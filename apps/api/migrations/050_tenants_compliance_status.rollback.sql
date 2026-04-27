-- Rollback migration 050
ALTER TABLE tenants
  DROP COLUMN IF EXISTS last_compliance_check_at,
  DROP COLUMN IF EXISTS last_compliance_status;
