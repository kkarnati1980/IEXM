-- Rollback 046: Remove download tracking columns and restore original export_type constraint

ALTER TABLE export_requests
  DROP COLUMN IF EXISTS download_used,
  DROP COLUMN IF EXISTS download_used_at;

-- Restore original export_type CHECK constraint
ALTER TABLE export_requests
  DROP CONSTRAINT IF EXISTS export_requests_export_type_check;

ALTER TABLE export_requests
  ADD CONSTRAINT export_requests_export_type_check CHECK (export_type IN (
    'vendor_leads','sponsor_leads','organizer_event_report'
  ));
