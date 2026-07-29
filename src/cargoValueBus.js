// ─── Cargo value change bus ────────────────────────────────────────────────────
// Pub-sub (same shape as servicesBus.js/toast.js): ShipmentContainersPage (Cargo
// page) and ShipmentHeaderBar (persistent, mounted once in App.jsx — never
// remounts on navigation) are cousins, not parent/child. The header's own Cargo
// Value rollup only refetches when the shipment's set of container ids changes,
// not when a pack item's price is added/edited/removed on an unchanged container —
// this lets saving/deleting a priced pack item refresh the header immediately
// instead of only on the next full reload.

const listeners = new Set();

export const emitCargoValueChanged = shipmentId => listeners.forEach(fn => fn(shipmentId));

export const onCargoValueChanged = fn => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
