import { useState, useEffect } from "react";
import { T, ADDITIONAL_PARTY_ROLES } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import { inputBase } from "../primitives/Form";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import CustomerCombobox from "./CustomerCombobox";

// ─── Additional Parties Panel (Epic TKT-5XFCAP, Story TKT-J7BLP6) ─────────────
// Generic, extensible party-role assignment sitting alongside the 4 fixed
// shipper/consignee/notify/principal cards on PartiesOfficesPanel — a variable-
// length list (add/remove independently), so it follows ContainerEventsPanel's
// idiom (dashed add-affordance revealing an inline form) rather than either of
// that panel's own two sub-patterns (a fixed-set modal, a bare inline select).

const AdditionalPartiesPanel = ({ shipmentId }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [parties,      setParties]      = useState(null); // null = loading
  const [adding,       setAdding]       = useState(false);
  const [newRole,      setNewRole]      = useState("");
  const [newCustomer,  setNewCustomer]  = useState({ id: "", name: "" });
  const [editingId,    setEditingId]    = useState(null);
  const [editCustomer, setEditCustomer] = useState({ id: "", name: "" });
  const [saving,       setSaving]       = useState(false);

  const load = () => api.shipmentParties.list(shipmentId).then(setParties).catch(() => setParties([]));
  useEffect(() => { load(); }, [shipmentId]);

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
      await load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const handleReassign = async id => {
    if (!editCustomer.id) return;
    setSaving(true);
    try {
      await api.shipmentParties.update(id, { customerId: editCustomer.id, customerName: editCustomer.name });
      setEditingId(null);
      await load();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  const handleRemove = async id => {
    try {
      await api.shipmentParties.remove(id);
      setParties(list => list.filter(p => p.id !== id));
    } catch (e) { toast.error(e.message); }
  };

  if (parties === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.textMuted,
        fontFamily: T.body, fontSize: 13, padding: "20px 0" }}>
        <Spinner size="sm" /> Loading additional parties…
      </div>
    );
  }

  return (
    <div id="shpparties-additional-panel">
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>
        Additional Parties
      </div>

      {sorted.length === 0 && (
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic", padding: "8px 0" }}>
          No additional parties assigned yet.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
        {sorted.map(p => (
          <div key={p.id} id={`shpparties-additional-${p.id}`}
            style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 16px" }}>
            {editingId === p.id ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                  textTransform: "uppercase", letterSpacing: ".08em" }}>{p.role}</div>
                <CustomerCombobox label="Customer" value={editCustomer} onChange={setEditCustomer} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <Btn size="sm" variant="secondary" onClick={() => setEditingId(null)}>Cancel</Btn>
                  <Btn size="sm" disabled={saving || !editCustomer.id} onClick={() => handleReassign(p.id)}>
                    {saving ? "Saving…" : "Save"}
                  </Btn>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
                    textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 4 }}>{p.role}</div>
                  <div style={{ fontFamily: T.body, fontSize: 15, fontWeight: 700, color: T.text }}>{p.customerName}</div>
                </div>
                {canEdit && (
                  <div style={{ display: "flex", gap: 10 }}>
                    <button type="button" title="Reassign customer"
                      onClick={() => { setEditingId(p.id); setEditCustomer({ id: p.customerId, name: p.customerName }); }}
                      style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 13 }}
                      onMouseEnter={e => e.currentTarget.style.color = T.text}
                      onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                      ✎
                    </button>
                    <button type="button" title="Remove" onClick={() => handleRemove(p.id)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 15, lineHeight: 1 }}
                      onMouseEnter={e => e.currentTarget.style.color = T.danger}
                      onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
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
        <div id="shpparties-additional-add-form" style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12,
          borderRadius: 8, border: `1px dashed ${T.accent}55`, background: T.bg }}>
          <select id="shpparties-additional-role-select" value={newRole} onChange={e => setNewRole(e.target.value)}
            style={{ ...inputBase, fontFamily: T.body, fontSize: 12, cursor: "pointer" }}>
            <option value="">Select role…</option>
            {availableRoles.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <CustomerCombobox label="Customer" value={newCustomer} onChange={setNewCustomer} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn size="sm" variant="secondary" onClick={() => setAdding(false)}>Cancel</Btn>
            <Btn id="shpparties-additional-save-btn" size="sm" disabled={saving || !newRole || !newCustomer.id} onClick={handleAdd}>
              {saving ? "Saving…" : "Add Party"}
            </Btn>
          </div>
        </div>
      ) : availableRoles.length > 0 && (
        <button id="shpparties-additional-add-btn" type="button" onClick={() => setAdding(true)}
          style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
            border: `1px dashed ${T.accent}55`, borderRadius: 6, padding: "7px 12px", cursor: "pointer", width: "100%" }}>
          ＋ Add Party
        </button>
      ))}
    </div>
  );
};

export default AdditionalPartiesPanel;
