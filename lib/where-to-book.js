"use strict";

// Where to book (Epic TKT-KFGL81, Story 2 TKT-BI1QS7; scope doc https://claude.ai/artifact/X9n2jk6TyGFKfbE7GsWKCy,
// approved with its mockup 2026-10-21). ONE answer to "where should this shipment be booked?", read by
// contract assignment (GET /api/where-to-book), the escalation alternatives (lib/booking-escalations.js)
// and the out-of-order check, so they can never disagree:
//   1. The line: the customer's own Lane Steering line for the trade lane on the ETD, else the line for
//      everyone (ctx.steeringFor). No line, no steered answer.
//   2. Each option in order is skipped (with the reason), full, or available. Its space is the space
//      configurations on its contract that fit the shipment (ctx.matchAllocations: route, ETD — its
//      week for weekly space —, loop, commodity): on a customer's line their own when they have some on
//      that contract, else its general space; on the line for everyone the customer's own first, then
//      everyone's. A contract that covers the route with no configuration for the shipment is order
//      only: available, no cap (decided 2026-10-21).
//   3. The pick: the first available option, on its first configuration with free space; a shipment
//      bigger than what's left stays there as an overbooking. Every option full: the first one not
//      skipped, as an overbooking (the waterfall agreed for Steering & Allocation, 2026-10-02).
// Free space = allocated − confirmed − pending (TKT-4JU8C8). Read-only: nothing is booked or saved.

module.exports = function createWhereToBook(ctx) {
  const { query, TEU_EXPR, FAK_COMMODITY } = ctx;
  const up = v => String(v || "").trim().toUpperCase();
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const fmtDate = d => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
  const freeOf = a => (Number(a.allocatedTEU) || 0) - (Number(a.confirmedTEU) || 0) - (Number(a.pendingTEU) || 0);
  // The same loop and commodity rules as ctx.matchAllocations.
  const fitsLoop = (a, loop) => !a.loopCode || !loop || a.loopCode === loop;
  const fitsCommodity = (a, commodity) => !a.commodityCode || a.commodityCode === FAK_COMMODITY || a.commodityCode === commodity;

  // Why a contract can't take the shipment ("" when it can). A contract the remote Contract
  // Management Service can't be asked about goes through, as the escalation alternatives always let it.
  async function contractProblem(c, { date, principalId, pol, pod, haulage }) {
    if (!c) return "the contract no longer exists";
    if (c.unreachable) return "";
    if (c.status && c.status !== "Active") return `the contract is ${c.status.toLowerCase()}`;
    if ((c.validFrom && date < c.validFrom) || (c.validTo && date > c.validTo)) return `the contract runs ${fmtDate(c.validFrom)} – ${fmtDate(c.validTo)}`;
    if (c.namedAccountId && c.namedAccountId !== principalId) return `named account ${c.namedAccount || c.namedAccountId}`;
    for (const l of c.lines) if ((await ctx.findMatchingContractLegs(l.legs, { pol, pod, ...haulage })).length) return "";
    return c.lines.length ? `it doesn't cover ${pol} → ${pod}` : "";
  }

  // The contract has space on the route, but none of it fits this shipment: say why.
  function spaceMismatch(configs, { loopCode, commodityCode }) {
    const loops = [...new Set(configs.map(a => a.loopCode).filter(Boolean))];
    if (loopCode && loops.length && configs.every(a => !fitsLoop(a, loopCode)))
      return `space for loop ${loops.join(", ")} only; this sailing is ${loopCode}`;
    const commodities = [...new Set(configs.map(a => a.commodityCode).filter(c => c && c !== FAK_COMMODITY))];
    return commodities.length ? `space for commodity ${commodities.join(", ")} only` : "its space doesn't fit this shipment";
  }

  // input: { customerId (the principal), pol, pod, etd, cargoReadyDate, commodityCode, loopCode, teu,
  //          needsPolHaulage, needsPodHaulage, pkuLocation, delLocation }
  async function whereToBook(input = {}) {
    const pol = up(input.pol), pod = up(input.pod);
    const date = String(input.etd || input.cargoReadyDate || "").slice(0, 10) || todayIso();
    const principalId = String(input.customerId || "");
    const loopCode = up(input.loopCode), commodityCode = String(input.commodityCode || "");
    const teu = Number(input.teu) || 0;
    const haulage = { needsPolHaulage: !!input.needsPolHaulage, needsPodHaulage: !!input.needsPodHaulage,
      pkuLocation: input.pkuLocation || "", delLocation: input.delLocation || "" };
    const originLane = pol ? ctx.longestLane?.(pol) || "" : "", destLane = pod ? ctx.longestLane?.(pod) || "" : "";
    const answer = { lane: originLane && destLane ? `${originLane} → ${destLane}` : "", originLane, destLane, date, teu, loopCode, line: null, options: [], pick: null };
    if (!pol || !pod || !originLane || !destLane) return answer;
    const line = ctx.steeringFor ? await ctx.steeringFor({ originLane, destLane, principalId, date }) : null;
    if (!line) return answer;
    answer.line = { id: line.id, customerId: line.customerId, customerName: line.customerName, validFrom: line.validFrom, validTo: line.validTo,
      autoSwitch: line.autoSwitch, note: line.note || "" };

    // Everything on the route for this customer on the date; loop and commodity are checked per option
    // below, so a mismatch can be named rather than the option simply having no space.
    const onRoute = await ctx.matchAllocations({ pol, pod, etd: date, principalId,
      ...(haulage.needsPolHaulage && { needsPolHaulage: "1" }), ...(haulage.needsPodHaulage && { needsPodHaulage: "1" }),
      ...(haulage.pkuLocation && { pkuLocation: haulage.pkuLocation }), ...(haulage.delLocation && { delLocation: haulage.delLocation }) });
    // A customer's own line books their own space on the option's contract when they have some there,
    // and never spills into the contract's general space once it's full; with none of their own, the
    // contract's general space (refined 2026-10-21 while building: reading only their own made such
    // an option uncapped, and broke the no-answer switch on a customer line over general space).
    const ownLine = !!line.customerId;
    for (const o of line.options) {
      const c = ctx.loadContract ? await ctx.loadContract(o.contractId) : null;
      const option = { rank: o.rank, carrierCode: o.carrierCode, contractId: o.contractId, contractNumber: o.contractNumber,
        contractRef: c && !c.unreachable ? c.info?.contractRef || "" : "", validTo: c && !c.unreachable ? c.validTo || "" : "", note: o.note || "",
        status: "available", reason: "", orderOnly: false, freeTeu: null, space: [] };
      const problem = await contractProblem(c, { date, principalId, pol, pod, haulage });
      if (problem) { answer.options.push({ ...option, status: "skipped", reason: problem }); continue; }
      const onThisContract = onRoute.filter(a => a.contractId === o.contractId);
      const own = ownLine ? onThisContract.filter(a => a.customerId === line.customerId) : [];
      const onContract = own.length ? own : onThisContract;
      const fitting = onContract.filter(a => fitsLoop(a, loopCode) && fitsCommodity(a, commodityCode));
      if (!fitting.length && onContract.length) {
        answer.options.push({ ...option, status: "skipped", reason: spaceMismatch(onContract, { loopCode, commodityCode }) });
        continue;
      }
      if (!fitting.length) { answer.options.push({ ...option, orderOnly: true }); continue; }
      // matchAllocations already puts the customer's own space first, then the newest period.
      const space = fitting.map(a => ({ id: a.id, allocatedTEU: a.allocatedTEU, confirmedTEU: a.confirmedTEU, pendingTEU: a.pendingTEU, freeTEU: freeOf(a),
        spaceBasis: a.spaceBasis, week: a.week || "", weekNumber: a.weekNumber ?? null, effectiveDate: a.effectiveDate, endDate: a.endDate,
        customerId: a.customerId, customerName: a.customerName, loopCode: a.loopCode, commodityCode: a.commodityCode, matchedRoutingId: a.matchedRoutingId || "" }));
      const free = space.reduce((n, s) => n + Math.max(0, s.freeTEU), 0);
      answer.options.push({ ...option, status: free > 0 ? "available" : "full", freeTeu: free, space });
    }

    const first = answer.options.find(o => o.status === "available");
    const fallback = first ? null : answer.options.find(o => o.status === "full");
    const chosen = first || fallback;
    if (chosen) {
      const on = chosen.orderOnly ? null : chosen.space.find(s => s.freeTEU > 0) || chosen.space[0];
      answer.pick = { rank: chosen.rank, carrierCode: chosen.carrierCode, contractId: chosen.contractId, contractNumber: chosen.contractNumber,
        allocationId: on?.id || "", routingId: on?.matchedRoutingId || "", orderOnly: chosen.orderOnly, freeTeu: on ? Math.max(0, on.freeTEU) : null,
        overbooking: !!on && teu > Math.max(0, on.freeTEU), allFull: !first };
    }
    return answer;
  }

  // The same answer for a saved shipment: its principal, route, ETD (else cargo-ready date), commodity,
  // TEU, the loop of its latest sailing, and the carrier haulage its Pick-up / Delivery legs ask for
  // (the rule deriveHaulageNeeds applies in the browser). opts.anyLoop: leave the loop out (an
  // escalation looks for another sailing, so the one that failed mustn't narrow it).
  async function forShipment(row, opts = {}) {
    const [{ teu } = { teu: 0 }] = await query(`SELECT COALESCE(SUM(${TEU_EXPR()}),0) AS teu FROM containers WHERE shipment_id=$1`, [row.id]);
    const legs = await query("SELECT leg_type, movement_type, pol, pod FROM shipment_legs WHERE shipment_id=$1 ORDER BY leg_order", [row.id]);
    const pku = legs[0]?.leg_type === "Pick-up" && legs[0]?.movement_type === "Carrier's Haulage" ? legs[0] : null;
    const last = legs[legs.length - 1];
    const del = last?.leg_type === "Delivery" && last?.movement_type === "Carrier's Haulage" ? last : null;
    const loopCode = opts.anyLoop || !ctx.shipmentLoopCode ? "" : await ctx.shipmentLoopCode(row.id);
    return whereToBook({ customerId: row.principal_id || "", pol: row.pol, pod: row.pod, etd: row.etd, cargoReadyDate: row.cargo_ready_date,
      commodityCode: row.commodity_code || "", loopCode, teu: Number(teu) || 0,
      ...(opts.noHaulage ? {} : { needsPolHaulage: !!pku, needsPodHaulage: !!del, pkuLocation: pku?.pol || "", delLocation: del?.pod || "" }) });
  }

  // ─── The steering verdict (Story 3 TKT-SQ5U6H) ─────────────────────────────────────────────────
  // Worked out and saved on the shipment whenever its contract or space is saved (never trusted from
  // a screen), because the space it was judged against changes afterwards. A verdict:
  //   steered        booked on the line, with no higher option that had space (all full: #1 or wherever)
  //   out_of_order   booked lower on the line while a higher option had space
  //   other_contract the carrier is on the line, the contract isn't, and an option had space
  //   other_carrier  a carrier that isn't on the line, while an option had space
  //   spot           bought SPOT while an option had space
  //   not_covered    no line for the lane and customer, or no option with space
  //   rebooked       moved down the line by an escalation or the no-answer switch (given by the caller)
  //   other_loop     its sailing left its space's loop, so the space was dropped (given by the caller)
  //   customer_own / no_contract   left out of the steering report
  // The reason the desk gave is kept for the not-followed ones (a reason is required on screen; the
  // server takes the booking either way: warn, never block).
  const NOT_FOLLOWED = ["out_of_order", "other_contract", "other_carrier", "spot"];
  const optionBrief = o => o ? { rank: o.rank, carrierCode: o.carrierCode, contractNumber: o.contractNumber, freeTeu: o.freeTeu, orderOnly: !!o.orderOnly } : null;

  async function judge(row) {
    const type = row.contract_type || "";
    if (type === "Customer Own") return { verdict: "customer_own" };
    if (type !== "SPOT" && (type !== "Central" || !row.contract_id)) return { verdict: "no_contract" };
    const answer = await forShipment(row);
    if (!answer.line) return { verdict: "not_covered", answer };
    const available = answer.options.filter(o => o.status === "available");
    const base = { answer, lineId: answer.line.id, options: answer.options.length };
    if (type === "SPOT") return { ...base, verdict: available.length ? "spot" : "not_covered", better: optionBrief(available[0]) };
    const booked = answer.options.find(o => o.contractId === row.contract_id);
    if (booked) {
      const higher = available.find(o => o.rank < booked.rank);
      return { ...base, verdict: higher ? "out_of_order" : "steered", rank: booked.rank, better: optionBrief(higher) };
    }
    if (!available.length) return { ...base, verdict: "not_covered" };
    return { ...base, verdict: answer.options.some(o => o.carrierCode === row.carrier_code) ? "other_contract" : "other_carrier", better: optionBrief(available[0]) };
  }

  // reasonOnly: the desk gave (or changed) its reason without changing the contract — the verdict
  // stands as judged when the contract was saved; only the reason changes.
  async function recordVerdict(shipmentId, { reason = "", verdict: given = "", actor = "", reasonOnly = false } = {}) {
    const [row] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    if (!row) return null;
    if (reasonOnly) {
      if (!NOT_FOLLOWED.includes(row.steering_verdict)) return { verdict: row.steering_verdict || "", reason: "" };
      const why = String(reason || "").trim().slice(0, 500);
      if (why !== (row.steering_reason || "")) {
        await query("UPDATE shipments SET steering_reason=$1 WHERE id=$2", [why, shipmentId]);
        await ctx.logEvent(shipmentId, "FIELD_UPDATED", "steering_reason", row.steering_reason || null, why || null, "", actor || "");
      }
      return { verdict: row.steering_verdict, reason: why };
    }
    const j = await judge(row);
    const verdict = given || j.verdict;
    const why = NOT_FOLLOWED.includes(verdict) ? String(reason || (verdict === row.steering_verdict ? row.steering_reason : "") || "").trim().slice(0, 500) : "";
    const pick = j.better || j.options ? JSON.stringify({ ...(j.better || {}), options: j.options || 0 }) : "";
    await query(`UPDATE shipments SET steering_line_id=$1, steering_verdict=$2, steering_rank=$3, steering_pick=$4, steering_reason=$5, steering_checked_at=$6 WHERE id=$7`,
      [j.lineId || "", verdict, j.rank ?? null, pick, why, new Date().toISOString(), shipmentId]);
    // The History says when a booking didn't follow the steering, with what it would have been.
    if (NOT_FOLLOWED.includes(verdict) && (verdict !== row.steering_verdict || why !== (row.steering_reason || ""))) {
      await ctx.logEvent(shipmentId, verdict === "out_of_order" ? "BOOKED_OUT_OF_ORDER" : "BOOKED_OFF_STEERING", "steering_verdict",
        row.steering_verdict || null, verdict, JSON.stringify({ lane: j.answer?.lane || "", lineId: j.lineId || "", bookedRank: j.rank ?? null,
          contract: row.contract_type === "SPOT" ? `SPOT ${row.contract_ref || ""}`.trim() : `${row.carrier_code} ${row.contract_ref || ""}`.trim(),
          better: j.better, reason: why }), actor || "");
    }
    return { verdict, rank: j.rank ?? null, better: j.better || null, reason: why };
  }

  return { whereToBook, forShipment, recordVerdict, NOT_FOLLOWED };
};
