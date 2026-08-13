import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Inp, Field, Textarea } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import ActionMenu from "../../components/primitives/ActionMenu";

// ─── Container Types registry (Equipment) ────────────────────────────────────
// Admin-maintained reference list of equipment (20ft Dry, 40ft High Cube, ...) — same
// role pack_type_definitions plays for cargo manifest pack types. Seeded from the app's
// long-standing hardcoded CONTAINER_OPTIONS list (src/tokens.js); purely additive
// reference data for now — no existing container-type dropdown reads from it yet.

const ContainerTypeForm = ({ init = {}, onSave, onCancel }) => {
  const [code,        setCode]        = useState(init.code || "");
  const [size,        setSize]        = useState(init.size || "");
  const [type,        setType]        = useState(init.type || "");
  const [teu,         setTeu]         = useState(init.teu != null ? String(init.teu) : "1");
  const [label,       setLabel]       = useState(init.label || "");
  const [description, setDescription] = useState(init.description || "");
  const [sortOrder,   setSortOrder]   = useState(init.sortOrder != null ? String(init.sortOrder) : "0");
  const [isActive,    setIsActive]    = useState(init.isActive !== false);
  const isEdit = !!init.id;

  const valid = code.trim().length > 0 && size.trim().length > 0 && type.trim().length > 0 && label.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
        <Inp label="Code" value={code} onChange={setCode} placeholder="20DC" mono required />
        <Inp label="Size" value={size} onChange={setSize} placeholder="20" mono required />
        <Inp label="Type" value={type} onChange={setType} placeholder="DC" mono required />
        <Inp label="TEU" value={teu} onChange={setTeu} type="number" placeholder="1" />
      </div>
      <Inp label="Label" value={label} onChange={setLabel} placeholder="20ft Dry Container" required />
      <Textarea label="Description" value={description} onChange={setDescription} rows={2} placeholder="Standard dry cargo — general goods, non-temperature-sensitive" />
      <Inp label="Sort Order" value={sortOrder} onChange={setSortOrder} type="number" placeholder="10" />
      <Field label="Status">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: T.body, fontSize: 13, color: T.text, cursor: "pointer" }}>
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          Active — selectable when adding/editing container equipment
        </label>
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => valid && onSave({
          code: code.trim(), size: size.trim(), type: type.trim(), teu: parseInt(teu, 10) || 1,
          label: label.trim(), description: description.trim(), sortOrder: parseInt(sortOrder, 10) || 0, isActive,
        })} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Container Type"}
        </Btn>
      </div>
    </div>
  );
};

const MdmContainerTypesPage = () => {
  const { canManageConfigs } = useAuth();
  const [defs,    setDefs]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | definition object
  const [confirm, setConfirm] = useState(null);

  const load = () => {
    setLoading(true);
    return api.containerTypes.list().then(setDefs).catch(() => setDefs([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleSave = async data => {
    try {
      if (modal === "add") {
        await api.containerTypes.create(data);
        toast.success("Container type added");
      } else {
        await api.containerTypes.update(modal.id, data);
        toast.success("Container type updated");
      }
      setModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async id => {
    try {
      await api.containerTypes.remove(id);
      toast.success("Container type removed");
      setConfirm(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Container Types</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {defs.length} type{defs.length !== 1 ? "s" : ""} · equipment registry — 20ft Dry, 40ft High Cube, Reefer, Flat Rack, Tank, ...
          </p>
        </div>
        {canManageConfigs && <Btn onClick={() => setModal("add")} size="lg">＋ Add Container Type</Btn>}
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "90px 60px 60px 1fr 60px 90px 90px", padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Code", "Size", "Type", "Label", "TEU", "Order", "Status"].map((h, i) => (
            <div key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</div>
          ))}
          <div />
        </div>

        {loading ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>Loading…</div>
        ) : defs.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No container types yet. Add one above — e.g. "20DC" 20ft Dry Container.
          </div>
        ) : defs.map(d => (
          <div key={d.id} id={`ctd-${d.id}-row`} style={{ display: "grid", gridTemplateColumns: "90px 60px 60px 1fr 60px 90px 90px 40px",
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{d.code}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{d.size}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{d.type}</span>
            <div>
              <div style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{d.label}</div>
              {d.description && <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginTop: 2 }}>{d.description}</div>}
            </div>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted }}>{d.teu}</span>
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
        <Modal title="Add Container Type" onClose={() => setModal(null)}>
          <ContainerTypeForm onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Container Type" onClose={() => setModal(null)}>
          <ContainerTypeForm init={modal} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Delete container type "${confirm.label}"? This only removes it from the Equipment registry.`}
          onConfirm={() => handleDelete(confirm.id)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmContainerTypesPage;
