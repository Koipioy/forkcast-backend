'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeFakeFirestore } = require('./helpers/fakeFirestore');
const {
  JOB_STATUS,
  claimJob,
  completeJob,
  createJob,
  deleteExpiredJobs,
  failJob,
  getJob,
  getJobForUser,
  setStage,
} = require('../recipeImport/jobStore');

test('a created job starts queued with a TTL and no result', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, {
    uid: 'user-1',
    url: 'https://www.instagram.com/reel/abc/',
    caption: 'you need 2 eggs',
  });

  assert.strictEqual(job.status, JOB_STATUS.QUEUED);
  assert.strictEqual(job.userId, 'user-1');
  assert.strictEqual(job.attempts, 0);
  assert.ok(job.expiresAt > Date.now());
  assert.strictEqual(job.result, null);
});

test('page text is capped so a job document cannot grow unbounded', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, {
    uid: 'user-1',
    url: 'https://example.com/r',
    pageText: 'x'.repeat(200000),
  });
  assert.ok(job.request.pageText.length <= 60000);
});

test('a claim moves the job to running and a second claim is refused', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, { uid: 'u', url: 'https://example.com/r' });

  const first = await claimJob(db, job.id, 'worker-a');
  assert.strictEqual(first.claimed, true);
  assert.strictEqual(first.job.status, JOB_STATUS.RUNNING);
  assert.strictEqual(first.job.claimedBy, 'worker-a');

  const second = await claimJob(db, job.id, 'worker-b');
  assert.strictEqual(second.claimed, false);
  assert.strictEqual(second.reason, 'running');
});

test('an expired lease lets another worker take over', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, { uid: 'u', url: 'https://example.com/r' });
  await claimJob(db, job.id, 'worker-a');

  // Simulate the first worker dying: force the lease into the past.
  const ref = db.collection('recipe_import_jobs').doc(job.id);
  await ref.update({ leaseExpiresAt: Date.now() - 1000 });

  const retry = await claimJob(db, job.id, 'worker-b');
  assert.strictEqual(retry.claimed, true);
  assert.strictEqual(retry.job.claimedBy, 'worker-b');
});

test('attempts are capped so a poison job cannot loop forever', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, { uid: 'u', url: 'https://example.com/r' });
  const ref = db.collection('recipe_import_jobs').doc(job.id);
  await ref.update({ attempts: 2, leaseExpiresAt: Date.now() - 1000 });

  const claim = await claimJob(db, job.id, 'worker-c');
  assert.strictEqual(claim.claimed, false);
  assert.strictEqual(claim.reason, 'attempts_exhausted');
});

test('a succeeded job is never re-claimed', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, { uid: 'u', url: 'https://example.com/r' });
  await claimJob(db, job.id, 'w');
  await completeJob(db, job.id, { escalated: true });

  const claim = await claimJob(db, job.id, 'w2');
  assert.strictEqual(claim.claimed, false);
  assert.strictEqual(claim.reason, 'succeeded');
});

test('stage updates keep the lease fresh', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, { uid: 'u', url: 'https://example.com/r' });
  await claimJob(db, job.id, 'w');
  const before = (await getJob(db, job.id)).leaseExpiresAt;
  await setStage(db, job.id, 'downloading_video');
  const after = await getJob(db, job.id);
  assert.strictEqual(after.stage, 'downloading_video');
  assert.ok(after.leaseExpiresAt >= before);
});

test('a failure stores a typed, machine-readable error', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, { uid: 'u', url: 'https://example.com/r' });
  const error = Object.assign(new Error('too long'), {
    code: 'VIDEO_TOO_LONG',
    retryable: false,
    details: { durationSeconds: 3600 },
  });
  await failJob(db, job.id, error);

  const stored = await getJob(db, job.id);
  assert.strictEqual(stored.status, JOB_STATUS.FAILED);
  assert.strictEqual(stored.error.code, 'VIDEO_TOO_LONG');
  assert.strictEqual(stored.error.retryable, false);
  assert.strictEqual(stored.error.details.durationSeconds, 3600);
});

test('a job is only readable by the user who created it', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, { uid: 'owner', url: 'https://example.com/r' });

  const mine = await getJobForUser(db, job.id, 'owner');
  assert.strictEqual(mine.id, job.id);

  await assert.rejects(
    () => getJobForUser(db, job.id, 'somebody-else'),
    (err) => err.code === 'JOB_NOT_FOUND',
  );
  await assert.rejects(
    () => getJobForUser(db, 'missing-job', 'owner'),
    (err) => err.code === 'JOB_NOT_FOUND',
  );
});

test('expired jobs are deleted and live ones are kept', async () => {
  const db = makeFakeFirestore();
  const stale = await createJob(db, { uid: 'u', url: 'https://example.com/a' });
  const fresh = await createJob(db, { uid: 'u', url: 'https://example.com/b' });
  await db
    .collection('recipe_import_jobs')
    .doc(stale.id)
    .update({ expiresAt: Date.now() - 1000 });

  const result = await deleteExpiredJobs(db, 10);
  assert.ok(result.deleted >= 1);
  assert.strictEqual(await getJob(db, stale.id), null);
  assert.ok(await getJob(db, fresh.id));
});
