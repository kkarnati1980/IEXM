-- Migration 046: Add download tracking columns to export_requests
-- Note: export_type already exists with CHECK ('vendor_leads','sponsor_leads','organizer_event_report').
-- We extend the constraint to include the new sovereignty export types while preserving old values.

ALTER TABLE export_requests
  ADD COLUMN IF NOT EXISTS download_used BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS download_used_at TIMESTAMPTZ;

-- Extend export_type CHECK constraint to include sovereignty export types
-- (existing values kept for backward compatibility with current data)
ALTER TABLE export_requests
  DROP CONSTRAINT IF EXISTS export_requests_export_type_check;

ALTER TABLE export_requests
  ADD CONSTRAINT export_requests_export_type_check CHECK (export_type IN (
    'vendor_leads','sponsor_leads','organizer_event_report',
    'vendor_leads_csv','sponsor_leads_csv','organizer_report_csv',
    'organizer_report_json','dsr_export_json','full_event_export_json',
    'full_event_export_csv','full_event_export_zip'
  ));
