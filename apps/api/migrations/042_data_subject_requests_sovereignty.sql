-- Migration 042: Ensure data_subject_requests has sovereignty columns
-- Table already exists from migration 022 with a different (older) schema.
-- CREATE TABLE IF NOT EXISTS is a no-op; we ADD the missing columns only.

CREATE TABLE IF NOT EXISTS data_subject_requests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  attendee_id TEXT REFERENCES attendees(id) ON DELETE SET NULL,
  request_type TEXT NOT NULL CHECK (request_type IN ('export','delete')),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','processing','completed','rejected','failed')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  export_file_url TEXT,
  export_expires_at TIMESTAMPTZ,
  requested_by_ip TEXT,
  metadata JSONB
);

-- Add columns missing from the pre-existing table (all safe nullable additions)
ALTER TABLE data_subject_requests
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS export_file_url TEXT,
  ADD COLUMN IF NOT EXISTS export_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS requested_by_ip TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB;
