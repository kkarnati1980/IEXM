import { createHmac, timingSafeEqual } from "node:crypto";

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
const DEFAULT_TTL = 86400; // 24 hours

export function issuePlatformToken(payload, secret, ttlSeconds = DEFAULT_TTL) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + ttlSeconds };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signing = `${HEADER}.${body}`;
  const sig = createHmac("sha256", secret).update(signing).digest("base64url");
  return `${signing}.${sig}`;
}

export function verifyPlatformToken(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedBody, encodedSig] = parts;
  const signing = `${encodedHeader}.${encodedBody}`;
  const expectedSig = createHmac("sha256", secret).update(signing).digest("base64url");

  const provided = Buffer.from(encodedSig, "utf8");
  const expected = Buffer.from(expectedSig, "utf8");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(encodedBody, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && now >= claims.exp) return null;
  if (claims.type !== "user") return null;

  return claims;
}
