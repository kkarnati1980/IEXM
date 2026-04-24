-- Rollback: 039_phase4_event_venue_columns

ALTER TABLE events
  DROP COLUMN IF EXISTS venue_name,
  DROP COLUMN IF EXISTS city,
  DROP COLUMN IF EXISTS country;

DELETE FROM schema_migrations WHERE version = '039_phase4_event_venue_columns';
