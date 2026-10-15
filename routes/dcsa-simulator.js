"use strict";

// Built-in DCSA carrier simulator — its carrier-side HTTP API (/dcsa-sim/…, lib/dcsa-simulator) and the
// Test Tools controls that play the carrier's decisions (DCSA-everywhere phase 1, TKT-IVI7FM). Also the
// one place screens ask how a carrier is connected (GET /api/carrier-connections/:carrierCode), which
// replaced eAdapter's "bookable carriers" list when eAdapter was retired (2026-10-11).

module.exports = function dcsaSimulatorRoutes(app, ctx) {
  const { query, ok, err, auth, requireRole, dcsaSimulator, carrierIntegrationFor, mapCarrierBooking } = ctx;
  const write = requireRole(["operator", "admin", "occ_bk"]);

  dcsaSimulator.registerRoutes(app);

  // How CargoDesk reaches this carrier for each capability: its own DCSA integration, the simulator,
  // or not at all. `demo` = the simulator is standing in (screens badge it DEMO CARRIER).
  app.get("/api/carrier-connections/:carrierCode", auth(), async (req, res) => {
    const carrierCode = String(req.params.carrierCode || "").toUpperCase();
    const capabilities = {};
    for (const cap of ["booking", "tracking", "schedules"]) {
      const c = await carrierIntegrationFor(carrierCode, cap);
      capabilities[cap] = c ? { via: c.row.is_simulator ? "simulator" : "integration", demo: !!c.row.is_simulator } : null;
    }
    ok(res, { carrierCode, capabilities, simulatorAvailable: await dcsaSimulator.allowed() });
  });

  // For App Settings' Demo carrier card: outside production the simulator is always on and the card
  // shows no switch; in production it follows the dcsa_demo_carrier_enabled setting.
  app.get("/api/dcsa-simulator/status", auth(), async (req, res) => {
    const production = process.env.NODE_ENV === "production";
    ok(res, { production, available: await dcsaSimulator.allowed(), capabilities: [...dcsaSimulator.CAPABILITIES] });
  });

  // ─── Test Tools: play the carrier ───────────────────────────────────────────
  // The simulator's bookings, newest first, each with the CargoDesk shipment it belongs to and the
  // decisions the carrier can take from its current state. Only bookings CargoDesk still holds:
  // deleting a shipment deletes its booking here, but the carrier keeps its copy (as a real one
  // would), and a decision on it would match nothing — the panel used to fill up with
  // "(shipment deleted)" rows (2026-10-15).
  app.get("/api/test-tools/dcsa-sim/bookings", write, async (req, res) => {
    if (!(await dcsaSimulator.allowed())) return err(res, "The DCSA carrier simulator is off (App Settings → Demo carrier)", 409);
    const sims = await dcsaSimulator.list();
    if (!sims.length) return ok(res, []);
    const refs = sims.map(s => s.carrierBookingRequestReference);
    const rows = await query(`SELECT cb.*, s.pol, s.pod FROM carrier_bookings cb JOIN shipments s ON s.id = cb.shipment_id
      WHERE cb.carrier_booking_request_reference IN (${refs.map((_, i) => `$${i + 1}`).join(",")})`, refs);
    const byRef = new Map(rows.map(r => [r.carrier_booking_request_reference, r]));
    ok(res, sims.filter(s => byRef.has(s.carrierBookingRequestReference)).map(s => {
      const r = byRef.get(s.carrierBookingRequestReference);
      return { ...s, shipmentId: r.shipment_id, pol: r.pol || null, pod: r.pod || null, cargoDeskBooking: mapCarrierBooking(r) };
    }));
  });

  // { message } is the carrier's feedback text (shown on the booking), optional.
  app.post("/api/test-tools/dcsa-sim/bookings/:ref/:action", write, async (req, res) => {
    if (!(await dcsaSimulator.allowed())) return err(res, "The DCSA carrier simulator is off (App Settings → Demo carrier)", 409);
    const r = await dcsaSimulator.act(req.params.ref, req.params.action, { message: req.body?.message || "" });
    if (!r.ok) return err(res, r.error, r.status || 400);
    const [row] = await query("SELECT * FROM carrier_bookings WHERE carrier_booking_request_reference=$1", [req.params.ref]);
    if (!r.delivery?.delivered)
      return err(res, `The simulator decided, but CargoDesk didn't accept its notification (${r.delivery?.status || "no answer"}: ${r.delivery?.body?.error || r.delivery?.error || "unknown"})`, 502);
    ok(res, { simulator: r.booking, booking: row ? mapCarrierBooking(row) : null });
  });
};
