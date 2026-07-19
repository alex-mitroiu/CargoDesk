import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../primitives/Btn";
import { inputBase } from "../primitives/Form";

// ─── Container Cargo Manifest — pallet/box sub-level breakdown (TKT-EMFIBR) ───
// Arbitrary-depth self-referencing packages under a container (e.g. 3 pallets of
// Product A + 2 pallets of Product B, each pallet itself built from several boxes).
// Description + quantity only — weight/HS code stay at the container level (see
// ticket's 2026-07-17 scoping decisions). Independent of containers.cargoDescription/
// grossWeightKg/volumeCbm, which remain the source of truth elsewhere in the app —
// this is a supplementary detail view, not a rollup.

const PackageForm = ({ init = {}, onSave, onCancel }) => {
  const [description, setDescription] = useState(init.description || "");
  const [quantity,    setQuantity]    = useState(init.quantity != null ? String(init.quantity) : "1");
  const [saving,      setSaving]      = useState(false);
  const qty   = parseInt(quantity, 10);
  const valid = description.trim().length > 0 && Number.isFinite(qty) && qty >= 1;

  const handleSave = async () => {
    if (!valid) return;
    setSaving(true);
    try { await onSave({ description: description.trim(), quantity: qty }); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 10,
      borderRadius: 8, border: `1px dashed ${T.accent}55`, background: T.bg }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 8 }}>
        <input value={description} onChange={e => setDescription(e.target.value)} autoFocus
          placeholder="Description (e.g. Pallet — Product A)" style={{ ...inputBase, fontFamily: T.body, fontSize: 12.5 }} />
        <input type="number" min="1" value={quantity} onChange={e => setQuantity(e.target.value)}
          placeholder="Qty" style={{ ...inputBase, fontFamily: T.mono, fontSize: 12.5 }} />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Btn size="sm" variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn size="sm" disabled={!valid || saving} onClick={handleSave}>{saving ? "Saving…" : "Save"}</Btn>
      </div>
    </div>
  );
};

const PackageNode = ({ pkg, allPackages, depth, canEdit, onAddChild, onEdit, onDelete, addingUnder, editingId, onSetAdding, onSetEditing }) => {
  const children = allPackages.filter(p => p.parentId === pkg.id);
  const isEditing = editingId === pkg.id;
  const isAddingHere = addingUnder === pkg.id;

  return (
    <div style={{ marginLeft: depth > 0 ? 22 : 0 }}>
      {isEditing ? (
        <PackageForm init={pkg}
          onSave={data => onEdit(pkg.id, data)}
          onCancel={() => onSetEditing(null)} />
      ) : (
        <div id={`pkg-${pkg.id}-row`} style={{ display: "flex", alignItems: "center", gap: 10,
          padding: "7px 10px", borderRadius: 7, background: T.bg, border: `1px solid ${T.border}`, marginBottom: 6 }}>
          <span style={{ fontSize: 13, flexShrink: 0 }}>📦</span>
          <span style={{ flex: 1, fontFamily: T.body, fontSize: 12.5, color: T.text }}>{pkg.description}</span>
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent, fontWeight: 700, flexShrink: 0 }}>× {pkg.quantity}</span>
          {canEdit && (
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              <button type="button" onClick={() => onSetAdding(pkg.id)} title="Add sub-package"
                style={{ background: "none", border: "none", cursor: "pointer", color: T.accent, fontSize: 13, padding: "0 3px" }}>＋</button>
              <button type="button" onClick={() => onSetEditing(pkg.id)} title="Edit"
                style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 12, padding: "0 3px" }}>✎</button>
              <button type="button" onClick={() => onDelete(pkg.id)} title="Delete"
                style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 13, padding: "0 3px" }}
                onMouseEnter={e => e.currentTarget.style.color = T.danger}
                onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>×</button>
            </div>
          )}
        </div>
      )}

      {isAddingHere && (
        <div style={{ marginLeft: 22, marginBottom: 6 }}>
          <PackageForm onSave={data => onAddChild(pkg.id, data)} onCancel={() => onSetAdding(null)} />
        </div>
      )}

      {children.map(child => (
        <PackageNode key={child.id} pkg={child} allPackages={allPackages} depth={depth + 1}
          canEdit={canEdit} onAddChild={onAddChild} onEdit={onEdit} onDelete={onDelete}
          addingUnder={addingUnder} editingId={editingId} onSetAdding={onSetAdding} onSetEditing={onSetEditing} />
      ))}
    </div>
  );
};

const ContainerPackagesPanel = ({ containerId, containerNumber }) => {
  const { canEdit } = useAuth();
  const [packages,    setPackages]    = useState(null); // null = loading
  const [addingUnder, setAddingUnder] = useState(null); // null | "root" | parentId
  const [editingId,   setEditingId]   = useState(null);

  const load = () => api.containerPackages.list(containerId).then(setPackages).catch(() => setPackages([]));
  useEffect(() => { load(); }, [containerId]);

  const roots = (packages || []).filter(p => !p.parentId);

  const handleAdd = async (parentId, data) => {
    try {
      await api.containerPackages.create(containerId, { ...data, parentId: parentId === "root" ? null : parentId });
      setAddingUnder(null);
      await load();
    } catch (e) { toast.error(e.message); }
  };

  const handleEdit = async (id, data) => {
    try {
      await api.containerPackages.update(id, data);
      setEditingId(null);
      await load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async id => {
    try {
      await api.containerPackages.remove(id);
      await load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
        {containerNumber || containerId} · supplementary manifest detail — weight/HS code stay on the container itself
      </div>

      {packages === null ? (
        <div style={{ padding: "24px 0", textAlign: "center", fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
          Loading packages…
        </div>
      ) : roots.length === 0 ? (
        <div style={{ padding: "20px 0", textAlign: "center", fontFamily: T.body, fontSize: 12,
          color: T.textMuted, fontStyle: "italic" }}>
          No packing breakdown recorded yet — this container's manifest is just the single cargo description above.
        </div>
      ) : (
        <div>
          {roots.map(pkg => (
            <PackageNode key={pkg.id} pkg={pkg} allPackages={packages} depth={0}
              canEdit={canEdit} onAddChild={handleAdd} onEdit={handleEdit} onDelete={handleDelete}
              addingUnder={addingUnder} editingId={editingId} onSetAdding={setAddingUnder} onSetEditing={setEditingId} />
          ))}
        </div>
      )}

      {canEdit && (addingUnder === "root" ? (
        <PackageForm onSave={data => handleAdd("root", data)} onCancel={() => setAddingUnder(null)} />
      ) : (
        <button type="button" onClick={() => setAddingUnder("root")}
          style={{ fontFamily: T.body, fontSize: 12, color: T.accent, background: "none",
            border: `1px dashed ${T.accent}55`, borderRadius: 6, padding: "7px 12px",
            cursor: "pointer", width: "100%", textAlign: "center" }}>
          ＋ Add Package
        </button>
      ))}
    </div>
  );
};

export default ContainerPackagesPanel;
