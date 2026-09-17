'use strict';

/**
 * The heavy worker.
 *
 * Deliberately free of any Firebase trigger wiring: it takes a job id and a set
 * of injected dependencies, and that is all it knows. Today it is called by a
 * Firestore background function; tomorrow it can be called by a Cloud Run
 * container that pulls jobs off a queue, and nothing in the recipe logic moves.
 *
 * The in-process concurrency guard exists because ffmpeg and yt-dlp are CPU and
 * disk hogs. Two concurrent video jobs on one 1GB instance is a good way to
 * make both of them fail, so the default is one at a time per instance.
 */

const os = require('os');
const crypto = require('crypto');

const config = require('./config');
const { logger: defaultLogger } = require('./logging');
const { JobBusyError, JobNotFoundError, toRecipeImportError } = require('./errors');
const { extractRecipeFromUrl } = require('./service');
const { evidenceToText, summarizeEvidence } = require('./evidence');
const {
  JOB_STATUS,
  claimJob,
  completeJob,
  failJob,
  getJob,
  setStage,
} = require('./jobStore');
const { meteredAICall } = require('./meteredAI');
const { canonicalCacheKey } = require('./evidenceCache');
const { platformOfUrl } = require('./mediaResolver');

/** Per-instance running-job counter. */
let runningJobs = 0;

function activeJobCount() {
  return runningJobs;
}

function workerId() {
  return `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * @param {{jobId: string, db: object, logger?: object, resolverChain?: object,
 *          analyzer?: object, callLLM?: Function, transcribeFn?: Function,
 *          meteredAICallFn?: Function}} params
 */
async function processRecipeImportJob(params) {
  const { jobId, db } = params;
  const logger = params.logger || defaultLogger;
  const startedAt = Date.now();

  if (!config.RECIPE_IMPORT_ENABLED) {
    throw new JobNotFoundError('Recipe import is disabled.', { jobId });
  }

  // The slot is taken synchronously, before the first await. Checking the
  // counter and then awaiting anything before incrementing it lets two jobs
  // both see "zero running" and both start ffmpeg.
  if (runningJobs >= config.MAX_CONCURRENT_JOBS_PER_INSTANCE) {
    throw new JobBusyError(
      'This worker is already at its concurrency limit.',
      { runningJobs, limit: config.MAX_CONCURRENT_JOBS_PER_INSTANCE },
    );
  }
  runningJobs += 1;

  try {
    return await runJob({ jobId, db, logger, params });
  } finally {
    runningJobs = Math.max(0, runningJobs - 1);
  }
}

async function runJob({ jobId, db, logger, params }) {
  const job = await getJob(db, jobId);
  if (!job) throw new JobNotFoundError('Job not found.', { jobId });
  if (job.status === JOB_STATUS.SUCCEEDED) {
    return { alreadyCompleted: true, job };
  }

  const claim = await claimJob(db, jobId, workerId());
  if (!claim.claimed) {
    throw new JobBusyError(`Job is not claimable (${claim.reason}).`, {
      jobId,
      claimReason: claim.reason,
    });
  }

  const startedAt = Date.now();
  logger.info('recipe_import_started', {
    jobId,
    url: job.url,
    attempt: job.attempts,
    userId: job.userId,
    skipSufficiencyCheck: Boolean(job.request?.skipSufficiencyCheck),
  });

  try {
    await setStage(db, jobId, 'resolving_media');

    const result = await extractRecipeFromUrl(job.url, {
      jobId,
      logger,
      db,
      // Canonical key so the same video pasted in three different forms is
      // resolved once. Null for URLs that must not be shared.
      cacheKey: canonicalCacheKey(job.url),
      pageText: job.request?.pageText || null,
      caption: job.request?.caption || null,
      structuredRecipe: job.request?.structuredRecipe || null,
      videoFile: job.request?.videoFile || null,
      skipSufficiencyCheck: Boolean(job.request?.skipSufficiencyCheck),
      uid: job.userId,
      email: job.email || null,
      provider: job.request?.provider || undefined,
      model: job.request?.model || undefined,
      resolverChain: params.resolverChain,
      preprocessor: params.preprocessor,
      analyzer: params.analyzer,
      // The direct-URL path is normally resolved internally from configuration,
      // which a unit test cannot do without live provider keys. Forwarding these
      // lets a test inject an analyzer and opt in explicitly.
      directAnalyzer: params.directAnalyzer,
      allowDirectYouTube: params.allowDirectYouTube,
      callLLM: params.callLLM,
      transcribeFn: params.transcribeFn,
      meteredAICall: params.meteredAICallFn || meteredAICall,
      sleepFn: params.sleepFn,
    });

    await setStage(db, jobId, 'normalizing');

    // The yt-dlp metadata probe can fail outright - YouTube blocks datacenter
    // IPs hard - which leaves result.media null. That must not erase the
    // platform: the URL still says where it points, and the direct-URL analyzer
    // can succeed with no metadata at all. Falling back to the host keeps
    // provenance intact instead of reporting "unknown" for a video we just
    // analysed.
    const platform = result.media?.platform || platformOfUrl(job.url) || null;

    const payload = {
      escalated: result.escalated,
      platform,
      media: result.media
        ? {
            platform: result.media.platform,
            title: result.media.title,
            uploader: result.media.uploader || null,
            durationSeconds: result.media.durationSeconds,
            isVideo: result.media.isVideo,
          }
        : null,
      sufficiency: result.sufficiency,
      evidence: result.evidence,
      evidenceText: evidenceToText(result.evidence, {
        maxChars: config.MAX_EVIDENCE_PROMPT_CHARS,
      }),
      video: result.videoResult
        ? {
            analyzer: result.videoResult.analyzer,
            provider: result.videoResult.provider,
            model: result.videoResult.model,
            frameCount: result.videoResult.frameCount,
            transcriptChars: result.videoResult.transcriptText
              ? result.videoResult.transcriptText.length
              : 0,
            chargedMicros: result.videoResult.billing?.chargedMicros ?? null,
            // Which of the two video paths produced this, and whether any bytes
            // crossed our network doing it.
            directUrl: Boolean(result.videoResult.directUrl),
            fromCache: Boolean(result.videoResult.fromCache),
            processingMode: result.videoResult.processingMode ?? null,
            mediaResolution: result.videoResult.mediaResolution ?? null,
            downloadBytes: result.videoResult.downloadBytes ?? null,
          }
        : null,
      // Pass accounting. The first pass is the app's own extraction over page
      // text; the second is the one this job just paid for. Both are metered
      // where a model ran, so the totals can be reconciled against billing.
      passes: {
        textPass: 1,
        videoPass: result.videoResult && !result.videoResult.fromCache ? 1 : 0,
        servedFromCache: Boolean(result.videoResult?.fromCache),
      },
    };

    await completeJob(db, jobId, payload, {
      durationMs: Date.now() - startedAt,
      escalated: result.escalated,
      evidenceSummary: summarizeEvidence(result.evidence),
    });

    logger.info('recipe_import_completed', {
      jobId,
      escalated: result.escalated,
      platform,
      durationMs: Date.now() - startedAt,
      evidence: summarizeEvidence(result.evidence),
    });

    return { completed: true, jobId, result: payload };
  } catch (err) {
    const typed = toRecipeImportError(err);
    await failJob(db, jobId, typed);
    logger.error('recipe_import_failed', {
      jobId,
      code: typed.code,
      retryable: typed.retryable,
      message: typed.message,
      durationMs: Date.now() - startedAt,
    });
    throw typed;
  }
}

module.exports = {
  processRecipeImportJob,
  activeJobCount,
  workerId,
};
