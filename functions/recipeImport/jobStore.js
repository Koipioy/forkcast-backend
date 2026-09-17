'use strict';

/**
 * Recipe import jobs in Firestore.
 *
 * A video import can run for minutes. A callable request that holds a socket
 * open for minutes is a bad idea, so the client creates a job, the worker picks
 * it up in a background function, and the client polls the document.
 *
 * The claim is a transaction, not a read-then-write: two triggers firing on the
 * same document would otherwise both start ffmpeg and double the cost of one
 * import.
 */

const crypto = require('crypto');

const config = require('./config');
const { JobNotClaimableError, JobNotFoundError } = require('./errors');

const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
};

function jobCollection(db) {
  return db.collection(config.JOB_COLLECTION);
}

function newJobId() {
  return `rji_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 128);
}

async function createJob(db, params) {
  const {
    uid,
    url,
    pageText = null,
    caption = null,
    structuredRecipe = null,
    skipSufficiencyCheck = false,
    provider = null,
    model = null,
  } = params;

  if (!uid || !url) throw new Error('createJob requires uid and url');

  const id = params.id || newJobId();
  const now = Date.now();

  const doc = {
    id,
    userId: uid,
    url,
    status: JOB_STATUS.QUEUED,
    stage: 'queued',
    request: {
      // Page text is stored so a retried job does not need the client to
      // re-scrape. It is capped: a job document is not a document store.
      pageText: pageText ? String(pageText).slice(0, 60000) : null,
      caption: caption ? String(caption).slice(0, 20000) : null,
      structuredRecipe: structuredRecipe || null,
      skipSufficiencyCheck: Boolean(skipSufficiencyCheck),
      provider: provider || null,
      model: model || null,
    },
    attempts: 0,
    maxAttempts: config.JOB_MAX_ATTEMPTS,
    claimedBy: null,
    leaseExpiresAt: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    expiresAt: now + config.JOB_TTL_HOURS * 60 * 60 * 1000,
    result: null,
    error: null,
    metrics: null,
  };

  await jobCollection(db).doc(id).set(doc);
  return doc;
}

/**
 * Take ownership of a job for one worker.
 *
 * Also re-queues a job whose previous worker died: if the lease has expired the
 * next claimer picks it up, up to `maxAttempts`.
 */
async function claimJob(db, jobId, workerId) {
  const ref = jobCollection(db).doc(jobId);

  return db.runTransaction(async (tx) => {
    const snap = await ref.get();
    if (!snap.exists) {
      return { claimed: false, reason: 'not_found', job: null };
    }
    const job = snap.data() || {};
    const now = Date.now();

    const leaseExpired =
      job.leaseExpiresAt === null || Number(job.leaseExpiresAt) < now;

    if (job.status === JOB_STATUS.RUNNING && !leaseExpired) {
      return { claimed: false, reason: 'running', job };
    }

    if (job.status === JOB_STATUS.SUCCEEDED) {
      return { claimed: false, reason: 'succeeded', job };
    }

    if (Number(job.attempts || 0) >= Number(job.maxAttempts || 1)) {
      return { claimed: false, reason: 'attempts_exhausted', job };
    }

    const attempts = Number(job.attempts || 0) + 1;
    const update = {
      status: JOB_STATUS.RUNNING,
      stage: 'started',
      attempts,
      claimedBy: workerId,
      leaseExpiresAt: now + config.JOB_LEASE_SECONDS * 1000,
      startedAt: job.startedAt || now,
    };
    tx.update(ref, update);
    return { claimed: true, reason: 'claimed', job: { ...job, ...update } };
  });
}

async function setStage(db, jobId, stage, fields = {}) {
  const ref = jobCollection(db).doc(jobId);
  await ref.set(
    {
      stage,
      updatedAt: Date.now(),
      leaseExpiresAt: Date.now() + config.JOB_LEASE_SECONDS * 1000,
      ...fields,
    },
    { merge: true },
  );
}

/**
 * Recursively drop keys whose value is `undefined`.
 *
 * Firestore rejects `undefined` anywhere inside a document with a low-level
 * "Cannot use undefined as a Firestore value" error. When that fires AFTER an
 * expensive model call it destroys good work and is painful to trace back to the
 * one field responsible - it took down a whole recipe import for a single
 * `confidence: undefined` on an ingredient candidate. So we strip it at the
 * write boundary rather than trusting every producer to omit absent optionals.
 *
 * `null` is preserved on purpose: it is a meaningful Firestore value, and the
 * difference between "absent" and "explicitly none" matters downstream.
 */
function stripUndefined(value) {
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : stripUndefined(item)));
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue;
      out[key] = stripUndefined(val);
    }
    return out;
  }
  return value;
}

async function completeJob(db, jobId, result, metrics = null) {
  const ref = jobCollection(db).doc(jobId);
  await ref.set(
    {
      status: JOB_STATUS.SUCCEEDED,
      stage: 'completed',
      result: stripUndefined(result),
      metrics: stripUndefined(metrics),
      finishedAt: Date.now(),
      updatedAt: Date.now(),
      error: null,
    },
    { merge: true },
  );
}

async function failJob(db, jobId, error) {
  const ref = jobCollection(db).doc(jobId);
  await ref.set(
    {
      status: JOB_STATUS.FAILED,
      stage: 'failed',
      finishedAt: Date.now(),
      updatedAt: Date.now(),
      error: {
        code: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Unknown error',
        retryable: Boolean(error?.retryable),
        details: error?.details || {},
      },
    },
    { merge: true },
  );
}

async function getJob(db, jobId) {
  const snap = await jobCollection(db).doc(jobId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

/** Read a job and check it belongs to the caller. */
async function getJobForUser(db, jobId, uid) {
  const job = await getJob(db, jobId);
  if (!job) throw new JobNotFoundError('Job not found.', { jobId });
  if (job.userId !== uid) throw new JobNotFoundError('Job not found.', { jobId });
  return job;
}

/**
 * Drop jobs past their TTL.
 *
 * Job documents hold page text, so they are not left around indefinitely.
 */
async function deleteExpiredJobs(db, limit = 100) {
  const now = Date.now();
  const snap = await jobCollection(db)
    .where('expiresAt', '<=', now)
    .limit(limit)
    .get();

  let deleted = 0;
  for (const doc of snap.docs) {
    await doc.ref.delete();
    deleted += 1;
  }
  return { deleted };
}

module.exports = {
  JOB_STATUS,
  jobCollection,
  newJobId,
  createJob,
  claimJob,
  setStage,
  completeJob,
  stripUndefined,
  failJob,
  getJob,
  getJobForUser,
  deleteExpiredJobs,
};
