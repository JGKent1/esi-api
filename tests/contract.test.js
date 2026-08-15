'use strict';
/* End-to-end API contract tests. Run against the in-memory store, so they need
 * no database and no network. Booting the real Express app means the routes,
 * the auth, the token lifecycle and the release gate are all genuinely exercised. */

process.env.ESI_STORE = 'memory';
process.env.ADMIN_API_KEY = 'test-admin-key';
process.env.PORT = '0';

const test = require('node:test');
const assert = require('node:assert');
const { app, store } = require('../server');
const ITEMS = require('../esi_engine_data/esi_items_v1_0.json');

let server, base;
const AUTH = { Authorization: 'Bearer test-admin-key', 'Content-Type': 'application/json', 'X-Admin-Actor': 'Tester' };

test.before(async () => {
  await store.init();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const j = async (path, opts = {}) => {
  const r = await fetch(base + path, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: r.status, body };
};

const LETTERS = ['A', 'B', 'C', 'D'];
function answers(offset = 0) {
  const r = {};
  ITEMS.sjs.forEach((it, i) => { r[it.id] = LETTERS[(i + offset) % 4]; });
  ITEMS.behavioral.forEach((b, i) => { r[b.id] = ((i + offset) % 5) + 1; });
  return r;
}
async function mint(overrides = {}) {
  const res = await j('/api/admin/esi/tokens', {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({
      cohort: 'TEST-1', window: 'day0', days: 30,
      roster: [{ student_ref: 's' + Math.random().toString(36).slice(2, 8), full_name: 'A. Student' }],
      ...overrides,
    }),
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body.tokens[0];
}

test('health reports the store and the engine versions', async () => {
  const r = await j('/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.store, 'memory');
  assert.ok(r.body.versions.engine);
});

test('the public instrument endpoint never leaks scoring vectors', async () => {
  const r = await j('/api/esi/instrument');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.sjs.length, 22);
  assert.strictEqual(r.body.behavioral.length, 16);
  const blob = JSON.stringify(r.body);
  assert.ok(!blob.includes('facets'), 'facet vectors must not reach the browser');
  assert.ok(!blob.includes('tendencies'), 'tendency vectors must not reach the browser');
  assert.ok(!/"reverse"/.test(blob), 'reverse-scoring flags must not reach the browser');
  for (const it of r.body.sjs) assert.strictEqual(Object.keys(it.options).length, 4);
});

test('admin routes reject a missing or wrong key', async () => {
  assert.strictEqual((await j('/api/admin/esi/whoami')).status, 401);
  assert.strictEqual((await j('/api/admin/esi/whoami',
    { headers: { Authorization: 'Bearer nope' } })).status, 401);
  const ok = await j('/api/admin/esi/whoami', { headers: AUTH });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.actor, 'Tester');
});

test('a minted token inspects clean and carries its window', async () => {
  const t = await mint();
  const r = await j('/api/esi/token?t=' + encodeURIComponent(t.token));
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.cohort, 'TEST-1');
  assert.strictEqual(r.body.window, 'day0');
});

test('an unknown token is refused', async () => {
  const r = await j('/api/esi/token?t=not-a-real-token');
  assert.strictEqual(r.status, 410);
  assert.strictEqual(r.body.reason, 'unknown');
});

test('submit scores, stores at pending_review, and returns three depth prompts', async () => {
  const t = await mint();
  const r = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(1) }),
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.status, 'pending_review');
  assert.strictEqual(r.body.depth_prompts.length, 3);
  // The student must NOT receive the Brief at submit time.
  assert.ok(!('report_text' in r.body), 'Brief must not be returned to the student');
  assert.ok(!('profile' in r.body), 'profile must not be returned to the student');
});

test('a malformed payload does NOT burn the token', async () => {
  const t = await mint();
  const bad = answers(0); delete bad.S01;
  const r1 = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: bad }),
  });
  assert.strictEqual(r1.status, 400);
  // Same token still works.
  const r2 = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(0) }),
  });
  assert.strictEqual(r2.status, 201);
});

test('a token is single-use', async () => {
  const t = await mint();
  const first = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(2) }),
  });
  assert.strictEqual(first.status, 201);
  const second = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(3) }),
  });
  assert.strictEqual(second.status, 410);
});

test('the release gate holds, then releases, and records who did it', async () => {
  const t = await mint();
  const sub = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(1) }),
  });
  const id = sub.body.submission_id;

  const pending = await j('/api/admin/esi/submissions?status=pending_review', { headers: AUTH });
  assert.ok(pending.body.some((s) => s.id === id), 'appears in the pending queue');

  const detail = await j('/api/admin/esi/submissions/' + id, { headers: AUTH });
  assert.strictEqual(detail.body.status, 'pending_review');
  assert.ok(detail.body.report_text.includes('Student Readiness Brief'));

  const rel = await j('/api/admin/esi/submissions/' + id + '/release',
    { method: 'POST', headers: AUTH, body: JSON.stringify({}) });
  assert.strictEqual(rel.status, 200);
  assert.strictEqual(rel.body.status, 'released');

  const after = await j('/api/admin/esi/submissions/' + id, { headers: AUTH });
  assert.strictEqual(after.body.released_by, 'Tester');
  assert.ok(after.body.audit.some((a) => a.action === 'released'));

  const again = await j('/api/admin/esi/submissions/' + id + '/release',
    { method: 'POST', headers: AUTH, body: JSON.stringify({}) });
  assert.strictEqual(again.status, 409, 'cannot release twice');
});

test('an edited Brief is what gets released, and the edit is recorded', async () => {
  const t = await mint();
  const sub = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(2) }),
  });
  const id = sub.body.submission_id;
  await j('/api/admin/esi/submissions/' + id + '/release', {
    method: 'POST', headers: AUTH, body: JSON.stringify({ report_text: '# Edited Brief\n\nBy hand.' }),
  });
  const after = await j('/api/admin/esi/submissions/' + id, { headers: AUTH });
  assert.strictEqual(after.body.report_text, '# Edited Brief\n\nBy hand.');
  assert.ok(after.body.audit.some((a) => a.detail === 'edited before release'));
});

test('depth responses store only for prompts the profile actually offered', async () => {
  const t = await mint();
  const sub = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(1) }),
  });
  const id = sub.body.submission_id;
  const offered = sub.body.depth_prompts[0].id;

  const good = await j('/api/esi/depth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submission_id: id, prompt_id: offered, body: 'A real answer.' }),
  });
  assert.strictEqual(good.status, 201);

  const bad = await j('/api/esi/depth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submission_id: id, prompt_id: 'NOT-OFFERED', body: 'x' }),
  });
  assert.strictEqual(bad.status, 400);
});

test('depth responses do not change the stored profile', async () => {
  const t = await mint();
  const sub = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(3) }),
  });
  const id = sub.body.submission_id;
  const before = await j('/api/admin/esi/submissions/' + id, { headers: AUTH });
  await j('/api/esi/depth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submission_id: id, prompt_id: sub.body.depth_prompts[0].id, body: 'Words.' }),
  });
  const after = await j('/api/admin/esi/submissions/' + id, { headers: AUTH });
  assert.strictEqual(JSON.stringify(before.body.profile), JSON.stringify(after.body.profile));
});

test('cohort view pairs Day 0 with Week 15 and reports the change in the gap', async () => {
  const ref = 'pair-student-1';
  const d0 = await mint({ cohort: 'PAIRED', window: 'day0', roster: [{ student_ref: ref, full_name: 'P. Student' }] });
  const w15 = await mint({ cohort: 'PAIRED', window: 'wk15', roster: [{ student_ref: ref, full_name: 'P. Student' }] });

  await j('/api/esi/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: d0.token, responses: answers(0) }) });
  await j('/api/esi/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: w15.token, responses: answers(2) }) });

  const c = await j('/api/admin/esi/cohort/PAIRED', { headers: AUTH });
  assert.strictEqual(c.status, 200);
  const s = c.body.students.find((x) => x.student_ref === ref);
  assert.ok(s.day0 && s.wk15, 'both windows present');
  assert.strictEqual(typeof s.pressure_delta_change, 'number');
  assert.strictEqual(c.body.n_paired, 1);
  assert.strictEqual(typeof c.body.mean_pressure_delta_change, 'number');
});

test('CSV export carries one row per submission with the domain columns', async () => {
  const r = await fetch(base + '/api/admin/esi/export/PAIRED.csv', { headers: AUTH });
  assert.strictEqual(r.status, 200);
  const csv = await r.text();
  const lines = csv.trim().split('\n');
  assert.ok(lines[0].includes('composite') && lines[0].includes('pressure_overall'));
  assert.strictEqual(lines.length, 3, 'header + two submissions');
});

test('the token list never echoes a token hash', async () => {
  const r = await j('/api/admin/esi/tokens', { headers: AUTH });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.length > 0);
  for (const t of r.body) assert.ok(!('token_hash' in t), 'hash must not be returned');
});

test('withholding records a reason and keeps the Brief from the student', async () => {
  const t = await mint();
  const sub = await j('/api/esi/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(1) }) });
  const id = sub.body.submission_id;
  const w = await j('/api/admin/esi/submissions/' + id + '/withhold',
    { method: 'POST', headers: AUTH, body: JSON.stringify({ reason: 'needs a conversation first' }) });
  assert.strictEqual(w.body.status, 'withheld');
  const after = await j('/api/admin/esi/submissions/' + id, { headers: AUTH });
  assert.ok(after.body.audit.some((a) => a.action === 'withheld' && a.detail.includes('conversation')));
});
