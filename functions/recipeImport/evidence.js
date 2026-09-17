'use strict';

/**
 * The intermediate evidence representation.
 *
 * Every source of recipe information - JSON-LD, page text, a social caption, a
 * transcript, a frame the model read - produces the same shape. Nothing down the
 * pipeline has to know where a line came from until it wants to weigh it.
 *
 * Provenance is kept because the sources are NOT equally trustworthy. "2 eggs"
 * spoken in the audio and "2 eggs" the model assumed because the dish usually has
 * eggs are different facts, and merging them without saying so is how a recipe
 * invents ingredients.
 */

const EVIDENCE_SOURCES = {
  STRUCTURED_RECIPE: 'structured_recipe',
  WEBPAGE_TEXT: 'webpage_text',
  CAPTION: 'caption',
  DESCRIPTION: 'description',
  TITLE: 'title',
  TRANSCRIPT: 'transcript',
  ONSCREEN_TEXT: 'onscreen_text',
  VISUAL_OBSERVATION: 'visual_observation',
  MODEL_INFERENCE: 'model_inference',
};

const ALL_SOURCES = Object.values(EVIDENCE_SOURCES);

/**
 * Deterministic precedence, highest first.
 *
 * Stated or shown beats inferred. Structured markup beats prose because it was
 * written by the publisher for machines to read. A transcript beats a caption
 * because the caption is often a marketing blurb that trails the actual recipe.
 * Model inference sits at the bottom and is the only tier allowed to be dropped
 * wholesale (see `withoutInference`).
 */
const SOURCE_PRECEDENCE = {
  [EVIDENCE_SOURCES.STRUCTURED_RECIPE]: 100,
  [EVIDENCE_SOURCES.TRANSCRIPT]: 90,
  [EVIDENCE_SOURCES.ONSCREEN_TEXT]: 88,
  [EVIDENCE_SOURCES.CAPTION]: 70,
  [EVIDENCE_SOURCES.DESCRIPTION]: 68,
  [EVIDENCE_SOURCES.WEBPAGE_TEXT]: 65,
  [EVIDENCE_SOURCES.VISUAL_OBSERVATION]: 55,
  [EVIDENCE_SOURCES.TITLE]: 50,
  [EVIDENCE_SOURCES.MODEL_INFERENCE]: 20,
};

/** Sources that describe something a human actually wrote, said or showed. */
const EXPLICIT_SOURCES = new Set([
  EVIDENCE_SOURCES.STRUCTURED_RECIPE,
  EVIDENCE_SOURCES.WEBPAGE_TEXT,
  EVIDENCE_SOURCES.CAPTION,
  EVIDENCE_SOURCES.DESCRIPTION,
  EVIDENCE_SOURCES.TITLE,
  EVIDENCE_SOURCES.TRANSCRIPT,
  EVIDENCE_SOURCES.ONSCREEN_TEXT,
]);

const DEFAULT_CONFIDENCE = {
  [EVIDENCE_SOURCES.STRUCTURED_RECIPE]: 0.95,
  [EVIDENCE_SOURCES.TRANSCRIPT]: 0.9,
  [EVIDENCE_SOURCES.ONSCREEN_TEXT]: 0.88,
  [EVIDENCE_SOURCES.CAPTION]: 0.75,
  [EVIDENCE_SOURCES.DESCRIPTION]: 0.72,
  [EVIDENCE_SOURCES.WEBPAGE_TEXT]: 0.7,
  [EVIDENCE_SOURCES.VISUAL_OBSERVATION]: 0.55,
  [EVIDENCE_SOURCES.TITLE]: 0.5,
  [EVIDENCE_SOURCES.MODEL_INFERENCE]: 0.2,
};

function isKnownSource(source) {
  return ALL_SOURCES.includes(source);
}

function sourceRank(source) {
  return SOURCE_PRECEDENCE[source] ?? 0;
}

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * Normalise a value for de-duplication.
 *
 * "2 eggs", " 2  eggs " and "2 EGGS" are one fact. Deliberately lexical rather
 * than semantic: merging "2 eggs" with "3 eggs" would be wrong, and deciding
 * whether "a onion" and "1 onion" are the same is the recipe normalizer's job,
 * not the evidence layer's.
 */
function normalizeEvidenceValue(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build one evidence item.
 *
 * @param {*} value the fact itself ("2 eggs", "whisk until frothy")
 * @param {string} source one of EVIDENCE_SOURCES
 * @param {{confidence?: number, timestampSeconds?: number, rawEvidence?: string}} [meta]
 */
function createEvidence(value, source, meta = {}) {
  if (!isKnownSource(source)) {
    throw new Error(`Unknown evidence source: ${source}`);
  }
  const normalized = normalizeEvidenceValue(value);
  if (!normalized) return null;

  const item = {
    value: typeof value === 'string' ? value.trim() : value,
    source,
    confidence: clamp01(meta.confidence, DEFAULT_CONFIDENCE[source] ?? 0.5),
  };

  const timestamp = Number(meta.timestampSeconds);
  if (Number.isFinite(timestamp) && timestamp >= 0) {
    item.timestampSeconds = Math.round(timestamp * 10) / 10;
  }
  if (meta.rawEvidence) {
    item.rawEvidence = String(meta.rawEvidence);
  }
  return item;
}

/**
 * Empty bundle for one import.
 *
 * `sourceMetadata` is deliberately small: it is what the recipe normalizer and
 * the logs need to know about where the media came from, not a copy of the
 * resolver's raw payload.
 */
function createEvidenceBundle(sourceMeta = {}) {
  return {
    titleCandidates: [],
    ingredientCandidates: [],
    instructionCandidates: [],
    servingsCandidates: [],
    timingCandidates: [],
    sourceMetadata: {
      originalUrl: sourceMeta.originalUrl || null,
      platform: sourceMeta.platform || null,
      videoDurationSeconds:
        sourceMeta.videoDurationSeconds === undefined
          ? null
          : Number(sourceMeta.videoDurationSeconds) || null,
      ...(sourceMeta.extra || {}),
    },
  };
}

function pushCandidate(bundle, field, value, source, meta) {
  const item = createEvidence(value, source, meta);
  if (!item) return null;
  bundle[field].push(item);
  return item;
}

const ADDERS = {
  title: 'titleCandidates',
  ingredient: 'ingredientCandidates',
  instruction: 'instructionCandidates',
  servings: 'servingsCandidates',
  timing: 'timingCandidates',
};

function addTitle(bundle, value, source, meta) {
  return pushCandidate(bundle, ADDERS.title, value, source, meta);
}
function addIngredient(bundle, value, source, meta) {
  return pushCandidate(bundle, ADDERS.ingredient, value, source, meta);
}
function addInstruction(bundle, value, source, meta) {
  return pushCandidate(bundle, ADDERS.instruction, value, source, meta);
}
function addServings(bundle, value, source, meta) {
  return pushCandidate(bundle, ADDERS.servings, value, source, meta);
}
function addTiming(bundle, value, source, meta) {
  return pushCandidate(bundle, ADDERS.timing, value, source, meta);
}

/**
 * Collapse same-value candidates down to the best-provenanced one.
 *
 * "2 eggs" said in the audio and "2 eggs" the model guessed are one fact with
 * two claims about it. Keeping both would let the weaker claim reach the parser
 * alongside the strong one, so the highest-ranked source wins and the rest are
 * dropped. Equal rank keeps the first, which preserves the earliest timestamp.
 */
function dedupeEvidenceList(list) {
  const byValue = new Map();
  for (const item of list || []) {
    const key = normalizeEvidenceValue(item.value);
    if (!key) continue;
    const existing = byValue.get(key);
    if (!existing || sourceRank(item.source) > sourceRank(existing.source)) {
      byValue.set(key, item);
    }
  }
  return Array.from(byValue.values());
}

/**
 * Merge two bundles.
 *
 * Order matters only as a tie-break: within one candidate list, an item already
 * present from a higher-ranked source is never displaced by a lower-ranked one.
 * Same-source duplicates collapse to the first occurrence, which keeps the
 * earliest timestamp for a repeated line.
 */
function mergeEvidenceBundles(target, incoming) {
  if (!incoming) return target;
  const fields = [
    'titleCandidates',
    'ingredientCandidates',
    'instructionCandidates',
    'servingsCandidates',
    'timingCandidates',
  ];

  for (const field of fields) {
    const existing = target[field] || [];
    const seen = new Map(existing.map((item) => [normalizeEvidenceValue(item.value), sourceRank(item.source)]));
    for (const item of incoming[field] || []) {
      const key = normalizeEvidenceValue(item.value);
      if (!key) continue;
      const previousRank = seen.get(key);
      if (previousRank !== undefined && previousRank >= sourceRank(item.source)) {
        continue;
      }
      if (previousRank === undefined) {
        existing.push(item);
      } else {
        // Higher-ranked source for the same value: replace so provenance wins.
        const index = existing.findIndex(
          (candidate) => normalizeEvidenceValue(candidate.value) === key,
        );
        if (index >= 0) existing[index] = item;
      }
      seen.set(key, sourceRank(item.source));
    }
    target[field] = dedupeEvidenceList(existing);
  }

  // Source metadata: fill gaps only, never overwrite a known value.
  const meta = incoming.sourceMetadata || {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === null) continue;
    if (target.sourceMetadata[key] === undefined || target.sourceMetadata[key] === null) {
      target.sourceMetadata[key] = value;
    }
  }

  return target;
}

/** Drop model-inferred candidates. Used when a policy forbids inferred ingredients. */
function withoutInference(bundle) {
  const strip = (list) => (list || []).filter((item) => item.source !== EVIDENCE_SOURCES.MODEL_INFERENCE);
  return {
    ...bundle,
    titleCandidates: strip(bundle.titleCandidates),
    ingredientCandidates: strip(bundle.ingredientCandidates),
    instructionCandidates: strip(bundle.instructionCandidates),
    servingsCandidates: strip(bundle.servingsCandidates),
    timingCandidates: strip(bundle.timingCandidates),
  };
}

/** Counts per source. Safe to log: no content, just tallies. */
function summarizeEvidence(bundle) {
  const summary = {};
  const fields = [
    'titleCandidates',
    'ingredientCandidates',
    'instructionCandidates',
    'servingsCandidates',
    'timingCandidates',
  ];
  for (const field of fields) {
    for (const item of bundle[field] || []) {
      summary[item.source] = (summary[item.source] || 0) + 1;
    }
  }
  return summary;
}

function formatTimestamp(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.round(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

const SECTION_LABELS = {
  titleCandidates: 'TITLE',
  ingredientCandidates: 'INGREDIENTS',
  instructionCandidates: 'INSTRUCTIONS',
  servingsCandidates: 'SERVINGS',
  timingCandidates: 'TIMING',
};

/**
 * Render the bundle as labelled text for the existing recipe parser.
 *
 * The parser is a prompt, so the provenance has to survive being turned into
 * words. Each line carries its source tag and timestamp, which is what lets the
 * model prefer "ONSCREEN_TEXT: 2 eggs" over a guess and lets a human audit the
 * result later.
 */
function evidenceToText(bundle, options = {}) {
  const maxChars = options.maxChars || 60000;
  const includeInference = options.includeInference !== false;
  const lines = [];

  for (const [field, label] of Object.entries(SECTION_LABELS)) {
    const items = (bundle[field] || []).filter(
      (item) => includeInference || item.source !== EVIDENCE_SOURCES.MODEL_INFERENCE,
    );
    if (items.length === 0) continue;

    lines.push(`### ${label}`);
    for (const item of items) {
      const stamp =
        item.timestampSeconds !== undefined
          ? ` @${formatTimestamp(item.timestampSeconds)}`
          : '';
      lines.push(`[${String(item.source).toUpperCase()}${stamp}] ${item.value}`);
    }
    lines.push('');
  }

  const text = lines.join('\n').trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

module.exports = {
  EVIDENCE_SOURCES,
  ALL_SOURCES,
  SOURCE_PRECEDENCE,
  EXPLICIT_SOURCES,
  DEFAULT_CONFIDENCE,
  normalizeEvidenceValue,
  dedupeEvidenceList,
  createEvidence,
  createEvidenceBundle,
  addTitle,
  addIngredient,
  addInstruction,
  addServings,
  addTiming,
  mergeEvidenceBundles,
  withoutInference,
  summarizeEvidence,
  evidenceToText,
  sourceRank,
  isKnownSource,
  formatTimestamp,
};
