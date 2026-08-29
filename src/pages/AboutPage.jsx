import { T } from "../tokens";
import Badge from "../components/primitives/Badge";
import React from "react";
import { VERSION, BUILD, BUILD_FINGERPRINT, CODENAME, CHANGELOG, COPYRIGHT_YEAR, COPYRIGHT_OWNER } from "../version";
import { IconSettings, IconAnchor, IconBaseStation, AnyIcon } from "../components/primitives/Icon";

// ─── About Page ───────────────────────────────────────────────────────────────


  const DB_SCHEMA = [
    {
      table: "shipments",
      description: "Core operational table — one row per ocean freight booking.",
      columns: [
        { name: "id",            type: "TEXT PK",  note: "Auto-generated SHP-XXXX identifier" },
        { name: "pol",           type: "TEXT",     note: "Port of Loading — 5-char UN/LOCODE" },
        { name: "pod",           type: "TEXT",     note: "Port of Discharge — 5-char UN/LOCODE" },
        { name: "carrier_code",  type: "TEXT",     note: "SCAC carrier code (FK → carriers)" },
        { name: "contract_type", type: "TEXT",     note: "SPOT | Customer Own | Pending" },
        { name: "contract_id",   type: "TEXT",     note: "Contract reference number — added v0.6.0" },
        { name: "contract_notes",type: "TEXT",     note: "Free-text contract remarks" },
        { name: "status",        type: "TEXT",     note: "Active | Pending | Completed | Cancelled" },
        { name: "incoterm",      type: "TEXT",     note: "Incoterms® 2020 code (EXW…DDP)" },
        { name: "etd",           type: "TEXT",     note: "Estimated Time of Departure — ISO date" },
        { name: "eta",           type: "TEXT",     note: "Estimated Time of Arrival — ISO date" },
        { name: "booking_ref",   type: "TEXT",     note: "Carrier booking reference" },
        { name: "bl_number",     type: "TEXT",     note: "Bill of Lading number" },
        { name: "vessel",        type: "TEXT",     note: "Vessel display name (legacy/display only)" },
        { name: "vessel_imo",    type: "TEXT",     note: "IMO number — FK → vessels. Added v0.5.0" },
        { name: "commodity_code", type: "TEXT",     note: "FK → commodities. Maersk freight type — mandatory. Added v0.10.0" },
        { name: "voyage",        type: "TEXT",     note: "Voyage/Loop identifier" },
        { name: "created_at",    type: "TEXT",     note: "ISO timestamp of record creation" },
      ],
    },
    {
      table: "containers",
      description: "Container-level cargo detail. Cascades on shipment delete.",
      columns: [
        { name: "id",               type: "TEXT PK",  note: "Auto-generated CTR-XXXX identifier" },
        { name: "shipment_id",      type: "TEXT FK",  note: "Parent shipment → ON DELETE CASCADE" },
        { name: "container_number", type: "TEXT",     note: "ISO 6346 container ID (e.g. MAEU1234567). Renamed from 'number' — v0.9.0 migration" },
        { name: "seal_number",      type: "TEXT",     note: "Customs seal number. Added v0.9.0" },
        { name: "size",             type: "TEXT",     note: "20 (1 TEU) | 40 (2 TEU)" },
        { name: "type",             type: "TEXT",     note: "DC | RF | OT | FR | TK" },
        { name: "hs_code",          type: "TEXT",     note: "HS / customs tariff code for this container's cargo. Renamed from 'commodity' — v0.10.0 migration" },
        { name: "gross_weight_kg",  type: "REAL",     note: "Total gross weight in kilograms. Added v0.9.0" },
        { name: "volume_cbm",       type: "REAL",     note: "Cargo volume in cubic metres (CBM). Added v0.9.0" },
        { name: "is_dg",            type: "INTEGER",  note: "Dangerous goods flag (0/1). Added v0.9.0" },
        { name: "dg_class",         type: "TEXT",     note: "IMDG class code (e.g. 3, 6.1). Added v0.9.0" },
      ],
    },
    {
      table: "allocations",
      description: "Carrier space configurations — TEU awarded per carrier, route, and period.",
      columns: [
        { name: "id",               type: "TEXT PK",  note: "Auto-generated ALC-XXXX identifier" },
        { name: "carrier_code",     type: "TEXT FK",  note: "SCAC carrier code → carriers" },
        { name: "pol",              type: "TEXT",     note: "Port of Loading — required. Added v0.8.0" },
        { name: "pod",              type: "TEXT",     note: "Port of Discharge — required. Added v0.8.0" },
        { name: "origin_lane",      type: "TEXT",     note: "Auto-detected origin trade lane code. Added v0.8.0" },
        { name: "dest_lane",        type: "TEXT",     note: "Auto-detected destination trade lane code. Added v0.8.0" },
        { name: "trade_lane",       type: "TEXT",     note: "Combined reference (origin_dest). Added v0.7.0" },
        { name: "allocated_teu",    type: "INTEGER",  note: "TEU capacity awarded for this period" },
        { name: "effective_date",   type: "TEXT",     note: "Config validity start — ISO date" },
        { name: "end_date",         type: "TEXT",     note: "Config validity end — ISO date" },
        { name: "alert_threshold",  type: "INTEGER",  note: "Utilisation % that triggers warning (default 80). Added v0.7.0" },
        { name: "notes",            type: "TEXT",     note: "Contract caveats, rollover terms. Added v0.7.0" },
        { name: "coverage_scope",   type: "TEXT",     note: "STRICT | LINKED | CONTRACT:id — reserved for Contract Management. Added v0.8.0" },
        { name: "contract_id",      type: "TEXT",     note: "FK → contracts. Mandatory from v0.14.0 — links the space config to a signed contract." },
        { name: "contract_number",  type: "TEXT",     note: "Denormalised contract number for display without a JOIN. Added v0.14.0" },
      ],
    },
    {
      table: "carriers",
      description: "Shipping line master data.",
      columns: [
        { name: "code",       type: "TEXT PK", note: "SCAC code (e.g. MAEU, HLCU, MSCU)" },
        { name: "name",       type: "TEXT",    note: "Full carrier name" },
        { name: "short_name", type: "TEXT",    note: "Abbreviated name. Added post v0.1.0" },
      ],
    },
    {
      table: "vessels",
      description: "IMO vessel registry — 349 vessels imported from IMO data.",
      columns: [
        { name: "imo",           type: "TEXT PK",  note: "7-digit IMO vessel number" },
        { name: "name",          type: "TEXT",     note: "Ship name (uppercase)" },
        { name: "asset_type",    type: "TEXT",     note: "Vessel type (e.g. Container Ship, Bulk Carrier)" },
        { name: "flag_iso2",     type: "TEXT",     note: "Country flag ISO2 code — soft FK to countries" },
        { name: "flag_name",     type: "TEXT",     note: "Country flag display name" },
        { name: "build_year",    type: "INTEGER",  note: "Year of construction" },
        { name: "gross_tonnage", type: "INTEGER",  note: "Gross tonnage (GT)" },
      ],
    },
    {
      table: "port_locations",
      description: "14,269 UN/LOCODE seaports — seeded from UN data.",
      columns: [
        { name: "unlocode",     type: "TEXT PK",  note: "5-char UN/LOCODE (e.g. NLRTM, CNSHA)" },
        { name: "name",         type: "TEXT",     note: "Port name" },
        { name: "latitude",     type: "REAL",     note: "Geographic latitude" },
        { name: "longitude",    type: "REAL",     note: "Geographic longitude" },
        { name: "country_code", type: "TEXT",     note: "ISO2 country code" },
        { name: "zone_code",      type: "TEXT",   note: "Subdivision / zone code" },
        { name: "last_synced_at", type: "TEXT",   note: "UTC timestamp of last import-mdm-data.js sync — enables delta sync and deprecation detection. Added v0.11.0" },
      ],
    },
    {
      table: "linked_ports",
      description: "Port equivalencies for conflict detection (e.g. NLRTM ↔ NLEUR).",
      columns: [
        { name: "id",               type: "TEXT PK",       note: "Auto-generated identifier" },
        { name: "primary_unlocode", type: "TEXT FK",       note: "Primary port → port_locations" },
        { name: "linked_unlocode",  type: "TEXT FK",       note: "Linked equivalent port → port_locations" },
        { name: "note",             type: "TEXT",          note: "Reason for link (e.g. terminal alias)" },
      ],
    },
    {
      table: "trade_lanes",
      description: "Named trade lane codes used for space configuration and route display.",
      columns: [
        { name: "code",        type: "TEXT PK", note: "Lane code (e.g. FE, EU-N, ME)" },
        { name: "name",        type: "TEXT",    note: "Full lane name" },
        { name: "description", type: "TEXT",    note: "Optional description" },
      ],
    },
    {
      table: "country_trade_lanes",
      description: "Many-to-many: assigns trade lanes to countries (a country may belong to multiple lanes).",
      columns: [
        { name: "iso2",      type: "TEXT FK", note: "Country ISO2 → countries" },
        { name: "lane_code", type: "TEXT FK", note: "Trade lane → trade_lanes" },
      ],
    },
    {
      table: "regions",
      description: "Geographic groupings for countries.",
      columns: [
        { name: "code",        type: "TEXT PK", note: "Region code (e.g. EMEA, APAC)" },
        { name: "name",        type: "TEXT",    note: "Region name" },
        { name: "description", type: "TEXT",    note: "Optional description" },
      ],
    },
    {
      table: "countries",
      description: "UN member states and territories — linked to flags, trade lanes, and regions.",
      columns: [
        { name: "iso2",        type: "TEXT PK",  note: "ISO 3166-1 alpha-2 code" },
        { name: "name",        type: "TEXT",     note: "Country name" },
        { name: "un_member",   type: "INTEGER",  note: "1 = UN member state" },
        { name: "region_code", type: "TEXT",     note: "FK → regions. Added post v0.1.0" },
      ],
    },
    {
      table: "shipment_events",
      description: "Full audit log of all shipment changes — field updates, container operations, and status transitions. One row per discrete change.",
      columns: [
        { name: "id",          type: "TEXT PK",  note: "Auto-generated EVT-XXXX identifier" },
        { name: "shipment_id", type: "TEXT FK",  note: "Parent shipment → ON DELETE CASCADE" },
        { name: "event_type",  type: "TEXT",     note: "STATUS_CHANGED | FIELD_UPDATED | CONTAINER_ADDED | CONTAINER_REMOVED | CONTAINER_UPDATED" },
        { name: "field",       type: "TEXT",     note: "DB column name that changed (e.g. etd, carrier_code, gross_weight_kg)" },
        { name: "old_value",   type: "TEXT",     note: "Value before the change" },
        { name: "new_value",   type: "TEXT",     note: "Value after the change" },
        { name: "actor",       type: "TEXT",     note: "Identity of the actor — defaults to 'user', ready for auth. Added v0.11.0" },
        { name: "occurred_at", type: "TEXT",     note: "UTC ISO 8601 timestamp" },
        { name: "meta",        type: "TEXT",     note: "JSON blob with extra context (container number, size, type for container events)" },
      ],
    },
    {
      table: "status_log",
      description: "Immutable audit trail of shipment status transitions. Cascades on shipment delete.",
      columns: [
        { name: "id",           type: "TEXT PK",  note: "Auto-generated SL-XXXX identifier" },
        { name: "shipment_id",  type: "TEXT FK",  note: "Parent shipment → ON DELETE CASCADE" },
        { name: "from_status",  type: "TEXT",     note: "Status before the change" },
        { name: "to_status",    type: "TEXT",     note: "Status after the change" },
        { name: "changed_at",   type: "TEXT",     note: "UTC ISO 8601 timestamp of the transition" },
        { name: "changed_by",   type: "TEXT",     note: "Identity of the actor. Defaults to 'user' — ready for auth. Added v0.10.0" },
      ],
    },
    {
      table: "entity_events",
      description: "Generic audit log for non-shipment entities — allocations, carriers, and contracts. Added v0.14.0.",
      columns: [
        { name: "id",          type: "TEXT PK",  note: "Auto-generated EEV-XXXX identifier" },
        { name: "entity_type", type: "TEXT",     note: "Entity kind: allocation | carrier | contract" },
        { name: "entity_id",   type: "TEXT",     note: "PK of the entity in its own table" },
        { name: "event_type",  type: "TEXT",     note: "CREATED | UPDATED | DELETED" },
        { name: "field",       type: "TEXT",     note: "Column that changed (UPDATED events only)" },
        { name: "old_value",   type: "TEXT",     note: "Value before the change" },
        { name: "new_value",   type: "TEXT",     note: "Value after the change" },
        { name: "meta",        type: "TEXT",     note: "JSON snapshot — key fields at time of event (carrier, POL, POD, contract number, etc.)" },
        { name: "created_at",  type: "TEXT",     note: "UTC ISO 8601 timestamp" },
      ],
    },
    {
      table: "commodities",
      description: "Maersk freight commodity registry — 294 codes across 5 grades. Seeded from lista-de-commodities-y-grado-de-unidad.",
      columns: [
        { name: "code",        type: "TEXT PK", note: "Maersk commodity code (e.g. 000544)" },
        { name: "description", type: "TEXT",    note: "Full commodity description (e.g. Salmon, non-frozen, fish)" },
        { name: "grade_code",  type: "TEXT",    note: "M | K | E | S | Q — determines handling requirements" },
        { name: "grade_name",  type: "TEXT",    note: "Food Grade | General Cargo — Premium | General Cargo | Flexi | Scrap Metal" },
      ],
    },
    {
      table: "tickets",
      description: "Integration Board — Kanban tickets for tracking development tasks.",
      columns: [
        { name: "id",          type: "TEXT PK",  note: "Auto-generated TKT-XXXX identifier" },
        { name: "title",       type: "TEXT",     note: "Ticket title (required)" },
        { name: "section",     type: "TEXT",     note: "CargoDesk area (Shipments, Dashboard, API…)" },
        { name: "description", type: "TEXT",     note: "Acceptance criteria and notes" },
        { name: "priority",    type: "TEXT",     note: "Critical | High | Medium | Low" },
        { name: "status",      type: "TEXT",     note: "Ready | In Progress | Done | Released" },
        { name: "position",    type: "INTEGER",  note: "Sort order within column" },
        { name: "created_at",  type: "TEXT",     note: "ISO timestamp" },
      ],
    },
  ];

  const SchemaSection = () => {
    const [expanded, setExpanded] = React.useState({});
    const toggle = t => setExpanded(p => ({ ...p, [t]: !p[t] }));
    return (
      <div>
        <h2 style={{ fontFamily: T.head, fontSize: 18, fontWeight: 800, color: T.text,
          margin: "0 0 8px", paddingBottom: 8, borderBottom: `1px solid ${T.border}` }}>
          Database Schema
        </h2>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.7, margin: "0 0 20px" }}>
          CargoDesk uses a single SQLite file (<code style={{ fontFamily: T.mono, fontSize: 12,
            color: T.textCode, background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: 4, padding: "1px 5px" }}>cargodesk.db</code>).
          Schema changes are applied at startup via safe <code style={{ fontFamily: T.mono, fontSize: 12,
            color: T.textCode, background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: 4, padding: "1px 5px" }}>ALTER TABLE</code> migrations —
          no manual intervention or DB deletion required.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {DB_SCHEMA.map(({ table, description, columns }) => (
            <div key={table} style={{ background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, overflow: "hidden" }}>
              {/* Table header — clickable */}
              <button type="button" onClick={() => toggle(table)}
                style={{ display: "flex", alignItems: "center", gap: 10, width: "100%",
                  padding: "12px 16px", background: "none", border: "none", cursor: "pointer",
                  textAlign: "left" }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.accent }}>
                  {expanded[table] ? "▾" : "▸"}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.textCode }}>
                  {table}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted,
                  background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
                  padding: "1px 8px" }}>
                  {columns.length} cols
                </span>
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  {description}
                </span>
              </button>
              {/* Columns */}
              {expanded[table] && (
                <div style={{ borderTop: `1px solid ${T.border}` }}>
                  {/* Column header */}
                  <div style={{ display: "grid", gridTemplateColumns: "160px 100px 1fr",
                    padding: "6px 16px", background: T.bg }}>
                    {["Column", "Type", "Notes"].map(h => (
                      <span key={h} style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                        color: T.border, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</span>
                    ))}
                  </div>
                  {columns.map((col, i) => (
                    <div key={col.name}
                      style={{ display: "grid", gridTemplateColumns: "160px 100px 1fr",
                        padding: "8px 16px", alignItems: "start",
                        borderTop: `1px solid ${T.border}22`,
                        background: i % 2 === 0 ? "transparent" : T.bg + "80" }}>
                      <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 600 }}>
                        {col.name}
                      </span>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                        {col.type}
                      </span>
                      <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
                        {col.note}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

// ─── Changelog entry component ────────────────────────────────────────────────

function ChangelogEntry({ entry, defaultOpen }) {
  const [open, setOpen] = React.useState(defaultOpen);

  // Split on ". " followed by an uppercase letter — each sentence is one feature bullet.
  const raw = entry.summary.split(/\.\s+(?=[A-Z])/);
  const bullets = raw.map((b, i) => (i < raw.length - 1 && !b.endsWith('.') ? b + '.' : b));

  return (
    <div style={{
      border: `1px solid ${defaultOpen ? T.accent + "55" : T.border}`,
      borderRadius: 10,
      background: T.surface,
      overflow: "hidden",
    }}>
      <button
        onClick={() => setOpen(o => !o)}
        type="button"
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 10,
          padding: "11px 16px", background: "none", border: "none",
          cursor: "pointer", textAlign: "left",
        }}
      >
        <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700,
          color: defaultOpen ? T.accent : T.textMuted, minWidth: 56 }}>
          v{entry.version}
        </span>
        {entry.codename && (
          <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600,
            color: defaultOpen ? T.accent : T.text }}>
            "{entry.codename}"
          </span>
        )}
        {defaultOpen && <Badge variant="success">current</Badge>}
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{entry.date}</span>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginLeft: 8 }}>
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div style={{ borderTop: `1px solid ${T.border}33`, padding: "10px 18px 14px" }}>
          <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 5 }}>
            {bullets.map((bullet, i) => (
              <li key={i} style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
                {bullet}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Architectural Details tab ─────────────────────────────────────────────
// In-app companion to the full interactive diagram artifact — same content,
// native components instead of Mermaid, so it stays available without a
// external dependency. See ARCHITECTURE_ARTIFACT_URL below for the diagram version.

const ARCHITECTURE_ARTIFACT_URL = "https://claude.ai/code/artifact/9515fbd6-accd-4295-93c6-cd54882d3abb";

const FRONTEND_DOMAINS = [
  { name: "Shipment Core", color: "#e8a217", items: ["ShipmentsPage", "ShipmentFormPage + LegsTable", "ShipmentDetailPage (Overview)"] },
  { name: "Embedded on Overview", color: "#4db3e8", items: ["ServicesPanel", "ShipmentHeaderBar", "MilestonePanel", "MessagesDrawer / EdiMessagesDrawer"] },
  { name: "Promoted Sub-pages (8)", color: "#2dcc8f", items: ["Cargo / Containers", "Parties & Offices", "Schedules + ScheduleHistoryPanel", "Milestones", "Tickets", "Invoice Entry", "Cost Entry", "GP Overview"] },
  { name: "Dashboards, MDM & Admin", color: "#a855f7", items: ["DashboardPage + Command Center", "12 × MdmXPage reference data", "Kanban / Test Cases · Plans · Runs", "AppSettingsPage"] },
];

const BACKEND_DOMAINS = [
  { name: "shipments.js", items: "CRUD, legs, containers, container-events, messages" },
  { name: "shipment-ops.js", items: "cost-lines, milestones, documents, services, schedules" },
  { name: "contracts.js", items: "contracts, entity-events" },
  { name: "allocations.js", items: "space configurations" },
  { name: "customers.js", items: "customers, sanctions, FX" },
  { name: "mdm.js", items: "carriers, vessels, ports, lanes, commodities" },
  { name: "kanban.js / testcases.js", items: "tickets, test items" },
  { name: "edi.js", items: "carrier EDI log" },
  { name: "auth.js / offices.js / organization.js", items: "users, offices, branches" },
  { name: "system.js", items: "health, settings, schedule search" },
  { name: "ai.js", items: "AI agent chat proxy" },
  { name: "finance.js / export.js / share.js", items: "margin, CSV/XLSX, public tracking" },
];

const DB_DOMAINS = [
  { name: "Shipment Core", color: "#e8a217", tables: "shipments · shipment_legs · containers · shipment_events · status_log · container_events" },
  { name: "Shipment Ops", color: "#e8a217", tables: "shipment_cost_lines · shipment_milestones · shipment_documents · shipment_services · shipment_schedules · shipment_rate_snapshots(_lines) · shipment_screenings · shipment_messages" },
  { name: "Contracts & Rates", color: "#2dcc8f", tables: "contracts · contract_legs · contract_rates · entity_events" },
  { name: "Allocations", color: "#2dcc8f", tables: "allocations" },
  { name: "Customers & Compliance", color: "#a855f7", tables: "customers · customer_documents · customer_identifiers · customer_screenings · sanctions_entries · sanctions_syncs" },
  { name: "MDM Reference Data", color: "#a855f7", tables: "carriers · vessels · port_locations · linked_ports · trade_lanes · country_trade_lanes · regions · countries · commodities" },
  { name: "Kanban & Testing", color: "#4db3e8", tables: "tickets · ticket_links · test_items · test_case_links · kb_projects · kb_columns · kb_versions" },
  { name: "EDI Messaging", color: "#4db3e8", tables: "edi_messages" },
  { name: "Auth & Organization", color: "#f5b84c", tables: "users · user_offices · user_scope_items · user_access_configs · offices · branches · org_countries" },
  { name: "System & Admin", color: "#f5b84c", tables: "app_settings · system_messages · admin_events" },
];

const ARCH_PATTERNS = [
  { name: "Route factory + ctx injection", desc: "Every route file is module.exports = (app, ctx) => {...}. ctx is assembled once in server.js and carries db, every mapX function, auth middleware, and shared helpers — a route never imports its own DB handle or writes its own mapper." },
  { name: "Mapper convention", desc: "One function per table (mapShipment, mapCostLine, mapService…), snake_case DB row → camelCase API shape. The frontend never sees a snake_case field from a mapped response — except raw entity_events rows, the one deliberate exception." },
  { name: "Generic audit log — entity_events", desc: "One shared table covers cost lines, documents, services, and schedules, tagged by entity_type. History views read it directly, unmapped — event_type / created_at, not the camelCase you'd expect everywhere else." },
  { name: "Self-fetching shared panels", desc: "ServicesPanel, ContainerEventsPanel, ScheduleHistoryPanel, and ShipmentHeaderBar take just a shipment/id prop and fetch their own data — drop-in anywhere without wiring a parent-level loader." },
  { name: "WebSocket broadcast — shipmentSubs", desc: "A per-shipment subscriber map drives live updates. Drawers fall back to 10s polling if the socket errors, so the feature degrades instead of breaking." },
];

const ARCH_GOTCHAS = [
  { name: "shipment.pol/pod isn't always the SEA leg", desc: "They're the journey's overall bookends (legs[0]/legs[-1]) — with a Door pickup or a multi-leg TSP journey, that's not the same as the SEA leg's own pol/pod. Anything showing \"the port\" should resolve the actual SEA leg(s)." },
  { name: "VGM isn't linked to a weight field", desc: "VGM is a valid Dedicated Services type (order it, track its status) but nothing connects a confirmed VGM to containers.grossWeightKg or a verified-weight cutoff date yet." },
  { name: "Service vendors aren't sanctions-screened", desc: "screenShipmentById only checks shipper/consignee/principal by a hardcoded field list. A vendor picked via the Services panel gets zero compliance coverage today — deliberate scope cut, tracked in TKT-9DGDNP." },
  { name: "Contract rate auto-import is BUY-only", desc: "importContractRates populates BUY lines from a carrier contract automatically. SELL lines have no contract-driven equivalent — manual entry or mirrored line-by-line from a BUY line." },
];

const Section = ({ title, children }) => (
  <div style={{ marginBottom: 32 }}>
    <h2 style={{ fontFamily: T.head, fontSize: 18, fontWeight: 800, color: T.text,
      margin: "0 0 12px", paddingBottom: 8, borderBottom: `1px solid ${T.border}` }}>
      {title}
    </h2>
    {children}
  </div>
);

const P = ({ children }) => (
  <p style={{ fontFamily: T.body, fontSize: 14, color: T.textMuted, lineHeight: 1.75, margin: "0 0 10px" }}>
    {children}
  </p>
);

const ArchitecturalDetailsTab = () => {
  const domainCard = (color) => ({
    background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
    padding: "14px 16px", borderTop: `3px solid ${color}`,
  });

  return (
    <div>
      <div style={{ background: T.surface, border: `1px solid ${T.accent}55`, borderRadius: 10,
        padding: "14px 18px", marginBottom: 28, display: "flex", alignItems: "center",
        justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: 0, lineHeight: 1.6, maxWidth: 480 }}>
          This tab is a native summary. The full reference — with system, frontend, backend, and
          workflow diagrams — lives in a linked interactive document.
        </p>
        <a href={ARCHITECTURE_ARTIFACT_URL} target="_blank" rel="noopener noreferrer"
          style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.accent,
            background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 8,
            padding: "9px 16px", textDecoration: "none", whiteSpace: "nowrap" }}>
          View interactive diagrams ↗
        </a>
      </div>

      <Section title="System Overview">
        <div style={{ background: T.surface, borderRadius: 10, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          {[
            ["Browser", "React 18 + Vite, hash-based routing (App.jsx) — no React Router"],
            ["Transport", "fetch() for JSON requests; a WebSocket (shipmentSubs) for live updates"],
            ["Server", "server.js — schema, startup migrations, mapper functions, assembled into ctx"],
            ["Routes", "17 route files, module.exports = (app, ctx) => {...}"],
            ["Database", "SQLite via node:sqlite — 55 tables, no ORM, prepared statements only"],
          ].map(([label, val], i, arr) => (
            <div key={label} style={{ display: "grid", gridTemplateColumns: "120px 1fr",
              padding: "12px 16px", borderBottom: i < arr.length - 1 ? `1px solid ${T.border}22` : "none",
              alignItems: "center", gap: 12 }}>
              <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>{label}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{val}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Frontend — by domain">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {FRONTEND_DOMAINS.map(d => (
            <div key={d.name} style={domainCard(d.color)}>
              <div style={{ fontFamily: T.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: ".07em",
                color: d.color, fontWeight: 700, marginBottom: 8 }}>{d.name}</div>
              <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.text, lineHeight: 1.9 }}>
                {d.items.join(" · ")}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Backend Routes — by domain">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {BACKEND_DOMAINS.map(d => (
            <div key={d.name} style={{ background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, padding: "12px 16px" }}>
              <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.textCode, marginBottom: 4 }}>{d.name}</div>
              <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{d.items}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Database — by domain">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {DB_DOMAINS.map(d => (
            <div key={d.name} style={domainCard(d.color)}>
              <div style={{ fontFamily: T.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: ".07em",
                color: d.color, fontWeight: 700, marginBottom: 8 }}>{d.name}</div>
              <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.text, lineHeight: 1.7 }}>{d.tables}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Cross-cutting Patterns">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {ARCH_PATTERNS.map(p => (
            <div key={p.name} style={{ background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, padding: "13px 18px" }}>
              <div style={{ fontFamily: T.head, fontSize: 13.5, fontWeight: 700, color: T.text, marginBottom: 4 }}>{p.name}</div>
              <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, lineHeight: 1.6, margin: 0 }}>{p.desc}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Known Gaps — from the functional workflow">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {ARCH_GOTCHAS.map(p => (
            <div key={p.name} style={{ background: T.surface, borderLeft: `3px solid ${T.warning}`,
              border: `1px solid ${T.border}`, borderRadius: 10, padding: "13px 18px" }}>
              <div style={{ fontFamily: T.head, fontSize: 13.5, fontWeight: 700, color: T.text,
                marginBottom: 4, display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ color: T.warning }}>⚠</span>{p.name}
              </div>
              <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, lineHeight: 1.6, margin: 0 }}>{p.desc}</p>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
};

// ─── Research tab — external dataset findings ─────────────────────────────
// Logged after checking openml.org, kaggle.com, and datasetsearch.research.google.com
// for datasets that could enrich or extend CargoDesk's own data model. Exploratory
// only — nothing listed here has been imported; these are candidates, not commitments.

const RESEARCH_DATE = "2026-07-20";

const DATASET_GROUPS = [
  {
    name: "Ports & Vessels",
    color: "#4db3e8",
    blurb: "Cross-checks and possible enrichment for the 349-vessel IMO registry and the 14,269 UN/LOCODE port table.",
    items: [
      {
        name: "Piraeus AIS Dataset",
        source: "Academic — ScienceDirect (open access)",
        stats: "244M AIS records · May 2017 – Dec 2019",
        relevance: "Real vessel position/trajectory data — a foundation for a live transit map or transit-time estimation, beyond the static vessel list.",
        url: "https://www.sciencedirect.com/science/article/pii/S2352340921010568",
      },
      {
        name: "Global Cargo Ships Dataset",
        source: "Kaggle",
        stats: "~4,000 ships · company, build year, gross tonnage, deadweight, length/width",
        relevance: "vessels is thin on specs today (name, asset type, flag, build year, gross tonnage) — this could backfill deadweight and dimensions.",
        url: "https://www.kaggle.com/datasets/ibrahimonmars/global-cargo-ships-dataset",
      },
      {
        name: "Ports AIS Dataset",
        source: "Kaggle",
        stats: "Per-port AIS coverage",
        relevance: "A cross-check against port_locations lat/long, not a wholesale replacement for the seeded UN/LOCODE table.",
        url: "https://www.kaggle.com/datasets/marwaashraf5814/ports-ais",
      },
      {
        name: "Shipping Ports Around The World",
        source: "Kaggle",
        stats: "450+ ports",
        relevance: "Same use — a spot-check set for port_locations.",
        url: "https://www.kaggle.com/datasets/sanjeetsinghnaik/ship-ports",
      },
      {
        name: "Global Daily Port Activity and Trade Estimates",
        source: "Kaggle (IMF-sourced)",
        stats: "Daily port call counts + trade-flow estimates, per port",
        relevance: "Could seed a port congestion/activity indicator next to the existing Schedules feature.",
        url: "https://www.kaggle.com/datasets/arunvithyasegar/daily-port-activity-data-and-trade-estimates",
      },
    ],
  },
  {
    name: "Commodities / HS Codes",
    color: "#a855f7",
    blurb: "commodities only covers 294 Maersk-specific codes today — these broaden it to the full international standard.",
    items: [
      {
        name: "Harmonized System (HS) as a datapackage",
        source: "GitHub — datasets/harmonized-system",
        stats: "Full 6-digit international HS classification tree",
        relevance: "Most direct way to extend commodities beyond Maersk-only codes, if customers ever need non-Maersk commodity lookups.",
        url: "https://github.com/datasets/harmonized-system",
      },
      {
        name: "WCO HS Codes CSV",
        source: "GitHub — warrantgroup/WCO-HS-Codes",
        stats: "World Customs Organization source list",
        relevance: "Alternate source for the same HS tree — useful for cross-checking the datapackage above.",
        url: "https://github.com/warrantgroup/WCO-HS-Codes/blob/master/data/hscodes.csv",
      },
      {
        name: "UN Comtrade",
        source: "United Nations (comtrade.un.org)",
        stats: "HS-coded global trade volume by country pair",
        relevance: "Overkill for MDM, but could feed a 'trade lane popularity' stat against trade_lanes later.",
        url: "https://comtrade.un.org/",
      },
    ],
  },
  {
    name: "Sanctions Screening",
    color: "#2dcc8f",
    blurb: "The strongest, most actionable find of the three sources — worth a real look, not just a toy dataset.",
    items: [
      {
        name: "OpenSanctions — US OFAC SDN",
        source: "opensanctions.org",
        stats: "~18,700 entities · aggregates 412+ global sanctions/PEP/watchlist sources · free for non-commercial use · bulk JSON/CSV + API",
        relevance: "sanctions_entries currently screens against raw OFAC SDN data. OpenSanctions gives the same coverage pre-normalized and deduped against other watchlists, plus vessel-specific sanctions entries that line up with the vessels table.",
        url: "https://www.opensanctions.org/datasets/us_ofac_sdn/",
      },
    ],
  },
  {
    name: "FX Rates",
    color: "#f5b84c",
    blurb: "Historical backfill for the live FX feature — not a replacement for it.",
    items: [
      {
        name: "Currency Foreign Exchange Rates",
        source: "Kaggle (dhruvildave)",
        stats: "Historical daily rate table",
        relevance: "Rate-on-date lookups for past shipments/invoices, where the live feed has no history.",
        url: "https://www.kaggle.com/datasets/dhruvildave/currency-exchange-rates",
      },
      {
        name: "Forex Exchange Rates Since 2004 (updated daily)",
        source: "Kaggle (asaniczka)",
        stats: "Daily rates, 2004–present",
        relevance: "Same use, longer history.",
        url: "https://www.kaggle.com/datasets/asaniczka/forex-exchange-rate-since-2004-updated-daily",
      },
    ],
  },
  {
    name: "Supply Chain / Delay Prediction",
    color: "#e8a217",
    blurb: "A realistic sandbox for prototyping a delay-risk feature, before CargoDesk has enough of its own historical data to train on.",
    items: [
      {
        name: "DataCo Smart Supply Chain Dataset",
        source: "Kaggle (shashwatwork)",
        stats: "18,000+ orders · 50+ features · shipping mode, scheduled vs. actual days, late-delivery label",
        relevance: "Structured close to the shipment/milestone model (order → ship → deliver, with a late/on-time label) — the best candidate for prototyping a 'predicted delay risk' feature on shipments.",
        url: "https://www.kaggle.com/datasets/shashwatwork/dataco-smart-supply-chain-for-big-data-analysis",
      },
      {
        name: "Supply Chain Order Delay Risk Analysis",
        source: "Kaggle (jayjoshi37)",
        stats: "Smaller, simpler variant of the above",
        relevance: "Same idea, lighter weight if the full DataCo set is more than needed for a first experiment.",
        url: "https://www.kaggle.com/datasets/jayjoshi37/supply-chain-order-delay-risk-analysis",
      },
    ],
  },
];

const RESEARCH_PICKS = [
  { name: "OpenSanctions (US OFAC SDN)", why: "Upgrades a feature CargoDesk already has — pre-normalized, deduped sanctions data instead of raw Treasury XML." },
  { name: "DataCo Smart Supply Chain Dataset", why: "Gives a realistic sandbox for a delay-prediction feature CargoDesk doesn't have yet." },
];

const DatasetCard = ({ item }) => (
  <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 14px" }}>
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10,
      flexWrap: "wrap", marginBottom: 4 }}>
      <span style={{ fontFamily: T.head, fontSize: 13.5, fontWeight: 700, color: T.text }}>{item.name}</span>
      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, textTransform: "uppercase",
        letterSpacing: ".05em" }}>{item.source}</span>
    </div>
    <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginBottom: 6 }}>{item.stats}</div>
    <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, lineHeight: 1.6, margin: "0 0 8px" }}>
      {item.relevance}
    </p>
    <a href={item.url} target="_blank" rel="noopener noreferrer"
      style={{ fontFamily: T.body, fontSize: 11.5, fontWeight: 700, color: T.accent, textDecoration: "none" }}>
      View dataset ↗
    </a>
  </div>
);

const ResearchTab = () => (
  <div>
    <div style={{ background: T.surface, border: `1px solid ${T.accent}55`, borderRadius: 10,
      padding: "14px 18px", marginBottom: 28 }}>
      <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: 0, lineHeight: 1.6 }}>
        Exploratory research, logged {RESEARCH_DATE} — datasets checked across openml.org, kaggle.com, and
        Google Dataset Search for anything that could enrich or extend CargoDesk's own data model. Nothing
        listed here has been imported; these are candidates, not commitments.
      </p>
    </div>

    <Section title="Top Picks">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {RESEARCH_PICKS.map(p => (
          <div key={p.name} style={{ background: T.surface, borderLeft: `3px solid ${T.accent}`,
            border: `1px solid ${T.border}`, borderRadius: 10, padding: "13px 18px" }}>
            <div style={{ fontFamily: T.head, fontSize: 13.5, fontWeight: 700, color: T.text, marginBottom: 4 }}>
              {p.name}
            </div>
            <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, lineHeight: 1.6, margin: 0 }}>
              {p.why}
            </p>
          </div>
        ))}
      </div>
    </Section>

    {DATASET_GROUPS.map(group => (
      <Section key={group.name} title={group.name}>
        <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, lineHeight: 1.6, margin: "0 0 12px" }}>
          {group.blurb}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {group.items.map(item => <DatasetCard key={item.name} item={item} />)}
        </div>
      </Section>
    ))}

    <Section title="openml.org — dead end for this purpose">
      <div style={{ background: T.surface, borderLeft: `3px solid ${T.warning}`,
        border: `1px solid ${T.border}`, borderRadius: 10, padding: "13px 18px" }}>
        <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, lineHeight: 1.6, margin: 0 }}>
          <span style={{ color: T.warning }}>⚠</span>{" "}
          OpenML is a generic ML-benchmark repository — mostly UCI-style tabular classification/regression
          sets for algorithm comparison — not a domain-data source. Every search variant tried (site-scoped,
          keyword, "supply chain" / "logistics" / "delivery") redirected to the same Kaggle/GitHub/ScienceDirect
          datasets listed above rather than surfacing anything freight-specific hosted on OpenML itself. Not
          worth revisiting for this purpose.
        </p>
      </div>
    </Section>
  </div>
);

const AboutPage = () => {
  const [tab, setTab] = React.useState("Overview");

  const features = [
    { icon: "📦", title: "Shipment Tracking",         desc: "Create and manage ocean freight shipments with container-level detail: HS Code, gross weight, volume, IMDG dangerous goods class, and Maersk commodity type. Full status audit trail with timestamped transitions." },
    { icon: "◈",  title: "Consumption Dashboard",     desc: "TEU utilisation heatmap per carrier and route, date-range picker, and a dedicated Contract Consumption breakdown tab. Space Configurations now live on their own sidebar page." },
    { icon: "⚡", title: "Space Configurations",      desc: "Standalone page (Dashboard › Space Configurations) for managing carrier TEU allocations. Per-allocation lifetime consumption bars, 6-week sparklines, mandatory contract picker, conflict detection, and a full ActionMenu per row (Edit, History, Delete)." },
    { icon: IconSettings,  title: "Action Menus & Audit Log",  desc: "The settings-icon ActionMenu replaces individual buttons across Shipments, Carriers, and Contracts. Clicking History opens EntityHistoryModal — a timestamped timeline of CREATED/UPDATED/DELETED events with field diffs and meta pills, backed by the new entity_events table." },
    { icon: "📜", title: "Shipment History Tracker",  desc: "Full audit trail for every shipment: field changes, container additions/removals/updates, and status transitions logged automatically — rendered as a colour-coded timeline on the detail page. Bridged into the unified entity-events endpoint." },
    { icon: "📦", title: "Commodities MDM",           desc: "294 Maersk freight commodity codes (Grades M/K/E/S/Q) with full-text typeahead search. Mandatory on every shipment booking — determines handling requirements and documentation." },
    { icon: "🚢", title: "Vessel Registry",           desc: "349 vessels from the IMO registry, searchable by name, IMO number, or asset type, linked to country flags and integrated with the shipment form." },
    { icon: "📍", title: "Port & MDM Directory",      desc: "14,269 UN/LOCODE ports, carrier directory, trade lanes, linked ports, regions, countries, UN location codes, and commodity codes — all editable." },
    { icon: "📋", title: "Integration Board",         desc: "Kanban board (Ready / In Progress / Done / Released) for tracking development and integration tasks, with priority and section filters. Cards drag within columns with live drop indicators." },
    { icon: "✓",  title: "Test Case Management",      desc: "Test Folders, Plans, Runs, and Cases live in their own dedicated repository, separate from the Integration Board. Test Cases link to Stories via a bidirectional Tests / Is tested by relationship for lightweight requirement traceability." },
    { icon: IconBaseStation, title: "EDI Messaging",              desc: "Send carrier booking requests (MAEU, SAFM, MCPU) and receive confirmations directly from the shipment detail page. Every message — sent and received — is logged with a raw/parsed payload toggle; falls back to demo data without a live carrier key." },
    { icon: "📋", title: "Container Lifecycle Events", desc: "Per-container FCL movement tracking — Empty Pickup, Gate In, Loaded, Sailed, Discharged, Gate Out, Empty Return — the foundation for upcoming demurrage/detention tracking." },
    { icon: "🌗", title: "Light / Dark Theme",        desc: "Apple HIG-compliant light theme alongside the CargoDesk dark theme. Instant toggle in the user menu, preference persisted to localStorage." },
    { icon: "📚", title: "User Manual",               desc: "Built-in documentation covering Incoterms® 2020 and IMDG dangerous goods classes (Classes 1–9, 20 sub-classes with full descriptions and source link)." },
    { icon: "🧭", title: "Persistent Shipment Header", desc: "Visible on the Overview page and all 8 promoted sub-pages: ID (click-to-copy), route, dates, Incoterm, vessel, parties, contract, TEU, Loop Code, and a Door → POL → POD → Terminal journey bar that resolves the actual SEA leg — correct even for Door pickups and multi-leg transshipment routings." },
    { icon: "🧰", title: "Dedicated Services",         desc: "Export/Import services dashboard on the shipment Overview page — VGM, Pickup/Loading (Export-only), Delivery/Unloading (Import-only), Fumigation, Storage, Customs Clearance, and more. Each service carries a vendor, an office defaulted from the shipment's Export/Import Managing Office, and a Requested → Confirmed → Completed/Cancelled lifecycle, fully audit-logged." },
    { icon: IconAnchor, title: "Schedules Page Overhaul",     desc: "Route Legs are now editable directly on the Schedules page with auto-ordering (Pick-up first, Delivery last). Add Sailing is transshipment-aware — a multi-leg sailing updates every affected leg. The old Sailings list is now a read-only Schedule History audit trail." },
  ];

  const stack = [
    { layer: "Frontend",  items: "React 18, Vite, custom dark design system (IBM Plex Mono / Syne / DM Sans)" },
    { layer: "Backend",   items: "Node.js 22.5+, Express, node:sqlite (built-in, no ORM)" },
    { layer: "Data",      items: "SQLite — single-file DB with safe ALTER TABLE migrations on startup" },
    { layer: "Weather",   items: "Open-Meteo API — free, no API key, geocoding via Open-Meteo geocoding API" },
    { layer: "Standards", items: "IMDG Code (IMO), Incoterms® 2020 (ICC), UN/LOCODE port registry" },
  ];

  return (
    <div style={{ maxWidth: 820, margin: "0 auto" }}>

      {/* Hero */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 12 }}>
          <h1 style={{ fontFamily: T.head, fontSize: 32, fontWeight: 800, color: T.text, margin: 0,
            display: "flex", alignItems: "center", gap: 10 }}>
            <IconAnchor size={28} />CargoDesk
          </h1>
          <Badge variant="info">v{VERSION}</Badge>
          <Badge variant="default">{CODENAME}</Badge>
        </div>
        <P>
          CargoDesk is a personal freight management application for tracking ocean shipments,
          monitoring carrier space utilisation, and maintaining master data across ports, vessels,
          carriers, trade lanes, and countries.
        </P>
        <P>
          Built as a full-stack single-user application — a React 18 frontend backed by an Express
          API and a local SQLite database — CargoDesk is designed to work entirely offline, with no
          cloud dependencies beyond the optional weather widget.
        </P>
      </div>

      {/* Tab bar */}
      <div style={{ display: "flex", borderBottom: `2px solid ${T.border}`, marginBottom: 24 }}>
        {["Overview", "Architectural Details", "Research"].map(t => (
          <button key={t} onClick={() => setTab(t)} type="button"
            style={{
              padding: "9px 20px", border: "none", cursor: "pointer", background: "none",
              fontFamily: T.body, fontSize: 14, fontWeight: t === tab ? 700 : 400,
              color: t === tab ? T.accent : T.textMuted,
              borderBottom: `2px solid ${t === tab ? T.accent : "transparent"}`,
              marginBottom: -2,
            }}>
            {t}
          </button>
        ))}
      </div>

      {tab === "Architectural Details" && <ArchitecturalDetailsTab />}

      {tab === "Research" && <ResearchTab />}

      {tab === "Overview" && <>

      {/* Features */}
      <Section title="Features">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {features.map(f => (
            <div key={f.title} style={{ background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 18, display: "inline-flex" }}><AnyIcon icon={f.icon} size={18} /></span>
                <span style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>{f.title}</span>
              </div>
              <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.65, margin: 0 }}>
                {f.desc}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* Tech stack */}
      <Section title="Technology Stack">
        <div style={{ background: T.surface, borderRadius: 10, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          {stack.map((s, i) => (
            <div key={s.layer} style={{ display: "grid", gridTemplateColumns: "140px 1fr",
              padding: "12px 16px", borderBottom: i < stack.length - 1 ? `1px solid ${T.border}22` : "none",
              alignItems: "center", gap: 12 }}>
              <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>{s.layer}</span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{s.items}</span>
            </div>
          ))}
        </div>
      </Section>

      {/* Schema */}
      <Section title="Database Schema">
        <SchemaSection />
      </Section>

      {/* Changelog */}
      <Section title="Changelog">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {CHANGELOG.map((entry, i) => (
            <ChangelogEntry key={entry.version} entry={entry} defaultOpen={i === 0} />
          ))}
        </div>
      </Section>

      {/* Build info */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "14px 18px", display: "flex", gap: 32, alignItems: "center", flexWrap: "wrap" }}>
        {[
          ["Version",   `v${VERSION}`],
          ["Build",     BUILD],
          ["Build ID",  BUILD_FINGERPRINT],
          ["Codename",  CODENAME],
          ["Copyright", `© ${COPYRIGHT_YEAR} ${COPYRIGHT_OWNER}`],
        ].map(([label, value]) => (
          <div key={label}>
            <div style={{ fontFamily: T.body, fontSize: 10, color: T.border, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: ".1em", marginBottom: 3 }}>{label}</div>
            <div style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted, fontWeight: 600 }}>{value}</div>
          </div>
        ))}
      </div>

      </>}

    </div>
  );
};

export default AboutPage;