import { createHmac, timingSafeEqual } from "node:crypto";

import { HttpError } from "./http-error.mjs";

function base64urlEncode(value) {
  return Buffer.from(value).toString("base64url");
}

function base64urlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(encodedPayload, secret) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createAttendeeSessionToken(payload, secret) {
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyAttendeeSessionToken(token, secret) {
  if (!token) {
    throw new HttpError(400, "Missing attendee session token");
  }
  if (typeof token !== "string" || !token.includes(".")) {
    throw new HttpError(401, "Invalid attendee session token");
  }

  const [encodedPayload, encodedSignature] = token.split(".");
  const expectedSignature = signPayload(encodedPayload, secret);
  const provided = Buffer.from(encodedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");

  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    throw new HttpError(401, "Attendee session signature mismatch");
  }

  const payload = JSON.parse(base64urlDecode(encodedPayload));
  if (payload.purpose !== "attendee_session") {
    throw new HttpError(401, "Invalid attendee session purpose");
  }
  if (Date.now() > Date.parse(payload.expires_at)) {
    throw new HttpError(401, "Attendee session expired");
  }
  return payload;
}
