#!/usr/bin/env node
// Seed demo data into Railway PostgreSQL.
// Idempotent: all INSERTs use ON CONFLICT DO NOTHING.
// Run: node apps/api/scripts/seed-demo.mjs

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;

// ── Load DATABASE_URL from .env ───────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env");
const envText = readFileSync(envPath, "utf8");
const match = envText.match(/^DATABASE_URL=(.+)$/m);
if (!match) { console.error("DATABASE_URL not found in .env"); process.exit(1); }
const DATABASE_URL = match[1].trim();

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function run(sql, params = []) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

function sha256(token) {
  return createHash("sha256").update(token).digest("hex");
}

// ── Seed data ─────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();

// Pre-computed scrypt hashes for "TestPass123!" (N=16384, r=8, p=1)
const DEMO_PW = {
  admin:     "scrypt:6587faeb928ce73b183b0ddff568af88:4745d449af7aea1fa46c579f41d9d77489515e216997ac7a3cf1c749e3e7543f4192804e62226f29ba41563a40649547b84d62b5356108ee491d1a788db62dcf",
  organizer: "scrypt:a38f4c2f3280493876ae4277333006d8:c6a85006bdd0bc4dc30c1820cc7b99672248da0f10aa437f1d0387a356281396973478618c056b7777c6c0570d371978a88da9319e046c616fdbb475c3247293",
  vendor:    "scrypt:826a82e5f0118eb797e2d8919a9cd738:20a6dea8f9f0a4bd19d3be3c0cd75702c9e980b17524eaba9da7ba723397e4fef3035c397edbafb01f4bdc09528f1ca399763ef87d3d4cbf10d8dc1e583bea36",
  sponsor:   "scrypt:e6b16e68b9db01438ed727704f2d4111:a0fedff85e5eb6bd641486ca1b7f8542560b0ff88b2e32bf5dd9b943629a5a275a7d25633df37198cb99ef167611f9b3ae76edc309c5bcad34068f4b60e4ea07",
  ops:       "scrypt:8bd69e7a7415e27bc401455683c85c49:d31d9c30d364680aa4653c60ba86c95cc1d3fc50aa85578dea39b43e7b21707000665555a6e132a4a47386cad47e4646554696e2c42f7e2678d05570a3909bd3",
};

// Tenant
const TENANT_ID = "tenant-demo";

// Org IDs
const ORG_ORGANIZER = "org-organizer";
const ORG_VENDOR    = "org-vendor";
const ORG_SPONSOR   = "org-sponsor";
const ORG_PLATFORM  = "org-platform";

// Event IDs
const EVENT_DEMO     = "event-demo";
const EVENT_SECONDARY = "event-other";
const EVENT_IE       = "event-indiaexpo";

// Hall IDs
const HALL_MAIN      = "hall-main";
const HALL_SECONDARY = "hall-secondary";
const HALL_A         = "hall-a";

// Stall IDs
const STALL_A1       = "stall-a1";
const STALL_A2       = "stall-a2";
const STALL_B1       = "stall-b1";
const STALL_IE_A1    = "stall-ie-a1";
const STALL_IE_A2    = "stall-ie-a2";
const STALL_IE_A3    = "stall-ie-a3";

// Device
const DEVICE_01      = "device-01";

// Sponsor package
const PKG_GOLD_IE    = "pkg-gold-ie";

// Demo users
const USER_ADMIN     = "demo-admin";
const USER_ORGANIZER = "demo-organizer";
const USER_VENDOR    = "demo-vendor";
const USER_SPONSOR   = "demo-sponsor";
const USER_OPS       = "demo-ops";

// Non-demo fixture users (needed for FK references in role assignments)
const USER_ORG       = "user-organizer";
const USER_VND       = "user-vendor";
const USER_SPO       = "user-sponsor";
const USER_OPS_FX    = "user-ops";
const USER_PLT1      = "user-platform-1";
const USER_PLT2      = "user-platform-2";
const USER_PLT3      = "user-platform-3";

// ── 1. Tenant ─────────────────────────────────────────────────────────────────
async function seedTenant() {
  await run(
    `INSERT INTO tenants (id, slug, name, data_residency_zone, offboarding_status, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [TENANT_ID, "demo", "Demo Tenant", "global", "active", NOW]
  );
  console.log("✓ tenant");
}

// ── 2. Organizations ──────────────────────────────────────────────────────────
async function seedOrganizations() {
  const orgs = [
    [ORG_ORGANIZER, TENANT_ID, "organizer", "Demo Organizer"],
    [ORG_VENDOR,    TENANT_ID, "vendor",    "Northfield Estates"],
    [ORG_SPONSOR,   TENANT_ID, "sponsor",   "Orbit Capital"],
    [ORG_PLATFORM,  TENANT_ID, "platform",  "Platform Operations"],
  ];
  for (const [id, tid, type, name] of orgs) {
    await run(
      `INSERT INTO organizations (id, tenant_id, type, name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [id, tid, type, name]
    );
  }
  console.log("✓ organizations (4)");
}

// ── 3. Users ──────────────────────────────────────────────────────────────────
async function seedUsers() {
  // Fixture users (no password hash — login via token only in tests)
  const fixtures = [
    [USER_ORG,  TENANT_ID, ORG_ORGANIZER, "organizer@example.com",  "Morgan Organizer", "organizer_admin"],
    [USER_VND,  TENANT_ID, ORG_VENDOR,    "vendor@example.com",     "Val Vendor",       "vendor_manager"],
    [USER_SPO,  TENANT_ID, ORG_SPONSOR,   "sponsor@example.com",    "Sia Sponsor",      "sponsor_user"],
    [USER_OPS_FX, TENANT_ID, ORG_PLATFORM,"ops@example.com",        "Omar Ops",         "ops_user"],
    [USER_PLT1, TENANT_ID, ORG_PLATFORM,  "platform1@example.com",  "Priya Platform",   "platform_admin"],
    [USER_PLT2, TENANT_ID, ORG_PLATFORM,  "platform2@example.com",  "Pavel Platform",   "platform_admin"],
    [USER_PLT3, TENANT_ID, ORG_PLATFORM,  "platform3@example.com",  "Nadia Platform",   "platform_admin"],
  ];
  for (const [id, tid, oid, email, name, role] of fixtures) {
    await run(
      `INSERT INTO users (id, tenant_id, organization_id, email, display_name, role, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [id, tid, oid, email, name, role, NOW]
    );
  }

  // Demo users with password hashes (password: TestPass123!)
  const demos = [
    [USER_ADMIN,     TENANT_ID, ORG_PLATFORM,  "admin@test.com",     "Admin User",     "platform_admin",  DEMO_PW.admin],
    [USER_ORGANIZER, TENANT_ID, ORG_ORGANIZER, "organizer@test.com", "Organizer User", "organizer_admin", DEMO_PW.organizer],
    [USER_VENDOR,    TENANT_ID, ORG_VENDOR,    "vendor@test.com",    "Vendor User",    "vendor_manager",  DEMO_PW.vendor],
    [USER_SPONSOR,   TENANT_ID, ORG_SPONSOR,   "sponsor@test.com",   "Sponsor User",   "sponsor_user",    DEMO_PW.sponsor],
    [USER_OPS,       TENANT_ID, ORG_PLATFORM,  "ops@test.com",       "Ops User",       "ops_user",        DEMO_PW.ops],
  ];
  for (const [id, tid, oid, email, name, role, pw] of demos) {
    await run(
      `INSERT INTO users (id, tenant_id, organization_id, email, display_name, role, password_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [id, tid, oid, email, name, role, pw, NOW]
    );
  }
  console.log("✓ users (12)");
}

// ── 4. Events ─────────────────────────────────────────────────────────────────
async function seedEvents() {
  const events = [
    [EVENT_DEMO,      TENANT_ID, ORG_ORGANIZER, "Expo Pilot 2026",      "live"],
    [EVENT_SECONDARY, TENANT_ID, ORG_ORGANIZER, "Expo Secondary 2026",  "draft"],
    [EVENT_IE,        TENANT_ID, ORG_ORGANIZER, "IndiaExpo 2026",       "live"],
  ];
  for (const [id, tid, oid, name, status] of events) {
    await run(
      `INSERT INTO events (id, tenant_id, organizer_organization_id, name, status, starts_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [id, tid, oid, name, status, NOW]
    );
  }
  console.log("✓ events (3)");
}

// ── 5. Halls ──────────────────────────────────────────────────────────────────
async function seedHalls() {
  const halls = [
    [HALL_MAIN,      TENANT_ID, EVENT_DEMO,      "Main Hall"],
    [HALL_SECONDARY, TENANT_ID, EVENT_SECONDARY, "Secondary Hall"],
    [HALL_A,         TENANT_ID, EVENT_IE,        "Hall A"],
  ];
  for (const [id, tid, eid, name] of halls) {
    await run(
      `INSERT INTO halls (id, tenant_id, event_id, name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [id, tid, eid, name]
    );
  }
  console.log("✓ halls (3)");
}

// ── 6. Stalls ─────────────────────────────────────────────────────────────────
async function seedStalls() {
  const stalls = [
    [STALL_A1,    TENANT_ID, EVENT_DEMO,      HALL_MAIN,      ORG_VENDOR, ORG_SPONSOR, "A1", "Northfield Estates"],
    [STALL_A2,    TENANT_ID, EVENT_DEMO,      HALL_MAIN,      ORG_VENDOR, ORG_SPONSOR, "A2", "Northfield Annex"],
    [STALL_B1,    TENANT_ID, EVENT_SECONDARY, HALL_SECONDARY, ORG_VENDOR, ORG_SPONSOR, "B1", "Northfield Secondary"],
    [STALL_IE_A1, TENANT_ID, EVENT_IE,        HALL_A,         ORG_VENDOR, ORG_SPONSOR, "A1", "Tech Pavilion A1"],
    [STALL_IE_A2, TENANT_ID, EVENT_IE,        HALL_A,         ORG_VENDOR, ORG_SPONSOR, "A2", "Innovation Hub A2"],
    [STALL_IE_A3, TENANT_ID, EVENT_IE,        HALL_A,         ORG_VENDOR, ORG_SPONSOR, "A3", "Startup Zone A3"],
  ];
  for (const [id, tid, eid, hid, vorg, sorg, code, name] of stalls) {
    await run(
      `INSERT INTO stalls (id, tenant_id, event_id, hall_id, vendor_organization_id, sponsor_organization_id, code, name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [id, tid, eid, hid, vorg, sorg, code, name]
    );
  }
  console.log("✓ stalls (6)");
}

// ── 7. Sponsor packages ───────────────────────────────────────────────────────
async function seedSponsorPackages() {
  await run(
    `INSERT INTO sponsor_packages (id, tenant_id, event_id, name, tier, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
    [PKG_GOLD_IE, TENANT_ID, EVENT_IE, "Gold", "gold", NOW]
  );
  console.log("✓ sponsor packages (1)");
}

// ── 8. Event data policies ────────────────────────────────────────────────────
async function seedEventPolicies() {
  const policies = [
    [EVENT_DEMO,      TENANT_ID, true,  false, true,  true,  30,  false],
    [EVENT_SECONDARY, TENANT_ID, true,  false, true,  false, 30,  false],
    [EVENT_IE,        TENANT_ID, true,  true,  false, true,  90,  false],
  ];
  for (const [eid, tid, ve, sp, ra, crm, rd, cig] of policies) {
    await run(
      `INSERT INTO event_data_policies
         (event_id, tenant_id, vendor_exports_enabled, sponsor_pii_enabled,
          require_export_approval, allow_crm_push, retention_days, allow_cross_event_identity_graph)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [eid, tid, ve, sp, ra, crm, rd, cig]
    );
  }
  console.log("✓ event data policies (3)");
}

// ── 9. Device ─────────────────────────────────────────────────────────────────
async function seedDevice() {
  const leaseExpires = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
  await run(
    `INSERT INTO devices (id, tenant_id, serial_number, status, config_lease_expires_at)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [DEVICE_01, TENANT_ID, "SN-001", "live", leaseExpires]
  );
  console.log("✓ device (1)");
}

// ── 10. Device assignment ─────────────────────────────────────────────────────
async function seedDeviceAssignment() {
  await run(
    `INSERT INTO device_assignments (id, tenant_id, device_id, event_id, stall_id, active, assignment_checksum)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    ["assign-01", TENANT_ID, DEVICE_01, EVENT_DEMO, STALL_A1, true,
     "35c70991fa13d0f72cfb1d1d721e46f582c32f78f181f47ebad2dc1f0f779545"]
  );
  console.log("✓ device assignment (1)");
}

// ── 11. Device credential ─────────────────────────────────────────────────────
async function seedDeviceCredential() {
  const tokenHash = sha256("dvc_seed_device_01");
  await run(
    `INSERT INTO device_credentials (id, tenant_id, device_id, credential_label, token_hash, status, created_by_user_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
    ["cred-device-01", TENANT_ID, DEVICE_01, "Seed kiosk credential", tokenHash, "active", USER_ORG, NOW]
  );
  console.log("✓ device credential (1)");
}

// ── 12. User role assignments ─────────────────────────────────────────────────
async function seedUserRoleAssignments() {
  const uras = [
    ["ura-organizer-event-demo", TENANT_ID, USER_ORG,       "organizer_admin", EVENT_DEMO, null,         null,        USER_PLT1],
    ["ura-vendor-stall-a1",      TENANT_ID, USER_VND,       "vendor_manager",  EVENT_DEMO, null,         null,        USER_ORG],
    ["ura-platform-admin",       TENANT_ID, USER_PLT1,      "platform_admin",  null,       null,         null,        USER_PLT1],
    ["ura-demo-admin",           TENANT_ID, USER_ADMIN,     "platform_admin",  null,       null,         null,        USER_ADMIN],
    ["ura-demo-organizer",       TENANT_ID, USER_ORGANIZER, "organizer_admin", EVENT_IE,   null,         null,        USER_ADMIN],
    ["ura-demo-vendor",          TENANT_ID, USER_VENDOR,    "vendor_manager",  EVENT_IE,   null,         null,        USER_ORGANIZER],
    ["ura-demo-sponsor",         TENANT_ID, USER_SPONSOR,   "sponsor_user",    EVENT_IE,   null,         PKG_GOLD_IE, USER_ORGANIZER],
    ["ura-demo-ops",             TENANT_ID, USER_OPS,       "ops_user",        EVENT_IE,   null,         null,        USER_ADMIN],
  ];
  for (const [id, tid, uid, role, eid, _stallIds, pkgId, assignedBy] of uras) {
    await run(
      `INSERT INTO user_role_assignments
         (id, tenant_id, user_id, role, event_id, stall_ids, sponsor_package_id, assigned_by_user_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [id, tid, uid, role, eid, [], pkgId, assignedBy, NOW]
    );
  }
  // Vendor stall scoping stored in stall_ids array
  await run(
    `UPDATE user_role_assignments SET stall_ids = $1 WHERE id = $2`,
    [[STALL_A1], "ura-vendor-stall-a1"]
  );
  await run(
    `UPDATE user_role_assignments SET stall_ids = $1 WHERE id = $2`,
    [[STALL_IE_A1], "ura-demo-vendor"]
  );
  console.log("✓ user role assignments (8)");
}

// ── 13. User access scopes ────────────────────────────────────────────────────
async function seedUserAccessScopes() {
  const scopes = [
    ["scope-organizer-event-demo", TENANT_ID, USER_ORG,       EVENT_DEMO, null,        null],
    ["scope-vendor-stall-a1",      TENANT_ID, USER_VND,       EVENT_DEMO, STALL_A1,    null],
    ["scope-sponsor-event-demo",   TENANT_ID, USER_SPO,       EVENT_DEMO, null,        ORG_SPONSOR],
    ["scope-demo-admin",           TENANT_ID, USER_ADMIN,     null,       null,        null],
    ["scope-demo-organizer",       TENANT_ID, USER_ORGANIZER, EVENT_IE,   null,        null],
    ["scope-demo-vendor-a1",       TENANT_ID, USER_VENDOR,    EVENT_IE,   STALL_IE_A1, null],
    ["scope-demo-sponsor",         TENANT_ID, USER_SPONSOR,   EVENT_IE,   null,        ORG_SPONSOR],
    ["scope-demo-ops",             TENANT_ID, USER_OPS,       EVENT_IE,   null,        null],
  ];
  for (const [id, tid, uid, eid, sid, soid] of scopes) {
    await run(
      `INSERT INTO user_access_scopes (id, tenant_id, user_id, event_id, stall_id, sponsor_organization_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [id, tid, uid, eid, sid, soid, NOW]
    );
  }
  console.log("✓ user access scopes (8)");
}

// ── 14. Attendees + profiles ──────────────────────────────────────────────────
async function seedAttendees() {
  const attendees = [
    ["att-ie-001", TENANT_ID],
    ["att-ie-002", TENANT_ID],
    ["att-ie-003", TENANT_ID],
    ["att-ie-004", TENANT_ID],
    ["att-ie-005", TENANT_ID],
  ];
  for (const [id, tid] of attendees) {
    await run(
      `INSERT INTO attendees (id, tenant_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [id, tid, NOW]
    );
  }

  const profiles = [
    ["att-ie-001", "Alice Chen",   "TechVentures Pvt Ltd", "alice@techventures.in",  "+91-9812345001"],
    ["att-ie-002", "Bob Patel",    "Patel Industries",     "bob@patelindustries.com","+91-9812345002"],
    ["att-ie-003", "Carol Smith",  "Global Exports",       "carol@globalexports.com", null],
    ["att-ie-004", "David Lee",    "Lee Capital",          "david@leecapital.sg",    "+65-9812345004"],
    ["att-ie-005", "Emma Wilson",  "Wilson & Co",          "emma@wilsonco.co.uk",     null],
  ];
  for (const [aid, name, company, email, phone] of profiles) {
    await run(
      `INSERT INTO attendee_profiles (attendee_id, full_name, company_name, email, phone, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [aid, name, company, email, phone, NOW]
    );
  }
  console.log("✓ attendees + profiles (5)");
}

// ── 15. Tap events ────────────────────────────────────────────────────────────
async function seedTapEvents() {
  const taps = [
    ["tap-ie-001", TENANT_ID, EVENT_IE, STALL_IE_A1, DEVICE_01, "local-ie-001", "card_uid"],
    ["tap-ie-002", TENANT_ID, EVENT_IE, STALL_IE_A1, DEVICE_01, "local-ie-002", "card_uid"],
    ["tap-ie-003", TENANT_ID, EVENT_IE, STALL_IE_A1, DEVICE_01, "local-ie-003", "phone_ndef"],
    ["tap-ie-004", TENANT_ID, EVENT_IE, STALL_IE_A1, DEVICE_01, "local-ie-004", "card_uid"],
    ["tap-ie-005", TENANT_ID, EVENT_IE, STALL_IE_A1, DEVICE_01, "local-ie-005", "phone_ndef"],
  ];
  for (const [id, tid, eid, sid, did, lid, tapType] of taps) {
    await run(
      `INSERT INTO tap_events (id, tenant_id, event_id, stall_id, device_id, local_event_id, tap_type, occurred_at, created_at, cloud_received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [id, tid, eid, sid, did, lid, tapType, NOW, NOW, NOW]
    );
  }
  console.log("✓ tap events (5)");
}

// ── 16. Interactions ──────────────────────────────────────────────────────────
async function seedInteractions() {
  const interactions = [
    ["int-ie-001", TENANT_ID, EVENT_IE, STALL_IE_A1, "tap-ie-001", "att-ie-001", "active",     "vendor_only",        "warm", 2],
    ["int-ie-002", TENANT_ID, EVENT_IE, STALL_IE_A1, "tap-ie-002", "att-ie-002", "active",     "vendor_and_sponsor", "hot",  5],
    ["int-ie-003", TENANT_ID, EVENT_IE, STALL_IE_A1, "tap-ie-003", "att-ie-003", "anonymized", "declined",           "cold", 0],
    ["int-ie-004", TENANT_ID, EVENT_IE, STALL_IE_A1, "tap-ie-004", "att-ie-004", "active",     "vendor_only",        "warm", 1],
    ["int-ie-005", TENANT_ID, EVENT_IE, STALL_IE_A1, "tap-ie-005", "att-ie-005", "active",     "vendor_and_sponsor", "hot",  3],
  ];
  for (const [id, tid, eid, sid, teid, aid, status, consent_status, cls, clicks] of interactions) {
    await run(
      `INSERT INTO interactions
         (id, tenant_id, event_id, stall_id, tap_event_id, attendee_id, status, consent_status, classification, sponsor_click_count, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [id, tid, eid, sid, teid, aid, status, consent_status, cls, clicks, NOW, NOW]
    );
  }
  console.log("✓ interactions (5)");
}

// ── 17. Consents ──────────────────────────────────────────────────────────────
async function seedConsents() {
  const consents = [
    ["int-ie-001", TENANT_ID, "att-ie-001", true,  false],
    ["int-ie-002", TENANT_ID, "att-ie-002", true,  true],
    ["int-ie-003", TENANT_ID, "att-ie-003", false, false],
    ["int-ie-004", TENANT_ID, "att-ie-004", true,  false],
    ["int-ie-005", TENANT_ID, "att-ie-005", true,  true],
  ];
  for (const [iid, tid, aid, vendor, sponsor] of consents) {
    await run(
      `INSERT INTO consents (interaction_id, tenant_id, attendee_id, vendor_release_allowed, sponsor_release_allowed, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [iid, tid, aid, vendor, sponsor, NOW]
    );
  }
  console.log("✓ consents (5)");
}

// ── 18. Consent events ────────────────────────────────────────────────────────
async function seedConsentEvents() {
  const events = [
    ["ce-ie-001", "int-ie-001", TENANT_ID, "capture", true,  false, "en-IN", "203.0.113.10"],
    ["ce-ie-002", "int-ie-002", TENANT_ID, "capture", true,  true,  "en-IN", "203.0.113.11"],
    ["ce-ie-003", "int-ie-003", TENANT_ID, "capture", false, false, "en-IN", "203.0.113.12"],
    ["ce-ie-004", "int-ie-004", TENANT_ID, "capture", true,  false, "en-IN", "203.0.113.13"],
    ["ce-ie-005", "int-ie-005", TENANT_ID, "capture", true,  true,  "en-IN", "203.0.113.14"],
  ];
  for (const [id, iid, tid, action, vendor, sponsor, locale, ip] of events) {
    await run(
      `INSERT INTO consent_events (id, interaction_id, tenant_id, action, vendor_release_allowed, sponsor_release_allowed, locale, ip_address, user_agent, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [id, iid, tid, action, vendor, sponsor, locale, ip, "Mozilla/5.0 Kiosk", NOW]
    );
  }
  console.log("✓ consent events (5)");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("Seeding demo data into Railway PostgreSQL…\n");
  try {
    await seedTenant();
    await seedOrganizations();
    await seedUsers();
    await seedEvents();
    await seedHalls();
    await seedStalls();
    await seedSponsorPackages();
    await seedEventPolicies();
    await seedDevice();
    await seedDeviceAssignment();
    await seedDeviceCredential();
    await seedUserRoleAssignments();
    await seedUserAccessScopes();
    await seedAttendees();
    await seedTapEvents();
    await seedInteractions();
    await seedConsents();
    await seedConsentEvents();
    console.log("\nSeed complete. Login: admin@test.com / TestPass123!");
  } catch (err) {
    console.error("\nSeed failed:", err.message);
    if (err.detail) console.error("Detail:", err.detail);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
