import { HttpError } from "./http-error.mjs";

export function enforceRoleScope(ctx) {
  const { route, principal, resources, state, breakGlass } = ctx;
  if (!route.allowedRoles?.length) {
    return;
  }

  if (!principal) {
    throw new HttpError(401, "Authentication required");
  }

  if (!route.allowedRoles.includes(principal.role)) {
    throw new HttpError(403, "Role not permitted");
  }

  if (resources.event && principal.event_ids?.length && !principal.event_ids.includes(resources.event.id)) {
    throw new HttpError(403, "Event scope violation");
  }

  if (resources.stall && principal.stall_ids?.length && !principal.stall_ids.includes(resources.stall.id)) {
    throw new HttpError(403, "Stall scope violation");
  }

  if (route.id === "device-config" || route.id === "device-heartbeat" || route.id === "device-sync" || route.id === "interaction-tap") {
    if (principal.role !== "device_principal" || principal.device_id !== resources.device.id) {
      throw new HttpError(403, "Device principal mismatch");
    }
    if (resources.assignment) {
      if (resources.assignment.event_id !== resources.event.id || resources.assignment.stall_id !== resources.stall.id) {
        throw new HttpError(403, "Device assignment scope violation");
      }
    }
  }

  if (route.id.startsWith("device-credentials")) {
    if (principal.role === "organizer_admin" && !resources.event) {
      throw new HttpError(403, "Organizer device credential management requires an event-scoped assignment");
    }
  }

  if (route.id === "stall-leads") {
    const stall = resources.stall;
    if (principal.role === "vendor_manager" && stall.vendor_organization_id !== principal.organization_id) {
      throw new HttpError(403, "Vendor scope violation");
    }
    if (principal.role === "platform_admin" && breakGlass) {
      assertBreakGlassScope(ctx, "stall_leads_unmask");
    }
  }

  if (["sponsor-metrics", "sponsor-report-snapshots", "sponsor-exports-list"].includes(route.id)) {
    const sponsorOrgId = resources.sponsorOrganization.id;
    if (principal.role === "sponsor_user" && principal.organization_id !== sponsorOrgId) {
      throw new HttpError(403, "Sponsor scope violation");
    }
  }

  if (route.id === "organizer-overview") {
    if (principal.role !== "organizer_admin") {
      throw new HttpError(403, "Organizer access required");
    }
  }

  if (route.id === "exports-approve" || route.id === "exports-reject") {
    if (principal.role !== "organizer_admin") {
      throw new HttpError(403, "Organizer approval required");
    }
  }

  if (route.id === "audit-logs" && !["organizer_admin", "platform_admin"].includes(principal.role)) {
    throw new HttpError(403, "Audit access denied");
  }

  if (route.id.startsWith("break-glass") && principal.role !== "platform_admin") {
    throw new HttpError(403, "Platform admin required");
  }

  if (route.id === "exports-request" && principal.role === "vendor_manager") {
    const organization = state.organizations.find((entry) => entry.id === principal.organization_id);
    if (!organization || organization.type !== "vendor") {
      throw new HttpError(403, "Vendor export scope violation");
    }
  }
}

export function enforcePolicy(ctx) {
  const { route, body, resources, principal, state } = ctx;
  const policy = resources.eventPolicy;

  if (route.id === "exports-request") {
    if (!policy) {
      throw new HttpError(400, "Event policy missing");
    }

    if (body.export_type === "vendor_leads") {
      if (!policy.vendor_exports_enabled) {
        throw new HttpError(403, "Vendor exports disabled by event policy");
      }
      if (principal.role !== "vendor_manager" && principal.role !== "organizer_admin") {
        throw new HttpError(403, "Vendor lead export unavailable");
      }
    }

    if (body.export_type === "sponsor_leads") {
      if (!policy.sponsor_pii_enabled) {
        throw new HttpError(403, "Sponsor PII disabled by event policy");
      }
      if (!["sponsor_user", "organizer_admin"].includes(principal.role)) {
        throw new HttpError(403, "Sponsor lead export unavailable");
      }
    }

    if (body.export_type === "sponsor_dashboard_snapshot" && !["sponsor_user", "organizer_admin"].includes(principal.role)) {
      throw new HttpError(403, "Sponsor dashboard export unavailable");
    }
    if (body.export_type === "sponsor_dashboard_snapshot") {
      if (!body.filters?.snapshot_id || !body.filters?.sponsor_id) {
        throw new HttpError(400, "Sponsor dashboard snapshot exports require snapshot_id and sponsor_id");
      }
    }

    if (body.export_type === "organizer_event_report" && principal.role !== "organizer_admin") {
      throw new HttpError(403, "Organizer report export requires organizer scope");
    }
  }

  if (route.id === "exports-status" || route.id === "exports-download" || route.id === "exports-short-link-create") {
    const exportRequest = resources.exportRequest;
    if (principal.event_ids?.length && !principal.event_ids.includes(exportRequest.event_id)) {
      throw new HttpError(403, "Export event scope violation");
    }
    if (principal.role === "vendor_manager" && exportRequest.requested_by_user_id !== principal.user_id) {
      throw new HttpError(403, "Export status scope violation");
    }
    if (principal.role === "sponsor_user" && exportRequest.requested_for_organization_id !== principal.organization_id) {
      throw new HttpError(403, "Sponsor export scope violation");
    }
  }

  if (route.id === "break-glass-approve") {
    const request = resources.breakGlassRequest;
    if (request.requested_by_user_id === principal.user_id) {
      throw new HttpError(409, "Requester cannot self-approve break-glass");
    }
    if (
      request.first_approved_by_user_id &&
      request.first_approved_by_user_id === principal.user_id
    ) {
      throw new HttpError(409, "Second approval must be from a different approver");
    }
  }

  if (route.id === "break-glass-revoke") {
    const request = resources.breakGlassRequest;
    if (request.requested_by_user_id === principal.user_id) {
      throw new HttpError(409, "Requester cannot self-revoke in approval role");
    }
  }

  if (route.id === "consent-capture") {
    if (body.sponsor_release_allowed && body.vendor_release_allowed === false) {
      throw new HttpError(400, "Sponsor release cannot be true when vendor release is false in pilot mode");
    }
  }

  if (route.id === "interaction-crm-sync") {
    if (!policy?.allow_crm_push) {
      throw new HttpError(403, "CRM push is disabled by event policy");
    }
    const eligibility = deriveCrmEligibility(resources.interaction, policy);
    if (eligibility !== "eligible") {
      throw new HttpError(409, `CRM push blocked: ${eligibility}`);
    }
    if (resources.interaction.status === "anonymized") {
      throw new HttpError(409, "CRM push is unavailable for anonymized interactions");
    }
  }

  if (route.id === "stall-leads" && principal.role === "sponsor_user") {
    throw new HttpError(403, "Sponsors do not have stall lead access in pilot mode");
  }
}

export function deriveCrmEligibility(interaction, policy) {
  if (!policy?.allow_crm_push) {
    return "blocked_by_policy";
  }
  if (interaction.consent_status === "vendor_only" || interaction.consent_status === "vendor_and_sponsor") {
    return "eligible";
  }
  return "blocked_by_consent";
}

function assertBreakGlassScope(ctx, requiredPermission) {
  const breakGlass = ctx.breakGlass;
  if (!breakGlass) {
    throw new HttpError(403, "Active break-glass session required");
  }

  const scope = parseBreakGlassScope(breakGlass.access_scope);
  if (!scope.permissions.includes(requiredPermission)) {
    throw new HttpError(403, "Break-glass scope does not permit this action");
  }
  if (scope.event_ids.length && !scope.event_ids.includes(ctx.resources.event?.id)) {
    throw new HttpError(403, "Break-glass event scope violation");
  }
  if (scope.stall_ids.length && !scope.stall_ids.includes(ctx.resources.stall?.id)) {
    throw new HttpError(403, "Break-glass stall scope violation");
  }
}

function parseBreakGlassScope(accessScope) {
  if (!accessScope) {
    return { permissions: [], event_ids: [], stall_ids: [] };
  }
  if (typeof accessScope === "object") {
    return {
      permissions: accessScope.permissions ?? [],
      event_ids: accessScope.event_ids ?? [],
      stall_ids: accessScope.stall_ids ?? []
    };
  }
  try {
    const parsed = JSON.parse(accessScope);
    return {
      permissions: parsed.permissions ?? [],
      event_ids: parsed.event_ids ?? [],
      stall_ids: parsed.stall_ids ?? []
    };
  } catch {
    return {
      permissions: [String(accessScope)],
      event_ids: [],
      stall_ids: []
    };
  }
}
