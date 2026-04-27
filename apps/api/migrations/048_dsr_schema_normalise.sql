-- Migration 048: Normalise data_subject_requests schema
-- FIX 1: Drop legacy download_url / download_expires_at columns (no code refs; replaced by export_file_url / export_expires_at in migration 042)
ALTER TABLE data_subject_requests DROP COLUMN IF EXISTS download_url;
ALTER TABLE data_subject_requests DROP COLUMN IF EXISTS download_expires_at;

-- FIX 2: Extend request_type CHECK to include 'export' (Phase 15 writes this value)
ALTER TABLE data_subject_requests DROP CONSTRAINT IF EXISTS data_subject_requests_request_type_check;
ALTER TABLE data_subject_requests ADD CONSTRAINT data_subject_requests_request_type_check
  CHECK (request_type IN ('export', 'delete', 'access'));

-- FIX 2b: Align status CHECK with migration 042 intent (add 'processing' and 'failed' that were in the spec but not in the original table)
ALTER TABLE data_subject_requests DROP CONSTRAINT IF EXISTS data_subject_requests_status_check;
ALTER TABLE data_subject_requests ADD CONSTRAINT data_subject_requests_status_check
  CHECK (status IN ('requested', 'processing', 'in_progress', 'completed', 'rejected', 'failed'));

-- FIX 3: Add 'completed' to export_requests.status CHECK (needed by Phase 15.4 full-export download guard)
ALTER TABLE export_requests DROP CONSTRAINT IF EXISTS export_requests_status_check;
ALTER TABLE export_requests ADD CONSTRAINT export_requests_status_check
  CHECK (status IN ('requested', 'approved', 'rejected', 'generated', 'completed', 'expired'));
