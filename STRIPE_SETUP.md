# Stripe Setup Guide

## Issue: Missing Stripe Price ID

You're getting this error because the Stripe Price ID is not configured. Here's how to fix it:

---

## Step 1: Create a Metered Price in Stripe

1. Go to [Stripe Dashboard > Products](https://dashboard.stripe.com/products)
2. Click **"+ Add product"**
3. Fill in:
   - **Name**: "Forkcast Usage" (or any name)
   - **Pricing model**: Select **"Metered billing"**
   - **Price**: Enter `0.00` (or your base price)
   - **Billing period**: Monthly (or your preference)
   - **Usage type**: Select **"Metered"**
   - **Unit**: Can be "unit" or "token" (doesn't matter, we report usage)
4. Click **"Save product"**
5. **Copy the Price ID** - it will look like `price_1ABC123xyz...`

---

## Step 2: Set the Price ID in Firebase

```bash
firebase functions:config:set stripe.price="price_1ABC123xyz..."
```

Replace `price_1ABC123xyz...` with your actual Price ID from Stripe.

---

## Step 3: Redeploy Functions

```bash
firebase deploy --only functions
```

---

## Complete Configuration

Make sure you have all these set:

```bash
# Stripe Secret Key (get this from Stripe Dashboard)
firebase functions:config:set stripe.secret="sk_test_YOUR_SECRET_KEY_HERE"

# Stripe Price ID (YOU NEED TO ADD THIS)
firebase functions:config:set stripe.price="price_YOUR_PRICE_ID_HERE"

# Gemini API Key (you already have this)
firebase functions:config:set llm.gemini_key="AIzaSyCARtV1Fcxr9dBZH-KcAY-UBePaAi33RqQ"
```

---

## Verify Configuration

```bash
firebase functions:config:get
```

You should see:
```json
{
  "stripe": {
    "secret": "sk_test_...",
    "price": "price_..."
  },
  "llm": {
    "gemini_key": "AIzaSy..."
  }
}
```

---

## About Checkout Sessions

**Important:** This backend does NOT use Stripe Checkout Sessions. 

The implementation works like this:
1. User calls `/createStripeCustomer` 
2. Backend automatically creates:
   - Stripe Customer
   - Metered Subscription (automatically active)
3. User can immediately use `/runLLM`
4. Usage is automatically reported to Stripe

**You don't need a checkout session function** - subscriptions are created automatically when the customer is created.

If you want checkout sessions (for payment collection), you'd need to add a separate function, but for metered billing with automatic subscription creation, you don't need it.

---

## Quick Fix Command

After creating the price in Stripe, run:

```bash
firebase functions:config:set stripe.price="YOUR_PRICE_ID"
firebase deploy --only functions:createStripeCustomer
```

Then test again!

