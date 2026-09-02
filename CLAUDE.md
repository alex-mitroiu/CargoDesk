# CargoDesk — Project Brief for Claude Code

## Project
Full-stack freight management app. React 18 + Vite frontend, Express + node:sqlite backend.
- Path: `C:\Users\alexm\Desktop\Git-CargoDesk\CargoDesk\`
- GitHub: github.com/alex-mitroiu/CargoDesk (public)
- Version: **v0.90.0 "Blueprint"**
- Run: `npm run dev` (runs the monolith on :3001 + Vite on :5173 + the Document Distribution Service on :3002 + the PDF Render Service on :3003 + the Contract Management Service on :3004 + the MDM Service on :3005 + the Screening Service on :3006 + the Kanban Service on :3007 + the Customer Service on :3008, concurrently) — zero-script onboarding: first boot with no `cargodesk.db` auto-copies the committed `db/cargodesk.sample.db` (MDM reference data only) into place
- Re-seed: `npm run seed` (runs `scripts/import-mdm-data.js`) — only needed to refresh MDM data from `data/*.csv`/`.json`, not for a normal first run

## Stack
- Frontend: React 18, Vite, JSX with inline styles (no CSS files, no Tailwind)
- Backend: Express, `node:sqlite` (DatabaseSync — NOT better-sqlite3)
- Design tokens: `src/tokens.js` exports mutable `T` object, `applyTheme(isDark)` for dark/light
- All styling via `style={{ ... }}` using `T.surface`, `T.text`, `T.accent`, `T.border` etc.
- `puppeteer-core` is a **root** `package.json` dependency even though no code in the monolith
  or `services/document-distribution/` requires it directly — `services/pdf-render/` (own
  `package.json`, no separate install step) hoists it from the root `node_modules`, matching
  `services/document-distribution`'s own hoisting convention. Don't remove it as apparent dead
  weight; check `services/pdf-render/server.js` first.

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
  kanban.js          /api/tickets/*, /api/ticket-links/*, /api/kb/* — every route branches on
                     app_settings.kanban_source since v0.82.0, proxying to the standalone
                     Kanban/Testing Service in 'remote' mode (services/kanban/)
  testcases.js       /api/test-items/*, /api/tickets/:id/tested-by (Story↔TestCase links) —
                     same kanban_source proxy branch as kanban.js above
  edi.js             /api/shipments/:id/edi-messages, /api/shipments/:id/edi-messages/booking-request
  customs-filing.js  /api/shipments/:id/customs-filings/*, /api/customs-filings — simulated
                     AES/EEI + ISF/AMS filing lifecycle, reuses edi_messages — Epic TKT-XW6TQK
  customers.js       /api/customers/*, /api/fx/*
  quotes.js          /api/quotes/* — Quoting/RFQ pre-booking stage (v0.70.0), converts into a shipment
  opportunities.js   /api/opportunities/* — CRM pre-sales pipeline (v0.85.0), converts into a quote
  sanctions.js       /api/sanctions/* — extracted out of customers.js at v0.81.0 as the first
                     step of the Screening Service extraction (services/screening/)
  contracts.js       /api/contracts/*, /api/entity-events/*
  carrier-invoices.js /api/carrier-invoices/*, /api/carrier-invoice-lines/:id/(approve|dispute) —
                     Freight Audit & Payment (v0.69.0)
  command-center.js  /api/milestones/overdue-summary, /api/exceptions/queue,
                     /api/command-center/carrier-scorecard, /api/command-center/transit-time-trend
                     — Command Center Quality & Exception Management (v0.77.0, Epic TKT-IBHB0K)
  shipment-ops.js    /api/shipments/:id/screening, cost-lines, milestones, documents,
                     services, services/:serviceId/loading-plan, services/:serviceId/haulage
                     (Merchant's Haulage — gate in/out, driver, instructions, cost-line
                     auto-creation, /haulage/:containerId/waypoints), /haulage-waypoints/:id
  finance.js         /api/margin/summary
  system.js          /api/health, /api/system-messages, /api/settings, /api/schedules/*
  export.js          /api/export/shipments.csv, /api/export/dashboard/xlsx,
                     /api/export/dashboard/template
  document-templates.js /api/document-templates/* (CRUD) + /api/document-templates/resolve
                     (cascading office+carrier lookup, mirrors milestone_templates' fallback
                     shape) — Document Template Editor (v0.90.0), BL01 pilot only
scripts/
  import-mdm-data.js               Seeds ports, carriers, vessels, commodities, and the full
                                   208-country/182-country-trade-lane registry, read directly
                                   from the committed db/cargodesk.sample.db (npm run seed)
  export-sample-data.js            Dumps the live business tables (shipments/customers/contracts/
                                   tickets/...) to the committed db/cargodesk.sample-data.json —
                                   run to refresh the snapshot after adding more demo data (npm
                                   run export:sample-data). Excludes/scrubs anything not safe to
                                   publish: users and every user-keyed config table (no real
                                   accounts or password hashes — a fresh clone gets its own
                                   default-seeded admin instead), org_signing_certs (private key),
                                   live API keys inside app_settings, SMTP passwords, and the
                                   already-reference-seeded MDM tables (see import-mdm-data.js)
  import-sample-data.js            Counterpart to export-sample-data.js — loads that committed
                                   JSON into a fresh database so a new clone starts with populated
                                   demo data instead of an empty shell (npm run seed:sample-data).
                                   Idempotent (ON CONFLICT DO NOTHING), safe to run against a
                                   database that already has its own real data
  seed-contracts.js                Seeds sample carrier contracts (npm run seed:contracts)
  checkdb.js                       Dev utility — inspects DB schema and row counts (npm run checkdb)
  create-export-template.js        Generates exports/dashboard-template.xlsx (npm run export:template)
  migrate-contracts-to-service.js  One-time, admin-run migration of local contracts into the
                                   standalone Contract Management Service (npm run
                                   migrate:contracts-to-service) — never automatic, doesn't
                                   flip app_settings.contract_source itself
  migrate-mdm-to-service.js        Same shape, for the MDM Service (npm run
                                   migrate:mdm-to-service) — chunked (port_locations alone is
                                   14,000+ rows), idempotent via INSERT OR IGNORE against each
                                   table's own natural-key primary key
  migrate-sanctions-to-service.js  Same shape, for the Screening Service (npm run
                                   migrate:sanctions-to-service) — chunked at 2,000 rows,
                                   deliberately does NOT carry over sanctions_syncs (sync
                                   history); the service starts that fresh on its own first sync
  migrate-kanban-to-service.js     Same shape, for the Kanban/Testing Service (npm run
                                   migrate:kanban-to-service) — migrates all 7 owned tables
                                   (kb_projects/kb_versions/kb_columns/tickets/ticket_links/
                                   test_items/test_case_links) in one POST to that service's own
                                   /internal/kanban/bulk-import route, INSERT OR IGNORE keyed on
                                   each table's own original id
  migrate-customers-to-service.js  Same shape, for the Customer Service (npm run
                                   migrate:customers-to-service) — migrates all 4 owned tables
                                   (customers/customer_identifiers/customer_contacts/
                                   customer_screenings) in one POST to /internal/customers/
                                   bulk-import, INSERT OR IGNORE keyed on each table's own
                                   original id. Deliberately does not touch customer_documents
                                   (local-only, no cross-service blob storage) or customer_roles
                                   (confirmed dead, derived live from shipments elsewhere)
exports/
  dashboard-template.xlsx          Base XLSX template with named ranges for chart wiring
db/
  cargodesk.sample.db              Committed MDM reference DB (ports/carriers/vessels/commodities/
                                   regions/trade lanes/countries only — no shipments, contracts,
                                   customers, or users). Read directly by `npm run seed`
                                   (scripts/import-mdm-data.js) into the live Postgres/pglite
                                   database — the older "auto-copied to cargodesk.db on first
                                   boot" mechanism was a node:sqlite-era behavior, retired along
                                   with node:sqlite itself once the app moved to Postgres.
  cargodesk.sample-data.json       Committed demo business-data snapshot (shipments/customers/
                                   contracts/tickets/...) — loaded via `npm run seed:sample-data`
                                   (scripts/import-sample-data.js) so a fresh clone starts with
                                   realistic pre-existing data instead of an empty shell. No real
                                   user accounts/credentials/API keys/SMTP passwords — see
                                   scripts/export-sample-data.js's own exclude/scrub list.
src/
  App.jsx                          Root: routing, nav, state, theme toggle, auth guards, role switcher
                                   (2357 lines as of v0.87.0, down from 4678 — the document-action
                                   modals and shell components below were split out into their own
                                   files, TKT-MRFL3O)
  api.js                           All fetch wrappers (api.shipments, api.export, api.auth, api.users…)
  tokens.js                        T object, theme colours, route-matching helpers
  toast.js                         Pub-sub toast emitter
  servicesBus.js                   Tiny pub-sub (same shape as toast.js) — ServicesPanel signals
                                   the shipment sidebar to refresh its Export/Import Services nav
  cargoValueBus.js                 Tiny pub-sub (same shape) — ShipmentContainersPage signals the
                                   persistent ShipmentHeaderBar to refetch its Cargo Value rollup
                                   right after a pack item is priced/repriced/deleted, since the
                                   header never remounts on navigation — Epic TKT-P3ASH1
  shipmentServicePages.js          SERVICE_TYPES catalog + per-service dedicated-page nav/routing
                                   config (side x type page keys/hashes/labels) — Epic TKT-TBS7QD
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
    LoadingServicePage.jsx         "Export/Import Services > Loading/Unloading" dedicated page —
                                   per-container plan table (date+time) + carrier attachment/
                                   produced LP01/UP01 document; serviceType prop picks which.
    GenericServicePage.jsx         Generic dedicated page for every other ordered service type
                                   (VGM, Haulage, Fumigation, Storage, CY Storage, Warehousing,
                                   Pickup/Delivery, Customs Clearance) — notes + generic "OT" doc.
    DashboardPage.jsx              Overview + Contract Consumption + Margin (XLSX export) tabs
    SpaceConfigurationsPage.jsx    Standalone Space Configs page with Linked Shipments modal
    FreightAuditPage.jsx           Freight Audit & Payment (v0.69.0) — carrier invoice list,
                                   cross-shipment exceptions queue, invoice detail with
                                   Approve/Dispute; nested under the Dashboard nav group. New
                                   Carrier Invoice modal has an "Extract from document" upload
                                   (v0.70.0) — POST /api/ai/extract-document pre-fills the form
    QuotesPage.jsx                 Quoting/RFQ (v0.70.0) — top-level nav item, list + New Quote
                                   modal (customer/route/carrier, "Find Matching Contracts" as a
                                   pricing reference, line items) + lifecycle detail modal
                                   (Send/Accept/Decline/Convert to Shipment)
    OpportunitiesPage.jsx          CRM pre-sales pipeline (v0.85.0) — top-level nav item, above
                                   Quotes in the sidebar (real funnel order). List + New
                                   Opportunity modal (title required, everything else optional —
                                   customer via CustomerCombobox in its unresolved/name-only
                                   state) + lifecycle detail modal (Qualify/Mark Lost/Convert to
                                   Quote). Flat table, not a kanban board — see Recent Changes
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
      DocumentTemplatesPage.jsx   Document Template Editor (v0.90.0) — list + free-form canvas
                                   editor for a per-office/carrier document layout, BL01 pilot
                                   only. Canvas dragging/resizing uses raw onMouseDown/mousemove/
                                   mouseup tracking (a genuinely new interaction for this
                                   codebase — every prior drag-and-drop here is native HTML5 DnD
                                   for list reordering, e.g. Kanban columns/admin sidebar order).
  components/
    primitives/
      ActionMenu.jsx   Btn.jsx Modal.jsx Form.jsx Badge.jsx Spinner.jsx
      ToastContainer.jsx DatePicker.jsx Pagination.jsx useResizableColumns.jsx
      PageSizeSelect.jsx           50/75/100 dropdown paired with Pagination.jsx — one shared
                                   `cargodesk_page_size` localStorage preference app-wide (v0.78.0)
    shared/
      ConsumptionBar.jsx           3-segment stacked TEU bar (Confirmed/Pending/Rejected,
                                   v0.85.0) — shared across SpaceConfigurationsPage's row + Linked
                                   Shipments modal, ShipmentSchedulesPage's Space Configuration
                                   panel, ShipmentFormPage's Contract Picker card
      PortCombobox.jsx             position:fixed dropdown (escapes modal overflow)
      CommodityCombobox.jsx        Typeahead with GradePill + CommodityPickerModal
      VesselCombobox.jsx           {VesselCombobox, VesselField} named exports
      EntityHistoryModal.jsx       Generic audit-log timeline viewer
      UserManagementPanel.jsx      Admin-only user CRUD table (name, email, role, status, last login)
      TestCaseStoryLinksPanel.jsx  Search+add UI for linking a Test Case ↔ Story ticket (bidirectional)
      ContainerEventsPanel.jsx     FCL container lifecycle log — self-fetching, opened in a Modal
                                   from the container list row's 📋 button in ShipmentDetailPage.jsx
      AdditionalPartiesPanel.jsx   Extensible party-role assignment (Forwarder, Customs Broker Export/
                                   Import, Trucker Pre/On-carriage, Also Notify, Bank, Insurance
                                   Provider, Agent) — self-fetching, rendered below PartiesOfficesPanel
                                   on ShipmentPartiesPage.jsx — Epic TKT-5XFCAP
      ShipmentHeaderBar.jsx        Persistent shipment header — mounted once in App.jsx, visible on
                                   Overview + every promoted sub-page (gated by SHIPMENT_SUBPAGE_LABELS[page]
                                   being truthy — the component itself has no page-awareness at all).
                                   Deliberately not a fixed count here — it's grown from 7 flat sections
                                   to include Accounting's 3 children, Carrier Booking's 2, and a variable
                                   number of dynamic Export/Import Services pages; add a label to that one
                                   map and any new promoted page picks the header up automatically.
      ServicesPanel.jsx            Dedicated Services Export/Import dashboard, embedded on Overview
                                   (see Recent changes)
      GenerateDocumentModal.jsx    "⚡ Generate Document" modal — doc type picker, calls
                                   dispatchDocBuilder (utils/documentBuilders.js), saves via
                                   api.documents.generate. Extracted from App.jsx, v0.87.0 (TKT-X14K0P)
      SendDocumentEmailModal.jsx   Send a generated document by email, always from the shipment's EMO
      SendDocumentEdiModal.jsx     Send as a formal EDI transmittal (metadata + checksum, no attachment)
      SendDocumentWebhookModal.jsx Send via the shipment's EMO office's configured webhook
      DocumentsModal.jsx           Documents readiness list + the 4 send modals above +
                                   TrackedDocPreviewModal/EntityHistoryModal — standalone=true
                                   renders this as the "Documents" promoted sub-page's own body
      HealthModal.jsx              System Health check panel (HEALTH_CHECKS list, internal + external)
      ShipmentFormSidebar.jsx      New/Edit Shipment form's left sidebar (status, back nav)
      ShipmentDetailSidebar.jsx    Explorer sidebar for an existing shipment — the full promoted
                                   sub-page nav tree, admin-only drag-to-reorder
                                   (DEFAULT_SIDEBAR_ORDER/reconcileSidebarOrder, local to this file)
      HaulageDetailsPanel.jsx      Merchant's Haulage details (gate in/out, driver, instructions,
                                   cost → auto BUY cost line, ordered waypoints incl. GPS mode) —
                                   opened from LoadingServicePage.jsx's per-container row, only
                                   when the covering leg is Merchant's Haulage
```
`src/utils/documentBuilders.js` — the 12 `buildXHtml` document template functions (BL01/MB01/BR01/
CI01/CI02/PL01/CO01/CD01/IC01/DG01/AN01/DO01) + `DOC_TYPES`/`docTypeLabel`/`dispatchDocBuilder`/
`getMissingDocRequirements`, extracted from App.jsx alongside the modals above (v0.87.0) — the same
kind of pure HTML-string builder `src/utils/invoiceGenerator.js` already houses for FR01/FR02/
LP01-family documents (which `dispatchDocBuilder` calls into for those codes).
`src/utils/templateRenderer.js` — the Document Template Editor's own renderer (v0.90.0):
`renderTemplateHtml(template, data)` walks a saved `document_templates` row's field array into a
real HTML string, `resolvePath(data, path)` does the dot-path lookup into the exact same resolved
data bag `GenerateDocumentModal.jsx` already assembles for `dispatchDocBuilder`. Deliberately
bypasses `_invShell`/`INV_CSS` — a template author designs the whole page themselves on the
canvas, so those would double-print a second header. `GenerateDocumentModal.jsx` resolves a
matching template (via `GET /api/document-templates/resolve`) before its existing
`dispatchDocBuilder` call — a match renders through `renderTemplateHtml` instead; no match falls
through to `dispatchDocBuilder` completely unchanged. `BL01` only for now.

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

## Database — 43 tables listed below (77 total as of v0.70.0 — see the About page's Architectural Details tab, or `ARCHITECTURE.md` §6, for the full domain-grouped list)
| Table | Purpose |
|---|---|
| shipments | Core shipment records |
| containers | Container-level cargo detail, plus VGM/CY-cutoff/Demurrage-Detention compliance fields (v0.30.0) |
| allocations | Space configurations (TEU per carrier/route/contract) |
| carriers | Carrier MDM |
| vessels | Vessel MDM (IMO registry). `mmsi`/`ais_verified_at` (v0.55.0) — AIS-observed MMSI (structural link a PositionReport, MMSI-only, needs to resolve back to an IMO) and last-live-confirmed timestamp; blank means MDM-import-only, never seen live |
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
| shipment_legs | Multimodal legs: leg_type, movement_type, pol_loc_type, pod_loc_type, movement_by. `etd_source`/`eta_source` (v0.55.1, `'manual'\|'ais'\|''`) — AIS-confirmed departure/arrival updates `etd`/`eta` in place (an estimate becoming a known fact) rather than a separate ATD/ATA pair; idempotent-confirmation guard (`source==='ais'` means already-confirmed, don't re-fire), a manual edit always overwrites an AIS-confirmed value and clears the flag. Older `atd`/`ata`/`atd_source`/`ata_source` columns (v0.55.0's original, since-superseded design) are left in place, inert |
| shipment_cost_lines | BUY/SELL cost lines per shipment with source tracking and FX |
| carrier_invoices | Freight Audit & Payment (v0.69.0) — a carrier's own submitted invoice per shipment, header only (carrier, invoice number/date, currency, rolled-up status) |
| carrier_invoice_lines | Per-invoice charge lines (v0.69.0) — amount vs. an independently-resolved `expected_amount` (from an accrued `shipment_cost_lines` row, a live `contract_rates` row, or a Detention/Demurrage pre-audit computed from `containers`' free-time fields + `container_events`), variance, and pending/matched/variance/approved/disputed status. Approving posts into the existing cost-line accrual/actualized lifecycle |
| quotes | Quoting/RFQ pre-booking stage (v0.70.0) — precedes and converts into a real shipment. Lifecycle Draft (editable) -> Sent (locked, needs `valid_until` + 1+ lines) -> Accepted \| Declined \| Expired (hourly `expireStaleQuotes()` sweep, mirrors `expireStaleContracts`) -> Converted (Accepted only). `contract_id`/`contract_ref` optional — set when a matched contract was used as a pricing reference, not a hard link |
| quote_lines | The quote's own customer-facing SELL price per line — kept independent of the referenced contract's live rate (a quote commonly already has margin added). On conversion, each becomes a new `shipment_cost_lines` SELL row, `source='quote'`, while the BUY side still comes from `importContractRates()` unchanged if a contract was referenced |
| opportunities | CRM pre-sales pipeline (v0.85.0) — precedes and converts into a real quote. Lifecycle New (editable) -> Qualified (editable) -> Converted (to Quote, Qualified only) \| Lost (from New or Qualified). No line-item child table — pre-pricing, real line-item detail belongs on the Quote it converts into. Only `title` is required; `customer_id` is optional (the same unresolved-customer pattern `quotes.customer_id` already established) |
| shipment_milestones | Per-shipment milestone steps (estimated date, completion, note) |
| shipment_schedules | Saved sailings: carrier, vessel (name + IMO), voyage, ETD/ATD, ETA/ATA, transit days, isMock, source (search/generated), savedBy. `shipment_id` is nullable (v0.54.0) — NULL means an ownerless Schedule Generator "template"; set means a real shipment's own copy, whose `template_id` (self-referential, ON DELETE SET NULL) records which template it was copied from, if any |
| schedule_legs | Per-leg detail (pol/pod/etd/eta/vessel/voyage/service, `leg_order`) for a genuine multi-leg/TSP `shipment_schedules` row — 2+ rows makes it TSP; 0-1 rows means direct, same convention the sailing-search `legs[]` shape already used (v0.54.0) |
| schedule_shipment_links | Legacy many-to-one from the pre-v0.54.0 shared-schedule model (v0.37.0) — no longer written to (Generator-created schedules are ownerless templates now, copied via `template_id` instead of linked); old rows are left in place, harmless |
| shipment_services | Dedicated Services (Export/Import): side, service_type, status lifecycle, vendor, office, dates — Epic TKT-A5LUPD |
| shipment_loading_plan_lines | Per-container loading plan (planned date, sequence, notes) for a Loading service — Epic TKT-TBS7QD |
| shipment_screenings | OFAC/SDN screening results and override records. Since v0.58.0 covers all 13 party-role slots (4 fixed + 9 `shipment_parties`), not just Shipper/Consignee/Principal — each hit's `field` corroborates by both name-match and `customer_id`-against-`customer_screenings` |
| shipment_documents | Uploaded documents metadata (filename, type, label). `bl_surrendered_at`/`_by`, `bl_released_at`/`_by` (v0.90.0, House B/L Lifecycle) — post-issuance facts on a confirmed `BL01` row, same sparse per-doc-type idiom `paid_at`/`paid_amount` (FR01/FR02-only) already established. Idempotent, set via `PATCH .../bl-surrender`/`.../bl-release`, logged through the existing `entity_events` mechanism |
| document_templates | Document Template Editor (v0.90.0) — a free-form canvas layout scoped by `(doc_type, office_id?, carrier_code?)`, `BL01` pilot only. `fields` is a JSON array of absolutely-positioned boxes (bound to a shipment value or free text) or `type:"table"` repeating regions bound to `containers`. No DB-level `UNIQUE` on the scope triple (Postgres treats `NULL <> NULL`, so two generic rows wouldn't collide at the constraint level anyway) — the create route enforces it itself via `IS NOT DISTINCT FROM` |
| status_log | Shipment status transitions (legacy, kept for compat) |
| entity_events | Generic audit log for allocations, carriers, contracts |
| commodities | 294 Maersk freight commodity codes (Grades M/K/E/S/Q) |
| customers | Customer records with full address and contact details. `credit_limit`/`credit_terms_days`/`credit_hold`/`credit_hold_reason` (v0.57.0) — `credit_hold` hard-blocks generating a NEW invoice for shipments where this customer is Shipper/Consignee/Principal/the linked contract's Named Account; `credit_limit` is a soft over-limit warning only, computed live against confirmed FR01/FR02 invoices, never a hard block. `parent_customer_id` (v0.59.0, self-referential, `ON DELETE SET NULL`) — branch/subsidiary rollup; read via the shared `resolveCustomerGroup(customerId)` helper (walks to the root ancestor then every descendant), never a write-path merge. `is_nvocc`/`fmc_number` (v0.71.0) — flags a customer eligible for the "NVOCC" party role and its FMC (or equivalent) license number; `fmc_number` only persists while `is_nvocc` is set, same gating idiom as `classified_location`/lat-lng. Also fully duplicated (own schema) in `services/customers/` since v0.84.0 — Postgres-backed (ARCHITECTURE.md §13, Phase 2), not a SQLite db file — see that section below |
| customer_contacts | Named people at a customer (v0.56.0) — name/title/email/phone/department, one `is_primary` per customer; replaces the old free-text-notes-only workaround. Also in `services/customers/` since v0.84.0 |
| customer_roles | Which of `ALL_CUSTOMER_ROLES` (v0.56.0) a customer is eligible for — `CustomerCombobox`'s `roleFilter` prop narrows pickers against this (soft filter, never a hard block). Confirmed dead (derived live from `shipments`/`shipment_parties` elsewhere) — deliberately excluded from the v0.84.0 Customer Service extraction and its toggle |
| contracts | Carrier rate contracts with IMDG class filters |
| contract_legs | POL/POD pairs per contract with linked-port flags + haulage columns + loc types. `routing_id` (v0.68.0, blank = ungrouped) optionally groups a leg into a named `contract_routings` bundle |
| contract_rates | Rate entries per contract. `routing_id` (v0.68.0) same optional grouping as `contract_legs` |
| contract_routings | Named, ordered routing bundles for a contract (v0.68.0) — a lane bookable via several distinct physical paths (e.g. 3 different transshipment hubs), each independently priced via its own `contract_rates`/`contract_legs` rows. `contracts`/`contract_legs`/`contract_rates`/`contract_routings` are also fully duplicated (own schema) in `services/contract-management/` — Postgres-backed (ARCHITECTURE.md §13, Phase 4), not a SQLite db file — see that section below |
| milestone_templates | Reusable milestone step definitions grouped by template key/carrier/lane |
| system_messages | Operational notices with severity and active date range |
| sanctions_entries | Denied-party entity records. `source` (already generic pre-v0.69.0, just never populated with anything but `'OFAC-SDN'` until now) also holds 11 more list names from the free US Consolidated Screening List (v0.69.0) — BIS Denied Persons/Entity/Unverified/Military End User Lists, State Dept ITAR Debarred + Nonproliferation Sanctions, 5 more OFAC-family lists. Every CSL-sourced row's `id` is prefixed `CSL-` so its own sync can safely scope a delete-then-reinsert without enumerating list names |
| sanctions_syncs | Sync history (timestamp, source, count) — one row per sync JOB (`'OFAC-SDN'`, `'CSL'`), not per list; the CSL job populates many `sanctions_entries.source` values from one sync |
| app_settings | Key-value store for server-side config (API keys, toggles, recurrence) |
| users | Authenticated users: id, email, name, password_hash, role, is_active, last_login |
| user_scope_items | Per-user shipment scope restrictions (carrier, POL, POD filters) |
| user_access_configs | Per-user access configuration records |
| test_items | Dedicated test-case repository (separate from `tickets`); optional `shipment_id` FK |
| test_case_links | Test Case ↔ Story links ("tests" / "is tested by") |
| edi_messages | Per-shipment carrier EDI log (direction out/in, raw/parsed payload, `is_mock`) |
| container_events | FCL container lifecycle log (event_type, location, occurred_at, recorded_by) — Epic TKT-A5LUPD |
| shipment_parties | Additional party roles beyond the 4 fixed shipper/consignee/notify/principal columns (role, customerId, customerName, UNIQUE(shipmentId, role)) — Epic TKT-5XFCAP |
| customs_filings | Simulated AES/EEI (export) + ISF/AMS (import) regulatory filings, UNIQUE(shipmentId, filingType) so both coexist independently — Epic TKT-XW6TQK. `carrier_code`/`vessel_name`/`voyage_number`/`export_date`/`cargo_snapshot` (v0.72.0) — a snapshot of routing + priced cargo captured at Submit time, compared against the shipment's live values to flag a Filed/Accepted filing as stale if either has since changed |

## Key patterns
- **DatePicker with time**: pass `withTime` to get a native time input alongside the calendar in the same popover — `value` becomes `"YYYY-MM-DDTHH:mm"` instead of a bare date (defaults the time to `09:00` the first time a day is picked; reopening lets the time be adjusted independently). The calendar/nav logic internally still operates on just the date part, so every other `DatePicker` call site in the app is unaffected by this prop existing. Used by `LoadingServicePage.jsx`'s per-container planned date field, for both Loading and Unloading — reuse the same prop for any future field that needs date+time rather than building a separate picker.
- **PortCombobox dropdown**: always `position: fixed` with `getBoundingClientRect()` to escape modal `overflow:auto` — `CarrierCombobox` and `DatePicker` (as of v0.40.1) follow the same pattern; any *new* dropdown/popover primitive should too, rather than `position: absolute`, which breaks the moment it lands inside any scrolling/clipped container
- **Paginated responses**: `api.ports.search(...)` returns `{ results: [], total, limit, offset }` — always use `.results`
- **Page-size dropdown (v0.78.0)**: `<PageSizeSelect value={limit} onChange={setLimit} />` (primitives) rendered next to `<Pagination>` on every table that scales with real usage — 50/75/100, one shared `cargodesk_page_size` localStorage key (not per-table). `GET /api/shipments`/`/linked-ports`/`/carrier-agents` all use the same opt-in shape: omit `limit`/`offset` entirely and get today's bare-array response (every existing zero-arg caller, e.g. App.jsx's own shared full-array load, is unaffected); pass them and get `{results,total,limit,offset}` with `status`/`carrier`/`search`/`sort` also opt-in on `/shipments`. Small/bounded tables (a shipment's own cost lines, containers, milestones; org headcount) deliberately stay unpaginated or get lighter client-side slicing — see ARCHITECTURE.md §8.18 for the full scope split.
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
- **Fallback / test admin accounts**: this dev DB has diverged from the seeded default above (its password was changed at some point), so two standing accounts exist for recovery/verification — leave both alone otherwise: `fallback-admin@cargodesk.local` (break-glass admin — stable, not meant to be reset; password stored outside this repo — this file is committed to a public GitHub repo, so it never holds a real credential in plaintext) and `claudeagent@localhost` (role admin — Claude's own account for CDP/browser verification during sessions; safe to reset its password when needed for a verification pass)
- **bcryptjs**: password hashing uses `bcryptjs` (pure JS, no native deps); `POST /api/users` returns `{ ok: true }`, not the created record — reload the list after create/edit
- **Kanban ticket nesting**: `parent_id` self-referencing FK on `tickets` — Epic → Story → sub-task; parent picker in TicketModal; breadcrumb chip on TicketCard and TicketPreview; children list with progress bar in TicketPreview; clicking a child navigates the preview panel
- **Kanban Epic progress ring**: SVG ring on Epic cards showing X% of child tickets done; computed from `allTickets` prop passed down from KanbanPage
- **Kanban assignee**: `assignee_id` FK → `users.id`; `GET /api/tickets` LEFT JOINs users so `assignee_name` and `assignee_initial` are always in the response in local mode (`TICKET_JOIN` SQL fragment, routes/kanban.js) — in remote mode (`kanban_source='remote'`, v0.82.0+) the Kanban Service returns a raw `assigneeId` with no name attached (it owns no `users` table), and the monolith's new `resolveAssigneeNames()` helper (`server.js`, exported via ctx) batch-resolves the name/initial locally before responding, so the response shape is identical either way
- **Kanban due date**: `due_date` TEXT (YYYY-MM-DD); `isOverdue(d)` helper; overdue cards show red ⚠ badge
- **Kanban WIP limits**: per-column limit via ⚙; persisted to `localStorage` under key `cargodesk_wip_limits`; amber at limit, red when exceeded
- **Export — CSV**: `GET /api/export/shipments.csv` — server-side, 34 columns, joins port names + container counts + cost totals, respects `applyShipmentAccessFilter`; `api.export.shipmentsCSV()` fetches as blob → `<a>.click()` download
- **Export — XLSX programmatic**: `GET /api/export/dashboard/xlsx` — ExcelJS workbook, 4 sheets (Summary with KPI block + 6-week trend, By Carrier, By Lane, Shipment Detail with autofilter + frozen header), brand palette, formula-based totals; no charts (ExcelJS chart API unreliable)
- **Export — XLSX template**: `GET /api/export/dashboard/template` — loads `exports/dashboard-template.xlsx`, overwrites data ranges (WeeklySummary A11:E16, ByCarrier, ByLane), preserves any Excel charts pre-wired to those named ranges; `npm run export:template` regenerates the base file
- **Export api namespace**: `api.export.shipmentsCSV()`, `api.export.dashboardXlsx()`, `api.export.dashboardTemplate()` — all use direct `fetch` + `blob` → `<a>.click()` pattern (same as documents download)
- **ShipmentDetailPage section nav**: NOT a React tab/state pattern — `ShipmentDetailSidebar` in App.jsx (~1385-1530) is a hardcoded `sections` array (`{id, icon, label, badge?}`, App.jsx:1407-1414) rendered as a list; clicking calls `scrollTo(id)` (App.jsx:1394-1397) → `document.getElementById(id)?.scrollIntoView(...)`. Adding/reordering a section means editing the App.jsx array AND moving the matching `id="shp-*"` anchor div inside ShipmentDetailPage.jsx — the two files must stay in sync manually, there's no shared source of truth
- **Document system**: `DOC_TYPES` in App.jsx (~line 56: BL01/MB01/CI01/CI02/FR01/FR02/PL01/CO01/CD01/IC01/DG01/OT) — `MB01` (Master Bill of Lading, v0.71.0) is the vessel-operator-to-NVOCC document, a genuinely separate build from `BL01` (NVOCC-to-shipper House B/L), not a mode flag on it — a full document-tracking system with draft/confirmed status per doc type, opened via the "📄 Documents" sidebar button (App.jsx:1484/2382) → `docsOpen` modal, generates HTML docs server-uploaded through `api.documents.upload` (base64 JSON, `shipment_documents` table). (The earlier client-side-jsPDF `DocumentsMenu` component this note used to distinguish from was removed as dead code — it had zero references anywhere in the app.)
- **Lifecycle-stage stepper precedent**: no dedicated stepper component exists yet; `MilestonePanel` (ShipmentDetailPage.jsx 1593-~1870) is the closest analog — linear progress bar (1734-1738, `width: ${progress}%`) plus per-step state coloring via `milestoneState()`/`stateColor()` (1666-1676: completed/overdue/current/upcoming) driven by `shipment_milestones` rows (`id, label, estimatedDate, note, completedAt, completedBy`, fixed step keys `booking_confirmed, si_submitted, cargo_gated_in, vessel_departed, bl_issued, vessel_arrived, customs_cleared, cargo_released, delivered`). Any new per-container lifecycle/stage UI should reuse this state-coloring pattern rather than inventing a new visual language
- **Drawer pattern** (MessagesDrawer/EdiMessagesDrawer, ShipmentDetailPage.jsx 954-1578): fixed backdrop + fixed right panel (width 420) with header/close/list/composer; WS-subscribe-while-open with 10s polling fallback (`ws.onerror` → `setInterval(loadRef.current, 10_000)`, cleared on `ws.onclose`/unmount); trigger buttons are adjacent icon buttons in the page header (✉️/📩 messages, 📡 EDI). Reuse this exact shape for any new slide-out panel (e.g. a Tickets drawer)

## Recent changes (v0.90.0 "Blueprint")
Two features plus a fix wave, bundled into one release rather than three incremental version
bumps for what was really one continuous working session's output (same call as v0.85.0's own
bundling).
- **House B/L Lifecycle Status Tracking** — informed by sourced CargoWise research (Consol/
  Shipment model, eHBL lifecycle language "create/issue → publish/distribute → update/amend"),
  closing a real gap: CargoDesk had no way to record whether a generated House B/L had actually
  been issued, surrendered at origin, or released at destination — `shipments.bl_release_type`
  only ever classified WHAT KIND of release applies, never the real-world temporal state. Direct
  scoping decision: EDI/electronic-transfer explicitly deferred, ships as document generation
  plus the existing print/email distribution only.
- "Issued" reuses the existing `draft→confirmed` transition on a `BL01` document — no new state
  needed — and now also auto-completes the previously-dormant `bl_issued` milestone step (seeded
  since the milestone sequence existed, never wired to any trigger before this). Two new manual
  actions, Mark Surrendered and Mark Released (new `shipment_documents` columns, see table above),
  idempotent, logged via the existing `entity_events` mechanism so they show up in the document's
  existing history modal for free.
- **Document Template Editor** — direct request: let staff define their own document layout per
  office/carrier using a free-form visual drag-and-drop canvas (explicitly chosen over a simpler
  reorderable-field-list alternative), so a layout change no longer means editing JS code. `BL01`
  pilot only — see `document_templates` in the table above and `src/utils/templateRenderer.js` in
  Key files. Canvas dragging/resizing needed a genuinely new interaction for this codebase (every
  prior drag-and-drop here is native HTML5 DnD for list reordering) — plain `onMouseDown`/
  `mousemove`/`mouseup` tracking instead, no new dependency.
- A real Express route-ordering bug was caught by the feature's own test suite:
  `/api/document-templates/:id` was registered before `/resolve`, so `:id` greedily captured the
  literal string "resolve" — fixed by reordering the route registrations.
- **Fix wave**: a real regression in the shipment Edit form — editing ANY field (even something
  unrelated like Booking Reference) on a shipment with zero `shipment_legs` rows (e.g. one
  created directly via API/import, never through the New Shipment form's own leg-creation flow)
  silently cleared `pol`/`pod`, since the save payload always sent leg-derived values with no
  fallback to the shipment's own already-correct current `pol`/`pod` when no legs exist to derive
  from. Server-side validation correctly rejected the resulting empty `pol`/`pod` with a 400,
  surfacing as an uncaught promise rejection in the UI. Fixed in `ShipmentFormPage.jsx`'s
  `handleSave` to fall back to the shipment's existing values in edit mode.
- Also fixed 3 failing/flaking Cypress specs found in CI: `carrier-agents.cy.js` (a
  fullwidth-plus-vs-ASCII-plus button-text mismatch — every "add" button app-wide renders `＋`,
  U+FF0B, not a plain `+`; and a raw `cy.request` missing its own auth header), and
  `pending-revalidation.cy.js` (a stale expected-keys assertion that never accounted for the
  already-shipped `commodityTypes` contract field).
- New `tests/document-templates.test.js` (16 assertions) and `tests/house-bl-lifecycle.test.js`
  (23 assertions), both green; full regression pass across `carrier-booking.test.js` (171),
  `invoice-reversal.test.js` (20), `document-signing.test.js` (16),
  `nvocc-carrier-identity.test.js` (21), `customs-filing.test.js` (39),
  `pagination-standardization.test.js` (24) — all clean, clean build. Both features verified live
  end-to-end via CDP; the `ShipmentFormPage.jsx` fix verified live by reproducing the exact
  failing scenario and confirming the PUT now succeeds with `pol`/`pod` preserved. Cypress itself
  couldn't be run locally to re-confirm the 3 spec fixes (the binary doesn't launch in this
  sandbox, a known pre-existing environment limitation) — each fix was instead verified through
  a direct equivalent (a live HTTP check for the key-shape fix, a live CDP reproduction of the
  exact failing scenario for the regression fix, and direct source confirmation of the button-text
  and missing-header fixes).
- README gains a fifth screenshot (Contracts & Schedules page).

## Recent changes (v0.89.0 "Arbiter")
- **Line Agent auto-resolve/ambiguity picker** — direct follow-up to this session's Carrier
  Agents restructure. `resolveCarrierAgent` already auto-assigns a single Line Agent silently,
  but couldn't distinguish "no match" from "silently picked one of several equally-valid
  candidates." A direct UN/LOCODE or country-level match is exclusivity-enforced at write time
  (only one `carrier_agents` header can claim a port/country per carrier), so real ambiguity can
  only arise from the **linked-ports fallback** — a port linked to 2+ others, each with its own
  independent agent for the same carrier.
- New `resolveCarrierAgentCandidates(carrierCode, portUnlocode)` (server.js) returns every tied
  candidate (tagged `matched_via`) instead of guessing; `resolveCarrierAgent` becomes a one-line
  `candidates[0] || null` wrapper, so its two existing callers need no change for the common
  unambiguous case. Both copies of `maybeAssignLineAgents` (`routes/shipments.js`,
  `routes/quotes.js`'s own duplicate) now only auto-assign on exactly 1 candidate; 2+ is left
  unassigned rather than guessed. MDM Service's `/internal/carrier-agents/resolve` gained a
  parallel `all=1` flag, kept in parity with the monolith.
- **UX mirrors Pending-Contract-Revalidation, not Contract-Mismatch** — an unresolved Line Agent
  already behaves like one with none registered, so nothing is forced. `ShipmentHeaderBar.jsx`
  shows a dismissible-elsewhere badge (new read-only `GET /api/shipments/:id/line-agent-candidates`)
  instead of a blocking modal; the actual picker (`LineAgentCandidatesModal`, new, in
  `AdditionalPartiesPanel.jsx`) lives on the Parties & Offices page with its own independent
  re-detection, and resolves a pick through the **already-existing**
  `POST /api/shipments/:id/parties` — no new write endpoint needed.
- 18 new assertions (`tests/line-agent-candidates.test.js`). `tests/carrier-agents.test.js` (41),
  `tests/quoting-rfq.test.js` (39), and the MDM service's own resolver/toggle suites all
  re-confirmed green. Verified live via CDP end-to-end. ARCHITECTURE.md §8.1 and the Carrier
  Agents User Manual subsection both updated. Clean build.

## Recent changes (v0.88.0 "Custody")
- **Shipment edit-locking** — direct request: two edit-capable users on the same shipment at the
  same time can produce conflicting writes, and this app has no field-level merge/conflict
  resolution anywhere. A coarser, first-come-first-served pessimistic lock scoped to the **whole**
  shipment: whoever opens it first for edit keeps every Save button and edit control on every one
  of its pages (including the full edit form) until they leave; everyone else sees the same
  read-only experience a Viewer role already gets, for as long as the lock holds.
- New `shipment_edit_locks` table (one row per currently-locked shipment). Two new routes,
  `POST`/`DELETE /api/shipments/:id/edit-lock` (`routes/shipments.js`), gated by the same role
  check every other shipment-write route already uses. POST is acquire-or-renew-or-report: the
  current holder calling again is a silent renewal (no broadcast, `lockedAt` unchanged); anyone
  else gets `{ownedByMe:false, lockedByName, ...}` back with **no error status** — a normal 200 the
  caller renders as read-only, not a rejection to handle. DELETE is a safe no-op for a non-holder.
  **No manual force-unlock** — a stale lock (crashed tab, lost connection) self-clears after 30
  minutes with no renewal, a deliberate, discussed decision (not tied to `idleTimeoutMinutes`,
  v0.85.0's unrelated idle-logout setting, even though they happen to share the same 30-minute
  figure today).
- **Reuses the existing per-shipment WebSocket subscription** (`shipmentSubs`) via a new
  `broadcastEditLockChange` helper, sibling to `broadcastMessage` — a locked-out viewer's badge
  clears live the instant the holder leaves, no reload needed, no new WS infrastructure.
- **Frontend wiring lives in `App.jsx`**, not any one page component — the lock is whole-shipment
  (every sub-page plus the full edit form, and `ShipmentHeaderBar` isn't mounted on the edit form)
  so it's keyed off `selectedId` directly. Acquires on open, renews every 5 minutes, releases on
  cleanup (navigating away, or losing edit-capability mid-session). **Downgrades
  `canEditShipments` itself** (the `AuthContext` value) rather than threading a second prop through
  the ~30 files that already check that one flag ad hoc — guarded on `shipmentLock.shipmentId ===
  selectedId` so it can never leak into an unrelated page. New `ShipmentHeaderBar` lock pill
  ("🔒 Locked by {name}"); the existing role-based View Only banner on Overview
  (`ShipmentDetailPage.jsx`) grew a second branch so a lock-caused read-only state gets accurate
  wording instead of the pre-existing "contact an admin for permissions" copy, which would have
  been actively wrong for an edit-capable user who's simply locked out.
- **A real bug found only through live two-browser CDP verification, not the standalone HTTP test
  suite**: the first pass, using two Puppeteer pages in the same browser context, appeared to show
  the release-on-navigate path silently failing — a lock stayed attributed to the original holder
  no matter what. Root cause was in the verification harness, not the app: two pages sharing one
  browser context share `localStorage` per-origin, so the second simulated user's page load
  silently overwrote the first user's auth token in the one shared store, making the first user's
  own release call authenticate as the second user instead. Fixed by using
  `browser.createBrowserContext()` for genuinely isolated storage per simulated user — the real
  two-context repro then passed cleanly end to end, including the live badge appearing/clearing
  with no page reload.
- New `tests/shipment-edit-lock.test.js` (20 assertions: acquire/renew/release, non-holder-release
  is a no-op, re-acquire after release, 404 on an unknown shipment). Full build clean. Verified
  live via CDP with two isolated browser sessions. The 30-minute real-clock expiry itself isn't
  exercised automatically — the same accepted gap this codebase already has for other short-of-
  an-hour time-based rules with no backdating endpoint.
- ARCHITECTURE.md §8.22 (new) and the User Manual's new "Concurrent Editing" reference topic both
  document the feature. In passing, corrected a stale User Manual claim (from the same session's
  earlier Carrier Agents work) that the Capabilities checklist already gates bookings against a
  mismatch — it doesn't yet; only the data exists today.

## Recent changes (v0.87.0 "Consortium")
- **Kanban board cleanup** — a fresh audit of what's still open, cross-checked against real code
  rather than trusted at face value. Found two tickets genuinely shipped long ago but left at "In
  Testing": Scheduled/emailed reports (TKT-IXAR9G — full route file, table, UI, 25/25 tests
  re-confirmed passing) and Document distribution channels (TKT-SLIRP9 — its own standalone
  microservice since v0.64.0). Also found the NVOCC epic's two remaining "logged backlog"
  children were themselves already resolved by earlier work, just never closed out: the
  structural dual-carrier/shipper split (TKT-9O2B3T, via the existing NVOCC party-role
  mechanism) and the two-stage destination release (TKT-IB5IEX, via the already-shipped
  independent `masterBlReleaseType` field). All four flipped to Done after verifying each claim
  against real code.
- **NVOCC co-loading / cross-tariff reference (TKT-UR1X17)** — the epic's one remaining
  genuinely-unbuilt item, closing Epic TKT-Q52B38 in full. Real-world gap: one NVOCC occasionally
  has no direct contract with the vessel operator for a given lane and instead tenders cargo
  through ANOTHER NVOCC's own tariff. New "Co-Loading NVOCC" party role (resolves via the
  existing extensible `shipment_parties` mechanism, zero new party infrastructure) plus a
  free-text `coloadTariffReference` column on shipments (mirrors `contractRef`'s own nature —
  there's no real registry of another NVOCC's tariff in this system).
- `buildMasterBillOfLadingHtml` now resolves the Co-Loading NVOCC, when assigned, as the real
  Shipper on the Master B/L instead of the primary NVOCC — it's the one that actually holds the
  direct Master B/L relationship with the vessel operator. Two additive detail rows ("Co-Loaded
  Via," naming the underlying NVOCC, and the tariff reference itself) appear only when a
  Co-Loading NVOCC party exists; byte-identical to today's direct case otherwise. New field
  editable on `ShipmentFormPage.jsx`, displayed on `ShipmentConditionsPage.jsx`, tracked in the
  existing field-diff audit log.
- 21 new assertions in `tests/nvocc-carrier-identity.test.js`. Since the Master B/L logic is
  client-side JS, verified live via a full CDP pass: assigned both an NVOCC and a Co-Loading
  NVOCC party on a real scratch shipment, drove the actual Generate Document UI end-to-end, and
  inspected the client-built HTML (intercepted before it reaches the server's signing step) to
  confirm the Shipper swap and both new detail rows render with the correct data. Clean build.

## Recent changes (v0.86.0 "Slate")
- **Admin "Reset Demo Data" panel** — direct ask: a way to wipe all demo/business data back to a
  clean slate while keeping MDM reference data intact, so the `.db` file could eventually be
  committed and a fresh clone (or a repeat demo run) starts from a known-good baseline instead of
  needing `npm run seed` or manual cleanup. The natural in-place sibling of Zero-Script Onboarding
  (`db/cargodesk.sample.db`, v0.79.0) — that one seeds a clean database only on first boot when
  none exists yet; this resets an already-running one on demand, no restart needed.
- **19 tables preserved, the rest wiped** — computed dynamically as `(live schema) −
  PRESERVE_TABLES` (`routes/admin-reset.js`), not a hand-maintained mirror of the reset list, so a
  future new table defaults to being wiped unless explicitly added to the preserve set. Preserved:
  MDM core (carriers/vessels/ports/linked-ports/regions/countries/country-trade-lanes/trade-lanes/
  commodities), admin-maintained registries (charge codes, pack/container type definitions, duty
  rate chapters, milestone templates, invoice status reason codes), compliance reference data
  (sanctions entries + sync history), and app-level config (`app_settings`, `system_email_settings`).
  Everything else — all 66 remaining tables, `users`/`org_signing_certs` included — is deleted.
- **`users` is wiped then immediately reseeded, not preserved as-is** — direct answer to "I do not
  want to expose my user account": keeping the acting admin's real account in a shareable baseline
  would defeat the point; leaving `users` empty would lock everyone out. `seedAdmin()`/
  `seedTestFixtureAdmin()`/`seedSigningCert()` (`server.js`) were refactored from three anonymous
  boot-time IIFEs into named, reusable functions — called once at boot exactly as before, and
  again by the new reset route right after the wipe, landing the database in exactly the state a
  fresh boot would produce.
- New `GET /api/admin/reset-demo-data/preview` (admin-only) returns the live preserve/reset table
  lists; `POST /api/admin/reset-demo-data` requires `{confirm: "RESET"}` (exact, case-sensitive)
  as a misclick guard, wraps the delete sweep in `PRAGMA foreign_keys=OFF`/`BEGIN...COMMIT`/
  `PRAGMA foreign_keys=ON` (same bracketing idiom this codebase's own table-rebuild migrations
  already use), then re-seeds and logs one `RESET_DEMO_DATA` row via the existing `logAdminEvent`.
- New admin-only **"Danger Zone"** tab (`AppSettingsPage.jsx`) — a red-tinted warning card naming
  exactly what's preserved vs. reset (including "your own account"), two live scrollable preview
  lists from the preview endpoint, a "type RESET to confirm" gate, and a success modal showing the
  fresh generic credentials before forcing a logout via the existing `cargodesk:logout` mechanism.
- **Deliberately not exercised end-to-end in the automated suite** — same class of decision this
  codebase already made for `POST /api/sanctions/sync*` (v0.72.2: "destructively replaces the live
  synced dataset other tests depend on"). `tests/admin-reset.test.js` (13 assertions) covers only
  the safe guardrails; the real wipe-and-reseed path was instead verified directly against the
  real dev database — backed up first (`cargodesk.db`/`-shm`/`-wal` copied aside), baselines
  recorded (71 carriers / 16 users / 160 shipments), a real reset triggered and confirmed correct
  (carriers still 71, users collapsed to the two generic seeded accounts, shipments at 0,
  `app_settings` intact), then the original database restored and every original count confirmed
  back exactly (71/16/160).
- Clean build, 13/13 guardrail assertions green from a fresh restart.

## Recent changes (v0.85.0 "Approach")
Four pieces of work, bundled into one unified release rather than four incremental version bumps
for what was really one continuous working session's output.
- **Idle-timeout auto-logout, multi-tab aware** — direct request: after 30 minutes of no activity
  anywhere, log the operator out, redirect to login with a clear reason, and return them to their
  own last screen on the next sign-in. Multi-tab awareness was explicit in the ask, since
  shipments already open in new tabs — activity in any tab keeps the whole session alive, and an
  idle timeout in one tab cleans up every other open tab too.
- **New `config/app-settings.yaml`** + **`lib/staticConfig.js`** — the 30-minute threshold is
  deliberately hardcoded, not exposed through the in-app Settings UI (unlike `app_settings`, the
  DB-backed runtime-editable table); read once at boot (new `js-yaml` dependency), falls back to
  the same default with a warning if the file is missing/malformed. Merged into the existing
  `GET /api/settings` response (`server.js`'s `getSettings()`) as `idleTimeoutMinutes` — the
  frontend already fetches that response after login, so no new endpoint was needed.
- **New `src/hooks/useIdleLogout.js`** — every tab writes one shared `localStorage` activity
  timestamp; when one tab's timer crosses the threshold it clears the shared auth token exactly
  like a 401 already does (`src/api.js`'s existing forced-logout precedent), which fires a native
  `storage` event in every *other* open tab automatically — the browser's own cross-tab signal,
  no polling or custom channel. A real gap caught before shipping: a plain manual "Log out" and a
  401 also clear that same token, which would otherwise mislabel other tabs' banners — fixed with
  a second shared key only the idle path sets, cleared on every login so a stale flag can never
  survive to mislabel a later, unrelated logout.
- Each tab remembers its own last screen via `sessionStorage` (per-tab, unlike `localStorage`),
  captured the instant it logs itself out and restored after that same tab's next login —
  deliberately scoped to the idle path only, so a deliberate manual logout still lands on the
  default home screen. New amber/info banner on `LoginPage.jsx`, distinct from its existing red
  wrong-password banner.
- No backend route changes beyond the one-line settings merge. Full frontend Vitest suite
  re-run green, clean build. Verified live via CDP with two real tabs on the same session against
  a temporarily-lowered threshold: both logged out together with the correct banner, and logging
  back in on one tab returned only that tab to its own last screen.

- **Consumption Dashboard follow-up** — direct audit request after the Space Consumption Split
  (below): `DashboardPage.jsx` (the page literally titled "Consumption Dashboard") never read an
  allocation's `confirmedTEU`/`pendingTEU`/`rejectedTEU` at all — it re-derives its own TEU totals
  entirely client-side from shipments+containers, matched to allocations by its own carrier/route
  heuristic, with zero regard for `carrier_bookings.status`. Six surfaces (Overview's KPI tiles,
  "TEU by Carrier" chart, and 6-week trend; Contract Consumption's bars, per-contract header, and
  its own 6-week trend) still lumped every booking status into one green "Consumed" number; the
  Carrier Volumes tab was confirmed **not** a gap — it's explicitly an all-status raw-volume
  metric, untouched. Gap analysis published as an artifact before planning:
  https://claude.ai/code/artifact/338f5c10-2464-430a-bdfd-87703ea414e6
- **"Consumption" on this dashboard now means Confirmed**, matching `remainingTEU = allocated −
  confirmed` shipped everywhere else — Pending/Rejected surface as inline "+N pending · +N
  rejected" captions under every headline figure, never folded back in. Zero new fetches, zero
  schema changes — `shipment.bookingStatus` and the allocation's own bucket fields were already on
  props this page receives.
- Contract Consumption's hand-rolled single-fill bar was replaced with the shared
  `ConsumptionBar` component (new below) — the two pages now render pixel-identical bar semantics
  instead of two implementations quietly disagreeing on what red/amber/green mean. Both
  shipment-row tables gained a small Booking Status badge next to the existing shipment-status
  badge.
- No backend changes. Clean build. Verified live via CDP with a 3-shipment mixed-status fixture
  (Confirmed/Pending/Rejected under one allocation): both tabs showed the correct 2/1/1/8 TEU
  split, matching the Space Configurations page's own visual language exactly.

- **Space Consumption Split** — direct report of a real calculation gap: an allocation's
  `consumedTEU` lumped every linked shipment together regardless of `carrier_bookings.status`, so
  a `Created`-but-unsent booking, one still awaiting a carrier reply, and a genuinely `Confirmed`
  one all counted identically. `routes/allocations.js`'s `loadConsumedTeuMap()` became
  `loadTeuBuckets()` — one `LEFT JOIN carrier_bookings`, grouped by allocation + status, reduced
  into `confirmedTEU`/`pendingTEU`/`rejectedTEU` per this rule: `Confirmed` (the **operator's own
  Confirm click**, not the carrier's raw `last_response_status`) is the only bucket that deducts
  from `remainingTEU`; `Created`/`Pending`/no-booking-row-yet fold into Pending; `Rejected` is its
  own visible segment; `Cancelled` is excluded entirely. All four response sites
  (`GET`/`POST`/`PUT /api/allocations`, `GET /api/allocations/match`) updated. **Zero schema
  migrations** — every field involved was already a plain TEXT column with no CHECK constraint.
- New shared `ConsumptionBar.jsx` (3-segment stacked bar, proportionally compresses + shows a
  "+N over" caption when demand exceeds capacity) replaces the old single-fill bar at all four
  places it appears (see `src/components/` table above). Dashboard's Contract Consumption tab
  computes its own independent, date-ranged figure and never touched these fields — confirmed via
  its own pre-existing code comment — left untouched, a candidate follow-up if ever reconciled.
- **New third EDI outcome: "Confirmed with Changes"** — a real carrier routinely confirms with a
  different vessel/voyage/ETD than requested; this didn't exist as a concept before. The three
  simulated-response builders (`routes/edi.js`) now all start from the last outbound
  booking-request payload (new `getLastOutboundPayload()`) instead of each synthesizing their own
  thin ~6-field subset, so the inbound message's `raw_payload` always carries the full field set
  — the new outcome overrides only what the carrier actually changed. Confirming afterward still
  only flips `carrier_bookings.status` — it does **not** auto-rewrite the shipment's schedule with
  the carrier's proposed vessel/voyage, preserving the deliberate `carrier_bookings`/
  `shipment_schedules` decoupling from v0.35.0. New Sent-vs-Received comparison table on the
  Carrier Booking Review tab (`ShipmentCarrierBookingReviewPage.jsx`), one row per payload field
  with column headers, styled on the existing Equipment-table grid pattern — built entirely
  client-side from data the page already fetches, no new endpoint. Test Tools' EDI Message
  Simulator gained a third "Simulate Confirmed (Changes)" button with Proposed Vessel/Voyage/ETD
  override fields.
- 48 new assertions (`tests/carrier-booking.test.js`, `tests/allocations-crud.test.js`, a two-line
  rename in `tests/contract-improvements.test.js`). Full backend chain re-verified standalone per
  file, zero regressions, clean build. Verified live via CDP end-to-end: a Confirmed-with-Changes
  simulation with a real vessel/voyage/ETD override rendered the comparison table's diff
  correctly; a 3-shipment mixed-status allocation rendered the exact green/amber/red split with
  correct percentages on the real Space Configurations page.

- **CRM / pre-sales pipeline** (`TKT-WW8THL`, Epic `TKT-GTGM6R` Competitive Gap Analysis) — every
  named competitor (CargoWise Opportunity Manager, Magaya CRM, Descartes' forwarder-CRM) bundles
  a lead/opportunity-tracking layer ahead of the shipment lifecycle; CargoDesk's `customers` table
  was a trading-partner record, not a pipeline. New `opportunities` entity precedes and converts
  into a Quote, the same way a Quote already precedes and converts into a Shipment — closes a
  dependency the ticket itself named back when Quoting/RFQ (v0.70.0) hadn't shipped yet.
- **Lifecycle**: New (editable) → Qualified (editable) → Converted (to Quote, Qualified only) |
  Lost (from New or Qualified). No separate "Won" status — Converted **is** the win condition;
  whether the resulting quote then actually closes is that quote's own already-shipped lifecycle
  to own from there, not re-derived on the opportunity. Deliberately no line-item child table —
  an opportunity is pre-pricing, real line-item detail belongs on the Quote it converts into.
  Only `title` is required; customer is captured via the existing `CustomerCombobox` in its
  already-supported unresolved (name-only, no real `customers` row) state, exactly as Quotes
  already does — no new "prospect" customer concept anywhere in the schema.
- **Built entirely from the Quoting/RFQ feature as a structural template** — new
  `routes/opportunities.js` mirrors `routes/quotes.js`'s route-factory shape and lifecycle-
  transition pattern; `POST /api/opportunities/:id/convert` mirrors quote→shipment conversion
  (creates a real Draft quote copying only the fields the opportunity actually has —
  `contractId`/`contractRef`/`incoterm`/`serviceType`/`cargoReadyDate` have no opportunity
  equivalent and are left at the quote's own defaults). One deliberate guard worth naming:
  `estimatedCloseDate` is never written into the new quote's `cargoReadyDate` — "when we expect
  to close this deal" and "when cargo is ready to ship" are unrelated concepts that happen to
  both be dates near a quote's creation, and conflating them would silently corrupt the new quote.
- New `OpportunitiesPage.jsx` mirrors `QuotesPage.jsx` — sidebar places Opportunities directly
  above Quotes, matching the real funnel order. **Flat table + modal, not a kanban-style pipeline
  board** — explicitly chosen after confirming no reusable stage/column component exists anywhere
  in the codebase (`KanbanPage.jsx`'s own board is a single 4358-line file, zero reusable pieces,
  hardcoded ticket-workflow columns, native HTML5 drag-and-drop) — a genuine drag-and-drop board
  remains real, valuable, explicitly-scoped future work, not silently deferred.
- 36 new assertions (`tests/opportunities.test.js`, mirrors `tests/quoting-rfq.test.js`'s shape),
  covering the full lifecycle including both delete guards (blocked only once Converted, same as
  Quotes), both Lost-from-New and Lost-from-Qualified paths, and — the most important case — the
  full opportunity→quote→shipment chain proving the two features compose cleanly rather than just
  asserting the conversion response shape. `tests/quoting-rfq.test.js` re-confirmed unaffected.
  Clean build. Verified live end-to-end via CDP in a real browser: created an opportunity with
  just a title and an unresolved customer name, qualified it, converted it, confirmed the
  resulting quote opened correctly on the Quotes page.

## Recent changes (v0.84.0 "Capstone")
- **Customer/Organization Service extraction (Epic 5)** — the fifth and final planned
  database-per-domain cut (Contract Management v0.68.0, MDM v0.80.0, Screening v0.81.0, Kanban
  v0.82.0), completing the 5-epic Organization Model roadmap begun at v0.56.0. New
  `services/customers/` (port 3008) owns `customers`/`customer_identifiers`/`customer_contacts`/
  `customer_screenings`; new `app_settings.customer_source` toggle (`'local'` default |
  `'remote'`), same one-way-cutover shape as the four toggles before it. `customer_documents`
  (local-only, no cross-service blob storage exists in this codebase) and `customer_roles`
  (confirmed dead — derived live from `shipments`/`shipment_parties` elsewhere) are deliberately
  excluded from the toggle.
- **The screening write/match split** — the hardest technical problem in this cut. The sanctions
  MATCH decision (`screenCustomer()`) can never leave the monolith (depends on the in-memory
  `sanctionsMap`, itself sourced from the Screening Service); only the already-decided result's
  WRITE branches on `customer_source` (new `PUT /internal/customers/:id/screening`). New
  `getCustomerScreeningResult(id)` backs `screenShipmentById`'s own customer-level cross-reference
  read. `screenShipmentById` becoming `async` rippled through every call site across `server.js`,
  `routes/customers.js`, `routes/shipments.js`, `routes/quotes.js`, `routes/shipment-ops.js`, and
  `routes/sanctions.js` — each converted and directly verified.
- **A real gap found and fixed while implementing it**: `screenCustomer()` read the customer row
  directly from the LOCAL table even in remote mode — a customer created after cutover would
  silently never get screened at all. Fixed by routing through `getCustomerRow` (the same shared
  helper backing every credit-hold/over-limit site), which also closed two gaps Stage 2 had left
  explicitly open: `POST`/`PUT /api/customers`'s remote branches now actually call
  `screenCustomer` instead of skipping it.
- **One shared `getCustomerRow(id)` helper** (`server.js`) backs every credit-hold/over-limit read
  site. `resolveCustomerGroup` became `async` with a remote branch calling the service's own
  `GET /internal/customers/:id/group`; `routes/finance.js`'s `rootOf()` (called synchronously
  inside a `.map()`) pre-warms a cache via one `Promise.all` up front rather than going async in
  place. `routes/mdm.js`'s `attachAgentNames()` now batches customer names through
  `callCustomerService`'s own `ids=` filter — a new combined `mdm_source=remote` AND
  `customer_source=remote` test covers the one place two extracted services actually interact.
  `routes/reports.js`'s billing-performance/invoice-collections reports batch every referenced
  customer's credit-terms/deadline fields into one call instead of N-per-row.
- **A second, unrelated real bug found and fixed**: `routes/customers.js` used `getCustomerRow`
  throughout the file but never actually destructured it from `ctx` — crashed the entire monolith
  process the moment the credit-hold-release remote-mode test exercised that path.
- **Also surfaced, not by this cut's own code**: `npm test`'s 53-file chain is `&&`-chained, so
  the first non-zero-exit file (`carrier-booking.test.js`, 5 known PDF-Render-service-dependent
  failures, present long before this session) silently stops everything after it — every "full
  suite green" claim in this project's history was, in practice, only ever confirming that first
  handful of files. Starting the three services that happened to be unavailable this session (PDF
  Render, Document Distribution, Contract Management — all work fine here) let the chain run to
  completion for the first time; logged as a real gap in the test-runner script itself, not fixed
  as a side effect of this cut.
- New `scripts/migrate-customers-to-service.js` (one combined-payload POST to
  `/internal/customers/bulk-import`, INSERT OR IGNORE, idempotent, doesn't flip the toggle).
- 230+ new assertions across `services/customers/tests/`, `tests/customer-service-toggle.test.js`.
  Every directly relevant existing suite re-run green in local mode.
- Full architecture writeup: `ARCHITECTURE.md` §8.1 (extended a fifth and final time).

## Recent changes (v0.83.0 "Berth")
- **eAdapter is now scoped per office, not just per carrier** — direct follow-up: a real carrier
  EDI relationship is negotiated per country/branch, not once globally, and a low-volume office
  is exactly the one a carrier is least inclined to bother giving EDI access to.
  `carrier_eadapter_configs` moves from a bare `carrier_code UNIQUE` key to
  `UNIQUE(carrier_code, office_id)` — a carrier can now hold several configs, one per office it's
  actually set up for. `country_iso2` is always derived server-side from whichever office is
  picked (never trusted from the request body), so the two can never drift apart.
- **`isEdiBookable(carrierCode, officeId)`** (`server.js`) now requires both — a shipment with no
  Export Managing Office assigned can never match a scoped config. `GET /api/eadapter/bookable-
  carriers` gained an `officeId` query param (no param = built-in 3 only); both Carrier Booking
  pages pass the shipment's own `emoOfficeId`. `offices.js`'s delete-guard gained a matching
  check for a referencing eAdapter config. A guarded, one-time table rebuild (same create-copy-
  swap shape as the `shipment_schedules.shipment_id` nullable migration) re-scopes the table;
  any pre-existing carrier-only row is deactivated with an explanatory note rather than guessing
  an office.
- **`EadapterConfigModal`** gained Country/Office selects (Country narrows Office, both required,
  both immutable once saved). Found along the way: the shared `Sel` primitive
  (`components/primitives/Form.jsx`) never supported a `disabled` prop at all — fixed there (same
  class of gap as the pre-existing `hint`-forwarding bug from v0.39.1) so every `Sel` consumer
  benefits.
- **Two real, unrelated test-hygiene bugs found and fixed** while regression-testing this:
  `tests/invoice-collections.test.js` and `tests/billing-performance.test.js` had both been
  silently leaking their own scratch customers/shipments/offices/users on every run — 198 rows
  had quietly accumulated in the dev DB and started polluting other reports' count-sensitive
  assertions. Both fixed; the existing backlog was removed as a one-time correction.
- 47 new/updated assertions (`tests/eadapter.test.js`, fully rewritten around the office-scoped
  shape). Full backend chain green from a fresh restart (same 5 unrelated pre-existing PDF-
  Render-service-dependent failures as the last several releases), clean build. Verified live via
  CDP: opened the real Settings modal, added a draft config, picked a real country, confirmed the
  Office select populated with exactly that country's real active offices.
- Full architecture writeup: `ARCHITECTURE.md` §8.12 (extended).

## Recent changes (v0.82.0 "Gantry")
- **Kanban/Testing Service extraction** — the third and final planned database-per-domain cut
  (MDM v0.80.0, Screening v0.81.0), same local/remote toggle pattern. New `services/kanban/`
  (port 3007) owns `tickets`/`ticket_links`/`test_items`/`test_case_links`/`kb_projects`/
  `kb_versions`/`kb_columns` — every route from `routes/kanban.js`/`routes/testcases.js` ported
  to `/internal/*` verbatim, minus `TICKET_JOIN`'s `LEFT JOIN users` (the service owns no `users`
  table). New `app_settings.kanban_source` toggle (`'local'` default | `'remote'`), same
  one-way-cutover-lever shape as the three sources before it.
- **New shared `resolveAssigneeNames(rows)`** (`server.js`, exported via ctx) batch-resolves
  `assignee_id` → `assigneeName`/`assigneeInitial` after the remote service returns raw ids —
  same batch-`IN` pattern `routes/shipments.js`'s own `resolveSeaPorts()` already established for
  sea-port names. Applied on `GET /api/tickets`/`GET /api/test-items`'s remote branches; the
  frontend's existing assignee-avatar rendering needed zero changes either way.
- **`ensureOpsTicket()` got a real atomicity fix, remote-mode only.** The ops-automation sweep's
  dedupe-on-`(sourceType, sourceId)` check was a plain check-then-insert — a narrow race under
  concurrent sweeps. The Kanban Service's own schema adds a real `UNIQUE(source_type, source_id)`
  constraint `tickets` never had in the monolith, backing a new atomic
  `POST /internal/tickets/ensure` (`INSERT OR IGNORE`) that closes the race outright in remote
  mode; the local path keeps its original behavior, unchanged. `ensureOpsTicket()` and
  `runOpsAutomationSweep()` both became `async` to support this — rippled into the startup call,
  the hourly `setInterval`, and the dev-only `/api/test/run-ops-automation-sweep` trigger route.
- **Two things needed zero special-casing**: Story↔TestCase links (`tickets` and `test_items`
  move to the same service, so the live cross-table JOIN stays entirely server-side there exactly
  like it does locally) and the Command Center's `TicketAlertCard` (already calls
  `api.tickets.list()` over HTTP through the monolith's own `/api/tickets` proxy).
- **New `scripts/migrate-kanban-to-service.js`** migrates all 7 tables in one POST to a new
  `/internal/kanban/bulk-import` route (mirrors MDM's own per-table-array bulk-import shape),
  each table keeping its own original id as an `INSERT OR IGNORE` natural key.
- 60 new assertions (`services/kanban/tests/{kanban-crud,testcases-crud}.test.js`,
  `tests/kanban-service-toggle.test.js` — the last covering toggle admin-gating, full
  local/remote CRUD, assignee-name resolution in remote mode, the story-link JOIN surviving
  remotely, ops-sweep atomicity across two consecutive runs, and the independent-datastore
  proof). Full backend chain green in local mode from a fresh restart (same 5 unrelated
  pre-existing PDF-Render-service-dependent failures as v0.80.0/v0.81.0), clean build. Verified
  live with all four extracted services plus the monolith running together, and via CDP against
  the real Settings UI toggle control.
- **This completes the three-cut database-per-domain extraction plan** (MDM → Screening →
  Kanban/Testing) proposed this session as three published design docs
  (`documentation/splitting-mdm-first.html`, `splitting-sanctions-next.html`,
  `splitting-kanban-out.html`).
- Full architecture writeup: `ARCHITECTURE.md` §8.1 (extended again, third and final time).

## Recent changes (v0.81.0 "Warden")
- **Screening Service extraction** — second of three planned database-per-domain cuts, following
  MDM (v0.80.0) with the same local/remote toggle pattern. New `services/screening/` (port 3006)
  owns `sanctions_entries`/`sanctions_syncs` plus both sync jobs (OFAC SDN, the US Consolidated
  Screening List) and their self-scheduling auto-sync timers, ported wholesale into its own tiny
  settings table — no admin UI for its schedule knobs yet, config + CRUD only this pass, same
  scoping precedent every other extraction has used. A new `app_settings.screening_source`
  toggle (`'local'` default | `'remote'`) selects per-request, same one-way-cutover-lever shape
  as `contract_source`/`mdm_source`.
- **New `routes/sanctions.js`** — the 5 `/api/sanctions/*` routes, which unlike MDM had never had
  a dedicated route file of their own (they'd lived inside `routes/customers.js` since day one),
  were extracted out as the first step, gaining an `isRemote()` branch. `screenCustomer()`/
  `rescreenShipmentsForCustomer()` stayed in `customers.js`, unchanged — they only ever read the
  shared `sanctionsMap` cache, never `sanctions_entries` directly.
- **Real pre-existing bug found and fixed**: `loadSanctionsIndex()` used to do
  `sanctionsMap = new Map()` — a *reassignment* of the module `let`, not an in-place mutation.
  `routes/customers.js` destructures `sanctionsMap` from `ctx` once at module-load time, so its
  captured reference silently never saw a reload after boot (a manual sync, a CSL sync, a CSV
  import, either scheduled timer) — `screenShipmentById` (closes over the variable directly)
  always saw the fresh map; `screenCustomer()`/`GET /api/customers/:id`'s `screeningResult` did
  not. Fixed to `sanctionsMap.clear()` + refill in place, verified with a dedicated regression
  test (sync twice, confirm both paths see the second sync).
- **`syncOfacSdn()`/`syncConsolidatedScreeningList()`** gained a remote-mode branch (POST to the
  service, then locally reload the cache + re-screen active shipments) — the manual "Sync Now"
  button gives the same immediate feedback either way. The two auto-sync schedulers retask
  themselves in remote mode: instead of the elaborate "is a sync due" math (irrelevant once the
  service owns that decision), they become a plain 15-minute cache-refresh poll.
- **New `scripts/migrate-sanctions-to-service.js`** (chunked at 2,000 rows — 25,865 real entries
  migrated in 13 batches in this dev environment) deliberately does **not** carry over
  `sanctions_syncs` — a service that's never independently verified a sync shouldn't claim a
  copied timestamp saying otherwise.
- 25 new assertions (`services/screening/tests/sanctions-sync.test.js`,
  `tests/screening-service-toggle.test.js` — the latter proving local/remote are genuinely
  independent datastores, same as MDM's own toggle test, plus the reassignment-bug regression).
  Full 53-file backend chain green in local mode from a fresh restart (same 5 unrelated
  pre-existing PDF-Render-service-dependent failures as v0.80.0), clean build. Verified live with
  all three extracted services plus the monolith running together: 73 assertions across every
  new toggle/service-scoped test file, all green.
- Full architecture writeup: `ARCHITECTURE.md` §8.1 (extended again).

## Recent changes (v0.80.0 "Atlas")
- **MDM Service extraction** — the first of three planned database-per-domain cuts (proposed as
  design docs this same session: `documentation/splitting-mdm-first.html`,
  `splitting-sanctions-next.html`, `splitting-kanban-out.html`) to actually get built, following
  the exact pattern `services/contract-management/` proved at v0.68.0: a new standalone process
  (`services/mdm/`, port 3005) owns its own SQLite file and a straight port of
  `carriers`/`vessels`/`port_locations`/`linked_ports`/`trade_lanes`/`country_trade_lanes`/
  `regions`/`countries`/`commodities`/`carrier_agents`, reached via a new `callMdmService()`
  helper and a new `app_settings.mdm_source` toggle (`'local'` default | `'remote'`) — same
  one-way-cutover-lever shape as `contract_source`. Every one of `routes/mdm.js`'s ~48 routes
  gained an `isRemote()` branch; the local path is untouched.
- **Two real cross-cutting risks, both resolved rather than glossed over.** `portLanesMap`/
  `portCountryMap` (`server.js`) are read synchronously on every shipment mapped — these stay
  in-memory caches in either mode, rebuilt from one bulk `GET /internal/port-lanes-index`/
  `-country-map` call in remote mode, never a live per-request fetch. `lib/ais-listener.js`'s
  persistent AIS connection writes `vessels` and reads `port_locations` inside its hot per-frame
  `PositionReport` loop — in remote mode, vessel writes fire-and-forget a
  `POST /internal/vessels/upsert` (never awaited, matching this module's own "never block on
  network I/O" rule), and a port-coords cache miss returns `null` for just that one frame while a
  background bulk fetch repopulates the cache.
- **`resolveCarrierAgent` became async** — its remote branch calls the MDM Service's own new
  `GET /internal/carrier-agents/resolve` (does its own linked-port fallback server-side, since it
  owns both `carrier_agents` and `linked_ports`), then the monolith attaches the agent's name via
  one local `customers` lookup (the service owns no `customers` table). Rippled into
  `maybeAssignLineAgents` (`routes/shipments.js`, `routes/quotes.js`) and one previously
  non-async `PUT /api/shipments/:id` handler, all now properly `await`ed.
- **New `services/mdm/mdm.sample.db`** (committed, additive — `db/cargodesk.sample.db` is
  untouched), seeded via `scripts/import-mdm-data.js`'s new `--db=<path>` flag plus the
  monolith's own full 208-country/182-country-trade-lane lists, deliberately excluding
  `carrier_agents` (every row points at a `customers` record a fresh install doesn't have yet).
  Auto-copied to `mdm.db` on first boot with no database yet, same zero-script pattern as the
  monolith's own onboarding.
- **Named, accepted gap**: 11 secondary read sites (`routes/reports.js`, `allocations.js`'s own
  linked-port matching, `shipment-ops.js`, `command-center.js`, `customers.js`, `export.js`,
  `organization.js`, `system.js`, `ais.js`'s Simulator, `scripts/checkdb.js`) still read MDM
  tables directly from the monolith's local schema regardless of `mdm_source` — mostly read-only
  display JOINs, staleness post-cutover is cosmetic not data-loss, flagged in `ARCHITECTURE.md`
  §8.1 rather than chased in this pass. Don't flip `mdm_source=remote` in an environment
  exercising those surfaces until it's closed.
- 44 new assertions (`services/mdm/tests/mdm-crud.test.js`, `mdm-resolvers.test.js`,
  `tests/mdm-service-toggle.test.js` — the last proving local/remote are genuinely independent
  datastores, not a live sync). Full 53-file backend chain green in local mode from a fresh
  restart (5 unrelated pre-existing failures in `carrier-booking.test.js`, fully explained by the
  PDF Render service not running in this pass), clean build. Verified live end-to-end via direct
  HTTP: toggle admin-gating/validation, full CRUD in both modes, the `portLanesMap` cache
  resolving correctly through remote-backed data, and the independent-datastore proof.
- Full architecture writeup: `ARCHITECTURE.md` §8.1 (extended).

## Recent changes (v0.79.0 "Keel")
- **eAdapter** — first story of the carrier-communication-via-EDI epic, direct request: "a
  feature toggle that has a configuration icon, and when clicking on the configuration icon,
  open a pop-up window that supports tabbing... 'Add carrier config' button in the top right."
  Generalizes the hardcoded `BOOKABLE_CARRIERS` Set (`MAEU`/`SAFM`/`MCPU`) into
  `isEdiBookable(carrierCode)` (server.js), unioning the built-in three with any carrier holding
  an *active* row in a new `carrier_eadapter_configs` table (`transport_type` REST API/AS2/SFTP,
  `endpoint_url`, `auth_header_name`, `credential`) — modeled directly on `office_mail_settings`'
  own shape and secret-hygiene convention: `mapEadapterConfig` (`lib/mappers.js`) never returns
  the raw credential, only a `hasCredential` boolean.
- **One master toggle governs the whole surface** (`app_settings.api_eadapter_enabled`, default
  on) — per direct clarification, turning it off must collapse *every* carrier, built-in three
  included, to **manual mode** uniformly, not just gate new carriers on top of an always-on
  legacy three. Manual mode reuses the existing non-EDI-carrier lifecycle as-is (Send/EDI UI
  hidden, operator confirms via a typed `bookingRef`) rather than building a second flow, since
  document generation + email already exist as a separate, always-available tool independent of
  the booking flow. New `routes/eadapter.js`: CRUD on `/api/eadapter/configs`
  (admin/operator-gated) plus a public `GET /api/eadapter/bookable-carriers` — both Carrier
  Booking pages now poll this live effective set instead of importing the static
  `BOOKABLE_CARRIERS` Set directly. **Config + CRUD only this pass** — no live outbound HTTP
  call is attempted yet; a real per-carrier send (mirroring the deleted Maersk `fetch()` pattern
  from v0.72.1) is a clean, separately-scoped follow-up.
- **New `EadapterConfigModal`** (`src/components/shared/`) — a hand-rolled tab bar inside
  `Modal.jsx` (which has no built-in tab support), one tab per configured carrier, "+ Add
  Carrier Config" in the header — same pattern `MdmCustomersPage.jsx`'s `CustomerDetailModal`
  already established. Reached via a new `EadapterCard` (Settings → API Controls → External
  APIs, ahead of the generic `EXTERNAL_APIS` list, since this needs N per-carrier sub-configs
  rather than one scalar key).
- **Billing Performance bar charts fixed**, direct report: a hardcoded `maxBarSize={64}` left
  large empty gaps whenever a chart had few categories in a wide container — worst on the By
  Month view, where two months left the chart mostly blank on both sides. Removed the cap
  entirely so bars size off the available band width instead (Recharts' own `barCategoryGap`).
- **A full Cypress run surfaced three unrelated issues, none of them app bugs** — all found and
  fixed live rather than guessed at: the login rate limiter (20/15min/IP) exhausting partway
  through ~30 spec files that each log in fresh (known issue, CI already sets `LOGIN_RATE_MAX`
  for exactly this — the plain `npm run cy:run` script doesn't); two Carrier Booking specs
  failing because the eAdapter master toggle had been left off in the live dev DB from an
  earlier verification pass, not a code defect; and one genuinely flaky
  `schedule-generator.cy.js` test whose own cleanup only captured a schedule's id for deletion
  *after* its success-toast assertion passed — every past flake permanently orphaned one more
  blank schedule in the catalog, and 167 had silently accumulated. Fixed by capturing the id
  straight off the real `POST /api/schedules` network response (`cy.intercept`/`cy.wait`)
  instead of parsing it out of toast text, decoupling cleanup from an unrelated UI assertion's
  success. All 167 orphaned rows (plus their now-unreferenced `sailing_legs`/
  `schedule_leg_refs`) deleted.
- **Zero-script onboarding** — following a DB-architecture discussion (a senior architect's own
  DSV/Kuehne+Nagel/CEVA-style push for clear DB-per-domain splits ahead of an eventual AWS
  migration; see the published proposal, `documentation/splitting-mdm-first.html`, recommending
  MDM as the lowest-risk first cut and Users/Auth as deliberately *not* first, since it sits
  behind literally every request). Direct audit found the project's own previously-documented
  "copy `sampleDB/cargodesk.db` to get started" path was aspirational, not real — that file was
  referenced in README.md/CLAUDE.md and even had its own changelog entry (v0.18.1) but was never
  actually committed; `git ls-files` showed zero tracked `.db` files in this repo's history.
- **New `db/cargodesk.sample.db`** (committed, ~2.5MB) replaces it: real ports/carriers/vessels/
  commodities/regions/trade lanes plus the full 208-country list and 182-row country↔trade-lane
  mapping (both had accumulated through the admin UI over time with zero backing script, unlike
  the seed script's own 4-of-each minimum) — deliberately zero shipments/contracts/customers/
  users, matching direct instruction that those are for a real install to create itself.
  `server.js` copies this file to `cargodesk.db` automatically on first boot if none exists yet
  — verified end-to-end (fresh boot, watched it copy, seed its own admin + test-fixture accounts
  and a unique signing cert, come up clean). `users` and `org_signing_certs` are deliberately
  left OUT of the committed file despite being non-empty on a running instance — both already
  have their own idempotent startup bootstrap, and baking a shared private signing key into a
  file every clone gets identically would be actively worse than redundant.
- **`seedAdmin()` genericized**, caught in the same pass — it had hardcoded the maintainer's own
  personal email/name as the seeded admin account, both leaking personal identity into this
  public repo's source and already stale against what README.md documented as the default. Now
  reads `ADMIN_EMAIL`/`ADMIN_PASSWORD` (optional, e.g. via `.env`), falling back to that
  documented generic default (`admin@cargodesk.com`/`admin123`) — same disclosed-insecure-default
  idiom as `JWT_SECRET`.
- 29 new assertions (`tests/eadapter.test.js`). Full 53-file backend chain, both service-scoped
  chains, frontend Vitest, and a clean build all verified green from a fresh restart. Verified
  live via CDP end-to-end for eAdapter (toggle, modal, credential masking, master-off blocking)
  and directly reproduced/confirmed for the DB auto-copy mechanism.
- Full architecture writeup: `ARCHITECTURE.md` §8.12 (deepened) and §8.19 (new).

## Recent changes (v0.78.0 "Tonnage")
- **Table pagination standardized app-wide** — direct request prompted by a real scaling
  concern: "if we have 1000 shipments a week, the list is going to be absolutely insane to
  scroll, and it will overload in the RAM for the browser." Confirmed true: `ShipmentsPage.jsx`
  received the full shipment list as one fully-loaded prop and did all filtering/sorting/
  pagination client-side over the complete in-memory array. New shared
  `PageSizeSelect.jsx` (50/75/100, one global `cargodesk_page_size` localStorage preference)
  pairs with the existing `Pagination.jsx` everywhere it now matters — see "Key patterns" above.
- **`GET /api/shipments` real server-side filter/sort/pagination** — the one change that
  actually fixes the RAM concern. New opt-in `status`/`carrier`/`search`/`sort` params (a
  verbatim port of what was `ShipmentsPage.jsx`'s own client logic) plus a real `teu` column
  (fourth `LEFT JOIN SUM` subquery, mirrors the existing margin buy/sell subqueries).
  `ShipmentsPage.jsx` now self-fetches its own page instead of slicing the shared array, while
  still reading that shared array for account-wide totals (header subtitle, status-chip counts,
  CSV-export-disabled check). A genuine out-of-order-response race (two requests in flight
  resolving in the wrong order, overwriting a newer filter's result with a stale one) was caught
  live and fixed with a request-generation counter (`loadSeqRef`).
- **Linked Ports and Carrier Agents were mislabeled as paginated** — both pages already imported
  `Pagination` and looked converted, but both backend routes (`routes/mdm.js`) had zero
  `WHERE`/`LIMIT` support and were silently client-slicing an entirely unbounded fetch. Both
  routes now support the same opt-in `limit`/`offset`/`search` shape `GET /api/shipments` does.
- **Quotes and Freight Audit's invoice list had working backend pagination the frontend never
  called** — a real bug, not a style gap: anything past the backend's own default 50-row page
  was silently invisible. Wired up.
- **Billing Performance and Invoice Collections** replace a hard `.slice(0, 200)` client cutoff
  (real data loss past row 200) with actual pagination over the same already-filtered array.
- **User Management, Dashboard's "Shipments in Period," Space Configurations, and the Archive
  page** get client-side pagination — deliberately lighter than the Shipments-list conversion,
  since none of these datasets scale with shipment volume.
- **Notification bell dropdown had no max-height** — an account with several active alert
  sections grew the panel as tall as its content instead of scrolling ("ended up in an infinite
  type of scroll situation"). Now bounded with an internal scroll wrapper; two sections that
  rendered fully unbounded lists (Contract Expiry, Invoicing Overdue) are capped to 5 rows like
  every other bell section already was.
- **`api.js`'s `req()` now distinguishes a network failure from a server error** — `fetch()`
  itself rejecting (offline, DNS failure, server down) now rethrows a clear "Network error —
  check your connection and try again" instead of a cryptic raw browser string, fixing
  `ForgotPasswordPage.jsx`/`ResetPasswordPage.jsx`'s vague "Something went wrong" fallback for
  every page using `req()`, not just those two.
- 24 new assertions (`tests/pagination-standardization.test.js`). Full 43-file backend chain,
  both service-scoped chains, frontend Vitest, and a clean build all verified green from a fresh
  restart. Verified live via CDP: Shipments-list filter/sort/page-size round-trip through the
  server (including the race-condition fix), an MDM page's dropdown, Billing Performance's real
  pagination, and the bell's bounded scroll.
- Full architecture writeup: `ARCHITECTURE.md` §8.18. The `routes/*.js` table in that doc's §5
  was also fully remeasured this pass (25→31 files, several genuinely missing) while in there.

## Recent changes (v0.77.0 "Overwatch")
- **Command Center — Quality & Exception Management** (Epic `TKT-IBHB0K`) — a sourced gap
  analysis of Cargo iQ (IATA's air-cargo quality-management interest group)'s Master Operating
  Plan / Freight Status Update model against the Command Center's existing volume-only
  analytics. Every planned-vs-actual signal Cargo iQ's model runs on already existed
  per-shipment (`shipment_milestones`, `shipment_legs`' AIS-confirmation provenance) but nothing
  aggregated it across the fleet — the only exception signal was one blunt "Overdue" tile with
  no differentiation of *why*. Ocean/FCL scope only; real IATA EDI formats, formal MOP
  membership, and cross-company benchmarking are named as structurally out of reach.
- **New `routes/command-center.js`**, four endpoints, all scoped per-caller via the same
  `applyShipmentAccessFilter()` every shipment-list read already uses (no separate role gate):
  `GET /api/milestones/overdue-summary` (fleet-wide milestone-breach KPI + per-milestone-key
  breakdown, backs a new 6th Command Center KPI card + a new "Milestone Alerts" bell section
  using the exact shape Invoicing Overdue/Carrier Bookings already established), `GET
  /api/exceptions/queue` (root-cause classified: `scheduleSlip`/`unconfirmedBooking`/
  `stalledMilestone`, replacing the old blunt Overdue count with a tabbed queue), `GET
  /api/command-center/carrier-scorecard` (AIS-confirmed-only on-time % as a new column on the
  existing Carrier Consumption ranking — note the `/command-center/` path, not `/carriers/`:
  `routes/mdm.js`'s pre-existing `GET /api/carriers/:code` would swallow the natural-seeming
  `/api/carriers/on-time-scorecard` path, a real collision caught live), `GET
  /api/command-center/transit-time-trend` (planned vs. AIS-confirmed-actual transit days per
  trade lane over time, a new "Transit-Time Variance by Lane" card).
- **`CommandCenterView.jsx`'s font sizes reset** — unchanged since v0.34.4, running 30-100%
  larger than every other page (18px section labels, 40px KPI numbers vs. the rest of the app's
  10-13px/18-22px). Reset to the same scale `BillingPerformancePanel` and other current pages
  use, both for existing UI and everything new added this pass.
- 38 new assertions (`tests/command-center.test.js`), including a fixture driven through the
  real AIS simulator. Two real bugs caught while writing it: the AIS listener correlates a
  position report via `Number(vessel.mmsi)` — a base36 test id silently produced `NaN`; and a
  lane-contamination test fragility from an intentionally-kept persistent verification shipment
  sharing a trade lane with a fresh fixture — fixed by asserting internal consistency instead of
  a hardcoded expected value. Full 44-file backend chain, both service-scoped chains, frontend
  Vitest, and a clean build all verified green. Verified live via CDP across all five new UI
  surfaces plus the notification bell, using one persistent seeded shipment kept in place for
  future reference.
- Full architecture writeup: `ARCHITECTURE.md` §8.17.

## Recent changes (v0.76.0 "Remittance")
- **The Billing Performance report itself** (`TKT-B4VBDH`, Epic `TKT-KR6ZBT`) — new
  `GET /api/reports/billing-performance` returns every FR01/FR02 invoice, row-level and
  enriched (status, sent, payment status + days overdue, office/customer/lane/carrier), so the
  frontend can filter/slice by any combination at once rather than one groupBy at a time.
- Joins GP by Trade Area as a second tab on the existing Reports page (same tab-bar pattern
  Dashboard already uses) — 5 stat cards, filter chips (Status/Sent/Payment/Overdue), and facet
  dropdowns populated live, all driving the same filtered table + CSV export. Same
  `canViewFinance` gate the rest of Reports already uses.
- Real layout bug caught live and fixed before shipping: the OUTSTANDING column header
  collided with OFFICE next to it — fixed-width flex columns had no floor under space pressure.
  Fixed with `flexShrink:0` everywhere, re-verified with a fresh screenshot.
- 12 new assertions (`tests/billing-performance.test.js`, 46 total). Full backend + frontend
  suites and a build verified green. Verified live via CDP against real data.
- 4 of 5 Epic stories shipped; only Story 5 (configurable per-customer reminder cadence)
  remains, next up.

## Recent changes (v0.75.1 "Remittance")
- **Per-customer invoice-generation deadline** (`TKT-YC7PZP`, Epic `TKT-KR6ZBT`) — direct
  follow-up: "some clients may pay the same day, but some ... at the end of the month" —
  notifications need to be configurable per customer, not one fixed schedule. New
  `customers.invoice_deadline_days` mirrors `credit_terms_days` exactly (nullable, per-customer).
  Anchored to the shipment's own "delivered" milestone; soft/informational only, never a block.
  New `GET /api/invoice-deadlines/overdue` (bounded, server-scoped) flags a delivered shipment
  with no confirmed FR01/FR02 yet, once past its deadline.
- Surfaced via the same lightweight pattern the notification bell already uses for expiring
  contracts — a new "Invoicing Overdue" bell section, 60s self-poll, click-to-navigate to
  Invoice Entry, dismiss-until-tomorrow. New "Invoice Generation Deadline (days, optional)"
  field on the customer Profile/Billing tab, next to Credit Limit/Credit Terms.
- 10 new assertions (`tests/billing-performance.test.js`, 34 total). Full backend + frontend
  suites and a build verified green. Verified live via CDP — a shipment delivered 12 days ago
  with a 5-day deadline correctly shows "7d over" in the real bell.
- 3 of 5 Epic stories shipped; the Billing Performance report and configurable reminder cadence
  remain queued.

## Recent changes (v0.75.0 "Remittance")
- **Invoicing Discipline & Billing Performance (Epic `TKT-KR6ZBT`), first pass** — direct
  follow-up after Credit Control Depth shipped: the app tracked AR aging on the receiving end
  but had zero control on the generating end (days since a shipment earned the right to be
  invoiced) or on actual payment receipt — `outstandingAr` literally just meant "confirmed,
  non-voided invoice," not "unpaid." Ships the 2 foundational primitives of 5 planned stories.
- **Mark as Paid** (`TKT-NQ87D3`) — the app's first real payment-receipt record. New
  `paid_at`/`paid_amount`/`transaction_id` on `shipment_documents`. Both `paidAt` and
  `paidAmount` are required (never auto-defaulted to "now" — a financial controller enters the
  real payment date, often reconciled a few days late); `transactionId` is optional reference
  data. A partial payment reduces `outstandingAr` without resetting its aging clock — the
  remainder still ages from the original `confirmed_at`. Gated to `postGate` (admin/operator,
  same tier as Confirm/Reverse). New "Mark Paid" action on `ShipmentAccountingInvoicesPage.jsx`.
- **Denormalized `first_sent_at`** (`TKT-PLAVEK`) — "was this ever sent" used to require joining
  `entity_events` (email) and the document-distribution service's own tables (EDI/webhook),
  neither of which write back to the monolith. Written once by whichever channel sends first —
  a fast read-side signal for the upcoming Billing Performance report; the full multi-channel
  history is untouched.
- 24 new assertions (`tests/billing-performance.test.js`, added to the 46-file main chain). Full
  backend + frontend suites and a build verified green. Verified live via CDP.
- Stories 3-5 (per-customer invoice-generation deadline, the Billing Performance report,
  configurable per-customer reminder cadence reviving `TKT-SUEDWH`) queued for later passes.

## Recent changes (v0.74.0 "Solvency")
- **Credit Control Depth, third and final pass (TKT-GLWMFP)** — closes Epic `TKT-6XFJQM`.
  Explicit business rule: credit-hold and over-limit override authority belongs EXCLUSIVELY to
  the trade_manager responsible for a shipment's own trade lane — never admin, operator, or an
  out-of-lane trade_manager. Reuses `user_scope_items`' `trade_lane` scope + `matchesScopeItem()`
  (the same mechanism that already scopes shipment visibility) via two new helpers,
  `userOwnsLaneForShipment`/`userOwnsLaneForCustomer`.
- **Releasing a hold** is now a dedicated action (`POST /api/customers/:id/credit-hold/release`,
  reason required) gated by the lane check — the SAME check was also added to the generic
  `PUT /api/customers/:id` route (only for the true→false transition) to close the direct-API
  bypass the dedicated endpoint alone would have left open.
- **Over-limit is now a real, server-enforced hard block** (`POST .../documents/generate`,
  FR01/FR02 only) for the first time — v0.57.0's original scope said this needed a proper
  AR-aging view; v0.73.0 shipped it. The only way past it is a `credit_overrides` row approved
  by the shipment's own lane trade_manager (`POST .../credit-override/approve`), valid for a
  60-minute grace window (not strict single-use — a per-container split invoice run calls the
  generate route once per container for one logical action). `ShipmentAccountingInvoicesPage.jsx`'s
  old "Generate Anyway" soft warning is gone, replaced by a real no-bypass `OverLimitBlockModal`.
- **New "Credit Overrides" page** (top-level nav, deliberately not nested under Accounting,
  which stays hidden from trade_manager per v0.29.0) lists every blocked shipment, server-scoped
  per viewer: admin/operator see the full queue for visibility only, a trade_manager sees and
  can act on exactly the shipments their own lane covers.
- **Real pre-existing bug caught while testing this pass**: the over-limit projection
  (`resolveCreditGate` and its new server mirror) double-counted the current invoice's own
  amount on top of `committedExposure`, which already includes it — harmless while the block was
  a soft warning (since v0.73.0), a real correctness bug now that it's a hard block. Fixed on
  both sides.
- 24 new assertions (`tests/customer-credit-control.test.js`, 83 total in that file) — full
  45-file backend chain, both service-scoped chains, frontend Vitest, and a clean build all
  verified green from a fresh restart. Verified live via CDP: the queue and approval flow for
  an in-lane trade_manager, and the hard-block modal's figures/messaging for an unapproved
  over-limit shipment.

## Recent changes (v0.73.1 "Solvency")
- **Credit Control Depth, second pass** — ships the earlier trigger points (`TKT-Q00WHF`)
  explicitly deferred from v0.73.0. Shipment creation stays soft/informational by design (a
  held Shipper/Consignee/Principal never blocks creating the shipment, but the response carries
  `creditWarning.onHold` and `App.jsx` mirrors it into a toast right next to the existing
  sanctions-screening one). Carrier booking send is a real, server-enforced 409 block instead
  (`routes/edi.js`) — a booking request is a genuine external commitment, checked both
  server-side (unbypassable) and client-side (`ShipmentCarrierBookingDetailsPage.jsx`, via
  `resolveCreditGate`). New shared `CreditHoldModal` (`src/components/shared/`) — extracted
  from what used to be a component local to `ShipmentAccountingInvoicesPage.jsx` — now backs
  both the invoice-generation gate and this new booking-send gate, parametrized by an `action`
  string so the wording matches the call site.
- 7 new assertions in `tests/customer-credit-control.test.js` (59 total in that file). Full
  45-file backend chain, both service-scoped chains, frontend Vitest, clean build all green from
  a fresh full-stack restart. Verified live via CDP: the booking-send `CreditHoldModal` renders
  correctly against a real held customer. The shipment-creation toast's wiring was confirmed by
  direct code review instead of a full click-through — the New Shipment form's interdependent
  Commodity/Route-Leg pickers proved too brittle to drive reliably via scripted automation in
  the time available; the toast itself is a 6-line addition structurally identical to the
  already-shipped, already-verified sanctions-screening toast in the same function — a
  disclosed scope boundary on the verification method, not a skipped check on the code.

## Recent changes (v0.73.0 "Solvency")
- **Credit Control Depth (Epic `TKT-6XFJQM`), first pass** — a sourced gap analysis of the
  existing Credit Control feature (Epic 2, v0.57.0) against CargoWise One and Magaya Supply
  Chain, published as an artifact + 7 Kanban stories. This release ships the 4 stories that all
  extend `GET /api/customers/:id/credit-status` and `customers.currency`, as one bundled
  backend pass: **AR aging** (`TKT-O4DNFX`, real Current/1-30/31-60/61-90/90+ buckets from
  each confirmed invoice's `confirmed_at` + `credit_terms_days`, not a flat total — confirmed
  Magaya gap); **committed exposure** (`TKT-AJAEDO`, a new `committedExposure` figure sums
  accrued SELL cost lines never invoiced at all, kept visibly separate from `outstandingAr`);
  **parent/group rollup** (`TKT-IA7I7J`, wires the existing `resolveCustomerGroup()` — already
  used for margin rollup since v0.59.0 — into an additive `groupOutstandingAr`); **currency**
  (`TKT-O5I4NK`, direct follow-up request — `credit_limit` was hardcoded USD regardless of
  `customers.currency`; a new customer now defaults its currency from country, e.g. ES→EUR,
  scoped to the 8 currencies the app's picker already supports, never applied retroactively to
  an existing customer; `credit-status` converts to `creditLimitUsd` via the exact `toUsd`/FX
  machinery every cost line already uses).
- **Explicitly deferred, named not silently dropped**: earlier trigger points at shipment/
  booking-creation time (`TKT-Q00WHF`) and the trade-lane-scoped override exclusive to that
  lane's own trade manager (`TKT-GLWMFP`) — both real, both logged, queued as the next pass.
  Dunning emails (`TKT-SUEDWH`) logged lowest-priority.
- 52 new/extended assertions in `tests/customer-credit-control.test.js` (90 total) — full
  45-file backend chain + both service-scoped chains + clean build all verified green from a
  fresh full-stack restart. One disclosed coverage gap: AR aging bucket *boundaries* can't be
  exercised through pure HTTP (no endpoint backdates `confirmed_at`) — only the "current"
  bucket is integration-tested; the day-threshold math itself is simple, reviewed, not faked
  into a false-confidence test.

## Recent changes (v0.72.3 "Clearance")
- **Real CI failure fixed at the source, not papered over**: `services/pdf-render/server.js`'s
  Puppeteer browser launch was fully lazy (by design, so a machine with no browser installed
  still boots fine) — the first document-generation call anywhere in a run paid the full
  cold-start cost inside `lib/pdf-signing.js`'s 30s per-call timeout. On a loaded CI runner this
  timed out at exactly 30.0s (`carrier-booking.test.js`'s B/L-document test, early in the
  45-file chain). Fixed by firing one `getBrowser()` call inside the service's own
  `app.listen()` callback at boot — non-fatal if it fails, a real render call still retries the
  launch itself exactly as before. Confirmed live: the previously-timing-out test file now
  completes, document generation included, in well under 4 seconds. Also bumped the monolith
  side's own timeout 30s→45s as defensive headroom on top of the real fix.
- Full 45-file backend chain + both service-scoped chains + frontend Vitest + build all verified
  green from a fresh full-stack restart.

## Recent changes (v0.72.2 "Clearance")
- **Backend test coverage pushed from 76.56% to 90.15%** (real V8 line coverage, measured via a
  temporarily-installed `c8` — this repo has no coverage tooling committed). 17 new test files,
  631 new assertions, all against live endpoints. Full list and rationale in `src/version.js`'s
  own changelog entry; highlights: `export.js`/`organization.js`/`mdm.js`/`kanban.js` went from
  ~20-55% to 100%, and `routes/shipment-ops.js`'s entire cost-line accrual/actualize/post/
  post-batch state machine plus Dedicated Services CRUD got their first-ever direct HTTP-level
  test despite being core to the app.
- **A recurring gotcha worth remembering**: a route with no per-route `auth()` call is NOT
  necessarily public — `server.js` has a single global `/api/*` gate (`auth() unless /auth|
  /health|/share`) that most individual route files never re-state. Several new tests initially
  assumed "no `auth()` in this file = public" and had to be corrected.
- **Deliberately not chased**: `ai.js`'s real LLM tool-execution loop (needs a live provider),
  `auth.js`'s SSO callback success path (needs a real Microsoft tenant), and
  `POST /api/sanctions/sync|sync-csl|import-csv` (destructively replaces the live synced OFAC/CSL
  dataset other tests depend on — matches `tests/customer-compliance-screening.test.js`'s own
  already-documented reason for the same decision). Also deliberately did not chase the
  frontend's own Vitest number (14.9%, 2 files) — this project's real frontend safety net is 24
  Cypress E2E specs, and inflating the Vitest number with shallow component tests would fight
  that architecture, not serve it.
- All 17 files wired into the permanent suite — 15 into the main `npm test` chain (now 45 files),
  2 needing a second process appended to the existing `test:document-distribution`/
  `test:contract-service-toggle` scripts (both already run as their own CI steps). Three more
  rate-limit env vars added to `ci.yml` (`AI_EXTRACT_RATE_MAX`, `AI_CHAT_RATE_MAX`) for the same
  recurring reason as every prior one: real per-user budgets exhausted before a 45-file suite
  finishes against one continuous process.

## Recent changes (v0.72.1 "Clearance")
- **Removed the obsolete Maersk developer-tools integration** — Maersk's own developer.maersk.com
  portal it depended on is obsolete; the app still carried its leftover App Settings configs.
  Removed the live-API code entirely (`routes/system.js`'s `maerskSchedules()`,
  `routes/edi.js`'s `maerskBookingRequest()`) rather than just hiding the Settings UI, since
  leaving them would mean unreachable dead code once `maersk_api_key` had no UI left to set it
  — matches this codebase's own v0.65.0 dead-code-removal precedent.
- **Schedule search is now catalog-then-demo only** — the live tier is gone; behavior is
  unchanged for every environment (none of them had a working key, since the booking-side
  integration's own code comment admitted its contract was an unverified placeholder). Carrier
  booking requests were already effectively simulated-only in practice (v0.35.0) — now
  explicit, with the dead live-attempt branch removed from the send route.
- Removed the two now-purposeless Settings → API Controls → External APIs cards ("Maersk
  Schedules", "Maersk Booking (EDI)"); rewrote the "demo sailings" banners on `SchedulesPage.jsx`/
  `MdmContractsPage.jsx` that pointed at configuring the now-gone key.
- **Deliberately left untouched**: `MAEU`/`SAFM`/`MCPU` as literal carrier codes (real carriers,
  still used as reference data and for `BOOKABLE_CARRIERS` — a different, still-live "EDI
  booking eligibility" concept, unaffected by this cleanup), the 294-code Maersk commodity
  registry (unrelated MDM reference data), and historical CHANGELOG entries mentioning the old
  integration (left as accurate history).
- Full 30-file backend suite + frontend Vitest suite green, clean build.

## Recent changes (v0.72.0 "Clearance")
- **Two-phase direct request.** Phase one: a Help Section / User Manual chapter teaching sea-freight
  fundamentals — Ro-Ro vs Lo-Lo, Master B/L vs House B/L issuance and their interlink — grounded in
  real external references (docshipper.com, Höegh Autoliners) rather than invented. New **"Ocean
  Freight Basics"** entry, first in `UserManualPage.jsx`'s reference list, ties back to CargoDesk's
  own `BL01`/`MB01` documents (v0.71.0).
- **Phase two — full integration of Epic `TKT-6A7J45`** ("The Missing Manifest" gap analysis: Export
  Filing ↔ Pickup Service), 10 stories, all shipped this pass.
- **Filing staleness detection.** `customs_filings` gains `carrier_code`/`vessel_name`/
  `voyage_number`/`export_date`/`cargo_snapshot` — captured at Submit time via a new
  `cargoSnapshotFor(shipmentId)` helper (`routes/customs-filing.js`, reads `container_packages`).
  New `stalenessOf(filing, shipment)`/`mapWithStaleness()` compares a Filed/Accepted filing's
  stored snapshot against the shipment's current values and flags drift — a "May be stale" badge
  on the filing card names exactly which fields changed.
- **USPPI (Shipper) / Ultimate Consignee gate** — both are legally required EEI fields; the filing
  create gate (`CustomsFilingGateModal`, `ShipmentCustomsFilingPage.jsx`) and the backend create
  route both now also require `shipment.shipperName`/`consigneeName`.
- **Pickup cross-reference** on the AES/EEI (export-side only) filing card — Pickup service status
  + a "View Pickup Service →" link, plus a non-blocking warning on Submit if Pickup isn't yet
  ordered/confirmed.
- **Pre-departure filing deadline** — a 24h-before-ETD indicator (`deadlineInfo()`), amber under
  48h, red once passed; a reasonable placeholder, not a precise per-mode legal citation.
- **Export Filing ITN on carrier documents** — the booking-request payload (`routes/edi.js`) and
  both the House (`BL01`) and Master (`MB01`) Bills of Lading now carry the AES/EEI filing's
  confirmation number once Accepted, as an additive detail row.
- **Two roadmap errors caught and corrected during implementation**: the published roadmap said to
  wire AES/EEI Accepted to the `customs_cleared` milestone — direct inspection of the
  `shipment_milestones` sequence (`customs_cleared` sits AFTER `vessel_arrived`, the
  destination/import-clearance step) showed this was backwards; wired ISF/AMS instead. The
  roadmap's story 9 said to move Pickup into Booking & Routing — `App.jsx`'s own code comment
  showed this would reverse a deliberate v0.45.0 decision; implemented as a cross-link only.
- Verified live via CDP across all 10 stories in one continuous session; full 30-file backend
  suite + frontend Vitest suite green, clean build. Six existing test fixtures (2 Cypress specs,
  2 Node test files) proactively updated with shipper/consignee data ahead of the new gate, to
  avoid regressing the CI pipeline stabilized in this same release window.

## Recent changes (v0.71.0 "Docket")
- **NVOCC (Non-Vessel Operating Common Carrier) readiness audit**, direct request off a detailed
  mechanics brief: "cover ALL gaps regarding the NVOCC." Core finding, confirmed by direct code
  read rather than assumed: an NVOCC is legally both a carrier (to its own customer, on the
  House B/L) and a shipper (to the real vessel operator, on the Master B/L) for the identical
  physical movement — `shipments.master_bl_number`/`bl_release_type` already existed (an earlier
  migration's own comment literally references NVOCC) but were only a caption field on the single
  `BL01` document, never a real House/Master split; zero FMC/tariff-license concept existed
  anywhere; the outbound carrier booking-request payload's `shipperName` always reflected the real
  underlying cargo owner, never an assigned NVOCC. Published as an artifact (7 findings) plus a
  real Kanban Epic (`TKT-Q52B38`, 7 stories) — 4 findings closed this pass (below, one of them —
  the Master B/L document — initially scoped as backlog and pulled forward on direct follow-up
  request); 3 larger ones (a full structural dual-carrier/principal field split, a two-stage
  destination release workflow, NVOCC co-loading/cross-tariff reference) remain logged as scoped
  backlog rather than rushed through in one pass. Explicitly **not** the same gap as
  LCL/consolidation (still deliberately deferred, FCL-first roadmap) — the brief's own wording
  confirms the House/Master split is real "even a single-shipper FCL container with zero
  consolidation involved," so this proceeded independently of that decision.
- **New "NVOCC" party role** (`ADDITIONAL_PARTY_ROLES`, server.js + tokens.js) — resolves via the
  existing `shipment_parties` mechanism exactly like Forwarder/Agent/Line Agent already do. New
  `customers.is_nvocc`/`fmc_number` columns, checkbox-reveals-field UI on the customer Profile tab
  (mirrors the `classified_location` pattern, v0.63.0).
- **Booking-request shipper-of-record fix**: `POST .../edi-messages/booking-request`
  (`routes/edi.js`) now prefers an assigned NVOCC party's name for the outbound `shipperName` —
  the NVOCC, not the underlying cargo owner, is the real shipper of record to the vessel operator.
  Falls back to today's exact behavior when no NVOCC party is assigned.
- **NVOCC identity surfaced on the generated Bill of Lading** (`buildBillOfLadingHtml`, App.jsx) —
  an additive detail row next to the existing Master B/L Number caption, populated only when an
  NVOCC party is assigned.
- **True independent Master B/L document** (`TKT-ABO0TA`, pulled forward from backlog on direct
  follow-up) — new `MB01` "Master Bill of Lading" `DOC_TYPES` entry, own `buildMasterBillOfLadingHtml`
  builder (App.jsx, not a mode flag on the House B/L builder — the two documents' party
  resolution differs too much to share cleanly). Shipper = the assigned NVOCC party; Consignee
  renders as standard trade language, `TO ORDER OF {NVOCC}`, rather than fabricating an
  NVOCC-destination-agent party this pass doesn't model; Notify Party is left blank rather than
  misattributing the House-side notify onto a document it has no role on. Each B/L document
  cross-references the other's number. Gated in `getMissingDocRequirements` same as every other
  doc type (NVOCC party, Master B/L Number, ≥1 container, both ports).
- Verified live via CDP and direct API checks: a scratch NVOCC-flagged customer's `is_nvocc`/
  `fmc_number` round-tripped through the real Profile tab save; a real outbound booking-request
  payload correctly showed the NVOCC's name instead of the real shipper's; the actual client-built
  House B/L HTML (intercepted via a wrapped `fetch`, before the server's signing step) contained
  the new NVOCC row; a second scratch shipment's actual generated Master B/L HTML carried the
  right title, NVOCC-as-Shipper, `TO ORDER OF` Consignee, real Master B/L number, and a correct
  cross-reference to the House B/L number. Full 30-file backend suite plus the frontend Vitest
  suite both green, clean build. All scratch data deleted after each pass.

## Recent changes (v0.70.0 "Waypoint")
- **AI-driven document extraction** (TKT-44PRSK) — new `POST /api/ai/extract-document`
  (`routes/ai.js`), a single-shot vision call deliberately kept generic (not carrier-invoice-
  specific) so future document-in/structured-data-out features can reuse it. Provider-agnostic
  like `/api/ai/chat`: Anthropic gets a native image/document content block (PDF support is
  Anthropic-only — the OpenAI-compatible Chat Completions shape has no native PDF handling, and
  a PDF upload against a non-Anthropic endpoint returns a clean 400, not a silently wrong-shaped
  request); every other configured endpoint gets an `image_url` block. Own tighter rate limiter
  (`aiExtractRateLimit`) than chat's, since a vision payload is meaningfully more expensive per
  call. Wired into `FreightAuditPage.jsx`'s New Carrier Invoice modal as an "Extract from
  document" upload that pre-fills the form for review before saving.
- **Quoting / RFQ pre-booking stage** (TKT-H8VOOW) — new `quotes`/`quote_lines` tables,
  `routes/quotes.js`, `QuotesPage.jsx` (new top-level nav item, before Shipments). Lifecycle
  Draft -> Sent -> Accepted | Declined | Expired -> Converted; pricing reuses the existing
  `GET /api/contracts/match` engine as a reference ("Find Matching Contracts"), but the quote's
  own lines are the real offer, kept independent of the live contract rate. Converting creates a
  real shipment (BUY side via the existing `importContractRates` path if a contract was
  referenced; SELL side from the quote's own lines, `source='quote'`) and returns the full
  mapped shipment object inline — required because the SPA's local `shipments` array (App.jsx)
  needs the record pushed in before it can navigate to a detail page it doesn't otherwise know
  about yet; this exact gap caused a real blank-page bug caught only via live CDP verification,
  since fixed.
- **CargoDesk Field Guide** — the user-facing manual rewritten from the existing topic-organized
  in-app reference (`UserManualPage.jsx`, left unchanged) into a step-by-step, illustrated
  walkthrough: 12 chapters in the real required workflow order (quote → shipment → cargo →
  schedule → booking → parties → customs → documents → tracking → money), following one example
  shipment through its whole lifecycle with live-captured screenshots. Chapter order corrected
  mid-build on a real discovery: Carrier Booking is hard-gated behind a schedule/contract being
  assigned first. Published as a standalone artifact for review, not merged into the in-app page.
- **`ARCHITECTURE.md` refresh** — the doc had gone stale since v0.30.0 (self-flagged, but worse
  on direct inspection: three different wrong `server.js` line counts across its own sections, a
  direct self-contradiction on whether FK constraints are enforced, five "known debts" already
  resolved, and an entire microservice plus several major subsystems missing). Rewritten from a
  direct, measured pass against the live code — see that file's own header for specifics.
  `dev/architecture.html` (a separate visual diagram, dated v0.20.0) was explicitly left
  untouched, out of scope for this pass.
- **CI gap fix, found in passing**: the document-action rate limiter (20/60s,
  `routes/shipment-ops.js`) gets exhausted by the full test suite's cumulative document-
  generation calls across files — the same class of bug the login limiter had before v0.66.0.
  Added `DOC_ACTION_RATE_MAX` to `ci.yml`'s backend job, mirroring the existing `LOGIN_RATE_MAX`
  fix exactly.

## Recent changes (v0.69.0 "Custodian")
- **Competitive gap analysis** — direct request to compare CargoDesk against other freight-
  forwarding software and act on the findings. 8-agent parallel research sweep (CargoWise One,
  Magaya, Descartes, project44/FourKites/GoComet, Flexport/Freightos/WebCargo, CargoSphere/
  Freightos Terminal & Procure, real AES/ISF/ACE filing requirements, multi-list denied-party
  screening) cross-checked against a direct, verified audit of CargoDesk's own code. Full
  writeup + prioritized roadmap published as an artifact; a 10-story Epic logged in Kanban.
  Gaps that are structurally out of reach (carrier networks, market-data indices, marketplaces —
  these need years of partnerships/a data business, not code) are named explicitly rather than
  treated as an engineering backlog. LCL/consolidation/Master-House B/L is the single largest
  real gap found — deliberately **not** scheduled, governed by the standing FCL-first sequencing
  decision. Two highest-value stories executed this pass (below); 8 more logged as scoped
  backlog (quoting/RFQ, customer self-service portal, AI document extraction, scheduled reports,
  external rate benchmarking, multi-entity accounting, CRM, LCL/consolidation).
- **Freight Audit & Payment** — carrier invoice reconciliation against contracted rates/accrued
  costs, plus a Detention & Demurrage pre-audit. New `carrier_invoices`/`carrier_invoice_lines`
  tables; the matching engine prefers an already-accrued `shipment_cost_lines` row over the live
  contract rate, respects the `contract_source` toggle (v0.68.0), and independently computes the
  expected D&D charge from `containers`' free-time fields + `container_events` before comparing
  it to what the carrier billed. Approving a matched line actualizes the existing cost line in
  place; an unmatched line creates a new one, tagged `source:'carrier_invoice'`. New
  `FreightAuditPage.jsx` (nav: Dashboard → Freight Audit) — invoice list, cross-shipment
  exceptions queue, per-line container/free-time-side entry, Approve/Dispute actions.
- **Multi-list denied-party screening** — extends OFAC-SDN-only screening to the free, public US
  Consolidated Screening List (11 more lists: BIS Denied Persons/Entity/Unverified/Military End
  User, State Dept ITAR Debarred + Nonproliferation Sanctions, 5 more OFAC-family lists).
  `sanctions_entries.source`/`sanctions_syncs.source` were already fully generic — zero schema
  change needed. New `syncConsolidatedScreeningList()` mirrors `syncOfacSdn()`'s exact shape,
  additive only. `screenShipmentById`/`ComplianceModal` already threaded `hit.source` through —
  zero screening-logic or hit-display changes needed, only the data feeding it grew. New Settings
  card mirrors the existing OFAC one.
- Full 28-file regression green, clean build, live CDP verification end-to-end for both features
  (including confirming, via a direct backend check, that an "Approve" click in the real UI
  genuinely actualizes the underlying cost line, not just a UI-only state change).

## Recent changes (v0.68.0 "Junction")
- **Multi-Routing-Per-Contract.** A carrier contract can now cover one lane via several distinct
  physical routings (e.g. HLCU/Kuehne+Nagel CNCKG->SEGOT bookable via three different
  transshipment hubs — DEHAM, NLRTM, Wilhelmshaven — each independently priced/timed), researched
  against SeaRates/CargoSphere/CargoWise/Freightos before building. New `contract_routings` table;
  `contract_legs`/`contract_rates` gain an optional `routing_id` (blank = today's exact ungrouped
  behavior). `findMatchingContractLeg` → `findMatchingContractLegs` — groups legs by routing,
  returns every matching routing instead of stopping at the first, so `GET /api/contracts/match`
  emits one comparable result per (contract, routing) pair, each with rates scoped to that routing
  (plus contract-wide `routing_id=''` rows). A leg/rate correlates to its routing by array index
  into the current save's `routings[]` payload (`routingIndex`) — the only identity that survives
  a save, since routing ids regenerate every save exactly like legs/rates already do. MdmContractsPage
  leg editor is routing-grouped; ContractPickerModal shows each routing as its own pickable option;
  `useContractMismatch`/`RateBenchmarkPage` key on routing id, not just contract id. Allocations
  stay contract-level-only by design (space config books lane capacity, not a specific path).
- **Standalone Contract Management Service** (`services/contract-management/`, port 3004) —
  CargoDesk's third extracted microservice, and its first that runs ALONGSIDE the monolith's own
  local tables rather than replacing them (own schema, Postgres-backed since ARCHITECTURE.md
  §13 Phase 4 — a faithful port of `routes/contracts.js`'s full route surface as `/internal/*`
  endpoints). New admin-only
  `app_settings.contract_source` toggle (`'local'` default | `'remote'`, Application Settings →
  API Controls → External APIs) decides per-request which is authoritative. Every local read that
  touches contract data got the same toggle branch: `routes/contracts.js`, `routes/allocations.js`'s
  match endpoint, `server.js`'s `createRateSnapshot`/`importContractRates`, `routes/shipment-ops.js`'s
  credit-hold check, `routes/shipments.js`'s `checkDgPolicy`, and the AI Assistant's `get_contract`
  tool. New shared `callContractService(method, path, body)` helper (server.js, exposed via ctx —
  unlike `callDistributionService`, needed by 4+ files, not just one) mirrors the clean-503-on-
  unreachable pattern already established for the other two services. The service owns no
  `linked_ports`/`shipments`/`allocations` data — linked-port pairs are resolved by the caller and
  passed explicitly; the shipment/allocation delete/withdraw reference guards are replicated in the
  monolith's proxy layer against its own local tables before ever calling the remote route. New
  `scripts/migrate-contracts-to-service.js` (CLI-only, never automatic) is the explicit, admin-
  triggered one-way cutover step — flipping the toggle alone never copies data.

## Recent changes (v0.67.0 "Drydock")
- **Four more architect-review fixes.** Two ARCHITECTURE.md claims driving this round (C1 "no
  transactions", H5 "no indexes") turned out stale/inaccurate — re-verified against the live
  codebase first, found the real narrower gap each one actually had.
- **Indexes**: 14 already existed. Added the real gap — `shipment_cost_lines`, `containers`,
  `entity_events`, `shipment_documents` (all queried by `shipment_id`/`entity_type`+`entity_id`
  on every shipment-detail load, none indexed). `shipment_parties` skipped — already covered by
  its own `UNIQUE(shipment_id, role)` constraint's implicit index.
- **Transactions**: 9 already existed. Fixed the real gap — `routes/contracts.js`'s
  `saveLegs`/`saveRates`, the contract-rate re-import overwrite path, and invoice reversal —
  all delete-then-regenerate or multi-insert sequences on `shipment_cost_lines` with zero
  wrapping before this.
- **Money rounding**: new `roundCents()` helper (`lib/mappers.js`, exported via `ctx`) fixes a
  real, verified float-precision bug in the `Math.round(x*100)/100` pattern (12 occurrences
  across 6 files) — adopted in `mapCostLine`, `toUsd`, and 3 more route files.
- **Production deployment**: `NODE_ENV=production`-gated static-file serving + SPA fallback in
  `server.js` (the monolith couldn't serve its own frontend before this); 3 Dockerfiles +
  `docker-compose.yml` (none build-tested — no Docker available here, documented plainly as a
  first draft); new `.env.example`.

## Recent changes (v0.66.0 "Bulkhead")
- **Four platform-hardening epics**, tracked as real Kanban epics/stories: CI Pipeline,
  Frontend Test Coverage, Runtime Lifecycle Separation, SQLite Ceiling.
- **CI**: `.github/workflows/cypress.yml` had zero actual runs ever (pull_request-only trigger,
  this project commits directly to main) — renamed to `ci.yml`, added a push trigger, added a
  `backend-tests-and-build` job (full monolith + distribution-service suites + build). Fixed two
  bugs the never-run workflow had been hiding: seed-before-server-exists ordering, and the login
  rate limiter (20/15min/IP) tripping across 23+ test files in one continuous run — now
  configurable via `LOGIN_RATE_MAX` (default unchanged; CI sets 200).
- **Frontend tests**: Vitest + Testing Library wired up (`npm run test:frontend`, its own
  parallel CI job). `src/App.test.jsx` (auth gating), `src/pages/KanbanPage.test.jsx` (Add
  Ticket flow). Mocks `./api` by mirroring its real shape via `vi.importActual`, not a hand-kept
  method list.
- **PDF Render Service** — CargoDesk's second extracted microservice (`services/pdf-render/`,
  port `3003`, stateless). `lib/pdf-signing.js`'s `renderHtmlToPdf(html)` kept its exact
  name/signature; only its implementation moved from a local Puppeteer launch to an HTTP call.
  Cert lookup + signing stay in the monolith — the signing key never leaves it. Full runtime-
  lifecycle audit (AIS listener, OFAC sync, WS broadcast, PDF rendering) in `ARCHITECTURE.md` §12.
- **SQLite ceiling**: design doc + honestly-blocked PoC in `ARCHITECTURE.md` §13 (no Postgres
  available in this environment — not skipped by choice). Recommends sequencing an eventual
  Postgres migration with the already-planned Epic 5 (Customer/Organization service extraction).
- `ARCHITECTURE.md` (root) was found even more stale than `src/dev/architecture.html` (v0.30.0)
  — staleness banner added, three Known Debts items marked resolved that are now directly false.

## Recent changes (v0.65.1 "Ballast")
- **Row-mapper extraction.** `server.js`'s "Map functions" section mixed genuine pure row-mappers
  with real business logic (`syncShipmentFromLegs` writes to the DB; `applyShipmentAccessFilter` is
  the role/office/scope authorization filter) sharing one section header. Extracted only the true
  mappers (`mapShipment`, `mapContainer`, `mapCustomer`, and 45 others) into new `lib/mappers.js` via
  a `createMappers({ portLanesMap, CUTOFF_WARNING_DAYS })` factory — same pattern as
  `createAisListener({ db, ... })`. `syncShipmentFromLegs`/`applyShipmentAccessFilter`/the party-role
  constants deliberately stayed in `server.js` rather than being swept in for a bigger line-count
  win. `server.js`: 3230 → 2984 lines. No behavior changed — full suite green, clean build, live CDP
  pass across 4 mapper-heavy pages. The larger remaining piece of the file-breakdown proposal
  (splitting `KanbanPage.jsx`'s ~20 components) was scoped but not executed this pass.

## Recent changes (v0.65.0 "Ballast")
- **Dead-code audit and removal.** `server.js`'s entire tail (144 `app.*` registrations, everything
  after the last `require('./routes/ais')` call) was an exact duplicate of routes already registered
  by `routes/*.js` — proven unreachable via Express's first-match routing, not just suspected-unused.
  Removed via a character-level statement parser (paren-depth tracking, skips string/template-literal/
  comment content) rather than a line-range heuristic. Also removed: 10 helper functions/constants
  interleaved in that same dead zone, each independently re-implemented in its live `routes/*.js`
  counterpart (`checkDgPolicy`, `TICKET_JOIN`, `saveLegs`, `saveRates`, `LEG_TO_MOT`,
  `resolveLegPointDead`, `parseCSVLine`, `parseOfacCsv`, `STALE_EVENTS`/`mapDoc`, `MAERSK_CODES`,
  `mockSailings`, `maerskSchedules`); `server.js` is now 3230 lines, down from 5300 (39% smaller).
  Elsewhere: `src/old - no refactor/` (a full legacy pre-refactor app copy, zero references) deleted;
  `src/utils/documentGenerator.js` (client-side jsPDF generation, zero references, superseded by the
  server-uploaded `DOC_TYPES` tracker) deleted, letting `jspdf`/`jspdf-autotable` drop from
  `package.json`; three complete dead component definitions inside `DashboardPage.jsx`
  (`CarriersPage`/`ShipmentsPage`/`ShipmentDetailPage` — a whole second, never-rendered
  carrier/shipment UI) removed (330 lines). No behavior changed anywhere — every removal was proven
  unreachable/unreferenced before deletion. Full 20-file monolith suite + 3 distribution-service
  suites green (600+ assertions), clean build, live CDP pass confirming zero regressions. A
  structural survey of the largest remaining files (`KanbanPage.jsx` 4358 lines, `App.jsx` 3977,
  `ShipmentDetailPage.jsx` 2816, etc.) found most are already composed of many independent,
  self-contained components concatenated into one file — a low-risk file-split candidate, logged as
  a proposed follow-up rather than executed in this pass.

## Recent changes (v0.64.0 "Relay")
- **TKT-SLIRP9 — Document Distribution: EDI + Webhook channels, and CargoDesk's first extracted
  microservice.** New `services/document-distribution/` — a genuinely separate deploy unit (own
  `package.json`, port `3002`, SQLite file, same Express+`node:sqlite` stack) owning
  `webhook_configs`/`edi_transmittals`/`webhook_deliveries`. It never touches the monolith's
  database — only the opaque ids the monolith hands it via `/internal/*` routes, authenticated by
  a shared bearer secret (`DISTRIBUTION_SERVICE_SECRET`). Email stays in the monolith (proven,
  shipped, no reason to migrate for architectural purity alone) — only the two brand-new channels
  get a service boundary from birth.
- **EDI** means a formal transmittal record (metadata + SHA-256 checksum, not embedded bytes) —
  this app's EDI messaging has always been simulated/structured-JSON, with zero attachment concept
  anywhere in `edi_messages`. **Webhook** is a real outbound HTTPS POST, HMAC-signed
  (`X-CargoDesk-Signature`), gated by a new SSRF guard (`services/document-distribution/lib/
  webhookSender.js` — https-only, blocks loopback/link-local/private-range literal hosts including
  the cloud-metadata address). New `lib/shareToken.js` (extracted from `routes/share.js`, pure
  move) backs a new `GET /api/share/document/:token` — a signed, expiring download link the
  monolith mints so an external webhook receiver can fetch the file without a CargoDesk login.
- **Two real bugs found live during verification**: the webhook handler's error path
  double-inserted the same delivery id (once in its `try` block on any non-2xx response, again in
  `catch`), surfacing as a UNIQUE constraint violation — fixed to exactly one `INSERT` regardless
  of outcome. A never-configured webhook defaulted `isActive` to `false` (Email's own
  `DEFAULT_SETTINGS` defaults `true`) — since the frontend always sends an explicit value seeded
  from the GET response, a brand-new webhook silently saved as inactive; fixed to match Email's
  default.
- New internal channel registry (`services/document-distribution/lib/channels.js`) —
  `registerChannel()`/`distribute()` — is the actual "add a channel = one new registration, not a
  new route" decoupling property, achieved without any new infrastructure (no message broker
  between the two processes — a direct authenticated HTTP call is the right size for two services).
- Document rows gain **"📡 EDI"** and **"🔗 Webhook"** buttons alongside the existing **"✉ Send"**,
  plus a **"🕐"** history icon wired to the already-generic (but until now unused for documents)
  `EntityHistoryModal` — closing a real gap where every send, Email included, wrote an audit event
  nobody could ever see again. Test Tools gains a **Webhook Simulator** tab (a real dev-only mock
  receiver plus client-side signature verification), mirroring the Message/Filing/AIS Simulator
  precedent. `src/dev/architecture.html` (stale since v0.22.0, otherwise untouched) gets one new,
  clearly-marked box for the split — see its own header note.
- 54 new test assertions across 3 files (2 service-level on `:3002`, 1 monolith-level exercising
  the real proxy-to-service round trip — the first test requiring two processes running). Full
  20-file regression suite still green, clean build. Verified live via CDP end-to-end: saved a
  real office webhook, sent a document via EDI and confirmed the transmittal in the History modal,
  sent via webhook to a real non-2xx host and got the same clean-failure toast the automated tests
  already proved — now confirmed over a real network call to a genuinely separate process.

## Recent changes (v0.63.0 "Beacon")
- **GPS-Coordinate Pickup/Delivery for Classified-Location Customers** — some customers' sites
  (military/government/restricted) can only be identified by GPS coordinates, never a UN/LOCODE.
  Strict either/or per leg endpoint (per direct clarification), not a hybrid: `shipment_legs`'
  existing `pol_loc_type`/`pod_loc_type` (`Door`/`Terminal`/`Container Yard`/`CFS`) gains a 5th
  value, `"GPS Coordinates"`, reusing the existing per-endpoint selector rather than a parallel
  mode column. New nullable `pol_latitude`/`pol_longitude`/`pod_latitude`/`pod_longitude` carry the
  location when set, with the corresponding `pol`/`pod` blanked — gated to Pick-up/Delivery legs
  only (a SEA leg always needs a real port), enforced both client- and server-side.
- New `customers.classified_location`/`latitude`/`longitude` — Profile tab checkbox reveals Lat/Lng
  fields when checked (mirrors the `credit_hold`/`credit_hold_reason` pattern). New `validCoord`
  helper (server.js) — the first lat/lng range validation (-90..90/-180..180) in this codebase,
  since `port_locations`' own coordinates are trusted import data, never user-typed.
- **Real bug fixed, found live via CDP verification**: the SEA-leg gate initially checked a leg's
  `mot` field, but the Leg Type selector (`ShipmentFormPage.jsx`) only updates `legType`/
  `movementType` on change, never `mot` — a leg just switched from SEA to Pick-up/Delivery still
  carried its old `mot='SEA'` in the same save, wrongly blocking a legitimate GPS-mode switch.
  Fixed by gating on `legType` instead. Also fixed: `syncShipmentFromLegs` now falls back to the
  real SEA leg's port for the shipment's own `pol`/`pod` when the bookending Pick-up/Delivery leg
  is GPS-blanked (it already did this for vessel/voyage/carrier, just not pol/pod).
- New shared `src/utils/legLocation.js` (`formatLegPoint`) renders `"GPS: {lat}, {lng}"` with a
  "Classified location" caption everywhere a leg's From/To is shown. `routes/share.js`'s public,
  unauthenticated tracking endpoint strips the 4 coordinate fields (keeping the loc-type label) —
  a classified site's exact coordinates must not leak through a token-only link.
- 30 new test assertions (`tests/classified-locations.test.js`), full 20-file suite green, clean
  build. Verified live via CDP: flagged a customer classified with real coordinates via the
  Profile tab; switched a shipment's Pick-up leg to GPS Coordinates with typed lat/lng, confirmed
  save/display (including the "GPS-PT" routing badge and header card) alongside a real SEA leg
  whose own port still correctly populated the shipment header.

## Recent changes (v0.62.1 "Waypoint")
- **Schedule-correction route (`PUT /api/shipments/:id/schedules/:scheduleId`) wired into the new
  leg-key system** — found live during an end-to-end manual test (simulating a carrier response
  with a different vessel/voyage via this route). It updated the schedule's flat columns fine but
  left `scheduleKey`/`sailing_legs`/`schedule_leg_refs` stale on the ORIGINAL sailing, since this
  route predates the Waypoint rework. Fixed by rebuilding legs from `schedule_leg_refs`, applying
  the correction on the first leg (carrier/vessel/voyage/etd) and last leg (eta), then re-saving via
  `saveScheduleLegs`. A real vessel substitution now correctly produces a new `leg_key`; a same-
  vessel ETD bump still lands as a normal `upsertLeg` update. 7 new test assertions, full 24-file
  suite green.

## Recent changes (v0.62.0 "Waypoint")
- **Content-Keyed Sailing Legs** — `schedule_legs` gave every schedule its own fresh leg rows with
  zero dedup, even when two schedules described the exact same physical dated sailing segment. New
  `sailing_legs` table is the canonical, deduplicated catalog instead — one row per distinct leg,
  keyed by a deterministic content key (`computeLegKey`: carrier+vesselImo+voyageNumber+pol+pod+etd,
  `routes/shipment-ops.js`). New `schedule_leg_refs` join table is the ordered composition — every
  schedule now has 1+ refs (a "direct" sailing is simply one ref). New `schedule_key` column (the
  ordered concatenation of leg keys) lets two independently-created schedules be recognized as the
  same sailing via string equality. `mapSchedule`'s external shape is unchanged, so the existing
  frontend and the 50-assertion `schedule-catalog.test.js` suite needed zero changes.
- **`upsertLeg` is a real upsert with an audit trail**, per direct feedback — a leg's descriptive
  fields (`eta`/`vesselName`/`service`) can be revised later by an external source, and every
  revision logs one `entity_events('sailing_leg', ...)` row per changed field, the same
  field-level diff-and-log idiom the schedule PUT route already used. Surfaced in the existing
  `ScheduleHistoryPanel` — `GET /api/shipments/:id/schedule-events` now unions in `sailing_leg`
  events for whichever legs back that shipment's own schedules, with a "Leg POL→POD:" prefix.
- **Real bug fixed along the way**: `POST /api/shipments/:id/schedules` never read a posted
  `legs[]` array even though the frontend's `commitSailing()` already sent one for multi-leg picks
  — a shipment picking a TSP sailing silently lost its transshipment-leg breakdown on save. Fixed
  by wiring the same leg-saving path into that route; no frontend change needed.
- One-time backfill gives every pre-existing schedule a uniform leg-backed representation;
  idempotent (verified via two consecutive restarts). 13 new test assertions, full 19-file suite
  green, clean build. Verified live via CDP: a second shipment reusing an existing schedule's leg
  with a revised ETA correctly shows up as a leg-level update (old→new diff) in the first
  shipment's own Schedule History.

## Recent changes (v0.61.0 "Liaison")
- **Carrier Line Agents** — modeled the CargoWise-baseline relationship between an ocean carrier
  and its local representative, who differs by port (Maersk's Rotterdam agent isn't its New York
  agent) — distinct from a Forwarder's own overseas correspondent network, which this doesn't
  model. New `carrier_agents` table (`carrier_code` x `port_unlocode` -> agent `customer`, no
  denormalized name — live-joins to `customers` like `CUST_JOIN` already does for
  `parent_customer_name`) plus `MdmCarrierAgentsPage.jsx`, modeled directly on
  `MdmLinkedPortsPage.jsx`. `agent_customer_id` has no `ON DELETE` clause (neither CASCADE nor
  SET NULL fits) — customer delete is blocked by a new app-level guard in `routes/customers.js`,
  mirroring `offices.js`'s own "referenced by shipments — deactivate it instead" pattern.
- **Resolves onto the existing `shipment_parties` mechanism**, not a parallel system — two new
  roles, `"Line Agent (Export)"`/`"Line Agent (Import)"`, mirroring how `"Customs Broker"` was
  already split Export/Import for the identical one-shipment-two-ends reason. New
  `resolveCarrierAgent(carrierCode, portUnlocode)` (server.js, beside `linkedPortCodes`) falls back
  through linked ports the same way `findMatchingContractLeg` already does.
  `maybeAssignLineAgents` (routes/shipments.js) fires on shipment create (before
  `screenShipmentById`, so compliance screening never misses a sanctioned agent on day one) and on
  carrier/POL/POD change — `UNIQUE(shipment_id, role)`'s own insert-conflict IS the "only fill an
  empty slot, never overwrite" mechanism, so a manual assignment is never clobbered and a carrier
  change with no registered agent simply leaves the existing party untouched.
- **Everything else picks it up for free**: compliance screening, and the customer
  role-derivation/segmented list (v0.60.0) — both new roles land under Service Providers
  automatically. One deliberate new UI surface: a read-only Line Agents card on the shipment's
  Carrier Booking → Details tab, next to the existing Carrier/Route/Vessel card.
- New `tests/carrier-agents.test.js` (24 assertions) — full 19-file suite green, clean build.
  Live browser-screenshot verification of the two new UI surfaces was inconclusive due to
  intermittent dev-proxy connectivity in this environment (backend itself responded correctly to
  every direct request throughout) — thoroughly verified instead via the automated suite and
  direct API checks against the exact data those surfaces render.

## Recent changes (v0.60.0 "Census")
- **Customer roles reworked from a hand-maintained 13-checkbox editor into a derived, read-only
  signal.** Direct concern: nothing kept a checked role honest against actual usage — classic
  staleness bug waiting to happen. `routes/customers.js` gained `CUSTOMER_ROLE_USAGE_SQL`, a
  UNION over `shipments`' 4 fixed role columns + `shipment_parties` (the same 13-role vocabulary
  `screenShipmentById`, Epic 3, already screens). `GET /api/customers/:id/roles` now reads it
  directly — `PUT /api/customers/:id/roles` is gone, there's nothing to set. `customer_roles`
  itself is left in place, unused, per this codebase's standing no-schema-drop-migration
  precedent.
- **`GET /api/customers?role=` now accepts comma-separated multi-role values**, resolved against
  the same derived UNION, and the list response batch-attaches a `roles: string[]` to each row.
- **Considered and rejected: splitting customers from vendors into separate tables** — would
  reintroduce the duplicate-company-record problem CargoWise's unified Organization-with-role-
  flags model exists to avoid. Built a segmented view instead: `CUSTOMER_ROLE_CATEGORIES`
  (`src/tokens.js`, frontend-only) groups the 13 roles into Trading Customers (5) / Service
  Providers (8); `MdmCustomersPage`'s list gained an All/Trading Customers/Service Providers
  segmented control and a color-coded Roles column. The Profile tab's checkbox editor was deleted
  and replaced with the same read-only badge list.
- Two interactive HTML mockups (matching the app's real theme tokens) were built and walked
  through with the user before writing any code, per explicit request.
- Verified live via CDP against real data: switching to "Trading Customers" correctly narrowed
  18 customers to 9, excluding every customer whose only real usage is a Service Provider role.

## Recent changes (v0.59.1 "Lineage")
- **Fixed a real bug found live on SHP-XXGOJ1** (direct user report: "the container invoice does
  not include the VAT"): the generated freight invoice PDF (FR01/FR02, and the credit/debit note
  reversing one) completely omitted VAT — a $10,000 line with a real 19% VAT rate ($1,900)
  produced a signed PDF showing just $10,010 total. `ShipmentAccountingInvoicesPage.jsx`'s own
  in-app summary bar had been computing/showing VAT correctly the whole time; the gap was purely
  in the document actually generated and sent to the customer.
- `buildFreightInvoiceHtml`/`buildCreditDebitNoteHtml` (`src/utils/invoiceGenerator.js`) both now
  render a VAT column per charge line and a Subtotal/VAT/Total(incl. VAT) breakdown per currency
  — collapsing back to the original plain Total row for a currency group with no VAT on any
  line, so a shipment with `vat_rate=0` everywhere renders byte-identical to before this fix.
- Verified live: regenerated the real draft invoice on SHP-XXGOJ1 and confirmed the signed PDF
  now shows SUBTOTAL $10,010.00 / VAT $1,900.00 / TOTAL (incl. VAT) $11,910.00.

## Recent changes (v0.59.0 "Lineage")
- **Organization Model Enhancement, Epic 4: Customer Hierarchy & Named-Account Unification.**
  New nullable, self-referential `customers.parent_customer_id` (`ON DELETE SET NULL`, actually
  enforced since `foreign_keys=ON` is set globally) — a plain `ADD COLUMN`, no table rebuild
  needed since it's a brand new nullable column. New shared `resolveCustomerGroup(customerId)`
  (server.js) — walks to the root ancestor then every descendant, so a rollup gets the same
  group regardless of which member's id the caller started from. Deliberately read-side only —
  the 3 independent customer-pointer mechanisms (shipment fixed FKs, `shipment_parties`,
  `contracts.named_account_id`) keep writing plain denormalized `customer_id`/`customer_name`
  pairs exactly as before; this reads across them for reporting, doesn't unify the write path.
- New Parent Customer picker on the customer Profile tab (`CustomerCombobox`, unrestricted) with
  server-side cycle detection (rejects self-parenting and deeper A→B→A loops, which would
  otherwise make `resolveCustomerGroup`'s walk infinite).
- **`GET /api/margin/summary` gains a `byCustomer` breakdown** (grouped by each shipment's
  Principal, falling back to Consignee) with a `groupByParent=true` query param — the Dashboard
  Margin tab's new "Roll up by parent" toggle (off by default) remaps every line to its
  hierarchy's root customer before aggregating.
- Carrier Booking's "Client" field gains a small "Part of {parent}" caption when the Named
  Account customer has a parent — single-shipment context, not a rollup (nothing to aggregate
  on one shipment's own client display).
- New `tests/customer-hierarchy.test.js` (17 assertions) — full suite green (18 files), clean
  build. Verified live via CDP: Parent Customer resolves correctly, and the rollup toggle
  correctly collapses two customer rows into one combined row under the parent's name.

## Recent changes (v0.58.0 "Sentinel")
- **Organization Model Enhancement, Epic 3: Unified Compliance Screening** — the highest
  compliance-risk gap from the original CargoWise analysis: 9 of a shipment's 13 possible
  party-role slots were previously invisible to sanctions screening entirely.
- **`screenShipmentById`** (server.js) broadened from Shipper/Consignee/Principal only to all
  13: the 4 fixed columns (adding Notify Party) plus every `shipment_parties` row. Assigning/
  reassigning/removing an additional party now auto-triggers a re-screen (`routes/shipments.js`'s
  new `maybeRescreen` helper, reused across all 3 `shipment_parties` CRUD routes and the
  shipment `PUT` route, which also gained `notify_name` to its own re-screen-trigger check) —
  honoring the same don't-overwrite-a-compliance-officer's-override guard every path already used.
- **Customer-level and shipment-level screening now cross-reference.** `screenCustomer`
  (`routes/customers.js`) calls a new `rescreenShipmentsForCustomer` that immediately re-screens
  every shipment referencing that customer via any of its 13 role slots. This surfaced a real,
  deeper bug: shipment-level screening only checked each party's denormalized NAME copy — a
  customer rename updates `customers.company_name` but never touches any shipment's already-
  stored copy of the old name, so a pure name-match re-screen stayed permanently blind to the
  rename. Fixed by also corroborating each party's `customer_id` (where set) against
  `customer_screenings` directly, alongside the name match, not instead of it.
- After any sanctions list update (OFAC sync, scheduled auto-sync, or manual CSV import), a new
  `rescreenActiveShipments` sweep re-screens every not-Completed/Cancelled shipment.
- The existing `ComplianceModal` (already the app's one unified compliance view, reachable from
  every shipment sub-page via the persistent header) was extended, not replaced: Notify Party
  joins the 4-role Phase 1, and a new Phase 1b lists every assigned additional party with its
  live screening status.
- New `tests/customer-compliance-screening.test.js` (25 assertions, deliberately reusing a real
  already-synced sanctioned entity name rather than importing new sanctions data, which would
  destructively replace the live OFAC dataset) — full suite green (17 files), clean build.
  Verified live via CDP: a sanctioned Notify Party and a sanctioned Bank additional party both
  correctly show as HIT with real matched OFAC program details.

## Recent changes (v0.57.0 "Covenant")
- **Organization Model Enhancement, Epic 2: Credit Control.** New `credit_limit`/
  `credit_terms_days`/`credit_hold`/`credit_hold_reason` on `customers`, surfaced in the
  Profile tab's Billing section alongside Currency — ties directly into the already-shipped
  invoicing infrastructure (`generateInvoices`, `ShipmentAccountingInvoicesPage.jsx`) rather
  than needing a new page.
- **`credit_hold` is a hard block on generating a NEW invoice** for shipments where the held
  customer is the Shipper, Consignee, Principal, or the linked contract's Named Account —
  existing cost lines/documents stay fully visible and editable, only Generate Invoice/
  Generate Per-Container Invoices are blocked, via a modal naming exactly which party and why
  (no way to proceed from it — mirrors `CarrierBookingGateModal`'s forced-modal shape, but
  scoped to one action rather than the whole page).
- **New `GET /api/customers/:id/credit-status`** resolves outstanding AR by summing every
  CONFIRMED (non-voided) FR01/FR02 invoice on shipments where the customer is Principal or
  Consignee, resolving each invoice's real dollar total via `source_cost_line_ids` (the same
  field the v0.53.0 invoice-reversal feature introduced) with the identical live-container-
  scoped fallback for older invoices predating that column.
- **Over-limit is a soft warning only** (`resolveCreditGate`, `src/utils/invoiceGenerator.js`)
  — Cancel/Generate Anyway, never a hard block, per this epic's own explicit scope (a real hard
  block needs a proper AR-aging view this app doesn't have yet). Computed as *outstanding AR +
  the invoice about to be generated* against the limit, not outstanding AR alone — a real gap
  caught during CDP verification: checking only prior confirmed invoices would never catch the
  very first invoice that actually pushes a customer over their limit.
- New `tests/customer-credit-control.test.js` (28 assertions) — full suite green (16 files),
  clean build. Verified live via CDP: the blocking modal correctly names the held customer and
  reason and produces zero documents; clearing the hold and lowering the limit below an
  uninvoiced line's amount correctly shows the projected-total warning modal instead.

## Recent changes (v0.56.0 "Roster")
- **Organization Model Enhancement, Epic 1 of a 5-epic roadmap** drawn up from a direct
  CargoWise One gap analysis: CargoWise's Organization record carries its own role flags and
  multiple named contacts; this app's `customers` table had neither — a company was only ever
  "a shipper" or "a bank" by whichever shipment-level slot it was dropped into, and the only
  place to record a contact person was `CustomerCombobox`'s free-text Notes field.
- **New `customer_contacts` table** (name/title/email/phone/department, one `is_primary` per
  customer) — new **Contacts** tab on the Customers MDM page, mirrors the existing
  `customer_identifiers` CRUD pattern almost exactly (`routes/customers.js`).
- **New `customer_roles` table** tags a customer against `ALL_CUSTOMER_ROLES` — a new combined
  vocabulary (the 4 fixed shipment roles Shipper/Consignee/Notify Party/Principal, plus the
  existing 9 `ADDITIONAL_PARTY_ROLES` from Epic `TKT-5XFCAP`, both sides — server.js and
  `src/tokens.js` — keep their own copy, same split `ADDITIONAL_PARTY_ROLES` already used). A
  checkbox multi-select on the customer Profile tab saves each toggle immediately via its own
  endpoint (`PUT /api/customers/:id/roles`, full-set replace) rather than folding into the main
  Save Profile button, since roles live in a separate table.
- **`CustomerCombobox` gains an optional `roleFilter` prop**, threaded through to a new
  `GET /api/customers?role=` subquery filter — wired into `AdditionalPartiesPanel` (filtered by
  whichever role is being assigned) and `PartiesEditForm`'s Shipper/Consignee/Principal/Notify
  Party fields. Deliberately a **soft filter, never a hard block**: `CustomerPickerModal` shows a
  checkbox ("Only show customers eligible for {role}", defaults on) so an operator can always
  reach an unflagged customer by unchecking it — verified live via CDP, toggling it correctly
  reveals/hides a non-eligible customer in the same result list.
- New `tests/customer-contacts-roles.test.js` (28 assertions: contacts CRUD including the
  single-primary-per-customer invariant, roles get/set as a full-replace not a merge,
  invalid-role rejection, the role search filter, orphan-free cleanup on customer delete) — full
  suite green (15 files), clean build.
- **This is Epic 1 of a larger roadmap** — Epics 2-4 (not yet built): credit control (limit/
  terms/hold gating invoice generation), unified compliance screening across all 13 party-role
  slots (today only 3 of 13 are screened), customer hierarchy/rollup reporting. Epic 5 (a real
  Customer/Organization service extraction) is deliberately sequenced last, after the data model
  settles — a same-process second SQLite file was considered and rejected as the mechanism, since
  it achieves neither of the two real drivers raised for it (future shared-service consumption,
  data-compliance controls); both need a genuine separate service with its own datastore and API,
  not a file split.

## Recent changes (v0.55.1 "Transponder")
- **Direct design correction to v0.55.0's AIS feature**: the original design showed AIS-detected
  departure/arrival as a separate, always-visible ATD/ATA pair alongside ETD/ETA — corrected per
  direct feedback to instead update `etd`/`eta` **in place** on confirmation (an estimate
  becoming a known fact), matching how the Route Legs table is meant to read. New
  `shipment_legs.etd_source`/`eta_source` replace `atd`/`ata`/`atd_source`/`ata_source` as the
  write model (old columns left inert, not dropped — standing no-migration-cleanup precedent).
  The write guard changed from a blank-fill check (etd/eta are almost always already populated
  with an estimate, so that would never fire) to an **idempotent-confirmation** check
  (`source==='ais'` means already-confirmed, don't re-fire) — the first AIS confirmation
  legitimately overwrites the prior estimate, and a later manual correction legitimately
  overwrites an AIS-confirmed value right back, clearing the flag. A small ship-icon indicator
  on the ETD/ETA cells marks a confirmed value. `lib/ais-listener.js`, the leg CRUD routes,
  `routes/ais.js`'s open-legs query, and the Test Tools AIS Simulator were all reworked to
  match; `tests/ais-integration.test.js` rewritten around the corrected model (30 assertions).
- **Four unrelated live bugs found and fixed in the same feedback pass**: (1) the Route Legs
  Carrier column could visually overlap Movement By — a CSS flexbox `min-width:auto` gotcha
  (`CarrierCombobox`'s root div had no explicit `min-width`, so it refused to shrink below its
  selected chip's intrinsic width inside a fixed-width cell); fixed at the shared-component
  source (`minWidth:0`) plus `overflow:hidden` on the cell wrapper. (2) Header/row column
  misalignment — the locked/read-only leg row rendered a variable-width leading lock-icon
  column the header had no matching placeholder for, while the editable row rendered no leading
  column at all; fixed with one shared `LEG_LEAD_COL_W=40` constant reserved identically across
  the header and both row states. (3) The Sailing Search modal's apparent "duplicate" schedule
  entry was three compounding gaps, not real duplicate data: a stale pre-fix `transit_days=0` on
  an already-committed `source='search'` copy (backfill migration broadened beyond
  `source='generated'`), and `vesselImo` never carried through `catalogSailings()`'s results nor
  `POST .../schedules`' commit route (both fixed). (4) A module-level `LEG_TYPE_COLOR` object in
  `ShipmentFormPage.jsx` captured `T.accent`/`T.info`/`T.textMuted` once at import time — since
  `T`'s colors mutate in place on theme toggle rather than the object rebuilding, "Delivery" was
  permanently stuck in the dark theme's blue-gray `textMuted` even in light mode. Fixed by
  converting it to a function evaluated at render time.
- **Vessels MDM polish** (same session's earlier AIS vessel-import work): Flag cell always
  reserves two stacked lines regardless of whether a vessel has flag data (fixes inconsistent
  row heights); Actions column header right-aligned to match its button content; Flag badge's
  caption text gets the same 9px left inset `Badge.jsx`'s own padding gives the badge above it
  (fixes an optical, not layout, misalignment).
- Full `npm test` green (14 files), clean `vite build`. Verified live via CDP: the header/row
  alignment fix confirmed via a fresh screenshot (separator bars now land exactly on column
  boundaries); the separately-reported "remove leg doesn't unlink the schedule" issue was
  reproduced on a disposable clone of the real reference shipment's exact leg/schedule shape
  (not the real shipment itself) and worked correctly end-to-end — the cascade logic itself was
  not broken.

## Recent changes (v0.55.0 "Transponder")
- **AIS Integration (Epic `TKT-ZFO2OM`)**, following two spike tickets (`TKT-R7S25A`,
  `TKT-1Q59BF`) evaluating live AIS vessel-tracking data for (a) keeping the Vessels registry
  fresh — resolving unknown IMOs automatically and catching renames/reflags — and (b)
  auto-detecting a shipment's actual departure/arrival (`atd`/`ata`), previously manual-entry
  only. Provider comparison landed on **aisstream.io** as the default (free, WebSocket, no
  hardware) — AISHub was directly considered and rejected as the default since it requires
  operating physical AIS receiver hardware and streaming to them before granting API access, not
  a signup-and-get-a-key API. Settings stay provider-pluggable (new `ais_provider`/`ais_api_key`
  App Settings card, same pattern as `maersk_api_key`) so a client with their own AIS access can
  supply different configuration later.
- **New `lib/ais-listener.js`** — one persistent outbound WebSocket connection (the first
  persistent-outbound-connection precedent in this codebase) feeds two independent write
  behaviors from the same handler: `ShipStaticData` resolves/refreshes `vessels` (new `mmsi`/
  `ais_verified_at` columns; a differing name for a known IMO logs a `RENAMED` `entity_event`),
  `PositionReport` proposes `atd`/`ata` on a tracked SEA leg when nav-status/position near the
  leg's POL/POD indicates a real departure or arrival.
- **ATD/ATA lives on `shipment_legs`** (new `atd`/`ata`/`atd_source`/`ata_source` columns,
  `_source` is `'manual'|'ais'|''`), rolled up onto `shipments.atd`/`.ata` the same first-leg/
  last-leg bookend way `etd`/`eta` already are via `syncShipmentFromLegs` — **not**
  `shipment_schedules`, since tracing every write path found `shipment_schedules.vessel_imo`/
  `atd`/`ata` are only ever populated by the Schedule Generator's ownerless template rows, never
  the everyday Add Sailing flow, so matching against it on a real shipment would essentially
  never hit. The auto-fill is strictly non-destructive — structurally identical to the existing
  `autoCompleteMilestone` guard (only ever writes a still-blank field) — with a visible
  provenance flag so an AIS-detected value is never mistaken for a manual one (small ship-icon
  indicator on the Route Legs table, `ShipmentFormPage.jsx`'s `LEG_COLS`).
- **New Test Tools "AIS Simulator" tab** (mirrors the existing Message/Filing Simulator
  precedent) injects synthetic `ShipStaticData`/`PositionReport` messages through the exact same
  `ctx.ingestAisMessage` the live connection calls — no parallel "simulate an update" code path
  — making the whole feature verifiable end-to-end without a real aisstream.io API key.
- **Two real bugs caught during verification, both fixed**: (1) disconnecting a socket that
  hadn't finished connecting yet (e.g. toggling the feature off moments after enabling it)
  emitted an internal 'error' event that `removeAllListeners()` had just stripped the handler
  for, **crashing the entire Node process** — fixed by no longer removing listeners before
  `terminate()`. (2) the live listener's tracked-leg cache only refreshes every 60s (fine for a
  real feed pushing hundreds of msg/sec, not fine for a leg a developer just created moments ago
  via the simulator) — the simulator now force-refreshes it before injecting a position.
- New `tests/ais-integration.test.js` (30 assertions, added to `npm test`) — full suite green
  (11 files), clean build. Verified live end-to-end via the real simulator/API: unknown-IMO
  resolve, rename detection with no duplicate event on a re-observed unchanged name, ATD/ATA
  blank-fill with correct provenance and shipment-level rollup, and — the single most important
  case — a manually-set ATD surviving a subsequent AIS departure simulation untouched. Also
  confirmed live: the reconnect/backoff loop retries indefinitely on a bad key without ever
  taking the server down, and a settings toggle/key change applies immediately with no restart.

## Recent changes (v0.54.3 "Catalog")
- **A fourth live bug on the same feature**: transit time showed "0d" for a real 2-leg TSP
  catalog match with an 8-day door-to-door span. `POST /api/schedules` (the Schedule
  Generator's create route) hardcoded `transit_days` to the literal value `0` at insert time —
  never derived from the schedule's own etd/eta, unlike `mockSailings()`/`maerskSchedules()`,
  which both compute it correctly from real date math. Fixed by computing it as the
  whole-journey ETD→ETA span in days — this naturally folds in any transshipment hub dwell
  time between legs instead of undercounting it (a TSP with a multi-day layover at the hub is
  the full door-to-door span, not the sum of each leg's own transit). Added a one-time startup
  backfill for schedules already created with this bug (`source='generated'`, `transit_days`
  still 0, real etd/eta present) — safe to re-run.
- **Separately investigated a reported Route Legs table formatting inconsistency** between the
  Contracts & Schedules page and the shipment Edit form (both render the shared `LegsTable`
  component). Direct side-by-side comparison via automated browser testing found no actual
  discrepancy — both already render identically with no overlaps on a fresh shipment; a fixed
  footer briefly appeared to overlap a leg row in an early screenshot, but that turned out to be
  a Puppeteer `fullPage`-screenshot artifact (fixed-position elements can render at the wrong
  offset during full-page capture), not a real rendering bug — confirmed via a real,
  non-fullpage scrolled screenshot showing clean separation.

## Recent changes (v0.54.2 "Catalog")
- **A third live bug on the same feature**, reported right after v0.54.1 shipped: "having the
  data filled in the modal does not propagate anything to the main schedule gen page, generation
  is prevented." `generate()`'s validation in `TestToolsPage.jsx` only ever checked the top-level
  Vessel/Carrier/POL/POD fields, never `legRows` — so a TSP built entirely inside the Configure
  Legs modal (main form deliberately left blank) was wrongly blocked even though the backend's
  own `POST /api/schedules` derivation (`finalCarrier`/`finalVesselName`/`finalPol`/`finalPod`
  from leg 1/leg N) already fully supported this exact case. Fixed by making `generate()`'s
  validation read `legRows[0]`/`legRows[legRows.length-1]` whenever `legRows.length >= 2`,
  mirroring the backend's own effective-value logic rather than duplicating a narrower one.
  New `closeLegsModal()` mirrors leg 1's pol/carrier/vessel and leg N's pod back onto the main
  form's visible fields on Done (not the unrelated Clear action), so a modal-only TSP is visibly
  reflected afterward instead of looking like nothing happened.
- **New regression test** in `cypress/e2e/schedule-generator.cy.js` reproduces the exact scenario
  end-to-end. Along the way, hit a Cypress-only artifact worth remembering: since the main form is
  deliberately left blank in this scenario, its own (still-empty) Carrier search input stays in
  the DOM too, just visually hidden behind the modal overlay — an unscoped page-wide selector can
  grab that one by accident instead of the modal's own. Fixed via `.within()` scoping from the
  modal's own `<h2>`, same pattern already established elsewhere in this suite for `Modal.jsx`'s
  header/content nesting.
- **Verified independently via a direct CDP/Puppeteer script**, not Cypress — the Cypress binary
  would not launch in this session's sandboxed shell (`Cypress.exe: bad option: --smoke-test`),
  confirmed unrelated to this fix via a full cache-clear-and-reinstall. The script drove a real
  browser through the exact regression scenario end-to-end: the modal-built TSP correctly
  propagated onto the main form and a real schedule generated successfully.

## Recent changes (v0.54.1 "Catalog")
- **Two real bugs found live on v0.54.0, both direct user reports against a real shipment
  (SHP-W942AJ).** (1) `GET /api/schedules/search`'s new catalog query had no `is_mock` exclusion,
  so it resurrected old `shipment_schedules` rows saved back when Add Sailing always inserted a
  row for any picked sailing, including synthetic "DEMO ..." ones — confirmed live, 4 stale rows
  ("DEMO DULCIMER"/"DEMO CADENZA") were surfacing tagged `source:catalog` as if real. Fixed with
  `AND is_mock=0` on the catalog query. (2) The Configure Legs modal's Vessel field was a plain
  text input with zero connection to the real vessel registry, and there was no per-leg carrier
  at all — real TSP sailings routinely change carrier at a transshipment hub. Vessel column now
  reuses the existing `VesselCombobox` (real `/api/vessels/search` typeahead) with a compact
  selected-vessel chip; new `schedule_legs.carrier` column + a `CarrierCombobox` per row — the
  schedule's own top-level carrier now derives from leg 1's carrier when set, same fallback
  pattern already used for vessel/voyage/service. `tests/schedule-catalog.test.js` gained 7 new
  assertions (stale-mock-exclusion regression, per-leg carrier/vesselImo round-trip) — full suite
  green (13 files, 546 assertions), clean build. Verified live via CDP/Cypress.

## Recent changes (v0.54.0 "Catalog")
- **Schedule Generator (Test Tools) decoupled from shipments, direct request.** Previously `POST
  /api/schedules` required `initialShipmentIds` to be non-empty — `shipment_schedules.shipment_id`
  was `NOT NULL`, so a generated schedule literally couldn't exist without a shipment attached at
  creation time (plus a secondary manual link/unlink UI in the same tab). Generate is now a plain
  "create and store" action with no shipment picker at all, create-time or post-hoc.
- **Add Sailing search now checks the stored catalog first.** `GET /api/schedules/search`
  (`routes/system.js`) previously always synthesized either live Maersk results or fully
  synthetic "DEMO ..." sailings (`mockSailings()`) — the search and the catalog were two
  completely disconnected write paths into the same table. It now queries `shipment_schedules`
  for a match on POL, POD, and an ETD window (mirroring the existing `weeks` semantics), joins in
  any `schedule_legs` for TSP detail, and only falls back to live/demo data when nothing real
  matches. Picking a catalog result flows through the exact same commit path as any other
  sailing (`applySailingToLegs`, unchanged) — it just also stamps the new `template_id` column on
  the shipment's own freshly-created row for provenance.
- **New `template_id` self-referential column** (nullable, `ON DELETE SET NULL`) replaces the old
  shared-ownership model for the search-and-copy flow: a shipment picking a catalog template gets
  its own `shipment_schedules` row (same as always), with `template_id` recording which template
  it was copied from — not a link to a shared row. The old `schedule_shipment_links` table and its
  `POST`/`DELETE .../link...` routes are gone (no caller once manual linking left the UI); `GET
  /api/schedules/:id/usage` (replacing `linked-shipments`) derives "used by N shipments" from
  `template_id` matches instead.
- **A guarded, one-time table-rebuild migration** (`server.js`) makes `shipment_schedules.shipment_id`
  nullable — SQLite can't drop `NOT NULL` via `ALTER TABLE`, so this is a real create-copy-swap,
  gated by checking the column's own `notnull` flag first (idempotent, runs once). Accepted
  despite this codebase's usual aversion to that migration class (see v0.41.0's additive
  `carrier_booking_archive` workaround for a similar constraint) since the blast radius here is
  narrow — nothing else joins on the column expecting non-null, and the everyday Add Sailing save
  path is completely untouched by the migration (it keeps writing shipment-owned rows exactly as
  before; only the Generator's new ownerless rows exercise the null case).
- **Real TSP/multi-leg support in the Generator**, previously entirely absent from both the tool
  and the schema. A new "Configure Legs" modal — a leg-rows table styled after the existing Route
  Legs add/remove-row interaction (direct request, simpler than bespoke inline multi-field TSP
  controls) — builds a genuine multi-leg sailing, backed by a new `schedule_legs` child table
  (mirrors the existing `shipment_legs`/`contract_legs` multi-leg pattern: one row = direct
  sailing, 2+ rows = TSP). The parent row's own summary fields (pol/vessel/voyage/etd from the
  first leg, pod/eta from the last) are derived automatically, falling back to the main form's
  top-level fields when a leg's own value is blank — every existing consumer of a schedule
  (`ShipmentHeaderBar`'s Loop field, etc.) is unaffected.
- **New `demo_schedules_enabled` setting** (App Settings → API Controls → External APIs, default
  **on**) gates the synthetic mock fallback specifically — live carrier API results are untouched,
  since they're real, not demo. Defaulting on means sailing search and existing test coverage keep
  working with zero setup; an admin turns it off once real generated schedules exist in the
  catalog and synthetic "DEMO ..." placeholders are no longer wanted.
- **Gap found and fixed while writing tests**: with no owning shipment, the existing per-shipment
  `DELETE /api/shipments/:id/schedules/:scheduleId` route (scoped `WHERE shipment_id=?`) could
  never reach an ownerless template at all — there was no way to remove a generated schedule once
  created. Added a dedicated `DELETE /api/schedules/:id` route, plus a delete button in the
  now-read-only catalog browser.
- `tests/schedule-catalog.test.js` rewritten around the new contract (50 assertions: ownerless
  creation, TSP leg derivation and the single-leg-array-is-still-direct edge case, usage/template
  provenance, the old link routes returning 404, catalog-first search priority over live/demo,
  and the toggle's on/off behavior) — full suite green (13 files, 516 assertions), clean build.
  Verified live end-to-end via a temporary Cypress spec: built a real 2-leg TSP schedule through
  the Configure Legs modal, confirmed it in the read-only catalog browser, found it via Add
  Sailing search on a real shipment tagged "Catalog", picked it and confirmed both SEA legs were
  created correctly with the right POL/hub/POD chain and `template_id` provenance, and confirmed
  the Settings toggle renders checked by default.

## Recent changes (v0.53.0 "Voucher")
- **TKT-O4B0IB (Office-Level Email Distribution) verified already shipped, closed rather than rebuilt.** Cross-checking the Kanban pipeline against actual code found every piece of this epic's 3-story scope already live from earlier releases: per-office SMTP config (`office_mail_settings`, `lib/mailer.js`, `routes/office-mail.js`, `OfficeMailSettingsModal` in `OfficePage.jsx`), a test-send route, and the embedded compose-and-send-with-signed-PDF flow (`POST .../documents/:docId/send-email`, `SendDocumentEmailModal` in `App.jsx`) — all already covered by `tests/office-mail.test.js` (31 assertions, re-run and confirmed green as the actual verification step). Epic + 3 stories (`TKT-R7UZT5`, `TKT-B8K7ZL`, `TKT-LRZTEJ`) marked Done.
- **Invoice Reversal / Debit-Credit Note workflow (`TKT-DUADU3`)**, logged since v0.49.0 — SELL-side only, a direct scoping decision that also happens to be the only thing structurally possible: a generated FR01/FR02 invoice is already built exclusively from SELL cost lines (`generateInvoices()`), so reversing one can only ever reverse SELL lines. A new "↩ Reverse" action on a **confirmed** FR01/FR02 invoice (Invoice Entry page) does three things: creates negative-amount, already-`posted` adjusting SELL cost lines mirroring the original charge lines (`source: 'reversal'`, a new `CostLineRow` badge — a reversal is a final, already-recorded accounting event, not something needing a separate manual posting step afterward); marks the original invoice `status: 'voided'` (struck-through label + gray "Voided" pill, the Reverse action itself hidden once already reversed); and generates a new, dedicated `CN01` "Credit / Debit Note" `DOC_TYPES` entry — deliberately **not** a reuse of `FR02` ("Amendment" and "Reversal" are different documents with different accounting meaning) — linked back to the original via a new symmetric `shipment_documents.related_doc_id`.
- **Precise reversal scoping via a new `source_cost_line_ids` column**: `generateInvoices()` previously had no record of exactly which cost-line IDs a given FR01/FR02 was built from — it just re-filtered live SELL lines by `containerId` at generation time. Now every FR01/FR02 generation captures and persists that exact id list (JSON array), so a later reversal negates precisely the lines that were actually invoiced rather than re-deriving from whatever SELL lines happen to still exist. An invoice generated **before** this shipped (no value in the new column) falls back to a live container-scoped SELL-line filter — the same "no migration, old rows get a sensible fallback" precedent this codebase uses throughout (VGM/CY cutoff fields, sequence floor, etc.).
- **New `POST /api/shipments/:shipmentId/documents/:docId/reverse`** (`routes/shipment-ops.js`, gated `admin`/`operator` — same tier as the cost-line `postGate`, since this creates locked financial records and voids a confirmed invoice) does the cost-line creation + original-doc voiding; `PATCH /api/documents/:docId` gained a `voided` status value and an independent `relatedDocId` field. The `CN01` document itself is built and uploaded **client-side** (`ShipmentAccountingInvoicesPage.jsx`'s new `handleReverse`, chaining `reverse` → `buildCreditDebitNoteHtml` → `documents.generate` → two `documents.patch` calls to complete the symmetric link) — matching this codebase's established client-builds-HTML/server-signs-and-stores split for every other generated document, not a new pattern.
- New `tests/invoice-reversal.test.js` (20 assertions: full reverse flow, draft/non-invoice/already-voided rejection paths, the `source_cost_line_ids` fallback) added to the `npm test` chain — full suite green, clean `vite build`. Verified live end-to-end via a temporary Cypress spec: generated and confirmed a real invoice, reversed it, confirmed the voided styling, the new `CN01` row with its "Reverses FR01-..." caption, and the negative `Reversal`-tagged posted cost line, all in the real UI.
- `TKT-DUADU3` marked Done.

## Recent changes (v0.52.0 "Manifest")
- **Completes epic `TKT-OYQFMB` (CargoWise-Aligned Carrier Booking Requirements)** — the
  outbound `POST /api/shipments/:id/edi-messages/booking-request` payload (`routes/edi.js`)
  was thin relative to what CargoWise/UN-EDIFACT IFTMBF actually expect, even though most of
  the missing data already existed on the `shipments` row this route already loads. Two of
  five child tickets shipped earlier (`TKT-0H9TSP` equipment summary, v0.39.0; `contractRef`/
  `rateSnapshotId`, v0.41.0) — this ships the remaining four (`TKT-5UNMUD`, `TKT-O57N94`,
  `TKT-U7T2QU`, `TKT-LAK8P4`), all in the exact same object literal.
- **New payload fields** (one-line additions, all pre-existing `shipments` columns): `vesselImo`,
  `cargoReadyDate`, `shipperName`/`consigneeName`/`notifyName`, `commodityCode`,
  `placeOfReceipt`/`placeOfDelivery` — null when unset, matching the existing
  `vessel`/`voyage`/`etd` convention.
- **New `dgCargo` DG declaration** — same size+type grouping the equipment summary already
  uses, plus IMDG class, sourced from **container-level** `is_dg`/`dg_class` only (consistent
  with every other DG signal in the app — the `ShipmentHeaderBar` DG badge, the
  `ShipmentContainersPage` contract-conflict chip — deliberately not also reaching into
  `container_packages`' independent, unsynced pack-level DG flags; that's a separately-scoped
  gap, not fixed here). **Corrected the ticket's own stated precedent along the way**: it said
  to mirror "ComplianceModal" for a DG warning — verified directly that's actually the
  OFAC/sanctions-screening modal, unrelated to DG. Used the real closer precedent instead
  (`ShipmentContainersPage.jsx`'s inline DG-conflict warning chip). Also reframed "warn if no
  DG declaration is included" — once this ships, `dgCargo` is **always** included automatically
  (same as `equipment` always is, never conditionally), so there's no real on/off state to gate.
  `ShipmentCarrierBookingDetailsPage.jsx` now shows a plain awareness chip ("N container(s)
  with DG cargo will be declared to the carrier") instead of a fabricated missing-declaration
  warning.
- **New booking-to-B/L traceability**: `carrier_bookings.bl_document_id` (nullable FK to
  `shipment_documents`) + `PATCH /api/shipments/:id/carrier-booking/link-bl-document`. Confirmed
  `shipments.bl_number` is free-text with zero connection to any generated document, and a
  shipment can have multiple `BL01` document rows (drafts, amendments) with no "current" flag —
  linking needs a real pick-one UI, not an auto-link. New "Link B/L Document" picker on
  `ShipmentCarrierBookingReviewPage.jsx`; the linked filename (with a download link) surfaces in
  `CarrierBookingsTable.jsx`'s shared expanded-detail view, visible from both Details and Review
  since that component is already shared between them.
- `tests/carrier-booking.test.js` gained 30 new assertions (129 → 158) covering all four
  tickets — including a real bug caught in the **test itself**, not the route: a wrong-shipment
  link attempt correctly returns 404 ("not found in this scope"), the test had wrongly asserted
  400 (that code is reserved for a right-shipment-wrong-doc-type rejection). Full suite green
  (797 assertions across 12 files), clean build.
- Epic `TKT-OYQFMB` and its 5 child tickets (`TKT-0H9TSP`, `TKT-5UNMUD`, `TKT-O57N94`,
  `TKT-U7T2QU`, `TKT-LAK8P4`) marked Done.

## Recent changes (v0.51.0 "Signet")
- **Signed PDF Document Generation (`TKT-YOFYFZ`)** — prerequisite for the coming Office-Level Email Distribution epic (`TKT-O4B0IB`), and valuable standalone. Every generated document (Bill of Lading, Commercial Invoice, Packing List, loading/service docs, freight invoices, ...) was built as an HTML string entirely **client-side** and uploaded as-is (`mimeType: "text/html"`) — no proof a file actually came from CargoDesk beyond trusting the filename.
- **Document generation now happens server-side**: `lib/pdf-signing.js` (new) renders the same client-built HTML string to a PDF via `puppeteer-core` driving a real installed browser (`executablePath` resolved via `PDF_BROWSER_PATH` env var first, then an OS-appropriate fallback list — never a hardcoded dev-machine path), then signs it with a genuine, tamper-evident **CAdES-detached CMS/PKCS#7 signature** (`node-forge` for the self-signed cert/keypair, `@signpdf` + `pdf-lib` for the actual signing). Realistic ceiling for a self-signed cert is basic B-B (not PAdES-LT, which needs OCSP/CRL/timestamp infra tied to a real CA) — shows as valid-but-untrusted-issuer in a reader's own signature panel, the accepted tradeoff.
- **New `org_signing_certs` table** holds the signing key — deliberately **not** `app_settings`, which `GET /api/settings` already returns in full plaintext to any authenticated user (confirmed: that's how `ai_api_key` leaks today). Bootstrapped once at server startup (same IIFE idiom as `seedAdmin`); only one `active` row at a time.
- **`verifySignedPdf` (new, in `lib/pdf-signing.js`)**: `node-forge`'s own `pkcs7` module can *build* CMS signatures but throws `"PKCS#7 signature verification not yet implemented"` on verify — confirmed directly, not assumed. Reimplements the two checks a real verifier does: the RSA signature over the DER-serialized `authenticatedAttributes` SET (re-tagged from the storage `[0] IMPLICIT` wrapper per RFC 2315, mirroring forge's own `sign()` internals in reverse), and that SET's `messageDigest` attribute matching a fresh SHA-256 of the actual signed byte range (`@signpdf/utils`'s `extractSignature`) — the second is what actually proves tamper-evidence; the signature itself stays "valid" for the original attributes even after the content changes.
- **New additive route** `POST /api/shipments/:id/documents/generate` (`routes/shipment-ops.js`) — the existing plain `POST .../documents` upload route is untouched, still used by the 3 raw-file-attachment call sites (`App.jsx` `handleUpload`, `GenericServicePage.jsx`, `LoadingServicePage.jsx`), which are **intentionally never signed** — signing a file CargoDesk didn't author would misrepresent who generated it.
- All **4 real HTML-generation call sites** switched to `api.documents.generate` (new `src/api.js` method): `App.jsx`'s `GenerateDocumentModal.handlePreview` (all `DOC_TYPES`), `LoadingServicePage.jsx`, `GenericServicePage.jsx`, `invoiceGenerator.js`'s `upload` closure. Generated filenames now end `.pdf` instead of `.html` (server does the swap); already-stored `.html` documents are left alone, no retroactive reprocessing.
- **Fixed stale UI copy** found in the process: `GenerateDocumentModal` still said *"Opens in a new window — use your browser's Print dialog to save as PDF"* and had a "Preview / Print →" button — both leftover from the old client-side-only flow. Now: *"Generates a digitally signed PDF and saves it to Documents"* / "Generate →".
- New `tests/document-signing.test.js` (16 assertions: generation, `.html`→`.pdf` filename swap, download, full signature verification including a real tamper test — flip one byte in the signed content, confirm `integrity` flips from `true` to `false` — and confirms the plain upload route is unaffected). Full suite green. Verified live via CDP end-to-end: generated a real Bill of Lading through the actual UI, downloaded it through the real endpoint, and independently verified its signature — genuinely valid, and genuinely broken by tampering.
- New dependencies: `puppeteer-core`, `node-forge` (pinned `>=1.4.0` — real disclosed CVEs in ≤1.3.1), `pdf-lib`, `@signpdf/signpdf` + `@signpdf/signer-p12` + `@signpdf/placeholder-pdf-lib` + `@signpdf/utils`.
- Two real pre-existing bugs found and fixed live before this epic (user-reported, unrelated to signing): **(1)** the New Shipment draft form's SEA leg row never visually updated after "Apply sailing to SEA leg" — `LegsTable`'s internal `legs` state only synced from the `draftLegs` prop once at mount, so an external mutation (Apply Sailing, the contract-driven bulk carrier-code sync) never reached the table's render state; fixed by adding `draftLegs` to the sync effect's own dependencies. **(2)** the Schedules tab flashed "No legs yet" instead of a loading spinner while its initial fetch was in flight; `LegsTable` had no distinct loading state — added one. See v0.50.1/v0.50.2 below.
- Also found (not fixed — out of scope, flagged only): two harmless **dead-code duplicates** in `server.js` — an old inline `/api/shipments/:id/events` handler (line ~2930, bare-array shape) shadowed by the real one in `routes/shipments.js` (paginated `{results,...}` shape, actually reachable), and similarly for the old inline `/api/shipments/:id/documents` / `/api/documents/:docId/download` handlers (shadowed by `routes/shipment-ops.js`'s versions). Neither executes; both are leftover from when these routes were extracted into dedicated route files.
- Epic `TKT-YOFYFZ` marked Done. Logged, not yet started: `TKT-O4B0IB` Office-Level Email Distribution (per-office SMTP config, embedded compose-and-send with the now-signed PDF auto-attached) — explicitly depends on this epic, 3 stories already logged (`TKT-R7UZT5`, `TKT-B8K7ZL`, `TKT-LRZTEJ`).

## Recent changes (v0.50.2 "Declaration")
- Fixed a real gap found live while testing the New Shipment form: the Schedules tab's Route Legs table had no distinct loading state — while its initial `GET .../legs` fetch was in flight, it showed the exact same "No legs yet — add one below." placeholder as a genuinely empty shipment. Added a `loading` state gated on that fetch, rendering the existing `Spinner` component. Verified via CDP with the network throttled: spinner shows correctly, no empty-state flash.

## Recent changes (v0.50.1 "Declaration")
- Fixed a real bug found live while testing the New Shipment form, direct user report: after picking a sailing and clicking "Apply sailing to SEA leg", the toast reported success but the SEA leg row never visually updated. `LegsTable` (`ShipmentFormPage.jsx`) keeps its own internal `legs` state for rendering, only synced from the `draftLegs` prop once at mount (effect keyed on `shipmentId`, which never changes during draft creation) — any external draft mutation updated the parent's `draftLegs` but never reached the table's own render state. Fixed by adding `draftLegs` to the sync effect's own dependencies (safe from feedback loops — the table's own edits pass the same array reference back down, which the effect correctly ignores).

## Recent changes (v0.50.0 "Declaration")
- **Epic 3 of the FCL-completeness roadmap — and its final epic: Customs & Regulatory Filing (`TKT-XW6TQK`)**, completing the sequence started with Party/Organization Model (v0.48.0) and Structured Commodity/Cargo Line Items (v0.49.0). Previously `CD01` "Customs Declaration" was a static generated document — no filing entity, status, or confirmation-number tracking existed anywhere; it was paperwork, not a filing.
- **New `customs_filings` table** mirrors `carrier_bookings`/`routes/edi.js` closely, minus the archive/supersede machinery — not needed here, since a shipment can independently need one AES/EEI export filing and one ISF/AMS import filing (two things that coexist, not something a carrier change supersedes). `UNIQUE(shipmentId, filingType)`, not `UNIQUE(shipmentId)` alone, lets both live as independent rows. **Reuses the existing `edi_messages` table** for submission/response messages rather than a new one — every row this epic inserts sets `correlation_id = filing.id` so two filings sharing one physical table still get independently filterable threads; `EdiMessageList.jsx` works unchanged for the new thread type (one additive `EDI_STATUS_COLOR` key, `accepted`).
- **SCOPE IS EXPLICITLY SIMULATED/MOCK ONLY** — no real government EDI integration, matching the carrier-booking Test Tools precedent exactly; a direct scope decision made up front and not revisited.
- **New Customs Filing page** (Details/Review tabs, nested in the shipment sidebar's "Booking & Routing" group next to Carrier Booking) renders **two side-by-side cards** — AES/EEI (Export) and ISF/AMS (Import), not a type-switcher, since a shipment may only ever need one. Each card sources its broker from the Epic 1 `shipment_parties` data and its cargo rollup from the Epic 2 `container_packages` value data. **Nav-gated** (`CustomsFilingGateModal.jsx`, mirrors `CarrierBookingGateModal.jsx`'s exact blocking pattern — `hideClose`, no dismiss path) until the shipment has at least one Customs Broker role assigned **and** one priced cargo line; each card's own "Create Filing" button additionally requires *that card's own* specific broker role (disabled + inline hint otherwise).
- **Lifecycle**: Draft (explicit "Create Filing" — deliberately no auto-materialization the way `ensureBookingCreated` auto-creates carrier bookings, since a shipment may only ever need one filing type and auto-creating both the instant preconditions are met would be presumptuous) → Filed (Submit action on the Details card, generates a `filing_reference`) → Accepted/Rejected (Test Tools' new **"Filing Simulator"** tab, mirroring the Message Simulator's exact shape — pick a Filed item, Accept with an optional confirmation number or Reject with an optional reason). A Rejected filing can **Reset to Draft** on the Review card for resubmission, generating a genuinely new reference on the next Submit (not reusing the rejected one).
- New `tests/customs-filing.test.js` (39 assertions: full Draft→Filed→Accepted/Rejected lifecycle, duplicate-filing-type rejection, two filing types coexisting independently on one shipment, reset-then-resubmit produces a new reference, 409s on every invalid status transition, cross-shipment listing) — full suite green, zero regressions. Verified live via CDP end-to-end, twice: once through Draft→Filed→Accepted with a real confirmation number correctly displayed on the Review tab, once through Draft→Filed→Rejected→Reset with a custom rejection reason, confirming the gate itself blocks/unblocks correctly as broker/cargo preconditions change.
- Epic `TKT-XW6TQK` and its 3 stories (`TKT-QRNGK9`, `TKT-AMXWYL`, `TKT-F109XI`) marked Done — this completes the full FCL-completeness roadmap (Epics 1-3, v0.48.0 → v0.50.0).

## Recent changes (v0.49.0 "Appraisal")
- **Epic 2 of the FCL-completeness roadmap: Structured Commodity / Cargo Line Items (`TKT-P3ASH1`)**, second of the 3-epic sequence (Party model → Cargo line items → Customs filing). Cargo detail was container-level only — one HS code + free-text description per container, plus the v0.46.0/v0.47.0 pack-tree with no value/currency/per-item HS code. Confirmed via direct read: `buildCommercialInvoiceHtml` rendered one row per container with `Declared Value` **hardcoded to a literal em-dash** — no real value anywhere in that document, just a placeholder.
- **`container_packages` gains `unit_value`/`currency`/`hs_code`** (a per-item override of the container's own HS code — blank means inherit) **and a write-time-precomputed `unit_value_usd`** — same `amount_usd`-at-write-time idiom already used for `contract_rates` (`saveRates`/`toUsd`), so the cargo value rollup and generated documents are pure sums over already-USD numbers, no live FX call at read time. `unit_value` stays `NULL` (not `0`) when nothing's entered — "$0" and "not priced yet" stay distinguishable. New shared `CURRENCIES` list (`src/tokens.js`).
- **`PackageDetailForm`** (`ContainerPackagesPanel.jsx`) gains Unit Value / Currency / HS Code fields — HS Code placeholder shows the container's own code (`"Container default: 8471.30"`) when left blank.
- **Cargo value rollup** (sum of `quantity × unitValueUsd`, same any-depth flattening the shipped Description of Goods rollup already uses) surfaces two places: a badge next to "Description of Goods" on the Cargo page, and a new **"Cargo Value"** field on the persistent `ShipmentHeaderBar` (visible on every sub-page).
- **Commercial Invoice (CI01/CI02) and Packing List (PL01) now render one row per pack item** (any depth, real Declared Value, real grand total) when a container has a pack-tree breakdown — falling back to today's exact single-row-per-container output when it doesn't (verified byte-identical on a container with zero pack items in the same shipment).
- **Bug found and fixed during CDP verification**: `ShipmentHeaderBar` is mounted once in `App.jsx` and never remounts on navigation, so its Cargo Value fetch only ever fired once at mount and never noticed a pack item being priced afterward on an already-known container (adding an item live left the header stuck showing "—" until a hard reload). New `src/cargoValueBus.js` (same pub-sub shape as `servicesBus.js`) lets `ShipmentContainersPage` signal the header to refetch immediately after every package save/delete.
- `tests/container-packages.test.js` extended with 11 new assertions (value/currency/HS round-trip, null-not-zero when unpriced, clearing a value back to blank, negative-value rejection) — 46 total, full suite green, zero regressions. Verified live via CDP end-to-end: added a priced item with an HS override, confirmed the container badge and the header's Cargo Value field both update immediately (the exact bug above, confirmed fixed), generated a real Commercial Invoice and Packing List and confirmed real per-line rows plus the byte-identical fallback row for an untouched container on the same shipment.
- Epic `TKT-P3ASH1` and its 3 stories (`TKT-PV5P5L`, `TKT-NSTDKF`, `TKT-LUNODU`) marked Done. Also logged (not yet scoped into a version): `TKT-DUADU3` invoice reversal/debit note workflow, `TKT-SLIRP9` document distribution channels (email/EDI/API) — both captured from a direct request, deliberately left unversioned pending prioritization.

## Recent changes (v0.48.0 "Muster")
- **Epic 1 of the FCL-completeness roadmap: Flexible Party / Organization Model (`TKT-5XFCAP`)**, first of a 3-epic sequence (Party model → Structured Commodity/Cargo Line Items → Customs & Regulatory Filing), per direct prioritization. A shipment previously had exactly 4 hardcoded party-role columns (`shipper_id/name`, `consignee_id/name`, `notify_id/name`, `principal_id/name`) — no way to record a Forwarder, Customs Broker, Trucker, Bank, Insurance Provider, or Agent without adding a new column per role. New `shipment_parties` table (`role`, `customer_id`, `customer_name`, `UNIQUE(shipment_id, role)`) adds a generic, extensible mechanism **alongside** the existing 4 (untouched — high blast radius, not broken, not in scope).
- **Fixed, curated role list** (`ADDITIONAL_PARTY_ROLES` — two copies, `src/tokens.js` + `server.js`, same split as `BOOKABLE_CARRIERS` since frontend/backend don't share a module): Forwarder, Customs Broker (Export), Customs Broker (Import), Trucker (Pre-carriage), Trucker (On-carriage), Also Notify Party, Bank, Insurance Provider, Agent. Customs Broker is deliberately split Export/Import — each shipment can only hold one party per role, and the two are routinely handled by different brokers; also a direct setup for the upcoming Customs & Regulatory Filing epic.
- **Backend**: `GET/POST/PUT/DELETE` on `/api/shipments/:id/parties` and `/api/shipment-parties/:id` (`routes/shipments.js`), mirroring the existing `container_packages` CRUD pattern exactly — the `UNIQUE(shipment_id, role)` constraint is enforced server-side (`isUniqueViolation`), not just filtered out of the picker UI client-side.
- **New `AdditionalPartiesPanel.jsx`** (`src/components/shared/`), rendered below the existing 4-card `PartiesOfficesPanel` on the Parties & Offices page — a dashed "＋ Add Party" affordance reveals a role picker (limited to unassigned roles) + `CustomerCombobox`, each row gets inline reassign (✎) and remove (×). Follows `ContainerEventsPanel.jsx`'s idiom (a variable-length list with add/remove per row) rather than either of the two existing party sub-patterns on that page — a fixed-set modal doesn't fit a variable-length list, and a bare inline `<select>` can't search customers.
- **Document surfacing is additive-only** — every touch point falls back to today's exact behavior when no matching role is assigned: **Insurance Certificate (IC01)** now prefers the assigned Insurance Provider over the Shipper for "Assured / Insured Party"; **Customs Declaration (CD01)** surfaces Customs Broker (Export)/(Import) as conditional detail rows; **Pickup/Delivery Plans (PU01/DL01)** surface the matching Trucker party (`buildLoadingPlanHtml`, gated on `planLabel` so Loading/Unloading Plans render byte-identical to before). `GenerateDocumentModal.handlePreview` (`App.jsx`) and `LoadingServicePage.jsx`'s own generate action both now fetch `api.shipmentParties.list()` unconditionally alongside their existing shipper/consignee fetches.
- New `tests/shipment-parties.test.js` (20 assertions, added to `npm test`): create/list, invalid-role rejection, duplicate-role rejection enforced server-side (not just client-side), reassign, delete-then-recreate-the-same-role, 404s on bogus ids. Full suite green with zero regressions. Verified live via CDP end-to-end on a real shipment: added an Insurance Provider party, confirmed it survives a full page reload, reassigned a second (Agent) party to a different customer, removed it, then generated a real Insurance Certificate through the Documents UI and confirmed it shows the assigned Insurance Provider instead of falling back to the Shipper.

## Recent changes (v0.47.2 "Consignment")
- **Fixed a real gap in `ServicesPanel.jsx`** (Overview page's Export/Import Services dashboard), direct user report with a screenshot: once a service (VGM, Pickup, Loading, ...) was requested, there was no way to add or change its vendor/office afterward — `ServiceRow` only ever offered Confirm/Complete, Cancel, and Delete. Since the Office picker in the Request Service form is optional, a service left blank at request time (very common — "No vendor set" shown in the row) stayed that way forever with no path to fix it. The backend (`PATCH /api/shipments/:shipmentId/services/:id`, `routes/shipment-ops.js`) already supported updating `vendorId`/`vendorName`/`officeId`/`notes` generically — this was purely a missing frontend entry point. Added an Edit (pencil) button to every service row that reopens `ServiceForm` (previously create-only) now also in an edit mode — accepts an `init` prop, pre-fills every field from the existing service (including falling back to the "Other" option + prefilling the specify-service field if the saved `serviceType` is a free-text value not in the current dropdown list), title/save button read "Edit ... Service"/"Save Changes", and saves via `api.services.update` instead of `create`. Verified live via CDP: edited a VGM service showing "No vendor set", picked the Rotterdam office, saved, confirmed it persisted via the API.

## Recent changes (v0.47.1 "Consignment")
- **Fixed a real layout bug on the redesigned Containers page**, direct user report: "we're missing the buttons and controls at the bottom of the page, outside of the table container." The two-panel tree+detail box (`ShipmentContainersPage.jsx`) had a fixed `height: 560` with the right detail panel getting its own `overflowY: auto` — `ContainerForm`'s own Save/Cancel buttons and the Description of Goods section's "+ Add Package" button sat at the *end* of that panel's content, so they were buried inside a small nested scroll box rather than reachable by the page's own scroll. Fixed: the outer two-panel box no longer has a fixed height; only the left tree gets a capped `maxHeight: 640` with its own internal scroll (for the many-containers edge case), while the right panel has no scroll of its own and just flows naturally in the page, matching how every other page in the app already behaves. Verified live via CDP — scrolling the actual page (not a nested box) now reaches Cancel/Update Container and + Add Package correctly.

## Recent changes (v0.47.0 "Consignment")
- **Cargo Manifest & Container Details Redesign (TKT-OTKNJN)**, from a user-drawn concept sketch (containers as a tree fanning out into pallets, a detail panel with Marks & Nos. and Description of Goods). `ShipmentContainersPage.jsx` rebuilt from a flat container table + a separate "Cargo Manifest" modal-per-container into one page: left tree spans every container in the shipment as root nodes, fanning out into each one's typed pack breakdown (`container_packages`, however many pallets/cartons the operator configures — not fixed to one); right panel shows either the full `ContainerForm` (container selected) or the pack detail form (pallet/carton selected). `ContainerPackagesPanel.jsx` was trimmed down to just its reusable building blocks (`NavRow`, `PackageDetailForm`, both now named exports) — its old single-container tree/default-export component is gone, absorbed into the new page's own multi-container tree.
- **Marks & Nos.** — a real packing-list/BOL field that never existed on `containers` (new `marks_and_numbers` column) — added to `ContainerForm`'s Cargo Details section, next to Cargo Description.
- **Description of Goods** is *not* a new field — it's a read-only rollup of the selected container's own pack items (`container_packages.description`, already meant "what's on/in this pack" per v0.46.0), shown as "Item 1", "Item 2", ... on the container's detail panel so the full manifest reads at a glance without drilling into the tree. A "+ Add Package" button there starts a new root pack item under that container.
- **DG classification extended from the container level down to the individual pack item** (`TKT-9VAD6R`) — `container_packages` gains `is_dg`/`dg_class` (mirrors the container's own fields exactly), surfaced in `PackageDetailForm` as a DG toggle + IMDG class picker (same `IMDG_CLASSES` list, same `BtnToggle` pattern as `ContainerForm`'s own DG section) and a small red "DG" badge in the tree row. A single DG pallet inside an otherwise clean container no longer forces the whole container to be flagged.
- **DG Compliance Address** (`TKT-DPLQTV`) — one reusable org-wide emergency-contact/compliance record (confirmed: FCL means one is enough, no per-office variant), plain `app_settings` keys (`dg_compliance_contact_name/phone/email/address`). New **Compliance** tab in Application Settings (`AppSettingsPage.jsx`, `TABS_BASE`), mirrors `SecuritySettingsPanel`'s exact shape. Pulled onto the DG01 Dangerous Goods Declaration's emergency-contact line (`buildDGDeclHtml`, `App.jsx`) in place of a hand-filled blank — falls back to the old generic CHEMTREC/CANUTEC text if the org hasn't filled in its own address yet.
- `tests/container-packages.test.js` extended with `marksAndNumbers`, `isDg`/`dgClass`, and `dg_compliance_*` settings round-trips (12 new assertions, 35 total in that file). Verified live via CDP: added a Pallet flagged DG Class 3 through the real unified tree, confirmed the DG badge + Description of Goods rollup, confirmed the Compliance settings tab saves and persists across reload.
- Epic `TKT-OTKNJN` and its Stories (`TKT-PI01TZ`, `TKT-9VAD6R`, `TKT-DPLQTV`) — logged in the app's own Kanban ahead of this work, per direct request — marked Done now that it's shipped.

## Recent changes (v0.46.1 "Stowage")
- **Three linked bugs, all reported live on SHP-JFULNY while a schedule was already assigned to it.** (1) **A freshly-added leg ("+ Add leg") was immediately locked/uneditable** — it defaults to `legType: "SEA"` (`ShipmentFormPage.jsx`'s `addLeg`), and `LegsTable` locked *any* leg typed SEA once a schedule existed (`locked={lockedSeaLegs && leg.legType === "SEA"}`), not just the schedule's own leg — so a brand new leg's Leg Type dropdown was disabled the instant it was created, and could never be switched to Pick-up/Delivery. Fixed: a SEA leg is only locked once it actually carries real vessel/voyage data (populated by `applySailingToLegs`) — `locked={lockedSeaLegs && leg.legType === "SEA" && !!(leg.vessel || leg.voyage)}`, same refinement applied to the confirm-remove modal's `isCascade` check.
- (2) **Removing that stuck, unconfigured leg cascaded into wiping the ENTIRE real schedule.** `ShipmentSchedulesPage.jsx`'s `handleLegsChange` compared raw SEA-leg *counts* before/after (`prevSeaLegCountRef`) — it couldn't tell a schedule-linked leg (real vessel/voyage) from a brand new blank one, so removing either tripped the same "unlink the schedule" cascade. Fixed: now tracks the actual leg *ids* that carry schedule data (`prevScheduledLegIdsRef`, a `Set`) and only cascades when one of those specific ids disappears — adding/removing an unrelated blank leg no longer touches the real schedule.
- (3) **Once a schedule really is unlinked, the header kept showing the stale vessel/ETD/routing forever**, for two independent reasons, both fixed: `syncShipmentFromLegs` (`server.js`) returned early (`if (!legs.length) return;`) when 0 legs remained, leaving the shipment row's `etd`/`eta`/`vessel`/`vessel_imo`/`voyage`/`routing_term` exactly as they were before every leg was removed — now clears them (`pol`/`pod`/`carrier_code` are left untouched, since those are shipment-level fields set independently at creation, not purely leg-derived). Separately, neither cascade path in `ShipmentSchedulesPage.jsx` ever called `onRefresh()` afterward — even with the backend now correctly cleared, the already-rendered `shipment` prop stayed stale until an unrelated reload. Both cascade sites now `await onRefresh?.()`. (Caught and fixed a related self-inflicted bug during this same pass: the `handleLegsChange` ref rename left one stale reference to the old `prevSeaLegCountRef` name in the `ContractAssignModal` carrier-change cascade, which would have thrown at runtime — renamed consistently.)
- **Carrier Booking stayed fully accessible with no schedule attached** — `ShipmentCarrierBookingPage.jsx`'s gate only ever checked "does a `carrier_bookings` row exist" (`booking === null`), which is correct for the create-time gate but was never re-checked afterward: a booking created while a schedule existed stayed permanently visible even after that schedule was later removed (deliberately, or via bug 2 above). Broadened per direct decision ("block entirely, with a message") to `if (booking === null || !hasSchedule)` — `hasSchedule` (same broadened SEA-leg-with-etd definition `ensureBookingCreated` uses server-side) is now re-evaluated on every render, not just once at booking-creation time.
- New `cypress/e2e/schedule-leg-cascade.cy.js` covers all three bugs end-to-end in a single spec, per direct request ("a dedicated test that would basically verify all 3 issues in one go") — add a leg while scheduled → assert it's editable → remove it → assert the real schedule survives → remove the real schedule leg → assert it correctly cascades, the header clears, and Carrier Booking is now gated. Also verified live via CDP against a real shipment scenario. (Note: the Cypress binary itself would not launch in this session's sandboxed environment even after a clean reinstall — `Cypress.exe: bad option: --smoke-test`, consistent with the sandbox rather than the spec; the spec is real, committed regression coverage for a normal environment/CI.)
- Also logged in the app's own Kanban (direct request): Epic `TKT-OTKNJN` "Cargo Manifest & Container Details Redesign" (scoping the next unified Containers+Cargo-Manifest page, per-pallet DG classification, and a DG compliance address setting — not yet implemented) with Stories `TKT-PI01TZ`/`TKT-9VAD6R`/`TKT-DPLQTV`, plus a retroactive Story `TKT-26C70U` under the existing `TKT-A5LUPD` epic for the v0.46.0 pack-types work.

## Recent changes (v0.46.0 "Stowage")
- **Container cargo manifest now supports a typed pack hierarchy**, direct request: "let's improve the cargo details by allowing the users to configure the details to deeper level where it can add for example pallets, and add boxes to the pallets... a container that loads 4 different pallets, 2 are topped with boxes, 1 is with metal sheets, and 1 is with bottles." The existing `container_packages` feature (arbitrary-depth self-referencing tree, TKT-EMFIBR) already handled the nesting but only via a free-text `description` field — no real "this node is a Pallet vs a Carton" distinction. Follow-up guidance pointed at two concrete references: "something with a tree structure... similar to how we have the test case repository. Look also at cargowise, [which] is supporting the pallets, and whatever is loaded on them."
- **New admin-maintained Pack Types registry** — `pack_type_definitions` table (`id, code, label, icon, sort_order, is_active, created_at`), seeded via migration with 9 defaults (Pallet 🟫, Carton 📦, Case 🗄️, Crate 🪵, Drum 🛢️, Box 📦, Bag 🛍️, Bundle 🎋, Other 📄). New `routes/pack-types.js` mirrors `routes/charge-codes.js`'s CRUD structure exactly (`GET /api/pack-type-definitions` public-read, `POST`/`PUT`/`DELETE` gated to `admin`/`operator`/`trade_manager`). New `src/pages/mdm/MdmPackTypesPage.jsx` mirrors `MdmChargeCodesPage.jsx`'s form/list pattern, registered in `App.jsx` at every touch-point Charge Codes already shows (`MDM_PAGES`, breadcrumb label map, `NavBtn` under Master Data, routing switch). Per direct answer to "where should the list of pack types live — a fixed default list, or admin-configurable?": **both** — sensible defaults out of the box, fully editable via Master Data on top.
- **`container_packages` gains one new nullable `pack_type_id` column** (plain `ADD COLUMN`, no backfill — existing rows simply show no icon, exactly as before). `description`'s meaning is now documented as *what's on/in the pack* (e.g. "Metal sheets", "Bottles of olive oil") rather than the pack's type — the type is `pack_type_id`. The three existing container-package routes (`POST /api/containers/:id/packages`, `PUT /api/container-packages/:id`, and their `DELETE` cascade — `routes/shipments.js`) gained a `packTypeId` passthrough; nothing else about their validation or cascade-delete behavior changed.
- **`ContainerPackagesPanel.jsx` rebuilt from an always-expanded boxed-card list into a two-panel tree + detail view**, deliberately mirroring `TestCasesPage.jsx`'s own folder tree (`NavRow`/`NavFolderNode`: collapsible ▾/▸ chevrons, per-node icon via the existing `AnyIcon` helper, quantity badge, selection highlight) rather than inventing a new interaction pattern. Left panel is the collapsible tree (with a "+" to add a root package); right panel is the selected node's detail form (Pack Type dropdown, Description, Quantity, Save/Add Sub-Package/Delete, or an empty-state prompt when nothing's selected). Per direct answer to "should selecting a node open a two-panel layout like the test case tree, or just expand/edit inline like today?": **two-panel**, full mirror. The hosting modal (`ShipmentContainersPage.jsx`'s Cargo Manifest button) widened from 520px to 820px to fit both panels comfortably.
- New `tests/container-packages.test.js` (23 assertions, added to `npm test`): Pack Types registry CRUD (seeded defaults present, create/update/delete a custom one), a typed Pallet+Carton tree round-trips `packTypeId`/`parentId` correctly through `GET .../packages`, and deleting the parent still cascade-deletes the child exactly as before typing existed. Verified live via CDP: added a Pallet root + Carton child through the real UI, confirmed collapse/expand and the Add Sub-Package/Delete actions work, confirmed the new Master Data page lists and manages the seeded defaults.

## Recent changes (v0.45.1 "Manifest")
- **Fixed a real loading-delay bug, direct user report** — "in the involved offices, there are loading delays, until the data is retrieved block the page with the loading spinner." `PartiesOfficesPanel` (`ShipmentDetailPage.jsx`, backs the "Parties & Offices" nav page) initialized its `offices` list to `[]` instead of `null` — during however long `api.offices.list()` took, every `OfficeInlineSelect` dropdown (EMO/IMO/Controlling) showed *only* its placeholder option, no real candidates at all, reading as "no offices configured" rather than "still loading" (the same `[]`-vs-`null` gap already fixed for `ServicesPanel`/the sidebar's Export-Import group in earlier releases). Now gated behind `if (offices === null) return <Spinner/>...`.
- **Generalized to the two other places already returning a bare `null`** (a blank flash, not a spinner) while loading, per the user's own framing ("generalize that behavior across the app... always displaying the information [complete], not having the user wait for bits and pieces"): `ShipmentCarrierBookingDetailsPage.jsx` and `ShipmentCarrierBookingReviewPage.jsx` now render a visible `Spinner` + label instead of nothing.
- **Deliberately did NOT touch `ShipmentSchedulesPage.jsx`**, despite it having the same `useState([])` pattern (`schedules`) feeding several derived values (`hasSchedule`, `canSearch`, `lockedSeaLegs`) directly off `schedules.length` in many places throughout an already-large, tightly-coupled component. Attempted the same null-gate fix, found it would require moving a `return` before hooks that are declared *after* `schedules` in source order (a real rules-of-hooks violation risk) and auditing every one of ~8 scattered `schedules.length`/`schedules.map` call sites for null-safety — reverted rather than risk a crash under time pressure. This is the one shipment sub-page still worth a dedicated pass if the same premature-render symptom shows up there.

## Recent changes (v0.45.0 "Manifest")
- **Pickup Service moved out of "Booking & Routing" and back into Export Services** as a regular child (direct request) — `genericExportTypes` (`App.jsx`) no longer filters `"Pickup"` out, and `bookingRoutingChildren`/`BOOKING_ROUTING_ROUTES` no longer special-case it. Delivery/Import Services are unchanged (still grouped under Booking & Routing) — only Pickup was asked to move. Verified live on the real shipment SHP-JFULNY: Pickup now renders under Export Services (labeled just "Pickup", matching its sibling generic service children), Booking & Routing shows only Schedules + Carrier Booking.
- **Sequence (Pickup/Delivery/Loading/Unloading's per-container plan, `LoadingServicePage.jsx`/`routes/shipment-ops.js`) now has a hard floor of 1** — a physical loading/pickup/delivery plan has no "0th" or negative position. Enforced server-side in the `PUT .../loading-plan/:containerId` route (`Math.max(1, parseInt(...) || 1)`, applied regardless of what the client sends — this route is shared by exactly these 4 service types, nothing else, so no per-type branching needed) with a one-time migration backfilling the 6 rows already saved as 0 before this rule existed. `mapLoadingPlanLine`'s own "no row yet" default also moved from `?? 0` to `?? 1` to match.
- **Client-side, correcting an out-of-range value is never fought or interrupted** — `LoadingPlanRow`'s `commitSequence` only clamps on blur/commit (the `onChange` handler still just tracks the raw typed string, so mid-edit the field can be cleared/retyped freely) and surfaces the correction via `toast.warning` rather than silently rewriting what the user typed. A real risk found during review and fixed in the same pass: the row's local `seq` display previously only resynced when switching to a different row (`useEffect` keyed on `line.containerId` alone) — after a clamped save round-tripped to the server, the input kept showing the user's original, now-stale entry instead of the corrected value. The effect now also depends on `line.sequenceOrder`/`line.notes`, so the display always reflects whatever's actually persisted once a save completes, without disrupting active typing (the prop only changes after blur, never mid-keystroke).
- Re-verified the v0.41.3 sequence→document propagation fix is still intact using **real CDP-simulated typing** (`Input.insertText` + real focus/blur, not synthetic DOM events, which don't reliably trigger React's handlers in headless testing) — confirmed a set sequence correctly propagates into both the generated document's displayed value and its row sort order end-to-end.

## Recent changes (v0.44.2 "Wayfinder")
- **`DEFAULT_SIDEBAR_ORDER` (App.jsx) updated to match the admin's own already-saved sidebar order** — confirmed by opening the real shipment SHP-JFULNY and reading its actual rendered order, cross-checked against `GET /api/settings`'s `shipment_sidebar_order` value: `shp-documents, shp-overview, shp-milestones, shp-conditions, shp-parties, shp-cargo, shp-booking-routing, shp-export-services, shp-import-services, shp-accounting, shp-history`. No visible change today (the saved `app_settings` override already took priority over the old hardcoded default via `reconcileSidebarOrder`) — this only matters for a fresh install or a cleared setting, which now starts from the intended order instead of the original v0.44.0 default.

## Recent changes (v0.44.1 "Wayfinder")
- **Carrier Booking — Details/Review cleanup**, direct user request with an annotated screenshot: the status badge + `BKG-` id shown next to each page's own heading was redundant with the identical info already on the current row of the new "Bookings on this Shipment" table (`CarrierBookingsTable`) sitting directly above it — removed from both `ShipmentCarrierBookingDetailsPage.jsx` and `ShipmentCarrierBookingReviewPage.jsx` (their now-unused local `StatusBadge`/`STATUS_COLOR` were dead code and deleted too — the Details page's "Awaiting carrier response" Pending banner, the one other consumer of that color, now just inlines the specific hex value it needs). The heading's font size (was 20px/800) is now matched to the table's own "Bookings on this Shipment" heading (14px/700) so the two read as one visual hierarchy instead of the page heading looking like an unrelated, bigger title floating above it.
- **New Contract & Customer card** on Carrier Booking — Details, between the route/vessel summary and the Equipment section: **Contract Number** (from the linked contract record via `api.contracts.get(shipment.contractId)` — Central only, since SPOT/Pending/Customer Own never have a linked record), **Reference** (the shipment's own `contractRef`, always present regardless of contract type), **Client** (the contract's own Named Account field — deliberately *not* the shipment's Shipper/Consignee, which are separate parties — falling back to an explicit `"No Customer"` string, per direct instruction, whenever there's no linked contract at all or a Central contract with no named account set), and **Commodity** (reusing the existing `CommodityDisplay` component, exported from `ShipmentDetailPage.jsx`, for visual consistency with the rest of the app rather than a bespoke lookup). Verified live via CDP against both cases (a SPOT shipment showing "No Customer", a Central contract showing its real named account) with no console errors.

## Recent changes (v0.44.0 "Wayfinder")
- **Admin-only drag-and-drop sidebar reordering** (`ShipmentDetailSidebar`, `App.jsx`, direct user request — "the current order of items is a bit wonky"). A new "⇅ Reorder" button next to the "EXPLORER" label (visible only when `isAdmin`, from `useAuth()`) toggles reorder mode: a flat, 11-item draggable list of every **top-level** nav block — `DEFAULT_SIDEBAR_ORDER` (module-scope const, above the component): `shp-overview, shp-conditions, shp-parties, shp-booking-routing, shp-cargo, shp-export-services, shp-import-services, shp-milestones, shp-documents, shp-accounting, shp-history`. Dragging and hitting Save persists the new order for **every user**, not just the admin doing the reordering. Deliberately scoped to only the top-level sequence — children within a group (Booking & Routing's Schedules/Carrier Booking/Pickup-Delivery, Accounting's Invoice/Cost/GP, each Export/Import Services type) stay in their existing fixed relative order and are hidden entirely while in reorder mode (only the 11 parent rows show, collapsed) — keeps the drag interaction to a simple flat list rather than an arbitrary tree, and prevents a child ever floating out to become a meaningless top-level item on its own (e.g. "Cost Entry" isn't a thing outside of Accounting).
- **Reuses the exact native HTML5 drag-and-drop pattern KanbanPage.jsx's column reorder already established** (`draggable`/`onDragStart`/`onDragOver`/`onDragEnd`, splice-and-reinsert on drop) rather than adding a DnD library — this codebase has no DnD dependency and didn't need one.
- **New admin-only `PUT /api/settings/shipment-sidebar-order`** (`routes/system.js`) — a dedicated, more tightly-gated route rather than folding into the existing `PUT /api/settings` (which also allows `operator`/`occ_bk`); stores the order as a JSON array under a new `shipment_sidebar_order` `app_settings` key (migration seeds it to `'[]'` — empty means "no override, use the default"). Reads go through the existing `GET /api/settings` every user already fetches once at the top-level `App` component (`appSettings` state) — passed down to `ShipmentDetailSidebar` as a prop rather than a second independent fetch.
- **`reconcileSidebarOrder(stored)`** (module-scope, `App.jsx`) reconciles a saved order against `DEFAULT_SIDEBAR_ORDER` on every render: keeps only ids that still exist today (drops anything since-removed), then appends any current id missing from the saved list at its normal default position — so a future new nav block introduced by other work always appears rather than silently vanishing just because an admin's saved order predates it.
- **Live nav rendering refactored from a hardcoded slice-and-splice sequence to a lookup-driven one**: a new `blockRenderers` map (one render function per `DEFAULT_SIDEBAR_ORDER` id) replaces the old `sectionsBeforeServices.slice(0,-1)` / booking-routing-insert / `.slice(-1)` / services-insert / `sectionsAfterServices` chain — the final render is just `effectiveOrder.map(id => blockRenderers[id]?.())`. Each block's own conditional visibility (Export/Import Services empty, Accounting hidden for `isTradeManager`) is unchanged, just relocated into its own renderer function.
- Verified end-to-end via CDP: default order renders identically to before this feature (no visual regression for anyone who hasn't used it), a simulated drag-and-save correctly reorders (moved "History" to the top), and the new order persists correctly across a full page reload (re-fetched from the server, not just local state).

## Recent changes (v0.43.0 "Reroute")
- **Carrier booking supersede rule broadened, direct user request.** `supersedeIfCarrierChanged` (server.js, renamed from `archiveIfSuperseded`) previously only auto-replaced an already-Cancelled/Rejected booking on a carrier change. Now it fires for **any not-yet-Confirmed booking**, `Pending` included — a real booking-request already sent, awaiting the carrier's response, gets auto-cancelled the moment the carrier changes, no manual Cancel/Reject step required first. The old booking is transitioned to `Cancelled` (forced, even if it was `Rejected`), a real cancellation EDI message goes out to it (same "notify only if something was actually transmitted" rule the manual Cancel action already follows — keyed off the OLD booking's own `carrier_code`, not the shipment's new one), then it's archived under its own `BKG-` id and a fresh `Created` booking takes its place under the new carrier. A **same-carrier** edit (new contract ref, a corrected sailing) explicitly persists the exact same `bookingID` forever — nothing archived, nothing new created; this is the other half of the rule and has its own dedicated test (`testSameCarrierPersistsId`). `ensureBookingCreated` now also broadcasts `booking_status_changed` whenever it creates a booking (previously silent at creation) — matters far more now that a carrier change can swap the live booking's own id out from under an already-open Details/Review tab.
- **The standalone History tab (v0.41.0) is gone** — folded back into a single new shared `CarrierBookingsTable` (`components/shared/`), embedded directly **above** both `ShipmentCarrierBookingDetailsPage.jsx`'s and `ShipmentCarrierBookingReviewPage.jsx`'s own existing content (not a third tab to click into). Lists every booking ever made on the shipment — the current live row pinned to the top with a "Current" badge, every archived row below it — self-fetching both `GET .../carrier-booking` and `GET .../carrier-booking-history` and merging them, with its own WS subscription (`booking_status_changed`/`new_edi_message`) so it refreshes live regardless of which page triggered the change. Click any row to expand inline: a superseded/cancelled row's expanded detail is pure read-only display ("Superseded — read-only record, nothing here can be edited") since there's nothing to act on — the current row's own Send/Confirm/Cancel actions are never duplicated inside the table, they're the content directly below it.
- Verified end-to-end against the exact scenario described: an HLCU booking auto-cancelled and archived, an MSCU booking created in its place, both visible in the same table on both tabs, confirmed live via CDP.

## Recent changes (v0.42.1 "Compass")
- **Removed "Haulage" from `SERVICE_TYPES` entirely** (user follow-up on v0.42.0: "Haulage is already covered by pickup and delivery and has a clear separation based on origin and destination") — rather than also restricting it to one side like VGM/Loading/Pickup or Unloading/Delivery, it was dropped outright: it was a generic, ambiguous both-sides duplicate of a distinction Pickup/Delivery already make directly (Pickup *is* the origin-side/export haulage arrangement, Delivery *is* the destination-side/import one, each with its own Merchant's-vs-Carrier's-Haulage `RoutingCard` awareness). Same no-migration precedent as the Loading/Unloading and Pickup/Delivery splits: the two real `shipment_services` rows already saved with `serviceType: "Haulage"` are untouched in the DB and keep displaying exactly where they always did (Overview's `ServicesPanel` reads `services` directly with no `SERVICE_TYPES` membership check — confirmed live via CDP, still shows vendor/office/status correctly) — they just no longer get a dedicated sidebar nav page/route now that `"Haulage"` isn't in the canonical list or `SERVICE_TYPE_ICON`.

## Recent changes (v0.42.0 "Compass")
- **Export/Import Services now restrict which service types can be ordered per side** (user-requested rework: "delivery and unloading are on the import side only, vgm only on the export side etc.") — previously the Request Service dropdown (`ServiceForm`, `ServicesPanel.jsx`) offered the identical full `SERVICE_TYPES` catalog regardless of `side`, so an operator could order "Delivery" under Export or "VGM" under Import, combinations that don't correspond to anything real. New `SERVICE_TYPE_SIDES` map (`shipmentServicePages.js`): `VGM`/`Loading`/`Pickup` → `["Export"]` (origin-side: weighing/loading the cargo, picking it up for the carrier); `Unloading`/`Delivery` → `["Import"]` (their destination-side mirror). Every other type — `Haulage` (pre- vs on-carriage), `Storage`/`CY Storage`/`Warehousing` (either end), `Customs Clearance` (export vs import declarations), `Fumigation` (either end depending on commodity/route), and the free-text `Other` — has no entry in the map and stays valid on both sides. New `serviceTypesForSide(side)` helper filters `SERVICE_TYPES` accordingly; `ServiceForm`'s dropdown options and its default-selected type both now derive from it instead of the unfiltered list. Nothing else needed to change — `App.jsx`'s `orderedTypesFor` only ever displays what's *already been ordered* (not what's orderable), so it correctly continues to work unmodified; `ALL_SERVICE_PAGES`'s full side×type combinatorial page-key set is deliberately left unrestricted too (a stray/legacy row under a since-restricted side, if one ever existed, should still be viewable, not lose its route). No data migration — matches the exact precedent the Loading/Unloading and Pickup/Delivery splits already established for this file.

## Recent changes (v0.41.3 "Logbook")
- **Fixed a real bug on the Pickup/Delivery/Loading/Unloading service pages** (`LoadingServicePage.jsx`, reported: the per-container Sequence value not being saved/propagated into the generated document) — traced to `handleGenerate` building the document from the component's own in-memory `lines` React state. A row's Sequence/Notes/Planned Date fields each save on blur via an async `PUT .../loading-plan/:containerId`; clicking "⚡ Generate {Plan}" immediately after editing a field could fire before that save's round-trip resolved and `setLines` applied the response, baking a stale value into the produced document even though the correct value would land in the database moments later. Confirmed both the backend PUT/GET round-trip and `buildLoadingPlanHtml`'s own rendering were already correct in isolation (verified directly) — the gap was purely this stale-closure race, not a persistence bug. Fixed two ways: (1) `handleGenerate` now calls `api.loadingPlan.list(...)` fresh immediately before building the document (`freshLines`, also written back via `setLines`) instead of trusting whatever `lines` happened to hold at click time; (2) the Generate button is now also `disabled` while `savingId !== null` (any row's save still in flight), closing the race at its source — a user physically cannot click Generate mid-save, not just get a document that recovers from it.

## Recent changes (v0.41.2 "Logbook")
- **Fixed a real misalignment on the New Shipment form** (`ShipmentFormPage.jsx`, Cargo section, Declared Value / Currency row) — `Currency` was a hand-rolled `<div>` + `<select>`, not the shared `Sel` primitive (`Inp`/`Sel`/`DatePicker`/`Textarea`, `components/primitives/Form.jsx`) every other field in the form uses. Two consequences: its label rendered as plain lowercase text instead of the standard uppercase/bold `Field` label style, and — since `Field`'s hint line only renders when a `hint` prop is actually passed — it had no hint at all, leaving its input shorter and vertically misaligned next to `Declared Value` (which does have one: "Customs / insured value of the goods"). Fixed by switching to `Sel` with a matching hint ("Currency the declared value is expressed in") — same component, same label styling, same label+hint-on-its-own-line structure (the v0.39.1 fix) as its sibling. Also cleaned up `tests/carrier-booking.test.js`: 4 of its 9 test functions (`testConfirmedPath`, `testRejectedPath`, `testManualPath`, `testAutoCreate` — the last creates 4 shipments) were missing their `DELETE` cleanup call entirely, alongside `testEquipmentSummary` from the same gap; all five now clean up after themselves. Also swept and deleted 65 already-orphaned scratch shipments this same gap had left behind in the dev DB across the session.

## Recent changes (v0.41.1 "Logbook")
- **Two more real gaps in the 0.41.0 carrier-booking-history fix**, found by re-checking the actual reported shipment (SHP-Y9E98X) after that release shipped — the fix worked, but only for the one trigger path it covered.
- **Gap 1 — Send/Confirm bypassed the archive check entirely.** `archiveIfSuperseded(shipment, existing)` (server.js) — the supersede check that used to live only inline inside `ensureBookingCreated` — is now a shared helper (exposed via `ctx`) applied at **three** call sites: `ensureBookingCreated` itself, `upsertPendingBooking` (`routes/edi.js`'s Send Booking Request handler), and the manual Confirm route. Both of those did a raw `UPDATE carrier_bookings SET ... WHERE id=?` on whatever row already existed, regardless of status — exactly what let a Cancelled/Rejected booking's own carrier/history still get silently overwritten the moment Send or Confirm was clicked again after the shipment's carrier changed. `upsertPendingBooking`'s update-in-place branch also now clears `cancelled_at`/`cancelled_by`/`cancel_reason` on a legitimate same-carrier resend (previously left stale, confusingly showing a "cancelled" reason on an active Pending booking). New test `testSupersedeViaSendBypass` (`tests/carrier-booking.test.js`, 12 assertions) covers both bypass points directly, including via a carrier-only `PUT /api/shipments/:id` edit that deliberately does NOT touch contract fields (so `ensureBookingCreated` never even runs) — the exact gap that let the original bug resurface.
- **Gap 2 — a contract/carrier change never touched an already-assigned schedule.** `ShipmentSchedulesPage.jsx`'s "Change Contract" flow (`ContractAssignModal`'s `onDone`) only ever auto-chained into the sailing search when `!hasSchedule` — if a schedule/SEA leg was already assigned and the operator picked a contract for a **different** carrier, the old leg's `carrierCode`/`vessel`/`voyage`/`contractRef` were left completely untouched, so Route Legs kept showing the old carrier forever, permanently disagreeing with the shipment's own (now-updated) one. Fixed: when the newly-picked contract's carrier differs from the shipment's current one and `hasSchedule` is true, auto-unlink the stale schedule first (same SEA-leg-removal-cascades-to-remove-the-schedule mechanism `handleLegsChange` already uses for a manual leg removal — every SEA leg, then every `shipment_schedules` row), toast `"Previous schedule unlinked — it was booked with a different carrier. Pick a new sailing below."`, then chain into the sailing search exactly like the no-schedule case already does. Verified live via CDP (Route Legs correctly clears to 0 rows, "Add Sailing" re-enables). This is frontend-only state logic — no backend route changes.
- Both fixes were applied directly to SHP-Y9E98X's own stale data as a one-time correction (cleared its booking's leftover `cancelled_at`/`cancelled_by`/`cancel_reason`, removed its stale CMDU leg + `shipment_schedules` row) so the real shipment reflects what either fix would have produced automatically.

## Recent changes (v0.41.0 "Logbook")
- **Carrier booking history** — fixes a real bug (SHP-Y9E98X): a shipment's schedule was changed to a new carrier and the old booking cancelled, but the booking kept showing the original carrier forever. Root cause: `carrier_bookings.shipment_id` is `UNIQUE` — once a row exists for a shipment it's the *only* record, permanently, regardless of status; `ensureBookingCreated`'s `if (existing) return;` never revisited it. Rewriting that row's carrier in place would be wrong anyway — a cancelled booking's carrier is a fact about what it actually was when cancelled. Right fix: let a **new** booking (own surrogate key) get created once the old one is Cancelled/Rejected and the shipment's carrier has actually moved on, while the old one survives as real, viewable history.
- **Additive data model, not a table rebuild.** SQLite can't drop a `UNIQUE` constraint via `ALTER TABLE` — a genuinely riskier migration class than anything else in this codebase's ~155 `ADD COLUMN`/`CREATE TABLE` migrations. Avoided entirely: new `carrier_booking_archive` table (same shape as `carrier_bookings` minus the uniqueness, plus `archived_at`/`archived_reason`). `carrier_bookings` itself, and every existing route touching it (send/simulate/confirm/cancel), is **completely untouched**.
- **`ensureBookingCreated` (server.js)** now checks, before its existing "row already exists, do nothing" guard: if the existing booking is `Cancelled`/`Rejected` **and** the shipment's current carrier no longer matches what that booking was created under, `archiveBooking()` copies it into `carrier_booking_archive` (keeping its own `BKG-` id, status, carrier, dates exactly as they were), deletes it from `carrier_bookings`, and falls through to create a fresh `Created` booking under the new carrier. Deliberately narrow — a same-carrier edit after cancellation (e.g. a date correction) does not spawn a new booking, and a **Confirmed** booking is never touched no matter what the carrier does afterward (a confirmation is a real commitment, not something to silently supersede).
- **New `GET /api/shipments/:id/carrier-booking-history`** (`routes/edi.js`) returns archived rows newest-first, through the same `mapCarrierBooking` (extended with `archivedAt`/`archivedReason`). New third **History** tab on `ShipmentCarrierBookingPage.jsx` (new `ShipmentCarrierBookingHistoryPage.jsx` — table of past attempts, click a row to expand full detail), alongside the existing Details/Review tabs; both of those now also show the current booking's own `BKG-` id next to its status badge (previously surfaced nowhere in the UI).
- **Booking-request payload** (`routes/edi.js`, already extended with an equipment summary in v0.39.0) gains `contractRef` and `rateSnapshotId` — the latter resolved via the exact same `shipment_rate_snapshots` lookup `importContractRates` already performs (`SELECT id ... ORDER BY generated_at DESC LIMIT 1`), reused rather than reinvented. `null` for SPOT/manual-contract shipments (which never get a snapshot — `createRateSnapshot` also returns `null` if the contract has zero `contract_rates` rows), a real id for a Central shipment that's had rates imported.

## Recent changes (v0.40.1 "Haulier")
- **Fixed `DatePicker`'s popover positioning** (`src/components/primitives/DatePicker.jsx`) — found while building the Pickup Service page: its calendar rendered `position:absolute` (relative to its own nearest positioned ancestor), so a `DatePicker` inside an `overflow`-clipped/scrolling container (the per-container plan table's horizontal scroller) got visually clipped to that container instead of floating over the page. Every other dropdown in this app (`PortCombobox`, `CarrierCombobox`) already uses `position:fixed` off the trigger's own `getBoundingClientRect()` for exactly this reason (see "Key patterns" below) — `DatePicker` was just never updated to match. Fixed the same way, recomputed on open and on scroll/resize while open. Also: the calendar keeps a fixed 272px width regardless of a narrow trigger's own width (previously would have inherited it had width been carried over — a table-cell date field is much narrower than a day grid needs), and right-aligns instead of left- when it would otherwise overflow the viewport's right edge.

## Recent changes (v0.40.0 "Haulier")
- **"Pickup/Delivery" split into "Pickup" and "Delivery"** (`src/shipmentServicePages.js`), same non-migration precedent Loading/Unloading's own split used — both now get `LoadingServicePage.jsx`'s bespoke page (`BESPOKE_SERVICE_TYPES`) instead of the generic placeholder. That component needed no structural change — already fully generic over `serviceType` — just two new label-map entries (`DOC_CODE_BY_TYPE`/`PLAN_LABEL_BY_TYPE`: `PU01`/`DL01`) and one new conditional card. `shipment_loading_plan_lines` and its routes (`routes/shipment-ops.js:416-455`) needed zero changes — already keyed by `service_id`/`container_id` with nothing Loading-specific baked in.
- **New Routing card** (Pickup/Delivery only, not Loading/Unloading): finds the shipment's own Pick-up (or last Delivery) leg via `findRoutingLeg` (new, `src/utils/carrierBooking.js` — shared rather than one page importing from another) and shows its door location, planned date, and whether it's **Merchant's Haulage** ("arranged by us" — the case this exists for) or **Carrier's Haulage** (a muted note that the carrier's already covering it, so the service may not be needed). `ServicesPanel.jsx`'s "Request Service" form also pre-selects Pickup/Delivery when that side's leg is Merchant's Haulage (a nicety, not required for correctness).
- **Sidebar reorganized: new "Booking & Routing" group.** Contracts & Schedules (previously a flat `SHIPMENT_SECTIONS` entry) and Carrier Booking (previously its own standalone promoted row) are now children of one new parent — same `NavRow` parent+children idiom Accounting already established, not new nav machinery. Pickup/Delivery join as children too, but only once actually ordered (mirrors Export/Import Services' own "only show if ordered" rule) — and are correspondingly *excluded* from the generic "Export Services"/"Import Services" groups (`genericExportTypes`/`genericImportTypes` in `App.jsx`, filtering out Pickup/Delivery specifically), which stay otherwise untouched (VGM, Haulage, Fumigation, Storage, CY Storage, Warehousing, Customs Clearance). Carrier Booking's Pending/Rejected sidebar badge moved down to its child row, logic unchanged.

## Recent changes (v0.39.1 "Tally")
- **Fixed a systemic form misalignment at its root** (reported: the VGM Weight/VGM Status row in the Add/Edit Container modal, `ContainerForm`, `ShipmentDetailPage.jsx`). The shared `Field` primitive (`src/components/primitives/Form.jsx`, underlying `Inp`/`Sel`/`DatePicker`/`Textarea` — used across essentially every form in the app) rendered its label and hint on one shared flex line; two side-by-side fields in a grid row with different combined label+hint text lengths would wrap to a different number of lines, pushing their inputs to different heights. Fixed by giving label and hint each their own line — hint length still varies the total height, but the label and hint no longer compete for the same line's width, which was the actual source of the unpredictable per-field height difference. Also fixed in the same pass: `Sel` never destructured or forwarded its `hint` prop to `Field` at all — every `Sel` field's hint text anywhere in the app was silently dropped before this fix (confirmed via VGM Status, which visibly gained its hint text after the fix). Both fixes apply automatically everywhere these primitives are used; not a per-modal patch.

## Recent changes (v0.39.0 "Tally")
- **Booking-request payload gains an equipment summary** (`routes/edi.js`, TKT-0H9TSP off the new CargoWise-Aligned Carrier Booking Requirements epic, `TKT-OYQFMB`) — previously `{pol, pod, carrierCode, etd, vessel, voyage, contractType}`, now also `containerCount` and `equipment: [{type, count, totalWeightKg, totalVolumeCbm}]`, grouped by `${size}${type}` (matching the "40HC"/"20GP" display convention used everywhere else) from the shipment's own `containers` table. `ShipmentCarrierBookingDetailsPage.jsx` shows the identical grouped breakdown next to the existing route/ETD card, so what the operator sees before clicking Send matches what's actually transmitted. `api.containers.list` (`src/api.js`) gained an optional params argument (`{shipmentId}`) to support this — existing no-arg callers unaffected.
- **Epic correction**: an earlier pass on `TKT-OYQFMB` flagged missing CargoWise-style consolidation (multiple shipments/customers combined onto one carrier booking) as a gap. That was wrong — this system deliberately does not use consolidations; what it has, correctly, is schedule sharing (`schedule_shipment_links`, v0.37.0), which is a solved and sufficient model here. The consolidation child ticket was deleted rather than left on the board to mislead a future pass.

## Recent changes (v0.38.1 "Waybill")
- **Bug fix: "has a schedule" was too narrow.** A real shipment (SHP-VSB0Z2) had a genuine contract and a fully-detailed 3-leg route (real POL/POD/ETD per SEA leg), but its legs had been filled in by hand directly in the Route Legs table rather than through Add Sailing/Schedule Generator — so no `shipment_schedules` row ever existed, and `ensureBookingCreated` (v0.38.0) never fired. Fixed by treating a SEA leg with a real `etd` as "has a schedule" too, not just a formal saved-sailing row (deliberately still requires `etd` specifically, not bare leg existence — `ShipmentFormPage.jsx` defaults every new leg to `legType SEA`, so nearly every shipment would otherwise qualify the instant a contract is added). `ensureBookingCreated` is now also called from `routes/shipments.js`'s leg create/update routes, not just the schedule-specific ones. A one-time startup backfill (`backfillCarrierBookings`, same idempotent-IIFE convention as `backfillPortCountryCodes`) swept every shipment against the corrected rule on first boot after this fix — created 19 bookings retroactively for shipments that already qualified.
- **`ShipmentCarrierBookingPage.jsx` no longer re-derives booking-readiness itself.** The bug above was really a symptom of duplication: the frontend and `ensureBookingCreated` each had their own definition of "has a schedule", and they quietly drifted apart. The page now gates purely on whether `GET .../carrier-booking` returns a row — trusting the backend as the single source of truth — and only computes its own contract/schedule checks to word the gate modal's message (getting that wrong shows an off explanation, never a wrong gate).

## Recent changes (v0.38.0 "Waybill")
- **Carrier bookings auto-create once contract + schedule both exist.** New `ensureBookingCreated(shipmentId)` helper in `server.js` (same shape as `autoCompleteMilestone` — idempotent, never overwrites an existing row) creates a `carrier_bookings` row in a new **`Created`** status the moment a shipment has both a contract (`contract_id` or `contract_ref`) and a schedule (`shipment_schedules` row), whichever lands second. Called from `routes/shipments.js`'s `PUT /api/shipments/:id` (contract assignment) and three spots in `routes/shipment-ops.js` (a normal schedule save, and both Schedule Generator paths — initial link and `POST /api/schedules/:id/link`). Sending a real booking request afterward still transitions `Created → Pending` through the pre-existing `upsertPendingBooking` — that function already treated "does a row exist" generically, so it needed zero changes.
- **`Created` replaces the old `Draft` fallback.** `booking?.status || "Draft"` used to be purely cosmetic — a frontend-only label with no real row behind it. Now a real row (and a real `BKG-` id) exists from the moment both preconditions are met, so `Created` is an actual persisted status, not a guess. Renamed in `ShipmentCarrierBookingDetailsPage.jsx`, `ShipmentCarrierBookingReviewPage.jsx`, and `TestToolsPage.jsx`'s `STATUS_COLOR` maps.
- **New `CarrierBookingGateModal`** (`src/components/shared/CarrierBookingGateModal.jsx`) blocks `ShipmentCarrierBookingPage.jsx` entirely (no tabs, no content) until both a contract and a schedule exist — modeled directly on the forced `ChangePasswordModal` pattern (`hideClose`, no backdrop dismiss — `Modal`'s backdrop has no `onClick` at all, so `hideClose` alone is sufficient — a single action button in place of Cancel/Close) rather than inventing a new blocking-modal convention. Its one button navigates to `shipment-schedules` (Contracts & Schedules).

## Recent changes (v0.37.1 "Almanac")
- **Carrier Booking is now in-page tabs, matching the original requirement** (which asked for tabs, not nav-bar children — v0.35.0 shipped it as a promoted parent nav row with two child rows, mirroring Accounting's pattern, which was the wrong shape). New `src/pages/ShipmentCarrierBookingPage.jsx` wraps the two existing, unchanged page components (`ShipmentCarrierBookingDetailsPage`, `ShipmentCarrierBookingReviewPage`) behind an in-page Details/Review tab row (same underline style as Test Tools' Message Simulator/Schedule Generator tabs). The sidebar (`App.jsx`) now renders a single "Carrier Booking" row — `bookingChildren` and its two child `NavRow`s are gone.
- **The two page keys and two-segment hash routes stay** (`shipment-carrier-booking-details`/`-review`, `shipments/:id/booking/(details|review)`) — not for the nav (which no longer needs them) but because the notification bell's Carrier Bookings section and Test Tools' "Open Review Page" button both still navigate straight to `shipment-carrier-booking-review`. `App.jsx`'s single render block now passes `initialTab` (`"review"` vs `"details"`) based on which key routed there; the merged page resolves that once on mount into local `activeTab` state. Switching tabs afterward does **not** rewrite the hash (matching Test Tools' tabs) — only the initial deep-link/nav-click target is hash-driven.

## Recent changes (v0.37.0 "Almanac")
- **`shipment_schedules` field completeness**: gained `vessel_imo` (a real IMO, resolved from the `vessels` registry — previously only free-text `vessel_name` existed, even though `shipments`/`shipment_legs` already had a proper `vessel_imo` column) and `atd`/`ata` (actual departure/arrival, alongside the existing `etd`/`eta` estimates). `mapSchedule` (`routes/shipment-ops.js`) extended accordingly.
- **Schedules can now be shared across shipments.** `shipment_schedules.shipment_id` still means exactly what it always has — "the shipment that originally saved this row" — so every existing owned-schedule flow (`ShipmentSchedulesPage.jsx`'s remove-then-save `commitSailing`, the PUT lockstep route, the CRD-vs-ETD guard that force-deletes a schedule on an unrelated field edit, Schedule History) is **completely untouched**. A new `schedule_shipment_links` table (`schedule_id`, `shipment_id`, `linked_at`, `linked_by`) lets *additional* shipments link to that same schedule without duplicating it — the deliberately additive alternative to a full ownership-model rewrite (which would have meant moving the FK onto `shipment_legs` and rewriting every one of those existing consumers). New routes: `POST /api/schedules` (standalone create, not nested under a shipment — takes `initialShipmentIds`, first becomes the owner, the rest become links), `GET /api/schedules` (catalog browse), `GET /api/schedules/:id/linked-shipments` (owner + links, same column shape as Space Configurations' existing Linked Shipments modal — `Shipment ID / POL → POD / ETD / Contract / TEU / Status` — reused rather than inventing a new one), `POST`/`DELETE /api/schedules/:id/link[/:shipmentId]`.
- **New Test Tools tool: Schedule Generator.** `TestToolsPage.jsx` gained its first tab row (Message Simulator | Schedule Generator, same underline style as `AppSettingsPage.jsx`'s tabs) now that it hosts two tools. Schedule Generator builds a schedule from the real Vessels/Ports/Carriers MDM registries (`VesselField`, `CarrierCombobox`, `PortCombobox` — no new picker components needed) instead of `mockSailings()`'s synthetic "DEMO ALLEGRO" placeholders, and can link the result to multiple real shipments in one action — each linked shipment's SEA leg is synced immediately server-side (`pushScheduleToLeg` in `routes/shipment-ops.js`), creating one from scratch if the shipment doesn't have a SEA leg yet (guards against the exact routing-table bug fixed in v0.35.1, reintroduced-and-caught in this new code path during implementation).
- **New header shortcut icon** (`src/App.jsx`'s `Header`, next to the Home button) jumps straight to Test Tools — reuses `IconBaseStation` (same icon as the Integration Board sidebar entry) rather than a new icon language. The sidebar entry stays; this is an additional fast path, not a replacement.
- **Incidental cleanup**: `applySailingToLegs` — already duplicated between `ShipmentSchedulesPage.jsx` and `ShipmentFormPage.jsx` — was extracted (the live-shipment version only) to `src/utils/applySailingToLegs.js`. `ShipmentFormPage.jsx`'s own draft-legs version stays local since it operates on an unsaved shipment's client-side state, a genuinely different case.

## Recent changes (v0.36.0 "Beacon")
- **Startup migration failures are no longer silent.** `server.js`'s migration loop wraps ~155 statements (109 `ALTER TABLE ADD COLUMN`, which SQLite has no `IF NOT EXISTS` guard for) in a single `try/catch` — "duplicate column name" on every restart after the first is the expected, harmless case, but any genuine failure (syntax error, wrong type, locked db) used to vanish into that same silent catch. Now only the duplicate-column case is swallowed; anything else is `console.error`'d immediately and collected into `ctx.migrationFailures`, exposed via `GET /api/health`'s new `migrations: {failed, details}` field and rendered as a red banner in the System Health modal (`HealthModal`, `App.jsx`) when non-zero.
- **Notification bell gains a Carrier Bookings section** (`Header` component, `App.jsx`): a Rejected booking, or a Pending one with no carrier response after a fixed 48h (`STALE_BOOKING_HOURS` — not yet a configurable setting), now shows up the same way an over-threshold allocation does, sorted worst-first, with its own dismiss-until-tomorrow control. Clicking a row navigates straight to that shipment's Carrier Booking Review page. No new fetch — reuses the already-loaded `shipments` list, which gained `bookingRequestedAt` (alongside the `bookingStatus` added in v0.35.1) via the same `carrier_bookings` LEFT JOIN on `GET /api/shipments`.
- **`KanbanPage.jsx` is now `React.lazy()`-loaded** instead of a static top-level import in `App.jsx` (wrapped in `<Suspense fallback={<FullPageSpinner />}>` at its one render site) — it's the only file that imports `mermaid`, whose core plus its own already-lazy diagram-renderer sub-chunks were nonetheless being pulled into the main bundle eagerly, since nothing lazy-loaded the *page* itself. Cuts the initial JS payload from 629 kB to 458 kB gzipped (main chunk 2.55 MB → 1.81 MB raw) — confirmed via `dist/index.html` carrying no `modulepreload` for the new `KanbanPage`/mermaid chunks, so they genuinely defer until Integration Board is opened.

## Recent changes (v0.35.1 "Charter")
- **`applySailingToLegs` silent no-op bug fixed** — found via a real bug report (a shipment had a schedule + contract assigned but an empty Route Legs table). The closure that copies a picked sailing's vessel/voyage/ETD onto the shipment's legs is duplicated in `ShipmentSchedulesPage.jsx` and `ShipmentFormPage.jsx` (the latter operates on client-side draft legs, the former on live `api.legs.*` calls); both used to silently `return`/no-op when `seaLegs.length === 0` instead of creating one — masked entirely because the caller still showed a "Sailing saved" success toast. Root cause: nothing in shipment creation (`POST /api/shipments`) auto-seeds an initial leg, so any shipment whose contract/schedule was assigned before its first SEA leg existed hit this. Both now build the missing leg(s) from the sailing data instead (one leg for a direct sailing, one per segment for a TSP sailing), using `shipment.contractType`/`contractRef` as fallbacks.
- **`BOOKABLE_CARRIERS` centralized.** v0.35.0 shipped this `Set(["MAEU","SAFM","MCPU"])` as three independent copies (`routes/edi.js` plus both new Carrier Booking sub-pages) — now a single `ctx.BOOKABLE_CARRIERS` on the backend and a new `src/utils/carrierBooking.js` on the frontend (two copies total, one per side, since frontend/backend don't share a module — but no longer three). Deliberately kept separate from `routes/system.js`'s `MAERSK_CODES` (adds `CMDU`) — that's the broader "carriers you can search schedules for" concept, a different domain rule from "carriers you can send a booking request to".
- **Booking-status badges.** The Carrier Booking sidebar nav entry (`ShipmentDetailSidebar` in `App.jsx`) and the Shipments list (`ShipmentsPage.jsx`) both now show a small Pending/Rejected badge next to a shipment with an outstanding or rejected carrier booking — `GET /api/shipments` gained a `LEFT JOIN carrier_bookings` for the list view (no subquery needed, one row per shipment already); the sidebar self-fetches `api.carrierBooking.get` once per shipment/page-change with no WebSocket subscription, matching the existing Tickets-count badge idiom rather than Messages/EDI's live-subscribe one. `NavRow` (`App.jsx`) gained an optional `badgeColor` prop (default `T.accent`) to support the badge's status-dependent color without touching its one pre-existing caller (the Cargo count badge).

## Recent changes (v0.35.0 "Charter")
- **Carrier Booking is now its own shipment sub-page family** (`ShipmentCarrierBookingDetailsPage.jsx` + `ShipmentCarrierBookingReviewPage.jsx`), structured exactly like Accounting (`shipments/:id/booking/:child` two-segment hash, `CARRIER_BOOKING_SUBPAGES`/`CARRIER_BOOKING_SUBPAGE_HASHES` local maps in `App.jsx`, unconditional Explorer sidebar entry — **not** gated behind Accounting's `!isTradeManager` finance guard). Replaces the old `EdiMessagesDrawer` (`ShipmentHeaderBar.jsx`'s `ediOpen` state + icon tile, and the drawer component itself in `ShipmentDetailPage.jsx`) entirely — both removed. The message-thread rendering was lifted into a new shared `src/components/shared/EdiMessageList.jsx` so Details/Review/Test Tools all reuse it instead of duplicating the JSX.
- **New `carrier_bookings` table** (`BKG-` surrogate key, real FK to `shipments` with `ON DELETE CASCADE` — `edi_messages` itself still lacks this same FK, deliberately not retrofitted against live rows). One row per shipment: a derived "current state" projection over `edi_messages` (which remains the full historical ledger), not a second history table. `status` and `last_response_status` are tracked separately **on purpose** — a confirmed carrier response no longer auto-finalizes the booking (the old drawer did this instantly); it only sets `last_response_status='confirmed'` and the booking stays `Pending` until the operator's own **Confirm** action, which is also the new trigger point for `shipments.booking_ref` and the `booking_confirmed` milestone auto-complete (moved off the automatic per-response path). A **rejected** response has nothing to lock in, so it auto-advances `status` straight to `Rejected` — no gate needed. **Cancel** sends an outbound `booking_cancellation` EDI message when the carrier is EDI-bookable and something was actually transmitted; doesn't clear `booking_ref` or un-complete the milestone. Non-EDI carriers get a full Confirm/Cancel lifecycle too via a manual `bookingRef` entry with no request ever sent — "consolidating all the carrier booking information" shouldn't only apply to the 3 EDI-bookable carriers (`MAEU`/`SAFM`/`MCPU`).
- **`POST .../edi-messages/booking-request` no longer auto-fabricates a response.** Previously, with no live `maersk_api_key` configured, this endpoint always synthesized an immediate `"confirmed"` reply (`mockBookingResponse()`) — meaning a rejection could never actually be tested. It now just sends the request and stops (`{pending:true}`) unless a real API call succeeds. New **Test Tools** page (Integration Board's 5th child, `TestToolsPage.jsx`) closes that gap: an EDI Message Simulator lets a developer pick a pending booking and inject either outcome (`POST .../edi-messages/simulate-response`) — writes a real `edi_messages` row through the real WebSocket broadcast path, so a Review page open elsewhere sees it exactly like a genuine carrier reply.
- **Fixed while in this code**: `occ_bk` users have `canEditShipments:true` on the frontend and saw an enabled Send button that 403'd on click — the backend `write` gate on every booking-related route (`routes/edi.js`) excluded `occ_bk`; widened to `["operator","admin","occ_bk"]` to match.
- **Confirmed, not changed**: `shipment_schedules` already had a proper surrogate key (`SCHED-`, real FK) before this release — no migration needed there. Deliberately left fully decoupled from `carrier_bookings` (no auto-populate-schedule-from-confirmed-booking button or side effect), per explicit direction — the carrier response payload doesn't carry `service`/`eta`/`transitDays` the way a real schedule search does, so an automatic write would leave a visibly-incomplete row next to fully-populated searched ones.

## Recent changes (v0.34.5 "Ledger")
- **Security review response** — see `src/version.js` CHANGELOG for the full writeup. Highlights: Mermaid stored-XSS fix (`KanbanPage.jsx`'s `escLabel`), `token_version` now bumps on role change not just password/deactivation (`routes/auth.js`), per-IP login rate limit, and a full password-expiry policy (see below).
- **Password expiry policy**: new `password_expiry_days` setting (default 90, `0` disables — Security Settings panel, `AppSettingsPage.jsx`), new `users.password_changed_at` column (migration backfills to `created_at`, not "now" — an old account correctly shows as already due). Self-service `POST /api/auth/change-password` (`routes/auth.js`, `auth()`-gated, any user their own account) verifies the current password, enforces a 12-char/3-of-4-character-class minimum (`passwordMeetsPolicy` server-side, mirrored in `src/utils/passwordPolicy.js`'s `scorePassword` client-side — two copies since the route is CommonJS and the frontend is ESM, keep both in sync if the policy changes), bumps `token_version`, and returns a fresh token so the user isn't logged out by changing their own password. `passwordExpired` is checked and returned by **both** `POST /api/auth/login` and `GET /api/auth/me` — the latter matters because a still-valid JWT restores the session silently on mount, bypassing the login endpoint entirely; checking only at login would let an already-logged-in session dodge the policy indefinitely.
- **New components**: `PasswordStrengthMeter.jsx` (primitives) and `ChangePasswordModal.jsx` (shared) — the modal takes a `forced` prop (`hideClose`, warning banner, "Sign out instead" instead of Cancel) used when `passwordExpired` is true, wired into `App.jsx`'s `changePwOpen`/`changePwForced` state from both the login handler and the mount-time token-restore effect. Reachable any time via the user menu's new "Change Password" item.
- **Two bugs this surfaced, both fixed**: (1) the existing office-picker modal (`App.jsx`, z-index 9000) painted over the forced password modal instead of deferring to it — now suppressed while `changePwOpen && changePwForced`. (2) change-password's "wrong current password" originally returned 401; `api.js`'s global `req()` treats **any** 401 as "session dead" and force-clears the token + logs out — wrong for a business-logic rejection where the caller IS authenticated. Moved to 400. Worth remembering: no other endpoint should use 401 for anything other than an actually-invalid/expired/revoked token, or it'll hit this same interceptor.
- **fallback-admin@cargodesk.local rotated**: its password was committed to this file in plaintext (this repo is public) — rotated through the new self-service endpoint (not a raw DB write) and redacted from here; see whoever holds it out-of-band.
- **`npm audit fix` applied** (non-forced — only patch-level bumps within existing package.json ranges: body-parser, brace-expansion, dompurify, postcss, shell-quote). Four findings remain, all requiring a major bump (Vite 5→8 skipping two majors, ExcelJS major) — deliberately not forced through; a dedicated follow-up.
- **Pre-existing, unrelated to the above**: `tests/*.test.js` hardcoded `claudeagent@localhost / admin` — permanently incompatible with the new password policy (too short/weak), so all four test files were updated to a policy-compliant fixture password. Also found (not fixed, out of scope): `GET /api/shipments/:id/events` returns `{results: [...]}` but `shipment-crud.test.js`/`container-events.test.js` expect a bare array — pre-existing shape mismatch, unrelated to anything in this wave.

## Recent changes (v0.34.4 "Ledger")
- **Second icon family (Remix Icon, Apache-2.0) added alongside MingCute** in `Icon.jsx` — MingCute has no anchor, search/magnifier, or messaging (mail/EDI/send/upload/download) icons; Remix's same 24x24 filled-line style mixes freely via the existing `AnyIcon` helper. Eight new icons: `IconAnchor`, `IconSearch`, `IconMail`, `IconMailUnread`, `IconBaseStation` (EDI), `IconSendPlane`, `IconUpload`, `IconDownload` (source SVGs vendored under new `remixicon-main/icons/`, same reference-only convention as `mingcute-icons-main/`).
- **Anchor** now covers every occurrence app-wide, including the app's own wordmark/logo (header sidebar, login page, landing greeting, full-page spinner, About page hero, footer) — the same cross-platform-consistency rationale the icon migration started on in v0.34.1 applies equally to the brand mark. Also: Contracts & Schedules nav icon, Add Sailing buttons, vessel-arrived status/milestone map entries, `CommandCenterView`'s Port Locations tile, `TrackingPage`'s public milestone timeline (its own standalone `STEP_ICONS` map, restructured off template-literal string interpolation to real JSX via `AnyIcon` so a component can sit in the same map as emoji).
- **Search** covers every combobox browse button (Carrier/Customer/Commodity/Port/Container-type pickers — both the collapsed-chip and typeahead-input variants), empty-search-result states (Dashboard/Space Configurations contract picker, Schedules page, Test Cases preview pane), and the Kanban parent-ticket picker.
- **Messaging/EDI cluster**: `ShipmentHeaderBar.jsx`'s icon tile (messages/unread messages/EDI), the EDI Messages drawer (header + sent/received badges + Send Booking Request button) in `ShipmentDetailPage.jsx`, and the Export/Import Services group icons in `App.jsx`'s shipment sidebar. `AboutPage.jsx`'s EDI Messaging feature card icon updated to match.

## Recent changes (v0.34.3 "Ledger")
- **Icon replacement pass three** — the sub-pages v0.34.2 disclosed as left out: `ShipmentSchedulesPage.jsx` (mismatch warning, Space config/Expired badges), `ShipmentAccountingCostsPage.jsx` + `ShipmentAccountingInvoicesPage.jsx` (toolbar buttons, status pills, Preview), `LoadingServicePage.jsx`/`GenericServicePage.jsx` (empty states → `IconFolder`, ⚡ Generate → `IconFlash`), `SpaceConfigurationsPage.jsx` (conflict banners, contract picker, lane override, copy chip, Archive button, `ActionMenu` items now component refs, inline ⚙ hint → `IconSettings`), `DashboardArchivePage.jsx` (Renew/delete), `ShipmentContainersPage.jsx` (DG badges, events/manifest/delete buttons), and the `ServicesPanel`/`ContainerEventsPanel`/`ContainerPackagesPanel` shared panels. Seven new icons in `Icon.jsx`: `IconDoor`, `IconReceipt`, `IconCoin`, `IconTime`, `IconFile`, `IconFileCertificate` (+ vendored sources under `mingcute-icons-main/svg/`). `shipmentSections.js` Explorer entries Conditions/Documents/History and App.jsx's `accountingChildren` (Invoice Entry → `IconReceipt`, Cost Entry → `IconCoin`) are now components — only the ⚓ anchor (Contracts & Schedules) stays emoji, MingCute has no anchor. `ContainerEventsPanel`'s `EVENT_ICON` lifecycle map is all components (door/package/arrows/ship/refresh) rendered via `AnyIcon`.
- **Nav fold persistence**: the four fold groups now use a tiny `useFoldState(storageKey)` hook in App.jsx persisting to `localStorage` (`cd_navfold_mdm|org|dashboard|kanban`, same idiom as `cd_theme`); absent key = collapsed, so a fresh browser still gets the all-minimized default. Verified live via CDP: expand → reload → stays expanded.

## Recent changes (v0.34.2 "Ledger")
- **Main nav scroll + collapse-by-default fix**: the sidebar `<aside>` had no explicit height, only `flexShrink: 0`, so on a viewport shorter than its full content (e.g. a MacBook's reduced usable height) it just grew taller than the window instead of scrolling internally — the last nav item was pushed below the fold with no way to reach it. Fixed by giving the sidebar an explicit `height: "100vh"` + `position: "sticky"` + `overflow: "hidden"` (same fix applied to `ShipmentDetailSidebar`'s Explorer sidebar, which had the identical gap) so the inner `<nav>`'s pre-existing `overflowY: "auto"` actually has a bounded height to scroll within. `NavBtn` gained an optional `foldable`/`open`/`onToggleFold` prop (a chevron rendered inside the button, `stopPropagation`d so it doesn't also trigger navigation) — Dashboard and Integration Board now collapse/expand their children the same way Master Data and Organization already did, and all four groups now default to **collapsed** (`useState(false)`) instead of expanded.
- **Icon replacement continued past v0.34.1's sidebar/settings-only scope**: shipment entry (`ShipmentFormPage.jsx`), shipment details (`ShipmentDetailPage.jsx` and its exported sub-components, `ShipmentHistoryPage.jsx`), the Dashboard (`DashboardPage.jsx`), the persistent `ShipmentHeaderBar.jsx`, and the shipment detail Explorer sidebar (`shipmentSections.js`) had their recurring close/warning/package/edit/check/clipboard/refresh/ship emoji swapped for the existing MingCute icon set. Six new icons were added to `Icon.jsx`: `IconLock`, `IconUnlock`, `IconEye`, `IconArrowUp`, `IconArrowDown`, `IconForbid` (source SVGs vendored under `mingcute-icons-main/svg/system/` and `svg/arrow/`). `ActionMenu.jsx`'s per-item `icon` field and `ShipmentHeaderBar.jsx`'s `IconTile` row both now render via `AnyIcon` (string-or-component), so every existing `items`/tile array in the app can upgrade one entry at a time without a full rewrite. A few icons were searched for and not found in MingCute (anchor, magnifying-glass/search) and are intentionally left as emoji, along with the messaging/EDI icon cluster and several page-specific one-off glyphs — a disclosed scope boundary, not every emoji in these files was converted.
- **Two standing recovery/test admin accounts**: `fallback-admin@cargodesk.local` (break-glass admin, created via the normal `POST /api/users` flow, meant to stay stable) and `claudeagent@localhost` (Claude's own account for CDP/browser verification — safe to reset its password between sessions). Documented next to the existing default-seed-admin note.

## Recent changes (v0.34.1 "Ledger")
- **Sidebar icon set** replaced with real SVG icons from MingCute (Apache-2.0) instead of emoji, via a new `components/primitives/Icon.jsx` (`Icon` wrapper + one small component per icon, e.g. `IconDashboard`, `IconShip` — `currentColor` fill so they inherit the nav item's text color, `size`/`color` override props). `NavBtn` (`App.jsx`)'s `icon` prop is now a component reference (`icon={IconShip}`), not an emoji string — instantiated internally as `<IconComp size={fs+3} color={iconColor} .../>`, where `iconColor` is a rare per-item override (used once, for the always-red Sanctioned Customers icon). Also fixed everywhere the ⚙ settings glyph appeared: `ActionMenu.jsx`'s shared trigger button (used across Shipments/Carriers/Contracts/Space Configurations/etc.), the header's Application Settings menu item, the command palette, and the Kanban board's WIP-limit/Board Settings buttons — all now render MingCute's actual gear-shaped `settings_3_line` icon rather than its sliders-style `settings_2_line` alternate, since "cog/wheel" means an actual gear, not sliders. A new `AnyIcon` helper (`Icon.jsx`) renders either a plain emoji string or an icon component from the same object slot, so lists that mix upgraded and still-emoji entries (`MenuItem`, the command palette, `AboutPage`'s feature cards) only needed their settings-related entry touched, not a full rewrite. Scoped to the sidebar and the settings icon only this pass; the many smaller inline emoji elsewhere (edit/delete/warning glyphs, status badges) are unchanged. The vendored `mingcute-icons-main/` reference folder was trimmed from ~24MB/3,324 SVGs down to just the ~30 files actually used (plus LICENSE/README) — the workspace tooling (`packages/`, `react/`, `scripts/`, `update/`, lockfiles) was removed since the icon paths are now self-contained in `Icon.jsx` and don't depend on that folder at runtime.

## Recent changes (v0.34.0 "Ledger")
- **Accrual/posting state machine + GP variance** (`TKT-83O41G`, Epic `TKT-A5LUPD` phase 2 of `TKT-6QT30S`): `shipment_cost_lines` gains a `status` lifecycle (`accrued` → `actualized` → `posted`) plus `actual_amount`/`actual_exchange_rate`/`actualized_at`/`actualized_by`/`posted_at`/`posted_by`. New routes `PATCH .../cost-lines/:id/actualize`, `PATCH .../cost-lines/:id/post`, `POST .../cost-lines/post-batch` (`routes/shipment-ops.js`); the existing `PUT`/`DELETE` cost-line routes now 409 once a line is `posted` ("add a new adjusting line instead"). `mapCostLine` computes `actualAmountUsd`/`varianceUsd`. `CostLineRow` shows a status pill (Actualized/Posted, variance in the tooltip) and gates Edit/Delete/Actualize/Post in its `ActionMenu` by status; new `CostLineActualizeModal`. `ShipmentAccountingGpPage.jsx` rewritten around Estimated (every line's original accrual) vs Actual (actualized/posted lines use their real amount, still-accrued lines fall back to the estimate) vs Variance, by charge code — "by office" is a shipment-level EMO/IMO context line, not a real per-line dimension, since cost lines carry no `office_id`.
- **Per-container invoicing + automated charge codes** (`TKT-OK5H34`): per-container invoice generation (`splitPerContainer` in `generateInvoices()`, `src/utils/invoiceGenerator.js`) already existed from an earlier pass; this wave adds the "automated charge codes registry" — new `charge_code_definitions` table (`code`, `label`, `trigger`, `amount`, `currency`, `unit`, `is_active`) managed via a new **Master Data → Charge Codes** page (`MdmChargeCodesPage.jsx`, gated on `canManageConfigs`). Only trigger today is `per_container_split`: when an Invoice Entry split-per-container generation runs, every active definition with that trigger auto-injects a matching SELL `shipment_cost_lines` row (`source: 'automated'`, new `Badge` color) into every container that doesn't already have one from that definition — e.g. a $10/container "Containerized Invoicing" fee — reusing the existing `generateInvoices()`/FR01 pipeline rather than a parallel one. **Caught mid-implementation**: the Invoice Entry page's `runGenerate()` only refreshed the document list (`loadDocs()`) after generating, not the cost-line list (`load()`) — a second "Generate Invoice, split per container" click on the *same page instance* (no reload) still saw the stale pre-injection `lines` state and re-injected duplicate automated charges. Fixed by also calling `load()` after `generateInvoices()` resolves.
- **Container cargo manifest — pallet/box breakdown** (`TKT-EMFIBR`): new self-referencing `container_packages` table (`container_id`, `parent_id` nullable, `description`, `quantity`, `position`) — arbitrary nesting depth, not a fixed Pallet→Box model, per the 2026-07-17 scoping decision. `description`+`quantity` only; weight/HS code deliberately stay on the container itself (`containers.cargo_description`/`gross_weight_kg`/`volume_cbm` are unchanged and remain the source of truth for VGM/cost lines/compliance elsewhere — this is a supplementary detail view, not a rollup). New `GET`/`POST /api/containers/:id/packages`, `PUT`/`DELETE /api/container-packages/:id` (delete cascades to the whole sub-tree). New recursive `ContainerPackagesPanel.jsx`/`PackageNode` component (first recursive-tree UI in this codebase — closest prior analog, Kanban's `parent_id` ticket nesting, isn't deeply recursive in its own UI) opened via a new 📦 button per row on the Cargo page.
- **CPI (Carrier Payment Indicator) + milestone automation** (`TKT-OZD4V8`, unblocked this wave — CPI data model resolved as **per-cost-line**, not per-shipment, since a shipment can mix Prepaid/Collect charges): `shipment_cost_lines` gains `payment_indicator` (`Prepaid`/`Collect`, default `Prepaid`); editable in `CostLineForm`, shown as a small badge in `CostLineRow` (only when `Collect`, matching the existing VAT-badge "only show the exception" idiom), and broken out as a new "By Payment Indicator (CPI) — who pays where" table on `ShipmentAccountingGpPage.jsx` alongside the existing by-charge-code one. New shared helper `autoCompleteMilestone(shipmentId, milestoneKey, note)` (`server.js`) wires three external events into the existing `shipment_milestones` lifecycle instead of requiring a manual click — no-ops if the step is already completed (a manual completion is never silently overwritten) or doesn't exist yet (init hasn't run): (1) a successful EDI carrier booking confirmation (`routes/edi.js`) completes `booking_confirmed`; (2) every container on the shipment logging the same `container_events` type completes `cargo_gated_in` (all "Gate In") / `cargo_released` (all "Gate Out") (`routes/shipments.js`); (3) every container reaching `vgm_status='Submitted'` completes `si_submitted` — VGM is declared alongside Shipping Instructions in real booking workflows, so this reuses that existing step rather than inventing an untracked one.
- **Parties & Offices — default-edit-mode redesign** (`TKT-PNFO5O`, per explicit user direction: *don't* drop the modal for Parties): Offices (EMO/IMO/Controlling) are now **inline-editable** `<select>`s directly on the page (new `OfficeInlineSelect`, commits immediately via a full-shipment-record `PUT`) — no modal. Parties (Shipper/Consignee/Notify/Principal) **keep** the existing "✎ Edit" → modal flow (`PartiesEditForm`, trimmed from the old combined `PartiesOfficesForm` which handled both sections). `PartiesOfficesPanel` now self-fetches `offices` directly rather than receiving Offices-section state from a parent modal.
- **Auto-validate/auto-save on section switch** (`TKT-OJYO71`, first example: Cargo page's Add/Edit Container modal): new `src/navigationGuard.js` — a tiny single-slot pub-sub (`setNavigationGuard`/`clearNavigationGuard`/`runNavigationGuard`) an open in-page form registers itself against. `ContainerForm` (`ShipmentDetailPage.jsx`) converted to `forwardRef` + `useImperativeHandle` exposing `trySave()`: on an invalid attempt it surfaces the existing inline `FieldErr` markers (via `setTouched`) *and* returns a toast-ready message naming exactly which fields are incomplete/conflicting; on success it saves and lets navigation proceed. The root `navigate()` in `App.jsx` is now `async` and calls `runNavigationGuard()` **before** the pre-existing dirty-form-discard confirm — deliberately scoped to the primary `navigate()` call path only, not the browser back/forward `hashchange` handler (a documented, intentionally incremental limit, not an oversight).
- **Services loading-state fix, div `id` instrumentation, Hermes Agent research**: `ServicesPanel`/`ShipmentDetailSidebar`'s services nav both briefly rendered "nothing ordered" during their first `shipment_services` fetch (same `[]`-vs-`null` gap fixed elsewhere before) — both now track loading as `null` until resolved. Stable `id` attributes added across every shipment sub-page's fields/rows/buttons (`{page-prefix}-{field}` convention, e.g. `shpcond-*`, `shpctr-${c.id}-row`) — five shared primitives (`Btn`/`Inp`/`Sel`/`Textarea`/`DatePicker`) gained `id` passthrough support to make this possible without hand-wrapping every instance. `TKT-A354CH` (Hermes Agent spike): confirmed real (MIT-licensed, Nous Research, native Windows/Linux/macOS/WSL2 installers, no admin rights required) via `WebSearch`/`WebFetch`; full install instructions documented in a new **AI Agent** section of the in-app User Manual, but the actual install attempt was blocked by Claude Code's own auto-mode classifier as unattended remote-script execution (a second layer of protection independent of prior user approval) — end-to-end verification against a running instance is left for the user to complete. `TKT-43W2WA` (Hermes Agent Integration epic) assessed as needing **no new code**: the AI Agent's existing OpenAI-compatible "Custom Local" provider preset (`routes/ai.js`'s `isAnthropicEndpoint()` gate) already covers exactly this integration shape.

## Recent changes (v0.33.0 "Gangway")
- **Unloading Service page** (`TKT-130OSZ`, reuses `LoadingServicePage.jsx`): Unloading is structurally identical to Loading (same per-container planned date/time + sequence + notes, same carrier-attachment-or-generate document flow), so it shares the component rather than duplicating it — `LoadingServicePage` now takes a `serviceType` prop (`"Loading"` or `"Unloading"`) that drives everything type-specific: the doc-type code (`DOC_CODE_BY_TYPE = { Loading: "LP01", Unloading: "UP01" }`), the plan label (`PLAN_LABEL_BY_TYPE`), the service-matching filter, empty-state text, and filenames. The underlying `shipment_loading_plan_lines` table needed **no schema change** — it was already keyed generically by `service_id`, not hardcoded to Loading. `BESPOKE_SERVICE_TYPES` in `shipmentServicePages.js` (renamed from `BUILT_SERVICE_TYPES`/`isBuiltServiceType` → `isBespokeServiceType`) now lists both types; App.jsx's routing-switch block picks `LoadingServicePage` for either. A new `DOC_TYPES` entry, `UP01` "Unloading Plan", sits alongside `LP01`; `buildLoadingPlanHtml` (`src/utils/invoiceGenerator.js`) gained an optional `planLabel` param (default `"Loading Plan"`) so the same builder produces either document's title/section-label text — `dispatchDocBuilder`'s `"UP01"` case just calls it with `planLabel: "Unloading Plan"`.
- **Generic service detail page** (`TKT-XBSF86`, `src/pages/GenericServicePage.jsx`, new): replaces the WIP placeholder for the other 7 service types (VGM, Haulage, Fumigation, Storage, CY Storage, Warehousing, Pickup/Delivery, Customs Clearance) — deliberately **not** tailored per type. Same vendor/status/dates recap header as `LoadingServicePage`; a bigger `Textarea` (gained an optional `disabled` prop, previously missing on that shared primitive) bound to the **same** `shipment_services.notes` column `ServicesPanel` already shows on Overview — no new table, just more room to write; and a generic produced document (`buildGenericServiceDocHtml`, `invoiceGenerator.js`) saved under the existing catch-all **`OT`** (Other) doc type. Reusing "OT" rather than minting a new tracked type per service type was a deliberate call — a shared type per service would either collide across services that share one global doc-type slot, or (if made per-side-per-type like `LP01`/`UP01`) require statically pre-registering ~16 more rows on **every** shipment's Documents readiness page regardless of whether that shipment ordered any of them. `ServiceWipPage.jsx` is now fully dead code (no service type routes to it anymore) and was deleted.
- **DatePicker `withTime`** (`src/components/primitives/DatePicker.jsx`): optional prop — a native `<input type="time">` rides alongside the calendar in the same popover; `value` becomes `"YYYY-MM-DDTHH:mm"` instead of a bare date. The calendar/nav logic internally still operates on just the date part (`datePart`/`timePart` derived from `value`), so every other existing `DatePicker` call site across the app is unaffected — the prop defaults to `false`. Picking a day defaults the time to `09:00` the first time; reopening lets the time be adjusted independently via the time input without re-picking the date. Used by `LoadingServicePage`'s planned date/time field; old date-only values (10-char strings, no `T`) still render fine everywhere that reads `plannedDate` — no migration needed, it's just a `TEXT` column either way.
- **Services loading-state fix** (found right after shipping the above): `ServicesPanel` (Overview) and `ShipmentDetailSidebar`'s Export/Import Services nav rows each self-fetch `shipment_services` independently, and both started from `useState([])` — indistinguishable from "confirmed, nothing ordered" during the fetch's first second or two, so a shipment with real services briefly rendered as if it had none. Both now init to `null` and track `loading = services === null` until the first fetch resolves: `ServicesPanel`'s `ServiceColumn` shows a small `Spinner` (`size="sm"`) instead of the "No X services ordered yet" text; the sidebar shows a one-line "Loading services…" placeholder with a spinner exactly where the Export/Import Services group renders once loaded, instead of silently omitting it. Neither resets to `null` on a post-mutation reload (only the true initial fetch) — creating/advancing/deleting a service still feels instant, no flicker.

## Recent changes (v0.32.0 "Stevedore")
- **Export/Import Services dedicated pages** (new Epic `TKT-TBS7QD`, sits alongside — not nested under — the FCL epic `TKT-A5LUPD`, linked via a "Relates to" ticket-link): ordering a service from `ServicesPanel` (Overview) now makes a dedicated nav entry for that specific service type appear in the shipment sidebar, under new "Export Services" / "Import Services" parent rows that are only visible once at least one service is ordered on that side. `src/shipmentServicePages.js` (new, mirrors `shipmentSections.js`'s export shape) holds `SERVICE_TYPES` (now canonical — `ServicesPanel.jsx` imports it rather than defining its own copy), `BUILT_SERVICE_TYPES` (`["Loading"]` so far), and precomputes the full side×type page-key/hash/label combinatorial set (20 entries: 10 types × 2 sides, "Other" excluded — it's free text per instance, never a catalog page) even though only a subset is ever visible on one shipment. This is a genuinely **dynamic per-shipment** nav shape (unlike the fixed `shipmentSections.js` array), so `ShipmentDetailSidebar` (`App.jsx`) self-fetches `shipment_services` (own `useEffect`, refetches on `shipment.id`/`currentPage` change) purely to decide which rows to show — a new tiny pub-sub `src/servicesBus.js` (same shape as `toast.js`) lets `ServicesPanel` (Overview, cousin component, not parent/child) signal an immediate nav refresh right after ordering, instead of only updating on the next navigation. Routing: a new two-segment hash `shipments/:id/services/:side/:type` parsed by its own regex in `parseHash` (parallel to Accounting's existing two-segment pattern) resolving through `SERVICE_SUBPAGES`; the routing switch handles it with **one generic block** (reads side+type from `SERVICE_PAGE_INFO[page]`, renders `LoadingServicePage` if `isBuiltServiceType(type)` else the shared `ServiceWipPage`) rather than one hardcoded JSX block per type. `SHIPMENT_SUBPAGE_LABELS` absorbs `SERVICE_SUBPAGE_LABELS` so the breadcrumb, page title, and persistent `ShipmentHeaderBar` mount gate (all keyed off that one object's truthiness) pick up service pages automatically with no separate changes needed.
- **"Loading/Unloading" split** (`TKT-6292VK`): the old combined `ServicesPanel` type is now two separate types, "Loading" and "Unloading" — existing `shipment_services` rows saved with the old combined label are free text and keep displaying it unchanged; no data migration.
- **Shared WIP placeholder** (`TKT-S0W8S4`, `src/pages/ServiceWipPage.jsx`): every ordered service type without a dedicated page yet (all of them except Loading, for now) renders this — same visual language as the pre-existing `UnderConstructionPage` (org pages) but a separate component, since threading org-specific props into that one wasn't worth it for ~20 lines.
- **Loading Service page** (`TKT-TR6OBR`/`TKT-X3SA2E`, `src/pages/LoadingServicePage.jsx`): the first real dedicated page. Self-resolves the matching `shipment_services` row (side + `serviceType === "Loading"`, non-cancelled) then fetches its per-container loading plan from a new `shipment_loading_plan_lines` table (`PRIMARY KEY (service_id, container_id)` — no synthetic id needed, a container only ever has one plan line per service). `GET`/`PUT /api/shipments/:id/services/:serviceId/loading-plan[/:containerId]` (`routes/shipment-ops.js`) — GET always `LEFT JOIN`s every current container so the table shows one row per container even before any plan data exists (same "list what should exist, backed by a maybe-absent row" idiom `cutoffState()` already uses for compliance badges); PUT is a manual check-then-insert-or-update (no `ON CONFLICT` precedent elsewhere in this codebase, so matched existing style rather than introducing one). Each row: planned loading date **and time** (`DatePicker` with the new `withTime` prop — see below), sequence order, notes — inline-edited, saved on change/blur via a small per-row `LoadingPlanRow` component (local draft state so typing doesn't fire a save per keystroke). `planned_date` stores `"YYYY-MM-DDTHH:mm"`; older date-only rows (10 chars, no `T`) still render fine everywhere (`LoadingServicePage`, `buildLoadingPlanHtml`) — no migration needed, both formats are just a `TEXT` column. A new tracked `DOC_TYPES` entry, `LP01` "Loading Plan" (`App.jsx`), gets populated two ways, both landing in the same `shipment_documents` slot: uploading the carrier's own emailed plan (reuses the existing generic upload endpoint, same as `DocumentsModal`'s "Upload External Document") or a "⚡ Generate Loading Plan" button that builds an HTML doc from the structured table via a new `buildLoadingPlanHtml` builder. That builder lives in `src/utils/invoiceGenerator.js` (not `App.jsx`) alongside `buildFreightInvoiceHtml`, for the exact same reason: `LoadingServicePage.jsx` needs to call it, and `App.jsx` imports that page, so keeping it `App.jsx`-private would be circular. `dispatchDocBuilder`'s `"LP01"` case also uses it for the generic Documents-page "⚡ Generate" picker, minus `loadingPlanLines` (that picker has no concept of "service") — still renders a sensible template with blank planned dates rather than nothing.

## Recent changes (v0.29.0 "Bearing")
- **Persistent Shipment Header**: `src/components/shared/ShipmentHeaderBar.jsx` mounts once in `App.jsx` (above the page switch, guarded by `(page === "detail" || SHIPMENT_SUBPAGE_LABELS[page]) && selectedShipment && isEnabled(page)`) so it's visible on Overview and all 8 promoted sub-pages. Row 1: ID (📋 copy-to-clipboard) · FCL/LCL · POL→POD · ETD/ETA · DG badge (only when a container is flagged). Row 2: Incoterm, Routing (`routingTerm`), Vessel/Voyage, Shipper, Consignee, Contract, TEU, Loop (`shipment_schedules[0].service` — self-fetched, no dedicated `loopCode` field exists). Row 3: a Door → POL ──carrier── POD → Terminal journey bar reusing `CommandCenterView`'s existing node visual language (same `LOC_FULL`/routingTerm-split parsing) rather than a new one — location type (Door/CY/CFS) labeled above the dot only for inland extensions, full location names primary with UNLOCODE demoted to a caption. Self-fetches `shipment_legs` to resolve the actual first/last **SEA** leg for the Port nodes and carrier caption — `shipment.pol`/`pod` are the journey's overall bookends (`legs[0]`/`legs[-1]`), not the same thing when there's a Door pickup or a multi-leg TSP journey.
- **Dedicated Services** (Epic `TKT-A5LUPD` → Story `TKT-9DGDNP`): new `shipment_services` table (`side` Export/Import, `service_type`, `status` Requested→Confirmed→Completed/Cancelled, `vendor_id`/`vendor_name`, `office_id`, `requested_date`/`confirmed_date`/`completed_date`, `notes`) with `GET`/`POST`/`PATCH`/`DELETE /api/shipments/:id/services` in `routes/shipment-ops.js`, `mapService` joining `office_code`/`office_name`. `src/components/shared/ServicesPanel.jsx` — self-fetching, embedded directly on the Overview page (deliberately **not** a promoted sub-page, per explicit user direction — it's meant to stay visible as a dashboard, unlike everything else that got promoted this session) — renders two columns (Export/Import), each with a "+ Request Service" modal (service type, vendor via `CustomerCombobox`, office defaulted to `shipment.emoOfficeId`/`imoOfficeId` per side via the same `offices.filter(o => o.department === 'SE'|'SI' && o.isActive)` pattern already used in `ShipmentFormPage.jsx`, requested date, notes) and inline Confirm/Complete/Cancel status buttons. Status transitions stamp `confirmed_date`/`completed_date` server-side and log through `logEntityEvent('service', ...)` — same generic audit mechanism as cost lines/documents. Deliberately **not** linked to `shipment_legs` (a leg tracks physical routing, a service tracks commercial ordering/vendor/status) and vendor rows are **not** sanctions-screened (`screenShipmentById` only checks shipper/consignee/principal by a hardcoded field list) — both documented as known follow-ups in `TKT-E64LKG`.
- **Schedules page overhaul** (`ShipmentSchedulesPage.jsx`): now shows **Route Legs** (`LegsTable`, imported from `ShipmentFormPage.jsx` — the exact same live-editing component used in the full shipment form, `showContractCols={false}` hides Contract Type/No. here), **Schedule History**, then `RouteSummaryBar` (relocated from Overview — see below). Two real bugs fixed: (1) legs now **auto-order** Pick-up-first/SEA-middle/Delivery-last on every `addLeg`/`saveLeg` (`orderLegs()` helper, stable sort by `LEG_TYPE_RANK`, re-stamps `legOrder` and persists via `Promise.all(api.legs.update(...))`) — previously a new leg always appended at the end regardless of type, landing after an existing Delivery leg; (2) **"Add Sailing" is TSP-aware** — `applySailingToLegs()` (now living in `ShipmentSchedulesPage.jsx`, not `SchedulesPanel`) mirrors `ShipmentFormPage`'s own `applySailingToLegs` but operates via live `api.legs.*` calls against an **existing** shipment's already-persisted legs instead of local draft state; a multi-leg (`sailing.legs.length > 1`) sailing updates the first SEA leg and replaces any trailing ones with fresh legs per remaining segment, while a direct sailing collapses back to one SEA leg **and resets pol/pod** (previously left pod stuck on a stale TSP transshipment hub if a direct sailing was picked after a TSP one). "Add Sailing" button moved next to the Route Legs section header. The old always-expanded Sailings box is renamed `ScheduleHistoryPanel` (still exported from `ShipmentDetailPage.jsx`) — now a **read-only** SAVED/REMOVED audit trail (`GET /api/shipments/:id/schedule-events` reads `entity_events WHERE entity_type='schedule'`, unmapped/snake_case rows same as `cost-line-events`) instead of the add/remove UI, which moved to `ShipmentSchedulesPage.jsx` itself. Follow-up ticket `TKT-E64LKG` tracks renaming the page to "Contracts & Schedules", adding contract attachment here, and converting history to a button-opens-modal pattern.
- **`RouteSummaryBar`** (`ShipmentDetailPage.jsx`, exported): the old grid-based Pick-up/POL/POD/Delivery route panel, extracted out of the Overview page entirely (self-fetches `shipment_legs` + contract carrier fallback) and relocated to the Schedules page only.
- **Overview page consolidation**: `ShipmentDetailPage.jsx` shrunk to just the View Only banner + `ServicesPanel` — everything else (Messages/Share/Refresh/EDI/Edit actions, header identity/status, space config, route summary, cost/schedule/milestone/ticket pointer links, history, and — as of v0.30.0 — Contract & References and Cargo Details) was relocated to `ShipmentHeaderBar.jsx`, a dedicated sub-page, or removed as a redundant pointer link. `ShipmentHeaderBar.jsx` Row 1 also carries an iOS App-Library-style `IconTile` icon cluster (Messages/Share/Refresh/EDI/Edit, max 2 rows, custom hover tooltips — not native `title`) plus two mutually-exclusive badges: `⚠ Contract Mismatch` (Central contracts whose route no longer matches) and `🔄 Contract Match Found` (Pending contracts whose free-text `contractRef` now string-matches a real Active contract). Shipment history was promoted to its own page (`ShipmentHistoryPage.jsx`, bottom of the sidebar nav, `GET /api/shipments/:id/events` rewritten to the global `{results,total,limit,offset}` pagination shape).
- **Badge-vs-modal split pattern**: both `ContractMismatchModal` and `PendingRevalidationModal` follow the same shape — `ShipmentHeaderBar.jsx` (mounted once, remounts on every sub-page nav) shows only a lightweight clickable badge that navigates to Contracts & Schedules; the actual interactive modal (with Accept/Change/Dismiss actions) renders only on `ShipmentSchedulesPage.jsx`, which duplicates the same cheap revalidation `useEffect` rather than sharing state, so the fix UI never re-pops on every header remount. `PendingRevalidationModal` is exported from `ShipmentDetailPage.jsx` alongside `ScheduleHistoryPanel`. `ShipmentSchedulesPage.jsx` also restores a **Space Configuration** panel (carrier/pol→pod, contract number, validity, consumed/allocated TEU progress bar) for Central shipments with a linked `allocationId`, sourced from `GET /api/allocations/match` (already computes `consumedTEU`/`remainingTEU` server-side) filtered to the matching `id` — this had been silently dropped during the Overview consolidation above until a follow-up code review caught it.

## Recent changes (v0.31.0 "Ballast")
- **TKT-E64LKG's remaining sibling bugs**: `TKT-MS7WCD` (sailing search after contract selection doesn't scope to the contract's own routing) — `ContractAssignModal.pickContract`'s `matchedRoute` now also carries `hub` (the TSP transshipment port, when `matchedLegs.length > 1`) and `service` (`contract_legs.vessel_service`, already exposed per-leg via `mapLeg` — no backend change needed). Threaded through `ShipmentSchedulesPage.jsx`'s `routeOverride` into two new optional `SailingPickerModal` props, `expectedHub`/`expectedService` — when set, renders an info line and **sorts/badges** matching sailings first rather than hard-filtering (a hard filter would dead-end the mock/demo data, which generates hubs unrelated to any real contract). `TKT-T0HUIF` (interrupting the flow at schedule selection leaves a committed contract with no confirmation) — found already resolved by the `confirmCloseSailing` dialog shipped in v0.29.0; no code change, ticket just corrected on the board. `TKT-UONN72` (manual contract types only offer a bare reference field) — SPOT/Pending/Customer Own now collect a `CarrierCombobox` and Valid From/To (`DatePicker`) alongside the existing free-text reference; two new nullable `shipments` columns, `contract_valid_from`/`contract_valid_to`; an amber "⚠ Expired" badge shows next to the contract ref on `ShipmentSchedulesPage.jsx` once `contractValidTo` has passed (Central contracts excluded — they don't carry these fields).
- **Schedule History staleness fix** (found via a live test, no pre-existing ticket): `shipment_schedules` had no update path at all (`GET`/`POST`/`DELETE` only), and `syncShipmentFromLegs` — which keeps `shipments.etd`/`eta` in sync with `shipment_legs` on every leg change — has zero awareness the table exists. A carrier-driven ETD/ETA correction on an already-scheduled SEA leg therefore updated the shipment/header/legs table everywhere except the "Saved Sailing" audit record shown in Schedule History, which silently kept the stale original values with no warning the two disagreed. New `PUT /api/shipments/:id/schedules/:scheduleId` (`routes/shipment-ops.js`) updates the schedule row **and** the backing SEA leg(s) (first leg gets vessel/voyage/etd/carrier, last leg gets eta — handles both direct and TSP sailings) in one call, then calls `syncShipmentFromLegs`. Logs one `logEntityEvent('schedule', id, 'UPDATED', field, oldVal, newVal, ...)` per changed field, reusing the exact field/old_value/new_value diff mechanism `CostLineHistoryModal` already used for cost lines — schedule events previously only ever logged whole-row `SAVED`/`REMOVED` snapshots, never a diff. A new pencil (✎) action appears on the locked SEA leg row in `LegsTable`/`LegRow` (`ShipmentFormPage.jsx`, only when a new `onUpdateSchedule` prop is passed — only `ShipmentSchedulesPage.jsx` passes it) opening a lightweight "Update Schedule" modal, replacing the only previous option of removing the SEA leg entirely (cascades: deletes the schedule, unlocks everything, forces a full re-search) for what's usually just a minor date correction. `ScheduleHistoryPanel` (`ShipmentDetailPage.jsx`) now branches on `ev.event_type === 'UPDATED'` to render a real red-old/green-new diff instead of the vessel/pol-pod snapshot layout used for `SAVED`/`REMOVED`.
- **Cargo Ready Date guard** (new business rule, user-requested): in the live `PUT /api/shipments/:id` handler, when the incoming `cargoReadyDate` now falls after the effective `etd` **and** the shipment actually has something booked (`contractId` set or a `shipment_schedules` row exists — a plain mismatch on an unbooked shipment is a no-op), the request clears `contractId`/`contractRef`/`allocationId` (`contractType` is deliberately left as-is — lands on the same "contract type set, no ref yet" empty state `ShipmentSchedulesPage.jsx` already renders for a fresh shipment), deletes any `shipment_schedules` row with an audited `REMOVED` event (`reason: 'CRD updated past ETD'`), and forces `status` to the existing `Requires Review` value. Response carries `scheduleDropped: true` for a frontend warning toast.
- **Kanban ticket version backfill**: 78 tickets had their `version` field filled in or corrected by cross-referencing titles against `src/version.js`'s `CHANGELOG`, version-tagged comments in `server.js`'s migration array (e.g. `// v0.20.0 — shipment form Phase 1: missing operational fields`), and `AboutPage.jsx`'s per-column schema notes (e.g. `"Added v0.9.0"`) — including correcting four tickets mistagged `0.17.1` (a one-line FX-hotfix release) that actually belonged to `0.17.0`/`0.18.0`, and eight route-extraction sub-tickets under `TKT-VC28ND` that carried the literal placeholder string `"next"` instead of the `0.23.0` release they actually shipped in. ~54 smaller internal/infra tickets (Kanban housekeeping, AI-agent sub-tasks, Cypress test suites) were deliberately left blank rather than guessed — no confident match found in any of the three sources.

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
