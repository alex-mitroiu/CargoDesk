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
import { ensureOffices, retireOffice, retireBranch } from "./helpers/offices.mjs";

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

    console.log("\nMixed-currency selection is rejected");
    const lineEur = await request("POST", `/api/shipments/${shipmentIdA}/cost-lines`, { type: "SELL", chargeCode: "Customs", currency: "EUR", amount: 40, exchangeRate: 1.08 }, token);
    const mixedGen = await request("POST", "/api/customer-statements/generate", {
      customerId, dateFrom: wide.dateFrom, dateTo: wide.dateTo, costLineIds: [lineC.body.id, lineEur.body.id], html: SAMPLE_HTML, filename: "mixed.html",
    }, token);
    assert("mixed-currency generate is rejected for the currency", mixedGen.status === 400 && /currency/i.test(mixedGen.body.error || ""), JSON.stringify(mixedGen.body));

    // ── TKT-6T97DY — statements are scoped like shipments (decided 2026-09-30: visible only when
    // the caller can see EVERY shipment on it; no finance gate on top). shipA is NLRTM → USNYC,
    // shipB is DEHAM → USLAX; the scoped user below only has POL NLRTM.
    console.log("\nScope: a statement is visible only when the caller can see every shipment on it");
    const scopedEmail = `occ-stmt-scope-${Date.now()}@example.com`;
    await request("POST", "/api/users", { email: scopedEmail, name: "OCC Statement Scope Test", roles: ["occ_bk"], password: "OccStmtScope!2026Zq" }, token);
    const scopedUserId = (await request("GET", "/api/users", null, token)).body.find(u => u.email === scopedEmail).id;
    await request("POST", `/api/users/${scopedUserId}/scope`, { itemType: "pol", value: "NLRTM", label: "Rotterdam only" }, token);
    const scopedToken = (await request("POST", "/api/auth/login", { email: scopedEmail, password: "OccStmtScope!2026Zq" })).body.token;
    assert("scoped user logged in", !!scopedToken);

    const addSell = (shipmentId, chargeCode, amount) =>
      request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "SELL", chargeCode, currency: "USD", amount, exchangeRate: 1 }, token).then(r => r.body.id);
    const generate = (costLineIds, name) => request("POST", "/api/customer-statements/generate", {
      customerId, dateFrom: wide.dateFrom, dateTo: wide.dateTo, costLineIds, html: SAMPLE_HTML, filename: `${name}.html` }, token);
    const lineInScope = await addSell(shipmentIdA, "Documentation", 60);
    const stmtInScope = (await generate([lineInScope], "in-scope")).body.id;
    const stmtMixed = (await generate([await addSell(shipmentIdA, "Terminal Handling", 245), await addSell(shipmentIdB, "Terminal Handling", 230)], "mixed")).body.id;
    // statementId (from the lifecycle above) holds only shipB's line — wholly out of scope.

    const scopedList = await request("GET", "/api/customer-statements", null, scopedToken);
    assert("scoped list returns 200", scopedList.status === 200, JSON.stringify(scopedList.body));
    assert("scoped list includes the statement on an in-scope shipment", scopedList.body.some(s => s.id === stmtInScope));
    assert("scoped list excludes the out-of-scope statement", !scopedList.body.some(s => s.id === statementId), "leaked!");
    assert("scoped list excludes a statement mixing in- and out-of-scope shipments", !scopedList.body.some(s => s.id === stmtMixed), "leaked!");
    assert("scoped detail of the in-scope statement is 200", (await request("GET", `/api/customer-statements/${stmtInScope}`, null, scopedToken)).status === 200);
    assert("scoped detail of the out-of-scope statement is 404", (await request("GET", `/api/customer-statements/${statementId}`, null, scopedToken)).status === 404);
    assert("scoped detail of the mixed statement is 404", (await request("GET", `/api/customer-statements/${stmtMixed}`, null, scopedToken)).status === 404);
    const scopedDownload = await new Promise((resolve, reject) => {
      const req = http.request({ method: "GET", hostname: "localhost", port: 3001, path: `/api/customer-statements/${statementId}/download`,
        headers: { Authorization: `Bearer ${scopedToken}` } }, res => { res.on("data", () => {}); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject); req.end();
    });
    assert("scoped download of the out-of-scope statement is 404", scopedDownload === 404, String(scopedDownload));
    const unbilledA = await addSell(shipmentIdA, "Cleaning", 40), unbilledB = await addSell(shipmentIdB, "Cleaning", 40);
    const scopedEligible = await request("GET", `/api/customer-statements/eligible-lines?customerId=${customerId}&dateFrom=${wide.dateFrom}&dateTo=${wide.dateTo}`, null, scopedToken);
    assert("scoped eligible-lines offers the in-scope charge", scopedEligible.body.some(l => l.id === unbilledA), JSON.stringify(scopedEligible.body));
    assert("scoped eligible-lines hides the out-of-scope charge", !scopedEligible.body.some(l => l.id === unbilledB), "leaked!");
    const adminList = await request("GET", `/api/customer-statements?customerId=${customerId}`, null, token);
    assert("admin still sees all three", [stmtInScope, stmtMixed, statementId].every(id => adminList.body.some(s => s.id === id)));

    // ── TKT-2F19XD — one SELL line, one live billing document (decided 2026-09-30).
    console.log("\nOne line, one live billing document");
    const invOverStatement = await request("POST", `/api/shipments/${shipmentIdA}/documents/generate`, {
      html: SAMPLE_HTML, filename: `FR01-${shipmentIdA}-dup.html`, docType: "FR01", sourceCostLineIds: [lineInScope] }, token);
    assert("an invoice for a line on a draft statement is refused (409)", invOverStatement.status === 409, JSON.stringify(invOverStatement.body));
    assert("the refusal names the statement", String(invOverStatement.body.error || "").includes(stmtInScope), JSON.stringify(invOverStatement.body));
    const secondStatement = await generate([lineInScope], "second");
    assert("a second statement for the same line is refused (409)", secondStatement.status === 409, JSON.stringify(secondStatement.body));

    const draftInvoice = await request("POST", `/api/shipments/${shipmentIdA}/documents/generate`, {
      html: SAMPLE_HTML, filename: `FR01-${shipmentIdA}-draft.html`, docType: "FR01", sourceCostLineIds: [unbilledA] }, token);
    assert("a draft invoice for an unbilled line is created", draftInvoice.status === 201, JSON.stringify(draftInvoice.body));
    const eligibleAfterDraft = await request("GET", `/api/customer-statements/eligible-lines?customerId=${customerId}&dateFrom=${wide.dateFrom}&dateTo=${wide.dateTo}`, null, token);
    assert("a line on a DRAFT invoice is no longer eligible for a statement", !eligibleAfterDraft.body.some(l => l.id === unbilledA), JSON.stringify(eligibleAfterDraft.body));
    assert("...and a statement for it is refused (409)", (await generate([unbilledA], "over-draft-invoice")).status === 409);

    const linesA = (await request("GET", `/api/shipments/${shipmentIdA}/cost-lines`, null, token)).body;
    const billedStmt = linesA.find(l => l.id === lineInScope)?.billedOn, billedDraft = linesA.find(l => l.id === unbilledA)?.billedOn;
    assert("cost lines carry billedOn for a statement", billedStmt?.kind === "statement" && billedStmt.id === stmtInScope, JSON.stringify(billedStmt));
    assert("cost lines carry billedOn for a draft invoice", billedDraft?.kind === "invoice" && billedDraft.id === draftInvoice.body.id && billedDraft.status === "draft", JSON.stringify(billedDraft));
    assert("an unbilled line has billedOn null", linesA.find(l => l.type === "SELL" && !linesA.some(x => x.id === l.id && x.billedOn))?.billedOn === null);

    const otherShip = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", etd: "2026-09-03", emoOfficeId, imoOfficeId }, token);
    const foreignLine = await addSell(otherShip.body.id, "Ocean Freight", 900);
    const foreignGen = await generate([foreignLine], "foreign");
    assert("a line from another customer's shipment is refused (400)", foreignGen.status === 400, JSON.stringify(foreignGen.body));

    console.log("\nVoiding a draft statement or deleting a draft invoice frees the line");
    await request("POST", `/api/customer-statements/${stmtInScope}/void`, {}, token);
    const invAfterVoid = await request("POST", `/api/shipments/${shipmentIdA}/documents/generate`, {
      html: SAMPLE_HTML, filename: `FR01-${shipmentIdA}-after-void.html`, docType: "FR01", sourceCostLineIds: [lineInScope] }, token);
    assert("after voiding the draft statement, the line can be invoiced (201)", invAfterVoid.status === 201, JSON.stringify(invAfterVoid.body));
    await request("DELETE", `/api/shipments/${shipmentIdA}/documents/${draftInvoice.body.id}`, null, token);
    assert("after deleting the draft invoice, its line can go on a statement (201)", (await generate([unbilledA], "after-delete")).status === 201);

    // ── TKT-1E55AR — statements carry VAT and are issued by one legal entity (decided 2026-09-30).
    console.log("\nVAT and one legal entity per statement");
    const brX = await request("POST", "/api/branches", { code: `SX${rand}`, name: `Stmt Entity NL ${rand}`, countryCode: "NL", currency: "EUR" }, token);
    const brY = await request("POST", "/api/branches", { code: `SY${rand}`, name: `Stmt Entity US ${rand}`, countryCode: "US", currency: "USD" }, token);
    const offX = await request("POST", "/api/offices", { unlocode: `NX${rand}`, department: "SE", name: "Stmt Entity Office NL", branchId: brX.body.id }, token);
    const offY = await request("POST", "/api/offices", { unlocode: `UY${rand}`, department: "SE", name: "Stmt Entity Office US", branchId: brY.body.id }, token);
    assert("two scratch entities with an office each", !!(brX.body.id && brY.body.id && offX.body.id && offY.body.id),
      JSON.stringify([brX.body, brY.body, offX.body, offY.body]));
    const vatCustomer = await request("POST", "/api/customers", { companyName: `Statement VAT Co ${rand}`, currency: "EUR" }, token);
    const vatCustomerId = vatCustomer.body.id;
    const newShip = (office, pol, pod, etd) => request("POST", "/api/shipments", {
      pol, pod, carrierCode: "MAEU", status: "Active", contractType: "SPOT", contractRef: `SPOT-${pol}-${pod}`, etd, incoterm: "FOB",
      emoOfficeId: office, imoOfficeId: office, principalId: vatCustomerId, principalName: vatCustomer.body.companyName,
    }, token).then(r => r.body.id);
    const shipX = await newShip(offX.body.id, "NLRTM", "USNYC", "2026-10-05");
    const shipY = await newShip(offY.body.id, "USNYC", "NLRTM", "2026-10-06");
    const addLine = (shipmentId, body) => request("POST", `/api/shipments/${shipmentId}/cost-lines`,
      { type: "SELL", currency: "EUR", exchangeRate: 1.08, ...body }, token).then(r => r.body.id);
    const docX = await addLine(shipX, { chargeCode: "Documentation", amount: 400, vatRate: 21 });
    const ofrX = await addLine(shipX, { chargeCode: "Ocean Freight", amount: 600, vatTreatment: "zero_rated" });
    const thcX = await addLine(shipX, { chargeCode: "Terminal Handling", amount: 200, vatTreatment: "reverse_charge" });
    const inlandY = await addLine(shipY, { chargeCode: "Inland", amount: 151 });

    const eligVat = await request("GET", `/api/customer-statements/eligible-lines?customerId=${vatCustomerId}&dateFrom=${wide.dateFrom}&dateTo=${wide.dateTo}`, null, token);
    const eDoc = eligVat.body.find(l => l.id === docX);
    assert("eligible lines carry VAT: 21% of 400 = 84", eDoc?.vatRate === 21 && eDoc?.vatAmount === 84 && eDoc?.vatTreatment === "standard", JSON.stringify(eDoc));
    assert("a reverse-charged line carries 0 VAT and its treatment", eligVat.body.find(l => l.id === thcX)?.vatAmount === 0
      && eligVat.body.find(l => l.id === thcX)?.vatTreatment === "reverse_charge");
    assert("eligible lines carry their legal entity", eDoc?.entityId === brX.body.id && eligVat.body.find(l => l.id === inlandY)?.entityId === brY.body.id,
      JSON.stringify(eligVat.body.map(l => [l.chargeCode, l.entityId])));
    const withHeld = await request("GET", `/api/customer-statements/eligible-lines?customerId=${vatCustomerId}&dateFrom=${wide.dateFrom}&dateTo=${wide.dateTo}&withHeld=1`, null, token);
    assert("withHeld=1 returns { lines, held }", Array.isArray(withHeld.body.lines) && Array.isArray(withHeld.body.held) && withHeld.body.lines.length === 4, JSON.stringify(withHeld.body).slice(0, 200));

    const vatGen = (costLineIds, name) => request("POST", "/api/customer-statements/generate", {
      customerId: vatCustomerId, dateFrom: wide.dateFrom, dateTo: wide.dateTo, costLineIds, html: SAMPLE_HTML, filename: `${name}.html` }, token);
    const twoEntities = await vatGen([docX, inlandY], "two-entities");
    assert("a statement across two legal entities is refused (400)", twoEntities.status === 400
      && twoEntities.body.error.includes(brX.body.name) && twoEntities.body.error.includes(brY.body.name), JSON.stringify(twoEntities.body));
    const vatStmt = await vatGen([docX, ofrX, thcX], "vat");
    assert("a one-entity statement is generated (201)", vatStmt.status === 201, JSON.stringify(vatStmt.body));
    assert("it records its legal entity", vatStmt.body.entityId === brX.body.id && vatStmt.body.entityName === brX.body.name, JSON.stringify(vatStmt.body));
    assert("net 1200, VAT 84, gross 1284", vatStmt.body.totalAmount === 1200 && vatStmt.body.vatAmount === 84 && vatStmt.body.grossAmount === 1284,
      JSON.stringify([vatStmt.body.totalAmount, vatStmt.body.vatAmount, vatStmt.body.grossAmount]));
    const sDoc = vatStmt.body.lines.find(l => l.costLineId === docX), sThc = vatStmt.body.lines.find(l => l.costLineId === thcX);
    assert("each line snapshots its VAT (Documentation: 21%, 84, gross 484)", sDoc?.vatRate === 21 && sDoc?.vatAmount === 84 && sDoc?.grossAmount === 484, JSON.stringify(sDoc));
    assert("the reverse-charged line keeps its treatment at 0 VAT", sThc?.vatTreatment === "reverse_charge" && sThc?.vatAmount === 0, JSON.stringify(sThc));

    console.log("\nMark as Paid records what was actually received, like an invoice");
    await request("POST", `/api/customer-statements/${vatStmt.body.id}/confirm`, {}, token);
    const halfFx = await request("POST", `/api/customer-statements/${vatStmt.body.id}/mark-paid`, { paidAt: today, paidAmount: 1373.88, paidAmountOriginal: 1284 }, token);
    assert("an original amount without currency + rate is refused (400)", halfFx.status === 400, JSON.stringify(halfFx.body));
    const fullFx = await request("POST", `/api/customer-statements/${vatStmt.body.id}/mark-paid`,
      { paidAt: today, paidAmount: 1373.88, paidAmountOriginal: 1284, paidCurrency: "EUR", paidExchangeRate: 1.07 }, token);
    assert("mark-paid stores the received amount, currency and rate", fullFx.status === 200 && fullFx.body.paidAmountOriginal === 1284
      && fullFx.body.paidCurrency === "EUR" && fullFx.body.paidExchangeRate === 1.07, JSON.stringify(fullFx.body));

    // ── TKT-02776W — a confirmed statement is an issued billing document in every finance report.
    // vatStmt (entity X, EUR at 1.08): Documentation 400 @21%, Ocean Freight 600 zero-rated,
    // THC 200 reverse charge — net 1296 USD, 90.72 USD VAT; paid 1373.88 USD for 1284 EUR at 1.07.
    console.log("\nStatement revenue reaches FX Revaluation, VAT Liability and GL Export");
    const near = (a, b) => Math.abs((a ?? NaN) - b) < 0.011;
    const stmtY = await vatGen([inlandY], "stmt-y");
    await request("POST", `/api/customer-statements/${stmtY.body.id}/confirm`, {}, token);

    const fx = await request("GET", "/api/fx-revaluation/summary", null, token);
    const realizedRows = fx.body.realized.filter(r => r.docId === vatStmt.body.id);
    assert("FX realized lists the paid statement exactly once", realizedRows.length === 1 && realizedRows[0].source === "statement", JSON.stringify(realizedRows));
    assert("booked value is gross USD (432×1.21 + 648 + 216 = 1386.72), received 1373.88, loss 12.84",
      near(realizedRows[0]?.bookedUsd, 1386.72) && near(realizedRows[0]?.receivedUsd, 1373.88) && near(realizedRows[0]?.gainLossUsd, -12.84), JSON.stringify(realizedRows[0]));
    const unrealizedRows = fx.body.unrealized.filter(r => r.docId === stmtY.body.id);
    assert("FX unrealized lists the unpaid EUR statement exactly once", unrealizedRows.length === 1 && unrealizedRows[0].source === "statement"
      && unrealizedRows[0].currency === "EUR" && near(unrealizedRows[0].foreignAmount, 151) && near(unrealizedRows[0].bookedUsd, 163.08), JSON.stringify(unrealizedRows));

    const vl = await request("GET", `/api/vat-liability/summary?dateFrom=${today}&dateTo=${today}`, null, token);
    const entX = vl.body.entities.find(e => e.entityId === brX.body.id);
    assert("VAT Liability: the statement's standard-rated line is output (base 432, VAT 90.72)",
      near(entX?.output.standard.baseUsd, 432) && near(entX?.output.standard.vatUsd, 90.72), JSON.stringify(entX?.output));
    assert("...its zero-rated and reverse-charged lines in their own boxes (648, 216)",
      near(entX?.output.zero_rated.baseUsd, 648) && near(entX?.output.reverse_charge.baseUsd, 216), JSON.stringify(entX?.output));

    const gl = await request("POST", "/api/gl-export/run", { dateFrom: today, dateTo: today }, token);
    const glX = gl.body.rows.filter(r => r.reference === vatStmt.body.id);
    const credit = code => glX.find(r => r.memo.startsWith(`${code} — `))?.credit;
    // Net revenue per charge, the 90.72 output VAT on its own row (TKT-AEPGWA), AR at gross.
    assert("GL Export: revenue credits at net (432 / 648 / 216), 90.72 output VAT, AR debit at gross 1386.72",
      near(credit("Documentation"), 432) && near(credit("Ocean Freight"), 648) && near(credit("Terminal Handling"), 216)
      && near(glX.find(r => r.memo.startsWith("Output VAT — "))?.credit, 90.72)
      && near(glX.find(r => r.memo.startsWith("AR — "))?.debit, 1386.72) && glX.length === 5, JSON.stringify(glX));
    assert("...and the second statement too", gl.body.rows.filter(r => r.reference === stmtY.body.id).length === 2);
    const stamped = await request("GET", `/api/customer-statements/${vatStmt.body.id}`, null, token);
    assert("the statement is stamped with the export batch", stamped.body.glExportBatchId === gl.body.batchId && !!stamped.body.glExportedAt, JSON.stringify(stamped.body.glExportBatchId));
    const glAgain = await request("POST", "/api/gl-export/run", { dateFrom: today, dateTo: today }, token);
    assert("a re-run doesn't export it again", !glAgain.body.rows.some(r => r.reference === vatStmt.body.id || r.reference === stmtY.body.id));

    await request("DELETE", `/api/shipments/${shipX}`, null, token);
    await request("DELETE", `/api/shipments/${shipY}`, null, token);
    await request("DELETE", `/api/customers/${vatCustomerId}`, null, token);
    // shipX/shipY are on confirmed statements, so they stay and their office/branch deactivate.
    for (const o of [offX, offY]) await retireOffice(token, o.body.id);
    for (const b of [brX, brY]) await retireBranch(token, b.body.id);

    // Last on purpose: releasing a hold is the lane trade manager's call (routes/customers.js), so
    // the customer stays on hold from here on — any generate after this would be refused for the
    // hold instead of for what it tests (the mixed-currency check above used to pass that way).
    console.log("\nCredit hold blocks statement generation");
    // PUT /api/customers/:id is a full-replace (requires companyName) — not a partial PATCH.
    const holdOn = await request("PUT", `/api/customers/${customerId}`, { companyName: customer.body.companyName, creditHold: true, creditHoldReason: "Test hold" }, token);
    assert("credit hold set", holdOn.status === 200, JSON.stringify(holdOn.body));
    const heldGen = await request("POST", "/api/customer-statements/generate", {
      customerId, dateFrom: wide.dateFrom, dateTo: wide.dateTo, costLineIds: [lineC.body.id], html: SAMPLE_HTML, filename: "held.html",
    }, token);
    assert("generation blocked while on credit hold (409)", heldGen.status === 409, JSON.stringify(heldGen.body));

    console.log("\nCleanup");
    await request("DELETE", `/api/users/${scopedUserId}`, null, token);
    await request("DELETE", `/api/shipments/${otherShip.body.id}`, null, token);
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
