// ─── Export/Import Services: dedicated per-service configuration pages ───────
// Epic TKT-TBS7QD. When a service is ordered from ServicesPanel (Overview), a nav
// entry for that specific service type becomes visible in the shipment sidebar
// under a new "Export Services" / "Import Services" parent row. The full
// combinatorial set of side x type page keys is precomputed statically here (same
// approach as shipmentSections.js) even though only a subset is ever visible on
// any one shipment — which rows actually show is a runtime decision (does this
// shipment have that type ordered, non-cancelled) made in App.jsx's sidebar, not
// baked into this config. SERVICE_TYPES lives here rather than in ServicesPanel.jsx
// since both the request-service form and this nav/routing config need the same
// canonical list.

export const SERVICE_TYPES = ["VGM", "Haulage", "Fumigation", "Storage", "CY Storage",
  "Warehousing", "Pickup/Delivery", "Loading", "Unloading", "Customs Clearance", "Other"];

// Types with their own bespoke page — Loading/Unloading share LoadingServicePage.jsx
// (parameterized by a serviceType prop, identical per-container date/time-plan +
// attachment/produced-document shape). Every other type in SERVICE_TYPES renders the
// shared GenericServicePage.jsx (vendor/status recap + notes + a generic produced
// document under the catch-all "OT" doc type) — not the WIP placeholder anymore, that
// component was removed once every remaining type had a real (if generic) page. "Other"
// is free text per instance and never gets a dedicated catalog page at all.
export const BESPOKE_SERVICE_TYPES = ["Loading", "Unloading"];

export const SERVICE_SIDES = ["Export", "Import"];

export const SERVICE_TYPE_ICON = {
  VGM: "⚖️", Haulage: "🚛", Fumigation: "🧪", Storage: "📦", "CY Storage": "🏗",
  Warehousing: "🏬", "Pickup/Delivery": "🚚", Loading: "⬆️", Unloading: "⬇️",
  "Customs Clearance": "🛃",
};

export const serviceTypeSlug = type =>
  String(type).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

export const isBespokeServiceType = type => BESPOKE_SERVICE_TYPES.includes(type);
export const servicePageKey = (side, type) => `service-${side.toLowerCase()}-${serviceTypeSlug(type)}`;

const DEDICATED_TYPES = SERVICE_TYPES.filter(t => t !== "Other");

const ALL_SERVICE_PAGES = SERVICE_SIDES.flatMap(side =>
  DEDICATED_TYPES.map(type => {
    const slug = serviceTypeSlug(type);
    return {
      pageKey: servicePageKey(side, type),
      hashKey: `${side.toLowerCase()}/${slug}`,
      side, type,
      label: `${type} Service`,
    };
  })
);

export const SERVICE_PAGE_KEYS       = ALL_SERVICE_PAGES.map(p => p.pageKey);
export const SERVICE_SUBPAGES        = Object.fromEntries(ALL_SERVICE_PAGES.map(p => [p.hashKey, p.pageKey]));
export const SERVICE_SUBPAGE_HASHES  = Object.fromEntries(ALL_SERVICE_PAGES.map(p => [p.pageKey, p.hashKey]));
export const SERVICE_SUBPAGE_LABELS  = Object.fromEntries(ALL_SERVICE_PAGES.map(p => [p.pageKey, p.label]));
export const SERVICE_PAGE_INFO       = Object.fromEntries(ALL_SERVICE_PAGES.map(p => [p.pageKey, { side: p.side, type: p.type }]));
