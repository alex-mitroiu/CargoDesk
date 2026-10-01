"use strict";

const { ISSUED_BILLING_DOC_SQL } = require("../lib/mappers");

module.exports = function financeRoutes(app, ctx) {
  const { query, ok, err, auth, resolveCustomerGroup, roundCents, costLineEffectiveUsd, getFxRates,
          resolveActiveOffice, entityByShipment } = ctx;

  // Multi-Entity Accounting (TKT-EEV4I9) — mirrors canEditOfficeSide's (server.js) admin/
  // operator/allOffices bypass exactly, applied to READ visibility of the byEntity breakdown
  // instead of write permission: a branch-scoped user should see their own entity's P&L, not the
  // whole company's, unless they're global. Returns null for "unrestricted" or a Set of branch
  // ids the caller may see (possibly empty, if they have no active office set).
  //
  // 2026-09-03 audit: this used to read x-office-id and look up its branch_id directly, with no
  // check that the caller was actually assigned to that office — a real authorization bypass
  // (any branch-scoped user could see a different branch's GP/margin breakdown just by setting
  // this header to an office id they aren't assigned to, discoverable via GET /api/offices).
  // resolveActiveOffice (server.js) now does that validation against user_offices before
  // returning anything.
  const callerEntityScope = async req => {
    const user = req.user;
    const jwtRoles = Array.isArray(user.roles) ? user.roles : (user.role ? [user.role] : ['viewer']);
    if (jwtRoles.includes('admin') || jwtRoles.includes('operator')) return null;
    if (user.allOffices) return null;
    if (!req.headers?.['x-office-id']) return new Set();
    const office = await resolveActiveOffice(req);
    return new Set(office?.branch_id ? [office.branch_id] : []);
  };

  // Converts a USD figure into `currency` using the same FX table toUsd() already uses, just
  // inverted — no new FX infrastructure, this is the one direction that table didn't need yet.
  const fromUsd = async (amountUsd, currency) => {
    if (!currency || currency === "USD") return roundCents(amountUsd);
    const rates = await getFxRates();
    const rate = rates[currency];
    return rate ? roundCents(amountUsd * rate) : roundCents(amountUsd);
  };

  app.get("/api/margin/summary", auth(), async (req, res) => {
    const u = req.user;
    const roles = Array.isArray(u.roles) ? u.roles : [u.role || 'viewer'];
    if (!roles.includes('admin') && !u.canViewFinance)
      return err(res, "Finance access not enabled for your account", 403);
    // entity/entityName/entityCurrency resolve a shipment's owning legal entity (Multi-Entity
    // Accounting, TKT-EEV4I9) as its EMO office's branch, falling back to the IMO office's branch
    // when EMO is unset — no new column on shipments/shipment_cost_lines, a branch already IS
    // CargoDesk's legal-entity boundary (see the branches.currency migration in server.js).
    const lines = await query(`
      SELECT cl.*, s.carrier_code, s.pol, s.pod, s.etd, s.created_at AS shp_created_at,
             s.principal_id, s.principal_name, s.consignee_id, s.consignee_name,
             COALESCE(emo_branch.id, imo_branch.id) AS entity_id,
             COALESCE(emo_branch.name, imo_branch.name) AS entity_name,
             COALESCE(emo_branch.currency, imo_branch.currency) AS entity_currency
      FROM shipment_cost_lines cl
      JOIN shipments s ON s.id = cl.shipment_id
      LEFT JOIN offices  emo_office ON emo_office.id = s.emo_office_id
      LEFT JOIN branches emo_branch ON emo_branch.id = emo_office.branch_id
      LEFT JOIN offices  imo_office ON imo_office.id = s.imo_office_id
      LEFT JOIN branches imo_branch ON imo_branch.id = imo_office.branch_id
    `);

    const todayStr = new Date().toISOString().slice(0, 10);
    const weekBuckets = Array.from({ length: 6 }, (_, i) => {
      const d = new Date(todayStr);
      d.setDate(d.getDate() - (5 - i) * 7);
      const end   = d.toISOString().slice(0, 10);
      const start = new Date(d.setDate(d.getDate() - 6)).toISOString().slice(0, 10);
      const label = new Date(end).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      return { start, end, label };
    });

    const aggregate = (rows) => {
      const buy  = rows.filter(r => r.type === 'BUY').reduce((s, r) => s + costLineEffectiveUsd(r), 0);
      const sell = rows.filter(r => r.type === 'SELL').reduce((s, r) => s + costLineEffectiveUsd(r), 0);
      const gp   = sell - buy;
      const pct  = sell > 0 ? Math.round((gp / sell) * 1000) / 10 : null;
      return { totalBuyUsd: roundCents(buy), totalSellUsd: roundCents(sell), grossProfitUsd: roundCents(gp), grossMarginPct: pct };
    };

    const weeklyBreakdown = (rows) => weekBuckets.map(b => {
      const inBucket = rows.filter(r => {
        const ref = (r.etd || r.shp_created_at || '').slice(0, 10);
        return ref >= b.start && ref <= b.end;
      });
      return { week: b.label, ...aggregate(inBucket) };
    });

    const overall      = aggregate(lines);
    const carrierCodes = [...new Set(lines.map(r => r.carrier_code))];
    const byCarrier    = carrierCodes.map(code => {
      const rows = lines.filter(r => r.carrier_code === code);
      return { carrierCode: code, ...aggregate(rows), weeks: weeklyBreakdown(rows) };
    }).sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

    const lanes  = [...new Set(lines.map(r => `${r.pol} → ${r.pod}`))];
    const byLane = lanes.map(lane => {
      const [pol, pod] = lane.split(' → ');
      const rows = lines.filter(r => r.pol === pol && r.pod === pod);
      return { lane, ...aggregate(rows), weeks: weeklyBreakdown(rows) };
    }).sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

    // Organization Model Enhancement Epic 4 — "the responsible party" precedence
    // (Principal, falling back to Consignee) mirrors invoiceGenerator.js's own responsibleParty
    // field, since that's the same customer relationship a generated invoice is actually billed
    // against. groupByParent=true (query param) remaps each line's customer to its hierarchy's
    // ROOT customer via resolveCustomerGroup before aggregating, so a multinational shipper's
    // shipments booked under several regional customer records show as one consolidated row —
    // without touching how any of those individual records are stored or displayed elsewhere.
    const groupByParent = req.query.groupByParent === 'true';
    const custKey = r => r.principal_id || r.consignee_id || '';
    const custName = r => r.principal_id ? r.principal_name : r.consignee_id ? r.consignee_name : '';
    const custRows = lines.filter(r => custKey(r));
    // resolveCustomerGroup is async (customer_source can be 'remote'), but rootOf is called
    // synchronously inside the .map()s below — pre-warm the cache for every distinct id up front,
    // then read it back synchronously, rather than making rootOf itself async in place.
    const rootCache = new Map();
    if (groupByParent) {
      const distinctIds = [...new Set(custRows.map(r => custKey(r)))];
      await Promise.all(distinctIds.map(async id => { rootCache.set(id, (await resolveCustomerGroup(id))[0]); }));
    }
    const rootOf = id => (!groupByParent || !id) ? id : (rootCache.get(id) ?? id);
    const customerIds = [...new Set(custRows.map(r => rootOf(custKey(r))))];
    const byCustomer = customerIds.map(rootId => {
      const rows = custRows.filter(r => rootOf(custKey(r)) === rootId);
      // Display name: prefer the root customer's own name if it's a member of this group,
      // otherwise fall back to whichever member's name we actually have on a cost line row —
      // a rolled-up group reads by its parent's name, a standalone customer reads by its own.
      const nameRow = rows.find(r => custKey(r) === rootId) || rows[0];
      return { customerId: rootId, customerName: custName(nameRow), ...aggregate(rows), weeks: weeklyBreakdown(rows) };
    }).sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

    // Multi-Entity Accounting (TKT-EEV4I9) — same aggregate()/weeklyBreakdown() reuse as
    // byCarrier/byLane/byCustomer above, just grouped by resolved entity (branch) instead.
    // Scoped to the caller's own branch unless global (callerEntityScope) — deliberately NOT
    // applied to byCarrier/byLane/byCustomer, which stay company-wide exactly as today; entity
    // is the one dimension that maps onto a real legal/branch boundary worth restricting.
    const entityScope = await callerEntityScope(req);
    const entityRows  = lines.filter(r => r.entity_id);
    const entityIds   = [...new Set(entityRows.map(r => r.entity_id))]
      .filter(id => entityScope === null || entityScope.has(id));
    const byEntity = await Promise.all(entityIds.map(async entityId => {
      const rows = entityRows.filter(r => r.entity_id === entityId);
      const nameRow = rows[0];
      const currency = nameRow.entity_currency || 'USD';
      const agg = aggregate(rows);
      const localBuy  = await fromUsd(agg.totalBuyUsd,  currency);
      const localSell = await fromUsd(agg.totalSellUsd, currency);
      return {
        entityId, entityName: nameRow.entity_name || entityId, currency,
        localBuy, localSell, localGp: roundCents(localSell - localBuy),
        ...agg, weeks: weeklyBreakdown(rows),
      };
    }));
    byEntity.sort((a, b) => (b.totalSellUsd || 0) - (a.totalSellUsd || 0));

    ok(res, { ...overall, byCarrier, byLane, byCustomer, byEntity });
  });

  // ─── VAT Liability (2026-09-29) ────────────────────────────────────────────
  // Output VAT (SELL) minus input VAT (BUY) per legal entity (branch) for a date range — the
  // figure a VAT return actually needs, not just the per-invoice VAT line. Same recognition
  // triggers GL Export uses, for the same reasons: output VAT on an ISSUED billing document's
  // confirm date (ISSUED_BILLING_DOC_SQL — a properly reversed invoice still counts in its own
  // period, its CN01 offsets it in the credit note's), input VAT on a BUY line's post date. Same
  // entity resolution and branch scoping as byEntity above (callerEntityScope), deliberately.
  //
  // Zero-rated / reverse-charged / exempt lines are reported as their own base-amount buckets
  // rather than folded into "0% VAT", because a return reports them in different boxes. A
  // reverse-charged PURCHASE is self-assessed at the buying entity's standard VAT rate (output and
  // input VAT at once, net zero — TKT-MQAXQX, see add() below). Confirmed consolidated statements
  // count as issued billing documents (TKT-02776W).
  app.get("/api/vat-liability/summary", auth(), async (req, res) => {
    const u = req.user;
    const roles = Array.isArray(u.roles) ? u.roles : [u.role || 'viewer'];
    if (!roles.includes('admin') && !u.canViewFinance)
      return err(res, "Finance access not enabled for your account", 403);
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) return err(res, "dateFrom and dateTo are required (YYYY-MM-DD)");
    if (dateFrom > dateTo) return err(res, "dateFrom must be on or before dateTo");
    const toBound = `${dateTo}T23:59:59.999Z`;
    const idList = ids => ids.map((_, i) => `$${i + 1}`).join(",");

    // Unqualified on purpose (ISSUED_BILLING_DOC_SQL's own column names would be ambiguous
    // against shipments.status in a join) — entity info is resolved in its own query below.
    const docs = await query(
      `SELECT * FROM shipment_documents WHERE ${ISSUED_BILLING_DOC_SQL} AND confirmed_at >= $1 AND confirmed_at <= $2`,
      [dateFrom, toBound]);
    const sellIds = [...new Set(docs.flatMap(d => (d.source_cost_line_ids ? JSON.parse(d.source_cost_line_ids) : [])))];
    const sellLinesById = new Map(sellIds.length
      ? (await query(`SELECT * FROM shipment_cost_lines WHERE id IN (${idList(sellIds)})`, sellIds)).map(l => [l.id, l])
      : []);
    // Per document, not per distinct line: a line billed on two issued invoices was genuinely
    // charged VAT twice until a credit note says otherwise, so it's owed twice.
    const outputLines = docs.flatMap(d =>
      (d.source_cost_line_ids ? JSON.parse(d.source_cost_line_ids) : []).map(id => sellLinesById.get(id)).filter(Boolean));
    // A confirmed consolidated statement is an issued billing document too (TKT-02776W): its lines
    // are output on the statement's confirmed_at, read from the cost lines it bills — the same
    // source an invoice's VAT comes from, so the two can't be reported differently.
    const statements = await query(
      "SELECT id FROM customer_statements WHERE status='confirmed' AND confirmed_at >= $1 AND confirmed_at <= $2", [dateFrom, toBound]);
    if (statements.length) {
      const ids = statements.map(s => s.id);
      outputLines.push(...await query(
        `SELECT scl.* FROM customer_statement_lines csl JOIN shipment_cost_lines scl ON scl.id = csl.cost_line_id
         WHERE csl.statement_id IN (${idList(ids)})`, ids));
    }

    const inputLines = await query(
      "SELECT * FROM shipment_cost_lines WHERE type='BUY' AND status='posted' AND posted_at >= $1 AND posted_at <= $2",
      [dateFrom, toBound]);

    const shipmentIds = [...new Set([...outputLines, ...inputLines].map(l => l.shipment_id))];
    const entityMap = await entityByShipment(shipmentIds); // lib/legal-entities.js — one rule for every report

    const emptySide = () => ({
      standard: { baseUsd: 0, vatUsd: 0 }, zero_rated: { baseUsd: 0 },
      reverse_charge: { baseUsd: 0 }, exempt: { baseUsd: 0 },
      self_assessed: { baseUsd: 0, vatUsd: 0 }, totalVatUsd: 0,
    });
    const buckets = new Map();
    const add = (line, side) => {
      const ent = entityMap.get(line.shipment_id);
      const key = ent?.entityId || null;
      if (!buckets.has(key)) buckets.set(key, {
        entityId: key, entityName: ent?.entityName || "Unassigned (no branch on either office)",
        currency: ent?.currency || "USD", taxRegistrationNumber: ent?.taxRegistrationNumber || "",
        standardVatRate: ent?.standardVatRate ?? null, selfAssessRateMissing: false,
        output: emptySide(), input: emptySide(),
      });
      const bucket = buckets.get(key);
      const b = bucket[side];
      const base = costLineEffectiveUsd(line);
      const treatment = line.vat_treatment || "standard";
      if (treatment === "standard") {
        const vat = base * (line.vat_rate || 0) / 100;
        b.standard.baseUsd += base; b.standard.vatUsd += vat; b.totalVatUsd += vat;
      } else if (b[treatment]) {
        b[treatment].baseUsd += base;
      }
      // Reverse-charge self-assessment (TKT-MQAXQX): on a reverse-charged PURCHASE the buyer — this
      // entity — accounts for the VAT itself, at its own standard rate, as output AND input VAT at
      // once. Both sides move by the same amount, so net VAT is unchanged. A reverse-charged SALE is
      // the customer's to account for and stays base-only. No rate on the entity: base-only as
      // before, and the entity is flagged so the report can say so.
      if (side === "input" && treatment === "reverse_charge") {
        if (bucket.standardVatRate == null) { bucket.selfAssessRateMissing = true; return; }
        const vat = base * bucket.standardVatRate / 100;
        for (const s of [bucket.output, bucket.input]) {
          s.self_assessed.baseUsd += base; s.self_assessed.vatUsd += vat; s.totalVatUsd += vat;
        }
      }
    };
    for (const l of outputLines) add(l, "output");
    for (const l of inputLines) add(l, "input");

    const round = side => ({
      standard: { baseUsd: roundCents(side.standard.baseUsd), vatUsd: roundCents(side.standard.vatUsd) },
      zero_rated: { baseUsd: roundCents(side.zero_rated.baseUsd) },
      reverse_charge: { baseUsd: roundCents(side.reverse_charge.baseUsd) },
      exempt: { baseUsd: roundCents(side.exempt.baseUsd) },
      self_assessed: { baseUsd: roundCents(side.self_assessed.baseUsd), vatUsd: roundCents(side.self_assessed.vatUsd) },
      totalVatUsd: roundCents(side.totalVatUsd),
    });

    // Unassigned rows (a shipment with no branch behind either office) are only shown to an
    // unrestricted caller — a branch-scoped user can't be told they "own" orphaned VAT.
    const entityScope = await callerEntityScope(req);
    const visible = [...buckets.values()].filter(b =>
      entityScope === null || (b.entityId !== null && entityScope.has(b.entityId)));
    const entities = await Promise.all(visible.map(async b => {
      const netVatUsd = roundCents(b.output.totalVatUsd - b.input.totalVatUsd);
      return { ...b, output: round(b.output), input: round(b.input), netVatUsd, localNetVat: await fromUsd(netVatUsd, b.currency) };
    }));
    entities.sort((a, b) => Math.abs(b.netVatUsd) - Math.abs(a.netVatUsd));

    ok(res, {
      dateFrom, dateTo, entities,
      totals: {
        outputVatUsd: roundCents(entities.reduce((s, e) => s + e.output.totalVatUsd, 0)),
        inputVatUsd:  roundCents(entities.reduce((s, e) => s + e.input.totalVatUsd, 0)),
        netVatUsd:    roundCents(entities.reduce((s, e) => s + e.netVatUsd, 0)),
      },
    });
  });
};
