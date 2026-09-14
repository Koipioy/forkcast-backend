'use strict';

/**
 * Integer microdollar helpers.
 *
 * $1.00 = 1,000,000 microdollars.
 * All authoritative billing math uses BigInt and returns safe JS numbers only
 * at the storage boundary.
 */

const MICRO_PER_DOLLAR = 1_000_000n;
const BPS_DENOM = 10_000n;
const TOKEN_DENOM = 1_000_000n;
const CENTS_TO_MICROS = 10_000n;

function ceilDiv(a, b) {
  if (b === 0n) {
    throw new Error('Division by zero');
  }
  // Works for non-negative integers. Negative values use truncation-safe logic.
  if (a >= 0n && b > 0n) {
    return (a + b - 1n) / b;
  }
  if (a <= 0n && b > 0n) {
    return a / b;
  }
  // Fallback for negative divisors: use BigInt division and adjust toward +Infinity.
  const q = a / b;
  const r = a % b;
  return r === 0n ? q : q + 1n;
}

function floorDiv(a, b) {
  if (b === 0n) {
    throw new Error('Division by zero');
  }
  const q = a / b;
  const r = a % b;
  if (r !== 0n && ((a < 0n) !== (b < 0n))) {
    return q - 1n;
  }
  return q;
}

function toBigInt(value, fieldName = 'value') {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`${fieldName} must be an integer`);
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  throw new Error(`${fieldName} must be an integer`);
}

function toSafeNumber(value, fieldName = 'value') {
  const big = toBigInt(value, fieldName);
  if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${fieldName} exceeds safe integer range`);
  }
  return Number(big);
}

function dollarsToMicros(dollars) {
  // Only accepts integer dollar strings/numbers for explicit conversions.
  return toSafeNumber(toBigInt(dollars, 'dollars') * MICRO_PER_DOLLAR, 'dollarsMicros');
}

function centsToMicros(cents) {
  return toSafeNumber(toBigInt(cents, 'cents') * CENTS_TO_MICROS, 'centsMicros');
}

function microsToCentsFloor(micros) {
  return Number(floorDiv(toBigInt(micros, 'micros'), CENTS_TO_MICROS));
}

function markupMicros(rawCostMicros, markupBps) {
  const raw = toBigInt(rawCostMicros, 'rawCostMicros');
  const bps = toBigInt(markupBps, 'markupBps');
  if (raw <= 0n) return 0n;
  if (bps < 0n) throw new Error('markupBps cannot be negative');
  return ceilDiv(raw * bps, BPS_DENOM);
}

function tokenCostMicros(tokens, microsPerMillion) {
  const t = toBigInt(tokens, 'tokens');
  const price = toBigInt(microsPerMillion, 'microsPerMillion');
  if (t <= 0n || price <= 0n) return 0n;
  return ceilDiv(t * price, TOKEN_DENOM);
}

function addCosts(...costs) {
  return costs.reduce((sum, c) => sum + toBigInt(c, 'cost'), 0n);
}

module.exports = {
  MICRO_PER_DOLLAR,
  BPS_DENOM,
  TOKEN_DENOM,
  CENTS_TO_MICROS,
  ceilDiv,
  floorDiv,
  toBigInt,
  toSafeNumber,
  dollarsToMicros,
  centsToMicros,
  microsToCentsFloor,
  markupMicros,
  tokenCostMicros,
  addCosts,
};
