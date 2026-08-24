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

// ─── Invoice Status Override Reason Codes (Epic TKT-G11AHW) ───────────────────
// Admin-maintained registry a Trade Manager picks from when overriding an Invoice Collections
// status (Reports → Invoice Collections). Seeded with sensible defaults via migration — same
// dual precedent this codebase already uses twice (Pack Types, Duty Rate Chapters).

const ReasonCodeForm = ({ init = {}, onSave, onCancel }) => {
  const [code,     setCode]     = useState(init.code || "");
  const [label,    setLabel]    = useState(init.label || "");
  const [isActive, setIsActive] = useState(init.isActive !== false);
  const isEdit = !!init.id;

  const valid = code.trim().length > 0 && label.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Inp label="Code" value={code} onChange={setCode} placeholder="END_OF_MONTH_TERMS" mono required />
      <Inp label="Label" value={label} onChange={setLabel}
        placeholder="Customer pays on a fixed end-of-month cycle" required />
      <Field label="Status">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: T.body, fontSize: 13, color: T.text, cursor: "pointer" }}>
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          Active — selectable when a Trade Manager overrides an invoice's collections status
        </label>
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => valid && onSave({ code: code.trim(), label: label.trim(), isActive })} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Reason Code"}
        </Btn>
      </div>
    </div>
  );
};

const MdmInvoiceReasonCodesPage = () => {
  const { canManageConfigs } = useAuth();
  const [defs,    setDefs]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | definition object
  const [confirm, setConfirm] = useState(null);

  const load = () => {
    setLoading(true);
    return api.invoiceReasonCodes.list().then(setDefs).catch(() => setDefs([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleSave = async data => {
    try {
      if (modal === "add") {
        await api.invoiceReasonCodes.create(data);
        toast.success("Reason code added");
      } else {
        await api.invoiceReasonCodes.update(modal.id, data);
        toast.success("Reason code updated");
      }
      setModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async id => {
    try {
      await api.invoiceReasonCodes.remove(id);
      toast.success("Reason code removed");
      setConfirm(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Invoice Reason Codes</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {defs.length} code{defs.length !== 1 ? "s" : ""} · used by Trade Managers to explain an Invoice Collections status override (Reports → Invoice Collections)
          </p>
        </div>
        {canManageConfigs && <Btn onClick={() => setModal("add")} size="lg">＋ Add Reason Code</Btn>}
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr 100px 90px", padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Code", "Label", "Status", ""].map((h, i) => (
            <div key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>Loading…</div>
        ) : defs.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No reason codes yet. Add one above.
          </div>
        ) : defs.map(d => (
          <div key={d.id} id={`irc-${d.id}-row`} style={{ display: "grid", gridTemplateColumns: "220px 1fr 100px 90px",
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{d.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{d.label}</span>
            <Badge variant={d.isActive ? "success" : "default"}>{d.isActive ? "Active" : "Inactive"}</Badge>
            <ActionMenu items={[
              ...(canManageConfigs ? [{ icon: "✎", label: "Edit", onClick: () => setModal(d) }] : []),
              ...(canManageConfigs ? [{ icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(d) }] : []),
            ]} />
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Reason Code" onClose={() => setModal(null)}>
          <ReasonCodeForm onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Reason Code" onClose={() => setModal(null)}>
          <ReasonCodeForm init={modal} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Delete reason code "${confirm.label}"? Overrides already using it keep their record but the code will no longer be selectable.`}
          onConfirm={() => handleDelete(confirm.id)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmInvoiceReasonCodesPage;
