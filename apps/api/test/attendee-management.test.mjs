import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

const EVENT_ID = "event-demo";

test("Attendees: GET /organizer/events/:id/attendees returns 200 with array", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "GET",
    path: `/organizer/events/${EVENT_ID}/attendees`,
    headers: bearer("organizer-token")
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body), "response must be an array");
});

test("Attendees: POST walk-in creates attendee (201)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/attendees`,
    headers: bearer("organizer-token"),
    body: {
      full_name: "Test Walkin",
      email: "walkin@test.com",
      company_name: "Test Co",
      age_confirmed_18_plus: true
    }
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.body));
  const d = r.body;
  assert.ok(d.id.startsWith("att-"), `id must have att- prefix, got: ${d.id}`);
  assert.equal(d.registration_source, "walk_in");
  assert.equal(d.age_confirmed_18_plus, true);
  assert.equal(d.profile.full_name, "Test Walkin");
  assert.equal(d.event_id, EVENT_ID);
});

test("Attendees: POST walk-in requires full_name (400)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/attendees`,
    headers: bearer("organizer-token"),
    body: { email: "missing@name.com" }
  });
  assert.equal(r.statusCode, 400, JSON.stringify(r.body));
});

test("Attendees: vendor cannot list attendees (403)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "GET",
    path: `/organizer/events/${EVENT_ID}/attendees`,
    headers: bearer("vendor-token")
  });
  assert.equal(r.statusCode, 403, JSON.stringify(r.body));
});

test("Attendees: created walk-in appears in list", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/attendees`,
    headers: bearer("organizer-token"),
    body: { full_name: "Listed Person", email: "listed@test.com" }
  });
  const r = await app.inject({
    method: "GET",
    path: `/organizer/events/${EVENT_ID}/attendees`,
    headers: bearer("organizer-token")
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  const found = r.body.find((a) => a.profile?.full_name === "Listed Person");
  assert.ok(found, "created walk-in must appear in list");
});
