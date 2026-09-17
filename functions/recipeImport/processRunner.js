'use strict';

/**
 * One place that spawns external binaries.
 *
 * yt-dlp and ffmpeg are the two long poles of this pipeline, and both need the
 * same three protections: a hard timeout that actually kills the child, a cap on
 * how much output we buffer, and a clean error when the binary is missing.
 * Putting that here means the resolver and the preprocessor cannot forget it.
 */

const { spawn } = require('child_process');

const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/**
 * Run a command to completion.
 *
 * @param {string} command binary to run
 * @param {string[]} args
 * @param {{timeoutMs?: number, maxBufferBytes?: number, cwd?: string, env?: object,
 *          onStderrLine?: (line: string) => void, killSignal?: string}} [options]
 * @returns {Promise<{code: number, stdout: string, stderr: string, timedOut: boolean,
 *                   truncated: boolean, missing: boolean, durationMs: number}>}
 */
function runProcess(command, args, options = {}) {
  const startedAt = Date.now();
  const timeoutMs = Number(options.timeoutMs) || 0;
  const maxBufferBytes = Number(options.maxBufferBytes) || DEFAULT_MAX_BUFFER_BYTES;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        // Never let a shell interpret the URL: argument vector only.
        shell: false,
      });
    } catch (err) {
      resolve({
        code: -1,
        stdout: '',
        stderr: String(err && err.message ? err.message : err),
        timedOut: false,
        truncated: false,
        missing: true,
        durationMs: Date.now() - startedAt,
        error: err,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let buffered = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let stderrLineBuffer = '';

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill(options.killSignal || 'SIGKILL');
          } catch (_err) {
            // Already gone.
          }
        }, timeoutMs)
      : null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: result.code,
        stdout,
        stderr,
        timedOut,
        truncated,
        missing: result.missing === true,
        durationMs: Date.now() - startedAt,
        error: result.error,
      });
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (buffered + text.length > maxBufferBytes) {
        truncated = true;
        // Keep the head, drop the rest, and stop the child: a runaway dump is a
        // memory attack on a 1GB instance.
        const room = Math.max(0, maxBufferBytes - buffered);
        stdout += text.slice(0, room);
        try {
          child.kill('SIGKILL');
        } catch (_err) {
          // ignore
        }
        return;
      }
      buffered += text.length;
      stdout += text;
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (typeof options.onStderrLine === 'function') {
        stderrLineBuffer += text;
        const lines = stderrLineBuffer.split('\n');
        stderrLineBuffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) options.onStderrLine(line);
        }
      }
      if (buffered + text.length <= maxBufferBytes) {
        buffered += text.length;
        stderr += text;
      } else {
        truncated = true;
      }
    });

    child.on('error', (err) => {
      // ENOENT/EACCES land here rather than in a non-zero exit code.
      finish({
        code: -1,
        missing: err && (err.code === 'ENOENT' || err.code === 'EACCES'),
        error: err,
      });
    });

    child.on('close', (code) => {
      if (stderrLineBuffer.trim() && typeof options.onStderrLine === 'function') {
        options.onStderrLine(stderrLineBuffer.trim());
      }
      finish({ code: code === null || code === undefined ? -1 : code });
    });
  });
}

module.exports = {
  DEFAULT_MAX_BUFFER_BYTES,
  runProcess,
};
