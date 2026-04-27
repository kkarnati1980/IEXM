import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// Establish temp directory and env vars before any imports that read them
const TEMP_DIR = mkdtempSync(path.join(tmpdir(), "codex-storage-test-"));
process.env.LOCAL_STORAGE_PATH = TEMP_DIR + path.sep;
process.env.EXPORT_SECRET = "test-infra-storage-secret";
process.env.STORAGE_BACKEND = "local";

import { uploadFile, deleteFile, getSignedDownloadUrl, validateDownloadToken } from "../src/storage/storage-adapter.mjs";
import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";
import { issuePlatformToken } from "../src/auth/platform-jwt.mjs";
import { buildUserPrincipal } from "../src/auth/principals.mjs";
import { createMemoryRepositories } from "../src/repositories/memory.mjs";
import { processFullExportJob } from "../src/jobs/full-export-worker.mjs";

function organizerJwt(state) {
  const user = state.users.find((u) => u.id === "user-organizer");
  const assignments = state.userRoleAssignments.filter((a) => a.user_id === user.id);
  const principal = buildUserPrincipal(user, [], assignments);
  return issuePlatformToken(principal, state.sessionSecret);
}

// ─────────────────────────────────────────────────────────────────
// 1. uploadFile (local): writes file to disk and returns signed URL
// ─────────────────────────────────────────────────────────────────

test("uploadFile (local): writes file to disk and returns signed URL", async () => {
  const key = "test/upload-test-01.json";
  const content = JSON.stringify({ hello: "world" });

  const result = await uploadFile(key, Buffer.from(content), "application/json", { expiresIn: 3600 });

  assert.ok(result.url, "url should be returned");
  assert.ok(result.url.startsWith("/api/exports/download?"), "url should be a local signed URL");
  assert.ok(!result.url.startsWith("data:"), "url must not be a data URI");
  assert.equal(result.key, key);
  assert.ok(result.expires_at instanceof Date, "expires_at should be a Date");

  const filePath = path.join(TEMP_DIR, key);
  assert.ok(fs.existsSync(filePath), "file should exist on disk");
  assert.equal(fs.readFileSync(filePath, "utf8"), content, "file content should match");
});

// ─────────────────────────────────────────────────────────────────
// 2. GET /api/exports/download: valid token returns 200 with data
// ─────────────────────────────────────────────────────────────────

test("GET /api/exports/download: valid signed token returns 200 with file content", async () => {
  const key = "test/download-valid-01.json";
  const content = JSON.stringify({ valid: true });
  const { url } = await uploadFile(key, Buffer.from(content), "application/json", { expiresIn: 3600 });

  const app = await createApp({ state: createSeedState() });
  const urlObj = new URL(url, "http://localhost");
  const res = await app.inject({
    method: "GET",
    path: url
  });

  assert.equal(res.statusCode, 200, "valid token should return 200");
  assert.equal(res.body.key, key);
  assert.equal(res.body.data, content, "returned data should match file content");
  assert.equal(res.body.content_type, "application/json");
});

// ─────────────────────────────────────────────────────────────────
// 3. Expired token returns 403
// ─────────────────────────────────────────────────────────────────

test("GET /api/exports/download: expired token returns 403", async () => {
  const key = "test/download-expired-01.json";
  const content = JSON.stringify({ expired: true });

  // Write the file directly so it exists on disk
  const filePath = path.join(TEMP_DIR, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);

  // Build a URL with an already-expired timestamp (1 second in the past)
  const expiredUnix = Math.floor(Date.now() / 1000) - 1;
  const { createHmac } = await import("node:crypto");
  const sig = createHmac("sha256", process.env.EXPORT_SECRET)
    .update(`${key}:${expiredUnix}`)
    .digest("hex");
  const expiredUrl = `/api/exports/download?key=${encodeURIComponent(key)}&expires=${expiredUnix}&sig=${sig}`;

  const app = await createApp({ state: createSeedState() });
  const res = await app.inject({ method: "GET", path: expiredUrl });

  assert.equal(res.statusCode, 403, "expired token should return 403");
  assert.ok(res.body.error?.includes("DOWNLOAD_LINK_EXPIRED_OR_INVALID"), "error code should indicate expired/invalid");
});

// ─────────────────────────────────────────────────────────────────
// 4. Full export worker: export_file_url is signed URL, not data URI
// ─────────────────────────────────────────────────────────────────

test("Full export worker: export_file_url is a signed URL, not a data: URI", async () => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);

  const exportId = "export-storage-test-01";
  state.exportRequests.push({
    id: exportId,
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    requested_by_user_id: "user-organizer",
    export_type: "full_event_export_json",
    filters: { include: ["event_config"], format: "json" },
    status: "requested",
    approval_required: false,
    download_used: false,
    created_at: new Date().toISOString()
  });

  await processFullExportJob(repos, state, exportId);

  const exportRequest = state.exportRequests.find((e) => e.id === exportId);
  assert.equal(exportRequest.status, "completed");
  assert.ok(exportRequest.export_file_url, "export_file_url should be set");
  assert.ok(!exportRequest.export_file_url.startsWith("data:"), "export_file_url must not be a data URI");
  assert.ok(exportRequest.export_file_url.startsWith("/api/exports/download?"), "export_file_url should be a local signed URL");

  // Verify file actually exists on disk
  const keyMatch = exportRequest.export_file_url.match(/[?&]key=([^&]+)/);
  assert.ok(keyMatch, "URL should contain key param");
  const fileKey = decodeURIComponent(keyMatch[1]);
  const filePath = path.join(TEMP_DIR, fileKey);
  assert.ok(fs.existsSync(filePath), "export file should exist on disk at " + filePath);
});

// ─────────────────────────────────────────────────────────────────
// 5. deleteFile: removes file from disk
// ─────────────────────────────────────────────────────────────────

test("deleteFile (local): removes file from disk", async () => {
  const key = "test/delete-test-01.json";
  await uploadFile(key, Buffer.from("to be deleted"), "application/json");

  const filePath = path.join(TEMP_DIR, key);
  assert.ok(fs.existsSync(filePath), "file should exist before deletion");

  await deleteFile(key);
  assert.ok(!fs.existsSync(filePath), "file should no longer exist after deleteFile");
});

test("deleteFile (local): silently succeeds when file does not exist", async () => {
  await assert.doesNotReject(
    () => deleteFile("test/nonexistent-file-99.json"),
    "deleteFile on missing file should not throw"
  );
});
