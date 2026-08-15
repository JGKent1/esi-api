'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * ESI API — zero-dependency server
 *
 * Identical routes and identical behaviour to server.js, implemented on Node's
 * built-in http module with NO npm packages at all. Run it with:
 *
 *     node server_local.js
 *
 * Why this exists: `npm install` needs registry access, and a locked-down
 * machine or an air-gapped classroom will not have it. Everything this file
 * replaces — express, cors, express-rate-limit, dotenv — is about 180 lines of
 * plain Node, so the honest move is to write those 180 lines and drop the
 * dependency tree entirely.
 *
 * The scoring engine, the token logic, the store, and both HTML pages are
 * shared with server.js and are not duplicated here. `pg` is required lazily
 * inside store.js, so memory mode needs nothing installed; DATABASE_URL mode
 * still needs `npm install pg`.
 *
 * State machine:  pending_review → released  (or → withheld)
 * There is no automatic path to the student. That is the point.
 * ──────────────────────────────────────────────────────────────────────────── */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const engine = require('./esi_engine');
const tokens = require('./esi_tokens');
const { requireAdmin } = require('./admin_auth');
const { createStore } = require('./store');

/* ── .env (replaces dotenv) ───────────────────────────────────────────────── */
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

const store = createStore();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const nowIso = () => new Date().toISOString();

/* ── tiny router (replaces express) ───────────────────────────────────────── */
const routes = [];
const add = (method, pattern, ...handlers) => {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[A-Za-z_]+/g, (m) => {
    keys.push(m.slice(1)); return '([^/]+)';
  }).replace(/\./g, '\\.') + '$');
  routes.push({ method, rx, keys, handlers });
};
const get = (p, ...h) => add('GET', p, ...h);
const post = (p, ...h) => add('POST', p, ...h);

/* ── rate limiting (replaces express-rate-limit) ──────────────────────────── */
const buckets = new Map();
function limit(max, windowMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    const key = req.path + '|' + req.ip;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) { b = { count: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - b.count)));
    if (b.count > max) {
      return res.json(429, { error: 'too many requests', retry_after_seconds: Math.ceil((b.reset - now) / 1000) });
    }
    next();
  };
}
// Keep the bucket map from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref();

/* ── static (replaces express.static) ─────────────────────────────────────── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const PUBLIC = path.join(__dirname, 'public');
function serveStatic(req, res) {
  // Resolve inside PUBLIC and verify — a request for /../server.js must not escape.
  const decoded = decodeURIComponent(req.path);
  let rel = decoded === '/' ? '/esi_admin.html' : decoded;
  let file = path.join(PUBLIC, rel);
  if (path.relative(PUBLIC, file).startsWith('..')) return false;
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

/* ── request plumbing ─────────────────────────────────────────────────────── */
const MAX_BODY = 256 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('payload too large'), { code: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('invalid JSON'), { code: 400 })); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const origin = process.env.CORS_ORIGIN || req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Actor');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  res.json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  res.status = (code) => ({ json: (o) => res.json(code, o), end: () => { res.writeHead(code); res.end(); } });

  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  req.path = u.pathname;
  req.query = Object.fromEntries(u.searchParams);
  req.ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'local';

  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.rx.exec(req.path);
      if (!m) continue;
      req.params = {};
      r.keys.forEach((k, i) => { req.params[k] = decodeURIComponent(m[i + 1]); });
      if (req.method === 'POST') {
        try { req.body = await readBody(req); }
        catch (e) { return res.json(e.code || 400, { error: e.message }); }
      } else req.body = {};

      // Run the middleware chain.
      let i = 0;
      const next = async () => {
        const h = r.handlers[i++];
        if (!h) return;
        await h(req, res, next);
      };
      await next();
      return;
    }
    if (req.method === 'GET' && serveStatic(req, res)) return;
    res.json(404, { error: 'not found', path: req.path });
  } catch (err) {
    console.error('[esi]', err);
    if (!res.headersSent) res.json(500, { error: 'internal error' });
  }
});

/* ═══════════════════════════ ROUTES ═══════════════════════════════════════ */
/* Behaviour below is a line-for-line mirror of server.js. If you change one,
 * change both — tests/local.test.js asserts they agree on the contract.       */

get('/api/health', async (req, res) => {
  let db = 'unknown';
  try { await store.init(); db = 'ok'; } catch (e) { db = 'error: ' + e.message; }
  res.json(200, { ok: db === 'ok', store: store.kind, db, versions: engine.VERSIONS, server: 'zero-dep' });
});

get('/favicon.ico', (req, res) => { res.writeHead(204); res.end(); });

// The instrument, minus every scoring vector. Coding vectors are Core IP and
// must never reach the browser: strip them here, not in the client.
get('/api/esi/instrument', limit(120), (req, res) => {
  const ITEMS = require('./esi_engine_data/esi_items_v1_0.json');
  res.json(200, {
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

get('/api/esi/token', limit(60), async (req, res) => {
  const r = await tokens.inspectToken(store, req.query.t, nowIso());
  if (!r.ok) return res.json(410, { ok: false, reason: r.reason });
  res.json(200, {
    ok: true, student_ref: r.token.student_ref, full_name: r.token.full_name,
    cohort: r.token.cohort, window: r.token.window,
  });
});

post('/api/esi/submit', limit(20), async (req, res) => {
  const { t, responses } = req.body || {};
  // Validate BEFORE consuming the token. A malformed payload must not cost a
  // student their single-use link.
  const v = engine.validateResponses(responses);
  if (!v.ok) return res.json(400, { error: 'invalid responses', details: v.errors });

  const look = await tokens.inspectToken(store, t, nowIso());
  if (!look.ok) return res.json(410, { error: 'token not usable', reason: look.reason });

  const profile = engine.scoreSubmission(responses);
  const tk = look.token;
  const report_text = engine.renderBrief(profile, {
    full_name: tk.full_name, cohort: tk.cohort, window: tk.window,
  });

  const sub = await store.createSubmission({
    student_ref: tk.student_ref, full_name: tk.full_name, email: tk.email,
    cohort: tk.cohort, window: tk.window, status: 'pending_review',
    responses, profile, report_text, versions: engine.VERSIONS, created_at: nowIso(),
  });

  const consumed = await tokens.consumeToken(store, t, sub.id, nowIso());
  if (!consumed) {
    await store.updateSubmission(sub.id, { status: 'void' });
    return res.json(409, { error: 'token already used' });
  }

  await store.addAudit({
    submission_id: sub.id, actor: 'student', action: 'submitted',
    detail: `window=${tk.window}`, created_at: nowIso(),
  });

  // The student gets the depth prompts and a confirmation. They do NOT get the
  // Brief — an instructor releases that.
  res.json(201, {
    ok: true, submission_id: sub.id, status: 'pending_review',
    depth_prompts: engine.selectDepthPrompts(profile),
    message: 'Submitted. Your instructor reviews and releases your Brief.',
  });
});

post('/api/esi/depth', limit(30), async (req, res) => {
  const { submission_id, prompt_id, body } = req.body || {};
  if (!submission_id || !prompt_id || !body) {
    return res.json(400, { error: 'submission_id, prompt_id and body are required' });
  }
  const sub = await store.getSubmission(submission_id);
  if (!sub) return res.json(404, { error: 'unknown submission' });
  const prof = typeof sub.profile === 'string' ? JSON.parse(sub.profile) : sub.profile;
  if (!prof.depth_prompt_ids.includes(prompt_id)) {
    return res.json(400, { error: 'prompt not offered for this profile' });
  }
  await store.addDepthResponse({
    submission_id, prompt_id, body: String(body).slice(0, 20000), created_at: nowIso(),
  });
  res.json(201, { ok: true, note: 'Stored. Depth responses are interpretive only and never affect a score.' });
});

/* ── admin ────────────────────────────────────────────────────────────────── */
const A = '/api/admin/esi';
const parse = (x) => (typeof x === 'string' ? JSON.parse(x) : x);

get(A + '/whoami', requireAdmin, (req, res) =>
  res.json(200, { ok: true, actor: req.admin.actor, store: store.kind }));

post(A + '/tokens', requireAdmin, async (req, res) => {
  const { roster, cohort, window = 'day0', days = 30 } = req.body || {};
  if (!Array.isArray(roster) || !roster.length) return res.json(400, { error: 'roster array required' });
  if (!cohort) return res.json(400, { error: 'cohort required' });
  try {
    const minted = await tokens.issueBatch(store, roster, {
      cohort, window, days, created_by: req.admin.actor, now: nowIso(),
    });
    res.json(201, {
      ok: true, count: minted.length,
      tokens: minted.map((m) => ({ ...m, url: tokens.assessmentUrl(APP_URL, m.token) })),
      warning: 'These raw links are shown once. Distribute them now; they cannot be recovered.',
    });
  } catch (e) { res.json(400, { error: e.message }); }
});

get(A + '/tokens', requireAdmin, async (req, res) => {
  const rows = await store.listTokens({ cohort: req.query.cohort });
  res.json(200, rows.map(({ token_hash, ...r }) => r));   // never echo the hash
});

get(A + '/submissions', requireAdmin, async (req, res) => {
  const rows = await store.listSubmissions({
    status: req.query.status, cohort: req.query.cohort, window: req.query.window,
  });
  res.json(200, rows.map((r) => {
    const p = parse(r.profile);
    return {
      id: r.id, student_ref: r.student_ref, full_name: r.full_name, cohort: r.cohort,
      window: r.window, status: r.status, created_at: r.created_at,
      composite: p.composite, band: p.band.name, pressure_overall: p.pressure.overall,
      signature_pair: p.signature_pair,
    };
  }));
});

get(A + '/submissions/:id', requireAdmin, async (req, res) => {
  const r = await store.getSubmission(req.params.id);
  if (!r) return res.json(404, { error: 'not found' });
  res.json(200, {
    ...r,
    responses: parse(r.responses), profile: parse(r.profile), versions: parse(r.versions),
    depth: await store.listDepthResponses(r.id),
    audit: await store.listAudit(r.id),
  });
});

post(A + '/submissions/:id/release', requireAdmin, async (req, res) => {
  const r = await store.getSubmission(req.params.id);
  if (!r) return res.json(404, { error: 'not found' });
  if (r.status === 'released') return res.json(409, { error: 'already released' });
  // Capture the original before writing — on a store that returns live object
  // references this comparison would otherwise be against the value just set.
  const original = r.report_text;
  const text = typeof req.body?.report_text === 'string' && req.body.report_text.trim()
    ? req.body.report_text : original;
  const edited = text !== original;
  const updated = await store.updateSubmission(r.id, {
    status: 'released', report_text: text, released_at: nowIso(), released_by: req.admin.actor,
  });
  await store.addAudit({
    submission_id: r.id, actor: req.admin.actor, action: 'released',
    detail: edited ? 'edited before release' : 'unedited', created_at: nowIso(),
  });
  res.json(200, { ok: true, status: updated.status, released_at: updated.released_at });
});

post(A + '/submissions/:id/withhold', requireAdmin, async (req, res) => {
  const r = await store.getSubmission(req.params.id);
  if (!r) return res.json(404, { error: 'not found' });
  const updated = await store.updateSubmission(r.id, { status: 'withheld' });
  await store.addAudit({
    submission_id: r.id, actor: req.admin.actor, action: 'withheld',
    detail: String(req.body?.reason || '').slice(0, 500), created_at: nowIso(),
  });
  res.json(200, { ok: true, status: updated.status });
});

get(A + '/cohort/:cohort', requireAdmin, async (req, res) => {
  const rows = await store.listSubmissions({ cohort: req.params.cohort });
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
  res.json(200, {
    cohort: req.params.cohort, n: students.length, n_paired: paired.length,
    mean_pressure_delta_change: paired.length
      ? engine.round(paired.reduce((a, s) => a + s.pressure_delta_change, 0) / paired.length, 1) : null,
    note: 'A negative pressure_delta_change is the good outcome: the gap between composed and compressed judgment got smaller.',
    students,
  });
});

get(A + '/export/:cohort.csv', requireAdmin, async (req, res) => {
  const rows = await store.listSubmissions({ cohort: req.params.cohort });
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
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="esi_${req.params.cohort}.csv"`,
  });
  res.end(lines.join('\n'));
});

/* ── boot ─────────────────────────────────────────────────────────────────── */
async function start(port = PORT) {
  await store.init();
  return new Promise((resolve) => {
    server.listen(port, HOST, () => {
      const p = server.address().port;
      console.log('');
      console.log('  ESI API — zero-dependency server');
      console.log(`  ${engine.VERSIONS.engine} · store=${store.kind}`);
      console.log('');
      console.log(`  Console:  http://localhost:${p}/esi_admin.html`);
      console.log(`  Health:   http://localhost:${p}/api/health`);
      if (!process.env.ADMIN_API_KEY) {
        console.log('');
        console.log('  ! ADMIN_API_KEY is not set — admin routes will return 503.');
        console.log('    Try:  ADMIN_API_KEY=dev-admin-key node server_local.js');
      }
      console.log('');
      resolve(server);
    });
  });
}

if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });

module.exports = { server, store, start };
