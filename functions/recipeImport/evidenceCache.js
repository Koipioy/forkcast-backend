'use strict';

/**
 * Cache and de-duplicate media resolution.
 *
 * The case this exists for: one viral cooking video, a hundred users pasting
 * the same link within an hour. Without a cache that is a hundred yt-dlp
 * calls, a hundred downloads, a hundred ffmpeg runs and a hundred model
 * calls producing the same evidence. With it, it is one of each and ninety-nine
 * reads.
 *
 * What gets cached is deliberately the cheap-to-keep half: resolved metadata
 * and extracted evidence. The video file itself is never stored - that is the
 * expensive thing, and holding it turns a cache into a media library nobody
 * asked for.
 *
 * What must NOT be cached is handled by the key: only public, canonical,
 * unauthenticated URLs get a key at all. A URL carrying a signed token, a
 * session parameter or a user-specific path is refused a cache entry, so one
 * user's private content can never be served to another.
 */

const crypto = require('crypto');

const config = require('./config');
const { canonicalizeYouTubeUrl } = require('./analyzers/geminiYouTubeDirect');

/**
 * Query parameters that make a URL user-specific rather than public.
 *
 * If any of these are present the URL is not cacheable: it encodes who is
 * asking, or grants temporary access that must not be reused by someone else.
 */
const NON_CACHEABLE_QUERY_KEYS = [
  'sig',
  'signature',
  'token',
  'access_token',
  'accesstoken',
  'auth',
  'auth_token',
  'session',
  'sessionid',
  'jsessionid',
  'phpsessid',
  'key',
  'api_key',
  'apikey',
  'expires',
  'expiry',
  'policy',
  'user_id',
  'uid',
  'private',
];

/**
 * Canonicalise a URL into a cache key.
 *
 * Returns null when the URL must not be cached. YouTube gets an exact
 * video-id key so its many equivalent forms collapse to one entry; everything
 * else is normalised by scheme + host + path with the query dropped, unless a
 * auth-ish parameter is present.
 */
function canonicalCacheKey(url) {
  if (!url || typeof url !== 'string') return null;

  const youtube = canonicalizeYouTubeUrl(url);
  if (youtube) return hashKey(`yt:${youtube}`);

  let parsed;
  try {
    parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
  } catch (_err) {
    return null;
  }

  const params = Array.from(parsed.searchParams.keys()).map((k) => k.toLowerCase());
  if (params.some((key) => NON_CACHEABLE_QUERY_KEYS.includes(key))) {
    return null;
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '');
  return hashKey(`${host}${path}`);
}

function hashKey(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function cacheCollection(db) {
  return db.collection(config.EVIDENCE_CACHE_COLLECTION);
}

function isFresh(entry, now = Date.now()) {
  if (!entry) return false;
  return Number(entry.expiresAt || 0) > now;
}

/**
 * Look up a cached result.
 *
 * Only a completed entry counts. An entry still marked `in_flight` is not a
 * result; it is a signal that somebody else is doing the work right now.
 */
async function lookupCache(db, key) {
  if (!db || !config.EVIDENCE_CACHE_ENABLED || !key) return null;
  try {
    const snap = await cacheCollection(db).doc(key).get();
    if (!snap.exists) return null;
    const entry = { id: snap.id, ...snap.data() };
    if (entry.status !== 'ready' || !isFresh(entry)) return null;
    return entry;
  } catch (_err) {
    // A cache miss is never allowed to fail an import.
    return null;
  }
}

/**
 * Claim the key for this job.
 *
 * Written with create-if-absent semantics so two jobs starting at the same
 * instant cannot both believe they own it. Returns `{ acquired: true }` when
 * this caller should do the work, or `{ acquired: false, entry }` when
 * somebody else holds it.
 */
async function reserveCacheKey(db, key, jobId) {
  if (!db || !config.EVIDENCE_CACHE_ENABLED || !key) {
    return { acquired: true, reason: 'cache_disabled' };
  }
  const now = Date.now();

  try {
    // Inside the try: a Firestore outage throws here, and a cache being down
    // must never be able to fail an import.
    const ref = cacheCollection(db).doc(key);
    const existing = await ref.get();
    if (existing.exists) {
      const entry = { id: ref.id, ...existing.data() };
      if (entry.status === 'ready' && isFresh(entry)) {
        return { acquired: false, reason: 'cached', entry };
      }
      if (
        entry.status === 'in_flight' &&
        Number(entry.leaseExpiresAt || 0) > now &&
        entry.jobId !== jobId
      ) {
        return { acquired: false, reason: 'in_flight', entry };
      }
      await ref.set(
        {
          status: 'in_flight',
          jobId,
          leaseExpiresAt: now + config.JOB_LEASE_SECONDS * 1000,
          updatedAt: now,
        },
        { merge: true },
      );
      return { acquired: true, reason: 'reclaimed' };
    }

    await ref.set({
      key,
      status: 'in_flight',
      jobId,
      hits: 0,
      leaseExpiresAt: now + config.JOB_LEASE_SECONDS * 1000,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + config.EVIDENCE_CACHE_TTL_MINUTES * 60 * 1000,
      media: null,
      evidence: null,
      evidenceText: null,
    });
    return { acquired: true, reason: 'created' };
  } catch (_err) {
    // If the cache is unreachable, do the work rather than refuse it.
    return { acquired: true, reason: 'cache_error' };
  }
}

/** Publish a completed result under the key. */
async function storeCacheResult(db, key, payload) {
  if (!db || !config.EVIDENCE_CACHE_ENABLED || !key) return null;
  const now = Date.now();
  const doc = {
    key,
    status: 'ready',
    jobId: payload.jobId || null,
    platform: payload.platform || null,
    canonicalUrl: payload.canonicalUrl || null,
    media: payload.media || null,
    evidence: payload.evidence || null,
    evidenceText: payload.evidenceText || null,
    hits: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + config.EVIDENCE_CACHE_TTL_MINUTES * 60 * 1000,
    leaseExpiresAt: null,
  };
  try {
    await cacheCollection(db).doc(key).set(doc, { merge: true });
    return doc;
  } catch (_err) {
    return null;
  }
}

/** Release a reservation that will never be published (the job failed). */
async function releaseCacheKey(db, key, jobId) {
  if (!db || !config.EVIDENCE_CACHE_ENABLED || !key) return;
  try {
    const ref = cacheCollection(db).doc(key);
    const snap = await ref.get();
    if (!snap.exists) return;
    const entry = snap.data() || {};
    if (entry.status === 'in_flight' && entry.jobId === jobId) {
      await ref.set({ status: 'abandoned', leaseExpiresAt: null, updatedAt: Date.now() }, { merge: true });
    }
  } catch (_err) {
    // Best effort. A stale in_flight entry expires with its lease anyway.
  }
}

/**
 * Wait for an in-flight twin to publish its result.
 *
 * Bounded on purpose. The alternative - starting our own download - is what
 * the cache exists to prevent, but hanging forever is worse. If the twin does
 * not finish inside the window, the caller is told to go and do its own work.
 */
async function waitForCacheResult(db, key, options = {}) {
  const maxWaitMs = Number(options.maxWaitMs ?? config.EVIDENCE_CACHE_DEDUPE_WAIT_MS);
  const intervalMs = Number(options.intervalMs ?? 2_000);
  const sleeper = options.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await sleeper(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    const entry = await lookupCache(db, key);
    if (entry) return entry;
  }
  return null;
}

/** Drop cache entries past their TTL. */
async function deleteExpiredCacheEntries(db, limit = 100) {
  if (!db) return { deleted: 0 };
  const now = Date.now();
  try {
    const snap = await cacheCollection(db)
      .where('expiresAt', '<=', now)
      .limit(limit)
      .get();
    let deleted = 0;
    for (const doc of snap.docs) {
      await doc.ref.delete();
      deleted += 1;
    }
    return { deleted };
  } catch (_err) {
    return { deleted: 0 };
  }
}

module.exports = {
  NON_CACHEABLE_QUERY_KEYS,
  canonicalCacheKey,
  cacheCollection,
  isFresh,
  lookupCache,
  reserveCacheKey,
  storeCacheResult,
  releaseCacheKey,
  waitForCacheResult,
  deleteExpiredCacheEntries,
  hashKey,
};
