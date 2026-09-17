'use strict';

/**
 * FFmpeg behind a preprocessor interface.
 *
 * Frame sampling and audio extraction are the two things a vision model that
 * cannot take a video file still needs, and both are easy to get wrong in a way
 * that costs real money: a 15-minute clip sampled at 1fps is 900 images, which
 * is a four-figure token bill for one recipe.
 *
 * So the sampling plan is computed first (`config.planFrameSampling`), capped,
 * and only then handed to ffmpeg. Nothing in the recipe pipeline builds an
 * ffmpeg command line.
 */

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');

const config = require('./config');
const { runProcess } = require('./processRunner');
const { sanitizeFileName } = require('./tempWorkspace');
const {
  NoFramesExtractedError,
  PreprocessFailedError,
  PreprocessTimeoutError,
} = require('./errors');

const DEFAULT_PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_FRAMES_TIMEOUT_MS = 120_000;
const DEFAULT_AUDIO_TIMEOUT_MS = 120_000;

class VideoPreprocessor {
  constructor(options = {}) {
    this.ffmpegPath = options.ffmpegPath || config.FFMPEG_PATH;
    this.ffprobePath = options.ffprobePath || config.FFPROBE_PATH;
    this.logger = options.logger || null;
    this.limits = {
      frameIntervalSeconds: options.frameIntervalSeconds ?? config.FRAME_INTERVAL_SECONDS,
      maxFrames: options.maxFrames ?? config.MAX_FRAMES,
      frameWidth: options.frameWidth ?? config.FRAME_WIDTH,
      dedupeFrames: options.dedupeFrames ?? config.FRAME_DEDUPE,
      sceneDetection: options.sceneDetection ?? config.FRAME_SCENE_DETECTION,
      sceneThreshold: options.sceneThreshold ?? config.FRAME_SCENE_THRESHOLD,
      audioSampleRate: options.audioSampleRate ?? config.AUDIO_SAMPLE_RATE_HZ,
      audioBitrateKbps: options.audioBitrateKbps ?? config.AUDIO_BITRATE_KBPS,
      audioMaxBytes: options.audioMaxBytes ?? config.AUDIO_MAX_BYTES,
    };
  }

  /**
   * Read duration/dimensions from the file we actually downloaded.
   *
   * The manifest from the resolver can be missing or wrong; ffmpeg's own answer
   * is what the frame plan should be built on.
   */
  async probe(videoPath) {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration,size:stream=width,height,codec_type',
      '-of', 'json',
      videoPath,
    ];
    const result = await runProcess(this.ffprobePath, args, {
      timeoutMs: DEFAULT_PROBE_TIMEOUT_MS,
      maxBufferBytes: 4 * 1024 * 1024,
    });

    if (result.timedOut) {
      throw new PreprocessTimeoutError('ffprobe timed out.', { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
    }
    if (result.missing) {
      throw new PreprocessFailedError(`ffprobe binary not found: ${this.ffprobePath}`, {});
    }
    if (result.code !== 0) {
      throw new PreprocessFailedError('Could not read the downloaded media.', {
        exitCode: result.code,
        stderrTail: (result.stderr || '').slice(-300),
      });
    }

    let parsed = {};
    try {
      parsed = JSON.parse(result.stdout || '{}');
    } catch (err) {
      throw new PreprocessFailedError('ffprobe returned unparseable output.', {
        error: err.message,
      });
    }

    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((s) => s.codec_type === 'video') || {};
    const duration = Number(parsed.format?.duration ?? videoStream.duration);

    return {
      durationSeconds: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : null,
      width: Number(videoStream.width) || null,
      height: Number(videoStream.height) || null,
      bytes: Number(parsed.format?.size) || null,
    };
  }

  /**
   * Compressed mono audio, sized for a speech-to-text model.
   *
   * 16kHz mono at a low bitrate is what every ASR endpoint wants and it keeps a
   * 15-minute track to a few megabytes instead of the ~150MB a stereo WAV is.
   */
  async extractAudio(videoPath, options = {}) {
    const destDir = options.destDir;
    if (!destDir) throw new PreprocessFailedError('extractAudio requires a destDir.', {});
    await fsp.mkdir(destDir, { recursive: true });

    const baseName = sanitizeFileName(options.baseName || 'audio', 'audio');
    const outPath = path.join(destDir, `${baseName}.mp3`);

    const args = [
      '-y',
      '-i', videoPath,
      '-vn',
      '-ac', '1',
      '-ar', String(this.limits.audioSampleRate),
      '-c:a', 'libmp3lame',
      '-b:a', `${this.limits.audioBitrateKbps}k`,
      outPath,
    ];

    const result = await runProcess(this.ffmpegPath, args, {
      timeoutMs: options.timeoutMs || DEFAULT_AUDIO_TIMEOUT_MS,
      maxBufferBytes: 4 * 1024 * 1024,
    });

    if (result.timedOut) {
      await fsp.rm(outPath, { force: true });
      throw new PreprocessTimeoutError('Audio extraction timed out.', {});
    }
    if (result.missing) {
      throw new PreprocessFailedError(`ffmpeg binary not found: ${this.ffmpegPath}`, {});
    }
    if (result.code !== 0) {
      await fsp.rm(outPath, { force: true });
      throw new PreprocessFailedError('Audio extraction failed.', {
        exitCode: result.code,
        stderrTail: (result.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 300),
      });
    }

    let stat;
    try {
      stat = await fsp.stat(outPath);
    } catch (_err) {
      throw new PreprocessFailedError('Audio extraction produced no file.', {});
    }

    if (stat.size === 0) {
      await fsp.rm(outPath, { force: true });
      throw new PreprocessFailedError('Audio extraction produced an empty file.', {});
    }

    if (stat.size > this.limits.audioMaxBytes) {
      await fsp.rm(outPath, { force: true });
      throw new PreprocessFailedError('Extracted audio exceeds the configured cap.', {
        bytes: stat.size,
        limitBytes: this.limits.audioMaxBytes,
      });
    }

    return { path: outPath, bytes: stat.size, mimeType: 'audio/mpeg' };
  }

  /**
   * Sample frames across the whole clip.
   *
   * Two strategies, both capped:
   *  - fixed interval (default): predictable cost, good for talking-head recipes;
   *  - scene change: fires on cuts, so a fast-edited reel gets frames where the
   *    food actually appears. Falls back to the interval if it finds too few.
   *
   * Byte-identical frames are dropped afterwards: a held shot of a finished
   * plate sampled 30 times is 30 copies of one image on the model's bill.
   */
  async extractFrames(videoPath, options = {}) {
    const destDir = options.destDir;
    if (!destDir) throw new PreprocessFailedError('extractFrames requires a destDir.', {});
    await fsp.mkdir(destDir, { recursive: true });

    const baseName = sanitizeFileName(options.baseName || 'frame', 'frame');
    const durationSeconds = options.durationSeconds ?? null;
    const plan = config.planFrameSampling(durationSeconds, {
      intervalSeconds: options.intervalSeconds ?? this.limits.frameIntervalSeconds,
      maxFrames: options.maxFrames ?? this.limits.maxFrames,
    });
    const width = options.width ?? this.limits.frameWidth;
    const useScenes = options.sceneDetection ?? this.limits.sceneDetection;

    const frames = useScenes
      ? await this.extractSceneFrames({ videoPath, destDir, baseName, plan, width })
      : await this.extractIntervalFrames({ videoPath, destDir, baseName, plan, width });

    if (frames.length === 0) {
      throw new NoFramesExtractedError('No frames could be extracted from the video.', {
        strategy: useScenes ? 'scene' : 'interval',
      });
    }

    const deduped = this.limits.dedupeFrames ? await this.dedupeFrames(frames) : frames;
    const finalFrames = deduped.slice(0, plan.maxFrames);

    if (finalFrames.length === 0) {
      throw new NoFramesExtractedError('Every extracted frame was a duplicate.', {});
    }

    return {
      frames: finalFrames.map((frame, index) => ({ ...frame, index })),
      plan,
      strategy: useScenes ? 'scene' : 'interval',
    };
  }

  async extractIntervalFrames({ videoPath, destDir, baseName, plan, width }) {
    const outPattern = path.join(destDir, `${baseName}_%04d.jpg`);
    const args = [
      '-y',
      '-i', videoPath,
      '-vf', `fps=1/${plan.intervalSeconds},scale='min(${width},iw)':-2`,
      '-frames:v', String(plan.maxFrames),
      '-q:v', '3',
      outPattern,
    ];

    const result = await runProcess(this.ffmpegPath, args, {
      timeoutMs: DEFAULT_FRAMES_TIMEOUT_MS,
      maxBufferBytes: 4 * 1024 * 1024,
    });
    this.assertFfmpegOk(result, 'Frame extraction failed.');

    const names = await this.listMatching(destDir, `${baseName}_`);
    return names.map((name, index) => ({
      path: path.join(destDir, name),
      timestampSeconds: Math.round(index * plan.intervalSeconds * 10) / 10,
    }));
  }

  async extractSceneFrames({ videoPath, destDir, baseName, plan, width }) {
    const outPattern = path.join(destDir, `${baseName}_%04d.jpg`);
    const args = [
      '-y',
      '-i', videoPath,
      '-vf',
      `select='gt(scene,${this.limits.sceneThreshold})',showinfo,scale='min(${width},iw)':-2`,
      '-vsync', 'vfr',
      '-frames:v', String(plan.maxFrames),
      '-q:v', '3',
      outPattern,
    ];

    const timestamps = [];
    const result = await runProcess(this.ffmpegPath, args, {
      timeoutMs: DEFAULT_FRAMES_TIMEOUT_MS,
      maxBufferBytes: 8 * 1024 * 1024,
      onStderrLine: (line) => {
        const match = /pts_time:(\d+(?:\.\d+)?)/.exec(line);
        if (match) timestamps.push(Number(match[1]));
      },
    });

    const names = await this.listMatching(destDir, `${baseName}_`);
    // Scene detection found nothing usable: fall back so the caller still gets
    // frames rather than an empty analysis.
    if (names.length === 0) {
      return this.extractIntervalFrames({ videoPath, destDir, baseName, plan, width });
    }
    if (result.code !== 0 && names.length === 0) {
      this.assertFfmpegOk(result, 'Scene-change frame extraction failed.');
    }

    return names.map((name, index) => ({
      path: path.join(destDir, name),
      timestampSeconds:
        Number.isFinite(timestamps[index])
          ? Math.round(timestamps[index] * 10) / 10
          : Math.round(index * plan.intervalSeconds * 10) / 10,
    }));
  }

  assertFfmpegOk(result, message) {
    if (result.timedOut) {
      throw new PreprocessTimeoutError(`${message} (timeout)`, {});
    }
    if (result.missing) {
      throw new PreprocessFailedError(`ffmpeg binary not found: ${this.ffmpegPath}`, {});
    }
    if (result.code !== 0) {
      throw new PreprocessFailedError(message, {
        exitCode: result.code,
        stderrTail: (result.stderr || '').split('\n').slice(-3).join(' | ').slice(0, 300),
      });
    }
  }

  async listMatching(destDir, prefix) {
    try {
      const entries = await fsp.readdir(destDir);
      return entries
        .filter((name) => name.startsWith(prefix) && name.endsWith('.jpg'))
        .sort();
    } catch (_err) {
      return [];
    }
  }

  /** Drop byte-identical frames, keeping the earliest occurrence. */
  async dedupeFrames(frames) {
    const seen = new Set();
    const kept = [];
    for (const frame of frames) {
      let hash;
      try {
        const buffer = await fsp.readFile(frame.path);
        hash = crypto.createHash('md5').update(buffer).digest('hex');
      } catch (_err) {
        kept.push(frame);
        continue;
      }
      if (seen.has(hash)) {
        await fsp.rm(frame.path, { force: true });
        continue;
      }
      seen.add(hash);
      kept.push(frame);
    }
    return kept;
  }
}

module.exports = {
  VideoPreprocessor,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_FRAMES_TIMEOUT_MS,
  DEFAULT_AUDIO_TIMEOUT_MS,
};
