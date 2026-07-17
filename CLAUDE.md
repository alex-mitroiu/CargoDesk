# CargoDesk — Project Brief for Claude Code

## Project
Full-stack freight management app. React 18 + Vite frontend, Express + node:sqlite backend.
- Path: `C:\Users\alexm\Desktop\Git-CargoDesk\CargoDesk\`
- GitHub: github.com/alex-mitroiu/CargoDesk (public)
- Version: **v0.30.0 "Fairway"**
- Run: `npm run dev` (runs server on :3001 + Vite on :5173 concurrently)
- Seed: `npm run seed` (runs `scripts/import-mdm-data.js`)

## Stack
- Frontend: React 18, Vite, JSX with inline styles (no CSS files, no Tailwind)
- Backend: Express, `node:sqlite` (DatabaseSync — NOT better-sqlite3)
- Design tokens: `src/tokens.js` exports mutable `T` object, `applyTheme(isDark)` for dark/light
- All styling via `style={{ ... }}` using `T.surface`, `T.text`, `T.accent`, `T.border` etc.

## Key files
```
server.js                          Express entry point: SQLite schema, startup migrations,
                                   shared helpers (mappers, auth middleware, broadcastMessage,
                                   syncShipmentFromLegs, etc.), WebSocket server.
                                   HTTP routes live in routes/ — server.js loads them via ctx.
routes/
  auth.js            /api/auth/*, /api/users/*, /api/access-configs/*, /api/scope-items/*
  shipments.js       /api/shipments/* (CRUD, events, status-log, containers, messages, legs,
                     container-events — FCL lifecycle: Empty Pickup/Gate In/Loaded/Sailed/
                     Discharged/Gate Out/Empty Return, GET+POST /api/containers/:id/events,
                     DELETE /api/container-events/:id)
  allocations.js     /api/allocations/* (CRUD, match, conflicts)
  mdm.js             /api/carriers, /api/vessels, /api/port-locations, /api/linked-ports,
                     /api/trade-lanes, /api/country-trade-lanes, /api/regions, /api/countries,
                     /api/unlocodes, /api/commodities
  kanban.js          /api/tickets/*, /api/ticket-links/*
  testcases.js       /api/test-items/*, /api/tickets/:id/tested-by (Story↔TestCase links)
  edi.js             /api/shipments/:id/edi-messages, /api/shipments/:id/edi-messages/booking-request
  customers.js       /api/customers/*, /api/sanctions/*, /api/fx/*
  contracts.js       /api/contracts/*, /api/entity-events/*
  shipment-ops.js    /api/shipments/:id/screening, cost-lines, milestones, documents
  finance.js         /api/margin/summary
  system.js          /api/health, /api/system-messages, /api/settings, /api/schedules/*
  export.js          /api/export/shipments.csv, /api/export/dashboard/xlsx,
                     /api/export/dashboard/template
scripts/
  import-mdm-data.js               Seeds ports, carriers, vessels, commodities (npm run seed)
  seed-contracts.js                Seeds sample carrier contracts (npm run seed:contracts)
  checkdb.js                       Dev utility — inspects DB schema and row counts (npm run checkdb)
  create-export-template.js        Generates exports/dashboard-template.xlsx (npm run export:template)
exports/
  dashboard-template.xlsx          Base XLSX template with named ranges for chart wiring
sampleDB/
  cargodesk.db                     Pre-loaded sample DB — copy to project root to use
src/
  App.jsx                          Root: routing, nav, state, theme toggle, auth guards, role switcher;
                                   also hosts ShipmentDetailSidebar (~1385-1530, anchor-scroll section
                                   nav for ShipmentDetailPage — see Key patterns) and the DOC_TYPES
                                   document-tracking system (~line 56, "⚡ Generate Document" modal)
  api.js                           All fetch wrappers (api.shipments, api.export, api.auth, api.users…)
  tokens.js                        T object, theme colours, route-matching helpers
  toast.js                         Pub-sub toast emitter
  version.js                       VERSION, CODENAME, CHANGELOG
  AuthContext.jsx                  createContext + useAuth hook — provides user, activeRole,
                                   canEdit, isAdmin, isViewer to all components
  pages/
    LoginPage.jsx                  Centered login form; calls api.auth.login → onLogin(token, user)
    ShipmentsPage.jsx              Shipment list + filters + CSV export + real sea-port POL/POD columns
                                   (seaPol/seaPod, resolved server-side — see Recent changes v0.30.0)
    ShipmentFormPage.jsx           New/edit shipment form. Exports LegsTable (shared with
                                   ShipmentSchedulesPage) and ContainerTypeField/deriveHaulageNeeds.
                                   Section order: Parties → Cargo (Commodity) → Offices → Transport &
                                   References (Route Legs, Sailing search) → Containers → Contract.
    ShipmentDetailPage.jsx         Overview page — heavily shrunk this session: just the View Only
                                   banner (conditional) + ServicesPanel now. Still hosts and EXPORTS
                                   most shared sub-components used by other promoted sub-pages though:
                                   ContainerForm (Identity/Cargo/Measurements/DG + Compliance & Cutoffs/
                                   Demurrage-Detention sections, v0.30.0), CommodityDisplay,
                                   MessagesDrawer, EdiMessagesDrawer, MilestonePanel, cost-line
                                   components (CostLineHistoryModal etc.), ScheduleHistoryPanel
                                   (forceOpen prop as of v0.30.0), PendingRevalidationModal,
                                   RouteSummaryBar, relTime/fmtDateTime/EVENT_CONFIG/getEventSummary
                                   (consumed by ShipmentHistoryPage.jsx).
    ShipmentConditionsPage.jsx     "Conditions" nav page (v0.30.0) — Contract Type/ID, Incoterm,
                                   Booking Ref, B/L Number, conditional Commodity/Declared Value/Notes.
                                   Promoted out of Overview's old Contract & References card+modal.
    ShipmentContainersPage.jsx     "Cargo" nav page — container CRUD table with a Compliance column
                                   (stacked VGM/CY/Free-Time badges, v0.30.0) and a dynamic 📋
                                   lifecycle-events tooltip.
    ShipmentPartiesPage.jsx        "Parties & Offices" nav page.
    ShipmentSchedulesPage.jsx      "Contracts & Schedules" nav page — Route Legs (LegsTable), contract
                                   attach/change, Space Configuration panel (Central + linked
                                   allocationId only), Schedule History (button + Modal, v0.30.0).
    ShipmentMilestonesPage.jsx     "Milestones" nav page — MilestonePanel stepper.
    ShipmentAccountingCostsPage.jsx / ShipmentAccountingInvoicesPage.jsx / ShipmentAccountingGpPage.jsx
                                   "Accounting" nested nav (Cost Entry / Invoice Entry / GP Overview).
    ShipmentTicketsPage.jsx        "Tickets" nav page — linked Integration Board tickets.
    ShipmentHistoryPage.jsx        "History" nav page (bottom of sidebar) — paginated shipment event
                                   log, global {results,total,limit,offset} contract.
    DashboardPage.jsx              Overview + Contract Consumption + Margin (XLSX export) tabs
    SpaceConfigurationsPage.jsx    Standalone Space Configs page with Linked Shipments modal
    DashboardArchivePage.jsx       Expired allocations + renew flow
    KanbanPage.jsx                 Integration board with drag-to-reorder
    AppSettingsPage.jsx            API Controls + Finance + Users (admin only) tabs
    AboutPage.jsx                  DB schema, features, changelog
    mdm/
      MdmCommoditiesPage.jsx       294 Maersk commodity codes
      MdmContractsPage.jsx         Carrier contracts with legs (incl. pol/pod loc type) and IMDG filters
      MdmCountriesPage.jsx         Countries + port count + trade lane assignments
      MdmLinkedPortsPage.jsx       Linked port pairs
      MdmPortLocationsPage.jsx     14,269 UN/LOCODE ports
      MdmTradeLanesPage.jsx        Trade lanes + country assignments
      MdmVesselsPage.jsx           349 IMO vessels
      MdmCarriersPage.jsx          Carrier codes
      MdmRegionsPage.jsx           Regions
      MdmUNLocationCodesPage.jsx   UN location code browser
  components/
    primitives/
      ActionMenu.jsx   Btn.jsx Modal.jsx Form.jsx Badge.jsx Spinner.jsx
      ToastContainer.jsx DatePicker.jsx Pagination.jsx useResizableColumns.jsx
    shared/
      PortCombobox.jsx             position:fixed dropdown (escapes modal overflow)
      CommodityCombobox.jsx        Typeahead with GradePill + CommodityPickerModal
      VesselCombobox.jsx           {VesselCombobox, VesselField} named exports
      EntityHistoryModal.jsx       Generic audit-log timeline viewer
      UserManagementPanel.jsx      Admin-only user CRUD table (name, email, role, status, last login)
      TestCaseStoryLinksPanel.jsx  Search+add UI for linking a Test Case ↔ Story ticket (bidirectional)
      ContainerEventsPanel.jsx     FCL container lifecycle log — self-fetching, opened in a Modal
                                   from the container list row's 📋 button in ShipmentDetailPage.jsx
      ShipmentHeaderBar.jsx        Persistent shipment header — mounted once in App.jsx, visible on
                                   Overview + all 8 promoted sub-pages (see Recent changes)
      ServicesPanel.jsx            Dedicated Services Export/Import dashboard, embedded on Overview
                                   (see Recent changes)
```

## Route factory pattern
All route files use `module.exports = function domainRoutes(app, ctx) { ... }`.
The `ctx` object (built in server.js just before route registration) carries every shared
dependency: `db`, mapper functions, middleware factories, helpers, and state:

```js
// Key ctx fields — see server.js for the full object
{ db, uid, ok, err, isUniqueViolation,
  auth, requireRole,
  portLanesMap, portCountryMap, rebuildPortLanesMap, longestLane,
  applyShipmentAccessFilter,
  fxCache, getFxRates, toUsd,
  sanctionsMap, loadSanctionsIndex, syncOfacSdn, scheduleNextOfacSync,
  normSanctionName, EMBARGOED_COUNTRIES, getSettings,
  shipmentSubs, broadcastMessage, recomputeSpaceBadge,
  UPLOADS_DIR, SVC_ABBR, LEG_LOC_ABBR,
  VALID_ROLES, ROLE_RANK_SV, primaryRoleSV, parseUserRoles,
  SERVICE_CODE_MAP, importContractRates,
  mapShipment, mapShipmentLeg, mapCostLine, mapService, mapContainer, mapAllocation,
  mapCarrier, mapVessel, mapPortLocation, mapLinkedPort, mapTradeLane,
  mapScopeItem, mapAccessConfig, mapRegion, mapCountry, mapTicketLink, mapTicket,
  mapCustomer, mapCommodity, mapSystemMessage, mapMilestone, mapMilestoneTemplate,
  mapContract, mapLeg, mapRate,
  logEvent, logEntityEvent, TRACKED_FIELDS, TRACKED_CTR_FIELDS,
  syncShipmentFromLegs, checkOverlap, screenShipmentById,
  bcrypt, jwt, JWT_SECRET, inverseLinkLabel, fs, path }
```

`shipmentSubs` (Map) is pre-declared at module top — `broadcastMessage` and
`recomputeSpaceBadge` close over it, so it must exist before those functions are defined.

The original inline routes remain in server.js as **dead code** (route files register first;
Express uses first-match). They act as a fallback and can be deleted once the extracted routes
are fully validated.

## Database — 40 tables listed below (55 total — see the About page's Architectural Details tab for the full domain-grouped list)
| Table | Purpose |
|---|---|
| shipments | Core shipment records |
| containers | Container-level cargo detail, plus VGM/CY-cutoff/Demurrage-Detention compliance fields (v0.30.0) |
| allocations | Space configurations (TEU per carrier/route/contract) |
| carriers | Carrier MDM |
| vessels | Vessel MDM (IMO registry) |
| port_locations | 14,269 UN/LOCODE ports (has last_synced_at) |
| linked_ports | Port equivalence pairs — conflict detection + route matching |
| trade_lanes | FIATA high-level trade lanes |
| country_trade_lanes | Country → lane assignments |
| regions | Region MDM |
| countries | ISO 3166-1 countries + portCount via JOIN |
| tickets | Kanban board cards (shipment_id FK, parent_id, assignee_id, due_date, version) |
| ticket_links | Cross-ticket dependency relationships (blocks / is blocked by / etc.) |
| shipment_events | Full audit log: FIELD_UPDATED, STATUS_CHANGED, CONTAINER_ADDED/REMOVED/UPDATED |
| shipment_messages | Per-shipment threaded messages with author, role, timestamp |
| shipment_legs | Multimodal legs: leg_type, movement_type, pol_loc_type, pod_loc_type, movement_by |
| shipment_cost_lines | BUY/SELL cost lines per shipment with source tracking and FX |
| shipment_milestones | Per-shipment milestone steps (estimated date, completion, note) |
| shipment_schedules | Per-shipment saved sailings: carrier, vessel, voyage, ETD, ETA, transit days, isMock, savedBy |
| shipment_services | Dedicated Services (Export/Import): side, service_type, status lifecycle, vendor, office, dates — Epic TKT-A5LUPD |
| shipment_screenings | OFAC/SDN screening results and override records |
| shipment_documents | Uploaded documents metadata (filename, type, label) |
| status_log | Shipment status transitions (legacy, kept for compat) |
| entity_events | Generic audit log for allocations, carriers, contracts |
| commodities | 294 Maersk freight commodity codes (Grades M/K/E/S/Q) |
| customers | Customer records with full address and contact details |
| contracts | Carrier rate contracts with IMDG class filters |
| contract_legs | POL/POD pairs per contract with linked-port flags + haulage columns + loc types |
| contract_rates | Rate entries per contract |
| milestone_templates | Reusable milestone step definitions grouped by template key/carrier/lane |
| system_messages | Operational notices with severity and active date range |
| sanctions_entries | OFAC SDN entity records |
| sanctions_syncs | OFAC sync history (timestamp, source, count) |
| app_settings | Key-value store for server-side config (API keys, toggles, recurrence) |
| users | Authenticated users: id, email, name, password_hash, role, is_active, last_login |
| user_scope_items | Per-user shipment scope restrictions (carrier, POL, POD filters) |
| user_access_configs | Per-user access configuration records |
| test_items | Dedicated test-case repository (separate from `tickets`); optional `shipment_id` FK |
| test_case_links | Test Case ↔ Story links ("tests" / "is tested by") |
| edi_messages | Per-shipment carrier EDI log (direction out/in, raw/parsed payload, `is_mock`) |
| container_events | FCL container lifecycle log (event_type, location, occurred_at, recorded_by) — Epic TKT-A5LUPD |

## Key patterns
- **PortCombobox dropdown**: always `position: fixed` with `getBoundingClientRect()` to escape modal `overflow:auto`
- **Paginated responses**: `api.ports.search(...)` returns `{ results: [], total, limit, offset }` — always use `.results`
- **mapCountry** includes `portCount: r.port_count ?? 0` from a LEFT JOIN in GET /api/countries
- **Migrations**: safe `try/catch` array in server.js startup — add new columns there
- **Backfill**: `backfillPortCountryCodes()` IIFE runs on startup
- **Toast**: `import { toast } from './toast'` → `toast.success/error/warning/info(msg)`
- **Version**: update `src/version.js` + `CLAUDE.md` + `README.md` on every release
- **Routing term**: computed in `syncShipmentFromLegs` from carrier-covered legs only — `legs.filter(l => l.movement_type !== "Merchant's Haulage" && l.movement_type !== "Customer Arranged")`; format `DR-CY`, `PT-PT`, `DR-DR`; `LEG_LOC_ABBR = { Door: DR, Terminal: PT, Container Yard: CY, CFS: CFS }`; stored as `routing_term` on shipments; `mapShipment` uses `r.routing_term || SVC_ABBR[r.service_type]`
- **Leg schema (shipment_legs)**: `leg_type` (Pick-up/SEA/AIR/RAIL/Feeder/Delivery), `movement_type` (Carrier's Haulage/Merchant's Haulage/SEA/Air Freight/Rail/Feeder), `pol_loc_type`/`pod_loc_type` (Door/Terminal/Container Yard/CFS), `movement_by` (Barge/Rail/Truck/Vessel/Air); `LEG_TO_MOT` in routes/shipments.js derives `mot` from `legType` (Pick-up/Delivery → ROAD, SEA → SEA)
- **Contract leg loc types**: `pol_loc_type` / `pod_loc_type` columns on `contract_legs` (Terminal default); selector in MdmContractsPage leg editor; persisted via `saveLegs` in routes/contracts.js
- **Trade lane column**: `longestLane(unlocode)` picks the most specific lane code (longest string) from `portLanesMap[unlocode]` Set; `tradeLane` in `mapShipment` = `polLane → podLane`; `SVC_ABBR` maps service_type to short codes: Port-to-Port→P2P, Door-to-Port→D2P, Port-to-Door→P2D, Door-to-Door→D2D
- **Theme**: `T.surface`, `T.bg`, `T.text`, `T.textMuted`, `T.accent`, `T.border`, `T.success`, `T.danger`, `T.warning`, `T.info`
- **VesselField**: named export `{ VesselField }` not default
- **EntityHistoryModal**: accepts `entityType`, `entityId`, `title`, `headerContent`, `onClose`; bridges to `shipment_events` for type="shipment", else uses `entity_events`
- **Route matching**: `allocationRouteMatch(s, a, contractsById, linkedPortIdx)` in tokens.js — defers to the allocation's contract legs (`polLinkedAllowed`/`podLinkedAllowed`) for linked-port expansion; falls back to exact pol/pod equality when no contract is loaded
- **contractMatch**: `contractMatch(s, a)` — priority: contractId exact > contractNumber/contractRef string > contractType === "Central Contract"
- **Contract legs loaded on demand**: SpaceConfigurationsPage fetches `api.contracts.get(id)` for each unique allocation contractId and caches in `contractsById` state
- **Auth token**: stored in `localStorage` under key `cargodesk_token`; decoded with `jwt.verify` in `auth()` middleware factory; `api.auth.login(email, password)` → `{ token, user }`
- **useAuth()**: `import { useAuth } from './AuthContext'` → `{ user, activeRole, canEdit, isAdmin, isViewer }`; `canEdit = effectiveRole !== "viewer"` — use this single boolean to gate all write actions
- **Role hierarchy**: admin (2) > operator (1) > viewer (0); `activeRole` overrides `user.role` when an admin is impersonating a lower role
- **ActionMenu null guard**: ActionMenu returns `null` when `items` is empty — safe to always render it with conditional items spread: `...(canEdit ? [{ ...}] : [])`
- **Admin seed**: on first startup, if no users exist, server seeds a default admin: `admin@cargodesk.com` / `admin123` — warn users to change this
- **bcryptjs**: password hashing uses `bcryptjs` (pure JS, no native deps); `POST /api/users` returns `{ ok: true }`, not the created record — reload the list after create/edit
- **Kanban ticket nesting**: `parent_id` self-referencing FK on `tickets` — Epic → Story → sub-task; parent picker in TicketModal; breadcrumb chip on TicketCard and TicketPreview; children list with progress bar in TicketPreview; clicking a child navigates the preview panel
- **Kanban Epic progress ring**: SVG ring on Epic cards showing X% of child tickets done; computed from `allTickets` prop passed down from KanbanPage
- **Kanban assignee**: `assignee_id` FK → `users.id`; `GET /api/tickets` LEFT JOINs users so `assignee_name` and `assignee_initial` are always in the response; `TICKET_JOIN` SQL fragment defined in routes/kanban.js
- **Kanban due date**: `due_date` TEXT (YYYY-MM-DD); `isOverdue(d)` helper; overdue cards show red ⚠ badge
- **Kanban WIP limits**: per-column limit via ⚙; persisted to `localStorage` under key `cargodesk_wip_limits`; amber at limit, red when exceeded
- **Export — CSV**: `GET /api/export/shipments.csv` — server-side, 34 columns, joins port names + container counts + cost totals, respects `applyShipmentAccessFilter`; `api.export.shipmentsCSV()` fetches as blob → `<a>.click()` download
- **Export — XLSX programmatic**: `GET /api/export/dashboard/xlsx` — ExcelJS workbook, 4 sheets (Summary with KPI block + 6-week trend, By Carrier, By Lane, Shipment Detail with autofilter + frozen header), brand palette, formula-based totals; no charts (ExcelJS chart API unreliable)
- **Export — XLSX template**: `GET /api/export/dashboard/template` — loads `exports/dashboard-template.xlsx`, overwrites data ranges (WeeklySummary A11:E16, ByCarrier, ByLane), preserves any Excel charts pre-wired to those named ranges; `npm run export:template` regenerates the base file
- **Export api namespace**: `api.export.shipmentsCSV()`, `api.export.dashboardXlsx()`, `api.export.dashboardTemplate()` — all use direct `fetch` + `blob` → `<a>.click()` pattern (same as documents download)
- **ShipmentDetailPage section nav**: NOT a React tab/state pattern — `ShipmentDetailSidebar` in App.jsx (~1385-1530) is a hardcoded `sections` array (`{id, icon, label, badge?}`, App.jsx:1407-1414) rendered as a list; clicking calls `scrollTo(id)` (App.jsx:1394-1397) → `document.getElementById(id)?.scrollIntoView(...)`. Adding/reordering a section means editing the App.jsx array AND moving the matching `id="shp-*"` anchor div inside ShipmentDetailPage.jsx — the two files must stay in sync manually, there's no shared source of truth
- **Two independent "document" systems** (naming collision, easy to confuse): (1) `DocumentsMenu` inside ShipmentDetailPage.jsx (2711-2919) — a header dropdown that generates B/L Draft/Packing List/Container Manifest client-side via jsPDF, no persistence/tracking. (2) `DOC_TYPES` in App.jsx (~line 56: BL01/CI01/CI02/FR01/FR02/PL01/CO01/CD01/IC01/DG01/OT) — a full document-tracking system with draft/confirmed status per doc type, opened via the "📄 Documents" sidebar button (App.jsx:1484/2382) → `docsOpen` modal, generates HTML docs server-uploaded through `api.documents.upload` (base64 JSON, `shipment_documents` table). When asked to "add a document type" or "generate a document," clarify which system — they don't share code
- **Lifecycle-stage stepper precedent**: no dedicated stepper component exists yet; `MilestonePanel` (ShipmentDetailPage.jsx 1593-~1870) is the closest analog — linear progress bar (1734-1738, `width: ${progress}%`) plus per-step state coloring via `milestoneState()`/`stateColor()` (1666-1676: completed/overdue/current/upcoming) driven by `shipment_milestones` rows (`id, label, estimatedDate, note, completedAt, completedBy`, fixed step keys `booking_confirmed, si_submitted, cargo_gated_in, vessel_departed, bl_issued, vessel_arrived, customs_cleared, cargo_released, delivered`). Any new per-container lifecycle/stage UI should reuse this state-coloring pattern rather than inventing a new visual language
- **Drawer pattern** (MessagesDrawer/EdiMessagesDrawer, ShipmentDetailPage.jsx 954-1578): fixed backdrop + fixed right panel (width 420) with header/close/list/composer; WS-subscribe-while-open with 10s polling fallback (`ws.onerror` → `setInterval(loadRef.current, 10_000)`, cleared on `ws.onclose`/unmount); trigger buttons are adjacent icon buttons in the page header (✉️/📩 messages 3516-3533, 📡 EDI 3534-3543, then `DocumentsMenu` at 3544). Reuse this exact shape for any new slide-out panel (e.g. a Tickets drawer)

## Recent changes (v0.29.0 "Bearing")
- **Persistent Shipment Header**: `src/components/shared/ShipmentHeaderBar.jsx` mounts once in `App.jsx` (above the page switch, guarded by `(page === "detail" || SHIPMENT_SUBPAGE_LABELS[page]) && selectedShipment && isEnabled(page)`) so it's visible on Overview and all 8 promoted sub-pages. Row 1: ID (📋 copy-to-clipboard) · FCL/LCL · POL→POD · ETD/ETA · DG badge (only when a container is flagged). Row 2: Incoterm, Routing (`routingTerm`), Vessel/Voyage, Shipper, Consignee, Contract, TEU, Loop (`shipment_schedules[0].service` — self-fetched, no dedicated `loopCode` field exists). Row 3: a Door → POL ──carrier── POD → Terminal journey bar reusing `CommandCenterView`'s existing node visual language (same `LOC_FULL`/routingTerm-split parsing) rather than a new one — location type (Door/CY/CFS) labeled above the dot only for inland extensions, full location names primary with UNLOCODE demoted to a caption. Self-fetches `shipment_legs` to resolve the actual first/last **SEA** leg for the Port nodes and carrier caption — `shipment.pol`/`pod` are the journey's overall bookends (`legs[0]`/`legs[-1]`), not the same thing when there's a Door pickup or a multi-leg TSP journey.
- **Dedicated Services** (Epic `TKT-A5LUPD` → Story `TKT-9DGDNP`): new `shipment_services` table (`side` Export/Import, `service_type`, `status` Requested→Confirmed→Completed/Cancelled, `vendor_id`/`vendor_name`, `office_id`, `requested_date`/`confirmed_date`/`completed_date`, `notes`) with `GET`/`POST`/`PATCH`/`DELETE /api/shipments/:id/services` in `routes/shipment-ops.js`, `mapService` joining `office_code`/`office_name`. `src/components/shared/ServicesPanel.jsx` — self-fetching, embedded directly on the Overview page (deliberately **not** a promoted sub-page, per explicit user direction — it's meant to stay visible as a dashboard, unlike everything else that got promoted this session) — renders two columns (Export/Import), each with a "+ Request Service" modal (service type, vendor via `CustomerCombobox`, office defaulted to `shipment.emoOfficeId`/`imoOfficeId` per side via the same `offices.filter(o => o.department === 'SE'|'SI' && o.isActive)` pattern already used in `ShipmentFormPage.jsx`, requested date, notes) and inline Confirm/Complete/Cancel status buttons. Status transitions stamp `confirmed_date`/`completed_date` server-side and log through `logEntityEvent('service', ...)` — same generic audit mechanism as cost lines/documents. Deliberately **not** linked to `shipment_legs` (a leg tracks physical routing, a service tracks commercial ordering/vendor/status) and vendor rows are **not** sanctions-screened (`screenShipmentById` only checks shipper/consignee/principal by a hardcoded field list) — both documented as known follow-ups in `TKT-E64LKG`.
- **Schedules page overhaul** (`ShipmentSchedulesPage.jsx`): now shows **Route Legs** (`LegsTable`, imported from `ShipmentFormPage.jsx` — the exact same live-editing component used in the full shipment form, `showContractCols={false}` hides Contract Type/No. here), **Schedule History**, then `RouteSummaryBar` (relocated from Overview — see below). Two real bugs fixed: (1) legs now **auto-order** Pick-up-first/SEA-middle/Delivery-last on every `addLeg`/`saveLeg` (`orderLegs()` helper, stable sort by `LEG_TYPE_RANK`, re-stamps `legOrder` and persists via `Promise.all(api.legs.update(...))`) — previously a new leg always appended at the end regardless of type, landing after an existing Delivery leg; (2) **"Add Sailing" is TSP-aware** — `applySailingToLegs()` (now living in `ShipmentSchedulesPage.jsx`, not `SchedulesPanel`) mirrors `ShipmentFormPage`'s own `applySailingToLegs` but operates via live `api.legs.*` calls against an **existing** shipment's already-persisted legs instead of local draft state; a multi-leg (`sailing.legs.length > 1`) sailing updates the first SEA leg and replaces any trailing ones with fresh legs per remaining segment, while a direct sailing collapses back to one SEA leg **and resets pol/pod** (previously left pod stuck on a stale TSP transshipment hub if a direct sailing was picked after a TSP one). "Add Sailing" button moved next to the Route Legs section header. The old always-expanded Sailings box is renamed `ScheduleHistoryPanel` (still exported from `ShipmentDetailPage.jsx`) — now a **read-only** SAVED/REMOVED audit trail (`GET /api/shipments/:id/schedule-events` reads `entity_events WHERE entity_type='schedule'`, unmapped/snake_case rows same as `cost-line-events`) instead of the add/remove UI, which moved to `ShipmentSchedulesPage.jsx` itself. Follow-up ticket `TKT-E64LKG` tracks renaming the page to "Contracts & Schedules", adding contract attachment here, and converting history to a button-opens-modal pattern.
- **`RouteSummaryBar`** (`ShipmentDetailPage.jsx`, exported): the old grid-based Pick-up/POL/POD/Delivery route panel, extracted out of the Overview page entirely (self-fetches `shipment_legs` + contract carrier fallback) and relocated to the Schedules page only.
- **Overview page consolidation**: `ShipmentDetailPage.jsx` shrunk to just the View Only banner + `ServicesPanel` — everything else (Messages/Share/Refresh/EDI/Edit actions, header identity/status, space config, route summary, cost/schedule/milestone/ticket pointer links, history, and — as of v0.30.0 — Contract & References and Cargo Details) was relocated to `ShipmentHeaderBar.jsx`, a dedicated sub-page, or removed as a redundant pointer link. `ShipmentHeaderBar.jsx` Row 1 also carries an iOS App-Library-style `IconTile` icon cluster (Messages/Share/Refresh/EDI/Edit, max 2 rows, custom hover tooltips — not native `title`) plus two mutually-exclusive badges: `⚠ Contract Mismatch` (Central contracts whose route no longer matches) and `🔄 Contract Match Found` (Pending contracts whose free-text `contractRef` now string-matches a real Active contract). Shipment history was promoted to its own page (`ShipmentHistoryPage.jsx`, bottom of the sidebar nav, `GET /api/shipments/:id/events` rewritten to the global `{results,total,limit,offset}` pagination shape).
- **Badge-vs-modal split pattern**: both `ContractMismatchModal` and `PendingRevalidationModal` follow the same shape — `ShipmentHeaderBar.jsx` (mounted once, remounts on every sub-page nav) shows only a lightweight clickable badge that navigates to Contracts & Schedules; the actual interactive modal (with Accept/Change/Dismiss actions) renders only on `ShipmentSchedulesPage.jsx`, which duplicates the same cheap revalidation `useEffect` rather than sharing state, so the fix UI never re-pops on every header remount. `PendingRevalidationModal` is exported from `ShipmentDetailPage.jsx` alongside `ScheduleHistoryPanel`. `ShipmentSchedulesPage.jsx` also restores a **Space Configuration** panel (carrier/pol→pod, contract number, validity, consumed/allocated TEU progress bar) for Central shipments with a linked `allocationId`, sourced from `GET /api/allocations/match` (already computes `consumedTEU`/`remainingTEU` server-side) filtered to the matching `id` — this had been silently dropped during the Overview consolidation above until a follow-up code review caught it.

## Recent changes (v0.30.0 "Fairway")
- **FCL container compliance trio** (Epic `TKT-A5LUPD`: `TKT-FT8S9F` Demurrage/Detention, `TKT-5L6NS6` VGM, `TKT-4KQ9OL` CY cutoff): six new nullable columns on `containers` (`vgm_weight_kg`, `vgm_status` default `'Pending'`, `vgm_cutoff`, `cy_cutoff`, `origin_free_time_days`, `dest_free_time_days`) — no new tables, `container_events` already covers the event-log dependency. `cutoffState()` in `server.js` (used inline in `mapContainer`) computes VGM/CY badge state (`none|ok|amber|red|closed-ok`) purely from the row + today, no join needed; `closed-ok` once `vgmStatus === 'Submitted'` regardless of date. `deriveFreeTime()`/`freeTimeWindow()`/`groupContainerEvents()` in `routes/shipments.js` compute demurrage/detention state from a **batched** `container_events` join across `GET /api/containers` (one query for the whole list, not N+1) — **`[ASSUMPTION]`**: origin window anchors on `Gate In`, closes at `Sailed`; destination anchors on `Discharged`, closes at `Gate Out` — this follows the ticket's literal wording, not necessarily the classical trade definition (origin = `Empty Pickup → Gate In`); flagged for correction if wrong. `POST`/`PUT /api/containers` apply the same derivation to the single affected row so a freshly saved container doesn't show a stale badge until the next list reload. `ContainerForm` gains two new numbered sections (⑤ Compliance & Cutoffs, ⑥ Demurrage & Detention — Free Time, finally using the already-imported-but-unused `DatePicker`). `CUTOFF_STATE_VARIANT`/`COMPLIANCE_STATE_LABEL`/`worstState`/`worstComplianceState` in `tokens.js` map a state string to a `Badge` variant/label and pick the worst of a list — `ShipmentContainersPage.jsx` stacks up to 3 badges (VGM/CY/combined-Free-Time) in a new Compliance column; the Overview compact Cargo preview (before it was removed, see below) used a single worst-of-all-four badge instead, since that row has no room for three.
- **Contracts & Schedules polish** (`TKT-E64LKG` remaining scope — items 1/2, rename + contract attachment, already shipped in v0.29.0): Schedule History collapsed from an always-expanded box into a small `⏱ History` button that opens the **same** `ScheduleHistoryPanel` inside a `Modal` — the panel gained a `forceOpen` prop that skips its own header/toggle/card chrome and renders just the existing event-card body, so the underlying fetch/render logic is untouched, only where it mounts changed. Contract and Space Configuration render side-by-side (`gridTemplateColumns: "1fr 1fr"`) when a space config is linked, full-width otherwise. The page's outer wrapper no longer caps at `maxWidth: 1100` — the Route Legs table now renders at essentially the same width as the persistent header bar above it (~5px difference in practice) with no column-width changes needed. `RouteSummaryBar` was briefly added to the top of this page in-session and then removed again — it duplicated the persistent header's own Row 3 journey bar, which is visible on this page too since the header mounts on every promoted sub-page.
- **Shipments list / export POD accuracy fix**: `shipment.pol`/`pod` are door-to-door bookends (see the Persistent Header entry below) — for a shipment with a Door pickup or trucked final Delivery leg, the real sea Port of Loading/Discharge can differ (e.g. shipment.pod showing an inland city like Chicago when the actual sea discharge port is New York). `resolveSeaPorts()` in `routes/shipments.js` (`GET /api/shipments`) and a duplicate in `routes/export.js` (`queryShipmentRows`, feeds both the CSV export and the XLSX dashboard export) batch-resolve each shipment's real first/last SEA leg POL/POD in one query across the whole list, exposed as `seaPol`/`seaPod`/`seaPolName`/`seaPodName` alongside the existing raw `pol`/`pod`. `ShipmentsPage.jsx`'s POL/POD columns show the resolved sea port as primary with a small `Door: {pol}` / `→ {pod}` caption when it differs from the door-to-door value (not discarded); the search filter matches against both. CSV export gets dedicated `Door Pickup`/`Door Delivery` columns. **Known remaining gap, not yet fixed**: the margin-by-lane grouping in `routes/export.js` (`buildMarginSummary`) still joins `shipment_cost_lines.pol`/`pod` raw from `shipments` — same underlying issue, different surface, out of scope for this pass.
- **New-shipment form sailing-search + validation fixes** (`ShipmentFormPage.jsx`): the same door-to-door-vs-real-SEA-leg gap above also existed here independently — `const seaLeg = legs.find(l => l.legType === "SEA")` only ever found the **first** SEA leg of a multi-leg TSP journey, so the Route Summary's Port of Discharge, the sailing-search target port, and `LegsTable`'s own footer summary line ("N legs POL → POD") could all show a mid-journey hub instead of the true final port. Fixed by replacing `seaLeg` with `seaLegs`/`firstSeaLeg`/`lastSeaLeg` (mirrors `RouteSummaryBar`'s existing pattern) and reusing the page's own `cLegsForMatch` filter (excludes Merchant's Haulage/Customer Arranged legs) for `derivedPol`/`derivedPod` instead of raw `legs[0]`/`legs[last]`. `applySailingToLegs()` now drops every SEA leg **after** the first before applying a newly-picked sailing's legs (previously only spliced new legs in after the first, leaving stale pre-existing trailing SEA legs — e.g. from a contract's own multi-leg routing — still in the array); the non-TSP branch also now resets pol/pod like the `ShipmentSchedulesPage.jsx` version already did. Separately: a **Customer Arranged** Pick-up/Delivery leg — explicitly the customer's own responsibility, not ours — left incomplete (no POL/POD) no longer blocks `valid`/Create Shipment; `derivedPol`/`derivedPod` skip past it to the next leg inward via the same `cLegsForMatch` filter.
- **Overview further consolidated**: the Contract & References and Cargo Details cards (and their "Show all details" modal) are gone from Overview entirely. Contract & References is promoted to a new dedicated page, `ShipmentConditionsPage.jsx` ("Conditions" in the sidebar, right after Overview) — same read-only content (Contract Type/ID, Incoterm, Booking Ref, B/L Number, conditional Commodity/Declared Value/Notes), now a full page instead of a card-behind-a-modal; `CommodityDisplay` was exported from `ShipmentDetailPage.jsx` for reuse there. Cargo Details (the container preview card) was dropped outright since it duplicated the dedicated Cargo page. Removing both cards left the "Add/Edit Container" and "Containers list" modals on `ShipmentDetailPage.jsx` with zero reachable triggers (their only entry points), so that dead code — `ctrModal`/`ctrListOpen`/`ctrFromList`/`eventsCtr`/`confirmCtr`/`dgPolicy` state, `closeCtrModal`, three `Modal` blocks, and the now-permanently-`false` `isDirty`/beforeunload effect — was removed too. The redundant **Services** sidebar entry was also removed (it anchor-scrolled to the same `ServicesPanel` Overview already shows in-page) — `ServicesPanel` itself is unchanged, still embedded directly on Overview.
- **New div `id`s on `LegsTable`/`LegRow`** (`ShipmentFormPage.jsx`): every cell (`leg-${legId}-${field}`, e.g. `leg-draft_123-pol`) and the Route Summary's POL/POD/transit/PKU/DEL cells (`shpform-route-*`) now carry stable ids for easier DevTools inspection/bug reporting — no behavior change.
- **`PortCombobox.jsx`**: the unselected search-input wrapper gained `paddingTop/paddingBottom: 5` — purely cosmetic, doesn't affect dropdown positioning since `positionDrop()` measures the `<input>` itself via `getBoundingClientRect()`, not the padded wrapper.

## Recent changes (v0.27.0 "Lookout")
- **FCL container lifecycle events** (first piece of the FCL shipment-management push, Epic `TKT-A5LUPD`): `container_events` table logs per-container movement (`Empty Pickup → Gate In → Loaded → Sailed → Discharged → Gate Out → Empty Return`), replacing shipment-level-only milestones as the foundation for demurrage/detention tracking. Routes in `routes/shipments.js` — `GET`/`POST /api/containers/:id/events`, `DELETE /api/container-events/:id`; POST validates `eventType` against the fixed list and logs a `CONTAINER_EVENT_ADDED` row to `shipment_events` (audit trail, same as `CONTAINER_ADDED`/`CONTAINER_UPDATED`). Frontend: new shared `ContainerEventsPanel.jsx` (self-fetching, chronological list + inline log-event form that suggests the next unused event type), opened via a 📋 button on each row in the container list modal (`ShipmentDetailPage.jsx` ~4181). Also fixed a data-entry gap found while building this: `seal_number` existed in the `containers` schema and backend routes but was never exposed in `ContainerForm` — added as a field next to Container Number. Remaining Epic stories (demurrage/detention, VGM, CY cutoff/empty equipment, sequential detail-page reorg) are logged and in Ready.
- **EDI Messaging (carrier booking communication)**: `edi_messages` table stores every outbound/inbound EDI exchange per shipment (`direction`, `message_type`, `status`, raw/parsed payload, `is_mock`); `routes/edi.js` — `GET /api/shipments/:id/edi-messages` + `POST .../booking-request`; `maerskBookingRequest()` mirrors `maerskSchedules()`'s real/mock-fallback shape exactly (reads `maersk_api_key`, `Consumer-Key` header, `AbortSignal.timeout(10s)`, returns `null` on any failure → falls back to `mockBookingResponse()`, tagged `is_mock=1`); confirmed bookings do a targeted `UPDATE shipments SET booking_ref=?`; broadcasts `{type:"new_edi_message"}` over the existing `shipmentSubs` WS infra. Frontend: `EdiMessagesDrawer` in `ShipmentDetailPage.jsx` (mirrors `MessagesDrawer`'s WS+polling-fallback shape; rows show a direction badge + status pill + raw/parsed payload toggle instead of chat bubbles), triggered by a 📡 icon in the shipment header. Settings: `maersk-booking` entry in `AppSettingsPage.jsx`'s `EXTERNAL_APIS` (shares the `maersk_api_key` setting with Maersk Schedules). Tracked under Kanban Epic `TKT-R2NCQJ`.
- **Test-case repository separation + Story links**: test-case items live only in `test_items` (own repository, not mixed into `tickets`); `test_case_links` provides a bidirectional "tests" / "is tested by" link between a Test Case and a Story ticket, surfaced via the shared `TestCaseStoryLinksPanel.jsx` component (used in both `TestCasesPage.jsx` and `KanbanPage.jsx`'s ticket preview). `test_items` carries an optional `shipment_id` so a test case can be linked directly to a shipment.
- **Sailing management hardening**: `applySailingToLegs` sets ETA + carrierCode; TSP multi-leg support splices draft SEA legs for each voyage segment; edit-mode replace-not-append fixed (`Promise.all` deletes all existing schedules before saving new); active sailing highlighted green in `SailingPickerModal` (`✓ Active` badge, `voyageNumber` or `vesselName+etd` match) — applied in both `ShipmentFormPage` and `ShipmentDetailPage`; replace confirmation uses proper `<Modal>` overlay
- **Negative transit days**: `transitDays < 0` renders `⚠ dates` amber badge with tooltip instead of a negative number (both ShipmentFormPage and ShipmentDetailPage)
- **ShipmentsPage refresh**: background poll every 90 s detects new IDs not yet in view; `↻` button with orange badge showing unloaded count; `_overdue` pseudo-status filter chip ("⏰ Overdue") filters `etd < today && not Completed/Cancelled`
- **ShipmentDetailPage refresh**: `↻` button in page header; calls `api.shipments.get(id)` and merges into app state via `onRefresh` prop; `RefreshBtn` component with CSS spin animation
- **Dashboard Contract Consumption**: three-tier fallback (`contractMap → alloc → group.contractRef`) for `contractNumber` and `carrierCode` — contracts with no space config allocation now always resolve correctly
- **Command Center — KPI filtering**: cards (Active / Pending / Review / TEU / Overdue) toggle local `activeFilter` state; shipments list filters and shows all matches; active card shows `✓` highlight + count header with `✕ clear`; `onNavigate` no longer called from cards
- **Command Center — routing bar**: `ShipmentPreviewModal` parses `routingTerm` (e.g. `DR-PT`) to render `Door → POL ──carrier──  POD → Terminal` journey nodes; vessel/voyage + routing term in sub-row
- **Command Center — Integration Board card**: `TicketAlertCard` component fetches `api.tickets.list()` on mount; tabs Overdue / Due This Week; rows show priority dot, ticket ID, title, status badge, days-late counter, assignee avatar; "View board ↗" navigates to Kanban; card only renders when there are overdue or due-soon tickets
- **Command Center — layout**: wrapper changed to `position: fixed` (`top:46, bottom:36, left:240`) escaping `<main>`'s scroll container; CC uses `height: 100%` (dynamic, scales to any viewport); right panel gets `overflow: hidden` — AI chat composer stays visible at all resolutions
- **AI chat drawer**: `overflow: hidden` on drawer panel + `minHeight: 0` on messages div — composer anchored at bottom of right panel
- **api.shipments.get(id)**: `get: (id) => req("GET", \`/shipments/${id}\`)` added to shipments namespace in `api.js`
