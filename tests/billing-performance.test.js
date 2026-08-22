/**
 * Invoicing Discipline & Billing Performance (Epic TKT-KR6ZBT) — Stories 1, 2, 3 & 4.
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
 * Story 3 (TKT-YC7PZP, invoice-generation deadline): customers.invoice_deadline_days mirrors
 * credit_terms_days exactly (nullable, per-customer). GET /api/invoice-deadlines/overdue is
 * purely informational (never a block) — a shipment appears once its own "delivered" milestone
 * has been completed longer ago than the responsible party's configured deadline, with no
 * confirmed FR01/FR02 yet.
 *
 * Story 4 (TKT-B4VBDH, Billing Performance report): GET /api/reports/billing-performance
 * returns row-level FR01/FR02 invoices enriched with status/sent/payment/office/customer/lane/
 * carrier, gated by the same finance access (canViewFinance or admin) Reports and Margin
 * already use.
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

    console.log("\ninvoiceDeadlineDays — round-trips through customer create/update, mirrors creditTermsDays");
    const custDl = await request("POST", "/api/customers", { companyName: "Test Deadline Co", invoiceDeadlineDays: 5 }, token);
    assert("invoiceDeadlineDays round-trips on create", custDl.body.invoiceDeadlineDays === 5, JSON.stringify(custDl.body));
    const custDlUpdate = await request("PUT", `/api/customers/${custDl.body.id}`, { companyName: "Test Deadline Co", invoiceDeadlineDays: 10 }, token);
    assert("invoiceDeadlineDays round-trips on update", custDlUpdate.body.invoiceDeadlineDays === 10, JSON.stringify(custDlUpdate.body));
    const custDlBlank = await request("PUT", `/api/customers/${custDl.body.id}`, { companyName: "Test Deadline Co", invoiceDeadlineDays: "" }, token);
    assert("blank clears it back to null (no deadline configured)", custDlBlank.body.invoiceDeadlineDays === null, JSON.stringify(custDlBlank.body));

    console.log("\nInvoice-deadline queue — a shipment delivered past its deadline with no confirmed invoice shows up");
    await request("PUT", `/api/customers/${custDl.body.id}`, { companyName: "Test Deadline Co", invoiceDeadlineDays: 5 }, token);
    const shipDl = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: custDl.body.id, principalName: "Test Deadline Co",
    }, token);
    const shipDlId = shipDl.body.id;
    await request("POST", `/api/shipments/${shipDlId}/milestones/init`, {}, token);
    const milestones = await request("GET", `/api/shipments/${shipDlId}/milestones`, null, token);
    const deliveredMs = milestones.body.find(m => m.milestoneKey === "delivered");
    assert("delivered milestone exists from the init template", !!deliveredMs, JSON.stringify(milestones.body.map(m => m.milestoneKey)));

    const beforeComplete = await request("GET", "/api/invoice-deadlines/overdue", null, token);
    assert("not yet in the queue — delivered milestone isn't completed yet", !beforeComplete.body.some(d => d.shipmentId === shipDlId));

    // 12 days ago, deadline is 5 days -> 7 days overdue
    const twelveDaysAgo = new Date(Date.now() - 12 * 86400000).toISOString();
    await request("PUT", `/api/milestones/${deliveredMs.id}`, { completedAt: twelveDaysAgo }, token);

    const afterComplete = await request("GET", "/api/invoice-deadlines/overdue", null, token);
    const queueRow = afterComplete.body.find(d => d.shipmentId === shipDlId);
    assert("shows up in the overdue queue once delivered past the deadline with no invoice", !!queueRow, JSON.stringify(afterComplete.body));
    assert("daysOverdue is roughly 7 (12 days since delivery - 5 day deadline)", queueRow && queueRow.daysOverdue >= 6 && queueRow.daysOverdue <= 8, JSON.stringify(queueRow));
    assert("companyName is the responsible party", queueRow?.companyName === "Test Deadline Co");

    console.log("\nInvoice-deadline queue — disappears once a confirmed invoice exists");
    const lineDl = await addSellLine(shipDlId, token, 500, "OFR");
    const docDl = await generateInvoiceDoc(shipDlId, token, [lineDl.id]);
    await confirmDoc(docDl.id, token);
    const afterInvoice = await request("GET", "/api/invoice-deadlines/overdue", null, token);
    assert("no longer in the queue once invoiced", !afterInvoice.body.some(d => d.shipmentId === shipDlId), JSON.stringify(afterInvoice.body));

    console.log("\nInvoice-deadline queue — a customer with no invoiceDeadlineDays configured never appears");
    const custNoDl = await request("POST", "/api/customers", { companyName: "Test No Deadline Co" }, token);
    const shipNoDl = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: custNoDl.body.id, principalName: "Test No Deadline Co",
    }, token);
    await request("POST", `/api/shipments/${shipNoDl.body.id}/milestones/init`, {}, token);
    const milestonesNoDl = await request("GET", `/api/shipments/${shipNoDl.body.id}/milestones`, null, token);
    const deliveredNoDl = milestonesNoDl.body.find(m => m.milestoneKey === "delivered");
    await request("PUT", `/api/milestones/${deliveredNoDl.id}`, { completedAt: twelveDaysAgo }, token);
    const queueNoDl = await request("GET", "/api/invoice-deadlines/overdue", null, token);
    assert("never appears without invoiceDeadlineDays configured", !queueNoDl.body.some(d => d.shipmentId === shipNoDl.body.id), JSON.stringify(queueNoDl.body));

    console.log("\nBilling Performance report — finance gate");
    const reportAsOcc = await request("GET", "/api/reports/billing-performance", null, occLogin.body.token);
    assert("occ_bk with no canViewFinance flag is rejected (403)", reportAsOcc.status === 403, JSON.stringify(reportAsOcc.body));

    console.log("\nBilling Performance report — row shape tracks a real invoice through its whole lifecycle");
    const custBp = await request("POST", "/api/customers", { companyName: "Test Billing Report Co", creditTermsDays: 0 }, token);
    const shipBp = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: custBp.body.id, principalName: "Test Billing Report Co",
    }, token);
    const shipBpId = shipBp.body.id;
    const lineBp = await addSellLine(shipBpId, token, 1000, "OFR");
    const docBp = await generateInvoiceDoc(shipBpId, token, [lineBp.id]);

    const reportRow = async () => {
      const rpt = await request("GET", "/api/reports/billing-performance", null, token);
      return rpt.body.find(r => r.docId === docBp.id);
    };

    let row = await reportRow();
    assert("draft invoice appears with status draft, no payment status, not sent",
      row && row.status === "draft" && row.paymentStatus === null && row.sent === false, JSON.stringify(row));
    assert("amountUsd correctly resolved from the source cost line", row?.amountUsd === 1000, JSON.stringify(row));
    assert("customer/carrier/lane correctly resolved", row?.customerName === "Test Billing Report Co" && row?.carrierCode === "MAEU" && row?.laneCode === "EU-N", JSON.stringify(row));

    await confirmDoc(docBp.id, token);
    row = await reportRow();
    assert("confirmed invoice shows paymentStatus unpaid, full amount outstanding", row?.status === "confirmed" && row?.paymentStatus === "unpaid" && row?.outstandingUsd === 1000, JSON.stringify(row));

    await request("POST", `/api/shipments/${shipBpId}/documents/${docBp.id}/mark-paid`, { paidAt: "2026-08-20", paidAmount: 400 }, token);
    row = await reportRow();
    assert("partially paid invoice shows paymentStatus partial with the right remaining balance", row?.paymentStatus === "partial" && row?.outstandingUsd === 600, JSON.stringify(row));

    await request("POST", `/api/shipments/${shipBpId}/documents/${docBp.id}/mark-paid`, { paidAt: "2026-08-21", paidAmount: 1000 }, token);
    row = await reportRow();
    assert("fully paid invoice shows paymentStatus paid, zero outstanding", row?.paymentStatus === "paid" && row?.outstandingUsd === 0, JSON.stringify(row));

    const ediSendBp = await request("POST", `/api/shipments/${shipBpId}/documents/${docBp.id}/send-edi`, { recipientCode: "MAEU", recipientLabel: "Maersk Line" }, token);
    assert("send-edi for the report test fixture succeeds", ediSendBp.status === 201, JSON.stringify(ediSendBp.body));
    row = await reportRow();
    assert("sent invoice shows sent:true with a firstSentAt", row?.sent === true && !!row?.firstSentAt, JSON.stringify(row));

    console.log("\nBilling Performance report — a voided invoice carries no payment status (matches Draft, not Confirmed)");
    const lineBp2 = await addSellLine(shipBpId, token, 200, "DOC");
    const docBp2 = await generateInvoiceDoc(shipBpId, token, [lineBp2.id]);
    await confirmDoc(docBp2.id, token);
    await request("POST", `/api/shipments/${shipBpId}/documents/${docBp2.id}/reverse`, { reason: "test" }, token);
    const rpt2 = await request("GET", "/api/reports/billing-performance", null, token);
    const rowVoided = rpt2.body.find(r => r.docId === docBp2.id);
    assert("voided invoice shows status voided with no payment status", rowVoided?.status === "voided" && rowVoided?.paymentStatus === null, JSON.stringify(rowVoided));

    console.log("\nBilling Performance report — CSV export");
    const csvRes = await new Promise((resolve, reject) => {
      const req = http.request({ method: "GET", hostname: "localhost", port: 3001,
        path: "/api/reports/billing-performance?format=csv", headers: { Authorization: `Bearer ${token}` } },
        res => { let data = ""; res.on("data", c => data += c); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data })); });
      req.on("error", reject); req.end();
    });
    assert("CSV export returns 200 with a csv content-type", csvRes.status === 200 && /text\/csv/.test(csvRes.headers["content-type"] || ""), JSON.stringify(csvRes.headers));
    assert("CSV body has a header row and at least one data row", csvRes.body.split("\n").length >= 2 && csvRes.body.includes("Shipment"));

    console.log("\nCleanup");
    await request("DELETE", `/api/users/${(await request("GET", "/api/users", null, token)).body.find(u => u.email === occEmail)?.id}`, null, token).catch(() => {});
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/customers/${customerId}`, null, token);
    await request("DELETE", `/api/shipments/${shipDlId}`, null, token);
    await request("DELETE", `/api/customers/${custDl.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipNoDl.body.id}`, null, token);
    await request("DELETE", `/api/customers/${custNoDl.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipBpId}`, null, token);
    await request("DELETE", `/api/customers/${custBp.body.id}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("\nFATAL:", e.message);
    process.exit(1);
  }
})();
