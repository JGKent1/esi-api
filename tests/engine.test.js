'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../esi_engine');
const ITEMS = require('../esi_engine_data/esi_items_v1_0.json');

const SJS_IDS = ITEMS.sjs.map((i) => i.id);
const BEH_IDS = ITEMS.behavioral.map((i) => i.id);

// Deterministic fixture builders — no randomness anywhere in the suite.
function build(pick, beh) {
  const r = {};
  SJS_IDS.forEach((id, i) => { r[id] = pick(id, i); });
  BEH_IDS.forEach((id, i) => { r[id] = beh(id, i); });
  return r;
}
const LETTERS = ['A', 'B', 'C', 'D'];
const allA   = build(() => 'A', () => 3);
const allC   = build(() => 'C', () => 2);
const cyclic = build((id, i) => LETTERS[i % 4], (id, i) => (i % 5) + 1);

// Best/worst possible: choose the option with the highest (lowest) total facet delta.
function extreme(dir) {
  return build((id) => {
    const it = ITEMS.sjs.find((x) => x.id === id);
    let best = null, bestVal = null;
    for (const [L, o] of Object.entries(it.options)) {
      const v = Object.values(o.facets || {}).reduce((a, b) => a + b, 0);
      if (bestVal === null || (dir > 0 ? v > bestVal : v < bestVal)) { bestVal = v; best = L; }
    }
    return best;
  }, (id) => {
    const it = ITEMS.behavioral.find((x) => x.id === id);
    return dir > 0 ? (it.reverse ? 1 : 5) : (it.reverse ? 5 : 1);
  });
}
const strong = extreme(1);
const weak   = extreme(-1);

test('instrument shape matches EEI v1.2', () => {
  assert.strictEqual(ITEMS.sjs.length, 22, '22 presentations');
  assert.strictEqual(ITEMS.behavioral.length, 16, '16 behavioral items');
  assert.strictEqual(Object.keys(E.PAIRS).length, 5, '5 pressure pairs');
  assert.strictEqual(E.ALL_FACETS.length, 24, '24 facets');
  for (const it of ITEMS.sjs) assert.strictEqual(Object.keys(it.options).length, 4, `${it.id} has 4 options`);
});

test('every pressure pair has a composed and a compressed member, one per domain', () => {
  const domains = new Set();
  for (const [, p] of Object.entries(E.PAIRS)) {
    assert.ok(p.composed && p.compressed, 'both members present');
    domains.add(p.domain);
  }
  assert.strictEqual(domains.size, 5, 'all five domains carry a pair');
});

test('validation rejects missing, invalid and unexpected keys', () => {
  assert.ok(E.validateResponses(allA).ok);
  const missing = { ...allA }; delete missing.S01;
  assert.ok(!E.validateResponses(missing).ok);
  const badOpt = { ...allA, S01: 'Z' };
  assert.ok(!E.validateResponses(badOpt).ok);
  const badBeh = { ...allA, B01: 9 };
  assert.ok(!E.validateResponses(badBeh).ok);
  const extra = { ...allA, NOPE: 'A' };
  assert.ok(!E.validateResponses(extra).ok);
  assert.throws(() => E.scoreSubmission(missing), /validation failed/);
});

test('determinism — same payload twice gives byte-identical profile and Brief', () => {
  const a = E.scoreSubmission(cyclic);
  const b = E.scoreSubmission(JSON.parse(JSON.stringify(cyclic)));
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
  const s = { full_name: 'A. Student', cohort: 'CJ 490', window: 'day0' };
  assert.strictEqual(E.renderBrief(a, s), E.renderBrief(b, s));
});

test('scale floor and ceiling hold', () => {
  for (const r of [allA, allC, cyclic, strong, weak]) {
    const p = E.scoreSubmission(r);
    for (const d of E.DOMAIN_KEYS) {
      assert.ok(p.domains[d] >= 25 && p.domains[d] <= 100, `${d}=${p.domains[d]} in range`);
    }
    assert.ok(p.composite >= 25 && p.composite <= 100, `composite ${p.composite} in range`);
  }
});

test('best-possible outranks worst-possible on every domain', () => {
  const hi = E.scoreSubmission(strong), lo = E.scoreSubmission(weak);
  for (const d of E.DOMAIN_KEYS) {
    assert.ok(hi.domains[d] > lo.domains[d], `${d}: ${hi.domains[d]} > ${lo.domains[d]}`);
  }
  assert.ok(hi.composite > lo.composite);
});

test('composite is the weighted sum of the domain scores', () => {
  const p = E.scoreSubmission(cyclic);
  const expected = E.round(
    E.DOMAIN_KEYS.reduce((s, d) => s + p.domains[d] * E.DOMAINS[d].weight, 0), 1);
  assert.strictEqual(p.composite, expected);
});

test('student weights are Self .25 Teams .20 Complexity .15 Pressure .25 Future .15', () => {
  assert.strictEqual(E.DOMAINS.LS.weight, 0.25);
  assert.strictEqual(E.DOMAINS.LT.weight, 0.20);
  assert.strictEqual(E.DOMAINS.LC.weight, 0.15);
  assert.strictEqual(E.DOMAINS.LP.weight, 0.25);
  assert.strictEqual(E.DOMAINS.LF.weight, 0.15);
  const total = E.DOMAIN_KEYS.reduce((s, d) => s + E.DOMAINS[d].weight, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'weights sum to 1');
});

test('bands are the four student bands with the documented cuts', () => {
  assert.deepStrictEqual(E.BANDS.map((b) => [b.name, b.min]), [
    ['Ready to Lead', 85], ['Ready with Support', 72], ['Developing', 58], ['Foundational', 0],
  ]);
});

test('Pressure Delta computes per domain and separates composed from compressed', () => {
  // Answer every composed member well and every compressed member badly.
  const r = { ...cyclic };
  for (const p of Object.values(E.PAIRS)) {
    const it = ITEMS.sjs.find((x) => x.id === p.composed);
    const px = E.DOMAINS[p.domain].key + '.';
    const sum = (o) => Object.entries(o.facets || {}).filter(([f]) => f.startsWith(px))
      .reduce((a, [, v]) => a + v, 0);
    const rank = Object.entries(it.options).sort((a, b) => sum(b[1]) - sum(a[1]));
    r[p.composed] = rank[0][0];
    const it2 = ITEMS.sjs.find((x) => x.id === p.compressed);
    const rank2 = Object.entries(it2.options).sort((a, b) => sum(a[1]) - sum(b[1]));
    r[p.compressed] = rank2[0][0];
  }
  const p = E.scoreSubmission(r);
  for (const d of E.DOMAIN_KEYS) {
    const x = p.pressure.by_domain[d];
    assert.ok(x.delta > 0, `${d} gap positive (${x.composed} vs ${x.compressed})`);
  }
  assert.ok(p.pressure.overall > 0);
});

test('depth module returns exactly three selectable prompts, deterministically', () => {
  const p = E.scoreSubmission(cyclic);
  assert.strictEqual(p.depth_prompt_ids.length, 3);
  assert.strictEqual(new Set(p.depth_prompt_ids).size, 3, 'no duplicates');
  const prompts = E.selectDepthPrompts(p);
  assert.strictEqual(prompts.length, 3);
  prompts.forEach((x) => assert.ok(x && x.text && x.text.length > 20));
  assert.deepStrictEqual(E.scoreSubmission(cyclic).depth_prompt_ids, p.depth_prompt_ids);
});

test('depth responses are interpretive only — nothing in the profile depends on them', () => {
  const withDepth = { ...cyclic };
  const p1 = E.scoreSubmission(cyclic);
  const p2 = E.scoreSubmission(withDepth);
  assert.strictEqual(JSON.stringify(p1), JSON.stringify(p2));
});

test('profile carries signature family, pair, archetype and counterpart', () => {
  const p = E.scoreSubmission(cyclic);
  assert.ok(E.DOMAIN_KEYS.includes(p.signature_family));
  assert.match(p.signature_pair, /^(LS|LT|LC|LP|LF)-(LS|LT|LC|LP|LF)$/);
  assert.ok(p.archetype && p.archetype.name && p.archetype.narrative);
  assert.ok(p.counterpart && p.counterpart.intro && p.counterpart.partner);
  assert.strictEqual(p.domain_order.length, 5);
});

test('every one of the 20 signature pairs has an authored archetype', () => {
  const S = require('../esi_engine_data/esi_statements.json');
  for (const a of E.DOMAIN_KEYS) for (const b of E.DOMAIN_KEYS) {
    if (a === b) continue;
    assert.ok(S.archetypes[`${a}-${b}`], `missing archetype ${a}-${b}`);
  }
});

test('statement bank covers all 24 facets for label, strength, vulnerability, development', () => {
  const S = require('../esi_engine_data/esi_statements.json');
  for (const f of E.ALL_FACETS) {
    assert.ok(S.facet_labels[f], `label ${f}`);
    assert.ok(S.strengths[f], `strength ${f}`);
    assert.ok(S.vulnerabilities[f], `vulnerability ${f}`);
    assert.ok(S.development[f], `development ${f}`);
  }
});

test('Brief renders without generic fallback and contains the required sections', () => {
  for (const r of [allA, allC, cyclic, strong, weak]) {
    const p = E.scoreSubmission(r);
    const md = E.renderBrief(p, { full_name: 'A. Student', cohort: 'CJ 490', window: 'day0' });
    for (const h of ['Student Readiness Brief', 'Where you are', 'The page and the room',
                     'Your shape', 'How you decide', 'What is working', 'Where the work is',
                     'Your development priorities', 'Who to work with']) {
      assert.ok(md.includes(h), `Brief missing "${h}"`);
    }
    assert.ok(!md.includes('undefined'), 'no undefined in Brief');
    assert.ok(!md.includes('[object'), 'no object stringification in Brief');
    assert.ok(md.length > 1800, 'Brief has substance');
  }
});

test('release safety — the Brief never uses prohibited language', () => {
  // The ban is on ASSERTING these things, not on disclaiming them. A line that
  // says "this is not a clinical assessment" is exactly what we want to keep, so
  // the check runs per line and exempts explicit negations.
  const banned = [/\bvalidated\b/i, /\bat[- ]risk\b/i, /\bdiagnos(is|e|ed)\b/i, /\bdisorder\b/i,
                  /\bclinical\b/i, /\byou will fail\b/i, /\bnot cut out\b/i];
  const isDisclaimer = (line) => /\b(is not|are not|does not|it is not|never)\b/i.test(line);
  // "Decision File Diagnose" is the canonical name of a capstone phase — a
  // course artifact, not a claim about the student. Strip proper nouns before
  // the ban check so the ban keeps its real target.
  const stripProperNouns = (line) => line.replace(/Decision File Diagnose/g, 'Decision File');
  for (const r of [allA, allC, cyclic, strong, weak]) {
    const md = E.renderBrief(E.scoreSubmission(r), { full_name: 'A. Student' });
    for (const line of md.split('\n')) {
      if (isDisclaimer(line)) continue;
      const checked = stripProperNouns(line);
      for (const re of banned) {
        assert.ok(!re.test(checked), `Brief line matched banned pattern ${re}: "${line}"`);
      }
    }
  }
});

test('versions are stamped on every profile', () => {
  const p = E.scoreSubmission(cyclic);
  assert.ok(p.versions.engine && p.versions.item_bank && p.versions.statements && p.versions.depth_bank);
});
