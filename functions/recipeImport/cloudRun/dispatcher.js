'use strict';

/**
 * Hand a job to the Cloud Run worker.
 *
 * Firebase keeps the parts it is good at - authentication, job creation,
 * Firestore state, billing - and Cloud Run does the part that needs yt-dlp
 * and ffmpeg installed in the image. This module is the hand-off.
 *
 * The dispatch is fire-and-forget from the client's point of view: the caller
 * gets its job id back immediately and polls Firestore, which the worker
 * writes to. If the dispatch fails and the Firestore trigger is still
 * enabled, the trigger picks the job up anyway. That double safety net is
 * deliberate: a Cloud Run cold-start or a bad URL in RECIPE_IMPORT_WORKER_URL
 * should slow imports down, not stop them.
 */

const config = require('../config');
const { logger: defaultLogger } = require('../logging');

function trimSlash(value) {
  return String(value).replace(/\/+$/, '');
}

/**
 * Build the auth header for the worker.
 *
 * Two options, in preference order. A shared secret is the simplest thing
 * that works and needs no IAM setup. A service-account ID token is the proper
 * GCP answer and is preferred when the runtime can produce one, because it
 * expires on its own and is scoped to the audience.
 */
async function buildAuthHeaders(options = {}) {
  const sharedSecret =
    options.sharedSecret ?? process.env.RECIPE_IMPORT_WORKER_TOKEN ?? '';
  if (sharedSecret) {
    return { 'x-recipe-import-token': sharedSecret };
  }

  const serviceAccount =
    options.serviceAccount ??
    process.env.RECIPE_IMPORT_WORKER_SERVICE_ACCOUNT ??
    '';

  if (!serviceAccount) return {};

  try {
    // Resolved lazily: the module is only needed when OIDC is configured, and
    // requiring it unconditionally would tie every test run to it.
    // eslint-disable-next-line global-require
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
      scopes: 'https://www.googleapis.com/auth/cloud-platform',
    });
    const client = await auth.getIdTokenClient(serviceAccount);
    const token = await client.getIdToken();
    return { Authorization: `Bearer ${token.token}` };
  } catch (err) {
    return {
      'x-recipe-import-oidc-error': String(err?.message || 'oidc_unavailable').slice(0, 120),
    };
  }
}

/**
 * Is a Cloud Run worker configured at all?
 *
 * When this is false the whole feature falls back to the Firestore trigger,
 * which is what ran before Cloud Run existed.
 */
function isWorkerConfigured() {
  return Boolean(config.WORKER_URL);
}

/**
 * @param {{jobId: string, url?: string, logger?: object, fetchImpl?: Function}} params
 * @returns {Promise<{dispatched: boolean, reason?: string, status?: number}>}
 */
async function dispatchJobToCloudRun(params) {
  const logger = params.logger || defaultLogger;
  const { jobId } = params;

  if (!isWorkerConfigured()) {
    return { dispatched: false, reason: 'worker_not_configured' };
  }

  const endpoint = `${trimSlash(config.WORKER_URL)}/run`;

  let headers = {};
  try {
    headers = await buildAuthHeaders(params);
  } catch (err) {
    logger.warn('recipe_import_worker_auth_failed', {
      jobId,
      message: err?.message,
    });
  }

  const fetchImpl = params.fetchImpl || fetch;
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout
        ? AbortSignal.timeout(config.WORKER_DISPATCH_TIMEOUT_MS)
        : undefined,
    });

    if (response.ok) {
      logger.info('recipe_import_worker_dispatched', {
        jobId,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return { dispatched: true, status: response.status };
    }

    const body = await response.text().catch(() => '');
    logger.error('recipe_import_worker_dispatch_failed', {
      jobId,
      status: response.status,
      body: body.slice(0, 300),
      durationMs: Date.now() - startedAt,
      fallback: config.WORKER_FIRESTORE_TRIGGER_ENABLED
        ? 'firestore_trigger'
        : 'none',
    });
    return { dispatched: false, reason: 'http_error', status: response.status };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const timedOut =
      /timeout|abort/i.test(String(err?.name || '')) ||
      /timeout|abort/i.test(String(err?.message || ''));

    // The worker claims the job synchronously before it starts any expensive
    // work, so a dispatch timeout means WE stopped listening - not that the job
    // is stranded. A real import runs far longer than the dispatch timeout, so
    // without this check every successful import logs an error and the genuine
    // "worker never received it" signal is buried in routine noise.
    if (timedOut && (await wasJobClaimed(params.db, jobId, logger))) {
      logger.info('recipe_import_worker_dispatch_timeout_but_claimed', {
        jobId,
        durationMs,
        note: 'worker claimed the job; the dispatch timeout only ended our wait',
      });
      return { dispatched: true, reason: 'claimed_after_timeout' };
    }

    // A timeout with no claim yet is still not proof of failure - a Cloud Run
    // cold start can outlast the dispatch window and the worker will claim the
    // job when it comes up. Warn rather than error, and let the client's own
    // poll surface a genuinely stuck job.
    const log = timedOut ? logger.warn.bind(logger) : logger.error.bind(logger);
    log('recipe_import_worker_dispatch_error', {
      jobId,
      message: err?.message,
      timedOut,
      durationMs,
      fallback: config.WORKER_FIRESTORE_TRIGGER_ENABLED
        ? 'firestore_trigger'
        : 'none',
    });
    return { dispatched: false, reason: timedOut ? 'timeout' : 'network_error' };
  }
}

/**
 * Did the worker claim this job?
 *
 * Best-effort diagnostic. A read failure is not treated as "unclaimed" - we
 * simply fall back to the less certain log line rather than inventing a failure.
 */
async function wasJobClaimed(db, jobId, logger) {
  if (!db || !jobId) return false;
  try {
    const { getJob } = require('../jobStore');
    const job = await getJob(db, jobId);
    return Boolean(job && job.claimedBy);
  } catch (err) {
    logger.warn('recipe_import_worker_claim_check_failed', {
      jobId,
      message: err?.message,
    });
    return false;
  }
}

module.exports = {
  isWorkerConfigured,
  dispatchJobToCloudRun,
  buildAuthHeaders,
};
