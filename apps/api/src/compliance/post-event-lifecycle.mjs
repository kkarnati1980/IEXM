import { HttpError } from "../http-error.mjs";
import { nextId } from "../store.mjs";
import { deletePilotCrmRecord, PILOT_CRM_PROVIDER } from "../crm/pilot-crm.mjs";
import { dispatchPilotWebhookDeletion, isWebhookTarget } from "../integrations/pilot-webhook.mjs";

export async function buildComplianceOverview({ repos, event, eventPolicy }) {
  const [interactions, requests, downstreamRecords, latestRun, crmSyncRecords] = await Promise.all([
    repos.interactions.listByEvent(event.tenant_id, event.id),
    repos.dataSubjectRequests.listByEvent(event.tenant_id, event.id),
    repos.downstreamDeletionRecords.listByEvent(event.tenant_id, event.id),
    repos.complianceRuns.findLatestByEvent(event.tenant_id, event.id),
    repos.crmSyncRecords.listByEvent(event.tenant_id, event.id)
  ]);
  const schedule = buildRetentionSchedule(event, eventPolicy);
  return {
    event_id: event.id,
    event_status: event.status,
    retention_days: eventPolicy.retention_days,
    retention_due_at: schedule.due_at,
    retention_due: schedule.due,
    retention_anchor_at: schedule.anchor_at,
    total_interactions: interactions.length,
    anonymized_interactions: interactions.filter((entry) => entry.status === "anonymized").length,
    active_interactions: interactions.filter((entry) => entry.status !== "anonymized").length,
    dsr_counts: {
      requested: requests.filter((entry) => entry.status === "requested").length,
      in_progress: requests.filter((entry) => entry.status === "in_progress").length,
      completed: requests.filter((entry) => entry.status === "completed").length,
      rejected: requests.filter((entry) => entry.status === "rejected").length
    },
    downstream_deletion_counts: {
      pending: downstreamRecords.filter((entry) => entry.status === "pending").length,
      confirmed: downstreamRecords.filter((entry) => entry.status === "confirmed").length,
      failed: downstreamRecords.filter((entry) => entry.status === "failed").length
    },
    crm_sync_counts: {
      synced: crmSyncRecords.filter((entry) => entry.status === "synced").length,
      delete_pending: crmSyncRecords.filter((entry) => entry.status === "delete_pending").length,
      deleted: crmSyncRecords.filter((entry) => entry.status === "deleted").length,
      failed: crmSyncRecords.filter((entry) => entry.status === "failed").length
    },
    latest_retention_run: latestRun && latestRun.run_type.startsWith("retention")
      ? latestRun
      : null
  };
}

export async function buildComplianceOperationalReport({ repos, event, eventPolicy }) {
  const [overview, requests, downstreamRecords, runs, crmSyncRecords, auditLogs] = await Promise.all([
    buildComplianceOverview({ repos, event, eventPolicy }),
    repos.dataSubjectRequests.listByEvent(event.tenant_id, event.id),
    repos.downstreamDeletionRecords.listByEvent(event.tenant_id, event.id),
    repos.complianceRuns.listByEvent(event.tenant_id, event.id),
    repos.crmSyncRecords.listByEvent(event.tenant_id, event.id),
    repos.auditLogs.listByTenant(event.tenant_id)
  ]);

  const relevantAuditLogs = filterComplianceAuditLogs({
    auditLogs,
    eventId: event.id,
    dsrIds: requests.map((entry) => entry.id),
    downstreamIds: downstreamRecords.map((entry) => entry.id),
    runIds: runs.map((entry) => entry.id)
  });

  return {
    generated_at: new Date().toISOString(),
    event: {
      id: event.id,
      name: event.name,
      status: event.status
    },
    overview,
    dsr_reporting: {
      by_type: {
        access: requests.filter((entry) => entry.request_type === "access").length,
        delete: requests.filter((entry) => entry.request_type === "delete").length
      },
      by_status: overview.dsr_counts,
      average_completion_hours: averageCompletionHours(requests),
      recent_requests: requests.slice(0, 10).map(summarizeRequest)
    },
    downstream_reporting: {
      by_target: summarizeByTarget(downstreamRecords),
      pending: downstreamRecords.filter((entry) => entry.status === "pending").length,
      failed: downstreamRecords.filter((entry) => entry.status === "failed").length,
      recent_failures: downstreamRecords
        .filter((entry) => entry.status === "failed")
        .slice(0, 10)
        .map((entry) => ({
          id: entry.id,
          target_system: entry.target_system,
          last_error: entry.last_error,
          updated_at: entry.updated_at
        }))
    },
    crm_reporting: {
      counts: overview.crm_sync_counts,
      records: crmSyncRecords.slice(0, 10).map((entry) => ({
        id: entry.id,
        interaction_id: entry.interaction_id,
        provider: entry.provider,
        status: entry.status,
        external_record_id: entry.external_record_id,
        updated_at: entry.updated_at,
        synced_at: entry.synced_at,
        deleted_at: entry.deleted_at
      }))
    },
    retention_reporting: {
      due_at: overview.retention_due_at,
      due: overview.retention_due,
      latest_run: overview.latest_retention_run,
      recent_runs: runs.slice(0, 10).map((entry) => ({
        id: entry.id,
        run_type: entry.run_type,
        status: entry.status,
        initiated_by: entry.initiated_by,
        created_at: entry.created_at,
        summary: entry.summary
      }))
    },
    audit_reporting: {
      total_entries: relevantAuditLogs.length,
      event_types: summarizeAuditEventTypes(relevantAuditLogs),
      recent_entries: relevantAuditLogs.slice(0, 20).map((entry) => ({
        id: entry.id,
        event_type: entry.event_type,
        actor_id: entry.actor_id,
        target_type: entry.target_type,
        target_id: entry.target_id,
        created_at: entry.created_at,
        metadata: entry.metadata
      }))
    }
  };
}

export async function listDataSubjectRequestsForEvent({ repos, event }) {
  const requests = await repos.dataSubjectRequests.listByEvent(event.tenant_id, event.id);
  const items = [];
  for (const request of requests) {
    const downstream = await repos.downstreamDeletionRecords.listByRequest(event.tenant_id, request.id);
    items.push({
      ...request,
      downstream_deletions: downstream
    });
  }
  return items;
}

export async function createDataSubjectRequest({ repos, event, principal, body }) {
  if (!["access", "delete"].includes(body.request_type)) {
    throw new HttpError(400, "request_type must be access or delete");
  }
  const resolution = await resolveRequestSubject({ repos, tenantId: event.tenant_id, eventId: event.id, body });
  const now = new Date().toISOString();
  return repos.dataSubjectRequests.create({
    id: nextId("dsr"),
    tenant_id: event.tenant_id,
    event_id: event.id,
    attendee_id: resolution.attendee_id,
    interaction_id: resolution.interaction_id,
    request_type: body.request_type,
    status: "requested",
    requested_by_user_id: principal?.user_id ?? null,
    request_reason: body.request_reason ?? null,
    resolution_summary: null,
    result_payload: {},
    created_at: now,
    updated_at: now,
    completed_at: null
  });
}

export async function completeDataSubjectRequest({
  repos,
  event,
  eventPolicy,
  principal,
  request,
  body
}) {
  const now = new Date().toISOString();
  if (request.status === "completed") {
    return buildDataSubjectRequestDetail({
      repos,
      tenantId: event.tenant_id,
      request: await repos.dataSubjectRequests.findById(event.tenant_id, request.id)
    });
  }

  const nextRequest = { ...request };
  if (request.request_type === "access") {
    nextRequest.status = "completed";
    nextRequest.resolution_summary = body.resolution_summary ?? "Access package prepared.";
    nextRequest.result_payload = await buildAccessPackage({
      repos,
      tenantId: event.tenant_id,
      event,
      request
    });
    nextRequest.updated_at = now;
    nextRequest.completed_at = now;
    await repos.dataSubjectRequests.update(nextRequest);
    return buildDataSubjectRequestDetail({
      repos,
      tenantId: event.tenant_id,
      request: nextRequest
    });
  }

  const downstreamTargets = inferDownstreamTargets(eventPolicy, body.downstream_targets);
  const anonymizationSummary = await anonymizeSubjectInEvent({
    repos,
    tenantId: event.tenant_id,
    event,
    attendeeId: request.attendee_id,
    interactionId: request.interaction_id,
    resolutionSummary: body.resolution_summary ?? "Delete request fulfilled.",
    now
  });

  await queueDownstreamDeletionRecords({
    repos,
    tenantId: event.tenant_id,
    eventId: event.id,
    dsrRequestId: request.id,
    request,
    interactionId: request.interaction_id,
    attendeeId: request.attendee_id,
    downstreamTargets,
    resolutionSummary: body.resolution_summary ?? "Delete request fulfilled.",
    now
  });

  const run = {
    id: nextId("compliance-run"),
    tenant_id: event.tenant_id,
    event_id: event.id,
    run_type: "dsr_delete_apply",
    status: "completed",
    initiated_by: principal.user_id,
    summary: {
      request_id: request.id,
      downstream_targets: downstreamTargets,
      ...anonymizationSummary
    },
    created_at: now
  };
  await repos.complianceRuns.create(run);

  nextRequest.status = "completed";
  nextRequest.resolution_summary = body.resolution_summary ?? "Delete request fulfilled.";
  nextRequest.result_payload = {
    downstream_targets: downstreamTargets,
    anonymization: anonymizationSummary
  };
  nextRequest.updated_at = now;
  nextRequest.completed_at = now;
  await repos.dataSubjectRequests.update(nextRequest);

  return buildDataSubjectRequestDetail({
    repos,
    tenantId: event.tenant_id,
    request: nextRequest
  });
}

export async function confirmDownstreamDeletionRecord({ repos, record, body }) {
  const now = new Date().toISOString();
  const next = {
    ...record,
    status: body.status,
    confirmed_at: body.status === "confirmed" ? now : record.confirmed_at,
    last_error: body.status === "failed" ? body.note ?? "Downstream deletion failed." : null,
    details: {
      ...(record.details ?? {}),
      confirmation_note: body.note ?? null
    },
    updated_at: now
  };
  return repos.downstreamDeletionRecords.update(next);
}

export async function dispatchDownstreamDeletion({ repos, record, principal }) {
  const now = new Date().toISOString();
  if (record.status === "confirmed") {
    return record;
  }

  const deleted = await dispatchTargetDeletion(record);

  const next = await repos.downstreamDeletionRecords.update({
    ...record,
    status: "confirmed",
    confirmed_at: deleted.confirmed_at,
    details: {
      ...(record.details ?? {}),
      dispatched_by_user_id: principal.user_id,
      dispatch_provider: deleted.provider,
      deletion_response: deleted.response_payload
    },
    last_error: null,
    updated_at: now
  });

  if (record.target_system === "crm" && record.details?.interaction_id) {
    const existingSync = await repos.crmSyncRecords.findByInteractionAndProvider(
      record.tenant_id,
      record.details.interaction_id,
      record.details.provider ?? PILOT_CRM_PROVIDER
    );
    if (existingSync) {
      await repos.crmSyncRecords.upsert({
        ...existingSync,
        status: "deleted",
        response_payload: deleted.response_payload,
        last_error: null,
        request_payload: redactCrmRequestPayload(existingSync, now),
        deleted_at: deleted.confirmed_at,
        updated_at: now
      });
    }
  }

  if (record.target_system === "wallet_artifacts") {
    for (const walletPassId of record.details?.wallet_pass_ids ?? []) {
      const walletPass = await repos.walletPasses.findById(record.tenant_id, walletPassId);
      await repos.walletPasses.update({
        ...walletPass,
        status: walletPass.status === "delivered" ? "delivered" : "cancelled",
        artifact_ref: null,
        short_link_id: null,
        failure_code: null,
        failure_message: null,
        updated_at: now
      });
    }
  }

  return next;
}

export async function runRetentionLifecycle({
  repos,
  event,
  eventPolicy,
  principal,
  body
}) {
  const mode = body.mode ?? "preview";
  const force = body.force === true;
  const now = new Date().toISOString();
  if (!["preview", "apply"].includes(mode)) {
    throw new HttpError(400, "Retention mode must be preview or apply");
  }
  const targets = await collectRetentionTargets({
    repos,
    tenantId: event.tenant_id,
    event
  });
  const schedule = buildRetentionSchedule(event, eventPolicy);
  const summary = {
    mode,
    force,
    retention_due_at: schedule.due_at,
    retention_due: schedule.due,
    event_status: event.status,
    interactions_to_anonymize: targets.interactions.length,
    attendee_profiles_to_scrub: targets.profile_attendee_ids.length,
    shared_attendees_skipped: targets.shared_attendee_ids.length,
    exports_to_expire: targets.exports.length,
    short_links_to_expire: targets.short_links.length,
    wallet_passes_to_cleanup: targets.wallet_passes.length,
    crm_sync_records_to_scrub: targets.crm_sync_records.length
  };

  if (mode === "preview") {
    const previewRun = {
      id: nextId("compliance-run"),
      tenant_id: event.tenant_id,
      event_id: event.id,
      run_type: "retention_preview",
      status: "preview",
      initiated_by: principal.user_id,
      summary,
      created_at: now
    };
    await repos.complianceRuns.create(previewRun);
    return {
      ...summary,
      run_id: previewRun.id
    };
  }

  if (!["closed", "archived"].includes(event.status)) {
    throw new HttpError(409, "Retention apply requires the event to be closed or archived");
  }
  if (!schedule.due && !force) {
    throw new HttpError(409, `Retention window is not due until ${schedule.due_at}`);
  }

  for (const interaction of targets.interactions) {
    await repos.interactions.update({
      ...interaction,
      attendee_id: null,
      status: "anonymized",
      consent_status: "declined",
      updated_at: now
    });
    const consent = await repos.consents.findByInteractionId(event.tenant_id, interaction.id);
    if (consent) {
      await repos.consents.upsert({
        ...consent,
        attendee_id: null,
        vendor_release_allowed: false,
        sponsor_release_allowed: false,
        revoked_at: consent.revoked_at ?? now,
        updated_at: now
      });
    }
  }

  for (const attendeeId of targets.profile_attendee_ids) {
    const existing = await repos.attendeeProfiles.findByAttendeeId(attendeeId);
    if (!existing) {
      continue;
    }
    await repos.attendeeProfiles.upsert({
      ...existing,
      full_name: null,
      company_name: null,
      email: null,
      phone: null,
      updated_at: now
    });
  }

  for (const exportRequest of targets.exports) {
    await repos.exportRequests.update({
      ...exportRequest,
      status: "expired",
      file_url: null,
      file_expires_at: now
    });
  }

  for (const shortLink of targets.short_links) {
    await repos.shortLinks.update({
      ...shortLink,
      status: "expired",
      expires_at: now
    });
  }

  for (const walletPass of targets.wallet_passes) {
    await repos.walletPasses.update({
      ...walletPass,
      status: walletPass.status === "delivered" ? "delivered" : "cancelled",
      artifact_ref: null,
      short_link_id: null,
      failure_code: null,
      failure_message: null,
      updated_at: now
    });
  }

  for (const crmSyncRecord of targets.crm_sync_records) {
    await repos.crmSyncRecords.upsert({
      ...crmSyncRecord,
      status: crmSyncRecord.status === "deleted" ? "deleted" : "delete_pending",
      request_payload: redactCrmRequestPayload(crmSyncRecord, now),
      response_payload: redactCrmResponsePayload(crmSyncRecord),
      last_error:
        crmSyncRecord.status === "deleted"
          ? null
          : "Retention cleanup pending downstream confirmation",
      updated_at: now
    });
  }

  if (event.status !== "archived") {
    await repos.events.update({
      ...event,
      status: "archived",
      ends_at: event.ends_at ?? now
    });
  }

  const applyRun = {
    id: nextId("compliance-run"),
    tenant_id: event.tenant_id,
    event_id: event.id,
    run_type: "retention_apply",
    status: "completed",
    initiated_by: principal.user_id,
    summary,
    created_at: now
  };
  await repos.complianceRuns.create(applyRun);

  return {
    ...summary,
    run_id: applyRun.id,
    event_status: "archived"
  };
}

export async function buildDataSubjectRequestDetail({ repos, tenantId, request }) {
  const downstream = await repos.downstreamDeletionRecords.listByRequest(tenantId, request.id);
  return {
    ...request,
    downstream_deletions: downstream
  };
}

async function resolveRequestSubject({ repos, tenantId, eventId, body }) {
  if (!body.attendee_id && !body.interaction_id) {
    throw new HttpError(400, "A delete or access request requires attendee_id or interaction_id");
  }
  if (body.interaction_id) {
    const interaction = await repos.interactions.findById(tenantId, body.interaction_id);
    if (interaction.event_id !== eventId) {
      throw new HttpError(403, "Interaction is outside the selected event");
    }
    if (!interaction.attendee_id && !body.attendee_id) {
      throw new HttpError(409, "Interaction is already anonymized");
    }
    return {
      attendee_id: body.attendee_id ?? interaction.attendee_id,
      interaction_id: interaction.id
    };
  }
  return {
    attendee_id: body.attendee_id,
    interaction_id: null
  };
}

async function buildAccessPackage({ repos, tenantId, event, request }) {
  const interactions = (await repos.interactions.listByEvent(tenantId, event.id))
    .filter((entry) => entry.attendee_id === request.attendee_id || entry.id === request.interaction_id);
  const profile = request.attendee_id
    ? await repos.attendeeProfiles.findByAttendeeId(request.attendee_id)
    : null;
  const consentRecords = [];
  const consentEvents = [];
  const walletPassRecords = [];
  const walletPassAttemptRecords = [];
  const shortLinkRecords = [];
  const allShortLinks = typeof repos.shortLinks?.listByTenant === "function"
    ? await repos.shortLinks.listByTenant(tenantId)
    : [];
  for (const interaction of interactions) {
    const consent = await repos.consents.findByInteractionId(tenantId, interaction.id);
    if (consent) {
      consentRecords.push(consent);
    }
    if (typeof repos.consentEvents.listByInteraction === "function") {
      consentEvents.push(...await repos.consentEvents.listByInteraction(tenantId, interaction.id));
    }
    const walletPasses = typeof repos.walletPasses?.listByInteraction === "function"
      ? await repos.walletPasses.listByInteraction(tenantId, interaction.id)
      : [];
    walletPassRecords.push(...walletPasses);
    for (const walletPass of walletPasses) {
      if (typeof repos.walletPassAttempts?.listByWalletPass === "function") {
        walletPassAttemptRecords.push(...await repos.walletPassAttempts.listByWalletPass(tenantId, walletPass.id));
      }
    }
    const walletPassIds = new Set(walletPasses.map((entry) => entry.id));
    shortLinkRecords.push(...allShortLinks.filter((entry) =>
      (entry.target_type === "attendee_session" && entry.target_id === interaction.id) ||
      (entry.target_type === "wallet_pass" && walletPassIds.has(entry.target_id))
    ));
  }
  return {
    event_id: event.id,
    event_name: event.name,
    attendee_id: request.attendee_id,
    interaction_id: request.interaction_id,
    attendee_profile: profile,
    interactions,
    consent_records: consentRecords,
    consent_events: consentEvents,
    wallet_pass_records: walletPassRecords.map(redactWalletPassForDsr),
    wallet_pass_attempts: walletPassAttemptRecords.map(redactWalletPassAttemptForDsr),
    short_link_records: shortLinkRecords.map(redactShortLinkForDsr)
  };
}

function redactWalletPassForDsr(walletPass) {
  return {
    id: walletPass.id,
    event_id: walletPass.event_id,
    stall_id: walletPass.stall_id,
    interaction_id: walletPass.interaction_id,
    pass_type: walletPass.pass_type,
    status: walletPass.status,
    short_link_id: walletPass.short_link_id,
    failure_code: walletPass.failure_code,
    failure_message: walletPass.failure_message,
    delivered_at: walletPass.delivered_at,
    created_at: walletPass.created_at,
    updated_at: walletPass.updated_at
  };
}

function redactWalletPassAttemptForDsr(attempt) {
  return {
    id: attempt.id,
    wallet_pass_id: attempt.wallet_pass_id,
    provider: attempt.provider,
    status: attempt.status,
    reason: attempt.reason,
    pass_type: attempt.pass_type,
    failure_code: attempt.failure_code,
    failure_message: attempt.failure_message,
    attempted_at: attempt.attempted_at
  };
}

function redactShortLinkForDsr(shortLink) {
  return {
    id: shortLink.id,
    target_type: shortLink.target_type,
    target_id: shortLink.target_id,
    status: shortLink.status,
    expires_at: shortLink.expires_at,
    consumed_at: shortLink.consumed_at,
    created_at: shortLink.created_at
  };
}

async function anonymizeSubjectInEvent({
  repos,
  tenantId,
  event,
  attendeeId,
  interactionId,
  resolutionSummary,
  now
}) {
  const interactions = (await repos.interactions.listByEvent(tenantId, event.id))
    .filter((entry) =>
      entry.attendee_id === attendeeId || (interactionId && entry.id === interactionId)
    );
  if (!interactions.length) {
    throw new HttpError(404, "No event interactions matched this data-subject request");
  }

  const profileTargetIds = await findProfileTargets({
    repos,
    tenantId,
    eventId: event.id,
    attendeeIds: [...new Set(interactions.map((entry) => entry.attendee_id).filter(Boolean))]
  });

  for (const interaction of interactions) {
    await repos.interactions.update({
      ...interaction,
      attendee_id: null,
      status: "anonymized",
      consent_status: "declined",
      updated_at: now
    });
    const consent = await repos.consents.findByInteractionId(tenantId, interaction.id);
    if (consent) {
      await repos.consents.upsert({
        ...consent,
        attendee_id: null,
        vendor_release_allowed: false,
        sponsor_release_allowed: false,
        revoked_at: consent.revoked_at ?? now,
        updated_at: now
      });
    }
  }

  for (const profileAttendeeId of profileTargetIds) {
    const existing = await repos.attendeeProfiles.findByAttendeeId(profileAttendeeId);
    if (!existing) {
      continue;
    }
    await repos.attendeeProfiles.upsert({
      ...existing,
      full_name: null,
      company_name: null,
      email: null,
      phone: null,
      updated_at: now
    });
  }

  return {
    interactions_anonymized: interactions.length,
    attendee_profiles_scrubbed: profileTargetIds.length,
    resolution_summary: resolutionSummary
  };
}

async function collectRetentionTargets({ repos, tenantId, event }) {
  const interactions = await repos.interactions.listByEvent(tenantId, event.id);
  const attendeeIds = [...new Set(interactions.map((entry) => entry.attendee_id).filter(Boolean))];
  const profileTargets = await findProfileTargets({
    repos,
    tenantId,
    eventId: event.id,
    attendeeIds
  });
  const sharedAttendeeIds = attendeeIds.filter((entry) => !profileTargets.includes(entry));
  const exports = (await repos.exportRequests.listByEvent(tenantId, event.id))
    .filter((entry) => ["requested", "approved", "generated"].includes(entry.status));
  const walletPasses = typeof repos.walletPasses?.listByEvent === "function"
    ? await repos.walletPasses.listByEvent(tenantId, event.id)
    : [];
  const interactionIds = new Set(interactions.map((entry) => entry.id));
  const exportIds = new Set(exports.map((entry) => entry.id));
  const walletPassIds = new Set(walletPasses.map((entry) => entry.id));
  const shortLinks = typeof repos.shortLinks?.listByTenant === "function"
    ? (await repos.shortLinks.listByTenant(tenantId)).filter((entry) =>
      entry.status === "active" &&
      (
        (entry.target_type === "attendee_session" && interactionIds.has(entry.target_id)) ||
        (entry.target_type === "export_download" && exportIds.has(entry.target_id)) ||
        (entry.target_type === "wallet_pass" && walletPassIds.has(entry.target_id))
      )
    )
    : [];
  const crmSyncRecords = (await repos.crmSyncRecords.listByEvent(tenantId, event.id))
    .filter((entry) => entry.provider === PILOT_CRM_PROVIDER);
  return {
    interactions,
    attendee_ids: attendeeIds,
    profile_attendee_ids: profileTargets,
    shared_attendee_ids: sharedAttendeeIds,
    exports,
    short_links: shortLinks,
    wallet_passes: walletPasses,
    crm_sync_records: crmSyncRecords
  };
}

async function findProfileTargets({ repos, tenantId, eventId, attendeeIds }) {
  if (!attendeeIds.length) {
    return [];
  }
  const events = await repos.events.listByTenant(tenantId);
  const otherEventIds = events.map((entry) => entry.id).filter((id) => id !== eventId);
  const shared = new Set();
  for (const otherEventId of otherEventIds) {
    const otherInteractions = await repos.interactions.listByEvent(tenantId, otherEventId);
    for (const interaction of otherInteractions) {
      if (interaction.attendee_id && attendeeIds.includes(interaction.attendee_id) && interaction.status !== "anonymized") {
        shared.add(interaction.attendee_id);
      }
    }
  }
  return attendeeIds.filter((entry) => !shared.has(entry));
}

function inferDownstreamTargets(eventPolicy, bodyTargets) {
  if (Array.isArray(bodyTargets) && bodyTargets.length) {
    return bodyTargets;
  }
  return eventPolicy.allow_crm_push ? ["crm"] : ["internal_exports"];
}

function summarizeRequest(request) {
  return {
    id: request.id,
    request_type: request.request_type,
    status: request.status,
    requested_by_user_id: request.requested_by_user_id,
    created_at: request.created_at,
    completed_at: request.completed_at,
    resolution_summary: request.resolution_summary
  };
}

function averageCompletionHours(requests) {
  const completed = requests.filter((entry) => entry.completed_at);
  if (!completed.length) {
    return 0;
  }
  const hours = completed.map((entry) => (
    Date.parse(entry.completed_at) - Date.parse(entry.created_at)
  ) / (60 * 60 * 1000));
  return Number((hours.reduce((sum, value) => sum + value, 0) / hours.length).toFixed(2));
}

function summarizeByTarget(records) {
  const summary = {};
  for (const record of records) {
    const bucket = summary[record.target_system] ?? { pending: 0, confirmed: 0, failed: 0 };
    bucket[record.status] = (bucket[record.status] ?? 0) + 1;
    summary[record.target_system] = bucket;
  }
  return summary;
}

function filterComplianceAuditLogs({ auditLogs, eventId, dsrIds, downstreamIds, runIds }) {
  return auditLogs
    .filter((entry) => {
      if (entry.target_id === eventId) {
        return true;
      }
      if (dsrIds.includes(entry.target_id) || downstreamIds.includes(entry.target_id) || runIds.includes(entry.target_id)) {
        return true;
      }
      return [
        "organizer.compliance",
        "organizer.dsr",
        "organizer.downstream_deletion",
        "organizer.retention",
        "interaction.crm_sync"
      ].some((prefix) => entry.event_type?.startsWith(prefix));
    })
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
}

function summarizeAuditEventTypes(entries) {
  const counts = {};
  for (const entry of entries) {
    counts[entry.event_type] = (counts[entry.event_type] ?? 0) + 1;
  }
  return counts;
}

async function queueDownstreamDeletionRecords({
  repos,
  tenantId,
  eventId,
  dsrRequestId,
  request,
  interactionId,
  attendeeId,
  downstreamTargets,
  resolutionSummary,
  now
}) {
  await queueWalletArtifactDeletionRecord({
    repos,
    tenantId,
    eventId,
    dsrRequestId,
    interactionId,
    attendeeId,
    resolutionSummary,
    now
  });

  for (const target of downstreamTargets) {
    if (target !== "crm") {
      await repos.downstreamDeletionRecords.create({
        id: nextId("downstream-delete"),
        tenant_id: tenantId,
        event_id: eventId,
        dsr_request_id: dsrRequestId,
        target_system: target,
        status: "pending",
        requested_at: now,
        confirmed_at: null,
        details: {
          reason: resolutionSummary,
          attendee_id: attendeeId,
          interaction_id: interactionId,
          dispatch_kind: isWebhookTarget(target) ? "webhook" : "manual"
        },
        last_error: null,
        updated_at: now
      });
      continue;
    }

    const crmRecords = [];
    if (interactionId) {
      const syncRecord = await repos.crmSyncRecords.findByInteractionAndProvider(
        tenantId,
        interactionId,
        PILOT_CRM_PROVIDER
      );
      if (syncRecord) {
        crmRecords.push(syncRecord);
      }
    } else if (request.attendee_id) {
      const interactions = await repos.interactions.listByEvent(tenantId, eventId);
      for (const interaction of interactions) {
        if (interaction.attendee_id !== request.attendee_id) {
          continue;
        }
        const syncRecord = await repos.crmSyncRecords.findByInteractionAndProvider(
          tenantId,
          interaction.id,
          PILOT_CRM_PROVIDER
        );
        if (syncRecord) {
          crmRecords.push(syncRecord);
        }
      }
    }

    if (!crmRecords.length) {
      await repos.downstreamDeletionRecords.create({
        id: nextId("downstream-delete"),
        tenant_id: tenantId,
        event_id: eventId,
        dsr_request_id: dsrRequestId,
        target_system: target,
        status: "pending",
        requested_at: now,
        confirmed_at: null,
        details: {
          reason: resolutionSummary,
          attendee_id: attendeeId,
          interaction_id: interactionId,
          provider: PILOT_CRM_PROVIDER
        },
        last_error: null,
        updated_at: now
      });
      continue;
    }

    for (const syncRecord of crmRecords) {
      await repos.downstreamDeletionRecords.create({
        id: nextId("downstream-delete"),
        tenant_id: tenantId,
        event_id: eventId,
        dsr_request_id: dsrRequestId,
        target_system: target,
        status: "pending",
        requested_at: now,
        confirmed_at: null,
        details: {
          reason: resolutionSummary,
          attendee_id: attendeeId,
          interaction_id: syncRecord.interaction_id,
          provider: syncRecord.provider,
          external_record_id: syncRecord.external_record_id
        },
        last_error: null,
        updated_at: now
      });

      await repos.crmSyncRecords.upsert({
        ...syncRecord,
        status: "delete_pending",
        last_error: null,
        updated_at: now
      });
    }
  }
}

async function dispatchTargetDeletion(record) {
  if (record.target_system === "wallet_artifacts") {
    const walletPassIds = record.details?.wallet_pass_ids ?? [];
    return {
      provider: "wallet_artifact_provider",
      response_payload: {
        deleted_wallet_pass_ids: walletPassIds,
        deletion_mode: "artifact_reference_scrub"
      },
      confirmed_at: new Date().toISOString()
    };
  }

  if (record.target_system === "crm") {
    const externalRecordId = record.details?.external_record_id ?? null;
    const deleted = await deletePilotCrmRecord({
      externalRecordId,
      reason: record.details?.reason ?? null
    });
    return {
      provider: deleted.provider,
      response_payload: deleted.response_payload,
      confirmed_at: deleted.deleted_at
    };
  }

  if (isWebhookTarget(record.target_system)) {
    const delivered = await dispatchPilotWebhookDeletion({
      targetSystem: record.target_system,
      interactionId: record.details?.interaction_id ?? null,
      attendeeId: record.details?.attendee_id ?? null,
      reason: record.details?.reason ?? null
    });
    return {
      provider: delivered.target_system,
      response_payload: delivered.response_payload,
      confirmed_at: delivered.delivered_at
    };
  }

  throw new HttpError(409, "Dispatch is only supported for CRM, webhook, or wallet artifact downstream deletions");
}

async function queueWalletArtifactDeletionRecord({
  repos,
  tenantId,
  eventId,
  dsrRequestId,
  interactionId,
  attendeeId,
  resolutionSummary,
  now
}) {
  if (!interactionId || typeof repos.walletPasses?.listByInteraction !== "function") {
    return;
  }
  const walletPasses = (await repos.walletPasses.listByInteraction(tenantId, interactionId))
    .filter((entry) => entry.artifact_ref || entry.short_link_id);
  if (!walletPasses.length) {
    return;
  }
  await repos.downstreamDeletionRecords.create({
    id: nextId("downstream-delete"),
    tenant_id: tenantId,
    event_id: eventId,
    dsr_request_id: dsrRequestId,
    target_system: "wallet_artifacts",
    status: "pending",
    requested_at: now,
    confirmed_at: null,
    details: {
      reason: resolutionSummary,
      attendee_id: attendeeId,
      interaction_id: interactionId,
      wallet_pass_ids: walletPasses.map((entry) => entry.id),
      dispatch_kind: "wallet_provider_cleanup"
    },
    last_error: null,
    updated_at: now
  });
}

function redactCrmRequestPayload(record, redactedAt) {
  return {
    redacted: true,
    redacted_at: redactedAt,
    interaction_id: record.interaction_id,
    provider: record.provider,
    external_record_id: record.external_record_id
  };
}

function redactCrmResponsePayload(record) {
  return {
    provider: record.provider,
    external_record_id: record.external_record_id,
    remote_status: record.status
  };
}

function buildRetentionSchedule(event, eventPolicy) {
  const anchorAt = event.ends_at ?? event.starts_at ?? event.created_at ?? new Date().toISOString();
  const dueAt = new Date(Date.parse(anchorAt) + Number(eventPolicy.retention_days ?? 30) * 24 * 60 * 60 * 1000).toISOString();
  return {
    anchor_at: anchorAt,
    due_at: dueAt,
    due: Date.now() >= Date.parse(dueAt)
  };
}
