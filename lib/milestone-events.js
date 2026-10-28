"use strict";
// Milestones completed by DCSA events (DCSA-everywhere phase 6, 2026-10-28), built once as ctx.milestoneEvents.
//
// Each milestone carries the DCSA Track & Trace 3.0 events that complete it (shipment_milestones.dcsa_events,
// copied from its template; '' = the default for its key, lib/dcsa/codes.js MILESTONE_DCSA). Every place
// CargoDesk learns of something that happened calls onEvent with the event in DCSA terms: a container event
// (manual or the carrier's), the carrier's booking confirmation, the Shipping Instructions the carrier
// received, the Master B/L it issued, its Track & Trace events. A milestone completes when one of its
// matchers holds:
//   - same eventType and code (and documentType for a SHIPMENT event, empty/laden when the matcher says);
//   - place POL/POD: the event happened at the shipment's own port (an event whose place isn't known is
//     not held against it — a container event typed by hand often names no UN/LOCODE);
//   - an EQUIPMENT matcher, or an event recorded per container, holds once EVERY container on the shipment
//     has it (one box gated in isn't the cargo gated in). A carrier's TRANSPORT event is one event for the
//     vessel, so it holds at once.
// Only ACTUAL events complete milestones; estimates move dates, not milestones. Completing goes through
// autoCompleteMilestone (a no-op once complete), so a milestone a person ticked stays as they left it.

const { MILESTONE_DCSA, EVENT_TYPE, EQUIPMENT_EVENT_TYPE, TRANSPORT_EVENT_TYPE, SHIPMENT_EVENT_TYPE, DOCUMENT_REFERENCE_TYPE,
  EMPTY_INDICATOR, has, describeMatcher } = require("./dcsa/codes");

const matchersOf = m => {
  if (m.dcsa_events) {
    try { const a = JSON.parse(m.dcsa_events); if (Array.isArray(a)) return a; } catch { /* fall back to the default */ }
  }
  return MILESTONE_DCSA[m.milestone_key] || [];
};

module.exports = function createMilestoneEvents({ query, autoCompleteMilestone }) {
  const portFor = (matcher, s) => (matcher.place === "POL" ? s.pol : matcher.place === "POD" ? s.pod : "") || "";

  // Does every container on the shipment have this equipment (or per-container transport) event? One
  // query: each container's own events, or the carrier's events about it (an equipment event outside the
  // container lifecycle, customs released say, is only there). A carrier event naming no place doesn't count.
  async function everyContainer(shipmentId, m, port) {
    const [r] = await query(`SELECT COUNT(*)::int AS total, COALESCE(SUM(CASE WHEN
        EXISTS (SELECT 1 FROM container_events e WHERE e.container_id = c.id AND e.dcsa_event_type=$2 AND e.dcsa_event_code=$3
          AND e.event_classifier='ACTUAL' AND ($4='' OR e.empty_indicator IN ('', $4)) AND ($5='' OR e.un_location_code IN ('', $5)))
        OR EXISTS (SELECT 1 FROM carrier_events ce WHERE ce.shipment_id=$1 AND ce.event_type=$2 AND ce.event_code=$3
          AND ce.event_classifier='ACTUAL' AND NOT ce.is_retracted AND ce.equipment_reference = UPPER(c.container_number) AND c.container_number <> ''
          AND ($4='' OR ce.empty_indicator IN ('', $4)) AND ($5='' OR ce.un_location_code=$5))
      THEN 1 ELSE 0 END), 0)::int AS having FROM containers c WHERE c.shipment_id=$1`, [shipmentId, m.eventType, m.code, m.emptyIndicator || "", port]);
    return !!r && r.total > 0 && r.having === r.total;
  }

  async function holds(m, ev, s, shipmentId) {
    if (m.eventType !== ev.eventType || m.code !== ev.code) return false;
    if (m.documentType && m.documentType !== (ev.documentType || "")) return false;
    if (m.emptyIndicator && ev.emptyIndicator && m.emptyIndicator !== ev.emptyIndicator) return false;
    const port = portFor(m, s);
    if (port && ev.unLocationCode && ev.unLocationCode !== port) return false;
    // A carrier's event that names no place isn't taken as being at the port (a hand-typed container
    // event often names none, and is given the benefit of the doubt).
    if (port && !ev.unLocationCode && ev.strictPlace) return false;
    if (m.eventType === "EQUIPMENT" || ev.scope === "container") return everyContainer(shipmentId, m, port);
    return true;
  }

  /**
   * @param {string} shipmentId
   * @param {object} ev  { eventType, code, classifier = "ACTUAL", documentType, unLocationCode, emptyIndicator, scope: "shipment" | "container",
   *                       strictPlace: a carrier's event (its place must be named to count as at a port) }
   * @param {string|function} note  the milestone's completion note (a function gets the milestone row)
   * @returns {Promise<string[]>} the milestone keys completed
   */
  async function onEvent(shipmentId, ev, note) {
    if ((ev.classifier || "ACTUAL") !== "ACTUAL" || !ev.eventType || !ev.code) return [];
    const [s] = await query("SELECT pol, pod FROM shipments WHERE id=$1", [shipmentId]);
    if (!s) return [];
    const open = await query("SELECT * FROM shipment_milestones WHERE shipment_id=$1 AND completed_at='' ORDER BY sequence_order", [shipmentId]);
    const completed = [];
    for (const m of open) {
      for (const matcher of matchersOf(m)) {
        if (!(await holds(matcher, ev, s, shipmentId))) continue;
        await autoCompleteMilestone(shipmentId, m.milestone_key, typeof note === "function" ? note(m) : note);
        completed.push(m.milestone_key);
        break;
      }
    }
    return completed;
  }

  return { onEvent, matchersOf };
};
// Matchers given to a milestone template (POST/PUT /api/milestone-templates): → { matchers } | { error }.
const CODES_FOR = { EQUIPMENT: EQUIPMENT_EVENT_TYPE, TRANSPORT: TRANSPORT_EVENT_TYPE, SHIPMENT: SHIPMENT_EVENT_TYPE };
function cleanMatchers(raw) {
  if (!Array.isArray(raw)) return { error: "dcsaEvents must be a list of DCSA events" };
  const matchers = [];
  for (const [i, m] of raw.entries()) {
    const eventType = String(m?.eventType || "").toUpperCase(), code = String(m?.code || "").toUpperCase();
    if (!has(EVENT_TYPE, eventType) || !CODES_FOR[eventType]) return { error: `dcsaEvents #${i + 1}: eventType must be SHIPMENT, TRANSPORT or EQUIPMENT` };
    if (!has(CODES_FOR[eventType], code)) return { error: `dcsaEvents #${i + 1}: ${code || "(none)"} is not a DCSA ${eventType.toLowerCase()} event` };
    const documentType = String(m.documentType || "").toUpperCase(), emptyIndicator = String(m.emptyIndicator || "").toUpperCase();
    const place = String(m.place || "").toUpperCase();
    if (documentType && !has(DOCUMENT_REFERENCE_TYPE, documentType)) return { error: `dcsaEvents #${i + 1}: ${documentType} is not a DCSA document type` };
    if (emptyIndicator && !has(EMPTY_INDICATOR, emptyIndicator)) return { error: `dcsaEvents #${i + 1}: emptyIndicator must be EMPTY or LADEN` };
    if (place && !["POL", "POD"].includes(place)) return { error: `dcsaEvents #${i + 1}: place must be POL or POD` };
    matchers.push({ eventType, code, ...(documentType ? { documentType } : {}), ...(emptyIndicator ? { emptyIndicator } : {}), ...(place ? { place } : {}) });
  }
  return { matchers };
}
// For the API: the matchers and how they read.
const dcsaEventsOf = r => matchersOf(r).map(m => ({ ...m, label: describeMatcher(m) }));

module.exports.matchersOf = matchersOf;
module.exports.cleanMatchers = cleanMatchers;
module.exports.dcsaEventsOf = dcsaEventsOf;
