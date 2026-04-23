import test from "node:test";
import assert from "node:assert/strict";

import {
  appendQueueItem,
  createQueueStore,
  detectCorruption,
  getReplayableQueueItems,
  markQueueItemRetryable,
  markQueueItemSynced
} from "../src/queue-store.mjs";

test("queue preserves append order for replay", () => {
  const store = createQueueStore();
  appendQueueItem(store, { local_event_id: "a" });
  appendQueueItem(store, { local_event_id: "b" });
  appendQueueItem(store, { local_event_id: "c" });

  const replay = getReplayableQueueItems(store).map((item) => item.payload.local_event_id);
  assert.deepEqual(replay, ["a", "b", "c"]);
});

test("synced items are excluded from replay", () => {
  const store = createQueueStore();
  appendQueueItem(store, { local_event_id: "a" });
  appendQueueItem(store, { local_event_id: "b" });
  markQueueItemSynced(store, 1);
  markQueueItemRetryable(store, 2);

  const replay = getReplayableQueueItems(store).map((item) => item.queue_sequence_number);
  assert.deepEqual(replay, [2]);
});

test("corruption is detected via checksum", () => {
  const store = createQueueStore();
  const item = appendQueueItem(store, { local_event_id: "a", tap_type: "phone_ndef" });
  item.payload.tap_type = "qr";

  const corruption = detectCorruption(store);
  assert.equal(corruption.length, 1);
  assert.equal(corruption[0].queue_sequence_number, 1);
});
