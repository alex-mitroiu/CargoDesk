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

// Rotation editor — a loop's ports split into two independently-ordered Eastbound/Westbound
// columns (2026-09-18 redesign). A port can legitimately sit in both (a shared hub/turn port
// called on both legs), so `direction` is a plain per-row tag rather than a partition — moving a
// row between columns just flips its tag. Each column reorders independently via the same native
// HTML5 drag-and-drop the single-list version used (ShipmentDetailSidebar.jsx's admin-sidebar
// reorder precedent); on save the two columns concatenate Eastbound-then-Westbound into the one
// flat `sequence_order` the backend/map/timeline consumers have always expected — nothing
// downstream of the rotation needs to know direction ever existed.
const DIRECTIONS = [
  { key: "EB", label: "Eastbound", flip: "→" },
  { key: "WB", label: "Westbound", flip: "←" },
];

const RotationEditor = ({ loopCodeId, onClose }) => {
  const [ports, setPorts] = useState(null); // null = loading; flat array, each row tagged `direction`
  const [pickEB, setPickEB] = useState(null);
  const [pickWB, setPickWB] = useState(null);
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState(null);       // { dir, idx } | null
  const [dragOver, setDragOver] = useState(null); // { dir, idx } | null

  const load = useCallback(async () => {
    const row = await api.loopCodes.get(loopCodeId);
    setPorts((row.ports || []).map(p => ({ ...p, direction: p.direction === "WB" ? "WB" : "EB" })));
  }, [loopCodeId]);

  useEffect(() => { load(); }, [load]);

  const eastbound = (ports || []).filter(p => p.direction === "EB");
  const westbound = (ports || []).filter(p => p.direction === "WB");
  const columnFor = key => key === "EB" ? eastbound : westbound;

  // Every mutation walks the flat `ports` array counting only rows in the target column, so a
  // column-local index (i, as rendered) maps back to the right row regardless of the other
  // column's contents or ordering.
  const mapColumn = (dir, idx, fn) => setPorts(p => {
    let seen = -1;
    return p.map(row => {
      if (row.direction !== dir) return row;
      seen++;
      return seen === idx ? fn(row) : row;
    });
  });

  const addPort = (dir) => {
    const pick = dir === "EB" ? pickEB : pickWB;
    if (!pick) return;
    setPorts(p => [...p, { portUnlocode: pick.unlocode, portName: pick.name, transitDayOffset: null, direction: dir }]);
    (dir === "EB" ? setPickEB : setPickWB)(null);
  };
  const removeAt = (dir, idx) => setPorts(p => {
    let seen = -1;
    return p.filter(row => { if (row.direction !== dir) return true; seen++; return seen !== idx; });
  });
  const setOffsetAt = (dir, idx, v) => mapColumn(dir, idx, row => ({ ...row, transitDayOffset: v === "" ? null : Number(v) }));
  const flipDirection = (dir, idx) => mapColumn(dir, idx, row => ({ ...row, direction: dir === "EB" ? "WB" : "EB" }));

  const handleDrop = (dir) => {
    if (!drag || !dragOver || drag.dir !== dir || dragOver.dir !== dir || drag.idx === dragOver.idx) { setDrag(null); setDragOver(null); return; }
    setPorts(p => {
      const col = p.filter(x => x.direction === dir);
      const rest = p.filter(x => x.direction !== dir);
      const reordered = [...col];
      const [moved] = reordered.splice(drag.idx, 1);
      reordered.splice(dragOver.idx, 0, moved);
      return dir === "EB" ? [...reordered, ...rest] : [...rest, ...reordered];
    });
    setDrag(null); setDragOver(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      const combined = [...eastbound, ...westbound]
        .map(p => ({ portUnlocode: p.portUnlocode, transitDayOffset: p.transitDayOffset, direction: p.direction }));
      await api.loopCodes.saveRotation(loopCodeId, combined);
      onClose(true);
    } catch (e) { alert(e.message); } // eslint-disable-line no-alert
    setSaving(false);
  };

  if (ports === null) return <PageSpinner />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        {DIRECTIONS.map(({ key, label, flip }) => {
          const list = columnFor(key);
          const pick = key === "EB" ? pickEB : pickWB;
          const setPick = key === "EB" ? setPickEB : setPickWB;
          return (
            <div key={key} style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
              <div style={{ fontFamily: T.body, fontSize: 11.5, fontWeight: 700, color: T.text, textTransform: "uppercase", letterSpacing: ".05em" }}>
                {label} <span style={{ color: T.textMuted, fontWeight: 500 }}>({list.length})</span>
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <PortField value={pick} onChange={setPick} placeholder="Search UN/LOCODE…" />
                </div>
                <Btn variant="secondary" onClick={() => addPort(key)} disabled={!pick}>＋</Btn>
              </div>

              {list.length === 0 ? (
                <div style={{ padding: "16px 0", textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 12 }}>
                  No {label.toLowerCase()} ports yet.
                </div>
              ) : list.map((p, i) => (
                <div key={`${key}-${p.portUnlocode}-${i}`} draggable
                  onDragStart={() => setDrag({ dir: key, idx: i })} onDragEnd={() => handleDrop(key)}
                  onDragOver={e => { e.preventDefault(); setDragOver({ dir: key, idx: i }); }}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px",
                    borderRadius: 7, cursor: "grab",
                    background: dragOver?.dir === key && dragOver.idx === i ? `${T.accent}12` : T.bg,
                    border: `1px solid ${dragOver?.dir === key && dragOver.idx === i ? T.accent + "55" : T.border}` }}>
                  <span style={{ color: T.border, fontSize: 12 }}>⠿</span>
                  <span style={{ fontFamily: T.mono, fontSize: 9, color: T.bg, background: T.border, width: 16, height: 16,
                    borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>{i + 1}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 700, width: 46, flexShrink: 0 }}>{p.portUnlocode}</span>
                  <span title={p.portName} style={{ fontFamily: T.body, fontSize: 11.5, color: T.text, flex: 1, minWidth: 0,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.portName}</span>
                  <input type="number" value={p.transitDayOffset ?? ""} onChange={e => setOffsetAt(key, i, e.target.value)}
                    placeholder="Day" title="Day offset from loop start (optional)"
                    style={{ width: 42, fontFamily: T.mono, fontSize: 11, color: T.text, background: T.surface,
                      border: `1px solid ${T.border}`, borderRadius: 5, padding: "3px 4px", textAlign: "center", flexShrink: 0 }} />
                  <button type="button" onClick={() => flipDirection(key, i)} title={`Move to ${key === "EB" ? "Westbound" : "Eastbound"}`}
                    style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 13, padding: 2, flexShrink: 0 }}>{flip}</button>
                  <button type="button" onClick={() => removeAt(key, i)}
                    style={{ background: "none", border: "none", color: T.textMuted, cursor: "pointer", fontSize: 12, padding: 2, flexShrink: 0 }}>✕</button>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
        <Btn variant="secondary" onClick={() => onClose(false)}>Cancel</Btn>
        <Btn disabled={ports.length < 2 || saving} onClick={save}>{saving ? "Saving…" : "Save Rotation"}</Btn>
      </div>
    </div>
  );
};

// Combined Edit modal — "Edit" and the former standalone "Edit Rotation" action now open the same
// modal with a tab switcher, rather than two separate dialogs (direct request, 2026-09-18). The
// Details tab is admin/operator-only (matches the original per-item gate on the "Edit" menu
// action) — a non-admin can still reach this modal via "Edit Rotation" (that action was never
// gated), so `canManageMdm` also hides the tab bar entirely rather than just disabling it, since a
// visible-but-inert Details tab would leak that the field exists without letting a reader query it.
const LoopCodeEditModal = ({ loop, initialTab, canManageMdm, onClose, onSaved }) => {
  const [tab, setTab] = useState(canManageMdm ? initialTab : "rotation");
  const showTabs = canManageMdm;

  return (
    <Modal title={`Loop Code — ${loop.code}`} onClose={() => onClose()} width={tab === "rotation" ? 780 : 480}>
      {showTabs && (
        <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: `1px solid ${T.border}` }}>
          {[["details", "Details"], ["rotation", "Rotation"]].map(([key, label]) => (
            <button key={key} type="button" onClick={() => setTab(key)}
              style={{ padding: "8px 16px", marginBottom: -1, background: "none", cursor: "pointer",
                fontFamily: T.body, fontSize: 13, fontWeight: 600,
                border: "none", borderBottom: `2px solid ${tab === key ? T.accent : "transparent"}`,
                color: tab === key ? T.accent : T.textMuted }}>
              {label}
            </button>
          ))}
        </div>
      )}
      {tab === "details" ? (
        <LoopCodeForm init={loop}
          onSave={async d => { await api.loopCodes.update(loop.id, d); onSaved(); }}
          onCancel={() => onClose()} />
      ) : (
        <RotationEditor loopCodeId={loop.id} onClose={saved => saved ? onSaved() : onClose()} />
      )}
    </Modal>
  );
};

const MdmLoopCodesPage = () => {
  const { canManageMdm } = useAuth();
  const [loops,   setLoops]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add"
  const [editModal, setEditModal] = useState(null); // null | { loop, tab: "details"|"rotation" }
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
                { icon: IconRoute, label: "Edit Rotation", onClick: () => setEditModal({ loop: l, tab: "rotation" }) },
                ...(canManageMdm ? [{ icon: IconPencil, label: "Edit", onClick: () => setEditModal({ loop: l, tab: "details" }) }] : []),
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
      {editModal && (
        <LoopCodeEditModal loop={editModal.loop} initialTab={editModal.tab} canManageMdm={canManageMdm}
          onClose={() => setEditModal(null)}
          onSaved={() => { setEditModal(null); load(); }} />
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
