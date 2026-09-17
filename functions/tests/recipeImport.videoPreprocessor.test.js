'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { VideoPreprocessor } = require('../recipeImport/videoPreprocessor');
const { planFrameSampling } = require('../recipeImport/config');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-ffmpeg-test-'));
const fixture = path.join(tmpRoot, 'fixture.mp4');

let ffmpegAvailable = true;
try {
  execFileSync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      fixture,
    ],
    { stdio: 'pipe' },
  );
} catch (err) {
  ffmpegAvailable = false;
}

test('probe reads duration and dimensions from the downloaded file', { skip: !ffmpegAvailable }, async () => {
  const preprocessor = new VideoPreprocessor();
  const info = await preprocessor.probe(fixture);
  assert.ok(Math.abs(info.durationSeconds - 6) < 0.5);
  assert.strictEqual(info.width, 320);
  assert.strictEqual(info.height, 180);
  assert.ok(info.bytes > 0);
});

test('extractAudio produces a small mono mp3', { skip: !ffmpegAvailable }, async () => {
  const preprocessor = new VideoPreprocessor();
  const audio = await preprocessor.extractAudio(fixture, { destDir: tmpRoot, baseName: 'audio' });
  assert.ok(audio.path.endsWith('audio.mp3'));
  assert.ok(audio.bytes > 0);
  assert.strictEqual(audio.mimeType, 'audio/mpeg');
  // 6s at 32kbps is ~24KB; anything an order of magnitude larger is wrong.
  assert.ok(audio.bytes < 200_000, `audio unexpectedly large: ${audio.bytes}`);
});

test('extractFrames samples at the configured interval with timestamps', { skip: !ffmpegAvailable }, async () => {
  const dir = path.join(tmpRoot, 'frames');
  const preprocessor = new VideoPreprocessor({ frameIntervalSeconds: 2, maxFrames: 10 });
  const result = await preprocessor.extractFrames(fixture, {
    destDir: dir,
    baseName: 'frame',
    durationSeconds: 6,
  });
  assert.strictEqual(result.strategy, 'interval');
  assert.ok(result.frames.length >= 3, `expected ~3 frames, got ${result.frames.length}`);
  assert.deepStrictEqual(
    result.frames.map((frame) => frame.timestampSeconds),
    result.frames.map((frame, index) => index * 2),
  );
  for (const frame of result.frames) {
    assert.ok(fs.existsSync(frame.path));
  }
});

test('the frame cap widens the interval instead of truncating the video', () => {
  const plan = planFrameSampling(900, { intervalSeconds: 2, maxFrames: 60 });
  assert.strictEqual(plan.maxFrames, 60);
  assert.ok(plan.intervalSeconds >= 15, `interval should widen, got ${plan.intervalSeconds}`);
  // Whole-video coverage: interval * cap must span the duration.
  assert.ok(plan.intervalSeconds * plan.maxFrames >= 900);
});

test('a short video keeps the requested interval', () => {
  const plan = planFrameSampling(10, { intervalSeconds: 2, maxFrames: 60 });
  assert.strictEqual(plan.intervalSeconds, 2);
});

test('frames are deduplicated by content', { skip: !ffmpegAvailable }, async () => {
  const dir = path.join(tmpRoot, 'dedupe');
  fs.mkdirSync(dir, { recursive: true });
  // Three byte-identical frames: two should be dropped.
  const payload = fs.readFileSync(fixture);
  for (const name of ['frame_0001.jpg', 'frame_0002.jpg', 'frame_0003.jpg']) {
    fs.writeFileSync(path.join(dir, name), payload);
  }
  const preprocessor = new VideoPreprocessor();
  const kept = await preprocessor.dedupeFrames(
    ['frame_0001.jpg', 'frame_0002.jpg', 'frame_0003.jpg'].map((name, index) => ({
      path: path.join(dir, name),
      timestampSeconds: index,
    })),
  );
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(fs.readdirSync(dir).length, 1);
});

test('a broken media file fails as PREPROCESS_FAILED, not as a crash', async () => {
  const badFile = path.join(tmpRoot, 'broken.mp4');
  fs.writeFileSync(badFile, 'this is not a video file at all');
  const preprocessor = new VideoPreprocessor();
  await assert.rejects(
    () => preprocessor.probe(badFile),
    (err) => err.code === 'PREPROCESS_FAILED',
  );
  await assert.rejects(
    () => preprocessor.extractAudio(badFile, { destDir: tmpRoot, baseName: 'bad' }),
    (err) => err.code === 'PREPROCESS_FAILED',
  );
});

test('a missing ffmpeg binary is reported as a preprocessing failure', async () => {
  const preprocessor = new VideoPreprocessor({
    ffmpegPath: path.join(tmpRoot, 'no-ffmpeg-here'),
    ffprobePath: path.join(tmpRoot, 'no-ffprobe-here'),
  });
  await assert.rejects(
    () => preprocessor.extractAudio(fixture, { destDir: tmpRoot, baseName: 'x' }),
    (err) => err.code === 'PREPROCESS_FAILED',
  );
});

test('extractFrames with no frames raises NO_FRAMES_EXTRACTED', async () => {
  const badFile = path.join(tmpRoot, 'broken2.mp4');
  fs.writeFileSync(badFile, 'nope');
  const preprocessor = new VideoPreprocessor({ ffmpegPath: '/bin/false' });
  await assert.rejects(
    () => preprocessor.extractFrames(badFile, { destDir: tmpRoot, durationSeconds: 5 }),
    (err) => err.code === 'NO_FRAMES_EXTRACTED' || err.code === 'PREPROCESS_FAILED',
  );
});

test('extractAudio refuses to exceed its byte cap', async () => {
  const preprocessor = new VideoPreprocessor({ audioMaxBytes: 100 });
  await assert.rejects(
    () => preprocessor.extractAudio(fixture, { destDir: tmpRoot, baseName: 'capped' }),
    (err) => err.code === 'PREPROCESS_FAILED',
  );
  assert.strictEqual(fs.existsSync(path.join(tmpRoot, 'capped.mp3')), false);
});

test('cleanup', () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
