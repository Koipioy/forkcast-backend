# Stripe Prepaid Top-Up Setup

Forkast now uses **prepaid credit**, not a metered subscription.

Users buy credit through Stripe Checkout. The Firebase backend stores the credit
in the user's Firestore balance. AI requests debit that balance server-side.

## Current Runtime

```text
Node.js 22 (1st Gen Cloud Functions)
firebase-functions v7
```

Secrets are stored in Firebase Secret Manager and declared in:

```text
functions/billing/params.js
```

Non-secret runtime values are loaded from:

```text
functions/.env
```

Do not put provider keys or Stripe keys in the Expo app bundle.

## Required Secrets

Set these with the local Firebase CLI:

```bash
cd /home/lilwilly/projects/forkast/forkcast-backend

npx firebase functions:secrets:set OPENAI_API_KEY --project forkast-da914
npx firebase functions:secrets:set ANTHROPIC_API_KEY --project forkast-da914
npx firebase functions:secrets:set GEMINI_API_KEY --project forkast-da914
npx firebase functions:secrets:set STRIPE_SECRET --project forkast-da914
npx firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project forkast-da914
```

Then deploy:

```bash
npx firebase deploy --only functions --project forkast-da914 --force
```

## Stripe Webhook

Stripe Dashboard webhook endpoint:

```text
https://us-central1-forkast-da914.cloudfunctions.net/stripeWebhook
```

Required events:

```text
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
charge.refunded
```

## Top-Up Options

Top-up options are configured server-side in:

```text
functions/billing/config.js
```

Default options:

```text
usd_5   = $5.00
usd_10  = $10.00
usd_20  = $20.00
```

The client sends only an `optionId`.

## Billing Model

Internal accounting uses microdollars:

```text
$1.00 = 1,000,000 microdollars
```

Default markup:

```text
10% = 1000 basis points
```

Every ledger entry stores the pricing version and actual markup used.

## Rotating The Old Committed Stripe Test Secret

Stripe does not expose API-key rotation through the public API. Rotate manually:

1. Open Stripe Dashboard -> Developers -> API keys.
2. Roll the old test secret key.
3. Update Firebase Secret Manager:

```bash
cd /home/lilwilly/projects/forkast/forkcast-backend
npx firebase functions:secrets:set STRIPE_SECRET --project forkast-da914
npx firebase functions:secrets:set STRIPE_WEBHOOK_SECRET --project forkast-da914
npx firebase deploy --only functions --project forkast-da914 --force
```

4. Verify:

```bash
curl https://us-central1-forkast-da914.cloudfunctions.net/health
```

Expected:

```json
{
  "ok": true,
  "config": {
    "hasStripeSecret": true,
    "hasStripeWebhookSecret": true
  }
}
```
