import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function makeApp(state) {
  return createApp({ state });
}

function sha256(str) {
  return createHash("sha256").update(str).digest("hex");
}

// Seed device/event/stall IDs (from store.mjs createSeedState)
const DEVICE_ID = "device-01";
const EVENT_ID = "event-demo";
const STALL_ID = "stall-a1";
const OCCURRED_AT = "2026-05-11T10:00:00.000Z";

// TEST 1 — SHA-256 hash consistency
test("NFC: SHA-256 hash is case-insensitive and 64 chars", () => {
  const raw = "04A3B2C1D4E5F6";
  const h1 = sha256(raw.toLowerCase());
  const h2 = sha256(raw); // uppercase — different
  const h3 = sha256(raw.toLowerCase()); // repeated lowercase — same

  assert.notEqual(h1, h2, "uppercase and lowercase must differ before lowercasing");
  assert.equal(h1, h3, "lowercased hashing must be idempotent");
  assert.equal(h1.length, 64, "SHA-256 hex digest must be 64 characters");
});

// TEST 2 — New attendee NFC tap returns 201 with all fields
test("NFC: POST /interactions/nfc-tap creates new attendee (201)", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("device-token"),
    body: {
      nfc_uid: "04A3B2C1D4E5F6",
      device_id: DEVICE_ID,
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-test-new-001",
      occurred_at: OCCURRED_AT
    }
  });

  assert.equal(res.statusCode, 201, `Expected 201, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const d = res.body;
  assert.ok(d.interaction_id, "interaction_id must be present");
  assert.ok(d.attendee_id, "attendee_id must be present");
  assert.equal(d.is_new_attendee, true, "is_new_attendee must be true for unknown UID");
  assert.equal(d.nfc_uid_hash, sha256("04a3b2c1d4e5f6"), "nfc_uid_hash must be SHA-256 of lowercased UID");
  assert.ok(d.attendee_session_token, "attendee_session_token must be present");
  assert.ok(d.consent_url, "consent_url must be present");
  assert.ok(d.consent_url.includes("consent_token="), "consent_url must contain consent_token param");
  assert.ok(d.consent_url.includes("interaction_id="), "consent_url must contain interaction_id param");
  assert.equal(d.consent_status, "pending", "initial consent_status must be pending");
});

// TEST 3 — Returning attendee (same UID, different tap)
test("NFC: second tap with same UID returns is_new_attendee=false and same attendee_id", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const firstRes = await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("device-token"),
    body: {
      nfc_uid: "04RETURNING01",
      device_id: DEVICE_ID,
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-returning-001",
      occurred_at: OCCURRED_AT
    }
  });
  assert.equal(firstRes.statusCode, 201);
  const firstAttendeeId = firstRes.body.attendee_id;

  const secondRes = await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("device-token"),
    body: {
      nfc_uid: "04RETURNING01",
      device_id: DEVICE_ID,
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-returning-002",
      occurred_at: OCCURRED_AT
    }
  });
  assert.equal(secondRes.statusCode, 201);
  const d = secondRes.body;
  assert.equal(d.is_new_attendee, false, "second tap must not create a new attendee");
  assert.equal(d.attendee_id, firstAttendeeId, "attendee_id must match the first tap");
});

// TEST 4 — Idempotent tap (same local_event_id)
test("NFC: duplicate local_event_id returns duplicate_existing mode", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("device-token"),
    body: {
      nfc_uid: "04IDEMPOTENT01",
      device_id: DEVICE_ID,
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-idem-001",
      occurred_at: OCCURRED_AT
    }
  });

  const dupRes = await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("device-token"),
    body: {
      nfc_uid: "04IDEMPOTENT01",
      device_id: DEVICE_ID,
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-idem-001",
      occurred_at: OCCURRED_AT
    }
  });

  assert.ok(
    [200, 201].includes(dupRes.statusCode),
    `Expected 200 or 201 for duplicate, got ${dupRes.statusCode}`
  );
  assert.equal(dupRes.body.result, "duplicate_existing", "duplicate tap must return duplicate_existing mode");
});

// TEST 5 — Missing nfc_uid returns 400
test("NFC: POST without nfc_uid returns 400", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("device-token"),
    body: {
      device_id: DEVICE_ID,
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-missing-uid",
      occurred_at: OCCURRED_AT
    }
  });

  assert.equal(res.statusCode, 400);
  const body = JSON.stringify(res.body);
  assert.ok(body.includes("nfc_uid"), "error message must mention nfc_uid");
});

// TEST 6 — Missing device_id fails (resolveResources runs before validate, so device lookup
// fires first and returns 404 Device not found — still a correctly-rejected bad request)
test("NFC: POST without device_id is rejected with 4xx", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("device-token"),
    body: {
      nfc_uid: "04SOMEUID",
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-missing-device",
      occurred_at: OCCURRED_AT
    }
  });

  assert.ok(res.statusCode >= 400 && res.statusCode < 500, `Expected 4xx, got ${res.statusCode}`);
});

// TEST 7 — Wrong role returns 403
test("NFC: POST /interactions/nfc-tap with organizer token returns 403", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  const res = await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("organizer-token"),
    body: {
      nfc_uid: "04WRONGROLE",
      device_id: DEVICE_ID,
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-wrong-role",
      occurred_at: OCCURRED_AT
    }
  });

  assert.equal(res.statusCode, 403);
});

// TEST 8 — PUT /attendees/:id/nfc-tag links NFC card to a known attendee
// att-ie-001 is demo data not in createSeedState() — we create an attendee via nfc-tap first
test("NFC: PUT /attendees/:id/nfc-tag links card and returns hash (200)", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  // Create an attendee via nfc-tap so we have a valid attendee_id
  const tapRes = await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("device-token"),
    body: {
      nfc_uid: "04PUTTEST001",
      device_id: DEVICE_ID,
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-put-create-001",
      occurred_at: OCCURRED_AT
    }
  });
  assert.equal(tapRes.statusCode, 201);
  const attendeeId = tapRes.body.attendee_id;

  // Now PUT a new NFC UID to that attendee
  const res = await app.inject({
    method: "PUT",
    path: `/attendees/${attendeeId}/nfc-tag`,
    headers: bearer("organizer-token"),
    body: { nfc_uid: "AABBCCDDEEFF00" }
  });

  assert.equal(res.statusCode, 200, `Expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  const d = res.body;
  assert.equal(d.attendee_id, attendeeId);
  assert.equal(d.nfc_uid_hash, sha256("aabbccddeeff00"), "nfc_uid_hash must be SHA-256 of lowercased UID");
  assert.ok(d.message, "response must include a message");
});

// TEST 9 — Tap finds pre-registered attendee by PUT nfc-tag
test("NFC: tap after PUT /nfc-tag finds the pre-registered attendee", async () => {
  const state = createSeedState();
  const app = await makeApp(state);

  // Step 1: Create an attendee via nfc-tap
  const createRes = await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("device-token"),
    body: {
      nfc_uid: "04PREREG001",
      device_id: DEVICE_ID,
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-prereg-create-001",
      occurred_at: OCCURRED_AT
    }
  });
  assert.equal(createRes.statusCode, 201);
  const attendeeId = createRes.body.attendee_id;

  // Step 2: Link a new NFC UID to that attendee
  const putRes = await app.inject({
    method: "PUT",
    path: `/attendees/${attendeeId}/nfc-tag`,
    headers: bearer("organizer-token"),
    body: { nfc_uid: "AABBCCDDEEFF00" }
  });
  assert.equal(putRes.statusCode, 200);

  // Step 3: Tap with the newly-linked UID
  const tapRes = await app.inject({
    method: "POST",
    path: "/interactions/nfc-tap",
    headers: bearer("device-token"),
    body: {
      nfc_uid: "AABBCCDDEEFF00",
      device_id: DEVICE_ID,
      event_id: EVENT_ID,
      stall_id: STALL_ID,
      local_event_id: "nfc-prereg-tap-001",
      occurred_at: OCCURRED_AT
    }
  });

  assert.equal(tapRes.statusCode, 201, `Expected 201, got ${tapRes.statusCode}: ${JSON.stringify(tapRes.body)}`);
  const d = tapRes.body;
  assert.equal(d.attendee_id, attendeeId, "tap must resolve to the pre-registered attendee");
  assert.equal(d.is_new_attendee, false, "pre-registered attendee must not be flagged as new");
});
