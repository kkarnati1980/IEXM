import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureNames = [
  "assignment-active.json",
  "credential-provisioned.json",
  "tap-card-uid-online.json",
  "tap-phone-ndef-offline-replay.json",
  "tap-duplicate-replay.json",
  "heartbeat-degraded.json",
  "incident-reader-disconnected.json",
  "error-assignment-scope-violation.json"
];

function payloadDir() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "../../../../docs/iot-platform-integration/payload-pack");
}

export async function loadMockFixturePack() {
  const dir = payloadDir();
  const entries = await Promise.all(
    fixtureNames.map(async (name) => {
      const contents = await readFile(path.join(dir, name), "utf8");
      return [name, JSON.parse(contents)];
    })
  );

  return Object.fromEntries(entries);
}

export function buildMockIotState(fixtures, metadata) {
  const assignmentA1 = fixtures["assignment-active.json"].assignment;
  const assignmentA2 = {
    ...assignmentA1,
    device_id: "device-02",
    stall_id: "stall-a2"
  };

  const credentials = new Map();
  const provisioned = fixtures["credential-provisioned.json"];
  credentials.set(provisioned.credential_id, {
    credential_id: provisioned.credential_id,
    device_id: provisioned.device_id,
    bearer_token: provisioned.bearer_token,
    issued_at: provisioned.issued_at,
    status: "active"
  });

  const tapItems = [
    ...fixtures["tap-card-uid-online.json"].items,
    ...fixtures["tap-phone-ndef-offline-replay.json"].items,
    ...fixtures["tap-duplicate-replay.json"].items
  ].sort((left, right) => left.stream_cursor.localeCompare(right.stream_cursor));

  const heartbeatItems = [...fixtures["heartbeat-degraded.json"].items];
  const incidentItems = [...fixtures["incident-reader-disconnected.json"].items];

  return {
    metadata,
    assignments: new Map([
      [assignmentA1.device_id, assignmentA1],
      [assignmentA2.device_id, assignmentA2]
    ]),
    credentials,
    taps: tapItems,
    heartbeats: heartbeatItems,
    incidents: incidentItems
  };
}

