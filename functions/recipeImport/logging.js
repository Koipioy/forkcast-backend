'use strict';

/**
 * Structured stage logging for recipe imports.
 *
 * Every stage of the pipeline emits one event name from STAGES so that a log
 * query can reconstruct a job without reading user content. Field values are
 * scrubbed: API keys, Authorization headers, base64 blobs and long free text
 * never reach stdout.
 *
 * The sink is injectable so tests can assert on events without monkey-patching
 * the console.
 */

const STAGES = {
  STARTED: 'recipe_import_started',
  URL_REJECTED: 'recipe_import_url_rejected',
  WEB_EXTRACTION_COMPLETED: 'web_extraction_completed',
  MEDIA_METADATA_RESOLVED: 'media_metadata_resolved',
  MEDIA_METADATA_FAILED: 'media_metadata_failed',
  /**
   * Media work was REQUIRED and could not run because the tooling is switched
   * off or missing. This is deliberately a different event from
   * `media_metadata_failed`: that one is a platform being difficult and is
   * normal, this one is a deployment being wrong and should page somebody.
   * Emitted at error level, and only when media was actually needed, so
   * text-only imports never produce it.
   */
  MEDIA_TOOLING_DISABLED: 'media_tooling_disabled',
  MEDIA_RETRY_SCHEDULED: 'media_retry_scheduled',
  MEDIA_RATE_LIMITED: 'media_rate_limited',
  MEDIA_CACHE_HIT: 'media_cache_hit',
  MEDIA_CACHE_STORED: 'media_cache_stored',
  MEDIA_CACHE_DEDUPE_WAIT: 'media_cache_dedupe_wait',
  /** A local video file was supplied, so no resolver ran at all. */
  LOCAL_VIDEO_SUPPLIED: 'local_video_supplied',
  /** Gemini is reading the YouTube URL directly: no download, no ffmpeg. */
  VIDEO_DIRECT_URL_STARTED: 'video_direct_url_started',
  VIDEO_DIRECT_URL_UNSUPPORTED: 'video_direct_url_unsupported',
  VIDEO_DIRECT_URL_FAILED: 'video_direct_url_failed',
  TEXT_RECIPE_SUFFICIENT: 'text_recipe_sufficient',
  TEXT_RECIPE_INSUFFICIENT: 'text_recipe_insufficient',
  VIDEO_DOWNLOAD_STARTED: 'video_download_started',
  VIDEO_DOWNLOAD_COMPLETED: 'video_download_completed',
  VIDEO_REJECTED: 'video_rejected',
  VIDEO_PREPROCESSING_COMPLETED: 'video_preprocessing_completed',
  TRANSCRIPTION_COMPLETED: 'transcription_completed',
  VIDEO_ANALYSIS_STARTED: 'video_analysis_started',
  VIDEO_ANALYSIS_COMPLETED: 'video_analysis_completed',
  EVIDENCE_MERGED: 'evidence_merged',
  /**
   * Sufficiency instrumentation. These four are the feedback loop for the
   * heuristic: how often the text was enough, how often we escalated, and
   * whether escalating actually bought anything. Without them there is no way
   * to tell whether the gate is set in the right place.
   */
  TEXT_ONLY_SUCCESS: 'text_only_success',
  VIDEO_ESCALATED: 'video_escalated',
  VIDEO_ADDED_USEFUL_INFORMATION: 'video_added_useful_information',
  VIDEO_CHANGED_RECIPE_MATERIALLY: 'video_changed_recipe_materially',
  COMPLETED: 'recipe_import_completed',
  FAILED: 'recipe_import_failed',
  CLEANUP: 'recipe_import_cleanup',
};

const REDACTED = '[redacted]';

/** Keys whose values must never be logged, matched case-insensitively. */
const SENSITIVE_KEY_RE =
  /(api[-_]?key|authorization|auth|token|secret|password|cookie|set-cookie|signature)/i;

/** Keys whose values are long free text: length only, never content. */
const BULK_TEXT_KEYS = new Set([
  'text',
  'html',
  'content',
  'transcript',
  'description',
  'caption',
  'prompt',
  'response',
  'body',
  'base64',
  'imagebase64',
  'frames',
]);

function scrubValue(key, value, depth = 0) {
  if (value === null || value === undefined) return value;

  if (SENSITIVE_KEY_RE.test(String(key))) {
    return REDACTED;
  }

  if (typeof value === 'bigint') return Number(value);

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (typeof value === 'string') {
    const lowerKey = String(key).toLowerCase();
    if (BULK_TEXT_KEYS.has(lowerKey)) {
      return `[${value.length} chars]`;
    }
    // A base64 blob can arrive under any key name; catch it by shape.
    if (value.length > 512 && /^[A-Za-z0-9+/\r\n]+={0,2}$/.test(value.slice(0, 256))) {
      return `[${value.length} chars base64-like]`;
    }
    return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  }

  if (Array.isArray(value)) {
    if (depth >= 3) return `[${value.length} items]`;
    return value.map((item) => scrubValue(key, item, depth + 1));
  }

  if (typeof value === 'object') {
    if (depth >= 3) return '[object]';
    return scrubFields(value, depth + 1);
  }

  return String(value);
}

function scrubFields(fields, depth = 0) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = scrubValue(key, value, depth);
  }
  return out;
}

/**
 * Strip query/fragment from a URL for logging.
 *
 * Social URLs carry signed tokens in the query string. The host and path are
 * what identifies the platform, so that is all we keep.
 */
function redactUrlForLog(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname && parsed.pathname.length > 120
      ? `${parsed.pathname.slice(0, 120)}…`
      : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch (_err) {
    return url.length > 160 ? `${url.slice(0, 160)}…` : url;
  }
}

function createLogger(sink) {
  const emit =
    typeof sink === 'function'
      ? sink
      : (level, payload) => {
          const line = JSON.stringify(payload);
          if (level === 'error') console.error(line);
          else console.log(line);
        };

  function logStage(level, event, fields = {}) {
    const payload = {
      event,
      level,
      ts: new Date().toISOString(),
      ...scrubFields(fields),
    };
    if (fields.url) payload.url = redactUrlForLog(fields.url);
    emit(level, payload);
    return payload;
  }

  return {
    stages: STAGES,
    debug: (event, fields) => logStage('debug', event, fields),
    info: (event, fields) => logStage('info', event, fields),
    warn: (event, fields) => logStage('warn', event, fields),
    error: (event, fields) => logStage('error', event, fields),
    logStage,
  };
}

/** Default process-wide logger. Tests pass their own sink instead. */
const logger = createLogger();

module.exports = {
  STAGES,
  REDACTED,
  createLogger,
  logger,
  scrubFields,
  redactUrlForLog,
};
