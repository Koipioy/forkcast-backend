/**
 * Authentication utilities
 * Handles Firebase ID token verification
 */

const { auth } = require('./firebase');

/**
 * Verifies Firebase ID token from Authorization header
 * @param {string} authHeader - Authorization header value (Bearer <token>)
 * @returns {Promise<{uid: string, decoded: object}>} - User ID and decoded token
 * @throws {Error} - If token is invalid or missing
 */
async function verifyIdToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header. Expected: Bearer <token>');
  }

  const idToken = authHeader.split('Bearer ')[1];

  if (!idToken) {
    throw new Error('ID token not found in Authorization header');
  }

  try {
    const decoded = await auth.verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      decoded
    };
  } catch (error) {
    throw new Error(`Invalid ID token: ${error.message}`);
  }
}

/**
 * Middleware-style function to extract and verify token from request
 * @param {object} req - Express request object
 * @returns {Promise<{uid: string, decoded: object}>} - User ID and decoded token
 */
async function getAuthenticatedUser(req) {
  const authHeader = req.headers.authorization;
  return await verifyIdToken(authHeader);
}

module.exports = {
  verifyIdToken,
  getAuthenticatedUser
};

