'use strict';

/**
 * Firebase Cloud Functions - Main Entry Point
 * Forkast prepaid AI billing backend.
 *
 * Core endpoints:
 *   POST /runAI                 - server-authoritative AI call with reservation/settlement
 *   POST /runLLM                - backward-compatible alias for /runAI
 *   POST /createCheckoutSession - create Stripe one-time top-up checkout
 *   POST /stripeWebhook         - process Stripe webhook events and credit top-ups
 *   GET  /getBillingSummary     - return balance, recent ledger, top-up options
 *   GET  /topupOptions          - return available top-up options
 *   SCHEDULE releaseExpiredReservations - release stale reservations
 */

const crypto = require('crypto');
const functions = require('firebase-functions/v1');

const { db } = require('./firebase');
const { getAuthenticatedUser } = require('./auth');
const { callLLM } = require('./llm');

const {
  DEFAULT_MODEL_ID,
  MAX_IMAGE_BASE64_CHARS,
  MAX_TEXT_CHARS,
  TOPUP_OPTIONS,
} = require('./billing/config');

const {
  calculateAiRawCostMicros,
  calculateCharge,
  calculateInfraRawCostMicros,
  estimateMaxDebitMicros,
  resolveModelPricing,
} = require('./billing/aiCost');

const {
  InsufficientBalanceError,
  claimReservation,
  releaseReservation,
  reserveBalance,
  settleReservation,
  storeReservationResult,
} = require('./billing/balance');

const { toSafeNumber } = require('./billing/money');

const {
  createTopupCheckout,
  getBillingSummary,
  processStripeEvent,
  releaseExpiredReservations,
} = require('./billing');
const {
  openaiApiKey,
  anthropicApiKey,
  geminiApiKey,
  stripeSecret,
  stripeWebhookSecret,
  safeSecret,
} = require('./billing/params');

const AI_SECRETS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'];
const STRIPE_SECRETS = ['STRIPE_SECRET', 'STRIPE_WEBHOOK_SECRET'];
const ALL_SECRETS = [...AI_SECRETS, ...STRIPE_SECRETS];

const OPERATION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

function setCors(req, res) {
  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = req.headers.origin;
  const allowOrigin =
    allowedOrigins.includes('*') || (origin && allowedOrigins.includes(origin))
      ? origin || '*'
      : allowedOrigins[0] || '*';

  res.set('Access-Control-Allow-Origin', allowOrigin);
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Credentials', 'true');
}

function sendJson(res, status, payload) {
  res.status(status).json(payload);
}

function badRequest(res, message, code = 'bad_request') {
  sendJson(res, 400, { error: message, code });
}

function unauthorized(res) {
  sendJson(res, 401, { error: 'Authentication required', code: 'unauthorized' });
}

function methodNotAllowed(res) {
  sendJson(res, 405, { error: 'Method not allowed', code: 'method_not_allowed' });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientProviderError(err) {
  const status = Number(err?.status || 0);
  if (!status) return true; // network / unknown transport error
  return status === 408 || status === 429 || status >= 500;
}

async function callLLMWithRetry(params, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callLLM(params.prompt, params.options);
    } catch (err) {
      lastErr = err;
      console.error('callLLMWithRetry attempt failed', {
        attempt,
        maxAttempts,
        transient: isTransientProviderError(err),
        message: err?.message || String(err),
        status: err?.status || null,
      });
      if (!isTransientProviderError(err) || attempt === maxAttempts) {
        throw err;
      }
      await sleep(500 * attempt);
    }
  }
  const err = new Error(
    `LLM call failed: ${lastErr?.message || String(lastErr)}`,
  );
  err.cause = lastErr;
  err.status = lastErr?.status || null;
  throw err;
}

function normalizeModelSelection(body) {
  let modelId = body.modelId || null;
  let provider = body.provider || null;
  let model = body.model || null;

  if (!modelId && typeof model === 'string' && model.includes(':')) {
    modelId = model;
    provider = provider || model.split(':')[0];
    model = null;
  }

  return { modelId, provider, model };
}

function safeNumber(value) {
  if (value === undefined || value === null) return null;
  try {
    return toSafeNumber(value, 'billingValue');
  } catch (_err) {
    return null;
  }
}

function billingResponseFromSettlement(settlement, charge, aiRaw, infra) {
  return {
    rawCostMicros: safeNumber(aiRaw + infra),
    aiRawCostMicros: safeNumber(aiRaw),
    infraRawCostMicros: safeNumber(infra),
    markupBps: charge?.markupBps ?? null,
    markupMicros: safeNumber(charge?.markupMicros ?? 0),
    chargedMicros: safeNumber(settlement?.charge ?? charge?.chargedMicros ?? 0),
    balanceBeforeMicros: safeNumber(settlement?.balanceBefore ?? null),
    balanceAfterMicros: safeNumber(settlement?.balanceAfter ?? null),
    pricingVersion: charge?.pricingVersion ?? null,
    ledgerId: settlement?.ledgerId ?? null,
  };
}

async function settleStoredReservation(operationId, reservation) {
  return db.runTransaction(async (tx) => {
    return settleReservation(db, tx, {
      operationId,
      actualRawCostMicros: reservation.actualRawCostMicros || 0,
      aiRawCostMicros: reservation.aiRawCostMicros || 0,
      infraRawCostMicros: reservation.infraRawCostMicros || 0,
      actualMarkupMicros: reservation.actualMarkupMicros || 0,
      actualChargedMicros: reservation.actualChargedMicros || 0,
      feature: reservation.feature,
      provider: reservation.provider,
      model: reservation.model,
      functionName: reservation.functionName || 'runAI',
      externalRequestId: reservation.externalRequestId,
      metadata: reservation.resultMetadata || {},
    });
  });
}

async function runAIHandler(req, res, options = {}) {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }

  let authResult = null;
  try {
    authResult = await getAuthenticatedUser(req);
  } catch (_err) {
    unauthorized(res);
    return;
  }

  const uid = authResult.uid;
  const email = authResult.decoded?.email || null;
  const body = req.body || {};

  const operationId = String(body.operationId || options.operationId || '').trim();
  if (!OPERATION_ID_RE.test(operationId)) {
    badRequest(
      res,
      'operationId is required and must match ^[A-Za-z0-9_-]{8,128}$',
      'invalid_operation_id',
    );
    return;
  }

  const feature = String(body.feature || options.feature || 'unknown');
  const rawText = body.text ?? body.prompt ?? '';
  const imageBase64 = body.imageBase64 || null;

  if (typeof rawText !== 'string') {
    badRequest(res, 'text must be a string', 'invalid_text');
    return;
  }

  if (imageBase64 && typeof imageBase64 !== 'string') {
    badRequest(res, 'imageBase64 must be a string', 'invalid_image');
    return;
  }

  const text = rawText.trim();
  const hasImage = Boolean(imageBase64);

  if (!text && !hasImage) {
    badRequest(res, 'text or imageBase64 is required', 'missing_input');
    return;
  }

  if (text.length > MAX_TEXT_CHARS) {
    sendJson(res, 413, {
      error: `Text exceeds maximum of ${MAX_TEXT_CHARS} characters`,
      code: 'text_too_large',
    });
    return;
  }

  if (hasImage && imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
    sendJson(res, 413, {
      error: `Image exceeds maximum of ${MAX_IMAGE_BASE64_CHARS} base64 characters`,
      code: 'image_too_large',
    });
    return;
  }

  const { modelId, provider, model } = normalizeModelSelection(body);
  const maxTokens = Number.isInteger(body.maxTokens) && body.maxTokens > 0 ? body.maxTokens : null;

  let pricing = null;
  try {
    pricing =
      resolveModelPricing({ provider, model, modelId }) ||
      resolveModelPricing({ modelId: DEFAULT_MODEL_ID });
  } catch (_err) {
    pricing = null;
  }

  if (!pricing) {
    badRequest(res, 'No configured model for this request', 'unknown_model');
    return;
  }

  let maxDebitMicros = 0;
  try {
    maxDebitMicros = estimateMaxDebitMicros({
      feature,
      provider: pricing.provider,
      model: pricing.model,
      modelId: `${pricing.provider}:${pricing.model.replace(/\./g, '-')}`,
      hasImage,
    });
  } catch (err) {
    badRequest(res, `Cannot estimate cost: ${err.message}`, 'cost_estimate_failed');
    return;
  }

  // 1. Reserve balance.
  let reservationResult = null;
  try {
    reservationResult = await db.runTransaction(async (tx) =>
      reserveBalance(db, tx, {
        userId: uid,
        operationId,
        maxDebitMicros,
        feature,
        functionName: 'runAI',
        email,
      }),
    );
  } catch (err) {
    if (err instanceof InsufficientBalanceError) {
      sendJson(res, 402, {
        error: 'Insufficient prepaid balance',
        code: 'insufficient_balance',
        availableBalanceMicros: err.details?.availableBalanceMicros ?? null,
        requiredMicros: err.details?.requiredMicros ?? maxDebitMicros,
      });
      return;
    }
    console.error('Reservation failed', err);
    sendJson(res, 500, { error: 'Billing reservation failed', code: 'reservation_failed' });
    return;
  }

  const reservation = reservationResult.reservation || {};

  // 2. Handle existing reservation states for idempotency.
  if (!reservationResult.created) {
    if (reservation.status === 'settled') {
      if (reservation.result) {
        sendJson(res, 200, {
          success: true,
          idempotent: true,
          ...reservation.result,
          billing: {
            rawCostMicros: reservation.actualRawCostMicros || 0,
            aiRawCostMicros: reservation.aiRawCostMicros || 0,
            infraRawCostMicros: reservation.infraRawCostMicros || 0,
            markupBps: reservation.markupBps || null,
            markupMicros: reservation.actualMarkupMicros || 0,
            chargedMicros: reservation.actualChargedMicros || 0,
            ledgerId: reservation.ledgerId || null,
            pricingVersion: reservation.pricingVersion || null,
          },
        });
        return;
      }
      sendJson(res, 409, {
        error: 'Operation already settled without a stored result',
        code: 'settled_without_result',
      });
      return;
    }

    if (reservation.status === 'completed_unsettled') {
      try {
        const settlement = await settleStoredReservation(operationId, reservation);
        sendJson(res, 200, {
          success: true,
          idempotent: true,
          ...(reservation.result || {}),
          billing: {
            rawCostMicros: reservation.actualRawCostMicros || 0,
            aiRawCostMicros: reservation.aiRawCostMicros || 0,
            infraRawCostMicros: reservation.infraRawCostMicros || 0,
            markupBps: reservation.markupBps || null,
            markupMicros: reservation.actualMarkupMicros || 0,
            chargedMicros: settlement.charge || 0,
            balanceBeforeMicros: settlement.balanceBefore || null,
            balanceAfterMicros: settlement.balanceAfter || null,
            ledgerId: settlement.ledgerId || null,
          },
        });
        return;
      } catch (err) {
        console.error('Failed to settle completed_unsettled reservation', err);
        sendJson(res, 500, { error: 'Billing settlement failed', code: 'settlement_failed' });
        return;
      }
    }

    if (reservation.status === 'running') {
      sendJson(res, 409, {
        error: 'Operation is already running',
        code: 'operation_running',
        status: reservation.status,
      });
      return;
    }

    if (reservation.status === 'released') {
      sendJson(res, 409, {
        error: 'Operation reservation was released',
        code: 'operation_released',
        status: reservation.status,
      });
      return;
    }
  }

  // 3. Claim the reservation to prevent duplicate provider calls.
  let claim = null;
  try {
    claim = await db.runTransaction(async (tx) => claimReservation(db, tx, operationId));
  } catch (err) {
    console.error('Reservation claim failed', err);
    sendJson(res, 500, { error: 'Billing reservation claim failed', code: 'claim_failed' });
    return;
  }

  if (!claim.claimed) {
    if (claim.reason === 'settled' && claim.reservation?.result) {
      sendJson(res, 200, {
        success: true,
        idempotent: true,
        ...claim.reservation.result,
        billing: {
          rawCostMicros: claim.reservation.actualRawCostMicros || 0,
          aiRawCostMicros: claim.reservation.aiRawCostMicros || 0,
          infraRawCostMicros: claim.reservation.infraRawCostMicros || 0,
          markupBps: claim.reservation.markupBps || null,
          markupMicros: claim.reservation.actualMarkupMicros || 0,
          chargedMicros: claim.reservation.actualChargedMicros || 0,
          ledgerId: claim.reservation.ledgerId || null,
        },
      });
      return;
    }

    sendJson(res, 409, {
      error: 'Operation is already in progress',
      code: 'operation_in_progress',
      status: claim.reason,
    });
    return;
  }

  // 4. Call provider.
  const prompt = text || 'Analyze the provided image.';
  let providerResult = null;
  try {
    providerResult = await callLLMWithRetry(
      {
        prompt,
        options: {
          provider: pricing.provider,
          model: pricing.model,
          maxTokens,
          image: hasImage
            ? {
                base64: imageBase64,
                mimeType: body.imageMimeType || 'image/jpeg',
              }
            : undefined,
        },
      },
      3,
    );
  } catch (err) {
    // Failed provider request: release reservation and record no charge by default.
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
          functionName: 'runAI',
          metadata: {
            failure: true,
            errorMessage: err?.message || 'provider_error',
            errorStatus: err?.status || null,
          },
        }),
      );
    } catch (settleErr) {
      console.error('Failed to settle failed provider request', settleErr);
    }

    const status = Number(err?.status || 0);
    sendJson(res, status >= 400 && status < 600 ? status : 502, {
      error: 'AI provider request failed',
      code: 'provider_failed',
      provider: pricing.provider,
      model: pricing.model,
    });
    return;
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
          functionName: 'runAI',
          metadata: { emptyOutput: true },
        }),
      );
    } catch (settleErr) {
      console.error('Failed to settle empty output request', settleErr);
    }

    sendJson(res, 502, {
      error: 'AI provider returned empty output',
      code: 'empty_output',
      provider: providerResult?.provider || pricing.provider,
      model: providerResult?.model || pricing.model,
    });
    return;
  }

  // 5. Calculate authoritative cost.
  let aiCost = null;
  let infraRaw = 0n;
  let charge = null;
  try {
    aiCost = calculateAiRawCostMicros({
      provider: providerResult.provider,
      model: providerResult.model,
      usage: providerResult.usage,
    });
    infraRaw = calculateInfraRawCostMicros(feature);
    charge = calculateCharge({ rawCostMicros: aiCost.rawCostMicros + infraRaw });
  } catch (err) {
    console.error('Cost calculation failed after provider success', err);
    // Do not charge if we cannot price the response.
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
          provider: providerResult.provider,
          model: providerResult.model,
          functionName: 'runAI',
          metadata: { pricingError: err?.message || 'pricing_error' },
        }),
      );
    } catch (settleErr) {
      console.error('Failed to settle pricing-failed request', settleErr);
    }

    sendJson(res, 500, {
      error: 'Cost calculation failed',
      code: 'pricing_failed',
    });
    return;
  }

  const resultPayload = {
    output: providerResult.output,
    provider: providerResult.provider,
    model: providerResult.model,
    requestId: providerResult.providerRequestId || null,
    usage: providerResult.usage || null,
  };

  const actual = {
    actualRawCostMicros: aiCost.rawCostMicros + infraRaw,
    aiRawCostMicros: aiCost.rawCostMicros,
    infraRawCostMicros: infraRaw,
    actualMarkupMicros: charge.markupMicros,
    actualChargedMicros: charge.chargedMicros,
    provider: providerResult.provider,
    model: providerResult.model,
    externalRequestId: providerResult.providerRequestId || null,
    metadata: {
      costSource: aiCost.costSource,
      normalizedUsage: providerResult.usage || null,
    },
  };

  // 6. Persist result before settlement so a crash can be recovered idempotently.
  try {
    await db.runTransaction(async (tx) =>
      storeReservationResult(db, tx, operationId, resultPayload, actual),
    );
  } catch (err) {
    console.error('Failed to store reservation result', err);
    sendJson(res, 500, { error: 'Failed to persist AI result', code: 'store_result_failed' });
    return;
  }

  // 7. Settle reservation and append ledger.
  let settlement = null;
  try {
    settlement = await db.runTransaction(async (tx) =>
      settleReservation(db, tx, {
        operationId,
        actualRawCostMicros: actual.actualRawCostMicros,
        aiRawCostMicros: actual.aiRawCostMicros,
        infraRawCostMicros: actual.infraRawCostMicros,
        actualMarkupMicros: actual.actualMarkupMicros,
        actualChargedMicros: actual.actualChargedMicros,
        feature,
        provider: actual.provider,
        model: actual.model,
        functionName: 'runAI',
        externalRequestId: actual.externalRequestId,
        metadata: actual.metadata,
      }),
    );
  } catch (err) {
    console.error('Settlement failed after result stored', err);
    sendJson(res, 500, {
      error: 'Billing settlement failed. Retry the same operationId to settle.',
      code: 'settlement_failed',
    });
    return;
  }

  sendJson(res, 200, {
    success: true,
    ...resultPayload,
    billing: billingResponseFromSettlement(
      settlement,
      charge,
      aiCost.rawCostMicros,
      infraRaw,
    ),
  });
}

/**
 * POST /runAI
 */
exports.runAI = functions.runWith({ secrets: AI_SECRETS }).https.onRequest(async (req, res) => {
  await runAIHandler(req, res, { feature: 'unknown' });
});

/**
 * POST /runLLM
 * Backward-compatible alias. New clients should use /runAI with an operationId.
 */
exports.runLLM = functions.runWith({ secrets: AI_SECRETS }).https.onRequest(async (req, res) => {
  const generatedOperationId = `legacy_${crypto.randomUUID().replace(/-/g, '')}`;
  await runAIHandler(req, res, {
    feature: req.body?.feature || 'unknown',
    operationId: req.body?.operationId || generatedOperationId,
  });
});

/**
 * POST /createCheckoutSession
 * Creates a one-time Stripe top-up checkout.
 *
 * Body: { optionId: "usd_10" }
 */
exports.createCheckoutSession = functions.runWith({ secrets: STRIPE_SECRETS }).https.onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }

  let authResult = null;
  try {
    authResult = await getAuthenticatedUser(req);
  } catch (_err) {
    unauthorized(res);
    return;
  }

  const optionId = String(req.body?.optionId || '').trim();
  if (!optionId) {
    badRequest(res, 'optionId is required', 'missing_option_id');
    return;
  }

  try {
    const result = await createTopupCheckout({
      uid: authResult.uid,
      email: authResult.decoded?.email || null,
      optionId,
    });
    sendJson(res, 200, {
      success: true,
      ...result,
    });
  } catch (err) {
    console.error('createCheckoutSession failed', err);
    if (err?.code === 'invalid_option') {
      badRequest(res, 'Unknown top-up option', 'invalid_option');
      return;
    }
    sendJson(res, 500, {
      error: 'Failed to create top-up checkout',
      code: 'checkout_failed',
    });
  }
});

/**
 * POST /stripeWebhook
 */
exports.stripeWebhook = functions.runWith({ secrets: STRIPE_SECRETS }).https.onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }

  const signature = req.headers['stripe-signature'];
  if (!signature) {
    badRequest(res, 'Missing stripe-signature header', 'missing_signature');
    return;
  }

  try {
    const stripe = require('./billing').getStripe();
    const webhookSecret =
      process.env.STRIPE_WEBHOOK_SECRET ||
      safeSecret(stripeWebhookSecret);

    if (!webhookSecret) {
      console.error('STRIPE_WEBHOOK_SECRET is not configured');
      sendJson(res, 500, {
        error: 'Stripe webhook secret is not configured',
        code: 'webhook_secret_missing',
      });
      return;
    }

    const event = stripe.webhooks.constructEvent(req.rawBody, signature, webhookSecret);
    const result = await processStripeEvent(event);
    sendJson(res, 200, {
      received: true,
      ...result,
    });
  } catch (err) {
    console.error('stripeWebhook failed', err);
    sendJson(res, 400, {
      error: 'Webhook signature verification failed',
      code: 'invalid_signature',
    });
  }
});

/**
 * GET /getBillingSummary
 */
exports.getBillingSummary = functions.https.onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    methodNotAllowed(res);
    return;
  }

  let authResult = null;
  try {
    authResult = await getAuthenticatedUser(req);
  } catch (_err) {
    unauthorized(res);
    return;
  }

  try {
    const summary = await getBillingSummary(authResult.uid);
    sendJson(res, 200, {
      success: true,
      ...summary,
    });
  } catch (err) {
    console.error('getBillingSummary failed', err);
    sendJson(res, 500, {
      error: 'Failed to load billing summary',
      code: 'summary_failed',
    });
  }
});

/**
 * GET /topupOptions
 */
exports.topupOptions = functions.https.onRequest(async (req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  sendJson(res, 200, {
    success: true,
    options: TOPUP_OPTIONS,
  });
});

/**
 * Scheduled cleanup for stale reservations.
 */
exports.releaseExpiredReservations = functions.pubsub
  .schedule('every 10 minutes')
  .onRun(async () => {
    try {
      const result = await releaseExpiredReservations(100);
      console.log('releaseExpiredReservations completed', result);
    } catch (err) {
      console.error('releaseExpiredReservations failed', err);
    }
  });

/**
 * GET /health
 */
exports.health = functions.runWith({ secrets: ALL_SECRETS }).https.onRequest(async (req, res) => {
  setCors(req, res);
  sendJson(res, 200, {
    ok: true,
    service: 'forkcast-backend',
    pricingVersion: require('./billing/config').PRICING_VERSION,
    config: {
      hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY || safeSecret(openaiApiKey)),
      hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY || safeSecret(anthropicApiKey)),
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY || safeSecret(geminiApiKey)),
      hasStripeSecret: Boolean(process.env.STRIPE_SECRET || safeSecret(stripeSecret)),
      hasStripeWebhookSecret: Boolean(
        process.env.STRIPE_WEBHOOK_SECRET || safeSecret(stripeWebhookSecret),
      ),
    },
  });
});
