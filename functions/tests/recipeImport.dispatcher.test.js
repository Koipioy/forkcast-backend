'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.RECIPE_IMPORT_WORKER_URL = 'https://worker.example.test';
process.env.RECIPE_IMPORT_WORKER_TOKEN = 'test-shared-secret';

const { dispatchJobToCloudRun } = require('../recipeImport/cloudRun/dispatcher');

function makeLogger() {
  const lines = [];
  return {
    lines,
    info: (event, meta) => lines.push({ level: 'info', event, meta }),
    warn: (event, meta) => lines.push({ level: 'warn', event, meta }),
    error: (event, meta) => lines.push({ level: 'error', event, meta }),
  };
}

function timeoutFetch() {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return async () => {
    throw err;
  };
}

test('a dispatch timeout where the worker already claimed the job counts as dispatched', async () => {
  const log = makeLogger();
  const db = {
    collection() {
      return {
        doc() {
          return {
            async get() {
              return { exists: true, data: () => ({ claimedBy: 'worker-1', status: 'running' }) };
            },
          };
        },
      };
    },
  };

  const res = await dispatchJobToCloudRun({
    jobId: 'rji_claimed',
    logger: log,
    fetchImpl: timeoutFetch(),
    db,
  });

  assert.strictEqual(res.dispatched, true);
  assert.strictEqual(res.reason, 'claimed_after_timeout');
  const errors = log.lines.filter((l) => l.level === 'error');
  assert.strictEqual(errors.length, 0, 'a claimed job must not log an error');
  assert.ok(
    log.lines.some((l) => l.event === 'recipe_import_worker_dispatch_timeout_but_claimed'),
    'the claim-after-timeout path should be logged',
  );
});

test('a dispatch timeout with no claim yet warns instead of erroring', async () => {
  const log = makeLogger();
  const db = {
    collection() {
      return {
        doc() {
          return { async get() { return { exists: true, data: () => ({ status: 'queued' }) }; } };
        },
      };
    },
  };

  const res = await dispatchJobToCloudRun({
    jobId: 'rji_unclaimed',
    logger: log,
    fetchImpl: timeoutFetch(),
    db,
  });

  assert.strictEqual(res.dispatched, false);
  assert.strictEqual(res.reason, 'timeout');
  assert.strictEqual(log.lines.filter((l) => l.level === 'error').length, 0,
    'a cold-start timeout is not proof of failure and must not log an error');
  assert.ok(log.lines.some((l) => l.level === 'warn' && l.event === 'recipe_import_worker_dispatch_error'));
});

test('a hard network failure still logs an error', async () => {
  const log = makeLogger();
  const res = await dispatchJobToCloudRun({
    jobId: 'rji_netfail',
    logger: log,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.strictEqual(res.dispatched, false);
  assert.strictEqual(res.reason, 'network_error');
  assert.ok(log.lines.some((l) => l.level === 'error' && l.event === 'recipe_import_worker_dispatch_error'));
});

test('a successful dispatch is reported as dispatched', async () => {
  const log = makeLogger();
  const res = await dispatchJobToCloudRun({
    jobId: 'rji_ok',
    logger: log,
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.strictEqual(res.dispatched, true);
  assert.ok(log.lines.some((l) => l.event === 'recipe_import_worker_dispatched'));
});
