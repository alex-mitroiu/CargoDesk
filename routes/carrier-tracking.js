"use strict";

// Track & Trace from the carrier (Epic TKT-KG4E49, 2026-10-09; Track & Trace 3.0 and the DCSA event model
// since 2026-10-28) — pulls a booking's DCSA events (GET /events by carrierBookingReference: shipment,
// transport and equipment events) and hands them to ctx.trackTrace.applyEvents (lib/track-trace.js), the
// same path a carrier's pushed events take: kept in carrier_events, container lifecycle events through the
// shared recordContainerEvent, vessel times onto the sea legs, milestones from the DCSA events. Re-pulling
// never duplicates: an event already kept unchanged, or a container that already has that event type
// (logged by hand, say), is left alone.
//
// "Sync carrier events" on Milestones & Events, plus a sweep every TRACKING_SWEEP_MINUTES for shipments
// booked through an integration whose carrier booking number is known and whose containers aren't all back
// empty yet. Needs the 'tracking' capability (the demo carrier has it too, for "Sync carrier events").

module.exports = function carrierTrackingRoutes(app, ctx) {
  const { query, ok, err, auth, requireRole, carrierIntegrationFor, getSettings } = ctx;
  const write = requireRole(["operator", "admin", "occ_bk"]);

  async function syncCarrierEvents(shipment) {
    const [booking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (!booking?.booking_ref) return { ok: false, status: 409, error: "The carrier hasn't given a booking number yet — Track & Trace looks events up by it" };
    const integ = await carrierIntegrationFor(booking.carrier_code, "tracking");
    if (!integ?.adapter.getEvents) return { ok: false, status: 409, error: `No active Track & Trace integration for ${booking.carrier_code}` };
    const result = await integ.adapter.getEvents(integ.config, { carrierBookingReference: booking.booking_ref });
    if (!result.ok) return { ok: false, status: 502, error: `${booking.carrier_code} could not be asked for events (${result.error})` };
    const r = await ctx.trackTrace.applyEvents(shipment, result.events, { carrierCode: booking.carrier_code, via: "pull", simulated: !!integ.row.is_simulator });
    await query("UPDATE carrier_bookings SET events_synced_at=$1 WHERE id=$2", [new Date().toISOString(), booking.id]);
    return { ok: true, ...r };
  }

  app.post("/api/shipments/:id/carrier-events/sync", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const r = await syncCarrierEvents(shipment);
    if (!r.ok) return err(res, r.error, r.status);
    ok(res, { added: r.added, alreadyRecorded: r.alreadyRecorded, skipped: r.skipped, received: r.received,
      stored: r.stored, legTimes: r.legTimes, milestones: r.milestones, retracted: r.retracted });
  });

  // Every Track & Trace event the carrier sent about the shipment, newest first, with what CargoDesk did with it.
  app.get("/api/shipments/:id/carrier-events", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM carrier_events WHERE shipment_id=$1 ORDER BY event_date_time DESC, received_at DESC", [req.params.id]);
    ok(res, rows.map(ctx.trackTrace.mapCarrierEvent));
  });

  const TRACKING_SWEEP_MINUTES = 30;
  async function runCarrierEventsSweep({ olderThanMinutes = TRACKING_SWEEP_MINUTES } = {}) {
    if ((await getSettings()).api_carrier_integrations_enabled === 'false') return { synced: 0, added: 0, failed: 0 };
    const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();
    // Booked through an integration, a carrier booking number known, not cancelled, and at least one
    // container not yet back empty.
    const rows = await query(`
      SELECT s.* FROM shipments s
      JOIN carrier_bookings cb ON cb.shipment_id = s.id
      JOIN carrier_integrations ci ON ci.carrier_code = cb.carrier_code AND ci.is_active = TRUE
      WHERE cb.status <> 'Cancelled' AND COALESCE(cb.booking_ref, '') <> '' AND COALESCE(cb.carrier_booking_request_reference, '') <> ''
        AND s.status <> 'Cancelled'
        AND (cb.events_synced_at IS NULL OR cb.events_synced_at <= $1)
        AND EXISTS (SELECT 1 FROM containers c WHERE c.shipment_id = s.id
          AND NOT EXISTS (SELECT 1 FROM container_events e WHERE e.container_id = c.id AND e.event_type = 'Empty Return'))`, [cutoff]);
    const summary = { synced: 0, added: 0, failed: 0 };
    for (const shipment of rows) {
      const r = await syncCarrierEvents(shipment).catch(e => ({ ok: false, error: e.message }));
      if (!r.ok) { summary.failed++; if (r.status !== 409) console.warn(`Track & Trace sync ${shipment.id}:`, r.error); continue; }
      summary.synced++;
      summary.added += r.added.length;
    }
    return summary;
  }
  ctx.runCarrierEventsSweep = runCarrierEventsSweep;
  const timer = setInterval(() => { runCarrierEventsSweep().catch(e => console.error("Track & Trace sweep failed:", e.message)); },
    TRACKING_SWEEP_MINUTES * 60000);
  timer.unref?.();

  // Admin trigger for the same sweep (Test Tools / tests), regardless of when each was last pulled.
  app.post("/api/carrier-events/sync-sweep", requireRole(["admin"]), async (req, res) => {
    ok(res, await runCarrierEventsSweep({ olderThanMinutes: 0 }));
  });
};
