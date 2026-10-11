"use strict";
// DCSA Track & Trace 2.2 events → CargoDesk container events (Epic TKT-KG4E49, decided by the user
// 2026-10-09). Pure, no I/O — tests/carrier-integrations.test.js covers it directly.
//
// Only ACTual events count (eventClassifierCode ACT; planned/estimated ones are not things that
// happened). CargoDesk's seven lifecycle events, from the spec's equipment and transport codes:
//
//   Empty Pickup  ← EQUIPMENT GTOT (gated out), EMPTY
//   Gate In       ← EQUIPMENT GTIN (gated in), LADEN
//   Loaded        ← EQUIPMENT LOAD at the shipment's POL
//   Sailed        ← TRANSPORT DEPA (departed) from the shipment's POL — every container on it
//   Discharged    ← EQUIPMENT DISC at the shipment's POD
//   Gate Out      ← EQUIPMENT GTOT, LADEN
//   Empty Return  ← EQUIPMENT GTIN, EMPTY
//
// A load or discharge anywhere else is a transshipment move: reported back as skipped (it stays in
// the carrier message log) rather than moving the container's lifecycle. STUF/STRP/PICK/DROP/INSP/
// RSEA/RMVD and arrivals have no CargoDesk event and are skipped too.

const up = s => String(s || "").trim().toUpperCase();
const placeOf = ev => up(ev.eventLocation?.UNLocationCode || ev.transportCall?.UNLocationCode || ev.transportCall?.location?.UNLocationCode);
const placeName = ev => ev.eventLocation?.locationName || ev.transportCall?.location?.locationName || "";

function equipmentEventType(ev, { pol, pod }) {
  const code = up(ev.equipmentEventTypeCode), empty = up(ev.emptyIndicatorCode) === "EMPTY", at = placeOf(ev);
  if (code === "GTOT") return empty ? { type: "Empty Pickup" } : { type: "Gate Out" };
  if (code === "GTIN") return empty ? { type: "Empty Return" } : { type: "Gate In" };
  if (code === "LOAD") return at && at === up(pol) ? { type: "Loaded" } : { skip: `loaded at ${at || "an unknown place"}, not the POL — transshipment` };
  if (code === "DISC") return at && at === up(pod) ? { type: "Discharged" } : { skip: `discharged at ${at || "an unknown place"}, not the POD — transshipment` };
  return { skip: `${code || "unknown"} has no CargoDesk event` };
}

/**
 * @param {object[]} events  DCSA events (equipment / transport / shipment)
 * @param {{ pol: string, pod: string, containers: { id: string, containerNumber: string }[] }} shipment
 * @returns {{ add: { containerId, containerNumber, eventType, occurredAt, location, carrierEventId }[],
 *             skipped: { eventId, reason }[] }}
 */
function mapTrackTraceEvents(events, { pol, pod, containers = [] }) {
  const byNumber = new Map(containers.filter(c => c.containerNumber).map(c => [up(c.containerNumber), c]));
  const add = [], skipped = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const eventId = ev.eventID || "";
    if (up(ev.eventClassifierCode) !== "ACT") { skipped.push({ eventId, reason: `${ev.eventClassifierCode || "unclassified"} event, not an actual one` }); continue; }
    const kind = up(ev.eventType);
    const location = [placeOf(ev), placeName(ev)].filter(Boolean).join(" · ");
    if (kind === "EQUIPMENT") {
      const ctr = byNumber.get(up(ev.equipmentReference));
      if (!ctr) { skipped.push({ eventId, reason: `container ${ev.equipmentReference || "(none)"} is not on this shipment` }); continue; }
      const m = equipmentEventType(ev, { pol, pod });
      if (m.skip) { skipped.push({ eventId, reason: m.skip }); continue; }
      add.push({ containerId: ctr.id, containerNumber: ctr.containerNumber, eventType: m.type, occurredAt: ev.eventDateTime, location, carrierEventId: eventId });
    } else if (kind === "TRANSPORT") {
      const at = placeOf(ev);
      if (up(ev.transportEventTypeCode) !== "DEPA" || !at || at !== up(pol)) {
        skipped.push({ eventId, reason: `${ev.transportEventTypeCode || "transport"} at ${at || "an unknown place"} — only the departure from the POL is tracked` });
        continue;
      }
      for (const ctr of containers) {
        // One carrier event fans out to every container; the id stays unique per container.
        add.push({ containerId: ctr.id, containerNumber: ctr.containerNumber, eventType: "Sailed", occurredAt: ev.eventDateTime, location, carrierEventId: eventId });
      }
    } else {
      skipped.push({ eventId, reason: `${kind || "unknown"} event — not a container event` });
    }
  }
  return { add, skipped };
}

module.exports = { mapTrackTraceEvents };
