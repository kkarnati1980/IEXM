import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

const EVENT_ID = "event-demo";

test("NFC batches: organizer can create a batch (201)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/nfc-batches`,
    headers: bearer("organizer-token"),
    body: { label: "Hall A Batch 1", quantity: 100, pass_type_id: "pt-vip" }
  });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.body.label, "Hall A Batch 1");
  assert.equal(r.body.quantity, 100);
  assert.ok(r.body.id);
});

test("NFC batches: organizer can list batches (200)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/nfc-batches`,
    headers: bearer("organizer-token"),
    body: { label: "Batch Alpha", quantity: 50 }
  });
  const r = await app.inject({
    method: "GET",
    path: `/organizer/events/${EVENT_ID}/nfc-batches`,
    headers: bearer("organizer-token")
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(Array.isArray(r.body));
  assert.ok(r.body.some((b) => b.label === "Batch Alpha"));
});

test("NFC batches: organizer can add UIDs to a batch (201)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const batchRes = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/nfc-batches`,
    headers: bearer("organizer-token"),
    body: { label: "UID Batch", quantity: 3 }
  });
  assert.equal(batchRes.statusCode, 201, batchRes.body);
  const batchId = batchRes.body.id;
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/nfc-batches/${batchId}/uids`,
    headers: bearer("organizer-token"),
    body: { uids: ["AA:BB:CC:DD", "11:22:33:44", "FF:EE:DD:CC"] }
  });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.body.added, 3);
  assert.equal(r.body.uids.length, 3);
});

test("NFC batches: vendor cannot create a batch (403)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/nfc-batches`,
    headers: bearer("vendor-token"),
    body: { label: "Unauthorized", quantity: 10 }
  });
  assert.equal(r.statusCode, 403);
});

test("NFC batches: create rejects missing label (400)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/nfc-batches`,
    headers: bearer("organizer-token"),
    body: { quantity: 10 }
  });
  assert.equal(r.statusCode, 400);
});

test("NFC batches: add UIDs rejects empty array (400)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const batchRes = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/nfc-batches`,
    headers: bearer("organizer-token"),
    body: { label: "Empty Batch", quantity: 0 }
  });
  const batchId = batchRes.body.id;
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/nfc-batches/${batchId}/uids`,
    headers: bearer("organizer-token"),
    body: { uids: [] }
  });
  assert.equal(r.statusCode, 400);
});
