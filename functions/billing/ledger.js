'use strict';

const { toSafeNumber } = require('./money');

function sanitizeDocPart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 180);
}

function makeLedgerId(userId, source, idempotencyKey) {
  const safeUser = sanitizeDocPart(userId);
  const safeSource = sanitizeDocPart(source);
  const safeKey = sanitizeDocPart(idempotencyKey);
  return `${safeUser}__${safeSource}__${safeKey}`;
}

function normalizeLedgerEntry(entry) {
  const now = entry.createdAt || Date.now();
  const normalized = {
    ...entry,
    createdAt: now,
    source: entry.source,
    type: entry.type || 'debit',
    amountMicros: toSafeNumber(entry.amountMicros ?? 0, 'amountMicros'),
    balanceBeforeMicros: toSafeNumber(entry.balanceBeforeMicros ?? 0, 'balanceBeforeMicros'),
    balanceAfterMicros: toSafeNumber(entry.balanceAfterMicros ?? 0, 'balanceAfterMicros'),
    status: entry.status || 'succeeded',
    pricingVersion: entry.pricingVersion || require('./config').PRICING_VERSION,
  };

  if (entry.rawCostMicros !== undefined && entry.rawCostMicros !== null) {
    normalized.rawCostMicros = toSafeNumber(entry.rawCostMicros, 'rawCostMicros');
  }
  if (entry.aiRawCostMicros !== undefined && entry.aiRawCostMicros !== null) {
    normalized.aiRawCostMicros = toSafeNumber(entry.aiRawCostMicros, 'aiRawCostMicros');
  }
  if (entry.infraRawCostMicros !== undefined && entry.infraRawCostMicros !== null) {
    normalized.infraRawCostMicros = toSafeNumber(entry.infraRawCostMicros, 'infraRawCostMicros');
  }
  if (entry.markupBps !== undefined && entry.markupBps !== null) {
    normalized.markupBps = toSafeNumber(entry.markupBps, 'markupBps');
  }
  if (entry.markupMicros !== undefined && entry.markupMicros !== null) {
    normalized.markupMicros = toSafeNumber(entry.markupMicros, 'markupMicros');
  }
  if (entry.chargedMicros !== undefined && entry.chargedMicros !== null) {
    normalized.chargedMicros = toSafeNumber(entry.chargedMicros, 'chargedMicros');
  }

  return normalized;
}

/**
 * Append a ledger entry inside an existing Firestore transaction.
 *
 * Uses deterministic document IDs so retries cannot create duplicate ledger rows.
 */
async function appendLedgerEntry(db, tx, entry) {
  if (!entry.userId) throw new Error('Ledger entry requires userId');
  if (!entry.source) throw new Error('Ledger entry requires source');
  if (!entry.idempotencyKey) throw new Error('Ledger entry requires idempotencyKey');

  const id = entry.id || makeLedgerId(entry.userId, entry.source, entry.idempotencyKey);
  const ref = db.collection('billingLedger').doc(id);
  const existing = await ref.get();
  if (existing.exists) {
    return { created: false, id, existing: existing.data() };
  }

  const normalized = normalizeLedgerEntry(entry);
  await ref.set(normalized);
  return { created: true, id, entry: normalized };
}

module.exports = {
  makeLedgerId,
  normalizeLedgerEntry,
  appendLedgerEntry,
};
