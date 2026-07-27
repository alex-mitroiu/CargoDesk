// Carriers a booking request can be sent to. Single source of truth on the frontend —
// mirrors ctx.BOOKABLE_CARRIERS on the backend (server.js); the two are separate copies
// (frontend/backend don't share a module) but should be kept in sync if this list changes.
export const BOOKABLE_CARRIERS = new Set(["MAEU", "SAFM", "MCPU"]);

// Finds the leg a Pickup or Delivery service is actually covering — Pickup means the
// shipment's own Pick-up leg, Delivery means its last Delivery leg (a shipment could in
// theory have more than one Delivery-typed leg; the last one is the true final door).
// Shared by LoadingServicePage.jsx (the dedicated Pickup/Delivery Service page) and
// ServicesPanel.jsx (to default the "Request Service" form's type when ordering on a
// Merchant's Haulage shipment) — lives here rather than in either of those since neither
// is the natural home for the other to import from (a shared component importing from a
// page component inverts the usual dependency direction).
export const findRoutingLeg = (legs, serviceType) => serviceType === "Pickup"
  ? legs.find(l => l.legType === "Pick-up") || null
  : [...legs].reverse().find(l => l.legType === "Delivery") || null;
