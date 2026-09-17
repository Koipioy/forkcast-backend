# ---------------------------------------------------------------------------
# Forkast recipe-import worker
#
# The container that makes the heavy path possible. A standard Cloud Functions
# image has neither yt-dlp nor ffmpeg, and pretending otherwise means every
# video import fails on a missing binary. Here we own the image, so we own the
# tooling.
#
# Build from the repo root:
#   docker build -f deploy/recipe-import-worker/Dockerfile -t \
#     us-central1-docker.pkg.dev/forkast-da914/recipe-import/worker:latest .
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim

# Pinned so a rebuild next month produces the same image we tested today.
# yt-dlp breaks against social platforms regularly; when it does, the fix is a
# deliberate version bump with a re-run of the tests, not a surprise at 3am.
ARG YTDLP_VERSION=2026.03.17
# Optional but strongly advised for production images: the SHA256 of the
# standalone yt-dlp binary. When set, the build fails rather than pulling a
# tampered or wrong artifact.
ARG YTDLP_SHA256=3bda0968a01cde70d26720653003b28553c71be14dcb2e5f4c24e9921fdad745

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    # Point the app at the binaries we install here rather than hoping they are
    # on PATH under whatever name the base image happens to provide.
    YT_DLP_PATH=/usr/local/bin/yt-dlp \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    RECIPE_MEDIA_TOOLING_AVAILABLE=true \
    RECIPE_IMPORT_TEMP_DIR=/tmp/forkcast-recipe-import

# python3          - yt-dlp is a Python zipapp. The "standalone" release
#                   bundles its *dependencies*, not the interpreter. Without
#                   this the binary fails at exec with
#                   `/usr/bin/env: 'python3': No such file or directory`.
# ca-certificates  - TLS to YouTube/Instagram/Firestore/Gemini
# ffmpeg + ffprobe - frame and audio extraction
# curl             - healthcheck
# tini             - PID 1, so orphaned ffmpeg children get reaped rather
#                   than leaking until the container fills with zombies
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      ffmpeg \
      python3 \
      tini \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp's standalone Linux binary is a self-contained zipapp with its
# dependencies bundled. It is used in preference to a pip install because it
# has no interaction with Debian's site-packages, needs no
# `--break-system-packages`, and cannot drift a transitive dependency out
# from under anything else in the image. The interpreter still comes from apt,
# so it gets Debian's security updates.
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp" \
 && chmod +x /usr/local/bin/yt-dlp \
 && if [ -n "${YTDLP_SHA256}" ]; then \
      echo "${YTDLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum -c - ; \
    else \
      echo "WARNING: YTDLP_SHA256 not supplied - artifact is UNVERIFIED" ; \
    fi \
 && yt-dlp --version \
 && ffmpeg -version -hide_banner | head -1 \
 && ffprobe -version -hide_banner | head -1

WORKDIR /app

# Install dependencies first so a source-only change does not reinstall the
# world on every build.
COPY functions/package*.json ./functions/
RUN cd functions && npm ci --omit=dev && npm cache clean --force

COPY functions/ ./functions/

# The scratch directory ffmpeg writes frames into. On Cloud Run this is the
# in-memory /tmp, which counts against the instance memory limit - which is
# why the frame cap and the video byte cap exist rather than being optional.
RUN mkdir -p /tmp/forkcast-recipe-import && chmod 1777 /tmp/forkcast-recipe-import

# Cloud Run injects PORT. 8080 is the conventional default for local runs.
ENV PORT=8080
EXPOSE 8080

# The worker logs its yt-dlp / ffmpeg / node versions at startup, so the
# running image is self-documenting in Cloud Run logs.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

# tini as PID 1 so SIGTERM reaches Node cleanly and ffmpeg orphans are reaped.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "functions/recipeImport/cloudRun/server.js"]
