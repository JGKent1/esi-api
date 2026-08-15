# Running the ESI with no installation

`server_local.js` is a complete, zero-dependency version of the service. It needs
**Node 18 or newer and nothing else** — no `npm install`, no registry access, no
database. Use it for a demo, a classroom laptop, or any machine where you cannot
reach the npm registry.

## Start it

    cd esi-api
    ADMIN_API_KEY=dev-admin-key node server_local.js

Then open **http://localhost:3000/esi_admin.html** and sign in with `dev-admin-key`.

Pick a different port with `PORT=8080`. Stop it with Ctrl-C.

## Take it for a full lap, in four minutes

1. **Links** tab. Cohort `CJ490-F26`, window `Day 0`. Paste a roster line:

       12345678, A. Student, astudent@crimson.ua.edu

   Click **Mint links** and copy the URL it gives you.
2. Open that URL in a **private window** — that is the student's view.
3. Answer the 38 questions. Submit.
4. Back in the console, **Review queue** → click the row → read the Brief → **Release to student**.

That is the entire loop: mint, take, score, review, release.

## What is different from the full server

| | `server_local.js` | `server.js` |
|---|---|---|
| Dependencies | none | express, cors, dotenv, express-rate-limit, pg |
| Storage | in-memory by default | Postgres |
| Data survives restart | **no** | yes |
| Routes and behaviour | identical | identical |

Both are covered by contract tests asserting the same rules — the release gate,
single-use tokens, and coding vectors never reaching the browser.

    node --test tests/local.test.js     # 14 tests, no install needed

**In-memory means exactly that.** Every token, submission, and Brief is gone when
you stop the process. That is correct for a demo and wrong for a cohort. For real
students, point it at Postgres:

    npm install                 # needs registry access
    npm run migrate
    npm start

## If something does not work

| Symptom | Fix |
|---|---|
| Admin routes return 503 | `ADMIN_API_KEY` is not set. It is in the start command above. |
| `EADDRINUSE` | Something else is on the port. `PORT=8080 node server_local.js` |
| Minted links point at the wrong host | Set `APP_URL=http://localhost:3000` before starting. |
| Everything vanished after a restart | Working as designed — memory store. See above. |
