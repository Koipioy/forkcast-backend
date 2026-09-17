'use strict';

/**
 * LLM proxy utilities.
 *
 * Handles communication with LLM providers and returns normalized usage data
 * for the billing layer.
 */

const OpenAI = require('openai');
const { DEFAULT_MODEL_ID } = require('./billing/config');
const {
  openaiApiKey,
  anthropicApiKey,
  geminiApiKey,
  safeSecret,
} = require('./billing/params');

const PROVIDERS = ['openai', 'anthropic', 'google'];

function envFirst(envKeys) {
  for (const key of envKeys) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
}

function getOpenAIKey() {
  return envFirst(['OPENAI_API_KEY', 'OPENAI_KEY']) || safeSecret(openaiApiKey);
}

function getOpenAIBaseUrl() {
  return envFirst(['OPENAI_BASE_URL', 'OPENAI_API_URL']);
}

function getAnthropicKey() {
  return envFirst(['ANTHROPIC_API_KEY']) || safeSecret(anthropicApiKey);
}

function getAnthropicBaseUrl() {
  return envFirst(['ANTHROPIC_BASE_URL']);
}

function getGeminiKey() {
  return envFirst(['GEMINI_API_KEY']) || safeSecret(geminiApiKey);
}

function getGeminiBaseUrl() {
  return envFirst(['GEMINI_BASE_URL']);
}

let openaiClient = null;
let openaiClientKey = null;

function getOpenAIClient() {
  const key = getOpenAIKey();
  if (!key) return null;
  if (openaiClient && openaiClientKey === key) {
    return openaiClient;
  }
  const baseUrl = getOpenAIBaseUrl();
  openaiClient = new OpenAI({
    apiKey: key,
    ...(baseUrl ? { baseURL: baseUrl } : {}),
  });
  openaiClientKey = key;
  return openaiClient;
}

function defaultModelParts() {
  // DEFAULT_MODEL_ID is a catalog id like "openai:gpt-5-6-luna".
  // The API model is stored in billing config, e.g. "gpt-5.6-luna".
  try {
    const { getModelPricing } = require('./billing/config');
    const pricing = getModelPricing(DEFAULT_MODEL_ID);
    if (pricing?.provider && pricing?.model) {
      return { provider: pricing.provider, model: pricing.model };
    }
  } catch (_err) {
    // Fall through to conservative default.
  }
  return { provider: 'openai', model: 'gpt-5.6-luna' };
}

function getDefaultModel() {
  return defaultModelParts().model;
}

function isProvider(value) {
  return PROVIDERS.includes(value);
}

function inferProvider(model) {
  if (typeof model !== 'string') return null;
  const lower = model.toLowerCase();
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3')) return 'openai';
  if (lower.startsWith('claude-')) return 'anthropic';
  if (lower.startsWith('gemini-')) return 'google';
  return null;
}

function normalizeProvider(provider, model) {
  if (isProvider(provider)) return provider;
  const inferred = inferProvider(model);
  if (inferred) return inferred;
  return defaultModelParts().provider;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, '');
}

function normalizeOpenAIUsage(usage) {
  const u = usage || {};
  return {
    inputTokens: Number(u.prompt_tokens || 0),
    outputTokens: Number(u.completion_tokens || 0),
    cachedInputTokens: Number(u.prompt_tokens_details?.cached_tokens || 0),
    reasoningTokens: Number(u.completion_tokens_details?.reasoning_tokens || 0),
    totalTokens: Number(u.total_tokens || 0),
  };
}

function normalizeAnthropicUsage(usage) {
  const u = usage || {};
  const cacheCreation = Number(u.cache_creation_input_tokens || 0);
  const cacheRead = Number(u.cache_read_input_tokens || 0);
  const baseInput = Number(u.input_tokens || 0);
  return {
    // Treat cache creation as ordinary input and cache reads as cached input.
    inputTokens: baseInput + cacheCreation + cacheRead,
    outputTokens: Number(u.output_tokens || 0),
    cachedInputTokens: cacheRead,
    reasoningTokens: 0,
    totalTokens: baseInput + cacheCreation + cacheRead + Number(u.output_tokens || 0),
  };
}

function normalizeGoogleUsage(usageMetadata) {
  const u = usageMetadata || {};
  return {
    inputTokens: Number(u.promptTokenCount || 0),
    outputTokens: Number(u.candidatesTokenCount || 0),
    cachedInputTokens: Number(u.cachedContentTokenCount || 0),
    reasoningTokens: Number(u.thoughtsTokenCount || 0),
    totalTokens: Number(u.totalTokenCount || 0),
  };
}

/**
 * Normalise the single-image and many-images cases into one list.
 *
 * `image` is the original single-image contract every existing caller uses and
 * is unchanged. `images` was added for the recipe video path, which sends a
 * sampled frame set in one request - one call per frame would multiply the
 * token bill by the frame count.
 */
function imageList(image, images) {
  if (Array.isArray(images)) return images.filter((item) => item && item.base64);
  if (image && image.base64) return [image];
  return [];
}

function buildOpenAIContent(prompt, image, images) {
  const list = imageList(image, images);
  if (list.length === 0) return prompt;
  return [
    { type: 'text', text: prompt },
    ...list.map((item) => ({
      type: 'image_url',
      image_url: {
        url: `data:${item.mimeType || 'image/jpeg'};base64,${item.base64}`,
      },
    })),
  ];
}

function buildAnthropicContent(prompt, image, images) {
  const list = imageList(image, images);
  if (list.length === 0) return prompt;
  return [
    { type: 'text', text: prompt },
    ...list.map((item) => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: item.mimeType || 'image/jpeg',
        data: item.base64,
      },
    })),
  ];
}

function buildGoogleContent(prompt, image, images) {
  const parts = [{ text: prompt }];
  for (const item of imageList(image, images)) {
    parts.push({
      inlineData: {
        mimeType: item.mimeType || 'image/jpeg',
        data: item.base64,
      },
    });
  }
  return [{ role: 'user', parts }];
}

async function callOpenAI(prompt, model = null, options = {}) {
  const client = getOpenAIClient();
  if (!client) {
    throw new Error('OpenAI client not initialized. Check OPENAI_API_KEY configuration.');
  }

  const modelToUse = model || getDefaultModel();

  const body = {
    model: modelToUse,
    messages: [
      {
        role: 'user',
        content: buildOpenAIContent(prompt, options.image, options.images),
      },
    ],
  };

  if (options.maxTokens) {
    // Newer OpenAI chat models reject max_tokens. Use the current parameter name.
    body.max_completion_tokens = options.maxTokens;
  }

  const response = await client.chat.completions.create(body);

  const output = response.choices?.[0]?.message?.content || '';
  const usage = normalizeOpenAIUsage(response.usage);

  return {
    output,
    usage,
    providerRequestId: response.id || null,
    model: modelToUse,
    provider: 'openai',
    raw: response,
  };
}

async function callAnthropic(prompt, model, options = {}) {
  const anthropicKey = getAnthropicKey();
  if (!anthropicKey) {
    throw new Error('Anthropic API key is not configured. Set ANTHROPIC_API_KEY.');
  }
  if (!model) {
    throw new Error('Anthropic model is required.');
  }

  const baseUrl = trimTrailingSlash(getAnthropicBaseUrl() || 'https://api.anthropic.com');

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: options.maxTokens || 4096,
      messages: [
        {
          role: 'user',
          content: buildAnthropicContent(prompt, options.image, options.images),
        },
      ],
    }),
  });

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_error) {
    data = { raw };
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      raw ||
      `Anthropic API error (${response.status})`;
    const err = new Error(`Anthropic API error: ${message}`);
    err.status = response.status;
    throw err;
  }

  const output = Array.isArray(data?.content)
    ? data.content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text || '')
        .join('')
    : '';
  const usage = normalizeAnthropicUsage(data?.usage);

  return {
    output,
    usage,
    providerRequestId: data?.id || null,
    model,
    provider: 'anthropic',
    raw: data,
  };
}

async function callGoogle(prompt, model, options = {}) {
  const geminiKey = getGeminiKey();
  if (!geminiKey) {
    throw new Error('Gemini API key is not configured. Set GEMINI_API_KEY.');
  }
  if (!model) {
    throw new Error('Google Gemini model is required.');
  }

  const baseUrl = trimTrailingSlash(
    getGeminiBaseUrl() || 'https://generativelanguage.googleapis.com/v1beta',
  );

  const body = {
    contents: buildGoogleContent(prompt, options.image, options.images),
  };

  if (options.maxTokens) {
    body.generationConfig = {
      maxOutputTokens: options.maxTokens,
    };
  }

  const response = await fetch(
    `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_error) {
    data = { raw };
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      raw ||
      `Google Gemini API error (${response.status})`;
    const err = new Error(`Google Gemini API error: ${message}`);
    err.status = response.status;
    throw err;
  }

  const output = Array.isArray(data?.candidates?.[0]?.content?.parts)
    ? data.candidates[0].content.parts
        .map((part) => part?.text || '')
        .join('')
    : '';
  const usage = normalizeGoogleUsage(data?.usageMetadata);

  return {
    output,
    usage,
    providerRequestId: data?.responseId || data?.response?.responseId || null,
    model,
    provider: 'google',
    raw: data,
  };
}

/**
 * Main LLM call function.
 *
 * Routes to the selected provider, or infers the provider from the model name.
 *
 * @param {string} prompt
 * @param {{provider?: string, model?: string, image?: {base64: string, mimeType?: string}, images?: Array<{base64: string, mimeType?: string}>, maxTokens?: number}} options
 * @returns {Promise<{output: string, usage: object, providerRequestId: string|null, model: string, provider: string}>}
 */
async function callLLMInternal(prompt, options = {}) {
  const provider = normalizeProvider(options.provider, options.model);
  const model = options.model || (provider === defaultModelParts().provider ? defaultModelParts().model : undefined);

  if (provider === 'anthropic') {
    return await callAnthropic(prompt, model, options);
  }

  if (provider === 'google') {
    return await callGoogle(prompt, model, options);
  }

  return await callOpenAI(prompt, model, options);
}

async function callLLM(prompt, options = {}) {
  try {
    return await callLLMInternal(prompt, options);
  } catch (err) {
    if (err && typeof err === 'object') {
      throw err;
    }
    const wrapped = new Error(`callLLM threw a non-error value: ${String(err)}`);
    wrapped.cause = err;
    throw wrapped;
  }
}

/**
 * Providers that hold a usable API key right now.
 */
function providerHasKey(provider) {
  if (provider === 'openai') return Boolean(getOpenAIKey());
  if (provider === 'anthropic') return Boolean(getAnthropicKey());
  if (provider === 'google') return Boolean(getGeminiKey());
  return false;
}

/**
 * Ordered catalog ids to try when the requested provider is unavailable.
 *
 * Ordered CHEAPEST FIRST on purpose. The caller reserved a max debit priced for
 * the model the user actually asked for, and settleReservation caps the charge at
 * that reservation. Falling back to something MORE expensive would silently move
 * cost onto us, so every entry here costs no more than the models users select.
 *
 * Override with AI_FALLBACK_MODEL_IDS (comma-separated catalog ids).
 */
const DEFAULT_FALLBACK_MODEL_IDS = [
  'openai:gpt-5-6-luna',
  'google:gemini-3-5-flash-lite',
  'google:gemini-3-6-flash',
];

function fallbackModelIds() {
  const raw = process.env.AI_FALLBACK_MODEL_IDS;
  if (!raw) return DEFAULT_FALLBACK_MODEL_IDS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Alternate provider/model pairs worth trying, cheapest first.
 *
 * Skips the pair that just failed, skips unpriced catalog entries (an unpriced
 * model would blow up at settlement time with pricing_failed), and skips
 * providers with no key configured.
 */
function getFallbackCandidates(excludeProvider, excludeModel) {
  const { getModelPricing } = require('./billing/config');
  const out = [];
  for (const catalogId of fallbackModelIds()) {
    let pricing = null;
    try {
      pricing = getModelPricing(catalogId);
    } catch (_err) {
      pricing = null;
    }
    if (!pricing || !pricing.provider || !pricing.model) continue;
    if (pricing.provider === excludeProvider && pricing.model === excludeModel) continue;
    if (!providerHasKey(pricing.provider)) continue;
    out.push({ catalogId, provider: pricing.provider, model: pricing.model });
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

/**
 * Call the LLM, and if the requested provider is unavailable, fall back to
 * another configured provider instead of failing the user's request.
 *
 * Without this a single overloaded or quota-capped model takes down the whole
 * product even when a perfectly good provider is sitting right there. That is
 * exactly what happened when Gemini 3.7 Flash hit its free-tier ceiling: every
 * recipe extraction failed although OpenAI was healthy.
 *
 * Only transient failures (408/429/5xx/transport) trigger a fallback. Auth and
 * invalid-request errors are the caller's problem and propagate immediately.
 *
 * Returns the provider result annotated with fellBackFrom/fellBackTo so the
 * response and the ledger show which model actually served the request.
 */
async function callLLMWithFallback(params, maxAttempts = 3, deps = {}) {
  const retry = deps.callLLMWithRetry || callLLMWithRetry;
  const candidatesFor = deps.getFallbackCandidates || getFallbackCandidates;
  const primaryProvider = params.options?.provider || null;
  const primaryModel = params.options?.model || null;

  try {
    return await retry(params, maxAttempts);
  } catch (primaryErr) {
    if (!isTransientProviderError(primaryErr)) {
      throw primaryErr;
    }

    const candidates = candidatesFor(primaryProvider, primaryModel);
    if (!candidates.length) {
      console.error('AI provider unavailable and no fallback candidate configured', {
        primaryProvider,
        primaryModel,
        status: primaryErr?.status || null,
      });
      throw primaryErr;
    }

    console.warn('Primary AI provider unavailable, trying fallbacks', {
      primaryProvider,
      primaryModel,
      status: primaryErr?.status || null,
      candidates: candidates.map((c) => c.catalogId),
    });

    for (const candidate of candidates) {
      try {
        const result = await retry(
          {
            prompt: params.prompt,
            options: {
              ...params.options,
              provider: candidate.provider,
              model: candidate.model,
            },
          },
          maxAttempts,
        );
        console.warn('AI fallback served the request', {
          fellBackFrom: `${primaryProvider}:${primaryModel}`,
          fellBackTo: candidate.catalogId,
        });
        return {
          ...result,
          fellBackFrom: `${primaryProvider}:${primaryModel}`,
          fellBackTo: candidate.catalogId,
        };
      } catch (fallbackErr) {
        console.error('AI fallback candidate failed', {
          candidate: candidate.catalogId,
          transient: isTransientProviderError(fallbackErr),
          message: fallbackErr?.message || String(fallbackErr),
          status: fallbackErr?.status || null,
        });
        // Keep walking the chain. A dead provider (no credits, 400) must not
        // stop us reaching the next one.
      }
    }

    console.error('All AI fallback candidates failed, surfacing the original error', {
      primaryProvider,
      primaryModel,
    });
    throw primaryErr;
  }
}


module.exports = {
  callLLM,
  callLLMWithRetry,
  callLLMWithFallback,
  isTransientProviderError,
  imageList,
  providerHasKey,
  fallbackModelIds,
  getFallbackCandidates,
  getOpenAIKey,
  getOpenAIBaseUrl,
  getAnthropicKey,
  getAnthropicBaseUrl,
  getGeminiKey,
  getGeminiBaseUrl,
  callOpenAI,
  callAnthropic,
  callGoogle,
  getDefaultModel,
  normalizeProvider,
  normalizeOpenAIUsage,
  normalizeAnthropicUsage,
  normalizeGoogleUsage,
};
