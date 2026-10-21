"use strict";

// Booking escalations (Epic TKT-ASIYFL; agreed with the user 2026-10-20, modelled on their K+N process;
// mockup https://claude.ai/artifact/FXrT7utJNRgPabknbKyPmR).
//
// A booking the carrier rejects, confirms with changes, or leaves without a decision for the no-answer
// time can be escalated. OCC/BK picks the group: OCC/AY of the shipment's export office (the default,
// App Settings) or CCL/CO of its import office. They find an alternative — it goes back to OCC/BK as
// instructions, and OCC/BK books as instructed — hand it over to each other, or escalate it to Trade/AY
// of the lane. Trade/AY gives an alternative, marks the booking impossible, sends it back, or (with the
// Trade level on) escalates it to the lane's Trade Managers, who can only add messages and send it back.
// There is no separate section: everything happens on the shipment's Booking & Review page, found
// through the Shipments list's Booking column and the notification bell.
//
// Who may act as a role on a shipment (canActAs): admin and operator always; OCC/BK and OCC/AY from the
// shipment's export side, CCL/CO from its import side (officeSideOf), Trade/AY and Trade by trade lane.

const { mainLegIndex } = require("./mainLeg");
const { confirmedSailing } = require("./carrier-confirmation");

module.exports = function createBookingEscalations(ctx) {
  const { query, uid, getSettings, mapShipment, officeSideOf, matchesScopeItem, logEvent, isUniqueViolation } = ctx;

  const ACTIVE = ["open", "instructed"];
  const ROLE_LABEL = { occ_bk: "OCC/BK", occ_ay: "OCC/AY", ccl_co: "CCL/CO", trade_ay: "Trade/AY", trade_manager: "Trade", system: "CargoDesk" };
  const TRIGGER_LABEL = { rejected: "Rejected by the carrier", changed: "Confirmed with changes", no_answer: "No answer from the carrier" };
  const REASONS = {
    no_space: "No space on the requested sailing", later_sailing: "Carrier moved it to a later sailing",
    equipment: "Equipment not available", rate: "Rate or contract problem", no_answer: "No answer from the carrier", other: "Other",
  };
  const ACTIONS = ["hand_over", "escalate", "send_back", "instruct", "impossible", "question", "message", "withdraw"];
  const fail = (status, error) => ({ ok: false, status, error });
  const nowIso = () => new Date().toISOString();

  // ─── Settings (App Settings → Bookings → Escalations) ──────────────────────────────────────────
  async function settings() {
    const s = await getSettings();
    let rules = {};
    try { rules = JSON.parse(s.booking_change_rules || "{}"); } catch { rules = {}; }
    const hours = Number(s.booking_no_answer_hours);
    return {
      defaultGroup: ["occ_ay", "ccl_co"].includes(s.booking_escalation_default_group) ? s.booking_escalation_default_group : "occ_ay",
      noAnswerHours: Number.isFinite(hours) && hours > 0 ? hours : 2,
      tradeLevel: s.booking_escalation_trade_level !== "false",
      changeRules: {
        vessel: rules.vessel !== false, dates: rules.dates !== false, equipment: rules.equipment !== false, ports: rules.ports !== false,
        toleranceDays: Number.isFinite(Number(rules.toleranceDays)) ? Number(rules.toleranceDays) : 1,
      },
    };
  }

  // ─── Who may act as which role ─────────────────────────────────────────────────────────────────
  // The roles the caller acts with: an X-Active-Role it really holds narrows it to that one role (the
  // app's role switcher), otherwise every role in its token.
  function rolesOf(user, req) {
    const roles = Array.isArray(user?.roles) ? user.roles : (user?.role ? [user.role] : []);
    const active = req?.headers?.["x-active-role"];
    return active && roles.includes(active) ? [active] : roles;
  }
  // Trade lanes in scope; none configured means every lane (same rule as shipment visibility).
  async function laneOk(user, shipment) {
    const items = await query("SELECT * FROM user_scope_items WHERE user_id=$1 AND item_type='trade_lane' AND COALESCE(excluded, FALSE)=FALSE", [user.id]);
    return !items.length || items.some(i => matchesScopeItem(shipment, i));
  }
  async function canActAs(user, req, role, shipment) {
    if (!user) return false;
    const roles = rolesOf(user, req);
    if (roles.includes("admin") || roles.includes("operator")) return true;
    if (!roles.includes(role)) return false;
    if (role === "occ_bk" || role === "occ_ay") return ["export", "unrestricted"].includes(await officeSideOf(user, shipment, req));
    if (role === "ccl_co") return ["import", "unrestricted"].includes(await officeSideOf(user, shipment, req));
    if (role === "trade_ay" || role === "trade_manager") return laneOk(user, shipment);
    return false;
  }

  // ─── What can be escalated ─────────────────────────────────────────────────────────────────────
  const hasChanges = b => !!(b?.changed_fields && b.changed_fields !== "[]");
  function triggerFor(b, cfg) {
    if (!b) return null;
    if (b.status === "Rejected") return "rejected";
    if (b.status === "Confirmed" && hasChanges(b)) return "changed";
    if (b.status === "Pending" && !b.decided_at && b.requested_at
      && Date.now() - Date.parse(b.requested_at) >= cfg.noAnswerHours * 3600e3) return "no_answer";
    return null;
  }

  // ─── Accepted with changes (Story 6) ───────────────────────────────────────────────────────────
  // A DCSA booking as the carrier holds it once CONFIRMED: the request it answered (vessel,
  // carrierExportVoyageNumber, expectedDepartureDate, requestedEquipments, shipmentLocations) beside
  // what the carrier confirmed (transportPlan, confirmedEquipments). The request has no arrival date,
  // so the confirmed arrival is checked against requestedEta, the shipment's ETA when the request was
  // sent (carrier_bookings.requested_eta). → the differences the change rules (App Settings) count, as
  // [{ field, label, requested, confirmed }]; [] when confirmed as asked.
  const locCode = l => String(l?.UNLocationCode || l?.locationName || "").trim().toUpperCase();
  const same = (a, b) => String(a || "").trim().toUpperCase() === String(b || "").trim().toUpperCase();
  const tally = list => {
    const n = {};
    for (const e of list || []) n[e.ISOEquipmentCode] = (n[e.ISOEquipmentCode] || 0) + (Number(e.units) || 0);
    return Object.entries(n).sort(([a], [b]) => a.localeCompare(b)).map(([code, units]) => `${units} × ${code}`).join(", ");
  };
  const daysApart = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 864e5;
  function confirmationChanges(dcsa, rules, { requestedEta = "" } = {}) {
    const plan = (Array.isArray(dcsa?.transportPlan) ? [...dcsa.transportPlan] : [])
      .sort((a, b) => (a.transportPlanStageSequenceNumber || 0) - (b.transportPlanStageSequenceNumber || 0));
    if (!plan.length) return [];
    const sea = plan.filter(l => l.transportPlanStage === "MNC");
    const main = sea.length ? sea : plan;
    const first = main[0], last = main[main.length - 1];
    // The requested vessel is the shipment's main vessel (lib/mainLeg.js), so it's compared with the
    // carrier's main leg: a plan that starts on a feeder isn't a vessel change by itself.
    const mainLeg = main[mainLegIndex(main.map(l => ({ etd: l.plannedDepartureDate, eta: l.plannedArrivalDate })))] || first;
    const where = code => (dcsa.shipmentLocations || []).find(l => l.locationTypeCode === code)?.location;
    const out = [];
    if (rules.vessel) {
      const vessel = dcsa.vessel?.name && mainLeg.vesselName && !same(dcsa.vessel.name, mainLeg.vesselName);
      const voyage = dcsa.carrierExportVoyageNumber && mainLeg.carrierExportVoyageNumber && !same(dcsa.carrierExportVoyageNumber, mainLeg.carrierExportVoyageNumber);
      if (vessel || voyage) out.push({ field: "vessel", label: "Vessel / voyage",
        requested: [dcsa.vessel?.name, dcsa.carrierExportVoyageNumber].filter(Boolean).join(" · "),
        confirmed: [mainLeg.vesselName, mainLeg.carrierExportVoyageNumber].filter(Boolean).join(" · ") });
    }
    if (rules.dates && dcsa.expectedDepartureDate && first.plannedDepartureDate && daysApart(dcsa.expectedDepartureDate, first.plannedDepartureDate) > rules.toleranceDays)
      out.push({ field: "dates", label: "Departure", requested: dcsa.expectedDepartureDate, confirmed: first.plannedDepartureDate });
    const eta = String(requestedEta || "").slice(0, 10);
    if (rules.dates && eta && last.plannedArrivalDate && daysApart(eta, last.plannedArrivalDate) > rules.toleranceDays)
      out.push({ field: "arrival", label: "Arrival", requested: eta, confirmed: last.plannedArrivalDate });
    if (rules.equipment) {
      const asked = tally(dcsa.requestedEquipments), got = tally(dcsa.confirmedEquipments);
      if (asked && got && asked !== got) out.push({ field: "equipment", label: "Equipment", requested: asked, confirmed: got });
    }
    if (rules.ports) {
      const pol = locCode(where("POL")), pod = locCode(where("POD")), load = locCode(first.loadLocation), discharge = locCode(last.dischargeLocation);
      if ((pol && load && pol !== load) || (pod && discharge && pod !== discharge))
        out.push({ field: "ports", label: "Ports", requested: `${pol} → ${pod}`, confirmed: `${load} → ${discharge}` });
    }
    return out;
  }
  const changesOf = b => { try { return b?.changed_fields ? JSON.parse(b.changed_fields) : []; } catch { return []; } };
  const changesText = list => list.map(c => `${c.label} ${c.requested} → ${c.confirmed}`).join("; ");

  // ─── Rows ──────────────────────────────────────────────────────────────────────────────────────
  function mapEscalation(r) {
    if (!r) return null;
    let instruction = null, sailing = null;
    try { instruction = r.instruction ? JSON.parse(r.instruction) : null; } catch { instruction = null; }
    try { sailing = r.sailing ? JSON.parse(r.sailing) : null; } catch { sailing = null; }
    return {
      id: r.id, shipmentId: r.shipment_id, bookingId: r.booking_id || "", carrierCode: r.carrier_code || "",
      trigger: r.trigger, triggerLabel: TRIGGER_LABEL[r.trigger] || r.trigger,
      reasonCode: r.reason_code || "", reasonLabel: REASONS[r.reason_code] || "", note: r.note || "",
      status: r.status, active: ACTIVE.includes(r.status),
      holderRole: r.holder_role, holderLabel: ROLE_LABEL[r.holder_role] || r.holder_role, holderSince: r.holder_since,
      instructedByRole: r.instructed_by_role || "", instruction, sailing, impossibleReason: r.impossible_reason || "",
      automatic: !!r.automatic, createdByName: r.created_by_name || "", createdAt: r.created_at, updatedAt: r.updated_at,
      closedAt: r.closed_at || null, closedByName: r.closed_by_name || "",
    };
  }
  function mapStep(r) {
    let data = null;
    try { data = r.data ? JSON.parse(r.data) : null; } catch { data = null; }
    return {
      id: r.id, escalationId: r.escalation_id, action: r.action,
      fromRole: r.from_role || "", fromLabel: ROLE_LABEL[r.from_role] || "", toRole: r.to_role || "", toLabel: ROLE_LABEL[r.to_role] || "",
      message: r.message || "", data, actorName: r.actor_name || "", actorRole: r.actor_role || "", createdAt: r.created_at,
    };
  }
  const activeRow = async shipmentId =>
    (await query("SELECT * FROM booking_escalations WHERE shipment_id=$1 AND status IN ('open','instructed')", [shipmentId]))[0] || null;
  const latestRow = async shipmentId =>
    (await query("SELECT * FROM booking_escalations WHERE shipment_id=$1 ORDER BY created_at DESC LIMIT 1", [shipmentId]))[0] || null;
  const stepsOf = async escalationId =>
    (await query("SELECT * FROM booking_escalation_steps WHERE escalation_id=$1 ORDER BY created_at, id", [escalationId])).map(mapStep);

  // Where the holder sits: the export office for OCC/BK and OCC/AY, the import office for CCL/CO,
  // the trade lane for Trade/AY and Trade.
  async function holderPlace(role, shipment) {
    const officeName = async id => id ? ((await query("SELECT name FROM offices WHERE id=$1", [id]))[0]?.name || "") : "";
    if (role === "occ_bk" || role === "occ_ay") return officeName(shipment.emoOfficeId);
    if (role === "ccl_co") return officeName(shipment.imoOfficeId);
    if (role === "trade_ay" || role === "trade_manager") return shipment.tradeLane || "";
    return "";
  }

  async function addStep(esc, { action, fromRole = "", toRole = "", message = "", data = null, user = null, actorRole = "" }) {
    const actorName = user ? (user.name || user.email || "") : "CargoDesk";
    await query(`INSERT INTO booking_escalation_steps (id, escalation_id, shipment_id, action, from_role, to_role, message, data, actor_id, actor_name, actor_role, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [`ESS-${uid()}`, esc.id, esc.shipment_id, action, fromRole, toRole, message, data ? JSON.stringify(data) : "", user?.id || "", actorName, actorRole, nowIso()]);
    // The shipment's History shows every step (actor by name, as everywhere since 2026-09).
    await logEvent(esc.shipment_id, `ESCALATION_${action.toUpperCase()}`, "booking_escalation",
      ROLE_LABEL[fromRole] || fromRole || null, ROLE_LABEL[toRole] || toRole || null,
      JSON.stringify({ escalationId: esc.id, message, ...(data || {}) }), actorName);
  }

  async function update(id, fields) {
    const keys = Object.keys(fields);
    await query(`UPDATE booking_escalations SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(", ")}, updated_at=$${keys.length + 1} WHERE id=$${keys.length + 2}`,
      [...keys.map(k => fields[k]), nowIso(), id]);
    return (await query("SELECT * FROM booking_escalations WHERE id=$1", [id]))[0];
  }

  // The sailing on the shipment right now, as the carrier was asked for it, and what the carrier changed
  // when it confirmed with changes.
  async function sailingOf(shipmentId, booking = null) {
    const [s] = await query("SELECT contract_ref, vessel, voyage, etd, eta FROM shipments WHERE id=$1", [shipmentId]);
    const changes = booking?.status === "Confirmed" ? changesOf(booking) : [];
    return JSON.stringify({ contractRef: s?.contract_ref || "", vessel: s?.vessel || "", voyage: s?.voyage || "",
      etd: String(s?.etd || "").slice(0, 10), eta: String(s?.eta || "").slice(0, 10), ...(changes.length ? { changes } : {}) });
  }

  // ─── Escalate (OCC/BK, or CargoDesk itself for no answer) ──────────────────────────────────────
  async function create({ shipmentId, toRole, reasonCode = "", note = "", user = null, automatic = false }) {
    const cfg = await settings();
    const [b] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipmentId]);
    const trigger = triggerFor(b, cfg);
    if (!trigger) return fail(409, "There's nothing to escalate: the carrier hasn't rejected this booking, changed it, or left it unanswered");
    if (await activeRow(shipmentId)) return fail(409, "This booking is already escalated");
    const to = toRole || cfg.defaultGroup;
    if (!["occ_ay", "ccl_co"].includes(to)) return fail(400, "Escalate to OCC/AY or CCL/CO");
    if (reasonCode && !REASONS[reasonCode]) return fail(400, `Unknown reason "${reasonCode}"`);
    const id = `ESC-${uid()}`, now = nowIso();
    try {
      await query(`INSERT INTO booking_escalations (id, shipment_id, booking_id, carrier_code, trigger, reason_code, note, status, holder_role, holder_since,
          automatic, created_by, created_by_name, created_at, updated_at, sailing)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$10,$11,$12,$9,$9,$13)`,
        [id, shipmentId, b.id, b.carrier_code || "", trigger, reasonCode || (trigger === "no_answer" ? "no_answer" : ""), String(note || "").trim(),
         to, now, !!automatic, user?.id || "", user ? (user.name || user.email || "") : "CargoDesk", await sailingOf(shipmentId, b)]);
    } catch (e) {
      if (isUniqueViolation?.(e)) return fail(409, "This booking is already escalated");
      throw e;
    }
    const [esc] = await query("SELECT * FROM booking_escalations WHERE id=$1", [id]);
    await addStep(esc, { action: "escalated", fromRole: automatic ? "system" : "occ_bk", toRole: to, message: esc.note,
      data: { trigger, reasonCode: esc.reason_code }, user, actorRole: automatic ? "system" : "occ_bk" });
    return { ok: true, escalation: mapEscalation(esc) };
  }

  // ─── Act on an escalation ──────────────────────────────────────────────────────────────────────
  const INSTRUCTION_KEYS = ["carrierCode", "contractId", "contractNumber", "allocationId", "source", "rank"];
  function cleanInstruction(raw) {
    if (!raw || typeof raw !== "object") return null;
    const carrierCode = String(raw.carrierCode || "").trim().toUpperCase();
    const s = raw.sailing || {};
    const code = v => String(v || "").trim().toUpperCase();
    const sailing = {
      vesselName: String(s.vesselName || "").trim(), voyageNumber: String(s.voyageNumber || "").trim(),
      etd: String(s.etd || "").slice(0, 10), eta: String(s.eta || "").slice(0, 10), service: String(s.service || "").trim(),
      transitDays: Number.isFinite(Number(s.transitDays)) ? Number(s.transitDays) : null,
      pol: code(s.pol), pod: code(s.pod),
    };
    if (!/^[A-Z0-9]{2,6}$/.test(carrierCode) || !/^\d{4}-\d{2}-\d{2}$/.test(sailing.etd) || !sailing.vesselName) return null;
    // A transshipment sailing carries its legs in sailing order (feeder, main, feeder); vesselName is
    // its main vessel (lib/mainLeg.js). Book As Instructed rebuilds the shipment's sea legs from them.
    if (Array.isArray(s.legs) && s.legs.length > 1) {
      sailing.legs = s.legs.map(l => ({ pol: code(l.pol), pod: code(l.pod), vesselName: String(l.vesselName || "").trim(),
        voyageNumber: String(l.voyageNumber || "").trim(), etd: String(l.etd || "").slice(0, 10), eta: String(l.eta || "").slice(0, 10),
        service: String(l.service || "").trim() }));
      if (sailing.legs.some(l => !l.pol || !l.pod || !l.vesselName || !/^\d{4}-\d{2}-\d{2}$/.test(l.etd))) return null;
    }
    const out = Object.fromEntries(INSTRUCTION_KEYS.map(k => [k, raw[k] ?? ""]));
    return { ...out, carrierCode, sailing };
  }

  async function act(escalationId, body, user, req) {
    const { action, toRole = "", message = "", instruction = null, reason = "" } = body || {};
    if (!ACTIONS.includes(action)) return fail(400, `Unknown action "${action}"`);
    const [esc] = await query("SELECT * FROM booking_escalations WHERE id=$1", [escalationId]);
    if (!esc) return fail(404, "Escalation not found");
    if (!ACTIVE.includes(esc.status)) return fail(409, "This escalation is closed");
    const [row] = await query("SELECT * FROM shipments WHERE id=$1", [esc.shipment_id]);
    const shipment = mapShipment(row);
    const cfg = await settings();
    const holder = esc.holder_role;
    const msg = String(message || "").trim();
    const asHolder = () => canActAs(user, req, holder, shipment);
    const isOpen = esc.status === "open";
    const now = nowIso();
    let next;

    if (action === "hand_over") {
      if (!isOpen || !["occ_ay", "ccl_co"].includes(holder)) return fail(409, "Only OCC/AY and CCL/CO hand an escalation over to each other");
      if (!(await asHolder())) return fail(403, `Only ${ROLE_LABEL[holder]} of this shipment can hand it over`);
      const to = holder === "occ_ay" ? "ccl_co" : "occ_ay";
      next = await update(esc.id, { holder_role: to, holder_since: now });
      await addStep(esc, { action, fromRole: holder, toRole: to, message: msg, user, actorRole: holder });
    } else if (action === "escalate") {
      const to = ["occ_ay", "ccl_co"].includes(holder) ? "trade_ay" : holder === "trade_ay" && cfg.tradeLevel ? "trade_manager" : null;
      if (!isOpen || !to) return fail(409, holder === "trade_ay" ? "The Trade level is off (App Settings → Bookings)" : `${ROLE_LABEL[holder]} can't escalate this further`);
      if (!(await asHolder())) return fail(403, `Only ${ROLE_LABEL[holder]} of this shipment can escalate it`);
      next = await update(esc.id, { holder_role: to, holder_since: now });
      await addStep(esc, { action, fromRole: holder, toRole: to, message: msg, user, actorRole: holder });
    } else if (action === "send_back") {
      if (!isOpen || !["trade_ay", "trade_manager"].includes(holder)) return fail(409, "Only Trade/AY and Trade send an escalation back");
      if (!(await asHolder())) return fail(403, `Only ${ROLE_LABEL[holder]} of this lane can send it back`);
      let to = "trade_ay";
      if (holder === "trade_ay") {
        // Back to whoever escalated it to Trade/AY, unless the caller names OCC/AY or CCL/CO.
        const [up] = await query("SELECT from_role FROM booking_escalation_steps WHERE escalation_id=$1 AND to_role='trade_ay' AND from_role IN ('occ_ay','ccl_co') ORDER BY created_at DESC LIMIT 1", [esc.id]);
        to = ["occ_ay", "ccl_co"].includes(toRole) ? toRole : (up?.from_role || cfg.defaultGroup);
      }
      next = await update(esc.id, { holder_role: to, holder_since: now });
      await addStep(esc, { action, fromRole: holder, toRole: to, message: msg, user, actorRole: holder });
    } else if (action === "instruct") {
      if (!isOpen || !["occ_ay", "ccl_co", "trade_ay"].includes(holder)) return fail(409, `${ROLE_LABEL[holder]} can't send instructions`);
      if (!(await asHolder())) return fail(403, `Only ${ROLE_LABEL[holder]} of this shipment can send instructions`);
      const ins = cleanInstruction(instruction);
      if (!ins) return fail(400, "Pick a carrier and a sailing (vessel and departure date) to send as instructions");
      next = await update(esc.id, { status: "instructed", instruction: JSON.stringify(ins), instructed_by_role: holder, holder_role: "occ_bk", holder_since: now });
      await addStep(esc, { action: "instructed", fromRole: holder, toRole: "occ_bk", message: msg,
        data: { carrierCode: ins.carrierCode, contractNumber: ins.contractNumber, vessel: ins.sailing.vesselName, voyage: ins.sailing.voyageNumber, etd: ins.sailing.etd }, user, actorRole: holder });
    } else if (action === "impossible") {
      if (!isOpen || holder !== "trade_ay") return fail(409, "Only Trade/AY marks a booking impossible");
      if (!(await asHolder())) return fail(403, "Only Trade/AY of this lane can mark it impossible");
      const why = String(reason || msg).trim();
      if (!why) return fail(400, "Say why the booking is impossible");
      next = await update(esc.id, { status: "impossible", impossible_reason: why, closed_at: now, closed_by_name: user?.name || user?.email || "" });
      await addStep(esc, { action, fromRole: holder, toRole: "occ_bk", message: why, user, actorRole: holder });
    } else if (action === "question") {
      if (esc.status !== "instructed") return fail(409, "There are no instructions to question");
      if (!(await canActAs(user, req, "occ_bk", shipment))) return fail(403, "Only OCC/BK of this shipment can send instructions back");
      if (!msg) return fail(400, "Write the question for the instructions' sender");
      const to = esc.instructed_by_role || cfg.defaultGroup;
      next = await update(esc.id, { status: "open", holder_role: to, holder_since: now, instruction: "" });
      await addStep(esc, { action, fromRole: "occ_bk", toRole: to, message: msg, user, actorRole: "occ_bk" });
    } else if (action === "withdraw") {
      if (!(await canActAs(user, req, "occ_bk", shipment))) return fail(403, "Only OCC/BK of this shipment can withdraw the escalation");
      next = await update(esc.id, { status: "withdrawn", closed_at: now, closed_by_name: user?.name || user?.email || "" });
      await addStep(esc, { action, fromRole: "occ_bk", toRole: "", message: msg, user, actorRole: "occ_bk" });
    } else if (action === "message") {
      if (!msg) return fail(400, "Write a message");
      let as = null;
      for (const r of [holder, "occ_bk", "occ_ay", "ccl_co", "trade_ay", "trade_manager"]) if (await canActAs(user, req, r, shipment)) { as = r; break; }
      if (!as) return fail(403, "You're not part of this escalation");
      next = esc;
      await addStep(esc, { action, fromRole: as, toRole: holder, message: msg, user, actorRole: as });
    }
    return { ok: true, escalation: mapEscalation(next) };
  }

  // What the caller may do now, for the shipment's escalation panel.
  async function allowedActions(esc, user, req, shipment) {
    if (!esc || !ACTIVE.includes(esc.status)) return [];
    const cfg = await settings();
    const holder = esc.holder_role, out = [];
    const asHolder = await canActAs(user, req, holder, shipment);
    const asOccBk = await canActAs(user, req, "occ_bk", shipment);
    if (esc.status === "open" && asHolder) {
      if (["occ_ay", "ccl_co"].includes(holder)) out.push("instruct", "hand_over", "escalate");
      if (holder === "trade_ay") { out.push("instruct", "send_back", "impossible"); if (cfg.tradeLevel) out.push("escalate"); }
      if (holder === "trade_manager") out.push("send_back");
    }
    if (esc.status === "instructed" && asOccBk && !(await wasBooked(esc.id))) out.push("book", "question");
    if (asOccBk) out.push("withdraw");
    let canMessage = asHolder || asOccBk;
    for (const r of ["occ_ay", "ccl_co", "trade_ay", "trade_manager"]) if (!canMessage && await canActAs(user, req, r, shipment)) canMessage = true;
    if (canMessage) out.push("message");
    return out;
  }

  // Can this caller escalate the shipment's booking now, and for what?
  async function escalationOffer(shipmentRow, user, req) {
    const cfg = await settings();
    const shipment = mapShipment(shipmentRow);
    const [b] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    const trigger = triggerFor(b, cfg);
    const active = await activeRow(shipment.id);
    return {
      trigger, triggerLabel: trigger ? TRIGGER_LABEL[trigger] : "",
      changes: trigger === "changed" ? changesOf(b) : [],
      allowed: !!trigger && !active && await canActAs(user, req, "occ_bk", shipment),
      defaultGroup: cfg.defaultGroup,
      groups: await Promise.all(["occ_ay", "ccl_co"].map(async role => ({ role, label: ROLE_LABEL[role], place: await holderPlace(role, shipment) }))),
      reasons: Object.entries(REASONS).filter(([k]) => k !== "no_answer" || trigger === "no_answer").map(([code, label]) => ({ code, label })),
    };
  }

  // A carrier answer moves an open escalation along: the carrier confirming as requested (the
  // booked-as-instructed request, or the original carrier after all) resolves it; the instructed
  // carrier rejecting the booked-as-instructed request, or confirming it with changes, sends it back to
  // whoever gave the instructions.
  async function onCarrierState(shipmentId, b) {
    const esc = await activeRow(shipmentId);
    if (!esc || !b) return;
    if (b.status === "Confirmed" && !hasChanges(b)) {
      const next = await update(esc.id, { status: "resolved", closed_at: nowIso(), closed_by_name: b.carrier_code || "Carrier" });
      await addStep(next, { action: "resolved", fromRole: esc.holder_role, message: `${b.carrier_code || "The carrier"} confirmed the booking${b.booking_ref ? ` (${b.booking_ref})` : ""}`, actorRole: "system" });
      return;
    }
    const changed = b.status === "Confirmed" && hasChanges(b);
    if ((b.status === "Rejected" || changed) && esc.status === "instructed" && await wasBooked(esc.id)) {
      const to = esc.instructed_by_role || (await settings()).defaultGroup;
      // From here on the escalation is about the booking made as instructed, and the sailing that carrier turned down or changed.
      const next = await update(esc.id, { status: "open", holder_role: to, holder_since: nowIso(), instruction: "",
        booking_id: b.id, carrier_code: b.carrier_code || "", trigger: changed ? "changed" : "rejected", sailing: await sailingOf(shipmentId, b) });
      await addStep(next, changed
        ? { action: "carrier_changed", fromRole: "occ_bk", toRole: to, message: `${b.carrier_code || "The carrier"} confirmed the booking made as instructed with changes: ${changesText(changesOf(b))}`, actorRole: "system" }
        : { action: "carrier_rejected", fromRole: "occ_bk", toRole: to, message: `${b.carrier_code || "The carrier"} rejected the booking made as instructed`, actorRole: "system" });
    } else if (changed && esc.status === "open") {
      await addStep(esc, { action: "carrier_changed", fromRole: esc.holder_role, toRole: "", message: `${b.carrier_code || "The carrier"} confirmed with changes: ${changesText(changesOf(b))}`, actorRole: "system" });
    }
  }
  const wasBooked = async escalationId =>
    !!(await query("SELECT 1 FROM booking_escalation_steps WHERE escalation_id=$1 AND action='booked' LIMIT 1", [escalationId]))[0];

  // ─── Book As Instructed (OCC/BK) ───────────────────────────────────────────────────────────────
  // The shipment takes the instructed carrier, contract and sailing, and the booking request goes to
  // that carrier (DCSA). An open request with the same carrier is withdrawn there first; another
  // carrier's not-yet-confirmed booking is withdrawn and archived by the carrier change itself
  // (supersedeIfCarrierChanged). A booking the carrier has CONFIRMED is a real commitment: it has to
  // be cancelled with that carrier first. The escalation stays with OCC/BK until the carrier answers.
  async function book(escalationId, user, req) {
    const [esc] = await query("SELECT * FROM booking_escalations WHERE id=$1", [escalationId]);
    if (!esc) return fail(404, "Escalation not found");
    if (esc.status !== "instructed") return fail(409, "There are no instructions to book");
    if (await wasBooked(esc.id)) return fail(409, "Already booked as instructed: waiting for the carrier");
    const [row] = await query("SELECT * FROM shipments WHERE id=$1", [esc.shipment_id]);
    const shipment = mapShipment(row);
    if (!(await canActAs(user, req, "occ_bk", shipment))) return fail(403, "Only OCC/BK of this shipment can book as instructed");
    let ins;
    try { ins = JSON.parse(esc.instruction); } catch { ins = null; }
    if (!ins?.carrierCode || !ins.sailing?.etd) return fail(409, "The instructions are incomplete: send them back with a question");
    // Refused before anything changes: the instructed carrier has to be bookable (DCSA).
    if (!(await ctx.carrierIntegrationFor(ins.carrierCode, "booking")))
      return fail(400, `No DCSA connection for ${ins.carrierCode}: it can't be booked from CargoDesk (Carrier Integrations, or App Settings → Demo carrier)`);
    const [b] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [row.id]);
    if (b?.status === "Confirmed")
      return fail(409, `${b.carrier_code} has confirmed this booking: cancel it with them first (Cancel Booking), then book as instructed`);
    const actorName = user?.name || user?.email || "";
    const r = await rebook(row, b, ins, { user, actorName, reason: "Rebooked as instructed", eventType: "BOOKED_AS_INSTRUCTED", eventMeta: { escalationId: esc.id } });
    if (r.error) return r;
    const sent = r.sent;
    await addStep(esc, { action: "booked", fromRole: "occ_bk", toRole: "", message: `Booked ${ins.carrierCode} as instructed`,
      data: { carrierCode: ins.carrierCode, bookingId: sent.body.booking?.id, requestReference: sent.body.booking?.carrierBookingRequestReference || "", carrierError: sent.body.carrierError || "" },
      user, actorRole: "occ_bk" });
    const [next] = await query("SELECT * FROM booking_escalations WHERE id=$1", [esc.id]);
    return { ok: true, escalation: mapEscalation(next), booking: sent.body.booking, carrierError: sent.body.carrierError || null };
  }

  // Replaces a shipment's SEA legs with a sailing's: its legs in order for a transshipment, one leg for a
  // direct sailing (from its POL/POD, else the old sea legs' ends). Pick-up legs stay before them and
  // Delivery legs after; leg_order is renumbered.
  async function replaceSeaLegs(row, ins) {
    const s = ins.sailing;
    const all = await query("SELECT id, leg_type, mot, pol, pod FROM shipment_legs WHERE shipment_id=$1 ORDER BY leg_order, created_at", [row.id]);
    const isSea = l => (l.leg_type ? l.leg_type === "SEA" : l.mot === "SEA");
    const seaAt = all.map((l, i) => (isSea(l) ? i : -1)).filter(i => i >= 0);
    const firstSea = seaAt.length ? all[seaAt[0]] : null, lastSea = seaAt.length ? all[seaAt[seaAt.length - 1]] : null;
    const segments = s.legs?.length > 1 ? s.legs
      : [{ pol: s.pol || firstSea?.pol || row.pol, pod: s.pod || lastSea?.pod || row.pod, vesselName: s.vesselName, voyageNumber: s.voyageNumber, vesselImo: s.vesselImo || "", etd: s.etd, eta: s.eta }];
    const head = seaAt.length ? all.slice(0, seaAt[0]).filter(l => !isSea(l)) : all.filter(l => l.leg_type === "Pick-up");
    const tail = all.filter(l => !isSea(l) && !head.includes(l));
    if (seaAt.length) await query(`DELETE FROM shipment_legs WHERE id IN (${seaAt.map((_, i) => `$${i + 1}`).join(",")})`, seaAt.map(i => all[i].id));
    const now = nowIso(), created = [];
    for (const seg of segments) {
      const id = `LEG-${uid()}`;
      await query(`INSERT INTO shipment_legs (id, shipment_id, leg_order, mot, leg_type, movement_type, pol, pod, pol_name, pod_name, pol_loc_type, pod_loc_type,
          etd, eta, carrier_code, vessel, vessel_imo, voyage, movement_by, contract_type, contract_ref, created_at)
        VALUES ($1,$2,0,'SEA','SEA','SEA',$3,$4,'','','Terminal','Terminal',$5,$6,$7,$8,$9,$10,'','','',$11)`,
        [id, row.id, seg.pol, seg.pod, seg.etd || null, seg.eta || null, ins.carrierCode, seg.vesselName, seg.vesselImo || "", seg.voyageNumber || "", now]);
      created.push(id);
    }
    const order = [...head.map(l => l.id), ...created, ...tail.map(l => l.id)];
    for (const [i, id] of order.entries()) await query("UPDATE shipment_legs SET leg_order=$1 WHERE id=$2", [i, id]);
  }

  // The shipment takes another carrier / contract / sailing and the booking request goes to that carrier:
  // Book As Instructed and the no-answer switch alike. ins: { carrierCode, contractId?, contractNumber?,
  // allocationId?, sailing: { vesselName, voyageNumber, etd, eta } }. → { sent } or a fail().
  async function rebook(row, b, ins, { user = null, actorName = "", reason, eventType, eventMeta = {} }) {
    const sameCarrier = ins.carrierCode === row.carrier_code;
    if (b?.status === "Pending" && sameCarrier) {
      try { await ctx.cancelCarrierBooking(row, reason, actorName || "CargoDesk"); }
      catch (e) { return fail(e.status || 502, e.message); }
    }

    const s = ins.sailing;
    // A spot offer from the old carrier, or for another departure, doesn't price this booking: it comes
    // off with its BUY lines (lib/spot-offers.js; SPOT rates, 2026-10-21).
    await ctx.spotOffers?.releaseIfStale(row, { carrierCode: ins.carrierCode, central: !!ins.contractId, etd: s?.etd || "" },
      { actor: actorName || "CargoDesk" });
    // The contract changes as a whole or not at all: instructions naming a contract make the shipment
    // Central on it (number and space configuration too); without one, its contract stays as it was.
    await query(`UPDATE shipments SET carrier_code=$1,
        contract_type=CASE WHEN $2<>'' THEN 'Central' ELSE contract_type END,
        contract_id=CASE WHEN $2<>'' THEN $2 ELSE contract_id END,
        contract_ref=CASE WHEN $2<>'' AND $3<>'' THEN $3 ELSE contract_ref END,
        allocation_id=CASE WHEN $2<>'' THEN NULLIF($4, '') ELSE allocation_id END WHERE id=$5`,
      [ins.carrierCode, ins.contractId || "", ins.contractNumber || "", ins.allocationId || "", row.id]);
    // The sailing's legs replace the shipment's sea legs (one for a direct sailing); the shipment's
    // vessel (the main leg's), ETD and ETA then roll up from them (syncShipmentFromLegs).
    await replaceSeaLegs(row, ins);
    await ctx.syncShipmentFromLegs(row.id, actorName || "CargoDesk");
    // Moving down the line after a rejection or no answer IS the steering (Epic TKT-KFGL81, Story 3).
    try { await ctx.whereToBook?.recordVerdict(row.id, { verdict: "rebooked", actor: actorName || "CargoDesk" }); }
    catch (e) { console.error(`Steering verdict ${row.id}:`, e.message); }
    await logEvent(row.id, eventType, "carrier_code", row.carrier_code, ins.carrierCode,
      JSON.stringify({ ...eventMeta, contractNumber: ins.contractNumber, vessel: s.vesselName, voyage: s.voyageNumber, etd: s.etd, eta: s.eta }), actorName || "CargoDesk");
    if (!sameCarrier) {
      const [fresh] = await query("SELECT * FROM shipments WHERE id=$1", [row.id]);
      const [existing] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [row.id]);
      await ctx.supersedeIfCarrierChanged(fresh, existing);
    }
    await ctx.recomputeSpacePool?.(row.id).catch(() => {});
    const sent = await ctx.sendBookingRequest(row.id, { user });
    if (sent.body?.error) return fail(sent.status, `The shipment now carries the new carrier and sailing, but the booking request wasn't sent: ${sent.body.error}`);
    return { sent };
  }

  // ─── Accept the carrier's version (Requested vs Carrier, agreed 2026-10-21) ─────────────────────
  // The confirmed sailing — every leg of the carrier's transport plan — replaces the shipment's sea
  // legs, so its vessel (the main one), ETD and ETA roll up from them; the cut-offs go where CargoDesk
  // keeps them (documentation → the Shipping Instructions' cut-off, VGM and FCL delivery → each
  // container). The booking then counts as Confirmed, an escalation raised over the changes resolves,
  // and the History records what was accepted. → { ok, accepted } or a fail().
  async function acceptCarrierChanges(row, booking, user) {
    if (booking.status !== "Confirmed") return fail(409, "Only a confirmed booking's version can be accepted");
    let dcsa = null;
    try { dcsa = booking.carrier_confirmation ? JSON.parse(booking.carrier_confirmation) : null; } catch { dcsa = null; }
    const sailing = dcsa ? confirmedSailing(dcsa) : null;
    if (!sailing) return fail(409, `${booking.carrier_code}'s confirmation has no sailing to accept`);
    if (booking.changes_accepted_at) return fail(409, `${booking.carrier_code}'s version was already accepted`);
    const actorName = user?.name || user?.email || "";
    const changes = changesOf(booking);
    await replaceSeaLegs(row, { carrierCode: booking.carrier_code, sailing });
    await ctx.syncShipmentFromLegs(row.id, actorName);

    const cut = code => (dcsa.shipmentCutOffTimes || []).find(c => c.cutOffDateTimeCode === code)?.cutOffDateTime || "";
    const local = v => String(v || "").slice(0, 16);   // "YYYY-MM-DDTHH:mm" (UTC), the date pickers' shape
    const cutOffs = { documentation: local(cut("DCO")), vgm: local(cut("VCO")), fclDelivery: local(cut("FCO")) };
    if (cutOffs.vgm) await query("UPDATE containers SET vgm_cutoff=$1 WHERE shipment_id=$2", [cutOffs.vgm, row.id]);
    if (cutOffs.fclDelivery) await query("UPDATE containers SET cy_cutoff=$1 WHERE shipment_id=$2", [cutOffs.fclDelivery, row.id]);
    if (cutOffs.documentation) {
      const [si] = await query("SELECT id FROM shipping_instructions WHERE shipment_id=$1", [row.id]);
      if (si) await query("UPDATE shipping_instructions SET si_cutoff=$1, updated_at=$2 WHERE id=$3", [cutOffs.documentation, nowIso(), si.id]);
      else await query(`INSERT INTO shipping_instructions (id, shipment_id, status, si_cutoff, special_instructions, created_at, updated_at)
        VALUES ($1,$2,'Draft',$3,'',$4,$4)`, [`SI-${uid()}`, row.id, cutOffs.documentation, nowIso()]);
    }
    await query("UPDATE carrier_bookings SET changed_fields='', changes_accepted_at=$1, changes_accepted_by=$2, updated_at=$1 WHERE id=$3", [nowIso(), actorName, booking.id]);
    await logEvent(row.id, "CARRIER_CHANGES_ACCEPTED", "vessel", row.vessel, sailing.vesselName,
      JSON.stringify({ carrier: booking.carrier_code, bookingRef: booking.booking_ref || "", changes, cutOffs,
        legs: (sailing.legs || [sailing]).map(l => `${l.pol}→${l.pod} ${l.vesselName} ${l.voyageNumber || ""}`.trim()) }), actorName);

    const esc = await activeRow(row.id);
    if (esc && esc.trigger === "changed") {
      const next = await update(esc.id, { status: "resolved", closed_at: nowIso(), closed_by_name: actorName || "OCC/BK" });
      await addStep(next, { action: "accepted_changes", fromRole: esc.holder_role, message: `${actorName || "OCC/BK"} accepted ${booking.carrier_code}'s version`, user, actorRole: "occ_bk" });
    }
    return { ok: true, accepted: { at: nowIso(), by: actorName }, sailing, cutOffs };
  }

  // ─── Alternatives for the handler ──────────────────────────────────────────────────────────────
  // The lane's steering first: Where to book's answer (lib/where-to-book.js, Epic TKT-KFGL81), its
  // options in their order, each checked against this shipment — an option that can't carry it stays
  // listed, greyed out, with the reason; a full one says so. Any loop and no haulage, as the handler is
  // looking for another sailing. With no steering for the lane and customer on the ETD, or when the
  // handler asks for it (source "contracts"), the general contract search: the space-configuration
  // match the contract picker uses, one option per carrier + contract, customer-specific space first
  // ("there's always a priority in using the central contracts").
  // → { source: "steering" | "contracts", lane, steering: { id, customerName, autoSwitch } | null, options }
  const fmtDate = d => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "";
  async function alternatives(shipmentRow, { source = "" } = {}) {
    const s = mapShipment(shipmentRow);
    const etd = (s.etd || nowIso()).slice(0, 10);
    const lane = s.tradeLane || "";
    const answer = ctx.whereToBook ? await ctx.whereToBook.forShipment({ ...shipmentRow, etd }, { anyLoop: true, noHaulage: true }) : null;
    const steering = answer?.line || null;
    const steeringInfo = steering ? { id: steering.id, customerName: steering.customerName, autoSwitch: steering.autoSwitch } : null;

    if (steering && source !== "contracts") {
      const options = answer.options.map(o => {
        const on = o.space.find(x => x.freeTEU > 0) || o.space[0] || null;
        const current = o.contractId === s.contractId && o.carrierCode === s.carrierCode;
        const week = on?.spaceBasis === "week" ? ` in week ${on.weekNumber}` : "";
        return {
          rank: o.rank, source: "steering", carrierCode: o.carrierCode, contractId: o.contractId, contractNumber: o.contractNumber,
          allocationId: on?.id || "", remainingTeu: o.orderOnly ? null : Math.max(0, on?.freeTEU ?? 0), contractType: "Central", validTo: o.validTo,
          customerSpecific: !!on?.customerId, usable: o.status !== "skipped", status: o.status,
          note: o.status === "skipped" ? `Not usable: ${o.reason}` : [
            current ? "The rejected contract, on a later sailing" : "",
            o.note,
            o.status === "full" ? `Full${week}` : on ? `${Math.max(0, on.freeTEU)} TEU free${week}` : "",
            o.validTo ? `Valid until ${fmtDate(o.validTo)}` : "",
            o.orderOnly ? "No space configured on this route" : "",
          ].filter(Boolean).join(" · "),
        };
      });
      return { source: "steering", lane, steering: steeringInfo, options };
    }

    const matches = ctx.matchAllocations
      ? await ctx.matchAllocations({ pol: s.pol, pod: s.pod, etd, principalId: s.principalId || "", commodityCode: s.commodityCode || "" })
      : [];
    const seen = new Set(), options = [];
    for (const m of matches) {
      const key = `${m.carrierCode}|${m.contractId || m.contractNumber}`;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        rank: options.length + 1, source: "contracts", carrierCode: m.carrierCode, contractId: m.contractId || "",
        contractNumber: m.contractNumber || "", allocationId: m.id, contractType: "Central", validTo: m.endDate || "",
        customerSpecific: !!m.customerId, usable: true,
        note: [m.customerId ? `Space for ${m.customerName || "this customer"}` : "", m.endDate ? `Valid until ${m.endDate}` : ""].filter(Boolean).join(" · "),
      });
    }
    return { source: "contracts", lane, steering: steeringInfo, options };
  }

  // The Recommended sailing among a carrier's direct sailings: the shortest transit time, the earlier
  // departure on a tie (user, 2026-10-20). The handler's list labels it; the no-answer switch books it.
  // The same rule is in src/components/shared/BookingEscalation.jsx (recommendedIndex).
  const transitOf = s => Number.isFinite(Number(s.transitDays)) && s.transitDays !== null && s.transitDays !== ""
    ? Number(s.transitDays) : (s.etd && s.eta ? (Date.parse(`${s.eta}T00:00:00Z`) - Date.parse(`${s.etd}T00:00:00Z`)) / 864e5 : Infinity);
  const recommendedSailing = list => [...list].sort((a, b) => transitOf(a) - transitOf(b) || String(a.etd).localeCompare(String(b.etd)))[0] || null;

  // ─── No answer (Story 6) ───────────────────────────────────────────────────────────────────────
  // A booking sent to a carrier (DCSA) that hasn't had a decision within the no-answer time:
  //   - on a lane steered with the switch on, CargoDesk withdraws it and books the next usable option
  //     after the current carrier that has space for the shipment, on that carrier's Recommended
  //     sailing (shortest transit, transshipments included) departing on or after the requested ETD,
  //     its legs replacing the shipment's sea legs — no OCC/BK step (agreed
  //     2026-10-20). The new request starts its own no-answer time, so an unanswered #2 moves on to #3;
  //   - otherwise, or with no option left, it escalates to the default group (OCC/AY unless App
  //     Settings says CCL/CO), once per booking.
  // Runs every few minutes (server.js) and on demand (POST /api/escalations/no-answer-sweep).
  async function autoSwitch(row, b) {
    const s = mapShipment(row);
    const etd = (s.etd || nowIso()).slice(0, 10);
    const steering = ctx.steeringFor
      ? await ctx.steeringFor({ originLane: ctx.longestLane?.(s.pol) || "", destLane: ctx.longestLane?.(s.pod) || "", principalId: s.principalId || "", date: etd })
      : null;
    if (!steering?.autoSwitch) return null;
    const { options } = await alternatives(row);
    const at = options.findIndex(o => o.carrierCode === s.carrierCode && (!s.contractId || o.contractId === s.contractId));
    for (const o of options.slice(at + 1)) {
      if (!o.usable || o.carrierCode === s.carrierCode || !o.allocationId || (o.remainingTeu ?? 0) < (s.teu || 0)) continue;
      if (!(await ctx.carrierIntegrationFor(o.carrierCode, "booking"))) continue;
      const sailings = ctx.carrierSailings ? await ctx.carrierSailings({ pol: s.pol, pod: s.pod, carrierCode: o.carrierCode, weeks: 6 }) : [];
      const sailing = recommendedSailing(sailings.filter(x => x.etd >= etd));
      if (!sailing) continue;
      const ins = { carrierCode: o.carrierCode, contractId: o.contractId, contractNumber: o.contractNumber, allocationId: o.allocationId,
        sailing: { vesselName: sailing.vesselName, voyageNumber: sailing.voyageNumber, etd: sailing.etd, eta: sailing.eta, pol: s.pol, pod: s.pod,
          ...(sailing.legs?.length > 1 ? { legs: sailing.legs } : {}) } };
      const why = `${b.carrier_code} didn't answer within the no-answer time`;
      const r = await rebook(row, b, ins, { reason: why, eventType: "NO_ANSWER_SWITCHED",
        eventMeta: { from: b.carrier_code, option: o.rank, steeringId: steering.id, reason: why } });
      if (r.error) { console.error(`No-answer switch ${s.id} → ${o.carrierCode}:`, r.error); continue; }
      return { shipmentId: s.id, from: b.carrier_code, to: o.carrierCode, option: o.rank, sailing: ins.sailing };
    }
    return null;
  }

  async function sweepNoAnswer() {
    const cfg = await settings();
    const cutoff = new Date(Date.now() - cfg.noAnswerHours * 3600e3).toISOString();
    const rows = await query(`SELECT s.*, cb.id AS cb_id FROM carrier_bookings cb JOIN shipments s ON s.id = cb.shipment_id
      WHERE cb.status='Pending' AND cb.decided_at IS NULL AND COALESCE(cb.carrier_booking_request_reference,'') <> ''
        AND cb.requested_at IS NOT NULL AND cb.requested_at <> '' AND cb.requested_at <= $1
        AND COALESCE(s.status,'') NOT IN ('Cancelled','Completed')
        AND NOT EXISTS (SELECT 1 FROM booking_escalations e WHERE e.shipment_id = s.id AND (e.status IN ('open','instructed') OR e.booking_id = cb.id))
      ORDER BY cb.requested_at LIMIT 200`, [cutoff]);
    const result = { switched: [], escalated: [], failed: [] };
    for (const row of rows) {
      try {
        const [b] = await query("SELECT * FROM carrier_bookings WHERE id=$1", [row.cb_id]);
        const switched = await autoSwitch(row, b);
        if (switched) { result.switched.push(switched); continue; }
        const r = await create({ shipmentId: row.id, toRole: cfg.defaultGroup, reasonCode: "no_answer", automatic: true,
          note: `${b.carrier_code} hasn't decided on the booking request in ${cfg.noAnswerHours} h` });
        if (r.error) result.failed.push({ shipmentId: row.id, error: r.error });
        else result.escalated.push({ shipmentId: row.id, escalationId: r.escalation.id, toRole: cfg.defaultGroup });
      } catch (e) {
        result.failed.push({ shipmentId: row.id, error: e.message });
      }
    }
    return result;
  }

  // ─── The Shipments list's Booking column (Story 2) ─────────────────────────────────────────────
  // One shipment's value. row: a shipments row with its carrier booking joined in (booking_status,
  // booking_requested_at, booking_decided_at, booking_changed_fields — routes/shipments.js); esc: its
  // latest escalation row; booked: that escalation was booked as instructed; place: where the holder
  // sits (export/import office name, or the trade lane). tone is a Badge variant.
  const TRIGGER_SHORT = { rejected: "Rejected", changed: "Changed", no_answer: "No answer" };
  function bookingStateOf(row, esc, booked, cfg, place = "") {
    if (esc?.status === "open")
      return { label: "Escalated", tone: "amber", sub: `${TRIGGER_SHORT[esc.trigger] || ""} · ${ROLE_LABEL[esc.holder_role] || esc.holder_role}${place ? ` ${place}` : ""}`,
        holderRole: esc.holder_role, since: esc.holder_since, escalationId: esc.id };
    if (esc?.status === "instructed" && !booked)
      return { label: "Instructions ready", tone: "purple", sub: `From ${ROLE_LABEL[esc.instructed_by_role] || "the handler"} · OCC/BK to book`,
        holderRole: "occ_bk", since: esc.holder_since, escalationId: esc.id };
    if (esc?.status === "impossible" && row.booking_status === "Rejected")
      return { label: "Impossible", tone: "danger", sub: esc.impossible_reason || "" };
    const st = row.booking_status;
    if (!st || st === "Created") return { label: "Not sent", tone: "default", sub: "" };
    if (st === "Pending") {
      if (row.booking_decided_at) return { label: "Update requested", tone: "warning", sub: "The carrier asked for changes" };
      const waited = row.booking_requested_at ? Date.now() - Date.parse(row.booking_requested_at) : 0;
      if (waited >= cfg.noAnswerHours * 3600e3) return { label: "No answer", tone: "warning", sub: "", since: row.booking_requested_at };
      return { label: "Waiting for carrier", tone: "info", sub: "", since: row.booking_requested_at };
    }
    if (st === "Confirmed")
      return hasChanges({ changed_fields: row.booking_changed_fields })
        ? { label: "Confirmed with changes", tone: "warning", sub: changesOf({ changed_fields: row.booking_changed_fields }).map(c => c.label).join(", ") }
        : { label: "Confirmed", tone: "success", sub: "" };
    if (st === "Rejected") return { label: "Rejected", tone: "danger", sub: esc ? "" : "Not escalated yet" };
    if (st === "Cancelled") return { label: "Cancelled", tone: "default", sub: "" };
    return { label: st, tone: "default", sub: "" };
  }
  // Each shipment's latest escalation, and which of those were booked as instructed.
  async function latestByShipment() {
    const rows = await query("SELECT DISTINCT ON (shipment_id) * FROM booking_escalations ORDER BY shipment_id, created_at DESC");
    const booked = new Set((await query("SELECT DISTINCT escalation_id FROM booking_escalation_steps WHERE action='booked'")).map(r => r.escalation_id));
    return { byShipment: new Map(rows.map(r => [r.shipment_id, r])), booked };
  }

  // ─── For the bell ─────────────────────────────────────────────────────────────────────────────
  async function activeByShipment(shipmentIds) {
    if (!shipmentIds.length) return new Map();
    const rows = await query(`SELECT * FROM booking_escalations WHERE status IN ('open','instructed') AND shipment_id IN (${shipmentIds.map((_, i) => `$${i + 1}`).join(",")})`, shipmentIds);
    return new Map(rows.map(r => [r.shipment_id, r]));
  }
  async function allActive() { return query("SELECT * FROM booking_escalations WHERE status IN ('open','instructed') ORDER BY holder_since"); }

  return {
    ROLE_LABEL, TRIGGER_LABEL, REASONS, ACTIVE,
    settings, canActAs, triggerFor, hasChanges, mapEscalation, mapStep, activeRow, latestRow, stepsOf, holderPlace,
    create, act, book, wasBooked, allowedActions, escalationOffer, onCarrierState, alternatives, activeByShipment, allActive,
    confirmationChanges, sweepNoAnswer, acceptCarrierChanges,
    bookingStateOf, latestByShipment,
  };
};
