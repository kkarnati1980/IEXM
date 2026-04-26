-- Rollback 044: Remove sovereignty columns from tenants
ALTER TABLE tenants
  DROP COLUMN IF EXISTS data_residency_zone,
  DROP COLUMN IF EXISTS offboarding_status,
  DROP COLUMN IF EXISTS offboarding_initiated_at;
