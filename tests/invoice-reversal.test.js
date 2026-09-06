/**
 * Invoice Reversal / Credit-Debit Note workflow (TKT-DUADU3) — smoke tests
 *
 * Usage:
 *   node tests/invoice-reversal.test.js
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

async function scratchShipment(token) {
  const res = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU",
    status: "Active", contractType: "SPOT", etd: "2026-09-01",
  }, token);
  return res.body.id;
}

const SAMPLE_HTML = `<html><body><h1>Freight Invoice (test fixture)</h1></body></html>`;

async function addSellLine(shipmentId, token, amount, chargeCode = "OFR") {
  const res = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, {
    type: "SELL", chargeCode, currency: "USD", amount, exchangeRate: 1,
  }, token);
  return res.body;
}

async function generateInvoiceDoc(shipmentId, token, { sourceCostLineIds } = {}) {
  const res = await request("POST", `/api/shipments/${shipmentId}/documents/generate`, {
    html: SAMPLE_HTML, filename: `FR01-${shipmentId}-2026-08-01.html`, docType: "FR01",
    responsibleParty: "Test Consignee", ...(sourceCostLineIds ? { sourceCostLineIds } : {}),
  }, token);
  return res.body;
}

async function confirmDoc(shipmentId, docId, token) {
  return request("PATCH", `/api/shipments/${shipmentId}/documents/${docId}`, { status: "confirmed" }, token);
}

(async () => {
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch shipment + SELL cost lines");
    const shipmentId = await scratchShipment(token);
    assert("scratch shipment created", !!shipmentId);
    const line1 = await addSellLine(shipmentId, token, 500, "OFR");
    const line2 = await addSellLine(shipmentId, token, 120, "DOC");
    assert("two SELL lines created", !!line1.id && !!line2.id);

    console.log("\nGenerate + confirm a real FR01 invoice, with sourceCostLineIds recorded");
    const doc = await generateInvoiceDoc(shipmentId, token, { sourceCostLineIds: [line1.id, line2.id] });
    assert("invoice generated", !!doc.id);
    assert("sourceCostLineIds persisted", Array.isArray(doc.sourceCostLineIds) && doc.sourceCostLineIds.length === 2, JSON.stringify(doc.sourceCostLineIds));
    const confirmed = await confirmDoc(shipmentId, doc.id, token);
    assert("confirm returns 200", confirmed.status === 200);
    assert("status is confirmed", confirmed.body.status === "confirmed");

    console.log("\nReversing a draft doc is rejected (generate a second, unconfirmed invoice)");
    const draftDoc = await generateInvoiceDoc(shipmentId, token, { sourceCostLineIds: [line1.id] });
    const draftReverse = await request("POST", `/api/shipments/${shipmentId}/documents/${draftDoc.id}/reverse`, {}, token);
    assert("reversing a draft invoice 409s", draftReverse.status === 409, JSON.stringify(draftReverse.body));

    console.log("\nReversing a non-invoice doc type is rejected");
    const otherDoc = await request("POST", `/api/shipments/${shipmentId}/documents/generate`, {
      html: SAMPLE_HTML, filename: `PL01-${shipmentId}.html`, docType: "PL01",
    }, token);
    await confirmDoc(shipmentId, otherDoc.body.id, token);
    const otherReverse = await request("POST", `/api/shipments/${shipmentId}/documents/${otherDoc.body.id}/reverse`, {}, token);
    assert("reversing a non-FR01/FR02 doc 400s", otherReverse.status === 400, JSON.stringify(otherReverse.body));

    console.log("\nReverse the confirmed FR01 invoice");
    const rev = await request("POST", `/api/shipments/${shipmentId}/documents/${doc.id}/reverse`, { reason: "Duplicate charge" }, token);
    assert("reverse returns 200", rev.status === 200, JSON.stringify(rev.body));
    assert("two reversal lines returned", rev.body.reversalLines?.length === 2, JSON.stringify(rev.body.reversalLines));
    const [r1, r2] = rev.body.reversalLines.sort((a, b) => a.amount - b.amount);
    assert("reversal amounts are negated", r1.amount === -500 && r2.amount === -120, JSON.stringify(rev.body.reversalLines));
    assert("reversal lines are tagged source:reversal", rev.body.reversalLines.every(l => l.source === "reversal"));
    assert("reversal lines are posted", rev.body.reversalLines.every(l => l.status === "posted"));
    assert("original doc is voided in response", rev.body.voidedDoc?.status === "voided");

    console.log("\nOriginal doc really is voided when re-fetched");
    const docsAfter = await request("GET", `/api/shipments/${shipmentId}/documents`, null, token);
    const refetched = docsAfter.body.find(d => d.id === doc.id);
    assert("refetched doc status is voided", refetched?.status === "voided");

    console.log("\nReversal lines really exist in the cost-lines list");
    const linesAfter = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
    const reversalRows = linesAfter.body.filter(l => l.source === "reversal");
    assert("2 reversal cost lines present", reversalRows.length === 2, `found ${reversalRows.length}`);

    console.log("\nReversing an already-voided invoice is rejected");
    const doubleReverse = await request("POST", `/api/shipments/${shipmentId}/documents/${doc.id}/reverse`, {}, token);
    assert("double-reverse 409s", doubleReverse.status === 409, JSON.stringify(doubleReverse.body));

    console.log("\nFallback path: reversing an invoice with no sourceCostLineIds (pre-feature doc) falls back to live container-scoped SELL lines");
    const line3 = await addSellLine(shipmentId, token, 75, "FUM");
    // Fallback scope is "every current shipment-level SELL line" — by this point that includes
    // the original line1/line2 (never deleted, only offset), the 2 reversal lines already
    // created above, and line3. Compute the expected total dynamically rather than hardcoding
    // it, since it's a live snapshot of whatever SELL lines currently exist.
    const linesBeforeFallback = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
    const expectedFallbackTotal = -linesBeforeFallback.body
      .filter(l => l.type === "SELL" && !l.containerId).reduce((s, l) => s + l.amount, 0);
    const legacyDoc = await generateInvoiceDoc(shipmentId, token); // no sourceCostLineIds
    assert("legacy doc has null sourceCostLineIds", legacyDoc.sourceCostLineIds === null);
    await confirmDoc(shipmentId, legacyDoc.id, token);
    const legacyReverse = await request("POST", `/api/shipments/${shipmentId}/documents/${legacyDoc.id}/reverse`, {}, token);
    assert("fallback reverse returns 200", legacyReverse.status === 200, JSON.stringify(legacyReverse.body));
    const fallbackTotal = legacyReverse.body.reversalLines.reduce((s, l) => s + l.amount, 0);
    assert("fallback reversal negates the live SELL total", Math.abs(fallbackTotal - expectedFallbackTotal) < 0.001, `got ${fallbackTotal}, expected ${expectedFallbackTotal}`);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
