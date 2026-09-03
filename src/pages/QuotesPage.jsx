import { useState, useEffect, useCallback } from "react";
import { T, CURRENCIES, INCOTERMS_2020 } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import { Field, Sel } from "../components/primitives/Form";
import { inputBase } from "../components/primitives/Form";
import DatePicker from "../components/primitives/DatePicker";
import Spinner from "../components/primitives/Spinner";
import Pagination from "../components/primitives/Pagination";
import PageSizeSelect, { getStoredPageSize } from "../components/primitives/PageSizeSelect";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import CustomerCombobox from "../components/shared/CustomerCombobox";
import PortField from "../components/shared/PortField";
import { CommodityCombobox } from "../components/shared/CommodityCombobox";
import { IconReceipt, IconClose, IconEye } from "../components/primitives/Icon";
import ActionMenu from "../components/primitives/ActionMenu";

// ─── Quoting / RFQ pre-booking stage ────────────────────────────────────────
// A quote is a distinct object that precedes and converts into a shipment — Draft (freely
// editable) -> Sent (awaiting the customer) -> Accepted | Declined | Expired -> Converted
// (Accepted only). Pricing can start from a matched contract (same engine shipment cost lines
// use) as a reference, but the quote's own lines are the actual customer-facing offer — on
// conversion those become the new shipment's SELL cost lines, independent of the live contract
// rate. See routes/quotes.js.

const STATUS_VARIANT = { Draft: "default", Sent: "info", Accepted: "success", Declined: "danger", Expired: "warning", Converted: "success" };

const fmtUsd = v => v == null ? "—" : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const defaultValidUntil = () => {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
};

const MOVEMENT_TYPE_OPTIONS = [
  { value: "FCL", label: "FCL — Full Container Load" },
  { value: "LCL", label: "LCL — Less than Container Load" },
  { value: "BCO", label: "BCO — Beneficial Cargo Owner" },
];
const SERVICE_TYPE_OPTIONS = [
  { value: "Port-to-Port", label: "Port-to-Port (P2P)" },
  { value: "Door-to-Port", label: "Door-to-Port (D2P)" },
  { value: "Port-to-Door", label: "Port-to-Door (P2D)" },
  { value: "Door-to-Door", label: "Door-to-Door (D2D)" },
];

const emptyLine = () => ({ serviceCode: "", description: "", containerType: "", quantity: "1", rate: "", currency: "USD", setTemperatureC: "" });

// A quote's containerType is free text (e.g. "40RF", "20HC") — this is the same "does it look
// like a reefer" check ContainerForm makes structurally (type === "RF"), just against a plain
// string here since a quote line has no real ContainerTypeField picker.
const looksReefer = containerType => /RF/i.test(containerType || "");

// ─── Quote form modal (New + Edit-while-Draft) ──────────────────────────────
const QuoteFormModal = ({ quote, onClose, onSaved }) => {
  const isEdit = !!quote;
  const [customer, setCustomer] = useState({ id: quote?.customerId || "", name: quote?.customerName || "" });
  const [pol, setPol] = useState(quote?.pol ? { unlocode: quote.pol, name: "" } : null);
  const [pod, setPod] = useState(quote?.pod ? { unlocode: quote.pod, name: "" } : null);
  const [carrierCode, setCarrierCode] = useState(quote?.carrierCode || "");
  const [commodityCode, setCommodityCode] = useState(quote?.commodityCode || "");
  const [movementType, setMovementType] = useState(quote?.movementType || "FCL");
  const [serviceType, setServiceType] = useState(quote?.serviceType || "Port-to-Port");
  const [incoterm, setIncoterm] = useState(quote?.incoterm || "");
  const [cargoReadyDate, setCargoReadyDate] = useState(quote?.cargoReadyDate || "");
  const [validUntil, setValidUntil] = useState(quote?.validUntil || defaultValidUntil());
  const [notes, setNotes] = useState(quote?.notes || "");
  const [currency, setCurrency] = useState(quote?.currency || "USD");
  const [lines, setLines] = useState(
    quote?.lines?.length ? quote.lines.map(l => ({ ...l, rate: String(l.rate), quantity: String(l.quantity),
      setTemperatureC: l.setTemperatureC != null ? String(l.setTemperatureC) : "" })) : [emptyLine()]
  );
  const [contractId, setContractId] = useState(quote?.contractId || "");
  const [contractRef, setContractRef] = useState(quote?.contractRef || "");
  const [saving, setSaving] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matches, setMatches] = useState(null);

  const setLine = (i, patch) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  const addLine = () => setLines(prev => [...prev, emptyLine()]);
  const removeLine = i => setLines(prev => prev.filter((_, idx) => idx !== i));

  const findMatches = async () => {
    if (!pol?.unlocode || !pod?.unlocode) { toast.error("Set POL and POD first"); return; }
    setMatching(true);
    try {
      const res = await api.contracts.match({ pol: pol.unlocode, pod: pod.unlocode, carrier: carrierCode, crd: cargoReadyDate });
      setMatches(res);
      if (res.length === 0) toast.info("No matching contracts found for this route — enter rates manually");
    } catch (e) { toast.error(e.message); }
    finally { setMatching(false); }
  };

  const applyContract = c => {
    setContractId(c.id);
    setContractRef(c.contractNumber || c.id);
    if (!carrierCode) setCarrierCode(c.carrierCode);
    if (c.rates?.length) {
      setLines(c.rates.map(r => ({
        serviceCode: r.serviceCode || "", description: r.description || "", containerType: r.containerType || "",
        quantity: "1", rate: String(r.amount), currency: r.currency || "USD",
        // Contract rates carry no temperature concept — always starts blank/editable here,
        // regardless of whether the applied rate happens to be for a reefer container type.
        setTemperatureC: "",
      })));
    }
    setMatches(null);
    toast.success(`Applied ${c.contractNumber || c.id} as a pricing reference — adjust rates for the customer-facing quote before saving`);
  };

  const canSave = pol?.unlocode && pod?.unlocode;

  const save = async () => {
    if (!canSave) { toast.error("Set POL and POD"); return; }
    setSaving(true);
    try {
      const payload = {
        customerId: customer.id, customerName: customer.name,
        pol: pol.unlocode, pod: pod.unlocode, carrierCode,
        contractId, contractRef, commodityCode, movementType, serviceType, incoterm,
        cargoReadyDate, validUntil, notes, currency,
        lines: lines.filter(l => l.serviceCode.trim())
          .map(l => ({ ...l, quantity: Number(l.quantity) || 1, rate: Number(l.rate) || 0 })),
      };
      const saved = isEdit ? await api.quotes.update(quote.id, payload) : await api.quotes.create(payload);
      toast.success(isEdit ? "Quote updated" : `Quote created — ${saved.lines.length} line(s)`);
      onSaved(saved);
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={isEdit ? `Edit Quote — ${quote.id}` : "New Quote"} onClose={onClose} width={820}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <CustomerCombobox label="Customer" value={customer} onChange={setCustomer} />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px", gap: 12 }}>
          <PortField label="POL" value={pol} onChange={setPol} required />
          <PortField label="POD" value={pod} onChange={setPod} required />
          <Field label="Carrier"><CarrierCombobox value={carrierCode} onChange={setCarrierCode} /></Field>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Sel label="Movement Type" value={movementType} onChange={setMovementType} options={MOVEMENT_TYPE_OPTIONS} />
          <Sel label="Service Type" value={serviceType} onChange={setServiceType} options={SERVICE_TYPE_OPTIONS} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Commodity"><CommodityCombobox value={commodityCode} onChange={setCommodityCode} /></Field>
          <Sel label="Incoterm" value={incoterm} onChange={setIncoterm}
            options={[{ value: "", label: "Select incoterm…" }, ...INCOTERMS_2020.map(t => ({ value: t.code, label: `${t.code} – ${t.name}` }))]} />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 120px", gap: 12 }}>
          <Field label="Cargo Ready Date"><DatePicker value={cargoReadyDate} onChange={setCargoReadyDate} /></Field>
          <Field label="Valid Until"><DatePicker value={validUntil} onChange={setValidUntil} /></Field>
          <Sel label="Currency" value={currency} onChange={setCurrency} options={CURRENCIES.map(c => ({ value: c, label: c }))} />
        </div>
        <p style={{ fontFamily: T.body, fontSize: 10.5, color: T.border, lineHeight: 1.4, margin: "-6px 0 0" }}>
          After Valid Until passes, an un-actioned Sent quote auto-expires.
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
          background: T.bg, border: `1px dashed ${T.border}`, borderRadius: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, fontWeight: 600 }}>Price from a matching contract</div>
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
              {contractRef
                ? `Referencing ${contractRef} — pick a different contract or adjust the lines below`
                : "Uses the same contract-match engine as shipment cost lines, as a pricing starting point"}
            </div>
          </div>
          <Btn size="sm" variant="secondary" onClick={findMatches} disabled={matching}>
            {matching ? "Searching…" : "Find Matching Contracts"}
          </Btn>
        </div>
        {matches && (
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, maxHeight: 180, overflowY: "auto" }}>
            {matches.length === 0 ? (
              <div style={{ padding: 12, fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>No matching contracts for this route</div>
            ) : matches.map((c, i) => (
              <div key={`${c.id}-${i}`} onClick={() => applyContract(c)}
                style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 12.5, color: T.text }}
                onMouseEnter={e => e.currentTarget.style.background = T.btnSecondaryHoverBg}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                {c.contractNumber || c.id} · {c.carrierCode} · {c.rates?.length || 0} rate(s) on file
              </div>
            ))}
          </div>
        )}

        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <label style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>
              Quote Lines
            </label>
            <Btn size="sm" variant="secondary" onClick={addLine}>+ Add Line</Btn>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {lines.map((l, i) => {
              const isReefer = looksReefer(l.containerType);
              return (
              <div key={i} style={{ display: "grid", gridTemplateColumns: "80px 1fr 90px 70px 60px 110px 80px 24px", gap: 6, alignItems: "center",
                padding: "8px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6 }}>
                <input value={l.serviceCode} onChange={e => setLine(i, { serviceCode: e.target.value.toUpperCase() })}
                  placeholder="OF" style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, padding: "6px 8px" }} />
                <input value={l.description} onChange={e => setLine(i, { description: e.target.value })}
                  placeholder="Description" style={{ ...inputBase, fontSize: 12.5, padding: "6px 8px" }} />
                <input value={l.containerType} onChange={e => setLine(i, { containerType: e.target.value.toUpperCase() })}
                  placeholder="40HC" style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, padding: "6px 8px" }} />
                {isReefer ? (
                  <input value={l.setTemperatureC} onChange={e => { if (e.target.value === "" || /^-?\d*\.?\d*$/.test(e.target.value)) setLine(i, { setTemperatureC: e.target.value }); }}
                    inputMode="decimal" placeholder="°C" title="Reefer set-point temperature (°C)"
                    style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, padding: "6px 8px", textAlign: "right" }} />
                ) : (
                  <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.border, textAlign: "right", padding: "6px 8px" }}>—</span>
                )}
                <input value={l.quantity} onChange={e => setLine(i, { quantity: e.target.value })} inputMode="numeric"
                  placeholder="Qty" style={{ ...inputBase, fontFamily: T.mono, fontSize: 12.5, padding: "6px 8px", textAlign: "right" }} />
                <input value={l.rate} onChange={e => setLine(i, { rate: e.target.value })} inputMode="decimal"
                  placeholder="Rate" style={{ ...inputBase, fontFamily: T.mono, fontSize: 12.5, padding: "6px 8px", textAlign: "right" }} />
                <select value={l.currency} onChange={e => setLine(i, { currency: e.target.value })}
                  style={{ ...inputBase, fontSize: 12, padding: "6px 8px", cursor: "pointer" }}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <button onClick={() => removeLine(i)} type="button" disabled={lines.length === 1}
                  style={{ background: "none", border: "none", cursor: lines.length === 1 ? "not-allowed" : "pointer",
                    color: T.textMuted, opacity: lines.length === 1 ? 0.3 : 1, display: "flex", justifyContent: "center" }}>
                  <IconClose size={14} />
                </button>
              </div>
              );
            })}
          </div>
        </div>

        <Field label="Notes"><textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
          style={{ ...inputBase, fontSize: 13, resize: "vertical" }} /></Field>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={save} disabled={!canSave || saving}>{saving ? "Saving…" : isEdit ? "Save Changes" : "Create Quote"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Quote detail modal ──────────────────────────────────────────────────────
const QuoteDetailModal = ({ quoteId, navigate, onClose, onChanged, onShipmentCreated }) => {
  const [quote, setQuote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.quotes.get(quoteId).then(setQuote).catch(e => toast.error(e.message)).finally(() => setLoading(false));
  }, [quoteId]);
  useEffect(() => { load(); }, [load]);

  const runAction = async (fn, successMsg) => {
    setBusy(true);
    try { await fn(); toast.success(successMsg); load(); onChanged?.(); }
    catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  const send = () => runAction(() => api.quotes.send(quoteId), "Quote sent");
  const accept = () => runAction(() => api.quotes.accept(quoteId), "Quote accepted");
  const decline = () => runAction(async () => { await api.quotes.decline(quoteId, { reason: declineReason }); setDeclining(false); setDeclineReason(""); }, "Quote declined");
  const convert = async () => {
    setBusy(true);
    try {
      const res = await api.quotes.convert(quoteId);
      toast.success(`Converted to shipment ${res.shipmentId}`);
      if (res.screening?.result === "HIT") {
        const parties = (res.screening.hits || []).map(h => `${h.field}: ${h.value}`).join(", ");
        toast.warning(`Compliance review required — sanctioned party detected${parties ? ` (${parties})` : ""}`);
      }
      if (res.creditWarning?.onHold?.length) {
        const names = res.creditWarning.onHold.map(h => `${h.companyName} (${h.role})`).join(", ");
        toast.warning(`On credit hold: ${names} — this will block sending a carrier booking request and generating invoices until it's cleared`);
      }
      onShipmentCreated?.(res.shipment);
      onClose();
      onChanged?.();
      navigate("detail", res.shipmentId);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={quote ? `Quote — ${quote.id}` : "Quote"} onClose={onClose} width={780}>
      {loading || !quote ? <Spinner /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Badge variant={STATUS_VARIANT[quote.status] || "default"}>{quote.status}</Badge>
              <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text }}>{quote.pol}→{quote.pod}</span>
              {quote.carrierCode && <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.textMuted }}>{quote.carrierCode}</span>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {quote.status === "Draft" && <Btn size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit</Btn>}
              {quote.status === "Draft" && <Btn size="sm" onClick={send} disabled={busy}>Send to Customer</Btn>}
              {quote.status === "Sent" && <Btn size="sm" variant="danger" onClick={() => setDeclining(true)} disabled={busy}>Decline</Btn>}
              {quote.status === "Sent" && <Btn size="sm" onClick={accept} disabled={busy}>Accept</Btn>}
              {quote.status === "Accepted" && <Btn size="sm" onClick={convert} disabled={busy}>Convert to Shipment</Btn>}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, fontFamily: T.body, fontSize: 12.5 }}>
            <div><div style={{ color: T.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Customer</div>
              <div style={{ color: T.text }}>{quote.customerName || "—"}</div></div>
            <div><div style={{ color: T.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Cargo Ready</div>
              <div style={{ color: T.text }}>{quote.cargoReadyDate || "—"}</div></div>
            <div><div style={{ color: T.textMuted, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>Valid Until</div>
              <div style={{ color: T.text }}>{quote.validUntil || "—"}</div></div>
          </div>

          {quote.contractRef && (
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
              Priced with reference to contract <span style={{ fontFamily: T.mono, color: T.accent }}>{quote.contractRef}</span>
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.body, fontSize: 12.5 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted, textAlign: "left" }}>
                  {["Service", "Description", "Container", "Temp", "Qty", "Rate", "USD"].map(h => (
                    <th key={h} style={{ padding: "6px 8px", fontWeight: 600, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {quote.lines.map(l => (
                  <tr key={l.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: "8px", fontFamily: T.mono, color: T.text }}>{l.serviceCode}</td>
                    <td style={{ padding: "8px", color: T.text }}>{l.description || "—"}</td>
                    <td style={{ padding: "8px", fontFamily: T.mono, color: T.textMuted }}>{l.containerType || "—"}</td>
                    <td style={{ padding: "8px", fontFamily: T.mono, color: T.textMuted, textAlign: "right" }}>{l.setTemperatureC != null ? `${l.setTemperatureC}°C` : "—"}</td>
                    <td style={{ padding: "8px", fontFamily: T.mono, color: T.text, textAlign: "right" }}>{l.quantity}</td>
                    <td style={{ padding: "8px", fontFamily: T.mono, color: T.text, textAlign: "right" }}>{l.rate.toLocaleString()} {l.currency}</td>
                    <td style={{ padding: "8px", fontFamily: T.mono, color: T.text, textAlign: "right" }}>{fmtUsd(l.amountUsd)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={5} style={{ padding: "8px", textAlign: "right", fontFamily: T.body, fontWeight: 600, color: T.textMuted }}>Total</td>
                  <td style={{ padding: "8px", textAlign: "right", fontFamily: T.mono, fontWeight: 700, color: T.text }}>{fmtUsd(quote.totalAmountUsd)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {quote.status === "Declined" && quote.declineReason && (
            <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, margin: 0 }}>Decline reason: {quote.declineReason}</p>
          )}
          {quote.status === "Converted" && quote.convertedShipmentId && (
            <button onClick={() => { onClose(); navigate("detail", quote.convertedShipmentId); }}
              style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontFamily: T.mono, fontSize: 12.5, padding: 0, textAlign: "left" }}>
              → View shipment {quote.convertedShipmentId}
            </button>
          )}
          {quote.notes && <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, margin: 0 }}>Notes: {quote.notes}</p>}
        </div>
      )}
      {declining && (
        <Modal title="Decline quote" onClose={() => setDeclining(false)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Reason" hint="Why the customer didn't proceed — visible in this quote's history">
              <textarea value={declineReason} onChange={e => setDeclineReason(e.target.value)} rows={3}
                style={{ ...inputBase, fontSize: 13, resize: "vertical" }} />
            </Field>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setDeclining(false)}>Cancel</Btn>
              <Btn variant="danger" onClick={decline} disabled={busy}>Mark Declined</Btn>
            </div>
          </div>
        </Modal>
      )}
      {editing && quote && (
        <QuoteFormModal quote={quote} onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); onChanged?.(); }} />
      )}
    </Modal>
  );
};

// ─── Main page ───────────────────────────────────────────────────────────────
const QuotesPage = ({ navigate, onShipmentCreated }) => {
  const [statusFilter, setStatusFilter] = useState("");
  const [quotes, setQuotes] = useState(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(getStoredPageSize);
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const load = useCallback((opts = {}) => {
    const off = opts.offset !== undefined ? opts.offset : offset;
    const lim = opts.limit  !== undefined ? opts.limit  : limit;
    api.quotes.list({ ...(statusFilter ? { status: statusFilter } : {}), limit: lim, offset: off })
      .then(r => { setQuotes(r.results); setTotal(r.total ?? (r.results || []).length); })
      .catch(() => { setQuotes([]); setTotal(0); });
  }, [statusFilter, offset, limit]);
  useEffect(() => { setOffset(0); load({ offset: 0 }); }, [statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const goPage = off => { setOffset(off); load({ offset: off }); };
  const changeLimit = n => { setLimit(n); setOffset(0); load({ limit: n, offset: 0 }); };

  const doDelete = async id => {
    try { await api.quotes.remove(id); toast.success("Quote deleted"); load(); }
    catch (e) { toast.error(e.message); }
    finally { setConfirmDeleteId(null); }
  };

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 22, fontWeight: 700, color: T.text, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <IconReceipt size={20} /> Quotes
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            A pre-booking quote / RFQ stage — price a route, send it to the customer, and convert an accepted
            quote directly into a real shipment.
          </p>
        </div>
        <Btn onClick={() => setNewOpen(true)}>+ New Quote</Btn>
      </div>

      <div style={{ marginBottom: 12, width: 200 }}>
        <Sel label="Status" value={statusFilter} onChange={setStatusFilter}
          options={[{ value: "", label: "All Statuses" }, ...["Draft", "Sent", "Accepted", "Declined", "Expired", "Converted"].map(s => ({ value: s, label: s }))]} />
      </div>

      {quotes === null ? <Spinner /> : quotes.length === 0 ? (
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>No quotes yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.body, fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted, textAlign: "left" }}>
                {["Quote", "Customer", "Route", "Carrier", "Valid Until", "Total", "Status", ""].map(h => (
                  <th key={h} style={{ padding: "8px", fontWeight: 600, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {quotes.map(q => (
                <tr key={q.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td onClick={() => setDetailId(q.id)} style={{ padding: "10px 8px", fontFamily: T.mono, color: T.accent, cursor: "pointer" }}>{q.id}</td>
                  <td onClick={() => setDetailId(q.id)} style={{ padding: "10px 8px", cursor: "pointer" }}>{q.customerName || "—"}</td>
                  <td onClick={() => setDetailId(q.id)} style={{ padding: "10px 8px", fontFamily: T.mono, cursor: "pointer" }}>{q.pol}→{q.pod}</td>
                  <td onClick={() => setDetailId(q.id)} style={{ padding: "10px 8px", cursor: "pointer" }}>{q.carrierCode || "—"}</td>
                  <td onClick={() => setDetailId(q.id)} style={{ padding: "10px 8px", cursor: "pointer" }}>{q.validUntil || "—"}</td>
                  <td onClick={() => setDetailId(q.id)} style={{ padding: "10px 8px", fontFamily: T.mono, cursor: "pointer", textAlign: "right" }}>{fmtUsd(q.totalAmountUsd)}</td>
                  <td onClick={() => setDetailId(q.id)} style={{ padding: "10px 8px", cursor: "pointer" }}><Badge variant={STATUS_VARIANT[q.status] || "default"}>{q.status}</Badge></td>
                  <td style={{ padding: "10px 8px", textAlign: "right" }} onClick={e => e.stopPropagation()}>
                    <ActionMenu items={[
                      { icon: IconEye,   label: "Open",   onClick: () => setDetailId(q.id) },
                      { icon: IconClose, label: "Delete", variant: "danger", onClick: () => setConfirmDeleteId(q.id) },
                    ]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {quotes !== null && quotes.length > 0 && (
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <PageSizeSelect value={limit} onChange={changeLimit} />
          <div style={{ flex: 1 }}><Pagination total={total} offset={offset} limit={limit} onPage={goPage} /></div>
        </div>
      )}

      {newOpen && (
        <QuoteFormModal onClose={() => setNewOpen(false)}
          onSaved={saved => { setNewOpen(false); load(); setDetailId(saved.id); }} />
      )}
      {detailId && (
        <QuoteDetailModal quoteId={detailId} navigate={navigate} onClose={() => setDetailId(null)} onChanged={load}
          onShipmentCreated={onShipmentCreated} />
      )}
      {confirmDeleteId && (
        <ConfirmModal message="Delete this quote? This can't be undone." onCancel={() => setConfirmDeleteId(null)} onConfirm={() => doDelete(confirmDeleteId)} />
      )}
    </div>
  );
};

export default QuotesPage;
