"use strict";

// Booking escalations (Epic TKT-ASIYFL) — the shipment's escalation, escalating a booking, acting on an
// escalation, the handler's alternatives, and "escalated to me" for the bell. The rules live in
// lib/booking-escalations.js (ctx.bookingEscalations); every route first checks the caller can see the
// shipment at all (applyShipmentAccessFilter), then the lib checks the role and side or lane.

module.exports = function bookingEscalationRoutes(app, ctx) {
  const { query, ok, err, auth, requireRole, mapShipment, applyShipmentAccessFilter, blockIfWrongSide, shipmentSubs, bookingEscalations: be } = ctx;
  const occBk = requireRole(["admin", "operator", "occ_bk"]);

  function broadcast(shipmentId) {
    const subs = shipmentSubs.get(shipmentId);
    if (!subs) return;
    const json = JSON.stringify({ type: "escalation_changed", shipmentId });
    for (const ws of subs) { if (ws.readyState === ws.OPEN) ws.send(json); }
  }

  // The shipment row, or null when it doesn't exist or the caller can't see it.
  async function visibleShipment(req, id) {
    const [row] = await query("SELECT * FROM shipments WHERE id=$1", [id]);
    if (!row) return null;
    const [seen] = await applyShipmentAccessFilter([mapShipment(row)], req.user, req);
    return seen ? row : null;
  }

  async function view(req, row) {
    const shipment = mapShipment(row);
    const esc = (await be.activeRow(row.id)) || (await be.latestRow(row.id));
    return {
      escalation: be.mapEscalation(esc),
      booked: esc ? await be.wasBooked(esc.id) : false,
      place: esc ? await be.holderPlace(esc.holder_role, shipment) : "",
      instructedByPlace: esc?.instructed_by_role ? await be.holderPlace(esc.instructed_by_role, shipment) : "",
      steps: esc ? await be.stepsOf(esc.id) : [],
      actions: await be.allowedActions(esc, req.user, req, shipment),
      offer: await be.escalationOffer(row, req.user, req),
    };
  }

  app.get("/api/shipments/:id/escalation", auth(), async (req, res) => {
    const row = await visibleShipment(req, req.params.id);
    if (!row) return err(res, "Shipment not found", 404);
    ok(res, await view(req, row));
  });

  // OCC/BK escalates: { toRole: 'occ_ay'|'ccl_co' (default from App Settings), reasonCode, note }.
  app.post("/api/shipments/:id/escalations", occBk, async (req, res) => {
    const row = await visibleShipment(req, req.params.id);
    if (!row) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, row, "export")) return;
    const { toRole, reasonCode = "", note = "" } = req.body || {};
    const r = await be.create({ shipmentId: row.id, toRole, reasonCode, note, user: req.user });
    if (!r.ok) return err(res, r.error, r.status);
    broadcast(row.id);
    ok(res, await view(req, row), 201);
  });

  // { action: hand_over | escalate | send_back | instruct | impossible | question | message | withdraw,
  //   toRole?, message?, instruction?: { carrierCode, contractId, contractNumber, allocationId, sailing }, reason? }
  app.post("/api/escalations/:id/actions", auth(), async (req, res) => {
    const [esc] = await query("SELECT shipment_id FROM booking_escalations WHERE id=$1", [req.params.id]);
    const row = esc && await visibleShipment(req, esc.shipment_id);
    if (!row) return err(res, "Escalation not found", 404);
    const r = await be.act(req.params.id, req.body, req.user, req);
    if (!r.ok) return err(res, r.error, r.status);
    broadcast(row.id);
    ok(res, await view(req, row));
  });

  // OCC/BK books as instructed: the shipment takes the instructions, the booking request goes out.
  app.post("/api/escalations/:id/book", occBk, async (req, res) => {
    const [esc] = await query("SELECT shipment_id FROM booking_escalations WHERE id=$1", [req.params.id]);
    const row = esc && await visibleShipment(req, esc.shipment_id);
    if (!row) return err(res, "Escalation not found", 404);
    if (await blockIfWrongSide(req, res, row, "export")) return;
    const r = await be.book(req.params.id, req.user, req);
    if (!r.ok) return err(res, r.error, r.status);
    broadcast(row.id);
    const [fresh] = await query("SELECT * FROM shipments WHERE id=$1", [row.id]);
    ok(res, { ...(await view(req, fresh)), booking: r.booking, carrierError: r.carrierError });
  });

  // The no-answer sweep (lib/booking-escalations.js sweepNoAnswer), which also runs on a timer
  // (server.js): admin and operator can run it now — and tests do, rather than wait.
  app.post("/api/escalations/no-answer-sweep", requireRole(["admin", "operator"]), async (req, res) => {
    const result = await be.sweepNoAnswer();
    for (const x of [...result.switched, ...result.escalated]) broadcast(x.shipmentId);
    ok(res, result);
  });
  const NO_ANSWER_SWEEP_MINUTES = 5;
  const sweepTimer = setInterval(() => {
    be.sweepNoAnswer()
      .then(r => { for (const x of [...r.switched, ...r.escalated]) broadcast(x.shipmentId); })
      .catch(e => console.error("No-answer sweep failed:", e.message));
  }, NO_ANSWER_SWEEP_MINUTES * 60000);
  sweepTimer.unref?.();

  app.get("/api/shipments/:id/escalation/alternatives", auth(), async (req, res) => {
    const row = await visibleShipment(req, req.params.id);
    if (!row) return err(res, "Shipment not found", 404);
    ok(res, await be.alternatives(row, { source: req.query.source === "contracts" ? "contracts" : "" }));
  });

  // Active escalations the caller can act on now — the bell, and the "Escalated to me" count.
  app.get("/api/escalations/mine", auth(), async (req, res) => {
    const out = [];
    for (const esc of await be.allActive()) {
      const row = await visibleShipment(req, esc.shipment_id);
      if (!row) continue;
      const shipment = mapShipment(row);
      if (!(await be.canActAs(req.user, req, esc.holder_role, shipment))) continue;
      // admin/operator may act as anyone, but "escalated to me" means the people it was routed to.
      const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
      if (!roles.includes(esc.holder_role)) continue;
      out.push({ ...be.mapEscalation(esc), pol: shipment.pol, pod: shipment.pod, place: await be.holderPlace(esc.holder_role, shipment) });
    }
    ok(res, out);
  });
};
