"use strict";

module.exports = function contractsRoutes(app, ctx) {
  const { query, transaction, ok, err, uid, requireRole, mapContract, mapLeg, mapRate, mapContractRouting, logEntityEvent, toUsd, findMatchingContractLegs,
          getSettings, callContractService, callMdmService, schemaReady } = ctx;

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
  const isRemote = async () => ((await getSettings()).contract_source || "local") === "remote";

  // The service owns no linked_ports data of its own (that's monolith MDM) — findMatchingContractLegs
  // needs it keyed by each LEG's own pol/pod (not the query's), so the whole small table is resolved
  // here and handed to the service as explicit pairs on every match call. Confirmed live: this table
  // has only a couple of rows in practice, so shipping it whole per-request is cheap.
  // Branches on mdm_source independently of contract_source — a shipment can be in the middle of
  // a "local contracts, remote MDM" transition, and the local linked_ports table stops being
  // fresh the moment mdm_source flips to remote (it's frozen, not deleted — see the plan's own
  // note on this narrow combination).
  async function linkedPortPairsJson() {
    if (((await getSettings()).mdm_source || "local") === "remote") {
      try { return JSON.stringify(await callMdmService("GET", "/internal/linked-ports/all")); }
      catch { return "[]"; } // an unreachable MDM service degrades match to exact-port-only, not a hard failure
    }
    const pairs = (await query("SELECT primary_unlocode, linked_unlocode FROM linked_ports"))
      .map(r => [r.primary_unlocode, r.linked_unlocode]);
    return JSON.stringify(pairs);
  }

  // routes/shipments.js and routes/allocations.js both reference a contract by id (contract_id)
  // for their own delete/withdraw-blocking reference guards — this service owns no shipments/
  // allocations data, so those checks are replicated here, against the monolith's own local
  // tables, before ever calling the remote route. Mirrors the exact wording the local DELETE/
  // withdraw routes below already use.
  async function referencedByShipmentOrAllocation(contractId) {
    const [shipmentInUse] = await query("SELECT id FROM shipments WHERE contract_id=$1 LIMIT 1", [contractId]);
    if (shipmentInUse) return "This contract is referenced by at least one shipment";
    const [allocInUse] = await query("SELECT id FROM allocations WHERE contract_id=$1 LIMIT 1", [contractId]);
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
  // oldContainerTypes/oldImdgClasses are pre-resolved by the caller from the junction tables
  // BEFORE saveContractArray below deletes and re-inserts them — container_types/imdg_classes no
  // longer live on oldRow itself (TKT-5YYLNT: those columns are frozen, no longer written to).
  async function logContractFieldDiffs(id, oldRow, newVals, oldContainerTypes, oldImdgClasses) {
    for (const [col, key] of CONTRACT_DIFF_FIELDS) {
      const oldVal = oldRow[col] ?? "";
      const newVal = newVals[key] ?? "";
      if (String(oldVal) !== String(newVal)) await logEntityEvent('contract', id, 'UPDATED', key, oldVal, newVal, null);
    }
    // Array fields — compare by sorted content, not raw string, so reordering the same set
    // doesn't spuriously log a change.
    const oldTypes = JSON.stringify([...(oldContainerTypes || [])].sort());
    const newTypes = JSON.stringify([...(newVals.containerTypes || [])].sort());
    if (oldTypes !== newTypes) await logEntityEvent('contract', id, 'UPDATED', 'containerTypes', JSON.stringify(oldContainerTypes || []), JSON.stringify(newVals.containerTypes || []), null);
    const oldClasses = JSON.stringify([...(oldImdgClasses || [])].sort());
    const newClasses = JSON.stringify([...(newVals.imdgClasses || [])].sort());
    if (oldClasses !== newClasses) await logEntityEvent('contract', id, 'UPDATED', 'imdgClasses', JSON.stringify(oldImdgClasses || []), JSON.stringify(newVals.imdgClasses || []), null);
    const oldDg = !!oldRow.dg_allowed, newDg = !!newVals.dgAllowed;
    if (oldDg !== newDg) await logEntityEvent('contract', id, 'UPDATED', 'dgAllowed', String(oldDg), String(newDg), null);
  }

  // ─── container_types / imdg_classes (TKT-5YYLNT — normalized off the legacy JSON columns) ──
  // Flat string arrays with no other per-item fields, so a single generic delete-then-reinsert
  // helper covers both tables — same transactional shape as saveLegs/saveRoutings above, since
  // the frontend already always submits the complete array on every save, never an incremental
  // add/remove.
  async function saveContractArray(table, column, contractId, values) {
    await transaction(async (tx) => {
      await tx.query(`DELETE FROM ${table} WHERE contract_id=$1`, [contractId]);
      const prefix = table === "contract_container_types" ? "CCT" : "CIC";
      for (const v of new Set((values || []).filter(Boolean))) {
        await tx.query(`INSERT INTO ${table} (id, contract_id, ${column}) VALUES ($1,$2,$3)`, [`${prefix}-${uid()}`, contractId, v]);
      }
    });
  }
  const saveContractContainerTypes = (contractId, types) => saveContractArray("contract_container_types", "container_type", contractId, types);
  const saveContractImdgClasses    = (contractId, classes) => saveContractArray("contract_imdg_classes", "imdg_class", contractId, classes);
  const getContractContainerTypes = async contractId => (await query("SELECT container_type FROM contract_container_types WHERE contract_id=$1", [contractId])).map(r => r.container_type);
  const getContractImdgClasses    = async contractId => (await query("SELECT imdg_class FROM contract_imdg_classes WHERE contract_id=$1", [contractId])).map(r => r.imdg_class);

  // Attaches fresh containerTypes/imdgClasses onto one already-mapped contract object, or a whole
  // array of them (one bulk IN(...) query each, mirroring the legsMap/ratesMap pattern the list
  // endpoint already uses) — overrides whatever mapContract itself derived from the now-frozen
  // legacy JSON columns. Every response site below wraps its existing mapContract(...) output
  // with this instead of duplicating the junction-table query at each call site.
  async function withContractArrays(mappedOrList) {
    const list = Array.isArray(mappedOrList) ? mappedOrList : [mappedOrList];
    if (list.length === 0) return mappedOrList;
    const ids = [...new Set(list.map(c => c.id))];
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    const typesByContract = {}, classesByContract = {};
    (await query(`SELECT contract_id, container_type FROM contract_container_types WHERE contract_id IN (${ph})`, ids))
      .forEach(r => { (typesByContract[r.contract_id] ||= []).push(r.container_type); });
    (await query(`SELECT contract_id, imdg_class FROM contract_imdg_classes WHERE contract_id IN (${ph})`, ids))
      .forEach(r => { (classesByContract[r.contract_id] ||= []).push(r.imdg_class); });
    list.forEach(c => { c.containerTypes = typesByContract[c.id] || []; c.imdgClasses = classesByContract[c.id] || []; });
    return mappedOrList;
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
  async function logRateDiffs(id, oldRates, newRates) {
    const rateKey = r => `${r.service_code || r.serviceCode || ""}|${r.container_type || r.containerType || ""}|${r.unit || "per_container"}|${r.routingName || ""}`;
    const oldByKey = new Map(oldRates.map(r => [rateKey(r), r]));
    const newByKey = new Map(newRates.map(r => [rateKey(r), r]));
    for (const [k, oldR] of oldByKey) {
      if (!newByKey.has(k)) await logEntityEvent('contract', id, 'UPDATED', 'rate_removed',
        `${oldR.amount} ${oldR.currency}`, null,
        JSON.stringify({ serviceCode: oldR.service_code, containerType: oldR.container_type || 'all' }));
    }
    for (const [k, newR] of newByKey) {
      const oldR = oldByKey.get(k);
      if (!oldR) {
        await logEntityEvent('contract', id, 'UPDATED', 'rate_added', null,
          `${newR.amount || 0} ${newR.currency || 'USD'}`,
          JSON.stringify({ serviceCode: newR.serviceCode, containerType: newR.containerType || 'all' }));
      } else if (Number(oldR.amount) !== Number(newR.amount || 0) || (oldR.currency || 'USD') !== (newR.currency || 'USD')) {
        await logEntityEvent('contract', id, 'UPDATED', `rate:${newR.serviceCode || oldR.service_code}`,
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
  async function saveRoutings(contractId, routings) {
    const now = new Date().toISOString();
    const ids = routings.map(() => `CRTG-${uid()}`);
    await transaction(async (tx) => {
      await tx.query("DELETE FROM contract_routings WHERE contract_id=$1", [contractId]);
      for (let i = 0; i < routings.length; i++) {
        const r = routings[i];
        await tx.query(`INSERT INTO contract_routings (id,contract_id,name,sort_order,transit_days,notes,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [ids[i], contractId, r.name || "", i, r.transitDays || 0, r.notes || "", now]);
      }
    });
    return ids;
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
  async function saveLegs(contractId, legs, routingIds = [], oldNameById = {}, newIndexByName = {}) {
    await transaction(async (tx) => {
      await tx.query("DELETE FROM contract_legs WHERE contract_id=$1", [contractId]);
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        await tx.query(`INSERT INTO contract_legs (id,contract_id,leg_order,pol,pol_name,pod,pod_name,transit_days,vessel_service,pol_linked_allowed,pod_linked_allowed,pol_carrier_haulage,pod_carrier_haulage,pol_haulage_locations,pod_haulage_locations,pol_loc_type,pod_loc_type,routing_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [`CLEG-${uid()}`, contractId, i, l.pol||"", l.polName||"", l.pod||"", l.podName||"", l.transitDays||0, l.vesselService||"",
           !!l.polLinkedAllowed, !!l.podLinkedAllowed,
           !!l.polCarrierHaulage, !!l.podCarrierHaulage,
           l.polHaulageLocations || "", l.podHaulageLocations || "",
           l.polLocType || 'Terminal', l.podLocType || 'Terminal', resolveRoutingId(l, routingIds, oldNameById, newIndexByName)]);
      }
    });
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
    await transaction(async (tx) => {
      await tx.query("DELETE FROM contract_rates WHERE contract_id=$1", [contractId]);
      for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i];
        await tx.query(`INSERT INTO contract_rates (id,contract_id,service_code,description,amount,currency,amount_usd,unit,container_type,sort_order,notes,valid_from,valid_to,routing_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [`RATE-${uid()}`, contractId, r.serviceCode||"", r.description||"", r.amount||0, r.currency||"USD", r.usd,
           r.unit||"per_container", r.containerType||"", i, r.notes||"", r.validFrom||"", r.validTo||"", resolveRoutingId(r, routingIds, oldNameById, newIndexByName)]);
      }
    });
  }

  // ─── Auto-expire ────────────────────────────────────────────────────────────
  // status is otherwise a fully manual dropdown (MdmContractsPage.jsx) — nothing ever moved a
  // contract off 'Active' on its own once valid_to passed. Left unchecked this silently defeated
  // both contract-mismatch/revalidation checks (they filter status='Active' before anything
  // else) and the Header notification bell below, which needs a real signal to alert on. Runs
  // once at startup (covers a contract that expired while the server was down) and then on a
  // periodic sweep — contract expiry is date-only, so hourly is more than frequent enough.
  async function expireStaleContracts() {
    const today = new Date().toISOString().slice(0, 10);
    const stale = await query("SELECT id, contract_number, carrier_code FROM contracts WHERE status='Active' AND valid_to != '' AND valid_to < $1", [today]);
    if (stale.length === 0) return;
    for (const c of stale) {
      await query("UPDATE contracts SET status='Expired' WHERE id=$1", [c.id]);
      await logEntityEvent('contract', c.id, 'UPDATED', 'status', 'Active', 'Expired',
        JSON.stringify({ contractNumber: c.contract_number, carrierCode: c.carrier_code, reason: 'valid_to passed' }));
    }
  }
  // This route file is required (and this call fires) synchronously at server startup, before
  // httpServer.listen()'s own schemaReadyPromise gate — the initial sweep must wait on schema
  // readiness itself, or it hits a real "relation contracts does not exist" on every fresh boot
  // (same ordering bug the AIS listener's initial tracked-legs load hit). The hourly interval is
  // left unguarded — 60 minutes comfortably outlasts schema creation either way.
  schemaReady.then(() => expireStaleContracts()).catch(e => console.error("expireStaleContracts failed:", e));
  const expireSweep = setInterval(() => expireStaleContracts().catch(e => console.error("expireStaleContracts failed:", e)), 60 * 60 * 1000);
  expireSweep.unref?.();

  // Upcoming/just-passed expiries for the Header notification bell — MUST be before
  // /api/contracts/:id. Deliberately checked on the raw date condition (not status='Expired')
  // so a contract still mid-sweep-window (up to an hour stale) is caught immediately rather than
  // waiting for expireStaleContracts' own next tick.
  app.get("/api/contracts/expiring", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callContractService("GET", `/internal/contracts/expiring?days=${encodeURIComponent(req.query.days || "")}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const days = Math.max(1, parseInt(req.query.days, 10) || 14);
    const today = new Date().toISOString().slice(0, 10);
    const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const rows = await query(`
      SELECT id, contract_number, carrier_code, valid_to FROM contracts
      WHERE status IN ('Active','Expired') AND valid_to != '' AND valid_to <= $1
      ORDER BY valid_to ASC LIMIT 20
    `, [horizon]);
    ok(res, rows.map(r => ({
      id: r.id, contractNumber: r.contract_number, carrierCode: r.carrier_code,
      validTo: r.valid_to, expired: r.valid_to < today,
    })));
  });

  // Contract typeahead — MUST be before /api/contracts/:id
  app.get("/api/contracts/search", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callContractService("GET", `/internal/contracts/search?${new URLSearchParams(req.query).toString()}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { q="", pol="", pod="", carrier="", asOf="" } = req.query;
    const clauses = [], params = [];
    const p = v => { params.push(v); return `$${params.length}`; };
    if (q.trim()) { const s=`%${q.trim()}%`; clauses.push(`(c.contract_number ILIKE ${p(s)} OR c.contract_ref ILIKE ${p(s)} OR c.carrier_code ILIKE ${p(s)} OR c.named_account ILIKE ${p(s)})`); }
    if (carrier.trim()) clauses.push(`c.carrier_code=${p(carrier.trim())}`);
    if (asOf.trim()) clauses.push(`c.valid_from<=${p(asOf)} AND c.valid_to>=${p(asOf)}`);
    clauses.push("c.status='Active'");
    const where = "WHERE " + clauses.join(" AND ");
    const rows = await query(`SELECT c.* FROM contracts c ${where} ORDER BY c.contract_number LIMIT 10`, params);
    ok(res, await withContractArrays(rows.map(mapContract)));
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
    if (await isRemote()) {
      const params = new URLSearchParams(req.query);
      params.set("linkedPorts", await linkedPortPairsJson());
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
    const p = v => { params.push(v); return `$${params.length}`; };
    if (dateRef) clauses.push(`c.valid_from<=${p(dateRef)} AND c.valid_to>=${p(dateRef)}`);
    if (carrier.trim()) clauses.push(`c.carrier_code=${p(carrier.trim().toUpperCase())}`);

    const candidates = await query(
      `SELECT c.* FROM contracts c WHERE ${clauses.join(" AND ")} ORDER BY c.valid_from DESC LIMIT 50`, params
    );

    const results = [];
    for (const c of candidates) {
      const legs = await query("SELECT * FROM contract_legs WHERE contract_id=$1 ORDER BY leg_order", [c.id]);
      const matches = await findMatchingContractLegs(legs, { pol, pod, needsPolHaulage: needsPol, needsPodHaulage: needsPod, pkuLocation, delLocation });
      if (matches.length === 0) continue;
      const routingsById = Object.fromEntries(
        (await query("SELECT * FROM contract_routings WHERE contract_id=$1", [c.id])).map(r => [r.id, mapContractRouting(r)])
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
      const allRates = await query(`SELECT * FROM contract_rates WHERE contract_id IN (${ids.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY sort_order`, ids);
      const ratesByContract = {};
      for (const r of allRates) (ratesByContract[r.contract_id] = ratesByContract[r.contract_id] || []).push(r);
      for (const result of results) {
        const contractRates = ratesByContract[result.id] || [];
        result.rates = contractRates.filter(r => r.routing_id === result.routingId || !r.routing_id).map(mapRate);
      }
    }

    ok(res, await withContractArrays(results));
  });

  app.get("/api/contracts", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callContractService("GET", `/internal/contracts?${new URLSearchParams(req.query).toString()}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { search="", carrier="", status="", dg="", asOf="", containerType="",
            pol="", pod="", polOrigin="", podDestination="", routingTerm="",
            namedAccount="", limit="50", offset="0" } = req.query;
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const clauses = [], params = [];
    const p = v => { params.push(v); return `$${params.length}`; };
    if (carrier.trim()) {
      const codes = carrier.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
      if (codes.length === 1) clauses.push(`c.carrier_code ILIKE ${p(`%${codes[0]}%`)}`);
      else clauses.push(`c.carrier_code IN (${codes.map(v => p(v)).join(",")})`);
    }
    if (status.trim())        clauses.push(`c.status=${p(status.trim())}`);
    if (dg !== "")            clauses.push(`c.dg_allowed=${p(dg === "1")}`);
    if (asOf.trim())          clauses.push(`c.valid_from<=${p(asOf)} AND c.valid_to>=${p(asOf)}`);
    if (containerType.trim()) clauses.push(`EXISTS(SELECT 1 FROM contract_container_types t WHERE t.contract_id=c.id AND t.container_type=${p(containerType.trim())})`);
    if (namedAccount.trim())  { const n = `%${namedAccount.trim()}%`; clauses.push(`(c.named_account ILIKE ${p(n)} OR c.named_account_id ILIKE ${p(n)})`); }
    if (pol.trim()) clauses.push(`EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND UPPER(l.pol)=UPPER(${p(pol.trim())}))`);
    if (pod.trim()) clauses.push(`EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND UPPER(l.pod)=UPPER(${p(pod.trim())}))`);
    if (polOrigin.trim()) {
      // Match legs where pol_carrier_haulage is enabled AND either no specific haulage locations
      // are listed (blank = accept any) OR the requested origin appears in the space-separated list.
      clauses.push(`EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pol_carrier_haulage=TRUE AND (COALESCE(l.pol_haulage_locations,'')='' OR UPPER(' '||l.pol_haulage_locations||' ') LIKE UPPER('% '||${p(polOrigin.trim())}||' %')))`);
    }
    if (podDestination.trim()) {
      clauses.push(`EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pod_carrier_haulage=TRUE AND (COALESCE(l.pod_haulage_locations,'')='' OR UPPER(' '||l.pod_haulage_locations||' ') LIKE UPPER('% '||${p(podDestination.trim())}||' %')))`);
    }
    if (routingTerm.trim()) {
      const hasPol = "EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pol_carrier_haulage=TRUE)";
      const hasPod = "EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pod_carrier_haulage=TRUE)";
      if (routingTerm === "P2P")                                  clauses.push(`NOT ${hasPol} AND NOT ${hasPod}`);
      if (["D2P","CY2P"].includes(routingTerm))                   clauses.push(`${hasPol} AND NOT ${hasPod}`);
      if (["P2D","P2CY"].includes(routingTerm))                   clauses.push(`NOT ${hasPol} AND ${hasPod}`);
      if (["D2D","D2CY","CY2D","CY2CY"].includes(routingTerm))   clauses.push(`${hasPol} AND ${hasPod}`);
    }
    if (search.trim()) {
      const s = `%${search.trim()}%`;
      clauses.push(`(c.contract_number ILIKE ${p(s)} OR c.contract_ref ILIKE ${p(s)} OR c.named_account ILIKE ${p(s)} OR c.carrier_code ILIKE ${p(s)} OR EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND (l.pol ILIKE ${p(s)} OR l.pod ILIKE ${p(s)} OR l.pol_name ILIKE ${p(s)} OR l.pod_name ILIKE ${p(s)})))`);
    }
    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM contracts c ${where}`, params);
    const rows  = await query(`SELECT c.* FROM contracts c ${where} ORDER BY c.valid_from DESC, c.created_at DESC LIMIT ${p(lim)} OFFSET ${p(off)}`, params);
    const ids = rows.map(r => r.id);
    let legsMap = {}, ratesMap = {}, routingsMap = {};
    if (ids.length > 0) {
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      (await query(`SELECT * FROM contract_legs  WHERE contract_id IN (${ph}) ORDER BY leg_order`, ids))
        .forEach(l => { (legsMap[l.contract_id]  = legsMap[l.contract_id]  || []).push(mapLeg(l)); });
      (await query(`SELECT * FROM contract_rates WHERE contract_id IN (${ph}) ORDER BY sort_order`, ids))
        .forEach(r => { (ratesMap[r.contract_id] = ratesMap[r.contract_id] || []).push(mapRate(r)); });
      (await query(`SELECT * FROM contract_routings WHERE contract_id IN (${ph}) ORDER BY sort_order`, ids))
        .forEach(rt => { (routingsMap[rt.contract_id] = routingsMap[rt.contract_id] || []).push(mapContractRouting(rt)); });
    }
    ok(res, { results: await withContractArrays(rows.map(r => ({ ...mapContract(r), legs: legsMap[r.id] || [], rates: ratesMap[r.id] || [], routings: routingsMap[r.id] || [] }))), total: Number(total), limit: lim, offset: off });
  });

  // Pending-contract revalidation — MUST be before /api/contracts/:id
  app.get("/api/contracts/revalidate", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callContractService("GET", `/internal/contracts/revalidate?ref=${encodeURIComponent(req.query.ref || "")}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { ref = "" } = req.query;
    if (!ref.trim()) return ok(res, []);
    const rows = await query("SELECT * FROM contracts WHERE LOWER(contract_number) = LOWER($1) AND status = 'Active' ORDER BY valid_from DESC", [ref.trim()]);
    ok(res, await withContractArrays(rows.map(mapContract)));
  });

  // ─── Publish / Withdraw ─────────────────────────────────────────────────────
  // The plain status dropdown (edit form) can already flip Draft<->Active with zero validation
  // — nothing stopped an empty, dateless, or already-expired contract from being marked Active
  // and immediately becoming selectable (GET /api/contracts/match filters on status='Active'
  // alone). These two routes are the validated, guarded, audited path for that specific
  // transition — additive, not a replacement: the raw dropdown still works for every other
  // status change (e.g. Active -> On Hold) or as a manual override.
  app.post("/api/contracts/:id/publish", write, async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callContractService("POST", `/internal/contracts/${req.params.id}/publish`, {})); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [c] = await query("SELECT * FROM contracts WHERE id=$1", [req.params.id]);
    if (!c) return err(res, "Not found", 404);
    if (c.status !== "Draft") return err(res, `Only a Draft contract can be published (this one is ${c.status})`);
    const [{ n: rateCount }] = await query("SELECT COUNT(*) AS n FROM contract_rates WHERE contract_id=$1", [req.params.id]);
    const [{ n: legCount }]  = await query("SELECT COUNT(*) AS n FROM contract_legs  WHERE contract_id=$1", [req.params.id]);
    if (Number(rateCount) === 0) return err(res, "Add at least one rate before publishing");
    if (Number(legCount) === 0) return err(res, "Add at least one route leg before publishing");
    // Once this contract has any named routing, every leg must belong to one — an "orphan" leg
    // with no routing_id would never surface through GET /api/contracts/match (which groups
    // strictly by routing) once any routing exists, so it'd be silently unreachable dead data.
    const [{ n: routingCount }] = await query("SELECT COUNT(*) AS n FROM contract_routings WHERE contract_id=$1", [req.params.id]);
    if (Number(routingCount) > 0) {
      const [{ n: orphanLegs }] = await query("SELECT COUNT(*) AS n FROM contract_legs WHERE contract_id=$1 AND (routing_id IS NULL OR routing_id='')", [req.params.id]);
      if (Number(orphanLegs) > 0) return err(res, "Every leg must belong to a named routing once this contract has named routings — assign or remove the ungrouped leg(s) first");
    }
    if (!c.valid_from || !c.valid_to) return err(res, "Set both Valid From and Valid To before publishing");
    const today = new Date().toISOString().slice(0, 10);
    if (c.valid_to < today) return err(res, "Valid To is already in the past — update the validity window before publishing");
    await query("UPDATE contracts SET status='Active' WHERE id=$1", [req.params.id]);
    await logEntityEvent('contract', req.params.id, 'PUBLISHED', 'status', 'Draft', 'Active',
      JSON.stringify({ contractNumber: c.contract_number, carrierCode: c.carrier_code, rateCount: Number(rateCount), legCount: Number(legCount) }));
    ok(res, await withContractArrays(mapContract({ ...c, status: 'Active' })));
  });

  app.post("/api/contracts/:id/withdraw", write, async (req, res) => {
    if (await isRemote()) {
      // This service owns no shipments/allocations data — replicate the reference guard locally
      // (against the monolith's own tables) before ever calling the remote withdraw route.
      const reason = await referencedByShipmentOrAllocation(req.params.id);
      if (reason) return err(res, `${reason} — use On Hold instead of withdrawing it to Draft`);
      try { return ok(res, await callContractService("POST", `/internal/contracts/${req.params.id}/withdraw`, {})); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [c] = await query("SELECT * FROM contracts WHERE id=$1", [req.params.id]);
    if (!c) return err(res, "Not found", 404);
    if (c.status !== "Active") return err(res, `Only an Active contract can be withdrawn to Draft (this one is ${c.status})`);
    const [shipmentInUse] = await query("SELECT id FROM shipments WHERE contract_id=$1 LIMIT 1", [req.params.id]);
    if (shipmentInUse) return err(res, "This contract is referenced by at least one shipment — use On Hold instead of withdrawing it to Draft");
    const [allocInUse] = await query("SELECT id FROM allocations WHERE contract_id=$1 LIMIT 1", [req.params.id]);
    if (allocInUse) return err(res, "This contract has a linked space configuration — use On Hold instead of withdrawing it to Draft");
    await query("UPDATE contracts SET status='Draft' WHERE id=$1", [req.params.id]);
    await logEntityEvent('contract', req.params.id, 'WITHDRAWN', 'status', 'Active', 'Draft',
      JSON.stringify({ contractNumber: c.contract_number, carrierCode: c.carrier_code }));
    ok(res, await withContractArrays(mapContract({ ...c, status: 'Draft' })));
  });

  app.get("/api/contracts/:id", async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callContractService("GET", `/internal/contracts/${req.params.id}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [c] = await query("SELECT * FROM contracts WHERE id=$1", [req.params.id]);
    if (!c) return err(res, "Not found", 404);
    const legs     = await query("SELECT * FROM contract_legs  WHERE contract_id=$1 ORDER BY leg_order", [req.params.id]);
    const rates    = await query("SELECT * FROM contract_rates WHERE contract_id=$1 ORDER BY sort_order", [req.params.id]);
    const routings = await query("SELECT * FROM contract_routings WHERE contract_id=$1 ORDER BY sort_order", [req.params.id]);
    ok(res, await withContractArrays({ ...mapContract(c), legs: legs.map(mapLeg), rates: rates.map(mapRate), routings: routings.map(mapContractRouting) }));
  });

  app.post("/api/contracts", write, async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callContractService("POST", "/internal/contracts", req.body), 201); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { contractNumber="", contractRef="", carrierCode="", namedAccountId="", namedAccount="",
            movementType="FCL", containerTypes=[], commodityTypes="", dgAllowed=false, imdgClasses=[],
            validFrom="", validTo="", currency="USD", status="Active", notes="",
            legs=[], rates=[], routings=[] } = req.body;
    const [dup] = await query("SELECT id FROM contracts WHERE contract_number=$1 AND contract_ref=$2 AND named_account_id=$3", [contractNumber, contractRef, namedAccountId]);
    if (dup) return err(res, `A contract with this number${contractRef ? ", reference" : ""}${namedAccountId ? ", and account" : ""} already exists (${dup.id})`);
    if (!CONTRACT_STATUSES.includes(status)) return err(res, `status must be one of: ${CONTRACT_STATUSES.join(", ")}`);
    const id = `CNTR-${uid()}`;
    const createdAt = new Date().toISOString();
    // Free text, no registry behind it — left blank means "no commodity restriction stated",
    // which is exactly what FAK ("Freight All Kinds") already means in the industry, so an
    // unfilled field defaults to it here rather than silently staying blank.
    const effCommodityTypes = (commodityTypes.trim() || "FAK").slice(0, 32);
    // container_types/imdg_classes no longer written here (TKT-5YYLNT) — saveContractContainerTypes/
    // saveContractImdgClasses below are the real write path now; the columns stay in the schema
    // (DEFAULT '[]', unused) rather than being dropped, matching this codebase's additive-only precedent.
    await query(`INSERT INTO contracts (id,contract_number,contract_ref,carrier_code,named_account_id,named_account,movement_type,dg_allowed,valid_from,valid_to,currency,status,notes,created_at,commodity_types)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [id, contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType,
           !!dgAllowed, validFrom, validTo, currency, status, notes, createdAt, effCommodityTypes]);
    await saveContractContainerTypes(id, containerTypes);
    await saveContractImdgClasses(id, imdgClasses);
    const routingIds = await saveRoutings(id, routings);
    await saveLegs(id, legs, routingIds);
    await saveRates(id, rates, routingIds);
    const [c]  = await query("SELECT * FROM contracts WHERE id=$1", [id]);
    const lgs  = await query("SELECT * FROM contract_legs  WHERE contract_id=$1 ORDER BY leg_order", [id]);
    const rts  = await query("SELECT * FROM contract_rates WHERE contract_id=$1 ORDER BY sort_order", [id]);
    const rtgs = await query("SELECT * FROM contract_routings WHERE contract_id=$1 ORDER BY sort_order", [id]);
    await logEntityEvent('contract', id, 'CREATED', null, null, null,
      JSON.stringify({ contractNumber, contractRef, carrierCode, validFrom, validTo, status }));
    ok(res, await withContractArrays({ ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate), routings: rtgs.map(mapContractRouting) }), 201);
  });

  app.put("/api/contracts/:id", write, async (req, res) => {
    if (await isRemote()) {
      try { return ok(res, await callContractService("PUT", `/internal/contracts/${req.params.id}`, req.body)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const { contractNumber="", contractRef="", carrierCode="", namedAccountId="", namedAccount="",
            movementType="FCL", containerTypes=[], commodityTypes="", dgAllowed=false, imdgClasses=[],
            validFrom="", validTo="", currency="USD", status="Active", notes="",
            legs=[], rates=[], routings=[] } = req.body;
    const effCommodityTypes = (commodityTypes.trim() || "FAK").slice(0, 32);
    const [dup] = await query("SELECT id FROM contracts WHERE contract_number=$1 AND contract_ref=$2 AND named_account_id=$3 AND id!=$4", [contractNumber, contractRef, namedAccountId, req.params.id]);
    if (dup) return err(res, `A contract with this number${contractRef ? ", reference" : ""}${namedAccountId ? ", and account" : ""} already exists (${dup.id})`);
    if (!CONTRACT_STATUSES.includes(status)) return err(res, `status must be one of: ${CONTRACT_STATUSES.join(", ")}`);
    // expireStaleContracts() (below) only ever flips Active -> Expired as validTo passes — it
    // never reverses that. Found live: a contract auto-expired that way stayed stuck showing
    // Expired forever even after its validTo was edited into the future, since the edit form
    // just resubmits whatever status it still had (untouched by the user) and this route wrote
    // it verbatim. Mirrors the sweep's own condition, inverted — only auto-revives when the
    // caller is still submitting status='Expired' itself; an explicit different choice (Draft,
    // On Hold) made in the same edit is never overridden.
    const today = new Date().toISOString().slice(0, 10);
    const effStatus = (status === 'Expired' && (!validTo || validTo >= today)) ? 'Active' : status;
    const [oldRow] = await query("SELECT * FROM contracts WHERE id=$1", [req.params.id]);
    const oldRates = await query("SELECT * FROM contract_rates WHERE contract_id=$1", [req.params.id]);
    // Resolved BEFORE saveContractContainerTypes/saveContractImdgClasses delete/regenerate them
    // below — oldRow.container_types/imdg_classes are frozen (TKT-5YYLNT), no longer reliable.
    const oldContainerTypes = await getContractContainerTypes(req.params.id);
    const oldImdgClasses = await getContractImdgClasses(req.params.id);
    // Old routings' id -> name, resolved BEFORE saveRoutings deletes/regenerates them below —
    // needed to give oldRates a stable routingName for logRateDiffs' content key (see its own
    // comment: routing_id itself never survives a save, so name is the only comparable identity).
    const oldRoutingsById = Object.fromEntries(
      (await query("SELECT id, name FROM contract_routings WHERE contract_id=$1", [req.params.id])).map(r => [r.id, r.name])
    );
    const updated = await query(`UPDATE contracts SET contract_number=$1,contract_ref=$2,carrier_code=$3,named_account_id=$4,named_account=$5,
      movement_type=$6,dg_allowed=$7,valid_from=$8,valid_to=$9,currency=$10,status=$11,notes=$12,commodity_types=$13
      WHERE id=$14 RETURNING id`,
      [contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType,
           !!dgAllowed, validFrom, validTo, currency, effStatus, notes, effCommodityTypes, req.params.id]);
    if (updated.length === 0) return err(res, "Not found", 404);
    await saveContractContainerTypes(req.params.id, containerTypes);
    await saveContractImdgClasses(req.params.id, imdgClasses);
    const routingIds = await saveRoutings(req.params.id, routings);
    // Fallback correlation for a leg/rate that carries a stale routingId but no routingIndex
    // (see resolveRoutingId's own comment) — maps the OLD routing's name to its position in
    // THIS save's routings[] payload, so a leg/rate that was in "Via Rotterdam" before still
    // lands in "Via Rotterdam" after, even if the caller never touched the routings themselves.
    const newIndexByName = {};
    routings.forEach((r, i) => { if (r.name && !(r.name in newIndexByName)) newIndexByName[r.name] = i; });
    await saveLegs(req.params.id, legs, routingIds, oldRoutingsById, newIndexByName);
    await saveRates(req.params.id, rates, routingIds, oldRoutingsById, newIndexByName);
    const [c]  = await query("SELECT * FROM contracts WHERE id=$1", [req.params.id]);
    const lgs  = await query("SELECT * FROM contract_legs  WHERE contract_id=$1 ORDER BY leg_order", [req.params.id]);
    const rts  = await query("SELECT * FROM contract_rates WHERE contract_id=$1 ORDER BY sort_order", [req.params.id]);
    const rtgs = await query("SELECT * FROM contract_routings WHERE contract_id=$1 ORDER BY sort_order", [req.params.id]);
    await logContractFieldDiffs(req.params.id, oldRow, { contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType, containerTypes, dgAllowed, imdgClasses, validFrom, validTo, currency, status: effStatus, notes }, oldContainerTypes, oldImdgClasses);
    const oldRatesWithRoutingName = oldRates.map(r => ({ ...r, routingName: oldRoutingsById[r.routing_id] || '' }));
    const newRatesWithRoutingName = rates.map(r => ({
      ...r,
      routingName: (Number.isInteger(r.routingIndex) && routings[r.routingIndex]) ? (routings[r.routingIndex].name || '') : '',
    }));
    await logRateDiffs(req.params.id, oldRatesWithRoutingName, newRatesWithRoutingName);
    ok(res, await withContractArrays({ ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate), routings: rtgs.map(mapContractRouting) }));
  });

  app.delete("/api/contracts/:id", write, async (req, res) => {
    if (await isRemote()) {
      const reason = await referencedByShipmentOrAllocation(req.params.id);
      if (reason) return err(res, `${reason} — set its status to Expired/On Hold instead of deleting`);
      try { return ok(res, await callContractService("DELETE", `/internal/contracts/${req.params.id}`)); }
      catch (e) { return err(res, e.message, e.status || 502); }
    }
    const [existing] = await query("SELECT * FROM contracts WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    // shipments.contract_id and allocations.contract_id both carry no FK constraint (SQLite
    // ADD COLUMN can't retrofit one onto live rows) — without this guard a delete here silently
    // orphans every shipment/space-config that still points at this id, and neither the contract
    // route-matching endpoints nor the contract-mismatch checks were ever built to handle a
    // vanished contract, only an Active/Draft/Expired one. Same "referenced — deactivate instead"
    // pattern routes/offices.js already uses for the identical class of problem.
    const [shipmentInUse] = await query("SELECT id FROM shipments WHERE contract_id=$1 LIMIT 1", [req.params.id]);
    if (shipmentInUse) return err(res, "This contract is referenced by at least one shipment — set its status to Expired/On Hold instead of deleting");
    const [allocInUse] = await query("SELECT id FROM allocations WHERE contract_id=$1 LIMIT 1", [req.params.id]);
    if (allocInUse) return err(res, "This contract has a linked space configuration — remove or reassign that configuration first");
    await query("DELETE FROM contracts WHERE id=$1", [req.params.id]);
    await logEntityEvent('contract', req.params.id, 'DELETED', null, null, null,
      JSON.stringify({ contractNumber: existing.contract_number, carrierCode: existing.carrier_code }));
    ok(res, { deleted: req.params.id });
  });

  // Entity events (shared endpoint — serves shipments via their own table, everything else via entity_events)
  app.get("/api/entity-events/:type/:id", async (req, res) => {
    if (req.params.type === 'shipment') {
      const rows = await query("SELECT * FROM shipment_events WHERE shipment_id=$1 ORDER BY occurred_at DESC", [req.params.id]);
      return ok(res, rows.map(r => ({
        id: r.id, entityType: 'shipment', entityId: r.shipment_id,
        eventType: r.event_type, field: r.field,
        oldValue: r.old_value, newValue: r.new_value,
        meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return r.meta; } })() : null,
        createdAt: r.occurred_at,
      })));
    }
    const rows = await query("SELECT * FROM entity_events WHERE entity_type=$1 AND entity_id=$2 ORDER BY created_at DESC", [req.params.type, req.params.id]);
    ok(res, rows.map(r => ({
      id: r.id, entityType: r.entity_type, entityId: r.entity_id,
      eventType: r.event_type, field: r.field,
      oldValue: r.old_value, newValue: r.new_value,
      meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return r.meta; } })() : null,
      createdAt: r.created_at,
    })));
  });
};
