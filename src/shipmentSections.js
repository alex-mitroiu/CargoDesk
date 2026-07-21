// ─── Shared Shipment Detail section config ───────────────────────────────────
// Single source of truth for the promoted shipment sub-pages, closing the M9 gap
// (ARCHITECTURE.md §11) where App.jsx previously hand-maintained six separate,
// easily-desynced data structures for the same set of pages. Overview (the anchor
// page, not a promoted route) and Accounting (a nested parent + 3 children under a
// two-segment hash, structurally different from the flat suffix pages below) are
// deliberately NOT part of this array — App.jsx still wires those two in directly.
//
// Order here IS the sidebar nav order (reordered to match the FCL operational
// lifecycle — see CLAUDE.md "Recent changes"): Conditions/Parties (reference info)
// → Schedules → Cargo → Milestones & Events → Documents, then Accounting (hardcoded
// in App.jsx, not listed here), then History (SHIPMENT_SECTIONS_AFTER_ACCOUNTING).

import { IconGroup, IconPackage, IconFlag, IconFileCertificate, IconFile, IconTime } from "./components/primitives/Icon";

export const SHIPMENT_SECTIONS = [
  { id: "shp-conditions", suffix: "conditions", pageKey: "shipment-conditions", icon: IconFileCertificate, label: "Conditions" },
  { id: "shp-parties",    suffix: "parties",    pageKey: "shipment-parties",    icon: IconGroup, label: "Parties & Offices" },
  { id: "shp-schedules",  suffix: "schedules",  pageKey: "shipment-schedules",  icon: "⚓", label: "Contracts & Schedules" },
  { id: "shp-cargo",      suffix: "containers", pageKey: "shipment-containers", icon: IconPackage, label: "Cargo" },
  { id: "shp-milestones", suffix: "milestones", pageKey: "shipment-milestones", icon: IconFlag,  label: "Milestones & Events" },
  { id: "shp-documents",  suffix: "documents",  pageKey: "shipment-documents",  icon: IconFile, label: "Documents" },
];

export const SHIPMENT_SECTIONS_AFTER_ACCOUNTING = [
  { id: "shp-history", suffix: "history", pageKey: "shipment-history", icon: IconTime, label: "History" },
];

const ALL_SHIPMENT_SECTIONS = [...SHIPMENT_SECTIONS, ...SHIPMENT_SECTIONS_AFTER_ACCOUNTING];

export const SHIPMENT_PROMOTED_ROUTES = Object.fromEntries(ALL_SHIPMENT_SECTIONS.map(s => [s.id, s.pageKey]));
export const SHIPMENT_SUBPAGES        = Object.fromEntries(ALL_SHIPMENT_SECTIONS.map(s => [s.suffix, s.pageKey]));
export const SHIPMENT_SUBPAGE_HASHES  = Object.fromEntries(ALL_SHIPMENT_SECTIONS.map(s => [s.pageKey, s.suffix]));
export const SHIPMENT_SUBPAGE_LABELS  = Object.fromEntries(ALL_SHIPMENT_SECTIONS.map(s => [s.pageKey, s.label]));
export const SHIPMENT_PAGE_KEYS       = ALL_SHIPMENT_SECTIONS.map(s => s.pageKey);

// Built from SHIPMENT_SUBPAGES's own keys rather than a hand-typed alternation, so a
// new entry above can't silently be forgotten here the way the old hardcoded regex could.
export const SHIPMENT_SUBPAGE_HASH_PATTERN = Object.keys(SHIPMENT_SUBPAGES).join("|");
