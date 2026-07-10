# CargoDesk — Project Brief for Claude Code

## Project
Full-stack freight management app. React 18 + Vite frontend, Express + node:sqlite backend.
- Path: `C:\Users\alexm\Desktop\Git-CargoDesk\CargoDesk\`
- GitHub: github.com/alex-mitroiu/CargoDesk (public)
- Version: **v0.27.0 "Lookout"**
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
  shipments.js       /api/shipments/* (CRUD, events, status-log, containers, messages, legs)
  allocations.js     /api/allocations/* (CRUD, match, conflicts)
  mdm.js             /api/carriers, /api/vessels, /api/port-locations, /api/linked-ports,
                     /api/trade-lanes, /api/country-trade-lanes, /api/regions, /api/countries,
                     /api/unlocodes, /api/commodities
  kanban.js          /api/tickets/*, /api/ticket-links/*
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
  App.jsx                          Root: routing, nav, state, theme toggle, auth guards, role switcher
  api.js                           All fetch wrappers (api.shipments, api.export, api.auth, api.users…)
  tokens.js                        T object, theme colours, route-matching helpers
  toast.js                         Pub-sub toast emitter
  version.js                       VERSION, CODENAME, CHANGELOG
  AuthContext.jsx                  createContext + useAuth hook — provides user, activeRole,
                                   canEdit, isAdmin, isViewer to all components
  pages/
    LoginPage.jsx                  Centered login form; calls api.auth.login → onLogin(token, user)
    ShipmentsPage.jsx              Shipment list + filters + CSV export button + ShipmentForm (new/edit)
    ShipmentDetailPage.jsx         Detail view, ContainerForm + ContainerTypePickerModal,
                                   ShipmentTimeline (history tracker), LinkVesselModal
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
  mapShipment, mapShipmentLeg, mapCostLine, mapContainer, mapAllocation,
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

## Database — 35 tables
| Table | Purpose |
|---|---|
| shipments | Core shipment records |
| containers | Container-level cargo detail |
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

## Recent changes (v0.27.0 "Lookout")
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
