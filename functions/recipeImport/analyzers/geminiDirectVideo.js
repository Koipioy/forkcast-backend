'use strict';

/**
 * Gemini whole-video analyzer.
 *
 * Gemini is the one configured provider that can take a video file and hear it,
 * so when it is available it is the cheapest path to good evidence: one upload,
 * one call, no ffmpeg, and no frame-sampling guesswork about what happened
 * between two stills.
 *
 * The video goes through the Files API rather than inline base64. Inline is
 * capped at 20MB per request, which most real cooking videos blow straight
 * past, and base64 inflates the bytes by a third on top of that.
 */

const fsp = require('fs/promises');
const path = require('path');

const config = require('../config');
const { getGeminiKey, getGeminiBaseUrl } = require('../../llm');
const { AnalysisFailedError, ProviderUnavailableError } = require('../errors');
const {
  buildAnalysisPrompt,
  extractJson,
  normalizeAnalysisResponse,
} = require('./prompt');
const { EVIDENCE_SOURCES } = require('../evidence');

const UPLOAD_TIMEOUT_MS = 180_000;
const GENERATE_TIMEOUT_MS = 300_000;
const FILE_POLL_INTERVAL_MS = 2_000;
const FILE_POLL_TIMEOUT_MS = 120_000;

function trimSlash(value) {
  return String(value).replace(/\/$/, '');
}

class GeminiVideoRecipeAnalyzer {
  constructor(deps = {}) {
    this.id = 'gemini-direct-video';
    this.deps = deps;
    this.logger = deps.logger || null;
    this.fetchImpl = deps.fetchImpl || fetch;
    this.meteredAICall = deps.meteredAICall;
    this.apiKey = deps.apiKey || getGeminiKey();
    this.baseUrl = trimSlash(
      deps.baseUrl || getGeminiBaseUrl() || 'https://generativelanguage.googleapis.com/v1beta',
    );
    this.model = deps.model || config.VIDEO_ANALYSIS_MODEL || 'gemini-3.7-flash';
  }

  static isAvailable() {
    return Boolean(getGeminiKey());
  }

  get provider() {
    return 'google';
  }

  /**
   * Upload the file and return its hosted URI.
   *
   * Gemini processes uploaded files asynchronously; a file in PROCESSING state
   * is not readable by generateContent yet, so we wait for ACTIVE.
   */
  async uploadVideo(videoPath, options = {}) {
    const buffer = await fsp.readFile(videoPath);
    const mimeType = options.mimeType || 'video/mp4';
    const uploadStart = `${this.baseUrl}/files?key=${encodeURIComponent(this.apiKey)}`;

    const startResponse = await this.fetchImpl(uploadStart, {
      method: 'POST',
      headers: {
        'x-goog-upload-protocol': 'resumable',
        'x-goog-upload-command': 'start',
        'x-goog-upload-header-content-type': mimeType,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        file: {
          display_name: path.basename(videoPath),
          bytes: buffer.length,
          mime_type: mimeType,
        },
      }),
      signal: AbortSignal.timeout ? AbortSignal.timeout(UPLOAD_TIMEOUT_MS) : undefined,
    });

    if (!startResponse.ok) {
      const body = await startResponse.text().catch(() => '');
      throw new AnalysisFailedError('Gemini upload session could not be started.', {
        status: startResponse.status,
        message: body.slice(0, 200),
      });
    }

    const uploadUrl =
      startResponse.headers.get('x-goog-upload-url') ||
      startResponse.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) {
      throw new AnalysisFailedError('Gemini did not return an upload URL.', {});
    }

    const uploadResponse = await this.fetchImpl(uploadUrl, {
      method: 'POST',
      headers: {
        'x-goog-upload-command': 'upload, finalize',
        'x-goog-upload-offset': '0',
        'Content-Type': mimeType,
      },
      body: buffer,
      signal: AbortSignal.timeout ? AbortSignal.timeout(UPLOAD_TIMEOUT_MS) : undefined,
    });

    if (!uploadResponse.ok) {
      const body = await uploadResponse.text().catch(() => '');
      throw new AnalysisFailedError('Gemini video upload failed.', {
        status: uploadResponse.status,
        message: body.slice(0, 200),
      });
    }

    const payload = await uploadResponse.json().catch(() => ({}));
    const file = payload.file || payload;
    if (!file || !file.uri) {
      throw new AnalysisFailedError('Gemini upload returned no file URI.', {});
    }

    if (file.state === 'PROCESSING') {
      await this.waitForActive(file.uri);
    }

    return { uri: file.uri, name: file.name || null, mimeType };
  }

  async waitForActive(fileUri) {
    const deadline = Date.now() + FILE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const response = await this.fetchImpl(`${fileUri}?key=${encodeURIComponent(this.apiKey)}`);
      if (!response.ok) {
        throw new AnalysisFailedError('Could not poll the uploaded file.', {
          status: response.status,
        });
      }
      const payload = await response.json().catch(() => ({}));
      const state = (payload.file || payload).state;
      if (state === 'ACTIVE') return;
      if (state === 'FAILED') {
        throw new AnalysisFailedError('Gemini could not process the uploaded video.', {});
      }
      await new Promise((resolve) => setTimeout(resolve, FILE_POLL_INTERVAL_MS));
    }
    throw new AnalysisFailedError('Timed out waiting for the video to finish processing.', {});
  }

  /**
   * @param {{videoPath: string, mimeType?: string, mediaMetadata?: object,
   *          contextText?: string}} input
   */
  async analyze(input) {
    if (!this.apiKey) {
      throw new ProviderUnavailableError('Gemini API key is not configured.', {});
    }
    if (!this.meteredAICall) {
      throw new ProviderUnavailableError(
        'The Gemini analyzer needs a metered AI call to be injected.',
        {},
      );
    }

    const uploaded = await this.uploadVideo(input.videoPath, {
      mimeType: input.mimeType,
    });

    const prompt = buildAnalysisPrompt({
      mode: 'video',
      mediaMetadata: input.mediaMetadata,
      contextText: input.contextText,
    });

    const contents = [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            file_data: {
              mime_type: uploaded.mimeType,
              file_uri: uploaded.uri,
            },
          },
        ],
      },
    ];

    // The video travels as a file part, not as an image, so the provider call
    // is injected rather than routed through the text/image LLM proxy.
    const result = await this.meteredAICall({
      uid: this.deps.uid,
      email: this.deps.email,
      feature: 'recipe_video_analysis',
      provider: 'google',
      model: this.model,
      runFn: () => this.generateWithVideo(contents),
      metadata: { analyzer: this.id, mode: 'video' },
    });

    const parsed = extractJson(result.output);
    if (!parsed) {
      throw new AnalysisFailedError('Gemini did not return parseable JSON.', {});
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
      billing: result.billing || null,
      raw: parsed,
    };
  }

  async generateWithVideo(contents) {
    const response = await this.fetchImpl(
      `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            maxOutputTokens: 4000,
            temperature: 0.1,
          },
        }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(GENERATE_TIMEOUT_MS) : undefined,
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
        `Gemini video analysis error (${response.status}).`,
        { message: data?.error?.message || raw?.slice(0, 200) },
      );
      err.status = response.status;
      throw err;
    }

    const parts = data?.candidates?.[0]?.content?.parts || [];
    const output = parts.map((part) => part?.text || '').join('');
    const usageMeta = data?.usageMetadata || {};

    return {
      output,
      provider: 'google',
      model: this.model,
      providerRequestId: data?.responseId || null,
      usage: {
        inputTokens: Number(usageMeta.promptTokenCount || 0),
        outputTokens: Number(usageMeta.candidatesTokenCount || 0),
        cachedInputTokens: Number(usageMeta.cachedContentTokenCount || 0),
        reasoningTokens: Number(usageMeta.thoughtsTokenCount || 0),
        totalTokens: Number(usageMeta.totalTokenCount || 0),
      },
    };
  }
}

module.exports = {
  GeminiVideoRecipeAnalyzer,
  UPLOAD_TIMEOUT_MS,
  GENERATE_TIMEOUT_MS,
};
