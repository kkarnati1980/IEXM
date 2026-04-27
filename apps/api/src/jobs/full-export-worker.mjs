import { nextId } from "../store.mjs";
import { dispatchTransactionalEmail } from "../notification-dispatch.mjs";

export function startFullExportWorker(repos, state, intervalMs = 30_000) {
  const handle = setInterval(() => {
    pollAndProcessFullExports(repos, state).catch((err) => {
      console.error("[full-export-worker] Poll error:", err);
    });
  }, intervalMs);
  return handle;
}

async function pollAndProcessFullExports(repos, state) {
  for (const tenant of state.tenants) {
    let events;
    try {
      events = await repos.events.listByTenant(tenant.id);
    } catch (err) {
      console.error(`[full-export-worker] Failed to list events for tenant ${tenant.id}:`, err);
      continue;
    }
    for (const event of events) {
      let exports;
      try {
        exports = await repos.exportRequests.listByEvent(tenant.id, event.id);
      } catch {
        continue;
      }
      const pending = exports.filter(
        (e) => e.export_type?.startsWith("full_event_export") && e.status === "requested"
      );
      for (const exp of pending) {
        processFullExportJob(repos, state, exp.id).catch((err) => {
          console.error(`[full-export-worker] Failed to process export ${exp.id}:`, err);
        });
      }
    }
  }
}

export async function processFullExportJob(repos, state, exportId) {
  let exportRequest;
  for (const tenant of state.tenants) {
    if (exportRequest) break;
    const events = await repos.events.listByTenant(tenant.id);
    for (const event of events) {
      if (exportRequest) break;
      const exports = await repos.exportRequests.listByEvent(tenant.id, event.id);
      exportRequest = exports.find((e) => e.id === exportId);
    }
  }

  if (!exportRequest) {
    console.error(`[full-export-worker] Export request ${exportId} not found`);
    return;
  }

  const tenantId = exportRequest.tenant_id;
  const eventId = exportRequest.event_id;

  await repos.exportRequests.update({ ...exportRequest, status: "processing" });

  try {
    const event = await repos.events.findById(tenantId, eventId);
    const include = exportRequest.filters?.include ?? ["interactions", "consents", "event_config"];
    const format = exportRequest.filters?.format ?? "json";

    const exportData = {
      export_id: exportId,
      event_id: eventId,
      generated_at: new Date().toISOString(),
      sections: {}
    };

    const interactions = await repos.interactions.listByEvent(tenantId, eventId);

    if (include.includes("interactions")) {
      exportData.sections.interactions = interactions.map((i) => ({
        id: i.id,
        stall_id: i.stall_id,
        status: i.status,
        consent_status: i.consent_status,
        created_at: i.created_at
      }));
    }

    if (include.includes("consents")) {
      const consents = await Promise.all(
        interactions.map((i) => repos.consents.findByInteractionId(tenantId, i.id).catch(() => null))
      );
      exportData.sections.consents = consents.filter(Boolean).map((c) => ({
        interaction_id: c.interaction_id,
        vendor_release_allowed: c.vendor_release_allowed,
        sponsor_release_allowed: c.sponsor_release_allowed,
        revoked_at: c.revoked_at ?? null
      }));
    }

    if (include.includes("event_config")) {
      const [halls, stalls, policy] = await Promise.all([
        repos.halls.listByEvent(tenantId, eventId),
        repos.stalls.listByEvent(tenantId, eventId),
        repos.eventPolicies.findByEventId(tenantId, eventId).catch(() => null)
      ]);
      exportData.sections.event_config = {
        event: {
          id: event.id,
          name: event.name,
          status: event.status,
          starts_at: event.starts_at,
          ends_at: event.ends_at
        },
        halls: halls.map((h) => ({ id: h.id, name: h.name })),
        stalls: stalls.map((s) => ({ id: s.id, code: s.code, name: s.name })),
        data_policy: policy
          ? { retention_days: policy.retention_days, vendor_exports_enabled: policy.vendor_exports_enabled }
          : null
      };
    }

    if (include.includes("platform_access_log") || include.includes("audit_trail")) {
      const auditLogs = await repos.auditLogs.listByTenant(tenantId);
      const eventLogs = auditLogs.filter((l) => l.target_id === eventId);
      if (include.includes("platform_access_log")) {
        exportData.sections.platform_access_log = eventLogs
          .filter((l) => l.actor_role_category === "internal_platform")
          .map((l) => ({ id: l.id, event_type: l.event_type, actor_role: l.actor_role_category, created_at: l.created_at }));
      }
      if (include.includes("audit_trail")) {
        exportData.sections.audit_trail = eventLogs.map((l) => ({
          id: l.id,
          event_type: l.event_type,
          actor_type: l.actor_type,
          created_at: l.created_at
        }));
      }
    }

    if (include.includes("attendee_data")) {
      const attendeeIds = [...new Set(interactions.map((i) => i.attendee_id).filter(Boolean))];
      const profiles = await Promise.all(
        attendeeIds.map((id) => repos.attendeeProfiles.findByAttendeeId(id).catch(() => null))
      );
      exportData.sections.attendee_data = attendeeIds.map((id, idx) => {
        const profile = profiles[idx];
        const attendeeInteractions = interactions.filter((i) => i.attendee_id === id);
        const hasConsent = attendeeInteractions.some((i) => i.consent_status && i.consent_status !== "declined");
        return {
          attendee_id: id,
          full_name: hasConsent ? (profile?.full_name ?? null) : "[anonymised]",
          email: hasConsent ? (profile?.email ?? null) : "[anonymised]",
          phone: hasConsent ? (profile?.phone ?? null) : "[anonymised]",
          company_name: hasConsent ? (profile?.company_name ?? null) : "[anonymised]"
        };
      });
    }

    const json = JSON.stringify(exportData);
    const b64 = Buffer.from(json).toString("base64");
    const dataUri = `data:application/json;base64,${b64}`;
    const completedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await repos.exportRequests.update({
      ...exportRequest,
      status: "completed",
      export_file_url: dataUri,
      export_expires_at: expiresAt,
      download_used: false
    });

    await repos.privacyAuditLogs.create({
      id: nextId("pal"),
      tenant_id: tenantId,
      event_id: eventId,
      actor_user_id: exportRequest.requested_by_user_id ?? null,
      actor_role: "organizer_admin",
      action: "full_export.completed",
      target_type: "export_request",
      target_id: exportId,
      metadata: { format, sections: Object.keys(exportData.sections) },
      occurred_at: completedAt
    });

    if (exportRequest.requested_by_user_id) {
      let requester;
      try {
        requester = await repos.users.findById(tenantId, exportRequest.requested_by_user_id);
      } catch {}
      if (requester?.email) {
        await dispatchTransactionalEmail({
          repos,
          tenantId,
          recipientEmail: requester.email,
          messageType: "full_export_ready",
          templateVars: {
            organizer_name: requester.display_name ?? "there",
            event_name: event.name,
            export_id: exportId,
            download_url: "",
            expires_in_hours: 24,
            platform_name: "Codex"
          }
        });
      }
    }
  } catch (err) {
    console.error(`[full-export-worker] Failed to process export ${exportId}:`, err);
    await repos.exportRequests.update({ ...exportRequest, status: "failed" }).catch(() => {});
    throw err;
  }
}
