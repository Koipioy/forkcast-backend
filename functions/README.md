# Forkcast Backend - Firebase Cloud Functions

Complete backend implementation for Forkcast: LLM Proxy with Stripe Metered Billing.

## Overview

This backend provides:
- 🔐 Firebase Auth token verification
- 💳 Stripe metered (usage-based) billing
- 📊 Firestore for user/subscription mappings and usage logs
- 🤖 LLM API proxy (OpenAI by default, easily swappable)
- 🔒 Secure key management via Firebase Functions config
- 📝 Comprehensive error handling

## Project Structure

```
functions/
├── index.js          # Main Cloud Functions entry point
├── firebase.js       # Firebase Admin initialization
├── auth.js           # Token verification utilities
├── users.js          # Firestore user operations
├── llm.js            # LLM proxy (OpenAI)
├── billing.js        # Stripe operations
├── usage.js          # Usage logging to Firestore
├── package.json      # Dependencies
└── README.md         # This file
```

## Firestore Schema

### Users Collection
```
users/{uid}
  - stripeCustomerId: string
  - subscriptionId: string
  - subscriptionItemId: string
  - createdAt: number (timestamp)
  - updatedAt: number (timestamp)
```

### Usage Collection
```
usage/{uid}/records/{autoId}
  - tokens: number
  - model: string
  - timestamp: number
```

## Setup Instructions

### 1. Prerequisites

- Node.js 18+
- Firebase CLI installed: `npm install -g firebase-tools`
- Firebase project created
- Stripe account with a metered price configured

### 2. Install Dependencies

```bash
cd functions
npm install
```

### 3. Configure Firebase

```bash
# Login to Firebase
firebase login

# Initialize Firebase (if not already done)
firebase init functions

# Select your Firebase project
```

### 4. Set Environment Variables

Set your secrets using Firebase Functions config:

```bash
# OpenAI API Key
firebase functions:config:set openai.key="sk-..."

# Stripe Secret Key
firebase functions:config:set stripe.secret="sk_live_..." # or sk_test_... for testing

# Stripe Price ID (for metered billing)
firebase functions:config:set stripe.price="price_..."

# Stripe Webhook Secret (get this from Stripe Dashboard after creating webhook)
firebase functions:config:set stripe.webhook_secret="whsec_..."
```

**Important:** Never commit secrets to git. They are stored securely in Firebase.

### 5. Deploy Functions

```bash
# From the functions directory
cd functions
npm install
firebase deploy --only functions
```

Or from the project root:

```bash
firebase deploy --only functions
```

### 6. Configure Stripe Webhook

1. Go to [Stripe Dashboard > Webhooks](https://dashboard.stripe.com/webhooks)
2. Click "Add endpoint"
3. Enter your webhook URL: `https://us-central1-<your-project-id>.cloudfunctions.net/stripeWebhook`
4. Select events to listen to:
   - `invoice.paid`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Copy the webhook signing secret and set it:
   ```bash
   firebase functions:config:set stripe.webhook_secret="whsec_..."
   ```
6. Redeploy functions:
   ```bash
   firebase deploy --only functions
   ```

## API Endpoints

### POST /runLLM

Main endpoint for LLM requests.

**Request:**
```bash
curl -X POST \
  https://us-central1-<project-id>.cloudfunctions.net/runLLM \
  -H "Authorization: Bearer <firebase_id_token>" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain quantum physics simply", "provider": "openai", "model": "gpt-5.6-luna"}'
```

`provider` is optional. If omitted, the backend infers it from the model name and
falls back to OpenAI. Supported providers are `openai`, `anthropic`, and `google`.

**Response:**
```json
{
  "output": "Quantum physics is...",
  "tokensUsed": 1234,
  "unitsReported": 1,
  "model": "gpt-5.6-luna",
  "provider": "openai"
}
```

**Error Responses:**
- `400` - Missing/invalid prompt
- `401` - Invalid or missing auth token
- `404` - User not found
- `500` - Internal server error

### POST /createStripeCustomer

Creates a Stripe customer and metered subscription for the authenticated user.

**Request:**
```bash
curl -X POST \
  https://us-central1-<project-id>.cloudfunctions.net/createStripeCustomer \
  -H "Authorization: Bearer <firebase_id_token>"
```

**Response:**
```json
{
  "customer": {
    "id": "cus_...",
    "email": "user@example.com"
  },
  "subscription": {
    "id": "sub_...",
    "status": "active"
  },
  "subscriptionItem": {
    "id": "si_...",
    "price": "price_..."
  }
}
```

### POST /stripeWebhook

Stripe webhook endpoint (called by Stripe, not your app).

**Note:** This endpoint validates webhook signatures and handles Stripe events.

## Billing Model

### Token to Units Conversion

- **1 unit = 100,000 tokens**
- Units are rounded up (e.g., 50,001 tokens = 1 unit, 150,000 tokens = 2 units)
- Usage is reported to Stripe after each LLM request

### Example

If a user makes 3 requests:
1. Request 1: 45,000 tokens → 1 unit
2. Request 2: 80,000 tokens → 1 unit  
3. Request 3: 25,000 tokens → 1 unit

Total: 3 units billed to Stripe

## Frontend Integration (React Native)

### Example Usage

```javascript
import auth from '@react-native-firebase/auth';

async function callLLM(prompt) {
  // Get Firebase ID token
  const user = auth().currentUser;
  const idToken = await user.getIdToken();

  // Call backend
  const response = await fetch(
    'https://us-central1-<project-id>.cloudfunctions.net/runLLM',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt }),
    }
  );

  const data = await response.json();
  return data.output;
}
```

## Local Development

### Run Emulator

```bash
firebase emulators:start --only functions
```

Functions will be available at `http://localhost:5001/<project-id>/us-central1/<function-name>`

### Test Locally

For local testing, you can set environment variables in `.env` (not committed):

```bash
# .env (local development only)
OPENAI_API_KEY=sk-...
# OPENAI_KEY is also accepted for backwards compatibility.
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
STRIPE_SECRET=sk_test_...
STRIPE_PRICE=price_...
```

## Swapping LLM Providers

To use a different LLM provider, modify `functions/llm.js`:

1. Update `callLLM()` function to call your provider
2. Ensure it returns: `{ output: string, tokensUsed: number, model: string }`
3. Update `getDefaultModel()` if needed

Example for Anthropic Claude:

```javascript
const Anthropic = require('@anthropic-ai/sdk');

async function callClaude(prompt, model = 'claude-3-5-sonnet-20241022') {
  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
  const message = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });
  
  return {
    output: message.content[0].text,
    tokensUsed: message.usage.input_tokens + message.usage.output_tokens,
    model
  };
}
```

## Monitoring & Logs

View function logs:

```bash
firebase functions:log
```

Or in Firebase Console:
https://console.firebase.google.com/project/<project-id>/functions/logs

## Security Notes

1. ✅ **Never commit secrets** - Use `firebase functions:config:set`
2. ✅ **Always verify tokens** - All endpoints verify Firebase ID tokens
3. ✅ **Validate webhook signatures** - Stripe webhooks verify signatures
4. ✅ **CORS enabled** - Adjust CORS settings in `index.js` for production
5. ✅ **Error handling** - Errors don't expose sensitive information

## Troubleshooting

### "OPENAI_KEY not set"
- Run: `firebase functions:config:set openai.key="sk-..."`

### "Stripe client not initialized"
- Run: `firebase functions:config:set stripe.secret="sk_..."`

### "User not found"
- Call `/createStripeCustomer` first to set up billing

### Webhook signature verification fails
- Ensure webhook secret is set correctly
- Verify webhook URL in Stripe Dashboard matches your function URL
- Check that you're using the correct webhook secret for the endpoint

## Example Firestore Queries

### Get user's usage records
```javascript
const { db } = require('./firebase');
const snapshot = await db
  .collection('usage')
  .doc(uid)
  .collection('records')
  .orderBy('timestamp', 'desc')
  .limit(10)
  .get();
```

### Get user's Stripe info
```javascript
const userDoc = await db.collection('users').doc(uid).get();
const { stripeCustomerId, subscriptionId } = userDoc.data();
```

## License

MIT

