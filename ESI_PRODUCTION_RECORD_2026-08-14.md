# ESI Platform — Production Deployment Record

**14–15 Aug 2026.** The ESI (Exceed Student Index) v1.0 API went from "code complete,
never deployed" to live in production, mirroring the EXCEED Exec stack.

## Live system

| Piece | Value |
|---|---|
| App URL | https://esi-web-production-0853.up.railway.app |
| Instructor console | https://esi-web-production-0853.up.railway.app/esi_admin.html |
| Health check | https://esi-web-production-0853.up.railway.app/api/health |
| GitHub repo | JGKent1/esi-api, branch `main` (Railway auto-deploys every push) |
| Railway project | `esi-api` (6b5270fb-…), service **esi-web** (72878c2a-…), env `production` |
| Supabase project | `esi-api` (ref `bdhvwipgswdgbycieonh`), us-east-2, $10/month |
| DB role | `esi_app` — RLS policies grant it full access; anon/authenticated read nothing |
| Admin key | In Railway → esi-web → Variables → `ADMIN_API_KEY` |
| Healthcheck | `/api/health`, restart ON_FAILURE ×3 |

Environment on the service: `ESI_STORE=postgres`, `DATABASE_URL`
(Supabase **aws-0** pooled connection, port 6543, user `esi_app.bdhvwipgswdgbycieonh`),
`ADMIN_API_KEY`, `APP_URL`, `CORS_ORIGIN`, `PG_POOL_MAX=10`, `NODE_ENV=production`.

## Bugs found and fixed during deployment

1. **`window` is a reserved word in Postgres.** The schema migration and three SQL
   statements in `store.js` used it unquoted; both failed on first contact with a real
   database. The in-memory store used by all 48 tests never exercised these paths. Fixed by
   quoting `"window"` everywhere; fix is in the repo and the applied migration.
2. **Supabase pooler host is `aws-0-us-east-2`, not `aws-1`.** The aws-1 pooler returns
   "tenant/user not found" for this project. Recorded here because the dashboards show both.

## Deployment friction worth remembering

- A Railway service created while its GitHub repo is invisible (not yet pushed, or not
  granted to the Railway GitHub app) never recovers its webhook — deploy triggers report
  "triggered" and silently do nothing, and `list-deployments` stays empty. The fix is to
  create the service again *after* the repo has commits and the app has access.
- Four orphaned Railway services were created while diagnosing this: `esi-api`,
  `esi-api-web`, `esi-api-prod`, `esi` (plus the unused domain
  esi-api-production-9b77.up.railway.app on the first). **Delete them in the Railway
  dashboard** — only **esi-web** is real. They have no deployments and cost nothing, but
  they clutter the project.
- The one-time `push_to_github.sh` initially ran in a directory that was already a git
  repo, so the push went to that repo's remote and `esi-api` stayed empty on GitHub. The
  script now lives in `esi-api/` and must be run from there.

## Runbook §5 smoke test — PASSED, 15 Aug 2026

Executed end-to-end against production (driven via pg_net from the Supabase database, since
the throwaway student needed no browser). Every step verified:

| Step | Result |
|---|---|
| Mint SMOKE-1 / SMOKETEST / day0 | 201, link points at correct APP_URL |
| Token gate check | 200, correct identity |
| Instrument fetch | 200 · 22 SJ + 16 behavioral · **no facets/tendencies/reverse in body** |
| Submit all 38 | 201 `pending_review`, 3 depth prompts, **no profile or Brief in response** |
| Database state | composite 60.6 · pressure −15 · 4,600-char draft Brief, no "undefined" · token consumed · versions recorded |
| Release (X-Admin-Actor) | 200 → `released`; audit rows: submitted/student, released/"GK (smoke test)" |
| Re-open spent link | 410 `used` |
| Double release | 409 `already released` (non-idempotent by design) |
| CSV export | 200, one row, all five domains + band + signature pair |
| Purge | All SMOKETEST rows deleted; cascade removed audit + depth |

All three invariants held in production. Remaining data note: one unused token exists for
`student_ref 123466`, cohort `CJ290`, minted by hand from the console — revoke it before
the real Day 0 mint if it was a test, or that student_ref cannot be re-issued for
CJ290/day0 (one-live-token rule).

## Day 0 (Thu Aug 20) operational sequence

1. Smoke test §5 end to end (open item above).
2. Statement bank second read (`esi_statements.json` is v0.1.0, single-authored).
3. Raise the submit rate limit if the cohort sits behind one campus NAT (default 20/15min).
4. Mint the real roster on the Links tab — copy output immediately, links are shown once.
5. Confirm `APP_URL` inside one minted link by opening it yourself before distribution.
6. Distribute individually, with the student instructions and privacy notice.

## The three invariants (unchanged, enforced in code)

1. No Brief reaches a student without instructor release — everything lands `pending_review`.
2. Coding vectors never reach the browser — `/api/esi/instrument` strips them server-side.
3. The ESI never touches a grade — not via API, export, or any later join to a gradebook.
