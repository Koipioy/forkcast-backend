'use strict';

/**
 * AI calls from the video worker, metered through the existing prepaid ledger.
 *
 * `runAI` is the client-facing metered entry point, but it is an HTTP handler:
 * the worker cannot call it without calling itself over the network. This is
 * the same reserve -> claim -> call -> store -> settle sequence, factored out so
 * the video analysis and transcription calls land in the same ledger with the
 * same idempotency guarantees as every other AI feature.
 *
 * The provider call itself is injected (`runFn`), because a Whisper
 * transcription and a Gemini video analysis are different SDK calls that both
 * need the same money handling.
 */

const crypto = require('crypto');

const { db } = require('../firebase');
const {
  calculateAiRawCostMicros,
  calculateCharge,
  calculateInfraRawCostMicros,
  estimateMaxDebitMicros,
  resolveModelPricing,
} = require('../billing/aiCost');
const {
  InsufficientBalanceError,
  claimReservation,
  releaseReservation,
  reserveBalance,
  settleReservation,
  storeReservationResult,
} = require('../billing/balance');
const { DEFAULT_MODEL_ID } = require('../billing/config');
const { toSafeNumber } = require('../billing/money');
const { callLLM } = require('../llm');
const { AnalysisFailedError, ProviderUnavailableError } = require('./errors');

function newOperationId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 128);
}

function safeNumber(value) {
  try {
    return toSafeNumber(value, 'billingValue');
  } catch (_err) {
    return null;
  }
}

function resolvePricing({ provider, model, modelId }) {
  return (
    resolveModelPricing({ provider, model, modelId }) ||
    resolveModelPricing({ modelId: DEFAULT_MODEL_ID })
  );
}

/**
 * Run one metered AI call.
 *
 * @param {{uid: string, email?: string|null, feature: string, functionName?: string,
 *          provider?: string, model?: string, modelId?: string,
 *          runFn: () => Promise<{output: string, usage?: object, provider?: string,
 *                                model?: string, providerRequestId?: string|null}>,
 *          operationId?: string, metadata?: object}} params
 * @returns {Promise<{output: string, usage: object|null, provider: string, model: string,
 *                   billing: object}>}
 */
async function meteredAICall(params) {
  const {
    uid,
    email = null,
    feature,
    functionName = 'recipeImportWorker',
    runFn,
    metadata = {},
  } = params;

  if (!uid) throw new Error('meteredAICall requires uid');
  if (typeof runFn !== 'function') throw new Error('meteredAICall requires runFn');

  const operationId = params.operationId || newOperationId('rvi');
  const pricing = resolvePricing(params);
  if (!pricing) {
    throw new ProviderUnavailableError('No configured model for this request.', {});
  }

  const modelId = `${pricing.provider}:${pricing.model.replace(/\./g, '-')}`;

  let maxDebitMicros = 0;
  try {
    maxDebitMicros = estimateMaxDebitMicros({
      feature,
      provider: pricing.provider,
      model: pricing.model,
      modelId,
      hasImage: Boolean(params.hasImage),
    });
  } catch (err) {
    throw new ProviderUnavailableError(`Cannot estimate cost: ${err.message}`, {});
  }

  let reservationResult;
  try {
    reservationResult = await db.runTransaction(async (tx) =>
      reserveBalance(db, tx, {
        userId: uid,
        operationId,
        maxDebitMicros,
        feature,
        functionName,
        email,
      }),
    );
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      const balanceErr = new AnalysisFailedError('Insufficient prepaid balance.', {
        code: 'insufficient_balance',
        availableBalanceMicros: err.details?.availableBalanceMicros ?? null,
        requiredMicros: err.details?.requiredMicros ?? maxDebitMicros,
      });
      balanceErr.code = 'insufficient_balance';
      balanceErr.status = 402;
      throw balanceErr;
    }
    throw err;
  }

  if (!reservationResult.created) {
    const status = reservationResult.reservation?.status;
    if (status === 'settled' || status === 'running' || status === 'completed_unsettled') {
      throw new AnalysisFailedError(
        `Operation already in a terminal or running state: ${status}`,
        { operationId, status },
      );
    }
  }

  let claim;
  try {
    claim = await db.runTransaction(async (tx) => claimReservation(db, tx, operationId));
  } catch (err) {
    throw new AnalysisFailedError('Billing reservation claim failed.', { operationId });
  }

  if (!claim.claimed) {
    throw new AnalysisFailedError('Operation is already in progress.', {
      operationId,
      reason: claim.reason,
    });
  }

  let providerResult;
  try {
    providerResult = await runFn();
  } catch (err) {
    // Mirror runAI: charge nothing for a failed provider call, but record the
    // attempt so the ledger shows the work was tried.
    let aiRaw = 0n;
    try {
      if (err?.usage) {
        aiRaw = calculateAiRawCostMicros({
          provider: pricing.provider,
          model: pricing.model,
          usage: err.usage,
        }).rawCostMicros;
      }
    } catch (_calcErr) {
      aiRaw = 0n;
    }

    try {
      await db.runTransaction(async (tx) =>
        settleReservation(db, tx, {
          operationId,
          actualRawCostMicros: aiRaw,
          aiRawCostMicros: aiRaw,
          infraRawCostMicros: 0,
          actualMarkupMicros: 0,
          actualChargedMicros: 0,
          ledgerSource: 'ai',
          ledgerType: 'no_charge',
          ledgerStatus: 'no_charge',
          feature,
          provider: pricing.provider,
          model: pricing.model,
          functionName,
          metadata: {
            failure: true,
            errorMessage: err?.message || 'provider_error',
            errorStatus: err?.status || null,
            ...metadata,
          },
        }),
      );
    } catch (settleErr) {
      console.error('meteredAICall: failed to settle failed provider call', settleErr);
    }

    throw err;
  }

  if (!providerResult?.output || !String(providerResult.output).trim()) {
    try {
      await db.runTransaction(async (tx) =>
        settleReservation(db, tx, {
          operationId,
          actualRawCostMicros: 0,
          aiRawCostMicros: 0,
          infraRawCostMicros: 0,
          actualMarkupMicros: 0,
          actualChargedMicros: 0,
          ledgerSource: 'ai',
          ledgerType: 'no_charge',
          ledgerStatus: 'empty_output',
          feature,
          provider: providerResult?.provider || pricing.provider,
          model: providerResult?.model || pricing.model,
          functionName,
          metadata: { emptyOutput: true, ...metadata },
        }),
      );
    } catch (settleErr) {
      console.error('meteredAICall: failed to settle empty output', settleErr);
    }

    throw new AnalysisFailedError('AI provider returned empty output.', {
      provider: providerResult?.provider || pricing.provider,
      model: providerResult?.model || pricing.model,
    });
  }

  let aiCost;
  let infraRaw = 0n;
  let charge;
  try {
    aiCost = calculateAiRawCostMicros({
      provider: providerResult.provider || pricing.provider,
      model: providerResult.model || pricing.model,
      usage: providerResult.usage,
    });
    infraRaw = calculateInfraRawCostMicros(feature);
    charge = calculateCharge({ rawCostMicros: aiCost.rawCostMicros + infraRaw });
  } catch (err) {
    // Never charge what we cannot price.
    try {
      await db.runTransaction(async (tx) =>
        settleReservation(db, tx, {
          operationId,
          actualRawCostMicros: 0,
          aiRawCostMicros: 0,
          infraRawCostMicros: 0,
          actualMarkupMicros: 0,
          actualChargedMicros: 0,
          ledgerSource: 'ai',
          ledgerType: 'no_charge',
          ledgerStatus: 'pricing_failed',
          feature,
          provider: providerResult.provider || pricing.provider,
          model: providerResult.model || pricing.model,
          functionName,
          metadata: { pricingError: err?.message || 'pricing_error', ...metadata },
        }),
      );
    } catch (settleErr) {
      console.error('meteredAICall: failed to settle pricing failure', settleErr);
    }
    throw new AnalysisFailedError('Cost calculation failed.', {});
  }

  const resultPayload = {
    output: providerResult.output,
    provider: providerResult.provider || pricing.provider,
    model: providerResult.model || pricing.model,
    requestId: providerResult.providerRequestId || null,
    usage: providerResult.usage || null,
  };

  const actual = {
    actualRawCostMicros: aiCost.rawCostMicros + infraRaw,
    aiRawCostMicros: aiCost.rawCostMicros,
    infraRawCostMicros: infraRaw,
    actualMarkupMicros: charge.markupMicros,
    actualChargedMicros: charge.chargedMicros,
    provider: resultPayload.provider,
    model: resultPayload.model,
    externalRequestId: resultPayload.requestId,
    metadata: { costSource: aiCost.costSource, ...metadata },
  };

  try {
    await db.runTransaction(async (tx) =>
      storeReservationResult(db, tx, operationId, resultPayload, actual),
    );
  } catch (err) {
    throw new AnalysisFailedError('Failed to persist AI result.', { operationId });
  }

  let settlement;
  try {
    settlement = await db.runTransaction(async (tx) =>
      settleReservation(db, tx, {
        operationId,
        ...actual,
        feature,
        functionName,
        metadata: actual.metadata,
      }),
    );
  } catch (err) {
    throw new AnalysisFailedError(
      'Billing settlement failed. Retry the same operationId to settle.',
      { operationId },
    );
  }

  return {
    ...resultPayload,
    billing: {
      rawCostMicros: safeNumber(aiCost.rawCostMicros + infraRaw),
      aiRawCostMicros: safeNumber(aiCost.rawCostMicros),
      infraRawCostMicros: safeNumber(infraRaw),
      markupBps: charge?.markupBps ?? null,
      markupMicros: safeNumber(charge?.markupMicros ?? 0),
      chargedMicros: safeNumber(settlement?.charge ?? charge?.chargedMicros ?? 0),
      balanceBeforeMicros: safeNumber(settlement?.balanceBefore ?? null),
      balanceAfterMicros: safeNumber(settlement?.balanceAfter ?? null),
      pricingVersion: charge?.pricingVersion ?? null,
      ledgerId: settlement?.ledgerId ?? null,
      operationId,
    },
  };
}

/** Metered wrapper around the shared text/image LLM proxy. */
async function meteredLLMCall(params) {
  return meteredAICall({
    ...params,
    runFn: () =>
      callLLM(params.prompt, {
        provider: params.provider,
        model: params.model,
        maxTokens: params.maxTokens,
        images: params.images,
        image: params.image,
      }),
  });
}

module.exports = {
  meteredAICall,
  meteredLLMCall,
  newOperationId,
};
