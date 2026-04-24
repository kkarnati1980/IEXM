-- Phase 4 follow-up: add venue_name, city, country to events table
-- These fields were stored in-memory only during Phase 4 implementation.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS venue_name TEXT,
  ADD COLUMN IF NOT EXISTS city       TEXT,
  ADD COLUMN IF NOT EXISTS country    TEXT;

INSERT INTO schema_migrations (version) VALUES ('039_phase4_event_venue_columns')
  ON CONFLICT (version) DO NOTHING;
