'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { estimatePaymentFeeMicros } = require('../billing/paymentFees');

test('estimatePaymentFeeMicros estimates 2.9% + 30 cents', () => {
  // $10.00 = 10,000,000 micros
  // 2.9% = 290,000 micros
  // fixed = 300,000 micros
  assert.strictEqual(estimatePaymentFeeMicros(10_000_000), 590_000);
});

test('estimatePaymentFeeMicros returns zero for zero gross', () => {
  assert.strictEqual(estimatePaymentFeeMicros(0), 0);
});
