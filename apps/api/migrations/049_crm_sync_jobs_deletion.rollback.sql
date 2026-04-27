-- Rollback migration 049
DROP INDEX IF EXISTS idx_crm_sync_jobs_deletion_status;

ALTER TABLE crm_sync_jobs
  DROP COLUMN IF EXISTS deletion_requested_at,
  DROP COLUMN IF EXISTS deletion_status,
  DROP COLUMN IF EXISTS deletion_error;
