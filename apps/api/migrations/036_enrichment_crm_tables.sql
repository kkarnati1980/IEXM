-- 036_enrichment_crm_tables.sql
-- Migration: Enrichment worker + CRM adapter infrastructure  (Batch 4)
--
-- Creates / ensures:
--   enrichment_requests   — EN-01: job lifecycle tracking (spec §10.1)
--   enrichment_results    — EN-01: persisted enrichment output (spec §10.2)
--   crm_connections       — AC-10: CRM provider connections (spec §13.1)
--   crm_sync_jobs         — AC-10: CRM push history (spec §13.2)
--
-- Place at: apps/api/migrations/036_enrichment_crm_tables.sql
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── enrichment_requests ───────────────────────────────────────────────────────
-- EN-01: Track enrichment job lifecycle per interaction.
-- Worker claims rows with status='queued', processes, marks succeeded/failed.

CREATE TABLE IF NOT EXISTS enrichment_requests (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT         NOT NULL,
  interaction_id  TEXT         NOT NULL,
  provider        TEXT         NOT NULL DEFAULT 'apollo'
                    CHECK (provider IN ('apollo','clearbit','hubspot_breeze','clay','manual')),
  status          TEXT         NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','running','succeeded','failed','skipped')),
  attempt_count   INTEGER      NOT NULL DEFAULT 0,
  error_message   TEXT         NULL,
  started_at      TIMESTAMPTZ  NULL,
  completed_at    TIMESTAMPTZ  NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Worker queue: unclaimed queued requests first
CREATE INDEX IF NOT EXISTS idx_enrichment_requests_queue
  ON enrichment_requests (tenant_id, status, created_at ASC)
  WHERE status = 'queued';

-- Lookup by interaction
CREATE INDEX IF NOT EXISTS idx_enrichment_requests_interaction
  ON enrichment_requests (tenant_id, interaction_id);

-- Retry eligibility: failed requests with fewer than 3 attempts
CREATE INDEX IF NOT EXISTS idx_enrichment_requests_retry
  ON enrichment_requests (tenant_id, status, attempt_count)
  WHERE status = 'failed' AND attempt_count < 3;

COMMENT ON TABLE  enrichment_requests              IS 'Async enrichment job queue. Never sits in the tap critical path. Spec §EN-01.';
COMMENT ON COLUMN enrichment_requests.attempt_count IS 'Incremented on each failed attempt. Worker retries up to 3 times then marks terminal failure.';
COMMENT ON COLUMN enrichment_requests.provider      IS 'Primary provider is apollo. Waterfall continues to clearbit if apollo returns no result.';


-- ── enrichment_results ────────────────────────────────────────────────────────
-- EN-01: Persisted enrichment output from successful provider calls.

CREATE TABLE IF NOT EXISTS enrichment_results (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT         NOT NULL,
  interaction_id   TEXT         NOT NULL,
  provider         TEXT         NOT NULL,
  company_id       TEXT         NULL,  -- FK to companies omitted: companies table not yet created
  title            TEXT         NULL,
  summary          TEXT         NULL,
  confidence_score NUMERIC(4,3) NULL CHECK (confidence_score BETWEEN 0 AND 1),
  raw_payload      JSONB        NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  -- One result per (interaction, provider)
  UNIQUE (interaction_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_enrichment_results_interaction
  ON enrichment_results (tenant_id, interaction_id);

COMMENT ON TABLE  enrichment_results                  IS 'Persisted enrichment output from Apollo/Clearbit. Spec §EN-01. If missing, interaction remains valid with basic profile.';
COMMENT ON COLUMN enrichment_results.confidence_score IS '0.0–1.0 provider-reported confidence. Used to surface enrichment quality in vendor lead detail.';
COMMENT ON COLUMN enrichment_results.raw_payload      IS 'Sanitised provider JSON. Never includes contact PII beyond what consent allows.';


-- ── crm_connections ───────────────────────────────────────────────────────────
-- AC-10: Configured CRM provider connections per tenant/organisation.

CREATE TABLE IF NOT EXISTS crm_connections (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT         NOT NULL,
  organization_id  TEXT         NULL,
  event_id         TEXT         NULL,   -- optional: scoped to a specific event
  provider         TEXT         NOT NULL
                     CHECK (provider IN ('salesforce','hubspot','zoho','pilot')),
  config           JSONB        NOT NULL DEFAULT '{}'::JSONB,
                   -- Stores: tokens (NEVER returned in API), instance_url, etc.
                   -- OAuth tokens are stored encrypted in production.
  field_map        JSONB        NOT NULL DEFAULT '{}'::JSONB,
                   -- Maps CRM field names to interaction/attendee field names.
  status           TEXT         NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','inactive','pending_oauth','error','revoked')),
  last_sync_at     TIMESTAMPTZ  NULL,
  last_error       TEXT         NULL,
  sync_count       INTEGER      NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_crm_connections_tenant
  ON crm_connections (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_crm_connections_org
  ON crm_connections (tenant_id, organization_id)
  WHERE organization_id IS NOT NULL;

COMMENT ON TABLE  crm_connections         IS 'Configured CRM provider connections. Spec §AC-10 and §13.1.';
COMMENT ON COLUMN crm_connections.config  IS 'OAuth tokens and provider config. Tokens must be encrypted at rest in production. Never returned in API responses.';
COMMENT ON COLUMN crm_connections.field_map IS 'Maps platform field names (display_name, email, etc.) to CRM-specific field names per provider.';


-- ── crm_sync_jobs ─────────────────────────────────────────────────────────────
-- AC-10: Queue and history of CRM push jobs.
-- Critical rule (spec §9.2): consent MUST be re-checked at execution time, not only at request time.

CREATE TABLE IF NOT EXISTS crm_sync_jobs (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT         NOT NULL,
  interaction_id   TEXT         NOT NULL,
  connection_id    UUID         NULL REFERENCES crm_connections(id) ON DELETE SET NULL,
  provider         TEXT         NOT NULL,
  target_object    TEXT         NOT NULL DEFAULT 'lead'
                     CHECK (target_object IN ('lead','contact','opportunity')),
  status           TEXT         NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','running','succeeded','failed','consent_blocked','policy_blocked')),
  external_record_id TEXT       NULL,   -- ID returned by CRM provider after successful push
  last_error       TEXT         NULL,
  attempt_count    INTEGER      NOT NULL DEFAULT 0,
  -- Consent re-check result at execution time (spec §9.2 hard rule)
  consent_verified_at TIMESTAMPTZ NULL,
  consent_valid    BOOLEAN      NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Worker queue
CREATE INDEX IF NOT EXISTS idx_crm_sync_jobs_queue
  ON crm_sync_jobs (tenant_id, status, created_at ASC)
  WHERE status = 'queued';

-- Per-interaction CRM state (vendor lead detail)
CREATE INDEX IF NOT EXISTS idx_crm_sync_jobs_interaction
  ON crm_sync_jobs (tenant_id, interaction_id, status);

-- Successful pushes (vendor metrics: CRM pushed count)
CREATE INDEX IF NOT EXISTS idx_crm_sync_jobs_succeeded
  ON crm_sync_jobs (tenant_id, interaction_id)
  WHERE status = 'succeeded';

COMMENT ON TABLE  crm_sync_jobs                     IS 'CRM push job queue and history. Spec §AC-10, §13.2.';
COMMENT ON COLUMN crm_sync_jobs.consent_valid        IS 'Result of consent re-check at execution time. Push must be blocked if false. Spec §9.2 hard rule.';
COMMENT ON COLUMN crm_sync_jobs.external_record_id   IS 'ID returned by CRM after successful push. Used for deduplication and audit.';
COMMENT ON COLUMN crm_sync_jobs.status               IS 'consent_blocked = blocked at execution due to consent re-check failure. policy_blocked = event policy blocked the push.';


-- ── Seed pilot CRM connection for demo tenant ─────────────────────────────────
INSERT INTO crm_connections (tenant_id, organization_id, provider, config, field_map, status)
VALUES (
  'tenant-demo',
  'org-demo',
  'pilot',
  '{"adapter":"pilot","test_mode":true}',
  '{"LastName":"display_name","Email":"email","Company":"company_name","Title":"title"}',
  'active'
)
ON CONFLICT DO NOTHING;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback:
-- ─────────────────────────────────────────────────────────────────────────────
--   BEGIN;
--   DROP TABLE IF EXISTS crm_sync_jobs;
--   DROP TABLE IF EXISTS crm_connections;
--   DROP TABLE IF EXISTS enrichment_results;
--   DROP TABLE IF EXISTS enrichment_requests;
--   COMMIT;
--
