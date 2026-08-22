import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import { Inp } from "../../components/primitives/Form";
import { Modal, ConfirmModal } from "../../components/primitives/Modal";
import ActionMenu from "../../components/primitives/ActionMenu";

// ─── Duty Rate Chapters registry ────────────────────────────────────────────
// Admin-maintained flat-rate-by-HS-chapter table backing the Cargo page's Landed-Cost
// Estimate (TKT-U6IZCL) — an explicit ballpark tool, not a live tariff feed. A chapter not
// listed here falls back to a fixed default rate at compute time (server-side).

const DutyRateForm = ({ init = {}, onSave, onCancel }) => {
  const [hsChapter, setHsChapter] = useState(init.hsChapter || "");
  const [label,     setLabel]     = useState(init.label || "");
  const [ratePct,   setRatePct]   = useState(init.ratePct != null ? String(init.ratePct) : "");
  const isEdit = !!init.hsChapter;

  const chapterValid = isEdit || /^\d{2}$/.test(hsChapter.trim());
  const valid = chapterValid && label.trim().length > 0 && ratePct !== "" && Number(ratePct) >= 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12 }}>
        <Inp label="HS Chapter" value={hsChapter} onChange={setHsChapter} placeholder="84" mono required
          disabled={isEdit} hint="2-digit HS chapter code" />
        <Inp label="Label" value={label} onChange={setLabel} placeholder="Machinery & mechanical appliances" required />
      </div>
      <Inp label="Duty Rate (%)" value={ratePct} onChange={setRatePct} type="number" placeholder="2.5"
        hint="Illustrative flat ad valorem rate — not live tariff data" />
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => valid && onSave({ hsChapter: hsChapter.trim(), label: label.trim(), ratePct: Number(ratePct) })} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Chapter"}
        </Btn>
      </div>
    </div>
  );
};

const MdmDutyRatesPage = () => {
  const { canManageConfigs } = useAuth();
  const [defs,    setDefs]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal,   setModal]   = useState(null); // null | "add" | chapter object
  const [confirm, setConfirm] = useState(null);

  const load = () => {
    setLoading(true);
    return api.dutyRates.list().then(setDefs).catch(() => setDefs([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const handleSave = async data => {
    try {
      if (modal === "add") {
        await api.dutyRates.create(data);
        toast.success("Duty rate chapter added");
      } else {
        await api.dutyRates.update(modal.hsChapter, data);
        toast.success("Duty rate chapter updated");
      }
      setModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async chapter => {
    try {
      await api.dutyRates.remove(chapter);
      toast.success("Duty rate chapter removed");
      setConfirm(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 28 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Duty Rate Chapters</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            {defs.length} chapter{defs.length !== 1 ? "s" : ""} · illustrative flat rates backing the Cargo page's Landed-Cost Estimate — not live tariff data
          </p>
        </div>
        {canManageConfigs && <Btn onClick={() => setModal("add")} size="lg">＋ Add Chapter</Btn>}
      </div>

      <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
        <div style={{ display: "grid", gridTemplateColumns: "100px 1fr 110px 90px", padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
          {["Chapter", "Label", "Rate", ""].map((h, i) => (
            <div key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</div>
          ))}
        </div>

        {loading ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>Loading…</div>
        ) : defs.length === 0 ? (
          <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 14 }}>
            No chapters configured yet — any HS code will fall back to the default rate on the Landed-Cost Estimate.
          </div>
        ) : defs.map(d => (
          <div key={d.hsChapter} id={`drc-${d.hsChapter}-row`} style={{ display: "grid", gridTemplateColumns: "100px 1fr 110px 90px",
            padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 700 }}>{d.hsChapter}</span>
            <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{d.label}</span>
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted }}>{d.ratePct}%</span>
            <ActionMenu items={[
              ...(canManageConfigs ? [{ icon: "✎", label: "Edit", onClick: () => setModal(d) }] : []),
              ...(canManageConfigs ? [{ icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(d) }] : []),
            ]} />
          </div>
        ))}
      </div>

      {modal === "add" && (
        <Modal title="Add Duty Rate Chapter" onClose={() => setModal(null)}>
          <DutyRateForm onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Duty Rate Chapter" onClose={() => setModal(null)}>
          <DutyRateForm init={modal} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Delete chapter "${confirm.hsChapter} — ${confirm.label}"? Any Landed-Cost Estimate touching this chapter will fall back to the default rate instead.`}
          onConfirm={() => handleDelete(confirm.hsChapter)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default MdmDutyRatesPage;
