// The shipment pages drawn in Trade Horizon Next (mockup 402fb5b5): the header with the route strip (ShipmentHeaderBar
// horizonNext) and the » pill (ShipmentAdvanceBar data-variant="next"). The user's rule (2026-11-18): every design and
// build uses the latest patterns, so a page joins this list when it is built in Next. Carrier Booking's two page keys are
// both here (mockup a3e1b986 v2, point G) so the header doesn't change between Details and Review.
export const HORIZON_NEXT_PAGES = Object.freeze([
  "shipment-schedules",
  "shipment-carrier-booking-details",
  "shipment-carrier-booking-review",
  // The Pickup and Delivery services' pages (haulage stops, 2026-11-20, mockup 3d91c28a, §8.56).
  "service-export-pickup",
  "service-import-delivery",
]);

export const isHorizonNextPage = page => HORIZON_NEXT_PAGES.includes(page);
