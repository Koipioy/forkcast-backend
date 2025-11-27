/**
 * Stripe billing utilities
 * Handles Stripe operations for metered billing
 */

const Stripe = require('stripe');
const functions = require('firebase-functions');

// Get Stripe secret key from environment
// In production, use: firebase functions:config:set stripe.secret="sk_live_..."
const STRIPE_SECRET = process.env.STRIPE_SECRET || functions.config().stripe?.secret;
const STRIPE_PRICE = process.env.STRIPE_PRICE || functions.config().stripe?.price;

if (!STRIPE_SECRET) {
  console.warn('Warning: STRIPE_SECRET not set. Billing functions will fail.');
}

// Initialize Stripe client
let stripe = null;
if (STRIPE_SECRET) {
  stripe = new Stripe(STRIPE_SECRET, {
    apiVersion: '2024-06-20.acacia' // Use latest stable version
  });
}

/**
 * Creates a new Stripe customer
 * @param {string} email - Customer email
 * @param {string} uid - Firebase user ID (for metadata)
 * @returns {Promise<object>} - Stripe customer object
 */
async function createCustomer(email, uid) {
  if (!stripe) {
    throw new Error('Stripe client not initialized. Check STRIPE_SECRET configuration.');
  }

  try {
    const customer = await stripe.customers.create({
      email,
      metadata: {
        firebase_uid: uid
      }
    });

    return customer;
  } catch (error) {
    throw new Error(`Failed to create Stripe customer: ${error.message}`);
  }
}

/**
 * Creates a metered subscription for a customer
 * @param {string} customerId - Stripe customer ID
 * @param {string} priceId - Stripe price ID for metered billing
 * @returns {Promise<{subscription: object, subscriptionItem: object}>} - Subscription and item
 */
async function createMeteredSubscription(customerId, priceId = null) {
  if (!stripe) {
    throw new Error('Stripe client not initialized. Check STRIPE_SECRET configuration.');
  }

  const priceToUse = priceId || STRIPE_PRICE;

  if (!priceToUse) {
    throw new Error('Stripe price ID not configured. Set STRIPE_PRICE or pass priceId.');
  }

  try {
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [
        {
          price: priceToUse
        }
      ],
      // Metered billing - pay for what you use
      billing_cycle_anchor: 'now'
    });

    // Get the subscription item ID (needed for usage records)
    const subscriptionItem = subscription.items.data[0];

    return {
      subscription,
      subscriptionItem
    };
  } catch (error) {
    throw new Error(`Failed to create Stripe subscription: ${error.message}`);
  }
}

/**
 * Reports usage to Stripe for metered billing
 * @param {string} subscriptionItemId - Stripe subscription item ID
 * @param {number} tokensUsed - Number of tokens used
 * @returns {Promise<object>} - Stripe usage record
 */
async function reportUsage(subscriptionItemId, tokensUsed) {
  if (!stripe) {
    throw new Error('Stripe client not initialized. Check STRIPE_SECRET configuration.');
  }

  // Convert tokens to units (1 unit = 100,000 tokens)
  // Round up to ensure we bill for partial usage
  const units = Math.ceil(tokensUsed / 100000);

  if (units <= 0) {
    // No usage to report
    return { quantity: 0, units: 0 };
  }

  try {
    const usageRecord = await stripe.subscriptionItems.createUsageRecord(
      subscriptionItemId,
      {
        quantity: units,
        action: 'increment',
        timestamp: Math.floor(Date.now() / 1000) // Unix timestamp
      }
    );

    return {
      usageRecord,
      units,
      tokensUsed
    };
  } catch (error) {
    throw new Error(`Failed to report usage to Stripe: ${error.message}`);
  }
}

/**
 * Gets subscription details
 * @param {string} subscriptionId - Stripe subscription ID
 * @returns {Promise<object>} - Subscription object
 */
async function getSubscription(subscriptionId) {
  if (!stripe) {
    throw new Error('Stripe client not initialized. Check STRIPE_SECRET configuration.');
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return subscription;
  } catch (error) {
    throw new Error(`Failed to get subscription: ${error.message}`);
  }
}

/**
 * Cancels a subscription
 * @param {string} subscriptionId - Stripe subscription ID
 * @returns {Promise<object>} - Cancelled subscription object
 */
async function cancelSubscription(subscriptionId) {
  if (!stripe) {
    throw new Error('Stripe client not initialized. Check STRIPE_SECRET configuration.');
  }

  try {
    const subscription = await stripe.subscriptions.cancel(subscriptionId);
    return subscription;
  } catch (error) {
    throw new Error(`Failed to cancel subscription: ${error.message}`);
  }
}

module.exports = {
  createCustomer,
  createMeteredSubscription,
  reportUsage,
  getSubscription,
  cancelSubscription,
  stripe // Export for webhook signature verification
};

