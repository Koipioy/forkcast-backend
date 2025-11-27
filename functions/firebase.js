/**
 * Firebase Admin SDK initialization
 * This module initializes Firebase Admin for server-side operations
 */

const admin = require('firebase-admin');

// Initialize Firebase Admin
// In production, this uses the default service account
// Make sure your Firebase project is properly configured
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = {
  admin,
  db,
  auth
};

