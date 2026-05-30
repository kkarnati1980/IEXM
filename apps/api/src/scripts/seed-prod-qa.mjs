// SECURITY NOTICE:
// This script seeds well-known TEST credentials (password "TestPass123!" with
// hashes from store.mjs DEMO_PW). Do NOT run against any environment that
// holds real customer data. The seeded admin account is rotated to a random
// password immediately after first run (see docs/incident_logs/
// 2026-05-30_db_repopulation.md). Re-running this script against a
// production-data DB would overwrite that rotation and re-introduce the
// known-credential backdoor.
//
// The SEED_PROD_QA_CONFIRM env guard below is the run-time defense.

import { createPostgresDatabase } from "../db/postgres.mjs";
import { hashDeviceCredentialToken } from "../device-credentials.mjs";

// Run-guard: prevent accidental execution against unintended databases.
// To run this script, the operator must explicitly confirm tenant scope:
//   SEED_PROD_QA_CONFIRM=tenant-demo node apps/api/src/scripts/seed-prod-qa.mjs
if (process.env.SEED_PROD_QA_CONFIRM !== "tenant-demo") {
  console.error(
    "ERROR: refusing to run without explicit confirmation.\n" +
    "Set SEED_PROD_QA_CONFIRM=tenant-demo if you intend to seed the demo tenant.\n" +
    "This guard prevents accidental seed runs against unintended environments."
  );
  process.exit(1);
}

// Pre-computed scrypt hashes (password = "TestPass123!")
// Source: apps/api/src/store.mjs DEMO_PW — same N=16384,r=8,p=1,64-byte-key params
const PW = {
  admin:     "scrypt:6587faeb928ce73b183b0ddff568af88:4745d449af7aea1fa46c579f41d9d77489515e216997ac7a3cf1c749e3e7543f4192804e62226f29ba41563a40649547b84d62b5356108ee491d1a788db62dcf",
  organizer: "scrypt:a38f4c2f3280493876ae4277333006d8:c6a85006bdd0bc4dc30c1820cc7b99672248da0f10aa437f1d0387a356281396973478618c056b7777c6c0570d371978a88da9319e046c616fdbb475c3247293",
  vendor:    "scrypt:826a82e5f0118eb797e2d8919a9cd738:20a6dea8f9f0a4bd19d3be3c0cd75702c9e980b17524eaba9da7ba723397e4fef3035c397edbafb01f4bdc09528f1ca399763ef87d3d4cbf10d8dc1e583bea36",
  sponsor:   "scrypt:e6b16e68b9db01438ed727704f2d4111:a0fedff85e5eb6bd641486ca1b7f8542560b0ff88b2e32bf5dd9b943629a5a275a7d25633df37198cb99ef167611f9b3ae76edc309c5bcad34068f4b60e4ea07",
  ops:       "scrypt:8bd69e7a7415e27bc401455683c85c49:d31d9c30d364680aa4653c60ba86c95cc1d3fc50aa85578dea39b43e7b21707000665555a6e132a4a47386cad47e4646554696e2c42f7e2678d05570a3909bd3"
};

const now = new Date().toISOString();
const TENANT = "tenant-demo";

const db = await createPostgresDatabase({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true",
  sslRejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false"
});

try {
  await db.withTransaction(async (tx) => {
    const q = (sql, params) => tx.query(sql, params);

    // 1. Tenant
    await q(
      `INSERT INTO tenants (id, slug, name, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [TENANT, "demo", "Demo Tenant", now]
    );

    // 2. Organizations
    for (const [id, type, name] of [
      ["org-organizer", "organizer", "Demo Organizer"],
      ["org-vendor",    "vendor",    "Northfield Estates"],
      ["org-sponsor",   "sponsor",   "Orbit Capital"],
      ["org-platform",  "platform",  "Platform Operations"],
    ]) {
      await q(
        `INSERT INTO organizations (id, tenant_id, type, name, created_at)
         VALUES ($1, $2, $3, $4, now()) ON CONFLICT (id) DO NOTHING`,
        [id, TENANT, type, name]
      );
    }

    // 3. Users — AP-4 separation baked in at insert time (FIX-A: true no-op on re-run)
    const users = [
      { id: "demo-admin",           email: "admin@test.com",           name: "Admin User",     role: "platform_admin",  org: "org-platform",  editor: false, approver: false, pw: PW.admin },
      { id: "demo-organizer",       email: "organizer@test.com",       name: "Organizer User", role: "organizer_admin", org: "org-organizer", editor: false, approver: false, pw: PW.organizer },
      { id: "demo-vendor",          email: "vendor@test.com",          name: "Vendor User",    role: "vendor_manager",  org: "org-vendor",    editor: true,  approver: false, pw: PW.vendor },
      { id: "demo-vendor-approver", email: "vendor-approver@test.com", name: "Vendor Approver",role: "vendor_manager",  org: "org-vendor",    editor: false, approver: true,  pw: PW.vendor },
      { id: "demo-sponsor",         email: "sponsor@test.com",         name: "Sponsor User",   role: "sponsor_user",    org: "org-sponsor",   editor: false, approver: false, pw: PW.sponsor },
      { id: "demo-ops",             email: "ops@test.com",             name: "Ops User",       role: "ops_user",        org: "org-platform",  editor: false, approver: false, pw: PW.ops },
    ];
    for (const u of users) {
      await q(
        `INSERT INTO users (
           id, tenant_id, organization_id, email, display_name, role,
           status, password_hash, vendor_content_editor, vendor_content_approver, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, now())
         ON CONFLICT (id) DO NOTHING`,
        [u.id, TENANT, u.org, u.email, u.name, u.role, u.pw, u.editor, u.approver]
      );
    }

    // 4. Events (event-indiaexpo required: QA_EVENT_ID in seed-approver-user_v1_0.sh:68)
    for (const [id, name, status] of [
      ["event-demo",      "Expo Pilot 2026",     "live"],
      ["event-other",     "Expo Secondary 2026", "draft"],
      ["event-indiaexpo", "IndiaExpo 2026",      "live"],
    ]) {
      await q(
        `INSERT INTO events (
           id, tenant_id, organizer_organization_id, name, status,
           metrics_definition_version, report_snapshot_version, starts_at, ends_at, created_at
         ) VALUES ($1, $2, 'org-organizer', $3, $4, 1, 1, $5, null, now())
         ON CONFLICT (id) DO NOTHING`,
        [id, TENANT, name, status, now]
      );
    }

    // 5. Halls
    for (const [id, event_id, name] of [
      ["hall-main",      "event-demo",      "Main Hall"],
      ["hall-secondary", "event-other",     "Secondary Hall"],
      ["hall-a",         "event-indiaexpo", "Hall A"],
    ]) {
      await q(
        `INSERT INTO halls (id, tenant_id, event_id, name)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [id, TENANT, event_id, name]
      );
    }

    // 6. Stalls (stall-ie-a1 required: QA_STALL_ID in test-fixtures.sh:8)
    for (const [id, event_id, hall_id, code, name] of [
      ["stall-a1",    "event-demo",      "hall-main",      "A1", "Northfield Estates"],
      ["stall-a2",    "event-demo",      "hall-main",      "A2", "Northfield Annex"],
      ["stall-b1",    "event-other",     "hall-secondary", "B1", "Northfield Secondary"],
      ["stall-ie-a1", "event-indiaexpo", "hall-a",         "A1", "Tech Pavilion A1"],
      ["stall-ie-a2", "event-indiaexpo", "hall-a",         "A2", "Innovation Hub A2"],
      ["stall-ie-a3", "event-indiaexpo", "hall-a",         "A3", "Startup Zone A3"],
    ]) {
      await q(
        `INSERT INTO stalls (
           id, tenant_id, event_id, hall_id, vendor_organization_id,
           sponsor_organization_id, code, name
         ) VALUES ($1, $2, $3, $4, 'org-vendor', 'org-sponsor', $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [id, TENANT, event_id, hall_id, code, name]
      );
    }

    // 7. Event data policies
    for (const [event_id, require_approval, allow_crm, retention] of [
      ["event-demo",      true,  true,  30],
      ["event-other",     true,  false, 30],
      ["event-indiaexpo", false, true,  90],
    ]) {
      await q(
        `INSERT INTO event_data_policies (
           event_id, tenant_id, vendor_exports_enabled, sponsor_pii_enabled,
           require_export_approval, allow_crm_push, retention_days,
           allow_cross_event_identity_graph, created_at, updated_at
         ) VALUES ($1, $2, true, false, $3, $4, $5, false, $6, $6)
         ON CONFLICT (event_id) DO NOTHING`,
        [event_id, TENANT, require_approval, allow_crm, retention, now]
      );
    }

    // 8. Sponsor package — must precede user_role_assignments (FK: sponsor_package_id)
    await q(
      `INSERT INTO sponsor_packages (id, tenant_id, event_id, name, created_at)
       VALUES ('pkg-gold-ie', $1, 'event-indiaexpo', 'Gold', now())
       ON CONFLICT (id) DO NOTHING`,
      [TENANT]
    );

    // 9. Device
    await q(
      `INSERT INTO devices (id, tenant_id, serial_number, status, config_lease_expires_at)
       VALUES ('device-01', $1, 'SN-001', 'live', now() + interval '8 hours')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT]
    );

    // 10. Device assignment (device-01 → event-demo / stall-a1)
    await q(
      `INSERT INTO device_assignments (
         id, tenant_id, device_id, event_id, stall_id, active, assignment_checksum
       ) VALUES (
         'assign-01', $1, 'device-01', 'event-demo', 'stall-a1', true,
         '35c70991fa13d0f72cfb1d1d721e46f582c32f78f181f47ebad2dc1f0f779545'
       ) ON CONFLICT (id) DO NOTHING`,
      [TENANT]
    );

    // 11. User role assignments — all demo users scoped to event-indiaexpo
    //     stall_ids is TEXT[] — must use ARRAY[...] cast
    const ura = [
      { id: "ura-demo-admin",           user: "demo-admin",           role: "platform_admin",  event: null,             stalls: [],              pkg: null,          by: "demo-admin" },
      { id: "ura-demo-organizer",        user: "demo-organizer",       role: "organizer_admin", event: "event-indiaexpo", stalls: [],              pkg: null,          by: "demo-admin" },
      { id: "ura-demo-vendor",           user: "demo-vendor",          role: "vendor_manager",  event: "event-indiaexpo", stalls: ["stall-ie-a1"], pkg: null,          by: "demo-organizer" },
      { id: "ura-demo-vendor-approver",  user: "demo-vendor-approver", role: "vendor_manager",  event: "event-indiaexpo", stalls: ["stall-ie-a1"], pkg: null,          by: "demo-organizer" },
      { id: "ura-demo-sponsor",          user: "demo-sponsor",         role: "sponsor_user",    event: "event-indiaexpo", stalls: [],              pkg: "pkg-gold-ie", by: "demo-organizer" },
      { id: "ura-demo-ops",              user: "demo-ops",             role: "ops_user",        event: "event-indiaexpo", stalls: [],              pkg: null,          by: "demo-admin" },
    ];
    for (const r of ura) {
      await q(
        `INSERT INTO user_role_assignments (
           id, tenant_id, user_id, role, event_id, stall_ids,
           sponsor_package_id, assigned_by_user_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::TEXT[], $7, $8, now())
         ON CONFLICT (id) DO NOTHING`,
        [r.id, TENANT, r.user, r.role, r.event ?? null, r.stalls, r.pkg ?? null, r.by]
      );
    }

    // 12. User access scopes (legacy compat path read by buildUserPrincipal)
    //     demo-vendor-approver scope was absent from createSeedState() — added here
    const scopes = [
      { id: "scope-demo-admin",             user: "demo-admin",           event: null,             stall: null,          sponsor_org: null },
      { id: "scope-demo-organizer",          user: "demo-organizer",       event: "event-indiaexpo", stall: null,         sponsor_org: null },
      { id: "scope-demo-vendor-a1",          user: "demo-vendor",          event: "event-indiaexpo", stall: "stall-ie-a1", sponsor_org: null },
      { id: "scope-demo-vendor-approver-a1", user: "demo-vendor-approver", event: "event-indiaexpo", stall: "stall-ie-a1", sponsor_org: null },
      { id: "scope-demo-sponsor",            user: "demo-sponsor",         event: "event-indiaexpo", stall: null,         sponsor_org: "org-sponsor" },
      { id: "scope-demo-ops",                user: "demo-ops",             event: "event-indiaexpo", stall: null,         sponsor_org: null },
    ];
    for (const s of scopes) {
      await q(
        `INSERT INTO user_access_scopes (
           id, tenant_id, user_id, event_id, stall_id, sponsor_organization_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (id) DO NOTHING`,
        [s.id, TENANT, s.user, s.event ?? null, s.stall ?? null, s.sponsor_org ?? null]
      );
    }

    // 13. Device credential — token literal "dvc_seed_device_01", SHA256 hashed
    const tokenHash = hashDeviceCredentialToken("dvc_seed_device_01");
    await q(
      `INSERT INTO device_credentials (
         id, tenant_id, device_id, credential_label, token_hash, status,
         created_by_user_id, revoked_by_user_id, last_used_at, revoked_at, created_at
       ) VALUES (
         'cred-device-01', $1, 'device-01', 'Seed kiosk credential', $2, 'active',
         'demo-organizer', null, null, null, now()
       ) ON CONFLICT (id) DO NOTHING`,
      [TENANT, tokenHash]
    );

    // 14. Consent version
    await q(
      `INSERT INTO consent_versions (
         id, tenant_id, version_number, effective_from, retention_period_days,
         grievance_officer_email, data_residency_zones, is_cross_border_transfer,
         created_by_user_id, created_at
       ) VALUES ('cv-v1-demo', $1, 1, $2, 365, 'grievance@kiot.io', ARRAY['IN']::TEXT[], false, null, $2)
       ON CONFLICT (id) DO NOTHING`,
      [TENANT, now]
    );

    // 15. App config
    await q(
      `INSERT INTO app_config (
         tenant_id, deployment_region, is_cross_border_transfer,
         data_controller_name, grievance_officer_email,
         retention_period_days, updated_at
       ) VALUES ($1, 'IN', false, 'Demo Tenant', 'grievance@kiot.io', 365, $2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [TENANT, now]
    );
  });

  console.log("QA seed complete — all records inserted idempotently (ON CONFLICT DO NOTHING)");
} finally {
  await db.close();
}
