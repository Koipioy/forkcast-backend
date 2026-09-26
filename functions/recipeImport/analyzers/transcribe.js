'use strict';

/**
 * Speech-to-text for the extracted audio track.
 *
 * Uses the OpenAI Whisper endpoint over plain multipart fetch rather than the
 * SDK, so the transport can be injected in tests and so this does not depend on
 * how a particular SDK release wants a file uploaded.
 */

const fsp = require('fs/promises');

const config = require('../config');
const { getOpenAIKey, getOpenAIBaseUrl } = require('../../llm');
const { TranscriptionFailedError, ProviderUnavailableError } = require('../errors');

const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 120_000;

function trimSlash(value) {
  return String(value).replace(/\/$/, '');
}

/**
 * @param {{audioPath: string, model?: string, timeoutMs?: number,
 *          fetchImpl?: typeof fetch, apiKey?: string, baseUrl?: string}} params
 * @returns {Promise<{text: string, language: string|null, durationSeconds: number|null}>}
 */
/**
 * Transcribe an in-memory audio buffer.
 *
 * This is the shared transport. Both the cloud worker (which reads a file
 * off disk) and the device (which captured a window with
 * `captureStream()` inside the WebView and posts it as base64) come
 * through here, so there is exactly one place that knows how to talk to
 * the transcription endpoint.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{filename?: string, mimeType?: string, model?: string,
 *          timeoutMs?: number, fetchImpl?: typeof fetch,
 *          apiKey?: string, baseUrl?: string}} params
 */
async function transcribeBuffer(buffer, params = {}) {
  const apiKey = params.apiKey || getOpenAIKey();
  if (!apiKey) {
    throw new ProviderUnavailableError(
      'Transcription needs an OpenAI API key and none is configured.',
      {},
    );
  }

  if (!buffer || buffer.length === 0) {
    throw new TranscriptionFailedError('No audio bytes were supplied.', {});
  }

  const baseUrl = trimSlash(
    params.baseUrl || getOpenAIBaseUrl() || 'https://api.openai.com/v1',
  );
  const model = params.model || config.TRANSCRIPTION_MODEL;
  const mimeType = params.mimeType || 'audio/mpeg';
  const filename = params.filename || 'audio.bin';

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimeType }), filename);
  form.append('model', model);
  form.append('response_format', 'json');

  const doFetch = params.fetchImpl || fetch;

  let response;
  try {
    response = await doFetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    throw new TranscriptionFailedError('Transcription request failed.', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (_err) {
    data = { raw };
  }

  if (!response.ok) {
    const err = new TranscriptionFailedError(
      `Transcription API error (${response.status}).`,
      {
        status: response.status,
        message: data?.error?.message || data?.message || raw?.slice(0, 200),
      },
    );
    err.status = response.status;
    throw err;
  }

  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) {
    throw new TranscriptionFailedError('Transcription returned no text.', {});
  }

  return {
    text,
    language: data.language || null,
    durationSeconds: Number.isFinite(data.duration) ? data.duration : null,
    model,
    provider: 'openai',
  };
}

/**
 * Transcribe an audio file from disk. Thin wrapper over transcribeBuffer.
 *
 * @param {{audioPath: string, model?: string, timeoutMs?: number,
 *          fetchImpl?: typeof fetch, apiKey?: string, baseUrl?: string}} params
 * @returns {Promise<{text: string, language: string|null, durationSeconds: number|null}>}
 */
async function transcribeAudio(params) {
  let buffer;
  try {
    buffer = await fsp.readFile(params.audioPath);
  } catch (err) {
    throw new TranscriptionFailedError('Could not read the extracted audio.', {
      error: err.message,
    });
  }
  return transcribeBuffer(buffer, {
    ...params,
    filename: params.filename || 'audio.mp3',
    mimeType: params.mimeType || 'audio/mpeg',
  });
}

/**
 * Transcribe base64 audio captured on the device.
 *
 * The WebView records a window with `captureStream()` and hands it over as
 * a base64 string. The spike's audio leg is exactly this: record a window,
 * send it to `/audio/transcriptions`, land the text in the prompt under
 * its own header. The mime type rides along because the recorder reports
 * what the engine actually chose - typically `audio/webm;codecs=opus` -
 * and guessing `audio/mpeg` for a webm is how a provider returns an
 * empty transcript for a file full of speech.
 *
 * @param {{audioBase64: string, mimeType?: string} & object} params
 */
async function transcribeBase64(params) {
  const raw = String(params.audioBase64 || '');
  if (!raw) {
    throw new TranscriptionFailedError('No audio was supplied.', {});
  }
  // Strip a data-URL header if one rode along. The header ends at the
  // first comma; a pattern that stops at the semicolon leaves ':' ';' and
  // ',' inside the base64 and the provider sees garbage.
  const comma = raw.indexOf(',');
  const body = raw.startsWith('data:') && comma !== -1 ? raw.slice(comma + 1) : raw;

  let buffer;
  try {
    buffer = Buffer.from(body, 'base64');
  } catch (err) {
    throw new TranscriptionFailedError('Audio could not be decoded.', {
      error: err.message,
    });
  }
  if (!buffer || buffer.length === 0) {
    throw new TranscriptionFailedError('Audio decoded to nothing.', {});
  }

  const mimeType = params.mimeType || 'audio/webm';
  const ext = mimeType.includes('webm')
    ? 'webm'
    : mimeType.includes('mp4')
      ? 'm4a'
      : 'bin';

  return transcribeBuffer(buffer, {
    ...params,
    mimeType,
    filename: `window.${ext}`,
  });
}

module.exports = {
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  transcribeBuffer,
  transcribeBase64,
  transcribeAudio,
};
