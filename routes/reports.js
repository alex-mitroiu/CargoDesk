"use strict";

// GP-by-trade-area report — aggregates every shipment's own BUY/SELL cost lines by the
// shipment's origin (POL) region, country, or carrier, reusing the exact same
// GpBreakdownPanel/ShipmentGpSankey the single-shipment GP Overview page already renders (see
// src/pages/ReportsPage.jsx) — only the underlying `lines` array is scoped differently, to a
// whole group instead of one shipment. ("gp-by-geo" is the route's original, narrower name from
// before carrier grouping existed — kept as-is rather than renamed, since nothing outside this
// file and ReportsPage.jsx depends on it and a rename buys nothing.)
//
// Origin (POL), not destination or the full lane, is deliberately the attribution side for
// region/country grouping — the simplest, most defensible v1 given there's no existing "which
// end owns this P&L" convention in this codebase to defer to; matches how `tradeLane` itself
// already leads with the POL-derived lane. Also uses the shipment's raw `pol` (door-to-door
// bookend), the same simplification GET /api/margin/summary's own byLane breakdown already
// makes, rather than resolving the real SEA leg via resolveSeaPorts() — worth revisiting
// together if this ever needs to be precise for a Door-pickup-heavy trade lane.
//
// "Region" here means trade lane (`trade_lanes`/`country_trade_lanes`) — the SAME geography
// already surfaced everywhere else in the app as the shipment "Trade Lane" field (e.g.
// "EU-N → NAM"), not the separate `regions`/`countries.region_code` MDM table. Confirmed live
// that the latter is scaffolded but never actually populated (every country's region_code is
// blank in this data) while country_trade_lanes has real, complete coverage — using the dormant
// one would make "By Region" permanently empty.
module.exports = function reportsRoutes(app, ctx) {
  const { db, ok, err, auth, requireRole, mapCostLine, roundCents, portCountryMap, getSettings,
          docAmountUsd, runDunningSweep,
          resolveInvoiceThresholds, runInvoiceCollectionsSweep, businessDaysBetween, mapInvoiceStatusOverride } = ctx;

  const financeGate = (req, res) => {
    const u = req.user;
    const roles = Array.isArray(u.roles) ? u.roles : [u.role || 'viewer'];
    if (!roles.includes('admin') && !u.canViewFinance) { err(res, "Finance access not enabled for your account", 403); return false; }
    return true;
  };

  function escCSV(v) {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // Plain-date arithmetic (YYYY-MM-DD in, YYYY-MM-DD out) for the period-over-period comparison
  // below — no timezone library needed since every date this app deals with here is already a
  // bare date string (ETD or created_at, sliced to 10 chars).
  function shiftDate(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  const GROUP_LABEL = { region: "Region", country: "Country", carrier: "Carrier" };

  app.get("/api/reports/gp-by-geo", auth(), (req, res) => {
    if (!financeGate(req, res)) return;
    const groupBy = ['region', 'country', 'carrier'].includes(req.query.groupBy) ? req.query.groupBy : 'country';
    const value = (req.query.value || '').trim();
    const dateFrom = (req.query.from || '').trim();
    const dateTo   = (req.query.to || '').trim();
    const format = req.query.format === 'csv' ? 'csv' : 'json';

    const allRows = db.prepare(`
      SELECT cl.*, s.pol, s.carrier_code, s.etd, s.created_at AS shp_created_at
      FROM shipment_cost_lines cl
      JOIN shipments s ON s.id = cl.shipment_id
    `).all();
    let rows = allRows;

    // Same reference-date convention GET /api/margin/summary's own weeklyBreakdown already
    // uses — a shipment's ETD when it has one, its own created_at otherwise — so a shipment
    // still in planning (no ETD yet) doesn't just silently vanish from every date-ranged report.
    if (dateFrom || dateTo) {
      rows = allRows.filter(r => {
        const ref = (r.etd || r.shp_created_at || '').slice(0, 10);
        if (dateFrom && ref < dateFrom) return false;
        if (dateTo && ref > dateTo) return false;
        return true;
      });
    }

    const countryNames = {};
    db.prepare("SELECT iso2, name FROM countries").all().forEach(c => { countryNames[c.iso2] = c.name; });
    const countryLane = {};
    db.prepare("SELECT iso2, lane_code FROM country_trade_lanes").all()
      .forEach(r => { if (!(r.iso2 in countryLane)) countryLane[r.iso2] = r.lane_code; });
    const laneNames = {};
    db.prepare("SELECT code, name FROM trade_lanes").all().forEach(l => { laneNames[l.code] = l.name; });
    const carrierNames = {};
    db.prepare("SELECT code, name FROM carriers").all().forEach(c => { carrierNames[c.code] = c.name; });

    const keyOf = row => {
      if (groupBy === 'carrier') return row.carrier_code || '';
      const iso2 = portCountryMap[row.pol] || '';
      if (!iso2) return '';
      return groupBy === 'region' ? (countryLane[iso2] || '') : iso2;
    };
    const nameOf = key => groupBy === 'carrier' ? (carrierNames[key] || key)
      : groupBy === 'region' ? (laneNames[key] || key) : (countryNames[key] || key);

    // Period-over-period comparison — only meaningful when the caller has picked a genuine,
    // bounded window on both ends; an open-ended range ("any" From or To) has no defensible
    // "prior period" of the same length to diff against, so comparison is simply omitted
    // rather than guessed at (surfaced to the frontend as comparisonAvailable:false).
    let prevMarginByKey = null;
    if (dateFrom && dateTo) {
      const spanDays = Math.round((new Date(`${dateTo}T00:00:00Z`) - new Date(`${dateFrom}T00:00:00Z`)) / 86400000) + 1;
      const prevTo = shiftDate(dateFrom, -1);
      const prevFrom = shiftDate(dateFrom, -spanDays);
      const prevRows = allRows.filter(r => {
        const ref = (r.etd || r.shp_created_at || '').slice(0, 10);
        return ref >= prevFrom && ref <= prevTo;
      });
      const byKeyPrev = new Map();
      for (const row of prevRows) {
        const key = keyOf(row);
        if (!key) continue;
        if (!byKeyPrev.has(key)) byKeyPrev.set(key, []);
        byKeyPrev.get(key).push(row);
      }
      prevMarginByKey = new Map();
      for (const [key, rowsForKey] of byKeyPrev) {
        const mapped = rowsForKey.map(mapCostLine);
        const sell = mapped.filter(l => l.type === 'SELL').reduce((s, l) => s + l.amountUsd, 0);
        const buy  = mapped.filter(l => l.type === 'BUY').reduce((s, l) => s + l.amountUsd, 0);
        const sellRounded = roundCents(sell), gpRounded = roundCents(sell - buy);
        prevMarginByKey.set(key, sellRounded > 0 ? Math.round((gpRounded / sellRounded) * 1000) / 10 : null);
      }
    }

    if (!value) {
      const byKey = new Map();
      for (const row of rows) {
        const key = keyOf(row);
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, { lines: [], shipmentIds: new Set() });
        const bucket = byKey.get(key);
        bucket.lines.push(row);
        bucket.shipmentIds.add(row.shipment_id);
      }
      let results = [...byKey.entries()].map(([key, bucket]) => {
        const mapped = bucket.lines.map(mapCostLine);
        const sell = mapped.filter(l => l.type === 'SELL').reduce((s, l) => s + l.amountUsd, 0);
        const buy  = mapped.filter(l => l.type === 'BUY').reduce((s, l) => s + l.amountUsd, 0);
        const totalSellUsd = roundCents(sell), totalBuyUsd = roundCents(buy), grossProfitUsd = roundCents(sell - buy);
        const grossMarginPct = totalSellUsd > 0 ? Math.round((grossProfitUsd / totalSellUsd) * 1000) / 10 : null;
        const prevMarginPct = prevMarginByKey ? (prevMarginByKey.has(key) ? prevMarginByKey.get(key) : null) : null;
        const marginDeltaPts = (grossMarginPct != null && prevMarginPct != null)
          ? Math.round((grossMarginPct - prevMarginPct) * 10) / 10 : null;
        return { code: key, name: nameOf(key), shipmentCount: bucket.shipmentIds.size,
          totalSellUsd, totalBuyUsd, grossProfitUsd, grossMarginPct, marginDeltaPts };
      });
      // Worst-margin-first once a target's configured (see Application Settings -> Finance ->
      // "Reports - GP Target") — that's the whole point of the setting, surfacing the problem
      // rows without a manual scan. No target set -> falls back to the original sell-volume-
      // desc ordering, since there's nothing to rank against.
      const targetPct = parseFloat((getSettings() || {}).gp_target_pct);
      const hasTarget = !isNaN(targetPct);
      results.sort(hasTarget
        ? (a, b) => (a.grossMarginPct ?? Infinity) - (b.grossMarginPct ?? Infinity)
        : (a, b) => b.totalSellUsd - a.totalSellUsd);

      if (format === 'csv') {
        const cols = [
          [GROUP_LABEL[groupBy], r => r.name], ["Code", r => r.code], ["Shipments", r => r.shipmentCount],
          ["Sell (USD)", r => r.totalSellUsd], ["Buy (USD)", r => r.totalBuyUsd],
          ["Gross Profit (USD)", r => r.grossProfitUsd], ["Margin %", r => r.grossMarginPct ?? ""],
          ...(prevMarginByKey ? [["Margin Δ vs Prior Period (pts)", r => r.marginDeltaPts ?? ""]] : []),
        ];
        const header = cols.map(([label]) => escCSV(label)).join(",");
        const body = results.map(r => cols.map(([, fn]) => escCSV(fn(r))).join(",")).join("\n");
        const date = new Date().toISOString().slice(0, 10);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="reports-by-${groupBy}-${date}.csv"`);
        return res.send(`${header}\n${body}`);
      }
      return ok(res, { results, targetPct: hasTarget ? targetPct : null, comparisonAvailable: !!prevMarginByKey });
    }

    const lines = rows.filter(r => keyOf(r) === value).map(mapCostLine);
    if (format === 'csv') {
      const cols = [
        ["Type", r => r.type], ["Charge Code", r => r.chargeCode], ["Currency", r => r.currency],
        ["Amount", r => r.amount], ["Amount (USD)", r => r.amountUsd],
        ["Actual (USD)", r => r.actualAmountUsd ?? ""], ["Status", r => r.status],
        ["Payment Indicator", r => r.paymentIndicator], ["Shipment ID", r => r.shipmentId],
      ];
      const header = cols.map(([label]) => escCSV(label)).join(",");
      const body = lines.map(r => cols.map(([, fn]) => escCSV(fn(r))).join(",")).join("\n");
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="reports-${groupBy}-${value}-${date}.csv"`);
      return res.send(`${header}\n${body}`);
    }
    ok(res, lines);
  });

  // Billing Performance report (TKT-B4VBDH, Epic TKT-KR6ZBT) — every FR01/FR02 invoice ever
  // generated, row-level and enriched, so the frontend can filter/slice by any combination of
  // office, customer, trade lane, and carrier rather than being locked into one groupBy at a
  // time the way gp-by-geo above is. Deliberately returns the full row set (bounded by however
  // many invoices actually exist — not a scale concern for this kind of platform) rather than a
  // pre-aggregated summary, so the frontend owns the slicing the same way ShipmentsPage already
  // owns its own client-side filtering.
  app.get("/api/reports/billing-performance", auth(), (req, res) => {
    if (!financeGate(req, res)) return;
    const format = req.query.format === 'csv' ? 'csv' : 'json';

    const rows = db.prepare(`
      SELECT d.*, s.carrier_code, s.pol, s.pod, s.emo_office_id,
             s.principal_id, s.principal_name, s.consignee_id, s.consignee_name
      FROM shipment_documents d
      JOIN shipments s ON s.id = d.shipment_id
      WHERE d.doc_type IN ('FR01','FR02')
      ORDER BY d.created_at DESC
    `).all();

    const officeNames = {};
    db.prepare("SELECT id, code, name FROM offices").all().forEach(o => { officeNames[o.id] = `${o.code} — ${o.name}`; });
    const carrierNames = {};
    db.prepare("SELECT code, name FROM carriers").all().forEach(c => { carrierNames[c.code] = c.name; });
    const countryLane = {};
    db.prepare("SELECT iso2, lane_code FROM country_trade_lanes").all()
      .forEach(r => { if (!(r.iso2 in countryLane)) countryLane[r.iso2] = r.lane_code; });
    const laneNames = {};
    db.prepare("SELECT code, name FROM trade_lanes").all().forEach(l => { laneNames[l.code] = l.name; });
    const custById = {};
    db.prepare("SELECT id, credit_terms_days, invoice_deadline_days FROM customers").all().forEach(c => { custById[c.id] = c; });

    const todayMs = Date.now();
    const results = rows.map(r => {
      const respId   = r.principal_id || r.consignee_id || null;
      const respName = r.principal_id ? r.principal_name : r.consignee_name;
      const amountUsd = docAmountUsd(r);
      const isLive = r.status === 'confirmed'; // draft/voided never carry a real payment status
      const outstandingUsd = isLive ? Math.max(0, roundCents(amountUsd - (r.paid_amount || 0))) : null;
      const paymentStatus = !isLive ? null : outstandingUsd <= 0 ? 'paid' : (r.paid_amount || 0) > 0 ? 'partial' : 'unpaid';
      let daysOverdue = null;
      if (isLive && outstandingUsd > 0) {
        const termsDays = respId ? (custById[respId]?.credit_terms_days ?? 0) : 0;
        const refDate = r.confirmed_at || r.created_at;
        const dueMs = new Date(refDate).getTime() + (termsDays || 0) * 86400000;
        daysOverdue = Math.floor((todayMs - dueMs) / 86400000);
      }
      // paymentState — the single unified status this report leads with (filter chips + the
      // table's own STATUS column): a manager cares "is this paid, and if not, how late is it",
      // not the document's own draft/confirmed/voided lifecycle label first. Draft/voided still
      // resolve to their own distinct states rather than being folded away, so nothing about the
      // existing document-status data is lost — they're just no longer the LEADING concept.
      const paymentState = r.status === 'voided' ? 'voided'
        : !isLive ? 'draft'
        : paymentStatus === 'paid' ? 'paid'
        : (daysOverdue != null && daysOverdue > 0) ? 'overdue'
        : paymentStatus;
      const laneCode = countryLane[portCountryMap[r.pol]] || '';
      return {
        docId: r.id, shipmentId: r.shipment_id, docType: r.doc_type, filename: r.filename,
        status: r.status || 'draft', paymentState, createdAt: r.created_at, confirmedAt: r.confirmed_at || null,
        firstSentAt: r.first_sent_at || null, sent: !!r.first_sent_at,
        lastReminderSentAt: r.last_reminder_sent_at || null,
        paidAt: r.paid_at || null, paidAmount: r.paid_amount ?? null, transactionId: r.transaction_id || '',
        amountUsd, outstandingUsd, paymentStatus, daysOverdue,
        officeId: r.emo_office_id || null, officeName: officeNames[r.emo_office_id] || null,
        customerId: respId, customerName: respName || null,
        carrierCode: r.carrier_code || null, carrierName: carrierNames[r.carrier_code] || r.carrier_code || null,
        laneCode: laneCode || null, laneName: laneCode ? (laneNames[laneCode] || laneCode) : null,
        pol: r.pol || null, pod: r.pod || null,
      };
    });

    // Missing — a shipment that's earned the right to be invoiced (delivered, past its
    // responsible party's own invoice_deadline_days) but has NO FR01/FR02 at all, so it can
    // never show up above (that scan only ever walks shipment_documents). Same "delivered +
    // past deadline" definition GET /api/invoice-deadlines/overdue and the Invoice Collections
    // report already use — reused here, not reinvented, so all three can never disagree about
    // what "missing" means. Direct bug report: these shipments were invisible to Billing
    // Performance entirely, which defeats the report's own purpose of surfacing collection risk.
    const invoicedShipmentIds = new Set(rows.map(r => r.shipment_id));
    const deliveredRows = db.prepare(`
      SELECT s.id AS shipment_id, s.carrier_code, s.pol, s.pod, s.emo_office_id,
             s.principal_id, s.principal_name, s.consignee_id, s.consignee_name,
             m.completed_at AS delivered_at
      FROM shipments s
      JOIN shipment_milestones m ON m.shipment_id = s.id AND m.milestone_key = 'delivered' AND m.completed_at != ''
      WHERE s.status != 'Cancelled'
    `).all();
    for (const r of deliveredRows) {
      if (invoicedShipmentIds.has(r.shipment_id)) continue;
      const respId   = r.principal_id || r.consignee_id || null;
      const respName = r.principal_id ? r.principal_name : r.consignee_name;
      const deadlineDays = respId ? custById[respId]?.invoice_deadline_days : null;
      if (deadlineDays == null) continue; // no configured deadline -> nothing to be "missing" against
      const daysSinceDelivery = Math.floor((todayMs - new Date(r.delivered_at).getTime()) / 86400000);
      const daysOverdue = daysSinceDelivery - deadlineDays;
      if (daysOverdue <= 0) continue;
      const laneCode = countryLane[portCountryMap[r.pol]] || '';
      results.push({
        docId: null, shipmentId: r.shipment_id, docType: null, filename: null,
        status: null, paymentState: 'missing', createdAt: r.delivered_at, confirmedAt: null,
        firstSentAt: null, sent: false, lastReminderSentAt: null,
        paidAt: null, paidAmount: null, transactionId: '',
        amountUsd: null, outstandingUsd: null, paymentStatus: null, daysOverdue,
        officeId: r.emo_office_id || null, officeName: officeNames[r.emo_office_id] || null,
        customerId: respId, customerName: respName || null,
        carrierCode: r.carrier_code || null, carrierName: carrierNames[r.carrier_code] || r.carrier_code || null,
        laneCode: laneCode || null, laneName: laneCode ? (laneNames[laneCode] || laneCode) : null,
        pol: r.pol || null, pod: r.pod || null,
      });
    }
    results.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    if (format === 'csv') {
      const cols = [
        ["Shipment", r => r.shipmentId], ["Doc Type", r => r.docType ?? ""], ["Filename", r => r.filename ?? ""],
        ["Status", r => r.status ?? ""], ["Payment State", r => r.paymentState], ["Sent", r => r.sent ? "Yes" : "No"],
        ["Payment Status", r => r.paymentStatus ?? ""], ["Days Overdue", r => r.daysOverdue ?? ""],
        ["Amount (USD)", r => r.amountUsd ?? ""], ["Outstanding (USD)", r => r.outstandingUsd ?? ""],
        ["Paid On", r => r.paidAt ?? ""], ["Paid Amount", r => r.paidAmount ?? ""], ["Transaction ID", r => r.transactionId],
        ["Office", r => r.officeName ?? ""], ["Customer", r => r.customerName ?? ""],
        ["Carrier", r => r.carrierName ?? ""], ["Trade Lane", r => r.laneName ?? ""],
        ["Created", r => r.createdAt], ["Confirmed", r => r.confirmedAt ?? ""],
      ];
      const header = cols.map(([label]) => escCSV(label)).join(",");
      const body = results.map(r => cols.map(([, fn]) => escCSV(fn(r))).join(",")).join("\n");
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="billing-performance-${date}.csv"`);
      return res.send(`${header}\n${body}`);
    }
    ok(res, results);
  });

  // Invoice Collections report (Epic TKT-G11AHW) — "scan all shipments" + Paid/Not Paid/Overdue/
  // Missing/Cancelled, per shipment's own MOST RECENT FR01/FR02 (not confirmed-only — a voided-
  // then-reissued invoice correctly shows the reissued one's real status, not stuck Cancelled).
  // Status resolution order matters: Cancelled first (the resolved document is voided — the
  // existing v0.53.0 Reverse/Debit-Credit-Note mechanism, reused not rebuilt), then Missing (no
  // confirmed invoice at all, reusing GET /api/invoice-deadlines/overdue's own definition), then
  // Paid/Overdue/Not Paid against the resolved per-office/per-country business-day threshold —
  // never a hardcoded 5, so this can never disagree with the collections sweep about what
  // "overdue" means for a given shipment.
  app.get("/api/reports/invoice-collections", auth(), (req, res) => {
    if (!financeGate(req, res)) return;

    const latestDocRows = db.prepare(`
      SELECT d.* FROM shipment_documents d
      INNER JOIN (
        SELECT shipment_id, MAX(created_at) AS max_created
        FROM shipment_documents WHERE doc_type IN ('FR01','FR02') GROUP BY shipment_id
      ) latest ON latest.shipment_id = d.shipment_id AND latest.max_created = d.created_at
      WHERE d.doc_type IN ('FR01','FR02')
    `).all();
    const latestDocByShipment = {};
    for (const r of latestDocRows) latestDocByShipment[r.shipment_id] = r;

    const shipmentIds = new Set(Object.keys(latestDocByShipment));
    const missingRows = db.prepare(`
      SELECT s.id AS shipment_id, s.principal_id, s.principal_name, s.emo_office_id,
             m.completed_at AS delivered_at
      FROM shipments s
      JOIN shipment_milestones m ON m.shipment_id = s.id AND m.milestone_key = 'delivered' AND m.completed_at != ''
      WHERE s.status != 'Cancelled'
    `).all();
    const todayIso = new Date().toISOString();
    const todayMs = Date.now();
    const missingShipmentIds = new Set();
    for (const r of missingRows) {
      if (shipmentIds.has(r.shipment_id)) continue; // has a real invoice, not missing
      if (!r.principal_id) continue;
      const c = db.prepare("SELECT invoice_deadline_days FROM customers WHERE id=?").get(r.principal_id);
      if (!c || c.invoice_deadline_days == null) continue;
      const daysSinceDelivery = Math.floor((todayMs - new Date(r.delivered_at).getTime()) / 86400000);
      if (daysSinceDelivery - c.invoice_deadline_days <= 0) continue;
      missingShipmentIds.add(r.shipment_id);
    }

    const userNames = {};
    db.prepare("SELECT id, name, email FROM users").all().forEach(u => { userNames[u.id] = u.name || u.email; });
    const overrideByDoc = {};
    db.prepare(`
      SELECT o.* FROM invoice_status_overrides o
      INNER JOIN (SELECT document_id, MAX(overridden_at) AS max_at FROM invoice_status_overrides GROUP BY document_id) latest
        ON latest.document_id = o.document_id AND latest.max_at = o.overridden_at
    `).all().forEach(o => { overrideByDoc[o.document_id] = o; });

    const results = [];
    for (const [shipmentId, doc] of Object.entries(latestDocByShipment)) {
      const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId);
      if (!shipment) continue;
      const override = overrideByDoc[doc.id] || null;

      let status, daysElapsed = null, alertBusinessDays = null;
      if (doc.status === "voided") {
        status = "cancelled";
      } else if (doc.status !== "confirmed") {
        continue; // draft — nothing to report yet
      } else {
        const amountUsd = docAmountUsd(doc);
        const outstandingUsd = Math.max(0, roundCents(amountUsd - (doc.paid_amount || 0)));
        const refDate = doc.confirmed_at || doc.created_at;
        daysElapsed = businessDaysBetween(refDate, todayIso);
        const thresholds = resolveInvoiceThresholds(shipment.emo_office_id);
        alertBusinessDays = thresholds.alertBusinessDays;
        if (override) status = "overridden";
        else if (outstandingUsd <= 0) status = "paid";
        else if (daysElapsed >= alertBusinessDays) status = "overdue";
        else status = "not_paid";
      }

      results.push({
        shipmentId, docId: doc.id, docType: doc.doc_type, filename: doc.filename,
        principalId: shipment.principal_id || null, principalName: shipment.principal_name || null,
        status, daysElapsed, alertBusinessDays,
        invoiceOwnerId: doc.invoice_owner_id || null,
        invoiceOwnerName: doc.invoice_owner_id ? (userNames[doc.invoice_owner_id] || null) : null,
        relatedDocId: doc.related_doc_id || null,
        override: override ? mapInvoiceStatusOverride(override) : null,
      });
    }
    for (const shipmentId of missingShipmentIds) {
      const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(shipmentId);
      if (!shipment) continue;
      results.push({
        shipmentId, docId: null, docType: null, filename: null,
        principalId: shipment.principal_id || null, principalName: shipment.principal_name || null,
        status: "missing", daysElapsed: null, alertBusinessDays: null,
        invoiceOwnerId: null, invoiceOwnerName: null, relatedDocId: null, override: null,
      });
    }

    const STATUS_RANK = { overdue: 0, missing: 1, not_paid: 2, overridden: 3, paid: 4, cancelled: 5 };
    results.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (b.daysElapsed ?? 0) - (a.daysElapsed ?? 0));
    ok(res, results);
  });

  // Manual trigger for the invoice collections sweep (Epic TKT-G11AHW) — same shape as the
  // existing dunning-sweep trigger below: the real recurring version runs on a daily interval at
  // server boot, this exposes the same core function for testing / an operator who wants alerts
  // sent right now. Admin-only — sends real outbound email on behalf of the organization.
  app.post("/api/billing/run-collections-sweep", auth(), requireRole(["admin"]), async (req, res) => {
    try {
      const sent = await runInvoiceCollectionsSweep();
      ok(res, { sentCount: sent.length, sent });
    } catch (e) { err(res, e.message || "Invoice collections sweep failed", 500); }
  });

  // Manual trigger for the dunning sweep (Story TKT-4TEYT1) — the real recurring version runs
  // on a daily interval at server boot (see server.js), this is the same core function exposed
  // as an admin action for testing and for an operator who wants reminders sent right now rather
  // than waiting for the next automatic pass. Admin-only (not just canViewFinance) since this
  // sends real outbound email on behalf of the organization, a step above viewing a report.
  app.post("/api/billing/send-reminders", auth(), requireRole(["admin"]), async (req, res) => {
    try {
      const sent = await runDunningSweep();
      ok(res, { sentCount: sent.length, sent });
    } catch (e) { err(res, e.message || "Reminder sweep failed", 500); }
  });
};
