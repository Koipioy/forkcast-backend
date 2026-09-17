'use strict';

/**
 * Recipe import: public surface.
 *
 * Everything the rest of the backend needs comes from here. The Firebase
 * function layer in ../index.js imports this module and never reaches into
 * yt-dlp, ffmpeg or a provider SDK directly.
 */

const config = require('./config');
const errors = require('./errors');
const evidence = require('./evidence');
const jobStore = require('./jobStore');
const logging = require('./logging');
const mediaResolver = require('./mediaResolver');
const meteredAI = require('./meteredAI');
const processRunner = require('./processRunner');
const service = require('./service');
const sufficiency = require('./sufficiency');
const tempWorkspace = require('./tempWorkspace');
const urlGuard = require('./urlGuard');
const videoPreprocessor = require('./videoPreprocessor');
const mediaRetry = require('./mediaRetry');
const evidenceCache = require('./evidenceCache');
const analyzers = require('./analyzers');
const worker = require('./worker');

module.exports = {
  // Config and policy
  config,
  sufficiency,

  // Safety
  urlGuard,

  // Media
  mediaResolver,
  videoPreprocessor,
  tempWorkspace,
  processRunner,
  mediaRetry,
  evidenceCache,

  // Evidence model
  evidence,

  // Providers
  analyzers,
  meteredAI,

  // Orchestration
  service,
  worker,
  jobStore,
  logging,

  // Re-exports for convenience
  ERROR_CODES: errors.ERROR_CODES,
  RecipeImportError: errors.RecipeImportError,
  toRecipeImportError: errors.toRecipeImportError,
  extractRecipeFromUrl: service.extractRecipeFromUrl,
  collectMediaEvidence: service.collectMediaEvidence,
  analyzeVideoEvidence: service.analyzeVideoEvidence,
  processRecipeImportJob: worker.processRecipeImportJob,
  STAGES: logging.STAGES,
  JOB_STATUS: jobStore.JOB_STATUS,
};
