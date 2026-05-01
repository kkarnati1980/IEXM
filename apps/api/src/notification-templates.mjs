const FOOTER_TEXT = [
  "",
  "--",
  "Codex Platform · This is a transactional notification.",
  "You received this email because you have an account on Codex Platform.",
  "Questions? Contact support@codex.io"
].join("\n");

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Converts plain-text body to a simple HTML email.
function buildHtml(body) {
  const URL_RE = /^(https?:\/\/\S+)$/;
  const lines = body.split("\n");

  const blocks = [];
  let current = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) { blocks.push(current); current = []; }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);

  const innerHtml = blocks.map((group) => {
    const content = group.map((line) => {
      if (URL_RE.test(line.trim())) {
        const url = esc(line.trim());
        return `<a href="${url}" style="color:#4f46e5;word-break:break-all;">${url}</a>`;
      }
      return esc(line);
    }).join("<br>\n");
    return `<p style="margin:0 0 16px;line-height:1.6;">${content}</p>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr>
          <td style="background:#1e293b;padding:20px 32px;">
            <span style="font-size:18px;font-weight:700;color:#f8fafc;letter-spacing:-0.3px;">Codex Platform</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px;">
            ${innerHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.5;">
              <strong style="color:#64748b;">Codex Platform</strong><br>
              This is a transactional notification. You received this email because you have an
              account on Codex Platform. If you believe you received this in error, please contact
              <a href="mailto:support@codex.io" style="color:#4f46e5;">support@codex.io</a>.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function renderTemplate(messageType, vars = {}) {
  const { subject, body, html: htmlOverride } = renderBody(messageType, vars);
  const text = body + FOOTER_TEXT;
  return { subject, html: htmlOverride ?? buildHtml(body), text, body: text };
}

function renderBody(messageType, vars = {}) {
  switch (messageType) {
    case "user_invitation": return renderUserInvitation(vars);
    case "invite_expiry_reminder": return renderInviteExpiryReminder(vars);
    case "account_activated": return renderAccountActivated(vars);
    case "password_reset": return renderPasswordReset(vars);
    case "break_glass_pending_approval": return renderBreakGlassPendingApproval(vars);
    case "break_glass_organizer_alert": return renderBreakGlassOrganizerAlert(vars);
    case "data_policy_changed": return renderDataPolicyChanged(vars);
    case "retention_purge_completed": return renderRetentionPurgeCompleted(vars);
    case "retention_expiry_warning": return renderRetentionExpiryWarning(vars);
    case "full_export_ready": return renderFullExportReady(vars);
    case "dsr_export_ready": return renderDsrExportReady(vars);
    case "dsr_delete_confirmed": return renderDsrDeleteConfirmed(vars);
    case "offboarding_deletion_certificate": return renderOffboardingDeletionCertificate(vars);
    case "offboarding_initiated": return renderOffboardingInitiated(vars);
    case "offboarding_deletion_reminder_14d": return renderOffboardingDeletionReminder14d(vars);
    case "offboarding_deletion_reminder_3d": return renderOffboardingDeletionReminder3d(vars);
    default: throw new Error(`Unknown notification template: ${messageType}`);
  }
}

function renderUserInvitation({ display_name = "there", invite_url = "", platform_name = "Codex" }) {
  const body = [
    `Hi ${display_name},`,
    ``,
    `You've been invited to join ${platform_name}. Accept your invitation here:`,
    ``,
    invite_url,
    ``,
    `This invitation expires in 7 days. If you did not expect this invitation, you can safely ignore this email.`
  ].join("\n");
  const html = `<p>Hi ${esc(display_name)},</p>
<p>You've been invited to join <strong>${esc(platform_name)}</strong>. Click the button below to set up your account:</p>
<p>
  <a href="${esc(invite_url)}" style="display:inline-block;padding:12px 24px;background:#f3c97d;color:#101117;text-decoration:none;border-radius:6px;font-weight:bold;">Accept Invitation</a>
</p>
<p style="margin-top:12px;font-size:12px;color:#666;">Or copy this link: <a href="${esc(invite_url)}">${esc(invite_url)}</a></p>
<p style="font-size:12px;color:#666;">This invitation expires in 7 days. If you did not expect this invitation, you can safely ignore this email.</p>`;
  return { subject: `You've been invited to ${platform_name}`, body, html };
}

function renderInviteExpiryReminder({ display_name = "there", invite_url = "", platform_name = "Codex" }) {
  const body = [
    `Hi ${display_name},`,
    ``,
    `Your invitation to join ${platform_name} is expiring soon. Accept it here:`,
    ``,
    invite_url,
    ``,
    `If you did not expect this invitation, you can safely ignore this email.`
  ].join("\n");
  const html = `<p>Hi ${esc(display_name)},</p>
<p>Your invitation to join <strong>${esc(platform_name)}</strong> is expiring soon.</p>
<p>
  <a href="${esc(invite_url)}" style="display:inline-block;padding:12px 24px;background:#f3c97d;color:#101117;text-decoration:none;border-radius:6px;font-weight:bold;">Accept Invitation</a>
</p>
<p style="margin-top:12px;font-size:12px;color:#666;">Or copy this link: <a href="${esc(invite_url)}">${esc(invite_url)}</a></p>
<p style="font-size:12px;color:#666;">If you did not expect this invitation, you can safely ignore this email.</p>`;
  return { subject: `Your invitation to ${platform_name} is expiring soon`, body, html };
}

function renderAccountActivated({ display_name = "there", login_url = "", platform_name = "Codex" }) {
  return {
    subject: `Welcome to ${platform_name} — your account is active`,
    body: [
      `Hi ${display_name},`,
      ``,
      `Your ${platform_name} account is now active. You can log in at any time:`,
      ``,
      login_url,
      ``,
      `If you have any questions, contact your administrator.`
    ].join("\n")
  };
}

function renderPasswordReset({ display_name = "there", reset_url = "", platform_name = "Codex" }) {
  return {
    subject: `Reset your ${platform_name} password`,
    body: [
      `Hi ${display_name},`,
      ``,
      `We received a request to reset your ${platform_name} password. Click the link below to choose a new password:`,
      ``,
      reset_url,
      ``,
      `This link expires in 1 hour. If you did not request a password reset, you can safely ignore this email.`
    ].join("\n")
  };
}

function renderBreakGlassPendingApproval({ requester_name = "A platform admin", justification = "", platform_name = "Codex" }) {
  return {
    subject: `[${platform_name}] Break-glass access request requires approval`,
    body: [
      `Hi,`,
      ``,
      `${requester_name} has submitted a break-glass access request on ${platform_name} and requires your approval.`,
      ``,
      `Justification: ${justification}`,
      ``,
      `Log in to the platform admin console to review and approve or deny this request.`
    ].join("\n")
  };
}

function renderBreakGlassOrganizerAlert({
  organizer_name = "there",
  requester_role = "platform operator",
  access_scope = "",
  justification = "",
  event_name = "your event",
  duration_minutes = null,
  platform_access_log_url = "",
  platform_name = "Codex"
}) {
  const occurred_at = new Date().toISOString();
  const durationLine = duration_minutes
    ? `Duration: ${duration_minutes} minute(s)`
    : "Duration: not specified";
  return {
    subject: `Platform operator accessed your event data — ${event_name}`,
    body: [
      `Hi ${organizer_name},`,
      ``,
      `A ${platform_name} platform operator (role: ${requester_role}) accessed data for "${event_name}" using break-glass emergency access.`,
      ``,
      `Time: ${occurred_at}`,
      `Access type: ${access_scope}`,
      `Justification: ${justification}`,
      durationLine,
      ``,
      `You can review the full access log here:`,
      platform_access_log_url,
      ``,
      `If you have questions about this access, contact your ${platform_name} account manager.`
    ].join("\n")
  };
}

function renderDataPolicyChanged({
  organizer_name = "there",
  event_name = "your event",
  changed_fields = [],
  actor_role = "platform_admin",
  occurred_at = new Date().toISOString(),
  review_url = "",
  platform_name = "Codex"
}) {
  const fieldLines = changed_fields.map(
    (f) => `  - ${f.field}: ${f.old_value} → ${f.new_value}`
  );
  const warning = actor_role === "platform_admin"
    ? `\nIMPORTANT: This change was made by a platform administrator, not your team.\n`
    : "";
  return {
    subject: `Data policy updated on ${event_name}`,
    body: [
      `Hi ${organizer_name},`,
      ``,
      `The data policy for "${event_name}" was updated by a ${actor_role} on ${occurred_at}.`,
      warning,
      `Changed fields:`,
      ...fieldLines,
      ``,
      `Review the current policy here:`,
      review_url,
      ``,
      `If you did not expect this change, contact ${platform_name} support immediately.`
    ].join("\n")
  };
}

function renderRetentionPurgeCompleted({
  organizer_name = "there",
  event_name = "your event",
  records_anonymised = 0,
  purged_at = new Date().toISOString(),
  retention_days = 30,
  platform_name = "Codex"
}) {
  return {
    subject: `Event data anonymised — ${event_name}`,
    body: [
      `Hi ${organizer_name},`,
      ``,
      `The data for "${event_name}" has been anonymised in accordance with your ${retention_days}-day retention policy.`,
      ``,
      `Anonymised on: ${purged_at}`,
      `Records processed: ${records_anonymised}`,
      ``,
      `What was removed: attendee PII (name, email, phone, company), interaction identifiers.`,
      `What was kept: anonymised analytics, aggregate metrics, consent audit trail.`,
      ``,
      `If you have questions, contact ${platform_name} support.`
    ].join("\n")
  };
}

function renderRetentionExpiryWarning({
  organizer_name = "there",
  event_name = "your event",
  retention_expiry_date = "",
  days_remaining = 14,
  data_policy_url = "",
  platform_name = "Codex"
}) {
  return {
    subject: `Your event data will be anonymised in ${days_remaining} days — ${event_name}`,
    body: [
      `Hi ${organizer_name},`,
      ``,
      `The data for "${event_name}" will be automatically anonymised on ${retention_expiry_date} (${days_remaining} day(s) from now).`,
      ``,
      `What will be removed: attendee PII (name, email, phone, company), interaction identifiers.`,
      `What will be kept: anonymised analytics, aggregate metrics, consent audit trail.`,
      ``,
      `To change your retention policy before this date, visit:`,
      data_policy_url || `(Log in to ${platform_name} to update your data policy)`,
      ``,
      `If you have questions, contact ${platform_name} support.`
    ].join("\n")
  };
}

function renderFullExportReady({
  organizer_name = "there",
  event_name = "your event",
  export_id = "",
  download_url = "",
  expires_in_hours = 24,
  platform_name = "Codex"
}) {
  return {
    subject: `Your event data export is ready — ${event_name}`,
    body: [
      `Hi ${organizer_name},`,
      ``,
      `Your full data export for "${event_name}" is ready to download.`,
      ``,
      `Export ID: ${export_id}`,
      download_url ? `Download link: ${download_url}` : `Log in to ${platform_name} to download your export.`,
      ``,
      `This download link expires in ${expires_in_hours} hours and can only be used once.`,
      ``,
      `Please store the downloaded file securely — it contains event data subject to your data policy.`,
      ``,
      `If you did not request this export, contact ${platform_name} support immediately.`
    ].join("\n")
  };
}

function renderDsrExportReady({
  attendee_name = "there",
  export_id = "",
  download_url = "",
  expires_in_hours = 24
}) {
  return {
    subject: `Your data export is ready`,
    body: [
      `Hi ${attendee_name},`,
      ``,
      `Your personal data export is ready to download.`,
      ``,
      `Export ID: ${export_id}`,
      download_url ? `Download link: ${download_url}` : `Please log in to download your data export.`,
      ``,
      `This link expires in ${expires_in_hours} hours and can only be used once.`,
      ``,
      `The export contains all personal data we hold for you as requested. Please store it securely.`,
      ``,
      `If you did not request this export, please contact us immediately.`
    ].join("\n")
  };
}

function renderDsrDeleteConfirmed({
  attendee_name = "there",
  event_name = "your event",
  completed_at = new Date().toISOString()
}) {
  return {
    subject: `Your data has been deleted`,
    body: [
      `Hi ${attendee_name},`,
      ``,
      `Your personal data associated with "${event_name}" has been deleted as requested.`,
      ``,
      `Deletion completed on: ${completed_at}`,
      ``,
      `What was removed: your name, email, phone number, company, and interaction details.`,
      `What was kept: anonymised analytics data used for aggregate event reporting (no personal identifiers).`,
      ``,
      `If you have any questions, please contact us.`
    ].join("\n")
  };
}

function renderOffboardingInitiated({
  organizer_name = "there",
  tenant_name = "your organisation",
  data_handling_path = "immediate_delete",
  grace_period_days = null,
  scheduled_deletion_at = null,
  contact_email = "support@codex.io"
}) {
  let pathDescription;
  if (data_handling_path === "export_then_delete") {
    pathDescription = "Your data will be exported first. You will receive a download link before any deletion occurs.";
  } else if (data_handling_path === "grace_period_delete") {
    pathDescription = `Your data will be retained for ${grace_period_days ?? "?"} days, then permanently deleted on ${scheduled_deletion_at ?? "the scheduled date"}.`;
  } else {
    pathDescription = "Your data will be permanently deleted. This process requires a second administrator approval.";
  }
  return {
    subject: `Account offboarding initiated — ${tenant_name}`,
    body: [
      `Hi ${organizer_name},`,
      ``,
      `Your account offboarding for "${tenant_name}" has been initiated.`,
      ``,
      pathDescription,
      ``,
      `If you did not request this or have questions, contact ${contact_email} immediately.`
    ].join("\n")
  };
}

function renderOffboardingDeletionReminder14d({
  organizer_name = "there",
  tenant_name = "your organisation",
  scheduled_deletion_at = "",
  contact_email = "support@codex.io"
}) {
  return {
    subject: `Your data will be deleted in 14 days — ${tenant_name}`,
    body: [
      `Hi ${organizer_name},`,
      ``,
      `This is a reminder that the data for "${tenant_name}" is scheduled for permanent deletion on ${scheduled_deletion_at}.`,
      ``,
      `You have 14 days remaining before this deletion occurs.`,
      ``,
      `To cancel or pause the offboarding process, contact ${contact_email} as soon as possible.`,
      ``,
      `After deletion is complete, data cannot be recovered.`
    ].join("\n")
  };
}

function renderOffboardingDeletionReminder3d({
  organizer_name = "there",
  tenant_name = "your organisation",
  scheduled_deletion_at = "",
  contact_email = "support@codex.io"
}) {
  return {
    subject: `URGENT: Your data will be deleted in 3 days — ${tenant_name}`,
    body: [
      `Hi ${organizer_name},`,
      ``,
      `URGENT: The data for "${tenant_name}" will be permanently deleted on ${scheduled_deletion_at}.`,
      ``,
      `You have only 3 days remaining before this deletion occurs.`,
      ``,
      `To cancel or pause the offboarding process, contact ${contact_email} immediately.`,
      ``,
      `After deletion is complete, data cannot be recovered. This action is irreversible.`
    ].join("\n")
  };
}

function renderOffboardingDeletionCertificate({
  organizer_name = "there",
  tenant_name = "your organisation",
  deleted_at = new Date().toISOString(),
  certificate_download_url = "",
  platform_name = "Codex"
}) {
  return {
    subject: `Data deletion certificate — ${tenant_name}`,
    body: [
      `Hi ${organizer_name},`,
      ``,
      `The data deletion for "${tenant_name}" on ${platform_name} has been completed.`,
      ``,
      `Deletion completed on: ${deleted_at}`,
      ``,
      `Your data deletion certificate is available here:`,
      certificate_download_url || `(Log in to ${platform_name} to download your certificate)`,
      ``,
      `Please retain this certificate for your records. As per data protection regulations, this certificate will be kept for 7 years.`,
      ``,
      `If you have questions about this deletion, contact ${platform_name} support.`
    ].join("\n")
  };
}
