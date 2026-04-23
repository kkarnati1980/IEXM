import { createHash, randomBytes } from "node:crypto";

export function createDeviceCredentialToken() {
  return `dvc_${randomBytes(24).toString("base64url")}`;
}

export function hashDeviceCredentialToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

