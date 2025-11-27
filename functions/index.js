/**
 * Firebase Cloud Functions - Main Entry Point
 * Forkcast Backend: LLM Proxy with Stripe Metered Billing
 */

const functions = require('firebase-functions');
const { getAuthenticatedUser } = require('./auth');
const { getUser, setStripeInfo } = require('./users');
const { callLLM } = require('./llm');
const { reportUsage } = require('./billing');
const { logUsage } = require('./usage');
const { createCustomer, createMeteredSubscription, stripe } = require('./billing');
const { auth } = require('./firebase');

/**
 * POST /runLLM
 * Main endpoint for LLM requests
 * 
 * Request:
 *   Headers: Authorization: Bearer <firebase_id_token>
 *   Body: { "prompt": "..." }
 * 
 * Response:
 *   { "output": "...", "tokensUsed": 1234, "unitsReported": 1 }
 */
exports.runLLM = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    // 1. Verify Firebase ID token
    const { uid } = await getAuthenticatedUser(req);

    // 2. Extract prompt from request body
    const { prompt } = req.body;

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ error: 'Missing or invalid prompt in request body' });
      return;
    }

    // 3. Load user document from Firestore
    const user = await getUser(uid);

    if (!user) {
      res.status(404).json({ error: 'User not found. Please create a Stripe customer first.' });
      return;
    }

    // 4. Check for subscription item ID
    const subscriptionItemId = user.subscriptionItemId;

    if (!subscriptionItemId) {
      res.status(400).json({ 
        error: 'No active subscription found. Please create a Stripe customer and subscription first.' 
      });
      return;
    }

    // 5. Call LLM API
    const llmResponse = await callLLM(prompt);

    const { output, tokensUsed, model } = llmResponse;

    // 6. Save usage to Firestore
    await logUsage(uid, tokensUsed, model);

    // 7. Convert tokens to units and report to Stripe
    const units = Math.ceil(tokensUsed / 100000);
    let unitsReported = 0;

    if (units > 0) {
      try {
        await reportUsage(subscriptionItemId, tokensUsed);
        unitsReported = units;
      } catch (stripeError) {
        // Log error but don't fail the request
        console.error('Failed to report usage to Stripe:', stripeError);
        // Still return the response, but note the billing failure
      }
    }

    // 8. Return output to client
    res.status(200).json({
      output,
      tokensUsed,
      unitsReported,
      model
    });

  } catch (error) {
    console.error('Error in runLLM:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

/**
 * POST /createStripeCustomer
 * Creates a Stripe customer and metered subscription
 * 
 * Request:
 *   Headers: Authorization: Bearer <firebase_id_token>
 * 
 * Response:
 *   { "customer": {...}, "subscription": {...}, "subscriptionItem": {...} }
 */
exports.createStripeCustomer = functions.https.onRequest(async (req, res) => {
  // Enable CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
    return;
  }

  try {
    // 1. Verify Firebase ID token
    const { uid, decoded } = await getAuthenticatedUser(req);

    // 2. Get user email from token
    const email = decoded.email;

    if (!email) {
      res.status(400).json({ error: 'User email not found in token' });
      return;
    }

    // 3. Check if user already has Stripe customer
    const existingUser = await getUser(uid);
    if (existingUser?.stripeCustomerId) {
      res.status(400).json({ 
        error: 'User already has a Stripe customer',
        customerId: existingUser.stripeCustomerId
      });
      return;
    }

    // 4. Create Stripe customer
    const customer = await createCustomer(email, uid);

    // 5. Create metered subscription
    const { subscription, subscriptionItem } = await createMeteredSubscription(customer.id);

    // 6. Store Stripe info in Firestore
    await setStripeInfo(
      uid,
      customer.id,
      subscription.id,
      subscriptionItem.id
    );

    // 7. Return customer and subscription info
    res.status(200).json({
      customer: {
        id: customer.id,
        email: customer.email
      },
      subscription: {
        id: subscription.id,
        status: subscription.status
      },
      subscriptionItem: {
        id: subscriptionItem.id,
        price: subscriptionItem.price.id
      }
    });

  } catch (error) {
    console.error('Error in createStripeCustomer:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

/**
 * POST /stripeWebhook
 * Handles Stripe webhook events
 * 
 * This endpoint should be configured in Stripe Dashboard:
 * https://dashboard.stripe.com/webhooks
 * 
 * Events handled:
 * - invoice.paid
 * - customer.subscription.updated
 * - customer.subscription.deleted
 * 
 * Note: For webhook signature verification, we need raw body.
 * Firebase Functions v1 automatically provides req.rawBody.
 */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }

  // Get webhook secret from environment
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || 
                       functions.config().stripe?.webhook_secret;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    res.status(500).json({ error: 'Webhook secret not configured' });
    return;
  }

  let event;

  try {
    // Verify webhook signature
    // req.rawBody is available in Firebase Functions v1
    // For v2, you'd need to use express.raw() middleware
    const rawBody = req.rawBody || JSON.stringify(req.body);
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    res.status(400).json({ error: `Webhook Error: ${err.message}` });
    return;
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'invoice.paid':
        const invoice = event.data.object;
        console.log('Invoice paid:', invoice.id);
        // You can add custom logic here, e.g., update user status
        break;

      case 'customer.subscription.updated':
        const subscription = event.data.object;
        console.log('Subscription updated:', subscription.id);
        // You can add custom logic here, e.g., sync subscription status to Firestore
        break;

      case 'customer.subscription.deleted':
        const deletedSubscription = event.data.object;
        console.log('Subscription deleted:', deletedSubscription.id);
        // You can add custom logic here, e.g., mark user as inactive
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // Return a response to acknowledge receipt of the event
    res.status(200).json({ received: true });

  } catch (error) {
    console.error('Error handling webhook:', error);
    res.status(500).json({ error: 'Error processing webhook' });
  }
});

