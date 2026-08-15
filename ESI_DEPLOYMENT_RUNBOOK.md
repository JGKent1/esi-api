# ESI — Deployment Runbook

**Exceed Student Index v1.0 · 27 July 2026.** Modelled on `EEI_STAGING_DEPLOYMENT_RUNBOOK_2026-07-18.md`. Read it once through before you start; the order matters in two places.

---

## 0 · What you need

- A Postgres 14+ database. Supabase, Railway Postgres, or institutional Postgres all work — the app speaks plain SQL over `DATABASE_URL` and uses no vendor extensions beyond `pgcrypto`.
- A Node 22 host. Railway matches the EEI stack and the `Procfile` is already `web: node server.js`.
- A hostname you can put in front of students.
- Ten minutes.

---

## 1 · Local first — prove the engine before you provision anything

```bash
npm install
npm test                 # expect 34/34
npm run demo             # in-memory store, admin key "dev-admin-key"
```

Open `http://localhost:3000/esi_admin.html`, sign in with `dev-admin-key`, mint one link on the **Links** tab, open it in a private window, take the instrument, then release the Brief from the queue.

**Do not skip this.** It exercises the entire path — token mint, gate, scoring, review, release — with no infrastructure. If something is wrong, it is wrong here, where the feedback loop is two seconds.

---

## 2 · Database

```bash
export DATABASE_URL='postgresql://…'
npm run migrate                       # or: psql "$DATABASE_URL" -f migrations/2026-07-27_esi_schema.sql
```

The migration is idempotent — safe to re-run. It creates four tables, enables row-level security on all of them with **no permissive policy**, and adds two generated columns (`composite`, `pressure_overall`) so cohort queries do not re-parse JSON.

On Supabase, connect with the **pooled** connection string (port 6543) and use the service role. RLS with no policy means an anon or authenticated key reads nothing even if it leaks into a browser — the API does its own authorization.

Verify:
```sql
select table_name from information_schema.tables
 where table_name like 'esi_%' order by 1;
-- esi_access_tokens, esi_audit, esi_depth_responses, esi_submissions
```

---

## 3 · Environment

```
PORT=3000
APP_URL=https://esi.your-institution.edu     # must be the real origin — it builds the student links
CORS_ORIGIN=https://esi.your-institution.edu # do not leave blank in production
ESI_STORE=postgres
DATABASE_URL=postgresql://…
ADMIN_API_KEY=<long random string>
```

Generate the key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**`APP_URL` is the one that bites.** It is what the minted links point at. Set it wrong and you will hand fifty-five students a link to `localhost`, and because raw tokens are shown once you cannot regenerate the same links — you revoke and re-mint. Check it before your first mint, not after.

---

## 4 · Deploy

```bash
git push                # Railway builds from Procfile
curl -s https://esi.your-institution.edu/api/health | jq
```

Expect `{"ok":true,"store":"postgres","db":"ok",…}`. `ok:false` means the app is up and the database is not — check `DATABASE_URL` and network rules before anything else.

---

## 5 · Smoke test in production, with a throwaway student

Do this before you touch the real roster.

1. Mint one link for `student_ref: SMOKE-1`, cohort `SMOKETEST`, window `day0`.
2. Open it in a private window. Confirm the header shows the right name, cohort, and window.
3. Answer all 38. Confirm the progress bar completes and the review screen appears.
4. Submit. Confirm you get the three depth prompts and **not** a Brief.
5. In the console, confirm the submission is `pending_review` and the draft Brief renders with no `undefined` anywhere.
6. Release it. Confirm status flips and the audit row names *you*.
7. Re-open the student link. It must refuse with "already been used."
8. `GET /api/admin/esi/export/SMOKETEST.csv` and confirm one row.

Then delete the smoke rows:
```sql
delete from esi_submissions   where cohort = 'SMOKETEST';
delete from esi_access_tokens where cohort = 'SMOKETEST';
```

---

## 6 · Before a live sitting

- [ ] **Raise the rate limits** if students take it in one room. Fifty-five people behind one campus NAT share an IP, and the default is 20 submits per 15 minutes — the back half of the room will be refused. Raise `submit` to at least `roster × 2` for the window, or run it as homework.
- [ ] Mint the real roster on the **Links** tab and **copy the output immediately**. It is shown once.
- [ ] Send links individually. A shared link is a shared identity, and the first student to click it consumes it.
- [ ] Confirm `APP_URL` in one of the minted links by opening it yourself before distribution.
- [ ] Have the student instructions and the privacy notice out before anyone starts.

---

## 7 · Rollback

The app is stateless; roll the deploy back and the data is untouched. The schema is additive and has no destructive migration, so a rollback needs no database change.

If a *scoring* change turns out to be wrong: every submission stores its `versions`. Re-scoring is a deliberate act, not a repair — deploy the corrected engine, then re-score explicitly and record it. Never let two administrations be silently scored by different banks.

---

## 8 · Backup and retention

Released Briefs are educational records.

- Nightly `pg_dump` retained per the institution's schedule.
- Retention follows the institution's student-record policy. The API does not delete on its own.
- On a student's withdrawal or a records request, the row is identifiable by `student_ref` in all four tables; `on delete cascade` on `esi_depth_responses` and `esi_audit` means removing a submission takes its children.

---

## 9 · The three things that must stay true

1. **No automatic path to the student.** Every submission lands at `pending_review`. If someone proposes an auto-release for convenience, that is the whole safeguard and the answer is no.
2. **Coding vectors never reach the browser.** `/api/esi/instrument` strips them server-side. Do not "simplify" by serving the raw bank.
3. **The ESI never touches a grade.** Not through this API, not through the CSV export, not through a spreadsheet someone builds later. If the export ends up joined to a gradebook, the instrument is finished for that cohort.

---

## 10 · Known limitations at v1.0

- The Brief renders as markdown. There is no PDF path yet; the console shows the text and you can copy it.
- No email delivery. Release marks the record; you send it. That is deliberate for v1.0 — one fewer system holding student records.
- Bands and calibration constants are **provisional pending the Phase 1 pilot** (n ≥ 30). Do not describe the instrument as validated.
- `esi_statements.json` is at `0.1.0`. Every archetype and all 24 facets are authored, but the bank has not been read by a second pair of eyes. Do that before a live cohort.
