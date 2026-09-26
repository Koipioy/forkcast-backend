'use strict';

/**
 * The media probe is the first thing that costs real time on an import, and
 * until now it ran unconditionally: every plain blog post paid for a yt-dlp
 * spawn and a network round trip before anyone had checked whether the text
 * the caller already scraped was enough. These tests pin the fix from both
 * sides - that a sufficient page body skips the probe, and that a thin one
 * still gets it, so the description-carrying-YouTube case is not lost.
 */

const test = require('node:test');
const assert = require('node:assert');

const { extractRecipeFromUrl } = require('../recipeImport/service');

const FULL_RECIPE_PAGE_TEXT = [
  'Creamy Garlic Pasta',
  '',
  'Ingredients',
  '200g spaghetti',
  '3 cloves garlic, minced',
  '1 cup heavy cream',
  '50g parmesan, grated',
  '2 tbsp butter',
  'salt and pepper to taste',
  '',
  'Method',
  'Boil the spaghetti in salted water until al dente, then drain.',
  'Melt the butter in a pan and cook the garlic until fragrant.',
  'Pour in the cream and simmer for three minutes.',
  'Stir in the parmesan and toss with the pasta to serve.',
].join('\n');

function fakeChain(metadata) {
  const calls = { metadata: 0, video: 0 };
  return {
    calls,
    async resolveMetadata() {
      calls.metadata += 1;
      return metadata;
    },
    async resolveVideo() {
      calls.video += 1;
      throw new Error('resolveVideo must not be reached in these tests');
    },
  };
}

function recordingLogger() {
  const events = [];
  const push = (level) => (stage, fields) => events.push({ level, stage, fields });
  return { events, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

const PLAIN_BLOG_METADATA = {
  originalUrl: 'https://blog.example/creamy-garlic-pasta',
  platform: 'blog',
  isVideo: false,
  durationSeconds: null,
  title: 'Creamy Garlic Pasta',
  description: '',
  formats: [],
};

test('a full recipe in the caller page text skips the media probe entirely', async () => {
  const chain = fakeChain(PLAIN_BLOG_METADATA);
  const logger = recordingLogger();

  const result = await extractRecipeFromUrl('https://blog.example/creamy-garlic-pasta', {
    pageText: FULL_RECIPE_PAGE_TEXT,
    resolverChain: chain,
    logger,
  });

  assert.strictEqual(result.escalated, false);
  assert.strictEqual(result.sufficiency.sufficient, true);
  assert.strictEqual(chain.calls.metadata, 0, 'yt-dlp must not be spawned for a sufficient page');
  assert.strictEqual(chain.calls.video, 0, 'nothing must be downloaded');
  assert.strictEqual(result.mediaProbeSkipped, true);
  // The skip is visible in the log, so a dashboard can count how many probes
  // this saves rather than having to infer it.
  const skipped = logger.events.filter((e) => e.fields && e.fields.mediaProbeSkipped === true);
  assert.ok(skipped.length >= 1, 'the skip must be recorded on the log');
});

test('a thin caller text still probes, so a description-carried recipe survives', async () => {
  // The page body is useless but the video description holds the whole
  // recipe. Skipping the probe here would silently lose that recipe, so the
  // fast path must NOT fire and the description must still be folded in.
  const chain = fakeChain({
    ...PLAIN_BLOG_METADATA,
    platform: 'youtube',
    isVideo: true,
    durationSeconds: 600,
    description: FULL_RECIPE_PAGE_TEXT,
  });

  const result = await extractRecipeFromUrl('https://www.youtube.com/watch?v=abcdef', {
    pageText: 'This looks delicious!!',
    resolverChain: chain,
    logger: recordingLogger(),
  });

  assert.strictEqual(chain.calls.metadata, 1, 'a thin page must still be probed');
  assert.strictEqual(result.escalated, false, 'the description makes the text sufficient');
  assert.strictEqual(result.sufficiency.sufficient, true);
  assert.ok(!result.mediaProbeSkipped);
});

test('skipSufficiencyCheck still probes, because the caller asked to escalate', async () => {
  const chain = fakeChain(PLAIN_BLOG_METADATA);

  const result = await extractRecipeFromUrl('https://blog.example/creamy-garlic-pasta', {
    pageText: FULL_RECIPE_PAGE_TEXT,
    skipSufficiencyCheck: true,
    resolverChain: chain,
    logger: recordingLogger(),
  });

  assert.strictEqual(chain.calls.metadata, 1, 'an explicit skip must not be short-circuited');
  assert.strictEqual(result.escalated, false);
  assert.strictEqual(result.reason, 'no_video_to_analyze');
});
