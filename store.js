'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * Storage layer. Two implementations behind one interface.
 *
 *   ESI_STORE=postgres  (default when DATABASE_URL is set) — production.
 *                        Works against Supabase, Railway Postgres, or any
 *                        Postgres 14+. Connect with the pooled connection string.
 *   ESI_STORE=memory    — no database. Used by the contract tests and by
 *                        `npm run demo`. Data is lost on restart, by design.
 *
 * Every method is async in both implementations so the server never has to know
 * which one it is talking to.
 * ──────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const newId = () => crypto.randomUUID();

/* ── memory ───────────────────────────────────────────────────────────────── */
function memoryStore() {
  const tokens = new Map();       // token_hash -> row
  const submissions = new Map();  // id -> row
  const depth = [];
  const audit = [];

  // Postgres hands back a fresh row on every read. The memory store must do the
  // same or it will quietly pass tests that production would fail: a caller
  // holding a live reference sees its own writes before it makes them.
  const copy = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const copyAll = (a) => a.map(copy);

  return {
    kind: 'memory',
    async init() {},
    async close() {},

    async createToken(row) {
      const r = { id: newId(), used_at: null, submission_id: null, ...row };
      tokens.set(r.token_hash, r);
      return copy(r);
    },
    async findToken(hash) { return copy(tokens.get(hash)) || null; },
    async consumeToken(hash, submissionId, nowIso) {
      const t = tokens.get(hash);
      if (!t || t.used_at) return null;
      t.used_at = nowIso; t.submission_id = submissionId;
      return copy(t);
    },
    async releaseToken(hash) {
      const t = tokens.get(hash);
      if (t) { t.used_at = null; t.submission_id = null; }
    },
    async listTokens({ cohort } = {}) {
      return copyAll([...tokens.values()]
        .filter((t) => !cohort || t.cohort === cohort)
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))));
    },

    async createSubmission(row) {
      const r = { id: newId(), ...row };
      submissions.set(r.id, r);
      return copy(r);
    },
    async getSubmission(id) { return copy(submissions.get(id)) || null; },
    async updateSubmission(id, patch) {
      const s = submissions.get(id);
      if (!s) return null;
      Object.assign(s, patch);
      return copy(s);
    },
    async listSubmissions({ status, cohort, window } = {}) {
      return copyAll([...submissions.values()]
        .filter((s) => (!status || s.status === status)
                    && (!cohort || s.cohort === cohort)
                    && (!window || s.window === window))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
    },

    async addDepthResponse(row) { const r = { id: newId(), ...row }; depth.push(r); return copy(r); },
    async listDepthResponses(submissionId) { return copyAll(depth.filter((d) => d.submission_id === submissionId)); },

    async addAudit(row) { audit.push({ id: newId(), ...row }); },
    async listAudit(submissionId) { return copyAll(audit.filter((a) => a.submission_id === submissionId)); },
  };
}

/* ── postgres ─────────────────────────────────────────────────────────────── */
function postgresStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 10),
  });
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
  const many = async (sql, params) => (await pool.query(sql, params)).rows;

  return {
    kind: 'postgres',
    async init() { await pool.query('select 1'); },
    async close() { await pool.end(); },

    createToken: (r) => one(
      `insert into esi_access_tokens
         (token_hash, student_ref, full_name, email, cohort, "window", expires_at, created_at, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
      [r.token_hash, r.student_ref, r.full_name, r.email, r.cohort, r.window, r.expires_at, r.created_at, r.created_by]),

    findToken: (h) => one(`select * from esi_access_tokens where token_hash=$1`, [h]),

    // Atomic single-use consume. The where-clause is the lock: two concurrent
    // submits with the same token cannot both win.
    consumeToken: (h, sid, now) => one(
      `update esi_access_tokens set used_at=$2, submission_id=$3
        where token_hash=$1 and used_at is null returning *`, [h, now, sid]),

    releaseToken: (h) => pool.query(
      `update esi_access_tokens set used_at=null, submission_id=null where token_hash=$1`, [h]),

    listTokens: ({ cohort } = {}) => many(
      `select * from esi_access_tokens where ($1::text is null or cohort=$1) order by created_at`, [cohort || null]),

    createSubmission: (r) => one(
      `insert into esi_submissions
         (student_ref, full_name, email, cohort, "window", status, responses, profile, report_text, versions, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [r.student_ref, r.full_name, r.email, r.cohort, r.window, r.status,
       JSON.stringify(r.responses), JSON.stringify(r.profile), r.report_text,
       JSON.stringify(r.versions), r.created_at]),

    getSubmission: (id) => one(`select * from esi_submissions where id=$1`, [id]),

    async updateSubmission(id, patch) {
      const cols = [], vals = [];
      for (const [k, v] of Object.entries(patch)) {
        cols.push(`${k}=$${cols.length + 2}`);
        vals.push(['profile', 'responses', 'versions'].includes(k) ? JSON.stringify(v) : v);
      }
      if (!cols.length) return this.getSubmission(id);
      return one(`update esi_submissions set ${cols.join(', ')} where id=$1 returning *`, [id, ...vals]);
    },

    listSubmissions: ({ status, cohort, window } = {}) => many(
      `select * from esi_submissions
        where ($1::text is null or status=$1)
          and ($2::text is null or cohort=$2)
          and ($3::text is null or "window"=$3)
        order by created_at desc`, [status || null, cohort || null, window || null]),

    addDepthResponse: (r) => one(
      `insert into esi_depth_responses (submission_id, prompt_id, body, created_at)
       values ($1,$2,$3,$4) returning *`, [r.submission_id, r.prompt_id, r.body, r.created_at]),

    listDepthResponses: (sid) => many(
      `select * from esi_depth_responses where submission_id=$1 order by created_at`, [sid]),

    addAudit: (r) => pool.query(
      `insert into esi_audit (submission_id, actor, action, detail, created_at)
       values ($1,$2,$3,$4,$5)`, [r.submission_id, r.actor, r.action, r.detail, r.created_at]),

    listAudit: (sid) => many(
      `select * from esi_audit where submission_id=$1 order by created_at`, [sid]),
  };
}

function createStore() {
  const mode = (process.env.ESI_STORE || (process.env.DATABASE_URL ? 'postgres' : 'memory')).toLowerCase();
  if (mode === 'memory') return memoryStore();
  if (!process.env.DATABASE_URL) throw new Error('ESI_STORE=postgres requires DATABASE_URL');
  return postgresStore(process.env.DATABASE_URL);
}

module.exports = { createStore, memoryStore, postgresStore };
