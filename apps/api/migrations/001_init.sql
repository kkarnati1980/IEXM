CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  type TEXT NOT NULL CHECK (type IN ('organizer','vendor','sponsor','platform')),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT REFERENCES organizations(id),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('platform_admin','organizer_admin','vendor_manager','sponsor_user','ops_user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organizer_organization_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','published','live','closed','archived')),
  metrics_definition_version INTEGER NOT NULL DEFAULT 1,
  report_snapshot_version INTEGER NOT NULL DEFAULT 1,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS halls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stalls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  hall_id TEXT REFERENCES halls(id),
  vendor_organization_id TEXT REFERENCES organizations(id),
  sponsor_organization_id TEXT REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_data_policies (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  vendor_exports_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  sponsor_pii_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  require_export_approval BOOLEAN NOT NULL DEFAULT TRUE,
  allow_crm_push BOOLEAN NOT NULL DEFAULT FALSE,
  retention_days INTEGER NOT NULL,
  allow_cross_event_identity_graph BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  serial_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('inventory','assigned','live','repair','retired')),
  config_lease_expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS device_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  assignment_checksum TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS device_assignments_one_active_per_device
ON device_assignments(device_id)
WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS device_heartbeats (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  battery_level INTEGER NOT NULL,
  local_queue_depth INTEGER NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_incidents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT REFERENCES events(id),
  severity TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS attendees (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attendee_profiles (
  attendee_id TEXT PRIMARY KEY REFERENCES attendees(id),
  full_name TEXT,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tap_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  local_event_id TEXT NOT NULL,
  tap_type TEXT NOT NULL CHECK (tap_type IN ('phone_ndef','card_uid','qr')),
  reader_uid_hash TEXT,
  ndef_payload TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cloud_received_at TIMESTAMPTZ,
  UNIQUE (device_id, local_event_id)
);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  tap_event_id TEXT NOT NULL UNIQUE REFERENCES tap_events(id),
  attendee_id TEXT REFERENCES attendees(id),
  captured_by_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('created','consent_required','active','anonymized','synced')),
  consent_status TEXT NOT NULL CHECK (consent_status IN ('pending','vendor_only','vendor_and_sponsor','declined')),
  classification TEXT NOT NULL DEFAULT 'cold' CHECK (classification IN ('hot','warm','cold')),
  sponsor_click_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_scores (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  scored_by_user_id TEXT REFERENCES users(id),
  previous_score TEXT CHECK (previous_score IN ('hot','warm','cold')),
  score TEXT NOT NULL CHECK (score IN ('hot','warm','cold')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consents (
  interaction_id TEXT PRIMARY KEY REFERENCES interactions(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  attendee_id TEXT REFERENCES attendees(id),
  vendor_release_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  sponsor_release_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consent_events (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  action TEXT NOT NULL CHECK (action IN ('capture','revoke')),
  vendor_release_allowed BOOLEAN NOT NULL,
  sponsor_release_allowed BOOLEAN NOT NULL,
  locale TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

CREATE TABLE IF NOT EXISTS interaction_notes (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

CREATE TABLE IF NOT EXISTS short_links (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  token_hash TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK (target_type IN ('attendee_session','export_download','wallet_pass')),
  target_id TEXT NOT NULL,
  target_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_passes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  pass_type TEXT NOT NULL CHECK (pass_type IN ('apple','google','generic')),
  status TEXT NOT NULL CHECK (status IN ('disabled','generated','delivered','failed','cancelled')),
  artifact_ref TEXT,
  short_link_id TEXT REFERENCES short_links(id),
  failure_code TEXT,
  failure_message TEXT,
  requested_by_user_id TEXT REFERENCES users(id),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_pass_attempts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  wallet_pass_id TEXT NOT NULL REFERENCES wallet_passes(id),
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('disabled','generated','failed')),
  reason TEXT NOT NULL CHECK (reason IN ('create','retry')),
  pass_type TEXT NOT NULL CHECK (pass_type IN ('apple','google','generic')),
  artifact_ref TEXT,
  short_link_id TEXT REFERENCES short_links(id),
  failure_code TEXT,
  failure_message TEXT,
  attempted_by_user_id TEXT REFERENCES users(id),
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS export_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  requested_for_organization_id TEXT REFERENCES organizations(id),
  export_type TEXT NOT NULL CHECK (export_type IN ('vendor_leads','sponsor_leads','organizer_event_report')),
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  row_count_estimate INTEGER,
  status TEXT NOT NULL CHECK (status IN ('requested','approved','rejected','generated','expired')),
  approval_required BOOLEAN NOT NULL DEFAULT TRUE,
  approved_by_user_id TEXT REFERENCES users(id),
  approval_reason TEXT,
  rejection_reason TEXT,
  file_url TEXT,
  file_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS break_glass_access (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  first_approved_by_user_id TEXT REFERENCES users(id),
  second_approved_by_user_id TEXT REFERENCES users(id),
  justification TEXT NOT NULL,
  access_scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('requested','partially_approved','active','rejected','revoked','expired')),
  starts_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','device','system')),
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  break_glass_access_id TEXT REFERENCES break_glass_access(id),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS event_report_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  report_snapshot_version INTEGER NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  snapshot_version INTEGER NOT NULL,
  calculation_version INTEGER NOT NULL DEFAULT 1,
  snapshot_interval_minutes INTEGER NOT NULL DEFAULT 5,
  payload JSONB NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_tenant ON events(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stalls_tenant_event ON stalls(tenant_id, event_id);
CREATE INDEX IF NOT EXISTS idx_tap_events_tenant_event ON tap_events(tenant_id, event_id);
CREATE INDEX IF NOT EXISTS idx_interactions_tenant_event ON interactions(tenant_id, event_id);
CREATE INDEX IF NOT EXISTS idx_interactions_tenant_stall ON interactions(tenant_id, stall_id);
CREATE INDEX IF NOT EXISTS idx_lead_scores_interaction_created ON lead_scores(tenant_id, interaction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_device_heartbeats_tenant_device ON device_heartbeats(tenant_id, device_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_tenant_event_created ON leaderboard_snapshots(tenant_id, event_id, created_at DESC);
