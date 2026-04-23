import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSign, generateKeyPairSync } from "node:crypto";
import { chromium } from "playwright-core";

import { createApp } from "../../api/src/app.mjs";
import { createSeedState } from "../../api/src/store.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const webRoot = join(__dirname, "..");
const chromeExecutable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("Browser E2E covers attendee, vendor, organizer, sponsor, and admin dashboard flows", { timeout: 30000 }, async () => {
  const oidc = createMockOidcIssuer();
  const app = await createApp({
    state: createSecureBrowserState(oidc.issuer),
    securityMode: "secure",
    sessionSecret: "browser-e2e-session-secret",
    oidc: {
      enabled: true,
      issuer: oidc.issuer,
      audience: oidc.audience,
      clientId: "browser-e2e-web"
    }
  });
  const server = await createBridgeServer(app);
  const browser = await chromium.launch({
    executablePath: chromeExecutable,
    headless: true,
    args: ["--no-sandbox"]
  });

  try {
    const seeded = await seedPhase3DemoData(app);

    await runAttendeeFlow(browser, server.baseUrl, seeded, app, oidc);
    await runVendorFlow(browser, server.baseUrl, oidc);
    await runOrganizerFlow(browser, server.baseUrl, seeded, oidc);
    await runSponsorFlow(browser, server.baseUrl, oidc);
    await runAdminFlow(browser, server.baseUrl, oidc);
  } finally {
    await browser.close();
    await closeServer(server.server);
    await app.close();
    oidc.restore();
  }
});

async function runAttendeeFlow(browser, baseUrl, seeded, app, oidc) {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(
    `${baseUrl}/attendee.html?interactionId=${encodeURIComponent(seeded.vendorGrantedInteractionId)}&token=${encodeURIComponent(seeded.vendorGrantedSessionToken)}`,
    { waitUntil: "domcontentloaded" }
  );

  await page.getByLabel("Allow sponsor follow-up").check();
  await page.getByRole("button", { name: "Save consent and profile" }).click();
  await page.waitForSelector("text=Saved. Consent status is now vendor_and_sponsor.");
  await page.waitForSelector("text=Vendor and sponsor");
  await page.waitForSelector("text=Consent evidence records");
  await page.waitForSelector("text=Latest evidence");

  const [sponsorOptOutResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/consents/revoke") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Opt out from sponsor only" }).click()
  ]);
  assert.equal(sponsorOptOutResponse.status(), 200);
  await page.waitForSelector("text=Sponsor follow-up disabled. Current status: vendor_only.");
  await page.waitForSelector("text=Vendor only");
  const [walletPassResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/wallet-pass") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Request wallet pass" }).click()
  ]);
  assert.equal(walletPassResponse.status(), 201);
  await page.waitForSelector("text=Wallet pass request recorded. Status: Safely disabled.");
  await page.waitForSelector("text=Wallet pass request");

  const [accessRequestResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/dsr") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Request my data/export" }).click()
  ]);
  assert.equal(accessRequestResponse.status(), 201);
  const accessRequest = await accessRequestResponse.json();
  await page.waitForSelector("text=Data/export request submitted. Status: requested.");
  await page.waitForSelector("text=Data/export request");
  const completedAccess = await app.inject({
    method: "POST",
    path: `/organizer/events/event-demo/dsr/${accessRequest.id}/complete`,
    headers: bearer(oidc.createToken({
      subject: "web-organizer",
      email: "organizer@example.com"
    })),
    body: {
      resolution_summary: "Browser attendee self-service export request prepared."
    }
  });
  assert.equal(completedAccess.statusCode, 200);
  assert.equal(await page.getByRole("button", { name: "Request deletion" }).isEnabled(), true);
  await page.close();
}

async function runAdminFlow(browser, baseUrl, oidc) {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await seedBrowserSession(page, baseUrl, "primary", oidc.createToken({
    subject: "web-platform-1",
    email: "platform1@example.com"
  }));
  await page.goto(`${baseUrl}/admin.html`, {
    waitUntil: "domcontentloaded"
  });

  await page.waitForSelector("text=IAM admin refreshed.");
  await page.waitForSelector("text=Managed users");
  await page.waitForSelector("text=registered route permissions covered by the matrix");
  await page.waitForSelector("text=pen-test readiness status");
  await page.waitForSelector("text=environment configuration");
  await page.waitForSelector("text=blocking pen-test findings");
  await page.waitForSelector("text=Final go-live blocked");
  await page.locator("#create-email").fill("browser-admin-vendor@example.com");
  await page.locator("#create-display-name").fill("Browser Admin Vendor");
  await page.locator("#create-role").selectOption("vendor_manager");
  await page.locator("#create-organization").selectOption("org-vendor");
  const [createUserResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/admin/users") &&
      response.request().method() === "POST" &&
      !response.url().includes("/access-scopes")
    ),
    page.getByRole("button", { name: "Create user" }).click()
  ]);
  assert.equal(createUserResponse.status(), 201);
  await page.waitForSelector("text=IAM user created:");
  await page.locator("#directory-rows tr").filter({ hasText: "browser-admin-vendor@example.com" }).first().click();
  await page.waitForSelector("text=Status: pending invite");

  await page.locator("#update-display-name").fill("Browser Admin Vendor Updated");
  await page.locator("#update-provider").fill("https://issuer.example.com");
  await page.locator("#update-subject").fill("browser-admin-vendor");
  const [saveUserResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/admin/users/") && response.request().method() === "PATCH"
    ),
    page.getByRole("button", { name: "Save user changes" }).click()
  ]);
  assert.equal(saveUserResponse.status(), 200);
  await page.waitForSelector("text=IAM user changes saved.");
  await page.waitForSelector("text=Identity linked: Yes");

  const [activateResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/activate") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Activate user" }).click()
  ]);
  assert.equal(activateResponse.status(), 200);
  await page.waitForSelector("text=User activated.");
  await page.waitForSelector("text=Status: active");

  await page.locator("#action-reason").fill("Browser IAM hold");
  const [disableResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/disable") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Disable user" }).click()
  ]);
  assert.equal(disableResponse.status(), 200);
  await page.waitForSelector("text=User disabled.");
  await page.waitForSelector("text=Status: disabled");

  const [reactivateResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/activate") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Activate user" }).click()
  ]);
  assert.equal(reactivateResponse.status(), 200);
  await page.waitForSelector("text=User activated.");

  await page.locator("#scope-event").selectOption("event-demo");
  await page.locator("#scope-stall").selectOption("stall-a1");
  const [assignScopeResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/access-scopes") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Assign scope" }).click()
  ]);
  assert.equal(assignScopeResponse.status(), 201);
  await page.waitForSelector("text=Access scope assigned.");
  await page.waitForSelector("#scope-list .revoke-scope");
  await page.waitForFunction(() => {
    const text = document.querySelector("#scope-list")?.textContent || "";
    return text.includes("Northfield Estates") && text.includes("Revoke scope");
  });
  await page.waitForSelector("text=admin.user_scope.assigned");

  const [revokeScopeResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/access-scopes/") && response.request().method() === "DELETE"
    ),
    page.getByRole("button", { name: "Revoke scope" }).click()
  ]);
  assert.equal(revokeScopeResponse.status(), 200);
  await page.waitForSelector("text=Access scope revoked.");

  await page.locator("#action-reason").fill("Browser IAM delete");
  const [deleteResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/delete") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Delete user" }).click()
  ]);
  assert.equal(deleteResponse.status(), 200);
  await page.waitForSelector("text=User deleted.");
  await page.waitForSelector("text=Status: deleted");
  await page.waitForSelector("text=admin.user.deleted");
  await page.close();
}

async function runVendorFlow(browser, baseUrl, oidc) {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await seedBrowserSession(page, baseUrl, "primary", oidc.createToken({
    subject: "web-vendor",
    email: "vendor@example.com"
  }));
  await page.goto(`${baseUrl}/vendor.html?stallId=stall-a1`, {
    waitUntil: "domcontentloaded"
  });

  await page.waitForSelector("text=Loaded 2 leads.");
  await page.locator("#lead-rows tr").filter({ hasText: "Ava Vendor" }).first().click();
  await page.locator("#detail-body").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const title = document.querySelector("#detail-title")?.textContent || "";
    const meta = document.querySelector("#detail-meta")?.textContent || "";
    return title.includes("Ava Vendor") && meta.includes("CRM eligibility");
  });

  await page.locator("#classification").selectOption("hot");
  assert.equal(await page.locator("#classification").inputValue(), "hot");
  const [classifyResponse, leadsReloadResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/classify") && response.request().method() === "POST"
    ),
    page.waitForResponse((response) =>
      response.url().includes("/stalls/stall-a1/leads") && response.request().method() === "GET"
    ),
    page.getByRole("button", { name: "Save classification" }).click()
  ]);
  assert.equal(classifyResponse.status(), 200);
  const classifyPayload = await classifyResponse.json();
  assert.equal(classifyPayload.classification, "hot");
  assert.equal(leadsReloadResponse.status(), 200);
  await page.waitForFunction(() => {
    const rows = Array.from(document.querySelectorAll("#lead-rows tr"));
    return rows.some((row) => {
      const text = row.textContent || "";
      return text.includes("Ava Vendor") && text.includes("Hot");
    });
  });

  await page.locator("#new-note").fill("Browser E2E note");
  const [noteResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/note") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Add note" }).click()
  ]);
  assert.equal(noteResponse.status(), 200);
  await page.waitForSelector("text=Browser E2E note");
  await page.waitForSelector("text=Email follow-up consent");
  await page.locator("#followup-subject").fill("Browser follow-up");
  await page.locator("#followup-body").fill("Browser approved follow-up");
  await page.locator("#followup-approved").check();
  const [followupResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/followups") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Queue approved follow-up" }).click()
  ]);
  assert.equal(followupResponse.status(), 201);
  await page.waitForSelector("text=Follow-up queued.");
  await page.waitForSelector("text=Email follow-up: Queued");
  const [crmSyncResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/crm-sync") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Sync to pilot CRM" }).click()
  ]);
  assert.equal(crmSyncResponse.status(), 200);
  await page.waitForSelector("text=Lead synced to CRM");
  await page.waitForSelector("text=Synced (");
  await page.close();
}

async function runSponsorFlow(browser, baseUrl, oidc) {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await seedBrowserSession(page, baseUrl, "primary", oidc.createToken({
    subject: "web-organizer",
    email: "organizer@example.com"
  }));
  await page.goto(`${baseUrl}/sponsor.html?eventId=event-demo&sponsorId=org-sponsor`, {
    waitUntil: "domcontentloaded"
  });

  await page.waitForSelector("text=Sponsor dashboard refreshed.");
  await page.waitForFunction(() => document.querySelector("#metric-impressions")?.textContent?.trim() === "2");
  await page.waitForSelector("text=Raw attendee PII remains hidden");
  await page.locator("#snapshot-note").fill("Browser sponsor snapshot");
  const [snapshotResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/report-snapshots") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Publish snapshot" }).click()
  ]);
  assert.equal(snapshotResponse.status(), 201);
  await page.waitForSelector("text=Sponsor snapshot published.");
  await page.waitForSelector("text=Browser sponsor snapshot");
  const [requestExportResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/exports/request") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Request snapshot export" }).click()
  ]);
  assert.equal(requestExportResponse.status(), 200);
  await page.waitForSelector("text=Sponsor snapshot export requested.");
  await page.waitForSelector("text=requested");
  await page.close();
}

async function runOrganizerFlow(browser, baseUrl, seeded, oidc) {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  await seedBrowserSession(page, baseUrl, "primary", oidc.createToken({
    subject: "web-organizer",
    email: "organizer@example.com"
  }));
  await seedBrowserSession(page, baseUrl, "admin", oidc.createToken({
    subject: "web-platform-1",
    email: "platform1@example.com"
  }));
  await page.goto(`${baseUrl}/organizer.html?eventId=event-demo`, {
    waitUntil: "domcontentloaded"
  });

  await page.waitForSelector("text=Organizer data refreshed.");
  await page.waitForSelector("text=Total interactions");
  await page.waitForSelector("text=Pilot ready");
  await page.waitForSelector("text=Pilot rehearsal blocked");
  await page.waitForSelector("text=Pilot signoff blocked");
  await page.waitForSelector("text=Joint pilot go-live blocked");
  await page.waitForSelector("text=reader_disconnect");
  await page.locator("#incident-rows tr").filter({ hasText: "reader_disconnect" }).first().click();
  await page.waitForSelector("text=Reader disconnected during browser E2E");
  await page.waitForSelector("text=Fleet status: matched / degraded");
  await page.waitForSelector("text=Linked alerts: 1");
  await page.waitForSelector("text=Focus audit trail");
  await page.waitForSelector("text=Heartbeat");
  await page.locator("#incident-action-note-input").fill("Escalating to event ops after repeated disconnects");
  const [escalateResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/state") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Escalate incident" }).click()
  ]);
  assert.equal(escalateResponse.status(), 200);
  await page.waitForSelector("text=Incident escalated.");
  await page.waitForSelector("text=Status: escalated");
  await page.locator("#runbook-reference-input").fill("RUNBOOK-BROWSER-7");
  await page.locator("#workaround-status-input").selectOption("active");
  await page.locator("#workaround-summary-input").fill("Swapped to spare reader and locked the cable path");
  await page.locator("#incident-next-action-input").fill("Monitor the next tap burst");
  const [runbookResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/runbook") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Save runbook tracking" }).click()
  ]);
  assert.equal(runbookResponse.status(), 200);
  await page.waitForSelector("text=Runbook tracking saved.");
  await page.waitForSelector("text=Runbook: RUNBOOK-BROWSER-7");
  await page.waitForSelector("text=Workaround status: active");
  await page.locator("#incident-note-input").fill("Operator switched to spare cable");
  const [incidentNoteResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/annotations") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Save incident note" }).click()
  ]);
  assert.equal(incidentNoteResponse.status(), 200);
  await page.waitForSelector("text=Incident note saved.");
  await page.waitForSelector("text=Operator switched to spare cable");
  await page.locator("#incident-action-note-input").fill("Recovered cleanly after workaround monitoring");
  const [resolveResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/state") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Resolve incident" }).click()
  ]);
  assert.equal(resolveResponse.status(), 200);
  await page.waitForSelector("text=Incident resolved.");
  await page.waitForSelector("text=Status: resolved");
  const [requestExportResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/exports/request") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Request export" }).click()
  ]);
  assert.equal(requestExportResponse.status(), 200);
  await page.waitForSelector("text=Export requested: Vendor leads.");
  await page.locator("#export-rows tr").filter({ hasText: "Vendor leads" }).first().click();
  await page.waitForSelector("text=Status: requested");
  const [approveExportResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/approve") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Approve export" }).click()
  ]);
  assert.equal(approveExportResponse.status(), 200);
  await page.waitForSelector("text=Export approved and signed link generated.");
  await page.waitForSelector("text=Status: generated");
  await page.waitForSelector("text=Open signed export link");
  await page.locator("#break-glass-justification").fill("Browser E2E trust investigation");
  const [requestBreakGlassResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/break-glass/request") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Request access" }).click()
  ]);
  assert.equal(requestBreakGlassResponse.status(), 200);
  await page.waitForSelector("text=Break-glass requested:");
  await page.waitForSelector("text=Browser E2E trust investigation");
  await seedBrowserSession(page, baseUrl, "admin", oidc.createToken({
    subject: "web-platform-2",
    email: "platform2@example.com"
  }));
  const [firstBreakGlassApproval] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/break-glass/") && response.url().includes("/approve") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Approve step" }).click()
  ]);
  assert.equal(firstBreakGlassApproval.status(), 200);
  await page.waitForSelector("text=Break-glass approval recorded: partially_approved.");
  await page.waitForSelector("text=Status: partially_approved");
  await seedBrowserSession(page, baseUrl, "admin", oidc.createToken({
    subject: "web-platform-3",
    email: "platform3@example.com"
  }));
  const [secondBreakGlassApproval] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/break-glass/") && response.url().includes("/approve") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Approve step" }).click()
  ]);
  assert.equal(secondBreakGlassApproval.status(), 200);
  await page.waitForSelector("text=Break-glass approval recorded: active.");
  await page.waitForSelector("text=Status: active");
  await page.waitForSelector("text=Wallet pass provider: Disabled");
  await page.waitForSelector("text=Email notification provider: Disabled");
  await page.waitForSelector("text=attendee session");
  const [shortLinkRevokeResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/short-links/") &&
      response.url().includes("/revoke") &&
      response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Revoke link" }).first().click()
  ]);
  assert.equal(shortLinkRevokeResponse.status(), 200);
  await page.waitForSelector("text=Signed link revoked.");
  await page.locator("tbody tr").filter({ hasText: "Ava Vendor" }).first().click();
  await page.waitForSelector("text=CRM eligibility: Eligible");
  await page.waitForSelector("text=CRM sync: Synced");
  await page.waitForSelector("text=Browser E2E note");
  await page.waitForSelector("text=Disabled wallet pass");
  const [walletRetryResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/wallet-passes/") &&
      response.url().includes("/retry") &&
      response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Retry wallet pass" }).click()
  ]);
  assert.equal(walletRetryResponse.status(), 200);
  await page.waitForSelector("text=Wallet pass retry recorded.");
  const [walletCancelResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/wallet-passes/") &&
      response.url().includes("/status") &&
      response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Cancel wallet pass" }).click()
  ]);
  assert.equal(walletCancelResponse.status(), 200);
  await page.waitForSelector("text=Wallet pass marked cancelled.");
  await page.waitForSelector("text=Cancelled wallet pass");
  await page.waitForSelector("text=wallet_pass.status.updated");
  await page.waitForSelector("text=Email follow-up: Queued");
  const [failedAttemptResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/notifications/") &&
      response.url().includes("/attempts") &&
      response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Mark failed" }).click()
  ]);
  assert.equal(failedAttemptResponse.status(), 201);
  await page.waitForSelector("text=Notification marked failed.");
  await page.waitForSelector("text=Email follow-up: Failed");
  await page.waitForSelector("text=Attempts: 1");
  const [resendResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/notifications/") &&
      response.url().includes("/resend") &&
      response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Resend" }).click()
  ]);
  assert.equal(resendResponse.status(), 200);
  await page.waitForSelector("text=Notification requeued for resend.");
  await page.waitForSelector("text=Email follow-up: Queued");
  const [cancelResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/notifications/") &&
      response.url().includes("/cancel") &&
      response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Cancel" }).click()
  ]);
  assert.equal(cancelResponse.status(), 200);
  await page.waitForSelector("text=Notification cancelled.");
  await page.waitForSelector("text=Email follow-up: Cancelled");
  await page.locator("#dsr-type").selectOption("access");
  await page.locator("#dsr-interaction-id").fill(seeded.vendorGrantedInteractionId);
  await page.locator("#dsr-reason").fill("Browser attendee access request");
  const [createDsrResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/organizer/events/event-demo/dsr") &&
      response.request().method() === "POST" &&
      !response.url().includes("/complete")
    ),
    page.getByRole("button", { name: "Create DSR" }).click()
  ]);
  assert.equal(createDsrResponse.status(), 201);
  await page.waitForSelector("text=DSR created:");
  await page.waitForSelector("text=Browser attendee access request");
  const [completeDsrResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/complete") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Prepare access package" }).click()
  ]);
  assert.equal(completeDsrResponse.status(), 200);
  await page.waitForSelector("text=Access package prepared.");
  await page.waitForSelector("text=Status: completed");
  await page.locator("#dsr-type").selectOption("delete");
  await page.locator("#dsr-interaction-id").fill(seeded.vendorGrantedInteractionId);
  await page.locator("#dsr-reason").fill("Browser attendee delete request");
  const [createDeleteDsrResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/organizer/events/event-demo/dsr") &&
      response.request().method() === "POST" &&
      !response.url().includes("/complete")
    ),
    page.getByRole("button", { name: "Create DSR" }).click()
  ]);
  assert.equal(createDeleteDsrResponse.status(), 201);
  await page.waitForSelector("text=Browser attendee delete request");
  await page.locator("#dsr-resolution-summary").fill("Delete request propagated to pilot CRM.");
  await page.locator("#dsr-downstream-targets").fill("crm");
  const [completeDeleteDsrResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/complete") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Complete delete workflow" }).click()
  ]);
  assert.equal(completeDeleteDsrResponse.status(), 200);
  await page.waitForSelector("text=Delete workflow completed.");
  const [dispatchDeleteResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/dispatch") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Dispatch CRM delete" }).click()
  ]);
  assert.equal(dispatchDeleteResponse.status(), 200);
  await page.waitForSelector("text=CRM downstream deletion dispatched.");
  await page.waitForSelector("text=CRM sync: Deleted");
  await page.waitForSelector("text=Compliance Reporting");
  const [complianceExportResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/compliance/audit-export") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Request compliance audit export" }).click()
  ]);
  assert.equal(complianceExportResponse.status(), 200);
  await page.waitForSelector("text=Compliance audit export requested.");
  await page.waitForSelector("text=Compliance audit export");
  await page.waitForSelector("text=Compliance closeout blocked");
  await page.locator("#report-freeze-note").fill("Browser organizer closeout");
  const [freezeResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/report-freeze") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Freeze official report" }).click()
  ]);
  assert.equal(freezeResponse.status(), 200);
  await page.waitForSelector("text=Official event report frozen and final export generated.");
  await page.waitForSelector("text=Official report frozen");
  const [previewRetentionResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/compliance/retention") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Preview retention" }).click()
  ]);
  assert.equal(previewRetentionResponse.status(), 200);
  await page.waitForSelector("text=Retention preview ready:");
  await page.locator("#export-rows tr").filter({ hasText: "Compliance audit export" }).first().click();
  const [approveComplianceExportResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/approve") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Approve export" }).click()
  ]);
  assert.equal(approveComplianceExportResponse.status(), 200);
  await page.waitForSelector("text=Compliance closeout ready");
  const [refreshRehearsalResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/pilot-rehearsal-report") && response.request().method() === "GET"
    ),
    page.getByRole("button", { name: "Refresh rehearsal report" }).click()
  ]);
  assert.equal(refreshRehearsalResponse.status(), 200);
  await page.waitForSelector("text=Pilot rehearsal ready");
  const [refreshSignoffResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/pilot-signoff-pack") && response.request().method() === "GET"
    ),
    page.getByRole("button", { name: "Refresh signoff pack" }).click()
  ]);
  assert.equal(refreshSignoffResponse.status(), 200);
  await page.waitForSelector("text=Pilot signoff ready");
  const [signoffExportResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/pilot-signoff-export") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Request pilot signoff export" }).click()
  ]);
  assert.equal(signoffExportResponse.status(), 200);
  await page.waitForSelector("text=Pilot signoff export requested.");
  await page.waitForSelector("text=Pilot signoff export");
  await page.locator("#dry-run-status").selectOption("completed");
  await page.locator("#dry-run-all-checks").check();
  await page.locator("#dry-run-note").fill("Browser E2E staging dry run");
  const [dryRunResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/pilot-go-live-dry-run") && response.request().method() === "POST"
    ),
    page.getByRole("button", { name: "Record dry run" }).click()
  ]);
  assert.equal(dryRunResponse.status(), 200);
  await page.waitForSelector("text=Pilot go-live dry run recorded.");

  for (const [role, label] of [
    ["organizer", "Morgan Organizer"],
    ["platform", "Platform owner"],
    ["iot", "IoT owner"]
  ]) {
    await page.locator("#approval-role").selectOption(role);
    await page.locator("#approval-label").fill(label);
    await page.locator("#approval-status").selectOption("approved");
    await page.locator("#approval-note").fill(`${label} approved the browser dry run`);
    const [approvalResponse] = await Promise.all([
      page.waitForResponse((response) =>
        response.url().includes("/pilot-go-live-approvals") && response.request().method() === "POST"
      ),
      page.getByRole("button", { name: "Record approval" }).click()
    ]);
    assert.equal(approvalResponse.status(), 200);
  }
  const [refreshExecutionResponse] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/pilot-go-live-execution") && response.request().method() === "GET"
    ),
    page.getByRole("button", { name: "Refresh joint execution" }).click()
  ]);
  assert.equal(refreshExecutionResponse.status(), 200);
  await page.waitForSelector("text=Browser E2E staging dry run");
  await page.waitForSelector("text=Organizer: approved");
  await page.waitForSelector("text=Platform: approved");
  await page.waitForSelector("text=Iot: approved");
  await page.close();
}

async function seedPhase3DemoData(app) {
  const grantedTap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("dvc_seed_device_01"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "phase3-ui-granted",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-18T12:00:00Z"
    }
  });
  assert.equal(grantedTap.statusCode, 201);

  const grantedConsent = await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: grantedTap.body.attendee_session_token,
      vendor_release_allowed: true,
      sponsor_release_allowed: false,
      communication_channel_consents: {
        email: true
      },
      attendee_profile: {
        full_name: "Ava Vendor",
        company_name: "Northfield Estates",
        email: "ava@example.com",
        phone: "+91-90000-00001"
      }
    }
  });
  assert.equal(grantedConsent.statusCode, 200);
  app.state.interactions[0].sponsor_click_count = 2;

  const pendingTap = await app.inject({
    method: "POST",
    path: "/interactions/tap",
    headers: bearer("dvc_seed_device_01"),
    body: {
      device_id: "device-01",
      event_id: "event-demo",
      stall_id: "stall-a1",
      local_event_id: "phase3-ui-masked",
      tap_type: "phone_ndef",
      occurred_at: "2026-04-18T12:01:00Z"
    }
  });
  assert.equal(pendingTap.statusCode, 201);

  const pendingConsent = await app.inject({
    method: "POST",
    path: "/consents/capture",
    body: {
      session_token: pendingTap.body.attendee_session_token,
      vendor_release_allowed: false,
      sponsor_release_allowed: false,
      attendee_profile: {
        full_name: "Maya Hidden",
        company_name: "Quiet Holdings",
        email: "maya@example.com",
        phone: "+91-90000-00002"
      }
    }
  });
  assert.equal(pendingConsent.statusCode, 200);
  app.state.interactions[1].sponsor_click_count = 1;

  await app.repos.iotCertificationStatuses.upsert({
    id: "cert-browser-1",
    integration_name: "iot_platform",
    status: "certified",
    contract_version: "2026-04-17.1",
    environment: "staging",
    build_version: "iot-mock-2026.04.17.1",
    last_checked_at: "2099-04-19T18:00:00Z",
    last_certified_at: "2099-04-19T18:00:00Z",
    last_failure_at: null,
    last_failure_message: null,
    metadata: {},
    created_at: "2099-04-19T18:00:00Z",
    updated_at: "2099-04-19T18:00:00Z"
  });
  await app.repos.iotIntegrationHealthStatuses.upsert({
    id: "health-browser-1",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    overall_status: "warning",
    certification_status: "certified",
    contract_version: "2026-04-17.1",
    environment: "staging",
    build_version: "iot-mock-2026.04.17.1",
    checked_at: "2099-04-19T18:00:00Z",
    stale_after_seconds: 7200,
    warnings: [
      {
        code: "DEVICE_DEGRADED",
        severity: "warning",
        message: "One device is degraded but still operational"
      }
    ],
    metrics: {
      degraded_devices: 1
    },
    created_at: "2099-04-19T18:00:00Z",
    updated_at: "2099-04-19T18:00:00Z"
  });
  await app.repos.iotEnvironmentParityStatuses.upsert({
    id: "parity-browser-1",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    status: "passed",
    staging_contract_version: "2026-04-17.1",
    staging_environment: "staging",
    staging_build_version: "iot-mock-2026.04.17.1",
    production_contract_version: "2026-04-17.1",
    production_environment: "production",
    production_build_version: "iot-mock-2026.04.17.1",
    issues: [],
    details: {
      release_id: "pilot-browser-e2e"
    },
    checked_at: "2099-04-19T18:00:00Z",
    created_at: "2099-04-19T18:00:00Z",
    updated_at: "2099-04-19T18:00:00Z"
  });
  await app.repos.iotIntegrationRuns.create({
    id: "run-browser-1",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    trigger_mode: "test",
    initiated_by: "browser-e2e",
    status: "completed_with_warnings",
    step_count: 7,
    failed_step_count: 0,
    warning_count: 1,
    started_at: "2099-04-19T18:00:00Z",
    finished_at: "2099-04-19T18:00:15Z",
    error_summary: null,
    summary: {},
    steps: [],
    created_at: "2099-04-19T18:00:00Z",
    updated_at: "2099-04-19T18:00:15Z"
  });

  app.state.incidents.push({
    id: "incident-browser-1",
    tenant_id: "tenant-demo",
    device_id: "device-01",
    event_id: "event-demo",
    stall_id: "stall-a1",
    severity: "critical",
    code: "reader_disconnect",
    message: "Reader disconnected during browser E2E",
    status: "open",
    assignment_checksum: "checksum-browser",
    metadata: { source: "browser-e2e" },
    occurred_at: "2026-04-18T12:02:00Z",
    resolved_at: null,
    source_cursor: "incident-browser-1",
    raw_payload: {},
    created_at: "2026-04-18T12:02:00Z"
  });
  app.state.iotAlertEvents.push({
    id: "alert-browser-1",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    source_type: "device",
    source_id: "device-01",
    dedupe_key: "alert-browser-1",
    severity: "warning",
    status: "open",
    code: "reader_disconnect",
    message: "Reader disconnected during browser E2E",
    details: { device_id: "device-01" },
    delivery_status: "delivered",
    routed_destinations: ["staging"],
    last_delivery_at: "2026-04-18T12:02:00Z",
    delivery_error: null,
    created_at: "2026-04-18T12:02:00Z",
    updated_at: "2026-04-18T12:02:00Z"
  });
  app.state.iotDeviceStatusSnapshots.push({
    id: "snapshot-browser-1",
    integration_name: "iot_platform",
    tenant_id: "tenant-demo",
    event_id: "event-demo",
    device_id: "device-01",
    assignment_status: "matched",
    diagnostics_status: "degraded",
    connectivity_status: "online",
    reader_status: "disconnected",
    app_version: "1.2.3",
    firmware_version: "2.0.0",
    local_queue_depth: 4,
    last_heartbeat_at: "2026-04-18T12:02:00Z",
    checked_at: "2026-04-18T12:02:00Z"
  });
  app.state.heartbeats.push({
    id: "heartbeat-browser-1",
    tenant_id: "tenant-demo",
    device_id: "device-01",
    event_id: "event-demo",
    stall_id: "stall-a1",
    battery_level: 81,
    local_queue_depth: 4,
    assignment_checksum: "checksum-browser",
    connectivity_status: "online",
    reader_status: "disconnected",
    app_version: "1.2.3",
    firmware_version: "2.0.0",
    source_cursor: "heartbeat-browser-1",
    raw_payload: {},
    recorded_at: "2026-04-18T12:02:00Z"
  });

  return {
    vendorGrantedInteractionId: grantedTap.body.interaction_id,
    vendorGrantedSessionToken: grantedTap.body.attendee_session_token
  };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

function createSecureBrowserState(issuer) {
  const state = createSeedState();
  const mappings = new Map([
    ["organizer@example.com", "web-organizer"],
    ["vendor@example.com", "web-vendor"],
    ["sponsor@example.com", "web-sponsor"],
    ["platform1@example.com", "web-platform-1"],
    ["platform2@example.com", "web-platform-2"],
    ["platform3@example.com", "web-platform-3"]
  ]);

  for (const user of state.users) {
    const subject = mappings.get(user.email);
    if (!subject) {
      continue;
    }
    user.external_identity_provider = issuer;
    user.external_subject = subject;
  }

  return state;
}

function createMockOidcIssuer({
  issuer = "https://issuer.example.com",
  audience = "physical-world-interaction-platform",
  kid = "browser-e2e-key"
} = {}) {
  const originalFetch = global.fetch;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  const jwk = publicKey.export({ format: "jwk" });
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = "RS256";

  global.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/.well-known/openid-configuration")) {
      return {
        ok: true,
        async json() {
          return {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`
          };
        }
      };
    }
    if (String(url) === `${issuer}/jwks`) {
      return {
        ok: true,
        async json() {
          return { keys: [jwk] };
        }
      };
    }
    if (String(url) === `${issuer}/token`) {
      const body = new URLSearchParams(String(init.body ?? ""));
      return {
        ok: true,
        async json() {
          return {
            access_token: body.get("code") || "",
            token_type: "Bearer",
            expires_in: 300
          };
        }
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  return {
    issuer,
    audience,
    createToken({ subject, email, expiresInSeconds = 300 }) {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({ alg: "RS256", typ: "JWT", kid })
      ).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          iss: issuer,
          sub: subject,
          aud: audience,
          exp: now + expiresInSeconds,
          iat: now,
          email
        })
      ).toString("base64url");
      const signer = createSign("RSA-SHA256");
      signer.update(`${header}.${payload}`);
      signer.end();
      return `${header}.${payload}.${signer.sign(privateKey).toString("base64url")}`;
    },
    restore() {
      global.fetch = originalFetch;
    }
  };
}

async function seedBrowserSession(page, baseUrl, slot, token) {
  const payload = { origin: baseUrl, authSlot: slot, accessToken: token };
  const storeSession = ({ origin, authSlot, accessToken }) => {
    const key = `pwi.browserAuth.token.${origin}.${authSlot}`;
    window.sessionStorage.setItem(
      key,
      JSON.stringify({
        access_token: accessToken,
        token_type: "Bearer",
        expires_at: Date.now() + 5 * 60 * 1000,
        updated_at: new Date().toISOString()
      })
    );
  };

  await page.addInitScript(storeSession, payload);
  try {
    await page.evaluate(storeSession, payload);
  } catch {
    // No-op when the page has not navigated yet.
  }
}

async function createBridgeServer(app) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");

    if (url.pathname === "/" || extname(url.pathname)) {
      try {
        const filePath = url.pathname === "/" ? join(webRoot, "index.html") : join(webRoot, url.pathname.slice(1));
        const asset = await readFile(filePath);
        res.writeHead(200, { "content-type": contentTypeForPath(url.pathname) });
        res.end(asset);
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
      }
      return;
    }

    const body = parseBody(rawBody, req.headers["content-type"]);
    const response = await app.inject({
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: req.headers,
      body
    });

    res.writeHead(response.statusCode, {
      "content-type": contentTypeForPath(url.pathname)
    });
    res.end(JSON.stringify(response.body));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

function parseBody(rawBody, contentType) {
  if (!rawBody) {
    return {};
  }
  if (contentType?.includes("application/json")) {
    return JSON.parse(rawBody);
  }
  return {};
}

function contentTypeForPath(pathname) {
  const extension = extname(pathname);
  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".js") {
    return "text/javascript; charset=utf-8";
  }
  return "application/json; charset=utf-8";
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
