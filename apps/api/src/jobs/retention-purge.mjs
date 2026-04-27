import { nextId } from "../store.mjs";
import { dispatchTransactionalEmail } from "../notification-dispatch.mjs";

export function startRetentionPurgeJob(repos, state, intervalMs = 24 * 60 * 60 * 1000) {
  const handle = setInterval(() => {
    runRetentionPurgeOnce(repos, state).catch((err) => {
      console.error("[retention-purge] Job error:", err);
    });
  }, intervalMs);
  return handle;
}

export function startRetentionExpiryCountdownJob(repos, state, intervalMs = 24 * 60 * 60 * 1000) {
  const handle = setInterval(() => {
    runRetentionExpiryCountdownOnce(repos, state).catch((err) => {
      console.error("[retention-expiry-countdown] Job error:", err);
    });
  }, intervalMs);
  return handle;
}

export async function runRetentionPurgeOnce(repos, state) {
  const now = new Date();
  const results = [];

  for (const tenant of state.tenants) {
    let events;
    try {
      events = await repos.events.listByTenant(tenant.id);
    } catch (err) {
      console.error(`[retention-purge] Failed to list events for tenant ${tenant.id}:`, err);
      continue;
    }

    for (const event of events) {
      if (["purged", "purge_failed", "purging"].includes(event.retention_status)) continue;
      if (!event.ends_at) continue;

      let policy;
      try {
        policy = await repos.eventPolicies.findByEventId(tenant.id, event.id);
      } catch {
        policy = { retention_days: 30 };
      }

      const retentionExpiry = new Date(Date.parse(event.ends_at) + policy.retention_days * 86400000);
      if (retentionExpiry > now) continue;

      try {
        await repos.events.update({ ...event, retention_status: "purging" });
      } catch (err) {
        console.error(`[retention-purge] Failed to set purging for event ${event.id}:`, err);
        continue;
      }

      try {
        const interactions = await repos.interactions.listByEvent(tenant.id, event.id);
        const attendeeIds = [...new Set(interactions.map((i) => i.attendee_id).filter(Boolean))];
        const purgedAt = new Date().toISOString();
        let recordsAnonymised = 0;

        for (const interaction of interactions) {
          if (interaction.status !== "anonymized") {
            await repos.interactions.update({
              ...interaction,
              attendee_id: null,
              status: "anonymized",
              consent_status: "declined",
              updated_at: purgedAt
            });
            recordsAnonymised++;
          }
        }

        for (const attendeeId of attendeeIds) {
          const profile = await repos.attendeeProfiles.findByAttendeeId(attendeeId);
          if (profile) {
            await repos.attendeeProfiles.upsert({
              ...profile,
              full_name: null,
              company_name: null,
              email: null,
              phone: null,
              updated_at: purgedAt
            });
          }
        }

        await repos.events.update({
          ...event,
          retention_status: "purged",
          purged_at: purgedAt,
          last_purge_run_at: purgedAt
        });

        await repos.privacyAuditLogs.create({
          id: nextId("pal"),
          tenant_id: tenant.id,
          event_id: event.id,
          actor_user_id: null,
          actor_role: "system",
          action: "retention.purge_executed",
          target_type: "event",
          target_id: event.id,
          metadata: { records_anonymised: recordsAnonymised, event_id: event.id },
          occurred_at: purgedAt
        });

        const allUsers = await repos.users.listByTenant(tenant.id);
        const organizerAdmins = allUsers.filter(
          (u) => u.role === "organizer_admin" && u.status === "active" && u.email
        );
        for (const admin of organizerAdmins) {
          await dispatchTransactionalEmail({
            repos,
            tenantId: tenant.id,
            recipientEmail: admin.email,
            messageType: "retention_purge_completed",
            templateVars: {
              organizer_name: admin.display_name ?? "there",
              event_name: event.name,
              records_anonymised: recordsAnonymised,
              purged_at: purgedAt,
              retention_days: policy.retention_days,
              platform_name: "Codex"
            }
          });
        }

        await dispatchRetentionWebhook(repos, tenant.id, event.id, "retention.purge_completed", {
          event_id: event.id,
          records_anonymised: recordsAnonymised,
          purged_at: purgedAt
        });

        results.push({ event_id: event.id, status: "purged", records_anonymised: recordsAnonymised });
      } catch (err) {
        console.error(`[retention-purge] Failed to purge event ${event.id}:`, err);
        try {
          await repos.events.update({ ...event, retention_status: "purge_failed" });
        } catch {}
        results.push({ event_id: event.id, status: "purge_failed", error: err.message });
      }
    }
  }

  return results;
}

export async function runRetentionExpiryCountdownOnce(repos, state) {
  const now = new Date();
  const fourteenDaysMs = 14 * 86400000;

  for (const tenant of state.tenants) {
    let events;
    try {
      events = await repos.events.listByTenant(tenant.id);
    } catch (err) {
      console.error(`[retention-expiry-countdown] Failed to list events for tenant ${tenant.id}:`, err);
      continue;
    }

    for (const event of events) {
      const currentStatus = event.retention_status ?? "active";
      if (!["active", "expiring_soon"].includes(currentStatus)) continue;
      if (!event.ends_at) continue;

      let policy;
      try {
        policy = await repos.eventPolicies.findByEventId(tenant.id, event.id);
      } catch {
        policy = { retention_days: 30 };
      }

      const retentionExpiry = new Date(Date.parse(event.ends_at) + policy.retention_days * 86400000);
      const msUntilExpiry = retentionExpiry - now;

      if (msUntilExpiry <= 0) {
        await repos.events.update({ ...event, retention_status: "expired_pending_purge" });
      } else if (msUntilExpiry <= fourteenDaysMs && currentStatus === "active") {
        await repos.events.update({ ...event, retention_status: "expiring_soon" });

        const daysRemaining = Math.ceil(msUntilExpiry / 86400000);
        const allUsers = await repos.users.listByTenant(tenant.id);
        const organizerAdmins = allUsers.filter(
          (u) => u.role === "organizer_admin" && u.status === "active" && u.email
        );
        for (const admin of organizerAdmins) {
          await dispatchTransactionalEmail({
            repos,
            tenantId: tenant.id,
            recipientEmail: admin.email,
            messageType: "retention_expiry_warning",
            templateVars: {
              organizer_name: admin.display_name ?? "there",
              event_name: event.name,
              retention_expiry_date: retentionExpiry.toISOString(),
              days_remaining: daysRemaining,
              data_policy_url: "",
              platform_name: "Codex"
            }
          });
        }
      }
    }
  }
}

async function dispatchRetentionWebhook(repos, tenantId, eventId, eventType, data) {
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
