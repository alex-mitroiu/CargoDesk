"use strict";
const ExcelJS = require("exceljs");
const path    = require("path");
const fs      = require("fs");

module.exports = function exportRoutes(app, ctx) {
  const { db, auth, applyShipmentAccessFilter, mapShipment } = ctx;

  // ─── Palette & style helpers ──────────────────────────────────────────────

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
    amber:     "FFF39C12",
  };

  const headerFill = (hex = BRAND.navy) => ({
    type: "pattern", pattern: "solid",
    fgColor: { argb: hex },
  });

  const font = (bold = false, size = 10, colorArgb = BRAND.white) => ({
    name: "Calibri", size, bold, color: { argb: colorArgb },
  });

  const border = () => ({
    top:    { style: "thin", color: { argb: BRAND.midGrey } },
    left:   { style: "thin", color: { argb: BRAND.midGrey } },
    bottom: { style: "thin", color: { argb: BRAND.midGrey } },
    right:  { style: "thin", color: { argb: BRAND.midGrey } },
  });

  const alignR = { horizontal: "right" };
  const alignC = { horizontal: "center" };

  const usd = (v) => (v == null ? 0 : Math.round(v * 100) / 100);

  // ─── Shared data queries ──────────────────────────────────────────────────

  function queryShipmentRows(user, req) {
    const rows = db.prepare(`
      SELECT s.*,
             p1.name AS pol_name, p2.name AS pod_name,
             COALESCE(buy.total, 0)  AS margin_buy_usd,
             COALESCE(sell.total, 0) AS margin_sell_usd,
             COALESCE(ctr.teu, 0)    AS total_teu,
             COALESCE(ctr.cnt, 0)    AS container_count
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      LEFT JOIN (SELECT shipment_id, SUM(amount * exchange_rate) AS total
                 FROM shipment_cost_lines WHERE type='BUY' GROUP BY shipment_id) buy
             ON buy.shipment_id = s.id
      LEFT JOIN (SELECT shipment_id, SUM(amount * exchange_rate) AS total
                 FROM shipment_cost_lines WHERE type='SELL' GROUP BY shipment_id) sell
             ON sell.shipment_id = s.id
      LEFT JOIN (SELECT shipment_id,
                        SUM(CASE WHEN size=20 THEN 1 WHEN size IN (40,45) THEN 2 ELSE 0 END) AS teu,
                        COUNT(*) AS cnt
                 FROM containers GROUP BY shipment_id) ctr
             ON ctr.shipment_id = s.id
      ORDER BY s.created_at DESC
    `).all();
    return applyShipmentAccessFilter(rows.map(r => ({
      ...mapShipment(r),
      totalTeu:       r.total_teu,
      containerCount: r.container_count,
      marginBuyUsd:   usd(r.margin_buy_usd),
      marginSellUsd:  usd(r.margin_sell_usd),
    })), user, req);
  }

  function queryCostLines() {
    return db.prepare(`
      SELECT cl.*, s.pol, s.pod, s.carrier_code, s.etd, s.booking_ref
      FROM shipment_cost_lines cl
      JOIN shipments s ON s.id = cl.shipment_id
      ORDER BY cl.shipment_id, cl.type, cl.created_at
    `).all();
  }

  function buildMarginSummary(shipments) {
    const lines = queryCostLines();

    const aggregate = (rows) => {
      const buy  = rows.filter(r => r.type === "BUY").reduce((s, r) => s + r.amount * r.exchange_rate, 0);
      const sell = rows.filter(r => r.type === "SELL").reduce((s, r) => s + r.amount * r.exchange_rate, 0);
      const gp   = sell - buy;
      const pct  = sell > 0 ? Math.round((gp / sell) * 1000) / 10 : null;
      return { buy: usd(buy), sell: usd(sell), gp: usd(gp), pct };
    };

    const today = new Date().toISOString().slice(0, 10);
    const weeks = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (5 - i) * 7);
      const end   = d.toISOString().slice(0, 10);
      const start = new Date(d.setDate(d.getDate() - 6)).toISOString().slice(0, 10);
      return { start, end, label: new Date(end).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) };
    });

    const overall = aggregate(lines);

    const byCarrier = [...new Set(lines.map(r => r.carrier_code))].map(code => ({
      carrier: code,
      ...aggregate(lines.filter(r => r.carrier_code === code)),
    })).sort((a, b) => b.sell - a.sell);

    const byLane = [...new Set(lines.map(r => `${r.pol} → ${r.pod}`))].map(lane => {
      const [pol, pod] = lane.split(" → ");
      return { lane, ...aggregate(lines.filter(r => r.pol === pol && r.pod === pod)) };
    }).sort((a, b) => b.sell - a.sell);

    const weeklyTrend = weeks.map(w => {
      const wLines = lines.filter(r => {
        const ref = (r.etd || "").slice(0, 10);
        return ref >= w.start && ref <= w.end;
      });
      return { week: w.label, ...aggregate(wLines) };
    });

    return { overall, byCarrier, byLane, weeklyTrend, shipmentCount: shipments.length };
  }

  // ─── CSV helpers ──────────────────────────────────────────────────────────

  function escCSV(v) {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  }

  const CSV_COLS = [
    ["id",              r => r.id],
    ["Status",          r => r.status],
    ["POL",             r => r.pol],
    ["POL Name",        r => r.polName],
    ["POD",             r => r.pod],
    ["POD Name",        r => r.podName],
    ["Carrier",         r => r.carrierCode],
    ["Contract Type",   r => r.contractType],
    ["Contract Ref",    r => r.contractRef],
    ["Trade Lane",      r => r.tradeLane],
    ["Routing Term",    r => r.routingTerm],
    ["ETD",             r => r.etd],
    ["ETA",             r => r.eta],
    ["Cargo Ready Date",r => r.cargoReadyDate],
    ["Booking Ref",     r => r.bookingRef],
    ["B/L Number",      r => r.blNumber],
    ["Vessel",          r => r.vessel],
    ["Voyage",          r => r.voyage],
    ["Incoterm",        r => r.incoterm],
    ["Freight Terms",   r => r.freightTerms],
    ["Movement Type",   r => r.movementType],
    ["Service Type",    r => r.serviceType],
    ["Commodity",       r => r.commodityCode],
    ["Shipper",         r => r.shipperName],
    ["Consignee",       r => r.consigneeName],
    ["Principal",       r => r.principalName],
    ["Place of Receipt",r => r.placeOfReceipt],
    ["Place of Delivery",r => r.placeOfDelivery],
    ["Containers",      r => r.containerCount],
    ["TEU",             r => r.totalTeu],
    ["Buy (USD)",       r => r.marginBuyUsd],
    ["Sell (USD)",      r => r.marginSellUsd],
    ["Gross Profit (USD)", r => usd(r.marginSellUsd - r.marginBuyUsd)],
    ["Margin %",        r => r.marginSellUsd > 0 ? Math.round((r.marginSellUsd - r.marginBuyUsd) / r.marginSellUsd * 1000) / 10 : ""],
    ["Created At",      r => r.createdAt],
  ];

  // ─── GET /api/export/shipments.csv ────────────────────────────────────────

  app.get("/api/export/shipments.csv", auth(), (req, res) => {
    const rows = queryShipmentRows(req.user, req);
    const header = CSV_COLS.map(([label]) => escCSV(label)).join(",");
    const body   = rows.map(r => CSV_COLS.map(([, fn]) => escCSV(fn(r))).join(",")).join("\n");
    const csv    = `${header}\n${body}`;
    const date   = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="shipments-${date}.csv"`);
    res.send(csv);
  });

  // ─── Shared XLSX sheet builders ───────────────────────────────────────────

  function buildSummarySheet(ws, summary, exportedAt) {
    ws.properties.defaultRowHeight = 18;

    // Title block
    ws.mergeCells("A1:F1");
    const title = ws.getCell("A1");
    title.value    = "CargoDesk — Dashboard KPI Export";
    title.font     = font(true, 14, BRAND.navy);
    title.fill     = headerFill(BRAND.lightGrey);
    title.alignment = alignC;
    ws.getRow(1).height = 28;

    ws.mergeCells("A2:F2");
    const sub = ws.getCell("A2");
    sub.value      = `Exported: ${exportedAt}    |    Shipments in scope: ${summary.shipmentCount}`;
    sub.font       = font(false, 9, BRAND.navy);
    sub.fill       = headerFill(BRAND.lightGrey);
    sub.alignment  = alignC;

    ws.getRow(3).height = 10; // spacer

    // KPI block
    const kpiHeaders = [["Metric", 28], ["Value (USD)", 18]];
    kpiHeaders.forEach(([h, w], i) => {
      const cell   = ws.getCell(4, i + 1);
      cell.value   = h;
      cell.font    = font(true, 10, BRAND.white);
      cell.fill    = headerFill(BRAND.teal);
      cell.border  = border();
      ws.getColumn(i + 1).width = w;
    });

    const kpiRows = [
      ["Total Buy",          summary.overall.buy],
      ["Total Sell",         summary.overall.sell],
      ["Gross Profit",       summary.overall.gp],
      ["Gross Margin %",     summary.overall.pct != null ? summary.overall.pct / 100 : null],
    ];
    kpiRows.forEach(([label, value], i) => {
      const row = ws.getRow(5 + i);
      row.getCell(1).value  = label;
      row.getCell(1).font   = font(false, 10, BRAND.black);
      row.getCell(1).border = border();

      const c = row.getCell(2);
      c.border = border();
      c.font   = font(false, 10, BRAND.black);
      if (label.includes("%")) {
        c.value      = value;
        c.numFmt     = "0.0%";
        c.alignment  = alignR;
        if (value != null) c.font = font(true, 10, value >= 0 ? BRAND.green : BRAND.red);
      } else {
        c.value  = value;
        c.numFmt = '#,##0.00" USD"';
        c.alignment = alignR;
      }
      if (label === "Gross Profit")
        c.font = font(true, 10, (value || 0) >= 0 ? BRAND.green : BRAND.red);
    });

    ws.getRow(9).height = 10; // spacer

    // Weekly trend table — data that a chart references
    const trendStartRow = 10;
    ["Week", "Buy USD", "Sell USD", "Gross Profit USD", "Margin %"].forEach((h, i) => {
      const cell   = ws.getCell(trendStartRow, i + 1);
      cell.value   = h;
      cell.font    = font(true, 10, BRAND.white);
      cell.fill    = headerFill(BRAND.navy);
      cell.border  = border();
    });
    summary.weeklyTrend.forEach((w, i) => {
      const row  = ws.getRow(trendStartRow + 1 + i);
      const vals = [w.week, w.buy, w.sell, w.gp, w.pct != null ? w.pct / 100 : null];
      vals.forEach((v, j) => {
        const cell   = row.getCell(j + 1);
        cell.value   = v;
        cell.border  = border();
        cell.font    = font(false, 10, BRAND.black);
        cell.fill    = { type: "pattern", pattern: "solid", fgColor: { argb: i % 2 === 0 ? BRAND.white : BRAND.lightGrey } };
        if (j > 0) {
          cell.numFmt    = j === 4 ? "0.0%" : '#,##0.00';
          cell.alignment = alignR;
        }
      });
    });
  }

  function buildCarrierSheet(ws, byCarrier) {
    ws.properties.defaultRowHeight = 18;
    ws.columns = [
      { header: "Carrier",          key: "carrier", width: 14 },
      { header: "Buy (USD)",        key: "buy",     width: 16 },
      { header: "Sell (USD)",       key: "sell",    width: 16 },
      { header: "Gross Profit",     key: "gp",      width: 16 },
      { header: "Margin %",         key: "pct",     width: 12 },
    ];
    const hRow = ws.getRow(1);
    hRow.eachCell(cell => {
      cell.font   = font(true, 10, BRAND.white);
      cell.fill   = headerFill(BRAND.teal);
      cell.border = border();
    });
    hRow.height = 22;

    byCarrier.forEach((r, i) => {
      const row = ws.addRow([r.carrier, r.buy, r.sell, r.gp, r.pct != null ? r.pct / 100 : null]);
      row.eachCell((cell, col) => {
        cell.border = border();
        cell.font   = font(false, 10, BRAND.black);
        cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: i % 2 === 0 ? BRAND.white : BRAND.lightGrey } };
        if (col > 1) {
          cell.numFmt    = col === 5 ? "0.0%" : '#,##0.00';
          cell.alignment = alignR;
        }
      });
      const gpCell  = row.getCell(4);
      const pctCell = row.getCell(5);
      gpCell.font  = font(true, 10, (r.gp  || 0) >= 0 ? BRAND.green : BRAND.red);
      if (r.pct != null) pctCell.font = font(true, 10, r.pct >= 0 ? BRAND.green : BRAND.red);
    });

    // Totals row
    const len = byCarrier.length;
    if (len > 0) {
      const totRow = ws.addRow([
        "TOTAL",
        { formula: `SUM(B2:B${1 + len})` },
        { formula: `SUM(C2:C${1 + len})` },
        { formula: `SUM(D2:D${1 + len})` },
        { formula: `IF(C${2 + len}>0,D${2 + len}/C${2 + len},0)` },
      ]);
      totRow.eachCell((cell, col) => {
        cell.font   = font(true, 10, BRAND.white);
        cell.fill   = headerFill(BRAND.navy);
        cell.border = border();
        if (col > 1) { cell.numFmt = col === 5 ? "0.0%" : '#,##0.00'; cell.alignment = alignR; }
      });
    }
  }

  function buildLaneSheet(ws, byLane) {
    ws.properties.defaultRowHeight = 18;
    ws.columns = [
      { header: "Trade Lane",       key: "lane",  width: 24 },
      { header: "Buy (USD)",        key: "buy",   width: 16 },
      { header: "Sell (USD)",       key: "sell",  width: 16 },
      { header: "Gross Profit",     key: "gp",    width: 16 },
      { header: "Margin %",         key: "pct",   width: 12 },
    ];
    const hRow = ws.getRow(1);
    hRow.eachCell(cell => {
      cell.font   = font(true, 10, BRAND.white);
      cell.fill   = headerFill(BRAND.teal);
      cell.border = border();
    });
    hRow.height = 22;

    byLane.forEach((r, i) => {
      const row = ws.addRow([r.lane, r.buy, r.sell, r.gp, r.pct != null ? r.pct / 100 : null]);
      row.eachCell((cell, col) => {
        cell.border = border();
        cell.font   = font(false, 10, BRAND.black);
        cell.fill   = { type: "pattern", pattern: "solid", fgColor: { argb: i % 2 === 0 ? BRAND.white : BRAND.lightGrey } };
        if (col > 1) { cell.numFmt = col === 5 ? "0.0%" : '#,##0.00'; cell.alignment = alignR; }
      });
      const gpCell  = row.getCell(4);
      if (r.gp != null) gpCell.font = font(true, 10, r.gp >= 0 ? BRAND.green : BRAND.red);
    });

    const len = byLane.length;
    if (len > 0) {
      const totRow = ws.addRow([
        "TOTAL",
        { formula: `SUM(B2:B${1 + len})` },
        { formula: `SUM(C2:C${1 + len})` },
        { formula: `SUM(D2:D${1 + len})` },
        { formula: `IF(C${2 + len}>0,D${2 + len}/C${2 + len},0)` },
      ]);
      totRow.eachCell((cell, col) => {
        cell.font   = font(true, 10, BRAND.white);
        cell.fill   = headerFill(BRAND.navy);
        cell.border = border();
        if (col > 1) { cell.numFmt = col === 5 ? "0.0%" : '#,##0.00'; cell.alignment = alignR; }
      });
    }
  }

  function buildShipmentDetailSheet(ws, shipments) {
    ws.properties.defaultRowHeight = 16;
    const cols = [
      { header: "Shipment ID",      key: "id",             width: 14 },
      { header: "Status",           key: "status",         width: 12 },
      { header: "POL",              key: "pol",            width: 8  },
      { header: "POL Name",         key: "polName",        width: 22 },
      { header: "POD",              key: "pod",            width: 8  },
      { header: "POD Name",         key: "podName",        width: 22 },
      { header: "Carrier",          key: "carrierCode",    width: 10 },
      { header: "Contract Type",    key: "contractType",   width: 14 },
      { header: "Contract Ref",     key: "contractRef",    width: 16 },
      { header: "Trade Lane",       key: "tradeLane",      width: 18 },
      { header: "Routing Term",     key: "routingTerm",    width: 14 },
      { header: "ETD",              key: "etd",            width: 12 },
      { header: "ETA",              key: "eta",            width: 12 },
      { header: "Booking Ref",      key: "bookingRef",     width: 16 },
      { header: "B/L Number",       key: "blNumber",       width: 16 },
      { header: "Vessel",           key: "vessel",         width: 20 },
      { header: "Voyage",           key: "voyage",         width: 10 },
      { header: "Incoterm",         key: "incoterm",       width: 10 },
      { header: "Movement",         key: "movementType",   width: 10 },
      { header: "Shipper",          key: "shipperName",    width: 22 },
      { header: "Consignee",        key: "consigneeName",  width: 22 },
      { header: "Commodity",        key: "commodityCode",  width: 12 },
      { header: "Containers",       key: "containerCount", width: 12 },
      { header: "TEU",              key: "totalTeu",       width: 8  },
      { header: "Buy (USD)",        key: "marginBuyUsd",   width: 14 },
      { header: "Sell (USD)",       key: "marginSellUsd",  width: 14 },
      { header: "Gross Profit",     key: "gp",             width: 14 },
      { header: "Margin %",         key: "pct",            width: 12 },
      { header: "Created At",       key: "createdAt",      width: 18 },
    ];
    ws.columns = cols;

    const hRow = ws.getRow(1);
    hRow.eachCell(cell => {
      cell.font   = font(true, 10, BRAND.white);
      cell.fill   = headerFill(BRAND.navy);
      cell.border = border();
    });
    hRow.height = 22;

    ws.autoFilter = { from: "A1", to: `${String.fromCharCode(64 + cols.length)}1` };

    shipments.forEach((s, i) => {
      const gp  = usd(s.marginSellUsd - s.marginBuyUsd);
      const pct = s.marginSellUsd > 0 ? Math.round(gp / s.marginSellUsd * 1000) / 10 : null;
      const row = ws.addRow({
        id: s.id, status: s.status, pol: s.pol, polName: s.polName,
        pod: s.pod, podName: s.podName, carrierCode: s.carrierCode,
        contractType: s.contractType, contractRef: s.contractRef,
        tradeLane: s.tradeLane, routingTerm: s.routingTerm,
        etd: s.etd, eta: s.eta, bookingRef: s.bookingRef, blNumber: s.blNumber,
        vessel: s.vessel, voyage: s.voyage, incoterm: s.incoterm, movementType: s.movementType,
        shipperName: s.shipperName, consigneeName: s.consigneeName, commodityCode: s.commodityCode,
        containerCount: s.containerCount, totalTeu: s.totalTeu,
        marginBuyUsd: s.marginBuyUsd, marginSellUsd: s.marginSellUsd,
        gp, pct: pct != null ? pct / 100 : null,
        createdAt: s.createdAt,
      });
      const altFill = { type: "pattern", pattern: "solid", fgColor: { argb: i % 2 === 0 ? BRAND.white : BRAND.lightGrey } };
      row.eachCell((cell, col) => {
        cell.border = border();
        cell.font   = font(false, 9, BRAND.black);
        cell.fill   = altFill;
        if (col >= 25) { cell.numFmt = col === 28 ? "0.0%" : '#,##0.00'; cell.alignment = alignR; }
        if (col === 27 && gp != null) cell.font = font(false, 9, gp >= 0 ? BRAND.green : BRAND.red);
      });
    });

    // Freeze header row
    ws.views = [{ state: "frozen", ySplit: 1 }];
  }

  // ─── Approach A: Fully programmatic ExcelJS ───────────────────────────────

  app.get("/api/export/dashboard/xlsx", auth(), (req, res) => {
    const shipments   = queryShipmentRows(req.user, req);
    const summary     = buildMarginSummary(shipments);
    const exportedAt  = new Date().toLocaleString("en-GB");

    const wb = new ExcelJS.Workbook();
    wb.creator  = "CargoDesk";
    wb.created  = new Date();
    wb.modified = new Date();

    buildSummarySheet(wb.addWorksheet("Summary", { tabColor: { argb: BRAND.teal } }), summary, exportedAt);
    buildCarrierSheet(wb.addWorksheet("By Carrier", { tabColor: { argb: BRAND.accent } }), summary.byCarrier);
    buildLaneSheet(wb.addWorksheet("By Lane", { tabColor: { argb: BRAND.accent } }), summary.byLane);
    buildShipmentDetailSheet(wb.addWorksheet("Shipment Detail", { tabColor: { argb: BRAND.navy } }), shipments);

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="cargodesk-dashboard-${date}.xlsx"`);
    wb.xlsx.write(res).then(() => res.end()).catch(() => res.status(500).end());
  });

  // ─── Approach B: Template-based ───────────────────────────────────────────

  const TEMPLATE_PATH = path.join(__dirname, "..", "exports", "dashboard-template.xlsx");

  app.get("/api/export/dashboard/template", auth(), async (req, res) => {
    if (!fs.existsSync(TEMPLATE_PATH)) {
      return res.status(404).json({ error: "Template not found. Run: node scripts/create-export-template.js" });
    }

    const shipments  = queryShipmentRows(req.user, req);
    const summary    = buildMarginSummary(shipments);
    const exportedAt = new Date().toLocaleString("en-GB");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(TEMPLATE_PATH);

    // Fill each sheet by name — template preserves column widths, tab colours, and any
    // charts the user added after running create-export-template.js.
    const wsSummary = wb.getWorksheet("Summary");
    if (wsSummary) {
      // Named data range: KPI block starts at B5, weekly trend at B11
      wsSummary.getCell("A1").value = "CargoDesk — Dashboard KPI Export";
      wsSummary.getCell("A2").value = `Exported: ${exportedAt}    |    Shipments in scope: ${summary.shipmentCount}`;
      const kpiVals = [summary.overall.buy, summary.overall.sell, summary.overall.gp,
                       summary.overall.pct != null ? summary.overall.pct / 100 : null];
      kpiVals.forEach((v, i) => { wsSummary.getCell(5 + i, 2).value = v; });
      summary.weeklyTrend.forEach((w, i) => {
        const r = wsSummary.getRow(11 + i);
        r.getCell(1).value = w.week;
        r.getCell(2).value = w.buy;
        r.getCell(3).value = w.sell;
        r.getCell(4).value = w.gp;
        r.getCell(5).value = w.pct != null ? w.pct / 100 : null;
      });
    }

    const wsCarrier = wb.getWorksheet("By Carrier");
    if (wsCarrier) {
      // Clear data rows below header (row 1)
      const dataStart = 2;
      for (let i = wsCarrier.rowCount; i >= dataStart; i--) wsCarrier.spliceRows(i, 1);
      buildCarrierSheet(wsCarrier, summary.byCarrier);
    }

    const wsLane = wb.getWorksheet("By Lane");
    if (wsLane) {
      const dataStart = 2;
      for (let i = wsLane.rowCount; i >= dataStart; i--) wsLane.spliceRows(i, 1);
      buildLaneSheet(wsLane, summary.byLane);
    }

    const wsDetail = wb.getWorksheet("Shipment Detail");
    if (wsDetail) {
      const dataStart = 2;
      for (let i = wsDetail.rowCount; i >= dataStart; i--) wsDetail.spliceRows(i, 1);
      buildShipmentDetailSheet(wsDetail, shipments);
    }

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="cargodesk-dashboard-template-${date}.xlsx"`);
    wb.xlsx.write(res).then(() => res.end()).catch(() => res.status(500).end());
  });
};
