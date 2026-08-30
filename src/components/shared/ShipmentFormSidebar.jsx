import { T } from "../../tokens";
import { toast } from "../../toast";
import { IconAnchor } from "../primitives/Icon";

// ─── Shipment Form Sidebar ────────────────────────────────────────────────────

const ShipmentFormSidebar = ({ shipment, mode, navigate, onContainers }) => {
  const goBack = () => {
    if (window.opener) { window.close(); return; }
    if (mode === "edit" && shipment) navigate("detail", shipment.id);
    else navigate("shipments");
  };

  const STATUS_COLORS = {
    Active:    { bg: "#22c55e22", color: "#22c55e" },
    Completed: { bg: "#3b82f622", color: "#3b82f6" },
    Cancelled: { bg: "#ef444422", color: "#ef4444" },
  };
  const sc = shipment ? (STATUS_COLORS[shipment.status] || { bg: "#ffffff11", color: T.textMuted }) : null;

  return (
    <aside style={{ width: 240, background: T.surface, borderRight: `1px solid ${T.border}`,
      display: "flex", flexDirection: "column", flexShrink: 0 }}>

      <div style={{ padding: "22px 20px 18px", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontFamily: T.head, fontSize: 17, fontWeight: 800, color: T.text,
          display: "flex", alignItems: "center", gap: 7 }}><IconAnchor size={17} />CargoDesk</div>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.textMuted, marginTop: 3,
          letterSpacing: ".12em", textTransform: "uppercase" }}>Freight Management</div>
      </div>

      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}` }}>
        <button onClick={goBack} style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          padding: "8px 12px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}`,
          fontFamily: T.body, fontSize: 13, color: T.text, cursor: "pointer", fontWeight: 500, textAlign: "left",
        }}>
          ← {mode === "edit" && shipment ? shipment.id : "All Shipments"}
        </button>
      </div>

      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column", gap: 7 }}>
        {mode === "new" ? (
          <>
            <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.textMuted }}>New Shipment</div>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.border }}>Fill in the form to create</div>
          </>
        ) : shipment ? (
          <>
            <div style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 800, color: T.text,
              cursor: "pointer", userSelect: "none" }}
              title="Click to copy"
              onClick={() => navigator.clipboard.writeText(shipment.id).then(() => toast.success(`Copied ${shipment.id}`))}>
              {shipment.id}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, borderRadius: 4,
                padding: "2px 8px", background: sc.bg, color: sc.color }}>{shipment.status}</span>
              {shipment.carrierCode && (
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{shipment.carrierCode}</span>
              )}
            </div>
            {(shipment.pol || shipment.pod) && (
              <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text, fontWeight: 600 }}>
                {shipment.pol || "—"} → {shipment.pod || "—"}
              </div>
            )}
            {shipment.etd && (
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>ETD {shipment.etd}</div>
            )}
          </>
        ) : null}
      </div>

      {onContainers && (
        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${T.border}` }}>
          <button onClick={onContainers} style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%",
            padding: "8px 12px", borderRadius: 8, background: "transparent",
            border: `1px solid ${T.border}`, fontFamily: T.body, fontSize: 13,
            color: T.text, cursor: "pointer", fontWeight: 500, textAlign: "left",
            transition: "border-color .15s, background .15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.background = T.accentBg; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.background = "transparent"; }}>
            📦 {mode === "new" ? "Manage Containers" : "Containers"}
          </button>
        </div>
      )}

      <div style={{ padding: "14px 16px", flex: 1 }}>
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.border, fontWeight: 700,
          textTransform: "uppercase", letterSpacing: ".12em", marginBottom: 8 }}>
          {mode === "new" ? "Creating" : "Editing"}
        </div>
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.55 }}>
          {mode === "new"
            ? "Unsaved changes will be lost if you navigate away."
            : "Changes are saved when you click Save Changes."}
        </div>
      </div>
    </aside>
  );
};

export default ShipmentFormSidebar;
