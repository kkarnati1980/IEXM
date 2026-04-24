import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// N=16384 is equivalent in cost to bcrypt rounds=12 on modern hardware
const PARAMS = { N: 16384, r: 8, p: 1 };

export async function hashPassword(plaintext) {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(plaintext, salt, KEY_BYTES, PARAMS);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(plaintext, stored) {
  if (typeof stored !== "string" || !stored.startsWith("scrypt:")) {
    return false;
  }
  const [, saltHex, keyHex] = stored.split(":");
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(keyHex, "hex");
  try {
    const actual = await scryptAsync(plaintext, salt, KEY_BYTES, PARAMS);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function validatePasswordComplexity(password) {
  if (typeof password !== "string" || password.length < 10) {
    return "Password must be at least 10 characters";
  }
  if (!/[A-Z]/.test(password)) {
    return "Password must contain at least one uppercase letter";
  }
  if (!/[0-9]/.test(password)) {
    return "Password must contain at least one number";
  }
  return null;
}
