-- Rollback 043: Remove sovereignty retention columns from events
ALTER TABLE events
  DROP COLUMN IF EXISTS retention_status,
  DROP COLUMN IF EXISTS purged_at;
