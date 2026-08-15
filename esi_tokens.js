'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * ESI Access Tokens — single-use, roster-granted access to /api/esi/submit.
 *
 * Ported from eei_tokens.js. Two things change for the student context:
 *   1. Tokens are minted in BULK from a roster, not one per purchase.
 *   2. Every token carries a `window` — 'day0' or 'wk15'. A student takes the
 *      instrument twice a term and each administration needs its own token, so
 *      that a Day 0 link cannot be replayed in Week 15.
 *
 * The raw token exists only in the URL you hand the student. The database
 * stores sha256(raw) and nothing else, so a leaked database does not hand
 * anyone an assessment link.
 * ──────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const ASSESSMENT_PAGE = 'esi_assessment.html';
const WINDOWS = Object.freeze(['day0', 'wk15']);

const assessmentUrl = (appUrl, rawToken) =>
  `${String(appUrl || '').replace(/\/$/, '')}/${ASSESSMENT_PAGE}?t=${encodeURIComponent(rawToken)}`;

/**
 * Mint one single-use token. Returns the RAW token — this is the only moment
 * it is readable. Store nothing but the hash.
 */
async function issueToken(store, {
  student_ref, full_name = null, email = null, cohort, window = 'day0',
  days = 30, created_by = 'admin', now = new Date().toISOString(),
}) {
  if (!student_ref) throw new Error('issueToken: student_ref is required');
  if (!cohort) throw new Error('issueToken: cohort is required');
  if (!WINDOWS.includes(window)) throw new Error(`issueToken: window must be one of ${WINDOWS.join(', ')}`);

  const raw = crypto.randomBytes(32).toString('base64url');  // ~43 chars, URL-safe
  const row = await store.createToken({
    token_hash: sha256(raw),
    student_ref: String(student_ref).trim(),
    full_name,
    email: email ? String(email).toLowerCase().trim() : null,
    cohort: String(cohort).trim(),
    window,
    expires_at: days ? new Date(Date.parse(now) + days * 864e5).toISOString() : null,
    created_at: now,
    created_by,
  });
  return { id: row.id, token: raw, student_ref: row.student_ref, window: row.window };
}

/** Bulk-mint from a roster. One token per row. Deterministic ordering. */
async function issueBatch(store, roster, opts = {}) {
  const out = [];
  for (const r of roster) {
    out.push(await issueToken(store, { ...opts, ...r }));
  }
  return out;
}

/**
 * Look up a raw token without consuming it. Used by the assessment page to
 * decide whether to render the instrument at all.
 */
async function inspectToken(store, rawToken, now = new Date().toISOString()) {
  if (!rawToken) return { ok: false, reason: 'missing' };
  const row = await store.findToken(sha256(rawToken));
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (row.expires_at && Date.parse(row.expires_at) < Date.parse(now)) return { ok: false, reason: 'expired' };
  return { ok: true, token: row };
}

/**
 * Consume atomically. Returns null if the token was already spent — which is
 * what makes a double-submit safe rather than a race.
 */
async function consumeToken(store, rawToken, submissionId, now = new Date().toISOString()) {
  return store.consumeToken(sha256(rawToken), submissionId, now);
}

/** Roll a consumed token back — used only when submission storage fails after consume. */
async function releaseToken(store, rawToken) {
  return store.releaseToken(sha256(rawToken));
}

module.exports = {
  sha256, ASSESSMENT_PAGE, WINDOWS, assessmentUrl,
  issueToken, issueBatch, inspectToken, consumeToken, releaseToken,
};
