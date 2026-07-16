import { useState, useEffect } from "react";
import { T, teuOf } from "../tokens";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import { ContainerForm } from "./ShipmentDetailPage";
import ContainerEventsPanel from "../components/shared/ContainerEventsPanel";
import { api } from "../api";

// ─── Shipment Containers Page ─────────────────────────────────────────────────
// Dedicated sub-page for FCL container management, promoted out of the
// anchor-scroll Overview page (first proof-of-concept for the shipment
// Explorer restructuring — see ARCHITECTURE.md §8.11 / TKT-WTF0J4).

const ShipmentContainersPage = ({ shipment, containers, onBack, onAddContainer, onEditContainer, onDeleteContainer }) => {
  const { canEditShipments: canEdit } = useAuth();
  const ctrs     = containers.filter(c => c.shipmentId === shipment.id);
  const totalTEU = ctrs.reduce((sum, c) => sum + teuOf(c.size), 0);

  const [ctrModal,   setCtrModal]   = useState(null); // null | "add" | container object
  const [confirmCtr, setConfirmCtr] = useState(null);
  const [eventsCtr,  setEventsCtr]  = useState(null);
  const [dgPolicy,   setDgPolicy]   = useState(null);

  useEffect(() => {
    if (!shipment.contractId) { setDgPolicy(null); return; }
    api.contracts.get(shipment.contractId)
      .then(c => setDgPolicy({ dgAllowed: c.dgAllowed, imdgClasses: c.imdgClasses || [] }))
      .catch(() => setDgPolicy(null));
  }, [shipment.contractId]);

  const ctrDgConflict = c => {
    if (!c.isDg || !c.dgClass || !dgPolicy) return null;
    if (!dgPolicy.dgAllowed) return "Contract does not permit DG cargo";
    if (dgPolicy.imdgClasses.length > 0 && !dgPolicy.imdgClasses.includes(c.dgClass))
      return `IMO class ${c.dgClass} not permitted by contract (allowed: ${dgPolicy.imdgClasses.join(", ")})`;
    return null;
  };
  const dgConflicts = ctrs.filter(ctrDgConflict).length;

  const closeCtrModal = () => setCtrModal(null);

  const thStyle = { fontFamily: T.body, fontSize: 10, fontWeight: 700,
    color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em" };

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            {ctrs.length} container{ctrs.length !== 1 ? "s" : ""} · {totalTEU} TEU total
          </span>
          {dgConflicts > 0 && (
            <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.warning,
              background: T.warning + "18", border: `1px solid ${T.warning}55`,
              borderRadius: 6, padding: "2px 8px" }}>
              ⚠ {dgConflicts} DG conflict{dgConflicts !== 1 ? "s" : ""} — review required
            </span>
          )}
        </div>
        {canEdit && <Btn onClick={() => setCtrModal("add")}>＋ Add Container</Btn>}
      </div>

      {/* Container table */}
      {ctrs.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", fontFamily: T.body,
          fontSize: 13, color: T.textMuted, fontStyle: "italic",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          No containers yet.
        </div>
      ) : (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface }}>
          <div style={{ display: "flex", alignItems: "center", padding: "7px 14px",
            borderBottom: `1px solid ${T.border}`, background: T.bg }}>
            <div style={{ ...thStyle, width: 140, flexShrink: 0 }}>Container No.</div>
            <div style={{ ...thStyle, width: 104, flexShrink: 0 }}>Size / Type</div>
            <div style={{ ...thStyle, width: 44,  flexShrink: 0 }}>TEU</div>
            <div style={{ ...thStyle, width: 84,  flexShrink: 0 }}>HS Code</div>
            <div style={{ ...thStyle, flex: 1 }}>Cargo Description</div>
            <div style={{ ...thStyle, width: 88,  flexShrink: 0 }}>Wt / Vol</div>
            <div style={{ ...thStyle, width: 64,  flexShrink: 0 }}>DG</div>
            <div style={{ ...thStyle, width: canEdit ? 132 : 60, flexShrink: 0 }} />
          </div>
          {ctrs.map(c => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", padding: "10px 14px",
              borderBottom: `1px solid ${T.border}22` }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 600,
                width: 140, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.containerNumber || "—"}
              </span>
              <div style={{ width: 104, flexShrink: 0, display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>{c.size}ft</span>
                <Badge>{c.type}</Badge>
              </div>
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text,
                width: 44, flexShrink: 0 }}>{teuOf(c.size)}</span>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: c.hsCode ? T.textCode : T.border,
                width: 84, flexShrink: 0 }}>{c.hsCode || "—"}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.body, fontSize: 12,
                  color: c.cargoDescription ? T.text : T.border,
                  fontStyle: c.cargoDescription ? "normal" : "italic",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.cargoDescription || "—"}
                </div>
              </div>
              <div style={{ width: 88, flexShrink: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                {c.grossWeightKg != null && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{c.grossWeightKg.toLocaleString()} kg</span>}
                {c.volumeCbm    != null && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{c.volumeCbm} m³</span>}
                {c.grossWeightKg == null && c.volumeCbm == null && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>}
              </div>
              <div style={{ width: 64, flexShrink: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                {c.isDg && c.dgClass
                  ? <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                      color: "#fff", background: T.danger, borderRadius: 4, padding: "2px 7px" }}>
                      IMO {c.dgClass}
                    </span>
                  : <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>}
                {ctrDgConflict(c) && (
                  <span title={ctrDgConflict(c)}
                    style={{ fontFamily: T.body, fontSize: 9, fontWeight: 700, color: T.warning,
                      background: T.warning + "18", border: `1px solid ${T.warning}55`,
                      borderRadius: 4, padding: "1px 5px", cursor: "default", whiteSpace: "nowrap" }}>
                    ⚠ conflict
                  </span>
                )}
              </div>
              <div style={{ width: canEdit ? 132 : 60, flexShrink: 0, display: "flex", gap: 5 }}>
                <Btn size="sm" variant="secondary" onClick={() => setEventsCtr(c)}>📋</Btn>
                {canEdit && (
                  <>
                    <Btn size="sm" variant="secondary" onClick={() => setCtrModal(c)}>Edit</Btn>
                    <Btn size="sm" variant="danger" onClick={() => setConfirmCtr(c.id)}>✕</Btn>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit modal */}
      {ctrModal && (
        <Modal title={ctrModal === "add" ? "Add Container" : "Edit Container"} onClose={closeCtrModal}>
          <ContainerForm init={ctrModal === "add" ? {} : ctrModal}
            dgPolicy={dgPolicy}
            onSave={async form => {
              try {
                ctrModal === "add"
                  ? await onAddContainer(shipment.id, form)
                  : await onEditContainer(ctrModal.id, form);
                closeCtrModal();
              } catch { /* error already toasted by App.jsx handler */ }
            }}
            onCancel={closeCtrModal} />
        </Modal>
      )}

      {/* Lifecycle events */}
      {eventsCtr && (
        <Modal title={`Lifecycle Events — ${eventsCtr.containerNumber || eventsCtr.id}`}
          onClose={() => setEventsCtr(null)} width={480}>
          <ContainerEventsPanel containerId={eventsCtr.id} containerNumber={eventsCtr.containerNumber} />
        </Modal>
      )}

      {/* Delete confirm */}
      {confirmCtr && (
        <ConfirmModal
          message="Remove this container from the shipment?"
          onConfirm={() => { onDeleteContainer(confirmCtr); setConfirmCtr(null); }}
          onCancel={() => setConfirmCtr(null)} />
      )}
    </div>
  );
};

export default ShipmentContainersPage;
