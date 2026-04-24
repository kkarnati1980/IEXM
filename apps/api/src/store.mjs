import { createHash, randomUUID } from "node:crypto";
import { hashDeviceCredentialToken } from "./device-credentials.mjs";

export function createSeedState() {
  const now = new Date().toISOString();
  const tenant = { id: "tenant-demo", slug: "demo", name: "Demo Tenant", created_at: now };
  const organizerOrg = {
    id: "org-organizer",
    tenant_id: tenant.id,
    type: "organizer",
    name: "Demo Organizer"
  };
  const vendorOrg = {
    id: "org-vendor",
    tenant_id: tenant.id,
    type: "vendor",
    name: "Northfield Estates"
  };
  const sponsorOrg = {
    id: "org-sponsor",
    tenant_id: tenant.id,
    type: "sponsor",
    name: "Orbit Capital"
  };
  const platformOrg = {
    id: "org-platform",
    tenant_id: tenant.id,
    type: "platform",
    name: "Platform Operations"
  };
  const event = {
    id: "event-demo",
    tenant_id: tenant.id,
    organizer_organization_id: organizerOrg.id,
    name: "Expo Pilot 2026",
    status: "live",
    metrics_definition_version: 1,
    report_snapshot_version: 1,
    starts_at: now,
    ends_at: null
  };
  const hall = { id: "hall-main", tenant_id: tenant.id, event_id: event.id, name: "Main Hall" };
  const eventSecondary = {
    id: "event-other",
    tenant_id: tenant.id,
    organizer_organization_id: organizerOrg.id,
    name: "Expo Secondary 2026",
    status: "draft",
    metrics_definition_version: 1,
    report_snapshot_version: 1,
    starts_at: now,
    ends_at: null
  };
  const hallSecondary = {
    id: "hall-secondary",
    tenant_id: tenant.id,
    event_id: eventSecondary.id,
    name: "Secondary Hall"
  };
  const stall = {
    id: "stall-a1",
    tenant_id: tenant.id,
    event_id: event.id,
    hall_id: hall.id,
    vendor_organization_id: vendorOrg.id,
    sponsor_organization_id: sponsorOrg.id,
    code: "A1",
    name: "Northfield Estates"
  };
  const stallSameEvent = {
    id: "stall-a2",
    tenant_id: tenant.id,
    event_id: event.id,
    hall_id: hall.id,
    vendor_organization_id: vendorOrg.id,
    sponsor_organization_id: sponsorOrg.id,
    code: "A2",
    name: "Northfield Annex"
  };
  const stallSecondary = {
    id: "stall-b1",
    tenant_id: tenant.id,
    event_id: eventSecondary.id,
    hall_id: hallSecondary.id,
    vendor_organization_id: vendorOrg.id,
    sponsor_organization_id: sponsorOrg.id,
    code: "B1",
    name: "Northfield Secondary"
  };
  const device = {
    id: "device-01",
    tenant_id: tenant.id,
    serial_number: "SN-001",
    status: "live",
    config_lease_expires_at: hoursFromNow(8)
  };
  const policy = {
    event_id: event.id,
    tenant_id: tenant.id,
    vendor_exports_enabled: true,
    sponsor_pii_enabled: false,
    require_export_approval: true,
    allow_crm_push: true,
    retention_days: 30,
    allow_cross_event_identity_graph: false,
    created_at: now,
    updated_at: now
  };
  const secondaryPolicy = {
    event_id: eventSecondary.id,
    tenant_id: tenant.id,
    vendor_exports_enabled: true,
    sponsor_pii_enabled: false,
    require_export_approval: true,
    allow_crm_push: false,
    retention_days: 30,
    allow_cross_event_identity_graph: false,
    created_at: now,
    updated_at: now
  };
  const assignment = {
    id: "assign-01",
    tenant_id: tenant.id,
    device_id: device.id,
    event_id: event.id,
    stall_id: stall.id,
    active: true,
    assignment_checksum: "35c70991fa13d0f72cfb1d1d721e46f582c32f78f181f47ebad2dc1f0f779545"
  };

  const organizer = user("user-organizer", "organizer@example.com", "Morgan Organizer", "organizer_admin", organizerOrg.id, tenant.id);
  const vendor = user("user-vendor", "vendor@example.com", "Val Vendor", "vendor_manager", vendorOrg.id, tenant.id);
  const sponsor = user("user-sponsor", "sponsor@example.com", "Sia Sponsor", "sponsor_user", sponsorOrg.id, tenant.id);
  const ops = user("user-ops", "ops@example.com", "Omar Ops", "ops_user", platformOrg.id, tenant.id);
  const platform1 = user("user-platform-1", "platform1@example.com", "Priya Platform", "platform_admin", platformOrg.id, tenant.id);
  const platform2 = user("user-platform-2", "platform2@example.com", "Pavel Platform", "platform_admin", platformOrg.id, tenant.id);
  const platform3 = user("user-platform-3", "platform3@example.com", "Nadia Platform", "platform_admin", platformOrg.id, tenant.id);

  return {
    tenants: [tenant],
    organizations: [organizerOrg, vendorOrg, sponsorOrg, platformOrg],
    users: [organizer, vendor, sponsor, ops, platform1, platform2, platform3],
    events: [event, eventSecondary],
    halls: [hall, hallSecondary],
    stalls: [stall, stallSameEvent, stallSecondary],
    devices: [device],
    deviceAssignments: [assignment],
    userRoleAssignments: [
      {
        id: "ura-organizer-event-demo",
        tenant_id: tenant.id,
        user_id: organizer.id,
        role: "organizer_admin",
        event_id: event.id,
        stall_ids: [],
        sponsor_package_id: null,
        assigned_by_user_id: platform1.id,
        created_at: now
      },
      {
        id: "ura-vendor-stall-a1",
        tenant_id: tenant.id,
        user_id: vendor.id,
        role: "vendor_manager",
        event_id: event.id,
        stall_ids: [stall.id],
        sponsor_package_id: null,
        assigned_by_user_id: organizer.id,
        created_at: now
      },
      {
        id: "ura-platform-admin",
        tenant_id: tenant.id,
        user_id: platform1.id,
        role: "platform_admin",
        event_id: null,
        stall_ids: [],
        sponsor_package_id: null,
        assigned_by_user_id: platform1.id,
        created_at: now
      }
    ],
    userAccessScopes: [
      {
        id: "scope-organizer-event-demo",
        tenant_id: tenant.id,
        user_id: organizer.id,
        event_id: event.id,
        stall_id: null,
        sponsor_organization_id: null,
        created_at: now
      },
      {
        id: "scope-vendor-stall-a1",
        tenant_id: tenant.id,
        user_id: vendor.id,
        event_id: event.id,
        stall_id: stall.id,
        sponsor_organization_id: null,
        created_at: now
      },
      {
        id: "scope-sponsor-event-demo",
        tenant_id: tenant.id,
        user_id: sponsor.id,
        event_id: event.id,
        stall_id: null,
        sponsor_organization_id: sponsorOrg.id,
        created_at: now
      }
    ],
    eventPolicies: [policy, secondaryPolicy],
    deviceCredentials: [
      {
        id: "cred-device-01",
        tenant_id: tenant.id,
        device_id: device.id,
        credential_label: "Seed kiosk credential",
        token_hash: hashDeviceCredentialToken("dvc_seed_device_01"),
        status: "active",
        created_by_user_id: organizer.id,
        revoked_by_user_id: null,
        last_used_at: null,
        revoked_at: null,
        created_at: now
      }
    ],
    attendees: [],
    attendeeProfiles: [],
    tapEvents: [],
    interactions: [],
    heartbeats: [],
    incidents: [],
    consents: [],
    consentEvents: [],
    communicationChannelConsents: [],
    communicationSuppressions: [],
    interactionNotes: [],
    shortLinks: [],
    walletPasses: [],
    walletPassAttempts: [],
    notifications: [],
    notificationAttempts: [],
    notificationReceipts: [],
    followupMessages: [],
    leadScores: [],
    exportRequests: [],
    breakGlassAccess: [],
    auditLogs: [],
    reportSnapshots: [],
    leaderboardSnapshots: [],
    crmSyncRecords: [],
    dataSubjectRequests: [],
    downstreamDeletionRecords: [],
    complianceRuns: [],
    pilotDryRunRecords: [],
    pilotSignoffApprovals: [],
    finalLaunchApprovals: [],
    commercialPartners: [],
    commercialDeals: [],
    commercialPartnerPayouts: [],
    commercialApprovals: [],
    commercialPartnerStatusUpdates: [],
    iotSyncCheckpoints: [],
    iotCertificationStatuses: [],
    iotDeviceStatusSnapshots: [],
    iotIntegrationHealthStatuses: [],
    iotIntegrationRuns: [],
    iotAlertEvents: [],
    iotEnvironmentParityStatuses: [],
    pentestFindings: [],
    sessionSecret: "pilot-attendee-session-secret",
    metrics: {
      routeHits: {}
    },
    authTokens: {
      "organizer-token": principalForUser(organizer, { event_ids: [event.id] }),
      "vendor-token": principalForUser(vendor, { event_ids: [event.id], stall_ids: [stall.id] }),
      "sponsor-token": principalForUser(sponsor, { event_ids: [event.id], sponsor_organization_ids: [sponsorOrg.id] }),
      "ops-token": principalForUser(ops, {}),
      "platform-token": principalForUser(platform1, {}),
      "platform-2-token": principalForUser(platform2, {}),
      "platform-3-token": principalForUser(platform3, {}),
      "device-token": {
        type: "device",
        actor_id: device.id,
        tenant_id: tenant.id,
        role: "device_principal",
        device_id: device.id,
        event_ids: [event.id],
        stall_ids: [stall.id]
      }
    }
  };
}

export function nextId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function getActiveAssignment(state, deviceId) {
  return state.deviceAssignments.find((entry) => entry.device_id === deviceId && entry.active);
}

function user(id, email, display_name, role, organization_id, tenant_id) {
  return {
    id,
    email,
    display_name,
    role,
    organization_id,
    tenant_id,
    external_identity_provider: null,
    external_subject: null,
    status: "active",
    password_hash: null,
    invited_by_user_id: null,
    invitation_token_hash: null,
    invitation_expires_at: null,
    password_reset_token_hash: null,
    password_reset_expires_at: null,
    last_login_at: null,
    disabled_at: null,
    disabled_reason: null,
    mfa_required: false,
    invited_at: null,
    deleted_at: null,
    created_at: new Date().toISOString()
  };
}

function principalForUser(userRecord, extras) {
  return {
    type: "user",
    actor_id: userRecord.id,
    tenant_id: userRecord.tenant_id,
    role: userRecord.role,
    user_id: userRecord.id,
    organization_id: userRecord.organization_id,
    ...extras
  };
}

function checksum(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}
