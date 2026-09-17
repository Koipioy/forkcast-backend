'use strict';

/**
 * Is what we already have enough to skip the video?
 *
 * This is the gate that decides whether a job costs a few cents or a few
 * dollars, so it is deliberately not "is the string non-empty". A caption that
 * says "Recipe in bio 🔥 link below" is non-empty and worthless.
 *
 * Two different questions get asked in this system, and this file answers the
 * one that can be answered WITHOUT a model: given raw text (a caption, a video
 * description, a page body), does it actually contain a recipe? The other
 * question - "is the structured recipe the app already parsed good enough?" -
 * is answered client-side against the real recipe schema.
 */

const { envInt, envStr } = require('./config');

const MIN_TITLE_LENGTH = envInt('SUFFICIENCY_MIN_TITLE_LENGTH', 3);
const MIN_INGREDIENTS = envInt('SUFFICIENCY_MIN_INGREDIENTS', 3);
const MIN_INSTRUCTIONS = envInt('SUFFICIENCY_MIN_INSTRUCTIONS', 2);
const SUFFICIENT_SCORE = Number(envStr('SUFFICIENCY_MIN_SCORE', '0.7'));

/**
 * A line that reads like an ingredient.
 *
 * The quantity may be glued to its unit ("200g pasta", "100ml cream") or
 * separated from it ("2 tbsp butter", "3 cloves garlic"), and it may be a
 * fraction ("1/2 tsp"). The unit group is optional and short on purpose: past
 * about six letters the word is the ingredient, not the measure.
 */
const QUANTITY_RE =
  '(?:\\d+\\s+\\d/\\d|\\d+/\\d+|\\d+(?:[.,]\\d+)?|[½⅓¼⅔¾]|a|an|one|two|three|four|five|six|seven|eight|nine|ten)';
const INGREDIENT_LINE_RE = new RegExp(
  `^\\s*${QUANTITY_RE}(?:\\s?-?\\s?[A-Za-z]{1,6})?\\s+\\S.*$`,
  'i',
);

/**
 * Ingredient lines are short. A sentence that merely starts with a number
 * ("2 of my favourite things about this blog, and why...") is a blog intro,
 * not a list, and the length cap is what tells them apart.
 */
const MAX_INGREDIENT_LINE_LENGTH = 60;

/** Headings that announce a list is coming. */
const INGREDIENT_HEADING_RE = /\b(ingredients?|what you need|shopping list|you'?ll need)\b/i;
const INSTRUCTION_HEADING_RE =
  /\b(method|instructions?|directions?|steps?|preparation|how to (make|cook|prepare))\b/i;

/** Imperative cooking verbs. Not exhaustive, but long enough to be a real signal. */
const COOKING_VERB_RE =
  /\b(add|mix|stir|whisk|whip|fold|heat|cook|fry|saute|sauté|bake|grill|boil|simmer|chop|dice|mince|slice|grate|peel|season|marinate|knead|blend|pour|spread|top|serve|combine|preheat|let|rest|set|place|remove|drain|taste|bring|cover|reduce|caramelize|sear|roast|steam|whisk|beat|cream|toss|coat|fill|baste|glaze|sprinkle|scatter|layer|roll|shape|form|set|cool|chill|refrigerate|freeze)\b/i;

const NUMBERED_STEP_RE = /^\s*(?:step\s*)?\d+[.)]\s+\S/i;
const GENERIC_TITLES = new Set([
  'recipe',
  'untitled',
  'unknown',
  'null',
  'n/a',
  'video',
  'post',
  'reel',
  'tiktok',
  'youtube',
  'instagram',
]);

function splitLines(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s>*•·-]+/, '').trim())
    .filter((line) => line.length > 0);
}

function hasMeaningfulTitle(title) {
  if (!title || typeof title !== 'string') return false;
  const cleaned = title.trim();
  if (cleaned.length < MIN_TITLE_LENGTH) return false;
  return !GENERIC_TITLES.has(cleaned.toLowerCase());
}

/**
 * Count lines that read like an ingredient.
 *
 * Only counted inside an ingredients region when one exists, so a sentence like
 * "3 ways to make the best pasta" in a blog intro is not mistaken for a list.
 */
function countIngredientSignals(lines) {
  if (lines.length === 0) return 0;

  const headingIndex = lines.findIndex((line) => INGREDIENT_HEADING_RE.test(line));
  const scope =
    headingIndex >= 0
      ? lines.slice(headingIndex + 1, headingIndex + 40)
      : lines;

  let count = 0;
  for (const line of scope) {
    if (INSTRUCTION_HEADING_RE.test(line)) break;
    if (line.length > MAX_INGREDIENT_LINE_LENGTH) continue;
    if (INGREDIENT_LINE_RE.test(line)) count += 1;
  }
  return count;
}

function countInstructionSignals(lines) {
  if (lines.length === 0) return 0;

  const headingIndex = lines.findIndex((line) => INSTRUCTION_HEADING_RE.test(line));
  const scope = headingIndex >= 0 ? lines.slice(headingIndex + 1) : lines;

  let count = 0;
  for (const line of scope) {
    if (NUMBERED_STEP_RE.test(line)) {
      count += 1;
      continue;
    }
    // A sentence that starts with a cooking verb, or is a long imperative-ish
    // line, counts as a step.
    const firstWord = line.split(/\s+/)[0] || '';
    if (COOKING_VERB_RE.test(firstWord) || (line.length > 25 && COOKING_VERB_RE.test(line))) {
      count += 1;
    }
  }
  return count;
}

/**
 * @param {{title?: string|null, text?: string|null, structuredRecipe?: unknown,
 *          ingredientCount?: number, instructionCount?: number}} input
 * @param {{minIngredients?: number, minInstructions?: number, minScore?: number}} [overrides]
 */
function assessTextSufficiency(input = {}, overrides = {}) {
  const minIngredients = overrides.minIngredients ?? MIN_INGREDIENTS;
  const minInstructions = overrides.minInstructions ?? MIN_INSTRUCTIONS;
  const minScore = overrides.minScore ?? SUFFICIENT_SCORE;

  const lines = splitLines(input.text);
  const hasStructured =
    input.structuredRecipe !== null && input.structuredRecipe !== undefined;

  const ingredientCount =
    input.ingredientCount ?? (hasStructured ? countStructured(input.structuredRecipe, 'ingredients') : countIngredientSignals(lines));
  const instructionCount =
    input.instructionCount ??
    (hasStructured ? countStructured(input.structuredRecipe, 'instructions') : countInstructionSignals(lines));
  const titleOk = hasMeaningfulTitle(input.title);

  const ingredientSignal = Math.min(1, ingredientCount / Math.max(1, minIngredients));
  const instructionSignal = Math.min(1, instructionCount / Math.max(1, minInstructions));
  const titleSignal = titleOk ? 1 : 0;

  // Weighted: a recipe without steps is not a recipe, so instructions carry the
  // most weight and the title the least.
  const score =
    ingredientSignal * 0.4 + instructionSignal * 0.45 + titleSignal * 0.15;

  const missing = [];
  if (!titleOk) missing.push('title');
  if (ingredientCount < minIngredients) missing.push('ingredients');
  if (instructionCount < minInstructions) missing.push('instructions');

  const sufficient =
    score >= minScore &&
    ingredientCount >= minIngredients &&
    instructionCount >= minInstructions;

  return {
    sufficient,
    score: Math.round(score * 1000) / 1000,
    minScore,
    signals: {
      title: titleSignal,
      ingredients: ingredientSignal,
      instructions: instructionSignal,
      ingredientCount,
      instructionCount,
      structured: hasStructured,
    },
    missing,
  };
}

function countStructured(recipe, key) {
  if (!recipe || typeof recipe !== 'object') return 0;
  const value = recipe[key];
  if (Array.isArray(value)) return value.length;
  return 0;
}

module.exports = {
  MIN_TITLE_LENGTH,
  MIN_INGREDIENTS,
  MIN_INSTRUCTIONS,
  SUFFICIENT_SCORE,
  splitLines,
  hasMeaningfulTitle,
  countIngredientSignals,
  countInstructionSignals,
  assessTextSufficiency,
};
