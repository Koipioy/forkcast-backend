/**
 * Firebase Admin SDK initialization
 * This module initializes Firebase Admin for server-side operations
 */

const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

// Initialize Firebase Admin
// In production, this uses the default service account.
// Make sure your Firebase project is properly configured.
if (!admin.getApps || admin.getApps().length === 0) {
  admin.initializeApp();
}

const db = getFirestore();
const auth = getAuth();

module.exports = {
  admin,
  db,
  auth,
};

