# CargoDesk — Project Brief for Claude Code

## Project
Full-stack freight management app. React 18 + Vite frontend, Express + node:sqlite backend.
- Path: `C:\Users\alexm\Desktop\Git-CargoDesk\CargoDesk\`
- GitHub: github.com/alex-mitroiu/CargoDesk (public)
- Version: **v0.11.0 "Meridian"**
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
  tokens.js                        T object, theme colours, IMDG_CLASSES, CONTAINER_TYPES
  toast.js                         Pub-sub toast emitter
  version.js                       VERSION, CODENAME, CHANGELOG
  pages/
    ShipmentsPage.jsx              Shipment list + ShipmentForm (new/edit)
    ShipmentDetailPage.jsx         Detail view, ContainerForm, StatusTimeline,
                                   ShipmentTimeline (history tracker), LinkVesselModal
    DashboardPage.jsx              Space configurations (allocations), PortField w/ linked ports
    DashboardArchivePage.jsx       Expired allocations + renew flow
    KanbanPage.jsx                 Integration board with drag-to-reorder
    AboutPage.jsx                  DB schema, features, changelog
    mdm/
      MdmCommoditiesPage.jsx       294 Maersk commodity codes
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
      Btn.jsx Modal.jsx Form.jsx Badge.jsx Spinner.jsx
      ToastContainer.jsx DatePicker.jsx Pagination.jsx
    shared/
      PortCombobox.jsx             position:fixed dropdown (escapes modal overflow)
      CommodityCombobox.jsx        Typeahead with GradePill
      VesselCombobox.jsx           {VesselCombobox, VesselField} named exports
```

## Database — 13 tables
| Table | Purpose |
|---|---|
| shipments | Core shipment records |
| containers | Container-level cargo detail |
| allocations | Space configurations (TEU per carrier/route) |
| carriers | Carrier MDM |
| vessels | Vessel MDM (IMO registry) |
| port_locations | 14,269 UN/LOCODE ports (has last_synced_at) |
| linked_ports | Port equivalence pairs |
| trade_lanes | FIATA high-level trade lanes |
| country_trade_lanes | Country → lane assignments |
| regions | Region MDM |
| countries | ISO 3166-1 countries + portCount via JOIN |
| tickets | Kanban board cards |
| status_log | Shipment status transitions (legacy, kept for compat) |
| shipment_events | Full audit log: FIELD_UPDATED, STATUS_CHANGED, CONTAINER_ADDED/REMOVED/UPDATED |
| commodities | 294 Maersk freight commodity codes (Grades M/K/E/S/Q) |

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

## Recent fixes (v0.11.0)
- shipment_events table: logEvent() called in PUT /api/shipments, POST/PUT/DELETE /api/containers
- Kanban: drag-to-reorder within columns with DropLine indicator
- Countries portCount: LEFT JOIN + startup backfill on country_code
- Trade lanes: GET/PUT /api/trade-lanes/:code/countries endpoints added
- Port locations: last_synced_at column + delta-sync in import-mdm-data.js
- App.jsx: duplicate "mdm-regions" key removed from PAGE_TITLES
