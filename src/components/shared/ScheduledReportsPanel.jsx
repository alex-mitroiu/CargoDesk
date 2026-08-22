import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import Badge from "../primitives/Badge";
import { Inp, Sel } from "../primitives/Form";
import { Modal, ConfirmModal } from "../primitives/Modal";
import ActionMenu from "../primitives/ActionMenu";

// Scheduled / emailed reports (TKT-IXAR9G, Competitive Gap Analysis epic TKT-GTGM6R) — reporting
// was manual-trigger only before this; a schedule here is generated and emailed automatically on
// its own cadence via the real daily sweep (server.js runScheduledReportsSweep), reusing each
// office's own configured mail settings — the exact infra already built for the invoice-email
// flow. report_type is deliberately narrow this pass (shipments CSV export only); the manual
// "Send Due Reports Now" trigger on the Test Tools page exercises the identical sweep function.

const REPORT_TYPE_LABEL = { "shipments-csv": "Shipments — full CSV export" };
const FREQUENCY_LABEL = { daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

const fmtDate = s => s ? new Date(s).toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Never";

const ScheduledReportForm = ({ init = {}, offices, onSave, onCancel }) => {
  const [reportType, setReportType] = useState(init.reportType || "shipments-csv");
  const [frequency,  setFrequency]  = useState(init.frequency || "weekly");
  const [recipients, setRecipients] = useState(init.recipients || "");
  const [officeId,   setOfficeId]   = useState(init.officeId || (offices[0]?.id || ""));
  const [isActive,   setIsActive]   = useState(init.isActive !== false);
  const isEdit = !!init.id;

  const valid = recipients.trim().length > 0 && officeId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Sel label="Report" value={reportType} onChange={setReportType}
        options={Object.entries(REPORT_TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Sel label="Frequency" value={frequency} onChange={setFrequency}
          options={Object.entries(FREQUENCY_LABEL).map(([value, label]) => ({ value, label }))} />
        <Sel label="Send Via Office" value={officeId} onChange={setOfficeId}
          hint="Whose mail settings send this report"
          options={offices.map(o => ({ value: o.id, label: `${o.code} — ${o.name}` }))} />
      </div>
      <Inp label="Recipients" value={recipients} onChange={setRecipients}
        placeholder="ops@example.com, finance@example.com" hint="Comma-separated email addresses" />
      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer",
        fontFamily: T.body, fontSize: 13, color: T.text }}>
        <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
        Active
      </label>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 4 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={() => valid && onSave({ reportType, frequency, recipients: recipients.trim(), officeId, isActive })} disabled={!valid}>
          {isEdit ? "Save Changes" : "Add Schedule"}
        </Btn>
      </div>
    </div>
  );
};

const ScheduledReportsPanel = () => {
  const [reports, setReports] = useState(null); // null = loading
  const [offices, setOffices] = useState([]);
  const [modal,   setModal]   = useState(null); // null | "add" | report object
  const [confirm, setConfirm] = useState(null);

  const load = () => api.scheduledReports.list().then(setReports).catch(() => setReports([]));
  useEffect(() => {
    load();
    api.offices.list().then(setOffices).catch(() => setOffices([]));
  }, []);

  const handleSave = async data => {
    try {
      if (modal === "add") { await api.scheduledReports.create(data); toast.success("Schedule added"); }
      else { await api.scheduledReports.update(modal.id, data); toast.success("Schedule updated"); }
      setModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async id => {
    try { await api.scheduledReports.remove(id); toast.success("Schedule removed"); setConfirm(null); load(); }
    catch (e) { toast.error(e.message); }
  };

  if (reports === null) return <div style={{ padding: 40, textAlign: "center" }}><Spinner /></div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: 0, maxWidth: 62 + "ch" }}>
          Reports generate and email themselves automatically on their own cadence — a daily sweep
          checks what's due against each schedule's last run. No login/manual export needed for
          recipients once one is set up here.
        </p>
        <Btn onClick={() => setModal("add")}>＋ Add Schedule</Btn>
      </div>

      {reports.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13,
          color: T.textMuted, fontStyle: "italic", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          No scheduled reports yet.
        </div>
      ) : (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 100px 1fr 150px 150px 90px", padding: "10px 16px", borderBottom: `1px solid ${T.border}` }}>
            {["Report", "Frequency", "Recipients", "Office", "Last Run", ""].map((h, i) => (
              <div key={i} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".07em" }}>{h}</div>
            ))}
          </div>
          {reports.map(r => (
            <div key={r.id} style={{ display: "grid", gridTemplateColumns: "1fr 100px 1fr 150px 150px 90px",
              padding: "12px 16px", borderBottom: `1px solid ${T.border}22`, alignItems: "center", gap: 8 }}>
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
                {REPORT_TYPE_LABEL[r.reportType] || r.reportType}
                {!r.isActive && <Badge variant="default">Paused</Badge>}
              </div>
              <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>{FREQUENCY_LABEL[r.frequency] || r.frequency}</div>
              <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.recipients}</div>
              <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>{r.officeName || "—"}</div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{fmtDate(r.lastRunAt)}</div>
              <ActionMenu items={[
                { icon: "✎", label: "Edit", onClick: () => setModal(r) },
                { icon: "✕", label: "Delete", variant: "danger", onClick: () => setConfirm(r) },
              ]} />
            </div>
          ))}
        </div>
      )}

      {modal === "add" && (
        <Modal title="Add Scheduled Report" onClose={() => setModal(null)}>
          <ScheduledReportForm offices={offices} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal && modal !== "add" && (
        <Modal title="Edit Scheduled Report" onClose={() => setModal(null)}>
          <ScheduledReportForm init={modal} offices={offices} onSave={handleSave} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {confirm && (
        <ConfirmModal
          message={`Delete this scheduled report? Recipients (${confirm.recipients}) will stop receiving it.`}
          onConfirm={() => handleDelete(confirm.id)}
          onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
};

export default ScheduledReportsPanel;
