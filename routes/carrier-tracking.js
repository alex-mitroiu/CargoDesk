"use strict";

// Track & Trace from the carrier (Epic TKT-KG4E49, 2026-10-09) — pulls a booking's DCSA events
// (GET /v2/events by carrierBookingReference) and records the ones CargoDesk tracks as container
// events, through the same recordContainerEvent the manual route uses, so milestones complete
// the same way. Mapping rules: lib/carrier-integrations/tnt-mapping.js. A carrier event already
// recorded (same container + carrier eventID), or a container that already has that event type
// (logged by hand, say), is left alone — re-pulling never duplicates.
//
// Pull, not push: "Sync carrier events" on Milestones & Events, plus a sweep every
// TRACKING_SWEEP_MINUTES for shipments whose carrier booking number is known and whose
// containers aren't all back empty yet. Needs the integration's 'tracking' capability.

const { mapTrackTraceEvents } = require("../lib/carrier-integrations/tnt-mapping");

module.exports = function carrierTrackingRoutes(app, ctx) {
  const { query, ok, err, requireRole, carrierIntegrationFor, getSettings } = ctx;
  const write = requireRole(["operator", "admin", "occ_bk"]);

  async function syncCarrierEvents(shipment) {
    const [booking] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipment.id]);
    if (!booking?.booking_ref) return { ok: false, status: 409, error: "The carrier hasn't given a booking number yet — Track & Trace looks events up by it" };
    const integ = await carrierIntegrationFor(booking.carrier_code, "tracking");
    if (!integ?.adapter.getEvents) return { ok: false, status: 409, error: `No active Track & Trace integration for ${booking.carrier_code}` };
    const result = await integ.adapter.getEvents(integ.config, { carrierBookingReference: booking.booking_ref });
    if (!result.ok) return { ok: false, status: 502, error: `${booking.carrier_code} could not be asked for events (${result.error})` };

    const containers = await query("SELECT * FROM containers WHERE shipment_id=$1", [shipment.id]);
    const { add, skipped } = mapTrackTraceEvents(result.events, {
      pol: shipment.pol, pod: shipment.pod, containers: containers.map(c => ({ id: c.id, containerNumber: c.container_number })),
    });
    const existing = await query("SELECT container_id, event_type, carrier_event_id FROM container_events WHERE shipment_id=$1", [shipment.id]);
    const seenId = new Set(existing.filter(e => e.carrier_event_id).map(e => `${e.container_id}|${e.carrier_event_id}`));
    const seenType = new Set(existing.map(e => `${e.container_id}|${e.event_type}`));
    const added = [];
    let alreadyRecorded = 0;
    // Oldest first, so milestones complete in the order things happened.
    for (const a of [...add].sort((x, y) => String(x.occurredAt).localeCompare(String(y.occurredAt)))) {
      if (seenId.has(`${a.containerId}|${a.carrierEventId}`) || seenType.has(`${a.containerId}|${a.eventType}`)) { alreadyRecorded++; continue; }
      const ctr = containers.find(c => c.id === a.containerId);
      added.push(await ctx.recordContainerEvent(ctr, {
        eventType: a.eventType, occurredAt: a.occurredAt, location: a.location,
        notes: `From ${booking.carrier_code} Track & Trace`, recordedBy: `${booking.carrier_code} Track & Trace`, carrierEventId: a.carrierEventId,
      }));
      seenId.add(`${a.containerId}|${a.carrierEventId}`);
      seenType.add(`${a.containerId}|${a.eventType}`);
    }
    await query("UPDATE carrier_bookings SET events_synced_at=$1 WHERE id=$2", [new Date().toISOString(), booking.id]);
    return { ok: true, added, alreadyRecorded, skipped, received: result.events.length };
  }

  app.post("/api/shipments/:id/carrier-events/sync", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const r = await syncCarrierEvents(shipment);
    if (!r.ok) return err(res, r.error, r.status);
    ok(res, { added: r.added, alreadyRecorded: r.alreadyRecorded, skipped: r.skipped, received: r.received });
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
