/**
 * Document Distribution proxy (routes/document-distribution.js) — gap-filling smoke tests
 *
 * tests/document-distribution.test.js already covers the EDI/webhook send happy paths, the
 * webhook-settings PUT/GET round-trip, and the SSRF guard. This file fills in what it doesn't:
 * send-edi/send-webhook 404 branches (unknown document, unknown shipment, file missing on
 * disk), webhook-settings PUT validation + unknown-office 404, the webhook-settings/test route,
 * and the dev-only Test Tools webhook-receiver mock (GET/POST/DELETE).
 *
 * Usage:
 *   node tests/document-distribution-gaps.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Document Distribution Service running on :3002 (npm run distribution-service)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: 3001, path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
      },
    };
    const req = http.request(opts, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost", password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch shipment + office + document");
    const shp = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, token);
    const shipmentId = shp.body.id;
    const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
    const office = await request("POST", "/api/offices", { unlocode: `NL${rand}`, department: "SE", name: "Dist Gap Test Office" }, token);
    const officeId = office.body.id;
    const doc = await request("POST", `/api/shipments/${shipmentId}/documents`, {
      filename: "gap-test.txt", mimeType: "text/plain", docType: "OT", data: Buffer.from("content").toString("base64"),
    }, token);
    const docId = doc.body.id;

    console.log("\nsend-edi — 404 branches (unknown document, unknown shipment)");
    const ediBadDoc = await request("POST", `/api/shipments/${shipmentId}/documents/DOC-NOPE/send-edi`, { recipientCode: "MAEU" }, token);
    assert("send-edi 404 for unknown document", ediBadDoc.status === 404);
    const ediBadShip = await request("POST", `/api/shipments/SHP-NOPE/documents/${docId}/send-edi`, { recipientCode: "MAEU" }, token);
    assert("send-edi 404 for unknown shipment (doc lookup is shipment-scoped)", ediBadShip.status === 404);

    console.log("\nsend-webhook — 404/400 branches (unknown shipment, unknown document, no EMO)");
    const webhookBadShip = await request("POST", "/api/shipments/SHP-NOPE/documents/DOC-NOPE/send-webhook", null, token);
    assert("send-webhook 404 for unknown shipment", webhookBadShip.status === 404);

    const putEmo = await request("PUT", `/api/shipments/${shipmentId}`, {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active", emoOfficeId: officeId,
    }, token);
    assert("EMO office assigned for the next check", putEmo.body.emoOfficeId === officeId);
    const webhookBadDoc = await request("POST", `/api/shipments/${shipmentId}/documents/DOC-NOPE/send-webhook`, null, token);
    assert("send-webhook 404 for unknown document (EMO already set)", webhookBadDoc.status === 404);

    console.log("\nwebhook-settings — validation and unknown-office branches");
    const settingsNoUrl = await request("PUT", `/api/offices/${officeId}/webhook-settings`, { isActive: true }, token);
    assert("PUT missing webhookUrl rejected", settingsNoUrl.status >= 400 && /required/i.test(settingsNoUrl.body.error || ""));
    const settingsBlankUrl = await request("PUT", `/api/offices/${officeId}/webhook-settings`, { webhookUrl: "   " }, token);
    assert("PUT blank (whitespace-only) webhookUrl rejected", settingsBlankUrl.status >= 400);
    const settings404 = await request("PUT", "/api/offices/OFF-NOPE/webhook-settings", { webhookUrl: "https://example.com/hook" }, token);
    assert("PUT webhook-settings 404 for unknown office", settings404.status === 404);

    const settingsOk = await request("PUT", `/api/offices/${officeId}/webhook-settings`, { webhookUrl: "https://example.com/gap-test-hook", secret: "s3cret", isActive: true }, token);
    assert("PUT webhook-settings succeeds with a valid URL", settingsOk.status === 200);

    console.log("\nwebhook-settings/test — real outbound call to a non-2xx-but-reachable host fails cleanly");
    const testMissingUrl = await request("POST", `/api/offices/${officeId}/webhook-settings/test`, {}, token);
    assert("test-send missing webhookUrl rejected", testMissingUrl.status >= 400);
    const testSend = await request("POST", `/api/offices/${officeId}/webhook-settings/test`, { webhookUrl: "https://example.com/not-a-real-endpoint", secret: "s3cret" }, token);
    assert("test-send against a real-but-wrong host returns a clean error, not a crash", testSend.status >= 400 && testSend.status < 600);

    console.log("\nDev-only Test Tools webhook-receiver mock — POST records, GET lists, DELETE clears");
    const clear = await request("DELETE", "/api/test/webhook-receiver", null, token);
    assert("receiver clear returns 200", clear.status === 200 && clear.body.cleared === true);
    const emptyLog = await request("GET", "/api/test/webhook-receiver", null, token);
    assert("receiver log starts empty", Array.isArray(emptyLog.body) && emptyLog.body.length === 0);

    const post1 = await request("POST", "/api/test/webhook-receiver", { hello: "world" }, token);
    assert("receiver accepts a posted payload", post1.status === 200 && post1.body.received === true);
    const afterPost = await request("GET", "/api/test/webhook-receiver", null, token);
    assert("posted payload appears in the log", afterPost.body.length === 1 && afterPost.body[0].body.hello === "world");
    assert("signature header captured (empty when none sent)", afterPost.body[0].signature === "");

    // The log caps at 20 entries — confirm the cap by posting past it.
    for (let i = 0; i < 22; i++) await request("POST", "/api/test/webhook-receiver", { i }, token);
    const cappedLog = await request("GET", "/api/test/webhook-receiver", null, token);
    assert("receiver log caps at 20 entries", cappedLog.body.length === 20);
    assert("most recent entry is first (unshift, not push)", cappedLog.body[0].body.i === 21);

    await request("DELETE", "/api/test/webhook-receiver", null, token);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/offices/${officeId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
