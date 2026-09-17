'use strict';

/**
 * Typed errors for the recipe import pipeline.
 *
 * Every failure the pipeline can produce carries a stable `code` so the client,
 * the logs and the job document all speak the same language. Callers branch on
 * `code`, never on a message string.
 *
 * `retryable` is the other half of the contract: it says whether asking again
 * could plausibly succeed. A video that is too long is not retryable; a
 * provider that returned 503 is.
 */

const ERROR_CODES = {
  // Input / routing
  INVALID_URL: 'INVALID_URL',
  UNSAFE_URL: 'UNSAFE_URL',
  FEATURE_DISABLED: 'FEATURE_DISABLED',

  // Media resolution (yt-dlp and friends)
  MEDIA_TOOLING_UNAVAILABLE: 'MEDIA_TOOLING_UNAVAILABLE',
  MEDIA_RESOLUTION_FAILED: 'MEDIA_RESOLUTION_FAILED',
  MEDIA_METADATA_TIMEOUT: 'MEDIA_METADATA_TIMEOUT',
  MEDIA_NOT_VIDEO: 'MEDIA_NOT_VIDEO',
  MEDIA_UNSUPPORTED: 'MEDIA_UNSUPPORTED',
  /**
   * The platform told us to come back later. Distinct from a generic
   * resolution failure so a log query can separate "our extractor is broken"
   * from "we are being politely throttled" - those need different responses.
   */
  MEDIA_RATE_LIMITED: 'MEDIA_RATE_LIMITED',
  /** A duplicate job gave up waiting for its in-flight twin. */
  MEDIA_DUPLICATE_IN_FLIGHT: 'MEDIA_DUPLICATE_IN_FLIGHT',

  // Cost gates
  VIDEO_TOO_LONG: 'VIDEO_TOO_LONG',
  VIDEO_TOO_LARGE: 'VIDEO_TOO_LARGE',

  // Acquisition
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
  DOWNLOAD_TIMEOUT: 'DOWNLOAD_TIMEOUT',

  // Preprocessing (ffmpeg)
  PREPROCESS_FAILED: 'PREPROCESS_FAILED',
  PREPROCESS_TIMEOUT: 'PREPROCESS_TIMEOUT',
  NO_FRAMES_EXTRACTED: 'NO_FRAMES_EXTRACTED',

  // Analysis (AI)
  TRANSCRIPTION_FAILED: 'TRANSCRIPTION_FAILED',
  ANALYSIS_FAILED: 'ANALYSIS_FAILED',
  ANALYSIS_EMPTY: 'ANALYSIS_EMPTY',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',

  // Job lifecycle
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  JOB_NOT_CLAIMABLE: 'JOB_NOT_CLAIMABLE',
  JOB_BUSY: 'JOB_BUSY',
  JOB_FAILED: 'JOB_FAILED',

  // Catch-all
  INTERNAL_ERROR: 'INTERNAL_ERROR',
};

/** Codes where a later attempt has a real chance of working. */
const ALL_CODES = new Set(Object.values(ERROR_CODES));

const RETRYABLE_CODES = new Set([
  ERROR_CODES.MEDIA_RATE_LIMITED,
  ERROR_CODES.MEDIA_DUPLICATE_IN_FLIGHT,
  ERROR_CODES.MEDIA_RESOLUTION_FAILED,
  ERROR_CODES.MEDIA_METADATA_TIMEOUT,
  ERROR_CODES.DOWNLOAD_FAILED,
  ERROR_CODES.DOWNLOAD_TIMEOUT,
  ERROR_CODES.PREPROCESS_TIMEOUT,
  ERROR_CODES.TRANSCRIPTION_FAILED,
  ERROR_CODES.ANALYSIS_FAILED,
  ERROR_CODES.PROVIDER_UNAVAILABLE,
  ERROR_CODES.JOB_BUSY,
]);

class RecipeImportError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message || code);
    this.name = options.name || 'RecipeImportError';
    this.code = code || ERROR_CODES.INTERNAL_ERROR;
    this.details = details || {};
    this.retryable =
      options.retryable !== undefined
        ? options.retryable
        : RETRYABLE_CODES.has(this.code);
    if (options.cause) {
      this.cause = options.cause;
    }
    Error.captureStackTrace?.(this, this.constructor);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      details: this.details || {},
    };
  }
}

function defineError(name) {
  return class extends RecipeImportError {
    constructor(message, details, options) {
      super(name, message, details, { name, ...options });
    }
  };
}

const InvalidUrlError = defineError(ERROR_CODES.INVALID_URL);
const UnsafeUrlError = defineError(ERROR_CODES.UNSAFE_URL);
const FeatureDisabledError = defineError(ERROR_CODES.FEATURE_DISABLED);
const MediaToolingUnavailableError = defineError(ERROR_CODES.MEDIA_TOOLING_UNAVAILABLE);
const MediaResolutionError = defineError(ERROR_CODES.MEDIA_RESOLUTION_FAILED);
const MediaMetadataTimeoutError = defineError(ERROR_CODES.MEDIA_METADATA_TIMEOUT);
const MediaNotVideoError = defineError(ERROR_CODES.MEDIA_NOT_VIDEO);
const MediaUnsupportedError = defineError(ERROR_CODES.MEDIA_UNSUPPORTED);
const MediaRateLimitedError = defineError(ERROR_CODES.MEDIA_RATE_LIMITED);
const MediaDuplicateInFlightError = defineError(ERROR_CODES.MEDIA_DUPLICATE_IN_FLIGHT);
const VideoTooLongError = defineError(ERROR_CODES.VIDEO_TOO_LONG, '', {}, { retryable: false });
const VideoTooLargeError = defineError(ERROR_CODES.VIDEO_TOO_LARGE);
const DownloadFailedError = defineError(ERROR_CODES.DOWNLOAD_FAILED);
const DownloadTimeoutError = defineError(ERROR_CODES.DOWNLOAD_TIMEOUT);
const PreprocessFailedError = defineError(ERROR_CODES.PREPROCESS_FAILED);
const PreprocessTimeoutError = defineError(ERROR_CODES.PREPROCESS_TIMEOUT);
const NoFramesExtractedError = defineError(ERROR_CODES.NO_FRAMES_EXTRACTED);
const TranscriptionFailedError = defineError(ERROR_CODES.TRANSCRIPTION_FAILED);
const AnalysisFailedError = defineError(ERROR_CODES.ANALYSIS_FAILED);
const AnalysisEmptyError = defineError(ERROR_CODES.ANALYSIS_EMPTY);
const ProviderUnavailableError = defineError(ERROR_CODES.PROVIDER_UNAVAILABLE);
const JobNotFoundError = defineError(ERROR_CODES.JOB_NOT_FOUND);
const JobNotClaimableError = defineError(ERROR_CODES.JOB_NOT_CLAIMABLE);
const JobBusyError = defineError(ERROR_CODES.JOB_BUSY);
const JobFailedError = defineError(ERROR_CODES.JOB_FAILED);

// The two "too big" gates are never worth retrying: the answer will not change.
VideoTooLongError.prototype.retryable = false;
VideoTooLargeError.prototype.retryable = false;

/**
 * Normalise anything thrown into a RecipeImportError.
 *
 * Unknown values become INTERNAL_ERROR rather than escaping as a bare string,
 * so the job document always has a code to store.
 */
function toRecipeImportError(error, fallbackCode = ERROR_CODES.INTERNAL_ERROR) {
  if (error instanceof RecipeImportError) return error;

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown error';

  // An error that crossed a module boundary usually arrives as a plain Error
  // with the code still attached. Keep it: losing the code turns a typed
  // "video too long" into an anonymous internal error at the client.
  const carriedCode =
    error && typeof error === 'object' && ALL_CODES.has(error.code)
      ? error.code
      : fallbackCode;

  const wrapped = new RecipeImportError(carriedCode, message, {}, {
    cause: error,
    retryable:
      error && typeof error === 'object' && error.retryable !== undefined
        ? Boolean(error.retryable)
        : undefined,
  });

  // Preserve a provider HTTP status so callers can still reason about 429s.
  const status = error && typeof error === 'object' ? error.status : undefined;
  if (typeof status === 'number') wrapped.status = status;

  // ...and a Retry-After if one was carried up. A platform that says "wait 90
  // seconds" has told us something better than any backoff curve we could
  // invent, so the retry layer must see it.
  const retryAfter =
    error && typeof error === 'object' ? error.retryAfterSeconds : undefined;
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    wrapped.retryAfterSeconds = retryAfter;
  }

  return wrapped;
}

function isRetryable(error) {
  if (error instanceof RecipeImportError) return Boolean(error.retryable);
  return false;
}

function codeOf(error) {
  if (error instanceof RecipeImportError) return error.code;
  return ERROR_CODES.INTERNAL_ERROR;
}

module.exports = {
  ERROR_CODES,
  RETRYABLE_CODES,
  RecipeImportError,
  InvalidUrlError,
  UnsafeUrlError,
  FeatureDisabledError,
  MediaToolingUnavailableError,
  MediaResolutionError,
  MediaMetadataTimeoutError,
  MediaNotVideoError,
  MediaUnsupportedError,
  MediaRateLimitedError,
  MediaDuplicateInFlightError,
  VideoTooLongError,
  VideoTooLargeError,
  DownloadFailedError,
  DownloadTimeoutError,
  PreprocessFailedError,
  PreprocessTimeoutError,
  NoFramesExtractedError,
  TranscriptionFailedError,
  AnalysisFailedError,
  AnalysisEmptyError,
  ProviderUnavailableError,
  JobNotFoundError,
  JobNotClaimableError,
  JobBusyError,
  JobFailedError,
  toRecipeImportError,
  isRetryable,
  codeOf,
};
