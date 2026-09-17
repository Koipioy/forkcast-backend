'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  analyzeVideoEvidence,
  collectMediaEvidence,
  extractRecipeFromUrl,
  isSocialPlatform,
} = require('../recipeImport/service');
const { createLogger } = require('../recipeImport/logging');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-service-test-'));

function recordingLogger() {
  const events = [];
  const logger = createLogger((level, payload) => events.push(payload));
  logger.events = events;
  return logger;
}

function fakeChain(metadata, options = {}) {
  const calls = { metadata: 0, video: 0 };
  return {
    calls,
    async resolveMetadata() {
      calls.metadata += 1;
      if (options.metadataError) throw options.metadataError;
      return metadata;
    },
    async resolveVideo(url, opts) {
      calls.video += 1;
      if (options.videoError) throw options.videoError;
      const file = path.join(opts.destDir, 'source.mp4');
      fs.writeFileSync(file, Buffer.alloc(2048, 5));
      return { path: file, bytes: 2048, mimeType: 'video/mp4', durationSeconds: metadata.durationSeconds };
    },
  };
}

function fakeAnalyzer(evidence, calls) {
  return {
    id: 'fake-analyzer',
    provider: 'google',
    async analyze() {
      calls.analyzed += 1;
      return {
        evidence,
        transcriptText: 'add two eggs and boil the pasta',
        frameCount: 4,
        provider: 'google',
        model: 'gemini-3.7-flash',
        billing: { chargedMicros: 5000 },
      };
    },
  };
}

function videoEvidenceFixture() {
  const { createEvidenceBundle, addIngredient, addInstruction } = require('../recipeImport/evidence');
  const bundle = createEvidenceBundle({});
  addIngredient(bundle, '2 eggs', 'transcript', { timestampSeconds: 18 });
  addIngredient(bundle, '200g pasta', 'onscreen_text', { timestampSeconds: 4 });
  addInstruction(bundle, 'Boil the pasta for 10 minutes', 'transcript', { timestampSeconds: 30 });
  addInstruction(bundle, 'Toss with the eggs', 'visual_observation', { timestampSeconds: 45 });
  return bundle;
}

function fakePreprocessor() {
  return {
    async probe() {
      return { durationSeconds: 33, width: 540, height: 960, bytes: 2048 };
    },
    async extractAudio(videoPath, opts) {
      const file = require('path').join(opts.destDir, 'audio.mp3');
      require('fs').writeFileSync(file, Buffer.alloc(512, 1));
      return { path: file, bytes: 512, mimeType: 'audio/mpeg' };
    },
    async extractFrames(videoPath, opts) {
      const frames = [];
      for (let i = 0; i < 3; i += 1) {
        const file = require('path').join(opts.destDir, `frame_${i}.jpg`);
        require('fs').writeFileSync(file, Buffer.alloc(128, i + 1));
        frames.push({ path: file, timestampSeconds: i * 2, index: i });
      }
      return { frames, plan: { intervalSeconds: 2, maxFrames: 3 }, strategy: 'interval' };
    },
  };
}

const YT_WITH_FULL_RECIPE = {
  originalUrl: 'https://youtu.be/x',
  resolvedUrl: 'https://www.youtube.com/watch?v=x',
  platform: 'youtube',
  title: 'Creamy Garlic Pasta',
  description:
    'Ingredients\n200g pasta\n3 cloves garlic\n100ml cream\n2 tbsp butter\n\nMethod\n1. Boil the pasta.\n2. Fry the garlic in butter.\n3. Add cream and simmer.\n4. Toss through and serve.',
  uploader: 'Chef',
  durationSeconds: 421,
  thumbnail: null,
  mediaType: 'video',
  isVideo: true,
  formats: [{ ext: 'mp4', height: 720, filesizeBytes: 50_000_000, vcodec: 'avc1', acodec: null }],
  resolver: 'yt-dlp',
};

const TIKTOK_THIN_CAPTION = {
  originalUrl: 'https://tk/1',
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

test('a structured recipe from the page means the video is never downloaded', async () => {
  const chain = fakeChain(YT_WITH_FULL_RECIPE);
  const calls = { analyzed: 0 };

  const result = await extractRecipeFromUrl('https://allrecipes.example/pasta', {
    structuredRecipe: {
      title: 'Baked Ziti',
      ingredients: ['1 lb ziti', '24 oz sauce', '2 cups mozzarella', '1 egg'],
      instructions: ['Cook the ziti.', 'Layer with sauce and cheese.', 'Bake 40 minutes.'],
      servings: 8,
    },
    resolverChain: chain,
    analyzer: fakeAnalyzer(videoEvidenceFixture(), calls),
    logger: recordingLogger(),
  });

  assert.strictEqual(result.escalated, false);
  assert.strictEqual(chain.calls.video, 0, 'video must not be downloaded');
  assert.strictEqual(calls.analyzed, 0, 'no model must be invoked');
  assert.strictEqual(result.sufficiency.sufficient, true);
  // Structured provenance is retained.
  const sources = result.evidence.ingredientCandidates.map((i) => i.source);
  assert.ok(sources.includes('structured_recipe'));
});

test('a full recipe in the video description is enough without downloading', async () => {
  const chain = fakeChain(YT_WITH_FULL_RECIPE);
  const calls = { analyzed: 0 };

  const result = await extractRecipeFromUrl(YT_WITH_FULL_RECIPE.originalUrl, {
    resolverChain: chain,
    analyzer: fakeAnalyzer(videoEvidenceFixture(), calls),
    logger: recordingLogger(),
  });

  assert.strictEqual(result.escalated, false);
  assert.strictEqual(chain.calls.video, 0);
  assert.strictEqual(calls.analyzed, 0);
  assert.strictEqual(result.evidence.sourceMetadata.platform, 'youtube');
});

test('a caption with ingredients but no steps escalates to the video', async () => {
  const chain = fakeChain(TIKTOK_THIN_CAPTION);
  const calls = { analyzed: 0 };

  const result = await extractRecipeFromUrl(TIKTOK_THIN_CAPTION.originalUrl, {
    resolverChain: chain,
    preprocessor: fakePreprocessor(),
    analyzer: fakeAnalyzer(videoEvidenceFixture(), calls),
    meteredAICall: async (params) => params.runFn(),
    logger: recordingLogger(),
  });

  // The caption has ingredients but no instructions, so it must escalate.
  assert.strictEqual(result.sufficiency.sufficient, false);
  assert.ok(result.sufficiency.missing.includes('instructions'));
  assert.strictEqual(calls.analyzed, 1);
  assert.strictEqual(result.escalated, true);

  // The caption travels as raw text with its own provenance; the video's spoken
  // and on-screen ingredients arrive in the ingredient channel. The recipe
  // parser reads both, and can tell them apart.
  const instructionSources = result.evidence.instructionCandidates.map((i) => i.source);
  assert.ok(instructionSources.includes('caption'), 'caption text must survive with provenance');
  const ingredientSources = result.evidence.ingredientCandidates.map((i) => i.source);
  assert.ok(ingredientSources.includes('transcript'), 'spoken ingredients must be tagged');
  assert.ok(ingredientSources.includes('onscreen_text'), 'on-screen ingredients must be tagged');

  const evidenceText = require('../recipeImport/evidence').evidenceToText(result.evidence);
  assert.match(evidenceText, /\[CAPTION\] you need 200g pasta and 2 eggs/);
  assert.match(evidenceText, /\[TRANSCRIPT @0:18\] 2 eggs/);
});

test('a social URL with no useful caption escalates', async () => {
  const noCaption = { ...TIKTOK_THIN_CAPTION, description: '🔥🔥🔥 #food' };
  const chain = fakeChain(noCaption);
  const calls = { analyzed: 0 };

  const result = await extractRecipeFromUrl(noCaption.originalUrl, {
    resolverChain: chain,
    preprocessor: fakePreprocessor(),
    analyzer: fakeAnalyzer(videoEvidenceFixture(), calls),
    meteredAICall: async (params) => params.runFn(),
    logger: recordingLogger(),
  });

  assert.strictEqual(result.escalated, true);
  assert.strictEqual(calls.analyzed, 1);
});

test('a resolver failure does not kill an import that already has a recipe', async () => {
  const metadataError = Object.assign(new Error('yt-dlp broke'), { code: 'MEDIA_RESOLUTION_FAILED' });
  const chain = fakeChain(null, { metadataError });
  const calls = { analyzed: 0 };

  const result = await extractRecipeFromUrl('https://allrecipes.example/pasta', {
    structuredRecipe: {
      title: 'Soup',
      ingredients: ['1 onion', '2 carrots', '1L stock'],
      instructions: ['Chop.', 'Simmer 30 min.'],
    },
    resolverChain: chain,
    analyzer: fakeAnalyzer(videoEvidenceFixture(), calls),
    logger: recordingLogger(),
  });

  assert.strictEqual(result.escalated, false);
  assert.strictEqual(result.media, null);
  assert.strictEqual(calls.analyzed, 0);
  assert.strictEqual(result.evidence.ingredientCandidates.length, 3);
});

test('a video over the duration cap is rejected before any model call', async () => {
  const longVideo = { ...TIKTOK_THIN_CAPTION, durationSeconds: 3600 };
  const chain = fakeChain(longVideo);
  const calls = { analyzed: 0 };

  await assert.rejects(
    () =>
      extractRecipeFromUrl(longVideo.originalUrl, {
        resolverChain: chain,
        analyzer: fakeAnalyzer(videoEvidenceFixture(), calls),
        meteredAICall: async (params) => params.runFn(),
        logger: recordingLogger(),
      }),
    (err) => err.code === 'VIDEO_TOO_LONG' && err.retryable === false,
  );
  assert.strictEqual(chain.calls.video, 0, 'must reject before downloading');
  assert.strictEqual(calls.analyzed, 0, 'must reject before paying for AI');
});

test('an oversized video is rejected cleanly', async () => {
  const huge = {
    ...TIKTOK_THIN_CAPTION,
    formats: [{ ext: 'mp4', height: 1080, filesizeBytes: 900_000_000, vcodec: 'avc1', acodec: 'mp4a' }],
  };
  const chain = fakeChain(huge);
  const calls = { analyzed: 0 };

  await assert.rejects(
    () =>
      extractRecipeFromUrl(huge.originalUrl, {
        resolverChain: chain,
        analyzer: fakeAnalyzer(videoEvidenceFixture(), calls),
        meteredAICall: async (params) => params.runFn(),
        logger: recordingLogger(),
      }),
    (err) => err.code === 'VIDEO_TOO_LARGE',
  );
  assert.strictEqual(calls.analyzed, 0);
});

test('a non-video media type never enters the video path', async () => {
  const audio = { ...TIKTOK_THIN_CAPTION, isVideo: false, mediaType: 'audio' };
  const chain = fakeChain(audio);
  const calls = { analyzed: 0 };

  const result = await extractRecipeFromUrl(audio.originalUrl, {
    resolverChain: chain,
    analyzer: fakeAnalyzer(videoEvidenceFixture(), calls),
    logger: recordingLogger(),
  });
  assert.strictEqual(result.escalated, false);
  assert.strictEqual(result.reason, 'no_video_to_analyze');
  assert.strictEqual(calls.analyzed, 0);
});

test('analyzeVideoEvidence removes its temp workspace even when the model fails', async () => {
  const chain = fakeChain(TIKTOK_THIN_CAPTION);
  const before = fs.existsSync(tmpRoot) ? fs.readdirSync(tmpRoot).length : 0;

  await assert.rejects(
    () =>
      analyzeVideoEvidence(TIKTOK_THIN_CAPTION.originalUrl, {
        jobId: 'cleanup-test',
        resolverChain: chain,
        preprocessor: fakePreprocessor(),
        media: TIKTOK_THIN_CAPTION,
        analyzer: {
          id: 'boom',
          async analyze() {
            throw new Error('model exploded');
          },
        },
        logger: recordingLogger(),
      }),
    /model exploded/,
  );

  // The job's own scratch directory must be gone afterwards.
  const leftovers = fs
    .readdirSync(require('../recipeImport/config').TEMP_ROOT)
    .filter((name) => name.startsWith('cleanup-test'));
  assert.deepStrictEqual(leftovers, [], 'temp files must be cleaned after a model failure');
  assert.ok(before >= 0);
});

test('collectMediaEvidence tags a social caption as caption, not description', async () => {
  const chain = fakeChain(TIKTOK_THIN_CAPTION);
  const { evidence } = await collectMediaEvidence(TIKTOK_THIN_CAPTION.originalUrl, {
    resolverChain: chain,
    logger: recordingLogger(),
  });
  const sources = evidence.instructionCandidates.map((i) => i.source);
  assert.ok(sources.includes('caption'));
  assert.strictEqual(evidence.titleCandidates[0].source, 'title');
});

test('isSocialPlatform distinguishes social hosts from youtube', () => {
  assert.strictEqual(isSocialPlatform('instagram'), true);
  assert.strictEqual(isSocialPlatform('tiktok'), true);
  assert.strictEqual(isSocialPlatform('pinterest'), true);
  assert.strictEqual(isSocialPlatform('youtube'), false);
});

test('cleanup', () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
