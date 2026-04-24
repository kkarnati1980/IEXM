import { nextId } from "./store.mjs";

export const AUDIT_EVENT_TYPES = Object.freeze({
  // User lifecycle
  USER_INVITED: "user.invited",
  USER_ACTIVATED: "user.activated",
  USER_DISABLED: "user.disabled",
  USER_RE_ENABLED: "user.re_enabled",
  USER_ROLE_ASSIGNED: "user.role_assigned",
  USER_ROLE_REMOVED: "user.role_removed",
  USER_PASSWORD_RESET_REQUESTED: "user.password_reset_requested",
  USER_PASSWORD_RESET_COMPLETED: "user.password_reset_completed",
  USER_PASSWORD_CHANGED: "user.password_changed",

  // Organisation
  ORG_CREATED: "org.created",
  ORG_UPDATED: "org.updated",

  // Event lifecycle
  EVENT_CREATED: "event.created",
  EVENT_PUBLISHED: "event.published",
  EVENT_WENT_LIVE: "event.went_live",
  EVENT_CLOSED: "event.closed",
  EVENT_ARCHIVED: "event.archived",
  EVENT_DATA_POLICY_CHANGED: "event.data_policy_changed",

  // Device
  DEVICE_REGISTERED: "device.registered",
  DEVICE_ASSIGNED: "device.assigned",
  DEVICE_UNASSIGNED: "device.unassigned",
  DEVICE_RETIRED: "device.retired",

  // Branding
  BRANDING_APPROVED: "branding.approved",
  BRANDING_PUBLISHED: "branding.published",

  // Break-glass
  BREAK_GLASS_REQUESTED: "break_glass.requested",
  BREAK_GLASS_APPROVED: "break_glass.approved",
  BREAK_GLASS_REJECTED: "break_glass.rejected",
  BREAK_GLASS_EXPIRED: "break_glass.expired",
  BREAK_GLASS_REVOKED: "break_glass.revoked",

  // API clients
  API_CLIENT_CREATED: "api_client.created",
  API_CLIENT_SECRET_ROTATED: "api_client.secret_rotated",
  API_CLIENT_REVOKED: "api_client.revoked"
});

export async function writeAuditEvent(repos, {
  tenantId,
  actorType = "system",
  actorId = "system",
  eventType,
  targetType = null,
  targetId = null,
  metadata = {},
  breakGlassAccessId = null
}) {
  return repos.auditLogs.create({
    id: nextId("audit"),
    tenant_id: tenantId,
    actor_type: actorType,
    actor_id: actorId,
    event_type: eventType,
    target_type: targetType,
    target_id: targetId,
    break_glass_access_id: breakGlassAccessId,
    metadata,
    created_at: new Date().toISOString()
  });
}
