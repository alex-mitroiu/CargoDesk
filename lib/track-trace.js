"use strict";
// Track & Trace 3.0 events into CargoDesk (DCSA-everywhere phase 6, 2026-10-28), built once as ctx.trackTrace.
// The pull (routes/carrier-tracking.js, GET /events) and the push (routes/carrier-webhooks.js, POST …/events)
// both end here. For each event the carrier sent about a shipment:
//
//   1. it is kept in carrier_events, as DCSA classified it, by its eventID. T&T 3.0: an event overrides one
//      with the same eventID and an earlier eventUpdatedDateTime — so an older copy (a retried push that
//      arrives late) is ignored, a newer one corrects what the earlier made (container events' times, leg
//      times), and a retraction (isRetracted) discards it and undoes what CargoDesk made from it: the
//      container events, and the leg time it set (back to what it was, if nothing changed it since);
//   2. an ACTUAL equipment or transport event in CargoDesk's container lifecycle becomes a container event
//      (lib/carrier-integrations/tnt-mapping.js decides which; the user's 2026-10-09 rules: loaded only at
//      the POL, discharged only at the POD, the vessel's departure from the POL sails every container);
//   3. a TRANSPORT event moves the times of the sea leg it is about (applyVesselTime): the carrier's ACTUAL
//      departure or arrival confirms the leg's date (source 'dcsa_actual', which only the carrier changes);
//      an ESTIMATED or PLANNED one updates the date (source 'dcsa') unless a confirmed time is already
//      there. AIS (lib/ais-listener.js) only confirms what the carrier hasn't;
//   4. an ACTUAL event completes the milestones it matches (lib/milestone-events.js).
// `applied` on each stored event says, in plain words, what of this happened; `derived` keeps the leg
// times it changed, for a retraction to undo. One batch per shipment runs at a time (a pull and a push for
// the same shipment can't interleave and double the container events).
//
// Review fixes 2026-10-28: eventUpdatedDateTime ordering, retraction routing and undo, corrections, vessel
// routing needs a voyage and a matching date, every document reference counts, the strict sea-leg test.

const { mapTrackTraceEvents } = require("./carrier-integrations/tnt-mapping");
const { CONTAINER_EVENT_DCSA, describeMatcher } = require("./dcsa/codes");

const up = s => String(s || "").trim().toUpperCase();
const nowIso = () => new Date().toISOString();
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };
// The sea legs: leg_type decides; mot only when leg_type is blank (server.js syncShipmentFromLegs: a
// Delivery leg can carry a stale mot='SEA').
const SEA_LEG = "(leg_type='SEA' OR (COALESCE(leg_type,'')='' AND mot='SEA'))";
const SEA_LEG_L = "(l.leg_type='SEA' OR (COALESCE(l.leg_type,'')='' AND l.mot='SEA'))";
// How far a vessel event's date may be from a leg's own date to be about that leg (another rotation of
// the same vessel and voyage number is months away).
const VESSEL_WINDOW_DAYS = 21;

// The parts of a Track & Trace 3.0 event CargoDesk keeps.
function factsOf(ev = {}) {
  const c = ev.eventClassification || {};
  const sd = ev.shipmentDetails || {};
  const doc = sd.documentReference || {};
  const tc = ev.transportDetails?.transportCall || {};
  return {
    eventId: ev.eventID || "",
    updatedAt: ev.eventUpdatedDateTime || "",
    eventType: up(c.eventType),
    code: up(c.equipmentEventType || c.transportEventType || c.shipmentEventType || c.iotEventType || c.reeferEventType),
    classifier: up(c.eventClassifier),
    dateTime: ev.eventDateTime || "",
    unLocationCode: up(ev.eventLocation?.UNLocationCode),
    locationName: ev.eventLocation?.locationName || "",
    equipmentReference: up(ev.equipmentDetails?.equipmentReference),
    emptyIndicator: up(ev.equipmentDetails?.emptyIndicator),
    documentType: up(doc.type),
    documentReference: doc.reference || "",
    references: [doc, ...(Array.isArray(sd.additionalDocumentReferences) ? sd.additionalDocumentReferences : [])]
      .filter(r => r?.reference).map(r => ({ type: up(r.type), reference: String(r.reference) })),
    vesselImo: tc.vesselTransport?.vesselIMONumber || "",
    vesselName: tc.vesselTransport?.vesselName || "",
    voyage: tc.exportVoyageNumberOrReference?.carrierVoyageNumber || tc.importVoyageNumberOrReference?.carrierVoyageNumber || "",
    isRetracted: !!ev.isRetracted,
  };
}

module.exports = function createTrackTrace(ctx) {
  const { query, uid, logEvent, logEntityEvent } = ctx;

  // ─── Vessel times on the shipment's sea legs (T&T 3.0 and OVS 3.0 alike) ────
  // field 'etd' (a departure from the leg's POL) or 'eta' (an arrival at its POD). → the change, or null.
  async function applyVesselTime(shipmentId, { field, unLocationCode, classifier, dateTime, vesselImo = "", source = "Track & Trace", carrierCode = "" }) {
    const date = String(dateTime || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !unLocationCode) return null;
    const legs = await query(`SELECT * FROM shipment_legs WHERE shipment_id=$1 AND ${SEA_LEG} ORDER BY leg_order`, [shipmentId]);
    const leg = legs.find(l => up(field === "etd" ? l.pol : l.pod) === unLocationCode
      && !(vesselImo && l.vessel_imo && String(l.vessel_imo) !== String(vesselImo)));
    if (!leg) return null;
    const sourceCol = `${field}_source`, actual = classifier === "ACTUAL";
    const current = String(leg[field] || "").slice(0, 10), currentSource = leg[sourceCol] || "";
    if (!actual && ["ais", "dcsa_actual"].includes(currentSource)) return null; // a confirmed time stays
    const nextSource = actual ? "dcsa_actual" : "dcsa";
    if (current === date && currentSource === nextSource) return null;
    await setLegTime(leg, field, date, nextSource, { classifier, source, carrierCode, previous: current, previousSource: currentSource });
    return { legId: leg.id, field, from: current, fromSource: currentSource, to: date, toSource: nextSource, classifier,
      text: `${field === "etd" ? "ETD" : "ETA"} ${actual ? "confirmed" : "set to"} ${date} (${actual ? "carrier actual" : "carrier estimate"}, ${unLocationCode})` };
  }
  async function setLegTime(leg, field, date, source, detail) {
    await query(`UPDATE shipment_legs SET ${field}=$1, ${field}_source=$2 WHERE id=$3`, [date || null, source, leg.id]);
    await ctx.syncShipmentFromLegs(leg.shipment_id, `${detail.carrierCode || "Carrier"} ${detail.source}`);
    const actual = source === "dcsa_actual";
    await logEntityEvent("shipment_leg", leg.id, detail.undo ? "CARRIER_TIME_RETRACTED"
      : actual ? (field === "etd" ? "CARRIER_DEPARTURE_CONFIRMED" : "CARRIER_ARRIVAL_CONFIRMED") : "CARRIER_TIME_ESTIMATED",
      field, detail.previous || "", date || "", JSON.stringify({ shipmentId: leg.shipment_id, classifier: detail.classifier || "", source: detail.source,
        carrierCode: detail.carrierCode || "", previousSource: detail.previousSource || "", nextSource: source }));
  }
  // A retracted event's leg times go back to what they were — only where the leg still shows what the
  // event set (a later event, AIS or a person may have changed it since).
  async function undoLegTimes(derived, carrierCode) {
    const undone = [];
    for (const t of derived?.legTimes || []) {
      const [leg] = await query("SELECT * FROM shipment_legs WHERE id=$1", [t.legId]);
      if (!leg || String(leg[t.field] || "").slice(0, 10) !== t.to || (leg[`${t.field}_source`] || "") !== t.toSource) continue;
      await setLegTime(leg, t.field, t.from, t.fromSource || "", { carrierCode, source: "Track & Trace retraction", undo: true, previous: t.to, previousSource: t.toSource });
      undone.push(`${t.field === "etd" ? "ETD" : "ETA"} back to ${t.from || "blank"}`);
    }
    return undone;
  }

  // ─── One batch at a time per shipment ───────────────────────────────────────
  const running = new Map();
  function serialized(shipmentId, fn) {
    const prev = running.get(shipmentId) || Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.catch(() => {});
    running.set(shipmentId, settled);
    settled.then(() => { if (running.get(shipmentId) === settled) running.delete(shipmentId); });
    return run;
  }
  const applyEvents = (shipment, events, opts) => serialized(shipment.id, () => applyEventsNow(shipment, events, opts));

  // Of several copies of one event in a batch, the one updated last (the T&T 3.0 override rule).
  function newestCopies(events) {
    const byId = new Map(), loose = [];
    for (const ev of Array.isArray(events) ? events : []) {
      if (!ev?.eventID) { loose.push(ev); continue; }
      const had = byId.get(ev.eventID);
      if (!had || String(ev.eventUpdatedDateTime || "") >= String(had.eventUpdatedDateTime || "")) byId.set(ev.eventID, ev);
    }
    return [...byId.values(), ...loose];
  }

  // → { received, added, alreadyRecorded, skipped, stored, legTimes, milestones, retracted }
  async function applyEventsNow(shipment, events, { carrierCode = "", via = "pull", simulated = false } = {}) {
    const containers = await query("SELECT * FROM containers WHERE shipment_id=$1", [shipment.id]);
    const existingCtrEvents = await query("SELECT container_id, event_type, carrier_event_id FROM container_events WHERE shipment_id=$1", [shipment.id]);
    const seenId = new Set(existingCtrEvents.filter(e => e.carrier_event_id).map(e => `${e.container_id}|${e.carrier_event_id}`));
    const seenType = new Set(existingCtrEvents.map(e => `${e.container_id}|${e.event_type}`));
    const out = { received: Array.isArray(events) ? events.length : 0, added: [], alreadyRecorded: 0, skipped: [], stored: 0, legTimes: [], milestones: [], retracted: 0 };
    const sorted = newestCopies(events).sort((a, b) => String(a?.eventDateTime || "").localeCompare(String(b?.eventDateTime || "")));
    const actor = `${carrierCode || "Carrier"} Track & Trace`;
    // Milestone names for the plain-words record of what each event did.
    const names = new Map((await query("SELECT milestone_key, label FROM shipment_milestones WHERE shipment_id=$1", [shipment.id])).map(m => [m.milestone_key, m.label]));
    const completedText = k => `${names.get(k) || k} completed`;

    for (const ev of sorted) {
      const f = factsOf(ev);
      const [stored] = f.eventId ? await query("SELECT * FROM carrier_events WHERE shipment_id=$1 AND carrier_event_id=$2", [shipment.id, f.eventId]) : [];
      const payload = JSON.stringify(ev);
      const now = nowIso();
      if (stored && stored.payload === payload) { out.alreadyRecorded++; continue; }
      if (stored && stored.event_updated_at && f.updatedAt && f.updatedAt < stored.event_updated_at) {
        out.skipped.push({ eventId: f.eventId, reason: "an older copy of an event already held (eventUpdatedDateTime)" });
        continue;
      }

      // Retracted: discard it and undo what CargoDesk made from it. Milestones it completed stay completed
      // (a person can reopen one); the History tab says what was retracted.
      if (f.isRetracted) {
        if (stored?.is_retracted) { out.alreadyRecorded++; continue; }
        const removed = f.eventId ? await query("DELETE FROM container_events WHERE shipment_id=$1 AND carrier_event_id=$2 RETURNING id", [shipment.id, f.eventId]) : [];
        const undone = stored ? await undoLegTimes(parse(stored.derived, {}), carrierCode) : [];
        // A retracted vessel time falls back to the carrier's newest estimate of it still standing.
        if (undone.length && stored.event_type === "TRANSPORT" && ["DEPARTED", "ARRIVED"].includes(stored.event_code)) {
          const [est] = await query(`SELECT * FROM carrier_events WHERE shipment_id=$1 AND event_type='TRANSPORT' AND event_code=$2 AND un_location_code=$3
            AND event_classifier IN ('ESTIMATED','PLANNED') AND NOT is_retracted AND id<>$4 ORDER BY event_updated_at DESC, updated_at DESC LIMIT 1`,
            [shipment.id, stored.event_code, stored.un_location_code, stored.id]);
          if (est) {
            const t = await applyVesselTime(shipment.id, { field: stored.event_code === "DEPARTED" ? "etd" : "eta", unLocationCode: est.un_location_code,
              classifier: est.event_classifier, dateTime: est.event_date_time, vesselImo: est.vessel_imo, carrierCode, source: "Track & Trace" });
            if (t) undone.push(`the carrier's estimate stands again: ${t.text}`);
          }
        }
        const note = ["Retracted by the carrier", removed.length ? `${removed.length} container event(s) made from it removed` : "", ...undone].filter(Boolean).join("; ");
        if (stored) await query("UPDATE carrier_events SET is_retracted=TRUE, applied=$1, payload=$2, event_updated_at=$3, updated_at=$4 WHERE id=$5",
          [note, payload, f.updatedAt || stored.event_updated_at || "", now, stored.id]);
        else await insertEvent(shipment.id, f, { carrierCode, via, simulated, payload, applied: note, retracted: true });
        if (stored || removed.length) await logEvent(shipment.id, "CARRIER_EVENT_RETRACTED", null, `${f.eventType} ${f.code}`, "",
          JSON.stringify({ eventId: f.eventId, removedContainerEvents: removed.length, legTimes: undone }), actor);
        out.retracted++;
        out.skipped.push({ eventId: f.eventId, reason: note });
        continue;
      }

      const applied = [];
      const derived = { legTimes: [] };
      // A newer version of an event already held (not retracted): what it made is corrected in place.
      if (stored && !stored.is_retracted) {
        const fixed = await query(`UPDATE container_events SET occurred_at=$1, location=CASE WHEN $2<>'' THEN $2 ELSE location END,
          un_location_code=CASE WHEN $3<>'' THEN $3 ELSE un_location_code END WHERE shipment_id=$4 AND carrier_event_id=$5 RETURNING id`,
          [f.dateTime, [f.unLocationCode, f.locationName].filter(Boolean).join(" · "), f.unLocationCode, shipment.id, f.eventId]);
        if (fixed.length) applied.push(`corrected ${fixed.length} container event(s) made from it`);
        derived.legTimes = parse(stored.derived, {}).legTimes || [];
      }
      // 2. Container lifecycle (actual events only; tnt-mapping says which, and why not).
      const { add, skipped } = mapTrackTraceEvents([ev], { pol: shipment.pol, pod: shipment.pod,
        containers: containers.map(c => ({ id: c.id, containerNumber: c.container_number })) });
      if (!stored) for (const s of skipped) out.skipped.push(s);
      for (const a of add) {
        if (seenId.has(`${a.containerId}|${a.carrierEventId}`) || seenType.has(`${a.containerId}|${a.eventType}`)) { if (!stored) out.alreadyRecorded++; continue; }
        const ctr = containers.find(c => c.id === a.containerId);
        const cls = CONTAINER_EVENT_DCSA[a.eventType] || {};
        const recorded = await ctx.recordContainerEvent(ctr, {
          eventType: a.eventType, occurredAt: a.occurredAt, location: a.location, notes: `From ${carrierCode || "the carrier"} Track & Trace`,
          recordedBy: actor, carrierEventId: a.carrierEventId,
          dcsa: { eventType: f.eventType || cls.eventType, code: f.code || cls.code, classifier: "ACTUAL",
            emptyIndicator: f.emptyIndicator || cls.emptyIndicator || "", unLocationCode: f.unLocationCode },
        });
        out.added.push(recorded);
        seenId.add(`${a.containerId}|${a.carrierEventId}`);
        seenType.add(`${a.containerId}|${a.eventType}`);
        applied.push(`${a.eventType} recorded for ${a.containerNumber}`);
        for (const k of recorded.milestonesCompleted || []) { out.milestones.push(k); applied.push(completedText(k)); }
      }
      // 3. Vessel times.
      if (f.eventType === "TRANSPORT" && ["DEPARTED", "ARRIVED"].includes(f.code)) {
        const t = await applyVesselTime(shipment.id, { field: f.code === "DEPARTED" ? "etd" : "eta", unLocationCode: f.unLocationCode,
          classifier: f.classifier, dateTime: f.dateTime, vesselImo: f.vesselImo, carrierCode, source: "Track & Trace" });
        if (t) {
          out.legTimes.push(t); applied.push(t.text);
          // An undo restores what the leg showed before this event at all: the first "from" is kept.
          const prev = derived.legTimes.find(x => x.legId === t.legId && x.field === t.field);
          if (prev) Object.assign(prev, { to: t.to, toSource: t.toSource });
          else derived.legTimes.push({ legId: t.legId, field: t.field, from: t.from, fromSource: t.fromSource, to: t.to, toSource: t.toSource });
        }
      }
      // Kept before the milestones are looked at: an equipment event outside the lifecycle (customs
      // released, say) counts toward its milestone from here.
      const rowId = stored ? stored.id : await insertEvent(shipment.id, f, { carrierCode, via, simulated, payload, applied: "" });
      if (stored) await query(`UPDATE carrier_events SET event_type=$1, event_code=$2, event_classifier=$3, event_date_time=$4, un_location_code=$5,
        location_name=$6, equipment_reference=$7, empty_indicator=$8, document_type=$9, document_reference=$10, vessel_imo=$11, vessel_name=$12,
        voyage=$13, is_retracted=FALSE, payload=$14, received_via=$15, updated_at=$16, event_updated_at=$17 WHERE id=$18`,
        [f.eventType, f.code, f.classifier, f.dateTime, f.unLocationCode, f.locationName, f.equipmentReference, f.emptyIndicator,
          f.documentType, f.documentReference, f.vesselImo, f.vesselName, f.voyage, payload, via, now, f.updatedAt, stored.id]);
      // 4. Milestones: the carrier's own SHIPMENT and TRANSPORT events for the shipment, and equipment events
      // (each holds once every container has it). A carrier event that names no place doesn't count as at a port.
      if (f.classifier === "ACTUAL") {
        const keys = await ctx.milestoneEvents.onEvent(shipment.id, { eventType: f.eventType, code: f.code, classifier: f.classifier,
          documentType: f.documentType, unLocationCode: f.unLocationCode, emptyIndicator: f.emptyIndicator, strictPlace: true,
          scope: f.eventType === "EQUIPMENT" ? "container" : "shipment" },
          `${carrierCode || "The carrier"} reported: ${describeMatcher({ eventType: f.eventType, code: f.code, documentType: f.documentType })}${f.unLocationCode ? ` at ${f.unLocationCode}` : ""}`);
        for (const k of keys) { out.milestones.push(k); applied.push(completedText(k)); }
      }
      await query("UPDATE carrier_events SET applied=$1, derived=$2 WHERE id=$3",
        [applied.length ? applied.join("; ") : (stored ? "updated by the carrier" : "kept for the record"), JSON.stringify(derived), rowId]);
      out.stored++;
    }
    return out;
  }

  async function insertEvent(shipmentId, f, { carrierCode, via, simulated, payload, applied, retracted = false }) {
    const id = `CEVT-${uid()}${uid()}`, now = nowIso();
    await query(`INSERT INTO carrier_events (id, shipment_id, carrier_code, carrier_event_id, event_type, event_code, event_classifier, event_date_time,
      un_location_code, location_name, equipment_reference, empty_indicator, document_type, document_reference, vessel_imo, vessel_name, voyage,
      is_retracted, applied, payload, received_via, is_mock, received_at, updated_at, event_updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$23,$24)`,
      [id, shipmentId, carrierCode || "", f.eventId, f.eventType, f.code, f.classifier, f.dateTime, f.unLocationCode, f.locationName,
        f.equipmentReference, f.emptyIndicator, f.documentType, f.documentReference, f.vesselImo, f.vesselName, f.voyage,
        retracted, applied, payload, via, !!simulated, now, f.updatedAt]);
    return id;
  }

  // ─── Pushed events: which shipments each is about ───────────────────────────
  // In order: an event CargoDesk already holds (by its eventID — a retraction or correction may carry
  // nothing else); every document it names (booking or booking request, the Master B/L, the Shipping
  // Instructions, a VGM declaration); the container; and, for a vessel event, the vessel and voyage on a
  // sea leg whose own date is near the event's — a vessel's departure is news for every shipment on it,
  // but a voyage number alone recurs. `scope`: the integration's carrier, or for the demo carrier its own bookings.
  async function shipmentsFor(f, { carrierCode = "", simulated = false } = {}) {
    const open = "s.status NOT IN ('Cancelled','Completed')";
    const scope = simulated ? "cb.is_mock=TRUE" : "cb.carrier_code=$2";
    const p = v => (simulated ? [v] : [v, carrierCode]);
    const ids = new Set();
    const add = rows => rows.forEach(r => ids.add(r.shipment_id));
    if (f.eventId) add(await query(`SELECT DISTINCT ce.shipment_id FROM carrier_events ce JOIN carrier_bookings cb ON cb.shipment_id = ce.shipment_id
      WHERE ce.carrier_event_id=$1 AND ${scope}`, p(f.eventId)));
    for (const ref of ids.size ? [] : f.references) {
      if (["BOOKING", "CARRIER_BOOKING_REQUEST"].includes(ref.type))
        add(await query(`SELECT cb.shipment_id FROM carrier_bookings cb JOIN shipments s ON s.id=cb.shipment_id WHERE ${scope} AND ${open}
          AND (cb.booking_ref=$1 OR cb.carrier_booking_request_reference=$1)`, p(ref.reference)));
      else if (ref.type === "TRANSPORT_DOCUMENT")
        add(await query(`SELECT s.id AS shipment_id FROM shipments s JOIN carrier_bookings cb ON cb.shipment_id=s.id WHERE ${scope} AND ${open}
          AND (s.master_bl_number=$1 OR EXISTS (SELECT 1 FROM transport_documents t WHERE t.shipment_id=s.id AND t.role='MASTER' AND t.reference=$1))`, p(ref.reference)));
      else if (ref.type === "SHIPPING_INSTRUCTIONS")
        add(await query(`SELECT si.shipment_id FROM shipping_instructions si JOIN shipments s ON s.id=si.shipment_id JOIN carrier_bookings cb ON cb.shipment_id=s.id
          WHERE ${scope} AND ${open} AND si.si_reference=$1`, p(ref.reference)));
      else if (ref.type === "VERIFIED_GROSS_MASS")
        add(await query(`SELECT d.shipment_id FROM vgm_declarations d JOIN shipments s ON s.id=d.shipment_id JOIN carrier_bookings cb ON cb.shipment_id=s.id
          WHERE ${scope} AND ${open} AND d.declaration_reference=$1`, p(ref.reference)));
    }
    if (!ids.size && f.equipmentReference)
      add(await query(`SELECT c.shipment_id FROM containers c JOIN shipments s ON s.id=c.shipment_id JOIN carrier_bookings cb ON cb.shipment_id=s.id
        WHERE ${scope} AND ${open} AND UPPER(c.container_number)=$1`, p(f.equipmentReference)));
    if (!ids.size && f.eventType === "TRANSPORT" && (f.vesselImo || f.vesselName) && f.voyage && /^\d{4}-\d{2}-\d{2}/.test(f.dateTime)) {
      const field = f.code === "DEPARTED" ? "etd" : "eta", port = f.code === "DEPARTED" ? "pol" : "pod";
      const vessel = f.vesselImo || f.vesselName;
      // $1 the port; then (a real carrier) $2 its code; then the vessel and the voyage.
      const params = simulated ? [f.unLocationCode, vessel, f.voyage] : [f.unLocationCode, carrierCode, vessel, f.voyage];
      const v = simulated ? 2 : 3, vo = simulated ? 3 : 4;
      const rows = await query(`SELECT DISTINCT l.shipment_id, l.${field} AS leg_date FROM shipment_legs l JOIN shipments s ON s.id=l.shipment_id
        JOIN carrier_bookings cb ON cb.shipment_id=s.id WHERE ${scope} AND ${open} AND ${SEA_LEG_L}
        AND l.${port}=$1 AND (l.vessel_imo=$${v} OR UPPER(l.vessel)=UPPER($${v})) AND l.voyage=$${vo}`, params);
      const at = Date.parse(f.dateTime.slice(0, 10));
      add(rows.filter(r => r.leg_date && Math.abs(Date.parse(String(r.leg_date).slice(0, 10)) - at) <= VESSEL_WINDOW_DAYS * 864e5));
    }
    return [...ids];
  }

  // The push: a POST /events from a carrier → per shipment. → { feedbackElements, results }
  async function receive(events, { carrierCode = "", simulated = false } = {}) {
    const byShipment = new Map(), feedbackElements = [];
    for (const [i, ev] of events.entries()) {
      const f = factsOf(ev);
      const ids = await shipmentsFor(f, { carrierCode, simulated });
      if (!ids.length) {
        feedbackElements.push({ severity: "WARN", message: `Event ${f.eventId || `#${i + 1}`} (${[f.eventType, f.code].filter(Boolean).join(" ") || "retraction"}) matches no open shipment booked with ${carrierCode || "this carrier"}`, propertyPath: `$.events[${i}]` });
        continue;
      }
      for (const id of ids) { if (!byShipment.has(id)) byShipment.set(id, []); byShipment.get(id).push(ev); }
    }
    const results = [];
    for (const [shipmentId, list] of byShipment) {
      const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
      if (!shipment) continue;
      const [cb] = await query("SELECT carrier_code FROM carrier_bookings WHERE shipment_id=$1", [shipmentId]);
      results.push({ shipmentId, ...(await applyEvents(shipment, list, { carrierCode: carrierCode || cb?.carrier_code || "", via: "push", simulated })) });
    }
    return { feedbackElements, results };
  }

  const mapCarrierEvent = r => ({
    id: r.id, shipmentId: r.shipment_id, carrierCode: r.carrier_code, carrierEventId: r.carrier_event_id, eventType: r.event_type,
    eventCode: r.event_code, eventClassifier: r.event_classifier, eventDateTime: r.event_date_time, eventUpdatedAt: r.event_updated_at || "",
    unLocationCode: r.un_location_code, locationName: r.location_name, equipmentReference: r.equipment_reference, emptyIndicator: r.empty_indicator,
    documentType: r.document_type, documentReference: r.document_reference, vesselImo: r.vessel_imo, vesselName: r.vessel_name, voyage: r.voyage,
    isRetracted: !!r.is_retracted, applied: r.applied, receivedVia: r.received_via, isMock: !!r.is_mock, receivedAt: r.received_at, updatedAt: r.updated_at,
  });

  return { applyEvents, applyVesselTime, receive, shipmentsFor, factsOf, mapCarrierEvent, SEA_LEG };
};
module.exports.factsOf = factsOf;
module.exports.SEA_LEG = SEA_LEG;
