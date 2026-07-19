// ─── Services change bus ──────────────────────────────────────────────────────
// Pub-sub (same shape as toast.js): ServicesPanel (Overview) and the shipment
// sidebar (self-fetches its own copy of shipment_services to decide which Export/
// Import Services nav rows to show) are cousins, not parent/child — this lets
// ordering a service on Overview refresh the sidebar's nav visibility immediately
// instead of only on the next navigation.

const listeners = new Set();

export const emitServicesChanged = shipmentId => listeners.forEach(fn => fn(shipmentId));

export const onServicesChanged = fn => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
