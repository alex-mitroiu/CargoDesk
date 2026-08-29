import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import { Inp, Sel, Field } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import ActionMenu from "../../components/primitives/ActionMenu";
import { IconPencil, IconClose } from "../../components/primitives/Icon";

// ─── Automated Charge Codes registry (TKT-OK5H34) ──────────────────────────────
// Admin-maintained definitions that auto-inject as SELL cost lines when their trigger
// fires. Only trigger today is 'per_container_split' — fired from generateInvoices()
// (src/utils/invoiceGenerator.js) when an Invoice Entry is split per container, e.g. a
// $10/container "Containerized Invoicing" fee covering the overhead of processing
// multiple invoices instead of one consolidated one.

const CURRENCIES = ["USD", "EUR", "GBP", "CNY", "SGD", "JPY", "AED", "CHF"];
const TRIGGERS = [{ value: "per_container_split", label: "Per-container invoice split" }];
const TRIGGER_LABEL = Object.fromEntries(TRIGGERS.map(t => [t.value, t.label]));

const ChargeCodeForm = ({ init = {}, onSave, onCancel }) => {
  const [code,     setCode]     = useState(init.code || "");
  const [label,    setLabel]    = useState(init.label || "");
  const [trigger,  setTrigger]  = useState(init.trigger || TRIGGERS[0].value);
  const [amount,   setAmount]   = useState(init.amount != null ? String(init.amount) : "");
  const [currency, setCurrency] = useState(init.currency || "USD");
  const [unit,     setUnit]     = useState(init.unit || "per_container");
  const [isActive, setIsActive] = useState(init.isActive !== false);
  const isEdit = !!init.id;

  const amtNum = parseFloat(amount) || 0;
  const valid  = code.trim().length > 0 && label.trim().length > 0 && amtNum > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
        <Inp label="Code" value={code} onChange={setCode} placeholder="CIF10" mono required />
        <Inp label="Label" value={label} onChange={setLabel} placeholder="Containerized Invoicing" required />
      </div>
      <Sel label="Trigger" value={trigger} onChange={setTrigger} options={TRIGGERS} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Inp label="Amount" value={amount} onChange={setAmount} type="number" placeholder="10.00" required />
        <Sel label="Currency" value={currency} onChange={setCurrency}
          options={CURRENCIES.map(c => ({ value: c, label: c }))} />
        <Inp label="Unit" value={unit} onChange={setUnit} placeholder="per_container" mono hint="Informational" />
      </div>
      <Field label="Status">
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: T.body, fontSize: 13, color: T.text, cursor: "pointer" }}>
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          Active — automatically applied when its trigger fires
        </label>
      </Field>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => valid && onSave({ code: code.trim(), label: label.trim(), trigger, amount: amtNum, currency, unit: unit.trim() || "per_container", isActive })} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Definition"}
        </Btn>
      </div>
    </div>
  );
};

const MdmChargeCodesPage = () => {
  const { canManageConfigs } = useAuth();
  const [defs,    setDefs]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | definition object
  const [confirm, setConfirm] = useState(null);

  const load = () => {
    setLoading(true);
    return api.chargeCodes.list().then(setDefs).catch(() => setDefs([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleSave = async data => {
    try {
      if (modal === "add") {
        await api.chargeCodes.create(data);
        toast.success("Charge code definition added");
      } else {
        await api.chargeCodes.update(modal.id, data);
        toast.success("Charge code definition updated");
      }
      setModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async id => {
    try {
      await api.chargeCodes.remove(id);
      toast.success("Charge code definition removed");
      setConfirm(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Automated Charge Codes</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {defs.length} definition{defs.length !== 1 ? "s" : ""} · auto-injected as Invoice Entry lines when their trigger fires
          </p>
        </div>
        {canManageConfigs && <Btn onClick={() => setModal("add")} size="lg">＋ Add Definition</Btn>}
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "110px 1fr 220px 130px 90px 90px", padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Code", "Label", "Trigger", "Amount", "Status", ""].map((h, i) => (
            <div key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>Loading…</div>
        ) : defs.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No charge code definitions yet. Add one above — e.g. a $10/container "Containerized Invoicing" fee on the per-container split trigger.
          </div>
        ) : defs.map(d => (
          <div key={d.id} id={`ccd-${d.id}-row`} style={{ display: "grid", gridTemplateColumns: "110px 1fr 220px 130px 90px 90px",
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{d.code}</span>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{d.label}</span>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{TRIGGER_LABEL[d.trigger] || d.trigger}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{d.currency} {d.amount.toFixed(2)}</span>
            <Badge variant={d.isActive ? "success" : "default"}>{d.isActive ? "Active" : "Inactive"}</Badge>
            <ActionMenu items={[
              ...(canManageConfigs ? [{ icon: IconPencil, label: "Edit", onClick: () => setModal(d) }] : []),
              ...(canManageConfigs ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(d) }] : []),
            ]} />
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Charge Code Definition" onClose={() => setModal(null)}>
          <ChargeCodeForm onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Charge Code Definition" onClose={() => setModal(null)}>
          <ChargeCodeForm init={modal} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Delete charge code definition "${confirm.label}"? It will no longer be auto-injected — already-generated invoice lines are unaffected.`}
          onConfirm={() => handleDelete(confirm.id)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmChargeCodesPage;
