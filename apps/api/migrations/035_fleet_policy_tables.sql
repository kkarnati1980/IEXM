-- 035_fleet_policy_tables.sql
-- Migration: Fleet, Policy, Audit, and Attendee DSR infrastructure  (Batch 3)
--
-- Creates / ensures:
--   event_data_policies       — DC-01 six-switch event governance (§5.6)
--   audit_log                 — AU-01 sensitive action audit trail (§5.6)
--   data_subject_requests     — AT-01 GDPR/privacy DSR workflow (§Privacy)
--   consent_events            — AT-01 consent change history timeline
--   export_worker_queue       — EX-01 background export job queue
--   device_incidents (extend) — HB-01 missing columns if not present
--
-- Place at: apps/api/migrations/035_fleet_policy_tables.sql
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── event_data_policies ───────────────────────────────────────────────────────
-- DC-01: Six organizer-controlled governance switches per event.

CREATE TABLE IF NOT EXISTS event_data_policies (
  event_id                         TEXT         PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  tenant_id                        TEXT         NOT NULL,
  vendor_exports_enabled           BOOLEAN      NOT NULL DEFAULT TRUE,
  sponsor_pii_enabled              BOOLEAN      NOT NULL DEFAULT FALSE,
  require_export_approval          BOOLEAN      NOT NULL DEFAULT FALSE,
  allow_crm_push                   BOOLEAN      NOT NULL DEFAULT TRUE,
  retention_days                   INTEGER      NOT NULL DEFAULT 90
                                     CHECK (retention_days BETWEEN 1 AND 730),
  allow_cross_event_identity_graph BOOLEAN      NOT NULL DEFAULT FALSE,
  updated_at                       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_data_policies_tenant
  ON event_data_policies (tenant_id);

COMMENT ON TABLE  event_data_policies IS 'Per-event organizer governance switches. Spec §DC-01.';
COMMENT ON COLUMN event_data_policies.require_export_approval IS 'When TRUE every export request requires organizer approval before generation.';
COMMENT ON COLUMN event_data_policies.sponsor_pii_enabled     IS 'When FALSE sponsors see aggregate-only metrics with no raw PII.';
COMMENT ON COLUMN event_data_policies.retention_days          IS 'Days until interaction PII is auto-anonymised by the retention worker.';


-- ── audit_log ─────────────────────────────────────────────────────────────────
-- AU-01: Immutable log of every sensitive platform action.

CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL     PRIMARY KEY,
  tenant_id    TEXT          NOT NULL,
  event_id     TEXT          NULL,
  action_type  TEXT          NOT NULL,  -- consent, export, crm_push, policy_change, freeze, break_glass, …
  actor_id     TEXT          NULL,      -- user_id or device_id
  actor_type   TEXT          NULL,      -- user | device | system
  target_id    TEXT          NULL,      -- resource affected (interaction_id, export_id, …)
  payload      JSONB         NULL,      -- sanitised context (no raw PII)
  result       TEXT          NOT NULL DEFAULT 'success'
                               CHECK (result IN ('success','failure','partial')),
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Tenant + event lookup (most dashboard queries)
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_event
  ON audit_log (tenant_id, event_id, created_at DESC);

-- Action type filter
CREATE INDEX IF NOT EXISTS idx_audit_log_action_type
  ON audit_log (tenant_id, event_id, action_type, created_at DESC);

-- Actor lookup
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log (tenant_id, actor_id, created_at DESC);

COMMENT ON TABLE  audit_log             IS 'Immutable sensitive-action audit trail. Spec §AU-01.';
COMMENT ON COLUMN audit_log.action_type IS 'Enumerated action category — consent, export_approved, export_rejected, crm_push, policy_change, event_frozen, break_glass, etc.';
COMMENT ON COLUMN audit_log.payload     IS 'Sanitised JSON context. Must never contain raw PII — IDs and metadata only.';


-- ── data_subject_requests ─────────────────────────────────────────────────────
-- AT-01 / Privacy: GDPR data subject right workflows (export, delete, access).

CREATE TABLE IF NOT EXISTS data_subject_requests (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT         NOT NULL,
  attendee_id     TEXT         NOT NULL,
  event_id        TEXT         NULL,
  request_type    TEXT         NOT NULL
                    CHECK (request_type IN ('export','delete','access','portability')),
  status          TEXT         NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','processing','completed','rejected','failed')),
  rejection_reason TEXT        NULL,
  completed_at    TIMESTAMPTZ  NULL,
  download_url    TEXT         NULL,      -- signed expiring URL when export is ready
  download_expires_at TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dsr_attendee
  ON data_subject_requests (tenant_id, attendee_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dsr_status
  ON data_subject_requests (tenant_id, status)
  WHERE status IN ('requested','processing');

COMMENT ON TABLE  data_subject_requests IS 'GDPR/privacy data subject right workflows. Spec §AT-01 and Privacy appendix.';
COMMENT ON COLUMN data_subject_requests.download_url IS 'Signed, expiring download URL generated when export status = completed.';


-- ── consent_events ────────────────────────────────────────────────────────────
-- AT-01: Append-only consent change history for compliance and realtime inbox.

CREATE TABLE IF NOT EXISTS consent_events (
  id              BIGSERIAL    PRIMARY KEY,
  tenant_id       TEXT         NOT NULL,
  interaction_id  TEXT         NOT NULL,
  event_type      TEXT         NOT NULL  -- consent_captured | consent_revoked | consent_updated
                    CHECK (event_type IN ('consent_captured','consent_revoked','consent_updated')),
  vendor_allowed  BOOLEAN      NOT NULL DEFAULT FALSE,
  sponsor_allowed BOOLEAN      NOT NULL DEFAULT FALSE,
  locale          TEXT         NULL,
  user_agent      TEXT         NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_events_interaction
  ON consent_events (tenant_id, interaction_id, created_at DESC);

COMMENT ON TABLE consent_events IS 'Append-only consent change history. Used for compliance audit and realtime vendor inbox refresh. Spec §AT-01.';


-- ── export_worker_queue ───────────────────────────────────────────────────────
-- EX-01: Simple work-queue for export generation after approval.

CREATE TABLE IF NOT EXISTS export_worker_queue (
  export_id     TEXT         PRIMARY KEY,
  queued_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  claimed_at    TIMESTAMPTZ  NULL,
  worker_id     TEXT         NULL,
  attempts      INTEGER      NOT NULL DEFAULT 0
);

COMMENT ON TABLE export_worker_queue IS 'Work queue for export generation jobs. Worker claims rows, generates file, updates exports.status. Spec §EX-01.';


-- ── Extend device_incidents if tenant_id column missing ──────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='device_incidents' AND column_name='tenant_id'
  ) THEN
    ALTER TABLE device_incidents ADD COLUMN tenant_id TEXT;
  END IF;
END $$;


-- ── Extend consents table with locale / user_agent if missing ────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='consents' AND column_name='locale'
  ) THEN
    ALTER TABLE consents ADD COLUMN locale TEXT;
    ALTER TABLE consents ADD COLUMN user_agent TEXT;
    ALTER TABLE consents ADD COLUMN revoked_at TIMESTAMPTZ;
  END IF;
END $$;

-- Add event_id to consents if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='consents' AND column_name='event_id'
  ) THEN
    ALTER TABLE consents ADD COLUMN event_id TEXT;
  END IF;
END $$;


-- ── Seed: default data policies for existing events ──────────────────────────
INSERT INTO event_data_policies (event_id, tenant_id)
SELECT id, tenant_id FROM events
WHERE NOT EXISTS (
  SELECT 1 FROM event_data_policies edp WHERE edp.event_id = events.id
)
ON CONFLICT DO NOTHING;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback:
-- ─────────────────────────────────────────────────────────────────────────────
--   BEGIN;
--   DROP TABLE IF EXISTS export_worker_queue;
--   DROP TABLE IF EXISTS consent_events;
--   DROP TABLE IF EXISTS data_subject_requests;
--   DROP TABLE IF EXISTS audit_log;
--   DROP TABLE IF EXISTS event_data_policies;
--   COMMIT;
--
