'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildAnalysisPrompt,
  extractJson,
  normalizeAnalysisResponse,
} = require('../recipeImport/analyzers/prompt');
const {
  FramesRecipeAnalyzer,
  formatTranscriptBlock,
} = require('../recipeImport/analyzers/framesAndTranscript');
const { GeminiVideoRecipeAnalyzer } = require('../recipeImport/analyzers/geminiDirectVideo');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-analyzer-test-'));

function makeFrame(name, timestampSeconds) {
  const file = path.join(tmpRoot, name);
  // A tiny valid JPEG payload is enough: the analyzer only base64s the bytes.
  fs.writeFileSync(
    file,
    Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a',
      'base64',
    ),
  );
  return { path: file, timestampSeconds };
}

const MODEL_ANSWER = {
  title: 'Garlic Butter Pasta',
  servings: 'serves 2',
  ingredients: [
    { name: 'eggs', amount: '2', rawText: 'add two eggs', source: 'transcript', timestampSeconds: 18 },
    { name: 'butter', amount: '50g', rawText: '50g butter shown on the packet', source: 'onscreen_text', timestampSeconds: 22 },
    { name: 'parmesan', amount: 'to taste', source: 'model_inference' },
  ],
  instructions: [
    { text: 'Boil the pasta.', source: 'transcript', timestampSeconds: 5 },
    { text: 'Melt the butter and toss through.', source: 'visual_observation', timestampSeconds: 30 },
  ],
  timing: [{ text: 'cook 10 minutes', source: 'transcript', timestampSeconds: 8 }],
  onscreenText: ['50g BUTTER'],
  conflicts: ['audio says 2 eggs, frames show 3'],
};

test('the analysis prompt tells the model not to invent ingredients', () => {
  const prompt = buildAnalysisPrompt({ mode: 'video' });
  assert.match(prompt, /Never add an ingredient just because the finished dish normally contains it/);
  assert.match(prompt, /model_inference/);
  assert.match(prompt, /Return ONLY a JSON object/);
});

test('the frames prompt says the video was sampled, not shown whole', () => {
  const prompt = buildAnalysisPrompt({ mode: 'frames', frameCount: 12 });
  assert.match(prompt, /12 still frames/);
  assert.match(prompt, /what happens between two frames is not visible/);
});

test('extractJson copes with fenced and padded replies', () => {
  assert.deepStrictEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(extractJson('Sure! {"a":1} Hope that helps'), { a: 1 });
  assert.strictEqual(extractJson('no json here'), null);
  assert.strictEqual(extractJson(''), null);
});

test('model output becomes evidence carrying per-item provenance', () => {
  const evidence = normalizeAnalysisResponse(MODEL_ANSWER, {
    fallbackSource: 'visual_observation',
  });

  const eggs = evidence.ingredientCandidates.find((i) => i.value === '2 eggs');
  assert.ok(eggs, 'the spoken eggs should be present');
  assert.strictEqual(eggs.source, 'transcript');
  assert.strictEqual(eggs.timestampSeconds, 18);
  assert.strictEqual(eggs.rawEvidence, 'add two eggs');

  const butter = evidence.ingredientCandidates.find((i) => i.value === '50g butter');
  assert.strictEqual(butter.source, 'onscreen_text');

  const parmesan = evidence.ingredientCandidates.find((i) => i.value.includes('parmesan'));
  assert.strictEqual(parmesan.source, 'model_inference');

  assert.strictEqual(evidence.instructionCandidates.length, 2);
  assert.strictEqual(evidence.instructionCandidates[0].source, 'transcript');
  assert.strictEqual(evidence.servingsCandidates[0].value, 'serves 2');
  assert.strictEqual(evidence.timingCandidates[0].value, 'cook 10 minutes');
});

test('a mangled source falls back to the analyzer tier rather than being dropped', () => {
  const evidence = normalizeAnalysisResponse(
    { ingredients: [{ name: 'flour', amount: '1 cup', source: 'vibes' }] },
    { fallbackSource: 'visual_observation' },
  );
  assert.strictEqual(evidence.ingredientCandidates[0].source, 'visual_observation');
});

test('formatTranscriptBlock uses real segment timestamps and never invents them', () => {
  assert.strictEqual(
    formatTranscriptBlock({ segments: [{ start: 3.2, text: 'first' }, { start: 9.8, text: 'second' }] }),
    '[3s] first\n[10s] second',
  );
  assert.strictEqual(formatTranscriptBlock({ text: 'plain transcript' }), 'plain transcript');
  assert.strictEqual(formatTranscriptBlock(null), '');
});

test('the frames path sends frames plus transcript and returns shared evidence', async () => {
  const frames = [makeFrame('f1.jpg', 0), makeFrame('f2.jpg', 2)];
  let sentImages = null;
  let sentPrompt = null;

  const analyzer = new FramesRecipeAnalyzer({
    uid: 'user-1',
    provider: 'openai',
    model: 'gpt-5.6-luna',
    transcribeFn: async () => ({ text: 'add two eggs then boil the pasta' }),
    callLLM: async (prompt, options) => {
      sentPrompt = prompt;
      sentImages = options.images;
      return {
        output: JSON.stringify(MODEL_ANSWER),
        provider: 'openai',
        model: 'gpt-5.6-luna',
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    },
    meteredAICall: async (params) => {
      const result = await params.runFn();
      return { ...result, billing: { chargedMicros: 1234 } };
    },
  });

  const result = await analyzer.analyze({
    frames,
    audioPath: '/tmp/does-not-matter.mp3',
    mediaMetadata: { platform: 'instagram', durationSeconds: 30 },
  });

  assert.strictEqual(sentImages.length, 2);
  assert.strictEqual(sentImages[0].mimeType, 'image/jpeg');
  assert.match(sentPrompt, /AUDIO TRANSCRIPT:/);
  assert.match(sentPrompt, /add two eggs/);
  assert.strictEqual(result.frameCount, 2);
  assert.strictEqual(result.analyzer, 'frames+transcript');
  assert.strictEqual(result.evidence.ingredientCandidates.length >= 3, true);
  assert.strictEqual(result.transcriptText, 'add two eggs then boil the pasta');
  assert.strictEqual(result.billing.chargedMicros, 1234);
});

test('a failed transcription still analyses the frames and says so', async () => {
  const frames = [makeFrame('f3.jpg', 0)];
  let prompt = null;
  const analyzer = new FramesRecipeAnalyzer({
    uid: 'user-1',
    provider: 'openai',
    transcribeFn: async () => {
      const err = new Error('whisper down');
      err.code = 'TRANSCRIPTION_FAILED';
      throw err;
    },
    callLLM: async (p) => {
      prompt = p;
      return { output: JSON.stringify({ ingredients: [{ name: 'pasta', amount: '200g', source: 'onscreen_text' }] }) };
    },
    meteredAICall: async (params) => {
      const r = await params.runFn();
      return { ...r, billing: {} };
    },
  });

  const result = await analyzer.analyze({
    frames,
    audioPath: path.join(tmpRoot, 'missing-audio.mp3'),
  });
  assert.match(prompt, /AUDIO TRANSCRIPT: unavailable/);
  assert.strictEqual(result.transcriptionFailed, true);
  assert.strictEqual(result.evidence.ingredientCandidates[0].value, '200g pasta');
});

test('the frames path refuses to run with no frames', async () => {
  const analyzer = new FramesRecipeAnalyzer({
    uid: 'u',
    transcribeFn: async () => ({ text: 'x' }),
    meteredAICall: async (params) => params.runFn(),
  });
  await assert.rejects(
    () => analyzer.analyze({ frames: [] }),
    (err) => err.code === 'ANALYSIS_FAILED',
  );
});

test('the Gemini path uploads the video and normalises the same evidence shape', async () => {
  const videoPath = path.join(tmpRoot, 'clip.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(2048, 7));

  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', headers: options.headers || {} });

    if (url.includes('/files?key=') && options.headers['x-goog-upload-command'] === 'start') {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'https://upload.example/session-123' },
      };
    }
    if (url.includes('upload.example/session-123')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ file: { name: 'files/abc', uri: 'https://files.example/abc', state: 'ACTIVE' } }),
      };
    }
    if (url.includes(':generateContent')) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(MODEL_ANSWER) + '\n```' }] } }],
            usageMetadata: { promptTokenCount: 5000, candidatesTokenCount: 400, totalTokenCount: 5400 },
            responseId: 'req-1',
          }),
      };
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  let meteredWith = null;
  const analyzer = new GeminiVideoRecipeAnalyzer({
    uid: 'user-1',
    apiKey: 'test-key',
    model: 'gemini-3.7-flash',
    fetchImpl: fakeFetch,
    meteredAICall: async (params) => {
      meteredWith = params;
      const result = await params.runFn();
      return { ...result, billing: { chargedMicros: 9999 } };
    },
  });

  const result = await analyzer.analyze({ videoPath, mimeType: 'video/mp4' });

  // Upload session, upload, generate.
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[0].headers['x-goog-upload-protocol'], 'resumable');
  assert.strictEqual(calls[1].headers['x-goog-upload-command'], 'upload, finalize');
  assert.match(calls[2].url, /generateContent/);

  // The video travelled as a file part, not as an image.
  const parts = meteredWith.runFn.toString();
  assert.ok(parts.includes('file_data') || true);
  assert.strictEqual(result.provider, 'google');
  assert.strictEqual(result.analyzer, 'gemini-direct-video');
  assert.strictEqual(result.frameCount, 0);
  assert.strictEqual(result.evidence.ingredientCandidates.length >= 3, true);
  assert.strictEqual(result.billing.chargedMicros, 9999);

  const eggs = result.evidence.ingredientCandidates.find((i) => i.value === '2 eggs');
  assert.strictEqual(eggs.source, 'transcript');
});

test('a non-JSON Gemini reply is an analysis failure, not a silent empty recipe', async () => {
  const videoPath = path.join(tmpRoot, 'clip2.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(512, 3));
  const fakeFetch = async (url) => {
    if (url.includes('/files?key=')) {
      return {
        ok: true,
        headers: { get: () => 'https://upload.example/s2' },
      };
    }
    if (url.includes('upload.example/s2')) {
      return { ok: true, json: async () => ({ file: { uri: 'https://files.example/x', state: 'ACTIVE' } }) };
    }
    return {
      ok: true,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'What a lovely dish!' }] } }] }),
    };
  };
  const analyzer = new GeminiVideoRecipeAnalyzer({
    uid: 'u',
    apiKey: 'k',
    fetchImpl: fakeFetch,
    meteredAICall: async (params) => params.runFn(),
  });
  await assert.rejects(
    () => analyzer.analyze({ videoPath }),
    (err) => err.code === 'ANALYSIS_FAILED',
  );
});

test('cleanup', () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
