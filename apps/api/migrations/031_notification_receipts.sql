CREATE TABLE IF NOT EXISTS notification_receipts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  provider TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  receipt_type TEXT NOT NULL CHECK (receipt_type IN ('delivered','opened','clicked','bounced','complained','unsubscribed','failed','deferred')),
  provider_message_id TEXT,
  provider_event_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  summary TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notification_receipts_notification_idx
  ON notification_receipts (notification_id, received_at DESC);

CREATE INDEX IF NOT EXISTS notification_receipts_provider_message_idx
  ON notification_receipts (tenant_id, provider_message_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE notification_receipts TO app_runtime;

ALTER TABLE notification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_receipts_tenant_isolation ON notification_receipts;
CREATE POLICY notification_receipts_tenant_isolation ON notification_receipts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
