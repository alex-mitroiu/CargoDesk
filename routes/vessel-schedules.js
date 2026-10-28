"use strict";

// ─── Vessel times from the carrier's Operational Vessel Schedules (DCSA OVS 3.0, phase 6, 2026-10-28) ───
// For each sea leg with a vessel and a voyage, asks the leg's carrier (through its 'vessel-schedules'
// connection) for the vessel's schedule and takes the best-known departure from the leg's POL and arrival
// at its POD (lib/carrier-integrations/dcsa-ovs-v3.js vesselTimesFrom). lib/track-trace.js applyVesselTime
// writes them: an actual confirms the leg's date (source 'dcsa_actual'), an estimate or plan updates it
// (source 'dcsa') unless a confirmed time is already there. An actual departure from the shipment's POL
// or arrival at its POD completes Vessel Departed / Vessel Arrived (lib/milestone-events.js).
//
// "Check vessel times" (POST /api/shipments/:id/vessel-times/sync) asks any connection, the demo carrier
// included; the hourly sweep only carriers with an integration of their own, like the tracking sweep, so
// the demo carrier never rewrites times nobody asked it for.

const { SEA_LEG } = require("../lib/track-trace");

module.exports = function vesselScheduleRoutes(app, ctx) {
  const { query, ok, err, requireRole, carrierIntegrationFor, getSettings } = ctx;
  const write = requireRole(["operator", "admin", "occ_bk"]);

  async function syncVesselTimes(shipment) {
    const legs = await query(`SELECT * FROM shipment_legs WHERE shipment_id=$1 AND ${SEA_LEG}
      AND (COALESCE(vessel_imo,'') <> '' OR COALESCE(vessel,'') <> '') AND COALESCE(voyage,'') <> '' ORDER BY leg_order`, [shipment.id]);
    const out = { legs: legs.length, changes: [], skipped: [], milestones: [] };
    for (const leg of legs) {
      const carrierCode = leg.carrier_code || shipment.carrier_code || "";
      const integ = await carrierIntegrationFor(carrierCode, "vessel-schedules").catch(() => null);
      if (!integ?.adapter.getServiceSchedules) { out.skipped.push({ legId: leg.id, reason: `no vessel schedule connection for ${carrierCode || "the leg's carrier"}` }); continue; }
      const r = await integ.adapter.getServiceSchedules(integ.config, { vesselIMONumber: leg.vessel_imo || "", vesselName: leg.vessel_imo ? "" : leg.vessel, carrierVoyageNumber: leg.voyage });
      if (!r.ok) { out.skipped.push({ legId: leg.id, reason: `${carrierCode} could not be asked (${r.error})` }); continue; }
      const times = integ.adapter.vesselTimesFrom(r.schedules, { vesselImo: leg.vessel_imo || "", vesselName: leg.vessel || "", voyage: leg.voyage, pol: leg.pol, pod: leg.pod });
      if (!times.departure && !times.arrival) { out.skipped.push({ legId: leg.id, reason: `${carrierCode} has no times for ${leg.vessel || leg.vessel_imo} ${leg.voyage} at ${leg.pol} / ${leg.pod}` }); continue; }
      for (const [slot, field, port, code, shipmentPort] of [["departure", "etd", leg.pol, "DEPARTED", shipment.pol], ["arrival", "eta", leg.pod, "ARRIVED", shipment.pod]]) {
        const t = times[slot];
        if (!t) continue;
        const change = await ctx.trackTrace.applyVesselTime(shipment.id, { field, unLocationCode: String(port || "").toUpperCase(), classifier: t.classifier,
          dateTime: t.dateTime, vesselImo: leg.vessel_imo || "", source: "vessel schedule", carrierCode });
        if (change) out.changes.push(change);
        if (t.classifier === "ACTUAL" && String(port || "").toUpperCase() === String(shipmentPort || "").toUpperCase())
          out.milestones.push(...await ctx.milestoneEvents.onEvent(shipment.id, { eventType: "TRANSPORT", code, classifier: "ACTUAL",
            unLocationCode: String(port).toUpperCase(), scope: "shipment" },
            `${carrierCode} vessel schedule: ${leg.vessel || leg.vessel_imo} ${code === "DEPARTED" ? "departed" : "arrived at"} ${port}`));
      }
    }
    return out;
  }
  ctx.syncVesselTimes = syncVesselTimes;

  app.post("/api/shipments/:id/vessel-times/sync", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    ok(res, await syncVesselTimes(shipment));
  });

  // Hourly: open shipments with a sea leg whose times aren't both confirmed, booked with a carrier that has
  // its own active integration with the 'vessel-schedules' capability.
  const SWEEP_MINUTES = 60;
  async function runVesselTimesSweep() {
    if ((await getSettings()).api_carrier_integrations_enabled === "false") return { synced: 0, changes: 0, failed: 0 };
    const rows = await query(`SELECT DISTINCT s.* FROM shipments s JOIN shipment_legs l ON l.shipment_id = s.id
      JOIN carrier_integrations ci ON ci.carrier_code = COALESCE(NULLIF(l.carrier_code, ''), s.carrier_code) AND ci.is_active = TRUE
        AND ci.capabilities LIKE '%vessel-schedules%'
      WHERE s.status NOT IN ('Cancelled', 'Completed') AND (l.leg_type='SEA' OR (COALESCE(l.leg_type,'')='' AND l.mot='SEA')) AND COALESCE(l.voyage,'') <> ''
        AND (COALESCE(l.etd_source,'') <> 'dcsa_actual' OR COALESCE(l.eta_source,'') <> 'dcsa_actual')`);
    const summary = { synced: 0, changes: 0, failed: 0 };
    for (const s of rows) {
      const r = await syncVesselTimes(s).catch(e => ({ error: e.message }));
      if (r.error) { summary.failed++; console.warn(`Vessel times ${s.id}:`, r.error); continue; }
      summary.synced++; summary.changes += r.changes.length;
    }
    return summary;
  }
  ctx.runVesselTimesSweep = runVesselTimesSweep;
  app.post("/api/vessel-times/sync-sweep", requireRole(["admin"]), async (req, res) => ok(res, await runVesselTimesSweep()));
  const timer = setInterval(() => { runVesselTimesSweep().catch(e => console.error("Vessel times sweep failed:", e.message)); }, SWEEP_MINUTES * 60000);
  timer.unref?.();
};
