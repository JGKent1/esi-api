# ESI API — Specification

**Exceed Student Index v1.0 · 27 July 2026.** Companion to `ESI_DEPLOYMENT_RUNBOOK.md` and `ESI_ADMIN_OPERATING_GUIDE.md`. Scoring model: `../../01_Canonical_Documentation/ESI_Scoring_and_Norms.md`.

Base URL is your deployment origin. All bodies are JSON.

---

## Authentication

| Surface | Auth |
|---|---|
| `/api/health`, `/api/esi/instrument` | none |
| `/api/esi/token`, `/api/esi/submit`, `/api/esi/depth` | the student's single-use token, in the body or query |
| `/api/admin/esi/*` | `Authorization: Bearer <ADMIN_API_KEY>` |

Admin requests should also send `X-Admin-Actor: <your name>`. It is recorded on every release and appears in the audit trail; a release attributed to "admin" is worth nothing six months later.

Key comparison is constant-time and **both sides are trimmed**. A key pasted from a hosting dashboard routinely carries a trailing newline; trimming only the header made the lengths differ, the compare short-circuited, and every request returned 401 — indistinguishable from a wrong key. That bug is fixed here and the fix is load-bearing.

---

## Public endpoints

### `GET /api/health`
```json
{ "ok": true, "store": "postgres", "db": "ok",
  "versions": { "engine": "esi_engine@1.0.0", "item_bank": "esi_items_v1_0",
                "statements": "esi_statements@0.1.0", "depth_bank": "esi_depth_v1_0" } }
```
Use for uptime checks. `ok:false` means the database is unreachable.

### `GET /api/esi/instrument`
Returns the 38 items **with every scoring vector stripped**.

```json
{ "instrument": "ESI Instrument v1.0 — …",
  "versions": { … },
  "sjs": [ { "id": "S01", "condition": null, "context": "You are president of…",
             "options": { "A": "Map how the org actually works…", "B": "…", "C": "…", "D": "…" } } ],
  "behavioral": [ { "id": "B01", "text": "In the last month I have asked…" } ] }
```

The facet and tendency vectors are Core IP and are removed server-side, not hidden client-side. A contract test asserts that the response body contains neither `facets` nor `tendencies` nor `reverse`. Do not "optimize" this by shipping the raw bank to the browser.

### `GET /api/esi/token?t=<raw>`
Checks a link before rendering the instrument, so a spent token costs a student a message rather than twenty-four minutes.

`200` → `{ ok, student_ref, full_name, cohort, window }`
`410` → `{ ok:false, reason }` where reason is `missing` · `unknown` · `used` · `expired`

### `POST /api/esi/submit`
```json
{ "t": "<raw token>", "responses": { "S01":"B", …, "B16": 4 } }
```
All 22 scenario answers (a letter) and all 16 behavioral answers (an integer 1–5) are required.

**Order of operations matters and is deliberate:** the payload is validated *before* the token is consumed. A malformed submission must not cost a student their single-use link.

`201` →
```json
{ "ok": true, "submission_id": "uuid", "status": "pending_review",
  "depth_prompts": [ { "id":"S-01", "text":"…" }, … ],
  "message": "Submitted. Your instructor reviews and releases your Brief." }
```

The student receives the depth prompts and a confirmation. They receive **neither the profile nor the Brief**. That is the release gate, and it is asserted by test.

`400` invalid responses (token untouched) · `410` token not usable · `409` token consumed by a concurrent request

### `POST /api/esi/depth`
```json
{ "submission_id": "uuid", "prompt_id": "S-01", "body": "…" }
```
Rejected with `400` unless `prompt_id` is one of the three the profile actually offered. Stored responses are **interpretive only and never score-bearing** (DEC-0008 §3); a test asserts that adding depth responses leaves the stored profile byte-identical.

---

## Admin endpoints

All under `/api/admin/esi`, all Bearer-authenticated.

### `GET /whoami`
`{ ok, actor, store }`. Use it to validate a key without side effects.

### `POST /tokens`
```json
{ "cohort": "CJ490-F26", "window": "day0", "days": 30,
  "roster": [ { "student_ref": "12345678", "full_name": "A. Student", "email": "a@…" } ] }
```
`window` is `day0` or `wk15`. Returns `201` with one entry per roster row:

```json
{ "ok": true, "count": 55,
  "tokens": [ { "id":"…", "token":"<raw>", "student_ref":"12345678", "window":"day0",
                "url":"https://…/esi_assessment.html?t=<raw>" } ],
  "warning": "These raw links are shown once…" }
```

**The raw links appear exactly once.** Only `sha256(raw)` is stored, so a lost link cannot be recovered — revoke and re-mint instead. That is the correct trade: a database leak does not hand anyone a working assessment link.

A unique index enforces one live token per `(student_ref, cohort, window)`. Re-issuing requires revoking the old row, deliberately — a silent re-issue would let a student retake the instrument and quietly overwrite their own baseline.

### `GET /tokens?cohort=…`
Issued tokens with `used_at`. **Never returns `token_hash`** (asserted by test).

### `GET /submissions?status=&cohort=&window=`
Queue rows: `id, student_ref, full_name, cohort, window, status, created_at, composite, band, pressure_overall, signature_pair`.

### `GET /submissions/:id`
Everything: parsed `responses`, full `profile`, `report_text`, `versions`, `depth[]`, `audit[]`.

### `POST /submissions/:id/release`
```json
{ "report_text": "…optional edited Brief…" }
```
Sets `released`, stamps `released_at` and `released_by` from `X-Admin-Actor`, and writes an audit row recording whether the text was edited before release. `409` if already released — release is not idempotent, on purpose.

### `POST /submissions/:id/withhold`
`{ "reason": "…" }` → status `withheld`, reason in the audit trail.

### `GET /cohort/:cohort`
Pairs Day 0 with Week 15 per student and returns the number the term is actually about:

```json
{ "cohort":"CJ490-F26", "n":55, "n_paired":52,
  "mean_pressure_delta_change": -6.4,
  "note": "A negative pressure_delta_change is the good outcome…",
  "students":[ { "student_ref":"…", "day0":{…}, "wk15":{…},
                 "composite_change": 4.2, "pressure_delta_change": -8.1 } ] }
```

**Negative `pressure_delta_change` is the good outcome**: the gap between composed and compressed judgment got smaller.

### `GET /export/:cohort.csv`
One row per submission: `student_ref, full_name, window, status, created_at, composite, band, LS, LT, LC, LP, LF, pressure_overall, signature_pair`. This is the norming export.

---

## State machine

```
        submit                    release
  —————————————————→ pending_review ————————→ released
                          │
                          └──────────────────→ withheld
```
`void` exists for one case only: a submission stored, then losing the token-consume race. There is no automatic transition to the student from any state.

---

## Determinism

Same responses in → byte-identical profile and Brief out. No model call, no network, no clock, no randomness in the scoring path. Every submission stores the engine, item-bank, statement-bank and depth-bank versions, so a Week 15 result can be compared to a Day 0 result with the versions on the record.

**If you change the item bank or the statement bank, bump the version.** Comparing two administrations scored by different banks is the one way to make this instrument lie.

## Rate limits

`submit` 20 / 15 min · `depth` 30 / 15 min · `token` 60 / 15 min · `instrument` 120 / 15 min, per IP. A fifty-student lab in one room shares an IP — raise these before a proctored sitting or the last students in the room will be refused.
