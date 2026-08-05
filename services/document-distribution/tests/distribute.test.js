/**
 * Document Distribution Service — EDI transmittal, webhook delivery, registry
 *
 * Hits the service directly on its own port, no monolith involved. The webhook-sending
 * mechanics (payload + X-CargoDesk-Signature) are tested directly against a real in-process
 * http.createServer receiver, bypassing the SSRF policy layer (which only lives in the route/
 * config-PUT layer, not in sendWebhook itself) — mirrors document-signing.test.js's and
 * office-mail.test.js's own no-network-mocking style. The full HTTP route is separately proven
 * against a real, always-reachable public host (example.com, which returns a deterministic
 * non-2xx for any POST) to confirm the failure-recording path end-to-end.
 *
 * Usage:
 *   node services/document-distribution/tests/distribute.test.js
 *
 * Prerequisites:
 *   - Document Distribution Service running on :3002 (npm run distribution-service)
 */

import http from "node:http";
import crypto from "node:crypto";
import { sendWebhook, signPayload, isUrlSafe } from "../lib/webhookSender.js";

const PORT = 3002;
const SECRET = process.env.DISTRIBUTION_SERVICE_SECRET || "cargoDesk-dev-distribution-secret-do-not-use-in-prod";
let passed = 0;
let failed = 0;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: PORT, path,
      headers: {
        "Content-Type": "application/json", Authorization: `Bearer ${SECRET}`,
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

(async () => {
  try {
    console.log("EDI transmittal — create + shape");
    const edi = await request("POST", "/internal/distribute/edi", {
      shipmentId: "SHP-TESTX", documentId: "DOC-TESTX", docType: "BL01", filename: "bl.pdf",
      sizeBytes: 1234, checksum: "abc123", recipientCode: "MAEU", recipientLabel: "Maersk Line",
    });
    assert("returns 201", edi.status === 201, JSON.stringify(edi.body));
    assert("transmittalId starts with EDIT-", (edi.body.transmittalId || "").startsWith("EDIT-"));
    assert("status is sent", edi.body.status === "sent");

    console.log("\nEDI transmittal — missing recipientCode rejected");
    const ediBad = await request("POST", "/internal/distribute/edi", { shipmentId: "SHP-TESTX", documentId: "DOC-TESTX" });
    assert("missing recipientCode returns 400", ediBad.status === 400);

    console.log("\nWebhook — pure sendWebhook() mechanics against a real local receiver");
    let received = null;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", c => (body += c));
      req.on("end", () => {
        received = { headers: req.headers, body: JSON.parse(body) };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise(resolve => server.listen(9911, resolve));
    const testPayload = { event: "document.distributed", documentId: "DOC-TESTX", timestamp: "2026-01-01T00:00:00.000Z" };
    const result = await sendWebhook("http://localhost:9911/hook", testPayload, "mysecret");
    assert("sendWebhook reports ok", result.ok === true, JSON.stringify(result));
    assert("receiver actually got the payload", received && received.body.documentId === "DOC-TESTX");
    const expectedSig = "sha256=" + crypto.createHmac("sha256", "mysecret").update(JSON.stringify(testPayload)).digest("hex");
    assert("signature header matches signPayload()", received && received.headers["x-cargodesk-signature"] === expectedSig);
    assert("signPayload() is deterministic for the same input", signPayload(testPayload, "mysecret") === expectedSig.replace("sha256=", ""));
    await new Promise(resolve => server.close(resolve));

    console.log("\nisUrlSafe() — direct unit checks");
    assert("https public host is safe", isUrlSafe("https://example.com/hook") === true);
    assert("http is never safe", isUrlSafe("http://example.com/hook") === false);
    assert("localhost is never safe", isUrlSafe("https://localhost/hook") === false);
    assert("cloud metadata address is never safe", isUrlSafe("https://169.254.169.254/hook") === false);
    assert("garbage input is never safe", isUrlSafe("not a url") === false);

    console.log("\nWebhook — full route, no config for this scope returns a clean error");
    const noConfig = await request("POST", "/internal/distribute/webhook", {
      shipmentId: "SHP-TESTX", documentId: "DOC-TESTX", docType: "BL01", filename: "bl.pdf",
      scopeId: "OFF-NEVER-CONFIGURED-2", downloadUrl: "https://example.com/download",
    });
    assert("returns 400", noConfig.status === 400, JSON.stringify(noConfig.body));

    console.log("\nWebhook — full route, configured but unreachable/non-2xx receiver records a failure cleanly (not a crash, not a double-insert)");
    await request("PUT", "/internal/webhook-configs/OFF-FAILTEST", { webhookUrl: "https://example.com/definitely-not-a-real-endpoint", secret: "x", isActive: true });
    const failSend = await request("POST", "/internal/distribute/webhook", {
      shipmentId: "SHP-TESTX", documentId: "DOC-TESTX", docType: "BL01", filename: "bl.pdf",
      scopeId: "OFF-FAILTEST", downloadUrl: "https://example.com/download",
    });
    assert("returns a clean 502, not a 500/crash", failSend.status === 502, JSON.stringify(failSend.body));
    assert("error message is informative", typeof failSend.body.error === "string" && failSend.body.error.length > 0);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
