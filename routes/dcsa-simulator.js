"use strict";

// Built-in DCSA carrier simulator — its carrier-side HTTP API (/dcsa-sim/…, lib/dcsa-simulator) and the
// Test Tools controls that play the carrier's decisions (DCSA-everywhere phase 1, TKT-IVI7FM). Also the
// one place screens ask how a carrier is connected (GET /api/carrier-connections/:carrierCode), which
// replaced eAdapter's "bookable carriers" list when eAdapter was retired (2026-10-11).

const { containerIso, dcsaSeals } = require("../lib/dcsa/codes");

module.exports = function dcsaSimulatorRoutes(app, ctx) {
  const { query, ok, err, auth, requireRole, dcsaSimulator, carrierIntegrationFor, mapCarrierBooking, mapShippingInstructions } = ctx;
  const write = requireRole(["operator", "admin", "occ_bk"]);

  dcsaSimulator.registerRoutes(app);

  // How CargoDesk reaches this carrier for each capability: its own DCSA integration, the simulator,
  // or not at all. `demo` = the simulator is standing in (screens badge it DEMO CARRIER).
  app.get("/api/carrier-connections/:carrierCode", auth(), async (req, res) => {
    const carrierCode = String(req.params.carrierCode || "").toUpperCase();
    const capabilities = {};
    for (const cap of ["booking", "shipping-instructions", "vgm", "tracking", "schedules", "vessel-schedules", "spot-rates"]) {
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

  // The carrier's decisions on Shipping Instructions and the Master B/L it drafts from them (2026-10-28):
  // requestUpdate, decline, draft (accept: draft the transport document, or redraft after an update),
  // issue, surrender (the B/L handed in at destination: the instructions become COMPLETED), void; and an
  // amendment CargoDesk asked for: confirmAmendment, declineAmendment, surrenderForAmendment, then issue.
  // { message } is the carrier's feedback text, optional.
  app.post("/api/test-tools/dcsa-sim/shipping-instructions/:ref/:action", write, async (req, res) => {
    if (!(await dcsaSimulator.allowed())) return err(res, "The DCSA carrier simulator is off (App Settings → Demo carrier)", 409);
    const r = await dcsaSimulator.actShippingInstructions(req.params.ref, req.params.action, { message: req.body?.message || "" });
    if (!r.ok) return err(res, r.error, r.status || 400);
    if (!r.delivery?.delivered)
      return err(res, `The simulator decided, but CargoDesk didn't accept its notification (${r.delivery?.status || "no answer"}: ${r.delivery?.body?.error || r.delivery?.error || "unknown"})`, 502);
    const [si] = await query("SELECT * FROM shipping_instructions WHERE si_reference=$1", [req.params.ref]);
    const [master] = si ? await query("SELECT reference, status FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' ORDER BY created_at DESC LIMIT 1", [si.shipment_id]) : [];
    ok(res, { simulator: r.transportDocument || r.shippingInstructions || null, ...(r.refused ? { refused: r.refused } : {}),
      shippingInstructions: si ? mapShippingInstructions(si) : null,
      masterBl: master ? { reference: master.reference, status: master.status } : null });
  });
  app.get("/api/test-tools/dcsa-sim/transport-documents", write, async (req, res) => {
    if (!(await dcsaSimulator.allowed())) return err(res, "The DCSA carrier simulator is off (App Settings → Demo carrier)", 409);
    ok(res, await dcsaSimulator.transportDocuments());
  });

  // ─── Track & Trace 3.0: what the demo carrier reports (2026-10-28) ──────────
  // The carrier reports `kind` about one of its bookings — gateIn, loaded, departed, arrived, discharged,
  // customsReleased, gateOut, emptyReturn, released — from what it knows of it (its booking number, the
  // containers, the ports, the vessel and voyage of the leg at that port). { classifier: ESTIMATED | PLANNED,
  // dateTime } for an expected departure or arrival; dateTime defaults to now. It pushes the events to
  // CargoDesk; the answer shows what CargoDesk made of them.
  const offOrNot = async res => (await dcsaSimulator.allowed()) ? false : (err(res, "The DCSA carrier simulator is off (App Settings → Demo carrier)", 409), true);
  app.post("/api/test-tools/dcsa-sim/events", write, async (req, res) => {
    if (await offOrNot(res)) return;
    const { shipmentId = "", kind = "", classifier = "ACTUAL", dateTime = "", updatedAt = "", routeBy = "" } = req.body || {};
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const [cb] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (!cb?.is_mock) return err(res, "Only a booking made with the demo carrier can be reported on here", 409);
    const containers = await query("SELECT container_number, size, type, iso_equipment_code FROM containers WHERE shipment_id=$1 ORDER BY container_number", [shipment.id]);
    const legs = await query("SELECT * FROM shipment_legs WHERE shipment_id=$1 AND (leg_type='SEA' OR (COALESCE(leg_type,'')='' AND mot='SEA')) ORDER BY leg_order", [shipment.id]);
    const atPod = ["arrived", "discharged", "customsReleased", "gateOut", "emptyReturn", "released"].includes(kind);
    const leg = (atPod ? [...legs].reverse().find(l => l.pod === shipment.pod) : legs.find(l => l.pol === shipment.pol)) || legs[0] || {};
    const [master] = await query("SELECT reference FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' AND status<>'VOIDED' ORDER BY created_at DESC LIMIT 1", [shipment.id]);
    const r = await dcsaSimulator.trackTrace.report(kind, { carrierCode: cb.carrier_code, bookingRef: cb.booking_ref,
      containers: containers.map(c => ({ number: c.container_number, iso: containerIso(c) })),
      pol: shipment.pol, pod: shipment.pod, vessel: { imo: leg.vessel_imo || "", name: leg.vessel || "" }, voyage: leg.voyage || "",
      dateTime, classifier, tdRef: master?.reference || "", updatedAt, routeBy });
    if (!r.ok) return err(res, r.error, r.status || 400);
    if (!r.delivery?.delivered)
      return err(res, `The simulator reported, but CargoDesk didn't take the events (${r.delivery?.status || "no answer"}: ${r.delivery?.body?.error || r.delivery?.error || "unknown"})`, 502);
    const rows = await query("SELECT * FROM carrier_events WHERE shipment_id=$1 ORDER BY event_date_time DESC, received_at DESC", [shipment.id]);
    ok(res, { reported: r.events.map(e => e.eventID), feedback: r.delivery.body?.feedbackElements || [], carrierEvents: rows.map(ctx.trackTrace.mapCarrierEvent) });
  });
  app.post("/api/test-tools/dcsa-sim/events/:eventId/retract", write, async (req, res) => {
    if (await offOrNot(res)) return;
    const r = await dcsaSimulator.trackTrace.retract(req.params.eventId);
    if (!r.ok) return err(res, r.error, r.status || 400);
    if (!r.delivery?.delivered) return err(res, `The simulator retracted it, but CargoDesk didn't take the retraction (${r.delivery?.status || "no answer"})`, 502);
    ok(res, { retracted: req.params.eventId, feedback: r.delivery.body?.feedbackElements || [] });
  });
  app.get("/api/test-tools/dcsa-sim/events", write, async (req, res) => {
    if (await offOrNot(res)) return;
    ok(res, await dcsaSimulator.trackTrace.list({ bookingRef: String(req.query.bookingRef || "") }));
  });

  // ─── Arrival Notice 1.0 and Port Call 2.0 (phase 8, 2026-10-28) ──
  // The demo carrier publishes an arrival notice for the B/L it issued on one of its bookings: { shipmentId,
  // eta, classifier, freeDays, detentionDays, charges, released: { freight, obl, customs }, lightweight }.
  // Defaults: the shipment's ETA, 4 days' demurrage and 7 days' detention, three destination charges.
  app.post("/api/test-tools/dcsa-sim/arrival-notices", write, async (req, res) => {
    if (await offOrNot(res)) return;
    const b = req.body || {};
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [b.shipmentId || ""]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const [cb] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (!cb?.is_mock) return err(res, "Only a booking made with the demo carrier can get its arrival notice here", 409);
    const [master] = await query("SELECT reference FROM transport_documents WHERE shipment_id=$1 AND role='MASTER' AND status<>'VOIDED' ORDER BY created_at DESC LIMIT 1", [shipment.id]);
    const [house] = await query("SELECT reference FROM transport_documents WHERE shipment_id=$1 AND role='HOUSE' AND status NOT IN ('DRAFT','VOIDED') ORDER BY created_at DESC LIMIT 1", [shipment.id]);
    const legs = await query("SELECT * FROM shipment_legs WHERE shipment_id=$1 AND (leg_type='SEA' OR (COALESCE(leg_type,'')='' AND mot='SEA')) ORDER BY leg_order", [shipment.id]);
    const leg = [...legs].reverse().find(l => l.pod === shipment.pod) || legs[legs.length - 1] || {};
    const containers = await query("SELECT * FROM containers WHERE shipment_id=$1 ORDER BY container_number", [shipment.id]);
    const r = await dcsaSimulator.arrivalNotices.publish({ carrierCode: cb.carrier_code, tdRef: master?.reference || shipment.master_bl_number || "",
      houseRefs: [house?.reference || shipment.bl_number].filter(Boolean), pol: shipment.pol, pod: shipment.pod,
      vessel: { imo: leg.vessel_imo || "", name: leg.vessel || shipment.vessel || "" }, voyage: leg.voyage || shipment.voyage || "",
      eta: String(b.eta || leg.eta || shipment.eta || "").slice(0, 10), classifier: b.classifier || "ESTIMATED",
      containers: containers.map(c => ({ number: c.container_number, iso: containerIso(c), seals: dcsaSeals(c) })),
      freeDays: b.freeDays === undefined ? undefined : Number(b.freeDays), detentionDays: b.detentionDays === undefined ? undefined : Number(b.detentionDays),
      charges: Array.isArray(b.charges) ? b.charges : undefined, released: b.released || {}, lightweight: !!b.lightweight });
    if (!r.ok) return err(res, r.error, r.status || 400);
    if (!r.delivery?.delivered)
      return err(res, `The simulator published it, but CargoDesk didn't take it (${r.delivery?.status || "no answer"}: ${r.delivery?.body?.error || r.delivery?.error || "unknown"})`, 502);
    ok(res, { versionLabel: r.arrivalNotice.versionLabel, feedback: r.delivery.body?.feedbackElements || [], arrivalNotice: await ctx.arrivalNotices.view(shipment.id) }, 201);
  });
  app.get("/api/test-tools/dcsa-sim/arrival-notices", write, async (req, res) => {
    if (await offOrNot(res)) return;
    ok(res, await dcsaSimulator.arrivalNotices.list({ tdRef: String(req.query.tdRef || "") }));
  });
  // A berth arrival or departure as a Port Call event: { vesselImo, vesselName, voyage, unLocationCode,
  // kind: ARRI | DEPA, classifier, dateTime }.
  app.post("/api/test-tools/dcsa-sim/port-calls", write, async (req, res) => {
    if (await offOrNot(res)) return;
    const r = await dcsaSimulator.arrivalNotices.reportPortCall(req.body || {});
    if (!r.ok) return err(res, r.error, r.status || 400);
    if (!r.delivery?.delivered) return err(res, `The simulator reported it, but CargoDesk didn't take it (${r.delivery?.status || "no answer"})`, 502);
    ok(res, { eventID: r.event.eventID, feedback: r.delivery.body?.feedbackElements || [] }, 201);
  });

  // ─── Operational Vessel Schedules 3.0: the demo carrier's vessel times (2026-10-28) ──
  // { vesselImo | vesselName, voyage, unLocationCode, eventTypeCode: ARRI | DEPA, eventClassifierCode: PLN | EST | ACT,
  //   eventDateTime, carrierCode?, serviceCode? }. CargoDesk reads them with "Check vessel times".
  app.post("/api/test-tools/dcsa-sim/vessel-calls", write, async (req, res) => {
    if (await offOrNot(res)) return;
    const r = await dcsaSimulator.vesselSchedules.setCall(req.body || {});
    if (!r.ok) return err(res, r.error, r.status || 400);
    ok(res, (await dcsaSimulator.vesselSchedules.calls({ vesselImo: String(req.body.vesselImo || ""), voyage: String(req.body.voyage || "") })), 201);
  });
  app.get("/api/test-tools/dcsa-sim/vessel-calls", write, async (req, res) => {
    if (await offOrNot(res)) return;
    ok(res, await dcsaSimulator.vesselSchedules.calls({ vesselImo: String(req.query.vesselImo || ""), voyage: String(req.query.voyage || "") }));
  });

  // The VGM declarations the built-in carrier has received, newest first (?equipmentReference= narrows
  // to one container): what CargoDesk actually declared, as the carrier holds it.
  app.get("/api/test-tools/dcsa-sim/vgm-declarations", write, async (req, res) => {
    if (!(await dcsaSimulator.allowed())) return err(res, "The DCSA carrier simulator is off (App Settings → Demo carrier)", 409);
    ok(res, await dcsaSimulator.vgmDeclarations({ equipmentReference: String(req.query.equipmentReference || "").toUpperCase() }));
  });
};
