"use strict";

// Lane steering (Epic TKT-ASIYFL, Story 5 TKT-SWD5LM; agreed 2026-10-20). The carrier order on a trade
// lane (origin trade → destination trade), for everyone or for one customer, over a validity window:
// options #1, #2, … each a carrier on one of its contracts. Escalation handlers are offered these first
// (lib/booking-escalations.js alternatives), and with auto_switch on an unanswered booking moves to the
// next option (Story 6). A lane with no steering falls back to the contract search, Central first.
// Master Data → Lane Steering; maintained ONLY by admins and Trade Managers (the user, 2026-10-20 — never
// by OCC/BK, OCC/AY or CCL/CO), readable by everyone.

module.exports = function laneSteeringRoutes(app, ctx) {
  const { query, transaction, ok, err, uid, requireRole, auth, logEntityEvent } = ctx;
  const write = requireRole(["admin", "trade_manager"]);
  const nowIso = () => new Date().toISOString();
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  const mapOption = r => ({ id: r.id, rank: r.rank, carrierCode: r.carrier_code, contractId: r.contract_id, contractNumber: r.contract_number || "", note: r.note || "" });
  const mapSteering = (r, options = []) => ({
    id: r.id, originLane: r.origin_lane, destLane: r.dest_lane, customerId: r.customer_id || "", customerName: r.customer_name || "",
    validFrom: r.valid_from, validTo: r.valid_to, autoSwitch: !!r.auto_switch, allowLinkedPorts: !!r.allow_linked_ports, note: r.note || "",
    createdByName: r.created_by_name || "", updatedByName: r.updated_by_name || "", createdAt: r.created_at, updatedAt: r.updated_at,
    options,
  });
  async function withOptions(rows) {
    if (!rows.length) return [];
    const ids = rows.map(r => r.id);
    const opts = await query(`SELECT * FROM lane_steering_options WHERE steering_id IN (${ids.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY rank`, ids);
    return rows.map(r => mapSteering(r, opts.filter(o => o.steering_id === r.id).map(mapOption)));
  }
  const describe = s => `${s.origin_lane ?? s.originLane} → ${s.dest_lane ?? s.destLane} for ${(s.customer_name ?? s.customerName) || "everyone"}`;

  // The steering that applies to a shipment on `date`: the customer's own first, then everyone's.
  // → mapped steering with its options, or null.
  async function steeringFor({ originLane, destLane, principalId = "", date }) {
    if (!originLane || !destLane || !date) return null;
    const rows = await query(`SELECT * FROM lane_steerings WHERE origin_lane=$1 AND dest_lane=$2 AND valid_from<=$3 AND valid_to>=$3
        AND (customer_id='' OR customer_id=$4) ORDER BY (customer_id='') ASC LIMIT 1`, [originLane, destLane, date, principalId || ""]);
    return rows.length ? (await withOptions(rows))[0] : null;
  }
  ctx.steeringFor = steeringFor;

  // Checks a create/update body → { value } or { error, status }.
  async function validate(body, excludeId = null) {
    const b = body || {};
    const originLane = String(b.originLane || "").trim().toUpperCase(), destLane = String(b.destLane || "").trim().toUpperCase();
    if (!originLane || !destLane) return { error: "Pick the origin and destination trades" };
    const known = new Set((await query("SELECT code FROM trade_lanes")).map(r => r.code));
    for (const code of [originLane, destLane]) if (!known.has(code)) return { error: `Unknown trade lane ${code}` };
    const validFrom = String(b.validFrom || "").slice(0, 10), validTo = String(b.validTo || "").slice(0, 10);
    if (!DATE.test(validFrom) || !DATE.test(validTo)) return { error: "Valid from and valid to are required" };
    if (validTo < validFrom) return { error: "Valid to must be on or after valid from" };
    const customerId = String(b.customerId || "").trim(), customerName = customerId ? String(b.customerName || "").trim() : "";

    const raw = Array.isArray(b.options) ? b.options : [];
    if (!raw.length) return { error: "Add at least one option" };
    const options = [], seen = new Set();
    for (const [i, o] of raw.entries()) {
      const carrierCode = String(o?.carrierCode || "").trim().toUpperCase(), contractId = String(o?.contractId || "").trim();
      if (!carrierCode || !contractId) return { error: `Option #${i + 1} needs a carrier and a contract` };
      if (seen.has(contractId)) return { error: `Option #${i + 1} repeats a contract already in the list` };
      seen.add(contractId);
      const c = ctx.loadContract ? await ctx.loadContract(contractId) : null;
      if (!c) return { error: `Option #${i + 1}: that contract doesn't exist` };
      if (c.unreachable) return { error: "The Contract Management Service can't be reached, so the contracts can't be checked — try again", status: 502 };
      if (c.carrierCode && c.carrierCode !== carrierCode) return { error: `Option #${i + 1}: ${c.contractNumber} is a ${c.carrierCode} contract, not ${carrierCode}` };
      options.push({ rank: i + 1, carrierCode, contractId, contractNumber: c.contractNumber || "", note: String(o?.note || "").trim().slice(0, 200) });
    }

    // One steering per lane and customer at a time, or which one applies would be a guess.
    const clash = (await query(`SELECT * FROM lane_steerings WHERE origin_lane=$1 AND dest_lane=$2 AND customer_id=$3
        AND valid_from<=$4 AND valid_to>=$5 AND id<>$6 LIMIT 1`, [originLane, destLane, customerId, validTo, validFrom, excludeId || ""]))[0];
    if (clash) return { error: `${describe(clash)} is already steered ${clash.valid_from} → ${clash.valid_to}: change that one, or pick dates that don't overlap`, status: 409 };

    return { value: { originLane, destLane, customerId, customerName, validFrom, validTo, autoSwitch: !!b.autoSwitch,
      allowLinkedPorts: !!b.allowLinkedPorts, options,
      note: String(b.note || "").trim().slice(0, 300) } };
  }

  async function saveOptions(tx, steeringId, options) {
    await tx.query("DELETE FROM lane_steering_options WHERE steering_id=$1", [steeringId]);
    for (const o of options)
      await tx.query("INSERT INTO lane_steering_options (id, steering_id, rank, carrier_code, contract_id, contract_number, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [`LSO-${uid()}`, steeringId, o.rank, o.carrierCode, o.contractId, o.contractNumber, o.note]);
  }
  const optionsText = options => options.map(o => `#${o.rank} ${o.carrierCode} ${o.contractNumber}`).join(", ");
  const loadOne = async id => (await withOptions(await query("SELECT * FROM lane_steerings WHERE id=$1", [id])))[0] || null;

  app.get("/api/lane-steerings", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM lane_steerings ORDER BY origin_lane, dest_lane, (customer_id='') DESC, customer_name, valid_from DESC");
    const list = await withOptions(rows);
    // Each option's contract validity and status, for the "Valid to" column (one lookup per contract),
    // and the space configurations on its contract that haven't ended — the space behind the option
    // (Where to book, Epic TKT-KFGL81).
    const contracts = new Map();
    const today = nowIso().slice(0, 10);
    const configs = await query("SELECT * FROM allocations WHERE end_date >= $1 ORDER BY effective_date", [today]);
    for (const s of list) for (const o of s.options) {
      if (!contracts.has(o.contractId)) contracts.set(o.contractId, ctx.loadContract ? await ctx.loadContract(o.contractId) : null);
      const c = contracts.get(o.contractId);
      o.contractValidTo = c && !c.unreachable ? c.validTo : "";
      o.contractStatus = !c ? "Missing" : c.unreachable ? "" : c.status || "";
      o.space = configs.filter(a => a.contract_id === o.contractId).map(a => ({ id: a.id, allocatedTEU: a.allocated_teu, spaceBasis: a.space_basis || "period",
        effectiveDate: a.effective_date, endDate: a.end_date, loopCode: a.loop_code || "", customerId: a.customer_id || "", customerName: a.customer_name || "",
        commodityCode: a.commodity_code || "", pol: a.pol || "", pod: a.pod || "" }));
    }
    ok(res, list);
  });

  app.post("/api/lane-steerings", write, async (req, res) => {
    const r = await validate(req.body);
    if (r.error) return err(res, r.error, r.status || 400);
    const v = r.value, id = `LST-${uid()}`, now = nowIso(), who = req.user?.name || req.user?.email || "";
    await transaction(async tx => {
      await tx.query(`INSERT INTO lane_steerings (id, origin_lane, dest_lane, customer_id, customer_name, valid_from, valid_to, auto_switch, note, created_by_name, updated_by_name, created_at, updated_at, allow_linked_ports)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$11,$12)`, [id, v.originLane, v.destLane, v.customerId, v.customerName, v.validFrom, v.validTo, v.autoSwitch, v.note, who, now, v.allowLinkedPorts]);
      await saveOptions(tx, id, v.options);
    });
    await logEntityEvent("lane_steering", id, "CREATED", null, null, null,
      JSON.stringify({ lane: `${v.originLane} → ${v.destLane}`, customer: v.customerName || "Everyone", validFrom: v.validFrom, validTo: v.validTo, autoSwitch: v.autoSwitch, allowLinkedPorts: v.allowLinkedPorts, options: optionsText(v.options), by: who }));
    ok(res, await loadOne(id), 201);
  });

  app.put("/api/lane-steerings/:id", write, async (req, res) => {
    const before = await loadOne(req.params.id);
    if (!before) return err(res, "Not found", 404);
    const r = await validate(req.body, req.params.id);
    if (r.error) return err(res, r.error, r.status || 400);
    const v = r.value, who = req.user?.name || req.user?.email || "";
    await transaction(async tx => {
      await tx.query(`UPDATE lane_steerings SET origin_lane=$1, dest_lane=$2, customer_id=$3, customer_name=$4, valid_from=$5, valid_to=$6, auto_switch=$7,
          note=$8, updated_by_name=$9, updated_at=$10, allow_linked_ports=$12 WHERE id=$11`,
        [v.originLane, v.destLane, v.customerId, v.customerName, v.validFrom, v.validTo, v.autoSwitch, v.note, who, nowIso(), req.params.id, v.allowLinkedPorts]);
      await saveOptions(tx, req.params.id, v.options);
    });
    const changes = [
      ["lane", `${before.originLane} → ${before.destLane}`, `${v.originLane} → ${v.destLane}`],
      ["customer", before.customerName || "Everyone", v.customerName || "Everyone"],
      ["valid", `${before.validFrom} → ${before.validTo}`, `${v.validFrom} → ${v.validTo}`],
      ["autoSwitch", String(before.autoSwitch), String(v.autoSwitch)],
      ["allowLinkedPorts", String(before.allowLinkedPorts), String(v.allowLinkedPorts)],
      ["options", optionsText(before.options), optionsText(v.options)],
      ["note", before.note || "", v.note],
    ].filter(([, a, b]) => a !== b);
    for (const [field, a, b] of changes) await logEntityEvent("lane_steering", req.params.id, "UPDATED", field, a, b, JSON.stringify({ by: who }));
    ok(res, await loadOne(req.params.id));
  });

  app.delete("/api/lane-steerings/:id", write, async (req, res) => {
    const before = await loadOne(req.params.id);
    if (!before) return err(res, "Not found", 404);
    await query("DELETE FROM lane_steerings WHERE id=$1", [req.params.id]);
    await logEntityEvent("lane_steering", req.params.id, "DELETED", null, null, null,
      JSON.stringify({ lane: `${before.originLane} → ${before.destLane}`, customer: before.customerName || "Everyone", options: optionsText(before.options), by: req.user?.name || req.user?.email || "" }));
    ok(res, { deleted: req.params.id });
  });
};
