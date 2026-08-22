# ⚓ CargoDesk

> Freight management application for tracking ocean shipments, carrier space utilisation, contracts, and maritime master data.

[![CI](https://github.com/alex-mitroiu/CargoDesk/actions/workflows/ci.yml/badge.svg)](https://github.com/alex-mitroiu/CargoDesk/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.70.0-blue)](.)
![Node](https://img.shields.io/badge/node-22.5%2B-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## Features

- **Shipment Tracking** — Container-level cargo detail with commodity, gross weight, volume, IMDG dangerous goods classification, Shipper / Consignee / Principal party fields, and a Requires Review status stage.
- **Shipment Detail** — FCL badge in the header alongside the status badge. ETD and ETA cards show the day-of-week and month in UTC (GMT). Click the shipment ID to copy it to clipboard. Trade lane badge in the subtitle.
- **Shipment Messages** — Per-shipment threaded message panel opened via a ✉️ icon in the detail header (📩 with a red unread badge when there are unread messages). Right-side drawer stays on top with a semi-transparent backdrop. Messages display the author's avatar initial, full name, role, and timestamp. Sort between oldest-first and newest-first with smart auto-scroll. Compose area enforces a 15–500 character limit with a live counter and Ctrl+Enter posting shortcut. Delivered in real time via WebSocket; falls back to a 10-second poll if the socket is unavailable.
- **Equipment Picker** — Clicking the Equipment Type field on a container opens a visual picker modal grouped by 20ft / 40ft, showing equipment code, label, description, and TEU value per option.
- **New-tab Workflow** — Clicking a shipment row or the Open action opens the shipment in a new browser tab; the tab title is set to the shipment ID. A `beforeunload` guard warns before closing a tab with unsaved container changes.
- **Quick Container Setup** — Containers section in the new-shipment form lets operators configure count, equipment type (visual picker), weight, volume, DG flag, and cargo description before saving. Draft containers are created sequentially after the shipment is saved. A Central Contract requires at least one container to be queued first.
- **Shipment History** — Full audit trail rendered as a colour-coded vertical timeline: every field change (including contract reference), status transition, and container add / remove / update is logged automatically in `shipment_events`.
- **Multimodal Legs** — 14-column leg table (Leg Type, Movement Type, From, Loc. Type, ETD, To, Loc. Type, ETA, Carrier, Movement By, Vessel, Voyage, Ctr. Type, Contract No.) covering Pick-up, SEA, Feeder, Rail, Air, and Delivery movements. SEA leg carrier and movement fields are auto-derived; Carrier's Haulage legs unlock Vessel/Voyage; new row-selection pattern with a Remove Leg footer button. Route summary banners in both the shipment form and detail page use a dynamic grid that adds Pick-up / Delivery door cells (dashed border) when Carrier's Haulage legs are present — seaport UNLOCODEs are shown as Port of Loading/Discharge rather than door locations.
- **Routing Term Engine** — `syncShipmentFromLegs` computes a routing term (e.g. DR-CY, PT-PT) from the carrier-covered subset of legs (excluding Merchant's Haulage and Customer Arranged). Stored on `shipments.routing_term`; surfaced as a chip in the leg-table footer and the routing banner.
- **Space Configurations** — TEU allocation per carrier and route with mandatory contract linking, conflict detection, utilisation sparklines, alert threshold badges, and a renewal archive for expired configs. Each row's action menu includes: Edit, Linked Shipments, History, and Delete.
- **Linked Shipments** — Per-configuration read-only modal showing every shipment currently consuming that config's space, with a TEU progress bar, contract badge, and status badge per row. Shipments that matched via a registered linked-port equivalent show a **linked** badge. Matching is contract-aware: consumption is scoped to the exact contract and resolves linked-port equivalents via the contract leg's `polLinkedAllowed` / `podLinkedAllowed` flags.
- **Config ID Chip** — Every space configuration's History modal shows its unique ID (`ALC-XXXXXX`) with a copy-to-clipboard button for easy cross-referencing.
- **Contract Consumption** — Dashboard tab showing Central shipments grouped by contract, with an Allocated vs Consumed TEU bar chart (green < 80%, amber 80–99%, red >= 100%) and a 6-week TEU trend line chart per contract number.
- **Contract Badges** — SPOT / Pending / Customer Own display as solid orange badges; Central displays as a solid blue badge — both theme-independent.
- **Requires Attention** — Landing page section with two tabs: Space Configs (active allocations above alert threshold, sorted worst-first) and Shipment Review (shipments with status Requires Review). Each row has an ↗ open-in-new-tab button.
- **Notification Bell** — Live badge count combining above-threshold allocations and active system messages. Bell dropdown shows active system messages in a dedicated section above the threshold alerts.
- **System Messages** — Post operational notices with severity (Info / Warning / Critical) and minute-precision active date/time ranges (`datetime-local` inputs). Active messages appear in the notification bell dropdown.
- **Carrier Contracts** — MDM module for rate contracts with carrier, route legs (including POL/POD location type: Terminal / Door / CY / CFS), validity dates, rate types, and IMDG class filters. Each leg declares `polLinkedAllowed` / `podLinkedAllowed` to control whether linked-port equivalents are acceptable.
- **Contract Matching** — `GET /api/contracts/match` resolves eligible contracts from seaport POL/POD, CRD, routing term, and pick-up / delivery locations. Inclusive carrier haulage logic: contracts that support haulage are shown for non-haulage shipments and excluded only when the shipment needs haulage but the contract does not.
- **Customers MDM** — Full CRUD for customers: company name, address, phone, fax, email, website, notes. Searchable by country, city, and customer code. `CustomerCombobox` typeahead used for Shipper / Consignee / Principal.
- **Vessel Registry** — 349 IMO vessels searchable by name, IMO number, or asset type.
- **Port Directory** — 14,269 UN/LOCODE seaports with linked-port relationships, trade lane assignment, and delta-sync support (`last_synced_at`).
- **Operational Accounting** — Per-shipment BUY and SELL cost lines with charge codes, multi-currency amounts with auto-filled FX rates, and per-container assignment. Each line shows its source (Contract / Contract (Modified) / Manual) and tracks changes in a dedicated Cost Line History modal (CREATED / IMPORTED / UPDATED / DELETED events with filter chips and CSV export). The Add/Edit form includes a ⇄ Mirror as BUY/SELL button that saves the current line and instantly creates a mirrored copy with the type flipped.
- **Margin Overview** — Dashboard tab showing total Buy / Sell / Gross Profit / Gross Margin KPIs, a 6-week trend table, and carrier + trade lane breakdowns. All figures calculated server-side in USD using per-line FX rates.
- **CSV Export** — One-click `⬇ CSV` button on the Shipments page header. Generated server-side (auth-aware): 34 columns including port names, container counts, TEU, and buy/sell/margin totals per shipment. Respects viewer scope restrictions.
- **XLSX Dashboard Export (programmatic)** — `⬇ XLSX (programmatic)` button on the Margin Overview tab. Generates a 4-sheet ExcelJS workbook: Summary (KPI block + 6-week trend table), By Carrier, By Lane, and Shipment Detail with autofilter and frozen header. Includes brand palette, alternating row fill, and formula-based totals. No charts — ExcelJS chart API is unreliable; use the template approach for chart-enabled exports.
- **XLSX Dashboard Export (template)** — `⬇ XLSX (template)` button on the Margin Overview tab. Loads a pre-committed base template (`exports/dashboard-template.xlsx`), overwrites data ranges, and serves the result. Add charts to the template in Excel once and they auto-update on every export. Regenerate the base template with `npm run export:template`.
- **Shipment Milestones** — Per-shipment milestone workflow backed by configurable templates. A default 9-step FCL sequence (Booking Confirmed → SI Submitted → Cargo Gated In → Vessel Departed → B/L Issued → Vessel Arrived → Customs Cleared → Cargo Released → Delivered) is seeded on startup. Each shipment's milestone panel shows a vertical stepper with per-step states (completed / current / overdue / upcoming), a progress bar, inline estimated-date and note editing, and mark-complete / undo actions. Overdue milestone count is surfaced as a badge on shipment rows and as a Fleet Overview KPI on the Landing Page.
- **Integration Board** — Kanban with six columns (Ready / In Progress / Done / In Testing / Testing Failed / Released), drag-to-reorder within columns, live drop indicators, colour-coded ticket types, shipment linking, and version tags. Each column collapses to the first 5 tickets with a ▾▾ Show More control. The Released column can be toggled on/off from the toolbar. Ticket nesting: Epic → Story → sub-task with progress ring on Epic cards and a breadcrumb chip on child cards. Assignee avatar chips and overdue date badges on cards.
- **Entity Audit Log** — `entity_events` table tracks every CREATED / UPDATED / DELETED event across allocations, carriers, and contracts. `EntityHistoryModal` renders a timestamped field-diff timeline, accessible via the History action on any row.
- **Currency Converter** — Live FX rates widget on the home page (20 currencies via Frankfurter / ECB) with swap button and localStorage-persisted currency pair.
- **Landing Page** — Fleet KPIs, weather widget, currency converter, calendar week badge on the clock card, system messages, and the Requires Attention section.
- **Breadcrumb Navigation** — Detail pages show a full path (CargoDesk › Shipments › {ID} › Details) with clickable segments. Home icon in the header for one-click return to the landing page.
- **Resizable Columns** — Drag handles on every data table; column widths persist to `localStorage` per table via `useResizableColumns`.
- **Light / Dark Theme** — Apple-style light theme and CargoDesk dark theme, toggled on the fly.
- **User Manual** — Built-in docs covering Incoterms 2020 and IMDG dangerous goods classes.
- **System Health** — Footer button opens a modal that parallel-pings all internal API routes and external services, reporting latency or error per endpoint.
- **Declared Value** — `declared_value` + `declared_value_currency` on shipments — number input with 10-currency select on the form, display in shipment detail, and a declared value row in all five document builders (B/L, Commercial Invoice, Freight Invoice, Customs Declaration, Insurance Certificate).
- **Epic Coverage Modal** — Full-screen Kanban coverage analysis for Epics: phase cards built from Story children, item rows, progress bar, and a verdict block. Opened via a 📊 button on Epic cards and the preview panel.
- **Document Readiness Overview** — Top section of DocumentsModal shows a coverage bar and 11 doc-type rows (confirmed / draft / missing per type, priority-ordered).
- **Compliance Screening** — ComplianceModal Phase 1 (Parties) and Phase 2 (Routing) cards each show a roll-up status pill and per-check rows with field value, description, and status icon.
- **Shipment Schedule Bookings** — Operators can search live (or demo) sailings directly from the create/edit shipment form. The Sailing section shows a 2/4/8/12-week search window picker; selecting a sailing attaches it to the shipment in the `shipment_schedules` table. A shortcut button copies the vessel name, voyage number, and ETD into the matching SEA leg with one click. The Schedules panel in the shipment detail view lists all saved sailings with vessel, service, voyage, ETD/ETA, transit days, and saved-by metadata; additional sailings can be added or removed from there too. A mock-data banner is shown when no Maersk API key is configured.
- **Related Tickets Panel** — Shipment detail page shows a Related Tickets panel listing all Kanban tickets linked to the shipment (status dot, ticket ID, title, assignee, priority). Tickets are filtered server-side via `GET /api/tickets?shipmentId=X`.
- **Sailing Management** — Active sailing highlighted in green in the sailing picker (voyageNumber or vesselName+ETD match); replacing an existing sailing requires confirmation via a proper modal overlay. Negative transit days (inconsistent ETD/ETA) surface an `⚠ dates` amber badge. TSP multi-leg sailings splice draft SEA legs for each voyage segment. Refresh button (↻) in the shipment detail header re-fetches the latest data on demand.
- **Command Center** — Full-screen operational dashboard with live shipment KPI cards, status donut, monthly booking trend bars, expiring space config list, carrier TEU consumption ranking, top routes by volume, and an Integration Board ticket card (overdue and due-this-week tabs with priority dot, days-late counter, and assignee avatar). KPI cards filter the in-page shipments list rather than navigating away; active filter shows a count header with a ✕ clear. Shipment preview routing bar renders the full journey (Door / CY → POL → POD → Terminal / Door) parsed from `routingTerm`. Layout uses `position: fixed` for dynamic sizing at any viewport resolution — no page scroll at 1080p, 4K, or anywhere between.
- **Authentication** — JWT-based login with `bcryptjs` password hashing. Token stored in `localStorage`; all API routes protected by `auth()` middleware. A default admin account (`admin@cargodesk.com` / `admin123`) is seeded on first startup when no users exist.
- **User Management** — Admin-only Users tab in Application Settings: create, edit, deactivate, and delete user accounts. Role-coded badges (admin / operator / viewer). Passwords hashed, never exposed.
- **RBAC — Three Roles** — admin (full access + user management), operator (full access, no user admin), viewer (read-only everywhere). All write actions (create, edit, delete, drag-to-reorder on Kanban) are hidden for viewers. A "👁 View Only" banner appears on the shipment detail page. Admins can impersonate lower roles via the nav role-switcher.
- **Persistent Shipment Header** — `ShipmentHeaderBar` is visible on the Overview page and all 8 promoted sub-pages: shipment ID (click-to-copy), FCL/LCL, route, dates, Incoterm, routing term, vessel, shipper/consignee, contract, TEU, and Loop Code, plus a Door → POL → POD → Terminal journey bar that resolves the actual SEA leg(s) rather than assuming the shipment's top-level POL/POD is the sea port — correct even for Door pickups and multi-leg transshipment (TSP) routings.
- **Dedicated Services** — Export/Import services dashboard (VGM, Haulage, Fumigation, Storage, Customs Clearance, and more) embedded on the shipment Overview page. Each service has a vendor, an office defaulted from the shipment's Export/Import Managing Office, and a Requested → Confirmed → Completed/Cancelled status lifecycle, fully audit-logged.
- **Schedules Page Overhaul** — Route Legs are now editable directly on the Schedules page; new legs auto-order Pick-up-first / Delivery-last. "Add Sailing" is transshipment-aware — picking a multi-leg sailing updates every affected leg, not just the first. The old Sailings list is now a read-only Schedule History audit trail.

---

## Tech Stack

| Layer      | Technology |
|------------|-----------|
| Frontend   | React 18, Vite, custom design system (inline styles via design tokens) |
| Backend    | Node.js 22.5+, Express |
| Database   | SQLite via `node:sqlite` (built-in, no ORM) |
| Real-time  | WebSocket via `ws` package (shared HTTP server, `/ws` path) |
| Charts     | Recharts |
| Diagrams   | Mermaid (Kanban Epic diagram view) |
| PDF Export | jsPDF + jsPDF-AutoTable (document builders) |
| XLSX Export | ExcelJS (server-side workbook generation + template population) |
| Auth       | JSON Web Tokens (`jsonwebtoken`), `bcryptjs` password hashing |
| FX Rates   | Frankfurter / ECB API (free, no key required) |
| Weather    | Open-Meteo API (free, no key required) |

---

## Getting Started

### Prerequisites

- **Node.js 22.5 or later** — required for the built-in `node:sqlite` module (DatabaseSync). The app will not start on older versions.

  Check your version: `node --version`

  If you use [nvm](https://github.com/nvm-sh/nvm) or [fnm](https://github.com/Schniz/fnm), the `.nvmrc` at the project root pins Node 22 — run `nvm use` or `fnm use` before installing.

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

### NPM Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start API server (port 3001) + Vite dev server (port 5173) concurrently |
| `npm run seed` | Seed ports, carriers, vessels, regions, commodities |
| `npm run seed:contracts` | Seed sample carrier contracts |
| `npm run checkdb` | Inspect DB schema and row counts |
| `npm run export:template` | Regenerate `exports/dashboard-template.xlsx` |
| `npm run build` | Production Vite build |
| `npm run test` | Run API integration tests |

### Notes

- `cargodesk.db` is created automatically on the first server start.
- Schema changes are applied via safe `ALTER TABLE` migrations at startup — no manual DB intervention needed.
- The database file is excluded from version control (see `.gitignore`).
- Run `npm run seed` and `npm run seed:contracts` with the server already running so they write to the same `cargodesk.db` instance.
- The FX converter and weather widget use free public APIs — no API keys required.
- The WebSocket server shares port 3001 with the Express API (`/ws` path). The Vite dev server proxies WebSocket connections automatically.

---

## Deployment

CargoDesk is 4 backend processes (the monolith, `services/document-distribution/`,
`services/pdf-render/`, `services/contract-management/`) plus a static frontend build. `npm run
dev` runs all of this in dev mode (Vite's own dev server + proxy). The contract-management
service runs alongside the monolith's own local contract tables, not in place of them — see
`app_settings.contract_source` in Application Settings. For anything else, there's a first-draft
Docker path:

```bash
mkdir -p docker-secrets
openssl rand -hex 32 > docker-secrets/jwt_secret
openssl rand -hex 32 > docker-secrets/distribution_service_secret
openssl rand -hex 32 > docker-secrets/pdf_render_service_secret
openssl rand -hex 32 > docker-secrets/contract_service_secret
cp .env.example .env          # non-secret config (LOGIN_RATE_MAX, etc.) — see below
mkdir -p docker-data && touch docker-data/cargodesk.db docker-data/distribution.db docker-data/contracts.db
mkdir -p docker-data/uploads
docker compose up -d --build
```

**This has not been build-tested in a real Docker environment** — it was written against this
repo's actual npm scripts, dependencies, and ports, but no Docker install was available to
actually build and run it while writing it. Treat `Dockerfile`, `services/*/Dockerfile`, and
`docker-compose.yml` as a first draft to verify before relying on for anything real, not as
proven-working.

### Secrets management

The 4 processes share 4 secrets (`JWT_SECRET`, `DISTRIBUTION_SERVICE_SECRET`,
`PDF_RENDER_SERVICE_SECRET`, `CONTRACT_SERVICE_SECRET`). Running via `docker compose`, they're passed using Compose's
native file-based `secrets:` mechanism — mounted at `/run/secrets/<name>` inside each
container, never exposed via `docker inspect` or a process-env dump the way a plain
`environment:` value is. Each process reads its own secret via a `<NAME>_FILE` env var pointing
at the mounted path (`lib/dockerSecret.js`, duplicated per-service since there's no shared
module between independent processes — same reasoning as `roundCents()`'s own duplication),
falling back to a plain `<NAME>` env var and then an insecure dev default if neither is set —
so `npm run dev` and a bare `docker run -e JWT_SECRET=...` both still work unchanged.
`docker-secrets/*` (the actual secret files) and `.env` are both gitignored; `.env.example`
documents the plain-env-var fallback path for anything not going through Compose secrets.

Beyond "generate real random values and keep the files/env out of version control," there is
no actual secrets-management story here: no vault, no rotation, no per-environment separation.
That's a real, honestly-acknowledged gap for anything beyond a single-operator self-hosted
deployment — a legitimate future ask once this deployment path itself exists and has actually
been used, not solved here.

---

## Troubleshooting

**`Cannot find module 'mermaid'` (or any other missing package)**
You probably skipped `npm install`. Run it before `npm run dev`:
```bash
npm install
npm run dev
```

**`TypeError: DatabaseSync is not a constructor` or `node:sqlite` errors**
Your Node.js version is too old. The built-in `node:sqlite` module requires Node.js 22.5 or later.
```bash
node --version   # must be v22.5.0 or higher
```
Use nvm (`nvm install 22 && nvm use`) or download the latest LTS from [nodejs.org](https://nodejs.org).

**`Error: listen EADDRINUSE :::3001` or `:::5173`**
A previous server process is still running on that port. Kill it and retry:
```bash
# Windows
netstat -ano | findstr :3001
taskkill /PID <pid> /F

# macOS / Linux
lsof -ti:3001 | xargs kill
```

**App starts but the database is empty**
The database is not included in the repository. Run the seed scripts once after the first server start:
```bash
npm run seed            # ports, carriers, vessels, commodities
npm run seed:contracts  # sample carrier contracts (optional)
```
Alternatively, copy `sampleDB/cargodesk.db` to the project root for a pre-loaded database.

**XLSX template export returns 404**
The base template has not been generated yet. Run:
```bash
npm run export:template
```
Then optionally open `exports/dashboard-template.xlsx` in Excel, add charts referencing the named ranges `WeeklySummary`, `ByCarrier`, or `ByLane`, and save.

---

## Project Structure

```
CargoDesk/
├── server.js                  # Entry point: SQLite schema, startup migrations, shared helpers,
│                              #   WebSocket server. HTTP routes live in routes/.
├── routes/
│   ├── auth.js                # /api/auth/*, /api/users/*, /api/access-configs/*, /api/scope-items/*
│   ├── shipments.js           # /api/shipments/* (CRUD, events, status-log, containers, messages, legs)
│   ├── allocations.js         # /api/allocations/* (CRUD, match, conflicts)
│   ├── mdm.js                 # carriers, vessels, ports, linked-ports, trade-lanes, countries,
│   │                          #   regions, unlocodes, commodities
│   ├── kanban.js              # /api/tickets/*, /api/ticket-links/*
│   ├── customers.js           # /api/customers/*, /api/sanctions/*, /api/fx/*
│   ├── contracts.js           # /api/contracts/*, /api/entity-events/*
│   ├── shipment-ops.js        # screening, cost-lines, milestones, documents
│   ├── finance.js             # /api/margin/summary
│   ├── system.js              # /api/health, system-messages, settings, schedules
│   └── export.js              # /api/export/shipments.csv, /xlsx, /template
├── vite.config.js             # Vite config with /api and /ws proxy rules
├── exports/
│   └── dashboard-template.xlsx  # Base XLSX template with named ranges (WeeklySummary, ByCarrier, ByLane)
├── scripts/
│   ├── import-mdm-data.js        # Seeds ports, carriers, vessels, regions, commodities (npm run seed)
│   ├── seed-contracts.js         # Seeds sample carrier contracts (npm run seed:contracts)
│   ├── checkdb.js                # Dev utility — inspects DB schema and row counts (npm run checkdb)
│   └── create-export-template.js # Generates exports/dashboard-template.xlsx (npm run export:template)
├── data/
│   ├── seaports.csv           # 14,269 UN/LOCODE records
│   ├── carriers.csv           # 68 carrier records
│   └── vessels.json           # 349 vessels (IMO registry)
├── sampleDB/
│   └── cargodesk.db           # Pre-loaded sample database — copy to project root to use
└── src/
    ├── api.js                 # All fetch wrappers (api.shipments, api.export, api.costLines…)
    ├── tokens.js              # Design tokens, theme system, route-matching helpers
    ├── version.js             # VERSION, CODENAME, CHANGELOG
    ├── toast.js               # Pub-sub toast emitter
    ├── App.jsx                # Routing, navigation, top-level state, auth guards, role switcher
    ├── AuthContext.jsx        # createContext + useAuth hook — user, activeRole, canEdit, isAdmin, isViewer
    ├── main.jsx
    ├── dev/
    │   ├── CargoDesk.postman_collection.json   # All API routes in 18 resource folders
    │   └── CargoDesk.postman_environment.json  # {{baseUrl}} = http://localhost:3001
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
    │       ├── SailingPickerModal.jsx    # Shared sailing search modal (selectLabel prop)
    │       ├── UserManagementPanel.jsx   # Admin-only user CRUD (name, email, role, status, last login)
    │       └── VesselCombobox.jsx        # {VesselCombobox, VesselField} named exports
    └── pages/
        ├── LoginPage.jsx                # Centered login form; calls api.auth.login → onLogin(token, user)
        ├── LandingPage.jsx              # Fleet KPIs, weather, FX, calendar week, system messages
        ├── ShipmentsPage.jsx            # Shipment list + filters + ⬇ CSV export + ShipmentForm
        ├── ShipmentFormPage.jsx         # New/edit shipment form; LegsTable (shared with Contracts & Schedules)
        ├── ShipmentDetailPage.jsx       # Overview — View Only banner + ServicesPanel; ContainerForm, MessagesDrawer (WebSocket)
        ├── ShipmentConditionsPage.jsx   # Contract Type, Incoterm, Booking Ref, B/L, commodity, declared value
        ├── ShipmentContainersPage.jsx   # Cargo — container CRUD, VGM/CY-cutoff/Demurrage Compliance column
        ├── ShipmentPartiesPage.jsx      # Parties & Offices
        ├── ShipmentSchedulesPage.jsx    # Contracts & Schedules — Route Legs, contract attach, Space Config, Schedule History modal
        ├── ShipmentMilestonesPage.jsx   # Milestone stepper
        ├── ShipmentAccounting{Costs,Invoices,Gp}Page.jsx  # Cost Entry / Invoice Entry / GP Overview
        ├── ShipmentTicketsPage.jsx      # Linked Integration Board tickets
        ├── ShipmentHistoryPage.jsx      # Paginated shipment event log
        ├── DashboardPage.jsx            # Overview + Contract Consumption + Margin (⬇ XLSX) tabs
        ├── SpaceConfigurationsPage.jsx  # Standalone Space Configs page with Linked Shipments modal
        ├── DashboardArchivePage.jsx     # Expired allocations + renew flow
        ├── KanbanPage.jsx               # Ticket board with drag-to-reorder, nesting, WIP limits
        ├── AppSettingsPage.jsx          # API Controls + Finance + Users (admin only) tabs
        ├── UserManualPage.jsx           # Incoterms 2020 + IMDG reference
        ├── AboutPage.jsx                # DB schema, features, changelog
        └── mdm/
            ├── MdmCarriersPage.jsx
            ├── MdmCommoditiesPage.jsx       # 294 Maersk commodity codes
            ├── MdmContractsPage.jsx         # Contracts with legs (loc type selectors) and IMDG filters
            ├── MdmCountriesPage.jsx         # Countries + port count + trade lane assignments
            ├── MdmCustomersPage.jsx         # Customer records with address + contact fields
            ├── MdmLinkedPortsPage.jsx
            ├── MdmPortLocationsPage.jsx     # 14,269 UN/LOCODE ports
            ├── MdmRegionsPage.jsx
            ├── MdmTradeLanesPage.jsx        # Trade lanes + country assignments
            ├── MdmUNLocationCodesPage.jsx
            └── MdmVesselsPage.jsx           # 349 IMO vessels
```

---

## Database Schema

55 tables total — schema declared in server.js startup, migrations applied automatically. See the About page's **Architectural Details** tab for the full domain-grouped list; the table below covers the core/most-referenced ones.

| Table | Purpose |
|---|---|
| `shipments` | Core shipment records with party fields (shipper, consignee, principal) |
| `containers` | Container-level cargo detail, plus VGM/CY-cutoff/Demurrage-Detention compliance fields (v0.30.0) |
| `allocations` | Space configurations (TEU per carrier / route / contract) |
| `carriers` | Carrier MDM |
| `vessels` | Vessel MDM (IMO registry) |
| `port_locations` | 14,269 UN/LOCODE ports (has `last_synced_at`) |
| `linked_ports` | Port equivalence pairs — used for conflict detection and route matching |
| `trade_lanes` | FIATA high-level trade lanes |
| `country_trade_lanes` | Country → lane assignments |
| `regions` | Region MDM |
| `countries` | ISO 3166-1 countries + `portCount` via LEFT JOIN |
| `tickets` | Kanban board cards (`shipment_id`, `parent_id`, `assignee_id`, `due_date`, `version`) |
| `ticket_links` | Cross-ticket dependency relationships (blocks / is blocked by / etc.) |
| `shipment_events` | Full audit log: `FIELD_UPDATED`, `STATUS_CHANGED`, `CONTAINER_ADDED/REMOVED/UPDATED` |
| `shipment_messages` | Per-shipment threaded messages with author, role, and timestamp |
| `shipment_legs` | Multimodal legs: `leg_type`, `movement_type`, `pol_loc_type`, `pod_loc_type`, `movement_by` |
| `shipment_cost_lines` | BUY and SELL cost lines per shipment with source tracking (`source`, `modified_at`) |
| `shipment_milestones` | Per-shipment milestone steps with estimated date, completion timestamp, and note |
| `shipment_schedules` | Per-shipment saved sailings: carrier, vessel, voyage, ETD, ETA, transit days, isMock flag, saved by |
| `shipment_services` | Dedicated Services (Export/Import): service type, status lifecycle, vendor, office, dates |
| `shipment_screenings` | OFAC/SDN screening results and manual override records |
| `shipment_documents` | Uploaded document metadata (filename, type, label, path) |
| `status_log` | Shipment status transitions (legacy, kept for compatibility) |
| `entity_events` | Generic audit log for allocations, carriers, and contracts |
| `test_items` | Dedicated test-case repository (Test Folder/Plan/Run/Case) — separate from `tickets`, optional `shipment_id` FK |
| `test_case_links` | Test Case ↔ Story links, bidirectional "Tests" / "Is tested by" relationship |
| `edi_messages` | Per-shipment carrier EDI log — direction (out/in), message type, raw/parsed payload, `is_mock` flag |
| `container_events` | Per-container FCL lifecycle log — event type, location, occurred at, recorded by |
| `commodities` | 294 Maersk freight commodity codes (Grades M/K/E/S/Q) |
| `customers` | Customer records with full address and contact details |
| `contracts` | Carrier rate contracts with IMDG class filters and validity window |
| `contract_legs` | Origin / destination port pairs per contract with linked-port flags, haulage columns, and loc types |
| `contract_rates` | Rate entries per contract |
| `milestone_templates` | Reusable milestone step definitions grouped by template key, carrier, and trade lane |
| `system_messages` | Operational notices with severity and minute-precision active date/time range |
| `sanctions_entries` | OFAC SDN entity records |
| `sanctions_syncs` | OFAC sync history (timestamp, source, record count) |
| `app_settings` | Key-value store for server-side config (API keys, feature toggles, recurrence) |
| `users` | Authenticated users: email, name, `password_hash`, role (admin/operator/viewer), `is_active`, `last_login` |
| `user_scope_items` | Per-user shipment scope restrictions (carrier, POL, POD filters for viewer role) |
| `user_access_configs` | Per-user access configuration records |

See the built-in **About** page (i in the sidebar) for the full interactive schema reference with column descriptions and migration history.

---

## Changelog

| Version | Codename | Summary |
|---------|----------|---------|
| 0.75.1 | Remittance | Invoicing Discipline & Billing Performance, second pass (`TKT-YC7PZP`) — per-customer invoice-generation deadline, direct follow-up: "some clients pay same day, some at end of month" — needs to be configurable, not one fixed schedule. New `customers.invoice_deadline_days` mirrors `credit_terms_days`; anchored to the shipment's own "delivered" milestone; soft/informational only. Surfaced via the same lightweight notification-bell pattern already used for expiring contracts — no new page needed yet, the full report (Story 4) is still queued. 10 new assertions, full suites + build green, live-CDP-verified. |
| 0.75.0 | Remittance | Invoicing Discipline & Billing Performance (Epic `TKT-KR6ZBT`), first pass — direct follow-up after Credit Control Depth: the app tracked AR aging on the receiving end but had no control on the generating end or on actual payment receipt (`outstandingAr` meant "confirmed, non-voided invoice," not "unpaid"). Ships the 2 foundational primitives: Mark as Paid (`TKT-NQ87D3`, real `paid_at`/`paid_amount`/`transaction_id` on invoices, both required, never auto-defaulted; a partial payment reduces AR without resetting its aging clock) and a denormalized `first_sent_at` signal (`TKT-PLAVEK`, replaces an expensive live join across the audit log and the document-distribution service for "was this sent"). 24 new assertions, full backend + frontend suites and a build verified green, live-CDP-verified. 3 more stories (deadline flag, Billing Performance report, configurable reminder cadence) queued. |
| 0.74.0 | Solvency | Credit Control Depth, third and final pass (`TKT-GLWMFP`) — closes Epic `TKT-6XFJQM`. Credit-hold and over-limit override authority now belongs exclusively to the trade_manager responsible for a shipment's own trade lane (never admin/operator/an out-of-lane trade_manager), reusing the existing `user_scope_items` trade-lane scoping mechanism. Releasing a hold is a new dedicated, reason-required action; the same lane check closes a direct-API bypass in the generic customer PUT route too. Over-limit is now a real, server-enforced hard block on invoice generation for the first time (the AR-aging prerequisite v0.57.0 deferred shipped in v0.73.0) — the only way past it is an approval from the shipment's own lane trade_manager, valid for a 60-minute grace window rather than strict single-use (so a per-container split invoice run isn't re-blocked on its 2nd+ document). New top-level "Credit Overrides" page (not nested under Accounting) lists every blocked shipment, scoped per viewer. Also fixed a real pre-existing bug caught while testing: the over-limit projection double-counted the current invoice's own amount, harmless as a soft warning, a real correctness bug now that it's a hard block. 24 new assertions, full backend + frontend suites and a build verified green, live-CDP-verified. |
| 0.73.1 | Solvency | Credit Control Depth, second pass — ships the earlier trigger points (`TKT-Q00WHF`) explicitly deferred from v0.73.0. Shipment creation stays soft/informational (a held Shipper/Consignee/Principal never blocks creating the shipment, but the response carries `creditWarning.onHold`, mirrored into a toast next to the existing sanctions-screening one). Carrier booking send is a real, server-enforced 409 block instead — a booking request is a genuine external commitment, checked both server-side (unbypassable) and client-side. New shared `CreditHoldModal` component, extracted from what used to be local to the invoice-generation gate, now backs both gates with call-site-specific wording. 7 new assertions (59 total in that file), full backend + frontend suites and a build verified green from a fresh restart. Verified live via CDP: the booking-send modal renders correctly against a real held customer; the creation-time toast's wiring was confirmed by direct code review (structurally identical to the already-verified sanctions toast) rather than a full form click-through — the New Shipment form's interdependent pickers proved too brittle to automate reliably, a disclosed scope boundary. |
| 0.73.0 | Solvency | Credit Control Depth (Epic `TKT-6XFJQM`), first pass — a sourced gap analysis of the existing Credit Control feature (v0.57.0) against CargoWise One and Magaya, published as an artifact + 7 Kanban stories. Ships the 4 that extend `GET /api/customers/:id/credit-status`/`customers.currency` as one bundled pass: real AR aging buckets (Current/1-30/31-60/61-90/90+, not a flat total — a confirmed Magaya gap); a new `committedExposure` figure for accrued-but-never-invoiced SELL cost lines, kept separate from `outstandingAr`; a parent/group `groupOutstandingAr` rollup wired onto the existing `resolveCustomerGroup()` helper; and a customer's own `currency` (already existed, previously unused for this) now drives `credit_limit`'s interpretation, defaulting from country for a new customer (e.g. ES→EUR) rather than the old hardcoded USD. Earlier trigger points (shipment/booking-creation gates) and a trade-lane-scoped override exclusive to that lane's own trade manager are logged, explicitly deferred to the next pass. 52 new/extended assertions, full backend + frontend suites and a build verified green from a fresh restart. |
| 0.72.3 | Clearance | Real CI failure fixed at the source: the PDF Render Service's Puppeteer browser launch was fully lazy, so the first document-generation call in a run paid the full cold-start cost inside a 30s timeout — timed out at exactly 30.0s on a loaded CI runner. Fixed by warming the browser eagerly at the service's own boot instead of on first use (non-fatal if it fails); also bumped the caller's own timeout 30s→45s as defensive headroom. Confirmed live: the previously-timing-out test now completes in well under 4 seconds. Full backend + frontend suites and a build verified green from a fresh restart. |
| 0.72.2 | Clearance | Backend test coverage pushed from 76.56% to 90.15% — real V8 line coverage, measured (no coverage tooling existed in this repo; installed `c8` temporarily, fully removed after). 17 new test files, 631 new assertions, all against live endpoints, targeting the specific files the baseline measurement identified as weakest: `export.js`/`organization.js`/`mdm.js`/`kanban.js` went from ~20-55% to 100%; `routes/shipment-ops.js`'s cost-line accrual/actualize/post/post-batch state machine and Dedicated Services CRUD got their first-ever direct HTTP-level test. A recurring gotcha found and fixed along the way: a route with no per-route `auth()` call isn't necessarily public — a single global `/api/*` gate in `server.js` most route files never re-state. Deliberately not chased: `ai.js`'s real LLM tool-loop (needs a live provider), SSO's real callback success path, and the sanctions sync/import routes (would destructively replace the live dataset other tests depend on — matching a precedent already set elsewhere in this suite). All 17 files wired into the permanent suite (main chain now 45 files); full backend + frontend suites verified green end-to-end from a fresh boot, clean build. |
| 0.72.1 | Clearance | Removed the obsolete Maersk developer-tools integration — Maersk's own developer.maersk.com portal it depended on is obsolete, and the app still carried its leftover App Settings configs. Removed the live-API code entirely (schedule search's `maerskSchedules()`, carrier booking's `maerskBookingRequest()`) rather than just hiding the Settings UI, since it would otherwise sit as unreachable dead code — matches this codebase's own dead-code-removal precedent. Schedule search is now catalog-then-demo only; carrier booking requests, already effectively simulated-only in practice, are now explicit about it. Removed the two now-purposeless Settings cards and rewrote the "demo sailings" banners that pointed at configuring the now-gone key. Left untouched: MAEU/SAFM/MCPU as real carrier codes (still used for booking eligibility, a separate concept), the Maersk commodity-code MDM registry, and historical changelog entries. Full backend + frontend suites green, clean build. |
| 0.72.0 | Clearance | Two-phase direct request. (1) A new "Ocean Freight Basics" chapter in the User Manual teaching sea-freight fundamentals — Ro-Ro vs Lo-Lo, Master B/L vs House B/L issuance and how they interlink — grounded in real external references (docshipper.com, Höegh Autoliners). (2) Full integration of Epic `TKT-6A7J45` ("The Missing Manifest" gap analysis: Export Filing ↔ Pickup Service), 10 stories. Highlights: filing staleness detection (a Filed/Accepted filing snapshots its carrier/routing/cargo at Submit time and flags drift against the shipment's live values); a USPPI/Ultimate Consignee gate on filing creation (both legally required EEI fields); a Pickup-service cross-reference and status on the AES/EEI filing card; a 24h pre-departure filing deadline indicator; the AES/EEI filing's confirmation number (ITN) now appears on the outbound carrier booking request and on both the House and Master Bills of Lading. Two errors in the original published roadmap were caught and corrected during implementation via direct code inspection rather than built as planned — the milestone-wiring direction (ISF/AMS, not AES/EEI, correctly maps to `customs_cleared`) and a proposed nav relocation that would have reversed a deliberate v0.45.0 decision (implemented as a cross-link instead). Verified live via CDP across all 10 stories; full backend + frontend suites green, clean build. |
| 0.71.0 | Docket | NVOCC (Non-Vessel Operating Common Carrier) readiness audit, off a detailed mechanics brief: an NVOCC is legally both a carrier (House B/L, to its own customer) and a shipper (Master B/L, to the real vessel operator) for the same movement. Audited CargoDesk's data model against that dual role — a 7-finding artifact plus a real Kanban Epic (`TKT-Q52B38`). 4 findings closed: a new "NVOCC" party role + `customers.is_nvocc`/`fmc_number` licensing fields; the outbound carrier booking-request payload now names the assigned NVOCC (not the underlying cargo owner) as shipper of record; the generated House Bill of Lading surfaces the NVOCC's identity; a genuinely separate, independently-generated Master B/L document (new `MB01` doc type — Shipper is the NVOCC, Consignee reads "TO ORDER OF {NVOCC}", cross-referenced against the House B/L). 3 larger findings (a full structural dual-carrier/principal field split, a two-stage destination release workflow, NVOCC co-loading/cross-tariff reference) remain logged as scoped backlog. Deliberately not the same gap as LCL/consolidation, which stays deferred under the standing FCL-first roadmap. |
| 0.70.0 | Waypoint | Two more Competitive Gap Analysis stories, plus a documentation refresh. (1) **AI-driven document extraction** — new `POST /api/ai/extract-document`, a generic single-shot vision endpoint (image on any provider, PDF on Anthropic only) wired into the Freight Audit invoice form as an "Extract from document" upload. (2) **Quoting / RFQ pre-booking stage** — new `quotes`/`quote_lines`, `QuotesPage.jsx`; Draft→Sent→Accepted/Declined/Expired→Converted, pricing referenced from the existing contract-match engine, conversion splits BUY (from the contract) and SELL (from the quote) cost lines correctly. A real blank-page bug found via live CDP verification (the new shipment wasn't reaching the SPA's local cache before navigating) — found and fixed. (3) **CargoDesk Field Guide** — the user manual rewritten as a 12-chapter, screenshot-illustrated, step-by-step walkthrough following one real shipment through its whole lifecycle in the actual required order, published as a standalone artifact for review. (4) **`ARCHITECTURE.md` refresh** — was stale since v0.30.0 and, on inspection, worse than its own staleness banner admitted (three conflicting line counts, a self-contradiction on FK enforcement, resolved debts still listed open, a whole microservice undocumented); rewritten from a direct pass against the live code. |
| 0.69.0 | Custodian | Competitive gap analysis vs. CargoWise, Magaya, Descartes, project44/FourKites/GoComet, Flexport/Freightos, CargoSphere, and real AES/ISF/ACE + multi-list screening requirements — full writeup + a 10-story roadmap logged in Kanban, explicitly separating gaps no code can close (carrier networks, market data, marketplaces) from real buildable ones. Two executed: (1) **Freight Audit & Payment** — carrier invoice reconciliation against contracted rates/accrued costs plus a Detention & Demurrage pre-audit computed from existing free-time tracking; new `FreightAuditPage.jsx`. (2) **Multi-list denied-party screening** — extends OFAC-SDN-only screening to the free US Consolidated Screening List (11 more lists: BIS Denied Persons/Entity/Unverified/Military End User, State Dept ITAR Debarred, 5 more OFAC-family lists), zero schema change needed. LCL/consolidation/Master-House B/L — the largest real gap found — deliberately not scheduled, per the standing FCL-first decision. |
| 0.68.0 | Junction | Two features: (1) Multi-Routing-Per-Contract — a contract can now cover one lane via several distinct physical routings (e.g. three different transshipment hubs), each independently priced/timed, researched against SeaRates/CargoSphere/CargoWise/Freightos. New `contract_routings` table; `findMatchingContractLegs` returns one match per (contract, routing) pair. (2) Standalone Contract Management Service (`services/contract-management/`, port 3004) — CargoDesk's third extracted microservice, and its first that runs ALONGSIDE the monolith's own local tables rather than replacing them, selected per-request via a new admin-only `app_settings.contract_source` toggle ('local' default \| 'remote') in Application Settings. Every local contract/allocation/cost-line/DG-policy read that touches contract data gained the same toggle branch. New CLI migration script (never automatic), Dockerfile + compose entry. Verified live via CDP: flipping the toggle immediately switches what the real Contracts page reads, and a contract created in 'remote' mode is provably invisible once flipped back to 'local'. |
| 0.67.0 | Drydock | Four more architect-review fixes, two correcting stale ARCHITECTURE.md claims found inaccurate on re-verification: real indexing gaps (shipment_cost_lines, containers, entity_events, shipment_documents — 14 indexes already existed elsewhere), real transaction gaps (contracts.js legs/rates, contract-rate re-import, invoice reversal — 9 transactions already existed elsewhere), a verified float-precision money-rounding bug fixed via a new roundCents() helper, and a first-draft (untested, no Docker available) production deployment path: static-file serving, 3 Dockerfiles, docker-compose.yml. |
| 0.66.0 | Bulkhead | Four platform-hardening epics: CI Pipeline (the existing Cypress workflow had zero actual runs ever — pull_request-only trigger on a commit-to-main project; fixed, plus a new backend-tests-and-build job and two real previously-hidden bugs it surfaced), Frontend Test Coverage (Vitest + Testing Library, App.jsx auth gating + KanbanPage's Add Ticket flow, wired into CI), Runtime Lifecycle Separation (audited server.js's 4 bundled lifecycles, extracted PDF rendering into a second microservice, services/pdf-render/), and a SQLite-ceiling design doc (Postgres PoC honestly logged as blocked by this environment, not skipped). |
| 0.65.1 | Ballast | Follow-up: extracted server.js's genuine pure row-mapper functions (mapShipment, mapContainer, mapCustomer, and 45 others) into lib/mappers.js via a factory matching the existing createAisListener pattern, leaving real business logic (syncShipmentFromLegs, the access-control filter) that had shared the same section header behind in server.js. server.js: 3230 → 2984 lines, no behavior changed. |
| 0.65.0 | Ballast | Dead-code audit and removal. `server.js`'s entire tail (144 route registrations) was an exact duplicate of routes already registered by `routes/*.js`, proven unreachable via Express's first-match routing, plus 10 interleaved helper functions independently re-implemented in their live counterparts — removed, taking `server.js` from 5300 to 3230 lines. Also removed: a full legacy pre-refactor app copy, an unreferenced client-side jsPDF document generator (dropping the `jspdf`/`jspdf-autotable` dependencies), and three entirely dead component definitions inside `DashboardPage.jsx`. No behavior changed — every removal was proven unreachable/unreferenced first. Full test suite green, clean build, live CDP verification. |
| 0.64.0 | Relay | TKT-SLIRP9 — Document Distribution: EDI + Webhook channels, and CargoDesk's first extracted microservice. New `services/document-distribution/` — a genuinely separate deploy unit (own port, own SQLite file) owning webhook configs, EDI transmittals, and webhook deliveries, reached over an authenticated internal HTTP API. Document rows gain "📡 EDI" and "🔗 Webhook" send buttons plus a "🕐" history icon (closing a gap where every send, including the existing Email feature, was invisible after the fact). Test Tools gains a real dev-only Webhook Simulator with client-side HMAC signature verification. Found and fixed two real bugs live: a webhook-delivery double-insert on failure, and a never-configured webhook silently defaulting to inactive. |
| 0.63.0 | Beacon | GPS-Coordinate Pickup/Delivery for Classified-Location Customers: some customers' sites (military/government/restricted) can only be identified by GPS coordinates, never a UN/LOCODE. A Pick-up/Delivery leg's loc-type gains a "GPS Coordinates" option (strict either/or with the UN/LOCODE, never both) carrying its own lat/lng, gated so a SEA leg can never use it. New `classified_location`/lat/lng fields on customers, with a Profile-tab checkbox reveal. Fixed a real bug found live via CDP verification: the SEA-leg gate checked a leg's stale `mot` field instead of the authoritative `legType`. Public share-token tracking links redact exact coordinates while still showing a "Classified location" label. |
| 0.62.1 | Waypoint | Found live during an end-to-end manual test of v0.62.0: the pre-existing schedule-correction route (`PUT /api/shipments/:id/schedules/:scheduleId`, for a carrier-driven vessel/ETD/ETA shift) updated the schedule's own columns fine but left `schedule_key` and the underlying leg rows stale on the original sailing, since this route predated the leg-key rework. Fixed by wiring it into the same leg-saving path; a real vessel substitution now correctly produces a new leg key instead of silently freezing. |
| 0.62.0 | Waypoint | Content-Keyed Sailing Legs: schedule legs are now deduplicated via a content-derived key (carrier+vessel+voyage+route+date) instead of every schedule owning fresh, unshared leg rows — the same physical leg can now back multiple schedules. A schedule_key (composed from its ordered leg keys) identifies a schedule by its actual sailing content. Leg revisions from external sources now diff-and-log an audit trail, surfaced in the existing Schedule History panel. Fixed a real gap where picking a multi-leg sailing via Add Sailing silently lost its transshipment-leg breakdown. |
| 0.61.0 | Liaison | Carrier Line Agents: modeled the carrier-to-local-agent relationship (differs by port, e.g. Maersk's Rotterdam agent isn't its New York agent) via a new carrier_agents master-data table + MDM page, auto-resolving onto shipments as ordinary "Line Agent (Export)"/"Line Agent (Import)" additional parties — reusing existing screening, party-editing, and customer-role infrastructure for free. New read-only Line Agents card on the shipment's Carrier Booking → Details tab. |
| 0.60.0 | Census | Customer roles reworked from a hand-maintained 13-checkbox editor into a derived, read-only signal computed from actual shipment/shipment_parties usage — self-correcting, nothing to keep in sync. GET /api/customers?role= now accepts comma-separated multi-role values. Considered and rejected splitting customers/vendors into separate tables (duplicate-company-record risk); built a segmented Trading Customers/Service Providers view over the same table instead, with a color-coded Roles column on the Customers MDM list. |
| 0.59.1 | Lineage | Fixed a real bug (direct user report on SHP-XXGOJ1): generated freight invoices (FR01/FR02) and credit/debit notes completely omitted VAT from the actual PDF, even with a real non-zero VAT rate on a cost line — the in-app summary always computed it correctly, only the generated document dropped it. Both builders now show a per-line VAT column and a Subtotal/VAT/Total breakdown per currency. |
| 0.59.0 | Lineage | Organization Model Enhancement, Epic 4: Customer Hierarchy. New self-referential parent_customer_id + resolveCustomerGroup() helper (read-side only — write paths keep denormalizing as before). Margin/GP reporting gains a "Roll up by parent" toggle consolidating a multinational shipper's regional accounts into one row; Carrier Booking's Client field shows "Part of {parent}" context. |
| 0.58.0 | Sentinel | Organization Model Enhancement, Epic 3: Unified Compliance Screening. Sanctions screening now covers all 13 possible party-role slots (was 3), auto-re-screens on any party change, and cross-references customer-level hits into every shipment referencing that customer — including catching a real bug where a customer rename was invisible to shipment-level screening due to denormalized name copies. |
| 0.57.0 | Covenant | Organization Model Enhancement, Epic 2: Credit Control. New credit_limit/credit_terms_days/credit_hold on customers — a hold hard-blocks generating a new invoice for that customer's shipments (naming exactly who and why); an over-limit projection (existing AR + the invoice about to be generated) is a soft warning only, never a hard block. Ties directly into the existing invoicing flow, no new page. |
| 0.56.0 | Roster | Organization Model Enhancement, Epic 1 of a CargoWise-gap-analysis roadmap: new per-customer Contacts (named people, replacing the old free-text-notes workaround) and Roles (role-eligibility tags) — CustomerCombobox gains a soft `roleFilter` that narrows pickers without ever hard-blocking an unflagged customer. First of 5 planned epics (credit control, unified compliance screening, customer hierarchy, and a proper Customer/Organization service extraction still to come). |
| 0.55.1 | Transponder | Design correction to AIS: confirmed departure/arrival now updates ETD/ETA in place (idempotent-confirmation guard) instead of a separate ATD/ATA pair. Plus four unrelated live bugs fixed: Route Legs carrier-column overflow, header/row column misalignment, a compounding "duplicate schedule" bug in Sailing Search, and a theme-toggle color bug that stuck "Delivery" leg text gray in light mode. Vessels MDM row-height/alignment polish. |
| 0.55.0 | Transponder | AIS Integration — live vessel-tracking data (aisstream.io, free/no hardware) keeps the Vessels registry fresh (resolves unknown IMOs, catches renames) and auto-detects a shipment's actual departure/arrival (ATD/ATA) from position data, non-destructively (never overwrites a manual entry). Pluggable provider config; new Test Tools AIS Simulator for verification without a live key. |
| 0.54.3 | Catalog | Fixed a fourth live bug: transit time showed "0d" for TSP schedules — the Schedule Generator's create route hardcoded `transit_days` to 0 instead of deriving it from etd/eta, undercounting any transshipment hub dwell time. Now computed as the whole-journey span; existing affected rows backfilled. |
| 0.54.2 | Catalog | Fixed a third live bug on the same feature: a TSP built entirely inside the Configure Legs modal (main form left blank) was wrongly blocked from generating, since validation only checked the top-level fields, not the leg rows — now mirrors the backend's own leg-1/leg-N derivation, and the main form visibly reflects a modal-built TSP on Done. |
| 0.54.1 | Catalog | Fixed two live bugs found on v0.54.0: stale mock-derived schedules were resurfacing in Add Sailing search mislabeled as real catalog matches (now excluded via `is_mock=0`), and the Configure Legs modal's Vessel field had no real autocomplete and no per-leg Carrier field (now a real vessel-registry search plus a carrier picker per leg). |
| 0.54.0 | Catalog | Decoupled the Schedule Generator (Test Tools) from shipments — Generate no longer requires linking a shipment, it just stores a schedule. Add Sailing search now checks that stored catalog first (POL/POD/ETD window/TSP hubs), falling back to live/demo data only when nothing real matches. Added real multi-leg/TSP support to the Generator via a new "Configure Legs" modal, and a settings toggle to disable the synthetic demo-sailing fallback. |
| 0.53.0 | Voucher | Verified Office-Level Email Distribution (`TKT-O4B0IB`) was already fully shipped and closed it out. Implemented Invoice Reversal / Debit-Credit Note workflow (`TKT-DUADU3`), SELL-side only: a "Reverse" action on a confirmed invoice creates negative-amount, locked adjusting cost lines, marks the original invoice voided (struck-through in the UI), and generates a new, dedicated Credit / Debit Note document linked back to the original. |
| 0.52.0 | Manifest | Completes the CargoWise-Aligned Carrier Booking Requirements epic: the outbound booking-request payload gains vessel IMO, Cargo Ready Date, party names, commodity code, Place of Receipt/Delivery, and a grouped DG cargo declaration (all previously missing despite the underlying data already existing on the shipment). A new booking-to-B/L link lets a confirmed booking point at a specific generated BL01 document, since a shipment can have several over time with no "current" flag. A DG-cargo awareness chip now shows on the Carrier Booking Details page. |
| 0.51.0 | Signet | Signed PDF Document Generation — document generation moves server-side (`puppeteer-core` renders the same client-built HTML) and every generated PDF is signed with a real, self-signed CAdES-detached CMS/PKCS#7 signature (`node-forge` + `@signpdf`), verifiable and tamper-evident in a PDF reader's own signature panel. New `org_signing_certs` table keeps the signing key off `app_settings`, which is returned in plaintext to any authenticated user. Filenames now end `.pdf` instead of `.html`. Raw file attachments are untouched and never signed. Prerequisite for the coming Office-Level Email Distribution epic. |
| 0.50.2 | Declaration | Fixed the Schedules tab flashing "No legs yet" instead of a loading spinner while its Route Legs fetch was in flight. |
| 0.50.1 | Declaration | Fixed the New Shipment draft form's SEA leg row not visually updating after "Apply sailing to SEA leg" — the legs table's internal render state wasn't resyncing on external draft mutations. |
| 0.50.0 | Declaration | Epic 3 (final) of the FCL-completeness roadmap: Customs & Regulatory Filing. New `customs_filings` table tracks simulated AES/EEI (export) and ISF/AMS (import) filings through Draft → Filed → Accepted/Rejected, reusing the existing EDI message infrastructure. New Customs Filing page (nav-gated on a Customs Broker + priced cargo line), new Test Tools "Filing Simulator" tab. Simulated/mock only — no real government EDI integration. |
| 0.49.0 | Appraisal | Epic 2 of the FCL-completeness roadmap: Structured Commodity / Cargo Line Items. `container_packages` gains unit value/currency/HS override plus a write-time USD conversion, feeding a cargo value rollup (Cargo page badge + a new "Cargo Value" field on the persistent shipment header) and real per-line rows on the Commercial Invoice and Packing List (previously a container-level em-dash placeholder), with a byte-identical fallback for containers with no pack-item breakdown. |
| 0.48.0 | Muster | Epic 1 of the FCL-completeness roadmap: Flexible Party / Organization Model. A shipment previously had exactly 4 hardcoded party roles (Shipper/Consignee/Notify/Principal) — new `shipment_parties` table adds an extensible mechanism alongside them (Forwarder, Customs Broker Export/Import, Trucker Pre/On-carriage, Also Notify Party, Bank, Insurance Provider, Agent). New Additional Parties panel on the Parties & Offices page; Insurance Certificate, Customs Declaration, and Pickup/Delivery Plan documents now surface the matching party when assigned, falling back to today's behavior otherwise. |
| 0.47.2 | Consignment | Fixed a gap in the Overview page's Export/Import Services dashboard: once a service was requested, there was no way to add or change its vendor/office afterward. Added an Edit button to each service row that reopens the request form pre-filled, now supporting save-in-place. |
| 0.47.1 | Consignment | Fixed a layout bug on the redesigned Containers page: the Save/Cancel and + Add Package buttons were buried inside a small fixed-height nested scroll box. The right detail panel now flows naturally in the page like every other page in the app. |
| 0.47.0 | Consignment | Cargo Manifest & Container Details Redesign: the Containers page and the separate "Cargo Manifest" modal are now one unified page — a tree spanning every container and its typed pack breakdown, with a detail panel showing Marks & Nos. and a Description of Goods rollup. DG classification now works at the individual pallet/carton level, not just the container. New org-wide DG Compliance Address setting, pulled onto the Dangerous Goods Declaration. |
| 0.46.1 | Stowage | Three linked schedule/booking bugs fixed: a freshly-added Route Leg was immediately locked/uneditable while a schedule existed; removing that stuck leg wiped the entire real schedule (cascade compared raw SEA-leg counts instead of checking which leg was actually removed); and once a schedule really was unlinked, the shipment header kept showing stale vessel/ETD data and Carrier Booking stayed fully accessible with no schedule attached. New combined Cypress spec (schedule-leg-cascade.cy.js) covers all three in one run. |
| 0.46.0 | Stowage | Container cargo manifest now supports a typed pack hierarchy (Pallet, Carton, Case, Crate, Drum, Box, Bag, Bundle, Other) alongside its existing arbitrary-depth nesting — pack types are admin-maintained via a new Master Data → Pack Types registry, seeded with defaults. The Cargo Manifest panel was rebuilt into a two-panel tree + detail view mirroring the Test Case repository's own folder tree. |
| 0.45.1 | Manifest | Fixed a real loading-delay bug: Parties & Offices' EMO/IMO/Controlling dropdowns showed only their placeholder option (no real candidates) while offices were still loading, reading as "not configured" rather than "still loading" — now gated behind a proper spinner. Carrier Booking Details/Review also upgraded from a blank flash to a visible spinner while loading. |
| 0.45.0 | Manifest | Pickup Service moved from "Booking & Routing" back into Export Services as a regular child. Sequence (Pickup/Delivery/Loading/Unloading's per-container plan) now has a hard floor of 1, enforced server-side with a backfill for pre-existing 0 values; client-side an out-of-range entry is clamped only on blur (never mid-typing) and surfaced via toast rather than silently rewritten. |
| 0.44.2 | Wayfinder | Promoted the admin's already-saved sidebar order to the hardcoded default in code (Documents, Overview, Milestones & Events, Conditions, Parties & Offices, Cargo, Booking & Routing, Export Services, Import Services, Accounting, History) — no visible change today, but a fresh install now starts from the intended order. |
| 0.44.1 | Wayfinder | Carrier Booking — Details/Review cleanup: removed the redundant status badge + BKG- id next to each page's heading (already shown in the "Bookings on this Shipment" table above), matched the heading's font size to that table's own heading, and added a new Contract & Customer card to Details (Contract Number, Reference, Client from the contract's Named Account — "No Customer" if none, and Commodity). |
| 0.44.0 | Wayfinder | Admin-only drag-and-drop reordering for the Shipment Explorer sidebar — an "⇅ Reorder" toggle lets an admin drag the 11 top-level nav blocks into a new order and save it for every user (children within a group stay fixed). New admin-only `PUT /api/settings/shipment-sidebar-order` route; a saved order is reconciled against the current default on every render so a future new section never silently disappears. |
| 0.43.0 | Reroute | Carrier booking rework: any not-yet-Confirmed booking (Pending included) is now auto-cancelled and superseded the moment its carrier actually changes — a real cancellation EDI message goes out, the old booking is archived under its own id, a fresh one is created under the new carrier. A same-carrier edit now explicitly keeps the same bookingID forever. The standalone History tab is gone — a single combined table (current + every past booking) is embedded directly in both the Details and Review tabs instead, with read-only inline expansion for superseded rows. |
| 0.42.1 | Compass | Removed "Haulage" from the Services catalog entirely — it was a generic duplicate of a distinction Pickup (export)/Delivery (import) already make directly, each with its own Merchant's-vs-Carrier's-Haulage routing awareness. Existing rows already ordered as "Haulage" keep displaying on Overview, just without a dedicated sidebar page anymore. |
| 0.42.0 | Compass | Export/Import Services now restrict which service types can be ordered per side instead of offering the same full catalog on both — VGM/Loading/Pickup are Export-only (origin-side), Unloading/Delivery are Import-only (destination-side); Haulage/Storage/CY Storage/Warehousing/Customs Clearance/Fumigation/Other stay available on both, since those genuinely apply at either end. |
| 0.41.3 | Logbook | Fixed a real bug: the Pickup service's per-container sequence (and notes/planned-date) could be missing from the generated document if "Generate" was clicked right after editing a row — its async save hadn't resolved yet. Generate now re-fetches fresh from the server before building the document, and the button disables while any row save is still in flight. |
| 0.41.2 | Logbook | Fixed a real misalignment on the New Shipment form's Cargo section — Currency was a hand-rolled `<select>`, not the shared `Sel` primitive, so it lacked both the standard label styling and a hint line, sitting misaligned next to Declared Value. Now uses `Sel` with a matching hint. |
| 0.41.1 | Logbook | Two more real gaps in 0.41.0, found by re-checking the actual reported shipment: Send Booking Request and the manual Confirm route both bypassed the new archive/supersede check entirely (only `ensureBookingCreated` had it) — fixed by sharing one `archiveIfSuperseded()` helper across all three. Separately, changing a shipment's contract to a new carrier never touched an already-assigned schedule/leg — Route Legs kept showing the old carrier forever; now auto-unlinks the stale schedule and prompts for a new sailing. |
| 0.41.0 | Logbook | Carrier bookings now have real history: a Cancelled/Rejected booking whose carrier no longer matches the shipment's current one gets archived (own BKG- id preserved, viewable in a new History tab) and replaced with a fresh booking under the new carrier — additive `carrier_booking_archive` table, existing booking routes untouched. A Confirmed booking is never superseded. Booking-request payload also gains `contractRef`/`rateSnapshotId`. |
| 0.40.1 | Haulier | Fixed DatePicker's calendar popover rendering clipped inside scrolling containers instead of floating over the page — it was the one dropdown in the app that never got updated to the position:fixed-off-the-trigger-rect pattern PortCombobox/CarrierCombobox already use. |
| 0.40.0 | Haulier | Pickup/Delivery split from one combined type into two, each with a dedicated page showing whether the covering leg is Merchant's Haulage (we arrange it) or Carrier's Haulage (the carrier does). Sidebar reorganized: Contracts & Schedules, Carrier Booking, and Pickup/Delivery (once ordered) now group under a new "Booking & Routing" section instead of living as separate top-level rows. |
| 0.39.1 | Tally | Fixed a systemic form-field misalignment at its root: the shared Field primitive (Inp/Sel/DatePicker/Textarea) crammed its label and hint onto one line, so two side-by-side fields with different label+hint lengths could wrap to different heights and misalign their inputs. Also fixed Sel silently dropping its hint prop entirely. |
| 0.39.0 | Tally | The carrier booking-request payload now includes an equipment summary (containers grouped by size+type, with count/weight/volume) instead of saying nothing about what's being shipped. Shown on the Carrier Booking Details page so what's on screen matches what gets sent. |
| 0.38.1 | Waybill | Fixed a bug where a shipment with a real contract and a fully hand-entered route (no formal "Add Sailing" ever run) still showed the Carrier Booking gate modal. A SEA leg with a real ETD now counts as "has a schedule" too, not just a saved-sailing row; a startup backfill retroactively created 19 bookings for shipments that already qualified. |
| 0.38.0 | Waybill | A carrier booking now gets a real ID automatically the moment a shipment has both a contract and a schedule — no need to click Send first. The new "Created" status replaces the old cosmetic "Draft" fallback with an actual persisted row. The Carrier Booking page is now blocked behind a modal (no close button) until both are set, with a button routing straight to Contracts & Schedules. |
| 0.37.1 | Almanac | Carrier Booking's Details/Review now render as in-page tabs on a single page (matching the original tabs requirement) instead of nav-bar parent/child rows. The sidebar shows one "Carrier Booking" entry; deep links to Review (notification bell, Test Tools) still open on the right tab. |
| 0.37.0 | Almanac | `shipment_schedules` gains a real vessel IMO and ATD/ATA (actual dates). More significantly, a schedule can now be shared: a new `schedule_shipment_links` table lets many shipments link to the same schedule without duplicating it, so "how many shipments are on this schedule" is answerable via a new Linked Shipments view. New Test Tools **Schedule Generator** (header shortcut icon + Integration Board sidebar) builds schedules from the real Vessels/Ports/Carriers registries and links them to one or more shipments at once. |
| 0.36.0 | Beacon | Three self-directed reliability/observability improvements. Startup migration failures are no longer silently swallowed — a genuine failure (not the expected "duplicate column name" re-run noise) is now logged and surfaced as a red banner in System Health. The notification bell gains a Carrier Bookings section: a Rejected booking, or a Pending one stale for 48h+, now shows up alongside above-threshold allocations and links straight to that shipment's Review page. `KanbanPage.jsx` (the only file importing `mermaid`) is now lazy-loaded, cutting the initial JS payload from 629 kB to 458 kB gzipped — the diagram library only loads when Integration Board is actually opened. |
| 0.35.1 | Charter | Fixed a silent bug where `applySailingToLegs` (duplicated in `ShipmentSchedulesPage.jsx` and `ShipmentFormPage.jsx`) no-op'd instead of creating a SEA leg when a shipment had no leg yet — the Route Legs table stayed empty while the UI still reported success. `BOOKABLE_CARRIERS` centralized (was duplicated 3 ways) into `ctx.BOOKABLE_CARRIERS` + a new `src/utils/carrierBooking.js`. The Carrier Booking sidebar entry and Shipments list both gained a Pending/Rejected booking-status badge. |
| 0.35.0 | Charter | Carrier Booking becomes its own shipment sub-page family (Details + Review), replacing the old EDI messages drawer — Details holds the outbound request, Review holds the carrier's response plus new Confirm/Cancel actions. A confirmed carrier response no longer auto-finalizes the booking; it waits for the operator's own Confirm click. New Integration Board → Test Tools page ships an EDI Message Simulator so rejections (previously untestable — the old demo fallback could only ever return "confirmed") can be exercised on demand. |
| 0.34.5 | Ledger | Security review response: fixed a stored-XSS hole in Kanban's Mermaid diagram rendering, closed a gap where role downgrades didn't revoke existing sessions, added per-IP login rate limiting, and shipped a full password-expiry policy (configurable expiry, self-service change with strength meter and complexity requirements, forced change prompt when overdue). Rotated a previously-exposed admin credential. Applied the safe subset of `npm audit fix`. |
| 0.34.4 | Ledger | Closes the last icon gap: MingCute has no anchor, search, or messaging/EDI icons, so a second Apache-2.0 family (Remix Icon, same style) was added — 8 new icons covering the anchor (including the app's own logo mark everywhere it appears), every search/browse button, and the messaging/EDI cluster (header icon tile, EDI drawer, Export/Import service groups). |
| 0.34.3 | Ledger | Icon replacement pass three covers the remaining shipment sub-pages (Contracts & Schedules, Cost/Invoice Entry, Loading & Generic Service, Space Configurations, Archive, Cargo) and the Services / Container Events / Container Packages shared panels, with seven new icons (door, receipt, coin, time, file, file-certificate) completing the shipment Explorer sidebar — only the anchor stays emoji (no MingCute equivalent). Container lifecycle events each get a matching icon. Nav fold state now persists per group in localStorage — expanded groups survive reloads; a fresh browser still starts all-collapsed. |
| 0.34.2 | Ledger | Main nav gets its own internal scrollbar and starts collapsed by default (Dashboard/Integration Board join Master Data/Organization as foldable groups) — fixes the sidebar silently clipping its last item on shorter screens. Icon replacement extends past the sidebar/settings-only scope of 0.34.1 into shipment entry/detail pages, the Dashboard, and the persistent shipment header, plus six new icons (lock, unlock, eye, up/down arrow, forbid). Two standing admin accounts documented for recovery/verification use. |
| 0.34.1 | Ledger | Sidebar icon set replaced: every nav item's emoji swapped for a line-style SVG icon from MingCute (Apache-2.0) via a new shared `Icon.jsx` component, rendering consistently across browsers/platforms instead of relying on the OS's emoji font. The ⚙ settings glyph got the same fix everywhere it appears (the shared ActionMenu trigger, Application Settings menu item, command palette, Kanban WIP-limit/Board Settings buttons), using an actual gear-shaped icon rather than a sliders-style one. The vendored icon source was trimmed from ~24MB/3,324 files down to just the ~30 actually used. Scoped to the sidebar and the settings icon for this pass — inline emoji elsewhere (edit/delete/warning glyphs, badges) are unchanged. |
| 0.34.0 | Ledger | Epic `TKT-A5LUPD` advances on five fronts. **Accrual/posting state machine + GP variance** (`TKT-83O41G`): cost lines gain an accrued → actualized → posted status lifecycle with amount/variance tracking; posting locks a line (409 on edit/delete); GP Overview shows Estimated vs Actual vs Variance by charge code. **Per-container invoicing + automated charge codes** (`TKT-OK5H34`): a new admin-maintained charge-code registry (Master Data → Charge Codes) auto-injects defined charges (e.g. a $10/container fee) into every per-container invoice when generated. **Container cargo manifest** (`TKT-EMFIBR`): a new self-referencing, arbitrary-depth pallet/box breakdown per container (description + quantity), independent of the container's own weight/cargo-description fields. **CPI + milestone automation** (`TKT-OZD4V8`): cost lines gain a per-line Carrier Payment Indicator (Prepaid/Collect) with its own GP breakdown; EDI booking confirmations and container Gate In/Out/VGM events now auto-complete the matching shipment milestone instead of requiring a manual click. **Parties & Offices redesign** (`TKT-PNFO5O`): Offices become inline-editable directly on the page; Parties keep their edit-modal flow. Plus: auto-validate/auto-save when leaving an open Add/Edit Container form with invalid fields (`TKT-OJYO71`), a services-panel loading-spinner fix, and stable `id` attributes across every shipment sub-page. |
| 0.33.0 | Gangway | Export/Import Services (Epic `TKT-TBS7QD`) reaches every ordered service type. Unloading now shares `LoadingServicePage.jsx` with Loading — structurally identical (per-container planned date/time, sequence, notes, carrier-attachment-or-generate document flow) — via a `serviceType` prop driving the doc-type code (`LP01`/new `UP01`) and labels, instead of a duplicated component. The other 7 types (VGM, Haulage, Fumigation, Storage, CY Storage, Warehousing, Pickup/Delivery, Customs Clearance) move off the "Work In Progress" placeholder onto a real `GenericServicePage` — vendor/status/dates recap, a bigger Details field bound to the existing `shipment_services.notes` column, and a generic produced document under the catch-all "OT" (Other) doc type rather than a new tracked type per service (would either collide across services sharing one slot, or clutter every shipment's Documents page). `DatePicker` gained an optional `withTime` prop — a native time input alongside the calendar, value becomes `"YYYY-MM-DDTHH:mm"` — every other call site unaffected since it defaults off. |
| 0.32.0 | Stevedore | Export/Import Services: dedicated per-service configuration pages (Epic `TKT-TBS7QD`). Ordering a service on Overview now makes a dedicated nav entry appear for that specific service type, under new "Export Services" / "Import Services" sidebar rows that only show once something's ordered on that side — a dynamic per-shipment nav shape (`src/shipmentServicePages.js`) separate from the static section config. "Loading/Unloading" split into separate "Loading" and "Unloading" types. Loading Service is the first type with a real dedicated page: a per-container loading plan (planned date, sequence, notes — new `shipment_loading_plan_lines` table) plus a new tracked "Loading Plan" (`LP01`) document type, populated either by uploading the carrier's emailed plan or generating one from the structured table (`buildLoadingPlanHtml`, alongside the existing invoice builders). Every other service type gets a shared "Work In Progress" placeholder page, making the pattern visibly extensible one story at a time. |
| 0.31.0 | Ballast | TKT-E64LKG's remaining sibling bugs: sailing search now soft-matches a Central contract's TSP transshipment hub/vessel service instead of dropping them (info hint + sort-first in `SailingPickerModal`, no hard filter); manual contract types (SPOT/Pending/Customer Own) gain a Carrier field and Valid From/To dates with an "Expired" badge; the schedule-confirmation-on-close dialog was found already resolved from v0.29.0. Schedule History staleness fix: a new `PUT /api/shipments/:id/schedules/:scheduleId` endpoint keeps the saved-sailing audit record and the backing SEA leg in lockstep in one call, logging a real field-level old→new diff (mirroring the cost-line history pattern) instead of silently going stale — a new pencil action on the locked SEA leg opens a lightweight "Update Schedule" modal instead of the previous only-option of removing the leg entirely. New Cargo Ready Date guard: editing CRD past the shipment's ETD now clears the booked contract/schedule (with an audited reason) and forces the shipment to Requires Review, since cargo can't be ready before a vessel that's already sailed. Also backfilled the `version` field on 78 Kanban tickets by cross-referencing against this changelog, server.js migration comments, and the About page's schema notes — correcting a few tickets mistagged against the wrong patch release. |
| 0.30.0 | Fairway | FCL container compliance trio: VGM tracking, CY cutoff, and Demurrage/Detention free-time countdowns (origin anchored on Gate In→Sailed, destination on Discharged→Gate Out), computed server-side in one batched query per container list fetch; new Compliance & Cutoffs / Free Time sections in `ContainerForm`, a stacked-badge Compliance column on the Cargo page. Contracts & Schedules polish: Schedule History collapsed into a button + modal (same panel, `forceOpen` prop, not rewritten); Contract/Space Configuration render side-by-side; Route Legs table no longer capped at 1100px, now matches the header bar's width. Shipments list POD/routing accuracy fix: the list, search, and CSV export now resolve each row's real sea Port of Loading/Discharge from its SEA legs instead of the door-to-door bookend fields, which could show an inland city under "POD" for a shipment with a trucked final delivery leg. New-shipment form: the same first-vs-last-SEA-leg bug that caused the POD issue also broke the sailing search and Route Summary — fixed identically; `applySailingToLegs` now correctly replaces every trailing SEA leg instead of splicing on top of them; a Customer Arranged Pick-up/Delivery leg no longer blocks Create Shipment when left incomplete. Overview page further consolidated: Contract & References and Cargo Details cards removed (Contract & References promoted to a new "Conditions" nav page; the redundant "Services" sidebar entry removed since Services already lives in-page on Overview). |
| 0.29.0 | Bearing | Persistent Shipment Header (`ShipmentHeaderBar`) visible on Overview + all 8 promoted sub-pages, with a Door → POL → POD → Terminal journey bar that's TSP/Door-pickup aware (resolves the real SEA leg instead of assuming `shipment.pol`/`pod` is the sea port). Dedicated Services: new `shipment_services` table + routes back a two-column Export/Import dashboard (`ServicesPanel`) embedded on Overview — vendor, EMO/IMO-defaulted office, Requested→Confirmed→Completed/Cancelled lifecycle, fully audit-logged. Schedules page overhaul: Route Legs table now lives here directly with auto-ordering (Pick-up first, Delivery last); "Add Sailing" is now fully TSP-aware (previously only ever touched the first leg, or nothing at all, on an existing shipment) and correctly resets POL/POD when switching from a transshipment sailing back to a direct one; the old Sailings box is now a read-only Schedule History audit panel. `RouteSummaryBar` relocated from Overview to the Schedules page. About page gains an Architectural Details tab. |
| 0.28.0 | Waypoint | Test-case repository separation: test items (Test Folder/Plan/Run/Case) live only in their own `test_items` table, no longer mixed into the Integration Board's `tickets` data; `test_case_links` gives a bidirectional Test Case ↔ Story "Tests" / "Is tested by" relationship. TicketPreview footer redesigned — only Backlog and previous/next status stay visible by default, rest moved behind a header ⚙ ActionMenu. EDI Messaging: `edi_messages` table logs every outbound/inbound carrier EDI exchange per shipment; `POST /api/shipments/:id/edi-messages/booking-request` sends via `maerskBookingRequest()` (mirrors `maerskSchedules()`'s real/mock-fallback shape) for MAEU/SAFM/MCPU, falling back to tagged demo data without a live key; `EdiMessagesDrawer` (📡 icon) shows direction badges, status pills, raw/parsed payload toggle. FCL container lifecycle events: new `container_events` table logs per-container movement (Empty Pickup → Gate In → Loaded → Sailed → Discharged → Gate Out → Empty Return) — foundation for upcoming demurrage/detention tracking — via a new `ContainerEventsPanel` (📋 button per container row). Fixed `seal_number` data-entry gap (existed in schema/backend, never exposed in `ContainerForm`). New test coverage: `tests/container-events.test.js` + extended `cypress/e2e/containers.cy.js`. |
| 0.27.0 | Lookout | Command Center overhaul: KPI cards toggle in-page shipment filter (Active / Pending / Review / TEU / Overdue); Integration Board ticket alert card (Overdue + Due This Week tabs with priority dot, status badge, days counter, assignee avatar); shipment preview routing bar renders Door/CY flanking nodes from routingTerm; CC layout changed to position:fixed escaping main scroll; AI chat composer anchored at bottom. Sailing management hardening: applySailingToLegs sets ETA + carrierCode; TSP multi-leg support; edit-mode replace-not-append; active sailing highlighted green in SailingPickerModal. ShipmentsPage 90s background poll with ↻ unloaded-count badge and ⏰ Overdue pseudo-filter. ShipmentDetailPage ↻ refresh button. Dashboard Contract Consumption three-tier fallback for contractNumber/carrierCode. api.shipments.get(id) added to api.js. Negative transit days render ⚠ dates amber badge. |
| 0.26.0 | Meridian II | AI Agent: routes/ai.js with POST /api/ai/chat (agentic tool-call loop: get_shipment, list_shipments, get_contract, get_allocation; OpenAI-compatible; max 3 iterations) and GET /api/ai/settings; ai_agent_enabled app_setting toggle. AiChatDrawer right-side panel (user/assistant bubbles, typing indicator, Shift+Enter; ✦ nav button when enabled; active shipment context). AI Agent subtab in AppSettings (provider presets, endpoint/model/key/system-prompt, Test Connection). Per-user finance gating: can_view_finance column on users; Finance chip in UserManagementPanel; financeEnabled = global_toggle AND (isAdmin OR canViewFinance). data-testid attributes: user-avatar-btn, main-nav, license-modal. GitHub Actions CI: .github/workflows/cypress.yml (wait-on, cypress run, screenshot artefacts). Journey breadcrumb in SailingPickerModal (door/CY/port nodes in routing-term order); SchedulesModal in MdmContractsPage rendered from seaLeg loc types. |
| 0.25.0 | Voyage | Shipment schedule bookings: shipment_schedules table; GET/POST/DELETE /api/shipments/:id/schedules in shipment-ops.js; api.schedules.list/save/remove. Sailing section in ShipmentForm with shared SailingPickerModal (2/4/8/12w picker, mock warning); new-shipment mode holds selection and saves post-create; edit mode saves directly. "Apply vessel & ETD to SEA leg" shortcut button. SchedulesPanel in ShipmentDetailPage. Related Tickets panel (GET /api/tickets?shipmentId= filter added to kanban.js; RelatedTicketsPanel component). ShipmentDetailSidebar gains Schedules (⚓) and Tickets (◩) nav links. SailingPickerModal extracted to src/components/shared/ (selectLabel prop, ~240 lines de-duped). Health endpoint version now uses require('../package.json').version; package.json synced to 0.25.0. |
| 0.24.0 | Sentinel | Login lockout (failed_attempts + locked_until, configurable via app_settings, HTTP 423). Token revocation via token_version column — auth() validates tv claim on every request. Configurable JWT lifetime (jwt_lifetime_hours). Azure AD / Entra ID SSO behind sso_enabled feature toggle: authorization code flow, /api/auth/sso/* endpoints, find-or-create user. Admin activity log: admin_events table, logAdminEvent helper, GET /api/admin/events with pagination. AppSettings: SecuritySettingsPanel, SsoSettingsPanel, AdminActivityLog tab. UserManagementPanel: lock badge, Unlock and Revoke Sessions buttons. LoginPage: SSO button, sso_token / sso_error URL param handlers. |
| 0.23.0 | Portage | Route extraction: all 144 HTTP routes moved from server.js into 11 domain-scoped route files (routes/auth, shipments, allocations, mdm, kanban, customers, contracts, shipment-ops, finance, system, export) using a ctx factory object; server.js is now a thin orchestrator. Contract leg location types: pol_loc_type / pod_loc_type selectors (Terminal/Door/CY/CFS) added to MdmContractsPage leg editor and persisted to contract_legs. Export feature: GET /api/export/shipments.csv (34-column server-side CSV, auth-aware); GET /api/export/dashboard/xlsx (4-sheet ExcelJS workbook — Summary + KPI block + 6-week trend, By Carrier, By Lane, Shipment Detail); GET /api/export/dashboard/template (template-based XLSX with named ranges for chart wiring). ⬇ CSV on ShipmentsPage; ⬇ XLSX (programmatic) + ⬇ XLSX (template) on Margin Overview tab. npm run export:template generates the base template. |
| 0.22.0 | Crossroads | Multimodal leg UX hardening: SEA leg Movement Type and Movement By blocked (show —); Pick-up/Delivery legs show — in Carrier column (always derived from SEA leg); Vessel/Voyage disabled for Pick-up/Delivery unless Barge; column order finalised (ETD before ETA, Carrier after ETA). Row selection + Remove Leg footer button replaces per-row × buttons. PKU/DEL flanking cells in route summary banners (ShipmentDetailPage and ShipmentFormPage): dynamic grid shows door pick-up/delivery locations in separate dashed-border cells; seaport UNLOCODE correctly shown as Port of Loading/Discharge. Contract matching: GET /api/contracts/match accepts crd, routingTerm, pkuLocation, delLocation; uses seaLeg?.pol as match POL; inclusive carrier haulage logic; contract guard relaxed to POL+POD only. contract_legs extended with carrier haulage columns. rebuildPortLanesMap() called after every trade-lane mutation — no more stale trade lane index. Section IDs added to ShipmentDetailPage and ShipmentFormPage. Trade lane badge in ShipmentDetailPage subtitle. |
| 0.21.0 | Transit | Routing Term engine: shipment_legs extended with leg_type, movement_type, pol_loc_type, pod_loc_type, movement_by; syncShipmentFromLegs computes routing_term from carrier-covered legs; chip in leg-table footer and routing banner. Legs table redesigned to 14 columns with multimodal Leg Type auto-defaults. Routing Term and Trade Lane columns in shipments list. Declared Value (declared_value + currency) on form, detail, and all five document builders. Invoice SELL-only filter. Commodity + Declared Value on one form row. Epic Coverage Modal (📊 on Epic cards). Document Readiness Overview in DocumentsModal. Compliance Screening Phase 1 + 2 summary cards. |
| 0.20.0 | Lading | Quick Container Setup in new-shipment form (count, equipment type, weight, volume, DG, cargo description; draft containers created after save). Central Contract gate requires containers queued first. Incoterm → Principal auto-default (C/D terms → Shipper; E/F terms → Consignee). Routing banner in ShipmentDetailPage derives TSP chips from legs; carrier falls back to linked contract. Carrier code preservation fix: syncShipmentFromLegs uses COALESCE(NULLIF(?, ''), carrier_code). |
| 0.19.0 | Muster | Authentication: JWT login, bcryptjs password hashing, auth() Express middleware, default admin seeded on first startup. User Management: full CRUD in AppSettings → Users tab (admin only). RBAC: three roles (admin / operator / viewer); viewer read-only enforced across every page and MDM module; admin role-switcher in nav. ActionMenu returns null when empty. |
| 0.18.1 | Traverse | Hotfix: License & EULA page; first-visit acceptance modal. File structure cleanup: seed scripts moved to scripts/; sampleDB/ with pre-loaded database. Commodity picker overflow fix. Double-click to open shipment. |
| 0.18.0 | Traverse | Operational Accounting: source tracking, Cost Line History modal, ⇄ Mirror feature, Container column, manual line preservation. Shipment Milestones: milestone_templates + shipment_milestones tables, 9-step FCL template, MilestonePanel stepper, overdue badge on rows and KPI on Landing Page. Integration Board: In Testing + Testing Failed columns, per-column Show More, Show/Hide Released toggle. |
| 0.17.1 | Sentry | Hotfix: FX Rates health check CORS block fixed by routing through /api/fx/rates backend endpoint. |
| 0.17.0 | Sentry | Application Settings page: API Controls tab (External APIs and Internal APIs subtabs), feature toggles that gate sidebar nav items. Sanctions & Denied Party Screening (OFAC SDN): silent screening on every create/edit, OFAC auto-sync with redirect following and overflow fix, CSV file-upload import. |
| 0.16.0 | Courier | Shipment Messages: real-time threaded panel via WebSocket with poll fallback. Shipment Detail FCL badge + click-to-copy ID. Contract badge redesign: Central → solid blue, SPOT/Pending/Customer Own → solid orange. Calendar week badge on Landing Page. Kanban version tags. |
| 0.15.0 | Waypoint | Linked Shipments action on Space Config rows. Config ID chip with copy. Contract-aware TEU consumption with linked-port resolution. ContainerTypePickerModal. Contracts list N+1 query fixed. |
| 0.14.0 | Logbook | Entity audit log (entity_events). ActionMenu cog button. EntityHistoryModal. Space Configurations promoted to standalone sidebar page with lifetime consumption bars and sparklines. |
| 0.13.0 | Manifest | Shipper / Consignee / Principal party fields. Requires Review status. FCL badge in list. CSV export. Kanban ticket types. Resizable columns across all tables. |
| 0.12.0 | Starboard | Customers MDM. Shipment list filters. Landing page KPI cards. Requires Attention section. Kanban tickets linked to shipments. Notification bell. |
| 0.11.0 | Meridian | Shipment History Tracker in shipment_events. Kanban drag-to-reorder. Trade Lanes country assignment. Port locations delta-sync. |
| 0.10.0 | Compass | Space Configs POL/POD + conflict detection. Commodities MDM. Light/Dark theme. Global toast system. |
| 0.9.0 | Anchor | Container freight fields. User Manual. About page. Version registry. |
| 0.8.0 | — | Space Configs: conflict detection, Dashboard Archive, 6-week TEU trend charts, sparklines. |
| 0.7.0 | — | Space Configs: trade lane, alert threshold, notes. Dashboard Archive + Renew flow. |
| 0.6.0 | — | Contract ID field. DatePicker 3-level navigation. |
| 0.5.0 | — | MDM Vessels: 349 ships from IMO registry. Modular refactor into 27 source files. |
| 0.4.0 | — | Landing page with weather widget, fleet stats, upcoming departures. |
| 0.3.0 | — | Integration Board (Kanban): Ready / In Progress / Done / Released. |
| 0.2.0 | — | MDM: 8 modules, 14,269 ports seeded. Shipment detail with container management. |
| 0.1.0 | — | Initial build: shipments, containers, Express + SQLite backend, React 18 + Vite frontend. |

---

(c) 2026 CargoDesk
