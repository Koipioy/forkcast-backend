/**
 * LLM Proxy utilities
 * Handles communication with LLM providers (OpenAI, Anthropic, Google).
 */

const OpenAI = require('openai');
const functions = require('firebase-functions');

const PROVIDERS = ['openai', 'anthropic', 'google'];

function envOrConfig(envKeys, configPath) {
  for (const key of envKeys) {
    const value = process.env[key];
    if (value) return value;
  }

  try {
    const configValue = configPath
      .split('.')
      .reduce((acc, part) => (acc == null ? undefined : acc[part]), functions.config());
    if (configValue) return configValue;
  } catch (_error) {
    // functions.config() may be unavailable in local tests.
  }

  return undefined;
}

const OPENAI_KEY = envOrConfig(['OPENAI_API_KEY', 'OPENAI_KEY'], 'openai.key');
const OPENAI_BASE_URL = envOrConfig(['OPENAI_BASE_URL', 'OPENAI_API_URL'], 'openai.base_url');
const ANTHROPIC_KEY = envOrConfig(['ANTHROPIC_API_KEY'], 'anthropic.key');
const ANTHROPIC_BASE_URL = envOrConfig(['ANTHROPIC_BASE_URL'], 'anthropic.base_url');
const GEMINI_KEY = envOrConfig(['GEMINI_API_KEY'], 'gemini.key');
const GEMINI_BASE_URL = envOrConfig(['GEMINI_BASE_URL'], 'gemini.base_url');

if (!OPENAI_KEY) {
  console.warn('Warning: OPENAI_API_KEY/OPENAI_KEY not set. OpenAI LLM calls will fail.');
}
if (!ANTHROPIC_KEY) {
  console.warn('Warning: ANTHROPIC_API_KEY not set. Anthropic LLM calls will fail.');
}
if (!GEMINI_KEY) {
  console.warn('Warning: GEMINI_API_KEY not set. Google Gemini LLM calls will fail.');
}

let openaiClient = null;
if (OPENAI_KEY) {
  openaiClient = new OpenAI({
    apiKey: OPENAI_KEY,
    ...(OPENAI_BASE_URL ? { baseURL: OPENAI_BASE_URL } : {}),
  });
}

function getDefaultModel() {
  return 'gpt-4o-mini';
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
  return 'openai';
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/$/, '');
}

async function callOpenAI(prompt, model = null) {
  if (!openaiClient) {
    throw new Error('OpenAI client not initialized. Check OPENAI_API_KEY configuration.');
  }

  const modelToUse = model || getDefaultModel();

  try {
    const response = await openaiClient.chat.completions.create({
      model: modelToUse,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.7,
    });

    const output = response.choices?.[0]?.message?.content || '';
    const tokensUsed = response.usage?.total_tokens || 0;

    return {
      output,
      tokensUsed,
      model: modelToUse,
      provider: 'openai',
    };
  } catch (error) {
    throw new Error(`OpenAI API error: ${error.message}`);
  }
}

async function callAnthropic(prompt, model) {
  if (!ANTHROPIC_KEY) {
    throw new Error('Anthropic API key is not configured. Set ANTHROPIC_API_KEY.');
  }
  if (!model) {
    throw new Error('Anthropic model is required.');
  }

  const baseUrl = trimTrailingSlash(ANTHROPIC_BASE_URL || 'https://api.anthropic.com');

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: prompt,
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
    throw new Error(`Anthropic API error: ${message}`);
  }

  const output = Array.isArray(data?.content)
    ? data.content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text || '')
        .join('')
    : '';
  const tokensUsed =
    (data?.usage?.input_tokens || 0) + (data?.usage?.output_tokens || 0);

  return {
    output,
    tokensUsed,
    model,
    provider: 'anthropic',
  };
}

async function callGoogle(prompt, model) {
  if (!GEMINI_KEY) {
    throw new Error('Gemini API key is not configured. Set GEMINI_API_KEY.');
  }
  if (!model) {
    throw new Error('Google Gemini model is required.');
  }

  const baseUrl = trimTrailingSlash(
    GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
  );

  const response = await fetch(
    `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
      }),
    }
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
    throw new Error(`Google Gemini API error: ${message}`);
  }

  const output = Array.isArray(data?.candidates?.[0]?.content?.parts)
    ? data.candidates[0].content.parts
        .map((part) => part?.text || '')
        .join('')
    : '';
  const tokensUsed = data?.usageMetadata?.totalTokenCount || 0;

  return {
    output,
    tokensUsed,
    model,
    provider: 'google',
  };
}

/**
 * Main LLM call function.
 * Routes to the selected provider, or infers the provider from the model name.
 *
 * @param {string} prompt
 * @param {{provider?: string, model?: string}} options
 * @returns {Promise<{output: string, tokensUsed: number, model: string, provider: string}>}
 */
async function callLLM(prompt, options = {}) {
  const provider = normalizeProvider(options.provider, options.model);
  const model = options.model || (provider === 'openai' ? getDefaultModel() : undefined);

  if (provider === 'anthropic') {
    return await callAnthropic(prompt, model);
  }

  if (provider === 'google') {
    return await callGoogle(prompt, model);
  }

  return await callOpenAI(prompt, model);
}

module.exports = {
  callLLM,
  callOpenAI,
  callAnthropic,
  callGoogle,
  getDefaultModel,
  normalizeProvider,
};
