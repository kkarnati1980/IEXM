import { readFile } from "node:fs/promises";

import { summarizeControls, validateProductionEnvironment } from "../deployment-readiness.mjs";

const env = {
  ...process.env,
  ...(await loadEnvFile(process.argv[2]))
};

const controls = validateProductionEnvironment(env, {
  backend: env.REPOSITORY_BACKEND,
  securityMode: env.APP_SECURITY_MODE,
  allowSeedTokens: env.AUTH_ALLOW_SEED_TOKENS === "true",
  securityHeadersEnabled: env.SECURITY_HEADERS_ENABLED === "true",
  databaseSsl: env.DATABASE_SSL === "true",
  databaseSslRejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false",
  oidcEnabled: env.OIDC_ENABLED === "true"
});
const summary = summarizeControls(controls);
const failures = controls.filter((control) => control.status === "fail");

console.log(JSON.stringify({
  ready: failures.length === 0,
  summary,
  failures,
  manual_gates: controls.filter((control) => control.status === "manual")
}, null, 2));

if (failures.length) {
  process.exitCode = 1;
}

async function loadEnvFile(filePath) {
  if (!filePath) {
    return {};
  }
  const content = await readFile(filePath, "utf8");
  const parsed = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1");
    parsed[key] = value;
  }
  return parsed;
}
