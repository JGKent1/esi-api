'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * ESI API — Exceed Student Index
 *
 * Serves the student assessment, scores it deterministically, holds every Brief
 * at pending_review until an instructor releases it, and exposes an admin
 * console for the review queue and the cohort view.
 *
 * State machine:  pending_review → released     (or → withheld)
 * There is no automatic path to the student. That is the point.
 * ──────────────────────────────────────────────────────────────────────────── */

require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const engine = require('./esi_engine');
const tokens = require('./esi_tokens');
const { requireAdmin } = require('./admin_auth');
const { renderBriefPdf } = require('./esi_pdf');
const { createStore } = require('./store');

const app = express();
const store = createStore();
const PORT = Number(process.env.PORT || 3000);
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const nowIso = () => new Date().toISOString();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));

const limit = (max, windowMs = 15 * 60 * 1000) =>
  rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });

/* ── public ───────────────────────────────────────────────────────────────── */

app.get('/api/health', async (_req, res) => {
  let db = 'unknown';
  try { await store.init(); db = 'ok'; } catch (e) { db = 'error: ' + e.message; }
  res.json({ ok: db === 'ok', store: store.kind, db, versions: engine.VERSIONS });
});

// The instrument itself, minus every scoring vector. The coding vectors are
// Core IP and must never reach the browser: strip them here, not in the client.
app.get('/api/esi/instrument', limit(Number(process.env.RATE_INSTRUMENT || 120)), (_req, res) => {
  const ITEMS = require('./esi_engine_data/esi_items_v1_0.json');
  res.json({
    instrument: ITEMS.instrument,
    versions: engine.VERSIONS,
    sjs: ITEMS.sjs.map((it) => ({
      id: it.id,
      condition: it.condition || null,
      context: it.context,
      options: Object.fromEntries(Object.entries(it.options).map(([k, v]) => [k, v.text])),
    })),
    behavioral: ITEMS.behavioral.map((b) => ({ id: b.id, text: b.text })),
  });
});

// Does this link still work? Called before rendering the instrument so a spent
// or expired token produces a clear message rather than a wasted 24 minutes.
app.get('/api/esi/token', limit(Number(process.env.RATE_TOKEN || 60)), async (req, res) => {
  const r = await tokens.inspectToken(store, req.query.t, nowIso());
  if (!r.ok) return res.status(410).json({ ok: false, reason: r.reason });
  res.json({
    ok: true,
    student_ref: r.token.student_ref,
    full_name: r.token.full_name,
    cohort: r.token.cohort,
    window: r.token.window,
  });
});

app.post('/api/esi/submit', limit(Number(process.env.RATE_SUBMIT || 20)), async (req, res) => {
  const { t, responses } = req.body || {};
  try {
    // Validate BEFORE consuming the token. A malformed payload must not cost a
    // student their single-use link.
    const v = engine.validateResponses(responses);
    if (!v.ok) return res.status(400).json({ error: 'invalid responses', details: v.errors });

    const look = await tokens.inspectToken(store, t, nowIso());
    if (!look.ok) return res.status(410).json({ error: 'token not usable', reason: look.reason });

    const profile = engine.scoreSubmission(responses);
    const tk = look.token;
    const report_text = engine.renderBrief(profile, {
      full_name: tk.full_name, cohort: tk.cohort, window: tk.window,
    });

    const sub = await store.createSubmission({
      student_ref: tk.student_ref,
      full_name: tk.full_name,
      email: tk.email,
      cohort: tk.cohort,
      window: tk.window,
      status: 'pending_review',
      responses, profile, report_text,
      versions: engine.VERSIONS,
      created_at: nowIso(),
    });

    const consumed = await tokens.consumeToken(store, t, sub.id, nowIso());
    if (!consumed) {
      // Lost the race — another submit spent the token first. Void this row.
      await store.updateSubmission(sub.id, { status: 'void' });
      return res.status(409).json({ error: 'token already used' });
    }

    await store.addAudit({
      submission_id: sub.id, actor: 'student', action: 'submitted',
      detail: `window=${tk.window}`, created_at: nowIso(),
    });

    // The student gets the depth prompts and confirmation. They do NOT get the
    // Brief — an instructor releases that.
    res.status(201).json({
      ok: true,
      submission_id: sub.id,
      status: 'pending_review',
      depth_prompts: engine.selectDepthPrompts(profile),
      message: 'Submitted. Your instructor reviews and releases your Brief.',
    });
  } catch (err) {
    console.error('[submit]', err);
    res.status(500).json({ error: 'submit failed' });
  }
});

// Depth responses: optional, interpretive only, never score-bearing.
app.post('/api/esi/depth', limit(Number(process.env.RATE_DEPTH || 30)), async (req, res) => {
  const { submission_id, prompt_id, body } = req.body || {};
  if (!submission_id || !prompt_id || !body) {
    return res.status(400).json({ error: 'submission_id, prompt_id and body are required' });
  }
  const sub = await store.getSubmission(submission_id);
  if (!sub) return res.status(404).json({ error: 'unknown submission' });
  const allowed = (typeof sub.profile === 'string' ? JSON.parse(sub.profile) : sub.profile).depth_prompt_ids;
  if (!allowed.includes(prompt_id)) return res.status(400).json({ error: 'prompt not offered for this profile' });
  await store.addDepthResponse({
    submission_id, prompt_id, body: String(body).slice(0, 20000), created_at: nowIso(),
  });
  res.status(201).json({ ok: true, note: 'Stored. Depth responses are interpretive only and never affect a score.' });
});

/* ── admin ────────────────────────────────────────────────────────────────── */

const admin = express.Router();
admin.use(requireAdmin);

admin.get('/whoami', (req, res) => res.json({ ok: true, actor: req.admin.actor, store: store.kind }));

admin.post('/tokens', async (req, res) => {
  const { roster, cohort, window = 'day0', days = 30 } = req.body || {};
  if (!Array.isArray(roster) || !roster.length) return res.status(400).json({ error: 'roster array required' });
  if (!cohort) return res.status(400).json({ error: 'cohort required' });
  try {
    const minted = await tokens.issueBatch(store, roster, {
      cohort, window, days, created_by: req.admin.actor, now: nowIso(),
    });
    res.status(201).json({
      ok: true, count: minted.length,
      tokens: minted.map((m) => ({ ...m, url: tokens.assessmentUrl(APP_URL, m.token) })),
      warning: 'These raw links are shown once. Distribute them now; they cannot be recovered.',
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

admin.get('/tokens', async (req, res) => {
  const rows = await store.listTokens({ cohort: req.query.cohort });
  res.json(rows.map(({ token_hash, ...r }) => r));   // never echo the hash
});

admin.get('/submissions', async (req, res) => {
  const rows = await store.listSubmissions({
    status: req.query.status, cohort: req.query.cohort, window: req.query.window,
  });
  res.json(rows.map((r) => {
    const p = typeof r.profile === 'string' ? JSON.parse(r.profile) : r.profile;
    return {
      id: r.id, student_ref: r.student_ref, full_name: r.full_name, cohort: r.cohort,
      window: r.window, status: r.status, created_at: r.created_at,
      composite: p.composite, band: p.band.name, pressure_overall: p.pressure.overall,
      signature_pair: p.signature_pair,
    };
  }));
});

// Printable Brief. Draft PDFs carry a NOT RELEASED watermark on every page,
// so a printed draft can never be mistaken for a released educational record.
admin.get('/submissions/:id/brief.pdf', async (req, res) => {
  const r = await store.getSubmission(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const parse = (x) => (typeof x === 'string' ? JSON.parse(x) : x);
  const safe = String(r.student_ref || 'brief').replace(/[^A-Za-z0-9_-]+/g, '_');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="ESI_Brief_${safe}_${r.window}${r.status === 'released' ? '' : '_DRAFT'}.pdf"`);
  renderBriefPdf({ ...r, versions: parse(r.versions) }, res);
});

admin.get('/submissions/:id', async (req, res) => {
  const r = await store.getSubmission(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const parse = (x) => (typeof x === 'string' ? JSON.parse(x) : x);
  res.json({
    ...r,
    responses: parse(r.responses),
    profile: parse(r.profile),
    versions: parse(r.versions),
    depth: await store.listDepthResponses(r.id),
    audit: await store.listAudit(r.id),
  });
});

// The release gate (D-18). Nothing reaches a student without passing here.
admin.post('/submissions/:id/release', async (req, res) => {
  const r = await store.getSubmission(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  if (r.status === 'released') return res.status(409).json({ error: 'already released' });
  // Capture the original before writing. On a store that returns live object
  // references this comparison would otherwise be against the value we just set.
  const original = r.report_text;
  const text = typeof req.body?.report_text === 'string' && req.body.report_text.trim()
    ? req.body.report_text : original;
  const edited = text !== original;
  const updated = await store.updateSubmission(r.id, {
    status: 'released', report_text: text, released_at: nowIso(),
    released_by: req.admin.actor,
  });
  await store.addAudit({
    submission_id: r.id, actor: req.admin.actor, action: 'released',
    detail: edited ? 'edited before release' : 'unedited', created_at: nowIso(),
  });
  res.json({ ok: true, status: updated.status, released_at: updated.released_at });
});

admin.post('/submissions/:id/withhold', async (req, res) => {
  const r = await store.getSubmission(req.params.id);
  if (!r) return res.status(404).json({ error: 'not found' });
  const updated = await store.updateSubmission(r.id, { status: 'withheld' });
  await store.addAudit({
    submission_id: r.id, actor: req.admin.actor, action: 'withheld',
    detail: String(req.body?.reason || '').slice(0, 500), created_at: nowIso(),
  });
  res.json({ ok: true, status: updated.status });
});

// Cohort view: Day 0 vs Week 15, and the number the term is actually about.
admin.get('/cohort/:cohort', async (req, res) => {
  const rows = await store.listSubmissions({ cohort: req.params.cohort });
  const parse = (x) => (typeof x === 'string' ? JSON.parse(x) : x);
  const byStudent = {};
  for (const r of rows) {
    const p = parse(r.profile);
    (byStudent[r.student_ref] ||= { student_ref: r.student_ref, full_name: r.full_name })[r.window] = {
      submission_id: r.id, status: r.status, composite: p.composite,
      band: p.band.name, pressure_overall: p.pressure.overall, domains: p.domains,
    };
  }
  const students = Object.values(byStudent).map((s) => {
    const d = s.day0, w = s.wk15;
    return {
      ...s,
      composite_change: d && w ? engine.round(w.composite - d.composite, 1) : null,
      pressure_delta_change: d && w ? engine.round(w.pressure_overall - d.pressure_overall, 1) : null,
    };
  }).sort((a, b) => String(a.student_ref).localeCompare(String(b.student_ref)));
  const paired = students.filter((s) => s.pressure_delta_change !== null);
  res.json({
    cohort: req.params.cohort,
    n: students.length,
    n_paired: paired.length,
    mean_pressure_delta_change: paired.length
      ? engine.round(paired.reduce((a, s) => a + s.pressure_delta_change, 0) / paired.length, 1) : null,
    note: 'A negative pressure_delta_change is the good outcome: the gap between composed and compressed judgment got smaller.',
    students,
  });
});

admin.get('/export/:cohort.csv', async (req, res) => {
  const rows = await store.listSubmissions({ cohort: req.params.cohort });
  const parse = (x) => (typeof x === 'string' ? JSON.parse(x) : x);
  const head = ['student_ref', 'full_name', 'window', 'status', 'created_at', 'composite', 'band',
                'LS', 'LT', 'LC', 'LP', 'LF', 'pressure_overall', 'signature_pair'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.join(',')];
  for (const r of rows) {
    const p = parse(r.profile);
    lines.push([r.student_ref, r.full_name, r.window, r.status, r.created_at, p.composite, p.band.name,
      p.domains.LS, p.domains.LT, p.domains.LC, p.domains.LP, p.domains.LF,
      p.pressure.overall, p.signature_pair].map(esc).join(','));
  }
  res.type('text/csv').attachment(`esi_${req.params.cohort}.csv`).send(lines.join('\n'));
});

app.use('/api/admin/esi', admin);

/* ── static ───────────────────────────────────────────────────────────────── */
app.get('/favicon.ico', (_req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/', (_req, res) => res.redirect('/esi_admin.html'));

app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

/* ── boot ─────────────────────────────────────────────────────────────────── */
async function start() {
  await store.init();
  return app.listen(PORT, () => {
    console.log(`ESI API on :${PORT}  store=${store.kind}  ${engine.VERSIONS.engine}`);
    if (!process.env.ADMIN_API_KEY) console.warn('  ! ADMIN_API_KEY is not set — admin routes will return 503');
  });
}

if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });

module.exports = { app, store, start };
