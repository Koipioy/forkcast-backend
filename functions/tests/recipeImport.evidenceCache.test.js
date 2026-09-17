'use strict';

const test = require('node:test');
const assert = require('node:assert');

const cache = require('../recipeImport/evidenceCache');
const { makeFakeFirestore } = require('./helpers/fakeFirestore');
const { createEvidenceBundle, addIngredient } = require('../recipeImport/evidence');

function bundle() {
  const b = createEvidenceBundle({});
  addIngredient(b, '200g pasta', 'transcript', { timestampSeconds: 4 });
  return b;
}

test('equivalent YouTube URLs produce one cache key', () => {
  const a = cache.canonicalCacheKey('https://youtu.be/abc123');
  const b = cache.canonicalCacheKey('https://www.youtube.com/watch?v=abc123&t=90s');
  const c = cache.canonicalCacheKey('https://m.youtube.com/shorts/abc123');
  assert.ok(a && b && c);
  assert.strictEqual(a, b);
  assert.strictEqual(a, c);
});

test('different videos get different keys', () => {
  assert.notStrictEqual(
    cache.canonicalCacheKey('https://youtu.be/abc123'),
    cache.canonicalCacheKey('https://youtu.be/zzz999'),
  );
});

test('a social post path is keyed without its tracking query', () => {
  const a = cache.canonicalCacheKey('https://www.tiktok.com/@cook/video/12345');
  const b = cache.canonicalCacheKey(
    'https://www.tiktok.com/@cook/video/12345?utm_source=share&is_copy_links=1',
  );
  assert.strictEqual(a, b);
});

test('a URL carrying credentials or a signed token is never cached', () => {
  assert.strictEqual(cache.canonicalCacheKey('https://x.example/p?token=abc'), null);
  assert.strictEqual(cache.canonicalCacheKey('https://x.example/p?access_token=abc'), null);
  assert.strictEqual(cache.canonicalCacheKey('https://x.example/p?sessionid=abc'), null);
  assert.strictEqual(cache.canonicalCacheKey('https://x.example/p?sig=deadbeef'), null);
  assert.strictEqual(cache.canonicalCacheKey('https://x.example/private?user_id=42'), null);
});

test('a fresh cache entry is returned and an expired one is not', async () => {
  const db = makeFakeFirestore();
  const key = 'k1';
  await cache.storeCacheResult(db, key, {
    jobId: 'job-a',
    platform: 'youtube',
    evidence: bundle(),
    evidenceText: '### INGREDIENTS',
  });

  const hit = await cache.lookupCache(db, key);
  assert.ok(hit);
  assert.strictEqual(hit.status, 'ready');
  assert.strictEqual(hit.platform, 'youtube');
  assert.strictEqual(hit.evidence.ingredientCandidates.length, 1);

  await cache
    .cacheCollection(db)
    .doc('k1')
    .set({ expiresAt: Date.now() - 1000 }, { merge: true });
  assert.strictEqual(await cache.lookupCache(db, key), null, 'expired entries must not be served');
});

test('the first caller reserves the key and a second caller is told to wait', async () => {
  const db = makeFakeFirestore();
  const first = await cache.reserveCacheKey(db, 'k2', 'job-1');
  assert.strictEqual(first.acquired, true);
  assert.strictEqual(first.reason, 'created');

  const second = await cache.reserveCacheKey(db, 'k2', 'job-2');
  assert.strictEqual(second.acquired, false);
  assert.strictEqual(second.reason, 'in_flight');
  assert.strictEqual(second.entry.jobId, 'job-1');
});

test('a completed entry short-circuits the second caller with `cached`', async () => {
  const db = makeFakeFirestore();
  await cache.reserveCacheKey(db, 'k3', 'job-1');
  await cache.storeCacheResult(db, 'k3', { jobId: 'job-1', evidence: bundle() });

  const second = await cache.reserveCacheKey(db, 'k3', 'job-2');
  assert.strictEqual(second.acquired, false);
  assert.strictEqual(second.reason, 'cached');
});

test('a dead worker\'s reservation is reclaimed by the next caller', async () => {
  const db = makeFakeFirestore();
  await cache.reserveCacheKey(db, 'k4', 'job-dead');
  await cache
    .cacheCollection(db)
    .doc('k4')
    .set({ leaseExpiresAt: Date.now() - 1 }, { merge: true });

  const next = await cache.reserveCacheKey(db, 'k4', 'job-alive');
  assert.strictEqual(next.acquired, true);
  assert.strictEqual(next.reason, 'reclaimed');
});

test('waiting for an in-flight twin returns its result when it lands', async () => {
  const db = makeFakeFirestore();
  await cache.reserveCacheKey(db, 'k5', 'job-1');

  let tick = 0;
  const fastSleep = async () => {
    tick += 1;
    if (tick === 2) {
      await cache.storeCacheResult(db, 'k5', { jobId: 'job-1', evidence: bundle() });
    }
  };

  const waited = await cache.waitForCacheResult(db, 'k5', {
    sleepFn: fastSleep,
    intervalMs: 1,
    maxWaitMs: 10_000,
  });
  assert.ok(waited);
  assert.strictEqual(waited.jobId, 'job-1');
});

test('waiting gives up rather than hanging when the twin never finishes', async () => {
  const db = makeFakeFirestore();
  await cache.reserveCacheKey(db, 'k6', 'job-1');
  const waited = await cache.waitForCacheResult(db, 'k6', {
    sleepFn: async () => {},
    intervalMs: 1,
    maxWaitMs: 50,
  });
  assert.strictEqual(waited, null);
});

test('releasing a reservation lets a later job take it over', async () => {
  const db = makeFakeFirestore();
  await cache.reserveCacheKey(db, 'k7', 'job-1');
  await cache.releaseCacheKey(db, 'k7', 'job-1');
  const next = await cache.reserveCacheKey(db, 'k7', 'job-2');
  assert.strictEqual(next.acquired, true);
});

test('expired cache entries are swept', async () => {
  const db = makeFakeFirestore();
  await cache.storeCacheResult(db, 'k8', { jobId: 'job-1', evidence: bundle() });
  await cache
    .cacheCollection(db)
    .doc('k8')
    .set({ expiresAt: Date.now() - 1 }, { merge: true });

  const { deleted } = await cache.deleteExpiredCacheEntries(db, 10);
  assert.strictEqual(deleted, 1);
});

test('a cache outage degrades to doing the work, not to failing the import', async () => {
  const broken = {
    collection() {
      throw new Error('firestore unavailable');
    },
  };
  assert.strictEqual(await cache.lookupCache(broken, 'x'), null);
  const reserve = await cache.reserveCacheKey(broken, 'x', 'job-1');
  assert.strictEqual(reserve.acquired, true, 'a broken cache must not block the pipeline');
  assert.strictEqual(await cache.storeCacheResult(broken, 'x', {}), null);
  await cache.releaseCacheKey(broken, 'x', 'job-1');
});
