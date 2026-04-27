import { nextId } from "../store.mjs";
import { dispatchTransactionalEmail } from "../notification-dispatch.mjs";
import { uploadFile } from "../storage/storage-adapter.mjs";

export function startDSRWorker(repos, state, intervalMs = 5 * 60 * 1000) {
  const handle = setInterval(() => {
    pollAndProcessDSRs(repos, state).catch((err) => {
      console.error("[dsr-worker] Poll error:", err);
    });
  }, intervalMs);
  return handle;
}

async function pollAndProcessDSRs(repos, state) {
  for (const tenant of state.tenants) {
    let events;
    try {
      events = await repos.events.listByTenant(tenant.id);
    } catch {
      continue;
    }
    for (const event of events) {
      let dsrs;
      try {
        dsrs = await repos.dataSubjectRequests.listByEvent(tenant.id, event.id);
      } catch {
        continue;
      }
      const pending = dsrs.filter((d) => d.status === "requested");
      for (const dsr of pending) {
        processDSRJob(repos, state, dsr.id).catch((err) => {
          console.error(`[dsr-worker] Failed to process DSR ${dsr.id}:`, err);
        });
      }
    }
  }
}

export async function processDSRJob(repos, state, dsrId) {
  let dsr;
  for (const tenant of state.tenants) {
    if (dsr) break;
    const events = await repos.events.listByTenant(tenant.id);
    for (const event of events) {
      if (dsr) break;
      const dsrs = await repos.dataSubjectRequests.listByEvent(tenant.id, event.id);
      dsr = dsrs.find((d) => d.id === dsrId);
    }
  }

  if (!dsr) {
    console.error(`[dsr-worker] DSR ${dsrId} not found`);
    return;
  }

  const tenantId = dsr.tenant_id;

  await repos.dataSubjectRequests.update({ ...dsr, status: "processing" });

  await repos.privacyAuditLogs.create({
    id: nextId("pal"),
    tenant_id: tenantId,
    event_id: dsr.event_id,
    actor_user_id: null,
    actor_role: "system",
    action: "dsr.processing",
    target_type: "data_subject_request",
    target_id: dsrId,
    metadata: { request_type: dsr.request_type },
    occurred_at: new Date().toISOString()
  });

  try {
    const completedAt = new Date().toISOString();

    if (dsr.request_type === "export") {
      const interactions = await repos.interactions.listByEvent(tenantId, dsr.event_id);
      const attendeeInteractions = interactions.filter((i) => i.attendee_id === dsr.attendee_id);
      const profile = await repos.attendeeProfiles.findByAttendeeId(dsr.attendee_id);
      const consents = await Promise.all(
        attendeeInteractions.map((i) => repos.consents.findByInteractionId(tenantId, i.id).catch(() => null))
      );

      const exportData = {
        dsr_id: dsrId,
        attendee_id: dsr.attendee_id,
        event_id: dsr.event_id,
        generated_at: completedAt,
        profile: profile
          ? {
              full_name: profile.full_name,
              company_name: profile.company_name,
              email: profile.email,
              phone: profile.phone
            }
          : null,
        interactions: attendeeInteractions.map((i) => ({
          id: i.id,
          stall_id: i.stall_id,
          status: i.status,
          consent_status: i.consent_status,
          created_at: i.created_at
        })),
        consents: consents.filter(Boolean).map((c) => ({
          interaction_id: c.interaction_id,
          vendor_release_allowed: c.vendor_release_allowed,
          sponsor_release_allowed: c.sponsor_release_allowed
        }))
      };

      const { url: fileUrl, expires_at: fileExpiresAt } = await uploadFile(
        `dsr/${dsr.attendee_id}/dsr-export-${dsrId}.json`,
        Buffer.from(JSON.stringify(exportData)),
        "application/json",
        { expiresIn: 86400 }
      );

      await repos.dataSubjectRequests.update({
        ...dsr,
        status: "completed",
        export_file_url: fileUrl,
        export_expires_at: fileExpiresAt.toISOString(),
        download_used: false,
        completed_at: completedAt
      });

      await repos.privacyAuditLogs.create({
        id: nextId("pal"),
        tenant_id: tenantId,
        event_id: dsr.event_id,
        actor_user_id: null,
        actor_role: "system",
        action: "dsr.completed",
        target_type: "data_subject_request",
        target_id: dsrId,
        metadata: { request_type: "export", outcome: "success" },
        occurred_at: completedAt
      });

      if (profile?.email) {
        await dispatchTransactionalEmail({
          repos,
          tenantId,
          recipientEmail: profile.email,
          messageType: "dsr_export_ready",
          templateVars: {
            attendee_name: profile.full_name ?? "there",
            export_id: dsrId,
            download_url: "",
            expires_in_hours: 24
          }
        });
      }

      await dispatchDSRWebhook(repos, tenantId, dsr.event_id, "dsr.completed", {
        event_id: dsr.event_id,
        request_type: "export",
        completed_at: completedAt
      });
    } else if (dsr.request_type === "delete") {
      const profile = await repos.attendeeProfiles.findByAttendeeId(dsr.attendee_id);
      const attendeeEmail = profile?.email ?? null;
      const attendeeName = profile?.full_name ?? "there";

      if (profile) {
        await repos.attendeeProfiles.upsert({
          ...profile,
          full_name: "[deleted]",
          company_name: null,
          email: null,
          phone: null,
          updated_at: completedAt
        });
      }

      const interactions = await repos.interactions.listByEvent(tenantId, dsr.event_id);
      for (const interaction of interactions.filter((i) => i.attendee_id === dsr.attendee_id)) {
        await repos.interactions.update({
          ...interaction,
          attendee_id: null,
          status: "anonymized",
          consent_status: "declined",
          updated_at: completedAt
        });
      }

      console.log(`TODO: dispatch CRM deletion push for attendee ${dsr.attendee_id} — requires CRM integration`);

      await repos.dataSubjectRequests.update({
        ...dsr,
        status: "completed",
        completed_at: completedAt
      });

      await repos.privacyAuditLogs.create({
        id: nextId("pal"),
        tenant_id: tenantId,
        event_id: dsr.event_id,
        actor_user_id: null,
        actor_role: "system",
        action: "dsr.completed",
        target_type: "data_subject_request",
        target_id: dsrId,
        metadata: { request_type: "delete", outcome: "success" },
        occurred_at: completedAt
      });

      let eventRecord;
      try {
        eventRecord = await repos.events.findById(tenantId, dsr.event_id);
      } catch {}

      if (attendeeEmail) {
        await dispatchTransactionalEmail({
          repos,
          tenantId,
          recipientEmail: attendeeEmail,
          messageType: "dsr_delete_confirmed",
          templateVars: {
            attendee_name: attendeeName,
            event_name: eventRecord?.name ?? "your event",
            completed_at: completedAt
          }
        });
      }

      await dispatchDSRWebhook(repos, tenantId, dsr.event_id, "dsr.completed", {
        event_id: dsr.event_id,
        request_type: "delete",
        completed_at: completedAt
      });
    }
  } catch (err) {
    console.error(`[dsr-worker] Failed to process DSR ${dsrId}:`, err);
    const failedAt = new Date().toISOString();
    await repos.dataSubjectRequests.update({ ...dsr, status: "failed", completed_at: failedAt }).catch(() => {});
    await repos.privacyAuditLogs
      .create({
        id: nextId("pal"),
        tenant_id: tenantId,
        event_id: dsr.event_id,
        actor_user_id: null,
        actor_role: "system",
        action: "dsr.completed",
        target_type: "data_subject_request",
        target_id: dsrId,
        metadata: { request_type: dsr.request_type, outcome: "failed", error: err.message },
        occurred_at: failedAt
      })
      .catch(() => {});
    throw err;
  }
}

async function dispatchDSRWebhook(repos, tenantId, eventId, eventType, data) {
  const subscriptions = repos.webhookSubscriptions?.listByEvent
    ? (await repos.webhookSubscriptions.listByEvent(tenantId, eventId)).filter(
        (s) => s.status === "active" && Array.isArray(s.event_types) && s.event_types.includes(eventType)
      )
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
