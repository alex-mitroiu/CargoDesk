// ─── Shipment nav sequence ────────────────────────────────────────────────────
// The shipment sidebar's tree as data: the admin-reorderable top-level order, which Export/
// Import Services rows a shipment shows, and the children of the Booking & Routing and
// Accounting groups. ShipmentDetailSidebar renders its rows from this, and the » Advance bar
// (ShipmentAdvanceBar) walks it — so "the next item" is always the row below in the tree the
// viewer is looking at, and the two can't drift apart.

import { SHIPMENT_SECTIONS, SHIPMENT_SECTIONS_AFTER_ACCOUNTING } from "./shipmentSections";
import { SERVICE_TYPES, servicePageKey } from "./shipmentServicePages";

// Admin-reorderable top-level nav blocks. A block can be a single row (Overview, Cargo, ...)
// or a parent+children group (Booking & Routing, Export/Import Services, Accounting) — only
// the TOP-LEVEL sequence is reorderable; children stay in their existing fixed relative order
// within their own group, keeping the drag interaction simple (11 draggable rows, not an
// arbitrary tree) and avoiding a child ever floating out to become its own top-level item,
// which would break the nav's structural meaning (e.g. "Cost Entry" isn't a thing outside of
// Accounting). This sequence was set via the admin Reorder UI (SHP-JFULNY's saved order,
// promoted to the hardcoded default) rather than the original v0.44.0 default — a fresh
// install with no admin-saved override yet should already start from the intended order.
export const DEFAULT_SIDEBAR_ORDER = [
  "shp-documents", "shp-overview", "shp-milestones", "shp-conditions", "shp-parties",
  "shp-cargo", "shp-booking-routing", "shp-export-services", "shp-import-services",
  "shp-accounting", "shp-history",
];

// Reconciles an admin-saved order (possibly stale — saved before a since-added/removed nav
// block) against the current default: keeps only ids that still exist today, in the saved
// sequence, then appends any current id missing from the saved list (preserving ITS default
// relative position) — so a newly-introduced block always appears rather than silently
// vanishing just because it didn't exist yet when the order was last saved.
export const reconcileSidebarOrder = stored => {
  const valid = stored.filter(id => DEFAULT_SIDEBAR_ORDER.includes(id));
  const missing = DEFAULT_SIDEBAR_ORDER.filter(id => !valid.includes(id));
  return [...valid, ...missing];
};

// The order every user's sidebar uses: app_settings.shipment_sidebar_order, reconciled.
export const sidebarOrderFromSettings = (appSettings = {}) => {
  let stored = [];
  try { stored = JSON.parse(appSettings.shipment_sidebar_order || "[]"); } catch { stored = []; }
  return reconcileSidebarOrder(Array.isArray(stored) ? stored : []);
};

// One nav row per distinct, non-cancelled ordered type per side, in canonical SERVICE_TYPES
// order (not order-ordered) for predictable placement. null services (first fetch still in
// flight) shows nothing yet.
export const orderedServiceTypes = (services, side) => {
  if (!services) return [];
  const ordered = new Set(services.filter(s => s.side === side && s.status !== "Cancelled").map(s => s.serviceType));
  return SERVICE_TYPES.filter(t => t !== "Other" && ordered.has(t));
};

// The rows under "Export Services"/"Import Services". Import Delivery stays grouped under
// "Booking & Routing" (bookingRoutingRows) — excluded here so that group's own visibility
// reflects only the ancillary types it actually still renders. Pickup moved back into Export
// Services as a regular child, per direct request, so it's no longer filtered out here.
export const serviceGroupTypes = (side, orderedTypes) =>
  side === "Import" ? orderedTypes.filter(t => t !== "Delivery") : orderedTypes;

const sectionById = Object.fromEntries(
  [...SHIPMENT_SECTIONS, ...SHIPMENT_SECTIONS_AFTER_ACCOUNTING].map(s => [s.id, s]));

// Each row lists every page that counts as being "on" it: Carrier Booking and Customs Filing
// each have a Details and a Review page, and the row opens the first. The sidebar adds icons,
// badges and locks by id.
export const bookingRoutingRows = importTypes => [
  { id: "shp-schedules", label: sectionById["shp-schedules"].label, pageKeys: ["shipment-schedules"] },
  { id: "shp-carrier-booking", label: "Carrier Booking",
    pageKeys: ["shipment-carrier-booking-details", "shipment-carrier-booking-review"] },
  { id: "shp-shipping-instructions", label: sectionById["shp-shipping-instructions"].label,
    pageKeys: ["shipment-shipping-instructions"] },
  { id: "shp-arrival-notice", label: sectionById["shp-arrival-notice"].label, pageKeys: ["shipment-arrival-notice"] },
  { id: "shp-customs-filing", label: "Customs Filing",
    pageKeys: ["shipment-customs-filing-details", "shipment-customs-filing-review"] },
  ...(importTypes.includes("Delivery")
    ? [{ id: servicePageKey("Import", "Delivery"), label: "Delivery Service", fullLabel: "Import Delivery Service",
        pageKeys: [servicePageKey("Import", "Delivery")] }] : []),
];

export const ACCOUNTING_ROWS = [
  { id: "shp-accounting-invoices", label: "Invoice Entry", pageKeys: ["shipment-accounting-invoices"] },
  { id: "shp-accounting-costs",    label: "Cost Entry",    pageKeys: ["shipment-accounting-costs"] },
  { id: "shp-accounting-gp",       label: "GP Overview",   pageKeys: ["shipment-accounting-gp"] },
];

const serviceRows = (side, orderedTypes) => serviceGroupTypes(side, orderedTypes).map(type => ({
  id: servicePageKey(side, type), label: type, fullLabel: `${side} ${type}`, pageKeys: [servicePageKey(side, type)],
}));

const flatRow = id => [{ id, label: sectionById[id].label, pageKeys: [sectionById[id].pageKey] }];

// Every page the viewer can open from the tree, top to bottom. A group contributes its
// children, not itself — its parent row only opens its first child. Blocks that render nothing
// in the sidebar contribute nothing here: Export/Import Services with nothing ordered, and
// Accounting for a trade manager.
export const shipmentNavSequence = ({ order = DEFAULT_SIDEBAR_ORDER, services, isTradeManager = false }) => {
  const exportTypes = orderedServiceTypes(services, "Export");
  const importTypes = orderedServiceTypes(services, "Import");
  const blocks = {
    "shp-overview":        () => [{ id: "shp-overview", label: "Overview", pageKeys: ["detail"] }],
    "shp-conditions":      () => flatRow("shp-conditions"),
    "shp-parties":         () => flatRow("shp-parties"),
    "shp-cargo":           () => flatRow("shp-cargo"),
    "shp-milestones":      () => flatRow("shp-milestones"),
    "shp-documents":       () => flatRow("shp-documents"),
    "shp-history":         () => flatRow("shp-history"),
    "shp-booking-routing": () => bookingRoutingRows(importTypes),
    "shp-export-services": () => serviceRows("Export", exportTypes),
    "shp-import-services": () => serviceRows("Import", importTypes),
    "shp-accounting":      () => isTradeManager ? [] : ACCOUNTING_ROWS,
  };
  return order.flatMap(id => blocks[id]?.() || []);
};

// The row after the one currentPage belongs to; null on the last row, or when currentPage
// isn't a row of this tree at all (e.g. a service page whose service has since been cancelled).
export const nextNavStop = (sequence, currentPage) => {
  const i = sequence.findIndex(row => row.pageKeys.includes(currentPage));
  return i >= 0 ? sequence[i + 1] || null : null;
};
