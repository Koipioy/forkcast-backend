'use strict';

/**
 * Worker runtime seam.
 *
 * The Firebase trigger calls `runWorkerJob(db, jobId)`. That is the only thing
 * that knows the worker is running inside a Cloud Function. Moving the worker to
 * Cloud Run means replacing this one file - and the recipe logic in worker.js,
 * service.js and the analyzers does not move with it.
 */

const { db: defaultDb } = require('../firebase');
const { logger } = require('./logging');
const { processRecipeImportJob } = require('./worker');

/**
 * @param {object} db Firestore instance (injectable for tests)
 * @param {string} jobId
 * @param {object} [overrides] extra deps (resolverChain, analyzer, callLLM, ...)
 */
async function runWorkerJob(db, jobId, overrides = {}) {
  return processRecipeImportJob({
    jobId,
    db: db || defaultDb,
    logger,
    ...overrides,
  });
}

module.exports = { runWorkerJob };
