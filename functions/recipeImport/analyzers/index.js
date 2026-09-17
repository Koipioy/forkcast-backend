'use strict';

/**
 * Analyzer registry.
 *
 * The worker asks for "an analyzer" and gets one. Which provider that turns out
 * to be is decided here, from `VIDEO_ANALYSIS_PROVIDER` and whichever API keys
 * are actually configured, so a deployment can move from Gemini to a
 * frames-based provider by changing one environment variable.
 */

const config = require('../config');
const { getGeminiKey, getOpenAIKey, getAnthropicKey } = require('../../llm');
const { ProviderUnavailableError } = require('../errors');
const { GeminiVideoRecipeAnalyzer } = require('./geminiDirectVideo');
const {
  GeminiYouTubeDirectAnalyzer,
  isDirectYouTubeUrl,
  canonicalizeYouTubeUrl,
} = require('./geminiYouTubeDirect');
const { FramesRecipeAnalyzer } = require('./framesAndTranscript');

/** Providers that accept a whole video file directly. */
const DIRECT_VIDEO_PROVIDERS = new Set(['google']);

function providerHasKey(provider) {
  if (provider === 'google') return Boolean(getGeminiKey());
  if (provider === 'openai') return Boolean(getOpenAIKey());
  if (provider === 'anthropic') return Boolean(getAnthropicKey());
  return false;
}

/**
 * Pick the analyzer for this deployment.
 *
 * `auto` prefers the direct-video path because it costs one call and sees the
 * whole clip; frames are the fallback for providers that cannot take video.
 */
function resolveVideoAnalyzer(options = {}) {
  const requested = (options.provider || config.VIDEO_ANALYSIS_PROVIDER || 'auto')
    .toLowerCase()
    .trim();

  const deps = {
    ...(options.deps || {}),
    callLLM: options.callLLM || require('../../llm').callLLM,
    transcribeFn: options.transcribeFn || require('./transcribe').transcribeAudio,
  };

  if (requested === 'auto') {
    if (providerHasKey('google')) {
      return new GeminiVideoRecipeAnalyzer({
        ...deps,
        model: options.model || config.VIDEO_ANALYSIS_MODEL || 'gemini-3.7-flash',
      });
    }
    const fallbackProvider = providerHasKey('openai')
      ? 'openai'
      : providerHasKey('anthropic')
        ? 'anthropic'
        : null;
    if (!fallbackProvider) {
      throw new ProviderUnavailableError(
        'No AI provider is configured for video analysis.',
        {},
      );
    }
    return new FramesRecipeAnalyzer({ ...deps, provider: fallbackProvider, model: options.model });
  }

  if (!providerHasKey(requested)) {
    throw new ProviderUnavailableError(
      `VIDEO_ANALYSIS_PROVIDER is "${requested}" but that provider has no API key.`,
      { provider: requested },
    );
  }

  if (DIRECT_VIDEO_PROVIDERS.has(requested)) {
    return new GeminiVideoRecipeAnalyzer({
      ...deps,
      model: options.model || config.VIDEO_ANALYSIS_MODEL || 'gemini-3.7-flash',
    });
  }

  return new FramesRecipeAnalyzer({ ...deps, provider: requested, model: options.model });
}

/**
 * Build the analyzer that reads a YouTube URL without downloading it.
 *
 * Returns null rather than throwing when it is not usable. The caller has a
 * perfectly good fallback path and "Gemini is not configured" is a reason to
 * take that path, not a reason to fail the import.
 */
function resolveYouTubeDirectAnalyzer(options = {}) {
  if (!config.GEMINI_DIRECT_YOUTUBE_ENABLED) {
    return null;
  }
  if (!providerHasKey('google')) {
    return null;
  }
  const deps = {
    ...(options.deps || {}),
  };
  return new GeminiYouTubeDirectAnalyzer({
    ...deps,
    model: options.model || config.GEMINI_DIRECT_YOUTUBE_MODEL,
    mediaResolution: options.mediaResolution || config.GEMINI_VIDEO_MEDIA_RESOLUTION,
    processingMode: options.processingMode || config.GEMINI_VIDEO_PROCESSING_MODE,
  });
}

/**
 * Should this URL skip the resolver entirely and go straight to the model?
 *
 * Only when it is a public YouTube watch URL, the feature is on, and a
 * Gemini key exists. Everything else - Instagram, TikTok, Pinterest, a
 * playlist, a local file - keeps using the normal path.
 */
function shouldUseDirectYouTube(url, options = {}) {
  if (options.allowDirectYouTube === false) return false;
  if (!isDirectYouTubeUrl(url)) return false;

  // An explicit allow is how a caller that has already supplied its own
  // analyzer opts in. Without it the decision is pure configuration.
  if (options.allowDirectYouTube === true) return true;

  if (!config.GEMINI_DIRECT_YOUTUBE_ENABLED) return false;
  if (!providerHasKey('google')) return false;
  return true;
}

module.exports = {
  DIRECT_VIDEO_PROVIDERS,
  providerHasKey,
  resolveVideoAnalyzer,
  resolveYouTubeDirectAnalyzer,
  shouldUseDirectYouTube,
  GeminiVideoRecipeAnalyzer,
  GeminiYouTubeDirectAnalyzer,
  FramesRecipeAnalyzer,
  isDirectYouTubeUrl,
  canonicalizeYouTubeUrl,
};
