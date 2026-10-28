"use strict";
// The demo carrier's Track & Trace 3.0 (DCSA-everywhere phase 6, 2026-10-28). State in dcsa_sim_events.
//
// Test Tools makes the carrier report something about one of its bookings (report): the containers gated
// in at the port of loading, loaded, the vessel departed, arrived, the containers discharged, released by
// customs, gated out, returned empty, the cargo released. The carrier builds the DCSA events, keeps them,
// and pushes them to CargoDesk (POST …/events, signed like its notifications); it also serves them at
// GET /events, which CargoDesk pulls with "Sync carrier events". A report repeated under the same kind
// keeps the same eventID, so it replaces the earlier event (an updated estimate, a corrected time), and a
// retraction sends the event again with isRetracted.

const { validateOutbound, validateOutboundSchema, errorsText } = require("../dcsa/validate");

const KINDS = {
  gateIn:          { eventType: "EQUIPMENT", code: "GATED_IN", empty: "LADEN", at: "pol", perContainer: true },
  loaded:          { eventType: "EQUIPMENT", code: "LOADED", empty: "LADEN", at: "pol", perContainer: true },
  departed:        { eventType: "TRANSPORT", code: "DEPARTED", at: "pol", estimable: true },
  arrived:         { eventType: "TRANSPORT", code: "ARRIVED", at: "pod", estimable: true },
  discharged:      { eventType: "EQUIPMENT", code: "DISCHARGED", empty: "LADEN", at: "pod", perContainer: true },
  customsReleased: { eventType: "EQUIPMENT", code: "CUSTOMS_RELEASED", empty: "LADEN", at: "pod", perContainer: true },
  gateOut:         { eventType: "EQUIPMENT", code: "GATED_OUT", empty: "LADEN", at: "pod", perContainer: true },
  emptyReturn:     { eventType: "EQUIPMENT", code: "GATED_IN", empty: "EMPTY", at: "pod", perContainer: true },
  released:        { eventType: "SHIPMENT", code: "RELEASED", at: "pod" },
};
const CLASSIFIERS = ["ACTUAL", "ESTIMATED", "PLANNED"];
const typeKey = { EQUIPMENT: "equipmentEventType", TRANSPORT: "transportEventType", SHIPMENT: "shipmentEventType" };

module.exports = function createSimTrackTrace({ query, deliver }) {
  const clean = s => String(s || "").replace(/[^A-Za-z0-9]/g, "");

  /**
   * @param {string} kind  one of KINDS
   * @param {object} o     { carrierCode, bookingRef, containers: [{ number, iso }], pol, pod, vessel: { imo, name }, voyage,
   *                         dateTime (ISO; default now), classifier (departed/arrived may be ESTIMATED / PLANNED), tdRef,
   *                         updatedAt (eventUpdatedDateTime; default now — an earlier one makes an out-of-date copy),
   *                         routeBy: "vessel" (a vessel event naming no document: only the vessel and voyage) }
   * → { ok, events, delivery } | { ok:false, status, error }
   */
  async function report(kind, o) {
    const k = KINDS[kind];
    if (!k) return { ok: false, status: 400, error: `Unknown event "${kind}" (${Object.keys(KINDS).join(", ")})` };
    const classifier = String(o.classifier || "ACTUAL").toUpperCase();
    if (!CLASSIFIERS.includes(classifier)) return { ok: false, status: 400, error: "classifier must be ACTUAL, ESTIMATED or PLANNED" };
    if (classifier !== "ACTUAL" && !k.estimable) return { ok: false, status: 400, error: `Only a departure or an arrival can be ${classifier.toLowerCase()}` };
    if (!o.bookingRef) return { ok: false, status: 409, error: "The booking has no carrier booking number yet" };
    const place = o[k.at];
    if (!place) return { ok: false, status: 409, error: `The shipment has no ${k.at.toUpperCase()}` };
    if (k.perContainer && !(o.containers || []).filter(c => c.number).length) return { ok: false, status: 409, error: "The shipment has no numbered containers" };
    const at = o.dateTime || new Date().toISOString();
    const updated = o.updatedAt || new Date().toISOString();
    if (o.routeBy === "vessel" && (k.eventType !== "TRANSPORT" || !o.voyage)) return { ok: false, status: 400, error: "Only a departure or an arrival with a voyage can name just the vessel" };
    const base = (suffix = "") => ({
      eventID: `${clean(o.bookingRef)}-${kind}-${classifier.slice(0, 3)}${suffix ? `-${clean(suffix)}` : ""}`.slice(0, 100),
      eventDateTime: at, eventUpdatedDateTime: updated,
      eventClassification: { eventType: k.eventType, eventClassifier: classifier, [typeKey[k.eventType]]: k.code },
      eventLocation: { UNLocationCode: place },
      // A cargo release is against the Master B/L when there is one, else a container release order; the
      // booking is named too (additionalDocumentReferences).
      shipmentDetails: k.eventType === "SHIPMENT"
        ? { documentReference: o.tdRef ? { type: "TRANSPORT_DOCUMENT", reference: o.tdRef } : { type: "CONTAINER_RELEASE_ORDER", reference: `CRO-${o.bookingRef}` },
            additionalDocumentReferences: [{ type: "BOOKING", reference: o.bookingRef }] }
        : { documentReference: { type: "BOOKING", reference: o.bookingRef } },
    });
    const vesselOnly = o.routeBy === "vessel";
    const transport = (o.vessel?.imo || o.vessel?.name) ? { transportDetails: { transportCall: { modeOfTransport: "VESSEL",
      vesselTransport: { ...(o.vessel.imo ? { vesselIMONumber: String(o.vessel.imo) } : {}), ...(o.vessel.name ? { vesselName: o.vessel.name } : {}) },
      ...(o.voyage ? { exportVoyageNumberOrReference: { carrierVoyageNumber: o.voyage } } : {}) } } } : {};
    const events = k.perContainer
      ? o.containers.filter(c => c.number).map(c => ({ ...base(c.number), ...transport,
          equipmentDetails: { equipmentReference: c.number, ...(c.iso ? { ISOEquipmentCode: c.iso } : {}), emptyIndicator: k.empty } }))
      : [(({ shipmentDetails, ...rest }) => (vesselOnly ? { ...rest, ...transport } : { ...base(), ...transport }))(base())];
    for (const ev of events) {
      const v = validateOutboundSchema("tnt", "Event", ev);
      if (!v.ok) return { ok: false, status: 500, error: `The demo carrier built an invalid Track & Trace event: ${errorsText(v.errors, 4)}` };
      await query(`INSERT INTO dcsa_sim_events (event_id, carrier_code, carrier_booking_ref, equipment_reference, event_type, event_json, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (event_id) DO UPDATE SET event_json=EXCLUDED.event_json, updated_at=EXCLUDED.updated_at`,
        [ev.eventID, o.carrierCode || "", o.bookingRef, ev.equipmentDetails?.equipmentReference || "", k.eventType, JSON.stringify(ev), updated]);
    }
    return { ok: true, events, delivery: await push(events) };
  }

  async function push(events) {
    const body = { events };
    const v = validateOutbound("tnt", "post", "/events", body);
    if (!v.ok) throw new Error(`The demo carrier built an invalid POST /events: ${errorsText(v.errors, 4)}`);
    return deliver(body, { path: "/events", retries: [250, 1000] });
  }

  async function retract(eventId) {
    const [row] = await query("SELECT * FROM dcsa_sim_events WHERE event_id=$1", [eventId]);
    if (!row) return { ok: false, status: 404, error: `The demo carrier reported no event ${eventId}` };
    // As little as the spec needs: the event's id, retracted, when (every earlier copy is discarded).
    const ev = { eventID: eventId, isRetracted: true, eventUpdatedDateTime: new Date().toISOString() };
    await query("UPDATE dcsa_sim_events SET event_json=$1, updated_at=$2 WHERE event_id=$3", [JSON.stringify(ev), ev.eventUpdatedDateTime, eventId]);
    return { ok: true, events: [ev], delivery: await push([ev]) };
  }

  async function list({ bookingRef = "" } = {}) {
    const rows = bookingRef
      ? await query("SELECT * FROM dcsa_sim_events WHERE carrier_booking_ref=$1 ORDER BY updated_at DESC", [bookingRef])
      : await query("SELECT * FROM dcsa_sim_events ORDER BY updated_at DESC LIMIT 200");
    return rows.map(r => JSON.parse(r.event_json));
  }

  // GET /events (T&T 3.0): by booking, container or transport document; eventTypes; a cursor that is the
  // offset of the next page, returned in Next-Page-Cursor.
  function registerRoutes(app) {
    app.get("/dcsa-sim/events", async (req, res) => {
      const { carrierBookingReference = "", equipmentReference = "", eventTypes = "", limit = "100", cursor = "0" } = req.query;
      if (!carrierBookingReference && !equipmentReference)
        return res.status(400).json({ feedbackElements: [{ severity: "ERROR", message: "Give a carrierBookingReference or an equipmentReference" }] });
      const types = String(eventTypes || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
      const rows = await query(`SELECT * FROM dcsa_sim_events WHERE ($1='' OR carrier_booking_ref=$1) AND ($2='' OR equipment_reference=$2)
        ORDER BY updated_at, event_id`, [String(carrierBookingReference), String(equipmentReference)]);
      const all = rows.filter(r => !types.length || types.includes(r.event_type)).map(r => JSON.parse(r.event_json));
      const from = Math.max(0, Number(cursor) || 0), size = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const page = all.slice(from, from + size);
      if (from + size < all.length) res.setHeader("Next-Page-Cursor", String(from + size));
      res.json({ events: page });
    });
  }

  return { report, retract, list, registerRoutes, KINDS: Object.keys(KINDS) };
};
