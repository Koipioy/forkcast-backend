'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { makeFakeFirestore } = require('./helpers/fakeFirestore');
const { createJob, getJob } = require('../recipeImport/jobStore');
const { createLogger } = require('../recipeImport/logging');
const { processRecipeImportJob } = require('../recipeImport/worker');
const { createEvidenceBundle, addIngredient, addInstruction } = require('../recipeImport/evidence');

function recordingLogger() {
  const events = [];
  const logger = createLogger((level, payload) => events.push(payload));
  logger.events = events;
  return logger;
}

const TIKTOK_THIN = {
  originalUrl: 'https://www.tiktok.com/@x/video/999',
  resolvedUrl: 'https://www.tiktok.com/@x/video/999',
  platform: 'tiktok',
  title: 'quick pasta',
  description: 'you need pasta',
  uploader: '@x',
  durationSeconds: 33,
  thumbnail: null,
  mediaType: 'video',
  isVideo: true,
  videoId: '999',
  formats: [{ ext: 'mp4', height: 540, filesizeBytes: 8_000_000, vcodec: 'avc1', acodec: 'mp4a' }],
  resolver: 'yt-dlp',
};

function countingChain(metadata, counters) {
  return {
    async resolveMetadata() {
      counters.metadata += 1;
      return metadata;
    },
    async resolveVideo(url, opts) {
      counters.video += 1;
      const file = path.join(opts.destDir, 'source.mp4');
      fs.writeFileSync(file, Buffer.alloc(1024, 9));
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
      fs.writeFileSync(file, Buffer.alloc(256, 2));
      return { path: file, bytes: 256, mimeType: 'audio/mpeg' };
    },
    async extractFrames(videoPath, opts) {
      const frames = [];
      for (let i = 0; i < 2; i += 1) {
        const file = path.join(opts.destDir, `frame_${i}.jpg`);
        fs.writeFileSync(file, Buffer.alloc(64, i + 1));
        frames.push({ path: file, timestampSeconds: i * 2, index: i });
      }
      return { frames, plan: { intervalSeconds: 2, maxFrames: 2 }, strategy: 'interval' };
    },
  };
}

function countingAnalyzer(counters) {
  return {
    id: 'fake-analyzer',
    provider: 'google',
    async analyze() {
      counters.analyses += 1;
      const bundle = createEvidenceBundle({});
      addIngredient(bundle, '2 eggs', 'transcript', { timestampSeconds: 18 });
      addIngredient(bundle, '200g pasta', 'onscreen_text', { timestampSeconds: 4 });
      addInstruction(bundle, 'Boil the pasta', 'transcript', { timestampSeconds: 30 });
      return {
        evidence: bundle,
        transcriptText: 'boil the pasta and add two eggs',
        frameCount: 2,
        provider: 'google',
        model: 'gemini-3.5-flash-lite',
        analyzer: 'fake-analyzer',
        billing: { chargedMicros: 4000 },
      };
    },
  };
}

test('SCENARIO 7: a second import of the same video is served from cache with no second model call', async () => {
  const db = makeFakeFirestore();
  const counters = { metadata: 0, video: 0, analyses: 0 };

  const deps = {
    logger: recordingLogger(),
    resolverChain: countingChain(TIKTOK_THIN, counters),
    preprocessor: fakePreprocessor(),
    analyzer: countingAnalyzer(counters),
    meteredAICall: async ({ runFn }) => ({ output: '', billing: { chargedMicros: 4000 }, ...(await runFn?.()) }),
    sleepFn: async () => {},
  };

  const jobA = await createJob(db, {
    uid: 'user-a',
    url: 'https://www.tiktok.com/@x/video/999',
    caption: 'yum',
    skipSufficiencyCheck: true,
  });
  await processRecipeImportJob({ jobId: jobA.id, db, ...deps });

  assert.strictEqual(counters.video, 1, 'first import downloads');
  assert.strictEqual(counters.analyses, 1, 'first import runs the model');

  const first = await getJob(db, jobA.id);
  assert.strictEqual(first.status, 'succeeded');
  assert.strictEqual(first.result.passes.videoPass, 1);
  assert.strictEqual(first.result.video.fromCache, false);

  // A different user, the same viral video.
  const jobB = await createJob(db, {
    uid: 'user-b',
    url: 'https://www.tiktok.com/@x/video/999?is_copy_links=1',
    caption: 'yum',
    skipSufficiencyCheck: true,
  });
  const loggerB = recordingLogger();
  await processRecipeImportJob({ jobId: jobB.id, db, logger: loggerB, ...deps, logger: loggerB });

  assert.strictEqual(counters.video, 1, 'second import must NOT download again');
  assert.strictEqual(counters.analyses, 1, 'second import must NOT call the model again');

  const second = await getJob(db, jobB.id);
  assert.strictEqual(second.status, 'succeeded');
  assert.strictEqual(second.result.video.fromCache, true);
  assert.strictEqual(second.result.passes.videoPass, 0, 'nothing was computed, so nothing is charged');
  assert.ok(loggerB.events.some((e) => e.event === 'media_cache_hit'));
});

test('a failed first import releases the key so the next one can try', async () => {
  const db = makeFakeFirestore();
  const counters = { metadata: 0, video: 0, analyses: 0 };

  const brokenChain = {
    async resolveMetadata() {
      counters.metadata += 1;
      return TIKTOK_THIN;
    },
    async resolveVideo(url, opts) {
      counters.video += 1;
      const err = new Error('download failed');
      err.code = 'DOWNLOAD_FAILED';
      throw err;
    },
  };

  const jobA = await createJob(db, {
    uid: 'user-a',
    url: 'https://www.tiktok.com/@x/video/999',
    caption: 'yum',
    skipSufficiencyCheck: true,
  });

  await assert.rejects(
    processRecipeImportJob({
      jobId: jobA.id,
      db,
      logger: recordingLogger(),
      resolverChain: brokenChain,
      preprocessor: fakePreprocessor(),
      analyzer: countingAnalyzer(counters),
      meteredAICall: async () => ({ output: '', billing: null }),
      sleepFn: async () => {},
    }),
  );

  const failed = await getJob(db, jobA.id);
  assert.strictEqual(failed.status, 'failed');

  // The key must not be left in_flight forever.
  const cache = require('../recipeImport/evidenceCache');
  const key = cache.canonicalCacheKey('https://www.tiktok.com/@x/video/999');
  const entry = await cache.cacheCollection(db).doc(key).get();
  assert.ok(entry.exists);
  assert.strictEqual(entry.data().status, 'abandoned');
});
