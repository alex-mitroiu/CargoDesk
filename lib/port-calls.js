"use strict";
// ─── Port Call 2.0 timestamps as vessel times (DCSA-everywhere phase 8, 2026-10-28) ───
// Built once as ctx.portCalls. Port Call is the standard between a vessel's operator, the terminal and the
// port; a forwarder takes only what moves its legs: the vessel's ARRIVAL at and DEPARTURE from the BERTH
// (portCallServiceTypeCode BERTH, ARRI / DEPA), planned, estimated or actual. Each one reaches every
// shipment whose sea leg has that vessel (IMO) and voyage calling at the port, and moves the leg like the
// carrier's schedule does (lib/track-trace.js applyVesselTime: an estimate never undoes a confirmed time).
// Everything else (pilotage, towage, moves forecasts, requested times) is acknowledged and left alone. Push
// only (POST …/port-call/events); events are kept in port_call_events, newest copy by eventUpdatedDateTime.

const { CLASSIFIER_FROM_SHORT } = require("./dcsa/codes");
const { SEA_LEG } = require("./track-trace");

const up = s => String(s || "").toUpperCase().trim();

module.exports = function createPortCalls(ctx) {
  const { query } = ctx;

  async function receive(events, { carrierCode = "", simulated = false } = {}) {
    const feedbackElements = [];
    for (const [i, ev] of (events || []).entries()) {
      const svc = ev.portCallService || {}, ts = ev.timestamp || {};
      const kind = up(svc.portCallServiceEventTypeCode);
      const classifier = CLASSIFIER_FROM_SHORT[up(ts.classifierCode)];
      const unloc = up(ev.portCall?.UNLocationCode);
      const imo = String(ev.vessel?.vesselIMONumber || "").trim();
      const voyages = [ev.terminalCall?.importVoyageNumberOrReference?.carrierVoyageNumber, ev.terminalCall?.exportVoyageNumberOrReference?.carrierVoyageNumber]
        .map(v => String(v || "").trim()).filter(Boolean);
      // Only berth arrivals and departures with a time, a port, the vessel and its voyage move a leg.
      if (up(svc.portCallServiceTypeCode) !== "BERTH" || !["ARRI", "DEPA"].includes(kind) || !classifier || !ts.serviceDateTime
        || !unloc || !imo || !voyages.length || svc.isCanceled || ev.isFYI) continue;
      // The newest copy of an event wins (eventUpdatedDateTime), as in Track & Trace.
      const [held] = ev.eventID ? await query("SELECT event_updated_at FROM port_call_events WHERE event_id=$1", [ev.eventID]) : [];
      if (held && String(held.event_updated_at || "") > String(ev.eventUpdatedDateTime || "")) continue;
      const field = kind === "ARRI" ? "eta" : "etd", portCol = kind === "ARRI" ? "pod" : "pol";
      const legs = await query(`SELECT DISTINCT shipment_id FROM shipment_legs WHERE ${SEA_LEG} AND vessel_imo=$1 AND ${portCol}=$2
        AND voyage IN (${voyages.map((_, j) => `$${j + 3}`).join(",")})`, [imo, unloc, ...voyages]);
      const changed = [];
      for (const { shipment_id: shipmentId } of legs) {
        const t = await ctx.trackTrace.applyVesselTime(shipmentId, { field, unLocationCode: unloc, classifier, dateTime: ts.serviceDateTime,
          vesselImo: imo, source: "Port Call", carrierCode });
        if (t) changed.push({ shipmentId, ...t });
      }
      if (ev.eventID) await query(`INSERT INTO port_call_events (event_id, vessel_imo, un_location_code, event_type, classifier, service_date_time,
          event_updated_at, payload, derived, is_mock, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (event_id) DO UPDATE SET classifier=EXCLUDED.classifier, service_date_time=EXCLUDED.service_date_time,
          event_updated_at=EXCLUDED.event_updated_at, payload=EXCLUDED.payload, derived=EXCLUDED.derived, received_at=EXCLUDED.received_at`,
        [ev.eventID, imo, unloc, kind, classifier, ts.serviceDateTime, ev.eventUpdatedDateTime || "", JSON.stringify(ev),
          JSON.stringify(changed), !!simulated, new Date().toISOString()]);
      if (!legs.length) feedbackElements.push({ severity: "WARN", propertyPath: `$.events[${i}]`,
        message: `No shipment has vessel ${imo} voyage ${voyages.join("/")} ${kind === "ARRI" ? "arriving at" : "departing from"} ${unloc}` });
    }
    return { feedbackElements };
  }

  return { receive };
};
