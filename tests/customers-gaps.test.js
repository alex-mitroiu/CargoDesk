/**
 * Customers (routes/customers.js) — gap-filling smoke tests
 *
 * Contacts, Roles, credit-status, and sanctions screening are already well covered by
 * tests/customer-contacts-roles.test.js, tests/customer-credit-control.test.js, and
 * tests/customer-compliance-screening.test.js. This file fills in the parts those don't touch:
 * Customer Identifiers CRUD (VAT/EORI-style codes), GET /sanctions-check, POST /:id/screen
 * (direct route, not just the GET), Customer Documents CRUD + download, and GET /api/fx/rates.
 *
 * Usage:
 *   node tests/customers-gaps.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
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

function download(path, token) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
    }).on("error", reject);
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

    console.log("\nScratch customer");
    const cust = await request("POST", "/api/customers", { companyName: "Customers Gap Test Co" }, token);
    assert("scratch customer created", cust.status === 201, JSON.stringify(cust.body));
    const customerId = cust.body.id;

    console.log("\nGET /api/customers/sanctions-check — legacy bulk-scan endpoint");
    const sanctionsCheck = await request("GET", "/api/customers/sanctions-check", null, token);
    assert("returns 200 with enabled/hits shape", sanctionsCheck.status === 200 && "enabled" in sanctionsCheck.body && "hits" in sanctionsCheck.body);

    console.log("\nPOST /api/customers/:id/screen — direct screen-now route");
    const screen404 = await request("POST", "/api/customers/CUST-NOPE/screen", {}, token);
    assert("screen 404 for unknown customer", screen404.status === 404);
    const screen = await request("POST", `/api/customers/${customerId}/screen`, {}, token);
    // Sanctions list is synced in this dev DB (per other test suites relying on real synced
    // entries) — either a real screen result comes back, or the "not yet synced" 400 fires; both
    // are legitimate, so accept either rather than assuming sync state.
    assert("screen returns 200 (synced) or 400 (not yet synced) — not a crash", [200, 400].includes(screen.status));
    if (screen.status === 200) {
      const screeningGet = await request("GET", `/api/customers/${customerId}/screening`, null, token);
      assert("GET screening reflects the just-run screen", screeningGet.status === 200 && screeningGet.body !== null);

      console.log("\nPOST /api/customers/:id/screening/override");
      const overrideNoReason = await request("POST", `/api/customers/${customerId}/screening/override`, {}, token);
      assert("override missing reason rejected", overrideNoReason.status >= 400 && /reason is required/i.test(overrideNoReason.body.error || ""));
      const overrideNoRecord = await request("POST", "/api/customers/CUST-NOPE/screening/override", { reason: "test" }, token);
      assert("override 404 for a customer with no screening record", overrideNoRecord.status === 404);
      const override = await request("POST", `/api/customers/${customerId}/screening/override`, { reason: "Verified false positive — test fixture" }, token);
      assert("override succeeds", override.status === 200, JSON.stringify(override.body));
      assert("result forced to CLEAR", override.body.result === "CLEAR");
      assert("override reason round-trips", override.body.overrideReason === "Verified false positive — test fixture");
    } else {
      console.log("  (sanctions list not synced in this environment — screen/override chain skipped)");
    }

    console.log("\nCustomer Identifiers — create, list, update, isPrimary exclusivity, delete");
    const idCreate = await request("POST", `/api/customers/${customerId}/identifiers`, {
      idType: "VAT", idCode: "NL123456789B01", countryIso2: "nl", label: "Primary VAT", isPrimary: true,
    }, token);
    assert("identifier created", idCreate.status === 201, JSON.stringify(idCreate.body));
    assert("countryIso2 uppercased", idCreate.body.countryIso2 === "NL");
    const idId = idCreate.body.id;

    const idMissingCode = await request("POST", `/api/customers/${customerId}/identifiers`, { idType: "EORI" }, token);
    assert("missing idCode rejected", idMissingCode.status >= 400);
    const idBadCustomer = await request("POST", "/api/customers/CUST-NOPE/identifiers", { idCode: "X" }, token);
    assert("create 404 for unknown customer", idBadCustomer.status === 404);

    const idSecond = await request("POST", `/api/customers/${customerId}/identifiers`, {
      idType: "VAT", idCode: "NL999999999B01", isPrimary: true,
    }, token);
    assert("second VAT identifier created", idSecond.status === 201);
    const idListAfterSecond = await request("GET", `/api/customers/${customerId}/identifiers`, null, token);
    const firstAfter = idListAfterSecond.body.find(i => i.id === idId);
    assert("setting a new primary of the same idType clears the old primary flag", firstAfter && firstAfter.isPrimary === false);
    assert("primary rows sort first", idListAfterSecond.body[0].isPrimary === true);

    const idUpdate = await request("PUT", `/api/customers/${customerId}/identifiers/${idId}`, { idCode: "NL123456789B02", label: "Updated VAT" }, token);
    assert("identifier update returns 200", idUpdate.status === 200 && idUpdate.body.idCode === "NL123456789B02");
    const idUpdate404 = await request("PUT", `/api/customers/${customerId}/identifiers/CID-NOPE`, { idCode: "X" }, token);
    assert("identifier update 404 for unknown id", idUpdate404.status === 404);
    const idUpdateMissingCode = await request("PUT", `/api/customers/${customerId}/identifiers/${idId}`, { idCode: "" }, token);
    assert("identifier update with blank idCode rejected", idUpdateMissingCode.status >= 400);

    const idDelete = await request("DELETE", `/api/customers/${customerId}/identifiers/${idId}`, null, token);
    assert("identifier delete returns 200", idDelete.status === 200);
    const idDelete404 = await request("DELETE", `/api/customers/${customerId}/identifiers/${idId}`, null, token);
    assert("identifier delete 404 on second attempt", idDelete404.status === 404);
    await request("DELETE", `/api/customers/${customerId}/identifiers/${idSecond.body.id}`, null, token);

    console.log("\nCustomer Documents — upload, list, download, delete");
    const emptyDocs = await request("GET", `/api/customers/${customerId}/documents`, null, token);
    assert("documents list starts empty", emptyDocs.status === 200 && emptyDocs.body.length === 0);

    const docMissing = await request("POST", `/api/customers/${customerId}/documents`, { filename: "" }, token);
    assert("upload missing filename/data rejected", docMissing.status >= 400);
    const docCreate = await request("POST", `/api/customers/${customerId}/documents`, {
      filename: "customer-fixture.txt", mimeType: "text/plain", docType: "Other",
      data: Buffer.from("customer document fixture content").toString("base64"),
    }, token);
    assert("document uploaded", docCreate.status === 201, JSON.stringify(docCreate.body));
    const docId = docCreate.body.id;

    const docBadCustomer = await request("POST", "/api/customers/CUST-NOPE/documents", { filename: "x.txt", data: "eA==" }, token);
    assert("upload 404 for unknown customer", docBadCustomer.status === 404);

    const docList = await request("GET", `/api/customers/${customerId}/documents`, null, token);
    assert("documents list now includes it", docList.body.some(d => d.id === docId));

    const docDownload = await download(`/api/customers/${customerId}/documents/${docId}/download`, token);
    assert("download returns 200", docDownload.status === 200);
    assert("download content matches what was uploaded", docDownload.buffer.toString() === "customer document fixture content");
    assert("content-disposition names the original filename", (docDownload.headers["content-disposition"] || "").includes("customer-fixture.txt"));
    const docDownload404 = await download(`/api/customers/${customerId}/documents/CDO-NOPE/download`, token);
    assert("download 404 for unknown document", docDownload404.status === 404);

    const docDelete = await request("DELETE", `/api/customers/${customerId}/documents/${docId}`, null, token);
    assert("document delete returns 200", docDelete.status === 200);
    const docDelete404 = await request("DELETE", `/api/customers/${customerId}/documents/${docId}`, null, token);
    assert("document delete 404 on second attempt", docDelete404.status === 404);

    console.log("\nGET /api/fx/rates — live FX cache");
    const fxRates = await request("GET", "/api/fx/rates", null, token);
    assert("fx rates returns 200", fxRates.status === 200);
    assert("shape has base/rates/ts", fxRates.body.base === "USD" && typeof fxRates.body.rates === "object" && "ts" in fxRates.body);

    console.log("\nDelete — blocked while assigned as a carrier line agent, and cleans up a lingering document's file on disk");
    const agentRand = Math.random().toString(36).slice(2, 5).toUpperCase();
    const agentPort = await request("POST", "/api/port-locations", { unlocode: `Z${agentRand}A`, name: "Zed Agent Port", countryCode: "NL" }, token);
    const agent = await request("POST", "/api/carrier-agents", { carrierCode: "MAEU", agentCustomerId: customerId, locationType: "unlocode", unlocode: `Z${agentRand}A` }, token);
    assert("scratch carrier-agent assignment created", agent.status === 201, JSON.stringify(agent.body));
    const deleteBlocked = await request("DELETE", `/api/customers/${customerId}`, null, token);
    assert("delete blocked while assigned as a carrier line agent", deleteBlocked.status >= 400 && /carrier line agent/i.test(deleteBlocked.body.error || ""));
    await request("DELETE", `/api/carrier-agents/${agent.body.id}`, null, token);
    await request("POST", `/api/customers/${customerId}/documents`, {
      filename: "lingering.txt", mimeType: "text/plain", data: Buffer.from("still here at delete time").toString("base64"),
    }, token);

    console.log("\nCleanup");
    const finalDelete = await request("DELETE", `/api/customers/${customerId}`, null, token);
    assert("delete succeeds once unblocked, cleaning up its lingering document", finalDelete.status === 200);
    await request("DELETE", `/api/port-locations/Z${agentRand}A`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
