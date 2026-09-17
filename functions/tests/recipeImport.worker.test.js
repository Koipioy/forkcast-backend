'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { makeFakeFirestore } = require('./helpers/fakeFirestore');
const { JOB_STATUS, claimJob, createJob, getJob } = require('../recipeImport/jobStore');
const { createLogger } = require('../recipeImport/logging');
const { activeJobCount, processRecipeImportJob } = require('../recipeImport/worker');

function recordingLogger() {
  const events = [];
  const logger = createLogger((level, payload) => events.push(payload));
  logger.events = events;
  return logger;
}

const TIKTOK_THIN = {
  originalUrl: 'https://www.tiktok.com/@x/video/1',
  resolvedUrl: 'https://www.tiktok.com/@x/video/1',
  platform: 'tiktok',
  title: 'quick pasta',
  description: 'you need 200g pasta and 2 eggs',
  uploader: '@x',
  durationSeconds: 33,
  thumbnail: null,
  mediaType: 'video',
  isVideo: true,
  formats: [{ ext: 'mp4', height: 540, filesizeBytes: 8_000_000, vcodec: 'avc1', acodec: 'mp4a' }],
  resolver: 'yt-dlp',
};

function fakeChain(metadata) {
  const calls = { metadata: 0, video: 0 };
  return {
    calls,
    async resolveMetadata() {
      calls.metadata += 1;
      return metadata;
    },
    async resolveVideo(url, opts) {
      calls.video += 1;
      const file = path.join(opts.destDir, 'source.mp4');
      require('fs').writeFileSync(file, Buffer.alloc(1024, 9));
      return { path: file, bytes: 1024, mimeType: 'video/mp4', durationSeconds: metadata.durationSeconds };
    },
  };
}

function fakePreprocessor() {
  return {
    async probe() {
      return { durationSeconds: 33, width: 540, height: 960, bytes: 1024 };
    },
    async extractAudio(videoPath, opts) {
      const file = path.join(opts.destDir, 'audio.mp3');
      require('fs').writeFileSync(file, Buffer.alloc(256, 2));
      return { path: file, bytes: 256, mimeType: 'audio/mpeg' };
    },
    async extractFrames(videoPath, opts) {
      const frames = [];
      for (let i = 0; i < 2; i += 1) {
        const file = path.join(opts.destDir, `frame_${i}.jpg`);
        require('fs').writeFileSync(file, Buffer.alloc(64, i + 1));
        frames.push({ path: file, timestampSeconds: i * 2, index: i });
      }
      return { frames, plan: { intervalSeconds: 2, maxFrames: 2 }, strategy: 'interval' };
    },
  };
}

function fakeAnalyzer() {
  const { createEvidenceBundle, addIngredient, addInstruction } = require('../recipeImport/evidence');
  return {
    id: 'fake-analyzer',
    provider: 'google',
    async analyze() {
      const bundle = createEvidenceBundle({});
      addIngredient(bundle, '2 eggs', 'transcript', { timestampSeconds: 18 });
      addIngredient(bundle, '200g pasta', 'onscreen_text', { timestampSeconds: 4 });
      addInstruction(bundle, 'Boil the pasta', 'transcript', { timestampSeconds: 30 });
      return {
        evidence: bundle,
        transcriptText: 'boil the pasta and add two eggs',
        frameCount: 2,
        provider: 'google',
        model: 'gemini-3.7-flash',
        billing: { chargedMicros: 4321 },
      };
    },
  };
}

test('a job runs the ladder and is stored as succeeded with usable evidence', async () => {
  const db = makeFakeFirestore();
  const logger = recordingLogger();
  const chain = fakeChain(TIKTOK_THIN);

  const job = await createJob(db, {
    uid: 'user-1',
    url: TIKTOK_THIN.originalUrl,
    skipSufficiencyCheck: true,
  });

  const result = await processRecipeImportJob({
    jobId: job.id,
    db,
    logger,
    resolverChain: chain,
    preprocessor: fakePreprocessor(),
    analyzer: fakeAnalyzer(),
    meteredAICallFn: async (params) => params.runFn(),
  });

  assert.strictEqual(result.completed, true);

  const stored = await getJob(db, job.id);
  assert.strictEqual(stored.status, JOB_STATUS.SUCCEEDED);
  assert.strictEqual(stored.result.escalated, true);
  assert.strictEqual(stored.result.platform, 'tiktok');
  assert.strictEqual(stored.result.video.frameCount, 2);
  assert.strictEqual(stored.result.video.chargedMicros, 4321);
  assert.match(stored.result.evidenceText, /\[TRANSCRIPT @0:18\] 2 eggs/);
  assert.match(stored.result.evidenceText, /\[ONSCREEN_TEXT @0:04\] 200g pasta/);
  assert.ok(stored.metrics.durationMs >= 0);
});

test('the worker emits the documented stage events', async () => {
  const db = makeFakeFirestore();
  const logger = recordingLogger();
  const job = await createJob(db, {
    uid: 'u',
    url: TIKTOK_THIN.originalUrl,
    skipSufficiencyCheck: true,
  });

  await processRecipeImportJob({
    jobId: job.id,
    db,
    logger,
    resolverChain: fakeChain(TIKTOK_THIN),
    preprocessor: fakePreprocessor(),
    analyzer: fakeAnalyzer(),
    meteredAICallFn: async (params) => params.runFn(),
  });

  const names = logger.events.map((event) => event.event);
  for (const expected of [
    'recipe_import_started',
    'media_metadata_resolved',
    'video_download_started',
    'video_download_completed',
    'video_preprocessing_completed',
    'video_analysis_started',
    'video_analysis_completed',
    'evidence_merged',
    'recipe_import_completed',
  ]) {
    assert.ok(names.includes(expected), `missing stage event: ${expected}`);
  }
});

test('a failure is stored as a typed error and the job is not left running', async () => {
  const db = makeFakeFirestore();
  const logger = recordingLogger();
  const chain = fakeChain(TIKTOK_THIN);
  chain.resolveVideo = async () => {
    const err = new Error('download blew up');
    err.code = 'DOWNLOAD_FAILED';
    throw err;
  };

  const job = await createJob(db, {
    uid: 'u',
    url: TIKTOK_THIN.originalUrl,
    skipSufficiencyCheck: true,
  });

  await assert.rejects(
    () =>
      processRecipeImportJob({
        jobId: job.id,
        db,
        logger,
        resolverChain: chain,
        preprocessor: fakePreprocessor(),
        analyzer: fakeAnalyzer(),
        meteredAICallFn: async (params) => params.runFn(),
      }),
    (err) => err.code === 'DOWNLOAD_FAILED',
  );

  const stored = await getJob(db, job.id);
  assert.strictEqual(stored.status, JOB_STATUS.FAILED);
  assert.strictEqual(stored.error.code === 'DOWNLOAD_FAILED', true);
  assert.ok(logger.events.some((e) => e.event === 'recipe_import_failed'));
});

test('a succeeded job is not run again', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, { uid: 'u', url: TIKTOK_THIN.originalUrl, skipSufficiencyCheck: true });
  const deps = {
    db,
    logger: recordingLogger(),
    resolverChain: fakeChain(TIKTOK_THIN),
    preprocessor: fakePreprocessor(),
    analyzer: fakeAnalyzer(),
    meteredAICallFn: async (params) => params.runFn(),
  };
  await processRecipeImportJob({ jobId: job.id, ...deps });
  const second = await processRecipeImportJob({ jobId: job.id, ...deps });
  assert.strictEqual(second.alreadyCompleted, true);
});

test('one instance will not run two video jobs at once', async () => {
  const db = makeFakeFirestore();
  const jobA = await createJob(db, { uid: 'u', url: 'https://a.example/v', skipSufficiencyCheck: true });
  const jobB = await createJob(db, { uid: 'u', url: 'https://b.example/v', skipSufficiencyCheck: true });

  const slowChain = (delay) => ({
    async resolveMetadata() {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return TIKTOK_THIN;
    },
    async resolveVideo(url, opts) {
      const file = path.join(opts.destDir, 'source.mp4');
      require('fs').writeFileSync(file, Buffer.alloc(64, 1));
      return { path: file, bytes: 64, mimeType: 'video/mp4' };
    },
  });

  const deps = {
    db,
    logger: recordingLogger(),
    preprocessor: fakePreprocessor(),
    analyzer: fakeAnalyzer(),
    meteredAICallFn: async (params) => params.runFn(),
  };

  const first = processRecipeImportJob({ jobId: jobA.id, ...deps, resolverChain: slowChain(50) });
  await assert.rejects(
    () => processRecipeImportJob({ jobId: jobB.id, ...deps, resolverChain: slowChain(10) }),
    (err) => err.code === 'JOB_BUSY',
  );
  await first;
  assert.strictEqual(activeJobCount(), 0);
});

test('a disabled feature refuses the job', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, { uid: 'u', url: 'https://a.example/v' });
  const config = require('../recipeImport/config');
  const original = config.RECIPE_IMPORT_ENABLED;
  config.RECIPE_IMPORT_ENABLED = false;
  try {
    await assert.rejects(
      () => processRecipeImportJob({ jobId: job.id, db, logger: recordingLogger() }),
      (err) => err.code === 'FEATURE_DISABLED' || err.code === 'JOB_NOT_FOUND',
    );
  } finally {
    config.RECIPE_IMPORT_ENABLED = original;
  }
});

test('a job claimed by a live worker is refused', async () => {
  const db = makeFakeFirestore();
  const job = await createJob(db, { uid: 'u', url: 'https://a.example/v' });
  await claimJob(db, job.id, 'someone-else');
  await assert.rejects(
    () =>
      processRecipeImportJob({
        jobId: job.id,
        db,
        logger: recordingLogger(),
        resolverChain: fakeChain(TIKTOK_THIN),
      }),
    (err) => err.code === 'JOB_BUSY',
  );
});
