'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  isWorkerConfigured,
  dispatchJobToCloudRun,
} = require('../recipeImport/cloudRun/dispatcher');
const config = require('../recipeImport/config');

function stubResponse(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    headers: { get: () => null },
  };
}

test('no worker URL means no dispatch, and the caller falls back', async () => {
  // WORKER_URL is unset in the test environment.
  assert.strictEqual(config.WORKER_URL, '');
  assert.strictEqual(isWorkerConfigured(), false);

  const result = await dispatchJobToCloudRun({ jobId: 'job-1' });
  assert.strictEqual(result.dispatched, false);
  assert.strictEqual(result.reason, 'worker_not_configured');
});

test('a configured worker receives the job id and a shared-secret header', async () => {
  const calls = [];
  const original = config.WORKER_URL;
  const originalToken = process.env.RECIPE_IMPORT_WORKER_TOKEN;
  config.WORKER_URL = 'https://worker.run.app/';
  process.env.RECIPE_IMPORT_WORKER_TOKEN = 's3cret';

  try {
    const result = await dispatchJobToCloudRun({
      jobId: 'job-42',
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return stubResponse(200, '{"ok":true}');
      },
    });

    assert.strictEqual(result.dispatched, true);
    assert.strictEqual(calls.length, 1);
    // Trailing slash on the configured URL must not produce `//run`.
    assert.strictEqual(calls[0].url, 'https://worker.run.app/run');
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.strictEqual(calls[0].init.headers['x-recipe-import-token'], 's3cret');
    assert.deepStrictEqual(JSON.parse(calls[0].init.body), { jobId: 'job-42' });
  } finally {
    config.WORKER_URL = original;
    if (originalToken === undefined) delete process.env.RECIPE_IMPORT_WORKER_TOKEN;
    else process.env.RECIPE_IMPORT_WORKER_TOKEN = originalToken;
  }
});

test('a dispatch failure is reported, not thrown - the trigger still has the job', async () => {
  const original = config.WORKER_URL;
  config.WORKER_URL = 'https://worker.run.app';

  try {
    const httpResult = await dispatchJobToCloudRun({
      jobId: 'job-5',
      fetchImpl: async () => stubResponse(503, 'unavailable'),
    });
    assert.strictEqual(httpResult.dispatched, false);
    assert.strictEqual(httpResult.reason, 'http_error');
    assert.strictEqual(httpResult.status, 503);

    const netResult = await dispatchJobToCloudRun({
      jobId: 'job-6',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.strictEqual(netResult.dispatched, false);
    assert.strictEqual(netResult.reason, 'network_error');
  } finally {
    config.WORKER_URL = original;
  }
});

test('the worker server rejects an unauthorised run and accepts the shared token', async () => {
  const server = require('../recipeImport/cloudRun/server');
  const original = process.env.RECIPE_IMPORT_WORKER_TOKEN;
  process.env.RECIPE_IMPORT_WORKER_TOKEN = 's3cret';

  try {
    assert.strictEqual(
      server.isAuthorized({ headers: { 'x-recipe-import-token': 's3cret' } }),
      true,
    );
    assert.strictEqual(
      server.isAuthorized({ headers: { 'x-recipe-import-token': 'wrong' } }),
      false,
    );
    assert.strictEqual(server.isAuthorized({ headers: {} }), false);
  } finally {
    if (original === undefined) delete process.env.RECIPE_IMPORT_WORKER_TOKEN;
    else process.env.RECIPE_IMPORT_WORKER_TOKEN = original;
  }
});

test('the worker reports the media tooling it actually found', async () => {
  const server = require('../recipeImport/cloudRun/server');
  await server.logToolVersions();
  const v = server.toolVersions;

  assert.ok(v.node, 'node version is always reported');
  // Whether yt-dlp is present depends on the machine; what matters is that we
  // recorded one answer or the other rather than staying silent.
  assert.ok(
    v.ytDlp || v.ytDlpError,
    'yt-dlp is either versioned or its absence is recorded',
  );
  assert.ok(
    v.ffmpeg || v.ffmpegError,
    'ffmpeg is either versioned or its absence is recorded',
  );
});

test('the worker server exposes health and rejects unknown routes', async () => {
  const server = require('../recipeImport/cloudRun/server');
  const http = require('http');
  const app = server.createServer();

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const port = app.address().port;

  const request = (method, path) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path, method },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      // Always end the request: without it the headers are never flushed and
      // the call sits until the socket times out.
      req.end(method === 'POST' ? '{}' : undefined);
    });

  try {
    const health = await request('GET', '/healthz');
    assert.ok(
      health.status === 200 || health.status === 503,
      `health must answer 200 or report degraded 503, got ${health.status}`,
    );
    const payload = JSON.parse(health.body);
    assert.ok('mediaToolingAvailable' in payload);
    assert.ok('uptimeSeconds' in payload);
    assert.ok('node' in payload);

    const missing = await request('POST', '/nope');
    assert.strictEqual(missing.status, 404);

    // /run without a token must be refused.
    const original = process.env.RECIPE_IMPORT_WORKER_TOKEN;
    process.env.RECIPE_IMPORT_WORKER_TOKEN = 's3cret';
    try {
      const denied = await request('POST', '/run');
      assert.strictEqual(denied.status, 401);
    } finally {
      if (original === undefined) delete process.env.RECIPE_IMPORT_WORKER_TOKEN;
      else process.env.RECIPE_IMPORT_WORKER_TOKEN = original;
    }
  } finally {
    app.close();
  }
});
