# ESI — Instructor Operating Guide

**Exceed Student Index v1.0 · 27 July 2026.** How to run the console across a term. Assumes the service is deployed (`ESI_DEPLOYMENT_RUNBOOK.md`) and you have the admin key.

---

## The console in one paragraph

Four tabs. **Links** mints single-use assessment links from a roster. **Review queue** is where every submission waits for you. **Cohort** pairs Day 0 against Week 15 and shows what moved. **Sign out** clears your key from the tab — it is never stored anywhere else.

---

## Term rhythm

| When | What you do | Minutes |
|---|---|---|
| Before Day 0 | Mint `day0` links for the roster. Distribute individually. | 10 |
| Day 0 + 2 days | Work the review queue. Read, release. | ~30 for 55 |
| Week 8 | Pull the cohort view. Read it alongside the midpoint coaching profiles. | 15 |
| Before Week 15 | Mint `wk15` links. Same roster, new window. | 10 |
| Week 15 + 2 days | Work the queue again. | ~30 |
| Week 16 | Cohort view for the term result. Export CSV for the norming file. | 15 |

Roughly two hours across a term.

---

## Minting links

Roster format, one per line:

```
12345678, A. Student, astudent@crimson.ua.edu
12345679, B. Student, bstudent@crimson.ua.edu
```

Only `student_ref` is required. Use the institutional ID rather than a name — it is what pairs Day 0 to Week 15, and names change.

**Copy the output the moment it appears.** Raw links are shown once and stored only as a hash. If you lose them, you revoke and re-mint; there is no recovery. This is the correct trade — a database leak does not hand anyone a working link.

Send links **individually**. A link is an identity: the first person to click a shared one consumes it, and the second person gets "already used."

---

## Working the review queue

Every submission lands at `pending_review`. Nothing reaches a student until you release it.

Open one and you get the profile summary, the domain table with composed / compressed / gap, the draft Brief in an editable box, the raw responses, any depth answers, and the audit trail.

**What to actually look at, in order.**

1. **The average gap.** This is the number the whole design is about. A wide positive gap means judgment that holds on the page and gives way in the room — which is the finding, not a problem with the student.
2. **The widest single domain gap.** Then read the Brief's line about it and ask whether it matches the student you know. When it does not, that is worth more than when it does.
3. **The Brief, whole.** Read it as the student will. You are checking one thing: would this land as useful, or as a verdict?
4. **The band.** Most entering students land in Developing. That is the design. If a cohort clusters in Foundational, suspect the instrument before the cohort — flag it and do not release until you have looked.

**Edit freely.** What you release is what the student sees, and the audit trail records that you edited. A generated sentence that is wrong about a particular student should be cut, not softened.

**Withhold** when a Brief should be delivered in conversation rather than in text. It records a reason. Use it — a withheld Brief and a five-minute conversation is better than a released Brief and a bad week.

---

## Reading the cohort view

Three numbers at the top: students, how many have both windows, and the mean change in the gap.

**A negative mean change is the good outcome.** It means composed and compressed judgment moved closer together across the term — the course did the thing it exists to do.

In the table, the last column is the one that matters. Watch for the pattern the whole design is built to catch: **composite up, gap unchanged.** That student got better on paper and no better in the room. It is invisible in any grade you assign and it is the most useful thing you will learn about them.

---

## The rules that are not yours to relax

**The ESI never touches a grade.** Not directly, not through the CSV, not through a spreadsheet someone builds in March. Completion may be graded; content may not. The instrument works only because students answer honestly, and nobody answers a diagnostic honestly when it is scoring them. If the export ends up joined to a gradebook, the instrument is finished for that cohort and the next one.

**No gatekeeping use.** Not for admission, selection, scholarship, placement, or discipline.

**Nothing clinical.** This measures leadership judgment. It is not a mental-health screen and the bands carry no clinical meaning. If a depth response raises a genuine welfare concern, that is a referral through your institution's normal channel — the instrument has nothing to say about it.

**Human release, always.** If someone proposes auto-release to save you thirty minutes, that thirty minutes *is* the safeguard.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every admin request 401 | Key has a trailing newline, or you are on the wrong deployment | Re-paste. Both sides are trimmed, so a genuine mismatch means a different key. |
| Student: "link not recognised" | Truncated paste — the part after `?t=` was cut | Re-send. Never re-mint before checking this. |
| Student: "already been used" | Second attempt, or a shared link | Revoke and mint a new one for that window. |
| Links point at `localhost` | `APP_URL` wrong at mint time | Fix `APP_URL`, re-mint. The old links cannot be repaired. |
| Back half of a proctored room refused | Rate limit — one campus IP | Raise the submit limit, or run it as homework. |
| Two students, identical Briefs | Their answers were genuinely similar | Not a bug. Determinism is the point; check the raw responses. |
| Cohort view shows no pairs | Different `student_ref` between windows | Mint Week 15 from the *same* roster file. |

---

## Before you release the first Brief of a term

- [ ] You have read one Brief end to end as a student would.
- [ ] `X-Admin-Actor` is your name, not "admin" — it is on the record permanently.
- [ ] The statement bank has been read by a second person. It is at `0.1.0`.
- [ ] Students have had the instructions and the privacy notice.
- [ ] You can say, out loud, why this does not affect their grade — because they will ask.
