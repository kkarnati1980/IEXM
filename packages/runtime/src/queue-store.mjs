import { createHash } from "node:crypto";

function canonicalize(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function checksumFor(payload) {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

export function createQueueStore() {
  return {
    lastSequence: 0,
    items: []
  };
}

export function appendQueueItem(store, payload) {
  const queue_sequence_number = store.lastSequence + 1;
  const item = {
    queue_sequence_number,
    payload,
    sync_status: "queued",
    retry_count: 0,
    checksum: checksumFor(payload)
  };
  store.lastSequence = queue_sequence_number;
  store.items.push(item);
  return item;
}

export function classifyQueueItem(item) {
  const current = checksumFor(item.payload);
  if (current !== item.checksum) {
    return "corrupt";
  }
  return item.sync_status;
}

export function markQueueItemSynced(store, queueSequence) {
  const item = store.items.find((entry) => entry.queue_sequence_number === queueSequence);
  if (!item) {
    return null;
  }
  item.sync_status = "synced";
  return item;
}

export function markQueueItemRetryable(store, queueSequence) {
  const item = store.items.find((entry) => entry.queue_sequence_number === queueSequence);
  if (!item) {
    return null;
  }
  item.sync_status = "failed_retryable";
  item.retry_count += 1;
  return item;
}

export function detectCorruption(store) {
  return store.items.filter((item) => classifyQueueItem(item) === "corrupt");
}

export function getReplayableQueueItems(store) {
  return store.items
    .filter((item) => {
      const status = classifyQueueItem(item);
      return status === "queued" || status === "failed_retryable";
    })
    .sort((left, right) => left.queue_sequence_number - right.queue_sequence_number);
}
