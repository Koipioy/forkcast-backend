'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeFakeFirestore } = require('./helpers/fakeFirestore');
const { JOB_STATUS, createJob, getJob } = require('../recipeImport/jobStore');
const { createLogger } = require('../recipeImport/logging');
const { processRecipeImportJob } = require('../recipeImport/worker');
const {
  createEvidenceBundle,
  addIngredient,
  addInstruction,
} = require('../recipeImport/evidence');

function recordingLogger() {
  const events = [];
  const logger = createLogger((level, payload) => events.push(payload));
  logger.events = events;
  return logger;
}

/** A resolver whose metadata probe fails, exactly like YouTube from a datacenter IP. */
function brokenChain() {
  return {
    async resolveMetadata() {
      const err = new Error('yt-dlp metadata resolution failed');
      err.code = 'MEDIA_RESOLUTION_FAILED';
      throw err;
    },
    async resolveVideo() {
      throw new Error('must not download when metadata failed');
    },
  };
}

function directAnalyzerReturningRecipe() {
  return {
    model: 'gemini-3.5-flash-lite',
    mediaResolution: 'high',
    async analyze() {
      const bundle = createEvidenceBundle({});
      addIngredient(bundle, 'chicken breast', 'transcript', { timestampSeconds: 8 });
      addIngredient(bundle, 'cream', 'transcript', { timestampSeconds: 15 });
      addInstruction(bundle, 'Simmer everything together', 'transcript', { timestampSeconds: 16 });
      return {
        evidence: bundle,
        transcriptText: 'season the chicken, add cream, simmer',
        frameCount: 0,
        provider: 'google',
        model: 'gemini-3.5-flash-lite',
        billing: { chargedMicros: 990 },
        directUrl: true,
      };
    },
  };
}

test('platform survives a failed metadata probe because the URL still says what it is', async () => {
  const db = makeFakeFirestore();
  const logger = recordingLogger();

  const job = await createJob(db, {
    uid: 'user-1',
    url: 'https://www.youtube.com/shorts/OJDyl16MZM4',
    skipSufficiencyCheck: true,
  });

  await processRecipeImportJob({
    jobId: job.id,
    db,
    logger,
    resolverChain: brokenChain(),
    directAnalyzer: directAnalyzerReturningRecipe(),
    // Explicit opt-in: shouldUseDirectYouTube otherwise requires a live
    // GEMINI_API_KEY, which a unit test does not have.
    allowDirectYouTube: true,
    meteredAICallFn: async (params) => params.runFn(),
  });

  const stored = await getJob(db, job.id);
  assert.strictEqual(stored.status, JOB_STATUS.SUCCEEDED);
  assert.strictEqual(
    stored.result.platform,
    'youtube',
    'a null media object must not erase the platform of a video we just analysed',
  );
  assert.strictEqual(stored.result.media, null, 'media really is absent here');
  assert.ok(
    (stored.result.evidence.ingredientCandidates || []).length >= 2,
    'the direct path still produced the recipe',
  );
});

test('the completed log line carries the derived platform too', async () => {
  const db = makeFakeFirestore();
  const logger = recordingLogger();
  const job = await createJob(db, {
    uid: 'u',
    url: 'https://youtu.be/jNQXAC9IVRw',
    skipSufficiencyCheck: true,
  });

  await processRecipeImportJob({
    jobId: job.id,
    db,
    logger,
    resolverChain: brokenChain(),
    directAnalyzer: directAnalyzerReturningRecipe(),
    // Explicit opt-in: shouldUseDirectYouTube otherwise requires a live
    // GEMINI_API_KEY, which a unit test does not have.
    allowDirectYouTube: true,
    meteredAICallFn: async (params) => params.runFn(),
  });

  const done = logger.events.find((e) => e.event === 'recipe_import_completed');
  assert.ok(done, 'recipe_import_completed should have been logged');
  assert.strictEqual(done.platform, 'youtube');
});
