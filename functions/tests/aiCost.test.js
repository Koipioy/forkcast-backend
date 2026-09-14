'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  calculateAiRawCostMicros,
  calculateCharge,
  estimateMaxDebitMicros,
} = require('../billing/aiCost');

test('calculateAiRawCostMicros uses configured model pricing', () => {
  const result = calculateAiRawCostMicros({
    provider: 'openai',
    model: 'gpt-5.6-luna',
    usage: {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    },
  });

  assert.strictEqual(result.rawCostMicros, 1_400_000n);
  assert.strictEqual(result.costSource, 'token_pricing');
});

test('calculateAiRawCostMicros subtracts cached input from non-cached input', () => {
  const result = calculateAiRawCostMicros({
    provider: 'openai',
    model: 'gpt-5.6-luna',
    usage: {
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 0,
    },
  });

  // Current config prices cached input the same as input, so total remains 200k.
  assert.strictEqual(result.rawCostMicros, 200_000n);
});

test('calculateCharge adds 10% markup by default', () => {
  const result = calculateCharge({ rawCostMicros: 1_000_000n });
  assert.strictEqual(result.rawCostMicros, 1_000_000n);
  assert.strictEqual(result.markupMicros, 100_000n);
  assert.strictEqual(result.chargedMicros, 1_100_000n);
});

test('estimateMaxDebitMicros includes feature infra and image reserve', () => {
  const max = estimateMaxDebitMicros({
    feature: 'receipt_extract',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    hasImage: true,
  });

  // 12k input * $0.20/M = 2400
  // 3k output * $1.20/M = 3600
  // infra = 150
  // image reserve = 3000
  // raw = 9150, markup = 915, charged = 10065
  assert.strictEqual(max, 10065);
});

test('estimateMaxDebitMicros falls back to default model when model is missing', () => {
  const max = estimateMaxDebitMicros({
    feature: 'meal_ideas',
    hasImage: false,
  });

  assert.ok(Number.isInteger(max));
  assert.ok(max > 0);
});
