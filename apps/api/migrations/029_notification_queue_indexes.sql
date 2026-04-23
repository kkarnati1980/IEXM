CREATE INDEX IF NOT EXISTS notifications_queue_lookup_idx
ON notifications(tenant_id, event_id, status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS notifications_channel_status_idx
ON notifications(tenant_id, event_id, channel, status, updated_at DESC);
