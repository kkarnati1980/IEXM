-- 051_notifications_transactional.sql
-- Extend notifications to support transactional system emails (invites, resets).
-- Transactional emails have no event scope and no consent gate.
--
-- Changes:
--   1. event_id, consent_checked_at, recipient_hash → nullable
--   2. system_payload JSONB → stores { recipient_email, subject, body }
--   3. status CHECK → adds 'dead_letter'

BEGIN;

ALTER TABLE notifications
  ALTER COLUMN event_id         DROP NOT NULL,
  ALTER COLUMN consent_checked_at DROP NOT NULL,
  ALTER COLUMN recipient_hash   DROP NOT NULL;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS system_payload JSONB;

-- Replace status constraint to include dead_letter
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('queued','sending','sent','failed','cancelled','dead_letter'));

INSERT INTO schema_migrations (version) VALUES ('051_notifications_transactional')
  ON CONFLICT DO NOTHING;

COMMIT;
