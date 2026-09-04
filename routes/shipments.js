"use strict";
const ExcelJS = require("exceljs");

module.exports = function shipmentsRoutes(app, ctx) {
  const { query, transaction, ok, err, uid, auth, requireRole, isUniqueViolation,
          mapShipment, mapShipmentLeg, mapContainer, mapContainerEvent, mapContainerPackage, mapAllocation,
          mapShipmentParty, ADDITIONAL_PARTY_ROLES, mapSideOffice, canEditOfficeSide,
          applyShipmentAccessFilter, syncShipmentFromLegs, importContractRates,
          broadcastMessage, broadcastEditLockChange, recomputeSpaceBadge, screenShipmentById, resolveCarrierAgent, resolveCarrierAgentCandidates,
          checkLineAgentCapabilityGaps,
          logEvent, logEntityEvent, TRACKED_FIELDS, TRACKED_CTR_FIELDS, FREE_TIME_WARNING_DAYS,
          sanctionsMap, autoCompleteMilestone, ensureBookingCreated, toUsd,
          validCoord, GPS_LOC_TYPE, getSettings, callContractService, callMdmService, getCustomerRow,
          COST_LINE_EFFECTIVE_USD_SQL } = ctx;

  // trade_manager and viewer are read-only on all shipment write operations
  const shipmentWrite = requireRole(["admin", "operator", "occ_bk"]);

  // Mirrors src/tokens.js's CONTRACT_PRESETS — frontend/backend don't share a module, same split
  // as ADDITIONAL_PARTY_ROLES/BOOKABLE_CARRIERS elsewhere in this app. Previously nothing
  // validated contractType server-side at all (only "non-empty string" was checked), so any
  // value could be stored — silently breaking every downstream check keyed on these 4 literal
  // strings (contract-mismatch detection, the Central-only rate-import path, the Dashboard's
  // Contract Consumption filter, the Pending-revalidation flow).
  const CONTRACT_TYPES = ["Pending", "SPOT", "Customer Own", "Central"];

  // Mirrors src/tokens.js's STATUSES — same split as CONTRACT_TYPES above (frontend/backend
  // don't share a module). Previously nothing validated shipments.status server-side at all, so
  // any string could be stored, silently breaking every downstream consumer keyed on these 5
  // literal values (dashboard status filters, the _overdue pseudo-filter's "not Completed/
  // Cancelled" check, the STATUS_CHANGED audit-log branch below, status_log inserts).
  const SHIPMENT_STATUSES = ["Active", "Pending", "Completed", "Cancelled", "Requires Review"];

  // Mirrors src/tokens.js's BL_RELEASE_TYPES — same split as CONTRACT_TYPES/SHIPMENT_STATUSES
  // above (frontend/backend don't share a module). '' (unset) is always allowed alongside these.
  const BL_RELEASE_TYPES = ["Original", "Telex Release", "Surrendered", "Seaway Bill"];

  const LEG_TO_MOT = { 'SEA': 'SEA', 'AIR': 'AIR', 'RAIL': 'RAIL', 'Pick-up': 'ROAD', 'Delivery': 'ROAD', 'Feeder': 'SEA' };

  // Classified-location GPS Coordinates loc-type — a SEA leg always needs a real port, so it's
  // never eligible; a Pick-up/Delivery leg in GPS mode blanks its UN/LOCODE and carries lat/lng
  // instead. Resolved server-side (not just trusted from the frontend) so switching back out of
  // GPS mode always clears any stale coordinates at the single source of truth. Gated on legType,
  // not mot — the Leg Type selector (ShipmentFormPage.jsx) only updates legType/movementType on
  // change, never mot, so a leg just switched from SEA to Pick-up/Delivery still carries its old
  // mot='SEA' in the very same save — found live via CDP verification of this exact flow.
  const resolveLegPoint = (legType, locType, code, lat, lng) => {
    if (locType !== GPS_LOC_TYPE) return { code: (code || '').toUpperCase(), lat: null, lng: null };
    if (legType === 'SEA') return { error: "A SEA leg cannot use GPS Coordinates — it must have a real port" };
    return {
      code: '',
      lat: lat === '' || lat == null ? null : Number(lat),
      lng: lng === '' || lng == null ? null : Number(lng),
    };
  };

  // Organization Model Enhancement Epic 3 — re-screens a shipment whenever an additional party
  // (shipment_parties) is added/reassigned/removed, since screenShipmentById now covers all 9
  // of those roles too, not just the 4 fixed columns. Honors the same "don't silently overwrite
  // a compliance officer's override" guard the shipment PUT route's own re-screen already uses.
  const maybeRescreen = async shipmentId => {
    if (sanctionsMap.size === 0) return;
    const [prev] = await query("SELECT result, overridden_at FROM shipment_screenings WHERE shipment_id=$1", [shipmentId]);
    const isOverridden = prev?.result === 'CLEAR' && prev?.overridden_at;
    if (!isOverridden) await screenShipmentById(shipmentId);
  };

  // Carrier Line Agents — resolves the carrier's registered agent at POL/POD (carrier_agents,
  // via resolveCarrierAgentCandidates) and, for each side with EXACTLY ONE candidate, adds it as
  // an ordinary "Line Agent (Export/Import)" additional party. The UNIQUE(shipment_id, role)
  // constraint on shipment_parties IS the "only fill an empty slot, never overwrite" mechanism —
  // same idiom POST /api/shipments/:id/parties below already relies on — so this never clobbers a
  // party that's already there, whether CargoDesk set it earlier or a person did. No transaction:
  // the two sides are independent single-row writes on two different role strings, so one
  // resolving and the other not is a normal, non-corrupting result. A side with 2+ candidates
  // (only possible via the linked-ports fallback — see resolveCarrierAgentCandidates) is
  // deliberately left unassigned rather than guessing which one — GET .../line-agent-candidates
  // below surfaces it for the operator to pick instead.
  const maybeAssignLineAgents = async (shipmentId, carrierCode, pol, pod, actorId = null) => {
    for (const [port, role] of [[pol, "Line Agent (Export)"], [pod, "Line Agent (Import)"]]) {
      const candidates = await resolveCarrierAgentCandidates(carrierCode, port);
      if (candidates.length !== 1) continue;
      const match = candidates[0];
      try {
        await query(`INSERT INTO shipment_parties (id, shipment_id, role, customer_id, customer_name, created_at)
          VALUES ($1,$2,$3,$4,$5,$6)`,
          [`PTY-${uid()}`, shipmentId, role, match.agent_customer_id, match.agent_customer_name, new Date().toISOString()]);
        // Silent until now — a resolved Line Agent slot filled itself in with no trace in the
        // shipment's own History tab, distinct from LOGGED PARTY_ASSIGNED (which only ever fired
        // for the manual assign route). Own event type so the History tab reads "auto-resolved",
        // not "someone assigned this" for a change nobody actually clicked.
        await logEvent(shipmentId, 'LINE_AGENT_AUTO_ASSIGNED', role, null, match.agent_customer_name,
          JSON.stringify({ carrierCode, port, matchedVia: match.matched_via || null }), actorId);
      } catch (e) { if (!isUniqueViolation(e)) throw e; }
    }
  };

  const checkDgPolicy = async (shipmentId, isDg, dgClass) => {
    if (!isDg || !dgClass) return null;
    const [shipment] = await query("SELECT contract_id, contract_ref FROM shipments WHERE id=$1", [shipmentId]);
    if (!shipment?.contract_id) return null;
    let contract;
    if (((await getSettings()).contract_source || "local") === "remote") {
      try {
        const c = await callContractService("GET", `/internal/contracts/${shipment.contract_id}`);
        contract = { dg_allowed: !!c.dgAllowed, imdg_classes: JSON.stringify(c.imdgClasses || []), contract_number: c.contractNumber };
      } catch { return null; } // an unreachable/vanished remote contract can't be checked either way — same "don't disprove it" default used elsewhere
    } else {
      const [row] = await query("SELECT dg_allowed, contract_number FROM contracts WHERE id=$1", [shipment.contract_id]);
      if (!row) return null;
      // imdg_classes lives in the contract_imdg_classes junction table now (TKT-5YYLNT) —
      // the contracts.imdg_classes column is frozen/no longer written to.
      const classes = (await query("SELECT imdg_class FROM contract_imdg_classes WHERE contract_id=$1", [shipment.contract_id])).map(r => r.imdg_class);
      contract = { dg_allowed: row.dg_allowed, imdg_classes: JSON.stringify(classes), contract_number: row.contract_number };
    }
    if (!contract) return null;
    if (!contract.dg_allowed)
      return `Contract ${contract.contract_number} does not permit DG cargo`;
    const allowed = JSON.parse(contract.imdg_classes || "[]");
    if (allowed.length > 0 && !allowed.includes(dgClass))
      return `IMO class ${dgClass} is not permitted under contract ${contract.contract_number} (allowed: ${allowed.join(", ")})`;
    return null;
  };

  // Demurrage and Detention are two commercially distinct charge types, each with its own
  // free-time allowance and carrier tariff — Demurrage is terminal DWELL TIME on a loaded
  // container (Gate In -> Sailed at origin, Discharged -> Gate Out at destination); Detention
  // is how long the carrier's EQUIPMENT is held outside the terminal (Empty Pickup -> Gate In
  // at origin — the shipper holding an empty box before stuffing/returning it; Gate Out ->
  // Empty Return at destination — the consignee holding a delivered box before returning it
  // empty). The original v0.30.0 model only ever computed the demurrage pair under a generic
  // "free time" name (self-flagged as an assumption needing review) — this now computes both,
  // independently, from the same container_events log.
  const freeTimeWindow = (freeDays, startAt, closeAt, warnDays) => {
    if (freeDays == null) return { state: 'no-window', expiresAt: null, daysRemaining: null };
    const startParsed = startAt ? new Date(startAt) : null;
    if (!startParsed || isNaN(startParsed)) return { state: 'not-started', expiresAt: null, daysRemaining: null };
    const expiresAt = new Date(startParsed.getTime() + freeDays * 86400000);
    const closeParsed = closeAt ? new Date(closeAt) : null;
    if (closeParsed && !isNaN(closeParsed)) {
      const daysRemaining = Math.round((expiresAt - closeParsed) / 86400000);
      return { state: daysRemaining >= 0 ? 'closed-ok' : 'closed-late', expiresAt: expiresAt.toISOString().slice(0, 10), daysRemaining };
    }
    const today = new Date(new Date().toISOString().slice(0, 10));
    const daysRemaining = Math.round((expiresAt - today) / 86400000);
    const state = daysRemaining < 0 ? 'red' : daysRemaining <= warnDays ? 'amber' : 'ok';
    return { state, expiresAt: expiresAt.toISOString().slice(0, 10), daysRemaining };
  };

  // eventsByType: { [eventType]: occurredAt } for ONE container's events (latest
  // occurrence per type, since a type could in principle be logged more than once).
  const deriveFreeTime = (ctr, eventsByType, latest) => ({
    ...(() => { const w = freeTimeWindow(ctr.origin_free_time_days, eventsByType['Gate In'], eventsByType['Sailed'], FREE_TIME_WARNING_DAYS);
      return { originDemurrageState: w.state, originDemurrageExpiresAt: w.expiresAt, originDemurrageDaysRemaining: w.daysRemaining }; })(),
    ...(() => { const w = freeTimeWindow(ctr.dest_free_time_days, eventsByType['Discharged'], eventsByType['Gate Out'], FREE_TIME_WARNING_DAYS);
      return { destDemurrageState: w.state, destDemurrageExpiresAt: w.expiresAt, destDemurrageDaysRemaining: w.daysRemaining }; })(),
    ...(() => { const w = freeTimeWindow(ctr.origin_detention_free_days, eventsByType['Empty Pickup'], eventsByType['Gate In'], FREE_TIME_WARNING_DAYS);
      return { originDetentionState: w.state, originDetentionExpiresAt: w.expiresAt, originDetentionDaysRemaining: w.daysRemaining }; })(),
    ...(() => { const w = freeTimeWindow(ctr.dest_detention_free_days, eventsByType['Gate Out'], eventsByType['Empty Return'], FREE_TIME_WARNING_DAYS);
      return { destDetentionState: w.state, destDetentionExpiresAt: w.expiresAt, destDetentionDaysRemaining: w.daysRemaining }; })(),
    latestEventType: latest?.type || '', latestEventLocation: latest?.location || '', latestEventAt: latest?.at || '',
  });

  // Groups a flat container_events result set (batched across many containers)
  // into per-container { byType, latest } — one query total instead of N+1.
  const groupContainerEvents = rows => {
    const byContainer = {};
    for (const r of rows) {
      const g = (byContainer[r.container_id] ??= { byType: {}, latest: null });
      g.byType[r.event_type] = r.occurred_at;
      if (!g.latest || r.occurred_at >= g.latest.at) g.latest = { type: r.event_type, location: r.location || '', at: r.occurred_at };
    }
    return byContainer;
  };

  // ─── Shipments ─────────────────────────────────────────────────────────────

  // shipment.pol/pod are the journey's overall DOOR-TO-DOOR bookends — for a shipment
  // with a Door pickup and/or a trucked final Delivery leg, that's not the same as the
  // real SEA leg's pol/pod (e.g. a Delivery leg to an inland city like Chicago shows up
  // as shipment.pod, even though the actual sea Port of Discharge is New York). Several
  // single-shipment views (RouteSummaryBar, ShipmentHeaderBar, the sailing search on
  // ShipmentSchedulesPage) already resolve this themselves by self-fetching legs — this
  // does the same resolution in bulk for the shipments LIST, one batched query across
  // all shipments instead of N+1 (same pattern as the container-events join above).
  const resolveSeaPorts = async shipmentIds => {
    if (!shipmentIds.length) return {};
    const ph = shipmentIds.map((_, i) => `$${i + 1}`).join(',');
    const legs = await query(`
      SELECT shipment_id, pol, pod FROM shipment_legs
      WHERE leg_type='SEA' AND shipment_id IN (${ph})
      ORDER BY leg_order ASC
    `, shipmentIds);
    const bySeaShipment = {};
    for (const l of legs) {
      const g = (bySeaShipment[l.shipment_id] ??= { seaPol: l.pol, seaPod: l.pod });
      g.seaPod = l.pod; // last SEA leg in leg_order wins
    }
    const codes = [...new Set(Object.values(bySeaShipment).flatMap(g => [g.seaPol, g.seaPod]).filter(Boolean))];
    const names = {};
    // mdm_source branch added 2026-09-03 (audit-found bypass — this used to always read the
    // local port_locations table regardless of the toggle, on the highest-traffic read in this
    // class: the main shipments list). The MDM service's own /internal/port-locations gained an
    // ids= bulk filter this pass specifically to back this call without an N+1 per port code.
    if (codes.length) {
      if (((await getSettings()).mdm_source || "local") === "remote") {
        try {
          const rows = await callMdmService("GET", `/internal/port-locations?ids=${codes.map(encodeURIComponent).join(',')}`);
          (rows || []).forEach(r => { names[r.unlocode] = r.name; });
        } catch { /* leave names empty — same clean-degrade every other remote MDM lookup in this codebase uses on failure */ }
      } else {
        const cph = codes.map((_, i) => `$${i + 1}`).join(',');
        (await query(`SELECT unlocode, name FROM port_locations WHERE unlocode IN (${cph})`, codes))
          .forEach(r => { names[r.unlocode] = r.name; });
      }
    }
    for (const g of Object.values(bySeaShipment)) {
      g.seaPolName = names[g.seaPol] || '';
      g.seaPodName = names[g.seaPod] || '';
    }
    return bySeaShipment;
  };

  app.get("/api/shipments", async (req, res) => {
    const rows = await query(`
      SELECT s.*,
             p1.name AS pol_name,
             p2.name AS pod_name,
             emo.code AS emo_office_code, emo.name AS emo_office_name,
             imo.code AS imo_office_code, imo.name AS imo_office_name,
             ctrl.code AS controlling_office_code, ctrl.name AS controlling_office_name,
             COALESCE(buy.total, 0)  AS margin_buy_usd,
             COALESCE(sell.total, 0) AS margin_sell_usd,
             COALESCE(ms.overdue_count, 0) AS overdue_count,
             cb.status AS booking_status,
             cb.requested_at AS booking_requested_at,
             COALESCE(ctr_teu.teu, 0) AS teu
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      LEFT JOIN offices emo  ON emo.id  = s.emo_office_id
      LEFT JOIN offices imo  ON imo.id  = s.imo_office_id
      LEFT JOIN offices ctrl ON ctrl.id = s.controlling_office_id
      LEFT JOIN (SELECT shipment_id, SUM(${COST_LINE_EFFECTIVE_USD_SQL}) AS total
                 FROM shipment_cost_lines WHERE type='BUY' GROUP BY shipment_id) buy
             ON buy.shipment_id = s.id
      LEFT JOIN (SELECT shipment_id, SUM(${COST_LINE_EFFECTIVE_USD_SQL}) AS total
                 FROM shipment_cost_lines WHERE type='SELL' GROUP BY shipment_id) sell
             ON sell.shipment_id = s.id
      LEFT JOIN (SELECT shipment_id, COUNT(*) AS overdue_count
                 FROM shipment_milestones
                 WHERE estimated_date != '' AND estimated_date < CURRENT_DATE::text AND completed_at = ''
                 GROUP BY shipment_id) ms
             ON ms.shipment_id = s.id
      LEFT JOIN carrier_bookings cb ON cb.shipment_id = s.id
      LEFT JOIN (SELECT shipment_id, COALESCE(SUM(CASE WHEN size='40' THEN 2 ELSE 1 END),0) AS teu
                 FROM containers GROUP BY shipment_id) ctr_teu
             ON ctr_teu.shipment_id = s.id
      ORDER BY s.created_at DESC
    `);
    const seaPorts = await resolveSeaPorts(rows.map(r => r.id));
    const mapped = rows.map(r => ({ ...mapShipment(r), ...(seaPorts[r.id] || { seaPol: r.pol, seaPod: r.pod, seaPolName: r.pol_name || '', seaPodName: r.pod_name || '' }) }));
    let filtered = await applyShipmentAccessFilter(mapped, req.user, req);
    // Pagination is opt-in (TKT-UAJGR3) — every existing caller (App.jsx's own load-everything-
    // once-into-state model, Command Center, Dashboard, AI Assistant tools) omits limit/offset and
    // keeps getting today's exact bare-array response, so nothing breaks. Only a caller that
    // explicitly asks for a page gets the {results,total,limit,offset} shape back. Sliced after
    // the access filter (not a SQL LIMIT) since that filter is JS/header-driven and can't safely
    // run after truncation without risking a wrong or short page.
    if (req.query.limit === undefined && req.query.offset === undefined) {
      return ok(res, filtered);
    }
    // status/carrier/search/sort are new — opt-in the same way limit/offset already are, applied
    // only when the caller passes them (ShipmentsPage.jsx's real server-side pagination, TKT-none
    // yet-ticketed pagination-standardization pass). Verbatim port of what was, until this pass,
    // purely client-side filter/sort logic in ShipmentsPage.jsx, so behavior is unchanged from the
    // caller's point of view — just computed here instead of over a fully-downloaded array.
    const today = new Date().toISOString().slice(0, 10);
    if (req.query.status === "_overdue") {
      filtered = filtered.filter(s => s.etd && s.etd < today && s.status !== "Completed" && s.status !== "Cancelled");
    } else if (req.query.status) {
      filtered = filtered.filter(s => s.status === req.query.status);
    }
    if (req.query.carrier) filtered = filtered.filter(s => s.carrierCode === req.query.carrier);
    if (req.query.search) {
      const q = req.query.search.toLowerCase();
      filtered = filtered.filter(s =>
        s.id.toLowerCase().includes(q) || s.pol.toLowerCase().includes(q) || s.pod.toLowerCase().includes(q)
        || (s.seaPol || '').toLowerCase().includes(q) || (s.seaPod || '').toLowerCase().includes(q)
        || (s.bookingRef || '').toLowerCase().includes(q) || (s.blNumber || '').toLowerCase().includes(q));
    }
    const SORTERS = {
      etd_asc:  (a, b) => (a.etd || "9").localeCompare(b.etd || "9"),
      etd_desc: (a, b) => (b.etd || "0").localeCompare(a.etd || "0"),
      eta_asc:  (a, b) => (a.eta || "9").localeCompare(b.eta || "9"),
      teu_desc: (a, b) => b.teu - a.teu,
      status:   (a, b) => (a.status || "").localeCompare(b.status || ""),
    };
    if (SORTERS[req.query.sort]) filtered = [...filtered].sort(SORTERS[req.query.sort]);

    const lim = Math.min(parseInt(req.query.limit) || 50, 500), off = parseInt(req.query.offset) || 0;
    ok(res, { results: filtered.slice(off, off + lim), total: filtered.length, limit: lim, offset: off });
  });

  app.get("/api/shipments/compliance-hits", async (req, res) => {
    const rows = await query(`
      SELECT s.*, p1.name AS pol_name, p2.name AS pod_name,
             ss.result AS scr_result, ss.hits AS scr_hits, ss.screened_at, ss.overridden_at
      FROM shipments s
      JOIN shipment_screenings ss ON ss.shipment_id = s.id
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      WHERE ss.result = 'HIT'
      ORDER BY ss.screened_at DESC
    `);
    ok(res, rows.map(r => ({
      ...mapShipment(r),
      screening: {
        result: r.scr_result,
        hits: JSON.parse(r.scr_hits || '[]'),
        screenedAt: r.screened_at,
        overriddenAt: r.overridden_at || null,
      },
    })));
  });

  app.get("/api/shipments/:id", async (req, res) => {
    const [row] = await query(`
      SELECT s.*, p1.name AS pol_name, p2.name AS pod_name,
             emo.code AS emo_office_code, emo.name AS emo_office_name,
             imo.code AS imo_office_code, imo.name AS imo_office_name,
             ctrl.code AS controlling_office_code, ctrl.name AS controlling_office_name
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      LEFT JOIN offices emo  ON emo.id  = s.emo_office_id
      LEFT JOIN offices imo  ON imo.id  = s.imo_office_id
      LEFT JOIN offices ctrl ON ctrl.id = s.controlling_office_id
      WHERE s.id = $1
    `, [req.params.id]);
    if (!row) return err(res, "Not found", 404);
    const s = mapShipment(row);
    if (!(await applyShipmentAccessFilter([s], req.user, req)).length) return err(res, "Not found", 404);
    ok(res, s);
  });

  // Global-pagination shape ({results, total, limit, offset}) — same contract as every other
  // paginated list endpoint (GET /api/contracts, /api/port-locations, etc). types/search/dateRange
  // filter server-side so `total` always reflects what's actually being paged through, not just
  // the unfiltered row count.
  app.get("/api/shipments/:id/events", async (req, res) => {
    const { limit = "50", offset = "0", types = "", search = "", dateRange = "", sort = "desc" } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
    const clauses = [];
    const params = [];
    const p = v => { params.push(v); return `$${params.length}`; };
    clauses.push(`shipment_id=${p(req.params.id)}`);
    if (types.trim()) {
      const typeList = types.split(",").map(t => t.trim()).filter(Boolean);
      if (typeList.length) clauses.push(`event_type IN (${typeList.map(t => p(t)).join(",")})`);
    }
    if (dateRange === "today") {
      clauses.push(`occurred_at >= ${p(new Date().toISOString().slice(0, 10))}`);
    } else if (dateRange === "7d") {
      clauses.push(`occurred_at >= ${p(new Date(Date.now() - 7 * 86400000).toISOString())}`);
    }
    if (search.trim()) {
      const s = `%${search.trim()}%`;
      clauses.push(`(field ILIKE ${p(s)} OR old_value ILIKE ${p(s)} OR new_value ILIKE ${p(s)} OR meta ILIKE ${p(s)} OR event_type ILIKE ${p(s)})`);
    }
    const where = "WHERE " + clauses.join(" AND ");
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM shipment_events ${where}`, params);
    const dir = sort === "asc" ? "ASC" : "DESC";
    const rows = await query(`SELECT * FROM shipment_events ${where} ORDER BY occurred_at ${dir} LIMIT ${p(lim)} OFFSET ${p(off)}`, params);
    ok(res, {
      results: rows.map(r => ({
        id: r.id, shipmentId: r.shipment_id,
        eventType: r.event_type, field: r.field,
        oldValue: r.old_value, newValue: r.new_value,
        actor: r.actor, occurredAt: r.occurred_at,
        meta: r.meta ? JSON.parse(r.meta) : {},
      })),
      total: Number(total), limit: lim, offset: off,
    });
  });

  app.get("/api/shipments/:id/status-log", async (req, res) => {
    const rows = await query(
      "SELECT * FROM status_log WHERE shipment_id=$1 ORDER BY changed_at ASC", [req.params.id]
    );
    ok(res, rows.map(r => ({
      id: r.id, shipmentId: r.shipment_id,
      fromStatus: r.from_status, toStatus: r.to_status,
      changedAt: r.changed_at, changedBy: r.changed_by,
    })));
  });

  app.post("/api/shipments", shipmentWrite, async (req, res) => {
    const { pol, pod, carrierCode, contractType, contractNotes = "", status = "Active",
            etd = "", eta = "", bookingRef = "", blNumber = "", blReleaseType = "", masterBlNumber = "", masterBlReleaseType = "", coloadTariffReference = "", vessel = "", voyage = "",
            incoterm = "", vesselImo = "", contractId = "", contractRef = "", commodityCode = "",
            shipperId = "", shipperName = "", consigneeId = "", consigneeName = "",
            principalId = "", principalName = "",
            allocationId = "", spaceSkipReason = "", spaceOverageReason = "",
            freightTerms = "Prepaid", movementType = "FCL", serviceType = "Port-to-Port",
            placeOfReceipt = "", placeOfDelivery = "", cargoReadyDate = null,
            notifyId = "", notifyName = "",
            declaredValue = null, declaredValueCurrency = "USD",
            emoOfficeId = null, imoOfficeId = null, controllingOfficeId = null,
            contractRoutingId = "" } = req.body;
    if (!pol || !pod || !carrierCode || !contractType) return err(res, "pol, pod, carrierCode, contractType required");
    if (!CONTRACT_TYPES.includes(contractType)) return err(res, `contractType must be one of: ${CONTRACT_TYPES.join(", ")}`);
    if (!SHIPMENT_STATUSES.includes(status)) return err(res, `status must be one of: ${SHIPMENT_STATUSES.join(", ")}`);
    if (blReleaseType && !BL_RELEASE_TYPES.includes(blReleaseType)) return err(res, `blReleaseType must be one of: ${BL_RELEASE_TYPES.join(", ")}`);
    if (masterBlReleaseType && !BL_RELEASE_TYPES.includes(masterBlReleaseType)) return err(res, `masterBlReleaseType must be one of: ${BL_RELEASE_TYPES.join(", ")}`);
    const id = `SHP-${uid()}`;
    const polU = pol.toUpperCase(), podU = pod.toUpperCase();
    const createdAt = new Date().toISOString();
    await query(`INSERT INTO shipments (id,pol,pod,carrier_code,contract_type,contract_notes,status,created_at,etd,eta,booking_ref,bl_number,bl_release_type,master_bl_number,master_bl_release_type,coload_tariff_reference,vessel,voyage,incoterm,vessel_imo,contract_id,contract_ref,commodity_code,shipper_id,shipper_name,consignee_id,consignee_name,principal_id,principal_name,allocation_id,space_skip_reason,space_overage_reason,freight_terms,movement_type,service_type,place_of_receipt,place_of_delivery,cargo_ready_date,notify_id,notify_name,declared_value,declared_value_currency,emo_office_id,imo_office_id,controlling_office_id,contract_routing_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46)`,
      [id, polU, podU, carrierCode, contractType, contractNotes, status, createdAt, etd, eta, bookingRef, blNumber, blReleaseType, masterBlNumber, masterBlReleaseType, coloadTariffReference, vessel, voyage, incoterm, vesselImo, contractId, contractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, allocationId, spaceSkipReason, spaceOverageReason, freightTerms, movementType, serviceType, placeOfReceipt, placeOfDelivery, cargoReadyDate || null, notifyId, notifyName, (declaredValue !== null && declaredValue !== undefined && String(declaredValue).trim() !== '') ? Number(declaredValue) : null, declaredValueCurrency || "USD", emoOfficeId || null, imoOfficeId || null, controllingOfficeId || null, contractRoutingId || ""]);
    await logEvent(id, 'SHIPMENT_CREATED', null, null, null,
      JSON.stringify({ pol: polU, pod: podU, carrier: carrierCode, status, etd, contractType }), req.user?.id);
    await maybeAssignLineAgents(id, carrierCode, polU, podU, req.user?.id);
    if (contractType === 'Central' && contractId) await importContractRates(id);
    const silentScreening = sanctionsMap.size > 0 ? await screenShipmentById(id) : null;

    // Earlier credit-check trigger point (TKT-Q00WHF, Credit Control Depth) — soft and
    // informational only, same non-blocking shape screening already uses above: whichever
    // parties are already known at creation get checked for credit_hold, surfaced as a
    // creditWarning the frontend can toast (mirrors the existing screening.result==='HIT'
    // toast in App.jsx) without ever stopping shipment creation itself. Deliberately does NOT
    // also check the credit_limit here — a limit check needs the full outstandingAr/
    // committedExposure computation (routes/customers.js), and this is meant to stay a cheap,
    // creation-time glance, not a duplicate of the real gate; the real limit check still lives
    // at invoice-generation time, and the real hold *block* now also lives at carrier-booking
    // send time (routes/edi.js).
    const heldParties = [];
    for (const [pid, role] of [[shipperId, 'Shipper'], [consigneeId, 'Consignee'], [principalId, 'Principal']]) {
      if (!pid) continue;
      const cust = await getCustomerRow(pid);
      if (cust?.creditHold) heldParties.push({ customerId: pid, companyName: cust.companyName, role, reason: cust.creditHoldReason || '' });
    }

    const [baseRow] = await query("SELECT * FROM shipments WHERE id=$1", [id]);
    const base = mapShipment(baseRow);
    const extra = {};
    if (silentScreening) extra.screening = silentScreening;
    if (heldParties.length) extra.creditWarning = { onHold: heldParties };
    ok(res, { ...base, ...extra }, 201);
  });

  app.put("/api/shipments/:id", shipmentWrite, async (req, res) => {
    const { pol: polIn, pod: podIn, carrierCode: carrierCodeIn, contractType: contractTypeIn,
            contractNotes = "", status: statusIn,
            etd = "", eta = "", bookingRef = "", blNumber = "", blReleaseType = "", masterBlNumber = "", masterBlReleaseType = "", coloadTariffReference = "", vessel = "", voyage = "",
            incoterm = "", vesselImo = "", contractId = "", contractRef = "", commodityCode = "",
            shipperId = "", shipperName = "", consigneeId = "", consigneeName = "",
            principalId = "", principalName = "",
            allocationId = "", spaceSkipReason = "", spaceOverageReason = "",
            freightTerms = "Prepaid", movementType = "FCL", serviceType = "Port-to-Port",
            placeOfReceipt = "", placeOfDelivery = "", cargoReadyDate = null,
            notifyId = "", notifyName = "",
            declaredValue = null, declaredValueCurrency = "USD",
            emoOfficeId = null, imoOfficeId = null, controllingOfficeId = null,
            contractValidFrom = "", contractValidTo = "", contractRoutingId = "" } = req.body;
    const [existing] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    // pol/pod/carrierCode/contractType/status have no destructuring default (unlike every sibling
    // field above) because their fallback needs the existing row — omitting one from a partial
    // update must preserve its current value, not silently bind `undefined` into the UPDATE below
    // (which node:sqlite rejects with a raw TypeError, previously crashing the whole process
    // instead of just failing the one request — see the crash-safety-net comments in server.js).
    const status = statusIn !== undefined ? statusIn : existing.status;
    const pol = polIn !== undefined ? polIn : existing.pol;
    const pod = podIn !== undefined ? podIn : existing.pod;
    const carrierCode = carrierCodeIn !== undefined ? carrierCodeIn : existing.carrier_code;
    const contractType = contractTypeIn !== undefined ? contractTypeIn : existing.contract_type;
    if (!pol || !pod) return err(res, "pol and pod are required");
    const polU = pol.toUpperCase(), podU = pod.toUpperCase();
    if (contractType && !CONTRACT_TYPES.includes(contractType)) return err(res, `contractType must be one of: ${CONTRACT_TYPES.join(", ")}`);
    if (status && !SHIPMENT_STATUSES.includes(status)) return err(res, `status must be one of: ${SHIPMENT_STATUSES.join(", ")}`);
    if (blReleaseType && !BL_RELEASE_TYPES.includes(blReleaseType)) return err(res, `blReleaseType must be one of: ${BL_RELEASE_TYPES.join(", ")}`);
    if (masterBlReleaseType && !BL_RELEASE_TYPES.includes(masterBlReleaseType)) return err(res, `masterBlReleaseType must be one of: ${BL_RELEASE_TYPES.join(", ")}`);

    // CRD-vs-ETD guard: cargo can't be ready after the vessel has already sailed, so a Cargo
    // Ready Date edit that now falls after ETD invalidates whatever schedule/contract was
    // already booked against the old CRD. Only acts when there's actually something booked —
    // a plain CRD/ETD mismatch on a shipment with no contract/schedule yet isn't this rule's
    // concern. contractType is deliberately left as-is (see CLAUDE.md-adjacent plan notes) —
    // this lands on the same "contract type set, no ref yet" empty state already handled by
    // ShipmentSchedulesPage.jsx for a fresh shipment.
    let effContractId = contractId, effContractRef = contractRef, effAllocationId = allocationId;
    let effContractRoutingId = contractRoutingId;
    let effStatus = status;
    let scheduleDropped = false;
    const existingSchedules = await query("SELECT * FROM shipment_schedules WHERE shipment_id=$1", [req.params.id]);
    if (cargoReadyDate && etd && cargoReadyDate > etd && (contractId || existingSchedules.length > 0)) {
      effContractId = ""; effContractRef = ""; effAllocationId = ""; effContractRoutingId = "";
      effStatus = "Requires Review";
      scheduleDropped = true;
      const actor = req.user?.name || req.user?.email || "";
      for (const s of existingSchedules) {
        await query("DELETE FROM shipment_schedules WHERE id=$1", [s.id]);
        await logEntityEvent('schedule', s.id, 'REMOVED', null, null, null,
          JSON.stringify({ shipmentId: req.params.id, carrier: s.carrier, vesselName: s.vessel_name, vesselImo: s.vessel_imo,
            voyageNumber: s.voyage_number, service: s.service, pol: s.pol, pod: s.pod, etd: s.etd, eta: s.eta,
            transitDays: s.transit_days, actor, reason: 'CRD updated past ETD' }));
        await logEvent(req.params.id, 'SCHEDULE_REMOVED', null, `${s.carrier} ${s.vessel_name} ${s.voyage_number}`.trim(), null,
          JSON.stringify({ reason: 'Cargo Ready Date updated past ETD' }), req.user?.id);
      }
    }

    const updatedRows = await query(`
      UPDATE shipments SET pol=$1, pod=$2, carrier_code=$3, contract_type=$4, contract_notes=$5, status=$6,
      etd=$7, eta=$8, booking_ref=$9, bl_number=$10, bl_release_type=$11, master_bl_number=$12, master_bl_release_type=$13, coload_tariff_reference=$14, vessel=$15, voyage=$16, incoterm=$17, vessel_imo=$18, contract_id=$19, contract_ref=$20, commodity_code=$21,
      shipper_id=$22, shipper_name=$23, consignee_id=$24, consignee_name=$25, principal_id=$26, principal_name=$27,
      allocation_id=$28, space_skip_reason=$29, space_overage_reason=$30,
      freight_terms=$31, movement_type=$32, service_type=$33, place_of_receipt=$34, place_of_delivery=$35,
      cargo_ready_date=$36, notify_id=$37, notify_name=$38,
      declared_value=$39, declared_value_currency=$40,
      emo_office_id=$41, imo_office_id=$42, controlling_office_id=$43,
      contract_valid_from=$44, contract_valid_to=$45, contract_routing_id=$46 WHERE id=$47 RETURNING id
    `, [polU, podU, carrierCode, contractType, contractNotes, effStatus, etd, eta, bookingRef, blNumber, blReleaseType, masterBlNumber, masterBlReleaseType, coloadTariffReference, vessel, voyage, incoterm, vesselImo, effContractId, effContractRef, commodityCode, shipperId, shipperName, consigneeId, consigneeName, principalId, principalName, effAllocationId, spaceSkipReason, spaceOverageReason, freightTerms, movementType, serviceType, placeOfReceipt, placeOfDelivery, cargoReadyDate || null, notifyId, notifyName, (declaredValue !== null && declaredValue !== undefined && String(declaredValue).trim() !== '') ? Number(declaredValue) : null, declaredValueCurrency || "USD", emoOfficeId || null, imoOfficeId || null, controllingOfficeId || null, contractValidFrom || null, contractValidTo || null, effContractRoutingId || "", req.params.id]);
    if (updatedRows.length === 0) return err(res, "Not found", 404);
    // Only re-attempt Line Agent resolution when carrier/route actually changed — the existing
    // partyOrRouteChanged flag (further below) doesn't check carrier_code, so this needs its
    // own condition rather than reusing that one.
    if (carrierCode !== existing.carrier_code || polU !== existing.pol || podU !== existing.pod)
      await maybeAssignLineAgents(req.params.id, carrierCode, polU, podU, req.user?.id);
    // Contract assignment is one of the two triggers for auto-creating a carrier booking
    // (the other is a schedule save/link, in routes/shipment-ops.js) — only worth checking
    // when the contract fields actually changed, since ensureBookingCreated no-ops otherwise.
    if (effContractId !== existing.contract_id || effContractRef !== existing.contract_ref)
      await ensureBookingCreated(req.params.id);
    const newVals = { pol: polU, pod: podU, status: effStatus, etd, eta, carrier_code: carrierCode,
      vessel, vessel_imo: vesselImo, voyage, incoterm, commodity_code: commodityCode,
      booking_ref: bookingRef, bl_number: blNumber, bl_release_type: blReleaseType, master_bl_number: masterBlNumber, master_bl_release_type: masterBlReleaseType, coload_tariff_reference: coloadTariffReference, contract_type: contractType,
      contract_id: effContractId, contract_ref: effContractRef, allocation_id: effAllocationId };
    for (const [col] of Object.entries(TRACKED_FIELDS)) {
      const o = String(existing[col] || ''), n = String(newVals[col] || '');
      if (o !== n) {
        const type = col === 'status' ? 'STATUS_CHANGED' : 'FIELD_UPDATED';
        await logEvent(req.params.id, type, col, o || null, n || null, '', req.user?.id);
      }
    }
    if (!existing.space_skip_reason && spaceSkipReason) {
      await logEvent(req.params.id, 'SPACE_SKIPPED', 'space_skip_reason', null, spaceSkipReason,
        JSON.stringify({ contractId, contractNumber: contractRef }), req.user?.id);
    }
    if (!existing.space_overage_reason && spaceOverageReason) {
      await logEvent(req.params.id, 'SPACE_OVERAGE', 'space_overage_reason', null, spaceOverageReason,
        JSON.stringify({ allocationId }), req.user?.id);
    }
    if (existing.status !== effStatus) {
      await query("INSERT INTO status_log (id,shipment_id,from_status,to_status,changed_at,changed_by) VALUES ($1,$2,$3,$4,$5,$6)",
        [`SL-${uid()}`, req.params.id, existing.status, effStatus, new Date().toISOString(), "user"]);
    }
    const [updated] = await query(`
      SELECT s.*, p1.name AS pol_name, p2.name AS pod_name,
             emo.code AS emo_office_code, emo.name AS emo_office_name,
             imo.code AS imo_office_code, imo.name AS imo_office_name,
             ctrl.code AS controlling_office_code, ctrl.name AS controlling_office_name
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      LEFT JOIN offices emo  ON emo.id  = s.emo_office_id
      LEFT JOIN offices imo  ON imo.id  = s.imo_office_id
      LEFT JOIN offices ctrl ON ctrl.id = s.controlling_office_id
      WHERE s.id = $1
    `, [req.params.id]);
    let silentScreening = null;
    if (sanctionsMap.size > 0) {
      const [prev] = await query("SELECT result, overridden_at FROM shipment_screenings WHERE shipment_id=$1", [req.params.id]);
      const isOverridden = prev?.result === 'CLEAR' && prev?.overridden_at;
      const partyOrRouteChanged = !prev
        || existing.shipper_name  !== shipperName
        || existing.consignee_name !== consigneeName
        || existing.principal_name !== principalName
        || existing.notify_name   !== notifyName
        || existing.pol            !== polU
        || existing.pod            !== podU;
      if (!isOverridden && partyOrRouteChanged) silentScreening = await screenShipmentById(req.params.id);
    }
    const body = mapShipment(updated);
    ok(res, { ...body, ...(silentScreening ? { screening: silentScreening } : {}), ...(scheduleDropped ? { scheduleDropped: true } : {}) });
  });

  app.delete("/api/shipments/:id", shipmentWrite, async (req, res) => {
    const deleted = await query("DELETE FROM shipments WHERE id=$1 RETURNING id", [req.params.id]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.id });
  });

  // ─── Edit Lock (first-come-first-served, whole-shipment) ──────────────────
  // Whole-shipment, not per-field/per-tab, and claimed the moment an edit-capable user opens the
  // shipment (any of its sub-pages) — see server.js's shipment_edit_locks migration comment for
  // the full rationale. No manual force-unlock: a stale lock (crashed tab, lost connection) just
  // self-clears once EDIT_LOCK_TTL_MINUTES passes since the holder's last heartbeat.
  const EDIT_LOCK_TTL_MINUTES = 30;

  app.post("/api/shipments/:id/edit-lock", shipmentWrite, async (req, res) => {
    const shipmentId = req.params.id;
    if (!(await query("SELECT 1 FROM shipments WHERE id=$1", [shipmentId]))[0]) return err(res, "Not found", 404);
    const now = new Date();
    const nowIso = now.toISOString();
    const [existing] = await query("SELECT * FROM shipment_edit_locks WHERE shipment_id=$1", [shipmentId]);
    const expired = existing && new Date(existing.expires_at) < now;
    if (existing && !expired && existing.locked_by_id !== req.user.id) {
      return ok(res, {
        locked: true, ownedByMe: false,
        lockedById: existing.locked_by_id, lockedByName: existing.locked_by_name,
        lockedAt: existing.locked_at, expiresAt: existing.expires_at,
      });
    }
    const lockerName = req.user.name || req.user.email;
    const lockedAt = (existing && !expired) ? existing.locked_at : nowIso;
    const expiresAt = new Date(now.getTime() + EDIT_LOCK_TTL_MINUTES * 60000).toISOString();
    const isNewHold = !existing || expired || existing.locked_by_id !== req.user.id;
    if (existing) {
      await query(`UPDATE shipment_edit_locks SET locked_by_id=$1, locked_by_name=$2, locked_at=$3, last_heartbeat_at=$4, expires_at=$5 WHERE shipment_id=$6`,
        [req.user.id, lockerName, lockedAt, nowIso, expiresAt, shipmentId]);
    } else {
      await query(`INSERT INTO shipment_edit_locks (shipment_id, locked_by_id, locked_by_name, locked_at, last_heartbeat_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
        [shipmentId, req.user.id, lockerName, lockedAt, nowIso, expiresAt]);
    }
    if (isNewHold) {
      broadcastEditLockChange(shipmentId, { locked: true, lockedById: req.user.id, lockedByName: lockerName, expiresAt });
    }
    ok(res, { locked: true, ownedByMe: true, lockedById: req.user.id, lockedByName: lockerName, lockedAt, expiresAt });
  });

  app.delete("/api/shipments/:id/edit-lock", shipmentWrite, async (req, res) => {
    const shipmentId = req.params.id;
    const [existing] = await query("SELECT * FROM shipment_edit_locks WHERE shipment_id=$1", [shipmentId]);
    if (existing && existing.locked_by_id === req.user.id) {
      await query("DELETE FROM shipment_edit_locks WHERE shipment_id=$1", [shipmentId]);
      broadcastEditLockChange(shipmentId, { locked: false });
    }
    ok(res, { locked: false });
  });

  // ─── Containers ────────────────────────────────────────────────────────────

  app.get("/api/containers", async (req, res) => {
    const rows = req.query.shipmentId
      ? await query("SELECT * FROM containers WHERE shipment_id=$1", [req.query.shipmentId])
      : await query("SELECT * FROM containers");
    const ids = rows.map(r => r.id);
    const evRows = ids.length
      ? await query(`SELECT container_id, event_type, location, occurred_at FROM container_events
                    WHERE container_id IN (${ids.map((_, i) => `$${i + 1}`).join(',')}) ORDER BY occurred_at ASC`, ids)
      : [];
    const byContainer = groupContainerEvents(evRows);
    ok(res, rows.map(r => {
      const g = byContainer[r.id] || { byType: {}, latest: null };
      return { ...mapContainer(r), ...deriveFreeTime(r, g.byType, g.latest) };
    }));
  });

  const CONTAINER_SIZES = ["20", "40"]; // matches the DB-level CHECK(size IN ('20','40')) on containers.size

  app.post("/api/containers", shipmentWrite, async (req, res) => {
    const { shipmentId, containerNumber = "", sealNumber = "", size, type,
            hsCode = "", cargoDescription = "", marksAndNumbers = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "",
            vgmWeightKg = null, vgmStatus = "Pending", vgmCutoff = "", cyCutoff = "",
            originFreeTimeDays = null, destFreeTimeDays = null,
            originDetentionFreeDays = null, destDetentionFreeDays = null,
            setTemperatureC = null } = req.body;
    if (!shipmentId || !size || !type) return err(res, "shipmentId, size, type required");
    if (!CONTAINER_SIZES.includes(size)) return err(res, `size must be one of: ${CONTAINER_SIZES.join(", ")}`);
    if (!(await query("SELECT 1 FROM shipments WHERE id=$1", [shipmentId]))[0]) return err(res, "Shipment not found", 404);
    if (grossWeightKg !== null && grossWeightKg !== undefined && Number(grossWeightKg) < 0) return err(res, "grossWeightKg cannot be negative");
    if (volumeCbm !== null && volumeCbm !== undefined && Number(volumeCbm) < 0) return err(res, "volumeCbm cannot be negative");
    const dgErr = await checkDgPolicy(shipmentId, isDg, dgClass);
    if (dgErr) return err(res, dgErr, 422);
    const id  = `CTR-${uid()}`;
    const cnU = containerNumber.toUpperCase();
    await query(`INSERT INTO containers (id,shipment_id,container_number,seal_number,size,type,hs_code,cargo_description,marks_and_numbers,gross_weight_kg,volume_cbm,is_dg,dg_class,
                vgm_weight_kg,vgm_status,vgm_cutoff,cy_cutoff,origin_free_time_days,dest_free_time_days,origin_detention_free_days,dest_detention_free_days,set_temperature_c) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [id, shipmentId, cnU, sealNumber, size, type, hsCode, cargoDescription, marksAndNumbers, grossWeightKg, volumeCbm, !!isDg, dgClass,
           vgmWeightKg, vgmStatus, vgmCutoff || null, cyCutoff || null, originFreeTimeDays, destFreeTimeDays, originDetentionFreeDays, destDetentionFreeDays, setTemperatureC]);
    const ctrRow = { id, shipment_id: shipmentId, container_number: cnU, seal_number: sealNumber, size, type, hs_code: hsCode, cargo_description: cargoDescription, marks_and_numbers: marksAndNumbers, gross_weight_kg: grossWeightKg, volume_cbm: volumeCbm, is_dg: !!isDg, dg_class: dgClass,
      vgm_weight_kg: vgmWeightKg, vgm_status: vgmStatus, vgm_cutoff: vgmCutoff || null, cy_cutoff: cyCutoff || null,
      origin_free_time_days: originFreeTimeDays, dest_free_time_days: destFreeTimeDays,
      origin_detention_free_days: originDetentionFreeDays, dest_detention_free_days: destDetentionFreeDays,
      set_temperature_c: setTemperatureC };
    // Brand-new container has no events yet — skip the query, free-time windows start 'not-started'.
    const addedCtr = { ...mapContainer(ctrRow), ...deriveFreeTime(ctrRow, {}, null) };
    await logEvent(shipmentId, 'CONTAINER_ADDED', null, null, cnU,
      JSON.stringify({ size, type, hsCode, cargoDescription }), req.user?.id);
    await recomputeSpaceBadge(shipmentId);
    ok(res, addedCtr, 201);
  });

  app.put("/api/containers/:id", shipmentWrite, async (req, res) => {
    const { containerNumber = "", sealNumber = "", size, type,
            hsCode = "", cargoDescription = "", marksAndNumbers = "", grossWeightKg = null, volumeCbm = null, isDg = false, dgClass = "",
            vgmWeightKg = null, vgmStatus = "Pending", vgmCutoff = "", cyCutoff = "",
            originFreeTimeDays = null, destFreeTimeDays = null,
            originDetentionFreeDays = null, destDetentionFreeDays = null,
            setTemperatureC = null } = req.body;
    const cnU    = containerNumber.toUpperCase();
    const [oldCtr] = await query("SELECT * FROM containers WHERE id=$1", [req.params.id]);
    if (!oldCtr) return err(res, "Not found", 404);
    if (!size || !type) return err(res, "size, type required");
    if (!CONTAINER_SIZES.includes(size)) return err(res, `size must be one of: ${CONTAINER_SIZES.join(", ")}`);
    if (grossWeightKg !== null && grossWeightKg !== undefined && Number(grossWeightKg) < 0) return err(res, "grossWeightKg cannot be negative");
    if (volumeCbm !== null && volumeCbm !== undefined && Number(volumeCbm) < 0) return err(res, "volumeCbm cannot be negative");
    const dgErr = await checkDgPolicy(oldCtr.shipment_id, isDg, dgClass);
    if (dgErr) return err(res, dgErr, 422);
    const updated = await query(`UPDATE containers SET container_number=$1, seal_number=$2, size=$3, type=$4, hs_code=$5, cargo_description=$6, marks_and_numbers=$7, gross_weight_kg=$8, volume_cbm=$9, is_dg=$10, dg_class=$11,
                vgm_weight_kg=$12, vgm_status=$13, vgm_cutoff=$14, cy_cutoff=$15, origin_free_time_days=$16, dest_free_time_days=$17, origin_detention_free_days=$18, dest_detention_free_days=$19, set_temperature_c=$20 WHERE id=$21 RETURNING id`,
      [cnU, sealNumber, size, type, hsCode, cargoDescription, marksAndNumbers, grossWeightKg, volumeCbm, !!isDg, dgClass,
           vgmWeightKg, vgmStatus, vgmCutoff || null, cyCutoff || null, originFreeTimeDays, destFreeTimeDays,
           originDetentionFreeDays, destDetentionFreeDays, setTemperatureC, req.params.id]);
    if (updated.length === 0) return err(res, "Not found", 404);
    const newVals = { container_number: cnU, size, type, hs_code: hsCode,
      cargo_description: cargoDescription, marks_and_numbers: marksAndNumbers, gross_weight_kg: grossWeightKg,
      volume_cbm: volumeCbm, is_dg: !!isDg, dg_class: dgClass,
      vgm_weight_kg: vgmWeightKg, vgm_status: vgmStatus, vgm_cutoff: vgmCutoff || null, cy_cutoff: cyCutoff || null,
      origin_free_time_days: originFreeTimeDays, dest_free_time_days: destFreeTimeDays,
      origin_detention_free_days: originDetentionFreeDays, dest_detention_free_days: destDetentionFreeDays,
      set_temperature_c: setTemperatureC };
    const meta = JSON.stringify({ containerNumber: cnU });
    for (const [col] of Object.entries(TRACKED_CTR_FIELDS)) {
      const o = String(oldCtr[col] ?? ''), n = String(newVals[col] ?? '');
      if (o !== n && !(o === '' && n === '')) {
        await logEvent(oldCtr.shipment_id, 'CONTAINER_UPDATED', col, o, n, meta, req.user?.id);
      }
    }
    const [row] = await query("SELECT * FROM containers WHERE id=$1", [req.params.id]);
    const evRows = await query("SELECT container_id, event_type, location, occurred_at FROM container_events WHERE container_id=$1 ORDER BY occurred_at ASC", [req.params.id]);
    const g = groupContainerEvents(evRows)[req.params.id] || { byType: {}, latest: null };
    await recomputeSpaceBadge(oldCtr.shipment_id);

    // TKT-OZD4V8: VGM is declared alongside Shipping Instructions in real booking
    // workflows — once every container on the shipment has VGM Submitted, treat that
    // as the si_submitted milestone step firing, rather than a separate untracked step.
    if (oldCtr.vgm_status !== 'Submitted' && vgmStatus === 'Submitted') {
      const allCtrs = await query("SELECT vgm_status FROM containers WHERE shipment_id=$1", [oldCtr.shipment_id]);
      if (allCtrs.length > 0 && allCtrs.every(c => c.vgm_status === 'Submitted')) {
        await autoCompleteMilestone(oldCtr.shipment_id, 'si_submitted',
          `Auto-completed — VGM submitted for all ${allCtrs.length} container(s)`);
      }
    }
    ok(res, { ...mapContainer(row), ...deriveFreeTime(row, g.byType, g.latest) });
  });

  app.delete("/api/containers/:id", shipmentWrite, async (req, res) => {
    const [ctr] = await query("SELECT * FROM containers WHERE id=$1", [req.params.id]);
    if (!ctr) return err(res, "Not found", 404);
    await query("DELETE FROM containers WHERE id=$1", [req.params.id]);
    await logEvent(ctr.shipment_id, 'CONTAINER_REMOVED', null, ctr.container_number, null,
      JSON.stringify({ size: ctr.size, type: ctr.type }), req.user?.id);
    await recomputeSpaceBadge(ctr.shipment_id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Bulk Container Import (direct request) ────────────────────────────────
  // Download a template, fill it, upload it back — a review-before-commit screen sits between
  // upload and actually creating anything. Columns mirror ContainerForm's own "Cargo Details"
  // section, deliberately excluding VGM/CY-cutoff/free-time fields — those are operational state
  // set later via the existing container UI as the shipment progresses, not bulk-imported cargo
  // data. The review screen's row shape ({rowNumber, data, errors}) is intentionally generic —
  // a later AI document-parsing wizard (extracting cargo data from a B/L) can feed the exact same
  // review step with AI-extracted rows instead of parsed spreadsheet rows, with no rework here.

  // Same duplication precedent as ADDITIONAL_PARTY_ROLES/BOOKABLE_CARRIERS/CONTRACT_PRESETS
  // elsewhere in this codebase — src/tokens.js's IMDG_CLASSES is frontend-only (ES module), so
  // the backend keeps its own copy of just the codes (not the full descriptions) to validate against.
  const IMDG_CLASS_CODES = ["1.1","1.2","1.3","1.4","1.5","1.6","2.1","2.2","2.3","3",
    "4.1","4.2","4.3","5.1","5.2","6.1","6.2","7","8","9"];

  const IMPORT_TEMPLATE_COLUMNS = [
    { header: "Container Number",      key: "containerNumber",  width: 18 },
    { header: "Seal Number",           key: "sealNumber",       width: 16 },
    { header: "Container Type Code*",  key: "typeCode",         width: 20 },
    { header: "HS Code",               key: "hsCode",           width: 14 },
    { header: "Cargo Description",     key: "cargoDescription", width: 32 },
    { header: "Marks & Numbers",       key: "marksAndNumbers",  width: 20 },
    { header: "Gross Weight (kg)",     key: "grossWeightKg",    width: 16 },
    { header: "Volume (CBM)",          key: "volumeCbm",        width: 14 },
    { header: "Is DG? (Y/N)",          key: "isDg",             width: 12 },
    { header: "DG Class",              key: "dgClass",          width: 12 },
    { header: "Reefer Set Temp (°C)",  key: "setTemperatureC",  width: 18 },
  ];

  // Shared between preview (informational) and commit (authoritative, re-run from scratch —
  // never trusts whatever the client hands back from its own already-shown preview pass).
  const parseImportRow = async (raw, shipmentId, typeDefsByCode) => {
    const errors = [];
    const str = v => (v === null || v === undefined ? "" : String(v)).trim();
    const containerNumber  = str(raw.containerNumber).toUpperCase();
    const sealNumber       = str(raw.sealNumber);
    const typeCode         = str(raw.typeCode).toUpperCase();
    const hsCode           = str(raw.hsCode);
    const cargoDescription = str(raw.cargoDescription);
    const marksAndNumbers  = str(raw.marksAndNumbers);
    const isDgRaw          = str(raw.isDg).toUpperCase();
    const isDg             = isDgRaw === "Y" || isDgRaw === "YES" || isDgRaw === "TRUE";
    const dgClass          = str(raw.dgClass);

    const typeDef = typeDefsByCode.get(typeCode);
    if (!typeCode) errors.push("Container Type Code is required");
    else if (!typeDef) errors.push(`"${typeCode}" is not a recognized active container type code`);

    const parseNum = (val, label) => {
      const s = str(val);
      if (!s) return null;
      const n = Number(s);
      if (Number.isNaN(n)) { errors.push(`${label} must be a number`); return null; }
      return n;
    };
    const grossWeightKg   = parseNum(raw.grossWeightKg, "Gross Weight (kg)");
    const volumeCbm       = parseNum(raw.volumeCbm, "Volume (CBM)");
    const setTemperatureC = parseNum(raw.setTemperatureC, "Reefer Set Temp (°C)");
    // Reefer set temp is deliberately not checked here — a frozen container's set point is
    // routinely negative (e.g. -18°C) — only weight/volume have no legitimate negative value.
    if (grossWeightKg !== null && grossWeightKg < 0) errors.push("Gross Weight (kg) cannot be negative");
    if (volumeCbm !== null && volumeCbm < 0) errors.push("Volume (CBM) cannot be negative");

    if (isDg && !dgClass) errors.push("DG Class is required when Is DG is Y");
    else if (isDg && !IMDG_CLASS_CODES.includes(dgClass)) errors.push(`"${dgClass}" is not a recognized IMDG class`);

    if (isDg && dgClass && IMDG_CLASS_CODES.includes(dgClass)) {
      const dgErr = await checkDgPolicy(shipmentId, isDg, dgClass);
      if (dgErr) errors.push(dgErr);
    }

    return {
      data: { containerNumber, sealNumber, typeCode, size: typeDef?.size || "", type: typeDef?.type || "",
        hsCode, cargoDescription, marksAndNumbers, grossWeightKg, volumeCbm, isDg, dgClass, setTemperatureC },
      errors,
    };
  };

  // parseImportRow only ever sees one row at a time, so a Container Number repeated across
  // several rows of the SAME batch — each individually valid — sailed through undetected and
  // committed as separate containers sharing an identical real-world number. Flags every row
  // whose (non-blank) Container Number appears more than once in this batch; blank numbers are
  // untouched since a real container number is optional on this template.
  const flagDuplicateContainerNumbers = (rows) => {
    const counts = new Map();
    for (const { data } of rows) {
      if (!data.containerNumber) continue;
      counts.set(data.containerNumber, (counts.get(data.containerNumber) || 0) + 1);
    }
    for (const { data, errors } of rows) {
      if (data.containerNumber && counts.get(data.containerNumber) > 1) {
        errors.push(`Container Number "${data.containerNumber}" is used by more than one row in this import batch`);
      }
    }
  };

  app.get("/api/containers/import-template", auth(), async (req, res) => {
    const typeRows = await query(
      "SELECT code FROM container_type_definitions WHERE is_active=TRUE ORDER BY sort_order, label"
    );
    if (typeRows.length === 0) return err(res, "No active container type definitions configured — set some up in Master Data first");

    const wb = new ExcelJS.Workbook();
    // very-hidden reference sheet backs the Excel dropdown lists — never meant to be seen or
    // edited, just referenced by the visible sheet's own data-validation formulae.
    const ref = wb.addWorksheet("Reference", { state: "veryHidden" });
    typeRows.forEach((r, i) => { ref.getCell(i + 1, 1).value = r.code; });
    ref.getCell(1, 2).value = "Y"; ref.getCell(2, 2).value = "N";
    IMDG_CLASS_CODES.forEach((c, i) => { ref.getCell(i + 1, 3).value = c; });

    const sheet = wb.addWorksheet("Containers");
    sheet.columns = IMPORT_TEMPLATE_COLUMNS;
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1A2E4A" } };

    sheet.addRow({ containerNumber: "EXAMPLE1234567", sealNumber: "SEAL0001", typeCode: typeRows[0].code,
      hsCode: "8471.30", cargoDescription: "General cargo — EXAMPLE, delete this row before importing",
      marksAndNumbers: "", grossWeightKg: 18000, volumeCbm: 58, isDg: "N", dgClass: "", setTemperatureC: "" });
    sheet.getRow(2).font = { italic: true, color: { argb: "FF888888" } };

    // Data-validation dropdowns on 300 data rows of headroom (rows 3..302) — most bad input is
    // caught in Excel itself, before the file is ever uploaded.
    for (let r = 3; r <= 302; r++) {
      sheet.getCell(`C${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [`Reference!$A$1:$A$${typeRows.length}`] };
      sheet.getCell(`I${r}`).dataValidation = { type: "list", allowBlank: true, formulae: ["Reference!$B$1:$B$2"] };
      sheet.getCell(`J${r}`).dataValidation = { type: "list", allowBlank: true, formulae: [`Reference!$C$1:$C$${IMDG_CLASS_CODES.length}`] };
    }

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="cargodesk-container-import-template.xlsx"');
    wb.xlsx.write(res).then(() => res.end()).catch(() => res.status(500).end());
  });

  app.post("/api/shipments/:id/containers/import/preview", shipmentWrite, async (req, res) => {
    const { data } = req.body || {};
    if (!data) return err(res, "data (base64 file contents) is required");
    const [shipment] = await query("SELECT id FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);

    const typeDefsByCode = new Map(
      (await query("SELECT * FROM container_type_definitions WHERE is_active=TRUE")).map(t => [t.code.toUpperCase(), t])
    );

    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(Buffer.from(data, "base64")); }
    catch { return err(res, "Could not read the uploaded file — make sure it's a valid .xlsx file"); }
    // Real bug caught live: the generated template's hidden "Reference" sheet (backs the Excel
    // dropdown lists) is added BEFORE "Containers", so it's worksheets[0] — reading data rows
    // from it produced 18 nonsense "rows" out of the IMDG class reference list. Select the real
    // data sheet by name, falling back to the first sheet only for a caller-built file that
    // doesn't use the template's own sheet name at all.
    const sheet = wb.getWorksheet("Containers") || wb.worksheets[0];
    if (!sheet) return err(res, "The uploaded file has no worksheets");

    const rawRows = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber < 3) return; // row 1 = header, row 2 = the generated example row
      const v = col => { const cell = row.getCell(col).value; return (cell && typeof cell === "object" && "result" in cell) ? cell.result : cell; };
      const raw = {
        containerNumber: v(1), sealNumber: v(2), typeCode: v(3), hsCode: v(4), cargoDescription: v(5),
        marksAndNumbers: v(6), grossWeightKg: v(7), volumeCbm: v(8), isDg: v(9), dgClass: v(10), setTemperatureC: v(11),
      };
      if (Object.values(raw).every(x => x === null || x === undefined || String(x).trim() === "")) return;
      rawRows.push({ rowNumber, raw });
    });

    const rows = [];
    for (const { rowNumber, raw } of rawRows) {
      const { data: rowData, errors } = await parseImportRow(raw, req.params.id, typeDefsByCode);
      rows.push({ rowNumber, data: rowData, errors });
    }
    flagDuplicateContainerNumbers(rows);
    ok(res, { rows });
  });

  app.post("/api/shipments/:id/containers/import/commit", shipmentWrite, async (req, res) => {
    const { rows } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) return err(res, "rows array is required");
    const [shipment] = await query("SELECT id FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);

    const typeDefsByCode = new Map(
      (await query("SELECT * FROM container_type_definitions WHERE is_active=TRUE")).map(t => [t.code.toUpperCase(), t])
    );

    const revalidated = [];
    for (const row of rows || []) {
      const raw = { ...(row.data || {}), isDg: row.data?.isDg ? "Y" : "N" };
      const { data, errors } = await parseImportRow(raw, req.params.id, typeDefsByCode);
      revalidated.push({ rowNumber: row.rowNumber, data, errors });
    }
    flagDuplicateContainerNumbers(revalidated);
    const stillFailing = revalidated.filter(r => r.errors.length > 0);
    if (stillFailing.length > 0) {
      return err(res, `${stillFailing.length} row(s) still have errors — nothing was imported`, 422);
    }

    const created = [];
    const eventsToLog = [];
    try {
      await transaction(async (tx) => {
        for (const { data } of revalidated) {
          const id = `CTR-${uid()}`;
          await tx.query(`INSERT INTO containers (id,shipment_id,container_number,seal_number,size,type,hs_code,cargo_description,marks_and_numbers,gross_weight_kg,volume_cbm,is_dg,dg_class,
                    vgm_weight_kg,vgm_status,vgm_cutoff,cy_cutoff,origin_free_time_days,dest_free_time_days,origin_detention_free_days,dest_detention_free_days,set_temperature_c) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
            [id, req.params.id, data.containerNumber, data.sealNumber, data.size, data.type, data.hsCode, data.cargoDescription, data.marksAndNumbers,
                 data.grossWeightKg, data.volumeCbm, !!data.isDg, data.dgClass,
                 null, "Pending", null, null, null, null, null, null, data.setTemperatureC]);
          const ctrRow = { id, shipment_id: req.params.id, container_number: data.containerNumber, seal_number: data.sealNumber,
            size: data.size, type: data.type, hs_code: data.hsCode, cargo_description: data.cargoDescription, marks_and_numbers: data.marksAndNumbers,
            gross_weight_kg: data.grossWeightKg, volume_cbm: data.volumeCbm, is_dg: !!data.isDg, dg_class: data.dgClass,
            vgm_weight_kg: null, vgm_status: "Pending", vgm_cutoff: null, cy_cutoff: null,
            origin_free_time_days: null, dest_free_time_days: null, origin_detention_free_days: null, dest_detention_free_days: null,
            set_temperature_c: data.setTemperatureC };
          created.push({ ...mapContainer(ctrRow), ...deriveFreeTime(ctrRow, {}, null) });
          eventsToLog.push({ size: data.size, type: data.type, hsCode: data.hsCode, cargoDescription: data.cargoDescription, containerNumber: data.containerNumber });
        }
      });
    } catch (e) {
      return err(res, e.message, 500);
    }
    // Audit-log writes deferred until after commit (see mdm.js's insertLocationRow for the same
    // reasoning) — the created containers are already durably committed at this point.
    for (const ev of eventsToLog) {
      await logEvent(req.params.id, 'CONTAINER_ADDED', null, null, ev.containerNumber,
        JSON.stringify({ size: ev.size, type: ev.type, hsCode: ev.hsCode, cargoDescription: ev.cargoDescription, source: 'bulk_import' }), req.user?.id);
    }
    await recomputeSpaceBadge(req.params.id);
    ok(res, { created }, 201);
  });

  // ─── Container Events (FCL lifecycle: Empty Pickup → Gate In → Loaded → Sailed →
  //     Discharged → Gate Out → Empty Return) ────────────────────────────────

  const CONTAINER_EVENT_TYPES = ["Empty Pickup", "Gate In", "Loaded", "Sailed", "Discharged", "Gate Out", "Empty Return"];

  app.get("/api/containers/:id/events", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM container_events WHERE container_id=$1 ORDER BY occurred_at ASC, created_at ASC", [req.params.id]);
    const events = rows.map(mapContainerEvent);
    // Batch-attach any condition/damage photos uploaded against a specific event (EIR,
    // TKT-QSUTQ7) — one query for the whole list, matching the batched-not-N+1 idiom the
    // demurrage/detention free-time computation already established for this same table.
    if (events.length > 0) {
      const eventIds = events.map(e => e.id);
      const ph = eventIds.map((_, i) => `$${i + 1}`).join(',');
      const photos = await query(
        `SELECT id, container_event_id, filename FROM shipment_documents WHERE container_event_id IN (${ph})`, eventIds
      );
      const photosByEvent = {};
      photos.forEach(p => { (photosByEvent[p.container_event_id] ||= []).push({ id: p.id, filename: p.filename }); });
      events.forEach(e => { e.photos = photosByEvent[e.id] || []; });
    }
    ok(res, events);
  });

  app.post("/api/containers/:id/events", shipmentWrite, async (req, res) => {
    const { eventType, occurredAt, location = "", notes = "", conditionNotes = "", damageFlag = false, chassisProvider = "" } = req.body || {};
    if (!eventType || !CONTAINER_EVENT_TYPES.includes(eventType))
      return err(res, `eventType must be one of: ${CONTAINER_EVENT_TYPES.join(", ")}`);
    if (!occurredAt) return err(res, "occurredAt required");
    const [ctr] = await query("SELECT * FROM containers WHERE id=$1", [req.params.id]);
    if (!ctr) return err(res, "Container not found", 404);
    const id = `CEV-${uid()}`;
    const now = new Date().toISOString();
    const recordedBy = req.user?.name || req.user?.email || "";
    await query(`INSERT INTO container_events
      (id, container_id, shipment_id, event_type, location, occurred_at, recorded_by, notes, condition_notes, damage_flag, chassis_provider, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, req.params.id, ctr.shipment_id, eventType, location, occurredAt, recordedBy, notes,
           conditionNotes, !!damageFlag, chassisProvider, now]);
    const [eventRow] = await query("SELECT * FROM container_events WHERE id=$1", [id]);
    const event = mapContainerEvent(eventRow);
    await logEvent(ctr.shipment_id, 'CONTAINER_EVENT_ADDED', null, null, `${eventType} — ${ctr.container_number}`,
      JSON.stringify({ containerId: req.params.id, eventType, occurredAt }), req.user?.id);

    // TKT-OZD4V8: once every container on the shipment has logged the same lifecycle
    // event, that's the real-world signal the corresponding milestone step represents —
    // Gate In (origin) -> cargo_gated_in, Gate Out (destination) -> cargo_released.
    const MILESTONE_BY_EVENT = { 'Gate In': 'cargo_gated_in', 'Gate Out': 'cargo_released' };
    const milestoneKey = MILESTONE_BY_EVENT[eventType];
    if (milestoneKey) {
      const allCtrs = await query("SELECT id FROM containers WHERE shipment_id=$1", [ctr.shipment_id]);
      const withEvent = await query("SELECT DISTINCT container_id FROM container_events WHERE shipment_id=$1 AND event_type=$2", [ctr.shipment_id, eventType]);
      if (allCtrs.length > 0 && withEvent.length >= allCtrs.length) {
        await autoCompleteMilestone(ctr.shipment_id, milestoneKey,
          `Auto-completed — all ${allCtrs.length} container(s) logged "${eventType}"`);
      }
    }
    ok(res, event, 201);
  });

  app.delete("/api/container-events/:id", shipmentWrite, async (req, res) => {
    const [ev] = await query("SELECT * FROM container_events WHERE id=$1", [req.params.id]);
    if (!ev) return err(res, "Not found", 404);
    await query("DELETE FROM container_events WHERE id=$1", [req.params.id]);
    ok(res, { deleted: req.params.id });
  });

  // ─── Container cargo manifest: pallet/box sub-level breakdown (TKT-EMFIBR) ─
  // Self-referencing tree, arbitrary depth. Returned as a flat list ordered by
  // position — the client builds the tree from parentId itself (same idiom as
  // Kanban's parent_id ticket nesting).

  app.get("/api/containers/:id/packages", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM container_packages WHERE container_id=$1 ORDER BY position ASC, created_at ASC", [req.params.id]);
    ok(res, rows.map(mapContainerPackage));
  });

  // Resolves+validates the optional per-item value/currency (Epic TKT-P3ASH1, Story
  // TKT-PV5P5L) and precomputes its USD equivalent at today's FX rate — shared by create
  // and update so both routes stay in sync. Write-time conversion (not live-at-read), same
  // amount_usd-at-write-time idiom as contract_rates/saveRates — keeps the cargo value
  // rollup and generated documents pure sums over already-USD numbers, no FX call at read
  // time. unitValue stays null (not 0) when nothing's entered — "$0" and "not priced yet"
  // must stay distinguishable.
  async function resolvePackageValue({ unitValue, currency }) {
    const uv = (unitValue === "" || unitValue == null) ? null : parseFloat(unitValue);
    if (uv != null && (!Number.isFinite(uv) || uv < 0)) throw new Error("unitValue must be a non-negative number");
    const curr = uv != null ? (currency || "USD") : "";
    const uvUsd = uv != null ? await toUsd(uv, curr) : null;
    return { uv, curr, uvUsd };
  }

  app.post("/api/containers/:id/packages", shipmentWrite, async (req, res) => {
    const { parentId = null, description, quantity = 1, packTypeId = null, isDg = false, dgClass = "",
            unitValue = null, currency = "", hsCode = "" } = req.body || {};
    if (!description || !description.trim()) return err(res, "description required");
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < 1) return err(res, "quantity must be a positive integer");
    const [ctr] = await query("SELECT id FROM containers WHERE id=$1", [req.params.id]);
    if (!ctr) return err(res, "Container not found", 404);
    if (parentId) {
      const [parent] = await query("SELECT id FROM container_packages WHERE id=$1 AND container_id=$2", [parentId, req.params.id]);
      if (!parent) return err(res, "Parent package not found on this container", 404);
    }
    let uv, curr, uvUsd;
    try { ({ uv, curr, uvUsd } = await resolvePackageValue({ unitValue, currency })); }
    catch (e) { return err(res, e.message); }
    const [{ n: siblingCount }] = await query("SELECT COUNT(*) AS n FROM container_packages WHERE container_id=$1 AND parent_id IS NOT DISTINCT FROM $2", [req.params.id, parentId]);
    const id = `PKG-${uid()}`;
    const now = new Date().toISOString();
    await query(`INSERT INTO container_packages (id, container_id, parent_id, description, quantity, position, pack_type_id, is_dg, dg_class, unit_value, currency, hs_code, unit_value_usd, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, req.params.id, parentId, description.trim(), qty, Number(siblingCount), packTypeId || null, !!isDg, dgClass || "",
           uv, curr, (hsCode || "").trim(), uvUsd, now]);
    const [row] = await query("SELECT * FROM container_packages WHERE id=$1", [id]);
    ok(res, mapContainerPackage(row), 201);
  });

  app.put("/api/container-packages/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM container_packages WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { description, quantity, packTypeId = null, isDg = false, dgClass = "",
            unitValue = null, currency = "", hsCode = "" } = req.body || {};
    if (!description || !description.trim()) return err(res, "description required");
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty < 1) return err(res, "quantity must be a positive integer");
    let uv, curr, uvUsd;
    try { ({ uv, curr, uvUsd } = await resolvePackageValue({ unitValue, currency })); }
    catch (e) { return err(res, e.message); }
    const hs = (hsCode || "").trim();
    await query("UPDATE container_packages SET description=$1, quantity=$2, pack_type_id=$3, is_dg=$4, dg_class=$5, unit_value=$6, currency=$7, hs_code=$8, unit_value_usd=$9 WHERE id=$10",
      [description.trim(), qty, packTypeId || null, !!isDg, dgClass || "", uv, curr, hs, uvUsd, req.params.id]);
    ok(res, mapContainerPackage({ ...existing, description: description.trim(), quantity: qty, pack_type_id: packTypeId || null,
      is_dg: !!isDg, dg_class: dgClass || "", unit_value: uv, currency: curr, hs_code: hs, unit_value_usd: uvUsd }));
  });

  // Deletes the package and its entire sub-tree (a package with children removed on
  // its own would otherwise orphan them with a dangling parent_id).
  app.delete("/api/container-packages/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM container_packages WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const toDelete = [req.params.id];
    for (let i = 0; i < toDelete.length; i++) {
      const children = await query("SELECT id FROM container_packages WHERE parent_id=$1", [toDelete[i]]);
      toDelete.push(...children.map(c => c.id));
    }
    const placeholders = toDelete.map((_, i) => `$${i + 1}`).join(',');
    await query(`DELETE FROM container_packages WHERE id IN (${placeholders})`, toDelete);
    ok(res, { deleted: toDelete });
  });

  // ─── Additional Parties (Epic TKT-5XFCAP, Story TKT-HG10IK) ────────────────
  // Generic role-based party assignment, alongside (not replacing) the 4 fixed
  // shipper/consignee/notify/principal columns on shipments. role is validated
  // against ADDITIONAL_PARTY_ROLES server-side too (defense in depth — the
  // frontend picker already filters to unassigned roles from the same list).

  app.get("/api/shipments/:id/parties", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM shipment_parties WHERE shipment_id=$1 ORDER BY created_at ASC", [req.params.id]);
    ok(res, rows.map(mapShipmentParty));
  });

  // Read-only: surfaces a Line Agent side that maybeAssignLineAgents (above) deliberately left
  // unassigned because resolveCarrierAgentCandidates found 2+ equally-valid candidates (only
  // possible via the linked-ports fallback) rather than guess which one. A side already filled —
  // whether by that auto-assign, or manually — has nothing to resolve and is omitted entirely, not
  // just because it'd be redundant: re-showing it would let a "pick" here silently overwrite an
  // operator's own deliberate manual choice. Picking a candidate is done via the existing
  // POST /api/shipments/:id/parties — this route only ever reads.
  app.get("/api/shipments/:id/line-agent-candidates", auth(), async (req, res) => {
    const [shipment] = await query("SELECT carrier_code, pol, pod FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Not found", 404);
    const filled = new Set(
      (await query("SELECT role FROM shipment_parties WHERE shipment_id=$1 AND role IN ($2,$3)",
        [req.params.id, "Line Agent (Export)", "Line Agent (Import)"])).map(r => r.role)
    );
    const result = {};
    const sides = [
      ["export", "Line Agent (Export)", shipment.pol],
      ["import", "Line Agent (Import)", shipment.pod],
    ];
    for (const [key, role, port] of sides) {
      if (filled.has(role) || !shipment.carrier_code || !port) continue;
      const candidates = await resolveCarrierAgentCandidates(shipment.carrier_code, port);
      if (candidates.length > 1) {
        result[key] = candidates.map(c => ({
          agentCustomerId: c.agent_customer_id, agentCustomerName: c.agent_customer_name, matchedVia: c.matched_via,
        }));
      }
    }
    ok(res, result);
  });

  // Capabilities cross-check (TKT-FQFE33, 2026-09-03 audit fix) — read-only awareness endpoint,
  // same non-blocking shape as line-agent-candidates above: nothing here forces a fix, it just
  // surfaces "the assigned Line Agent on this side doesn't offer something this shipment
  // actually needs" before a booking is sent, rather than after a carrier rejection.
  app.get("/api/shipments/:id/line-agent-capability-gaps", auth(), async (req, res) => {
    ok(res, await checkLineAgentCapabilityGaps(req.params.id));
  });

  // Line Agent (Export)/(Import) are the one pair of ADDITIONAL_PARTY_ROLES tied to a specific
  // office side rather than open to any shipmentWrite user — the export side owns the carrier
  // relationship at the load port, the import side owns it at the discharge port, and neither
  // should be able to reassign the other's contact. Every other role stays gated by shipmentWrite
  // alone, unchanged.
  const LINE_AGENT_SIDE = { "Line Agent (Export)": "Export", "Line Agent (Import)": "Import" };

  app.post("/api/shipments/:id/parties", shipmentWrite, async (req, res) => {
    const { role, customerId, customerName } = req.body || {};
    if (!role || !ADDITIONAL_PARTY_ROLES.includes(role)) return err(res, "Invalid role");
    if (!customerId || !customerName) return err(res, "customerId and customerName required");
    if (LINE_AGENT_SIDE[role] && !(await canEditOfficeSide(req, LINE_AGENT_SIDE[role])))
      return err(res, `Only ${LINE_AGENT_SIDE[role].toLowerCase()}-side users can assign the ${role}`, 403);
    const [sh] = await query("SELECT id FROM shipments WHERE id=$1", [req.params.id]);
    if (!sh) return err(res, "Shipment not found", 404);
    const id = `PTY-${uid()}`;
    const now = new Date().toISOString();
    try {
      await query(`INSERT INTO shipment_parties (id, shipment_id, role, customer_id, customer_name, created_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, [id, req.params.id, role, customerId, customerName, now]);
    } catch (e) {
      return err(res, isUniqueViolation(e) ? "This role is already assigned on this shipment — edit or remove it instead." : e.message);
    }
    // Real gap found live: assigning/reassigning/removing a party (Line Agent included) never
    // showed up on the shipment's own History tab at all — every fixed shipment field logs
    // through the TRACKED_FIELDS loop above, but this variable-length sibling table never wrote
    // to shipment_events. Mirrors that same mechanism rather than inventing a second one.
    await logEvent(req.params.id, 'PARTY_ASSIGNED', role, null, customerName, '', req.user?.id);
    await maybeRescreen(req.params.id);
    const [row] = await query("SELECT * FROM shipment_parties WHERE id=$1", [id]);
    ok(res, mapShipmentParty(row), 201);
  });

  // Role is immutable once assigned (it's the row's conceptual identity, backed by the
  // UNIQUE constraint) — PUT only ever reassigns which customer fills that role.
  app.put("/api/shipment-parties/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_parties WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const side = LINE_AGENT_SIDE[existing.role];
    if (side && !(await canEditOfficeSide(req, side)))
      return err(res, `Only ${side.toLowerCase()}-side users can reassign the ${existing.role}`, 403);
    const { customerId, customerName } = req.body || {};
    if (!customerId || !customerName) return err(res, "customerId and customerName required");
    await query("UPDATE shipment_parties SET customer_id=$1, customer_name=$2 WHERE id=$3", [customerId, customerName, req.params.id]);
    await logEvent(existing.shipment_id, 'PARTY_REASSIGNED', existing.role, existing.customer_name, customerName, '', req.user?.id);
    await maybeRescreen(existing.shipment_id);
    ok(res, mapShipmentParty({ ...existing, customer_id: customerId, customer_name: customerName }));
  });

  app.delete("/api/shipment-parties/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_parties WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const side = LINE_AGENT_SIDE[existing.role];
    if (side && !(await canEditOfficeSide(req, side)))
      return err(res, `Only ${side.toLowerCase()}-side users can remove the ${existing.role}`, 403);
    await query("DELETE FROM shipment_parties WHERE id=$1", [req.params.id]);
    await logEvent(existing.shipment_id, 'PARTY_REMOVED', existing.role, existing.customer_name, null, '', req.user?.id);
    await maybeRescreen(existing.shipment_id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Involved Offices: additional (backup) offices + disaster-recovery reassignment ────────
  // Direct follow-up to the Nested Office Groups redesign. Additional offices let more than one
  // office hold Export (or Import) work at once — side-tagged so an added office renders as its
  // own home-style group in that column immediately (see OfficeColumn, ShipmentDetailPage.jsx).
  // Reassignment of the actual EMO/IMO/Controlling column is a SEPARATE, dedicated action (not
  // folded into the generic shipment PUT) so a takeover always carries a required reason and its
  // own distinct audit-log entry — a routine multi-field shipment edit shouldn't need either.
  const SIDE_OFFICE_DEPT = { Export: "SE", Import: "SI" };
  const REASSIGN_FIELD_META = {
    emoOfficeId:         { column: "emo_office_id",         side: "Export",      dept: "SE", label: "Export Managing Office" },
    imoOfficeId:         { column: "imo_office_id",         side: "Import",      dept: "SI", label: "Import Managing Office" },
    controllingOfficeId: { column: "controlling_office_id", side: "Controlling", dept: null, label: "Controlling Office" },
  };

  const officeLabel = office => office ? `${office.code} — ${office.name}` : "(none)";

  app.get("/api/shipments/:id/side-offices", auth(), async (req, res) => {
    const rows = await query(
      `SELECT so.*, o.code AS office_code, o.name AS office_name FROM shipment_side_offices so
       JOIN offices o ON o.id = so.office_id WHERE so.shipment_id=$1 ORDER BY so.added_at ASC`, [req.params.id]
    );
    ok(res, rows.map(mapSideOffice));
  });

  app.post("/api/shipments/:id/side-offices", shipmentWrite, async (req, res) => {
    const { side, officeId } = req.body || {};
    if (!SIDE_OFFICE_DEPT[side]) return err(res, "side must be 'Export' or 'Import'");
    if (!officeId) return err(res, "officeId required");
    if (!(await canEditOfficeSide(req, side))) return err(res, `You don't have permission to add a ${side} office`, 403);
    const [sh] = await query("SELECT id FROM shipments WHERE id=$1", [req.params.id]);
    if (!sh) return err(res, "Shipment not found", 404);
    const [office] = await query("SELECT * FROM offices WHERE id=$1 AND is_active=TRUE", [officeId]);
    if (!office) return err(res, "Office not found or inactive");
    if (office.department !== SIDE_OFFICE_DEPT[side]) return err(res, `Office must be a ${SIDE_OFFICE_DEPT[side]} department office for ${side}`);
    const id = `SOF-${uid()}`;
    const now = new Date().toISOString();
    try {
      await query(`INSERT INTO shipment_side_offices (id, shipment_id, side, office_id, added_at, added_by)
        VALUES ($1,$2,$3,$4,$5,$6)`, [id, req.params.id, side, officeId, now, req.user?.name || req.user?.email || ""]);
    } catch (e) {
      return err(res, isUniqueViolation(e) ? "This office is already added to this side." : e.message);
    }
    const [row] = await query(
      `SELECT so.*, o.code AS office_code, o.name AS office_name FROM shipment_side_offices so
       JOIN offices o ON o.id = so.office_id WHERE so.id=$1`, [id]
    );
    // Same History-tab gap fixed for shipment_parties above — this sibling variable-length table
    // had the identical never-logged-to-shipment_events omission.
    await logEvent(req.params.id, 'SIDE_OFFICE_ADDED', `${side} Office`, null, `${row.office_code} — ${row.office_name}`, '', req.user?.id);
    ok(res, mapSideOffice(row), 201);
  });

  app.delete("/api/shipment-side-offices/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query(
      `SELECT so.*, o.code AS office_code, o.name AS office_name FROM shipment_side_offices so
       JOIN offices o ON o.id = so.office_id WHERE so.id=$1`, [req.params.id]
    );
    if (!existing) return err(res, "Not found", 404);
    if (!(await canEditOfficeSide(req, existing.side))) return err(res, `You don't have permission to remove a ${existing.side} office`, 403);
    await query("DELETE FROM shipment_side_offices WHERE id=$1", [req.params.id]);
    await logEvent(existing.shipment_id, 'SIDE_OFFICE_REMOVED', `${existing.side} Office`, `${existing.office_code} — ${existing.office_name}`, null, '', req.user?.id);
    ok(res, { deleted: req.params.id });
  });

  // Reassigning EMO/IMO/Controlling is a takeover, not a typo fix — always requires a reason and
  // always logs its own OFFICE_REASSIGNED event (the generic shipment PUT's TRACKED_FIELDS diff
  // log doesn't cover these 3 columns at all today), independent of the routine field-diff log.
  app.post("/api/shipments/:id/reassign-office", shipmentWrite, async (req, res) => {
    const { field, officeId, reason } = req.body || {};
    const meta = REASSIGN_FIELD_META[field];
    if (!meta) return err(res, "field must be one of: " + Object.keys(REASSIGN_FIELD_META).join(", "));
    if (!reason || !reason.trim()) return err(res, "A reason for reassignment is required");
    if (!(await canEditOfficeSide(req, meta.side))) return err(res, `You don't have permission to reassign the ${meta.label}`, 403);
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    let newOffice = null;
    if (officeId) {
      [newOffice] = await query("SELECT * FROM offices WHERE id=$1 AND is_active=TRUE", [officeId]);
      if (!newOffice) return err(res, "Office not found or inactive");
      if (meta.dept && newOffice.department !== meta.dept) return err(res, `Office must be a ${meta.dept} department office for ${meta.label}`);
    } else if (meta.dept) {
      return err(res, `${meta.label} is required and cannot be cleared`);
    }
    const [oldOffice] = shipment[meta.column] ? await query("SELECT * FROM offices WHERE id=$1", [shipment[meta.column]]) : [null];
    await query(`UPDATE shipments SET ${meta.column}=$1 WHERE id=$2`, [officeId || null, req.params.id]);
    await logEvent(req.params.id, "OFFICE_REASSIGNED", field, officeLabel(oldOffice), officeLabel(newOffice), reason.trim(), req.user?.id);

    // A replaced office shouldn't keep quietly handling services on THIS shipment just because
    // nothing else pointed them elsewhere — direct bug report: reassigning EMO/IMO/Controlling
    // left any service still individually assigned to the OLD office exactly where it was,
    // so the "replaced" office kept showing up as a live nested group on the Involved Offices
    // tab regardless of whether it was also marked inactive. Every lingering service on this
    // shipment now moves to the NEW office automatically, as part of the same reassignment —
    // gated by the same canEditOfficeSide check already passed above, independent of whatever
    // the caller later decides about the old office's global active/inactive status.
    let migratedServiceCount = 0;
    if (oldOffice && oldOffice.id !== (officeId || null)) {
      const lingering = await query(
        "SELECT id, side, service_type FROM shipment_services WHERE shipment_id=$1 AND office_id=$2",
        [req.params.id, oldOffice.id]
      );
      for (const svc of lingering) {
        await query("UPDATE shipment_services SET office_id=$1 WHERE id=$2", [officeId || '', svc.id]);
        await logEntityEvent('service', svc.id, 'UPDATED', 'office_id', oldOffice.id, officeId || '',
          JSON.stringify({ shipmentId: req.params.id, side: svc.side, serviceType: svc.service_type, reason: 'office_reassignment' }));
      }
      migratedServiceCount = lingering.length;
    }

    // mapShipment reads emoOfficeName/imoOfficeName/controllingOfficeName (and polName/podName)
    // off whatever the row carries — none of those are columns on `shipments` itself, only
    // resolved via a live JOIN (same query the main PUT route already uses). A bare SELECT *
    // here would leave them all blank while the reassigned column itself is correct — and since
    // the frontend merges this response straight over its cached shipment object
    // ({...s, ...updated}), that blank would silently clobber the already-correct pol/pod names
    // everywhere else the shipment is shown, not just misrender the office that was reassigned.
    const [updated] = await query(`
      SELECT s.*, p1.name AS pol_name, p2.name AS pod_name,
             emo.code AS emo_office_code, emo.name AS emo_office_name,
             imo.code AS imo_office_code, imo.name AS imo_office_name,
             ctrl.code AS controlling_office_code, ctrl.name AS controlling_office_name
      FROM shipments s
      LEFT JOIN port_locations p1 ON p1.unlocode = s.pol
      LEFT JOIN port_locations p2 ON p2.unlocode = s.pod
      LEFT JOIN offices emo  ON emo.id  = s.emo_office_id
      LEFT JOIN offices imo  ON imo.id  = s.imo_office_id
      LEFT JOIN offices ctrl ON ctrl.id = s.controlling_office_id
      WHERE s.id = $1
    `, [req.params.id]);
    ok(res, { ...mapShipment(updated), migratedServiceCount, oldOfficeId: oldOffice?.id || null });
  });

  // ─── Shipment Messages ────────────────────────────────────────────────────

  app.get("/api/shipments/:id/messages", async (req, res) => {
    const rows = await query(
      "SELECT * FROM shipment_messages WHERE shipment_id=$1 ORDER BY created_at ASC", [req.params.id]
    );
    ok(res, rows.map(r => ({ id: r.id, shipmentId: r.shipment_id, body: r.body,
      author: r.author, role: r.role, createdAt: r.created_at })));
  });

  app.post("/api/shipments/:id/messages", async (req, res) => {
    const { body, author = "User", role = "" } = req.body;
    if (!body || body.trim().length < 15) return err(res, "Message must be at least 15 characters", 400);
    if (body.trim().length > 500) return err(res, "Message must be at most 500 characters", 400);
    const id = `MSG-${uid()}`;
    const createdAt = new Date().toISOString();
    await query("INSERT INTO shipment_messages (id,shipment_id,body,author,role,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, req.params.id, body.trim(), author.trim(), role.trim(), createdAt]);
    const newMsg = { id, shipmentId: req.params.id, body: body.trim(), author, role, createdAt };
    broadcastMessage(req.params.id, newMsg);
    ok(res, newMsg, 201);
  });

  // ─── Shipment Legs ────────────────────────────────────────────────────────

  app.get("/api/shipments/:id/legs", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM shipment_legs WHERE shipment_id=$1 ORDER BY leg_order ASC", [req.params.id]);
    ok(res, rows.map(ctx.mapShipmentLeg));
  });

  app.post("/api/shipments/:id/legs", shipmentWrite, async (req, res) => {
    const { legType='SEA', movementType='SEA', movementBy='',
            mot: rawMot, pol='', pod='', polName='', podName='', etd=null, eta=null, carrierCode='',
            polLocType='Terminal', podLocType='Terminal',
            polLatitude=null, polLongitude=null, podLatitude=null, podLongitude=null,
            vessel='', vesselImo='', voyage='', contractType='', contractRef='' } = req.body;
    const mot = rawMot || LEG_TO_MOT[legType] || 'SEA';
    const polPoint = resolveLegPoint(legType, polLocType, pol, polLatitude, polLongitude);
    if (polPoint.error) return err(res, polPoint.error);
    const podPoint = resolveLegPoint(legType, podLocType, pod, podLatitude, podLongitude);
    if (podPoint.error) return err(res, podPoint.error);
    if (!validCoord(polPoint.lat, -90, 90)) return err(res, "POL latitude must be between -90 and 90");
    if (!validCoord(polPoint.lng, -180, 180)) return err(res, "POL longitude must be between -180 and 180");
    if (!validCoord(podPoint.lat, -90, 90)) return err(res, "POD latitude must be between -90 and 90");
    if (!validCoord(podPoint.lng, -180, 180)) return err(res, "POD longitude must be between -180 and 180");
    const id = `LEG-${uid()}`;
    const [maxOrder] = await query("SELECT MAX(leg_order) as m FROM shipment_legs WHERE shipment_id=$1", [req.params.id]);
    const legOrder = (maxOrder?.m ?? -1) + 1;
    const createdAt = new Date().toISOString();
    // etd_source/eta_source start blank (an estimate, not yet AIS-confirmed) — a leg created
    // through this route always carries a fresh, unconfirmed date, even if etd/eta happen to be
    // pre-filled from a picked sailing.
    await query(`INSERT INTO shipment_legs (id,shipment_id,leg_order,mot,leg_type,movement_type,pol,pod,pol_name,pod_name,pol_loc_type,pod_loc_type,pol_latitude,pol_longitude,pod_latitude,pod_longitude,etd,eta,carrier_code,vessel,vessel_imo,voyage,movement_by,contract_type,contract_ref,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [id, req.params.id, legOrder, mot, legType, movementType,
           polPoint.code, podPoint.code, polPoint.code ? polName : '', podPoint.code ? podName : '', polLocType, podLocType,
           polPoint.lat, polPoint.lng, podPoint.lat, podPoint.lng,
           etd||null, eta||null, carrierCode, vessel, vesselImo, voyage, movementBy,
           contractType, contractRef, createdAt]);
    await syncShipmentFromLegs(req.params.id, req.user?.id);
    // A hand-entered SEA leg with a real ETD counts as "has a schedule" for booking
    // auto-creation purposes too — see ensureBookingCreated's comment in server.js.
    await ensureBookingCreated(req.params.id);
    const [row] = await query("SELECT * FROM shipment_legs WHERE id=$1", [id]);
    ok(res, ctx.mapShipmentLeg(row), 201);
  });

  app.put("/api/shipments/:id/legs/:legId", shipmentWrite, async (req, res) => {
    const { legType='SEA', movementType='SEA', movementBy='',
            mot: rawMot, pol='', pod='', polName='', podName='', etd=null, eta=null, carrierCode='',
            polLocType='Terminal', podLocType='Terminal',
            polLatitude=null, polLongitude=null, podLatitude=null, podLongitude=null,
            vessel='', vesselImo='', voyage='', contractType='', contractRef='', legOrder } = req.body;
    const mot = rawMot || LEG_TO_MOT[legType] || 'SEA';
    const [existing] = await query("SELECT * FROM shipment_legs WHERE id=$1 AND shipment_id=$2", [req.params.legId, req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const polPoint = resolveLegPoint(legType, polLocType, pol, polLatitude, polLongitude);
    if (polPoint.error) return err(res, polPoint.error);
    const podPoint = resolveLegPoint(legType, podLocType, pod, podLatitude, podLongitude);
    if (podPoint.error) return err(res, podPoint.error);
    if (!validCoord(polPoint.lat, -90, 90)) return err(res, "POL latitude must be between -90 and 90");
    if (!validCoord(polPoint.lng, -180, 180)) return err(res, "POL longitude must be between -180 and 180");
    if (!validCoord(podPoint.lat, -90, 90)) return err(res, "POD latitude must be between -90 and 90");
    if (!validCoord(podPoint.lng, -180, 180)) return err(res, "POD longitude must be between -180 and 180");
    // The only writer here is this HTTP route (the AIS listener updates etd/eta directly via
    // its own DB calls, never through this endpoint) — so a changed date reaching this route is
    // inherently a manual correction, and clears the 'ais'-confirmed flag (the operator is
    // stating a new estimate/correction, not re-confirming the same detected event). An
    // unchanged value keeps whatever source it already had, so saving other fields on the same
    // leg doesn't accidentally erase an existing confirmation.
    const etdSource = etd !== (existing.etd || null) ? '' : existing.etd_source;
    const etaSource = eta !== (existing.eta || null) ? '' : existing.eta_source;
    await query(`UPDATE shipment_legs SET mot=$1,leg_type=$2,movement_type=$3,pol=$4,pod=$5,pol_name=$6,pod_name=$7,pol_loc_type=$8,pod_loc_type=$9,pol_latitude=$10,pol_longitude=$11,pod_latitude=$12,pod_longitude=$13,etd=$14,eta=$15,carrier_code=$16,vessel=$17,vessel_imo=$18,voyage=$19,movement_by=$20,contract_type=$21,contract_ref=$22,leg_order=$23,etd_source=$24,eta_source=$25 WHERE id=$26`,
      [mot, legType, movementType, polPoint.code, podPoint.code,
           polPoint.code ? polName : '', podPoint.code ? podName : '',
           polLocType, podLocType, polPoint.lat, polPoint.lng, podPoint.lat, podPoint.lng,
           etd||null, eta||null,
           carrierCode, vessel, vesselImo, voyage, movementBy,
           contractType, contractRef, legOrder ?? existing.leg_order,
           etdSource, etaSource, req.params.legId]);
    await syncShipmentFromLegs(req.params.id, req.user?.id);
    await ensureBookingCreated(req.params.id);
    const [row] = await query("SELECT * FROM shipment_legs WHERE id=$1", [req.params.legId]);
    ok(res, ctx.mapShipmentLeg(row));
  });

  app.delete("/api/shipments/:id/legs/:legId", shipmentWrite, async (req, res) => {
    const deleted = await query("DELETE FROM shipment_legs WHERE id=$1 AND shipment_id=$2 RETURNING id", [req.params.legId, req.params.id]);
    if (deleted.length === 0) return err(res, "Not found", 404);
    await syncShipmentFromLegs(req.params.id, req.user?.id);
    ok(res, { deleted: req.params.legId });
  });
};
