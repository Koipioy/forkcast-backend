'use strict';

/**
 * Retry and concurrency control for media acquisition.
 *
 * Social platforms throttle. That is expected traffic management on their
 * side, not a bug on ours. The response here is ordinary good-citizen
 * behaviour: back off, add jitter, honour an explicit Retry-After, cap the
 * total number of tries, and give up cleanly.
 *
 * What this deliberately is NOT: it does not rotate IPs, does not proxy, does
 * not spoof user agents, and does nothing else designed to get around a
 * platform's anti-abuse controls. If a platform says no, we wait or we walk
 * away. That keeps the feature honest and keeps the account and the egress IP
 * out of trouble.
 */

const config = require('./config');
const {
  ERROR_CODES,
  MediaRateLimitedError,
  isRetryable,
  toRecipeImportError,
} = require('./errors');

/**
 * Pull a Retry-After hint out of a yt-dlp failure.
 *
 * yt-dlp does not surface response headers, but it does echo the platform's
 * message, and rate-limit messages from YouTube, TikTok and Instagram tend to
 * contain a number of seconds. Best-effort: if we cannot read one we return
 * null and fall back to the backoff curve rather than guessing.
 */
function parseRetryAfterSeconds(text) {
  if (!text || typeof text !== 'string') return null;

  const header = text.match(/retry-after["']?\s*[:=]\s*"?(\d+)/i);
  if (header) return Number(header[1]);

  const explicit = text.match(
    /(?:try again|wait|retry)\s+(?:in\s+)?(\d{1,5})\s*(?:seconds?|secs?)\b/i,
  );
  if (explicit) return Number(explicit[1]);

  const minutes = text.match(
    /(?:try again|wait|retry)\s+(?:in\s+)?(\d{1,3})\s*(?:minutes?|mins?)\b/i,
  );
  if (minutes) return Number(minutes[1]) * 60;

  const hours = text.match(
    /(?:try again|wait|retry)\s+(?:in\s+)?(\d{1,2})\s*(?:hours?|hrs?)\b/i,
  );
  if (hours) return Number(hours[1]) * 3600;

  return null;
}

/**
 * Classify a yt-dlp failure.
 *
 * A 429 or a "too many requests" message is a rate limit: retryable, and it
 * may carry its own delay. Anything else keeps whatever classification the
 * error already had.
 */
function classifyMediaError(error, stderrText) {
  const typed = toRecipeImportError(error);
  const haystack = `${typed.message || ''}\n${stderrText || ''}`;

  const looksRateLimited =
    typed.status === 429 ||
    /\b429\b/.test(haystack) ||
    /too many requests/i.test(haystack) ||
    /rate ?limit/i.test(haystack) ||
    /please try again later/i.test(haystack) ||
    /captcha/i.test(haystack) && /too many|blocked/i.test(haystack);

  if (!looksRateLimited) return typed;

  const retryAfter = parseRetryAfterSeconds(haystack);
  const rateLimited = new MediaRateLimitedError(
    typed.message || 'Media platform is rate limiting us.',
    { ...(typed.details || {}), originalCode: typed.code },
    { retryable: true },
  );
  rateLimited.status = typed.status;
  if (retryAfter !== null && Number.isFinite(retryAfter)) {
    rateLimited.retryAfterSeconds = retryAfter;
  }
  return rateLimited;
}

/**
 * Backoff for attempt `n` (0-based), before jitter.
 *
 * 15s, 30s, 60s, 120s... clamped at MEDIA_RETRY_MAX_MS. The first delay is
 * long enough to matter to a throttling platform and short enough that a user
 * watching a progress bar is not left wondering whether anything is happening.
 */
function backoffDelayMs(attempt, overrides = {}) {
  const base = Number(overrides.baseMs ?? config.MEDIA_RETRY_BASE_MS);
  const max = Number(overrides.maxMs ?? config.MEDIA_RETRY_MAX_MS);
  const exponential = base * Math.pow(2, Math.max(0, attempt));
  return Math.min(Math.max(base, exponential), max);
}

/**
 * Spread a delay so a burst of failed jobs does not come back in lockstep.
 *
 * Without jitter, a rate limit that hits fifty jobs at 12:00:00 produces
 * fifty retries at 12:00:15 - which is just a second attack with extra
 * steps. The jitter is applied as a symmetric window around the delay and is
 * clamped to stay positive.
 */
function jitteredDelayMs(delayMs, ratio = config.MEDIA_RETRY_JITTER_RATIO) {
  const fraction = Math.min(Math.max(Number(ratio) || 0, 0), 0.9);
  if (fraction === 0) return Math.round(delayMs);
  const spread = delayMs * fraction;
  const jitter = (Math.random() * 2 - 1) * spread;
  return Math.max(1, Math.round(delayMs + jitter));
}

/**
 * Resolve the delay before the next attempt.
 *
 * An explicit Retry-After wins over our curve, but is still clamped to the
 * ceiling: a platform asking for an hour is telling us to go away, not asking
 * us to hold a worker open for an hour.
 */
function nextDelayMs(error, attempt, overrides = {}) {
  const max = Number(overrides.maxMs ?? config.MEDIA_RETRY_MAX_MS);
  if (Number.isFinite(error?.retryAfterSeconds) && error.retryAfterSeconds > 0) {
    return {
      delayMs: Math.min(error.retryAfterSeconds * 1000, max),
      source: 'retry_after',
    };
  }
  return {
    delayMs: jitteredDelayMs(
      backoffDelayMs(attempt, overrides),
      overrides.jitterRatio ?? config.MEDIA_RETRY_JITTER_RATIO,
    ),
    source: 'backoff',
  };
}

/**
 * A small in-process semaphore.
 *
 * Per-instance on purpose. Cross-instance coordination would need a shared
 * counter and would be a much larger machine than "do not stampede TikTok".
 * Cloud Run scales instances on request volume; the per-platform ceiling
 * bounds what any one instance does at a time.
 */
class ConcurrencyLimiter {
  constructor({ perKey = 1, total = Infinity, name = 'limiter' } = {}) {
    this.perKey = Math.max(1, Number(perKey) || 1);
    this.total = Number(total) > 0 ? Number(total) : Infinity;
    this.name = name;
    this.activeByKey = new Map();
    this.activeTotal = 0;
    this.waitersByKey = new Map();
    this.waitersTotal = [];
  }

  get active() {
    return this.activeTotal;
  }

  activeFor(key) {
    return this.activeByKey.get(key) || 0;
  }

  get pendingCount() {
    let n = this.waitersTotal.length;
    for (const queue of this.waitersByKey.values()) n += queue.length;
    return n;
  }

  _slotAvailable(key) {
    return (
      this.activeTotal < this.total &&
      (this.activeByKey.get(key) || 0) < this.perKey
    );
  }

  _take(key) {
    this.activeTotal += 1;
    this.activeByKey.set(key, (this.activeByKey.get(key) || 0) + 1);
  }

  /**
   * Wait for a slot. Resolves with a release function that MUST be called.
   *
   * The release is idempotent so a caller that releases in a `finally` and a
   * timeout path cannot double-decrement the counter and let three jobs
   * through on a limit of two.
   */
  acquire(key = 'default') {
    if (this._slotAvailable(key)) {
      this._take(key);
      return Promise.resolve(this._releaseOnce(key));
    }

    return new Promise((resolve) => {
      const waiter = () => {
        if (this._slotAvailable(key)) {
          this._take(key);
          resolve(this._releaseOnce(key));
          return true;
        }
        return false;
      };

      if (!this.waitersByKey.has(key)) this.waitersByKey.set(key, []);
      this.waitersByKey.get(key).push(waiter);
      this.waitersTotal.push(waiter);
    });
  }

  _releaseOnce(key) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTotal = Math.max(0, this.activeTotal - 1);
      const current = this.activeByKey.get(key) || 0;
      if (current <= 1) this.activeByKey.delete(key);
      else this.activeByKey.set(key, current - 1);
      this._drain(key);
    };
  }

  _drain(key) {
    const queue = this.waitersByKey.get(key);
    if (Array.isArray(queue) && queue.length > 0) {
      const waiter = queue.shift();
      if (waiter()) {
        if (queue.length === 0) this.waitersByKey.delete(key);
      } else if (queue.length > 0) {
        // Still blocked for this key; leave the waiter queued.
        queue.unshift(waiter);
      }
    }
    // A slot freed globally may unblock a waiter on another key.
    if (this.activeTotal < this.total) {
      for (const otherKey of Array.from(this.waitersByKey.keys())) {
        if (otherKey === key) continue;
        const otherQueue = this.waitersByKey.get(otherKey);
        if (otherQueue && otherQueue.length > 0 && this._slotAvailable(otherKey)) {
          const w = otherQueue.shift();
          w();
          if (otherQueue.length === 0) this.waitersByKey.delete(otherKey);
          break;
        }
      }
    }
  }
}

const sharedLimiter = new ConcurrencyLimiter({
  perKey: config.MEDIA_MAX_CONCURRENT_PER_PLATFORM,
  total: config.MEDIA_MAX_CONCURRENT_TOTAL,
  name: 'media',
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a media operation with retry, backoff, jitter and concurrency control.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{platform?: string, logger?: object, maxAttempts?: number,
 *          baseMs?: number, maxMs?: number, jitterRatio?: number,
 *          limiter?: ConcurrencyLimiter, jobId?: string, operation?: string,
 *          sleepFn?: (ms:number)=>Promise<void>}} [options]
 * @returns {Promise<T>}
 */
async function withMediaRetry(fn, options = {}) {
  const maxAttempts = Math.max(
    1,
    Number(options.maxAttempts ?? config.MEDIA_RETRY_MAX_ATTEMPTS),
  );
  const platform = options.platform || 'unknown';
  const limiter = options.limiter || sharedLimiter;
  const logger = options.logger || null;
  const sleeper = options.sleepFn || sleep;
  const operation = options.operation || 'media_operation';

  const release = await limiter.acquire(platform);
  try {
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        const typed = classifyMediaError(err, err?.details?.stderrTail);
        lastError = typed;

        const canTryAgain = isRetryable(typed) && attempt < maxAttempts - 1;
        if (!canTryAgain) {
          throw typed;
        }

        const { delayMs, source } = nextDelayMs(typed, attempt, options);

        if (logger) {
          logger.warn(STAGES_OR_DEFAULT(), {
            jobId: options.jobId,
            platform,
            operation,
            attempt: attempt + 1,
            maxAttempts,
            delayMs,
            delaySource: source,
            code: typed.code,
          });
        }
        await sleeper(delayMs);
      }
    }

    throw lastError || toRecipeImportError(new Error('media retry exhausted'));
  } finally {
    release();
  }
}

// Resolved lazily so this module does not depend on load order with logging.
function STAGES_OR_DEFAULT() {
  // eslint-disable-next-line global-require
  const { STAGES } = require('./logging');
  return STAGES.MEDIA_RETRY_SCHEDULED;
}

module.exports = {
  ConcurrencyLimiter,
  sharedLimiter,
  withMediaRetry,
  backoffDelayMs,
  jitteredDelayMs,
  nextDelayMs,
  classifyMediaError,
  parseRetryAfterSeconds,
};
