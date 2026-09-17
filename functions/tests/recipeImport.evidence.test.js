'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  EVIDENCE_SOURCES,
  addIngredient,
  addInstruction,
  addTitle,
  createEvidence,
  createEvidenceBundle,
  dedupeEvidenceList,
  evidenceToText,
  mergeEvidenceBundles,
  normalizeEvidenceValue,
  sourceRank,
  summarizeEvidence,
  withoutInference,
} = require('../recipeImport/evidence');

test('an evidence item carries its source and timestamp', () => {
  const item = createEvidence('add two eggs', EVIDENCE_SOURCES.TRANSCRIPT, {
    timestampSeconds: 18.4,
    rawEvidence: 'and then you add two eggs',
  });
  assert.strictEqual(item.value, 'add two eggs');
  assert.strictEqual(item.source, 'transcript');
  assert.strictEqual(item.timestampSeconds, 18.4);
  assert.strictEqual(item.rawEvidence, 'and then you add two eggs');
  assert.ok(item.confidence > 0.5);
});

test('an unknown source is rejected rather than silently accepted', () => {
  assert.throws(() => createEvidence('x', 'telepathy'), /Unknown evidence source/);
});

test('blank values never become evidence', () => {
  assert.strictEqual(createEvidence('   ', EVIDENCE_SOURCES.CAPTION), null);
  assert.strictEqual(createEvidence(null, EVIDENCE_SOURCES.CAPTION), null);
});

test('normalisation collapses whitespace and case but not different quantities', () => {
  assert.strictEqual(normalizeEvidenceValue('  2   EGGS '), '2 eggs');
  assert.notStrictEqual(normalizeEvidenceValue('2 eggs'), normalizeEvidenceValue('3 eggs'));
});

test('stated evidence outranks inferred evidence', () => {
  assert.ok(sourceRank(EVIDENCE_SOURCES.TRANSCRIPT) > sourceRank(EVIDENCE_SOURCES.MODEL_INFERENCE));
  assert.ok(sourceRank(EVIDENCE_SOURCES.ONSCREEN_TEXT) > sourceRank(EVIDENCE_SOURCES.CAPTION));
  assert.ok(sourceRank(EVIDENCE_SOURCES.STRUCTURED_RECIPE) > sourceRank(EVIDENCE_SOURCES.TRANSCRIPT));
});

test('dedupe keeps the strongest provenance for the same value', () => {
  const list = [
    { value: '2 eggs', source: EVIDENCE_SOURCES.MODEL_INFERENCE },
    { value: '2 eggs', source: EVIDENCE_SOURCES.TRANSCRIPT },
    { value: '2 eggs', source: EVIDENCE_SOURCES.ONSCREEN_TEXT },
  ];
  const deduped = dedupeEvidenceList(list);
  assert.strictEqual(deduped.length, 1);
  assert.strictEqual(deduped[0].source, EVIDENCE_SOURCES.TRANSCRIPT);
});

test('merging a caption bundle into a page-text bundle preserves both provenances', () => {
  const page = createEvidenceBundle({ originalUrl: 'https://example.com/r', platform: null });
  addInstruction(page, 'Preheat the oven to 180C.', EVIDENCE_SOURCES.WEBPAGE_TEXT);

  const social = createEvidenceBundle({ platform: 'instagram', videoDurationSeconds: 42 });
  addIngredient(social, '200g pasta', EVIDENCE_SOURCES.CAPTION);

  mergeEvidenceBundles(page, social);

  assert.strictEqual(page.instructionCandidates.length, 1);
  assert.strictEqual(page.instructionCandidates[0].source, 'webpage_text');
  assert.strictEqual(page.ingredientCandidates.length, 1);
  assert.strictEqual(page.ingredientCandidates[0].source, 'caption');
  assert.strictEqual(page.sourceMetadata.platform, 'instagram');
  assert.strictEqual(page.sourceMetadata.videoDurationSeconds, 42);
  assert.strictEqual(page.sourceMetadata.originalUrl, 'https://example.com/r');
});

test('conflicting caption and video evidence both survive, each tagged', () => {
  const bundle = createEvidenceBundle({ originalUrl: 'https://tk/t/1', platform: 'tiktok' });
  addIngredient(bundle, '2 eggs', EVIDENCE_SOURCES.CAPTION);
  addIngredient(bundle, '3 eggs', EVIDENCE_SOURCES.TRANSCRIPT);

  assert.strictEqual(bundle.ingredientCandidates.length, 2);
  const sources = bundle.ingredientCandidates.map((i) => i.source);
  assert.deepStrictEqual(sources, ['caption', 'transcript']);

  const text = evidenceToText(bundle);
  assert.match(text, /\[CAPTION\] 2 eggs/);
  assert.match(text, /\[TRANSCRIPT\] 3 eggs/);
});

test('a higher-ranked source replaces a lower-ranked one for the same value', () => {
  const bundle = createEvidenceBundle({ originalUrl: 'https://x' });
  addIngredient(bundle, '2 eggs', EVIDENCE_SOURCES.MODEL_INFERENCE);

  const incoming = createEvidenceBundle({});
  addIngredient(incoming, '2 eggs', EVIDENCE_SOURCES.ONSCREEN_TEXT);

  mergeEvidenceBundles(bundle, incoming);
  assert.strictEqual(bundle.ingredientCandidates.length, 1);
  assert.strictEqual(bundle.ingredientCandidates[0].source, 'onscreen_text');
});

test('withoutInference drops only the guessed tier', () => {
  const bundle = createEvidenceBundle({ originalUrl: 'https://x' });
  addIngredient(bundle, '2 eggs', EVIDENCE_SOURCES.TRANSCRIPT);
  addIngredient(bundle, 'salt', EVIDENCE_SOURCES.MODEL_INFERENCE);

  const stripped = withoutInference(bundle);
  assert.strictEqual(stripped.ingredientCandidates.length, 1);
  assert.strictEqual(stripped.ingredientCandidates[0].value, '2 eggs');
});

test('evidenceToText renders sections with provenance tags and timestamps', () => {
  const bundle = createEvidenceBundle({ originalUrl: 'https://x' });
  addTitle(bundle, 'Garlic Pasta', EVIDENCE_SOURCES.TITLE);
  addIngredient(bundle, '2 eggs', EVIDENCE_SOURCES.TRANSCRIPT, { timestampSeconds: 18 });
  addInstruction(bundle, 'Boil the pasta', EVIDENCE_SOURCES.ONSCREEN_TEXT, { timestampSeconds: 65 });

  const text = evidenceToText(bundle);
  assert.match(text, /### TITLE/);
  assert.match(text, /\[TITLE\] Garlic Pasta/);
  assert.match(text, /\[TRANSCRIPT @0:18\] 2 eggs/);
  assert.match(text, /\[ONSCREEN_TEXT @1:05\] Boil the pasta/);
});

test('evidenceToText can exclude inference and caps its length', () => {
  const bundle = createEvidenceBundle({ originalUrl: 'https://x' });
  addIngredient(bundle, 'a guessed ingredient', EVIDENCE_SOURCES.MODEL_INFERENCE);
  addIngredient(bundle, 'real flour', EVIDENCE_SOURCES.CAPTION);

  const text = evidenceToText(bundle, { includeInference: false });
  assert.doesNotMatch(text, /guessed/);
  assert.match(text, /real flour/);

  const capped = evidenceToText(bundle, { maxChars: 10 });
  assert.ok(capped.length <= 10);
});

test('summarise reports counts only, never content', () => {
  const bundle = createEvidenceBundle({ originalUrl: 'https://x' });
  addIngredient(bundle, 'secret family ingredient', EVIDENCE_SOURCES.CAPTION);
  addInstruction(bundle, 'another secret', EVIDENCE_SOURCES.TRANSCRIPT);

  const summary = summarizeEvidence(bundle);
  assert.deepStrictEqual(summary, { caption: 1, transcript: 1 });
  assert.strictEqual(JSON.stringify(summary).includes('secret'), false);
});
