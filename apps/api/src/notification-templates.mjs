export function renderTemplate(messageType, vars = {}) {
  switch (messageType) {
    case "user_invitation": return renderUserInvitation(vars);
    case "invite_expiry_reminder": return renderInviteExpiryReminder(vars);
    case "account_activated": return renderAccountActivated(vars);
    case "password_reset": return renderPasswordReset(vars);
    case "break_glass_pending_approval": return renderBreakGlassPendingApproval(vars);
    default: throw new Error(`Unknown notification template: ${messageType}`);
  }
}

function renderUserInvitation({ display_name = "there", invite_url = "", platform_name = "Codex" }) {
  return {
    subject: `You've been invited to ${platform_name}`,
    body: [
      `Hi ${display_name},`,
      ``,
      `You've been invited to join ${platform_name}. Click the link below to set up your account:`,
      ``,
      invite_url,
      ``,
      `This invitation expires in 7 days. If you did not expect this invitation, you can safely ignore this email.`
    ].join("\n")
  };
}

function renderInviteExpiryReminder({ display_name = "there", invite_url = "", platform_name = "Codex" }) {
  return {
    subject: `Your invitation to ${platform_name} is expiring soon`,
    body: [
      `Hi ${display_name},`,
      ``,
      `Your invitation to join ${platform_name} is expiring soon. Accept it before it expires:`,
      ``,
      invite_url,
      ``,
      `If you did not expect this invitation, you can safely ignore this email.`
    ].join("\n")
  };
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
