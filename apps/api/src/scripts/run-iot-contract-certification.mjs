import { createIotPlatformAdapter } from "../iot/platform-adapter.mjs";
import { createIotContractCertificationRunner } from "../iot/contract-certification-runner.mjs";

const adapter = createIotPlatformAdapter({
  baseUrl: process.env.IOT_BASE_URL,
  authToken: process.env.IOT_AUTH_TOKEN ?? null,
  expectedContractVersion: process.env.IOT_EXPECTED_CONTRACT_VERSION ?? "2026-04-17.1",
  expectedEnvironment: process.env.IOT_EXPECTED_ENVIRONMENT ?? "staging"
});

const runner = createIotContractCertificationRunner({ adapter });
const summary = await runner.run();
console.log(JSON.stringify(summary, null, 2));

if (summary.status !== "passed") {
  process.exitCode = 1;
}
