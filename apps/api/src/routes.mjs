import { createHash } from "node:crypto";
import { nextId } from "./store.mjs";
import { hashPassword, verifyPassword, validatePasswordComplexity } from "./auth/passwords.mjs";
import { issuePlatformToken } from "./auth/platform-jwt.mjs";
import { hashToken, generateInviteToken, generateResetToken } from "./auth/invite-tokens.mjs";
import { resolveRedirectTarget } from "./auth/redirect-resolver.mjs";
import { HttpError } from "./http-error.mjs";
import { deriveCrmEligibility } from "./policy.mjs";
import { createAttendeeSessionToken, verifyAttendeeSessionToken } from "./session-tokens.mjs";
import { createDeviceCredentialToken, hashDeviceCredentialToken } from "./device-credentials.mjs";
import { createShortLinkToken, hashShortLinkToken, shortLinkPath } from "./short-links.mjs";
import { listAccessControlMatrix } from "./access-control.mjs";
import {
  buildAttackSurfaceReport,
  buildPentestEvidencePack,
  buildSecurityAlerts,
  buildSecurityReadiness,
  summarizePentestFindings
} from "./security-hardening.mjs";
import { buildDeploymentReadiness } from "./deployment-readiness.mjs";
import { ingestTapEvent } from "./interactions/ingest-tap.mjs";
import {
  buildComplianceOverview,
  buildComplianceOperationalReport,
  buildDataSubjectRequestDetail,
  completeDataSubjectRequest,
  confirmDownstreamDeletionRecord,
  createDataSubjectRequest,
  dispatchDownstreamDeletion,
  listDataSubjectRequestsForEvent,
  runRetentionLifecycle
} from "./compliance/post-event-lifecycle.mjs";
import { PILOT_CRM_PROVIDER, syncInteractionToPilotCrm } from "./crm/pilot-crm.mjs";
import {
  buildNotificationAttemptHistory,
  buildNotificationDeliveryAnalytics,
  buildNotificationQueueInventory,
  buildNotificationQueueMetrics,
  completeNotificationSendFailure,
  completeNotificationSendSuccess,
  completeNotificationSendTemporaryFailure,
  deriveNotificationQueueState,
  processNotificationQueueBatch,
  resolveNotificationRetryPolicy
} from "./notification-worker.mjs";
import {
  assertNotificationWebhookAuthorized,
  buildNotificationEngagementAnalytics,
  buildNotificationReceiptGovernance,
  buildNotificationReceiptHistory,
  ingestNotificationReceipt
} from "./notification-receipts.mjs";
import {
  buildNotificationChannelsReadiness,
  resolveNotificationWorkerSchedule
} from "./notification-providers.mjs";
import { dispatchTransactionalEmail } from "./notification-dispatch.mjs";
import { writeAuditEvent, AUDIT_EVENT_TYPES } from "./audit.mjs";
import { runRetentionPurgeOnce } from "./jobs/retention-purge.mjs";
import { processFullExportJob } from "./jobs/full-export-worker.mjs";
import { processDSRJob } from "./jobs/dsr-worker.mjs";
import { processTenantOffboarding } from "./jobs/offboarding-worker.mjs";
import { validateDownloadToken, readLocalFile } from "./storage/storage-adapter.mjs";

export function registerRoutes(router) {
  router.addRoute({
    id: "storage-local-download",
    method: "GET",
    path: "/api/exports/download",
    authRequired: false,
    handler: async ({ query }) => {
      const { key, expires, sig } = query;
      if (!key || !expires || !sig) {
        throw new HttpError(400, "MISSING_DOWNLOAD_PARAMS");
      }
      if (!validateDownloadToken(key, expires, sig)) {
        throw new HttpError(403, "DOWNLOAD_LINK_EXPIRED_OR_INVALID");
      }
      let data;
      try {
        data = readLocalFile(key).toString("utf8");
      } catch {
        throw new HttpError(404, "EXPORT_FILE_NOT_FOUND");
      }
      return { key, content_type: "application/json", data };
    }
  });

  router.addRoute({
    id: "health",
    method: "GET",
    path: "/health",
    authRequired: false,
    handler: async ({ state, repos }) => ({
      status: "ok",
      version: "0.1.0",
      backend: repos.backend,
      events: state.events.length,
      routes: Object.keys(state.metrics.routeHits).length
    })
  });

  router.addRoute({
    id: "readiness",
    method: "GET",
    path: "/ready",
    authRequired: false,
    handler: async (ctx) => {
      const readiness = await buildDeploymentReadiness(ctx, { includeDetails: false });
      if (!readiness.ready) {
        throw new HttpError(503, "Deployment readiness checks failed", {
          summary: readiness.summary
        });
      }
      return readiness;
    }
  });

  router.addRoute({
    id: "auth-browser-config",
    method: "GET",
    path: "/auth/browser-config",
    authRequired: false,
    handler: async ({ securityMode, allowSeedTokens, oidc }) => {
      const browserOidcEnabled = securityMode === "secure" && Boolean(oidc?.enabled);
      const browserConfig = browserOidcEnabled
        ? await oidc.getBrowserConfiguration()
        : null;

      return {
        security_mode: securityMode,
        allow_seed_tokens: allowSeedTokens,
        browser_auth: {
          mode: browserOidcEnabled ? "oidc_pkce" : "seed_bearer",
          requires_login: securityMode === "secure",
          oidc: browserConfig
        }
      };
    }
  });

  router.addRoute({
    id: "notification-provider-webhook",
    method: "POST",
    path: "/webhooks/notifications/:channel",
    authRequired: false,
    validate: (body) => body ?? {},
    handler: async ({ repos, params, headers, body, env }) => {
      const tenantId = headers["x-tenant-id"] ?? body.tenant_id ?? null;
      if (!tenantId) {
        throw new HttpError(400, "Notification webhook tenant_id is required");
      }
      assertNotificationWebhookAuthorized(params.channel, headers, body, env);
      return repos.withTransaction((txRepos) =>
        ingestNotificationReceipt({
          repos: txRepos,
          tenantId,
          channel: params.channel,
          payload: body,
          initiatedBy: `notification-webhook:${params.channel}`
        })
      );
    },
    statusCode: 202
  });

  router.addRoute({
    id: "event-public-leaderboard",
    method: "GET",
    path: "/events/:eventId/leaderboard",
    authRequired: false,
    resolveResources: async ({ state, repos, params, headers }) => {
      const tenantId = headers["x-tenant-id"] ?? state.events.find((entry) => entry.id === params.eventId)?.tenant_id;
      if (!tenantId) {
        throw new HttpError(400, "Unable to resolve tenant for public leaderboard");
      }
      const event = await repos.events.findById(tenantId, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(tenantId, event.id);
      return { event, eventPolicy, tenantHint: tenantId };
    },
    handler: async ({ repos, resources, query }) =>
      buildPublicLeaderboard({
        repos,
        tenantId: resources.event.tenant_id,
        event: resources.event,
        eventPolicy: resources.eventPolicy,
        query
      }),
    auditEventType: "event.public_leaderboard.view"
  });

  router.addRoute({
    id: "short-link-resolve",
    method: "GET",
    path: "/s/:token",
    authRequired: false,
    resolveResources: async ({ repos, params }) => {
      const shortLink = await repos.shortLinks.findByTokenHash(hashShortLinkToken(params.token));
      if (!shortLink) {
        throw new HttpError(404, "Short link not found");
      }
      const resources = {
        shortLink,
        tenantHint: shortLink.tenant_id
      };
      if (shortLink.target_type === "attendee_session") {
        resources.interaction = await repos.interactions.findById(shortLink.tenant_id, shortLink.target_id);
        resources.event = await repos.events.findById(shortLink.tenant_id, resources.interaction.event_id);
      }
      if (shortLink.target_type === "export_download") {
        resources.exportRequest = await repos.exportRequests.findById(shortLink.tenant_id, shortLink.target_id);
        resources.event = await repos.events.findById(shortLink.tenant_id, resources.exportRequest.event_id);
      }
      if (shortLink.target_type === "wallet_pass") {
        resources.walletPass = await repos.walletPasses.findById(shortLink.tenant_id, shortLink.target_id);
        resources.event = await repos.events.findById(shortLink.tenant_id, resources.walletPass.event_id);
      }
      return resources;
    },
    handler: async ({ repos, resources, req, res }) => {
      const result = await resolveShortLink({ repos, resources });
      if (req?.headers?.accept?.includes('text/html') && result?.target_url) {
        res.redirect(302, result.target_url);
        return null;
      }
      return result;
    },
    auditEventType: "short_link.resolved"
  });

  router.addRoute({
    id: "short-link-status",
    method: "GET",
    path: "/short-links/:shortLinkId/status",
    allowedRoles: ["organizer_admin"],
    resolveResources: resolveShortLinkOperatorResources,
    handler: async ({ resources }) => serializeShortLinkInvestigation(resources),
    auditEventType: "short_link.status.view"
  });

  router.addRoute({
    id: "short-link-revoke",
    method: "POST",
    path: "/short-links/:shortLinkId/revoke",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: resolveShortLinkOperatorResources,
    handler: async ({ repos, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const shortLink = await txRepos.shortLinks.findById(resources.shortLink.tenant_id, resources.shortLink.id);
        if (shortLink.status === "active") {
          shortLink.status = "revoked";
          await txRepos.shortLinks.update(shortLink);
        }
        return serializeShortLinkInvestigation({
          ...resources,
          shortLink
        });
      }),
    auditEventType: "short_link.revoked"
  });

  router.addRoute({
    id: "organizer-leaderboard-snapshots",
    method: "GET",
    path: "/organizer/events/:eventId/leaderboard-snapshots",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      return { event };
    },
    handler: async ({ repos, resources }) => {
      const snapshots = await repos.leaderboardSnapshots.listByEvent(resources.event.tenant_id, resources.event.id);
      return {
        event_id: resources.event.id,
        snapshot_interval_minutes: LEADERBOARD_SNAPSHOT_INTERVAL_MINUTES,
        items: snapshots.map(serializeLeaderboardSnapshot)
      };
    },
    auditEventType: "organizer.leaderboard_snapshots.view"
  });

  router.addRoute({
    id: "organizer-leaderboard-snapshot-create",
    method: "POST",
    path: "/organizer/events/:eventId/leaderboard-snapshots",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, principal, resources, body }) => {
      const existingSnapshots = await repos.leaderboardSnapshots.listByEvent(resources.event.tenant_id, resources.event.id);
      enforceLeaderboardSnapshotCadence(existingSnapshots, body.force === true);
      const leaderboard = await buildPublicLeaderboard({
        repos,
        tenantId: resources.event.tenant_id,
        event: resources.event,
        eventPolicy: resources.eventPolicy,
        query: { limit: body.limit ?? "10" }
      });
      const snapshotVersion = nextLeaderboardSnapshotVersion(existingSnapshots);
      const snapshot = await repos.leaderboardSnapshots.create({
        id: nextId("leaderboard-snapshot"),
        tenant_id: resources.event.tenant_id,
        event_id: resources.event.id,
        snapshot_version: snapshotVersion,
        calculation_version: Number(resources.event.metrics_definition_version ?? 1),
        snapshot_interval_minutes: LEADERBOARD_SNAPSHOT_INTERVAL_MINUTES,
        payload: buildLeaderboardSnapshotPayload({
          event: resources.event,
          leaderboard,
          snapshotVersion
        }),
        created_by_user_id: principal.user_id,
        created_at: new Date().toISOString()
      });
      return serializeLeaderboardSnapshot(snapshot);
    },
    statusCode: 201,
    auditEventType: "organizer.leaderboard_snapshot.created"
  });

  router.addRoute({
    id: "auth-me",
    method: "GET",
    path: "/auth/me",
    authRequired: true,
    handler: async ({ principal }) => ({
      principal: {
        type: principal.type,
        actor_id: principal.actor_id,
        tenant_id: principal.tenant_id,
        org_id: principal.org_id ?? null,
        role: principal.role,
        roles: principal.roles ?? [principal.role].filter(Boolean),
        user_id: principal.user_id ?? null,
        device_id: principal.device_id ?? null,
        organization_id: principal.organization_id ?? null,
        user_status: principal.user_status ?? null,
        last_login_at: principal.last_login_at ?? null,
        mfa_required: principal.mfa_required ?? false,
        event_ids: principal.event_ids ?? [],
        stall_ids: principal.stall_ids ?? [],
        sponsor_organization_ids: principal.sponsor_organization_ids ?? [],
        sponsor_package_ids: principal.sponsor_package_ids ?? [],
        auth_source: principal.auth_source ?? "seed"
      }
    }),
    auditEventType: "auth.me.view"
  });

  router.addRoute({
    id: "organizer-short-links-list",
    method: "GET",
    path: "/organizer/events/:eventId/short-links",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const pagination = parseArtifactInventoryPagination(query);
      const allLinks = await repos.shortLinks.listByTenant(resources.event.tenant_id);
      const items = [];
      for (const shortLink of allLinks) {
        const itemResources = await resolveShortLinkTargetResources(repos, shortLink);
        if (itemResources.event?.id === resources.event.id) {
          items.push(serializeShortLinkInvestigation(itemResources));
        }
      }
      const filtered = items.filter((item) =>
        (!query.status || item.status === query.status) &&
        (!query.target_type || item.target_type === query.target_type)
      );
      const sorted = filtered.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      const pageItems = sorted.slice(pagination.offset, pagination.offset + pagination.limit);
      return {
        event_id: resources.event.id,
        items: pageItems,
        pagination: buildPaginationEnvelope(sorted.length, pageItems.length, pagination)
      };
    },
    auditEventType: "organizer.short_links.view"
  });

  router.addRoute({
    id: "organizer-provider-readiness",
    method: "GET",
    path: "/organizer/events/:eventId/provider-readiness",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ resources, env }) => buildProviderReadiness(resources.event, env),
    auditEventType: "organizer.provider_readiness.view"
  });

  router.addRoute({
    id: "organizer-outbound-queue-metrics",
    method: "GET",
    path: "/organizer/events/:eventId/outbound-queue/metrics",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) =>
      buildNotificationQueueMetrics({
        repos,
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id
      }),
    auditEventType: "organizer.outbound_queue_metrics.view"
  });

  router.addRoute({
    id: "organizer-outbound-delivery-analytics",
    method: "GET",
    path: "/organizer/events/:eventId/outbound-delivery-analytics",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) =>
      Promise.all([
        buildNotificationDeliveryAnalytics({
          repos,
          tenantId: resources.event.tenant_id,
          eventId: resources.event.id,
          query
        }),
        buildNotificationEngagementAnalytics({
          repos,
          tenantId: resources.event.tenant_id,
          eventId: resources.event.id,
          query
        })
      ]).then(([attemptAnalytics, engagementAnalytics]) => ({
        ...attemptAnalytics,
        engagement: engagementAnalytics
      })),
    auditEventType: "organizer.outbound_delivery_analytics.view"
  });

  router.addRoute({
    id: "organizer-outbound-queue-list",
    method: "GET",
    path: "/organizer/events/:eventId/outbound-queue",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const pagination = parseArtifactInventoryPagination(query);
      const inventory = await buildNotificationQueueInventory({
        repos,
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id,
        query
      });
      const pageItems = inventory.slice(pagination.offset, pagination.offset + pagination.limit);
      return {
        event_id: resources.event.id,
        filters: {
          channel: query.channel ?? null,
          status: query.status ?? null
        },
        items: pageItems,
        pagination: buildPaginationEnvelope(inventory.length, pageItems.length, pagination)
      };
    },
    auditEventType: "organizer.outbound_queue.view"
  });

  router.addRoute({
    id: "organizer-outbound-queue-process",
    method: "POST",
    path: "/organizer/events/:eventId/outbound-queue/process",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      if (body?.limit != null) {
        const limit = parsePositiveInteger(body.limit, "limit");
        if (limit > 200) {
          throw new HttpError(400, "limit must be 200 or less");
        }
      }
      return body ?? {};
    },
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, principal, body, env }) =>
      processNotificationQueueBatch({
        repos,
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id,
        env,
        limit: Number(body?.limit ?? 20),
        initiatedBy: principal.user_id ?? principal.actor_id
      }),
    auditEventType: "organizer.outbound_queue.batch_processed"
  });

  router.addRoute({
    id: "organizer-outbound-attempts-list",
    method: "GET",
    path: "/organizer/events/:eventId/outbound-attempts",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const pagination = parseArtifactInventoryPagination(query);
      const items = await buildNotificationAttemptHistory({
        repos,
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id,
        query
      });
      const pageItems = items.slice(pagination.offset, pagination.offset + pagination.limit);
      return {
        event_id: resources.event.id,
        filters: {
          channel: query.channel ?? null,
          provider: query.provider ?? null,
          status: query.status ?? null,
          device_id: query.device_id ?? null,
          recent_hours: query.recent_hours != null ? Number(query.recent_hours) : null
        },
        items: pageItems,
        pagination: buildPaginationEnvelope(items.length, pageItems.length, pagination)
      };
    },
    auditEventType: "organizer.outbound_attempts.view"
  });

  router.addRoute({
    id: "organizer-outbound-queue-export",
    method: "GET",
    path: "/organizer/events/:eventId/outbound-queue/export",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const items = await buildNotificationQueueInventory({
        repos,
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id,
        query
      });
      const columns = [
        "notification_id",
        "interaction_id",
        "channel",
        "provider",
        "queue_state",
        "status",
        "attempts_count",
        "latest_attempt_status",
        "latest_attempt_at",
        "latest_attempt_http_status",
        "latest_attempt_duration_ms",
        "latest_attempt_response_excerpt",
        "next_attempt_at",
        "last_error",
        "retry_exhausted_at",
        "retry_exhausted_reason",
        "provider_message_id",
        "created_at",
        "updated_at"
      ];
      const rows = items.map((item) => ({
        notification_id: item.id,
        interaction_id: item.interaction_id,
        channel: item.channel,
        provider: item.provider,
        queue_state: item.queue_state,
        status: item.status,
        attempts_count: item.attempts_count,
        latest_attempt_status: item.latest_attempt_status,
        latest_attempt_at: item.latest_attempt_at,
        latest_attempt_http_status: item.latest_attempt_http_status,
        latest_attempt_duration_ms: item.latest_attempt_duration_ms,
        latest_attempt_response_excerpt: item.latest_attempt_response_excerpt,
        next_attempt_at: item.next_attempt_at,
        last_error: item.last_error,
        retry_exhausted_at: item.retry_exhausted_at,
        retry_exhausted_reason: item.retry_exhausted_reason,
        provider_message_id: item.provider_message_id,
        created_at: item.created_at,
        updated_at: item.updated_at
      }));
      return {
        event_id: resources.event.id,
        content_type: "text/csv",
        filename: `${resources.event.id}-outbound-queue.csv`,
        row_count: rows.length,
        csv: toCsv(columns, rows)
      };
    },
    auditEventType: "organizer.outbound_queue.exported"
  });

  router.addRoute({
    id: "organizer-outbound-attempts-export",
    method: "GET",
    path: "/organizer/events/:eventId/outbound-attempts/export",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const items = await buildNotificationAttemptHistory({
        repos,
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id,
        query
      });
      const columns = [
        "attempt_id",
        "notification_id",
        "interaction_id",
        "channel",
        "provider",
        "status",
        "attempt_number",
        "provider_message_id",
        "http_status",
        "duration_ms",
        "response_excerpt",
        "error_message",
        "attempted_at"
      ];
      const rows = items.map((item) => ({
        attempt_id: item.id,
        notification_id: item.notification_id,
        interaction_id: item.interaction_id,
        channel: item.channel,
        provider: item.provider,
        status: item.status,
        attempt_number: item.attempt_number,
        provider_message_id: item.provider_message_id,
        http_status: item.http_status,
        duration_ms: item.duration_ms,
        response_excerpt: item.response_excerpt,
        error_message: item.error_message,
        attempted_at: item.attempted_at
      }));
      return {
        event_id: resources.event.id,
        content_type: "text/csv",
        filename: `${resources.event.id}-outbound-attempts.csv`,
        row_count: rows.length,
        csv: toCsv(columns, rows)
      };
    },
    auditEventType: "organizer.outbound_attempts.exported"
  });

  router.addRoute({
    id: "organizer-notification-receipts-list",
    method: "GET",
    path: "/organizer/events/:eventId/notification-receipts",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const pagination = parseArtifactInventoryPagination(query);
      const items = await buildNotificationReceiptHistory({
        repos,
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id,
        query
      });
      const pageItems = items.slice(pagination.offset, pagination.offset + pagination.limit);
      return {
        event_id: resources.event.id,
        filters: {
          channel: query.channel ?? null,
          provider: query.provider ?? null,
          receipt_type: query.receipt_type ?? null,
          device_id: query.device_id ?? null,
          recent_hours: query.recent_hours != null ? Number(query.recent_hours) : null
        },
        items: pageItems,
        pagination: buildPaginationEnvelope(items.length, pageItems.length, pagination)
      };
    },
    auditEventType: "organizer.notification_receipts.view"
  });

  router.addRoute({
    id: "organizer-notification-receipts-export",
    method: "GET",
    path: "/organizer/events/:eventId/notification-receipts/export",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const items = await buildNotificationReceiptHistory({
        repos,
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id,
        query
      });
      const columns = [
        "receipt_id",
        "notification_id",
        "interaction_id",
        "channel",
        "provider",
        "receipt_type",
        "provider_message_id",
        "provider_event_id",
        "summary",
        "occurred_at",
        "received_at"
      ];
      const rows = items.map((item) => ({
        receipt_id: item.id,
        notification_id: item.notification_id,
        interaction_id: item.interaction_id,
        channel: item.channel,
        provider: item.provider,
        receipt_type: item.receipt_type,
        provider_message_id: item.provider_message_id,
        provider_event_id: item.provider_event_id,
        summary: item.summary,
        occurred_at: item.occurred_at,
        received_at: item.received_at
      }));
      return {
        event_id: resources.event.id,
        content_type: "text/csv",
        filename: `${resources.event.id}-notification-receipts.csv`,
        row_count: rows.length,
        csv: toCsv(columns, rows)
      };
    },
    auditEventType: "organizer.notification_receipts.exported"
  });

  router.addRoute({
    id: "organizer-operational-alerts",
    method: "GET",
    path: "/organizer/events/:eventId/operational-alerts",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const pagination = parseArtifactInventoryPagination(query);
      const alerts = await buildOperationalArtifactAlerts(repos, resources.event);
      const pageItems = alerts.items.slice(pagination.offset, pagination.offset + pagination.limit);
      return {
        ...alerts,
        items: pageItems,
        pagination: buildPaginationEnvelope(alerts.items.length, pageItems.length, pagination)
      };
    },
    auditEventType: "organizer.operational_alerts.view"
  });

  router.addRoute({
    id: "organizer-artifact-attempts-export",
    method: "GET",
    path: "/organizer/events/:eventId/artifact-attempts/export",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => buildArtifactAttemptsCsvExport(repos, resources.event),
    auditEventType: "organizer.artifact_attempts.exported"
  });

  router.addRoute({
    id: "auth-oidc-exchange",
    method: "POST",
    path: "/auth/oidc/exchange",
    authRequired: false,
    validate: (body) => {
      required(body, ["code", "code_verifier", "redirect_uri"]);
      return body;
    },
    handler: async ({ oidc, securityMode, body }) => {
      if (securityMode !== "secure") {
        throw new HttpError(400, "OIDC browser exchange is only available in secure mode");
      }
      if (!oidc?.enabled) {
        throw new HttpError(503, "OIDC browser login is not configured");
      }

      const tokenSet = await oidc.exchangeAuthorizationCode({
        code: body.code,
        codeVerifier: body.code_verifier,
        redirectUri: body.redirect_uri
      });

      return {
        access_token: tokenSet.access_token ?? null,
        token_type: tokenSet.token_type ?? "Bearer",
        expires_in: tokenSet.expires_in ?? null,
        scope: tokenSet.scope ?? null,
        id_token: tokenSet.id_token ?? null
      };
    }
  });

  router.addRoute({
    id: "device-credentials-list",
    method: "GET",
    path: "/devices/:deviceId/credentials",
    allowedRoles: ["organizer_admin", "platform_admin"],
    resolveResources: resolveDeviceCredentialResources,
    handler: async ({ repos, resources }) => ({
      device_id: resources.device.id,
      items: (await repos.deviceCredentials.listByDevice(resources.device.tenant_id, resources.device.id)).map(
        (credential) => ({
          id: credential.id,
          credential_label: credential.credential_label,
          status: credential.status,
          created_by_user_id: credential.created_by_user_id,
          revoked_by_user_id: credential.revoked_by_user_id,
          last_used_at: credential.last_used_at,
          revoked_at: credential.revoked_at,
          created_at: credential.created_at
        })
      )
    }),
    auditEventType: "device.credentials.view"
  });

  router.addRoute({
    id: "device-credentials-provision",
    method: "POST",
    path: "/devices/:deviceId/credentials/provision",
    allowedRoles: ["organizer_admin", "platform_admin"],
    validate: (body) => {
      required(body, ["credential_label"]);
      return body;
    },
    resolveResources: resolveDeviceCredentialResources,
    handler: async ({ repos, principal, body, resources }) => {
      const token = createDeviceCredentialToken();
      const credential = await repos.deviceCredentials.create({
        id: nextId("device-credential"),
        tenant_id: resources.device.tenant_id,
        device_id: resources.device.id,
        credential_label: body.credential_label,
        token_hash: hashDeviceCredentialToken(token),
        status: "active",
        created_by_user_id: principal.user_id,
        revoked_by_user_id: null,
        last_used_at: null,
        revoked_at: null,
        created_at: new Date().toISOString()
      });

      return {
        device_id: resources.device.id,
        credential: {
          id: credential.id,
          credential_label: credential.credential_label,
          status: credential.status,
          created_at: credential.created_at
        },
        bearer_token: token
      };
    },
    statusCode: 201,
    auditEventType: "device.credentials.provisioned"
  });

  router.addRoute({
    id: "device-credentials-revoke",
    method: "POST",
    path: "/devices/:deviceId/credentials/:credentialId/revoke",
    allowedRoles: ["organizer_admin", "platform_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const base = await resolveDeviceCredentialResources({ repos, principal, params });
      const credential = await repos.deviceCredentials.findById(principal.tenant_id, params.credentialId);
      if (credential.device_id !== base.device.id) {
        throw new HttpError(404, "Device credential not found");
      }
      return { ...base, credential };
    },
    handler: async ({ repos, principal, resources }) => {
      resources.credential.status = "revoked";
      resources.credential.revoked_by_user_id = principal.user_id;
      resources.credential.revoked_at = new Date().toISOString();
      const credential = await repos.deviceCredentials.update(resources.credential);
      return {
        id: credential.id,
        device_id: credential.device_id,
        credential_label: credential.credential_label,
        status: credential.status,
        revoked_by_user_id: credential.revoked_by_user_id,
        revoked_at: credential.revoked_at
      };
    },
    auditEventType: "device.credentials.revoked"
  });

  router.addRoute({
    id: "device-config",
    method: "GET",
    path: "/device/config/:deviceId",
    allowedRoles: ["device_principal"],
    resolveResources: async ({ repos, principal, params }) => {
      const device = await repos.devices.findById(principal.tenant_id, params.deviceId);
      const assignment = await repos.deviceAssignments.findActiveByDeviceId(principal.tenant_id, device.id);
      const event = await repos.events.findById(principal.tenant_id, assignment.event_id);
      const stall = await repos.stalls.findById(principal.tenant_id, assignment.stall_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { device, assignment, event, stall, eventPolicy };
    },
    handler: async ({ resources }) => ({
      device_id: resources.device.id,
      event_id: resources.event.id,
      stall_id: resources.stall.id,
      assignment_checksum: resources.assignment.assignment_checksum,
      lease_expires_at: resources.device.config_lease_expires_at,
      metrics_definition_version: resources.event.metrics_definition_version,
      event_policy: resources.eventPolicy
    }),
    auditEventType: "device.config.view"
  });

  router.addRoute({
    id: "device-heartbeat",
    method: "POST",
    path: "/device/heartbeat",
    allowedRoles: ["device_principal"],
    validate: (body) => {
      required(body, ["device_id", "event_id", "stall_id", "local_queue_depth", "battery_level"]);
      return body;
    },
    resolveResources: async ({ repos, principal, body }) => {
      const device = await repos.devices.findById(principal.tenant_id, body.device_id);
      const event = await repos.events.findById(principal.tenant_id, body.event_id);
      const stall = await repos.stalls.findById(principal.tenant_id, body.stall_id);
      const assignment = await repos.deviceAssignments.findActiveByDeviceId(principal.tenant_id, device.id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      if (assignment.event_id !== event.id || assignment.stall_id !== stall.id) {
        throw new HttpError(403, "Heartbeat event/stall must match active assignment");
      }
      return { device, assignment, event, stall, eventPolicy };
    },
    handler: async ({ repos, body, resources }) => {
      await repos.heartbeats.create({
        id: nextId("heartbeat"),
        tenant_id: resources.event.tenant_id,
        device_id: body.device_id,
        event_id: body.event_id,
        stall_id: body.stall_id,
        battery_level: body.battery_level,
        local_queue_depth: body.local_queue_depth,
        assignment_checksum: resources.assignment.assignment_checksum,
        connectivity_status: body.connectivity_status ?? "online",
        reader_status: body.reader_status ?? "connected",
        app_version: body.app_version ?? null,
        firmware_version: body.firmware_version ?? null,
        source_cursor: null,
        raw_payload: body,
        recorded_at: new Date().toISOString()
      });
      return { accepted: true };
    },
    statusCode: 202,
    auditEventType: "device.heartbeat.recorded"
  });

  router.addRoute({
    id: "interaction-tap",
    method: "POST",
    path: "/interactions/tap",
    allowedRoles: ["device_principal"],
    validate: validateTapBody,
    resolveResources: async ({ repos, principal, body }) => {
      const device = await repos.devices.findById(principal.tenant_id, body.device_id);
      const assignment = await repos.deviceAssignments.findActiveByDeviceId(principal.tenant_id, device.id);
      const event = await repos.events.findById(principal.tenant_id, body.event_id);
      const stall = await repos.stalls.findById(principal.tenant_id, body.stall_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { device, assignment, event, stall, eventPolicy };
    },
    handler: async (ctx) => createInteractionFromTap(ctx),
    statusCode: 201,
    auditEventType: "interaction.tap.created"
  });

  router.addRoute({
    id: "device-sync",
    method: "POST",
    path: "/device/sync",
    allowedRoles: ["device_principal"],
    validate: (body) => {
      required(body, ["device_id", "items"]);
      if (!Array.isArray(body.items)) {
        throw new HttpError(400, "items must be an array");
      }
      return body;
    },
    resolveResources: async ({ repos, principal, body }) => {
      const device = await repos.devices.findById(principal.tenant_id, body.device_id);
      const assignment = await repos.deviceAssignments.findActiveByDeviceId(principal.tenant_id, device.id);
      const event = await repos.events.findById(principal.tenant_id, assignment.event_id);
      const stall = await repos.stalls.findById(principal.tenant_id, assignment.stall_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { device, assignment, event, stall, eventPolicy };
    },
    handler: async (ctx) => {
      const results = [];
      for (const item of ctx.body.items) {
        if (item.event_id !== ctx.resources.assignment.event_id || item.stall_id !== ctx.resources.assignment.stall_id) {
          throw new HttpError(403, "Sync item event/stall must match active device assignment");
        }
        const result = await createInteractionFromTap({
          ...ctx,
          body: item,
          resources: {
            ...ctx.resources,
            event: await ctx.repos.events.findById(ctx.tenantId, item.event_id),
            stall: await ctx.repos.stalls.findById(ctx.tenantId, item.stall_id)
          }
        });
        results.push(result);
      }
      return { device_id: ctx.body.device_id, results };
    },
    auditEventType: "device.sync.completed"
  });

  router.addRoute({
    id: "consent-capture",
    method: "POST",
    path: "/consents/capture",
    authRequired: false,
    validate: (body) => {
      required(body, ["session_token", "vendor_release_allowed", "sponsor_release_allowed"]);
      if (typeof body.vendor_release_allowed !== "boolean" || typeof body.sponsor_release_allowed !== "boolean") {
        throw new HttpError(400, "Consent choices must be explicit booleans");
      }
      validateCommunicationChannelConsentChoices(body.communication_channel_consents);
      return body;
    },
    resolveResources: async ({ state, repos, body, headers }) => {
      const session = verifyAttendeeSessionToken(body.session_token, state.sessionSecret);
      const interaction = await repos.interactions.findById(session.tenant_id, session.interaction_id);
      const event = await repos.events.findById(session.tenant_id, interaction.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(session.tenant_id, event.id);
      return {
        session,
        interaction,
        event,
        eventPolicy,
        tenantHint: headers["x-tenant-id"] || event.tenant_id
      };
    },
    handler: async ({ repos, body, resources, headers }) =>
      repos.withTransaction(async (txRepos) => {
        const evidence = buildConsentEvidence({ body, headers });
        const interaction = await txRepos.interactions.findById(resources.interaction.tenant_id, resources.interaction.id);
        let attendee = interaction.attendee_id
          ? await txRepos.attendees.findById(interaction.tenant_id, interaction.attendee_id)
          : null;

        if (!attendee) {
          attendee = {
            id: nextId("attendee"),
            tenant_id: interaction.tenant_id,
            created_at: new Date().toISOString()
          };
          await txRepos.attendees.create(attendee);
          interaction.attendee_id = attendee.id;
        }

        const consentStatus = body.vendor_release_allowed
          ? body.sponsor_release_allowed
            ? "vendor_and_sponsor"
            : "vendor_only"
          : "declined";

        interaction.consent_status = consentStatus;
        interaction.status = consentStatus === "declined" ? "anonymized" : "active";
        await txRepos.interactions.update(interaction);

        await txRepos.consents.upsert({
          interaction_id: interaction.id,
          tenant_id: interaction.tenant_id,
          attendee_id: attendee.id,
          vendor_release_allowed: Boolean(body.vendor_release_allowed),
          sponsor_release_allowed: Boolean(body.sponsor_release_allowed),
          revoked_at: null,
          updated_at: new Date().toISOString()
        });

        await txRepos.consentEvents.create({
          id: nextId("consent-event"),
          interaction_id: interaction.id,
          tenant_id: interaction.tenant_id,
          action: "capture",
          vendor_release_allowed: Boolean(body.vendor_release_allowed),
          sponsor_release_allowed: Boolean(body.sponsor_release_allowed),
          locale: evidence.locale,
          ip_address: evidence.ip_address,
          user_agent: evidence.user_agent,
          created_at: new Date().toISOString()
        });

        if (body.attendee_profile) {
          await txRepos.attendeeProfiles.upsert({
            attendee_id: attendee.id,
            full_name: body.attendee_profile.full_name ?? null,
            company_name: body.attendee_profile.company_name ?? null,
            email: body.attendee_profile.email ?? null,
            phone: body.attendee_profile.phone ?? null,
            updated_at: new Date().toISOString()
          });
        }

        const channelConsents = await upsertCommunicationChannelConsents({
          repos: txRepos,
          interaction,
          attendee,
          choices: body.communication_channel_consents,
          evidence
        });
        const revokedChannels = Object.entries(body.communication_channel_consents ?? {})
          .filter(([, allowed]) => allowed === false)
          .map(([channel]) => channel);
        if (revokedChannels.length) {
          await cancelQueuedFollowupsForInteraction({
            repos: txRepos,
            interaction,
            channels: revokedChannels
          });
        }

        return {
          interaction_id: interaction.id,
          consent_status: interaction.consent_status,
          attendee_id: attendee.id,
          communication_channel_consents: channelConsents
        };
      }),
    auditEventType: "consent.capture"
  });

  router.addRoute({
    id: "consent-revoke",
    method: "POST",
    path: "/consents/revoke",
    authRequired: false,
    validate: (body) => {
      required(body, ["session_token"]);
      return body;
    },
    resolveResources: async ({ state, repos, body }) => {
      const session = verifyAttendeeSessionToken(body.session_token, state.sessionSecret);
      const interaction = await repos.interactions.findById(session.tenant_id, session.interaction_id);
      const event = await repos.events.findById(session.tenant_id, interaction.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(session.tenant_id, event.id);
      return { session, interaction, event, eventPolicy };
    },
    handler: async ({ repos, resources, body, headers }) =>
      repos.withTransaction(async (txRepos) => {
        const evidence = buildConsentEvidence({ body, headers });
        const interaction = await txRepos.interactions.findById(resources.interaction.tenant_id, resources.interaction.id);
        const existingConsent =
          (await txRepos.consents.findByInteractionId(interaction.tenant_id, interaction.id)) ?? {
            vendor_release_allowed: interaction.consent_status === "vendor_only" || interaction.consent_status === "vendor_and_sponsor",
            sponsor_release_allowed: interaction.consent_status === "vendor_and_sponsor"
          };
        const revokeVendorRelease = body.revoke_vendor_release ?? true;
        const revokeSponsorRelease = body.revoke_sponsor_release ?? true;
        let vendorReleaseAllowed = Boolean(existingConsent.vendor_release_allowed) && !revokeVendorRelease;
        let sponsorReleaseAllowed = Boolean(existingConsent.sponsor_release_allowed) && !revokeSponsorRelease;
        if (!vendorReleaseAllowed) {
          sponsorReleaseAllowed = false;
        }
        interaction.consent_status = vendorReleaseAllowed
          ? sponsorReleaseAllowed
            ? "vendor_and_sponsor"
            : "vendor_only"
          : "declined";
        interaction.status = interaction.consent_status === "declined" ? "anonymized" : "active";
        await txRepos.interactions.update(interaction);

        await txRepos.consents.upsert({
          interaction_id: interaction.id,
          tenant_id: interaction.tenant_id,
          attendee_id: interaction.attendee_id ?? null,
          vendor_release_allowed: vendorReleaseAllowed,
          sponsor_release_allowed: sponsorReleaseAllowed,
          revoked_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });

        await txRepos.consentEvents.create({
          id: nextId("consent-event"),
          interaction_id: interaction.id,
          tenant_id: interaction.tenant_id,
          action: "revoke",
          vendor_release_allowed: vendorReleaseAllowed,
          sponsor_release_allowed: sponsorReleaseAllowed,
          locale: evidence.locale,
          ip_address: evidence.ip_address,
          user_agent: evidence.user_agent,
          created_at: new Date().toISOString()
        });

        if (!vendorReleaseAllowed && body.revoke_communication_channels !== false) {
          await revokeCommunicationChannelConsents({
            repos: txRepos,
            interaction,
            evidence
          });
          await cancelQueuedFollowupsForInteraction({
            repos: txRepos,
            interaction,
            channels: COMMUNICATION_CHANNELS
          });
        }

        return { interaction_id: interaction.id, consent_status: interaction.consent_status };
      }),
    auditEventType: "consent.revoke"
  });

  router.addRoute({
    id: "attendee-session-view",
    method: "GET",
    path: "/attendee/session/:interactionId",
    authRequired: false,
    resolveResources: async ({ state, repos, params, query, headers }) => {
      const sessionToken = query.token ?? headers["x-attendee-session-token"];
      const session = verifyAttendeeSessionToken(sessionToken, state.sessionSecret);
      if (session.interaction_id !== params.interactionId) {
        throw new HttpError(403, "Attendee session does not match requested interaction");
      }
      const interaction = await repos.interactions.findById(session.tenant_id, session.interaction_id);
      const event = await repos.events.findById(session.tenant_id, interaction.event_id);
      const stall = await repos.stalls.findById(session.tenant_id, interaction.stall_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(session.tenant_id, event.id);
      return { session, interaction, event, stall, eventPolicy };
    },
    handler: async ({ repos, resources }) => {
      const interaction = resources.interaction;
      const attendeeProfile = interaction.attendee_id
        ? await repos.attendeeProfiles.findByAttendeeId(interaction.attendee_id)
        : null;
      const consent =
        (await repos.consents.findByInteractionId(interaction.tenant_id, interaction.id)) ?? {
          vendor_release_allowed: false,
          sponsor_release_allowed: false,
          revoked_at: null
        };
      const consentEvents = typeof repos.consentEvents.listByInteraction === "function"
        ? await repos.consentEvents.listByInteraction(interaction.tenant_id, interaction.id)
        : [];
      const communicationChannelConsents = typeof repos.communicationChannelConsents.listByInteraction === "function"
        ? await repos.communicationChannelConsents.listByInteraction(interaction.tenant_id, interaction.id)
        : [];
      const communicationSuppressions = typeof repos.communicationSuppressions?.listByInteraction === "function"
        ? await repos.communicationSuppressions.listByInteraction(interaction.tenant_id, interaction.id)
        : [];
      const walletPasses = typeof repos.walletPasses?.listByInteraction === "function"
        ? await repos.walletPasses.listByInteraction(interaction.tenant_id, interaction.id)
        : [];

      const eventInteractions = interaction.attendee_id
        ? await repos.interactions.listByEvent(interaction.tenant_id, interaction.event_id)
        : [];
      const connections = await Promise.all(
        eventInteractions
          .filter((entry) => entry.attendee_id && entry.attendee_id === interaction.attendee_id)
          .map(async (entry) => {
            const stall = await repos.stalls.findById(interaction.tenant_id, entry.stall_id);
            return {
              interaction_id: entry.id,
              stall_id: stall.id,
              stall_name: stall.name,
              stall_code: stall.code,
              consent_status: entry.consent_status,
              status: entry.status,
              created_at: entry.created_at
            };
          })
      );

      return {
        interaction_id: interaction.id,
        event: {
          id: resources.event.id,
          name: resources.event.name
        },
        current_connection: {
          stall_id: resources.stall.id,
          stall_name: resources.stall.name,
          stall_code: resources.stall.code,
          consent_status: interaction.consent_status,
          status: interaction.status,
          created_at: interaction.created_at
        },
        attendee_profile: attendeeProfile,
        consent,
        consent_events: consentEvents,
        communication_channel_consents: communicationChannelConsents,
        communication_suppressions: communicationSuppressions,
        wallet_passes: walletPasses.map(serializeWalletPass),
        connections: connections.sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at)),
        privacy: {
          sponsor_pii_enabled: resources.eventPolicy.sponsor_pii_enabled,
          vendor_exports_enabled: resources.eventPolicy.vendor_exports_enabled,
          allow_crm_push: resources.eventPolicy.allow_crm_push,
          self_service_controls: {
            revoke_consent: {
              method: "POST",
              endpoint: "/consents/revoke",
              requires_session_token: true
            },
            request_access_export: {
              method: "POST",
              endpoint: `/attendee/session/${interaction.id}/dsr`,
              request_type: "access",
              requires_session_token: true
            },
            request_delete: {
              method: "POST",
              endpoint: `/attendee/session/${interaction.id}/dsr`,
              request_type: "delete",
              requires_session_token: true
            },
            request_wallet_pass: {
              method: "POST",
              endpoint: `/attendee/session/${interaction.id}/wallet-pass`,
              requires_session_token: true,
              safe_disabled: true
            }
          }
        }
      };
    },
    auditEventType: "attendee.session.view"
  });

  router.addRoute({
    id: "attendee-wallet-pass-create",
    method: "POST",
    path: "/attendee/session/:interactionId/wallet-pass",
    authRequired: false,
    validate: validateWalletPassRequestBody,
    resolveResources: async ({ state, repos, params, body }) => {
      const session = verifyAttendeeSessionToken(body.session_token, state.sessionSecret);
      if (session.interaction_id !== params.interactionId) {
        throw new HttpError(403, "Attendee session does not match requested interaction");
      }
      const interaction = await repos.interactions.findById(session.tenant_id, session.interaction_id);
      const event = await repos.events.findById(session.tenant_id, interaction.event_id);
      const stall = await repos.stalls.findById(session.tenant_id, interaction.stall_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(session.tenant_id, event.id);
      return { session, interaction, event, stall, eventPolicy };
    },
    handler: async ({ repos, resources, body, env }) =>
      repos.withTransaction(async (txRepos) => createWalletPassSafely({
        repos: txRepos,
        resources,
        passType: body.pass_type ?? "generic",
        requestedByUserId: null,
        env
      })),
    statusCode: 201,
    auditEventType: "attendee.wallet_pass.requested"
  });

  router.addRoute({
    id: "attendee-dsr-create",
    method: "POST",
    path: "/attendee/session/:interactionId/dsr",
    authRequired: false,
    validate: (body) => {
      required(body, ["session_token", "request_type"]);
      if (!["access", "delete"].includes(body.request_type)) {
        throw new HttpError(400, "request_type must be access or delete");
      }
      return body;
    },
    resolveResources: async ({ state, repos, params, body }) => {
      const session = verifyAttendeeSessionToken(body.session_token, state.sessionSecret);
      if (session.interaction_id !== params.interactionId) {
        throw new HttpError(403, "Attendee session does not match requested interaction");
      }
      const interaction = await repos.interactions.findById(session.tenant_id, session.interaction_id);
      const event = await repos.events.findById(session.tenant_id, interaction.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(session.tenant_id, event.id);
      return { session, interaction, event, eventPolicy };
    },
    handler: async ({ repos, resources, body }) => {
      const request = await createDataSubjectRequest({
        repos,
        event: resources.event,
        principal: null,
        body: {
          request_type: body.request_type,
          interaction_id: resources.interaction.id,
          request_reason: body.request_reason ?? `Attendee self-service ${body.request_type} request`
        }
      });
      return {
        id: request.id,
        event_id: request.event_id,
        interaction_id: request.interaction_id,
        attendee_id: request.attendee_id,
        request_type: request.request_type,
        status: request.status,
        created_at: request.created_at
      };
    },
    statusCode: 201,
    auditEventType: "attendee.dsr.created"
  });

  router.addRoute({
    id: "stall-leads",
    method: "GET",
    path: "/stalls/:stallId/leads",
    allowedRoles: ["vendor_manager", "organizer_admin", "platform_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId);
      const event = await repos.events.findById(principal.tenant_id, stall.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { stall, event, eventPolicy };
    },
    maskResponse: true,
    handler: async ({ repos, resources, query }) => {
      const pagination = parseLeadInboxQuery(query);
      const leadItems = await Promise.all(
        (await repos.interactions.listByStall(resources.event.tenant_id, resources.stall.id))
          .map((interaction) => buildLeadItem(repos, resources.event.tenant_id, interaction, resources.eventPolicy))
      );
      const sorted = leadItems.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      const filtered = applyLeadInboxFilters(sorted, pagination.filters);
      const pageItems = filtered.slice(pagination.offset, pagination.offset + pagination.limit);

      return {
        items: pageItems,
        columns: LEAD_INBOX_COLUMNS,
        filters: LEAD_INBOX_FILTERS,
        pagination: {
          limit: pagination.limit,
          offset: pagination.offset,
          total: filtered.length,
          has_more: pagination.offset + pageItems.length < filtered.length,
          next_offset:
            pagination.offset + pageItems.length < filtered.length
              ? pagination.offset + pageItems.length
              : null
        },
        filters_applied: pagination.filters
      };
    },
    auditEventType: "vendor.leads.view"
  });

  router.addRoute({
    id: "stall-dashboard-metrics",
    method: "GET",
    path: "/stalls/:stallId/dashboard-metrics",
    allowedRoles: ["vendor_manager", "organizer_admin", "platform_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId);
      const event = await repos.events.findById(principal.tenant_id, stall.event_id);
      return { stall, event };
    },
    handler: async ({ repos, resources, query }) =>
      buildVendorDashboardMetrics({
        repos,
        tenantId: resources.event.tenant_id,
        event: resources.event,
        stall: resources.stall,
        query
      }),
    auditEventType: "vendor.dashboard_metrics.view"
  });

  router.addRoute({
    id: "interaction-lead-detail",
    method: "GET",
    path: "/interactions/:interactionId/detail",
    allowedRoles: ["vendor_manager", "organizer_admin", "platform_admin"],
    maskResponse: true,
    resolveResources: async ({ repos, principal, params }) => {
      const interaction = await repos.interactions.findById(principal.tenant_id, params.interactionId);
      const stall = await repos.stalls.findById(principal.tenant_id, interaction.stall_id);
      const event = await repos.events.findById(principal.tenant_id, interaction.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { interaction, stall, event, eventPolicy };
    },
    handler: async ({ repos, resources }) => {
      const item = await buildLeadItem(repos, resources.event.tenant_id, resources.interaction, resources.eventPolicy);
      return { item };
    },
    auditEventType: "vendor.lead_detail.view"
  });

  router.addRoute({
    id: "interaction-wallet-passes-list",
    method: "GET",
    path: "/interactions/:interactionId/wallet-passes",
    allowedRoles: ["vendor_manager", "organizer_admin", "platform_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const interaction = await repos.interactions.findById(principal.tenant_id, params.interactionId);
      const stall = await repos.stalls.findById(principal.tenant_id, interaction.stall_id);
      const event = await repos.events.findById(principal.tenant_id, interaction.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { interaction, stall, event, eventPolicy };
    },
    handler: async ({ repos, resources }) => ({
      interaction_id: resources.interaction.id,
      wallet_passes: await Promise.all((await repos.walletPasses.listByInteraction(resources.interaction.tenant_id, resources.interaction.id))
        .map((walletPass) => serializeWalletPassWithAttempts(repos, walletPass)))
    }),
    auditEventType: "wallet_passes.view"
  });

  router.addRoute({
    id: "classify-interaction",
    method: "POST",
    path: "/interactions/:interactionId/classify",
    allowedRoles: ["vendor_manager"],
    validate: (body) => {
      required(body, ["classification"]);
      if (!["hot", "warm", "cold"].includes(body.classification)) {
        throw new HttpError(400, "classification must be hot, warm, or cold");
      }
      if ("reason" in body && body.reason != null && typeof body.reason !== "string") {
        throw new HttpError(400, "reason must be a string when provided");
      }
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const interaction = await repos.interactions.findById(principal.tenant_id, params.interactionId);
      const stall = await repos.stalls.findById(principal.tenant_id, interaction.stall_id);
      const event = await repos.events.findById(principal.tenant_id, interaction.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { interaction, stall, event, eventPolicy };
    },
    handler: async ({ repos, body, resources, principal }) => {
      const previousScore = resources.interaction.classification ?? "cold";
      resources.interaction.classification = body.classification;
      await repos.interactions.update(resources.interaction);
      const score = await repos.leadScores.create({
        id: nextId("lead-score"),
        tenant_id: resources.interaction.tenant_id,
        interaction_id: resources.interaction.id,
        scored_by_user_id: principal.user_id,
        previous_score: previousScore,
        score: body.classification,
        reason: body.reason ?? null,
        created_at: new Date().toISOString()
      });
      return {
        interaction_id: resources.interaction.id,
        classification: body.classification,
        score_event: score
      };
    },
    auditEventType: "interaction.classified"
  });

  router.addRoute({
    id: "interaction-note",
    method: "POST",
    path: "/interactions/:interactionId/note",
    allowedRoles: ["vendor_manager"],
    validate: (body) => {
      required(body, ["note"]);
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const interaction = await repos.interactions.findById(principal.tenant_id, params.interactionId);
      const stall = await repos.stalls.findById(principal.tenant_id, interaction.stall_id);
      const event = await repos.events.findById(principal.tenant_id, interaction.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { interaction, stall, event, eventPolicy };
    },
    handler: async ({ repos, body, principal, resources }) => {
      const note = {
        id: nextId("note"),
        interaction_id: resources.interaction.id,
        tenant_id: resources.interaction.tenant_id,
        author_user_id: principal.user_id,
        note: body.note,
        created_at: new Date().toISOString()
      };
      await repos.interactionNotes.create(note);
      return { note_id: note.id, interaction_id: resources.interaction.id };
    },
    auditEventType: "interaction.note.created"
  });

  router.addRoute({
    id: "interaction-followup-create",
    method: "POST",
    path: "/interactions/:interactionId/followups",
    allowedRoles: ["vendor_manager", "organizer_admin"],
    validate: validateFollowupBody,
    resolveResources: resolveInteractionFollowupResources,
    handler: async ({ repos, body, principal, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const now = new Date().toISOString();
        const followup = await txRepos.followupMessages.create({
          id: nextId("followup"),
          tenant_id: resources.interaction.tenant_id,
          event_id: resources.interaction.event_id,
          stall_id: resources.interaction.stall_id,
          interaction_id: resources.interaction.id,
          channel: body.channel,
          subject: body.subject ?? null,
          body: body.body,
          status: "draft",
          created_by_user_id: principal.user_id,
          approved_by_user_id: null,
          notification_id: null,
          created_at: now,
          updated_at: now
        });
        if (body.status === "queued") {
          return queueFollowupMessage({
            repos: txRepos,
            followup,
            resources,
            principal,
            humanApproved: body.human_approved === true
          });
        }
        return followup;
      }),
    statusCode: 201,
    auditEventType: "interaction.followup.created"
  });

  router.addRoute({
    id: "followup-queue",
    method: "POST",
    path: "/followups/:followupId/queue",
    allowedRoles: ["vendor_manager", "organizer_admin"],
    validate: (body) => {
      if (body.human_approved !== true) {
        throw new HttpError(400, "Human approval is required before a follow-up can be queued");
      }
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const followup = await repos.followupMessages.findById(principal.tenant_id, params.followupId);
      const interaction = await repos.interactions.findById(principal.tenant_id, followup.interaction_id);
      const stall = await repos.stalls.findById(principal.tenant_id, interaction.stall_id);
      const event = await repos.events.findById(principal.tenant_id, interaction.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { followup, interaction, stall, event, eventPolicy };
    },
    handler: async ({ repos, resources, principal }) =>
      repos.withTransaction(async (txRepos) =>
        queueFollowupMessage({
          repos: txRepos,
          followup: await txRepos.followupMessages.findById(resources.followup.tenant_id, resources.followup.id),
          resources,
          principal,
          humanApproved: true
        })
      ),
    auditEventType: "followup.queued"
  });

  router.addRoute({
    id: "notification-attempt-create",
    method: "POST",
    path: "/notifications/:notificationId/attempts",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      required(body, ["provider", "status"]);
      if (!["sent", "failed", "temporary_failure"].includes(body.status)) {
        throw new HttpError(400, "Notification attempt status must be sent, failed, or temporary_failure");
      }
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const notification = await repos.notifications.findById(principal.tenant_id, params.notificationId);
      const event = await repos.events.findById(principal.tenant_id, notification.event_id);
      const interaction = notification.interaction_id
        ? await repos.interactions.findById(principal.tenant_id, notification.interaction_id)
        : null;
      const followup = await repos.followupMessages.findByNotificationId(principal.tenant_id, notification.id);
      return { notification, event, interaction, followup };
    },
    handler: async ({ repos, resources, body, env, principal }) =>
      repos.withTransaction(async (txRepos) => {
        if (["sent", "cancelled"].includes(resources.notification.status)) {
          throw new HttpError(409, "Notification is already in a final state");
        }
        const now = new Date().toISOString();
        if (body.status === "sent") {
          return completeNotificationSendSuccess({
            repos: txRepos,
            tenantId: resources.notification.tenant_id,
            notificationId: resources.notification.id,
            provider: body.provider,
            providerMessageId: body.provider_message_id ?? null,
            attemptedByUserId: principal.user_id ?? principal.actor_id,
            now
          });
        }
        if (body.status === "temporary_failure") {
          return completeNotificationSendTemporaryFailure({
            repos: txRepos,
            tenantId: resources.notification.tenant_id,
            notificationId: resources.notification.id,
            provider: body.provider,
            errorMessage: body.error_message ?? "Notification delivery failed and will be retried.",
            retryAt: new Date(
              Date.parse(now) + resolveNotificationRetryPolicy(env).retry_delay_minutes * 60 * 1000
            ).toISOString(),
            env,
            providerMessageId: body.provider_message_id ?? null,
            httpStatus: body.http_status ?? null,
            durationMs: body.duration_ms ?? null,
            responseExcerpt: body.response_excerpt ?? null,
            attemptedByUserId: principal.user_id ?? principal.actor_id,
            now
          });
        }
        return completeNotificationSendFailure({
          repos: txRepos,
          tenantId: resources.notification.tenant_id,
          notificationId: resources.notification.id,
          provider: body.provider,
          errorMessage: body.error_message ?? "Notification delivery was marked failed.",
          providerMessageId: body.provider_message_id ?? null,
          httpStatus: body.http_status ?? null,
          durationMs: body.duration_ms ?? null,
          responseExcerpt: body.response_excerpt ?? null,
          attemptedByUserId: principal.user_id ?? principal.actor_id,
          now
        });
      }),
    statusCode: 201,
    auditEventType: "notification.attempt.created"
  });

  router.addRoute({
    id: "notification-retry-now",
    method: "POST",
    path: "/notifications/:notificationId/retry-now",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: resolveNotificationOperationResources,
    handler: async ({ repos, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const queueState = deriveNotificationQueueState(resources.notification);
        if (queueState === "dead_letter") {
          throw new HttpError(409, "Dead-letter notifications require force requeue");
        }
        if (resources.notification.status === "sent") {
          throw new HttpError(409, "Sent notifications cannot be retried");
        }
        if (resources.notification.status === "cancelled") {
          throw new HttpError(409, "Cancelled notifications cannot be retried");
        }
        if (queueState !== "temporary_failure") {
          throw new HttpError(409, "Only temporary-failure notifications can be retried now");
        }
        await assertNotificationConsentStillValid(txRepos, resources);
        const now = new Date().toISOString();
        const notification = await txRepos.notifications.update({
          ...await txRepos.notifications.findById(resources.notification.tenant_id, resources.notification.id),
          status: "queued",
          sending_started_at: null,
          next_attempt_at: now,
          final_error: null,
          retry_exhausted_at: null,
          retry_exhausted_reason: null,
          updated_at: now
        });
        let followup = null;
        const existingFollowup = await txRepos.followupMessages.findByNotificationId(notification.tenant_id, notification.id);
        if (existingFollowup) {
          followup = await txRepos.followupMessages.update({
            ...existingFollowup,
            status: "queued",
            updated_at: now
          });
        }
        return {
          notification,
          followup,
          attempts: await txRepos.notificationAttempts.listByNotification(notification.tenant_id, notification.id)
        };
      }),
    auditEventType: "notification.retry_now"
  });

  router.addRoute({
    id: "notification-force-requeue",
    method: "POST",
    path: "/notifications/:notificationId/force-requeue",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: resolveNotificationOperationResources,
    handler: async ({ repos, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const queueState = deriveNotificationQueueState(resources.notification);
        if (queueState !== "dead_letter") {
          throw new HttpError(409, "Only dead-letter notifications can be force requeued");
        }
        await assertNotificationConsentStillValid(txRepos, resources);
        const now = new Date().toISOString();
        const notification = await txRepos.notifications.update({
          ...await txRepos.notifications.findById(resources.notification.tenant_id, resources.notification.id),
          status: "queued",
          sending_started_at: null,
          next_attempt_at: now,
          final_error: null,
          provider_message_id: null,
          retry_exhausted_at: null,
          retry_exhausted_reason: null,
          updated_at: now
        });
        let followup = null;
        const existingFollowup = await txRepos.followupMessages.findByNotificationId(notification.tenant_id, notification.id);
        if (existingFollowup) {
          followup = await txRepos.followupMessages.update({
            ...existingFollowup,
            status: "queued",
            updated_at: now
          });
        }
        return {
          notification,
          followup,
          attempts: await txRepos.notificationAttempts.listByNotification(notification.tenant_id, notification.id)
        };
      }),
    auditEventType: "notification.force_requeue"
  });

  router.addRoute({
    id: "notification-resend",
    method: "POST",
    path: "/notifications/:notificationId/resend",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: resolveNotificationOperationResources,
    handler: async ({ repos, resources }) =>
      repos.withTransaction(async (txRepos) => {
        if (resources.notification.status === "sent") {
          throw new HttpError(409, "Sent notifications cannot be resent");
        }
        if (resources.notification.status === "cancelled") {
          throw new HttpError(409, "Cancelled notifications cannot be resent");
        }
        if (resources.notification.status === "queued") {
          throw new HttpError(409, "Notification is already queued");
        }
        if (resources.notification.retry_exhausted_at) {
          throw new HttpError(409, "Dead-letter notifications require force requeue");
        }
        await assertNotificationConsentStillValid(txRepos, resources);
        const now = new Date().toISOString();
        const notification = await txRepos.notifications.update({
          ...await txRepos.notifications.findById(resources.notification.tenant_id, resources.notification.id),
          status: "queued",
          sending_started_at: null,
          next_attempt_at: now,
          final_error: null,
          provider_message_id: null,
          retry_exhausted_at: null,
          retry_exhausted_reason: null,
          updated_at: now
        });
        let followup = null;
        const existingFollowup = await txRepos.followupMessages.findByNotificationId(notification.tenant_id, notification.id);
        if (existingFollowup) {
          followup = await txRepos.followupMessages.update({
            ...existingFollowup,
            status: "queued",
            updated_at: now
          });
        }
        return {
          notification,
          followup,
          attempts: await txRepos.notificationAttempts.listByNotification(notification.tenant_id, notification.id)
        };
      }),
    auditEventType: "notification.resend_queued"
  });

  router.addRoute({
    id: "notification-cancel",
    method: "POST",
    path: "/notifications/:notificationId/cancel",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: resolveNotificationOperationResources,
    handler: async ({ repos, resources }) =>
      repos.withTransaction(async (txRepos) => {
        if (resources.notification.status === "sent") {
          throw new HttpError(409, "Sent notifications cannot be cancelled");
        }
        if (resources.notification.status === "cancelled") {
          return {
            notification: resources.notification,
            followup: resources.followup,
            attempts: await txRepos.notificationAttempts.listByNotification(resources.notification.tenant_id, resources.notification.id)
          };
        }
        const now = new Date().toISOString();
        const notification = await txRepos.notifications.update({
          ...await txRepos.notifications.findById(resources.notification.tenant_id, resources.notification.id),
          status: "cancelled",
          next_attempt_at: null,
          updated_at: now
        });
        let followup = null;
        const existingFollowup = await txRepos.followupMessages.findByNotificationId(notification.tenant_id, notification.id);
        if (existingFollowup) {
          followup = await txRepos.followupMessages.update({
            ...existingFollowup,
            status: "cancelled",
            updated_at: now
          });
        }
        return {
          notification,
          followup,
          attempts: await txRepos.notificationAttempts.listByNotification(notification.tenant_id, notification.id)
        };
      }),
    auditEventType: "notification.cancelled"
  });

  router.addRoute({
    id: "wallet-pass-retry",
    method: "POST",
    path: "/wallet-passes/:walletPassId/retry",
    allowedRoles: ["organizer_admin"],
    validate: validateWalletPassRetryBody,
    resolveResources: resolveWalletPassResources,
    handler: async ({ repos, resources, body, principal, env }) =>
      repos.withTransaction(async (txRepos) => {
        if (["delivered", "cancelled"].includes(resources.walletPass.status)) {
          throw new HttpError(409, "Wallet pass is already in a final state");
        }
        return retryWalletPassSafely({
          repos: txRepos,
          resources,
          passType: body.pass_type ?? resources.walletPass.pass_type,
          requestedByUserId: principal.user_id,
          env
        });
      }),
    auditEventType: "wallet_pass.retry"
  });

  router.addRoute({
    id: "wallet-pass-status-update",
    method: "POST",
    path: "/wallet-passes/:walletPassId/status",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      required(body, ["status"]);
      if (!["delivered", "failed", "cancelled"].includes(body.status)) {
        throw new HttpError(400, "Wallet pass status must be delivered, failed, or cancelled");
      }
      return body;
    },
    resolveResources: resolveWalletPassResources,
    handler: async ({ repos, resources, body }) =>
      repos.withTransaction(async (txRepos) => updateWalletPassStatus({
        repos: txRepos,
        walletPass: resources.walletPass,
        status: body.status,
        failureCode: body.failure_code ?? null,
        failureMessage: body.failure_message ?? null
      })),
    auditEventType: "wallet_pass.status.updated"
  });

  router.addRoute({
    id: "interaction-crm-sync",
    method: "POST",
    path: "/interactions/:interactionId/crm-sync",
    allowedRoles: ["vendor_manager", "organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: async ({ repos, principal, params }) => {
      const interaction = await repos.interactions.findById(principal.tenant_id, params.interactionId);
      const stall = await repos.stalls.findById(principal.tenant_id, interaction.stall_id);
      const event = await repos.events.findById(principal.tenant_id, interaction.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { interaction, stall, event, eventPolicy };
    },
    handler: async ({ repos, principal, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const attendeeProfile = resources.interaction.attendee_id
          ? await txRepos.attendeeProfiles.findByAttendeeId(resources.interaction.attendee_id)
          : null;
        const notes = await txRepos.interactionNotes.listByInteraction(
          resources.interaction.tenant_id,
          resources.interaction.id
        );
        const synced = await syncInteractionToPilotCrm({
          interaction: resources.interaction,
          attendeeProfile,
          stall: resources.stall,
          event: resources.event,
          notes
        });
        const existing = await txRepos.crmSyncRecords.findByInteractionAndProvider(
          resources.interaction.tenant_id,
          resources.interaction.id,
          synced.provider
        );
        const record = await txRepos.crmSyncRecords.upsert({
          id: existing?.id ?? nextId("crm-sync"),
          tenant_id: resources.interaction.tenant_id,
          event_id: resources.event.id,
          stall_id: resources.stall.id,
          interaction_id: resources.interaction.id,
          provider: synced.provider,
          requested_by_user_id: principal.user_id,
          status: "synced",
          external_record_id: synced.external_record_id,
          request_payload: synced.request_payload,
          response_payload: synced.response_payload,
          last_error: null,
          synced_at: synced.synced_at,
          deleted_at: null,
          created_at: existing?.created_at ?? synced.synced_at,
          updated_at: synced.synced_at
        });
        return buildCrmSyncResponse(record);
      }),
    auditEventType: "interaction.crm_sync.triggered"
  });

  router.addRoute({
    id: "interaction-notes-list",
    method: "GET",
    path: "/interactions/:interactionId/notes",
    allowedRoles: ["vendor_manager", "organizer_admin", "platform_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const interaction = await repos.interactions.findById(principal.tenant_id, params.interactionId);
      const stall = await repos.stalls.findById(principal.tenant_id, interaction.stall_id);
      const event = await repos.events.findById(principal.tenant_id, interaction.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { interaction, stall, event, eventPolicy };
    },
    handler: async ({ repos, resources }) => ({
      interaction_id: resources.interaction.id,
      items: await repos.interactionNotes.listByInteraction(
        resources.interaction.tenant_id,
        resources.interaction.id
      )
    }),
    auditEventType: "interaction.notes.view"
  });

  router.addRoute({
    id: "sponsor-metrics",
    method: "GET",
    path: "/sponsors/:sponsorId/metrics",
    allowedRoles: ["sponsor_user", "organizer_admin"],
    resolveResources: resolveSponsorDashboardResources,
    handler: async ({ repos, resources }) => buildSponsorDashboardResponse(
      repos,
      resources.sponsorOrganization,
      resources.event
    ),
    auditEventType: "sponsor.metrics.view"
  });

  router.addRoute({
    id: "sponsor-report-snapshots",
    method: "GET",
    path: "/sponsors/:sponsorId/report-snapshots",
    allowedRoles: ["sponsor_user", "organizer_admin"],
    resolveResources: resolveSponsorDashboardResources,
    handler: async ({ repos, resources }) => ({
      sponsor_id: resources.sponsorOrganization.id,
      event_id: resources.event.id,
      items: await listSponsorReportSnapshots(
        repos,
        resources.event.tenant_id,
        resources.event.id,
        resources.sponsorOrganization.id
      )
    }),
    auditEventType: "sponsor.report_snapshots.view"
  });

  router.addRoute({
    id: "sponsor-exports-list",
    method: "GET",
    path: "/sponsors/:sponsorId/exports",
    allowedRoles: ["sponsor_user", "organizer_admin"],
    resolveResources: resolveSponsorDashboardResources,
    handler: async ({ repos, resources }) => ({
      sponsor_id: resources.sponsorOrganization.id,
      event_id: resources.event.id,
      items: [...await repos.exportRequests.listByEvent(resources.event.tenant_id, resources.event.id)]
        .filter((entry) =>
          entry.export_type === "sponsor_dashboard_snapshot" &&
          entry.filters?.sponsor_id === resources.sponsorOrganization.id
        )
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    }),
    auditEventType: "sponsor.exports.view"
  });

  router.addRoute({
    id: "organizer-sponsor-report-snapshot-create",
    method: "POST",
    path: "/organizer/events/:eventId/sponsors/:sponsorId/report-snapshots",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const sponsorOrganization = await repos.organizations.findById(principal.tenant_id, params.sponsorId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, sponsorOrganization, eventPolicy };
    },
    handler: async ({ repos, principal, resources, body }) => {
      const dashboard = await buildSponsorDashboardResponse(
        repos,
        resources.sponsorOrganization,
        resources.event
      );
      const snapshot = await repos.reportSnapshots.create({
        id: nextId("report-snapshot"),
        tenant_id: resources.event.tenant_id,
        event_id: resources.event.id,
        report_snapshot_version: resources.event.report_snapshot_version,
        payload: {
          snapshot_type: "sponsor_dashboard",
          sponsor_id: resources.sponsorOrganization.id,
          sponsor_name: resources.sponsorOrganization.name,
          note: body.note ?? null,
          created_by_user_id: principal.user_id,
          dashboard
        },
        created_at: new Date().toISOString()
      });
      return {
        id: snapshot.id,
        event_id: snapshot.event_id,
        report_snapshot_version: snapshot.report_snapshot_version,
        created_at: snapshot.created_at,
        payload: snapshot.payload
      };
    },
    statusCode: 201,
    auditEventType: "sponsor.report_snapshot.created"
  });

  router.addRoute({
    id: "organizer-report-freeze-status",
    method: "GET",
    path: "/organizer/events/:eventId/report-freeze",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) =>
      buildReportFreezeStatus(repos, resources.event.tenant_id, resources.event),
    auditEventType: "organizer.report_freeze.view"
  });

  router.addRoute({
    id: "organizer-report-freeze-trigger",
    method: "POST",
    path: "/organizer/events/:eventId/report-freeze",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, principal, body }) =>
      repos.withTransaction(async (txRepos) => {
        const event = await txRepos.events.findById(resources.event.tenant_id, resources.event.id);
        const now = new Date().toISOString();
        const nextVersion = Number(event.report_snapshot_version ?? 0) + 1;
        const sponsorOrganizations = await listSponsorOrganizationsForEvent(txRepos, event.tenant_id, event.id);
        const sponsorSnapshots = [];
        for (const sponsorOrganization of sponsorOrganizations) {
          const dashboard = await buildSponsorDashboardResponse(txRepos, sponsorOrganization, event);
          const snapshot = await txRepos.reportSnapshots.create({
            id: nextId("report-snapshot"),
            tenant_id: event.tenant_id,
            event_id: event.id,
            report_snapshot_version: nextVersion,
            payload: {
              snapshot_type: "sponsor_dashboard",
              sponsor_id: sponsorOrganization.id,
              sponsor_name: sponsorOrganization.name,
              note: body.note ?? "Generated during official report freeze",
              created_by_user_id: principal.user_id,
              dashboard
            },
            created_at: now
          });
          sponsorSnapshots.push({
            id: snapshot.id,
            sponsor_id: sponsorOrganization.id,
            sponsor_name: sponsorOrganization.name,
            dashboard: snapshot.payload.dashboard
          });
        }

        const artifactFreezeChecks = await buildArtifactFreezeChecks(txRepos, event);
        const overview = await buildOrganizerOverviewPayload(txRepos, event);
        const freezeSnapshot = await txRepos.reportSnapshots.create({
          id: nextId("report-snapshot"),
          tenant_id: event.tenant_id,
          event_id: event.id,
          report_snapshot_version: nextVersion,
          payload: {
            snapshot_type: "official_event_report",
            note: body.note ?? null,
            created_by_user_id: principal.user_id,
            event_status_before_freeze: event.status,
            artifact_freeze_checks: artifactFreezeChecks,
            overview,
            sponsor_snapshots: sponsorSnapshots.map((entry) => ({
              id: entry.id,
              sponsor_id: entry.sponsor_id,
              sponsor_name: entry.sponsor_name,
              impressions: entry.dashboard.impressions,
              ctr: entry.dashboard.ctr,
              opted_in_leads: entry.dashboard.opted_in_leads
            }))
          },
          created_at: now
        });

        event.status = "closed";
        event.ends_at = event.ends_at ?? now;
        event.report_snapshot_version = nextVersion;
        await txRepos.events.update(event);

        const officialExportId = nextId("export");
        const exportRequest = await txRepos.exportRequests.create({
          id: officialExportId,
          tenant_id: event.tenant_id,
          event_id: event.id,
          requested_by_user_id: principal.user_id,
          requested_for_organization_id: principal.organization_id,
          export_type: "organizer_event_report",
          filters: {
            report_snapshot_id: freezeSnapshot.id,
            frozen: true
          },
          row_count_estimate: 1,
          status: "generated",
          approval_required: false,
          approved_by_user_id: principal.user_id,
          approval_reason: "Generated during official event close and report freeze",
          rejection_reason: null,
          file_url: exportDownloadPath({ id: officialExportId }),
          file_expires_at: inHours(24),
          created_at: now
        });

        return {
          event_id: event.id,
          status: "closed",
          report_snapshot_version: nextVersion,
          official_snapshot: {
            id: freezeSnapshot.id,
            created_at: freezeSnapshot.created_at
          },
          sponsor_snapshots: sponsorSnapshots.map((entry) => ({
            id: entry.id,
            sponsor_id: entry.sponsor_id,
            sponsor_name: entry.sponsor_name
          })),
          official_export: exportRequest,
          freeze_status: await buildReportFreezeStatus(txRepos, event.tenant_id, event)
        };
      }),
    auditEventType: "organizer.report_freeze.triggered"
  });

  router.addRoute({
    id: "organizer-overview",
    method: "GET",
    path: "/organizer/events/:eventId/overview",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => {
      const assignments = await repos.deviceAssignments.listByEvent(resources.event.tenant_id, resources.event.id);
      const latestHeartbeats = await Promise.all(
        assignments.map(async (assignment) => {
          const records = await repos.heartbeats.listByDevice(resources.event.tenant_id, assignment.device_id);
          return records.sort((left, right) => Date.parse(right.recorded_at) - Date.parse(left.recorded_at))[0] ?? null;
        })
      );
      const onlineDevices = latestHeartbeats.filter((entry) => isRecent(entry?.recorded_at, 120)).length;
      const queueDepths = latestHeartbeats.filter(Boolean).map((entry) => entry.local_queue_depth);
      const avgQueueDepth = queueDepths.length === 0 ? 0 : average(queueDepths);
      const relevantTapEvents = await repos.tapEvents.listByEvent(resources.event.tenant_id, resources.event.id);
      const syncLatencies = relevantTapEvents
        .filter((entry) => entry.cloud_received_at)
        .map((entry) => Date.parse(entry.cloud_received_at) - Date.parse(entry.occurred_at));
      const avgSyncLatencyMs = syncLatencies.length === 0 ? 0 : average(syncLatencies);
      const interactions = await repos.interactions.listByEvent(resources.event.tenant_id, resources.event.id);
      const incidents = await repos.incidents.listByEvent(resources.event.tenant_id, resources.event.id);
      return {
        event_id: resources.event.id,
        metrics_definition_version: resources.event.metrics_definition_version,
        report_snapshot_version: resources.event.report_snapshot_version,
        total_interactions: interactions.length,
        online_devices: onlineDevices,
        offline_devices: assignments.length - onlineDevices,
        average_queue_depth: Number(avgQueueDepth.toFixed(2)),
        average_sync_latency_ms: Number(avgSyncLatencyMs.toFixed(2)),
        open_incidents: incidents.filter((entry) => entry.status !== "resolved").length,
        top_stalls: await topStalls(repos, resources.event.tenant_id, resources.event.id),
        iot_integration: await buildIotIntegrationStatus(repos, resources.event.tenant_id, resources.event.id)
      };
    },
    auditEventType: "organizer.overview.view"
  });

  router.addRoute({
    id: "organizer-data-control",
    method: "GET",
    path: "/organizer/events/:eventId/data-control",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ resources }) => serializeEventDataControl(resources.event, resources.eventPolicy),
    auditEventType: "organizer.data_control.view"
  });

  router.addRoute({
    id: "organizer-data-control-update",
    method: "PUT",
    path: "/organizer/events/:eventId/data-control",
    allowedRoles: ["organizer_admin"],
    validate: validateEventDataControlInput,
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, body }) =>
      repos.withTransaction(async (txRepos) => {
        const now = new Date().toISOString();
        const savedPolicy = await txRepos.eventPolicies.upsert({
          ...resources.eventPolicy,
          event_id: resources.event.id,
          tenant_id: resources.event.tenant_id,
          vendor_exports_enabled: body.vendor_exports_enabled,
          sponsor_pii_enabled: body.sponsor_pii_enabled,
          require_export_approval: body.require_export_approval,
          allow_crm_push: body.allow_crm_push,
          retention_days: body.retention_days,
          allow_cross_event_identity_graph: body.allow_cross_event_identity_graph,
          created_at: resources.eventPolicy.missing_policy_row ? now : (resources.eventPolicy.created_at ?? now),
          updated_at: now
        });
        return serializeEventDataControl(resources.event, savedPolicy);
      }),
    auditEventType: "organizer.data_control.update"
  });

  router.addRoute({
    id: "organizer-event-publish",
    method: "POST",
    path: "/organizer/events/:eventId/publish",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const event = await txRepos.events.findById(resources.event.tenant_id, resources.event.id);
        const eventPolicy = await txRepos.eventPolicies.findByEventId(resources.event.tenant_id, resources.event.id);
        const publishReadiness = buildEventPublishReadiness(event, eventPolicy);
        if (!publishReadiness.ready) {
          throw new HttpError(409, "Event data-control policy must be confirmed before publishing", {
            blockers: publishReadiness.blockers,
            data_control: serializeEventDataControl(event, eventPolicy)
          });
        }
        if (event.status === "published") {
          return {
            event_id: event.id,
            status: event.status,
            data_control: serializeEventDataControl(event, eventPolicy)
          };
        }
        if (event.status !== "draft") {
          throw new HttpError(409, "Only draft events can be published from organizer data control");
        }
        event.status = "published";
        await txRepos.events.update(event);
        return {
          event_id: event.id,
          status: event.status,
          published_at: new Date().toISOString(),
          data_control: serializeEventDataControl(event, eventPolicy)
        };
      }),
    auditEventType: "organizer.event.publish"
  });

  router.addRoute({
    id: "organizer-compliance-overview",
    method: "GET",
    path: "/organizer/events/:eventId/compliance",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) =>
      buildComplianceOverview({
        repos,
        event: resources.event,
        eventPolicy: resources.eventPolicy
      }),
    auditEventType: "organizer.compliance.view"
  });

  router.addRoute({
    id: "organizer-compliance-report",
    method: "GET",
    path: "/organizer/events/:eventId/compliance/report",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) =>
      buildComplianceOperationalReport({
        repos,
        event: resources.event,
        eventPolicy: resources.eventPolicy
    }),
    auditEventType: "organizer.compliance_report.view"
  });

  router.addRoute({
    id: "organizer-compliance-closeout-readiness",
    method: "GET",
    path: "/organizer/events/:eventId/compliance/closeout-readiness",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => ({
      event_id: resources.event.id,
      readiness: await buildComplianceCloseoutReadiness(
        repos,
        resources.event,
        resources.eventPolicy
      )
    }),
    auditEventType: "organizer.compliance_closeout_readiness.view"
  });

  router.addRoute({
    id: "organizer-crm-sync-history",
    method: "GET",
    path: "/organizer/events/:eventId/crm-sync",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => {
      const records = await repos.crmSyncRecords.listByEvent(resources.event.tenant_id, resources.event.id);
      const items = [];
      for (const record of records) {
        const interaction = await repos.interactions.findById(resources.event.tenant_id, record.interaction_id);
        const stall = await repos.stalls.findById(resources.event.tenant_id, record.stall_id);
        const profile = interaction.attendee_id
          ? await repos.attendeeProfiles.findByAttendeeId(interaction.attendee_id)
          : null;
        items.push({
          id: record.id,
          interaction_id: record.interaction_id,
          stall_id: record.stall_id,
          stall_name: stall.name,
          provider: record.provider,
          status: record.status,
          external_record_id: record.external_record_id,
          synced_at: record.synced_at,
          deleted_at: record.deleted_at,
          updated_at: record.updated_at,
          last_error: record.last_error,
          request_payload: record.request_payload,
          response_payload: record.response_payload,
          full_name: profile?.full_name ?? null,
          company_name: profile?.company_name ?? null,
          classification: interaction.classification ?? "cold"
        });
      }
      return {
        event_id: resources.event.id,
        items
      };
    },
    auditEventType: "organizer.crm_sync.view"
  });

  router.addRoute({
    id: "organizer-compliance-audit-export",
    method: "POST",
    path: "/organizer/events/:eventId/compliance/audit-export",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, principal }) => {
      const exportId = nextId("export");
      const exportRequest = {
        id: exportId,
        tenant_id: resources.event.tenant_id,
        event_id: resources.event.id,
        requested_by_user_id: principal.user_id,
        requested_for_organization_id: principal.organization_id,
        export_type: "organizer_event_report",
        filters: {
          report_variant: "compliance_audit"
        },
        row_count_estimate: 1,
        status: resources.eventPolicy.require_export_approval ? "requested" : "generated",
        approval_required: resources.eventPolicy.require_export_approval,
        approved_by_user_id: null,
        approval_reason: null,
        rejection_reason: null,
        file_url: resources.eventPolicy.require_export_approval ? null : exportDownloadPath({ id: exportId }),
        file_expires_at: resources.eventPolicy.require_export_approval ? null : inHours(4),
        created_at: new Date().toISOString()
      };
      return repos.exportRequests.create(exportRequest);
    },
    auditEventType: "organizer.compliance_audit_export.requested"
  });

  router.addRoute({
    id: "organizer-dsr-list",
    method: "GET",
    path: "/organizer/events/:eventId/dsr",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => ({
      event_id: resources.event.id,
      items: await listDataSubjectRequestsForEvent({
        repos,
        event: resources.event
      })
    }),
    auditEventType: "organizer.dsr.view"
  });

  router.addRoute({
    id: "organizer-dsr-create",
    method: "POST",
    path: "/organizer/events/:eventId/dsr",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      required(body, ["request_type"]);
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, principal, body }) =>
      createDataSubjectRequest({
        repos,
        event: resources.event,
        principal,
        body
      }),
    statusCode: 201,
    auditEventType: "organizer.dsr.created"
  });

  router.addRoute({
    id: "organizer-dsr-complete",
    method: "POST",
    path: "/organizer/events/:eventId/dsr/:requestId/complete",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      const dsrRequest = await repos.dataSubjectRequests.findById(principal.tenant_id, params.requestId);
      if (dsrRequest.event_id !== event.id) {
        throw new HttpError(404, "Data-subject request not found for this event");
      }
      return { event, eventPolicy, dsrRequest };
    },
    handler: async ({ repos, resources, principal, body }) =>
      repos.withTransaction(async (txRepos) =>
        completeDataSubjectRequest({
          repos: txRepos,
          event: resources.event,
          eventPolicy: resources.eventPolicy,
          principal,
          request: resources.dsrRequest,
          body
        })
      ),
    auditEventType: "organizer.dsr.completed"
  });

  router.addRoute({
    id: "organizer-downstream-deletion-confirm",
    method: "POST",
    path: "/organizer/events/:eventId/downstream-deletions/:recordId",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      required(body, ["status"]);
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      const downstreamDeletionRecord = await repos.downstreamDeletionRecords.findById(principal.tenant_id, params.recordId);
      if (downstreamDeletionRecord.event_id !== event.id) {
        throw new HttpError(404, "Downstream deletion record not found for this event");
      }
      return { event, eventPolicy, downstreamDeletionRecord };
    },
    handler: async ({ repos, resources, body }) =>
      confirmDownstreamDeletionRecord({
        repos,
        record: resources.downstreamDeletionRecord,
        body
      }),
    auditEventType: "organizer.downstream_deletion.updated"
  });

  router.addRoute({
    id: "organizer-downstream-deletion-dispatch",
    method: "POST",
    path: "/organizer/events/:eventId/downstream-deletions/:recordId/dispatch",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      const downstreamDeletionRecord = await repos.downstreamDeletionRecords.findById(principal.tenant_id, params.recordId);
      if (downstreamDeletionRecord.event_id !== event.id) {
        throw new HttpError(404, "Downstream deletion record not found for this event");
      }
      return { event, eventPolicy, downstreamDeletionRecord };
    },
    handler: async ({ repos, resources, principal }) =>
      repos.withTransaction(async (txRepos) =>
        dispatchDownstreamDeletion({
          repos: txRepos,
          record: resources.downstreamDeletionRecord,
          principal
        })
      ),
    auditEventType: "organizer.downstream_deletion.dispatched"
  });

  router.addRoute({
    id: "organizer-retention-run",
    method: "POST",
    path: "/organizer/events/:eventId/compliance/retention",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, principal, body }) =>
      repos.withTransaction(async (txRepos) =>
        runRetentionLifecycle({
          repos: txRepos,
          event: resources.event,
          eventPolicy: resources.eventPolicy,
          principal,
          body
        })
      ),
    auditEventType: "organizer.retention.run"
  });

  router.addRoute({
    id: "organizer-device-fleet",
    method: "GET",
    path: "/organizer/events/:eventId/device-fleet",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => {
      const assignments = await repos.deviceAssignments.listByEvent(resources.event.tenant_id, resources.event.id);
      const snapshots = await repos.iotDeviceStatusSnapshots.listByEvent(resources.event.tenant_id, resources.event.id);
      const snapshotByDeviceId = new Map(snapshots.map((entry) => [entry.device_id, entry]));

      const items = await Promise.all(
        assignments.map(async (assignment) => {
          const device = await repos.devices.findById(resources.event.tenant_id, assignment.device_id);
          const snapshot = snapshotByDeviceId.get(assignment.device_id) ?? null;
          return {
            device_id: device.id,
            serial_number: device.serial_number,
            platform_assignment: {
              event_id: assignment.event_id,
              stall_id: assignment.stall_id,
              assignment_checksum: assignment.assignment_checksum
            },
            iot_assignment: snapshot
              ? {
                  event_id: snapshot.iot_event_id,
                  stall_id: snapshot.iot_stall_id,
                  assignment_checksum: snapshot.iot_assignment_checksum,
                  lease_expires_at: snapshot.lease_expires_at
                }
              : null,
            assignment_status: snapshot?.assignment_status ?? "unknown",
            diagnostics_status: snapshot?.diagnostics_status ?? "unknown",
            connectivity_status: snapshot?.connectivity_status ?? null,
            reader_status: snapshot?.reader_status ?? null,
            app_version: snapshot?.app_version ?? null,
            firmware_version: snapshot?.firmware_version ?? null,
            local_queue_depth: snapshot?.local_queue_depth ?? null,
            last_heartbeat_at: snapshot?.last_heartbeat_at ?? null,
            open_incident: snapshot?.open_incident_code
              ? {
                  code: snapshot.open_incident_code,
                  status: snapshot.open_incident_status,
                  severity: snapshot.open_incident_severity
                }
              : null,
            checked_at: snapshot?.checked_at ?? null,
            metadata: snapshot?.metadata ?? {}
          };
        })
      );

      return {
        event_id: resources.event.id,
        items: items.sort((left, right) => left.device_id.localeCompare(right.device_id))
      };
    },
    auditEventType: "organizer.device_fleet.view"
  });

  router.addRoute({
    id: "organizer-incidents-list",
    method: "GET",
    path: "/organizer/events/:eventId/incidents",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const incidents = await repos.incidents.listByEvent(resources.event.tenant_id, resources.event.id);
      const alerts = await repos.iotAlertEvents.listByEvent(resources.event.tenant_id, resources.event.id, {
        limit: 200
      });
      const filtered = incidents.filter((incident) =>
        matchesIncidentFilters(incident, {
          severity: query.severity ?? null,
          status: query.status ?? null,
          deviceId: query.device_id ?? null,
          stallId: query.stall_id ?? null,
          area: query.area ?? null,
          recentHours: query.recent_hours ?? null
        })
      );

      const items = await Promise.all(
        filtered.map(async (incident) => buildIncidentSummary(
          repos,
          resources.event.tenant_id,
          resources.event.id,
          incident,
          alerts
        ))
      );

      return {
        event_id: resources.event.id,
        filters: {
          severity: query.severity ?? null,
          status: query.status ?? null,
          device_id: query.device_id ?? null,
          stall_id: query.stall_id ?? null,
          area: query.area ?? null,
          recent_hours: query.recent_hours ?? null
        },
        items
      };
    },
    auditEventType: "organizer.incidents.view"
  });

  router.addRoute({
    id: "organizer-incident-detail",
    method: "GET",
    path: "/organizer/events/:eventId/incidents/:incidentId",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      const incident = await resolveIncidentForEvent(repos, principal.tenant_id, event.id, params.incidentId);
      return { event, eventPolicy, incident };
    },
    handler: async ({ repos, resources }) => {
      return buildIncidentInvestigation(
        repos,
        resources.event.tenant_id,
        resources.event.id,
        resources.incident
      );
    },
    auditEventType: "organizer.incident_detail.view"
  });

  router.addRoute({
    id: "organizer-incident-annotation",
    method: "POST",
    path: "/organizer/events/:eventId/incidents/:incidentId/annotations",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      required(body, ["note"]);
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      const incident = await resolveIncidentForEvent(repos, principal.tenant_id, event.id, params.incidentId);
      return { event, eventPolicy, incident };
    },
    handler: async ({ repos, principal, resources, body }) => {
      const incident = resources.incident;
      appendIncidentMetadataEntry(incident, "annotations", {
        id: nextId("incident-note"),
        author_user_id: principal.user_id,
        note: body.note,
        action_type: body.action_type ?? "note",
        created_at: new Date().toISOString()
      });
      await repos.incidents.update(incident);
      return {
        incident_id: incident.id,
        annotations: incident.metadata.annotations
      };
    },
    auditEventType: "organizer.incident_annotation.created"
  });

  router.addRoute({
    id: "organizer-incident-state",
    method: "POST",
    path: "/organizer/events/:eventId/incidents/:incidentId/state",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      required(body, ["action"]);
      if (!["escalate", "resolve"].includes(body.action)) {
        throw new HttpError(400, "action must be one of: escalate, resolve");
      }
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      const incident = await resolveIncidentForEvent(repos, principal.tenant_id, event.id, params.incidentId);
      return { event, eventPolicy, incident };
    },
    handler: async ({ repos, principal, resources, body }) => {
      const incident = resources.incident;
      const now = new Date().toISOString();
      const previousStatus = incident.status;

      if (body.action === "escalate") {
        incident.status = "escalated";
        incident.resolved_at = null;
        if (body.severity) {
          incident.severity = body.severity;
        }
      } else {
        incident.status = "resolved";
        incident.resolved_at = now;
      }

      appendIncidentMetadataEntry(incident, "state_history", {
        id: nextId("incident-state"),
        actor_user_id: principal.user_id,
        action: body.action,
        previous_status: previousStatus,
        next_status: incident.status,
        note: body.note ?? null,
        severity: incident.severity,
        created_at: now
      });
      appendIncidentMetadataEntry(incident, "annotations", {
        id: nextId("incident-note"),
        author_user_id: principal.user_id,
        note: body.note ?? (body.action === "escalate"
          ? "Organizer escalated the incident."
          : "Organizer resolved the incident."),
        action_type: body.action === "escalate" ? "escalation" : "resolution",
        created_at: now
      });

      await repos.incidents.update(incident);
      return buildIncidentInvestigation(
        repos,
        resources.event.tenant_id,
        resources.event.id,
        incident
      );
    },
    auditEventType: "organizer.incident_state.updated"
  });

  router.addRoute({
    id: "organizer-incident-runbook",
    method: "POST",
    path: "/organizer/events/:eventId/incidents/:incidentId/runbook",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      if (!body || typeof body !== "object") {
        throw new HttpError(400, "Request body is required");
      }
      if (![
        body.runbook_reference,
        body.workaround_status,
        body.workaround_summary,
        body.next_action,
        body.note
      ].some(Boolean)) {
        throw new HttpError(400, "At least one runbook or workaround field is required");
      }
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      const incident = await resolveIncidentForEvent(repos, principal.tenant_id, event.id, params.incidentId);
      return { event, eventPolicy, incident };
    },
    handler: async ({ repos, principal, resources, body }) => {
      const incident = resources.incident;
      const now = new Date().toISOString();
      const tracking = {
        ...(incident.metadata?.runbook_tracking ?? {}),
        runbook_reference: body.runbook_reference ?? incident.metadata?.runbook_tracking?.runbook_reference ?? null,
        workaround_status: body.workaround_status ?? incident.metadata?.runbook_tracking?.workaround_status ?? null,
        workaround_summary: body.workaround_summary ?? incident.metadata?.runbook_tracking?.workaround_summary ?? null,
        next_action: body.next_action ?? incident.metadata?.runbook_tracking?.next_action ?? null,
        updated_by_user_id: principal.user_id,
        updated_at: now
      };

      incident.metadata = {
        ...(incident.metadata ?? {}),
        runbook_tracking: tracking
      };

      const note = body.note ?? buildRunbookUpdateNote(tracking);
      appendIncidentMetadataEntry(incident, "runbook_updates", {
        id: nextId("incident-runbook"),
        author_user_id: principal.user_id,
        note,
        runbook_reference: tracking.runbook_reference,
        workaround_status: tracking.workaround_status,
        workaround_summary: tracking.workaround_summary,
        next_action: tracking.next_action,
        created_at: now
      });
      appendIncidentMetadataEntry(incident, "annotations", {
        id: nextId("incident-note"),
        author_user_id: principal.user_id,
        note,
        action_type: "runbook_update",
        created_at: now
      });

      await repos.incidents.update(incident);
      return buildIncidentInvestigation(
        repos,
        resources.event.tenant_id,
        resources.event.id,
        incident
      );
    },
    auditEventType: "organizer.incident_runbook.updated"
  });

  router.addRoute({
    id: "organizer-device-history",
    method: "GET",
    path: "/organizer/events/:eventId/devices/:deviceId/history",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, params, query }) => {
      const limit = Number(query.limit ?? 10);
      const heartbeats = await repos.heartbeats.listByDevice(resources.event.tenant_id, params.deviceId);
      const incidents = await repos.incidents.listByDevice(resources.event.tenant_id, params.deviceId);
      return {
        event_id: resources.event.id,
        device_id: params.deviceId,
        heartbeats: heartbeats
          .filter((entry) => entry.event_id === resources.event.id)
          .slice(0, limit),
        incidents: incidents
          .filter((entry) => entry.event_id === resources.event.id)
          .slice(0, limit)
      };
    },
    auditEventType: "organizer.device_history.view"
  });

  router.addRoute({
    id: "organizer-iot-health",
    method: "GET",
    path: "/organizer/events/:eventId/iot-health",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => ({
      event_id: resources.event.id,
      iot_integration: await buildIotIntegrationStatus(repos, resources.event.tenant_id, resources.event.id)
    }),
    auditEventType: "organizer.iot_health.view"
  });

  router.addRoute({
    id: "organizer-iot-go-live-readiness",
    method: "GET",
    path: "/organizer/events/:eventId/iot-go-live-readiness",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => {
      const iotIntegration = await buildIotIntegrationStatus(
        repos,
        resources.event.tenant_id,
        resources.event.id
      );
      return {
        event_id: resources.event.id,
        readiness: buildGoLiveReadiness(resources.event.id, iotIntegration)
      };
    },
    auditEventType: "organizer.iot_go_live_readiness.view"
  });

  router.addRoute({
    id: "organizer-pilot-rehearsal-report",
    method: "GET",
    path: "/organizer/events/:eventId/pilot-rehearsal-report",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => ({
      event_id: resources.event.id,
      rehearsal: await buildPilotRehearsalReport(repos, resources.event, resources.eventPolicy)
    }),
    auditEventType: "organizer.pilot_rehearsal_report.view"
  });

  router.addRoute({
    id: "organizer-pilot-signoff-pack",
    method: "GET",
    path: "/organizer/events/:eventId/pilot-signoff-pack",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => ({
      event_id: resources.event.id,
      signoff: await buildPilotSignoffPack(repos, resources.event, resources.eventPolicy)
    }),
    auditEventType: "organizer.pilot_signoff_pack.view"
  });

  router.addRoute({
    id: "organizer-pilot-signoff-export",
    method: "POST",
    path: "/organizer/events/:eventId/pilot-signoff-export",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, principal }) => {
      const exportId = nextId("export");
      const exportRequest = {
        id: exportId,
        tenant_id: resources.event.tenant_id,
        event_id: resources.event.id,
        requested_by_user_id: principal.user_id,
        requested_for_organization_id: principal.organization_id,
        export_type: "organizer_event_report",
        filters: {
          report_variant: "pilot_signoff"
        },
        row_count_estimate: 1,
        status: resources.eventPolicy.require_export_approval ? "requested" : "generated",
        approval_required: resources.eventPolicy.require_export_approval,
        approved_by_user_id: null,
        approval_reason: null,
        rejection_reason: null,
        file_url: resources.eventPolicy.require_export_approval ? null : exportDownloadPath({ id: exportId }),
        file_expires_at: resources.eventPolicy.require_export_approval ? null : inHours(4),
        created_at: new Date().toISOString()
      };
      return repos.exportRequests.create(exportRequest);
    },
    auditEventType: "organizer.pilot_signoff_export.requested"
  });

  router.addRoute({
    id: "organizer-pilot-go-live-execution",
    method: "GET",
    path: "/organizer/events/:eventId/pilot-go-live-execution",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => ({
      event_id: resources.event.id,
      execution: await buildPilotGoLiveExecution(repos, resources.event, resources.eventPolicy)
    }),
    auditEventType: "organizer.pilot_go_live_execution.view"
  });

  router.addRoute({
    id: "organizer-pilot-go-live-dry-run",
    method: "POST",
    path: "/organizer/events/:eventId/pilot-go-live-dry-run",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      if (!body || typeof body !== "object") {
        throw new HttpError(400, "Request body is required");
      }
      if (!body.status) {
        throw new HttpError(400, "Dry-run status is required");
      }
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, principal, body }) => {
      const now = new Date().toISOString();
      const blockers = Array.isArray(body.blockers)
        ? body.blockers.filter(Boolean)
        : String(body.blockers ?? "")
            .split("\n")
            .map((entry) => entry.trim())
            .filter(Boolean);
      return repos.pilotDryRunRecords.create({
        id: nextId("pilot-dry-run"),
        tenant_id: resources.event.tenant_id,
        event_id: resources.event.id,
        execution_type: "staging_go_live_dry_run",
        status: body.status,
        executed_by_user_id: principal.user_id,
        summary: body.summary ?? {},
        blockers,
        note: body.note ?? null,
        started_at: body.started_at ?? now,
        finished_at: body.finished_at ?? (body.status === "completed" || body.status === "failed" ? now : null),
        created_at: now,
        updated_at: now
      });
    },
    auditEventType: "organizer.pilot_go_live_dry_run.recorded"
  });

  router.addRoute({
    id: "organizer-pilot-go-live-approval",
    method: "POST",
    path: "/organizer/events/:eventId/pilot-go-live-approvals",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      if (!body || typeof body !== "object") {
        throw new HttpError(400, "Request body is required");
      }
      required(body, ["approver_role", "approver_label", "approval_status"]);
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, principal, body }) => {
      const now = new Date().toISOString();
      return repos.pilotSignoffApprovals.upsert({
        id: nextId("pilot-signoff-approval"),
        tenant_id: resources.event.tenant_id,
        event_id: resources.event.id,
        approver_role: body.approver_role,
        approver_label: body.approver_label,
        approver_user_id: body.approver_role === "organizer" ? principal.user_id : null,
        approval_status: body.approval_status,
        note: body.note ?? null,
        approved_at: body.approval_status === "approved" ? now : null,
        created_at: now,
        updated_at: now
      });
    },
    auditEventType: "organizer.pilot_go_live_approval.recorded"
  });

  router.addRoute({
    id: "organizer-iot-runs",
    method: "GET",
    path: "/organizer/events/:eventId/iot-runs",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const limit = Number(query.limit ?? 20);
      const runs = await repos.iotIntegrationRuns.listByEvent(resources.event.tenant_id, resources.event.id, {
        limit
      });
      return {
        event_id: resources.event.id,
        items: runs.map(formatIntegrationRun)
      };
    },
    auditEventType: "organizer.iot_runs.view"
  });

  router.addRoute({
    id: "organizer-iot-alerts",
    method: "GET",
    path: "/organizer/events/:eventId/iot-alerts",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources, query }) => {
      const limit = Number(query.limit ?? 20);
      const status = query.status ?? null;
      const items = await repos.iotAlertEvents.listByEvent(resources.event.tenant_id, resources.event.id, {
        limit,
        status
      });
      return {
        event_id: resources.event.id,
        open_count: await repos.iotAlertEvents.countOpenByEvent(resources.event.tenant_id, resources.event.id),
        items: items.map(formatAlertEvent)
      };
    },
    auditEventType: "organizer.iot_alerts.view"
  });

  router.addRoute({
    id: "organizer-iot-runs-trigger",
    method: "POST",
    path: "/organizer/events/:eventId/iot-runs/trigger",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ state, repos, resources, principal }) => {
      const orchestrator = state.iotOperations?.orchestrator;
      if (!orchestrator) {
        throw new HttpError(503, "IoT integration orchestrator is not configured");
      }
      const run = await orchestrator.runForEvent({
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id,
        triggerMode: "manual",
        initiatedBy: principal.user_id ?? principal.actor_id
      });
      return {
        event_id: resources.event.id,
        run: formatIntegrationRun(run),
        iot_integration: await buildIotIntegrationStatus(repos, resources.event.tenant_id, resources.event.id)
      };
    },
    auditEventType: "organizer.iot_runs.triggered"
  });

  router.addRoute({
    id: "organizer-iot-parity-trigger",
    method: "POST",
    path: "/organizer/events/:eventId/iot-parity/trigger",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ state, repos, resources }) => {
      const parityRunner = state.iotOperations?.parityRunner;
      const alertRouter = state.iotOperations?.alertRouter ?? null;
      if (!parityRunner) {
        throw new HttpError(503, "IoT environment parity runner is not configured");
      }
      const parity = await parityRunner.runForEvent({
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id
      });
      if (alertRouter) {
        await alertRouter.routeForEventState({
          tenantId: resources.event.tenant_id,
          eventId: resources.event.id,
          parity
        });
      }
      return {
        event_id: resources.event.id,
        parity: formatParityStatus(parity),
        iot_integration: await buildIotIntegrationStatus(repos, resources.event.tenant_id, resources.event.id)
      };
    },
    auditEventType: "organizer.iot_parity.triggered"
  });

  router.addRoute({
    id: "admin-iot-runs-trigger",
    method: "POST",
    path: "/admin/events/:eventId/iot-runs/trigger",
    allowedRoles: ["platform_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ state, repos, resources, principal }) => {
      const orchestrator = state.iotOperations?.orchestrator;
      if (!orchestrator) {
        throw new HttpError(503, "IoT integration orchestrator is not configured");
      }
      const run = await orchestrator.runForEvent({
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id,
        triggerMode: "manual",
        initiatedBy: principal.user_id ?? principal.actor_id
      });
      return {
        event_id: resources.event.id,
        run: formatIntegrationRun(run),
        iot_integration: await buildIotIntegrationStatus(repos, resources.event.tenant_id, resources.event.id)
      };
    },
    auditEventType: "admin.iot_runs.triggered"
  });

  router.addRoute({
    id: "admin-iot-cleanup-trigger",
    method: "POST",
    path: "/admin/events/:eventId/iot-cleanup/trigger",
    allowedRoles: ["platform_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ state, resources }) => {
      const retentionManager = state.iotOperations?.retentionManager;
      if (!retentionManager) {
        throw new HttpError(503, "IoT retention manager is not configured");
      }
      return retentionManager.cleanupEventData({
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id
      });
    },
    auditEventType: "admin.iot_cleanup.triggered"
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 9 — Tenant Management API (Platform Admin only)
  // ─────────────────────────────────────────────────────────────────────────

  router.addRoute({
    id: "admin-tenants-list",
    method: "GET",
    path: "/admin/tenants",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos }) => {
      const tenants = await repos.tenants.listAll();
      const enriched = await Promise.all(
        tenants.map(async (tenant) => {
          const [orgs, users, events] = await Promise.all([
            repos.organizations.listByTenant(tenant.id),
            repos.users.listByTenant(tenant.id),
            repos.events.listByTenant(tenant.id)
          ]);
          return {
            id: tenant.id,
            name: tenant.name,
            slug: tenant.slug,
            status: tenant.status ?? "active",
            created_at: tenant.created_at,
            org_count: orgs.length,
            user_count: users.length,
            active_event_count: events.filter((e) => e.status === "live").length
          };
        })
      );
      return { items: enriched };
    },
    auditEventType: "admin.tenants.list"
  });

  router.addRoute({
    id: "admin-tenants-create",
    method: "POST",
    path: "/admin/tenants",
    allowedRoles: ["platform_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, repos }) => {
      const { name, slug } = body;
      if (!name || typeof name !== "string" || name.trim().length < 2) {
        throw new HttpError(400, "name is required (min 2 characters)");
      }
      if (!slug || typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
        throw new HttpError(400, "slug is required and must be lowercase alphanumeric with hyphens");
      }
      const existing = await repos.tenants.findBySlug(slug);
      if (existing) {
        throw new HttpError(409, "Slug already in use");
      }
      const now = new Date().toISOString();
      const tenant = await repos.tenants.create({
        id: nextId("tenant"),
        name: name.trim(),
        slug,
        status: "active",
        created_at: now,
        updated_at: now
      });
      return { tenant };
    },
    auditEventType: "admin.tenant.created"
  });

  router.addRoute({
    id: "admin-tenants-get",
    method: "GET",
    path: "/admin/tenants/:tenantId",
    allowedRoles: ["platform_admin"],
    handler: async ({ params, repos }) => {
      const tenant = await repos.tenants.findById(params.tenantId);
      const [orgs, users, events] = await Promise.all([
        repos.organizations.listByTenant(tenant.id),
        repos.users.listByTenant(tenant.id),
        repos.events.listByTenant(tenant.id)
      ]);
      const activeEvents = events.filter((e) => e.status === "live");
      return {
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status ?? "active",
          created_at: tenant.created_at
        },
        stats: {
          org_count: orgs.length,
          user_count: users.length,
          event_count: events.length,
          active_event_count: activeEvents.length
        }
      };
    },
    auditEventType: "admin.tenant.view"
  });

  router.addRoute({
    id: "admin-tenants-patch",
    method: "PATCH",
    path: "/admin/tenants/:tenantId",
    allowedRoles: ["platform_admin"],
    validate: (body) => body ?? {},
    handler: async ({ params, body, repos }) => {
      const tenant = await repos.tenants.findById(params.tenantId);
      const updates = {};
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || body.name.trim().length < 2) {
          throw new HttpError(400, "name must be at least 2 characters");
        }
        updates.name = body.name.trim();
      }
      if (body.status !== undefined) {
        if (!["active", "suspended"].includes(body.status)) {
          throw new HttpError(400, "status must be active or suspended");
        }
        updates.status = body.status;
      }
      const updated = await repos.tenants.update({ ...tenant, ...updates, updated_at: new Date().toISOString() });
      return { tenant: updated };
    },
    auditEventType: "admin.tenant.updated"
  });

  router.addRoute({
    id: "admin-reference-data",
    method: "GET",
    path: "/admin/reference-data",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, tenantId }) => {
      const [organizations, events, stalls] = await Promise.all([
        repos.organizations.listByTenant(tenantId),
        repos.events.listByTenant(tenantId),
        repos.stalls.listByTenant(tenantId)
      ]);

      return {
        roles: ["platform_admin", "organizer_admin", "vendor_manager", "sponsor_user", "ops_user"],
        user_statuses: ["pending_invite", "active", "disabled", "suspended", "deleted"],
        organizations: organizations.map(formatOrganizationSummary),
        events: events.map(formatEventSummary),
        stalls: stalls.map(formatStallSummary)
      };
    },
    auditEventType: "admin.reference_data.view"
  });

  router.addRoute({
    id: "admin-access-control-matrix",
    method: "GET",
    path: "/admin/access-control-matrix",
    allowedRoles: ["platform_admin"],
    handler: async () => ({
      items: listAccessControlMatrix()
    }),
    auditEventType: "admin.access_control_matrix.view"
  });

  router.addRoute({
    id: "admin-security-readiness",
    method: "GET",
    path: "/admin/security/readiness",
    allowedRoles: ["platform_admin"],
    handler: async (ctx) => buildSecurityReadiness(ctx),
    auditEventType: "admin.security_readiness.view"
  });

  router.addRoute({
    id: "admin-security-alerts",
    method: "GET",
    path: "/admin/security/alerts",
    allowedRoles: ["platform_admin"],
    handler: async (ctx) => {
      const [auditLogs, breakGlassRequests, users, pentestFindings, notificationDeadLetterSummary] = await Promise.all([
        ctx.repos.auditLogs.listByTenant(ctx.tenantId),
        ctx.repos.breakGlassAccess.listByTenant(ctx.tenantId),
        ctx.repos.users.listByTenant(ctx.tenantId),
        ctx.repos.pentestFindings.listByTenant(ctx.tenantId),
        buildNotificationDeadLetterSummary(ctx.repos, ctx.tenantId, ctx.env)
      ]);
      const readiness = buildSecurityReadiness(ctx);
      return buildSecurityAlerts({
        readiness,
        auditLogs,
        breakGlassRequests,
        users,
        pentestFindings,
        notificationProviderReadiness: buildNotificationChannelsReadiness(ctx.env),
        notificationWorkerSchedule: resolveNotificationWorkerSchedule(ctx.env),
        notificationDeadLetterSummary
      });
    },
    auditEventType: "admin.security_alerts.view"
  });

  router.addRoute({
    id: "admin-security-pentest-pack",
    method: "GET",
    path: "/admin/security/pentest-pack",
    allowedRoles: ["platform_admin"],
    handler: async (ctx) => {
      const [auditLogs, breakGlassRequests, users, pentestFindings, notificationDeadLetterSummary] = await Promise.all([
        ctx.repos.auditLogs.listByTenant(ctx.tenantId),
        ctx.repos.breakGlassAccess.listByTenant(ctx.tenantId),
        ctx.repos.users.listByTenant(ctx.tenantId),
        ctx.repos.pentestFindings.listByTenant(ctx.tenantId),
        buildNotificationDeadLetterSummary(ctx.repos, ctx.tenantId, ctx.env)
      ]);
      const accessControlMatrix = listAccessControlMatrix();
      const readiness = buildSecurityReadiness(ctx);
      const alerts = buildSecurityAlerts({
        readiness,
        auditLogs,
        breakGlassRequests,
        users,
        pentestFindings,
        notificationProviderReadiness: buildNotificationChannelsReadiness(ctx.env),
        notificationWorkerSchedule: resolveNotificationWorkerSchedule(ctx.env),
        notificationDeadLetterSummary
      });
      return buildPentestEvidencePack({
        readiness,
        alerts,
        accessControlMatrix,
        auditLogs: [...auditLogs].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at)),
        pentestFindings,
        attackSurface: buildAttackSurfaceReport({
          accessControlMatrix,
          routes: ctx.router?.routes ?? []
        })
      });
    },
    auditEventType: "admin.security_pentest_pack.export"
  });

  router.addRoute({
    id: "admin-pentest-attack-surface",
    method: "GET",
    path: "/admin/security/pentest/attack-surface",
    allowedRoles: ["platform_admin"],
    handler: async ({ router: routeRegistry }) => buildAttackSurfaceReport({
      accessControlMatrix: listAccessControlMatrix(),
      routes: routeRegistry.routes
    }),
    auditEventType: "admin.security_pentest_attack_surface.view"
  });

  router.addRoute({
    id: "admin-pentest-findings-list",
    method: "GET",
    path: "/admin/security/pentest/findings",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, tenantId }) => {
      const items = await repos.pentestFindings.listByTenant(tenantId);
      return {
        summary: summarizePentestFindings(items),
        items
      };
    },
    auditEventType: "admin.security_pentest_findings.view"
  });

  router.addRoute({
    id: "admin-pentest-finding-create",
    method: "POST",
    path: "/admin/security/pentest/findings",
    allowedRoles: ["platform_admin"],
    validate: validatePentestFindingCreateBody,
    handler: async ({ repos, tenantId, principal, body }) => {
      const now = new Date().toISOString();
      const finding = await repos.pentestFindings.create({
        id: nextId("pentest-finding"),
        tenant_id: tenantId,
        source: body.source ?? "external_pentest",
        title: body.title,
        severity: body.severity,
        category: body.category ?? "general",
        status: body.status ?? "open",
        affected_area: body.affected_area ?? null,
        description: body.description ?? null,
        evidence: body.evidence ?? {},
        remediation_plan: body.remediation_plan ?? null,
        owner_user_id: body.owner_user_id ?? null,
        due_at: body.due_at ?? null,
        resolved_at: null,
        accepted_risk_reason: null,
        created_by_user_id: principal.user_id,
        updated_by_user_id: principal.user_id,
        created_at: now,
        updated_at: now
      });
      return { item: finding };
    },
    statusCode: 201,
    auditEventType: "admin.security_pentest_finding.created"
  });

  router.addRoute({
    id: "admin-pentest-finding-update",
    method: "PATCH",
    path: "/admin/security/pentest/findings/:findingId",
    allowedRoles: ["platform_admin"],
    validate: validatePentestFindingUpdateBody,
    resolveResources: async ({ repos, principal, params }) => ({
      pentestFinding: await repos.pentestFindings.findById(principal.tenant_id, params.findingId)
    }),
    handler: async ({ repos, principal, resources, body }) => {
      const nextStatus = body.status ?? resources.pentestFinding.status;
      const now = new Date().toISOString();
      const finding = await repos.pentestFindings.update({
        ...resources.pentestFinding,
        source: body.source ?? resources.pentestFinding.source,
        title: body.title ?? resources.pentestFinding.title,
        severity: body.severity ?? resources.pentestFinding.severity,
        category: body.category ?? resources.pentestFinding.category,
        status: nextStatus,
        affected_area: body.affected_area ?? resources.pentestFinding.affected_area,
        description: body.description ?? resources.pentestFinding.description,
        evidence: body.evidence ?? resources.pentestFinding.evidence ?? {},
        remediation_plan: body.remediation_plan ?? resources.pentestFinding.remediation_plan,
        owner_user_id: body.owner_user_id ?? resources.pentestFinding.owner_user_id,
        due_at: body.due_at ?? resources.pentestFinding.due_at,
        resolved_at: ["remediated", "accepted_risk", "false_positive"].includes(nextStatus)
          ? body.resolved_at ?? resources.pentestFinding.resolved_at ?? now
          : null,
        accepted_risk_reason: body.accepted_risk_reason ?? resources.pentestFinding.accepted_risk_reason,
        updated_by_user_id: principal.user_id,
        updated_at: now
      });
      return { item: finding };
    },
    auditEventType: "admin.security_pentest_finding.updated"
  });

  router.addRoute({
    id: "admin-deployment-readiness",
    method: "GET",
    path: "/admin/deployment/readiness",
    allowedRoles: ["platform_admin"],
    handler: async (ctx) => buildDeploymentReadiness(ctx),
    auditEventType: "admin.deployment_readiness.view"
  });

  router.addRoute({
    id: "admin-final-go-live-package",
    method: "GET",
    path: "/admin/events/:eventId/final-go-live",
    allowedRoles: ["platform_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async (ctx) => ({
      launch: await buildFinalGoLivePackage(ctx, ctx.resources.event, ctx.resources.eventPolicy)
    }),
    auditEventType: "admin.final_go_live.view"
  });

  router.addRoute({
    id: "admin-final-go-live-approval",
    method: "POST",
    path: "/admin/events/:eventId/final-go-live/approvals",
    allowedRoles: ["platform_admin"],
    validate: validateFinalLaunchApprovalBody,
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, principal, body, resources }) => {
      const now = new Date().toISOString();
      const approval = await repos.finalLaunchApprovals.upsert({
        id: nextId("final-launch-approval"),
        tenant_id: resources.event.tenant_id,
        event_id: resources.event.id,
        approver_role: body.approver_role,
        approver_label: body.approver_label,
        approver_user_id: principal.user_id,
        approval_status: body.approval_status,
        note: body.note ?? null,
        approved_at: body.approval_status === "approved" ? now : null,
        created_at: now,
        updated_at: now
      });
      return { item: approval };
    },
    auditEventType: "admin.final_go_live_approval.recorded"
  });

  router.addRoute({
    id: "admin-final-go-live-export",
    method: "POST",
    path: "/admin/events/:eventId/final-go-live/export",
    allowedRoles: ["platform_admin"],
    validate: (body) => body ?? {},
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async (ctx) => {
      const launch = await buildFinalGoLivePackage(ctx, ctx.resources.event, ctx.resources.eventPolicy);
      return {
        file_name: `event-${ctx.resources.event.id}-final-go-live-package.json`,
        generated_at: new Date().toISOString(),
        payload: launch
      };
    },
    auditEventType: "admin.final_go_live_export.generated"
  });

  router.addRoute({
    id: "admin-users-list",
    method: "GET",
    path: "/admin/users",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, tenantId }) => {
      const [users, organizations, events, stalls] = await Promise.all([
        repos.users.listByTenant(tenantId),
        repos.organizations.listByTenant(tenantId),
        repos.events.listByTenant(tenantId),
        repos.stalls.listByTenant(tenantId)
      ]);
      const lookups = buildAdminReferenceLookups({ organizations, events, stalls });
      const accessScopesByUserId = new Map();

      await Promise.all(
        users.map(async (user) => {
          accessScopesByUserId.set(user.id, await repos.userAccessScopes.listByUser(tenantId, user.id));
        })
      );

      return {
        items: users
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
          .map((user) =>
            formatManagedUser(user, {
              organization: lookups.organizations.get(user.organization_id) ?? null,
              accessScopes: accessScopesByUserId.get(user.id) ?? [],
              lookups
            })
          )
      };
    },
    auditEventType: "admin.users.view"
  });

  router.addRoute({
    id: "admin-user-create",
    method: "POST",
    path: "/admin/users",
    statusCode: 201,
    allowedRoles: ["platform_admin"],
    validate: validateAdminUserCreateBody,
    resolveResources: async ({ repos, principal, body }) => {
      const organization = await repos.organizations.findById(principal.tenant_id, body.organization_id);
      return { organization };
    },
    handler: async ({ repos, tenantId, body, resources }) => {
      const existingUsers = await repos.users.listByTenant(tenantId);
      const email = normalizeManagedUserEmail(body.email);
      if (
        existingUsers.some((entry) => entry.email.toLowerCase() === email.toLowerCase())
      ) {
        throw new HttpError(409, "A user with this email already exists in the tenant");
      }

      assertOrganizationCompatibleWithRole(body.role, resources.organization);

      const status = body.status ?? "pending_invite";
      if (!["pending_invite", "active"].includes(status)) {
        throw new HttpError(400, "New users may only start as pending_invite or active");
      }

      const createdUser = await repos.users.create({
        id: nextId("user"),
        tenant_id: tenantId,
        organization_id: resources.organization.id,
        email,
        display_name: body.display_name,
        role: body.role,
        external_identity_provider: body.external_identity_provider ?? null,
        external_subject: body.external_subject ?? null,
        status,
        last_login_at: null,
        disabled_at: null,
        disabled_reason: null,
        mfa_required: body.mfa_required ?? false,
        invited_at: status === "pending_invite" ? new Date().toISOString() : null,
        deleted_at: null,
        created_at: new Date().toISOString()
      });
      resources.user = createdUser;
      return createdUser;
    },
    auditEventType: "admin.user.created"
  });

  router.addRoute({
    id: "admin-user-detail",
    method: "GET",
    path: "/admin/users/:userId",
    allowedRoles: ["platform_admin"],
    resolveResources: resolveAdminUserResources,
    handler: async ({ repos, resources, tenantId }) => {
      const [organizations, events, stalls] = await Promise.all([
        repos.organizations.listByTenant(tenantId),
        repos.events.listByTenant(tenantId),
        repos.stalls.listByTenant(tenantId)
      ]);
      const lookups = buildAdminReferenceLookups({ organizations, events, stalls });
      return {
        item: formatManagedUser(resources.user, {
          organization: resources.organization,
          accessScopes: resources.accessScopes,
          lookups
        })
      };
    },
    auditEventType: "admin.user.view"
  });

  router.addRoute({
    id: "admin-user-update",
    method: "PATCH",
    path: "/admin/users/:userId",
    allowedRoles: ["platform_admin"],
    validate: validateAdminUserUpdateBody,
    resolveResources: resolveAdminUserResources,
    handler: async ({ repos, tenantId, body, resources }) => {
      const nextOrganization =
        body.organization_id && body.organization_id !== resources.user.organization_id
          ? await repos.organizations.findById(tenantId, body.organization_id)
          : resources.organization;
      const nextRole = body.role ?? resources.user.role;
      assertOrganizationCompatibleWithRole(nextRole, nextOrganization);

      const nextEmail = body.email ? normalizeManagedUserEmail(body.email) : resources.user.email;
      if (nextEmail.toLowerCase() !== resources.user.email.toLowerCase()) {
        const existingUsers = await repos.users.listByTenant(tenantId);
        if (
          existingUsers.some(
            (entry) =>
              entry.id !== resources.user.id && entry.email.toLowerCase() === nextEmail.toLowerCase()
          )
        ) {
          throw new HttpError(409, "A user with this email already exists in the tenant");
        }
      }

      return repos.users.update({
        ...resources.user,
        organization_id: nextOrganization.id,
        email: nextEmail,
        display_name: body.display_name ?? resources.user.display_name,
        role: nextRole,
        external_identity_provider:
          "external_identity_provider" in body
            ? body.external_identity_provider ?? null
            : resources.user.external_identity_provider,
        external_subject:
          "external_subject" in body ? body.external_subject ?? null : resources.user.external_subject,
        mfa_required:
          "mfa_required" in body ? body.mfa_required : resources.user.mfa_required
      });
    },
    auditEventType: "admin.user.updated"
  });

  router.addRoute({
    id: "admin-user-activate",
    method: "POST",
    path: "/admin/users/:userId/activate",
    allowedRoles: ["platform_admin"],
    resolveResources: resolveAdminUserResources,
    handler: async ({ repos, resources }) => {
      if (resources.user.status === "deleted") {
        throw new HttpError(409, "Deleted users cannot be reactivated");
      }
      return repos.users.update({
        ...resources.user,
        status: "active",
        disabled_at: null,
        disabled_reason: null
      });
    },
    auditEventType: "admin.user.activated"
  });

  router.addRoute({
    id: "admin-user-disable",
    method: "POST",
    path: "/admin/users/:userId/disable",
    allowedRoles: ["platform_admin"],
    validate: validateAdminUserActionBody,
    resolveResources: resolveAdminUserResources,
    handler: async ({ repos, body, resources }) =>
      repos.users.update({
        ...resources.user,
        status: "disabled",
        disabled_at: new Date().toISOString(),
        disabled_reason: body.reason ?? "Disabled by platform admin"
      }),
    auditEventType: "admin.user.disabled"
  });

  router.addRoute({
    id: "admin-user-suspend",
    method: "POST",
    path: "/admin/users/:userId/suspend",
    allowedRoles: ["platform_admin"],
    validate: validateAdminUserActionBody,
    resolveResources: resolveAdminUserResources,
    handler: async ({ repos, body, resources }) =>
      repos.users.update({
        ...resources.user,
        status: "suspended",
        disabled_at: new Date().toISOString(),
        disabled_reason: body.reason ?? "Suspended by platform admin"
      }),
    auditEventType: "admin.user.suspended"
  });

  router.addRoute({
    id: "admin-user-delete",
    method: "POST",
    path: "/admin/users/:userId/delete",
    allowedRoles: ["platform_admin"],
    validate: validateAdminUserActionBody,
    resolveResources: resolveAdminUserResources,
    handler: async ({ repos, body, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const currentScopes = await txRepos.userAccessScopes.listByUser(
          resources.user.tenant_id,
          resources.user.id
        );
        for (const scope of currentScopes) {
          await txRepos.userAccessScopes.deleteById(resources.user.tenant_id, scope.id);
        }
        return txRepos.users.update({
          ...resources.user,
          status: "deleted",
          disabled_at: resources.user.disabled_at ?? new Date().toISOString(),
          disabled_reason: body.reason ?? resources.user.disabled_reason ?? "Deleted by platform admin",
          deleted_at: new Date().toISOString()
        });
      }),
    auditEventType: "admin.user.deleted"
  });

  router.addRoute({
    id: "admin-user-scope-assign",
    method: "POST",
    path: "/admin/users/:userId/access-scopes",
    statusCode: 201,
    allowedRoles: ["platform_admin"],
    validate: validateAdminUserScopeBody,
    resolveResources: resolveAdminUserScopeAssignmentResources,
    handler: async ({ repos, resources }) => {
      if (resources.user.status === "deleted") {
        throw new HttpError(409, "Deleted users cannot receive access scopes");
      }

      validateScopeAssignmentForManagedUser(resources);

      const existingScopes = await repos.userAccessScopes.listByUser(
        resources.user.tenant_id,
        resources.user.id
      );
      if (
        existingScopes.some(
          (entry) =>
            normalizeNullableId(entry.event_id) === normalizeNullableId(resources.event?.id ?? null) &&
            normalizeNullableId(entry.stall_id) === normalizeNullableId(resources.stall?.id ?? null) &&
            normalizeNullableId(entry.sponsor_organization_id) ===
              normalizeNullableId(resources.sponsorOrganization?.id ?? null)
        )
      ) {
        throw new HttpError(409, "This access scope already exists for the user");
      }

      const createdScope = await repos.userAccessScopes.create({
        id: nextId("user-scope"),
        tenant_id: resources.user.tenant_id,
        user_id: resources.user.id,
        event_id: resources.event?.id ?? null,
        stall_id: resources.stall?.id ?? null,
        sponsor_organization_id: resources.sponsorOrganization?.id ?? null,
        created_at: new Date().toISOString()
      });
      resources.accessScope = createdScope;
      return createdScope;
    },
    auditEventType: "admin.user_scope.assigned"
  });

  router.addRoute({
    id: "admin-user-scope-revoke",
    method: "DELETE",
    path: "/admin/users/:userId/access-scopes/:scopeId",
    allowedRoles: ["platform_admin"],
    resolveResources: resolveAdminUserScopeResources,
    handler: async ({ repos, resources }) =>
      repos.userAccessScopes.deleteById(resources.user.tenant_id, resources.accessScope.id),
    auditEventType: "admin.user_scope.revoked"
  });

  router.addRoute({
    id: "admin-commercial-governance",
    method: "GET",
    path: "/admin/commercial/governance",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, tenantId }) => {
      const [partners, deals, payouts, approvals] = await Promise.all([
        repos.commercialPartners.listByTenant(tenantId),
        repos.commercialDeals.listByTenant(tenantId),
        repos.commercialPartnerPayouts.listByTenant(tenantId),
        repos.commercialApprovals.listByTenant(tenantId)
      ]);
      return buildCommercialGovernance({ partners, deals, payouts, approvals });
    },
    auditEventType: "admin.commercial_governance.view"
  });

  router.addRoute({
    id: "admin-commercial-partners-list",
    method: "GET",
    path: "/admin/commercial/partners",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, tenantId }) => ({
      items: await repos.commercialPartners.listByTenant(tenantId)
    }),
    auditEventType: "admin.commercial_partners.view"
  });

  router.addRoute({
    id: "admin-commercial-partner-create",
    method: "POST",
    path: "/admin/commercial/partners",
    statusCode: 201,
    allowedRoles: ["platform_admin"],
    validate: validateCommercialPartnerCreateBody,
    resolveResources: resolveCommercialPartnerAccessUser,
    handler: async ({ repos, tenantId, body, resources }) =>
      repos.commercialPartners.create({
        id: nextId("commercial-partner"),
        tenant_id: tenantId,
        name: body.name,
        partner_type: body.partner_type,
        status: body.status ?? "active",
        access_level: body.access_level ?? "commercial_status_only",
        platform_user_id: resources.platformAccessUser?.id ?? null,
        notes: body.notes ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }),
    auditEventType: "admin.commercial_partner.created"
  });

  router.addRoute({
    id: "admin-commercial-partner-update",
    method: "PATCH",
    path: "/admin/commercial/partners/:partnerId",
    allowedRoles: ["platform_admin"],
    validate: validateCommercialPartnerUpdateBody,
    resolveResources: async (ctx) => ({
      partner: await ctx.repos.commercialPartners.findById(ctx.principal.tenant_id, ctx.params.partnerId),
      ...(await resolveCommercialPartnerAccessUser(ctx))
    }),
    handler: async ({ repos, body, resources }) =>
      repos.commercialPartners.update({
        ...resources.partner,
        name: body.name ?? resources.partner.name,
        partner_type: body.partner_type ?? resources.partner.partner_type,
        status: body.status ?? resources.partner.status,
        access_level: body.access_level ?? resources.partner.access_level,
        platform_user_id:
          "platform_user_id" in body
            ? resources.platformAccessUser?.id ?? null
            : resources.partner.platform_user_id,
        notes: "notes" in body ? body.notes ?? null : resources.partner.notes,
        updated_at: new Date().toISOString()
      }),
    auditEventType: "admin.commercial_partner.updated"
  });

  router.addRoute({
    id: "admin-commercial-partner-status-update",
    method: "POST",
    path: "/admin/commercial/partners/:partnerId/status-updates",
    statusCode: 201,
    allowedRoles: ["platform_admin"],
    validate: validateCommercialPartnerStatusUpdateBody,
    resolveResources: async ({ repos, principal, params, body }) => ({
      partner: await repos.commercialPartners.findById(principal.tenant_id, params.partnerId),
      deal: body.deal_id ? await repos.commercialDeals.findById(principal.tenant_id, body.deal_id) : null
    }),
    handler: async ({ repos, principal, tenantId, body, resources }) => {
      if (resources.deal?.partner_id && resources.deal.partner_id !== resources.partner.id) {
        throw new HttpError(409, "deal_id must belong to the partner receiving the update");
      }
      return repos.commercialPartnerStatusUpdates.create({
        id: nextId("partner-status"),
        tenant_id: tenantId,
        partner_id: resources.partner.id,
        deal_id: resources.deal?.id ?? null,
        update_type: body.update_type,
        summary: body.summary,
        created_by_user_id: principal.user_id,
        created_at: new Date().toISOString()
      });
    },
    auditEventType: "admin.commercial_partner_status_update.created"
  });

  router.addRoute({
    id: "admin-commercial-deals-list",
    method: "GET",
    path: "/admin/commercial/deals",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, tenantId }) => ({
      items: await repos.commercialDeals.listByTenant(tenantId)
    }),
    auditEventType: "admin.commercial_deals.view"
  });

  router.addRoute({
    id: "admin-commercial-deal-create",
    method: "POST",
    path: "/admin/commercial/deals",
    statusCode: 201,
    allowedRoles: ["platform_admin"],
    validate: validateCommercialDealCreateBody,
    resolveResources: async ({ repos, principal, body }) => ({
      partner: body.partner_id ? await repos.commercialPartners.findById(principal.tenant_id, body.partner_id) : null
    }),
    handler: async ({ repos, tenantId, body, resources }) =>
      repos.commercialDeals.create({
        id: nextId("commercial-deal"),
        tenant_id: tenantId,
        partner_id: resources.partner?.id ?? null,
        account_name: body.account_name,
        stage: body.stage,
        next_action: body.next_action,
        next_action_at: body.next_action_at,
        offer_structure: body.offer_structure,
        commercial_positioning_ack: body.commercial_positioning_ack,
        notes: body.notes ?? null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }),
    auditEventType: "admin.commercial_deal.created"
  });

  router.addRoute({
    id: "admin-commercial-deal-update",
    method: "PATCH",
    path: "/admin/commercial/deals/:dealId",
    allowedRoles: ["platform_admin"],
    validate: validateCommercialDealUpdateBody,
    resolveResources: async ({ repos, principal, params, body }) => ({
      deal: await repos.commercialDeals.findById(principal.tenant_id, params.dealId),
      partner: body.partner_id ? await repos.commercialPartners.findById(principal.tenant_id, body.partner_id) : null
    }),
    handler: async ({ repos, body, resources }) =>
      repos.commercialDeals.update({
        ...resources.deal,
        partner_id: "partner_id" in body ? resources.partner?.id ?? null : resources.deal.partner_id,
        account_name: body.account_name ?? resources.deal.account_name,
        stage: body.stage ?? resources.deal.stage,
        next_action: body.next_action ?? resources.deal.next_action,
        next_action_at: body.next_action_at ?? resources.deal.next_action_at,
        offer_structure: body.offer_structure ?? resources.deal.offer_structure,
        commercial_positioning_ack:
          "commercial_positioning_ack" in body
            ? body.commercial_positioning_ack
            : resources.deal.commercial_positioning_ack,
        notes: "notes" in body ? body.notes ?? null : resources.deal.notes,
        updated_at: new Date().toISOString()
      }),
    auditEventType: "admin.commercial_deal.updated"
  });

  router.addRoute({
    id: "admin-commercial-payouts-list",
    method: "GET",
    path: "/admin/commercial/payouts",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, tenantId }) => ({
      items: await repos.commercialPartnerPayouts.listByTenant(tenantId)
    }),
    auditEventType: "admin.commercial_payouts.view"
  });

  router.addRoute({
    id: "admin-commercial-payout-create",
    method: "POST",
    path: "/admin/commercial/payouts",
    statusCode: 201,
    allowedRoles: ["platform_admin"],
    validate: validateCommercialPayoutCreateBody,
    resolveResources: resolveCommercialPayoutResources,
    handler: async ({ repos, principal, tenantId, body, resources }) => {
      const now = new Date().toISOString();
      const status = body.status ?? "pending";
      const approvedAt = status === "approved" || status === "paid" ? now : null;
      const paidAt = status === "paid" ? now : null;
      return repos.commercialPartnerPayouts.create({
        id: nextId("partner-payout"),
        tenant_id: tenantId,
        partner_id: resources.partner.id,
        deal_id: resources.deal?.id ?? null,
        amount_cents: body.amount_cents,
        currency: body.currency ?? "USD",
        status,
        client_payment_received_at: body.client_payment_received_at ?? null,
        approved_by_user_id: approvedAt ? principal.user_id : null,
        approved_at: approvedAt,
        paid_at: paidAt,
        notes: body.notes ?? null,
        created_at: now,
        updated_at: now
      });
    },
    auditEventType: "admin.commercial_payout.created"
  });

  router.addRoute({
    id: "admin-commercial-payout-update",
    method: "PATCH",
    path: "/admin/commercial/payouts/:payoutId",
    allowedRoles: ["platform_admin"],
    validate: validateCommercialPayoutUpdateBody,
    resolveResources: async (ctx) => {
      const payout = await ctx.repos.commercialPartnerPayouts.findById(ctx.principal.tenant_id, ctx.params.payoutId);
      return {
        payout,
        ...(await resolveCommercialPayoutResources({
          ...ctx,
          body: {
            partner_id: ctx.body.partner_id ?? payout.partner_id,
            deal_id: "deal_id" in ctx.body ? ctx.body.deal_id : payout.deal_id
          }
        }))
      };
    },
    handler: async ({ repos, principal, body, resources }) => {
      const now = new Date().toISOString();
      const nextStatus = body.status ?? resources.payout.status;
      const approvedAt =
        nextStatus === "approved" || nextStatus === "paid"
          ? resources.payout.approved_at ?? now
          : resources.payout.approved_at;
      return repos.commercialPartnerPayouts.update({
        ...resources.payout,
        partner_id: resources.partner.id,
        deal_id: "deal_id" in body ? resources.deal?.id ?? null : resources.payout.deal_id,
        amount_cents: body.amount_cents ?? resources.payout.amount_cents,
        currency: body.currency ?? resources.payout.currency,
        status: nextStatus,
        client_payment_received_at:
          "client_payment_received_at" in body
            ? body.client_payment_received_at
            : resources.payout.client_payment_received_at,
        approved_by_user_id: approvedAt ? resources.payout.approved_by_user_id ?? principal.user_id : null,
        approved_at: approvedAt,
        paid_at: nextStatus === "paid" ? resources.payout.paid_at ?? now : resources.payout.paid_at,
        notes: "notes" in body ? body.notes ?? null : resources.payout.notes,
        updated_at: now
      });
    },
    auditEventType: "admin.commercial_payout.updated"
  });

  router.addRoute({
    id: "admin-commercial-approvals-list",
    method: "GET",
    path: "/admin/commercial/approvals",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, tenantId }) => ({
      items: await repos.commercialApprovals.listByTenant(tenantId)
    }),
    auditEventType: "admin.commercial_approvals.view"
  });

  router.addRoute({
    id: "admin-commercial-approval-create",
    method: "POST",
    path: "/admin/commercial/approvals",
    statusCode: 201,
    allowedRoles: ["platform_admin"],
    validate: validateCommercialApprovalBody,
    handler: async ({ repos, principal, tenantId, body }) =>
      repos.commercialApprovals.create({
        id: nextId("commercial-approval"),
        tenant_id: tenantId,
        approval_type: body.approval_type,
        subject_id: body.subject_id ?? null,
        requested_by_user_id: principal.user_id,
        approver_user_id: principal.user_id,
        approver_role: body.approver_role,
        approval_status: body.approval_status,
        reason: body.reason,
        created_at: new Date().toISOString(),
        decided_at: body.approval_status === "pending" ? null : new Date().toISOString()
      }),
    auditEventType: "admin.commercial_approval.created"
  });

  router.addRoute({
    id: "organizer-exports-list",
    method: "GET",
    path: "/organizer/events/:eventId/exports",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, resources }) => ({
      event_id: resources.event.id,
      approval_required: resources.eventPolicy.require_export_approval,
      items: [...await repos.exportRequests.listByEvent(resources.event.tenant_id, resources.event.id)]
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    }),
    auditEventType: "organizer.exports.view"
  });

  router.addRoute({
    id: "exports-request",
    method: "POST",
    path: "/exports/request",
    allowedRoles: ["vendor_manager", "sponsor_user", "organizer_admin"],
    validate: (body) => {
      required(body, ["event_id", "export_type"]);
      return body;
    },
    resolveResources: async ({ repos, principal, body }) => {
      const event = await repos.events.findById(principal.tenant_id, body.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { event, eventPolicy };
    },
    handler: async ({ repos, body, principal, resources }) => {
      const exportId = nextId("export");
      const exportRequest = {
        id: exportId,
        tenant_id: resources.event.tenant_id,
        event_id: resources.event.id,
        requested_by_user_id: principal.user_id,
        requested_for_organization_id: principal.organization_id,
        export_type: body.export_type,
        filters: body.filters ?? {},
        row_count_estimate: await estimateRows(repos, resources.event.tenant_id, body.export_type, resources.event.id),
        status: resources.eventPolicy.require_export_approval ? "requested" : "generated",
        approval_required: resources.eventPolicy.require_export_approval,
        approved_by_user_id: null,
        approval_reason: null,
        rejection_reason: null,
        file_url: resources.eventPolicy.require_export_approval ? null : exportDownloadPath({ id: exportId }),
        file_expires_at: resources.eventPolicy.require_export_approval ? null : inHours(4),
        created_at: new Date().toISOString()
      };
      return repos.exportRequests.create(exportRequest);
    },
    auditEventType: "export.requested"
  });

  router.addRoute({
    id: "exports-approve",
    method: "POST",
    path: "/exports/:exportId/approve",
    allowedRoles: ["organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const exportRequest = await repos.exportRequests.findById(principal.tenant_id, params.exportId);
      const event = await repos.events.findById(principal.tenant_id, exportRequest.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { exportRequest, event, eventPolicy };
    },
    handler: async ({ repos, principal, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const exportRequest = await txRepos.exportRequests.findById(resources.exportRequest.tenant_id, resources.exportRequest.id);
        exportRequest.status = "generated";
        exportRequest.approved_by_user_id = principal.user_id;
        exportRequest.approval_reason = "Approved for pilot export";
        exportRequest.file_url = exportDownloadPath(exportRequest);
        exportRequest.file_expires_at = inHours(4);
        return txRepos.exportRequests.update(exportRequest);
      }),
    auditEventType: "export.approved"
  });

  router.addRoute({
    id: "exports-reject",
    method: "POST",
    path: "/exports/:exportId/reject",
    allowedRoles: ["organizer_admin"],
    validate: (body) => {
      required(body, ["reason"]);
      return body;
    },
    resolveResources: async ({ repos, principal, params }) => {
      const exportRequest = await repos.exportRequests.findById(principal.tenant_id, params.exportId);
      const event = await repos.events.findById(principal.tenant_id, exportRequest.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { exportRequest, event, eventPolicy };
    },
    handler: async ({ repos, body, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const exportRequest = await txRepos.exportRequests.findById(resources.exportRequest.tenant_id, resources.exportRequest.id);
        exportRequest.status = "rejected";
        exportRequest.rejection_reason = body.reason;
        return txRepos.exportRequests.update(exportRequest);
      }),
    auditEventType: "export.rejected"
  });

  router.addRoute({
    id: "exports-status",
    method: "GET",
    path: "/exports/:exportId/status",
    allowedRoles: ["vendor_manager", "sponsor_user", "organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const exportRequest = await repos.exportRequests.findById(principal.tenant_id, params.exportId);
      const event = await repos.events.findById(principal.tenant_id, exportRequest.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { exportRequest, event, eventPolicy };
    },
    handler: async ({ resources }) => resources.exportRequest,
    auditEventType: "export.status.view"
  });

  router.addRoute({
    id: "exports-short-link-create",
    method: "POST",
    path: "/exports/:exportId/short-link",
    allowedRoles: ["vendor_manager", "sponsor_user", "organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const exportRequest = await repos.exportRequests.findById(principal.tenant_id, params.exportId);
      const event = await repos.events.findById(principal.tenant_id, exportRequest.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { exportRequest, event, eventPolicy };
    },
    handler: async ({ repos, resources }) => {
      if (resources.exportRequest.status !== "generated") {
        throw new HttpError(409, "Export file is not ready");
      }
      if (resources.exportRequest.file_expires_at && Date.parse(resources.exportRequest.file_expires_at) < Date.now()) {
        throw new HttpError(410, "Export file has expired");
      }
      const shortLink = await createShortLinkRecord({
        repos,
        tenantId: resources.exportRequest.tenant_id,
        targetType: "export_download",
        targetId: resources.exportRequest.id,
        targetPayload: {
          export_id: resources.exportRequest.id,
          event_id: resources.exportRequest.event_id,
          download_path: exportDownloadPath(resources.exportRequest)
        },
        expiresAt: resources.exportRequest.file_expires_at ?? inHours(4)
      });
      return serializeShortLink(shortLink);
    },
    statusCode: 201,
    auditEventType: "export.short_link.created"
  });

  router.addRoute({
    id: "exports-download",
    method: "GET",
    path: "/exports/:exportId/download",
    allowedRoles: ["vendor_manager", "sponsor_user", "organizer_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const exportRequest = await repos.exportRequests.findById(principal.tenant_id, params.exportId);
      const event = await repos.events.findById(principal.tenant_id, exportRequest.event_id);
      const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      return { exportRequest, event, eventPolicy };
    },
    handler: async ({ repos, resources }) => {
      if (resources.exportRequest.status !== "generated") {
        throw new HttpError(409, "Export file is not ready");
      }
      if (resources.exportRequest.file_expires_at && Date.parse(resources.exportRequest.file_expires_at) < Date.now()) {
        throw new HttpError(410, "Export file has expired");
      }
      const file = await buildExportDownloadPayload(
        repos,
        resources.exportRequest.tenant_id,
        resources.exportRequest.event_id,
        resources.exportRequest
      );
      return {
        export_id: resources.exportRequest.id,
        export_type: resources.exportRequest.export_type,
        file_name: file.file_name,
        generated_at: resources.exportRequest.created_at,
        payload: file.payload
      };
    },
    auditEventType: "export.download"
  });

  router.addRoute({
    id: "break-glass-request",
    method: "POST",
    path: "/break-glass/request",
    allowedRoles: ["platform_admin"],
    validate: (body) => {
      required(body, ["justification", "access_scope", "expires_at"]);
      return body;
    },
    resolveResources: async ({ state, headers }) => ({
      tenantHint: headers["x-tenant-id"] ?? state.tenants[0].id
    }),
    handler: async ({ repos, body, principal, tenantId }) => {
      const request = {
        id: nextId("break-glass"),
        tenant_id: tenantId,
        requested_by_user_id: principal.user_id,
        first_approved_by_user_id: null,
        second_approved_by_user_id: null,
        justification: body.justification,
        access_scope: body.access_scope,
        status: "requested",
        starts_at: null,
        expires_at: body.expires_at,
        revoked_at: null,
        created_at: new Date().toISOString()
      };
      const created = await repos.breakGlassAccess.create(request);

      const requester = await repos.users.findById(tenantId, principal.user_id).catch(() => null);
      const allUsers = await repos.users.listByTenant(tenantId);
      const adminUsers = allUsers.filter((u) => u.role === "platform_admin" && u.id !== principal.user_id && u.status === "active");
      const recipients = adminUsers.length > 0 ? adminUsers : allUsers.filter((u) => u.role === "platform_admin");
      for (const admin of recipients) {
        await dispatchTransactionalEmail({
          repos,
          tenantId,
          recipientEmail: admin.email,
          messageType: "break_glass_pending_approval",
          templateVars: {
            requester_name: requester?.display_name ?? "A platform admin",
            justification: body.justification
          },
          actorUserId: principal.user_id
        });
      }

      return created;
    },
    auditEventType: "break_glass.requested"
  });

  router.addRoute({
    id: "break-glass-approve",
    method: "POST",
    path: "/break-glass/:requestId/approve",
    allowedRoles: ["platform_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const breakGlassRequest = await repos.breakGlassAccess.findById(principal.tenant_id, params.requestId);
      return { breakGlassRequest };
    },
    handler: async ({ repos, principal, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const request = await txRepos.breakGlassAccess.findById(resources.breakGlassRequest.tenant_id, resources.breakGlassRequest.id);
        if (!request.first_approved_by_user_id) {
          request.first_approved_by_user_id = principal.user_id;
          request.status = "partially_approved";
          return txRepos.breakGlassAccess.update(request);
        }

        request.second_approved_by_user_id = principal.user_id;
        request.starts_at = new Date().toISOString();
        request.status = "active";
        return txRepos.breakGlassAccess.update(request);
      }),
    auditEventType: "break_glass.approved"
  });

  router.addRoute({
    id: "break-glass-revoke",
    method: "POST",
    path: "/break-glass/:requestId/revoke",
    allowedRoles: ["platform_admin"],
    resolveResources: async ({ repos, principal, params }) => {
      const breakGlassRequest = await repos.breakGlassAccess.findById(principal.tenant_id, params.requestId);
      return { breakGlassRequest };
    },
    handler: async ({ repos, resources }) =>
      repos.withTransaction(async (txRepos) => {
        const request = await txRepos.breakGlassAccess.findById(resources.breakGlassRequest.tenant_id, resources.breakGlassRequest.id);
        request.status = "revoked";
        request.revoked_at = new Date().toISOString();
        return txRepos.breakGlassAccess.update(request);
      }),
    auditEventType: "break_glass.revoked"
  });

  router.addRoute({
    id: "break-glass-list",
    method: "GET",
    path: "/break-glass",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, tenantId }) => ({
      items: [...await repos.breakGlassAccess.listByTenant(tenantId)]
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    }),
    auditEventType: "break_glass.view"
  });

  router.addRoute({
    id: "audit-logs",
    method: "GET",
    path: "/audit/logs",
    allowedRoles: ["organizer_admin", "platform_admin"],
    handler: async ({ repos, tenantId }) => ({
      items: [...await repos.auditLogs.listByTenant(tenantId)].sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    }),
    auditEventType: "audit.logs.view"
  });

  // ─────────────────────────────────────────────────────────────
  // PHASE 2 — Auth Service Extensions
  // ─────────────────────────────────────────────────────────────

  router.addRoute({
    id: "auth-login",
    method: "POST",
    path: "/auth/login",
    authRequired: false,
    validate: (body) => body ?? {},
    handler: async ({ body, repos, state }) => {
      const { email, password } = body;
      if (!email || !password) {
        throw new HttpError(400, "email and password are required");
      }
      const user = await repos.users.findByEmail(email);
      if (!user || !user.password_hash) {
        throw new HttpError(401, "Invalid credentials");
      }
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        throw new HttpError(401, "Invalid credentials");
      }
      if (user.status !== "active") {
        throw new HttpError(403, "User account is not active");
      }
      await repos.users.update({ ...user, last_login_at: new Date().toISOString() });

      const roleAssignments = await repos.userRoleAssignments.listByUser(user.tenant_id, user.id);
      const scopes = await repos.userAccessScopes.listByUser(user.tenant_id, user.id);
      const { buildUserPrincipal } = await import("./auth/principals.mjs");
      const principal = buildUserPrincipal(user, scopes, roleAssignments);
      const secret = state.sessionSecret;
      const token = issuePlatformToken(principal, secret);
      const redirect = await resolveRedirectTarget(user.id, user.tenant_id, repos);
      return {
        token,
        user: { id: user.id, email: user.email, full_name: user.display_name, role: user.role },
        ...redirect
      };
    }
  });

  router.addRoute({
    id: "auth-invite-info",
    method: "GET",
    path: "/auth/invite-info",
    authRequired: false,
    handler: async ({ query, repos, state }) => {
      const { token } = query;
      if (!token || typeof token !== "string") {
        throw new HttpError(400, "token is required");
      }
      const hash = hashToken(token, state.sessionSecret);
      const user = await repos.users.findByInviteTokenHash(hash);
      if (!user || user.status !== "pending_invite") {
        throw new HttpError(404, "Invite not found or already used");
      }
      return { full_name: user.display_name, email: user.email };
    }
  });

  router.addRoute({
    id: "auth-accept-invite",
    method: "POST",
    path: "/auth/accept-invite",
    authRequired: false,
    auditEventType: "user.activated",
    validate: (body) => body ?? {},
    handler: async ({ body, repos, state }) => {
      const { token, password } = body;
      if (!token || !password) {
        throw new HttpError(400, "token and password are required");
      }
      const hash = hashToken(token, state.sessionSecret);
      const user = await repos.users.findByInviteTokenHash(hash);
      if (!user) {
        throw new HttpError(400, "INVITE_TOKEN_INVALID_OR_EXPIRED");
      }
      const complexity = validatePasswordComplexity(password);
      if (complexity) {
        throw new HttpError(400, "PASSWORD_TOO_WEAK", { message: complexity });
      }
      const passwordHash = await hashPassword(password);
      await repos.users.update({
        ...user,
        password_hash: passwordHash,
        status: "active",
        invitation_token_hash: null,
        invitation_expires_at: null
      });
      const updatedUser = await repos.users.findById(user.tenant_id, user.id);
      const roleAssignments = await repos.userRoleAssignments.listByUser(updatedUser.tenant_id, updatedUser.id);
      const scopes = await repos.userAccessScopes.listByUser(updatedUser.tenant_id, updatedUser.id);
      const { buildUserPrincipal } = await import("./auth/principals.mjs");
      const principal = buildUserPrincipal(updatedUser, scopes, roleAssignments);
      const jwtToken = issuePlatformToken(principal, state.sessionSecret);
      const redirect = await resolveRedirectTarget(updatedUser.id, updatedUser.tenant_id, repos);
      await dispatchTransactionalEmail({
        repos,
        tenantId: updatedUser.tenant_id,
        recipientEmail: updatedUser.email,
        messageType: "account_activated",
        templateVars: {
          display_name: updatedUser.display_name,
          login_url: process.env.PLATFORM_BASE_URL ?? ""
        },
        actorUserId: updatedUser.id
      });
      return { token: jwtToken, ...redirect };
    }
  });

  // In-memory per-email rate limit store for forgot-password (3 req/hour)
  const forgotPasswordHits = new Map();
  function checkForgotPasswordRateLimit(email) {
    const now = Date.now();
    const windowStart = now - 60 * 60 * 1000;
    const key = email.toLowerCase();
    const hits = (forgotPasswordHits.get(key) ?? []).filter((t) => t > windowStart);
    if (hits.length >= 3) return false;
    hits.push(now);
    forgotPasswordHits.set(key, hits);
    return true;
  }

  router.addRoute({
    id: "auth-forgot-password",
    method: "POST",
    path: "/auth/forgot-password",
    authRequired: false,
    validate: (body) => body ?? {},
    handler: async ({ body, repos, state }) => {
      const { email } = body;
      if (!email || typeof email !== "string") {
        // Still return 200 — never reveal details
        return { message: "If an account exists for this email, a reset link has been sent." };
      }
      const allowed = checkForgotPasswordRateLimit(email);
      if (!allowed) {
        return { message: "If an account exists for this email, a reset link has been sent." };
      }
      const user = await repos.users.findByEmail(email);
      if (user) {
        const plaintext = await generateResetToken(user.id, user.tenant_id, repos, state.sessionSecret);
        const resetUrl = `${process.env.PLATFORM_BASE_URL ?? ""}/reset-password?token=${plaintext}`;
        await dispatchTransactionalEmail({
          repos,
          tenantId: user.tenant_id,
          recipientEmail: user.email,
          messageType: "password_reset",
          templateVars: { display_name: user.display_name, reset_url: resetUrl },
          actorUserId: null
        });
        await writeAuditEvent(repos, {
          tenantId: user.tenant_id,
          actorType: "system",
          actorId: "system",
          eventType: AUDIT_EVENT_TYPES.USER_PASSWORD_RESET_REQUESTED,
          targetType: "user",
          targetId: user.id
        });
      }
      return { message: "If an account exists for this email, a reset link has been sent." };
    }
  });

  router.addRoute({
    id: "auth-reset-password",
    method: "POST",
    path: "/auth/reset-password",
    authRequired: false,
    auditEventType: "user.password_reset_completed",
    validate: (body) => body ?? {},
    handler: async ({ body, repos, state }) => {
      const { token, password } = body;
      if (!token || !password) {
        throw new HttpError(400, "token and password are required");
      }
      const hash = hashToken(token, state.sessionSecret);
      const user = await repos.users.findByResetTokenHash(hash);
      if (!user) {
        throw new HttpError(400, "RESET_TOKEN_INVALID_OR_EXPIRED");
      }
      const complexity = validatePasswordComplexity(password);
      if (complexity) {
        throw new HttpError(400, "PASSWORD_TOO_WEAK", { message: complexity });
      }
      const passwordHash = await hashPassword(password);
      await repos.users.update({
        ...user,
        password_hash: passwordHash,
        password_reset_token_hash: null,
        password_reset_expires_at: null
      });
      return { message: "Password reset successfully" };
    }
  });

  router.addRoute({
    id: "auth-change-password",
    method: "POST",
    path: "/auth/change-password",
    authRequired: true,
    auditEventType: "user.password_changed",
    validate: (body) => body ?? {},
    handler: async ({ body, principal, repos }) => {
      const { current_password, new_password } = body;
      if (!current_password || !new_password) {
        throw new HttpError(400, "current_password and new_password are required");
      }
      const user = await repos.users.findById(principal.tenant_id, principal.actor_id);
      if (!user.password_hash) {
        throw new HttpError(400, "Password authentication is not configured for this account");
      }
      const valid = await verifyPassword(current_password, user.password_hash);
      if (!valid) {
        throw new HttpError(401, "CURRENT_PASSWORD_INCORRECT");
      }
      const complexity = validatePasswordComplexity(new_password);
      if (complexity) {
        throw new HttpError(400, "PASSWORD_TOO_WEAK", { message: complexity });
      }
      const passwordHash = await hashPassword(new_password);
      await repos.users.update({ ...user, password_hash: passwordHash });
      return { message: "Password updated" };
    }
  });

  router.addRoute({
    id: "auth-me-extended",
    method: "GET",
    path: "/auth/me/profile",
    authRequired: true,
    handler: async ({ principal, repos }) => {
      const user = await repos.users.findById(principal.tenant_id, principal.actor_id);
      const org = user.organization_id
        ? await repos.organizations.findById(principal.tenant_id, user.organization_id).catch(() => null)
        : null;
      const roleAssignments = await repos.userRoleAssignments.listByUser(principal.tenant_id, user.id);
      return {
        id: user.id,
        full_name: user.display_name,
        email: user.email,
        org_id: user.organization_id ?? null,
        org_name: org?.name ?? null,
        status: user.status,
        roles: [...new Set([user.role, ...roleAssignments.map((r) => r.role)])],
        last_login_at: user.last_login_at ?? null
      };
    }
  });

  router.addRoute({
    id: "auth-patch-me",
    method: "PATCH",
    path: "/auth/me",
    authRequired: true,
    validate: (body) => body ?? {},
    handler: async ({ body, principal, repos }) => {
      const { full_name } = body;
      if (!full_name || typeof full_name !== "string") {
        throw new HttpError(400, "full_name is required");
      }
      const trimmed = full_name.trim();
      if (trimmed.length < 2 || trimmed.length > 100) {
        throw new HttpError(400, "full_name must be 2–100 characters");
      }
      const user = await repos.users.findById(principal.tenant_id, principal.actor_id);
      const updated = await repos.users.update({ ...user, display_name: trimmed });
      const org = updated.organization_id
        ? await repos.organizations.findById(principal.tenant_id, updated.organization_id).catch(() => null)
        : null;
      const roleAssignments = await repos.userRoleAssignments.listByUser(principal.tenant_id, updated.id);
      return {
        id: updated.id,
        full_name: updated.display_name,
        email: updated.email,
        org_id: updated.organization_id ?? null,
        org_name: org?.name ?? null,
        status: updated.status,
        roles: [...new Set([updated.role, ...roleAssignments.map((r) => r.role)])],
        last_login_at: updated.last_login_at ?? null
      };
    }
  });

  // generateInviteToken is exported for use by Phase 3 user invite endpoint
  router.generateInviteToken = (userId, tenantId, repos, secret) =>
    generateInviteToken(userId, tenantId, repos, secret);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3 — Identity / User Management API
  // ─────────────────────────────────────────────────────────────────────────

  const VALID_ROLES = ["platform_admin", "organizer_admin", "vendor_manager", "sponsor_user", "ops_user"];
  const VALID_ORG_TYPES = ["organizer", "vendor", "sponsor", "platform"];

  function formatUser(user, roleAssignments) {
    return {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      roles: [...new Set([user.role, ...roleAssignments.map((r) => r.role)])],
      org_id: user.organization_id ?? null,
      tenant_id: user.tenant_id,
      status: user.status,
      invited_at: user.invited_at ?? null,
      last_login_at: user.last_login_at ?? null,
      disabled_at: user.disabled_at ?? null
    };
  }

  function validateRoleAssignment({ role, event_id, stall_ids, sponsor_package_id }) {
    if (!VALID_ROLES.includes(role)) {
      throw new HttpError(400, `Invalid role: ${role}`);
    }
    if (role === "vendor_manager") {
      if (!event_id) throw new HttpError(400, "vendor_manager requires event_id");
      if (!Array.isArray(stall_ids) || stall_ids.length === 0) {
        throw new HttpError(400, "vendor_manager requires at least one stall_id");
      }
    } else if (role === "sponsor_user") {
      if (!event_id) throw new HttpError(400, "sponsor_user requires event_id");
      if (!sponsor_package_id) throw new HttpError(400, "sponsor_user requires sponsor_package_id");
    } else if (role === "organizer_admin") {
      if (!event_id) throw new HttpError(400, "organizer_admin requires event_id");
    } else if (role === "ops_user") {
      if (!event_id) throw new HttpError(400, "ops_user requires event_id");
    } else if (role === "platform_admin") {
      // no event/stall scope required
    }
  }

  // GET /users — list users, tenant-scoped
  router.addRoute({
    id: "users-list",
    method: "GET",
    path: "/users",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ query, principal, repos }) => {
      const { role, status, org_id, page = "1", page_size = "20" } = query ?? {};
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(page_size, 10) || 20));

      let users = await repos.users.listByTenant(principal.tenant_id);

      // organizer_admin: scope to users who have a role assignment in one of their events
      if (principal.role === "organizer_admin") {
        const allAssignments = await repos.userRoleAssignments.listByTenant(principal.tenant_id);
        const allowedEventIds = new Set(principal.event_ids ?? []);
        const allowedUserIds = new Set(
          allAssignments
            .filter((a) => a.event_id && allowedEventIds.has(a.event_id))
            .map((a) => a.user_id)
        );
        users = users.filter((u) => allowedUserIds.has(u.id) || u.id === principal.actor_id);
      }

      if (role) users = users.filter((u) => u.role === role);
      if (status) users = users.filter((u) => u.status === status);
      if (org_id) users = users.filter((u) => u.organization_id === org_id);

      const total = users.length;
      const paginated = users.slice((pageNum - 1) * pageSize, pageNum * pageSize);

      const allAssignmentsForPage = await Promise.all(
        paginated.map((u) => repos.userRoleAssignments.listByUser(principal.tenant_id, u.id))
      );

      return {
        users: paginated.map((u, i) => formatUser(u, allAssignmentsForPage[i])),
        total,
        page: pageNum,
        page_size: pageSize
      };
    }
  });

  // POST /users/invite — create user + role assignment + invite token
  router.addRoute({
    id: "users-invite",
    method: "POST",
    path: "/users/invite",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, principal, repos, state }) => {
      const { email, display_name, role, org_id, event_id, stall_ids = [], sponsor_package_id } = body;

      if (!email || typeof email !== "string") throw new HttpError(400, "email is required");
      if (!display_name || typeof display_name !== "string") throw new HttpError(400, "display_name is required");
      if (!role) throw new HttpError(400, "role is required");

      if (principal.role === "organizer_admin" && (role === "organizer_admin" || role === "platform_admin")) {
        throw new HttpError(403, "INSUFFICIENT_PERMISSIONS");
      }

      validateRoleAssignment({ role, event_id, stall_ids, sponsor_package_id });

      const existing = await repos.users.findByEmail(email.toLowerCase().trim());
      if (existing) throw new HttpError(409, "A user with this email already exists");

      const now = new Date().toISOString();
      const userId = nextId("user");
      const newUser = {
        id: userId,
        email: email.toLowerCase().trim(),
        display_name: display_name.trim(),
        role,
        organization_id: org_id ?? null,
        tenant_id: principal.tenant_id,
        external_identity_provider: null,
        external_subject: null,
        status: "pending_invite",
        password_hash: null,
        invited_by_user_id: principal.actor_id,
        invitation_token_hash: null,
        invitation_expires_at: null,
        password_reset_token_hash: null,
        password_reset_expires_at: null,
        last_login_at: null,
        disabled_at: null,
        disabled_reason: null,
        mfa_required: false,
        invited_at: now,
        deleted_at: null,
        created_at: now
      };
      await repos.users.create(newUser);

      const assignmentId = nextId("ura");
      await repos.userRoleAssignments.create({
        id: assignmentId,
        tenant_id: principal.tenant_id,
        user_id: userId,
        role,
        event_id: event_id ?? null,
        stall_ids: stall_ids ?? [],
        sponsor_package_id: sponsor_package_id ?? null,
        assigned_by_user_id: principal.actor_id,
        created_at: now
      });

      const secret = state?.sessionSecret ?? "default-secret";
      const inviteToken = await generateInviteToken(userId, principal.tenant_id, repos, secret);
      const createdUser = await repos.users.findById(principal.tenant_id, userId);

      const inviteUrl = `${process.env.PLATFORM_BASE_URL ?? ""}/accept-invite?token=${inviteToken}`;
      await dispatchTransactionalEmail({
        repos,
        tenantId: principal.tenant_id,
        recipientEmail: createdUser.email,
        messageType: "user_invitation",
        templateVars: { display_name: createdUser.display_name, invite_url: inviteUrl },
        actorUserId: principal.actor_id
      });
      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.USER_INVITED,
        targetType: "user",
        targetId: userId,
        metadata: { role, event_id: event_id ?? null, invited_by: principal.actor_id }
      });

      return {
        user_id: userId,
        email: createdUser.email,
        display_name: createdUser.display_name,
        role,
        status: "pending_invite",
        invite_token: inviteToken,
        expires_at: createdUser.invitation_expires_at
      };
    }
  });

  // GET /users/:userId — user detail
  router.addRoute({
    id: "users-get",
    method: "GET",
    path: "/users/:userId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ params, principal, repos }) => {
      const user = await repos.users.findById(principal.tenant_id, params.userId);
      const roleAssignments = await repos.userRoleAssignments.listByUser(principal.tenant_id, user.id);
      const org = user.organization_id
        ? await repos.organizations.findById(principal.tenant_id, user.organization_id).catch(() => null)
        : null;
      return {
        ...formatUser(user, roleAssignments),
        org_name: org?.name ?? null,
        role_assignments: roleAssignments
      };
    }
  });

  // PATCH /users/:userId — update display name
  router.addRoute({
    id: "users-patch",
    method: "PATCH",
    path: "/users/:userId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const user = await repos.users.findById(principal.tenant_id, params.userId);
      const updates = {};
      if (body.display_name !== undefined) {
        const trimmed = String(body.display_name).trim();
        if (trimmed.length < 2 || trimmed.length > 100) {
          throw new HttpError(400, "display_name must be 2–100 characters");
        }
        updates.display_name = trimmed;
      }
      const updated = await repos.users.update({ ...user, ...updates });
      const roleAssignments = await repos.userRoleAssignments.listByUser(principal.tenant_id, updated.id);
      return formatUser(updated, roleAssignments);
    }
  });

  // POST /users/:userId/disable
  router.addRoute({
    id: "users-disable",
    method: "POST",
    path: "/users/:userId/disable",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    auditEventType: "user.disabled",
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const user = await repos.users.findById(principal.tenant_id, params.userId);
      if (user.id === principal.actor_id) {
        throw new HttpError(400, "Cannot disable your own account");
      }
      if (user.status === "disabled") {
        throw new HttpError(409, "User is already disabled");
      }
      const now = new Date().toISOString();
      const updated = await repos.users.update({
        ...user,
        status: "disabled",
        disabled_at: now,
        disabled_reason: body.reason ?? null
      });
      const roleAssignments = await repos.userRoleAssignments.listByUser(principal.tenant_id, updated.id);
      return formatUser(updated, roleAssignments);
    }
  });

  // POST /users/:userId/enable
  router.addRoute({
    id: "users-enable",
    method: "POST",
    path: "/users/:userId/enable",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    auditEventType: "user.re_enabled",
    validate: (body) => body ?? {},
    handler: async ({ params, principal, repos }) => {
      const user = await repos.users.findById(principal.tenant_id, params.userId);
      // organizer_admin cannot re-enable a platform_admin user
      if (principal.role === "organizer_admin" && user.role === "platform_admin") {
        throw new HttpError(403, "organizer_admin cannot enable a platform_admin user");
      }
      if (user.status === "active") {
        return { id: user.id, status: "active" };
      }
      const updated = await repos.users.update({
        ...user,
        status: "active",
        disabled_at: null,
        disabled_reason: null
      });
      return { id: updated.id, status: "active" };
    }
  });

  // POST /users/:userId/resend-invite
  router.addRoute({
    id: "users-resend-invite",
    method: "POST",
    path: "/users/:userId/resend-invite",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ params, principal, repos, state }) => {
      const user = await repos.users.findById(principal.tenant_id, params.userId);
      if (user.status !== "pending_invite") {
        throw new HttpError(400, "User is not in pending_invite status");
      }
      // invalidate old token
      await repos.users.update({
        ...user,
        invitation_token_hash: null,
        invitation_expires_at: null
      });
      const secret = state?.sessionSecret ?? "default-secret";
      const inviteToken = await generateInviteToken(user.id, principal.tenant_id, repos, secret);
      const refreshed = await repos.users.findById(principal.tenant_id, user.id);

      const inviteUrl = `${process.env.PLATFORM_BASE_URL ?? ""}/accept-invite?token=${inviteToken}`;
      await dispatchTransactionalEmail({
        repos,
        tenantId: principal.tenant_id,
        recipientEmail: refreshed.email,
        messageType: "user_invitation",
        templateVars: { display_name: refreshed.display_name, invite_url: inviteUrl },
        actorUserId: principal.actor_id
      });

      return {
        user_id: user.id,
        email: user.email,
        invite_token: inviteToken,
        expires_at: refreshed.invitation_expires_at
      };
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // API Client Management — platform_admin only
  // ─────────────────────────────────────────────────────────────────────────

  {
    const VALID_API_CLIENT_SCOPES = new Set([
      "interactions:read",
      "leads:export",
      "events:read",
      "webhooks:write",
      "analytics:read"
    ]);

    function formatApiClient(client) {
      return {
        id: client.id,
        name: client.name,
        client_id: client.client_id,
        scopes: client.scopes,
        status: client.status,
        created_at: client.created_at,
        last_used_at: client.last_used_at ?? null
      };
    }

    router.addRoute({
      id: "admin-api-clients-list",
      method: "GET",
      path: "/admin/api-clients",
      authRequired: true,
      allowedRoles: ["platform_admin"],
      handler: async ({ query, principal, repos }) => {
        const { tenant_id } = query ?? {};
        const tid = tenant_id ?? principal.tenant_id;
        const clients = await repos.apiClients.listByTenant(tid);
        return clients.map(formatApiClient);
      }
    });

    router.addRoute({
      id: "admin-api-clients-create",
      method: "POST",
      path: "/admin/api-clients",
      authRequired: true,
      allowedRoles: ["platform_admin"],
      statusCode: 201,
      auditEventType: "api_client.created",
      validate: (body) => {
        if (!body?.name) throw new HttpError(400, "name is required");
        if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
          throw new HttpError(400, "scopes must be a non-empty array");
        }
        const invalid = body.scopes.filter((s) => !VALID_API_CLIENT_SCOPES.has(s));
        if (invalid.length > 0) {
          throw new HttpError(400, `Invalid scopes: ${invalid.join(", ")}`);
        }
        return body;
      },
      handler: async ({ body, principal, repos, state }) => {
        const { randomBytes, randomUUID } = await import("node:crypto");
        const clientSecret = randomBytes(32).toString("hex");
        const secretHash = hashToken(clientSecret, state.sessionSecret);
        const now = new Date().toISOString();
        const record = {
          id: nextId("apiclient"),
          tenant_id: principal.tenant_id,
          name: body.name,
          client_id: randomUUID(),
          client_secret_hash: secretHash,
          scopes: body.scopes,
          status: "active",
          last_used_at: null,
          created_at: now
        };
        await repos.apiClients.create(record);
        return { client_id: record.client_id, client_secret: clientSecret };
      }
    });

    router.addRoute({
      id: "admin-api-clients-get",
      method: "GET",
      path: "/admin/api-clients/:clientId",
      authRequired: true,
      allowedRoles: ["platform_admin"],
      handler: async ({ params, principal, repos }) => {
        const client = await repos.apiClients.findById(principal.tenant_id, params.clientId);
        return formatApiClient(client);
      }
    });

    router.addRoute({
      id: "admin-api-clients-rotate-secret",
      method: "POST",
      path: "/admin/api-clients/:clientId/rotate-secret",
      authRequired: true,
      allowedRoles: ["platform_admin"],
      auditEventType: "api_client.secret_rotated",
      validate: (body) => body ?? {},
      handler: async ({ params, principal, repos, state }) => {
        const client = await repos.apiClients.findById(principal.tenant_id, params.clientId);
        if (client.status === "revoked") {
          throw new HttpError(400, "Cannot rotate secret on a revoked API client");
        }
        const { randomBytes } = await import("node:crypto");
        const clientSecret = randomBytes(32).toString("hex");
        const secretHash = hashToken(clientSecret, state.sessionSecret);
        await repos.apiClients.update({
          ...client,
          client_secret_hash: secretHash,
          last_used_at: null
        });
        return { client_id: client.client_id, client_secret: clientSecret };
      }
    });

    router.addRoute({
      id: "admin-api-clients-revoke",
      method: "POST",
      path: "/admin/api-clients/:clientId/revoke",
      authRequired: true,
      allowedRoles: ["platform_admin"],
      auditEventType: "api_client.revoked",
      validate: (body) => body ?? {},
      handler: async ({ params, principal, repos }) => {
        const client = await repos.apiClients.findById(principal.tenant_id, params.clientId);
        const updated = await repos.apiClients.update({ ...client, status: "revoked" });
        return { id: updated.id, status: "revoked" };
      }
    });
  }

  // GET /users/:userId/roles
  router.addRoute({
    id: "users-roles-list",
    method: "GET",
    path: "/users/:userId/roles",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ params, principal, repos }) => {
      await repos.users.findById(principal.tenant_id, params.userId);
      const assignments = await repos.userRoleAssignments.listByUser(principal.tenant_id, params.userId);
      return { role_assignments: assignments };
    }
  });

  // POST /users/:userId/roles — assign role
  router.addRoute({
    id: "users-roles-assign",
    method: "POST",
    path: "/users/:userId/roles",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const { role, event_id, stall_ids = [], sponsor_package_id } = body;
      if (!role) throw new HttpError(400, "role is required");
      validateRoleAssignment({ role, event_id, stall_ids, sponsor_package_id });

      await repos.users.findById(principal.tenant_id, params.userId);

      const now = new Date().toISOString();
      const assignment = await repos.userRoleAssignments.create({
        id: nextId("ura"),
        tenant_id: principal.tenant_id,
        user_id: params.userId,
        role,
        event_id: event_id ?? null,
        stall_ids: stall_ids ?? [],
        sponsor_package_id: sponsor_package_id ?? null,
        assigned_by_user_id: principal.actor_id,
        created_at: now
      });
      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.USER_ROLE_ASSIGNED,
        targetType: "user",
        targetId: params.userId,
        metadata: { role, event_id: event_id ?? null, stall_ids: stall_ids ?? [], sponsor_package_id: sponsor_package_id ?? null }
      });
      return assignment;
    }
  });

  // DELETE /users/:userId/roles/:assignmentId
  router.addRoute({
    id: "users-roles-delete",
    method: "DELETE",
    path: "/users/:userId/roles/:assignmentId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ params, principal, repos }) => {
      await repos.users.findById(principal.tenant_id, params.userId);
      const deleted = await repos.userRoleAssignments.deleteById(principal.tenant_id, params.assignmentId);
      if (deleted.user_id !== params.userId) {
        throw new HttpError(404, "Role assignment not found for this user");
      }
      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.USER_ROLE_REMOVED,
        targetType: "user",
        targetId: params.userId,
        metadata: { assignment_id: params.assignmentId }
      });
      return { deleted: true, id: deleted.id };
    }
  });

  // GET /orgs — list organizations
  router.addRoute({
    id: "orgs-list",
    method: "GET",
    path: "/orgs",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ principal, repos }) => {
      const orgs = await repos.organizations.listByTenant(principal.tenant_id);
      return { organizations: orgs };
    }
  });

  // POST /orgs — create organization (platform_admin only)
  router.addRoute({
    id: "orgs-create",
    method: "POST",
    path: "/orgs",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    auditEventType: "org.created",
    validate: (body) => body ?? {},
    handler: async ({ body, principal, repos }) => {
      const { name, type } = body;
      if (!name || typeof name !== "string" || name.trim().length < 2) {
        throw new HttpError(400, "name must be at least 2 characters");
      }
      if (!type || !VALID_ORG_TYPES.includes(type)) {
        throw new HttpError(400, `type must be one of: ${VALID_ORG_TYPES.join(", ")}`);
      }
      const now = new Date().toISOString();
      const org = await repos.organizations.create({
        id: nextId("org"),
        tenant_id: principal.tenant_id,
        name: name.trim(),
        type,
        created_at: now,
        updated_at: now
      });
      return org;
    }
  });

  // GET /orgs/:orgId — org detail
  router.addRoute({
    id: "orgs-get",
    method: "GET",
    path: "/orgs/:orgId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ params, principal, repos }) => {
      const org = await repos.organizations.findById(principal.tenant_id, params.orgId);
      return org;
    }
  });

  // PATCH /orgs/:orgId — update organization (platform_admin only)
  router.addRoute({
    id: "orgs-patch",
    method: "PATCH",
    path: "/orgs/:orgId",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    auditEventType: "org.updated",
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const org = await repos.organizations.findById(principal.tenant_id, params.orgId);
      const updates = {};
      if (body.name !== undefined) {
        const trimmed = String(body.name).trim();
        if (trimmed.length < 2) throw new HttpError(400, "name must be at least 2 characters");
        updates.name = trimmed;
      }
      if (body.type !== undefined) {
        if (!VALID_ORG_TYPES.includes(body.type)) {
          throw new HttpError(400, `type must be one of: ${VALID_ORG_TYPES.join(", ")}`);
        }
        updates.type = body.type;
      }
      const updated = await repos.organizations.update({
        ...org,
        ...updates,
        updated_at: new Date().toISOString()
      });
      return updated;
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 4 — Event Management API
  // ─────────────────────────────────────────────────────────────────────────

  const LOCKED_STATUSES = ["live", "closed", "archived"];
  const VALID_TIERS = ["bronze", "silver", "gold", "custom"];
  const VALID_RETENTION_DAYS = [30, 60, 90, 180, 365];

  function assertEventEditable(event) {
    if (LOCKED_STATUSES.includes(event.status)) {
      throw new HttpError(400, "EVENT_LOCKED: Event configuration cannot be changed after going live");
    }
  }

  function isEventScoped(principal, eventId) {
    if (principal.role === "platform_admin") return true;
    const ids = principal.event_ids ?? [];
    return ids.includes(eventId);
  }

  function assertEventScoped(principal, eventId) {
    if (!isEventScoped(principal, eventId)) {
      throw new HttpError(403, "Event not in your scope");
    }
  }

  async function computeEventCounts(repos, tenantId, eventId) {
    const [halls, stalls, devices] = await Promise.all([
      repos.halls.listByEvent(tenantId, eventId),
      repos.stalls.listByEvent(tenantId, eventId),
      repos.deviceAssignments.listByEvent(tenantId, eventId)
    ]);
    return { hall_count: halls.length, stall_count: stalls.length, device_count: devices.length };
  }

  function formatEvent(event, counts = {}) {
    return {
      id: event.id,
      name: event.name,
      venue_name: event.venue_name ?? null,
      city: event.city ?? null,
      country: event.country ?? null,
      starts_at: event.starts_at ?? null,
      ends_at: event.ends_at ?? null,
      status: event.status,
      organizer_org_id: event.organizer_organization_id ?? null,
      tenant_id: event.tenant_id,
      created_at: event.created_at,
      hall_count: counts.hall_count ?? 0,
      stall_count: counts.stall_count ?? 0,
      device_count: counts.device_count ?? 0
    };
  }

  async function computeChecklist(repos, tenantId, eventId) {
    const [halls, stalls, packages, policy, assignments, branding] = await Promise.all([
      repos.halls.listByEvent(tenantId, eventId),
      repos.stalls.listByEvent(tenantId, eventId),
      repos.sponsorPackages.listByEvent(tenantId, eventId),
      repos.eventPolicies.findByEventId(tenantId, eventId),
      repos.userRoleAssignments.listByTenant(tenantId),
      repos.brandingAssets.findActiveByEvent(tenantId, eventId)
    ]);
    const organizerAssigned = assignments.some(
      (a) => a.event_id === eventId && a.role === "organizer_admin"
    );
    const items = {
      has_halls: halls.length > 0,
      has_stalls: stalls.length > 0,
      has_sponsor_packages: packages.length > 0,
      has_data_policy: !policy.missing_policy_row,
      has_organizer_admin_user: organizerAssigned,
      has_branding_approved: branding?.branding_approved === true,
      has_device_assigned: false
    };
    // check for recent device heartbeat
    const deviceAssignments = await repos.deviceAssignments.listByEvent(tenantId, eventId);
    if (deviceAssignments.length > 0) {
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      for (const da of deviceAssignments) {
        const beats = await repos.heartbeats.listByDevice(tenantId, da.device_id);
        const recent = beats.some((b) => new Date(b.received_at ?? b.created_at) > tenMinutesAgo);
        if (recent) { items.has_device_assigned = true; break; }
      }
    }
    const publishItems = [
      items.has_halls, items.has_stalls, items.has_sponsor_packages,
      items.has_data_policy, items.has_organizer_admin_user
    ];
    const ready_to_publish = publishItems.every(Boolean);
    const ready_to_go_live = ready_to_publish && items.has_branding_approved && items.has_device_assigned;
    return { items, ready_to_publish, ready_to_go_live };
  }

  // POST /events
  router.addRoute({
    id: "events-create",
    method: "POST",
    path: "/events",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, principal, repos }) => {
      const { name, venue_name, city, country, start_at, end_at, organizer_org_id } = body;

      if (!name || typeof name !== "string" || name.trim().length < 2 || name.trim().length > 200) {
        throw new HttpError(400, "name must be 2–200 characters");
      }
      if (!venue_name || typeof venue_name !== "string") throw new HttpError(400, "venue_name is required");
      if (!city || typeof city !== "string") throw new HttpError(400, "city is required");
      if (!country || typeof country !== "string") throw new HttpError(400, "country is required");
      if (!start_at) throw new HttpError(400, "start_at is required");
      if (!end_at) throw new HttpError(400, "end_at is required");

      const startsAt = new Date(start_at);
      const endsAt = new Date(end_at);
      if (isNaN(startsAt.getTime())) throw new HttpError(400, "start_at must be a valid ISO8601 datetime");
      if (isNaN(endsAt.getTime())) throw new HttpError(400, "end_at must be a valid ISO8601 datetime");
      if (endsAt <= startsAt) throw new HttpError(400, "end_at must be after start_at");

      const tenantId = principal.tenant_id;
      const orgId = organizer_org_id ?? principal.org_id ?? null;
      const now = new Date().toISOString();

      const event = await repos.events.create({
        id: nextId("event"),
        tenant_id: tenantId,
        organizer_organization_id: orgId,
        name: name.trim(),
        venue_name: venue_name.trim(),
        city: city.trim(),
        country: country.trim(),
        status: "draft",
        metrics_definition_version: 1,
        report_snapshot_version: 1,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        created_at: now
      });

      await writeAuditEvent(repos, {
        tenantId,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.EVENT_CREATED,
        targetType: "event",
        targetId: event.id
      });

      return { event_id: event.id, name: event.name, status: event.status };
    }
  });

  // GET /events
  router.addRoute({
    id: "events-list",
    method: "GET",
    path: "/events",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin", "vendor_manager", "sponsor_user", "ops_user"],
    handler: async ({ query, principal, repos }) => {
      const { status, page = "1", page_size = "20" } = query ?? {};
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(page_size, 10) || 20));

      let events;
      if (principal.role === "platform_admin") {
        events = await repos.events.listByTenant(principal.tenant_id);
      } else {
        const ids = principal.event_ids ?? [];
        events = ids.length > 0
          ? await repos.events.listByIds(principal.tenant_id, ids)
          : [];
      }

      if (status) events = events.filter((e) => e.status === status);

      const total = events.length;
      const paginated = events.slice((pageNum - 1) * pageSize, pageNum * pageSize);

      const withCounts = await Promise.all(
        paginated.map(async (e) => {
          const counts = await computeEventCounts(repos, principal.tenant_id, e.id);
          return formatEvent(e, counts);
        })
      );

      return { events: withCounts, total, page: pageNum, page_size: pageSize };
    }
  });

  // GET /events/:eventId
  router.addRoute({
    id: "events-get",
    method: "GET",
    path: "/events/:eventId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin", "vendor_manager", "sponsor_user", "ops_user"],
    handler: async ({ params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const counts = await computeEventCounts(repos, principal.tenant_id, event.id);
      return formatEvent(event, counts);
    }
  });

  // PATCH /events/:eventId
  router.addRoute({
    id: "events-patch",
    method: "PATCH",
    path: "/events/:eventId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      assertEventEditable(event);

      const updates = {};
      if (body.name !== undefined) {
        const n = String(body.name).trim();
        if (n.length < 2 || n.length > 200) throw new HttpError(400, "name must be 2–200 characters");
        updates.name = n;
      }
      if (body.venue_name !== undefined) updates.venue_name = String(body.venue_name).trim();
      if (body.city !== undefined) updates.city = String(body.city).trim();
      if (body.country !== undefined) updates.country = String(body.country).trim();
      if (body.start_at !== undefined) {
        const d = new Date(body.start_at);
        if (isNaN(d.getTime())) throw new HttpError(400, "start_at must be a valid ISO8601 datetime");
        updates.starts_at = d.toISOString();
      }
      if (body.end_at !== undefined) {
        const d = new Date(body.end_at);
        if (isNaN(d.getTime())) throw new HttpError(400, "end_at must be a valid ISO8601 datetime");
        updates.ends_at = d.toISOString();
      }
      const startsAt = new Date(updates.starts_at ?? event.starts_at ?? 0);
      const endsAt = new Date(updates.ends_at ?? event.ends_at ?? Infinity);
      if (updates.starts_at || updates.ends_at) {
        if (endsAt <= startsAt) throw new HttpError(400, "end_at must be after start_at");
      }

      const updated = await repos.events.update({ ...event, ...updates });
      const counts = await computeEventCounts(repos, principal.tenant_id, updated.id);
      return formatEvent(updated, counts);
    }
  });

  // POST /events/:eventId/publish
  router.addRoute({
    id: "events-publish",
    method: "POST",
    path: "/events/:eventId/publish",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      if (event.status !== "draft") {
        throw new HttpError(400, "INVALID_STATUS_TRANSITION: Event must be in draft status to publish");
      }

      const { items, ready_to_publish } = await computeChecklist(repos, principal.tenant_id, event.id);
      const checklist = {
        has_halls: items.has_halls,
        has_stalls: items.has_stalls,
        has_sponsor_packages: items.has_sponsor_packages,
        has_data_policy: items.has_data_policy,
        has_organizer_admin_user: items.has_organizer_admin_user
      };

      if (!ready_to_publish) {
        const failing_items = Object.entries(checklist)
          .filter(([, v]) => !v)
          .map(([k]) => k.replace(/^has_/, "no_"));
        throw new HttpError(422, "CHECKLIST_INCOMPLETE", { failing_items });
      }

      const updated = await repos.events.update({ ...event, status: "published" });
      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.EVENT_PUBLISHED,
        targetType: "event",
        targetId: updated.id
      });
      return {
        event_id: updated.id,
        status: "published",
        checklist: Object.fromEntries(Object.entries(checklist).map(([k, v]) => [k, v ? "pass" : "fail"]))
      };
    }
  });

  // POST /events/:eventId/go-live
  router.addRoute({
    id: "events-go-live",
    method: "POST",
    path: "/events/:eventId/go-live",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      if (event.status !== "published") {
        throw new HttpError(400, "INVALID_STATUS_TRANSITION: Event must be in published status to go live");
      }

      const { items } = await computeChecklist(repos, principal.tenant_id, event.id);
      const failing_items = [];
      if (!items.has_branding_approved) failing_items.push("branding_not_approved");
      if (!items.has_device_assigned) failing_items.push("no_device_with_recent_heartbeat");

      if (failing_items.length > 0) {
        throw new HttpError(422, "GO_LIVE_BLOCKED", { failing_items });
      }

      const updated = await repos.events.update({ ...event, status: "live" });
      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.EVENT_WENT_LIVE,
        targetType: "event",
        targetId: updated.id
      });
      console.log(`TODO: broadcast config update to assigned devices for event ${event.id} to enable tap ingestion`);
      return { event_id: updated.id, status: "live" };
    }
  });

  // POST /events/:eventId/close
  router.addRoute({
    id: "events-close",
    method: "POST",
    path: "/events/:eventId/close",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      if (event.status !== "live") {
        throw new HttpError(400, "INVALID_STATUS_TRANSITION: Event must be in live status to close");
      }
      if (!body.confirm_event_name || body.confirm_event_name !== event.name) {
        throw new HttpError(400, "CONFIRMATION_NAME_MISMATCH: Type the event name exactly to confirm");
      }

      const updated = await repos.events.update({ ...event, status: "closed" });
      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.EVENT_CLOSED,
        targetType: "event",
        targetId: updated.id
      });
      console.log(`TODO: broadcast config update to assigned devices for event ${event.id} to stop tap ingestion`);
      return { event_id: updated.id, status: "closed" };
    }
  });

  // POST /events/:eventId/archive (platform_admin only)
  router.addRoute({
    id: "events-archive",
    method: "POST",
    path: "/events/:eventId/archive",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    validate: (body) => body ?? {},
    handler: async ({ params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      if (event.status !== "closed") {
        throw new HttpError(400, "INVALID_STATUS_TRANSITION: Event must be in closed status to archive");
      }
      const updated = await repos.events.update({ ...event, status: "archived" });
      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.EVENT_ARCHIVED,
        targetType: "event",
        targetId: updated.id
      });
      console.log(`TODO: mark all event-scoped user_role_assignments as inactive for event ${event.id}`);
      return { event_id: updated.id, status: "archived" };
    }
  });

  // GET /events/:eventId/checklist
  router.addRoute({
    id: "events-checklist",
    method: "GET",
    path: "/events/:eventId/checklist",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const { items, ready_to_publish, ready_to_go_live } = await computeChecklist(
        repos, principal.tenant_id, event.id
      );
      const allPassed = Object.values(items).every(Boolean);
      return {
        event_id: event.id,
        status: allPassed ? "complete" : "incomplete",
        items,
        ready_to_publish,
        ready_to_go_live
      };
    }
  });

  // POST /events/:eventId/data-policy
  router.addRoute({
    id: "events-data-policy",
    method: "POST",
    path: "/events/:eventId/data-policy",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);

      const {
        vendor_exports_enabled,
        sponsor_pii_enabled,
        require_export_approval,
        allow_crm_push,
        retention_days,
        allow_cross_event_identity_graph
      } = body;

      if (retention_days !== undefined && !VALID_RETENTION_DAYS.includes(Number(retention_days))) {
        throw new HttpError(400, "INVALID_RETENTION_DAYS", { valid_values: VALID_RETENTION_DAYS });
      }

      const now = new Date().toISOString();
      const existing = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
      const base = existing.missing_policy_row ? {} : existing;

      const policyFields = {
        vendor_exports_enabled: vendor_exports_enabled ?? base.vendor_exports_enabled ?? false,
        sponsor_pii_enabled: sponsor_pii_enabled ?? base.sponsor_pii_enabled ?? false,
        require_export_approval: require_export_approval ?? base.require_export_approval ?? true,
        allow_crm_push: allow_crm_push ?? base.allow_crm_push ?? false,
        retention_days: Number(retention_days ?? base.retention_days ?? 30),
        allow_cross_event_identity_graph: allow_cross_event_identity_graph ?? base.allow_cross_event_identity_graph ?? false
      };

      const changedFields = Object.keys(policyFields).filter((k) => {
        const incoming = body[k];
        return incoming !== undefined && incoming !== base[k];
      });

      const policy = await repos.eventPolicies.upsert({
        ...base,
        event_id: event.id,
        tenant_id: principal.tenant_id,
        ...policyFields,
        created_at: base.created_at ?? now,
        updated_at: now
      });

      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.EVENT_DATA_POLICY_CHANGED,
        targetType: "event",
        targetId: event.id,
        metadata: {
          changed_fields: changedFields,
          new_values: Object.fromEntries(changedFields.map((k) => [k, policyFields[k]]))
        }
      });

      if (changedFields.length > 0) {
        const changedFieldsDetail = changedFields.map((k) => ({ field: k, old_value: base[k] ?? null, new_value: policyFields[k] }));

        await repos.privacyAuditLogs.create({
          id: nextId("pal"),
          tenant_id: principal.tenant_id,
          event_id: event.id,
          actor_user_id: principal.user_id,
          actor_role: principal.role,
          action: "data_policy.changed",
          target_type: "event",
          target_id: event.id,
          metadata: { changed_fields: changedFieldsDetail, actor_role: principal.role },
          occurred_at: new Date().toISOString()
        });

        // Notify organizer admins
        const allUsers = await repos.users.listByTenant(principal.tenant_id);
        const eventAdmins = allUsers.filter((u) => u.role === "organizer_admin" && u.status === "active" && u.id !== principal.user_id);
        const reviewUrl = `${process.env.PLATFORM_BASE_URL ?? ""}/events/${event.id}/data-policy`;
        for (const admin of eventAdmins) {
          await dispatchTransactionalEmail({
            repos,
            tenantId: principal.tenant_id,
            recipientEmail: admin.email,
            messageType: "data_policy_changed",
            templateVars: {
              organizer_name: admin.display_name ?? "Organizer",
              event_name: event.name,
              changed_fields: changedFieldsDetail,
              actor_role: principal.role,
              occurred_at: new Date().toISOString(),
              review_url: reviewUrl
            },
            actorUserId: principal.user_id
          });
        }
      }

      return { policy };
    }
  });

  // POST /events/:eventId/halls
  router.addRoute({
    id: "halls-create",
    method: "POST",
    path: "/events/:eventId/halls",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      assertEventEditable(event);

      const { name, floor_plan_url } = body;
      if (!name || typeof name !== "string" || name.trim().length < 1) {
        throw new HttpError(400, "name is required");
      }

      const hall = await repos.halls.create({
        id: nextId("hall"),
        tenant_id: principal.tenant_id,
        event_id: event.id,
        name: name.trim(),
        floor_plan_url: floor_plan_url ?? null,
        created_at: new Date().toISOString()
      });
      return { hall_id: hall.id, name: hall.name, event_id: hall.event_id };
    }
  });

  // PATCH /halls/:hallId
  router.addRoute({
    id: "halls-patch",
    method: "PATCH",
    path: "/halls/:hallId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const hall = await repos.halls.findById(principal.tenant_id, params.hallId);
      const event = await repos.events.findById(principal.tenant_id, hall.event_id);
      assertEventScoped(principal, event.id);
      assertEventEditable(event);

      const updates = {};
      if (body.name !== undefined) updates.name = String(body.name).trim();
      if (body.floor_plan_url !== undefined) updates.floor_plan_url = body.floor_plan_url;

      return repos.halls.update({ ...hall, ...updates });
    }
  });

  // DELETE /halls/:hallId
  router.addRoute({
    id: "halls-delete",
    method: "DELETE",
    path: "/halls/:hallId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ params, principal, repos }) => {
      const hall = await repos.halls.findById(principal.tenant_id, params.hallId);
      const event = await repos.events.findById(principal.tenant_id, hall.event_id);
      assertEventScoped(principal, event.id);
      if (event.status !== "draft") {
        throw new HttpError(400, "EVENT_LOCKED: Halls can only be deleted when event is in draft status");
      }
      const stalls = await repos.stalls.listByEvent(principal.tenant_id, event.id);
      const hallStalls = stalls.filter((s) => s.hall_id === hall.id);
      if (hallStalls.length > 0) {
        throw new HttpError(400, "HALL_HAS_STALLS: Remove all stalls before deleting hall");
      }
      await repos.halls.deleteById(principal.tenant_id, hall.id);
      return { deleted: true };
    }
  });

  // POST /events/:eventId/stalls
  router.addRoute({
    id: "stalls-create",
    method: "POST",
    path: "/events/:eventId/stalls",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      assertEventEditable(event);

      const { stall_code, name, hall_id, org_id } = body;
      if (!stall_code || typeof stall_code !== "string") throw new HttpError(400, "stall_code is required");
      if (!name || typeof name !== "string") throw new HttpError(400, "name is required");
      if (!hall_id) throw new HttpError(400, "hall_id is required");

      // verify hall belongs to this event
      const hall = await repos.halls.findById(principal.tenant_id, hall_id);
      if (hall.event_id !== event.id) throw new HttpError(400, "hall_id does not belong to this event");

      // stall_code must be unique within event
      const existing = await repos.stalls.listByEvent(principal.tenant_id, event.id);
      if (existing.some((s) => s.code === stall_code)) {
        throw new HttpError(409, "Stall code already exists for this event");
      }

      const stall = await repos.stalls.create({
        id: nextId("stall"),
        tenant_id: principal.tenant_id,
        event_id: event.id,
        hall_id,
        vendor_organization_id: org_id ?? null,
        sponsor_organization_id: null,
        code: stall_code,
        name: name.trim(),
        created_at: new Date().toISOString()
      });
      return {
        stall_id: stall.id,
        stall_code: stall.code,
        name: stall.name,
        hall_id: stall.hall_id,
        org_id: stall.vendor_organization_id
      };
    }
  });

  // PATCH /stalls/:stallId
  router.addRoute({
    id: "stalls-patch",
    method: "PATCH",
    path: "/stalls/:stallId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId);
      const event = await repos.events.findById(principal.tenant_id, stall.event_id);
      assertEventScoped(principal, event.id);

      if (body.org_id !== undefined && LOCKED_STATUSES.includes(event.status)) {
        throw new HttpError(400, "EVENT_LOCKED: Org assignment changes only allowed when event is draft or published");
      }

      const updates = {};
      if (body.name !== undefined) updates.name = String(body.name).trim();
      if (body.org_id !== undefined) updates.vendor_organization_id = body.org_id;
      if (body.hall_id !== undefined) {
        const hall = await repos.halls.findById(principal.tenant_id, body.hall_id);
        if (hall.event_id !== event.id) throw new HttpError(400, "hall_id does not belong to this event");
        updates.hall_id = body.hall_id;
      }

      const updated = await repos.stalls.update({ ...stall, ...updates });
      return {
        stall_id: updated.id,
        stall_code: updated.code,
        name: updated.name,
        hall_id: updated.hall_id,
        org_id: updated.vendor_organization_id
      };
    }
  });

  // DELETE /stalls/:stallId
  router.addRoute({
    id: "stalls-delete",
    method: "DELETE",
    path: "/stalls/:stallId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ params, principal, repos }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId);
      const event = await repos.events.findById(principal.tenant_id, stall.event_id);
      assertEventScoped(principal, event.id);
      if (event.status !== "draft") {
        throw new HttpError(400, "EVENT_LOCKED: Stalls can only be deleted when event is in draft status");
      }
      const deviceAssignments = await repos.deviceAssignments.listByStall(principal.tenant_id, stall.id);
      if (deviceAssignments.length > 0) {
        throw new HttpError(400, "STALL_HAS_DEVICE: Remove device assignment before deleting stall");
      }
      await repos.stalls.deleteById(principal.tenant_id, stall.id);
      return { deleted: true };
    }
  });

  // POST /events/:eventId/sponsor-packages
  router.addRoute({
    id: "sponsor-packages-create",
    method: "POST",
    path: "/events/:eventId/sponsor-packages",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);

      const { name, tier, org_id } = body;
      if (!name || typeof name !== "string") throw new HttpError(400, "name is required");
      if (!tier || !VALID_TIERS.includes(tier)) {
        throw new HttpError(400, `tier must be one of: ${VALID_TIERS.join(", ")}`);
      }
      if (org_id) {
        const org = await repos.organizations.findById(principal.tenant_id, org_id);
        if (org.type !== "sponsor") throw new HttpError(400, "org_id must reference an org with type 'sponsor'");
      }

      const pkg = await repos.sponsorPackages.create({
        id: nextId("pkg"),
        tenant_id: principal.tenant_id,
        event_id: event.id,
        name: name.trim(),
        tier,
        sponsor_organization_id: org_id ?? null,
        created_at: new Date().toISOString()
      });
      return { package_id: pkg.id, name: pkg.name, tier: pkg.tier, org_id: pkg.sponsor_organization_id };
    }
  });

  // PATCH /sponsor-packages/:packageId
  router.addRoute({
    id: "sponsor-packages-patch",
    method: "PATCH",
    path: "/sponsor-packages/:packageId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ body, params, principal, repos }) => {
      const pkg = await repos.sponsorPackages.findById(principal.tenant_id, params.packageId);
      assertEventScoped(principal, pkg.event_id);

      const updates = {};
      if (body.name !== undefined) updates.name = String(body.name).trim();
      if (body.tier !== undefined) {
        if (!VALID_TIERS.includes(body.tier)) {
          throw new HttpError(400, `tier must be one of: ${VALID_TIERS.join(", ")}`);
        }
        updates.tier = body.tier;
      }
      if (body.org_id !== undefined) {
        if (body.org_id) {
          const org = await repos.organizations.findById(principal.tenant_id, body.org_id);
          if (org.type !== "sponsor") throw new HttpError(400, "org_id must reference an org with type 'sponsor'");
        }
        updates.sponsor_organization_id = body.org_id ?? null;
      }

      const updated = await repos.sponsorPackages.update({ ...pkg, ...updates });
      return { package_id: updated.id, name: updated.name, tier: updated.tier, org_id: updated.sponsor_organization_id };
    }
  });

  // DELETE /sponsor-packages/:packageId
  router.addRoute({
    id: "sponsor-packages-delete",
    method: "DELETE",
    path: "/sponsor-packages/:packageId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ params, principal, repos }) => {
      const pkg = await repos.sponsorPackages.findById(principal.tenant_id, params.packageId);
      assertEventScoped(principal, pkg.event_id);
      // check no sponsor_user role assignments linked to this package
      const allAssignments = await repos.userRoleAssignments.listByTenant(principal.tenant_id);
      const linked = allAssignments.filter((a) => a.sponsor_package_id === pkg.id);
      if (linked.length > 0) {
        throw new HttpError(400, "PACKAGE_HAS_USERS: Remove all user role assignments from this package before deleting");
      }
      await repos.sponsorPackages.deleteById(principal.tenant_id, pkg.id);
      return { deleted: true };
    }
  });

  // GET /stalls/:stallId/users — vendor_managers scoped to this stall
  router.addRoute({
    id: "stalls-users-list",
    method: "GET",
    path: "/stalls/:stallId/users",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ params, principal, repos }) => {
      const stall = await repos.stalls.findById(principal.tenant_id, params.stallId);
      assertEventScoped(principal, stall.event_id);
      const allAssignments = await repos.userRoleAssignments.listByTenant(principal.tenant_id);
      const stalledAssignments = allAssignments.filter(
        (a) => a.role === "vendor_manager" && Array.isArray(a.stall_ids) && a.stall_ids.includes(stall.id)
      );
      const users = await Promise.all(
        stalledAssignments.map(async (a) => {
          const u = await repos.users.findById(principal.tenant_id, a.user_id).catch(() => null);
          if (!u) return null;
          return { id: u.id, full_name: u.display_name, email: u.email, status: u.status, assignment_id: a.id };
        })
      );
      return { users: users.filter(Boolean) };
    }
  });

  // GET /sponsor-packages/:packageId/users — sponsor_users scoped to this package
  router.addRoute({
    id: "sponsor-packages-users-list",
    method: "GET",
    path: "/sponsor-packages/:packageId/users",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ params, principal, repos }) => {
      const pkg = await repos.sponsorPackages.findById(principal.tenant_id, params.packageId);
      assertEventScoped(principal, pkg.event_id);
      const allAssignments = await repos.userRoleAssignments.listByTenant(principal.tenant_id);
      const pkgAssignments = allAssignments.filter(
        (a) => a.role === "sponsor_user" && a.sponsor_package_id === pkg.id
      );
      const users = await Promise.all(
        pkgAssignments.map(async (a) => {
          const u = await repos.users.findById(principal.tenant_id, a.user_id).catch(() => null);
          if (!u) return null;
          return { id: u.id, full_name: u.display_name, email: u.email, status: u.status, assignment_id: a.id };
        })
      );
      return { users: users.filter(Boolean) };
    }
  });

  // GET /devices — list devices for tenant
  router.addRoute({
    id: "devices-list",
    method: "GET",
    path: "/devices",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin", "ops_user"],
    handler: async ({ repos, principal, query }) => {
      let devices = await repos.devices.listByTenant(principal.tenant_id);
      if (query?.status) devices = devices.filter((d) => d.status === query.status);
      if (query?.event_id) {
        const assignments = await repos.deviceAssignments.listByEvent(principal.tenant_id, query.event_id);
        const ids = new Set(assignments.map((a) => a.device_id));
        devices = devices.filter((d) => ids.has(d.id));
      }
      return { devices };
    }
  });

  // POST /devices — create/register a new device
  router.addRoute({
    id: "devices-create",
    method: "POST",
    path: "/devices",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    statusCode: 201,
    validate: (body) => {
      required(body, ["serial_number", "name"]);
      return body;
    },
    handler: async ({ repos, body, principal }) => {
      const now = new Date().toISOString();
      const device = {
        id: nextId("device"),
        tenant_id: principal.tenant_id,
        serial_number: body.serial_number,
        name: body.name,
        hardware_type: body.hardware_type ?? null,
        status: "inventory",
        config_lease_expires_at: null,
        created_at: now
      };
      await repos.devices.create(device);
      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.DEVICE_REGISTERED,
        targetType: "device",
        targetId: device.id,
        metadata: { serial_number: device.serial_number }
      });
      return { device_id: device.id, serial_number: device.serial_number, status: device.status };
    }
  });

  // GET /devices/:deviceId — device detail
  router.addRoute({
    id: "devices-get",
    method: "GET",
    path: "/devices/:deviceId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin", "ops_user"],
    handler: async ({ repos, params, principal }) => {
      const device = await repos.devices.findById(principal.tenant_id, params.deviceId);
      const reader = await repos.nfcReaders.findByDevice(principal.tenant_id, device.id).catch(() => null);
      return { device, nfc_reader: reader ?? null };
    }
  });

  // PATCH /devices/:deviceId — update name or status (repair transitions only)
  router.addRoute({
    id: "devices-patch",
    method: "PATCH",
    path: "/devices/:deviceId",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    validate: (body) => body ?? {},
    handler: async ({ repos, params, body, principal }) => {
      const device = await repos.devices.findById(principal.tenant_id, params.deviceId);
      if (body.status !== undefined) {
        const allowed = new Map([["inventory", "repair"], ["repair", "inventory"]]);
        if (!allowed.has(device.status) || allowed.get(device.status) !== body.status) {
          throw new HttpError(400, "INVALID_STATUS_TRANSITION");
        }
      }
      const updated = { ...device, ...body, id: device.id, tenant_id: device.tenant_id };
      await repos.devices.update(updated);
      return { device: updated };
    }
  });

  // POST /devices/:deviceId/assign — assign device to a stall
  router.addRoute({
    id: "devices-assign",
    method: "POST",
    path: "/devices/:deviceId/assign",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin", "ops_user"],
    validate: (body) => {
      required(body, ["stall_id", "event_id"]);
      return body;
    },
    handler: async ({ repos, body, params, principal }) => {
      const device = await repos.devices.findById(principal.tenant_id, params.deviceId);
      if (device.status === "assigned" || device.status === "live") {
        throw new HttpError(409, "DEVICE_ALREADY_ASSIGNED");
      }
      const stall = await repos.stalls.findById(principal.tenant_id, body.stall_id);
      assertEventScoped(principal, stall.event_id);

      const existingAssignments = await repos.deviceAssignments.listByStall(principal.tenant_id, body.stall_id);
      if (existingAssignments.some((a) => a.active)) {
        throw new HttpError(409, "STALL_ALREADY_HAS_DEVICE");
      }

      const now = new Date().toISOString();
      const assignment = {
        id: nextId("assign"),
        tenant_id: principal.tenant_id,
        device_id: device.id,
        event_id: body.event_id,
        stall_id: body.stall_id,
        active: true,
        starts_at: body.starts_at ?? now,
        ends_at: body.ends_at ?? null,
        created_at: now
      };
      await repos.deviceAssignments.create(assignment);

      device.status = "assigned";
      await repos.devices.update(device);

      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.DEVICE_ASSIGNED,
        targetType: "device",
        targetId: device.id,
        metadata: { stall_id: body.stall_id, event_id: body.event_id }
      });

      return { device_id: device.id, status: "assigned", stall_id: body.stall_id, event_id: body.event_id };
    }
  });

  // POST /devices/:deviceId/unassign — unassign a device
  router.addRoute({
    id: "devices-unassign",
    method: "POST",
    path: "/devices/:deviceId/unassign",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin", "ops_user"],
    validate: (body) => body ?? {},
    handler: async ({ repos, params, principal }) => {
      const device = await repos.devices.findById(principal.tenant_id, params.deviceId);
      if (device.status !== "assigned") {
        throw new HttpError(400, "INVALID_STATUS_TRANSITION: Device must be in assigned status to unassign");
      }

      const assignments = await repos.deviceAssignments.listByEvent(principal.tenant_id, device.id).catch(() => []);
      const stallAssignments = (await Promise.all(
        (await repos.deviceAssignments.listByEvent(principal.tenant_id, device.id).catch(() => [])).map(async (a) => a)
      ));

      const allActive = (await repos.deviceAssignments.findActiveByDeviceId(principal.tenant_id, device.id).catch(() => null));
      if (allActive) {
        allActive.active = false;
        allActive.ended_at = new Date().toISOString();
        await repos.deviceAssignments.update(allActive);
      }

      device.status = "inventory";
      await repos.devices.update(device);

      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.DEVICE_UNASSIGNED,
        targetType: "device",
        targetId: device.id
      });

      return { device_id: device.id, status: "inventory" };
    }
  });

  // POST /devices/:deviceId/retire — retire a device
  router.addRoute({
    id: "devices-retire",
    method: "POST",
    path: "/devices/:deviceId/retire",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    validate: (body) => body ?? {},
    handler: async ({ repos, params, principal }) => {
      const device = await repos.devices.findById(principal.tenant_id, params.deviceId);
      if (device.status === "live") {
        throw new HttpError(400, "CANNOT_RETIRE_LIVE_DEVICE");
      }
      if (device.status === "assigned") {
        throw new HttpError(400, "CANNOT_RETIRE_ASSIGNED_DEVICE: Unassign device first");
      }
      device.status = "retired";
      await repos.devices.update(device);

      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.DEVICE_RETIRED,
        targetType: "device",
        targetId: device.id
      });

      return { device_id: device.id, status: "retired" };
    }
  });

  // POST /nfc-readers — pair NFC reader to device
  router.addRoute({
    id: "nfc-readers-create",
    method: "POST",
    path: "/nfc-readers",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin", "ops_user"],
    statusCode: 201,
    validate: (body) => {
      required(body, ["device_id"]);
      return body;
    },
    handler: async ({ repos, body, principal }) => {
      await repos.devices.findById(principal.tenant_id, body.device_id);
      const now = new Date().toISOString();
      const reader = {
        id: nextId("nfc"),
        tenant_id: principal.tenant_id,
        device_id: body.device_id,
        model: body.model ?? "ACR122U",
        firmware_version: body.firmware_version ?? null,
        created_at: now,
        updated_at: now
      };
      await repos.nfcReaders.create(reader);
      return { reader_id: reader.id, device_id: reader.device_id, model: reader.model, firmware_version: reader.firmware_version };
    }
  });

  // PATCH /nfc-readers/:readerId — update reader firmware or model
  router.addRoute({
    id: "nfc-readers-patch",
    method: "PATCH",
    path: "/nfc-readers/:readerId",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin", "ops_user"],
    validate: (body) => body ?? {},
    handler: async ({ repos, params, body, principal }) => {
      const reader = await repos.nfcReaders.findById(principal.tenant_id, params.readerId);
      const updated = { ...reader, ...body, id: reader.id, tenant_id: reader.tenant_id, device_id: reader.device_id, updated_at: new Date().toISOString() };
      await repos.nfcReaders.update(updated);
      return { reader: updated };
    }
  });

  // GET /events/:eventId/branding — get branding config
  router.addRoute({
    id: "events-branding-get",
    method: "GET",
    path: "/events/:eventId/branding",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    handler: async ({ repos, params, principal }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const branding = await repos.brandingAssets.findActiveByEvent(principal.tenant_id, event.id);
      if (!branding) {
        return { branding: null, is_default: true };
      }
      return { branding, is_default: false };
    }
  });

  // POST /events/:eventId/branding — save branding config
  router.addRoute({
    id: "events-branding-save",
    method: "POST",
    path: "/events/:eventId/branding",
    authRequired: true,
    allowedRoles: ["platform_admin", "organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ repos, params, body, principal }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const now = new Date().toISOString();
      const existing = await repos.brandingAssets.findActiveByEvent(principal.tenant_id, event.id);
      if (existing) {
        const updated = { ...existing, ...body, updated_at: now };
        await repos.brandingAssets.update(updated);
        return { branding: updated };
      }
      const branding = {
        id: nextId("branding"),
        tenant_id: principal.tenant_id,
        event_id: event.id,
        status: "active",
        branding_approved: false,
        ...body,
        created_at: now,
        updated_at: now
      };
      await repos.brandingAssets.create(branding);
      return { branding };
    }
  });

  // POST /events/:eventId/branding/approve — approve branding
  router.addRoute({
    id: "events-branding-approve",
    method: "POST",
    path: "/events/:eventId/branding/approve",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, params, principal }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      const branding = await repos.brandingAssets.findActiveByEvent(principal.tenant_id, event.id);
      if (!branding) {
        throw new HttpError(404, "No branding config found for this event");
      }
      const updated = { ...branding, branding_approved: true, updated_at: new Date().toISOString() };
      await repos.brandingAssets.update(updated);
      return { branding: updated };
    }
  });

  const VALID_BG_ACCESS_SCOPES = new Set(["interaction_pii", "attendee_pii", "export_review", "incident_debug"]);
  const VALID_BG_DURATIONS = new Set([30, 60, 120, 240]);

  // POST /admin/break-glass/request
  router.addRoute({
    id: "admin-break-glass-request",
    method: "POST",
    path: "/admin/break-glass/request",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    statusCode: 201,
    validate: (body) => {
      if (!body?.justification || typeof body.justification !== "string" || body.justification.trim().length < 20) {
        throw new HttpError(400, "justification must be at least 20 characters");
      }
      if (!body.access_scope || !VALID_BG_ACCESS_SCOPES.has(body.access_scope)) {
        throw new HttpError(400, `access_scope must be one of: ${[...VALID_BG_ACCESS_SCOPES].join(", ")}`);
      }
      const dur = Number(body.requested_duration_minutes);
      if (!VALID_BG_DURATIONS.has(dur)) {
        throw new HttpError(400, `requested_duration_minutes must be one of: ${[...VALID_BG_DURATIONS].join(", ")}`);
      }
      return body;
    },
    handler: async ({ repos, body, principal }) => {
      const now = new Date().toISOString();
      const request = {
        id: nextId("bg"),
        tenant_id: principal.tenant_id,
        requested_by_user_id: principal.user_id,
        approved_by_user_id: null,
        rejected_by_user_id: null,
        rejection_reason: null,
        justification: body.justification.trim(),
        access_scope: body.access_scope,
        event_id: body.event_id ?? null,
        requested_duration_minutes: Number(body.requested_duration_minutes),
        status: "requested",
        starts_at: null,
        expires_at: null,
        revoked_at: null,
        created_at: now
      };
      await repos.breakGlassAccess.create(request);

      const requester = await repos.users.findById(principal.tenant_id, principal.user_id).catch(() => null);
      const allUsers = await repos.users.listByTenant(principal.tenant_id);
      const otherAdmins = allUsers.filter((u) => u.role === "platform_admin" && u.id !== principal.user_id);
      for (const admin of otherAdmins) {
        await dispatchTransactionalEmail({
          repos,
          tenantId: principal.tenant_id,
          recipientEmail: admin.email,
          messageType: "break_glass_pending_approval",
          templateVars: {
            requester_name: requester?.display_name ?? "A platform admin",
            justification: body.justification
          },
          actorUserId: principal.user_id
        });
      }

      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.BREAK_GLASS_REQUESTED,
        targetType: "break_glass_request",
        targetId: request.id,
        metadata: { access_scope: request.access_scope }
      });

      return { id: request.id, status: "requested" };
    }
  });

  // GET /admin/break-glass — list all requests
  router.addRoute({
    id: "admin-break-glass-list",
    method: "GET",
    path: "/admin/break-glass",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, principal, query }) => {
      const allUsers = await repos.users.listByTenant(principal.tenant_id);
      const nameOf = (id) => allUsers.find((u) => u.id === id)?.display_name ?? id ?? null;

      let items = await repos.breakGlassAccess.listByTenant(principal.tenant_id);
      if (query?.status) items = items.filter((r) => r.status === query.status);

      return {
        items: items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).map((r) => ({
          id: r.id,
          requested_by_name: nameOf(r.requested_by_user_id),
          access_scope: r.access_scope,
          justification: r.justification,
          event_id: r.event_id ?? null,
          requested_duration_minutes: r.requested_duration_minutes ?? null,
          status: r.status,
          created_at: r.created_at,
          approved_by_name: nameOf(r.approved_by_user_id),
          starts_at: r.starts_at ?? null,
          expires_at: r.expires_at ?? null
        }))
      };
    }
  });

  // GET /admin/break-glass/:requestId — single request detail
  router.addRoute({
    id: "admin-break-glass-get",
    method: "GET",
    path: "/admin/break-glass/:requestId",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, params, principal }) => {
      const request = await repos.breakGlassAccess.findById(principal.tenant_id, params.requestId);
      const allUsers = await repos.users.listByTenant(principal.tenant_id);
      const nameOf = (id) => allUsers.find((u) => u.id === id)?.display_name ?? id ?? null;
      return {
        ...request,
        requested_by_name: nameOf(request.requested_by_user_id),
        approved_by_name: nameOf(request.approved_by_user_id ?? null)
      };
    }
  });

  // POST /admin/break-glass/:requestId/approve
  router.addRoute({
    id: "admin-break-glass-approve",
    method: "POST",
    path: "/admin/break-glass/:requestId/approve",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    validate: (body) => body ?? {},
    handler: async ({ repos, params, principal }) => {
      const request = await repos.breakGlassAccess.findById(principal.tenant_id, params.requestId);
      if (request.requested_by_user_id === principal.user_id) {
        throw new HttpError(403, "SELF_APPROVAL_FORBIDDEN");
      }
      if (request.status !== "requested") {
        throw new HttpError(400, "INVALID_STATUS_TRANSITION");
      }
      const now = new Date();
      const durationMs = (request.requested_duration_minutes ?? 60) * 60 * 1000;
      const starts_at = now.toISOString();
      const expires_at = new Date(now.getTime() + durationMs).toISOString();

      const updated = {
        ...request,
        approved_by_user_id: principal.user_id,
        status: "active",
        starts_at,
        expires_at
      };
      await repos.breakGlassAccess.update(updated);

      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.BREAK_GLASS_APPROVED,
        targetType: "break_glass_request",
        targetId: request.id,
        metadata: { approved_by: principal.user_id, expires_at }
      });

      // SG11: Notify organizer_admin users of break-glass access
      const allUsers = await repos.users.listByTenant(principal.tenant_id);
      const organizerAdmins = allUsers.filter((u) => u.role === "organizer_admin" && u.status === "active");
      const tenantsList = await repos.tenants.listAll();
      const tenantRecord = tenantsList.find((t) => t.id === principal.tenant_id);
      for (const admin of organizerAdmins) {
        await dispatchTransactionalEmail({
          repos,
          tenantId: principal.tenant_id,
          recipientEmail: admin.email,
          messageType: "break_glass_organizer_alert",
          templateVars: {
            organizer_name: admin.display_name ?? "Organizer",
            requester_role: "platform_admin",
            access_scope: request.access_scope,
            justification: request.justification,
            event_name: tenantRecord?.name ?? "your event",
            duration_minutes: request.requested_duration_minutes ?? null,
            platform_access_log_url: `${process.env.PLATFORM_BASE_URL ?? ""}/events/platform-access-log`
          },
          actorUserId: principal.user_id
        });
      }

      await repos.privacyAuditLogs.create({
        id: nextId("pal"),
        tenant_id: principal.tenant_id,
        event_id: null,
        actor_user_id: principal.user_id,
        actor_role: "platform_admin",
        action: "break_glass.accessed",
        target_type: "break_glass_access",
        target_id: updated.id,
        metadata: { access_scope: request.access_scope, justification: request.justification },
        occurred_at: new Date().toISOString()
      });

      return { id: updated.id, status: "active", expires_at };
    }
  });

  // POST /admin/break-glass/:requestId/reject
  router.addRoute({
    id: "admin-break-glass-reject",
    method: "POST",
    path: "/admin/break-glass/:requestId/reject",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    validate: (body) => {
      if (!body?.rejection_reason || typeof body.rejection_reason !== "string") {
        throw new HttpError(400, "rejection_reason is required");
      }
      return body;
    },
    handler: async ({ repos, params, body, principal }) => {
      const request = await repos.breakGlassAccess.findById(principal.tenant_id, params.requestId);
      if (request.requested_by_user_id === principal.user_id) {
        throw new HttpError(403, "SELF_APPROVAL_FORBIDDEN");
      }
      if (request.status !== "requested") {
        throw new HttpError(400, "INVALID_STATUS_TRANSITION");
      }
      const updated = {
        ...request,
        rejected_by_user_id: principal.user_id,
        rejection_reason: body.rejection_reason,
        status: "rejected"
      };
      await repos.breakGlassAccess.update(updated);

      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.BREAK_GLASS_REJECTED,
        targetType: "break_glass_request",
        targetId: request.id,
        metadata: { rejected_by: principal.user_id }
      });

      return { id: updated.id, status: "rejected" };
    }
  });

  // POST /admin/break-glass/:requestId/revoke
  router.addRoute({
    id: "admin-break-glass-revoke",
    method: "POST",
    path: "/admin/break-glass/:requestId/revoke",
    authRequired: true,
    allowedRoles: ["platform_admin"],
    validate: (body) => body ?? {},
    handler: async ({ repos, params, principal }) => {
      const request = await repos.breakGlassAccess.findById(principal.tenant_id, params.requestId);
      if (request.status !== "active") {
        throw new HttpError(400, "INVALID_STATUS_TRANSITION: Only active sessions can be revoked");
      }
      const updated = {
        ...request,
        status: "revoked",
        revoked_at: new Date().toISOString()
      };
      await repos.breakGlassAccess.update(updated);

      await writeAuditEvent(repos, {
        tenantId: principal.tenant_id,
        actorType: "user",
        actorId: principal.actor_id,
        eventType: AUDIT_EVENT_TYPES.BREAK_GLASS_REVOKED,
        targetType: "break_glass_request",
        targetId: request.id
      });

      return { id: updated.id, status: "revoked" };
    }
  });

  // ══════════════════════════════════════════════════════════════
  // PHASE 15 — Sovereignty Backend Services (SG1-SG11)
  // ══════════════════════════════════════════════════════════════

  async function writePrivacyAudit(repos, { tenantId, eventId = null, actorUserId = null, actorRole, action, targetType = null, targetId = null, metadata = null }) {
    return repos.privacyAuditLogs.create({
      id: nextId("pal"),
      tenant_id: tenantId,
      event_id: eventId,
      actor_user_id: actorUserId,
      actor_role: actorRole,
      action,
      target_type: targetType,
      target_id: targetId,
      metadata: metadata ?? null,
      occurred_at: new Date().toISOString()
    });
  }

  const SOVEREIGNTY_WEBHOOK_EVENTS = new Set([
    "data_policy.changed", "break_glass.accessed", "export.downloaded",
    "retention.purge_completed", "dsr.submitted", "dsr.completed"
  ]);

  async function dispatchSovereigntyWebhook(repos, tenantId, eventId, eventType, data) {
    if (!SOVEREIGNTY_WEBHOOK_EVENTS.has(eventType)) return;
    const subscriptions = repos.webhookSubscriptions?.listByEvent
      ? (await repos.webhookSubscriptions.listByEvent(tenantId, eventId))
          .filter((s) => s.status === "active" && Array.isArray(s.event_types) && s.event_types.includes(eventType))
      : [];
    const payload = { event_type: eventType, fired_at: new Date().toISOString(), event_id: eventId, data };
    for (const sub of subscriptions) {
      fetch(sub.target_url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-event": eventType },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000)
      }).catch(() => {});
    }
  }

  // ── Step 15.1: Platform access log (SG1, SG8) ────────────────

  router.addRoute({
    id: "platform-access-log",
    method: "GET",
    path: "/events/:eventId/platform-access-log",
    allowedRoles: ["organizer_admin"],
    handler: async ({ repos, params, principal, query }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const { action_type, from, to, outcome, page: pageStr, page_size: pageSizeStr } = query;
      const page = Math.max(1, parseInt(pageStr ?? "1", 10) || 1);
      const pageSize = Math.min(100, Math.max(1, parseInt(pageSizeStr ?? "20", 10) || 20));
      let logs = (await repos.auditLogs.listByTenant(principal.tenant_id))
        .filter((e) => e.actor_role_category === "internal_platform" && e.target_id === event.id);
      if (action_type) logs = logs.filter((e) => e.event_type === action_type);
      if (from) logs = logs.filter((e) => e.created_at >= from);
      if (to) logs = logs.filter((e) => e.created_at <= to);
      if (outcome) {
        logs = outcome === "success"
          ? logs.filter((e) => !e.event_type.endsWith(".failed") && !e.event_type.endsWith(".denied"))
          : logs.filter((e) => e.event_type.endsWith(".failed") || e.event_type.endsWith(".denied"));
      }
      const total = logs.length;
      const items = logs.slice((page - 1) * pageSize, page * pageSize).map((e) => ({
        id: e.id,
        occurred_at: e.created_at,
        actor_role: e.actor_role_category,
        action_type: e.event_type,
        target_resource: e.target_type,
        justification: e.break_glass_access_id ? (e.metadata?.justification ?? null) : null,
        session_duration_minutes: e.break_glass_access_id ? (e.metadata?.session_duration_minutes ?? null) : null,
        outcome: e.event_type.endsWith(".failed") || e.event_type.endsWith(".denied") ? "denied" : "success"
      }));
      return { items, total, page, page_size: pageSize };
    },
    auditEventType: "platform_access_log.viewed"
  });

  router.addRoute({
    id: "platform-access-log-export",
    method: "GET",
    path: "/events/:eventId/platform-access-log/export",
    allowedRoles: ["organizer_admin"],
    handler: async ({ repos, params, principal }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const logs = (await repos.auditLogs.listByTenant(principal.tenant_id))
        .filter((e) => e.actor_role_category === "internal_platform" && e.target_id === event.id);
      const header = "id,occurred_at,actor_role,action_type,target_resource,outcome";
      const rows = logs.map((e) =>
        [e.id, e.created_at, e.actor_role_category, e.event_type, e.target_type,
          e.event_type.endsWith(".failed") || e.event_type.endsWith(".denied") ? "denied" : "success"
        ].join(",")
      );
      await writePrivacyAudit(repos, {
        tenantId: principal.tenant_id, eventId: event.id, actorUserId: principal.user_id,
        actorRole: principal.role, action: "privacy_log_exported", targetType: "event", targetId: event.id
      });
      return { csv: [header, ...rows].join("\n"), row_count: rows.length, exported_at: new Date().toISOString() };
    },
    auditEventType: "platform_access_log.exported"
  });

  // ── Step 15.4: Full event data export (SG2) ──────────────────

  const VALID_EXPORT_INCLUDES = ["interactions", "consents", "leads_metadata", "event_config", "platform_access_log", "audit_trail", "attendee_data"];
  const VALID_EXPORT_FORMATS = ["json", "csv", "zip"];

  router.addRoute({
    id: "full-export-create",
    method: "POST",
    path: "/events/:eventId/full-export",
    allowedRoles: ["organizer_admin"],
    statusCode: 201,
    validate: (body) => body ?? {},
    handler: async ({ repos, params, principal, body, state }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const include = body.include ?? VALID_EXPORT_INCLUDES;
      const format = body.format ?? "json";
      if (!VALID_EXPORT_FORMATS.includes(format)) throw new HttpError(400, "INVALID_FORMAT", { valid: VALID_EXPORT_FORMATS });
      const invalid = include.filter((c) => !VALID_EXPORT_INCLUDES.includes(c));
      if (invalid.length) throw new HttpError(400, "INVALID_INCLUDE_CATEGORIES", { invalid });
      const allExports = await repos.exportRequests.listByEvent(principal.tenant_id, event.id);
      const inProgress = allExports.find((e) => e.export_type.startsWith("full_event_export") && e.status === "requested");
      if (inProgress) throw new HttpError(409, "EXPORT_IN_PROGRESS", { export_id: inProgress.id });
      const exportRequest = await repos.exportRequests.create({
        id: nextId("export"), tenant_id: principal.tenant_id, event_id: event.id,
        requested_by_user_id: principal.user_id, export_type: `full_event_export_${format}`,
        filters: { include, format }, status: "requested", approval_required: false,
        download_used: false, created_at: new Date().toISOString()
      });
      await writePrivacyAudit(repos, {
        tenantId: principal.tenant_id, eventId: event.id, actorUserId: principal.user_id,
        actorRole: principal.role, action: "full_export.requested", targetType: "export_request", targetId: exportRequest.id
      });
      setImmediate(() => {
        processFullExportJob(repos, state, exportRequest.id).catch((err) => {
          console.error(`[routes] Full export worker error for ${exportRequest.id}:`, err);
        });
      });
      return { export_id: exportRequest.id, status: "requested", message: "Export is being prepared. You will be notified when ready." };
    },
    auditEventType: "full_export.created"
  });

  router.addRoute({
    id: "full-export-status",
    method: "GET",
    path: "/events/:eventId/full-export/status",
    allowedRoles: ["organizer_admin"],
    handler: async ({ repos, params, principal }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const allExports = await repos.exportRequests.listByEvent(principal.tenant_id, event.id);
      const latest = allExports
        .filter((e) => e.export_type.startsWith("full_event_export"))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
      if (!latest) return { export_id: null, status: "none", created_at: null, estimated_completion: null, download_available: false };
      return { export_id: latest.id, status: latest.status, created_at: latest.created_at,
        estimated_completion: null, download_available: latest.status === "completed" && !latest.download_used };
    }
  });

  router.addRoute({
    id: "full-export-download",
    method: "GET",
    path: "/events/:eventId/full-export/download",
    allowedRoles: ["organizer_admin"],
    handler: async ({ repos, params, principal }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const allExports = await repos.exportRequests.listByEvent(principal.tenant_id, event.id);
      const latest = allExports
        .filter((e) => e.export_type.startsWith("full_event_export") && e.status === "completed")
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
      if (!latest) throw new HttpError(404, "NO_COMPLETED_EXPORT");
      if (latest.download_used) throw new HttpError(410, "DOWNLOAD_ALREADY_USED", { message: "This download link has already been used. Request a new export." });
      await repos.exportRequests.update({ ...latest, download_used: true, download_used_at: new Date().toISOString() });
      await writePrivacyAudit(repos, {
        tenantId: principal.tenant_id, eventId: event.id, actorUserId: principal.user_id,
        actorRole: principal.role, action: "full_export.downloaded", targetType: "export_request", targetId: latest.id
      });
      await dispatchSovereigntyWebhook(repos, principal.tenant_id, event.id, "export.downloaded", {
        event_id: event.id, export_type: latest.export_type, export_id: latest.id, actor_role: principal.role, occurred_at: new Date().toISOString()
      });
      const downloadUrl = latest.export_file_url ?? `${process.env.PLATFORM_BASE_URL ?? "http://localhost:3000"}/exports/${latest.id}/file`;
      return { export_id: latest.id, download_url: downloadUrl, expires_at: latest.export_expires_at ?? new Date(Date.now() + 15 * 60 * 1000).toISOString() };
    },
    auditEventType: "full_export.downloaded"
  });

  router.addRoute({
    id: "full-export-history",
    method: "GET",
    path: "/events/:eventId/full-export/history",
    allowedRoles: ["organizer_admin"],
    handler: async ({ repos, params, principal }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const allExports = await repos.exportRequests.listByEvent(principal.tenant_id, event.id);
      return { items: allExports.filter((e) => e.export_type.startsWith("full_event_export"))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
        .map((e) => ({ export_id: e.id, export_type: e.export_type, status: e.status, created_at: e.created_at, download_used: e.download_used ?? false })) };
    }
  });

  // ── Step 15.5: DSR endpoints (SG7) ───────────────────────────

  router.addRoute({
    id: "privacy-dsr-create",
    method: "POST",
    path: "/attendee/privacy/dsr",
    authRequired: false,
    statusCode: 201,
    validate: (body) => body ?? {},
    handler: async ({ repos, body, state }) => {
      const { request_type, event_id, attendee_id, session_token } = body;
      if (!["export", "delete"].includes(request_type)) throw new HttpError(400, "request_type must be export or delete");
      if (!event_id) throw new HttpError(400, "event_id is required");
      let resolvedAttendeeId = attendee_id;
      let tenantId;
      if (session_token) {
        const session = verifyAttendeeSessionToken(session_token, state.sessionSecret);
        tenantId = session.tenant_id;
        resolvedAttendeeId = session.attendee_id ?? resolvedAttendeeId;
      }
      if (!resolvedAttendeeId) throw new HttpError(400, "attendee_id is required");
      const event = await repos.events.findById(tenantId ?? state.tenants[0]?.id, event_id);
      tenantId = tenantId ?? event.tenant_id;
      const existing = await repos.dataSubjectRequests.findActiveByAttendeeEventType(tenantId, resolvedAttendeeId, event_id, request_type);
      if (existing) throw new HttpError(409, "DSR_ALREADY_IN_PROGRESS", { dsr_id: existing.id });
      const now = new Date().toISOString();
      const dsr = await repos.dataSubjectRequests.create({
        id: nextId("dsr"), tenant_id: tenantId, event_id, attendee_id: resolvedAttendeeId,
        request_type, status: "requested", submitted_at: now, created_at: now,
        export_file_url: null, export_expires_at: null, metadata: null
      });
      await writePrivacyAudit(repos, {
        tenantId, eventId: event_id, actorRole: "attendee_action", action: "dsr.submitted",
        targetType: "data_subject_request", targetId: dsr.id
      });
      await dispatchSovereigntyWebhook(repos, tenantId, event_id, "dsr.submitted", { event_id, request_type, occurred_at: now });
      setImmediate(() => {
        processDSRJob(repos, state, dsr.id).catch((err) => {
          console.error(`[routes] DSR worker error for ${dsr.id}:`, err);
        });
      });
      return { dsr_id: dsr.id, status: "requested" };
    }
  });

  router.addRoute({
    id: "privacy-dsr-list",
    method: "GET",
    path: "/attendee/privacy/dsr",
    authRequired: false,
    handler: async ({ repos, query, state }) => {
      const { session_token, attendee_id } = query;
      let resolvedAttendeeId = attendee_id;
      let tenantId;
      if (session_token) {
        const session = verifyAttendeeSessionToken(session_token, state.sessionSecret);
        tenantId = session.tenant_id;
        resolvedAttendeeId = session.attendee_id ?? resolvedAttendeeId;
      }
      if (!resolvedAttendeeId) throw new HttpError(400, "attendee_id or session_token is required");
      tenantId = tenantId ?? state.tenants[0]?.id;
      const items = await repos.dataSubjectRequests.listByAttendee(tenantId, resolvedAttendeeId);
      return { items: items.map((d) => ({ id: d.id, request_type: d.request_type, status: d.status, submitted_at: d.submitted_at ?? d.created_at, completed_at: d.completed_at ?? null })) };
    }
  });

  router.addRoute({
    id: "privacy-dsr-download",
    method: "GET",
    path: "/attendee/privacy/dsr/:dsrId/download",
    authRequired: false,
    handler: async ({ repos, params, query, state }) => {
      const { session_token } = query;
      let tenantId;
      if (session_token) {
        const session = verifyAttendeeSessionToken(session_token, state.sessionSecret);
        tenantId = session.tenant_id;
      }
      tenantId = tenantId ?? state.tenants[0]?.id;
      const dsr = await repos.dataSubjectRequests.findById(tenantId, params.dsrId);
      if (dsr.request_type !== "export") throw new HttpError(400, "DSR_NOT_EXPORT_TYPE");
      if (dsr.status !== "completed") throw new HttpError(400, "DSR_NOT_COMPLETED");
      if (dsr.download_used) throw new HttpError(410, "DOWNLOAD_ALREADY_USED", { message: "This download has already been used." });
      await repos.dataSubjectRequests.update({ ...dsr, download_used: true, download_used_at: new Date().toISOString() });
      return { dsr_id: dsr.id, download_url: dsr.export_file_url ?? `${process.env.PLATFORM_BASE_URL ?? "https://placeholder.example.com"}/dsr/${dsr.id}/file`, expires_at: dsr.export_expires_at ?? new Date(Date.now() + 15 * 60 * 1000).toISOString() };
    }
  });

  router.addRoute({
    id: "event-privacy-requests-list",
    method: "GET",
    path: "/events/:eventId/privacy-requests",
    allowedRoles: ["organizer_admin"],
    handler: async ({ repos, params, principal, query }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const filters = {
        request_type: query.request_type, status: query.status,
        page: parseInt(query.page ?? "1", 10) || 1,
        page_size: Math.min(100, parseInt(query.page_size ?? "20", 10) || 20)
      };
      const result = await repos.dataSubjectRequests.listByEventFiltered(principal.tenant_id, event.id, filters);
      return { items: result.items.map((d) => ({ id: d.id, request_type: d.request_type, status: d.status, submitted_at: d.submitted_at ?? d.created_at, completed_at: d.completed_at ?? null })), total: result.total, page: filters.page, page_size: filters.page_size };
    }
  });

  router.addRoute({
    id: "event-privacy-request-detail",
    method: "GET",
    path: "/events/:eventId/privacy-requests/:dsrId",
    allowedRoles: ["organizer_admin"],
    handler: async ({ repos, params, principal }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const dsr = await repos.dataSubjectRequests.findById(principal.tenant_id, params.dsrId);
      if (dsr.event_id !== event.id) throw new HttpError(403, "DSR not associated with this event");
      const response = {
        id: dsr.id,
        request_type: dsr.request_type,
        status: dsr.status,
        submitted_at: dsr.submitted_at ?? dsr.created_at,
        completed_at: dsr.completed_at ?? null,
        rejection_reason: dsr.rejection_reason ?? null,
        metadata: dsr.metadata ?? null
      };
      if (dsr.request_type === "delete" && dsr.attendee_id) {
        const crmJobs = await repos.crmSyncJobs.findByAttendeeId(dsr.attendee_id);
        response.crm_deletion_attempts = crmJobs
          .filter((j) => j.external_record_id)
          .map((j) => ({
            provider: j.provider ?? null,
            external_record_id: j.external_record_id ? j.external_record_id.slice(0, 8) + "…" : null,
            deletion_status: j.deletion_status ?? null,
            deletion_error: j.deletion_error ?? null
          }));
      }
      return response;
    }
  });

  router.addRoute({
    id: "event-privacy-request-reject",
    method: "POST",
    path: "/events/:eventId/privacy-requests/:dsrId/reject",
    allowedRoles: ["organizer_admin"],
    validate: (body) => body ?? {},
    handler: async ({ repos, params, principal, body }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const dsr = await repos.dataSubjectRequests.findById(principal.tenant_id, params.dsrId);
      if (dsr.event_id !== event.id) throw new HttpError(403, "DSR not associated with this event");
      if (dsr.status !== "requested") throw new HttpError(400, "DSR_NOT_REJECTABLE", { current_status: dsr.status });
      if (!body.rejection_reason || typeof body.rejection_reason !== "string") throw new HttpError(400, "rejection_reason is required");
      await repos.dataSubjectRequests.update({ ...dsr, status: "rejected", rejection_reason: body.rejection_reason, completed_at: new Date().toISOString() });
      return { id: dsr.id, status: "rejected" };
    },
    auditEventType: "dsr.rejected"
  });

  // ── Step 15.6: Tenant offboarding (SG6) ──────────────────────

  router.addRoute({
    id: "tenant-offboard-initiate",
    method: "POST",
    path: "/admin/tenants/:tenantId/offboard",
    allowedRoles: ["platform_admin"],
    statusCode: 201,
    validate: (body) => body ?? {},
    handler: async ({ repos, params, principal, body }) => {
      const tenant = await repos.tenants.findById(params.tenantId);
      if (!tenant) throw new HttpError(404, "Tenant not found");
      const validPaths = ["export_then_delete", "immediate_delete", "grace_period_delete"];
      if (!body.data_handling_path || !validPaths.includes(body.data_handling_path)) throw new HttpError(400, "INVALID_DATA_HANDLING_PATH", { valid: validPaths });
      if (body.data_handling_path === "grace_period_delete" && !body.grace_period_days) throw new HttpError(400, "grace_period_days is required for grace_period_delete");
      if (body.confirm_tenant_slug !== tenant.slug) throw new HttpError(400, "CONFIRMATION_SLUG_MISMATCH", { message: "confirm_tenant_slug must exactly match the tenant slug" });
      const now = new Date().toISOString();
      const job = await repos.tenantOffboardingJobs.create({
        id: nextId("offboard"), tenant_id: tenant.id, initiated_by_user_id: principal.user_id,
        approved_by_user_id: null, data_handling_path: body.data_handling_path,
        grace_period_days: body.grace_period_days ?? null, status: "awaiting_approval",
        export_file_url: null, deletion_certificate_url: null, scheduled_deletion_at: null, completed_at: null, created_at: now
      });
      await repos.tenants.update({ ...tenant, offboarding_status: "offboarding_initiated", offboarding_initiated_at: now });
      await writePrivacyAudit(repos, { tenantId: tenant.id, actorUserId: principal.user_id, actorRole: "platform_admin", action: "tenant.offboarding_initiated", targetType: "tenant", targetId: tenant.id, metadata: { data_handling_path: body.data_handling_path, job_id: job.id } });
      await writeAuditEvent(repos, { tenantId: tenant.id, actorType: "user", actorId: principal.actor_id, eventType: "tenant.offboarding_initiated", targetType: "tenant", targetId: tenant.id });
      const allTenantUsers = await repos.users.listByTenant(tenant.id);
      const primaryContact = allTenantUsers.find((u) => u.role === "organizer_admin" && u.status === "active" && u.email)
        ?? allTenantUsers.find((u) => u.status === "active" && u.email);
      if (primaryContact) {
        await dispatchTransactionalEmail({
          repos,
          tenantId: tenant.id,
          recipientEmail: primaryContact.email,
          messageType: "offboarding_initiated",
          templateVars: {
            organizer_name: primaryContact.display_name ?? "there",
            tenant_name: tenant.name,
            data_handling_path: body.data_handling_path,
            grace_period_days: body.grace_period_days ?? null,
            scheduled_deletion_at: null,
            contact_email: process.env.SUPPORT_EMAIL ?? "support@codex.io"
          },
          actorUserId: principal.user_id
        });
      }
      return { job_id: job.id, status: "awaiting_approval" };
    },
    auditEventType: "tenant.offboarding_initiated"
  });

  router.addRoute({
    id: "tenant-offboard-approve",
    method: "POST",
    path: "/admin/tenants/:tenantId/offboard/:jobId/approve",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, params, principal, state }) => {
      const job = await repos.tenantOffboardingJobs.findById(params.jobId);
      if (!job || job.tenant_id !== params.tenantId) throw new HttpError(404, "Offboarding job not found");
      if (job.initiated_by_user_id === principal.user_id) throw new HttpError(403, "SAME_USER_APPROVAL_FORBIDDEN", { message: "The approver must be a different platform_admin than the initiator" });
      const newStatus = job.data_handling_path === "immediate_delete" ? "deletion_in_progress" : "export_in_progress";
      const updated = await repos.tenantOffboardingJobs.update({ ...job, approved_by_user_id: principal.user_id, status: newStatus });
      setImmediate(() => {
        processTenantOffboarding(repos, state, job.id).catch((err) => {
          console.error(`[routes] Offboarding worker error for job ${job.id}:`, err);
        });
      });
      return { job_id: updated.id, status: updated.status };
    },
    auditEventType: "tenant.offboarding_approved"
  });

  router.addRoute({
    id: "tenant-offboard-status",
    method: "GET",
    path: "/admin/tenants/:tenantId/offboard/status",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, params }) => {
      const job = await repos.tenantOffboardingJobs.findActiveByTenant(params.tenantId);
      if (!job) return { status: "none", job_id: null };
      return { job_id: job.id, status: job.status, data_handling_path: job.data_handling_path, created_at: job.created_at, completed_at: job.completed_at ?? null };
    }
  });

  // ── Step 15.7: Retention status (SG3) ────────────────────────

  router.addRoute({
    id: "admin-tenant-retention",
    method: "GET",
    path: "/admin/tenants/:tenantId/retention",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, params }) => {
      const events = await repos.events.listByTenant(params.tenantId);
      const policies = await Promise.all(events.map((e) => repos.eventPolicies.findByEventId(params.tenantId, e.id).catch(() => null)));
      const counts = { active: 0, expiring_soon: 0, expired_pending_purge: 0, purged: 0 };
      const eventItems = events.map((e, i) => {
        const policy = policies[i];
        const retentionDays = policy?.retention_days ?? 30;
        const status = e.retention_status ?? "active";
        if (counts[status] !== undefined) counts[status]++;
        const retentionExpiryAt = e.ends_at ? new Date(Date.parse(e.ends_at) + retentionDays * 86400000).toISOString() : null;
        return { event_id: e.id, name: e.name, retention_days: retentionDays, event_end_at: e.ends_at ?? null, retention_expiry_at: retentionExpiryAt, retention_status: status, last_purge_run_at: e.last_purge_run_at ?? null };
      });
      return { summary: { active_count: counts.active, expiring_soon_count: counts.expiring_soon, expired_pending_purge_count: counts.expired_pending_purge, purged_count: counts.purged }, events: eventItems };
    }
  });

  router.addRoute({
    id: "event-retention-status",
    method: "GET",
    path: "/events/:eventId/retention/status",
    allowedRoles: ["organizer_admin"],
    handler: async ({ repos, params, principal }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const policy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id).catch(() => null);
      const retentionDays = policy?.retention_days ?? 30;
      const retentionExpiryAt = event.ends_at ? new Date(Date.parse(event.ends_at) + retentionDays * 86400000).toISOString() : null;
      return { retention_days: retentionDays, event_end_at: event.ends_at ?? null, retention_expiry_at: retentionExpiryAt, retention_status: event.retention_status ?? "active", purged_at: event.purged_at ?? null };
    }
  });

  router.addRoute({
    id: "admin-event-force-purge",
    method: "POST",
    path: "/admin/events/:eventId/retention/force-purge",
    allowedRoles: ["platform_admin"],
    validate: (body) => body ?? {},
    handler: async ({ repos, params, principal, body }) => {
      if (body.confirm !== true) throw new HttpError(400, "confirm must be true to initiate force purge");
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      await repos.events.update({ ...event, retention_status: "purging" });
      await writePrivacyAudit(repos, { tenantId: principal.tenant_id, eventId: event.id, actorUserId: principal.user_id, actorRole: "platform_admin", action: "retention.purge_executed", targetType: "event", targetId: event.id });
      const singleEventState = { tenants: [{ id: principal.tenant_id }] };
      runRetentionPurgeOnce(repos, singleEventState).catch((err) => {
        console.error(`[routes] Force-purge worker error for event ${event.id}:`, err);
      });
      return { message: "Purge initiated", event_id: event.id, status: "purging" };
    },
    auditEventType: "retention.force_purge_initiated"
  });

  // ── Step 15.8: Data residency configuration (SG10) ───────────

  router.addRoute({
    id: "admin-tenant-compliance-get",
    method: "GET",
    path: "/admin/tenants/:tenantId/compliance",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, params }) => {
      const tenant = await repos.tenants.findById(params.tenantId);
      if (!tenant) throw new HttpError(404, "Tenant not found");
      const zone = tenant.data_residency_zone ?? "global";
      return { data_residency_zone: zone, sensitive_data_categories: tenant.sensitive_data_categories ?? [], compliance_status: zone === "india" ? "review_required" : "compliant", last_checked_at: tenant.compliance_last_checked_at ?? null };
    }
  });

  router.addRoute({
    id: "admin-tenant-compliance-patch",
    method: "PATCH",
    path: "/admin/tenants/:tenantId/compliance",
    allowedRoles: ["platform_admin"],
    validate: (body) => body ?? {},
    handler: async ({ repos, params, body }) => {
      const tenant = await repos.tenants.findById(params.tenantId);
      if (!tenant) throw new HttpError(404, "Tenant not found");
      const VALID_ZONES = ["india", "eu", "us", "global"];
      if (body.data_residency_zone && !VALID_ZONES.includes(body.data_residency_zone)) throw new HttpError(400, "INVALID_DATA_RESIDENCY_ZONE", { valid: VALID_ZONES });
      const updated = await repos.tenants.update({ ...tenant, data_residency_zone: body.data_residency_zone ?? tenant.data_residency_zone ?? "global", sensitive_data_categories: body.sensitive_data_categories ?? tenant.sensitive_data_categories ?? [] });
      const zone = updated.data_residency_zone ?? "global";
      return { data_residency_zone: updated.data_residency_zone, sensitive_data_categories: updated.sensitive_data_categories ?? [], compliance_status: zone === "india" ? "review_required" : "compliant", last_checked_at: updated.compliance_last_checked_at ?? null };
    }
  });

  router.addRoute({
    id: "admin-tenant-compliance-check",
    method: "POST",
    path: "/admin/tenants/:tenantId/compliance/check",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, params }) => {
      const tenant = await repos.tenants.findById(params.tenantId);
      if (!tenant) throw new HttpError(404, "Tenant not found");
      // TODO: wire to infrastructure tag scan (requires infra team)
      return { status: "review_required", message: "Infrastructure compliance check requires manual verification. Contact your infrastructure team.", last_checked_at: new Date().toISOString() };
    }
  });

  // ── Step 15.9: Privacy audit log (SG9) ───────────────────────

  router.addRoute({
    id: "admin-privacy-audit-log",
    method: "GET",
    path: "/admin/privacy-audit-log",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, principal, query }) => {
      const filters = {
        action: query.action, actor_role: query.actor_role, from: query.from, to: query.to,
        page: parseInt(query.page ?? "1", 10) || 1, page_size: Math.min(100, parseInt(query.page_size ?? "20", 10) || 20)
      };
      return repos.privacyAuditLogs.listByTenant(principal.tenant_id, filters);
    }
  });

  router.addRoute({
    id: "event-privacy-audit-log",
    method: "GET",
    path: "/events/:eventId/privacy-audit-log",
    allowedRoles: ["organizer_admin"],
    handler: async ({ repos, params, principal, query }) => {
      const event = await repos.events.findById(principal.tenant_id, params.eventId);
      assertEventScoped(principal, event.id);
      const filters = { event_id: event.id, action: query.action, from: query.from, to: query.to, page: parseInt(query.page ?? "1", 10) || 1, page_size: Math.min(100, parseInt(query.page_size ?? "20", 10) || 20) };
      const result = await repos.privacyAuditLogs.listByTenant(principal.tenant_id, filters);
      return { ...result, entries: result.entries.map(({ actor_user_id: _omit, ...entry }) => entry) };
    }
  });

  router.addRoute({
    id: "admin-privacy-audit-log-export",
    method: "POST",
    path: "/admin/privacy-audit-log/export",
    allowedRoles: ["platform_admin"],
    handler: async ({ repos, principal }) => {
      const result = await repos.privacyAuditLogs.listByTenant(principal.tenant_id, { page: 1, page_size: 10000 });
      const header = "id,tenant_id,event_id,actor_role,action,target_type,target_id,occurred_at";
      const rows = result.entries.map((e) => [e.id, e.tenant_id, e.event_id ?? "", e.actor_role, e.action, e.target_type ?? "", e.target_id ?? "", e.occurred_at].join(","));
      const exportId = nextId("palexport");
      await writePrivacyAudit(repos, { tenantId: principal.tenant_id, actorUserId: principal.user_id, actorRole: "platform_admin", action: "privacy_log_exported", targetType: "privacy_audit_log", targetId: exportId });
      return { export_id: exportId, message: "Privacy audit log export ready", csv: [header, ...rows].join("\n"), row_count: rows.length };
    }
  });

}

async function resolveDeviceCredentialResources({ repos, principal, params }) {
  const device = await repos.devices.findById(principal.tenant_id, params.deviceId);

  let assignment = null;
  let event = null;
  let stall = null;
  let eventPolicy = null;

  try {
    assignment = await repos.deviceAssignments.findActiveByDeviceId(principal.tenant_id, device.id);
    event = await repos.events.findById(principal.tenant_id, assignment.event_id);
    stall = await repos.stalls.findById(principal.tenant_id, assignment.stall_id);
    eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
  } catch (error) {
    if (!(error instanceof HttpError) || error.statusCode !== 404) {
      throw error;
    }
  }

  return { device, assignment, event, stall, eventPolicy };
}

async function resolveAdminUserResources({ repos, principal, params }) {
  const user = await repos.users.findById(principal.tenant_id, params.userId);
  const [organization, accessScopes] = await Promise.all([
    user.organization_id
      ? repos.organizations.findById(principal.tenant_id, user.organization_id)
      : Promise.resolve(null),
    repos.userAccessScopes.listByUser(principal.tenant_id, user.id)
  ]);
  return { user, organization, accessScopes };
}

async function resolveAdminUserScopeAssignmentResources({ repos, principal, params, body }) {
  const user = await repos.users.findById(principal.tenant_id, params.userId);
  const [organization, event, stall, sponsorOrganization] = await Promise.all([
    user.organization_id
      ? repos.organizations.findById(principal.tenant_id, user.organization_id)
      : Promise.resolve(null),
    body.event_id ? repos.events.findById(principal.tenant_id, body.event_id) : Promise.resolve(null),
    body.stall_id ? repos.stalls.findById(principal.tenant_id, body.stall_id) : Promise.resolve(null),
    body.sponsor_organization_id
      ? repos.organizations.findById(principal.tenant_id, body.sponsor_organization_id)
      : Promise.resolve(null)
  ]);
  return { user, organization, event, stall, sponsorOrganization };
}

async function resolveAdminUserScopeResources({ repos, principal, params }) {
  const user = await repos.users.findById(principal.tenant_id, params.userId);
  const accessScope = await repos.userAccessScopes.findById(principal.tenant_id, params.scopeId);
  if (accessScope.user_id !== user.id) {
    throw new HttpError(404, "User access scope not found");
  }
  return { user, accessScope };
}

async function createInteractionFromTap({ state, repos, body, resources }) {
  const interactionResult = await ingestTapEvent({ repos, body, resources });
  const interaction = interactionResult.interaction;

  const attendeeSessionToken = createAttendeeSessionToken(
    buildAttendeeSessionPayload(interaction, resources.event.tenant_id),
    state.sessionSecret
  );
  const customerShortLink = await createShortLinkRecord({
    repos,
    tenantId: interaction.tenant_id,
    targetType: "attendee_session",
    targetId: interaction.id,
    targetPayload: {
      interaction_id: interaction.id,
      session_token: attendeeSessionToken,
      target_url: `/attendee.html?interactionId=${encodeURIComponent(interaction.id)}&token=${encodeURIComponent(attendeeSessionToken)}`
    },
    expiresAt: inHours(24)
  });

  return {
    result: interactionResult.mode,
    interaction_id: interaction.id,
    tap_event_id: interactionResult.tapEvent.id,
    consent_status: interaction.consent_status,
    attendee_preview: null,
    attendee_session_token: attendeeSessionToken,
    customer_link: `/attendee/session/${interaction.id}?token=${encodeURIComponent(attendeeSessionToken)}`,
    customer_short_link: customerShortLink.short_link_url,
    customer_short_link_expires_at: customerShortLink.expires_at
  };
}

async function createShortLinkRecord({
  repos,
  tenantId,
  targetType,
  targetId,
  targetPayload,
  expiresAt,
  token = createShortLinkToken()
}) {
  const shortLinkUrl = shortLinkPath(token);
  const shortLink = await repos.shortLinks.create({
    id: nextId("short-link"),
    tenant_id: tenantId,
    token_hash: hashShortLinkToken(token),
    target_type: targetType,
    target_id: targetId,
    target_payload: targetPayload,
    status: "active",
    expires_at: expiresAt,
    consumed_at: null,
    created_at: new Date().toISOString()
  });
  return { ...shortLink, short_link_url: shortLinkUrl };
}

async function resolveShortLinkOperatorResources({ repos, principal, params }) {
  const shortLink = await repos.shortLinks.findById(principal.tenant_id, params.shortLinkId);
  return resolveShortLinkTargetResources(repos, shortLink);
}

async function resolveShortLinkTargetResources(repos, shortLink) {
  const resources = {
    shortLink,
    tenantHint: shortLink.tenant_id
  };
  if (shortLink.target_type === "attendee_session") {
    resources.interaction = await repos.interactions.findById(shortLink.tenant_id, shortLink.target_id);
    resources.stall = await repos.stalls.findById(shortLink.tenant_id, resources.interaction.stall_id);
    resources.event = await repos.events.findById(shortLink.tenant_id, resources.interaction.event_id);
  }
  if (shortLink.target_type === "export_download") {
    resources.exportRequest = await repos.exportRequests.findById(shortLink.tenant_id, shortLink.target_id);
    resources.event = await repos.events.findById(shortLink.tenant_id, resources.exportRequest.event_id);
  }
  if (shortLink.target_type === "wallet_pass") {
    resources.walletPass = await repos.walletPasses.findById(shortLink.tenant_id, shortLink.target_id);
    resources.interaction = await repos.interactions.findById(shortLink.tenant_id, resources.walletPass.interaction_id);
    resources.stall = await repos.stalls.findById(shortLink.tenant_id, resources.walletPass.stall_id);
    resources.event = await repos.events.findById(shortLink.tenant_id, resources.walletPass.event_id);
  }
  return resources;
}

async function resolveShortLink({ repos, resources }) {
  const shortLink = resources.shortLink;
  if (shortLink.status !== "active") {
    throw new HttpError(410, "Short link is no longer active");
  }
  if (shortLink.expires_at && Date.parse(shortLink.expires_at) < Date.now()) {
    await repos.shortLinks.update({
      ...shortLink,
      status: "expired"
    });
    throw new HttpError(410, "Short link has expired");
  }

  if (shortLink.target_type === "attendee_session") {
    return {
      short_link_id: shortLink.id,
      target_type: shortLink.target_type,
      target_id: shortLink.target_id,
      expires_at: shortLink.expires_at,
      target_url: shortLink.target_payload?.target_url ?? null,
      interaction_id: shortLink.target_payload?.interaction_id ?? shortLink.target_id,
      requires_session_token: true
    };
  }

  if (shortLink.target_type === "export_download") {
    const exportRequest = resources.exportRequest;
    if (exportRequest.status !== "generated") {
      throw new HttpError(409, "Export file is not ready");
    }
    if (exportRequest.file_expires_at && Date.parse(exportRequest.file_expires_at) < Date.now()) {
      throw new HttpError(410, "Export file has expired");
    }
    const file = await buildExportDownloadPayload(
      repos,
      exportRequest.tenant_id,
      exportRequest.event_id,
      exportRequest
    );
    return {
      short_link_id: shortLink.id,
      target_type: shortLink.target_type,
      target_id: shortLink.target_id,
      expires_at: shortLink.expires_at,
      export_id: exportRequest.id,
      export_type: exportRequest.export_type,
      file_name: file.file_name,
      generated_at: exportRequest.created_at,
      payload: file.payload
    };
  }

  if (shortLink.target_type === "wallet_pass") {
    const walletPass = resources.walletPass;
    if (!["generated", "delivered"].includes(walletPass.status)) {
      throw new HttpError(409, "Wallet pass is not available");
    }
    return {
      short_link_id: shortLink.id,
      target_type: shortLink.target_type,
      target_id: shortLink.target_id,
      expires_at: shortLink.expires_at,
      wallet_pass: serializeWalletPass(walletPass),
      artifact_ref: walletPass.artifact_ref
    };
  }

  return {
    short_link_id: shortLink.id,
    target_type: shortLink.target_type,
    target_id: shortLink.target_id,
    expires_at: shortLink.expires_at
  };
}

function serializeShortLink(shortLink) {
  return {
    id: shortLink.id,
    target_type: shortLink.target_type,
    target_id: shortLink.target_id,
    short_link_url: shortLink.short_link_url,
    expires_at: shortLink.expires_at,
    status: shortLink.status
  };
}

function serializeShortLinkInvestigation(resources) {
  const shortLink = resources.shortLink;
  const targetStatus =
    resources.exportRequest?.status ??
    resources.walletPass?.status ??
    resources.interaction?.status ??
    null;
  return {
    id: shortLink.id,
    target_type: shortLink.target_type,
    target_id: shortLink.target_id,
    status: shortLink.status,
    target_status: targetStatus,
    event_id: resources.event?.id ?? null,
    stall_id: resources.stall?.id ?? null,
    interaction_id: resources.interaction?.id ?? null,
    export_id: resources.exportRequest?.id ?? null,
    wallet_pass_id: resources.walletPass?.id ?? null,
    expires_at: shortLink.expires_at,
    consumed_at: shortLink.consumed_at,
    created_at: shortLink.created_at,
    expired: Boolean(shortLink.expires_at && Date.parse(shortLink.expires_at) < Date.now()),
    revocable: shortLink.status === "active"
  };
}

function buildProviderReadiness(event, env = {}) {
  const wallet = resolveWalletPassProviderOutcome(env);
  const notificationChannels = buildNotificationChannelsReadiness(env);
  const scheduler = resolveNotificationWorkerSchedule(env);
  return {
    event_id: event.id,
    generated_at: new Date().toISOString(),
    wallet_pass: {
      enabled: env.WALLET_PASS_ENABLED === "true",
      mode: env.WALLET_PASS_PROVIDER_MODE ?? "not_configured",
      status: wallet.status === "generated"
        ? "ready"
        : wallet.status === "disabled"
          ? "disabled"
          : "misconfigured",
      failure_code: wallet.failure_code ?? null,
      non_blocking: true
    },
    notifications: notificationChannels,
    scheduler,
    blocking: false
  };
}

async function buildOperationalArtifactAlerts(repos, event) {
  const [walletPasses, notifications] = await Promise.all([
    typeof repos.walletPasses?.listByEvent === "function"
      ? repos.walletPasses.listByEvent(event.tenant_id, event.id)
      : [],
    typeof repos.notifications?.listByEvent === "function"
      ? repos.notifications.listByEvent(event.tenant_id, event.id)
      : []
  ]);

  const walletAlerts = walletPasses
    .filter((walletPass) => ["failed", "disabled"].includes(walletPass.status))
    .map((walletPass) => ({
      id: `wallet:${walletPass.id}`,
      kind: "wallet_pass",
      severity: walletPass.status === "failed" ? "warning" : "info",
      status: walletPass.status,
      event_id: event.id,
      interaction_id: walletPass.interaction_id,
      stall_id: walletPass.stall_id,
      wallet_pass_id: walletPass.id,
      notification_id: null,
      channel: null,
      provider: "wallet-pass",
      message: walletPass.failure_message || walletPass.failure_code || "Wallet pass needs operator review.",
      updated_at: walletPass.updated_at
    }));

  const notificationAlerts = [];
  for (const notification of notifications) {
    const attempts = await repos.notificationAttempts.listByNotification(notification.tenant_id, notification.id);
    const receipts = await repos.notificationReceipts.listByNotification(notification.tenant_id, notification.id);
    const receiptGovernance = await buildNotificationReceiptGovernance({
      repos,
      tenantId: notification.tenant_id,
      notification
    });
    const latestAttempt = attempts.at(-1) ?? null;
    const latestReceipt = receipts[0] ?? null;
    const needsReceiptAlert = Boolean(receiptGovernance.blocking_receipt || receiptGovernance.review_receipt);
    const needsStatusAlert = ["failed", "cancelled"].includes(notification.status);
    if (!needsStatusAlert && !needsReceiptAlert) {
      continue;
    }
    notificationAlerts.push({
      id: `notification:${notification.id}`,
      kind: "notification",
      severity: receiptGovernance.blocking_receipt
        ? "warning"
        : notification.status === "failed" || receiptGovernance.review_receipt
          ? "warning"
          : "info",
      status: notification.status,
      event_id: event.id,
      interaction_id: notification.interaction_id,
      stall_id: null,
      wallet_pass_id: null,
      notification_id: notification.id,
      channel: notification.channel,
      provider: latestAttempt?.provider ?? "notification-provider",
      message:
        receiptGovernance.resend_blocked_reason ||
        receiptGovernance.resend_review_reason ||
        (latestReceipt ? `Provider receipt ${latestReceipt.receipt_type}${latestReceipt.summary ? `: ${latestReceipt.summary}` : "."}` : null) ||
        latestAttempt?.error_message ||
        notification.final_error ||
        `Notification ${notification.status}.`,
      attempts_count: attempts.length,
      latest_attempt_status: latestAttempt?.status ?? null,
      latest_receipt_type: latestReceipt?.receipt_type ?? null,
      receipts_count: receipts.length,
      updated_at: notification.updated_at
    });
  }

  const items = [...walletAlerts, ...notificationAlerts]
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at));
  return {
    event_id: event.id,
    generated_at: new Date().toISOString(),
    counts: {
      total: items.length,
      wallet_passes: walletAlerts.length,
      notifications: notificationAlerts.length,
      receipt_governance: notificationAlerts.filter((item) => item.latest_receipt_type).length,
      receipt_blocked: notificationAlerts.filter((item) => item.message?.includes("blocks resend")).length,
      receipt_review: notificationAlerts.filter((item) => item.message?.includes("requires operator review")).length,
      warning: items.filter((item) => item.severity === "warning").length,
      info: items.filter((item) => item.severity === "info").length
    },
    items
  };
}

async function buildArtifactAttemptsCsvExport(repos, event) {
  const [walletAttempts, notifications] = await Promise.all([
    typeof repos.walletPassAttempts?.listByEvent === "function"
      ? repos.walletPassAttempts.listByEvent(event.tenant_id, event.id)
      : [],
    typeof repos.notifications?.listByEvent === "function"
      ? repos.notifications.listByEvent(event.tenant_id, event.id)
      : []
  ]);
  const notificationRows = [];
  const receiptRows = [];
  for (const notification of notifications) {
    const attempts = await repos.notificationAttempts.listByNotification(notification.tenant_id, notification.id);
    const receipts = await repos.notificationReceipts.listByNotification(notification.tenant_id, notification.id);
    for (const attempt of attempts) {
      notificationRows.push({
        artifact_type: "notification",
        artifact_id: notification.id,
        attempt_id: attempt.id,
        interaction_id: notification.interaction_id,
        channel_or_pass_type: notification.channel,
        provider: attempt.provider,
        status: attempt.status,
        reason: notification.message_type,
        failure_code: "",
        failure_message: attempt.error_message ?? "",
        attempted_by_user_id: notification.approved_by_user_id ?? notification.created_by_user_id ?? "",
        attempted_at: attempt.attempted_at
      });
    }
    for (const receipt of receipts) {
      receiptRows.push({
        artifact_type: "notification_receipt",
        artifact_id: notification.id,
        attempt_id: receipt.id,
        interaction_id: notification.interaction_id,
        channel_or_pass_type: notification.channel,
        provider: receipt.provider,
        status: receipt.receipt_type,
        reason: notification.message_type,
        failure_code: receipt.provider_event_id ?? "",
        failure_message: receipt.summary ?? "",
        attempted_by_user_id: "notification-provider-webhook",
        attempted_at: receipt.occurred_at ?? receipt.received_at
      });
    }
  }
  const walletRows = walletAttempts.map((attempt) => ({
    artifact_type: "wallet_pass",
    artifact_id: attempt.wallet_pass_id,
    attempt_id: attempt.id,
    interaction_id: attempt.interaction_id,
    channel_or_pass_type: attempt.pass_type,
    provider: attempt.provider,
    status: attempt.status,
    reason: attempt.reason,
    failure_code: attempt.failure_code ?? "",
    failure_message: attempt.failure_message ?? "",
    attempted_by_user_id: attempt.attempted_by_user_id ?? "",
    attempted_at: attempt.attempted_at
  }));
  const columns = [
    "artifact_type",
    "artifact_id",
    "attempt_id",
    "interaction_id",
    "channel_or_pass_type",
    "provider",
    "status",
    "reason",
    "failure_code",
    "failure_message",
    "attempted_by_user_id",
    "attempted_at"
  ];
  const rows = [...notificationRows, ...receiptRows, ...walletRows]
    .sort((left, right) => Date.parse(right.attempted_at) - Date.parse(left.attempted_at));
  return {
    event_id: event.id,
    filename: `${event.id}-artifact-attempt-evidence.csv`,
    content_type: "text/csv",
    row_count: rows.length,
    csv: toCsv(columns, rows)
  };
}

function toCsv(columns, rows) {
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(","))
  ].join("\n");
}

function csvEscape(value) {
  const text = value == null ? "" : String(value);
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

const COMMERCIAL_PARTNER_TYPES = ["referrer", "channel_partner", "delivery_ecosystem_partner"];
const COMMERCIAL_PARTNER_STATUSES = ["active", "inactive"];
const COMMERCIAL_PARTNER_ACCESS_LEVELS = ["commercial_status_only", "platform_access_provisioned"];
const COMMERCIAL_PIPELINE_STAGES = [
  "lead_added",
  "contacted",
  "replied",
  "call_scheduled",
  "demo_done",
  "proposal_sent",
  "negotiation",
  "closed_won",
  "closed_lost"
];
const COMMERCIAL_OFFER_STRUCTURES = ["organizer_paid", "sponsor_funded", "mixed"];
const COMMERCIAL_PAYOUT_STATUSES = ["pending", "approved", "paid", "cancelled"];
const COMMERCIAL_APPROVAL_TYPES = ["standard_proposal", "pricing_discount", "pricing_exception", "partner_payout_exception"];
const COMMERCIAL_APPROVER_ROLES = ["account_owner", "founder", "product_owner", "platform_admin"];
const COMMERCIAL_STATUS_UPDATE_TYPES = ["commercial_status", "deal_status", "payout_status"];
const COMMERCIAL_POSITIONING_RULE =
  "Commercial communication must position the platform as exhibitor ROI + sponsor revenue + measurable engagement, not NFC novelty or AI novelty.";
const COMMERCIAL_DAILY_TARGETS = [
  { metric: "outreach_touches_or_connections", minimum: 20 },
  { metric: "follow_ups", minimum: 10 },
  { metric: "qualification_calls", minimum: 2 },
  { metric: "demos", minimum: 1 }
];
const COMMERCIAL_DEMO_SOP = [
  "Live or simulated physical tap",
  "Vendor lead capture and ROI view",
  "Sponsor aggregate reporting and snapshot workflow",
  "Consent, export approval, masking, and break-glass trust controls",
  "Trust objection handling for sensitive organizer data"
];

function buildCommercialGovernance({ partners, deals, payouts, approvals }) {
  return {
    rtm_scope: "Deferred/Gap Step 1 mandatory production scope",
    positioning_rule: COMMERCIAL_POSITIONING_RULE,
    partner_types: COMMERCIAL_PARTNER_TYPES,
    partner_access_rule: "Partners receive commercial status updates only unless platform access is explicitly provisioned by a platform admin.",
    forbidden_partner_access: [
      "raw_attendee_data",
      "organizer_dashboard",
      "vendor_leads",
      "sponsor_pii"
    ],
    offer_structures: COMMERCIAL_OFFER_STRUCTURES,
    pipeline_stages: COMMERCIAL_PIPELINE_STAGES,
    daily_targets: COMMERCIAL_DAILY_TARGETS,
    demo_sop: COMMERCIAL_DEMO_SOP,
    pricing_controls: {
      standard_proposal_approver_roles: ["account_owner", "platform_admin"],
      restricted_approver_roles: ["founder", "product_owner"],
      restricted_approval_types: ["pricing_discount", "pricing_exception", "partner_payout_exception"]
    },
    summary: {
      partners: partners.length,
      active_partners: partners.filter((entry) => entry.status === "active").length,
      deals: deals.length,
      open_deals: deals.filter((entry) => !["closed_won", "closed_lost"].includes(entry.stage)).length,
      payouts: payouts.length,
      payouts_paid: payouts.filter((entry) => entry.status === "paid").length,
      approvals: approvals.length
    }
  };
}

function validateTapBody(body) {
  required(body, ["device_id", "event_id", "stall_id", "local_event_id", "tap_type", "occurred_at"]);
  if (!["phone_ndef", "card_uid", "qr"].includes(body.tap_type)) {
    throw new HttpError(400, "tap_type must be phone_ndef, card_uid, or qr");
  }
  return body;
}

function validateCommercialPartnerCreateBody(body) {
  required(body, ["name", "partner_type"]);
  validateCommercialPartnerFields(body, { create: true });
  return body;
}

function validateCommercialPartnerUpdateBody(body) {
  const mutableFields = ["name", "partner_type", "status", "access_level", "platform_user_id", "notes"];
  if (!mutableFields.some((field) => field in body)) {
    throw new HttpError(400, "At least one mutable commercial partner field must be provided");
  }
  validateCommercialPartnerFields(body, { create: false });
  return body;
}

function validateCommercialPartnerFields(body) {
  if ("partner_type" in body && !COMMERCIAL_PARTNER_TYPES.includes(body.partner_type)) {
    throw new HttpError(400, "partner_type is invalid");
  }
  if ("status" in body && !COMMERCIAL_PARTNER_STATUSES.includes(body.status)) {
    throw new HttpError(400, "status is invalid");
  }
  if ("access_level" in body && !COMMERCIAL_PARTNER_ACCESS_LEVELS.includes(body.access_level)) {
    throw new HttpError(400, "access_level is invalid");
  }
  if (body.platform_user_id && body.access_level !== "platform_access_provisioned") {
    throw new HttpError(400, "platform_user_id requires access_level platform_access_provisioned");
  }
  if ((body.access_level ?? "commercial_status_only") === "platform_access_provisioned" && !body.platform_user_id) {
    throw new HttpError(400, "platform_access_provisioned requires platform_user_id");
  }
  for (const field of ["name", "notes"]) {
    if (field in body && body[field] != null && typeof body[field] !== "string") {
      throw new HttpError(400, `${field} must be a string when provided`);
    }
  }
}

async function resolveCommercialPartnerAccessUser({ repos, principal, body }) {
  if (!body.platform_user_id) {
    return { platformAccessUser: null };
  }
  const user = await repos.users.findById(principal.tenant_id, body.platform_user_id);
  if (user.status !== "active") {
    throw new HttpError(409, "Partner platform access requires an active user");
  }
  return { platformAccessUser: user };
}

function validateCommercialDealCreateBody(body) {
  required(body, ["account_name", "stage", "next_action", "next_action_at", "offer_structure", "commercial_positioning_ack"]);
  validateCommercialDealFields(body);
  if (body.commercial_positioning_ack !== true) {
    throw new HttpError(400, "commercial_positioning_ack must be true before a commercial deal is created");
  }
  return body;
}

function validateCommercialDealUpdateBody(body) {
  const mutableFields = [
    "partner_id",
    "account_name",
    "stage",
    "next_action",
    "next_action_at",
    "offer_structure",
    "commercial_positioning_ack",
    "notes"
  ];
  if (!mutableFields.some((field) => field in body)) {
    throw new HttpError(400, "At least one mutable commercial deal field must be provided");
  }
  validateCommercialDealFields(body);
  if ("commercial_positioning_ack" in body && body.commercial_positioning_ack !== true) {
    throw new HttpError(400, "commercial_positioning_ack cannot be unset for production commercial deals");
  }
  return body;
}

function validateCommercialDealFields(body) {
  if ("stage" in body && !COMMERCIAL_PIPELINE_STAGES.includes(body.stage)) {
    throw new HttpError(400, "stage is invalid");
  }
  if ("offer_structure" in body && !COMMERCIAL_OFFER_STRUCTURES.includes(body.offer_structure)) {
    throw new HttpError(400, "offer_structure is invalid");
  }
  if ("commercial_positioning_ack" in body && typeof body.commercial_positioning_ack !== "boolean") {
    throw new HttpError(400, "commercial_positioning_ack must be boolean");
  }
  for (const field of ["account_name", "next_action", "next_action_at", "notes"]) {
    if (field in body && body[field] != null && typeof body[field] !== "string") {
      throw new HttpError(400, `${field} must be a string when provided`);
    }
  }
  for (const field of ["account_name", "next_action", "next_action_at"]) {
    if (field in body && !String(body[field] ?? "").trim()) {
      throw new HttpError(400, `${field} must be non-empty`);
    }
  }
  if ("next_action_at" in body && Number.isNaN(Date.parse(body.next_action_at))) {
    throw new HttpError(400, "next_action_at must be a valid date-time");
  }
}

function validateCommercialPayoutCreateBody(body) {
  required(body, ["partner_id", "amount_cents"]);
  validateCommercialPayoutFields(body);
  return body;
}

function validateCommercialPayoutUpdateBody(body) {
  const mutableFields = ["partner_id", "deal_id", "amount_cents", "currency", "status", "client_payment_received_at", "notes"];
  if (!mutableFields.some((field) => field in body)) {
    throw new HttpError(400, "At least one mutable commercial payout field must be provided");
  }
  validateCommercialPayoutFields(body);
  return body;
}

function validateCommercialPayoutFields(body) {
  if ("amount_cents" in body && (!Number.isInteger(body.amount_cents) || body.amount_cents < 0)) {
    throw new HttpError(400, "amount_cents must be a non-negative integer");
  }
  if ("status" in body && !COMMERCIAL_PAYOUT_STATUSES.includes(body.status)) {
    throw new HttpError(400, "status is invalid");
  }
  if (body.status === "paid" && !body.client_payment_received_at) {
    throw new HttpError(400, "paid payouts require client_payment_received_at");
  }
  for (const field of ["currency", "client_payment_received_at", "notes"]) {
    if (field in body && body[field] != null && typeof body[field] !== "string") {
      throw new HttpError(400, `${field} must be a string when provided`);
    }
  }
}

async function resolveCommercialPayoutResources({ repos, principal, body }) {
  const partnerId = body.partner_id;
  const partner = partnerId
    ? await repos.commercialPartners.findById(principal.tenant_id, partnerId)
    : null;
  const deal = body.deal_id
    ? await repos.commercialDeals.findById(principal.tenant_id, body.deal_id)
    : null;
  if (partner && deal?.partner_id && deal.partner_id !== partner.id) {
    throw new HttpError(409, "deal_id must belong to partner_id");
  }
  return { partner, deal };
}

function validateCommercialApprovalBody(body) {
  required(body, ["approval_type", "approver_role", "approval_status", "reason"]);
  if (!COMMERCIAL_APPROVAL_TYPES.includes(body.approval_type)) {
    throw new HttpError(400, "approval_type is invalid");
  }
  if (!COMMERCIAL_APPROVER_ROLES.includes(body.approver_role)) {
    throw new HttpError(400, "approver_role is invalid");
  }
  if (!["pending", "approved", "rejected"].includes(body.approval_status)) {
    throw new HttpError(400, "approval_status is invalid");
  }
  if (
    ["pricing_discount", "pricing_exception", "partner_payout_exception"].includes(body.approval_type) &&
    !["founder", "product_owner"].includes(body.approver_role)
  ) {
    throw new HttpError(409, "Pricing and payout exceptions require founder or product owner approval");
  }
  for (const field of ["subject_id", "reason"]) {
    if (field in body && body[field] != null && typeof body[field] !== "string") {
      throw new HttpError(400, `${field} must be a string when provided`);
    }
  }
  return body;
}

function validateCommercialPartnerStatusUpdateBody(body) {
  required(body, ["update_type", "summary"]);
  if (!COMMERCIAL_STATUS_UPDATE_TYPES.includes(body.update_type)) {
    throw new HttpError(400, "update_type is invalid");
  }
  if (typeof body.summary !== "string" || body.summary.trim().length === 0) {
    throw new HttpError(400, "summary must be a non-empty string");
  }
  return body;
}

function validateAdminUserCreateBody(body) {
  required(body, ["email", "display_name", "role", "organization_id"]);
  if (!body.email.includes("@")) {
    throw new HttpError(400, "email must be a valid email address");
  }
  if (!["platform_admin", "organizer_admin", "vendor_manager", "sponsor_user", "ops_user"].includes(body.role)) {
    throw new HttpError(400, "role is invalid");
  }
  if ("status" in body && !["pending_invite", "active"].includes(body.status)) {
    throw new HttpError(400, "status must be pending_invite or active when creating a user");
  }
  return body;
}

function validateAdminUserUpdateBody(body) {
  const mutableFields = [
    "email",
    "display_name",
    "role",
    "organization_id",
    "external_identity_provider",
    "external_subject",
    "mfa_required"
  ];
  if (!mutableFields.some((field) => field in body)) {
    throw new HttpError(400, "At least one mutable user field must be provided");
  }
  if ("email" in body && !body.email.includes("@")) {
    throw new HttpError(400, "email must be a valid email address");
  }
  if ("role" in body && !["platform_admin", "organizer_admin", "vendor_manager", "sponsor_user", "ops_user"].includes(body.role)) {
    throw new HttpError(400, "role is invalid");
  }
  if ("mfa_required" in body && typeof body.mfa_required !== "boolean") {
    throw new HttpError(400, "mfa_required must be boolean");
  }
  return body;
}

function validateAdminUserActionBody(body) {
  if ("reason" in body && body.reason != null && typeof body.reason !== "string") {
    throw new HttpError(400, "reason must be a string when provided");
  }
  return body;
}

function validateAdminUserScopeBody(body) {
  if (!body.event_id && !body.stall_id && !body.sponsor_organization_id) {
    throw new HttpError(400, "At least one scope field must be provided");
  }
  if (body.stall_id && !body.event_id) {
    throw new HttpError(400, "stall_id requires event_id");
  }
  if (body.stall_id && body.sponsor_organization_id) {
    throw new HttpError(400, "stall_id and sponsor_organization_id cannot be combined");
  }
  return body;
}

function validatePentestFindingCreateBody(body) {
  required(body, ["title", "severity"]);
  validatePentestFindingFields(body, { create: true });
  return body;
}

function validatePentestFindingUpdateBody(body) {
  const mutableFields = [
    "source",
    "title",
    "severity",
    "category",
    "status",
    "affected_area",
    "description",
    "evidence",
    "remediation_plan",
    "owner_user_id",
    "due_at",
    "resolved_at",
    "accepted_risk_reason"
  ];
  if (!mutableFields.some((field) => field in body)) {
    throw new HttpError(400, "At least one mutable pen-test finding field must be provided");
  }
  validatePentestFindingFields(body, { create: false });
  if (body.status === "accepted_risk" && !body.accepted_risk_reason) {
    throw new HttpError(400, "accepted_risk status requires accepted_risk_reason");
  }
  return body;
}

function validatePentestFindingFields(body) {
  if ("severity" in body && !["critical", "high", "medium", "low", "info"].includes(body.severity)) {
    throw new HttpError(400, "severity must be critical, high, medium, low, or info");
  }
  if ("status" in body && !["open", "triaged", "in_progress", "remediated", "accepted_risk", "false_positive"].includes(body.status)) {
    throw new HttpError(400, "status is invalid");
  }
  if ("evidence" in body && (typeof body.evidence !== "object" || body.evidence === null || Array.isArray(body.evidence))) {
    throw new HttpError(400, "evidence must be an object when provided");
  }
  for (const field of ["title", "source", "category", "affected_area", "description", "remediation_plan", "accepted_risk_reason"]) {
    if (field in body && body[field] != null && typeof body[field] !== "string") {
      throw new HttpError(400, `${field} must be a string when provided`);
    }
  }
}

function validateFinalLaunchApprovalBody(body) {
  required(body, ["approver_role", "approver_label", "approval_status"]);
  if (!["platform_admin", "organizer_owner", "security_owner", "business_owner"].includes(body.approver_role)) {
    throw new HttpError(400, "approver_role is invalid");
  }
  if (!["pending", "approved", "rejected"].includes(body.approval_status)) {
    throw new HttpError(400, "approval_status is invalid");
  }
  for (const field of ["approver_label", "note"]) {
    if (field in body && body[field] != null && typeof body[field] !== "string") {
      throw new HttpError(400, `${field} must be a string when provided`);
    }
  }
  return body;
}

function required(body, fields) {
  for (const field of fields) {
    if (!(field in body)) {
      throw new HttpError(400, `Missing field: ${field}`);
    }
  }
}

function normalizeManagedUserEmail(email) {
  return String(email).trim().toLowerCase();
}

function assertOrganizationCompatibleWithRole(role, organization) {
  const expectedTypeByRole = {
    platform_admin: "platform",
    organizer_admin: "organizer",
    vendor_manager: "vendor",
    sponsor_user: "sponsor",
    ops_user: "platform"
  };
  const expectedType = expectedTypeByRole[role];
  if (!expectedType) {
    throw new HttpError(400, "Unsupported user role");
  }
  if (organization.type !== expectedType) {
    throw new HttpError(409, `Role ${role} requires an organization of type ${expectedType}`);
  }
}

function validateScopeAssignmentForManagedUser(resources) {
  const { user, organization, event, stall, sponsorOrganization } = resources;
  if (user.role === "platform_admin") {
    throw new HttpError(409, "Platform admins do not use scoped access assignments");
  }
  if (stall && event && stall.event_id !== event.id) {
    throw new HttpError(409, "stall_id must belong to the provided event_id");
  }
  if (sponsorOrganization && sponsorOrganization.type !== "sponsor") {
    throw new HttpError(409, "sponsor_organization_id must reference a sponsor organization");
  }

  switch (user.role) {
    case "organizer_admin":
      if (!event || stall || sponsorOrganization) {
        throw new HttpError(409, "Organizer admins require an event-only access scope");
      }
      if (organization?.id !== event.organizer_organization_id) {
        throw new HttpError(409, "Organizer admin organization must match the event organizer");
      }
      return;
    case "vendor_manager":
      if (!event || !stall || sponsorOrganization) {
        throw new HttpError(409, "Vendor managers require event_id and stall_id access");
      }
      if (organization?.id !== stall.vendor_organization_id) {
        throw new HttpError(409, "Vendor manager organization must match the stall vendor organization");
      }
      return;
    case "sponsor_user":
      if (!event || stall || !sponsorOrganization) {
        throw new HttpError(409, "Sponsor users require event_id and sponsor_organization_id access");
      }
      if (organization?.id !== sponsorOrganization.id) {
        throw new HttpError(409, "Sponsor user organization must match the sponsor organization scope");
      }
      return;
    case "ops_user":
      if (!event || stall || sponsorOrganization) {
        throw new HttpError(409, "Ops users require an event-only access scope");
      }
      return;
    default:
      throw new HttpError(409, "Unsupported role for scoped access");
  }
}

function buildAdminReferenceLookups({ organizations, events, stalls }) {
  return {
    organizations: new Map(organizations.map((entry) => [entry.id, entry])),
    events: new Map(events.map((entry) => [entry.id, entry])),
    stalls: new Map(stalls.map((entry) => [entry.id, entry]))
  };
}

function formatManagedUser(user, { organization = null, accessScopes = [], lookups }) {
  return {
    id: user.id,
    tenant_id: user.tenant_id,
    organization_id: user.organization_id,
    organization_name: organization?.name ?? null,
    organization_type: organization?.type ?? null,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
    status: user.status,
    identity_linked: Boolean(user.external_identity_provider && user.external_subject),
    external_identity_provider: user.external_identity_provider ?? null,
    external_subject: user.external_subject ?? null,
    last_login_at: user.last_login_at ?? null,
    disabled_at: user.disabled_at ?? null,
    disabled_reason: user.disabled_reason ?? null,
    mfa_required: user.mfa_required ?? false,
    invited_at: user.invited_at ?? null,
    deleted_at: user.deleted_at ?? null,
    created_at: user.created_at,
    access_scope_count: accessScopes.length,
    access_scopes: accessScopes.map((scope) => formatManagedUserScope(scope, lookups))
  };
}

function formatManagedUserScope(scope, lookups) {
  const event = scope.event_id ? lookups.events.get(scope.event_id) : null;
  const stall = scope.stall_id ? lookups.stalls.get(scope.stall_id) : null;
  const sponsorOrganization = scope.sponsor_organization_id
    ? lookups.organizations.get(scope.sponsor_organization_id)
    : null;

  return {
    id: scope.id,
    event_id: scope.event_id ?? null,
    event_name: event?.name ?? null,
    stall_id: scope.stall_id ?? null,
    stall_code: stall?.code ?? null,
    stall_name: stall?.name ?? null,
    sponsor_organization_id: scope.sponsor_organization_id ?? null,
    sponsor_organization_name: sponsorOrganization?.name ?? null,
    created_at: scope.created_at
  };
}

function formatOrganizationSummary(organization) {
  return {
    id: organization.id,
    tenant_id: organization.tenant_id,
    type: organization.type,
    name: organization.name,
    created_at: organization.created_at
  };
}

function formatEventSummary(event) {
  return {
    id: event.id,
    tenant_id: event.tenant_id,
    organizer_organization_id: event.organizer_organization_id,
    name: event.name,
    status: event.status,
    starts_at: event.starts_at,
    ends_at: event.ends_at
  };
}

function formatStallSummary(stall) {
  return {
    id: stall.id,
    tenant_id: stall.tenant_id,
    event_id: stall.event_id,
    vendor_organization_id: stall.vendor_organization_id,
    sponsor_organization_id: stall.sponsor_organization_id,
    code: stall.code,
    name: stall.name
  };
}

function normalizeNullableId(value) {
  return value ?? null;
}

function buildConsentEvidence({ body = {}, headers = {} }) {
  const forwardedFor = headers["x-forwarded-for"]?.split(",")[0]?.trim();
  return {
    locale: body.locale ?? body.consent_locale ?? headers["accept-language"]?.split(",")[0]?.trim() ?? null,
    ip_address: body.ip_address ?? forwardedFor ?? headers["x-real-ip"] ?? null,
    user_agent: body.user_agent ?? headers["user-agent"] ?? null
  };
}

const COMMUNICATION_CHANNELS = ["email", "sms", "whatsapp"];

function validateCommunicationChannelConsentChoices(choices) {
  if (choices == null) {
    return;
  }
  if (typeof choices !== "object" || Array.isArray(choices)) {
    throw new HttpError(400, "communication_channel_consents must be an object");
  }
  for (const [channel, allowed] of Object.entries(choices)) {
    if (!COMMUNICATION_CHANNELS.includes(channel)) {
      throw new HttpError(400, "Unsupported communication channel consent");
    }
    if (typeof allowed !== "boolean") {
      throw new HttpError(400, "Communication channel consent choices must be explicit booleans");
    }
  }
}

async function upsertCommunicationChannelConsents({
  repos,
  interaction,
  attendee,
  choices,
  evidence,
  source = "attendee_self_service"
}) {
  if (!choices) {
    return [];
  }
  const now = new Date().toISOString();
  const records = [];
  for (const [channel, allowed] of Object.entries(choices)) {
    if (allowed) {
      await repos.communicationSuppressions.deactivateByInteractionAndChannel(
        interaction.tenant_id,
        interaction.id,
        channel,
        now
      );
    }
    records.push(await repos.communicationChannelConsents.upsert({
      id: nextId("channel-consent"),
      tenant_id: interaction.tenant_id,
      interaction_id: interaction.id,
      attendee_id: attendee?.id ?? interaction.attendee_id ?? null,
      channel,
      allowed,
      source,
      evidence,
      created_at: now,
      updated_at: now
    }));
  }
  return records;
}

async function revokeCommunicationChannelConsents({ repos, interaction, evidence }) {
  const existing = await repos.communicationChannelConsents.listByInteraction(interaction.tenant_id, interaction.id);
  const now = new Date().toISOString();
  const records = [];
  const channels = existing.length ? existing.map((record) => record.channel) : COMMUNICATION_CHANNELS;
  for (const channel of channels) {
    const record = existing.find((entry) => entry.channel === channel);
    const activeSuppression = await repos.communicationSuppressions.findActiveByInteractionAndChannel(
      interaction.tenant_id,
      interaction.id,
      channel
    );
    if (!activeSuppression) {
      await repos.communicationSuppressions.create({
        id: nextId("communication-suppression"),
        tenant_id: interaction.tenant_id,
        event_id: interaction.event_id,
        interaction_id: interaction.id,
        attendee_id: interaction.attendee_id ?? null,
        channel,
        status: "active",
        reason: "Attendee revoked communication channel consent",
        source: "consent_revoke",
        created_at: now,
        updated_at: now
      });
    }
    if (!record) {
      continue;
    }
    records.push(await repos.communicationChannelConsents.upsert({
      ...record,
      allowed: false,
      source: "consent_revoke",
      evidence,
      updated_at: now
    }));
  }
  return records;
}

async function cancelQueuedFollowupsForInteraction({ repos, interaction, channels }) {
  const followups = await repos.followupMessages.listByInteraction(interaction.tenant_id, interaction.id);
  const now = new Date().toISOString();
  const cancelled = [];
  for (const followup of followups) {
    if (!channels.includes(followup.channel) || followup.status !== "queued") {
      continue;
    }
    followup.status = "cancelled";
    followup.updated_at = now;
    const updatedFollowup = await repos.followupMessages.update(followup);
    let updatedNotification = null;
    if (followup.notification_id) {
      const notification = await repos.notifications.findById(interaction.tenant_id, followup.notification_id);
      if (!["sent", "cancelled"].includes(notification.status)) {
        notification.status = "cancelled";
        notification.updated_at = now;
        updatedNotification = await repos.notifications.update(notification);
      }
    }
    cancelled.push({
      followup: updatedFollowup,
      notification: updatedNotification
    });
  }
  return cancelled;
}

async function estimateRows(repos, tenantId, exportType, eventId) {
  if (exportType === "organizer_event_report" || exportType === "sponsor_dashboard_snapshot") {
    return 1;
  }
  if (exportType === "vendor_leads" || exportType === "sponsor_leads") {
    const interactions = await repos.interactions.listByEvent(tenantId, eventId);
    return interactions.filter((interaction) => leadExportConsentAllowed(interaction, exportType)).length;
  }
  return (await repos.interactions.listByEvent(tenantId, eventId)).length;
}

function exportDownloadPath(exportRequest) {
  return `/exports/${exportRequest.id}/download`;
}

function inHours(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function matchesIncidentFilters(incident, filters) {
  if (filters.severity && incident.severity !== filters.severity) {
    return false;
  }
  if (filters.status && incident.status !== filters.status) {
    return false;
  }
  if (filters.deviceId && incident.device_id !== filters.deviceId) {
    return false;
  }
  if (filters.stallId && incident.stall_id !== filters.stallId) {
    return false;
  }
  if (filters.area) {
    const haystack = `${incident.stall_id ?? ""} ${incident.code ?? ""} ${incident.message ?? ""}`.toLowerCase();
    if (!haystack.includes(String(filters.area).toLowerCase())) {
      return false;
    }
  }
  if (filters.recentHours) {
    const recentHours = Number(filters.recentHours);
    if (Number.isFinite(recentHours) && recentHours > 0) {
      const timestamp = incident.occurred_at ?? incident.created_at;
      if (!timestamp || Date.now() - Date.parse(timestamp) > recentHours * 60 * 60 * 1000) {
        return false;
      }
    }
  }
  return true;
}

async function buildIncidentSummary(repos, tenantId, eventId, incident, alerts) {
  const device = await repos.devices.findById(tenantId, incident.device_id);
  const stall = incident.stall_id ? await repos.stalls.findById(tenantId, incident.stall_id) : null;
  const relatedAlerts = alerts.filter((alert) => incidentMatchesAlert(incident, alert));
  return {
    id: incident.id,
    device_id: incident.device_id,
    serial_number: device.serial_number,
    stall_id: incident.stall_id,
    stall_name: stall?.name ?? null,
    severity: incident.severity,
    code: incident.code,
    message: incident.message ?? null,
    status: incident.status,
    occurred_at: incident.occurred_at ?? incident.created_at,
    resolved_at: incident.resolved_at ?? null,
    assignment_checksum: incident.assignment_checksum ?? null,
    area_label: stall?.name ?? incident.stall_id ?? "Event-wide",
    related_alerts: relatedAlerts.map(formatAlertEvent)
  };
}

async function buildIncidentInvestigation(repos, tenantId, eventId, incident) {
  const [device, stall, alerts, snapshots, auditLogs, exportRequests, breakGlassRequests, heartbeats, deviceIncidents] = await Promise.all([
    repos.devices.findById(tenantId, incident.device_id),
    incident.stall_id ? repos.stalls.findById(tenantId, incident.stall_id) : Promise.resolve(null),
    repos.iotAlertEvents.listByEvent(tenantId, eventId, { limit: 200 }),
    repos.iotDeviceStatusSnapshots.listByEvent(tenantId, eventId),
    repos.auditLogs.listByTenant(tenantId),
    repos.exportRequests.listByEvent(tenantId, eventId),
    repos.breakGlassAccess.listByTenant(tenantId),
    repos.heartbeats.listByDevice(tenantId, incident.device_id),
    repos.incidents.listByDevice(tenantId, incident.device_id)
  ]);

  const snapshot = snapshots.find((entry) => entry.device_id === incident.device_id) ?? null;
  const relatedAlerts = alerts
    .filter((alert) => incidentMatchesAlert(incident, alert))
    .map(formatAlertEvent);
  const relatedAuditLogs = auditLogs
    .filter((entry) => incidentMatchesAuditLog(incident, entry))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, 20);
  const relatedExports = exportRequests
    .filter((entry) => incidentMatchesExport(incident, entry))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, 10);
  const relatedBreakGlass = breakGlassRequests
    .filter((entry) => incidentMatchesBreakGlass(incident, entry))
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, 10);

  return {
    item: {
      id: incident.id,
      device_id: incident.device_id,
      serial_number: device.serial_number,
      stall_id: incident.stall_id,
      stall_name: stall?.name ?? null,
      severity: incident.severity,
      code: incident.code,
      message: incident.message ?? null,
      status: incident.status,
      occurred_at: incident.occurred_at ?? incident.created_at,
      resolved_at: incident.resolved_at ?? null,
      assignment_checksum: incident.assignment_checksum ?? null,
      metadata: incident.metadata ?? {}
    },
    fleet_context: snapshot
      ? {
          assignment_status: snapshot.assignment_status,
          diagnostics_status: snapshot.diagnostics_status,
          connectivity_status: snapshot.connectivity_status,
          reader_status: snapshot.reader_status,
          app_version: snapshot.app_version,
          firmware_version: snapshot.firmware_version,
          local_queue_depth: snapshot.local_queue_depth,
          last_heartbeat_at: snapshot.last_heartbeat_at,
          checked_at: snapshot.checked_at
        }
      : null,
    related_alerts: relatedAlerts,
    timeline: buildIncidentTimeline(incident, relatedAlerts, relatedAuditLogs),
    related_audit_logs: relatedAuditLogs,
    related_exports: relatedExports,
    related_break_glass_requests: relatedBreakGlass
      .map((entry) => ({
        ...entry,
        access_scope: entry.access_scope
      })),
    annotations: incident.metadata?.annotations ?? [],
    runbook_tracking: incident.metadata?.runbook_tracking ?? null,
    device_history: {
      heartbeats: heartbeats
        .filter((entry) => entry.event_id === eventId)
        .slice(0, 10),
      incidents: deviceIncidents
        .filter((entry) => entry.event_id === eventId)
        .slice(0, 10)
    }
  };
}

function buildIncidentTimeline(incident, relatedAlerts, relatedAuditLogs) {
  const items = [
    {
      type: "incident",
      label: `Incident opened: ${incident.code}`,
      timestamp: incident.occurred_at ?? incident.created_at,
      details: incident.message ?? null
    },
    ...relatedAlerts.map((alert) => ({
      type: "alert",
      label: `Alert ${alert.status}: ${alert.code}`,
      timestamp: alert.created_at,
      details: alert.message
    })),
    ...((incident.metadata?.state_history ?? []).map((entry) => ({
      type: "state",
      label: `Status changed to ${entry.next_status}`,
      timestamp: entry.created_at,
      details: entry.note ?? `Updated by ${entry.actor_user_id ?? "organizer"}`
    }))),
    ...((incident.metadata?.runbook_updates ?? []).map((entry) => ({
      type: "runbook",
      label: "Runbook/workaround updated",
      timestamp: entry.created_at,
      details: entry.note ?? entry.workaround_summary ?? entry.next_action ?? null
    }))),
    ...relatedAuditLogs.map((entry) => ({
      type: "audit",
      label: entry.event_type,
      timestamp: entry.created_at,
      details: entry.target_id ?? entry.actor_id ?? null
    }))
  ];
  if (incident.resolved_at && !(incident.metadata?.state_history ?? []).some((entry) => entry.next_status === "resolved")) {
    items.push({
      type: "incident",
      label: "Incident resolved",
      timestamp: incident.resolved_at,
      details: null
    });
  }
  return items.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
}

function incidentMatchesAlert(incident, alert) {
  if (alert.source_type === "device" && alert.source_id === incident.device_id) {
    return true;
  }
  if (alert.code === incident.code) {
    return true;
  }
  const detailDeviceId = alert.details?.device_id ?? alert.details?.deviceId ?? null;
  return detailDeviceId === incident.device_id;
}

function incidentMatchesAuditLog(incident, auditLog) {
  const metadataText = JSON.stringify(auditLog.metadata ?? {});
  return [
    auditLog.target_id,
    auditLog.actor_id,
    metadataText
  ].some((value) => {
    const text = String(value ?? "");
    return text.includes(incident.id) || text.includes(incident.device_id) || text.includes(incident.code);
  });
}

function incidentMatchesExport(incident, exportRequest) {
  if (exportRequest.export_type === "organizer_event_report") {
    return true;
  }
  return exportRequest.event_id === incident.event_id;
}

function incidentMatchesBreakGlass(incident, request) {
  const accessScope = typeof request.access_scope === "string"
    ? request.access_scope
    : JSON.stringify(request.access_scope ?? {});
  return accessScope.includes("audit") || accessScope.includes(incident.device_id) || accessScope.includes(incident.code);
}

async function resolveIncidentForEvent(repos, tenantId, eventId, incidentId) {
  const incidents = await repos.incidents.listByEvent(tenantId, eventId);
  const incident = incidents.find((entry) => entry.id === incidentId);
  if (!incident) {
    throw new HttpError(404, "Incident not found");
  }
  return incident;
}

function appendIncidentMetadataEntry(incident, key, entry) {
  const values = [...(incident.metadata?.[key] ?? [])];
  values.push(entry);
  incident.metadata = {
    ...(incident.metadata ?? {}),
    [key]: values
  };
  return values;
}

function buildRunbookUpdateNote(tracking) {
  const parts = [];
  if (tracking.runbook_reference) {
    parts.push(`Runbook ${tracking.runbook_reference}`);
  }
  if (tracking.workaround_status) {
    parts.push(`workaround ${tracking.workaround_status}`);
  }
  if (tracking.workaround_summary) {
    parts.push(tracking.workaround_summary);
  }
  if (tracking.next_action) {
    parts.push(`next: ${tracking.next_action}`);
  }
  return parts.join(" | ") || "Runbook tracking updated.";
}

function isRecent(isoDate, seconds) {
  if (!isoDate) {
    return false;
  }
  return Date.now() - Date.parse(isoDate) <= seconds * 1000;
}

async function topStalls(repos, tenantId, eventId) {
  const counts = new Map();
  for (const interaction of await repos.interactions.listByEvent(tenantId, eventId)) {
    counts.set(interaction.stall_id, (counts.get(interaction.stall_id) ?? 0) + 1);
  }
  const rows = [];
  for (const [stallId, count] of counts.entries()) {
    const stall = await repos.stalls.findById(tenantId, stallId);
    rows.push({ stall_id: stallId, stall_name: stall?.name ?? stallId, interactions: count });
  }
  return rows.sort((left, right) => right.interactions - left.interactions);
}

async function buildVendorDashboardMetrics({ repos, tenantId, event, stall, query }) {
  const period = parseMetricsPeriod(query);
  const interactions = (await repos.interactions.listByStall(tenantId, stall.id))
    .filter((interaction) => isWithinMetricsPeriod(interaction.created_at, period));
  const crmRecords = (await repos.crmSyncRecords.listByEvent(tenantId, event.id))
    .filter((record) => record.stall_id === stall.id && isWithinMetricsPeriod(record.synced_at ?? record.created_at, period));
  const followups = (await repos.followupMessages.listByStall(tenantId, stall.id))
    .filter((record) => record.status === "sent" && isWithinMetricsPeriod(record.updated_at ?? record.created_at, period));
  const vendorConsentedInteractions = interactions.filter((interaction) =>
    ["vendor_only", "vendor_and_sponsor"].includes(interaction.consent_status)
  );
  const crmPushedInteractionIds = new Set(
    crmRecords
      .filter((record) => record.synced_at)
      .map((record) => record.interaction_id)
  );
  const followupSentInteractionIds = new Set(followups.map((record) => record.interaction_id));
  const respondedInteractionIds = new Set([...crmPushedInteractionIds, ...followupSentInteractionIds]);
  const denominator = vendorConsentedInteractions.length;

  return {
    event_id: event.id,
    stall_id: stall.id,
    stall_name: stall.name,
    period,
    total_taps: interactions.length,
    vendor_consented_leads: denominator,
    crm_pushed_leads: crmPushedInteractionIds.size,
    followup_sent_leads: followupSentInteractionIds.size,
    response_rate: denominator === 0 ? 0 : Number((respondedInteractionIds.size / denominator).toFixed(4)),
    response_rate_formula: "(distinct CRM pushed or followup sent) / distinct vendor-consented leads; if denominator = 0 then 0",
    classification_breakdown: interactions.reduce((acc, interaction) => {
      const key = interaction.classification ?? "cold";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, { hot: 0, warm: 0, cold: 0 })
  };
}

function validateFollowupBody(body) {
  required(body, ["channel", "body"]);
  if (!COMMUNICATION_CHANNELS.includes(body.channel)) {
    throw new HttpError(400, "Unsupported follow-up channel");
  }
  if (body.status && !["draft", "queued"].includes(body.status)) {
    throw new HttpError(400, "Follow-up status must be draft or queued at creation");
  }
  if (body.status === "queued" && body.human_approved !== true) {
    throw new HttpError(400, "Human approval is required before a follow-up can be queued");
  }
  if (typeof body.body !== "string" || !body.body.trim()) {
    throw new HttpError(400, "Follow-up body is required");
  }
  return {
    ...body,
    body: body.body.trim(),
    subject: body.subject?.trim() || null,
    status: body.status ?? "draft"
  };
}

function validateWalletPassRequestBody(body) {
  required(body, ["session_token"]);
  if ("pass_type" in body && body.pass_type != null && !["apple", "google", "generic"].includes(body.pass_type)) {
    throw new HttpError(400, "pass_type must be apple, google, or generic");
  }
  return body;
}

function validateWalletPassRetryBody(body) {
  if (body?.pass_type != null && !["apple", "google", "generic"].includes(body.pass_type)) {
    throw new HttpError(400, "pass_type must be apple, google, or generic");
  }
  return body ?? {};
}

async function resolveInteractionFollowupResources({ repos, principal, params }) {
  const interaction = await repos.interactions.findById(principal.tenant_id, params.interactionId);
  const stall = await repos.stalls.findById(principal.tenant_id, interaction.stall_id);
  const event = await repos.events.findById(principal.tenant_id, interaction.event_id);
  const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
  return { interaction, stall, event, eventPolicy };
}

async function resolveNotificationOperationResources({ repos, principal, params }) {
  const notification = await repos.notifications.findById(principal.tenant_id, params.notificationId);
  const event = await repos.events.findById(principal.tenant_id, notification.event_id);
  const interaction = notification.interaction_id
    ? await repos.interactions.findById(principal.tenant_id, notification.interaction_id)
    : null;
  const stall = interaction ? await repos.stalls.findById(principal.tenant_id, interaction.stall_id) : null;
  const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
  const followup = await repos.followupMessages.findByNotificationId(principal.tenant_id, notification.id);
  return { notification, event, interaction, stall, eventPolicy, followup };
}

async function buildNotificationDeadLetterSummary(repos, tenantId, env = {}) {
  const policy = resolveNotificationRetryPolicy(env);
  const events = await repos.events.listByTenant(tenantId);
  let total = 0;
  let eventsWithDeadLetter = 0;
  const topEvents = [];

  for (const event of events) {
    const metrics = await buildNotificationQueueMetrics({
      repos,
      tenantId,
      eventId: event.id
    });
    const deadLetterCount = Number(metrics.counts.dead_letter ?? 0);
    if (!deadLetterCount) {
      continue;
    }
    total += deadLetterCount;
    eventsWithDeadLetter += 1;
    topEvents.push({
      event_id: event.id,
      event_name: event.name ?? null,
      dead_letter_count: deadLetterCount
    });
  }

  return {
    total,
    threshold: policy.dead_letter_alert_threshold,
    events_with_dead_letter: eventsWithDeadLetter,
    top_events: topEvents
      .sort((left, right) => right.dead_letter_count - left.dead_letter_count)
      .slice(0, 10)
  };
}

async function resolveWalletPassResources({ repos, principal, params }) {
  const walletPass = await repos.walletPasses.findById(principal.tenant_id, params.walletPassId);
  const interaction = await repos.interactions.findById(principal.tenant_id, walletPass.interaction_id);
  const stall = await repos.stalls.findById(principal.tenant_id, walletPass.stall_id);
  const event = await repos.events.findById(principal.tenant_id, walletPass.event_id);
  const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
  return { walletPass, interaction, stall, event, eventPolicy };
}

async function createWalletPassSafely({ repos, resources, passType, requestedByUserId, env }) {
  const now = new Date().toISOString();
  const walletPass = await repos.walletPasses.create({
    id: nextId("wallet-pass"),
    tenant_id: resources.interaction.tenant_id,
    event_id: resources.interaction.event_id,
    stall_id: resources.interaction.stall_id,
    interaction_id: resources.interaction.id,
    pass_type: passType,
    status: "disabled",
    artifact_ref: null,
    short_link_id: null,
    failure_code: null,
    failure_message: null,
    requested_by_user_id: requestedByUserId,
    delivered_at: null,
    created_at: now,
    updated_at: now
  });
  return applyWalletPassProviderOutcome({
    repos,
    walletPass,
    env,
    reason: "create"
  });
}

async function retryWalletPassSafely({ repos, resources, passType, requestedByUserId, env }) {
  const walletPass = await repos.walletPasses.update({
    ...resources.walletPass,
    pass_type: passType,
    requested_by_user_id: requestedByUserId,
    status: "disabled",
    artifact_ref: null,
    short_link_id: null,
    failure_code: null,
    failure_message: null,
    delivered_at: null,
    updated_at: new Date().toISOString()
  });
  return applyWalletPassProviderOutcome({
    repos,
    walletPass,
    env,
    reason: "retry"
  });
}

async function applyWalletPassProviderOutcome({ repos, walletPass, env, reason }) {
  const outcome = resolveWalletPassProviderOutcome(env);
  const now = new Date().toISOString();
  if (outcome.status !== "generated") {
    const updated = await repos.walletPasses.update({
      ...walletPass,
      status: outcome.status,
      artifact_ref: null,
      short_link_id: null,
      failure_code: outcome.failure_code,
      failure_message: outcome.failure_message,
      delivered_at: null,
      updated_at: now
    });
    const attempt = await recordWalletPassAttempt(repos, updated, {
      provider: "wallet-pass",
      status: outcome.status,
      reason,
      failureCode: outcome.failure_code,
      failureMessage: outcome.failure_message
    });
    return {
      wallet_pass: serializeWalletPass(updated),
      attempts: attempt ? [attempt] : [],
      non_blocking: true,
      provider_result: outcome.status,
      reason
    };
  }

  try {
    const artifactRef = `mock-wallet-pass://${walletPass.pass_type}/${walletPass.id}`;
    const shortLink = await createShortLinkRecord({
      repos,
      tenantId: walletPass.tenant_id,
      targetType: "wallet_pass",
      targetId: walletPass.id,
      targetPayload: {
        wallet_pass_id: walletPass.id,
        pass_type: walletPass.pass_type,
        artifact_ref: artifactRef
      },
      expiresAt: inHours(24)
    });
    const updated = await repos.walletPasses.update({
      ...walletPass,
      status: "generated",
      artifact_ref: artifactRef,
      short_link_id: shortLink.id,
      failure_code: null,
      failure_message: null,
      delivered_at: null,
      updated_at: now
    });
    const attempt = await recordWalletPassAttempt(repos, updated, {
      provider: "mock-wallet-pass",
      status: "generated",
      reason,
      artifactRef,
      shortLinkId: shortLink.id
    });
    return {
      wallet_pass: serializeWalletPass(updated),
      short_link: serializeShortLink(shortLink),
      attempts: attempt ? [attempt] : [],
      non_blocking: true,
      provider_result: "generated",
      reason
    };
  } catch (error) {
    const updated = await repos.walletPasses.update({
      ...walletPass,
      status: "failed",
      artifact_ref: null,
      short_link_id: null,
      failure_code: "wallet_short_link_failed",
      failure_message: error.message,
      delivered_at: null,
      updated_at: new Date().toISOString()
    });
    const attempt = await recordWalletPassAttempt(repos, updated, {
      provider: "wallet-pass",
      status: "failed",
      reason,
      failureCode: "wallet_short_link_failed",
      failureMessage: error.message
    });
    return {
      wallet_pass: serializeWalletPass(updated),
      attempts: attempt ? [attempt] : [],
      non_blocking: true,
      provider_result: "failed",
      reason
    };
  }
}

async function recordWalletPassAttempt(repos, walletPass, {
  provider,
  status,
  reason,
  artifactRef = null,
  shortLinkId = null,
  failureCode = null,
  failureMessage = null
}) {
  if (typeof repos.walletPassAttempts?.create !== "function") {
    return null;
  }
  return repos.walletPassAttempts.create({
    id: nextId("wallet-pass-attempt"),
    tenant_id: walletPass.tenant_id,
    event_id: walletPass.event_id,
    stall_id: walletPass.stall_id,
    interaction_id: walletPass.interaction_id,
    wallet_pass_id: walletPass.id,
    provider,
    status,
    reason,
    pass_type: walletPass.pass_type,
    artifact_ref: artifactRef,
    short_link_id: shortLinkId,
    failure_code: failureCode,
    failure_message: failureMessage,
    attempted_by_user_id: walletPass.requested_by_user_id ?? null,
    attempted_at: new Date().toISOString()
  });
}

function resolveWalletPassProviderOutcome(env = {}) {
  if (env.WALLET_PASS_ENABLED !== "true") {
    return {
      status: "disabled",
      failure_code: "wallet_pass_feature_disabled",
      failure_message: "Wallet pass generation is safely disabled for this environment."
    };
  }
  if (env.WALLET_PASS_PROVIDER_MODE === "mock_success") {
    return { status: "generated" };
  }
  return {
    status: "failed",
    failure_code: "wallet_pass_provider_not_configured",
    failure_message: "Wallet pass provider is enabled but no production provider is configured."
  };
}

async function updateWalletPassStatus({ repos, walletPass, status, failureCode, failureMessage }) {
  if (["delivered", "cancelled"].includes(walletPass.status) && walletPass.status !== status) {
    throw new HttpError(409, "Wallet pass is already in a final state");
  }
  if (status === "delivered" && !["generated", "delivered"].includes(walletPass.status)) {
    throw new HttpError(409, "Only generated wallet passes can be marked delivered");
  }
  const updated = await repos.walletPasses.update({
    ...walletPass,
    status,
    failure_code: status === "failed" ? failureCode ?? "wallet_pass_manual_failure" : null,
    failure_message: status === "failed" ? failureMessage ?? "Wallet pass delivery was marked failed." : null,
    delivered_at: status === "delivered" ? walletPass.delivered_at ?? new Date().toISOString() : walletPass.delivered_at,
    updated_at: new Date().toISOString()
  });
  return {
    wallet_pass: serializeWalletPass(updated)
  };
}

function serializeWalletPass(walletPass) {
  return {
    id: walletPass.id,
    event_id: walletPass.event_id,
    stall_id: walletPass.stall_id,
    interaction_id: walletPass.interaction_id,
    pass_type: walletPass.pass_type,
    status: walletPass.status,
    artifact_ref: walletPass.artifact_ref,
    short_link_id: walletPass.short_link_id,
    failure_code: walletPass.failure_code,
    failure_message: walletPass.failure_message,
    requested_by_user_id: walletPass.requested_by_user_id,
    delivered_at: walletPass.delivered_at,
    created_at: walletPass.created_at,
    updated_at: walletPass.updated_at
  };
}

async function serializeWalletPassWithAttempts(repos, walletPass) {
  const attempts = typeof repos.walletPassAttempts?.listByWalletPass === "function"
    ? await repos.walletPassAttempts.listByWalletPass(walletPass.tenant_id, walletPass.id)
    : [];
  return {
    ...serializeWalletPass(walletPass),
    attempts: attempts.map(serializeWalletPassAttempt),
    attempts_count: attempts.length,
    latest_attempt_status: attempts.at(-1)?.status ?? null
  };
}

function serializeWalletPassAttempt(attempt) {
  return {
    id: attempt.id,
    wallet_pass_id: attempt.wallet_pass_id,
    provider: attempt.provider,
    status: attempt.status,
    reason: attempt.reason,
    pass_type: attempt.pass_type,
    artifact_ref: attempt.artifact_ref,
    short_link_id: attempt.short_link_id,
    failure_code: attempt.failure_code,
    failure_message: attempt.failure_message,
    attempted_by_user_id: attempt.attempted_by_user_id,
    attempted_at: attempt.attempted_at
  };
}

async function queueFollowupMessage({ repos, followup, resources, principal, humanApproved }) {
  if (!humanApproved) {
    throw new HttpError(400, "Human approval is required before a follow-up can be queued");
  }
  if (followup.status !== "draft") {
    throw new HttpError(409, "Only draft follow-ups can be queued");
  }
  if (!["vendor_only", "vendor_and_sponsor"].includes(resources.interaction.consent_status)) {
    throw new HttpError(403, "Vendor consent is required before follow-up messaging");
  }
  const channelConsent = await repos.communicationChannelConsents.findByInteractionAndChannel(
    resources.interaction.tenant_id,
    resources.interaction.id,
    followup.channel
  );
  if (!channelConsent?.allowed) {
    throw new HttpError(403, "Communication channel consent is required before follow-up messaging");
  }
  const suppression = await repos.communicationSuppressions.findActiveByInteractionAndChannel(
    resources.interaction.tenant_id,
    resources.interaction.id,
    followup.channel
  );
  if (suppression) {
    throw new HttpError(403, "Communication is suppressed for this attendee and channel");
  }
  const attendeeProfile = resources.interaction.attendee_id
    ? await repos.attendeeProfiles.findByAttendeeId(resources.interaction.attendee_id)
    : null;
  const recipient = resolveFollowupRecipient(attendeeProfile, followup.channel);
  if (!recipient) {
    throw new HttpError(409, "Follow-up recipient is missing for the selected channel");
  }

  const now = new Date().toISOString();
  const notification = await repos.notifications.create({
    id: nextId("notification"),
    tenant_id: followup.tenant_id,
    event_id: followup.event_id,
    interaction_id: followup.interaction_id,
    channel: followup.channel,
    message_type: "followup",
    status: "queued",
    provider: null,
    recipient_hash: hashNotificationRecipient(followup.channel, recipient),
    consent_checked_at: now,
    sending_started_at: null,
    last_attempt_at: null,
    next_attempt_at: now,
    attempts_count: 0,
    provider_message_id: null,
    final_error: null,
    created_by_user_id: followup.created_by_user_id,
    approved_by_user_id: principal.user_id,
    created_at: now,
    updated_at: now
  });

  followup.status = "queued";
  followup.approved_by_user_id = principal.user_id;
  followup.notification_id = notification.id;
  followup.updated_at = now;
  const updatedFollowup = await repos.followupMessages.update(followup);
  return {
    followup: updatedFollowup,
    notification
  };
}

async function assertNotificationConsentStillValid(repos, resources) {
  if (!resources.interaction || !resources.followup) {
    return;
  }
  if (!["vendor_only", "vendor_and_sponsor"].includes(resources.interaction.consent_status)) {
    throw new HttpError(403, "Vendor consent is required before resending follow-up messaging");
  }
  const channelConsent = await repos.communicationChannelConsents.findByInteractionAndChannel(
    resources.interaction.tenant_id,
    resources.interaction.id,
    resources.followup.channel
  );
  if (!channelConsent?.allowed) {
    throw new HttpError(403, "Communication channel consent is required before resending follow-up messaging");
  }
  const suppression = await repos.communicationSuppressions.findActiveByInteractionAndChannel(
    resources.interaction.tenant_id,
    resources.interaction.id,
    resources.followup.channel
  );
  if (suppression) {
    throw new HttpError(
      403,
      `Communication is suppressed for this attendee and channel${suppression.reason ? ` (${suppression.reason})` : ""}`
    );
  }
  if (resources.notification) {
    const receiptGovernance = await buildNotificationReceiptGovernance({
      repos,
      tenantId: resources.notification.tenant_id,
      notification: resources.notification
    });
    if (receiptGovernance.resend_blocked_reason) {
      throw new HttpError(403, receiptGovernance.resend_blocked_reason);
    }
  }
}

function resolveFollowupRecipient(attendeeProfile, channel) {
  if (channel === "email") {
    return attendeeProfile?.email ?? null;
  }
  if (channel === "sms" || channel === "whatsapp") {
    return attendeeProfile?.phone ?? null;
  }
  return null;
}

function hashNotificationRecipient(channel, value) {
  return createHash("sha256")
    .update(`${channel}:${String(value).trim().toLowerCase()}`)
    .digest("hex");
}

function parseMetricsPeriod(query = {}) {
  const recentHours = query.recent_hours ? Number(query.recent_hours) : null;
  if (recentHours != null && (!Number.isFinite(recentHours) || recentHours <= 0)) {
    throw new HttpError(400, "recent_hours must be a positive number");
  }
  const from = query.from ? parseMetricDate(query.from, "from") : null;
  const to = query.to ? parseMetricDate(query.to, "to") : null;
  if (from && to && from > to) {
    throw new HttpError(400, "from must be before to");
  }
  return {
    from: from?.toISOString() ?? (recentHours ? new Date(Date.now() - recentHours * 60 * 60 * 1000).toISOString() : null),
    to: to?.toISOString() ?? null,
    recent_hours: recentHours
  };
}

function parseMetricDate(value, field) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, `${field} must be a valid date-time`);
  }
  return parsed;
}

function isWithinMetricsPeriod(value, period) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  if (period.from && timestamp < Date.parse(period.from)) {
    return false;
  }
  if (period.to && timestamp > Date.parse(period.to)) {
    return false;
  }
  return true;
}

const LEADERBOARD_SNAPSHOT_INTERVAL_MINUTES = 5;

async function buildPublicLeaderboard({ repos, tenantId, event, eventPolicy, query }) {
  const limit = Math.min(parsePositiveInteger(query.limit ?? "5", "limit"), 20);
  const [stalls, interactions] = await Promise.all([
    repos.stalls.listByEvent(tenantId, event.id),
    repos.interactions.listByEvent(tenantId, event.id)
  ]);
  const stallById = new Map(stalls.map((stall) => [stall.id, stall]));
  const counts = new Map();
  for (const interaction of interactions) {
    counts.set(interaction.stall_id, (counts.get(interaction.stall_id) ?? 0) + 1);
  }

  const rankings = stalls
    .map((stall) => ({
      stall_id: stall.id,
      stall_name: stall.name,
      connection_count: counts.get(stall.id) ?? 0
    }))
    .sort((left, right) => right.connection_count - left.connection_count || left.stall_name.localeCompare(right.stall_name));

  const latest_connections = [];
  const latestInteractions = [...interactions]
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, limit);
  for (const interaction of latestInteractions) {
    const stall = stallById.get(interaction.stall_id);
    if (!stall) {
      continue;
    }
    const profile = interaction.attendee_id
      ? await repos.attendeeProfiles.findByAttendeeId(interaction.attendee_id)
      : null;
    const companyDescriptor = buildPublicCompanyDescriptor(profile, eventPolicy);
    latest_connections.push({
      interaction_id: interaction.id,
      stall_id: stall.id,
      stall_name: stall.name,
      created_at: interaction.created_at,
      company_descriptor: companyDescriptor,
      text: `Someone from ${companyDescriptor} connected with ${stall.name}`,
      pii_redacted: true
    });
  }

  return {
    event_id: event.id,
    generated_at: new Date().toISOString(),
    privacy: {
      personal_data_included: false,
      exact_company_names_enabled: canShowExactCompanyOnPublicLeaderboard(eventPolicy),
      rule: "Latest connection ticker is generalized; personal names, emails, and exact companies are excluded unless explicitly enabled with legal basis."
    },
    rankings,
    latest_connections
  };
}

function buildLeaderboardSnapshotPayload({ event, leaderboard, snapshotVersion }) {
  return {
    snapshot_type: "public_leaderboard",
    authoritative_scope: "leaderboard_snapshots",
    event_id: event.id,
    snapshot_version: snapshotVersion,
    snapshot_interval_minutes: LEADERBOARD_SNAPSHOT_INTERVAL_MINUTES,
    calculation_version: Number(event.metrics_definition_version ?? 1),
    formula: {
      ranking: "Count all event interactions per stall; sort by connection_count descending, then stall_name ascending.",
      latest_connection_ticker: "Use latest event interactions and generalized organization descriptors only.",
      privacy: "No attendee name, email, phone, title, or raw attendee profile fields are stored in leaderboard snapshots."
    },
    leaderboard
  };
}

function serializeLeaderboardSnapshot(snapshot) {
  return {
    id: snapshot.id,
    tenant_id: snapshot.tenant_id,
    event_id: snapshot.event_id,
    snapshot_version: snapshot.snapshot_version,
    calculation_version: snapshot.calculation_version,
    snapshot_interval_minutes: snapshot.snapshot_interval_minutes,
    created_by_user_id: snapshot.created_by_user_id ?? null,
    created_at: snapshot.created_at,
    payload: snapshot.payload
  };
}

function enforceLeaderboardSnapshotCadence(existingSnapshots, force) {
  if (force || existingSnapshots.length === 0) {
    return;
  }
  const latestCreatedAt = Date.parse(existingSnapshots[0].created_at);
  if (Number.isNaN(latestCreatedAt)) {
    return;
  }
  const nextAllowedAt = latestCreatedAt + LEADERBOARD_SNAPSHOT_INTERVAL_MINUTES * 60 * 1000;
  if (Date.now() < nextAllowedAt) {
    throw new HttpError(409, "Latest leaderboard snapshot is still inside the 5-minute cadence window", {
      latest_snapshot_id: existingSnapshots[0].id,
      latest_snapshot_created_at: existingSnapshots[0].created_at,
      next_allowed_at: new Date(nextAllowedAt).toISOString(),
      force_supported: true
    });
  }
}

function nextLeaderboardSnapshotVersion(existingSnapshots) {
  return existingSnapshots.reduce(
    (highest, snapshot) => Math.max(highest, Number(snapshot.snapshot_version ?? 0)),
    0
  ) + 1;
}

function buildPublicCompanyDescriptor(profile, eventPolicy) {
  if (canShowExactCompanyOnPublicLeaderboard(eventPolicy) && profile?.company_name) {
    return profile.company_name;
  }
  return inferGeneralizedCompanyDescriptor(profile?.company_name);
}

function canShowExactCompanyOnPublicLeaderboard(eventPolicy) {
  return Boolean(
    eventPolicy?.public_leaderboard_company_names_enabled === true &&
      eventPolicy?.public_leaderboard_company_legal_basis
  );
}

function inferGeneralizedCompanyDescriptor(companyName) {
  const normalized = String(companyName ?? "").toLowerCase();
  if (!normalized) {
    return "an attendee organization";
  }
  if (/\b(enterprise|group|global|international|holdings|capital|bank|pharma|medical|industries|manufacturing)\b/.test(normalized)) {
    return "a large enterprise";
  }
  if (/\b(university|college|school|institute|academy)\b/.test(normalized)) {
    return "an education organization";
  }
  if (/\b(hospital|clinic|health|care)\b/.test(normalized)) {
    return "a healthcare organization";
  }
  return "an attendee organization";
}

const EVENT_POLICY_RETENTION_DAYS = [30, 60, 90, 180, 365];

function validateEventDataControlInput(body) {
  const value = body ?? {};
  for (const field of [
    "vendor_exports_enabled",
    "sponsor_pii_enabled",
    "require_export_approval",
    "allow_crm_push",
    "allow_cross_event_identity_graph"
  ]) {
    if (typeof value[field] !== "boolean") {
      throw new HttpError(400, `${field} must be an explicit boolean`);
    }
  }
  const retentionDays = parsePositiveInteger(value.retention_days, "retention_days");
  if (!EVENT_POLICY_RETENTION_DAYS.includes(retentionDays)) {
    throw new HttpError(
      400,
      `retention_days must be one of ${EVENT_POLICY_RETENTION_DAYS.join(", ")}`
    );
  }
  return {
    vendor_exports_enabled: value.vendor_exports_enabled,
    sponsor_pii_enabled: value.sponsor_pii_enabled,
    require_export_approval: value.require_export_approval,
    allow_crm_push: value.allow_crm_push,
    retention_days: retentionDays,
    allow_cross_event_identity_graph: value.allow_cross_event_identity_graph
  };
}

function buildEventPublishReadiness(event, eventPolicy) {
  const blockers = [];
  if (eventPolicy?.missing_policy_row) {
    blockers.push({
      code: "missing_policy_row",
      message: "No persisted event data-control policy row exists yet. Secure defaults are active until saved."
    });
  }
  if (!EVENT_POLICY_RETENTION_DAYS.includes(Number(eventPolicy?.retention_days))) {
    blockers.push({
      code: "invalid_retention_days",
      message: `Retention must be one of ${EVENT_POLICY_RETENTION_DAYS.join(", ")} days.`
    });
  }
  return {
    ready: blockers.length === 0,
    blockers
  };
}

function serializeEventDataControl(event, eventPolicy) {
  const publishReadiness = buildEventPublishReadiness(event, eventPolicy);
  return {
    event_id: event.id,
    event_name: event.name,
    event_status: event.status,
    policy: {
      vendor_exports_enabled: Boolean(eventPolicy?.vendor_exports_enabled),
      sponsor_pii_enabled: Boolean(eventPolicy?.sponsor_pii_enabled),
      require_export_approval: Boolean(eventPolicy?.require_export_approval ?? true),
      allow_crm_push: Boolean(eventPolicy?.allow_crm_push),
      retention_days: Number(eventPolicy?.retention_days ?? EVENT_POLICY_RETENTION_DAYS[0]),
      allow_cross_event_identity_graph: Boolean(eventPolicy?.allow_cross_event_identity_graph)
    },
    consent_privacy_masking: {
      sponsor_pii_exposed: Boolean(eventPolicy?.sponsor_pii_enabled),
      vendor_exports_enabled: Boolean(eventPolicy?.vendor_exports_enabled),
      break_glass_required_for_platform_unmask: true
    },
    vendor_dashboard_crm: {
      crm_push_allowed: Boolean(eventPolicy?.allow_crm_push),
      export_approval_required: Boolean(eventPolicy?.require_export_approval ?? true)
    },
    database_persistence: {
      policy_row_present: !eventPolicy?.missing_policy_row,
      secure_defaults_applied: Boolean(eventPolicy?.missing_policy_row),
      created_at: eventPolicy?.created_at ?? null,
      updated_at: eventPolicy?.updated_at ?? null,
      allowed_retention_days: EVENT_POLICY_RETENTION_DAYS
    },
    ui_states: {
      publish_ready: publishReadiness.ready,
      publish_blockers: publishReadiness.blockers,
      publish_action_enabled: event.status === "draft" && publishReadiness.ready,
      save_action_enabled: true
    }
  };
}

const LEAD_INBOX_COLUMNS = [
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
];

const LEAD_INBOX_FILTERS = {
  classification: ["hot", "warm", "cold"],
  consent_status: ["pending", "vendor_only", "vendor_and_sponsor", "declined"],
  crm_eligibility: ["eligible", "blocked_by_policy", "blocked_by_consent"]
};

function parseLeadInboxQuery(query = {}) {
  const limit = parsePositiveInteger(query.limit ?? query.per_page ?? "50", "limit");
  const offset = parseNonNegativeInteger(query.offset ?? "0", "offset");
  if (limit > 100) {
    throw new HttpError(400, "limit must be 100 or less");
  }

  const filters = {};
  for (const [field, allowedValues] of Object.entries(LEAD_INBOX_FILTERS)) {
    if (!(field in query) || query[field] === "") {
      continue;
    }
    if (!allowedValues.includes(query[field])) {
      throw new HttpError(400, `${field} filter is invalid`);
    }
    filters[field] = query[field];
  }

  return { limit, offset, filters };
}

function parseArtifactInventoryPagination(query = {}) {
  const limit = parsePositiveInteger(query.limit ?? query.per_page ?? "50", "limit");
  const offset = parseNonNegativeInteger(query.offset ?? "0", "offset");
  if (limit > 200) {
    throw new HttpError(400, "limit must be 200 or less");
  }
  return { limit, offset };
}

function buildPaginationEnvelope(total, pageLength, pagination) {
  return {
    limit: pagination.limit,
    offset: pagination.offset,
    total,
    has_more: pagination.offset + pageLength < total,
    next_offset:
      pagination.offset + pageLength < total
        ? pagination.offset + pageLength
        : null
  };
}

function parsePositiveInteger(value, fieldName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpError(400, `${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, fieldName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(400, `${fieldName} must be a non-negative integer`);
  }
  return parsed;
}

function applyLeadInboxFilters(items, filters) {
  return items.filter((item) => {
    for (const [field, expected] of Object.entries(filters)) {
      if (item[field] !== expected) {
        return false;
      }
    }
    return true;
  });
}

async function buildLeadItem(repos, tenantId, interaction, eventPolicy) {
  const profile = (interaction.attendee_id
    ? await repos.attendeeProfiles.findByAttendeeId(interaction.attendee_id)
    : null) ?? {};
  const consent =
    (await repos.consents.findByInteractionId(tenantId, interaction.id)) ?? {
      vendor_release_allowed: false,
      sponsor_release_allowed: false
    };
  const notes = await repos.interactionNotes.listByInteraction(tenantId, interaction.id);
  const scoreHistory = await repos.leadScores.listByInteraction(tenantId, interaction.id);
  const communicationChannelConsents = await repos.communicationChannelConsents.listByInteraction(tenantId, interaction.id);
  const communicationSuppressions = await repos.communicationSuppressions.listByInteraction(tenantId, interaction.id);
  const followups = await repos.followupMessages.listByInteraction(tenantId, interaction.id);
  const walletPasses = await repos.walletPasses.listByInteraction(tenantId, interaction.id);
  const walletPassIds = new Set(walletPasses.map((walletPass) => walletPass.id));
  const shortLinks = typeof repos.shortLinks?.listByTenant === "function"
    ? (await repos.shortLinks.listByTenant(tenantId)).filter((shortLink) => (
      (shortLink.target_type === "attendee_session" && shortLink.target_id === interaction.id) ||
      (shortLink.target_type === "wallet_pass" && walletPassIds.has(shortLink.target_id))
    ))
    : [];
  const crmSync = await repos.crmSyncRecords.findByInteractionAndProvider(
    tenantId,
    interaction.id,
    PILOT_CRM_PROVIDER
  );
  const crmEligibility = deriveCrmEligibility(interaction, eventPolicy);

  return {
    interaction_id: interaction.id,
    full_name: profile.full_name ?? null,
    company_name: profile.company_name ?? null,
    title: profile.title ?? null,
    email: profile.email ?? null,
    phone: profile.phone ?? null,
    consent_status: interaction.consent_status,
    consent,
    classification: interaction.classification ?? "cold",
    next_action: buildLeadNextAction({ consent, crmEligibility, crmSync }),
    crm_eligibility: crmEligibility,
    status: interaction.status,
    sponsor_click_count: interaction.sponsor_click_count,
    crm_sync: buildCrmSyncResponse(crmSync),
    crm_sync_status: crmSync?.status ?? "not_synced",
    created_at: interaction.created_at,
    updated_at: interaction.updated_at,
    notes_count: notes.length,
    communication_channel_consents: communicationChannelConsents,
    communication_suppressions: communicationSuppressions,
    followups: await Promise.all(followups.map(async (entry) => {
      const notification = entry.notification_id
        ? await repos.notifications.findById(tenantId, entry.notification_id)
        : null;
      const attempts = entry.notification_id
        ? await repos.notificationAttempts.listByNotification(tenantId, entry.notification_id)
        : [];
      const receipts = entry.notification_id
        ? await repos.notificationReceipts.listByNotification(tenantId, entry.notification_id)
        : [];
      const receiptGovernance = notification
        ? await buildNotificationReceiptGovernance({
            repos,
            tenantId,
            notification
          })
        : {
            latest_receipt_type: receipts[0]?.receipt_type ?? null,
            resend_blocked_reason: null,
            resend_review_reason: null
          };
      return {
        id: entry.id,
        channel: entry.channel,
        subject: entry.subject,
        body: entry.body,
        status: entry.status,
        notification_id: entry.notification_id,
        notification_status: notification?.status ?? null,
        queue_state: notification ? deriveNotificationQueueState(notification) : entry.status,
        provider: notification?.provider ?? attempts.at(-1)?.provider ?? null,
        next_attempt_at: notification?.next_attempt_at ?? null,
        sending_started_at: notification?.sending_started_at ?? null,
        last_error: notification?.final_error ?? attempts.at(-1)?.error_message ?? null,
        retry_exhausted_at: notification?.retry_exhausted_at ?? null,
        retry_exhausted_reason: notification?.retry_exhausted_reason ?? null,
        provider_message_id: notification?.provider_message_id ?? attempts.at(-1)?.provider_message_id ?? null,
        attempts: attempts.map((attempt) => ({
          id: attempt.id,
          provider: attempt.provider,
          status: attempt.status,
          attempt_number: attempt.attempt_number ?? null,
          provider_message_id: attempt.provider_message_id,
          http_status: attempt.http_status ?? null,
          duration_ms: attempt.duration_ms ?? null,
          response_excerpt: attempt.response_excerpt ?? null,
          error_message: attempt.error_message,
          attempted_at: attempt.attempted_at
        })),
        attempts_count: attempts.length,
        latest_attempt_status: attempts.at(-1)?.status ?? null,
        latest_attempt_http_status: attempts.at(-1)?.http_status ?? null,
        latest_attempt_duration_ms: attempts.at(-1)?.duration_ms ?? null,
        latest_attempt_response_excerpt: attempts.at(-1)?.response_excerpt ?? null,
        receipts: receipts.map((receipt) => ({
          id: receipt.id,
          provider: receipt.provider,
          receipt_type: receipt.receipt_type,
          provider_message_id: receipt.provider_message_id ?? null,
          provider_event_id: receipt.provider_event_id ?? null,
          summary: receipt.summary ?? null,
          occurred_at: receipt.occurred_at ?? null,
          received_at: receipt.received_at
        })),
        receipts_count: receipts.length,
        latest_receipt_type: receiptGovernance.latest_receipt_type,
        resend_blocked_reason: receiptGovernance.resend_blocked_reason,
        resend_review_reason: receiptGovernance.resend_review_reason,
        created_by_user_id: entry.created_by_user_id,
        approved_by_user_id: entry.approved_by_user_id,
        created_at: entry.created_at,
        updated_at: entry.updated_at
      };
    })),
    followups_count: followups.length,
    wallet_passes: await Promise.all(walletPasses.map((walletPass) => serializeWalletPassWithAttempts(repos, walletPass))),
    wallet_passes_count: walletPasses.length,
    short_links: shortLinks.map((shortLink) => ({
      id: shortLink.id,
      target_type: shortLink.target_type,
      target_id: shortLink.target_id,
      status: shortLink.status,
      expires_at: shortLink.expires_at,
      created_at: shortLink.created_at,
      expired: Boolean(shortLink.expires_at && Date.parse(shortLink.expires_at) < Date.now()),
      revocable: shortLink.status === "active"
    })),
    short_links_count: shortLinks.length,
    score_history: scoreHistory,
    score_history_count: scoreHistory.length,
    latest_score_at: scoreHistory[0]?.created_at ?? null,
    latest_note_at: notes.at(-1)?.created_at ?? null
  };
}

function buildLeadNextAction({ consent, crmEligibility, crmSync }) {
  if (!consent.vendor_release_allowed) {
    return "Collect vendor consent before outreach";
  }
  if (crmSync?.status === "synced") {
    return "Follow up from CRM";
  }
  if (crmSync?.status === "failed") {
    return "Review failed CRM sync";
  }
  if (crmEligibility === "eligible") {
    return "Review lead and push to CRM";
  }
  return "Review event policy before outreach";
}

function buildCrmSyncResponse(record) {
  if (!record) {
    return null;
  }
  return {
    id: record.id,
    provider: record.provider,
    status: record.status,
    external_record_id: record.external_record_id,
    last_error: record.last_error,
    synced_at: record.synced_at,
    deleted_at: record.deleted_at,
    updated_at: record.updated_at
  };
}

function bucketHourly(interactions) {
  const buckets = new Map();
  for (const interaction of interactions) {
    const hour = new Date(interaction.created_at).toISOString().slice(0, 13) + ":00:00Z";
    buckets.set(hour, (buckets.get(hour) ?? 0) + 1);
  }
  return [...buckets.entries()]
    .map(([hour, impressions]) => ({ hour, impressions }))
    .sort((left, right) => left.hour.localeCompare(right.hour));
}

async function resolveSponsorDashboardResources({ repos, principal, params, query }) {
  const sponsorOrganization = await repos.organizations.findById(principal.tenant_id, params.sponsorId);
  const event = await repos.events.findById(principal.tenant_id, query.event_id);
  const eventPolicy = await repos.eventPolicies.findByEventId(principal.tenant_id, event.id);
  return { sponsorOrganization, event, eventPolicy };
}

async function buildSponsorDashboardResponse(repos, sponsorOrganization, event) {
  const stalls = (await repos.stalls.listByEvent(event.tenant_id, event.id))
    .filter((stall) => stall.sponsor_organization_id === sponsorOrganization.id);
  const stallById = new Map(stalls.map((stall) => [stall.id, stall]));
  const stallIds = stalls.map((stall) => stall.id);
  const interactions = (await repos.interactions.listByEvent(event.tenant_id, event.id))
    .filter((interaction) => stallIds.includes(interaction.stall_id));
  const snapshots = await listSponsorReportSnapshots(repos, event.tenant_id, event.id, sponsorOrganization.id);
  const reportFreeze = await buildReportFreezeStatus(repos, event.tenant_id, event);

  const impressions = interactions.length;
  const clickInteractions = interactions.filter((interaction) => (interaction.sponsor_click_count ?? 0) > 0);
  const clicks = clickInteractions.length;
  const totalClicks = interactions.reduce((sum, interaction) => sum + Number(interaction.sponsor_click_count ?? 0), 0);
  const ctr = impressions === 0 ? 0 : Number(((clicks / impressions) * 100).toFixed(2));
  const uniqueAttendees = new Set(interactions.map((interaction) => interaction.attendee_id ?? interaction.id)).size;
  const optedInLeads = interactions.filter((interaction) => interaction.consent_status === "vendor_and_sponsor").length;
  const consentBreakdown = {
    sponsor_opt_in: optedInLeads,
    vendor_only: interactions.filter((interaction) => interaction.consent_status === "vendor_only").length,
    pending_or_masked: interactions.filter((interaction) => interaction.consent_status !== "vendor_and_sponsor" && interaction.consent_status !== "vendor_only").length
  };
  const classificationCounts = interactions.reduce((acc, interaction) => {
    const key = interaction.classification || "unclassified";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const stallBreakdown = stalls.map((stall) => {
    const stallInteractions = interactions.filter((interaction) => interaction.stall_id === stall.id);
    const stallClicks = stallInteractions.filter((interaction) => (interaction.sponsor_click_count ?? 0) > 0).length;
    return {
      stall_id: stall.id,
      stall_name: stall.name,
      impressions: stallInteractions.length,
      clicks: stallClicks,
      ctr: stallInteractions.length === 0 ? 0 : Number(((stallClicks / stallInteractions.length) * 100).toFixed(2)),
      opted_in_leads: stallInteractions.filter((interaction) => interaction.consent_status === "vendor_and_sponsor").length
    };
  }).sort((left, right) => right.impressions - left.impressions);

  return {
    sponsor_id: sponsorOrganization.id,
    sponsor_name: sponsorOrganization.name,
    event_id: event.id,
    event_name: event.name,
    event_status: event.status,
    metrics_definition_version: event.metrics_definition_version,
    report_snapshot_version: event.report_snapshot_version,
    impressions,
    clicks,
    total_clicks: totalClicks,
    ctr,
    opted_in_leads: optedInLeads,
    unique_attendees: uniqueAttendees,
    top_zone: stalls[0]?.name ?? "No sponsored zones yet",
    hourly_trend: bucketHourly(interactions),
    consent_breakdown: consentBreakdown,
    classification_breakdown: classificationCounts,
    stall_breakdown: stallBreakdown,
    latest_snapshot: snapshots[0] ?? null,
    snapshot_count: snapshots.length,
    report_freeze: reportFreeze,
    privacy: {
      personal_data_included: false,
      pii_rule: "Sponsor dashboard metrics are aggregate-only; lead PII is available only through sponsor lead export when event policy and sponsor consent allow it."
    }
  };
}

async function listSponsorReportSnapshots(repos, tenantId, eventId, sponsorId) {
  const snapshots = await repos.reportSnapshots.listByEvent(tenantId, eventId);
  return snapshots
    .filter((snapshot) =>
      snapshot.payload?.snapshot_type === "sponsor_dashboard" &&
      snapshot.payload?.sponsor_id === sponsorId
    )
    .map((snapshot) => ({
      id: snapshot.id,
      event_id: snapshot.event_id,
      report_snapshot_version: snapshot.report_snapshot_version,
      created_at: snapshot.created_at,
      note: snapshot.payload?.note ?? null,
      created_by_user_id: snapshot.payload?.created_by_user_id ?? null,
      dashboard: snapshot.payload?.dashboard ?? null
    }));
}

async function listSponsorOrganizationsForEvent(repos, tenantId, eventId) {
  const stalls = await repos.stalls.listByEvent(tenantId, eventId);
  const ids = [...new Set(stalls.map((stall) => stall.sponsor_organization_id).filter(Boolean))];
  const organizations = [];
  for (const id of ids) {
    organizations.push(await repos.organizations.findById(tenantId, id));
  }
  return organizations;
}

async function buildOrganizerOverviewPayload(repos, event) {
  const assignments = await repos.deviceAssignments.listByEvent(event.tenant_id, event.id);
  const latestHeartbeats = await Promise.all(
    assignments.map(async (assignment) => {
      const records = await repos.heartbeats.listByDevice(event.tenant_id, assignment.device_id);
      return records.sort((left, right) => Date.parse(right.recorded_at) - Date.parse(left.recorded_at))[0] ?? null;
    })
  );
  const onlineDevices = latestHeartbeats.filter((entry) => isRecent(entry?.recorded_at, 120)).length;
  const queueDepths = latestHeartbeats.filter(Boolean).map((entry) => entry.local_queue_depth);
  const avgQueueDepth = queueDepths.length === 0 ? 0 : average(queueDepths);
  const relevantTapEvents = await repos.tapEvents.listByEvent(event.tenant_id, event.id);
  const syncLatencies = relevantTapEvents
    .filter((entry) => entry.cloud_received_at)
    .map((entry) => Date.parse(entry.cloud_received_at) - Date.parse(entry.occurred_at));
  const avgSyncLatencyMs = syncLatencies.length === 0 ? 0 : average(syncLatencies);
  const interactions = await repos.interactions.listByEvent(event.tenant_id, event.id);
  const incidents = await repos.incidents.listByEvent(event.tenant_id, event.id);
  return {
    event_id: event.id,
    event_status: event.status,
    metrics_definition_version: event.metrics_definition_version,
    report_snapshot_version: event.report_snapshot_version,
    total_interactions: interactions.length,
    online_devices: onlineDevices,
    offline_devices: assignments.length - onlineDevices,
    average_queue_depth: Number(avgQueueDepth.toFixed(2)),
    average_sync_latency_ms: Number(avgSyncLatencyMs.toFixed(2)),
    open_incidents: incidents.filter((entry) => entry.status !== "resolved").length,
    top_stalls: await topStalls(repos, event.tenant_id, event.id)
  };
}

async function buildReportFreezeStatus(repos, tenantId, event) {
  const snapshots = await repos.reportSnapshots.listByEvent(tenantId, event.id);
  const officialSnapshots = snapshots
    .filter((entry) => entry.payload?.snapshot_type === "official_event_report")
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const sponsorSnapshots = snapshots.filter((entry) => entry.payload?.snapshot_type === "sponsor_dashboard");
  const exports = [...await repos.exportRequests.listByEvent(tenantId, event.id)]
    .filter((entry) => entry.export_type === "organizer_event_report")
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const incidents = await repos.incidents.listByEvent(tenantId, event.id);
  const unresolvedIncidents = incidents.filter((entry) => entry.status !== "resolved").length;
  const latestOfficial = officialSnapshots[0] ?? null;
  const artifactFreezeChecks = await buildArtifactFreezeChecks(repos, event);
  return {
    event_id: event.id,
    event_status: event.status,
    report_snapshot_version: event.report_snapshot_version,
    latest_official_snapshot: latestOfficial
      ? {
          id: latestOfficial.id,
          created_at: latestOfficial.created_at,
          note: latestOfficial.payload?.note ?? null
        }
      : null,
    sponsor_snapshot_count: sponsorSnapshots.length,
    latest_official_export: exports[0] ?? null,
    unresolved_incidents: unresolvedIncidents,
    artifact_freeze_checks: artifactFreezeChecks,
    frozen: event.status === "closed" && Boolean(latestOfficial)
  };
}

async function buildArtifactFreezeChecks(repos, event) {
  const [alerts, walletPasses, allShortLinks] = await Promise.all([
    buildOperationalArtifactAlerts(repos, event),
    typeof repos.walletPasses?.listByEvent === "function"
      ? repos.walletPasses.listByEvent(event.tenant_id, event.id)
      : [],
    typeof repos.shortLinks?.listByTenant === "function"
      ? repos.shortLinks.listByTenant(event.tenant_id)
      : []
  ]);
  let activeShortLinks = 0;
  for (const shortLink of allShortLinks) {
    if (!["export_download", "wallet_pass"].includes(shortLink.target_type)) {
      continue;
    }
    if (shortLink.status !== "active" || (shortLink.expires_at && Date.parse(shortLink.expires_at) < Date.now())) {
      continue;
    }
    const resources = await resolveShortLinkTargetResources(repos, shortLink);
    if (resources.event?.id === event.id) {
      activeShortLinks += 1;
    }
  }
  const pendingWalletDelivery = walletPasses.filter((walletPass) => walletPass.status === "generated").length;
  const failedArtifacts = alerts.counts.warning;
  const unresolvedArtifacts = failedArtifacts + activeShortLinks + pendingWalletDelivery;
  return {
    ready: unresolvedArtifacts === 0,
    unresolved_artifacts: unresolvedArtifacts,
    failed_or_cancelled_artifacts: failedArtifacts,
    active_short_links: activeShortLinks,
    pending_wallet_delivery: pendingWalletDelivery,
    generated_at: new Date().toISOString()
  };
}

async function buildComplianceCloseoutReadiness(repos, event, eventPolicy) {
  const [complianceOverview, reportFreeze, exports] = await Promise.all([
    buildComplianceOverview({ repos, event, eventPolicy }),
    buildReportFreezeStatus(repos, event.tenant_id, event),
    repos.exportRequests.listByEvent(event.tenant_id, event.id)
  ]);

  const items = [];
  const blockers = [];
  const warnings = [];

  const officialFreezePackageReady =
    reportFreeze.frozen && reportFreeze.latest_official_export?.status === "generated";
  pushReadinessItem(items, blockers, {
    key: "report_freeze",
    label: "Official event report is frozen and the final organizer package is generated",
    passed: officialFreezePackageReady,
    blockerMessage: "Freeze the official event report before closing out compliance operations"
  });

  pushReadinessItem(items, blockers, {
    key: "artifact_freeze_checks",
    label: "Wallet, notification, and signed-link artifacts are clear for event close",
    passed: reportFreeze.artifact_freeze_checks?.ready === true,
    blockerMessage: "Resolve failed artifacts, pending wallet delivery, and active signed links before closeout"
  });

  const dsrQueueClear =
    Number(complianceOverview.dsr_counts.requested ?? 0) === 0 &&
    Number(complianceOverview.dsr_counts.in_progress ?? 0) === 0;
  pushReadinessItem(items, blockers, {
    key: "dsr_queue",
    label: "No requested or in-progress data-subject requests remain",
    passed: dsrQueueClear,
    blockerMessage: "Complete or reject all open data-subject requests before compliance closeout"
  });

  const downstreamQueueClear =
    Number(complianceOverview.downstream_deletion_counts.pending ?? 0) === 0 &&
    Number(complianceOverview.downstream_deletion_counts.failed ?? 0) === 0;
  pushReadinessItem(items, blockers, {
    key: "downstream_deletions",
    label: "No pending or failed downstream deletion records remain",
    passed: downstreamQueueClear,
    blockerMessage: "Resolve downstream deletion retries and failures before compliance closeout"
  });

  const crmCleanupClear =
    Number(complianceOverview.crm_sync_counts.delete_pending ?? 0) === 0 &&
    Number(complianceOverview.crm_sync_counts.failed ?? 0) === 0;
  pushReadinessItem(items, blockers, {
    key: "crm_cleanup",
    label: "CRM sync cleanup has no pending-delete or failed records",
    passed: crmCleanupClear,
    blockerMessage: "Clear pending or failed CRM cleanup records before compliance closeout"
  });

  const latestRetentionRun = complianceOverview.latest_retention_run;
  const retentionReviewed = Boolean(latestRetentionRun);
  pushReadinessItem(items, blockers, {
    key: "retention_review",
    label: event.status === "archived"
      ? "Retention apply has been executed for the archived event"
      : "Retention posture has been reviewed for the event",
    passed: event.status === "archived"
      ? latestRetentionRun?.run_type === "retention_apply"
      : retentionReviewed,
    blockerMessage: event.status === "archived"
      ? "Archived events must have a completed retention apply run recorded"
      : "Run at least a retention preview before compliance closeout"
  });

  const complianceAuditExports = [...exports]
    .filter((entry) =>
      entry.export_type === "organizer_event_report" &&
      entry.filters?.report_variant === "compliance_audit"
    )
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
  const latestComplianceAuditExport = complianceAuditExports[0] ?? null;
  const complianceAuditReady = latestComplianceAuditExport?.status === "generated";
  pushReadinessItem(items, blockers, {
    key: "compliance_audit_export",
    label: "A compliance audit export is generated and ready to download",
    passed: complianceAuditReady,
    blockerMessage: "Generate and approve the compliance audit export before compliance closeout"
  });

  if (latestComplianceAuditExport?.status === "requested") {
    warnings.push("COMPLIANCE_AUDIT_EXPORT_PENDING_APPROVAL");
  }
  if (complianceOverview.retention_due && event.status !== "archived") {
    warnings.push("RETENTION_DUE_NOT_APPLIED");
  }
  if (reportFreeze.unresolved_incidents > 0) {
    warnings.push("UNRESOLVED_INCIDENTS_AT_CLOSEOUT");
  }

  return {
    ready: blockers.length === 0,
    checked_from: {
      event_id: event.id,
      event_status: event.status,
      retention_due_at: complianceOverview.retention_due_at,
      latest_retention_run_at: latestRetentionRun?.created_at ?? null,
      latest_compliance_audit_export_at: latestComplianceAuditExport?.created_at ?? null,
      latest_official_report_at: reportFreeze.latest_official_snapshot?.created_at ?? null
    },
    blockers,
    warnings,
    checklist: items,
    summary: {
      dsr_counts: complianceOverview.dsr_counts,
      downstream_deletion_counts: complianceOverview.downstream_deletion_counts,
      crm_sync_counts: complianceOverview.crm_sync_counts,
      unresolved_incidents: reportFreeze.unresolved_incidents
    },
    latest_compliance_audit_export: latestComplianceAuditExport,
    runbook_links: {
      staging_runbook: "/Users/kishore/Codex Development/deploy/staging/README.md",
      compliance_closeout_runbook: "/Users/kishore/Codex Development/deploy/staging/PILOT_COMPLIANCE_CLOSEOUT_RUNBOOK.md",
      downstream_integrations_runbook: "/Users/kishore/Codex Development/deploy/staging/PILOT_DOWNSTREAM_INTEGRATIONS_RUNBOOK.md"
    },
    recommended_actions: [
      {
        label: "View compliance report",
        endpoint: `/organizer/events/${event.id}/compliance/report`
      },
      {
        label: "View DSR queue",
        endpoint: `/organizer/events/${event.id}/dsr`
      },
      {
        label: "View report freeze status",
        endpoint: `/organizer/events/${event.id}/report-freeze`
      },
      {
        label: "Request compliance audit export",
        endpoint: `/organizer/events/${event.id}/compliance/audit-export`
      },
      {
        label: "Run retention workflow",
        endpoint: `/organizer/events/${event.id}/compliance/retention`
      }
    ]
  };
}

async function buildExportDownloadPayload(repos, tenantId, eventId, exportRequest) {
  if (exportRequest.export_type === "sponsor_dashboard_snapshot") {
    const snapshotId = exportRequest.filters?.snapshot_id;
    const sponsorId = exportRequest.filters?.sponsor_id;
    const snapshots = await repos.reportSnapshots.listByEvent(tenantId, eventId);
    const snapshot = snapshots.find((entry) => entry.id === snapshotId && entry.payload?.sponsor_id === sponsorId);
    if (!snapshot) {
      throw new HttpError(404, "Sponsor snapshot export payload not found");
    }
    return {
      file_name: `${sponsorId}-snapshot-${snapshot.report_snapshot_version}.json`,
      payload: snapshot.payload
    };
  }

  if (exportRequest.export_type === "organizer_event_report") {
    if (exportRequest.filters?.report_variant === "compliance_audit") {
      const event = await repos.events.findById(tenantId, eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(tenantId, eventId);
      return {
        file_name: `event-${eventId}-compliance-audit.json`,
        payload: await buildComplianceOperationalReport({
          repos,
          event,
          eventPolicy
        })
      };
    }
    if (exportRequest.filters?.report_variant === "pilot_signoff") {
      const event = await repos.events.findById(tenantId, eventId);
      const eventPolicy = await repos.eventPolicies.findByEventId(tenantId, eventId);
      return {
        file_name: `event-${eventId}-pilot-signoff.json`,
        payload: await buildPilotSignoffPack(repos, event, eventPolicy)
      };
    }
    const snapshotId = exportRequest.filters?.report_snapshot_id ?? null;
    const snapshots = await repos.reportSnapshots.listByEvent(tenantId, eventId);
    const snapshot = snapshots
      .filter((entry) => entry.payload?.snapshot_type === "official_event_report")
      .find((entry) => !snapshotId || entry.id === snapshotId);
    const payload = snapshot
      ? snapshot.payload
      : {
          snapshot_type: "organizer_event_report_live",
          overview: await buildOrganizerOverviewPayload(repos, await repos.events.findById(tenantId, eventId))
        };
    return {
      file_name: `event-${eventId}-report.json`,
      payload
    };
  }

  if (exportRequest.export_type === "vendor_leads" || exportRequest.export_type === "sponsor_leads") {
    return buildLeadExportPayload(repos, tenantId, eventId, exportRequest);
  }

  return {
    file_name: `${exportRequest.export_type}-${eventId}.json`,
    payload: {
      export_type: exportRequest.export_type,
      event_id: eventId
    }
  };
}

async function buildLeadExportPayload(repos, tenantId, eventId, exportRequest) {
  const eventPolicy = await repos.eventPolicies.findByEventId(tenantId, eventId);
  if (exportRequest.export_type === "vendor_leads" && !eventPolicy.vendor_exports_enabled) {
    throw new HttpError(403, "Vendor exports disabled by event policy");
  }
  if (exportRequest.export_type === "sponsor_leads" && !eventPolicy.sponsor_pii_enabled) {
    throw new HttpError(403, "Sponsor PII disabled by event policy");
  }

  const [interactions, stalls] = await Promise.all([
    repos.interactions.listByEvent(tenantId, eventId),
    repos.stalls.listByEvent(tenantId, eventId)
  ]);
  const stallById = new Map(stalls.map((stall) => [stall.id, stall]));
  const allowedStallIds = scopedLeadExportStallIds(stalls, exportRequest);
  const eligibleInteractions = interactions
    .filter((interaction) => allowedStallIds.has(interaction.stall_id))
    .filter((interaction) => leadExportConsentAllowed(interaction, exportRequest.export_type));
  const leads = await Promise.all(
    eligibleInteractions.map(async (interaction) => {
      const profile = interaction.attendee_id
        ? await repos.attendeeProfiles.findByAttendeeId(interaction.attendee_id)
        : null;
      const stall = stallById.get(interaction.stall_id);
      return {
        interaction_id: interaction.id,
        stall_id: interaction.stall_id,
        stall_name: stall?.name ?? null,
        consent_status: interaction.consent_status,
        classification: interaction.classification ?? "cold",
        created_at: interaction.created_at,
        profile: {
          full_name: profile?.full_name ?? null,
          company_name: profile?.company_name ?? null,
          title: profile?.title ?? null,
          email: profile?.email ?? null,
          phone: profile?.phone ?? null
        }
      };
    })
  );

  return {
    file_name: `${exportRequest.export_type}-${eventId}.json`,
    payload: {
      export_type: exportRequest.export_type,
      event_id: eventId,
      privacy: {
        personal_data_included: true,
        consent_rule:
          exportRequest.export_type === "sponsor_leads"
            ? "Only interactions with vendor_and_sponsor consent are included; sponsor_pii_enabled must remain true at download time."
            : "Only interactions with vendor_only or vendor_and_sponsor consent are included; revoked, declined, and pending interactions are excluded at download time.",
        scope_rule: "Rows are limited to the requesting vendor or sponsor organization when the export is organization-scoped."
      },
      leads
    }
  };
}

function scopedLeadExportStallIds(stalls, exportRequest) {
  const organizationId = exportRequest.requested_for_organization_id;
  if (!organizationId) {
    return new Set(stalls.map((stall) => stall.id));
  }
  if (exportRequest.export_type === "vendor_leads") {
    return new Set(
      stalls
        .filter((stall) => stall.vendor_organization_id === organizationId)
        .map((stall) => stall.id)
    );
  }
  if (exportRequest.export_type === "sponsor_leads") {
    return new Set(
      stalls
        .filter((stall) => stall.sponsor_organization_id === organizationId)
        .map((stall) => stall.id)
    );
  }
  return new Set(stalls.map((stall) => stall.id));
}

function leadExportConsentAllowed(interaction, exportType) {
  if (exportType === "sponsor_leads") {
    return interaction.consent_status === "vendor_and_sponsor";
  }
  if (exportType === "vendor_leads") {
    return ["vendor_only", "vendor_and_sponsor"].includes(interaction.consent_status);
  }
  return false;
}

function buildAttendeeSessionPayload(interaction, tenantId) {
  return {
    purpose: "attendee_session",
    tenant_id: tenantId,
    interaction_id: interaction.id,
    event_id: interaction.event_id,
    expires_at: inHours(8)
  };
}

async function buildIotIntegrationStatus(repos, tenantId, eventId) {
  const integrationName = "iot_platform";
  const certification = await repos.iotCertificationStatuses.findByIntegration(integrationName);
  const health = await repos.iotIntegrationHealthStatuses.findByEvent(tenantId, integrationName, eventId);
  const latestRun = await repos.iotIntegrationRuns.findLatestByEvent(tenantId, integrationName, eventId);
  const parity = await repos.iotEnvironmentParityStatuses.findByEvent(tenantId, integrationName, eventId);
  const alerts = await repos.iotAlertEvents.listByEvent(tenantId, eventId, {
    status: "open",
    limit: 10
  });
  const [tapCheckpoint, heartbeatCheckpoint, incidentCheckpoint] = await Promise.all([
    repos.iotSyncCheckpoints.findByIntegrationAndStream(integrationName, "taps"),
    repos.iotSyncCheckpoints.findByIntegrationAndStream(integrationName, "heartbeats"),
    repos.iotSyncCheckpoints.findByIntegrationAndStream(integrationName, "incidents")
  ]);

  return {
    certification: certification
      ? {
          status: certification.status,
          contract_version: certification.contract_version,
          environment: certification.environment,
          build_version: certification.build_version,
          last_checked_at: certification.last_checked_at,
          last_certified_at: certification.last_certified_at,
          last_failure_at: certification.last_failure_at,
          last_failure_message: certification.last_failure_message,
          certification_pack: certification.metadata?.certification_pack ?? null,
          consecutive_failure_count: certification.metadata?.consecutive_failure_count ?? 0,
          metadata: certification.metadata ?? {}
        }
      : {
          status: "unknown",
          contract_version: null,
          environment: null,
          build_version: null,
          last_checked_at: null,
          last_certified_at: null,
          last_failure_at: null,
          last_failure_message: null,
          metadata: {}
        },
    health: formatHealthStatus(health),
    parity: formatParityStatus(parity),
    alerts: {
      open_count: await repos.iotAlertEvents.countOpenByEvent(tenantId, eventId),
      items: alerts.map(formatAlertEvent)
    },
    latest_run: formatIntegrationRun(latestRun),
    streams: {
      taps: formatStreamCheckpoint(tapCheckpoint),
      heartbeats: formatStreamCheckpoint(heartbeatCheckpoint),
      incidents: formatStreamCheckpoint(incidentCheckpoint)
    }
  };
}

function buildGoLiveReadiness(eventId, iotIntegration) {
  const items = [];
  const blockers = [];
  const warnings = [];

  const certificationReady =
    iotIntegration.certification.status === "certified" &&
    !!iotIntegration.certification.contract_version;
  pushReadinessItem(items, blockers, {
    key: "staging_certification",
    label: "Staging certification is current",
    passed: certificationReady,
    blockerMessage: "Staging contract certification must pass before pilot go-live"
  });

  const healthReady =
    ["healthy", "warning"].includes(iotIntegration.health.status) && !iotIntegration.health.is_stale;
  pushReadinessItem(items, blockers, {
    key: "operational_health",
    label: "Operational health is fresh and non-critical",
    passed: healthReady,
    blockerMessage: "Operational health must be fresh and not critical before pilot go-live"
  });

  const parityReady = iotIntegration.parity.status === "passed";
  pushReadinessItem(items, blockers, {
    key: "release_parity",
    label: "Staging and production match the approved release manifest",
    passed: parityReady,
    blockerMessage: "Staging-to-production parity must pass against the approved release manifest"
  });

  const latestRunReady = ["completed", "completed_with_warnings"].includes(
    iotIntegration.latest_run?.status ?? "unknown"
  );
  pushReadinessItem(items, blockers, {
    key: "latest_run",
    label: "Latest integration orchestration run completed",
    passed: latestRunReady,
    blockerMessage: "Run a successful integration orchestration before pilot go-live"
  });

  const openCriticalAlerts = iotIntegration.alerts.items.filter((entry) => entry.severity === "critical").length;
  pushReadinessItem(items, blockers, {
    key: "critical_alerts",
    label: "No open critical IoT alerts remain",
    passed: openCriticalAlerts === 0,
    blockerMessage: "Critical IoT alerts must be resolved before pilot go-live"
  });

  if (iotIntegration.health.warning_count > 0) {
    warnings.push(...iotIntegration.health.warnings.map((entry) => entry.code));
  }
  if (iotIntegration.latest_run?.status === "completed_with_warnings") {
    warnings.push("LATEST_RUN_COMPLETED_WITH_WARNINGS");
  }

  return {
    ready: blockers.length === 0,
    checked_from: {
      event_id: eventId,
      certification_checked_at: iotIntegration.certification.last_checked_at,
      health_checked_at: iotIntegration.health.checked_at,
      parity_checked_at: iotIntegration.parity.checked_at,
      latest_run_started_at: iotIntegration.latest_run?.started_at ?? null
    },
    blockers,
    warnings,
    checklist: items,
    runbook_links: {
      staging_runbook: "/Users/kishore/Codex Development/deploy/staging/README.md",
      pilot_go_live_runbook: "/Users/kishore/Codex Development/deploy/staging/PILOT_GO_LIVE_RUNBOOK.md",
      pilot_go_live_checklist: "/Users/kishore/Codex Development/deploy/staging/PILOT_GO_LIVE_CHECKLIST.md"
    },
    recommended_actions: [
      {
        label: "View IoT health",
        endpoint: `/organizer/events/${eventId}/iot-health`
      },
      {
        label: "View IoT alerts",
        endpoint: `/organizer/events/${eventId}/iot-alerts`
      },
      {
        label: "Trigger integration run",
        endpoint: `/organizer/events/${eventId}/iot-runs/trigger`
      },
      {
        label: "Trigger parity check",
        endpoint: `/organizer/events/${eventId}/iot-parity/trigger`
      }
    ]
  };
}

async function buildPilotRehearsalReport(repos, event, eventPolicy) {
  const [auditLogs, dsrRequests, downstreamRecords, exports, incidents, reportFreeze, breakGlassRequests] = await Promise.all([
    repos.auditLogs.listByTenant(event.tenant_id),
    repos.dataSubjectRequests.listByEvent(event.tenant_id, event.id),
    repos.downstreamDeletionRecords.listByEvent(event.tenant_id, event.id),
    repos.exportRequests.listByEvent(event.tenant_id, event.id),
    repos.incidents.listByEvent(event.tenant_id, event.id),
    buildReportFreezeStatus(repos, event.tenant_id, event),
    repos.breakGlassAccess.listByTenant(event.tenant_id)
  ]);

  const incidentIds = new Set(incidents.map((entry) => entry.id));
  const relevantExports = exports.filter((entry) => entry.event_id === event.id);
  const generatedComplianceAuditExport = [...relevantExports]
    .filter((entry) =>
      entry.export_type === "organizer_event_report" &&
      entry.filters?.report_variant === "compliance_audit" &&
      entry.status === "generated"
    )
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0] ?? null;

  const incidentStateEvidence = auditLogs.filter(
    (entry) => entry.event_type === "organizer.incident_state.updated" && incidentIds.has(entry.target_id)
  );
  const incidentRunbookEvidence = auditLogs.filter(
    (entry) => entry.event_type === "organizer.incident_runbook.updated" && incidentIds.has(entry.target_id)
  );
  const breakGlassApprovals = auditLogs.filter((entry) => entry.event_type === "break_glass.approved");
  const incidentResponseExercised = incidents.some((entry) => ["escalated", "resolved"].includes(entry.status));
  const incidentRunbookExercised = incidents.some((entry) => Boolean(entry.metadata?.runbook_tracking));

  const accessCompleted = dsrRequests.some(
    (entry) => entry.request_type === "access" && entry.status === "completed"
  );
  const deleteCompleted = dsrRequests.some(
    (entry) => entry.request_type === "delete" && entry.status === "completed"
  );
  const downstreamConfirmed = downstreamRecords.some((entry) => entry.status === "confirmed");
  const generatedExportExists = relevantExports.some((entry) => entry.status === "generated");
  const breakGlassExercised = breakGlassRequests.some((entry) =>
    ["partially_approved", "active", "revoked", "expired"].includes(entry.status)
  );
  const unresolvedIncidents = incidents.filter((entry) => entry.status !== "resolved");

  const items = [];
  const blockers = [];

  pushReadinessItem(items, blockers, {
    key: "incident_response",
    label: "Incident escalation or resolution was exercised during rehearsal",
    passed: incidentResponseExercised,
    blockerMessage: "Rehearsal must include an incident escalation or resolution exercise"
  });
  pushReadinessItem(items, blockers, {
    key: "incident_runbook",
    label: "Incident runbook/workaround tracking was exercised during rehearsal",
    passed: incidentRunbookExercised,
    blockerMessage: "Rehearsal must include runbook and workaround tracking"
  });
  pushReadinessItem(items, blockers, {
    key: "break_glass",
    label: "Break-glass approval flow was exercised",
    passed: breakGlassExercised,
    blockerMessage: "Rehearsal must include a break-glass approval exercise"
  });
  pushReadinessItem(items, blockers, {
    key: "dsr_access",
    label: "Access-request packaging was exercised",
    passed: accessCompleted,
    blockerMessage: "Rehearsal must include a completed access DSR workflow"
  });
  pushReadinessItem(items, blockers, {
    key: "dsr_delete",
    label: "Delete-request workflow was exercised",
    passed: deleteCompleted,
    blockerMessage: "Rehearsal must include a completed delete DSR workflow"
  });
  pushReadinessItem(items, blockers, {
    key: "downstream_dispatch",
    label: "Downstream deletion dispatch was exercised",
    passed: downstreamConfirmed,
    blockerMessage: "Rehearsal must include a confirmed downstream deletion dispatch"
  });
  pushReadinessItem(items, blockers, {
    key: "export_controls",
    label: "Controlled export generation was exercised",
    passed: generatedExportExists,
    blockerMessage: "Rehearsal must include a generated export through the controlled export flow"
  });
  pushReadinessItem(items, blockers, {
    key: "report_freeze",
    label: "Official report freeze workflow was exercised",
    passed: reportFreeze.frozen,
    blockerMessage: "Rehearsal must include the official report freeze workflow"
  });
  pushReadinessItem(items, blockers, {
    key: "compliance_audit_export",
    label: "Compliance audit export was generated",
    passed: Boolean(generatedComplianceAuditExport),
    blockerMessage: "Rehearsal must include a generated compliance audit export"
  });
  pushReadinessItem(items, blockers, {
    key: "incident_backlog",
    label: "No unresolved rehearsal incidents remain open",
    passed: unresolvedIncidents.length === 0,
    blockerMessage: "Resolve open rehearsal incidents before final pilot readiness review"
  });

  return {
    ready: blockers.length === 0,
    checked_at: new Date().toISOString(),
    blockers,
    checklist: items,
    evidence: {
      incident_state_updates: incidentStateEvidence.length,
      incident_runbook_updates: incidentRunbookEvidence.length,
      break_glass_approvals: breakGlassApprovals.length,
      completed_access_dsrs: dsrRequests.filter((entry) => entry.request_type === "access" && entry.status === "completed").length,
      completed_delete_dsrs: dsrRequests.filter((entry) => entry.request_type === "delete" && entry.status === "completed").length,
      confirmed_downstream_dispatches: downstreamRecords.filter((entry) => entry.status === "confirmed").length,
      generated_exports: relevantExports.filter((entry) => entry.status === "generated").length,
      unresolved_incidents: unresolvedIncidents.length
    },
    latest_compliance_audit_export: generatedComplianceAuditExport,
    runbook_links: {
      pilot_rehearsal_runbook: "/Users/kishore/Codex Development/deploy/staging/PILOT_REHEARSAL_RUNBOOK.md",
      pilot_go_live_runbook: "/Users/kishore/Codex Development/deploy/staging/PILOT_GO_LIVE_RUNBOOK.md",
      compliance_closeout_runbook: "/Users/kishore/Codex Development/deploy/staging/PILOT_COMPLIANCE_CLOSEOUT_RUNBOOK.md"
    },
    recommended_actions: [
      {
        label: "View incidents",
        endpoint: `/organizer/events/${event.id}/incidents`
      },
      {
        label: "View exports",
        endpoint: `/organizer/events/${event.id}/exports`
      },
      {
        label: "View compliance report",
        endpoint: `/organizer/events/${event.id}/compliance/report`
      },
      {
        label: "View report freeze status",
        endpoint: `/organizer/events/${event.id}/report-freeze`
      }
    ]
  };
}

async function buildPilotSignoffPack(repos, event, eventPolicy) {
  const [iotIntegration, complianceReadiness, rehearsal, reportFreeze, exports] = await Promise.all([
    buildIotIntegrationStatus(repos, event.tenant_id, event.id),
    buildComplianceCloseoutReadiness(repos, event, eventPolicy),
    buildPilotRehearsalReport(repos, event, eventPolicy),
    buildReportFreezeStatus(repos, event.tenant_id, event),
    repos.exportRequests.listByEvent(event.tenant_id, event.id)
  ]);

  const goLiveReadiness = buildGoLiveReadiness(event.id, iotIntegration);
  const latestPilotSignoffExport =
    [...exports]
      .filter(
        (entry) =>
          entry.export_type === "organizer_event_report" &&
          entry.filters?.report_variant === "pilot_signoff"
      )
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0] ?? null;

  const items = [];
  const blockers = [];
  const warnings = [];

  pushReadinessItem(items, blockers, {
    key: "iot_go_live",
    label: "IoT go-live readiness gate is clear",
    passed: goLiveReadiness.ready,
    blockerMessage: "Clear IoT go-live readiness blockers before final pilot signoff"
  });
  pushReadinessItem(items, blockers, {
    key: "pilot_rehearsal",
    label: "Pilot rehearsal evidence gate is complete",
    passed: rehearsal.ready,
    blockerMessage: "Complete the pilot rehearsal evidence gate before final pilot signoff"
  });
  pushReadinessItem(items, blockers, {
    key: "compliance_closeout",
    label: "Compliance closeout readiness gate is clear",
    passed: complianceReadiness.ready,
    blockerMessage: "Clear compliance closeout blockers before final pilot signoff"
  });
  pushReadinessItem(items, blockers, {
    key: "official_package",
    label: "Official event report package is frozen and generated",
    passed: reportFreeze.frozen && reportFreeze.latest_official_export?.status === "generated",
    blockerMessage: "Freeze the official event report package before final pilot signoff"
  });

  warnings.push(
    ...(goLiveReadiness.warnings ?? []).map((entry) => `IOT:${entry}`),
    ...(complianceReadiness.warnings ?? []).map((entry) => `COMPLIANCE:${entry}`)
  );

  return {
    ready: blockers.length === 0,
    checked_at: new Date().toISOString(),
    blockers,
    warnings,
    checklist: items,
    summary: {
      event_status: event.status,
      report_snapshot_version: reportFreeze.report_snapshot_version,
      unresolved_incidents: reportFreeze.unresolved_incidents,
      iot_blocker_count: goLiveReadiness.blockers.length,
      rehearsal_blocker_count: rehearsal.blockers.length,
      compliance_blocker_count: complianceReadiness.blockers.length
    },
    latest_pilot_signoff_export: latestPilotSignoffExport,
    sections: {
      iot_go_live: goLiveReadiness,
      pilot_rehearsal: rehearsal,
      compliance_closeout: complianceReadiness,
      report_freeze: reportFreeze
    },
    runbook_links: {
      staging_runbook: "/Users/kishore/Codex Development/deploy/staging/README.md",
      pilot_go_live_runbook: "/Users/kishore/Codex Development/deploy/staging/PILOT_GO_LIVE_RUNBOOK.md",
      pilot_go_live_checklist: "/Users/kishore/Codex Development/deploy/staging/PILOT_GO_LIVE_CHECKLIST.md",
      pilot_rehearsal_runbook: "/Users/kishore/Codex Development/deploy/staging/PILOT_REHEARSAL_RUNBOOK.md",
      compliance_closeout_runbook: "/Users/kishore/Codex Development/deploy/staging/PILOT_COMPLIANCE_CLOSEOUT_RUNBOOK.md",
      pilot_signoff_pack: "/Users/kishore/Codex Development/deploy/staging/PILOT_SIGNOFF_PACK.md"
    },
    recommended_actions: [
      {
        label: "View IoT go-live readiness",
        endpoint: `/organizer/events/${event.id}/iot-go-live-readiness`
      },
      {
        label: "View rehearsal report",
        endpoint: `/organizer/events/${event.id}/pilot-rehearsal-report`
      },
      {
        label: "View compliance closeout readiness",
        endpoint: `/organizer/events/${event.id}/compliance/closeout-readiness`
      },
      {
        label: "Request pilot signoff export",
        endpoint: `/organizer/events/${event.id}/pilot-signoff-export`
      }
    ]
  };
}

async function buildPilotGoLiveExecution(repos, event, eventPolicy) {
  const [signoffPack, latestDryRun, approvals] = await Promise.all([
    buildPilotSignoffPack(repos, event, eventPolicy),
    repos.pilotDryRunRecords.findLatestByEvent(event.tenant_id, event.id),
    repos.pilotSignoffApprovals.listByEvent(event.tenant_id, event.id)
  ]);

  const approvalMap = new Map(approvals.map((entry) => [entry.approver_role, entry]));
  const approvalItems = ["organizer", "platform", "iot"].map((role) => {
    const existing = approvalMap.get(role);
    return existing ?? {
      approver_role: role,
      approver_label: role === "iot" ? "IoT team" : `${capitalize(role)} owner`,
      approval_status: "pending",
      note: null,
      approved_at: null,
      updated_at: null
    };
  });

  const dryRunPassed =
    latestDryRun?.status === "completed" &&
    (latestDryRun.summary?.all_checks_passed === true || (latestDryRun.blockers ?? []).length === 0);

  const items = [];
  const blockers = [];
  const warnings = [];

  pushReadinessItem(items, blockers, {
    key: "pilot_signoff_pack",
    label: "Pilot signoff pack is ready",
    passed: signoffPack.ready,
    blockerMessage: "Pilot signoff pack must be ready before the joint go-live execution can be approved"
  });
  pushReadinessItem(items, blockers, {
    key: "staging_dry_run",
    label: "Latest staging go-live dry run completed with all checks passing",
    passed: dryRunPassed,
    blockerMessage: "Record a successful staging go-live dry run before final pilot signoff"
  });

  for (const approval of approvalItems) {
    pushReadinessItem(items, blockers, {
      key: `approval_${approval.approver_role}`,
      label: `${capitalize(approval.approver_role)} approval is recorded`,
      passed: approval.approval_status === "approved",
      blockerMessage: `Record an approved ${approval.approver_role} signoff before final pilot go-live`
    });
    if (approval.approval_status === "rejected") {
      warnings.push(`SIGNOFF_REJECTED_${approval.approver_role.toUpperCase()}`);
    }
  }

  if (latestDryRun?.status === "failed") {
    warnings.push("STAGING_DRY_RUN_FAILED");
  }

  return {
    ready: blockers.length === 0,
    checked_at: new Date().toISOString(),
    blockers,
    warnings,
    checklist: items,
    signoff_pack: signoffPack,
    latest_dry_run: latestDryRun,
    approvals: approvalItems,
    runbook_links: {
      staging_runbook: "/Users/kishore/Codex Development/deploy/staging/README.md",
      pilot_go_live_runbook: "/Users/kishore/Codex Development/deploy/staging/PILOT_GO_LIVE_RUNBOOK.md",
      pilot_signoff_pack: "/Users/kishore/Codex Development/deploy/staging/PILOT_SIGNOFF_PACK.md",
      joint_execution_runbook: "/Users/kishore/Codex Development/deploy/staging/JOINT_PILOT_SIGNOFF_EXECUTION.md"
    },
    recommended_actions: [
      {
        label: "View pilot signoff pack",
        endpoint: `/organizer/events/${event.id}/pilot-signoff-pack`
      },
      {
        label: "Record staging dry run",
        endpoint: `/organizer/events/${event.id}/pilot-go-live-dry-run`
      },
      {
        label: "Record joint approvals",
        endpoint: `/organizer/events/${event.id}/pilot-go-live-approvals`
      }
    ]
  };
}

async function buildFinalGoLivePackage(ctx, event, eventPolicy) {
  const [
    deploymentReadiness,
    securityReadiness,
    auditLogs,
    breakGlassRequests,
    users,
    pentestFindings,
    pilotSignoff,
    jointExecution,
    finalApprovals
  ] = await Promise.all([
    buildDeploymentReadiness(ctx),
    Promise.resolve(buildSecurityReadiness(ctx)),
    ctx.repos.auditLogs.listByTenant(event.tenant_id),
    ctx.repos.breakGlassAccess.listByTenant(event.tenant_id),
    ctx.repos.users.listByTenant(event.tenant_id),
    ctx.repos.pentestFindings.listByTenant(event.tenant_id),
    buildPilotSignoffPack(ctx.repos, event, eventPolicy),
    buildPilotGoLiveExecution(ctx.repos, event, eventPolicy),
    ctx.repos.finalLaunchApprovals.listByEvent(event.tenant_id, event.id)
  ]);

  const securityAlerts = buildSecurityAlerts({
    readiness: securityReadiness,
    auditLogs,
    breakGlassRequests,
    users,
    pentestFindings,
    notificationProviderReadiness: buildNotificationChannelsReadiness(ctx.env),
    notificationWorkerSchedule: resolveNotificationWorkerSchedule(ctx.env),
    notificationDeadLetterSummary: await buildNotificationDeadLetterSummary(ctx.repos, event.tenant_id, ctx.env)
  });
  const findingSummary = summarizePentestFindings(pentestFindings);
  const approvalItems = buildFinalLaunchApprovalItems(finalApprovals);
  const blockingSecurityAlerts = securityAlerts.items.filter((entry) =>
    ["critical", "high"].includes(entry.severity) &&
    ["security_readiness", "pentest", "break_glass"].includes(entry.source)
  );
  const securityControlFailures = securityReadiness.summary.fail ?? 0;
  const items = [];
  const blockers = [];
  const warnings = [];

  pushReadinessItem(items, blockers, {
    key: "deployment_readiness",
    label: "Production deployment readiness has zero blockers",
    passed: deploymentReadiness.ready,
    blockerMessage: "Clear deployment readiness blockers before final production launch"
  });
  pushReadinessItem(items, blockers, {
    key: "security_readiness",
    label: "Security readiness has no failed controls",
    passed: securityControlFailures === 0,
    blockerMessage: "Clear failed security readiness controls before final production launch"
  });
  pushReadinessItem(items, blockers, {
    key: "security_alerts",
    label: "No active high or critical security blockers remain",
    passed: blockingSecurityAlerts.length === 0,
    blockerMessage: "Resolve active high/critical security blockers before launch"
  });
  pushReadinessItem(items, blockers, {
    key: "pentest_findings",
    label: "No blocking high or critical penetration-test findings remain",
    passed: findingSummary.blocking === 0,
    blockerMessage: "Remediate or formally accept blocking penetration-test findings before launch"
  });
  pushReadinessItem(items, blockers, {
    key: "pilot_signoff",
    label: "Pilot signoff pack is ready",
    passed: pilotSignoff.ready,
    blockerMessage: "Complete the pilot signoff pack before final production launch"
  });
  pushReadinessItem(items, blockers, {
    key: "joint_go_live_execution",
    label: "Joint staging dry run and cross-team approvals are complete",
    passed: jointExecution.ready,
    blockerMessage: "Complete joint go-live execution approvals before production launch"
  });

  for (const approval of approvalItems) {
    pushReadinessItem(items, blockers, {
      key: `final_approval_${approval.approver_role}`,
      label: `${finalLaunchApprovalLabel(approval.approver_role)} approval is recorded`,
      passed: approval.approval_status === "approved",
      blockerMessage: `Record final ${finalLaunchApprovalLabel(approval.approver_role)} approval before launch`
    });
    if (approval.approval_status === "rejected") {
      warnings.push(`FINAL_APPROVAL_REJECTED_${approval.approver_role.toUpperCase()}`);
    }
  }

  if ((deploymentReadiness.summary.manual ?? 0) > 0) {
    warnings.push("DEPLOYMENT_MANUAL_GATES_REMAIN");
  }
  if ((securityReadiness.summary.manual ?? 0) > 0) {
    warnings.push("SECURITY_MANUAL_GATES_REMAIN");
  }

  return {
    ready: blockers.length === 0,
    generated_at: new Date().toISOString(),
    event: formatEventSummary(event),
    blockers,
    warnings,
    checklist: items,
    approvals: approvalItems,
    sections: {
      deployment_readiness: deploymentReadiness,
      security_readiness: securityReadiness,
      security_alerts: securityAlerts,
      pentest_findings: {
        summary: findingSummary,
        items: pentestFindings
      },
      pilot_signoff: pilotSignoff,
      joint_go_live_execution: jointExecution
    },
    runbook_links: {
      production_deployment: "/Users/kishore/Codex Development/deploy/production/README.md",
      final_launch_checklist: "/Users/kishore/Codex Development/deploy/production/FINAL_GO_LIVE_CHECKLIST.md",
      post_launch_monitoring: "/Users/kishore/Codex Development/deploy/production/POST_LAUNCH_MONITORING.md",
      pentest_support: "/Users/kishore/Codex Development/docs/spec-closure-pack/external-pentest-support.md"
    },
    post_launch_monitoring: [
      "Watch /ready, API error rate, and latency continuously for the first 24 hours.",
      "Review platform-admin security alerts every hour for the first 24 hours.",
      "Review IoT health, parity, and critical alert queues every hour during event opening.",
      "Confirm export, audit, break-glass, DSR, and downstream deletion flows remain operational.",
      "Run a 24-hour and 72-hour launch review before declaring production steady state."
    ],
    recommended_actions: [
      {
        label: "View deployment readiness",
        endpoint: "/admin/deployment/readiness"
      },
      {
        label: "View security alerts",
        endpoint: "/admin/security/alerts"
      },
      {
        label: "View penetration-test findings",
        endpoint: "/admin/security/pentest/findings"
      },
      {
        label: "Export final launch package",
        endpoint: `/admin/events/${event.id}/final-go-live/export`
      }
    ]
  };
}

function buildFinalLaunchApprovalItems(approvals) {
  const approvalMap = new Map(approvals.map((entry) => [entry.approver_role, entry]));
  return ["platform_admin", "organizer_owner", "security_owner", "business_owner"].map((role) => {
    const existing = approvalMap.get(role);
    return existing ?? {
      approver_role: role,
      approver_label: finalLaunchApprovalLabel(role),
      approval_status: "pending",
      note: null,
      approved_at: null,
      updated_at: null
    };
  });
}

function finalLaunchApprovalLabel(role) {
  const labels = {
    platform_admin: "Platform admin",
    organizer_owner: "Organizer owner",
    security_owner: "Security owner",
    business_owner: "Business owner"
  };
  return labels[role] ?? role;
}

function formatIntegrationRun(run) {
  if (!run) {
    return null;
  }
  return {
    id: run.id,
    integration_name: run.integration_name,
    trigger_mode: run.trigger_mode,
    initiated_by: run.initiated_by,
    status: run.status,
    step_count: run.step_count,
    failed_step_count: run.failed_step_count,
    warning_count: run.warning_count,
    started_at: run.started_at,
    finished_at: run.finished_at,
    error_summary: run.error_summary,
    summary: run.summary ?? {},
    steps: run.steps ?? []
  };
}

function formatHealthStatus(health) {
  if (!health) {
    return {
      status: "unknown",
      certification_status: "unknown",
      checked_at: null,
      stale_after_seconds: null,
      is_stale: false,
      warning_count: 0,
      warnings: [],
      metrics: {}
    };
  }

  const warningItems = [...(health.warnings ?? [])];
  const isStale =
    health.checked_at && health.stale_after_seconds
      ? Date.now() - Date.parse(health.checked_at) > health.stale_after_seconds * 1000
      : false;

  if (isStale) {
    warningItems.push({
      code: "HEALTH_CHECK_STALE",
      severity: "warning",
      message: "IoT health check is stale and should be rerun",
      details: {
        checked_at: health.checked_at,
        stale_after_seconds: health.stale_after_seconds
      }
    });
  }

  return {
    status: isStale ? escalateHealthStatus(health.overall_status, "warning") : health.overall_status,
    certification_status: health.certification_status,
    contract_version: health.contract_version,
    environment: health.environment,
    build_version: health.build_version,
    checked_at: health.checked_at,
    stale_after_seconds: health.stale_after_seconds,
    is_stale: isStale,
    warning_count: warningItems.length,
    warnings: warningItems,
    metrics: health.metrics ?? {}
  };
}

function escalateHealthStatus(currentStatus, nextStatus) {
  const ranking = {
    unknown: 0,
    healthy: 1,
    warning: 2,
    critical: 3,
    failed: 4
  };
  return ranking[nextStatus] > ranking[currentStatus] ? nextStatus : currentStatus;
}

function formatStreamCheckpoint(checkpoint) {
  if (!checkpoint) {
    return {
      status: "never_synced",
      last_cursor: null,
      last_synced_at: null,
      contract_version: null,
      environment: null,
      build_version: null,
      metadata: {}
    };
  }

  return {
    status: checkpoint.last_synced_at ? "synced" : "pending",
    last_cursor: checkpoint.last_cursor,
    last_synced_at: checkpoint.last_synced_at,
    contract_version: checkpoint.last_contract_version,
    environment: checkpoint.last_environment,
    build_version: checkpoint.last_build_version,
    consecutive_failure_count: checkpoint.metadata?.consecutive_failure_count ?? 0,
    last_failure_code: checkpoint.metadata?.last_failure_code ?? null,
    last_failure_retryable: checkpoint.metadata?.last_failure_retryable ?? null,
    metadata: checkpoint.metadata ?? {}
  };
}

function formatAlertEvent(alert) {
  if (!alert) {
    return null;
  }
  return {
    id: alert.id,
    source_type: alert.source_type,
    source_id: alert.source_id,
    severity: alert.severity,
    status: alert.status,
    code: alert.code,
    message: alert.message,
    details: alert.details ?? {},
    delivery_status: alert.delivery_status,
    routed_destinations: alert.routed_destinations ?? [],
    last_delivery_at: alert.last_delivery_at,
    delivery_error: alert.delivery_error,
    created_at: alert.created_at,
    updated_at: alert.updated_at
  };
}

function formatParityStatus(status) {
  if (!status) {
    return {
      status: "unknown",
      checked_at: null,
      staging: null,
      production: null,
      issues: []
    };
  }

  return {
    status: status.status,
    checked_at: status.checked_at,
    staging: {
      contract_version: status.staging_contract_version,
      environment: status.staging_environment,
      build_version: status.staging_build_version
    },
    production: {
      contract_version: status.production_contract_version,
      environment: status.production_environment,
      build_version: status.production_build_version
    },
    issues: status.issues ?? [],
    details: status.details ?? {}
  };
}

function pushReadinessItem(items, blockers, { key, label, passed, blockerMessage }) {
  items.push({
    key,
    label,
    passed
  });
  if (!passed) {
    blockers.push(blockerMessage);
  }
}

function capitalize(value) {
  if (!value) {
    return "";
  }
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}
