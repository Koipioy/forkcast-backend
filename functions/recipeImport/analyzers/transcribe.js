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
async function transcribeAudio(params) {
  const apiKey = params.apiKey || getOpenAIKey();
  if (!apiKey) {
    throw new ProviderUnavailableError(
      'Transcription needs an OpenAI API key and none is configured.',
      {},
    );
  }

  const baseUrl = trimSlash(
    params.baseUrl || getOpenAIBaseUrl() || 'https://api.openai.com/v1',
  );
  const model = params.model || config.TRANSCRIPTION_MODEL;

  let buffer;
  try {
    buffer = await fsp.readFile(params.audioPath);
  } catch (err) {
    throw new TranscriptionFailedError('Could not read the extracted audio.', {
      error: err.message,
    });
  }

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/mpeg' }), 'audio.mp3');
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

module.exports = {
  DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  transcribeAudio,
};
