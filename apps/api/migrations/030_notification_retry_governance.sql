ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS retry_exhausted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retry_exhausted_reason TEXT;

ALTER TABLE notification_attempts
  ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS http_status INTEGER,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS response_excerpt TEXT;

CREATE INDEX IF NOT EXISTS notifications_retry_exhausted_idx
ON notifications(tenant_id, event_id, retry_exhausted_at, updated_at DESC);
