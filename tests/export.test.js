/**
 * Export routes (routes/export.js) — smoke tests
 *
 * Covers GET /api/export/shipments.csv (all fields + ?fields= subset with mandatory
 * force-inclusion), GET /api/export/dashboard/xlsx (fully-programmatic ExcelJS build),
 * and GET /api/export/dashboard/template (fill-in-place against exports/dashboard-template.xlsx,
 * including the template-missing 404 branch). Previously zero dedicated coverage — every other
 * test file only ever exercises export.js incidentally, if at all.
 *
 * Usage:
 *   node tests/export.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

const BASE = "http://localhost:3001";
const TEMPLATE_PATH = path.join(process.cwd(), "exports", "dashboard-template.xlsx");
let passed = 0;
let failed = 0;

function request(method, reqPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: 3001, path: reqPath,
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
        catch { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function download(reqPath, token) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${reqPath}`, { headers: { Authorization: `Bearer ${token}` } }, res => {
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

    console.log("\nScratch shipment with a SEA leg + BUY/SELL cost lines (feeds margin summary + sea-port resolution)");
    const today = new Date().toISOString().slice(0, 10);
    const shp = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU",
      status: "Active", contractType: "SPOT", etd: today,
      shipperName: "Export Test Shipper Co", consigneeName: "Export Test Consignee Co",
    }, token);
    assert("scratch shipment created", shp.status === 201);
    const shipmentId = shp.body.id;

    const leg = await request("POST", `/api/shipments/${shipmentId}/legs`, {
      legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: today,
    }, token);
    assert("SEA leg created", leg.status === 201, JSON.stringify(leg.body));

    const buy = await request("POST", `/api/shipments/${shipmentId}/cost-lines`,
      { type: "BUY", chargeCode: "OFR", currency: "USD", amount: 1000, exchangeRate: 1 }, token);
    assert("BUY cost line created", buy.status === 201);
    const sell = await request("POST", `/api/shipments/${shipmentId}/cost-lines`,
      { type: "SELL", chargeCode: "OFR", currency: "USD", amount: 1500, exchangeRate: 1 }, token);
    assert("SELL cost line created", sell.status === 201);

    console.log("\nGET /api/export/shipments.csv — no ?fields= means every column");
    const csvAll = await request("GET", "/api/export/shipments.csv", null, token);
    assert("csv returns 200", csvAll.status === 200);
    assert("content-type is text/csv", (csvAll.headers?.["content-type"] || "").includes("text/csv"));
    assert("content-disposition names the file", (csvAll.headers?.["content-disposition"] || "").includes("shipments-"));
    const allLines = String(csvAll.body).split("\n");
    assert("header row present", allLines[0].includes("Shipment ID"));
    assert("header includes an optional (non-mandatory) column", allLines[0].includes("Status"));
    assert("our scratch shipment appears in the export", String(csvAll.body).includes(shipmentId));

    console.log("\nGET .../shipments.csv?fields= — mandatory fields force-included even if not requested");
    const csvSubset = await request("GET", "/api/export/shipments.csv?fields=id,carrierCode", null, token);
    assert("filtered csv returns 200", csvSubset.status === 200);
    const subsetHeader = String(csvSubset.body).split("\n")[0];
    assert("requested field (Carrier) present", subsetHeader.includes("Carrier"));
    assert("mandatory field (ETD / ATD) force-included though not requested", subsetHeader.includes("ETD / ATD"));
    assert("non-requested, non-mandatory field (Status) excluded", !subsetHeader.includes("Status"));

    console.log("\nGET /api/export/dashboard/xlsx — fully-programmatic ExcelJS workbook");
    const xlsxRes = await download("/api/export/dashboard/xlsx", token);
    assert("xlsx returns 200", xlsxRes.status === 200);
    assert("content-type is xlsx", (xlsxRes.headers["content-type"] || "").includes("spreadsheetml"));
    assert("non-trivial file size", xlsxRes.buffer.length > 1000, `${xlsxRes.buffer.length} bytes`);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxRes.buffer);
    const sheetNames = wb.worksheets.map(ws => ws.name);
    assert("has Summary sheet", sheetNames.includes("Summary"));
    assert("has By Carrier sheet", sheetNames.includes("By Carrier"));
    assert("has By Lane sheet", sheetNames.includes("By Lane"));
    assert("has Shipment Detail sheet", sheetNames.includes("Shipment Detail"));

    const wsSummary = wb.getWorksheet("Summary");
    assert("Summary title cell set", String(wsSummary.getCell("A1").value).includes("Dashboard KPI Export"));
    const wsCarrier = wb.getWorksheet("By Carrier");
    const carrierRows = wsCarrier.rowCount;
    assert("By Carrier has a header + at least one data row", carrierRows >= 2);
    assert("By Carrier has a TOTAL row", wsCarrier.getCell(`A${carrierRows}`).value === "TOTAL");
    const wsDetail = wb.getWorksheet("Shipment Detail");
    assert("Shipment Detail header row frozen", wsDetail.views?.[0]?.state === "frozen");
    assert("Shipment Detail has an autoFilter", !!wsDetail.autoFilter);

    console.log("\nGET /api/export/dashboard/template — fills the committed template in place");
    const tplRes = await download("/api/export/dashboard/template", token);
    assert("template export returns 200", tplRes.status === 200);
    assert("content-type is xlsx", (tplRes.headers["content-type"] || "").includes("spreadsheetml"));
    const wbTpl = new ExcelJS.Workbook();
    await wbTpl.xlsx.load(tplRes.buffer);
    const tplSummary = wbTpl.getWorksheet("Summary");
    assert("template Summary sheet exists", !!tplSummary);
    if (tplSummary) assert("template Summary title filled in", String(tplSummary.getCell("A1").value).includes("Dashboard KPI Export"));

    console.log("\nGET .../dashboard/template with the template file temporarily absent — clean 404, not a crash");
    const backupPath = `${TEMPLATE_PATH}.bak-export-test`;
    fs.renameSync(TEMPLATE_PATH, backupPath);
    try {
      const missingTpl = await request("GET", "/api/export/dashboard/template", null, token);
      assert("missing template returns 404", missingTpl.status === 404);
      assert("error message points at the regeneration script", (missingTpl.body?.error || "").includes("create-export-template.js"));
    } finally {
      fs.renameSync(backupPath, TEMPLATE_PATH);
    }
    assert("template file restored", fs.existsSync(TEMPLATE_PATH));

    console.log("\nUnauthenticated requests are rejected");
    const noAuthCsv = await request("GET", "/api/export/shipments.csv", null, null);
    assert("csv without a token is rejected", noAuthCsv.status === 401);

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
