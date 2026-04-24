import { randomBytes, createHmac } from "node:crypto";

const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

export function generatePlaintextToken() {
  return randomBytes(32).toString("hex");
}

export function hashToken(plaintext, secret) {
  return createHmac("sha256", secret).update(plaintext).digest("hex");
}

export async function generateInviteToken(userId, tenantId, repos, secret) {
  const plaintext = generatePlaintextToken();
  const hash = hashToken(plaintext, secret);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const user = await repos.users.findById(tenantId, userId);
  await repos.users.update({
    ...user,
    invitation_token_hash: hash,
    invitation_expires_at: expiresAt
  });
  return plaintext;
}

export async function generateResetToken(userId, tenantId, repos, secret) {
  const plaintext = generatePlaintextToken();
  const hash = hashToken(plaintext, secret);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
  const user = await repos.users.findById(tenantId, userId);
  await repos.users.update({
    ...user,
    password_reset_token_hash: hash,
    password_reset_expires_at: expiresAt
  });
  return plaintext;
}
