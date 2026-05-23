import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";
import { createSeedState } from "../src/store.mjs";

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

const EVENT_ID = "event-demo";

test("Attendee import: organizer can bulk-import attendees (201)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/attendees/import`,
    headers: bearer("organizer-token"),
    body: {
      rows: [
        { full_name: "Alice Chen", email: "alice@example.com", company_name: "ACME" },
        { full_name: "Bob Patel", email: "bob@example.com" },
        { full_name: "Carol Smith" }
      ]
    }
  });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.body.imported, 3);
  assert.equal(r.body.attendees.length, 3);
  assert.equal(r.body.attendees[0].registration_source, "bulk_import");
});

test("Attendee import: rejects empty rows array (400)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/attendees/import`,
    headers: bearer("organizer-token"),
    body: { rows: [] }
  });
  assert.equal(r.statusCode, 400);
});

test("Attendee import: rejects row missing full_name (400)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/attendees/import`,
    headers: bearer("organizer-token"),
    body: { rows: [{ email: "missing@name.com" }] }
  });
  assert.equal(r.statusCode, 400);
});

test("Attendee import: vendor cannot import (403)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/attendees/import`,
    headers: bearer("vendor-token"),
    body: { rows: [{ full_name: "Hacker" }] }
  });
  assert.equal(r.statusCode, 403);
});

test("Attendee import: each imported attendee has a profile", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/attendees/import`,
    headers: bearer("organizer-token"),
    body: { rows: [{ full_name: "David Lee", email: "d@lee.com", company_name: "Lee Co" }] }
  });
  assert.equal(r.statusCode, 201);
  const att = r.body.attendees[0];
  assert.ok(att.profile, "profile should be present");
  assert.equal(att.profile.full_name, "David Lee");
  assert.equal(att.profile.email, "d@lee.com");
});

test("Attendee import: platform admin can also import (201)", async () => {
  const state = createSeedState();
  const app = await createApp({ state });
  const r = await app.inject({
    method: "POST",
    path: `/organizer/events/${EVENT_ID}/attendees/import`,
    headers: bearer("platform-token"),
    body: { rows: [{ full_name: "Emma Wilson" }] }
  });
  assert.equal(r.statusCode, 201);
  assert.equal(r.body.imported, 1);
});
