export function buildUserPrincipal(user, scopes = []) {
  const eventIds = new Set();
  const stallIds = new Set();
  const sponsorOrganizationIds = new Set();

  for (const scope of scopes) {
    if (scope.event_id) {
      eventIds.add(scope.event_id);
    }
    if (scope.stall_id) {
      stallIds.add(scope.stall_id);
    }
    if (scope.sponsor_organization_id) {
      sponsorOrganizationIds.add(scope.sponsor_organization_id);
    }
  }

  return {
    type: "user",
    actor_id: user.id,
    tenant_id: user.tenant_id,
    role: user.role,
    user_id: user.id,
    organization_id: user.organization_id,
    user_status: user.status ?? "active",
    last_login_at: user.last_login_at ?? null,
    mfa_required: user.mfa_required ?? false,
    event_ids: [...eventIds],
    stall_ids: [...stallIds],
    sponsor_organization_ids: [...sponsorOrganizationIds]
  };
}

export function buildDevicePrincipal(device, assignment = null, credential = null) {
  return {
    type: "device",
    actor_id: device.id,
    tenant_id: device.tenant_id,
    role: "device_principal",
    device_id: device.id,
    credential_id: credential?.id ?? null,
    event_ids: assignment?.event_id ? [assignment.event_id] : [],
    stall_ids: assignment?.stall_id ? [assignment.stall_id] : []
  };
}
