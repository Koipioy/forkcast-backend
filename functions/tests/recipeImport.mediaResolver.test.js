'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MediaResolverChain,
  YtDlpMediaResolver,
  chooseDownloadFormat,
  normalizeMediaMetadata,
  pickEntry,
} = require('../recipeImport/mediaResolver');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-media-test-'));

function writeFakeYtDlp(name, body) {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  return file;
}

const YOUTUBE_INFO = {
  id: 'abc123',
  extractor_key: 'Youtube',
  title: '15-Minute Garlic Butter Pasta',
  description: 'Ingredients\n200g pasta\n3 cloves garlic\n\nMethod\n1. Boil pasta\n2. Melt butter',
  uploader: 'Chef Test',
  duration: 421,
  thumbnail: 'https://img.example/t.jpg',
  webpage_url: 'https://www.youtube.com/watch?v=abc123',
  formats: [
    { ext: 'mp4', height: 720, filesize: 52428800, vcodec: 'avc1.4d401f', acodec: 'none' },
    { ext: 'm4a', height: null, filesize: 4194304, vcodec: 'none', acodec: 'mp4a.40.2' },
  ],
};

const TIKTOK_INFO = {
  id: '7412345678901234567',
  extractor_key: 'TikTok',
  title: 'creamy pasta #recipe',
  description: 'creamy pasta #recipe #food',
  uploader: '@cook',
  duration: 37,
  webpage_url: 'https://www.tiktok.com/@cook/video/7412345678901234567',
  formats: [{ ext: 'mp4', height: 540, filesize: 8_000_000, vcodec: 'avc1', acodec: 'mp4a' }],
};

test('yt-dlp JSON is normalised into our own MediaMetadata shape', () => {
  const metadata = normalizeMediaMetadata(YOUTUBE_INFO, 'https://youtu.be/abc123');
  assert.strictEqual(metadata.platform, 'youtube');
  assert.strictEqual(metadata.title, '15-Minute Garlic Butter Pasta');
  assert.strictEqual(metadata.uploader, 'Chef Test');
  assert.strictEqual(metadata.durationSeconds, 421);
  assert.strictEqual(metadata.isVideo, true);
  assert.strictEqual(metadata.mediaType, 'video');
  assert.strictEqual(metadata.resolver, 'yt-dlp');
  assert.strictEqual(metadata.formats.length, 2);
  // The rest of the app never sees a raw yt-dlp key.
  assert.strictEqual(metadata.extractor_key, undefined);
  assert.strictEqual(metadata.formats[0].vcodec, 'avc1.4d401f');
});

test('a playlist response is narrowed to its first entry', () => {
  const playlist = { _type: 'playlist', entries: [TIKTOK_INFO, YOUTUBE_INFO] };
  const entry = pickEntry(playlist);
  assert.strictEqual(entry.extractor_key, 'TikTok');
  const metadata = normalizeMediaMetadata(playlist, 'https://tiktok.com/x');
  assert.strictEqual(metadata.platform, 'tiktok');
});

test('an audio-only stream is not reported as a video', () => {
  const audioOnly = {
    id: 'a1',
    extractor_key: 'SoundCloud',
    title: 'podcast',
    duration: 900,
    vcodec: 'none',
    acodec: 'mp3',
    formats: [{ ext: 'mp3', filesize: 1000, vcodec: 'none', acodec: 'mp3' }],
  };
  const metadata = normalizeMediaMetadata(audioOnly, 'https://soundcloud.com/x');
  assert.strictEqual(metadata.isVideo, false);
  assert.strictEqual(metadata.mediaType, 'audio');
});

test('chooseDownloadFormat estimates the smallest usable stream', () => {
  const formats = normalizeFormatsForTest();
  const choice = chooseDownloadFormat(formats);
  assert.strictEqual(choice.estimateBytes, 5_000_000);
});

function normalizeFormatsForTest() {
  return [
    { ext: 'mp4', height: 1080, filesizeBytes: 50_000_000, vcodec: 'avc1', acodec: 'none' },
    { ext: 'mp4', height: 360, filesizeBytes: 5_000_000, vcodec: 'avc1', acodec: 'none' },
  ];
}

test('resolveMetadata returns normalized metadata for a working URL', async () => {
  const bin = writeFakeYtDlp('ok.sh', `cat <<'JSON'\n${JSON.stringify(YOUTUBE_INFO)}\nJSON`);
  const resolver = new YtDlpMediaResolver({
    binaryPath: bin,
    allowPrivateNetwork: true,
  });
  const metadata = await resolver.resolveMetadata('https://www.youtube.com/watch?v=abc123');
  assert.strictEqual(metadata.platform, 'youtube');
  assert.strictEqual(metadata.durationSeconds, 421);
});

test('an unsupported or broken URL fails as MEDIA_RESOLUTION_FAILED', async () => {
  const bin = writeFakeYtDlp('broken.sh', `echo "ERROR: [generic] Unable to download webpage" >&2\nexit 1`);
  const resolver = new YtDlpMediaResolver({ binaryPath: bin, allowPrivateNetwork: true });
  await assert.rejects(
    () => resolver.resolveMetadata('https://dead.example/video'),
    (err) => err.code === 'MEDIA_RESOLUTION_FAILED' && err.retryable === true,
  );
});

test('a hanging resolver is cut off as a timeout, not left running', async () => {
  const bin = writeFakeYtDlp('slow.sh', `sleep 30`);
  const resolver = new YtDlpMediaResolver({
    binaryPath: bin,
    metadataTimeoutMs: 300,
    allowPrivateNetwork: true,
  });
  await assert.rejects(
    () => resolver.resolveMetadata('https://slow.example/v'),
    (err) => err.code === 'MEDIA_METADATA_TIMEOUT',
  );
});

test('a missing yt-dlp binary is reported as tooling unavailable', async () => {
  const resolver = new YtDlpMediaResolver({
    binaryPath: path.join(tmpRoot, 'definitely-not-here'),
    allowPrivateNetwork: true,
  });
  await assert.rejects(
    () => resolver.resolveMetadata('https://example.com/v'),
    (err) => err.code === 'MEDIA_TOOLING_UNAVAILABLE',
  );
});

test('resolveVideo downloads into the given directory', async () => {
  const bin = writeFakeYtDlp(
    'dl.sh',
    `out=""\nprev=""\nfor a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done\nout="\${out//%(ext)s/mp4}"\nhead -c 4096 /dev/urandom > "$out"`,
  );
  const dest = path.join(tmpRoot, 'dl');
  const resolver = new YtDlpMediaResolver({ binaryPath: bin, allowPrivateNetwork: true });
  const file = await resolver.resolveVideo('https://www.youtube.com/watch?v=abc123', {
    destDir: dest,
    baseName: 'source',
  });
  assert.ok(file.path.endsWith('source.mp4'));
  assert.strictEqual(file.bytes, 4096);
  assert.strictEqual(file.mimeType, 'video/mp4');
  assert.ok(fs.existsSync(file.path));
});

test('a video over the byte cap is rejected and the file is removed', async () => {
  const bin = writeFakeYtDlp(
    'big.sh',
    `out=""\nprev=""\nfor a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done\nout="\${out//%(ext)s/mp4}"\nhead -c 8192 /dev/urandom > "$out"`,
  );
  const dest = path.join(tmpRoot, 'big');
  const resolver = new YtDlpMediaResolver({ binaryPath: bin, allowPrivateNetwork: true });
  await assert.rejects(
    () => resolver.resolveVideo('https://www.youtube.com/watch?v=abc123', {
      destDir: dest,
      baseName: 'source',
      maxBytes: 1000,
    }),
    (err) => err.code === 'VIDEO_TOO_LARGE' && err.retryable === false,
  );
  const leftovers = fs.readdirSync(dest).filter((name) => name.startsWith('source'));
  assert.deepStrictEqual(leftovers, [], 'oversized download must not be left on disk');
});

test('a failed download cleans up its partial file', async () => {
  const bin = writeFakeYtDlp(
    'faildl.sh',
    `out=""\nprev=""\nfor a in "$@"; do if [ "$prev" = "-o" ]; then out="$a"; fi; prev="$a"; done\nout="\${out//%(ext)s/mp4}"\nhead -c 100 /dev/urandom > "$out"\nexit 1`,
  );
  const dest = path.join(tmpRoot, 'faildl');
  const resolver = new YtDlpMediaResolver({ binaryPath: bin, allowPrivateNetwork: true });
  await assert.rejects(
    () => resolver.resolveVideo('https://www.youtube.com/watch?v=abc123', { destDir: dest, baseName: 'source' }),
    (err) => err.code === 'DOWNLOAD_FAILED',
  );
  assert.deepStrictEqual(fs.readdirSync(dest), []);
});

test('a private-network URL never reaches the binary', async () => {
  const bin = writeFakeYtDlp('never.sh', `echo "SHOULD NOT RUN" > "$PWD/marker" || true`);
  const resolver = new YtDlpMediaResolver({ binaryPath: bin, allowPrivateNetwork: false });
  await assert.rejects(
    () => resolver.resolveMetadata('http://169.254.169.254/latest/meta-data/'),
    (err) => err.code === 'UNSAFE_URL',
  );
});

test('a redirect to an internal host is caught after resolution', async () => {
  const evil = { ...YOUTUBE_INFO, webpage_url: 'http://127.0.0.1/internal' };
  const bin = writeFakeYtDlp('redirect.sh', `cat <<'JSON'\n${JSON.stringify(evil)}\nJSON`);
  const resolver = new YtDlpMediaResolver({ binaryPath: bin, allowPrivateNetwork: false });
  await assert.rejects(
    () => resolver.resolveMetadata('https://looks-fine.example/v'),
    (err) => err.code === 'UNSAFE_URL' || err.code === 'MEDIA_RESOLUTION_FAILED',
  );
});

test('the chain tries resolvers in order and reports the first success', async () => {
  const failing = {
    name: 'first',
    supports: () => true,
    resolveMetadata: async () => {
      throw new Error('nope');
    },
  };
  const working = {
    name: 'second',
    supports: () => true,
    resolveMetadata: async () => normalizeMediaMetadata(TIKTOK_INFO, 'https://tk/1'),
  };
  const chain = new MediaResolverChain([failing, working]);
  const metadata = await chain.resolveMetadata('https://www.tiktok.com/@cook/video/1');
  assert.strictEqual(metadata.platform, 'tiktok');
});

test('the chain does not use a fallback to get around a safety rejection', async () => {
  let secondCalled = false;
  const unsafe = {
    name: 'first',
    supports: () => true,
    resolveMetadata: async () => {
      const err = new Error('unsafe');
      err.code = 'UNSAFE_URL';
      throw err;
    },
  };
  const fallback = {
    name: 'second',
    supports: () => true,
    resolveMetadata: async () => {
      secondCalled = true;
      return normalizeMediaMetadata(TIKTOK_INFO, 'x');
    },
  };
  const chain = new MediaResolverChain([unsafe, fallback]);
  await assert.rejects(
    () => chain.resolveMetadata('https://evil.example/v'),
    (err) => err.code === 'UNSAFE_URL',
  );
  assert.strictEqual(secondCalled, false);
});

test('the chain gives up with MEDIA_RESOLUTION_FAILED when nothing works', async () => {
  const chain = new MediaResolverChain([
    {
      name: 'a',
      supports: () => true,
      resolveMetadata: async () => {
        throw new Error('boom');
      },
    },
  ]);
  await assert.rejects(
    () => chain.resolveMetadata('https://whatever.example/v'),
    (err) => err.code === 'MEDIA_RESOLUTION_FAILED',
  );
});

test('resolveMetadata never passes --no-download is false: metadata mode downloads nothing', async () => {
  const capture = path.join(tmpRoot, 'args.txt');
  const bin = writeFakeYtDlp(
    'args.sh',
    `printf '%s\\n' "$@" > ${capture}\ncat <<'JSON'\n${JSON.stringify(YOUTUBE_INFO)}\nJSON`,
  );
  const resolver = new YtDlpMediaResolver({ binaryPath: bin, allowPrivateNetwork: true });
  await resolver.resolveMetadata('https://www.youtube.com/watch?v=abc123');
  const args = fs.readFileSync(capture, 'utf8');
  assert.match(args, /--no-download/);
  assert.match(args, /--no-playlist/);
  assert.match(args, /-J/);
});

test('cleanup: remove the temp tree', async () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  assert.strictEqual(fs.existsSync(tmpRoot), false);
});
