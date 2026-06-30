// ─── CargoDesk — Version Registry ────────────────────────────────────────────
// Increment MAJOR.MINOR.PATCH manually before each release.
// Add an entry to CHANGELOG with a short summary of changes.

export const VERSION   = "0.15.0";
export const BUILD     = "2026-06-30";
export const CODENAME  = "Waypoint";

export const CHANGELOG = [
  {
    version:  "0.15.0",
    date:     "2026-06-30",
    codename: "Waypoint",
    summary:  "Space Configs — Linked Shipments: new action-menu item opens a read-only modal showing every shipment currently consuming that configuration's space, with a TEU progress bar and a per-row contract badge; shipments that matched via a linked-port equivalent on the carrier's contract leg show a linked badge. Config ID chip with copy-to-clipboard added to the History modal header for easier cross-referencing. Actions column header fix; setConflicts crash fix. Contract-aware TEU consumption: consumedPerAlloc and the Linked Shipments modal now filter by contractId / contractRef (not just carrier), and resolve linked-port equivalents via each contract leg's polLinkedAllowed / podLinkedAllowed flags — fixing cases where a shipment's port is a registered linked equivalent of the config's declared port but was previously excluded. Shared helpers buildLinkedPortIndex / matchedLegFor / allocationRouteMatch added to tokens.js. Dashboard — 0-TEU shipments excluded from all range calculations and displayed lists. Contract Consumption tab gains an Allocated vs Consumed TEU bar chart (utilisation per contract, green/amber/red) and a 6-week TEU trend line chart per contract number; Shipments in Period table gains drag-to-resize columns with localStorage persistence. Shipment Detail — ContainerTypePickerModal: clicking the Equipment Type field now opens a visual picker grouped by 20ft / 40ft, showing equipment code, label, description and TEU value per option. server.js — contracts list now batches leg fetching via a single IN query instead of N+1 lookups.",
  },
  {
    version:  "0.14.0",
    date:     "2026-06-29",
    codename: "Logbook",
    summary:  "Entity audit log: entity_events table tracks CREATED/UPDATED/DELETED events across allocations, carriers, and contracts; GET /api/entity-events/:type/:id bridges shipment_events for the shipment type so all history queries share a single endpoint. ActionMenu: cog (⚙) button replaces individual Edit/Delete buttons on Shipments, Carriers, and Contracts — opens a position:fixed dropdown with Edit, History, and Delete items. EntityHistoryModal renders a timestamped event timeline with field diffs and meta pills, reused across entities. Space Configurations promoted to a standalone sidebar page (Dashboard › Space Configurations) with per-allocation lifetime consumption bars, 6-week sparklines, mandatory contract linking via contract picker, and ActionMenu per row. Dashboard simplified to Overview + Contract Consumption tabs (read-only, no CRUD). Space config fixes: Effective From date picker blocks past dates on new allocations; conflict detection now distinguishes same-contract duplicates (hard block) from cross-contract overlaps on the same lane (amber warning, allowed).",
  },
  {
    version:  "0.13.0",
    date:     "2026-06-29",
    codename: "Manifest",
    summary:  "Shipper / Consignee / Principal: three mandatory party fields on every shipment form, backed by CustomerCombobox — typeahead suggestions plus a 🔍 full picker modal; stored as ID + denormalised name (6 new DB columns); parties section promoted to top of the create/edit modal. Requires Review status: new purple shipment status with matching badge variant and theme tokens. FCL badge: Type column added to shipments list showing a blue FCL badge on every row. CSV export: one-click ↓ Export CSV button on the shipments list producing one row per container (25 columns) as a browser download. Kanban ticket types: Feature / Bug / Improvement / Task / Chore selector with colour-coded badges; Task hidden on cards to keep them clean. Customers search filters: Country, City, Customer Code inputs plus a manual Search button added to the Customers MDM page and mirrored in the Select Customer picker modal for consistency. Countries View Locations fix: GET /api/countries/:iso2/locations endpoint was missing — added with search + pagination. Resizable columns: drag-to-resize handles on every data table throughout the app (Shipments, Dashboard, Shipment containers, all 10 MDM pages); widths persist to localStorage per table.",
  },
  {
    version:  "0.12.0",
    date:     "2026-06-29",
    codename: "Starboard",
    summary:  "Customers MDM: new module with full CRUD — company name, address (line 1/2, city, state, postal code, country ISO2), phone, fax, email, website, notes. Shipment list filters: search by ID/POL/POD/booking ref, filter by status and carrier with live clear button. Landing page KPI cards: Over Threshold and Configs Expiring added to Fleet Overview. Home page Requires Attention section: active allocations above their alert threshold shown with utilisation bar, route, and expiry, sorted worst-first. Kanban tickets linked to shipments: shipment_id FK, optional shipment selector in ticket modal, shipment chip on cards. Notification bell: live badge count for above-threshold allocations; clicking opens a dropdown listing up to 5 offending lanes (carrier, POL › POD, utilisation %) sorted worst-first, each entry navigates to the Dashboard. Countries MDM portCount fix: mapCountry now forwards port_count from LEFT JOIN.",
  },
  {
    version:  "0.11.0",
    date:     "2026-06-29",
    codename: "Meridian",
    summary:  "Shipment History Tracker: shipment_events table logs every field change, container add/remove/update automatically — rendered as a colour-coded vertical timeline on the detail page. Kanban drag-to-reorder within columns with live drop indicators and optimistic updates. Countries MDM: port count fixed via LEFT JOIN + startup country_code backfill. Trade Lanes: country count and assignment endpoints added. Port locations: last_synced_at column + delta-sync pattern in import script. Loading spinners (FullPageSpinner, PageSpinner, inline Spinner) across all MDM pages and form save buttons. URL hash includes shipment ID for deep links. Duplicate key and missing import fixes.",
  },
  {
    version:  "0.10.0",
    date:     "2026-06-28",
    codename: "Compass",
    summary:  "Space Configs: POL/POD required, auto trade-lane detection, linked-port conflict detection. Commodities MDM: 294 Maersk codes, CommodityCombobox, mandatory on shipments. Containers: HS Code + Cargo Description split, gross weight, volume, DG/IMDG class. Light/Dark theme. Global toast system. URL hash navigation. Status audit trail.",
  },
  {
    version:  "0.9.0",
    date:     "2026-06-28",
    codename: "Anchor",
    summary:  "Container freight fields (commodity, weight, volume, DG/IMDG). User Manual DG Classes reference. Footer + About page with interactive DB schema. Version registry.",
  },
  {
    version:  "0.8.0",
    date:     "2026-06-28",
    summary:  "Space Configs: POL/POD, auto trade-lane badges, conflict detection. Dashboard Archive page. 6-week TEU trend line chart. Sparklines + delta badges per allocation row.",
  },
  {
    version:  "0.7.0",
    date:     "2026-06-28",
    summary:  "Space Configs: trade lane, alert threshold, notes. Dashboard Archive + Renew flow.",
  },
  {
    version:  "0.6.0",
    date:     "2026-06-27",
    summary:  "Contract ID field. DatePicker 3-level navigation, smart viewport flip.",
  },
  {
    version:  "0.5.0",
    date:     "2026-06-27",
    summary:  "MDM Vessels: 349 vessels from IMO registry. Modular refactor into 27 source files.",
  },
  {
    version:  "0.4.0",
    date:     "2026-06-27",
    summary:  "Landing page with weather widget, fleet stats, upcoming departures.",
  },
  {
    version:  "0.3.0",
    date:     "2026-06-27",
    summary:  "Integration Board (Kanban): Ready / In Progress / Done / Released.",
  },
  {
    version:  "0.2.0",
    date:     "2026-06-27",
    summary:  "MDM: 8 modules, 14,269 ports seeded. Shipment detail with container management.",
  },
  {
    version:  "0.1.0",
    date:     "2026-06-26",
    summary:  "Initial build: shipments, containers, Express + SQLite backend, React 18 + Vite frontend, dark design system.",
  },
];

export const COPYRIGHT_YEAR  = "2026";
export const COPYRIGHT_OWNER = "CargoDesk";