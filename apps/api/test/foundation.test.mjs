import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { createRouter } from "../src/router.mjs";
import { registerRoutes } from "../src/routes.mjs";
import { validateRouteMatrixCoverage } from "../src/access-control.mjs";
import { sendNotificationWithProvider } from "../src/notification-providers.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function signWebhookPayload(payload, secret, timestamp) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${stableJson(payload)}`)
    .digest("hex");
}

function stableJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

async function createQueuedEmailFollowup(app, {
  localEventId,
  email = "worker@example.com",
  body = "Queued follow-up for outbound queue testing."
}) {
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: localEventId,
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:00:00Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  const consent = await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      communication_channel_consents: {
        email: true
      },
      attendee_profile: {
        full_name: "Queue Worker",
        company_name: "Outbound Ops",
        email
      }
    }
  });
  assert.equal(consent.statusCode, 200);

  const queued = await app.inject({
    method: "POST",
    path: `/interactions/${tap.body.interaction_id}/followups`,
    headers: bearer("vendor-token"),
    body: {
      channel: "email",
      body,
      status: "queued",
      human_approved: true
    }
  });
  assert.equal(queued.statusCode, 201);
  return { tap, queued };
}

function createMockOidcIssuer({
  issuer = "https://issuer.example.com",
  audience = "physical-world-interaction-platform",
  kid = "test-key"
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
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
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
    if (String(url) === `${issuer}/token`) {
      return {
        ok: true,
        async json() {
          return {
            access_token: "mock-browser-access-token",
            token_type: "Bearer",
            expires_in: 300
          };
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

test("access-control matrix covers every route and mirrors route role gates", () => {
  const router = createRouter();
  registerRoutes(router);
  const validation = validateRouteMatrixCoverage(router.routes);

  assert.deepEqual(validation.missing, []);
  assert.deepEqual(validation.stale, []);
  assert.deepEqual(validation.role_mismatches, []);
});

test("tap sync is idempotent by device_id and local_event_id", async () => {
  const app = await createApp();

  const first = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "local-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:00:00Z"
    }
  });

  const second = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "local-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:00:00Z"
    }
  });

  assert.equal(first.statusCode, 201);
  assert.equal(first.body.result, "created");
  assert.equal(second.body.result, "duplicate_existing");
  assert.equal(app.state.tapEvents.length, 1);
  assert.equal(app.state.interactions.length, 1);
});

test("vendor lead view is masked until consent exists", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "local-2",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:01:00Z"
    }
  });

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    headers: { "x-tenant-id": "tenant-demo" },
    body: {
      interaction_id: tap.body.interaction_id,
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: false,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Alice Walker",
        company_name: "Northfield Estates",
        email: "alice@example.com"
      }
    }
  });

  const leads = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads",
    headers: bearer("vendor-token")
  });

  assert.equal(leads.statusCode, 200);
  assert.equal(leads.body.items[0].full_name, "Masked until consent");
  assert.equal(leads.body.items[0].masked, true);
  assert.equal(leads.body.items[0].privacy.pii_visible, false);
  assert.equal(leads.body.items[0].privacy.reason, "vendor_consent_required");
});

test("vendor lead view is unmasked when vendor consent exists", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "local-3",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:02:00Z"
    }
  });

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    headers: { "x-tenant-id": "tenant-demo" },
    body: {
      interaction_id: tap.body.interaction_id,
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Alice Walker",
        company_name: "Northfield Estates",
        email: "alice@example.com"
      }
    }
  });

  const leads = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads",
    headers: bearer("vendor-token")
  });

  assert.equal(leads.body.items[0].full_name, "Alice Walker");
  assert.equal(leads.body.items[0].masked, false);
  assert.equal(leads.body.items[0].privacy.pii_visible, true);
});

test("vendor lead inbox exposes required columns, filters, and pagination", async () => {
  const app = await createApp();

  async function createLead({ localEventId, occurredAt, profile, vendorConsent = true, classification = null }) {
    const tap = await app.inject({
      method: "POST",
      path: "/interactions/tap",
      headers: bearer("device-token"),
      body: {
        device_id: "device-01",
        event_id: "event-demo",
        stall_id: "stall-a1",
        local_event_id: localEventId,
        tap_type: "phone_ndef",
        occurred_at: occurredAt
      }
    });

    await app.inject({
      method: "POST",
      path: "/consents/capture",
      headers: { "x-tenant-id": "tenant-demo" },
      body: {
        interaction_id: tap.body.interaction_id,
        session_token: tap.body.attendee_session_token,
        vendor_release_allowed: vendorConsent,
        sponsor_release_allowed: false,
        attendee_profile: profile
      }
    });
    const interaction = app.state.interactions.find((entry) => entry.id === tap.body.interaction_id);
    interaction.created_at = occurredAt;
    interaction.updated_at = occurredAt;

    if (classification) {
      await app.inject({
        method: "POST",
        path: `/interactions/${tap.body.interaction_id}/classify`,
        headers: bearer("vendor-token"),
        body: { classification }
      });
    }

    return tap.body.interaction_id;
  }

  const firstId = await createLead({
    localEventId: "page-local-1",
    occurredAt: "2026-04-17T10:00:00Z",
    profile: { full_name: "Ari One", company_name: "A Co", email: "ari@example.com" }
  });
  const secondId = await createLead({
    localEventId: "page-local-2",
    occurredAt: "2026-04-17T10:01:00Z",
    profile: { full_name: "Bea Two", company_name: "B Co", email: "bea@example.com" },
    classification: "hot"
  });
  await createLead({
    localEventId: "page-local-3",
    occurredAt: "2026-04-17T10:02:00Z",
    profile: { full_name: "Cal Three", company_name: "C Co", email: "cal@example.com" },
    vendorConsent: false
  });

  const firstPage = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads?limit=2&offset=0",
    headers: bearer("vendor-token")
  });

  assert.equal(firstPage.statusCode, 200);
  assert.deepEqual(firstPage.body.columns, [
    "created_at",
    "interaction_id",
    "full_name",
    "company_name",
    "title",
    "classification",
    "consent_status",
    "next_action",
    "crm_eligibility",
    "crm_sync_status",
    "notes_count"
  ]);
  assert.deepEqual(firstPage.body.filters.classification, ["hot", "warm", "cold"]);
  assert.equal(firstPage.body.pagination.limit, 2);
  assert.equal(firstPage.body.pagination.offset, 0);
  assert.equal(firstPage.body.pagination.total, 3);
  assert.equal(firstPage.body.pagination.has_more, true);
  assert.equal(firstPage.body.pagination.next_offset, 2);
  assert.equal(firstPage.body.items.length, 2);
  assert.equal(firstPage.body.items[0].masked, true);
  assert.equal(firstPage.body.items[0].next_action, "Collect vendor consent before outreach");

  const secondPage = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads?limit=2&offset=2",
    headers: bearer("vendor-token")
  });

  assert.equal(secondPage.statusCode, 200);
  assert.equal(secondPage.body.pagination.has_more, false);
  assert.equal(secondPage.body.items.length, 1);
  assert.equal(secondPage.body.items[0].interaction_id, firstId);

  const hotLeads = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads?classification=hot",
    headers: bearer("vendor-token")
  });

  assert.equal(hotLeads.statusCode, 200);
  assert.equal(hotLeads.body.pagination.total, 1);
  assert.equal(hotLeads.body.items[0].interaction_id, secondId);
  assert.equal(hotLeads.body.items[0].next_action, "Review lead and push to CRM");
  assert.equal(hotLeads.body.items[0].score_history_count, 1);

  const hotDetail = await app.inject({
    method: "GET",
    path: `/interactions/${secondId}/detail`,
    headers: bearer("vendor-token")
  });
  assert.equal(hotDetail.statusCode, 200);
  assert.equal(hotDetail.body.item.score_history.length, 1);
  assert.equal(hotDetail.body.item.score_history[0].score, "hot");
  assert.equal(hotDetail.body.item.score_history[0].previous_score, "cold");

  const invalidFilter = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads?classification=urgent",
    headers: bearer("vendor-token")
  });

  assert.equal(invalidFilter.statusCode, 400);
});

test("vendor dashboard metrics calculate total taps and response rate", async () => {
  const app = await createApp();

  async function createConsentedLead(localEventId, profile) {
    const tap = await app.inject({
      method: "POST",
      path: "/interactions/tap",
      headers: bearer("device-token"),
      body: {
        device_id: "device-01",
        event_id: "event-demo",
        stall_id: "stall-a1",
        local_event_id: localEventId,
        tap_type: "phone_ndef",
        occurred_at: "2026-04-20T11:30:00Z"
      }
    });
    assert.equal(tap.statusCode, 201);
    const consent = await app.inject({
      method: "POST",
      path: "/consents/capture",
      body: {
        session_token: tap.body.attendee_session_token,
        vendor_release_allowed: true,
        sponsor_release_allowed: false,
        attendee_profile: profile
      }
    });
    assert.equal(consent.statusCode, 200);
    return tap.body.interaction_id;
  }

  const firstId = await createConsentedLead("vendor-metrics-1", {
    full_name: "Metric One",
    company_name: "Northfield Estates",
    email: "metric-one@example.com"
  });
  await createConsentedLead("vendor-metrics-2", {
    full_name: "Metric Two",
    company_name: "Northfield Estates",
    email: "metric-two@example.com"
  });

  const sync = await app.inject({
    method: "POST",
    path: `/interactions/${firstId}/crm-sync`,
    headers: bearer("vendor-token"),
    body: {}
  });
  assert.equal(sync.statusCode, 200);

  const metrics = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/dashboard-metrics",
    headers: bearer("vendor-token")
  });
  assert.equal(metrics.statusCode, 200);
  assert.equal(metrics.body.total_taps, 2);
  assert.equal(metrics.body.vendor_consented_leads, 2);
  assert.equal(metrics.body.crm_pushed_leads, 1);
  assert.equal(metrics.body.followup_sent_leads, 0);
  assert.equal(metrics.body.response_rate, 0.5);
  assert.match(metrics.body.response_rate_formula, /distinct CRM pushed or followup sent/);

  const invalidPeriod = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/dashboard-metrics?recent_hours=0",
    headers: bearer("vendor-token")
  });
  assert.equal(invalidPeriod.statusCode, 400);
});

test("follow-up messaging requires channel consent and preserves notification attempts", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "followup-guard-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:01:30Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  const consentWithoutEmail = await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      communication_channel_consents: {
        email: false
      },
      attendee_profile: {
        full_name: "Follow Up Guard",
        company_name: "Consent Labs",
        email: "followup@example.com"
      }
    }
  });
  assert.equal(consentWithoutEmail.statusCode, 200);
  assert.equal(consentWithoutEmail.body.communication_channel_consents[0].allowed, false);

  const draft = await app.inject({
    method: "POST",
    path: `/interactions/${tap.body.interaction_id}/followups`,
    headers: bearer("vendor-token"),
    body: {
      channel: "email",
      subject: "Thanks for visiting",
      body: "Thanks for stopping by our booth."
    }
  });
  assert.equal(draft.statusCode, 201);
  assert.equal(draft.body.status, "draft");

  const missingApproval = await app.inject({
    method: "POST",
    path: `/followups/${draft.body.id}/queue`,
    headers: bearer("vendor-token"),
    body: {}
  });
  assert.equal(missingApproval.statusCode, 400);

  const blockedQueue = await app.inject({
    method: "POST",
    path: `/followups/${draft.body.id}/queue`,
    headers: bearer("vendor-token"),
    body: {
      human_approved: true
    }
  });
  assert.equal(blockedQueue.statusCode, 403);
  assert.match(blockedQueue.body.error, /Communication channel consent/);

  const consentWithEmail = await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      communication_channel_consents: {
        email: true
      },
      attendee_profile: {
        full_name: "Follow Up Guard",
        company_name: "Consent Labs",
        email: "followup@example.com"
      }
    }
  });
  assert.equal(consentWithEmail.statusCode, 200);
  assert.equal(consentWithEmail.body.communication_channel_consents[0].allowed, true);

  await app.repos.communicationSuppressions.create({
    id: "suppression-followup-guard-1",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    interaction_id: tap.body.interaction_id,
    attendee_id: consentWithEmail.body.attendee_id,
    channel: "email",
    status: "active",
    reason: "Manual suppression test",
    source: "test",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });

  const suppressedQueue = await app.inject({
    method: "POST",
    path: `/followups/${draft.body.id}/queue`,
    headers: bearer("vendor-token"),
    body: {
      human_approved: true
    }
  });
  assert.equal(suppressedQueue.statusCode, 403);
  assert.match(suppressedQueue.body.error, /suppressed/);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      communication_channel_consents: {
        email: true
      },
      attendee_profile: {
        full_name: "Follow Up Guard",
        company_name: "Consent Labs",
        email: "followup@example.com"
      }
    }
  });
  assert.equal(
    await app.repos.communicationSuppressions.findActiveByInteractionAndChannel("tenant-demo", tap.body.interaction_id, "email"),
    null
  );

  const queued = await app.inject({
    method: "POST",
    path: `/followups/${draft.body.id}/queue`,
    headers: bearer("vendor-token"),
    body: {
      human_approved: true
    }
  });
  assert.equal(queued.statusCode, 200);
  assert.equal(queued.body.followup.status, "queued");
  assert.equal(queued.body.notification.status, "queued");
  assert.equal("recipient_hash" in queued.body.notification, true);
  assert.equal(JSON.stringify(queued.body.notification).includes("followup@example.com"), false);

  const failedAttempt = await app.inject({
    method: "POST",
    path: `/notifications/${queued.body.notification.id}/attempts`,
    headers: bearer("organizer-token"),
    body: {
      provider: "pilot-email",
      status: "failed",
      error_message: "Provider rejected the message"
    }
  });
  assert.equal(failedAttempt.statusCode, 201);
  assert.equal(failedAttempt.body.notification.status, "failed");
  assert.equal(failedAttempt.body.followup.status, "failed");
  const interactionAfterFailure = await app.repos.interactions.findById("tenant-demo", tap.body.interaction_id);
  assert.equal(interactionAfterFailure.status, "active");
  const failedAttempts = await app.repos.notificationAttempts.listByNotification("tenant-demo", queued.body.notification.id);
  assert.equal(failedAttempts.length, 1);

  const operationalAlerts = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/operational-alerts",
    headers: bearer("organizer-token")
  });
  assert.equal(operationalAlerts.statusCode, 200);
  assert.equal(operationalAlerts.body.counts.notifications, 1);
  assert.equal(operationalAlerts.body.pagination.limit, 50);
  assert.ok(operationalAlerts.body.items.some(
    (item) =>
      item.kind === "notification" &&
      item.notification_id === queued.body.notification.id &&
      item.message === "Provider rejected the message"
  ));
  const pagedOperationalAlerts = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/operational-alerts?limit=1",
    headers: bearer("organizer-token")
  });
  assert.equal(pagedOperationalAlerts.statusCode, 200);
  assert.equal(pagedOperationalAlerts.body.items.length, 1);
  assert.equal(pagedOperationalAlerts.body.pagination.limit, 1);
  const attemptExport = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/artifact-attempts/export",
    headers: bearer("organizer-token")
  });
  assert.equal(attemptExport.statusCode, 200);
  assert.equal(attemptExport.body.content_type, "text/csv");
  assert.match(attemptExport.body.csv, /artifact_type,artifact_id,attempt_id/);
  assert.match(attemptExport.body.csv, /notification/);
  assert.match(attemptExport.body.csv, /Provider rejected the message/);

  const resend = await app.inject({
    method: "POST",
    path: `/notifications/${queued.body.notification.id}/resend`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(resend.statusCode, 200);
  assert.equal(resend.body.notification.status, "queued");
  assert.equal(resend.body.followup.status, "queued");
  assert.equal(resend.body.attempts.length, 1);

  const cancel = await app.inject({
    method: "POST",
    path: `/notifications/${queued.body.notification.id}/cancel`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(cancel.statusCode, 200);
  assert.equal(cancel.body.notification.status, "cancelled");
  assert.equal(cancel.body.followup.status, "cancelled");
  assert.equal(cancel.body.attempts.length, 1);

  const attemptAfterCancel = await app.inject({
    method: "POST",
    path: `/notifications/${queued.body.notification.id}/attempts`,
    headers: bearer("organizer-token"),
    body: {
      provider: "pilot-email",
      status: "sent"
    }
  });
  assert.equal(attemptAfterCancel.statusCode, 409);

  const resendAfterCancel = await app.inject({
    method: "POST",
    path: `/notifications/${queued.body.notification.id}/resend`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(resendAfterCancel.statusCode, 409);

  const queuedDirectly = await app.inject({
    method: "POST",
    path: `/interactions/${tap.body.interaction_id}/followups`,
    headers: bearer("vendor-token"),
    body: {
      channel: "email",
      body: "Here is the brochure we discussed.",
      status: "queued",
      human_approved: true
    }
  });
  assert.equal(queuedDirectly.statusCode, 201);
  assert.equal(queuedDirectly.body.followup.status, "queued");

  const sentAttempt = await app.inject({
    method: "POST",
    path: `/notifications/${queuedDirectly.body.notification.id}/attempts`,
    headers: bearer("organizer-token"),
    body: {
      provider: "pilot-email",
      status: "sent",
      provider_message_id: "msg-123"
    }
  });
  assert.equal(sentAttempt.statusCode, 201);
  assert.equal(sentAttempt.body.notification.status, "sent");
  assert.equal(sentAttempt.body.followup.status, "sent");

  const metrics = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/dashboard-metrics",
    headers: bearer("vendor-token")
  });
  assert.equal(metrics.statusCode, 200);
  assert.equal(metrics.body.vendor_consented_leads, 1);
  assert.equal(metrics.body.followup_sent_leads, 1);
  assert.equal(metrics.body.response_rate, 1);
});

test("consent revocation cancels queued follow-ups and notifications", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "followup-revoke-cancel-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:02:30Z"
    }
  });
  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      communication_channel_consents: {
        email: true
      },
      attendee_profile: {
        full_name: "Cancel Pending",
        company_name: "Suppression Co",
        email: "cancel-pending@example.com"
      }
    }
  });
  const queued = await app.inject({
    method: "POST",
    path: `/interactions/${tap.body.interaction_id}/followups`,
    headers: bearer("vendor-token"),
    body: {
      channel: "email",
      body: "Queued before revocation",
      status: "queued",
      human_approved: true
    }
  });
  assert.equal(queued.statusCode, 201);
  assert.equal(queued.body.notification.status, "queued");

  const revoked = await app.inject({
    method: "POST",
    path: "/consents/revoke",
    body: {
      session_token: tap.body.attendee_session_token
    }
  });
  assert.equal(revoked.statusCode, 200);
  const followup = await app.repos.followupMessages.findById("tenant-demo", queued.body.followup.id);
  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);
  assert.equal(followup.status, "cancelled");
  assert.equal(notification.status, "cancelled");
  assert.ok(await app.repos.communicationSuppressions.findActiveByInteractionAndChannel("tenant-demo", tap.body.interaction_id, "email"));

  const attemptAfterCascade = await app.inject({
    method: "POST",
    path: `/notifications/${notification.id}/attempts`,
    headers: bearer("organizer-token"),
    body: {
      provider: "pilot-email",
      status: "sent"
    }
  });
  assert.equal(attemptAfterCascade.statusCode, 409);
});

test("outbound queue batch marks queued notifications sent with mock provider success", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_success"
    }
  });

  const { queued } = await createQueuedEmailFollowup(app, {
    localEventId: "queue-worker-success-1",
    email: "queue-success@example.com"
  });

  const processed = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: {
      limit: 5
    }
  });
  assert.equal(processed.statusCode, 200);
  assert.equal(processed.body.processed_count, 1);
  assert.equal(processed.body.items[0].outcome, "sent");

  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);
  const followup = await app.repos.followupMessages.findById("tenant-demo", queued.body.followup.id);
  assert.equal(notification.status, "sent");
  assert.match(notification.provider_message_id, /mock-email/);
  assert.equal(notification.attempts_count, 1);
  assert.equal(followup.status, "sent");

  const queueMetrics = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/outbound-queue/metrics",
    headers: bearer("organizer-token")
  });
  assert.equal(queueMetrics.statusCode, 200);
  assert.equal(queueMetrics.body.counts.sent, 1);
});

test("outbound queue batch leaves retryable notifications queued with temporary failure state", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_temporary_failure",
      NOTIFICATION_RETRY_DELAY_MINUTES: "5"
    }
  });

  const { queued } = await createQueuedEmailFollowup(app, {
    localEventId: "queue-worker-temp-failure-1",
    email: "queue-temp@example.com"
  });

  const processed = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: {
      limit: 5
    }
  });
  assert.equal(processed.statusCode, 200);
  assert.equal(processed.body.items[0].outcome, "temporary_failure");

  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);
  const followup = await app.repos.followupMessages.findById("tenant-demo", queued.body.followup.id);
  assert.equal(notification.status, "queued");
  assert.equal(followup.status, "queued");
  assert.match(notification.final_error, /retryable failure/i);
  assert.ok(notification.next_attempt_at);

  const queueInventory = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/outbound-queue?status=temporary_failure",
    headers: bearer("organizer-token")
  });
  assert.equal(queueInventory.statusCode, 200);
  assert.equal(queueInventory.body.items.length, 1);
  assert.equal(queueInventory.body.items[0].queue_state, "temporary_failure");
});

test("retry exhaustion moves notifications into dead-letter state and exposes attempt analytics", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_temporary_failure",
      NOTIFICATION_RETRY_DELAY_MINUTES: "5",
      NOTIFICATION_MAX_ATTEMPTS: "1"
    }
  });

  const { queued } = await createQueuedEmailFollowup(app, {
    localEventId: "queue-worker-dead-letter-1",
    email: "queue-dead-letter@example.com"
  });

  const processed = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: {
      limit: 5
    }
  });
  assert.equal(processed.statusCode, 200);
  assert.equal(processed.body.items[0].outcome, "temporary_failure");
  assert.equal(processed.body.items[0].queue_state, "dead_letter");
  assert.equal(processed.body.dead_letter_count, 1);

  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);
  assert.equal(notification.status, "failed");
  assert.ok(notification.retry_exhausted_at);
  assert.match(notification.retry_exhausted_reason, /retryable failure/i);

  const queueMetrics = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/outbound-queue/metrics",
    headers: bearer("organizer-token")
  });
  assert.equal(queueMetrics.statusCode, 200);
  assert.equal(queueMetrics.body.counts.dead_letter, 1);

  const analytics = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/outbound-delivery-analytics?status=temporary_failure",
    headers: bearer("organizer-token")
  });
  assert.equal(analytics.statusCode, 200);
  assert.equal(analytics.body.summary.total_attempts, 1);
  assert.equal(analytics.body.summary.temporary_failure, 1);

  const attempts = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/outbound-attempts?status=temporary_failure",
    headers: bearer("organizer-token")
  });
  assert.equal(attempts.statusCode, 200);
  assert.equal(attempts.body.items.length, 1);
  assert.equal(attempts.body.items[0].attempt_number, 1);
});

test("organizer can retry temporary failures immediately and force requeue dead-letter notifications", async () => {
  const retryApp = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_temporary_failure",
      NOTIFICATION_RETRY_DELAY_MINUTES: "5",
      NOTIFICATION_MAX_ATTEMPTS: "3"
    }
  });

  const { queued: retryQueued } = await createQueuedEmailFollowup(retryApp, {
    localEventId: "queue-worker-retry-now-1",
    email: "queue-retry-now@example.com"
  });

  await retryApp.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: { limit: 5 }
  });

  const retryNow = await retryApp.inject({
    method: "POST",
    path: `/notifications/${retryQueued.body.notification.id}/retry-now`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(retryNow.statusCode, 200);
  assert.equal(retryNow.body.notification.status, "queued");
  assert.equal(retryNow.body.followup.status, "queued");

  const deadLetterApp = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_temporary_failure",
      NOTIFICATION_RETRY_DELAY_MINUTES: "5",
      NOTIFICATION_MAX_ATTEMPTS: "1"
    }
  });

  const { queued: deadLetterQueued } = await createQueuedEmailFollowup(deadLetterApp, {
    localEventId: "queue-worker-force-requeue-1",
    email: "queue-force-requeue@example.com"
  });

  await deadLetterApp.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: { limit: 5 }
  });

  const forceRequeue = await deadLetterApp.inject({
    method: "POST",
    path: `/notifications/${deadLetterQueued.body.notification.id}/force-requeue`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(forceRequeue.statusCode, 200);
  assert.equal(forceRequeue.body.notification.status, "queued");
  assert.equal(forceRequeue.body.followup.status, "queued");
  assert.equal(forceRequeue.body.notification.retry_exhausted_at, null);

  const attemptsExport = await deadLetterApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/outbound-attempts/export?status=temporary_failure",
    headers: bearer("organizer-token")
  });
  assert.equal(attemptsExport.statusCode, 200);
  assert.match(attemptsExport.body.csv, /attempt_id,notification_id,interaction_id,channel,provider,status/);
});

test("outbound queue batch marks notifications failed when provider is not configured", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "not_configured"
    }
  });

  const { queued } = await createQueuedEmailFollowup(app, {
    localEventId: "queue-worker-not-configured-1",
    email: "queue-missing-provider@example.com"
  });

  const processed = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: {
      limit: 5
    }
  });
  assert.equal(processed.statusCode, 200);
  assert.equal(processed.body.items[0].outcome, "failed");

  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);
  assert.equal(notification.status, "failed");
  assert.match(notification.final_error, /not configured/i);
});

test("outbound queue batch marks notifications failed on mock permanent provider failures", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_failure"
    }
  });

  const { queued } = await createQueuedEmailFollowup(app, {
    localEventId: "queue-worker-permanent-failure-1",
    email: "queue-permanent-failure@example.com"
  });

  const processed = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: {
      limit: 5
    }
  });
  assert.equal(processed.statusCode, 200);
  assert.equal(processed.body.items[0].outcome, "failed");

  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);
  const followup = await app.repos.followupMessages.findById("tenant-demo", queued.body.followup.id);
  assert.equal(notification.status, "failed");
  assert.equal(followup.status, "failed");
  assert.match(notification.final_error, /permanent failure/i);
});

test("production notification adapter sends JSON payloads with bearer auth and marks notifications sent", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      status: 202,
      headers: { get() { return null; } },
      async text() {
        return JSON.stringify({ provider_message_id: "provider-msg-123" });
      }
    };
  };

  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "production",
      NOTIFICATION_EMAIL_PROVIDER_KIND: "http_json",
      NOTIFICATION_EMAIL_PROVIDER_URL: "https://notify.example.com/email",
      NOTIFICATION_EMAIL_PROVIDER_AUTH_TYPE: "bearer",
      NOTIFICATION_EMAIL_PROVIDER_AUTH_TOKEN: "secret-bearer-token",
      NOTIFICATION_EMAIL_SENDER: "no-reply@example.com"
    }
  });

  try {
    const { queued } = await createQueuedEmailFollowup(app, {
      localEventId: "queue-worker-production-success-1",
      email: "production-success@example.com",
      body: "Production adapter test body."
    });

    const processed = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/outbound-queue/process",
      headers: bearer("organizer-token"),
      body: { limit: 5 }
    });
    assert.equal(processed.statusCode, 200);
    assert.equal(processed.body.items[0].outcome, "sent");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://notify.example.com/email");
    assert.equal(requests[0].options.headers.authorization, "Bearer secret-bearer-token");
    const payload = JSON.parse(requests[0].options.body);
    assert.equal(payload.to, "production-success@example.com");
    assert.equal(payload.sender, "no-reply@example.com");
    assert.equal(payload.body, "Production adapter test body.");
    assert.equal(payload.message_id, queued.body.notification.id);

    const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);
    assert.equal(notification.status, "sent");
    assert.equal(notification.provider_message_id, "provider-msg-123");
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
});

test("production notification adapter classifies 5xx responses as temporary failures", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 502,
    headers: { get() { return null; } },
    async text() {
      return "provider temporarily unavailable";
    }
  });

  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "production",
      NOTIFICATION_EMAIL_PROVIDER_KIND: "http_json",
      NOTIFICATION_EMAIL_PROVIDER_URL: "https://notify.example.com/email",
      NOTIFICATION_EMAIL_PROVIDER_AUTH_TYPE: "bearer",
      NOTIFICATION_EMAIL_PROVIDER_AUTH_TOKEN: "secret-bearer-token"
    }
  });

  try {
    const { queued } = await createQueuedEmailFollowup(app, {
      localEventId: "queue-worker-production-tempfail-1",
      email: "production-temp@example.com"
    });

    const processed = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/outbound-queue/process",
      headers: bearer("organizer-token"),
      body: { limit: 5 }
    });
    assert.equal(processed.statusCode, 200);
    assert.equal(processed.body.items[0].outcome, "temporary_failure");

    const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);
    assert.equal(notification.status, "queued");
    assert.match(notification.final_error, /http 502/i);
    assert.ok(notification.next_attempt_at);
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
});

test("production notification adapter classifies 4xx responses as permanent failures and supports custom auth headers", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: false,
      status: 400,
      headers: { get() { return null; } },
      async text() {
        return "invalid destination";
      }
    };
  };

  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "production",
      NOTIFICATION_EMAIL_PROVIDER_KIND: "http_json",
      NOTIFICATION_EMAIL_PROVIDER_URL: "https://notify.example.com/email",
      NOTIFICATION_EMAIL_PROVIDER_AUTH_TYPE: "header",
      NOTIFICATION_EMAIL_PROVIDER_AUTH_HEADER_NAME: "x-provider-key",
      NOTIFICATION_EMAIL_PROVIDER_AUTH_HEADER_VALUE: "header-secret"
    }
  });

  try {
    const { queued } = await createQueuedEmailFollowup(app, {
      localEventId: "queue-worker-production-permfail-1",
      email: "production-permanent@example.com"
    });

    const processed = await app.inject({
      method: "POST",
      path: "/organizer/events/event-demo/outbound-queue/process",
      headers: bearer("organizer-token"),
      body: { limit: 5 }
    });
    assert.equal(processed.statusCode, 200);
    assert.equal(processed.body.items[0].outcome, "failed");
    assert.equal(requests[0].options.headers["x-provider-key"], "header-secret");

    const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);
    assert.equal(notification.status, "failed");
    assert.match(notification.final_error, /http 400/i);
  } finally {
    global.fetch = originalFetch;
    await app.close();
  }
});

test("notification provider adapter supports basic auth in production mode", async () => {
  let request = null;
  const outcome = await sendNotificationWithProvider({
    notification: {
      id: "notification-basic-auth",
      tenant_id: "tenant-demo",
      event_id: "event-demo",
      interaction_id: "interaction-demo",
      channel: "email",
      message_type: "followup",
      attempts_count: 0
    },
    followup: {
      id: "followup-basic-auth",
      subject: "Subject",
      body: "Body"
    },
    recipient: "basic@example.com",
    env: {
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "production",
      NOTIFICATION_EMAIL_PROVIDER_KIND: "http_json",
      NOTIFICATION_EMAIL_PROVIDER_URL: "https://notify.example.com/email",
      NOTIFICATION_EMAIL_PROVIDER_AUTH_TYPE: "basic",
      NOTIFICATION_EMAIL_PROVIDER_AUTH_USERNAME: "user-a",
      NOTIFICATION_EMAIL_PROVIDER_AUTH_PASSWORD: "pass-b"
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        headers: { get() { return null; } },
        async text() {
          return JSON.stringify({ id: "msg-basic-1" });
        }
      };
    }
  });
  assert.equal(outcome.status, "sent");
  assert.equal(request.url, "https://notify.example.com/email");
  assert.match(request.options.headers.authorization, /^Basic /);
});

test("notification provider webhook requires tenant scope and shared secret", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_WEBHOOK_SECRET: "email-webhook-secret"
    }
  });

  const missingTenant = await app.inject({
    method: "POST",
    path: "/webhooks/notifications/email",
    headers: {
      "x-notification-webhook-secret": "email-webhook-secret"
    },
    body: {
      provider_message_id: "msg-1",
      receipt_type: "delivered"
    }
  });
  assert.equal(missingTenant.statusCode, 400);

  const invalidSecret = await app.inject({
    method: "POST",
    path: "/webhooks/notifications/email",
    headers: {
      "x-tenant-id": "tenant-demo",
      "x-notification-webhook-secret": "wrong-secret"
    },
    body: {
      provider_message_id: "msg-1",
      receipt_type: "delivered"
    }
  });
  assert.equal(invalidSecret.statusCode, 403);
});

test("notification provider webhook ingests receipts idempotently and exposes organizer receipt history", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_success",
      NOTIFICATION_EMAIL_WEBHOOK_SECRET: "email-webhook-secret"
    }
  });

  const { queued } = await createQueuedEmailFollowup(app, {
    localEventId: "notification-webhook-delivered-1",
    email: "notification-webhook@example.com"
  });

  await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: { limit: 5 }
  });

  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);

  const delivered = await app.inject({
    method: "POST",
    path: "/webhooks/notifications/email",
    headers: {
      "x-tenant-id": "tenant-demo",
      "x-notification-webhook-secret": "email-webhook-secret"
    },
    body: {
      provider: notification.provider,
      provider_message_id: notification.provider_message_id,
      provider_event_id: "provider-event-1",
      receipt_type: "delivered",
      summary: "Delivered by provider"
    }
  });
  assert.equal(delivered.statusCode, 202);
  assert.equal(delivered.body.accepted, true);
  assert.equal(delivered.body.matched, true);
  assert.equal(delivered.body.deduplicated, false);

  const duplicate = await app.inject({
    method: "POST",
    path: "/webhooks/notifications/email",
    headers: {
      "x-tenant-id": "tenant-demo",
      "x-notification-webhook-secret": "email-webhook-secret"
    },
    body: {
      provider: notification.provider,
      provider_message_id: notification.provider_message_id,
      provider_event_id: "provider-event-1",
      receipt_type: "delivered",
      summary: "Delivered by provider"
    }
  });
  assert.equal(duplicate.statusCode, 202);
  assert.equal(duplicate.body.deduplicated, true);

  const receipts = await app.repos.notificationReceipts.listByNotification("tenant-demo", notification.id);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].receipt_type, "delivered");

  const organizerReceipts = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/notification-receipts?receipt_type=delivered",
    headers: bearer("organizer-token")
  });
  assert.equal(organizerReceipts.statusCode, 200);
  assert.equal(organizerReceipts.body.items.length, 1);

  const organizerExport = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/notification-receipts/export?receipt_type=delivered",
    headers: bearer("organizer-token")
  });
  assert.equal(organizerExport.statusCode, 200);
  assert.match(organizerExport.body.csv, /receipt_id,notification_id,interaction_id,channel,provider,receipt_type/);
});

test("notification provider webhook supports HMAC signature validation and receipt-aware engagement analytics", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_success",
      NOTIFICATION_EMAIL_WEBHOOK_AUTH_MODE: "hmac_sha256",
      NOTIFICATION_EMAIL_WEBHOOK_SECRET: "email-hmac-secret",
      NOTIFICATION_EMAIL_WEBHOOK_SIGNATURE_HEADER: "x-provider-signature",
      NOTIFICATION_EMAIL_WEBHOOK_TIMESTAMP_HEADER: "x-provider-timestamp",
      NOTIFICATION_EMAIL_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: "300"
    }
  });

  const { queued } = await createQueuedEmailFollowup(app, {
    localEventId: "notification-webhook-hmac-1",
    email: "notification-hmac@example.com"
  });

  await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: { limit: 5 }
  });

  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);
  const timestamp = String(Math.floor(Date.now() / 1000));

  for (const [providerEventId, receiptType] of [
    ["provider-event-delivered-1", "delivered"],
    ["provider-event-opened-1", "opened"],
    ["provider-event-clicked-1", "clicked"]
  ]) {
    const payload = {
      provider: notification.provider,
      provider_message_id: notification.provider_message_id,
      provider_event_id: providerEventId,
      receipt_type: receiptType,
      summary: receiptType
    };
    const signature = signWebhookPayload(payload, "email-hmac-secret", timestamp);
    const response = await app.inject({
      method: "POST",
      path: "/webhooks/notifications/email",
      headers: {
        "x-tenant-id": "tenant-demo",
        "x-provider-signature": `sha256=${signature}`,
        "x-provider-timestamp": timestamp
      },
      body: payload
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.body.matched, true);
  }

  const stalePayload = {
    provider: notification.provider,
    provider_message_id: notification.provider_message_id,
    provider_event_id: "provider-event-stale-1",
    receipt_type: "opened",
    summary: "opened"
  };
  const staleTimestamp = "1";
  const staleSignature = signWebhookPayload(stalePayload, "email-hmac-secret", staleTimestamp);
  const staleResponse = await app.inject({
    method: "POST",
    path: "/webhooks/notifications/email",
    headers: {
      "x-tenant-id": "tenant-demo",
      "x-provider-signature": `sha256=${staleSignature}`,
      "x-provider-timestamp": staleTimestamp
    },
    body: stalePayload
  });
  assert.equal(staleResponse.statusCode, 403);

  const analytics = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/outbound-delivery-analytics?provider=" + encodeURIComponent(notification.provider),
    headers: bearer("organizer-token")
  });
  assert.equal(analytics.statusCode, 200);
  assert.equal(analytics.body.engagement.summary.delivered, 1);
  assert.equal(analytics.body.engagement.summary.opened, 1);
  assert.equal(analytics.body.engagement.summary.clicked, 1);
  assert.equal(analytics.body.engagement.summary.delivered_rate, 1);
  assert.equal(analytics.body.engagement.summary.open_rate, 1);
  assert.equal(analytics.body.engagement.summary.click_rate, 1);
});

test("complaint receipts fail notifications and create active communication suppression", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_success",
      NOTIFICATION_EMAIL_WEBHOOK_SECRET: "email-webhook-secret"
    }
  });

  const { queued } = await createQueuedEmailFollowup(app, {
    localEventId: "notification-webhook-complaint-1",
    email: "notification-complaint@example.com"
  });

  await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: { limit: 5 }
  });

  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);

  const complained = await app.inject({
    method: "POST",
    path: "/webhooks/notifications/email",
    headers: {
      "x-tenant-id": "tenant-demo",
      "x-notification-webhook-secret": "email-webhook-secret"
    },
    body: {
      provider: notification.provider,
      provider_message_id: notification.provider_message_id,
      provider_event_id: "provider-event-complaint-1",
      receipt_type: "complained",
      summary: "Recipient complained"
    }
  });
  assert.equal(complained.statusCode, 202);

  const updatedNotification = await app.repos.notifications.findById("tenant-demo", notification.id);
  assert.equal(updatedNotification.status, "failed");
  assert.match(updatedNotification.final_error, /complained/i);

  const followup = await app.repos.followupMessages.findByNotificationId("tenant-demo", notification.id);
  assert.equal(followup.status, "failed");

  const suppression = await app.repos.communicationSuppressions.findActiveByInteractionAndChannel(
    "tenant-demo",
    notification.interaction_id,
    "email"
  );
  assert.ok(suppression);
  assert.equal(suppression.reason, "complained");
});

test("receipt governance blocks resend after complaint receipts and surfaces organizer alerts", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_success",
      NOTIFICATION_EMAIL_WEBHOOK_SECRET: "email-webhook-secret"
    }
  });

  const { tap, queued } = await createQueuedEmailFollowup(app, {
    localEventId: "notification-webhook-governance-block-1",
    email: "notification-governance-block@example.com"
  });

  await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: { limit: 5 }
  });

  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);

  const complained = await app.inject({
    method: "POST",
    path: "/webhooks/notifications/email",
    headers: {
      "x-tenant-id": "tenant-demo",
      "x-notification-webhook-secret": "email-webhook-secret"
    },
    body: {
      provider: notification.provider,
      provider_message_id: notification.provider_message_id,
      provider_event_id: "provider-event-governance-block-1",
      receipt_type: "complained",
      summary: "Recipient complained"
    }
  });
  assert.equal(complained.statusCode, 202);

  const resend = await app.inject({
    method: "POST",
    path: `/notifications/${notification.id}/resend`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(resend.statusCode, 403);
  assert.match(resend.body.error, /suppressed/i);
  assert.match(resend.body.error, /complained/i);

  const alerts = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/operational-alerts",
    headers: bearer("organizer-token")
  });
  assert.equal(alerts.statusCode, 200);
  assert.equal(alerts.body.counts.receipt_blocked, 1);
  const notificationAlert = alerts.body.items.find((entry) => entry.notification_id === notification.id);
  assert.ok(notificationAlert);
  assert.equal(notificationAlert.latest_receipt_type, "complained");
  assert.match(notificationAlert.message, /blocks resend/i);

  const queue = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/outbound-queue?status=failed",
    headers: bearer("organizer-token")
  });
  assert.equal(queue.statusCode, 200);
  const queueItem = queue.body.items.find((entry) => entry.id === notification.id);
  assert.ok(queueItem);
  assert.match(queueItem.resend_blocked_reason, /complained/i);

  const detail = await app.inject({
    method: "GET",
    path: `/interactions/${tap.body.interaction_id}/detail`,
    headers: bearer("organizer-token")
  });
  assert.equal(detail.statusCode, 200);
  assert.match(detail.body.item.followups[0].resend_blocked_reason, /complained/i);
});

test("receipt governance exports bounced receipt evidence and review guidance", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_success",
      NOTIFICATION_EMAIL_WEBHOOK_SECRET: "email-webhook-secret"
    }
  });

  const { tap, queued } = await createQueuedEmailFollowup(app, {
    localEventId: "notification-webhook-governance-review-1",
    email: "notification-governance-review@example.com"
  });

  await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: { limit: 5 }
  });

  const notification = await app.repos.notifications.findById("tenant-demo", queued.body.notification.id);

  const bounced = await app.inject({
    method: "POST",
    path: "/webhooks/notifications/email",
    headers: {
      "x-tenant-id": "tenant-demo",
      "x-notification-webhook-secret": "email-webhook-secret"
    },
    body: {
      provider: notification.provider,
      provider_message_id: notification.provider_message_id,
      provider_event_id: "provider-event-governance-review-1",
      receipt_type: "bounced",
      summary: "Mailbox full"
    }
  });
  assert.equal(bounced.statusCode, 202);

  const alerts = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/operational-alerts",
    headers: bearer("organizer-token")
  });
  assert.equal(alerts.statusCode, 200);
  assert.equal(alerts.body.counts.receipt_review, 1);
  const notificationAlert = alerts.body.items.find((entry) => entry.notification_id === notification.id);
  assert.ok(notificationAlert);
  assert.equal(notificationAlert.latest_receipt_type, "bounced");
  assert.match(notificationAlert.message, /requires operator review/i);
  assert.match(notificationAlert.message, /Mailbox full/);

  const queue = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/outbound-queue?status=failed",
    headers: bearer("organizer-token")
  });
  assert.equal(queue.statusCode, 200);
  const queueItem = queue.body.items.find((entry) => entry.id === notification.id);
  assert.ok(queueItem);
  assert.match(queueItem.resend_review_reason, /Mailbox full/);

  const detail = await app.inject({
    method: "GET",
    path: `/interactions/${tap.body.interaction_id}/detail`,
    headers: bearer("organizer-token")
  });
  assert.equal(detail.statusCode, 200);
  assert.match(detail.body.item.followups[0].resend_review_reason, /Mailbox full/);

  const exportResponse = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/artifact-attempts/export",
    headers: bearer("organizer-token")
  });
  assert.equal(exportResponse.statusCode, 200);
  assert.match(exportResponse.body.csv, /notification_receipt/);
  assert.match(exportResponse.body.csv, /bounced/);
  assert.match(exportResponse.body.csv, /Mailbox full/);
});

test("public leaderboard exposes only generalized no-PII ticker data", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "leaderboard-private-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T11:30:00Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  const consent = await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Priya Private",
        company_name: "Stealth Capital Partners",
        email: "priya.private@example.com",
        phone: "+91-90000-44444"
      }
    }
  });
  assert.equal(consent.statusCode, 200);
  app.state.eventPolicies[0].public_leaderboard_company_names_enabled = true;

  const leaderboard = await app.inject({
    method: "GET",
    path: "/events/event-demo/leaderboard",
    headers: { "x-tenant-id": "tenant-demo" }
  });
  assert.equal(leaderboard.statusCode, 200);
  assert.equal(leaderboard.body.privacy.personal_data_included, false);
  assert.equal(leaderboard.body.privacy.exact_company_names_enabled, false);
  assert.ok(leaderboard.body.rankings.some((entry) => entry.stall_id === "stall-a1" && entry.connection_count === 1));
  assert.ok(leaderboard.body.latest_connections.length > 0);
  assert.match(leaderboard.body.latest_connections[0].text, /Someone from a large enterprise connected with Northfield Estates/);
  assert.equal(leaderboard.body.latest_connections[0].company_descriptor, "a large enterprise");
  assert.equal(leaderboard.body.latest_connections[0].pii_redacted, true);

  const serialized = JSON.stringify(leaderboard.body);
  assert.equal(serialized.includes("Priya Private"), false);
  assert.equal(serialized.includes("priya.private@example.com"), false);
  assert.equal(serialized.includes("+91-90000-44444"), false);
  assert.equal(serialized.includes("Stealth Capital Partners"), false);
});

test("organizer leaderboard snapshots preserve 5-minute no-PII replay history", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "leaderboard-snapshot-private-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T11:35:00Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  const consent = await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Lena Locked",
        company_name: "Confidential Global Holdings",
        email: "lena.locked@example.com",
        phone: "+91-90000-55555"
      }
    }
  });
  assert.equal(consent.statusCode, 200);

  const created = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/leaderboard-snapshots",
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.snapshot_version, 1);
  assert.equal(created.body.calculation_version, 1);
  assert.equal(created.body.snapshot_interval_minutes, 5);
  assert.equal(created.body.payload.snapshot_type, "public_leaderboard");
  assert.equal(created.body.payload.authoritative_scope, "leaderboard_snapshots");
  assert.match(created.body.payload.formula.ranking, /Count all event interactions per stall/);
  assert.equal(created.body.payload.leaderboard.privacy.personal_data_included, false);
  assert.ok(created.body.payload.leaderboard.rankings.some((entry) => entry.stall_id === "stall-a1" && entry.connection_count === 1));

  const duplicate = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/leaderboard-snapshots",
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(duplicate.statusCode, 409);
  assert.match(duplicate.body.error, /5-minute cadence/);

  const list = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/leaderboard-snapshots",
    headers: bearer("organizer-token")
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.snapshot_interval_minutes, 5);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].id, created.body.id);

  const serialized = JSON.stringify(list.body);
  assert.equal(serialized.includes("Lena Locked"), false);
  assert.equal(serialized.includes("lena.locked@example.com"), false);
  assert.equal(serialized.includes("+91-90000-55555"), false);
  assert.equal(serialized.includes("Confidential Global Holdings"), false);
});

test("sponsor lead export is blocked when sponsor PII is disabled", async () => {
  const app = await createApp();
  const response = await app.inject({
    method: "POST",
    path: "/exports/request",
    headers: bearer("sponsor-token"),
    body: {
      event_id: "event-demo",
      export_type: "sponsor_leads"
    }
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /Sponsor PII disabled/);
});

test("sponsor lead exports include only opted-in leads and honor later revocation", async () => {
  const app = await createApp();
  app.state.eventPolicies[0].sponsor_pii_enabled = true;

  async function createLead(localEventId, sponsorConsent, profile) {
    const tap = await app.inject({
      method: "POST",
      path: "/interactions/tap",
      headers: bearer("device-token"),
      body: {
        device_id: "device-01",
        event_id: "event-demo",
        stall_id: "stall-a1",
        local_event_id: localEventId,
        tap_type: "phone_ndef",
        occurred_at: "2026-04-20T08:45:00Z"
      }
    });
    assert.equal(tap.statusCode, 201);
    const consent = await app.inject({
      method: "POST",
      path: "/consents/capture",
      body: {
        session_token: tap.body.attendee_session_token,
        vendor_release_allowed: true,
        sponsor_release_allowed: sponsorConsent,
        attendee_profile: profile
      }
    });
    assert.equal(consent.statusCode, 200);
    return tap.body;
  }

  const sponsorLead = await createLead("sponsor-lead-export-opt-in", true, {
    full_name: "Sponsor Allowed",
    company_name: "Orbit Capital",
    email: "sponsor.allowed@example.com",
    phone: "+91-90000-11111"
  });
  await createLead("sponsor-lead-export-vendor-only", false, {
    full_name: "Vendor Only Export",
    company_name: "Vendor Only Co",
    email: "vendor.only@example.com",
    phone: "+91-90000-22222"
  });

  const requested = await app.inject({
    method: "POST",
    path: "/exports/request",
    headers: bearer("sponsor-token"),
    body: {
      event_id: "event-demo",
      export_type: "sponsor_leads"
    }
  });
  assert.equal(requested.statusCode, 200);
  assert.equal(requested.body.row_count_estimate, 1);

  const approved = await app.inject({
    method: "POST",
    path: `/exports/${requested.body.id}/approve`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(approved.statusCode, 200);

  const downloaded = await app.inject({
    method: "GET",
    path: `/exports/${requested.body.id}/download`,
    headers: bearer("sponsor-token")
  });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.body.payload.privacy.personal_data_included, true);
  assert.equal(downloaded.body.payload.leads.length, 1);
  assert.equal(downloaded.body.payload.leads[0].profile.full_name, "Sponsor Allowed");
  const firstSerialized = JSON.stringify(downloaded.body.payload);
  assert.equal(firstSerialized.includes("Vendor Only Export"), false);
  assert.equal(firstSerialized.includes("vendor.only@example.com"), false);

  const sponsorOptOut = await app.inject({
    method: "POST",
    path: "/consents/revoke",
    body: {
      session_token: sponsorLead.attendee_session_token,
      revoke_vendor_release: false,
      revoke_sponsor_release: true
    }
  });
  assert.equal(sponsorOptOut.statusCode, 200);
  assert.equal(sponsorOptOut.body.consent_status, "vendor_only");

  const sponsorOptOutDetail = await app.inject({
    method: "GET",
    path: `/interactions/${sponsorLead.interaction_id}/detail`,
    headers: bearer("vendor-token")
  });
  assert.equal(sponsorOptOutDetail.statusCode, 200);
  assert.equal(sponsorOptOutDetail.body.item.masked, false);
  assert.equal(sponsorOptOutDetail.body.item.crm_eligibility, "eligible");

  const sponsorOptOutDownload = await app.inject({
    method: "GET",
    path: `/exports/${requested.body.id}/download`,
    headers: bearer("sponsor-token")
  });
  assert.equal(sponsorOptOutDownload.statusCode, 200);
  assert.equal(sponsorOptOutDownload.body.payload.leads.length, 0);
  assert.equal(JSON.stringify(sponsorOptOutDownload.body.payload).includes("Sponsor Allowed"), false);

  const revoked = await app.inject({
    method: "POST",
    path: "/consents/revoke",
    body: {
      session_token: sponsorLead.attendee_session_token
    }
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.body.consent_status, "declined");

  const detailAfterRevoke = await app.inject({
    method: "GET",
    path: `/interactions/${sponsorLead.interaction_id}/detail`,
    headers: bearer("vendor-token")
  });
  assert.equal(detailAfterRevoke.statusCode, 200);
  assert.equal(detailAfterRevoke.body.item.masked, true);
  assert.equal(detailAfterRevoke.body.item.privacy.reason, "vendor_consent_required");
  assert.equal(detailAfterRevoke.body.item.crm_eligibility, "blocked_by_consent");

  const crmAfterRevoke = await app.inject({
    method: "POST",
    path: `/interactions/${sponsorLead.interaction_id}/crm-sync`,
    headers: bearer("vendor-token"),
    body: {}
  });
  assert.equal(crmAfterRevoke.statusCode, 409);
  assert.match(crmAfterRevoke.body.error, /blocked_by_consent/);

  const redownloaded = await app.inject({
    method: "GET",
    path: `/exports/${requested.body.id}/download`,
    headers: bearer("sponsor-token")
  });
  assert.equal(redownloaded.statusCode, 200);
  assert.equal(redownloaded.body.payload.leads.length, 0);
  assert.equal(JSON.stringify(redownloaded.body.payload).includes("Sponsor Allowed"), false);
});

test("sponsor dashboard returns aggregate breakdowns and published report snapshots", async () => {
  const app = await createApp();

  const firstTap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "sponsor-dashboard-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T08:00:00Z"
    }
  });
  assert.equal(firstTap.statusCode, 201);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: firstTap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: true,
      attendee_profile: {
        full_name: "Sponsor Visible",
        company_name: "Orbit Capital",
        email: "visible@example.com"
      }
    }
  });

  const secondTap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "sponsor-dashboard-2",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T08:30:00Z"
    }
  });
  assert.equal(secondTap.statusCode, 201);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: secondTap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Vendor Only",
        company_name: "Northfield Estates",
        email: "vendoronly@example.com"
      }
    }
  });

  app.state.interactions[0].sponsor_click_count = 2;
  app.state.interactions[0].classification = "hot";
  app.state.interactions[1].sponsor_click_count = 1;
  app.state.interactions[1].classification = "warm";

  const metrics = await app.inject({
    method: "GET",
    path: "/sponsors/org-sponsor/metrics?event_id=event-demo",
    headers: bearer("sponsor-token")
  });

  assert.equal(metrics.statusCode, 200);
  assert.equal(metrics.body.impressions, 2);
  assert.equal(metrics.body.clicks, 2);
  assert.equal(metrics.body.total_clicks, 3);
  assert.equal(metrics.body.consent_breakdown.sponsor_opt_in, 1);
  assert.equal(metrics.body.consent_breakdown.vendor_only, 1);
  assert.equal(metrics.body.privacy.personal_data_included, false);
  assert.equal(metrics.body.stall_breakdown.length, 2);
  assert.equal(metrics.body.stall_breakdown[0].stall_id, "stall-a1");
  assert.equal(metrics.body.snapshot_count, 0);

  const snapshot = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/sponsors/org-sponsor/report-snapshots",
    headers: bearer("organizer-token"),
    body: {
      note: "Locked for sponsor check-in meeting"
    }
  });

  assert.equal(snapshot.statusCode, 201);
  assert.equal(snapshot.body.payload.snapshot_type, "sponsor_dashboard");
  assert.equal(snapshot.body.payload.dashboard.impressions, 2);

  const snapshotList = await app.inject({
    method: "GET",
    path: "/sponsors/org-sponsor/report-snapshots?event_id=event-demo",
    headers: bearer("sponsor-token")
  });

  assert.equal(snapshotList.statusCode, 200);
  assert.equal(snapshotList.body.items.length, 1);
  assert.equal(snapshotList.body.items[0].note, "Locked for sponsor check-in meeting");
});

test("sponsor snapshot exports can be requested, approved, and downloaded", async () => {
  const app = await createApp();

  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "sponsor-export-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T09:00:00Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: true,
      attendee_profile: {
        full_name: "Export Lead",
        company_name: "Orbit Capital",
        email: "export@example.com"
      }
    }
  });
  app.state.interactions[0].sponsor_click_count = 1;

  const snapshot = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/sponsors/org-sponsor/report-snapshots",
    headers: bearer("organizer-token"),
    body: {
      note: "Prepared for sponsor export"
    }
  });
  assert.equal(snapshot.statusCode, 201);

  const request = await app.inject({
    method: "POST",
    path: "/exports/request",
    headers: bearer("sponsor-token"),
    body: {
      event_id: "event-demo",
      export_type: "sponsor_dashboard_snapshot",
      filters: {
        snapshot_id: snapshot.body.id,
        sponsor_id: "org-sponsor"
      }
    }
  });
  assert.equal(request.statusCode, 200);
  assert.equal(request.body.status, "requested");

  const list = await app.inject({
    method: "GET",
    path: "/sponsors/org-sponsor/exports?event_id=event-demo",
    headers: bearer("sponsor-token")
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.items.length, 1);

  const approved = await app.inject({
    method: "POST",
    path: `/exports/${request.body.id}/approve`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.status, "generated");
  assert.equal(approved.body.file_url, `/exports/${request.body.id}/download`);

  const downloaded = await app.inject({
    method: "GET",
    path: `/exports/${request.body.id}/download`,
    headers: bearer("sponsor-token")
  });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.body.export_type, "sponsor_dashboard_snapshot");
  assert.equal(downloaded.body.payload.snapshot_type, "sponsor_dashboard");
});

test("organizer can list, approve, and inspect event export requests", async () => {
  const app = await createApp();

  const request = await app.inject({
    method: "POST",
    path: "/exports/request",
    headers: bearer("organizer-token"),
    body: {
      event_id: "event-demo",
      export_type: "vendor_leads"
    }
  });

  assert.equal(request.statusCode, 200);
  assert.equal(request.body.status, "requested");

  const list = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/exports",
    headers: bearer("organizer-token")
  });

  assert.equal(list.statusCode, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].id, request.body.id);

  const approve = await app.inject({
    method: "POST",
    path: `/exports/${request.body.id}/approve`,
    headers: bearer("organizer-token"),
    body: {}
  });

  assert.equal(approve.statusCode, 200);
  assert.equal(approve.body.status, "generated");
  assert.ok(approve.body.file_url);

  const status = await app.inject({
    method: "GET",
    path: `/exports/${request.body.id}/status`,
    headers: bearer("organizer-token")
  });

  assert.equal(status.statusCode, 200);
  assert.equal(status.body.status, "generated");
  assert.ok(status.body.file_url);
});

test("event close freezes official report snapshots and generates final organizer report export", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "close-event-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T10:00:00Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: true,
      attendee_profile: {
        full_name: "Close Event Lead",
        company_name: "Orbit Capital",
        email: "close@example.com"
      }
    }
  });

  const frozen = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/report-freeze",
    headers: bearer("organizer-token"),
    body: {
      note: "Pilot event closed after final sponsor review"
    }
  });

  assert.equal(frozen.statusCode, 200);
  assert.equal(frozen.body.status, "closed");
  assert.equal(frozen.body.freeze_status.frozen, true);
  assert.equal(frozen.body.freeze_status.artifact_freeze_checks.ready, true);
  assert.ok(frozen.body.official_snapshot.id);
  assert.ok(frozen.body.official_export.id);
  assert.equal(frozen.body.official_export.file_url, `/exports/${frozen.body.official_export.id}/download`);

  const status = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/report-freeze",
    headers: bearer("organizer-token")
  });

  assert.equal(status.statusCode, 200);
  assert.equal(status.body.frozen, true);
  assert.equal(status.body.event_status, "closed");
  assert.equal(status.body.artifact_freeze_checks.unresolved_artifacts, 0);
  assert.ok(status.body.latest_official_snapshot);
  assert.ok(status.body.latest_official_export);

  const downloaded = await app.inject({
    method: "GET",
    path: `/exports/${frozen.body.official_export.id}/download`,
    headers: bearer("organizer-token")
  });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.body.export_type, "organizer_event_report");
  assert.equal(downloaded.body.payload.snapshot_type, "official_event_report");
});

test("organizer can complete delete DSRs and track downstream deletion confirmations", async () => {
  const app = await createApp({
    env: {
      WALLET_PASS_ENABLED: "true",
      WALLET_PASS_PROVIDER_MODE: "mock_success"
    }
  });
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "dsr-delete-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T11:00:00Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Delete Me",
        company_name: "Orbit Capital",
        email: "delete-me@example.com"
      }
    }
  });

  const walletPass = await app.inject({
    method: "POST",
    path: `/attendee/session/${tap.body.interaction_id}/wallet-pass`,
    body: {
      session_token: tap.body.attendee_session_token,
      pass_type: "generic"
    }
  });
  assert.equal(walletPass.statusCode, 201);

  const created = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/dsr",
    headers: bearer("organizer-token"),
    body: {
      request_type: "delete",
      interaction_id: tap.body.interaction_id,
      request_reason: "Attendee requested deletion"
    }
  });
  assert.equal(created.statusCode, 201);

  const completed = await app.inject({
    method: "POST",
    path: `/organizer/events/event-demo/dsr/${created.body.id}/complete`,
    headers: bearer("organizer-token"),
    body: {
      resolution_summary: "Removed personal data and queued downstream deletes.",
      downstream_targets: ["crm", "warehouse"]
    }
  });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.body.status, "completed");
  assert.equal(completed.body.downstream_deletions.length, 3);
  const walletDeletion = completed.body.downstream_deletions.find((entry) => entry.target_system === "wallet_artifacts");
  assert.ok(walletDeletion);
  assert.deepEqual(walletDeletion.details.wallet_pass_ids, [walletPass.body.wallet_pass.id]);

  const interaction = await app.repos.interactions.findById("tenant-demo", tap.body.interaction_id);
  assert.equal(interaction.status, "anonymized");
  assert.equal(interaction.attendee_id, null);

  const list = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/dsr",
    headers: bearer("organizer-token")
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].downstream_deletions.length, 3);

  const walletDispatch = await app.inject({
    method: "POST",
    path: `/organizer/events/event-demo/downstream-deletions/${walletDeletion.id}/dispatch`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(walletDispatch.statusCode, 200);
  assert.equal(walletDispatch.body.status, "confirmed");
  const cleanedWalletPass = await app.repos.walletPasses.findById("tenant-demo", walletPass.body.wallet_pass.id);
  assert.equal(cleanedWalletPass.status, "cancelled");
  assert.equal(cleanedWalletPass.failure_message, null);

  const confirmed = await app.inject({
    method: "POST",
    path: `/organizer/events/event-demo/downstream-deletions/${completed.body.downstream_deletions.find((entry) => entry.target_system === "crm").id}`,
    headers: bearer("organizer-token"),
    body: {
      status: "confirmed",
      note: "CRM deletion confirmed"
    }
  });
  assert.equal(confirmed.statusCode, 200);
  assert.equal(confirmed.body.status, "confirmed");

  const overview = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/compliance",
    headers: bearer("organizer-token")
  });
  assert.equal(overview.statusCode, 200);
  assert.equal(overview.body.dsr_counts.completed, 1);
  assert.equal(overview.body.downstream_deletion_counts.confirmed, 2);
  assert.equal(overview.body.downstream_deletion_counts.pending, 1);
});

test("vendor can sync an eligible lead to pilot CRM and organizer can dispatch downstream CRM deletion", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "crm-sync-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T11:30:00Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "CRM Ready",
        company_name: "Northfield Estates",
        email: "crm-ready@example.com",
        phone: "+91-90000-99999"
      }
    }
  });

  const crmSync = await app.inject({
    method: "POST",
    path: `/interactions/${tap.body.interaction_id}/crm-sync`,
    headers: bearer("vendor-token"),
    body: {}
  });
  assert.equal(crmSync.statusCode, 200);
  assert.equal(crmSync.body.status, "synced");
  assert.equal(crmSync.body.provider, "pilot_crm");
  assert.match(crmSync.body.external_record_id, /pilot_crm:/);

  const crmHistory = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/crm-sync",
    headers: bearer("organizer-token")
  });
  assert.equal(crmHistory.statusCode, 200);
  const crmRecord = crmHistory.body.items.find((item) => item.interaction_id === tap.body.interaction_id);
  assert.equal(crmRecord.request_payload.lead.pipeline.stage, "lead_added");
  assert.equal(crmRecord.request_payload.lead.pipeline.next_action, "Review lead qualification");
  assert.ok(Date.parse(crmRecord.request_payload.lead.pipeline.next_action_at));
  assert.deepEqual(
    crmRecord.response_payload.pipeline,
    crmRecord.request_payload.lead.pipeline
  );

  const detail = await app.inject({
    method: "GET",
    path: `/interactions/${tap.body.interaction_id}/detail`,
    headers: bearer("vendor-token")
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.item.crm_eligibility, "eligible");
  assert.equal(detail.body.item.crm_sync.status, "synced");

  const created = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/dsr",
    headers: bearer("organizer-token"),
    body: {
      request_type: "delete",
      interaction_id: tap.body.interaction_id,
      request_reason: "CRM delete propagation"
    }
  });
  assert.equal(created.statusCode, 201);

  const completed = await app.inject({
    method: "POST",
    path: `/organizer/events/event-demo/dsr/${created.body.id}/complete`,
    headers: bearer("organizer-token"),
    body: {
      resolution_summary: "Delete request queued to CRM.",
      downstream_targets: ["crm"]
    }
  });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.body.downstream_deletions.length, 1);
  assert.equal(completed.body.downstream_deletions[0].details.external_record_id, crmSync.body.external_record_id);

  const dispatched = await app.inject({
    method: "POST",
    path: `/organizer/events/event-demo/downstream-deletions/${completed.body.downstream_deletions[0].id}/dispatch`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(dispatched.statusCode, 200);
  assert.equal(dispatched.body.status, "confirmed");

  const syncedRecord = await app.repos.crmSyncRecords.findByInteractionAndProvider(
    "tenant-demo",
    tap.body.interaction_id,
    "pilot_crm"
  );
  assert.equal(syncedRecord.status, "deleted");
  assert.ok(syncedRecord.deleted_at);
});

test("organizer can dispatch webhook downstream deletions and inspect CRM activity history", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "webhook-delete-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T11:45:00Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Webhook Lead",
        company_name: "Event Bus Co",
        email: "webhook@example.com"
      }
    }
  });

  await app.inject({
    method: "POST",
    path: `/interactions/${tap.body.interaction_id}/crm-sync`,
    headers: bearer("vendor-token"),
    body: {}
  });

  const created = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/dsr",
    headers: bearer("organizer-token"),
    body: {
      request_type: "delete",
      interaction_id: tap.body.interaction_id,
      request_reason: "Webhook delete propagation"
    }
  });
  assert.equal(created.statusCode, 201);

  const completed = await app.inject({
    method: "POST",
    path: `/organizer/events/event-demo/dsr/${created.body.id}/complete`,
    headers: bearer("organizer-token"),
    body: {
      resolution_summary: "Queued webhook delete.",
      downstream_targets: ["webhook_event_bus"]
    }
  });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.body.downstream_deletions.length, 1);
  assert.equal(completed.body.downstream_deletions[0].target_system, "webhook_event_bus");

  const dispatched = await app.inject({
    method: "POST",
    path: `/organizer/events/event-demo/downstream-deletions/${completed.body.downstream_deletions[0].id}/dispatch`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(dispatched.statusCode, 200);
  assert.equal(dispatched.body.status, "confirmed");
  assert.equal(dispatched.body.details.deletion_response.delivery_status, "delivered");

  const history = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/crm-sync",
    headers: bearer("organizer-token")
  });
  assert.equal(history.statusCode, 200);
  assert.equal(history.body.items.length, 1);
  assert.equal(history.body.items[0].provider, "pilot_crm");
  assert.equal(history.body.items[0].status, "synced");
});

test("organizer can review compliance reporting and download a compliance audit export", async () => {
  const app = await createApp();

  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "compliance-report-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T12:10:00Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Compliance Lead",
        company_name: "Northfield",
        email: "compliance@example.com"
      }
    }
  });

  await app.inject({
    method: "POST",
    path: `/interactions/${tap.body.interaction_id}/crm-sync`,
    headers: bearer("vendor-token"),
    body: {}
  });

  const report = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/compliance/report",
    headers: bearer("organizer-token")
  });
  assert.equal(report.statusCode, 200);
  assert.equal(report.body.event.id, "event-demo");
  assert.equal(report.body.crm_reporting.counts.synced, 1);
  assert.equal(report.body.dsr_reporting.by_type.delete, 0);
  assert.ok(Array.isArray(report.body.audit_reporting.recent_entries));

  const requested = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/compliance/audit-export",
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(requested.statusCode, 200);
  assert.equal(requested.body.export_type, "organizer_event_report");
  assert.equal(requested.body.filters.report_variant, "compliance_audit");

  const approved = await app.inject({
    method: "POST",
    path: `/exports/${requested.body.id}/approve`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.status, "generated");

  const downloaded = await app.inject({
    method: "GET",
    path: `/exports/${requested.body.id}/download`,
    headers: bearer("organizer-token")
  });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.body.export_type, "organizer_event_report");
  assert.equal(downloaded.body.file_name, "event-event-demo-compliance-audit.json");
  assert.equal(downloaded.body.payload.event.id, "event-demo");
  assert.equal(downloaded.body.payload.crm_reporting.counts.synced, 1);
});

test("organizer compliance closeout readiness reports blockers and then turns ready", async () => {
  const app = await createApp();

  const initial = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/compliance/closeout-readiness",
    headers: bearer("organizer-token")
  });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.body.readiness.ready, false);
  assert.ok(initial.body.readiness.blockers.some((entry) => entry.includes("Freeze the official event report")));

  const frozen = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/report-freeze",
    headers: bearer("organizer-token"),
    body: {
      note: "Compliance closeout"
    }
  });
  assert.equal(frozen.statusCode, 200);

  const preview = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/compliance/retention",
    headers: bearer("organizer-token"),
    body: {
      mode: "preview"
    }
  });
  assert.equal(preview.statusCode, 200);

  const requested = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/compliance/audit-export",
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(requested.statusCode, 200);

  await app.inject({
    method: "POST",
    path: `/exports/${requested.body.id}/approve`,
    headers: bearer("organizer-token"),
    body: {}
  });

  const ready = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/compliance/closeout-readiness",
    headers: bearer("organizer-token")
  });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.readiness.ready, true);
  assert.equal(ready.body.readiness.blockers.length, 0);
  assert.equal(ready.body.readiness.latest_compliance_audit_export.status, "generated");
  assert.equal(
    ready.body.readiness.runbook_links.compliance_closeout_runbook,
    "/Users/kishore/Codex Development/deploy/staging/PILOT_COMPLIANCE_CLOSEOUT_RUNBOOK.md"
  );
});

test("organizer pilot rehearsal report captures exercised flows and becomes ready", async () => {
  const app = await createApp();
  const tenantId = "tenant-demo";
  const eventId = "event-demo";
  const now = new Date().toISOString();

  const initial = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/pilot-rehearsal-report",
    headers: bearer("organizer-token")
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
    id: "report-snapshot-rehearsal",
    tenant_id: tenantId,
    event_id: eventId,
    report_snapshot_version: 2,
    payload: {
      snapshot_type: "official_event_report",
      note: "Pilot rehearsal freeze"
    },
    created_at: now
  });

  await app.repos.exportRequests.create({
    id: "export-compliance-rehearsal",
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
    approval_reason: "Rehearsal approved",
    rejection_reason: null,
    file_url: "/exports/export-compliance-rehearsal/download",
    file_expires_at: now,
    created_at: now
  });

  await app.repos.dataSubjectRequests.create({
    id: "dsr-access-rehearsal",
    tenant_id: tenantId,
    event_id: eventId,
    attendee_id: null,
    interaction_id: null,
    request_type: "access",
    status: "completed",
    requested_by_user_id: "user-organizer",
    request_reason: "Access rehearsal",
    resolution_summary: "Access package prepared",
    result_payload: {},
    created_at: now,
    updated_at: now,
    completed_at: now
  });

  await app.repos.dataSubjectRequests.create({
    id: "dsr-delete-rehearsal",
    tenant_id: tenantId,
    event_id: eventId,
    attendee_id: null,
    interaction_id: null,
    request_type: "delete",
    status: "completed",
    requested_by_user_id: "user-organizer",
    request_reason: "Delete rehearsal",
    resolution_summary: "Delete workflow completed",
    result_payload: {},
    created_at: now,
    updated_at: now,
    completed_at: now
  });

  await app.repos.downstreamDeletionRecords.create({
    id: "downstream-rehearsal",
    tenant_id: tenantId,
    event_id: eventId,
    dsr_request_id: "dsr-delete-rehearsal",
    target_system: "crm",
    status: "confirmed",
    requested_at: now,
    confirmed_at: now,
    details: {},
    last_error: null,
    updated_at: now
  });

  await app.repos.breakGlassAccess.create({
    id: "break-glass-rehearsal",
    tenant_id: tenantId,
    requested_by_user_id: "user-platform-1",
    first_approved_by_user_id: "user-platform-2",
    second_approved_by_user_id: "user-platform-3",
    justification: "Pilot rehearsal",
    access_scope: "masked_audit_only",
    status: "active",
    starts_at: now,
    expires_at: "2099-04-19T18:00:00.000Z",
    revoked_at: null,
    created_at: now
  });

  await app.repos.incidents.create({
    id: "incident-rehearsal",
    tenant_id: tenantId,
    device_id: "device-01",
    event_id: eventId,
    stall_id: "stall-a1",
    severity: "P2",
    code: "reader_disconnect",
    message: "Rehearsal incident",
    status: "resolved",
    assignment_checksum: "rehearsal-checksum",
    metadata: {
      runbook_tracking: {
        runbook_reference: "RUNBOOK-REHEARSAL",
        workaround_status: "validated"
      }
    },
    occurred_at: now,
    resolved_at: now,
    source_cursor: "rehearsal-source",
    raw_payload: {},
    created_at: now
  });

  await app.repos.auditLogs.create({
    id: "audit-rehearsal-incident-state",
    tenant_id: tenantId,
    actor_type: "user",
    actor_id: "user-organizer",
    event_type: "organizer.incident_state.updated",
    target_type: "incident",
    target_id: "incident-rehearsal",
    break_glass_access_id: null,
    metadata: {},
    created_at: now
  });
  await app.repos.auditLogs.create({
    id: "audit-rehearsal-incident-runbook",
    tenant_id: tenantId,
    actor_type: "user",
    actor_id: "user-organizer",
    event_type: "organizer.incident_runbook.updated",
    target_type: "incident",
    target_id: "incident-rehearsal",
    break_glass_access_id: null,
    metadata: {},
    created_at: now
  });
  await app.repos.auditLogs.create({
    id: "audit-rehearsal-break-glass",
    tenant_id: tenantId,
    actor_type: "user",
    actor_id: "user-platform-3",
    event_type: "break_glass.approved",
    target_type: "break_glass",
    target_id: "break-glass-rehearsal",
    break_glass_access_id: "break-glass-rehearsal",
    metadata: {},
    created_at: now
  });

  const ready = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/pilot-rehearsal-report",
    headers: bearer("organizer-token")
  });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.rehearsal.ready, true);
  assert.equal(ready.body.rehearsal.blockers.length, 0);
  assert.equal(ready.body.rehearsal.evidence.completed_delete_dsrs, 1);
  assert.equal(
    ready.body.rehearsal.runbook_links.pilot_rehearsal_runbook,
    "/Users/kishore/Codex Development/deploy/staging/PILOT_REHEARSAL_RUNBOOK.md"
  );
});

test("organizer pilot signoff pack aggregates readiness gates and supports export download", async () => {
  const app = await createApp();
  const tenantId = "tenant-demo";
  const eventId = "event-demo";
  const now = new Date().toISOString();

  const initial = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/pilot-signoff-pack",
    headers: bearer("organizer-token")
  });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.body.signoff.ready, false);
  assert.ok(
    initial.body.signoff.blockers.some((entry) => entry.includes("IoT go-live readiness"))
  );

  await app.repos.iotCertificationStatuses.upsert({
    id: "cert-signoff-demo",
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
    id: "health-signoff-demo",
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
    id: "parity-signoff-demo",
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
    id: "run-signoff-demo",
    integration_name: "iot_platform",
    tenant_id: tenantId,
    event_id: eventId,
    trigger_mode: "test",
    initiated_by: "foundation-test",
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
    id: "report-snapshot-signoff",
    tenant_id: tenantId,
    event_id: eventId,
    report_snapshot_version: 2,
    payload: {
      snapshot_type: "official_event_report",
      note: "Pilot signoff freeze"
    },
    created_at: now
  });

  await app.repos.exportRequests.create({
    id: "export-official-signoff",
    tenant_id: tenantId,
    event_id: eventId,
    requested_by_user_id: "user-organizer",
    requested_for_organization_id: "org-organizer",
    export_type: "organizer_event_report",
    filters: {
      report_snapshot_id: "report-snapshot-signoff"
    },
    row_count_estimate: 1,
    status: "generated",
    approval_required: true,
    approved_by_user_id: "user-organizer",
    approval_reason: "Official signoff package",
    rejection_reason: null,
    file_url: "/exports/export-official-signoff/download",
    file_expires_at: now,
    created_at: now
  });

  await app.repos.exportRequests.create({
    id: "export-compliance-signoff",
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
    approval_reason: "Pilot signoff approved",
    rejection_reason: null,
    file_url: "/exports/export-compliance-signoff/download",
    file_expires_at: now,
    created_at: now
  });

  await app.repos.dataSubjectRequests.create({
    id: "dsr-access-signoff",
    tenant_id: tenantId,
    event_id: eventId,
    attendee_id: null,
    interaction_id: null,
    request_type: "access",
    status: "completed",
    requested_by_user_id: "user-organizer",
    request_reason: "Access signoff",
    resolution_summary: "Access package prepared",
    result_payload: {},
    created_at: now,
    updated_at: now,
    completed_at: now
  });
  await app.repos.dataSubjectRequests.create({
    id: "dsr-delete-signoff",
    tenant_id: tenantId,
    event_id: eventId,
    attendee_id: null,
    interaction_id: null,
    request_type: "delete",
    status: "completed",
    requested_by_user_id: "user-organizer",
    request_reason: "Delete signoff",
    resolution_summary: "Delete workflow completed",
    result_payload: {},
    created_at: now,
    updated_at: now,
    completed_at: now
  });
  await app.repos.downstreamDeletionRecords.create({
    id: "downstream-signoff",
    tenant_id: tenantId,
    event_id: eventId,
    dsr_request_id: "dsr-delete-signoff",
    target_system: "crm",
    status: "confirmed",
    requested_at: now,
    confirmed_at: now,
    details: {},
    last_error: null,
    updated_at: now
  });
  await app.repos.complianceRuns.create({
    id: "compliance-run-signoff",
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
    id: "break-glass-signoff",
    tenant_id: tenantId,
    requested_by_user_id: "user-platform-1",
    first_approved_by_user_id: "user-platform-2",
    second_approved_by_user_id: "user-platform-3",
    justification: "Pilot signoff",
    access_scope: "masked_audit_only",
    status: "active",
    starts_at: now,
    expires_at: "2099-04-19T18:00:00.000Z",
    revoked_at: null,
    created_at: now
  });
  await app.repos.incidents.create({
    id: "incident-signoff",
    tenant_id: tenantId,
    device_id: "device-01",
    event_id: eventId,
    stall_id: "stall-a1",
    severity: "P2",
    code: "reader_disconnect",
    message: "Signoff incident",
    status: "resolved",
    assignment_checksum: "signoff-checksum",
    metadata: {
      runbook_tracking: {
        runbook_reference: "RUNBOOK-SIGNOFF",
        workaround_status: "validated"
      }
    },
    occurred_at: now,
    resolved_at: now,
    source_cursor: "signoff-source",
    raw_payload: {},
    created_at: now
  });
  await app.repos.auditLogs.create({
    id: "audit-signoff-incident-state",
    tenant_id: tenantId,
    actor_type: "user",
    actor_id: "user-organizer",
    event_type: "organizer.incident_state.updated",
    target_type: "incident",
    target_id: "incident-signoff",
    break_glass_access_id: null,
    metadata: {},
    created_at: now
  });
  await app.repos.auditLogs.create({
    id: "audit-signoff-incident-runbook",
    tenant_id: tenantId,
    actor_type: "user",
    actor_id: "user-organizer",
    event_type: "organizer.incident_runbook.updated",
    target_type: "incident",
    target_id: "incident-signoff",
    break_glass_access_id: null,
    metadata: {},
    created_at: now
  });
  await app.repos.auditLogs.create({
    id: "audit-signoff-break-glass",
    tenant_id: tenantId,
    actor_type: "user",
    actor_id: "user-platform-3",
    event_type: "break_glass.approved",
    target_type: "break_glass",
    target_id: "break-glass-signoff",
    break_glass_access_id: "break-glass-signoff",
    metadata: {},
    created_at: now
  });

  const ready = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/pilot-signoff-pack",
    headers: bearer("organizer-token")
  });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.signoff.ready, true);
  assert.equal(ready.body.signoff.blockers.length, 0);
  assert.equal(ready.body.signoff.sections.iot_go_live.ready, true);
  assert.equal(ready.body.signoff.sections.pilot_rehearsal.ready, true);
  assert.equal(ready.body.signoff.sections.compliance_closeout.ready, true);
  assert.equal(
    ready.body.signoff.runbook_links.pilot_signoff_pack,
    "/Users/kishore/Codex Development/deploy/staging/PILOT_SIGNOFF_PACK.md"
  );

  const requested = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/pilot-signoff-export",
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(requested.statusCode, 200);
  assert.equal(requested.body.filters.report_variant, "pilot_signoff");

  const approved = await app.inject({
    method: "POST",
    path: `/exports/${requested.body.id}/approve`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.body.status, "generated");

  const downloaded = await app.inject({
    method: "GET",
    path: `/exports/${requested.body.id}/download`,
    headers: bearer("organizer-token")
  });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(downloaded.body.file_name, "event-event-demo-pilot-signoff.json");
  assert.equal(downloaded.body.payload.ready, true);
  assert.equal(downloaded.body.payload.sections.iot_go_live.ready, true);

  const executionBlocked = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/pilot-go-live-execution",
    headers: bearer("organizer-token")
  });
  assert.equal(executionBlocked.statusCode, 200);
  assert.equal(executionBlocked.body.execution.ready, false);

  const dryRun = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/pilot-go-live-dry-run",
    headers: bearer("organizer-token"),
    body: {
      status: "completed",
      note: "Real staging dry run completed cleanly",
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
      headers: bearer("organizer-token"),
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
    headers: bearer("organizer-token")
  });
  assert.equal(executionReady.statusCode, 200);
  assert.equal(executionReady.body.execution.ready, true);
  assert.equal(executionReady.body.execution.approvals.length, 3);

  const finalBlocked = await app.inject({
    method: "GET",
    path: "/admin/events/event-demo/final-go-live",
    headers: bearer("platform-token")
  });
  assert.equal(finalBlocked.statusCode, 200);
  assert.equal(finalBlocked.body.launch.ready, false);
  assert.ok(finalBlocked.body.launch.blockers.some((entry) => entry.includes("Platform admin approval")));

  await app.repos.breakGlassAccess.update({
    ...(await app.repos.breakGlassAccess.findById(tenantId, "break-glass-signoff")),
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
      headers: bearer("platform-token"),
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
    headers: bearer("platform-token")
  });
  assert.equal(finalReady.statusCode, 200);
  assert.equal(finalReady.body.launch.ready, true);
  assert.equal(finalReady.body.launch.sections.joint_go_live_execution.ready, true);
  assert.equal(finalReady.body.launch.sections.pentest_findings.summary.blocking, 0);

  const finalExport = await app.inject({
    method: "POST",
    path: "/admin/events/event-demo/final-go-live/export",
    headers: bearer("platform-token"),
    body: {}
  });
  assert.equal(finalExport.statusCode, 200);
  assert.equal(finalExport.body.file_name, "event-event-demo-final-go-live-package.json");
  assert.equal(finalExport.body.payload.ready, true);
});

test("retention apply archives the event, anonymizes interactions, and expires event exports", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "retention-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-20T12:00:00Z"
    }
  });
  assert.equal(tap.statusCode, 201);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Retention User",
        company_name: "Northfield",
        email: "retention@example.com"
      }
    }
  });

  const walletPass = await app.inject({
    method: "POST",
    path: `/attendee/session/${tap.body.interaction_id}/wallet-pass`,
    body: {
      session_token: tap.body.attendee_session_token,
      pass_type: "generic"
    }
  });
  assert.equal(walletPass.statusCode, 201);
  assert.equal(walletPass.body.wallet_pass.status, "disabled");

  const crmSync = await app.inject({
    method: "POST",
    path: `/interactions/${tap.body.interaction_id}/crm-sync`,
    headers: bearer("vendor-token"),
    body: {}
  });
  assert.equal(crmSync.statusCode, 200);

  const exportRequest = await app.inject({
    method: "POST",
    path: "/exports/request",
    headers: bearer("organizer-token"),
    body: {
      event_id: "event-demo",
      export_type: "vendor_leads"
    }
  });
  assert.equal(exportRequest.statusCode, 200);

  await app.inject({
    method: "POST",
    path: `/exports/${exportRequest.body.id}/approve`,
    headers: bearer("organizer-token"),
    body: {}
  });

  app.state.events[0].status = "closed";
  app.state.events[0].ends_at = "2026-01-01T00:00:00Z";

  const preview = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/compliance/retention",
    headers: bearer("organizer-token"),
    body: {
      mode: "preview"
    }
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.body.interactions_to_anonymize, 1);

  const applied = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/compliance/retention",
    headers: bearer("organizer-token"),
    body: {
      mode: "apply"
    }
  });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.body.event_status, "archived");
  assert.equal(applied.body.short_links_to_expire >= 1, true);
  assert.equal(applied.body.wallet_passes_to_cleanup, 1);
  assert.equal(app.state.events[0].status, "archived");
  assert.equal(app.state.interactions[0].status, "anonymized");
  assert.equal(app.state.exportRequests[0].status, "expired");
  assert.ok(app.state.shortLinks.every((entry) => entry.status === "expired"));
  assert.equal(app.state.walletPasses[0].status, "cancelled");
  assert.equal(app.state.walletPasses[0].failure_message, null);

  const profile = await app.repos.attendeeProfiles.findByAttendeeId(app.state.attendees[0].id);
  assert.equal(profile.full_name, null);
  assert.equal(profile.email, null);

  const crmRecord = await app.repos.crmSyncRecords.findByInteractionAndProvider(
    "tenant-demo",
    tap.body.interaction_id,
    "pilot_crm"
  );
  assert.equal(crmRecord.status, "delete_pending");
  assert.equal(crmRecord.request_payload.redacted, true);
  assert.equal(crmRecord.request_payload.external_record_id, crmSync.body.external_record_id);
});

test("organizer incident detail links fleet context, alerts, audits, exports, and break-glass requests", async () => {
  const app = await createApp();
  const now = "2026-04-19T10:30:00Z";
  app.state.heartbeats.push({
    id: "heartbeat-demo-1",
    tenant_id: "tenant-demo",
    device_id: "device-01",
    event_id: "event-demo",
    stall_id: "stall-a1",
    battery_level: 77,
    local_queue_depth: 3,
    assignment_checksum: "checksum-demo",
    connectivity_status: "online",
    reader_status: "disconnected",
    app_version: "1.2.3",
    firmware_version: "2.0.0",
    source_cursor: "heartbeat-demo-1",
    raw_payload: {},
    recorded_at: now
  });
  app.state.incidents.push({
    id: "incident-demo-1",
    tenant_id: "tenant-demo",
    device_id: "device-01",
    event_id: "event-demo",
    stall_id: "stall-a1",
    severity: "critical",
    code: "reader_disconnect",
    message: "Reader disconnected during live operation",
    status: "open",
    assignment_checksum: "checksum-demo",
    metadata: { cable: "usb-c" },
    occurred_at: now,
    resolved_at: null,
    source_cursor: "incident-cursor-1",
    raw_payload: {},
    created_at: now
  });
  app.state.iotAlertEvents.push({
    id: "alert-demo-1",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    source_type: "device",
    source_id: "device-01",
    dedupe_key: "alert-demo-1",
    severity: "critical",
    status: "open",
    code: "reader_disconnect",
    message: "Reader disconnected",
    details: { device_id: "device-01" },
    delivery_status: "delivered",
    routed_destinations: ["staging"],
    last_delivery_at: now,
    delivery_error: null,
    created_at: now,
    updated_at: now
  });
  app.state.iotDeviceStatusSnapshots.push({
    id: "snapshot-demo-1",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    device_id: "device-01",
    assignment_status: "matched",
    diagnostics_status: "degraded",
    connectivity_status: "online",
    reader_status: "disconnected",
    app_version: "1.2.3",
    firmware_version: "2.0.0",
    local_queue_depth: 3,
    last_heartbeat_at: now,
    checked_at: now
  });

  const exportRequest = await app.inject({
    method: "POST",
    path: "/exports/request",
    headers: bearer("organizer-token"),
    body: {
      event_id: "event-demo",
      export_type: "organizer_event_report"
    }
  });
  assert.equal(exportRequest.statusCode, 200);

  const breakGlassRequest = await app.inject({
    method: "POST",
    path: "/break-glass/request",
    headers: {
      ...bearer("platform-token"),
      "x-tenant-id": "tenant-demo"
    },
    body: {
      justification: "Incident review for reader disconnect",
      access_scope: "masked_audit_only",
      expires_at: "2099-04-19T18:00:00Z"
    }
  });
  assert.equal(breakGlassRequest.statusCode, 200);

  const response = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/incidents/incident-demo-1",
    headers: bearer("organizer-token")
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.item.code, "reader_disconnect");
  assert.equal(response.body.fleet_context.reader_status, "disconnected");
  assert.equal(response.body.related_alerts.length, 1);
  assert.equal(response.body.related_exports.length, 1);
  assert.equal(response.body.related_break_glass_requests.length, 1);
  assert.ok(response.body.timeline.length >= 1);

  const escalated = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/incidents/incident-demo-1/state",
    headers: bearer("organizer-token"),
    body: {
      action: "escalate",
      note: "Escalated after second disconnect on the same reader"
    }
  });

  assert.equal(escalated.statusCode, 200);
  assert.equal(escalated.body.item.status, "escalated");
  assert.equal(escalated.body.annotations.at(-1).action_type, "escalation");
  assert.ok(escalated.body.timeline.some((entry) => entry.label === "Status changed to escalated"));

  const runbook = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/incidents/incident-demo-1/runbook",
    headers: bearer("organizer-token"),
    body: {
      runbook_reference: "RUNBOOK-42",
      workaround_status: "active",
      workaround_summary: "Swapped the USB cable and moved to spare reader",
      next_action: "Monitor for the next 15 minutes"
    }
  });

  assert.equal(runbook.statusCode, 200);
  assert.equal(runbook.body.runbook_tracking.runbook_reference, "RUNBOOK-42");
  assert.equal(runbook.body.runbook_tracking.workaround_status, "active");
  assert.ok(runbook.body.timeline.some((entry) => entry.label === "Runbook/workaround updated"));

  const annotation = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/incidents/incident-demo-1/annotations",
    headers: bearer("organizer-token"),
    body: {
      note: "Operator moved device to spare reader",
      action_type: "mitigation"
    }
  });

  assert.equal(annotation.statusCode, 200);
  assert.ok(annotation.body.annotations.length >= 3);

  const resolved = await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/incidents/incident-demo-1/state",
    headers: bearer("organizer-token"),
    body: {
      action: "resolve",
      note: "Reader stabilized after cable swap and monitoring"
    }
  });

  assert.equal(resolved.statusCode, 200);
  assert.equal(resolved.body.item.status, "resolved");
  assert.ok(resolved.body.item.resolved_at);
  assert.ok(resolved.body.timeline.some((entry) => entry.label === "Status changed to resolved"));

  const deviceHistory = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/devices/device-01/history",
    headers: bearer("organizer-token")
  });

  assert.equal(deviceHistory.statusCode, 200);
  assert.equal(deviceHistory.body.heartbeats.length, 1);
  assert.equal(deviceHistory.body.incidents.length, 1);

  const overview = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/overview",
    headers: bearer("organizer-token")
  });

  assert.equal(overview.statusCode, 200);
  assert.equal(overview.body.open_incidents, 0);
});

test("break-glass requires two distinct approvers", async () => {
  const app = await createApp();
  const request = await app.inject({
    method: "POST",
    path: "/break-glass/request",
    headers: {
      ...bearer("platform-token"),
      "x-tenant-id": "tenant-demo"
    },
    body: {
      justification: "Investigate trust incident",
      access_scope: "masked_audit_only",
      expires_at: "2099-04-17T12:00:00Z"
    }
  });

  const firstApproval = await app.inject({
    method: "POST",
    path: `/break-glass/${request.body.id}/approve`,
    headers: bearer("platform-2-token"),
    body: {}
  });

  const secondApprovalBySameUser = await app.inject({
    method: "POST",
    path: `/break-glass/${request.body.id}/approve`,
    headers: bearer("platform-2-token"),
    body: {}
  });

  const finalApproval = await app.inject({
    method: "POST",
    path: `/break-glass/${request.body.id}/approve`,
    headers: bearer("platform-3-token"),
    body: {}
  });

  assert.equal(firstApproval.body.status, "partially_approved");
  assert.equal(secondApprovalBySameUser.statusCode, 409);
  assert.equal(finalApproval.body.status, "active");

  const list = await app.inject({
    method: "GET",
    path: "/break-glass",
    headers: bearer("platform-token")
  });

  assert.equal(list.statusCode, 200);
  assert.equal(list.body.items[0].id, request.body.id);
});

test("device sync rejects cross-event or cross-stall items", async () => {
  const app = await createApp();

  const response = await app.inject({
    method: "POST",
    path: "/device/sync",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      items: [
        {
          device_id: "device-01",
          event_id: "event-other",
          stall_id: "stall-b1",
          local_event_id: "cross-event-1",
          tap_type: "qr",
          occurred_at: "2026-04-17T09:20:00Z"
        }
      ]
    }
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /active device assignment/);
});

test("vendor cannot access another stall outside assigned stall scope", async () => {
  const app = await createApp();

  const response = await app.inject({
    method: "GET",
    path: "/stalls/stall-a2/leads",
    headers: bearer("vendor-token")
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /STALL_SCOPE_FORBIDDEN/);
});

test("organizer cannot access another event outside event scope", async () => {
  const app = await createApp();

  const response = await app.inject({
    method: "GET",
    path: "/organizer/events/event-other/overview",
    headers: bearer("organizer-token")
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body.error, /EVENT_SCOPE_FORBIDDEN/);
});

test("organizer data control applies secure defaults, validates retention, and gates publish", async () => {
  const app = await createApp();
  app.state.userAccessScopes.push({
    id: "scope-organizer-event-other",
    tenant_id: "tenant-demo",
    user_id: "user-organizer",
    event_id: "event-other",
    stall_id: null,
    sponsor_organization_id: null,
    created_at: new Date().toISOString()
  });
  app.state.eventPolicies = app.state.eventPolicies.filter((entry) => entry.event_id !== "event-other");

  const detail = await app.inject({
    method: "GET",
    path: "/organizer/events/event-other/data-control",
    headers: bearer("organizer-token")
  });

  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.database_persistence.policy_row_present, false);
  assert.equal(detail.body.database_persistence.secure_defaults_applied, true);
  assert.equal(detail.body.ui_states.publish_ready, false);
  assert.equal(detail.body.policy.allow_crm_push, false);

  const blockedPublish = await app.inject({
    method: "POST",
    path: "/organizer/events/event-other/publish",
    headers: bearer("organizer-token")
  });

  assert.equal(blockedPublish.statusCode, 409);
  assert.equal(blockedPublish.body.details.data_control.database_persistence.policy_row_present, false);

  const invalidSave = await app.inject({
    method: "PUT",
    path: "/organizer/events/event-other/data-control",
    headers: bearer("organizer-token"),
    body: {
      vendor_exports_enabled: true,
      sponsor_pii_enabled: false,
      require_export_approval: true,
      allow_crm_push: true,
      retention_days: 45,
      allow_cross_event_identity_graph: false
    }
  });

  assert.equal(invalidSave.statusCode, 400);
  assert.match(invalidSave.body.error, /retention_days/);

  const saved = await app.inject({
    method: "PUT",
    path: "/organizer/events/event-other/data-control",
    headers: bearer("organizer-token"),
    body: {
      vendor_exports_enabled: true,
      sponsor_pii_enabled: true,
      require_export_approval: true,
      allow_crm_push: true,
      retention_days: 60,
      allow_cross_event_identity_graph: false
    }
  });

  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.database_persistence.policy_row_present, true);
  assert.equal(saved.body.policy.retention_days, 60);
  assert.equal(saved.body.ui_states.publish_ready, true);

  const publish = await app.inject({
    method: "POST",
    path: "/organizer/events/event-other/publish",
    headers: bearer("organizer-token")
  });

  assert.equal(publish.statusCode, 200);
  assert.equal(publish.body.status, "published");
  assert.equal(app.state.events.find((entry) => entry.id === "event-other")?.status, "published");
});

test("attendee consent changes require a valid signed attendee session", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "local-4",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:04:00Z"
    }
  });

  const missingToken = await app.inject({
    method: "POST",
    path: "/consents/capture",
    headers: { "x-tenant-id": "tenant-demo" },
    body: {
      interaction_id: tap.body.interaction_id,
      vendor_release_allowed: true,
      sponsor_release_allowed: false
    }
  });

  const tamperedToken = await app.inject({
    method: "POST",
    path: "/consents/capture",
    headers: { "x-tenant-id": "tenant-demo" },
    body: {
      session_token: `${tap.body.attendee_session_token}tampered`,
      vendor_release_allowed: true,
      sponsor_release_allowed: false
    }
  });

  assert.equal(missingToken.statusCode, 400);
  assert.equal(tamperedToken.statusCode, 401);
});

test("attendee session view returns consent, profile, and current connections for a valid session token", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "local-4b",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:04:30Z"
    }
  });

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    headers: {
      "x-tenant-id": "tenant-demo",
      "x-forwarded-for": "203.0.113.9",
      "user-agent": "AttendeeBrowser/1.0",
      "accept-language": "en-IN,en;q=0.8"
    },
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      locale: "hi-IN",
      attendee_profile: {
        full_name: "Session Viewer",
        company_name: "Expo Realty",
        email: "session@example.com"
      }
    }
  });

  const session = await app.inject({
    method: "GET",
    path: `/attendee/session/${tap.body.interaction_id}?token=${encodeURIComponent(tap.body.attendee_session_token)}`
  });

  assert.equal(session.statusCode, 200);
  assert.equal(session.body.interaction_id, tap.body.interaction_id);
  assert.equal(session.body.attendee_profile.full_name, "Session Viewer");
  assert.equal(session.body.consent.vendor_release_allowed, true);
  assert.equal(session.body.current_connection.stall_id, "stall-a1");
  assert.equal(session.body.connections.length, 1);
  assert.equal(session.body.privacy.self_service_controls.request_access_export.endpoint, `/attendee/session/${tap.body.interaction_id}/dsr`);
  assert.equal(session.body.privacy.self_service_controls.request_delete.request_type, "delete");

  const sessionWalletPass = await app.inject({
    method: "POST",
    path: `/attendee/session/${tap.body.interaction_id}/wallet-pass`,
    body: {
      session_token: tap.body.attendee_session_token,
      pass_type: "generic"
    }
  });
  assert.equal(sessionWalletPass.statusCode, 201);
  assert.equal(sessionWalletPass.body.wallet_pass.interaction_id, tap.body.interaction_id);

  const accessRequest = await app.inject({
    method: "POST",
    path: `/attendee/session/${tap.body.interaction_id}/dsr`,
    body: {
      session_token: tap.body.attendee_session_token,
      request_type: "access",
      request_reason: "Attendee wants a copy of stored connections"
    }
  });
  assert.equal(accessRequest.statusCode, 201);
  assert.equal(accessRequest.body.request_type, "access");
  assert.equal(accessRequest.body.status, "requested");
  assert.equal(accessRequest.body.interaction_id, tap.body.interaction_id);

  const completedAccess = await app.inject({
    method: "POST",
    path: `/organizer/events/event-demo/dsr/${accessRequest.body.id}/complete`,
    headers: bearer("organizer-token"),
    body: {
      resolution_summary: "Access package prepared from attendee self-service request"
    }
  });
  assert.equal(completedAccess.statusCode, 200);
  assert.equal(completedAccess.body.result_payload.consent_events.length, 1);
  assert.equal(completedAccess.body.result_payload.consent_events[0].locale, "hi-IN");
  assert.equal(completedAccess.body.result_payload.consent_events[0].ip_address, "203.0.113.9");
  assert.equal(completedAccess.body.result_payload.consent_events[0].user_agent, "AttendeeBrowser/1.0");
  assert.equal(completedAccess.body.result_payload.wallet_pass_records.length, 1);
  assert.equal(completedAccess.body.result_payload.wallet_pass_attempts.length, 1);
  assert.ok(completedAccess.body.result_payload.short_link_records.some((entry) => entry.target_type === "attendee_session"));

  const deleteRequest = await app.inject({
    method: "POST",
    path: `/attendee/session/${tap.body.interaction_id}/dsr`,
    body: {
      session_token: tap.body.attendee_session_token,
      request_type: "delete"
    }
  });
  assert.equal(deleteRequest.statusCode, 201);
  assert.equal(deleteRequest.body.request_type, "delete");

  const organizerQueue = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/dsr",
    headers: bearer("organizer-token")
  });
  assert.equal(organizerQueue.statusCode, 200);
  assert.equal(organizerQueue.body.items.some((item) => item.id === accessRequest.body.id && item.requested_by_user_id === null), true);
  assert.equal(organizerQueue.body.items.some((item) => item.id === deleteRequest.body.id && item.request_reason === "Attendee self-service delete request"), true);

  const invalidType = await app.inject({
    method: "POST",
    path: `/attendee/session/${tap.body.interaction_id}/dsr`,
    body: {
      session_token: tap.body.attendee_session_token,
      request_type: "rectify"
    }
  });
  assert.equal(invalidType.statusCode, 400);

  const invalidConsent = await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: "true",
      sponsor_release_allowed: false
    }
  });
  assert.equal(invalidConsent.statusCode, 400);
  assert.match(invalidConsent.body.error, /explicit booleans/);
});

test("short links resolve attendee sessions and export downloads with expiry enforcement", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "short-link-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:05:30Z"
    }
  });

  assert.equal(tap.statusCode, 201);
  assert.match(tap.body.customer_short_link, /^\/s\/[^/]+$/);
  assert.equal(tap.body.customer_short_link.includes(tap.body.attendee_session_token), false);

  const resolvedAttendee = await app.inject({
    method: "GET",
    path: tap.body.customer_short_link
  });
  assert.equal(resolvedAttendee.statusCode, 200);
  assert.equal(resolvedAttendee.body.target_type, "attendee_session");
  assert.equal(resolvedAttendee.body.interaction_id, tap.body.interaction_id);
  assert.match(resolvedAttendee.body.target_url, new RegExp(tap.body.interaction_id));

  const attendeeShortLink = app.state.shortLinks.find((entry) => entry.id === resolvedAttendee.body.short_link_id);
  attendeeShortLink.expires_at = "2000-01-01T00:00:00.000Z";
  await app.repos.shortLinks.update(attendeeShortLink);
  const expiredAttendee = await app.inject({
    method: "GET",
    path: tap.body.customer_short_link
  });
  assert.equal(expiredAttendee.statusCode, 410);

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Short Link Export",
        company_name: "Export Co",
        email: "short-export@example.com"
      }
    }
  });

  const requested = await app.inject({
    method: "POST",
    path: "/exports/request",
    headers: bearer("vendor-token"),
    body: {
      event_id: "event-demo",
      export_type: "vendor_leads"
    }
  });
  assert.equal(requested.statusCode, 200);

  const approved = await app.inject({
    method: "POST",
    path: `/exports/${requested.body.id}/approve`,
    headers: bearer("organizer-token")
  });
  assert.equal(approved.statusCode, 200);

  const exportShortLink = await app.inject({
    method: "POST",
    path: `/exports/${requested.body.id}/short-link`,
    headers: bearer("vendor-token")
  });
  assert.equal(exportShortLink.statusCode, 201);
  assert.match(exportShortLink.body.short_link_url, /^\/s\/[^/]+$/);

  const resolvedExport = await app.inject({
    method: "GET",
    path: exportShortLink.body.short_link_url
  });
  assert.equal(resolvedExport.statusCode, 200);
  assert.equal(resolvedExport.body.target_type, "export_download");
  assert.equal(resolvedExport.body.export_id, requested.body.id);
  assert.equal(resolvedExport.body.payload.leads[0].profile.full_name, "Short Link Export");

  const linkInventory = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/short-links",
    headers: bearer("organizer-token")
  });
  assert.equal(linkInventory.statusCode, 200);
  assert.equal(linkInventory.body.pagination.limit, 50);
  assert.equal(linkInventory.body.pagination.offset, 0);
  assert.ok(linkInventory.body.items.some((entry) => entry.id === exportShortLink.body.id && entry.status === "active"));

  const pagedLinkInventory = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/short-links?limit=1&offset=0",
    headers: bearer("organizer-token")
  });
  assert.equal(pagedLinkInventory.statusCode, 200);
  assert.equal(pagedLinkInventory.body.items.length, 1);
  assert.equal(pagedLinkInventory.body.pagination.limit, 1);

  const freezeStatusWithActiveLink = await app.inject({
    method: "GET",
    path: "/organizer/events/event-demo/report-freeze",
    headers: bearer("organizer-token")
  });
  assert.equal(freezeStatusWithActiveLink.statusCode, 200);
  assert.equal(freezeStatusWithActiveLink.body.artifact_freeze_checks.active_short_links >= 1, true);
  assert.equal(freezeStatusWithActiveLink.body.artifact_freeze_checks.ready, false);

  const linkStatus = await app.inject({
    method: "GET",
    path: `/short-links/${exportShortLink.body.id}/status`,
    headers: bearer("organizer-token")
  });
  assert.equal(linkStatus.statusCode, 200);
  assert.equal(linkStatus.body.target_type, "export_download");
  assert.equal(linkStatus.body.revocable, true);

  const revoked = await app.inject({
    method: "POST",
    path: `/short-links/${exportShortLink.body.id}/revoke`,
    headers: bearer("organizer-token"),
    body: {
      reason: "Investigation complete"
    }
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.body.status, "revoked");

  const revokedResolve = await app.inject({
    method: "GET",
    path: exportShortLink.body.short_link_url
  });
  assert.equal(revokedResolve.statusCode, 410);
});

test("wallet pass requests are safe-disabled and provider failures remain non-blocking", async () => {
  const disabledApp = await createApp();
  const disabledTap = await disabledApp.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "wallet-disabled-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:07:30Z"
    }
  });
  assert.equal(disabledTap.statusCode, 201);

  const disabledPass = await disabledApp.inject({
    method: "POST",
    path: `/attendee/session/${disabledTap.body.interaction_id}/wallet-pass`,
    body: {
      session_token: disabledTap.body.attendee_session_token,
      pass_type: "generic"
    }
  });
  assert.equal(disabledPass.statusCode, 201);
  assert.equal(disabledPass.body.non_blocking, true);
  assert.equal(disabledPass.body.wallet_pass.status, "disabled");
  assert.equal(disabledPass.body.wallet_pass.failure_code, "wallet_pass_feature_disabled");
  assert.equal(disabledPass.body.attempts.length, 1);
  assert.equal(disabledPass.body.attempts[0].status, "disabled");

  const disabledList = await disabledApp.inject({
    method: "GET",
    path: `/interactions/${disabledTap.body.interaction_id}/wallet-passes`,
    headers: bearer("vendor-token")
  });
  assert.equal(disabledList.statusCode, 200);
  assert.equal(disabledList.body.wallet_passes[0].status, "disabled");
  assert.equal(disabledList.body.wallet_passes[0].attempts_count, 1);

  const failedApp = await createApp({
    env: {
      WALLET_PASS_ENABLED: "true"
    }
  });
  const failedTap = await failedApp.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "wallet-provider-failed-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:08:30Z"
    }
  });
  const failedPass = await failedApp.inject({
    method: "POST",
    path: `/attendee/session/${failedTap.body.interaction_id}/wallet-pass`,
    body: {
      session_token: failedTap.body.attendee_session_token,
      pass_type: "apple"
    }
  });
  assert.equal(failedPass.statusCode, 201);
  assert.equal(failedPass.body.non_blocking, true);
  assert.equal(failedPass.body.wallet_pass.status, "failed");
  assert.equal(failedPass.body.wallet_pass.failure_code, "wallet_pass_provider_not_configured");
  assert.equal(failedPass.body.attempts.length, 1);
  assert.equal(failedPass.body.attempts[0].status, "failed");
  const walletAlerts = await failedApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/operational-alerts",
    headers: bearer("organizer-token")
  });
  assert.equal(walletAlerts.statusCode, 200);
  assert.equal(walletAlerts.body.counts.wallet_passes, 1);
  assert.ok(walletAlerts.body.items.some(
    (item) =>
      item.kind === "wallet_pass" &&
      item.wallet_pass_id === failedPass.body.wallet_pass.id &&
      item.status === "failed"
  ));
  const walletAttemptExport = await failedApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/artifact-attempts/export",
    headers: bearer("organizer-token")
  });
  assert.equal(walletAttemptExport.statusCode, 200);
  assert.match(walletAttemptExport.body.csv, /wallet_pass/);
  assert.match(walletAttemptExport.body.csv, /wallet_pass_provider_not_configured/);

  const generatedApp = await createApp({
    env: {
      WALLET_PASS_ENABLED: "true",
      WALLET_PASS_PROVIDER_MODE: "mock_success"
    }
  });
  const generatedTap = await generatedApp.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "wallet-generated-1",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:09:30Z"
    }
  });
  const generatedPass = await generatedApp.inject({
    method: "POST",
    path: `/attendee/session/${generatedTap.body.interaction_id}/wallet-pass`,
    body: {
      session_token: generatedTap.body.attendee_session_token,
      pass_type: "google"
    }
  });
  assert.equal(generatedPass.statusCode, 201);
  assert.equal(generatedPass.body.wallet_pass.status, "generated");
  assert.match(generatedPass.body.short_link.short_link_url, /^\/s\/[^/]+$/);
  assert.equal(generatedPass.body.attempts.length, 1);
  assert.equal(generatedPass.body.attempts[0].status, "generated");

  const resolvedWallet = await generatedApp.inject({
    method: "GET",
    path: generatedPass.body.short_link.short_link_url
  });
  assert.equal(resolvedWallet.statusCode, 200);
  assert.equal(resolvedWallet.body.target_type, "wallet_pass");
  assert.equal(resolvedWallet.body.wallet_pass.pass_type, "google");

  const delivered = await generatedApp.inject({
    method: "POST",
    path: `/wallet-passes/${generatedPass.body.wallet_pass.id}/status`,
    headers: bearer("organizer-token"),
    body: {
      status: "delivered"
    }
  });
  assert.equal(delivered.statusCode, 200);
  assert.equal(delivered.body.wallet_pass.status, "delivered");
  const walletAudit = await generatedApp.inject({
    method: "GET",
    path: "/audit/logs",
    headers: bearer("organizer-token")
  });
  assert.equal(walletAudit.statusCode, 200);
  assert.ok(walletAudit.body.items.some(
    (entry) =>
      entry.event_type === "wallet_pass.status.updated" &&
      entry.target_id === generatedPass.body.wallet_pass.id
  ));

  const retryDelivered = await generatedApp.inject({
    method: "POST",
    path: `/wallet-passes/${generatedPass.body.wallet_pass.id}/retry`,
    headers: bearer("organizer-token"),
    body: {}
  });
  assert.equal(retryDelivered.statusCode, 409);
});

test("organizer provider readiness exposes wallet and notification channel states", async () => {
  const safeDisabledApp = await createApp();
  const safeDisabled = await safeDisabledApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/provider-readiness",
    headers: bearer("organizer-token")
  });
  assert.equal(safeDisabled.statusCode, 200);
  assert.equal(safeDisabled.body.blocking, false);
  assert.equal(safeDisabled.body.wallet_pass.status, "disabled");
  assert.equal(safeDisabled.body.notifications.find((entry) => entry.channel === "email").status, "disabled");
  assert.equal(safeDisabled.body.notifications.find((entry) => entry.channel === "email").webhook_ready, true);
  assert.equal(safeDisabled.body.scheduler.status, "disabled");

  const readyApp = await createApp({
    env: {
      WALLET_PASS_ENABLED: "true",
      WALLET_PASS_PROVIDER_MODE: "mock_success",
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_success",
      NOTIFICATION_WORKER_ENABLED: "true",
      NOTIFICATION_WORKER_TENANT_ID: "tenant-demo"
    }
  });
  const ready = await readyApp.inject({
    method: "GET",
    path: "/organizer/events/event-demo/provider-readiness",
    headers: bearer("organizer-token")
  });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.body.wallet_pass.status, "ready");
  assert.equal(ready.body.notifications.find((entry) => entry.channel === "email").status, "ready");
  assert.equal(ready.body.notifications.find((entry) => entry.channel === "email").webhook_ready, true);
  assert.equal(ready.body.notifications.find((entry) => entry.channel === "sms").status, "disabled");
  assert.equal(ready.body.scheduler.status, "ready");
});

test("denied sensitive actions are audited", async () => {
  const app = await createApp();

  await app.inject({
    method: "POST",
    path: "/exports/request",
    headers: bearer("sponsor-token"),
    body: {
      event_id: "event-demo",
      export_type: "sponsor_leads"
    }
  });

  const auditResponse = await app.inject({
    method: "GET",
    path: "/audit/logs",
    headers: bearer("platform-token")
  });

  const deniedEntry = auditResponse.body.items.find((item) => item.event_type === "export.requested.denied");
  assert.ok(deniedEntry);
  assert.equal(deniedEntry.metadata.status_code, 403);
});

test("platform admin sees masked leads by default and unmasked with active break-glass", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "local-5",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:05:00Z"
    }
  });

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    headers: { "x-tenant-id": "tenant-demo" },
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Break Glass User",
        company_name: "Scoped Realty",
        email: "bg@example.com"
      }
    }
  });

  const maskedResponse = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads",
    headers: bearer("platform-token")
  });

  const breakGlassRequest = await app.inject({
    method: "POST",
    path: "/break-glass/request",
    headers: {
      ...bearer("platform-token"),
      "x-tenant-id": "tenant-demo"
    },
    body: {
      justification: "Investigate consent issue",
      access_scope: JSON.stringify({
        permissions: ["stall_leads_unmask"],
        event_ids: ["event-demo"],
        stall_ids: ["stall-a1"]
      }),
      expires_at: "2099-04-17T15:00:00Z"
    }
  });

  await app.inject({
    method: "POST",
    path: `/break-glass/${breakGlassRequest.body.id}/approve`,
    headers: bearer("platform-2-token"),
    body: {}
  });

  await app.inject({
    method: "POST",
    path: `/break-glass/${breakGlassRequest.body.id}/approve`,
    headers: bearer("platform-3-token"),
    body: {}
  });

  const unmaskedResponse = await app.inject({
    method: "GET",
    path: "/stalls/stall-a1/leads",
    headers: {
      ...bearer("platform-token"),
      "x-break-glass-id": breakGlassRequest.body.id
    }
  });

  assert.equal(maskedResponse.body.items[0].full_name, "Masked until consent");
  assert.equal(unmaskedResponse.body.items[0].full_name, "Break Glass User");
  assert.equal(unmaskedResponse.body.items[0].break_glass_access_id, breakGlassRequest.body.id);
});

test("vendor lead detail is masked until vendor consent exists and note list is scoped to the same interaction", async () => {
  const app = await createApp();
  const tap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("device-token"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "local-5b",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-17T09:05:30Z"
    }
  });

  await app.inject({
    method: "POST",
    path: "/consents/capture",
    headers: { "x-tenant-id": "tenant-demo" },
    body: {
      session_token: tap.body.attendee_session_token,
      vendor_release_allowed: false,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Detail Viewer",
        company_name: "Masked Co",
        email: "detail@example.com"
      }
    }
  });

  const maskedDetail = await app.inject({
    method: "GET",
    path: `/interactions/${tap.body.interaction_id}/detail`,
    headers: bearer("vendor-token")
  });

  assert.equal(maskedDetail.statusCode, 200);
  assert.equal(maskedDetail.body.item.full_name, "Masked until consent");
  assert.equal(maskedDetail.body.item.masked, true);

  await app.inject({
    method: "POST",
    path: `/interactions/${tap.body.interaction_id}/note`,
    headers: bearer("vendor-token"),
    body: {
      note: "Warm follow-up requested"
    }
  });

  const notes = await app.inject({
    method: "GET",
    path: `/interactions/${tap.body.interaction_id}/notes`,
    headers: bearer("vendor-token")
  });

  assert.equal(notes.statusCode, 200);
  assert.equal(notes.body.items.length, 1);
  assert.equal(notes.body.items[0].note, "Warm follow-up requested");
});

test("device credentials can be provisioned, used, and revoked", async () => {
  const app = await createApp();

  const provision = await app.inject({
    method: "POST",
    path: "/devices/device-01/credentials/provision",
    headers: bearer("organizer-token"),
    body: {
      credential_label: "Field tablet"
    }
  });

  assert.equal(provision.statusCode, 201);
  assert.ok(provision.body.bearer_token.startsWith("dvc_"));

  const config = await app.inject({
    method: "GET",
    path: "/device/config/device-01",
    headers: bearer(provision.body.bearer_token)
  });

  assert.equal(config.statusCode, 200);
  assert.equal(config.body.device_id, "device-01");

  const revoke = await app.inject({
    method: "POST",
    path: `/devices/device-01/credentials/${provision.body.credential.id}/revoke`,
    headers: bearer("organizer-token"),
    body: {}
  });

  assert.equal(revoke.statusCode, 200);
  assert.equal(revoke.body.status, "revoked");

  const rejected = await app.inject({
    method: "GET",
    path: "/device/config/device-01",
    headers: bearer(provision.body.bearer_token)
  });

  assert.equal(rejected.statusCode, 401);
});

test("secure mode rejects seed bearer tokens while still accepting provisioned device credentials", async () => {
  const app = await createApp({ securityMode: "secure", sessionSecret: "test-secure-session-secret" });

  const seededUser = await app.inject({
    method: "GET",
    path: "/auth/me",
    headers: bearer("organizer-token")
  });

  const provisionedDevice = await app.inject({
    method: "GET",
    path: "/auth/me",
    headers: bearer("dvc_seed_device_01")
  });

  assert.equal(seededUser.statusCode, 401);
  assert.match(seededUser.body.error, /Invalid bearer token/);
  assert.equal(provisionedDevice.statusCode, 200);
  assert.equal(provisionedDevice.body.principal.role, "device_principal");
});

test("secure mode does not allow OIDC email fallback unless it is explicitly enabled", async () => {
  const state = createSeedState();
  const organizer = state.users.find((entry) => entry.id === "user-organizer");
  organizer.external_identity_provider = null;
  organizer.external_subject = null;

  const originalFetch = global.fetch;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = "email-fallback-test-key";
  jwk.use = "sig";
  jwk.alg = "RS256";

  global.fetch = async (url) => {
    if (String(url).endsWith("/.well-known/openid-configuration")) {
      return {
        ok: true,
        async json() {
          return {
            issuer: "https://issuer.example.com",
            jwks_uri: "https://issuer.example.com/jwks"
          };
        }
      };
    }
    if (String(url) === "https://issuer.example.com/jwks") {
      return {
        ok: true,
        async json() {
          return { keys: [jwk] };
        }
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "email-fallback-test-key" })
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://issuer.example.com",
      sub: "oidc-unlinked-user",
      aud: "physical-world-interaction-platform",
      exp: now + 300,
      iat: now,
      email: organizer.email
    })
  ).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const token = `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;

  const secureApp = await createApp({
    state,
    securityMode: "secure",
    sessionSecret: "test-secure-session-secret",
    oidc: {
      enabled: true,
      issuer: "https://issuer.example.com",
      audience: "physical-world-interaction-platform"
    }
  });

  const fallbackApp = await createApp({
    state,
    securityMode: "secure",
    sessionSecret: "test-secure-session-secret",
    oidc: {
      enabled: true,
      issuer: "https://issuer.example.com",
      audience: "physical-world-interaction-platform",
      allowEmailFallback: true
    }
  });

  try {
    const denied = await secureApp.inject({
      method: "GET",
      path: "/auth/me",
      headers: bearer(token)
    });
    const allowed = await fallbackApp.inject({
      method: "GET",
      path: "/auth/me",
      headers: bearer(token)
    });

    assert.equal(denied.statusCode, 403);
    assert.match(denied.body.error, /not linked to a platform user/);
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.body.principal.user_id, "user-organizer");
    assert.equal(allowed.body.principal.auth_source, "oidc");
  } finally {
    global.fetch = originalFetch;
    await secureApp.close();
    await fallbackApp.close();
  }
});

test("secure mode requires an explicit session secret", async () => {
  await assert.rejects(
    () => createApp({ securityMode: "secure" }),
    /SESSION_SECRET is required/
  );
});

test("secure mode responses include hardening headers", async () => {
  const app = await createApp({
    securityMode: "secure",
    sessionSecret: "test-secure-session-secret"
  });

  const response = await app.inject({
    method: "GET",
    path: "/health"
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal(response.headers["x-frame-options"], "DENY");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.match(response.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(
    response.headers["strict-transport-security"],
    "max-age=31536000; includeSubDomains"
  );
});

test("basic rate limiting applies to sensitive endpoints when enabled", async () => {
  const app = await createApp({
    securityMode: "secure",
    sessionSecret: "test-secure-session-secret",
    auth: {
      allowSeedTokens: true
    },
    rateLimiting: {
      enabled: true,
      windowMs: 60_000,
      authMax: 2,
      publicMax: 2,
      sensitiveMax: 2,
      adminMax: 2
    }
  });

  const first = await app.inject({
    method: "GET",
    path: "/auth/me",
    headers: bearer("organizer-token")
  });
  const second = await app.inject({
    method: "GET",
    path: "/auth/me",
    headers: bearer("organizer-token")
  });
  const third = await app.inject({
    method: "GET",
    path: "/auth/me",
    headers: bearer("organizer-token")
  });

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);
  assert.match(third.body.error, /Rate limit exceeded/);
});

test("secure mode exposes browser auth config and exchanges OIDC authorization codes", async () => {
  const oidc = createMockOidcIssuer();
  const app = await createApp({
    securityMode: "secure",
    sessionSecret: "test-secure-session-secret",
    oidc: {
      enabled: true,
      issuer: oidc.issuer,
      audience: oidc.audience,
      clientId: "browser-web"
    }
  });

  try {
    const configResponse = await app.inject({
      method: "GET",
      path: "/auth/browser-config"
    });
    assert.equal(configResponse.statusCode, 200);
    assert.equal(configResponse.body.security_mode, "secure");
    assert.equal(configResponse.body.browser_auth.mode, "oidc_pkce");
    assert.equal(configResponse.body.browser_auth.oidc.client_id, "browser-web");
    assert.equal(
      configResponse.body.browser_auth.oidc.authorization_endpoint,
      "https://issuer.example.com/authorize"
    );

    const exchangeResponse = await app.inject({
      method: "POST",
      path: "/auth/oidc/exchange",
      body: {
        code: "browser-auth-code",
        code_verifier: "pkce-verifier",
        redirect_uri: "http://127.0.0.1:3000/admin.html"
      }
    });
    assert.equal(exchangeResponse.statusCode, 200);
    assert.equal(exchangeResponse.body.access_token, "mock-browser-access-token");
    assert.equal(exchangeResponse.body.token_type, "Bearer");
  } finally {
    oidc.restore();
    await app.close();
  }
});

test("oidc bearer tokens map to scoped platform users", async () => {
  const state = createSeedState();
  const organizer = state.users.find((entry) => entry.id === "user-organizer");
  organizer.external_identity_provider = "https://issuer.example.com";
  organizer.external_subject = "oidc-organizer-123";

  const oidc = createMockOidcIssuer();
  const app = await createApp({
    state,
    oidc: {
      enabled: true,
      issuer: oidc.issuer,
      audience: oidc.audience
    }
  });

  try {
    const response = await app.inject({
      method: "GET",
      path: "/auth/me",
      headers: bearer(
        oidc.createToken({
          subject: "oidc-organizer-123",
          email: organizer.email
        })
      )
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.principal.auth_source, "oidc");
    assert.deepEqual(response.body.principal.event_ids, ["event-demo"]);
    assert.equal(response.body.principal.user_status, "active");
    assert.ok(response.body.principal.last_login_at);
  } finally {
    oidc.restore();
    await app.close();
  }
});

test("secure OIDC users cannot cross into platform-admin access-control permissions", async () => {
  const state = createSeedState();
  const platformAdmin = state.users.find((entry) => entry.id === "user-platform-1");
  const sponsor = state.users.find((entry) => entry.id === "user-sponsor");
  platformAdmin.external_identity_provider = "https://issuer.example.com";
  platformAdmin.external_subject = "oidc-platform-admin";
  sponsor.external_identity_provider = "https://issuer.example.com";
  sponsor.external_subject = "oidc-sponsor-user";

  const oidc = createMockOidcIssuer();
  const app = await createApp({
    state,
    securityMode: "secure",
    sessionSecret: "test-secure-session-secret",
    oidc: {
      enabled: true,
      issuer: oidc.issuer,
      audience: oidc.audience,
      clientId: "browser-web"
    }
  });

  try {
    const sponsorDenied = await app.inject({
      method: "GET",
      path: "/admin/access-control-matrix",
      headers: bearer(
        oidc.createToken({
          subject: "oidc-sponsor-user",
          email: sponsor.email
        })
      )
    });
    assert.equal(sponsorDenied.statusCode, 403);
    assert.match(sponsorDenied.body.error, /not granted|Role not permitted/i);

    const platformAllowed = await app.inject({
      method: "GET",
      path: "/admin/access-control-matrix",
      headers: bearer(
        oidc.createToken({
          subject: "oidc-platform-admin",
          email: platformAdmin.email
        })
      )
    });
    assert.equal(platformAllowed.statusCode, 200);
    assert.ok(platformAllowed.body.items.some((entry) => entry.route_id === "exports-download"));
    assert.ok(platformAllowed.body.items.some((entry) => entry.permission === "admin.users.delete"));
  } finally {
    oidc.restore();
    await app.close();
  }
});

test("secure OIDC platform admins can review security alerts and pen-test readiness", async () => {
  const state = createSeedState();
  const platformAdmin = state.users.find((entry) => entry.id === "user-platform-1");
  const sponsor = state.users.find((entry) => entry.id === "user-sponsor");
  platformAdmin.external_identity_provider = "https://issuer.example.com";
  platformAdmin.external_subject = "oidc-security-admin";
  sponsor.external_identity_provider = "https://issuer.example.com";
  sponsor.external_subject = "oidc-security-sponsor";

  const oidc = createMockOidcIssuer();
  const app = await createApp({
    state,
    securityMode: "secure",
    sessionSecret: "test-secure-session-secret",
    oidc: {
      enabled: true,
      issuer: oidc.issuer,
      audience: oidc.audience,
      clientId: "browser-web"
    }
  });

  const sponsorToken = oidc.createToken({
    subject: "oidc-security-sponsor",
    email: sponsor.email
  });
  const platformToken = oidc.createToken({
    subject: "oidc-security-admin",
    email: platformAdmin.email
  });

  try {
    const denied = await app.inject({
      method: "GET",
      path: "/admin/security/readiness",
      headers: bearer(sponsorToken)
    });
    assert.equal(denied.statusCode, 403);

    const readiness = await app.inject({
      method: "GET",
      path: "/admin/security/readiness",
      headers: bearer(platformToken)
    });
    assert.equal(readiness.statusCode, 200);
    assert.equal(readiness.body.controls.find((entry) => entry.id === "browser_oidc").status, "pass");
    assert.equal(readiness.body.controls.find((entry) => entry.id === "seed_tokens_disabled").status, "pass");
    assert.equal(readiness.body.controls.find((entry) => entry.id === "wallet_provider_mode").status, "pass");

    const alerts = await app.inject({
      method: "GET",
      path: "/admin/security/alerts",
      headers: bearer(platformToken)
    });
    assert.equal(alerts.statusCode, 200);
    assert.ok(alerts.body.items.some((entry) => entry.title === "Denied sensitive action"));
    assert.ok(alerts.body.items.some((entry) => entry.evidence?.permission === "admin.security_readiness.view"));

    const pack = await app.inject({
      method: "GET",
      path: "/admin/security/pentest-pack",
      headers: bearer(platformToken)
    });
    assert.equal(pack.statusCode, 200);
    assert.equal(pack.body.purpose, "Sprint 9 external penetration testing support and remediation evidence pack");
    assert.ok(pack.body.access_control.route_permission_count > 0);
    assert.ok(pack.body.attack_surface.sensitive_route_count > 0);
    assert.ok(pack.body.handoff_checklist.some((entry) => entry.includes("external penetration testing")));
  } finally {
    oidc.restore();
    await app.close();
  }
});

test("security readiness flags unsafe wallet provider production configuration", async () => {
  const app = await createApp({
    env: {
      WALLET_PASS_ENABLED: "true",
      WALLET_PASS_PROVIDER_MODE: "production"
    }
  });

  const readiness = await app.inject({
    method: "GET",
    path: "/admin/security/readiness",
    headers: bearer("platform-token")
  });
  assert.equal(readiness.statusCode, 200);
  assert.equal(readiness.body.controls.find((entry) => entry.id === "wallet_provider_mode").status, "pass");
  assert.equal(readiness.body.controls.find((entry) => entry.id === "wallet_provider_key_refs").status, "fail");
});

test("security readiness and alerts flag notification scheduler/provider misconfiguration", async () => {
  const app = await createApp({
    env: {
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "production"
    }
  });

  const readiness = await app.inject({
    method: "GET",
    path: "/admin/security/readiness",
    headers: bearer("platform-token")
  });
  assert.equal(readiness.statusCode, 200);
  assert.equal(readiness.body.controls.find((entry) => entry.id === "notification_provider_mode").status, "pass");
  assert.equal(readiness.body.controls.find((entry) => entry.id === "notification_provider_config").status, "fail");
  assert.equal(readiness.body.controls.find((entry) => entry.id === "notification_webhook_auth").status, "fail");
  assert.equal(readiness.body.controls.find((entry) => entry.id === "notification_worker_schedule").status, "fail");

  const alerts = await app.inject({
    method: "GET",
    path: "/admin/security/alerts",
    headers: bearer("platform-token")
  });
  assert.equal(alerts.statusCode, 200);
  assert.ok(alerts.body.items.some((entry) => entry.rule_id === "notifications.scheduler_misconfigured"));
});

test("security alerts flag notification dead-letter backlog and bounded retry governance", async () => {
  const app = await createApp({
    env: {
      ...process.env,
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "mock_temporary_failure",
      NOTIFICATION_MAX_ATTEMPTS: "1",
      NOTIFICATION_DEAD_LETTER_ALERT_THRESHOLD: "1"
    }
  });

  await createQueuedEmailFollowup(app, {
    localEventId: "dead-letter-security-alert-1",
    email: "dead-letter-security@example.com"
  });

  await app.inject({
    method: "POST",
    path: "/organizer/events/event-demo/outbound-queue/process",
    headers: bearer("organizer-token"),
    body: { limit: 5 }
  });

  const readiness = await app.inject({
    method: "GET",
    path: "/admin/security/readiness",
    headers: bearer("platform-token")
  });
  assert.equal(readiness.statusCode, 200);
  assert.equal(readiness.body.controls.find((entry) => entry.id === "notification_retry_governance").status, "pass");

  const alerts = await app.inject({
    method: "GET",
    path: "/admin/security/alerts",
    headers: bearer("platform-token")
  });
  assert.equal(alerts.statusCode, 200);
  assert.ok(alerts.body.items.some((entry) => entry.rule_id === "notifications.dead_letter_backlog"));
});

test("platform admins can track external pen-test findings through remediation", async () => {
  const app = await createApp();

  const created = await app.inject({
    method: "POST",
    path: "/admin/security/pentest/findings",
    headers: bearer("platform-token"),
    body: {
      title: "Missing edge WAF rule for scanner burst",
      severity: "high",
      category: "abuse_control",
      affected_area: "API edge",
      description: "External tester observed burst traffic was only limited inside the app.",
      evidence: {
        tool: "external_dast",
        request_count: 250
      },
      remediation_plan: "Tune WAF plus app buckets before production launch"
    }
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.item.status, "open");

  const alerts = await app.inject({
    method: "GET",
    path: "/admin/security/alerts",
    headers: bearer("platform-token")
  });
  assert.equal(alerts.statusCode, 200);
  assert.ok(alerts.body.items.some((entry) => entry.rule_id === "pentest.open_high_or_critical"));

  const attackSurface = await app.inject({
    method: "GET",
    path: "/admin/security/pentest/attack-surface",
    headers: bearer("platform-token")
  });
  assert.equal(attackSurface.statusCode, 200);
  assert.ok(attackSurface.body.public_route_count > 0);
  assert.ok(attackSurface.body.sensitive_routes.some((entry) => entry.route_id === "admin-pentest-finding-create"));

  const updated = await app.inject({
    method: "PATCH",
    path: `/admin/security/pentest/findings/${created.body.item.id}`,
    headers: bearer("platform-token"),
    body: {
      status: "remediated",
      remediation_plan: "WAF rule added and app rate-limit evidence attached",
      evidence: {
        retest: "passed"
      }
    }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.item.status, "remediated");
  assert.ok(updated.body.item.resolved_at);

  const findings = await app.inject({
    method: "GET",
    path: "/admin/security/pentest/findings",
    headers: bearer("platform-token")
  });
  assert.equal(findings.statusCode, 200);
  assert.equal(findings.body.summary.total, 1);
  assert.equal(findings.body.summary.blocking, 0);
});

test("deployment readiness exposes public probe and platform-admin configuration detail", async () => {
  const localApp = await createApp();
  const localReady = await localApp.inject({
    method: "GET",
    path: "/ready"
  });
  assert.equal(localReady.statusCode, 200);
  assert.equal(localReady.body.ready, true);

  const productionLikeApp = await createApp({
    env: {
      DEPLOYMENT_ENV: "production",
      NODE_ENV: "production",
      APP_SECURITY_MODE: "secure",
      REPOSITORY_BACKEND: "memory",
      DATABASE_URL: "",
      DATABASE_SSL: "false",
      DATABASE_SSL_REJECT_UNAUTHORIZED: "false",
      AUTH_ALLOW_SEED_TOKENS: "true",
      OIDC_ENABLED: "false",
      SECURITY_HEADERS_ENABLED: "false",
      RATE_LIMITING_ENABLED: "false",
      CORS_ALLOW_ORIGINS: "*",
      SESSION_SECRET: "short",
      NOTIFICATION_EMAIL_ENABLED: "true",
      NOTIFICATION_EMAIL_PROVIDER_MODE: "production"
    }
  });

  const blockedProbe = await productionLikeApp.inject({
    method: "GET",
    path: "/ready"
  });
  assert.equal(blockedProbe.statusCode, 503);
  assert.ok(blockedProbe.body.details.summary.fail > 0);

  const detail = await productionLikeApp.inject({
    method: "GET",
    path: "/admin/deployment/readiness",
    headers: bearer("platform-token")
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.ready, false);
  assert.ok(detail.body.controls.some((entry) => entry.id === "cors_allowlist" && entry.status === "fail"));
  assert.ok(detail.body.controls.some((entry) => entry.id === "session_secret" && entry.status === "fail"));
  assert.ok(detail.body.controls.some((entry) => entry.id === "notification_provider_url_email" && entry.status === "fail"));
  assert.ok(detail.body.controls.some((entry) => entry.id === "notification_webhook_auth_email" && entry.status === "manual"));
  assert.ok(detail.body.controls.some((entry) => entry.id === "notification_worker_enabled" && entry.status === "manual"));
});

test("OIDC lifecycle statuses deny non-active users and audit the reason", async () => {
  for (const [status, expectedMessage] of [
    ["pending_invite", /pending activation/],
    ["disabled", /disabled/],
    ["suspended", /suspended/],
    ["deleted", /deleted/]
  ]) {
    const state = createSeedState();
    const organizer = state.users.find((entry) => entry.id === "user-organizer");
    organizer.external_identity_provider = "https://issuer.example.com";
    organizer.external_subject = `oidc-${status}-user`;
    organizer.status = status;
    organizer.invited_at = status === "pending_invite" ? new Date().toISOString() : organizer.invited_at;
    organizer.disabled_at = ["disabled", "suspended"].includes(status) ? new Date().toISOString() : organizer.disabled_at;
    organizer.deleted_at = status === "deleted" ? new Date().toISOString() : organizer.deleted_at;

    const oidc = createMockOidcIssuer();
    const app = await createApp({
      state,
      oidc: {
        enabled: true,
        issuer: oidc.issuer,
        audience: oidc.audience
      }
    });

    try {
      const response = await app.inject({
        method: "GET",
        path: "/auth/me",
        headers: bearer(
          oidc.createToken({
            subject: `oidc-${status}-user`,
            email: organizer.email
          })
        )
      });

      assert.equal(response.statusCode, 403);
      assert.match(response.body.error, expectedMessage);

      const auditEntry = app.state.auditLogs.find((entry) => entry.event_type === "auth.me.view.denied");
      assert.ok(auditEntry);
      assert.equal(auditEntry.actor_id, organizer.id);
      assert.equal(auditEntry.metadata.user_status, status);
      assert.equal(auditEntry.metadata.auth_reason, `user_status_${status}`);
    } finally {
      oidc.restore();
      await app.close();
    }
  }
});

test("seed user authentication records last login and enforces lifecycle status", async () => {
  const state = createSeedState();
  const app = await createApp({ state });

  const activeResponse = await app.inject({
    method: "GET",
    path: "/auth/me",
    headers: bearer("organizer-token")
  });

  assert.equal(activeResponse.statusCode, 200);
  assert.equal(activeResponse.body.principal.user_status, "active");

  const organizer = await app.repos.users.findById("tenant-demo", "user-organizer");
  assert.ok(organizer.last_login_at);

  await app.repos.users.update({
    ...organizer,
    status: "disabled",
    disabled_at: new Date().toISOString(),
    disabled_reason: "Suspicious activity"
  });

  const deniedResponse = await app.inject({
    method: "GET",
    path: "/auth/me",
    headers: bearer("organizer-token")
  });

  assert.equal(deniedResponse.statusCode, 403);
  assert.match(deniedResponse.body.error, /disabled/);

  const deniedAudit = app.state.auditLogs.filter((entry) => entry.event_type === "auth.me.view.denied").at(-1);
  assert.ok(deniedAudit);
  assert.equal(deniedAudit.actor_id, "user-organizer");
  assert.equal(deniedAudit.metadata.user_status, "disabled");
});

test("platform admin can manage users, lifecycle state, and access scopes", async () => {
  const app = await createApp();

  const reference = await app.inject({
    method: "GET",
    path: "/admin/reference-data",
    headers: bearer("platform-token")
  });

  assert.equal(reference.statusCode, 200);
  assert.ok(reference.body.organizations.some((entry) => entry.id === "org-vendor"));
  assert.ok(reference.body.events.some((entry) => entry.id === "event-demo"));
  assert.ok(reference.body.stalls.some((entry) => entry.id === "stall-a1"));

  const created = await app.inject({
    method: "POST",
    path: "/admin/users",
    headers: bearer("platform-token"),
    body: {
      email: "new-vendor@example.com",
      display_name: "Nia Vendor",
      role: "vendor_manager",
      organization_id: "org-vendor"
    }
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.body.status, "pending_invite");
  assert.ok(created.body.invited_at);

  const listed = await app.inject({
    method: "GET",
    path: "/admin/users",
    headers: bearer("platform-token")
  });

  assert.equal(listed.statusCode, 200);
  const createdSummary = listed.body.items.find((entry) => entry.id === created.body.id);
  assert.ok(createdSummary);
  assert.equal(createdSummary.access_scope_count, 0);

  const updated = await app.inject({
    method: "PATCH",
    path: `/admin/users/${created.body.id}`,
    headers: bearer("platform-token"),
    body: {
      display_name: "Nia Vendor Updated",
      mfa_required: true,
      external_identity_provider: "https://issuer.example.com",
      external_subject: "vendor-new-oidc"
    }
  });

  assert.equal(updated.statusCode, 200);
  assert.equal(updated.body.display_name, "Nia Vendor Updated");
  assert.equal(updated.body.mfa_required, true);

  const scope = await app.inject({
    method: "POST",
    path: `/admin/users/${created.body.id}/access-scopes`,
    headers: bearer("platform-token"),
    body: {
      event_id: "event-demo",
      stall_id: "stall-a1"
    }
  });

  assert.equal(scope.statusCode, 201);
  assert.equal(scope.body.user_id, created.body.id);

  const detail = await app.inject({
    method: "GET",
    path: `/admin/users/${created.body.id}`,
    headers: bearer("platform-token")
  });

  assert.equal(detail.statusCode, 200);
  assert.equal(detail.body.item.access_scope_count, 1);
  assert.equal(detail.body.item.access_scopes[0].stall_id, "stall-a1");

  const activated = await app.inject({
    method: "POST",
    path: `/admin/users/${created.body.id}/activate`,
    headers: bearer("platform-token"),
    body: {}
  });

  assert.equal(activated.statusCode, 200);
  assert.equal(activated.body.status, "active");

  const disabled = await app.inject({
    method: "POST",
    path: `/admin/users/${created.body.id}/disable`,
    headers: bearer("platform-token"),
    body: { reason: "Access hold" }
  });

  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.body.status, "disabled");
  assert.equal(disabled.body.disabled_reason, "Access hold");

  const suspended = await app.inject({
    method: "POST",
    path: `/admin/users/${created.body.id}/suspend`,
    headers: bearer("platform-token"),
    body: { reason: "Policy review" }
  });

  assert.equal(suspended.statusCode, 200);
  assert.equal(suspended.body.status, "suspended");
  assert.equal(suspended.body.disabled_reason, "Policy review");

  const reactivated = await app.inject({
    method: "POST",
    path: `/admin/users/${created.body.id}/activate`,
    headers: bearer("platform-token"),
    body: {}
  });

  assert.equal(reactivated.statusCode, 200);
  assert.equal(reactivated.body.status, "active");

  const revoked = await app.inject({
    method: "DELETE",
    path: `/admin/users/${created.body.id}/access-scopes/${scope.body.id}`,
    headers: bearer("platform-token")
  });

  assert.equal(revoked.statusCode, 200);
  assert.equal(revoked.body.id, scope.body.id);

  const deleted = await app.inject({
    method: "POST",
    path: `/admin/users/${created.body.id}/delete`,
    headers: bearer("platform-token"),
    body: { reason: "Offboarding complete" }
  });

  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.body.status, "deleted");
  assert.ok(deleted.body.deleted_at);

  const deletedDetail = await app.inject({
    method: "GET",
    path: `/admin/users/${created.body.id}`,
    headers: bearer("platform-token")
  });

  assert.equal(deletedDetail.statusCode, 200);
  assert.equal(deletedDetail.body.item.access_scope_count, 0);

  const adminAudits = app.state.auditLogs.filter((entry) => entry.event_type.startsWith("admin."));
  assert.ok(adminAudits.some((entry) => entry.event_type === "admin.user.created"));
  assert.ok(adminAudits.some((entry) => entry.event_type === "admin.user_scope.assigned"));
  assert.ok(adminAudits.some((entry) => entry.event_type === "admin.user.deleted"));
});

test("platform admin IAM endpoints reject non-admin callers and invalid scope assignments", async () => {
  const app = await createApp();

  const denied = await app.inject({
    method: "GET",
    path: "/admin/users",
    headers: bearer("organizer-token")
  });

  assert.equal(denied.statusCode, 403);

  const created = await app.inject({
    method: "POST",
    path: "/admin/users",
    headers: bearer("platform-token"),
    body: {
      email: "bad-scope-vendor@example.com",
      display_name: "Bad Scope Vendor",
      role: "vendor_manager",
      organization_id: "org-vendor"
    }
  });

  assert.equal(created.statusCode, 201);

  const invalidScope = await app.inject({
    method: "POST",
    path: `/admin/users/${created.body.id}/access-scopes`,
    headers: bearer("platform-token"),
    body: {
      event_id: "event-demo"
    }
  });

  assert.equal(invalidScope.statusCode, 409);
  assert.match(invalidScope.body.error, /Vendor managers require event_id and stall_id access/);

  const duplicateEmail = await app.inject({
    method: "POST",
    path: "/admin/users",
    headers: bearer("platform-token"),
    body: {
      email: "vendor@example.com",
      display_name: "Duplicate Vendor",
      role: "vendor_manager",
      organization_id: "org-vendor"
    }
  });

  assert.equal(duplicateEmail.statusCode, 409);
  assert.match(duplicateEmail.body.error, /already exists/);
});

test("platform admin commercial governance covers mandatory Deferred/Gap Step 1 controls", async () => {
  const app = await createApp();

  const denied = await app.inject({
    method: "GET",
    path: "/admin/commercial/governance",
    headers: bearer("organizer-token")
  });

  assert.equal(denied.statusCode, 403);

  const governance = await app.inject({
    method: "GET",
    path: "/admin/commercial/governance",
    headers: bearer("platform-token")
  });

  assert.equal(governance.statusCode, 200);
  assert.deepEqual(governance.body.partner_types, ["referrer", "channel_partner", "delivery_ecosystem_partner"]);
  assert.deepEqual(governance.body.pipeline_stages, [
    "lead_added",
    "contacted",
    "replied",
    "call_scheduled",
    "demo_done",
    "proposal_sent",
    "negotiation",
    "closed_won",
    "closed_lost"
  ]);
  assert.match(governance.body.positioning_rule, /exhibitor ROI \+ sponsor revenue \+ measurable engagement/);
  assert.ok(governance.body.daily_targets.some((entry) => entry.metric === "demos" && entry.minimum === 1));
  assert.ok(governance.body.demo_sop.some((entry) => entry.includes("Trust objection handling")));

  const rejectedPartnerAccess = await app.inject({
    method: "POST",
    path: "/admin/commercial/partners",
    headers: bearer("platform-token"),
    body: {
      name: "Unprovisioned Partner",
      partner_type: "referrer",
      platform_user_id: "user-vendor"
    }
  });

  assert.equal(rejectedPartnerAccess.statusCode, 400);
  assert.match(rejectedPartnerAccess.body.error, /platform_user_id requires access_level/);

  const partner = await app.inject({
    method: "POST",
    path: "/admin/commercial/partners",
    headers: bearer("platform-token"),
    body: {
      name: "North Channel",
      partner_type: "channel_partner",
      notes: "Commercial status-only partner for production Step 1"
    }
  });

  assert.equal(partner.statusCode, 201);
  assert.equal(partner.body.partner_type, "channel_partner");
  assert.equal(partner.body.access_level, "commercial_status_only");
  assert.equal(partner.body.platform_user_id, null);

  const rejectedStage = await app.inject({
    method: "POST",
    path: "/admin/commercial/deals",
    headers: bearer("platform-token"),
    body: {
      partner_id: partner.body.id,
      account_name: "Metro Expo",
      stage: "verbal_yes",
      next_action: "Schedule discovery call",
      next_action_at: "2026-04-22T10:00:00Z",
      offer_structure: "mixed",
      commercial_positioning_ack: true
    }
  });

  assert.equal(rejectedStage.statusCode, 400);
  assert.match(rejectedStage.body.error, /stage is invalid/);

  const rejectedMissingNextActionDate = await app.inject({
    method: "POST",
    path: "/admin/commercial/deals",
    headers: bearer("platform-token"),
    body: {
      partner_id: partner.body.id,
      account_name: "Metro Expo",
      stage: "lead_added",
      next_action: "Schedule discovery call",
      offer_structure: "mixed",
      commercial_positioning_ack: true
    }
  });

  assert.equal(rejectedMissingNextActionDate.statusCode, 400);
  assert.match(rejectedMissingNextActionDate.body.error, /Missing field: next_action_at/);

  const rejectedBlankNextAction = await app.inject({
    method: "POST",
    path: "/admin/commercial/deals",
    headers: bearer("platform-token"),
    body: {
      partner_id: partner.body.id,
      account_name: "Metro Expo",
      stage: "lead_added",
      next_action: " ",
      next_action_at: "2026-04-22T10:00:00Z",
      offer_structure: "mixed",
      commercial_positioning_ack: true
    }
  });

  assert.equal(rejectedBlankNextAction.statusCode, 400);
  assert.match(rejectedBlankNextAction.body.error, /next_action must be non-empty/);

  const rejectedDeal = await app.inject({
    method: "POST",
    path: "/admin/commercial/deals",
    headers: bearer("platform-token"),
    body: {
      partner_id: partner.body.id,
      account_name: "Metro Expo",
      stage: "lead_added",
      next_action: "Schedule discovery call",
      next_action_at: "2026-04-22T10:00:00Z",
      offer_structure: "mixed",
      commercial_positioning_ack: false
    }
  });

  assert.equal(rejectedDeal.statusCode, 400);
  assert.match(rejectedDeal.body.error, /commercial_positioning_ack must be true/);

  const deal = await app.inject({
    method: "POST",
    path: "/admin/commercial/deals",
    headers: bearer("platform-token"),
    body: {
      partner_id: partner.body.id,
      account_name: "Metro Expo",
      stage: "lead_added",
      next_action: "Schedule discovery call",
      next_action_at: "2026-04-22T10:00:00Z",
      offer_structure: "mixed",
      commercial_positioning_ack: true,
      notes: "ROI-led sponsor and exhibitor value story confirmed"
    }
  });

  assert.equal(deal.statusCode, 201);
  assert.equal(deal.body.stage, "lead_added");
  assert.equal(deal.body.next_action, "Schedule discovery call");
  assert.equal(deal.body.offer_structure, "mixed");

  const rejectedApproval = await app.inject({
    method: "POST",
    path: "/admin/commercial/approvals",
    headers: bearer("platform-token"),
    body: {
      approval_type: "pricing_exception",
      subject_id: deal.body.id,
      approver_role: "account_owner",
      approval_status: "approved",
      reason: "Discount requested"
    }
  });

  assert.equal(rejectedApproval.statusCode, 409);
  assert.match(rejectedApproval.body.error, /founder or product owner approval/);

  const approval = await app.inject({
    method: "POST",
    path: "/admin/commercial/approvals",
    headers: bearer("platform-token"),
    body: {
      approval_type: "pricing_exception",
      subject_id: deal.body.id,
      approver_role: "founder",
      approval_status: "approved",
      reason: "Founder approved launch exception"
    }
  });

  assert.equal(approval.statusCode, 201);
  assert.equal(approval.body.approver_role, "founder");

  const rejectedPaidPayout = await app.inject({
    method: "POST",
    path: "/admin/commercial/payouts",
    headers: bearer("platform-token"),
    body: {
      partner_id: partner.body.id,
      deal_id: deal.body.id,
      amount_cents: 25000,
      status: "paid"
    }
  });

  assert.equal(rejectedPaidPayout.statusCode, 400);
  assert.match(rejectedPaidPayout.body.error, /client_payment_received_at/);

  const payout = await app.inject({
    method: "POST",
    path: "/admin/commercial/payouts",
    headers: bearer("platform-token"),
    body: {
      partner_id: partner.body.id,
      deal_id: deal.body.id,
      amount_cents: 25000,
      currency: "USD",
      status: "pending"
    }
  });

  assert.equal(payout.statusCode, 201);
  assert.equal(payout.body.status, "pending");

  const paidPayout = await app.inject({
    method: "PATCH",
    path: `/admin/commercial/payouts/${payout.body.id}`,
    headers: bearer("platform-token"),
    body: {
      status: "paid",
      client_payment_received_at: "2026-04-23T12:00:00Z"
    }
  });

  assert.equal(paidPayout.statusCode, 200);
  assert.equal(paidPayout.body.status, "paid");
  assert.ok(paidPayout.body.approved_at);
  assert.ok(paidPayout.body.paid_at);

  const statusUpdate = await app.inject({
    method: "POST",
    path: `/admin/commercial/partners/${partner.body.id}/status-updates`,
    headers: bearer("platform-token"),
    body: {
      deal_id: deal.body.id,
      update_type: "deal_status",
      summary: "Demo scheduled; partner receives commercial status only."
    }
  });

  assert.equal(statusUpdate.statusCode, 201);
  assert.equal(statusUpdate.body.partner_id, partner.body.id);
  assert.equal(statusUpdate.body.deal_id, deal.body.id);

  const updatedGovernance = await app.inject({
    method: "GET",
    path: "/admin/commercial/governance",
    headers: bearer("platform-token")
  });

  assert.equal(updatedGovernance.statusCode, 200);
  assert.equal(updatedGovernance.body.summary.partners, 1);
  assert.equal(updatedGovernance.body.summary.deals, 1);
  assert.equal(updatedGovernance.body.summary.payouts, 1);
  assert.equal(updatedGovernance.body.summary.payouts_paid, 1);
  assert.equal(updatedGovernance.body.summary.approvals, 1);

  const audits = app.state.auditLogs.filter((entry) => entry.event_type.startsWith("admin.commercial_"));
  assert.ok(audits.some((entry) => entry.event_type === "admin.commercial_partner.created"));
  assert.ok(audits.some((entry) => entry.event_type === "admin.commercial_payout.updated"));
});
