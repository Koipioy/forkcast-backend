'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ceilDiv,
  centsToMicros,
  markupMicros,
  tokenCostMicros,
  toSafeNumber,
} = require('../billing/money');

test('ceilDiv rounds positive division up', () => {
  assert.strictEqual(ceilDiv(1n, 3n), 1n);
  assert.strictEqual(ceilDiv(3n, 3n), 1n);
  assert.strictEqual(ceilDiv(4n, 3n), 2n);
});

test('centsToMicros converts cents to microdollars', () => {
  assert.strictEqual(centsToMicros(1), 10_000);
  assert.strictEqual(centsToMicros(1000), 10_000_000);
});

test('markupMicros applies basis points and rounds up', () => {
  assert.strictEqual(markupMicros(1_000_000n, 1000), 100_000n);
  assert.strictEqual(markupMicros(1n, 1000), 1n);
  assert.strictEqual(markupMicros(0n, 1000), 0n);
});

test('tokenCostMicros prices tokens per million', () => {
  assert.strictEqual(tokenCostMicros(1_000_000, 200_000), 200_000n);
  assert.strictEqual(tokenCostMicros(1, 200_000), 1n);
  assert.strictEqual(tokenCostMicros(0, 200_000), 0n);
});

test('toSafeNumber rejects unsafe integers', () => {
  assert.strictEqual(toSafeNumber(123), 123);
  assert.throws(() => toSafeNumber(Number.MAX_SAFE_INTEGER + 1), /safe integer/);
});
