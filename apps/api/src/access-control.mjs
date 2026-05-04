import { HttpError } from "./http-error.mjs";

export const ROLES = Object.freeze({
  platformAdmin: "platform_admin",
  organizerAdmin: "organizer_admin",
  vendorManager: "vendor_manager",
  sponsorUser: "sponsor_user",
  opsUser: "ops_user",
  devicePrincipal: "device_principal"
});

const USER_ROLES = [
  ROLES.platformAdmin,
  ROLES.organizerAdmin,
  ROLES.vendorManager,
  ROLES.sponsorUser,
  ROLES.opsUser
];
const ALL_AUTHENTICATED_ROLES = [...USER_ROLES, ROLES.devicePrincipal];

function entry({ permission, roles, scope = "tenant", description, sensitivity = "internal" }) {
  return Object.freeze({
    permission,
    roles: Object.freeze([...roles]),
    scope,
    description,
    sensitivity
  });
}

function publicEntry(permission, description, sensitivity = "public") {
  return entry({
    permission,
    roles: [],
    scope: "public",
    description,
    sensitivity
  });
}

const organizer = [ROLES.organizerAdmin];
const platform = [ROLES.platformAdmin];
const vendor = [ROLES.vendorManager];
const sponsor = [ROLES.sponsorUser];
const device = [ROLES.devicePrincipal];
const organizerOrPlatform = [ROLES.organizerAdmin, ROLES.platformAdmin];
const vendorOrganizerPlatform = [ROLES.vendorManager, ROLES.organizerAdmin, ROLES.platformAdmin];
const sponsorOrOrganizer = [ROLES.sponsorUser, ROLES.organizerAdmin];

export const ACCESS_CONTROL_MATRIX = Object.freeze({
  health: publicEntry("system.health.view", "Read API health metadata"),
  readiness: publicEntry("system.readiness.view", "Read minimal deployment readiness probe"),
  "auth-browser-config": publicEntry("auth.browser_config.view", "Read public browser login configuration"),
  "auth-oidc-exchange": publicEntry("auth.oidc.exchange", "Exchange an OIDC authorization code for a browser access token", "sensitive"),
  "notification-provider-webhook": publicEntry("notification.webhook.ingest", "Ingest a secret-gated provider delivery receipt webhook", "secret-adjacent"),
  "consent-capture": publicEntry("attendee.consent.capture", "Capture attendee consent using a signed attendee session", "pii"),
  "consent-revoke": publicEntry("attendee.consent.revoke", "Revoke attendee consent using a signed attendee session", "pii"),
  "attendee-session-view": publicEntry("attendee.session.view", "Read attendee session detail using a signed attendee session", "pii"),
  "attendee-dsr-create": publicEntry("attendee.dsr.create", "Create an attendee access or delete request using a signed attendee session", "privacy"),
  "attendee-wallet-pass-create": publicEntry("attendee.wallet_pass.create", "Request a safe wallet pass artifact using a signed attendee session", "privacy"),
  "event-public-leaderboard": publicEntry("event.leaderboard.public.view", "Read public no-PII event leaderboard"),
  "short-link-resolve": publicEntry("short_link.resolve", "Resolve an expiring signed short link", "sensitive"),
  "short-link-status": entry({ permission: "short_link.status.view", roles: organizer, scope: "event", description: "Inspect a signed short link lifecycle state", sensitivity: "sensitive" }),
  "short-link-revoke": entry({ permission: "short_link.revoke", roles: organizer, scope: "event", description: "Revoke an active signed short link", sensitivity: "sensitive" }),

  "auth-me": entry({
    permission: "auth.principal.view",
    roles: ALL_AUTHENTICATED_ROLES,
    scope: "principal",
    description: "Read the authenticated principal bootstrap payload"
  }),

  "device-credentials-list": entry({
    permission: "device.credentials.view",
    roles: organizerOrPlatform,
    scope: "event_device",
    description: "List device credentials for a scoped device",
    sensitivity: "secret-adjacent"
  }),
  "device-credentials-provision": entry({
    permission: "device.credentials.provision",
    roles: organizerOrPlatform,
    scope: "event_device",
    description: "Provision a new device credential",
    sensitivity: "secret"
  }),
  "device-credentials-revoke": entry({
    permission: "device.credentials.revoke",
    roles: organizerOrPlatform,
    scope: "event_device",
    description: "Revoke a device credential",
    sensitivity: "secret"
  }),
  "device-config": entry({
    permission: "device.config.view",
    roles: device,
    scope: "assigned_device",
    description: "Read assigned device configuration"
  }),
  "device-heartbeat": entry({
    permission: "device.heartbeat.record",
    roles: device,
    scope: "assigned_device",
    description: "Record device heartbeat status"
  }),
  "interaction-tap": entry({
    permission: "interaction.tap.create",
    roles: device,
    scope: "assigned_device",
    description: "Ingest a physical tap interaction",
    sensitivity: "pii"
  }),
  "device-sync": entry({
    permission: "device.sync.record",
    roles: device,
    scope: "assigned_device",
    description: "Sync queued device interaction records",
    sensitivity: "pii"
  }),

  "stall-leads": entry({
    permission: "vendor.leads.view",
    roles: vendorOrganizerPlatform,
    scope: "event_stall",
    description: "View consent-aware stall lead list",
    sensitivity: "pii"
  }),
  "stall-dashboard-metrics": entry({
    permission: "vendor.dashboard_metrics.view",
    roles: vendorOrganizerPlatform,
    scope: "event_stall",
    description: "View vendor stall dashboard calculations",
    sensitivity: "sensitive"
  }),
  "interaction-lead-detail": entry({
    permission: "vendor.lead_detail.view",
    roles: vendorOrganizerPlatform,
    scope: "event_stall",
    description: "View consent-aware lead detail",
    sensitivity: "pii"
  }),
  "classify-interaction": entry({
    permission: "vendor.interaction.classify",
    roles: vendor,
    scope: "event_stall",
    description: "Update vendor classification for a lead"
  }),
  "interaction-note": entry({
    permission: "vendor.interaction.note.create",
    roles: vendor,
    scope: "event_stall",
    description: "Create a vendor note on a lead",
    sensitivity: "pii"
  }),
  "interaction-followup-create": entry({
    permission: "vendor.interaction.followup.create",
    roles: [ROLES.vendorManager, ROLES.organizerAdmin],
    scope: "event_stall",
    description: "Create a human-reviewed follow-up message draft or queue request",
    sensitivity: "pii"
  }),
  "followup-queue": entry({
    permission: "vendor.followup.queue",
    roles: [ROLES.vendorManager, ROLES.organizerAdmin],
    scope: "event_stall",
    description: "Queue a follow-up after explicit human approval and channel consent checks",
    sensitivity: "pii"
  }),
  "interaction-wallet-passes-list": entry({
    permission: "wallet_pass.view",
    roles: vendorOrganizerPlatform,
    scope: "event_stall",
    description: "View wallet pass generation status for a lead",
    sensitivity: "privacy"
  }),
  "wallet-pass-retry": entry({
    permission: "wallet_pass.retry",
    roles: organizer,
    scope: "event",
    description: "Retry a failed or disabled wallet pass without blocking the interaction flow",
    sensitivity: "privacy"
  }),
  "wallet-pass-status-update": entry({
    permission: "wallet_pass.status.update",
    roles: organizer,
    scope: "event",
    description: "Record wallet pass delivery, failure, or cancellation state",
    sensitivity: "privacy"
  }),
  "notification-attempt-create": entry({
    permission: "notification.attempt.create",
    roles: organizer,
    scope: "event",
    description: "Record provider-level notification send attempts",
    sensitivity: "pii"
  }),
  "notification-retry-now": entry({
    permission: "notification.retry_now",
    roles: organizer,
    scope: "event",
    description: "Retry a temporarily failed notification immediately after consent re-check",
    sensitivity: "pii"
  }),
  "notification-force-requeue": entry({
    permission: "notification.force_requeue",
    roles: organizer,
    scope: "event",
    description: "Force requeue an exhausted dead-letter notification after operator review",
    sensitivity: "pii"
  }),
  "notification-resend": entry({
    permission: "notification.resend",
    roles: organizer,
    scope: "event",
    description: "Requeue a failed notification for resend after consent re-check",
    sensitivity: "pii"
  }),
  "notification-cancel": entry({
    permission: "notification.cancel",
    roles: organizer,
    scope: "event",
    description: "Cancel a queued or failed notification",
    sensitivity: "pii"
  }),
  "interaction-crm-sync": entry({
    permission: "vendor.interaction.crm_sync",
    roles: [ROLES.vendorManager, ROLES.organizerAdmin],
    scope: "event_stall",
    description: "Sync an eligible consented lead to the pilot CRM",
    sensitivity: "pii"
  }),
  "interaction-notes-list": entry({
    permission: "vendor.interaction.notes.view",
    roles: vendorOrganizerPlatform,
    scope: "event_stall",
    description: "View notes for a lead",
    sensitivity: "pii"
  }),

  "sponsor-metrics": entry({
    permission: "sponsor.metrics.view",
    roles: sponsorOrOrganizer,
    scope: "event_sponsor",
    description: "View aggregate sponsor metrics"
  }),
  "sponsor-report-snapshots": entry({
    permission: "sponsor.snapshots.view",
    roles: sponsorOrOrganizer,
    scope: "event_sponsor",
    description: "View published sponsor report snapshots"
  }),
  "sponsor-exports-list": entry({
    permission: "sponsor.exports.view",
    roles: sponsorOrOrganizer,
    scope: "event_sponsor",
    description: "View sponsor export history"
  }),
  "organizer-sponsor-report-snapshot-create": entry({
    permission: "sponsor.snapshots.create",
    roles: organizer,
    scope: "event_sponsor",
    description: "Publish a sponsor report snapshot"
  }),

  "organizer-report-freeze-status": entry({ permission: "organizer.report_freeze.view", roles: organizer, scope: "event", description: "View event report-freeze status" }),
  "organizer-report-freeze-trigger": entry({ permission: "organizer.report_freeze.trigger", roles: organizer, scope: "event", description: "Freeze the official event report", sensitivity: "sensitive" }),
  "organizer-overview": entry({ permission: "organizer.overview.view", roles: organizer, scope: "event", description: "View organizer event overview" }),
  "organizer-data-control": entry({ permission: "organizer.data_control.view", roles: organizer, scope: "event", description: "View organizer event data-control settings", sensitivity: "privacy" }),
  "organizer-data-control-update": entry({ permission: "organizer.data_control.update", roles: organizer, scope: "event", description: "Update organizer event data-control settings", sensitivity: "privacy" }),
  "organizer-event-publish": entry({ permission: "organizer.event.publish", roles: organizer, scope: "event", description: "Publish a draft event after confirming data-control policy", sensitivity: "sensitive" }),
  "organizer-provider-readiness": entry({ permission: "organizer.provider_readiness.view", roles: organizer, scope: "event", description: "View wallet and notification provider readiness flags", sensitivity: "sensitive" }),
  "organizer-outbound-delivery-analytics": entry({ permission: "organizer.outbound_analytics.view", roles: organizer, scope: "event", description: "View outbound notification delivery analytics and provider breakdowns", sensitivity: "sensitive" }),
  "organizer-outbound-queue-metrics": entry({ permission: "organizer.outbound_queue.view", roles: organizer, scope: "event", description: "View outbound notification queue metrics", sensitivity: "sensitive" }),
  "organizer-outbound-queue-list": entry({ permission: "organizer.outbound_queue.view", roles: organizer, scope: "event", description: "Inspect outbound notification queue inventory", sensitivity: "sensitive" }),
  "organizer-outbound-queue-process": entry({ permission: "organizer.outbound_queue.process", roles: organizer, scope: "event", description: "Process an outbound notification queue batch", sensitivity: "sensitive" }),
  "organizer-outbound-attempts-list": entry({ permission: "organizer.outbound_attempts.view", roles: organizer, scope: "event", description: "Inspect outbound notification delivery attempt history", sensitivity: "sensitive" }),
  "organizer-outbound-queue-export": entry({ permission: "organizer.outbound_queue.export", roles: organizer, scope: "event", description: "Download outbound notification queue inventory as CSV", sensitivity: "sensitive" }),
  "organizer-outbound-attempts-export": entry({ permission: "organizer.outbound_attempts.export", roles: organizer, scope: "event", description: "Download outbound notification attempt history as CSV", sensitivity: "sensitive" }),
  "organizer-notification-receipts-list": entry({ permission: "organizer.notification_receipts.view", roles: organizer, scope: "event", description: "Inspect provider delivery receipt history for notifications", sensitivity: "sensitive" }),
  "organizer-notification-receipts-export": entry({ permission: "organizer.notification_receipts.export", roles: organizer, scope: "event", description: "Download provider delivery receipt history as CSV", sensitivity: "sensitive" }),
  "organizer-operational-alerts": entry({ permission: "organizer.operational_alerts.view", roles: organizer, scope: "event", description: "View failed wallet and notification artifacts for operations follow-up", sensitivity: "sensitive" }),
  "organizer-artifact-attempts-export": entry({ permission: "organizer.artifact_attempts.export", roles: organizer, scope: "event", description: "Download notification and wallet attempt evidence as CSV", sensitivity: "sensitive" }),
  "organizer-short-links-list": entry({ permission: "organizer.short_links.view", roles: organizer, scope: "event", description: "View signed short links connected to an event investigation", sensitivity: "sensitive" }),
  "organizer-leaderboard-snapshots": entry({ permission: "organizer.leaderboard_snapshots.view", roles: organizer, scope: "event", description: "View public leaderboard snapshot history" }),
  "organizer-leaderboard-snapshot-create": entry({ permission: "organizer.leaderboard_snapshots.create", roles: organizer, scope: "event", description: "Capture a public no-PII leaderboard snapshot" }),
  "organizer-compliance-overview": entry({ permission: "organizer.compliance.view", roles: organizer, scope: "event", description: "View compliance overview", sensitivity: "privacy" }),
  "organizer-compliance-report": entry({ permission: "organizer.compliance_report.view", roles: organizer, scope: "event", description: "View compliance operational report", sensitivity: "privacy" }),
  "organizer-compliance-closeout-readiness": entry({ permission: "organizer.compliance_closeout.view", roles: organizer, scope: "event", description: "View compliance closeout readiness", sensitivity: "privacy" }),
  "organizer-crm-sync-history": entry({ permission: "organizer.crm_sync.view", roles: organizer, scope: "event", description: "View CRM sync history", sensitivity: "pii" }),
  "organizer-compliance-audit-export": entry({ permission: "organizer.compliance_audit_export.request", roles: organizer, scope: "event", description: "Request a compliance audit export", sensitivity: "privacy" }),
  "organizer-dsr-list": entry({ permission: "organizer.dsr.view", roles: organizer, scope: "event", description: "List data subject requests", sensitivity: "privacy" }),
  "organizer-dsr-create": entry({ permission: "organizer.dsr.create", roles: organizer, scope: "event", description: "Create a data subject request", sensitivity: "privacy" }),
  "organizer-dsr-complete": entry({ permission: "organizer.dsr.complete", roles: organizer, scope: "event", description: "Complete a data subject request", sensitivity: "privacy" }),
  "organizer-downstream-deletion-confirm": entry({ permission: "organizer.downstream_deletion.confirm", roles: organizer, scope: "event", description: "Confirm a downstream deletion", sensitivity: "privacy" }),
  "organizer-downstream-deletion-dispatch": entry({ permission: "organizer.downstream_deletion.dispatch", roles: organizer, scope: "event", description: "Dispatch a downstream deletion", sensitivity: "privacy" }),
  "organizer-retention-run": entry({ permission: "organizer.retention.run", roles: organizer, scope: "event", description: "Run retention preview or apply", sensitivity: "privacy" }),
  "organizer-device-fleet": entry({ permission: "organizer.device_fleet.view", roles: organizer, scope: "event", description: "View device fleet posture" }),
  "organizer-incidents-list": entry({ permission: "organizer.incidents.view", roles: organizer, scope: "event", description: "List operational incidents" }),
  "organizer-incident-detail": entry({ permission: "organizer.incident.view", roles: organizer, scope: "event", description: "View incident investigation detail" }),
  "organizer-incident-annotation": entry({ permission: "organizer.incident.annotation.create", roles: organizer, scope: "event", description: "Create an incident annotation" }),
  "organizer-incident-state": entry({ permission: "organizer.incident.state.update", roles: organizer, scope: "event", description: "Update incident lifecycle state" }),
  "organizer-incident-runbook": entry({ permission: "organizer.incident.runbook.update", roles: organizer, scope: "event", description: "Update incident runbook tracking" }),
  "organizer-device-history": entry({ permission: "organizer.device_history.view", roles: organizer, scope: "event_device", description: "View device heartbeat and incident history" }),
  "organizer-iot-health": entry({ permission: "organizer.iot_health.view", roles: organizer, scope: "event", description: "View IoT integration health" }),
  "organizer-iot-go-live-readiness": entry({ permission: "organizer.iot_go_live_readiness.view", roles: organizer, scope: "event", description: "View IoT go-live readiness" }),
  "organizer-pilot-rehearsal-report": entry({ permission: "organizer.pilot_rehearsal.view", roles: organizer, scope: "event", description: "View pilot rehearsal report" }),
  "organizer-pilot-signoff-pack": entry({ permission: "organizer.pilot_signoff.view", roles: organizer, scope: "event", description: "View pilot signoff pack" }),
  "organizer-pilot-signoff-export": entry({ permission: "organizer.pilot_signoff.export", roles: organizer, scope: "event", description: "Request pilot signoff export" }),
  "organizer-pilot-go-live-execution": entry({ permission: "organizer.go_live_execution.view", roles: organizer, scope: "event", description: "View joint go-live execution" }),
  "organizer-pilot-go-live-dry-run": entry({ permission: "organizer.go_live_dry_run.record", roles: organizer, scope: "event", description: "Record go-live dry run" }),
  "organizer-pilot-go-live-approval": entry({ permission: "organizer.go_live_approval.record", roles: organizer, scope: "event", description: "Record go-live approval" }),
  "organizer-iot-runs": entry({ permission: "organizer.iot_runs.view", roles: organizer, scope: "event", description: "View IoT run history" }),
  "organizer-iot-alerts": entry({ permission: "organizer.iot_alerts.view", roles: organizer, scope: "event", description: "View IoT alerts" }),
  "organizer-iot-runs-trigger": entry({ permission: "organizer.iot_runs.trigger", roles: organizer, scope: "event", description: "Trigger organizer IoT sync", sensitivity: "sensitive" }),
  "organizer-iot-parity-trigger": entry({ permission: "organizer.iot_parity.trigger", roles: organizer, scope: "event", description: "Trigger IoT parity check", sensitivity: "sensitive" }),

  "admin-iot-runs-trigger": entry({ permission: "admin.iot_runs.trigger", roles: platform, scope: "event", description: "Trigger platform IoT sync", sensitivity: "sensitive" }),
  "admin-iot-cleanup-trigger": entry({ permission: "admin.iot_cleanup.trigger", roles: platform, scope: "event", description: "Run IoT operational cleanup", sensitivity: "sensitive" }),
  "admin-tenants-list": entry({ permission: "admin.tenants.list", roles: platform, scope: "global", description: "List all tenants with org/user/event counts" }),
  "admin-tenants-create": entry({ permission: "admin.tenants.create", roles: platform, scope: "global", description: "Create a new tenant", sensitivity: "sensitive" }),
  "admin-tenants-get": entry({ permission: "admin.tenants.view", roles: platform, scope: "global", description: "View tenant detail and stats" }),
  "admin-tenants-patch": entry({ permission: "admin.tenants.update", roles: platform, scope: "global", description: "Update tenant name or status", sensitivity: "sensitive" }),
  "admin-reference-data": entry({ permission: "admin.reference_data.view", roles: platform, scope: "tenant", description: "View IAM reference data" }),
  "admin-access-control-matrix": entry({ permission: "admin.access_control_matrix.view", roles: platform, scope: "tenant", description: "View the route-to-permission access-control matrix", sensitivity: "security" }),
  "admin-security-readiness": entry({ permission: "admin.security_readiness.view", roles: platform, scope: "tenant", description: "View production security hardening readiness controls", sensitivity: "security" }),
  "admin-security-alerts": entry({ permission: "admin.security_alerts.view", roles: platform, scope: "tenant", description: "View platform-admin security alerts derived from audit and runtime posture", sensitivity: "security" }),
  "admin-security-pentest-pack": entry({ permission: "admin.security_pentest_pack.export", roles: platform, scope: "tenant", description: "Export penetration-test readiness evidence", sensitivity: "security" }),
  "admin-pentest-attack-surface": entry({ permission: "admin.security_pentest_attack_surface.view", roles: platform, scope: "tenant", description: "View authorized attack surface summary for external testers", sensitivity: "security" }),
  "admin-pentest-findings-list": entry({ permission: "admin.security_pentest_findings.view", roles: platform, scope: "tenant", description: "View external penetration-test findings", sensitivity: "security" }),
  "admin-pentest-finding-create": entry({ permission: "admin.security_pentest_findings.create", roles: platform, scope: "tenant", description: "Create an external penetration-test finding", sensitivity: "security" }),
  "admin-pentest-finding-update": entry({ permission: "admin.security_pentest_findings.update", roles: platform, scope: "tenant", description: "Update external penetration-test finding remediation status", sensitivity: "security" }),
  "admin-deployment-readiness": entry({ permission: "admin.deployment_readiness.view", roles: platform, scope: "tenant", description: "View production deployment readiness and environment configuration checks", sensitivity: "security" }),
  "admin-final-go-live-package": entry({ permission: "admin.final_go_live.view", roles: platform, scope: "event", description: "View final production go-live checklist and launch package", sensitivity: "security" }),
  "admin-final-go-live-approval": entry({ permission: "admin.final_go_live.approve", roles: platform, scope: "event", description: "Record a final production go-live approval decision", sensitivity: "security" }),
  "admin-final-go-live-export": entry({ permission: "admin.final_go_live.export", roles: platform, scope: "event", description: "Export final production go-live evidence package", sensitivity: "security" }),
  "admin-users-list": entry({ permission: "admin.users.view", roles: platform, scope: "tenant", description: "List managed users", sensitivity: "security" }),
  "admin-user-create": entry({ permission: "admin.users.create", roles: platform, scope: "tenant", description: "Create or invite a managed user", sensitivity: "security" }),
  "admin-user-detail": entry({ permission: "admin.users.view", roles: platform, scope: "tenant", description: "View managed user detail", sensitivity: "security" }),
  "admin-user-update": entry({ permission: "admin.users.update", roles: platform, scope: "tenant", description: "Update user profile, role, organization, or identity link", sensitivity: "security" }),
  "admin-user-activate": entry({ permission: "admin.users.activate", roles: platform, scope: "tenant", description: "Activate a managed user", sensitivity: "security" }),
  "admin-user-disable": entry({ permission: "admin.users.disable", roles: platform, scope: "tenant", description: "Disable a managed user", sensitivity: "security" }),
  "admin-user-suspend": entry({ permission: "admin.users.suspend", roles: platform, scope: "tenant", description: "Suspend a managed user", sensitivity: "security" }),
  "admin-user-delete": entry({ permission: "admin.users.delete", roles: platform, scope: "tenant", description: "Soft-delete a managed user and revoke scopes", sensitivity: "security" }),
  "admin-user-scope-assign": entry({ permission: "admin.user_scopes.assign", roles: platform, scope: "tenant", description: "Assign a scoped access grant", sensitivity: "security" }),
  "admin-user-scope-revoke": entry({ permission: "admin.user_scopes.revoke", roles: platform, scope: "tenant", description: "Revoke a scoped access grant", sensitivity: "security" }),
  "admin-api-clients-list": entry({ permission: "admin.api_clients.list", roles: platform, scope: "tenant", description: "List API clients for a tenant", sensitivity: "secret-adjacent" }),
  "admin-api-clients-create": entry({ permission: "admin.api_clients.create", roles: platform, scope: "tenant", description: "Create an API client and get one-time secret", sensitivity: "secret" }),
  "admin-api-clients-get": entry({ permission: "admin.api_clients.view", roles: platform, scope: "tenant", description: "View API client detail (no secret)", sensitivity: "secret-adjacent" }),
  "admin-api-clients-rotate-secret": entry({ permission: "admin.api_clients.rotate_secret", roles: platform, scope: "tenant", description: "Rotate API client secret and get one-time new secret", sensitivity: "secret" }),
  "admin-api-clients-revoke": entry({ permission: "admin.api_clients.revoke", roles: platform, scope: "tenant", description: "Revoke an API client", sensitivity: "sensitive" }),
  "admin-commercial-governance": entry({ permission: "admin.commercial_governance.view", roles: platform, scope: "tenant", description: "View mandatory commercial and partner governance controls", sensitivity: "sensitive" }),
  "admin-commercial-partners-list": entry({ permission: "admin.commercial_partners.view", roles: platform, scope: "tenant", description: "List commercial partners", sensitivity: "sensitive" }),
  "admin-commercial-partner-create": entry({ permission: "admin.commercial_partners.create", roles: platform, scope: "tenant", description: "Create a commercial partner record", sensitivity: "sensitive" }),
  "admin-commercial-partner-update": entry({ permission: "admin.commercial_partners.update", roles: platform, scope: "tenant", description: "Update a commercial partner record", sensitivity: "sensitive" }),
  "admin-commercial-partner-status-update": entry({ permission: "admin.commercial_partner_status_updates.create", roles: platform, scope: "tenant", description: "Create a status-only partner update", sensitivity: "sensitive" }),
  "admin-commercial-deals-list": entry({ permission: "admin.commercial_deals.view", roles: platform, scope: "tenant", description: "List commercial pipeline deals", sensitivity: "sensitive" }),
  "admin-commercial-deal-create": entry({ permission: "admin.commercial_deals.create", roles: platform, scope: "tenant", description: "Create a commercial pipeline deal", sensitivity: "sensitive" }),
  "admin-commercial-deal-update": entry({ permission: "admin.commercial_deals.update", roles: platform, scope: "tenant", description: "Update a commercial pipeline deal", sensitivity: "sensitive" }),
  "admin-commercial-payouts-list": entry({ permission: "admin.commercial_payouts.view", roles: platform, scope: "tenant", description: "List partner payout records", sensitivity: "sensitive" }),
  "admin-commercial-payout-create": entry({ permission: "admin.commercial_payouts.create", roles: platform, scope: "tenant", description: "Create a partner payout record", sensitivity: "sensitive" }),
  "admin-commercial-payout-update": entry({ permission: "admin.commercial_payouts.update", roles: platform, scope: "tenant", description: "Update partner payout approval or payment state", sensitivity: "sensitive" }),
  "admin-commercial-approvals-list": entry({ permission: "admin.commercial_approvals.view", roles: platform, scope: "tenant", description: "List commercial approval records", sensitivity: "sensitive" }),
  "admin-commercial-approval-create": entry({ permission: "admin.commercial_approvals.create", roles: platform, scope: "tenant", description: "Record a commercial approval decision", sensitivity: "sensitive" }),

  "organizer-exports-list": entry({ permission: "organizer.exports.view", roles: organizer, scope: "event", description: "List organizer event exports", sensitivity: "pii" }),
  "exports-request": entry({ permission: "exports.request", roles: [ROLES.vendorManager, ROLES.sponsorUser, ROLES.organizerAdmin], scope: "event", description: "Request an export", sensitivity: "pii" }),
  "exports-approve": entry({ permission: "exports.approve", roles: organizer, scope: "event", description: "Approve an export", sensitivity: "pii" }),
  "exports-reject": entry({ permission: "exports.reject", roles: organizer, scope: "event", description: "Reject an export", sensitivity: "pii" }),
  "exports-status": entry({ permission: "exports.status.view", roles: [ROLES.vendorManager, ROLES.sponsorUser, ROLES.organizerAdmin], scope: "event", description: "View export status", sensitivity: "pii" }),
  "exports-short-link-create": entry({ permission: "exports.short_link.create", roles: [ROLES.vendorManager, ROLES.sponsorUser, ROLES.organizerAdmin], scope: "event", description: "Create an expiring export short link", sensitivity: "pii" }),
  "exports-download": entry({ permission: "exports.download", roles: [ROLES.vendorManager, ROLES.sponsorUser, ROLES.organizerAdmin], scope: "event", description: "Download generated export payload", sensitivity: "pii" }),

  "break-glass-request": entry({ permission: "break_glass.request", roles: platform, scope: "tenant", description: "Request emergency break-glass access", sensitivity: "security" }),
  "break-glass-approve": entry({ permission: "break_glass.approve", roles: platform, scope: "tenant", description: "Approve emergency break-glass access", sensitivity: "security" }),
  "break-glass-revoke": entry({ permission: "break_glass.revoke", roles: platform, scope: "tenant", description: "Revoke emergency break-glass access", sensitivity: "security" }),
  "break-glass-list": entry({ permission: "break_glass.view", roles: platform, scope: "tenant", description: "List emergency access requests", sensitivity: "security" }),
  "audit-logs": entry({ permission: "audit.logs.view", roles: organizerOrPlatform, scope: "event_or_tenant", description: "View audit logs", sensitivity: "security" }),

  // Phase 2 — Auth Service Extensions
  "auth-login": publicEntry("auth.login", "Authenticate with email and password", "sensitive"),
  "auth-invite-info": publicEntry("auth.invite.info", "Retrieve display name and email for a pending invite token"),
  "auth-accept-invite": publicEntry("auth.invite.accept", "Accept an invitation and set password", "sensitive"),
  "auth-forgot-password": publicEntry("auth.password.forgot", "Request a password reset email", "sensitive"),
  "auth-reset-password": publicEntry("auth.password.reset", "Reset password using a reset token", "sensitive"),
  "auth-change-password": entry({ permission: "auth.password.change", roles: USER_ROLES, scope: "principal", description: "Change own password", sensitivity: "sensitive" }),
  "auth-me-extended": entry({ permission: "auth.profile.view", roles: USER_ROLES, scope: "principal", description: "View own profile with org and roles", sensitivity: "internal" }),
  "auth-patch-me": entry({ permission: "auth.profile.update", roles: USER_ROLES, scope: "principal", description: "Update own display name", sensitivity: "internal" }),

  // Phase 3 — Identity / User Management API
  "users-list": entry({ permission: "user.list", roles: organizerOrPlatform, scope: "tenant", description: "List users in tenant (scoped for organizer_admin)", sensitivity: "internal" }),
  "users-invite": entry({ permission: "user.invite", roles: organizerOrPlatform, scope: "tenant", description: "Invite a new user and send invitation email", sensitivity: "sensitive" }),
  "users-get": entry({ permission: "user.view", roles: organizerOrPlatform, scope: "tenant", description: "View a user's details and role assignments", sensitivity: "internal" }),
  "users-patch": entry({ permission: "user.update", roles: organizerOrPlatform, scope: "tenant", description: "Update a user's display name", sensitivity: "internal" }),
  "users-disable": entry({ permission: "user.disable", roles: organizerOrPlatform, scope: "tenant", description: "Disable a user account", sensitivity: "sensitive" }),
  "users-enable": entry({ permission: "user.enable", roles: organizerOrPlatform, scope: "tenant", description: "Re-enable a disabled user account", sensitivity: "sensitive" }),
  "users-resend-invite": entry({ permission: "user.invite.resend", roles: organizerOrPlatform, scope: "tenant", description: "Resend an invitation to a pending user", sensitivity: "sensitive" }),
  "users-roles-list": entry({ permission: "user.roles.list", roles: organizerOrPlatform, scope: "tenant", description: "List role assignments for a user", sensitivity: "internal" }),
  "users-roles-assign": entry({ permission: "user.roles.assign", roles: organizerOrPlatform, scope: "tenant", description: "Add a role assignment to a user", sensitivity: "sensitive" }),
  "users-roles-delete": entry({ permission: "user.roles.remove", roles: organizerOrPlatform, scope: "tenant", description: "Remove a role assignment from a user", sensitivity: "sensitive" }),
  "orgs-list": entry({ permission: "org.list", roles: organizerOrPlatform, scope: "tenant", description: "List organizations in tenant", sensitivity: "internal" }),
  "orgs-create": entry({ permission: "org.create", roles: platform, scope: "tenant", description: "Create a new organization", sensitivity: "internal" }),
  "orgs-get": entry({ permission: "org.view", roles: organizerOrPlatform, scope: "tenant", description: "View organization details", sensitivity: "internal" }),
  "orgs-patch": entry({ permission: "org.update", roles: platform, scope: "tenant", description: "Update organization details", sensitivity: "internal" }),

  // Phase 4 — Event Management API
  "events-create": entry({ permission: "event.create", roles: organizerOrPlatform, scope: "tenant", description: "Create a new event", sensitivity: "internal" }),
  "events-list": entry({ permission: "event.list", roles: USER_ROLES, scope: "tenant", description: "List events scoped to caller's assignments", sensitivity: "internal" }),
  "events-get": entry({ permission: "event.view", roles: USER_ROLES, scope: "tenant", description: "View event details", sensitivity: "internal" }),
  "events-patch": entry({ permission: "event.update", roles: organizerOrPlatform, scope: "tenant", description: "Update event details (draft/published only)", sensitivity: "internal" }),
  "events-publish": entry({ permission: "event.publish", roles: organizerOrPlatform, scope: "tenant", description: "Publish event after checklist passes", sensitivity: "internal" }),
  "events-go-live": entry({ permission: "event.go_live", roles: organizerOrPlatform, scope: "tenant", description: "Move event to live status", sensitivity: "internal" }),
  "events-close": entry({ permission: "event.close", roles: organizerOrPlatform, scope: "tenant", description: "Close a live event with name confirmation", sensitivity: "internal" }),
  "events-archive": entry({ permission: "event.archive", roles: platform, scope: "tenant", description: "Archive a closed event", sensitivity: "internal" }),
  "events-checklist": entry({ permission: "event.checklist.view", roles: organizerOrPlatform, scope: "tenant", description: "View event onboarding checklist", sensitivity: "internal" }),
  "events-data-policy-get": entry({ permission: "event.data_policy.read", roles: [ROLES.organizerAdmin, ROLES.platformAdmin, ROLES.sponsorUser], scope: "tenant", description: "Read event data policy", sensitivity: "internal" }),
  "events-data-policy": entry({ permission: "event.data_policy.write", roles: organizerOrPlatform, scope: "tenant", description: "Create or update event data policy", sensitivity: "internal" }),
  "halls-list": entry({ permission: "hall.list", roles: organizerOrPlatform, scope: "tenant", description: "List halls for an event", sensitivity: "internal" }),
  "halls-create": entry({ permission: "hall.create", roles: organizerOrPlatform, scope: "tenant", description: "Create a hall for an event", sensitivity: "internal" }),
  "halls-patch": entry({ permission: "hall.update", roles: organizerOrPlatform, scope: "tenant", description: "Update a hall", sensitivity: "internal" }),
  "halls-delete": entry({ permission: "hall.delete", roles: organizerOrPlatform, scope: "tenant", description: "Delete a hall (draft events only)", sensitivity: "internal" }),
  "stalls-get": entry({ permission: "stall.view", roles: organizerOrPlatform, scope: "tenant", description: "Get a single stall by ID", sensitivity: "internal" }),
  "stalls-list": entry({ permission: "stall.list", roles: organizerOrPlatform, scope: "tenant", description: "List stalls for an event (supports ?hall_id filter)", sensitivity: "internal" }),
  "stalls-create": entry({ permission: "stall.create", roles: organizerOrPlatform, scope: "tenant", description: "Create a stall for an event", sensitivity: "internal" }),
  "stalls-patch": entry({ permission: "stall.update", roles: organizerOrPlatform, scope: "tenant", description: "Update a stall", sensitivity: "internal" }),
  "stalls-delete": entry({ permission: "stall.delete", roles: organizerOrPlatform, scope: "tenant", description: "Delete a stall (draft events only)", sensitivity: "internal" }),
  "sponsor-packages-list": entry({ permission: "sponsor_package.list", roles: organizerOrPlatform, scope: "tenant", description: "List sponsor packages for an event", sensitivity: "internal" }),
  "sponsor-packages-get": entry({ permission: "sponsor_package.view", roles: organizerOrPlatform, scope: "tenant", description: "Get a single sponsor package by ID", sensitivity: "internal" }),
  "sponsor-packages-create": entry({ permission: "sponsor_package.create", roles: organizerOrPlatform, scope: "tenant", description: "Create a sponsor package", sensitivity: "internal" }),
  "sponsor-packages-patch": entry({ permission: "sponsor_package.update", roles: organizerOrPlatform, scope: "tenant", description: "Update a sponsor package", sensitivity: "internal" }),
  "sponsor-packages-delete": entry({ permission: "sponsor_package.delete", roles: organizerOrPlatform, scope: "tenant", description: "Delete a sponsor package", sensitivity: "internal" }),
  "stalls-users-list": entry({ permission: "stall.users.list", roles: organizerOrPlatform, scope: "event", description: "List vendor_manager users scoped to a specific stall", sensitivity: "internal" }),
  "sponsor-packages-users-list": entry({ permission: "sponsor_package.users.list", roles: organizerOrPlatform, scope: "event", description: "List sponsor_user users scoped to a specific sponsor package", sensitivity: "internal" }),
  "devices-list": entry({ permission: "device.list", roles: [ROLES.platformAdmin, ROLES.organizerAdmin, ROLES.opsUser], scope: "tenant", description: "List devices for tenant", sensitivity: "internal" }),
  "devices-create": entry({ permission: "device.create", roles: [ROLES.platformAdmin], scope: "tenant", description: "Create/register a new device", sensitivity: "internal" }),
  "devices-get": entry({ permission: "device.view", roles: [ROLES.platformAdmin, ROLES.organizerAdmin, ROLES.opsUser], scope: "tenant", description: "Get a device by ID", sensitivity: "internal" }),
  "devices-patch": entry({ permission: "device.update", roles: [ROLES.platformAdmin], scope: "tenant", description: "Update device name or status (repair transitions only)", sensitivity: "internal" }),
  "devices-assign": entry({ permission: "device.assign", roles: [ROLES.platformAdmin, ROLES.organizerAdmin, ROLES.opsUser], scope: "tenant", description: "Assign a device to a stall", sensitivity: "internal" }),
  "devices-unassign": entry({ permission: "device.unassign", roles: [ROLES.platformAdmin, ROLES.organizerAdmin, ROLES.opsUser], scope: "tenant", description: "Unassign a device from its stall", sensitivity: "internal" }),
  "devices-retire": entry({ permission: "device.retire", roles: [ROLES.platformAdmin], scope: "tenant", description: "Retire a device (cannot retire live or assigned devices)", sensitivity: "internal" }),
  "nfc-readers-create": entry({ permission: "nfc_reader.create", roles: [ROLES.platformAdmin, ROLES.organizerAdmin, ROLES.opsUser], scope: "tenant", description: "Pair an NFC reader to a device", sensitivity: "internal" }),
  "nfc-readers-patch": entry({ permission: "nfc_reader.update", roles: [ROLES.platformAdmin, ROLES.organizerAdmin, ROLES.opsUser], scope: "tenant", description: "Update NFC reader firmware or model", sensitivity: "internal" }),
  "events-branding-get": entry({ permission: "event.branding.view", roles: organizerOrPlatform, scope: "event", description: "Get branding config for an event", sensitivity: "internal" }),
  "events-branding-save": entry({ permission: "event.branding.save", roles: organizerOrPlatform, scope: "event", description: "Save branding config for an event", sensitivity: "internal" }),
  "events-branding-publish": entry({ permission: "event.branding.publish", roles: [ROLES.organizerAdmin], scope: "event", description: "Publish branding to assigned fleet devices", sensitivity: "internal" }),
  "events-branding-approve": entry({ permission: "event.branding.approve", roles: [ROLES.platformAdmin], scope: "event", description: "Approve branding for an event", sensitivity: "internal" }),
  "admin-break-glass-request": entry({ permission: "admin.break_glass.request", roles: platform, scope: "tenant", description: "Submit a break-glass access request", sensitivity: "security" }),
  "admin-break-glass-list": entry({ permission: "admin.break_glass.list", roles: platform, scope: "tenant", description: "List break-glass requests", sensitivity: "security" }),
  "admin-break-glass-get": entry({ permission: "admin.break_glass.view", roles: platform, scope: "tenant", description: "View a single break-glass request", sensitivity: "security" }),
  "admin-break-glass-approve": entry({ permission: "admin.break_glass.approve", roles: platform, scope: "tenant", description: "Approve a break-glass request", sensitivity: "security" }),
  "admin-break-glass-reject": entry({ permission: "admin.break_glass.reject", roles: platform, scope: "tenant", description: "Reject a break-glass request", sensitivity: "security" }),
  "admin-break-glass-revoke": entry({ permission: "admin.break_glass.revoke", roles: platform, scope: "tenant", description: "Revoke an active break-glass session", sensitivity: "security" }),

  // Phase 15 — Sovereignty Backend Services
  "platform-access-log": entry({ permission: "organizer.platform_access_log.view", roles: organizer, scope: "event", description: "View internal_platform audit entries for own event (no actor identity)", sensitivity: "security" }),
  "platform-access-log-export": entry({ permission: "organizer.platform_access_log.export", roles: organizer, scope: "event", description: "Export platform access log as CSV", sensitivity: "security" }),
  "full-export-create": entry({ permission: "organizer.full_export.create", roles: organizer, scope: "event", description: "Request full event data export", sensitivity: "pii" }),
  "full-export-status": entry({ permission: "organizer.full_export.status", roles: organizer, scope: "event", description: "Check status of full event export", sensitivity: "pii" }),
  "full-export-download": entry({ permission: "organizer.full_export.download", roles: organizer, scope: "event", description: "Download completed full event export (single-use)", sensitivity: "pii" }),
  "full-export-history": entry({ permission: "organizer.full_export.history", roles: organizer, scope: "event", description: "List history of full event export requests", sensitivity: "pii" }),
  "privacy-dsr-create": publicEntry("attendee.dsr.submit", "Submit a data subject request (export or delete)", "sensitive"),
  "privacy-dsr-list": publicEntry("attendee.dsr.list", "List own data subject requests", "sensitive"),
  "privacy-dsr-download": publicEntry("attendee.dsr.download", "Download completed DSR export (single-use)", "pii"),
  "event-privacy-requests-list": entry({ permission: "organizer.privacy_requests.list", roles: organizer, scope: "event", description: "List DSRs for an event (no PII)", sensitivity: "pii" }),
  "event-privacy-request-detail": entry({ permission: "organizer.privacy_requests.view", roles: organizer, scope: "event", description: "View a single DSR detail", sensitivity: "pii" }),
  "event-privacy-request-reject": entry({ permission: "organizer.privacy_requests.reject", roles: organizer, scope: "event", description: "Reject a pending DSR", sensitivity: "pii" }),
  "tenant-offboard-initiate": entry({ permission: "admin.tenant.offboard.initiate", roles: platform, scope: "tenant", description: "Initiate tenant offboarding (requires second-admin approval)", sensitivity: "security" }),
  "tenant-offboard-approve": entry({ permission: "admin.tenant.offboard.approve", roles: platform, scope: "tenant", description: "Approve tenant offboarding (different admin required)", sensitivity: "security" }),
  "tenant-offboard-status": entry({ permission: "admin.tenant.offboard.status", roles: platform, scope: "tenant", description: "Check tenant offboarding job status", sensitivity: "security" }),
  "admin-tenant-retention": entry({ permission: "admin.tenant.retention.view", roles: platform, scope: "tenant", description: "View retention status for all events in a tenant", sensitivity: "pii" }),
  "event-retention-status": entry({ permission: "organizer.retention.view", roles: organizer, scope: "event", description: "View retention status for own event", sensitivity: "pii" }),
  "admin-event-force-purge": entry({ permission: "admin.event.retention.force_purge", roles: platform, scope: "event", description: "Force-purge event data", sensitivity: "security" }),
  "admin-tenant-compliance-get": entry({ permission: "admin.tenant.compliance.view", roles: platform, scope: "tenant", description: "View tenant data residency and compliance config", sensitivity: "security" }),
  "admin-tenant-compliance-patch": entry({ permission: "admin.tenant.compliance.update", roles: platform, scope: "tenant", description: "Update tenant data residency zone or sensitive data categories", sensitivity: "security" }),
  "admin-tenant-compliance-check": entry({ permission: "admin.tenant.compliance.check", roles: platform, scope: "tenant", description: "Run infrastructure compliance check", sensitivity: "security" }),
  "admin-privacy-audit-log": entry({ permission: "admin.privacy_audit_log.view", roles: platform, scope: "tenant", description: "View privacy audit log entries across all events", sensitivity: "security" }),
  "event-privacy-audit-log": entry({ permission: "organizer.privacy_audit_log.view", roles: organizer, scope: "event", description: "View privacy audit log for own event (no actor identity)", sensitivity: "security" }),
  "admin-privacy-audit-log-export": entry({ permission: "admin.privacy_audit_log.export", roles: platform, scope: "tenant", description: "Export full privacy audit log as CSV", sensitivity: "security" }),
  "storage-local-download": publicEntry("storage.local.download", "Download a signed local export file (token IS the auth)", "pii")
});

export function getAccessControlEntry(routeId) {
  return ACCESS_CONTROL_MATRIX[routeId] ?? null;
}

export function listAccessControlMatrix() {
  return Object.entries(ACCESS_CONTROL_MATRIX).map(([route_id, value]) => ({
    route_id,
    ...value,
    roles: [...value.roles]
  }));
}

export function enforceAccessControlMatrix(ctx) {
  const entry = getAccessControlEntry(ctx.route.id);
  if (!entry) {
    throw new HttpError(500, "Route is missing access-control matrix coverage", {
      route_id: ctx.route.id
    });
  }

  if (!entry.roles.length) {
    return;
  }

  if (!ctx.principal) {
    throw new HttpError(401, "Authentication required");
  }

  if (!entry.roles.includes(ctx.principal.role)) {
    throw new HttpError(403, "Permission not granted", {
      route_id: ctx.route.id,
      permission: entry.permission,
      role: ctx.principal.role
    });
  }
}

export function validateRouteMatrixCoverage(routes) {
  const routeIds = new Set(routes.map((route) => route.id));
  const matrixIds = new Set(Object.keys(ACCESS_CONTROL_MATRIX));
  const missing = [...routeIds].filter((routeId) => !matrixIds.has(routeId)).sort();
  const stale = [...matrixIds].filter((routeId) => !routeIds.has(routeId)).sort();
  const roleMismatches = [];

  for (const route of routes) {
    const entry = ACCESS_CONTROL_MATRIX[route.id];
    if (!entry || !route.allowedRoles?.length) {
      continue;
    }
    const routeRoles = [...route.allowedRoles].sort();
    const matrixRoles = [...entry.roles].sort();
    if (routeRoles.join("|") !== matrixRoles.join("|")) {
      roleMismatches.push({
        route_id: route.id,
        route_roles: routeRoles,
        matrix_roles: matrixRoles
      });
    }
  }

  return { missing, stale, role_mismatches: roleMismatches };
}
