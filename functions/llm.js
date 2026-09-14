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

function buildOpenAIContent(prompt, image) {
  if (!image) return prompt;
  const mimeType = image.mimeType || 'image/jpeg';
  return [
    { type: 'text', text: prompt },
    {
      type: 'image_url',
      image_url: {
        url: `data:${mimeType};base64,${image.base64}`,
      },
    },
  ];
}

function buildAnthropicContent(prompt, image) {
  if (!image) return prompt;
  return [
    { type: 'text', text: prompt },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType || 'image/jpeg',
        data: image.base64,
      },
    },
  ];
}

function buildGoogleContent(prompt, image) {
  const parts = [{ text: prompt }];
  if (image) {
    parts.push({
      inlineData: {
        mimeType: image.mimeType || 'image/jpeg',
        data: image.base64,
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
        content: buildOpenAIContent(prompt, options.image),
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
          content: buildAnthropicContent(prompt, options.image),
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
    contents: buildGoogleContent(prompt, options.image),
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
 * @param {{provider?: string, model?: string, image?: {base64: string, mimeType?: string}, maxTokens?: number}} options
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

module.exports = {
  callLLM,
  callOpenAI,
  callAnthropic,
  callGoogle,
  getDefaultModel,
  normalizeProvider,
  normalizeOpenAIUsage,
  normalizeAnthropicUsage,
  normalizeGoogleUsage,
};
