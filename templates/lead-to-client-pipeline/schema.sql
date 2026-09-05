-- Lead-to-client pipeline — schema for the DEDICATED `leads` database.
--
-- IMPORTANT: this must NOT live in n8n's own database (`n8n`). The chart's backup
-- CronJob runs `pg_dump --clean --if-exists` against that database; restoring it
-- would DROP these tables and roll the business back to the last backup.
--
-- Owned by the EXISTING `n8n_app` role on purpose: the isolation that matters is at
-- the DATABASE level (the backup dumps POSTGRES_DB=n8n and never sees this one), so a
-- second role would add a password, a Vault path and an ESO manifest for no extra
-- protection. In n8n, clone the Postgres credential and change only the database name.
-- ponytail: add a dedicated `leads_app` role only if blast-radius isolation is needed.
--
--   CREATE DATABASE leads OWNER n8n_app;
--   \c leads
--   CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
--   \i schema.sql

CREATE TABLE IF NOT EXISTS leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_norm       text,
  phone_norm       text,
  name             text NOT NULL,
  service_type     text,
  urgency          text NOT NULL DEFAULT 'normal',   -- 'urgent' | 'normal'

  -- Two ORTHOGONAL facets. A lead can be payment_pending AND consult_booked at
  -- the same time; a single `stage` enum cannot represent that and would make the
  -- transition guard reject a legitimate booking.
  commercial_stage text NOT NULL DEFAULT 'lead_in',
  calendar_stage   text NOT NULL DEFAULT 'none',

  consent_source   text,
  consent_at       timestamptz,

  first_touch_at   timestamptz,
  next_touch_at    timestamptz,
  touch_number     int  NOT NULL DEFAULT 0,
  stopped_at       timestamptz,
  stop_reason      text,                             -- 'replied'|'booked'|'unsubscribed'|'bounced'|'lost'

  purge_after      timestamptz NOT NULL DEFAULT now() + interval '13 months',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT leads_contactable CHECK (email_norm IS NOT NULL OR phone_norm IS NOT NULL)
);

-- Partial unique indexes: idempotency + dedupe, while still allowing phone-only leads.
CREATE UNIQUE INDEX IF NOT EXISTS leads_email_uq ON leads (email_norm) WHERE email_norm IS NOT NULL;

-- There is deliberately NO unique index on phone_norm. WF-A's upsert names only
-- (email_norm) as its ON CONFLICT target, so a second unique index cannot be caught
-- by it: a submission whose email is new but whose phone matches an existing row
-- raises unique_violation (23505), and because the upsert is one atomic CTE the whole
-- statement aborts -- no lead, no submission, no audit event, and the node throws.
-- Email is required by `Validate & Normalise` (a lead without one is unreachable and
-- is rejected), so email is the only dedupe key that can ever fire. A second unique
-- index bought nothing and could abort the write path.
-- ponytail: if phone-only leads ever become a real intake channel, add the index back
-- AND give the upsert a matching conflict target -- never one without the other.
DROP INDEX IF EXISTS leads_phone_uq;
CREATE INDEX IF NOT EXISTS leads_due_idx ON leads (next_touch_at) WHERE stopped_at IS NULL;

-- One row per form submission. The website's PD-YYMMDD-XXXX reference is the join key
-- to its Cloudflare KV record and MUST NOT live on `leads` — an upsert would clobber
-- the earlier reference when a prospect submits a second time.
CREATE TABLE IF NOT EXISTS submissions (
  ref          text PRIMARY KEY,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source       text, utm_source text, utm_medium text, utm_campaign text,
  entry_point  text, topic text,
  raw          jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS submissions_lead_idx ON submissions (lead_id);

-- Append-only. This is the audit trail, the POPIA consent record and the whole
-- reporting surface. Never UPDATE or DELETE a row here.
CREATE TABLE IF NOT EXISTS lead_events (
  id         bigserial PRIMARY KEY,
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  facet      text NOT NULL,                 -- 'commercial' | 'calendar' | 'system'
  from_stage text,
  to_stage   text NOT NULL,
  actor      text NOT NULL,                 -- 'system' | 'webhook' | 'human'
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_events_lead_idx ON lead_events (lead_id, created_at DESC);

-- Single-use, expiring tokens for stage transitions driven by a LINK CLICK (a GET
-- from a client's mail client). HMAC is not enough on its own for a GET: the URL
-- lands in browser history and edge logs, so each token is one-shot and expires.
CREATE TABLE IF NOT EXISTS stage_tokens (
  token      text PRIMARY KEY,
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  facet      text NOT NULL,
  to_stage   text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stage_tokens_lead_idx ON stage_tokens (lead_id);
