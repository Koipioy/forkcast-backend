'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  InsufficientBalanceError,
  claimReservation,
  ensureUserDoc,
  releaseReservation,
  reserveBalance,
  settleReservation,
} = require('../billing/balance');
const { INITIAL_BALANCE_MICROS } = require('../billing/config');

function makeFakeDb() {
  const store = {
    users: new Map(),
    billingReservations: new Map(),
    billingLedger: new Map(),
  };

  function applyValue(current, value) {
    if (value && typeof value === 'object' && value.__op === 'increment') {
      return Number(current || 0) + Number(value.value);
    }
    return value;
  }

  function makeDoc(collectionName, id) {
    const map = store[collectionName];
    return {
      id,
      async get() {
        const exists = map.has(id);
        return {
          exists,
          data: () => (exists ? { ...map.get(id) } : undefined),
        };
      },
      async set(data, opts = {}) {
        const existing = map.get(id) || {};
        const next = { ...existing };
        for (const [key, value] of Object.entries(data)) {
          next[key] = applyValue(existing[key], value);
        }
        if (!opts.merge) {
          map.set(id, next);
        } else {
          map.set(id, next);
        }
      },
      async update(data) {
        if (!map.has(id)) {
          throw new Error('Document does not exist');
        }
        const existing = map.get(id);
        const next = { ...existing };
        for (const [key, value] of Object.entries(data)) {
          next[key] = applyValue(existing[key], value);
        }
        map.set(id, next);
      },
    };
  }

  return {
    store,
    FieldValue: {
      increment(value) {
        return { __op: 'increment', value };
      },
    },
    collection(name) {
      if (!store[name]) store[name] = new Map();
      return {
        doc(id) {
          return makeDoc(name, String(id));
        },
      };
    },
  };
}

test('ensureUserDoc creates a new account with the starting AI credit', async () => {
  const db = makeFakeDb();

  await ensureUserDoc(db, {}, 'u_new', 'new@example.com');

  const user = db.store.users.get('u_new');
  assert.ok(user);
  assert.strictEqual(user.availableBalanceMicros, INITIAL_BALANCE_MICROS);
  assert.strictEqual(user.availableBalanceMicros, 100_000);
  assert.strictEqual(user.reservedBalanceMicros, 0);
});

test('reserveBalance moves available balance into reserved balance', async () => {
  const db = makeFakeDb();
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 1000,
    reservedBalanceMicros: 0,
  });

  const result = await reserveBalance(db, {}, {
    userId: 'u1',
    operationId: 'op_12345678',
    maxDebitMicros: 500,
    feature: 'receipt_extract',
    functionName: 'runAI',
  });

  assert.strictEqual(result.created, true);
  assert.strictEqual(result.status, 'reserved');

  const user = db.store.users.get('u1');
  assert.strictEqual(user.availableBalanceMicros, 500);
  assert.strictEqual(user.reservedBalanceMicros, 500);

  const reservation = db.store.billingReservations.get('op_12345678');
  assert.strictEqual(reservation.status, 'reserved');
  assert.strictEqual(reservation.maxDebitMicros, 500);
});

test('reserveBalance throws insufficient balance when no money is available', async () => {
  const db = makeFakeDb();
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 0,
    reservedBalanceMicros: 0,
  });

  await assert.rejects(
    () =>
      reserveBalance(db, {}, {
        userId: 'u1',
        operationId: 'op_12345678',
        maxDebitMicros: 500,
      }),
    InsufficientBalanceError,
  );
});

test('reserveBalance partially reserves the remaining balance instead of blocking', async () => {
  const db = makeFakeDb();
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 100,
    reservedBalanceMicros: 0,
  });

  const result = await reserveBalance(db, {}, {
    userId: 'u1',
    operationId: 'op_partial_1',
    maxDebitMicros: 500,
  });

  assert.strictEqual(result.created, true);
  assert.strictEqual(result.status, 'reserved');

  const user = db.store.users.get('u1');
  assert.strictEqual(user.availableBalanceMicros, 0);
  assert.strictEqual(user.reservedBalanceMicros, 100);

  const reservation = db.store.billingReservations.get('op_partial_1');
  assert.strictEqual(reservation.maxDebitMicros, 100);
  assert.strictEqual(reservation.requestedMaxDebitMicros, 500);
  assert.strictEqual(reservation.partialReservation, true);
});

test('settleReservation releases unused reservation and charges actual amount', async () => {
  const db = makeFakeDb();
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 1000,
    reservedBalanceMicros: 0,
    lifetimeChargedMicros: 0,
  });

  await reserveBalance(db, {}, {
    userId: 'u1',
    operationId: 'op_12345678',
    maxDebitMicros: 500,
  });

  const settlement = await settleReservation(db, {}, {
    operationId: 'op_12345678',
    actualRawCostMicros: 180,
    actualMarkupMicros: 20,
    actualChargedMicros: 200,
  });

  assert.strictEqual(settlement.charge, 200);
  assert.strictEqual(settlement.balanceBefore, 1000);
  assert.strictEqual(settlement.balanceAfter, 800);

  const user = db.store.users.get('u1');
  assert.strictEqual(user.availableBalanceMicros, 800);
  assert.strictEqual(user.reservedBalanceMicros, 0);
  assert.strictEqual(user.lifetimeChargedMicros, 200);

  const ledger = [...db.store.billingLedger.values()];
  assert.strictEqual(ledger.length, 1);
  assert.strictEqual(ledger[0].amountMicros, -200);
  assert.strictEqual(ledger[0].chargedMicros, 200);
  assert.strictEqual(ledger[0].balanceBeforeMicros, 1000);
  assert.strictEqual(ledger[0].balanceAfterMicros, 800);
});

test('settleReservation caps charge at reserved max and records uncollectible', async () => {
  const db = makeFakeDb();
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 1000,
    reservedBalanceMicros: 0,
  });

  await reserveBalance(db, {}, {
    userId: 'u1',
    operationId: 'op_12345678',
    maxDebitMicros: 300,
  });

  const settlement = await settleReservation(db, {}, {
    operationId: 'op_12345678',
    actualChargedMicros: 500,
  });

  assert.strictEqual(settlement.charge, 300);
  const ledger = [...db.store.billingLedger.values()];
  assert.strictEqual(ledger[0].chargedMicros, 300);
  assert.strictEqual(ledger[0].metadata.requestedChargedMicros, 500);
  assert.strictEqual(ledger[0].metadata.uncollectibleMicros, 200);
});

test('settleReservation floors the balance at zero for a partial reservation', async () => {
  const db = makeFakeDb();
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 100,
    reservedBalanceMicros: 0,
    lifetimeChargedMicros: 0,
  });

  await reserveBalance(db, {}, {
    userId: 'u1',
    operationId: 'op_partial_1',
    maxDebitMicros: 500,
  });

  const settlement = await settleReservation(db, {}, {
    operationId: 'op_partial_1',
    actualChargedMicros: 500,
  });

  assert.strictEqual(settlement.charge, 100);
  assert.strictEqual(settlement.balanceBefore, 100);
  assert.strictEqual(settlement.balanceAfter, 0);

  const user = db.store.users.get('u1');
  assert.strictEqual(user.availableBalanceMicros, 0);
  assert.strictEqual(user.reservedBalanceMicros, 0);
  assert.strictEqual(user.lifetimeChargedMicros, 100);

  const ledger = [...db.store.billingLedger.values()];
  assert.strictEqual(ledger[0].chargedMicros, 100);
  assert.strictEqual(ledger[0].metadata.requestedChargedMicros, 500);
  assert.strictEqual(ledger[0].metadata.uncollectibleMicros, 400);
});

test('releaseReservation returns reserved balance to available', async () => {
  const db = makeFakeDb();
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 1000,
    reservedBalanceMicros: 0,
  });

  await reserveBalance(db, {}, {
    userId: 'u1',
    operationId: 'op_12345678',
    maxDebitMicros: 500,
  });

  const result = await releaseReservation(db, {}, {
    operationId: 'op_12345678',
    reason: 'test',
  });

  assert.strictEqual(result.released, true);
  const user = db.store.users.get('u1');
  assert.strictEqual(user.availableBalanceMicros, 1000);
  assert.strictEqual(user.reservedBalanceMicros, 0);
});

test('claimReservation prevents double claim', async () => {
  const db = makeFakeDb();
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 1000,
    reservedBalanceMicros: 0,
  });

  await reserveBalance(db, {}, {
    userId: 'u1',
    operationId: 'op_12345678',
    maxDebitMicros: 500,
  });

  const first = await claimReservation(db, {}, 'op_12345678');
  assert.strictEqual(first.claimed, true);

  const second = await claimReservation(db, {}, 'op_12345678');
  assert.strictEqual(second.claimed, false);
  assert.strictEqual(second.reason, 'running');
});
