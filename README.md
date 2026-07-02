# ⚓ CargoDesk

> Freight management application for tracking ocean shipments, carrier space utilisation, contracts, and maritime master data.

[![Version](https://img.shields.io/badge/version-0.19.0-blue)](.)
![Node](https://img.shields.io/badge/node-22.5%2B-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Features

- **Shipment Messages** — Per-shipment threaded message panel opened via a ✉️ icon in the detail header (📩 with a red unread badge when there are unread messages). Right-side drawer stays on top with a semi-transparent backdrop. Messages display the author's avatar initial, full name, role, and timestamp. Sort between oldest-first and newest-first with smart auto-scroll. Compose area enforces a 15–500 character limit with a live counter and Ctrl+Enter posting shortcut. Delivered in real time via WebSocket; falls back to a 10-second poll if the socket is unavailable.
- **Shipment Tracking** — Container-level cargo detail with commodity, gross weight, volume, IMDG dangerous goods classification, Shipper / Consignee / Principal party fields, and a Requires Review status stage.
- **Shipment Detail** — FCL badge in the header alongside the status badge. ETD and ETA cards show the day-of-week and month in UTC (GMT). Click the shipment ID to copy it to clipboard.
- **Equipment Picker** — Clicking the Equipment Type field on a container opens a visual picker modal grouped by 20ft / 40ft, showing equipment code, label, description, and TEU value per option.
- **New-tab Workflow** — Clicking a shipment row or the Open action opens the shipment in a new browser tab; the tab title is set to the shipment ID. A `beforeunload` guard warns before closing a tab with unsaved container changes.
- **CSV Export** — One-click export of the shipments list as a CSV file (one row per container, 25 columns) directly from the browser.
- **Shipment History** — Full audit trail rendered as a colour-coded vertical timeline: every field change (including contract reference), status transition, and container add / remove / update is logged automatically in `shipment_events`.
- **Space Configurations** — TEU allocation per carrier and route with mandatory contract linking, conflict detection, utilisation sparklines, alert threshold badges, and a renewal archive for expired configs. Each row's action menu includes: Edit, Linked Shipments, History, and Delete.
- **Linked Shipments** — Per-configuration read-only modal showing every shipment currently consuming that config's space, with a TEU progress bar, contract badge, and status badge per row. Shipments that matched via a registered linked-port equivalent show a **linked** badge. Matching is contract-aware: consumption is scoped to the exact contract and resolves linked-port equivalents via the contract leg's `polLinkedAllowed` / `podLinkedAllowed` flags.
- **Config ID Chip** — Every space configuration's History modal shows its unique ID (`ALC-XXXXXX`) with a copy-to-clipboard button for easy cross-referencing.
- **Contract Consumption** — Dashboard tab showing Central shipments grouped by contract, with an Allocated vs Consumed TEU bar chart (green < 80%, amber 80–99%, red >= 100%) and a 6-week TEU trend line chart per contract number.
- **Contract Badges** — SPOT / Pending / Customer Own display as solid orange badges; Central displays as a solid blue badge — both theme-independent.
- **Requires Attention** — Landing page section with two tabs: Space Configs (active allocations above alert threshold, sorted worst-first) and Shipment Review (shipments with status Requires Review). Each row has an ↗ open-in-new-tab button.
- **Notification Bell** — Live badge count combining above-threshold allocations and active system messages. Bell dropdown shows active system messages in a dedicated section above the threshold alerts.
- **System Messages** — Post operational notices with severity (Info / Warning / Critical) and minute-precision active date/time ranges (`datetime-local` inputs). Active messages appear in the notification bell dropdown.
- **Carrier Contracts** — MDM module for rate contracts with carrier, route legs, validity dates, rate types, and IMDG class filters. Each leg declares `polLinkedAllowed` / `podLinkedAllowed` to control whether linked-port equivalents are acceptable.
- **Customers MDM** — Full CRUD for customers: company name, address, phone, fax, email, website, notes. Searchable by country, city, and customer code. `CustomerCombobox` typeahead used for Shipper / Consignee / Principal.
- **Vessel Registry** — 349 IMO vessels searchable by name, IMO number, or asset type.
- **Port Directory** — 14,269 UN/LOCODE seaports with linked-port relationships, trade lane assignment, and delta-sync support (`last_synced_at`).
- **Operational Accounting** — Per-shipment BUY and SELL cost lines with charge codes, multi-currency amounts with auto-filled FX rates, and per-container assignment. Each line shows its source (Contract / Contract (Modified) / Manual) and tracks changes in a dedicated Cost Line History modal (CREATED / IMPORTED / UPDATED / DELETED events with filter chips and CSV export). The Add/Edit form includes a ⇄ Mirror as BUY/SELL button that saves the current line and instantly creates a mirrored copy with the type flipped.
- **Shipment Milestones** — Per-shipment milestone workflow backed by configurable templates. A default 9-step FCL sequence (Booking Confirmed → SI Submitted → Cargo Gated In → Vessel Departed → B/L Issued → Vessel Arrived → Customs Cleared → Cargo Released → Delivered) is seeded on startup. Each shipment's milestone panel shows a vertical stepper with per-step states (completed / current / overdue / upcoming), a progress bar, inline estimated-date and note editing, and mark-complete / undo actions. Overdue milestone count is surfaced as a badge on shipment rows and as a Fleet Overview KPI on the Landing Page.
- **Integration Board** — Kanban with six columns (Ready / In Progress / Done / In Testing / Testing Failed / Released), drag-to-reorder within columns, live drop indicators, colour-coded ticket types, shipment linking, and version tags. Each column collapses to the first 5 tickets with a ▾▾ Show More control. The Released column can be toggled on/off from the toolbar.
- **Entity Audit Log** — `entity_events` table tracks every CREATED / UPDATED / DELETED event across allocations, carriers, and contracts. `EntityHistoryModal` renders a timestamped field-diff timeline, accessible via the History action on any row.
- **Currency Converter** — Live FX rates widget on the home page (20 currencies via Frankfurter / ECB) with swap button and localStorage-persisted currency pair.
- **Landing Page** — Fleet KPIs, weather widget, currency converter, calendar week badge on the clock card, system messages, and the Requires Attention section.
- **Breadcrumb Navigation** — Detail pages show a full path (CargoDesk › Shipments › {ID} › Details) with clickable segments. Home icon in the header for one-click return to the landing page.
- **Resizable Columns** — Drag handles on every data table; column widths persist to `localStorage` per table via `useResizableColumns`.
- **Light / Dark Theme** — Apple-style light theme and CargoDesk dark theme, toggled on the fly.
- **User Manual** — Built-in docs covering Incoterms 2020 and IMDG dangerous goods classes.
- **System Health** — Footer button opens a modal that parallel-pings all internal API routes and external services, reporting latency or error per endpoint.
- **Authentication** — JWT-based login with `bcryptjs` password hashing. Token stored in `localStorage`; all API routes protected by `auth()` middleware. A default admin account (`admin@cargodesk.com` / `admin123`) is seeded on first startup when no users exist.
- **User Management** — Admin-only Users tab in Application Settings: create, edit, deactivate, and delete user accounts. Role-coded badges (admin / operator / viewer). Passwords hashed, never exposed.
- **RBAC — Three Roles** — admin (full access + user management), operator (full access, no user admin), viewer (read-only everywhere). All write actions (create, edit, delete, drag-to-reorder on Kanban) are hidden for viewers. A "👁 View Only" banner appears on the shipment detail page. Admins can impersonate lower roles via the nav role-switcher.

---

## Tech Stack

| Layer      | Technology |
|------------|-----------|
| Frontend   | React 18, Vite, custom design system (inline styles via design tokens) |
| Backend    | Node.js 22.5+, Express |
| Database   | SQLite via `node:sqlite` (built-in, no ORM) |
| Real-time  | WebSocket via `ws` package (shared HTTP server, `/ws` path) |
| Charts     | Recharts |
| FX Rates   | Frankfurter / ECB API (free, no key required) |
| Weather    | Open-Meteo API (free, no key required) |

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
# Start the API + WebSocket server (port 3001) and Vite dev server (port 5173) together
npm run dev

# Seed master data -- run once after the first server start
npm run seed

# Seed sample contracts (optional)
npm run seed:contracts
```

Open [http://localhost:5173](http://localhost:5173)

### Default Login

On first startup, if no users exist, the server seeds a default admin account:

| Field | Value |
|-------|-------|
| Email | `admin@cargodesk.com` |
| Password | `admin123` |

> **Change the password immediately** in Application Settings → Users after your first login.

### Notes

- `cargodesk.db` is created automatically on the first server start.
- Schema changes are applied via safe `ALTER TABLE` migrations at startup — no manual DB intervention needed.
- The database file is excluded from version control (see `.gitignore`).
- Run `npm run seed` and `npm run seed:contracts` with the server already running so they write to the same `cargodesk.db` instance.
- The FX converter and weather widget use free public APIs — no API keys required.
- The WebSocket server shares port 3001 with the Express API (`/ws` path). The Vite dev server proxies WebSocket connections automatically.

---

## Project Structure

```
CargoDesk/
├── server.js                  # Express API + WebSocket server + SQLite schema + migrations + all endpoints
├── vite.config.js             # Vite config with /api and /ws proxy rules
├── scripts/
│   ├── import-mdm-data.js     # Seeds ports, carriers, vessels, regions, commodities (npm run seed)
│   ├── seed-contracts.js      # Seeds sample carrier contracts (npm run seed:contracts)
│   └── checkdb.js             # Dev utility — inspects DB schema and row counts (npm run checkdb)
├── data/
│   ├── seaports.csv           # 14,269 UN/LOCODE records
│   ├── carriers.csv           # 68 carrier records
│   └── vessels.json           # 349 vessels (IMO registry)
├── sampleDB/
│   └── cargodesk.db           # Pre-loaded sample database — copy to project root to use
└── src/
    ├── api.js                 # All fetch wrappers (api.shipments, api.costLines, api.milestones...)
    ├── tokens.js              # Design tokens, theme system, route-matching helpers
    ├── version.js             # VERSION, CODENAME, CHANGELOG
    ├── dev/
    │   ├── CargoDesk.postman_collection.json   # All API routes in 18 resource folders
    │   └── CargoDesk.postman_environment.json  # {{baseUrl}} = http://localhost:3001
    ├── toast.js               # Pub-sub toast emitter
    ├── App.jsx                # Routing, navigation, top-level state, auth guards, role switcher
    ├── AuthContext.jsx        # createContext + useAuth hook — user, activeRole, canEdit, isAdmin, isViewer
    ├── main.jsx
    ├── components/
    │   ├── primitives/
    │   │   ├── ActionMenu.jsx
    │   │   ├── Badge.jsx
    │   │   ├── Btn.jsx
    │   │   ├── DatePicker.jsx
    │   │   ├── Form.jsx
    │   │   ├── Modal.jsx
    │   │   ├── Pagination.jsx
    │   │   ├── Spinner.jsx
    │   │   ├── ToastContainer.jsx
    │   │   └── useResizableColumns.jsx   # Drag-to-resize hook, widths -> localStorage
    │   └── shared/
    │       ├── CommodityCombobox.jsx     # Typeahead with GradePill + CommodityPickerModal
    │       ├── CountryCombobox.jsx
    │       ├── CountryLocationsModal.jsx
    │       ├── CustomerCombobox.jsx      # Typeahead + full-picker modal for parties
    │       ├── EntityHistoryModal.jsx    # Generic audit-log timeline viewer
    │       ├── IncotermsModal.jsx
    │       ├── PortCombobox.jsx          # position:fixed dropdown (escapes modal overflow)
    │       ├── UserManagementPanel.jsx   # Admin-only user CRUD (name, email, role, status, last login)
    │       └── VesselCombobox.jsx        # {VesselCombobox, VesselField} named exports
    └── pages/
        ├── LoginPage.jsx                # Centered login form; calls api.auth.login → onLogin(token, user)
        ├── LandingPage.jsx              # Fleet KPIs, weather, FX, calendar week, system messages, requires-attention tabs
        ├── ShipmentsPage.jsx            # Shipment list + filters + CSV export + ShipmentForm (opens in new tab)
        ├── ShipmentDetailPage.jsx       # Detail view, MessagesDrawer (WebSocket), ContainerForm, ShipmentTimeline
        ├── DashboardPage.jsx            # Overview + Contract Consumption tabs, AllocationForm
        ├── SpaceConfigurationsPage.jsx  # Standalone Space Configs page with Linked Shipments modal
        ├── DashboardArchivePage.jsx     # Expired allocations + renew flow
        ├── KanbanPage.jsx               # Ticket board with drag-to-reorder, ticket types, and version tags
        ├── AppSettingsPage.jsx          # API Controls + Finance + Users (admin only) tabs
        ├── UserManualPage.jsx           # Incoterms 2020 + IMDG reference
        ├── AboutPage.jsx                # DB schema, features, changelog
        └── mdm/
            ├── MdmCarriersPage.jsx
            ├── MdmCommoditiesPage.jsx   # 294 Maersk commodity codes
            ├── MdmContractsPage.jsx     # Carrier contracts with legs and IMDG class filters
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
| `allocations` | Space configurations (TEU per carrier / route / contract) |
| `carriers` | Carrier MDM |
| `vessels` | Vessel MDM (IMO registry) |
| `port_locations` | 14,269 UN/LOCODE ports (has `last_synced_at`) |
| `linked_ports` | Port equivalence pairs — used for conflict detection and route matching |
| `trade_lanes` | FIATA high-level trade lanes |
| `country_trade_lanes` | Country -> lane assignments |
| `regions` | Region MDM |
| `countries` | ISO 3166-1 countries + `portCount` via LEFT JOIN |
| `tickets` | Kanban board cards (with `shipment_id` FK and `version` tag) |
| `status_log` | Shipment status transitions (legacy, kept for compatibility) |
| `shipment_events` | Full audit log: `FIELD_UPDATED`, `STATUS_CHANGED`, `CONTAINER_ADDED/REMOVED/UPDATED` |
| `shipment_messages` | Per-shipment threaded messages with author, role, and timestamp |
| `entity_events` | Generic audit log for allocations, carriers, and contracts |
| `commodities` | 294 Maersk freight commodity codes (Grades M/K/E/S/Q) |
| `customers` | Customer records with full address and contact details |
| `contracts` | Carrier rate contracts with IMDG class filters and validity window |
| `contract_legs` | Origin / destination port pairs per contract with linked-port allowance flags |
| `contract_rates` | Rate entries per contract |
| `system_messages` | Operational notices with severity and minute-precision active date/time range |
| `shipment_cost_lines` | BUY and SELL cost lines per shipment with source tracking (`source`, `modified_at`) |
| `shipment_milestones` | Per-shipment milestone steps with estimated date, completion timestamp, and note |
| `milestone_templates` | Reusable milestone step definitions grouped by template key, carrier, and trade lane |
| `users` | Authenticated users: email, name, `password_hash`, role (admin/operator/viewer), `is_active`, `last_login` |

See the built-in **About** page (i in the sidebar) for the full interactive schema reference with column descriptions and migration history.

---

## Changelog

| Version | Codename | Summary |
|---------|----------|---------|
| 0.19.0 | Muster | Authentication: JWT login, `bcryptjs` password hashing, `auth()` Express middleware, default admin seeded on first startup (`admin@cargodesk.com` / `admin123`). User Management: full CRUD in AppSettings → Users tab (admin only), role-coded badges, `is_active` flag. RBAC: three roles (admin / operator / viewer); viewer read-only enforced across every page and MDM module — all write buttons hidden, Kanban drag disabled, "👁 View Only" banner on shipment detail. Admin role-switcher in nav. ActionMenu returns `null` when empty (prevents orphan ⚙ buttons). |
| 0.18.1 | Traverse | Hotfix: License & EULA page (non-commercial use terms, donation section); first-visit acceptance modal. File structure cleanup: seed scripts moved to `scripts/`; `npm run seed` / `seed:contracts` / `checkdb` shortcuts added. `sampleDB/` with pre-loaded database for quick onboarding. Commodity picker grade column overflow fix. Shipments table double-click to open. ContractField disabled state names the missing field. |
| 0.18.0 | Traverse | Operational Accounting: source tracking (Contract / Contract (Modified) / Manual pills), Cost Line History modal with CREATED/IMPORTED/UPDATED/DELETED audit log + CSV export, ⇄ Mirror as BUY/SELL in the Add/Edit modal, Container column, import container-type filtering, manual line preservation on recalculate, renamed from Cost Control. Shipment Milestones: new `milestone_templates` + `shipment_milestones` tables, default 9-step FCL template seeded on startup, `MilestonePanel` vertical stepper with progress bar, per-step states, inline editing, collapse toggle, overdue badge on shipment rows, Overdue Milestones KPI on Landing Page. Integration Board: In Testing + Testing Failed columns, per-column Show More (▾▾/▴▴), Show/Hide Released toggle. REST API: cost-line routes nested under shipments; Postman collection added in `/src/dev/`. |
| 0.17.1 | Sentry | Hotfix: FX Rates health check was fetching `frankfurter.app` directly from the browser, triggering a CORS block (HTTP 301, no `Access-Control-Allow-Origin` header). Routed through the existing `/api/fx/rates` backend endpoint instead. |
| 0.17.0 | Sentry | Application Settings page (⚙ nav item above footer): API Controls tab with External APIs subtab (FX Rates, Weather, OFAC SDN — toggle, recurrence, latency test, CSV import, direct sync) and Internal APIs subtab (WebSocket, Shipments, Contracts, Customers, Carriers, Vessels, Ports, System Messages — toggle + latency test). Toggles gate sidebar nav items; disabled modules show a 🔒 Module Disabled fallback. User Manual and About moved to the avatar dropdown. Sanctions & Denied Party Screening: shipments are screened silently on every create/edit when the SDN index is loaded; skips re-screen on OVERRIDE or non-party edits; warning toast names each flagged party. Compliance badge simplified to "⚠ Compliance review required" with a per-party hover tooltip. OFAC auto-sync: redirect following (up to 5 hops), `setTimeout` overflow fixed (capped at ~23 days), failed syncs retry after 1 h. CSV file-upload path added via Vite large-body passthrough plugin. Five SDN test customers seeded. Header badge font size increased 15% (10.5 → 12 px); `Badge` gains a `size` prop. |
| 0.16.0 | Courier | Shipment Messages: per-shipment threaded panel with ✉️/📩 header icon, unread badge, author/role/timestamp display, sort toggle, 15–500 char compose area, and Ctrl+Enter posting. Real-time delivery via WebSocket (`ws`) with 10-second poll fallback. Shipment Detail: FCL badge, GTM day/month on ETD and ETA cards, click-to-copy shipment ID. Contract badges redesigned: SPOT/Pending/Customer Own → solid orange; Central Contract renamed to Central → solid blue; full rename across DB, server, and UI. Shipments list: stacked carrier (code/name) and contract (badge/ref) columns. System messages upgraded to `datetime-local` inputs; active messages shown in bell dropdown. Requires Attention split into Space Configs and Shipment Review tabs. New-tab workflow for shipments with document.title and beforeunload dirty guard. Breadcrumb updated to full path with clickable segments. Home icon added to header. Calendar week badge on Landing Page clock card. Kanban version tags: tickets gain a version field with a purple badge on the card. Bug fix: `contract_ref` was missing from `TRACKED_FIELDS` so editing it logged no history event. |
| 0.15.0 | Waypoint | Linked Shipments action on Space Config rows: read-only modal with TEU bar, contract badge, and a linked badge when a port-link equivalent resolved the match. Contract-aware TEU consumption scoped to exact contract with linked-port resolution via contract leg flags. Config ID chip with copy-to-clipboard in History modal. Dashboard: 0-TEU exclusion, Contract Consumption adds Allocated vs Consumed TEU chart and 6-week trend per contract, Shipments in Period gets resizable columns. ContainerTypePickerModal: visual equipment picker grouped by 20ft/40ft. Contracts list N+1 query fixed. |
| 0.14.0 | Logbook | Entity audit log (`entity_events`) tracks CREATED/UPDATED/DELETED across allocations, carriers, and contracts. ActionMenu cog button replaces Edit/Delete on Shipments, Carriers, and Contracts. `EntityHistoryModal` renders a timestamped field-diff timeline reused across entities. Space Configurations promoted to a standalone sidebar page with lifetime consumption bars, 6-week sparklines, mandatory contract linking, and ActionMenu per row. Dashboard simplified to Overview + Contract Consumption read-only tabs. |
| 0.13.0 | Manifest | Shipper / Consignee / Principal party fields on shipments backed by CustomerCombobox typeahead + picker modal. Requires Review status stage. FCL badge in shipments list. One-click CSV export (25 columns). Kanban ticket types with colour-coded badges. Customers MDM search filters. Resizable columns with localStorage persistence across all data tables. |
| 0.12.0 | Starboard | Customers MDM with full CRUD. Shipment list filters. Landing page KPI cards. Requires Attention section. Kanban tickets linked to shipments. Notification bell for above-threshold allocations. |
| 0.11.0 | Meridian | Shipment History Tracker in `shipment_events`. Kanban drag-to-reorder. Countries port count fixed. Trade Lanes country assignment. Port locations delta-sync. Loading spinners. URL hash deep links. |
| 0.10.0 | Compass | Commodities MDM, CommodityCombobox, HS Code + Cargo Description fields, status audit trail, global toast system, light/dark theme. |
| 0.9.0 | Anchor | Container freight fields. User Manual. About page with interactive DB schema. Version registry. |
| 0.8.0 | — | Space Configs: conflict detection, Dashboard Archive, 6-week TEU trend charts, sparklines. |
| 0.7.0 | — | Space Configs: trade lane, alert threshold, notes. Dashboard Archive + Renew flow. |
| 0.6.0 | — | Contract ID field. DatePicker 3-level navigation. |
| 0.5.0 | — | MDM Vessels: 349 ships from IMO registry. Modular refactor into 27 source files. |
| 0.4.0 | — | Landing page with weather widget, fleet stats, upcoming departures. |
| 0.3.0 | — | Integration Board (Kanban): Ready / In Progress / Done / Released. |
| 0.2.0 | — | MDM: 8 modules, 14,269 ports seeded. Shipment detail with container management. |
| 0.1.0 | — | Initial build: shipments, containers, Express + SQLite backend, React 18 + Vite frontend, dark design system. |

---

(c) 2026 CargoDesk
