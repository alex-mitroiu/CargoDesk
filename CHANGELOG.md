# Changelog

Full release history for CargoDesk. See [README.md](README.md#changelog) for the most recent
releases and [src/version.js](src/version.js) / the in-app About page for the same history with
implementation-level detail.

| Version | Codename | Summary |
|---------|----------|---------|
| 0.91.7 | Landfall | Bundled release — closes out the Office-Side Permissions Epic (TKT-Z0LB0W, all 6 phases Released: per-shipment relative office-side scoping, fixed-side write gates, a vessel-arrived import-office-handoff Kanban trigger, and a 50-assertion regression suite) and completes the Trade Horizon restyle across every remaining Shipment Details page — Cargo and History get a stat strip and a real table, Involved Offices and Export/Import Services flatten to one card per side with a Your Side/Read-only badge, Invoice Entry/Cost Entry/GP Overview round out Accounting, and Shipping Instructions, Documents, Carrier Booking and Customs Filing move onto the same tokens in their existing layout; fixes a real bug where several new colour lookups didn't follow the app's live light/dark toggle, and a separate pre-existing bug where the Carrier Booking/Customs Filing Details↔Review tab strip could go stale when navigated to while the page was already mounted. |
| 0.91.6 | Concourse | Bundled release — the shared Shipments-style table system (column-header checklists, search, sort, paging) now runs on every list page: Quotes, Opportunities, Contracts, Customers, Freight Audit (both tabs), Credit Overrides, Schedule Search and Space Configurations; Space Configurations splits Trade Lane into Origin Trade and Destination Trade; Quotes, Opportunities, Reports, Freight Audit and Credit Overrides move into a new Financials sidebar group with a hub page of live counts; the shared Modal closes on Escape; and the shipment header's Loop route modal, which could not be closed, is fixed along with every other overlay that header opens. |
| 0.91.5 | Chartroom | Bundled release — Master Data gains a real Eastbound/Westbound loop-rotation editor (Loop Codes, one tabbed edit modal, a port allowed in both directions, AL1 now the real Hapag-Lloyd rotation) and a new HS Codes registry with a live, never-stored EU classification lookup, and the free-text HS Code inputs on cargo forms become a registry-backed picker; the Trade Horizon design (Dashboard, Shipment Details) now has a full light theme that follows the app toggle; dropdowns that opened far from their input inside glass cards (Equipment Type, HS Code) are now portaled; Quotes is rebuilt on a new shared Shipments-style table system (column-header checklists, search, sort, server-side paging) as the pilot for the other list pages; the Shipment Details sidebar gains a collapsible icon rail, group folding and a milestone vitals card; the CRD/ETD contract guard, contract-match dedup and space-configuration search get real fixes; and CI is green again after being red since v0.91.3 — every backend test and Cypress spec now provisions its own offices and the backend login cap is raised to 1000. |
| 0.91.4 | Ratify | Fix wave — Contract Picker no longer lets a re-opened "Change Contract" silently reselect the already-assigned contract, and a card click now stages behind an explicit Confirm/Cancel step; fixed an app-wide modal background-scroll leak; fixed a real data bug where a stale Cargo Ready Date/ETD mismatch could permanently block a shipment from ever having a contract set again. |
| 0.91.3 | Horizon | Command Center restyled to Trade Horizon with Excel-style column filters (Shipments + Dashboard) and a bell contract-deep-link fix; the full Shipment Details experience (header, sidebar, Overview/Conditions/Parties & Offices/Contracts & Schedules/Cargo/Milestones & Events) restyled to match; shipment-integrity fix wave (required EMO/IMO offices, container-number uniqueness, non-negative declared value). |
| 0.91.1 | Bulkhead | Hotfix — User Management/access-scoping redesign (Branch/Country office-visibility grants, a new `sales` role, Quotes/Opportunities office scoping) plus a shipment creation/editing deep-dive; 8 real findings across both QA passes fixed same day, including an office-reassignment authorization bypass and a silent full-replace on shipment edits. |
| 0.91.0 | Interchange | Real multi-carrier API integration (DCSA Booking v2.0.5, adapter-registry pattern); added Shipping Instructions and closed 4 more FCL export gaps; closed all 9 Space Configuration & Allocation Consumption gaps (badge UI, Dashboard/allocation-engine reconciliation, cascading cancel, real FKs); Kanban page split into focused components; changelog history extracted to this file. |
| 0.90.3 | Ledger's Edge | Closed out the 37-route-file Shipment-Domain Gap & Dead-Code Audit — 5 real findings fixed (2 critical scope bypasses); shipped Rate Reconciliation for carrier cost import/update conflicts. |
| 0.90.2 | Ol' Scratch | Fixed a real pglite database-corruption bug (concurrent `npm run seed` + a live server) with an OS-level exclusive lock; added `npm run setup` to automate the correct one-time onboarding order. |
| 0.90.1 | Bulwark | Added a Loop Codes MDM registry with a rotation-timeline viewer and a graceful dev-server shutdown button; fix wave covering ETA/ETD leg-ordering, duplicate sailing results, and an admin-password-policy bypass. |
| 0.90.0 | Blueprint | Added House B/L lifecycle status tracking (Issued/Surrendered/Released) and a free-form Document Template Editor (BL01 pilot); fixed a shipment-edit regression that could silently clear POL/POD. |
| 0.89.0 | Arbiter | Added a Line Agent ambiguity picker — surfaces every tied candidate instead of silently guessing when a port has more than one registered agent for a carrier. |
| 0.88.0 | Custody | Added whole-shipment edit-locking so two concurrent editors can't produce conflicting writes; a stale lock self-clears after 30 minutes. |
| 0.87.0 | Consortium | Closed 4 Kanban tickets found already shipped on re-audit; added NVOCC co-loading/cross-tariff reference, the last gap in that epic. |
| 0.86.0 | Slate | Added an admin "Reset Demo Data" panel — wipes business data back to a clean slate on demand while preserving MDM/config data, with a preview and a typed confirmation gate. |
| 0.85.0 | Approach | Bundled release: a CRM pre-sales pipeline (Opportunities), a Confirmed/Pending/Rejected TEU consumption split (replacing one lumped total), and multi-tab-aware idle-timeout auto-logout. |
| 0.84.0 | Capstone | Extracted the Customer/Organization Service (5th and final planned microservice cut), completing the Organization Model roadmap begun at v0.56.0. |
| 0.83.0 | Berth | eAdapter carrier-EDI configs are now scoped per office, not just per carrier, matching how carriers actually negotiate EDI access. |
| 0.82.0 | Gantry | Extracted the Kanban/Testing Service (third of three planned database-per-domain cuts), completing that extraction plan. |
| 0.81.0 | Warden | Extracted the Screening Service (second of three cuts); fixed a real bug where the in-memory sanctions cache wasn't refreshing after a sync. |
| 0.80.0 | Atlas | Extracted the MDM Service (first of three planned database-per-domain cuts) — carriers/vessels/ports/lanes now optionally served by a standalone process. |
| 0.79.0 | Keel | Added eAdapter (per-carrier EDI configuration behind one master toggle) and zero-script onboarding via a committed MDM reference database. |
| 0.78.0 | Tonnage | Standardized table pagination app-wide, most importantly making the Shipments list server-side-paginated instead of holding the whole fleet in browser memory. |
| 0.77.0 | Overwatch | Added Command Center Quality & Exception Management — fleet-wide milestone on-time KPIs, a root-cause-classified exception queue, and a carrier on-time scorecard. |
| 0.76.0 | Remittance | Shipped the Billing Performance report (filterable, enriched invoice-level view) — 4th of 5 planned Invoicing Discipline stories. |
| 0.75.1 | Remittance | Added a per-customer invoice-generation deadline, surfaced via the notification bell. |
| 0.75.0 | Remittance | Added Mark as Paid (real payment-receipt records) and a denormalized "first sent" signal for invoices. |
| 0.74.0 | Solvency | Closed the Credit Control Depth epic — credit-hold/over-limit override authority now belongs exclusively to the shipment's own lane trade manager; over-limit is now a real hard block. |
| 0.73.1 | Solvency | Extended credit-hold enforcement to carrier-booking send (a real, server-enforced block) alongside the existing invoice-generation gate. |
| 0.73.0 | Solvency | Deepened Credit Control with real AR-aging buckets, committed exposure, parent/group rollup, and per-customer currency. |
| 0.72.3 | Clearance | Fixed a real CI timeout — the PDF Render Service's browser now warms eagerly at boot instead of on first document-generation call. |
| 0.72.2 | Clearance | Pushed backend test coverage from 76.56% to 90.15% (631 new assertions across 17 files) via measured V8 coverage. |
| 0.72.1 | Clearance | Removed the obsolete Maersk developer-tools integration; schedule search and carrier booking are now explicitly catalog/demo-only. |
| 0.72.0 | Clearance | Added a sea-freight fundamentals User Manual chapter and closed the 10-story "Missing Manifest" epic (Export Filing ↔ Pickup Service integration). |
| 0.71.0 | Docket | NVOCC readiness audit — added the NVOCC party role, FMC licensing fields, correct shipper-of-record on booking requests, and an independent Master B/L document. |
| 0.70.0 | Waypoint | Added AI-driven document extraction, the Quoting/RFQ pre-booking stage, and a 12-chapter illustrated Field Guide user manual. |
| 0.69.0 | Custodian | Competitive gap analysis vs. 8 industry platforms; shipped Freight Audit & Payment and multi-list denied-party screening (12 lists total). |
| 0.68.0 | Junction | Added Multi-Routing-Per-Contract (several priced physical paths per lane) and extracted the Contract Management Service. |
| 0.67.0 | Drydock | Closed real indexing/transaction/money-rounding gaps found on architecture re-review; shipped a first-draft (untested) Docker deployment path. |
| 0.66.0 | Bulkhead | Fixed a CI pipeline that had never actually run; added frontend test coverage (Vitest) and extracted the PDF Render Service. |
| 0.65.1 | Ballast | Extracted `server.js`'s pure row-mapper functions into `lib/mappers.js` — no behavior change, 3230 → 2984 lines. |
| 0.65.0 | Ballast | Dead-code audit — removed an entire unreachable duplicate route tail from `server.js` (5300 → 3230 lines) plus several unreferenced legacy files. |
| 0.64.0 | Relay | Added Document Distribution (EDI + Webhook send channels) as CargoDesk's first extracted microservice. |
| 0.63.0 | Beacon | Added GPS-coordinate Pickup/Delivery for classified-location customers who can't be identified by a UN/LOCODE. |
| 0.62.1 | Waypoint | Fixed a schedule-correction route that updated a sailing's own fields but left its underlying leg-key data stale. |
| 0.62.0 | Waypoint | Added Content-Keyed Sailing Legs — schedule legs are now deduplicated by physical-sailing content instead of every schedule owning fresh unshared rows. |
| 0.61.0 | Liaison | Added Carrier Line Agents — a carrier's local representative, resolved automatically per port onto shipments as an additional party. |
| 0.60.0 | Census | Reworked customer roles from a hand-maintained checkbox editor into a derived, self-correcting signal computed from actual usage. |
| 0.59.1 | Lineage | Fixed a real bug where generated freight invoices completely omitted VAT despite the in-app summary showing it correctly. |
| 0.59.0 | Lineage | Added Customer Hierarchy — parent/subsidiary rollup for margin reporting and booking context. |
| 0.58.0 | Sentinel | Extended sanctions screening from 3 to all 13 possible shipment party-role slots, with auto-re-screen on any change. |
| 0.57.0 | Covenant | Added Credit Control — a customer credit hold now hard-blocks new invoice generation; over-limit is a soft warning. |
| 0.56.0 | Roster | Added per-customer Contacts and Roles as the first epic of a 5-part Organization Model roadmap. |
| 0.55.1 | Transponder | Corrected the AIS design so confirmed departure/arrival updates ETD/ETA in place instead of a separate ATD/ATA pair; four unrelated live bugs fixed. |
| 0.55.0 | Transponder | Added AIS Integration — live vessel-tracking data keeps the Vessels registry fresh and auto-detects actual departure/arrival, non-destructively. |
| 0.54.3 | Catalog | Fixed transit time showing "0d" on TSP schedules — now derived from the whole-journey ETD→ETA span. |
| 0.54.2 | Catalog | Fixed a TSP built entirely inside the Configure Legs modal being wrongly blocked from generating. |
| 0.54.1 | Catalog | Fixed stale mock schedules resurfacing as real catalog matches, and added real vessel/carrier pickers to the TSP leg editor. |
| 0.54.0 | Catalog | Decoupled the Schedule Generator from shipments; Add Sailing search now checks the stored catalog before falling back to live/demo data. |
| 0.53.0 | Voucher | Added Invoice Reversal / Debit-Credit Note workflow for confirmed invoices. |
| 0.52.0 | Manifest | Completed the CargoWise-Aligned Carrier Booking epic — vessel IMO, CRD, party names, and a grouped DG declaration added to the booking-request payload. |
| 0.51.0 | Signet | Document generation moved server-side with real, tamper-evident CAdES/PKCS#7 PDF signing. |
| 0.50.2 | Declaration | Fixed the Schedules tab flashing "No legs yet" instead of a loading spinner. |
| 0.50.1 | Declaration | Fixed the New Shipment form's SEA leg row not visually updating after applying a sailing. |
| 0.50.0 | Declaration | Closed the FCL-completeness roadmap's final epic: Customs & Regulatory Filing (simulated AES/EEI + ISF/AMS). |
| 0.49.0 | Appraisal | Added structured per-item cargo value/currency/HS code, feeding a real cargo value rollup and per-line invoice/packing-list rows. |
| 0.48.0 | Muster | Added a flexible party model — Forwarder, Customs Broker, Trucker, Bank, Insurance Provider, and more, beyond the original 4 fixed roles. |
| 0.47.2 | Consignment | Added the ability to edit a dedicated service's vendor/office after it's been requested. |
| 0.47.1 | Consignment | Fixed a layout bug that buried the Containers page's Save/Cancel buttons in a small nested scroll box. |
| 0.47.0 | Consignment | Redesigned Cargo Manifest & Container Details into one unified tree + detail-panel page, with per-pallet DG classification. |
| 0.46.1 | Stowage | Fixed three linked schedule/booking bugs found live: a freshly-added leg locked while scheduled, its removal wiping the real schedule, and a stale header after unlinking. |
| 0.46.0 | Stowage | Added a typed pack hierarchy (Pallet/Carton/Case/etc.) to the container cargo manifest, admin-maintained via a new Pack Types registry. |
| 0.45.1 | Manifest | Fixed loading-delay UI gaps that briefly read as "not configured" instead of "still loading." |
| 0.45.0 | Manifest | Moved Pickup back into Export Services; enforced a hard floor of 1 on per-container plan sequence numbers. |
| 0.44.2 | Wayfinder | Promoted the already-saved admin sidebar order to the hardcoded default. |
| 0.44.1 | Wayfinder | Cleaned up Carrier Booking Details/Review; added a Contract & Customer summary card. |
| 0.44.0 | Wayfinder | Added admin-only drag-and-drop reordering for the shipment Explorer sidebar's top-level sections. |
| 0.43.0 | Reroute | Any not-yet-confirmed carrier booking is now auto-cancelled and superseded the moment its carrier changes, with full archived history. |
| 0.42.1 | Compass | Removed "Haulage" from the Services catalog — a generic duplicate of what Pickup/Delivery already model directly. |
| 0.42.0 | Compass | Export/Import Services now restrict which service types can be ordered per side, matching real-world usage. |
| 0.41.3 | Logbook | Fixed a race where clicking Generate right after editing a row could bake a stale value into the produced document. |
| 0.41.2 | Logbook | Fixed a Currency field misalignment on the New Shipment form's Cargo section. |
| 0.41.1 | Logbook | Closed two gaps in the 0.41.0 carrier-booking-history fix: Send/Confirm bypassing the archive check, and a contract-carrier-change never updating an already-assigned schedule. |
| 0.41.0 | Logbook | Added real carrier-booking history — a superseded booking is archived under its own id instead of being silently overwritten. |
| 0.40.1 | Haulier | Fixed DatePicker's calendar popover rendering clipped inside scrolling containers. |
| 0.40.0 | Haulier | Split "Pickup/Delivery" into two dedicated pages; grouped Schedules/Carrier Booking/Pickup/Delivery under a new "Booking & Routing" section. |
| 0.39.1 | Tally | Fixed a systemic form-field misalignment at its root (the shared Field primitive's label/hint layout). |
| 0.39.0 | Tally | Added an equipment summary (containers grouped by size/type) to the outbound carrier booking-request payload. |
| 0.38.1 | Waybill | Fixed the Carrier Booking gate wrongly blocking shipments with a fully hand-entered route and no formal "Add Sailing" run. |
| 0.38.0 | Waybill | Carrier bookings now auto-create the moment a shipment has both a contract and a schedule, instead of waiting for a manual Send. |
| 0.37.1 | Almanac | Rebuilt Carrier Booking as in-page Details/Review tabs, matching the original tabs requirement. |
| 0.37.0 | Almanac | Added a real vessel IMO and ATD/ATA to schedules; schedules can now be linked across multiple shipments without duplication. |
| 0.36.0 | Beacon | Startup migration failures are no longer silently swallowed; added a Carrier Bookings notification-bell section; lazy-loaded the Kanban page to shrink the initial bundle. |
| 0.35.1 | Charter | Fixed a silent bug where applying a sailing to a shipment with no leg yet was a no-op despite reporting success. |
| 0.35.0 | Charter | Carrier Booking became its own Details/Review sub-page family, replacing the old EDI messages drawer. |
| 0.34.5 | Ledger | Security review response — fixed a stored-XSS hole in Kanban diagrams, added per-IP login rate limiting and a full password-expiry policy. |
| 0.34.4 | Ledger | Added a second icon family to cover the remaining anchor/search/messaging glyphs the first one lacked. |
| 0.34.3 | Ledger | Completed the icon-replacement pass across the remaining shipment sub-pages; nav fold state now persists. |
| 0.34.2 | Ledger | Fixed the main nav silently clipping its last item on shorter screens; extended icon replacement past the sidebar. |
| 0.34.1 | Ledger | Replaced the sidebar's emoji icon set with real SVG icons for cross-platform consistency. |
| 0.34.0 | Ledger | Added an accrual→actualized→posted cost-line state machine with GP variance, automated per-container charge codes, a container cargo-pallet breakdown, and Carrier Payment Indicator tracking. |
| 0.33.0 | Gangway | Extended Export/Import Services to every ordered service type via a shared generic page. |
| 0.32.0 | Stevedore | Added dedicated per-service configuration pages, starting with a real Loading Service page (per-container plan + generated document). |
| 0.31.0 | Ballast | Closed remaining Contracts & Schedules bugs; fixed schedule-history staleness after a carrier-driven correction; added a Cargo Ready Date guard against booking a shipment past its own ETD. |
| 0.30.0 | Fairway | Added the FCL container compliance trio — VGM, CY cutoff, and Demurrage/Detention free-time tracking. |
| 0.29.0 | Bearing | Added the persistent Shipment Header (visible across every sub-page) and Dedicated Services (Export/Import) dashboard. |
| 0.28.0 | Waypoint | Separated the test-case repository from Kanban tickets; added EDI Messaging and FCL container lifecycle events. |
| 0.27.0 | Lookout | Reworked Command Center with filterable KPI cards, a ticket alert card, and a fixed-layout that scales to any viewport. |
| 0.26.0 | Meridian II | Added an AI Agent chat drawer with a tool-calling loop over shipment/contract/allocation data. |
| 0.25.0 | Voyage | Added shipment schedule bookings — live/demo sailing search with a shared picker modal. |
| 0.24.0 | Sentinel | Added login lockout, token revocation, configurable JWT lifetime, Azure AD/Entra SSO, and an admin activity log. |
| 0.23.0 | Portage | Extracted all 144 HTTP routes from `server.js` into 11 domain-scoped route files; added CSV/XLSX export. |
| 0.22.0 | Crossroads | Hardened multimodal leg UX (locked derived fields, row-selection model) and inclusive carrier-haulage contract matching. |
| 0.21.0 | Transit | Added the Routing Term engine, a 14-column multimodal legs table, and Declared Value tracking. |
| 0.20.0 | Lading | Added Quick Container Setup on the New Shipment form and an Incoterm → Principal auto-default. |
| 0.19.0 | Muster | Added authentication (JWT + bcryptjs) and three-role RBAC (admin/operator/viewer). |
| 0.18.1 | Traverse | Added the License & EULA acceptance flow; moved seed scripts into `scripts/`. |
| 0.18.0 | Traverse | Added Operational Accounting cost-line history and the Shipment Milestones stepper. |
| 0.17.1 | Sentry | Hotfix: FX Rates health check CORS block. |
| 0.17.0 | Sentry | Added Application Settings (feature toggles) and OFAC/SDN sanctions screening. |
| 0.16.0 | Courier | Added real-time threaded Shipment Messages over WebSocket. |
| 0.15.0 | Waypoint | Added the Linked Shipments modal and contract-aware TEU consumption. |
| 0.14.0 | Logbook | Added a generic entity audit log and promoted Space Configurations to its own page. |
| 0.13.0 | Manifest | Added Shipper/Consignee/Principal party fields, CSV export, and resizable columns. |
| 0.12.0 | Starboard | Added Customers MDM, shipment list filters, and the notification bell. |
| 0.11.0 | Meridian | Added the shipment history audit trail and Kanban drag-to-reorder. |
| 0.10.0 | Compass | Added space-config conflict detection, Commodities MDM, and light/dark theme. |
| 0.9.0 | Anchor | Added container freight fields, the User Manual, and the About page. |
| 0.8.0 | — | Added Space Config conflict detection and Dashboard Archive with TEU trend charts. |
| 0.7.0 | — | Added trade-lane/alert-threshold fields to Space Configs and the Renew flow. |
| 0.6.0 | — | Added the Contract ID field and a 3-level DatePicker. |
| 0.5.0 | — | Added Vessels MDM (349 ships) and a modular 27-file refactor. |
| 0.4.0 | — | Added the Landing Page with a weather widget and fleet stats. |
| 0.3.0 | — | Added the Integration Board (Kanban). |
| 0.2.0 | — | Added core MDM (8 modules, 14,269 ports) and container management. |
| 0.1.0 | — | Initial build: shipments, containers, Express + SQLite backend, React 18 + Vite frontend. |
