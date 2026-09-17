'use strict';

/**
 * Media resolution behind one interface.
 *
 * Business logic asks for `resolveMetadata(url)` and `resolveVideo(url)`. It
 * never sees a yt-dlp command line, a yt-dlp JSON key, or a format selector.
 * That is what makes it possible to swap in a paid resolver later, or to
 * upgrade yt-dlp's flags, without touching the recipe pipeline.
 *
 * The two-mode split is the cost control: `resolveMetadata` runs with
 * `--no-download` and costs a network round trip. `resolveVideo` is the
 * expensive one and is only reached after the cheap text has been judged
 * insufficient.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const config = require('./config');
const { runProcess } = require('./processRunner');
const { sanitizeFileName } = require('./tempWorkspace');
const { assertSafeResolvedUrl, assertSafeUrlShape } = require('./urlGuard');
const {
  DownloadFailedError,
  DownloadTimeoutError,
  MediaMetadataTimeoutError,
  MediaResolutionError,
  MediaToolingUnavailableError,
  VideoTooLargeError,
} = require('./errors');
const { withMediaRetry } = require('./mediaRetry');

/**
 * Which platform a URL belongs to, before we ask yt-dlp.
 *
 * The retry limiter needs a key before the resolver has run, and the host is
 * the only thing available at that point. yt-dlp's own `extractor_key` is a
 * better answer but only arrives after a successful call - which is exactly
 * when a rate limit means it does not.
 */
const PLATFORM_BY_HOST = [
  ['youtube.com', 'youtube'],
  ['youtu.be', 'youtube'],
  ['instagram.com', 'instagram'],
  ['tiktok.com', 'tiktok'],
  ['facebook.com', 'facebook'],
  ['fb.watch', 'facebook'],
  ['pinterest.com', 'pinterest'],
  ['pin.it', 'pinterest'],
  ['vimeo.com', 'vimeo'],
  ['dailymotion.com', 'dailymotion'],
  ['twitter.com', 'twitter'],
  ['x.com', 'twitter'],
];

function platformOfUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const hit = PLATFORM_BY_HOST.find(
      ([suffix]) => host === suffix || host.endsWith(`.${suffix}`),
    );
    return hit ? hit[1] : host || 'unknown';
  } catch (_err) {
    return 'unknown';
  }
}

/**
 * @typedef {Object} MediaMetadata
 * @property {string} originalUrl
 * @property {string|null} resolvedUrl
 * @property {string|null} platform          e.g. "youtube", "instagram", "tiktok"
 * @property {string|null} title
 * @property {string|null} description      the video description / social caption
 * @property {string|null} uploader
 * @property {number|null} durationSeconds
 * @property {string|null} thumbnail
 * @property {string} mediaType             "video" | "audio" | "unknown"
 * @property {boolean} isVideo
 * @property {string|null} videoId
 * @property {Array<{ext: string, height: number|null, filesizeBytes: number|null, vcodec: string|null, acodec: string|null}>} formats
 * @property {string} resolver
 */

/**
 * @typedef {Object} LocalMediaFile
 * @property {string} path
 * @property {number} bytes
 * @property {string} mimeType
 * @property {number|null} durationSeconds
 * @property {string} resolver
 */

/**
 * Collapse yt-dlp's playlist/entry shapes into the single entry we care about.
 * A recipe import is one video, never a channel.
 */
function pickEntry(info) {
  if (!info || typeof info !== 'object') return null;
  if (info._type === 'playlist') {
    const entries = Array.isArray(info.entries) ? info.entries : [];
    return entries.length > 0 ? entries[0] : null;
  }
  return info;
}

function normalizeFormats(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  return formats.map((format) => ({
    ext: format.ext || null,
    height: Number.isFinite(format.height) ? format.height : null,
    filesizeBytes:
      Number(format.filesize) || Number(format.filesize_approx) || null,
    vcodec: format.vcodec || null,
    acodec: format.acodec || null,
  }));
}

/**
 * Codec first, duration last.
 *
 * A duration is not evidence of video: a podcast episode has one too. The codec
 * is the answer when it is present, and the length only becomes the tie-breaker
 * when a resolver told us nothing about codecs at all.
 */
function looksLikeVideo(info, formats) {
  if (info?.vcodec) return info.vcodec !== 'none';
  if (formats.length > 0) {
    return formats.some((format) => format.vcodec && format.vcodec !== 'none');
  }
  const duration = Number(info?.duration);
  return Number.isFinite(duration) && duration > 0;
}

/**
 * yt-dlp's JSON -> our MediaMetadata.
 *
 * Every field is read defensively: platforms add and drop keys, and a resolver
 * that throws on a missing `channel` field turns a cosmetic change into an
 * import failure.
 */
function normalizeMediaMetadata(info, originalUrl) {
  const entry = pickEntry(info);
  if (!entry) return null;

  const formats = normalizeFormats(entry);
  const isVideo = looksLikeVideo(entry, formats);
  const duration = Number(entry.duration);

  return {
    originalUrl,
    resolvedUrl: entry.webpage_url || entry.webpage_url_base || originalUrl,
    platform: entry.extractor_key
      ? String(entry.extractor_key).toLowerCase()
      : entry.extractor
        ? String(entry.extractor).toLowerCase()
        : null,
    title: entry.title ? String(entry.title) : null,
    description: entry.description ? String(entry.description) : null,
    uploader: entry.uploader || entry.channel || entry.uploader_id || null,
    durationSeconds: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : null,
    thumbnail: entry.thumbnail || null,
    mediaType: isVideo ? 'video' : entry.acodec && entry.acodec !== 'none' ? 'audio' : 'unknown',
    isVideo,
    videoId: entry.id ? String(entry.id) : null,
    formats,
    resolver: 'yt-dlp',
  };
}

/**
 * Pick the format to download and report what it will cost.
 *
 * Preferring mp4 keeps ffmpeg's job trivial and avoids webm/mkv containers that
 * need extra muxing. The estimate is used to reject an oversized video BEFORE
 * spending 180 seconds pulling it down.
 */
function chooseDownloadFormat(formats) {
  const withVideo = formats.filter((f) => f.vcodec && f.vcodec !== 'none');
  const pool = withVideo.length > 0 ? withVideo : formats;
  const mp4 = pool.filter((f) => f.ext === 'mp4');
  const ranked = mp4.length > 0 ? mp4 : pool;
  const sized = ranked.filter((f) => f.filesizeBytes);
  const estimate = sized.length > 0
    ? Math.min(...sized.map((f) => f.filesizeBytes))
    : null;
  return { estimateBytes: estimate, count: ranked.length };
}

class YtDlpMediaResolver {
  constructor(options = {}) {
    this.name = 'yt-dlp';
    this.binaryPath = options.binaryPath || config.YT_DLP_PATH;
    this.metadataTimeoutMs =
      options.metadataTimeoutMs || config.MAX_METADATA_SECONDS * 1000;
    this.downloadTimeoutMs =
      options.downloadTimeoutMs || config.MAX_VIDEO_DOWNLOAD_SECONDS * 1000;
    this.logger = options.logger || null;
    this.allowPrivateNetwork =
      options.allowPrivateNetwork !== undefined
        ? options.allowPrivateNetwork
        : config.ALLOW_PRIVATE_NETWORK;
  }

  supports(url) {
    try {
      const parsed = assertSafeUrlShape(url);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch (_err) {
      return false;
    }
  }

  async assertTooling() {
    if (!config.MEDIA_TOOLING_AVAILABLE) {
      throw new MediaToolingUnavailableError(
        'Media tooling (yt-dlp) is not available in this deployment.',
        { binary: this.binaryPath },
      );
    }
  }

  async assertUrlSafe(url) {
    const parsed = assertSafeUrlShape(url);
    await assertSafeResolvedUrl(parsed, {
      allowPrivateNetwork: this.allowPrivateNetwork,
    });
    return parsed;
  }

  /**
   * Metadata only. `--no-download` is the whole point of this mode: no bytes
   * of the video are transferred, so the caller can decide whether they are
   * worth having.
   */
  /**
   * Public entry: metadata lookup wrapped in retry + concurrency control.
   *
   * yt-dlp is left with `--retries 1` on purpose. Retrying in two places
   * multiplies the attempts and hides which layer is responsible for the
   * delay; owning it here means one policy, one log line per wait.
   */
  async resolveMetadata(url, options = {}) {
    return withMediaRetry(() => this.resolveMetadataOnce(url), {
      platform: platformOfUrl(url),
      logger: this.logger,
      jobId: options.jobId,
      operation: 'resolve_metadata',
      limiter: options.limiter,
      maxAttempts: options.maxAttempts,
      sleepFn: options.sleepFn,
    });
  }

  async resolveMetadataOnce(url) {
    await this.assertTooling();
    await this.assertUrlSafe(url);

    const args = [
      '-J',
      '--no-download',
      '--no-warnings',
      '--no-playlist',
      '--retries', '1',
      '--socket-timeout', '15',
      url,
    ];

    const result = await runProcess(this.binaryPath, args, {
      timeoutMs: this.metadataTimeoutMs,
      maxBufferBytes: 16 * 1024 * 1024,
    });

    if (result.missing) {
      throw new MediaToolingUnavailableError(
        `yt-dlp binary not found: ${this.binaryPath}`,
        { binary: this.binaryPath },
      );
    }

    if (result.timedOut) {
      throw new MediaMetadataTimeoutError(
        'Media metadata lookup timed out.',
        { timeoutMs: this.metadataTimeoutMs },
      );
    }

    if (result.code !== 0) {
      throw new MediaResolutionError(
        'yt-dlp could not resolve this URL.',
        {
          exitCode: result.code,
          stderrTail: (result.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 400),
        },
      );
    }

    let info;
    try {
      info = JSON.parse(result.stdout);
    } catch (err) {
      throw new MediaResolutionError(
        'yt-dlp returned unparseable metadata.',
        { error: err.message },
      );
    }

    const metadata = normalizeMediaMetadata(info, url);
    if (!metadata) {
      throw new MediaResolutionError('yt-dlp returned no media entry for this URL.', {});
    }

    // The resolver may have been redirected to a different host. Re-check the
    // final target: the guard on the input URL does not cover redirects.
    if (metadata.resolvedUrl && metadata.resolvedUrl !== url) {
      try {
        const redirected = assertSafeUrlShape(metadata.resolvedUrl);
        await assertSafeResolvedUrl(redirected, {
          allowPrivateNetwork: this.allowPrivateNetwork,
        });
      } catch (err) {
        throw new MediaResolutionError(
          'Media resolution redirected to an unsafe host.',
          { reason: err.message },
        );
      }
    }

    return metadata;
  }

  /**
   * Download the video into `destDir`.
   *
   * Size is checked twice: once from the format manifest before the download
   * starts, and once against the file actually written, because a manifest can
   * lie and a stream can overrun.
   */
  /**
   * Public entry: download wrapped in retry + concurrency control.
   *
   * A retried download must not leave a partial file behind for the next
   * attempt to mistake for a complete one, so each attempt cleans its own
   * stragglers before the retry sleeps.
   */
  async resolveVideo(url, options = {}) {
    return withMediaRetry(() => this.resolveVideoOnce(url, options), {
      platform: platformOfUrl(url),
      logger: this.logger,
      jobId: options.jobId,
      operation: 'resolve_video',
      limiter: options.limiter,
      maxAttempts: options.maxAttempts,
      sleepFn: options.sleepFn,
    });
  }

  async resolveVideoOnce(url, options = {}) {
    await this.assertTooling();
    await this.assertUrlSafe(url);

    const destDir = options.destDir;
    if (!destDir) {
      throw new DownloadFailedError('resolveVideo requires a destDir.', {});
    }
    await fsp.mkdir(destDir, { recursive: true });

    const maxBytes = options.maxBytes || config.MAX_VIDEO_BYTES;
    const baseName = sanitizeFileName(options.baseName || 'video', 'video');
    const outTemplate = path.join(destDir, `${baseName}.%(ext)s`);

    const args = [
      '-f',
      'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--retries', '1',
      '--socket-timeout', '20',
      '--max-filesize', String(maxBytes),
      '-o', outTemplate,
      url,
    ];

    const result = await runProcess(this.binaryPath, args, {
      timeoutMs: options.timeoutMs || this.downloadTimeoutMs,
      maxBufferBytes: 8 * 1024 * 1024,
    });

    if (result.missing) {
      throw new MediaToolingUnavailableError(
        `yt-dlp binary not found: ${this.binaryPath}`,
        { binary: this.binaryPath },
      );
    }

    if (result.timedOut) {
      await this.removeStragglers(destDir, baseName);
      throw new DownloadTimeoutError(
        'Video download exceeded its time budget.',
        { timeoutMs: options.timeoutMs || this.downloadTimeoutMs },
      );
    }

    if (result.code !== 0) {
      await this.removeStragglers(destDir, baseName);
      throw new DownloadFailedError(
        'yt-dlp failed to download the video.',
        {
          exitCode: result.code,
          stderrTail: (result.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 400),
        },
      );
    }

    const downloaded = await this.findDownloadedFile(destDir, baseName);
    if (!downloaded) {
      throw new DownloadFailedError('yt-dlp reported success but produced no file.', {});
    }

    const stat = await fsp.stat(downloaded);
    if (stat.size > maxBytes) {
      await fsp.rm(downloaded, { force: true });
      throw new VideoTooLargeError(
        'Downloaded video exceeds the configured size limit.',
        { bytes: stat.size, limitBytes: maxBytes },
      );
    }

    if (stat.size === 0) {
      await fsp.rm(downloaded, { force: true });
      throw new DownloadFailedError('Downloaded video is empty.', {});
    }

    return {
      path: downloaded,
      bytes: stat.size,
      mimeType: mimeTypeForExtension(path.extname(downloaded)),
      durationSeconds: options.durationSeconds ?? null,
      resolver: this.name,
    };
  }

  async findDownloadedFile(destDir, baseName) {
    let entries;
    try {
      entries = await fsp.readdir(destDir);
    } catch (_err) {
      return null;
    }
    const candidates = entries
      .filter((name) => name.startsWith(baseName) && !name.endsWith('.part'))
      .map((name) => path.join(destDir, name))
      .filter((full) => fs.existsSync(full) && fs.statSync(full).isFile());
    if (candidates.length === 0) return null;
    return candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  }

  async removeStragglers(destDir, baseName) {
    try {
      const entries = await fsp.readdir(destDir);
      for (const name of entries) {
        if (name.startsWith(baseName)) {
          await fsp.rm(path.join(destDir, name), { force: true });
        }
      }
    } catch (_err) {
      // Cleanup is best-effort; the workspace cleanup is the real backstop.
    }
  }
}

function mimeTypeForExtension(ext) {
  const normalized = String(ext || '').toLowerCase();
  if (normalized === '.mp4') return 'video/mp4';
  if (normalized === '.webm') return 'video/webm';
  if (normalized === '.mov') return 'video/quicktime';
  if (normalized === '.m4a') return 'audio/mp4';
  if (normalized === '.mp3') return 'audio/mpeg';
  if (normalized === '.wav') return 'audio/wav';
  return 'application/octet-stream';
}

/**
 * Try resolvers in order.
 *
 * This is the seam a paid resolver plugs into: append one to the chain and it
 * becomes the fallback when yt-dlp's extractor breaks, with no change to any
 * caller.
 */
class MediaResolverChain {
  constructor(resolvers = [], options = {}) {
    this.resolvers = resolvers;
    this.logger = options.logger || null;
  }

  async resolveMetadata(url) {
    const failures = [];
    for (const resolver of this.resolvers) {
      if (typeof resolver.supports === 'function' && !resolver.supports(url)) {
        continue;
      }
      try {
        const metadata = await resolver.resolveMetadata(url);
        if (metadata) return metadata;
      } catch (err) {
        failures.push({ resolver: resolver.name || 'unknown', code: err.code, message: err.message });
        // A safety or tooling failure is not something the next resolver fixes.
        if (err.code === 'UNSAFE_URL' || err.code === 'MEDIA_TOOLING_UNAVAILABLE') {
          throw err;
        }
      }
    }
    throw new MediaResolutionError(
      'No media resolver could handle this URL.',
      { failures },
    );
  }

  async resolveVideo(url, options = {}) {
    const failures = [];
    for (const resolver of this.resolvers) {
      if (typeof resolver.supports === 'function' && !resolver.supports(url)) {
        continue;
      }
      try {
        const file = await resolver.resolveVideo(url, options);
        if (file) return file;
      } catch (err) {
        failures.push({ resolver: resolver.name || 'unknown', code: err.code, message: err.message });
        // Size and safety rejections are policy, not a resolver bug: trying the
        // next resolver would just be a way of getting around our own limits.
        if (
          err.code === 'UNSAFE_URL' ||
          err.code === 'VIDEO_TOO_LARGE' ||
          err.code === 'MEDIA_TOOLING_UNAVAILABLE'
        ) {
          throw err;
        }
      }
    }
    throw new MediaResolutionError('No media resolver could download this video.', {
      failures,
    });
  }
}

function createDefaultResolverChain(options = {}) {
  return new MediaResolverChain([new YtDlpMediaResolver(options)], options);
}

module.exports = {
  YtDlpMediaResolver,
  platformOfUrl,
  MediaResolverChain,
  createDefaultResolverChain,
  normalizeMediaMetadata,
  normalizeFormats,
  pickEntry,
  chooseDownloadFormat,
  mimeTypeForExtension,
};
