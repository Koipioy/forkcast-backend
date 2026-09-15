'use strict';

/**
 * Stripe prepaid top-up billing.
 *
 * This replaces the old metered subscription model with one-time top-ups.
 * Users buy prepaid credit; AI usage is debited from the user's balance by
 * the reservation/settlement layer.
 */

const Stripe = require('stripe');
const { db } = require('./firebase');
const {
  INITIAL_BALANCE_MICROS,
  PAYMENT_FEE_ESTIMATE,
  PRICING_VERSION,
  TOPUP_OPTIONS,
  getTopupOption,
  resolveCustomTopupOption,
} = require('./billing/config');
const {
  centsToMicros,
  toSafeNumber,
} = require('./billing/money');
const { estimatePaymentFeeMicros } = require('./billing/paymentFees');
const { appendLedgerEntry } = require('./billing/ledger');
const { ensureUserDoc, releaseReservation } = require('./billing/balance');
const { increment } = require('./billing/firestoreValue');
const { stripeSecret, stripeWebhookSecret, safeSecret } = require('./billing/params');

function getStripeSecret() {
  return process.env.STRIPE_SECRET || safeSecret(stripeSecret);
}

function getStripeWebhookSecret() {
  return process.env.STRIPE_WEBHOOK_SECRET || safeSecret(stripeWebhookSecret);
}

function getSuccessUrl() {
  return process.env.BILLING_SUCCESS_URL || 'forkcast://topup-success';
}

function getCancelUrl() {
  return process.env.BILLING_CANCEL_URL || 'forkcast://topup-cancel';
}

let stripe = null;
let stripeClientSecret = null;

function getStripe() {
  const secret = getStripeSecret();
  if (!secret) {
    throw new Error('Stripe client not initialized. Check STRIPE_SECRET configuration.');
  }
  if (stripe && stripeClientSecret === secret) {
    return stripe;
  }
  // Do not pin an old Stripe API version. The account default is newer, and
  // old pinned versions can be rejected by Stripe.
  stripe = new Stripe(secret);
  stripeClientSecret = secret;
  return stripe;
}

async function getOrCreateStripeCustomer(uid, email) {
  const stripeClient = getStripe();
  const userRef = db.collection('users').doc(String(uid));
  const snap = await userRef.get();
  const data = snap.data() || {};

  if (data.stripeCustomerId) {
    return { customerId: data.stripeCustomerId, created: false };
  }

  const customer = await stripeClient.customers.create({
    email: email || undefined,
    metadata: {
      firebase_uid: String(uid),
    },
  });

  await userRef.set(
    {
      stripeCustomerId: customer.id,
      updatedAt: Date.now(),
    },
    { merge: true },
  );

  return { customerId: customer.id, created: true };
}

async function createTopupCheckout({ uid, email, optionId, amountMicros }) {
  // The wallet now sends a raw custom amount. `optionId` is still honoured so older
  // installed APKs keep working until they are updated.
  const hasCustomAmount =
    amountMicros !== undefined && amountMicros !== null && amountMicros !== '';

  const option = hasCustomAmount
    ? resolveCustomTopupOption(amountMicros)
    : getTopupOption(optionId);

  if (!option) {
    const err = new Error(
      hasCustomAmount ? 'Top-up amount is not accepted' : 'Unknown top-up option',
    );
    err.code = hasCustomAmount ? 'invalid_amount' : 'invalid_option';
    throw err;
  }

  const { customerId } = await getOrCreateStripeCustomer(uid, email);
  const topupId = `topup_${uid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const amountCents = Math.round(option.amountMicros / 10_000);

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    customer: customerId,
    client_reference_id: topupId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          product_data: {
            name: `Forkast prepaid credit ${option.label}`,
            description: 'Prepaid AI usage credit',
            metadata: {
              optionId: option.id,
              amountMicros: String(option.amountMicros),
            },
          },
        },
      },
    ],
    success_url: `${getSuccessUrl()}?topupId=${encodeURIComponent(topupId)}&status=success`,
    cancel_url: `${getCancelUrl()}?topupId=${encodeURIComponent(topupId)}&status=cancelled`,
    metadata: {
      firebaseUID: String(uid),
      topupId,
      optionId: option.id,
      amountMicros: String(option.amountMicros),
    },
    allow_promotion_codes: true,
  });

  await db.collection('topups').doc(topupId).set({
    id: topupId,
    userId: String(uid),
    status: 'pending',
    optionId: option.id,
    expectedAmountMicros: option.amountMicros,
    stripeCustomerId: customerId,
    stripeSessionId: session.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  return {
    topupId,
    url: session.url,
    sessionId: session.id,
  };
}

function extractTopupMetadata(session) {
  const md = session?.metadata || {};
  const uid = md.firebaseUID || md.uid || null;
  const topupId = md.topupId || session?.client_reference_id || null;
  return { uid, topupId };
}

async function creditTopupFromSession(session, eventId) {
  const { uid, topupId } = extractTopupMetadata(session);
  if (!uid || !topupId) {
    console.warn('Stripe top-up session missing metadata', { eventId, sessionId: session?.id });
    return { credited: false, reason: 'missing_metadata' };
  }

  const amountTotalCents = Number(session?.amount_total || 0);
  const amountTaxCents = Number(session?.total_details?.amount_tax || 0);
  const creditCents = Math.max(0, amountTotalCents - amountTaxCents);
  const grossPaymentMicros = centsToMicros(amountTotalCents);
  const creditsIssuedMicros = centsToMicros(creditCents);
  const paymentProcessingFeeMicros = estimatePaymentFeeMicros(grossPaymentMicros);

  if (creditsIssuedMicros <= 0) {
    return { credited: false, reason: 'zero_credit' };
  }

  const topupRef = db.collection('topups').doc(String(topupId));
  const eventRef = db.collection('stripeEvents').doc(String(eventId));

  return db.runTransaction(async (tx) => {
    const existingEvent = await eventRef.get();
    if (existingEvent.exists && existingEvent.data()?.processed) {
      return { credited: false, reason: 'event_already_processed' };
    }

    const topupSnap = await topupRef.get();
    if (!topupSnap.exists) {
      return { credited: false, reason: 'topup_not_found' };
    }
    const topup = topupSnap.data() || {};
    if (topup.userId !== String(uid)) {
      return { credited: false, reason: 'topup_user_mismatch' };
    }
    if (topup.status === 'completed') {
      return { credited: false, reason: 'topup_already_completed' };
    }

    await ensureUserDoc(db, tx, String(uid));
    const userRef = db.collection('users').doc(String(uid));
    const userSnap = await userRef.get();
    const user = userSnap.data() || {};
    const balanceBefore = Number(user.availableBalanceMicros || 0);
    const balanceAfter = balanceBefore + Number(creditsIssuedMicros);

    await userRef.set(
      {
        availableBalanceMicros: increment(db, Number(creditsIssuedMicros)),
        lifetimeTopupMicros: increment(db, Number(creditsIssuedMicros)),
        updatedAt: Date.now(),
      },
      { merge: true },
    );

    const ledgerResult = await appendLedgerEntry(db, tx, {
      userId: String(uid),
      source: 'topup',
      type: 'credit',
      feature: 'topup',
      amountMicros: Number(creditsIssuedMicros),
      chargedMicros: 0,
      balanceBeforeMicros: balanceBefore,
      balanceAfterMicros: balanceAfter,
      externalRequestId: session?.id || null,
      idempotencyKey: `topup:${topupId}`,
      status: 'succeeded',
      pricingVersion: PRICING_VERSION,
      metadata: {
        grossPaymentMicros: Number(grossPaymentMicros),
        paymentProcessingFeeMicros: Number(paymentProcessingFeeMicros),
        creditsIssuedMicros: Number(creditsIssuedMicros),
        stripeSessionId: session?.id || null,
        stripeEventId: eventId || null,
        optionId: topup.optionId || null,
      },
    });

    await topupRef.update({
      status: 'completed',
      amountMicros: Number(creditsIssuedMicros),
      grossPaymentMicros: Number(grossPaymentMicros),
      paymentProcessingFeeMicros: Number(paymentProcessingFeeMicros),
      creditsIssuedMicros: Number(creditsIssuedMicros),
      stripeSessionId: session?.id || topup.stripeSessionId || null,
      stripePaymentIntent: session?.payment_intent || null,
      ledgerId: ledgerResult.id,
      completedAt: Date.now(),
      updatedAt: Date.now(),
    });

    await eventRef.set(
      {
        id: String(eventId),
        type: 'checkout.session.completed',
        processed: true,
        processedAt: Date.now(),
        topupId: String(topupId),
        userId: String(uid),
      },
      { merge: true },
    );

    return {
      credited: true,
      topupId: String(topupId),
      creditsIssuedMicros: Number(creditsIssuedMicros),
      balanceAfterMicros: balanceAfter,
    };
  });
}

async function markTopupFailed(session, eventId, reason) {
  const { uid, topupId } = extractTopupMetadata(session);
  if (!topupId) return { updated: false, reason: 'missing_topup_id' };
  const topupRef = db.collection('topups').doc(String(topupId));
  const eventRef = db.collection('stripeEvents').doc(String(eventId));
  await topupRef.set(
    {
      status: 'failed',
      failureReason: reason || 'payment_failed',
      stripeSessionId: session?.id || null,
      updatedAt: Date.now(),
    },
    { merge: true },
  );
  await eventRef.set(
    {
      id: String(eventId),
      type: 'checkout.session.failed',
      processed: true,
      processedAt: Date.now(),
      topupId: String(topupId),
      userId: uid || null,
    },
    { merge: true },
  );
  return { updated: true };
}

async function handleChargeRefunded(charge, eventId) {
  const paymentIntent = charge?.payment_intent;
  if (!paymentIntent) {
    return { handled: false, reason: 'missing_payment_intent' };
  }

  const amountRefundedCents = Number(charge?.amount_refunded || 0);
  const amountCapturedCents = Number(charge?.amount_captured || charge?.amount || 0);
  const isFullRefund = amountRefundedCents >= amountCapturedCents && amountCapturedCents > 0;

  if (!isFullRefund) {
    return { handled: false, reason: 'partial_refund_not_supported' };
  }

  const topupSnap = await db
    .collection('topups')
    .where('stripePaymentIntent', '==', String(paymentIntent))
    .limit(1)
    .get();

  if (topupSnap.empty) {
    return { handled: false, reason: 'topup_not_found' };
  }

  const topupRef = topupSnap.docs[0].ref;
  const topup = topupSnap.docs[0].data() || {};
  if (topup.status !== 'completed') {
    return { handled: false, reason: 'topup_not_completed' };
  }

  const userId = String(topup.userId);
  const creditsIssued = Number(topup.creditsIssuedMicros || topup.amountMicros || 0);
  if (creditsIssued <= 0) {
    return { handled: false, reason: 'zero_credits' };
  }

  const eventRef = db.collection('stripeEvents').doc(String(eventId));

  return db.runTransaction(async (tx) => {
    const existingEvent = await eventRef.get();
    if (existingEvent.exists && existingEvent.data()?.processed) {
      return { credited: false, reason: 'event_already_processed' };
    }

    const freshTopupSnap = await topupRef.get();
    if (!freshTopupSnap.exists) {
      return { credited: false, reason: 'topup_not_found' };
    }
    const freshTopup = freshTopupSnap.data() || {};
    if (freshTopup.status === 'refunded') {
      return { credited: false, reason: 'already_refunded' };
    }

    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    const user = userSnap.data() || {};
    const available = Number(user.availableBalanceMicros || 0);
    const debit = Math.min(available, creditsIssued);
    const balanceBefore = available;
    const balanceAfter = available - debit;

    if (debit > 0) {
      await userRef.set(
        {
          availableBalanceMicros: increment(db, -debit),
          lifetimeRefundedMicros: increment(db, debit),
          updatedAt: Date.now(),
        },
        { merge: true },
      );
    }

    const ledgerResult = await appendLedgerEntry(db, tx, {
      userId,
      source: 'refund',
      type: 'debit',
      feature: 'refund',
      amountMicros: -debit,
      chargedMicros: 0,
      balanceBeforeMicros: balanceBefore,
      balanceAfterMicros: balanceAfter,
      externalRequestId: charge?.id || null,
      idempotencyKey: `refund:${charge?.id || eventId}`,
      status: 'succeeded',
      pricingVersion: PRICING_VERSION,
      metadata: {
        topupId: freshTopup.id || null,
        creditsIssuedMicros: creditsIssued,
        refundedFromBalanceMicros: debit,
        uncollectedRefundMicros: Math.max(0, creditsIssued - debit),
        stripeChargeId: charge?.id || null,
        stripeEventId: eventId || null,
      },
    });

    await topupRef.update({
      status: 'refunded',
      refundedAt: Date.now(),
      refundStripeChargeId: charge?.id || null,
      refundLedgerId: ledgerResult.id,
      updatedAt: Date.now(),
    });

    await eventRef.set(
      {
        id: String(eventId),
        type: 'charge.refunded',
        processed: true,
        processedAt: Date.now(),
        topupId: freshTopup.id || null,
        userId,
      },
      { merge: true },
    );

    return {
      handled: true,
      refunded: true,
      topupId: freshTopup.id || null,
      refundedFromBalanceMicros: debit,
      balanceAfterMicros: balanceAfter,
    };
  });
}

async function processStripeEvent(event) {
  const eventId = event?.id;
  if (!eventId) return { handled: false, reason: 'missing_event_id' };

  const eventRef = db.collection('stripeEvents').doc(String(eventId));
  const existing = await eventRef.get();
  if (existing.exists && existing.data()?.processed) {
    return { handled: true, reason: 'already_processed' };
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session?.mode !== 'payment') {
      await eventRef.set(
        {
          id: String(eventId),
          type: event.type,
          processed: true,
          processedAt: Date.now(),
          skippedReason: 'not_payment_mode',
        },
        { merge: true },
      );
      return { handled: true, reason: 'not_payment_mode' };
    }

    if (session?.payment_status === 'paid') {
      return await creditTopupFromSession(session, eventId);
    }

    await markTopupFailed(session, eventId, `payment_status_${session?.payment_status || 'unknown'}`);
    return { handled: true, reason: 'not_paid' };
  }

  if (event.type === 'checkout.session.async_payment_succeeded') {
    const session = event.data.object;
    return await creditTopupFromSession(session, eventId);
  }

  if (event.type === 'checkout.session.async_payment_failed') {
    const session = event.data.object;
    return await markTopupFailed(session, eventId, 'async_payment_failed');
  }

  if (event.type === 'charge.refunded') {
    return await handleChargeRefunded(event.data?.object, eventId);
  }

  await eventRef.set(
    {
      id: String(eventId),
      type: event.type,
      processed: true,
      processedAt: Date.now(),
      ignored: true,
    },
    { merge: true },
  );

  return { handled: true, reason: 'ignored_event_type' };
}

async function getBillingSummary(uid) {
  const userRef = db.collection('users').doc(String(uid));
  const snap = await userRef.get();
  let user = snap.data() || {};

  if (!snap.exists) {
    const now = Date.now();
    user = {
      uid: String(uid),
      availableBalanceMicros: INITIAL_BALANCE_MICROS,
      reservedBalanceMicros: 0,
      lifetimeTopupMicros: 0,
      lifetimeChargedMicros: 0,
      lifetimeRefundedMicros: 0,
      lifetimeAdjustmentMicros: 0,
      createdAt: now,
      updatedAt: now,
    };
    await userRef.set(user);
  }

  const ledgerQuery = await db
    .collection('billingLedger')
    .where('userId', '==', String(uid))
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  const topupQuery = await db
    .collection('topups')
    .where('userId', '==', String(uid))
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();

  return {
    availableBalanceMicros: Number(user.availableBalanceMicros || 0),
    reservedBalanceMicros: Number(user.reservedBalanceMicros || 0),
    lifetimeTopupMicros: Number(user.lifetimeTopupMicros || 0),
    lifetimeChargedMicros: Number(user.lifetimeChargedMicros || 0),
    lifetimeRefundedMicros: Number(user.lifetimeRefundedMicros || 0),
    pricingVersion: PRICING_VERSION,
    topupOptions: TOPUP_OPTIONS,
    recentLedger: ledgerQuery.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
    recentTopups: topupQuery.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
  };
}

async function releaseExpiredReservations(limit = 100) {
  const now = Date.now();
  const snap = await db
    .collection('billingReservations')
    .where('status', 'in', ['reserved', 'running', 'completed_unsettled'])
    .where('expiresAt', '<', now)
    .limit(limit)
    .get();

  let released = 0;
  for (const doc of snap.docs) {
    try {
      const result = await db.runTransaction(async (tx) => {
        return await releaseReservation(db, tx, {
          operationId: doc.id,
          reason: 'expired',
        });
      });
      if (result?.released) released += 1;
    } catch (err) {
      console.error('Failed to release expired reservation', doc.id, err);
    }
  }

  return {
    checked: snap.size,
    released,
  };
}

module.exports = {
  createTopupCheckout,
  processStripeEvent,
  getBillingSummary,
  releaseExpiredReservations,
  estimatePaymentFeeMicros,
  getStripe,
  stripe,
};
