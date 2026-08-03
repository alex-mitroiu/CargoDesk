/**
 * Organization Model Enhancement — Epic 2: Credit Control
 *
 * Covers the credit_limit/credit_terms_days/credit_hold/credit_hold_reason fields on
 * customers, and GET /api/customers/:id/credit-status — the outstanding-AR-vs-limit
 * computation that ShipmentAccountingInvoicesPage.jsx's Generate Invoice flow gates on
 * (resolveCreditGate, src/utils/invoiceGenerator.js).
 *
 * Usage:
 *   node tests/customer-credit-control.test.js
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

const SAMPLE_HTML = `<html><body><h1>Freight Invoice (test fixture)</h1></body></html>`;

async function addSellLine(shipmentId, token, amount, chargeCode = "OFR") {
  const res = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, {
    type: "SELL", chargeCode, currency: "USD", amount, exchangeRate: 1,
  }, token);
  return res.body;
}

async function generateInvoiceDoc(shipmentId, token, sourceCostLineIds) {
  const res = await request("POST", `/api/shipments/${shipmentId}/documents/generate`, {
    html: SAMPLE_HTML, filename: `FR01-${shipmentId}-2026-08-02.html`, docType: "FR01",
    responsibleParty: "Test Credit Co", sourceCostLineIds,
  }, token);
  return res.body;
}

async function confirmDoc(docId, token) {
  return request("PATCH", `/api/documents/${docId}`, { status: "confirmed" }, token);
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch customer — credit fields default blank/off");
    const cust = await request("POST", "/api/customers", { companyName: "Test Credit Co" }, token);
    const customerId = cust.body.id;
    assert("scratch customer created", !!customerId);
    assert("creditLimit defaults null", cust.body.creditLimit === null);
    assert("creditTermsDays defaults null", cust.body.creditTermsDays === null);
    assert("creditHold defaults false", cust.body.creditHold === false);

    console.log("\nSet credit_limit=1000, credit_terms_days=30");
    const setLimit = await request("PUT", `/api/customers/${customerId}`, {
      companyName: "Test Credit Co", creditLimit: 1000, creditTermsDays: 30,
    }, token);
    assert("update returns 200", setLimit.status === 200);
    assert("creditLimit round-trips", setLimit.body.creditLimit === 1000);
    assert("creditTermsDays round-trips", setLimit.body.creditTermsDays === 30);

    console.log("\nCredit status — no shipments yet, no outstanding AR");
    const status0 = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("GET returns 200", status0.status === 200);
    assert("outstandingAr is 0", status0.body.outstandingAr === 0);
    assert("overLimit is false", status0.body.overLimit === false);

    console.log("\nScratch shipment with this customer as Principal");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: customerId, principalName: "Test Credit Co",
    }, token);
    const shipmentId = ship.body.id;
    assert("scratch shipment created", !!shipmentId);
    assert("principalId round-trips on the shipment", ship.body.principalId === customerId);

    console.log("\nFirst confirmed invoice — 700 USD, under the 1000 limit");
    const line1 = await addSellLine(shipmentId, token, 500, "OFR");
    const line2 = await addSellLine(shipmentId, token, 200, "DOC");
    const doc1 = await generateInvoiceDoc(shipmentId, token, [line1.id, line2.id]);
    assert("invoice 1 generated", !!doc1.id);
    const confirm1 = await confirmDoc(doc1.id, token);
    assert("invoice 1 confirmed", confirm1.body.status === "confirmed");

    const status1 = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("outstandingAr reflects the confirmed invoice (700)", status1.body.outstandingAr === 700, JSON.stringify(status1.body));
    assert("still under limit", status1.body.overLimit === false);

    console.log("\nSecond confirmed invoice — 500 USD more, now 1200 total, OVER the 1000 limit");
    const line3 = await addSellLine(shipmentId, token, 500, "THC");
    const doc2 = await generateInvoiceDoc(shipmentId, token, [line3.id]);
    const confirm2 = await confirmDoc(doc2.id, token);
    assert("invoice 2 confirmed", confirm2.body.status === "confirmed");

    const status2 = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("outstandingAr now 1200", status2.body.outstandingAr === 1200, JSON.stringify(status2.body));
    assert("now over limit", status2.body.overLimit === true);

    console.log("\nReversing invoice 2 drops outstanding AR back to 700 (voided invoices are excluded)");
    const reversed = await request("POST", `/api/shipments/${shipmentId}/documents/${doc2.id}/reverse`, { reason: "test" }, token);
    assert("reverse returns 200", reversed.status === 200);
    const status3 = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("outstandingAr back to 700 after reversal", status3.body.outstandingAr === 700, JSON.stringify(status3.body));
    assert("back under limit", status3.body.overLimit === false);

    console.log("\nCredit hold — set, verify, then clear");
    const setHold = await request("PUT", `/api/customers/${customerId}`, {
      companyName: "Test Credit Co", creditLimit: 1000, creditTermsDays: 30,
      creditHold: true, creditHoldReason: "Overdue balance — test fixture",
    }, token);
    assert("hold set", setHold.body.creditHold === true);
    assert("hold reason round-trips", setHold.body.creditHoldReason === "Overdue balance — test fixture");
    const statusHold = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("credit-status reflects the hold", statusHold.body.creditHold === true && statusHold.body.creditHoldReason === "Overdue balance — test fixture");

    const clearHold = await request("PUT", `/api/customers/${customerId}`, {
      companyName: "Test Credit Co", creditLimit: 1000, creditTermsDays: 30, creditHold: false,
    }, token);
    assert("hold cleared", clearHold.body.creditHold === false);
    assert("hold reason cleared alongside it (no stale reason left behind)", clearHold.body.creditHoldReason === "");

    console.log("\n404 on a bogus customer id");
    const bogus = await request("GET", "/api/customers/CUS-DOESNOTEXIST/credit-status", null, token);
    assert("bogus id returns 404", bogus.status === 404);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/customers/${customerId}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
