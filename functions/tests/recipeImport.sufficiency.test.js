'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  assessTextSufficiency,
  countIngredientSignals,
  countInstructionSignals,
  hasMeaningfulTitle,
  splitLines,
} = require('../recipeImport/sufficiency');

const FULL_RECIPE = `Creamy Garlic Pasta

Ingredients
200g pasta
3 cloves garlic
100ml cream
2 tbsp butter
salt and pepper

Method
1. Boil the pasta until al dente.
2. Melt the butter and fry the garlic.
3. Add the cream and simmer for 5 minutes.
4. Toss the pasta through and serve.`;

test('a full recipe text is sufficient', () => {
  const result = assessTextSufficiency({ title: 'Creamy Garlic Pasta', text: FULL_RECIPE });
  assert.strictEqual(result.sufficient, true);
  assert.ok(result.score >= 0.7);
  assert.deepStrictEqual(result.missing, []);
});

test('a caption with no recipe content is insufficient', () => {
  const result = assessTextSufficiency({
    title: 'Reel',
    text: 'You won\'t believe this!!! 🔥 Link in bio for more food content',
  });
  assert.strictEqual(result.sufficient, false);
  assert.deepStrictEqual(result.missing.sort(), ['ingredients', 'instructions', 'title']);
});

test('ingredients without instructions is not enough', () => {
  const result = assessTextSufficiency({
    title: 'Shopping list',
    text: 'Ingredients\n2 eggs\n1 cup flour\n200ml milk',
  });
  assert.strictEqual(result.sufficient, false);
  assert.deepStrictEqual(result.missing, ['instructions']);
});

test('instructions without ingredients is not enough', () => {
  const result = assessTextSufficiency({
    title: 'How to cook',
    text: 'Method\n1. Heat the pan.\n2. Add everything and cook.',
  });
  assert.strictEqual(result.sufficient, false);
  assert.deepStrictEqual(result.missing, ['ingredients']);
});

test('generic titles do not count as an identity', () => {
  assert.strictEqual(hasMeaningfulTitle('Recipe'), false);
  assert.strictEqual(hasMeaningfulTitle('untitled'), false);
  assert.strictEqual(hasMeaningfulTitle('Instagram'), false);
  assert.strictEqual(hasMeaningfulTitle('One-pan lemon chicken'), true);
  assert.strictEqual(hasMeaningfulTitle('ab'), false);
});

test('ingredient counting is scoped to the ingredients section', () => {
  const lines = splitLines(`3 ways to make breakfast this week\nIngredients\n2 eggs\n100g bacon\n2 slices bread\nMethod\n1. Fry the bacon.`);
  assert.strictEqual(countIngredientSignals(lines), 3);
  assert.strictEqual(countInstructionSignals(lines) >= 1, true);
});

test('a blog intro sentence is not mistaken for an ingredient list', () => {
  const lines = splitLines('2 of my favourite things about this blog, and why you should subscribe to the newsletter today.');
  assert.strictEqual(countIngredientSignals(lines), 0);
});

test('structured recipe counts win over text heuristics', () => {
  const result = assessTextSufficiency({
    title: 'JSON-LD Cake',
    text: 'nothing useful here at all',
    structuredRecipe: {
      ingredients: [{ name: 'flour' }, { name: 'eggs' }, { name: 'sugar' }],
      instructions: ['Mix', 'Bake'],
    },
  });
  assert.strictEqual(result.signals.structured, true);
  assert.strictEqual(result.signals.ingredientCount, 3);
  assert.strictEqual(result.signals.instructionCount, 2);
  assert.strictEqual(result.sufficient, true);
});

test('thresholds are configurable per call', () => {
  const text = 'Ingredients\n2 eggs\nMethod\n1. Mix it.';
  assert.strictEqual(assessTextSufficiency({ title: 'Eggs', text }).sufficient, false);
  assert.strictEqual(
    assessTextSufficiency({ title: 'Eggs', text }, { minIngredients: 1, minInstructions: 1 }).sufficient,
    true,
  );
});

test('empty input is never sufficient', () => {
  assert.strictEqual(assessTextSufficiency({}).sufficient, false);
  assert.strictEqual(assessTextSufficiency({ title: 'X', text: '' }).sufficient, false);
});
