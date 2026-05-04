const ROLE_ROUTE = {
  platform_admin: "/admin/tenants",
  organizer_admin: "/organizer/events",
  vendor_manager: "/vendor",
  sponsor_user: "/sponsor",
  ops_user: "/ops/fleet"
};

export async function resolveRedirectTarget(userId, tenantId, repos) {
  const assignments = await repos.userRoleAssignments.listByUser(tenantId, userId);

  if (assignments.length === 0) {
    return { redirect_to: "/onboarding/no-role" };
  }

  if (assignments.length === 1) {
    return { redirect_to: ROLE_ROUTE[assignments[0].role] ?? "/dashboard" };
  }

  const eventAssignments = assignments.filter((a) => a.event_id);
  const uniqueEvents = [...new Set(eventAssignments.map((a) => a.event_id))];

  if (uniqueEvents.length > 1) {
    const eventRecords = await Promise.all(
      uniqueEvents.map((id) => repos.events.findById(tenantId, id).catch(() => null))
    );
    return {
      requires_context_selection: true,
      events: eventAssignments.map((a) => {
        const record = eventRecords.find((e) => e?.id === a.event_id);
        return {
          id: a.event_id,
          name: record?.name ?? null,
          status: record?.status ?? "live",
          starts_at: record?.starts_at ?? null,
          ends_at: record?.ends_at ?? null,
          role: a.role
        };
      })
    };
  }

  return { redirect_to: ROLE_ROUTE[assignments[0].role] ?? "/dashboard" };
}
