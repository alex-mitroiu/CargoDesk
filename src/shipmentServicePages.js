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

// "Pickup/Delivery" was split into separate "Pickup" and "Delivery" entries (mirroring the
// earlier Loading/Unloading split, TKT-6292VK) — each needs its own nav entry and, now, its
// own Merchant's Haulage awareness (a Pickup service matters for an Export shipment's own
// Pick-up leg; Delivery for an Import shipment's own Delivery leg). Existing shipment_services
// rows saved with the old combined "Pickup/Delivery" label are free text and simply keep
// displaying it — no migration, same non-migration precedent Loading/Unloading's split used.
//
// "Haulage" was removed outright (not split) — it was a generic both-sides duplicate of a
// distinction Pickup/Delivery already make directly: Pickup *is* the origin-side/export
// haulage arrangement, Delivery *is* the destination-side/import one, each with its own
// Merchant's-vs-Carrier's-Haulage routing awareness already. A separate ambiguous "Haulage"
// type alongside them offered no distinction those two don't already cover. Same no-migration
// precedent as above — any shipment_services row already saved with serviceType "Haulage"
// keeps displaying wherever it's read directly (the Overview ServicesPanel's own list, which
// reads straight off `services` with no SERVICE_TYPES membership check); it just no longer
// gets a dedicated sidebar nav page/route now that "Haulage" isn't in the canonical list.
export const SERVICE_TYPES = ["VGM", "Fumigation", "Storage", "CY Storage",
  "Warehousing", "Pickup", "Delivery", "Loading", "Unloading", "Customs Clearance", "Other"];

// Which side(s) a type can actually be ordered under — real freight-forwarding terms, not
// arbitrary: VGM/Loading/Pickup are origin-side activities (weighing and loading the cargo,
// picking it up for the carrier), so Export-only; Unloading/Delivery are the destination-side
// mirror of those same two, so Import-only. Everything else genuinely happens on both sides
// under the same name (origin vs destination Storage/CY Storage/Warehousing, export vs import
// Customs Clearance, Fumigation either end depending on commodity/route, "Other" being free
// text) and stays unrestricted. A type with no entry here is valid on both sides.
export const SERVICE_TYPE_SIDES = {
  VGM:       ["Export"],
  Loading:   ["Export"],
  Pickup:    ["Export"],
  Unloading: ["Import"],
  Delivery:  ["Import"],
};

export const serviceTypesForSide = side =>
  SERVICE_TYPES.filter(t => !SERVICE_TYPE_SIDES[t] || SERVICE_TYPE_SIDES[t].includes(side));

// Types with their own bespoke page — Loading/Unloading share LoadingServicePage.jsx
// (parameterized by a serviceType prop, identical per-container date/time-plan +
// attachment/produced-document shape); Pickup/Delivery now share it too (same shape, plus
// a Merchant's Haulage routing card the other two don't show). Every other type in
// SERVICE_TYPES renders the shared GenericServicePage.jsx (vendor/status recap + notes + a
// generic produced document under the catch-all "OT" doc type) — not the WIP placeholder
// anymore, that component was removed once every remaining type had a real (if generic)
// page. "Other" is free text per instance and never gets a dedicated catalog page at all.
export const BESPOKE_SERVICE_TYPES = ["Loading", "Unloading", "Pickup", "Delivery"];

export const SERVICE_SIDES = ["Export", "Import"];

export const SERVICE_TYPE_ICON = {
  VGM: "⚖️", Fumigation: "🧪", Storage: "📦", "CY Storage": "🏗",
  Warehousing: "🏬", Pickup: "🚚", Delivery: "📍", Loading: "⬆️", Unloading: "⬇️",
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
