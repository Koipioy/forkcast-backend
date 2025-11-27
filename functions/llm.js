/**
 * LLM Proxy utilities
 * Handles communication with LLM providers (OpenAI by default)
 */

const OpenAI = require('openai');
const functions = require('firebase-functions');

// Get OpenAI API key from environment
// In production, use: firebase functions:config:set openai.key="sk-..."
const OPENAI_KEY = process.env.OPENAI_KEY || functions.config().openai?.key;

if (!OPENAI_KEY) {
  console.warn('Warning: OPENAI_KEY not set. LLM functions will fail.');
}

// Initialize OpenAI client
let openaiClient = null;
if (OPENAI_KEY) {
  openaiClient = new OpenAI({
    apiKey: OPENAI_KEY
  });
}

/**
 * Default model configuration
 * Easy to swap providers by changing this function
 */
function getDefaultModel() {
  return 'gpt-4o-mini';
}

/**
 * Calls OpenAI API with a prompt
 * @param {string} prompt - User's prompt
 * @param {string} model - Model to use (default: gpt-4o-mini)
 * @returns {Promise<{output: string, tokensUsed: number}>} - Response and token usage
 */
async function callOpenAI(prompt, model = null) {
  if (!openaiClient) {
    throw new Error('OpenAI client not initialized. Check OPENAI_KEY configuration.');
  }

  const modelToUse = model || getDefaultModel();

  try {
    const response = await openaiClient.chat.completions.create({
      model: modelToUse,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7
    });

    const output = response.choices[0]?.message?.content || '';
    const tokensUsed = response.usage?.total_tokens || 0;

    return {
      output,
      tokensUsed,
      model: modelToUse
    };
  } catch (error) {
    throw new Error(`OpenAI API error: ${error.message}`);
  }
}

/**
 * Main LLM call function
 * This is the abstraction point - swap providers here
 * @param {string} prompt - User's prompt
 * @param {object} options - Additional options (model, etc.)
 * @returns {Promise<{output: string, tokensUsed: number, model: string}>}
 */
async function callLLM(prompt, options = {}) {
  // Default to OpenAI, but easy to swap
  return await callOpenAI(prompt, options.model);
}

module.exports = {
  callLLM,
  callOpenAI,
  getDefaultModel
};

