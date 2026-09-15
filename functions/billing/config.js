'use strict';

/**
 * Central billing/pricing configuration.
 *
 * This is the only place where markup, model pricing, top-up options, feature
 * limits, and infrastructure estimates should be changed.
 *
 * Historical ledger entries store the actual markupBps and pricingVersion used,
 * so changing this file does not rewrite old records.
 */

const DEFAULT_PRICING_VERSION = '2026-09-v1';
const DEFAULT_MARKUP_BPS = 1000; // 10%

function envInt(name, fallback) {
  const raw = process.env[name] ?? fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer`);
  }
  return n;
}

function envStr(name, fallback) {
  const raw = process.env[name] ?? fallback;
  return String(raw);
}

const PRICING_VERSION = envStr('BILLING_PRICING_VERSION', DEFAULT_PRICING_VERSION);
const DEFAULT_MARKUP = envInt('BILLING_MARKUP_BPS', DEFAULT_MARKUP_BPS);
const BILLING_ENFORCEMENT = envStr('BILLING_ENFORCEMENT', 'on').toLowerCase(); // on | shadow | off

const RESERVATION_TTL_MS = envInt('BILLING_RESERVATION_TTL_MS', 30 * 60 * 1000);
const MAX_TEXT_CHARS = envInt('BILLING_MAX_TEXT_CHARS', 100_000);
const MAX_IMAGE_BASE64_CHARS = envInt('BILLING_MAX_IMAGE_BASE64_CHARS', 8_000_000);

/**
 * New accounts start with a tiny amount of prepaid AI credit.
 *
 * $0.10 is enough for a few small AI calls, but not enough to hide the fact
 * that AI usage is metered. Existing accounts are never topped up automatically.
 */
const INITIAL_BALANCE_MICROS = envInt('BILLING_INITIAL_BALANCE_MICROS', 100_000);

const TOPUP_OPTIONS = [
  {
    id: 'usd_5',
    label: '$5.00',
    amountMicros: 5_000_000,
  },
  {
    id: 'usd_10',
    label: '$10.00',
    amountMicros: 10_000_000,
  },
  {
    id: 'usd_20',
    label: '$20.00',
    amountMicros: 20_000_000,
  },
];

/**
 * Model pricing is stored as integer microdollars per 1,000,000 tokens.
 *
 * Example:
 *   $0.20 / 1M input = 200,000 microdollars / 1M
 *   $1.20 / 1M output = 1,200,000 microdollars / 1M
 *
 * If a provider reports cached/reasoning tokens and no specific price is set,
 * the cost adapter treats them conservatively as ordinary input/output tokens.
 */
const MODEL_PRICING = {
  'openai:gpt-6-astra': {
    provider: 'openai',
    model: 'gpt-6-astra',
    inputMicrosPerMillion: 10_000_000,
    outputMicrosPerMillion: 50_000_000,
    cachedInputMicrosPerMillion: 10_000_000,
    reasoningOutputMicrosPerMillion: 50_000_000,
  },
  'openai:gpt-5-6-sol': {
    provider: 'openai',
    model: 'gpt-5.6-sol',
    inputMicrosPerMillion: 4_000_000,
    outputMicrosPerMillion: 20_000_000,
    cachedInputMicrosPerMillion: 4_000_000,
    reasoningOutputMicrosPerMillion: 20_000_000,
  },
  'openai:gpt-5-6-terra': {
    provider: 'openai',
    model: 'gpt-5.6-terra',
    inputMicrosPerMillion: 2_000_000,
    outputMicrosPerMillion: 12_000_000,
    cachedInputMicrosPerMillion: 2_000_000,
    reasoningOutputMicrosPerMillion: 12_000_000,
  },
  'openai:gpt-5-6-luna': {
    provider: 'openai',
    model: 'gpt-5.6-luna',
    inputMicrosPerMillion: 200_000,
    outputMicrosPerMillion: 1_200_000,
    cachedInputMicrosPerMillion: 200_000,
    reasoningOutputMicrosPerMillion: 1_200_000,
  },
  'anthropic:claude-fable-5-1': {
    provider: 'anthropic',
    model: 'claude-fable-5.1',
    inputMicrosPerMillion: 10_000_000,
    outputMicrosPerMillion: 50_000_000,
    cachedInputMicrosPerMillion: 10_000_000,
    reasoningOutputMicrosPerMillion: 50_000_000,
  },
  'anthropic:claude-opus-5': {
    provider: 'anthropic',
    model: 'claude-opus-5',
    inputMicrosPerMillion: 5_000_000,
    outputMicrosPerMillion: 25_000_000,
    cachedInputMicrosPerMillion: 5_000_000,
    reasoningOutputMicrosPerMillion: 25_000_000,
  },
  'anthropic:claude-sonnet-5': {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    inputMicrosPerMillion: 2_000_000,
    outputMicrosPerMillion: 10_000_000,
    cachedInputMicrosPerMillion: 2_000_000,
    reasoningOutputMicrosPerMillion: 10_000_000,
  },
  'anthropic:claude-haiku-4-5': {
    provider: 'anthropic',
    model: 'claude-haiku-4.5',
    inputMicrosPerMillion: 1_000_000,
    outputMicrosPerMillion: 5_000_000,
    cachedInputMicrosPerMillion: 1_000_000,
    reasoningOutputMicrosPerMillion: 5_000_000,
  },
  'google:gemini-3-1-pro-preview': {
    provider: 'google',
    model: 'gemini-3.1-pro-preview',
    inputMicrosPerMillion: 2_000_000,
    outputMicrosPerMillion: 12_000_000,
    cachedInputMicrosPerMillion: 2_000_000,
    reasoningOutputMicrosPerMillion: 12_000_000,
  },
  'google:gemini-3-7-flash': {
    provider: 'google',
    model: 'gemini-3.7-flash',
    inputMicrosPerMillion: 750_000,
    outputMicrosPerMillion: 3_750_000,
    cachedInputMicrosPerMillion: 750_000,
    reasoningOutputMicrosPerMillion: 3_750_000,
  },
};

const DEFAULT_MODEL_ID = 'openai:gpt-5-6-luna';

const FEATURE_BILLING = {
  receipt_extract: {
    label: 'Receipt scan',
    infraMicros: 150,
    maxInputTokens: 12_000,
    maxOutputTokens: 3_000,
    imageReserveMicros: 3_000,
  },
  pantry_scan: {
    label: 'Pantry scan',
    infraMicros: 180,
    maxInputTokens: 12_000,
    maxOutputTokens: 3_000,
    imageReserveMicros: 3_500,
  },
  recipe_extract: {
    label: 'Recipe extraction',
    infraMicros: 120,
    maxInputTokens: 20_000,
    maxOutputTokens: 5_000,
  },
  recipe_cart_mapping: {
    label: 'Recipe cart mapping',
    infraMicros: 80,
    maxInputTokens: 12_000,
    maxOutputTokens: 3_000,
  },
  receipt_price_match: {
    label: 'Receipt price matching',
    infraMicros: 80,
    maxInputTokens: 12_000,
    maxOutputTokens: 3_000,
  },
  meal_ideas: {
    label: 'Meal ideas',
    infraMicros: 60,
    maxInputTokens: 8_000,
    maxOutputTokens: 2_500,
  },
  pantry_category: {
    label: 'Pantry categorization',
    infraMicros: 60,
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
  },
  pantry_analysis: {
    label: 'Pantry analysis',
    infraMicros: 80,
    maxInputTokens: 10_000,
    maxOutputTokens: 3_000,
  },
  plan_recipe_suggestion: {
    label: 'Plan recipe suggestion',
    infraMicros: 50,
    maxInputTokens: 5_000,
    maxOutputTokens: 1_500,
  },
  unknown: {
    label: 'AI operation',
    infraMicros: 200,
    maxInputTokens: 12_000,
    maxOutputTokens: 3_000,
    imageReserveMicros: 5_000,
  },
};

const PAYMENT_FEE_ESTIMATE = {
  // Approximate current Stripe standard domestic card pricing:
  // 2.9% + $0.30 per successful transaction.
  percentBps: 290,
  fixedMicros: 300_000,
};

function getTopupOption(optionId) {
  return TOPUP_OPTIONS.find((option) => option.id === optionId) || null;
}

/** Smallest custom top-up accepted, in microdollars ($5.00). */
const MIN_TOPUP_MICROS = envInt('BILLING_MIN_TOPUP_MICROS', 5_000_000);

/** Largest custom top-up allowed in a single checkout ($500.00). */
const MAX_TOPUP_MICROS = envInt('BILLING_MAX_TOPUP_MICROS', 500_000_000);

/**
 * Build a synthetic top-up option for an arbitrary custom amount.
 *
 * The wallet no longer offers fixed chips, so the client sends a raw amount instead
 * of an option id. The amount is snapped to whole cents because Stripe only bills
 * whole cents; callers must persist the returned `amountMicros`, not the value the
 * user typed, so the ledger matches what Stripe actually charged.
 *
 * Returns null when the amount is unusable, which callers treat as a validation
 * failure.
 */
function resolveCustomTopupOption(amountMicros) {
  const raw = Number(amountMicros);
  if (!Number.isFinite(raw)) return null;

  const cents = Math.round(raw / 10_000);
  if (!Number.isInteger(cents) || cents <= 0) return null;

  const snappedMicros = cents * 10_000;
  if (snappedMicros < MIN_TOPUP_MICROS) return null;
  if (snappedMicros > MAX_TOPUP_MICROS) return null;

  return {
    id: `custom_${snappedMicros}`,
    label: `$${(snappedMicros / 1_000_000).toFixed(2)}`,
    amountMicros: snappedMicros,
    custom: true,
  };
}

function getModelPricing(modelId) {
  if (!modelId) return null;
  return MODEL_PRICING[modelId] || null;
}

function getModelPricingByProviderModel(provider, model) {
  if (!provider || !model) return null;
  return Object.values(MODEL_PRICING).find(
    (entry) => entry.provider === provider && entry.model === model,
  ) || null;
}

function getFeatureConfig(feature) {
  return FEATURE_BILLING[feature] || FEATURE_BILLING.unknown;
}

function isEnforcementEnabled() {
  return BILLING_ENFORCEMENT === 'on';
}

function isShadowMode() {
  return BILLING_ENFORCEMENT === 'shadow';
}

module.exports = {
  PRICING_VERSION,
  DEFAULT_MARKUP_BPS: DEFAULT_MARKUP,
  BILLING_ENFORCEMENT,
  INITIAL_BALANCE_MICROS,
  RESERVATION_TTL_MS,
  MAX_TEXT_CHARS,
  MAX_IMAGE_BASE64_CHARS,
  TOPUP_OPTIONS,
  MIN_TOPUP_MICROS,
  MAX_TOPUP_MICROS,
  resolveCustomTopupOption,
  MODEL_PRICING,
  DEFAULT_MODEL_ID,
  FEATURE_BILLING,
  PAYMENT_FEE_ESTIMATE,
  getTopupOption,
  getModelPricing,
  getModelPricingByProviderModel,
  getFeatureConfig,
  isEnforcementEnabled,
  isShadowMode,
};
