'use strict';

/**
 * Recipe-import configuration.
 *
 * Every limit the video escalation path needs lives here, read from the same
 * `functions/.env` file the billing layer already uses. Nothing downstream is
 * allowed to hard-code a magic number: the worker, the resolver, the
 * preprocessor and the analyzers all read from this module.
 *
 * Defaults are chosen for a 1st-gen Cloud Function with 1GB of memory and a
 * 540s timeout (see `RECIPE_IMPORT_FUNCTION_*` below), so that a worst-case
 * job - metadata + download + ffmpeg + one model call - still finishes inside
 * the function's lifetime and inside the instance's disk budget.
 */

const os = require('os');
const path = require('path');

function envStr(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return String(fallback);
  }
  return String(raw).trim();
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return Number(fallback);
  }
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return Math.trunc(n);
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return Boolean(fallback);
  }
  const value = String(raw).trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function envList(name, fallback) {
  return envStr(name, fallback)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** Master switch. When off, video escalation is refused and text-only still works. */
const RECIPE_IMPORT_ENABLED = envBool('RECIPE_IMPORT_ENABLED', true);

/**
 * Whether the heavy media pipeline may run in this process at all.
 *
 * yt-dlp and ffmpeg are external binaries. A 1st-gen Cloud Function image has
 * neither, so a deployment that has not installed/bundled them must leave this
 * false: the API then answers MEDIA_TOOLING_UNAVAILABLE instead of hanging on a
 * missing binary. The Cloud Run worker image sets it to true.
 */
const MEDIA_TOOLING_AVAILABLE = envBool('RECIPE_MEDIA_TOOLING_AVAILABLE', true);

const YT_DLP_PATH = envStr('YT_DLP_PATH', 'yt-dlp');
const FFMPEG_PATH = envStr('FFMPEG_PATH', 'ffmpeg');
const FFPROBE_PATH = envStr('FFPROBE_PATH', 'ffprobe');

/** Scratch space for downloads/frames. Overridable so Cloud Run can point at a volume. */
const TEMP_ROOT = envStr(
  'RECIPE_IMPORT_TEMP_DIR',
  path.join(os.tmpdir(), 'forkcast-recipe-import'),
);

/** Hard ceilings enforced BEFORE any expensive work happens. */
const MAX_VIDEO_DURATION_SECONDS = envInt('MAX_VIDEO_DURATION_SECONDS', 900); // 15 min
const MAX_VIDEO_BYTES = envInt('MAX_VIDEO_BYTES', 200 * 1024 * 1024); // 200 MiB
const MAX_VIDEO_DOWNLOAD_SECONDS = envInt('MAX_VIDEO_DOWNLOAD_SECONDS', 180);
const MAX_METADATA_SECONDS = envInt('MAX_MEDIA_METADATA_SECONDS', 45);

/** Frame sampling for providers that cannot take video directly. */
const FRAME_INTERVAL_SECONDS = envInt('FRAME_INTERVAL_SECONDS', 2);
const MAX_FRAMES = envInt('MAX_FRAMES', 60);
const FRAME_WIDTH = envInt('FRAME_WIDTH', 640);
/** Drop byte-identical frames (static slides, held shots) after sampling. */
const FRAME_DEDUPE = envBool('FRAME_DEDUPE', true);
/** Prefer scene-change sampling when it is available; falls back to fixed interval. */
const FRAME_SCENE_DETECTION = envBool('FRAME_SCENE_DETECTION', false);
const FRAME_SCENE_THRESHOLD = envStr('FRAME_SCENE_THRESHOLD', '0.4');

/** Extracted audio for transcription. */
const AUDIO_SAMPLE_RATE_HZ = envInt('AUDIO_SAMPLE_RATE_HZ', 16000);
const AUDIO_BITRATE_KBPS = envInt('AUDIO_BITRATE_KBPS', 32);
const AUDIO_MAX_BYTES = envInt('AUDIO_MAX_BYTES', 25 * 1024 * 1024);

/**
 * Which analyzer handles the video.
 *
 * `auto` prefers a provider that accepts a whole video (Gemini) when its key is
 * configured, and otherwise falls back to the frames+transcript path.
 */
const VIDEO_ANALYSIS_PROVIDER = envStr('VIDEO_ANALYSIS_PROVIDER', 'auto');
const VIDEO_ANALYSIS_MODEL = envStr('VIDEO_ANALYSIS_MODEL', '');
const TRANSCRIPTION_MODEL = envStr('TRANSCRIPTION_MODEL', 'whisper-1');
const TRANSCRIPTION_PROVIDER = envStr('TRANSCRIPTION_PROVIDER', 'openai');

/**
 * Direct YouTube analysis.
 *
 * A public YouTube URL can be handed to Gemini as-is: the docs list "YouTube
 * URLs" as a first-class video input method, and the model reads the frames and
 * the audio itself. That means no yt-dlp download, no ffmpeg, no frame
 * sampling, and no egress bill for pulling a 200MB clip across the Atlantic
 * just to hand it straight back to Google.
 *
 * Model choice, as of the current Gemini API docs:
 *
 *   gemini-3.5-flash-lite  $0.30 / 1M input, $2.50 / 1M output
 *   gemini-3.8-flash       $0.75 / 1M input, $3.75 / 1M output
 *   gemini-3.5-flash       $1.50 / 1M input, $9.00 / 1M output   (legacy, dominated)
 *
 * Video token math from the docs, static mode: 66 tokens/frame at low media
 * resolution, 258 at high, plus 32 tokens/second of audio - roughly 100
 * tokens/second at low and 300 at high.
 *
 * 3.5 Flash Lite is the cheapest model that still accepts video AND audio and
 * still supports agentic video understanding. Running it at HIGH media
 * resolution costs about the same as 3.8 Flash at LOW resolution, and high
 * resolution is what makes small on-screen ingredient text legible. That is
 * the trade this default makes: buy resolution, not model size.
 *
 * A 3-minute recipe video at high resolution is ~54k input tokens:
 *   54,000 / 1M x $0.30 = $0.016 in, ~2.5k out x $2.50 = $0.006
 *   ~$0.022 per YouTube import, with no download at all.
 */
const GEMINI_DIRECT_YOUTUBE_ENABLED = envBool('GEMINI_DIRECT_YOUTUBE_ENABLED', true);
const GEMINI_DIRECT_YOUTUBE_MODEL = envStr(
  'GEMINI_DIRECT_YOUTUBE_MODEL',
  'gemini-3.5-flash-lite',
);
/** low | medium | high. High is what makes on-screen text readable. */
const GEMINI_VIDEO_MEDIA_RESOLUTION = envStr('GEMINI_VIDEO_MEDIA_RESOLUTION', 'high');
/**
 * auto | static | agentic.
 *
 * The docs put it plainly: static is a single 1 FPS pass and is better for
 * short clips; agentic lets the model walk the timeline and uses up to 88%
 * fewer tokens on long-form content. `auto` picks agentic once a video is
 * long enough for that to matter.
 */
const GEMINI_VIDEO_PROCESSING_MODE = envStr('GEMINI_VIDEO_PROCESSING_MODE', 'auto');
const GEMINI_VIDEO_AGENTIC_MIN_SECONDS = envInt('GEMINI_VIDEO_AGENTIC_MIN_SECONDS', 120);

/**
 * yt-dlp retry policy.
 *
 * Social platforms rate-limit. That is normal and it is not a reason to fail
 * the import on first contact, nor a reason to hammer the endpoint. The shape
 * below is ordinary good-citizen behaviour: back off exponentially, add jitter
 * so a burst of failed jobs does not come back in lockstep, honour an explicit
 * Retry-After when the platform gives us one, and stop after a small number of
 * tries so a user is not left watching a spinner for half an hour.
 */
const MEDIA_RETRY_MAX_ATTEMPTS = envInt('MEDIA_RETRY_MAX_ATTEMPTS', 3);
const MEDIA_RETRY_BASE_MS = envInt('MEDIA_RETRY_BASE_MS', 15_000);
const MEDIA_RETRY_MAX_MS = envInt('MEDIA_RETRY_MAX_MS', 180_000);
/** +/- fraction of the delay. 0.25 on a 30s delay means 22.5s..37.5s. */
const MEDIA_RETRY_JITTER_RATIO = Number(envStr('MEDIA_RETRY_JITTER_RATIO', '0.25'));

/**
 * Concurrency, per platform.
 *
 * Two jobs hitting TikTok at once from one worker is two chances to be rate
 * limited. The limiter is per-platform so a YouTube job does not block a
 * Pinterest one, and there is a total ceiling as well because yt-dlp is CPU
 * and memory hungry alongside ffmpeg.
 */
const MEDIA_MAX_CONCURRENT_PER_PLATFORM = envInt('MEDIA_MAX_CONCURRENT_PER_PLATFORM', 1);
const MEDIA_MAX_CONCURRENT_TOTAL = envInt('MEDIA_MAX_CONCURRENT_TOTAL', 2);

/**
 * Evidence cache.
 *
 * When a viral video gets imported by a hundred people, a hundred yt-dlp hits,
 * a hundred downloads and a hundred model calls is a hundred times the same
 * answer. This caches the resolved metadata and the extracted evidence - never
 * the video file, which is the expensive thing to keep.
 */
const EVIDENCE_CACHE_ENABLED = envBool('RECIPE_EVIDENCE_CACHE_ENABLED', true);
const EVIDENCE_CACHE_COLLECTION = envStr(
  'RECIPE_EVIDENCE_CACHE_COLLECTION',
  'recipe_import_cache',
);
const EVIDENCE_CACHE_TTL_MINUTES = envInt('RECIPE_EVIDENCE_CACHE_TTL_MINUTES', 360);
/** How long a duplicate job waits for an in-flight twin to finish. */
const EVIDENCE_CACHE_DEDUPE_WAIT_MS = envInt('RECIPE_EVIDENCE_CACHE_DEDUPE_WAIT_MS', 60_000);

/**
 * Cloud Run worker.
 *
 * When set, `createRecipeImportJob` hands the job to Cloud Run over HTTP
 * instead of relying on the Firestore trigger. The worker image is the thing
 * that actually has yt-dlp and ffmpeg in it.
 */
const WORKER_URL = envStr('RECIPE_IMPORT_WORKER_URL', '');
const WORKER_DISPATCH_TIMEOUT_MS = envInt('RECIPE_IMPORT_WORKER_DISPATCH_TIMEOUT_MS', 15_000);
/**
 * Keep the Firestore trigger as a fallback when Cloud Run is not configured or
 * the dispatch failed. Turning this off means a dispatch failure is final.
 */
const WORKER_FIRESTORE_TRIGGER_ENABLED = envBool(
  'RECIPE_IMPORT_FIRESTORE_TRIGGER_ENABLED',
  true,
);

/** SSRF policy. */
const ALLOWED_PROTOCOLS = envList('RECIPE_IMPORT_ALLOWED_PROTOCOLS', 'https,http');
/**
 * Test-only escape hatch. Lets a unit test point the resolver at a localhost
 * fixture. Must stay unset in every deployed environment.
 */
const ALLOW_PRIVATE_NETWORK = envBool('RECIPE_IMPORT_ALLOW_PRIVATE_NETWORK', false);

/** Job lifecycle. */
const JOB_COLLECTION = envStr('RECIPE_IMPORT_JOB_COLLECTION', 'recipe_import_jobs');
const JOB_LEASE_SECONDS = envInt('RECIPE_IMPORT_JOB_LEASE_SECONDS', 600);
const JOB_TTL_HOURS = envInt('RECIPE_IMPORT_JOB_TTL_HOURS', 24);
const JOB_MAX_ATTEMPTS = envInt('RECIPE_IMPORT_JOB_MAX_ATTEMPTS', 2);
/** In-process guard so one instance never runs two ffmpeg jobs at once. */
const MAX_CONCURRENT_JOBS_PER_INSTANCE = envInt(
  'RECIPE_IMPORT_MAX_CONCURRENT_JOBS',
  1,
);

/**
 * Documented deployment shape for the worker.
 *
 * 1GB is enough for ffmpeg to hold a 15-minute 640px frame set plus the
 * Node heap; 540s is the 1st-gen ceiling and covers a 200MB download at a
 * conservative 1.5MB/s plus preprocessing plus one model call. maxInstances
 * is kept low because yt-dlp + ffmpeg are CPU and disk heavy and the feature
 * is an escalation path, not the default.
 */
const WORKER_MEMORY = envStr('RECIPE_IMPORT_WORKER_MEMORY', '1GB');
const WORKER_TIMEOUT_SECONDS = envInt('RECIPE_IMPORT_WORKER_TIMEOUT_SECONDS', 540);
const WORKER_MAX_INSTANCES = envInt('RECIPE_IMPORT_WORKER_MAX_INSTANCES', 2);

/** Cap on how much evidence text is handed to the recipe parser. */
const MAX_EVIDENCE_PROMPT_CHARS = envInt('MAX_EVIDENCE_PROMPT_CHARS', 60000);

function isVideoDurationAllowed(durationSeconds) {
  if (durationSeconds === undefined || durationSeconds === null) {
    // Unknown duration is not a licence to run unbounded work: treat it as
    // allowed only when the caller opted in, otherwise reject.
    return { allowed: true, durationSeconds: null };
  }
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { allowed: true, durationSeconds: null };
  }
  return {
    allowed: duration <= MAX_VIDEO_DURATION_SECONDS,
    durationSeconds: duration,
    limitSeconds: MAX_VIDEO_DURATION_SECONDS,
  };
}

function isVideoSizeAllowed(bytes) {
  if (bytes === undefined || bytes === null) {
    return { allowed: true, bytes: null };
  }
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) {
    return { allowed: true, bytes: null };
  }
  return {
    allowed: size <= MAX_VIDEO_BYTES,
    bytes: size,
    limitBytes: MAX_VIDEO_BYTES,
  };
}

/**
 * Frame sampling plan for a known duration.
 *
 * A fixed 2s interval over a 15-minute video would ask for 450 frames. The
 * cap is honoured by widening the interval instead of truncating the tail, so
 * the whole video is still covered - dropping the end of a cooking video
 * drops the finished dish.
 */
function planFrameSampling(durationSeconds, overrides = {}) {
  const interval = Math.max(
    1,
    Number(overrides.intervalSeconds || FRAME_INTERVAL_SECONDS),
  );
  const maxFrames = Math.max(1, Number(overrides.maxFrames || MAX_FRAMES));
  const duration = Number(durationSeconds);

  if (!Number.isFinite(duration) || duration <= 0) {
    return { intervalSeconds: interval, maxFrames };
  }

  const natural = Math.floor(duration / interval) + 1;
  if (natural <= maxFrames) {
    return { intervalSeconds: interval, maxFrames };
  }

  const widened = Math.ceil(duration / maxFrames);
  return {
    intervalSeconds: Math.max(interval, widened, 1),
    maxFrames,
  };
}

/**
 * Pick static or agentic video processing for a given duration.
 *
 * `auto` follows the documented guidance: short clips get a single pass, long
 * videos get the model walking the timeline. Unknown duration stays static,
 * because static is the cheaper surprise.
 */
function planVideoProcessingMode(durationSeconds, overrides = {}) {
  const requested = String(
    overrides.mode || GEMINI_VIDEO_PROCESSING_MODE || 'auto',
  )
    .toLowerCase()
    .trim();

  if (requested === 'static' || requested === 'agentic') {
    return { mode: requested, reason: 'configured' };
  }

  const duration = Number(durationSeconds);
  if (Number.isFinite(duration) && duration >= GEMINI_VIDEO_AGENTIC_MIN_SECONDS) {
    return {
      mode: 'agentic',
      reason: `duration ${Math.round(duration)}s >= ${GEMINI_VIDEO_AGENTIC_MIN_SECONDS}s`,
    };
  }
  return { mode: 'static', reason: 'short clip or unknown duration' };
}

module.exports = {
  RECIPE_IMPORT_ENABLED,
  MEDIA_TOOLING_AVAILABLE,
  YT_DLP_PATH,
  FFMPEG_PATH,
  FFPROBE_PATH,
  TEMP_ROOT,
  MAX_VIDEO_DURATION_SECONDS,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_DOWNLOAD_SECONDS,
  MAX_METADATA_SECONDS,
  FRAME_INTERVAL_SECONDS,
  MAX_FRAMES,
  FRAME_WIDTH,
  FRAME_DEDUPE,
  FRAME_SCENE_DETECTION,
  FRAME_SCENE_THRESHOLD,
  AUDIO_SAMPLE_RATE_HZ,
  AUDIO_BITRATE_KBPS,
  AUDIO_MAX_BYTES,
  VIDEO_ANALYSIS_PROVIDER,
  VIDEO_ANALYSIS_MODEL,
  TRANSCRIPTION_MODEL,
  TRANSCRIPTION_PROVIDER,
  GEMINI_DIRECT_YOUTUBE_ENABLED,
  GEMINI_DIRECT_YOUTUBE_MODEL,
  GEMINI_VIDEO_MEDIA_RESOLUTION,
  GEMINI_VIDEO_PROCESSING_MODE,
  GEMINI_VIDEO_AGENTIC_MIN_SECONDS,
  MEDIA_RETRY_MAX_ATTEMPTS,
  MEDIA_RETRY_BASE_MS,
  MEDIA_RETRY_MAX_MS,
  MEDIA_RETRY_JITTER_RATIO,
  MEDIA_MAX_CONCURRENT_PER_PLATFORM,
  MEDIA_MAX_CONCURRENT_TOTAL,
  EVIDENCE_CACHE_ENABLED,
  EVIDENCE_CACHE_COLLECTION,
  EVIDENCE_CACHE_TTL_MINUTES,
  EVIDENCE_CACHE_DEDUPE_WAIT_MS,
  WORKER_URL,
  WORKER_DISPATCH_TIMEOUT_MS,
  WORKER_FIRESTORE_TRIGGER_ENABLED,
  ALLOWED_PROTOCOLS,
  ALLOW_PRIVATE_NETWORK,
  JOB_COLLECTION,
  JOB_LEASE_SECONDS,
  JOB_TTL_HOURS,
  JOB_MAX_ATTEMPTS,
  MAX_CONCURRENT_JOBS_PER_INSTANCE,
  WORKER_MEMORY,
  WORKER_TIMEOUT_SECONDS,
  WORKER_MAX_INSTANCES,
  MAX_EVIDENCE_PROMPT_CHARS,
  isVideoDurationAllowed,
  isVideoSizeAllowed,
  planFrameSampling,
  planVideoProcessingMode,
  // exported for tests
  envInt,
  envBool,
  envStr,
};
