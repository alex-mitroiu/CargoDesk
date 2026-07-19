import { useState, useEffect } from "react";
import { T } from "../tokens";
import { useAuth } from "../AuthContext";
import Btn from "../components/primitives/Btn";
import { Modal, ConfirmModal } from "../components/primitives/Modal";
import TrackedDocPreviewModal from "../components/shared/TrackedDocPreviewModal";
import { CostLineForm, CostLineHistoryModal, CostLineRow, CostLineActualizeModal } from "./ShipmentDetailPage";
import { generateInvoices, resolveInvoiceCurrency } from "../utils/invoiceGenerator";
import { api } from "../api";
import { toast } from "../toast";

const fmtUsd = v => v == null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = s => s ? new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";

// ─── Shipment Invoice Entry Page ──────────────────────────────────────────
// Dedicated sub-page for SELL-side revenue lines, split out of the old flat
// CostControl component (see ARCHITECTURE.md / TKT-6QT30S). Sibling to Cost
// Entry (BUY lines) — contract-rate regeneration (Reset/Update Carrier Costs)
// lives on that page since it's a carrier-cost concept; SELL lines here are
// added/edited manually or arrive via the Mirror action from Cost Entry.

const ShipmentAccountingInvoicesPage = ({ shipment, containers, onBack }) => {
  const { canEditShipments: canEdit } = useAuth();
  const ctrs = containers.filter(c => c.shipmentId === shipment.id);

  const [lines,     setLines]     = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [fxRates,   setFxRates]   = useState({});
  const [lineModal, setLineModal] = useState(null); // null | "add" | line object
  const [confirm,   setConfirm]   = useState(null);
  const [histOpen,  setHistOpen]  = useState(false);

  const [docs,        setDocs]        = useState([]);
  const [docsLoading,  setDocsLoading] = useState(true);
  const [previewDoc,   setPreviewDoc]  = useState(null);
  const [genBusy,       setGenBusy]     = useState(false);
  const [splitConfirm,  setSplitConfirm] = useState(false);
  const [splitBusy,     setSplitBusy]    = useState(false);
  const [currencyModal, setCurrencyModal] = useState(null); // { splitPerContainer, distinctCurrencies, currency, isFallback, principalName }
  const [actualizeLine, setActualizeLine] = useState(null); // line pending actualization
  const [confirmPost,   setConfirmPost]   = useState(null); // line pending Post confirmation

  const load = () => {
    setLoading(true);
    return api.costLines.list(shipment.id)
      .then(setLines).catch(() => setLines([])).finally(() => setLoading(false));
  };

  const loadDocs = () => {
    setDocsLoading(true);
    return api.documents.list(shipment.id)
      .then(rows => setDocs(rows.filter(d => d.docType === "FR01" || d.docType === "FR02")))
      .catch(() => setDocs([]))
      .finally(() => setDocsLoading(false));
  };

  useEffect(() => {
    load();
    loadDocs();
    api.fx.rates().then(d => setFxRates(d.rates || {})).catch(() => {});
  }, [shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const sellLines   = lines.filter(l => l.type === "SELL");
  const totalSell   = sellLines.reduce((s, l) => s + l.amountUsd, 0);
  const totalVat    = sellLines.reduce((s, l) => s + (l.vatAmountUsd || 0), 0);
  const hasVat      = totalVat > 0;
  const hasChargeLines = sellLines.length > 0;
  const untaggedSellLines = sellLines.filter(l => !l.containerId);
  const canSplit = untaggedSellLines.length > 0 && ctrs.length > 0;

  // Generation is blocked with no charge lines present — not just a courtesy message,
  // this is the actual gate: the buttons are disabled AND this guard runs before any
  // upload call fires, so there's no path to producing a blank/empty invoice document.
  const handleGenerate = async splitPerContainer => {
    if (!hasChargeLines) {
      toast.error("At least one valid charge line needs to be present to generate an invoice.");
      return;
    }
    // Lines actually in scope for this generation action — mirrors generateInvoices()'s own
    // per-container targeting so the currency check matches what will really be invoiced.
    const scopedLines = splitPerContainer
      ? sellLines.filter(l => l.containerId && ctrs.some(c => c.id === l.containerId))
      : sellLines;
    const distinctCurrencies = [...new Set(scopedLines.map(l => l.currency))];
    if (distinctCurrencies.length > 1) {
      setGenBusy(true);
      const resolved = await resolveInvoiceCurrency(shipment);
      setGenBusy(false);
      setCurrencyModal({ splitPerContainer, distinctCurrencies, ...resolved });
      return;
    }
    await runGenerate(splitPerContainer, "USD");
  };

  const runGenerate = async (splitPerContainer, targetCurrency) => {
    setGenBusy(true);
    try {
      const created = await generateInvoices(shipment, { containers: ctrs, costLines: lines, splitPerContainer, targetCurrency, fxRates });
      toast.success(`${created.length} invoice${created.length !== 1 ? "s" : ""} generated`);
      // generateInvoices() may have auto-injected new automated charge-code cost lines
      // (TKT-OK5H34) — reload lines too, not just docs, so a second Generate click on
      // this same page instance sees them and doesn't inject duplicates.
      load();
      loadDocs();
    } catch (e) { toast.error(e.message); }
    setGenBusy(false);
  };

  // Divides amount evenly across n containers, rounded to 2dp, with the last container
  // absorbing any rounding remainder so the sum always equals the original amount exactly.
  const splitAmount = (total, n) => {
    const base = Math.floor((total / n) * 100) / 100;
    const amounts = Array(n).fill(base);
    const remainder = Math.round((total - base * n) * 100) / 100;
    amounts[n - 1] = Math.round((amounts[n - 1] + remainder) * 100) / 100;
    return amounts;
  };

  // Replaces each shipment-level (untagged) SELL line with one line per container, amount
  // divided evenly — preserves the original total rather than multiplying it by container
  // count. Creates the replacements first, then removes the original, so a failure partway
  // through never leaves the shipment with less revenue recorded than before.
  const handleSplitPerContainer = async () => {
    setSplitBusy(true);
    try {
      for (const line of untaggedSellLines) {
        const amounts = splitAmount(line.amount, ctrs.length);
        for (let i = 0; i < ctrs.length; i++) {
          await api.costLines.create(shipment.id, {
            type: "SELL", chargeCode: line.chargeCode, currency: line.currency,
            amount: amounts[i], exchangeRate: line.exchangeRate,
            vatRate: line.vatRate, notes: line.notes, containerId: ctrs[i].id,
            source: line.source,
          });
        }
        await api.costLines.remove(shipment.id, line.id);
      }
      toast.success(`Split ${untaggedSellLines.length} line${untaggedSellLines.length !== 1 ? "s" : ""} across ${ctrs.length} containers`);
      setSplitConfirm(false);
      load();
    } catch (e) { toast.error(e.message); }
    setSplitBusy(false);
  };

  const handleConfirmDoc = async docId => {
    try {
      const updated = await api.documents.patch(docId, { status: "confirmed" });
      setDocs(p => p.map(d => d.id === docId ? updated : d));
      setPreviewDoc(updated);
      toast.success("Invoice confirmed");
    } catch (e) { toast.error(e.message); }
  };

  const invoiceLabel = doc => {
    if (!doc.containerId) return "Consolidated";
    const ctr = ctrs.find(c => c.id === doc.containerId);
    return ctr ? `Container ${ctr.containerNumber || `(${ctr.size || ""}${ctr.type || ""})`}` : "Container";
  };

  const statusPill = doc => {
    const isConfirmed = doc.status === "confirmed";
    const label = isConfirmed ? "✓ Confirmed" : doc.isStale ? "⚠ Outdated" : "Draft";
    const color = isConfirmed ? T.success : doc.isStale ? T.warning : T.textMuted;
    return <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color,
      background: color + "18", border: `1px solid ${color}44`, borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap" }}>{label}</span>;
  };

  const handleSave = async (data, mirror = false) => {
    try {
      if (lineModal === "add") {
        await api.costLines.create(shipment.id, data);
        if (mirror) {
          // Tagged 'mirror', not inherited from `data`/source — this line didn't come
          // from a contract import, so Reset/Update Carrier Costs must never touch it.
          await api.costLines.create(shipment.id, { ...data, type: "BUY", source: "mirror" });
          toast.success("Invoice line added + mirrored to Cost Entry as BUY");
        } else {
          toast.success("Invoice line added");
        }
      } else {
        await api.costLines.update(shipment.id, lineModal.id, data);
        if (mirror) {
          await api.costLines.create(shipment.id, { ...data, type: "BUY", source: "mirror" });
          toast.success("Changes saved + mirrored to Cost Entry as BUY");
        } else {
          toast.success("Invoice line updated");
        }
      }
      setLineModal(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleDelete = async id => {
    try {
      await api.costLines.remove(shipment.id, id);
      toast.success("Invoice line removed");
      setConfirm(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handleActualize = async data => {
    try {
      await api.costLines.actualize(shipment.id, actualizeLine.id, data);
      toast.success("Invoice line actualized");
      setActualizeLine(null);
      load();
    } catch (e) { toast.error(e.message); }
  };

  const handlePost = async () => {
    const line = confirmPost;
    setConfirmPost(null);
    try {
      await api.costLines.post(shipment.id, line.id);
      toast.success("Invoice line posted — now locked");
      load();
    } catch (e) { toast.error(e.message); }
  };

  const th = { fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".07em" };

  return (
    <div id="shpacct-invoices-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Invoice lines — the charge lines an invoice is generated from */}
      <div id="shpacct-invoices-toolbar" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            {sellLines.length} line{sellLines.length !== 1 ? "s" : ""}
          </span>
          <span id="shpacct-invoices-total-sell" style={{ fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>
            Total Sell: {fmtUsd(totalSell)}
          </span>
          {hasVat && (
            <span style={{ fontFamily: T.mono, fontSize: 13, color: T.textMuted }}>
              VAT: {fmtUsd(totalVat)} · Incl. VAT: {fmtUsd(totalSell + totalVat)}
            </span>
          )}
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn id="shpacct-invoices-split-btn" size="sm" variant="secondary" disabled={!canSplit}
              title={!canSplit ? "No shipment-level lines to split — either none exist or all are already container-tagged" : undefined}
              onClick={() => setSplitConfirm(true)}>
              ◫ Split per Container
            </Btn>
            <Btn id="shpacct-invoices-history-btn" size="sm" variant="secondary" onClick={() => setHistOpen(true)}>⏱ History</Btn>
            <Btn id="shpacct-invoices-add-btn" size="sm" onClick={() => setLineModal("add")}>＋ Add Line</Btn>
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted, marginBottom: 22 }}>Loading…</div>
      ) : sellLines.length === 0 ? (
        <div id="shpacct-invoices-lines-empty" style={{ padding: 48, textAlign: "center", fontFamily: T.body,
          fontSize: 13, color: T.textMuted, fontStyle: "italic", marginBottom: 22,
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          No invoice lines yet.
        </div>
      ) : (
        <div id="shpacct-invoices-lines-table" style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface, marginBottom: 22 }}>
          <div style={{ display: "flex", alignItems: "center", padding: "7px 16px",
            borderBottom: `1px solid ${T.border}`, background: T.bg }}>
            <div style={{ ...th, width: 60 }}>Type</div>
            <div style={{ ...th, flex: 1 }}>Charge</div>
            <div style={{ ...th, width: 100, paddingLeft: 4 }}>Container</div>
            <div style={{ ...th, width: 160, paddingLeft: 4 }}>Source</div>
            <div style={{ ...th, width: 80 }}>Currency</div>
            <div style={{ ...th, width: 100, textAlign: "right" }}>Exch. Rate</div>
            <div style={{ ...th, width: 110, textAlign: "right" }}>Amount (USD)</div>
            <div style={{ ...th, width: 100, paddingLeft: 8 }}>Status</div>
            <div style={{ width: 36 }} />
          </div>
          {sellLines.map(l => (
            <CostLineRow key={l.id} line={l} containers={ctrs} showActions
              onEdit={() => setLineModal(l)} onDelete={() => setConfirm(l.id)}
              onActualize={() => setActualizeLine(l)} onPost={() => setConfirmPost(l)} />
          ))}
        </div>
      )}

      {/* Invoices — generated FR01/FR02 documents, one consolidated or one per container.
          Generation is disabled entirely while there are no charge lines above. */}
      <div id="shpacct-invoices-docs-header" style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8, display: "flex",
        alignItems: "center", justifyContent: "space-between" }}>
        <span>Invoices</span>
        {canEdit && (
          <div style={{ display: "flex", gap: 8, textTransform: "none", letterSpacing: 0 }}>
            <Btn id="shpacct-invoices-generate-btn" size="sm" variant="secondary" disabled={genBusy || loading || !hasChargeLines}
              title={!hasChargeLines ? "Add at least one charge line first" : undefined}
              onClick={() => handleGenerate(false)}>
              🧾 Generate Invoice
            </Btn>
            <Btn id="shpacct-invoices-generate-percontainer-btn" size="sm" variant="secondary" disabled={genBusy || loading || !hasChargeLines || ctrs.length === 0}
              title={!hasChargeLines ? "Add at least one charge line first" : undefined}
              onClick={() => handleGenerate(true)}>
              📦 Generate Per-Container Invoices
            </Btn>
          </div>
        )}
      </div>
      {docsLoading ? (
        <div style={{ padding: 24, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
      ) : docs.length === 0 ? (
        <div id="shpacct-invoices-docs-empty" style={{ padding: 32, textAlign: "center", fontFamily: T.body,
          fontSize: 13, color: T.textMuted, fontStyle: "italic",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          No invoices generated yet.
        </div>
      ) : (
        <div id="shpacct-invoices-docs-table" style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface }}>
          <div style={{ display: "flex", alignItems: "center", padding: "7px 16px",
            borderBottom: `1px solid ${T.border}`, background: T.bg }}>
            <div style={{ ...th, width: 60 }}>Type</div>
            <div style={{ ...th, flex: 1 }}>Invoice</div>
            <div style={{ ...th, width: 110 }}>Status</div>
            <div style={{ ...th, width: 100 }}>Created</div>
            <div style={{ ...th, flex: 1 }}>Responsible Party</div>
            <div style={{ width: 130 }} />
          </div>
          {docs.map(doc => (
            <div key={doc.id} id={`shpacct-invoices-doc-${doc.id}`}
              onDoubleClick={() => setPreviewDoc(doc)}
              style={{ display: "flex", alignItems: "center", padding: "9px 16px",
                borderBottom: `1px solid ${T.border}22`, cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
              <div style={{ width: 60 }}>
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.accent,
                  background: T.accent + "18", border: `1px solid ${T.accent}44`,
                  borderRadius: 6, padding: "2px 6px" }}>{doc.docType}</span>
              </div>
              <div style={{ flex: 1, fontFamily: T.body, fontSize: 13, color: T.text }}>{invoiceLabel(doc)}</div>
              <div style={{ width: 110 }}>{statusPill(doc)}</div>
              <div style={{ width: 100, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{fmtDate(doc.createdAt)}</div>
              <div style={{ flex: 1, fontFamily: T.body, fontSize: 12, color: doc.responsibleParty ? T.text : T.border }}>
                {doc.responsibleParty || "—"}
              </div>
              <div style={{ width: 130, textAlign: "right" }}>
                <Btn size="sm" variant="secondary" onClick={() => setPreviewDoc(doc)}>👁 Preview Invoice</Btn>
              </div>
            </div>
          ))}
        </div>
      )}

      {lineModal && (
        <Modal title={lineModal === "add" ? "Add Invoice Line" : "Edit Invoice Line"} onClose={() => setLineModal(null)}>
          <CostLineForm init={lineModal === "add" ? {} : lineModal} fxRates={fxRates} containers={ctrs} lockType="SELL"
            onSave={data => handleSave(data, false)}
            onSaveAndMirror={data => handleSave(data, true)}
            onCancel={() => setLineModal(null)} />
        </Modal>
      )}

      {histOpen && <CostLineHistoryModal shipmentId={shipment.id} onClose={() => setHistOpen(false)} />}

      {splitConfirm && (
        <Modal title="Split per Container" onClose={() => !splitBusy && setSplitConfirm(false)} width={440}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
              Split {untaggedSellLines.length} shipment-level line{untaggedSellLines.length !== 1 ? "s" : ""} evenly
              across {ctrs.length} container{ctrs.length !== 1 ? "s" : ""}. Each line's amount is divided across the
              containers and replaced with one line per container — the original line{untaggedSellLines.length !== 1 ? "s are" : " is"} removed.
              Lines already tagged to a container are left untouched.
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn variant="secondary" onClick={() => setSplitConfirm(false)} disabled={splitBusy}>Cancel</Btn>
              <Btn onClick={handleSplitPerContainer} disabled={splitBusy}>{splitBusy ? "Splitting…" : "Split"}</Btn>
            </div>
          </div>
        </Modal>
      )}

      {currencyModal && (
        <Modal title="Multiple Currencies" onClose={() => !genBusy && setCurrencyModal(null)} width={460}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, lineHeight: 1.5 }}>
              These charge lines are in multiple currencies ({currencyModal.distinctCurrencies.join(", ")}).
              {currencyModal.isFallback ? (
                <> No currency is configured on this shipment's Principal — the grand total will default
                  to <strong style={{ color: T.text }}>{currencyModal.currency}</strong>. Set a Principal
                  (with a currency on their customer profile) on Parties &amp; Offices to change this.</>
              ) : (
                <> The grand total will be converted to and shown
                  in <strong style={{ color: T.text }}>{currencyModal.currency}</strong> —
                  {" "}{currencyModal.principalName || "the Principal"}'s configured currency on their customer profile.</>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn variant="secondary" onClick={() => setCurrencyModal(null)} disabled={genBusy}>Cancel</Btn>
              <Btn onClick={async () => {
                const { splitPerContainer, currency } = currencyModal;
                setCurrencyModal(null);
                await runGenerate(splitPerContainer, currency);
              }} disabled={genBusy}>{genBusy ? "Generating…" : "Continue"}</Btn>
            </div>
          </div>
        </Modal>
      )}

      {actualizeLine && (
        <CostLineActualizeModal line={actualizeLine} onClose={() => setActualizeLine(null)} onSave={handleActualize} />
      )}

      {confirmPost && (
        <ConfirmModal
          message={`Post this ${confirmPost.chargeCode} line? Posted lines are locked — any correction after this needs a new adjusting line, not an edit.`}
          onConfirm={handlePost}
          onCancel={() => setConfirmPost(null)} />
      )}

      {confirm && (
        <ConfirmModal
          message="Remove this invoice line?"
          onConfirm={() => handleDelete(confirm)}
          onCancel={() => setConfirm(null)} />
      )}

      {previewDoc && (
        <TrackedDocPreviewModal
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
          onConfirm={canEdit ? () => handleConfirmDoc(previewDoc.id) : null}
        />
      )}
    </div>
  );
};

export default ShipmentAccountingInvoicesPage;
