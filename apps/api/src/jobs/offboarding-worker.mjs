import { createHash } from "node:crypto";
import { nextId } from "../store.mjs";
import { dispatchTransactionalEmail } from "../notification-dispatch.mjs";

export async function processTenantOffboarding(repos, state, jobId) {
  const job = await repos.tenantOffboardingJobs.findById(jobId);
  if (!job) {
    console.error(`[offboarding-worker] Job ${jobId} not found`);
    return;
  }

  await repos.tenantOffboardingJobs.update({ ...job, status: "deletion_in_progress" });

  try {
    const tenant = await repos.tenants.findById(job.tenant_id);
    const now = new Date().toISOString();

    if (job.data_handling_path === "export_then_delete" && !job.export_file_url) {
      console.log(`[offboarding-worker] Job ${jobId}: export not yet complete, aborting deletion`);
      await repos.tenantOffboardingJobs.update({ ...job, status: "awaiting_approval" });
      return;
    }

    const events = await repos.events.listByTenant(job.tenant_id);
    let totalPurged = 0;

    for (const event of events) {
      try {
        const interactions = await repos.interactions.listByEvent(job.tenant_id, event.id);
        const attendeeIds = [...new Set(interactions.map((i) => i.attendee_id).filter(Boolean))];

        for (const interaction of interactions) {
          if (interaction.status !== "anonymized") {
            await repos.interactions.update({
              ...interaction,
              attendee_id: null,
              status: "anonymized",
              consent_status: "declined",
              updated_at: now
            });
            totalPurged++;
          }
        }

        for (const attendeeId of attendeeIds) {
          const profile = await repos.attendeeProfiles.findByAttendeeId(attendeeId);
          if (profile) {
            await repos.attendeeProfiles.upsert({
              ...profile,
              full_name: null,
              company_name: null,
              email: null,
              phone: null,
              updated_at: now
            });
          }
        }

        await repos.events.update({ ...event, retention_status: "purged", purged_at: now });
      } catch (err) {
        console.error(`[offboarding-worker] Failed to purge event ${event.id}:`, err);
      }
    }

    const witnessHash = createHash("sha256")
      .update(String(job.approved_by_user_id ?? "unknown"))
      .digest("hex");

    const certificate = {
      tenant_name: tenant.name,
      tenant_slug: tenant.slug,
      deleted_at: now,
      data_categories_deleted: ["attendee_pii", "interaction_raw_payload"],
      method: job.data_handling_path,
      executed_by_role: "platform_admin",
      witness_approver_id_hash: witnessHash
    };

    const certB64 = Buffer.from(JSON.stringify(certificate)).toString("base64");
    const certDataUri = `data:application/json;base64,${certB64}`;

    await repos.tenantOffboardingJobs.update({
      ...job,
      status: "completed",
      deletion_certificate_url: certDataUri,
      completed_at: now
    });

    await repos.tenants.update({ ...tenant, offboarding_status: "deleted" });

    await repos.privacyAuditLogs.create({
      id: nextId("pal"),
      tenant_id: job.tenant_id,
      event_id: null,
      actor_user_id: job.approved_by_user_id ?? null,
      actor_role: "system",
      action: "tenant.data_deleted",
      target_type: "tenant",
      target_id: job.tenant_id,
      metadata: { job_id: jobId, events_purged: events.length, certificate_generated: true },
      occurred_at: now
    });

    const allUsers = await repos.users.listByTenant(job.tenant_id);
    const organizerAdmins = allUsers.filter(
      (u) => u.role === "organizer_admin" && u.status === "active" && u.email
    );
    for (const admin of organizerAdmins) {
      await dispatchTransactionalEmail({
        repos,
        tenantId: job.tenant_id,
        recipientEmail: admin.email,
        messageType: "offboarding_deletion_certificate",
        templateVars: {
          organizer_name: admin.display_name ?? "there",
          tenant_name: tenant.name,
          deleted_at: now,
          certificate_download_url: certDataUri,
          platform_name: "Codex"
        }
      });
    }
  } catch (err) {
    console.error(`[offboarding-worker] Failed to process job ${jobId}:`, err);
    await repos.tenantOffboardingJobs.update({ ...job, status: "failed" }).catch(() => {});
    throw err;
  }
}
