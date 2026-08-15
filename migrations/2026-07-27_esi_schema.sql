-- ESI schema — Exceed Student Index v1.0
-- Postgres 14+. Idempotent: safe to run more than once.
-- Apply against Supabase, Railway Postgres, or a local instance.
--
--   psql "$DATABASE_URL" -f migrations/2026-07-27_esi_schema.sql

create extension if not exists pgcrypto;

-- ─── access tokens ───────────────────────────────────────────────────────────
-- One row per administration per student. The raw token is never stored.
create table if not exists esi_access_tokens (
  id            uuid primary key default gen_random_uuid(),
  token_hash    text        not null unique,
  student_ref   text        not null,
  full_name     text,
  email         text,
  cohort        text        not null,
  "window"      text        not null check ("window" in ('day0','wk15')),
  expires_at    timestamptz,
  used_at       timestamptz,
  submission_id uuid,
  created_at    timestamptz not null default now(),
  created_by    text
);
create index if not exists esi_tokens_cohort_idx  on esi_access_tokens (cohort, "window");
create index if not exists esi_tokens_student_idx on esi_access_tokens (student_ref);

-- A student gets exactly one live token per window. Re-issuing requires
-- revoking the old row, which is deliberate — silent re-issue would let a
-- student retake the instrument and quietly overwrite their own baseline.
create unique index if not exists esi_tokens_one_per_window
  on esi_access_tokens (student_ref, cohort, "window");

-- ─── submissions ─────────────────────────────────────────────────────────────
-- status: pending_review → released | withheld | void
-- Nothing reaches a student from pending_review without a human release.
create table if not exists esi_submissions (
  id           uuid primary key default gen_random_uuid(),
  student_ref  text        not null,
  full_name    text,
  email        text,
  cohort       text        not null,
  "window"     text        not null check ("window" in ('day0','wk15')),
  status       text        not null default 'pending_review'
                 check (status in ('pending_review','released','withheld','void')),
  responses    jsonb       not null,
  profile      jsonb       not null,
  report_text  text,
  versions     jsonb       not null,
  created_at   timestamptz not null default now(),
  released_at  timestamptz,
  released_by  text
);
create index if not exists esi_sub_cohort_idx  on esi_submissions (cohort, "window", status);
create index if not exists esi_sub_student_idx on esi_submissions (student_ref);
create index if not exists esi_sub_status_idx  on esi_submissions (status, created_at desc);

-- Generated columns make the cohort view and any SQL analysis cheap without
-- re-parsing jsonb in every query.
alter table esi_submissions
  add column if not exists composite numeric
    generated always as (((profile->>'composite'))::numeric) stored;
alter table esi_submissions
  add column if not exists pressure_overall numeric
    generated always as (((profile->'pressure'->>'overall'))::numeric) stored;

-- ─── depth module ────────────────────────────────────────────────────────────
-- Interpretive only. Nothing here ever feeds a score. Enforced in code, and
-- recorded here so the constraint is visible to anyone reading the schema.
create table if not exists esi_depth_responses (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid        not null references esi_submissions(id) on delete cascade,
  prompt_id     text        not null,
  body          text        not null,
  created_at    timestamptz not null default now()
);
create index if not exists esi_depth_sub_idx on esi_depth_responses (submission_id);
comment on table esi_depth_responses is
  'Depth-module narrative responses. INTERPRETIVE ONLY — never score-bearing (DEC-0008 §3).';

-- ─── audit ───────────────────────────────────────────────────────────────────
-- Who released what, when, and whether they edited it first. An educational
-- record needs a trail.
create table if not exists esi_audit (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid        references esi_submissions(id) on delete cascade,
  actor         text        not null,
  action        text        not null,
  detail        text,
  created_at    timestamptz not null default now()
);
create index if not exists esi_audit_sub_idx on esi_audit (submission_id, created_at);

-- ─── row level security ──────────────────────────────────────────────────────
-- The API connects with a privileged role and does its own authorization, so
-- RLS is enabled with no permissive policy: nothing is readable by anon or
-- authenticated roles even if a key leaks into a browser.
alter table esi_access_tokens   enable row level security;
alter table esi_submissions     enable row level security;
alter table esi_depth_responses enable row level security;
alter table esi_audit           enable row level security;

comment on table esi_submissions is
  'ESI submissions. A released Brief is an educational record — handle under the institution''s student-record policy. Never used for grading, admission, selection, or discipline.';
