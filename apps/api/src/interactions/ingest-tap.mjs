import { nextId } from "../store.mjs";
import { HttpError } from "../http-error.mjs";

export async function ingestTapEvent({ repos, body, resources, cloudReceivedAt = null }) {
  if (resources.assignment && (resources.assignment.event_id !== body.event_id || resources.assignment.stall_id !== body.stall_id)) {
    throw new HttpError(403, "Tap event/stall must match active device assignment");
  }

  if (
    body.assignment_checksum &&
    resources.assignment &&
    body.assignment_checksum !== resources.assignment.assignment_checksum
  ) {
    throw new HttpError(409, "Tap assignment checksum mismatch", {
      code: "assignment_checksum_mismatch",
      expected_assignment_checksum: resources.assignment.assignment_checksum,
      received_assignment_checksum: body.assignment_checksum
    });
  }

  const existingTap = await repos.tapEvents.findByIdempotencyKey(
    resources.event.tenant_id,
    body.device_id,
    body.local_event_id
  );

  if (existingTap) {
    const existingInteraction = await repos.interactions.findByTapEventId(resources.event.tenant_id, existingTap.id);
    return {
      mode: "duplicate_existing",
      interaction: existingInteraction,
      tapEvent: existingTap
    };
  }

  return repos.withTransaction(async (txRepos) => {
    try {
      const now = new Date().toISOString();
      const tapEvent = {
        id: nextId("tap"),
        tenant_id: resources.event.tenant_id,
        event_id: resources.event.id,
        stall_id: resources.stall.id,
        device_id: body.device_id,
        local_event_id: body.local_event_id,
        tap_type: body.tap_type,
        reader_uid_hash: body.reader_uid ?? null,
        ndef_payload: body.ndef_payload ?? null,
        occurred_at: body.occurred_at,
        created_at: now,
        cloud_received_at: cloudReceivedAt ?? now
      };
      const createdTap = await txRepos.tapEvents.create(tapEvent);

      const interaction = await txRepos.interactions.create({
        id: nextId("interaction"),
        tenant_id: resources.event.tenant_id,
        event_id: resources.event.id,
        stall_id: resources.stall.id,
        tap_event_id: createdTap.id,
        attendee_id: null,
        captured_by_user_id: null,
        status: "consent_required",
        consent_status: "pending",
        classification: "cold",
        sponsor_click_count: 0,
        created_at: now,
        updated_at: now
      });

      return {
        mode: "created",
        interaction,
        tapEvent: createdTap
      };
    } catch (error) {
      if (error instanceof HttpError && error.statusCode === 409 && error.details?.code === "duplicate_tap") {
        const duplicateTap = await txRepos.tapEvents.findByIdempotencyKey(
          resources.event.tenant_id,
          body.device_id,
          body.local_event_id
        );
        const duplicateInteraction = await txRepos.interactions.findByTapEventId(
          resources.event.tenant_id,
          duplicateTap.id
        );
        return {
          mode: "duplicate_existing",
          interaction: duplicateInteraction,
          tapEvent: duplicateTap
        };
      }
      throw error;
    }
  });
}

