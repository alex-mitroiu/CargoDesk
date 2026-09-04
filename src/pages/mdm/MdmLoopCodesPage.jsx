import { useState, useCallback, useEffect } from "react";
import Spinner, { PageSpinner } from "../../components/primitives/Spinner";
import { T } from "../../tokens";
import { api } from "../../api";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import { Inp } from "../../components/primitives/Form";
import PortField from "../../components/shared/PortField";
import ActionMenu from "../../components/primitives/ActionMenu";
import { IconPencil, IconClose, IconRoute } from "../../components/primitives/Icon";
import { useResizableColumns, ColResizer } from "../../components/primitives/useResizableColumns.jsx";

// ─── MDM: Loop Codes Page ──────────────────────────────────────────────────────
// A carrier's named service loop (e.g. "AL1") and its ordered port rotation — backs the route
// map/timeline opened from a shipment header's Loop field (LoopRouteModal.jsx), resolved by
// matching `loop_codes.code` against the shipment's live-derived loop string. That derivation
// (src/utils/scheduleLoop.js) has no FK into this table, so a loop with no matching row here
// simply shows "no route data registered" on the shipment side — this registry is opt-in.

const LoopCodeForm = ({ init = {}, onSave, onCancel }) => {
  const [code, setCode] = useState(init.code || "");
  const [name, setName] = useState(init.name || "");
  const [carrierCode, setCarrierCode] = useState(init.carrierCode || "");
  const [frequencyDays, setFrequencyDays] = useState(init.frequencyDays ?? "");
  const [roundTripDays, setRoundTripDays] = useState(init.roundTripDays ?? "");
  const isEdit = !!init.id;
  const valid = (isEdit || code.trim().length >= 2) && name.trim().length >= 2;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {!isEdit && <Inp label="Loop Code" value={code} onChange={v => setCode(v.toUpperCase())} placeholder="AL1" mono required hint="Matches the service code carried on a saved sailing" />}
      {isEdit && (
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px",
          fontFamily: T.mono, fontSize: 14, color: T.accent, fontWeight: 700 }}>{init.code}</div>
      )}
      <Inp label="Loop Name" value={name} onChange={setName} placeholder="Atlantic Loop 1" required />
      <Inp label="Carrier Code" value={carrierCode} onChange={v => setCarrierCode(v.toUpperCase())} placeholder="HLCU" mono hint="Optional — the operating carrier's SCAC/code" />
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1 }}>
          <Inp label="Frequency (days)" type="number" value={frequencyDays} onChange={setFrequencyDays} placeholder="7" hint="e.g. 7 for weekly" />
        </div>
        <div style={{ flex: 1 }}>
          <Inp label="Round Trip (days)" type="number" value={roundTripDays} onChange={setRoundTripDays} placeholder="35" />
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn disabled={!valid} onClick={() => onSave({
          code: code.trim().toUpperCase(), name: name.trim(), carrierCode: carrierCode.trim() || null,
          frequencyDays: frequencyDays === "" ? null : Number(frequencyDays),
          roundTripDays: roundTripDays === "" ? null : Number(roundTripDays),
        })}>
          {isEdit ? "Save Changes" : "Add Loop Code"}
        </Btn>
      </div>
    </div>
  );
};

// Rotation editor — native HTML5 drag-and-drop reorder, same splice-and-reinsert pattern the
// admin sidebar reorder (ShipmentDetailSidebar.jsx) already established for this codebase,
// rather than a new DnD dependency.
const RotationEditor = ({ loopCodeId, onClose }) => {
  const [ports, setPorts] = useState(null); // null = loading
  const [pick, setPick] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dragIdx, setDragIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  const load = useCallback(async () => {
    const row = await api.loopCodes.get(loopCodeId);
    setPorts(row.ports || []);
  }, [loopCodeId]);

  useEffect(() => { load(); }, [load]);

  const addPort = () => {
    if (!pick) return;
    setPorts(p => [...p, { portUnlocode: pick.unlocode, portName: pick.name, transitDayOffset: null }]);
    setPick(null);
  };
  const removeAt = i => setPorts(p => p.filter((_, idx) => idx !== i));
  const setOffsetAt = (i, v) => setPorts(p => p.map((row, idx) => idx === i ? { ...row, transitDayOffset: v === "" ? null : Number(v) } : row));

  const handleDrop = () => {
    if (dragIdx === null || dragOverIdx === null || dragIdx === dragOverIdx) { setDragIdx(null); setDragOverIdx(null); return; }
    setPorts(p => {
      const reordered = [...p];
      const [moved] = reordered.splice(dragIdx, 1);
      reordered.splice(dragOverIdx, 0, moved);
      return reordered;
    });
    setDragIdx(null); setDragOverIdx(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.loopCodes.saveRotation(loopCodeId, ports.map(p => ({ portUnlocode: p.portUnlocode, transitDayOffset: p.transitDayOffset })));
      onClose(true);
    } catch (e) { alert(e.message); } // eslint-disable-line no-alert
    setSaving(false);
  };

  if (ports === null) return <PageSpinner />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <PortField label="Add Port to Rotation" value={pick} onChange={setPick} placeholder="Search UN/LOCODE…" />
        </div>
        <Btn variant="secondary" onClick={addPort} disabled={!pick}>＋ Add</Btn>
      </div>

      {ports.length === 0 ? (
        <div style={{ padding: "20px 0", textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
          No ports in this rotation yet — add at least 2 above.
        </div>
      ) : ports.map((p, i) => (
        <div key={`${p.portUnlocode}-${i}`} draggable onDragStart={() => setDragIdx(i)} onDragEnd={handleDrop}
          onDragOver={e => { e.preventDefault(); setDragOverIdx(i); }}
          style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px",
            borderRadius: 7, cursor: "grab",
            background: dragOverIdx === i ? `${T.accent}12` : T.bg,
            border: `1px solid ${dragOverIdx === i ? T.accent + "55" : T.border}` }}>
          <span style={{ color: T.border, fontSize: 13 }}>⠿</span>
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.bg, background: T.border, width: 18, height: 18,
            borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700, width: 56 }}>{p.portUnlocode}</span>
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, flex: 1 }}>{p.portName}</span>
          <input type="number" value={p.transitDayOffset ?? ""} onChange={e => setOffsetAt(i, e.target.value)}
            placeholder="Day" title="Day offset from loop start (optional)"
            style={{ width: 54, fontFamily: T.mono, fontSize: 12, color: T.text, background: T.surface,
              border: `1px solid ${T.border}`, borderRadius: 5, padding: "4px 6px", textAlign: "center" }} />
          <button type="button" onClick={() => removeAt(i)}
            style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 13, padding: 4 }}>✕</button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4, borderTop: `1px solid ${T.border}` }}>
        <Btn variant="secondary" onClick={() => onClose(false)}>Cancel</Btn>
        <Btn disabled={ports.length < 2 || saving} onClick={save}>{saving ? "Saving…" : "Save Rotation"}</Btn>
      </div>
    </div>
  );
};

const MdmLoopCodesPage = () => {
  const { canManageMdm } = useAuth();
  const [loops,   setLoops]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | loop obj
  const [rotation, setRotation] = useState(null); // loop id being edited
  const [confirm, setConfirm] = useState(null);
  const { template, startResize } = useResizableColumns("mdm-loop-codes", [90,180,110,80,110,110,90,110]);
  const headers = ["Code","Name","Carrier","Ports","Frequency","Round Trip","Status","Actions"];

  const load = useCallback(async () => {
    setLoading(true);
    try { setLoops(await api.loopCodes.list()); } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Loop Codes</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {loops.length} loop{loops.length !== 1 ? "s" : ""} registered — clicking a shipment's Loop field resolves against these
          </p>
        </div>
        {canManageMdm && <Btn onClick={() => setModal("add")} size="lg">＋ Add Loop Code</Btn>}
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: template,
          padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {headers.map((h, i) => (
            <div key={i} style={{ position: "relative", paddingLeft: 6, fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              {h}{i < headers.length - 1 && <ColResizer onStart={e => startResize(i, e)} />}
            </div>
          ))}
        </div>
        {loading ? (
          <PageSpinner />
        ) : loops.length === 0 ? (
          <div style={{ padding: 40, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No loop codes yet. Use "＋ Add Loop Code" to register one, then build its rotation.
          </div>
        ) : loops.map(l => (
          <div key={l.id}
            style={{ display: "grid", gridTemplateColumns: template,
              padding: "13px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
              transition: "background .1s" }}
            onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700 }}>{l.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{l.name}</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{l.carrierCode || "—"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>{l.portCount}</span>
            <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text }}>{l.frequencyDays ? `${l.frequencyDays}d` : "—"}</span>
            <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text }}>{l.roundTripDays ? `${l.roundTripDays}d` : "—"}</span>
            <span style={{ fontFamily: T.mono, fontSize: 11.5, color: l.isActive ? T.success : T.textMuted }}>{l.isActive ? "● Active" : "○ Inactive"}</span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                { icon: IconRoute, label: "Edit Rotation", onClick: () => setRotation(l.id) },
                ...(canManageMdm ? [{ icon: IconPencil, label: "Edit", onClick: () => setModal(l) }] : []),
                ...(canManageMdm ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(l) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Loop Code" onClose={() => setModal(null)}>
          <LoopCodeForm onSave={async d => { await api.loopCodes.create(d); setModal(null); load(); }} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Loop Code" onClose={() => setModal(null)}>
          <LoopCodeForm init={modal}
            onSave={async d => { await api.loopCodes.update(modal.id, d); setModal(null); load(); }}
            onCancel={() => setModal(null)} />
        </Modal>
      )}
      {rotation && (
        <Modal title={`Rotation — ${loops.find(l => l.id === rotation)?.code || ""}`} onClose={() => setRotation(null)} width={620}>
          <RotationEditor loopCodeId={rotation} onClose={saved => { setRotation(null); if (saved) load(); }} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal message={`Delete loop code "${confirm.code}"? Its rotation will be removed too. Shipments referencing this loop by name are not affected.`}
          onConfirm={async () => { await api.loopCodes.remove(confirm.id); setConfirm(null); load(); }}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmLoopCodesPage;
