/**
 * Usage logging utilities
 * Handles Firestore operations for usage records
 */

const { db } = require('./firebase');

const USAGE_COLLECTION = 'usage';

/**
 * Logs token usage to Firestore
 * @param {string} uid - User ID
 * @param {number} tokens - Number of tokens used
 * @param {string} model - Model used
 * @returns {Promise<object>} - Created usage record
 */
async function logUsage(uid, tokens, model) {
  const usageData = {
    tokens,
    model,
    timestamp: Date.now()
  };

  // Store in usage/{uid}/records/{autoId}
  const usageRef = await db
    .collection(USAGE_COLLECTION)
    .doc(uid)
    .collection('records')
    .add(usageData);

  return {
    id: usageRef.id,
    ...usageData
  };
}

/**
 * Gets usage records for a user
 * @param {string} uid - User ID
 * @param {number} limit - Maximum number of records to return
 * @returns {Promise<Array>} - Array of usage records
 */
async function getUserUsage(uid, limit = 100) {
  const snapshot = await db
    .collection(USAGE_COLLECTION)
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

/**
 * Gets total token usage for a user
 * @param {string} uid - User ID
 * @returns {Promise<number>} - Total tokens used
 */
async function getTotalUsage(uid) {
  const snapshot = await db
    .collection(USAGE_COLLECTION)
    .doc(uid)
    .collection('records')
    .get();

  let total = 0;
  snapshot.docs.forEach(doc => {
    total += doc.data().tokens || 0;
  });

  return total;
}

module.exports = {
  logUsage,
  getUserUsage,
  getTotalUsage
};

