import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

const EVENT_ID = "event-demo";

test("Import staff: organizer can assign import-staff role (201)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/import-staff`,
    headers: bearer("organizer-token"),
    body: { user_id: "user-vendor" }
  });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.body.role, "organizer_import_staff");
  assert.equal(r.body.user_id, "user-vendor");
});

test("Import staff: organizer can revoke import-staff role (200)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/import-staff`,
    headers: bearer("organizer-token"),
    body: { user_id: "user-vendor" }
  });
  const r = await app.inject({
    method: "DELETE",
    path: `/organizer/events/${EVENT_ID}/import-staff/user-vendor`,
    headers: bearer("organizer-token")
  });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.body.ok, true);
});

test("Import staff: vendor cannot assign import-staff role (403)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/import-staff`,
    headers: bearer("vendor-token"),
    body: { user_id: "user-vendor" }
  });
  assert.equal(r.statusCode, 403);
});
