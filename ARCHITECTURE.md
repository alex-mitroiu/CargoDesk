# CargoDesk — Architecture Reference
**Version:** 0.87.0 "Consortium" · **Date:** 2026-08-29
**Audience:** Software architects, senior engineers, technical reviewers

> This document was fully refreshed from a direct pass against the live codebase on 2026-08-13
> (v0.69.0), replacing a version that had gone stale since v0.30.0. The 2026-08-19 pass was
> **incremental** — it added §8.14 (Reports) and §8.15 (NVOCC Support), the two subsystems that
> shipped since the 2026-08-13 pass. The 2026-08-22 pass was also incremental — it added
> §8.16 (Credit Control), a feature that had shipped as far back as v0.57.0 but was never
> documented here at all; the section covers the whole feature end-to-end, not just the
> v0.73.0–v0.73.1 work that prompted writing it. The 2026-08-25 pass added §8.19
> (Zero-Script Onboarding) and deepened §8.12 (EDI Messaging & Carrier Booking Lifecycle) with the
> eAdapter per-carrier configuration layer, and corrected the banner itself, which had drifted
> stale. This latest pass (2026-08-28, v0.85.0 "Approach" — a single bundled release covering
> four pieces of work built in one continuous session, not four separate versions) adds new
> **§8.20 (Opportunities / CRM Pre-Sales Pipeline)**, rewrites **§8.6 (Space Configurations & TEU
> Accounting)** from its previous "unchanged" placeholder to describe the real Confirmed/Pending/
> Rejected consumption split, extends **§8.12** again with the new "Confirmed with Changes" EDI
> outcome and the Sent-vs-Received comparison table, and extends **§8.9 (Authentication & RBAC)**
> with the multi-tab-aware idle-timeout auto-logout mechanism. The 2026-08-29 pass (v0.86.0
> "Slate") added new **§8.21 (Admin "Reset Demo Data" Panel)**, the in-place-reset sibling of
> §8.19's Zero-Script Onboarding. The same-day v0.87.0 "Consortium" pass extended **§8.15 (NVOCC
> Support)** with the co-loading/cross-tariff-reference story (TKT-UR1X17) and the two earlier
> logged-backlog stories (TKT-9O2B3T, TKT-IB5IEX) — closing Epic TKT-Q52B38 in full; also a
> housekeeping pass across the Kanban board's stale statuses (no new sections). This pass is
> still **incremental,
> not a full re-audit** — every other section between v0.79.0 and this one (the four remaining
> microservice extractions, eAdapter's office-scoping, several credit-control/billing passes) is
> **not** re-verified here; those are already covered by `CLAUDE.md`'s own per-release "Recent
> changes" entries but never folded into this document's own numbered sections, a known,
> pre-existing gap this pass does not attempt to close. Appendix A's line-count/table-count
> figures are still dated to 2026-08-13 and were **not** re-measured. See `CLAUDE.md`'s own
> "Recent changes" sections for a release-by-release changelog this document doesn't restate —
> treat that file as the day-to-day source of truth and this one as the standing structural
> reference.
>
> A companion visual diagram, `dev/architecture.html`, is dated v0.20.0 (2026-07-03) and remains
> **not** refreshed — it's now well over 65 releases behind and should be treated as a
> historical snapshot, not a current reference, until someone rebuilds it.

---

## Table of Contents
_(§8.15 extended 2026-08-29 (v0.87.0); §8.21 added 2026-08-29 (v0.86.0); §8.20, and the §8.6/§8.9/§8.12 extensions, added 2026-08-28 (v0.85.0); §8.19 and the version-banner fix added 2026-08-25; §8.12 deepened 2026-08-25; §8.17–8.18 and the §5 routes/ table added 2026-08-24; §8.16 added 2026-08-22; §8.14–8.15 added 2026-08-19; everything else reflects the 2026-08-13 pass)_
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

**78 tables** in the monolith's own `cargodesk.db` (77 as of the 2026-08-25 pass, +1 for
`opportunities`, §8.20 — up from the 35–54 this doc previously and inconsistently claimed), plus
the Contract Management service's own 4-table copy
(`contracts`/`contract_legs`/`contract_rates`/`contract_routings`) when `contract_source='remote'`
(§8.1) — never both populated as the live source at once.

### Domain groupings (representative, not exhaustive — see server.js for the authoritative list)

```
PRE-BOOKING
───────────
opportunities                              (New→Qualified→Converted/Lost, §8.20 — precedes and
    └── converted_quote_id → quotes         converts into a Quote, no line-item child table)
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
            ├── shipment_edit_locks          (first-come-first-served whole-shipment edit lock,
            │                                 one row per currently-locked shipment, §8.22)
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
carriers · vessels · port_locations ── linked_ports
regions ── countries ── country_trade_lanes · trade_lanes ── allocations
commodities · charge_code_definitions · pack_type_definitions
carrier_agents ──┬── carrier_agent_locations       (header = carrier x agent customer; each
                  │                                 location row is EITHER a specific UN/LOCODE
                  │                                 OR a whole country — restructured from an
                  │                                 earlier one-row-per-port shape so one Line
                  │                                 Agent can cover several locations at once)
                  └── carrier_agent_schedule_rows   (working-hours rows, day-grouped)
carrier_agents.capabilities                          (JSON array of service capability codes —
                                                       see §8.1's Carrier Agents subsection)

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
prefix this pass: `OPP-` (opportunities, §8.20).

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
| **Document Distribution** (`services/document-distribution/`, v0.64.0) | 3002 | Outbound document delivery (email/webhook) has its own retry/failure profile, distinct from request/response HTTP | Postgres (Phase 0 of the Postgres migration, §13 — `pg` when `DATABASE_URL` is set, embedded `@electric-sql/pglite` otherwise; was SQLite before this) — webhook configs, delivery attempts |
| **PDF Render** (`services/pdf-render/`, v0.65.1) | 3003 | The heaviest, most bursty thing the monolith did per-request (a full headless-Chromium launch) — see §12 for the full reasoning | Stateless — no database at all |
| **Contract Management** (`services/contract-management/`, v0.68.0) | 3004 | First real "toggle between local and remote" extraction — proves the pattern before Epic 5 (Customer/Organization) needs it | Postgres (Phase 4 of the Postgres migration, §13 — `pg` when `DATABASE_URL` is set, embedded `@electric-sql/pglite` otherwise; was SQLite before this), a straight port of `contracts`/`contract_legs`/`contract_rates`/`contract_routings` |
| **MDM** (`services/mdm/`, v0.80.0) | 3005 | Second "toggle between local and remote" extraction, following the sequencing proposed in `documentation/splitting-mdm-first.html` — the lowest-blast-radius domain (no request-path involvement, no outbound FK from any of its tables into shipments/customers/users) | Postgres (Phase 5 of the Postgres migration, §13 — `pg` when `DATABASE_URL` is set, embedded `@electric-sql/pglite` otherwise; was SQLite before this, the last microservice to migrate): `carriers`/`vessels`/`port_locations`/`linked_ports`/`trade_lanes`/`country_trade_lanes`/`regions`/`countries`/`commodities`/`carrier_agents`/`carrier_agent_locations`/`carrier_agent_schedule_rows` |
| **Screening** (`services/screening/`, v0.81.0) | 3006 | Third "toggle between local and remote" extraction — externally-sourced denylist data, zero outbound FK, read via name-match not JOIN (`documentation/splitting-sanctions-next.html`) | Postgres (Phase 1 of the Postgres migration, §13 — `pg` when `DATABASE_URL` is set, embedded `@electric-sql/pglite` otherwise; was SQLite before this): `sanctions_entries`/`sanctions_syncs`, plus a small local `settings` table for its own auto-sync schedule (no admin UI for it yet — see below) |
| **Kanban/Testing** (`services/kanban/`, v0.82.0) | 3007 | Fourth "toggle between local and remote" extraction — a feature the roadmap expects to eventually go away entirely (`documentation/splitting-kanban-out.html`), so keeping its schema fully separable now avoids leftovers later | Postgres (Phase 3 of the Postgres migration, §13 — `pg` when `DATABASE_URL` is set, embedded `@electric-sql/pglite` otherwise; was SQLite before this): `tickets`/`ticket_links`/`test_items`/`test_case_links`/`kb_projects`/`kb_versions`/`kb_columns` |
| **Customer/Organization** (`services/customers/`, v0.84.0) | 3008 | Fifth and final "toggle between local and remote" extraction, and the last story of the 5-epic Organization Model roadmap begun at v0.56.0 — deliberately sequenced last, after the data model had fully settled | Postgres (Phase 2 of the Postgres migration, §13 — `pg` when `DATABASE_URL` is set, embedded `@electric-sql/pglite` otherwise; was SQLite before this): `customers`/`customer_identifiers`/`customer_contacts`/`customer_screenings`. `customer_documents` and `customer_roles` are deliberately excluded — see the Customer-specific notes below |

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

**Carrier Agents restructured (header + locations, not one-row-per-port)**: `carrier_agents` was
originally `UNIQUE(carrier_code, port_unlocode)` — exactly one port per row, so covering several
locations with the same agent meant several independent rows with no shared identity. It's now a
pure header (`carrier_code` x `agent_customer_id`, `UNIQUE(carrier_code, agent_customer_id)`) with
a new child `carrier_agent_locations` table — each row is EITHER a specific UN/LOCODE OR a whole
country (`location_type` CHECK constraint), so one Line Agent config can cover several ports and/or
entire countries at once ("a Line Agent in Spain can also handle the shipment in Andorra" is one
header with an ES row and an AD row). A guarded, one-time create-copy-swap migration
(`rebuildCarrierAgentsLocations`, mirrored identically in both the monolith and the MDM Service,
since both own an independent copy of this schema) groups every pre-existing row by
`(carrier_code, agent_customer_id)` into one header with one location each — lossless for
carrier/agent/location, with only a differing note across grouped rows unable to all survive (the
header keeps the first). **A real gotcha hit during this migration**: SQLite's `ALTER TABLE ...
RENAME TO` silently rewrites any OTHER table's foreign-key reference that points at the renamed
table — since `carrier_agent_locations` is created (with an FK to `carrier_agents(id)`) by the flat
migrations array *before* this guarded rebuild runs, renaming `carrier_agents` to a scratch name
mid-rebuild left `carrier_agent_locations`'s FK dangling at the about-to-be-dropped scratch table.
Fixed by dropping and recreating `carrier_agent_locations` fresh inside the same guarded rebuild,
after the real `carrier_agents` table exists again.
`resolveCarrierAgent`/the MDM Service's `/internal/carrier-agents/resolve` both now try a direct
UN/LOCODE match first, then fall back to the port's own country before finally trying linked
ports — so a shipment can resolve its Line Agent through a country-level config even when no
UN/LOCODE was ever configured directly for that port. Redundancy is enforced both ways: adding a
UN/LOCODE already covered by an existing country-level row on the same header is rejected outright
(nothing to discard, since it was never saved); adding a country that makes existing UN/LOCODE
rows on the same header redundant auto-discards them and logs each discard to `entity_events`
(`entity_type='carrier_agent_location'`, `event_type='DISCARDED_REDUNDANT'`) — never a silent
removal. A separate check rejects any location (UN/LOCODE or country) already claimed by a
*different* header for the same carrier, so at most one Line Agent ever owns a given location per
carrier. The header-create route wraps the header insert and its first location insert in one
transaction — an earlier version left an orphaned, location-less header behind whenever the
location insert failed, caught live during verification and fixed.
**Named, accepted gap**: 11 secondary read sites beyond these (`routes/reports.js`,
`allocations.js`'s own linked-port matching, `shipment-ops.js`, `command-center.js`,
`customers.js`, `export.js`, `organization.js`, `system.js`, `ais.js` (Simulator), plus
`scripts/checkdb.js`) still read MDM tables directly from the monolith's local schema regardless
of `mdm_source` — mostly read-only display JOINs where staleness post-cutover is cosmetic, not
data loss, but flagged rather than silently chased in this pass. Don't flip `mdm_source=remote` in
an environment exercising Reports/Export/Command Center/the AIS Simulator until this is closed.

**Carrier Agents — Working Schedule and Capabilities added on top of the header+locations
restructure above** (same session, direct follow-up feedback): a new child
`carrier_agent_schedule_rows` table (`carrier_agent_id`, `days` JSON array, `start_time`,
`end_time`, `sort_order`) records a header's working hours as however many day-grouped rows an
operator configures (e.g. "Mon–Tue 09:00–18:00" / "Wed, Fri 09:00–13:00" / "Thu 09:00–19:00") —
mirrored identically in both the monolith and the MDM Service, same as every other Carrier Agents
table. A day can only belong to one row at a time; the frontend enforces this by clearing a
clicked day from every other row in the same table the instant it's toggled on a new one, rather
than validating after the fact. New `carrier_agents.capabilities` column (`TEXT DEFAULT '[]'`,
same JSON-array-on-a-flat-column idiom `contract.imdg_classes` already established) holds a
checklist of service capabilities (road/rail/barge haulage, warehousing, CY storage, customs
clearance, documentation, port agency, fumigation, empty equipment) — not yet cross-checked
against anything; it exists so a future pass can validate an assigned Line Agent actually
supports the carrier's haulage arrangement on a given leg before a booking is sent, catching a
carrier rejection or forced rebooking before it happens rather than after.
**UI consolidation, per explicit design-pattern correction**: this MDM page's own Add/Edit modal
was pushed through three shapes before landing — inline per-row page controls, then a split
across several modals — before direct feedback settled on one rule this codebase's other MDM
pages already followed and this one had briefly deviated from: a search/maintenance page's own
Edit modal touches only the entity's direct fields, with row-by-row sub-resource configuration
(locations, schedule, capabilities) living inside that single modal as tabs, never on the page
itself or spread across separate dialogs. The final shape is one Add modal and one Edit modal,
each with four tabs — Coverage (Locations sub-tab + the new Working Schedule sub-tab),
Capabilities, Notes, and a read-only Address & Contact tab that live-reads the linked customer's
`GET /internal/customers/:id`/contacts rather than duplicating that data onto `carrier_agents`.
`carrier_agent_schedule_rows` was added straight into the flat migrations array (a plain
`CREATE TABLE IF NOT EXISTS`, no guarded rebuild needed) and was never at risk from the RENAME
gotcha above — that only bites a table whose FK exists *before* `rebuildCarrierAgentsLocations`
runs its one-time rename, and that guard had already fired (and won't fire again) on any database
that already carries the post-restructure header+locations shape. Worth remembering for any
*future* child table added onto `carrier_agents` on a database that still predates the original
restructure, though — the same drop-and-recreate-after-the-rename fix `carrier_agent_locations`
needed would apply again.

**Line Agent resolution can now return several candidates, not just guess at one** (added
v0.89.0, direct follow-up): `resolveCarrierAgent(carrierCode, portUnlocode)` tries a direct
UN/LOCODE match, then the port's own country, then falls back through every linked port in turn —
the first two tiers are exclusivity-enforced at write time (only one `carrier_agents` header can
claim a given port or country per carrier), so they can only ever produce 0 or 1 result. Genuine
ambiguity can only come from the linked-ports tier: `linked_ports` has no constraint stopping one
port from being linked to several others, so if two or more of a port's linked ports each have
their own independent, valid agent for the same carrier, the old code silently returned whichever
one happened to come first in an unordered SQL scan. New `resolveCarrierAgentCandidates(carrierCode,
portUnlocode)` returns every tied candidate instead of guessing (each tagged with `matched_via`,
the actual port that produced it); `resolveCarrierAgent` is now a one-line wrapper —
`candidates[0] || null` — so its two pre-existing callers (`routes/shipments.js`,
`routes/quotes.js`'s own small duplicate of `maybeAssignLineAgents`) needed no signature change for
the common, unambiguous case. Both copies of `maybeAssignLineAgents` now only auto-assign when
`candidates.length === 1`; a 2+ side is deliberately left unassigned rather than guessed, exactly
matching this app's existing "no match = leave it unfilled" behavior, just for a different reason.
The MDM Service's own `/internal/carrier-agents/resolve` gained a parallel `all=1` query flag
returning an array instead of one row, kept in exact parity with the monolith's local logic per
this carrier-agent feature's own established convention of mirroring the two implementations.
**Chosen UX deliberately mirrors the existing Pending-Contract-Revalidation pattern, not the
Contract-Mismatch one**: `ShipmentHeaderBar.jsx` shows only a dismissible-elsewhere badge (new
`GET /api/shipments/:id/line-agent-candidates`, read-only, only reports a side that's still
unfilled AND has 2+ candidates) rather than forcing an inline blocking modal — an unresolved Line
Agent already behaves exactly like a shipment with none registered at all, so there's nothing to
force. The actual picker (`LineAgentCandidatesModal`, `AdditionalPartiesPanel.jsx`) lives on the
Parties & Offices page with its own independent re-detection (no shared state with the header,
same split Pending Revalidation already established) and resolves a pick through the
**already-existing** `POST /api/shipments/:id/parties` — picking a candidate is exactly the same
operation as manually adding that party, so no new write endpoint was needed.

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

**System Health now actually reflects a microservice architecture.** `HealthModal.jsx`'s checks
predated most of the extractions above and only ever probed the monolith itself plus two external
APIs (FX, Weather) — none of the 7 standalone services (Document Distribution, PDF Render,
Contract Management, MDM, Screening, Kanban/Testing, Customer) appeared anywhere in it, despite
each being a real, independently-deployable process this app depends on. `GET /api/health`
(`routes/system.js`) now server-side-probes every service's own unauthenticated `GET /health` in
parallel (2.5s timeout each, `Promise.all`) and folds the results into a new `services` field on
its response, plus a new `ais` field sourced from `getAisListenerStatus()` (a free, in-memory read
— `lib/ais-listener.js`'s persistent outbound WebSocket has no request/response health endpoint of
its own to probe). Both are server-aggregated rather than fetched directly by the browser because
this app runs no CORS middleware — a page origin on :5173 can't reach a service on :3002-:3008
directly. `HealthModal.jsx` reads both new fields off the same `/api/health` call its own "API
Server" row already made, rendering a new "Microservices" category (one row per service) and an
AIS row under "External" — no second round trip. Also widened the Internal category to cover a
few more real feature APIs that had no row at all (Quotes, Opportunities, Integration Board,
Sanctions Screening).

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

### 8.6 Space Configurations & TEU Accounting (deepened v0.85.0 — Space Consumption Split)

An `allocations` row's TEU consumption is now split three ways, not one flat number. Before this
pass, `loadConsumedTeuMap()` (`routes/allocations.js`) summed every linked shipment's TEU with
zero regard for the state of its carrier booking — a `Created` (not-yet-sent) booking, one still
`Pending` a carrier reply, and a genuinely `Confirmed` one all counted identically.

```
loadTeuBuckets()  (routes/allocations.js, renamed from loadConsumedTeuMap)
  LEFT JOIN carrier_bookings cb ON cb.shipment_id = s.id
  GROUP BY s.allocation_id, cb.status
  →  Map<allocationId, { confirmedTEU, pendingTEU, rejectedTEU }>

Bucket rule:
  Confirmed                              → confirmedTEU   (deducts: remainingTEU = allocated − confirmed)
  Created | Pending | no booking row yet → pendingTEU     (informational only)
  Rejected                               → rejectedTEU    (own visible segment, informational only)
  Cancelled                              → excluded entirely (no live demand left)
```

The deducting bucket is keyed on `carrier_bookings.status` specifically — the **operator's own
explicit Confirm click** (`PATCH .../carrier-booking/confirm`) — not `last_response_status`, the
carrier's raw EDI reply. This split predates the deduction question by design (v0.35.0): a
confirmed EDI response has never auto-finalized a booking, only the operator's own action does.
All four call sites that used to spread `consumedTEU`/`remainingTEU` (`GET`/`POST`/
`PUT /api/allocations`, `GET /api/allocations/match`) now spread the three buckets plus the
recomputed `remainingTEU`. Zero schema migration — every column involved was already a plain
TEXT field with no CHECK constraint.

New shared `src/components/shared/ConsumptionBar.jsx` (a 3-segment stacked div, not a chart
library) renders this everywhere the split needs to appear —
`SpaceConfigurationsPage.jsx`'s table row and its Linked Shipments modal,
`ShipmentSchedulesPage.jsx`'s Space Configuration panel, `ShipmentFormPage.jsx`'s Contract Picker
card, and (client-side bucketed the same way, since that page never reads the allocation's own
fields) `DashboardPage.jsx`'s Overview KPIs/chart and Contract Consumption tab. When demand
exceeds capacity the three segments compress proportionally rather than overflowing past 100%,
with a small "+N over" caption naming the real gap instead of hiding it.

`DashboardPage.jsx` — the page literally titled "Consumption Dashboard" — is a deliberately
**separate** client-side computation from `loadTeuBuckets()`, not a consumer of it: it re-derives
TEU totals from `rangeShipments`+`containers`, matched to allocations via its own carrier/
route/contract heuristic (`allocContractMatch`), scoped to a selectable date range — a genuinely
different question ("how much moved in this window") from the allocation's own live, unscoped
state. Both now apply the identical Confirmed/Pending/Rejected bucket rule (keyed off
`shipment.bookingStatus`, already present on every shipment row via the existing
`LEFT JOIN carrier_bookings` in `GET /api/shipments`) independently, so the two pages agree on
what each color means even though their underlying scoping intentionally differs. A third,
still-independent figure — `DashboardPage.jsx`'s Carrier Volumes tab — is explicitly **not**
bucketed this way: it's a raw all-status freight-volume metric by design, unrelated to allocated
space, and was confirmed out of scope for this pass.

### 8.7 WebSocket — per-shipment subscription, not blanket broadcast

This is a genuine change from the last review, which described a single `broadcast(type,
payload)` reaching every connected client. The actual model:

```
shipmentSubs: Map<shipmentId, Set<WebSocket>>   (server.js, shared via ctx)

Client subscribes to one specific shipment (sent while its detail page is open); server adds
the socket to that shipment's Set. Any route module can push to just that shipment's viewers:

  broadcastMessage(shipmentId, payload)     → { type: "new_message", ... }        (server.js)
  recomputeSpaceBadge(shipmentId)           → { type: "space_badge_update", ... } (server.js)
  broadcastEditLockChange(shipmentId, ...)  → { type: "edit_lock_changed", ... }  (server.js, §8.22)
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

### 8.9 Authentication & RBAC (extended v0.85.0 — idle-timeout auto-logout)

The role hierarchy has grown from 3 roles to 5: `VALID_ROLES = ["admin", "operator", "occ_bk",
"trade_manager", "viewer"]` (`server.js`). `occ_bk` and `trade_manager` are newer, narrower roles
— most route-level `requireRole([...])` guards now list a specific subset (e.g.
`["admin","operator","occ_bk"]` for most day-to-day writes) rather than a single linear rank
check. A user can hold multiple roles (`users.roles`, JSON array); `primaryRoleSV()` picks the
highest-ranked one where a single role is needed. JWT mechanics (8-hour token, `cargodesk_token`
in `localStorage`, `auth()` middleware) are unchanged.

**Idle-timeout auto-logout, multi-tab aware.** After a hardcoded 30 minutes of no user activity
anywhere, every open tab is logged out and redirected to login. The threshold is deliberately
static, not an `app_settings` row — it lives in a new `config/app-settings.yaml`, read once at
boot by new `lib/staticConfig.js` (via `js-yaml`, falling back to the same default with a warning
if the file is missing/malformed) and merged into `GET /api/settings` as `idleTimeoutMinutes`, so
the frontend needed no new endpoint.

```
src/hooks/useIdleLogout.js
  Activity (mousemove/mousedown/keydown/scroll/touchstart, throttled ~5s)
    → localStorage["cargodesk_last_activity"] = Date.now()     (shared across every tab)
  setInterval(~15s): if now − last_activity ≥ threshold → onIdle()
    → clears localStorage["cargodesk_token"]  (same mechanism api.js's own 401 handler uses)
    → localStorage["cargodesk_logout_reason"] = "inactivity"   (idle-specific — see below)

  storage event listener (always attached, independent of login state):
    e.key === TOKEN_KEY && !e.newValue && reason === "inactivity" → this tab logs itself out too
```

Because every tab writes the *same* shared activity timestamp, idle is correctly a property of
the whole session, not of one forgotten tab — activity in a shipment opened in a second tab keeps
the entire session alive. Cross-tab cleanup needs no custom sync channel: clearing
`localStorage["cargodesk_token"]` fires a native browser `storage` event in every *other* open
tab automatically (never in the tab that made the change) — the same signal the API layer's own
forced-logout-on-401 already relies on, just triggered by a different cause. A real gap was
caught before shipping: a plain manual "Log out" and a 401 also clear that same token, which
would otherwise make other tabs wrongly display the inactivity banner for an unrelated logout —
resolved with the separate `cargodesk_logout_reason` key, set only by the idle path and cleared
on every successful login, so a stale flag from an earlier idle event can never survive to
mislabel a later, unrelated logout.

Each tab remembers its own last screen independently via `sessionStorage` (per-tab, unlike
`localStorage`) — captured the instant that tab logs itself out (directly or via the cross-tab
broadcast) and restored right after that same tab's next successful login. This is deliberately
scoped to the idle path only: a deliberate manual logout still lands on the default home screen
rather than silently reopening whatever was on screen before.

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

### 8.12 EDI Messaging & Carrier Booking Lifecycle (deepened v0.79.0 — eAdapter; office-scoped v0.83.0; third outcome v0.85.0)

**A genuine third simulated carrier-response outcome, "Confirmed with Changes" (v0.85.0).** Until
this pass, a simulated reply (Test Tools → Message Simulator) was strictly binary — `confirmed`
or `rejected`. A real carrier routinely confirms a booking with a different vessel/voyage/ETD
than what was actually requested; that state didn't exist anywhere. `routes/edi.js`'s three
response builders (`simulatedConfirmedResponse`/`simulatedConfirmedWithChangesResponse`/
`simulatedRejectedResponse`) now all start from a new `getLastOutboundPayload()` — the full
outbound `booking_request` payload, not each builder's own thin ~6-field subset as before — so
the inbound message's `raw_payload` always carries the complete field set to compare against; the
new outcome overrides only the fields the carrier actually changed. `applyBookingResponse`'s
`inType` ternary was inverted (`rejected → booking_reject`, everything else →
`booking_confirmation`) to stay 3-way-safe; its status ternary needed **no** change, since it
already special-cased only `"rejected"` — a confirmed-with-changes response correctly leaves
`carrier_bookings.status` at `Pending` until the operator's own Confirm action, exactly like a
plain `confirmed` reply already does. Confirming afterward still does not auto-rewrite the
shipment's own schedule/legs with the carrier's proposed values — the deliberate
`carrier_bookings`/`shipment_schedules` decoupling from v0.35.0 is unchanged and unreopened.

New **Sent vs. Received comparison table** on the Carrier Booking Review tab
(`ShipmentCarrierBookingReviewPage.jsx`) — one row per outbound payload field, column headers,
differing rows highlighted with a colored left border and bold Received value. Built entirely
client-side from data the page already fetches (the newest outbound and inbound `edi_messages`
rows via `api.ediMessages.list`), no new endpoint.

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

### 8.15 NVOCC Support (added v0.71.0, extended v0.87.0, Epic TKT-Q52B38 — now fully closed)

```
An NVOCC (Non-Vessel Operating Common Carrier) is legally both a carrier (to its own customer,
on a House B/L) and a shipper (to the real vessel operator, on a Master B/L) for one physical
movement — audited against a detailed mechanics brief rather than assumed. Published as a
7-finding artifact against the original v0.71.0 pass; 4 closed immediately, 3 logged as scoped
backlog (a full structural dual-carrier/principal field split, a two-stage destination release
workflow, NVOCC co-loading/cross-tariff reference). All 3 have since closed — the last,
co-loading, at v0.87.0. Deliberately NOT the same gap as LCL/consolidation, which stays deferred
under the standing FCL-first roadmap — the House/Master split is real even for a single-shipper
FCL container with zero consolidation involved.

Closed at v0.71.0, all additive (no existing behavior changes when no NVOCC is involved):
  - "NVOCC" party role — resolves via the existing shipment_parties mechanism, zero new party
    infrastructure.
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

Closed later, resolved via the same party-role mechanism rather than a new field pair (TKT-9O2B3T
had explicitly left that choice open — "needs a scoping pass on whether this is a new field pair
or a party-role-based resolution"):
  - Structural dual carrier/shipper split (TKT-9O2B3T) — shipments.carrier_code always means "the
    real vessel-operating carrier," unchanged everywhere internal (booking, schedule, EDI, Master
    B/L). The assigned NVOCC party already carries the customer-facing carrier-of-record identity
    end to end (House B/L caption, Master B/L Shipper); the one gap was the public tracking page
    (GET /api/share/:token) not surfacing it — fixed by adding nvoccName to that response.
  - Destination deconsolidation / two-stage release (TKT-IB5IEX) — shipments.master_bl_release_type
    is a genuinely separate column from bl_release_type: the vessel operator's release to the
    NVOCC's own destination agent (Master B/L side) vs. the NVOCC's later release to the actual
    consignee (House B/L / Delivery Order side). Both independently editable
    (ShipmentFormPage.jsx), both displayed (ShipmentConditionsPage.jsx), both rendered with
    correct semantics on the Master B/L. Narrower than "model the NVOCC's own destination agent
    as a real party" (still not done) — this closes the release-event tracking gap specifically.

Closed at v0.87.0 — NVOCC co-loading / cross-tariff reference (TKT-UR1X17, lower priority, "cover
ALL gaps" completeness item): one NVOCC occasionally has no direct contract with the vessel
operator for a lane and tenders cargo through ANOTHER NVOCC's own tariff instead. New
"Co-Loading NVOCC" party role (13th entry in ADDITIONAL_PARTY_ROLES) plus a free-text
shipments.coload_tariff_reference column (mirrors contract_ref's own nature — there's no real
registry of another NVOCC's tariff in this system). buildMasterBillOfLadingHtml resolves the
Co-Loading NVOCC (when assigned) as the real Shipper instead of the primary NVOCC — it's the one
that actually holds the direct Master B/L relationship with the vessel operator — with two
additive detail rows ("Co-Loaded Via," the underlying NVOCC's name, and the tariff reference
itself) shown only when a co-loading party exists; byte-identical to the direct case otherwise.
Verified live via CDP end-to-end: assigned both an NVOCC and a Co-Loading NVOCC party on a real
scratch shipment, generated the actual Master B/L through the real UI, and confirmed the
intercepted client-built HTML (before it reaches the server's signing step) correctly named the
Co-Loading NVOCC as Shipper and carried both new detail rows with the right data.

shipments.master_bl_number/bl_release_type already existed before v0.71.0 (an earlier migration's
own comment already referenced NVOCC) but were only a caption field on BL01 — the gap this epic
closed, across all its passes, was that nothing else in the system (party model, licensing, the
booking payload, a second document, the two-stage release, co-loading) knew an NVOCC could exist.
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

### 8.20 Opportunities / CRM Pre-Sales Pipeline (added v0.85.0)

```
opportunities (New → Qualified → Converted (to Quote, Qualified only) | Lost (New or Qualified))
  — no line-item child table: an opportunity is pre-pricing, real line-item detail belongs on
  the Quote it converts into. Only `title` is required; customer is captured via the existing
  CustomerCombobox in its already-supported unresolved (name-only, no real `customers` row)
  state — no new "prospect" customer concept anywhere in the schema.

No separate "Won" status. Converted IS the win condition — whether the resulting quote then
actually closes is that quote's own already-shipped Draft→Sent→Accepted→…→Converted(to
shipment) lifecycle to own from there, not re-derived on the opportunity.

Conversion (POST /api/opportunities/:id/convert, Qualified only):
  1. INSERT quotes — copies only the fields an opportunity actually has: customerId/
     customerName/pol/pod/carrierCode/commodityCode/movementType/currency/notes. contractId/
     contractRef/incoterm/serviceType/cargoReadyDate have no opportunity equivalent and are
     left at the quote's own table-level defaults.
  2. Deliberate guard: estimatedCloseDate is never written into the new quote's
     cargoReadyDate — "when we expect to close this deal" and "when cargo is ready to ship"
     are unrelated concepts that happen to both be dates near a quote's creation; conflating
     them would silently corrupt the new quote.
  3. Stamps converted_quote_id/converted_at on the opportunity, flips it to Converted.
  4. logEntityEvent on both entities, shaped identically to POST /api/quotes' own CREATED log
     so a converted quote's audit trail reads the same regardless of origin.
  5. Response returns { opportunity, quoteId, quote } — the full mapped quote inline, same
     "the SPA's local array needs the real record before navigating to a page it doesn't
     otherwise know about yet" reason §8.2's own quote→shipment conversion already documents.
```

Built entirely as a structural mirror of §8.2 (Quoting/RFQ), verified directly against the real
code rather than assumed: `routes/opportunities.js` mirrors `routes/quotes.js`'s route-factory
shape and lifecycle-transition-route pattern; `OpportunitiesPage.jsx` mirrors `QuotesPage.jsx`'s
list-page/detail-modal frontend shape; `tests/opportunities.test.js` mirrors
`tests/quoting-rfq.test.js`'s scaffolding, including chaining a full happy-path conversion
straight into the resulting quote's own already-shipped Send/Accept/Convert-to-shipment
lifecycle — proving the two features compose, not just that the conversion response shape looks
right. Sidebar places Opportunities directly above Quotes (`App.jsx`'s `NavBtn` order), matching
the real funnel: Opportunity → Quote → Shipment.

**Flat table + modal, not a kanban-style pipeline board** — explicitly chosen after confirming no
reusable stage/column component exists anywhere in the codebase (`KanbanPage.jsx`'s own board is
a single ~4,300-line file, hardcoded ticket-workflow columns, native HTML5 drag-and-drop, zero
reusable pieces). A genuine drag-and-drop pipeline board remains real, valuable, explicitly-named
future work — not silently deferred by this choice.

### 8.21 Admin "Reset Demo Data" Panel (added v0.86.0)

```
Direct request: a way for an admin to wipe all demo/business data back to a clean slate while
keeping MDM reference data (and a few adjacent things, below) intact — so the .db file could
eventually be committed and a fresh clone (or a repeat demo run) starts from a known-good
baseline instead of needing `npm run seed` or manual cleanup. Explicitly not wanting the acting
admin's own real user account exposed in that baseline.

The in-place-reset sibling of §8.19's Zero-Script Onboarding — that mechanism only fires on first
boot when no cargodesk.db exists yet; this adds an admin-triggered, in-place reset of an
already-running database, no restart needed. Scoped to local-mode data only — the five extracted
microservices each keep their own DB file when *_source='remote'; this reset can only reach the
monolith's own local tables, by design.
```

**`PRESERVE_TABLES` is the single source of truth** (`routes/admin-reset.js`) — reset is computed
dynamically as `(live schema via sqlite_master) − PRESERVE_TABLES`, never a hand-maintained mirror
of what gets deleted:

| Group | Tables |
|---|---|
| MDM core | `carriers`, `vessels`, `port_locations`, `linked_ports`, `regions`, `countries`, `country_trade_lanes`, `trade_lanes`, `commodities` |
| Admin-maintained registries | `charge_code_definitions`, `pack_type_definitions`, `container_type_definitions`, `duty_rate_chapters`, `milestone_templates`, `invoice_status_reason_codes` |
| Compliance reference data | `sanctions_entries`, `sanctions_syncs` |
| App-level infra config | `app_settings`, `system_email_settings` |

19 tables total, preserved because they're reference/registry data or infra config, not tied to
any specific demo scenario or person. Every other table — 66 as of this release, `users` and
`org_signing_certs` included — is wiped. Deriving the reset list from the live schema rather than
enumerating it is deliberate: a **new** table added in a future release defaults to being wiped
unless someone explicitly adds it to `PRESERVE_TABLES` — the safer failure direction for a
"clean slate" feature (leftover demo data after a reset is a much smaller problem than silently
nuking a future reference table nobody remembered to exempt).

**`users`/`org_signing_certs` are wiped then immediately re-seeded, not preserved as-is** — the
direct resolution to "I do not want to expose my user account": keeping the acting admin's real
account in a shareable baseline would defeat the whole point of the feature, and leaving `users`
empty afterward would lock everyone out of the freshly-reset instance. `server.js` already had
exactly the right idempotent bootstrap for this, just as three previously-anonymous boot-time
IIFEs — `seedAdmin()` (generic `admin@cargodesk.com`/`admin123`, or `ADMIN_EMAIL`/`ADMIN_PASSWORD`
if set), `seedTestFixtureAdmin()` (`claudeagent@localhost`), `seedSigningCert()`. These were
refactored into named, reusable function declarations (identical bodies, still called once at
boot exactly as before) and exposed via `ctx` so the new reset route can call all three again
immediately after the delete sweep — the database ends up in exactly the state a genuinely fresh
boot would produce, not a bespoke new one.

```js
// routes/admin-reset.js
app.post("/api/admin/reset-demo-data", auth(), requireRole(["admin"]), (req, res) => {
  if (req.body?.confirm !== "RESET") return err(res, 'Type RESET to confirm this irreversible action');
  const allTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);
  const toReset = allTables.filter(t => !PRESERVE_TABLES.has(t));

  db.exec("PRAGMA foreign_keys=OFF");   // same bracketing idiom this codebase's own
  db.exec("BEGIN");                     // table-rebuild migrations already use
  try {
    for (const t of toReset) db.exec(`DELETE FROM ${t}`);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); db.exec("PRAGMA foreign_keys=ON"); return err(res, e.message, 500); }
  db.exec("PRAGMA foreign_keys=ON");

  seedAdmin(); seedTestFixtureAdmin(); seedSigningCert();  // re-bootstrap, same as a fresh boot
  logAdminEvent(req.user, "RESET_DEMO_DATA", "system", "", { tablesCleared: toReset.length });
  ok(res, { reset: true, tablesCleared: toReset.length });
});
```

Table names in the `DELETE FROM` loop come exclusively from `sqlite_master` filtered against a
fixed internal `Set` — never from request input — so there's no injection surface despite the
string interpolation. `GET /api/admin/reset-demo-data/preview` (same file) returns the live
preserve/reset arrays unauthenticated-to-content (still `admin`-gated) so the frontend never has
to hardcode the table list either.

**Frontend** — new admin-only **"Danger Zone"** tab (`AppSettingsPage.jsx`, `DangerZonePanel`): a
red-tinted warning card naming exactly what's preserved vs. reset in plain language (explicitly
including "your own account"), two live scrollable chip lists sourced from the preview endpoint,
a text input that must exactly match `RESET` before the button enables, and — on success — a
forced modal showing the fresh generic login credentials before calling the exact same
`localStorage.removeItem(TOKEN_KEY); window.dispatchEvent(new Event("cargodesk:logout"))`
sequence `src/api.js` already uses on any 401, so the now-invalid session is torn down through
the one existing mechanism rather than a second bespoke logout path.

**Deliberately not exercised end-to-end in the automated suite** — the same class of decision
this codebase already made for `POST /api/sanctions/sync|sync-csl|import-csv` (v0.72.2's own
changelog: "destructively replaces the live synced dataset other tests depend on"). Running the
real wipe path inside `npm test`'s shared-process suite would destroy this dev database's own
accumulated history on every CI run. `tests/admin-reset.test.js` (13 assertions) covers only the
fully safe guardrails — preview shape/content, the confirmation-string gate (missing/wrong/
lowercase all rejected), and the admin-only role gate on both endpoints. The real destructive
path was instead verified directly, once, against the actual dev database, backed up first: the
server was stopped, `cargodesk.db`/`-shm`/`-wal` copied aside, restarted, baseline counts recorded
(71 carriers / 16 users / 160 shipments), a scratch shipment created, the real
`POST /api/admin/reset-demo-data` call made with `confirm: "RESET"`, and the response and
resulting state confirmed exactly as designed — 68 tables cleared, carriers still 71, `users`
collapsed to just the two generic seeded accounts, shipments at 0, `app_settings` (including the
idle-timeout config from v0.85.0) fully intact — before the original database was restored from
the backup and every original count (71/16/160) confirmed back exactly.

### 8.22 Shipment Edit-Locking (added v0.88.0)

```
Direct request: two edit-capable users (admin/operator/occ_bk) on the same shipment at the same
time can produce conflicting writes, and this app has no field-level merge/conflict resolution
anywhere — not on the shipment record, not on any of its sub-resources (containers, parties,
schedules, cost lines, ...). Rather than build per-field optimistic concurrency across dozens of
already-shipped forms, this ships a coarser, first-come-first-served pessimistic lock scoped to
the whole shipment: whoever opens it first for edit keeps every edit control on every one of its
pages until they leave; everyone else sees the exact same read-only experience a Viewer role
already gets, for as long as the lock holds.
```

**New `shipment_edit_locks` table** — one row per currently-locked shipment (`shipment_id` is the
primary key, so at most one holder ever exists per shipment): `locked_by_id`/`locked_by_name`,
`locked_at` (when this hold started — survives a renewal), `last_heartbeat_at`/`expires_at` (moved
forward by every renewal). No manual force-unlock exists — a stale lock (crashed tab, closed
browser, lost connection) self-clears once 30 minutes pass with no renewal, the same idle-timeout
window `useIdleLogout` (§8.9) already uses for the unrelated concept of a genuinely inactive
session, chosen independently here rather than sharing that setting (a security team shortening
the idle-logout window for other reasons shouldn't silently also shrink this unrelated grace
period).

**Two routes on `routes/shipments.js`**, both gated by the same `shipmentWrite` role check
(`admin`/`operator`/`occ_bk`) every other shipment-write route already uses — a Viewer or
trade_manager account can't reach either one, since they can't edit shipments regardless of any
lock:
- `POST /api/shipments/:id/edit-lock` — acquire-or-renew-or-report. A first-ever or expired lock
  is claimed outright; the current holder calling again is a renewal (`locked_at` preserved,
  `expires_at` pushed forward, no broadcast — nothing actually changed for anyone else watching);
  anyone else gets back `{ownedByMe:false, lockedByName, ...}` with **no error status** — the 200
  response is the caller's cue to render read-only, not a failure to handle.
- `DELETE /api/shipments/:id/edit-lock` — explicit release, a safe no-op if the caller isn't the
  current holder (never lets B accidentally clear A's hold by calling release speculatively).

**No new WebSocket infrastructure** — reuses the existing per-shipment `shipmentSubs` Map (§8.7)
via a new `broadcastEditLockChange(shipmentId, payload)` helper, sibling to `broadcastMessage`,
emitting a new `edit_lock_changed` frame (`{locked, lockedById, lockedByName, expiresAt}` or
`{locked:false}`) only when the holder actually *changes* (acquired, released, or expired-and-
reclaimed) — a same-holder renewal broadcasts nothing, so a locked-out viewer's UI doesn't flicker
every heartbeat.

**Frontend wiring is in `App.jsx`, not any one page component** — deliberate, since the lock is
whole-shipment (every sub-page, plus the full edit form) and `ShipmentHeaderBar` (the one
component mounted across most sub-pages) is *not* mounted on the edit form itself. A `useEffect`
keyed on `[selectedId, roleCanEditShipments, user?.id]` acquires on mount, renews every 5 minutes,
opens its own WS subscription for live push, and releases on cleanup (navigating away, or losing
edit-capability mid-session, e.g. an admin switching to the viewer role) — but only if this
specific effect instance's own `owned` flag was true, so a locked-out viewer's cleanup never
issues a pointless release call. The lock state then **downgrades `canEditShipments` itself**
(`AuthContext`'s value, computed in `App.jsx`) rather than threading a second prop through the
~30 files that already check that one flag ad hoc — cheaper than the alternative, and correct
because the downgrade is guarded on `shipmentLock.shipmentId === selectedId`, so it can never leak
into an unrelated page that happens to render while some other shipment's lock state is still in
memory. `ShipmentHeaderBar` surfaces a small `🔒 Locked by {name}` pill (visible on every
sub-page); the existing role-based View Only banner on Overview (`ShipmentDetailPage.jsx`) grew a
second branch so a lock-caused read-only state gets accurate wording instead of the pre-existing
"contact an admin for permissions" copy, which would have been actively wrong for an edit-capable
user who's simply locked out.

**A real bug found only through live two-browser verification, not the standalone test suite**:
the first CDP verification pass using two Puppeteer pages in the *same* browser context appeared
to show the release-on-navigate path silently failing — the lock stayed attributed to the original
holder no matter what. Root cause was in the verification harness, not the app: two pages sharing
one browser context share `localStorage` per-origin, so the second simulated user's page load
silently overwrote the first user's auth token in the one shared store, making the first user's
own release call authenticate as the second user instead (confirmed via a temporary
`reqUserId`/`existingLockedBy` server-side log — they didn't match, but not for the reason
initially assumed). Fixed by using `browser.createBrowserContext()` for genuinely isolated storage
per simulated user — the real two-context repro then passed cleanly end to end, including the
live badge appearing/clearing with no page reload.

**Deliberately out of scope**: an admin "force unlock" override (the 30-minute auto-expiry was
judged short enough on its own) and per-field/per-tab locking (would need instrumenting the same
~30 files this design specifically avoided touching). `tests/shipment-edit-lock.test.js` (20
assertions) covers acquire/renew/release/non-holder-release-is-a-no-op/re-acquire-after-release/
404-on-unknown-shipment via pure HTTP; the 30-minute real-clock expiry itself isn't exercised
automatically, the same accepted gap this codebase already has for other short-of-an-hour
time-based rules with no backdating endpoint (§8.16's own AR-aging-boundary note).

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

### Shipment-Domain Gap & Dead-Code Audit Log (ongoing, started 2026-09-02)

A direct request to systematically hunt for dead ends and gaps, starting at the shipment level —
distinct from the Critical/High/Medium/Low items above (which are architectural debt) and from
the competitive gap analyses elsewhere (which compare against other platforms' features). This
log is per-item: what was checked, the verdict, and the finding — kept dated so it doesn't go
stale silently the way this whole document once did (see L10). Append rows as the audit
continues; don't rewrite history once an item's checked.

| Date | Area checked | Verdict | Finding |
|---|---|---|---|
| 2026-09-02 | Shipment sidebar nav wiring (`ShipmentDetailSidebar.jsx` ↔ `App.jsx` routing switch ↔ `shipmentSections.js`) | **No gap** | Fully traced end to end. The 6 flat promoted sections, Booking & Routing/Export-Import Services/Accounting groups, and the admin-reorderable sidebar all derive from single-source-of-truth configs (`SHIPMENT_SECTIONS`, `PROMOTED_ROUTES`, `blockRenderers`) — no orphaned page key, no link to a route that doesn't exist. |
| 2026-09-02 | `server.js` inline route duplication (previously flagged and partially fixed v0.65.0/v0.51.0) | **Confirmed clean** | The specific dead duplicates called out in the v0.51.0 changelog (`GET /api/shipments/:id/events`/`/documents`, `GET /api/documents/:docId/download`) are gone. `server.js` now registers only 2 inline routes total: `/internal/dev/shutdown` and the production SPA fallback — both intentional, not dead code. |
| 2026-09-02 | `PUT /api/shipments/:id` crash when `status` omitted from body ([[project_workflow_audit_fixes]] had this flagged as known-unfixed) | **Already fixed — memory was stale** | `routes/shipments.js` now guards `status` (and `pol`/`pod`/`carrierCode`/`contractType`) with an explicit `!== undefined` fallback to `existing.status`, with a comment describing the old crash. Verified live: PUT with no `status` field → 200, status preserved, server stays up. Memory file corrected in place. |
| 2026-09-02 | Document Template Editor (`routes/document-templates.js`) — does it bypass `mdm_source=remote` the way 11 other known sites do (§8.1)? | **No gap** | `offices` was never extracted to any microservice — no `offices_source` toggle exists anywhere, so the route's direct `LEFT JOIN offices` is correct by construction, not a bypass. The carrier picker in `NewTemplateModal` calls the already-remote-aware `api.carriers.list()` rather than duplicating that logic. |
| 2026-09-02 | Carrier/Line Agent **Capabilities checklist** (`MdmCarrierAgentsPage.jsx`'s Capabilities tab, `carrier_agents.capabilities`) — is it ever cross-checked against a shipment before a booking is sent? | **Real, confirmed gap — data collected, never read back** | Grepped every carrier-booking file (`routes/edi.js`, `routes/shipment-ops.js`, `ShipmentCarrierBookingDetailsPage.jsx`, `ShipmentCarrierBookingReviewPage.jsx`, `CarrierBookingGateModal.jsx`) for any reference to `capabilit*` — zero hits outside `routes/mdm.js`'s own CRUD. The feature's own code comment already named the intent ("used later to cross-check against a leg's own haulage/service before a booking is sent") — confirmed that check genuinely doesn't exist anywhere, not assumed from the comment. Logged as `TKT-FQFE33`, under new Epic `TKT-E25769` "Shipment Domain Gap & Dead-Code Audit" (see Kanban). |
| 2026-09-02 | `shipment_cost_lines` — does deleting a shipment cascade to its cost lines the way every other child table does? | **Real bug, higher severity — orphaned financial data** | `lib/schema.js`: every other `shipment_id` column across 13+ child tables (`containers`, `shipment_documents`, `shipment_milestones`, `shipment_parties`, ...) is declared `REFERENCES shipments(id) ON DELETE CASCADE`. `shipment_cost_lines.shipment_id` (line 765) is the one exception — plain `TEXT NOT NULL`, no FK at all. `DELETE /api/shipments/:id` (`routes/shipments.js:575-579`) is a bare `DELETE FROM shipments`, no explicit child cleanup, relying entirely on cascade for every table — so this one is the sole gap. **Verified live, not just read**: created a shipment, added a cost line, deleted the shipment (200, and a follow-up `GET` on it correctly 404s), then `GET .../cost-lines` on the same now-deleted shipment ID **still returned the line** — a real, permanently orphaned row, unreachable from any UI (no page can navigate to a deleted shipment) and never cleaned up. This can only get worse over time and may already have live orphans in this dev DB from past real deletions — worth a one-time audit query before deciding whether to backfill-delete or just fix forward. Test row cleaned up after confirming. **FIXED same day**, per direct authorization: `lib/schema.js`'s `CREATE TABLE` now declares the FK for fresh installs; a new guarded entry in the "Incremental schema changes" section deletes existing orphans (idempotent — a `WHERE NOT EXISTS` delete against `shipments`, safe to re-run) then adds the constraint if it isn't already there (checked via `pg_constraint`, since Postgres has no `ADD CONSTRAINT IF NOT EXISTS`). Run against this dev DB: **removed 5,435 pre-existing orphaned rows** (accumulated over the project's history, overwhelmingly test-fixture churn — several were `status: 'posted'`). Re-verified the exact live repro end to end afterward: create shipment → add cost line → delete shipment → `GET .../cost-lines` now correctly returns `[]` instead of the orphaned row. Full relevant regression run clean: `cost-lines-lifecycle.test.js` (39), `shipment-crud.test.js` (35), `invoice-reversal.test.js` (20), `billing-performance.test.js` (82, once the Document Distribution service — not started earlier in this session — was brought up; its absence was the sole cause of an unrelated failure cascade in that file, confirmed by re-running with it up). |
| 2026-09-02 | `mdm_source=remote` bypass sites (§8.1's own "11 secondary read sites, named, accepted gap") — is that list still complete against current code? | **Real gap — list is stale, 3 more sites found** | Grepped every `routes/*.js` + `server.js` for raw `SELECT ... FROM {carriers,vessels,port_locations,linked_ports,trade_lanes,country_trade_lanes,regions,countries,commodities,carrier_agents}` and checked each against an `isRemote()`/`mdm_source` branch. All 9 files already named in §8.1 checked out — genuinely gated or already-disclosed. Found 3 more, not on that list: (1) `resolveInvoiceThresholds()` (`server.js` ~1450, backs the Invoice Collections alert/escalation sweep AND report) reads `countries` directly, no branch at all; (2) `resolveSeaPorts()` (`routes/shipments.js` ~185, backs the **main** `GET /api/shipments` list — the single highest-traffic read in this class) reads `port_locations` directly, no branch; (3) `linkedPortCodes()` (`server.js` ~2535) reads `linked_ports` directly with no branch, and is called unconditionally from `findMatchingContractLegs()` — the shared contract-rate-matching engine behind **both** `GET /api/contracts/match` (`routes/contracts.js:354`, not previously named) and `routes/allocations.js`'s match route (already named, but only for its own direct caller — this shared-helper path wasn't accounted for). `mdm_source` is `'local'` everywhere in this dev environment (confirmed live via `GET /api/settings`), so none of this is live-wrong today — same "cosmetic staleness, not data loss, until someone flips the toggle" character as the original 11. Not fixed this pass (doc-completeness finding, not a live bug) — §8.1's list and its "don't flip remote until closed" warning should be updated to reflect 14, not 11, sites. |
| 2026-09-02 | Freight Audit & Payment (`routes/carrier-invoices.js`) — does approving a carrier-invoice line matched to a cost line that's since been **posted** actually update the shipment's real financial record? | **Real bug, high severity — silent financial-reconciliation loss. FIXED same day** | The matching engine (`matchLine()`, line ~116) only ever auto-matches against `status='accrued'` cost lines — so a match is always made while the cost line is still open. But nothing stops the matched cost line from being independently actualized+posted (normal month-end/invoice-to-customer flow) **before** the carrier's own invoice arrives and gets approved — a realistic ordering in real freight operations, where a carrier's invoice routinely arrives weeks after a shipment's own costs are already closed out. The approve route (`POST /api/carrier-invoice-lines/:id/approve`) correctly refused to overwrite a `posted` cost line's `actual_amount` (respects the same lock every other cost-line write path enforces) — but then **silently continued** and marked the invoice line `status:'approved'` anyway, with no adjustment created and nothing in the response indicating the underlying cost line was left untouched. **Verified live end-to-end before the fix**: a $1,000 BUY cost line, a carrier invoice line for the real carrier-billed $1,200 (auto-matched while still accrued, `variancePct: 20`), posted the cost line independently, then approved the invoice line — API returned `status:'approved', varianceUsd:200` with no error, while `GET .../cost-lines` showed the record **unchanged**: `amount:1000, actualAmount:1000, status:'posted'`. **Fixed per direct authorization** (user chose "reject with 409" over "auto-create an adjusting line" — matches this codebase's own standing "posted lines are locked, add an adjusting line" convention used everywhere else on `shipment_cost_lines`): the approve route now returns 409 instead of silently continuing when the matched cost line is already posted; `FreightAuditPage.jsx`'s existing generic `catch(e) { toast.error(e.message) }` surfaces it with zero frontend changes needed. **A real nuance found while verifying the recovery path**, and deliberately NOT papered over: `approve` always writes the invoice line's *full* carrier-billed amount as whatever cost line it ends up matched to — not an incremental delta — so "add an adjusting line for the difference, rematch, approve" (the obvious-sounding fix) actually double-counts (adjusting line's `actual_amount` becomes the full $1,200 on top of the original line's already-posted $1,000 actual, overstating total cost by $1,000 — confirmed live). The 409 error message was deliberately worded to NOT prescribe "for the difference" and instead leaves the correction amount to the resolver's own accounting judgment — this recovery path (and the accrual→actualize→post lifecycle's total lack of a real BUY-side adjustment/reversal mechanism, unlike the SELL-side Invoice Reversal feature from v0.53.0) is itself a logged follow-on gap, not solved in this pass. Re-verified live end-to-end after the fix: rejected 409 with the new message, original posted line confirmed untouched, then the full add-adjusting-line→Rematch→Approve recovery path completed successfully against the new line. Test data cleaned up each time. |
| 2026-09-02 | Freight Audit & Payment's BUY-side recovery path (found while fixing the bug above) — is there any way to correct/reverse an already-*posted* BUY cost line's actual amount, the way the SELL-side has Invoice Reversal (v0.53.0)? | **Real, confirmed gap — no BUY-side equivalent exists** | Grepped `routes/*.js` for any BUY-scoped reversal/adjustment route — `POST .../documents/:docId/reverse` (v0.53.0) is SELL-only, built from `generateInvoices()`'s own line set, structurally inapplicable to a BUY cost line with no invoice document behind it. The only lever on a posted BUY line today is manually inserting a new, unlinked cost line and trusting the person doing it to size it correctly — no system-enforced link between "this adjusts that", no running total shown anywhere before the two lines are added into a report. Logged as a follow-on, not scoped/built this pass — worth a dedicated design pass if BUY-side corrections turn out to happen often enough in practice to justify it. |
| 2026-09-02 | Credit-override 60-minute grace window (`OVERRIDE_GRACE_MS`, v0.74.0) — the v0.74.0 changelog itself disclosed this was never exercised end-to-end automatically (only integration-tested via the "current" AR-aging bucket, no endpoint backdates `created_at`). Is the expiry actually enforced, or just documented? | **No gap — correctly implemented** | Traced both consuming sites: `routes/customers.js:332` (the override-approval route's own immediate validity echo) and `routes/shipment-ops.js:1016`'s `findOverLimitBlock()` (the real gate on `POST .../documents/generate` for FR01/FR02) both compute `Date.now() - created_at <= OVERRIDE_GRACE_MS` identically — a real, live time check, not a stub. Confirmed the grace window is deliberately NOT tied to `consumed_at` (an already-consumed-by-container-1 override still passes for containers 2..N of the same per-container invoice split, exactly as the code's own comment says) — correct by design, not an oversight. No code change needed. |
| 2026-09-02 | Milestone auto-completion (`autoCompleteMilestone`, TKT-OZD4V8) — is every one of the 9 milestone steps actually wired to a real trigger, or are some still dormant the way `bl_issued` was before v0.90? | **Real, confirmed gap — `vessel_departed`/`vessel_arrived` were dormant despite AIS already detecting exactly that event. FIXED same day** | Grepped every `autoCompleteMilestone(` call site app-wide: `booking_confirmed` (`routes/edi.js`), `si_submitted` (`routes/shipments.js`, VGM), `cargo_gated_in`/`cargo_released` (`routes/shipments.js`, container events), `bl_issued` (`routes/shipment-ops.js`, v0.90), `customs_cleared` (`routes/customs-filing.js`) — 6 of 9 keys covered. `vessel_departed`, `vessel_arrived`, and `delivered` had zero trigger anywhere, including inside `lib/ais-listener.js` itself, which is the one place that already positively confirms a real-world departure/arrival (`shipment_legs.etd_source`/`eta_source` flipping to `'ais'`) — a purpose-built signal for precisely this milestone, sitting unused. Worse: Command Center's own on-time-scorecard and transit-time-variance features (`routes/command-center.js:99-113,180-193`) already **read** `shipment_milestones.vessel_departed`/`vessel_arrived` and compare them against the AIS-confirmed leg dates to compute slippage — meaning those analytics were silently starved unless an operator separately, manually completed the milestone in a way that happened to line up with the AIS date, which nothing prompted them to do. **Verified live before the fix**: AIS-simulated departure correctly flipped the leg's `etdSource` to `'ais'`, but the shipment's `vessel_departed` milestone row stayed `completedAt:"", completedBy:""`. **Fixed**: `lib/ais-listener.js`'s `applyActual()` (the one function that writes `etd_source`/`eta_source='ais'`) now also calls the newly-threaded-through `autoCompleteMilestone(shipmentId, field==='etd'?'vessel_departed':'vessel_arrived', ...)` — `createAisListener()`'s factory signature and its one call site (`server.js`) both updated to pass it in. Reuses the exact same idempotent no-op-if-already-completed guard every other milestone trigger already relies on, so it's safe on every AIS confirmation, not just the first. `delivered` has no obvious existing signal to wire to (no proof-of-delivery mechanism exists anywhere in this codebase) — left alone as a likely legitimate permanently-manual step, unlike the other two. Re-verified live end-to-end after the fix: both `vessel_departed` and `vessel_arrived` now correctly show `completedBy:"System (Auto)"` with a clear note immediately after their matching AIS simulation. Full `tests/ais-integration.test.js` (30 assertions) and `tests/command-center.test.js` (38 assertions, the other real consumer of these two milestone fields) re-run green, zero regressions. |

### Low / Enhancement

| # | Opportunity | Status |
|---|---|---|
| ~~L1~~ | ~~Security headers (CSP, X-Frame-Options, Referrer-Policy)~~ | **RESOLVED 2026-09-02** — `server.js` now sets `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` on every response. `style-src` needed `'unsafe-inline'` (this app has zero CSS files, every component styles via a plain `style={{}}` attribute). `connect-src`/`style-src`/`font-src` allowlist exactly the real external calls this app's browser code makes — `fonts.googleapis.com`/`fonts.gstatic.com` (a Google Fonts `<link>` injected client-side via `document.createElement`, missed by an initial static grep) and both `open-meteo.com` API subdomains (the Dashboard weather widget) — found only by loading a real production build and watching the console for violations, not by reading source. Verified live via CDP against a real `NODE_ENV=production` build: zero CSP violations, zero console errors, navigated Dashboard + a styled MDM page. Only matters in production — the dev workflow serves the frontend from Vite's own `:5173` server, untouched by anything Express sets. |
| L2 | WAL mode for SQLite | **Moot** — the app fully migrated off SQLite to Postgres/pglite (`project_postgres_migration_progress` memory: monolith + all 6 microservices). A SQLite-specific journaling pragma no longer applies to anything in this codebase. Should be struck from this list rather than "resolved". |
| L3 | `crypto.randomUUID()` instead of manual `uid()` | Still using manual `uid()` — the 6-char ID format is now load-bearing in a lot of places (prefixes, display), so this is a bigger change than it looks. Flagged, not touched this pass. |
| L4 | Extract `SERVICE_CODE_MAP`/`TRACKED_FIELDS` to shared config | Confirmed still inline in `server.js` (~2172-2216, ~2762) as plain object literals, exported via `ctx`. Genuinely low-risk to move (pure data, no logic) but zero functional value — deferred as pure code-organization polish, not picked up this pass. |
| L5 | OpenAPI/Swagger spec | Still true — no route documentation beyond this file and inline comments; now covering well over 200 routes across 31 files. Substantial effort, not a "quick" item — flagged, not started. |
| ~~L6~~ | ~~Version column on `app_settings`~~ | Not applicable — no migration framework exists to version against (see H2). |
| ~~L7~~ | ~~Containerise with Docker~~ | **RESOLVED** — Dockerfiles + `docker-compose.yml` exist for all 4 processes (§3). |
| L8 | Cost-line validation endpoint (orphaned/missing lines) | Confirmed via direct grep (`routes/*.js`): no such endpoint exists — only this session's unrelated `shipment_cost_lines` FK-cascade fix (§ audit log above) touches "orphaned" in this codebase. Still open; Kanban ticket status not re-checked live this pass (services were down at verification time). |
| ~~L9~~ | ~~`package.json`'s own `"version"` field drifts from `src/version.js`~~ | **RE-DRIFTED, then RE-FIXED 2026-09-02** — confirmed live: a running server's own `/api/health` reported `0.87.0` while `src/version.js` already said `0.90.0`. Exactly the recurrence the v0.78.0 fix note warned about ("nothing reads package.json's version at runtime, and still no automated check keeping the two in sync"). Bumped `package.json` back in line (`0.87.0` → `0.90.0`). Still no automated check — the next several-release gap will drift again unless L10's process gap is also closed. |
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

**Second update — real 100-concurrent-user load test data, not just the design doc's reasoning**
(added by direct request). New `scripts/load-test.js` (`npm run load-test [connections]
[durationSeconds]`, uses `autocannon`'s JS scripting API) drives a realistic mixed session per
virtual connection — list shipments, view one, browse a lightweight MDM lookup, then create,
update, and delete its own scratch shipment — rather than hammering one endpoint, so both
read-heavy and write-heavy paths get exercised together under real concurrency. One admin login
happens once before the run (not per-connection), sharing the resulting JWT via autocannon's
`initialContext`, so 100 simultaneous logins don't trip the unrelated per-IP login rate limiter —
that's a test-harness concern, not something this run is measuring.
- **30s run**: 12,362 requests, zero non-2xx / connection errors / timeouts. Latency p50 184ms,
  p99 680ms, max 901ms.
- **180s sustained run** (to catch anything that only shows up over time, not an instant burst):
  62,444 requests, again zero non-2xx / errors / timeouts. Latency p50 247ms, p99 805ms, one
  outlier max of 2.9s. Server memory sampled every 30s throughout stayed flat (257–295MB, no
  growth trend) — no leak. The one outlier spike is most plausibly the live AIS listener (§8's
  persistent outbound WebSocket, a real external data feed, not simulated) landing a burst of
  `PositionReport` writes on the same single Node thread as the HTTP traffic at an unlucky moment
  — consistent with, not contradicting, this section's own "no concurrent-write parallelism"
  reasoning; not chased further since nothing actually failed.
- **Net result: this confirms rather than refutes §13's core claim.** The monolith holds up
  correctly under 100 real concurrent users doing a genuine mixed CRUD workload — no crashes, no
  corrupted writes, no dropped requests, no memory growth — but latency visibly degrades under
  load (roughly 4-6x slower at p50/p99 than the equivalent lightly-loaded numbers this codebase's
  own test suites see) because every request ultimately serializes through one synchronous,
  single-threaded SQLite connection. That degradation curve, now measured rather than assumed, is
  the concrete evidence for why Epic 5's cross-process concurrent-write requirement is real and
  why this section recommends sequencing a Postgres migration with it rather than treating today's
  single-file SQLite setup as permanently sufficient.
- **One real bug, found in the test tooling itself, not the app**: the first version of this
  script tagged scratch shipments via a `note` field to identify and verify cleanup of its own
  load-generated data — `POST /api/shipments` silently ignores that field entirely (it was never
  a real column), so the leak-detection check was quietly comparing against data that was never
  persisted, reporting a false "0 leaked" the whole time. Fixed by using a deliberately fake,
  distinctive `carrierCode` ("LDTST") instead — a field actually mapped and persisted — plus an
  automatic post-run cleanup step for the handful of connections always caught mid-cycle (between
  create and delete) when a run's duration expires, which scales with `connections` and is
  expected, not a bug. Re-verified clean (0 leaked rows) after both runs above.

**Third update — the migration itself is underway, Phases 0 through 5 shipped — every
independently-deployable microservice is now Postgres-backed, only the monolith itself
remains.** Direct decision, after
seeing the load-test numbers above: commit to the long-term Postgres migration rather than a
short-term mitigation (a worker-thread pool was considered and explicitly rejected — "short term
fixes will just have us run into the same problem sooner or later").

Scoping found the true scope is large: **1,273** `db.prepare`/`db.exec` call sites in the
monolith alone (`server.js` 219, `routes/shipment-ops.js` 199, `routes/shipments.js` 104,
`routes/mdm.js` 101, ...), only ~32% of route handlers already `async`, and two high-fan-in
synchronous helpers — `logEntityEvent` (106 call sites across 13 files) and `getSettings` (57
call sites) — that are the real structural risk to converting the monolith itself, more than the
raw count is. A separate ~300 call sites are spread across 6 of the 7 microservices (`pdf-render`
has no database at all) — but critically, **no service calls another service's database or code
directly** (only the monolith holds every `*_SERVICE_URL` and proxies over HTTP), so each of the
7 is safely migratable in complete isolation, the same way their original extraction from the
monolith was. This must be phased across many sessions, at the same cadence the original 7
microservice extractions used (one per release).

**Environment unblock**: this section's own proof-of-concept had been blocked on "no Postgres
instance to connect to" in this sandboxed environment (confirmed again: no Docker, no native
install). `@electric-sql/pglite` (npm, confirmed available) is a genuine WASM-compiled build of
real Postgres — not a compatibility shim — that runs embedded with zero install and no server
process, exposing the same `await db.query(sql, params) → {rows}` shape as the standard `pg`
driver. It's explicitly alpha-status and single-connection-only (its own README: "PGlite is
single user/connection"), so it validates **schema and query correctness**, not the real
concurrent-connection-pool behavior that's the actual point of this migration — that still needs
a genuine Postgres server once one is available, at which point `scripts/load-test.js`'s pattern
should be re-run against it.

**Phase 0 (shipped): `document-distribution`** — chosen as the first target over de-risking the
monolith's shared helpers first, since it's the smallest, safest, fully self-contained service (3
tables, ~11 columns max, 9 call sites, no create-copy-swap migration IIFE) and proves the whole
pattern end-to-end on a real, already-in-production service before committing further sessions to
anything bigger. New `services/document-distribution/lib/db.js` — self-contained in this
service's own `lib/` folder (confirmed no service imports cross-directory from another service or
the monolith's root `lib/`) — exposes `query(sql, params)` and `transaction(fn)`, backed by a real
`pg.Pool` when `DATABASE_URL` is set, or a local `@electric-sql/pglite` instance (persisted to
`services/document-distribution/pgdata/`, gitignored) otherwise. Schema translation: dropped
`PRAGMA journal_mode=WAL` (Postgres's MVCC covers it natively); `id TEXT PRIMARY KEY` unchanged;
`is_active` became a real `BOOLEAN` instead of the `INTEGER 0/1` idiom (worth doing correctly
while the blast radius was small); `TEXT` ISO-8601 date columns stayed `TEXT` for this phase (the
app already treats them as plain strings everywhere — a real `TIMESTAMP` type is a separate,
later, non-blocking cleanup). All 9 call sites converted to `await query(...)`, `?` placeholders
to `$1, $2, ...`, route handlers made `async`. Zero test changes needed — both of this service's
own test files (38 assertions total) and the monolith's own integration test suite
(`tests/document-distribution.test.js`/`-gaps.test.js`, 18 assertions) pass identically to the
SQLite-backed results, plus a real end-to-end manual check through the live monolith→service
proxy (`GET`/`PUT /api/offices/:id/webhook-settings`) confirmed correct round-tripping.

**Phase 1 (shipped): `screening`** — 3 tables (`sanctions_entries`, `sanctions_syncs`, a small
local `settings` k/v table), 36 call sites. New `services/screening/lib/db.js`, same shape as
Phase 0's. Two real behavioral-parity details this migration surfaced that Phase 0's simpler
schema hadn't: (1) SQLite's `INSERT OR REPLACE` (a full-row replace) has no direct Postgres
equivalent — translated to `INSERT ... ON CONFLICT (id) DO UPDATE SET col=EXCLUDED.col, ...` for
every non-key column, and one of the three call sites doing this (`import-csv`) hardcoded a
literal `'[]'` for `aliases_norm` in its original `VALUES` clause rather than a bound parameter —
easy to miss that the `ON CONFLICT DO UPDATE` needs that exact same literal, not just the
parameterized columns, to stay byte-for-byte behaviorally identical; caught before shipping by
re-diffing every column against the original statement, not just skimming it. (2) `COUNT(*)`
returns a string from both `pg` and `pglite` (Postgres's `bigint` result type, avoiding silent
precision loss past `Number.MAX_SAFE_INTEGER`) — every one of this service's 4 `COUNT(*)` sites
needed an explicit `Number(...)` wrap, a gotcha Phase 0's schema never exercised since it had no
count queries at all. Also translated: `LIKE` → `ILIKE` in the entries search (SQLite's `LIKE` is
case-insensitive by default for ASCII; Postgres's is not — silently changing search behavior if
left as a literal find-replace). The two long-lived `BEGIN`/`COMMIT` sync jobs (`syncOfacSdn`,
`syncConsolidatedScreeningList`) and the two auto-sync scheduler functions (`getSettings` plus a
`sanctions_syncs` lookup, now real async queries) all converted cleanly using the same
`transaction()` helper and the "wrap the whole body in try/catch, never let the returned promise
reject" contract the original synchronous fire-and-forget schedulers already had. 11 new
assertions (this service's own test file) plus the monolith's 14-assertion
`screening-service-toggle` suite — the latter is the more meaningful proof here, since it
exercises the full local↔remote toggle, a live import through the remote-mode proxy, and a real
shipment screening confirming the monolith's in-memory `sanctionsMap` cache actually reloads from
the now-Postgres-backed service — both pass identically to the SQLite-backed results.

**Phase 2 (shipped): `customers`** — the largest and most structurally complex service migrated
so far: 4 tables (`customers` at 31 columns, `customer_identifiers`, `customer_contacts`,
`customer_screenings`), a self-referential FK (`parent_customer_id`, `ON DELETE SET NULL` —
Postgres enforces it natively, no `PRAGMA foreign_keys=ON` needed at all), 5 boolean columns
across 2 tables (`credit_hold`/`classified_location`/`is_nvocc` on `customers`, `is_primary` on
both child tables — all converted from `INTEGER 0/1` to real `BOOLEAN`, every `? 1 : 0`/`!!row.col`
conversion removed), two graph-walk routes (`wouldCreateCycle`'s parent-chain walk, `/group`'s
walk-to-root-then-BFS-down), and a generic 4-table `bulk-import` route backing
`scripts/migrate-customers-to-service.js`. New `services/customers/lib/db.js`, same shape as
Phases 0-1. Translation notes specific to this phase: `INSERT OR IGNORE` (used throughout
`bulk-import`'s per-row helper) became `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id`,
counting `result.length` (0 or 1) per row in place of SQLite's `info.changes` — verified against
this route's own test fixture, which deliberately passes raw `0`/`1` integers (not JS booleans)
for every boolean column, matching exactly what a real migration payload sourced from the
monolith's SQLite rows would send; Postgres's boolean input parser accepts `'0'`/`'1'` as valid
text literals, so these bind correctly with no explicit coercion needed, confirmed by the test
passing unmodified. Every `LIKE` in the dynamic multi-filter `GET /internal/customers` list route
became `ILIKE`; every `UPDATE`/`DELETE` route needing "was a row actually affected" (previously
`info.changes === 0`) gained a `RETURNING id` clause checked via `rows.length === 0`. 33 new
assertions (`customers-crud.test.js`) plus 16 (`customers-screening.test.js`) — 49 total — plus
the monolith's 42-assertion `customer-service-toggle` suite (the most thorough of the three
toggle suites so far, exercising credit-hold, margin group-rollup, and the screening
write/cross-reference split all through the remote branch), all passing identically to the
SQLite-backed results.

**Phase 3 (shipped): `kanban`** — 7 tables (`tickets`, `ticket_links`, `test_items`,
`test_case_links`, `kb_projects`, `kb_versions`, `kb_columns`), 79 call sites, the first phase
with real relational structure spanning multiple independent entity families (tickets ↔ their
own links, test items ↔ their own story-links to tickets, projects ↔ versions/columns via
`ON DELETE CASCADE` — enforced natively in Postgres, no code needed). New
`services/kanban/lib/db.js`, same shape as Phases 0-2. No boolean columns anywhere in this
schema, so — unlike `customers` — this phase needed no `INTEGER 0/1` → `BOOLEAN` conversion at
all. Translation notes specific to this phase: the atomic "create ticket if this
(source_type, source_id) pair doesn't already exist" route (`POST /internal/tickets/ensure`,
backing `ensureOpsTicket`'s remote branch and its own `UNIQUE(source_type, source_id)`
constraint) converted from `INSERT OR IGNORE` to `INSERT ... ON CONFLICT (source_type,
source_id) DO NOTHING RETURNING id` — a composite-column conflict target rather than the
usual bare `id`, since that's the actual constraint being raced against; several N+1-shaped
per-row sub-queries inside a `.map()` (ticket links' "resolve the other ticket", story-links'
"resolve the linked ticket/test case") converted to `Promise.all(rows.map(async ...))` rather
than a plain sequential loop, since a plain `.map()` callback can't itself be awaited. The
recursive test-item descendant collector (`collectDescendants`, backing cascade delete) and its
transactional two-table cascade delete (`test_case_links` then `test_items`) both converted
cleanly using the shared `transaction()` helper — the same "wrap the whole body, roll back on
throw" pattern already used for `bulk-import` in every prior phase. 27 new assertions
(`kanban-crud.test.js`) plus 14 (`testcases-crud.test.js`) — 41 total — plus the monolith's
19-assertion `kanban-service-toggle` suite (covering the assignee-name-resolution ripple, the
cross-table story-link JOIN surviving remotely, and — the most load-bearing case — two
consecutive ops-automation sweep runs proving the new `ON CONFLICT`-backed atomicity actually
holds), all passing identically to the SQLite-backed results.

**Phase 4 (shipped): `contract-management`** — 6 tables (`contracts`, `contract_legs`,
`contract_rates`, `contract_routings`, and 2 legacy-backfill junction tables), 68 call sites, the
most dynamically-filtered query surface of any phase so far (`GET /internal/contracts` alone
builds up to 10 optional WHERE clauses). New `services/contract-management/lib/db.js`, same
shape as Phases 0-3. A small `p(value)` closure (push to `params`, return `$N` for the position
just pushed) replaced manual placeholder-index tracking for every dynamically-built query in this
file — cleaner than Phase 2's manual `params.length` arithmetic once a route has this many
optional filters compounding. 5 boolean columns converted (`dg_allowed` on `contracts`;
`pol_linked_allowed`/`pod_linked_allowed`/`pol_carrier_haulage`/`pod_carrier_haulage` on
`contract_legs`) — and this phase caught a **real bug the straight port would otherwise have
shipped silently**: `mapLeg`'s four boolean fields were read via `r.pol_linked_allowed === 1`
(a SQLite-integer equality check) — `true === 1` is `false` in JS, so left unconverted, every
one of these fields would have silently read as `false` after migration regardless of the
column's real value, breaking linked-port fallback matching and carrier-haulage detection
outright. Fixed to `!!r.pol_linked_allowed` (and the sibling three); caught by re-deriving every
boolean read site from the schema rather than trusting the existing code shape, then confirmed
by the service's own linked-port-expansion test and the monolith's haulage-gated allocation-match
test, both of which specifically exercise these four fields and both passed. The two other
synchronous module-load-time pieces this service had that Phases 0-3 didn't — a legacy-JSON-to-
junction-table backfill IIFE and an hourly contract-auto-expire sweep — both moved from
unconditional execution at module load into the `require.main` block, run once after
`initSchema()` resolves, same relocation this series already used for screening's two auto-sync
schedulers in Phase 1 (a synchronous schema creation could safely be raced against at load time;
an async one cannot). `INSERT OR IGNORE` in the legacy backfill became a bare
`ON CONFLICT DO NOTHING` (no explicit target — each junction table has exactly one relevant
unique constraint, so an unqualified target resolves unambiguously). The bulk-import route was
confirmed to need no `ON CONFLICT` handling at all — unlike every prior phase's bulk-import, this
one always mints a fresh id per row rather than reusing the source's original id, so there was
never a natural-key collision to guard against; a plain `INSERT` port was correct as-is. 24 new
assertions (`contracts-crud.test.js`) plus 7 (`contracts-match.test.js`, including the
multi-routing HLCU/Kuehne+Nagel worked example) — 31 total — plus the monolith's 20-assertion
`contract-service-toggle` suite (covering the full create/publish/match/withdraw cycle in both
modes and `routes/allocations.js`'s own haulage-gated match resolving a remote contract's legs
correctly), all passing identically to the SQLite-backed results.

**Phase 5 (shipped): `mdm`** — the largest and riskiest microservice migration, deliberately
saved for last: 12 tables, 133 call sites, and the one already-known guarded-rebuild-migration
gotcha. New `services/mdm/lib/db.js`, same shape as Phases 0-4.
- **The guarded rebuild was eliminated, not translated** — `rebuildCarrierAgentsLocations` (a
  SQLite create-copy-swap restructuring a pre-v0.61 flat `port_unlocode` column into today's
  header+locations shape) and a small additive `ALTER TABLE ... ADD COLUMN capabilities` both
  disappeared entirely rather than being ported. Postgres supports every operation these existed
  to work around natively (dropping/adding columns, renaming tables) with no `PRAGMA
  foreign_keys=OFF`/create-copy-swap dance needed — and critically, this guard has existed since
  the MDM service's own v0.80.0 launch, so any real SQLite `mdm.db` old enough to need it has
  already run it at least once; a table migrated via `scripts/migrate-mdm-to-service.js` is
  therefore guaranteed to already be in the post-rebuild shape, and a brand-new Postgres table is
  simply created directly in that shape from day one. This is the first phase to actually
  exercise the "eliminate, don't translate" guidance §13 laid out from the start of this
  migration.
- **`un_member` converted `INTEGER DEFAULT 1` → `BOOLEAN NOT NULL DEFAULT TRUE`** — and this
  phase caught the exact same bug class Phase 4 (contract-management) did: `mapCountry` read it
  via `r.un_member === 1`, which silently becomes `false` for every country once the column is a
  real Postgres boolean. Fixed to `!!r.un_member`, confirmed live (`unMember: true` in a real
  response) and by the service's own test suite.
- **Zero-script onboarding needed a real redesign, not a syntax port.** The old mechanism — copy
  a committed `mdm.sample.db` SQLite *file* into place before the process ever opens a connection
  — has no equivalent once the live database is Postgres/pglite, neither of which is a single
  portable file to copy. Replaced with a data-level seed: a one-off extraction script read every
  reference table out of the retired `mdm.sample.db` (carriers/vessels/port_locations/
  linked_ports/trade_lanes/country_trade_lanes/regions/countries/commodities — 9 tables, 15,738
  rows total, largest being 14,269 port_locations) into a new committed `mdm.sample-data.json`
  (2.8MB). New `seedIfEmpty()` checks whether `carriers` is empty and, if so and the JSON exists,
  bulk-inserts through the same `bulkImportTables()` helper the `/internal/mdm/bulk-import` route
  uses (refactored out into a shared function so both call sites stay in sync) — same "only ever
  seeds a genuinely fresh install, never overwrites a running one" guarantee the file-copy
  version had, just checked with a row count instead of a file-existence check. `mdm.sample.db`
  itself is left in the repo as the historical source the JSON was extracted from, not deleted.
  Verified live: a fresh `pgdata/` boot correctly logged seeding all 9 tables and every row
  resolved correctly on the first real query.
- `INSERT OR IGNORE` throughout (`bulkImportTables`, the two lane-assignment replace routes)
  became `ON CONFLICT DO NOTHING`. One refinement over every prior phase's bulk-import: this
  service's 11 tables are ALL natural-key primary keys (code/imo/unlocode/composite iso2+lane
  pairs) — none of them has a generic `id` column — so the "was this row actually inserted"
  signal uses `RETURNING 1` instead of the `RETURNING id` every previous phase used, since that
  wouldn't compile against a table with no `id` column at all.
- `isUniqueViolation` — previously a SQLite-specific `e.message.includes("UNIQUE constraint")`
  string check, guarding several `INSERT`-then-catch routes (carriers/vessels/ports/linked-ports/
  trade-lanes/regions/countries/commodities, none of which pre-check for a duplicate via a SELECT
  first, unlike every other migrated service) — converted to check Postgres's own unique-violation
  SQLSTATE code (`e.code === "23505"`), confirmed correct by the service's own duplicate-rejection
  test.
- 40 new assertions (`mdm-crud.test.js` 25, `mdm-resolvers.test.js` 15 — including the carrier-agent
  linked-port fallback, which specifically exercises the boolean-shaped location-type routing, and
  the bulk-import idempotency check) plus the monolith's 25-assertion `mdm-service-toggle` suite —
  the most cross-cutting toggle suite of any phase, since it's the only one that exercises TWO
  extracted services' remote modes at once (`mdm_source=remote` AND `customer_source=remote`,
  proving `attachAgentNames` correctly resolves a real customer name through a second live
  service) — all passing identically to the SQLite-backed results.

**This completes every planned microservice Postgres migration.** All 6 database-backed
services (`document-distribution`, `screening`, `customers`, `kanban`, `contract-management`,
`mdm`) are now Postgres-backed; only `pdf-render` (stateless, no database) and the monolith
itself remain on their original stack. The monolith is tackled last of all, and needs its own
internal sub-phasing: convert `logEntityEvent` and `getSettings` to `async` first as a
standalone, zero-behavior-change prerequisite (still on `node:sqlite` — awaiting an
already-synchronous call is a no-op, so this is safe to do before any driver swap), then convert
route files smallest-to-largest, and `server.js`'s own core last.

**Monolith sub-phase 1 (shipped): the async-ification prerequisite.** Both `logEntityEvent` and
`getSettings` converted to `async function`, and every real call site across the entire
monolith — 106 for `logEntityEvent`, 58 for `getSettings` (excluding `services/screening/`'s own
unrelated, already-async, same-named local function) — converted to `await` them, spanning 23
files (`server.js` plus 22 route/lib files) and ~950 lines changed. Zero Postgres/SQL changes in
this pass — every `db.prepare(...)` call is untouched; this is purely "make the call graph
async-shaped" so the eventual driver swap only has to change *what* a function awaits, not
*whether* it does.
- **The two functions themselves were trivial** (a single `db.prepare(...).run(...)` each,
  wrapped in a try/catch that already never threw) — the real work was the ripple: converting
  every caller's enclosing function to `async`, all the way up to the nearest Express route
  handler (always a safe endpoint, since every route is already wrapped by `wrapAsyncHandler`).
  Several call sites were buried 2-4 layers deep in helper functions with no `async` anywhere in
  the chain — `isEdiBookable` → `supersedeIfCarrierChanged` → `ensureBookingCreated` (plus a
  module-load-time backfill IIFE whose own correctness depended on `ensureBookingCreated`
  completing before its next line ran) is the deepest chain converted.
- **`applyShipmentAccessFilter`** (the shipment-list scope filter used by 9 call sites across 7
  files) also needed converting, since its office-scoping branch reads `getSettings()` — not one
  of the two headline functions, but pulled in by the same ripple.
- **One genuine design conflict, resolved with a local cache, not a compromise**:
  `lib/ais-listener.js`'s `getPortCoords`/`handleShipStaticData` run in the AIS feed's hot
  per-frame path (up to hundreds of messages/sec) and the module's own governing rule (stated in
  its file header before this pass ever started) is that path must never await anything. Fixed by
  introducing `cachedSettings`, refreshed synchronously inside `applySettings()` (already called
  at boot and on every settings save) — every hot-path read now hits the cache instead of calling
  the now-async `getSettings()` directly. `getStatus()` was kept synchronous the same way,
  avoiding an unnecessary async ripple into its own two route callers.
- **A real, would-have-shipped-silently correctness question, checked rather than assumed**:
  `logEntityEvent`'s DB write is still synchronous today (node:sqlite), so awaiting it changes
  nothing yet — but the two call sites *not* awaited (`lib/ais-listener.js`'s three background
  message-processing sites, deliberately left fire-and-forget) were a conscious choice, not an
  oversight: unlike an HTTP route handler — where a client might immediately re-fetch history
  data expecting to see a just-logged event before the response even returns — nothing in the
  AIS listener's background pipeline waits on this write's completion, and the function's own
  internal try/catch means it can never reject either way.
- **Caught mid-conversion, before it could ship**: `isEdiBookable`'s `getSettings()` call was
  originally missed in the first `routes/auth.js` pass (a naming coincidence — `sso/callback`'s
  own copy at a different line number) and briefly left the master eAdapter toggle
  (`api_eadapter_enabled`) silently unable to block bookings once `getSettings()` returned a
  Promise instead of a plain object — caught by the existing `tests/eadapter.test.js` suite
  before this phase was considered done, not discovered later.
- Verified via the full 68-file test suite, run standalone per file (not the `&&`-chained
  `npm test`, which stops at the first non-zero exit) with every microservice running —
  everything green except one already-diagnosed, pre-existing test-data collision in
  `billing-performance.test.js` (a hardcoded detection value coincidentally matching an unrelated
  real shipment already in the long-lived dev DB — confirmed unrelated to this change by tracing
  the actual scoping logic directly).
- **Not yet started**: converting the monolith's actual `db.prepare`/`db.exec` call sites
  (1,273 of them) to the real dual-backend `query`/`transaction` driver, route file by route
  file, smallest to largest, `server.js`'s own core last. This prerequisite pass makes that work
  additive from here — every function in the call graph already awaits correctly, so each
  following phase only has to swap the SQL layer underneath.

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
| Standalone microservices | 7 (Document Distribution :3002, PDF Render :3003, Contract Management :3004, MDM :3005, Screening :3006, Kanban/Testing :3007, Customer :3008) — stale count as of v0.69.0, corrected here; the rest of this table's figures still predate several later releases and were not remeasured in this pass |
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
