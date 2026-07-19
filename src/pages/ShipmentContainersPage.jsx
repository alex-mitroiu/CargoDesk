import { useState, useEffect, useRef } from "react";
import { T, teuOf, CUTOFF_STATE_VARIANT, COMPLIANCE_STATE_LABEL, worstState } from "../tokens";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import { ContainerForm } from "./ShipmentDetailPage";
import ContainerEventsPanel from "../components/shared/ContainerEventsPanel";
import ContainerPackagesPanel from "../components/shared/ContainerPackagesPanel";
import { api } from "../api";
import { setNavigationGuard, clearNavigationGuard } from "../navigationGuard";

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
  const [pkgsCtr,    setPkgsCtr]    = useState(null);
  const [dgPolicy,   setDgPolicy]   = useState(null);
  const ctrFormRef = useRef(null);

  useEffect(() => {
    if (!shipment.contractId) { setDgPolicy(null); return; }
    api.contracts.get(shipment.contractId)
      .then(c => setDgPolicy({ dgAllowed: c.dgAllowed, imdgClasses: c.imdgClasses || [] }))
      .catch(() => setDgPolicy(null));
  }, [shipment.contractId]);

  // Navigation guard (TKT-OJYO71): while the Add/Edit Container modal is open,
  // attempting to switch sections auto-validates + auto-saves via ContainerForm's
  // own imperative trySave() instead of silently discarding an in-progress edit —
  // only blocks (with the concrete field-level reason) if validation actually fails.
  useEffect(() => {
    if (!ctrModal) { clearNavigationGuard(); return; }
    setNavigationGuard({
      trySave: async () => {
        if (!ctrFormRef.current) return { ok: true };
        const result = await ctrFormRef.current.trySave();
        if (result.ok) setCtrModal(null);
        return result;
      },
    });
    return () => clearNavigationGuard();
  }, [ctrModal]);

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
    <div id="shpctr-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Toolbar */}
      <div id="shpctr-toolbar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span id="shpctr-summary" style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            {ctrs.length} container{ctrs.length !== 1 ? "s" : ""} · {totalTEU} TEU total
          </span>
          {dgConflicts > 0 && (
            <span id="shpctr-dg-conflicts" style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.warning,
              background: T.warning + "18", border: `1px solid ${T.warning}55`,
              borderRadius: 6, padding: "2px 8px" }}>
              ⚠ {dgConflicts} DG conflict{dgConflicts !== 1 ? "s" : ""} — review required
            </span>
          )}
        </div>
        {canEdit && <Btn id="shpctr-add-btn" onClick={() => setCtrModal("add")}>＋ Add Container</Btn>}
      </div>

      {/* Container table */}
      {ctrs.length === 0 ? (
        <div id="shpctr-empty" style={{ padding: 48, textAlign: "center", fontFamily: T.body,
          fontSize: 13, color: T.textMuted, fontStyle: "italic",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          No containers yet.
        </div>
      ) : (
        <div id="shpctr-table" style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface }}>
          <div id="shpctr-table-header" style={{ display: "flex", alignItems: "center", padding: "7px 14px",
            borderBottom: `1px solid ${T.border}`, background: T.bg }}>
            <div style={{ ...thStyle, width: 140, flexShrink: 0 }}>Container No.</div>
            <div style={{ ...thStyle, width: 104, flexShrink: 0 }}>Size / Type</div>
            <div style={{ ...thStyle, width: 44,  flexShrink: 0 }}>TEU</div>
            <div style={{ ...thStyle, width: 84,  flexShrink: 0 }}>HS Code</div>
            <div style={{ ...thStyle, flex: 1 }}>Cargo Description</div>
            <div style={{ ...thStyle, width: 88,  flexShrink: 0 }}>Wt / Vol</div>
            <div style={{ ...thStyle, width: 64,  flexShrink: 0 }}>DG</div>
            <div style={{ ...thStyle, width: 110, flexShrink: 0 }}>Compliance</div>
            <div style={{ ...thStyle, width: canEdit ? 132 : 60, flexShrink: 0 }} />
          </div>
          {ctrs.map(c => (
            <div key={c.id} id={`shpctr-${c.id}-row`} style={{ display: "flex", alignItems: "center", padding: "10px 14px",
              borderBottom: `1px solid ${T.border}22` }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <span id={`shpctr-${c.id}-number`} style={{ fontFamily: T.mono, fontSize: 12, color: T.textCode, fontWeight: 600,
                width: 140, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {c.containerNumber || "—"}
              </span>
              <div id={`shpctr-${c.id}-size-type`} style={{ width: 104, flexShrink: 0, display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>{c.size}ft</span>
                <Badge>{c.type}</Badge>
              </div>
              <span id={`shpctr-${c.id}-teu`} style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text,
                width: 44, flexShrink: 0 }}>{teuOf(c.size)}</span>
              <span id={`shpctr-${c.id}-hscode`} style={{ fontFamily: T.mono, fontSize: 11, color: c.hsCode ? T.textCode : T.border,
                width: 84, flexShrink: 0 }}>{c.hsCode || "—"}</span>
              <div id={`shpctr-${c.id}-cargo-description`} style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: T.body, fontSize: 12,
                  color: c.cargoDescription ? T.text : T.border,
                  fontStyle: c.cargoDescription ? "normal" : "italic",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.cargoDescription || "—"}
                </div>
              </div>
              <div id={`shpctr-${c.id}-weight-volume`} style={{ width: 88, flexShrink: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                {c.grossWeightKg != null && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{c.grossWeightKg.toLocaleString()} kg</span>}
                {c.volumeCbm    != null && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>{c.volumeCbm} m³</span>}
                {c.grossWeightKg == null && c.volumeCbm == null && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.border }}>—</span>}
              </div>
              <div id={`shpctr-${c.id}-dg`} style={{ width: 64, flexShrink: 0, display: "flex", flexDirection: "column", gap: 3 }}>
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
              <div id={`shpctr-${c.id}-compliance`} style={{ width: 110, flexShrink: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                {c.vgmCutoffState && c.vgmCutoffState !== "none" && (
                  <div title={`VGM: ${COMPLIANCE_STATE_LABEL[c.vgmCutoffState]}${c.vgmCutoff ? ` (cutoff ${c.vgmCutoff})` : ""}`}>
                    <Badge variant={CUTOFF_STATE_VARIANT[c.vgmCutoffState]} size={9.5}>VGM · {COMPLIANCE_STATE_LABEL[c.vgmCutoffState]}</Badge>
                  </div>
                )}
                {c.cyCutoffState && c.cyCutoffState !== "none" && (
                  <div title={`CY cutoff: ${COMPLIANCE_STATE_LABEL[c.cyCutoffState]}${c.cyCutoff ? ` (${c.cyCutoff})` : ""}`}>
                    <Badge variant={CUTOFF_STATE_VARIANT[c.cyCutoffState]} size={9.5}>CY · {COMPLIANCE_STATE_LABEL[c.cyCutoffState]}</Badge>
                  </div>
                )}
                {worstState([c.originFreeTimeState, c.destFreeTimeState]) && (
                  <div title={`Origin free time: ${c.originFreeTimeState || "not tracked"}${c.originFreeTimeDaysRemaining != null ? ` (${c.originFreeTimeDaysRemaining}d)` : ""} · Destination: ${c.destFreeTimeState || "not tracked"}${c.destFreeTimeDaysRemaining != null ? ` (${c.destFreeTimeDaysRemaining}d)` : ""}`}>
                    <Badge variant={CUTOFF_STATE_VARIANT[worstState([c.originFreeTimeState, c.destFreeTimeState])]} size={9.5}>
                      FT · {COMPLIANCE_STATE_LABEL[worstState([c.originFreeTimeState, c.destFreeTimeState])]}
                    </Badge>
                  </div>
                )}
              </div>
              <div style={{ width: canEdit ? 168 : 96, flexShrink: 0, display: "flex", gap: 5 }}>
                <Btn id={`shpctr-${c.id}-events-btn`} size="sm" variant="secondary" onClick={() => setEventsCtr(c)}
                  title={c.latestEventType ? `Latest: ${c.latestEventType}${c.latestEventLocation ? ` @ ${c.latestEventLocation}` : ""} (${c.latestEventAt || ""})` : "No lifecycle events yet"}>📋</Btn>
                <Btn id={`shpctr-${c.id}-packages-btn`} size="sm" variant="secondary" onClick={() => setPkgsCtr(c)}
                  title="Cargo manifest — pallet/box breakdown">📦</Btn>
                {canEdit && (
                  <>
                    <Btn id={`shpctr-${c.id}-edit-btn`} size="sm" variant="secondary" onClick={() => setCtrModal(c)}>Edit</Btn>
                    <Btn id={`shpctr-${c.id}-delete-btn`} size="sm" variant="danger" onClick={() => setConfirmCtr(c.id)}>✕</Btn>
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
          <ContainerForm ref={ctrFormRef} init={ctrModal === "add" ? {} : ctrModal}
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

      {/* Cargo manifest — pallet/box breakdown */}
      {pkgsCtr && (
        <Modal title={`Cargo Manifest — ${pkgsCtr.containerNumber || pkgsCtr.id}`}
          onClose={() => setPkgsCtr(null)} width={520}>
          <ContainerPackagesPanel containerId={pkgsCtr.id} containerNumber={pkgsCtr.containerNumber} />
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
