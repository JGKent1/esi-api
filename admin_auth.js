'use strict';
/* Bearer-key admin auth. Ported from the EEI service, including the trimming
 * fix: a secret pasted into a hosting dashboard routinely carries a trailing
 * newline, and trimming only the supplied header made the lengths differ, so
 * the constant-time compare short-circuited and every request returned 401 —
 * indistinguishable from a genuinely wrong key. Trim both sides. */

const crypto = require('crypto');

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res, next) {
  const expected = String(process.env.ADMIN_API_KEY || '').trim();
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!expected) return res.status(503).json({ error: 'ESI administration is not configured' });
  if (!constantTimeEqual(supplied, expected)) return res.status(401).json({ error: 'Unauthorized' });
  req.admin = { actor: String(req.headers['x-admin-actor'] || 'admin').slice(0, 120) };
  next();
}

module.exports = { constantTimeEqual, requireAdmin };
