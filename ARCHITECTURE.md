# CargoDesk — Architecture Reference
**Version:** 0.79.0 "Keel" · **Date:** 2026-08-25
**Audience:** Software architects, senior engineers, technical reviewers

> This document was fully refreshed from a direct pass against the live codebase on 2026-08-13
> (v0.69.0), replacing a version that had gone stale since v0.30.0. The 2026-08-19 pass was
> **incremental** — it added §8.14 (Reports) and §8.15 (NVOCC Support), the two subsystems that
> shipped since the 2026-08-13 pass. The 2026-08-22 pass was also incremental — it added
> §8.16 (Credit Control), a feature that had shipped as far back as v0.57.0 but was never
> documented here at all; the section covers the whole feature end-to-end, not just the
> v0.73.0–v0.73.1 work that prompted writing it. This latest pass (2026-08-25) adds §8.19
> (Zero-Script Onboarding) and deepens §8.12 (EDI Messaging & Carrier Booking Lifecycle) with the
> eAdapter per-carrier configuration layer — also **corrects this banner itself**, which had
> drifted to a stale "0.74.0" even while §8.17–8.18 below it already documented v0.77.0/v0.78.0
> work; the version line and the section content had quietly gone out of sync with each other.
> Appendix A's line-count/table-count figures are still dated to 2026-08-13 and were **not**
> re-measured this pass — the additions since then are a handful of new columns/routes/tables,
> not a scale change big enough to move those figures meaningfully. See `CLAUDE.md`'s own
> "Recent changes" sections for a release-by-release changelog this document doesn't restate —
> treat that file as the day-to-day source of truth and this one as the standing structural
> reference.
>
> A companion visual diagram, `dev/architecture.html`, is dated v0.20.0 (2026-07-03) and remains
> **not** refreshed — it's now well over 50 releases behind and should be treated as a
> historical snapshot, not a current reference, until someone rebuilds it.

---

## Table of Contents
_(§8.19 and the version-banner fix added 2026-08-25; §8.12 deepened 2026-08-25; §8.17–8.18 and the §5 routes/ table added 2026-08-24; §8.16 added 2026-08-22; §8.14–8.15 added 2026-08-19; everything else reflects the 2026-08-13 pass)_
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
else still lives in the monolith. Not redrawn into the box diagram above (a read-side view over
existing data, not a new owned domain): **Reports** (§8.14), a GP-by-trade-area aggregation
layer over `shipment_cost_lines`/`shipments`, reusing the Commercial/Shipments & Cargo domains'
own data rather than owning any of its own.

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
│  ├─ node services/contract-management/server.js   → :3004
│  ├─ node services/mdm/server.js                    → :3005
│  ├─ node services/screening/server.js              → :3006
│  └─ node services/kanban/server.js                 → :3007
│         │
│         └─ Vite proxies /api and /ws → :3001 (monolith only — the browser never talks
│            directly to any of the six microservices)
│
├─ cargodesk.db                (monolith's own file, co-located with server.js)
├─ services/document-distribution/*.db
├─ services/pdf-render/            (stateless — no database)
├─ services/contract-management/*.db   (only holds live data when contract_source='remote', §8.1)
├─ services/mdm/*.db                   (only holds live data when mdm_source='remote', §8.1)
├─ services/screening/*.db             (only holds live data when screening_source='remote', §8.1)
└─ services/kanban/*.db                (only holds live data when kanban_source='remote', §8.1)
```

The monolith calls each microservice over plain HTTP, gated by a shared static secret per
service (`DISTRIBUTION_SERVICE_SECRET`, `PDF_RENDER_SERVICE_SECRET`, `CONTRACT_SERVICE_SECRET`,
`MDM_SERVICE_SECRET`, `SCREENING_SERVICE_SECRET`, `KANBAN_SERVICE_SECRET`) read via
`lib/dockerSecret.js` (env var, or a `_FILE`-suffixed path for Docker/Compose secrets).
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

`server.js` is **4,292 lines** as of v0.78.0 (remeasured for this pass — the doc's earlier
"3,529 lines" figure was accurate at the time it was taken but has since grown again as more
tables/migrations/`ctx` entries accumulated across releases; route *handling* itself still lives
almost entirely in `routes/*.js`, not back in this file — the growth is schema/startup/shared-
helper surface, the composition-root shape below is unchanged). `server.js`'s actual job today:

```
server.js  (4,292 lines)
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

### routes/ — 31 files, 10,057 lines

Each file is a factory function `module.exports = function xRoutes(app, ctx) { ... }`, called
once from `server.js` with the shared `ctx`. Roughly ordered by size — remeasured directly for
this pass (the doc's previous "25 files, 8,290 lines" figure had drifted six files and ~1,800
lines out of date, not from any one release but from several additive passes never circling back
to update this table; corrected here rather than left compounding):

```
routes/shipment-ops.js     1,486   Cost lines, milestones, documents, container events, services
routes/shipments.js          968   Core shipment CRUD, legs, routing-term engine, list-page
                                    status/carrier/search/sort filters (v0.78.0)
routes/customers.js          794   Customer CRUD, contacts, screening, documents, sanctions sync
routes/contracts.js          674   Contract CRUD, matching, publish/withdraw, local/remote toggle
routes/auth.js                657   Login, users, password reset, RBAC role management
routes/export.js              649   CSV/Excel export (configurable field sets)
routes/reports.js             488   GP by Trade Area, Billing Performance, Invoice Collections
routes/edi.js                  461   Carrier booking EDI (request/response/confirm/supersede)
routes/mdm.js                  422   Ports, carriers, vessels, trade lanes, countries, commodities,
                                    linked ports + carrier agents (real pagination, v0.78.0)
routes/ai.js                   376   AI chat (tool-calling) + document extraction (v0.69.0)
routes/carrier-invoices.js     337   Freight Audit & Payment matching engine (v0.69.0)
routes/quotes.js                269   Quoting/RFQ lifecycle (v0.69.0)
routes/command-center.js        260   Command Center — Quality & Exception Management (v0.77.0, §8.17)
routes/kanban.js                259   Tickets, ticket links, Kanban projects/columns
routes/system.js                228   Settings, system messages, contract-source toggle
routes/organization.js          221   Branches, offices, org countries
routes/customs-filing.js        203   AES/EEI + ISF/AMS filing lifecycle
routes/allocations.js           191   Space allocation CRUD + conflict detection
routes/document-distribution.js 173   Proxy to the Document Distribution service
routes/testcases.js             157   Test plans/runs/cases, ticket↔test-case links
routes/offices.js               125   Office CRUD
routes/share.js                  99   Public read-only shipment-tracking share links
routes/office-mail.js            96   Per-office SMTP settings
routes/finance.js                87   Margin/GP aggregation
routes/ais.js                    85   AIS listener status + manual controls
routes/scheduled-reports.js      82   Recurring emailed reports (TKT-IXAR9G)
routes/duty-rates.js             46   Duty rate chapters — HS-chapter flat-rate registry
routes/invoice-reason-codes.js   45   Invoice status override reason codes (Epic TKT-G11AHW)
routes/pack-types.js             40   Pack type definitions (cargo manifest tree)
routes/container-types.js        40   Container type registry (Equipment section)
routes/charge-codes.js           39   Charge code registry
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
            │                                 principal + 12 additional roles, e.g. Forwarder,
            │                                 Customs Broker (Export/Import), Line Agent, NVOCC
            │                                 — §8.15)
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
customers.is_nvocc / fmc_number            (§8.15 — flags a customer eligible for the NVOCC
                                             party role above, carries its FMC/license number)
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

Three pieces of the monolith have been extracted into their own Express processes for reasons
unrelated to the toggle pattern below (retry/failure isolation, a heavy bursty operation, or
proving the pattern out); five more followed the pattern itself, one per session, as a deliberate
five-cut plan (Contract Management → MDM → Screening → Kanban/Testing → Customer/Organization) —
the last of which (Epic 5, v0.84.0) completes both this extraction plan and the separate 5-epic
Organization Model roadmap begun at v0.56.0:

| Service | Port | Extracted because | Data ownership |
|---|---|---|---|
| **Document Distribution** (`services/document-distribution/`, v0.64.0) | 3002 | Outbound document delivery (email/webhook) has its own retry/failure profile, distinct from request/response HTTP | Owns its own `.db` — webhook configs, delivery attempts |
| **PDF Render** (`services/pdf-render/`, v0.65.1) | 3003 | The heaviest, most bursty thing the monolith did per-request (a full headless-Chromium launch) — see §12 for the full reasoning | Stateless — no database at all |
| **Contract Management** (`services/contract-management/`, v0.68.0) | 3004 | First real "toggle between local and remote" extraction — proves the pattern before Epic 5 (Customer/Organization) needs it | Owns its own `.db`, a straight port of `contracts`/`contract_legs`/`contract_rates`/`contract_routings` |
| **MDM** (`services/mdm/`, v0.80.0) | 3005 | Second "toggle between local and remote" extraction, following the sequencing proposed in `documentation/splitting-mdm-first.html` — the lowest-blast-radius domain (no request-path involvement, no outbound FK from any of its tables into shipments/customers/users) | Owns its own `.db`: `carriers`/`vessels`/`port_locations`/`linked_ports`/`trade_lanes`/`country_trade_lanes`/`regions`/`countries`/`commodities`/`carrier_agents` |
| **Screening** (`services/screening/`, v0.81.0) | 3006 | Third "toggle between local and remote" extraction — externally-sourced denylist data, zero outbound FK, read via name-match not JOIN (`documentation/splitting-sanctions-next.html`) | Owns its own `.db`: `sanctions_entries`/`sanctions_syncs`, plus a small local `settings` table for its own auto-sync schedule (no admin UI for it yet — see below) |
| **Kanban/Testing** (`services/kanban/`, v0.82.0) | 3007 | Fourth "toggle between local and remote" extraction — a feature the roadmap expects to eventually go away entirely (`documentation/splitting-kanban-out.html`), so keeping its schema fully separable now avoids leftovers later | Owns its own `.db`: `tickets`/`ticket_links`/`test_items`/`test_case_links`/`kb_projects`/`kb_versions`/`kb_columns` |
| **Customer/Organization** (`services/customers/`, v0.84.0) | 3008 | Fifth and final "toggle between local and remote" extraction, and the last story of the 5-epic Organization Model roadmap begun at v0.56.0 — deliberately sequenced last, after the data model had fully settled | Owns its own `.db`: `customers`/`customer_identifiers`/`customer_contacts`/`customer_screenings`. `customer_documents` and `customer_roles` are deliberately excluded — see the Customer-specific notes below |

All five of Contract Management, MDM, Screening, Kanban/Testing, and Customer/Organization share
the same shape, and unlike the other two extracted services, **the monolith's own local tables are
never deleted or bypassed** by any of them — `app_settings.contract_source`/`mdm_source`/
`screening_source`/`kanban_source`/`customer_source` (`'local'` default, or `'remote'`) are
per-request toggles read via `getSettings()`. Every place that touches contract data —
`routes/contracts.js`'s own endpoints, `routes/allocations.js`'s match logic, `server.js`'s
`createRateSnapshot`/`importContractRates`, `routes/carrier-invoices.js`'s matching engine —
branches on `contract_source`; every place that touches MDM data — `routes/mdm.js`'s own
endpoints, `server.js`'s `rebuildPortLanesMap`/`portCountryMap` in-memory caches (these two MUST
stay in-process caches regardless of source, since they're read synchronously on every shipment
mapped — see below), `resolveCarrierAgent`, `routes/contracts.js`'s `linkedPortPairsJson()`, and
`lib/ais-listener.js`'s vessel-write/port-coords-read paths — branches on `mdm_source`; every place
that touches sanctions data — `routes/sanctions.js`'s own endpoints, `server.js`'s
`loadSanctionsIndex`/`syncOfacSdn`/`syncConsolidatedScreeningList`/the two auto-sync schedulers —
branches on `screening_source`; every place that touches Kanban/Testing data —
`routes/kanban.js`'s and `routes/testcases.js`'s own endpoints, `server.js`'s
`ensureOpsTicket`/`runOpsAutomationSweep` — branches on `kanban_source`; every place that touches
customer data — `routes/customers.js`'s own endpoints, `server.js`'s shared `getCustomerRow`/
`getCustomerScreeningResult`/`resolveCustomerGroup` helpers (consumed by `routes/shipments.js`,
`routes/edi.js`, `routes/shipment-ops.js`, `routes/finance.js`, `routes/mdm.js`,
`routes/reports.js` — see below) — branches on `customer_source`. Flipping any of the five is a
one-way cutover lever (§13's design doc covers why this isn't a live bidirectional sync), not
something to flip back and forth casually in production. A CLI migration script per service
(`scripts/migrate-contracts-to-service.js`, `scripts/migrate-mdm-to-service.js`,
`scripts/migrate-sanctions-to-service.js`, `scripts/migrate-kanban-to-service.js`,
`scripts/migrate-customers-to-service.js`) moves existing local data across; nothing does this
automatically.

**Screening-specific notes**: `sanctionsMap` (server.js) is read as a pure in-memory lookup on
every shipment/customer screen — a hot path — so it MUST stay an in-process cache regardless of
`screening_source`, same rule as MDM's port-lane cache above. In remote mode,
`loadSanctionsIndex()` rebuilds it from one bulk `GET /internal/sanctions/entries/export` call;
the manual "Sync Now"/"Sync CSL Now" actions POST to the service then immediately reload the
cache locally (so they still give synchronous feedback), while the two auto-sync schedulers
(`scheduleNextOfacSync`/`scheduleNextCslSync`) retask themselves into a plain 15-minute
cache-refresh poll instead of their local-mode "is a sync due" math — the Screening Service now
owns firing the actual sync, on its own schedule, independent of the monolith's process lifetime.
**Real pre-existing bug found and fixed during this extraction**: `loadSanctionsIndex()` used to
reassign the module-level `sanctionsMap` variable (`sanctionsMap = new Map()`) rather than mutate
it in place — any consumer that had captured a reference before a reload (`routes/customers.js`'s
`screenCustomer`, destructured from `ctx` once at module-load time) silently never saw a later
sync. Fixed to `sanctionsMap.clear()` + refill, verified with a dedicated regression test.

**MDM-specific notes**: `portLanesMap`/`portCountryMap` are read on the hot shipment-mapping path
(`mapShipment`, `matchesScopeItem`), so in `remote` mode they're rebuilt from one bulk
`GET /internal/port-lanes-index`/`/internal/port-country-map` call at boot and at the same
mutation-trigger points as today — never a live per-request fetch. `lib/ais-listener.js`'s
`handleShipStaticData` (vessel upsert on every `ShipStaticData` frame) fire-and-forgets a
`POST /internal/vessels/upsert` in remote mode rather than awaiting it, matching this module's own
"never block on network I/O, never throw past its boundary" rule; `getPortCoords` (read inside the
hot per-frame `PositionReport` loop) returns `null` on a remote-mode cache miss for that one frame
while a background bulk fetch repopulates the cache, rather than ever blocking the socket.
`resolveCarrierAgent`'s remote branch calls the MDM Service's own
`GET /internal/carrier-agents/resolve` (which does its own linked-port fallback server-side, since
it owns both `carrier_agents` and `linked_ports`) and then does one local
`SELECT company_name FROM customers` to attach the name — the service owns no `customers` table.
**Named, accepted gap**: 11 secondary read sites beyond these (`routes/reports.js`,
`allocations.js`'s own linked-port matching, `shipment-ops.js`, `command-center.js`,
`customers.js`, `export.js`, `organization.js`, `system.js`, `ais.js` (Simulator), plus
`scripts/checkdb.js`) still read MDM tables directly from the monolith's local schema regardless
of `mdm_source` — mostly read-only display JOINs where staleness post-cutover is cosmetic, not
data loss, but flagged rather than silently chased in this pass. Don't flip `mdm_source=remote` in
an environment exercising Reports/Export/Command Center/the AIS Simulator until this is closed.

**Kanban/Testing-specific notes**: unlike the caches above, there is nothing to keep warm here —
tickets/test items are read fresh per request in both modes, so flipping `kanban_source` takes
effect immediately with no rebuild step (`PUT /api/settings/kanban-source` does nothing but write
the setting and log the change). The Kanban Service owns no `users` table, so every route that
used to `LEFT JOIN users` for `assignee_name` (`TICKET_JOIN`/`TEST_ITEM_JOIN`) instead returns a
raw `assigneeId` in remote mode; a new shared `resolveAssigneeNames(rows)` (`server.js`, exported
via ctx) batch-resolves the name/initial locally afterward, mirroring `routes/shipments.js`'s own
`resolveSeaPorts()` batch-`IN` pattern — the response shape is identical to local mode either way,
so the frontend needed zero changes. `ensureOpsTicket()`'s dedupe-on-`(sourceType, sourceId)`
check was a plain check-then-insert in the monolith — a narrow race under concurrent sweeps that
was never worth fixing there (the ops-automation sweep runs on one hourly timer, not genuinely
concurrent with itself). The Kanban Service's own schema adds a real
`UNIQUE(source_type, source_id)` constraint on `tickets` that the monolith's table never had,
backing a new atomic `POST /internal/tickets/ensure` (`INSERT OR IGNORE`) — remote mode closes the
race outright rather than porting the old behavior; local mode is unchanged. `ensureOpsTicket()`
and `runOpsAutomationSweep()` both became `async` to support the remote branch, which rippled into
three call sites: the startup call, the hourly `setInterval` (both now swallow a rejection via
`.catch()` rather than letting it become an unhandled rejection), and the dev-only
`POST /api/test/run-ops-automation-sweep` trigger route, whose own before/after ticket-count check
now branches on `kanban_source` too (counting via `GET /internal/tickets` in remote mode instead
of a local `SELECT COUNT(*)`). Story↔TestCase links (`test_case_links`) needed no special
treatment at all — `tickets` and `test_items` move to the same service together, so the live JOIN
between them (`GET /internal/test-items/:id/story-links`, `GET /internal/tickets/:id/tested-by`)
stays entirely server-side there exactly like it does in the monolith today. The Command Center's
`TicketAlertCard` (`CommandCenterView.jsx`) needed no change either — it already calls
`api.tickets.list()` over HTTP through the monolith's own `/api/tickets`, which is now a thin
proxy in remote mode rather than a direct table read, but the response shape it consumes is
unchanged.

**Customer/Organization-specific notes**: the largest and riskiest of the five cuts, for two
reasons that aren't just "more tables." **The screening write/match split** — sanctions
screening's MATCH decision (`screenCustomer()`, `routes/customers.js`) can never move into the
Customer Service: it depends on the in-memory `sanctionsMap` cache, itself sourced from the
already-extracted Screening Service, so a customer's screening is a genuinely split read/write
domain, not a clean lift. `screenCustomer()` stays in `routes/customers.js`, unchanged position,
still matching locally against `sanctionsMap` — only the already-decided result's WRITE branches
on `customer_source` (local keeps the existing `INSERT ... ON CONFLICT DO UPDATE`; remote calls a
new `PUT /internal/customers/:id/screening`, a write-only upsert). The override route
(`POST .../screening/override`) has no `sanctionsMap` dependency and runs fully server-side either
way. The read side — `screenShipmentById`'s own per-party customer-level cross-reference check —
is backed by a new `getCustomerScreeningResult(id)` helper (local: direct query; remote:
`GET /internal/customers/:id/screening`). **The `screenShipmentById` async ripple** — becoming
`async` (a caller can't know `customer_source` in advance) touched every call site across
`server.js` (`rescreenActiveShipments`), `routes/customers.js` (`rescreenShipmentsForCustomer`,
`POST`/`PUT /api/customers`, `POST .../screen`), `routes/shipments.js` (`maybeRescreen` and its 3
`shipment_parties` CRUD call sites, the create/update routes), `routes/quotes.js` (quote
conversion), `routes/shipment-ops.js` (`POST .../screen`), and `routes/sanctions.js` (the OFAC/CSL
sync routes' own re-screen sweep) — each converted and directly verified against the real code
rather than assumed from the plan.

One shared `getCustomerRow(id)` helper (`server.js`) backs every credit-hold/over-limit read site
across `routes/customers.js` (4 sites), `routes/shipments.js`'s create-time soft warning,
`routes/edi.js`'s booking-request hard block, and `routes/shipment-ops.js`'s
`findCreditHold`/`findOverLimitBlock` — one remote shape, not many independently-drifting ones.
`resolveCustomerGroup` became `async`, with a remote branch calling the service's own
`GET /internal/customers/:id/group` (does the whole root-then-descendants walk server-side,
root-first — `routes/finance.js`'s `rootOf()` depends on that exact order). Since `rootOf()` is
called synchronously inside a `.map()`, `GET /api/margin/summary` pre-warms a cache via one
`Promise.all` up front rather than trying to make `rootOf()` itself async in place.
`routes/mdm.js`'s `attachAgentNames()` — a local-only `customers` lookup to attach a Line Agent's
name, harmless while customers only ever lived in the monolith, a real gap once `customer_source`
can be remote independently of `mdm_source` — now batches through `callCustomerService`'s own
`ids=` filter, the one place two extracted services genuinely interact (covered by a dedicated
combined `mdm_source=remote` + `customer_source=remote` test). `routes/reports.js`'s
billing-performance and invoice-collections reports both batch every referenced customer's
`creditTermsDays`/`invoiceDeadlineDays` into one call via a shared `getCustTermsMap()` helper
instead of the N-per-row query `invoice-collections` was previously doing.

**`customer_documents` stays local-only, deliberately, regardless of `customer_source`** —
uploaded file bytes live on disk under `UPLOADS_DIR`, outside SQLite, and no cross-service blob
storage exists anywhere in this codebase (none of the prior four extractions needed one either).
The one nuance this doesn't fully dodge: the document routes' existence-check guard used to read
the local `customers` table directly, which would wrongly 404 an upload for a customer created
*after* a remote cutover — fixed by routing just that one check through `getCustomerRow`; file
write, the DB row, and download are all untouched. **`customer_roles` is excluded from the toggle
entirely** — confirmed dead (zero readers, zero writers anywhere in the codebase; role membership
is fully derived live via `CUSTOMER_ROLE_USAGE_SQL`, a UNION over `shipments`/`shipment_parties`,
which stay permanently monolith-owned either way and need no toggle branch at all).

**`PRAGMA foreign_keys=ON`** — `customers.parent_customer_id`'s `ON DELETE SET NULL` is a real,
enforced FK in the monolith (`server.js` sets this pragma globally; `node:sqlite`'s own
`DatabaseSync` defaults it off). `services/customers/server.js` explicitly sets both
`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` in its own schema block, or deleting a parent
in remote mode would leave dangling pointers instead of nulling them — a correctness hazard for
both `resolveCustomerGroup`'s walk and the cycle-detection guard on save. (The Kanban Service's own
schema declares `ON DELETE CASCADE` on two columns but never sets this pragma — a pre-existing gap
there, not this cut's job to fix, but deliberately not copied here.)

**Two real bugs found and fixed while implementing this cut, neither specific to the toggle
pattern itself**: `screenCustomer()` was reading the customer row directly from the local table
even in remote mode — a customer created after cutover would silently never get screened at all,
the exact blind spot a compliance feature can't afford; fixed by routing that read through
`getCustomerRow` too, which also closed two gaps Stage 2 had left explicitly open (`POST`/
`PUT /api/customers`'s remote branches now actually call `screenCustomer` instead of skipping it).
Separately, `routes/customers.js` used `getCustomerRow` throughout the file but had never actually
destructured it from `ctx` — a `ReferenceError` that crashed the entire monolith process the
moment a remote-mode credit-hold-release request exercised that code path, found via a full crash
reproduction with a captured stack trace before being fixed.

**Named, accepted gap, unchanged by this cut**: `DELETE /api/customers/:id`'s own reference guard
only ever checked `carrier_agents.agent_customer_id` — and since `carrier_agents` itself moved to
the MDM Service at v0.80.0, that check already silently does nothing once `mdm_source='remote'`, a
pre-existing bug predating this extraction. It doesn't check `shipments`/`shipment_parties`/
`credit_overrides`/`contracts.named_account_id`/other customers' `parent_customer_id` either —
also pre-existing, also not widened or fixed as a side effect of this pass.

**Also surfaced during this cut's own verification, not caused by its code**: `npm test`'s 53-file
chain is `&&`-chained (see `package.json`'s `test` script), so the first file with a non-zero exit
silently stops everything after it — `carrier-booking.test.js`'s 5 PDF-Render-service-dependent
failures (present long before this session) had been doing exactly that the entire time. Every
"full backend chain green" claim in this document's own changelog history was, in practice, only
ever re-confirming the first handful of files in the chain; the real per-stage signal always came
from directly running the individually relevant test files, which remains sound. Starting the
three services that happened to be unavailable this session (PDF Render, Document Distribution,
Contract Management — all work correctly in this environment) let the chain run to completion for
the first time, confirming this is a real, disclosed gap in the test-runner script itself — logged
here for a future pass, not fixed as a side effect of this cut.

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
`ai_model`/`ai_api_key`, `gp_target_pct` (§8.14, blank by default — one flat global target, same
simplification `fap_variance_tolerance_pct` already made), and more) — no longer enumerable as a
short table the way the last review did it. `isEnabled(module)` in `App.jsx` still reads from
`appSettings` state the same way.

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

### 8.12 EDI Messaging & Carrier Booking Lifecycle (deepened v0.79.0 — eAdapter; office-scoped v0.83.0)

Substantially more complete than the last review's "v1, demoable" framing. `carrier_bookings` /
`carrier_booking_archive` now model a real state machine: a booking created via
`ensureBookingCreated()` once both a contract and a schedule exist (§14); a carrier-change on an
unconfirmed booking triggers `supersedeIfCarrierChanged()`, which archives the old booking (full
history preserved, an auto-cancellation EDI message sent to the old carrier if it was still
Pending) and starts a fresh one — a **confirmed** booking is never silently rewritten, only ever
archived-and-superseded before confirmation.

`BOOKABLE_CARRIERS` (`MAEU`/`SAFM`/`MCPU`, the built-in three) is no longer the whole story.
First story of the carrier-EDI epic, eAdapter, generalizes it into `isEdiBookable(carrierCode,
officeId)`:
```
function isEdiBookable(carrierCode, officeId) {
  if (getSettings().api_eadapter_enabled === 'false') return false;
  if (BOOKABLE_CARRIERS.has(carrierCode)) return true;
  if (!officeId) return false;
  const cfg = db.prepare("SELECT is_active FROM carrier_eadapter_configs WHERE carrier_code=? AND office_id=?").get(carrierCode, officeId);
  return !!cfg?.is_active;
}
```
`carrier_eadapter_configs` (one row per **(carrier, office)** as of v0.83.0, not one row per
carrier — a real carrier EDI relationship is negotiated per country/branch, not once globally; a
low-volume office is exactly the one a carrier is least inclined to bother configuring EDI for.
`office_id` is the real scope key (`UNIQUE(carrier_code, office_id)`); `country_iso2` is
denormalized from that office at write time — always re-derived server-side from `office_id`,
never trusted from the request body, so it can never drift from the office actually picked. The
built-in three are deliberately **not** office-scoped — a separate, pre-existing, always-
simulated concept this pass didn't revisit. `officeId` at the call site is the shipment's own
`emo_office_id` (Export Managing Office — the same field `resolveInvoiceThresholds`/
`sendViaOffice` already key off as "the office actually handling this shipment"); a shipment with
no EMO office assigned can never match a scoped config. A pre-existing `carrier_code`-only row
predates this and has no real office to attribute itself to — the one-time rebuild migration
(`server.js`, guarded by checking for the `office_id` column) deactivates any such row with an
explanatory note rather than guessing an office, same non-destructive posture the `shipment_
schedules.shipment_id` nullable rebuild (§14) already established for this class of migration.
Transport columns (`transport_type` REST API/AS2/SFTP, `endpoint_url`, `auth_header_name`,
`credential`) are modeled directly on `office_mail_settings`' shape and secret-hygiene convention
— `mapEadapterConfig` (`lib/mappers.js`) never returns the raw `credential`, only a
`hasCredential` boolean, same as that table's own `smtp_password`; `offices.js`'s own office
delete-guard (already blocking a delete referenced by a shipment) gained the same check for a
referencing eAdapter config. New `routes/eadapter.js`: CRUD on `/api/eadapter/configs` (admin/
operator write-gated, `officeId` required on create), plus a public `GET /api/eadapter/bookable-
carriers?officeId=` (`{enabled, carriers}`, office-aware — no `officeId` param returns only the
built-in three) that both Carrier Booking pages now poll (with the shipment's own `emoOfficeId`)
instead of importing the static `BOOKABLE_CARRIERS` Set directly — the live, office-scoped
effective set, not a compile-time constant.

The master toggle (`app_settings.api_eadapter_enabled`, default `'true'`) is deliberately a
single switch over the **entire** EDI-carrier-communication surface, built-in three included —
not a per-new-carrier flag layered on top of an always-on legacy three. Turning it off collapses
every carrier uniformly to **manual mode**: the existing non-EDI-carrier lifecycle (Send/EDI UI
hidden, operator records the outcome via the existing manual Confirm action with a typed
`bookingRef`), which already existed for any carrier that was never in `BOOKABLE_CARRIERS` —
reused as-is rather than building a second document-generation path (document generation + email
already exist as a separate, always-available tool, independent of the booking flow). This is
explicitly config + CRUD only for this first story — no live outbound HTTP call is attempted yet;
wiring a real send attempt per carrier (mirroring the deleted Maersk `fetch()` pattern from
v0.72.1, generalized) is a clean, separately-scoped follow-up story once this scaffolding exists.

Frontend: a new `EadapterCard` (Settings → API Controls → External APIs, ahead of the generic
`EXTERNAL_APIS` list — it needs N per-carrier sub-configs, not one scalar key, so it isn't built
through that generic component) pairs the master toggle with a gear-icon button opening
`EadapterConfigModal` — a hand-rolled tab bar (one tab per **(carrier, office)** row since v0.83.0,
labeled `{carrierCode} · {officeCode}`, `+ Add Carrier Config` in the header, same tab-bar-inside-
a-`Modal` pattern `MdmCustomersPage.jsx`'s `CustomerDetailModal` already established, since
`Modal.jsx` has no built-in tab support). The draft form's Country select narrows a dependent
Office select (both required, both disabled once a row is saved — same "immutable after create,
delete and re-add to change scope" rule `carrierCode` already had); `Sel` (`components/
primitives/Form.jsx`) gained a `disabled` prop to support this, a gap in the same class as the
pre-existing `hint`-forwarding fix (v0.39.1) — every other `Sel` consumer app-wide is unaffected
since the prop defaults to `false`.

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

### 8.14 Reports — GP by Trade Area (added v0.71.0)

```
GET /api/reports/gp-by-geo?groupBy=region|country|carrier&value=&from=&to=&format=json|csv

Not a new table — an in-memory aggregation over the existing shipment_cost_lines/shipments
join, the same mapCostLine()/roundCents() USD-computation path every other cost-line reader
already uses (routes/finance.js's own margin-summary endpoint is the closest sibling; this
route was built by reading that one first rather than reinventing the aggregation).

Grouping key resolution:
  region   → portCountryMap[pol] → country_trade_lanes.lane_code  (NOT countries.region_code,
             confirmed live to be scaffolded but never populated — using it would make "By
             Region" permanently empty)
  country  → portCountryMap[pol]                                  (ISO2)
  carrier  → shipments.carrier_code

Two features layer on top of the base aggregation, both computed server-side over the same
already-fetched row set (no second query):
  - Period-over-period comparison: when both `from` and `to` are set, the identical aggregation
    re-runs over the immediately preceding window of equal length; each result row gets a
    marginDeltaPts (null when no prior-period data exists for that key, or when the date range
    is open-ended on either side — no defensible "prior period" to diff against then).
  - Target-based ranking: app_settings.gp_target_pct (blank by default, same "no per-lane
    override" simplification as fap_variance_tolerance_pct, §8.3) sorts worst-margin-first and
    flags below-target rows once set; falls back to sell-volume-descending with no flagging
    when unset.

Drill-in (value= set) returns the raw per-line-item array for that group, rendered by the same
GpBreakdownPanel/ShipmentGpSankey components the single-shipment GP Overview page already uses
(src/components/shared/) — extracted once, reused over a differently-scoped `lines` array rather
than duplicated. The Sankey gained a separate VAT lane in this same pass (a disconnected
"VAT on Sales → VAT (Collected)" mini-flow, not merged into the Revenue chain, since every
SELL line's amountUsd is already VAT-exclusive) — a real, previously-invisible gap: VAT was
already computed per line (mapCostLine's vatAmountUsd) and shown in a stat card, just never
drawn in the diagram itself.
```

### 8.15 NVOCC Support (added v0.71.0, Epic TKT-Q52B38)

```
An NVOCC (Non-Vessel Operating Common Carrier) is legally both a carrier (to its own customer,
on a House B/L) and a shipper (to the real vessel operator, on a Master B/L) for one physical
movement — audited against a detailed mechanics brief rather than assumed. Published as a
7-finding artifact; 4 closed this pass, 3 logged as scoped backlog (a full structural
dual-carrier/principal field split beyond the additive fields below, a two-stage destination
release workflow, NVOCC co-loading/cross-tariff reference). Deliberately NOT the same gap as
LCL/consolidation, which stays deferred under the standing FCL-first roadmap — the House/Master
split is real even for a single-shipper FCL container with zero consolidation involved.

Closed this pass, all additive (no existing behavior changes when no NVOCC is involved):
  - "NVOCC" party role — 12th entry in ADDITIONAL_PARTY_ROLES (§6), resolves via the existing
    shipment_parties mechanism, zero new party infrastructure.
  - customers.is_nvocc / fmc_number — licensing fields, gated the same way
    classified_location/latitude/longitude already are (only persist while the flag is set).
  - Booking-request payload (routes/edi.js, §8.12's carrier_bookings flow) prefers an assigned
    NVOCC party's name for shipperName over shipments.shipper_name — the real shipper of record
    on the vessel-operator side is the NVOCC, not the underlying cargo owner.
  - A second, genuinely independent document type: MB01 "Master Bill of Lading"
    (buildMasterBillOfLadingHtml, App.jsx) alongside the existing BL01 House B/L — not a mode
    flag on one builder, since the two documents' party resolution differs too much to share
    (NVOCC-as-Shipper + "TO ORDER OF {NVOCC}" Consignee on the MBL, vs. NVOCC-as-caption-identity
    on the HBL). Each document cross-references the other's B/L number. Gated in
    getMissingDocRequirements same as every other doc type in the shared Generate Document modal.

shipments.master_bl_number/bl_release_type already existed before this pass (an earlier
migration's own comment already referenced NVOCC) but were only a caption field on BL01 — the
gap this epic closed was that nothing else in the system (party model, licensing, the booking
payload, a second document) knew an NVOCC could exist.
```

### 8.16 Credit Control (added v0.57.0, deepened v0.73.0–v0.74.0, Epic TKT-6XFJQM)

```
customers.credit_limit/credit_terms_days/credit_hold/credit_hold_reason (v0.57.0) is the base
model. credit_hold and (as of v0.74.0) credit_limit are both HARD BLOCKS — the "credit_limit is
a soft warning" framing was true through v0.73.0 but is now stale; see trigger point 3 below.

GET /api/customers/:id/credit-status (routes/customers.js) is the single computed source both
the hold and the limit checks read from — computeArExposure(customerId, creditTermsDays) returns:
  - outstandingAr        sum of confirmed (non-voided) FR01/FR02 invoice totals, resolved via
                          each invoice's source_cost_line_ids (falls back to a live
                          container-scoped SELL-line query for invoices predating that column)
  - committedExposure    (v0.73.0) sum of accrued SELL cost lines NEVER invoiced at all — kept
                          visibly separate from outstandingAr, never merged; a shipment can carry
                          real risk a hold check that only looks at invoices would miss entirely
  - aging                (v0.73.0) Current/1-30/31-60/61-90/90+ buckets, from each invoice's
                          confirmed_at + credit_terms_days as the due-date baseline
  - creditLimitUsd        (v0.73.0) credit_limit converted via the same toUsd()/FX machinery
                          every shipment_cost_lines row already uses — customers.currency
                          (pre-existing, previously only read by resolveInvoiceCurrency() for
                          multi-currency invoice display) now also drives credit_limit's
                          interpretation; a new customer defaults its currency from country
                          (COUNTRY_TO_CURRENCY map, e.g. ES→EUR), never applied retroactively
  - groupOutstandingAr    (v0.73.0) resolveCustomerGroup() (§6, customer hierarchy, v0.59.0)
                          summed across every group member except self — reused, not duplicated

Trigger points (chronological in a shipment's life, hold-vs-limit behavior noted per point):
  1. Shipment/booking creation (v0.73.1, TKT-Q00WHF) — POST /api/shipments checks the Shipper/
     Consignee/Principal for credit_hold and returns a soft, informational creditWarning.onHold
     array (never blocks creation); App.jsx mirrors it into a toast next to the existing
     sanctions-screening one. No limit check here — computing full AR/exposure at creation time
     was deliberately kept out of scope, this trigger point is cheap by design.
  2. Carrier booking send (v0.73.1) — POST .../edi-messages/booking-request (routes/edi.js) is a
     REAL 409 BLOCK on credit_hold, checked server-side (unbypassable) and mirrored client-side
     (ShipmentCarrierBookingDetailsPage.jsx via resolveCreditGate) for a modal instead of a raw
     error. A carrier booking is a genuine external commitment — categorically harder-blocked
     than shipment creation above.
  3. Invoice generation (v0.57.0, extended v0.73.0, credit_limit hardened v0.74.0) — the
     original and still-primary gate. credit_hold blocks generating a NEW invoice outright
     (existing cost lines/documents stay editable; only Generate Invoice/Generate Per-Container
     Invoices are blocked) via src/components/shared/CreditHoldModal.jsx (extracted to shared in
     v0.73.1 — previously local to ShipmentAccountingInvoicesPage.jsx; also backs trigger point
     2, parametrized by an `action` string). credit_limit is now the SAME class of hard block —
     overLimit = (outstandingAr + committedExposure) > creditLimitUsd, enforced server-side in
     POST .../documents/generate (FR01/FR02 only) via findOverLimitBlock, mirrored client-side
     via resolveCreditGate for OverLimitBlockModal (no bypass, replaces the old v0.57.0-v0.73.0
     "Generate Anyway" soft warning). NOTE: this formula deliberately does NOT add a separate
     "this invoice's own amount" term — committedExposure already includes it, since a cost line
     always exists in the DB before Generate is clicked; a real bug where the pre-v0.74.0 code
     added it anyway (double-counting) was caught and fixed in the same pass, on both the client
     and server copies of this formula.

Exclusive trade-lane override (v0.74.0, TKT-GLWMFP) — closes this Epic. Direct, explicit
business rule: only the trade_manager scoped to a shipment's own trade lane may ever release a
credit_hold or approve an over-limit generation — never admin, operator, or an out-of-lane
trade_manager. Reuses user_scope_items' existing item_type='trade_lane' + matchesScopeItem()/
portLanesMap (server.js, same mechanism applyShipmentAccessFilter already uses to scope
shipment visibility) via two new helpers: userOwnsLaneForShipment(user, shipment) — true if any
of the user's own trade_lane scope items match the shipment's pol/pod — and
userOwnsLaneForCustomer(user, customerId) — same check, but true if ANY shipment where this
customer is Shipper/Consignee/Principal matches (credit_hold lives on the customer, not one
shipment). Plain role-membership check (req.user.roles.includes('trade_manager'), matching
requireRole's own convention) rather than primaryRoleSV's rank/effective-role logic — this is a
narrow grant, not a hierarchy position, and should hold even for a user who also carries a
higher-ranked role.
  - Releasing a hold: POST /api/customers/:id/credit-hold/release (reason required, mirrors the
    existing screening/override pattern) — the SAME lane check was also added inline to the
    generic PUT /api/customers/:id route (only for the credit_hold true->false transition;
    setting a hold, or editing anything else about a customer, is unrestricted as before) to
    close the direct-API bypass the dedicated endpoint alone would have left open.
  - Approving an over-limit generation: POST /api/shipments/:id/credit-override/approve (reason
    required, re-verifies the party is genuinely over limit right now) inserts a credit_overrides
    row (customer_id, shipment_id, override_type='over_limit', approved_by, created_at). Validity
    is a 60-MINUTE GRACE WINDOW from approval, not strict single-use — a per-container split
    invoice run (invoiceGenerator.js's generateInvoices) calls POST .../documents/generate once
    PER CONTAINER for what's really one logical action; single-use-on-first-call would have
    silently re-blocked containers 2..N of the same batch. Short enough that it can't become a
    standing bypass for a later, genuinely new over-limit event (a customer whose balance rises
    again days later needs a fresh approval); long enough to cover any realistic one-batch
    generation. GET /api/shipments/:id/credit-override surfaces the current valid override (or
    null) so the frontend can skip straight to generating instead of re-showing the block.
  - New "Credit Overrides" page (src/pages/CreditOverridesPage.jsx, top-level nav — deliberately
    NOT nested under Accounting, which stays hidden from trade_manager's nav per v0.29.0, a
    narrow carve-out so this one exclusive authority stays reachable) lists every currently-
    blocked shipment via GET /api/credit-overrides/queue, server-scoped per viewer: admin/
    operator get the full queue for visibility/escalation with canAct always false; a
    trade_manager's own result set is pre-filtered to shipments their lane scope actually
    covers, so canAct is always true for everything they see.

Test coverage: tests/customer-credit-control.test.js (83 assertions as of v0.74.0) covers every
trigger point above via live HTTP calls, including the full authorization matrix for both
exclusive actions (in-lane/out-of-lane/admin, each tested against both allow and deny paths) and
the grace-window/queue-scoping behavior. One disclosed, permanent gap: AR aging bucket
*boundaries* (31+/61+/90+ days) can't be exercised through pure HTTP — no endpoint backdates an
invoice's confirmed_at — only the "current" bucket is integration-tested; the day-threshold
arithmetic itself is simple, reviewed math, not faked into a false-confidence test.
```

### 8.17 Command Center — Quality & Exception Management (added v0.77.0, Epic TKT-IBHB0K)

```
A sourced gap analysis of Cargo iQ (IATA's air-cargo quality-management interest group)'s
Master Operating Plan / Freight Status Update model against the Command Center's pre-existing
volume-only analytics (status breakdown, TEU booked, carrier consumption, top routes, monthly
trend — all still unchanged). The gap: every planned-vs-actual signal Cargo iQ's model runs on
already existed per-shipment in this app (shipment_milestones' estimatedDate/completedAt,
shipment_legs' etd/eta + etd_source/eta_source='ais' provenance) but nothing aggregated it across
the fleet — the Command Center's only exception signal was one blunt "Overdue" tile (etd < today,
status not Completed/Cancelled), with no differentiation of *why* a shipment was late. Ocean/FCL
scope only, applying Cargo iQ's methodology to data already captured — not its air-cargo message
formats (real IATA FSU/FWB/FHL EDI, formal MOP membership/certification, cross-company
benchmarking are named as structurally out of reach, not silently dropped).

New routes/command-center.js (260 lines), four endpoints — all auth()-only (no reportsGate; the
Command Center itself has no role gate at all, unlike the Reports page) and scoped per-caller via
the same applyShipmentAccessFilter() every shipment-list read already uses:

  GET /api/milestones/overdue-summary
    Walks every active (not Completed/Cancelled) shipment's shipment_milestones for rows where
    estimatedDate < today && completedAt is empty — the same "overdue" definition
    ShipmentDetailPage.jsx's own milestoneState() already used per-shipment, just aggregated.
    Returns {totalActiveShipments, shipmentsWithBreach, onTimePct, byMilestoneKey[], items[]}.
    Backs both a new 6th Command Center KPI card and (via the same response, re-fetched by
    App.jsx's Header) a new "Milestone Alerts" notification-bell section — same self-poll/
    dismiss-until-tomorrow shape the pre-existing Invoicing Overdue/Carrier Bookings bell
    sections already established, not a new pattern.

  GET /api/exceptions/queue
    Three independent root-cause classifications (a shipment can appear in more than one):
    scheduleSlip (an AIS-reconfirmed SEA leg date, etd_source/eta_source='ais', landed later than
    the shipment's own vessel_departed/vessel_arrived milestone estimate — the carrier actually
    moved the date), unconfirmedBooking (ETD has passed but carrier_bookings.status never left
    Pending/Created), stalledMilestone (the shipment's current — first sequence_order-incomplete —
    milestone's own estimatedDate has passed, independent of ETD). Replaces the single "Overdue"
    tile's blunt count with a tabbed exception queue naming *what kind* of intervention is needed.

  GET /api/command-center/carrier-scorecard?toleranceDays=1
    Per carrier_code: % of AIS-confirmed SEA leg dates (etd/eta) landing within toleranceDays of
    the shipment's own milestone estimate. Only AIS-confirmed samples count — a manual-only date
    isn't a reliable "actual," so a shipment with no AIS confirmation yet contributes no sample
    rather than counting as late. Surfaced as an added on-time% column on the pre-existing Carrier
    Consumption (TEU) ranking, not a separate panel — a chronically-late carrier no longer looks
    identical to an on-time one just because both move the same TEU.
    NOTE: this route lives under /api/command-center/, not /api/carriers/ — routes/mdm.js already
    registers GET /api/carriers/:code ahead of this file in server.js's require order, so
    /api/carriers/on-time-scorecard would be swallowed by that :code route and 404 as an unknown
    carrier code. A real routing collision caught live before settling on this path.

  GET /api/command-center/transit-time-trend
    Planned (shipment_schedules.transit_days, most recently saved per shipment) vs. actual (the
    ETD→ETA span reconstructed from AIS-confirmed SEA leg dates — min confirmed ETD to max
    confirmed ETA across the shipment's own legs, so a TSP's transshipment dwell time folds into
    the whole-journey span rather than being summed leg-by-leg) — bucketed by the shipment's own
    tradeLane (mapShipment, §6) × the month its journey departed. New "Transit-Time Variance by
    Lane" Command Center card, worst-variance-lane first, each row carrying a small trend
    sparkline of actual days across the returned months.

All four reuse mapShipment's fields directly rather than re-deriving shipment state — the only
schema addition anywhere in this epic is a `teu` column on GET /api/shipments' own response
(§8.18 below), added for a different, unrelated reason but incidentally useful here too via the
shared mapper. shipment_milestones/shipment_legs/carrier_bookings/shipment_schedules are all
read-only from this file — nothing here writes to them.

Test coverage: tests/command-center.test.js (38 assertions) — two scratch-shipment fixtures (one
built via /milestones/init with a deliberately backdated etd/eta so every one of the 9 fixed
milestone steps lands overdue by construction; one driven through the real AIS simulator,
POST /api/test-tools/ais/simulate-position, with one milestone's estimate corrected to today so
the fixture proves a real mixed on-time/late sample rather than an all-or-nothing one) prove all
four endpoints against real HTTP calls, not mocked data.
```

### 8.18 Table Pagination Standardization (added v0.78.0)

```
Direct request, prompted by a real scaling concern: "if we have 1000 shipments a week, the list
is going to be absolutely insane to scroll, and it will overload in the RAM for the browser."
Investigation found this was already true — ShipmentsPage.jsx received the entire shipment list
as one fully-loaded prop from App.jsx's shared top-level state and did all filtering/sorting/
pagination client-side over the complete in-memory array, regardless of what page size was
displayed. Two existing pagination shapes already existed to build on: the src/scaffold/
MdmPageScaffold.jsx copy-paste template's real server-side {results,total,limit,offset} contract
(used by ~8 MDM pages already), and src/components/primitives/Pagination.jsx (prev/next UI,
{total,offset,limit,onPage}, no page-size concept). Nothing new was invented — this pass extends
both and adds one new shared primitive, PageSizeSelect.jsx (41 lines): a bare <select> (50/75/100,
matching the inline-filter-bar convention every other toolbar dropdown in this app already uses,
not the vertical Sel/Field form primitives) reading/writing ONE global localStorage key
(cargodesk_page_size) — a scalar app-wide preference, same idiom as cd_theme/
cargodesk_active_role, deliberately not per-table like the independent cd_navfold_* keys, so
raising the page size once on any table raises the default everywhere else too.

GET /api/shipments (routes/shipments.js) is the one route that changed shape, not just gained a
caller: still returns a bare array when the caller omits limit/offset (every existing consumer —
App.jsx's own shared full-array load, Dashboard, Command Center, AI-assistant tools — is
unaffected, opt-in pagination already existed here from an earlier pass, TKT-UAJGR3). New,
also opt-in: status/carrier/search filters and a sort param, applied as JS-array steps AFTER
applyShipmentAccessFilter() (the authorization boundary must run on the full, unfiltered set) —
a verbatim port of what was, until this pass, ShipmentsPage.jsx's own client-side filter/sort
logic, so behavior is unchanged from the caller's point of view, just computed server-side. A new
`teu` column (a fourth LEFT JOIN SUM subquery on the same query, mirroring the pre-existing
margin buy/sell subquery shape) makes teu_desc sort possible without a second per-shipment query.
ShipmentsPage.jsx itself now self-fetches its own page via this endpoint instead of slicing the
shared array — but still receives and reads that shared `shipments` prop for the three things
that must reflect the true full-account totals regardless of the current filter: the header
subtitle, the per-status quick-filter chip counts, and the CSV-export-disabled check.
DELIBERATELY OUT OF SCOPE, named not silently dropped: the SQL query itself still has no WHERE
clause — every filter/sort/pagination step still runs in JS over a fully-queried row set on the
server. This fixes the stated problem (browser RAM, network payload — the client now only ever
holds one page) but not per-request server DB/CPU cost, which stays proportional to total
shipment count on every App.jsx-level unbounded call (initial load, role-switch, manual refresh).
A real SQL rewrite is a larger, separate future pass if this becomes an actual bottleneck.

A genuine race condition was caught and fixed during this same pass, not a pre-existing bug: two
requests in flight at once (React 18 StrictMode's dev-only double-invoked mount effect, or in
production two filter clicks issued in quick succession) could resolve out of order, with the
slower/earlier response silently overwriting a newer filter's already-correct result. Fixed with
a request-generation counter (loadSeqRef) — a response is only applied if no newer request has
been issued since it was sent, discarded otherwise.

Elsewhere, this pass closes a few small pre-existing correctness gaps found while auditing the
app's other tables, alongside the mechanical page-size-dropdown rollout: GET /api/linked-ports
and GET /api/carrier-agents (routes/mdm.js) were mislabeled as paginated — both pages already
imported Pagination and looked like the scaffold, but both backend routes had zero WHERE/LIMIT
support and the "pagination" was a client slice over the entire unbounded fetch; both routes now
support the same opt-in limit/offset/search shape as GET /api/shipments. QuotesPage.jsx and
FreightAuditPage.jsx's invoice list had fully-built backend pagination (routes/quotes.js,
routes/carrier-invoices.js) that the frontend simply never called with limit/offset — a real bug,
not a missing feature: anything past the backend's own default 50-row page was silently
invisible, now fixed by wiring up the existing capability. BillingPerformancePanel.jsx and
InvoiceCollectionsPanel.jsx replace a hard `.slice(0, 200)` client-side cutoff (genuine data
loss past row 200, not just an unpaginated-but-complete list) with real client-side pagination
over the same already-filtered array — chosen over server-side pagination here since both
already fetch their full filtered dataset for client-side multi-facet filtering by design, and
converting that to server-side filtering is a separately-scoped, larger reports-architecture
change. User Management, Dashboard's "Shipments in Period" table, Space Configurations, and the
Archive page get the same client-side treatment — all four are genuinely bounded, non-shipment-
volume datasets (org headcount, a date-filtered view of the same shared array, carrier space
configs), so the lighter, lower-risk client-side slice was the deliberate choice over a
ShipmentsPage-style backend conversion.

Test coverage: tests/pagination-standardization.test.js (24 assertions) exercises the new
status/carrier/search/sort/teu behavior on GET /api/shipments and the new opt-in pagination on
GET /api/linked-ports and GET /api/carrier-agents via real scratch fixtures, confirming every
existing zero-arg caller's bare-array response is unaffected.
```

### 8.19 Zero-Script Onboarding — Sample MDM Database (added v0.79.0)

```
A fresh clone previously needed npm run seed (and, for an already-broken alternate path,
"copy sampleDB/cargodesk.db to the project root") before the app held any real data. Direct
audit found that alternate path was aspirational, not real: sampleDB/ was documented in
README.md/CLAUDE.md, even carried its own changelog entry (v0.18.1), but did not exist on disk
and was never actually committed — git ls-files showed zero tracked .db files in this repo's
entire history.

New db/cargodesk.sample.db (committed, ~2.5MB) replaces it, generated by booting the monolith
against a genuinely empty database (schema + migrations only, no seed data), running the
existing npm run seed import, then layering in the two static reference sets that have no
backing script at all — the full 208-row ISO country list and the 182-row country↔trade-lane
mapping, both of which had only ever been built up a few rows at a time through the admin UI
across this project's history (import-mdm-data.js's own seed only ever created the 4 of each its
own 14 hardcoded trade lanes strictly need). server.js now copies this file to cargodesk.db
automatically on first boot if none exists yet:

  const DB_PATH = path.join(__dirname, "cargodesk.db");
  const SAMPLE_DB_PATH = path.join(__dirname, "db", "cargodesk.sample.db");
  if (!fs.existsSync(DB_PATH) && fs.existsSync(SAMPLE_DB_PATH)) {
    fs.copyFileSync(SAMPLE_DB_PATH, DB_PATH);
  }

The committed file deliberately holds only static reference data — ports, carriers, vessels,
commodities, regions, trade lanes, countries, country↔trade-lane mappings, plus the handful of
migration-seeded structural defaults (milestone/pack-type/container-type templates) every fresh
schema already gets regardless. Two categories were deliberately kept OUT, not overlooked:
  - shipments/contracts/customers/users/anything business-generated — matches the direct
    instruction this shipped against ("they can create their own contracts and configurations").
  - users and org_signing_certs specifically, despite both being non-empty on a normal running
    instance — both already have their own idempotent startup bootstrap (seedAdmin(),
    seedTestFixtureAdmin(), the signing-cert IIFE, all "if none exists, create one" — same idiom
    as backfillPortCountryCodes()), so baking a snapshot into the committed file would be pure
    redundancy at best. For org_signing_certs specifically it would be worse than redundant — it
    holds a private signing key, and every clone sharing the one baked into a committed file
    defeats the point of it being a per-install secret; letting each fresh boot generate its own
    is strictly better. Sanctions/OFAC data (25,865 rows on a real running instance) was excluded
    for a related but distinct reason: a synced snapshot looks live the moment a fresh clone
    boots, but is stale from clone-day forward with no code path to notice — better for a fresh
    install to trigger its own real sync (already-existing app_settings.api_ofac_interval_*
    scheduling) than to ship a snapshot that quietly ages without anyone realizing it's not current.

seedAdmin() itself was corrected in the same pass — it had hardcoded the maintainer's own
personal email/name as the seeded admin account, which both leaked personal identity into this
public repo's source and was already-stale against what README.md documented as the default
(admin@cargodesk.com / admin123). Now reads ADMIN_EMAIL/ADMIN_PASSWORD (optional, e.g. via .env)
falling back to that documented generic default — same disclosed-insecure-default tradeoff as
JWT_SECRET, logged loudly on creation so it's never mistaken for a real credential.
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
| C4 | **`server.js`** — still the composition root (§5), now 4,292 lines. Route handling has moved almost entirely to `routes/*.js` (31 files, 10,057 lines) — a much better split than the last review credited, but the file is still large and still owns schema/migrations, shared runtime helpers, and `ctx` wiring in one place. | Splitting the migrations block into its own module remains a logged, not-yet-executed follow-up. |
| ~~C5~~ | ~~No test suite~~ | **RESOLVED, and grown further** — 36 backend test files (`npm test`), 2 frontend files (Vitest), both wired into CI (`.github/workflows/ci.yml`). |

### High

| # | Issue | Status |
|---|---|---|
| H1 | **`ShipmentDetailPage.jsx`** | **RESOLVED** — was 4,275 lines; now 2,811, with every section broken into its own routed page under `src/pages/shipments/` (§8.11). |
| H2 | **No migration framework** | Still true. Additive-only `ALTER TABLE` array in `server.js`, no version table, no rollback. |
| ~~H3~~ | ~~No pagination on shipments/tickets/cost-lines~~ | **RESOLVED for `shipments`, `quotes`, and `carrier_invoices`** — v0.78.0 (§8.18) gave `GET /api/shipments` real filter/sort/pagination and converted `ShipmentsPage.jsx` to use it, and wired the frontend up to `quotes`/`carrier_invoices`' pagination that already existed server-side but was never called with `limit`/`offset`. `tickets`/`shipment_cost_lines` remain genuinely unpaginated by design (§8.18's own scope note) — both are bounded per-shipment/per-board lists, not the open-ended, business-volume-scaling case this item was actually about. |
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
| L5 | OpenAPI/Swagger spec | Still true — no route documentation beyond this file and inline comments; now covering well over 200 routes across 31 files. |
| ~~L6~~ | ~~Version column on `app_settings`~~ | Not applicable — no migration framework exists to version against (see H2). |
| ~~L7~~ | ~~Containerise with Docker~~ | **RESOLVED** — Dockerfiles + `docker-compose.yml` exist for all 4 processes (§3). |
| L8 | Cost-line validation endpoint (orphaned/missing lines) | Not re-verified — check ticket TKT-1X8R29's current status before assuming either way. |
| ~~L9~~ | ~~`package.json`'s own `"version"` field drifts from `src/version.js`~~ | **RESOLVED v0.78.0** — both bumped together in this pass (`package.json` had drifted to `0.71.0` against `src/version.js`'s `0.76.0`). Still nothing reads `package.json`'s version at runtime, and still no automated check keeping the two in sync — a future bump could drift again if only `src/version.js` is touched. |
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
| Standalone microservices | 6 (Document Distribution :3002, PDF Render :3003, Contract Management :3004, MDM :3005, Screening :3006, Kanban/Testing :3007) |
| Seed data | 14,269 port locations · 21,201 vessels · 69 carriers (per `GET /api/health`'s live counts) |

Every figure above was read directly from the code or a live `GET /api/health` call on
2026-08-13 — none carried over from a prior revision of this document.

---

*Fully refreshed from a direct pass against the live codebase — CargoDesk v0.69.0 "Custodian" ·
2026-08-13. Incrementally updated (§8.14, §8.15, and the data-model/context notes they touch) —
CargoDesk v0.71.0 "Docket" · 2026-08-19. Incrementally updated again (§8.16, and the
CUSTOMERS/ORGANIZATION domain-grouping context it touches) — CargoDesk v0.73.1 "Solvency" ·
2026-08-22, backfilling a feature (Credit Control, shipped v0.57.0) that had never been
documented here at all; §8.16 updated again in place the same day for v0.74.0 "Solvency" to
cover that release's trade-lane override authorization model and grace-window design (Epic
`TKT-6XFJQM` closing pass). Appendix A's metrics were not re-measured in any incremental pass
(see the banner at the top of this document). Next scheduled review: whichever comes first of
(a) the next major structural change (a new microservice extraction, a routing framework
change, a data-store migration) or (b) six months from the 2026-08-13 full pass — whichever is
sooner, so this doesn't repeat a 39-release gap.*
