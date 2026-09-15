'use strict';

const { toSafeNumber } = require('./money');
const { appendLedgerEntry } = require('./ledger');
const { increment } = require('./firestoreValue');
const {
  INITIAL_BALANCE_MICROS,
  isEnforcementEnabled,
  PRICING_VERSION,
  RESERVATION_TTL_MS,
} = require('./config');

class InsufficientBalanceError extends Error {
  constructor(details) {
    super('Insufficient balance');
    this.name = 'InsufficientBalanceError';
    this.details = details;
  }
}

class ReservationConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ReservationConflictError';
    this.details = details;
  }
}

function reservationRef(db, reservationId) {
  return db.collection('billingReservations').doc(String(reservationId));
}

function userRef(db, userId) {
  return db.collection('users').doc(String(userId));
}

async function ensureUserDoc(db, tx, userId, email) {
  const ref = userRef(db, userId);
  const snap = await ref.get();
  const now = Date.now();
  if (!snap.exists) {
    const data = {
      uid: userId,
      availableBalanceMicros: INITIAL_BALANCE_MICROS,
      reservedBalanceMicros: 0,
      lifetimeTopupMicros: 0,
      lifetimeChargedMicros: 0,
      lifetimeRefundedMicros: 0,
      lifetimeAdjustmentMicros: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (email) data.email = email;
    await ref.set(data);
    return data;
  }
  return snap.data() || {};
}

async function reserveBalance(db, tx, params) {
  const {
    userId,
    operationId,
    maxDebitMicros,
    feature,
    functionName,
    email,
  } = params;

  if (!userId || !operationId) {
    throw new Error('reserveBalance requires userId and operationId');
  }

  const ref = reservationRef(db, operationId);
  const existing = await ref.get();
  const now = Date.now();

  if (existing.exists) {
    const data = existing.data() || {};
    if (data.userId !== userId) {
      throw new ReservationConflictError('Operation id belongs to another user', {
        operationId,
      });
    }
    return {
      created: false,
      reservation: data,
      status: data.status,
    };
  }

  const maxDebit = Math.max(0, toSafeNumber(maxDebitMicros || 0, 'maxDebitMicros'));
  const enforcement = isEnforcementEnabled();

  if (!enforcement || maxDebit <= 0) {
    const reservation = {
      id: operationId,
      userId,
      status: 'skipped',
      maxDebitMicros: 0,
      feature: feature || 'unknown',
      functionName: functionName || 'unknown',
      createdAt: now,
      expiresAt: now + RESERVATION_TTL_MS,
      settledAt: null,
      skippedReason: enforcement ? 'zero_max_debit' : 'billing_enforcement_off',
    };
    await ref.set(reservation);
    return { created: true, reservation, status: 'skipped' };
  }

  await ensureUserDoc(db, tx, userId, email);
  const userSnap = await userRef(db, userId).get();
  const userData = userSnap.data() || {};
  const available = Number(userData.availableBalanceMicros || 0);

  if (available <= 0) {
    throw new InsufficientBalanceError({
      userId,
      availableBalanceMicros: available,
      requiredMicros: maxDebit,
    });
  }

  // If the user has some money but not enough for the full estimated maximum,
  // reserve what they have instead of blocking the call outright. Settlement is
  // capped by this reserved amount, so the account floors at $0.00 instead of
  // going negative.
  const reserveAmount = Math.min(maxDebit, available);
  const partialReservation = reserveAmount < maxDebit;

  const reservation = {
    id: operationId,
    userId,
    status: 'reserved',
    maxDebitMicros: reserveAmount,
    requestedMaxDebitMicros: maxDebit,
    partialReservation,
    feature: feature || 'unknown',
    functionName: functionName || 'unknown',
    createdAt: now,
    expiresAt: now + RESERVATION_TTL_MS,
    settledAt: null,
  };

  await userRef(db, userId).set(
    {
      availableBalanceMicros: increment(db, -reserveAmount),
      reservedBalanceMicros: increment(db, reserveAmount),
      updatedAt: now,
    },
    { merge: true },
  );
  await ref.set(reservation);

  return { created: true, reservation, status: 'reserved' };
}

async function markReservationRunning(db, tx, operationId) {
  const ref = reservationRef(db, operationId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (data.status === 'reserved') {
    await ref.update({ status: 'running', startedAt: Date.now() });
    return { ...data, status: 'running' };
  }
  return data;
}

async function claimReservation(db, tx, operationId) {
  const ref = reservationRef(db, operationId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { claimed: false, reason: 'not_found', reservation: null };
  }
  const data = snap.data() || {};
  if (data.status === 'reserved') {
    await ref.update({ status: 'running', startedAt: Date.now() });
    return { claimed: true, reason: 'claimed', reservation: { ...data, status: 'running' } };
  }
  if (data.status === 'skipped') {
    // Enforcement is off or max debit is zero. Allow execution without balance lock.
    return { claimed: true, reason: 'skipped', reservation: data };
  }
  return { claimed: false, reason: data.status, reservation: data };
}

async function storeReservationResult(db, tx, operationId, result, actual = {}) {
  const ref = reservationRef(db, operationId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (data.status === 'settled') return data;

  const update = {
    status: 'completed_unsettled',
    completedAt: Date.now(),
    result: result || null,
  };

  if (actual.actualRawCostMicros !== undefined) {
    update.actualRawCostMicros = toSafeNumber(actual.actualRawCostMicros, 'actualRawCostMicros');
  }
  if (actual.aiRawCostMicros !== undefined) {
    update.aiRawCostMicros = toSafeNumber(actual.aiRawCostMicros, 'aiRawCostMicros');
  }
  if (actual.infraRawCostMicros !== undefined) {
    update.infraRawCostMicros = toSafeNumber(actual.infraRawCostMicros, 'infraRawCostMicros');
  }
  if (actual.actualMarkupMicros !== undefined) {
    update.actualMarkupMicros = toSafeNumber(actual.actualMarkupMicros, 'actualMarkupMicros');
  }
  if (actual.actualChargedMicros !== undefined) {
    update.actualChargedMicros = toSafeNumber(actual.actualChargedMicros, 'actualChargedMicros');
  }
  if (actual.provider !== undefined) update.provider = actual.provider;
  if (actual.model !== undefined) update.model = actual.model;
  if (actual.externalRequestId !== undefined) update.externalRequestId = actual.externalRequestId;
  if (actual.metadata !== undefined) update.resultMetadata = actual.metadata;

  await ref.update(update);
  return { ...data, ...update };
}

async function settleReservation(db, tx, params) {
  const {
    operationId,
    actualRawCostMicros = 0,
    aiRawCostMicros = 0,
    infraRawCostMicros = 0,
    actualMarkupMicros = 0,
    actualChargedMicros = 0,
    ledgerSource = 'ai',
    ledgerType = 'debit',
    ledgerStatus = 'charged',
    feature,
    provider,
    model,
    functionName,
    externalRequestId,
    metadata = {},
  } = params;

  const ref = reservationRef(db, operationId);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`Reservation not found: ${operationId}`);
  }

  const reservation = snap.data() || {};
  if (reservation.status === 'settled') {
    return { alreadySettled: true, reservation };
  }

  const now = Date.now();
  const userId = reservation.userId;
  const maxDebit = Math.max(0, Number(reservation.maxDebitMicros || 0));
  const requestedCharge = Math.max(0, toSafeNumber(actualChargedMicros || 0, 'actualChargedMicros'));
  const enforcement = isEnforcementEnabled() && reservation.status !== 'skipped';

  if (!enforcement) {
    await ref.update({
      status: 'settled',
      settledAt: now,
      actualRawCostMicros: toSafeNumber(actualRawCostMicros || 0, 'actualRawCostMicros'),
      actualMarkupMicros: toSafeNumber(actualMarkupMicros || 0, 'actualMarkupMicros'),
      actualChargedMicros: 0,
      skippedReason: reservation.skippedReason || 'billing_enforcement_off',
    });
    return { alreadySettled: false, skipped: true, reservation: { ...reservation, status: 'settled' } };
  }

  await ensureUserDoc(db, tx, userId);
  const userSnap = await userRef(db, userId).get();
  const userData = userSnap.data() || {};
  const available = Number(userData.availableBalanceMicros || 0);
  const reserved = Number(userData.reservedBalanceMicros || 0);

  const releaseAmount = Math.min(reserved, maxDebit);
  const charge = Math.min(requestedCharge, releaseAmount);
  const uncollectible = Math.max(0, requestedCharge - charge);
  const balanceBefore = available + releaseAmount;
  const balanceAfter = balanceBefore - charge;

  if (releaseAmount > 0) {
    await userRef(db, userId).set(
      {
        reservedBalanceMicros: increment(db, -releaseAmount),
        availableBalanceMicros: increment(db, releaseAmount - charge),
        lifetimeChargedMicros: increment(db, charge),
        lastUsageAt: now,
        updatedAt: now,
      },
      { merge: true },
    );
  } else if (charge > 0) {
    // Should not happen in a healthy reservation flow. Do not create a negative balance.
    throw new ReservationConflictError('Reservation has no reserved balance to settle', {
      operationId,
      available,
      reserved,
      requestedCharge,
    });
  }

  const ledgerEntry = {
    userId,
    source: ledgerSource,
    type: ledgerType,
    feature: feature || reservation.feature || 'unknown',
    provider: provider || null,
    model: model || null,
    functionName: functionName || reservation.functionName || null,
    rawCostMicros: actualRawCostMicros,
    aiRawCostMicros,
    infraRawCostMicros,
    markupBps: reservation.markupBps || require('./config').DEFAULT_MARKUP_BPS,
    markupMicros: actualMarkupMicros,
    chargedMicros: charge,
    amountMicros: -charge,
    balanceBeforeMicros: balanceBefore,
    balanceAfterMicros: balanceAfter,
    externalRequestId: externalRequestId || null,
    idempotencyKey: `usage:${operationId}`,
    status: ledgerStatus,
    pricingVersion: PRICING_VERSION,
    metadata: {
      ...metadata,
      reservationId: operationId,
      requestedChargedMicros: requestedCharge,
      uncollectibleMicros: uncollectible,
    },
  };

  const ledgerResult = await appendLedgerEntry(db, tx, ledgerEntry);

  await ref.update({
    status: 'settled',
    settledAt: now,
    actualRawCostMicros: toSafeNumber(actualRawCostMicros || 0, 'actualRawCostMicros'),
    actualMarkupMicros: toSafeNumber(actualMarkupMicros || 0, 'actualMarkupMicros'),
    actualChargedMicros: charge,
    ledgerId: ledgerResult.id,
  });

  return {
    alreadySettled: false,
    charge,
    balanceBefore,
    balanceAfter,
    ledgerId: ledgerResult.id,
    ledgerCreated: ledgerResult.created,
  };
}

async function releaseReservation(db, tx, params) {
  const { operationId, reason = 'released' } = params;
  const ref = reservationRef(db, operationId);
  const snap = await ref.get();
  if (!snap.exists) return { released: false, reason: 'not_found' };
  const reservation = snap.data() || {};
  if (reservation.status === 'settled') {
    return { released: false, reason: 'already_settled', reservation };
  }
  if (reservation.status === 'released') {
    return { released: false, reason: 'already_released', reservation };
  }

  const now = Date.now();
  const userId = reservation.userId;
  const maxDebit = Math.max(0, Number(reservation.maxDebitMicros || 0));

  if (maxDebit > 0 && reservation.status !== 'skipped') {
    await ensureUserDoc(db, tx, userId);
    const userSnap = await userRef(db, userId).get();
    const userData = userSnap.data() || {};
    const reserved = Number(userData.reservedBalanceMicros || 0);
    const releaseAmount = Math.min(reserved, maxDebit);
    if (releaseAmount > 0) {
      await userRef(db, userId).set(
        {
          reservedBalanceMicros: increment(db, -releaseAmount),
          availableBalanceMicros: increment(db, releaseAmount),
          updatedAt: now,
        },
        { merge: true },
      );
    }
  }

  await ref.update({
    status: 'released',
    releasedAt: now,
    releaseReason: reason,
  });

  return { released: true, reservation: { ...reservation, status: 'released' } };
}

module.exports = {
  InsufficientBalanceError,
  ReservationConflictError,
  ensureUserDoc,
  reserveBalance,
  claimReservation,
  markReservationRunning,
  storeReservationResult,
  settleReservation,
  releaseReservation,
};
