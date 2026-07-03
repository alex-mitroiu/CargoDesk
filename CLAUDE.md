# CargoDesk — Project Brief for Claude Code

## Project
Full-stack freight management app. React 18 + Vite frontend, Express + node:sqlite backend.
- Path: `C:\Users\alexm\Desktop\Git-CargoDesk\CargoDesk\`
- GitHub: github.com/alex-mitroiu/CargoDesk (public)
- Version: **v0.20.0 "Lading"**
- Run: `npm run dev` (runs server on :3001 + Vite on :5173 concurrently)
- Seed: `npm run seed` (runs `scripts/import-mdm-data.js`)

## Stack
- Frontend: React 18, Vite, JSX with inline styles (no CSS files, no Tailwind)
- Backend: Express, `node:sqlite` (DatabaseSync — NOT better-sqlite3)
- Design tokens: `src/tokens.js` exports mutable `T` object, `applyTheme(isDark)` for dark/light
- All styling via `style={{ ... }}` using `T.surface`, `T.text`, `T.accent`, `T.border` etc.

## Key files
```
server.js                          Express API + SQLite schema + all endpoints
scripts/
  import-mdm-data.js               Seeds ports, carriers, vessels, commodities (npm run seed)
  seed-contracts.js                Seeds sample carrier contracts (npm run seed:contracts)
  checkdb.js                       Dev utility — inspects DB schema and row counts (npm run checkdb)
sampleDB/
  cargodesk.db                     Pre-loaded sample DB — copy to project root to use
src/
  App.jsx                          Root: routing, nav, state, theme toggle, auth guards, role switcher
  api.js                           All fetch wrappers (api.shipments, api.ports, api.auth, api.users…)
  tokens.js                        T object, theme colours, route-matching helpers
  toast.js                         Pub-sub toast emitter
  version.js                       VERSION, CODENAME, CHANGELOG
  AuthContext.jsx                  createContext + useAuth hook — provides user, activeRole,
                                   canEdit, isAdmin, isViewer to all components
  pages/
    LoginPage.jsx                  Centered login form; calls api.auth.login → onLogin(token, user)
    ShipmentsPage.jsx              Shipment list + ShipmentForm (new/edit)
    ShipmentDetailPage.jsx         Detail view, ContainerForm + ContainerTypePickerModal,
                                   ShipmentTimeline (history tracker), LinkVesselModal
    DashboardPage.jsx              Overview + Contract Consumption tabs, AllocationForm
    SpaceConfigurationsPage.jsx    Standalone Space Configs page with Linked Shipments modal
    DashboardArchivePage.jsx       Expired allocations + renew flow
    KanbanPage.jsx                 Integration board with drag-to-reorder
    AppSettingsPage.jsx            API Controls + Finance + Users (admin only) tabs
    AboutPage.jsx                  DB schema, features, changelog
    mdm/
      MdmCommoditiesPage.jsx       294 Maersk commodity codes
      MdmContractsPage.jsx         Carrier contracts with legs and IMDG class filters
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

## Database — 21 tables
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
| tickets | Kanban board cards (shipment_id FK) |
| status_log | Shipment status transitions (legacy, kept for compat) |
| shipment_events | Full audit log: FIELD_UPDATED, STATUS_CHANGED, CONTAINER_ADDED/REMOVED/UPDATED |
| entity_events | Generic audit log for allocations, carriers, contracts |
| commodities | 294 Maersk freight commodity codes (Grades M/K/E/S/Q) |
| customers | Customer records with full address and contact details |
| contracts | Carrier rate contracts with IMDG class filters |
| contract_legs | POL/POD pairs per contract with polLinkedAllowed / podLinkedAllowed flags |
| contract_rates | Rate entries per contract |
| system_messages | Operational notices with severity and active date range |
| users | Authenticated users: id, email, name, password_hash, role (admin/operator/viewer), is_active, created_at, last_login |

## Key patterns
- **PortCombobox dropdown**: always `position: fixed` with `getBoundingClientRect()` to escape modal `overflow:auto`
- **Paginated responses**: `api.ports.search(...)` returns `{ results: [], total, limit, offset }` — always use `.results`
- **mapCountry** includes `portCount: r.port_count ?? 0` from a LEFT JOIN in GET /api/countries
- **Migrations**: safe `try/catch` array in server.js startup — add new columns there
- **Backfill**: `backfillPortCountryCodes()` IIFE runs on startup
- **Toast**: `import { toast } from './toast'` → `toast.success/error/warning/info(msg)`
- **Version**: update `src/version.js` on every release
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
- **Kanban ticket nesting**: `parent_id` self-referencing FK on `tickets` — Epic → Story → sub-task; parent picker in TicketModal (typeahead filtered to Epics/Stories); breadcrumb chip on TicketCard and TicketPreview; children list with progress bar in TicketPreview; clicking a child navigates the preview panel to that ticket
- **Kanban Epic progress ring**: SVG ring on Epic cards showing X% of child tickets done (green at 100%, accent otherwise); computed from `allTickets` prop passed down from KanbanPage
- **Kanban assignee**: `assignee_id` FK → `users.id`; `GET /api/tickets` LEFT JOINs users so `assignee_name` and `assignee_initial` are always in the response — no second round-trip needed on the client; avatar chip shown on card and preview
- **Kanban due date**: `due_date` TEXT (YYYY-MM-DD); `isOverdue(d)` helper compares against today's ISO date prefix; overdue cards show red ⚠ badge
- **Kanban avatar colour**: `avatarColor(id)` derives a deterministic colour from the user ID string by summing char codes mod palette length — same user always gets the same colour across sessions
- **Kanban WIP limits**: per-column Work-In-Progress limit set via ⚙ in the column header; persisted to `localStorage` under key `cargodesk_wip_limits`; count badge turns amber at limit, red when exceeded; `onSetWipLimit(null)` clears the limit
- **TICKET_JOIN constant**: shared SQL fragment in server.js used by GET, POST response, and PUT response so the assignee JOIN is defined in one place

## Recent changes (v0.20.0 "Lading")
- **Quick Container Setup**: new Containers section in the new-shipment form (hidden on edit); fields: Count, Container Type (`ContainerTypeField`), Weight (kg), Volume (CBM), Distribution (`all` = total÷N, `per` = copy same to each), Cargo Description, DG toggle + IMDG class picker; Generate button builds draft container objects shown as preview chips; on save, containers are created via `api.containers.create({ shipmentId, ...ctr })` after legs and merged into `containers` state
- **Central Contract gate**: clicking "Central" on a new shipment with no draft containers shows `toast.warning` directing the user to generate containers first — ensures contract eligibility can be filtered by cargo details
- **Incoterm → Principal auto-default**: changing Incoterm automatically sets Principal — C/D terms (CPT, CIP, CFR, CIF, DAP, DPU, DDP) → Shipper; E/F terms (EXW, FCA, FAS, FOB) → Consignee; only fires when the relevant party is already selected; done in a single `setF` call for atomicity
- **Routing banner — TSP chips**: `ShipmentDetailPage` loads legs via `api.legs.list` on mount; TSPs derived as `legs.slice(0,-1).map(l => l.pod)`; shown as monospaced chips in the banner centre panel
- **Routing banner — carrier code fallback**: `contractCarrierCode` state populated from `api.contracts.get` fetch; banner displays `shipment.carrierCode || contractCarrierCode` so shipments with a linked contract always show a carrier even if `shipment.carrier_code` is empty
- **`syncShipmentFromLegs` fix (server)**: leg save now uses `COALESCE(NULLIF(?, ''), carrier_code)` — a leg with no carrier no longer overwrites the shipment's stored `carrier_code` with an empty string
