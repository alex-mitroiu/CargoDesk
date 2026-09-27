import { useState, useEffect } from "react";
import { T, todayIso, addDays } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import Spinner from "../components/primitives/Spinner";
import { Modal } from "../components/primitives/Modal";
import { Inp } from "../components/primitives/Form";
import DatePicker from "../components/primitives/DatePicker";
import CustomerCombobox from "../components/shared/CustomerCombobox";
import { buildStatementHtml } from "../utils/invoiceGenerator";

// Consolidated/Statement Billing — Financials -> Statements. One billing document spanning
// several shipments for the same customer, alongside (never replacing) the existing per-shipment
// Invoice Entry flow on each Shipment's own Accounting tab. Manual, on-demand only — see
// routes/customer-statements.js's own comment for the full scope (a scheduled/recurring version
// is a clearly separate follow-on, not built here).

const fmtCurr = (n, c = "USD") => `${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}`;

const STATUS_VARIANT = { draft: "default", confirmed: "info", voided: "danger" };

const GenerateStatementModal = ({ onClose, onGenerated }) => {
  const [customer, setCustomer] = useState({ id: "", name: "" });
  const [dateFrom, setDateFrom] = useState(() => addDays(todayIso(), -30));
  const [dateTo,   setDateTo]   = useState(() => todayIso());
  const [eligible, setEligible] = useState(null); // null = not loaded yet
  const [selected, setSelected] = useState(new Set());
  const [loading,  setLoading]  = useState(false);
  const [busy,     setBusy]     = useState(false);

  const loadEligible = async () => {
    if (!customer.id || !dateFrom || !dateTo) return;
    setLoading(true);
    try {
      const rows = await api.customerStatements.eligibleLines(customer.id, dateFrom, dateTo);
      setEligible(rows);
      setSelected(new Set(rows.map(r => r.id)));
    } catch (e) { toast.error(e.message); setEligible([]); }
    setLoading(false);
  };

  const toggle = id => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const chosen = (eligible || []).filter(r => selected.has(r.id));
  const total = chosen.reduce((s, r) => s + r.amount, 0);
  const currency = chosen[0]?.currency;
  const mixedCurrency = chosen.length > 0 && chosen.some(r => r.currency !== currency);

  const generate = async () => {
    setBusy(true);
    try {
      const now = new Date();
      const invDate = now.toISOString().slice(0, 10);
      const invNumber = `STMT-${customer.id}-${now.getTime().toString(36).toUpperCase().slice(-6)}`;
      const html = buildStatementHtml({
        customerName: customer.name, dateFrom, dateTo, invNumber, invDate, currency, lines: chosen,
      });
      const statement = await api.customerStatements.generate({
        customerId: customer.id, dateFrom, dateTo, costLineIds: [...selected],
        html, filename: `${invNumber}-${invDate}.pdf`,
      });
      toast.success("Statement generated as a draft");
      onGenerated(statement);
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  return (
    <Modal title="New Statement" onClose={() => !busy && onClose()} width={640}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <CustomerCombobox label="Customer" value={customer} onChange={c => { setCustomer(c); setEligible(null); }} required />
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}><DatePicker label="From" value={dateFrom} onChange={v => { setDateFrom(v); setEligible(null); }} maxDate={dateTo} /></div>
          <div style={{ flex: 1 }}><DatePicker label="To" value={dateTo} onChange={v => { setDateTo(v); setEligible(null); }} minDate={dateFrom} /></div>
        </div>
        <Btn variant="secondary" onClick={loadEligible} disabled={!customer.id || loading}>
          {loading ? "Loading…" : "Load Eligible Charges"}
        </Btn>

        {eligible !== null && (
          eligible.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic",
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8 }}>
              No unbilled SELL charges for this customer in this range — either nothing's been entered yet, or
              it's already on a per-shipment invoice or another statement.
            </div>
          ) : (
            <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", maxHeight: 280, overflowY: "auto" }}>
              {eligible.map(r => (
                <label key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
                  borderBottom: `1px solid ${T.border}22`, cursor: "pointer", background: selected.has(r.id) ? `${T.accent}0c` : "transparent" }}>
                  <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  <span style={{ flex: 1, fontFamily: T.mono, fontSize: 11.5, color: T.textMuted }}>{r.shipmentId}</span>
                  <span style={{ flex: 1.4, fontFamily: T.body, fontSize: 12.5, color: T.text }}>{r.chargeCode}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text, fontWeight: 600 }}>{fmtCurr(r.amount, r.currency)}</span>
                </label>
              ))}
            </div>
          )
        )}

        {mixedCurrency && (
          <div style={{ padding: "8px 12px", borderRadius: 6, background: `${T.danger}18`, border: `1px solid ${T.danger}44`,
            fontFamily: T.body, fontSize: 11.5, color: T.text }}>
            Selected charges span more than one currency — deselect down to a single currency before generating.
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 8, borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            {chosen.length} charge{chosen.length !== 1 ? "s" : ""} selected
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: T.text }}>
            {currency ? fmtCurr(total, currency) : "—"}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={generate} disabled={busy || chosen.length === 0 || mixedCurrency}>
            {busy ? "Generating…" : "Generate Statement"}
          </Btn>
        </div>
      </div>
    </Modal>
  );
};

const StatementDetailModal = ({ statement, onClose, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [paidAt, setPaidAt] = useState("");
  const [paidAmount, setPaidAmount] = useState(String(statement.totalAmount));

  const act = async (fn, successMsg) => {
    setBusy(true);
    try {
      const updated = await fn();
      toast.success(successMsg);
      onChanged(updated);
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  return (
    <Modal title={`Statement — ${statement.customerName}`} onClose={() => !busy && onClose()} width={620}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Badge variant={STATUS_VARIANT[statement.status] || "default"}>{statement.status}</Badge>
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
            {statement.dateFrom} → {statement.dateTo}
          </span>
        </div>

        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
          {statement.lines.map(l => (
            <div key={l.id} style={{ display: "flex", padding: "8px 12px", borderBottom: `1px solid ${T.border}22`, alignItems: "center" }}>
              <span style={{ flex: 1, fontFamily: T.mono, fontSize: 11.5, color: T.textMuted }}>{l.shipmentId}</span>
              <span style={{ flex: 1.4, fontFamily: T.body, fontSize: 12.5, color: T.text }}>{l.chargeCode}</span>
              <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text }}>{fmtCurr(l.amount, l.currency)}</span>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: T.text }}>
          Total: {fmtCurr(statement.totalAmount, statement.currency)}
        </div>

        {statement.paidAt && (
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.success }}>
            Paid {fmtCurr(statement.paidAmount, "USD")} on {new Date(statement.paidAt).toLocaleDateString()}
          </div>
        )}

        {markPaidOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 8, border: `1px dashed ${T.accent}55` }}>
            <DatePicker label="Paid On" required value={paidAt} onChange={setPaidAt} maxDate={todayIso()} />
            <Inp label="Amount Paid (USD)" required type="number" value={paidAmount} onChange={setPaidAmount} />
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Btn variant="secondary" onClick={() => api.customerStatements.download(statement.id, statement.filename)} disabled={busy}>
            ⬇ Download PDF
          </Btn>
          {statement.status === "draft" && (
            <>
              <Btn variant="secondary" onClick={() => act(() => api.customerStatements.voidStatement(statement.id), "Statement voided")} disabled={busy}>
                Void Draft
              </Btn>
              <Btn onClick={() => act(() => api.customerStatements.confirm(statement.id), "Statement confirmed")} disabled={busy}>
                Confirm
              </Btn>
            </>
          )}
          {statement.status === "confirmed" && !statement.paidAt && (
            markPaidOpen ? (
              <Btn onClick={() => act(() => api.customerStatements.markPaid(statement.id, { paidAt, paidAmount: Number(paidAmount) }), "Marked as paid")}
                disabled={busy || !paidAt || !paidAmount || Number(paidAmount) <= 0}>
                Confirm Paid
              </Btn>
            ) : (
              <Btn onClick={() => setMarkPaidOpen(true)} disabled={busy}>Mark as Paid</Btn>
            )
          )}
        </div>
      </div>
    </Modal>
  );
};

const CustomerStatementsPage = () => {
  const { canEditShipments: canEdit } = useAuth();
  const [statements, setStatements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [detail, setDetail] = useState(null);

  const load = () => {
    setLoading(true);
    return api.customerStatements.list().then(setStatements).catch(() => setStatements([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Statements</h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            Bill a customer once across several shipments, instead of one invoice per shipment
          </p>
        </div>
        {canEdit && <Btn onClick={() => setGenerateOpen(true)} size="lg">＋ New Statement</Btn>}
      </div>

      {loading ? (
        <div style={{ padding: 48, textAlign: "center" }}><Spinner /></div>
      ) : statements.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", fontFamily: T.body, fontSize: 14, color: T.textMuted,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12 }}>
          No statements yet — generate one for a customer with unbilled charges across several shipments.
        </div>
      ) : (
        <div style={{ background: T.surface, borderRadius: 12, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 100px", padding: "10px 20px", borderBottom: `1px solid ${T.border}` }}>
            {["Customer", "Period", "Total", "Status"].map(h => (
              <div key={h} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</div>
            ))}
          </div>
          {statements.map(s => (
            <div key={s.id} onClick={() => setDetail(s)} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 100px",
              padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center", cursor: "pointer" }}>
              <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{s.customerName}</span>
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textMuted }}>{s.dateFrom} → {s.dateTo}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>{fmtCurr(s.totalAmount, s.currency)}</span>
              <Badge variant={STATUS_VARIANT[s.status] || "default"}>{s.status}</Badge>
            </div>
          ))}
        </div>
      )}

      {generateOpen && (
        <GenerateStatementModal onClose={() => setGenerateOpen(false)}
          onGenerated={s => { setGenerateOpen(false); load(); setDetail(s); }} />
      )}
      {detail && (
        <StatementDetailModal statement={detail} onClose={() => { setDetail(null); load(); }}
          onChanged={updated => { setDetail(updated); load(); }} />
      )}
    </div>
  );
};

export default CustomerStatementsPage;
