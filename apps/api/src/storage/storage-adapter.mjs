import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function getBackend() {
  return process.env.STORAGE_BACKEND ?? "local";
}

function getStorageDir() {
  return process.env.LOCAL_STORAGE_PATH ?? "./storage/exports/";
}

function getSecret() {
  return process.env.EXPORT_SECRET ?? process.env.SESSION_SECRET ?? "dev-export-secret";
}

// ── Local helpers ────────────────────────────────────────────────

function buildLocalSignedUrl(key, expiresUnix) {
  const sig = createHmac("sha256", getSecret())
    .update(`${key}:${expiresUnix}`)
    .digest("hex");
  return `/api/exports/download?key=${encodeURIComponent(key)}&expires=${expiresUnix}&sig=${sig}`;
}

export function validateDownloadToken(key, expiresStr, sig) {
  const expiresUnix = parseInt(expiresStr, 10);
  if (Number.isNaN(expiresUnix) || Math.floor(Date.now() / 1000) > expiresUnix) {
    return false;
  }
  const expected = createHmac("sha256", getSecret())
    .update(`${key}:${expiresUnix}`)
    .digest("hex");
  return sig === expected;
}

export function readLocalFile(key) {
  const filePath = path.join(getStorageDir(), key);
  return fs.readFileSync(filePath);
}

// ── S3 / R2 helpers (dynamic import — zero dep when local) ───────
// R2_* vars take precedence over AWS_* vars when both are present.

function getS3Bucket() {
  return process.env.R2_BUCKET ?? process.env.S3_BUCKET;
}

async function getS3Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const endpoint   = process.env.R2_ENDPOINT   ?? process.env.S3_ENDPOINT;
  const accessKeyId     = process.env.R2_ACCESS_KEY_ID     ?? process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? "";
  return new S3Client({
    region: process.env.S3_REGION ?? "ap-south-1",
    ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId ? { credentials: { accessKeyId, secretAccessKey } } : {})
  });
}

async function uploadToS3(key, buffer, contentType, expiresIn) {
  const [{ PutObjectCommand, GetObjectCommand }, { getSignedUrl }] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/s3-request-presigner")
  ]);
  const client = await getS3Client();
  const bucket = getS3Bucket();
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn });
  return { url, key, expires_at: new Date(Date.now() + expiresIn * 1000) };
}

async function deleteFromS3(key) {
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await getS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: getS3Bucket(), Key: key }));
}

async function getS3SignedUrl(key, expiresIn) {
  const [{ GetObjectCommand }, { getSignedUrl }] = await Promise.all([
    import("@aws-sdk/client-s3"),
    import("@aws-sdk/s3-request-presigner")
  ]);
  const client = await getS3Client();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }), { expiresIn });
}

// ── Public API ───────────────────────────────────────────────────

export async function uploadFile(key, buffer, contentType, options = {}) {
  const expiresIn = options.expiresIn ?? 86400;

  if (getBackend() === "s3") {
    return uploadToS3(key, buffer, contentType, expiresIn);
  }

  const storageDir = getStorageDir();
  const filePath = path.join(storageDir, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buffer);

  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const expiresUnix = Math.floor(expiresAt.getTime() / 1000);
  const url = buildLocalSignedUrl(key, expiresUnix);

  return { url, key, expires_at: expiresAt };
}

export async function deleteFile(key) {
  if (getBackend() === "s3") {
    return deleteFromS3(key);
  }

  const filePath = path.join(getStorageDir(), key);
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

export async function getSignedDownloadUrl(key, expiresIn = 3600) {
  if (getBackend() === "s3") {
    return getS3SignedUrl(key, expiresIn);
  }

  const expiresAt = new Date(Date.now() + expiresIn * 1000);
  const expiresUnix = Math.floor(expiresAt.getTime() / 1000);
  return buildLocalSignedUrl(key, expiresUnix);
}
