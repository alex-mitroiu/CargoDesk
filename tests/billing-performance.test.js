/**
 * Invoicing Discipline & Billing Performance (Epic TKT-KR6ZBT) — Stories 1 & 2.
 *
 * Story 1 (TKT-NQ87D3, Mark as Paid): a real payment-receipt primitive — before this,
 * computeArExposure's outstandingAr meant purely "confirmed, non-voided invoice", with no
 * concept anywhere of a customer having actually paid. paidAt/paidAmount are both required at
 * the API level (never auto-defaulted); a partial payment reduces but never zeroes the
 * remaining outstanding balance, and never resets its aging clock.
 *
 * Story 2 (TKT-PLAVEK, first_sent_at): a fast, denormalized "was this ever sent" signal on
 * shipment_documents, written once by whichever channel (email/EDI/webhook) succeeds first.
 * Tested via send-edi (the one channel that genuinely succeeds against the real, locally
 * running Document Distribution Service — send-email needs a real SMTP host this environment
 * doesn't have, and send-webhook's own test file deliberately points at an unreachable host).
 *
 * Usage:
 *   node tests/billing-performance.test.js
 *
 * Prerequisites:
 *   - Full 4-service dev stack running (npm run dev) — send-edi proxies to the Document
 *     Distribution Service on :3002, not just the monolith on :3001.
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
    html: SAMPLE_HTML, filename: `FR01-${shipmentId}-2026-08-22.html`, docType: "FR01",
    responsibleParty: "Test Billing Co", sourceCostLineIds,
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

    console.log("\nScratch customer + shipment + confirmed invoice");
    const cust = await request("POST", "/api/customers", { companyName: "Test Billing Co" }, token);
    const customerId = cust.body.id;
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: customerId, principalName: "Test Billing Co",
    }, token);
    const shipmentId = ship.body.id;
    const line1 = await addSellLine(shipmentId, token, 600, "OFR");
    const line2 = await addSellLine(shipmentId, token, 400, "DOC");
    const doc = await generateInvoiceDoc(shipmentId, token, [line1.id, line2.id]);
    assert("invoice generated", !!doc.id);
    assert("mapDoc exposes paidAt/paidAmount/transactionId/firstSentAt, all null/blank by default",
      doc.paidAt === null && doc.paidAmount === null && doc.transactionId === "" && doc.firstSentAt === null,
      JSON.stringify(doc));

    console.log("\nMark as Paid — validation");
    const markDraft = await request("POST", `/api/shipments/${shipmentId}/documents/${doc.id}/mark-paid`,
      { paidAt: "2026-08-22", paidAmount: 1000 }, token);
    assert("marking a DRAFT invoice paid is rejected", markDraft.status === 409, JSON.stringify(markDraft.body));

    await confirmDoc(doc.id, token);

    const noDate = await request("POST", `/api/shipments/${shipmentId}/documents/${doc.id}/mark-paid`, { paidAmount: 1000 }, token);
    assert("missing paidAt rejected", noDate.status >= 400, JSON.stringify(noDate.body));
    const noAmount = await request("POST", `/api/shipments/${shipmentId}/documents/${doc.id}/mark-paid`, { paidAt: "2026-08-22" }, token);
    assert("missing paidAmount rejected", noAmount.status >= 400, JSON.stringify(noAmount.body));
    const zeroAmount = await request("POST", `/api/shipments/${shipmentId}/documents/${doc.id}/mark-paid`, { paidAt: "2026-08-22", paidAmount: 0 }, token);
    assert("zero paidAmount rejected", zeroAmount.status >= 400, JSON.stringify(zeroAmount.body));
    const negAmount = await request("POST", `/api/shipments/${shipmentId}/documents/${doc.id}/mark-paid`, { paidAt: "2026-08-22", paidAmount: -50 }, token);
    assert("negative paidAmount rejected", negAmount.status >= 400, JSON.stringify(negAmount.body));

    console.log("\nMark as Paid — role gate (postGate: admin/operator only)");
    const rand = Math.random().toString(36).slice(2, 8);
    const occEmail = `occ-mp-${rand}@example.com`;
    await request("POST", "/api/users", { email: occEmail, name: "OCC Mark Paid Test", roles: ["occ_bk"], password: "OccFixture!2026Zq" }, token);
    const occLogin = await request("POST", "/api/auth/login", { email: occEmail, password: "OccFixture!2026Zq" });
    const markAsOcc = await request("POST", `/api/shipments/${shipmentId}/documents/${doc.id}/mark-paid`,
      { paidAt: "2026-08-22", paidAmount: 1000 }, occLogin.body.token);
    assert("occ_bk (not admin/operator) cannot mark paid", markAsOcc.status === 403, JSON.stringify(markAsOcc.body));

    console.log("\nCredit-status before any payment — full 1000 outstanding");
    const statusBefore = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("outstandingAr is the full invoice total (1000) before any payment", statusBefore.body.outstandingAr === 1000, JSON.stringify(statusBefore.body));

    console.log("\nPartial payment — 400 of 1000 — reduces but doesn't zero outstandingAr, aging clock unchanged");
    const partial = await request("POST", `/api/shipments/${shipmentId}/documents/${doc.id}/mark-paid`,
      { paidAt: "2026-08-20", paidAmount: 400, transactionId: "WIRE-TEST-001" }, token);
    assert("partial mark-paid returns 200", partial.status === 200, JSON.stringify(partial.body));
    assert("paidAt round-trips", partial.body.paidAt === "2026-08-20");
    assert("paidAmount round-trips", partial.body.paidAmount === 400);
    assert("transactionId round-trips", partial.body.transactionId === "WIRE-TEST-001");
    const statusPartial = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("outstandingAr reduced by exactly the paid amount (1000-400=600)", statusPartial.body.outstandingAr === 600, JSON.stringify(statusPartial.body));
    assert("the remainder still ages in 'current' (same confirmed_at, not reset)", statusPartial.body.aging.current === 600, JSON.stringify(statusPartial.body.aging));

    console.log("\nFull payment — marking again with the full remaining total zeroes outstandingAr");
    const full = await request("POST", `/api/shipments/${shipmentId}/documents/${doc.id}/mark-paid`,
      { paidAt: "2026-08-21", paidAmount: 1000, transactionId: "WIRE-TEST-002" }, token);
    assert("re-marking (a correction) is allowed, not blocked by the earlier partial mark", full.status === 200, JSON.stringify(full.body));
    const statusFull = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("outstandingAr is fully zeroed once paidAmount covers the whole invoice", statusFull.body.outstandingAr === 0, JSON.stringify(statusFull.body));
    assert("overLimit correctly reflects zero exposure", statusFull.body.overLimit === false);

    console.log("\nMark as Paid — a voided invoice cannot be marked paid");
    const line3 = await addSellLine(shipmentId, token, 200, "THC");
    const doc2 = await generateInvoiceDoc(shipmentId, token, [line3.id]);
    await confirmDoc(doc2.id, token);
    await request("POST", `/api/shipments/${shipmentId}/documents/${doc2.id}/reverse`, { reason: "test" }, token);
    const markVoided = await request("POST", `/api/shipments/${shipmentId}/documents/${doc2.id}/mark-paid`,
      { paidAt: "2026-08-22", paidAmount: 200 }, token);
    assert("marking a voided invoice paid is rejected", markVoided.status === 409, JSON.stringify(markVoided.body));

    console.log("\nfirst_sent_at — null before any send, set by a real successful EDI send");
    const line4 = await addSellLine(shipmentId, token, 300, "FUM");
    const doc3 = await generateInvoiceDoc(shipmentId, token, [line4.id]);
    await confirmDoc(doc3.id, token);
    assert("firstSentAt is null before any send", doc3.firstSentAt === null);

    const ediSend1 = await request("POST", `/api/shipments/${shipmentId}/documents/${doc3.id}/send-edi`,
      { recipientCode: "MAEU", recipientLabel: "Maersk Line" }, token);
    assert("send-edi succeeds (201) against the real, locally running distribution service", ediSend1.status === 201, JSON.stringify(ediSend1.body));

    const docsAfterSend = await request("GET", `/api/shipments/${shipmentId}/documents`, null, token);
    const doc3AfterSend = docsAfterSend.body.find(d => d.id === doc3.id);
    assert("firstSentAt is now set", !!doc3AfterSend?.firstSentAt, JSON.stringify(doc3AfterSend));
    const firstSentAtValue = doc3AfterSend.firstSentAt;

    console.log("\nfirst_sent_at — a second send does NOT overwrite the original (first channel wins)");
    await new Promise(r => setTimeout(r, 1100)); // ensure a genuinely different timestamp if it were (wrongly) overwritten
    const ediSend2 = await request("POST", `/api/shipments/${shipmentId}/documents/${doc3.id}/send-edi`,
      { recipientCode: "SAFM", recipientLabel: "Safmarine" }, token);
    assert("second send-edi also succeeds", ediSend2.status === 201, JSON.stringify(ediSend2.body));
    const docsAfterSend2 = await request("GET", `/api/shipments/${shipmentId}/documents`, null, token);
    const doc3AfterSend2 = docsAfterSend2.body.find(d => d.id === doc3.id);
    assert("firstSentAt is unchanged after a second send", doc3AfterSend2.firstSentAt === firstSentAtValue,
      `before=${firstSentAtValue} after=${doc3AfterSend2.firstSentAt}`);

    console.log("\nCleanup");
    await request("DELETE", `/api/users/${(await request("GET", "/api/users", null, token)).body.find(u => u.email === occEmail)?.id}`, null, token).catch(() => {});
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/customers/${customerId}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("\nFATAL:", e.message);
    process.exit(1);
  }
})();
