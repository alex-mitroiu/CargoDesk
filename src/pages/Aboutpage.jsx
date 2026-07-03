import { T } from "../tokens";
import Badge from "../components/primitives/Badge";
import React from "react";
import { VERSION, BUILD, CODENAME, CHANGELOG, COPYRIGHT_YEAR, COPYRIGHT_OWNER } from "../version";

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

const AboutPage = () => {
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

  const features = [
    { icon: "📦", title: "Shipment Tracking",         desc: "Create and manage ocean freight shipments with container-level detail: HS Code, gross weight, volume, IMDG dangerous goods class, and Maersk commodity type. Full status audit trail with timestamped transitions." },
    { icon: "◈",  title: "Consumption Dashboard",     desc: "TEU utilisation heatmap per carrier and route, date-range picker, and a dedicated Contract Consumption breakdown tab. Space Configurations now live on their own sidebar page." },
    { icon: "⚡", title: "Space Configurations",      desc: "Standalone page (Dashboard › Space Configurations) for managing carrier TEU allocations. Per-allocation lifetime consumption bars, 6-week sparklines, mandatory contract picker, conflict detection, and a full ActionMenu per row (Edit, History, Delete)." },
    { icon: "⚙",  title: "Action Menus & Audit Log",  desc: "Cog (⚙) ActionMenu replaces individual buttons across Shipments, Carriers, and Contracts. Clicking History opens EntityHistoryModal — a timestamped timeline of CREATED/UPDATED/DELETED events with field diffs and meta pills, backed by the new entity_events table." },
    { icon: "📜", title: "Shipment History Tracker",  desc: "Full audit trail for every shipment: field changes, container additions/removals/updates, and status transitions logged automatically — rendered as a colour-coded timeline on the detail page. Bridged into the unified entity-events endpoint." },
    { icon: "📦", title: "Commodities MDM",           desc: "294 Maersk freight commodity codes (Grades M/K/E/S/Q) with full-text typeahead search. Mandatory on every shipment booking — determines handling requirements and documentation." },
    { icon: "🚢", title: "Vessel Registry",           desc: "349 vessels from the IMO registry, searchable by name, IMO number, or asset type, linked to country flags and integrated with the shipment form." },
    { icon: "📍", title: "Port & MDM Directory",      desc: "14,269 UN/LOCODE ports, carrier directory, trade lanes, linked ports, regions, countries, UN location codes, and commodity codes — all editable." },
    { icon: "📋", title: "Integration Board",         desc: "Kanban board (Ready / In Progress / Done / Released) for tracking development and integration tasks, with priority and section filters. Cards drag within columns with live drop indicators." },
    { icon: "🌗", title: "Light / Dark Theme",        desc: "Apple HIG-compliant light theme alongside the CargoDesk dark theme. Instant toggle in the user menu, preference persisted to localStorage." },
    { icon: "📚", title: "User Manual",               desc: "Built-in documentation covering Incoterms® 2020 and IMDG dangerous goods classes (Classes 1–9, 20 sub-classes with full descriptions and source link)." },
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
          <h1 style={{ fontFamily: T.head, fontSize: 32, fontWeight: 800, color: T.text, margin: 0 }}>
            ⚓ CargoDesk
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

      {/* Features */}
      <Section title="Features">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {features.map(f => (
            <div key={f.title} style={{ background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 10, padding: "14px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 18 }}>{f.icon}</span>
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
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {CHANGELOG.map((entry, i) => (
            <div key={entry.version}
              style={{ display: "grid", gridTemplateColumns: "80px 90px 1fr", gap: 12,
                padding: "12px 16px", background: T.surface, borderRadius: 10,
                border: `1px solid ${i === 0 ? T.accent + "55" : T.border}`,
                alignItems: "start" }}>
              <div>
                <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                  color: i === 0 ? T.accent : T.textMuted }}>
                  v{entry.version}
                </span>
                {i === 0 && (
                  <div style={{ marginTop: 4 }}>
                    <Badge variant="success">current</Badge>
                  </div>
                )}
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border, paddingTop: 2 }}>
                {entry.date}
              </span>
              <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
                {entry.summary}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Build info */}
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "14px 18px", display: "flex", gap: 32, alignItems: "center", flexWrap: "wrap" }}>
        {[
          ["Version",   `v${VERSION}`],
          ["Build",     BUILD],
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

    </div>
  );
};

export default AboutPage;