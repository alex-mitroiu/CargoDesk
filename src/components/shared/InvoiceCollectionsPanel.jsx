import { useState, useEffect, useMemo } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import { Modal } from "../primitives/Modal";
import { Sel, Textarea, Field } from "../primitives/Form";

// Invoice Collections report (Epic TKT-G11AHW) — every shipment's own most recent FR01/FR02:
// who's the responsible customer (Principal), what's the status, who owns chasing it, and how
// many business days it's been sitting. Deliberately a flat scan-and-triage table, same posture
// as BillingPerformancePanel next to it — the point here is "what needs my attention right now",
// not a groupBy summary.

const STATUS_META = {
  paid:       { label: "Paid",       color: T.success },
  not_paid:   { label: "Not Paid",   color: T.warning },
  overdue:    { label: "Overdue",    color: T.danger },
  missing:    { label: "Missing",    color: T.textMuted },
  cancelled:  { label: "Cancelled",  color: T.info },
  overridden: { label: "Overridden", color: T.accent },
};
const STATUS_ORDER = ["overdue", "missing", "not_paid", "overridden", "paid", "cancelled"];

const Pill = ({ status }) => {
  const meta = STATUS_META[status] || { label: status, color: T.textMuted };
  return (
    <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase",
      padding: "3px 9px", borderRadius: 20, color: meta.color, background: `${meta.color}18`,
      border: `1px solid ${meta.color}44`, whiteSpace: "nowrap" }}>
      {meta.label}
    </span>
  );
};

const OverrideModal = ({ row, onClose, onSaved }) => {
  const [reasonCodes, setReasonCodes] = useState([]);
  const [reasonCode,  setReasonCode]  = useState("");
  const [description, setDescription] = useState("");
  const [overriddenStatus, setOverriddenStatus] = useState("not_paid");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.invoiceReasonCodes.list().then(rows => setReasonCodes(rows.filter(r => r.isActive))).catch(() => setReasonCodes([]));
  }, []);

  const save = async () => {
    if (!reasonCode) return toast.error("Pick a reason code");
    setSaving(true);
    try {
      await api.documents.statusOverride(row.shipmentId, row.docId, { reasonCode, description, overriddenStatus });
      toast.success("Status overridden");
      onSaved();
    } catch (e) { toast.error(e.message); }
    setSaving(false);
  };

  return (
    <Modal title={`Override — ${row.shipmentId}`} onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <Sel label="Displayed As" value={overriddenStatus} onChange={setOverriddenStatus}
          options={[{ value: "not_paid", label: "Not Paid" }, { value: "paid", label: "Paid" }]} />
        <Sel label="Reason Code" value={reasonCode} onChange={setReasonCode}
          options={[{ value: "", label: "— Select —" }, ...reasonCodes.map(r => ({ value: r.code, label: r.label }))]} required />
        <Textarea label="Description (optional)" value={description} onChange={setDescription}
          placeholder="e.g. Customer confirmed payment will process on their next end-of-month cycle" rows={3} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={save} disabled={saving || !reasonCode}>{saving ? "Saving…" : "Save Override"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

const InvoiceCollectionsPanel = () => {
  const { isTradeManager, isAdmin } = useAuth();
  const [rows,  setRows]  = useState(null);
  const [error, setError] = useState(false);
  const [statusFilter, setStatusFilter] = useState(new Set());
  const [overrideRow, setOverrideRow]   = useState(null);
  const [running, setRunning] = useState(false);

  const load = () => {
    setError(false);
    api.reports.invoiceCollections().then(setRows).catch(() => { setRows([]); setError(true); });
  };
  useEffect(load, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    if (!statusFilter.size) return rows;
    return rows.filter(r => statusFilter.has(r.status));
  }, [rows, statusFilter]);

  const toggleStatus = s => setStatusFilter(prev => {
    const next = new Set(prev);
    next.has(s) ? next.delete(s) : next.add(s);
    return next;
  });

  const runSweep = async () => {
    setRunning(true);
    try {
      const res = await api.reports.runCollectionsSweep();
      toast.success(`Sweep sent ${res.sentCount} alert${res.sentCount === 1 ? "" : "s"}`);
    } catch (e) { toast.error(e.message); }
    setRunning(false);
  };

  const th = { fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".07em" };

  if (rows === null) return <div style={{ padding: 40, textAlign: "center" }}><Spinner /></div>;
  if (error) return (
    <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
      Couldn't load the Invoice Collections report — finance access may not be enabled for your account.
    </div>
  );

  return (
    <div id="invoice-collections-panel">
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", marginBottom: 14,
        display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        {STATUS_ORDER.map(s => (
          <button key={s} type="button" onClick={() => toggleStatus(s)} style={{
            padding: "5px 12px", borderRadius: 20, cursor: "pointer",
            fontFamily: T.body, fontSize: 12, fontWeight: 600,
            border: `1px solid ${statusFilter.has(s) ? STATUS_META[s].color : T.border}`,
            background: statusFilter.has(s) ? `${STATUS_META[s].color}18` : "transparent",
            color: statusFilter.has(s) ? STATUS_META[s].color : T.textMuted,
          }}>{STATUS_META[s].label}</button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{filtered.length} of {rows.length} shipments</span>
        {isAdmin && (
          <Btn variant="secondary" size="sm" onClick={runSweep} disabled={running}>
            {running ? "Running…" : "Send Alerts Now"}
          </Btn>
        )}
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          No shipments match these filters.
        </div>
      ) : (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface, overflowX: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 16px", borderBottom: `1px solid ${T.border}`, background: T.bg, minWidth: 780 }}>
            <div style={{ ...th, width: 90, flexShrink: 0 }}>Shipment</div>
            <div style={{ ...th, flex: 1, minWidth: 140 }}>Principal</div>
            <div style={{ ...th, width: 110, flexShrink: 0 }}>Status</div>
            <div style={{ ...th, width: 130, flexShrink: 0 }}>User Responsible</div>
            <div style={{ ...th, width: 90, flexShrink: 0, textAlign: "right" }}>Business Days</div>
            <div style={{ ...th, width: 90, flexShrink: 0 }} />
          </div>
          {filtered.slice(0, 200).map(r => (
            <div key={r.shipmentId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px",
              borderBottom: `1px solid ${T.border}22`, minWidth: 780 }}>
              <div style={{ width: 90, flexShrink: 0, fontFamily: T.mono, fontSize: 11.5, color: T.text, fontWeight: 600 }}>{r.shipmentId}</div>
              <div style={{ flex: 1, minWidth: 140, fontFamily: T.body, fontSize: 12.5, color: r.principalName ? T.text : T.border,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.principalName || "—"}</div>
              <div style={{ width: 110, flexShrink: 0 }}><Pill status={r.status} /></div>
              <div style={{ width: 130, flexShrink: 0, fontFamily: T.body, fontSize: 11.5, color: T.textMuted,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.invoiceOwnerName || "—"}</div>
              <div style={{ width: 90, flexShrink: 0, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>
                {r.daysElapsed != null ? `${r.daysElapsed}d` : "—"}
              </div>
              <div style={{ width: 90, flexShrink: 0, textAlign: "right" }}>
                {isTradeManager && r.docId && r.status !== "cancelled" && r.status !== "paid" && (
                  <Btn variant="ghost" size="sm" onClick={() => setOverrideRow(r)}>Override</Btn>
                )}
              </div>
            </div>
          ))}
          {filtered.length > 200 && (
            <div style={{ padding: "10px 16px", textAlign: "center", fontFamily: T.body, fontSize: 11.5, color: T.textMuted, fontStyle: "italic" }}>
              Showing the first 200 of {filtered.length} matching shipments.
            </div>
          )}
        </div>
      )}

      {overrideRow && (
        <OverrideModal row={overrideRow} onClose={() => setOverrideRow(null)}
          onSaved={() => { setOverrideRow(null); load(); }} />
      )}
    </div>
  );
};

export default InvoiceCollectionsPanel;
