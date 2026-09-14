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

function safeRuntimeConfig() {
  try {
    // firebase-functions may not be available in pure unit tests.
    const functions = require('firebase-functions');
    if (functions && typeof functions.config === 'function') {
      return functions.config() || {};
    }
  } catch (_err) {
    // Ignore.
  }
  return {};
}

function envInt(name, fallback) {
  const cfg = safeRuntimeConfig();
  const envValue = process.env[name];
  const cfgValue =
    cfg?.billing?.[name.toLowerCase()] ??
    cfg?.billing?.[name.toLowerCase().replace(/_/g, '_')];
  const raw = envValue ?? cfgValue ?? fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer`);
  }
  return n;
}

function envStr(name, fallback) {
  const cfg = safeRuntimeConfig();
  const envValue = process.env[name];
  const cfgValue = cfg?.billing?.[name.toLowerCase()];
  return String(envValue ?? cfgValue ?? fallback);
}

const PRICING_VERSION = envStr('BILLING_PRICING_VERSION', DEFAULT_PRICING_VERSION);
const DEFAULT_MARKUP = envInt('BILLING_MARKUP_BPS', DEFAULT_MARKUP_BPS);
const BILLING_ENFORCEMENT = envStr('BILLING_ENFORCEMENT', 'on').toLowerCase(); // on | shadow | off

const RESERVATION_TTL_MS = envInt('BILLING_RESERVATION_TTL_MS', 30 * 60 * 1000);
const MAX_TEXT_CHARS = envInt('BILLING_MAX_TEXT_CHARS', 100_000);
const MAX_IMAGE_BASE64_CHARS = envInt('BILLING_MAX_IMAGE_BASE64_CHARS', 8_000_000);

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
  RESERVATION_TTL_MS,
  MAX_TEXT_CHARS,
  MAX_IMAGE_BASE64_CHARS,
  TOPUP_OPTIONS,
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
