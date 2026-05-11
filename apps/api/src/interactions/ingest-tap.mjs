import { randomBytes } from "node:crypto";
import { nextId } from "../store.mjs";
import { HttpError } from "../http-error.mjs";

export async function ingestTapEvent({ repos, body, resources, cloudReceivedAt = null, attendeeId = null }) {
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
        attendee_id: attendeeId,
        captured_by_user_id: null,
        status: "consent_required",
        consent_status: "pending",
        classification: "cold",
        sponsor_click_count: 0,
        created_at: now,
        updated_at: now
      });

      const docGrants = await autoGrantDocumentAccess(txRepos, {
        stallId: resources.stall.id,
        interactionId: interaction.id,
        tenantId: resources.event.tenant_id,
        eventId: resources.event.id,
        attendeeId
      });

      return {
        mode: "created",
        interaction,
        tapEvent: createdTap,
        document_access: docGrants.length > 0 ? {
          has_documents: true,
          access_url: (process.env.BASE_URL ?? "") + "/docs/" + docGrants[0].access_token,
          folders: docGrants.map(g => g.folder_name)
        } : { has_documents: false, access_url: null, folders: [] }
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

async function autoGrantDocumentAccess(repos, { stallId, interactionId, tenantId, eventId, attendeeId = null }) {
  try {
    const folders = await repos.stallSharedFolders.listActive(stallId, tenantId);
    const openFolders = folders.filter(f => f.default_access === "open" && f.status === "active");
    if (!openFolders.length) return [];

    const expiryDays = parseInt(process.env.DRIVE_ACCESS_TOKEN_EXPIRY_DAYS ?? "30", 10);
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString();

    const grants = [];
    for (const folder of openFolders) {
      const accessToken = randomBytes(32).toString("hex");
      await repos.stallFolderAccess.create({
        id: "sfa-" + randomBytes(6).toString("hex"),
        tenant_id: tenantId,
        stall_id: stallId,
        event_id: eventId,
        folder_id: folder.id,
        attendee_id: attendeeId,
        interaction_id: interactionId,
        access_token: accessToken,
        access_token_expires_at: expiresAt,
        granted_by: "auto",
        status: "active"
      });
      grants.push({ folder_name: folder.folder_name, access_token: accessToken });
    }
    return grants;
  } catch (err) {
    console.error("[drive] Auto-grant failed:", err.message);
    return [];
  }
}

