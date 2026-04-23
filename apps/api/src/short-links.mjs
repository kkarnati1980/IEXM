import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 24;

export function createShortLinkToken() {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashShortLinkToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function shortLinkPath(token) {
  return `/s/${encodeURIComponent(token)}`;
}
