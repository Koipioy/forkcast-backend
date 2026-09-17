'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  GeminiYouTubeDirectAnalyzer,
  isDirectYouTubeUrl,
  canonicalizeYouTubeUrl,
  extractResponseText,
  resolveProcessingMode,
} = require('../recipeImport/analyzers/geminiYouTubeDirect');
const { extractRecipeFromUrl } = require('../recipeImport/service');
const { createLogger } = require('../recipeImport/logging');
const { createEvidenceBundle, addIngredient, addInstruction } = require('../recipeImport/evidence');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ytdirect-test-'));

function recordingLogger() {
  const events = [];
  const logger = createLogger((level, payload) => events.push(payload));
  logger.events = events;
  return logger;
}

function youtubeMetadata(overrides = {}) {
  return {
    originalUrl: 'https://www.youtube.com/watch?v=abc123',
    resolvedUrl: 'https://www.youtube.com/watch?v=abc123',
    platform: 'youtube',
    title: 'Garlic Butter Salmon',
    description: 'Recipe in the video!',
    uploader: 'Chef',
    durationSeconds: 180,
    thumbnail: null,
    mediaType: 'video',
    isVideo: true,
    videoId: 'abc123',
    formats: [{ ext: 'mp4', height: 720, filesizeBytes: 40_000_000, vcodec: 'avc1', acodec: 'mp4a' }],
    resolver: 'yt-dlp',
    ...overrides,
  };
}

function videoEvidence() {
  const bundle = createEvidenceBundle({});
  addIngredient(bundle, '2 salmon fillets', 'onscreen_text', { timestampSeconds: 12 });
  addIngredient(bundle, '50g butter', 'transcript', { timestampSeconds: 30 });
  addInstruction(bundle, 'Sear the salmon skin side down', 'transcript', { timestampSeconds: 45 });
  return bundle;
}

/** Chain that records whether it was ever asked to touch the video. */
function spyChain(metadata, options = {}) {
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
      return { path: file, bytes: 2048, mimeType: 'video/mp4', durationSeconds: 180 };
    },
  };
}

function fakePreprocessor() {
  return {
    async probe() {
      return { durationSeconds: 180, width: 540, height: 960, bytes: 2048 };
    },
    async extractAudio(videoPath, opts) {
      const file = path.join(opts.destDir, 'audio.mp3');
      fs.writeFileSync(file, Buffer.alloc(512, 1));
      return { path: file, bytes: 512, mimeType: 'audio/mpeg' };
    },
    async extractFrames(videoPath, opts) {
      const frames = [];
      for (let i = 0; i < 3; i += 1) {
        const file = path.join(opts.destDir, `frame_${i}.jpg`);
        fs.writeFileSync(file, Buffer.alloc(128, i + 1));
        frames.push({ path: file, timestampSeconds: i * 2, index: i });
      }
      return { frames, plan: { intervalSeconds: 2, maxFrames: 3 }, strategy: 'interval' };
    },
  };
}

function fakeResolverAnalyzer(id = 'frames-analyzer') {
  return {
    id,
    provider: 'openai',
    async analyze() {
      return {
        evidence: videoEvidence(),
        transcriptText: 'melt the butter and sear the salmon',
        frameCount: 3,
        provider: 'openai',
        model: 'gpt-4o',
        analyzer: id,
        billing: { chargedMicros: 9000 },
      };
    },
  };
}

/** Gemini analyzer stub that records the request it was given. */
function stubGeminiDirect(result, calls) {
  return {
    id: 'gemini-youtube-direct',
    provider: 'google',
    model: 'gemini-3.5-flash-lite',
    mediaResolution: 'high',
    async analyze(input) {
      calls.direct = input;
      if (result.error) throw result.error;
      return result.value;
    },
  };
}

test('public YouTube watch URLs are recognised, everything else is not', () => {
  assert.ok(isDirectYouTubeUrl('https://www.youtube.com/watch?v=abc123'));
  assert.ok(isDirectYouTubeUrl('https://youtu.be/abc123'));
  assert.ok(isDirectYouTubeUrl('https://m.youtube.com/watch?v=abc123&t=30s'));
  assert.ok(isDirectYouTubeUrl('https://www.youtube.com/shorts/abc123xyz'));
  assert.ok(isDirectYouTubeUrl('https://www.youtube.com/embed/abc123xyz'));

  assert.ok(!isDirectYouTubeUrl('https://www.youtube.com/playlist?list=PL123'));
  assert.ok(!isDirectYouTubeUrl('https://www.youtube.com/@somechannel'));
  assert.ok(!isDirectYouTubeUrl('https://www.youtube.com/results?search_query=pasta'));
  assert.ok(!isDirectYouTubeUrl('https://www.tiktok.com/@user/video/123'));
  assert.ok(!isDirectYouTubeUrl('https://www.instagram.com/reel/abc/'));
  assert.ok(!isDirectYouTubeUrl('https://www.allrecipes.com/recipe/1/'));
  assert.ok(!isDirectYouTubeUrl('not a url'));
});

test('equivalent YouTube URLs collapse to one canonical form', () => {
  assert.strictEqual(
    canonicalizeYouTubeUrl('https://youtu.be/abc123'),
    'https://www.youtube.com/watch?v=abc123',
  );
  assert.strictEqual(
    canonicalizeYouTubeUrl('https://m.youtube.com/watch?v=abc123&t=45s'),
    'https://www.youtube.com/watch?v=abc123',
  );
  assert.strictEqual(
    canonicalizeYouTubeUrl('https://www.youtube.com/shorts/abc123'),
    'https://www.youtube.com/watch?v=abc123',
  );
  assert.strictEqual(canonicalizeYouTubeUrl('https://example.com/x'), null);
});

test('processing mode follows duration: static short, agentic long', () => {
  assert.strictEqual(resolveProcessingMode(60, 'auto').mode, 'static');
  assert.strictEqual(resolveProcessingMode(300, 'auto').mode, 'agentic');
  assert.strictEqual(resolveProcessingMode(null, 'auto').mode, 'static');
  assert.strictEqual(resolveProcessingMode(300, 'static').mode, 'static');
  assert.strictEqual(resolveProcessingMode(30, 'agentic').mode, 'agentic');
});

test('the direct analyzer posts the URL to the Interactions API without downloading', async () => {
  const requests = [];
  const analyzer = new GeminiYouTubeDirectAnalyzer({
    apiKey: 'test-key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.5-flash-lite',
    mediaResolution: 'high',
    processingMode: 'static',
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            id: 'int_1',
            output_text: JSON.stringify({
              title: 'Garlic Salmon',
              ingredients: [
                { name: 'salmon', amount: '2 fillets', source: 'onscreen_text', timestampSeconds: 12 },
              ],
              instructions: [
                { text: 'Sear the salmon', source: 'transcript', timestampSeconds: 45 },
              ],
            }),
            usageMetadata: { promptTokenCount: 54000, candidatesTokenCount: 2000 },
          }),
      };
    },
    meteredAICall: async ({ runFn }) => {
      const r = await runFn();
      return { ...r, billing: { chargedMicros: 5000 } };
    },
  });

  const result = await analyzer.analyze({
    url: 'https://youtu.be/abc123',
    mediaMetadata: youtubeMetadata(),
    contextText: 'page text',
  });

  assert.strictEqual(requests.length, 1);
  assert.strictEqual(requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/interactions?key=test-key');

  const body = requests[0].body;
  assert.strictEqual(body.model, 'gemini-3.5-flash-lite');
  assert.strictEqual(body.store, false, 'we never follow up, so nothing should be stored');
  const videoPart = body.input.find((p) => p.type === 'video');
  assert.strictEqual(videoPart.uri, 'https://www.youtube.com/watch?v=abc123');
  assert.strictEqual(videoPart.resolution, 'high');
  assert.strictEqual(videoPart.processing, 'static');

  assert.strictEqual(result.analyzer, 'gemini-youtube-direct');
  assert.strictEqual(result.frameCount, 0, 'no frames: we never touched ffmpeg');
  assert.strictEqual(result.evidence.ingredientCandidates.length, 1);
  assert.strictEqual(result.evidence.ingredientCandidates[0].source, 'onscreen_text');
  assert.strictEqual(result.usage.inputTokens, 54000);
});

test('response text is read from output_text, output parts, or steps', () => {
  assert.strictEqual(extractResponseText({ output_text: 'hello' }), 'hello');
  assert.strictEqual(extractResponseText({ output: [{ text: 'a' }, { text: 'b' }] }), 'a\nb');
  assert.strictEqual(
    extractResponseText({ steps: [{ content: 'first' }, { content: 'last' }] }),
    'last',
  );
  assert.strictEqual(
    extractResponseText({ candidates: [{ content: { parts: [{ text: 'legacy' }] } }] }),
    'legacy',
  );
  assert.strictEqual(extractResponseText(null), '');
});

test('SCENARIO 1: a public YouTube URL with Gemini available never calls yt-dlp to download', async () => {
  const chain = spyChain(youtubeMetadata());
  const calls = { direct: null };
  const logger = recordingLogger();

  const stub = stubGeminiDirect(
    {
      value: {
        evidence: videoEvidence(),
        transcriptText: null,
        frameCount: 0,
        provider: 'google',
        model: 'gemini-3.5-flash-lite',
        processingMode: 'static',
        mediaResolution: 'high',
        billing: { chargedMicros: 2200 },
      },
    },
    calls,
  );

  const result = await extractRecipeFromUrl('https://www.youtube.com/watch?v=abc123', {
    caption: 'so tasty!! #recipe',
    jobId: 'job-1',
    logger,
    resolverChain: chain,
    allowDirectYouTube: true,
    directAnalyzer: stub,
  });

  assert.ok(calls.direct, 'the direct analyzer must have been used');
  assert.strictEqual(calls.direct.url, 'https://www.youtube.com/watch?v=abc123');
  assert.strictEqual(chain.calls.video, 0, 'yt-dlp must not download when direct Gemini is used');
  assert.strictEqual(result.escalated, true);
  assert.strictEqual(result.videoResult.directUrl, true);
  assert.strictEqual(result.videoResult.downloadBytes, 0);

  const started = logger.events.find((e) => e.event === 'video_direct_url_started');
  assert.ok(started, 'the direct path must announce itself');
  assert.strictEqual(started.model, 'gemini-3.5-flash-lite');
  assert.strictEqual(started.mediaResolution, 'high');
});

test('SCENARIO 2: a direct-URL failure falls back to the resolver path', async () => {
  const chain = spyChain(youtubeMetadata());
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://www.youtube.com/watch?v=abc123', {
    caption: 'yum',
    jobId: 'job-2',
    logger,
    resolverChain: chain,
    preprocessor: fakePreprocessor(),
    analyzer: fakeResolverAnalyzer('frames-analyzer'),
    allowDirectYouTube: true,
    directAnalyzer: stubGeminiDirect(
      { error: Object.assign(new Error('Gemini direct URL analysis error (400).'), { code: 'ANALYSIS_FAILED' }) },
      { direct: null },
    ),
  });

  const failed = logger.events.find((e) => e.event === 'video_direct_url_failed');
  assert.ok(failed, 'the direct failure must be logged');
  assert.strictEqual(failed.fallback, 'resolver');
  assert.ok(chain.calls.video >= 1, 'the resolver path must have been taken after the direct failure');
  assert.strictEqual(result.escalated, true);
  assert.notStrictEqual(result.videoResult.analyzer, 'gemini-youtube-direct');
});

test('SCENARIO 3: a non-YouTube social video uses the resolver, not the direct path', async () => {
  const chain = spyChain({
    originalUrl: 'https://www.tiktok.com/@cook/video/123',
    resolvedUrl: 'https://www.tiktok.com/@cook/video/123',
    platform: 'tiktok',
    title: 'quick pasta',
    description: 'yum',
    uploader: '@cook',
    durationSeconds: 33,
    thumbnail: null,
    mediaType: 'video',
    isVideo: true,
    videoId: '123',
    formats: [{ ext: 'mp4', height: 540, filesizeBytes: 8_000_000, vcodec: 'avc1', acodec: 'mp4a' }],
    resolver: 'yt-dlp',
  });
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://www.tiktok.com/@cook/video/123', {
    caption: 'yum',
    jobId: 'job-3',
    logger,
    resolverChain: chain,
    preprocessor: fakePreprocessor(),
    analyzer: fakeResolverAnalyzer('frames-analyzer'),
    allowDirectYouTube: true,
  });

  assert.strictEqual(
    logger.events.find((e) => e.event === 'video_direct_url_started'),
    undefined,
    'TikTok must not be sent to the YouTube direct path',
  );
  assert.strictEqual(chain.calls.video, 1, 'the resolver must do the download');
  assert.strictEqual(result.videoResult.analyzer, 'frames-analyzer');
});

test('SCENARIO 4: a text-sufficient social URL never downloads video', async () => {
  const chain = spyChain({
    originalUrl: 'https://www.instagram.com/reel/abc/',
    resolvedUrl: 'https://www.instagram.com/reel/abc/',
    platform: 'instagram',
    title: 'Pasta',
    description:
      'Ingredients\n200g pasta\n3 cloves garlic\n100ml cream\n2 tbsp butter\n\nMethod\n1. Boil the pasta.\n2. Fry the garlic in butter.\n3. Add cream and simmer.\n4. Toss through and serve.',
    uploader: '@chef',
    durationSeconds: 45,
    thumbnail: null,
    mediaType: 'video',
    isVideo: true,
    videoId: 'abc',
    formats: [],
    resolver: 'yt-dlp',
  });
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://www.instagram.com/reel/abc/', {
    jobId: 'job-4',
    logger,
    resolverChain: chain,
  });

  assert.strictEqual(result.escalated, false);
  assert.strictEqual(chain.calls.video, 0);
  const success = logger.events.find((e) => e.event === 'text_only_success');
  assert.ok(success, 'a text-only win must be recorded as its own event');
});

test('SCENARIO 9: a supplied video file bypasses the resolver entirely', async () => {
  const localFile = path.join(tmpRoot, 'user-upload.mp4');
  fs.writeFileSync(localFile, Buffer.alloc(4096, 7));

  const chain = spyChain(null, { metadataError: new Error('must not be called') });
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('', {
    jobId: 'job-9',
    logger,
    videoFile: localFile,
    videoSource: 'share_sheet',
    durationSeconds: 180,
    resolverChain: chain,
    preprocessor: fakePreprocessor(),
    analyzer: fakeResolverAnalyzer('frames-analyzer'),
  });

  assert.strictEqual(chain.calls.metadata, 0, 'no resolver call for a file we already have');
  assert.strictEqual(chain.calls.video, 0, 'no download for a file we already have');
  assert.strictEqual(logger.events.find((e) => e.event === 'local_video_supplied').source, 'share_sheet');
  assert.strictEqual(result.escalated, true);
  assert.strictEqual(result.videoResult.analyzer, 'frames-analyzer');
});

test('SCENARIO 10: a normal webpage recipe is unchanged and never touches video', async () => {
  const chain = spyChain({
    originalUrl: 'https://www.allrecipes.com/recipe/1/',
    resolvedUrl: 'https://www.allrecipes.com/recipe/1/',
    platform: 'allrecipes',
    title: 'Best Lasagna',
    description:
      'Ingredients\n1 box lasagna noodles\n500g beef mince\n2 jars tomato sauce\n250g mozzarella\n\nMethod\n1. Cook the noodles.\n2. Brown the beef.\n3. Layer and bake for 40 minutes.',
    uploader: null,
    durationSeconds: null,
    thumbnail: null,
    mediaType: 'unknown',
    isVideo: false,
    videoId: null,
    formats: [],
    resolver: 'yt-dlp',
  });
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://www.allrecipes.com/recipe/1/', {
    pageText:
      'Best Lasagna. Ingredients: 1 box lasagna noodles, 500g beef mince, 2 jars tomato sauce, 250g mozzarella. Method: 1. Cook the noodles. 2. Brown the beef. 3. Layer and bake for 40 minutes.',
    jobId: 'job-10',
    logger,
    resolverChain: chain,
  });

  assert.strictEqual(result.escalated, false);
  assert.strictEqual(result.sufficiency.sufficient, true);
  assert.strictEqual(chain.calls.video, 0);
  assert.ok(logger.events.find((e) => e.event === 'text_only_success'));
  assert.strictEqual(
    logger.events.find((e) => e.event === 'media_tooling_disabled'),
    undefined,
    'a working text import must not raise the tooling alarm',
  );
});

test('SCENARIO 8: tooling disabled on a video we needed keeps the old behaviour and raises the alarm', async () => {
  const toolingError = new Error('Media tooling (yt-dlp) is not available in this deployment.');
  toolingError.code = 'MEDIA_TOOLING_UNAVAILABLE';
  const chain = spyChain(null, { metadataError: toolingError });
  const logger = recordingLogger();

  // Thin caption: the text is NOT enough, so the video was genuinely needed.
  const result = await extractRecipeFromUrl('https://www.tiktok.com/@cook/video/555', {
    caption: 'you have to try this!! #recipe',
    jobId: 'job-8',
    logger,
    resolverChain: chain,
  });

  // Old user-facing behaviour preserved: no crash, the caller keeps what it has.
  assert.strictEqual(result.escalated, false);
  assert.strictEqual(result.reason, 'media_tooling_unavailable');

  // The misconfiguration is loud, and distinguishable from a platform failure.
  const alarm = logger.events.find((e) => e.event === 'media_tooling_disabled');
  assert.ok(alarm, 'tooling disabled must emit its own event');
  assert.strictEqual(alarm.level, 'error');
  assert.strictEqual(alarm.jobId, 'job-8');
  assert.strictEqual(alarm.required, true);
  assert.notStrictEqual(
    alarm.event,
    'media_metadata_failed',
    'the two must not be conflated',
  );
});

test('tooling disabled on a sufficient text page raises NO alarm', async () => {
  const toolingError = new Error('Media tooling (yt-dlp) is not available in this deployment.');
  toolingError.code = 'MEDIA_TOOLING_UNAVAILABLE';
  const chain = spyChain(null, { metadataError: toolingError });
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://www.allrecipes.com/recipe/1/', {
    pageText: [
      'Best Lasagna',
      'Ingredients',
      '1 box lasagna noodles',
      '500g beef mince',
      '2 jars tomato sauce',
      '250g mozzarella',
      'Method',
      '1. Cook the noodles.',
      '2. Brown the beef with the sauce.',
      '3. Layer and bake for 40 minutes.',
    ].join('\n'),
    jobId: 'job-8b',
    logger,
    resolverChain: chain,
  });

  assert.strictEqual(result.escalated, false);
  assert.strictEqual(result.sufficiency.sufficient, true);
  assert.strictEqual(
    logger.events.find((e) => e.event === 'media_tooling_disabled'),
    undefined,
    'a page that never needed the tooling must not raise the alarm',
  );
  assert.ok(logger.events.find((e) => e.event === 'text_only_success'));
});

test('a thin text import with no video at all does not raise the tooling alarm', async () => {
  const chain = spyChain({
    originalUrl: 'https://blog.example/post',
    resolvedUrl: 'https://blog.example/post',
    platform: 'blog',
    title: 'Thoughts on pasta',
    description: 'I like pasta a lot.',
    uploader: null,
    durationSeconds: null,
    thumbnail: null,
    mediaType: 'unknown',
    isVideo: false,
    videoId: null,
    formats: [],
    resolver: 'yt-dlp',
  });
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://blog.example/post', {
    pageText: 'I like pasta a lot.',
    jobId: 'job-11',
    logger,
    resolverChain: chain,
  });

  assert.strictEqual(result.escalated, false);
  assert.strictEqual(result.reason, 'no_video_to_analyze');
  assert.strictEqual(
    logger.events.find((e) => e.event === 'media_tooling_disabled'),
    undefined,
  );
});

test('video escalation is instrumented with usefulness and material change', async () => {
  const chain = spyChain(youtubeMetadata({ description: 'yum' }));
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://www.youtube.com/watch?v=abc123', {
    caption: 'yum',
    jobId: 'job-12',
    logger,
    resolverChain: chain,
    preprocessor: fakePreprocessor(),
    analyzer: fakeResolverAnalyzer('frames-analyzer'),
    // Direct YouTube disabled so the resolver analyzer supplies the evidence.
    allowDirectYouTube: false,
  });

  assert.strictEqual(result.escalated, true);
  assert.ok(logger.events.find((e) => e.event === 'video_escalated'));
  const useful = logger.events.find((e) => e.event === 'video_added_useful_information');
  assert.ok(useful, 'the video supplied evidence, so that must be recorded');
  assert.ok(useful.videoSourcedItems >= 3);
  const material = logger.events.find((e) => e.event === 'video_changed_recipe_materially');
  assert.ok(material, 'new ingredients and instructions is a material change');
  assert.ok(material.addedIngredients > 0);
  assert.ok(material.addedInstructions > 0);
});

test('a YouTube URL whose metadata probe FAILED still gets the direct-URL path', async () => {
  // The direct path hands Gemini a link and needs nothing from yt-dlp. If a
  // failed metadata lookup were treated as "there is no video", the one path
  // that does not depend on the resolver would be switched off by the
  // resolver being broken - which is exactly what was happening.
  const metaErr = new Error('yt-dlp could not resolve this URL.');
  metaErr.code = 'MEDIA_RESOLUTION_FAILED';
  const chain = spyChain(null, { metadataError: metaErr });
  const calls = {};
  const direct = stubGeminiDirect({ value: { evidence: videoEvidence(), analyzer: 'gemini-youtube-direct', provider: 'google', model: 'gemini-3.5-flash-lite' } }, calls);
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://www.youtube.com/watch?v=abc123', {
    caption: 'you have to try this!!',
    jobId: 'job-metafail',
    logger,
    resolverChain: chain,
    allowDirectYouTube: true,
    directAnalyzer: direct,
  });

  assert.ok(
    logger.events.find((e) => e.event === 'video_direct_url_started'),
    'direct path must be attempted even with no metadata',
  );
  assert.strictEqual(result.escalated, true);
  assert.strictEqual(result.reason, undefined);
  assert.strictEqual(result.videoResult.directUrl, true);
});

test('tooling unavailable does NOT block a direct-eligible YouTube URL', async () => {
  // Same reasoning: no yt-dlp in the deployment is not a reason to skip a
  // path that never calls yt-dlp.
  const toolingErr = new Error('Media tooling (yt-dlp) is not available.');
  toolingErr.code = 'MEDIA_TOOLING_UNAVAILABLE';
  const chain = spyChain(null, { metadataError: toolingErr });
  const calls = {};
  const direct = stubGeminiDirect({ value: { evidence: videoEvidence(), analyzer: 'gemini-youtube-direct', provider: 'google', model: 'gemini-3.5-flash-lite' } }, calls);
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://youtu.be/abc123', {
    caption: 'you have to try this!!',
    jobId: 'job-notooling-direct',
    logger,
    resolverChain: chain,
    allowDirectYouTube: true,
    directAnalyzer: direct,
  });

  assert.strictEqual(result.escalated, true);
  assert.strictEqual(
    logger.events.find((e) => e.event === 'media_tooling_disabled'),
    undefined,
    'the alarm is for work we could not do; the direct path did the work',
  );
});

test('a NON-YouTube URL with failed metadata still reports no video', async () => {
  // Symmetry: the relaxation is scoped to direct-eligible URLs only.
  const metaErr = new Error('could not resolve');
  metaErr.code = 'MEDIA_RESOLUTION_FAILED';
  const chain = spyChain(null, { metadataError: metaErr });
  const calls = {};
  const direct = stubGeminiDirect({ value: { evidence: videoEvidence(), analyzer: 'gemini-youtube-direct', provider: 'google', model: 'gemini-3.5-flash-lite' } }, calls);
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://www.tiktok.com/@x/video/9', {
    caption: 'you have to try this!!',
    jobId: 'job-novideo',
    logger,
    resolverChain: chain,
    directAnalyzer: direct,
  });

  assert.strictEqual(result.escalated, false);
  assert.strictEqual(result.reason, 'no_video_to_analyze');
});

test('the configured direct-YouTube model is actually priced', async () => {
  // The direct path failed in production with "Cost calculation failed"
  // because gemini-3.5-flash-lite was the default but had no entry in the
  // pricing table. A default that cannot be priced means every escalation
  // dies at the metering step, so this is worth a test rather than a hope.
  const config = require('../recipeImport/config');
  const { getModelPricingByProviderModel } = require('../billing/config');
  const model = config.GEMINI_DIRECT_YOUTUBE_MODEL;
  const pricing = getModelPricingByProviderModel('google', model);
  assert.ok(
    pricing,
    `model "${model}" is the configured default but has no pricing entry`,
  );
  assert.ok(pricing.inputMicrosPerMillion > 0);
  assert.ok(pricing.outputMicrosPerMillion > 0);
});
