/**
 * Bulk Container Import — template download, upload/preview validation, and commit.
 *
 * Covers GET /api/containers/import-template (a real, non-empty, readable .xlsx listing the
 * current active container type codes) and the preview/commit pair on
 * POST /api/shipments/:id/containers/import/{preview,commit} — built in-test with `exceljs`
 * (already a project dependency) rather than a checked-in fixture file, so it always reflects
 * whatever container_type_definitions are actually active right now.
 *
 * Usage:
 *   node tests/container-bulk-import.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import ExcelJS from "exceljs";

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

// GET /api/containers/import-template returns a raw binary .xlsx, not JSON — a separate
// downloader since `request()` above always tries to JSON.parse the response body.
function downloadBinary(path, token) {
  return new Promise((resolve, reject) => {
    http.request({ method: "GET", hostname: "localhost", port: 3001, path,
      headers: { Authorization: `Bearer ${token}` } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    }).on("error", reject).end();
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

// Builds a real .xlsx buffer matching the template's own column layout (Container Number, Seal
// Number, Container Type Code, HS Code, Cargo Description, Marks & Numbers, Gross Weight (kg),
// Volume (CBM), Is DG?, DG Class, Reefer Set Temp) — header row + N data rows starting row 2,
// mirroring exactly what the preview route expects (it skips rows 1-2, treating row 2 as the
// generated example row; this test's own "row 2" is a real data row, so it's built starting at
// row 3 by inserting a throwaway blank row 2 first).
//
// A "Reference" sheet is added FIRST, deliberately mirroring the real template's own sheet
// order (its hidden Reference sheet, backing the Excel dropdown lists, is added before
// "Containers") — this is exactly what caught a real bug live: the preview route originally
// picked worksheets[0] by index rather than the "Containers" sheet by name, silently reading
// data out of the reference list instead. A test workbook with only one sheet would never have
// exercised that path.
function buildWorkbook(dataRows) {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet("Reference", { state: "veryHidden" }).addRow(["decoy", "reference", "data"]);
  const sheet = wb.addWorksheet("Containers");
  sheet.addRow(["Container Number", "Seal Number", "Container Type Code", "HS Code", "Cargo Description",
    "Marks & Numbers", "Gross Weight (kg)", "Volume (CBM)", "Is DG?", "DG Class", "Reefer Set Temp"]);
  sheet.addRow(["(example row placeholder)"]);
  for (const row of dataRows) {
    sheet.addRow([row.containerNumber, row.sealNumber, row.typeCode, row.hsCode, row.cargoDescription,
      row.marksAndNumbers, row.grossWeightKg, row.volumeCbm, row.isDg, row.dgClass, row.setTemperatureC]);
  }
  return wb;
}

(async () => {
  let token, shipmentId;
  const createdContainerIds = [];
  try {
    console.log("Logging in…");
    token = await login();
    console.log("  ✓ Logged in");

    console.log("\nTemplate download");
    const template = await downloadBinary("/api/containers/import-template", token);
    assert("template returns 200", template.status === 200);
    assert("template is non-trivial in size", template.buffer.length > 1000, `size=${template.buffer.length}`);
    const templateWb = new ExcelJS.Workbook();
    await templateWb.xlsx.load(template.buffer);
    const templateSheet = templateWb.getWorksheet("Containers");
    assert("template has a Containers sheet", !!templateSheet);
    assert("template header row has Container Type Code column", String(templateSheet.getRow(1).getCell(3).value || "").includes("Container Type Code"));

    console.log("\nScratch shipment + a real active container type code");
    const typeDefs = await request("GET", "/api/container-type-definitions", null, token);
    const activeType = typeDefs.body.find(t => t.isActive);
    assert("at least one active container type exists", !!activeType, "seed some via Master Data if this fails");
    const validCode = activeType.code;

    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    }, token);
    shipmentId = ship.body.id;
    assert("scratch shipment created", !!shipmentId, JSON.stringify(ship.body));

    console.log("\nPreview — mixed valid/invalid rows");
    const wb = buildWorkbook([
      { containerNumber: "TEST0000001", sealNumber: "SEAL01", typeCode: validCode, hsCode: "8471.30",
        cargoDescription: "Valid row", grossWeightKg: 18000, volumeCbm: 58, isDg: "N" },
      { containerNumber: "TEST0000002", sealNumber: "SEAL02", typeCode: "NOTREAL99",
        cargoDescription: "Bad type code", grossWeightKg: 5000, volumeCbm: 20, isDg: "N" },
      { containerNumber: "TEST0000003", sealNumber: "SEAL03", typeCode: validCode,
        cargoDescription: "DG=Y but no class", grossWeightKg: 5000, volumeCbm: 20, isDg: "Y", dgClass: "" },
      { containerNumber: "TEST0000004", sealNumber: "SEAL04", typeCode: validCode,
        cargoDescription: "Non-numeric weight", grossWeightKg: "heavy", volumeCbm: 20, isDg: "N" },
    ]);
    const buffer = await wb.xlsx.writeBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    const preview = await request("POST", `/api/shipments/${shipmentId}/containers/import/preview`, { data: base64 }, token);
    assert("preview returns 200", preview.status === 200, JSON.stringify(preview.body));
    assert("preview finds exactly 4 rows", preview.body.rows?.length === 4, JSON.stringify(preview.body.rows));

    const [row1, row2, row3, row4] = preview.body.rows;
    assert("row 1 (valid) has no errors", row1.errors.length === 0, JSON.stringify(row1));
    assert("row 1 resolved size/type from the code", !!row1.data.size && !!row1.data.type, JSON.stringify(row1.data));
    assert("row 2 (bad type code) is flagged", row2.errors.some(e => e.includes("not a recognized")), JSON.stringify(row2.errors));
    assert("row 3 (DG=Y, no class) is flagged", row3.errors.some(e => e.includes("DG Class is required")), JSON.stringify(row3.errors));
    assert("row 4 (non-numeric weight) is flagged", row4.errors.some(e => e.includes("must be a number")), JSON.stringify(row4.errors));

    console.log("\nCommit — rejected while rows still have errors");
    const commitBad = await request("POST", `/api/shipments/${shipmentId}/containers/import/commit`, { rows: preview.body.rows }, token);
    assert("commit rejected (422) while errors remain", commitBad.status === 422, JSON.stringify(commitBad.body));
    const stillHasContainers = await request("GET", `/api/containers?shipmentId=${shipmentId}`, null, token);
    assert("nothing was created on the rejected commit", (stillHasContainers.body.results || stillHasContainers.body).length === 0);

    console.log("\nCommit — corrected rows succeed");
    const corrected = [
      { ...row1 },
      { ...row2, data: { ...row2.data, typeCode: validCode } },
      { ...row3, data: { ...row3.data, dgClass: "9" } },
      { ...row4, data: { ...row4.data, grossWeightKg: 7000 } },
    ];
    const commitGood = await request("POST", `/api/shipments/${shipmentId}/containers/import/commit`, { rows: corrected }, token);
    assert("commit succeeds (201) once corrected", commitGood.status === 201, JSON.stringify(commitGood.body));
    assert("4 containers created", commitGood.body.created?.length === 4, JSON.stringify(commitGood.body));
    commitGood.body.created?.forEach(c => createdContainerIds.push(c.id));

    const afterCommit = await request("GET", `/api/containers?shipmentId=${shipmentId}`, null, token);
    const rows = afterCommit.body.results || afterCommit.body;
    assert("all 4 containers are actually on the shipment", rows.length === 4, JSON.stringify(rows.map(r => r.containerNumber)));
    const dgRow = rows.find(r => r.containerNumber === "TEST0000003");
    assert("DG row persisted correctly (isDg + class)", dgRow?.isDg === true && dgRow?.dgClass === "9", JSON.stringify(dgRow));
    const weightRow = rows.find(r => r.containerNumber === "TEST0000004");
    assert("corrected numeric weight persisted", weightRow?.grossWeightKg === 7000, JSON.stringify(weightRow));

    console.log("\nPreview — malformed file is rejected cleanly, not a 500");
    const garbage = await request("POST", `/api/shipments/${shipmentId}/containers/import/preview`,
      { data: Buffer.from("not a real xlsx file").toString("base64") }, token);
    assert("malformed file returns a clean 4xx, not a crash", garbage.status >= 400 && garbage.status < 500, JSON.stringify(garbage.body));

    console.log("\nCleanup");
    for (const id of createdContainerIds) await request("DELETE", `/api/containers/${id}`, null, token);
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    if (token && shipmentId) {
      for (const id of createdContainerIds) await request("DELETE", `/api/containers/${id}`, null, token).catch(() => {});
      await request("DELETE", `/api/shipments/${shipmentId}`, null, token).catch(() => {});
    }
    process.exit(1);
  }
})();
