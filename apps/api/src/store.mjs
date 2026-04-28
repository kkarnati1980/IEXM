import { createHash, randomUUID } from "node:crypto";
import { hashDeviceCredentialToken } from "./device-credentials.mjs";

// Pre-computed scrypt hashes for password "TestPass123!"
// Generated with N=16384, r=8, p=1 (same params as auth/passwords.mjs)
const DEMO_PW = {
  admin:     "scrypt:6587faeb928ce73b183b0ddff568af88:4745d449af7aea1fa46c579f41d9d77489515e216997ac7a3cf1c749e3e7543f4192804e62226f29ba41563a40649547b84d62b5356108ee491d1a788db62dcf",
  organizer: "scrypt:a38f4c2f3280493876ae4277333006d8:c6a85006bdd0bc4dc30c1820cc7b99672248da0f10aa437f1d0387a356281396973478618c056b7777c6c0570d371978a88da9319e046c616fdbb475c3247293",
  vendor:    "scrypt:826a82e5f0118eb797e2d8919a9cd738:20a6dea8f9f0a4bd19d3be3c0cd75702c9e980b17524eaba9da7ba723397e4fef3035c397edbafb01f4bdc09528f1ca399763ef87d3d4cbf10d8dc1e583bea36",
  sponsor:   "scrypt:e6b16e68b9db01438ed727704f2d4111:a0fedff85e5eb6bd641486ca1b7f8542560b0ff88b2e32bf5dd9b943629a5a275a7d25633df37198cb99ef167611f9b3ae76edc309c5bcad34068f4b60e4ea07",
  ops:       "scrypt:8bd69e7a7415e27bc401455683c85c49:d31d9c30d364680aa4653c60ba86c95cc1d3fc50aa85578dea39b43e7b21707000665555a6e132a4a47386cad47e4646554696e2c42f7e2678d05570a3909bd3"
};

export function createSeedState() {
  const now = new Date().toISOString();
  const tenant = {
    id: "tenant-demo",
    slug: "demo",
    name: "Demo Tenant",
    created_at: now,
    data_residency_zone: "global",
    offboarding_status: "active",
    offboarding_initiated_at: null,
    sensitive_data_categories: []
  };
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
    ends_at: null,
    retention_status: "active",
    purged_at: null,
    last_purge_run_at: null
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
    ends_at: null,
    retention_status: "active",
    purged_at: null,
    last_purge_run_at: null
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

  // IndiaExpo IDs — defined as constants so role assignments can reference them.
  // The actual event/hall/stalls/package/policy records are created in applyDemoSampleData()
  // to avoid polluting the test-state event list (some tests assert events.length === 2).
  const IE_EVENT_ID   = "event-indiaexpo";
  const IE_STALL_A1   = "stall-ie-a1";
  const IE_PKG_GOLD   = "pkg-gold-ie";

  const organizer = user("user-organizer", "organizer@example.com", "Morgan Organizer", "organizer_admin", organizerOrg.id, tenant.id);
  const vendor = user("user-vendor", "vendor@example.com", "Val Vendor", "vendor_manager", vendorOrg.id, tenant.id);
  const sponsor = user("user-sponsor", "sponsor@example.com", "Sia Sponsor", "sponsor_user", sponsorOrg.id, tenant.id);
  const ops = user("user-ops", "ops@example.com", "Omar Ops", "ops_user", platformOrg.id, tenant.id);
  const platform1 = user("user-platform-1", "platform1@example.com", "Priya Platform", "platform_admin", platformOrg.id, tenant.id);
  const platform2 = user("user-platform-2", "platform2@example.com", "Pavel Platform", "platform_admin", platformOrg.id, tenant.id);
  const platform3 = user("user-platform-3", "platform3@example.com", "Nadia Platform", "platform_admin", platformOrg.id, tenant.id);

  // ─── Demo test users (password: TestPass123!) ─────────────────────
  const demoAdmin     = { ...user("demo-admin",     "admin@test.com",     "Admin User",     "platform_admin",  platformOrg.id, tenant.id), password_hash: DEMO_PW.admin };
  const demoOrganizer = { ...user("demo-organizer", "organizer@test.com", "Organizer User", "organizer_admin", organizerOrg.id, tenant.id), password_hash: DEMO_PW.organizer };
  const demoVendor    = { ...user("demo-vendor",    "vendor@test.com",    "Vendor User",    "vendor_manager",  vendorOrg.id,    tenant.id), password_hash: DEMO_PW.vendor };
  const demoSponsor   = { ...user("demo-sponsor",   "sponsor@test.com",   "Sponsor User",   "sponsor_user",    sponsorOrg.id,   tenant.id), password_hash: DEMO_PW.sponsor };
  const demoOps       = { ...user("demo-ops",       "ops@test.com",       "Ops User",       "ops_user",        platformOrg.id,  tenant.id), password_hash: DEMO_PW.ops };

  return {
    tenants: [tenant],
    organizations: [organizerOrg, vendorOrg, sponsorOrg, platformOrg],
    users: [organizer, vendor, sponsor, ops, platform1, platform2, platform3, demoAdmin, demoOrganizer, demoVendor, demoSponsor, demoOps],
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
      },
      // Demo test users scoped to IndiaExpo 2026
      { id: "ura-demo-admin",     tenant_id: tenant.id, user_id: demoAdmin.id,     role: "platform_admin",  event_id: null,          stall_ids: [],          sponsor_package_id: null,         assigned_by_user_id: demoAdmin.id,     created_at: now },
      { id: "ura-demo-organizer", tenant_id: tenant.id, user_id: demoOrganizer.id, role: "organizer_admin", event_id: IE_EVENT_ID,   stall_ids: [],          sponsor_package_id: null,         assigned_by_user_id: demoAdmin.id,     created_at: now },
      { id: "ura-demo-vendor",    tenant_id: tenant.id, user_id: demoVendor.id,    role: "vendor_manager",  event_id: IE_EVENT_ID,   stall_ids: [IE_STALL_A1], sponsor_package_id: null,       assigned_by_user_id: demoOrganizer.id, created_at: now },
      { id: "ura-demo-sponsor",   tenant_id: tenant.id, user_id: demoSponsor.id,   role: "sponsor_user",    event_id: IE_EVENT_ID,   stall_ids: [],          sponsor_package_id: IE_PKG_GOLD,  assigned_by_user_id: demoOrganizer.id, created_at: now },
      { id: "ura-demo-ops",       tenant_id: tenant.id, user_id: demoOps.id,       role: "ops_user",        event_id: IE_EVENT_ID,   stall_ids: [],          sponsor_package_id: null,         assigned_by_user_id: demoAdmin.id,     created_at: now }
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
      },
      // Demo test users
      { id: "scope-demo-admin",     tenant_id: tenant.id, user_id: demoAdmin.id,     event_id: null,         stall_id: null,       sponsor_organization_id: null,          created_at: now },
      { id: "scope-demo-organizer", tenant_id: tenant.id, user_id: demoOrganizer.id, event_id: IE_EVENT_ID,  stall_id: null,       sponsor_organization_id: null,          created_at: now },
      { id: "scope-demo-vendor-a1", tenant_id: tenant.id, user_id: demoVendor.id,    event_id: IE_EVENT_ID,  stall_id: IE_STALL_A1, sponsor_organization_id: null,         created_at: now },
      { id: "scope-demo-sponsor",   tenant_id: tenant.id, user_id: demoSponsor.id,   event_id: IE_EVENT_ID,  stall_id: null,       sponsor_organization_id: sponsorOrg.id, created_at: now },
      { id: "scope-demo-ops",       tenant_id: tenant.id, user_id: demoOps.id,       event_id: IE_EVENT_ID,  stall_id: null,       sponsor_organization_id: null,          created_at: now }
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
    sponsorPackages: [],
    brandingAssets: [],
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
    crmConnections: [],
    crmSyncJobs: [],
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
    apiClients: [],
    nfcReaders: [],
    privacyAuditLogs: [],
    tenantOffboardingJobs: [],
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
      },
      "demo-admin-token":     principalForUser(demoAdmin,     {}),
      "demo-organizer-token": principalForUser(demoOrganizer, { event_ids: [IE_EVENT_ID] }),
      "demo-vendor-token":    principalForUser(demoVendor,    { event_ids: [IE_EVENT_ID], stall_ids: [IE_STALL_A1] }),
      "demo-sponsor-token":   principalForUser(demoSponsor,   { event_ids: [IE_EVENT_ID], sponsor_organization_ids: [sponsorOrg.id] }),
      "demo-ops-token":       principalForUser(demoOps,       {})
    }
  };
}

// Populates live demo sample data into an existing state object.
// Called by server.mjs on startup — NOT from createSeedState() so tests stay clean.
export function applyDemoSampleData(state) {
  const now = new Date().toISOString();
  const tenantId = "tenant-demo";
  const eventId  = "event-indiaexpo";
  const stallId  = "stall-ie-a1";

  // ─── IndiaExpo 2026 event structure ──────────────────────────────
  state.events.push({
    id: eventId, tenant_id: tenantId, organizer_organization_id: "org-organizer",
    name: "IndiaExpo 2026", status: "live",
    metrics_definition_version: 1, report_snapshot_version: 1,
    starts_at: now, ends_at: null,
    retention_status: "active", purged_at: null, last_purge_run_at: null
  });
  state.halls.push({ id: "hall-a", tenant_id: tenantId, event_id: eventId, name: "Hall A" });
  state.stalls.push(
    { id: "stall-ie-a1", tenant_id: tenantId, event_id: eventId, hall_id: "hall-a", vendor_organization_id: "org-vendor", sponsor_organization_id: "org-sponsor", code: "A1", name: "Tech Pavilion A1" },
    { id: "stall-ie-a2", tenant_id: tenantId, event_id: eventId, hall_id: "hall-a", vendor_organization_id: "org-vendor", sponsor_organization_id: "org-sponsor", code: "A2", name: "Innovation Hub A2" },
    { id: "stall-ie-a3", tenant_id: tenantId, event_id: eventId, hall_id: "hall-a", vendor_organization_id: "org-vendor", sponsor_organization_id: "org-sponsor", code: "A3", name: "Startup Zone A3" }
  );
  state.sponsorPackages.push({ id: "pkg-gold-ie", tenant_id: tenantId, event_id: eventId, name: "Gold", tier: "gold", sponsor_organization_id: "org-sponsor", created_at: now });
  state.eventPolicies.push({
    event_id: eventId, tenant_id: tenantId,
    vendor_exports_enabled: true, sponsor_pii_enabled: true,
    require_export_approval: false, allow_crm_push: true,
    retention_days: 90, allow_cross_event_identity_graph: false,
    created_at: now, updated_at: now
  });

  const attendees = [
    { id: "att-ie-001", tenant_id: tenantId, created_at: now },
    { id: "att-ie-002", tenant_id: tenantId, created_at: now },
    { id: "att-ie-003", tenant_id: tenantId, created_at: now },
    { id: "att-ie-004", tenant_id: tenantId, created_at: now },
    { id: "att-ie-005", tenant_id: tenantId, created_at: now }
  ];

  const profiles = [
    { attendee_id: "att-ie-001", full_name: "Alice Chen",   company_name: "TechVentures Pvt Ltd", email: "alice@techventures.in",    phone: "+91-9812345001", updated_at: now },
    { attendee_id: "att-ie-002", full_name: "Bob Patel",    company_name: "Patel Industries",     email: "bob@patelindustries.com",   phone: "+91-9812345002", updated_at: now },
    { attendee_id: "att-ie-003", full_name: "Carol Smith",  company_name: "Global Exports",       email: "carol@globalexports.com",   phone: null,             updated_at: now },
    { attendee_id: "att-ie-004", full_name: "David Lee",    company_name: "Lee Capital",          email: "david@leecapital.sg",       phone: "+65-9812345004", updated_at: now },
    { attendee_id: "att-ie-005", full_name: "Emma Wilson",  company_name: "Wilson & Co",          email: "emma@wilsonco.co.uk",       phone: null,             updated_at: now }
  ];

  const tapEvents = [
    { id: "tap-ie-001", tenant_id: tenantId, event_id: eventId, stall_id: stallId, device_id: "device-01", local_event_id: "local-ie-001", tap_type: "card_uid",    reader_uid_hash: null, ndef_payload: null, occurred_at: now, created_at: now, cloud_received_at: now },
    { id: "tap-ie-002", tenant_id: tenantId, event_id: eventId, stall_id: stallId, device_id: "device-01", local_event_id: "local-ie-002", tap_type: "card_uid",    reader_uid_hash: null, ndef_payload: null, occurred_at: now, created_at: now, cloud_received_at: now },
    { id: "tap-ie-003", tenant_id: tenantId, event_id: eventId, stall_id: stallId, device_id: "device-01", local_event_id: "local-ie-003", tap_type: "phone_ndef",  reader_uid_hash: null, ndef_payload: null, occurred_at: now, created_at: now, cloud_received_at: now },
    { id: "tap-ie-004", tenant_id: tenantId, event_id: eventId, stall_id: stallId, device_id: "device-01", local_event_id: "local-ie-004", tap_type: "card_uid",    reader_uid_hash: null, ndef_payload: null, occurred_at: now, created_at: now, cloud_received_at: now },
    { id: "tap-ie-005", tenant_id: tenantId, event_id: eventId, stall_id: stallId, device_id: "device-01", local_event_id: "local-ie-005", tap_type: "phone_ndef",  reader_uid_hash: null, ndef_payload: null, occurred_at: now, created_at: now, cloud_received_at: now }
  ];

  const interactions = [
    { id: "int-ie-001", tenant_id: tenantId, event_id: eventId, stall_id: stallId, tap_event_id: "tap-ie-001", attendee_id: "att-ie-001", captured_by_user_id: null, status: "active",     consent_status: "vendor_only",       classification: "warm", sponsor_click_count: 2, created_at: now, updated_at: now },
    { id: "int-ie-002", tenant_id: tenantId, event_id: eventId, stall_id: stallId, tap_event_id: "tap-ie-002", attendee_id: "att-ie-002", captured_by_user_id: null, status: "active",     consent_status: "vendor_and_sponsor", classification: "hot",  sponsor_click_count: 5, created_at: now, updated_at: now },
    { id: "int-ie-003", tenant_id: tenantId, event_id: eventId, stall_id: stallId, tap_event_id: "tap-ie-003", attendee_id: "att-ie-003", captured_by_user_id: null, status: "anonymized", consent_status: "declined",          classification: "cold", sponsor_click_count: 0, created_at: now, updated_at: now },
    { id: "int-ie-004", tenant_id: tenantId, event_id: eventId, stall_id: stallId, tap_event_id: "tap-ie-004", attendee_id: "att-ie-004", captured_by_user_id: null, status: "active",     consent_status: "vendor_only",       classification: "warm", sponsor_click_count: 1, created_at: now, updated_at: now },
    { id: "int-ie-005", tenant_id: tenantId, event_id: eventId, stall_id: stallId, tap_event_id: "tap-ie-005", attendee_id: "att-ie-005", captured_by_user_id: null, status: "active",     consent_status: "vendor_and_sponsor", classification: "hot",  sponsor_click_count: 3, created_at: now, updated_at: now }
  ];

  const consents = [
    { interaction_id: "int-ie-001", tenant_id: tenantId, attendee_id: "att-ie-001", vendor_release_allowed: true,  sponsor_release_allowed: false, revoked_at: null, updated_at: now },
    { interaction_id: "int-ie-002", tenant_id: tenantId, attendee_id: "att-ie-002", vendor_release_allowed: true,  sponsor_release_allowed: true,  revoked_at: null, updated_at: now },
    { interaction_id: "int-ie-003", tenant_id: tenantId, attendee_id: "att-ie-003", vendor_release_allowed: false, sponsor_release_allowed: false, revoked_at: null, updated_at: now },
    { interaction_id: "int-ie-004", tenant_id: tenantId, attendee_id: "att-ie-004", vendor_release_allowed: true,  sponsor_release_allowed: false, revoked_at: null, updated_at: now },
    { interaction_id: "int-ie-005", tenant_id: tenantId, attendee_id: "att-ie-005", vendor_release_allowed: true,  sponsor_release_allowed: true,  revoked_at: null, updated_at: now }
  ];

  const consentEvents = [
    { id: "ce-ie-001", interaction_id: "int-ie-001", tenant_id: tenantId, action: "capture", vendor_release_allowed: true,  sponsor_release_allowed: false, locale: "en-IN", ip_address: "203.0.113.10", user_agent: "Mozilla/5.0 Kiosk", created_at: now },
    { id: "ce-ie-002", interaction_id: "int-ie-002", tenant_id: tenantId, action: "capture", vendor_release_allowed: true,  sponsor_release_allowed: true,  locale: "en-IN", ip_address: "203.0.113.11", user_agent: "Mozilla/5.0 Kiosk", created_at: now },
    { id: "ce-ie-003", interaction_id: "int-ie-003", tenant_id: tenantId, action: "capture", vendor_release_allowed: false, sponsor_release_allowed: false, locale: "en-IN", ip_address: "203.0.113.12", user_agent: "Mozilla/5.0 Kiosk", created_at: now },
    { id: "ce-ie-004", interaction_id: "int-ie-004", tenant_id: tenantId, action: "capture", vendor_release_allowed: true,  sponsor_release_allowed: false, locale: "en-IN", ip_address: "203.0.113.13", user_agent: "Mozilla/5.0 Kiosk", created_at: now },
    { id: "ce-ie-005", interaction_id: "int-ie-005", tenant_id: tenantId, action: "capture", vendor_release_allowed: true,  sponsor_release_allowed: true,  locale: "en-IN", ip_address: "203.0.113.14", user_agent: "Mozilla/5.0 Kiosk", created_at: now }
  ];

  state.attendees.push(...attendees);
  state.attendeeProfiles.push(...profiles);
  state.tapEvents.push(...tapEvents);
  state.interactions.push(...interactions);
  state.consents.push(...consents);
  state.consentEvents.push(...consentEvents);
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
