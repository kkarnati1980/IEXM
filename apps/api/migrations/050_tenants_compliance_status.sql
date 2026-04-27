-- Migration 050: Add compliance check result columns to tenants
-- Stores the outcome of the last infrastructure compliance scan (Infra TODO 3)

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS last_compliance_check_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_compliance_status TEXT
    CHECK (last_compliance_status IN ('compliant', 'review_required', 'non_compliant'));

COMMENT ON COLUMN tenants.last_compliance_check_at IS 'Timestamp of the most recent infrastructure compliance check run.';
COMMENT ON COLUMN tenants.last_compliance_status   IS 'Outcome of the most recent compliance check: compliant, review_required, or non_compliant.';
