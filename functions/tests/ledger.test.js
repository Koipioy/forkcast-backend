'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { appendLedgerEntry, makeLedgerId } = require('../billing/ledger');

function makeFakeDb() {
  const store = {
    billingLedger: new Map(),
  };

  return {
    store,
    collection(name) {
      if (!store[name]) store[name] = new Map();
      return {
        doc(id) {
          return {
            id,
            async get() {
              const exists = store[name].has(id);
              return {
                exists,
                data: () => (exists ? { ...store[name].get(id) } : undefined),
              };
            },
            async set(data) {
              store[name].set(id, { ...data });
            },
          };
        },
      };
    },
  };
}

test('makeLedgerId is deterministic', () => {
  const a = makeLedgerId('user/1', 'ai', 'op-1');
  const b = makeLedgerId('user/1', 'ai', 'op-1');
  assert.strictEqual(a, b);
  assert.match(a, /^user_1__ai__op-1$/);
});

test('appendLedgerEntry prevents duplicate ledger rows', async () => {
  const db = makeFakeDb();
  const entry = {
    userId: 'u1',
    source: 'ai',
    type: 'debit',
    amountMicros: -100,
    balanceBeforeMicros: 1000,
    balanceAfterMicros: 900,
    idempotencyKey: 'usage:op_12345678',
  };

  const first = await appendLedgerEntry(db, {}, entry);
  const second = await appendLedgerEntry(db, {}, entry);

  assert.strictEqual(first.created, true);
  assert.strictEqual(second.created, false);
  assert.strictEqual(db.store.billingLedger.size, 1);
});
