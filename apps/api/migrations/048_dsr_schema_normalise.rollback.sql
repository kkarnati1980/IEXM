-- Rollback migration 048
ALTER TABLE data_subject_requests ADD COLUMN IF NOT EXISTS download_url TEXT;
ALTER TABLE data_subject_requests ADD COLUMN IF NOT EXISTS download_expires_at TIMESTAMPTZ;

ALTER TABLE data_subject_requests DROP CONSTRAINT IF EXISTS data_subject_requests_request_type_check;
ALTER TABLE data_subject_requests ADD CONSTRAINT data_subject_requests_request_type_check
  CHECK (request_type IN ('access', 'delete'));

ALTER TABLE data_subject_requests DROP CONSTRAINT IF EXISTS data_subject_requests_status_check;
ALTER TABLE data_subject_requests ADD CONSTRAINT data_subject_requests_status_check
  CHECK (status IN ('requested', 'in_progress', 'completed', 'rejected'));

ALTER TABLE export_requests DROP CONSTRAINT IF EXISTS export_requests_status_check;
ALTER TABLE export_requests ADD CONSTRAINT export_requests_status_check
  CHECK (status IN ('requested', 'approved', 'rejected', 'generated', 'expired'));
