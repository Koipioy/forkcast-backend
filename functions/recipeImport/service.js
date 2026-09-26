'use strict';

/**
 * The escalation ladder, in one function.
 *
 * Cheap first, expensive last:
 *   1. structured recipe data the caller already has
 *   2. page text the caller already scraped
 *   3. caption / video description from resolver metadata (no download)
 *   4. a sufficiency check over all of that
 *   5. only then: download
 *   6. only then: ffmpeg
 *   7. only then: a model looks at the video
 *
 * Every step that can end the job early does, and the temp workspace is removed
 * in a `finally` whether the job succeeded, failed, or threw on the way out.
 */

const config = require('./config');
const {
  EVIDENCE_SOURCES,
  addIngredient,
  addInstruction,
  addServings,
  addTiming,
  addTitle,
  createEvidenceBundle,
  evidenceToText,
  mergeEvidenceBundles,
  summarizeEvidence,
} = require('./evidence');
const {
  MediaNotVideoError,
  VideoTooLargeError,
  VideoTooLongError,
  toRecipeImportError,
} = require('./errors');
const { logger: defaultLogger } = require('./logging');
const { createDefaultResolverChain } = require('./mediaResolver');
const { createTempWorkspace } = require('./tempWorkspace');
const { mimeTypeForExtension } = require('./mediaResolver');
const fsp = require('fs/promises');
const path = require('path');
const { VideoPreprocessor } = require('./videoPreprocessor');
const { assessTextSufficiency } = require('./sufficiency');
const {
  resolveVideoAnalyzer,
  resolveYouTubeDirectAnalyzer,
  shouldUseDirectYouTube,
} = require('./analyzers');
const { STAGES } = require('./logging');
const evidenceCache = require('./evidenceCache');

/**
 * Metadata only. No bytes of video move.
 *
 * This is what the app calls before it decides anything: it gets the platform,
 * the title, the caption/description and the duration, and can run its own
 * recipe pass over them for the price of one function call.
 */
async function collectMediaEvidence(url, options = {}) {
  const logger = options.logger || defaultLogger;
  const chain = options.resolverChain || createDefaultResolverChain({ logger });

  const metadata = await chain.resolveMetadata(url);

  const bundle = createEvidenceBundle({
    originalUrl: url,
    platform: metadata.platform,
    videoDurationSeconds: metadata.durationSeconds,
  });

  if (metadata.title) {
    addTitle(bundle, metadata.title, EVIDENCE_SOURCES.TITLE);
  }
  if (metadata.description) {
    // A social post's caption and a YouTube description are the same kind of
    // evidence: text a human wrote to describe the video.
    const source = isSocialPlatform(metadata.platform)
      ? EVIDENCE_SOURCES.CAPTION
      : EVIDENCE_SOURCES.DESCRIPTION;
    addInstruction(bundle, metadata.description, source);
  }
  if (metadata.uploader) {
    bundle.sourceMetadata.uploader = metadata.uploader;
  }

  logger.info('media_metadata_resolved', {
    url,
    platform: metadata.platform,
    isVideo: metadata.isVideo,
    durationSeconds: metadata.durationSeconds,
    descriptionChars: (metadata.description || '').length,
    formatCount: metadata.formats.length,
  });

  return { media: metadata, evidence: bundle };
}

function isSocialPlatform(platform) {
  return ['instagram', 'tiktok', 'facebook', 'twitter', 'x', 'pinterest'].includes(
    String(platform || '').toLowerCase(),
  );
}

/**
 * Seed a bundle from whatever the caller already has, before any media work.
 */
function seedEvidenceFromCaller(url, options = {}) {
  const bundle = createEvidenceBundle({ originalUrl: url });

  if (options.structuredRecipe) {
    const recipe = options.structuredRecipe;
    if (recipe.title) addTitle(bundle, recipe.title, EVIDENCE_SOURCES.STRUCTURED_RECIPE);
    for (const ing of recipe.ingredients || []) {
      const text = typeof ing === 'string' ? ing : [ing.amount, ing.name].filter(Boolean).join(' ');
      addIngredient(bundle, text, EVIDENCE_SOURCES.STRUCTURED_RECIPE);
    }
    for (const step of recipe.instructions || []) {
      addInstruction(bundle, step, EVIDENCE_SOURCES.STRUCTURED_RECIPE);
    }
    if (recipe.servings) addServings(bundle, recipe.servings, EVIDENCE_SOURCES.STRUCTURED_RECIPE);
  }

  if (options.pageText) {
    addInstruction(bundle, String(options.pageText).slice(0, 20000), EVIDENCE_SOURCES.WEBPAGE_TEXT);
  }
  if (options.caption) {
    addInstruction(bundle, String(options.caption), EVIDENCE_SOURCES.CAPTION);
  }
  return bundle;
}

/**
 * The heavy half of the ladder: download, preprocess, analyze.
 *
 * Kept separate from the decision-making so it can be lifted onto a Cloud Run
 * worker without touching the routing logic above it.
 */
async function analyzeVideoEvidence(url, options = {}) {
  const logger = options.logger || defaultLogger;
  const jobId = options.jobId || 'inline';
  const chain = options.resolverChain || createDefaultResolverChain({ logger });
  const startedAt = Date.now();

  // A caller that already has the file - a direct upload, a share-sheet
  // hand-off - must not be made to produce a URL for it. The resolver exists
  // to turn a link into bytes; bytes already in hand skip it entirely.
  const localVideoPath = options.videoFile || null;
  if (localVideoPath) {
    logger.info(STAGES.LOCAL_VIDEO_SUPPLIED, {
      jobId,
      platform: options.platform || 'local',
      source: options.videoSource || 'upload',
    });
  }

  const metadata =
    localVideoPath
      ? options.media || buildLocalMediaMetadata(url, options)
      : options.media || (await chain.resolveMetadata(url));

  if (!metadata.isVideo) {
    throw new MediaNotVideoError('The resolved media is not a video.', {
      mediaType: metadata.mediaType,
    });
  }

  // Duration gate BEFORE the download: rejecting a 40-minute video after
  // pulling 800MB down is a waste nobody should pay for.
  const durationCheck = config.isVideoDurationAllowed(metadata.durationSeconds);
  if (!durationCheck.allowed) {
    throw new VideoTooLongError(
      'Video exceeds the maximum duration for recipe analysis.',
      {
        durationSeconds: durationCheck.durationSeconds,
        limitSeconds: durationCheck.limitSeconds,
      },
    );
  }

  // Size gate on the manifest, before the download, for the same reason.
  const declaredBytes = pickDeclaredBytes(metadata);
  const sizeCheck = config.isVideoSizeAllowed(declaredBytes);
  if (!sizeCheck.allowed) {
    throw new VideoTooLargeError(
      'Video exceeds the maximum download size.',
      { bytes: sizeCheck.bytes, limitBytes: sizeCheck.limitBytes },
    );
  }

  const workspace = await createTempWorkspace(jobId);
  let cleanupResult = null;

  try {
    logger.info('video_download_started', {
      jobId,
      url,
      platform: metadata.platform,
      durationSeconds: metadata.durationSeconds,
      maxBytes: config.MAX_VIDEO_BYTES,
    });

    let mediaFile;
    if (localVideoPath) {
      const stat = await fsp.stat(localVideoPath);
      mediaFile = {
        path: localVideoPath,
        bytes: stat.size,
        mimeType:
          options.mimeType ||
          mimeTypeForExtension(path.extname(localVideoPath)),
        durationSeconds: metadata.durationSeconds,
        resolver: 'local',
      };
      // The workspace does not own a caller-supplied file, so it is tracked
      // without being deleted: we must not remove a file we were only lent.
    } else {
      mediaFile = await chain.resolveVideo(url, {
        destDir: workspace.dir,
        baseName: 'source',
        maxBytes: config.MAX_VIDEO_BYTES,
        durationSeconds: metadata.durationSeconds,
        jobId,
      });
      workspace.track(mediaFile.path);
    }

    logger.info('video_download_completed', {
      jobId,
      bytes: mediaFile.bytes,
      mimeType: mediaFile.mimeType,
      durationMs: Date.now() - startedAt,
    });

    // Injectable so the ladder can be tested without ffmpeg, and so a different
    // preprocessor (hardware acceleration, a different sampler) can be swapped
    // in without touching this file.
    const preprocessor = options.preprocessor || new VideoPreprocessor({ logger });
    const probe = await preprocessor.probe(mediaFile.path);
    const effectiveDuration = probe.durationSeconds ?? metadata.durationSeconds;

    // Re-check with the real duration from the file: manifests lie.
    const realDurationCheck = config.isVideoDurationAllowed(effectiveDuration);
    if (!realDurationCheck.allowed) {
      throw new VideoTooLongError(
        'Video is longer than allowed once measured.',
        {
          durationSeconds: realDurationCheck.durationSeconds,
          limitSeconds: realDurationCheck.limitSeconds,
        },
      );
    }

    const audio = await preprocessor.extractAudio(mediaFile.path, {
      destDir: workspace.dir,
      baseName: 'audio',
    });
    workspace.track(audio.path);

    const frameResult = await preprocessor.extractFrames(mediaFile.path, {
      destDir: workspace.dir,
      baseName: 'frame',
      durationSeconds: effectiveDuration,
    });
    for (const frame of frameResult.frames) workspace.track(frame.path);

    logger.info('video_preprocessing_completed', {
      jobId,
      durationSeconds: effectiveDuration,
      frameCount: frameResult.frames.length,
      frameIntervalSeconds: frameResult.plan.intervalSeconds,
      frameStrategy: frameResult.strategy,
      audioBytes: audio.bytes,
    });

    const analyzer = options.analyzer || resolveVideoAnalyzer({
      provider: options.provider,
      model: options.model,
      deps: {
        uid: options.uid,
        email: options.email,
        jobId,
        logger,
        meteredAICall: options.meteredAICall,
        callLLM: options.callLLM,
        transcribeFn: options.transcribeFn,
      },
    });

    logger.info('video_analysis_started', {
      jobId,
      analyzer: analyzer.id,
      provider: analyzer.provider || null,
      frameCount: frameResult.frames.length,
    });

    const analysis = await analyzer.analyze({
      videoPath: mediaFile.path,
      mimeType: mediaFile.mimeType,
      audioPath: audio.path,
      frames: frameResult.frames,
      mediaMetadata: metadata,
      contextText: options.contextText || null,
    });

    logger.info('video_analysis_completed', {
      jobId,
      analyzer: analysis.analyzer,
      provider: analysis.provider,
      model: analysis.model,
      frameCount: analysis.frameCount,
      transcriptChars: analysis.transcriptText ? analysis.transcriptText.length : 0,
      evidence: summarizeEvidence(analysis.evidence),
      chargedMicros: analysis.billing?.chargedMicros ?? null,
    });

    return {
      media: metadata,
      evidence: analysis.evidence,
      transcriptText: analysis.transcriptText || null,
      frameCount: analysis.frameCount,
      analyzer: analysis.analyzer,
      provider: analysis.provider,
      model: analysis.model,
      billing: analysis.billing || null,
      durationSeconds: effectiveDuration,
    };
  } finally {
    cleanupResult = await workspace.cleanup();
    logger.info('recipe_import_cleanup', {
      jobId,
      cleaned: cleanupResult.cleaned,
      filesRemoved: true,
    });
  }
}

function pickDeclaredBytes(metadata) {
  const sizes = (metadata.formats || [])
    .filter((format) => format.filesizeBytes)
    .map((format) => format.filesizeBytes);
  if (sizes.length === 0) return null;
  // The smallest declared size for a usable stream: if even that is over the
  // limit, nothing we could download would fit.
  return Math.min(...sizes);
}

/**
 * Minimal metadata for a video we were handed directly.
 *
 * There is no resolver to ask and no manifest to read, so the shape is
 * constructed rather than discovered. The ffmpeg probe that follows is what
 * actually establishes duration, and the duration gate runs again against
 * that measurement, so a guess here cannot smuggle an oversized file past
 * the cost controls.
 */
function buildLocalMediaMetadata(url, options = {}) {
  return {
    originalUrl: url || null,
    resolvedUrl: null,
    platform: options.platform || 'local',
    title: options.title || null,
    description: options.caption || null,
    uploader: null,
    durationSeconds: Number.isFinite(Number(options.durationSeconds))
      ? Number(options.durationSeconds)
      : null,
    thumbnail: null,
    mediaType: 'video',
    isVideo: true,
    videoId: null,
    formats: [],
    resolver: 'local',
  };
}

/**
 * Count the video-derived claims in a bundle.
 *
 * Used to answer a question the sufficiency heuristic cannot: did the video
 * actually tell us anything? Escalating is only worth its cost if it moved
 * the recipe, and "we ran a model" is not the same as "we learned something".
 */
function countVideoSourcedItems(bundle) {
  const videoSources = new Set([
    EVIDENCE_SOURCES.TRANSCRIPT,
    EVIDENCE_SOURCES.ONSCREEN_TEXT,
    EVIDENCE_SOURCES.VISUAL_OBSERVATION,
  ]);
  let count = 0;
  for (const field of ['ingredientCandidates', 'instructionCandidates', 'timingCandidates']) {
    for (const item of bundle[field] || []) {
      if (videoSources.has(item.source)) count += 1;
    }
  }
  return count;
}

function countByField(bundle) {
  return {
    ingredients: (bundle.ingredientCandidates || []).length,
    instructions: (bundle.instructionCandidates || []).length,
  };
}

/**
 * The YouTube fast path: hand the URL to Gemini, download nothing.
 *
 * Returns null when the path is not available or did not produce evidence,
 * which sends the caller to the resolver. A failure here is not fatal and is
 * not reported as one - the resolver is a legitimate second attempt, and the
 * two paths fail for unrelated reasons.
 */
async function tryDirectYouTubeAnalysis(url, media, contextText, options = {}) {
  const logger = options.logger || defaultLogger;
  const jobId = options.jobId || 'inline';

  if (!shouldUseDirectYouTube(url, options)) return null;

  const analyzer =
    options.directAnalyzer ||
    resolveYouTubeDirectAnalyzer({
      deps: {
        uid: options.uid,
        email: options.email,
        jobId,
        logger,
        meteredAICall: options.meteredAICall,
      },
      model: options.model,
    });

  if (!analyzer) return null;

  logger.info(STAGES.VIDEO_DIRECT_URL_STARTED, {
    jobId,
    url,
    platform: media?.platform || 'youtube',
    model: analyzer.model,
    mediaResolution: analyzer.mediaResolution,
    durationSeconds: media?.durationSeconds ?? null,
  });

  try {
    const analysis = await analyzer.analyze({
      url,
      mediaMetadata: media,
      contextText,
      durationSeconds: media?.durationSeconds ?? null,
    });

    if (!analysis || !analysis.evidence) return null;

    logger.info(STAGES.VIDEO_ANALYSIS_COMPLETED, {
      jobId,
      analyzer: analysis.analyzer,
      provider: analysis.provider,
      model: analysis.model,
      path: 'direct_url',
      downloadBytes: 0,
      frameCount: 0,
      evidence: summarizeEvidence(analysis.evidence),
      chargedMicros: analysis.billing?.chargedMicros ?? null,
    });

    return {
      media,
      evidence: analysis.evidence,
      transcriptText: analysis.transcriptText || null,
      frameCount: 0,
      analyzer: analysis.analyzer,
      provider: analysis.provider,
      model: analysis.model,
      processingMode: analysis.processingMode || null,
      mediaResolution: analysis.mediaResolution || null,
      billing: analysis.billing || null,
      downloadBytes: 0,
      directUrl: true,
    };
  } catch (err) {
    const typed = toRecipeImportError(err);
    logger.warn(STAGES.VIDEO_DIRECT_URL_FAILED, {
      jobId,
      url,
      code: typed.code,
      status: typed.status ?? null,
      message: typed.message,
      fallback: 'resolver',
    });
    return null;
  }
}

/**
 * Video analysis wrapped in the evidence cache.
 *
 * The expensive half of the pipeline sits behind this. A second import of the
 * same public video reads the answer instead of paying for it again, and a
 * third one that arrives while the first is still running waits for it rather
 * than starting a parallel download of the same file.
 *
 * A cache hit carries no billing: nothing was called, so nothing is charged.
 */
async function analyzeVideoEvidenceCached(url, options = {}) {
  const logger = options.logger || defaultLogger;
  const jobId = options.jobId || 'inline';
  const db = options.db;
  const key = options.cacheKey;

  if (!db || !config.EVIDENCE_CACHE_ENABLED || !key) {
    return analyzeVideoEvidence(url, options);
  }

  const reservation = await evidenceCache.reserveCacheKey(db, key, jobId);

  if (!reservation.acquired) {
    if (reservation.reason === 'cached') {
      logger.info(STAGES.MEDIA_CACHE_HIT, {
        jobId,
        url,
        platform: reservation.entry?.platform || null,
        cachedJobId: reservation.entry?.jobId || null,
      });
      return {
        media: options.media,
        evidence: reservation.entry.evidence,
        evidenceText: reservation.entry.evidenceText || null,
        transcriptText: null,
        frameCount: 0,
        analyzer: 'cache',
        provider: null,
        model: null,
        billing: null,
        fromCache: true,
      };
    }

    if (reservation.reason === 'in_flight') {
      logger.info(STAGES.MEDIA_CACHE_DEDUPE_WAIT, {
        jobId,
        url,
        waitingForJobId: reservation.entry?.jobId || null,
        maxWaitMs: config.EVIDENCE_CACHE_DEDUPE_WAIT_MS,
      });
      const waited = await evidenceCache.waitForCacheResult(db, key, {
        sleepFn: options.sleepFn,
      });
      if (waited) {
        logger.info(STAGES.MEDIA_CACHE_HIT, {
          jobId,
          url,
          platform: waited.platform || null,
          cachedJobId: waited.jobId || null,
          afterWait: true,
        });
        return {
          media: options.media,
          evidence: waited.evidence,
          evidenceText: waited.evidenceText || null,
          transcriptText: null,
          frameCount: 0,
          analyzer: 'cache',
          provider: null,
          model: null,
          billing: null,
          fromCache: true,
        };
      }
      logger.warn(STAGES.MEDIA_CACHE_DEDUPE_WAIT, {
        jobId,
        url,
        outcome: 'timed_out_running_own',
      });
    }
  }

  try {
    const result = await analyzeVideoEvidence(url, options);
    const stored = await evidenceCache.storeCacheResult(db, key, {
      jobId,
      platform: result.media?.platform || null,
      canonicalUrl: result.media?.resolvedUrl || url,
      media: summarizeMediaForCache(result.media),
      evidence: result.evidence,
      evidenceText: evidenceToText(result.evidence, {
        maxChars: config.MAX_EVIDENCE_PROMPT_CHARS,
      }),
    });
    if (stored) {
      logger.info(STAGES.MEDIA_CACHE_STORED, {
        jobId,
        url,
        platform: result.media?.platform || null,
        ttlMinutes: config.EVIDENCE_CACHE_TTL_MINUTES,
      });
    }
    return result;
  } catch (err) {
    await evidenceCache.releaseCacheKey(db, key, jobId);
    throw err;
  }
}

/**
 * Shrink metadata before it goes in the cache.
 *
 * The format list is download bookkeeping and can run to hundreds of entries.
 * Nothing downstream reads it after the download decision has been made, so
 * keeping it would bloat the document for no reason.
 */
function summarizeMediaForCache(media) {
  if (!media) return null;
  return {
    originalUrl: media.originalUrl || null,
    resolvedUrl: media.resolvedUrl || null,
    platform: media.platform || null,
    title: media.title || null,
    description: media.description || null,
    uploader: media.uploader || null,
    durationSeconds: media.durationSeconds ?? null,
    isVideo: Boolean(media.isVideo),
    mediaType: media.mediaType || null,
    videoId: media.videoId || null,
    formats: [],
  };
}

/**
 * The single high-level entry point.
 *
 * Routing, in order of increasing cost:
 *
 *   1. text the caller already has            free
 *   2. metadata, no download                one cheap call
 *   3. sufficiency check                    free
 *   4. cached video evidence                one document read
 *   5. Gemini reads the YouTube URL         input tokens only
 *   6. yt-dlp + ffmpeg + model             download + compute + tokens
 *
 * Each step gets a chance to end the job before the next one starts. The
 * temp workspace is removed in a `finally` whether the job succeeded,
 * failed, or threw on the way out.
 *
 * @param {string} url
 * @param {{pageText?: string, caption?: string, structuredRecipe?: object,
 *          videoFile?: string, skipSufficiencyCheck?: boolean, uid?: string,
 *          email?: string, provider?: string, model?: string, jobId?: string,
 *          db?: object, cacheKey?: string,
 *          meteredAICall?: Function, logger?: object, resolverChain?: object}} options
 * @returns {Promise<{escalated: boolean, evidence: object, media: object|null,
 *                   sufficiency: object, videoResult: object|null}>}
 */
async function extractRecipeFromUrl(url, options = {}) {
  const logger = options.logger || defaultLogger;
  const jobId = options.jobId || 'inline';
  const callerBundle = seedEvidenceFromCaller(url, options);

  // Ask the cheap question before paying for the expensive one.
  //
  // The resolver below spawns yt-dlp and makes a network round trip to find
  // out whether this URL carries a video. A blog post that already handed us
  // its whole recipe in scraped page text never needs that answer, but until
  // now it paid for it anyway: a process spawn and a round trip on every
  // text-only import, and on a deployment without the binary a
  // MEDIA_METADATA_FAILED line every time, which is noise that buries the
  // alarms that matter.
  //
  // Only the caller's own text is weighed here. If it falls short we fall
  // straight through and probe exactly as before, so a YouTube page whose
  // description is what makes it sufficient still gets that description, and
  // no escalation path changes behaviour.
  if (!options.videoFile && !options.skipSufficiencyCheck) {
    const callerSufficiency = assessTextSufficiency(
      {
        title: options.structuredRecipe?.title || null,
        text: [options.pageText || '', options.caption || ''].filter(Boolean).join('\n\n'),
        structuredRecipe: options.structuredRecipe,
      },
      options.sufficiency,
    );

    if (callerSufficiency.sufficient) {
      logger.info(STAGES.TEXT_RECIPE_SUFFICIENT, {
        jobId,
        url,
        score: callerSufficiency.score,
        missing: callerSufficiency.missing,
        platform: null,
        isVideo: false,
        mediaProbeSkipped: true,
      });
      logger.info(STAGES.TEXT_ONLY_SUCCESS, {
        jobId,
        url,
        platform: null,
        score: callerSufficiency.score,
        evidence: summarizeEvidence(callerBundle),
        mediaProbeSkipped: true,
      });
      return {
        escalated: false,
        evidence: callerBundle,
        media: null,
        sufficiency: callerSufficiency,
        videoResult: null,
        mediaProbeSkipped: true,
      };
    }
  }

  let media = null;
  // Recorded rather than logged immediately. Whether a missing binary matters
  // depends on something we do not know yet: whether the text turns out to be
  // enough. A sufficient page text means the tooling was never needed, and
  // raising an alarm for it would bury the alarms that do matter.
  let toolingBlocked = false;
  let toolingMessage = null;

  // A caller that handed us the file has nothing to probe: there is no link
  // behind it, and probing one would be a network call in search of a video we
  // are already holding.
  if (options.videoFile) {
    media = options.media || buildLocalMediaMetadata(url, options);
  } else
    try {
      const collected = await collectMediaEvidence(url, {
        logger,
        resolverChain: options.resolverChain,
      });
      media = collected.media;
      mergeEvidenceBundles(callerBundle, collected.evidence);
    } catch (err) {
      const typed = toRecipeImportError(err);
      if (typed.code === 'MEDIA_TOOLING_UNAVAILABLE') {
        toolingBlocked = true;
        toolingMessage = typed.message;
      }
      // Metadata failing must not kill an import that may already have a
      // usable recipe from the page. Record it and carry on.
      logger.warn(STAGES.MEDIA_METADATA_FAILED, {
        jobId,
        url,
        code: typed.code,
        message: typed.message,
      });
    }

  const combinedText = [
    options.pageText || '',
    options.caption || '',
    media?.description || '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const sufficiency = assessTextSufficiency(
    {
      title: options.structuredRecipe?.title || media?.title,
      text: combinedText,
      structuredRecipe: options.structuredRecipe,
    },
    options.sufficiency,
  );

  logger.info(sufficiency.sufficient ? STAGES.TEXT_RECIPE_SUFFICIENT : STAGES.TEXT_RECIPE_INSUFFICIENT, {
    jobId,
    url,
    score: sufficiency.score,
    missing: sufficiency.missing,
    platform: media?.platform || null,
    isVideo: Boolean(media?.isVideo),
  });

  if (sufficiency.sufficient && !options.skipSufficiencyCheck) {
    logger.info(STAGES.TEXT_ONLY_SUCCESS, {
      jobId,
      url,
      platform: media?.platform || null,
      score: sufficiency.score,
      evidence: summarizeEvidence(callerBundle),
    });
    return {
      escalated: false,
      evidence: callerBundle,
      media,
      sufficiency,
      videoResult: null,
    };
  }

  // Computed before the gates below, because it changes what they mean.
  //
  // The direct-URL path needs nothing from yt-dlp: the video is handed to
  // Gemini by link. So a failed or unavailable resolver is not a reason to
  // skip it. Gating it on `media.isVideo` meant that whenever yt-dlp could
  // not read a YouTube page - which is most of the time from a datacenter
  // IP - we declared there was no video to analyse and walked away from the
  // one path that did not need yt-dlp at all.
  const directYouTubeEligible = shouldUseDirectYouTube(url, options);

  // Past this point the text was NOT enough, so a missing binary is now a
  // real problem rather than an unused feature - unless the direct path can
  // carry the job without the binary.
  if (toolingBlocked && !directYouTubeEligible) {
    logger.error(STAGES.MEDIA_TOOLING_DISABLED, {
      jobId,
      url,
      required: true,
      message: toolingMessage,
      hint: 'Deploy the Cloud Run worker image, or set RECIPE_MEDIA_TOOLING_AVAILABLE=true.',
    });
    return {
      escalated: false,
      evidence: callerBundle,
      media,
      sufficiency,
      videoResult: null,
      reason: 'media_tooling_unavailable',
    };
  }

  if ((!media || !media.isVideo) && !options.videoFile && !directYouTubeEligible) {
    return {
      escalated: false,
      evidence: callerBundle,
      media,
      sufficiency,
      videoResult: null,
      reason: 'no_video_to_analyze',
    };
  }

  logger.info(STAGES.VIDEO_ESCALATED, {
    jobId,
    url,
    platform: media?.platform || null,
    score: sufficiency.score,
    missing: sufficiency.missing,
    directYouTubeEligible,
    hasLocalFile: Boolean(options.videoFile),
  });

  const beforeMerge = countByField(callerBundle);
  const contextText = evidenceToText(callerBundle, {
    maxChars: config.MAX_EVIDENCE_PROMPT_CHARS,
  });

  // The YouTube fast path runs first and downloads nothing. If it is not
  // available, not applicable, or came back empty, the resolver takes over.
  let videoResult = options.videoFile
    ? null
    : await tryDirectYouTubeAnalysis(url, media, contextText, options);

  if (!videoResult) {
    videoResult = await analyzeVideoEvidenceCached(url, {
      ...options,
      media,
      contextText,
    });
  }

  mergeEvidenceBundles(callerBundle, videoResult.evidence);

  const afterMerge = countByField(callerBundle);
  const videoClaims = countVideoSourcedItems(callerBundle);

  if (videoClaims > 0) {
    logger.info(STAGES.VIDEO_ADDED_USEFUL_INFORMATION, {
      jobId,
      url,
      videoSourcedItems: videoClaims,
      analyzer: videoResult.analyzer || null,
      fromCache: Boolean(videoResult.fromCache),
    });

    // "Materially" is deliberately blunt: did the merge add any ingredient or
    // instruction the page did not already give us. A precise measure of
    // recipe change would need a model, and this is a log line, not a score.
    const addedIngredients = afterMerge.ingredients - beforeMerge.ingredients;
    const addedInstructions = afterMerge.instructions - beforeMerge.instructions;
    if (addedIngredients > 0 || addedInstructions > 0) {
      logger.info(STAGES.VIDEO_CHANGED_RECIPE_MATERIALLY, {
        jobId,
        url,
        addedIngredients,
        addedInstructions,
        analyzer: videoResult.analyzer || null,
      });
    }
  }

  logger.info(STAGES.EVIDENCE_MERGED, {
    jobId,
    url,
    escalated: true,
    evidence: summarizeEvidence(callerBundle),
  });

  return {
    escalated: true,
    evidence: callerBundle,
    media,
    sufficiency,
    videoResult,
  };
}

module.exports = {
  collectMediaEvidence,
  analyzeVideoEvidence,
  analyzeVideoEvidenceCached,
  tryDirectYouTubeAnalysis,
  buildLocalMediaMetadata,
  countVideoSourcedItems,
  summarizeMediaForCache,
  extractRecipeFromUrl,
  seedEvidenceFromCaller,
  isSocialPlatform,
  pickDeclaredBytes,
};
