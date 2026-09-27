/**
 * GL Export — Charge Code -> GL Account mapping CRUD, control accounts (via the generic
 * Application Settings), and lib/gl-export.js's run engine (SELL via confirmed FR01, BUY via
 * posted cost lines), including re-run idempotency.
 *
 * Usage:
 *   node tests/gl-export.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - PDF Render Service running on :3003 (invoice generation renders a real PDF)
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

const SAMPLE_HTML = `<html><body><h1>Freight Invoice (test fixture)</h1></body></html>`;
const rand = Math.random().toString(36).slice(2, 8).toUpperCase();

(async () => {
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const today = new Date().toISOString().slice(0, 10);

    console.log("\nGL Account Mappings — CRUD + validation");
    const mapCreate = await request("POST", "/api/gl-account-mappings",
      { chargeCode: "Ocean Freight", type: "SELL", glAccountCode: `4010-${rand}`, glAccountName: "Freight Revenue (test)" }, token);
    assert("mapping created (201)", mapCreate.status === 201, JSON.stringify(mapCreate.body));
    const mapDup = await request("POST", "/api/gl-account-mappings",
      { chargeCode: "Ocean Freight", type: "SELL", glAccountCode: "9999" }, token);
    assert("duplicate charge_code+type rejected", mapDup.status >= 400, JSON.stringify(mapDup.body));
    const mapBuy = await request("POST", "/api/gl-account-mappings",
      { chargeCode: "Ocean Freight", type: "BUY", glAccountCode: `5010-${rand}`, glAccountName: "Freight Cost (test)" }, token);
    assert("BUY mapping for the SAME charge code is independent (201)", mapBuy.status === 201, JSON.stringify(mapBuy.body));
    const mapBadCode = await request("POST", "/api/gl-account-mappings", { chargeCode: "Not A Real Code", type: "SELL", glAccountCode: "1" }, token);
    assert("an unknown charge code is rejected", mapBadCode.status >= 400);
    const mapUpdate = await request("PUT", `/api/gl-account-mappings/${mapCreate.body.id}`, { glAccountName: "Freight Revenue (renamed)" }, token);
    assert("update returns the renamed account", mapUpdate.status === 200 && mapUpdate.body.glAccountName === "Freight Revenue (renamed)");
    const mapDelete404 = await request("DELETE", "/api/gl-account-mappings/GAM-NOPE", null, token);
    assert("delete of an unknown mapping 404s", mapDelete404.status === 404);

    console.log("\nControl accounts round-trip via the generic Application Settings");
    const settingsBefore = await request("GET", "/api/settings", null, token);
    const { gl_control_account_ar: prevAr, gl_control_account_ap: prevAp, gl_control_account_unmapped: prevUnmapped } = settingsBefore.body;
    const setControl = await request("PUT", "/api/settings",
      { gl_control_account_ar: `1200-${rand}`, gl_control_account_ap: `2100-${rand}`, gl_control_account_unmapped: `9999-${rand}` }, token);
    assert("control accounts saved (200)", setControl.status === 200, JSON.stringify(setControl.body));
    const settingsAfter = await request("GET", "/api/settings", null, token);
    assert("AR control account round-trips", settingsAfter.body.gl_control_account_ar === `1200-${rand}`);
    assert("Unmapped control account round-trips", settingsAfter.body.gl_control_account_unmapped === `9999-${rand}`);

    console.log("\nScratch shipment with one mapped SELL charge (confirmed invoice) and one unmapped SELL charge");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", etd: "2026-09-01",
      emoOfficeId, imoOfficeId,
    }, token);
    assert("scratch shipment created", !!ship.body.id, JSON.stringify(ship.body));
    const shipmentId = ship.body.id;

    const mappedLine = await request("POST", `/api/shipments/${shipmentId}/cost-lines`,
      { type: "SELL", chargeCode: "Ocean Freight", currency: "USD", amount: 1000, exchangeRate: 1 }, token);
    const unmappedLine = await request("POST", `/api/shipments/${shipmentId}/cost-lines`,
      { type: "SELL", chargeCode: `Unmapped-${rand}`, currency: "USD", amount: 250, exchangeRate: 1 }, token);
    assert("both SELL lines created", !!mappedLine.body.id && !!unmappedLine.body.id);

    const doc = await request("POST", `/api/shipments/${shipmentId}/documents/generate`, {
      html: SAMPLE_HTML, filename: `FR01-${shipmentId}-${today}.html`, docType: "FR01",
      sourceCostLineIds: [mappedLine.body.id, unmappedLine.body.id],
    }, token);
    assert("invoice generated", !!doc.body.id, JSON.stringify(doc.body));
    const confirmed = await request("PATCH", `/api/shipments/${shipmentId}/documents/${doc.body.id}`, { status: "confirmed" }, token);
    assert("invoice confirmed", confirmed.status === 200 && confirmed.body.status === "confirmed");

    console.log("\nBUY side — a posted cost line, mapped");
    const buyLine = await request("POST", `/api/shipments/${shipmentId}/cost-lines`,
      { type: "BUY", chargeCode: "Ocean Freight", currency: "USD", amount: 700, exchangeRate: 1 }, token);
    const buyActualize = await request("PATCH", `/api/shipments/${shipmentId}/cost-lines/${buyLine.body.id}/actualize`, { actualAmount: 700 }, token);
    assert("BUY line actualized", buyActualize.status === 200);
    const buyPost = await request("PATCH", `/api/shipments/${shipmentId}/cost-lines/${buyLine.body.id}/post`, {}, token);
    assert("BUY line posted", buyPost.status === 200 && buyPost.body.status === "posted");

    console.log("\nRun the export over just today's window");
    const run1 = await request("POST", "/api/gl-export/run", { dateFrom: today, dateTo: today }, token);
    assert("export run returns 201", run1.status === 201, JSON.stringify(run1.body));
    const rows1 = run1.body.rows.filter(r => r.reference === doc.body.id || r.reference === shipmentId);
    const sellRevenueRow = rows1.find(r => r.credit === 1000 && r.accountCode === `4010-${rand}`);
    assert("SELL mapped charge posts a revenue credit to the mapped account", !!sellRevenueRow, JSON.stringify(rows1));
    const arRow = rows1.find(r => r.debit === 1250 && r.reference === doc.body.id);
    assert("AR debit is the invoice's FULL total (mapped + unmapped combined)", !!arRow, JSON.stringify(rows1));
    const unmappedRow = rows1.find(r => r.credit === 250 && r.accountCode === `9999-${rand}`);
    assert("the unmapped SELL charge falls into the Unmapped/Suspense control account", !!unmappedRow, JSON.stringify(rows1));
    const buyExpenseRow = rows1.find(r => r.debit === 700 && r.accountCode === `5010-${rand}`);
    assert("BUY mapped charge posts an expense debit to its own (BUY) mapped account", !!buyExpenseRow, JSON.stringify(rows1));
    const apRow = rows1.find(r => r.credit === 700 && r.accountCode === `2100-${rand}`);
    assert("AP credit for the posted BUY line", !!apRow, JSON.stringify(rows1));
    assert("CSV is a non-empty string", typeof run1.body.csv === "string" && run1.body.csv.includes("Account Code"));

    console.log("\nRe-running the same range never double-exports (idempotency)");
    const run2 = await request("POST", "/api/gl-export/run", { dateFrom: today, dateTo: today }, token);
    const rows2 = run2.body.rows.filter(r => r.reference === doc.body.id || r.reference === shipmentId);
    assert("a second run over the identical range returns none of the already-exported rows", rows2.length === 0, JSON.stringify(rows2));

    console.log("\nBatch history");
    const batches = await request("GET", "/api/gl-export/batches", null, token);
    assert("batch history includes both runs", batches.body.some(b => b.id === run1.body.batchId) && batches.body.some(b => b.id === run2.body.batchId));

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/gl-account-mappings/${mapCreate.body.id}`, null, token);
    await request("DELETE", `/api/gl-account-mappings/${mapBuy.body.id}`, null, token);
    await request("PUT", "/api/settings", { gl_control_account_ar: prevAr || "", gl_control_account_ap: prevAp || "", gl_control_account_unmapped: prevUnmapped || "" }, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
