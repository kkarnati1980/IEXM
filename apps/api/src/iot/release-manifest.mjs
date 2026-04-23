import { readFileSync } from "node:fs";

export function loadReleaseManifest(options = {}) {
  if (options.releaseManifest) {
    return options.releaseManifest;
  }

  const path = options.releaseManifestPath ?? process.env.IOT_RELEASE_MANIFEST_PATH;
  if (!path) {
    return null;
  }

  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}

export function selectIntegrationManifest(manifest, integrationName = "iot_platform") {
  if (!manifest) {
    return null;
  }
  const selected = manifest[integrationName];
  if (!selected) {
    return null;
  }
  return {
    release_id: manifest.release_id ?? null,
    approved: manifest.approved ?? null,
    platform_owner_handle: manifest.platform_owner_handle ?? null,
    iot_owner_handle: manifest.iot_owner_handle ?? null,
    ...selected
  };
}
