"use strict";
// AIS Integration (TKT-ZFO2OM) — status readout for App Settings, plus the Test Tools AIS
// Simulator's two inject endpoints. Both simulate endpoints funnel through ctx.ingestAisMessage,
// the exact same function the live aisstream.io connection calls — no parallel "simulate an
// update" code path, same discipline routes/edi.js's simulate-response already follows.

module.exports = function aisRoutes(app, ctx) {
  const { query, ok, err, auth, requireRole, getAisListenerStatus, ingestAisMessage, forceRefreshAisTrackedLegs, mapVessel, mapShipmentLeg } = ctx;

  const write = requireRole(["admin", "operator"]);

  app.get("/api/ais/status", auth(), (req, res) => {
    ok(res, getAisListenerStatus());
  });

  // Legs currently eligible for AIS departure/arrival confirmation — same shape the listener's
  // own tracked-leg cache uses, so what a developer sees here is exactly what's eligible for
  // real matching. "Open" means not yet AIS-confirmed, not blank — etd/eta almost always
  // already hold an estimate.
  app.get("/api/test-tools/ais/open-legs", auth(), async (req, res) => {
    const rows = await query(`
      SELECT l.id AS leg_id, l.shipment_id, l.pol, l.pod, l.vessel, l.vessel_imo,
             l.etd, l.eta, l.etd_source, l.eta_source
      FROM shipment_legs l
      JOIN shipments s ON s.id = l.shipment_id
      WHERE l.leg_type='SEA' AND l.vessel_imo != '' AND (l.etd_source != 'ais' OR l.eta_source != 'ais')
      ORDER BY l.created_at DESC LIMIT 50
    `);
    ok(res, rows.map(r => ({
      legId: r.leg_id, shipmentId: r.shipment_id, pol: r.pol, pod: r.pod,
      vessel: r.vessel, vesselImo: r.vessel_imo, etd: r.etd || "", eta: r.eta || "",
      etdSource: r.etd_source || "", etaSource: r.eta_source || "",
    })));
  });

  app.post("/api/test-tools/ais/simulate-static", write, async (req, res) => {
    const { imo, mmsi, name } = req.body;
    if (!imo || !mmsi || !name) return err(res, "imo, mmsi, and name are required");
    await ingestAisMessage({
      MessageType: "ShipStaticData",
      MetaData: { MMSI: Number(mmsi), ShipName: name, time_utc: new Date().toISOString() },
      Message: { ShipStaticData: { ImoNumber: Number(imo), UserID: Number(mmsi), Name: name } },
    });
    const [row] = await query("SELECT * FROM vessels WHERE imo=$1", [String(imo)]);
    ok(res, { imo: String(imo), applied: !!row, vessel: row ? mapVessel(row) : null });
  });

  app.post("/api/test-tools/ais/simulate-position", write, async (req, res) => {
    const { legId, event } = req.body;
    if (!legId || !["departure", "arrival"].includes(event)) return err(res, "legId and event ('departure'|'arrival') are required");
    const [leg] = await query("SELECT * FROM shipment_legs WHERE id=$1", [legId]);
    if (!leg) return err(res, "Leg not found", 404);
    if (!leg.vessel_imo) return err(res, "Leg has no vessel IMO set — nothing to match against");
    const [vessel] = await query("SELECT mmsi FROM vessels WHERE imo=$1", [leg.vessel_imo]);
    if (!vessel || !vessel.mmsi) return err(res, "No known MMSI for this vessel yet — simulate a ShipStaticData message for it first");

    const targetUnlocode = event === "departure" ? leg.pol : leg.pod;
    const [port] = await query("SELECT latitude, longitude FROM port_locations WHERE unlocode=$1", [targetUnlocode]);
    if (!port || !port.latitude || !port.longitude) return err(res, `No coordinates on file for ${targetUnlocode}`);

    // The live listener only re-pulls its tracked-leg cache every 60s (fine for a real feed
    // pushing up to hundreds of messages/sec — not fine for a leg a developer just created
    // moments ago via this same simulator). Force it fresh before injecting.
    await forceRefreshAisTrackedLegs();

    // Two-step transition, matching what the listener's detection logic requires (a state
    // *change*, not a single snapshot): departure = stopped (moored/anchor) -> under way;
    // arrival = under way -> stopped (moored/anchor).
    const firstStatus  = event === "departure" ? 5 /* moored */ : 8 /* under way sailing */;
    const secondStatus = event === "departure" ? 0 /* under way using engine */ : 1 /* at anchor */;
    const base = {
      MessageType: "PositionReport",
      MetaData: { MMSI: Number(vessel.mmsi), time_utc: new Date().toISOString() },
    };
    await ingestAisMessage({ ...base, Message: { PositionReport: {
      Latitude: port.latitude, Longitude: port.longitude, NavigationalStatus: firstStatus, UserID: Number(vessel.mmsi),
    } } });
    await ingestAisMessage({ ...base, Message: { PositionReport: {
      Latitude: port.latitude, Longitude: port.longitude, NavigationalStatus: secondStatus, UserID: Number(vessel.mmsi),
    } } });

    const [fresh] = await query("SELECT * FROM shipment_legs WHERE id=$1", [legId]);
    ok(res, mapShipmentLeg(fresh));
  });
};
