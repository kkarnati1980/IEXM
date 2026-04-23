import { HttpError } from "../http-error.mjs";

export const PILOT_CRM_PROVIDER = "pilot_crm";
export const PILOT_CRM_PIPELINE_STAGES = [
  "lead_added",
  "contacted",
  "replied",
  "call_scheduled",
  "demo_done",
  "proposal_sent",
  "negotiation",
  "closed_won",
  "closed_lost"
];

export async function syncInteractionToPilotCrm({
  interaction,
  attendeeProfile,
  stall,
  event,
  notes = [],
  provider = PILOT_CRM_PROVIDER
}) {
  if (!attendeeProfile?.full_name && !attendeeProfile?.email && !attendeeProfile?.phone) {
    throw new HttpError(409, "CRM sync requires attendee profile data");
  }

  const externalRecordId = `${provider}:${interaction.id}`;
  const syncedAt = new Date();
  const pipeline = buildPilotCrmPipeline(interaction, syncedAt);
  const requestPayload = {
    event_id: event.id,
    event_name: event.name,
    stall_id: stall.id,
    stall_code: stall.code,
    stall_name: stall.name,
    interaction_id: interaction.id,
    attendee: {
      full_name: attendeeProfile.full_name ?? null,
      company_name: attendeeProfile.company_name ?? null,
      email: attendeeProfile.email ?? null,
      phone: attendeeProfile.phone ?? null
    },
    lead: {
      consent_status: interaction.consent_status,
      classification: interaction.classification ?? "cold",
      status: interaction.status,
      sponsor_click_count: interaction.sponsor_click_count ?? 0,
      pipeline
    },
    notes: notes.map((note) => ({
      author_user_id: note.author_user_id,
      note: note.note,
      created_at: note.created_at
    }))
  };

  return {
    provider,
    external_record_id: externalRecordId,
    request_payload: requestPayload,
    response_payload: {
      provider,
      operation: "upsert",
      remote_status: "active",
      external_record_id: externalRecordId,
      pipeline
    },
    synced_at: syncedAt.toISOString()
  };
}

function buildPilotCrmPipeline(interaction, syncedAt) {
  const classification = interaction.classification ?? "cold";
  const nextActionByClassification = {
    hot: "Schedule discovery call",
    warm: "Send follow-up material",
    cold: "Review lead qualification"
  };
  const nextActionAt = new Date(syncedAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
  return {
    stage: "lead_added",
    next_action: nextActionByClassification[classification] ?? nextActionByClassification.cold,
    next_action_at: nextActionAt
  };
}

export async function deletePilotCrmRecord({
  externalRecordId,
  reason,
  provider = PILOT_CRM_PROVIDER
}) {
  if (!externalRecordId) {
    throw new HttpError(409, "CRM deletion requires an external record id");
  }

  return {
    provider,
    external_record_id: externalRecordId,
    response_payload: {
      provider,
      operation: "delete",
      remote_status: "deleted",
      external_record_id: externalRecordId,
      reason: reason ?? null
    },
    deleted_at: new Date().toISOString()
  };
}
