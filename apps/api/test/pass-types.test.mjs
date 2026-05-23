import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

const EVENT_ID = "event-demo";

test("Pass types: GET /organizer/events/:id/pass-types returns 200 with array", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "GET",
    path: `/organizer/events/${EVENT_ID}/pass-types`,
    headers: bearer("organizer-token")
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const d = r.body;
  assert.ok(Array.isArray(d), "response must be an array");
  assert.ok(d.length >= 10, `must have at least 10 seeded pass types, got ${d.length}`);
});

test("Pass types: POST creates a new pass type (201)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/pass-types`,
    headers: bearer("organizer-token"),
    body: {
      name: "Investor",
      code: "investor",
      nfc_behaviour: "consent",
      colour_hex: "#FFD700",
      vendor_visible: true
    }
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  const d = r.body;
  assert.equal(d.code, "investor");
  assert.equal(d.nfc_behaviour, "consent");
  assert.ok(d.id.startsWith("pt-"), `id must have pt- prefix, got: ${d.id}`);
});

test("Pass types: POST rejects invalid nfc_behaviour (400)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/pass-types`,
    headers: bearer("organizer-token"),
    body: { name: "Bad", code: "bad", nfc_behaviour: "fly" }
  });
  assert.equal(r.statusCode, 400, JSON.stringify(r.body));
});

test("Pass types: vendor cannot list pass types (403)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "GET",
    path: `/organizer/events/${EVENT_ID}/pass-types`,
    headers: bearer("vendor-token")
  });
  assert.equal(r.statusCode, 403, JSON.stringify(r.body));
});
