'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { callLLMWithFallback, isTransientProviderError } = require('../llm');

function transientError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * retry stub: fails for the listed provider/model pairs, succeeds otherwise.
 * Records every (provider, model) it was asked for.
 */
function makeRetry(failures) {
  const calls = [];
  return {
    calls,
    fn: async (params) => {
      const key = `${params.options.provider}:${params.options.model}`;
      calls.push(key);
      const err = failures[key];
      if (err) throw err;
      return { output: `ok from ${key}`, provider: params.options.provider, model: params.options.model };
    },
  };
}

const CANDIDATES = [
  { catalogId: 'openai:gpt-5-6-luna', provider: 'openai', model: 'gpt-5.6-luna' },
  { catalogId: 'google:gemini-3-5-flash-lite', provider: 'google', model: 'gemini-3.5-flash-lite' },
];

test('a healthy primary provider never triggers a fallback', async () => {
  const r = makeRetry({});
  const out = await callLLMWithFallback(
    { prompt: 'p', options: { provider: 'google', model: 'gemini-3.7-flash' } },
    3,
    { callLLMWithRetry: r.fn, getFallbackCandidates: () => CANDIDATES },
  );
  assert.strictEqual(out.output, 'ok from google:gemini-3.7-flash');
  assert.strictEqual(out.fellBackTo, undefined);
  assert.deepStrictEqual(r.calls, ['google:gemini-3.7-flash']);
});

test('a transient primary failure falls back to the next provider', async () => {
  const r = makeRetry({ 'google:gemini-3.7-flash': transientError('high demand', 503) });
  const out = await callLLMWithFallback(
    { prompt: 'p', options: { provider: 'google', model: 'gemini-3.7-flash' } },
    3,
    { callLLMWithRetry: r.fn, getFallbackCandidates: () => CANDIDATES },
  );
  assert.strictEqual(out.provider, 'openai');
  assert.strictEqual(out.fellBackFrom, 'google:gemini-3.7-flash');
  assert.strictEqual(out.fellBackTo, 'openai:gpt-5-6-luna');
  assert.deepStrictEqual(r.calls, ['google:gemini-3.7-flash', 'openai:gpt-5.6-luna']);
});

test('a 429 quota cap on the primary also triggers the fallback', async () => {
  const r = makeRetry({
    'google:gemini-3.7-flash': transientError('free tier quota exceeded', 429),
  });
  const out = await callLLMWithFallback(
    { prompt: 'p', options: { provider: 'google', model: 'gemini-3.7-flash' } },
    3,
    { callLLMWithRetry: r.fn, getFallbackCandidates: () => CANDIDATES },
  );
  assert.strictEqual(out.fellBackTo, 'openai:gpt-5-6-luna');
});

test('a non-transient primary error propagates immediately with no fallback', async () => {
  const r = makeRetry({ 'google:gemini-3.7-flash': transientError('bad api key', 401) });
  await assert.rejects(
    () => callLLMWithFallback(
      { prompt: 'p', options: { provider: 'google', model: 'gemini-3.7-flash' } },
      3,
      { callLLMWithRetry: r.fn, getFallbackCandidates: () => CANDIDATES },
    ),
    /bad api key/,
  );
  assert.deepStrictEqual(r.calls, ['google:gemini-3.7-flash'], 'must not try fallbacks for an auth error');
});

test('keeps walking past a dead fallback candidate to reach a live one', async () => {
  const r = makeRetry({
    'google:gemini-3.7-flash': transientError('high demand', 503),
    'openai:gpt-5.6-luna': transientError('insufficient credits', 400),
  });
  const out = await callLLMWithFallback(
    { prompt: 'p', options: { provider: 'google', model: 'gemini-3.7-flash' } },
    3,
    { callLLMWithRetry: r.fn, getFallbackCandidates: () => CANDIDATES },
  );
  assert.strictEqual(out.fellBackTo, 'google:gemini-3-5-flash-lite');
  assert.deepStrictEqual(r.calls, [
    'google:gemini-3.7-flash',
    'openai:gpt-5.6-luna',
    'google:gemini-3.5-flash-lite',
  ]);
});

test('when every candidate fails the ORIGINAL error is surfaced', async () => {
  const r = makeRetry({
    'google:gemini-3.7-flash': transientError('original high demand', 503),
    'openai:gpt-5.6-luna': transientError('dead', 400),
    'google:gemini-3.5-flash-lite': transientError('also dead', 503),
  });
  await assert.rejects(
    () => callLLMWithFallback(
      { prompt: 'p', options: { provider: 'google', model: 'gemini-3.7-flash' } },
      3,
      { callLLMWithRetry: r.fn, getFallbackCandidates: () => CANDIDATES },
    ),
    /original high demand/,
  );
});

test('no configured candidates surfaces the original error rather than silently succeeding', async () => {
  const r = makeRetry({ 'google:gemini-3.7-flash': transientError('high demand', 503) });
  await assert.rejects(
    () => callLLMWithFallback(
      { prompt: 'p', options: { provider: 'google', model: 'gemini-3.7-flash' } },
      3,
      { callLLMWithRetry: r.fn, getFallbackCandidates: () => [] },
    ),
    /high demand/,
  );
  assert.deepStrictEqual(r.calls, ['google:gemini-3.7-flash']);
});

test('fallback preserves the other call options such as maxTokens and image', async () => {
  const seen = [];
  const retry = async (params) => {
    seen.push(params.options);
    if (params.options.model === 'gemini-3.7-flash') throw transientError('high demand', 503);
    return { output: 'ok', provider: params.options.provider, model: params.options.model };
  };
  const image = { base64: 'AAA', mimeType: 'image/png' };
  await callLLMWithFallback(
    { prompt: 'p', options: { provider: 'google', model: 'gemini-3.7-flash', maxTokens: 999, image } },
    3,
    { callLLMWithRetry: retry, getFallbackCandidates: () => CANDIDATES },
  );
  const fallbackOpts = seen[1];
  assert.strictEqual(fallbackOpts.maxTokens, 999);
  assert.deepStrictEqual(fallbackOpts.image, image);
  assert.strictEqual(fallbackOpts.provider, 'openai');
});

test('isTransientProviderError classifies transport, 408, 429 and 5xx as transient', () => {
  assert.strictEqual(isTransientProviderError({}), true, 'no status means transport error');
  assert.strictEqual(isTransientProviderError({ status: 408 }), true);
  assert.strictEqual(isTransientProviderError({ status: 429 }), true);
  assert.strictEqual(isTransientProviderError({ status: 500 }), true);
  assert.strictEqual(isTransientProviderError({ status: 503 }), true);
  assert.strictEqual(isTransientProviderError({ status: 400 }), false);
  assert.strictEqual(isTransientProviderError({ status: 401 }), false);
  assert.strictEqual(isTransientProviderError({ status: 404 }), false);
});
