"use strict";

module.exports = function contractsRoutes(app, ctx) {
  const { db, ok, err, uid, requireRole, mapContract, mapLeg, mapRate, logEntityEvent, toUsd, findMatchingContractLeg } = ctx;

  // Contracts are full-CRUD for trade_manager alongside admin/operator — previously these
  // write routes had no role gate at all (any authenticated user, including viewer, could write).
  const write = requireRole(["admin", "operator", "trade_manager"]);

  function saveLegs(contractId, legs) {
    db.prepare("DELETE FROM contract_legs WHERE contract_id=?").run(contractId);
    legs.forEach((l, i) => {
      const legId = `CLEG-${uid()}`;
      db.prepare(`INSERT INTO contract_legs (id,contract_id,leg_order,pol,pol_name,pod,pod_name,transit_days,vessel_service,pol_linked_allowed,pod_linked_allowed,pol_carrier_haulage,pod_carrier_haulage,pol_haulage_locations,pod_haulage_locations,pol_loc_type,pod_loc_type)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(legId, contractId, i, l.pol||"", l.polName||"", l.pod||"", l.podName||"", l.transitDays||0, l.vesselService||"",
             l.polLinkedAllowed ? 1 : 0, l.podLinkedAllowed ? 1 : 0,
             l.polCarrierHaulage ? 1 : 0, l.podCarrierHaulage ? 1 : 0,
             l.polHaulageLocations || "", l.podHaulageLocations || "",
             l.polLocType || 'Terminal', l.podLocType || 'Terminal');
    });
  }

  async function saveRates(contractId, rates) {
    db.prepare("DELETE FROM contract_rates WHERE contract_id=?").run(contractId);
    for (let i = 0; i < rates.length; i++) {
      const r   = rates[i];
      const usd = await toUsd(r.amount || 0, r.currency || "USD");
      const rateId = `RATE-${uid()}`;
      db.prepare(`INSERT INTO contract_rates (id,contract_id,service_code,description,amount,currency,amount_usd,unit,container_type,sort_order,notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(rateId, contractId, r.serviceCode||"", r.description||"", r.amount||0, r.currency||"USD", usd,
             r.unit||"per_container", r.containerType||"", i, r.notes||"");
    }
  }

  // Contract typeahead — MUST be before /api/contracts/:id
  app.get("/api/contracts/search", (req, res) => {
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
  // this endpoint would have to re-parse — see findMatchingContractLeg in server.js, shared
  // with /api/allocations/match so a contract and its own space-config allocations are judged
  // by the identical rule. Deliberately NOT shared with GET /api/contracts (#schedules search).
  app.get("/api/contracts/match", (req, res) => {
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
      const match = findMatchingContractLeg(legs, { pol, pod, needsPolHaulage: needsPol, needsPodHaulage: needsPod, pkuLocation, delLocation });
      if (!match) continue;
      // matchedLegs is the specific contiguous run that satisfied the query — NOT the
      // contract's full leg list, which may include unrelated alternate lanes (see
      // findMatchingContractLeg). Callers that chain into a sailing search after picking
      // this contract need matchedLegs' own first pol/last pod, not the shipment's generic
      // SEA-leg span, so the search reflects the specific route this contract was rated for.
      results.push({ ...mapContract(c), legs: legs.map(mapLeg), matchedLegs: match.legs.map(mapLeg),
        matchKind: match.matchKind,
        linkedPolVia: match.firstLeg.pol !== polU ? match.firstLeg.pol : null,
        linkedPodVia: match.lastLeg.pod !== podU ? match.lastLeg.pod : null });
    }

    if (results.length > 0) {
      const ids = results.map(r => r.id);
      const allRates = db.prepare(`SELECT * FROM contract_rates WHERE contract_id IN (${ids.map(() => "?").join(",")}) ORDER BY sort_order`).all(...ids);
      const ratesById = {};
      for (const r of allRates) (ratesById[r.contract_id] = ratesById[r.contract_id] || []).push(mapRate(r));
      for (const c of results) c.rates = ratesById[c.id] || [];
    }

    ok(res, results);
  });

  app.get("/api/contracts", (req, res) => {
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
    let legsMap = {}, ratesMap = {};
    if (ids.length > 0) {
      const ph = ids.map(() => '?').join(',');
      db.prepare(`SELECT * FROM contract_legs  WHERE contract_id IN (${ph}) ORDER BY leg_order`).all(...ids)
        .forEach(l => { (legsMap[l.contract_id]  = legsMap[l.contract_id]  || []).push(mapLeg(l)); });
      db.prepare(`SELECT * FROM contract_rates WHERE contract_id IN (${ph}) ORDER BY sort_order`).all(...ids)
        .forEach(r => { (ratesMap[r.contract_id] = ratesMap[r.contract_id] || []).push(mapRate(r)); });
    }
    ok(res, { results: rows.map(r => ({ ...mapContract(r), legs: legsMap[r.id] || [], rates: ratesMap[r.id] || [] })), total, limit: lim, offset: off });
  });

  // Pending-contract revalidation — MUST be before /api/contracts/:id
  app.get("/api/contracts/revalidate", (req, res) => {
    const { ref = "" } = req.query;
    if (!ref.trim()) return ok(res, []);
    const rows = db.prepare("SELECT * FROM contracts WHERE LOWER(contract_number) = LOWER(?) AND status = 'Active' ORDER BY valid_from DESC").all(ref.trim());
    ok(res, rows.map(mapContract));
  });

  app.get("/api/contracts/:id", (req, res) => {
    const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
    if (!c) return err(res, "Not found", 404);
    const legs  = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(req.params.id);
    const rates = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
    ok(res, { ...mapContract(c), legs: legs.map(mapLeg), rates: rates.map(mapRate) });
  });

  app.post("/api/contracts", write, async (req, res) => {
    const { contractNumber="", contractRef="", carrierCode="", namedAccountId="", namedAccount="",
            movementType="FCL", containerTypes=[], dgAllowed=false, imdgClasses=[],
            validFrom="", validTo="", currency="USD", status="Active", notes="",
            legs=[], rates=[] } = req.body;
    const dup = db.prepare("SELECT id FROM contracts WHERE contract_number=? AND contract_ref=? AND named_account_id=?").get(contractNumber, contractRef, namedAccountId);
    if (dup) return err(res, `A contract with this number${contractRef ? ", reference" : ""}${namedAccountId ? ", and account" : ""} already exists (${dup.id})`);
    const id = `CNTR-${uid()}`;
    const createdAt = new Date().toISOString();
    db.prepare(`INSERT INTO contracts (id,contract_number,contract_ref,carrier_code,named_account_id,named_account,movement_type,container_types,dg_allowed,imdg_classes,valid_from,valid_to,currency,status,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType,
           JSON.stringify(containerTypes), dgAllowed ? 1 : 0, JSON.stringify(imdgClasses),
           validFrom, validTo, currency, status, notes, createdAt);
    saveLegs(id, legs);
    await saveRates(id, rates);
    const c   = db.prepare("SELECT * FROM contracts WHERE id=?").get(id);
    const lgs = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(id);
    const rts = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(id);
    logEntityEvent('contract', id, 'CREATED', null, null, null,
      JSON.stringify({ contractNumber, contractRef, carrierCode, validFrom, validTo, status }));
    ok(res, { ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate) }, 201);
  });

  app.put("/api/contracts/:id", write, async (req, res) => {
    const { contractNumber="", contractRef="", carrierCode="", namedAccountId="", namedAccount="",
            movementType="FCL", containerTypes=[], dgAllowed=false, imdgClasses=[],
            validFrom="", validTo="", currency="USD", status="Active", notes="",
            legs=[], rates=[] } = req.body;
    const dup = db.prepare("SELECT id FROM contracts WHERE contract_number=? AND contract_ref=? AND named_account_id=? AND id!=?").get(contractNumber, contractRef, namedAccountId, req.params.id);
    if (dup) return err(res, `A contract with this number${contractRef ? ", reference" : ""}${namedAccountId ? ", and account" : ""} already exists (${dup.id})`);
    const info = db.prepare(`UPDATE contracts SET contract_number=?,contract_ref=?,carrier_code=?,named_account_id=?,named_account=?,
      movement_type=?,container_types=?,dg_allowed=?,imdg_classes=?,valid_from=?,valid_to=?,currency=?,status=?,notes=?
      WHERE id=?`)
      .run(contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType,
           JSON.stringify(containerTypes), dgAllowed ? 1 : 0, JSON.stringify(imdgClasses),
           validFrom, validTo, currency, status, notes, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    saveLegs(req.params.id, legs);
    await saveRates(req.params.id, rates);
    const c   = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
    const lgs = db.prepare("SELECT * FROM contract_legs  WHERE contract_id=? ORDER BY leg_order").all(req.params.id);
    const rts = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
    logEntityEvent('contract', req.params.id, 'UPDATED', null, null, null,
      JSON.stringify({ contractNumber, contractRef, carrierCode, validFrom, validTo, status }));
    ok(res, { ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate) });
  });

  app.delete("/api/contracts/:id", write, (req, res) => {
    const existing = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
    const info = db.prepare("DELETE FROM contracts WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    if (existing) logEntityEvent('contract', req.params.id, 'DELETED', null, null, null,
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
