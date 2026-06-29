# ⚓ CargoDesk

> Freight management application for tracking ocean shipments, carrier space utilisation, contracts, and maritime master data.

[![Version](https://img.shields.io/badge/version-0.13.0-blue)](.)
![Node](https://img.shields.io/badge/node-22.5%2B-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Features

- **Shipment Tracking** — Container-level cargo detail with commodity, gross weight, volume, IMDG dangerous goods classification, Shipper / Consignee / Principal party fields, and a Requires Review status stage. FCL badge shown on every row in the shipments list.
- **CSV Export** — One-click export of the shipments list as a CSV file (one row per container, 25 columns) directly from the browser.
- **Shipment History** — Full audit trail rendered as a colour-coded vertical timeline: every field change, status transition, and container add / remove / update is logged automatically in `shipment_events`.
- **Space Configurations** — TEU allocation per carrier and route with conflict detection, 6-week trend charts, utilisation sparklines, alert threshold badges, and a renewal archive for expired configs.
- **Requires Attention** — Home page section listing active allocations above their alert threshold, sorted worst-first with a utilisation bar, route, and expiry date.
- **Notification Bell** — Live badge count for above-threshold allocations; dropdown lists up to five offending lanes sorted worst-first and navigates to the Dashboard on click.
- **Carrier Contracts** — MDM module for rate contracts with carrier, route, validity dates, rate types, and IMDG dangerous-goods class filters. "All" toggle selects / deselects all DG classes in one click. Carrier Code field validates against the carrier registry with a typeahead combobox and an inline error for unrecognised codes.
- **Customers MDM** — Full CRUD for customers: company name, address (line 1/2, city, state, postal code, country), phone, fax, email, website, notes. Searchable by country, city, and customer code. `CustomerCombobox` typeahead used throughout the app for Shipper / Consignee / Principal.
- **Vessel Registry** — 349 IMO vessels searchable by name, IMO number, or asset type.
- **Port Directory** — 14,269 UN/LOCODE seaports with linked-port relationships, trade lane assignment, and delta-sync support (`last_synced_at`).
- **Integration Board** — Kanban (Ready / In Progress / Done / Released) with drag-to-reorder within columns, live drop indicators, and colour-coded ticket types (Feature / Bug / Improvement / Task / Chore). Tickets can be linked to a shipment.
- **Currency Converter** — Live FX rates widget on the home page (20 currencies via Frankfurter / ECB) with swap button and localStorage-persisted currency pair.
- **System Messages** — Post-a-notice widget on the home page for maintenance and deployment announcements with severity levels (Info / Warning / Critical) and active date ranges.
- **System Health** — Footer "System Health" button opens a modal that parallel-pings all internal API routes and external services (FX, weather), reporting latency or error per endpoint in under 7 seconds.
- **Resizable Columns** — Drag handles on every data table (Shipments, Dashboard, all 10 MDM pages); column widths persist to `localStorage` per table via `useResizableColumns`.
- **User Manual** — Built-in docs covering Incoterms® 2020 and IMDG dangerous goods classes.
- **Light / Dark Theme** — Apple-style light theme and CargoDesk dark theme, toggled on the fly.

---

## Tech Stack

| Layer    | Technology |
|----------|-----------|
| Frontend | React 18, Vite, custom design system (inline styles via design tokens) |
| Backend  | Node.js 22.5+, Express |
| Database | SQLite via `node:sqlite` (built-in, no ORM) |
| Charts   | Recharts |
| FX Rates | Frankfurter / ECB API (free, no key required) |
| Weather  | Open-Meteo API (free, no key required) |

---

## Getting Started

### Prerequisites

- Node.js 22.5 or later (required for built-in `node:sqlite`)

### Install

```bash
git clone https://github.com/alex-mitroiu/CargoDesk.git
cd CargoDesk
npm install
```

### Run

```bash
# Start the API server (port 3001) and Vite dev server (port 5173) together
npm run dev

# Seed master data — run once after the first server start
node import-mdm-data.js

# Seed sample contracts (optional)
node seed-contracts.js
```

Open [http://localhost:5173](http://localhost:5173)

### Notes

- `cargodesk.db` is created automatically on the first server start.
- Schema changes are applied via safe `ALTER TABLE` migrations at startup — no manual DB intervention needed.
- The database file is excluded from version control (see `.gitignore`).
- Run `import-mdm-data.js` and `seed-contracts.js` with the server already running so they write to the same `cargodesk.db` instance.
- The FX converter and weather widget use free public APIs — no API keys required.

---

## Project Structure

```
CargoDesk/
├── server.js                  # Express API + SQLite schema + migrations + all endpoints
├── import-mdm-data.js         # Seeds ports, carriers, vessels, regions, commodities
├── seed-contracts.js          # Seeds sample carrier contracts
├── vite.config.js
├── data/
│   ├── seaports.csv           # 14,269 UN/LOCODE records
│   ├── carriers.csv           # 68 carrier records
│   └── vessels.json           # 349 vessels (IMO registry)
└── src/
    ├── api.js                 # All fetch wrappers (api.shipments, api.ports, api.contracts…)
    ├── tokens.js              # Design tokens, theme system, IMDG_CLASSES, CONTAINER_TYPES
    ├── version.js             # VERSION, CODENAME, CHANGELOG
    ├── toast.js               # Pub-sub toast emitter
    ├── App.jsx                # Routing, navigation, top-level state, HealthModal
    ├── main.jsx
    ├── components/
    │   ├── primitives/
    │   │   ├── Badge.jsx
    │   │   ├── Btn.jsx
    │   │   ├── DatePicker.jsx
    │   │   ├── Form.jsx
    │   │   ├── Modal.jsx
    │   │   ├── Pagination.jsx
    │   │   ├── Spinner.jsx
    │   │   ├── ToastContainer.jsx
    │   │   └── useResizableColumns.jsx   # Drag-to-resize hook, widths → localStorage
    │   └── shared/
    │       ├── CommodityCombobox.jsx     # Typeahead with GradePill
    │       ├── CountryCombobox.jsx
    │       ├── CountryLocationsModal.jsx
    │       ├── CustomerCombobox.jsx      # Typeahead + full-picker modal for parties
    │       ├── IncotermsModal.jsx
    │       ├── PortCombobox.jsx          # position:fixed dropdown (escapes modal overflow)
    │       └── VesselCombobox.jsx        # {VesselCombobox, VesselField} named exports
    └── pages/
        ├── LandingPage.jsx              # Fleet KPIs, weather, FX converter, system messages, requires-attention
        ├── ShipmentsPage.jsx            # Shipment list + filters + CSV export + ShipmentForm
        ├── ShipmentDetailPage.jsx       # Detail view, ContainerForm, StatusTimeline, ShipmentTimeline, LinkVesselModal
        ├── DashboardPage.jsx            # Space configurations + PortField
        ├── DashboardArchivePage.jsx     # Expired allocations + renew flow
        ├── KanbanPage.jsx               # Ticket board with drag-to-reorder and ticket types
        ├── UserManualPage.jsx           # Incoterms® 2020 + IMDG reference
        ├── AboutPage.jsx                # DB schema, features, changelog
        └── mdm/
            ├── MdmCarriersPage.jsx
            ├── MdmCommoditiesPage.jsx   # 294 Maersk commodity codes
            ├── MdmContractsPage.jsx     # Carrier contracts with IMDG class filters
            ├── MdmCountriesPage.jsx     # Countries + port count + trade lane assignments
            ├── MdmCustomersPage.jsx     # Customer records with address + contact fields
            ├── MdmLinkedPortsPage.jsx
            ├── MdmPortLocationsPage.jsx # 14,269 UN/LOCODE ports
            ├── MdmRegionsPage.jsx
            ├── MdmTradeLanesPage.jsx    # Trade lanes + country assignments
            ├── MdmUNLocationCodesPage.jsx
            └── MdmVesselsPage.jsx       # 349 IMO vessels
```

---

## Database Schema

| Table | Purpose |
|---|---|
| `shipments` | Core shipment records with party fields (shipper, consignee, principal) |
| `containers` | Container-level cargo detail |
| `allocations` | Space configurations (TEU per carrier / route) |
| `carriers` | Carrier MDM |
| `vessels` | Vessel MDM (IMO registry) |
| `port_locations` | 14,269 UN/LOCODE ports (has `last_synced_at`) |
| `linked_ports` | Port equivalence pairs |
| `trade_lanes` | FIATA high-level trade lanes |
| `country_trade_lanes` | Country → lane assignments |
| `regions` | Region MDM |
| `countries` | ISO 3166-1 countries + `portCount` via LEFT JOIN |
| `tickets` | Kanban board cards (with `shipment_id` FK) |
| `status_log` | Shipment status transitions (legacy, kept for compatibility) |
| `shipment_events` | Full audit log: `FIELD_UPDATED`, `STATUS_CHANGED`, `CONTAINER_ADDED/REMOVED/UPDATED` |
| `commodities` | 294 Maersk freight commodity codes (Grades M/K/E/S/Q) |
| `customers` | Customer records with full address and contact details |
| `contracts` | Carrier rate contracts with IMDG class filters |
| `contract_legs` | Origin / destination port pairs per contract |
| `contract_rates` | Rate entries per contract |
| `system_messages` | Operational notices with severity and active date range |

See the built-in **About** page (ℹ in the sidebar) for the full interactive schema reference with column descriptions and migration history.

---

## Changelog

| Version | Codename | Summary |
|---------|----------|---------|
| 0.13.0 | Manifest | Shipper / Consignee / Principal party fields on shipments backed by CustomerCombobox typeahead + picker modal. Requires Review status stage. FCL badge in shipments list. One-click CSV export (25 columns). Kanban ticket types (Feature / Bug / Improvement / Task / Chore) with colour-coded badges. Customers MDM search filters (country, city, code). Countries → View Locations endpoint. Resizable columns with localStorage persistence across all data tables. |
| 0.12.0 | Starboard | Customers MDM with full CRUD. Shipment list filters (search, status, carrier). Landing page KPI cards (Over Threshold, Configs Expiring). Requires Attention section on home page. Kanban tickets linked to shipments. Notification bell for above-threshold allocations. Countries portCount fix via LEFT JOIN. |
| 0.11.0 | Meridian | Shipment History Tracker: every field change, status transition, and container operation logged in `shipment_events` and rendered as a colour-coded timeline. Kanban drag-to-reorder with live drop indicators. Countries port count fixed via startup backfill. Trade Lanes country count + assignment endpoints. Port locations `last_synced_at` column + delta-sync. Loading spinners across all MDM pages. URL hash deep links for shipments. |
| 0.10.0 | Compass | Commodities MDM (294 Maersk codes), CommodityCombobox, HS Code + Cargo Description fields, status audit trail, global toast system, URL hash navigation, light/dark theme, loading spinners, Link Vessel action. |
| 0.9.0 | Anchor | Container freight fields (commodity, weight, volume, DG/IMDG). User Manual DG Classes reference. Footer + About page with interactive DB schema. Version registry. |
| 0.8.0 | — | Space Configs: POL/POD required, auto trade-lane badges, conflict detection. Dashboard Archive. 6-week TEU trend charts. Sparklines + delta badges. |
| 0.7.0 | — | Space Configs: trade lane, alert threshold, notes. Dashboard Archive + Renew flow. |
| 0.6.0 | — | Contract ID field. DatePicker 3-level navigation with smart viewport flip. |
| 0.5.0 | — | MDM Vessels: 349 ships from IMO registry. Modular refactor into 27 source files. |
| 0.4.0 | — | Landing page with weather widget, fleet stats, upcoming departures. |
| 0.3.0 | — | Integration Board (Kanban): Ready / In Progress / Done / Released. |
| 0.2.0 | — | MDM: 8 modules, 14,269 ports seeded. Shipment detail with container management. |
| 0.1.0 | — | Initial build: shipments, containers, Express + SQLite backend, React 18 + Vite frontend, dark design system. |

---

© 2026 CargoDesk
