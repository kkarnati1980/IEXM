export function maskResponse(response, ctx) {
  if (!ctx.route.maskResponse || !response || typeof response !== "object") {
    return response;
  }

  if (ctx.route.id === "stall-leads") {
    return {
      ...response,
      items: response.items.map((item) => maskLead(item, ctx))
    };
  }

  if (ctx.route.id === "interaction-lead-detail") {
    return {
      ...response,
      item: response.item ? maskLead(response.item, ctx) : null
    };
  }

  return response;
}

const MASKED_FIELDS = ["full_name", "company_name", "title", "email", "phone"];

function maskLead(item, ctx) {
  const policy = ctx.resources.eventPolicy;
  const principal = ctx.principal;
  const consent = item.consent ?? { vendor_release_allowed: false, sponsor_release_allowed: false };
  const maskedFields = {
    full_name: "Masked until consent",
    company_name: "Masked",
    title: null,
    email: null,
    phone: null
  };

  if (principal?.role === "vendor_manager") {
    if (!consent.vendor_release_allowed) {
      return withPrivacyMask(item, maskedFields, "vendor_consent_required");
    }
    return withPrivacyVisible(item, "vendor_consent_granted");
  }

  if (principal?.role === "organizer_admin") {
    if (!consent.vendor_release_allowed) {
      return withPrivacyMask(item, maskedFields, "vendor_consent_required");
    }
    return withPrivacyVisible(item, "organizer_event_scope_vendor_consent_granted");
  }

  if (principal?.role === "sponsor_user") {
    if (!policy?.sponsor_pii_enabled || !consent.sponsor_release_allowed) {
      return withPrivacyMask(
        item,
        maskedFields,
        policy?.sponsor_pii_enabled ? "sponsor_consent_required" : "sponsor_pii_disabled_by_event_policy"
      );
    }
    return withPrivacyVisible(item, "sponsor_consent_granted");
  }

  if (principal?.role === "ops_user") {
    return withPrivacyMask(item, maskedFields, "ops_user_minimized_access");
  }

  if (principal?.role === "platform_admin") {
    const scope = parseBreakGlassScope(ctx.breakGlass?.access_scope);
    const canUnmask =
      ctx.breakGlass &&
      scope.permissions.includes("stall_leads_unmask") &&
      scopeMatches(scope, item, ctx);
    if (!canUnmask) {
      return withPrivacyMask(item, maskedFields, "break_glass_required_for_platform_unmask");
    }
    return { ...withPrivacyVisible(item, "active_break_glass_unmask"), break_glass_access_id: ctx.breakGlass.id };
  }

  return withPrivacyVisible(item, "role_allows_view");
}

function withPrivacyMask(item, maskedFields, reason) {
  return {
    ...item,
    ...maskedFields,
    masked: true,
    privacy: {
      pii_visible: false,
      reason,
      masked_fields: MASKED_FIELDS
    }
  };
}

function withPrivacyVisible(item, reason) {
  return {
    ...item,
    masked: false,
    privacy: {
      pii_visible: true,
      reason,
      masked_fields: []
    }
  };
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

function scopeMatches(scope, _item, ctx) {
  const eventId = ctx.resources.event?.id;
  const stallId = ctx.resources.stall?.id;
  const eventAllowed = scope.event_ids.length === 0 || scope.event_ids.includes(eventId);
  const stallAllowed = scope.stall_ids.length === 0 || scope.stall_ids.includes(stallId);
  return eventAllowed && stallAllowed;
}
