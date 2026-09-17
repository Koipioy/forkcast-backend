'use strict';

/**
 * Cloud Run entrypoint for the recipe-import worker.
 *
 * This is the seam working as designed. `workerRuntime.runWorkerJob()` is the
 * same function the Firebase trigger calls; the trigger was never the worker,
 * it was only ever where the worker lived. Everything above this file - the
 * ladder, the resolvers, the analyzers, the evidence model - is unchanged,
 * because none of it knew what was hosting it.
 *
 * Cloud Run is here for one reason: yt-dlp and ffmpeg are binaries, and a
 * standard Cloud Functions image does not have them. Trying to force them in
 * is a fight; putting them in a container we control is one Dockerfile.
 *
 * Firebase still owns authentication, job creation, Firestore state and
 * billing. This service owns the heavy lifting and nothing else.
 */

const http = require('http');

const config = require('../config');
const { createLogger } = require('../logging');
const { runProcess } = require('../processRunner');
const { runWorkerJob } = require('../workerRuntime');
const { ERROR_CODES } = require('../errors');

const logger = createLogger();

const PORT = Number(process.env.PORT || 8080);

/**
 * Read the auth config at call time rather than at module load.
 *
 * A const captured at require() time makes the policy impossible to change in
 * a test and awkward to change in a reconfigured container. Reading it here
 * costs one property lookup per request, which is not what we are optimising.
 */
function sharedToken() {
  return process.env.RECIPE_IMPORT_WORKER_TOKEN || '';
}

function oidcAudience() {
  return process.env.RECIPE_IMPORT_WORKER_AUDIENCE || '';
}

/** Cached at startup. A version we cannot read is a version we cannot debug. */
const toolVersions = {
  node: process.version,
  ytDlp: null,
  ffmpeg: null,
  ffprobe: null,
  ytDlpError: null,
  ffmpegError: null,
};

async function readToolVersion(binary, args) {
  const result = await runProcess(binary, args, {
    timeoutMs: 15_000,
    maxBufferBytes: 256 * 1024,
  });
  if (result.missing) {
    throw new Error(`${binary} not found`);
  }
  if (result.code !== 0) {
    throw new Error(`${binary} exited ${result.code}`);
  }
  return String(result.stdout || result.stderr || '')
    .split('\n')[0]
    .trim();
}

/**
 * Report what is actually installed, at boot, loudly.
 *
 * When a yt-dlp extractor breaks on a Tuesday morning the first question is
 * "what version are we running", and the answer should be in the startup log
 * rather than something somebody has to exec into a container to find. A
 * missing binary is logged as an error at boot rather than discovered by a
 * user three hours later.
 */
async function logToolVersions() {
  try {
    toolVersions.ytDlp = await readToolVersion(config.YT_DLP_PATH, ['--version']);
  } catch (err) {
    toolVersions.ytDlpError = err.message;
    logger.error('worker_tool_missing', {
      tool: 'yt-dlp',
      path: config.YT_DLP_PATH,
      message: err.message,
    });
  }

  try {
    toolVersions.ffmpeg = await readToolVersion(config.FFMPEG_PATH, [
      '-version',
      '-hide_banner',
    ]);
  } catch (err) {
    toolVersions.ffmpegError = err.message;
    logger.error('worker_tool_missing', {
      tool: 'ffmpeg',
      path: config.FFMPEG_PATH,
      message: err.message,
    });
  }

  try {
    toolVersions.ffprobe = await readToolVersion(config.FFPROBE_PATH, [
      '-version',
      '-hide_banner',
    ]);
  } catch (err) {
    toolVersions.ffprobeError = err.message;
  }

  logger.info('worker_startup', {
    node: toolVersions.node,
    ytDlp: toolVersions.ytDlp,
    ffmpeg: toolVersions.ffmpeg,
    ffprobe: toolVersions.ffprobe,
    mediaToolingAvailable: config.MEDIA_TOOLING_AVAILABLE,
    videoAnalysisProvider: config.VIDEO_ANALYSIS_PROVIDER,
    directYouTubeEnabled: config.GEMINI_DIRECT_YOUTUBE_ENABLED,
    directYouTubeModel: config.GEMINI_DIRECT_YOUTUBE_MODEL,
    maxConcurrentJobs: config.MAX_CONCURRENT_JOBS_PER_INSTANCE,
    maxConcurrentPerPlatform: config.MEDIA_MAX_CONCURRENT_PER_PLATFORM,
    evidenceCacheEnabled: config.EVIDENCE_CACHE_ENABLED,
    tempRoot: config.TEMP_ROOT,
  });
}

function isAuthorized(req) {
  const token = sharedToken();
  if (token) {
    return req.headers['x-recipe-import-token'] === token;
  }
  if (oidcAudience()) {
    // Verified by Cloud Run's own IAM layer when the service is deployed with
    // `--no-allow-unauthenticated`. A Bearer token reaching us here means the
    // platform already checked it against the audience.
    return Boolean(req.headers.authorization);
  }
  // No auth configured. Only acceptable on a service that Cloud Run itself
  // is protecting; refuse otherwise so a misconfigured deploy is not also an
  // open endpoint.
  return false;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Lazily-created Firestore. Cloud Run supplies ADC; no key file in the image. */
let firestoreInstance = null;
function getDb() {
  if (firestoreInstance) return firestoreInstance;
  // eslint-disable-next-line global-require
  const admin = require('firebase-admin');
  // eslint-disable-next-line global-require
  const { getFirestore } = require('firebase-admin/firestore');

  // firebase-admin v11+ removed `admin.apps` and `admin.firestore` from the
  // root export. The supported accessors are `getApps()` and the
  // `firebase-admin/firestore` subpath - which is exactly what
  // functions/firebase.js already does. This file had drifted to the removed
  // form and threw on the first request that touched the database.
  if (admin.getApps().length === 0) {
    admin.initializeApp({
      projectId:
        process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || 'forkast-da914',
    });
  }
  firestoreInstance = getFirestore();
  return firestoreInstance;
}

async function handleRun(req, res) {
  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'unauthorized', code: 'UNAUTHORIZED' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (_err) {
    sendJson(res, 400, { error: 'invalid JSON body', code: 'INVALID_BODY' });
    return;
  }

  const jobId = String(body.jobId || '').trim();
  if (!jobId) {
    sendJson(res, 400, { error: 'jobId is required', code: 'MISSING_JOB_ID' });
    return;
  }

  logger.info('worker_job_received', { jobId });

  try {
    const result = await runWorkerJob(getDb(), jobId);
    sendJson(res, 200, { ok: true, jobId, completed: Boolean(result?.completed) });
  } catch (err) {
    const code = err?.code || ERROR_CODES.INTERNAL_ERROR;
    // A busy or already-claimed job is not an error in the worker; it is the
    // concurrency guard doing its job. 429 lets Cloud Run route the next
    // request to another instance instead of treating it as a crash.
    const status =
      code === ERROR_CODES.JOB_BUSY || code === ERROR_CODES.JOB_NOT_CLAIMABLE
        ? 429
        : code === ERROR_CODES.JOB_NOT_FOUND
          ? 404
          : 500;

    logger.warn('worker_job_rejected', { jobId, code, status, message: err?.message });
    // Expected failures (busy, not found, policy rejections) are fully
    // described by their code. An INTERNAL_ERROR is not: without the stack it
    // is a message with no location, and "Cannot read properties of
    // undefined" tells nobody where to look. Log the trace only for the
    // unexpected ones, so the signal is not buried under routine 429s.
    if (status === 500) {
      logger.error('worker_job_crashed', {
        jobId,
        message: err?.message,
        stack: (err?.stack || '').split('\n').slice(0, 12).join('\n'),
      });
    }
    sendJson(res, status, {
      ok: false,
      jobId,
      code,
      error: err?.message || 'worker failed',
      retryable: Boolean(err?.retryable),
    });
  }
}

function handleHealth(req, res) {
  const healthy = Boolean(toolVersions.ytDlp && toolVersions.ffmpeg);
  sendJson(res, healthy ? 200 : 503, {
    status: healthy ? 'ok' : 'degraded',
    ...toolVersions,
    mediaToolingAvailable: config.MEDIA_TOOLING_AVAILABLE,
    uptimeSeconds: Math.round(process.uptime()),
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/')) {
      handleHealth(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/version') {
      if (!isAuthorized(req)) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      sendJson(res, 200, toolVersions);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/run') {
      await handleRun(req, res);
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  });
}

async function main() {
  await logToolVersions();
  const server = createServer();
  server.listen(PORT, () => {
    logger.info('worker_listening', { port: PORT });
  });

  const shutdown = (signal) => {
    logger.info('worker_shutting_down', { signal });
    server.close(() => process.exit(0));
    // Cloud Run sends SIGTERM and expects a prompt exit. If a job is mid-ffmpeg
    // we do not want to hang past the platform's grace period with the temp
    // files still on disk, so force after a short window.
    setTimeout(() => process.exit(0), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('worker_startup_failed', { message: err?.message });
    process.exit(1);
  });
}

module.exports = {
  createServer,
  logToolVersions,
  toolVersions,
  isAuthorized,
  getDb,
  main,
};
