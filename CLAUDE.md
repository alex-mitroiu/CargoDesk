# CargoDesk — Project Brief for Claude Code

## Project
Full-stack freight management app. React 18 + Vite frontend, Express + node:sqlite backend.
- Path: `C:\Users\alexm\Desktop\Git-CargoDesk\CargoDesk\`
- GitHub: github.com/alex-mitroiu/CargoDesk (public)
- Version: **v0.17.1 "Sentry"**
- Run: `npm run dev` (runs server on :3001 + Vite on :5173 concurrently)
- Seed: `node import-mdm-data.js`

## Stack
- Frontend: React 18, Vite, JSX with inline styles (no CSS files, no Tailwind)
- Backend: Express, `node:sqlite` (DatabaseSync — NOT better-sqlite3)
- Design tokens: `src/tokens.js` exports mutable `T` object, `applyTheme(isDark)` for dark/light
- All styling via `style={{ ... }}` using `T.surface`, `T.text`, `T.accent`, `T.border` etc.

## Key files
```
server.js                          Express API + SQLite schema + all endpoints
import-mdm-data.js                 Seeds ports, carriers, vessels, commodities
src/
  App.jsx                          Root: routing, nav, state, theme toggle
  api.js                           All fetch wrappers (api.shipments, api.ports, etc.)
  tokens.js                        T object, theme colours, route-matching helpers
  toast.js                         Pub-sub toast emitter
  version.js                       VERSION, CODENAME, CHANGELOG
  pages/
    ShipmentsPage.jsx              Shipment list + ShipmentForm (new/edit)
    ShipmentDetailPage.jsx         Detail view, ContainerForm + ContainerTypePickerModal,
                                   ShipmentTimeline (history tracker), LinkVesselModal
    DashboardPage.jsx              Overview + Contract Consumption tabs, AllocationForm
    SpaceConfigurationsPage.jsx    Standalone Space Configs page with Linked Shipments modal
    DashboardArchivePage.jsx       Expired allocations + renew flow
    KanbanPage.jsx                 Integration board with drag-to-reorder
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
```

## Database — 20 tables
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

## Recent changes (v0.17.0)
- AppSettingsPage (new): ⚙ nav item pinned above footer; API Controls tab with External APIs subtab (FX Rates, Weather, OFAC SDN — toggle, recurrence, test, import, sync) and Internal APIs subtab (WebSocket, Shipments, Contracts, Customers, Carriers, Vessels, Ports, System Messages — toggle + latency test); toggles gate corresponding sidebar nav items and render a 🔒 Module Disabled fallback for direct URL access
- App.jsx: appSettings state + PAGE_SETTING_MAP + isEnabled() helper; settings reloaded on nav away from settings page; NavBtn hides when module disabled; User Manual + About moved from sidebar to avatar dropdown; paddingBottom on aside to clear footer
- Sanctions screening: silent auto-screen on POST/PUT /api/shipments when sanctionsMap.size > 0; skips re-screen if compliance override exists or if only non-party fields changed; screening result embedded in response; warning toast on HIT names each flagged party
- OFAC sync: httpsGetFollowRedirects() follows up to 5 redirects; setTimeout overflow fixed (capped at 2,000,000,000 ms); failed syncs retry after 1 h instead of immediately; CSV file-upload path added (Vite large-body passthrough plugin)
- ShipmentDetailPage: compliance badge text simplified to "⚠ Compliance review required"; hover tooltip lists hit parties; header badge fontSize 10.5 → 12 (+15%); edit save refreshes screening state from response
- Badge primitive: size prop added for per-instance font-size override
- server.js: app_settings table + SETTING_DEFAULTS seeding; getSettings() helper; scheduleNextOfacSync() with cap + retry logic; express.json limit raised to 25 mb; POST /api/sanctions/import-csv; GET|PUT /api/settings
