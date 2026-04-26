-- Migration 043: Add sovereignty retention columns to events table

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS retention_status TEXT NOT NULL DEFAULT 'active'
    CHECK (retention_status IN ('active','expiring_soon','expired_pending_purge','purging','purged','purge_failed')),
  ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;
