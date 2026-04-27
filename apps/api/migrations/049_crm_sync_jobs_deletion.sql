-- Migration 049: Add deletion tracking columns to crm_sync_jobs
-- Supports DSR delete worker CRM push (Infra TODO 2)

ALTER TABLE crm_sync_jobs
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deletion_status TEXT
    CHECK (deletion_status IN ('pending', 'deleted', 'deletion_failed', 'not_applicable')),
  ADD COLUMN IF NOT EXISTS deletion_error TEXT;

-- Index for querying pending/failed deletions during DSR reconciliation
CREATE INDEX IF NOT EXISTS idx_crm_sync_jobs_deletion_status
  ON crm_sync_jobs (tenant_id, deletion_status)
  WHERE deletion_status IN ('pending', 'deletion_failed');

COMMENT ON COLUMN crm_sync_jobs.deletion_requested_at IS 'Timestamp when CRM deletion was dispatched following a DSR delete request.';
COMMENT ON COLUMN crm_sync_jobs.deletion_status       IS 'Outcome of CRM deletion attempt: deleted, deletion_failed, not_applicable, or pending.';
COMMENT ON COLUMN crm_sync_jobs.deletion_error        IS 'Provider error reason if deletion_status = deletion_failed.';
