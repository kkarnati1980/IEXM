DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  organizations,
  events,
  halls,
  stalls,
  event_data_policies,
  devices,
  user_access_scopes,
  device_credentials,
  device_assignments,
  device_heartbeats,
  device_incidents,
  attendees,
  attendee_profiles,
  tap_events,
  interactions,
  consents,
  consent_events,
  communication_channel_consents,
  communication_suppressions,
  interaction_notes,
  short_links,
  wallet_passes,
  wallet_pass_attempts,
  notifications,
  notification_attempts,
  followup_messages,
  export_requests,
  break_glass_access,
  audit_logs,
  event_report_snapshots
TO app_runtime;

CREATE OR REPLACE FUNCTION app_current_tenant_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '');
$$;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS organizations_tenant_isolation ON organizations;
CREATE POLICY organizations_tenant_isolation ON organizations
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS events_tenant_isolation ON events;
CREATE POLICY events_tenant_isolation ON events
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE halls ENABLE ROW LEVEL SECURITY;
ALTER TABLE halls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS halls_tenant_isolation ON halls;
CREATE POLICY halls_tenant_isolation ON halls
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE stalls ENABLE ROW LEVEL SECURITY;
ALTER TABLE stalls FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stalls_tenant_isolation ON stalls;
CREATE POLICY stalls_tenant_isolation ON stalls
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE event_data_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_data_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS event_data_policies_tenant_isolation ON event_data_policies;
CREATE POLICY event_data_policies_tenant_isolation ON event_data_policies
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS devices_tenant_isolation ON devices;
CREATE POLICY devices_tenant_isolation ON devices
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE user_access_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_access_scopes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_access_scopes_tenant_isolation ON user_access_scopes;
CREATE POLICY user_access_scopes_tenant_isolation ON user_access_scopes
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE device_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_credentials_tenant_isolation ON device_credentials;
CREATE POLICY device_credentials_tenant_isolation ON device_credentials
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE device_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_assignments_tenant_isolation ON device_assignments;
CREATE POLICY device_assignments_tenant_isolation ON device_assignments
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE device_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_heartbeats FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_heartbeats_tenant_isolation ON device_heartbeats;
CREATE POLICY device_heartbeats_tenant_isolation ON device_heartbeats
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE device_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_incidents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS device_incidents_tenant_isolation ON device_incidents;
CREATE POLICY device_incidents_tenant_isolation ON device_incidents
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendees FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attendees_tenant_isolation ON attendees;
CREATE POLICY attendees_tenant_isolation ON attendees
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE attendee_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendee_profiles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS attendee_profiles_tenant_isolation ON attendee_profiles;
CREATE POLICY attendee_profiles_tenant_isolation ON attendee_profiles
  USING (
    EXISTS (
      SELECT 1
      FROM attendees
      WHERE attendees.id = attendee_profiles.attendee_id
        AND attendees.tenant_id = app_current_tenant_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM attendees
      WHERE attendees.id = attendee_profiles.attendee_id
        AND attendees.tenant_id = app_current_tenant_id()
    )
  );

ALTER TABLE tap_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tap_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tap_events_tenant_isolation ON tap_events;
CREATE POLICY tap_events_tenant_isolation ON tap_events
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE interactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interactions_tenant_isolation ON interactions;
CREATE POLICY interactions_tenant_isolation ON interactions
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE consents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consents_tenant_isolation ON consents;
CREATE POLICY consents_tenant_isolation ON consents
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE consent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS consent_events_tenant_isolation ON consent_events;
CREATE POLICY consent_events_tenant_isolation ON consent_events
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

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

ALTER TABLE interaction_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS interaction_notes_tenant_isolation ON interaction_notes;
CREATE POLICY interaction_notes_tenant_isolation ON interaction_notes
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

ALTER TABLE followup_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS followup_messages_tenant_isolation ON followup_messages;
CREATE POLICY followup_messages_tenant_isolation ON followup_messages
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE short_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS short_links_tenant_isolation ON short_links;
CREATE POLICY short_links_tenant_isolation ON short_links
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE wallet_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_passes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_passes_tenant_isolation ON wallet_passes;
CREATE POLICY wallet_passes_tenant_isolation ON wallet_passes
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE wallet_pass_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_pass_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wallet_pass_attempts_tenant_isolation ON wallet_pass_attempts;
CREATE POLICY wallet_pass_attempts_tenant_isolation ON wallet_pass_attempts
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS export_requests_tenant_isolation ON export_requests;
CREATE POLICY export_requests_tenant_isolation ON export_requests
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE break_glass_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE break_glass_access FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS break_glass_access_tenant_isolation ON break_glass_access;
CREATE POLICY break_glass_access_tenant_isolation ON break_glass_access
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE event_report_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_report_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS event_report_snapshots_tenant_isolation ON event_report_snapshots;
CREATE POLICY event_report_snapshots_tenant_isolation ON event_report_snapshots
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());
