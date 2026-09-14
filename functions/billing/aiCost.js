'use strict';

const {
  ceilDiv,
  markupMicros,
  tokenCostMicros,
  toBigInt,
  toSafeNumber,
} = require('./money');
const {
  DEFAULT_MARKUP_BPS,
  PRICING_VERSION,
  getFeatureConfig,
  getModelPricing,
  getModelPricingByProviderModel,
} = require('./config');

function resolveModelPricing({ provider, model, modelId }) {
  if (modelId) {
    const byId = getModelPricing(modelId);
    if (byId) return byId;
  }
  const byProviderModel = getModelPricingByProviderModel(provider, model);
  if (byProviderModel) return byProviderModel;
  return null;
}

function normalizeUsage(usage) {
  const u = usage || {};
  return {
    inputTokens: Number(u.inputTokens || 0),
    outputTokens: Number(u.outputTokens || 0),
    cachedInputTokens: Number(u.cachedInputTokens || 0),
    reasoningTokens: Number(u.reasoningTokens || 0),
    totalTokens: Number(u.totalTokens || 0),
  };
}

/**
 * Calculate raw AI provider cost in microdollars.
 *
 * If providerReportedCostMicros is present, it is used directly.
 * Otherwise cost is calculated from normalized token usage and central pricing.
 */
function calculateAiRawCostMicros({ provider, model, modelId, usage, providerReportedCostMicros }) {
  if (providerReportedCostMicros !== undefined && providerReportedCostMicros !== null) {
    const reported = toBigInt(providerReportedCostMicros, 'providerReportedCostMicros');
    return {
      rawCostMicros: reported < 0n ? 0n : reported,
      costSource: 'provider_reported',
      pricing: null,
    };
  }

  const pricing = resolveModelPricing({ provider, model, modelId });
  if (!pricing) {
    throw new Error(`No pricing configured for model: ${modelId || `${provider}:${model}`}`);
  }

  const normalized = normalizeUsage(usage);
  const cached = Math.max(0, normalized.cachedInputTokens);
  const nonCachedInput = Math.max(0, normalized.inputTokens - cached);
  const reasoning = Math.max(0, normalized.reasoningTokens);
  const output = Math.max(0, normalized.outputTokens);

  const inputCost = tokenCostMicros(nonCachedInput, pricing.inputMicrosPerMillion);
  const cachedCost = tokenCostMicros(cached, pricing.cachedInputMicrosPerMillion ?? pricing.inputMicrosPerMillion);
  const outputCost = tokenCostMicros(output, pricing.outputMicrosPerMillion);
  const reasoningCost = tokenCostMicros(reasoning, pricing.reasoningOutputMicrosPerMillion ?? pricing.outputMicrosPerMillion);

  const raw = inputCost + cachedCost + outputCost + reasoningCost;

  return {
    rawCostMicros: raw,
    costSource: 'token_pricing',
    pricing,
    normalizedUsage: normalized,
  };
}

function calculateInfraRawCostMicros(feature) {
  const featureConfig = getFeatureConfig(feature);
  return toBigInt(featureConfig.infraMicros || 0, 'infraMicros');
}

function calculateCharge({ rawCostMicros, markupBps = DEFAULT_MARKUP_BPS }) {
  const raw = toBigInt(rawCostMicros, 'rawCostMicros');
  const markup = markupMicros(raw, markupBps);
  const charged = raw + markup;
  return {
    rawCostMicros: raw,
    markupBps: Number(markupBps),
    markupMicros: markup,
    chargedMicros: charged,
    pricingVersion: PRICING_VERSION,
  };
}

function estimateMaxDebitMicros({ feature, provider, model, modelId, hasImage = false }) {
  const featureConfig = getFeatureConfig(feature);
  const pricing = resolveModelPricing({ provider, model, modelId });
  if (!pricing) {
    // Conservative fallback if model is missing: use default model pricing.
    const fallback = getModelPricing(require('./config').DEFAULT_MODEL_ID);
    if (!fallback) {
      throw new Error('No default model pricing configured');
    }
    return estimateMaxDebitMicros({
      feature,
      provider: fallback.provider,
      model: fallback.model,
      modelId: `${fallback.provider}:${fallback.model.replace(/\./g, '-')}`,
      hasImage,
    });
  }

  const maxInput = Number(featureConfig.maxInputTokens || 0);
  const maxOutput = Number(featureConfig.maxOutputTokens || 0);
  const imageReserve = hasImage ? Number(featureConfig.imageReserveMicros || 0) : 0;

  const maxInputCost = tokenCostMicros(maxInput, pricing.inputMicrosPerMillion);
  const maxOutputCost = tokenCostMicros(maxOutput, pricing.outputMicrosPerMillion);
  const infra = toBigInt(featureConfig.infraMicros || 0, 'infraMicros');
  const raw = maxInputCost + maxOutputCost + infra + BigInt(imageReserve);
  const charge = calculateCharge({ rawCostMicros: raw });
  return toSafeNumber(charge.chargedMicros, 'maxDebitMicros');
}

module.exports = {
  resolveModelPricing,
  normalizeUsage,
  calculateAiRawCostMicros,
  calculateInfraRawCostMicros,
  calculateCharge,
  estimateMaxDebitMicros,
};
