// ─── Legs/schedule change bus ──────────────────────────────────────────────────
// Pub-sub (same shape as cargoValueBus.js/servicesBus.js/toast.js): ShipmentSchedulesPage
// (Contracts & Schedules) and ShipmentHeaderBar (persistent, mounted once in App.jsx — never
// remounts on navigation) are cousins, not parent/child. The header's own legs/schedules
// self-fetch is keyed only on shipment.id, so it never noticed a schedule/leg being removed
// or changed elsewhere — the routing pill, loop code, and header POL/POD kept showing stale
// data after a schedule was unlinked (found live: SHP-8C7JZW). Emit whenever this shipment's
// legs or schedules actually change so the header can refetch immediately instead of only on
// the next full reload/remount.

const listeners = new Set();

export const emitLegsScheduleChanged = shipmentId => listeners.forEach(fn => fn(shipmentId));

export const onLegsScheduleChanged = fn => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
