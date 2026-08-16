'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * Postgres integration test. Runs ONLY when DATABASE_URL is set (CI provides a
 * throwaway service container; locally: export DATABASE_URL and run
 * `node --test tests/pg.test.js`).
 *
 * Exists because of the 14 Aug 2026 deployment: `window` is a reserved word in
 * Postgres, the migration and three store.js statements used it unquoted, and
 * the in-memory store used by every other test never noticed. This file makes
 * the real database part of every CI run so that class of bug cannot ship.
 * ──────────────────────────────────────────────────────────────────────────── */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

let store;
const now = () => new Date().toISOString();

before(async () => {
  if (skip) return;
  process.env.ESI_STORE = 'postgres';
  const { createStore } = require('../store.js');
  store = createStore();
  await store.init();
});

after(async () => {
  if (store) {
    // Clean up everything this suite created, then close the pool.
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: DATABASE_URL,
      ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
    await pool.query(`delete from esi_submissions where cohort = 'PGTEST'`);
    await pool.query(`delete from esi_access_tokens where cohort = 'PGTEST'`);
    await pool.end();
    await store.close();
  }
});

test('migration applied: all four esi_ tables exist with RLS enabled', { skip }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false } });
  const r = await pool.query(
    `select relname, relrowsecurity from pg_class
      where relname in ('esi_access_tokens','esi_submissions','esi_depth_responses','esi_audit')`);
  await pool.end();
  assert.strictEqual(r.rows.length, 4, 'expected all four esi_ tables');
  for (const row of r.rows) assert.ok(row.relrowsecurity, `${row.relname} must have RLS enabled`);
});

test('token lifecycle survives real Postgres (quoted "window" column)', { skip }, async () => {
  const hash = 'pgtest-' + Math.random().toString(36).slice(2);
  const created = await store.createToken({
    token_hash: hash, student_ref: 'PG-1', full_name: 'PG Test', email: null,
    cohort: 'PGTEST', window: 'day0', expires_at: null, created_at: now(), created_by: 'ci',
  });
  assert.strictEqual(created.window, 'day0');

  const found = await store.findToken(hash);
  assert.strictEqual(found.student_ref, 'PG-1');
  assert.strictEqual(found.used_at, null);

  // window CHECK constraint is live
  await assert.rejects(() => store.createToken({
    token_hash: hash + '-bad', student_ref: 'PG-2', full_name: null, email: null,
    cohort: 'PGTEST', window: 'not-a-window', expires_at: null, created_at: now(), created_by: 'ci',
  }), /check|constraint/i);

  // one-live-token-per-window unique index is live
  await assert.rejects(() => store.createToken({
    token_hash: hash + '-dup', student_ref: 'PG-1', full_name: null, email: null,
    cohort: 'PGTEST', window: 'day0', expires_at: null, created_at: now(), created_by: 'ci',
  }), /duplicate|unique/i);
});

test('submission round-trip: insert, filter by "window", generated columns, atomic consume', { skip }, async () => {
  const sub = await store.createSubmission({
    student_ref: 'PG-1', full_name: 'PG Test', email: null, cohort: 'PGTEST',
    window: 'day0', status: 'pending_review',
    responses: { S01: 'A' }, profile: { composite: 61.5, pressure: { overall: -4 } },
    report_text: 'integration draft', versions: { engine: 'ci' }, created_at: now(),
  });
  assert.ok(sub.id);

  // generated columns parsed the jsonb
  assert.strictEqual(Number(sub.composite), 61.5);
  assert.strictEqual(Number(sub.pressure_overall), -4);

  // the listSubmissions "window" filter — the exact statement that failed unquoted
  const listed = await store.listSubmissions({ cohort: 'PGTEST', window: 'day0' });
  assert.ok(listed.some((s) => s.id === sub.id));
  const none = await store.listSubmissions({ cohort: 'PGTEST', window: 'wk15' });
  assert.strictEqual(none.length, 0);

  // atomic single-use consume: exactly one of two concurrent consumers wins
  const hash = 'pgtest-race-' + Math.random().toString(36).slice(2);
  await store.createToken({
    token_hash: hash, student_ref: 'PG-RACE', full_name: null, email: null,
    cohort: 'PGTEST', window: 'day0', expires_at: null, created_at: now(), created_by: 'ci',
  });
  const [a, b] = await Promise.all([
    store.consumeToken(hash, sub.id, now()),
    store.consumeToken(hash, sub.id, now()),
  ]);
  assert.ok((a === null) !== (b === null), 'exactly one concurrent consume must win');

  // release → audit trail
  const rel = await store.updateSubmission(sub.id, { status: 'released', released_at: now(), released_by: 'ci' });
  assert.strictEqual(rel.status, 'released');
  await store.addAudit({ submission_id: sub.id, actor: 'ci', action: 'released', detail: null, created_at: now() });
  const audit = await store.listAudit(sub.id);
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].action, 'released');
});
