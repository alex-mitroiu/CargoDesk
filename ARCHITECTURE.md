# CargoDesk — Architecture Reference
**Version:** 0.17.1 "Sentry" · **Date:** 2026-07-02  
**Audience:** Software architects, senior engineers, technical reviewers

---

## Table of Contents
1. [System Overview](#1-system-overview)
2. [Tech Stack](#2-tech-stack)
3. [Process & Deployment Topology](#3-process--deployment-topology)
4. [Frontend Architecture](#4-frontend-architecture)
5. [Backend Architecture](#5-backend-architecture)
6. [Data Model](#6-data-model)
7. [API Layer](#7-api-layer)
8. [Key Subsystems](#8-key-subsystems)
9. [Data Flow Diagrams](#9-data-flow-diagrams)
10. [Cross-Cutting Concerns](#10-cross-cutting-concerns)
11. [Known Debts & Improvement Opportunities](#11-known-debts--improvement-opportunities)

---

## 1. System Overview

CargoDesk is a **single-tenant freight operations management system** designed for a freight forwarding desk. It covers the full lifecycle of a sea-freight shipment: booking, container management, operational accounting (buy/sell cost lines), space configuration against carrier contracts, compliance screening, and integration tracking.

### Bounded contexts (logical domains)

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CargoDesk                                   │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  Shipments   │  │  Commercial  │  │       Master Data         │  │
│  │  & Cargo     │  │  (Contracts  │  │  (Ports · Carriers ·      │  │
│  │              │  │   + Rates)   │  │   Vessels · Countries ·   │  │
│  │  Shipments   │  │              │  │   Trade Lanes · Regions ·  │  │
│  │  Containers  │  │  Contracts   │  │   Commodities)            │  │
│  │  Cost Lines  │  │  Allocations │  │                           │  │
│  └──────┬───────┘  └──────┬───────┘  └────────────┬─────────────┘  │
│         │                 │                        │                  │
│  ┌──────▼───────┐  ┌──────▼───────┐  ┌────────────▼─────────────┐  │
│  │  Compliance  │  │  Operations  │  │        Platform           │  │
│  │              │  │              │  │                           │  │
│  │  OFAC SDN    │  │  Kanban /    │  │  App Settings · Feature   │  │
│  │  Sanctions   │  │  Integration │  │  Toggles · System Msgs ·  │  │
│  │  Screening   │  │  Board       │  │  FX Rates · WebSocket     │  │
│  └──────────────┘  └──────────────┘  └───────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Tech Stack

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Frontend framework | React | 18.2 | Functional components, hooks only |
| Frontend build | Vite | 5.2 | HMR in dev, ESBuild in prod |
| Styling | Inline styles | — | No CSS files; design token object `T` |
| Charts | Recharts | 2.12 | Dashboard + Space Configs charts |
| Backend runtime | Node.js | ≥ 22.5 | Required for `node:sqlite` |
| Backend framework | Express | 4.18 | Single-file server |
| Database | SQLite (node:sqlite) | built-in | `DatabaseSync` — sync API, no ORM |
| Real-time | ws | 8.21 | WebSocket server on shared HTTP |
| Dev tooling | concurrently | 8.2 | Runs server + Vite in parallel |

**Notable absences (intentional):** no TypeScript, no CSS framework, no ORM, no test framework, no auth layer, no migration framework, no message queue.

---

## 3. Process & Deployment Topology

### Development (current)

```
Developer machine
│
├─ npm run dev
│  ├─ node server.js          → :3001  (Express + SQLite + WebSocket)
│  └─ vite                    → :5173  (React dev server + HMR)
│         │
│         └─ proxy /api → :3001     (all API calls forwarded)
│         └─ proxy /ws  → :3001     (WebSocket upgrade forwarded)
│
└─ cargodesk.db               (single file, co-located with server.js)
```

### Production build

```
vite build  →  dist/
                ├─ index.html
                └─ assets/  (hashed JS + CSS bundles)

node server.js
  ├─ app.use(express.static('dist'))   → serves built frontend
  ├─ app.use('/api/...')               → REST endpoints
  └─ WebSocketServer on same httpServer
```

There is **no reverse proxy, container runtime, or process manager** defined. Single-process, single-host deployment.

---

## 4. Frontend Architecture

### Module map

```
src/
├─ App.jsx              (1,022 lines)  Root: routing, nav, settings state, theme
├─ api.js               (182 lines)   All fetch wrappers — single source of truth
├─ tokens.js            (278 lines)   Design tokens T{}, theme, route helpers
├─ toast.js                           Pub-sub toast emitter
├─ version.js                         VERSION, CODENAME, CHANGELOG
│
├─ pages/
│   ├─ LandingPage.jsx               Dashboard home — clock, weather, fleet KPIs
│   ├─ ShipmentsPage.jsx   (588)      List + create/edit form
│   ├─ ShipmentDetailPage.jsx (2,635) Detail view — largest file in codebase
│   ├─ DashboardPage.jsx   (2,052)    Overview + Contract Consumption
│   ├─ SpaceConfigurationsPage.jsx (920) Allocations CRUD + linked shipments
│   ├─ DashboardArchivePage.jsx      Expired allocations + renew
│   ├─ KanbanPage.jsx      (838)     Integration board, drag-to-reorder
│   ├─ AppSettingsPage.jsx (550)     Feature toggles, external API controls
│   ├─ AboutPage.jsx                 DB schema browser, changelog
│   ├─ UserManualPage.jsx            Inline documentation
│   └─ mdm/  (10 pages)             Master data management CRUD pages
│
└─ components/
    ├─ primitives/
    │   ├─ ActionMenu.jsx            Cog-button context menu (position:fixed)
    │   ├─ Btn.jsx                   Button primitive with size/variant
    │   ├─ Modal.jsx                 Overlay modal
    │   ├─ Form.jsx                  Form field helpers
    │   ├─ Badge.jsx                 Status/label pill (size prop)
    │   ├─ Spinner.jsx               Loading indicator
    │   ├─ ToastContainer.jsx        Toast renderer
    │   ├─ DatePicker.jsx            3-level calendar (Y/M/D)
    │   ├─ Pagination.jsx            Page controls
    │   └─ useResizableColumns.jsx   Drag-to-resize hook + localStorage
    │
    └─ shared/
        ├─ PortCombobox.jsx          Typeahead (position:fixed dropdown)
        ├─ CommodityCombobox.jsx     Typeahead + picker modal
        ├─ VesselCombobox.jsx        Named exports: VesselCombobox, VesselField
        └─ EntityHistoryModal.jsx    Generic audit timeline viewer
```

### Routing

All routing is **hash-based** (`window.location.hash`), implemented manually in `App.jsx`. There is no React Router.

```
#/                        LandingPage
#/shipments               ShipmentsPage
#/shipments/:id           ShipmentDetailPage
#/dashboard               DashboardPage
#/space-configs           SpaceConfigurationsPage
#/dashboard-archive       DashboardArchivePage
#/kanban                  KanbanPage
#/settings                AppSettingsPage
#/about                   AboutPage
#/manual                  UserManualPage
#/mdm/ports               MdmPortLocationsPage
#/mdm/carriers            MdmCarriersPage
#/mdm/vessels             MdmVesselsPage
... (10 MDM routes)
```

### State management

No global state library (no Redux, no Zustand). State flows as:

```
App.jsx
  │
  ├─ appSettings (object)          ← GET /api/settings on mount + nav-away reload
  ├─ theme (isDark bool)           ← localStorage
  ├─ isEnabled(module) helper      ← gates nav items + renders 🔒 fallback
  │
  └─ per-page local state via useState / useEffect
       └─ api.js fetch wrappers return plain JSON → setState
```

### Design token system

All visual properties come from `tokens.js`:

```js
T.surface    T.bg         T.text       T.textMuted
T.accent     T.accentBg   T.border     T.surfaceHover
T.success    T.danger     T.warning    T.info
T.head       T.body       T.mono
```

`applyTheme(isDark)` mutates `T` in place and triggers a full re-render. No CSS variables; all values are JavaScript strings applied via `style={{ ... }}`.

---

## 5. Backend Architecture

### server.js structure (2,241 lines)

```
server.js
│
├─ Imports & constants
│   ├─ express, cors, ws, https, fs, crypto, node:sqlite
│   └─ SERVICE_CODE_MAP, SETTING_DEFAULTS, TRACKED_FIELDS
│
├─ Database setup
│   ├─ DatabaseSync('./cargodesk.db')
│   ├─ Schema CREATE TABLE IF NOT EXISTS (28 tables)
│   └─ Migrations array  ← safe try/catch loop on startup
│
├─ Startup routines
│   ├─ seedDefaultSettings()     ← app_settings defaults
│   ├─ backfillPortCountryCodes() ← IIFE: fills country_code on port_locations
│   └─ scheduleNextOfacSync()    ← reads settings, calls setTimeout
│
├─ Helper functions
│   ├─ uid()                     ← 6-char random hex ID
│   ├─ ok(res, data, status)     ← JSON 200/201 response
│   ├─ err(res, msg, status)     ← JSON error response
│   ├─ logEvent()                ← writes to shipment_events
│   ├─ logEntityEvent()          ← writes to entity_events
│   ├─ getSettings()             ← reads app_settings as key-value map
│   ├─ httpsGetFollowRedirects() ← up to 5-hop redirect follower
│   ├─ importContractRates()     ← contract → BUY cost lines
│   └─ map* functions            ← row → camelCase DTO (one per entity)
│
├─ Express app
│   ├─ express.json({ limit: '25mb' })
│   ├─ cors()
│   └─ 110 route handlers (see §7)
│
├─ WebSocket server
│   ├─ wss = new WebSocketServer({ server: httpServer })
│   ├─ broadcast(type, payload) helper
│   └─ connection handler (ping/pong heartbeat)
│
└─ httpServer.listen(3001)
```

### Request lifecycle

```
Browser fetch('/api/...')
    │
    ▼
Vite dev proxy  (dev only; bypassed in production)
    │
    ▼
Express router
    │
    ├─ express.json()  ← parse body (limit 25 MB)
    ├─ cors()          ← allow all origins
    │
    ├─ Route handler
    │   ├─ db.prepare(sql).get/all/run  (synchronous)
    │   ├─ logEvent() / logEntityEvent()
    │   ├─ broadcast() to WebSocket clients
    │   └─ ok(res, dto) / err(res, msg)
    │
    └─ Response JSON
```

**All database access is synchronous** (`DatabaseSync`). There is no connection pool, no async query layer, and no transaction abstraction.

---

## 6. Data Model

### Entity-Relationship Overview

```
MASTER DATA
───────────
carriers ──────────────────────────────────────────┐
vessels                                             │
port_locations ──────── linked_ports               │
regions ──── countries ──── country_trade_lanes    │
trade_lanes ─────────────────────────────────────────── allocations
commodities                                         │        │
                                                    │        │
COMMERCIAL                                          │        │
──────────                                          │        │
contracts ──────── contract_legs                   │        │
    │                                               │        │
    └──── contract_rates                            │        │
    │         (service_code, unit, container_type)  │        │
    │                                               │        │
SHIPMENTS                                           │        │
─────────                                           │        │
shipments ──────────────────────────────────────────┘        │
    │   (carrier_code FK→carriers)                           │
    │   (contract_id  FK→contracts)                          │
    │   (vessel_imo   FK→vessels)                            │
    │   (pol/pod      FK→port_locations)                     │
    │   (commodity_code FK→commodities)                      │
    │   (shipper/consignee/principal FK→customers)           │
    │                                                         │
    ├──── containers ──── shipment_cost_lines ───────────────┘
    │         (size+type matches contract_rates.container_type)
    │
    ├──── shipment_events       (field-level audit log)
    ├──── entity_events         (cost_line / alloc / contract events)
    ├──── shipment_messages     (threaded notes)
    ├──── shipment_screenings   (OFAC SDN results)
    └──── status_log            (legacy status transitions)

OPERATIONS
──────────
tickets ──── ticket_links       (Kanban board)
    │
    └── (shipment_id FK→shipments, optional)

PLATFORM
────────
app_settings                    (key/value feature toggles)
system_messages                 (operational notices)
sanctions_entries               (OFAC SDN index, ~40k rows)
sanctions_syncs                 (sync history)
```

### Core tables (columns)

**shipments** — 25 columns  
`id · pol · pod · carrier_code · contract_type · contract_id · contract_ref · status · etd · eta · booking_ref · bl_number · vessel · vessel_imo · voyage · incoterm · commodity_code · shipper_id · shipper_name · consignee_id · consignee_name · principal_id · principal_name · contract_notes · created_at`

**containers** — 13 columns  
`id · shipment_id · container_number · size · type · hs_code · gross_weight_kg · volume_cbm · is_dg · dg_class · seal_number · commodity · cargo_description`

**shipment_cost_lines** — 12 columns  
`id · shipment_id · type(BUY|SELL) · charge_code · currency · amount · exchange_rate · notes · container_id · source(contract|manual) · modified_at · created_at`

**contracts** — 14 columns  
`id · contract_number · carrier_code · named_account_id · named_account · movement_type · container_types(JSON) · dg_allowed · imdg_classes(JSON) · valid_from · valid_to · currency · status · notes · created_at`

**contract_rates** — 11 columns  
`id · contract_id · service_code · description · amount · currency · amount_usd · unit(per_container|per_bl|flat) · container_type · sort_order · notes`

**allocations** — 15 columns  
`id · carrier_code · allocated_teu · effective_date · end_date · trade_lane · pol · pod · origin_lane · dest_lane · coverage_scope · contract_id · contract_number · alert_threshold · notes`

**entity_events** — 9 columns  
`id · entity_type(cost_line|allocation|carrier|contract) · entity_id · event_type · field · old_value · new_value · meta(JSON) · created_at`

**shipment_events** — 9 columns  
`id · shipment_id · event_type · field · old_value · new_value · actor · occurred_at · meta(JSON)`

### ID format

All IDs are generated by `uid()` — 6 upper-hex characters prefixed by entity type:

| Entity | Format | Example |
|---|---|---|
| Shipment | `SHP-XXXXXX` | `SHP-W67D3S` |
| Container | `CTR-XXXXXX` | `CTR-4WCFV8` |
| Cost line | `CL-XXXXXX` | `CL-IMEYHI` |
| Contract | `CNTR-XXXXXX` | `CNTR-3KTW1F` |
| Allocation | `ALLOC-XXXXXX` | |
| Ticket | `TKT-XXXXXX` | |
| Customer | `CUS-XXXXXX` | |
| Entity event | `EEV-XXXXXX` | |

---

## 7. API Layer

**110 REST endpoints** across 14 resource groups. All return `{ data }` on success, `{ error }` on failure.

```
Resource group              Endpoints   Notes
────────────────────────────────────────────────────────────────────
/api/shipments              8           CRUD + events + status-log + compliance-hits
/api/containers             4           CRUD (shipment-scoped in practice)
/api/shipment-cost-lines    5           CRUD + import-contract + cost-line-events
/api/cost-lines             2           PUT (edit) + DELETE (by line ID)
/api/margin                 1           Aggregated buy/sell/GP summary
/api/contracts              6           CRUD + search + match
/api/allocations            5           CRUD + conflicts
/api/carriers               5           CRUD + get-by-code
/api/vessels                6           CRUD + search
/api/port-locations         7           CRUD + links + lanes
/api/linked-ports           4           CRUD
/api/trade-lanes            6           CRUD + country assignments
/api/countries              6           CRUD + locations
/api/commodities            6           CRUD + search
/api/customers              6           CRUD + sanctions-check
/api/tickets                6           CRUD + links
/api/entity-events          1           GET by type+id
/api/shipment-messages      2           GET + POST (per shipment)
/api/sanctions              4           status + sync + import-csv + entries
/api/screening              3           get + run + override (per shipment)
/api/fx                     1           GET rates (proxies frankfurter.app)
/api/settings               2           GET + PUT
/api/system-messages        4           CRUD (all + active variants)
/api/health                 1           Liveness probe
/api/unlocodes              1           Search
/api/regions                4           CRUD
/api/country-trade-lanes    4           GET + PUT + DELETE
```

### Naming inconsistency (known debt)

Cost line routes are split between shipment-scoped (`/api/shipments/:id/cost-lines`) and line-scoped (`/api/cost-lines/:id`). All other sub-resources use only the parent-scoped path.

---

## 8. Key Subsystems

### 8.1 Operational Accounting (Cost Lines)

```
Contract
  └── contract_rates[]
        (service_code, amount, currency, unit, container_type)
              │
              │  importContractRates()
              │   1. filter: container_type matches shipment containers
              │   2. aggregate or split-per-container
              │   3. INSERT with source='contract'
              ▼
shipment_cost_lines[]
  ├── source='contract'  → replaced on ↻ Recalculate
  └── source='manual'   → always preserved

Every mutation → logEntityEvent('cost_line', lineId, event, ...)
                 → entity_events (queryable via json_extract(meta,'$.shipmentId'))

UI: CostControl card (compact 5-row preview + summary bar)
     └── CostControlModal (full table: Type · Charge · Container · Source · CCY · Rate · Amount)
     └── CostLineHistoryModal (CREATED / IMPORTED / UPDATED / DELETED timeline)
```

**Source states:**

| `source` | `modified_at` | Display label | Colour |
|---|---|---|---|
| `contract` | null | Contract | Blue |
| `contract` | timestamp | Contract (Modified) | Amber |
| `manual` | any | Manual | Muted |

### 8.2 Compliance Screening (OFAC SDN)

```
OFAC SDN CSV  (treasury.gov — up to 5 HTTP redirects)
      │
      ├── POST /api/sanctions/sync    ← manual trigger or scheduled
      └── POST /api/sanctions/import-csv  ← file upload path
              │
              ▼
      sanctions_entries  (~40k rows, normalised names)
              │
              ▼
      In-memory Map: sanctionsMap (entity_name_norm → entry[])
      Built on startup / after each sync
              │
      ┌───────▼────────────────────────────────────────────────────┐
      │  Auto-screening on POST/PUT /api/shipments                 │
      │                                                            │
      │  Screens: shipper_name, consignee_name, principal_name     │
      │  Skips if: sanctionsMap.size === 0                         │
      │         or compliance override already exists              │
      │         or only non-party fields changed (ETA-only edits)  │
      │                                                            │
      │  HIT  → INSERT shipment_screenings (result='HIT', hits=[]) │
      │       → warning toast naming flagged parties               │
      │  CLEAR→ INSERT shipment_screenings (result='CLEAR')        │
      └───────────────────────────────────────────────────────────┘
              │
      shipment_screenings (latest row per shipment is current state)
      Override: POST /api/shipments/:id/screening/override
                → sets overridden_at, override_reason
```

### 8.3 Space Configurations & TEU Accounting

```
allocations[]
  ├── carrier_code, pol, pod
  ├── contract_id (mandatory since v0.14)
  ├── allocated_teu, alert_threshold
  └── effective_date → end_date

Route matching (tokens.js: allocationRouteMatch)
  ├── Load contract legs for each allocation's contract_id
  ├── Check polLinkedAllowed / podLinkedAllowed flags
  ├── Expand via linked_ports equivalence pairs
  └── Match shipment pol/pod (exact or linked equivalent)

Consumed TEU = sum of container TEU for matching Active shipments
Utilisation  = consumed / allocated × 100
Alert fires  = utilisation >= alert_threshold
```

### 8.4 Contract Rate Matching

`importContractRates()` applies the following logic per rate:

```
for each contract_rate r:
  1. resolve applicableCtrs = containers where (size+type == r.container_type)
                              OR r.container_type is empty (applies to all)
  2. if per_container AND container_type AND applicableCtrs.length === 0 → SKIP
  3. if per_container AND splitPerContainer AND applicableCtrs.length > 0:
       → one BUY line per matching container (linked to container_id)
  4. else:
       containerCount = applicableCtrs.length || 1
       amount = (per_container) ? r.amount * containerCount : r.amount
       → one aggregate BUY line (no container_id)
  5. INSERT with source='contract'
  6. logEntityEvent IMPORTED
```

On recalculate (`overwrite=true`): only `source='contract'` BUY lines are deleted. Manual BUY lines and all SELL lines survive.

### 8.5 Feature Toggles (App Settings)

```
app_settings table  (key TEXT, value TEXT)

Key                     Controls
──────────────────────────────────────────────────────────────
websocket_enabled       WebSocket connection in App.jsx
shipments_enabled       Shipments nav item + module access
contracts_enabled       Contracts MDM
customers_enabled       Customers MDM
carriers_enabled        Carriers MDM
vessels_enabled         Vessels MDM
ports_enabled           Port Locations MDM
system_messages_enabled System Messages MDM
fx_rates_enabled        FX Rates external API
weather_enabled         Weather widget (landing page)
ofac_enabled            OFAC SDN auto-sync
ofac_recurrence_value   Sync interval (number)
ofac_recurrence_unit    Sync interval (days|weeks|months)
```

`isEnabled(module)` in `App.jsx` reads from `appSettings` state. Disabled modules: hidden from nav, show a 🔒 fallback page on direct URL access.

### 8.6 WebSocket

```
Server (ws 8.21):
  wss = new WebSocketServer({ server: httpServer })
  broadcast(type, payload) → all connected clients

  Events broadcast:
    'shipment_updated'   → after PUT /api/shipments/:id
    'ticket_updated'     → after PUT /api/tickets/:id
    'message'            → after POST /api/shipments/:id/messages

Client (App.jsx):
  ws = new WebSocket('ws://…/ws')
  ws.onmessage → parse JSON → update relevant state
  10-second poll fallback if WebSocket not connected
```

### 8.7 Audit Logging — Two-Table Strategy

| Table | Written by | Used for |
|---|---|---|
| `shipment_events` | `logEvent()` | Shipment field changes, status changes, container add/remove |
| `entity_events` | `logEntityEvent()` | Cost line CRUD, allocation CRUD, contract CRUD, carrier CRUD |

Cost line events were **migrated from `shipment_events` to `entity_events`** in v0.18 to keep the shipment history clean. Historical `COST_LINE_ADDED/UPDATED/REMOVED` rows in `shipment_events` may still exist for older shipments.

---

## 9. Data Flow Diagrams

### 9.1 Shipment creation with auto-screening

```
User fills ShipmentForm
        │
        ▼
POST /api/shipments
        │
        ├─ INSERT shipments
        ├─ logEvent(SHIPMENT_CREATED)
        │
        ├─ [if contract_type='Central' && contract_id]
        │    importContractRates(id)  → INSERT cost lines
        │
        └─ [if sanctionsMap.size > 0]
             screenParties(shipper, consignee, principal)
                  │
                  ├─ HIT  → INSERT shipment_screenings
                  │       → response includes screeningResult
                  └─ CLEAR→ INSERT shipment_screenings
        │
        ▼
Response → React state update
        │
        ├─ toast.warning("⚠ Compliance hit: Consignee: Mahan Air")  [if HIT]
        └─ navigate to ShipmentDetailPage
```

### 9.2 Contract recalculation flow

```
User clicks "↻ Recalculate from contract"
        │
        ▼
POST /api/shipments/:id/cost-lines/import-contract
     { overwrite: true, splitPerContainer: bool }
        │
        ├─ DELETE existing BUY lines WHERE source='contract'
        │   (manual BUY lines + all SELL lines are preserved)
        │
        └─ importContractRates(shipmentId, { splitPerContainer })
              │
              for each contract_rate:
              ├─ determine applicableCtrs (by container_type match)
              ├─ SKIP if type-specific and no matching containers
              ├─ INSERT BUY lines (split or aggregate)
              └─ logEntityEvent(IMPORTED)
        │
        ▼
Response { imported: N }
        │
        ▼
await load()  →  setLines(freshData)  →  isSplit re-derived  →  button label updates
```

### 9.3 OFAC sync scheduling

```
Server startup
        │
        ├─ scheduleNextOfacSync()
        │       │
        │       ├─ read ofac_enabled, last_synced_at, recurrence from app_settings
        │       ├─ compute msUntilNext (capped at 2,000,000,000 ms ≈ 23 days)
        │       └─ setTimeout(runSync, msUntilNext)
        │
        ▼
runSync():
        ├─ httpsGetFollowRedirects(OFAC_URL)  (up to 5 redirects)
        ├─ parse CSV → INSERT sanctions_entries (upsert pattern)
        ├─ rebuild in-memory sanctionsMap
        ├─ UPDATE sanctions_syncs
        ├─ on failure → setTimeout(runSync, 1 hour)
        └─ on success → scheduleNextOfacSync()  (re-arm for next cycle)
```

### 9.4 Feature toggle gating

```
App.jsx mount:
  GET /api/settings → appSettings state

Nav render:
  NavBtn visible = isEnabled('shipments_enabled')

Route render:
  isEnabled('shipments_enabled')
    ? <ShipmentsPage />
    : <div>🔒 Module Disabled</div>

Settings save (AppSettingsPage):
  PUT /api/settings → response → setAppSettings
  Nav re-renders immediately (no reload required)
```

---

## 10. Cross-Cutting Concerns

### Error handling

- **Frontend:** `api.js` `req()` wrapper catches HTTP errors, surfaces `error`/`message` from JSON body, fires `toast.error()` for 5xx. Components catch additional domain errors in `try/catch` blocks.
- **Backend:** `err(res, msg, status)` helper — always JSON. No global Express error middleware. Unhandled promise rejections are not caught (no `process.on('unhandledRejection')`).

### Transactions

**None.** All multi-step write operations (e.g. import-contract: delete + insert loop) run as separate synchronous statements with no `BEGIN TRANSACTION`. A mid-operation crash leaves partial state.

### Concurrency

**None modelled.** `DatabaseSync` is synchronous, so Node's single-threaded event loop serialises all DB access naturally. Multiple simultaneous users (if added) would see race conditions on shared state.

### Authentication & authorisation

**None implemented.** No session, no JWT, no API keys. All endpoints are fully open. `author` fields on messages/events are free-text strings passed by the client.

### Pagination

Implemented on: `port_locations`, `commodities`, `unlocodes`, `customers`, `sanctions_entries`.  
Not implemented on: `shipments`, `containers`, `cost_lines`, `tickets`, `allocations`. These return full table scans.

### Data integrity

No foreign-key constraints are enforced (SQLite FK pragma is not enabled). Referential integrity is maintained solely by application logic. Orphaned records (e.g. containers after shipment delete) accumulate silently.

---

## 11. Known Debts & Improvement Opportunities

### Critical

| # | Issue | Impact | Suggested Fix |
|---|---|---|---|
| C1 | **No transactions** on multi-step writes (import-contract, batch deletes) | Data corruption on crash | Wrap in `db.exec('BEGIN')` / `COMMIT` / `ROLLBACK` |
| C2 | **No authentication** — all 110 endpoints are unauthenticated | Full data exposure | Add JWT middleware; role-based access (ops / compliance / read-only) |
| C3 | **No FK constraints** (`PRAGMA foreign_keys = ON` never set) | Silent orphaned rows | Enable pragma + add FK definitions to schema |
| C4 | **`server.js` is a 2,241-line monolith** | Merge conflicts, testability | Split into domain routers: `routes/shipments.js`, `routes/contracts.js`, etc. |
| C5 | **No test suite** | Regressions ship silently | Add Vitest for unit tests; Supertest for route integration tests |

### High

| # | Issue | Impact | Suggested Fix |
|---|---|---|---|
| H1 | **ShipmentDetailPage.jsx is 2,635 lines** | Cognitive load, slow HMR | Extract `CostControl`, `CostLineHistoryModal`, `CompactHistory`, `ContainersCard`, `ContractCard` into their own files |
| H2 | **No migration framework** — migrations are a bare try/catch array | Silent failures, no rollback, no versioning | Adopt `node-sqlite-migrations` or a hand-rolled version table |
| H3 | **Full table scans on shipments/tickets/cost-lines** — no pagination | Will degrade at ~1,000+ rows | Add `LIMIT/OFFSET` to list endpoints; add indexes on `shipment_id`, `status`, `carrier_code` |
| H4 | **JSON stored in columns** (`container_types`, `imdg_classes`) | Cannot query/index; no schema validation | Normalise to junction tables or use SQLite JSON functions with generated columns |
| H5 | **No SQLite indexes** beyond primary keys | Query degradation at scale | Add indexes: `shipment_cost_lines(shipment_id)`, `entity_events(entity_type, entity_id)`, `shipment_events(shipment_id)`, `sanctions_entries(entity_name_norm)` |
| H6 | **Hash-based routing (manual)** | No browser back/forward, no deep-link bookmarking, no `<Link>` | Migrate to React Router v6 with `createBrowserRouter` |

### Medium

| # | Issue | Impact | Suggested Fix |
|---|---|---|---|
| M1 | **No production process manager** | Crashes are unrecovered | Add PM2 or systemd unit; define `NODE_ENV` |
| M2 | **Inline styles throughout** — no CSS | No style reuse, large component payloads, no responsive media queries | Move shared layout patterns to a minimal CSS file; keep tokens for colours |
| M3 | **`applyTheme()` mutates `T` globally** | Re-renders can be inconsistent; hard to test | Replace with React context (`ThemeContext`) |
| M4 | **FX rates fetched on demand with no caching** | Repeated external calls on every cost-line add | Cache in `app_settings` or an in-memory map with a 1-hour TTL |
| M5 | **`entity_events` queried via `json_extract(meta, '$.shipmentId')`** | No index on JSON field; full scan as events grow | Add a `shipment_id TEXT` column to `entity_events` + index; populate on insert |
| M6 | **Denormalised party names** (`shipper_name`, `consignee_name`, `principal_name`) stored on every shipment | Name changes on customer record don't propagate | Store only the FK; join at query time (or snapshot deliberately and document) |
| M7 | **`status_log` table kept for compatibility** | Dead code, misleading | Remove or document it as deprecated; consolidate into `shipment_events` |
| M8 | **WebSocket clients are never cleaned up** | Memory leak on long-running server | Remove dead sockets on `close`/`error`; periodic pruning |

### Low / Enhancement

| # | Opportunity |
|---|---|
| L1 | Add `Content-Security-Policy`, `X-Frame-Options`, `Referrer-Policy` headers (express-helmet) |
| L2 | Add a `db.pragma('wal_mode = WAL')` for better concurrent read performance |
| L3 | Replace manual `uid()` with `crypto.randomUUID()` (available since Node 15) |
| L4 | Extract `SERVICE_CODE_MAP` and `TRACKED_FIELDS` constants to a shared config file |
| L5 | Add `OpenAPI / Swagger` spec — 110 routes with no documentation |
| L6 | Add a `version` column to the `app_settings` table for migration tracking |
| L7 | Containerise with Docker for reproducible deployment |
| L8 | Add a `GET /api/shipments/:id/cost-lines/validate` endpoint (orphaned / missing lines) — already designed in backlog ticket TKT-1X8R29 |

---

## Appendix A — Codebase Metrics

| File | Lines | Role |
|---|---|---|
| `server.js` | 2,241 | Entire backend |
| `src/pages/ShipmentDetailPage.jsx` | 2,635 | Shipment detail UI |
| `src/pages/DashboardPage.jsx` | 2,052 | Dashboard + Contract Consumption |
| `src/App.jsx` | 1,022 | Root routing + nav |
| `src/pages/SpaceConfigurationsPage.jsx` | 920 | Space configs CRUD |
| `src/pages/KanbanPage.jsx` | 838 | Kanban board |
| `src/pages/AppSettingsPage.jsx` | 550 | Feature toggles |
| `src/pages/ShipmentsPage.jsx` | 588 | Shipment list |
| `src/tokens.js` | 278 | Design system |
| `src/api.js` | 182 | API client |

**Total source files:** ~40 JSX/JS files  
**Total DB tables:** 28  
**Total API routes:** 110  
**Seed data:** 14,269 port locations · 349 vessels · 294 commodities · 69 carriers · 211 countries

---

## Appendix B — Sequence: Edit a Cost Line (full trace)

```
User edits amount in CostLineForm  →  clicks Save
        │
        ▼
CostControl.handleSave(data)
  await api.costLines.update(lineId, data)
        │
        ▼
PUT /api/cost-lines/:id
  SELECT existing row
  UPDATE SET amount=?, ..., modified_at=now()
  for each changed field:
    logEntityEvent('cost_line', id, 'UPDATED', field, oldV, newV, meta)
  return mapCostLine(updated row)   ← includes source, modifiedAt
        │
        ▼
setLineModal(null)
load()  →  GET /api/shipments/:id/cost-lines  →  setLines(fresh)
        │
        ▼
Re-render:
  sourceInfo(l) → source='contract', modifiedAt≠null → "Contract (Modified)" amber pill
  renderTableRow → Source column shows new pill
  Summary bar    → updated totals
```

---

*Document generated from live codebase — CargoDesk v0.17.1 "Sentry"*  
*Next scheduled review: on release of v0.18.0*
