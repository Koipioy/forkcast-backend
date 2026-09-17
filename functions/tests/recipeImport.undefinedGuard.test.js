'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizeAnalysisResponse } = require('../recipeImport/analyzers/prompt');
const { stripUndefined } = require('../recipeImport/jobStore');
const { EVIDENCE_SOURCES, DEFAULT_CONFIDENCE } = require('../recipeImport/evidence');

/** Deep-assert that no value anywhere in the tree is `undefined`. */
function assertNoUndefined(value, path = 'root') {
  if (value === undefined) {
    assert.fail(`${path} is undefined - Firestore would reject this write`);
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoUndefined(v, `${path}[${i}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) {
        assert.fail(`${path}.${k} is undefined - Firestore would reject this write`);
      }
      assertNoUndefined(v, `${path}.${k}`);
    }
  }
}

test('ingredient candidates with no model confidence get the source default, not undefined', () => {
  const out = normalizeAnalysisResponse(
    { ingredients: [{ name: 'olive oil', amount: '2 tbsp' }] },
    { fallbackSource: EVIDENCE_SOURCES.TRANSCRIPT },
  );
  assert.strictEqual(out.ingredientCandidates.length, 1);
  const item = out.ingredientCandidates[0];
  assert.strictEqual(item.value, '2 tbsp olive oil');
  assert.strictEqual(
    item.confidence,
    DEFAULT_CONFIDENCE[EVIDENCE_SOURCES.TRANSCRIPT],
    'must fall back to the per-source default rather than undefined',
  );
  assertNoUndefined(out, 'bundle');
});

test('a model-supplied confidence is respected', () => {
  const out = normalizeAnalysisResponse(
    { ingredients: [{ name: 'salt', confidence: 0.9 }] },
    { fallbackSource: EVIDENCE_SOURCES.TRANSCRIPT },
  );
  assert.strictEqual(out.ingredientCandidates[0].confidence, 0.9);
});

test('plain string ingredients produce a numeric confidence', () => {
  const out = normalizeAnalysisResponse(
    { ingredients: ['200g flour', '3 eggs'] },
    { fallbackSource: EVIDENCE_SOURCES.VISUAL_OBSERVATION },
  );
  assert.strictEqual(out.ingredientCandidates.length, 2);
  for (const item of out.ingredientCandidates) {
    assert.strictEqual(typeof item.confidence, 'number');
    assert.ok(item.confidence >= 0 && item.confidence <= 1);
  }
});

test('absent timestampSeconds and rawEvidence are omitted, not set to undefined', () => {
  const out = normalizeAnalysisResponse(
    {
      ingredients: [{ name: 'basil' }],
      instructions: ['tear the basil'],
      timing: ['10 minutes'],
    },
    { fallbackSource: EVIDENCE_SOURCES.TRANSCRIPT },
  );
  assertNoUndefined(out, 'bundle');
  assert.ok(!('timestampSeconds' in out.ingredientCandidates[0]));
  assert.ok(!('timestampSeconds' in out.instructionCandidates[0]));
  assert.ok(!('timestampSeconds' in out.timingCandidates[0]));
});

test('a valid timestamp still survives', () => {
  const out = normalizeAnalysisResponse(
    { ingredients: [{ name: 'garlic', timestampSeconds: 12.34 }] },
    { fallbackSource: EVIDENCE_SOURCES.TRANSCRIPT },
  );
  assert.strictEqual(out.ingredientCandidates[0].timestampSeconds, 12.3);
});

test('the full response shape is undefined-free across every candidate list', () => {
  const out = normalizeAnalysisResponse(
    {
      title: 'Cacio e pepe',
      servings: '2',
      ingredients: ['black pepper', { name: 'pecorino', amount: '50g' }],
      instructions: ['toast the pepper', { text: 'melt the cheese' }],
      timing: ['5 minutes'],
      onscreenText: ['PECORINO ROMANO'],
    },
    { fallbackSource: EVIDENCE_SOURCES.VISUAL_OBSERVATION },
  );
  assertNoUndefined(out, 'bundle');
  for (const list of Object.values(out)) {
    for (const item of list) {
      assert.strictEqual(typeof item.confidence, 'number', `${item.value} lost its confidence`);
    }
  }
});

test('empty and junk input still yields an undefined-free empty bundle', () => {
  for (const input of [null, undefined, {}, { ingredients: [null, ''] }]) {
    const out = normalizeAnalysisResponse(input, {});
    assertNoUndefined(out, 'bundle');
  }
});

test('stripUndefined removes nested and array undefined values but keeps null', () => {
  const input = {
    a: undefined,
    b: null,
    c: 1,
    nested: { d: undefined, e: 'keep' },
    list: [{ f: undefined, g: 2 }, undefined, 3],
  };
  const out = stripUndefined(input);
  assert.ok(!('a' in out));
  assert.strictEqual(out.b, null, 'null is meaningful and must survive');
  assert.strictEqual(out.c, 1);
  assert.ok(!('d' in out.nested));
  assert.strictEqual(out.nested.e, 'keep');
  assert.ok(!('f' in out.list[0]));
  assert.strictEqual(out.list[0].g, 2);
  assert.strictEqual(out.list[1], null, 'undefined array slots become null');
  assert.strictEqual(out.list[2], 3);
});

test('stripUndefined leaves primitives and empty structures alone', () => {
  assert.strictEqual(stripUndefined(null), null);
  assert.strictEqual(stripUndefined(0), 0);
  assert.strictEqual(stripUndefined('x'), 'x');
  assert.deepStrictEqual(stripUndefined([]), []);
  assert.deepStrictEqual(stripUndefined({}), {});
});
