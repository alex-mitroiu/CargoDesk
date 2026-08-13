# CargoDesk — Architecture Reference
**Version:** 0.69.0 "Custodian" · **Date:** 2026-08-13
**Audience:** Software architects, senior engineers, technical reviewers

> This document was refreshed from a full pass against the live codebase on 2026-08-13,
> replacing a version that had gone stale (§1–11 hadn't been touched since v0.30.0 — 39
> releases behind). Every figure below (line counts, table counts, route counts) was measured
> directly, not carried over. See `CLAUDE.md`'s own "Recent changes" sections for a
> release-by-release changelog this document doesn't restate — treat that file as the
> day-to-day source of truth and this one as the standing structural reference.
>
> A companion visual diagram, `dev/architecture.html`, is dated v0.20.0 (2026-07-03) and was
> **not** refreshed as part of this pass — it's now 49 releases behind and should be treated as
> a historical snapshot, not a current reference, until someone rebuilds it.

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
12. [Runtime Lifecycle Audit](#12-runtime-lifecycle-audit)
13. [SQLite vs Postgres — Design Doc](#13-sqlite-vs-postgres--design-doc)
14. [Auto-Trigger Registry](#14-auto-trigger-registry)
- [Appendix A — Codebase Metrics](#appendix-a--codebase-metrics-measured-directly-2026-08-13)

---

## 1. System Overview

CargoDesk is a **single-tenant freight operations management system** for a freight forwarding
desk. It now covers the full commercial lifecycle of a sea-freight shipment, not just execution:
quoting, booking, container management, operational accounting (buy/sell cost lines with
carrier-invoice reconciliation), space configuration against carrier contracts, multi-list
compliance screening, customs filing, and integration tracking — plus an AI assistant that can
answer questions about any of it and extract structured data from uploaded documents.

### Bounded contexts (logical domains)

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                                 CargoDesk                                      │
│                                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │  Pre-Booking  │  │  Shipments   │  │  Commercial  │  │    Master Data     │ │
│  │               │  │  & Cargo     │  │  (Contracts  │  │  (Ports · Carriers │ │
│  │  Quotes       │  │              │  │   + Rates)   │  │   Vessels ·        │ │
│  │  (Draft→Sent  │  │  Shipments   │  │              │  │   Countries ·      │ │
│  │  →Accepted→   │  │  Containers  │  │  Contracts   │  │   Trade Lanes ·    │ │
│  │  Converted)   │  │  Cost Lines  │  │  Allocations │  │   Commodities ·    │ │
│  │               │  │  Parties     │  │              │  │   Charge Codes ·   │ │
│  │               │  │  Milestones  │  │              │  │   Pack Types)      │ │
│  └──────┬────────┘  └──────┬───────┘  └──────┬───────┘  └─────────┬──────────┘ │
│         │                  │                  │                    │           │
│  ┌──────▼────────┐  ┌──────▼───────┐  ┌──────▼───────┐  ┌─────────▼──────────┐ │
│  │  Compliance   │  │  Freight     │  │  Operations  │  │      Platform       │ │
│  │               │  │  Audit       │  │              │  │                     │ │
│  │  12-list      │  │              │  │  Kanban /    │  │  App Settings ·     │ │
│  │  sanctions    │  │  Carrier     │  │  Integration │  │  Feature Toggles ·  │ │
│  │  screening    │  │  invoice     │  │  Board · Test│  │  System Msgs ·      │ │
│  │  (OFAC + CSL) │  │  reconcile · │  │  Plans/Runs  │  │  FX Rates ·         │ │
│  │  Customs      │  │  D&D pre-    │  │              │  │  WebSocket ·        │ │
│  │  filing       │  │  audit       │  │              │  │  AI Agent           │ │
│  └───────────────┘  └──────────────┘  └──────────────┘  └─────────────────────┘ │
└───────────────────────────────────────────────────────────────────────────────┘
```

Three of these bounded contexts — **Document Distribution**, **PDF Rendering**, and **Contract
Management** — have been extracted into their own standalone services (§3, §8.1). Everything
else still lives in the monolith.

---

## 2. Tech Stack

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Frontend framework | React | 18.2 | Functional components, hooks only |
| Frontend build | Vite | 5.2 | HMR in dev, ESBuild in prod |
| Styling | Inline styles | — | No CSS files; design token object `T` (`src/tokens.js`) |
| Charts | Recharts | 2.12 | Dashboard + Space Configs charts |
| Backend runtime | Node.js | ≥ 22.5 | Required for `node:sqlite` |
| Backend framework | Express | 4.18 | Monolith + all 3 microservices |
| Database | SQLite (`node:sqlite`) | built-in | `DatabaseSync` — sync API, no ORM; `PRAGMA foreign_keys=ON` |
| Real-time | `ws` | 8.21 | WebSocket server on shared HTTP; per-shipment subscription model (§8.7) |
| PDF generation | Puppeteer (`puppeteer-core`) | — | Isolated in the `pdf-render` microservice, not the monolith |
| Backend testing | Node's built-in test runner (`node:assert`-style scripts) | — | 36 files, `npm test` |
| Frontend testing | Vitest + Testing Library | — | `npm run test:frontend`, 2 files |
| CI | GitHub Actions | — | `.github/workflows/ci.yml` — frontend tests, backend tests + build, all in parallel jobs |
| Containerization | Docker + Docker Compose | — | `Dockerfile` per process (monolith + 3 services), `docker-compose.yml` wires them together |
| Dev tooling | `concurrently` | 8.2 | Runs monolith + Vite + all 3 microservices in parallel (`npm run dev`) |

**Still true:** no TypeScript, no CSS framework, no ORM, no migration framework, no message
queue. **No longer true (as of this pass):** "no test framework" — both a backend and a frontend
suite now exist; "no containerization" — Docker artifacts exist for every process.

---

## 3. Process & Deployment Topology

### Development

```
Developer machine
│
├─ npm run dev  (via `concurrently`)
│  ├─ node server.js                              → :3001  (Express + SQLite + WebSocket)
│  ├─ vite                                         → :5173  (React dev server + HMR)
│  ├─ node services/document-distribution/server.js → :3002
│  ├─ node services/pdf-render/server.js            → :3003
│  └─ node services/contract-management/server.js   → :3004
│         │
│         └─ Vite proxies /api and /ws → :3001 (monolith only — the browser never talks
│            directly to any of the three microservices)
│
├─ cargodesk.db                (monolith's own file, co-located with server.js)
├─ services/document-distribution/*.db
├─ services/pdf-render/            (stateless — no database)
└─ services/contract-management/*.db   (only holds live data when contract_source='remote', §8.1)
```

The monolith calls each microservice over plain HTTP, gated by a shared static secret per
service (`DISTRIBUTION_SERVICE_SECRET`, `PDF_RENDER_SERVICE_SECRET`, `CONTRACT_SERVICE_SECRET`)
read via `lib/dockerSecret.js` (env var, or a `_FILE`-suffixed path for Docker/Compose secrets).
Every monolith→service call follows the same shape: a short timeout (10s), and a clean `503` back
to the caller if the service is unreachable — never a hang, a 500, or a crash.

### Production build

```
vite build  →  dist/
                ├─ index.html
                └─ assets/  (hashed JS + CSS bundles)

NODE_ENV=production node server.js
  ├─ app.use(express.static('dist'))   → serves built frontend
  ├─ SPA fallback (all non-/api routes → index.html)
  ├─ app.use('/api/...')               → REST endpoints
  └─ WebSocketServer on same httpServer
```

### Docker / Compose

`docker-compose.yml` wires all four processes (monolith + 3 microservices) together, with the
service-to-service secrets passed as Compose secrets rather than plain env vars. Each process has
its own `Dockerfile`. This is a first draft — not yet exercised against a real orchestrator
(Kubernetes, ECS, etc.) — but it replaces the previous "no container runtime, single-host only"
state entirely; a production deployment path now genuinely exists, even if unproven at scale.

---

## 4. Frontend Architecture

### Module map

The frontend has grown to **127 JS/JSX files** (excluding tests) — nearly double the ~70 files
this doc last counted.

```
src/
├─ App.jsx                (4,082 lines)  Root: routing, nav, auth guards, role switcher, theme
├─ api.js                              All fetch wrappers — single source of truth
├─ tokens.js                           Design tokens T{}, theme, route helpers
├─ AuthContext.jsx                     createContext + useAuth() hook
├─ toast.js                            Pub-sub toast emitter
├─ version.js                          VERSION, CODENAME, CHANGELOG
├─ shipmentSections.js                 Shared config for the promoted shipment sub-pages —
│                                        closes the old "two hand-synced files" gap (§11, was M9)
├─ shipmentServicePages.js             Config for the generic/loading/VGM service sub-pages
├─ cargoValueBus.js / servicesBus.js / saving.js / navigationGuard.js
│                                      Small pub-sub/utility modules (cargo-value recompute
│                                      notifications, unsaved-changes guard on nav, etc.)
│
├─ pages/                              22 top-level pages, plus 3 sub-directories
│   ├─ LoginPage.jsx / ForgotPasswordPage.jsx / ResetPasswordPage.jsx / LicensePage.jsx
│   ├─ LandingPage.jsx                 Home — clock, weather, fleet KPIs, currency converter
│   ├─ QuotesPage.jsx                  Quote list + New Quote modal + lifecycle detail (v0.69.0)
│   ├─ FreightAuditPage.jsx            Carrier invoice reconciliation (v0.69.0)
│   ├─ DashboardPage.jsx               Space-allocation consumption + Contract Consumption tabs
│   ├─ SpaceConfigurationsPage.jsx / DashboardArchivePage.jsx
│   ├─ KanbanPage.jsx                  Kanban board — Epic/Story/sub-task nesting, WIP limits
│   ├─ TestPlansPage.jsx / TestRunsPage.jsx / TestCasesPage.jsx / TestToolsPage.jsx
│   ├─ SchedulesPage.jsx / RateBenchmarkPage.jsx / TrackingPage.jsx / ReleasesPage.jsx
│   ├─ AppSettingsPage.jsx             Feature toggles, external APIs, user management
│   ├─ AboutPage.jsx / UserManualPage.jsx
│   │
│   ├─ shipments/  (21 files)          Promoted sub-pages replacing the old anchor-scroll
│   │                                  ShipmentDetailPage (see §8.9 — this resolved the old
│   │                                  "no shared source of truth for sections" debt)
│   │   ├─ ShipmentDetailPage.jsx (2,811 lines)   Now the Overview anchor page only
│   │   ├─ ShipmentFormPage.jsx                   New + edit form
│   │   ├─ ShipmentContainersPage.jsx / ShipmentPartiesPage.jsx / ShipmentSchedulesPage.jsx
│   │   ├─ ShipmentMilestonesPage.jsx / ShipmentConditionsPage.jsx / ShipmentHistoryPage.jsx
│   │   ├─ ShipmentCarrierBooking{Page,DetailsPage,ReviewPage}.jsx
│   │   ├─ ShipmentCustomsFiling{Page,DetailsPage,ReviewPage}.jsx
│   │   ├─ ShipmentAccounting{Costs,Invoices,Gp}Page.jsx
│   │   └─ GenericServicePage.jsx / LoadingServicePage.jsx / VgmServicePage.jsx
│   │
│   ├─ mdm/  (15 files)                Master data management CRUD pages
│   └─ org/  (3 files)                 Branches, Countries, Offices (organization structure)
│
└─ components/
    ├─ primitives/  (13 files)         Btn, Modal, Form, Badge, Spinner, DatePicker, Pagination, …
    └─ shared/  (30 files)             PortCombobox, CarrierCombobox, CustomerCombobox,
                                       CommodityCombobox, VesselCombobox, EntityHistoryModal,
                                       UserManagementPanel, …
```

### Routing

Still **hash-based** (`window.location.hash`), still no React Router — unchanged from the last
review. Sub-pages that need a parent+child shape (Accounting, Carrier Booking, Customs Filing)
use a two-segment hash (`shipments/:id/accounting/:child`); flat promoted sub-pages use one
segment (`shipments/:id/containers`). The mapping lives in `shipmentSections.js`, imported by
both `App.jsx` and every page that needs to build a link — this is the fix for the old "two
hand-synced files" debt (§11).

### State management

Still no global state library. The shape is unchanged in kind, larger in scope:

```
App.jsx
  │
  ├─ appSettings (object)          ← GET /api/settings on mount + nav-away reload
  ├─ shipments (array)             ← fetched once, patched locally on create/update
  │    (every write path that creates/updates a shipment — including quote conversion,
  │     §8.5 — must push the result into this array, or the detail page renders blank
  │     for a shipment the SPA doesn't yet know about; this bit a real bug during the
  │     Quoting feature's own CDP verification, since fixed)
  ├─ theme (isDark bool)           ← localStorage
  ├─ isEnabled(module) helper      ← gates nav items + renders a locked fallback page
  │
  └─ per-page local state via useState / useEffect
       └─ api.js fetch wrappers return plain JSON → setState
```

### Design token system

Unchanged in shape from the last review — `T.surface`, `T.bg`, `T.text`, `T.accent`, `T.head`,
`T.body`, `T.mono`, etc., all JavaScript strings applied via `style={{ ... }}`, mutated in place
by `applyTheme(isDark)`. No CSS variables.

---

## 5. Backend Architecture

### The monolith today: composition root, not a route dumping ground

`server.js` was **3,987 lines** at the point this doc was last (inaccurately) measured. It is now
**3,529 lines** — smaller despite the app having grown substantially, because route handling has
moved almost entirely into `routes/*.js`. `server.js`'s actual job today:

```
server.js  (3,529 lines)
│
├─ Imports & constants
├─ Database setup
│   ├─ DatabaseSync('./cargodesk.db')
│   ├─ 77 CREATE TABLE IF NOT EXISTS statements (§6)
│   ├─ ~100+ ALTER TABLE ADD COLUMN migrations (additive-only; SQLite has no
│   │   ADD COLUMN IF NOT EXISTS, so "duplicate column name" on every restart after
│   │   the first is expected and swallowed — anything else is a genuine failure,
│   │   surfaced via GET /api/health's migrations.failed count)
│   └─ 25 CREATE INDEX IF NOT EXISTS statements
│
├─ Startup routines
│   ├─ seedDefaultSettings() / seedDefaultAdmin()
│   ├─ backfillPortCountryCodes(), backfillCarrierBookings(), backfillSailingLegs(),
│   │   backfillTestItems() — one-time, idempotent, safe to re-run every restart (§14)
│   ├─ rebuildPortLanesMap()
│   └─ scheduleNextOfacSync() / scheduleNextCslSync()
│
├─ Shared runtime helpers, exposed to every route module via one `ctx` object:
│   uid(), ok()/err(), auth()/requireRole(), logEvent()/logEntityEvent(), getSettings(),
│   toUsd()/roundCents(), importContractRates(), createRateSnapshot(), syncShipmentFromLegs(),
│   screenShipmentById(), the ~13 auto-trigger functions (§14), callDistributionService(),
│   callPdfRenderService(), callContractService(), every map*() DTO function (lib/mappers.js),
│   and more — `ctx` is large (see `const ctx = { ... }` near the bottom of the file) and is the
│   actual "backend framework" every route module is written against.
│
├─ Express app
│   ├─ express.json({ limit: '25mb' })
│   ├─ cors()
│   └─ require('./routes/X')(app, ctx) — 25 calls, registering every route module (§7)
│
├─ WebSocket server
│   ├─ wss = new WebSocketServer({ server: httpServer })
│   ├─ shipmentSubs: Map<shipmentId, Set<ws>> — per-shipment subscription, not a blanket
│   │   broadcast-to-everyone model (§8.7 — this is a real change from the last review)
│   └─ connection handler (subscribe/unsubscribe messages, ping/pong heartbeat)
│
└─ httpServer.listen(3001)
```

### routes/ — 25 files, 8,290 lines

Each file is a factory function `module.exports = function xRoutes(app, ctx) { ... }`, called
once from `server.js` with the shared `ctx`. Roughly ordered by size:

```
routes/shipment-ops.js    1,250   Cost lines, milestones, documents, container events, services
routes/shipments.js         859   Core shipment CRUD, legs, routing-term engine
routes/auth.js               651   Login, users, password reset, RBAC role management
routes/export.js             623   CSV/Excel export (configurable field sets)
routes/contracts.js          615   Contract CRUD, matching, publish/withdraw, local/remote toggle
routes/customers.js          585   Customer CRUD, contacts, screening, documents, sanctions sync
routes/edi.js                426   Carrier booking EDI (request/response/confirm/supersede)
routes/mdm.js                380   Ports, carriers, vessels, trade lanes, countries, commodities
routes/ai.js                 371   AI chat (tool-calling) + document extraction (v0.69.0)
routes/carrier-invoices.js   320   Freight Audit & Payment matching engine (v0.69.0)
routes/system.js             280   Settings, system messages, contract-source toggle
routes/quotes.js             264   Quoting/RFQ lifecycle (v0.69.0)
routes/kanban.js             248   Tickets, ticket links, Kanban projects/columns
routes/organization.js       221   Branches, offices, org countries
routes/allocations.js        191   Space allocation CRUD + conflict detection
routes/document-distribution.js 169  Proxy to the Document Distribution service
routes/testcases.js          157   Test plans/runs/cases, ticket↔test-case links
routes/customs-filing.js     141   AES/EEI + ISF/AMS filing lifecycle
routes/offices.js            100   Office CRUD
routes/office-mail.js         96   Per-office SMTP settings
routes/share.js               92   Public read-only shipment-tracking share links
routes/finance.js             87   Margin/GP aggregation
routes/ais.js                 85   AIS listener status + manual controls
routes/pack-types.js          40   Pack type definitions (cargo manifest tree)
routes/charge-codes.js        39   Charge code registry
```

### lib/ — shared, non-route modules

`ais-listener.js` (its own runtime lifecycle, §12), `mappers.js` (every `map*()` DTO function,
factored out for reuse across route modules), `pdf-signing.js` (cert lookup + cryptographic
signing — calls out to the PDF Render service for the actual rendering, §8.1), `mailer.js`,
`rateLimit.js` (the `createRateLimiter` factory every route module's rate limiters are built
from), `shareToken.js`, `dockerSecret.js` (env var / Docker secret file resolution, shared by
every service-to-service auth check).

### Request lifecycle

Unchanged in shape from the last review — synchronous `DatabaseSync` access throughout, no
connection pool, no async query layer. What **has** changed: transactions now exist for
multi-statement writes that need them (§10, §11 — this resolves the old "no transactions" debt),
and 25 indexes now exist beyond primary keys (§11 — this resolves the old "no indexes" debt).

---

## 6. Data Model

**77 tables** in the monolith's own `cargodesk.db` (up from the 35–54 this doc previously and
inconsistently claimed), plus the Contract Management service's own 4-table copy
(`contracts`/`contract_legs`/`contract_rates`/`contract_routings`) when `contract_source='remote'`
(§8.1) — never both populated as the live source at once.

### Domain groupings (representative, not exhaustive — see server.js for the authoritative list)

```
PRE-BOOKING
───────────
quotes ──── quote_lines                    (Draft→Sent→Accepted/Declined/Expired→Converted)
    └── converted_shipment_id → shipments  (set only once, on conversion)

SHIPMENTS & CARGO
─────────────────
shipments ──┬── shipment_legs               (multimodal leg records)
            ├── containers ──┬── container_events    (Empty Pickup → … → Empty Return)
            │                └── container_packages   (cargo manifest tree — pallets/boxes/crates)
            ├── shipment_parties             (Flexible Party Model — shipper/consignee/notify/
            │                                 principal + 11 additional roles, e.g. Forwarder,
            │                                 Customs Broker (Export/Import), Line Agent)
            ├── shipment_cost_lines          (BUY/SELL, accrued→actualized→posted state machine)
            ├── shipment_milestones          (per-step timeline, soft out-of-order warning)
            ├── shipment_documents           (generated + signed PDFs, readiness tracking)
            ├── shipment_schedules           (applied sailings)
            ├── shipment_events / entity_events   (two-table audit strategy, §10)
            ├── shipment_messages            (threaded notes)
            ├── shipment_screenings          (sanctions-screening results)
            └── edi_messages / carrier_bookings / carrier_booking_archive
                                             (booking request/response log + supersede history)

FREIGHT AUDIT & PAYMENT
───────────────────────
carrier_invoices ──── carrier_invoice_lines  (reconciled against accrued cost lines / contract
                                               rates / an independent D&D pre-audit)

CUSTOMS
───────
customs_filings                              (AES/EEI export, ISF/AMS import)

COMMERCIAL
──────────
contracts ──┬── contract_legs
            ├── contract_rates
            └── contract_routings                    (named multi-routing per contract)
allocations                                          (space vs. TEU consumption)

COMPLIANCE
──────────
sanctions_entries ──── sanctions_syncs        (OFAC SDN + 11 more Consolidated Screening List
                                                sources, one generic `source` column, §8.4)

MASTER DATA
───────────
carriers · carrier_agents · vessels · port_locations ── linked_ports
regions ── countries ── country_trade_lanes · trade_lanes ── allocations
commodities · charge_code_definitions · pack_type_definitions

CUSTOMERS / ORGANIZATION
────────────────────────
customers ──┬── customer_contacts
            ├── customer_identifiers
            ├── customer_documents
            ├── customer_roles
            └── customer_screenings
branches · offices · office_mail_settings · org_countries · org_signing_certs

OPERATIONS
──────────
tickets ──── ticket_links            (Kanban; Epic→Story→sub-task nesting)
kb_projects ── kb_versions · kb_columns
test_items ──── test_case_links      (dedicated test-case repository)

PLATFORM
────────
users · app_settings · system_messages · system_email_settings
user_access_configs · user_scope_items · user_offices
admin_events
```

### ID format

Unchanged convention — `uid()` generates 6 upper-hex characters, prefixed by entity type
(`SHP-`, `CTR-`, `CL-`, `QT-`/`QTL-`, `CINV-`/`CINL-`, `CUS-`, `TKT-`, `EDI-`, `CEV-`, …). New
prefixes since the last review: `QT-`/`QTL-` (quotes), `CINV-`/`CINL-` (carrier invoices).

---

## 7. API Layer

Route counts are no longer usefully summarized as a flat table the way the last review did it —
with 25 separate route modules (§5), the file list above **is** the resource-group breakdown.
Every endpoint still returns `{ data }` on success (via the shared `ok()` helper) or `{ error }`
on failure (via `err()`).

### Naming inconsistency (still true)

Cost-line routes are still split between shipment-scoped (`/api/shipments/:id/cost-lines`) and
line-scoped (`/api/cost-lines/:id`). Not fixed in this pass; low priority, cosmetic.

### Cross-service proxying

Three route modules exist specifically to proxy the monolith's own `/api/*` surface to a
standalone microservice when a settings toggle says to: `routes/document-distribution.js`
(always remote — that service has no "local" mode), `routes/contracts.js` (branches on
`contract_source`, §8.1), and `lib/pdf-signing.js` (not a route module, but the same pattern —
`renderHtmlToPdf()` calls the PDF Render service internally, transparent to every caller).

---

## 8. Key Subsystems

### 8.1 Standalone Microservices

Three pieces of the monolith have been extracted into their own Express processes, each for a
different reason:

| Service | Port | Extracted because | Data ownership |
|---|---|---|---|
| **Document Distribution** (`services/document-distribution/`, v0.64.0) | 3002 | Outbound document delivery (email/webhook) has its own retry/failure profile, distinct from request/response HTTP | Owns its own `.db` — webhook configs, delivery attempts |
| **PDF Render** (`services/pdf-render/`, v0.65.1) | 3003 | The heaviest, most bursty thing the monolith did per-request (a full headless-Chromium launch) — see §12 for the full reasoning | Stateless — no database at all |
| **Contract Management** (`services/contract-management/`, v0.68.0) | 3004 | First real "toggle between local and remote" extraction — proves the pattern before Epic 5 (Customer/Organization) needs it | Owns its own `.db`, a straight port of `contracts`/`contract_legs`/`contract_rates`/`contract_routings` |

The Contract Management extraction is the most architecturally interesting of the three because,
unlike the other two, **the monolith's own local tables are never deleted or bypassed** —
`app_settings.contract_source` (`'local'` default, or `'remote'`) is a per-request toggle read via
`getSettings()`. Every place that touches contract data — `routes/contracts.js`'s own endpoints,
`routes/allocations.js`'s match logic, `server.js`'s `createRateSnapshot`/`importContractRates`,
`routes/carrier-invoices.js`'s matching engine — branches on this same toggle. Flipping it is a
one-way cutover lever (§13's design doc covers why this isn't a live bidirectional sync), not
something to flip back and forth casually in production. A CLI migration script
(`scripts/migrate-contracts-to-service.js`) moves existing local data across; nothing does this
automatically.

### 8.2 Quoting / RFQ (added v0.69.0)

```
quotes (Draft → Sent → Accepted | Declined | Expired → Converted)
  └── quote_lines[]  (the customer-facing SELL price — independent of any contract rate)

Pricing reference: GET /api/contracts/match (unchanged, reused as-is) — lets the person building
a quote pull a contract's own rates as a starting point, then adjust for margin before saving.
The quote's own lines are what gets quoted; the contract rate is never silently substituted.

Conversion (POST /api/quotes/:id/convert, Accepted only):
  1. INSERT shipments — only the columns the quote actually has values for; every other
     column (etd, vessel, booking_ref, …) falls back to its own table-level DEFAULT, same as
     an omitted field on a direct POST /api/shipments would.
  2. maybeAssignLineAgents(), then importContractRates() if the quote carried a contractId —
     same BUY-side path a direct shipment creation already uses, unchanged.
  3. Each quote_line becomes a new SELL-side shipment_cost_line, source='quote' — kept
     independent of whatever the live contract rate says, since the quoted price commonly
     already includes a margin.
  4. screenShipmentById() — a quote-converted shipment gets the same silent compliance
     screening a directly-created one would.
  5. Response includes the full mapped shipment object, not just its id — the frontend's
     local `shipments` array (§4) needs the real record before it can navigate to a detail
     page the SPA doesn't otherwise know about yet.

An hourly sweep (expireStaleQuotes(), mirrors expireStaleContracts()) flips a Sent quote whose
valid_until has passed to Expired.
```

### 8.3 Freight Audit & Payment (added v0.69.0)

```
A carrier's own submitted invoice (carrier_invoices/carrier_invoice_lines) is reconciled
against what was actually agreed — NOT the same thing as shipment_cost_lines' own
accrued→actualized→posted maturity (that tracks CargoDesk's own estimate; this validates an
external document against it).

Matching priority per line:
  1. An already-accrued BUY cost line for the same charge code (what was actually quoted/
     booked at the time) — preferred over the live contract rate, which can have moved since.
  2. The live contract rate (via the same contract_source-aware helper §8.1 describes).
  3. For Detention/Demurrage lines specifically: independently computed from the container's
     own free-time window (containers.origin_free_time_days/dest_free_time_days +
     container_events timeline) — the D&D pre-audit — checked BEFORE ever comparing to what
     the carrier billed.

variance = amount - expected; flagged 'variance' (vs. 'matched') beyond a configurable
tolerance (app_settings.fap_variance_tolerance_pct, default 2%). Approving a matched line
actualizes the existing cost line in place; approving an unmatched line creates a new one
directly as actualized, source='carrier_invoice'.
```

### 8.4 Compliance Screening — OFAC SDN + Consolidated Screening List

Extended in v0.69.0 from OFAC-SDN-only to the full US Consolidated Screening List (12 source
lists total — OFAC's SDN plus 11 more: BIS Denied/Entity/Unverified/Military End User lists,
State Dept ITAR Debarred + Nonproliferation Sanctions, and 5 more OFAC-family lists).
`sanctions_entries.source`/`sanctions_syncs.source` were already fully generic columns before
this — the extension was purely a new sync function (`syncConsolidatedScreeningList()`,
structurally mirroring the pre-existing `syncOfacSdn()`), not a schema change. Screening logic,
hit display, and the override flow are all unchanged — they already threaded `source` through
generically.

### 8.5 Operational Accounting (Cost Lines)

Unchanged in shape from the last review — `importContractRates()` still turns contract rates into
BUY cost lines (aggregate or split-per-container), `source='contract'` lines are replaced on
recalculate while `source='manual'` lines are always preserved. New `source` values since the
last review: `'quote'` (§8.2) and `'carrier_invoice'` (§8.3). New states beyond the original
`contract`/`manual` split: an `accrued → actualized → posted` status lifecycle per line (a
posted line is locked; corrections are new adjusting lines, never rewrites) with a computed
variance (`actual - accrued`) once a line is actualized.

### 8.6 Space Configurations & TEU Accounting

Unchanged from the last review.

### 8.7 WebSocket — per-shipment subscription, not blanket broadcast

This is a genuine change from the last review, which described a single `broadcast(type,
payload)` reaching every connected client. The actual model:

```
shipmentSubs: Map<shipmentId, Set<WebSocket>>   (server.js, shared via ctx)

Client subscribes to one specific shipment (sent while its detail page is open); server adds
the socket to that shipment's Set. Any route module can push to just that shipment's viewers:

  broadcastMessage(shipmentId, payload)     → { type: "new_message", ... }        (server.js)
  recomputeSpaceBadge(shipmentId)           → { type: "space_badge_update", ... } (server.js)
  routes/edi.js's own broadcast(id, frame)  → { type: "new_edi_message", ... } /
                                               { type: "booking_status_changed", ... }

A client not viewing that shipment never receives its updates — this scales with concurrently
open shipment-detail pages, not with total data volume.
```

### 8.8 Feature Toggles (App Settings)

Same `app_settings` key-value shape as before. Grown substantially in count — every new
subsystem in this document added its own settings (`fap_variance_tolerance_pct`,
`api_csl_enabled`/`api_csl_interval_*`, `contract_source`, `ai_agent_enabled`/`ai_endpoint`/
`ai_model`/`ai_api_key`, and more) — no longer enumerable as a short table the way the last
review did it. `isEnabled(module)` in `App.jsx` still reads from `appSettings` state the same way.

### 8.9 Authentication & RBAC

The role hierarchy has grown from 3 roles to 5: `VALID_ROLES = ["admin", "operator", "occ_bk",
"trade_manager", "viewer"]` (`server.js`). `occ_bk` and `trade_manager` are newer, narrower roles
— most route-level `requireRole([...])` guards now list a specific subset (e.g.
`["admin","operator","occ_bk"]` for most day-to-day writes) rather than a single linear rank
check. A user can hold multiple roles (`users.roles`, JSON array); `primaryRoleSV()` picks the
highest-ranked one where a single role is needed. JWT mechanics (8-hour token, `cargodesk_token`
in `localStorage`, `auth()` middleware) are unchanged.

### 8.10 Multimodal Legs & Routing Term Engine

Unchanged from the last review.

### 8.11 ShipmentDetailPage — Section Navigation (resolved)

The old debt this section used to describe — anchor-scroll sections with no shared source of
truth between `App.jsx` and `ShipmentDetailPage.jsx` — is resolved. `ShipmentDetailPage.jsx` is
now 2,811 lines (down from 4,275) and hosts only the Overview anchor page; every other section
(Cargo, Parties & Offices, Contracts & Schedules, Milestones & Events, Documents, Accounting,
Carrier Booking, Customs Filing, History) is a real, independently-routed page under
`src/pages/shipments/`, with the hash-routing table centralized in `shipmentSections.js` (§4) —
imported by both files instead of hand-duplicated.

### 8.12 EDI Messaging & Carrier Booking Lifecycle

Substantially more complete than the last review's "v1, demoable" framing. `carrier_bookings` /
`carrier_booking_archive` now model a real state machine: a booking created via
`ensureBookingCreated()` once both a contract and a schedule exist (§14); a carrier-change on an
unconfirmed booking triggers `supersedeIfCarrierChanged()`, which archives the old booking (full
history preserved, an auto-cancellation EDI message sent to the old carrier if it was still
Pending) and starts a fresh one — a **confirmed** booking is never silently rewritten, only ever
archived-and-superseded before confirmation. `BOOKABLE_CARRIERS` today: MAEU, SAFM, MCPU.

### 8.13 AI Agent (added v0.68.0–v0.69.0)

```
routes/ai.js — provider-agnostic: isAnthropicEndpoint(endpoint) branches between Anthropic's
Messages API shape and an OpenAI-compatible Chat Completions shape (covers OpenRouter, any
local/self-hosted OpenAI-compatible server). Two capabilities:

  POST /api/ai/chat              Tool-calling loop (max 3 iterations) — get_shipment,
                                  list_shipments, get_contract, get_allocation tools, all
                                  executed server-side against the real database.

  POST /api/ai/extract-document  Single-shot vision call (v0.69.0) — image (both providers) or
                                  PDF (Anthropic only — no native PDF support in the
                                  OpenAI-compatible shape) in, structured JSON out. Deliberately
                                  generic, not carrier-invoice-specific, so future extraction
                                  features (e.g. commercial invoice → cargo packages) can reuse
                                  it rather than duplicating provider-branching logic.

Both gated by app_settings.ai_agent_enabled + a configured endpoint/model/key; both have their
own rate limiter (aiChatRateLimit / aiExtractRateLimit, tighter for the extraction endpoint
since a vision payload is meaningfully more expensive per call).
```

---

## 9. Data Flow Diagrams

The four diagrams in this section (shipment creation with auto-screening; contract recalculation;
OFAC sync scheduling; feature toggle gating) remain conceptually accurate and are not reproduced
again here — see the previous revision of this document (available in version control) for the
exact sequences. One addition:

### 9.1 Quote → Shipment conversion (new, v0.69.0)

```
User clicks "Convert to Shipment" on an Accepted quote
        │
        ▼
POST /api/quotes/:id/convert
        │
        ├─ INSERT shipments (only the columns the quote has values for)
        ├─ maybeAssignLineAgents() + importContractRates() if contractId set  (BUY side)
        ├─ for each quote_line: INSERT shipment_cost_lines (SELL side, source='quote')
        ├─ screenShipmentById()
        └─ UPDATE quotes SET status='Converted', converted_shipment_id=?
        │
        ▼
Response { quote, shipmentId, shipment: <full mapped shipment>, screening }
        │
        ▼
Frontend: setShipments(p => [shipment, ...p])   ← must happen before navigate("detail", id),
          or the SPA has no local record to render the new shipment's detail page from (§4)
        │
        ▼
navigate("detail", shipmentId)
```

---

## 10. Cross-Cutting Concerns

### Error handling

Unchanged from the last review — `api.js`'s `req()` wrapper surfaces `error`/`message` from the
JSON body and fires `toast.error()` for 5xx; `err(res, msg, status)` on the backend, no global
Express error middleware, unhandled promise rejections still uncaught.

### Transactions

**No longer "none."** The last review's blanket claim was already wrong by the time it was
written and is definitely wrong now: `db.exec("BEGIN")`/`COMMIT`/`ROLLBACK` wraps multi-statement
writes in 6 places in `server.js` and 10 more across `routes/*.js` (contracts' leg/rate saves,
customer writes, MDM bulk operations, system settings, test-case migrations). Not
**every** multi-statement write is wrapped — this was addressed as a deliberate sweep (Kanban
epic, "wrap remaining multi-statement writes in transactions"), not a blanket guarantee for all
future code, so a new multi-step write path should still be evaluated on its own merits rather
than assumed to inherit this automatically.

### Concurrency

Unchanged — still none modelled; `DatabaseSync`'s single-threaded serialization is still the only
protection against races.

### Authentication & authorisation

RBAC role list grown from 3 to 5 roles (§8.9); mechanics otherwise unchanged.

### Pagination

**Still accurate.** Implemented on: `port_locations`, `commodities`, `unlocodes`, `customers`,
`sanctions_entries`, `shipment_events`. **Still not implemented** on the main list endpoints:
`shipments`, `containers`, `cost_lines`, `tickets`, `allocations`, `quotes`, `carrier_invoices`.
This is one of the few claims from the last review that held up unchanged — see §11/H3.

### Data integrity

**No longer accurate as stated.** The last review's own §11 table separately claimed this was
resolved, directly contradicting this section's blanket "no FK constraints are enforced" — that
internal contradiction is now fixed by checking directly: `PRAGMA foreign_keys=ON` is set
globally (`server.js` line 97) and real `REFERENCES` clauses exist throughout the schema (§6).
Referential integrity is genuinely enforced at the SQLite level, not just by application logic.

---

## 11. Known Debts & Improvement Opportunities

### Critical

| # | Issue | Status |
|---|---|---|
| ~~C1~~ | ~~No transactions on multi-step writes~~ | **RESOLVED** — see §10. Not exhaustive (a genuinely new multi-step write path isn't automatically covered), but the blanket "none" claim is false. |
| ~~C2~~ | ~~No authentication~~ | **RESOLVED v0.19.0** (unchanged from last review) |
| ~~C3~~ | ~~No FK constraints~~ | **RESOLVED** — confirmed directly this pass (§10); the last review's own §10/§11 contradicted each other on this exact point. |
| C4 | **`server.js`** — still the composition root (§5), now 3,529 lines. Route handling has moved almost entirely to `routes/*.js` (25 files, 8,290 lines) — a much better split than the last review credited, but the file is still large and still owns schema/migrations, shared runtime helpers, and `ctx` wiring in one place. | Splitting the migrations block into its own module remains a logged, not-yet-executed follow-up. |
| ~~C5~~ | ~~No test suite~~ | **RESOLVED, and grown further** — 36 backend test files (`npm test`), 2 frontend files (Vitest), both wired into CI (`.github/workflows/ci.yml`). |

### High

| # | Issue | Status |
|---|---|---|
| H1 | **`ShipmentDetailPage.jsx`** | **RESOLVED** — was 4,275 lines; now 2,811, with every section broken into its own routed page under `src/pages/shipments/` (§8.11). |
| H2 | **No migration framework** | Still true. Additive-only `ALTER TABLE` array in `server.js`, no version table, no rollback. |
| H3 | **No pagination on shipments/tickets/cost-lines** | Still true (§10) — now also true of `quotes` and `carrier_invoices`, both added without pagination. |
| H4 | **JSON stored in columns** (`container_types`, `imdg_classes`) | Still true. |
| ~~H5~~ | ~~No SQLite indexes beyond primary keys~~ | **RESOLVED** — 25 `CREATE INDEX IF NOT EXISTS` statements exist, covering the highest-traffic lookup columns (`shipment_cost_lines(shipment_id)`, `containers(shipment_id)`, `entity_events(entity_type, entity_id)`, `shipment_documents`, `shipment_parties`, and more). |
| H6 | **Hash-based routing (manual)** | Still true — no React Router adopted. |

### Medium

| # | Issue | Status |
|---|---|---|
| M1 | **No production process manager** | Partially addressed — Docker/Compose now exists (§3), which covers process supervision differently (container restart policies) than a PM2/systemd unit would, but neither is configured yet. |
| M2 | **Inline styles throughout** | Still true. |
| M3 | **`applyTheme()` mutates `T` globally** | Still true. |
| M4 | **FX rates fetched with no caching** | Not re-verified this pass. |
| M5 | **`entity_events` queried via `json_extract(meta, '$.shipmentId')`** | Not re-verified this pass — worth a direct check before trusting either way. |
| M6 | **Denormalised party names** on `shipments` | Still true, and now also true of `quotes.customer_name` and `carrier_invoices.carrier_code` following the same existing convention. |
| M7 | **`status_log` table kept for compatibility** | Not re-verified this pass. |
| M8 | **WebSocket clients never cleaned up** | Not re-verified this pass — the subscription model changed (§8.7) since the last review, so this needs a fresh look rather than being carried over. |
| ~~M9~~ | ~~ShipmentDetailPage section nav has no shared source of truth~~ | **RESOLVED** — see §8.11, `shipmentSections.js`. |
| ~~M10~~ | ~~Two unrelated "document" systems~~ | **RESOLVED v0.65.0** (unchanged from last review). |

### Low / Enhancement

| # | Opportunity | Status |
|---|---|---|
| L1 | Security headers (CSP, X-Frame-Options, Referrer-Policy) | Not re-verified this pass. |
| L2 | WAL mode for SQLite | Not re-verified this pass. |
| L3 | `crypto.randomUUID()` instead of manual `uid()` | Still using manual `uid()` — the 6-char ID format is now load-bearing in a lot of places (prefixes, display), so this is a bigger change than it looks. |
| L4 | Extract `SERVICE_CODE_MAP`/`TRACKED_FIELDS` to shared config | Not re-verified this pass. |
| L5 | OpenAPI/Swagger spec | Still true — no route documentation beyond this file and inline comments; now covering well over 200 routes across 25 files. |
| ~~L6~~ | ~~Version column on `app_settings`~~ | Not applicable — no migration framework exists to version against (see H2). |
| ~~L7~~ | ~~Containerise with Docker~~ | **RESOLVED** — Dockerfiles + `docker-compose.yml` exist for all 4 processes (§3). |
| L8 | Cost-line validation endpoint (orphaned/missing lines) | Not re-verified — check ticket TKT-1X8R29's current status before assuming either way. |
| **L9 (new)** | **`package.json`'s own `"version"` field reads `0.66.0`** while `src/version.js` (the actual source of truth for the in-app version badge and changelog) is at `0.69.0`. Cosmetic — nothing reads `package.json`'s version at runtime — but worth a fix next time either file is touched, since it's the kind of drift that erodes trust in version numbers generally. | Open |
| **L10 (new)** | **This document itself has no enforced freshness process.** It went 39 releases stale silently — nothing in CI or the release process checks it. If it's worth maintaining at all, it's worth a lightweight check (even just a version-number diff against `src/version.js` at release time) so the next drift is caught in weeks, not months. | Open — a process gap, not a code gap. |

---

## 12. Runtime Lifecycle Audit

*(Added v0.65.1, Epic TKT-AU8UA4 — unchanged from the last review; still accurate. Reproduced in
full in version control history. Summary: four runtime lifecycles share the monolith's one event
loop — the AIS WebSocket listener, the OFAC/CSL sync scheduler, the browser WebSocket broadcast,
and PDF rendering. PDF rendering was extracted (§8.1) as the one lifecycle where isolation was
the right fix, not just a nice-to-have; the other three remain in the monolith, each already
reasonably well-isolated in practice.)*

---

## 13. SQLite vs Postgres — Design Doc

*(Added v0.65.1, Epic TKT-FYVYGR — unchanged from the last review; still accurate as a design
doc. Summary: a Postgres migration is not recommended as a standalone effort. It's sequenced as
part of Epic 5 (Customer/Organization service extraction) — the first extraction that would
actually need cross-process concurrent writes to genuinely shared core data, which
`node:sqlite`'s `DatabaseSync` cannot support. The proof-of-concept (porting `system_messages`)
remains blocked on this environment having no Postgres instance to connect to — not skipped by
choice.)*

**Update since §13 was written:** the Contract Management extraction (§8.1, v0.68.0) shipped
using the "duplicate the relevant data into the new service's own SQLite store" option this
section describes — the same pattern Document Distribution and PDF Render already used, and
exactly the option §13 says does **not** work for Epic 5's Customer/Organization case. This is
a real, shipped data point in favor of §13's own reasoning, not a contradiction of it.

---

## 14. Auto-Trigger Registry

*(Added v0.67.1, workflow audit — largely unchanged from the last review; still an accurate
inventory of the ~13 hand-coded "if X changes, run Y" functions with no shared dispatch
mechanism. Reproduced in full in version control history.)* One addition since v0.67.1:
`expireStaleQuotes()` (§8.2) joins `expireStaleContracts()` as a second hourly-sweep expiry
trigger, same idempotent shape (check current state, no-op if already there, act once).

---

## Appendix A — Codebase Metrics (measured directly, 2026-08-13)

| Metric | Value |
|---|---|
| `server.js` | 3,529 lines |
| `src/App.jsx` | 4,082 lines |
| `src/pages/shipments/ShipmentDetailPage.jsx` | 2,811 lines (now Overview only — was 4,275 as one monolithic page) |
| `routes/*.js` | 25 files, 8,290 lines total (largest: `shipment-ops.js` at 1,250) |
| `lib/*.js` | 7 files |
| Frontend source files | 127 `.jsx`/`.js` (excl. tests), up from "~70" last counted |
| Backend test files | 36 (`npm test`) |
| Frontend test files | 2 (Vitest) |
| Database tables (monolith) | 77 |
| Database indexes (monolith) | 25 |
| Transaction-wrapped write blocks | 16 (6 in `server.js`, 10 across `routes/*.js`) |
| Standalone microservices | 3 (Document Distribution :3002, PDF Render :3003, Contract Management :3004) |
| Seed data | 14,269 port locations · 21,201 vessels · 69 carriers (per `GET /api/health`'s live counts) |

Every figure above was read directly from the code or a live `GET /api/health` call on
2026-08-13 — none carried over from a prior revision of this document.

---

*Document refreshed from a direct pass against the live codebase — CargoDesk v0.69.0 "Custodian"
· 2026-08-13. Next scheduled review: whichever comes first of (a) the next major structural
change (a new microservice extraction, a routing framework change, a data-store migration) or
(b) six months from this date — whichever is sooner, so this doesn't repeat a 39-release gap.*
