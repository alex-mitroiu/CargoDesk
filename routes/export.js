"use strict";
const ExcelJS = require("exceljs");
const path    = require("path");
const fs      = require("fs");

module.exports = function exportRoutes(app, ctx) {
  const { db, auth, applyShipmentAccessFilter, mapShipment, roundCents, createRateLimiter } = ctx;

  // Every route below does a full server-side multi-join build (CSV) or an in-memory ExcelJS
  // workbook build (XLSX) across every shipment the caller can see — cheap for one call, not
  // something that should be triggerable in a tight loop. Keyed per-user.
  const exportRateLimit = createRateLimiter({
    windowMs: 5 * 60 * 1000, max: 15, maxEnvVar: "EXPORT_RATE_MAX",
    keyFn: req => req.user.id,
    message: "Too many exports recently — please slow down",
  });

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

  const usd = (v) => (v == null ? 0 : roundCents(v));

  // ─── Shared data queries ──────────────────────────────────────────────────

  // shipment.pol/pod are the journey's overall DOOR-TO-DOOR bookends, not necessarily
  // the real sea Port of Loading/Discharge (a Door pickup or trucked final Delivery leg
  // can put an inland city there instead) — same gap fixed for the shipments list in
  // routes/shipments.js's resolveSeaPorts, duplicated here (small per-file helper,
  // matching this codebase's existing precedent) so exports show a real sea port under
  // "POL"/"POD" rather than an inland city.
  function resolveSeaPorts(shipmentIds) {
    if (!shipmentIds.length) return {};
    const legs = db.prepare(`
      SELECT shipment_id, pol, pod FROM shipment_legs
      WHERE leg_type='SEA' AND shipment_id IN (${shipmentIds.map(() => '?').join(',')})
      ORDER BY leg_order ASC
    `).all(...shipmentIds);
    const bySeaShipment = {};
    for (const l of legs) {
      const g = (bySeaShipment[l.shipment_id] ??= { seaPol: l.pol, seaPod: l.pod });
      g.seaPod = l.pod;
    }
    const codes = [...new Set(Object.values(bySeaShipment).flatMap(g => [g.seaPol, g.seaPod]).filter(Boolean))];
    const names = {};
    if (codes.length) {
      db.prepare(`SELECT unlocode, name FROM port_locations WHERE unlocode IN (${codes.map(() => '?').join(',')})`)
        .all(...codes).forEach(r => { names[r.unlocode] = r.name; });
    }
    for (const g of Object.values(bySeaShipment)) {
      g.seaPolName = names[g.seaPol] || '';
      g.seaPodName = names[g.seaPod] || '';
    }
    return bySeaShipment;
  }

  function queryShipmentRows(user, req) {
    const rows = db.prepare(`
      SELECT s.*,
             p1.name AS pol_name, p2.name AS pod_name,
             emo.name  AS emo_office_name, imo.name  AS imo_office_name, ctrl.name AS controlling_office_name,
             COALESCE(buy.total, 0)  AS margin_buy_usd,
             COALESCE(sell.total, 0) AS margin_sell_usd,
             COALESCE(ctr.teu, 0)    AS total_teu,
             COALESCE(ctr.cnt, 0)    AS container_count
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      LEFT JOIN offices emo  ON emo.id  = s.emo_office_id
      LEFT JOIN offices imo  ON imo.id  = s.imo_office_id
      LEFT JOIN offices ctrl ON ctrl.id = s.controlling_office_id
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
    const seaPorts = resolveSeaPorts(rows.map(r => r.id));
    return applyShipmentAccessFilter(rows.map(r => ({
      ...mapShipment(r),
      totalTeu:       r.total_teu,
      containerCount: r.container_count,
      marginBuyUsd:   usd(r.margin_buy_usd),
      marginSellUsd:  usd(r.margin_sell_usd),
      ...(seaPorts[r.id] || { seaPol: r.pol, seaPod: r.pod, seaPolName: r.pol_name || '', seaPodName: r.pod_name || '' }),
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

  // Field registry backing the Shipments page's "Export CSV" field-picker modal — mirrored on
  // the frontend (src/pages/shipments/ShipmentsPage.jsx's EXPORT_FIELD_GROUPS) since frontend
  // and backend don't share a module in this app (same split already used for
  // ADDITIONAL_PARTY_ROLES/CONTRACT_PRESETS elsewhere). `key` is the stable id sent over the
  // wire via ?fields=; `mandatory` fields are always included server-side regardless of what
  // the caller requests — the modal shows them checked and disabled, but this is the actual
  // enforcement point, not just a client-side nicety. "ETD / ATD" and "ETA / ATA" are
  // deliberately one column each, not four — this app has no independently-populated ATD/ATA
  // distinct from ETD/ETA; etd/eta get overwritten in place once AIS-confirmed (see
  // shipment_legs.etd_source/eta_source), so the shipment's own etd/eta value already *is* the
  // ATD/ATA once known.
  const CSV_FIELDS = [
    ["id",                   "Shipment ID",         true,  r => r.id],
    ["status",               "Status",              false, r => r.status],
    ["pol",                  "POL",                 true,  r => r.seaPol || r.pol],
    ["polName",              "POL Name",             false, r => r.seaPolName || r.polName],
    ["pod",                  "POD",                 true,  r => r.seaPod || r.pod],
    ["podName",              "POD Name",             false, r => r.seaPodName || r.podName],
    ["doorPickup",           "Door Pickup",          false, r => r.seaPol && r.seaPol !== r.pol ? r.pol : ""],
    ["doorDelivery",         "Door Delivery",        false, r => r.seaPod && r.seaPod !== r.pod ? r.pod : ""],
    ["tradeLane",            "Trade Lane",           false, r => r.tradeLane],
    ["routingTerm",          "Routing Term",         false, r => r.routingTerm],
    ["placeOfReceipt",       "Place of Receipt",     false, r => r.placeOfReceipt],
    ["placeOfDelivery",      "Place of Delivery",    false, r => r.placeOfDelivery],
    ["etd",                  "ETD / ATD",           true,  r => r.etd],
    ["eta",                  "ETA / ATA",           true,  r => r.eta],
    ["cargoReadyDate",       "Cargo Ready Date",     false, r => r.cargoReadyDate],
    ["createdAt",            "Created At",           false, r => r.createdAt],
    ["carrierCode",          "Carrier",              false, r => r.carrierCode],
    ["vessel",               "Vessel",               false, r => r.vessel],
    ["vesselImo",            "Vessel IMO",           false, r => r.vesselImo],
    ["voyage",               "Voyage",               false, r => r.voyage],
    ["bookingRef",           "Booking Ref",          false, r => r.bookingRef],
    ["blNumber",             "B/L Number",           false, r => r.blNumber],
    ["contractType",         "Contract Type",        false, r => r.contractType],
    ["contractRef",          "Contract Ref",         false, r => r.contractRef],
    ["contractValidFrom",    "Contract Valid From",  false, r => r.contractValidFrom],
    ["contractValidTo",      "Contract Valid To",    false, r => r.contractValidTo],
    ["incoterm",             "Incoterm",             false, r => r.incoterm],
    ["freightTerms",         "Freight Terms",        false, r => r.freightTerms],
    ["movementType",         "Movement Type",        false, r => r.movementType],
    ["serviceType",          "Service Type",         false, r => r.serviceType],
    ["commodityCode",        "Commodity",            false, r => r.commodityCode],
    ["containerCount",       "Containers",           false, r => r.containerCount],
    ["totalTeu",             "TEU",                  false, r => r.totalTeu],
    ["shipperName",          "Shipper",              false, r => r.shipperName],
    ["consigneeName",        "Consignee",            false, r => r.consigneeName],
    ["principalName",        "Principal",            false, r => r.principalName],
    ["notifyName",           "Notify Party",         false, r => r.notifyName],
    ["emoOfficeName",        "EMO Office",           false, r => r.emoOfficeName],
    ["imoOfficeName",        "IMO Office",           false, r => r.imoOfficeName],
    ["controllingOfficeName","Controlling Office",   false, r => r.controllingOfficeName],
    ["declaredValue",        "Declared Value",       false, r => r.declaredValue],
    ["declaredValueCurrency","Declared Value Currency", false, r => r.declaredValueCurrency],
    ["marginBuyUsd",         "Buy (USD)",            false, r => r.marginBuyUsd],
    ["marginSellUsd",        "Sell (USD)",           false, r => r.marginSellUsd],
    ["grossProfit",          "Gross Profit (USD)",   false, r => usd(r.marginSellUsd - r.marginBuyUsd)],
    ["marginPct",            "Margin %",             false, r => r.marginSellUsd > 0 ? Math.round((r.marginSellUsd - r.marginBuyUsd) / r.marginSellUsd * 1000) / 10 : ""],
  ];
  const MANDATORY_FIELD_KEYS = CSV_FIELDS.filter(([, , mandatory]) => mandatory).map(([key]) => key);

  // ─── GET /api/export/shipments.csv ────────────────────────────────────────

  app.get("/api/export/shipments.csv", auth(), exportRateLimit, (req, res) => {
    const rows = queryShipmentRows(req.user, req);
    // No ?fields= (or an empty one) means "export everything" — preserves the old one-click
    // behavior for any caller that doesn't go through the field-picker modal. When fields ARE
    // specified, mandatory keys are force-included here regardless of what was actually sent —
    // the modal already prevents unchecking them client-side, but the server is the real
    // enforcement point, not the UI.
    const requested = (req.query.fields || "").split(",").map(s => s.trim()).filter(Boolean);
    const selected = requested.length
      ? new Set([...requested, ...MANDATORY_FIELD_KEYS])
      : new Set(CSV_FIELDS.map(([key]) => key));
    const cols = CSV_FIELDS.filter(([key]) => selected.has(key));
    const header = cols.map(([, label]) => escCSV(label)).join(",");
    const body   = rows.map(r => cols.map(([, , , fn]) => escCSV(fn(r))).join(",")).join("\n");
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

  app.get("/api/export/dashboard/xlsx", auth(), exportRateLimit, (req, res) => {
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

  app.get("/api/export/dashboard/template", auth(), exportRateLimit, async (req, res) => {
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
