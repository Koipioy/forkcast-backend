# Code Examples

## Frontend Integration (React Native)

### 1. Initialize Firebase Auth

```javascript
import auth from '@react-native-firebase/auth';

// User is already authenticated via Firebase Auth
const user = auth().currentUser;
```

### 2. Call LLM Endpoint

```javascript
async function callLLM(prompt) {
  try {
    // Get Firebase ID token
    const user = auth().currentUser;
    if (!user) {
      throw new Error('User not authenticated');
    }
    
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
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Request failed');
    }
    
    const data = await response.json();
    return data.output;
    
  } catch (error) {
    console.error('LLM request failed:', error);
    throw error;
  }
}

// Usage
const response = await callLLM("Explain quantum physics simply");
console.log(response);
```

### 3. Create Stripe Customer

```javascript
async function setupBilling() {
  try {
    const user = auth().currentUser;
    if (!user) {
      throw new Error('User not authenticated');
    }
    
    const idToken = await user.getIdToken();
    
    const response = await fetch(
      'https://us-central1-<project-id>.cloudfunctions.net/createStripeCustomer',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${idToken}`,
        },
      }
    );
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || 'Failed to create customer');
    }
    
    const data = await response.json();
    console.log('Customer created:', data.customer.id);
    return data;
    
  } catch (error) {
    console.error('Billing setup failed:', error);
    throw error;
  }
}
```

## Firestore Queries

### Get User's Usage Records

```javascript
const { db } = require('./firebase');

async function getUserUsage(uid, limit = 10) {
  const snapshot = await db
    .collection('usage')
    .doc(uid)
    .collection('records')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();
  
  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

// Usage
const records = await getUserUsage('user123', 20);
console.log('Total records:', records.length);
```

### Get Total Token Usage

```javascript
async function getTotalTokens(uid) {
  const snapshot = await db
    .collection('usage')
    .doc(uid)
    .collection('records')
    .get();
  
  let total = 0;
  snapshot.docs.forEach(doc => {
    total += doc.data().tokens || 0;
  });
  
  return total;
}

// Usage
const total = await getTotalTokens('user123');
console.log('Total tokens used:', total);
console.log('Total units (billed):', Math.ceil(total / 100000));
```

### Get User's Stripe Info

```javascript
async function getUserStripeInfo(uid) {
  const userDoc = await db.collection('users').doc(uid).get();
  
  if (!userDoc.exists) {
    return null;
  }
  
  const data = userDoc.data();
  return {
    stripeCustomerId: data.stripeCustomerId,
    subscriptionId: data.subscriptionId,
    subscriptionItemId: data.subscriptionItemId
  };
}

// Usage
const stripeInfo = await getUserStripeInfo('user123');
if (stripeInfo) {
  console.log('Customer ID:', stripeInfo.stripeCustomerId);
}
```

## Testing with cURL

### Test runLLM

```bash
# Get Firebase ID token (from your app)
ID_TOKEN="your-firebase-id-token-here"

curl -X POST \
  https://us-central1-<project-id>.cloudfunctions.net/runLLM \
  -H "Authorization: Bearer $ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Write a haiku about coding"
  }'
```

### Test createStripeCustomer

```bash
ID_TOKEN="your-firebase-id-token-here"

curl -X POST \
  https://us-central1-<project-id>.cloudfunctions.net/createStripeCustomer \
  -H "Authorization: Bearer $ID_TOKEN"
```

## Error Handling Examples

### Handle Authentication Errors

```javascript
try {
  const response = await callLLM(prompt);
} catch (error) {
  if (error.message.includes('Invalid ID token')) {
    // Token expired, refresh it
    const newToken = await user.getIdToken(true);
    // Retry request
  } else if (error.message.includes('User not found')) {
    // User needs to create Stripe customer first
    await setupBilling();
    // Retry request
  } else {
    // Other error
    console.error('Error:', error);
  }
}
```

### Handle Billing Errors

```javascript
try {
  const response = await callLLM(prompt);
} catch (error) {
  if (error.message.includes('No active subscription')) {
    // Redirect to billing setup
    navigation.navigate('BillingSetup');
  } else if (error.message.includes('subscription')) {
    // Subscription issue
    console.error('Billing error:', error);
  }
}
```

## Stripe Webhook Testing

### Test Webhook Locally with Stripe CLI

```bash
# Install Stripe CLI
# https://stripe.com/docs/stripe-cli

# Forward webhooks to local function
stripe listen --forward-to http://localhost:5001/<project-id>/us-central1/stripeWebhook

# Trigger test event
stripe trigger invoice.paid
```

### Webhook Event Handling

The webhook handler in `index.js` processes these events:

```javascript
// invoice.paid - Invoice was paid
// You can update user status, send notifications, etc.

// customer.subscription.updated - Subscription changed
// Sync subscription status to Firestore

// customer.subscription.deleted - Subscription cancelled
// Mark user as inactive, clean up data
```

## Monitoring Usage

### Check User's Billing Status

```javascript
const user = await getUser('user123');
if (user?.subscriptionItemId) {
  console.log('User has active subscription');
  console.log('Subscription ID:', user.subscriptionId);
} else {
  console.log('User needs to set up billing');
}
```

### Calculate Billing

```javascript
// Get total tokens used
const totalTokens = await getTotalTokens('user123');

// Convert to units (1 unit = 100,000 tokens)
const units = Math.ceil(totalTokens / 100000);

console.log(`User has used ${totalTokens} tokens`);
console.log(`This equals ${units} billing units`);
```

