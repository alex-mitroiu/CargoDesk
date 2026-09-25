import { useState, useEffect } from "react";
import { ADDITIONAL_PARTY_ROLES } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import { inputBase } from "../primitives/Form";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import { Modal } from "../primitives/Modal";
import CustomerCombobox from "./CustomerCombobox";
import { HZ, HZ_MONO, HZ_BODY, useHorizonFonts } from "../../pages/shipments/shipmentDetailTheme";

// ─── Line Agent Candidates Modal ──────────────────────────────────────────────
// Modeled directly on PendingRevalidationModal (ShipmentDetailPage.jsx) — same visual language
// (Modal, selectable cards, single-vs-multi wording) for the same class of problem: an
// auto-resolution step found more than one equally-valid option and needs a human pick instead of
// guessing. Dismissible, not forced — closing without picking leaves the role exactly as
// unassigned as it already is; AdditionalPartiesPanel's own manual "+ Add Party" flow is always
// still there as a fallback. Each side (export/import) resolves independently — picking one
// doesn't require picking the other in the same sitting.
const SIDE_LABEL = { export: "Line Agent (Export)", import: "Line Agent (Import)" };

const LineAgentCandidatesModal = ({ candidates, onResolve, onDismiss }) => {
  const sides = Object.keys(candidates);
  const [selected, setSelected] = useState({});

  return (
    <Modal
      title={sides.length > 1 ? "Multiple Line Agent Picks Needed" : "Multiple Line Agents Found"}
      onClose={onDismiss}
      width={560}
      data-testid="shipment-parties-line-agent-candidates-modal"
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <p style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.text, lineHeight: 1.6, margin: 0 }}>
          More than one registered Line Agent matches this shipment's route via a linked port —
          pick which one to assign below, or dismiss and assign one manually later.
        </p>
        {sides.map(side => (
          <div key={side}>
            <div style={{ fontFamily: HZ_BODY, fontSize: 10.5, color: HZ.textMuted, fontWeight: 700,
              textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
              {SIDE_LABEL[side]} — {candidates[side].length} candidates
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {candidates[side].map(c => (
                <button key={c.agentCustomerId} type="button"
                  data-testid={`shipment-parties-line-agent-candidate-${side}-${c.agentCustomerId}`}
                  onClick={() => setSelected(s => ({ ...s, [side]: c.agentCustomerId }))}
                  style={{ textAlign: "left", padding: "10px 14px", borderRadius: 8, cursor: "pointer",
                    border: `1px solid ${selected[side] === c.agentCustomerId ? HZ.cyan : HZ.border}`,
                    background: selected[side] === c.agentCustomerId ? HZ.cyanBg : HZ.bg }}>
                  <div style={{ fontFamily: HZ_BODY, fontSize: 14, fontWeight: 700, color: HZ.text }}>{c.agentCustomerName}</div>
                  <div style={{ fontFamily: HZ_MONO, fontSize: 11, color: HZ.textMuted, marginTop: 2 }}>via linked port {c.matchedVia}</div>
                </button>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
              <Btn size="sm" variant="primary" disabled={!selected[side]}
                data-testid={`shipment-parties-line-agent-candidate-${side}-assign-btn`}
                onClick={() => onResolve(side, selected[side], candidates[side].find(c => c.agentCustomerId === selected[side])?.agentCustomerName)}>
                Assign
              </Btn>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", paddingTop: 12, borderTop: `1px solid ${HZ.border}` }}>
          <Btn variant="ghost" onClick={onDismiss} data-testid="shipment-parties-line-agent-candidates-close-btn">Close</Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Additional Parties Panel (Epic TKT-5XFCAP, Story TKT-J7BLP6) ─────────────
// Generic, extensible party-role assignment sitting alongside the 4 fixed
// shipper/consignee/notify/principal cards on PartiesOfficesPanel — a variable-
// length list (add/remove independently), so it follows ContainerEventsPanel's
// idiom (dashed add-affordance revealing an inline form) rather than either of
// that panel's own two sub-patterns (a fixed-set modal, a bare inline select).

// `parties` (null while loading) and `onChanged` (re-fetches it) come from the parent
// ShipmentPartiesPage, shared with the sibling PartiesOfficesPanel — this panel used to run its
// own independent shipmentParties.list fetch, a real duplicate request every time this tab loaded
// (2026-09-25 audit finding).
const AdditionalPartiesPanel = ({ shipmentId, parties, onChanged }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [adding,       setAdding]       = useState(false);
  const [newRole,      setNewRole]      = useState("");
  const [newCustomer,  setNewCustomer]  = useState({ id: "", name: "" });
  const [editingId,    setEditingId]    = useState(null);
  const [editCustomer, setEditCustomer] = useState({ id: "", name: "" });
  const [saving,       setSaving]       = useState(false);
  const [lineAgentCandidates, setLineAgentCandidates] = useState(null);
  const [candidatesDismissed, setCandidatesDismissed] = useState(false);

  // Independent re-detection, same as AdditionalPartiesPanel's own party list above and the
  // header's own badge — no shared state between the two, matching the Pending Revalidation
  // precedent (ShipmentHeaderBar.jsx / ShipmentSchedulesPage.jsx).
  useEffect(() => {
    let live = true;
    api.shipments.lineAgentCandidates(shipmentId)
      .then(r => { if (live) setLineAgentCandidates((r?.export?.length || r?.import?.length) ? r : null); })
      .catch(() => { if (live) setLineAgentCandidates(null); });
    return () => { live = false; };
  }, [shipmentId]);

  const handleResolveLineAgent = async (side, agentCustomerId, agentCustomerName) => {
    try {
      await api.shipmentParties.create(shipmentId, { role: SIDE_LABEL[side], customerId: agentCustomerId, customerName: agentCustomerName });
      setLineAgentCandidates(prev => {
        if (!prev) return prev;
        const next = { ...prev };
        delete next[side];
        return Object.keys(next).length ? next : null;
      });
      await onChanged();
    } catch (e) { toast.error(e.message); }
  };

  const assignedRoles  = new Set((parties || []).map(p => p.role));
  const availableRoles = ADDITIONAL_PARTY_ROLES.filter(r => !assignedRoles.has(r));
  const sorted = [...(parties || [])].sort(
    (a, b) => ADDITIONAL_PARTY_ROLES.indexOf(a.role) - ADDITIONAL_PARTY_ROLES.indexOf(b.role)
  );

  const handleAdd = async () => {
    if (!newRole || !newCustomer.id) return;
    setSaving(true);
    try {
      await api.shipmentParties.create(shipmentId, { role: newRole, customerId: newCustomer.id, customerName: newCustomer.name });
      setAdding(false); setNewRole(""); setNewCustomer({ id: "", name: "" });
      await onChanged();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const handleReassign = async id => {
    if (!editCustomer.id) return;
    setSaving(true);
    try {
      await api.shipmentParties.update(shipmentId, id, { customerId: editCustomer.id, customerName: editCustomer.name });
      setEditingId(null);
      await onChanged();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const handleRemove = async id => {
    try {
      await api.shipmentParties.remove(shipmentId, id);
      await onChanged();
    } catch (e) { toast.error(e.message); }
  };

  useHorizonFonts();

  if (parties === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: HZ.textMuted,
        fontFamily: HZ_BODY, fontSize: 13, padding: "20px 0" }}>
        <Spinner size="sm" /> Loading additional parties…
      </div>
    );
  }

  return (
    <div id="shpparties-additional-panel" data-testid="shipment-parties-additional-panel">
      <div style={{ fontFamily: HZ_BODY, fontSize: 10.5, color: HZ.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
        Additional Parties
      </div>

      {sorted.length === 0 && (
        <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, fontStyle: "italic", padding: "8px 0" }}>
          No additional parties assigned yet.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
        {sorted.map(p => (
          <div key={p.id} id={`shpparties-additional-${p.id}`} data-testid={`shipment-parties-additional-row-${p.id}`}
            style={{ background: HZ.bg, border: `1px solid ${HZ.border}`, borderRadius: 10, padding: "12px 16px" }}>
            {editingId === p.id ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontFamily: HZ_BODY, fontSize: 10.5, color: HZ.textMuted, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: ".08em" }}>{p.role}</div>
                <CustomerCombobox label="Customer" value={editCustomer} onChange={setEditCustomer} roleFilter={p.role} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Btn size="sm" variant="secondary" onClick={() => setEditingId(null)} data-testid={`shipment-parties-additional-${p.id}-cancel-btn`}>Cancel</Btn>
                  <Btn size="sm" disabled={saving || !editCustomer.id} onClick={() => handleReassign(p.id)} data-testid={`shipment-parties-additional-${p.id}-save-btn`}>
                    {saving ? "Saving…" : "Save"}
                  </Btn>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontFamily: HZ_BODY, fontSize: 10.5, color: HZ.textMuted, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 4 }}>{p.role}</div>
                  <div style={{ fontFamily: HZ_BODY, fontSize: 15, fontWeight: 700, color: HZ.text }}>{p.customerName}</div>
                </div>
                {canEdit && (
                  <div style={{ display: "flex", gap: 10 }}>
                    <button type="button" title="Reassign customer"
                      data-testid={`shipment-parties-additional-${p.id}-reassign-btn`}
                      onClick={() => { setEditingId(p.id); setEditCustomer({ id: p.customerId, name: p.customerName }); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: HZ.textMuted, fontSize: 13 }}
                      onMouseEnter={e => e.currentTarget.style.color = HZ.text}
                      onMouseLeave={e => e.currentTarget.style.color = HZ.textMuted}>
                      ✎
                    </button>
                    <button type="button" title="Remove" onClick={() => handleRemove(p.id)}
                      data-testid={`shipment-parties-additional-${p.id}-remove-btn`}
                      style={{ background: "none", border: "none", cursor: "pointer", color: HZ.textMuted, fontSize: 15, lineHeight: 1 }}
                      onMouseEnter={e => e.currentTarget.style.color = HZ.crit}
                      onMouseLeave={e => e.currentTarget.style.color = HZ.textMuted}>
                      ×
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {canEdit && (adding ? (
        <div id="shpparties-additional-add-form" data-testid="shipment-parties-additional-add-form" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12,
          borderRadius: 8, border: `1px dashed ${HZ.cyan}55`, background: HZ.bg }}>
          <select id="shpparties-additional-role-select" data-testid="shipment-parties-additional-role-select" value={newRole} onChange={e => setNewRole(e.target.value)}
            style={{ ...inputBase, fontFamily: HZ_BODY, fontSize: 12, cursor: "pointer" }}>
            <option value="">Select role…</option>
            {availableRoles.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <CustomerCombobox label="Customer" value={newCustomer} onChange={setNewCustomer} roleFilter={newRole} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn size="sm" variant="secondary" onClick={() => setAdding(false)} data-testid="shipment-parties-additional-add-cancel-btn">Cancel</Btn>
            <Btn id="shpparties-additional-save-btn" data-testid="shipment-parties-additional-save-btn" size="sm" disabled={saving || !newRole || !newCustomer.id} onClick={handleAdd}>
              {saving ? "Saving…" : "Add Party"}
            </Btn>
          </div>
        </div>
      ) : availableRoles.length > 0 && (
        <button id="shpparties-additional-add-btn" data-testid="shipment-parties-additional-add-btn" type="button" onClick={() => setAdding(true)}
          style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.cyan, background: "none",
            border: `1px dashed ${HZ.cyan}55`, borderRadius: 6, padding: "7px 12px", cursor: "pointer", width: "100%" }}>
          ＋ Add Party
        </button>
      ))}

      {lineAgentCandidates && !candidatesDismissed && (
        <LineAgentCandidatesModal
          candidates={lineAgentCandidates}
          onResolve={handleResolveLineAgent}
          onDismiss={() => setCandidatesDismissed(true)}
        />
      )}
    </div>
  );
};

export default AdditionalPartiesPanel;
