-- Migration 041: Create privacy_audit_log table with append-only enforcement
-- Depends on: tenants, events, users

CREATE TABLE privacy_audit_log (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'consent.captured','consent.revoked',
    'export.requested','export.approved','export.downloaded',
    'dsr.submitted','dsr.processing','dsr.completed','dsr.rejected',
    'break_glass.accessed','data_policy.changed',
    'retention.purge_executed','full_export.requested',
    'full_export.downloaded','attendee.anonymised',
    'tenant.offboarding_initiated','tenant.data_deleted',
    'privacy_log_exported'
  )),
  target_type TEXT,
  target_id TEXT,
  metadata JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_privacy_audit_tenant_event ON privacy_audit_log(tenant_id, event_id, occurred_at DESC);
CREATE INDEX idx_privacy_audit_action ON privacy_audit_log(action, occurred_at DESC);

-- Append-only enforcement: app_runtime may INSERT and SELECT but not UPDATE or DELETE
REVOKE UPDATE, DELETE ON privacy_audit_log FROM app_runtime;
