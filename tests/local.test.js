'use strict';
/* Contract tests for the zero-dependency server. Same assertions as
 * contract.test.js, run against server_local.js, so the two servers are proven
 * to agree on the parts that matter: the release gate, the token lifecycle,
 * and the rule that coding vectors never reach the browser.
 *
 * Requires no npm packages and no database. */

process.env.ESI_STORE = 'memory';
process.env.ADMIN_API_KEY = 'test-admin-key';

const test = require('node:test');
const assert = require('node:assert');
const { server, store, start } = require('../server_local');
const ITEMS = require('../esi_engine_data/esi_items_v1_0.json');

let base;
const AUTH = { Authorization: 'Bearer test-admin-key', 'Content-Type': 'application/json', 'X-Admin-Actor': 'Tester' };

test.before(async () => {
  await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const j = async (p, o = {}) => {
  const r = await fetch(base + p, o);
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch { body = { raw: t }; }
  return { status: r.status, body };
};

const LETTERS = ['A', 'B', 'C', 'D'];
function answers(off = 0) {
  const r = {};
  ITEMS.sjs.forEach((it, i) => { r[it.id] = LETTERS[(i + off) % 4]; });
  ITEMS.behavioral.forEach((b, i) => { r[b.id] = ((i + off) % 5) + 1; });
  return r;
}
async function mint(ov = {}) {
  const res = await j('/api/admin/esi/tokens', {
    method: 'POST', headers: AUTH,
    body: JSON.stringify({
      cohort: 'LOCAL-1', window: 'day0', days: 30,
      roster: [{ student_ref: 'l' + Math.random().toString(36).slice(2, 9), full_name: 'A. Student' }],
      ...ov,
    }),
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body.tokens[0];
}

test('boots with no npm dependencies and reports zero-dep', async () => {
  const r = await j('/api/health');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.server, 'zero-dep');
  assert.strictEqual(r.body.store, 'memory');
  assert.ok(r.body.versions.engine);
});

test('serves the admin console and the assessment page as static files', async () => {
  for (const p of ['/esi_admin.html', '/esi_assessment.html', '/']) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 200, p);
    assert.match(r.headers.get('content-type') || '', /text\/html/, p);
    assert.match(await r.text(), /EXCEED STUDENT/, p);
  }
});

test('static serving cannot be walked out of public/', async () => {
  for (const p of ['/../server_local.js', '/..%2Fserver_local.js', '/../../etc/passwd']) {
    const r = await fetch(base + p);
    assert.ok(r.status === 404 || r.status === 400, `${p} returned ${r.status}`);
    const body = await r.text();
    assert.ok(!body.includes('ADMIN_API_KEY'), `${p} leaked source`);
  }
});

test('the instrument endpoint never leaks scoring vectors', async () => {
  const r = await j('/api/esi/instrument');
  assert.strictEqual(r.body.sjs.length, 22);
  assert.strictEqual(r.body.behavioral.length, 16);
  const blob = JSON.stringify(r.body);
  assert.ok(!blob.includes('facets'));
  assert.ok(!blob.includes('tendencies'));
  assert.ok(!/"reverse"/.test(blob));
});

test('admin auth rejects missing and wrong keys', async () => {
  assert.strictEqual((await j('/api/admin/esi/whoami')).status, 401);
  assert.strictEqual((await j('/api/admin/esi/whoami',
    { headers: { Authorization: 'Bearer nope' } })).status, 401);
  const ok = await j('/api/admin/esi/whoami', { headers: AUTH });
  assert.strictEqual(ok.body.actor, 'Tester');
});

test('a malformed payload does not burn the token', async () => {
  const t = await mint();
  const bad = answers(0); delete bad.S05;
  assert.strictEqual((await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: bad }) })).status, 400);
  assert.strictEqual((await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(0) }) })).status, 201);
});

test('tokens are single-use', async () => {
  const t = await mint();
  assert.strictEqual((await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(1) }) })).status, 201);
  assert.strictEqual((await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(2) }) })).status, 410);
});

test('submit withholds the Brief and returns three depth prompts', async () => {
  const t = await mint();
  const r = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(3) }) });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.status, 'pending_review');
  assert.strictEqual(r.body.depth_prompts.length, 3);
  assert.ok(!('report_text' in r.body));
  assert.ok(!('profile' in r.body));
});

test('the release gate holds, releases, and records the actor and the edit', async () => {
  const t = await mint();
  const sub = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(1) }) });
  const id = sub.body.submission_id;

  const pending = await j('/api/admin/esi/submissions?status=pending_review', { headers: AUTH });
  assert.ok(pending.body.some((s) => s.id === id));

  const rel = await j(`/api/admin/esi/submissions/${id}/release`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ report_text: '# Edited\n\nBy hand.' }) });
  assert.strictEqual(rel.status, 200);

  const after = await j(`/api/admin/esi/submissions/${id}`, { headers: AUTH });
  assert.strictEqual(after.body.status, 'released');
  assert.strictEqual(after.body.released_by, 'Tester');
  assert.strictEqual(after.body.report_text, '# Edited\n\nBy hand.');
  assert.ok(after.body.audit.some((a) => a.detail === 'edited before release'));

  assert.strictEqual((await j(`/api/admin/esi/submissions/${id}/release`,
    { method: 'POST', headers: AUTH, body: '{}' })).status, 409);
});

test('depth responses are gated to the offered prompts and never change the profile', async () => {
  const t = await mint();
  const sub = await j('/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: t.token, responses: answers(2) }) });
  const id = sub.body.submission_id;
  const before = await j(`/api/admin/esi/submissions/${id}`, { headers: AUTH });

  assert.strictEqual((await j('/api/esi/depth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submission_id: id, prompt_id: 'NOPE', body: 'x' }) })).status, 400);

  assert.strictEqual((await j('/api/esi/depth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ submission_id: id, prompt_id: sub.body.depth_prompts[0].id, body: 'Real words.' }) })).status, 201);

  const after = await j(`/api/admin/esi/submissions/${id}`, { headers: AUTH });
  assert.strictEqual(JSON.stringify(before.body.profile), JSON.stringify(after.body.profile));
});

test('cohort view pairs the two windows and CSV exports', async () => {
  const ref = 'local-pair-1';
  const d0 = await mint({ cohort: 'LOCALPAIR', window: 'day0', roster: [{ student_ref: ref, full_name: 'P. Student' }] });
  const w15 = await mint({ cohort: 'LOCALPAIR', window: 'wk15', roster: [{ student_ref: ref, full_name: 'P. Student' }] });
  for (const [tok, off] of [[d0, 0], [w15, 2]]) {
    await j('/api/esi/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: tok.token, responses: answers(off) }) });
  }
  const c = await j('/api/admin/esi/cohort/LOCALPAIR', { headers: AUTH });
  assert.strictEqual(c.body.n_paired, 1);
  assert.strictEqual(typeof c.body.mean_pressure_delta_change, 'number');

  const csv = await fetch(base + '/api/admin/esi/export/LOCALPAIR.csv', { headers: AUTH });
  assert.strictEqual(csv.status, 200);
  assert.match(csv.headers.get('content-type') || '', /text\/csv/);
  assert.strictEqual((await csv.text()).trim().split('\n').length, 3);
});

test('the token list never echoes a hash', async () => {
  const r = await j('/api/admin/esi/tokens', { headers: AUTH });
  for (const t of r.body) assert.ok(!('token_hash' in t));
});

test('oversized and malformed bodies are refused cleanly', async () => {
  const big = await fetch(base + '/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ t: 'x', pad: 'y'.repeat(300 * 1024) }) }).catch(() => ({ status: 413 }));
  assert.ok([400, 413].includes(big.status), `got ${big.status}`);

  const bad = await fetch(base + '/api/esi/submit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.strictEqual(bad.status, 400);
});

test('rate limiting engages and reports a retry window', async () => {
  const hits = [];
  for (let i = 0; i < 24; i++) {
    hits.push((await j('/api/esi/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ t: 'nope', responses: answers(0) }) })).status);
  }
  assert.ok(hits.includes(429), 'limit should engage within 24 calls');
});
