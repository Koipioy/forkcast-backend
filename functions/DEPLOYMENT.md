# Deployment Instructions

## Prerequisites

1. **Firebase CLI installed:**
   ```bash
   npm install -g firebase-tools
   ```

2. **Firebase project created:**
   - Go to https://console.firebase.google.com
   - Create a new project or select existing one

3. **Stripe account set up:**
   - Create a metered price in Stripe Dashboard
   - Note the Price ID (starts with `price_`)

## Step-by-Step Deployment

### 1. Initialize Firebase (if not already done)

```bash
firebase login
firebase init functions
```

When prompted:
- Select your Firebase project
- Choose JavaScript (or TypeScript if preferred)
- Install dependencies: Yes

### 2. Install Dependencies

```bash
cd functions
npm install
```

### 3. Configure Environment Variables

Set all required secrets:

```bash
# OpenAI API Key
firebase functions:config:set openai.key="sk-..."

# Stripe Secret Key (use sk_test_... for testing, sk_live_... for production)
firebase functions:config:set stripe.secret="sk_test_..."

# Stripe Price ID (your metered price)
firebase functions:config:set stripe.price="price_..."

# Stripe Webhook Secret (set this after creating webhook in step 6)
firebase functions:config:set stripe.webhook_secret="whsec_..."
```

**Verify configuration:**
```bash
firebase functions:config:get
```

### 4. Deploy Functions

```bash
# From project root
firebase deploy --only functions

# Or from functions directory
cd functions
firebase deploy --only functions
```

**Deploy specific function:**
```bash
firebase deploy --only functions:runLLM
```

### 5. Get Function URLs

After deployment, you'll see output like:

```
✔  functions[runLLM(us-central1)]: Successful create operation.
✔  functions[createStripeCustomer(us-central1)]: Successful create operation.
✔  functions[stripeWebhook(us-central1)]: Successful create operation.

Function URLs:
  runLLM: https://us-central1-<project-id>.cloudfunctions.net/runLLM
  createStripeCustomer: https://us-central1-<project-id>.cloudfunctions.net/createStripeCustomer
  stripeWebhook: https://us-central1-<project-id>.cloudfunctions.net/stripeWebhook
```

### 6. Configure Stripe Webhook

1. Go to [Stripe Dashboard > Webhooks](https://dashboard.stripe.com/webhooks)
2. Click **"Add endpoint"**
3. Enter endpoint URL:
   ```
   https://us-central1-<your-project-id>.cloudfunctions.net/stripeWebhook
   ```
4. Select events to listen to:
   - `invoice.paid`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
5. Click **"Add endpoint"**
6. Copy the **Signing secret** (starts with `whsec_`)
7. Set it in Firebase:
   ```bash
   firebase functions:config:set stripe.webhook_secret="whsec_..."
   ```
8. Redeploy:
   ```bash
   firebase deploy --only functions:stripeWebhook
   ```

### 7. Test Deployment

**Test runLLM endpoint:**
```bash
curl -X POST \
  https://us-central1-<project-id>.cloudfunctions.net/runLLM \
  -H "Authorization: Bearer <firebase_id_token>" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello, world!"}'
```

**Test createStripeCustomer:**
```bash
curl -X POST \
  https://us-central1-<project-id>.cloudfunctions.net/createStripeCustomer \
  -H "Authorization: Bearer <firebase_id_token>"
```

## Updating Functions

After making code changes:

```bash
# Deploy all functions
firebase deploy --only functions

# Deploy specific function
firebase deploy --only functions:runLLM

# Deploy with force (if needed)
firebase deploy --only functions --force
```

## Viewing Logs

```bash
# All logs
firebase functions:log

# Specific function
firebase functions:log --only runLLM

# Follow logs in real-time
firebase functions:log --follow
```

Or view in Firebase Console:
https://console.firebase.google.com/project/<project-id>/functions/logs

## Environment Variables Reference

| Variable | Command | Description |
|----------|---------|-------------|
| `openai.key` | `firebase functions:config:set openai.key="sk-..."` | OpenAI API key |
| `stripe.secret` | `firebase functions:config:set stripe.secret="sk_..."` | Stripe secret key |
| `stripe.price` | `firebase functions:config:set stripe.price="price_..."` | Stripe metered price ID |
| `stripe.webhook_secret` | `firebase functions:config:set stripe.webhook_secret="whsec_..."` | Stripe webhook signing secret |

## Troubleshooting

### "Permission denied" errors
- Ensure you're logged in: `firebase login`
- Check project permissions in Firebase Console

### "Function failed to deploy"
- Check logs: `firebase functions:log`
- Verify all environment variables are set
- Check Node.js version (should be 18+)

### "Module not found" errors
- Run `npm install` in functions directory
- Check package.json dependencies

### Webhook signature verification fails
- Ensure webhook secret matches Stripe Dashboard
- Verify webhook URL is correct
- Check that webhook is enabled in Stripe

## Production Checklist

- [ ] All environment variables set
- [ ] Stripe webhook configured
- [ ] Functions deployed successfully
- [ ] Test endpoints working
- [ ] Logs accessible
- [ ] CORS configured (if needed for web frontend)
- [ ] Error handling tested
- [ ] Billing flow tested end-to-end

## Rollback

If you need to rollback:

```bash
# List deployments
firebase functions:list

# Rollback to previous version (if available in Firebase Console)
# Or redeploy previous code from git
git checkout <previous-commit>
firebase deploy --only functions
```

