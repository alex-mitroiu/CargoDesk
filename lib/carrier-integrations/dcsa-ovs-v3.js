"use strict";
// DCSA Operational Vessel Schedules 3.0 (vendored OVS_v3.0.0.yaml, API 3.0.2), part of the generic DCSA
// adapter (merged with dcsa-bkg-v2 in server.js) since 2026-10-28 (DCSA-everywhere phase 6). CargoDesk is
// the consumer: GET /v3/service-schedules for the vessel and voyage of a shipment's sea leg, and the
// carrier's planned, estimated or actual arrival and departure at the leg's ports become the leg's times
// (lib/track-trace.js applyVesselTime): the carrier's own times outrank AIS, which only fills in.

const { dcsaCall: call } = require("./dcsa-http");
const { CLASSIFIER_FROM_SHORT } = require("../dcsa/codes");

async function getServiceSchedules(config, { vesselIMONumber = "", vesselName = "", carrierVoyageNumber = "", UNLocationCode = "", startDate = "", endDate = "" } = {}) {
  const query = {};
  if (vesselIMONumber) query.vesselIMONumber = String(vesselIMONumber);
  else if (vesselName) query.vesselName = vesselName;
  if (carrierVoyageNumber) query.carrierVoyageNumber = carrierVoyageNumber;
  if (UNLocationCode) query.UNLocationCode = UNLocationCode;
  if (startDate) query.startDate = startDate;
  if (endDate) query.endDate = endDate;
  query.limit = "100";
  const r = await call(config, "GET", "/v3/service-schedules", { query, expect: [200], spec: ["ovs", "/v3/service-schedules"] });
  if (!r.ok) return r;
  return { ok: true, schedules: Array.isArray(r.raw) ? r.raw : [], raw: r.raw };
}

const RANK = { ACT: 3, EST: 2, PLN: 1 };
// The best-known departure from `pol` and arrival at `pod` for the vessel and voyage: an actual over an
// estimate over a plan; among equals, the latest one listed. → { departure, arrival }, each
// { classifier: ACTUAL | ESTIMATED | PLANNED, dateTime } or null.
function vesselTimesFrom(schedules, { vesselImo = "", vesselName = "", voyage = "", pol = "", pod = "" } = {}) {
  const pick = { departure: null, arrival: null };
  const best = (slot, ts) => {
    const cur = pick[slot];
    if (!cur || RANK[ts.eventClassifierCode] >= cur.rank) pick[slot] = { rank: RANK[ts.eventClassifierCode] || 0,
      classifier: CLASSIFIER_FROM_SHORT[ts.eventClassifierCode] || ts.eventClassifierCode, dateTime: ts.eventDateTime };
  };
  for (const svc of schedules || []) for (const v of svc.vesselSchedules || []) {
    const sameVessel = vesselImo ? String(v.vesselIMONumber || "") === String(vesselImo)
      : String(v.vesselName || "").toUpperCase() === String(vesselName || "").toUpperCase();
    if (!sameVessel) continue;
    for (const tc of v.transportCalls || []) {
      if (voyage && ![tc.carrierExportVoyageNumber, tc.carrierImportVoyageNumber].includes(voyage)) continue;
      const at = String(tc.location?.UNLocationCode || "").toUpperCase();
      for (const ts of tc.timestamps || []) {
        if (ts.eventTypeCode === "DEPA" && at === String(pol).toUpperCase()) best("departure", ts);
        if (ts.eventTypeCode === "ARRI" && at === String(pod).toUpperCase()) best("arrival", ts);
      }
    }
  }
  for (const k of Object.keys(pick)) if (pick[k]) delete pick[k].rank;
  return pick;
}

module.exports = { getServiceSchedules, vesselTimesFrom };
