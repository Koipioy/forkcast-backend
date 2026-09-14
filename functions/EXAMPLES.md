# Code Examples

## Call /runAI From A Client

```javascript
async function callAI({ idToken, operationId, feature, text, provider, model, modelId, maxTokens }) {
  const response = await fetch(
    'https://us-central1-forkast-da914.cloudfunctions.net/runAI',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        operationId,
        feature,
        text,
        provider,
        model,
        modelId,
        maxTokens,
      }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'AI request failed');
  }

  return data;
}
```

## Create A Top-Up Checkout

```javascript
async function createTopup(idToken, optionId) {
  const response = await fetch(
    'https://us-central1-forkast-da914.cloudfunctions.net/createCheckoutSession',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ optionId }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Top-up checkout failed');
  }

  return data;
}
```

## Get Billing Summary

```javascript
async function getBillingSummary(idToken) {
  const response = await fetch(
    'https://us-central1-forkast-da914.cloudfunctions.net/getBillingSummary',
    {
      headers: {
        Authorization: `Bearer ${idToken}`,
      },
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to load billing summary');
  }

  return data;
}
```

## Read The Ledger From Firestore

```javascript
const { getFirestore } = require('firebase-admin/firestore');

async function getRecentLedger(uid, limit = 20) {
  const db = getFirestore();
  const snapshot = await db
    .collection('billingLedger')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
```

## Format Microdollars

```javascript
function formatMicrodollars(value) {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(Number(value || 0));
  const dollars = Math.floor(abs / 1_000_000);
  const cents = Math.floor((abs % 1_000_000) / 10_000);
  return `${sign}$${dollars}.${String(cents).padStart(2, '0')}`;
}
```
