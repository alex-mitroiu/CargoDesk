import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { IconArchive, IconPackage } from "../../components/primitives/Icon";

// ─── Equipment (hub) ──────────────────────────────────────────────────────────
// Landing page for the equipment type catalog (20ft Dry, 40ft High Cube, ...) and the
// cargo-manifest pack-type catalog (Pallet, Carton, ...). A clickable nav page rather than a
// plain section header, per direct request — each card below is the "button to access it
// directly".

const EquipmentCard = ({ icon: IconComp, title, description, count, onClick }) => (
  <div onClick={onClick}
    style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 24,
      cursor: "pointer", display: "flex", flexDirection: "column", gap: 12, transition: "border-color .12s, transform .12s" }}
    onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.transform = "translateY(-2px)"; }}
    onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.transform = "translateY(0)"; }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: T.accentBg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <IconComp size={20} color={T.accent} />
      </div>
      {count != null && (
        <span style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800, color: T.text }}>{count}</span>
      )}
    </div>
    <div>
      <div style={{ fontFamily: T.head, fontSize: 16, fontWeight: 700, color: T.text }}>{title}</div>
      <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginTop: 4, lineHeight: 1.4 }}>{description}</div>
    </div>
  </div>
);

const MdmEquipmentPage = ({ navigate }) => {
  const [counts, setCounts] = useState({ containerTypes: null, packTypes: null });

  useEffect(() => {
    Promise.all([
      api.containerTypes.list().catch(() => []),
      api.packTypes.list().catch(() => []),
    ]).then(([containerTypes, packTypes]) => {
      setCounts({ containerTypes: containerTypes.length, packTypes: packTypes.length });
    });
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Equipment</h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
          The equipment type catalog and cargo pack types
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        <EquipmentCard
          icon={IconArchive}
          title="Container Types"
          description="Admin-maintained equipment catalog — 20ft Dry, 40ft High Cube, Reefer, Flat Rack, Tank, ... feeds the Equipment Type field on a shipment's Cargo Details."
          count={counts.containerTypes}
          onClick={() => navigate("mdm-container-types")}
        />
        <EquipmentCard
          icon={IconPackage}
          title="Pack Types"
          description="Reference list for the container cargo manifest tree — Pallet, Carton, Box, ..."
          count={counts.packTypes}
          onClick={() => navigate("mdm-pack-types")}
        />
      </div>
    </div>
  );
};

export default MdmEquipmentPage;
