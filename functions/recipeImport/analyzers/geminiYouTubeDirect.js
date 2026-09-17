'use strict';

/**
 * Gemini reads a public YouTube URL directly.
 *
 * This is the cheapest path to video evidence that exists, and it exists only
 * for YouTube. The current Gemini API lists "YouTube URLs" as a first-class
 * video input method: pass the watch URL and the model fetches, decodes and
 * hears the video on Google's side. We never touch the bytes.
 *
 * Compared to the yt-dlp path this skips:
 *   - downloading the video onto our disk and our egress bill
 *   - ffmpeg frame extraction and audio extraction
 *   - a separate Whisper transcription call
 *   - the whole class of "yt-dlp's YouTube extractor broke today" failures
 *
 * What it costs instead: input tokens. Per the current docs, static mode
 * tokenises video at 66 tokens/frame at low media resolution or 258 at high,
 * plus 32 tokens per second of audio - roughly 100 tokens/second at low and
 * 300 at high. At the default `gemini-3.5-flash-lite` pricing of $0.30 per
 * million input tokens, a 3-minute video at high resolution is about
 * 54,000 tokens, or ~1.6 cents.
 *
 * Constraints that shape the routing, all from the docs:
 *   - PUBLIC videos only. Private and unlisted links will not work.
 *   - Free tier caps YouTube ingestion at 8 hours of video per day.
 *   - The direct path is YouTube-specific; Instagram, TikTok and Pinterest
 *     still need a resolver.
 */

const config = require('../config');
const { getGeminiKey } = require('../../llm');
const { AnalysisFailedError, ProviderUnavailableError } = require('../errors');
const { EVIDENCE_SOURCES } = require('../evidence');
const {
  buildAnalysisPrompt,
  extractJson,
  normalizeAnalysisResponse,
} = require('./prompt');

const GENERATE_TIMEOUT_MS = 300_000;

/** YouTube URL shapes that point at a single public watchable video. */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

/**
 * Is this a URL Gemini can be handed directly?
 *
 * Deliberately narrow. A playlist URL, a channel URL, a search URL or a
 * `/embed/` of a private video all fail in ways that look like a broken
 * integration rather than a bad link, so anything we cannot confidently call
 * a single watch URL is refused here and falls through to the normal path.
 */
function isDirectYouTubeUrl(url) {
  if (!url || typeof url !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch (_err) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return false;

  // youtu.be/<id>
  if (host.endsWith('youtu.be')) {
    const id = parsed.pathname.replace(/^\//, '').split('/')[0];
    return /^[A-Za-z0-9_-]{6,20}$/.test(id);
  }

  const path = parsed.pathname;
  if (path === '/watch') {
    const videoId = parsed.searchParams.get('v');
    return Boolean(videoId && /^[A-Za-z0-9_-]{6,20}$/.test(videoId));
  }
  if (/^\/shorts\/[A-Za-z0-9_-]{6,20}/.test(path)) return true;
  if (/^\/embed\/[A-Za-z0-9_-]{6,20}/.test(path)) return true;
  if (/^\/live\/[A-Za-z0-9_-]{6,20}/.test(path)) return true;

  // /playlist, /channel, /@user, /results - not a single video.
  return false;
}

/**
 * Normalise any YouTube URL to its canonical watch form.
 *
 * Used as the cache key so `youtu.be/x`, `youtube.com/watch?v=x` and
 * `m.youtube.com/watch?v=x&t=30s` are recognised as the same video rather
 * than three separate imports.
 */
function canonicalizeYouTubeUrl(url) {
  if (!isDirectYouTubeUrl(url)) return null;
  let parsed;
  try {
    parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch (_err) {
    return null;
  }

  let videoId = null;
  if (parsed.hostname.toLowerCase().endsWith('youtu.be')) {
    videoId = parsed.pathname.replace(/^\//, '').split('/')[0];
  } else {
    const match = parsed.pathname.match(/^\/(shorts|embed|live)\/([A-Za-z0-9_-]{6,20})/) || [];
    videoId = match[2] || parsed.searchParams.get('v');
  }
  if (!videoId) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * Read the interaction response, whatever shape it arrives in.
 *
 * The Interactions API returns `output_text` for the common case, but the
 * payload also carries a `steps` array (thought, processing_call,
 * processing_result, model_output) and older shapes used `candidates`.
 * Trying the known shapes in order keeps this from breaking on a response
 * refactor that changes one field name.
 */
function extractResponseText(data) {
  if (!data || typeof data !== 'object') return '';

  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }

  if (Array.isArray(data.output)) {
    const joined = data.output
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .filter(Boolean)
      .join('\n');
    if (joined.trim()) return joined;
  }

  if (Array.isArray(data.steps)) {
    for (let i = data.steps.length - 1; i >= 0; i -= 1) {
      const step = data.steps[i];
      const text =
        typeof step?.content === 'string'
          ? step.content
          : Array.isArray(step?.content)
            ? step.content.map((c) => c?.text || '').join('')
            : '';
      if (text && text.trim()) return text;
    }
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map((part) => part?.text || '').join('');
}

function extractUsage(data) {
  const usage = data?.usageMetadata || data?.usage || {};
  return {
    inputTokens: Number(usage.promptTokenCount || usage.inputTokens || 0),
    outputTokens: Number(usage.candidatesTokenCount || usage.outputTokens || 0),
    cachedInputTokens: Number(usage.cachedContentTokenCount || 0),
    reasoningTokens: Number(usage.thoughtsTokenCount || usage.reasoningTokens || 0),
    totalTokens: Number(usage.totalTokenCount || usage.totalTokens || 0),
  };
}

class GeminiYouTubeDirectAnalyzer {
  constructor(deps = {}) {
    this.id = 'gemini-youtube-direct';
    this.deps = deps;
    this.logger = deps.logger || null;
    this.fetchImpl = deps.fetchImpl || fetch;
    this.meteredAICall = deps.meteredAICall;
    this.apiKey = deps.apiKey || getGeminiKey();
    this.baseUrl = String(
      deps.baseUrl ||
        getGeminiBaseUrlSafe() ||
        'https://generativelanguage.googleapis.com/v1beta',
    ).replace(/\/$/, '');
    this.model =
      deps.model || config.GEMINI_DIRECT_YOUTUBE_MODEL || 'gemini-3.5-flash-lite';
    this.mediaResolution =
      deps.mediaResolution || config.GEMINI_VIDEO_MEDIA_RESOLUTION || 'high';
    this.processingMode =
      deps.processingMode || config.GEMINI_VIDEO_PROCESSING_MODE || 'auto';
  }

  get provider() {
    return 'google';
  }

  static isAvailable() {
    return Boolean(getGeminiKey()) && config.GEMINI_DIRECT_YOUTUBE_ENABLED;
  }

  /**
   * @param {{url: string, mediaMetadata?: object, contextText?: string,
   *          durationSeconds?: number|null}} input
   */
  async analyze(input) {
    if (!this.apiKey) {
      throw new ProviderUnavailableError('Gemini API key is not configured.', {});
    }
    if (!this.meteredAICall) {
      throw new ProviderUnavailableError(
        'The Gemini direct-URL analyzer needs a metered AI call to be injected.',
        {},
      );
    }
    if (!isDirectYouTubeUrl(input.url)) {
      throw new ProviderUnavailableError(
        'Direct URL analysis only supports public YouTube watch URLs.',
        { url: input.url },
      );
    }

    const duration =
      input.durationSeconds ?? input.mediaMetadata?.durationSeconds ?? null;
    const processing = resolveProcessingMode(duration, this.processingMode);

    const prompt = buildAnalysisPrompt({
      mode: 'video',
      mediaMetadata: input.mediaMetadata,
      contextText: input.contextText,
    });

    const videoPart = {
      type: 'video',
      uri: canonicalizeYouTubeUrl(input.url) || input.url,
    };
    if (this.mediaResolution) videoPart.resolution = this.mediaResolution;
    if (processing.mode) videoPart.processing = processing.mode;

    const body = {
      model: this.model,
      // Stateless: we never follow up on this interaction, so there is no
      // reason to leave the request and its video reference stored server-side.
      store: false,
      input: [
        { type: 'text', text: prompt },
        videoPart,
      ],
    };

    const result = await this.meteredAICall({
      uid: this.deps.uid,
      email: this.deps.email,
      feature: 'recipe_video_analysis',
      provider: 'google',
      model: this.model,
      runFn: () => this.generate(body),
      metadata: {
        analyzer: this.id,
        mode: 'direct_url',
        processingMode: processing.mode,
        mediaResolution: this.mediaResolution,
      },
    });

    const parsed = extractJson(result.output);
    if (!parsed) {
      throw new AnalysisFailedError(
        'Gemini direct URL analysis returned no parseable JSON.',
        {},
      );
    }

    const evidence = normalizeAnalysisResponse(parsed, {
      fallbackSource: EVIDENCE_SOURCES.VISUAL_OBSERVATION,
    });

    return {
      evidence,
      transcriptText: null,
      frameCount: 0,
      provider: 'google',
      model: this.model,
      analyzer: this.id,
      processingMode: processing.mode,
      mediaResolution: this.mediaResolution,
      billing: result.billing || null,
      usage: result.usage || null,
      raw: parsed,
    };
  }

  async generate(body) {
    const response = await this.fetchImpl(
      `${this.baseUrl}/interactions?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout
          ? AbortSignal.timeout(GENERATE_TIMEOUT_MS)
          : undefined,
      },
    );

    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_err) {
      data = { raw };
    }

    if (!response.ok) {
      const err = new AnalysisFailedError(
        `Gemini direct URL analysis error (${response.status}).`,
        { message: data?.error?.message || String(raw).slice(0, 200) },
      );
      err.status = response.status;
      const retryAfter = response.headers?.get?.('retry-after');
      if (retryAfter && Number.isFinite(Number(retryAfter))) {
        err.retryAfterSeconds = Number(retryAfter);
      }
      throw err;
    }

    return {
      output: extractResponseText(data),
      provider: 'google',
      model: this.model,
      providerRequestId: data?.id || data?.responseId || null,
      usage: extractUsage(data),
    };
  }
}

/**
 * static for short clips, agentic for long ones.
 *
 * The docs are explicit that agentic is a win on long-form content (up to 88%
 * fewer tokens) and a small loss on short clips, where the whole thing fits in
 * one pass anyway. `auto` draws that line at a configurable duration.
 */
function resolveProcessingMode(durationSeconds, requested) {
  const mode = String(requested || 'auto').toLowerCase().trim();
  if (mode === 'static' || mode === 'agentic') {
    return { mode, reason: 'configured' };
  }
  const plan = config.planVideoProcessingMode(durationSeconds, { mode: 'auto' });
  return plan;
}

function getGeminiBaseUrlSafe() {
  try {
    // eslint-disable-next-line global-require
    return require('../../llm').getGeminiBaseUrl();
  } catch (_err) {
    return null;
  }
}

module.exports = {
  GeminiYouTubeDirectAnalyzer,
  isDirectYouTubeUrl,
  canonicalizeYouTubeUrl,
  extractResponseText,
  extractUsage,
  resolveProcessingMode,
  GENERATE_TIMEOUT_MS,
};
