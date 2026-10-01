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
import { buildStatementHtml, resolveStatementTaxInfo } from "../utils/invoiceGenerator";

// Consolidated/Statement Billing — Financials -> Statements. One billing document spanning
// several shipments for the same customer, alongside (never replacing) the existing per-shipment
// Invoice Entry flow on each Shipment's own Accounting tab. Manual, on-demand only — see
// routes/customer-statements.js's own comment for the full scope (a scheduled/recurring version
// is a clearly separate follow-on, not built here).
//
// A statement is issued by one legal entity and carries VAT (TKT-1E55AR, approved mockup
// https://claude.ai/artifact/846XpgViNbf5JAdU9PkPHW). Every place it shows its three amounts uses
// the order Gross, VAT, Net — the user's convention for statements.

const fmtCurr = (n, c = "USD") => `${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}`;
const round2 = n => Math.round(n * 100) / 100;

const STATUS_VARIANT = { draft: "default", confirmed: "info", voided: "danger" };
const VAT_LABEL = { zero_rated: "Zero-rated", reverse_charge: "Reverse charge", exempt: "Exempt" };

const VatChip = ({ line: l }) => {
  const t = l.vatTreatment || "standard";
  if (t === "standard" && !l.vatRate) return <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>No VAT</span>;
  return (
    <span style={{ fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, color: T.info, background: T.infoBg,
      border: `1px solid ${T.info}44`, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>
      {t === "standard" ? `VAT ${l.vatRate}%` : VAT_LABEL[t] || t}
    </span>
  );
};

const th = { fontFamily: T.body, fontSize: 9.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase",
  letterSpacing: ".07em", textAlign: "left", padding: "8px 12px", borderBottom: `1px solid ${T.border}`, whiteSpace: "nowrap" };
const td = { padding: "8px 12px", borderBottom: `1px solid ${T.border}22`, fontFamily: T.body, fontSize: 12.5, color: T.text };
const tdNum = { ...td, textAlign: "right", fontFamily: T.mono, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };
const tdShip = { ...td, fontFamily: T.mono, fontSize: 11.5, color: T.textMuted, whiteSpace: "nowrap" };

// Gross, VAT, Net — biggest first.
const Totals = ({ gross, vat, net, currency }) => (
  <div style={{ display: "flex", justifyContent: "flex-end", gap: 22, flexWrap: "wrap", paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
    {[["Gross (incl. VAT)", gross, 17], ["VAT", vat, 14], ["Net", net, 14]].map(([label, value, size]) => (
      <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
        <span style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{label}</span>
        <span style={{ fontFamily: T.mono, fontSize: size, fontWeight: 700, color: T.text }}>{currency ? fmtCurr(value, currency) : "—"}</span>
      </div>
    ))}
  </div>
);

// The eligible lines grouped by legal entity ('' = a shipment with no branch on either office).
const entitiesOf = lines => {
  const m = new Map();
  for (const l of lines) {
    const id = l.entityId || "";
    if (!m.has(id)) m.set(id, { id, name: l.entityName || "No legal entity", lines: [] });
    m.get(id).lines.push(l);
  }
  return [...m.values()].sort((a, b) => b.lines.length - a.lines.length);
};

const GenerateStatementModal = ({ onClose, onGenerated }) => {
  const [customer, setCustomer] = useState({ id: "", name: "" });
  const [dateFrom, setDateFrom] = useState(() => addDays(todayIso(), -30));
  const [dateTo,   setDateTo]   = useState(() => todayIso());
  const [data,     setData]     = useState(null); // { lines, held } — null = not loaded yet
  const [entityId, setEntityId] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [loading,  setLoading]  = useState(false);
  const [busy,     setBusy]     = useState(false);

  const loadEligible = async () => {
    if (!customer.id || !dateFrom || !dateTo) return;
    setLoading(true);
    try {
      const r = await api.customerStatements.eligibleLinesWithHeld(customer.id, dateFrom, dateTo);
      setData(r);
      setEntityId(entitiesOf(r.lines)[0]?.id ?? null);
      setSelected(new Set(r.lines.map(l => l.id)));
    } catch (e) { toast.error(e.message); setData({ lines: [], held: [] }); }
    setLoading(false);
  };
  const reset = () => setData(null);

  const toggle = id => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const entities = data ? entitiesOf(data.lines) : [];
  const entity = entities.find(e => e.id === entityId) || null;
  const entityLines = entity ? entity.lines : [];
  const chosen = entityLines.filter(r => selected.has(r.id));
  const net = round2(chosen.reduce((s, r) => s + r.amount, 0));
  const vat = round2(chosen.reduce((s, r) => s + (r.vatAmount || 0), 0));
  const currency = chosen[0]?.currency;
  const mixedCurrency = chosen.length > 0 && chosen.some(r => r.currency !== currency);
  const held = data ? data.held.filter(h => (h.entityId || "") === (entityId ?? "")) : [];
  const others = entities.filter(e => e.id !== entityId);

  const generate = async () => {
    setBusy(true);
    try {
      const now = new Date();
      const invDate = now.toISOString().slice(0, 10);
      const invNumber = `STMT-${customer.id}-${now.getTime().toString(36).toUpperCase().slice(-6)}`;
      const taxInfo = await resolveStatementTaxInfo({ entityId: entity.id, entityName: entity.id ? entity.name : "", customerId: customer.id, customerName: customer.name });
      const html = buildStatementHtml({
        customerName: customer.name, entityName: entity.id ? entity.name : "", dateFrom, dateTo, invNumber, invDate, currency, lines: chosen, taxInfo,
      });
      const statement = await api.customerStatements.generate({
        customerId: customer.id, dateFrom, dateTo, costLineIds: chosen.map(l => l.id),
        html, filename: `${invNumber}-${invDate}.pdf`,
      });
      toast.success("Statement generated as a draft");
      onGenerated(statement);
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  return (
    <Modal title="New Statement" onClose={() => !busy && onClose()} width={720}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <CustomerCombobox label="Customer" value={customer} onChange={c => { setCustomer(c); reset(); }} required />
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}><DatePicker label="From" value={dateFrom} onChange={v => { setDateFrom(v); reset(); }} maxDate={dateTo} /></div>
          <div style={{ flex: 1 }}><DatePicker label="To" value={dateTo} onChange={v => { setDateTo(v); reset(); }} minDate={dateFrom} /></div>
        </div>
        <Btn variant="secondary" onClick={loadEligible} disabled={!customer.id || loading}>
          {loading ? "Loading…" : "Load Eligible Charges"}
        </Btn>

        {data !== null && (data.lines.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic",
            background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8 }}>
            No unbilled SELL charges for this customer in this range — either nothing's been entered yet, or
            it's already on a per-shipment invoice or another statement.
          </div>
        ) : (<>
          <div data-testid="statement-entities" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span id="stmt-entity-label" style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
              Issued by (legal entity) <span style={{ color: T.danger }}>*</span>
            </span>
            <div role="radiogroup" aria-labelledby="stmt-entity-label" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              {entities.map(e => {
                const on = e.id === entityId;
                const ships = new Set(e.lines.map(l => l.shipmentId)).size;
                const cur = e.lines[0]?.currency || "";
                return (
                  <label key={e.id || "none"} data-testid={`statement-entity-${e.id || "none"}`}
                    style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 10px", padding: "10px 12px", borderRadius: 9, cursor: "pointer",
                      border: `1px solid ${on ? T.accent : T.border}`, background: on ? T.accentBg : T.surface }}>
                    <input type="radio" name="stmt-entity" checked={on} onChange={() => setEntityId(e.id)}
                      style={{ gridRow: "span 2", margin: "3px 0 0", accentColor: T.accent }} />
                    <span style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.text }}>{e.name}</span>
                    <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                      {e.lines.length} charge{e.lines.length !== 1 ? "s" : ""} · {ships} shipment{ships !== 1 ? "s" : ""} · {fmtCurr(e.lines.reduce((s, l) => s + l.amount, 0), cur)} net
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
            <div style={{ overflowX: "auto", maxHeight: 300, overflowY: "auto" }}>
              <table data-testid="statement-eligible-lines" style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
                <thead><tr>
                  <th style={{ ...th, width: 34 }} /><th style={th}>Shipment</th><th style={th}>Charge</th><th style={th}>VAT</th>
                  <th style={{ ...th, textAlign: "right" }}>Gross</th><th style={{ ...th, textAlign: "right" }}>VAT</th><th style={{ ...th, textAlign: "right" }}>Net</th>
                </tr></thead>
                <tbody>{entityLines.map(r => {
                  const on = selected.has(r.id);
                  return (
                    <tr key={r.id} style={{ background: on ? T.accentBg : "transparent" }}>
                      <td style={td}><input type="checkbox" checked={on} onChange={() => toggle(r.id)} aria-label={`${r.chargeCode} on ${r.shipmentId}`} style={{ accentColor: T.accent }} /></td>
                      <td style={tdShip}>{r.shipmentId}</td>
                      <td style={td}>{r.chargeCode}</td>
                      <td style={td}><VatChip line={r} /></td>
                      <td style={tdNum}>{fmtCurr(r.amount + (r.vatAmount || 0), r.currency)}</td>
                      <td style={tdNum}>{r.vatAmount ? fmtCurr(r.vatAmount, r.currency) : "—"}</td>
                      <td style={tdNum}>{fmtCurr(r.amount, r.currency)}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
            {held.length > 0 && (
              <div data-testid="statement-held" style={{ padding: "8px 12px", fontFamily: T.body, fontSize: 12, color: T.textMuted, background: T.bg, borderTop: `1px solid ${T.border}` }}>
                {held.length} charge{held.length !== 1 ? "s are" : " is"} already billed — not offered
                ({held.map(h => `${h.chargeCode} on ${h.billedOn?.kind === "statement" ? h.billedOn.id : (h.billedOn?.label || h.billedOn?.docType)}`).join(", ")})
              </div>
            )}
          </div>

          {others.length > 0 && (
            <div style={{ padding: "8px 12px", borderRadius: 6, background: T.infoBg, border: `1px solid ${T.info}44`, fontFamily: T.body, fontSize: 12, color: T.text }}>
              {others.map(e => `${e.name}'s ${e.lines.length} charge${e.lines.length !== 1 ? "s" : ""}`).join(" and ")} for this customer go on a separate statement — a statement is issued by one legal entity.
            </div>
          )}
          {mixedCurrency && (
            <div style={{ padding: "8px 12px", borderRadius: 6, background: `${T.danger}18`, border: `1px solid ${T.danger}44`,
              fontFamily: T.body, fontSize: 11.5, color: T.text }}>
              Selected charges span more than one currency — deselect down to a single currency before generating.
            </div>
          )}
          <Totals gross={round2(net + vat)} vat={vat} net={net} currency={mixedCurrency ? null : currency} />
        </>))}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 4 }}>
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            {chosen.length} charge{chosen.length !== 1 ? "s" : ""} selected
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
            <Btn onClick={generate} disabled={busy || chosen.length === 0 || mixedCurrency}>
              {busy ? "Generating…" : "Generate Statement"}
            </Btn>
          </div>
        </div>
      </div>
    </Modal>
  );
};

const StatementDetailModal = ({ statement, onClose, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const [markPaidOpen, setMarkPaidOpen] = useState(false);
  const [paidAt, setPaidAt] = useState("");
  const isUsd = statement.currency === "USD";
  const [paidAmount, setPaidAmount] = useState(isUsd ? String(statement.grossAmount) : "");
  // What was actually received in the statement's own currency — the same optional block an
  // invoice's Mark as Paid offers (TKT-02776W, FX Revaluation's realized gain/loss). Filling both
  // fields locks Amount Paid (USD) to their product.
  const [showFx, setShowFx] = useState(false);
  const [paidAmountOriginal, setPaidAmountOriginal] = useState("");
  const [paidExchangeRate, setPaidExchangeRate] = useState("");
  const fxOriginalNum = Number(paidAmountOriginal), fxRateNum = Number(paidExchangeRate);
  const fxValid = showFx && paidAmountOriginal !== "" && paidExchangeRate !== ""
    && !Number.isNaN(fxOriginalNum) && fxOriginalNum > 0 && !Number.isNaN(fxRateNum) && fxRateNum > 0;
  useEffect(() => {
    if (fxValid) setPaidAmount(String(round2(fxOriginalNum * fxRateNum)));
  }, [showFx, paidAmountOriginal, paidExchangeRate]); // eslint-disable-line react-hooks/exhaustive-deps
  const amountNum = Number(paidAmount);
  const paidValid = !!paidAt && paidAmount !== "" && !Number.isNaN(amountNum) && amountNum > 0 && (!showFx || fxValid);

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
    <Modal title={`Statement — ${statement.customerName}`} onClose={() => !busy && onClose()} width={720}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Badge variant={STATUS_VARIANT[statement.status] || "default"}>{statement.status}</Badge>
            {statement.entityName && <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>Issued by {statement.entityName}</span>}
          </span>
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
            {statement.dateFrom} → {statement.dateTo}
          </span>
        </div>

        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflowX: "auto" }}>
          <table data-testid="statement-detail-lines" style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
            <thead><tr>
              <th style={th}>Shipment</th><th style={th}>Charge</th><th style={th}>VAT</th>
              <th style={{ ...th, textAlign: "right" }}>Gross</th><th style={{ ...th, textAlign: "right" }}>VAT</th><th style={{ ...th, textAlign: "right" }}>Net</th>
            </tr></thead>
            <tbody>{statement.lines.map(l => (
              <tr key={l.id}>
                <td style={tdShip}>{l.shipmentId}</td>
                <td style={td}>{l.chargeCode}</td>
                <td style={td}><VatChip line={l} /></td>
                <td style={tdNum}>{fmtCurr(l.grossAmount ?? l.amount, l.currency)}</td>
                <td style={tdNum}>{l.vatAmount ? fmtCurr(l.vatAmount, l.currency) : "—"}</td>
                <td style={tdNum}>{fmtCurr(l.amount, l.currency)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>

        <Totals gross={statement.grossAmount} vat={statement.vatAmount || 0} net={statement.totalAmount} currency={statement.currency} />

        {statement.paidAt && (
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.success }}>
            Paid {fmtCurr(statement.paidAmount, "USD")} on {new Date(statement.paidAt).toLocaleDateString()}
            {statement.paidAmountOriginal != null && ` — received ${fmtCurr(statement.paidAmountOriginal, statement.paidCurrency)} at ${statement.paidExchangeRate}`}
          </div>
        )}

        {markPaidOpen && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 8, border: `1px dashed ${T.accent}55` }}>
            <DatePicker label="Paid On" required value={paidAt} onChange={setPaidAt} maxDate={todayIso()} />
            <Inp label="Amount Paid (USD)" required type="number" value={paidAmount} onChange={setPaidAmount} disabled={fxValid}
              hint={fxValid ? `Computed from the ${statement.currency} amount and rate below` : "A partial payment is fine — the remainder stays outstanding"} />
            {!isUsd && (!showFx ? (
              <button type="button" onClick={() => { setShowFx(true); setPaidAmountOriginal(String(statement.grossAmount)); }}
                style={{ alignSelf: "flex-start", background: "none", border: "none", padding: 0,
                  fontFamily: T.body, fontSize: 12, color: T.info, cursor: "pointer", textDecoration: "underline" }}>
                + Record what was actually received in {statement.currency} (for FX gain/loss tracking)
              </button>
            ) : (
              <div data-testid="statement-paid-fx" style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: 8,
                border: `1px dashed ${T.info}55`, background: T.bg }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>
                    Actually Received (optional)
                  </span>
                  <button type="button" onClick={() => { setShowFx(false); setPaidAmountOriginal(""); setPaidExchangeRate(""); }}
                    style={{ background: "none", border: "none", padding: 0, fontFamily: T.body, fontSize: 11, color: T.textMuted, cursor: "pointer" }}>
                    Remove
                  </button>
                </div>
                <Inp label={`Amount Received (${statement.currency})`} type="number" value={paidAmountOriginal} onChange={setPaidAmountOriginal} />
                <Inp label={`Exchange Rate (USD per ${statement.currency})`} type="number" value={paidExchangeRate} onChange={setPaidExchangeRate} />
              </div>
            ))}
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
              <Btn onClick={() => act(() => api.customerStatements.markPaid(statement.id, {
                  paidAt, paidAmount: amountNum,
                  ...(fxValid ? { paidAmountOriginal: fxOriginalNum, paidCurrency: statement.currency, paidExchangeRate: fxRateNum } : {}),
                }), "Marked as paid")}
                disabled={busy || !paidValid}>
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

  // The list row carries no lines — open the full statement for the detail.
  const openDetail = s => api.customerStatements.get(s.id).then(setDetail).catch(e => toast.error(e.message));

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
            {["Customer", "Period", "Total (incl. VAT)", "Status"].map(h => (
              <div key={h} style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>{h}</div>
            ))}
          </div>
          {statements.map(s => (
            <div key={s.id} onClick={() => openDetail(s)} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 100px",
              padding: "14px 20px", borderBottom: `1px solid ${T.border}22`, alignItems: "center", cursor: "pointer" }}>
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontFamily: T.body, fontSize: 14, color: T.text }}>{s.customerName}</span>
                {s.entityName && <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>{s.entityName}</span>}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.textMuted }}>{s.dateFrom} → {s.dateTo}</span>
              <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>{fmtCurr(s.grossAmount ?? s.totalAmount, s.currency)}</span>
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
