# Deployment Guide

## Runtime

```text
Node.js 22 (1st Gen Cloud Functions)
firebase-functions v7
```

The code uses `firebase-functions/v1` because the deployed functions are 1st Gen.
Do not switch exports to 2nd Gen unless you intentionally recreate the functions.

## Local Firebase CLI

Use the repo-local Firebase CLI:

```bash
cd /home/lilwilly/projects/forkast/forkcast-backend
npx firebase --version
```

Current verified CLI version:

```text
15.30.0
```

## Deploy Functions

```bash
cd /home/lilwilly/projects/forkast/forkcast-backend
npx firebase deploy --only functions --project forkast-da914 --force
```

## Deploy Firestore Rules And Indexes

```bash
cd /home/lilwilly/projects/forkast/forkcast-backend
npx firebase deploy --only firestore --project forkast-da914 --force
```

## Secrets

Secrets are stored in Firebase Secret Manager.

Required names:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
STRIPE_SECRET
STRIPE_WEBHOOK_SECRET
```

Set a secret:

```bash
npx firebase functions:secrets:set STRIPE_SECRET --project forkast-da914
```

After changing secrets, redeploy functions:

```bash
npx firebase deploy --only functions --project forkast-da914 --force
```

## Non-Secret Environment Variables

Non-secret values are loaded from:

```text
functions/.env
```

Examples:

```text
OPENAI_BASE_URL=https://api.openai.com/v1
ANTHROPIC_BASE_URL=https://api.anthropic.com
BILLING_MARKUP_BPS=1000
BILLING_PRICING_VERSION=2026-09-v1
BILLING_ENFORCEMENT=on
BILLING_SUCCESS_URL=forkcast://topup-success
BILLING_CANCEL_URL=forkcast://topup-cancel
```

## Verify Deployment

```bash
curl https://us-central1-forkast-da914.cloudfunctions.net/health
```

Expected:

```json
{
  "ok": true,
  "service": "forkcast-backend",
  "pricingVersion": "2026-09-v1",
  "config": {
    "hasOpenAIKey": true,
    "hasAnthropicKey": true,
    "hasGeminiKey": true,
    "hasStripeSecret": true,
    "hasStripeWebhookSecret": true
  }
}
```

## Stripe Webhook

Endpoint:

```text
https://us-central1-forkast-da914.cloudfunctions.net/stripeWebhook
```

Events:

```text
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
charge.refunded
```

## Notes

- `functions.config()` is removed in `firebase-functions` v7.
- Do not use `firebase functions:config:set` for new configuration.
- The old committed Stripe test secret must be rolled in the Stripe dashboard.
