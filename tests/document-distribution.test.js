/**
 * Document Distribution — EDI transmittal + Webhook (TKT-SLIRP9)
 *
 * Exercises the monolith's thin proxy routes (routes/document-distribution.js) against the REAL
 * Document Distribution Service — this is the one test file in this suite that needs a second
 * process running.
 *
 * Usage:
 *   node tests/document-distribution.test.js
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

async function scratchShipment(token) {
  const res = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
  }, token);
  return res.body.id;
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch shipment + uploaded document");
    const shipId = await scratchShipment(token);
    const doc = await request("POST", `/api/shipments/${shipId}/documents`, {
      filename: "test-dist.txt", mimeType: "text/plain", docType: "OT",
      data: Buffer.from("distribution test content").toString("base64"),
    }, token);
    assert("document created", doc.status === 201, JSON.stringify(doc.body));

    console.log("\nEDI transmittal — missing recipientCode rejected");
    const ediMissing = await request("POST", `/api/shipments/${shipId}/documents/${doc.body.id}/send-edi`, {}, token);
    assert("missing recipientCode rejected (400)", ediMissing.status === 400);

    console.log("\nEDI transmittal — success + monolith-side audit event");
    const ediSend = await request("POST", `/api/shipments/${shipId}/documents/${doc.body.id}/send-edi`,
      { recipientCode: "MAEU", recipientLabel: "Maersk Line" }, token);
    assert("send-edi returns 201", ediSend.status === 201, JSON.stringify(ediSend.body));
    assert("transmittalId present", (ediSend.body.transmittalId || "").startsWith("EDIT-"));
    const ediHistory = await request("GET", `/api/entity-events/document/${doc.body.id}`, null, token);
    const ediEvent = ediHistory.body.find(e => e.eventType === "EDI_SENT");
    assert("EDI_SENT entity_events row exists", !!ediEvent, JSON.stringify(ediHistory.body));

    console.log("\nWebhook — no EMO office assigned yet returns a clean error");
    const webhookNoEmo = await request("POST", `/api/shipments/${shipId}/documents/${doc.body.id}/send-webhook`, null, token);
    assert("no EMO office rejected", webhookNoEmo.status === 400, JSON.stringify(webhookNoEmo.body));

    console.log("\nAssign an EMO office, configure its webhook to an unreachable-but-real https host");
    const offices = await request("GET", "/api/offices", null, token);
    const officeId = offices.body[0]?.id;
    assert("a real office exists to test with", !!officeId, JSON.stringify(offices.body));
    const shipFull = await request("GET", `/api/shipments/${shipId}`, null, token);
    const putShip = await request("PUT", `/api/shipments/${shipId}`, {
      pol: shipFull.body.pol, pod: shipFull.body.pod, carrierCode: shipFull.body.carrierCode,
      contractType: shipFull.body.contractType, status: shipFull.body.status, emoOfficeId: officeId,
    }, token);
    assert("EMO office assigned", putShip.body.emoOfficeId === officeId, JSON.stringify(putShip.body));

    const webhookConfig = await request("PUT", `/api/offices/${officeId}/webhook-settings`,
      { webhookUrl: "https://example.com/not-a-real-endpoint", secret: "testsecret", isActive: true }, token);
    assert("webhook-settings PUT returns 200", webhookConfig.status === 200, JSON.stringify(webhookConfig.body));
    assert("webhookUrl round-trips", webhookConfig.body.webhookUrl === "https://example.com/not-a-real-endpoint");
    assert("secret itself is never returned", webhookConfig.body.secret === undefined);

    const webhookGet = await request("GET", `/api/offices/${officeId}/webhook-settings`, null, token);
    assert("webhook-settings GET matches", webhookGet.body.webhookUrl === "https://example.com/not-a-real-endpoint");

    console.log("\nWebhook — send attempt against a real-but-non-2xx host fails cleanly (not a hang, not a 500)");
    const webhookSend = await request("POST", `/api/shipments/${shipId}/documents/${doc.body.id}/send-webhook`, null, token);
    assert("clean 502, not a crash", webhookSend.status === 502, JSON.stringify(webhookSend.body));
    assert("error message present", typeof webhookSend.body.error === "string" && webhookSend.body.error.length > 0);

    console.log("\nWebhook-settings — invalid URL rejected before ever reaching the service");
    const webhookBadUrl = await request("PUT", `/api/offices/${officeId}/webhook-settings`,
      { webhookUrl: "https://169.254.169.254/hook", isActive: true }, token);
    assert("cloud-metadata URL rejected", webhookBadUrl.status >= 400, JSON.stringify(webhookBadUrl.body));

    console.log("\nDocument-scoped share token — minted internally by send-webhook, downloadable, tamper-evident");
    // Mint one directly via a real webhook send's side effect isn't observable from here (the URL
    // is only ever handed to the distribution service, never returned to the caller) — so instead
    // confirm the underlying public route behaves correctly against a deliberately invalid token,
    // proving the endpoint is live and rejects garbage rather than 404ing or crashing.
    const badToken = await request("GET", "/api/share/document/not-a-real-token", null, null);
    assert("garbage token rejected cleanly", badToken.status === 400, JSON.stringify(badToken.body));

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
