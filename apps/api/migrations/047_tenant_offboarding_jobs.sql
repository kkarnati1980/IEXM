-- Migration 047: Create tenant_offboarding_jobs table for full offboarding lifecycle tracking
-- Depends on: tenants, users

CREATE TABLE tenant_offboarding_jobs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  initiated_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  data_handling_path TEXT NOT NULL CHECK (data_handling_path IN (
    'export_then_delete','immediate_delete','grace_period_delete'
  )),
  grace_period_days INTEGER,
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (status IN (
    'initiated','awaiting_approval','export_in_progress','export_complete',
    'deletion_in_progress','completed','failed'
  )),
  export_file_url TEXT,
  deletion_certificate_url TEXT,
  scheduled_deletion_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
