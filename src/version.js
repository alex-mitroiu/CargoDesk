// ─── CargoDesk — Version Registry ────────────────────────────────────────────
// Increment MAJOR.MINOR.PATCH manually before each release.
// Add an entry to CHANGELOG with a short summary of changes.

export const VERSION   = "0.10.0";
export const BUILD     = "2026-06-28";
export const CODENAME  = "Compass";

export const CHANGELOG = [
  {
    version: "0.10.0",
    date:    "2026-06-28",
    codename:"Compass",
    summary: "Space Configs: POL/POD required, auto trade-lane detection (EU-N › FE badges), linked-port conflict detection with coverage override stub. Commodities MDM: 294 Maersk codes, CommodityCombobox, mandatory field on shipments. Containers: commodity renamed to HS Code, gross weight, volume, DG/IMDG class (20 sub-classes with descriptions). Light/Dark theme: Apple HIG palette, instant toggle, persisted. Header: user dropdown, theme toggle, notification placeholder. Global toast system: success/error/warning/info, 5xx auto-toast. URL hash navigation: #shipments/SHP-ID deep links, browser back/forward. Shipment status audit trail: status_log table, automatic logging, timeline UI.",
  },
  {
    version: "0.9.0",
    date:    "2026-06-28",
    codename:"Anchor",
    summary: "Container freight fields (commodity, weight, volume, DG/IMDG). User Manual: DG Classes reference section. Footer + About page with interactive DB schema. Version registry.",
  },
  {
    version: "0.8.0",
    date:    "2026-06-28",
    summary: "Space Configs: POL/POD, auto trade-lane badges, conflict detection. Dashboard Archive page as sidebar child. 6-week TEU trend line chart alongside carrier bar chart. Sparklines + delta badges per allocation row.",
  },
  {
    version: "0.7.0",
    date:    "2026-06-28",
    summary: "Space Configs: trade lane, alert threshold slider, notes field. Dashboard Archive (expired configs, ↻ Renew flow). DashboardPage modularised into DashboardArchivePage.",
  },
  {
    version: "0.6.0",
    date:    "2026-06-27",
    summary: "Contract ID field. DatePicker 3-level navigation (Days→Months→Years), smart viewport flip. Central Contract button with tooltip placeholder.",
  },
  {
    version: "0.5.0",
    date:    "2026-06-27",
    summary: "MDM Vessels: 349 vessels from IMO registry, VesselField combobox. Modular refactor: monolithic cargodesk.jsx split into 27 source files.",
  },
  {
    version: "0.4.0",
    date:    "2026-06-27",
    summary: "Landing page with weather widget, fleet stats, upcoming departures. Space Config POL/POD required. Allocation consumption scoped per carrier.",
  },
  {
    version: "0.3.0",
    date:    "2026-06-27",
    summary: "Integration Board (Kanban): Ready / In Progress / Done / Released, drag-and-drop, priority & section filters. Dashboard TEU utilisation charts.",
  },
  {
    version: "0.2.0",
    date:    "2026-06-27",
    summary: "MDM: 8 modules, 14,269 ports seeded. Shipment detail with container management.",
  },
  {
    version: "0.1.0",
    date:    "2026-06-26",
    summary: "Initial build: shipments, containers, Express + SQLite backend, React 18 + Vite frontend, dark design system.",
  },
];

export const COPYRIGHT_YEAR  = "2026";
export const COPYRIGHT_OWNER = "CargoDesk";