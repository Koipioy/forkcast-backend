'use strict';

/**
 * Firestore increment helper that works with real admin Firestore instances and
 * lightweight test fakes.
 */
function increment(db, value) {
  if (db && db.FieldValue && typeof db.FieldValue.increment === 'function') {
    return db.FieldValue.increment(value);
  }
  if (db && db.firestore && db.firestore.FieldValue && typeof db.firestore.FieldValue.increment === 'function') {
    return db.firestore.FieldValue.increment(value);
  }
  const { FieldValue } = require('firebase-admin/firestore');
  return FieldValue.increment(value);
}

module.exports = {
  increment,
};
