#!/usr/bin/env node
"use strict";
/**
 * Generates exports/dashboard-template.xlsx
 *
 * Run once:  node scripts/create-export-template.js
 *
 * The template defines:
 *   - Named ranges pointing to the data cells in each sheet
 *   - Column widths, tab colours, and frozen header rows
 *   - Placeholder data rows so Excel can render chart previews immediately
 *
 * After running this script, open the file in Excel and add charts that
 * reference the named ranges (WeeklySummary, ByCarrier, ByLane).
 * Save the file and commit it.  The /api/export/dashboard/template endpoint
 * then loads this file and overwrites the data cells while preserving every
 * chart, pivot table, or other object you added.
 */

const ExcelJS = require("exceljs");
const path    = require("path");
const fs      = require("fs");

const OUT_DIR  = path.join(__dirname, "..", "exports");
const OUT_FILE = path.join(OUT_DIR, "dashboard-template.xlsx");

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Design tokens ───────────────────────────────────────────────────────────

const BRAND = {
  navy:      "FF1A2E4A",
  teal:      "FF0D7377",
  accent:    "FF14A085",
  lightGrey: "FFF4F6F9",
  midGrey:   "FFD1D9E6",
  white:     "FFFFFFFF",
  black:     "FF1A1A2E",
  green:     "FF27AE60",
  red:       "FFE74C3C",
};

const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const hFont = (size = 10) => ({ name: "Calibri", size, bold: true, color: { argb: BRAND.white } });
const dFont = (size = 10) => ({ name: "Calibri", size, bold: false, color: { argb: BRAND.black } });
const border = () => ({
  top:    { style: "thin", color: { argb: BRAND.midGrey } },
  left:   { style: "thin", color: { argb: BRAND.midGrey } },
  bottom: { style: "thin", color: { argb: BRAND.midGrey } },
  right:  { style: "thin", color: { argb: BRAND.midGrey } },
});

// ─── Workbook ─────────────────────────────────────────────────────────────────

const wb = new ExcelJS.Workbook();
wb.creator  = "CargoDesk";
wb.created  = new Date();
wb.modified = new Date();

// ─── Sheet 1: Summary ─────────────────────────────────────────────────────────

const wsSummary = wb.addWorksheet("Summary", { tabColor: { argb: BRAND.teal } });
wsSummary.properties.defaultRowHeight = 18;

// Title block (rows 1-2)
wsSummary.mergeCells("A1:F1");
const t = wsSummary.getCell("A1");
t.value     = "CargoDesk — Dashboard KPI Export";
t.font      = { name: "Calibri", size: 14, bold: true, color: { argb: BRAND.navy } };
t.fill      = fill(BRAND.lightGrey);
t.alignment = { horizontal: "center" };
wsSummary.getRow(1).height = 28;

wsSummary.mergeCells("A2:F2");
const sub = wsSummary.getCell("A2");
sub.value     = "Exported: [date]    |    Shipments in scope: [count]";
sub.font      = { name: "Calibri", size: 9, color: { argb: BRAND.navy } };
sub.fill      = fill(BRAND.lightGrey);
sub.alignment = { horizontal: "center" };

// Spacer row 3
wsSummary.getRow(3).height = 10;

// KPI header (row 4)
["Metric", "Value (USD)"].forEach((h, i) => {
  const cell   = wsSummary.getCell(4, i + 1);
  cell.value   = h;
  cell.font    = hFont();
  cell.fill    = fill(BRAND.teal);
  cell.border  = border();
});
wsSummary.getColumn(1).width = 28;
wsSummary.getColumn(2).width = 18;

// KPI data rows 5-8
const kpiLabels = ["Total Buy", "Total Sell", "Gross Profit", "Gross Margin %"];
const kpiVals   = [0, 0, 0, null];
kpiLabels.forEach((label, i) => {
  const row = wsSummary.getRow(5 + i);
  const c1  = row.getCell(1);
  c1.value  = label; c1.font = dFont(); c1.border = border();
  const c2  = row.getCell(2);
  c2.value  = kpiVals[i]; c2.border = border(); c2.font = dFont();
  c2.alignment = { horizontal: "right" };
  c2.numFmt = label.includes("%") ? "0.0%" : '#,##0.00" USD"';
});

// Spacer row 9
wsSummary.getRow(9).height = 10;

// Weekly Trend header (row 10) — named range starts here
const weekCols = ["Week", "Buy USD", "Sell USD", "Gross Profit USD", "Margin %"];
weekCols.forEach((h, i) => {
  const cell   = wsSummary.getCell(10, i + 1);
  cell.value   = h;
  cell.font    = hFont();
  cell.fill    = fill(BRAND.navy);
  cell.border  = border();
  wsSummary.getColumn(i + 1).width = [14, 14, 14, 18, 12][i];
});
wsSummary.getRow(10).height = 22;

// Placeholder weekly data rows 11-16 (6 weeks)
const today = new Date();
for (let i = 0; i < 6; i++) {
  const d = new Date(today);
  d.setDate(d.getDate() - (5 - i) * 7);
  const label = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  const row = wsSummary.getRow(11 + i);
  [label, 0, 0, 0, null].forEach((v, j) => {
    const cell   = row.getCell(j + 1);
    cell.value   = v;
    cell.border  = border();
    cell.font    = dFont(9);
    cell.fill    = fill(i % 2 === 0 ? BRAND.white : BRAND.lightGrey);
    if (j > 0) { cell.numFmt = j === 4 ? "0.0%" : '#,##0.00'; cell.alignment = { horizontal: "right" }; }
  });
}

// Named range: WeeklySummary — A11:E16
wb.definedNames.add("WeeklySummary", "Summary!$A$11:$E$16");

wsSummary.views = [{ state: "frozen", ySplit: 10 }];

// ─── Sheet 2: By Carrier ──────────────────────────────────────────────────────

const wsCarrier = wb.addWorksheet("By Carrier", { tabColor: { argb: BRAND.accent } });
wsCarrier.properties.defaultRowHeight = 18;
wsCarrier.columns = [
  { header: "Carrier",      key: "carrier", width: 14 },
  { header: "Buy (USD)",    key: "buy",     width: 16 },
  { header: "Sell (USD)",   key: "sell",    width: 16 },
  { header: "Gross Profit", key: "gp",      width: 16 },
  { header: "Margin %",     key: "pct",     width: 12 },
];
const chRow = wsCarrier.getRow(1);
chRow.eachCell(cell => { cell.font = hFont(); cell.fill = fill(BRAND.teal); cell.border = border(); });
chRow.height = 22;

// Three placeholder rows
[["CARRIER A", 10000, 12000, 2000, 0.167], ["CARRIER B", 8000, 9500, 1500, 0.158], ["CARRIER C", 5000, 6000, 1000, 0.167]].forEach((vals, i) => {
  const row = wsCarrier.addRow({ carrier: vals[0], buy: vals[1], sell: vals[2], gp: vals[3], pct: vals[4] });
  row.eachCell((cell, col) => {
    cell.border = border(); cell.font = dFont(); cell.fill = fill(i % 2 === 0 ? BRAND.white : BRAND.lightGrey);
    if (col > 1) { cell.numFmt = col === 5 ? "0.0%" : '#,##0.00'; cell.alignment = { horizontal: "right" }; }
  });
});

wb.definedNames.add("ByCarrier", "By Carrier!$A$2:$E$4");
wsCarrier.views = [{ state: "frozen", ySplit: 1 }];

// ─── Sheet 3: By Lane ─────────────────────────────────────────────────────────

const wsLane = wb.addWorksheet("By Lane", { tabColor: { argb: BRAND.accent } });
wsLane.properties.defaultRowHeight = 18;
wsLane.columns = [
  { header: "Trade Lane",   key: "lane", width: 24 },
  { header: "Buy (USD)",    key: "buy",  width: 16 },
  { header: "Sell (USD)",   key: "sell", width: 16 },
  { header: "Gross Profit", key: "gp",   width: 16 },
  { header: "Margin %",     key: "pct",  width: 12 },
];
const lhRow = wsLane.getRow(1);
lhRow.eachCell(cell => { cell.font = hFont(); cell.fill = fill(BRAND.teal); cell.border = border(); });
lhRow.height = 22;

[["CNSHA → DEHAM", 15000, 18000, 3000, 0.167], ["SGSIN → NLRTM", 9000, 11000, 2000, 0.182], ["JPOSA → USNYC", 6000, 7200, 1200, 0.167]].forEach((vals, i) => {
  const row = wsLane.addRow({ lane: vals[0], buy: vals[1], sell: vals[2], gp: vals[3], pct: vals[4] });
  row.eachCell((cell, col) => {
    cell.border = border(); cell.font = dFont(); cell.fill = fill(i % 2 === 0 ? BRAND.white : BRAND.lightGrey);
    if (col > 1) { cell.numFmt = col === 5 ? "0.0%" : '#,##0.00'; cell.alignment = { horizontal: "right" }; }
  });
});

wb.definedNames.add("ByLane", "By Lane!$A$2:$E$4");
wsLane.views = [{ state: "frozen", ySplit: 1 }];

// ─── Sheet 4: Shipment Detail ─────────────────────────────────────────────────

const wsDetail = wb.addWorksheet("Shipment Detail", { tabColor: { argb: BRAND.navy } });
wsDetail.properties.defaultRowHeight = 16;
wsDetail.columns = [
  { header: "Shipment ID",   key: "id",             width: 14 },
  { header: "Status",        key: "status",         width: 12 },
  { header: "POL",           key: "pol",            width: 8  },
  { header: "POL Name",      key: "polName",        width: 22 },
  { header: "POD",           key: "pod",            width: 8  },
  { header: "POD Name",      key: "podName",        width: 22 },
  { header: "Carrier",       key: "carrierCode",    width: 10 },
  { header: "Contract Type", key: "contractType",   width: 14 },
  { header: "Contract Ref",  key: "contractRef",    width: 16 },
  { header: "Trade Lane",    key: "tradeLane",      width: 18 },
  { header: "Routing Term",  key: "routingTerm",    width: 14 },
  { header: "ETD",           key: "etd",            width: 12 },
  { header: "ETA",           key: "eta",            width: 12 },
  { header: "Booking Ref",   key: "bookingRef",     width: 16 },
  { header: "B/L Number",    key: "blNumber",       width: 16 },
  { header: "Vessel",        key: "vessel",         width: 20 },
  { header: "Voyage",        key: "voyage",         width: 10 },
  { header: "Incoterm",      key: "incoterm",       width: 10 },
  { header: "Movement",      key: "movementType",   width: 10 },
  { header: "Shipper",       key: "shipperName",    width: 22 },
  { header: "Consignee",     key: "consigneeName",  width: 22 },
  { header: "Commodity",     key: "commodityCode",  width: 12 },
  { header: "Containers",    key: "containerCount", width: 12 },
  { header: "TEU",           key: "totalTeu",       width: 8  },
  { header: "Buy (USD)",     key: "marginBuyUsd",   width: 14 },
  { header: "Sell (USD)",    key: "marginSellUsd",  width: 14 },
  { header: "Gross Profit",  key: "gp",             width: 14 },
  { header: "Margin %",      key: "pct",            width: 12 },
  { header: "Created At",    key: "createdAt",      width: 18 },
];
const dhRow = wsDetail.getRow(1);
dhRow.eachCell(cell => { cell.font = hFont(); cell.fill = fill(BRAND.navy); cell.border = border(); });
dhRow.height = 22;
wsDetail.autoFilter = { from: "A1", to: "AC1" };
wsDetail.views = [{ state: "frozen", ySplit: 1 }];

// ─── Notes sheet ─────────────────────────────────────────────────────────────

const wsNotes = wb.addWorksheet("README");
wsNotes.getCell("A1").value = "CargoDesk Dashboard Template — Instructions";
wsNotes.getCell("A1").font  = { name: "Calibri", size: 12, bold: true };
const notes = [
  "",
  "This workbook is a template. The server fills in the data at export time.",
  "",
  "Named ranges used by the export endpoint:",
  "  WeeklySummary  = Summary!A11:E16   (6 weekly rows: Week | Buy | Sell | Profit | Margin%)",
  "  ByCarrier      = By Carrier!A2:E?  (dynamic — rows replaced on export)",
  "  ByLane         = By Lane!A2:E?     (dynamic — rows replaced on export)",
  "",
  "To add charts:",
  "  1. Select the named range in the Summary, By Carrier, or By Lane sheet",
  "  2. Insert > Chart > choose your chart type",
  "  3. Excel will auto-update the chart when data is refreshed via export",
  "",
  "After customising, save the file and commit exports/dashboard-template.xlsx.",
  "The /api/export/dashboard/template endpoint will use this file as the base.",
];
notes.forEach((line, i) => { wsNotes.getCell(2 + i, 1).value = line; });
wsNotes.getColumn(1).width = 80;

// ─── Write ────────────────────────────────────────────────────────────────────

wb.xlsx.writeFile(OUT_FILE).then(() => {
  console.log(`Template written to: ${OUT_FILE}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. Open the file in Excel");
  console.log("  2. Add charts referencing WeeklySummary, ByCarrier, or ByLane");
  console.log("  3. Save and commit exports/dashboard-template.xlsx");
  console.log("  4. Use GET /api/export/dashboard/template to download populated reports");
}).catch(e => { console.error("Failed to write template:", e.message); process.exit(1); });
