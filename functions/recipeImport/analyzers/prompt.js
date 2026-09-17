'use strict';

/**
 * The shared video-analysis prompt and its output contract.
 *
 * Both analyzer paths (whole-video and frames+transcript) ask the same question
 * in the same words, so their answers land in the same shape and a provider swap
 * does not change what the merger receives.
 *
 * The wording matters more than it looks. A vision model asked to "extract the
 * recipe" will happily add the garlic and onion that every pasta sauce has,
 * because that is what the dish usually contains. The instructions below say
 * explicitly that an ingredient must have been said, shown, or written on
 * screen, and label which of those happened, so the guesswork stays visible
 * instead of becoming a shopping list.
 */

const { EVIDENCE_SOURCES, createEvidence } = require('../evidence');

const ALLOWED_ITEM_SOURCES = new Set([
  EVIDENCE_SOURCES.TRANSCRIPT,
  EVIDENCE_SOURCES.ONSCREEN_TEXT,
  EVIDENCE_SOURCES.VISUAL_OBSERVATION,
  EVIDENCE_SOURCES.MODEL_INFERENCE,
  EVIDENCE_SOURCES.CAPTION,
  EVIDENCE_SOURCES.DESCRIPTION,
]);

const ANALYSIS_RULES = `You are extracting recipe evidence from a cooking video. You are not writing a recipe and you are not completing one.

Rules you must follow:
1. Only report an ingredient if it was SPOKEN out loud, WRITTEN on screen, or CLEARLY SHOWN (a recognisable product, a measured quantity, a visible action using it).
2. Never add an ingredient just because the finished dish normally contains it. If you were not shown or told it, do not list it.
3. The transcript may omit ingredients that are only shown visually. Frames may reveal ingredient labels, packet names and quantities that nobody says out loud. Use both, and prefer whichever is more specific.
4. Visual evidence supplements spoken evidence; it does not override it. If the audio says "2 eggs" and the frames show 3, report the spoken quantity and note the conflict in "conflicts".
5. For every item, say where it came from: "transcript" (spoken), "onscreen_text" (written in the video), "visual_observation" (you saw it happen), or "model_inference" (you are guessing).
6. Use "model_inference" only as a last resort and expect it to be dropped.
7. Include quantities exactly as given. If a quantity is unclear, say so in the item rather than inventing a number.
8. Keep instructions in the order they happen. Do not merge separate steps into one.
9. If you cannot find a section, return an empty array for it. Never pad.`;

const RESPONSE_SHAPE = `Return ONLY a JSON object with this exact shape, no prose, no markdown fences:
{
  "title": "the dish name, or null",
  "servings": "e.g. 'serves 4', or null",
  "timing": [{"text": "e.g. 'bake 20 minutes'", "source": "transcript|onscreen_text|visual_observation", "timestampSeconds": 0}],
  "ingredients": [
    {"name": "eggs", "amount": "2", "rawText": "add two eggs", "source": "transcript", "timestampSeconds": 18}
  ],
  "instructions": [
    {"text": "Crack the eggs into a bowl and whisk.", "source": "transcript", "timestampSeconds": 18}
  ],
  "onscreenText": ["2 eggs", "PREP 10 MIN"],
  "conflicts": ["audio says 2 eggs, frames show 3"],
  "coverageNotes": "one short sentence on what could not be determined"
}`;

/**
 * Build the prompt for one analysis call.
 *
 * @param {{mode: 'video'|'frames', contextText?: string, mediaMetadata?: object,
 *          frameCount?: number, hasTranscript?: boolean}} params
 */
function buildAnalysisPrompt(params = {}) {
  const meta = params.mediaMetadata || {};
  const lines = [ANALYSIS_RULES, ''];

  if (params.mode === 'frames') {
    lines.push(
      `The video is provided as ${params.frameCount || 'a number of'} still frames sampled at regular intervals, plus a transcript of the audio where available.`,
      'Frames are sparse: what happens between two frames is not visible. Do not assume an action happened because it is likely.',
    );
  } else {
    lines.push('The video is provided in full, with its audio.');
  }

  if (meta.title) lines.push(`Video title: ${meta.title}`);
  if (meta.platform) lines.push(`Platform: ${meta.platform}`);
  if (meta.uploader) lines.push(`Uploader: ${meta.uploader}`);
  if (meta.durationSeconds) lines.push(`Duration: ${Math.round(meta.durationSeconds)} seconds`);

  if (params.contextText) {
    lines.push('');
    lines.push('Text already known from the page or caption (may be incomplete or unrelated):');
    lines.push(params.contextText);
  }

  lines.push('');
  lines.push(RESPONSE_SHAPE);
  return lines.join('\n');
}

function clampTimestamp(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : undefined;
}

function safeSource(value, fallback) {
  const source = typeof value === 'string' ? value.trim().toLowerCase() : null;
  if (source && ALLOWED_ITEM_SOURCES.has(source)) return source;
  return fallback;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

/**
 * Model JSON -> evidence candidates.
 *
 * `fallbackSource` is what an item is attributed to when the model omits or
 * mangles its `source` field. For the frames path that is
 * `visual_observation`: the model saw a frame, it did not hear anything.
 */
function normalizeAnalysisResponse(parsed, options = {}) {
  const fallbackSource = options.fallbackSource || EVIDENCE_SOURCES.VISUAL_OBSERVATION;
  const bundle = {
    titleCandidates: [],
    ingredientCandidates: [],
    instructionCandidates: [],
    servingsCandidates: [],
    timingCandidates: [],
  };

  if (!parsed || typeof parsed !== 'object') return bundle;

  if (parsed.title) {
    bundle.titleCandidates.push({
      value: String(parsed.title),
      source: fallbackSource,
      confidence: 0.6,
    });
  }

  if (parsed.servings) {
    bundle.servingsCandidates.push({
      value: String(parsed.servings),
      source: fallbackSource,
      confidence: 0.6,
    });
  }

  // Every item goes through createEvidence rather than a hand-built object.
  // createEvidence always produces a numeric confidence (falling back to the
  // per-source default) and only attaches timestampSeconds/rawEvidence when they
  // are actually present. Hand-built literals here previously emitted
  // `confidence: undefined`, which Firestore rejects outright and which took the
  // whole job down AFTER a successful model call.
  for (const item of asArray(parsed.ingredients)) {
    if (!item) continue;
    const isObj = typeof item === 'object' && item !== null;
    const name = isObj ? item.name : item;
    if (!name) continue;
    const amount = isObj && item.amount ? String(item.amount).trim() : '';
    const rawText = (isObj && item.rawText) || (amount ? `${amount} ${name}` : String(name));
    const ev = createEvidence(
      amount ? `${amount} ${name}`.trim() : String(name),
      safeSource(isObj ? item.source : null, fallbackSource),
      {
        confidence: isObj ? item.confidence : undefined,
        timestampSeconds: isObj ? item.timestampSeconds : undefined,
        rawEvidence: rawText,
      },
    );
    if (ev) bundle.ingredientCandidates.push(ev);
  }

  for (const item of asArray(parsed.instructions)) {
    if (!item) continue;
    const isObj = typeof item === 'object' && item !== null;
    const text = isObj ? item.text : item;
    if (!text) continue;
    const ev = createEvidence(
      String(text),
      safeSource(isObj ? item.source : null, fallbackSource),
      {
        confidence: isObj ? item.confidence : undefined,
        timestampSeconds: isObj ? item.timestampSeconds : undefined,
        rawEvidence: isObj ? item.rawText : undefined,
      },
    );
    if (ev) bundle.instructionCandidates.push(ev);
  }

  for (const item of asArray(parsed.timing)) {
    const isObj = typeof item === 'object' && item !== null;
    const text = isObj ? item.text : item;
    if (!text) continue;
    const ev = createEvidence(
      String(text),
      safeSource(isObj ? item.source : null, fallbackSource),
      {
        confidence: isObj ? item.confidence : undefined,
        timestampSeconds: isObj ? item.timestampSeconds : undefined,
        rawEvidence: isObj ? item.rawText : undefined,
      },
    );
    if (ev) bundle.timingCandidates.push(ev);
  }

  // On-screen text is reported twice by a well-behaved model: folded into the
  // items above, and listed verbatim here. Keep the verbatim copy - it is the
  // rawest form of the strongest evidence tier.
  for (const text of asArray(parsed.onscreenText)) {
    if (!text) continue;
    bundle.ingredientCandidates.push({
      value: String(text),
      source: EVIDENCE_SOURCES.ONSCREEN_TEXT,
      confidence: 0.85,
    });
  }

  return bundle;
}

/** Pull the first JSON object out of a model reply that may be fenced or padded. */
function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (_err) {
    return null;
  }
}

module.exports = {
  ANALYSIS_RULES,
  RESPONSE_SHAPE,
  ALLOWED_ITEM_SOURCES,
  buildAnalysisPrompt,
  normalizeAnalysisResponse,
  extractJson,
};
