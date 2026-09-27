import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import { Inp, Sel, Field } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import ActionMenu from "../../components/primitives/ActionMenu";
import { IconPencil, IconClose } from "../../components/primitives/Icon";

// ─── GL Export — Charge Code -> GL Account mapping (Master Data -> Finance) ────────────
// Drives lib/gl-export.js's journal-entry export: every BUY/SELL charge code the app actually
// uses gets its own GL account, so a posted cost line or confirmed invoice knows which account to
// debit/credit. The 3 standing control accounts (AR, AP, and Unmapped/Suspense — where a charge
// code with no row below falls) live on the generic Application Settings, not a row here.

const CHARGE_CODES = ["Ocean Freight", "Origin THC", "Destination THC", "B/L Fee", "Customs", "Inland", "Haulage", "Other"];
const TYPES = [{ value: "SELL", label: "SELL (Revenue)" }, { value: "BUY", label: "BUY (Expense)" }];

const MappingForm = ({ init = {}, onSave, onCancel }) => {
  const [chargeCode, setChargeCode] = useState(init.chargeCode || CHARGE_CODES[0]);
  const [type, setType] = useState(init.type || "SELL");
  const [glAccountCode, setGlAccountCode] = useState(init.glAccountCode || "");
  const [glAccountName, setGlAccountName] = useState(init.glAccountName || "");
  const isEdit = !!init.id;
  const valid = glAccountCode.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Sel label="Charge Code" value={chargeCode} onChange={setChargeCode} disabled={isEdit}
          options={CHARGE_CODES.map(c => ({ value: c, label: c }))} />
        <Sel label="Type" value={type} onChange={setType} disabled={isEdit} options={TYPES} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
        <Inp label="GL Account Code" value={glAccountCode} onChange={setGlAccountCode} placeholder="4010" mono required />
        <Inp label="GL Account Name" value={glAccountName} onChange={setGlAccountName} placeholder="Freight Revenue" />
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => valid && onSave({ chargeCode, type, glAccountCode: glAccountCode.trim(), glAccountName: glAccountName.trim() })} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Mapping"}
        </Btn>
      </div>
    </div>
  );
};

const ControlAccountsCard = ({ canEdit }) => {
  const [ar, setAr] = useState("");
  const [ap, setAp] = useState("");
  const [unmapped, setUnmapped] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.settings.get().then(s => {
      setAr(s.gl_control_account_ar || "");
      setAp(s.gl_control_account_ap || "");
      setUnmapped(s.gl_control_account_unmapped || "");
    }).finally(() => setLoaded(true));
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.settings.update({ gl_control_account_ar: ar, gl_control_account_ap: ap, gl_control_account_unmapped: unmapped });
      toast.success("Control accounts saved");
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  if (!loaded) return null;
  return (
    <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, padding: 20, marginBottom: 20 }}>
      <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>Control Accounts</div>
      <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, margin: "0 0 14px" }}>
        The 3 standing accounts every GL export uses — Accounts Receivable (the debit side of every SELL invoice),
        Accounts Payable (the credit side of every BUY cost), and Unmapped/Suspense (where a charge code with no
        mapping below falls, so nothing silently drops from an export).
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Inp label="Accounts Receivable" value={ar} onChange={setAr} placeholder="1200" mono disabled={!canEdit} />
        <Inp label="Accounts Payable" value={ap} onChange={setAp} placeholder="2100" mono disabled={!canEdit} />
        <Inp label="Unmapped / Suspense" value={unmapped} onChange={setUnmapped} placeholder="9999" mono disabled={!canEdit} />
      </div>
      {canEdit && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <Btn size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Control Accounts"}</Btn>
        </div>
      )}
    </div>
  );
};

const MdmGlAccountMappingsPage = () => {
  const { canManageConfigs } = useAuth();
  const [mappings, setMappings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | "add" | mapping object
  const [confirm, setConfirm] = useState(null);

  const load = () => {
    setLoading(true);
    return api.glAccountMappings.list().then(setMappings).catch(() => setMappings([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleSave = async data => {
    try {
      if (modal === "add") {
        await api.glAccountMappings.create(data);
        toast.success("Mapping added");
      } else {
        await api.glAccountMappings.update(modal.id, data);
        toast.success("Mapping updated");
      }
      setModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async id => {
    try {
      await api.glAccountMappings.remove(id);
      toast.success("Mapping removed");
      setConfirm(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>GL Account Mappings</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {mappings.length} mapping{mappings.length !== 1 ? "s" : ""} · which GL account each charge code posts to when exported
          </p>
        </div>
        {canManageConfigs && <Btn onClick={() => setModal("add")} size="lg">＋ Add Mapping</Btn>}
      </div>

      <ControlAccountsCard canEdit={canManageConfigs} />

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 140px 1fr 90px", padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Charge Code", "Type", "Account Code", "Account Name", "Actions"].map((h, i) => (
            <div key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>Loading…</div>
        ) : mappings.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No mappings yet — an unmapped charge code exports to the Unmapped/Suspense account above.
          </div>
        ) : mappings.map(m => (
          <div key={m.id} id={`gam-${m.id}-row`} style={{ display: "grid", gridTemplateColumns: "1fr 100px 140px 1fr 90px",
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{m.chargeCode}</span>
            <span style={{ fontFamily: T.mono, fontSize: 11.5, fontWeight: 700, color: m.type === "SELL" ? T.success : T.warning }}>{m.type}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{m.glAccountCode}</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{m.glAccountName || "—"}</span>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <ActionMenu items={[
                ...(canManageConfigs ? [{ icon: IconPencil, label: "Edit", onClick: () => setModal(m) }] : []),
                ...(canManageConfigs ? [{ icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirm(m) }] : []),
              ]} />
            </div>
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add GL Account Mapping" onClose={() => setModal(null)}>
          <MappingForm onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit GL Account Mapping" onClose={() => setModal(null)}>
          <MappingForm init={modal} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Delete the mapping for ${confirm.chargeCode} (${confirm.type})? Future exports will fall into the Unmapped/Suspense account until it's re-mapped.`}
          onConfirm={() => handleDelete(confirm.id)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmGlAccountMappingsPage;
