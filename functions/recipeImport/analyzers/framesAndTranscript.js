'use strict';

/**
 * Frames + transcript analyzer for providers that cannot take a video file.
 *
 * OpenAI's chat models and Claude both want still images, so the video has to be
 * taken apart first: an audio track for Whisper, a capped frame set for the
 * vision model. The transcript and the frames arrive at the model together, in
 * one call, because two separate calls would produce two separate stories about
 * the same video and nothing downstream could tell which to believe.
 */

const fsp = require('fs/promises');

const config = require('../config');
const { EVIDENCE_SOURCES } = require('../evidence');
const { AnalysisFailedError, ProviderUnavailableError } = require('../errors');
const { buildAnalysisPrompt, extractJson, normalizeAnalysisResponse } = require('./prompt');

const MAX_FRAME_BASE64_CHARS = 2_000_000;

async function readFrameAsBase64(frame) {
  const buffer = await fsp.readFile(frame.path);
  return {
    base64: buffer.toString('base64'),
    mimeType: 'image/jpeg',
    timestampSeconds: frame.timestampSeconds,
    bytes: buffer.length,
  };
}

/**
 * Lay the transcript out with timestamps so the model can line a spoken line
 * up with the frame that shows it.
 *
 * Without a real timestamped transcript (Whisper's plain text has none) the
 * whole track is passed as one block and the model is told so, rather than
 * being handed invented timestamps.
 */
function formatTranscriptBlock(transcript) {
  if (!transcript) return '';
  if (Array.isArray(transcript.segments) && transcript.segments.length > 0) {
    return transcript.segments
      .map((segment) => `[${Math.round(segment.start || 0)}s] ${segment.text}`)
      .join('\n');
  }
  return transcript.text || '';
}

class FramesRecipeAnalyzer {
  constructor(deps = {}) {
    this.id = 'frames+transcript';
    this.deps = deps;
    this.logger = deps.logger || null;
    this.meteredAICall = deps.meteredAICall;
    this.transcribeFn = deps.transcribeFn;
    this.provider = deps.provider || 'openai';
    this.model = deps.model || config.VIDEO_ANALYSIS_MODEL || null;
  }

  async analyze(input) {
    if (!this.meteredAICall) {
      throw new ProviderUnavailableError(
        'The frames analyzer needs a metered AI call to be injected.',
        {},
      );
    }

    const frames = Array.isArray(input.frames) ? input.frames : [];
    if (frames.length === 0) {
      throw new AnalysisFailedError('No frames were supplied to the analyzer.', {});
    }

    // Transcript first: a frame set without the audio loses every quantity that
    // was spoken but never written down, so a failed transcription is worth
    // saying loudly rather than hiding.
    let transcript = null;
    let transcriptError = null;
    if (input.audioPath && this.transcribeFn) {
      try {
        transcript = await this.transcribeFn({ audioPath: input.audioPath });
      } catch (err) {
        transcriptError = err;
        this.logger?.warn?.('transcription_failed', {
          jobId: this.deps.jobId,
          code: err?.code,
          message: err?.message,
        });
      }
    }

    const transcriptText = formatTranscriptBlock(transcript);
    if (!transcriptText && frames.length === 0) {
      throw new AnalysisFailedError(
        'Neither a transcript nor frames could be obtained for analysis.',
        { transcriptionError: transcriptError?.message },
      );
    }

    const images = [];
    for (const frame of frames) {
      const encoded = await readFrameAsBase64(frame);
      if (encoded.base64.length > MAX_FRAME_BASE64_CHARS) {
        // One oversized frame should not sink the whole analysis; skip it and
        // say so in the log rather than silently shrinking the evidence set.
        this.logger?.warn?.('frame_skipped_too_large', {
          jobId: this.deps.jobId,
          timestampSeconds: frame.timestampSeconds,
          base64Chars: encoded.base64.length,
        });
        continue;
      }
      images.push(encoded);
    }

    if (images.length === 0) {
      throw new AnalysisFailedError('Every frame was too large to send.', {});
    }

    const prompt = buildAnalysisPrompt({
      mode: 'frames',
      frameCount: images.length,
      mediaMetadata: input.mediaMetadata,
      contextText: this.withTranscriptContext(input.contextText, transcriptText),
    });

    const result = await this.meteredAICall({
      uid: this.deps.uid,
      email: this.deps.email,
      feature: 'recipe_video_analysis',
      provider: this.provider,
      model: this.model,
      hasImage: true,
      runFn: () =>
        this.deps.callLLM(prompt, {
          provider: this.provider,
          model: this.model,
          maxTokens: 4000,
          images,
        }),
      metadata: { analyzer: this.id, mode: 'frames', frameCount: images.length },
    });

    const parsed = extractJson(result.output);
    if (!parsed) {
      throw new AnalysisFailedError('The frames model did not return parseable JSON.', {});
    }

    const evidence = normalizeAnalysisResponse(parsed, {
      fallbackSource: EVIDENCE_SOURCES.VISUAL_OBSERVATION,
    });

    // The transcript is explicit evidence in its own right. Fold it in even if
    // the model failed to attribute it, so a dropped line is recoverable.
    if (transcriptText) {
      evidence.transcriptText = transcriptText;
    }

    return {
      evidence,
      transcriptText: transcriptText || null,
      frameCount: images.length,
      provider: this.provider,
      model: this.model,
      analyzer: this.id,
      billing: result.billing || null,
      transcriptionFailed: Boolean(transcriptError),
      raw: parsed,
    };
  }

  withTranscriptContext(contextText, transcriptText) {
    const parts = [];
    if (contextText) parts.push(contextText);
    if (transcriptText) {
      parts.push(`AUDIO TRANSCRIPT:\n${transcriptText}`);
    } else {
      parts.push(
        'AUDIO TRANSCRIPT: unavailable. Rely on the frames and on-screen text only.',
      );
    }
    return parts.join('\n\n');
  }
}

module.exports = {
  FramesRecipeAnalyzer,
  MAX_FRAME_BASE64_CHARS,
  formatTranscriptBlock,
};
