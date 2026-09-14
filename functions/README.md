# Forkcast Backend Functions

Firebase Cloud Functions for Forkast prepaid AI billing.

Current runtime:

```text
Node.js 22 (1st Gen Cloud Functions)
firebase-functions v7
```

The functions intentionally use the v1 API (`firebase-functions/v1`) because the
existing deployed functions are 1st Gen. `firebase-functions` v7 removed
`functions.config()`, so secrets now use Firebase Secret Manager.

## Project Structure

```text
functions/
├── index.js                 # HTTP and scheduled function exports
├── llm.js                   # Provider adapters and usage normalization
├── billing.js               # Stripe top-up checkout and webhook processing
├── firebase.js              # Firebase Admin initialization
├── auth.js                  # Firebase Auth helpers
├── params.js                # Secret Manager parameter definitions
├── billing/
│   ├── config.js            # Pricing, markup, top-up options, feature config
│   ├── aiCost.js            # AI and infrastructure cost calculation
│   ├── balance.js           # Reservation, settlement, release logic
│   ├── ledger.js            # Append-only ledger helpers
│   ├── money.js             # Microdollar integer helpers
│   ├── paymentFees.js       # Stripe fee estimates
│   └── firestoreValue.js    # Firestore increment compatibility helper
└── tests/                   # Node test files
```

## Secrets

Required Secret Manager names:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
STRIPE_SECRET
STRIPE_WEBHOOK_SECRET
```

Set a secret:

```bash
npx firebase functions:secrets:set OPENAI_API_KEY --project forkast-da914
```

Non-secret runtime values are loaded from `functions/.env`.

## Tests

```bash
npm test
```

## Deploy

From the backend repo root:

```bash
npx firebase deploy --only functions --project forkast-da914 --force
```

## API Endpoints

Base URL:

```text
https://us-central1-forkast-da914.cloudfunctions.net
```

### POST /runAI

Server-authoritative AI call.

Request:

```json
{
  "operationId": "ai_1234567890",
  "feature": "meal_ideas",
  "text": "hello",
  "provider": "openai",
  "model": "gpt-5.6-luna",
  "modelId": "openai:gpt-5-6-luna",
  "maxTokens": 1000
}
```

Response:

```json
{
  "success": true,
  "output": "OK",
  "provider": "openai",
  "model": "gpt-5.6-luna",
  "requestId": "chatcmpl-...",
  "usage": {
    "inputTokens": 10,
    "outputTokens": 4,
    "cachedInputTokens": 0,
    "reasoningTokens": 0,
    "totalTokens": 14
  },
  "billing": {
    "rawCostMicros": 67,
    "aiRawCostMicros": 7,
    "infraRawCostMicros": 60,
    "markupBps": 1000,
    "markupMicros": 7,
    "chargedMicros": 74,
    "balanceBeforeMicros": 5000000,
    "balanceAfterMicros": 4999926,
    "pricingVersion": "2026-09-v1",
    "ledgerId": "..."
  }
}
```

### POST /runLLM

Backward-compatible alias for `/runAI`.

### POST /createCheckoutSession

Creates a Stripe one-time top-up checkout.

Request:

```json
{
  "optionId": "usd_5"
}
```

Response:

```json
{
  "success": true,
  "topupId": "topup_...",
  "url": "https://checkout.stripe.com/...",
  "sessionId": "cs_test_..."
}
```

### POST /stripeWebhook

Handles Stripe events:

```text
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
charge.refunded
```

### GET /getBillingSummary

Returns available balance, reserved balance, lifetime totals, top-up options,
recent ledger entries, and recent top-ups.

### GET /health

Returns service status and whether required secrets are present.

## Billing Model

Internal accounting uses microdollars:

```text
$1.00 = 1,000,000 microdollars
```

Default markup:

```text
10% = 1000 basis points
```

Failed AI requests are recorded as `no_charge` when the user receives no useful
output.
