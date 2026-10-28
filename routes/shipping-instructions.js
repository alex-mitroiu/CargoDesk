"use strict";

// ─── Shipping Instructions (2026-09 FCL export gap analysis, finding #1; DCSA since 2026-10-27) ───
// One row per shipment (UNIQUE shipment_id). Submit sends DCSA Shipping Instructions 3.0 to the carrier
// through its DCSA connection (the carrier's own integration, or the built-in DCSA carrier where
// allowed; lib/carrier-integrations/dcsa-ebl-v3.js) — before 2026-10-27 it recorded a home-made summary
// and sent nothing. The carrier answers with DCSA notifications (routes/carrier-webhooks.js →
// applyShippingInstructionsState), or when polled. These are the instructions for the carrier's
// Master B/L: the NVOCC (when there is one) ships, as on the booking.
//
// CargoDesk's own statuses, from the carrier's DCSA state:
//   Draft      — not sent yet (or reopened to correct after the carrier asked for an update)
//   Submitted  — sent; the carrier has it (RECEIVED, or an update UPDATE_RECEIVED) and hasn't drafted from it yet
//   Confirmed  — the carrier accepted it: it drafted its Master B/L from it (routes/master-bl.js), or the
//                B/L was surrendered for delivery (COMPLETED, the spec's last state — before 2026-10-28
//                CargoDesk wrongly took COMPLETED as the carrier's acceptance)
//   Rejected   — the carrier asked for an update (PENDING_UPDATE: correct and resubmit, which sends a
//                DCSA update under the same reference) or declined it (DECLINED: final)
//   Cancelled  — CargoDesk cancelled them (CANCELLED); resetting starts new instructions
// Until the carrier issues the Master B/L, "Send update" sends the shipment's current data as an update
// (corrections, or a House B/L issued since, gap G25), and an update the carrier hasn't worked in yet
// can be cancelled.

const { buildShippingInstructions, houseBillOfLadingFrom, houseBillOfLadingFor } = require("../lib/carrier-integrations/dcsa-ebl-v3");

module.exports = function shippingInstructionsRoutes(app, ctx) {
  const { query, uid, ok, err, auth, requireRole, applyShipmentAccessFilter, mapShipment,
          mapShippingInstructions, mapEdiMessage, getCustomerRow, carrierIntegrationFor,
          logEntityEvent, autoCompleteMilestone, blockIfWrongSide } = ctx;

  const write = requireRole(["operator", "admin", "occ_bk"]); // same set as routes/edi.js / customs-filing.js

  async function insertMessage(shipmentId, carrierCode, correlationId, direction, messageType, status, rawPayload, parsedPayload, isMock) {
    const id = `EDI-${uid()}`, now = new Date().toISOString();
    await query(`INSERT INTO edi_messages (id, shipment_id, carrier_code, direction, message_type,
      format, raw_payload, parsed_payload, status, correlation_id, is_mock, created_at, processed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, shipmentId, carrierCode || "", direction, messageType, "JSON", JSON.stringify(rawPayload),
           parsedPayload ? JSON.stringify(parsedPayload) : null, status, correlationId, !!isMock, now, now]);
    const [msg] = await query("SELECT * FROM edi_messages WHERE id=$1", [id]);
    return mapEdiMessage(msg);
  }

  // ─── The DCSA Shipping Instructions for a shipment ─────────────────────────
  // → { body, missing: [plain words] }. `reference` makes it an update (UpdateShippingInstructions).
  async function shippingInstructionsFor(shipment, { reference = "" } = {}) {
    const hb = ctx.houseBl;
    const missing = [];
    const containers = await query("SELECT * FROM containers WHERE shipment_id=$1 ORDER BY container_number, id", [shipment.id]);
    const [nvocc] = await query("SELECT customer_id, customer_name FROM shipment_parties WHERE shipment_id=$1 AND role='NVOCC'", [shipment.id]);
    const shipperRow = await getCustomerRow(nvocc?.customer_id || shipment.shipper_id).catch(() => null);
    const consigneeRow = await getCustomerRow(shipment.consignee_id).catch(() => null);
    const notifyRow = await getCustomerRow(shipment.notify_id).catch(() => null);
    const [office] = shipment.emo_office_id ? await query(
      "SELECT o.name AS office_name, b.name AS branch_name, b.email, b.phone FROM offices o LEFT JOIN branches b ON b.id = o.branch_id WHERE o.id=$1",
      [shipment.emo_office_id]) : [];

    if (!shipment.booking_ref) missing.push("the carrier's booking number (a carrier booking the carrier has confirmed)");
    if (!nvocc && !shipment.shipper_id && !shipment.shipper_name) missing.push("a Shipper (Parties & Offices)");
    if (!shipment.consignee_id && !shipment.consignee_name) missing.push("a Consignee (Parties & Offices)");
    if (!(office?.email || office?.phone)) missing.push("a phone or email on the export office's legal entity (Organisation → Branches), for the carrier to reach");
    if (!containers.length) missing.push("at least one container");
    // The House B/L CargoDesk issued under this Master, as issued (its DCSA document is kept on the record).
    const house = await hb.liveHouse(shipment.id).catch(() => null);
    const houseDoc = house?.payload ? (() => { try { return JSON.parse(house.payload); } catch { return null; } })() : null;
    const legs = await query("SELECT pol, pod FROM shipment_legs WHERE shipment_id=$1 ORDER BY leg_order", [shipment.id]);
    const notifyContact = notifyRow && (notifyRow.email || notifyRow.phone) ? { name: notifyRow.companyName, email: notifyRow.email, phone: notifyRow.phone } : null;
    if (houseDoc?.isToOrder && !notifyContact)
      missing.push(`a phone or email on the notify party ${notifyRow?.companyName || shipment.notify_name || ""} (Customers): House B/L ${houseDoc.transportDocumentReference} is to order, and the carrier needs its notify party's contact`.replace("party  (", "party ("));
    // Only where the destination's advance filing takes House-level data (ICS2, AMS, Mercosur), and only
    // coded truthfully: a package without its code, or a commodity code too short for the tariff, is asked for.
    const houseCheck = houseDoc ? houseBillOfLadingFor(houseDoc) : null;
    if (houseCheck?.missing) missing.push(...houseCheck.missing);
    const houseBillsOfLading = houseDoc && houseCheck?.ok ? [houseBillOfLadingFrom(houseDoc, {
      routingCountries: legs.flatMap(l => [l.pol, l.pod]).map(c => String(c || "").slice(0, 2).toUpperCase()), notifyContact })] : [];
    for (const c of containers) {
      const gaps = [];
      if (!c.container_number || /^TBC$/i.test(c.container_number)) gaps.push("container number");
      if (!String(c.seal_number || "").trim()) gaps.push("seal number");
      if (!/^\d{6,10}$/.test(String(c.hs_code || "").replace(/\D/g, ""))) gaps.push("HS code (6–10 digits)");
      if (!(Number(c.gross_weight_kg) > 0)) gaps.push("gross weight");
      if (!String(c.cargo_description || "").trim()) gaps.push("cargo description");
      if (gaps.length) missing.push(`container ${c.container_number || `${c.size}' ${c.type}`}: ${gaps.join(", ")}`);
    }
    const parties = {
      shipper: await hb.dcsaParty(shipperRow, nvocc?.customer_name || shipment.shipper_name),
      consignee: (shipment.consignee_id || shipment.consignee_name) ? await hb.dcsaParty(consigneeRow, shipment.consignee_name) : null,
      notify: (shipment.notify_id || shipment.notify_name) ? await hb.dcsaParty(notifyRow, shipment.notify_name) : null,
    };
    // The carrier's Master B/L names its consignee by an identifying code (DCSA eBL 3.0.3 requires at least
    // one there), so instructions without one would come back asking for it.
    if (parties.consignee && !parties.consignee.identifyingCodes?.length)
      missing.push(`an identifying code (LEI, DUNS, FMC or an eBL platform id) on the consignee ${parties.consignee.partyName} (Customers → Identifiers): the carrier's Master B/L names the consignee by one`);
    const body = buildShippingInstructions({
      shipment, containers, reference,
      parties,
      contact: { name: office?.office_name || office?.branch_name || "", email: office?.email || "", phone: office?.phone || "" },
      houseBillsOfLading,
    });
    return { body, missing };
  }

  // ─── The carrier's answer (notification or poll) ───────────────────────────
  const LABEL = { RECEIVED: "received", PENDING_UPDATE: "update_requested", COMPLETED: "completed", DECLINED: "rejected", CANCELLED: "cancelled",
    UPDATE_RECEIVED: "received", UPDATE_CONFIRMED: "update_confirmed", UPDATE_DECLINED: "update_declined", UPDATE_CANCELLED: "update_cancelled" };
  // A draft Master B/L from these instructions means the carrier accepted them.
  const hasCarrierDraft = async si => !!(await query(`SELECT 1 FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' AND status<>'VOIDED'
    AND shipping_instructions_reference=$2 LIMIT 1`, [si.shipment_id, si.si_reference || ""]))[0];
  async function statusFor(si, main, upd) {
    if (main === "CANCELLED") return "Cancelled";
    // The correction sent after the carrier asked for one: PENDING_UPDATE with UPDATE_RECEIVED (the spec's
    // state after UseCase 2's update) is the carrier working on it, not a second rejection.
    if (main === "PENDING_UPDATE" && upd === "UPDATE_RECEIVED") return "Submitted";
    if (main === "DECLINED" || main === "PENDING_UPDATE") return "Rejected";
    if (main === "COMPLETED") return "Confirmed";
    if (main === "RECEIVED") return upd === "UPDATE_RECEIVED" ? "Submitted" : (await hasCarrierDraft(si)) ? "Confirmed" : "Submitted";
    return si.status;
  }
  // Applies a DCSA SI state to the record. A repeat (same states) records nothing. → { changed, shippingInstructions }
  async function applyShippingInstructionsState(si, state, { source = "callback", raw = null, simulated = false } = {}) {
    const main = state.shippingInstructionsStatus || "", upd = state.updatedShippingInstructionsStatus || "";
    // The transport document the carrier made from these instructions: kept, and fetched if CargoDesk
    // hasn't heard of it (a lost first DRAFT notification is found this way, by the poll as much as a notification).
    const tdRef = state.transportDocumentReference || "";
    if (tdRef && tdRef !== (si.transport_document_reference || "")) {
      await query("UPDATE shipping_instructions SET transport_document_reference=$1 WHERE id=$2", [tdRef, si.id]);
      si = { ...si, transport_document_reference: tdRef };
      const [held] = await query("SELECT 1 FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' AND reference=$2", [si.shipment_id, tdRef]);
      if (!held && ctx.applyTransportDocumentState)
        await ctx.applyTransportDocumentState(si, { transportDocumentReference: tdRef, transportDocumentStatus: "" }, { source: "poll", simulated }).catch(e => console.error(`Master B/L ${tdRef}:`, e.message));
      [si] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [si.id]);
    }
    if (main === (si.carrier_state || "") && upd === (si.carrier_updated_state || "")) return { changed: false, shippingInstructions: mapShippingInstructions(si) };
    const status = await statusFor(si, main, upd);
    const feedback = (state.feedbacks || []).map(f => f.message).filter(Boolean).join("; ");
    const reason = status === "Rejected" ? (feedback || (main === "PENDING_UPDATE" ? "The carrier asked for an update" : `The carrier ${main.toLowerCase()} the Shipping Instructions`))
      : upd === "UPDATE_DECLINED" ? (feedback || "The carrier declined the update; the instructions stand as they were") : "";
    const now = new Date().toISOString();
    await query(`UPDATE shipping_instructions SET status=$1, carrier_state=$2, carrier_updated_state=$3, carrier_feedback=$4, rejection_reason=$5,
      responded_at=$6, carrier_state_at=$6, updated_at=$6 WHERE id=$7`, [status, main, upd, feedback, reason, now, si.id]);
    const [shipment] = await query("SELECT carrier_code FROM shipments WHERE id=$1", [si.shipment_id]);
    await insertMessage(si.shipment_id, si.carrier_code || shipment?.carrier_code, si.id, "in",
      source === "poll" ? "shipping_instructions_status" : "shipping_instructions_notification", LABEL[upd && upd !== si.carrier_updated_state ? upd : main] || "received", raw || state, state, simulated);
    if (status !== si.status) await logEntityEvent("shipping_instructions", si.id, status.toUpperCase(), null, si.status, status,
      JSON.stringify({ carrierState: main, ...(upd ? { carrierUpdatedState: upd } : {}), ...(feedback ? { feedback } : {}) }));
    const [fresh] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [si.id]);
    return { changed: true, shippingInstructions: mapShippingInstructions(fresh) };
  }
  ctx.applyShippingInstructionsState = applyShippingInstructionsState;

  app.get("/api/shipments/:id/shipping-instructions", auth(), async (req, res) => {
    const [row] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    ok(res, row ? mapShippingInstructions(row) : null);
  });

  // Upsert the Draft — cutoff + special instructions only. Refused once Submitted/Confirmed
  // (reset first, same "no editing what's already in flight" rule customs filings enforce
  // implicitly by having no edit route at all once Filed).
  app.put("/api/shipments/:id/shipping-instructions", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const { siCutoff = "", specialInstructions = "" } = req.body || {};
    const [existing] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    const now = new Date().toISOString();
    if (existing) {
      if (existing.status !== "Draft") return err(res, `Cannot edit — this Shipping Instructions record is ${existing.status.toLowerCase()}. Reset it to Draft first.`, 409);
      await query(`UPDATE shipping_instructions SET si_cutoff=$1, special_instructions=$2, updated_at=$3 WHERE id=$4`,
        [siCutoff || null, specialInstructions, now, existing.id]);
    } else {
      await query(`INSERT INTO shipping_instructions (id, shipment_id, status, si_cutoff, special_instructions, created_at, updated_at)
        VALUES ($1,$2,'Draft',$3,$4,$5,$5)`, [`SI-${uid()}`, req.params.id, siCutoff || null, specialInstructions, now]);
    }
    const [row] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    ok(res, mapShippingInstructions(row), existing ? 200 : 201);
  });

  // Sends the DCSA Shipping Instructions: a new submission, or — after the carrier asked for an update
  // (PENDING_UPDATE) and the record was reopened — an update under the same reference. Nothing is
  // recorded as sent unless the carrier accepted it (202).
  app.post("/api/shipments/:id/shipping-instructions/submit", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const [si] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    if (!si) return err(res, "Save the Shipping Instructions details before submitting", 404);
    if (si.status !== "Draft") return err(res, `Already ${si.status.toLowerCase()}`, 409);
    const integ = await carrierIntegrationFor(shipment.carrier_code, "shipping-instructions");
    if (!integ?.adapter.submitShippingInstructions)
      return err(res, `No DCSA connection for ${shipment.carrier_code || "this carrier"} to send Shipping Instructions to: set one up under Carrier Integrations (or, for a demo, turn on App Settings → Demo carrier)`, 400);
    const update = !!si.si_reference && ["PENDING_UPDATE", "RECEIVED"].includes(si.carrier_state);
    const { body, missing } = await shippingInstructionsFor(shipment, { reference: update ? si.si_reference : "" });
    if (missing.length) return err(res, `Can't submit the Shipping Instructions yet: add ${missing.join("; ")}`, 400);
    const result = update
      ? await integ.adapter.updateShippingInstructions(integ.config, si.si_reference, body)
      : await integ.adapter.submitShippingInstructions(integ.config, body);
    if (!result.ok) return err(res, result.invalid ? `Can't submit the Shipping Instructions: ${String(result.error).replace(/^Not sent: /, "")}`
      : `${shipment.carrier_code} did not accept the Shipping Instructions (${result.error}). Nothing was changed — try again.`, result.invalid ? 400 : 502);
    const now = new Date().toISOString();
    const siRef = update ? si.si_reference : result.shippingInstructionsReference;
    await query(`UPDATE shipping_instructions SET status='Submitted', si_reference=$1, submitted_at=$2, submitted_by=$3, updated_at=$2,
      carrier_code=$4, is_mock=$5, rejection_reason='', carrier_state_at=$2 WHERE id=$6`,
      [siRef, now, req.user?.name || req.user?.email || "", shipment.carrier_code || "", !!integ.row.is_simulator, si.id]);
    const sent = await insertMessage(shipment.id, shipment.carrier_code, si.id, "out",
      update ? "shipping_instructions_update" : "shipping_instructions_submission", "sent", body,
      { shippingInstructionsReference: siRef, siCutoff: si.si_cutoff || null, specialInstructions: si.special_instructions || "" }, !!integ.row.is_simulator);
    // Direct, accurate trigger for si_submitted — sits alongside the pre-existing all-containers-
    // VGM-Submitted heuristic (TKT-OZD4V8) rather than replacing it; autoCompleteMilestone is a
    // no-op once already completed, so whichever signal arrives first wins.
    await ctx.milestoneEvents.onEvent(shipment.id, { eventType: "SHIPMENT", code: "RECEIVED", documentType: "SHIPPING_INSTRUCTIONS" },
      `Shipping Instructions submitted (reference ${siRef})`);
    await logEntityEvent('shipping_instructions', si.id, update ? 'UPDATE_SENT' : 'SUBMITTED', null, 'Draft', 'Submitted', JSON.stringify({ siReference: siRef }));
    const [fresh] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [si.id]);
    ok(res, { sent, shippingInstructions: mapShippingInstructions(fresh) }, 201);
  });

  // While the carrier holds the instructions (and hasn't issued the Master B/L), "Send update" sends the
  // shipment's data as it is now under the same reference: corrections made to the shipment since, or a
  // House B/L issued since (G25). The carrier redrafts from it.
  app.post("/api/shipments/:id/shipping-instructions/send-update", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const [si] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    if (!si) return err(res, "Shipping Instructions not found", 404);
    if (!["Submitted", "Confirmed"].includes(si.status) || si.carrier_state !== "RECEIVED")
      return err(res, `An update goes to Shipping Instructions the carrier holds (these are ${si.status.toLowerCase()})`, 409);
    if (si.carrier_updated_state === "UPDATE_RECEIVED") return err(res, "The carrier hasn't worked in the last update yet: wait for it, or cancel it first", 409);
    const [master] = await query("SELECT reference, status FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' AND status NOT IN ('DRAFT','APPROVED','VOIDED') LIMIT 1", [shipment.id]);
    if (master) return err(res, `The carrier has already ${master.status.toLowerCase().replace(/_/g, " ")} Master B/L ${master.reference}: the instructions can't change now`, 409);
    const integ = await carrierIntegrationFor(si.carrier_code || shipment.carrier_code, "shipping-instructions");
    if (!integ?.adapter.updateShippingInstructions) return err(res, `No DCSA connection for ${si.carrier_code || shipment.carrier_code}`, 400);
    const { body, missing } = await shippingInstructionsFor(shipment, { reference: si.si_reference });
    if (missing.length) return err(res, `Can't send the update yet: add ${missing.join("; ")}`, 400);
    const result = await integ.adapter.updateShippingInstructions(integ.config, si.si_reference, body);
    if (!result.ok) return err(res, result.invalid ? `Can't send the update: ${String(result.error).replace(/^Not sent: /, "")}`
      : `${si.carrier_code} did not accept the update (${result.error}). Nothing was changed — try again.`, result.invalid ? 400 : 502);
    const now = new Date().toISOString();
    await query("UPDATE shipping_instructions SET status='Submitted', submitted_at=$1, submitted_by=$2, updated_at=$1 WHERE id=$3",
      [now, req.user?.name || req.user?.email || "", si.id]);
    const sent = await insertMessage(shipment.id, si.carrier_code, si.id, "out", "shipping_instructions_update", "sent", body,
      { shippingInstructionsReference: si.si_reference, houseBillsOfLading: (body.houseBillOfLadings || []).map(h => h.houseBillOfLadingReference) }, !!integ.row.is_simulator);
    await logEntityEvent('shipping_instructions', si.id, 'UPDATE_SENT', null, si.status, 'Submitted', JSON.stringify({ siReference: si.si_reference }));
    const [fresh] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [si.id]);
    ok(res, { sent, shippingInstructions: mapShippingInstructions(fresh) }, 201);
  });

  // Cancel the instructions at the carrier (not once it has issued the Master B/L), or with `update`
  // only the update it hasn't worked in yet. The carrier's CANCELLED / UPDATE_CANCELLED notification
  // moves the record.
  app.post("/api/shipments/:id/shipping-instructions/cancel", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const [si] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    if (!si?.si_reference) return err(res, "These Shipping Instructions haven't been sent to the carrier", 409);
    const update = !!req.body?.update;
    if (update && si.carrier_updated_state !== "UPDATE_RECEIVED") return err(res, "There is no update waiting at the carrier to cancel", 409);
    if (!update && !["RECEIVED", "PENDING_UPDATE"].includes(si.carrier_state)) return err(res, `Shipping Instructions that are ${String(si.carrier_state || si.status).toLowerCase()} can't be cancelled`, 409);
    const [master] = await query("SELECT reference, status FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' AND status NOT IN ('DRAFT','APPROVED','VOIDED') LIMIT 1", [shipment.id]);
    if (master && !update) return err(res, `The carrier has already ${master.status.toLowerCase().replace(/_/g, " ")} Master B/L ${master.reference}: the instructions can't be cancelled now`, 409);
    const integ = await carrierIntegrationFor(si.carrier_code || shipment.carrier_code, "shipping-instructions");
    if (!integ?.adapter.cancelShippingInstructions) return err(res, `No DCSA connection for ${si.carrier_code || shipment.carrier_code}`, 400);
    const r = await integ.adapter.cancelShippingInstructions(integ.config, si.si_reference, { update });
    if (!r.ok) return err(res, `${si.carrier_code} did not accept the cancellation (${r.error}). Nothing was changed.`, r.invalid ? 400 : 502);
    await insertMessage(shipment.id, si.carrier_code, si.id, "out", update ? "shipping_instructions_update_cancellation" : "shipping_instructions_cancellation", "sent",
      update ? { updatedShippingInstructionsStatus: "UPDATE_CANCELLED" } : { shippingInstructionsStatus: "CANCELLED" },
      { shippingInstructionsReference: si.si_reference }, !!integ.row.is_simulator);
    await logEntityEvent('shipping_instructions', si.id, update ? 'UPDATE_CANCELLATION_SENT' : 'CANCELLATION_SENT', null, si.status, si.status, JSON.stringify({ siReference: si.si_reference }));
    // The carrier's notification usually lands while this answers; wait briefly for it.
    let fresh = si;
    for (let i = 0; i < 20; i++) {
      [fresh] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [si.id]);
      if (update ? fresh.carrier_updated_state !== "UPDATE_RECEIVED" : fresh.carrier_state === "CANCELLED") break;
      await new Promise(r2 => setTimeout(r2, 100));
    }
    ok(res, mapShippingInstructions(fresh));
  });

  // Test Tools: the built-in DCSA carrier accepts the Shipping Instructions by drafting its Master B/L from
  // them, or asks for an update (its notification comes back through the carrier webhook, as a real
  // carrier's would). Shipping Instructions sent to a real carrier are answered by that carrier only.
  app.post("/api/shipments/:id/shipping-instructions/simulate-response", write, async (req, res) => {
    const [si] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    if (!si) return err(res, "Shipping Instructions not found", 404);
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const { outcome, reason } = req.body || {};
    if (outcome !== "confirmed" && outcome !== "rejected") return err(res, 'outcome must be "confirmed" or "rejected"');
    if (si.status !== "Submitted") return err(res, "This Shipping Instructions record has no pending submission to respond to", 409);
    if (!si.is_mock) return err(res, `These Shipping Instructions went to ${si.carrier_code || "the carrier"}, which answers them itself`, 409);
    const r = await ctx.dcsaSimulator.actShippingInstructions(si.si_reference, outcome === "confirmed" ? "draft" : "requestUpdate",
      { message: outcome === "rejected" ? (reason?.trim() || "Shipping Instructions rejected — data did not match the booking.") : "" });
    if (!r.ok) return err(res, r.error, r.status || 409);
    const [fresh] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [si.id]);
    ok(res, mapShippingInstructions(fresh), 201);
  });

  // Reopens a rejected record for correction. After a PENDING_UPDATE the next Submit sends a DCSA update
  // under the same reference; after a final DECLINED / CANCELLED it sends new Shipping Instructions.
  app.patch("/api/shipments/:id/shipping-instructions/reset", write, async (req, res) => {
    const [si] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    if (!si) return err(res, "Shipping Instructions not found", 404);
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    if (!["Rejected", "Cancelled"].includes(si.status)) return err(res, "Only Rejected or Cancelled Shipping Instructions can be reset to Draft", 409);
    const now = new Date().toISOString();
    const keep = si.carrier_state === "PENDING_UPDATE";
    await query(`UPDATE shipping_instructions SET status='Draft', si_reference=$1, carrier_state=$2, carrier_updated_state=$3, updated_at=$4 WHERE id=$5`,
      [keep ? si.si_reference : "", keep ? si.carrier_state : "", keep ? si.carrier_updated_state || "" : "", now, si.id]);
    await logEntityEvent('shipping_instructions', si.id, 'RESET', null, 'Rejected', 'Draft', null);
    const [fresh] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [si.id]);
    ok(res, mapShippingInstructions(fresh));
  });

  // Cross-shipment list for the Test Tools Filing Simulator picker — mirrors GET /api/customs-filings.
  app.get("/api/shipping-instructions", auth(), async (req, res) => {
    const { status } = req.query;
    const rows = status
      ? await query("SELECT * FROM shipping_instructions WHERE status=$1 ORDER BY updated_at DESC", [status])
      : await query("SELECT * FROM shipping_instructions ORDER BY updated_at DESC");
    if (rows.length === 0) return ok(res, []);
    const shipmentIds = [...new Set(rows.map(r => r.shipment_id))];
    const ph = shipmentIds.map((_, i) => `$${i + 1}`).join(",");
    const shipmentRows = await query(`SELECT * FROM shipments WHERE id IN (${ph})`, shipmentIds);
    const allowedShipments = await applyShipmentAccessFilter(shipmentRows.map(mapShipment), req.user, req);
    const shipmentById = new Map(allowedShipments.map(s => [s.id, s]));
    ok(res, rows.filter(r => shipmentById.has(r.shipment_id))
      .map(r => ({ ...mapShippingInstructions(r), shipment: shipmentById.get(r.shipment_id) })));
  });

  // ─── Polling: Shipping Instructions the carrier hasn't been heard from about ─
  // Same reason as the booking poll (routes/edi.js): a lost notification would leave them Submitted.
  const SI_POLL_MINUTES = 15;
  async function pollShippingInstructionsSweep({ olderThanMinutes = SI_POLL_MINUTES } = {}) {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();
    // Submitted, and Confirmed ones the carrier hasn't finished with (a lost COMPLETED after the surrender).
    const rows = await query(`SELECT * FROM shipping_instructions WHERE status IN ('Submitted','Confirmed') AND COALESCE(si_reference,'') <> ''
      AND COALESCE(carrier_code,'') <> '' AND COALESCE(carrier_state,'') NOT IN ('COMPLETED','CANCELLED','DECLINED')
      AND (carrier_state_at IS NULL OR carrier_state_at <= $1)`, [cutoff]);
    const summary = { polled: 0, changed: 0, failed: 0 };
    for (const si of rows) {
      const integ = await carrierIntegrationFor(si.carrier_code, "shipping-instructions").catch(() => null);
      if (!integ?.adapter.getShippingInstructions) continue;
      const r = await integ.adapter.getShippingInstructions(integ.config, si.si_reference);
      if (!r.ok) { summary.failed++; continue; }
      summary.polled++;
      if ((await applyShippingInstructionsState(si, r.state, { source: "poll", raw: r.raw, simulated: !!integ.row.is_simulator })).changed) summary.changed++;
      else await query("UPDATE shipping_instructions SET carrier_state_at=$1 WHERE id=$2", [new Date().toISOString(), si.id]);
    }
    return summary;
  }
  ctx.pollShippingInstructionsSweep = pollShippingInstructionsSweep;
  app.post("/api/shipping-instructions/poll-sweep", requireRole(["admin"]), async (req, res) => ok(res, await pollShippingInstructionsSweep({ olderThanMinutes: 0 })));
  const pollTimer = setInterval(() => { pollShippingInstructionsSweep().catch(e => console.error("Shipping Instructions poll sweep failed:", e.message)); },
    SI_POLL_MINUTES * 60000);
  pollTimer.unref?.();
};
