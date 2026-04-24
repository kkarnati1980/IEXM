import { writeAuditEvent, AUDIT_EVENT_TYPES } from "../audit.mjs";

export function startBreakGlassExpiryJob(repos, tenantIds, intervalMs = 60_000) {
  const handle = setInterval(() => {
    runOnce(repos, tenantIds).catch((err) => {
      console.error("[break-glass-expiry] Job error:", err);
    });
  }, intervalMs);
  return handle;
}

export async function runOnce(repos, tenantIds) {
  const now = new Date().toISOString();
  const expired = [];

  for (const tenantId of tenantIds) {
    let sessions;
    try {
      sessions = await repos.breakGlassAccess.listApprovedExpired(tenantId, now);
    } catch (err) {
      console.error(`[break-glass-expiry] Failed to list expired sessions for tenant ${tenantId}:`, err);
      continue;
    }

    for (const session of sessions) {
      try {
        await repos.breakGlassAccess.update({ ...session, status: "expired" });
        await writeAuditEvent(repos, {
          tenantId: session.tenant_id,
          actorType: "system",
          actorId: "system",
          eventType: AUDIT_EVENT_TYPES.BREAK_GLASS_EXPIRED,
          targetType: "break_glass_access",
          targetId: session.id,
          metadata: { expired_at: now }
        });
        // TODO: publish session invalidation event via realtime channel so client UI re-masks (Phase 15)
        expired.push(session.id);
      } catch (err) {
        console.error(`[break-glass-expiry] Failed to expire session ${session.id}:`, err);
      }
    }
  }

  return expired;
}
