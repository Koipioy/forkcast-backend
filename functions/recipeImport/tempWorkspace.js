'use strict';

/**
 * Per-job scratch space.
 *
 * A video import writes a download, an audio track and up to MAX_FRAMES images
 * into one directory, then must remove all of it - including when the model
 * call throws halfway through. Leaked frames in /tmp on a warm instance add up
 * to a full disk and a failed instance for the next user.
 *
 * Remote filenames are never trusted: yt-dlp can return a title containing
 * "../../etc/cron.d/x", so every name goes through `sanitizeFileName` and every
 * resolved path is checked to still be inside the job directory.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const { TEMP_ROOT } = require('./config');

const SAFE_NAME_RE = /[^A-Za-z0-9._-]+/g;
const MAX_NAME_LENGTH = 80;

/**
 * Turn anything (a video title, a URL segment) into a filename that cannot
 * escape a directory, hide an extension trick, or blow up a shell.
 */
function sanitizeFileName(rawName, fallback = 'file') {
  if (rawName === null || rawName === undefined) return fallback;
  let name = String(rawName)
    // Drop directory components a remote source may have smuggled in.
    .replace(/[\\/]/g, '_')
    .replace(SAFE_NAME_RE, '_')
    // Leading dots make hidden files and `..` tricks.
    .replace(/^\.+/, '')
    .replace(/_{2,}/g, '_')
    .trim();

  if (name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH).replace(/_+$/, '');
  }
  if (!name || name === '.' || name === '..') return fallback;
  return name;
}

function safeJobId(rawJobId) {
  const id = sanitizeFileName(rawJobId, 'job').slice(0, 48);
  return id || 'job';
}

/**
 * Create the scratch directory for one job.
 *
 * A random suffix rides alongside the job id so a retried job never collides
 * with the half-finished directory of the attempt that just died.
 */
async function createTempWorkspace(jobId, options = {}) {
  const root = options.root || TEMP_ROOT;
  const suffix = crypto.randomBytes(6).toString('hex');
  const dir = path.join(root, `${safeJobId(jobId)}-${suffix}`);

  await fsp.mkdir(dir, { recursive: true });

  const workspace = {
    jobId: safeJobId(jobId),
    root,
    dir,
    createdFiles: [],

    /** Resolve a name inside the job dir, refusing anything that escapes. */
    pathFor(rawName) {
      const resolved = path.resolve(dir, sanitizeFileName(rawName));
      if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
        throw new Error(`Path escapes the job workspace: ${rawName}`);
      }
      return resolved;
    },

    /** Register a produced file so its size can be reported and removed. */
    track(filePath) {
      this.createdFiles.push(filePath);
      return filePath;
    },

    async sizeBytes() {
      let total = 0;
      for (const file of this.createdFiles) {
        try {
          const stat = await fsp.stat(file);
          if (stat.isFile()) total += stat.size;
        } catch (_err) {
          // Already gone; nothing to count.
        }
      }
      return total;
    },

    /**
     * Remove the whole job directory.
     *
     * Idempotent and never throws: this runs from `finally` blocks, and an
     * error here would replace the real failure in the logs.
     */
    async cleanup() {
      try {
        await fsp.rm(this.dir, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        try {
          fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 3 });
        } catch (_syncErr) {
          return { cleaned: false, error: _syncErr && _syncErr.message };
        }
      }
      this.createdFiles = [];
      return { cleaned: true };
    },
  };

  return workspace;
}

module.exports = {
  SAFE_NAME_RE,
  MAX_NAME_LENGTH,
  sanitizeFileName,
  safeJobId,
  createTempWorkspace,
};
