import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Inp, Field } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import ActionMenu from "../../components/primitives/ActionMenu";

// ─── Pack Types registry ────────────────────────────────────────────────────
// Admin-maintained reference list for the container cargo manifest tree (Cargo →
// Container → Cargo Manifest): Pallet, Carton, Box, etc. Seeded with sensible
// defaults via migration; nothing else in the app enforces this list — it's just
// the source for the pack-type dropdown/icon on each manifest node.

const PackTypeForm = ({ init = {}, onSave, onCancel }) => {
  const [code,      setCode]      = useState(init.code || "");
  const [label,     setLabel]     = useState(init.label || "");
  const [icon,      setIcon]      = useState(init.icon || "📦");
  const [sortOrder, setSortOrder] = useState(init.sortOrder != null ? String(init.sortOrder) : "0");
  const [isActive,  setIsActive]  = useState(init.isActive !== false);
  const isEdit = !!init.id;

  const valid = code.trim().length > 0 && label.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
        <Inp label="Code" value={code} onChange={setCode} placeholder="PALLET" mono required />
        <Inp label="Label" value={label} onChange={setLabel} placeholder="Pallet" required />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Inp label="Icon" value={icon} onChange={setIcon} placeholder="🟫" hint="One emoji" />
        <Inp label="Sort Order" value={sortOrder} onChange={setSortOrder} type="number" placeholder="10" />
      </div>
      <Field label="Status">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: T.body, fontSize: 13, color: T.text, cursor: "pointer" }}>
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          Active — selectable when adding/editing a cargo manifest node
        </label>
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => valid && onSave({ code: code.trim(), label: label.trim(), icon: icon.trim() || "📦", sortOrder: parseInt(sortOrder, 10) || 0, isActive })} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Pack Type"}
        </Btn>
      </div>
    </div>
  );
};

const MdmPackTypesPage = () => {
  const { canManageConfigs } = useAuth();
  const [defs,    setDefs]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | definition object
  const [confirm, setConfirm] = useState(null);

  const load = () => {
    setLoading(true);
    return api.packTypes.list().then(setDefs).catch(() => setDefs([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleSave = async data => {
    try {
      if (modal === "add") {
        await api.packTypes.create(data);
        toast.success("Pack type added");
      } else {
        await api.packTypes.update(modal.id, data);
        toast.success("Pack type updated");
      }
      setModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async id => {
    try {
      await api.packTypes.remove(id);
      toast.success("Pack type removed");
      setConfirm(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Pack Types</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {defs.length} type{defs.length !== 1 ? "s" : ""} · used to classify container cargo manifest nodes (Pallet, Carton, Box, ...)
          </p>
        </div>
        {canManageConfigs && <Btn onClick={() => setModal("add")} size="lg">＋ Add Pack Type</Btn>}
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "60px 110px 1fr 100px 90px 90px", padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Icon", "Code", "Label", "Order", "Status", ""].map((h, i) => (
            <div key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>Loading…</div>
        ) : defs.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No pack types yet. Add one above — e.g. "Pallet" 🟫 for the container cargo manifest tree.
          </div>
        ) : defs.map(d => (
          <div key={d.id} id={`ptd-${d.id}-row`} style={{ display: "grid", gridTemplateColumns: "60px 110px 1fr 100px 90px 90px",
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
            <span style={{ fontSize: 18 }}>{d.icon}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{d.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{d.label}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted }}>{d.sortOrder}</span>
            <Badge variant={d.isActive ? "success" : "default"}>{d.isActive ? "Active" : "Inactive"}</Badge>
            <ActionMenu items={[
              ...(canManageConfigs ? [{ icon: "✎", label: "Edit", onClick: () => setModal(d) }] : []),
              ...(canManageConfigs ? [{ icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(d) }] : []),
            ]} />
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Pack Type" onClose={() => setModal(null)}>
          <PackTypeForm onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Pack Type" onClose={() => setModal(null)}>
          <PackTypeForm init={modal} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Delete pack type "${confirm.label}"? Cargo manifest nodes already using it keep their reference but will show no icon.`}
          onConfirm={() => handleDelete(confirm.id)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmPackTypesPage;
