'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ConcurrencyLimiter,
  withMediaRetry,
  backoffDelayMs,
  jitteredDelayMs,
  nextDelayMs,
  classifyMediaError,
  parseRetryAfterSeconds,
} = require('../recipeImport/mediaRetry');

const noSleep = async () => {};

function collectLogger() {
  const events = [];
  return {
    events,
    debug: (e, f) => events.push({ level: 'debug', event: e, ...f }),
    info: (e, f) => events.push({ level: 'info', event: e, ...f }),
    warn: (e, f) => events.push({ level: 'warn', event: e, ...f }),
    error: (e, f) => events.push({ level: 'error', event: e, ...f }),
  };
}

test('backoff grows exponentially and is clamped at the ceiling', () => {
  const opts = { baseMs: 15_000, maxMs: 180_000 };
  assert.strictEqual(backoffDelayMs(0, opts), 15_000);
  assert.strictEqual(backoffDelayMs(1, opts), 30_000);
  assert.strictEqual(backoffDelayMs(2, opts), 60_000);
  assert.strictEqual(backoffDelayMs(3, opts), 120_000);
  assert.strictEqual(backoffDelayMs(4, opts), 180_000, 'clamped, not exponential forever');
  assert.strictEqual(backoffDelayMs(20, opts), 180_000);
});

test('jitter spreads the delay but never below zero', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(jitteredDelayMs(30_000, 0.25));
  assert.ok(seen.size > 20, 'jitter must actually vary the delay');
  for (const value of seen) {
    assert.ok(value >= 22_500 && value <= 37_500, `delay ${value} outside the jitter window`);
  }
  assert.ok(jitteredDelayMs(1, 0.9) >= 1);
});

test('a Retry-After header beats our own curve', () => {
  const err = { retryAfterSeconds: 90 };
  const { delayMs, source } = nextDelayMs(err, 0, { maxMs: 180_000 });
  assert.strictEqual(source, 'retry_after');
  assert.strictEqual(delayMs, 90_000);
});

test('a Retry-After longer than the ceiling is clamped', () => {
  const err = { retryAfterSeconds: 7200 };
  const { delayMs, source } = nextDelayMs(err, 0, { maxMs: 180_000 });
  assert.strictEqual(source, 'retry_after');
  assert.strictEqual(delayMs, 180_000, 'we do not hold a worker open for two hours');
});

test('Retry-After is read from platform message text', () => {
  assert.strictEqual(parseRetryAfterSeconds('Retry-After: 120'), 120);
  assert.strictEqual(parseRetryAfterSeconds('too many requests, please try again in 45 seconds'), 45);
  assert.strictEqual(parseRetryAfterSeconds('wait 5 minutes'), 300);
  assert.strictEqual(parseRetryAfterSeconds('no hint here'), null);
});

test('a 429 is classified as rate limited and stays retryable', () => {
  const err = new Error('HTTP 429 Too Many Requests');
  err.status = 429;
  const typed = classifyMediaError(err, '');
  assert.strictEqual(typed.code, 'MEDIA_RATE_LIMITED');
  assert.strictEqual(typed.retryable, true);
});

test('a rate limit message in stderr is classified even without a status', () => {
  const err = new Error('ERROR: unable to fetch');
  const typed = classifyMediaError(err, '429: Too Many Requests - try again in 30 seconds');
  assert.strictEqual(typed.code, 'MEDIA_RATE_LIMITED');
  assert.strictEqual(typed.retryAfterSeconds, 30);
});

test('a non-rate-limit failure keeps its own code', () => {
  const err = new Error('Unsupported URL');
  err.code = 'MEDIA_UNSUPPORTED';
  const typed = classifyMediaError(err, 'nothing special');
  assert.strictEqual(typed.code, 'MEDIA_UNSUPPORTED');
  assert.strictEqual(typed.retryable, false);
});

test('a retryable media call is retried with backoff and then succeeds', async () => {
  const delays = [];
  let calls = 0;
  const logger = collectLogger();

  const result = await withMediaRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('429 Too Many Requests');
        err.status = 429;
        throw err;
      }
      return 'ok';
    },
    {
      platform: 'tiktok',
      maxAttempts: 4,
      baseMs: 1000,
      maxMs: 8000,
      jitterRatio: 0,
      sleepFn: async (ms) => delays.push(ms),
      logger,
      jobId: 'job-1',
    },
  );

  assert.strictEqual(result, 'ok');
  assert.strictEqual(calls, 3);
  assert.deepStrictEqual(delays, [1000, 2000]);
  assert.strictEqual(logger.events.length, 2);
  assert.strictEqual(logger.events[0].event, 'media_retry_scheduled');
  assert.strictEqual(logger.events[0].platform, 'tiktok');
  assert.strictEqual(logger.events[0].code, 'MEDIA_RATE_LIMITED');
});

test('retry exhaustion throws the last typed error rather than looping forever', async () => {
  const delays = [];
  let calls = 0;

  await assert.rejects(
    withMediaRetry(
      async () => {
        calls += 1;
        const err = new Error('rate limited');
        err.status = 429;
        throw err;
      },
      {
        platform: 'instagram',
        maxAttempts: 3,
        baseMs: 1000,
        maxMs: 8000,
        jitterRatio: 0,
        sleepFn: async (ms) => delays.push(ms),
      },
    ),
    (err) => {
      assert.strictEqual(err.code, 'MEDIA_RATE_LIMITED');
      return true;
    },
  );

  assert.strictEqual(calls, 3, 'exactly maxAttempts, then stop');
  assert.strictEqual(delays.length, 2, 'no sleep after the final attempt');
});

test('a non-retryable error is not retried at all', async () => {
  let calls = 0;
  await assert.rejects(
    withMediaRetry(
      async () => {
        calls += 1;
        const err = new Error('video too long');
        err.code = 'VIDEO_TOO_LONG';
        err.retryable = false;
        throw err;
      },
      { platform: 'youtube', maxAttempts: 5, sleepFn: noSleep },
    ),
    (err) => {
      assert.strictEqual(err.code, 'VIDEO_TOO_LONG');
      return true;
    },
  );
  assert.strictEqual(calls, 1);
});

test('the limiter allows only one job per platform at a time', async () => {
  const limiter = new ConcurrencyLimiter({ perKey: 1, total: 4 });
  const order = [];

  const first = await limiter.acquire('tiktok');
  assert.strictEqual(limiter.activeFor('tiktok'), 1);

  let secondResolved = false;
  const second = limiter.acquire('tiktok').then((release) => {
    secondResolved = true;
    order.push('second');
    return release;
  });

  await new Promise((r) => setImmediate(r));
  assert.strictEqual(secondResolved, false, 'second tiktok job must wait');

  // A different platform is not blocked by tiktok being busy.
  const other = await limiter.acquire('youtube');
  assert.strictEqual(limiter.activeFor('youtube'), 1);
  assert.strictEqual(secondResolved, false);

  first();
  await new Promise((r) => setImmediate(r));
  const secondRelease = await second;
  assert.strictEqual(secondResolved, true);
  assert.strictEqual(limiter.activeFor('tiktok'), 1);

  other();
  secondRelease();
  assert.strictEqual(limiter.active, 0);
});

test('the limiter total ceiling blocks across platforms', async () => {
  const limiter = new ConcurrencyLimiter({ perKey: 1, total: 1 });
  const a = await limiter.acquire('tiktok');

  let bResolved = false;
  const bPromise = limiter.acquire('youtube').then((release) => {
    bResolved = true;
    return release;
  });

  await new Promise((r) => setImmediate(r));
  assert.strictEqual(bResolved, false, 'total ceiling of 1 must block a second platform too');

  a();
  const b = await bPromise;
  assert.strictEqual(bResolved, true, 'releasing the only slot must wake the waiter');
  assert.strictEqual(limiter.activeFor('youtube'), 1);
  b();
  assert.strictEqual(limiter.active, 0);
});

test('releasing twice does not let extra jobs through', async () => {
  const limiter = new ConcurrencyLimiter({ perKey: 1, total: 2 });
  const release = await limiter.acquire('x');
  release();
  release();
  release();
  assert.strictEqual(limiter.active, 0, 'double release must not go negative or over-admit');
  const next = await limiter.acquire('x');
  assert.strictEqual(limiter.activeFor('x'), 1);
  next();
});

test('withMediaRetry releases its slot even when the call throws', async () => {
  const limiter = new ConcurrencyLimiter({ perKey: 1, total: 2 });
  await assert.rejects(
    withMediaRetry(
      async () => {
        throw new Error('boom');
      },
      { platform: 'x', maxAttempts: 1, limiter, sleepFn: noSleep },
    ),
  );
  assert.strictEqual(limiter.active, 0);
});
