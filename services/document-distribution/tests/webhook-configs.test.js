/**
 * Document Distribution Service — webhook-config CRUD + SSRF guard
 *
 * Hits the service directly on its own port, no monolith involved.
 *
 * Usage:
 *   node services/document-distribution/tests/webhook-configs.test.js
 *
 * Prerequisites:
 *   - Document Distribution Service running on :3002 (npm run distribution-service)
 */

import http from "node:http";

const PORT = 3002;
const SECRET = process.env.DISTRIBUTION_SERVICE_SECRET || "cargoDesk-dev-distribution-secret-do-not-use-in-prod";
let passed = 0;
let failed = 0;

function request(method, path, body, auth = true) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: PORT, path,
      headers: {
        "Content-Type": "application/json",
        ...(auth && { Authorization: `Bearer ${SECRET}` }),
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
    console.log("Health check");
    const health = await request("GET", "/health", null, false);
    assert("health returns 200", health.status === 200);
    assert("service name is document-distribution", health.body.service === "document-distribution");

    console.log("\nNo secret / wrong secret is rejected on /internal/*");
    const noAuth = await request("GET", "/internal/webhook-configs/OFF-TESTX", null, false);
    assert("no auth returns 401", noAuth.status === 401);

    console.log("\nGET a never-configured scope returns a sensible default, not 404");
    const empty = await request("GET", "/internal/webhook-configs/OFF-NEVER-CONFIGURED");
    assert("empty config returns 200", empty.status === 200);
    assert("webhookUrl is blank", empty.body.webhookUrl === "");
    // isActive defaults true (matching office_mail_settings' own DEFAULT_SETTINGS convention) —
    // a brand-new config should be immediately usable once a URL is saved, not silently inactive.
    assert("isActive defaults true", empty.body.isActive === true);

    console.log("\nPUT create + GET round-trip");
    const put = await request("PUT", "/internal/webhook-configs/OFF-TESTX", { webhookUrl: "https://partner.example.com/hook", secret: "s3cr3t", isActive: true });
    assert("PUT returns 200", put.status === 200, JSON.stringify(put.body));
    assert("webhookUrl round-trips", put.body.webhookUrl === "https://partner.example.com/hook");
    assert("hasSecret is true", put.body.hasSecret === true);
    assert("secret value itself is never returned", put.body.secret === undefined);
    const get = await request("GET", "/internal/webhook-configs/OFF-TESTX");
    assert("GET after PUT matches", get.body.webhookUrl === "https://partner.example.com/hook" && get.body.isActive === true);

    console.log("\nBlank secret on a later PUT keeps the existing one (password-field UX)");
    const putBlankSecret = await request("PUT", "/internal/webhook-configs/OFF-TESTX", { webhookUrl: "https://partner.example.com/hook-v2", isActive: true });
    assert("PUT without secret returns 200", putBlankSecret.status === 200);
    assert("hasSecret is still true (kept)", putBlankSecret.body.hasSecret === true);
    assert("webhookUrl updated", putBlankSecret.body.webhookUrl === "https://partner.example.com/hook-v2");

    console.log("\nSSRF guard — https required");
    const httpRejected = await request("PUT", "/internal/webhook-configs/OFF-BAD1", { webhookUrl: "http://partner.example.com/hook", isActive: true });
    assert("plain http rejected", httpRejected.status >= 400, JSON.stringify(httpRejected.body));

    console.log("\nSSRF guard — private/loopback/link-local literal hosts rejected");
    for (const badUrl of [
      "https://localhost/hook", "https://127.0.0.1/hook", "https://169.254.169.254/hook",
      "https://10.0.0.5/hook", "https://172.20.0.5/hook", "https://192.168.1.5/hook",
    ]) {
      const r = await request("PUT", "/internal/webhook-configs/OFF-BAD-" + badUrl.replace(/\W/g, ""), { webhookUrl: badUrl, isActive: true });
      assert(`rejected: ${badUrl}`, r.status >= 400, JSON.stringify(r.body));
    }

    console.log("\nSSRF guard — a real public https host is accepted");
    const goodUrl = await request("PUT", "/internal/webhook-configs/OFF-GOOD1", { webhookUrl: "https://example.com/hook", isActive: true });
    assert("public https host accepted", goodUrl.status === 200, JSON.stringify(goodUrl.body));

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
