import test from "node:test";
import assert from "node:assert/strict";

import { createSeedState } from "../src/store.mjs";
import { createMemoryRepositories } from "../src/repositories/memory.mjs";
import { runEmailDeliveryBatchOnce } from "../src/jobs/email-delivery-worker.mjs";

const TEST_ENV = {
  SENDGRID_API_KEY: "test-sg-key",
  EMAIL_FROM: "noreply@test.example"
};

function makeTransactionalNotification(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "notif-email-test-1",
    tenant_id: "tenant-demo",
    event_id: null,
    interaction_id: null,
    channel: "email",
    message_type: "user_invite",
    status: "queued",
    provider: null,
    recipient_hash: "deadbeef",
    system_payload: {
      recipient_email: "invitee@example.com",
      subject: "You have been invited",
      body: "<p>Click here to accept</p>"
    },
    consent_checked_at: null,
    sending_started_at: null,
    last_attempt_at: null,
    next_attempt_at: null,
    attempts_count: 0,
    provider_message_id: null,
    final_error: null,
    retry_exhausted_at: null,
    retry_exhausted_reason: null,
    created_by_user_id: null,
    approved_by_user_id: null,
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

test("email delivery worker: 202 response marks notification sent", async (t) => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);
  const notification = makeTransactionalNotification();
  state.notifications.push(notification);

  t.mock.method(globalThis, "fetch", async () => ({ status: 202 }));

  await runEmailDeliveryBatchOnce(repos, state, TEST_ENV);

  const updated = state.notifications.find((n) => n.id === notification.id);
  assert.equal(updated.status, "sent");
  assert.equal(updated.provider, "sendgrid");
  assert.equal(updated.attempts_count, 1);
  assert.ok(updated.last_attempt_at);
});

test("email delivery worker: 500 response three times marks notification dead_letter", async (t) => {
  const state = createSeedState();
  const repos = createMemoryRepositories(state);
  const notification = makeTransactionalNotification();
  state.notifications.push(notification);

  t.mock.method(globalThis, "fetch", async () => ({ status: 500 }));

  // Three poll cycles simulate three delivery attempts
  await runEmailDeliveryBatchOnce(repos, state, TEST_ENV);
  await runEmailDeliveryBatchOnce(repos, state, TEST_ENV);
  await runEmailDeliveryBatchOnce(repos, state, TEST_ENV);

  const updated = state.notifications.find((n) => n.id === notification.id);
  assert.equal(updated.status, "dead_letter");
  assert.equal(updated.attempts_count, 3);
  assert.match(updated.final_error, /SendGrid returned HTTP 500/);
});
