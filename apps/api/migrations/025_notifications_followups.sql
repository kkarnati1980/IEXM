CREATE TABLE IF NOT EXISTS communication_channel_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  attendee_id TEXT REFERENCES attendees(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  allowed BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'attendee_self_service',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (interaction_id, channel)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  interaction_id TEXT REFERENCES interactions(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  message_type TEXT NOT NULL DEFAULT 'followup',
  status TEXT NOT NULL CHECK (status IN ('queued','sending','sent','failed','cancelled')),
  provider TEXT,
  recipient_hash TEXT NOT NULL,
  consent_checked_at TIMESTAMPTZ NOT NULL,
  sending_started_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  attempts_count INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  final_error TEXT,
  retry_exhausted_at TIMESTAMPTZ,
  retry_exhausted_reason TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  approved_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  notification_id TEXT NOT NULL REFERENCES notifications(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','failed','temporary_failure')),
  attempt_number INTEGER NOT NULL DEFAULT 1,
  provider_message_id TEXT,
  http_status INTEGER,
  duration_ms INTEGER,
  response_excerpt TEXT,
  error_message TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS followup_messages (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  subject TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','queued','sent','failed','cancelled')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  approved_by_user_id TEXT REFERENCES users(id),
  notification_id TEXT REFERENCES notifications(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS communication_suppressions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  attendee_id TEXT REFERENCES attendees(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','sms','whatsapp')),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'consent_revoke',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  communication_channel_consents,
  communication_suppressions,
  notifications,
  notification_attempts,
  notification_receipts,
  followup_messages
TO app_runtime;

ALTER TABLE communication_channel_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_channel_consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS communication_channel_consents_tenant_isolation ON communication_channel_consents;
CREATE POLICY communication_channel_consents_tenant_isolation ON communication_channel_consents
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE communication_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_suppressions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS communication_suppressions_tenant_isolation ON communication_suppressions;
CREATE POLICY communication_suppressions_tenant_isolation ON communication_suppressions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_tenant_isolation ON notifications;
CREATE POLICY notifications_tenant_isolation ON notifications
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE notification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_attempts_tenant_isolation ON notification_attempts;
CREATE POLICY notification_attempts_tenant_isolation ON notification_attempts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE notification_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_receipts_tenant_isolation ON notification_receipts;
CREATE POLICY notification_receipts_tenant_isolation ON notification_receipts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE followup_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS followup_messages_tenant_isolation ON followup_messages;
CREATE POLICY followup_messages_tenant_isolation ON followup_messages
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
