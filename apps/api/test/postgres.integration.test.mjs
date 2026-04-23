import assert from "node:assert/strict";
import test from "node:test";
import { createSign, generateKeyPairSync } from "node:crypto";

import { createApp } from "../src/app.mjs";
import { createIotCertificationHealthRunner } from "../src/iot/certification-health-runner.mjs";
import { createPostgresDatabase } from "../src/db/postgres.mjs";
import { defaultMigrationsDir, runMigrations } from "../src/db/migrator.mjs";
import { resetDatabase } from "../src/db/reset.mjs";
import { seedDemoData } from "../src/db/seed-demo.mjs";
import { createMockIotApp } from "../src/iot/mock-app.mjs";
import { HttpError } from "../src/http-error.mjs";
import { createIotDeviceOpsSyncService } from "../src/iot/device-ops-sync-service.mjs";
import { createIotHeartbeatSyncService } from "../src/iot/heartbeat-sync-service.mjs";
import { createIotIntegrationOrchestrator } from "../src/iot/integration-orchestrator.mjs";
import { createIotIncidentSyncService } from "../src/iot/incident-sync-service.mjs";
import { createIotPlatformAdapter } from "../src/iot/platform-adapter.mjs";
import { createIotTapSyncService } from "../src/iot/tap-sync-service.mjs";

const databaseUrl = process.env.DATABASE_URL;
const migratorDatabaseUrl = process.env.MIGRATOR_DATABASE_URL ?? databaseUrl;
const pgTest = databaseUrl ? test : test.skip;

async function resetAndSeed() {
  const db = await createPostgresDatabase({ connectionString: migratorDatabaseUrl });
  try {
    await resetDatabase(db);
    await runMigrations(db, defaultMigrationsDir());
    await seedDemoData(db);
  } finally {
    await db.close();
  }
}

function createInjectFetch(app) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.href ?? String(input));
    const response = await app.inject({
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : {}
    });

    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      async json() {
        return response.body;
      }
    };
  };
}

function createDispatchFetch(routes) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.href ?? String(input));
    const handler = routes[url.host];
    if (!handler) {
      throw new Error(`No fetch handler configured for host ${url.host}`);
    }

    if (typeof handler === "function") {
      return handler(url, init);
    }

    return createInjectFetch(handler)(url, init);
  };
}

function createMockOidcIssuer({
  issuer = "https://issuer.example.com",
  audience = "physical-world-interaction-platform",
  kid = "postgres-test-key"
} = {}) {
  const originalFetch = global.fetch;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = "RS256";

  global.fetch = async (url) => {
    if (String(url).endsWith("/.well-known/openid-configuration")) {
      return {
        ok: true,
        async json() {
          return {
            issuer,
            jwks_uri: `${issuer}/jwks`
          };
        }
      };
    }
    if (String(url) === `${issuer}/jwks`) {
      return {
        ok: true,
        async json() {
          return { keys: [jwk] };
        }
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  return {
    issuer,
    audience,
    createToken({ subject, email, expiresInSeconds = 300 }) {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT", kid })
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          sub: subject,
          aud: audience,
          exp: now + expiresInSeconds,
          iat: now,
          email
        })
      ).toString("base64url");
      const signer = createSign("RSA-SHA256");
      signer.update(`${header}.${payload}`);
      signer.end();
      return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
    },
    restore() {
      global.fetch = originalFetch;
    }
  };
}

pgTest("postgres backend persists tap and consent capture flows", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const tapResponse = await app.inject({
      method: "POST",
      path: "/interactions/tap",
      headers: { authorization: "Bearer device-token" },
      body: {
        device_id: "device-01",
        event_id: "event-demo",
        stall_id: "stall-a1",
        local_event_id: "pg-local-event-1",
        tap_type: "card_uid",
        reader_uid: "reader-001",
        occurred_at: "2026-04-17T12:00:00.000Z"
      }
    });

    assert.equal(tapResponse.statusCode, 201);
    assert.equal(tapResponse.body.result, "created");
    assert.equal(app.backend, "postgres");

    const captureResponse = await app.inject({
      method: "POST",
      path: "/consents/capture",
      body: {
        session_token: tapResponse.body.attendee_session_token,
        vendor_release_allowed: true,
        sponsor_release_allowed: false,
        attendee_profile: {
          full_name: "Asha Rao",
          company_name: "Acme Realty",
          email: "asha@example.com",
          phone: "+91-90000-00000"
        }
      }
    });

    assert.equal(captureResponse.statusCode, 200);
    assert.equal(captureResponse.body.consent_status, "vendor_only");

    const interaction = await app.repos.interactions.findById("tenant-demo", tapResponse.body.interaction_id);
    assert.equal(interaction.consent_status, "vendor_only");
    assert.ok(interaction.attendee_id);

    const consent = await app.repos.consents.findByInteractionId("tenant-demo", interaction.id);
    assert.equal(consent.vendor_release_allowed, true);
    assert.equal(consent.sponsor_release_allowed, false);

    const profile = await app.repos.attendeeProfiles.findByAttendeeId(interaction.attendee_id);
    assert.equal(profile.full_name, "Asha Rao");
    assert.equal(profile.email, "asha@example.com");
  } finally {
    await app.close();
  }
});

pgTest("postgres backend records denied-action audits", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const deniedResponse = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/overview",
      headers: { authorization: "Bearer vendor-token" }
    });

    assert.equal(deniedResponse.statusCode, 403);

    const auditLogs = await app.repos.auditLogs.listByTenant("tenant-demo");
    const deniedAudit = auditLogs.find((entry) => entry.event_type === "organizer.overview.view.denied");

    assert.ok(deniedAudit);
    assert.equal(deniedAudit.actor_id, "user-vendor");
    assert.equal(deniedAudit.target_id, "event-demo");
  } finally {
    await app.close();
  }
});

pgTest("postgres backend persists mandatory commercial partner governance records", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const partner = await app.inject({
      method: "POST",
      path: "/admin/commercial/partners",
      headers: { authorization: "Bearer platform-token" },
      body: {
        name: "Postgres Channel Partner",
        partner_type: "delivery_ecosystem_partner"
      }
    });

    assert.equal(partner.statusCode, 201);

    const deal = await app.inject({
      method: "POST",
      path: "/admin/commercial/deals",
      headers: { authorization: "Bearer platform-token" },
      body: {
        partner_id: partner.body.id,
        account_name: "Postgres Expo",
        stage: "demo_done",
        next_action: "Send proposal",
        next_action_at: "2026-04-24T09:00:00Z",
        offer_structure: "organizer_paid",
        commercial_positioning_ack: true
      }
    });

    assert.equal(deal.statusCode, 201);

    const payout = await app.inject({
      method: "POST",
      path: "/admin/commercial/payouts",
      headers: { authorization: "Bearer platform-token" },
      body: {
        partner_id: partner.body.id,
        deal_id: deal.body.id,
        amount_cents: 10000,
        status: "approved"
      }
    });

    assert.equal(payout.statusCode, 201);
    assert.ok(payout.body.approved_at);

    const paidPayout = await app.inject({
      method: "PATCH",
      path: `/admin/commercial/payouts/${payout.body.id}`,
      headers: { authorization: "Bearer platform-token" },
      body: {
        status: "paid",
        client_payment_received_at: "2026-04-25T09:00:00Z"
      }
    });

    assert.equal(paidPayout.statusCode, 200);
    assert.equal(paidPayout.body.status, "paid");

    const governance = await app.inject({
      method: "GET",
      path: "/admin/commercial/governance",
      headers: { authorization: "Bearer platform-token" }
    });

    assert.equal(governance.statusCode, 200);
    assert.equal(governance.body.summary.partners, 1);
    assert.equal(governance.body.summary.deals, 1);
    assert.equal(governance.body.summary.payouts_paid, 1);
  } finally {
    await app.close();
  }
});

pgTest("postgres backend persists DSR completion and retention lifecycle records", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const tapResponse = await app.inject({
      method: "POST",
      path: "/interactions/tap",
      headers: { authorization: "Bearer device-token" },
      body: {
        device_id: "device-01",
        event_id: "event-demo",
        stall_id: "stall-a1",
        local_event_id: "pg-dsr-1",
        tap_type: "qr",
        occurred_at: "2026-04-20T12:00:00.000Z"
      }
    });
    assert.equal(tapResponse.statusCode, 201);

    await app.inject({
      method: "POST",
      path: "/consents/capture",
      body: {
        session_token: tapResponse.body.attendee_session_token,
        vendor_release_allowed: true,
        sponsor_release_allowed: false,
        attendee_profile: {
          full_name: "PG Delete",
          company_name: "Acme Realty",
          email: "pg-delete@example.com"
        }
      }
    });

    const crmSync = await app.inject({
      method: "POST",
      path: `/interactions/${tapResponse.body.interaction_id}/crm-sync`,
      headers: { authorization: "Bearer vendor-token" },
      body: {}
    });
    assert.equal(crmSync.statusCode, 200);

    const created = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/dsr",
      headers: { authorization: "Bearer organizer-token" },
      body: {
        request_type: "delete",
        interaction_id: tapResponse.body.interaction_id,
        request_reason: "GDPR delete request"
      }
    });
    assert.equal(created.statusCode, 201);

    const completed = await app.inject({
      method: "POST",
      path: `/organizer/events/event-demo/dsr/${created.body.id}/complete`,
      headers: { authorization: "Bearer organizer-token" },
      body: {
        resolution_summary: "Deleted from event systems.",
        downstream_targets: ["crm"]
      }
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.body.downstream_deletions.length, 1);

    const event = await app.repos.events.findById("tenant-demo", "event-demo");
    await app.repos.events.update({
      ...event,
      status: "closed",
      ends_at: "2026-01-01T00:00:00.000Z"
    });

    const retention = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/compliance/retention",
      headers: { authorization: "Bearer organizer-token" },
      body: {
        mode: "apply"
      }
    });
    assert.equal(retention.statusCode, 200);

    const overview = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/compliance",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.body.event_status, "archived");
    assert.equal(overview.body.dsr_counts.completed, 1);

    const requests = await app.repos.dataSubjectRequests.listByEvent("tenant-demo", "event-demo");
    assert.equal(requests.length, 1);

    const runs = await app.repos.complianceRuns.listByEvent("tenant-demo", "event-demo");
    assert.ok(runs.some((entry) => entry.run_type === "retention_apply"));

    const crmRecord = await app.repos.crmSyncRecords.findByInteractionAndProvider(
      "tenant-demo",
      tapResponse.body.interaction_id,
      "pilot_crm"
    );
    assert.equal(crmRecord.status, "delete_pending");
    assert.equal(crmRecord.request_payload.redacted, true);
    assert.equal(crmRecord.request_payload.external_record_id, crmSync.body.external_record_id);
  } finally {
    await app.close();
  }
});

pgTest("postgres backend enforces user lifecycle status and records last login for OIDC users", async () => {
  await resetAndSeed();
  const oidc = createMockOidcIssuer();
  const app = await createApp({
    backend: "postgres",
    databaseUrl,
    oidc: {
      enabled: true,
      issuer: oidc.issuer,
      audience: oidc.audience
    }
  });

  try {
    const organizer = await app.repos.users.findById("tenant-demo", "user-organizer");
    await app.repos.users.update({
      ...organizer,
      external_identity_provider: oidc.issuer,
      external_subject: "pg-oidc-organizer"
    });

    const activeResponse = await app.inject({
      method: "GET",
      path: "/auth/me",
      headers: { authorization: `Bearer ${oidc.createToken({ subject: "pg-oidc-organizer", email: organizer.email })}` }
    });

    assert.equal(activeResponse.statusCode, 200);
    assert.equal(activeResponse.body.principal.user_status, "active");
    assert.ok(activeResponse.body.principal.last_login_at);

    const loggedInUser = await app.repos.users.findById("tenant-demo", "user-organizer");
    assert.ok(loggedInUser.last_login_at);

    await app.repos.users.update({
      ...loggedInUser,
      status: "disabled",
      disabled_at: new Date().toISOString(),
      disabled_reason: "Operator disabled access"
    });

    const deniedResponse = await app.inject({
      method: "GET",
      path: "/auth/me",
      headers: { authorization: `Bearer ${oidc.createToken({ subject: "pg-oidc-organizer", email: organizer.email })}` }
    });

    assert.equal(deniedResponse.statusCode, 403);
    assert.match(deniedResponse.body.error, /disabled/);

    const auditLogs = await app.repos.auditLogs.listByTenant("tenant-demo");
    const deniedAudit = auditLogs.filter((entry) => entry.event_type === "auth.me.view.denied").at(-1);
    assert.ok(deniedAudit);
    assert.equal(deniedAudit.actor_id, "user-organizer");
    assert.equal(deniedAudit.metadata.user_status, "disabled");
    assert.equal(deniedAudit.metadata.auth_reason, "user_status_disabled");
  } finally {
    oidc.restore();
    await app.close();
  }
});

pgTest("postgres backend supports platform-admin user management and scoped access assignments", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const created = await app.inject({
      method: "POST",
      path: "/admin/users",
      headers: { authorization: "Bearer platform-token" },
      body: {
        email: "pg-vendor-admin@example.com",
        display_name: "PG Vendor Admin",
        role: "vendor_manager",
        organization_id: "org-vendor"
      }
    });

    assert.equal(created.statusCode, 201);
    assert.equal(created.body.status, "pending_invite");

    const scope = await app.inject({
      method: "POST",
      path: `/admin/users/${created.body.id}/access-scopes`,
      headers: { authorization: "Bearer platform-token" },
      body: {
        event_id: "event-demo",
        stall_id: "stall-a1"
      }
    });

    assert.equal(scope.statusCode, 201);

    const detail = await app.inject({
      method: "GET",
      path: `/admin/users/${created.body.id}`,
      headers: { authorization: "Bearer platform-token" }
    });

    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.item.access_scope_count, 1);
    assert.equal(detail.body.item.organization_type, "vendor");

    const disabled = await app.inject({
      method: "POST",
      path: `/admin/users/${created.body.id}/disable`,
      headers: { authorization: "Bearer platform-token" },
      body: { reason: "PG disable check" }
    });

    assert.equal(disabled.statusCode, 200);
    assert.equal(disabled.body.status, "disabled");

    const revoked = await app.inject({
      method: "DELETE",
      path: `/admin/users/${created.body.id}/access-scopes/${scope.body.id}`,
      headers: { authorization: "Bearer platform-token" }
    });

    assert.equal(revoked.statusCode, 200);

    const deleted = await app.inject({
      method: "POST",
      path: `/admin/users/${created.body.id}/delete`,
      headers: { authorization: "Bearer platform-token" },
      body: { reason: "PG offboarding" }
    });

    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.status, "deleted");

    const users = await app.repos.users.listByTenant("tenant-demo");
    const managedUser = users.find((entry) => entry.id === created.body.id);
    assert.ok(managedUser);
    assert.equal(managedUser.status, "deleted");

    const scopes = await app.repos.userAccessScopes.listByUser("tenant-demo", created.body.id);
    assert.equal(scopes.length, 0);

    const auditLogs = await app.repos.auditLogs.listByTenant("tenant-demo");
    assert.ok(auditLogs.some((entry) => entry.event_type === "admin.user.created"));
    assert.ok(auditLogs.some((entry) => entry.event_type === "admin.user_scope.assigned"));
    assert.ok(auditLogs.some((entry) => entry.event_type === "admin.user.deleted"));
  } finally {
    await app.close();
  }
});

pgTest("postgres backend persists CRM sync records and dispatched downstream CRM deletions", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const tapResponse = await app.inject({
      method: "POST",
      path: "/interactions/tap",
      headers: { authorization: "Bearer device-token" },
      body: {
        device_id: "device-01",
        event_id: "event-demo",
        stall_id: "stall-a1",
        local_event_id: "pg-crm-sync-1",
        tap_type: "phone_ndef",
        occurred_at: "2026-04-20T13:00:00.000Z"
      }
    });
    assert.equal(tapResponse.statusCode, 201);

    await app.inject({
      method: "POST",
      path: "/consents/capture",
      body: {
        session_token: tapResponse.body.attendee_session_token,
        vendor_release_allowed: true,
        sponsor_release_allowed: false,
        attendee_profile: {
          full_name: "PG CRM",
          company_name: "Northfield Estates",
          email: "pg-crm@example.com"
        }
      }
    });

    const crmSync = await app.inject({
      method: "POST",
      path: `/interactions/${tapResponse.body.interaction_id}/crm-sync`,
      headers: { authorization: "Bearer vendor-token" },
      body: {}
    });
    assert.equal(crmSync.statusCode, 200);
    assert.equal(crmSync.body.status, "synced");

    const created = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/dsr",
      headers: { authorization: "Bearer organizer-token" },
      body: {
        request_type: "delete",
        interaction_id: tapResponse.body.interaction_id,
        request_reason: "Postgres CRM delete propagation"
      }
    });
    assert.equal(created.statusCode, 201);

    const completed = await app.inject({
      method: "POST",
      path: `/organizer/events/event-demo/dsr/${created.body.id}/complete`,
      headers: { authorization: "Bearer organizer-token" },
      body: {
        resolution_summary: "Queued CRM deletion.",
        downstream_targets: ["crm"]
      }
    });
    assert.equal(completed.statusCode, 200);
    assert.equal(completed.body.downstream_deletions.length, 1);

    const dispatched = await app.inject({
      method: "POST",
      path: `/organizer/events/event-demo/downstream-deletions/${completed.body.downstream_deletions[0].id}/dispatch`,
      headers: { authorization: "Bearer organizer-token" },
      body: {}
    });
    assert.equal(dispatched.statusCode, 200);
    assert.equal(dispatched.body.status, "confirmed");

    const record = await app.repos.crmSyncRecords.findByInteractionAndProvider(
      "tenant-demo",
      tapResponse.body.interaction_id,
      "pilot_crm"
    );
    assert.equal(record.status, "deleted");
    assert.ok(record.deleted_at);
  } finally {
    await app.close();
  }
});

pgTest("postgres backend dispatches webhook downstream deletions and exposes organizer CRM history", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const tapResponse = await app.inject({
      method: "POST",
      path: "/interactions/tap",
      headers: { authorization: "Bearer device-token" },
      body: {
        device_id: "device-01",
        event_id: "event-demo",
        stall_id: "stall-a1",
        local_event_id: "pg-webhook-delete-1",
        tap_type: "phone_ndef",
        occurred_at: "2026-04-20T13:20:00.000Z"
      }
    });
    assert.equal(tapResponse.statusCode, 201);

    await app.inject({
      method: "POST",
      path: "/consents/capture",
      body: {
        session_token: tapResponse.body.attendee_session_token,
        vendor_release_allowed: true,
        sponsor_release_allowed: false,
        attendee_profile: {
          full_name: "PG Webhook",
          company_name: "Event Bus Co",
          email: "pg-webhook@example.com"
        }
      }
    });

    await app.inject({
      method: "POST",
      path: `/interactions/${tapResponse.body.interaction_id}/crm-sync`,
      headers: { authorization: "Bearer vendor-token" },
      body: {}
    });

    const created = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/dsr",
      headers: { authorization: "Bearer organizer-token" },
      body: {
        request_type: "delete",
        interaction_id: tapResponse.body.interaction_id,
        request_reason: "Webhook propagation"
      }
    });
    assert.equal(created.statusCode, 201);

    const completed = await app.inject({
      method: "POST",
      path: `/organizer/events/event-demo/dsr/${created.body.id}/complete`,
      headers: { authorization: "Bearer organizer-token" },
      body: {
        resolution_summary: "Queued webhook delete.",
        downstream_targets: ["webhook_event_bus"]
      }
    });
    assert.equal(completed.statusCode, 200);

    const dispatched = await app.inject({
      method: "POST",
      path: `/organizer/events/event-demo/downstream-deletions/${completed.body.downstream_deletions[0].id}/dispatch`,
      headers: { authorization: "Bearer organizer-token" },
      body: {}
    });
    assert.equal(dispatched.statusCode, 200);
    assert.equal(dispatched.body.details.deletion_response.delivery_status, "delivered");

    const history = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/crm-sync",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.body.items.length, 1);
    assert.equal(history.body.items[0].provider, "pilot_crm");
  } finally {
    await app.close();
  }
});

pgTest("postgres backend exposes compliance reporting and compliance audit exports", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const tapResponse = await app.inject({
      method: "POST",
      path: "/interactions/tap",
      headers: { authorization: "Bearer device-token" },
      body: {
        device_id: "device-01",
        event_id: "event-demo",
        stall_id: "stall-a1",
        local_event_id: "pg-compliance-report-1",
        tap_type: "phone_ndef",
        occurred_at: "2026-04-20T13:45:00.000Z"
      }
    });
    assert.equal(tapResponse.statusCode, 201);

    await app.inject({
      method: "POST",
      path: "/consents/capture",
      body: {
        session_token: tapResponse.body.attendee_session_token,
        vendor_release_allowed: true,
        sponsor_release_allowed: false,
        attendee_profile: {
          full_name: "PG Compliance",
          company_name: "Northfield",
          email: "pg-compliance@example.com"
        }
      }
    });

    await app.inject({
      method: "POST",
      path: `/interactions/${tapResponse.body.interaction_id}/crm-sync`,
      headers: { authorization: "Bearer vendor-token" },
      body: {}
    });

    const report = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/compliance/report",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(report.statusCode, 200);
    assert.equal(report.body.event.id, "event-demo");
    assert.equal(report.body.crm_reporting.counts.synced, 1);

    const requested = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/compliance/audit-export",
      headers: { authorization: "Bearer organizer-token" },
      body: {}
    });
    assert.equal(requested.statusCode, 200);
    assert.equal(requested.body.filters.report_variant, "compliance_audit");

    const approved = await app.inject({
      method: "POST",
      path: `/exports/${requested.body.id}/approve`,
      headers: { authorization: "Bearer organizer-token" },
      body: {}
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.body.status, "generated");

    const downloaded = await app.inject({
      method: "GET",
      path: `/exports/${requested.body.id}/download`,
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.body.file_name, "event-event-demo-compliance-audit.json");
    assert.equal(downloaded.body.payload.event.id, "event-demo");
    assert.equal(downloaded.body.payload.crm_reporting.counts.synced, 1);
  } finally {
    await app.close();
  }
});

pgTest("postgres backend reports compliance closeout readiness and can become ready", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const initial = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/compliance/closeout-readiness",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.body.readiness.ready, false);

    const frozen = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/report-freeze",
      headers: { authorization: "Bearer organizer-token" },
      body: {
        note: "Postgres compliance closeout"
      }
    });
    assert.equal(frozen.statusCode, 200);

    const preview = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/compliance/retention",
      headers: { authorization: "Bearer organizer-token" },
      body: {
        mode: "preview"
      }
    });
    assert.equal(preview.statusCode, 200);

    const requested = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/compliance/audit-export",
      headers: { authorization: "Bearer organizer-token" },
      body: {}
    });
    assert.equal(requested.statusCode, 200);

    await app.inject({
      method: "POST",
      path: `/exports/${requested.body.id}/approve`,
      headers: { authorization: "Bearer organizer-token" },
      body: {}
    });

    const ready = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/compliance/closeout-readiness",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body.readiness.ready, true);
    assert.equal(ready.body.readiness.blockers.length, 0);
    assert.equal(ready.body.readiness.latest_compliance_audit_export.status, "generated");
  } finally {
    await app.close();
  }
});

pgTest("postgres backend reports pilot rehearsal evidence and can become ready", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });
  const tenantId = "tenant-demo";
  const eventId = "event-demo";
  const now = new Date().toISOString();

  try {
    const initial = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/pilot-rehearsal-report",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.body.rehearsal.ready, false);

    const event = await app.repos.events.findById(tenantId, eventId);
    await app.repos.events.update({
      ...event,
      status: "closed",
      ends_at: now,
      report_snapshot_version: 2
    });

    await app.repos.reportSnapshots.create({
      id: "pg-report-snapshot-rehearsal",
      tenant_id: tenantId,
      event_id: eventId,
      report_snapshot_version: 2,
      payload: {
        snapshot_type: "official_event_report",
        note: "PG pilot rehearsal freeze"
      },
      created_at: now
    });

    await app.repos.exportRequests.create({
      id: "pg-export-compliance-rehearsal",
      tenant_id: tenantId,
      event_id: eventId,
      requested_by_user_id: "user-organizer",
      requested_for_organization_id: "org-organizer",
      export_type: "organizer_event_report",
      filters: { report_variant: "compliance_audit" },
      row_count_estimate: 1,
      status: "generated",
      approval_required: true,
      approved_by_user_id: "user-organizer",
      approval_reason: "PG rehearsal approved",
      rejection_reason: null,
      file_url: "/exports/pg-export-compliance-rehearsal/download",
      file_expires_at: now,
      created_at: now
    });

    await app.repos.dataSubjectRequests.create({
      id: "pg-dsr-access-rehearsal",
      tenant_id: tenantId,
      event_id: eventId,
      attendee_id: null,
      interaction_id: null,
      request_type: "access",
      status: "completed",
      requested_by_user_id: "user-organizer",
      request_reason: "PG access rehearsal",
      resolution_summary: "Access package prepared",
      result_payload: {},
      created_at: now,
      updated_at: now,
      completed_at: now
    });

    await app.repos.dataSubjectRequests.create({
      id: "pg-dsr-delete-rehearsal",
      tenant_id: tenantId,
      event_id: eventId,
      attendee_id: null,
      interaction_id: null,
      request_type: "delete",
      status: "completed",
      requested_by_user_id: "user-organizer",
      request_reason: "PG delete rehearsal",
      resolution_summary: "Delete workflow completed",
      result_payload: {},
      created_at: now,
      updated_at: now,
      completed_at: now
    });

    await app.repos.downstreamDeletionRecords.create({
      id: "pg-downstream-rehearsal",
      tenant_id: tenantId,
      event_id: eventId,
      dsr_request_id: "pg-dsr-delete-rehearsal",
      target_system: "crm",
      status: "confirmed",
      requested_at: now,
      confirmed_at: now,
      details: {},
      last_error: null,
      updated_at: now
    });

    await app.repos.breakGlassAccess.create({
      id: "pg-break-glass-rehearsal",
      tenant_id: tenantId,
      requested_by_user_id: "user-platform-1",
      first_approved_by_user_id: "user-platform-2",
      second_approved_by_user_id: "user-platform-3",
      justification: "PG pilot rehearsal",
      access_scope: "masked_audit_only",
      status: "active",
      starts_at: now,
      expires_at: "2099-04-19T18:00:00.000Z",
      revoked_at: null,
      created_at: now
    });

    await app.repos.incidents.create({
      id: "pg-incident-rehearsal",
      tenant_id: tenantId,
      device_id: "device-01",
      event_id: eventId,
      stall_id: "stall-a1",
      severity: "P2",
      code: "reader_disconnect",
      message: "PG rehearsal incident",
      status: "resolved",
      assignment_checksum: "pg-rehearsal-checksum",
      metadata: {
        runbook_tracking: {
          runbook_reference: "RUNBOOK-PG-REHEARSAL",
          workaround_status: "validated"
        }
      },
      occurred_at: now,
      resolved_at: now,
      source_cursor: "pg-rehearsal-source",
      raw_payload: {},
      created_at: now
    });

    await app.repos.auditLogs.create({
      id: "pg-audit-rehearsal-incident-state",
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: "user-organizer",
      event_type: "organizer.incident_state.updated",
      target_type: "incident",
      target_id: "pg-incident-rehearsal",
      break_glass_access_id: null,
      metadata: {},
      created_at: now
    });
    await app.repos.auditLogs.create({
      id: "pg-audit-rehearsal-incident-runbook",
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: "user-organizer",
      event_type: "organizer.incident_runbook.updated",
      target_type: "incident",
      target_id: "pg-incident-rehearsal",
      break_glass_access_id: null,
      metadata: {},
      created_at: now
    });
    await app.repos.auditLogs.create({
      id: "pg-audit-rehearsal-break-glass",
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: "user-platform-3",
      event_type: "break_glass.approved",
      target_type: "break_glass",
      target_id: "pg-break-glass-rehearsal",
      break_glass_access_id: "pg-break-glass-rehearsal",
      metadata: {},
      created_at: now
    });

    const ready = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/pilot-rehearsal-report",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body.rehearsal.ready, true);
    assert.equal(ready.body.rehearsal.blockers.length, 0);
    assert.equal(ready.body.rehearsal.evidence.completed_delete_dsrs, 1);
  } finally {
    await app.close();
  }
});

pgTest("postgres backend aggregates pilot signoff readiness and exports the signoff pack", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });
  const tenantId = "tenant-demo";
  const eventId = "event-demo";
  const now = new Date().toISOString();

  try {
    const initial = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/pilot-signoff-pack",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.body.signoff.ready, false);

    await app.repos.iotCertificationStatuses.upsert({
      id: "pg-cert-signoff-demo",
      integration_name: "iot_platform",
      status: "certified",
      contract_version: "2026-04-17.1",
      environment: "staging",
      build_version: "iot-mock-2026.04.17.1",
      last_checked_at: now,
      last_certified_at: now,
      last_failure_at: null,
      last_failure_message: null,
      metadata: {},
      created_at: now,
      updated_at: now
    });
    await app.repos.iotIntegrationHealthStatuses.upsert({
      id: "pg-health-signoff-demo",
      integration_name: "iot_platform",
      tenant_id: tenantId,
      event_id: eventId,
      overall_status: "healthy",
      certification_status: "certified",
      contract_version: "2026-04-17.1",
      environment: "staging",
      build_version: "iot-mock-2026.04.17.1",
      checked_at: now,
      stale_after_seconds: 7200,
      warning_count: 0,
      warnings: [],
      metrics: {
        stream_warning_count: 0
      },
      created_at: now,
      updated_at: now
    });
    await app.repos.iotEnvironmentParityStatuses.upsert({
      id: "pg-parity-signoff-demo",
      integration_name: "iot_platform",
      tenant_id: tenantId,
      event_id: eventId,
      status: "passed",
      staging_contract_version: "2026-04-17.1",
      staging_environment: "staging",
      staging_build_version: "iot-mock-2026.04.17.1",
      production_contract_version: "2026-04-17.1",
      production_environment: "production",
      production_build_version: "iot-mock-2026.04.17.1",
      issues: [],
      details: {
        release_id: "pilot-2026-04-20"
      },
      checked_at: now,
      created_at: now,
      updated_at: now
    });
    await app.repos.iotIntegrationRuns.create({
      id: "pg-run-signoff-demo",
      integration_name: "iot_platform",
      tenant_id: tenantId,
      event_id: eventId,
      trigger_mode: "test",
      initiated_by: "postgres-test",
      status: "completed",
      step_count: 7,
      failed_step_count: 0,
      warning_count: 0,
      started_at: now,
      finished_at: now,
      error_summary: null,
      summary: {},
      steps: [],
      created_at: now,
      updated_at: now
    });

    const event = await app.repos.events.findById(tenantId, eventId);
    await app.repos.events.update({
      ...event,
      status: "closed",
      ends_at: now,
      report_snapshot_version: 2
    });

    await app.repos.reportSnapshots.create({
      id: "pg-report-snapshot-signoff",
      tenant_id: tenantId,
      event_id: eventId,
      report_snapshot_version: 2,
      payload: {
        snapshot_type: "official_event_report",
        note: "PG pilot signoff freeze"
      },
      created_at: now
    });

    await app.repos.exportRequests.create({
      id: "pg-export-official-signoff",
      tenant_id: tenantId,
      event_id: eventId,
      requested_by_user_id: "user-organizer",
      requested_for_organization_id: "org-organizer",
      export_type: "organizer_event_report",
      filters: {
        report_snapshot_id: "pg-report-snapshot-signoff"
      },
      row_count_estimate: 1,
      status: "generated",
      approval_required: true,
      approved_by_user_id: "user-organizer",
      approval_reason: "PG official signoff package",
      rejection_reason: null,
      file_url: "/exports/pg-export-official-signoff/download",
      file_expires_at: now,
      created_at: now
    });

    await app.repos.exportRequests.create({
      id: "pg-export-compliance-signoff",
      tenant_id: tenantId,
      event_id: eventId,
      requested_by_user_id: "user-organizer",
      requested_for_organization_id: "org-organizer",
      export_type: "organizer_event_report",
      filters: { report_variant: "compliance_audit" },
      row_count_estimate: 1,
      status: "generated",
      approval_required: true,
      approved_by_user_id: "user-organizer",
      approval_reason: "PG signoff approved",
      rejection_reason: null,
      file_url: "/exports/pg-export-compliance-signoff/download",
      file_expires_at: now,
      created_at: now
    });

    await app.repos.dataSubjectRequests.create({
      id: "pg-dsr-access-signoff",
      tenant_id: tenantId,
      event_id: eventId,
      attendee_id: null,
      interaction_id: null,
      request_type: "access",
      status: "completed",
      requested_by_user_id: "user-organizer",
      request_reason: "PG access signoff",
      resolution_summary: "Access package prepared",
      result_payload: {},
      created_at: now,
      updated_at: now,
      completed_at: now
    });
    await app.repos.dataSubjectRequests.create({
      id: "pg-dsr-delete-signoff",
      tenant_id: tenantId,
      event_id: eventId,
      attendee_id: null,
      interaction_id: null,
      request_type: "delete",
      status: "completed",
      requested_by_user_id: "user-organizer",
      request_reason: "PG delete signoff",
      resolution_summary: "Delete workflow completed",
      result_payload: {},
      created_at: now,
      updated_at: now,
      completed_at: now
    });
    await app.repos.downstreamDeletionRecords.create({
      id: "pg-downstream-signoff",
      tenant_id: tenantId,
      event_id: eventId,
      dsr_request_id: "pg-dsr-delete-signoff",
      target_system: "crm",
      status: "confirmed",
      requested_at: now,
      confirmed_at: now,
      details: {},
      last_error: null,
      updated_at: now
    });
    await app.repos.complianceRuns.create({
      id: "pg-compliance-run-signoff",
      tenant_id: tenantId,
      event_id: eventId,
      run_type: "retention_preview",
      status: "completed",
      summary: {
        interactions_to_anonymize: 0
      },
      created_at: now
    });
    await app.repos.breakGlassAccess.create({
      id: "pg-break-glass-signoff",
      tenant_id: tenantId,
      requested_by_user_id: "user-platform-1",
      first_approved_by_user_id: "user-platform-2",
      second_approved_by_user_id: "user-platform-3",
      justification: "PG pilot signoff",
      access_scope: "masked_audit_only",
      status: "active",
      starts_at: now,
      expires_at: "2099-04-19T18:00:00.000Z",
      revoked_at: null,
      created_at: now
    });
    await app.repos.incidents.create({
      id: "pg-incident-signoff",
      tenant_id: tenantId,
      device_id: "device-01",
      event_id: eventId,
      stall_id: "stall-a1",
      severity: "P2",
      code: "reader_disconnect",
      message: "PG signoff incident",
      status: "resolved",
      assignment_checksum: "pg-signoff-checksum",
      metadata: {
        runbook_tracking: {
          runbook_reference: "RUNBOOK-PG-SIGNOFF",
          workaround_status: "validated"
        }
      },
      occurred_at: now,
      resolved_at: now,
      source_cursor: "pg-signoff-source",
      raw_payload: {},
      created_at: now
    });
    await app.repos.auditLogs.create({
      id: "pg-audit-signoff-incident-state",
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: "user-organizer",
      event_type: "organizer.incident_state.updated",
      target_type: "incident",
      target_id: "pg-incident-signoff",
      break_glass_access_id: null,
      metadata: {},
      created_at: now
    });
    await app.repos.auditLogs.create({
      id: "pg-audit-signoff-incident-runbook",
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: "user-organizer",
      event_type: "organizer.incident_runbook.updated",
      target_type: "incident",
      target_id: "pg-incident-signoff",
      break_glass_access_id: null,
      metadata: {},
      created_at: now
    });
    await app.repos.auditLogs.create({
      id: "pg-audit-signoff-break-glass",
      tenant_id: tenantId,
      actor_type: "user",
      actor_id: "user-platform-3",
      event_type: "break_glass.approved",
      target_type: "break_glass",
      target_id: "pg-break-glass-signoff",
      break_glass_access_id: "pg-break-glass-signoff",
      metadata: {},
      created_at: now
    });

    const ready = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/pilot-signoff-pack",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.body.signoff.ready, true);
    assert.equal(ready.body.signoff.blockers.length, 0);
    assert.equal(ready.body.signoff.sections.iot_go_live.ready, true);
    assert.equal(ready.body.signoff.sections.pilot_rehearsal.ready, true);
    assert.equal(ready.body.signoff.sections.compliance_closeout.ready, true);

    const requested = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/pilot-signoff-export",
      headers: { authorization: "Bearer organizer-token" },
      body: {}
    });
    assert.equal(requested.statusCode, 200);
    assert.equal(requested.body.filters.report_variant, "pilot_signoff");

    const approved = await app.inject({
      method: "POST",
      path: `/exports/${requested.body.id}/approve`,
      headers: { authorization: "Bearer organizer-token" },
      body: {}
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.body.status, "generated");

    const downloaded = await app.inject({
      method: "GET",
      path: `/exports/${requested.body.id}/download`,
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(downloaded.statusCode, 200);
    assert.equal(downloaded.body.file_name, "event-event-demo-pilot-signoff.json");
    assert.equal(downloaded.body.payload.ready, true);

    const executionBlocked = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/pilot-go-live-execution",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(executionBlocked.statusCode, 200);
    assert.equal(executionBlocked.body.execution.ready, false);

    const dryRun = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/pilot-go-live-dry-run",
      headers: { authorization: "Bearer organizer-token" },
      body: {
        status: "completed",
        note: "Postgres staging dry run completed cleanly",
        summary: {
          all_checks_passed: true
        }
      }
    });
    assert.equal(dryRun.statusCode, 200);

    for (const [role, label] of [
      ["organizer", "Morgan Organizer"],
      ["platform", "Platform owner"],
      ["iot", "IoT owner"]
    ]) {
      const approval = await app.inject({
        method: "POST",
        path: "/organizer/events/event-demo/pilot-go-live-approvals",
        headers: { authorization: "Bearer organizer-token" },
        body: {
          approver_role: role,
          approver_label: label,
          approval_status: "approved",
          note: `${label} approved the staging dry run`
        }
      });
      assert.equal(approval.statusCode, 200);
    }

    const executionReady = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/pilot-go-live-execution",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(executionReady.statusCode, 200);
    assert.equal(executionReady.body.execution.ready, true);
    assert.equal(executionReady.body.execution.approvals.length, 3);

    const finalBlocked = await app.inject({
      method: "GET",
      path: "/admin/events/event-demo/final-go-live",
      headers: { authorization: "Bearer platform-token" }
    });
    assert.equal(finalBlocked.statusCode, 200);
    assert.equal(finalBlocked.body.launch.ready, false);
    assert.ok(finalBlocked.body.launch.blockers.some((entry) => entry.includes("Platform admin approval")));

    await app.repos.breakGlassAccess.update({
      ...(await app.repos.breakGlassAccess.findById(tenantId, "pg-break-glass-signoff")),
      status: "revoked",
      revoked_at: now
    });

    for (const [role, label] of [
      ["platform_admin", "Platform admin"],
      ["organizer_owner", "Organizer owner"],
      ["security_owner", "Security owner"],
      ["business_owner", "Business owner"]
    ]) {
      const finalApproval = await app.inject({
        method: "POST",
        path: "/admin/events/event-demo/final-go-live/approvals",
        headers: { authorization: "Bearer platform-token" },
        body: {
          approver_role: role,
          approver_label: label,
          approval_status: "approved",
          note: `${label} approved final production launch`
        }
      });
      assert.equal(finalApproval.statusCode, 200);
    }

    const finalReady = await app.inject({
      method: "GET",
      path: "/admin/events/event-demo/final-go-live",
      headers: { authorization: "Bearer platform-token" }
    });
    assert.equal(finalReady.statusCode, 200);
    assert.equal(finalReady.body.launch.ready, true);
    assert.equal(finalReady.body.launch.sections.joint_go_live_execution.ready, true);

    const finalExport = await app.inject({
      method: "POST",
      path: "/admin/events/event-demo/final-go-live/export",
      headers: { authorization: "Bearer platform-token" },
      body: {}
    });
    assert.equal(finalExport.statusCode, 200);
    assert.equal(finalExport.body.file_name, "event-event-demo-final-go-live-package.json");
    assert.equal(finalExport.body.payload.ready, true);
  } finally {
    await app.close();
  }
});

pgTest("postgres backend authenticates provisioned device credentials", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const provision = await app.inject({
      method: "POST",
      path: "/devices/device-01/credentials/provision",
      headers: { authorization: "Bearer organizer-token" },
      body: {
        credential_label: "Postgres integration tablet"
      }
    });

    assert.equal(provision.statusCode, 201);

    const config = await app.inject({
      method: "GET",
      path: "/device/config/device-01",
      headers: { authorization: `Bearer ${provision.body.bearer_token}` }
    });

    assert.equal(config.statusCode, 200);
    assert.equal(config.body.device_id, "device-01");
  } finally {
    await app.close();
  }
});

pgTest("postgres runtime role and RLS block raw cross-tenant reads", async () => {
  await resetAndSeed();
  const db = await createPostgresDatabase({ connectionString: migratorDatabaseUrl });

  try {
    await db.query(
      `INSERT INTO audit_logs (
        id, tenant_id, actor_type, actor_id, event_type, target_type, target_id, break_glass_access_id, metadata, created_at
      ) VALUES (
        'audit-demo-1', 'tenant-demo', 'system', 'seed', 'demo.audit', 'seed', 'seed', null, '{}'::jsonb, now()
      )
      ON CONFLICT (id) DO NOTHING`
    );
    await db.query(
      `INSERT INTO tenants (id, slug, name, created_at)
       VALUES ('tenant-other', 'other', 'Other Tenant', now())
       ON CONFLICT (id) DO NOTHING`
    );
    await db.query(
      `INSERT INTO audit_logs (
        id, tenant_id, actor_type, actor_id, event_type, target_type, target_id, break_glass_access_id, metadata, created_at
      ) VALUES (
        'audit-other-1', 'tenant-other', 'system', 'seed', 'other.audit', 'seed', 'seed', null, '{}'::jsonb, now()
      )
      ON CONFLICT (id) DO NOTHING`
    );

    const scoped = await db.queryWithContext(
      {
        tenantId: "tenant-demo",
        actorId: "user-organizer",
        actorRole: "organizer_admin",
        databaseRole: "app_runtime"
      },
      "SELECT DISTINCT tenant_id FROM audit_logs ORDER BY tenant_id"
    );

    assert.deepEqual(scoped.rows.map((row) => row.tenant_id), ["tenant-demo"]);
  } finally {
    await db.close();
  }
});

pgTest("postgres runtime role cannot update or delete audit log evidence", async () => {
  await resetAndSeed();
  const db = await createPostgresDatabase({ connectionString: migratorDatabaseUrl });

  try {
    await db.query(
      `INSERT INTO audit_logs (
        id, tenant_id, actor_type, actor_id, event_type, target_type, target_id, break_glass_access_id, metadata, created_at
      ) VALUES (
        'audit-immutable-1', 'tenant-demo', 'system', 'seed', 'security.audit_immutability.test', 'seed', 'seed', null, '{}'::jsonb, now()
      )
      ON CONFLICT (id) DO NOTHING`
    );

    const context = {
      tenantId: "tenant-demo",
      actorId: "user-platform-1",
      actorRole: "platform_admin",
      databaseRole: "app_runtime"
    };

    await assert.rejects(
      () => db.queryWithContext(context, "UPDATE audit_logs SET event_type = $1 WHERE id = $2", [
        "security.audit_immutability.tampered",
        "audit-immutable-1"
      ]),
      /permission denied/i
    );
    await assert.rejects(
      () => db.queryWithContext(context, "DELETE FROM audit_logs WHERE id = $1", ["audit-immutable-1"]),
      /permission denied/i
    );

    const evidence = await db.query("SELECT event_type FROM audit_logs WHERE id = $1", ["audit-immutable-1"]);
    assert.equal(evidence.rows[0].event_type, "security.audit_immutability.test");
  } finally {
    await db.close();
  }
});

pgTest("postgres backend persists external pen-test findings and remediation status", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });

  try {
    const created = await app.inject({
      method: "POST",
      path: "/admin/security/pentest/findings",
      headers: { authorization: "Bearer platform-token" },
      body: {
        title: "External tester found stale staging origin",
        severity: "critical",
        category: "cors",
        affected_area: "API gateway",
        evidence: {
          origin: "https://old-staging.example.com"
        }
      }
    });
    assert.equal(created.statusCode, 201);

    const listed = await app.inject({
      method: "GET",
      path: "/admin/security/pentest/findings",
      headers: { authorization: "Bearer platform-token" }
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.body.summary.blocking, 1);

    const updated = await app.inject({
      method: "PATCH",
      path: `/admin/security/pentest/findings/${created.body.item.id}`,
      headers: { authorization: "Bearer platform-token" },
      body: {
        status: "accepted_risk",
        accepted_risk_reason: "Temporary staging-only exception approved for retest window"
      }
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.body.item.status, "accepted_risk");

    const finalList = await app.inject({
      method: "GET",
      path: "/admin/security/pentest/findings",
      headers: { authorization: "Bearer platform-token" }
    });
    assert.equal(finalList.body.summary.blocking, 0);
  } finally {
    await app.close();
  }
});

pgTest("postgres-backed IoT tap sync runner persists interactions, checkpoints, and certification status", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });
  const mockIotApp = await createMockIotApp();

  try {
    const adapter = createIotPlatformAdapter({
      baseUrl: "http://iot-mock.local",
      expectedContractVersion: "2026-04-17.1",
      expectedEnvironment: "staging",
      fetchImpl: createInjectFetch(mockIotApp)
    });

    const service = createIotTapSyncService({
      adapter,
      repos: app.repos,
      pageLimit: 2
    });

    const firstRun = await service.runOnce();
    assert.equal(firstRun.created, 3);
    assert.equal(firstRun.duplicates, 1);

    const secondRun = await service.runOnce();
    assert.equal(secondRun.processed, 0);

    const interactions = await app.repos.interactions.listByEvent("tenant-demo", "event-demo");
    assert.equal(interactions.length, 3);

    const checkpoint = await app.repos.iotSyncCheckpoints.findByIntegrationAndStream("iot_platform", "taps");
    assert.equal(checkpoint.last_cursor, "tap-cursor-1012");
    assert.equal(checkpoint.last_contract_version, "2026-04-17.1");

    const certification = await app.repos.iotCertificationStatuses.findByIntegration("iot_platform");
    assert.equal(certification.status, "certified");
    assert.equal(certification.contract_version, "2026-04-17.1");
  } finally {
    await app.close();
  }
});

pgTest("postgres-backed tap sync keeps checkpoint pinned on partial-page ingest failure", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });
  const mockIotApp = await createMockIotApp();

  try {
    const baseAdapter = createIotPlatformAdapter({
      baseUrl: "http://iot-mock.local",
      expectedContractVersion: "2026-04-17.1",
      expectedEnvironment: "staging",
      fetchImpl: createInjectFetch(mockIotApp)
    });

    let breakSecondItem = true;
    const adapter = {
      ...baseAdapter,
      async listTapEvents(options = {}) {
        const page = await baseAdapter.listTapEvents(options);
        if (breakSecondItem && !options.afterCursor && page.items.length > 1) {
          return {
            ...page,
            items: page.items.map((item, index) =>
              index === 1
                ? {
                    ...item,
                    assignment_checksum: "broken-checksum"
                  }
                : item
            )
          };
        }
        return page;
      }
    };

    const service = createIotTapSyncService({
      adapter,
      repos: app.repos,
      pageLimit: 2
    });

    await assert.rejects(() => service.runOnce(), /assignment checksum mismatch/i);

    const failedCheckpoint = await app.repos.iotSyncCheckpoints.findByIntegrationAndStream("iot_platform", "taps");
    assert.equal(failedCheckpoint.last_cursor, null);
    assert.equal(failedCheckpoint.metadata.failed_cursor, "tap-cursor-1010");
    assert.equal(failedCheckpoint.metadata.failure_stage, "item_ingest");

    breakSecondItem = false;
    const recovery = await service.runOnce();
    assert.equal(recovery.created, 2);
    assert.equal(recovery.duplicates, 2);
  } finally {
    await app.close();
  }
});

pgTest("postgres-backed device ops sync persists organizer fleet snapshots", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });
  const mockIotApp = await createMockIotApp();

  try {
    const adapter = createIotPlatformAdapter({
      baseUrl: "http://iot-mock.local",
      expectedContractVersion: "2026-04-17.1",
      expectedEnvironment: "staging",
      fetchImpl: createInjectFetch(mockIotApp)
    });

    const service = createIotDeviceOpsSyncService({
      adapter,
      repos: app.repos
    });

    const summary = await service.runForEvent({
      tenantId: "tenant-demo",
      eventId: "event-demo"
    });
    assert.equal(summary.checked_devices, 1);

    const snapshot = await app.repos.iotDeviceStatusSnapshots.findByDevice(
      "tenant-demo",
      "iot_platform",
      "device-01"
    );
    assert.equal(snapshot.assignment_status, "matched");
    assert.equal(snapshot.open_incident_code, "READER_DISCONNECTED");

    const fleet = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/device-fleet",
      headers: { authorization: "Bearer organizer-token" }
    });

    assert.equal(fleet.statusCode, 200);
    assert.equal(fleet.body.items.length, 1);
    assert.equal(fleet.body.items[0].diagnostics_status, "degraded");
  } finally {
    await app.close();
  }
});

pgTest("postgres-backed IoT orchestrator persists run history and latest organizer run state", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });
  const mockIotApp = await createMockIotApp();

  try {
    const adapter = createIotPlatformAdapter({
      baseUrl: "http://iot-mock.local",
      expectedContractVersion: "2026-04-17.1",
      expectedEnvironment: "staging",
      fetchImpl: createInjectFetch(mockIotApp)
    });

    const orchestrator = createIotIntegrationOrchestrator({
      adapter,
      repos: app.repos
    });

    const run = await orchestrator.runForEvent({
      tenantId: "tenant-demo",
      eventId: "event-demo",
      triggerMode: "test",
      initiatedBy: "postgres-test"
    });

    assert.equal(run.step_count, 7);
    assert.ok(run.steps.some((entry) => entry.name === "tap_sync"));
    assert.ok(run.steps.some((entry) => entry.name === "parity_check"));

    const latestRun = await app.repos.iotIntegrationRuns.findLatestByEvent(
      "tenant-demo",
      "iot_platform",
      "event-demo"
    );
    assert.equal(latestRun.id, run.id);

    const routeResponse = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/iot-runs",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(routeResponse.statusCode, 200);
    assert.equal(routeResponse.body.items[0].id, run.id);
  } finally {
    await app.close();
  }
});

pgTest("postgres-backed organizer trigger persists parity state and alert records", async () => {
  await resetAndSeed();
  const stagingIotApp = await createMockIotApp();
  const productionIotApp = await createMockIotApp({
    environment: "production",
    buildVersion: "iot-mock-2026.04.18.9"
  });
  const app = await createApp({
    backend: "postgres",
    databaseUrl,
    iot: {
      baseUrl: "http://iot-staging.local",
      productionBaseUrl: "http://iot-production.local",
      fetchImpl: createDispatchFetch({
        "iot-staging.local": stagingIotApp,
        "iot-production.local": productionIotApp
      })
    }
  });

  try {
    await app.repos.iotCertificationStatuses.upsert({
      id: "cert-demo",
      integration_name: "iot_platform",
      status: "certified",
      contract_version: "2026-04-17.1",
      environment: "staging",
      build_version: "iot-mock-2026.04.17.1",
      last_checked_at: new Date().toISOString(),
      last_certified_at: new Date().toISOString(),
      last_failure_at: null,
      last_failure_message: null,
      metadata: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });

    const response = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/iot-parity/trigger",
      headers: { authorization: "Bearer organizer-token" }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.parity.status, "failed");

    const parity = await app.repos.iotEnvironmentParityStatuses.findByEvent(
      "tenant-demo",
      "iot_platform",
      "event-demo"
    );
    assert.equal(parity.status, "failed");

    const alerts = await app.repos.iotAlertEvents.listByEvent("tenant-demo", "event-demo", {
      status: "open",
      limit: 10
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].code, "IOT_PARITY_FAILED");
  } finally {
    await app.close();
  }
});

pgTest("postgres-backed go-live readiness reports parity manifest blockers", async () => {
  await resetAndSeed();
  const stagingIotApp = await createMockIotApp();
  const productionIotApp = await createMockIotApp({
    environment: "production",
    buildVersion: "iot-mock-2026.04.17.1"
  });
  const app = await createApp({
    backend: "postgres",
    databaseUrl,
    iot: {
      baseUrl: "http://iot-staging.local",
      productionBaseUrl: "http://iot-production.local",
      requireReleaseManifest: true,
      releaseManifest: {
        release_id: "pilot-2026-04-18",
        approved: false,
        iot_platform: {
          staging: {
            contract_version: "2026-04-17.1",
            build_version: "iot-mock-2026.04.17.1"
          },
          production: {
            contract_version: "2026-04-17.1",
            build_version: "iot-mock-2026.04.17.1"
          }
        }
      },
      fetchImpl: createDispatchFetch({
        "iot-staging.local": stagingIotApp,
        "iot-production.local": productionIotApp
      })
    }
  });

  try {
    const response = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/iot-runs/trigger",
      headers: { authorization: "Bearer organizer-token" }
    });
    assert.equal(response.statusCode, 200);

    const readiness = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/iot-go-live-readiness",
      headers: { authorization: "Bearer organizer-token" }
    });

    assert.equal(readiness.statusCode, 200);
    assert.equal(readiness.body.readiness.ready, false);
    assert.ok(
      readiness.body.readiness.blockers.some((entry) =>
        entry.includes("approved release manifest")
      )
    );
  } finally {
    await app.close();
  }
});

pgTest("postgres-backed health runner persists organizer IoT health warnings", async () => {
  await resetAndSeed();
  const app = await createApp({ backend: "postgres", databaseUrl });
  const mockIotApp = await createMockIotApp();

  try {
    const adapter = createIotPlatformAdapter({
      baseUrl: "http://iot-mock.local",
      expectedContractVersion: "2026-04-17.1",
      expectedEnvironment: "staging",
      fetchImpl: createInjectFetch(mockIotApp)
    });

    const tapService = createIotTapSyncService({
      adapter,
      repos: app.repos,
      pageLimit: 2
    });
    const heartbeatService = createIotHeartbeatSyncService({
      adapter,
      repos: app.repos,
      pageLimit: 1
    });
    const incidentService = createIotIncidentSyncService({
      adapter,
      repos: app.repos,
      pageLimit: 1
    });
    const deviceOpsService = createIotDeviceOpsSyncService({
      adapter,
      repos: app.repos
    });
    await tapService.runOnce();
    await heartbeatService.runOnce();
    await incidentService.runOnce();
    await deviceOpsService.runForEvent({
      tenantId: "tenant-demo",
      eventId: "event-demo"
    });

    const checkpoint = await app.repos.iotSyncCheckpoints.findByIntegrationAndStream("iot_platform", "taps");
    await app.repos.iotSyncCheckpoints.upsert({
      ...checkpoint,
      last_contract_version: "2025-12-01.1"
    });

    const runner = createIotCertificationHealthRunner({
      adapter,
      repos: app.repos
    });
    const health = await runner.runForEvent({
      tenantId: "tenant-demo",
      eventId: "event-demo",
      refreshDeviceOps: false
    });

    assert.equal(health.overall_status, "warning");
    assert.ok(health.warnings.some((entry) => entry.code === "TAPS_CONTRACT_DRIFT"));

    const routeResponse = await app.inject({
      method: "GET",
      path: "/organizer/events/event-demo/iot-health",
      headers: { authorization: "Bearer organizer-token" }
    });

    assert.equal(routeResponse.statusCode, 200);
    assert.equal(routeResponse.body.iot_integration.health.status, "warning");
    assert.ok(routeResponse.body.iot_integration.health.warnings.some((entry) => entry.code === "TAPS_CONTRACT_DRIFT"));
  } finally {
    await app.close();
  }
});
