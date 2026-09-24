// Office-Side Permissions Epic (TKT-Z0LB0W), Phase 3 (TKT-5W24J7) — client-side mirror of the
// server's officeSideOf/blockIfWrongSide (server.js). The server re-checks this on every write;
// this only decides what the UI renders as editable vs read-only, matching the approved mockup.
//
// Deliberately centralized here, unlike the older canEditSideDept pattern (ShipmentSchedulesPage,
// PartiesOfficesPanel) which reimplements its own small check locally per file — that one has
// exactly two consumers (the Line Agent fields) and predates this epic. This one has 5+ consumers
// across the shipment detail sub-pages, and "two engines independently computing the same
// permission and drifting apart" is this codebase's own most-repeated bug class (see the comment
// on server.js's applyOfficeScopedAccessFilter) — worth a single source of truth from the start
// rather than waiting for the drift to actually happen.
//
// `auth` is whatever useAuth() returns (or a subset with these same field names); `shipment` is
// any shipment object carrying the myOfficeSide field GET /api/shipments now computes per row.
export function canEditShipmentSide(auth, shipment, side) {
  const { canEditShipments, isAdmin, activeRoles, allOffices } = auth || {};
  if (!canEditShipments) return false;
  if (isAdmin || (activeRoles || []).includes("operator") || allOffices) return true;
  const mySide = shipment?.myOfficeSide;
  return mySide === "unrestricted" || mySide === side;
}
