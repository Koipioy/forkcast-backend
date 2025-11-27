# Forkcast Backend

Firebase Cloud Functions backend for Forkcast - LLM Proxy with Stripe Metered Billing.

## Quick Start

1. **Install dependencies:**
   ```bash
   cd functions
   npm install
   ```

2. **Configure Firebase:**
   ```bash
   firebase login
   firebase init functions
   ```

3. **Set environment variables:**
   ```bash
   firebase functions:config:set openai.key="sk-..."
   firebase functions:config:set stripe.secret="sk_live_..."
   firebase functions:config:set stripe.price="price_..."
   firebase functions:config:set stripe.webhook_secret="whsec_..."
   ```

4. **Deploy:**
   ```bash
   firebase deploy --only functions
   ```

## Documentation

See [functions/README.md](./functions/README.md) for complete documentation including:
- API endpoints
- Firestore schema
- Frontend integration examples
- Troubleshooting guide

## Project Structure

```
.
├── functions/          # Firebase Cloud Functions
│   ├── index.js       # Main entry point
│   ├── auth.js        # Token verification
│   ├── users.js       # User management
│   ├── llm.js         # LLM proxy
│   ├── billing.js     # Stripe operations
│   ├── usage.js       # Usage logging
│   └── package.json   # Dependencies
└── README.md          # This file
```

## API Endpoints

- `POST /runLLM` - Main LLM endpoint
- `POST /createStripeCustomer` - Create Stripe customer & subscription
- `POST /stripeWebhook` - Stripe webhook handler

All endpoints require Firebase Auth token in `Authorization: Bearer <token>` header.

