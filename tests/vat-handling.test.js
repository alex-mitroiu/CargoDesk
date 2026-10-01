/**
 * Tax handling — branch VAT registration numbers, input VAT on BUY lines, VAT treatment
 * (standard / zero-rated / reverse charge / exempt), the VAT Liability report, and the
 * issued-document rule shared with GL Export (a properly reversed invoice still counts in its
 * own period, netted by its CN01; a bare manual void never counted).
 *
 * Usage:
 *   node tests/vat-handling.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - PDF Render Service running on :3003 (invoice / credit note generation renders a real PDF)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices, retireOffice, retireBranch } from "./helpers/offices.mjs";

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

const SAMPLE_HTML = `<html><body><h1>Tax document (test fixture)</h1></body></html>`;
const rand = Math.random().toString(36).slice(2, 5).toUpperCase().replace(/[^A-Z]/g, "Q").padEnd(3, "Q");
const near = (a, b) => Math.abs(a - b) < 0.01;

(async () => {
  let token, branchId, officeId;
  const shipments = [];
  try {
    console.log("Logging in...");
    token = await login();
    console.log("  ✓ Logged in");
    const { imoOfficeId } = await ensureOffices(token);
    const today = new Date().toISOString().slice(0, 10);

    console.log("\nBranch VAT registration number — create, update, preserved when omitted");
    const branch = await request("POST", "/api/branches", {
      code: `VT${rand}`, name: `VAT Test Entity ${rand} Ltd`, countryCode: "GB", currency: "EUR",
      taxRegistrationNumber: `GB${rand}123456`,
    }, token);
    assert("branch created with a tax number", branch.status === 200 && branch.body.taxRegistrationNumber === `GB${rand}123456`, JSON.stringify(branch.body));
    branchId = branch.body.id;
    const renamed = await request("PUT", `/api/branches/${branchId}`, { name: `VAT Test Entity ${rand} Limited` }, token);
    assert("an update that omits the tax number keeps it", renamed.body.taxRegistrationNumber === `GB${rand}123456`, JSON.stringify(renamed.body));
    const retaxed = await request("PUT", `/api/branches/${branchId}`, { taxRegistrationNumber: `GB${rand}999999` }, token);
    assert("the tax number itself can be changed", retaxed.body.taxRegistrationNumber === `GB${rand}999999`);

    // An office in the scratch branch, so the report's entity attribution is deterministic.
    const office = await request("POST", "/api/offices", {
      unlocode: `GB${rand}`, countryCode: "GB", department: "SE", name: `VAT Test Office ${rand}`, branchId,
    }, token);
    assert("scratch SE office created in the branch", !!office.body.id, JSON.stringify(office.body));
    officeId = office.body.id;

    const newShipment = async () => {
      const s = await request("POST", "/api/shipments", {
        pol: "GBFXT", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", etd: "2026-10-15",
        emoOfficeId: officeId, imoOfficeId,
      }, token);
      shipments.push(s.body.id);
      return s.body.id;
    };
    const addLine = (shipmentId, body) => request("POST", `/api/shipments/${shipmentId}/cost-lines`, { currency: "USD", exchangeRate: 1, ...body }, token);

    console.log("\nCost-line VAT — input VAT on BUY, treatment validation and forcing");
    const shipA = await newShipment();
    assert("shipment created", !!shipA);
    const buy = await addLine(shipA, { type: "BUY", chargeCode: "Ocean Freight", amount: 400, vatRate: 20 });
    assert("a BUY line keeps its VAT rate (input VAT) instead of being forced to 0", buy.status === 201 && buy.body.vatRate === 20, JSON.stringify(buy.body));
    const badTreatment = await addLine(shipA, { type: "SELL", chargeCode: "Other", amount: 10, vatTreatment: "half_rated" });
    assert("an unknown VAT treatment is rejected", badTreatment.status === 400, JSON.stringify(badTreatment.body));
    const badRate = await addLine(shipA, { type: "SELL", chargeCode: "Other", amount: 10, vatRate: 150 });
    assert("a VAT rate over 100% is rejected", badRate.status === 400, JSON.stringify(badRate.body));
    const zero = await addLine(shipA, { type: "SELL", chargeCode: "Inland", amount: 500, vatRate: 20, vatTreatment: "zero_rated" });
    assert("zero-rated forces the rate to 0 even when 20 was sent", zero.body.vatRate === 0 && zero.body.vatTreatment === "zero_rated", JSON.stringify(zero.body));
    const rc = await addLine(shipA, { type: "SELL", chargeCode: "Customs", amount: 300, vatTreatment: "reverse_charge" });
    assert("reverse charge is stored", rc.body.vatTreatment === "reverse_charge");
    const rcEdit = await request("PUT", `/api/shipments/${shipA}/cost-lines/${rc.body.id}`,
      { type: "SELL", chargeCode: "Customs", currency: "USD", amount: 300, exchangeRate: 1, notes: "edited" }, token);
    assert("an edit that omits vatTreatment keeps reverse charge (never silently resets to standard)", rcEdit.body.vatTreatment === "reverse_charge", JSON.stringify(rcEdit.body));
    const std = await addLine(shipA, { type: "SELL", chargeCode: "Ocean Freight", amount: 1000, vatRate: 20 });
    assert("a standard-rated SELL line", std.body.vatRate === 20 && std.body.vatTreatment === "standard");

    await request("PATCH", `/api/shipments/${shipA}/cost-lines/${buy.body.id}/actualize`, { actualAmount: 400 }, token);
    const posted = await request("PATCH", `/api/shipments/${shipA}/cost-lines/${buy.body.id}/post`, {}, token);
    assert("BUY line posted", posted.body.status === "posted");

    const invoice = await request("POST", `/api/shipments/${shipA}/documents/generate`, {
      html: SAMPLE_HTML, filename: `FR01-${shipA}.html`, docType: "FR01",
      sourceCostLineIds: [std.body.id, zero.body.id, rc.body.id],
    }, token);
    const confirmed = await request("PATCH", `/api/shipments/${shipA}/documents/${invoice.body.id}`, { status: "confirmed" }, token);
    assert("invoice generated and confirmed", confirmed.body.status === "confirmed", JSON.stringify(invoice.body));

    console.log("\nVAT Liability report — per-entity output/input VAT and treatment buckets");
    const missing = await request("GET", "/api/vat-liability/summary", null, token);
    assert("dates are required", missing.status === 400);
    const inverted = await request("GET", `/api/vat-liability/summary?dateFrom=2026-12-31&dateTo=2026-01-01`, null, token);
    assert("an inverted date range is rejected", inverted.status === 400);
    const r1 = await request("GET", `/api/vat-liability/summary?dateFrom=${today}&dateTo=${today}`, null, token);
    assert("report returns 200", r1.status === 200, JSON.stringify(r1.body));
    const e1 = r1.body.entities.find(e => e.entityId === branchId);
    assert("the scratch branch appears as its own entity", !!e1, JSON.stringify(r1.body.entities.map(e => e.entityId)));
    assert("it carries the branch's VAT number", e1?.taxRegistrationNumber === `GB${rand}999999`);
    assert("standard-rated output: base 1000, VAT 200", near(e1.output.standard.baseUsd, 1000) && near(e1.output.standard.vatUsd, 200), JSON.stringify(e1.output));
    assert("zero-rated output base is reported separately (500)", near(e1.output.zero_rated.baseUsd, 500));
    assert("reverse-charge output base is reported separately (300)", near(e1.output.reverse_charge.baseUsd, 300));
    assert("input VAT from the posted BUY line: base 400, VAT 80", near(e1.input.standard.baseUsd, 400) && near(e1.input.standard.vatUsd, 80), JSON.stringify(e1.input));
    assert("net VAT = 200 - 80 = 120", near(e1.netVatUsd, 120), String(e1?.netVatUsd));
    assert("a local-currency net figure is present for a non-USD entity", typeof e1.localNetVat === "number" && e1.currency === "EUR");

    console.log("\nA properly reversed invoice still counts, and its credit note nets it out");
    const rev = await request("POST", `/api/shipments/${shipA}/documents/${invoice.body.id}/reverse`, { reason: "Test reversal" }, token);
    assert("reverse returns 200", rev.status === 200, JSON.stringify(rev.body));
    const revRc = rev.body.reversalLines.find(l => l.chargeCode === "Customs");
    assert("the reversal line keeps the original's reverse-charge treatment", revRc?.vatTreatment === "reverse_charge", JSON.stringify(revRc));
    const cn = await request("POST", `/api/shipments/${shipA}/documents/generate`, {
      html: SAMPLE_HTML, filename: `CN01-${shipA}.html`, docType: "CN01",
      sourceCostLineIds: rev.body.reversalLines.map(l => l.id), relatedDocId: invoice.body.id,
    }, token);
    await request("PATCH", `/api/shipments/${shipA}/documents/${cn.body.id}`, { status: "confirmed" }, token);
    await request("PATCH", `/api/shipments/${shipA}/documents/${invoice.body.id}`, { relatedDocId: cn.body.id }, token);
    const r2 = await request("GET", `/api/vat-liability/summary?dateFrom=${today}&dateTo=${today}`, null, token);
    const e2 = r2.body.entities.find(e => e.entityId === branchId);
    assert("output VAT nets to 0 — the voided original (+200) still counts and the CN01 (-200) offsets it",
      near(e2.output.standard.vatUsd, 0) && near(e2.output.standard.baseUsd, 0), JSON.stringify(e2.output.standard));
    assert("reverse-charge base nets to 0 too", near(e2.output.reverse_charge.baseUsd, 0));
    assert("net VAT is now just the reclaimable input VAT (-80)", near(e2.netVatUsd, -80), String(e2.netVatUsd));

    console.log("\nA bare manual void (no credit note) never counted as issued");
    const shipB = await newShipment();
    const lineB = await addLine(shipB, { type: "SELL", chargeCode: "Ocean Freight", amount: 1000, vatRate: 20 });
    const invB = await request("POST", `/api/shipments/${shipB}/documents/generate`, {
      html: SAMPLE_HTML, filename: `FR01-${shipB}.html`, docType: "FR01", sourceCostLineIds: [lineB.body.id],
    }, token);
    await request("PATCH", `/api/shipments/${shipB}/documents/${invB.body.id}`, { status: "confirmed" }, token);
    await request("PATCH", `/api/shipments/${shipB}/documents/${invB.body.id}`, { status: "voided" }, token);
    const r3 = await request("GET", `/api/vat-liability/summary?dateFrom=${today}&dateTo=${today}`, null, token);
    const e3 = r3.body.entities.find(e => e.entityId === branchId);
    assert("the manually voided invoice adds no output VAT", near(e3.output.standard.vatUsd, 0), JSON.stringify(e3.output.standard));

    console.log("\nGL Export uses the same rule — a reversed-before-export invoice exports alongside its CN01");
    const gl = await request("POST", "/api/gl-export/run", { dateFrom: today, dateTo: today }, token);
    assert("GL export run returns 201", gl.status === 201, JSON.stringify(gl.body).slice(0, 200));
    const refs = new Set(gl.body.rows.map(r => r.reference));
    assert("the voided original invoice IS exported (it was issued)", refs.has(invoice.body.id));
    assert("its CN01 is exported too", refs.has(cn.body.id));
    assert("the bare manual void is NOT exported", !refs.has(invB.body.id));
    const arOriginal = gl.body.rows.find(r => r.reference === invoice.body.id && r.debit > 0)?.debit;
    const arCredit   = gl.body.rows.find(r => r.reference === cn.body.id && r.debit !== 0)?.debit;
    assert("the two AR postings are equal and opposite (net zero)", near((arOriginal || 0) + (arCredit || 0), 0), `${arOriginal} / ${arCredit}`);

    // TKT-MQAXQX (decided 2026-09-30): the rate comes from the buying legal entity (branch).
    console.log("\nA reverse-charged purchase is self-assessed at the entity's standard VAT rate");
    const shipC = await newShipment();
    const rcBuy = await addLine(shipC, { type: "BUY", chargeCode: "Ocean Freight", amount: 500, vatTreatment: "reverse_charge" });
    await request("PATCH", `/api/shipments/${shipC}/cost-lines/${rcBuy.body.id}/post`, {}, token);
    const summary = async () => (await request("GET", `/api/vat-liability/summary?dateFrom=${today}&dateTo=${today}`, null, token)).body.entities.find(e => e.entityId === branchId);
    const beforeRate = await summary();
    assert("with no rate on the entity: base-only, and the entity is flagged",
      beforeRate.selfAssessRateMissing === true && near(beforeRate.input.reverse_charge.baseUsd, 500) && near(beforeRate.output.self_assessed.vatUsd, 0),
      JSON.stringify({ flag: beforeRate.selfAssessRateMissing, input: beforeRate.input }));
    const badVatRate = await request("PUT", `/api/branches/${branchId}`, { standardVatRate: 150 }, token);
    assert("a rate over 100% is refused", badVatRate.status === 400, JSON.stringify(badVatRate.body));
    const setRate = await request("PUT", `/api/branches/${branchId}`, { standardVatRate: 20 }, token);
    assert("the branch stores its standard VAT rate", setRate.status === 200 && setRate.body.standardVatRate === 20, JSON.stringify(setRate.body));
    const afterRate = await summary();
    assert("self-assessed: 500 × 20% = 100 on output AND input", near(afterRate.output.self_assessed.baseUsd, 500) && near(afterRate.output.self_assessed.vatUsd, 100)
      && near(afterRate.input.self_assessed.vatUsd, 100) && afterRate.selfAssessRateMissing === false, JSON.stringify({ o: afterRate.output.self_assessed, i: afterRate.input.self_assessed }));
    assert("both totals rise by 100", near(afterRate.output.totalVatUsd - beforeRate.output.totalVatUsd, 100) && near(afterRate.input.totalVatUsd - beforeRate.input.totalVatUsd, 100));
    assert("net VAT is unchanged", near(afterRate.netVatUsd, beforeRate.netVatUsd), `${beforeRate.netVatUsd} → ${afterRate.netVatUsd}`);
    assert("a reverse-charged SALE is still the customer's to account for (not self-assessed)", near(afterRate.output.reverse_charge.baseUsd, beforeRate.output.reverse_charge.baseUsd));
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    console.log("\nCleanup");
    // A leftover active SE office would be picked up by other tests' ensureOffices(), so this
    // runs even when an assertion above threw.
    for (const id of shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    // Billed shipments can't be deleted, so the office/branch they reference are deactivated instead.
    await retireOffice(token, officeId).catch(() => {});
    await retireBranch(token, branchId).catch(() => {});
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  }
})();
