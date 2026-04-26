-- Rollback 042: Remove sovereignty columns added to data_subject_requests
-- Does NOT drop the table (it pre-existed this migration)
ALTER TABLE data_subject_requests
  DROP COLUMN IF EXISTS rejection_reason,
  DROP COLUMN IF EXISTS export_file_url,
  DROP COLUMN IF EXISTS export_expires_at,
  DROP COLUMN IF EXISTS requested_by_ip,
  DROP COLUMN IF EXISTS metadata;
