/**
 * Consolidated/Statement Billing — eligible-lines resolution (excludes already-invoiced and
 * already-statemented lines, includes a voided statement's lines back in the pool), generate ->
 * confirm -> mark-paid lifecycle, draft-only void, and credit-hold/over-limit gating.
 *
 * Usage:
 *   node tests/customer-statements.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - PDF Render Service running on :3003
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

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

const SAMPLE_HTML = `<html><body><h1>Statement (test fixture)</h1></body></html>`;
const rand = Math.random().toString(36).slice(2, 8).toUpperCase();

(async () => {
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);

    console.log("\nScratch customer + 2 shipments, each with an unbilled SELL line");
    const customer = await request("POST", "/api/customers", { companyName: `Statement Test Co ${rand}`, currency: "USD" }, token);
    assert("scratch customer created", !!customer.body.id, JSON.stringify(customer.body));
    const customerId = customer.body.id;

    const shipA = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", etd: "2026-09-01",
      emoOfficeId, imoOfficeId, principalId: customerId,
    }, token);
    const shipB = await request("POST", "/api/shipments", {
      pol: "DEHAM", pod: "USLAX", carrierCode: "MAEU", status: "Active", contractType: "SPOT", etd: "2026-09-02",
      emoOfficeId, imoOfficeId, principalId: customerId,
    }, token);
    assert("both shipments created", !!shipA.body.id && !!shipB.body.id);
    const shipmentIdA = shipA.body.id, shipmentIdB = shipB.body.id;

    const lineA = await request("POST", `/api/shipments/${shipmentIdA}/cost-lines`, { type: "SELL", chargeCode: "Ocean Freight", currency: "USD", amount: 500, exchangeRate: 1 }, token);
    const lineB = await request("POST", `/api/shipments/${shipmentIdB}/cost-lines`, { type: "SELL", chargeCode: "Inland", currency: "USD", amount: 200, exchangeRate: 1 }, token);
    assert("both SELL lines created", !!lineA.body.id && !!lineB.body.id);

    const today = new Date().toISOString().slice(0, 10);
    const wide = { dateFrom: "2020-01-01", dateTo: "2030-01-01" };

    console.log("\nEligible-lines preview shows both, unfiltered");
    const eligible1 = await request("GET", `/api/customer-statements/eligible-lines?customerId=${customerId}&dateFrom=${wide.dateFrom}&dateTo=${wide.dateTo}`, null, token);
    assert("eligible-lines returns 200", eligible1.status === 200, JSON.stringify(eligible1.body));
    assert("both lines are eligible before any billing", eligible1.body.some(l => l.id === lineA.body.id) && eligible1.body.some(l => l.id === lineB.body.id), JSON.stringify(eligible1.body));

    console.log("\nA line already on a confirmed per-shipment invoice is excluded");
    const invA = await request("POST", `/api/shipments/${shipmentIdA}/documents/generate`, {
      html: SAMPLE_HTML, filename: `FR01-${shipmentIdA}.html`, docType: "FR01", sourceCostLineIds: [lineA.body.id],
    }, token);
    await request("PATCH", `/api/shipments/${shipmentIdA}/documents/${invA.body.id}`, { status: "confirmed" }, token);
    const eligible2 = await request("GET", `/api/customer-statements/eligible-lines?customerId=${customerId}&dateFrom=${wide.dateFrom}&dateTo=${wide.dateTo}`, null, token);
    assert("the individually-invoiced line is no longer eligible", !eligible2.body.some(l => l.id === lineA.body.id), JSON.stringify(eligible2.body));
    assert("the other shipment's line is still eligible", eligible2.body.some(l => l.id === lineB.body.id));

    console.log("\nGenerate a statement for the remaining eligible line");
    const gen = await request("POST", "/api/customer-statements/generate", {
      customerId, dateFrom: wide.dateFrom, dateTo: wide.dateTo, costLineIds: [lineB.body.id],
      html: SAMPLE_HTML, filename: `STMT-${customerId}.html`,
    }, token);
    assert("statement generated (201)", gen.status === 201, JSON.stringify(gen.body));
    assert("status starts draft", gen.body.status === "draft");
    assert("total matches the one line", gen.body.totalAmount === 200);
    assert("one line recorded", gen.body.lines.length === 1 && gen.body.lines[0].costLineId === lineB.body.id);
    const statementId = gen.body.id;

    console.log("\nThat line is now excluded from a NEW eligible-lines preview (draft statement holds it)");
    const eligible3 = await request("GET", `/api/customer-statements/eligible-lines?customerId=${customerId}&dateFrom=${wide.dateFrom}&dateTo=${wide.dateTo}`, null, token);
    assert("the statemented line is no longer eligible", !eligible3.body.some(l => l.id === lineB.body.id), JSON.stringify(eligible3.body));

    console.log("\nGenerating with an empty selection is rejected");
    const genEmpty = await request("POST", "/api/customer-statements/generate", { customerId, dateFrom: wide.dateFrom, dateTo: wide.dateTo, costLineIds: [], html: SAMPLE_HTML, filename: "x.html" }, token);
    assert("empty costLineIds rejected", genEmpty.status >= 400);

    console.log("\nList + get");
    const list = await request("GET", `/api/customer-statements?customerId=${customerId}`, null, token);
    assert("list includes the new statement", list.body.some(s => s.id === statementId));
    const get = await request("GET", `/api/customer-statements/${statementId}`, null, token);
    assert("get returns the full line detail", get.body.lines.length === 1);

    console.log("\nConfirm, then Mark as Paid");
    const confirm = await request("POST", `/api/customer-statements/${statementId}/confirm`, {}, token);
    assert("confirm returns 200", confirm.status === 200 && confirm.body.status === "confirmed");
    const confirmAgain = await request("POST", `/api/customer-statements/${statementId}/confirm`, {}, token);
    assert("confirming an already-confirmed statement is rejected", confirmAgain.status >= 400);
    const voidConfirmed = await request("POST", `/api/customer-statements/${statementId}/void`, {}, token);
    assert("voiding a CONFIRMED statement is rejected (only drafts can be voided)", voidConfirmed.status >= 400, JSON.stringify(voidConfirmed.body));
    const markPaid = await request("POST", `/api/customer-statements/${statementId}/mark-paid`, { paidAt: today, paidAmount: 200 }, token);
    assert("mark-paid returns 200", markPaid.status === 200 && markPaid.body.paidAmount === 200);

    console.log("\nDownload the generated PDF");
    const download = await new Promise((resolve, reject) => {
      const req = http.request({ method: "GET", hostname: "localhost", port: 3001, path: `/api/customer-statements/${statementId}/download`,
        headers: { Authorization: `Bearer ${token}` } }, res => { res.on("data", () => {}); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end();
    });
    assert("download returns 200", download === 200);

    console.log("\nA voided statement's lines return to the eligible pool");
    const lineC = await request("POST", `/api/shipments/${shipmentIdA}/cost-lines`, { type: "SELL", chargeCode: "Haulage", currency: "USD", amount: 80, exchangeRate: 1 }, token);
    const draftGen = await request("POST", "/api/customer-statements/generate", {
      customerId, dateFrom: wide.dateFrom, dateTo: wide.dateTo, costLineIds: [lineC.body.id], html: SAMPLE_HTML, filename: "draft.html",
    }, token);
    assert("second draft statement generated", draftGen.status === 201);
    const eligible4 = await request("GET", `/api/customer-statements/eligible-lines?customerId=${customerId}&dateFrom=${wide.dateFrom}&dateTo=${wide.dateTo}`, null, token);
    assert("the new line is excluded while its draft statement exists", !eligible4.body.some(l => l.id === lineC.body.id));
    const voidDraft = await request("POST", `/api/customer-statements/${draftGen.body.id}/void`, {}, token);
    assert("voiding a draft succeeds", voidDraft.status === 200 && voidDraft.body.status === "voided");
    const eligible5 = await request("GET", `/api/customer-statements/eligible-lines?customerId=${customerId}&dateFrom=${wide.dateFrom}&dateTo=${wide.dateTo}`, null, token);
    assert("the line is eligible again after its statement was voided", eligible5.body.some(l => l.id === lineC.body.id), JSON.stringify(eligible5.body));

    console.log("\nCredit hold blocks statement generation");
    // PUT /api/customers/:id is a full-replace (requires companyName) — not a partial PATCH.
    const holdOn = await request("PUT", `/api/customers/${customerId}`, { companyName: customer.body.companyName, creditHold: true, creditHoldReason: "Test hold" }, token);
    assert("credit hold set", holdOn.status === 200, JSON.stringify(holdOn.body));
    const heldGen = await request("POST", "/api/customer-statements/generate", {
      customerId, dateFrom: wide.dateFrom, dateTo: wide.dateTo, costLineIds: [lineC.body.id], html: SAMPLE_HTML, filename: "held.html",
    }, token);
    assert("generation blocked while on credit hold (409)", heldGen.status === 409, JSON.stringify(heldGen.body));
    await request("PUT", `/api/customers/${customerId}`, { companyName: customer.body.companyName, creditHold: false }, token);

    console.log("\nMixed-currency selection is rejected");
    const lineEur = await request("POST", `/api/shipments/${shipmentIdA}/cost-lines`, { type: "SELL", chargeCode: "Customs", currency: "EUR", amount: 40, exchangeRate: 1.08 }, token);
    const mixedGen = await request("POST", "/api/customer-statements/generate", {
      customerId, dateFrom: wide.dateFrom, dateTo: wide.dateTo, costLineIds: [lineC.body.id, lineEur.body.id], html: SAMPLE_HTML, filename: "mixed.html",
    }, token);
    assert("mixed-currency generate is rejected", mixedGen.status >= 400, JSON.stringify(mixedGen.body));

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentIdA}`, null, token);
    await request("DELETE", `/api/shipments/${shipmentIdB}`, null, token);
    await request("DELETE", `/api/customers/${customerId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
