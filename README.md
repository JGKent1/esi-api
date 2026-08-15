# ESI API — Exceed Student Index

Assessment delivery, deterministic scoring, and the instructor review console for
the Exceed Student Index v1.0.

    npm install
    npm run demo          # in-memory store, admin key "dev-admin-key", no database
    open http://localhost:3000/esi_admin.html

Production needs two things: a Postgres database and an admin key.

    cp .env.example .env          # fill in DATABASE_URL and ADMIN_API_KEY
    npm run migrate               # applies migrations/2026-07-27_esi_schema.sql
    npm start

## What is in here

| File | What it does |
|---|---|
| `esi_engine.js` | Deterministic scoring. No model call, no network, no clock, no randomness. |
| `esi_engine_data/esi_items_v1_0.json` | Instrument v1.0 — 38 items with coding vectors. **Core IP.** |
| `esi_engine_data/esi_statements.json` | Statement bank the Brief is assembled from. |
| `esi_engine_data/esi_depth_bank.json` | 16 narrative prompts. Interpretive only, never score-bearing. |
| `esi_tokens.js` | Single-use, roster-minted access tokens. Raw token never stored. |
| `store.js` | Postgres or in-memory, one interface. |
| `server.js` | The API and the release gate. |
| `public/esi_assessment.html` | The student instrument. |
| `public/esi_admin.html` | The instructor console. |
| `migrations/` | Idempotent schema. |
| `tests/` | 34 tests. `npm test`. No database required. |

## Three rules the code enforces

1. **The Brief never reaches a student automatically.** Every submission lands at
   `pending_review`. An instructor releases it. There is no other path.
2. **Coding vectors never reach the browser.** `/api/esi/instrument` strips every
   facet and tendency vector server-side. A contract test asserts this.
3. **Depth responses are interpretive only.** Nothing written there can change a score.

## Documentation

`ESI_API_SPEC.md` · `ESI_DEPLOYMENT_RUNBOOK.md` · `ESI_ADMIN_OPERATING_GUIDE.md`
