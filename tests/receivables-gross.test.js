/**
 * Receivables are gross, statements are receivables, issued invoices stay issued (2026-09-30).
 *
 *  - A customer's outstanding AR, committed exposure and every "outstanding" figure (credit limit
 *    checks, dunning, Billing Performance, Invoice Collections) include VAT — it used to be the net
 *    total only, so a customer's VAT never counted against their credit limit.
 *  - A confirmed consolidated statement is a receivable like an invoice (it used to be missing from
 *    AR, and its lines stayed in committed exposure even after payment).
 *  - An invoice or credit note can be deleted only while draft, and its status only moves forward
 *    (a confirmed one can't go back to draft; a voided one is never re-confirmed).
 *
 * Usage:
 *   node tests/receivables-gross.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - PDF Render Service running on :3003
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

let passed = 0, failed = 0;
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ method, hostname: "localhost", port: 3001, path, headers: {
      "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }),
      ...(payload && { "Content-Length": Buffer.byteLength(payload) }) } }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
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
const near = (a, b) => Math.abs((a ?? NaN) - b) < 0.011;
const SAMPLE_HTML = "<html><body><h1>test fixture</h1></body></html>";
const rand = Math.random().toString(36).slice(2, 7).toUpperCase();

(async () => {
  const cleanup = { shipments: [], customers: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const today = new Date().toISOString().slice(0, 10);

    const cust = await request("POST", "/api/customers", { companyName: `Receivables Test Co ${rand}`, currency: "USD", creditLimit: 100000, creditTermsDays: 30 }, token);
    const customerId = cust.body.id;
    cleanup.customers.push(customerId);
    const newShipment = async () => {
      const r = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", contractRef: `SPOT-RCV-${rand}`,
        etd: "2026-10-12", eta: "2026-10-24", incoterm: "FOB", commodityCode: "002001",
        principalId: customerId, principalName: cust.body.companyName, emoOfficeId, imoOfficeId,
      }, token);
      cleanup.shipments.push(r.body.id);
      return r.body.id;
    };
    const addSell = (shipmentId, body) => request("POST", `/api/shipments/${shipmentId}/cost-lines`,
      { type: "SELL", currency: "USD", exchangeRate: 1, ...body }, token).then(r => r.body.id);
    const genInvoice = (shipmentId, ids, name = "FR01") => request("POST", `/api/shipments/${shipmentId}/documents/generate`,
      { html: SAMPLE_HTML, filename: `${name}-${shipmentId}.html`, docType: "FR01", sourceCostLineIds: ids }, token);
    const status = async () => (await request("GET", `/api/customers/${customerId}/credit-status`, null, token)).body;

    console.log("Invoices: outstanding AR is the gross, VAT included");
    const shipA = await newShipment();
    const ofA = await addSell(shipA, { chargeCode: "Ocean Freight", amount: 1000, vatRate: 20 });
    const zrA = await addSell(shipA, { chargeCode: "Documentation", amount: 150, vatTreatment: "zero_rated" });
    const invA = await genInvoice(shipA, [ofA, zrA]);
    await request("PATCH", `/api/shipments/${shipA}/documents/${invA.body.id}`, { status: "confirmed" }, token);
    const s1 = await status();
    assert("outstanding AR = 1000 × 1.2 + 150 = 1350", near(s1.outstandingAr, 1350), JSON.stringify(s1));
    assert("an uninvoiced 20% line counts at gross in committed exposure (300 → 360)", await (async () => {
      await addSell(shipA, { chargeCode: "Terminal Handling", amount: 300, vatRate: 20 });
      return near((await status()).committedExposure, 360);
    })(), JSON.stringify(await status()));

    const bp = await request("GET", "/api/reports/billing-performance", null, token);
    const bpRow = (bp.body.results || bp.body).find?.(r => r.docId === invA.body.id);
    assert("Billing Performance shows the invoice at gross (1350)", near(bpRow?.amountUsd, 1350) && near(bpRow?.outstandingUsd, 1350), JSON.stringify(bpRow));
    await request("POST", `/api/shipments/${shipA}/documents/${invA.body.id}/mark-paid`, { paidAt: today, paidAmount: 1200 }, token);
    const bp2 = await request("GET", "/api/reports/billing-performance", null, token);
    const bpRow2 = (bp2.body.results || bp2.body).find?.(r => r.docId === invA.body.id);
    assert("paying the net 1200 leaves it PARTIAL with 150 outstanding", bpRow2?.paymentStatus === "partial" && near(bpRow2?.outstandingUsd, 150), JSON.stringify(bpRow2));
    assert("...and outstanding AR drops to 150", near((await status()).outstandingAr, 150));

    console.log("\nStatements are receivables");
    const shipB = await newShipment();
    const stLine = await addSell(shipB, { chargeCode: "Ocean Freight", amount: 500, vatRate: 20 });
    const before = await status();
    const draft = await request("POST", "/api/customer-statements/generate", {
      customerId, dateFrom: "2020-01-01", dateTo: "2030-01-01", costLineIds: [stLine], html: SAMPLE_HTML, filename: "rcv.html" }, token);
    assert("statement generated", draft.status === 201, JSON.stringify(draft.body));
    const sDraft = await status();
    assert("a DRAFT statement bills nothing yet: its line stays in committed exposure and AR is unchanged",
      near(sDraft.committedExposure - before.committedExposure, 0) && near(sDraft.outstandingAr, before.outstandingAr),
      JSON.stringify({ before, sDraft }));
    await request("POST", `/api/customer-statements/${draft.body.id}/confirm`, {}, token);
    const sConf = await status();
    assert("a CONFIRMED statement is outstanding AR at gross (+600)", near(sConf.outstandingAr - before.outstandingAr, 600), JSON.stringify({ before, sConf }));
    assert("...and its line leaves committed exposure (−600)", near(before.committedExposure - sConf.committedExposure, 600), JSON.stringify({ before, sConf }));
    assert("...and it ages from its confirmation (current bucket)", near(sConf.aging.current - before.aging.current, 600), JSON.stringify(sConf.aging));
    await request("POST", `/api/customer-statements/${draft.body.id}/mark-paid`, { paidAt: today, paidAmount: 600 }, token);
    const sPaid = await status();
    assert("once paid it adds nothing to AR or committed exposure", near(sPaid.outstandingAr, before.outstandingAr) && near(sPaid.committedExposure, before.committedExposure - 600),
      JSON.stringify({ before, sPaid }));

    console.log("\nAn issued invoice stays issued");
    const shipC = await newShipment();
    const cLine = await addSell(shipC, { chargeCode: "Ocean Freight", amount: 800 });
    const invC = await genInvoice(shipC, [cLine]);
    await request("PATCH", `/api/shipments/${shipC}/documents/${invC.body.id}`, { status: "confirmed" }, token);
    const delConfirmed = await request("DELETE", `/api/shipments/${shipC}/documents/${invC.body.id}`, null, token);
    assert("a confirmed invoice can't be deleted (409)", delConfirmed.status === 409 && /reverse it/.test(delConfirmed.body.error || ""), JSON.stringify(delConfirmed.body));
    const backToDraft = await request("PATCH", `/api/shipments/${shipC}/documents/${invC.body.id}`, { status: "draft" }, token);
    assert("...nor sent back to draft (409)", backToDraft.status === 409, JSON.stringify(backToDraft.body));
    const voided = await request("PATCH", `/api/shipments/${shipC}/documents/${invC.body.id}`, { status: "voided" }, token);
    assert("voiding it still works", voided.status === 200 && voided.body.status === "voided", JSON.stringify(voided.body));
    const reconfirm = await request("PATCH", `/api/shipments/${shipC}/documents/${invC.body.id}`, { status: "confirmed" }, token);
    assert("a voided invoice is never re-confirmed (409)", reconfirm.status === 409, JSON.stringify(reconfirm.body));
    const delVoided = await request("DELETE", `/api/shipments/${shipC}/documents/${invC.body.id}`, null, token);
    assert("...nor deleted (409)", delVoided.status === 409, JSON.stringify(delVoided.body));
    const draftDoc = await genInvoice(shipC, [cLine], "FR01-again");
    assert("its charge can be invoiced again once it was voided", draftDoc.status === 201, JSON.stringify(draftDoc.body));
    const delDraft = await request("DELETE", `/api/shipments/${shipC}/documents/${draftDoc.body.id}`, null, token);
    assert("a DRAFT invoice can still be deleted", delDraft.status === 200, JSON.stringify(delDraft.body));
    const other = await request("POST", `/api/shipments/${shipC}/documents/generate`, { html: SAMPLE_HTML, filename: `PL01-${shipC}.html`, docType: "PL01" }, token);
    await request("PATCH", `/api/shipments/${shipC}/documents/${other.body.id}`, { status: "confirmed" }, token);
    assert("other document types are unaffected (a confirmed PL01 deletes)",
      (await request("DELETE", `/api/shipments/${shipC}/documents/${other.body.id}`, null, token)).status === 200);

    // Deleting a shipment cascade-deletes its cost lines, so an issued invoice would lose its
    // charges and drop out of the VAT report / GL / AR while the invoice row was left orphaned.
    console.log("\nA shipment that billed its customer can't be deleted");
    const delIssued = await request("DELETE", `/api/shipments/${shipC}`, null, token);
    assert("a shipment with an issued (here: voided) invoice is refused (409), pointing to cancel",
      delIssued.status === 409 && /issued invoices/.test(delIssued.body.error) && /Cancel the shipment/.test(delIssued.body.error), JSON.stringify(delIssued.body));
    const delOnStatement = await request("DELETE", `/api/shipments/${shipB}`, null, token);
    assert("a shipment whose charges are on a confirmed statement is refused (409)",
      delOnStatement.status === 409 && delOnStatement.body.error.includes(draft.body.id), JSON.stringify(delOnStatement.body));
    assert("...and both are still there", (await request("GET", `/api/shipments/${shipC}`, null, token)).status === 200
      && (await request("GET", `/api/shipments/${shipB}`, null, token)).status === 200);

    const shipD = await newShipment();
    const dLine = await addSell(shipD, { chargeCode: "Ocean Freight", amount: 250, vatRate: 20 });
    const draftStmt = await request("POST", "/api/customer-statements/generate", {
      customerId, dateFrom: "2020-01-01", dateTo: "2030-01-01", costLineIds: [dLine], html: SAMPLE_HTML, filename: "rcv-draft.html" }, token);
    const delOnDraft = await request("DELETE", `/api/shipments/${shipD}`, null, token);
    assert("charges on a DRAFT statement: refused, asking to void that draft first", delOnDraft.status === 409 && /Void the draft statement/.test(delOnDraft.body.error),
      JSON.stringify(delOnDraft.body));
    await request("POST", `/api/customer-statements/${draftStmt.body.id}/void`, {}, token);
    assert("...and once it's voided the shipment deletes", (await request("DELETE", `/api/shipments/${shipD}`, null, token)).status === 200);

    const shipE = await newShipment();
    const eLine = await addSell(shipE, { chargeCode: "Ocean Freight", amount: 90 });
    const eDraft = await genInvoice(shipE, [eLine]);
    const ePl = await request("POST", `/api/shipments/${shipE}/documents/generate`, { html: SAMPLE_HTML, filename: `PL01-${shipE}.html`, docType: "PL01" }, token);
    const delE = await request("DELETE", `/api/shipments/${shipE}`, null, token);
    assert("a shipment with only a draft invoice and a packing list deletes (200)", delE.status === 200, JSON.stringify(delE.body));
    assert("...and takes its documents with it (no orphaned rows)",
      (await request("DELETE", `/api/shipments/${shipE}/documents/${eDraft.body.id}`, null, token)).status === 404
      && (await request("DELETE", `/api/shipments/${shipE}/documents/${ePl.body.id}`, null, token)).status === 404);
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    console.log("\nCleanup");
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  }
})();
