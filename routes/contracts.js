"use strict";

module.exports = function contractsRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapContract, mapLeg, mapRate, mapContractRouting, logEntityEvent, toUsd, findMatchingContractLegs,
          getSettings, callContractService } = ctx;

  // Contracts are full-CRUD for trade_manager alongside admin/operator — previously these
  // write routes had no role gate at all (any authenticated user, including viewer, could write).
  const write = requireRole(["admin", "operator", "trade_manager"]);

  // ─── contract_source toggle ─────────────────────────────────────────────────
  // 'local' (default) keeps every route below exactly as it's always behaved. 'remote' proxies
  // to the standalone Contract Management Service instead — each route gains one early branch
  // (checked fresh per request via getSettings(), no caching needed) rather than being rewritten;
  // the 'local' code path underneath is untouched byte-for-byte. See ARCHITECTURE/plan notes: this
  // is a one-way cutover lever, not a live sync — flipping back to 'local' does not pull remote
  // changes back.
  const isRemote = () => (getSettings().contract_source || "local") === "remote";

  // The service owns no linked_ports data of its own (that's monolith MDM) — findMatchingContractLegs
  // needs it keyed by each LEG's own pol/pod (not the query's), so the whole small table is resolved
  // here and handed to the service as explicit pairs on every match call. Confirmed live: this table
  // has only a couple of rows in practice, so shipping it whole per-request is cheap.
  function linkedPortPairsJson() {
    const pairs = db.prepare("SELECT primary_unlocode, linked_unlocode FROM linked_ports").all()
      .map(r => [r.primary_unlocode, r.linked_unlocode]);
    return JSON.stringify(pairs);
  }

  // routes/shipments.js and routes/allocations.js both reference a contract by id (contract_id)
  // for their own delete/withdraw-blocking reference guards — this service owns no shipments/
  // allocations data, so those checks are replicated here, against the monolith's own local
  // tables, before ever calling the remote route. Mirrors the exact wording the local DELETE/
  // withdraw routes below already use.
  function referencedByShipmentOrAllocation(contractId) {
    const shipmentInUse = db.prepare("SELECT id FROM shipments WHERE contract_id=? LIMIT 1").get(contractId);
    if (shipmentInUse) return "This contract is referenced by at least one shipment";
    const allocInUse = db.prepare("SELECT id FROM allocations WHERE contract_id=? LIMIT 1").get(contractId);
    if (allocInUse) return "This contract has a linked space configuration";
    return null;
  }

  // Mirrors MdmContractsPage.jsx's own CONTRACT_STATUSES dropdown list — previously nothing
  // validated contracts.status server-side at all (a plain dropdown could be bypassed by any
  // string via a direct API call), silently breaking every downstream check keyed on these 4
  // literal values (GET /api/contracts/match's status='Active' filter, expireStaleContracts,
  // pending-revalidation's Active-contract lookup).
  const CONTRACT_STATUSES = ["Active", "Draft", "Expired", "On Hold"];

  // ─── Amendment diffs ────────────────────────────────────────────────────────
  // Mirrors the field/oldValue/newValue diff-and-log idiom already established for cost lines
  // (CostLineHistoryModal) and sailing legs (upsertLeg) — contracts never had this: every prior
  // UPDATE logged one generic event with a handful of surface fields in a meta blob, with no way
  // to see WHAT actually changed (a status flip and a $400 rate increase produced an identical
  // event). EntityHistoryModal already renders field/oldValue/newValue generically for any
  // entityType, so no frontend change was needed to surface this.
  const CONTRACT_DIFF_FIELDS = [
    ["contract_number", "contractNumber"], ["contract_ref", "contractRef"], ["carrier_code", "carrierCode"],
    ["named_account_id", "namedAccountId"], ["named_account", "namedAccount"], ["movement_type", "movementType"],
    ["valid_from", "validFrom"], ["valid_to", "validTo"], ["currency", "currency"], ["status", "status"], ["notes", "notes"],
  ];
  function logContractFieldDiffs(id, oldRow, newVals) {
    for (const [col, key] of CONTRACT_DIFF_FIELDS) {
      const oldVal = oldRow[col] ?? "";
      const newVal = newVals[key] ?? "";
      if (String(oldVal) !== String(newVal)) logEntityEvent('contract', id, 'UPDATED', key, oldVal, newVal, null);
    }
    // Array fields — compare by sorted content, not raw string, so reordering the same set
    // doesn't spuriously log a change.
    const oldTypes = JSON.stringify([...JSON.parse(oldRow.container_types || "[]")].sort());
    const newTypes = JSON.stringify([...(newVals.containerTypes || [])].sort());
    if (oldTypes !== newTypes) logEntityEvent('contract', id, 'UPDATED', 'containerTypes', oldRow.container_types, JSON.stringify(newVals.containerTypes || []), null);
    const oldClasses = JSON.stringify([...JSON.parse(oldRow.imdg_classes || "[]")].sort());
    const newClasses = JSON.stringify([...(newVals.imdgClasses || [])].sort());
    if (oldClasses !== newClasses) logEntityEvent('contract', id, 'UPDATED', 'imdgClasses', oldRow.imdg_classes, JSON.stringify(newVals.imdgClasses || []), null);
    const oldDg = !!oldRow.dg_allowed, newDg = !!newVals.dgAllowed;
    if (oldDg !== newDg) logEntityEvent('contract', id, 'UPDATED', 'dgAllowed', String(oldDg), String(newDg), null);
  }

  // contract_rates rows get a brand-new id on every save (saveRates always DELETEs and
  // re-INSERTs — see below), so there's no stable row identity to diff against across edits.
  // Matched by content-key (service code + container type + unit + routing name) instead — a
  // real-world edit essentially never changes a rate line's own service code, so this reliably
  // tracks "the same logical charge" across a save even though its underlying row id changed. A
  // key present only on one side is a genuine add/remove, not a false-positive amount change.
  // Routing NAME, not routing_id, disambiguates two routings' otherwise-identical rate lines
  // (e.g. OFR/40HC priced differently on "Via Rotterdam" vs "Via Hamburg") — contract_routings
  // rows get fresh ids on every save exactly like legs/rates do, so an id would never survive
  // the round trip; the name is the stable, human-meaningful identity across an edit. Callers
  // must pre-resolve each rate's routingName onto the object before calling this (see saveLegs/
  // saveRates callers in POST/PUT below) since a bare routing_id/routingIndex on its own isn't
  // comparable across the old (DB) and new (request body) shapes.
  function logRateDiffs(id, oldRates, newRates) {
    const rateKey = r => `${r.service_code || r.serviceCode || ""}|${r.container_type || r.containerType || ""}|${r.unit || "per_container"}|${r.routingName || ""}`;
    const oldByKey = new Map(oldRates.map(r => [rateKey(r), r]));
    const newByKey = new Map(newRates.map(r => [rateKey(r), r]));
    for (const [k, oldR] of oldByKey) {
      if (!newByKey.has(k)) logEntityEvent('contract', id, 'UPDATED', 'rate_removed',
        `${oldR.amount} ${oldR.currency}`, null,
        JSON.stringify({ serviceCode: oldR.service_code, containerType: oldR.container_type || 'all' }));
    }
    for (const [k, newR] of newByKey) {
      const oldR = oldByKey.get(k);
      if (!oldR) {
        logEntityEvent('contract', id, 'UPDATED', 'rate_added', null,
          `${newR.amount || 0} ${newR.currency || 'USD'}`,
          JSON.stringify({ serviceCode: newR.serviceCode, containerType: newR.containerType || 'all' }));
      } else if (Number(oldR.amount) !== Number(newR.amount || 0) || (oldR.currency || 'USD') !== (newR.currency || 'USD')) {
        logEntityEvent('contract', id, 'UPDATED', `rate:${newR.serviceCode || oldR.service_code}`,
          `${oldR.amount} ${oldR.currency}`, `${newR.amount || 0} ${newR.currency || 'USD'}`,
          JSON.stringify({ containerType: newR.containerType || oldR.container_type || 'all' }));
      }
    }
  }

  // Named routings (e.g. "Via Shanghai/Rotterdam") are saved BEFORE legs/rates, same
  // delete-then-loop-insert-in-a-transaction shape as saveLegs/saveRates below — a routing row
  // gets a fresh id on every save too, so legs/rates can't reference a stable id from a prior
  // save. Instead the client correlates a leg/rate to a routing purely by ARRAY INDEX into the
  // `routings` payload (a leg/rate's `routingIndex` field) — the same "index is the only
  // identity that survives a save" convention `leg_order`/`sort_order` already rely on. Returns
  // the freshly generated ids in input order so saveLegs/saveRates can resolve routingIndex -> id.
  function saveRoutings(contractId, routings) {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM contract_routings WHERE contract_id=?").run(contractId);
      const ins = db.prepare(`INSERT INTO contract_routings (id,contract_id,name,sort_order,transit_days,notes,created_at)
        VALUES (?,?,?,?,?,?,?)`);
      const now = new Date().toISOString();
      const ids = routings.map((r, i) => {
        const id = `CRTG-${uid()}`;
        ins.run(id, contractId, r.name || "", i, r.transitDays || 0, r.notes || "", now);
        return id;
      });
      db.exec("COMMIT");
      return ids;
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  // Resolves a leg/rate's target routing to the real, freshly-generated contract_routings id.
  // Preferred path: an explicit routingIndex (an integer index into the CURRENT routings[]
  // payload) — this is what MdmContractsPage.jsx always sends, since it's the only identity
  // that survives a save (routing ids get regenerated every save, exactly like legs/rates do).
  // Fallback path (oldNameById/newIndexByName both optional): a caller that PUTs back
  // `{...previousGetResponse, someUnrelatedChange}` without re-deriving routingIndex — the
  // existing amendment-diff test in tests/contract-improvements.test.js does exactly this
  // pattern — carries a stale routingId instead. That's resolved via the routing's NAME, the
  // one thing that DOES survive when the routings list itself is unchanged.
  const resolveRoutingId = (item, routingIds, oldNameById = {}, newIndexByName = {}) => {
    if (Number.isInteger(item.routingIndex) && routingIds[item.routingIndex]) return routingIds[item.routingIndex];
    if (item.routingId && oldNameById[item.routingId] != null) {
      const idx = newIndexByName[oldNameById[item.routingId]];
      if (idx != null && routingIds[idx]) return routingIds[idx];
    }
    return "";
  };

  // Delete-then-loop-insert, wrapped in a transaction — an interrupted loop (a bad row, a
  // disk error, the process dying) used to leave a contract with its legs fully deleted and
  // only partially replaced. Mirrors the BEGIN/COMMIT/ROLLBACK pattern already established in
  // routes/mdm.js's own trade-lane-replace routes.
  function saveLegs(contractId, legs, routingIds = [], oldNameById = {}, newIndexByName = {}) {
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM contract_legs WHERE contract_id=?").run(contractId);
      const ins = db.prepare(`INSERT INTO contract_legs (id,contract_id,leg_order,pol,pol_name,pod,pod_name,transit_days,vessel_service,pol_linked_allowed,pod_linked_allowed,pol_carrier_haulage,pod_carrier_haulage,pol_haulage_locations,pod_haulage_locations,pol_loc_type,pod_loc_type,routing_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      legs.forEach((l, i) => {
        ins.run(`CLEG-${uid()}`, contractId, i, l.pol||"", l.polName||"", l.pod||"", l.podName||"", l.transitDays||0, l.vesselService||"",
             l.polLinkedAllowed ? 1 : 0, l.podLinkedAllowed ? 1 : 0,
             l.polCarrierHaulage ? 1 : 0, l.podCarrierHaulage ? 1 : 0,
             l.polHaulageLocations || "", l.podHaulageLocations || "",
             l.polLocType || 'Terminal', l.podLocType || 'Terminal', resolveRoutingId(l, routingIds, oldNameById, newIndexByName));
      });
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  // usd conversion (toUsd, potentially a network-backed FX lookup) resolves BEFORE the
  // transaction opens — holding a write transaction open across an awaited network call would
  // block other writers for however long that call takes, for no benefit (the resolved amounts
  // don't depend on anything inside the transaction itself).
  async function saveRates(contractId, rates, routingIds = [], oldNameById = {}, newIndexByName = {}) {
    const resolved = [];
    for (const r of rates) {
      resolved.push({ ...r, usd: await toUsd(r.amount || 0, r.currency || "USD") });
    }
    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM contract_rates WHERE contract_id=?").run(contractId);
      const ins = db.prepare(`INSERT INTO contract_rates (id,contract_id,service_code,description,amount,currency,amount_usd,unit,container_type,sort_order,notes,valid_from,valid_to,routing_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      resolved.forEach((r, i) => {
        ins.run(`RATE-${uid()}`, contractId, r.serviceCode||"", r.description||"", r.amount||0, r.currency||"USD", r.usd,
             r.unit||"per_container", r.containerType||"", i, r.notes||"", r.validFrom||"", r.validTo||"", resolveRoutingId(r, routingIds, oldNameById, newIndexByName));
      });
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  // ─── Auto-expire ────────────────────────────────────────────────────────────
  // status is otherwise a fully manual dropdown (MdmContractsPage.jsx) — nothing ever moved a
  // contract off 'Active' on its own once valid_to passed. Left unchecked this silently defeated
  // both contract-mismatch/revalidation checks (they filter status='Active' before anything
  // else) and the Header notification bell below, which needs a real signal to alert on. Runs
  // once at startup (covers a contract that expired while the server was down) and then on a
  // periodic sweep — contract expiry is date-only, so hourly is more than frequent enough.
  function expireStaleContracts() {
    const today = new Date().toISOString().slice(0, 10);
    const stale = db.prepare("SELECT id, contract_number, carrier_code FROM contracts WHERE status='Active' AND valid_to != '' AND valid_to < ?").all(today);
    if (stale.length === 0) return;
    const update = db.prepare("UPDATE contracts SET status='Expired' WHERE id=?");
    for (const c of stale) {
      update.run(c.id);
      logEntityEvent('contract', c.id, 'UPDATED', 'status', 'Active', 'Expired',
        JSON.stringify({ contractNumber: c.contract_number, carrierCode: c.carrier_code, reason: 'valid_to passed' }));
    }
  }
  expireStaleContracts();
  const expireSweep = setInterval(expireStaleContracts, 60 * 60 * 1000);
  expireSweep.unref?.();

  // Upcoming/just-passed expiries for the Header notification bell — MUST be before
  // /api/contracts/:id. Deliberately checked on the raw date condition (not status='Expired')
  // so a contract still mid-sweep-window (up to an hour stale) is caught immediately rather than
  // waiting for expireStaleContracts' own next tick.
  app.get("/api/contracts/expiring", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callContractService("GET", `/internal/contracts/expiring?days=${encodeURIComponent(req.query.days || "")}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const days = Math.max(1, parseInt(req.query.days, 10) || 14);
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT id, contract_number, carrier_code, valid_to FROM contracts
      WHERE status IN ('Active','Expired') AND valid_to != '' AND valid_to <= ?
      ORDER BY valid_to ASC LIMIT 20
    `).all(horizon);
    ok(res, rows.map(r => ({
      id: r.id, contractNumber: r.contract_number, carrierCode: r.carrier_code,
      validTo: r.valid_to, expired: r.valid_to < today,
    })));
  });

  // Contract typeahead — MUST be before /api/contracts/:id
  app.get("/api/contracts/search", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callContractService("GET", `/internal/contracts/search?${new URLSearchParams(req.query).toString()}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { q="", pol="", pod="", carrier="", asOf="" } = req.query;
    const clauses = [], params = [];
    if (q.trim()) { clauses.push(`(c.contract_number LIKE ? OR c.contract_ref LIKE ? OR c.carrier_code LIKE ? OR c.named_account LIKE ?)`); const s=`%${q.trim()}%`; params.push(s,s,s,s); }
    if (carrier.trim()) { clauses.push("c.carrier_code=?"); params.push(carrier.trim()); }
    if (asOf.trim()) { clauses.push("c.valid_from<=? AND c.valid_to>=?"); params.push(asOf, asOf); }
    clauses.push("c.status='Active'");
    const where = "WHERE " + clauses.join(" AND ");
    const rows = db.prepare(`SELECT c.* FROM contracts c ${where} ORDER BY c.contract_number LIMIT 10`).all(...params);
    ok(res, rows.map(mapContract));
  });

  // Contract route-match — MUST be before /api/contracts/:id
  // needsPolHaulage/needsPodHaulage are booleans the caller already knows (derived straight
  // from the shipment's own Pick-up/Delivery legs) rather than an encoded routingTerm string
  // this endpoint would have to re-parse — see findMatchingContractLegs in server.js, shared
  // with /api/allocations/match so a contract and its own space-config allocations are judged
  // by the identical rule. Deliberately NOT shared with GET /api/contracts (#schedules search).
  //
  // Emits one result per (contract, routing) pair, not one per contract id — a contract with
  // several named routings for the same lane (e.g. HLCU/Kuehne+Nagel CNCKG->SEGOT via three
  // different transshipment hubs) surfaces each as its own comparable, independently-priced
  // candidate. A legacy contract with no named routings still produces at most one result,
  // identical to this endpoint's pre-routing behavior.
  app.get("/api/contracts/match", async (req, res) => {
    if (isRemote()) {
      const params = new URLSearchParams(req.query);
      params.set("linkedPorts", linkedPortPairsJson());
      try { return ok(res, await callContractService("GET", `/internal/contracts/match?${params.toString()}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { pol = "", pod = "", etd = "", crd = "", carrier = "",
            needsPolHaulage = "", needsPodHaulage = "", pkuLocation = "", delLocation = "" } = req.query;
    if (!pol || !pod) return ok(res, []);

    const polU = pol.toUpperCase(), podU = pod.toUpperCase();
    const dateRef = crd || etd;
    const needsPol = needsPolHaulage === "1" || needsPolHaulage === "true";
    const needsPod = needsPodHaulage === "1" || needsPodHaulage === "true";

    const clauses = ["c.status='Active'"];
    const params  = [];
    if (dateRef) { clauses.push("c.valid_from<=? AND c.valid_to>=?"); params.push(dateRef, dateRef); }
    if (carrier.trim()) { clauses.push("c.carrier_code=?"); params.push(carrier.trim().toUpperCase()); }

    const candidates = db.prepare(
      `SELECT c.* FROM contracts c WHERE ${clauses.join(" AND ")} ORDER BY c.valid_from DESC LIMIT 50`
    ).all(...params);

    const results = [];
    for (const c of candidates) {
      const legs = db.prepare("SELECT * FROM contract_legs WHERE contract_id=? ORDER BY leg_order").all(c.id);
      const matches = findMatchingContractLegs(legs, { pol, pod, needsPolHaulage: needsPol, needsPodHaulage: needsPod, pkuLocation, delLocation });
      if (matches.length === 0) continue;
      const routingsById = Object.fromEntries(
        db.prepare("SELECT * FROM contract_routings WHERE contract_id=?").all(c.id).map(r => [r.id, mapContractRouting(r)])
      );
      for (const match of matches) {
        // matchedLegs is the specific contiguous run that satisfied the query — NOT the
        // contract's full leg list, which may include other routings entirely (see
        // findMatchingContractLegs). Callers that chain into a sailing search after picking
        // this contract need matchedLegs' own first pol/last pod, not the shipment's generic
        // SEA-leg span, so the search reflects the specific route this contract was rated for.
        results.push({ ...mapContract(c), legs: legs.map(mapLeg), matchedLegs: match.legs.map(mapLeg),
          matchKind: match.matchKind,
          routingId: match.routingId,
          routing: match.routingId ? (routingsById[match.routingId] || null) : null,
          linkedPolVia: match.firstLeg.pol !== polU ? match.firstLeg.pol : null,
          linkedPodVia: match.lastLeg.pod !== podU ? match.lastLeg.pod : null });
      }
    }

    // Rates: scoped to the specific routing that actually matched (that routing's own rows plus
    // contract-wide routing_id='' rows, e.g. a flat documentation fee), not every rate on the
    // whole contract — previously the full unfiltered rate set was attached regardless of which
    // leg-run matched, so a shipment could see pricing for a routing it wasn't even assigned.
    // For a legacy contract with no named routings, every existing rate row already has
    // routing_id='' by column default, so this filter still selects all of them — identical to
    // this endpoint's pre-routing behavior.
    if (results.length > 0) {
      const ids = [...new Set(results.map(r => r.id))];
      const allRates = db.prepare(`SELECT * FROM contract_rates WHERE contract_id IN (${ids.map(() => "?").join(",")}) ORDER BY sort_order`).all(...ids);
      const ratesByContract = {};
      for (const r of allRates) (ratesByContract[r.contract_id] = ratesByContract[r.contract_id] || []).push(r);
      for (const result of results) {
        const contractRates = ratesByContract[result.id] || [];
        result.rates = contractRates.filter(r => r.routing_id === result.routingId || !r.routing_id).map(mapRate);
      }
    }

    ok(res, results);
  });

  app.get("/api/contracts", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callContractService("GET", `/internal/contracts?${new URLSearchParams(req.query).toString()}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { search="", carrier="", status="", dg="", asOf="", containerType="",
            pol="", pod="", polOrigin="", podDestination="", routingTerm="",
            namedAccount="", limit="50", offset="0" } = req.query;
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const clauses = [], params = [];
    if (carrier.trim()) {
      const codes = carrier.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
      if (codes.length === 1) { clauses.push("c.carrier_code LIKE ?"); params.push(`%${codes[0]}%`); }
      else { clauses.push(`c.carrier_code IN (${codes.map(() => "?").join(",")})`); params.push(...codes); }
    }
    if (status.trim())        { clauses.push("c.status=?");               params.push(status.trim()); }
    if (dg !== "")            { clauses.push("c.dg_allowed=?");           params.push(dg === "1" ? 1 : 0); }
    if (asOf.trim())          { clauses.push("c.valid_from<=? AND c.valid_to>=?"); params.push(asOf, asOf); }
    if (containerType.trim()) { clauses.push("c.container_types LIKE ?"); params.push(`%"${containerType.trim()}"%`); }
    if (namedAccount.trim())  { clauses.push("(c.named_account LIKE ? OR c.named_account_id LIKE ?)"); const n = `%${namedAccount.trim()}%`; params.push(n, n); }
    if (pol.trim()) { clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND UPPER(l.pol)=UPPER(?))"); params.push(pol.trim()); }
    if (pod.trim()) { clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND UPPER(l.pod)=UPPER(?))"); params.push(pod.trim()); }
    if (polOrigin.trim()) {
      // Match legs where pol_carrier_haulage is enabled AND either no specific haulage locations
      // are listed (blank = accept any) OR the requested origin appears in the space-separated list.
      clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pol_carrier_haulage=1 AND (COALESCE(l.pol_haulage_locations,'')='' OR UPPER(' '||l.pol_haulage_locations||' ') LIKE UPPER('% '||?||' %')))");
      params.push(polOrigin.trim());
    }
    if (podDestination.trim()) {
      clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pod_carrier_haulage=1 AND (COALESCE(l.pod_haulage_locations,'')='' OR UPPER(' '||l.pod_haulage_locations||' ') LIKE UPPER('% '||?||' %')))");
      params.push(podDestination.trim());
    }
    if (routingTerm.trim()) {
      const hasPol = "EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pol_carrier_haulage=1)";
      const hasPod = "EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pod_carrier_haulage=1)";
      if (routingTerm === "P2P")                                  clauses.push(`NOT ${hasPol} AND NOT ${hasPod}`);
      if (["D2P","CY2P"].includes(routingTerm))                   clauses.push(`${hasPol} AND NOT ${hasPod}`);
      if (["P2D","P2CY"].includes(routingTerm))                   clauses.push(`NOT ${hasPol} AND ${hasPod}`);
      if (["D2D","D2CY","CY2D","CY2CY"].includes(routingTerm))   clauses.push(`${hasPol} AND ${hasPod}`);
    }
    if (search.trim()) {
      clauses.push(`(c.contract_number LIKE ? OR c.contract_ref LIKE ? OR c.named_account LIKE ? OR c.carrier_code LIKE ? OR EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND (l.pol LIKE ? OR l.pod LIKE ? OR l.pol_name LIKE ? OR l.pod_name LIKE ?)))`);
      const s = `%${search.trim()}%`; params.push(s, s, s, s, s, s, s, s);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM contracts c ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT c.* FROM contracts c ${where} ORDER BY c.valid_from DESC, c.created_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
    const ids = rows.map(r => r.id);
    let legsMap = {}, ratesMap = {}, routingsMap = {};
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      db.prepare(`SELECT * FROM contract_legs  WHERE contract_id IN (${ph}) ORDER BY leg_order`).all(...ids)
        .forEach(l => { (legsMap[l.contract_id]  = legsMap[l.contract_id]  || []).push(mapLeg(l)); });
      db.prepare(`SELECT * FROM contract_rates WHERE contract_id IN (${ph}) ORDER BY sort_order`).all(...ids)
        .forEach(r => { (ratesMap[r.contract_id] = ratesMap[r.contract_id] || []).push(mapRate(r)); });
      db.prepare(`SELECT * FROM contract_routings WHERE contract_id IN (${ph}) ORDER BY sort_order`).all(...ids)
        .forEach(rt => { (routingsMap[rt.contract_id] = routingsMap[rt.contract_id] || []).push(mapContractRouting(rt)); });
    }
    ok(res, { results: rows.map(r => ({ ...mapContract(r), legs: legsMap[r.id] || [], rates: ratesMap[r.id] || [], routings: routingsMap[r.id] || [] })), total, limit: lim, offset: off });
  });

  // Pending-contract revalidation — MUST be before /api/contracts/:id
  app.get("/api/contracts/revalidate", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callContractService("GET", `/internal/contracts/revalidate?ref=${encodeURIComponent(req.query.ref || "")}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { ref = "" } = req.query;
    if (!ref.trim()) return ok(res, []);
    const rows = db.prepare("SELECT * FROM contracts WHERE LOWER(contract_number) = LOWER(?) AND status = 'Active' ORDER BY valid_from DESC").all(ref.trim());
    ok(res, rows.map(mapContract));
  });

  // ─── Publish / Withdraw ─────────────────────────────────────────────────────
  // The plain status dropdown (edit form) can already flip Draft<->Active with zero validation
  // — nothing stopped an empty, dateless, or already-expired contract from being marked Active
  // and immediately becoming selectable (GET /api/contracts/match filters on status='Active'
  // alone). These two routes are the validated, guarded, audited path for that specific
  // transition — additive, not a replacement: the raw dropdown still works for every other
  // status change (e.g. Active -> On Hold) or as a manual override.
  app.post("/api/contracts/:id/publish", write, async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callContractService("POST", `/internal/contracts/${req.params.id}/publish`, {})); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
    if (!c) return err(res, "Not found", 404);
    if (c.status !== "Draft") return err(res, `Only a Draft contract can be published (this one is ${c.status})`);
    const rateCount = db.prepare("SELECT COUNT(*) AS n FROM contract_rates WHERE contract_id=?").get(req.params.id).n;
    const legCount   = db.prepare("SELECT COUNT(*) AS n FROM contract_legs  WHERE contract_id=?").get(req.params.id).n;
    if (rateCount === 0) return err(res, "Add at least one rate before publishing");
    if (legCount === 0) return err(res, "Add at least one route leg before publishing");
    // Once this contract has any named routing, every leg must belong to one — an "orphan" leg
    // with no routing_id would never surface through GET /api/contracts/match (which groups
    // strictly by routing) once any routing exists, so it'd be silently unreachable dead data.
    const routingCount = db.prepare("SELECT COUNT(*) AS n FROM contract_routings WHERE contract_id=?").get(req.params.id).n;
    if (routingCount > 0) {
      const orphanLegs = db.prepare("SELECT COUNT(*) AS n FROM contract_legs WHERE contract_id=? AND (routing_id IS NULL OR routing_id='')").get(req.params.id).n;
      if (orphanLegs > 0) return err(res, "Every leg must belong to a named routing once this contract has named routings — assign or remove the ungrouped leg(s) first");
    }
    if (!c.valid_from || !c.valid_to) return err(res, "Set both Valid From and Valid To before publishing");
    const today = new Date().toISOString().slice(0, 10);
    if (c.valid_to < today) return err(res, "Valid To is already in the past — update the validity window before publishing");
    db.prepare("UPDATE contracts SET status='Active' WHERE id=?").run(req.params.id);
    logEntityEvent('contract', req.params.id, 'PUBLISHED', 'status', 'Draft', 'Active',
      JSON.stringify({ contractNumber: c.contract_number, carrierCode: c.carrier_code, rateCount, legCount }));
    ok(res, mapContract({ ...c, status: 'Active' }));
  });

  app.post("/api/contracts/:id/withdraw", write, async (req, res) => {
    if (isRemote()) {
      // This service owns no shipments/allocations data — replicate the reference guard locally
      // (against the monolith's own tables) before ever calling the remote withdraw route.
      const reason = referencedByShipmentOrAllocation(req.params.id);
      if (reason) return err(res, `${reason} — use On Hold instead of withdrawing it to Draft`);
      try { return ok(res, await callContractService("POST", `/internal/contracts/${req.params.id}/withdraw`, {})); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
    if (!c) return err(res, "Not found", 404);
    if (c.status !== "Active") return err(res, `Only an Active contract can be withdrawn to Draft (this one is ${c.status})`);
    const shipmentInUse = db.prepare("SELECT id FROM shipments WHERE contract_id=? LIMIT 1").get(req.params.id);
    if (shipmentInUse) return err(res, "This contract is referenced by at least one shipment — use On Hold instead of withdrawing it to Draft");
    const allocInUse = db.prepare("SELECT id FROM allocations WHERE contract_id=? LIMIT 1").get(req.params.id);
    if (allocInUse) return err(res, "This contract has a linked space configuration — use On Hold instead of withdrawing it to Draft");
    db.prepare("UPDATE contracts SET status='Draft' WHERE id=?").run(req.params.id);
    logEntityEvent('contract', req.params.id, 'WITHDRAWN', 'status', 'Active', 'Draft',
      JSON.stringify({ contractNumber: c.contract_number, carrierCode: c.carrier_code }));
    ok(res, mapContract({ ...c, status: 'Draft' }));
  });

  app.get("/api/contracts/:id", async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callContractService("GET", `/internal/contracts/${req.params.id}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
    if (!c) return err(res, "Not found", 404);
    const legs     = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(req.params.id);
    const rates    = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
    const routings = db.prepare("SELECT * FROM contract_routings WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
    ok(res, { ...mapContract(c), legs: legs.map(mapLeg), rates: rates.map(mapRate), routings: routings.map(mapContractRouting) });
  });

  app.post("/api/contracts", write, async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callContractService("POST", "/internal/contracts", req.body), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { contractNumber="", contractRef="", carrierCode="", namedAccountId="", namedAccount="",
            movementType="FCL", containerTypes=[], dgAllowed=false, imdgClasses=[],
            validFrom="", validTo="", currency="USD", status="Active", notes="",
            legs=[], rates=[], routings=[] } = req.body;
    const dup = db.prepare("SELECT id FROM contracts WHERE contract_number=? AND contract_ref=? AND named_account_id=?").get(contractNumber, contractRef, namedAccountId);
    if (dup) return err(res, `A contract with this number${contractRef ? ", reference" : ""}${namedAccountId ? ", and account" : ""} already exists (${dup.id})`);
    if (!CONTRACT_STATUSES.includes(status)) return err(res, `status must be one of: ${CONTRACT_STATUSES.join(", ")}`);
    const id = `CNTR-${uid()}`;
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO contracts (id,contract_number,contract_ref,carrier_code,named_account_id,named_account,movement_type,container_types,dg_allowed,imdg_classes,valid_from,valid_to,currency,status,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType,
           JSON.stringify(containerTypes), dgAllowed ? 1 : 0, JSON.stringify(imdgClasses),
           validFrom, validTo, currency, status, notes, createdAt);
    const routingIds = saveRoutings(id, routings);
    saveLegs(id, legs, routingIds);
    await saveRates(id, rates, routingIds);
    const c    = db.prepare("SELECT * FROM contracts WHERE id=?").get(id);
    const lgs  = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(id);
    const rts  = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(id);
    const rtgs = db.prepare("SELECT * FROM contract_routings WHERE contract_id=? ORDER BY sort_order").all(id);
    logEntityEvent('contract', id, 'CREATED', null, null, null,
      JSON.stringify({ contractNumber, contractRef, carrierCode, validFrom, validTo, status }));
    ok(res, { ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate), routings: rtgs.map(mapContractRouting) }, 201);
  });

  app.put("/api/contracts/:id", write, async (req, res) => {
    if (isRemote()) {
      try { return ok(res, await callContractService("PUT", `/internal/contracts/${req.params.id}`, req.body)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { contractNumber="", contractRef="", carrierCode="", namedAccountId="", namedAccount="",
            movementType="FCL", containerTypes=[], dgAllowed=false, imdgClasses=[],
            validFrom="", validTo="", currency="USD", status="Active", notes="",
            legs=[], rates=[], routings=[] } = req.body;
    const dup = db.prepare("SELECT id FROM contracts WHERE contract_number=? AND contract_ref=? AND named_account_id=? AND id!=?").get(contractNumber, contractRef, namedAccountId, req.params.id);
    if (dup) return err(res, `A contract with this number${contractRef ? ", reference" : ""}${namedAccountId ? ", and account" : ""} already exists (${dup.id})`);
    if (!CONTRACT_STATUSES.includes(status)) return err(res, `status must be one of: ${CONTRACT_STATUSES.join(", ")}`);
    const oldRow   = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
    const oldRates = db.prepare("SELECT * FROM contract_rates WHERE contract_id=?").all(req.params.id);
    // Old routings' id -> name, resolved BEFORE saveRoutings deletes/regenerates them below —
    // needed to give oldRates a stable routingName for logRateDiffs' content key (see its own
    // comment: routing_id itself never survives a save, so name is the only comparable identity).
    const oldRoutingsById = Object.fromEntries(
      db.prepare("SELECT id, name FROM contract_routings WHERE contract_id=?").all(req.params.id).map(r => [r.id, r.name])
    );
    const info = db.prepare(`UPDATE contracts SET contract_number=?,contract_ref=?,carrier_code=?,named_account_id=?,named_account=?,
      movement_type=?,container_types=?,dg_allowed=?,imdg_classes=?,valid_from=?,valid_to=?,currency=?,status=?,notes=?
      WHERE id=?`)
      .run(contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType,
           JSON.stringify(containerTypes), dgAllowed ? 1 : 0, JSON.stringify(imdgClasses),
           validFrom, validTo, currency, status, notes, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    const routingIds = saveRoutings(req.params.id, routings);
    // Fallback correlation for a leg/rate that carries a stale routingId but no routingIndex
    // (see resolveRoutingId's own comment) — maps the OLD routing's name to its position in
    // THIS save's routings[] payload, so a leg/rate that was in "Via Rotterdam" before still
    // lands in "Via Rotterdam" after, even if the caller never touched the routings themselves.
    const newIndexByName = {};
    routings.forEach((r, i) => { if (r.name && !(r.name in newIndexByName)) newIndexByName[r.name] = i; });
    saveLegs(req.params.id, legs, routingIds, oldRoutingsById, newIndexByName);
    await saveRates(req.params.id, rates, routingIds, oldRoutingsById, newIndexByName);
    const c    = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
    const lgs  = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(req.params.id);
    const rts  = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
    const rtgs = db.prepare("SELECT * FROM contract_routings WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
    logContractFieldDiffs(req.params.id, oldRow, { contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType, containerTypes, dgAllowed, imdgClasses, validFrom, validTo, currency, status, notes });
    const oldRatesWithRoutingName = oldRates.map(r => ({ ...r, routingName: oldRoutingsById[r.routing_id] || '' }));
    const newRatesWithRoutingName = rates.map(r => ({
      ...r,
      routingName: (Number.isInteger(r.routingIndex) && routings[r.routingIndex]) ? (routings[r.routingIndex].name || '') : '',
    }));
    logRateDiffs(req.params.id, oldRatesWithRoutingName, newRatesWithRoutingName);
    ok(res, { ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate), routings: rtgs.map(mapContractRouting) });
  });

  app.delete("/api/contracts/:id", write, async (req, res) => {
    if (isRemote()) {
      const reason = referencedByShipmentOrAllocation(req.params.id);
      if (reason) return err(res, `${reason} — set its status to Expired/On Hold instead of deleting`);
      try { return ok(res, await callContractService("DELETE", `/internal/contracts/${req.params.id}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const existing = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    // shipments.contract_id and allocations.contract_id both carry no FK constraint (SQLite
    // ADD COLUMN can't retrofit one onto live rows) — without this guard a delete here silently
    // orphans every shipment/space-config that still points at this id, and neither the contract
    // route-matching endpoints nor the contract-mismatch checks were ever built to handle a
    // vanished contract, only an Active/Draft/Expired one. Same "referenced — deactivate instead"
    // pattern routes/offices.js already uses for the identical class of problem.
    const shipmentInUse = db.prepare("SELECT id FROM shipments WHERE contract_id=? LIMIT 1").get(req.params.id);
    if (shipmentInUse) return err(res, "This contract is referenced by at least one shipment — set its status to Expired/On Hold instead of deleting");
    const allocInUse = db.prepare("SELECT id FROM allocations WHERE contract_id=? LIMIT 1").get(req.params.id);
    if (allocInUse) return err(res, "This contract has a linked space configuration — remove or reassign that configuration first");
    db.prepare("DELETE FROM contracts WHERE id=?").run(req.params.id);
    logEntityEvent('contract', req.params.id, 'DELETED', null, null, null,
      JSON.stringify({ contractNumber: existing.contract_number, carrierCode: existing.carrier_code }));
    ok(res, { deleted: req.params.id });
  });

  // Entity events (shared endpoint — serves shipments via their own table, everything else via entity_events)
  app.get("/api/entity-events/:type/:id", (req, res) => {
    if (req.params.type === 'shipment') {
      const rows = db.prepare("SELECT * FROM shipment_events WHERE shipment_id=? ORDER BY occurred_at DESC").all(req.params.id);
      return ok(res, rows.map(r => ({
        id: r.id, entityType: 'shipment', entityId: r.shipment_id,
        eventType: r.event_type, field: r.field,
        oldValue: r.old_value, newValue: r.new_value,
        meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return r.meta; } })() : null,
        createdAt: r.occurred_at,
      })));
    }
    const rows = db.prepare("SELECT * FROM entity_events WHERE entity_type=? AND entity_id=? ORDER BY created_at DESC").all(req.params.type, req.params.id);
    ok(res, rows.map(r => ({
      id: r.id, entityType: r.entity_type, entityId: r.entity_id,
      eventType: r.event_type, field: r.field,
      oldValue: r.old_value, newValue: r.new_value,
      meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return r.meta; } })() : null,
      createdAt: r.created_at,
    })));
  });
};
