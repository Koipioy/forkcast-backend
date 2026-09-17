'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  clearRetryableFailedReservation,
  reserveBalance,
  settleReservation,
} = require('../billing/balance');

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
        return { exists, data: () => (exists ? { ...map.get(id) } : undefined) };
      },
      async set(data) {
        const existing = map.get(id) || {};
        const next = { ...existing };
        for (const [key, value] of Object.entries(data)) {
          next[key] = applyValue(existing[key], value);
        }
        map.set(id, next);
      },
      async update(data) {
        if (!map.has(id)) throw new Error('Document does not exist');
        const existing = map.get(id);
        const next = { ...existing };
        for (const [key, value] of Object.entries(data)) {
          next[key] = applyValue(existing[key], value);
        }
        map.set(id, next);
      },
      async delete() {
        map.delete(id);
      },
    };
  }

  return {
    store,
    FieldValue: { increment(value) { return { __op: 'increment', value }; } },
    collection(name) {
      if (!store[name]) store[name] = new Map();
      return { doc(id) { return makeDoc(name, String(id)); } };
    },
  };
}

async function seedFailedReservation(db, id, overrides = {}) {
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 10000,
    reservedBalanceMicros: 0,
  });
  await reserveBalance(db, {}, {
    userId: 'u1',
    operationId: id,
    maxDebitMicros: 500,
    feature: 'recipe_extract',
    functionName: 'runAI',
  });
  await settleReservation(db, {}, {
    operationId: id,
    actualRawCostMicros: 0,
    aiRawCostMicros: 0,
    infraRawCostMicros: 0,
    actualMarkupMicros: 0,
    actualChargedMicros: 0,
    ledgerSource: 'ai',
    ledgerType: 'no_charge',
    ledgerStatus: 'no_charge',
    feature: 'recipe_extract',
    functionName: 'runAI',
    metadata: { failure: true, errorMessage: 'provider 503', errorStatus: 503 },
    ...overrides,
  });
}

test('a zero-charge failed reservation is cleared so the operation can be retried', async () => {
  const db = makeFakeDb();
  await seedFailedReservation(db, 'recipe_extract_retry_me');

  const res = await clearRetryableFailedReservation(db, 'recipe_extract_retry_me');

  assert.strictEqual(res.cleared, true);
  assert.strictEqual(res.reason, 'retryable_failure');
  assert.strictEqual(db.store.billingReservations.has('recipe_extract_retry_me'), false);
});

test('after clearing, the same operationId reserves and runs again', async () => {
  const db = makeFakeDb();
  await seedFailedReservation(db, 'recipe_extract_retry_me');
  await clearRetryableFailedReservation(db, 'recipe_extract_retry_me');

  const again = await reserveBalance(db, {}, {
    userId: 'u1',
    operationId: 'recipe_extract_retry_me',
    maxDebitMicros: 500,
    feature: 'recipe_extract',
    functionName: 'runAI',
  });

  assert.strictEqual(again.created, true, 'the operationId must be reusable after a failed attempt');
  assert.strictEqual(again.status, 'reserved');
});

test('a settled reservation WITH a result is never cleared', async () => {
  const db = makeFakeDb();
  await seedFailedReservation(db, 'op_done', {
    actualChargedMicros: 0,
    metadata: { failure: true },
  });
  await db.collection('billingReservations').doc('op_done').update({
    result: { response: 'here is your recipe' },
  });

  const res = await clearRetryableFailedReservation(db, 'op_done');

  assert.strictEqual(res.cleared, false);
  assert.strictEqual(res.reason, 'has_result');
  assert.ok(db.store.billingReservations.has('op_done'));
});

test('a settled reservation that actually charged money is never cleared', async () => {
  const db = makeFakeDb();
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 10000,
    reservedBalanceMicros: 0,
  });
  await reserveBalance(db, {}, {
    userId: 'u1', operationId: 'op_paid', maxDebitMicros: 500,
    feature: 'recipe_extract', functionName: 'runAI',
  });
  await settleReservation(db, {}, {
    operationId: 'op_paid',
    actualRawCostMicros: 300, aiRawCostMicros: 300, infraRawCostMicros: 0,
    actualMarkupMicros: 30, actualChargedMicros: 330,
    ledgerSource: 'ai', ledgerType: 'debit', ledgerStatus: 'charged',
    feature: 'recipe_extract', functionName: 'runAI',
    metadata: { failure: true },
  });

  const res = await clearRetryableFailedReservation(db, 'op_paid');

  assert.strictEqual(res.cleared, false);
  assert.strictEqual(res.reason, 'charged');
  assert.ok(db.store.billingReservations.has('op_paid'));
});

test('a settled success with no failure flag is never cleared', async () => {
  const db = makeFakeDb();
  await seedFailedReservation(db, 'op_no_flag', { metadata: { ok: true } });

  const res = await clearRetryableFailedReservation(db, 'op_no_flag');

  assert.strictEqual(res.cleared, false);
  assert.strictEqual(res.reason, 'not_a_recorded_failure');
});

test('a still-running reservation is never cleared', async () => {
  const db = makeFakeDb();
  await db.collection('users').doc('u1').set({
    availableBalanceMicros: 10000, reservedBalanceMicros: 0,
  });
  await reserveBalance(db, {}, {
    userId: 'u1', operationId: 'op_running', maxDebitMicros: 500,
    feature: 'recipe_extract', functionName: 'runAI',
  });

  const res = await clearRetryableFailedReservation(db, 'op_running');

  assert.strictEqual(res.cleared, false);
  assert.strictEqual(res.reason, 'not_settled');
});

test('a missing reservation is a no-op', async () => {
  const db = makeFakeDb();
  const res = await clearRetryableFailedReservation(db, 'never_existed');
  assert.strictEqual(res.cleared, false);
  assert.strictEqual(res.reason, 'not_found');
});

test('clearing strands no balance - the failed settle already refunded the hold', async () => {
  const db = makeFakeDb();
  await seedFailedReservation(db, 'op_money_check');

  const before = { ...db.store.users.get('u1') };
  assert.strictEqual(before.reservedBalanceMicros, 0, 'failed settle must have released the hold');
  assert.strictEqual(before.availableBalanceMicros, 10000, 'nothing was consumed');

  await clearRetryableFailedReservation(db, 'op_money_check');

  const after = { ...db.store.users.get('u1') };
  assert.strictEqual(after.availableBalanceMicros, 10000);
  assert.strictEqual(after.reservedBalanceMicros, 0);
});
