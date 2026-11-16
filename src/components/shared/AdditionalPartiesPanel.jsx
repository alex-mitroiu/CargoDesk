import { useState } from "react";
import { ADDITIONAL_PARTY_ROLES } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import { inputBase } from "../primitives/Form";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import CustomerCombobox from "./CustomerCombobox";
import { HZ, HZ_MONO, HZ_BODY, useHorizonFonts } from "../../pages/shipments/shipmentDetailTheme";

// The Line Agent candidates modal is gone: an office of the carrier found twice via linked ports is picked on the
// shipment's carrier office tiles (Contracts & Schedules, §8.53).

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
// `locked`: the shipment is Completed or Cancelled, so its parties can't change (TKT-SPXTGR).
const AdditionalPartiesPanel = ({ shipmentId, parties, onChanged, locked = false }) => {
  const { canEditShipments } = useAuth();
  const canEdit = canEditShipments && !locked;
  const [adding,       setAdding]       = useState(false);
  const [newRole,      setNewRole]      = useState("");
  const [newCustomer,  setNewCustomer]  = useState({ id: "", name: "" });
  const [editingId,    setEditingId]    = useState(null);
  const [editCustomer, setEditCustomer] = useState({ id: "", name: "" });
  const [saving,       setSaving]       = useState(false);

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

    </div>
  );
};

export default AdditionalPartiesPanel;
