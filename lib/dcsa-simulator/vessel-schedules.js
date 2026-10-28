"use strict";
// The demo carrier's Operational Vessel Schedules 3.0 (DCSA-everywhere phase 6, 2026-10-28). State in
// dcsa_sim_vessel_calls: one row per vessel, voyage, port and timestamp kind (arrival or departure;
// planned, estimated or actual). Test Tools sets them (setCall); GET /v3/service-schedules serves them as
// DCSA ServiceSchedules, which CargoDesk reads with "Check vessel times" (routes/vessel-schedules.js).
// Nothing is made up: a vessel the demo carrier was given no times for has no schedule.

const { validateResponse, errorsText } = require("../dcsa/validate");

const EVENT_TYPES = ["ARRI", "DEPA"], CLASSIFIERS = ["PLN", "EST", "ACT"];

module.exports = function createSimVesselSchedules({ query, uid }) {
  async function setCall({ carrierCode = "", vesselImo = "", vesselName = "", voyage = "", serviceCode = "", unLocationCode = "", eventTypeCode, eventClassifierCode, eventDateTime }) {
    const type = String(eventTypeCode || "").toUpperCase(), cls = String(eventClassifierCode || "").toUpperCase();
    if (!EVENT_TYPES.includes(type)) return { ok: false, status: 400, error: "eventTypeCode must be ARRI or DEPA" };
    if (!CLASSIFIERS.includes(cls)) return { ok: false, status: 400, error: "eventClassifierCode must be PLN, EST or ACT" };
    if (!vesselImo && !vesselName) return { ok: false, status: 400, error: "A vessel IMO number or name is needed" };
    if (!/^[A-Z]{2}[A-Z2-9]{3}$/.test(String(unLocationCode).toUpperCase())) return { ok: false, status: 400, error: "unLocationCode must be a UN/LOCODE" };
    if (!voyage) return { ok: false, status: 400, error: "A voyage number is needed" };
    if (Number.isNaN(Date.parse(eventDateTime || ""))) return { ok: false, status: 400, error: "eventDateTime must be a date and time" };
    const now = new Date().toISOString();
    await query(`INSERT INTO dcsa_sim_vessel_calls (id, carrier_code, vessel_imo, vessel_name, voyage, service_code, un_location_code, event_type, classifier, event_date_time, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (vessel_imo, voyage, un_location_code, event_type, classifier) DO UPDATE SET event_date_time=EXCLUDED.event_date_time,
        vessel_name=EXCLUDED.vessel_name, service_code=EXCLUDED.service_code, carrier_code=EXCLUDED.carrier_code, updated_at=EXCLUDED.updated_at`,
      [`SVC-${uid()}${uid()}`, carrierCode, String(vesselImo || ""), vesselName, voyage, serviceCode, String(unLocationCode).toUpperCase(), type, cls,
        new Date(eventDateTime).toISOString(), now]);
    return { ok: true };
  }

  async function calls({ vesselImo = "", vesselName = "", voyage = "", unLocationCode = "" } = {}) {
    return query(`SELECT * FROM dcsa_sim_vessel_calls WHERE ($1='' OR vessel_imo=$1) AND ($2='' OR UPPER(vessel_name)=UPPER($2))
      AND ($3='' OR voyage=$3) AND ($4='' OR un_location_code=$4) ORDER BY event_date_time`, [vesselImo, vesselName, voyage, unLocationCode]);
  }

  // Rows → DCSA ServiceSchedule[]: service → vessel → transport call (voyage + port) → timestamps.
  function toSchedules(rows) {
    const services = new Map();
    for (const r of rows) {
      const svcKey = r.service_code || "DEMO";
      if (!services.has(svcKey)) services.set(svcKey, { carrierServiceName: r.service_code ? `Demo service ${r.service_code}` : "Demo carrier service",
        carrierServiceCode: (r.service_code || "DEMO").slice(0, 11), vessels: new Map() });
      const svc = services.get(svcKey);
      const vKey = r.vessel_imo || r.vessel_name;
      if (!svc.vessels.has(vKey)) svc.vessels.set(vKey, { vesselOperatorSMDGLinerCode: (r.carrier_code || "DEMO").slice(0, 10),
        ...(r.vessel_imo ? { vesselIMONumber: r.vessel_imo } : {}), ...(r.vessel_name ? { vesselName: r.vessel_name.slice(0, 35) } : {}),
        // No IMO number yet is what the spec calls a dummy vessel.
        isDummyVessel: !r.vessel_imo, calls: new Map() });
      const vessel = svc.vessels.get(vKey);
      const cKey = `${r.voyage}|${r.un_location_code}`;
      if (!vessel.calls.has(cKey)) vessel.calls.set(cKey, { transportCallReference: `${vKey}-${r.voyage}-${r.un_location_code}`.slice(0, 100),
        carrierImportVoyageNumber: r.voyage, carrierExportVoyageNumber: r.voyage, location: { locationType: "UNLO", UNLocationCode: r.un_location_code }, timestamps: [] });
      vessel.calls.get(cKey).timestamps.push({ eventTypeCode: r.event_type, eventClassifierCode: r.classifier, eventDateTime: r.event_date_time });
    }
    return [...services.values()].map(s => ({ carrierServiceName: s.carrierServiceName, carrierServiceCode: s.carrierServiceCode,
      vesselSchedules: [...s.vessels.values()].map(({ calls: c, ...v }) => ({ ...v, transportCalls: [...c.values()] })) }));
  }

  function registerRoutes(app) {
    app.get("/dcsa-sim/v3/service-schedules", async (req, res) => {
      const { vesselIMONumber = "", vesselName = "", carrierVoyageNumber = "", UNLocationCode = "" } = req.query;
      const schedules = toSchedules(await calls({ vesselImo: String(vesselIMONumber), vesselName: String(vesselName), voyage: String(carrierVoyageNumber),
        unLocationCode: String(UNLocationCode).toUpperCase() }));
      const v = validateResponse("ovs", "get", "/v3/service-schedules", 200, schedules);
      if (!v.ok) return res.status(500).json({ error: `The demo carrier built an invalid OVS answer: ${errorsText(v.errors, 4)}` });
      res.json(schedules);
    });
  }

  return { setCall, calls, toSchedules, registerRoutes };
};
