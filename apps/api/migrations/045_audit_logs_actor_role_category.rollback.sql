-- Rollback 045: Remove actor_role_category from audit_logs
ALTER TABLE audit_logs
  DROP COLUMN IF EXISTS actor_role_category;
