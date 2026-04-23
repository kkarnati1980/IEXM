CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  type TEXT NOT NULL CHECK (type IN ('organizer','vendor','sponsor','platform')),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  organization_id TEXT REFERENCES organizations(id),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('platform_admin','organizer_admin','vendor_manager','sponsor_user','ops_user')),
  external_identity_provider TEXT,
  external_subject TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending_invite','active','disabled','suspended','deleted')),
  last_login_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT,
  mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
  invited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_external_identity_unique
ON users (external_identity_provider, external_subject)
WHERE external_identity_provider IS NOT NULL AND external_subject IS NOT NULL;

CREATE TABLE events (
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

CREATE TABLE halls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  name TEXT NOT NULL
);

CREATE TABLE stalls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  hall_id TEXT REFERENCES halls(id),
  vendor_organization_id TEXT REFERENCES organizations(id),
  sponsor_organization_id TEXT REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE event_data_policies (
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

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  serial_number TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('inventory','assigned','live','repair','retired')),
  config_lease_expires_at TIMESTAMPTZ
);

CREATE TABLE user_access_scopes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT REFERENCES events(id),
  stall_id TEXT REFERENCES stalls(id),
  sponsor_organization_id TEXT REFERENCES organizations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE device_credentials (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  credential_label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_by_user_id TEXT REFERENCES users(id),
  revoked_by_user_id TEXT REFERENCES users(id),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE device_assignments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  assignment_checksum TEXT NOT NULL
);

CREATE UNIQUE INDEX device_assignments_one_active_per_device
ON device_assignments(device_id)
WHERE active = TRUE;

CREATE TABLE device_heartbeats (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  battery_level INTEGER NOT NULL,
  local_queue_depth INTEGER NOT NULL,
  assignment_checksum TEXT,
  connectivity_status TEXT NOT NULL DEFAULT 'online',
  reader_status TEXT NOT NULL DEFAULT 'connected',
  app_version TEXT,
  firmware_version TEXT,
  source_cursor TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE device_incidents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  event_id TEXT REFERENCES events(id),
  stall_id TEXT REFERENCES stalls(id),
  severity TEXT NOT NULL CHECK (severity IN ('P0','P1','P2','P3')),
  code TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  assignment_checksum TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ,
  source_cursor TEXT,
  raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE attendees (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attendee_profiles (
  attendee_id TEXT PRIMARY KEY REFERENCES attendees(id),
  full_name TEXT,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tap_events (
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

CREATE TABLE interactions (
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

CREATE TABLE lead_scores (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  scored_by_user_id TEXT REFERENCES users(id),
  previous_score TEXT CHECK (previous_score IN ('hot','warm','cold')),
  score TEXT NOT NULL CHECK (score IN ('hot','warm','cold')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE consents (
  interaction_id TEXT PRIMARY KEY REFERENCES interactions(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  attendee_id TEXT REFERENCES attendees(id),
  vendor_release_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  sponsor_release_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE consent_events (
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

CREATE TABLE communication_channel_consents (
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

CREATE TABLE interaction_notes (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  author_user_id TEXT NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
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

CREATE TABLE notification_attempts (
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

CREATE TABLE notification_receipts (
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

CREATE TABLE followup_messages (
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

CREATE TABLE short_links (
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

CREATE TABLE export_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  requested_by_user_id TEXT REFERENCES users(id),
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

CREATE TABLE break_glass_access (
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

CREATE TABLE audit_logs (
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

CREATE TABLE pentest_findings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  source TEXT NOT NULL DEFAULT 'external_pentest',
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  category TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL CHECK (status IN ('open','triaged','in_progress','remediated','accepted_risk','false_positive')),
  affected_area TEXT,
  description TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  remediation_plan TEXT,
  owner_user_id TEXT REFERENCES users(id),
  due_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  accepted_risk_reason TEXT,
  created_by_user_id TEXT REFERENCES users(id),
  updated_by_user_id TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE event_report_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  report_snapshot_version INTEGER NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE leaderboard_snapshots (
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

CREATE TABLE crm_sync_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  interaction_id TEXT NOT NULL REFERENCES interactions(id),
  provider TEXT NOT NULL,
  requested_by_user_id TEXT REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('synced','delete_pending','deleted','failed')),
  external_record_id TEXT,
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  synced_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE data_subject_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  attendee_id TEXT REFERENCES attendees(id),
  interaction_id TEXT REFERENCES interactions(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('access','delete')),
  status TEXT NOT NULL CHECK (status IN ('requested','in_progress','completed','rejected')),
  requested_by_user_id TEXT NOT NULL REFERENCES users(id),
  request_reason TEXT,
  resolution_summary TEXT,
  result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE downstream_deletion_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  dsr_request_id TEXT NOT NULL REFERENCES data_subject_requests(id),
  target_system TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','failed')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE compliance_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  run_type TEXT NOT NULL CHECK (run_type IN ('retention_preview','retention_apply','dsr_delete_apply')),
  status TEXT NOT NULL CHECK (status IN ('preview','completed','failed')),
  initiated_by TEXT,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pilot_dry_run_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  execution_type TEXT NOT NULL CHECK (execution_type IN ('staging_go_live_dry_run')),
  status TEXT NOT NULL CHECK (status IN ('planned','running','completed','failed')),
  executed_by_user_id TEXT REFERENCES users(id),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  note TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pilot_signoff_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  approver_role TEXT NOT NULL CHECK (approver_role IN ('organizer','platform','iot')),
  approver_label TEXT NOT NULL,
  approver_user_id TEXT REFERENCES users(id),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('pending','approved','rejected')),
  note TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id, approver_role)
);

CREATE TABLE final_launch_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  approver_role TEXT NOT NULL CHECK (approver_role IN ('platform_admin','organizer_owner','security_owner','business_owner')),
  approver_label TEXT NOT NULL,
  approver_user_id TEXT REFERENCES users(id),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('pending','approved','rejected')),
  note TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, event_id, approver_role)
);

CREATE TABLE commercial_partners (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  partner_type TEXT NOT NULL CHECK (partner_type IN ('referrer','channel_partner','delivery_ecosystem_partner')),
  status TEXT NOT NULL CHECK (status IN ('active','inactive')),
  access_level TEXT NOT NULL CHECK (access_level IN ('commercial_status_only','platform_access_provisioned')),
  platform_user_id TEXT REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (access_level <> 'platform_access_provisioned' OR platform_user_id IS NOT NULL)
);

CREATE TABLE commercial_deals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  partner_id TEXT REFERENCES commercial_partners(id),
  account_name TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('lead_added','contacted','replied','call_scheduled','demo_done','proposal_sent','negotiation','closed_won','closed_lost')),
  next_action TEXT NOT NULL,
  next_action_at TIMESTAMPTZ NOT NULL,
  offer_structure TEXT NOT NULL CHECK (offer_structure IN ('organizer_paid','sponsor_funded','mixed')),
  commercial_positioning_ack BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE commercial_partner_payouts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  partner_id TEXT NOT NULL REFERENCES commercial_partners(id),
  deal_id TEXT REFERENCES commercial_deals(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL CHECK (status IN ('pending','approved','paid','cancelled')),
  client_payment_received_at TIMESTAMPTZ,
  approved_by_user_id TEXT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'approved' OR approved_at IS NOT NULL),
  CHECK (status <> 'paid' OR (approved_at IS NOT NULL AND client_payment_received_at IS NOT NULL AND paid_at IS NOT NULL))
);

CREATE TABLE commercial_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  approval_type TEXT NOT NULL CHECK (approval_type IN ('standard_proposal','pricing_discount','pricing_exception','partner_payout_exception')),
  subject_id TEXT,
  requested_by_user_id TEXT REFERENCES users(id),
  approver_user_id TEXT REFERENCES users(id),
  approver_role TEXT NOT NULL CHECK (approver_role IN ('account_owner','founder','product_owner','platform_admin')),
  approval_status TEXT NOT NULL CHECK (approval_status IN ('pending','approved','rejected')),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  CHECK (approval_status = 'pending' OR decided_at IS NOT NULL)
);

CREATE TABLE commercial_partner_status_updates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  partner_id TEXT NOT NULL REFERENCES commercial_partners(id),
  deal_id TEXT REFERENCES commercial_deals(id),
  update_type TEXT NOT NULL CHECK (update_type IN ('commercial_status','deal_status','payout_status')),
  summary TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE iot_sync_checkpoints (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  stream_name TEXT NOT NULL,
  last_cursor TEXT,
  last_contract_version TEXT,
  last_environment TEXT,
  last_build_version TEXT,
  last_synced_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE iot_certification_statuses (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('certified','failed')),
  contract_version TEXT,
  environment TEXT,
  build_version TEXT,
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_certified_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_failure_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE iot_device_status_snapshots (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  device_id TEXT NOT NULL REFERENCES devices(id),
  platform_event_id TEXT REFERENCES events(id),
  platform_stall_id TEXT REFERENCES stalls(id),
  platform_assignment_checksum TEXT,
  iot_event_id TEXT REFERENCES events(id),
  iot_stall_id TEXT REFERENCES stalls(id),
  iot_assignment_checksum TEXT,
  lease_expires_at TIMESTAMPTZ,
  assignment_status TEXT NOT NULL CHECK (assignment_status IN ('matched','mismatched','missing','error')),
  diagnostics_status TEXT NOT NULL CHECK (diagnostics_status IN ('healthy','degraded','error','unknown')),
  connectivity_status TEXT,
  reader_status TEXT,
  app_version TEXT,
  firmware_version TEXT,
  local_queue_depth INTEGER,
  last_heartbeat_at TIMESTAMPTZ,
  open_incident_code TEXT,
  open_incident_status TEXT,
  open_incident_severity TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE iot_integration_health_statuses (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  overall_status TEXT NOT NULL CHECK (overall_status IN ('healthy','warning','critical','failed')),
  certification_status TEXT NOT NULL CHECK (certification_status IN ('certified','failed','unknown')),
  contract_version TEXT,
  environment TEXT,
  build_version TEXT,
  stale_after_seconds INTEGER NOT NULL DEFAULT 900,
  warning_count INTEGER NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE iot_integration_runs (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('manual','scheduled','automation','test')),
  initiated_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','completed','completed_with_warnings','failed')),
  step_count INTEGER NOT NULL DEFAULT 0,
  failed_step_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE iot_alert_events (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('run','health','parity')),
  source_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('not_configured','pending','delivered','failed')),
  routed_destinations JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_delivery_at TIMESTAMPTZ,
  delivery_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE iot_environment_parity_statuses (
  id TEXT PRIMARY KEY,
  integration_name TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  status TEXT NOT NULL CHECK (status IN ('passed','failed')),
  staging_contract_version TEXT,
  staging_environment TEXT,
  staging_build_version TEXT,
  production_contract_version TEXT,
  production_environment TEXT,
  production_build_version TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_access_scopes_tenant_user
ON user_access_scopes (tenant_id, user_id, created_at DESC);

CREATE INDEX idx_device_credentials_tenant_device
ON device_credentials (tenant_id, device_id, created_at DESC);

CREATE INDEX idx_events_tenant
ON events (tenant_id);

CREATE INDEX idx_stalls_tenant_event
ON stalls (tenant_id, event_id);

CREATE INDEX idx_tap_events_tenant_event
ON tap_events (tenant_id, event_id);

CREATE INDEX idx_interactions_tenant_event
ON interactions (tenant_id, event_id);

CREATE INDEX idx_interactions_tenant_stall
ON interactions (tenant_id, stall_id);

CREATE INDEX idx_lead_scores_interaction_created
ON lead_scores (tenant_id, interaction_id, created_at DESC);

CREATE INDEX idx_device_heartbeats_tenant_device
ON device_heartbeats (tenant_id, device_id, recorded_at DESC);

CREATE UNIQUE INDEX idx_device_heartbeats_source_cursor
ON device_heartbeats (source_cursor)
WHERE source_cursor IS NOT NULL;

CREATE INDEX idx_device_incidents_tenant_event
ON device_incidents (tenant_id, event_id, occurred_at DESC);

CREATE UNIQUE INDEX idx_device_incidents_source_cursor
ON device_incidents (source_cursor)
WHERE source_cursor IS NOT NULL;

CREATE INDEX idx_audit_logs_tenant_created
ON audit_logs (tenant_id, created_at DESC);

CREATE INDEX idx_pentest_findings_tenant_status
ON pentest_findings (tenant_id, status, severity, updated_at DESC);

CREATE UNIQUE INDEX idx_crm_sync_records_interaction_provider
ON crm_sync_records (tenant_id, interaction_id, provider);

CREATE INDEX idx_crm_sync_records_tenant_event
ON crm_sync_records (tenant_id, event_id, updated_at DESC);

CREATE INDEX idx_data_subject_requests_tenant_event_created
ON data_subject_requests (tenant_id, event_id, created_at DESC);

CREATE INDEX idx_downstream_deletion_records_tenant_event
ON downstream_deletion_records (tenant_id, event_id, requested_at DESC);

CREATE INDEX idx_downstream_deletion_records_request
ON downstream_deletion_records (tenant_id, dsr_request_id, requested_at DESC);

CREATE INDEX idx_compliance_runs_tenant_event_created
ON compliance_runs (tenant_id, event_id, created_at DESC);

CREATE INDEX idx_pilot_dry_run_records_event_created
ON pilot_dry_run_records (tenant_id, event_id, created_at DESC);

CREATE INDEX idx_pilot_signoff_approvals_event_role
ON pilot_signoff_approvals (tenant_id, event_id, approver_role);

CREATE INDEX idx_final_launch_approvals_event_role
ON final_launch_approvals (tenant_id, event_id, approver_role);

CREATE UNIQUE INDEX idx_iot_sync_checkpoints_integration_stream
ON iot_sync_checkpoints (integration_name, stream_name);

CREATE UNIQUE INDEX idx_iot_device_status_snapshots_integration_device
ON iot_device_status_snapshots (integration_name, device_id);

CREATE INDEX idx_iot_device_status_snapshots_tenant_event
ON iot_device_status_snapshots (tenant_id, event_id, checked_at DESC);

CREATE UNIQUE INDEX idx_iot_integration_health_statuses_integration_event
ON iot_integration_health_statuses (integration_name, tenant_id, event_id);

CREATE INDEX idx_iot_integration_runs_tenant_event_started
ON iot_integration_runs (tenant_id, event_id, started_at DESC);

CREATE INDEX idx_iot_alert_events_tenant_event_created
ON iot_alert_events (tenant_id, event_id, created_at DESC);

CREATE INDEX idx_iot_alert_events_tenant_event_status
ON iot_alert_events (tenant_id, event_id, status, created_at DESC);

CREATE UNIQUE INDEX idx_iot_environment_parity_statuses_integration_event
ON iot_environment_parity_statuses (integration_name, tenant_id, event_id);
