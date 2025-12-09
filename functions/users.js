/**
 * User management utilities
 * Handles Firestore operations for user documents
 */

const { db } = require('./firebase');

const USERS_COLLECTION = 'users';

/**
 * Gets user document from Firestore
 * @param {string} uid - User ID
 * @returns {Promise<object|null>} - User document or null if not found
 */
async function getUser(uid) {
  const userDoc = await db.collection(USERS_COLLECTION).doc(uid).get();
  
  if (!userDoc.exists) {
    return null;
  }
  
  return {
    id: userDoc.id,
    ...userDoc.data()
  };
}

/**
 * Creates a new user document in Firestore
 * @param {string} uid - User ID
 * @param {object} userData - User data to store
 * @returns {Promise<object>} - Created user document
 */
async function createUser(uid, userData) {
  await db.collection(USERS_COLLECTION).doc(uid).set({
    ...userData,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  
  return getUser(uid);
}

/**
 * Updates user document in Firestore
 * @param {string} uid - User ID
 * @param {object} updates - Fields to update
 * @returns {Promise<object>} - Updated user document
 */
async function updateUser(uid, updates) {
  await db.collection(USERS_COLLECTION).doc(uid).update({
    ...updates,
    updatedAt: Date.now()
  });
  
  return getUser(uid);
}

/**
 * Sets Stripe customer information for a user
 * Creates the user document if it doesn't exist, or updates it if it does
 * @param {string} uid - User ID
 * @param {string} stripeCustomerId - Stripe customer ID
 * @param {string|null} subscriptionId - Stripe subscription ID (optional)
 * @param {string|null} subscriptionItemId - Stripe subscription item ID (optional)
 * @returns {Promise<object>} - Updated user document
 */
async function setStripeInfo(uid, stripeCustomerId, subscriptionId, subscriptionItemId) {
  const updates = {
    stripeCustomerId,
    updatedAt: Date.now()
  };
  
  if (subscriptionId) {
    updates.subscriptionId = subscriptionId;
  }
  
  if (subscriptionItemId) {
    updates.subscriptionItemId = subscriptionItemId;
  }
  
  // Use set with merge to create document if it doesn't exist, or update if it does
  const userRef = db.collection(USERS_COLLECTION).doc(uid);
  const userDoc = await userRef.get();
  
  if (!userDoc.exists) {
    // Document doesn't exist, set createdAt as well
    updates.createdAt = Date.now();
  }
  
  await userRef.set(updates, { merge: true });
  
  return getUser(uid);
}

/**
 * Gets user's Stripe subscription item ID
 * @param {string} uid - User ID
 * @returns {Promise<string|null>} - Subscription item ID or null
 */
async function getSubscriptionItemId(uid) {
  const user = await getUser(uid);
  return user?.subscriptionItemId || null;
}

module.exports = {
  getUser,
  createUser,
  updateUser,
  setStripeInfo,
  getSubscriptionItemId
};

