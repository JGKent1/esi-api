'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
 * ESI Deterministic Scoring Engine
 * Exceed Student Index v1.0 · port of the EEI structured engine (DEC-0008)
 *
 * Pure functions. No model call, no network, no clock, no randomness.
 * Same responses in → byte-identical profile and Brief out. That property is a
 * hard requirement: it is what lets a Week 15 score be compared to a Day 0 score
 * without arguing about the scorer.
 *
 * Public API:
 *   scoreSubmission(responses)      → profile object
 *   renderBrief(profile, subject)   → markdown string
 *   validateResponses(responses)    → { ok, errors[] }
 *   selectDepthPrompts(profile)     → [3 prompt objects]
 *   VERSIONS                        → stamped on every submission
 * ──────────────────────────────────────────────────────────────────────────── */

const ITEMS      = require('./esi_engine_data/esi_items_v1_0.json');
const DEPTH      = require('./esi_engine_data/esi_depth_bank.json');
const STATEMENTS = require('./esi_engine_data/esi_statements.json');

const VERSIONS = Object.freeze({
  engine:     'esi_engine@1.0.0',
  item_bank:  'esi_items_v1_0',
  statements: STATEMENTS.bank_version,
  depth_bank: 'esi_depth_v1_0',
});

/* ── taxonomy ─────────────────────────────────────────────────────────────── */

const DOMAINS = Object.freeze({
  LS: { key: 'ls', name: 'Leading Self',               weight: 0.25 },
  LT: { key: 'lt', name: 'Leading Teams',              weight: 0.20 },
  LC: { key: 'lc', name: 'Leading Through Complexity', weight: 0.15 },
  LP: { key: 'lp', name: 'Leading Under Pressure',     weight: 0.25 },
  LF: { key: 'lf', name: 'Leading Into the Future',    weight: 0.15 },
});
const DOMAIN_KEYS = Object.freeze(['LS', 'LT', 'LC', 'LP', 'LF']);
const PREFIX_TO_DOMAIN = Object.freeze({ ls: 'LS', lt: 'LT', lc: 'LC', lp: 'LP', lf: 'LF' });

const BANDS = Object.freeze([
  { min: 85, name: 'Ready to Lead',
    gloss: 'Judgment already holds under pressure and with people watching.' },
  { min: 72, name: 'Ready with Support',
    gloss: 'Sound judgment with identified conditions; ready for responsibility alongside a named support structure.' },
  { min: 58, name: 'Developing',
    gloss: 'Capable when conditions are favourable; inconsistent when they are not.' },
  { min: 0,  name: 'Foundational',
    gloss: 'Early. The building blocks are the work of this term. A starting line, not a verdict.' },
]);

const TENDENCY_AXES = Object.freeze({
  velocity:    { neg: 'deliberate',  pos: 'decisive' },
  information: { neg: 'analytical',  pos: 'intuitive' },
  orientation: { neg: 'task-first',  pos: 'people-first' },
  risk:        { neg: 'protective',  pos: 'bold' },
  counsel:     { neg: 'solo',        pos: 'collaborative' },
});

const SCORE_FLOOR = 25;   // "no student scores zero" — inherited from the EEI

/* ── deterministic helpers ────────────────────────────────────────────────── */

// Round half away from zero, matching the Python reference used for EEI parity.
function round(n, dp = 2) {
  const f = Math.pow(10, dp);
  const scaled = n * f;
  const r = scaled >= 0 ? Math.floor(scaled + 0.5) : Math.ceil(scaled - 0.5);
  return r / f;
}
const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const byId = (arr) => arr.reduce((m, x) => (m[x.id] = x, m), {});

const SJS = byId(ITEMS.sjs);
const BEH = byId(ITEMS.behavioral);
const SJS_IDS = ITEMS.sjs.map((i) => i.id);
const BEH_IDS = ITEMS.behavioral.map((i) => i.id);

// Pressure pairs, derived from the bank rather than hardcoded.
const PAIRS = (() => {
  const m = {};
  for (const it of ITEMS.sjs) {
    if (!it.pair) continue;
    (m[it.pair] ||= { domain: it.domain_lead })[it.condition] = it.id;
  }
  return Object.freeze(m);
})();

/* ── facet range table (computed once, from the bank) ─────────────────────── */
// A facet's raw score is bounded by the best and worst it could possibly do:
// for each item where the facet appears, the max (and min) delta available
// across that item's four options, plus ±2 if a behavioral item targets it.
const FACET_RANGE = (() => {
  const range = {};
  const touch = (f) => (range[f] ||= { min: 0, max: 0 });

  for (const it of ITEMS.sjs) {
    const per = {};
    for (const opt of Object.values(it.options)) {
      for (const [f, v] of Object.entries(opt.facets || {})) {
        per[f] ||= { min: 0, max: 0 };
        if (v > per[f].max) per[f].max = v;
        if (v < per[f].min) per[f].min = v;
      }
    }
    for (const [f, mm] of Object.entries(per)) {
      touch(f); range[f].max += mm.max; range[f].min += mm.min;
    }
  }
  for (const it of ITEMS.behavioral) {
    touch(it.facet); range[it.facet].max += 2; range[it.facet].min += -2;
  }
  return Object.freeze(range);
})();

const ALL_FACETS = Object.freeze(Object.keys(FACET_RANGE).sort());

const TENDENCY_RANGE = (() => {
  const r = {};
  for (const it of ITEMS.sjs) {
    const per = {};
    for (const opt of Object.values(it.options)) {
      for (const [a, v] of Object.entries(opt.tendencies || {})) {
        per[a] ||= { min: 0, max: 0 };
        if (v > per[a].max) per[a].max = v;
        if (v < per[a].min) per[a].min = v;
      }
    }
    for (const [a, mm] of Object.entries(per)) {
      r[a] ||= { min: 0, max: 0 };
      r[a].max += mm.max; r[a].min += mm.min;
    }
  }
  return Object.freeze(r);
})();

/* ── validation ───────────────────────────────────────────────────────────── */

function validateResponses(responses) {
  const errors = [];
  if (!responses || typeof responses !== 'object') {
    return { ok: false, errors: ['responses must be an object'] };
  }
  for (const id of SJS_IDS) {
    const v = responses[id];
    if (v === undefined || v === null || v === '') { errors.push(`missing scenario ${id}`); continue; }
    if (!Object.prototype.hasOwnProperty.call(SJS[id].options, v)) {
      errors.push(`invalid option "${v}" for ${id}`);
    }
  }
  for (const id of BEH_IDS) {
    const v = Number(responses[id]);
    if (!Number.isInteger(v) || v < 1 || v > 5) errors.push(`behavioral ${id} must be an integer 1–5`);
  }
  const extra = Object.keys(responses).filter((k) => !SJS[k] && !BEH[k]);
  if (extra.length) errors.push(`unexpected keys: ${extra.sort().join(', ')}`);
  return { ok: errors.length === 0, errors };
}

/* ── scoring ──────────────────────────────────────────────────────────────── */

function rawFacets(responses) {
  const raw = {};
  for (const f of ALL_FACETS) raw[f] = 0;

  for (const id of SJS_IDS) {
    const opt = SJS[id].options[responses[id]];
    for (const [f, v] of Object.entries(opt.facets || {})) raw[f] += v;
  }
  for (const id of BEH_IDS) {
    const item = BEH[id];
    const val = Number(responses[id]);
    const scored = item.reverse ? 6 - val : val;   // 1..5
    raw[item.facet] += scored - 3;                 // −2..+2, same scale as an option delta
  }
  return raw;
}

const facetUnit = (f, rawVal) => {
  const { min, max } = FACET_RANGE[f];
  return max === min ? 0.5 : clamp01((rawVal - min) / (max - min));
};

const toScale = (unit) => round(SCORE_FLOOR + (100 - SCORE_FLOOR) * unit, 1);

function domainScores(units) {
  const out = {};
  for (const dk of DOMAIN_KEYS) {
    const px = DOMAINS[dk].key + '.';
    const fs = ALL_FACETS.filter((f) => f.startsWith(px));
    const mean = fs.reduce((s, f) => s + units[f], 0) / fs.length;
    out[dk] = toScale(mean);
  }
  return out;
}

// Pressure Delta: the same scenario scored composed and compressed.
// Each member is scored on the delta it produces in its own domain's facets,
// normalized against that single item's own best and worst options.
function itemDomainUnit(itemId, choice, domainKey) {
  const it = SJS[itemId];
  const px = DOMAINS[domainKey].key + '.';
  const sumFor = (opt) => Object.entries(opt.facets || {})
    .filter(([f]) => f.startsWith(px))
    .reduce((s, [, v]) => s + v, 0);
  const sums = Object.values(it.options).map(sumFor);
  const min = Math.min(...sums), max = Math.max(...sums);
  const got = sumFor(it.options[choice]);
  return max === min ? 0.5 : clamp01((got - min) / (max - min));
}

function pressure(responses) {
  const per = {};
  for (const [pairId, p] of Object.entries(PAIRS)) {
    const dk = p.domain;
    const composed   = toScale(itemDomainUnit(p.composed,   responses[p.composed],   dk));
    const compressed = toScale(itemDomainUnit(p.compressed, responses[p.compressed], dk));
    per[dk] = { pair: pairId, composed, compressed, delta: round(composed - compressed, 1) };
  }
  const deltas = DOMAIN_KEYS.map((d) => per[d].delta);
  const overall = round(deltas.reduce((a, b) => a + b, 0) / deltas.length, 1);
  return { by_domain: per, overall };
}

function tendencies(responses) {
  const raw = {};
  for (const a of Object.keys(TENDENCY_AXES)) raw[a] = 0;
  for (const id of SJS_IDS) {
    const opt = SJS[id].options[responses[id]];
    for (const [a, v] of Object.entries(opt.tendencies || {})) raw[a] += v;
  }
  const out = {};
  for (const [a, labels] of Object.entries(TENDENCY_AXES)) {
    const { min, max } = TENDENCY_RANGE[a] || { min: -1, max: 1 };
    const span = raw[a] >= 0 ? (max || 1) : Math.abs(min || 1);
    const norm = round(Math.max(-1, Math.min(1, raw[a] / span)), 3);
    let level;
    if (norm >= 0.45) level = 'pos_strong';
    else if (norm >= 0.15) level = 'pos_mod';
    else if (norm <= -0.45) level = 'neg_strong';
    else if (norm <= -0.15) level = 'neg_mod';
    else level = 'balanced';
    out[a] = { raw: raw[a], norm, level, pole: labels[level.startsWith('pos') ? 'pos' : 'neg'] || 'balanced' };
  }
  return out;
}

function bandFor(composite) {
  return BANDS.find((b) => composite >= b.min) || BANDS[BANDS.length - 1];
}

// Deterministic domain ordering: score desc, then fixed domain order as tie-break.
function rankDomains(domains) {
  return [...DOMAIN_KEYS].sort((a, b) =>
    domains[b] - domains[a] || DOMAIN_KEYS.indexOf(a) - DOMAIN_KEYS.indexOf(b));
}

function scoreSubmission(responses) {
  const v = validateResponses(responses);
  if (!v.ok) { const e = new Error('ESI validation failed'); e.details = v.errors; throw e; }

  const raw = rawFacets(responses);
  const units = {}; const facets = {};
  for (const f of ALL_FACETS) {
    units[f] = facetUnit(f, raw[f]);
    facets[f] = { raw: raw[f], unit: round(units[f], 3), score: toScale(units[f]) };
  }

  const domains = domainScores(units);
  const composite = round(
    DOMAIN_KEYS.reduce((s, dk) => s + domains[dk] * DOMAINS[dk].weight, 0), 1);
  const band = bandFor(composite);

  const ranked = rankDomains(domains);
  const signature_family = ranked[0];
  const signature_pair = `${ranked[0]}-${ranked[1]}`;
  const exposure = ranked[ranked.length - 1];

  const sortedFacets = [...ALL_FACETS].sort((a, b) => units[a] - units[b] || (a < b ? -1 : 1));
  const exposure_facets = sortedFacets.slice(0, 3);
  const strength_facets = [...sortedFacets].reverse().slice(0, 3);

  return {
    versions: VERSIONS,
    facets,
    domains,
    domain_order: ranked,
    composite,
    band: { name: band.name, min: band.min, gloss: band.gloss },
    pressure: pressure(responses),
    tendencies: tendencies(responses),
    signature_family,
    signature_pair,
    archetype: STATEMENTS.archetypes[signature_pair] || STATEMENTS.archetypes._default,
    exposure_domain: exposure,
    counterpart: STATEMENTS.counterpart[exposure],
    exposure_facets,
    strength_facets,
    depth_prompt_ids: selectDepthPromptIds({ exposure_facets, exposure_domain: exposure }),
  };
}

/* ── depth module ─────────────────────────────────────────────────────────── */
// Exactly three prompts, chosen for the measured profile. Interpretive only —
// they never alter a score. Selection is deterministic: rank by how many of the
// student's three exposure facets a prompt touches, tie-break on prompt id.
function selectDepthPromptIds({ exposure_facets, exposure_domain }) {
  const scored = DEPTH.prompts
    .filter((p) => p.selectable !== false)
    .map((p) => {
      const hits = p.facets.filter((f) => exposure_facets.includes(f)).length;
      const domainHit = p.domain === exposure_domain ? 1 : 0;
      return { id: p.id, key: hits * 10 + domainHit };
    })
    .sort((a, b) => b.key - a.key || (a.id < b.id ? -1 : 1));
  return scored.slice(0, 3).map((p) => p.id);
}
function selectDepthPrompts(profile) {
  const map = byId(DEPTH.prompts);
  return profile.depth_prompt_ids.map((id) => map[id]);
}

/* ── Brief ────────────────────────────────────────────────────────────────── */

const facetLabel = (f) => STATEMENTS.facet_labels[f] || f;

function renderBrief(profile, subject = {}) {
  const name = subject.full_name || 'Student';
  const L = [];
  const p = profile;

  L.push(`# Student Readiness Brief`);
  L.push('');
  L.push(`**${name}**${subject.cohort ? ` · ${subject.cohort}` : ''}${subject.window ? ` · ${subject.window === 'wk15' ? 'Week 13' : 'Day 0'} administration` : ''}`);
  L.push('');
  L.push(`Exceed Student Index v1.0 · structured developmental diagnostic · pre-norming`);
  L.push('');
  L.push('---');
  L.push('');

  L.push(`## Where you are`);
  L.push('');
  L.push(`**Composite ${p.composite} — ${p.band.name}.** ${p.band.gloss}`);
  L.push('');
  L.push(STATEMENTS.band_note);
  L.push('');

  L.push('| Domain | Score | Weight |');
  L.push('|---|---:|---:|');
  for (const dk of p.domain_order) {
    L.push(`| ${DOMAINS[dk].name} | ${p.domains[dk]} | ${DOMAINS[dk].weight.toFixed(2)} |`);
  }
  L.push('');
  L.push(`_${STATEMENTS.weights_note}_`);
  L.push('');

  L.push(`## The page and the room`);
  L.push('');
  L.push(STATEMENTS.pressure_intro);
  L.push('');
  // Each domain rests on ONE paired scenario: a two-point reading shown as a
  // number invites false precision. Students get direction; the numbers stay
  // in the instructor console and the CSV export (v3, patch 4).
  const mark = (v) => (v >= 50 ? '●' : '○');
  L.push('| Domain | On the page | In the room |  |');
  L.push('|---|:-:|:-:|---|');
  for (const dk of DOMAIN_KEYS) {
    const x = p.pressure.by_domain[dk];
    const pageStronger = x.delta > 0;
    const note = pageStronger ? '**page stronger — watch this**'
      : x.delta < 0 ? 'room stronger' : 'no difference';
    const dn = pageStronger ? `**${DOMAINS[dk].name}**` : DOMAINS[dk].name;
    L.push(`| ${dn} | ${mark(x.composed)} | ${mark(x.compressed)} | ${note} |`);
  }
  L.push('');
  const deltas = DOMAIN_KEYS.map((dk) => p.pressure.by_domain[dk].delta);
  const nPage = deltas.filter((d) => d > 0).length;
  const nRoom = deltas.filter((d) => d < 0).length;
  const ov = p.pressure.overall;
  const pk = ov >= 18 ? 'wide' : ov >= 8 ? 'moderate' : ov >= -3 ? 'narrow' : 'inverted';
  L.push(`**${nPage} of 5 domains ${nPage === 1 ? 'was' : 'were'} stronger on the page; ${nRoom} ${nRoom === 1 ? 'was' : 'were'} stronger in the room.** ${STATEMENTS.pressure_readings[pk]}`);
  L.push('');
  // The line that matters is the one where composed judgment beat compressed —
  // the direction this course exists to close. Rendered only when it happened.
  const pagey = DOMAIN_KEYS.filter((dk) => p.pressure.by_domain[dk].delta > 0);
  if (pagey.length) {
    const watch = pagey.reduce((a, b) =>
      p.pressure.by_domain[b].delta > p.pressure.by_domain[a].delta ? b : a);
    L.push(`**${DOMAINS[watch].name}** is where your page answer beat your room answer by the most. That direction — stronger with time than without it — is the one this course is built to close. ${STATEMENTS.pressure_domain_note[watch]}`);
    L.push('');
  }
  L.push(`_${STATEMENTS.pressure_caveat}_`);
  L.push('');

  L.push(`## Your shape`);
  L.push('');
  L.push(`**${p.archetype.name}** — ${DOMAINS[p.signature_family].name} out front, with ${DOMAINS[p.domain_order[1]].name} close behind it. Your lowest domain is **${DOMAINS[p.exposure_domain].name}** (${p.domains[p.exposure_domain]}).`);
  L.push('');
  L.push(p.archetype.narrative);
  L.push('');

  L.push(`### How you decide`);
  L.push('');
  for (const [axis, t] of Object.entries(p.tendencies)) {
    L.push(`- ${STATEMENTS.tendency_lines[axis][t.level]}`);
  }
  L.push('');
  L.push(STATEMENTS.tendency_note);
  L.push('');

  L.push(`## What is working`);
  L.push('');
  const facetDomain = (f) => DOMAINS[f.slice(0, 2).toUpperCase()].name;
  for (const f of p.strength_facets) {
    L.push(`- **${facetLabel(f)}** _(${facetDomain(f)})_ — ${STATEMENTS.strengths[f] || STATEMENTS.strengths._default}`);
  }
  L.push('');

  L.push(`## Where the work is`);
  L.push('');
  // Frame before the list: exposure facets are the RELATIVE bottom three.
  // Low means little evidence, not a fixed limit (second read, 16 Aug 2026).
  L.push(`_${STATEMENTS.vulnerabilities._default}_`);
  L.push('');
  for (const f of p.exposure_facets) {
    L.push(`- **${facetLabel(f)}** _(${facetDomain(f)})_ — ${STATEMENTS.vulnerabilities[f] || STATEMENTS.vulnerabilities._default}`);
  }
  L.push('');

  L.push(`## Your development priorities this term`);
  L.push('');
  p.exposure_facets.forEach((f, i) => {
    L.push(`${i + 1}. ${STATEMENTS.development[f] || STATEMENTS.development._default}`);
  });
  L.push('');

  // "Your term, from here" — the section that answers what to DO about all of
  // the above. Keyed by the same bottom-three facets the priorities already
  // selected; no new logic, no new measurement (v3, patch 5).
  L.push(`## Your term, from here`);
  L.push('');
  L.push(STATEMENTS.term_paths_intro);
  L.push('');
  L.push('| What you are working on | Where it happens | What you will produce | What we watch for |');
  L.push('|---|---|---|---|');
  for (const f of p.exposure_facets) {
    const tp = STATEMENTS.term_paths[f];
    if (tp) L.push(`| **${facetLabel(f)}** | ${tp.where} | ${tp.produce} | ${tp.watch} |`);
  }
  if (pagey.length) {
    const watch = pagey.reduce((a, b) =>
      p.pressure.by_domain[b].delta > p.pressure.by_domain[a].delta ? b : a);
    const pp = STATEMENTS.pressure_path;
    L.push(`| **Your page-vs-room gap** in ${DOMAINS[watch].name} | ${pp.where} | ${pp.produce} | ${pp.watch} |`);
  }
  L.push('');
  L.push(`**${STATEMENTS.lab_path_label}** ${STATEMENTS.lab_path[p.signature_family]}`);
  if (p.facets['lp.ethical_clarity'].unit < 0.40) {
    L.push('');
    L.push(`**Weighing Room flag.** ${STATEMENTS.ethics_gate}`);
  }
  L.push('');

  L.push(`## Who to work with`);
  L.push('');
  L.push(`Your lowest-scoring domain is ${DOMAINS[p.exposure_domain].name}. ${p.counterpart.intro}`);
  L.push('');
  L.push(`**On your next team:** ${p.counterpart.partner}`);
  L.push('');
  L.push(STATEMENTS.closing_line);
  L.push('');

  L.push('---');
  L.push('');
  L.push(STATEMENTS.footer);
  L.push('');
  L.push(`_Engine ${p.versions.engine} · items ${p.versions.item_bank} · statements ${p.versions.statements}_`);
  return L.join('\n');
}

module.exports = {
  VERSIONS, DOMAINS, DOMAIN_KEYS, BANDS, ALL_FACETS, FACET_RANGE, PAIRS,
  validateResponses, scoreSubmission, renderBrief,
  selectDepthPrompts, selectDepthPromptIds, round,
};
