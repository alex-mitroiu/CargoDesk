# CargoDesk — Project Brief for Claude Code

## Project
Full-stack freight management app. React 18 + Vite frontend, Express + node:sqlite backend.
- Path: `C:\Users\alexm\Desktop\Git-CargoDesk\CargoDesk\`
- GitHub: github.com/alex-mitroiu/CargoDesk (public)
- Version: **v0.22.0 "Crossroads"**
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
- **Version**: update `src/version.js` + `CLAUDE.md` on every release
- **Routing term**: computed in `syncShipmentFromLegs` from carrier-covered legs only — `legs.filter(l => l.movement_type !== "Merchant's Haulage" && l.movement_type !== "Customer Arranged")`; format `DR-CY`, `PT-PT`, `DR-DR`; `LEG_LOC_ABBR = { Door: DR, Terminal: PT, Container Yard: CY, CFS: CFS }`; stored as `routing_term` on shipments; `mapShipment` uses `r.routing_term || SVC_ABBR[r.service_type]`
- **Leg schema (shipment_legs)**: `leg_type` (Pick-up/SEA/AIR/RAIL/Feeder/Delivery), `movement_type` (Carrier's Haulage/Merchant's Haulage/SEA/Air Freight/Rail/Feeder), `pol_loc_type`/`pod_loc_type` (Door/Terminal/Container Yard/CFS), `movement_by` (Barge/Rail/Truck/Vessel/Air); `LEG_TO_MOT` in server derives `mot` from `legType` (Pick-up/Delivery → ROAD, SEA → SEA) for the seaLeg sync lookup
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
- **Kanban ticket nesting**: `parent_id` self-referencing FK on `tickets` — Epic → Story → sub-task; parent picker in TicketModal (typeahead filtered to Epics/Stories); breadcrumb chip on TicketCard and TicketPreview; children list with progress bar in TicketPreview; clicking a child navigates the preview panel to that ticket
- **Kanban Epic progress ring**: SVG ring on Epic cards showing X% of child tickets done (green at 100%, accent otherwise); computed from `allTickets` prop passed down from KanbanPage
- **Kanban assignee**: `assignee_id` FK → `users.id`; `GET /api/tickets` LEFT JOINs users so `assignee_name` and `assignee_initial` are always in the response — no second round-trip needed on the client; avatar chip shown on card and preview
- **Kanban due date**: `due_date` TEXT (YYYY-MM-DD); `isOverdue(d)` helper compares against today's ISO date prefix; overdue cards show red ⚠ badge
- **Kanban avatar colour**: `avatarColor(id)` derives a deterministic colour from the user ID string by summing char codes mod palette length — same user always gets the same colour across sessions
- **Kanban WIP limits**: per-column Work-In-Progress limit set via ⚙ in the column header; persisted to `localStorage` under key `cargodesk_wip_limits`; count badge turns amber at limit, red when exceeded; `onSetWipLimit(null)` clears the limit
- **TICKET_JOIN constant**: shared SQL fragment in server.js used by GET, POST response, and PUT response so the assignee JOIN is defined in one place

## Recent changes (v0.22.0 "Crossroads")
- **Multimodal leg UX hardening**: SEA leg Movement Type and Movement By are blank/blocked (show `—`, non-editable); Pick-up and Delivery legs show `—` in the Carrier column (code always derived from the SEA leg); Vessel and Voyage disabled for Pick-up/Delivery legs unless Movement By is Barge; new legs default to `legType: "SEA"`; column order: Leg Type → Movement Type → From → Loc. Type → ETD → To → Loc. Type → ETA → **Carrier** → Movement By → Vessel → Voyage → Ctr. Type → Contract No.
- **Row selection + Remove Leg**: clicking a row highlights it with accent left-border + 6% tint; Remove Leg footer button activates (danger colour) when a row is selected; replaces inline × buttons — no selection = no removal
- **PKU/DEL flanking cells**: both `shp-route` (ShipmentDetailPage) and `shpform-route` (ShipmentFormPage) use a dynamic grid (`${pkuLeg ? "auto " : ""}1fr auto 1fr${delLeg ? " auto" : ""}`) that adds door cells with dashed borders when Carrier's Haulage legs exist; seaport UNLOCODE (`seaLeg?.pol`) shown as Port of Loading — fixes prior mislabelling of door pickup locations as POL
- **Contract matching improvements**: `GET /api/contracts/match` accepts `crd`, `routingTerm`, `pkuLocation`, `delLocation`; uses `seaLeg?.pol` as match POL (not the door UNLOCODE); inclusive haulage logic — contracts with haulage support shown for non-haulage shipments, excluded only when shipment needs haulage (DR routing term) but contract does not; ContractField guard relaxed to POL + POD only (not ETD)
- **contract_legs extended**: `pol_carrier_haulage`, `pod_carrier_haulage`, `pol_haulage_locations`, `pod_haulage_locations` columns added via startup migration
- **portLanesMap live rebuild**: `rebuildPortLanesMap()` called after every country-trade-lane mutation — trade lane assignments take effect immediately without server restart
- **Section IDs**: ShipmentDetailPage (`shp-route`, `shp-info-ports`, `shp-info-dates`, `shp-space`) and ShipmentFormPage (`shpform-parties`, `shpform-cargo`, `shpform-transport`, `shpform-route`, `shpform-containers`, `shpform-contract`, `shpform-status`, `shpform-actions`)
- **Trade lane badge** added to ShipmentDetailPage shipment subtitle
