'use strict';

/**
 * Firebase Functions parameter definitions.
 *
 * firebase-functions v7 removed functions.config(). Secrets are declared here and
 * resolved from Secret Manager at runtime. Non-secret values are read from normal
 * environment variables, which can be set in firebase.json or a local .env file.
 */

const { defineSecret } = require('firebase-functions/params');

const openaiApiKey = defineSecret('OPENAI_API_KEY');
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');
const geminiApiKey = defineSecret('GEMINI_API_KEY');
const stripeSecret = defineSecret('STRIPE_SECRET');
const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');

function safeSecret(secret) {
  try {
    return secret.value();
  } catch (_err) {
    return undefined;
  }
}

module.exports = {
  openaiApiKey,
  anthropicApiKey,
  geminiApiKey,
  stripeSecret,
  stripeWebhookSecret,
  safeSecret,
};
