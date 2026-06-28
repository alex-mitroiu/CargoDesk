import { useState } from "react";
import { T, IMDG_CLASSES, IMDG_CLASS_VARIANT } from "../tokens";
import Badge from "../components/primitives/Badge";
import IncotermsModal from "../components/shared/IncotermsModal";

// ─── User Manual Page ─────────────────────────────────────────────────────────

const UserManualPage = () => {
  const [section, setSection] = useState("overview");
  const [showIncoterms, setShowIncoterms] = useState(false);

  const SECTIONS = [
    { id: "overview",   label: "Overview" },
    { id: "shipments",  label: "Shipments" },
    { id: "dashboard",  label: "Dashboard" },
    { id: "mdm",        label: "Master Data" },
    { id: "incoterms",  label: "Incoterms" },
    { id: "dg-classes", label: "DG Classes ⚠" },
  ];

  const SectionBtn = ({ id, label }) => (
    <button onClick={() => setSection(id)} style={{
      display: "block", width: "100%", textAlign: "left", padding: "8px 14px",
      background: section === id ? T.accentBg : "transparent",
      border: "none", borderLeft: `3px solid ${section === id ? T.accent : "transparent"}`,
      color: section === id ? T.accent : T.textMuted,
      fontFamily: T.body, fontSize: 13, fontWeight: section === id ? 600 : 400,
      cursor: "pointer", borderRadius: "0 6px 6px 0", marginBottom: 2,
    }}>{label}</button>
  );

  const H2 = ({ children }) => (
    <h2 style={{ fontFamily: T.head, fontSize: 20, fontWeight: 700, color: T.text, margin: "0 0 10px" }}>{children}</h2>
  );
  const H3 = ({ children }) => (
    <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.accent, margin: "20px 0 6px" }}>{children}</h3>
  );
  const P = ({ children }) => (
    <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, lineHeight: 1.75, margin: "0 0 10px" }}>{children}</p>
  );
  const Tag = ({ children }) => (
    <code style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, background: T.bg,
      border: `1px solid ${T.border}`, borderRadius: 4, padding: "1px 6px" }}>{children}</code>
  );

  const content = {
    overview: (
      <div>
        <H2>CargoDesk — User Manual</H2>
        <P>CargoDesk is a freight management platform for creating and tracking ocean shipments, monitoring TEU consumption against carrier allocations, and maintaining master data for ports, carriers, trade lanes, and countries.</P>
        <H3>Navigation</H3>
        <P>The sidebar is organised into two areas: <strong>Operational</strong> (Shipments and Dashboard) and <strong>Master Data</strong> (MDM). Use the Master Data section header to expand or collapse the sub-menu.</P>
        <H3>Data model</H3>
        <P>Everything flows from Master Data. Carriers and ports must exist in the MDM before you can create a shipment. Allocations on the Dashboard are configured per carrier and contract type. Trade lanes link countries to FIATA high-level regions.</P>
      </div>
    ),
    shipments: (
      <div>
        <H2>Shipments</H2>
        <P>A shipment represents one booking with a carrier, from a Port of Loading (POL) to a Port of Discharge (POD).</P>
        <H3>Creating a shipment</H3>
        <P>Click <strong>＋ New Shipment</strong>. Search for the POL and POD using the port search — it queries the 14,000+ UN/LOCODE database. Select a carrier, set the contract type, and optionally add dates, booking reference, B/L number, vessel, and voyage.</P>
        <H3>Contract types</H3>
        <P>Use the preset buttons for <Tag>Pending</Tag>, <Tag>SPOT</Tag>, or <Tag>Customer Own</Tag>, or type a custom contract label. The contract type links to your Dashboard allocation configuration.</P>
        <H3>Cargo Details</H3>
        <P>Open a shipment to access Cargo Details. Add containers by specifying the container number, size (<Tag>20ft = 1 TEU</Tag>, <Tag>40ft = 2 TEU</Tag>), and equipment type (DC, RF, OT, FR, TK). TEU totals update instantly on the Dashboard.</P>
        <H3>Status workflow</H3>
        <P>Set the shipment status to <Tag>Active</Tag>, <Tag>Pending</Tag>, <Tag>Completed</Tag>, or <Tag>Cancelled</Tag> as it progresses.</P>
      </div>
    ),
    dashboard: (
      <div>
        <H2>Consumption Dashboard</H2>
        <P>The Dashboard shows TEU consumption against your configured carrier space allocations, scoped to a specific week.</P>
        <H3>Week picker</H3>
        <P>The dashboard always opens on the current week (Monday–Sunday). Use the <strong>← Prev</strong> and <strong>Next →</strong> arrows to navigate between weeks, or click <strong>Today</strong> to return to the current week. Only shipments with an ETD (or creation date) falling in the selected week are counted.</P>
        <H3>KPIs</H3>
        <P><strong>Total Allocated</strong> — the sum of all configured space across all carriers and contract types. <strong>Active Consumption</strong> — TEU booked in the selected week. <strong>Remaining</strong> — how much space is still available.</P>
        <H3>Space Configurations</H3>
        <P>Click <strong>＋ Add Configuration</strong> to set the awarded TEU for a specific carrier and contract type combination — e.g. MAEU / Customer Own = 80 TEU. Edit or remove configurations at any time. The utilisation bar turns amber above 70% and red above 90%.</P>
      </div>
    ),
    mdm: (
      <div>
        <H2>Master Data Management (MDM)</H2>
        <P>MDM is the reference layer for all operational data. Changes here propagate automatically to shipment forms and the dashboard.</P>
        <H3>Carriers</H3>
        <P>Add, edit, or remove ocean carriers. Each carrier requires a SCAC code (e.g. <Tag>MAEU</Tag>) and a full name. Carriers listed here appear in the shipment carrier dropdown.</P>
        <H3>Port Locations</H3>
        <P>The port database contains 14,000+ UN/LOCODE records with coordinates. Use the search bar to filter by code or name. Every row with coordinates includes a <strong>📍 Map</strong> link that opens Google Maps at that location. You can add custom ports or edit existing ones.</P>
        <H3>Linked Ports</H3>
        <P>Create links between ports that share a geographical area (e.g. <Tag>USLAX</Tag> → <Tag>USLGB</Tag>). Useful for matching booking data where the same physical port appears under multiple codes.</P>
        <H3>Trade Lanes</H3>
        <P>14 FIATA high-level trade lanes are pre-configured (<Tag>FE</Tag>, <Tag>EU-N</Tag>, <Tag>ME</Tag>, etc.). Each lane lists its assigned countries. Use the edit modal to search for countries by name or ISO2 code and add or remove them from the lane.</P>
        <H3>Countries</H3>
        <P>ISO 3166-1 alpha-2 country registry pre-populated with 193 UN member states and key territories. Each country shows its assigned trade lanes and seaport count. Click <strong>View Locations</strong> to see all UN/LOCODE ports for that country.</P>
        <H3>UN Location Codes</H3>
        <P>A complete index of all 5-character codes in the system. The <strong>Has Seaport?</strong> column shows ✅ for any code that matches a port in the Port Locations database, and <Tag>—</Tag> for codes referenced in shipments but not yet in the master data.</P>
      </div>
    ),
    incoterms: (
      <div>
        <H2>Incoterms® 2020</H2>
        <P>Incoterms® are standardised trade terms published by the ICC, used in every international shipment to define where risk and cost transfer from seller to buyer.</P>
        <button onClick={() => setShowIncoterms(true)} style={{
          display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 20,
          padding: "9px 18px", borderRadius: 7, cursor: "pointer",
          background: T.accentBg, border: `1px solid ${T.accent}55`,
          color: T.accent, fontFamily: T.body, fontSize: 13, fontWeight: 600,
        }}>
          📋 Open Incoterm Information
        </button>
        <H3>The two groups</H3>
        <P><strong>Any transport mode</strong> (EXW, FCA, CPT, CIP, DAP, DPU, DDP) — suitable for all cargo types including containerised ocean freight.</P>
        <P><strong>Sea and inland waterway only</strong> (FAS, FOB, CFR, CIF) — intended for bulk and break-bulk. For containerised cargo, prefer FCA over FOB and CIP over CIF.</P>
        <H3>Key principle</H3>
        <P>Incoterms define where <em>risk</em> and <em>cost</em> transfer from seller to buyer. They do not determine title of goods, payment terms, or liability for cargo damage beyond the risk transfer point.</P>
        {showIncoterms && <IncotermsModal onClose={() => setShowIncoterms(false)} />}
      </div>
    ),
        "dg-classes": (
      <div>
        <H2>IMDG Dangerous Goods Classes</H2>
        <P>The International Maritime Dangerous Goods (IMDG) Code classifies hazardous materials into 9 primary classes. When a container is flagged as DG in CargoDesk, the applicable class is mandatory. This ensures correct handling, segregation, and documentation across the shipment lifecycle.</P>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {IMDG_CLASSES.reduce((acc, c) => {
            const last = acc[acc.length - 1];
            if (!last || last.classNum !== c.classNum) acc.push({ classNum: c.classNum, entries: [c] });
            else last.entries.push(c);
            return acc;
          }, []).map(({ classNum, entries }) => {
            const variant = IMDG_CLASS_VARIANT[classNum] || "default";
            const borderCol = variant === "danger" ? T.danger : variant === "warning" ? T.warning : T.border;
            return (
              <div key={classNum} style={{ background: T.surface, border: `1px solid ${T.border}`,
                borderLeft: `4px solid ${borderCol}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "10px 16px", background: T.bg, borderBottom: `1px solid ${T.border}44`,
                  display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: borderCol,
                    background: `${borderCol}22`, border: `1px solid ${borderCol}44`,
                    borderRadius: 5, padding: "2px 10px" }}>Class {classNum}</span>
                  <span style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text }}>
                    {entries[0].name.replace(/Subclass \d+\.?\d* — /, "").split(" — ")[0]}
                  </span>
                </div>
                {entries.map((c, i) => (
                  <div key={c.code} style={{ padding: "10px 16px",
                    borderBottom: i < entries.length - 1 ? `1px solid ${T.border}22` : "none",
                    display: "grid", gridTemplateColumns: "110px 1fr", gap: 12 }}>
                    <div>
                      <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: borderCol }}>{c.label}</div>
                    </div>
                    <div>
                      <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, fontWeight: 600, marginBottom: 3 }}>
                        {c.name.includes(" — ") ? c.name.split(" — ")[1] : c.name}
                      </div>
                      <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
                        {c.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
        <div style={{ marginTop: 16, padding: "12px 16px", background: T.bg,
          border: `1px solid ${T.border}`, borderRadius: 8 }}>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.7 }}>
            📋 <strong style={{ color: T.text }}>Documentation note:</strong> DG shipments require
            a Dangerous Goods Declaration (DGD). The container must be marked and placarded with the
            appropriate IMDG hazard label. Always verify compliance with the carrier's DG acceptance
            policy and port restrictions before booking. Source:{" "}
            <a href="https://www.searates.com/reference/imo/" target="_blank" rel="noreferrer"
              style={{ color: T.accent }}>SeaRates IMO Reference</a>.
          </div>
        </div>
      </div>
    ),
  };

  return (
    <div style={{ display: "flex", gap: 28 }}>
      {/* Sidebar TOC */}
      <div style={{ width: 180, flexShrink: 0 }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: ".1em", padding: "0 14px 8px" }}>Contents</div>
        {SECTIONS.map(s => <SectionBtn key={s.id} id={s.id} label={s.label} />)}
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {content[section]}
      </div>
    </div>
  );
};

export default UserManualPage;