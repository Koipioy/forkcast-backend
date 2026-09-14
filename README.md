# Forkast Backend

Firebase Cloud Functions backend for Forkast prepaid AI billing.

Current runtime:

```text
Node.js 22 (1st Gen Cloud Functions)
firebase-functions v7
```

## Quick Start

Install dependencies:

```bash
cd functions
npm install
```

Run tests:

```bash
npm test
```

Deploy functions:

```bash
cd /home/lilwilly/projects/forkast/forkcast-backend
npx firebase deploy --only functions --project forkast-da914 --force
```

Deploy Firestore rules and indexes:

```bash
npx firebase deploy --only firestore --project forkast-da914 --force
```

## Secrets

Secrets are stored in Firebase Secret Manager and declared in:

```text
functions/billing/params.js
```

Required secret names:

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

Non-secret runtime values are loaded from:

```text
functions/.env
```

## API Endpoints

Base URL:

```text
https://us-central1-forkast-da914.cloudfunctions.net
```

- `POST /runAI` - server-authoritative AI call with reservation and settlement.
- `POST /runLLM` - backward-compatible alias for `/runAI`.
- `POST /createCheckoutSession` - create Stripe one-time top-up checkout.
- `POST /stripeWebhook` - process Stripe webhook events and credit top-ups.
- `GET /getBillingSummary` - return balance, reserved balance, ledger, top-up options.
- `GET /topupOptions` - return available top-up options.
- `GET /health` - return service and secret presence status.
- Scheduled `releaseExpiredReservations` - release stale reservations.

All user-facing endpoints require Firebase Auth in:

```text
Authorization: Bearer <id_token>
```

## Billing Model

Internal accounting uses microdollars:

```text
$1.00 = 1,000,000 microdollars
```

Default markup:

```text
10% = 1000 basis points
```

See `STRIPE_SETUP.md` for Stripe and secret rotation details.
