import { useState, useEffect, useCallback, useRef } from "react";
import { T, CURRENCIES } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Btn from "../components/primitives/Btn";
import Badge from "../components/primitives/Badge";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import { Field, Inp, Sel } from "../components/primitives/Form";
import { inputBase } from "../components/primitives/Form";
import DatePicker from "../components/primitives/DatePicker";
import Spinner from "../components/primitives/spinner";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import { IconFileCertificate, IconSearch, IconClose, IconUpload } from "../components/primitives/Icon";

// ─── Freight Audit & Payment ────────────────────────────────────────────────
// Reconciles a carrier's own submitted invoice against what was actually contracted (or already
// accrued on the shipment) — flags variance beyond a tolerance instead of trusting the carrier's
// figure at face value. A dedicated Detention & Demurrage pre-audit independently computes the
// expected charge from the shipment's existing free-time tracking before comparing it to what
// the carrier billed. See routes/carrier-invoices.js for the matching engine this page drives.

const STATUS_VARIANT = { Pending: "warning", Reconciled: "info", Approved: "success", Disputed: "danger" };
const LINE_STATUS_VARIANT = { pending: "warning", matched: "success", variance: "danger", approved: "success", disputed: "danger" };
const EXPECTED_SOURCE_LABEL = { cost_line: "vs. accrued cost line", contract_rate: "vs. contract rate", dnd_calc: "vs. computed free-time charge", "": "no basis to compare" };

const fmtUsd = v => v == null ? "—" : `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = v => v == null ? "" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

// ─── Shipment picker (inline, client-filtered over the already-loaded shipments list) ──────────
const ShipmentPicker = ({ shipments, value, onSelect }) => {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = shipments.find(s => s.id === value) || null;
  const matches = query.trim()
    ? shipments.filter(s =>
        s.id.toUpperCase().includes(query.toUpperCase()) ||
        (s.pol || "").includes(query.toUpperCase()) || (s.pod || "").includes(query.toUpperCase()) ||
        (s.carrierCode || "").toUpperCase().includes(query.toUpperCase())
      ).slice(0, 20)
    : shipments.slice(0, 20);

  if (selected) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, ...inputBase }}>
        <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text, flex: 1 }}>
          {selected.id} — {selected.pol}→{selected.pod} ({selected.carrierCode})
        </span>
        <button onClick={() => onSelect(null)} type="button"
          style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, padding: 0, display: "flex" }}>
          <IconClose size={14} />
        </button>
      </div>
    );
  }
  return (
    <div style={{ position: "relative" }}>
      <input value={query} onChange={e => { setQuery(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        placeholder="Search by shipment ID, POL, POD, or carrier…" style={{ ...inputBase, fontFamily: T.mono, fontSize: 13 }} />
      {open && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 20,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, maxHeight: 260, overflowY: "auto",
          boxShadow: "0 12px 28px rgba(0,0,0,.35)" }}>
          {matches.length === 0 && <div style={{ padding: 12, fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>No matching shipments</div>}
          {matches.map(s => (
            <div key={s.id} onClick={() => { onSelect(s.id); setOpen(false); setQuery(""); }}
              style={{ padding: "8px 12px", cursor: "pointer", fontFamily: T.mono, fontSize: 12.5, color: T.text,
                borderBottom: `1px solid ${T.border}` }}
              onMouseEnter={e => e.currentTarget.style.background = T.btnSecondaryHoverBg}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              {s.id} — {s.pol}→{s.pod} ({s.carrierCode}) · {s.status}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── New Carrier Invoice modal ──────────────────────────────────────────────
const emptyLine = () => ({ serviceCode: "", description: "", containerId: "", freeTimeSide: "", amount: "", currency: "USD" });

// Instructs the vision model to hand back exactly the shape the form below expects, so the
// extraction result can pre-fill state directly without a translation layer.
const EXTRACT_INSTRUCTIONS = `Extract carrier freight invoice data from this document as a single JSON object with this exact shape:
{
  "carrierCode": string or null (the carrier's SCAC code, e.g. "MAEU", "MSCU", "CMDU" — infer from the carrier name if the SCAC itself isn't printed),
  "invoiceNumber": string or null,
  "invoiceDate": string or null (format as YYYY-MM-DD),
  "currency": string or null (3-letter ISO code, e.g. "USD", "EUR"),
  "lines": [
    {
      "serviceCode": short uppercase code for the charge, e.g. "OF" (Ocean Freight), "THC" (Terminal Handling), "DET" (Detention), "DEM" (Demurrage), "DOC" (Documentation), "BAF" (Bunker Adjustment), "CAF" (Currency Adjustment), or another short code you infer,
      "description": string — the line's own description as printed,
      "amount": number — the charge amount with no currency symbols, commas, or units
    }
  ]
}
Return ONLY the JSON object, no other text.`;

const NewInvoiceModal = ({ shipments, onClose, onCreated }) => {
  const [shipmentId, setShipmentId] = useState(null);
  const [containers, setContainers] = useState([]);
  const [carrierCode, setCarrierCode] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([emptyLine()]);
  const [saving, setSaving] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const extractFileRef = useRef(null);

  useEffect(() => {
    if (!shipmentId) { setContainers([]); return; }
    const s = shipments.find(x => x.id === shipmentId);
    if (s?.carrierCode) setCarrierCode(prev => prev || s.carrierCode);
    api.containers.list({ shipmentId }).then(setContainers).catch(() => setContainers([]));
  }, [shipmentId]);

  useEffect(() => { api.ai.settings().then(s => setAiEnabled(s.enabled)).catch(() => {}); }, []);

  const setLine = (i, patch) => setLines(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  const addLine = () => setLines(prev => [...prev, emptyLine()]);
  const removeLine = i => setLines(prev => prev.filter((_, idx) => idx !== i));

  const canSave = shipmentId && lines.length > 0 && lines.every(l => l.serviceCode.trim() && l.amount !== "" && !isNaN(Number(l.amount)));

  const handleExtractFile = async e => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setExtracting(true);
    try {
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = ev => resolve(ev.target.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { extracted } = await api.ai.extractDocument(dataBase64, file.type, EXTRACT_INSTRUCTIONS);
      const validCurrency = extracted?.currency && CURRENCIES.includes(extracted.currency) ? extracted.currency : null;
      if (extracted?.carrierCode) setCarrierCode(String(extracted.carrierCode).toUpperCase());
      if (extracted?.invoiceNumber) setInvoiceNumber(String(extracted.invoiceNumber));
      if (extracted?.invoiceDate) setInvoiceDate(String(extracted.invoiceDate));
      if (validCurrency) setCurrency(validCurrency);
      if (Array.isArray(extracted?.lines) && extracted.lines.length > 0) {
        setLines(extracted.lines.map(l => ({
          serviceCode: String(l.serviceCode || "").toUpperCase().trim().slice(0, 10),
          description: l.description || "",
          containerId: "",
          freeTimeSide: "",
          amount: l.amount != null && !isNaN(Number(l.amount)) ? String(l.amount) : "",
          currency: validCurrency || "USD",
        })));
      }
      toast.success("Extracted from document — review the fields below before saving");
    } catch (ex) { toast.error(ex.message); }
    finally { setExtracting(false); }
  };

  const save = async () => {
    if (!canSave) { toast.error("Pick a shipment and fill in every line's service code and amount"); return; }
    setSaving(true);
    try {
      const created = await api.carrierInvoices.create({
        shipmentId, carrierCode, invoiceNumber, invoiceDate, currency, notes,
        lines: lines.map(l => ({ ...l, amount: Number(l.amount) })),
      });
      toast.success(`Carrier invoice created — ${created.lines.length} line(s)`);
      onCreated(created);
    } catch (e) { toast.error(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="New Carrier Invoice" onClose={onClose} width={780}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {aiEnabled && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
            background: T.bg, border: `1px dashed ${T.border}`, borderRadius: 8 }}>
            <IconUpload size={15} style={{ color: T.textMuted, flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, fontWeight: 600 }}>Extract from document</div>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                Upload the carrier's invoice (PDF or image) to pre-fill the fields below — review before saving.
              </div>
            </div>
            <Btn size="sm" variant="secondary" onClick={() => extractFileRef.current?.click()} disabled={extracting}>
              {extracting ? "Extracting…" : "Choose File"}
            </Btn>
            <input ref={extractFileRef} type="file" style={{ display: "none" }} onChange={handleExtractFile}
              accept="application/pdf,image/png,image/jpeg,image/webp,image/gif" />
          </div>
        )}
        <Field label="Shipment" required><ShipmentPicker shipments={shipments} value={shipmentId} onSelect={setShipmentId} /></Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 120px", gap: 12 }}>
          <Field label="Carrier"><CarrierCombobox value={carrierCode} onChange={setCarrierCode} /></Field>
          <Inp label="Invoice Number" value={invoiceNumber} onChange={setInvoiceNumber} mono />
          <Field label="Invoice Date"><DatePicker value={invoiceDate} onChange={setInvoiceDate} /></Field>
          <Sel label="Currency" value={currency} onChange={setCurrency} options={CURRENCIES.map(c => ({ value: c, label: c }))} />
        </div>

        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <label style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".08em" }}>
              Invoice Lines
            </label>
            <Btn size="sm" variant="secondary" onClick={addLine}>+ Add Line</Btn>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {lines.map((l, i) => {
              const isDnd = ["DET", "DEM"].includes(l.serviceCode.trim().toUpperCase());
              return (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "90px 1fr 140px 120px 110px 80px 24px", gap: 6, alignItems: "center",
                  padding: "8px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6 }}>
                  <input value={l.serviceCode} onChange={e => setLine(i, { serviceCode: e.target.value.toUpperCase() })}
                    placeholder="OF" style={{ ...inputBase, fontFamily: T.mono, fontSize: 12, padding: "6px 8px" }} />
                  <input value={l.description} onChange={e => setLine(i, { description: e.target.value })}
                    placeholder="Description" style={{ ...inputBase, fontSize: 12.5, padding: "6px 8px" }} />
                  <select value={l.containerId} onChange={e => setLine(i, { containerId: e.target.value })}
                    style={{ ...inputBase, fontSize: 12, padding: "6px 8px", cursor: "pointer" }}>
                    <option value="">(no container)</option>
                    {containers.map(c => <option key={c.id} value={c.id}>{c.containerNumber || `${c.size}${c.type}`}</option>)}
                  </select>
                  <select value={l.freeTimeSide} onChange={e => setLine(i, { freeTimeSide: e.target.value })}
                    disabled={!isDnd || !l.containerId}
                    style={{ ...inputBase, fontSize: 12, padding: "6px 8px", cursor: isDnd ? "pointer" : "not-allowed", opacity: isDnd ? 1 : 0.45 }}>
                    <option value="">Free time side…</option>
                    <option value="origin">Origin</option>
                    <option value="destination">Destination</option>
                  </select>
                  <input value={l.amount} onChange={e => setLine(i, { amount: e.target.value })} inputMode="decimal"
                    placeholder="Amount" style={{ ...inputBase, fontFamily: T.mono, fontSize: 12.5, padding: "6px 8px", textAlign: "right" }} />
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
          <p style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, margin: "8px 0 0" }}>
            A Detention (DET) or Demurrage (DEM) line with a container and free-time side picked gets independently
            checked against the shipment's own free-time tracking, not just the contract rate.
          </p>
        </div>

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={save} disabled={!canSave || saving}>{saving ? "Creating…" : "Create Invoice"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

// ─── Invoice detail modal ───────────────────────────────────────────────────
const InvoiceDetailModal = ({ invoiceId, shipments, navigate, onClose, onChanged }) => {
  const [invoice, setInvoice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [disputing, setDisputing] = useState(null); // line id currently in the dispute-reason prompt
  const [disputeReason, setDisputeReason] = useState("");
  const [busyLineId, setBusyLineId] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.carrierInvoices.get(invoiceId).then(setInvoice).catch(e => toast.error(e.message)).finally(() => setLoading(false));
  }, [invoiceId]);
  useEffect(() => { load(); }, [load]);

  const approve = async lineId => {
    setBusyLineId(lineId);
    try { await api.carrierInvoices.approveLine(lineId); toast.success("Approved — posted to cost lines"); load(); onChanged?.(); }
    catch (e) { toast.error(e.message); }
    finally { setBusyLineId(null); }
  };
  const dispute = async lineId => {
    setBusyLineId(lineId);
    try { await api.carrierInvoices.disputeLine(lineId, { reason: disputeReason }); toast.success("Marked disputed"); setDisputing(null); setDisputeReason(""); load(); onChanged?.(); }
    catch (e) { toast.error(e.message); }
    finally { setBusyLineId(null); }
  };
  const rematch = async () => {
    try { await api.carrierInvoices.rematch(invoiceId); toast.success("Re-matched"); load(); onChanged?.(); }
    catch (e) { toast.error(e.message); }
  };

  const shipment = invoice ? shipments.find(s => s.id === invoice.shipmentId) : null;

  return (
    <Modal title={invoice ? `Carrier Invoice — ${invoice.invoiceNumber || invoice.id}` : "Carrier Invoice"} onClose={onClose} width={860}>
      {loading || !invoice ? <Spinner /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Badge variant={STATUS_VARIANT[invoice.status] || "default"}>{invoice.status}</Badge>
              <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.textMuted }}>{invoice.carrierCode} · {invoice.invoiceDate || "no date"}</span>
              <button onClick={() => { onClose(); navigate("detail", invoice.shipmentId); }}
                style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontFamily: T.mono, fontSize: 12.5, padding: 0 }}>
                {invoice.shipmentId}{shipment ? ` — ${shipment.pol}→${shipment.pod}` : ""} ↗
              </button>
            </div>
            <Btn size="sm" variant="secondary" onClick={rematch}>↻ Re-match</Btn>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.body, fontSize: 12.5 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted, textAlign: "left" }}>
                  {["Service", "Description", "Amount", "Expected", "Variance", "Status", ""].map(h => (
                    <th key={h} style={{ padding: "6px 8px", fontWeight: 600, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map(l => (
                  <tr key={l.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                    <td style={{ padding: "8px", fontFamily: T.mono, color: T.text }}>{l.serviceCode}{l.freeTimeSide && <span style={{ color: T.textMuted }}> ({l.freeTimeSide})</span>}</td>
                    <td style={{ padding: "8px", color: T.text }}>{l.description || "—"}</td>
                    <td style={{ padding: "8px", fontFamily: T.mono, color: T.text, textAlign: "right" }}>{fmtUsd(l.amountUsd)}</td>
                    <td style={{ padding: "8px", textAlign: "right" }}>
                      <div style={{ fontFamily: T.mono, color: T.text }}>{fmtUsd(l.expectedAmountUsd)}</div>
                      <div style={{ fontSize: 10, color: T.textMuted }}>{EXPECTED_SOURCE_LABEL[l.expectedSource] || ""}</div>
                    </td>
                    <td style={{ padding: "8px", fontFamily: T.mono, textAlign: "right", color: l.varianceUsd > 0 ? T.danger : l.varianceUsd < 0 ? T.success : T.textMuted }}>
                      {l.varianceUsd == null ? "—" : `${fmtUsd(Math.abs(l.varianceUsd))} ${fmtPct(l.variancePct)}`}
                    </td>
                    <td style={{ padding: "8px" }}><Badge variant={LINE_STATUS_VARIANT[l.status] || "default"}>{l.status}</Badge></td>
                    <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                      {(l.status === "pending" || l.status === "matched" || l.status === "variance") && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <Btn size="sm" onClick={() => approve(l.id)} disabled={busyLineId === l.id}>Approve</Btn>
                          <Btn size="sm" variant="danger" onClick={() => setDisputing(l.id)} disabled={busyLineId === l.id}>Dispute</Btn>
                        </div>
                      )}
                      {l.status === "disputed" && l.resolutionNotes && (
                        <span style={{ fontSize: 11, color: T.textMuted, fontStyle: "italic" }} title={l.resolutionNotes}>reason noted</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {invoice.notes && <p style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, margin: 0 }}>Notes: {invoice.notes}</p>}
        </div>
      )}
      {disputing && (
        <Modal title="Dispute line" onClose={() => setDisputing(null)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Field label="Reason" hint="Why this charge is being rejected — visible in the line's history">
              <textarea value={disputeReason} onChange={e => setDisputeReason(e.target.value)} rows={3}
                style={{ ...inputBase, fontSize: 13, resize: "vertical" }} />
            </Field>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setDisputing(null)}>Cancel</Btn>
              <Btn variant="danger" onClick={() => dispute(disputing)} disabled={busyLineId === disputing}>Mark Disputed</Btn>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
};

// ─── Main page ───────────────────────────────────────────────────────────────
const FreightAuditPage = ({ shipments, navigate }) => {
  const [activeTab, setActiveTab] = useState("all"); // 'all' | 'exceptions'
  const [invoices, setInvoices] = useState(null);
  const [exceptions, setExceptions] = useState(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const loadInvoices = useCallback(() => {
    api.carrierInvoices.list(statusFilter ? { status: statusFilter } : {})
      .then(r => setInvoices(r.results)).catch(() => setInvoices([]));
  }, [statusFilter]);
  const loadExceptions = useCallback(() => {
    api.carrierInvoices.exceptions().then(setExceptions).catch(() => setExceptions([]));
  }, []);

  useEffect(() => { loadInvoices(); loadExceptions(); }, [loadInvoices, loadExceptions]);

  const shipmentLabel = id => {
    const s = shipments.find(x => x.id === id);
    return s ? `${id} (${s.pol}→${s.pod})` : id;
  };

  const doDelete = async id => {
    try { await api.carrierInvoices.remove(id); toast.success("Invoice deleted"); loadInvoices(); loadExceptions(); }
    catch (e) { toast.error(e.message); }
    finally { setConfirmDeleteId(null); }
  };

  return (
    <div style={{ maxWidth: 1200 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: T.head, fontSize: 22, fontWeight: 700, color: T.text, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
            <IconFileCertificate size={20} /> Freight Audit &amp; Payment
          </h1>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
            Reconcile carrier invoices against contracted rates and accrued costs — including an
            independent Detention &amp; Demurrage pre-audit from the shipment's own free-time tracking.
          </p>
        </div>
        <Btn onClick={() => setNewOpen(true)}>+ New Carrier Invoice</Btn>
      </div>

      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${T.border}`, marginBottom: 16 }}>
        {[
          { key: "all", label: "All Invoices" },
          { key: "exceptions", label: `Exceptions${exceptions ? ` (${exceptions.length})` : ""}` },
        ].map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            style={{ padding: "9px 16px", background: "none", border: "none", cursor: "pointer",
              fontFamily: T.body, fontSize: 13, fontWeight: 600,
              color: activeTab === t.key ? T.accent : T.textMuted,
              borderBottom: activeTab === t.key ? `2px solid ${T.accent}` : "2px solid transparent", marginBottom: -1 }}>
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "all" && (
        <>
          <div style={{ marginBottom: 12, width: 200 }}>
            <Sel label="Status" value={statusFilter} onChange={setStatusFilter}
              options={[{ value: "", label: "All Statuses" }, ...["Pending", "Reconciled", "Approved", "Disputed"].map(s => ({ value: s, label: s }))]} />
          </div>
          {invoices === null ? <Spinner /> : invoices.length === 0 ? (
            <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>No carrier invoices yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.body, fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted, textAlign: "left" }}>
                    {["Invoice #", "Shipment", "Carrier", "Date", "Status", ""].map(h => (
                      <th key={h} style={{ padding: "8px", fontWeight: 600, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <tr key={inv.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                      <td onClick={() => setDetailId(inv.id)} style={{ padding: "10px 8px", fontFamily: T.mono, color: T.accent, cursor: "pointer" }}>{inv.invoiceNumber || inv.id}</td>
                      <td onClick={() => setDetailId(inv.id)} style={{ padding: "10px 8px", cursor: "pointer" }}>{shipmentLabel(inv.shipmentId)}</td>
                      <td onClick={() => setDetailId(inv.id)} style={{ padding: "10px 8px", cursor: "pointer" }}>{inv.carrierCode || "—"}</td>
                      <td onClick={() => setDetailId(inv.id)} style={{ padding: "10px 8px", cursor: "pointer" }}>{inv.invoiceDate || "—"}</td>
                      <td onClick={() => setDetailId(inv.id)} style={{ padding: "10px 8px", cursor: "pointer" }}><Badge variant={STATUS_VARIANT[inv.status] || "default"}>{inv.status}</Badge></td>
                      <td style={{ padding: "10px 8px", textAlign: "right" }}>
                        <Btn size="sm" variant="ghost" onClick={() => setConfirmDeleteId(inv.id)}>Delete</Btn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {activeTab === "exceptions" && (
        exceptions === null ? <Spinner /> : exceptions.length === 0 ? (
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>No open exceptions — every line has either matched or been resolved.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: T.body, fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}`, color: T.textMuted, textAlign: "left" }}>
                  {["Shipment", "Invoice", "Service", "Amount", "Expected", "Variance", "Status"].map(h => (
                    <th key={h} style={{ padding: "8px", fontWeight: 600, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {exceptions.map(e => (
                  <tr key={e.id} onClick={() => setDetailId(e.invoiceId)} style={{ borderBottom: `1px solid ${T.border}`, cursor: "pointer" }}>
                    <td style={{ padding: "10px 8px" }}>{shipmentLabel(e.shipmentId)}</td>
                    <td style={{ padding: "10px 8px", fontFamily: T.mono, color: T.accent }}>{e.invoiceNumber || e.invoiceId}</td>
                    <td style={{ padding: "10px 8px", fontFamily: T.mono }}>{e.serviceCode}</td>
                    <td style={{ padding: "10px 8px", fontFamily: T.mono, textAlign: "right" }}>{fmtUsd(e.amountUsd)}</td>
                    <td style={{ padding: "10px 8px", fontFamily: T.mono, textAlign: "right" }}>{fmtUsd(e.expectedAmountUsd)}</td>
                    <td style={{ padding: "10px 8px", fontFamily: T.mono, textAlign: "right", color: e.varianceUsd > 0 ? T.danger : T.success }}>
                      {e.varianceUsd == null ? "—" : fmtUsd(Math.abs(e.varianceUsd))}
                    </td>
                    <td style={{ padding: "10px 8px" }}><Badge variant={LINE_STATUS_VARIANT[e.status] || "default"}>{e.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {newOpen && (
        <NewInvoiceModal shipments={shipments} onClose={() => setNewOpen(false)}
          onCreated={created => { setNewOpen(false); loadInvoices(); loadExceptions(); setDetailId(created.id); }} />
      )}
      {detailId && (
        <InvoiceDetailModal invoiceId={detailId} shipments={shipments} navigate={navigate}
          onClose={() => setDetailId(null)} onChanged={() => { loadInvoices(); loadExceptions(); }} />
      )}
      {confirmDeleteId && (
        <ConfirmModal message="Delete this carrier invoice? This can't be undone." onCancel={() => setConfirmDeleteId(null)} onConfirm={() => doDelete(confirmDeleteId)} />
      )}
    </div>
  );
};

export default FreightAuditPage;
