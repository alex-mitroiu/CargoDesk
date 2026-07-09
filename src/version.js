// ─── CargoDesk — Version Registry ────────────────────────────────────────────
// Increment MAJOR.MINOR.PATCH manually before each release.
// Add an entry to CHANGELOG with a short summary of changes.

export const VERSION   = "0.25.0";
export const BUILD     = "2026-07-09";
export const CODENAME  = "Voyage";

export const CHANGELOG = [
  {
    version:  "0.25.0",
    date:     "2026-07-09",
    codename: "Voyage",
    summary:  "Shipment-level schedule bookings: new shipment_schedules table (FK → shipments, CASCADE DELETE) storing carrier, vessel, voyage, ETD, ETA, transit days, and isMock flag. Three new REST endpoints under routes/shipment-ops.js: GET /api/shipments/:id/schedules, POST (save), DELETE (remove). api.schedules namespace extended with list/save/remove. Sailing section added to ShipmentForm after Contract: SailingPickerModal (shared, extracted to src/components/shared/SailingPickerModal.jsx) lets operators search sailings with a 2/4/8/12-week window picker; new-shipment mode holds the selection in state and saves it after creation in App.jsx; edit mode saves immediately. Mock-data banner when no Maersk API key is configured. 'Apply vessel & ETD to SEA leg' shortcut button appears below the selected sailing chip when a draft SEA leg exists — copies vesselName, voyageNumber, and ETD into the leg with one click. SchedulesPanel added to ShipmentDetailPage below MilestonePanel: lists all saved sailings with vessel, service, voyage, ETD/ETA, transit, isMock badge, and saved-by info; Add Sailing button opens the shared SailingPickerModal; remove via ConfirmModal. Related Tickets panel added to ShipmentDetailPage: GET /api/tickets?shipmentId= filter added to kanban.js; RelatedTicketsPanel shows linked tickets with status dot, ID, title, assignee, and priority colour. ShipmentDetailSidebar updated with Schedules (⚓) and Tickets (◩) nav links. Health endpoint version fixed: routes/system.js now uses require('../package.json').version instead of hardcoded '0.22.0'; package.json version synced to 0.25.0. SailingPickerModal extracted from both ShipmentFormPage and ShipmentDetailPage into src/components/shared/SailingPickerModal.jsx with a selectLabel prop eliminating ~240 lines of duplication.",
  },
  {
    version:  "0.24.0",
    date:     "2026-07-07",
    codename: "Sentinel",
    summary:  "Admin security hardening: login lockout (configurable max attempts and lockout duration), JWT lifetime configurable per app_settings; token revocation via token_version column — auth() middleware validates the tv claim against DB so deactivating or revoking a user immediately invalidates all their live tokens. Admin activity log: admin_events table records USER_CREATED/UPDATED/DELETED, SESSIONS_REVOKED, SETTINGS_UPDATED, SYSMSG_CREATED/DELETED, LOGIN_LOCKED events with actor, target, and JSON details — viewable in AppSettings > Activity Log tab. Azure AD / Entra ID SSO behind feature toggle: sso_enabled app_setting gates all /api/auth/sso/* endpoints; authorization code flow using built-in fetch (no MSAL); find-or-create user on callback; local login always available as fallback. Frontend: SecuritySettingsPanel (max attempts, lockout duration, JWT lifetime), SsoSettingsPanel (toggle + tenant/client config), AdminActivityLog (paginated table with action filter). UserManagementPanel: lock badge with attempt count, Unlock button for locked accounts, Revoke Sessions button per user. LoginPage: SSO button shown when enabled, sso_token / sso_error URL param handlers.",
  },
  {
    version:  "0.23.0",
    date:     "2026-07-07",
    codename: "Portage",
    summary:  "Route extraction: all 144 HTTP routes extracted from server.js into 11 domain-scoped route files (routes/auth, shipments, allocations, mdm, kanban, customers, contracts, shipment-ops, finance, system, export) using a shared ctx factory object; server.js is now a thin orchestrator (~1 400 lines of schema/helpers/startup, zero inline route handlers). Contract leg location types: pol_loc_type and pod_loc_type selectors added to MdmContractsPage leg editor; values persisted to contract_legs via startup migration; saveLegs updated to include the new columns. Export feature: three new endpoints in routes/export.js — GET /api/export/shipments.csv produces a 34-column access-filtered CSV (joins port names, containers, and cost totals server-side); GET /api/export/dashboard/xlsx generates a fully programmatic ExcelJS workbook (4 sheets: Summary with KPI block + 6-week trend table, By Carrier, By Lane, Shipment Detail with autofilter and frozen header); GET /api/export/dashboard/template loads exports/dashboard-template.xlsx, overwrites data cells, and returns the workbook (preserves any charts added in Excel). scripts/create-export-template.js (npm run export:template) generates the base template with named ranges WeeklySummary/ByCarrier/ByLane so Excel charts auto-update on export. api.export namespace added (shipmentsCSV, dashboardXlsx, dashboardTemplate). CSV button on ShipmentsPage header; two XLSX buttons (programmatic + template) on DashboardPage Margin Overview header for side-by-side evaluation.",
  },
  {
    version:  "0.22.0",
    date:     "2026-07-05",
    codename: "Crossroads",
    summary:  "Multimodal leg UX hardening: SEA leg Movement Type and Movement By are now blank/blocked (show — and are non-editable); Pick-up and Delivery legs show — in the Carrier column (carrier code always derived from the SEA leg); Vessel and Voyage fields disabled for Pick-up/Delivery legs unless Movement By is Barge (barge registries carry IMO/Lloyd codes in multimodal documents); column order finalised — Carrier placed after ETA Date (Leg Type → Movement Type → From → Loc. Type → ETD → To → Loc. Type → ETA → Carrier → Movement By → Vessel → Voyage → Ctr. Type → Contract No.); new legs default to legType SEA on creation. Row selection + Remove Leg pattern: clicking a leg row highlights it with an accent left-border and 6% tint overlay; Remove Leg footer button activates (turns danger colour) when a row is selected, replaces per-row inline × buttons — no selection means no removal is possible. PKU/DEL flanking cells in both route summaries: ShipmentDetailPage shp-route and ShipmentFormPage shpform-route use a dynamic grid (auto 1fr auto 1fr auto) that expands to show door pick-up and delivery cells with dashed borders when Carrier's Haulage legs are present; the seaport UNLOCODE (from the SEA leg) is shown as Port of Loading / Port of Discharge while the door UNLOCODE appears in a dedicated Pick-up / Delivery flanking cell labelled with a Carrier's Haulage → arrow. Contract matching improvements: GET /api/contracts/match now accepts crd, routingTerm, pkuLocation, and delLocation query parameters; matching uses seaLeg?.pol as the contract POL instead of the door pickup UNLOCODE — fixing false negatives when a PKU leg makes the first leg's pol a door location rather than a seaport; inclusive carrier haulage logic — contracts that support haulage are shown for non-haulage shipments and are excluded only when the shipment needs haulage (DR routing term) but the contract does not support it; ContractField passes the full routing context (routingTerm, pkuLocation, delLocation, crd); contract guard relaxed to require only POL + POD (not ETD). contract_legs table extended with pol_carrier_haulage, pod_carrier_haulage, pol_haulage_locations, pod_haulage_locations columns for per-leg carrier haulage location filtering. portLanesMap live rebuild: rebuildPortLanesMap() is called after every country-trade-lane mutation (PUT /api/trade-lanes/:code/countries, POST /api/country-trade-lanes, PUT /api/countries/:iso2/trade-lanes, DELETE /api/country-trade-lanes/:iso2/:laneCode) so trade lane assignments take effect immediately without a server restart — previously the in-memory index was stale until restart. Section IDs: all major sections in ShipmentDetailPage (shp-route, shp-info-ports, shp-info-dates, shp-space) and ShipmentFormPage (shpform-parties, shpform-cargo, shpform-transport, shpform-route, shpform-containers, shpform-contract, shpform-status, shpform-actions) given stable IDs for deep-link targeting. Trade lane badge added to ShipmentDetailPage subtitle.",
  },
  {
    version:  "0.21.0",
    date:     "2026-07-04",
    codename: "Transit",
    summary:  "Routing Term engine: shipment_legs table extended with leg_type (Pick-up / SEA / AIR / RAIL / Feeder / Delivery), movement_type (Carrier's Haulage / Merchant's Haulage / SEA / Air Freight / Rail / Feeder), pol_loc_type / pod_loc_type (Door / Terminal / Container Yard / CFS), and movement_by (Barge / Rail / Truck / Vessel / Air); syncShipmentFromLegs now computes routing_term from the carrier-covered subset of legs only — Merchant's Haulage legs are excluded, so DR-CY means the carrier takes responsibility from a Door at origin through to a Container Yard at destination; routing_term is stored denormalised on the shipment and surfaced as a chip in the leg table footer (live, client-side) and in the routing banner (ShipmentDetailPage). Legs table redesigned to match standard multimodal leg structure: 14 columns in order — Leg Type, Movement Type, From (UNLOCODE), Loc. Type, Date (ETD), To (UNLOCODE), Loc. Type, Date (ETA), Carrier, Movement by, Vessel, Voyage, Ctr. Type, Contract No.; selecting a Leg Type auto-defaults Movement Type (SEA → SEA, Pick-up / Delivery → Carrier's Haulage). Trade Lane column added to the shipments list table — computed server-side from portLanesMap using the longest (most specific) lane code per UNLOCODE and formatted as EU-N → USA. Routing Term column in the shipments list shows the leg-derived term (e.g. DR-CY) or falls back to the service type abbreviation (P2P). Declared Value field: new declared_value + declared_value_currency on shipments — number input with 10-currency select on the form, display in shipment detail, and declared value row in all document builders (B/L, Commercial Invoice, Freight Invoice, Customs Declaration, Insurance Certificate). Invoice SELL-only filter: all document builders that consume cost lines now filter to type=SELL before building totals and line tables. Commodity + Declared Value merged onto one form row (1fr 1fr grid, matching the Movement Type / Service Type row above). Epic Coverage Modal: full-screen coverage analysis for Kanban Epics — phase cards, item rows, progress bar, verdict block; accessible via 📊 button on Epic cards and the preview panel. Document Readiness Overview: coverage bar + 11 doc-type rows at the top of DocumentsModal showing confirmed / draft / missing status per document type. Compliance Screening Phase Summary: ComplianceModal redesigned with Phase 1 (Parties) and Phase 2 (Routing) phase cards each with a roll-up status pill and per-check rows showing field value, description, and status icon.",
  },
  {
    version:  "0.20.0",
    date:     "2026-07-03",
    codename: "Lading",
    summary:  "Quick Container Setup: new Containers section in the new-shipment form (hidden in edit mode) — fields for Count, Container Type (ContainerTypeField typeahead + visual picker), Weight (kg), Volume (CBM), Distribution toggle (Total ÷ N or Per container copy), Cargo Description, and DG toggle with IMDG class picker; Generate button builds draft container objects shown as preview chips; containers are created sequentially via api.containers.create on shipment save and added to app state. Central Contract gate: selecting Central on a new shipment without containers queued shows a toast.warning directing the user to add cargo details first — ensures contract eligibility filtering has a container list to work with. Incoterm → Principal auto-default: changing the Incoterm field automatically sets the Principal party — C/D terms (CPT, CIP, CFR, CIF, DAP, DPU, DDP) map to the Shipper (seller pays, export-instructed); E/F terms (EXW, FCA, FAS, FOB) map to the Consignee (buyer arranges, import-instructed); only fires when the relevant party is already selected. Routing banner in ShipmentDetailPage: loads shipment legs via api.legs.list on mount to derive TSP chips (intermediate PODs); carrier code falls back to the linked contract's carrierCode when shipment.carrierCode is empty (contractCarrierCode state). Carrier code preservation fix (server): syncShipmentFromLegs now uses COALESCE(NULLIF(?, ''), carrier_code) so saving a leg with no carrier no longer overwrites the shipment's stored carrier_code with an empty string — previously cleared the carrier on any leg save.",
  },
  {
    version:  "0.19.0",
    date:     "2026-07-02",
    codename: "Muster",
    summary:  "Authentication: JWT-based login page; users table in SQLite with bcrypt-hashed passwords; 8-hour access tokens stored in localStorage; POST /api/auth/login, GET /api/auth/me, POST /api/auth/logout; admin account seeded on first startup; global auth() middleware gates all /api/* routes (exempt: /api/auth/*); 401 responses dispatch cargodesk:logout across all tabs. User Management: admin-only Users tab in Application Settings; full CRUD — create (name, email, role, password), edit (name, role, active toggle, reset password), delete with confirmation; table shows role badge, active/inactive pill, last login. RBAC: three roles — admin (full access), operator (create & edit), viewer (read-only); AuthContext provides canEdit / isAdmin / isViewer computed from effective role; role switcher in user dropdown lets admin step down to operator or viewer for preview (JWT unchanged, server unaffected). Viewer read-only: all create/edit/delete actions hidden for viewer role across every page — Shipments (New Shipment button + Delete action), Shipment Detail (Edit Shipment, Link Vessel, Add/Edit/Delete containers; View Only banner shown), Archive (Renew + Delete buttons), Integration Board (Add Ticket, card move/edit/delete, drag-to-reorder all gated), Space Configurations, Contracts, and all 9 MDM pages (Carriers, Vessels, Ports, Linked Ports, Customers, Commodities, Regions, Trade Lanes, Countries). Shipment Detail contextual sidebar: when a shipment is open in its own tab the main sidebar is replaced by a shipment-specific nav with a context card (ID, route, TEU, status), section links (Overview, Cargo Details, Accounting, Milestones) that scroll to and open the matching panel, and a smart Close Tab back button. ActionMenu guard: returns null when items array is empty so no orphan ⚙ buttons appear for viewer-role users.",
  },
  {
    version:  "0.18.1",
    date:     "2026-07-02",
    codename: "Traverse",
    summary:  "Hotfix: License & EULA page (non-commercial use terms, donation section); first-visit acceptance modal stored in localStorage; License & Terms link in sidebar nav and footer. File structure cleanup: seed scripts moved to scripts/ folder (import-mdm-data.js, seed-contracts.js, checkdb.js); npm run seed / seed:contracts / checkdb shortcuts added to package.json; all __dirname paths updated. sampleDB/ folder added with pre-loaded sample database for quick onboarding. Commodity picker grade column widened to 180px to prevent overflow. Shipments table changed to double-click to open in new tab. ContractField disabled state now names the missing field (Set ETD first…) instead of silently blocking clicks.",
  },
  {
    version:  "0.18.0",
    date:     "2026-07-02",
    codename: "Traverse",
    summary:  "Operational Accounting (renamed from Cost Control): source tracking — every cost line now carries a source field (contract / manual) and a modified_at timestamp; lines show Contract, Contract (Modified), or Manual pills in the table. Cost Line History modal: full CREATED / IMPORTED / UPDATED / DELETED audit log with filter chips and CSV export, stored in entity_events (separate from shipment history). Mirror feature: Add/Edit modal gains a ⇄ Mirror as BUY/SELL button that saves the current line and instantly creates a mirrored copy with the type flipped and all other values preserved. Container column added to the cost line table. Import fix: per-container rates are now filtered by container type (e.g. 40HC) so no phantom lines are created for non-matching equipment. Manual line preservation: recalculate (overwrite) only deletes contract-sourced BUY lines — manually added lines survive. Module renamed to Operational Accounting - Masha's Domain throughout. Shipment Milestones (new): milestone_templates and shipment_milestones DB tables; default 9-step FCL template (Booking Confirmed → SI Submitted → Cargo Gated In → Vessel Departed → B/L Issued → Vessel Arrived → Customs Cleared → Cargo Released → Delivered) seeded on startup; POST /api/shipments/:id/milestones/init auto-selects best-matching template by carrier and trade lane; MilestonePanel in shipment detail renders a vertical stepper with progress bar, per-step completed / current / overdue / upcoming states (colour-coded), inline estimated-date and note editing, mark-complete / undo, reset, and collapse toggle; overdue milestone badge on shipment rows in the list; Overdue Milestones KPI added to Landing Page Fleet Overview. Integration Board: two new columns — In Testing (cyan) and Testing Failed (red) — inserted between Done and Released; per-column Show More collapses each list to the first 5 tickets with a ▾▾ Show N more button and ▴▴ Collapse; Show/Hide Released toggle in the board toolbar (default ON, styled with the Released accent colour). REST API compliance: cost-line PUT and DELETE routes moved from /api/cost-lines/:id to /api/shipments/:shipmentId/cost-lines/:id (nested under the parent resource); api.costLines.update/remove signatures updated accordingly. Postman collection added at /src/dev/CargoDesk.postman_collection.json covering all routes in 18 resource folders, plus CargoDesk.postman_environment.json with a {{baseUrl}} variable.",
  },
  {
    version:  "0.17.1",
    date:     "2026-06-30",
    codename: "Sentry",
    summary:  "Hotfix: FX Rates health check was fetching https://api.frankfurter.app directly from the browser, triggering a CORS block (HTTP 301, no Access-Control-Allow-Origin header). Fixed by routing the health check through the existing /api/fx/rates backend endpoint, which already proxies the request server-side.",
  },
  {
    version:  "0.17.0",
    date:     "2026-06-30",
    codename: "Sentry",
    summary:  "Application Settings: new ⚙ nav item (pinned above footer) with API Controls tab; External APIs subtab — FX Rates, Weather, and OFAC SDN each have an ON/OFF toggle, configurable auto-sync recurrence (days / weeks / months), last-sync info, latency test, and action buttons; Internal APIs subtab — WebSocket, Shipments, Contracts, Customers, Carriers, Vessels, Port Locations, System Messages each have a toggle that gates the corresponding sidebar nav item (disabled modules hide from navigation and show a 🔒 Module Disabled fallback page). User Manual and About moved from sidebar nav to the user avatar dropdown. System Health respects the same toggles — disabled APIs are shown as inactive rather than failing. Sanctions & Denied Party Screening (OFAC SDN): shipments are now screened silently on every create and edit; screening runs only when the SDN index is loaded (sanctionsMap.size > 0), skips re-screening when a compliance officer has already manually overridden a result, and only re-screens on edit when party names or POL/POD change (not on ETA-only edits). Warning toast fires on save if any sanctioned party is detected, naming each hit (e.g. 'Consignee: Mahan Air'). Compliance badge in shipment detail header simplified to '⚠ Compliance review required'; hover tooltip lists each flagged party on its own line. OFAC auto-sync fixes: httpsGetFollowRedirects() follows up to 5 HTTP 302 redirects (treasury.gov redirects to ofac.treasury.gov); setTimeout overflow fixed by capping the delay at 2,000,000,000 ms (~23 days) so intervals longer than 24 days no longer collapse to 1 ms and spam-retry; failed syncs now wait 1 hour before retrying instead of immediately rescheduling from the same stale lastSync timestamp. OFAC manual import: CSV file upload path added alongside the direct-sync button (Vite large-body passthrough plugin pipes the 25 MB CSV stream directly to Express, bypassing proxy buffer limits). SDN test customers: five pre-seeded customer records covering direct SDN name match (Mahan Air), alias match (IRISL), Russian SDN entity (Rosoboronexport), and two clean control entities (Rotterdam Cargo Services B.V., Evergreen Logistics Pte. Ltd.). Shipment detail header label size increased 15% (10.5 → 12 px) for status badge, FCL chip, and compliance badge; Badge primitive gains a size prop for per-instance override.",
  },
  {
    version:  "0.16.0",
    date:     "2026-06-30",
    codename: "Courier",
    summary:  "Shipment Messages: per-shipment threaded message panel accessible via ✉️ / 📩 icon in the detail header; unread count badge tracked per shipment in localStorage; right-side drawer stays on top with semi-transparent backdrop; messages show author avatar initial, name, role, and timestamp; sort toggle (oldest / newest first) with smart auto-scroll; compose area enforces 15–500 character limit with live counter and Ctrl+Enter shortcut. Real-time delivery via WebSocket (ws package, WebSocketServer attached to the shared HTTP server on /ws path; Vite dev proxy configured); 10-second poll fallback if the socket fails to connect. Shipment Detail improvements: FCL badge in header alongside the status badge; ETD and ETA info cards now show the day-of-week and month in UTC (GMT); click the shipment ID to copy it to clipboard with toast confirmation. Contract badge redesign: SPOT / Pending / Customer Own consolidated to a solid orange badge (theme-independent); Central Contract renamed to Central with a solid blue badge; full rename across DB (migration), server, all pages, and tokens. Contract column in Shipments list: stacked layout showing badge on top and contract reference below; Carrier column also stacked (code bold / name muted). System messages: active-from / active-to inputs upgraded to datetime-local for minute-precision scheduling; active messages appear in a dedicated section of the notification bell dropdown. Requires Attention section (Landing Page): split into Space Configs tab (existing threshold alerts) and Shipment Review tab (shipments with status Requires Review), each row has an ↗ open-in-new-tab button. New-tab workflow: clicking a shipment row or the Open action in ShipmentsPage opens the shipment in a new browser tab; the detail page sets document.title to the shipment ID; a beforeunload guard warns before closing a tab with unsaved container changes. Breadcrumb updated to CargoDesk › Shipments › {ID} › Details with a clickable Shipments segment. Home icon added to the header between the notification bell and user avatar. Calendar week (CW XX) badge shown in the Landing Page clock card. Kanban version tags: tickets gain a version field populated from the CHANGELOG; the selected version renders as a purple badge on the card. Bug fix: contract_ref was absent from TRACKED_FIELDS and newVals in PUT /api/shipments/:id, so editing the Contract Reference field logged no history event — now fixed.",
  },
  {
    version:  "0.15.0",
    date:     "2026-06-30",
    codename: "Waypoint",
    summary:  "Space Configs — Linked Shipments: new action-menu item opens a read-only modal showing every shipment currently consuming that configuration's space, with a TEU progress bar and a per-row contract badge; shipments that matched via a linked-port equivalent on the carrier's contract leg show a linked badge. Config ID chip with copy-to-clipboard added to the History modal header for easier cross-referencing. Actions column header fix; setConflicts crash fix. Contract-aware TEU consumption: consumedPerAlloc and the Linked Shipments modal now filter by contractId / contractRef (not just carrier), and resolve linked-port equivalents via each contract leg's polLinkedAllowed / podLinkedAllowed flags — fixing cases where a shipment's port is a registered linked equivalent of the config's declared port but was previously excluded. Shared helpers buildLinkedPortIndex / matchedLegFor / allocationRouteMatch added to tokens.js. Dashboard — 0-TEU shipments excluded from all range calculations and displayed lists. Contract Consumption tab gains an Allocated vs Consumed TEU bar chart (utilisation per contract, green/amber/red) and a 6-week TEU trend line chart per contract number; Shipments in Period table gains drag-to-resize columns with localStorage persistence. Shipment Detail — ContainerTypePickerModal: clicking the Equipment Type field now opens a visual picker grouped by 20ft / 40ft, showing equipment code, label, description and TEU value per option. server.js — contracts list now batches leg fetching via a single IN query instead of N+1 lookups.",
  },
  {
    version:  "0.14.0",
    date:     "2026-06-29",
    codename: "Logbook",
    summary:  "Entity audit log: entity_events table tracks CREATED/UPDATED/DELETED events across allocations, carriers, and contracts; GET /api/entity-events/:type/:id bridges shipment_events for the shipment type so all history queries share a single endpoint. ActionMenu: cog (⚙) button replaces individual Edit/Delete buttons on Shipments, Carriers, and Contracts — opens a position:fixed dropdown with Edit, History, and Delete items. EntityHistoryModal renders a timestamped event timeline with field diffs and meta pills, reused across entities. Space Configurations promoted to a standalone sidebar page (Dashboard › Space Configurations) with per-allocation lifetime consumption bars, 6-week sparklines, mandatory contract linking via contract picker, and ActionMenu per row. Dashboard simplified to Overview + Contract Consumption tabs (read-only, no CRUD). Space config fixes: Effective From date picker blocks past dates on new allocations; conflict detection now distinguishes same-contract duplicates (hard block) from cross-contract overlaps on the same lane (amber warning, allowed).",
  },
  {
    version:  "0.13.0",
    date:     "2026-06-29",
    codename: "Manifest",
    summary:  "Shipper / Consignee / Principal: three mandatory party fields on every shipment form, backed by CustomerCombobox — typeahead suggestions plus a 🔍 full picker modal; stored as ID + denormalised name (6 new DB columns); parties section promoted to top of the create/edit modal. Requires Review status: new purple shipment status with matching badge variant and theme tokens. FCL badge: Type column added to shipments list showing a blue FCL badge on every row. CSV export: one-click ↓ Export CSV button on the shipments list producing one row per container (25 columns) as a browser download. Kanban ticket types: Feature / Bug / Improvement / Task / Chore selector with colour-coded badges; Task hidden on cards to keep them clean. Customers search filters: Country, City, Customer Code inputs plus a manual Search button added to the Customers MDM page and mirrored in the Select Customer picker modal for consistency. Countries View Locations fix: GET /api/countries/:iso2/locations endpoint was missing — added with search + pagination. Resizable columns: drag-to-resize handles on every data table throughout the app (Shipments, Dashboard, Shipment containers, all 10 MDM pages); widths persist to localStorage per table.",
  },
  {
    version:  "0.12.0",
    date:     "2026-06-29",
    codename: "Starboard",
    summary:  "Customers MDM: new module with full CRUD — company name, address (line 1/2, city, state, postal code, country ISO2), phone, fax, email, website, notes. Shipment list filters: search by ID/POL/POD/booking ref, filter by status and carrier with live clear button. Landing page KPI cards: Over Threshold and Configs Expiring added to Fleet Overview. Home page Requires Attention section: active allocations above their alert threshold shown with utilisation bar, route, and expiry, sorted worst-first. Kanban tickets linked to shipments: shipment_id FK, optional shipment selector in ticket modal, shipment chip on cards. Notification bell: live badge count for above-threshold allocations; clicking opens a dropdown listing up to 5 offending lanes (carrier, POL › POD, utilisation %) sorted worst-first, each entry navigates to the Dashboard. Countries MDM portCount fix: mapCountry now forwards port_count from LEFT JOIN.",
  },
  {
    version:  "0.11.0",
    date:     "2026-06-29",
    codename: "Meridian",
    summary:  "Shipment History Tracker: shipment_events table logs every field change, container add/remove/update automatically — rendered as a colour-coded vertical timeline on the detail page. Kanban drag-to-reorder within columns with live drop indicators and optimistic updates. Countries MDM: port count fixed via LEFT JOIN + startup country_code backfill. Trade Lanes: country count and assignment endpoints added. Port locations: last_synced_at column + delta-sync pattern in import script. Loading spinners (FullPageSpinner, PageSpinner, inline Spinner) across all MDM pages and form save buttons. URL hash includes shipment ID for deep links. Duplicate key and missing import fixes.",
  },
  {
    version:  "0.10.0",
    date:     "2026-06-28",
    codename: "Compass",
    summary:  "Space Configs: POL/POD required, auto trade-lane detection, linked-port conflict detection. Commodities MDM: 294 Maersk codes, CommodityCombobox, mandatory on shipments. Containers: HS Code + Cargo Description split, gross weight, volume, DG/IMDG class. Light/Dark theme. Global toast system. URL hash navigation. Status audit trail.",
  },
  {
    version:  "0.9.0",
    date:     "2026-06-28",
    codename: "Anchor",
    summary:  "Container freight fields (commodity, weight, volume, DG/IMDG). User Manual DG Classes reference. Footer + About page with interactive DB schema. Version registry.",
  },
  {
    version:  "0.8.0",
    date:     "2026-06-28",
    summary:  "Space Configs: POL/POD, auto trade-lane badges, conflict detection. Dashboard Archive page. 6-week TEU trend line chart. Sparklines + delta badges per allocation row.",
  },
  {
    version:  "0.7.0",
    date:     "2026-06-28",
    summary:  "Space Configs: trade lane, alert threshold, notes. Dashboard Archive + Renew flow.",
  },
  {
    version:  "0.6.0",
    date:     "2026-06-27",
    summary:  "Contract ID field. DatePicker 3-level navigation, smart viewport flip.",
  },
  {
    version:  "0.5.0",
    date:     "2026-06-27",
    summary:  "MDM Vessels: 349 vessels from IMO registry. Modular refactor into 27 source files.",
  },
  {
    version:  "0.4.0",
    date:     "2026-06-27",
    summary:  "Landing page with weather widget, fleet stats, upcoming departures.",
  },
  {
    version:  "0.3.0",
    date:     "2026-06-27",
    summary:  "Integration Board (Kanban): Ready / In Progress / Done / Released.",
  },
  {
    version:  "0.2.0",
    date:     "2026-06-27",
    summary:  "MDM: 8 modules, 14,269 ports seeded. Shipment detail with container management.",
  },
  {
    version:  "0.1.0",
    date:     "2026-06-26",
    summary:  "Initial build: shipments, containers, Express + SQLite backend, React 18 + Vite frontend, dark design system.",
  },
];

export const COPYRIGHT_YEAR  = "2026";
export const COPYRIGHT_OWNER = "CargoDesk";