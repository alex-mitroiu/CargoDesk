import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY } from "../../pages/shipments/shipmentDetailTheme";
import { CATEGORIES, SIDES, sideOfCode, lineSplit, billedPartyOf, dcsaPaymentTerms, defaultCategories } from "../../utils/paymentTerms";

// ─── The office split on the Carrier Booking (2026-11-14, mockup 1cb7bdf6 v2, lib/payment-terms.js, ARCHITECTURE.md §8.52) ──
// PaymentTermsCard: the carrier payment terms (CPI) per charge category, each Prepaid or Collect with a responsible office
// from the shipment's offices and the party it bills; what goes to the carrier in the booking request. The OCC/BK of the
// export side changes them (admins and operators too); the Incoterm sets the defaults. CostsAndChargesModal: every cost and
// charge line with its side, category, office (its category's unless changed) and billed party, before the booking goes.

// Export office = cyan, import = violet, billing = amber, others muted, everywhere the split shows.
export const officeColor = key => (key === "export" ? HZ.cyan : key === "import" ? HZ.violet : key === "billing" ? HZ.amber : HZ.textMuted);
const termLabel = t => (t === "PRE" ? "Prepaid" : "Collect");
const money = (n, cur) => `${cur} ${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const usd = n => `USD ${Math.round(n).toLocaleString("en-US")}`;

// The shipment as the rules read it, with the terms being edited.
export const splitShipment = (shipment, view, categories) => ({
  ...shipment,
  paymentTerms: { followsIncoterm: false, categories },
  sideOfficeIds: (view?.offices || []).filter(o => o.key.startsWith("office:")).map(o => o.key.slice(7)),
});

const eyebrow = () => ({ fontFamily: HZ_BODY, fontSize: 10.5, color: HZ.textMuted, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em" });
const cell = () => ({ padding: "8px 10px", borderBottom: `1px solid ${HZ.border}`, fontFamily: HZ_BODY, fontSize: 13, color: HZ.text, verticalAlign: "middle" });
const head = () => ({ ...cell(), fontSize: 10.5, fontWeight: 700, color: HZ.textFaint, textTransform: "uppercase", letterSpacing: ".07em", textAlign: "left" });
const select = () => ({ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text, background: HZ.surfaceSolid, border: `1px solid ${HZ.borderStrong}`,
  borderRadius: 7, padding: "4px 6px", maxWidth: "100%" });
const chip = key => ({ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: HZ_BODY, fontSize: 11.5, fontWeight: 600, borderRadius: 999,
  padding: "2px 9px", color: officeColor(key), background: `${officeColor(key)}1f`, whiteSpace: "nowrap" });

function TermToggle({ id, value, onChange, disabled }) {
  return (
    <span role="group" aria-label={id} style={{ display: "inline-flex", border: `1px solid ${HZ.borderStrong}`, borderRadius: 8, overflow: "hidden" }}>
      {["PRE", "COL"].map(t => (
        <button key={t} type="button" id={`${id}-${t}`} data-testid={`${id}-${t}`} aria-pressed={value === t} disabled={disabled}
          onClick={() => value !== t && onChange(t)}
          style={{ fontFamily: HZ_BODY, fontSize: 11.5, fontWeight: 600, border: 0, padding: "4px 10px", cursor: disabled ? "default" : "pointer",
            background: value === t ? HZ.text : "transparent", color: value === t ? HZ.surfaceSolid : HZ.textMuted }}>{termLabel(t)}</button>
      ))}
    </span>
  );
}

const OfficeSelect = ({ id, offices, value, onChange, disabled, inherit }) => (
  <select id={id} data-testid={id} value={value} disabled={disabled} onChange={e => onChange(e.target.value)} style={select()}>
    {inherit && <option value="">{inherit}</option>}
    {offices.map(o => <option key={o.key} value={o.key}>{o.label.replace(" office", "")} · {o.code || "—"}</option>)}
  </select>
);

export function PaymentTermsCard({ shipment, onSaved }) {
  const [view, setView] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showLines, setShowLines] = useState(false);
  const load = useCallback(() => api.paymentTerms.get(shipment.id).then(v => {
    setView(v);
    setDraft(Object.fromEntries(v.categories.map(c => [c.id, { term: c.term, office: c.office }])));
  }).catch(e => toast.error(e.message)), [shipment.id]);
  useEffect(() => { load(); }, [load, shipment.incoterm, shipment.freightTerms, shipment.billingOfficeId, shipment.emoOfficeId, shipment.imoOfficeId]);

  const s = useMemo(() => (view && draft ? splitShipment(shipment, view, draft) : null), [shipment, view, draft]);
  if (!view || !draft) return null;
  const canEdit = !!view.canEdit;
  const dirty = view.categories.some(c => draft[c.id].term !== c.term || draft[c.id].office !== c.office);
  const officeByKey = k => view.offices.find(o => o.key === k);
  const freightOffice = officeByKey(draft.freight.office);
  const payload = dcsaPaymentTerms({ categories: draft }, { freightPayableAt: freightOffice?.unlocode || "" });
  const defaults = defaultCategories(shipment.incoterm);
  const followsDefaults = CATEGORIES.every(c => draft[c.id].term === defaults[c.id].term && draft[c.id].office === defaults[c.id].office);

  const setTerm = (id, term) => setDraft(d => ({ ...d, [id]: { term,
    // The office follows the term unless a billing or additional office was picked for it.
    office: ["export", "import"].includes(d[id].office) ? (term === "PRE" ? "export" : "import") : d[id].office } }));
  const save = async body => {
    setBusy(true);
    try {
      const v = await api.paymentTerms.save(shipment.id, body);
      toast.success(body.reset ? "Payment terms follow the Incoterm again" : "Payment terms saved");
      await load();
      onSaved?.(v);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  let stage = "";
  return (
    <div data-testid="payment-terms-card" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.7fr) minmax(0, 1fr)", gap: 14, marginBottom: 24 }}>
      <div style={{ background: HZ.surface, backdropFilter: HZ.cardBlur, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10, padding: "16px 18px", display: "grid", gap: 12, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={eyebrow()}>Agreed with the carrier in the booking</div>
            <div style={{ fontFamily: HZ_DISPLAY, fontSize: 16, fontWeight: 700, color: HZ.text }}>Payment terms (CPI)</div>
          </div>
          <span data-testid="payment-terms-status" style={{ fontFamily: HZ_BODY, fontSize: 11.5, fontWeight: 600, borderRadius: 999, padding: "2px 10px",
            color: view.saved ? HZ.good : HZ.warn, background: view.saved ? HZ.goodBg : HZ.warnBg }}>
            {!view.saved ? `Not saved yet · the ${shipment.incoterm || "default"} defaults` : view.followsIncoterm ? `Follows the Incoterm ${shipment.incoterm || ""}` : "Set by hand"}
          </span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 560 }}>
            <thead><tr><th style={head()}>Charge category</th><th style={head()}>Prepaid / Collect</th><th style={head()}>Responsible office</th><th style={head()}>Billed to</th></tr></thead>
            <tbody>
              {CATEGORIES.flatMap(c => {
                const rows = [];
                if (c.side !== stage) { stage = c.side; rows.push(<tr key={`g-${c.side}`}><td colSpan={4} style={{ ...cell(), ...eyebrow(), fontSize: 10, background: HZ.tint || "transparent", padding: "5px 10px" }}>{c.side}</td></tr>); }
                const party = billedPartyOf(s, draft[c.id].term);
                rows.push(
                  <tr key={c.id} data-testid={`cpi-row-${c.id}`}>
                    <td style={{ ...cell(), fontWeight: 600 }}>{c.label}</td>
                    <td style={cell()}><TermToggle id={`cpi-${c.id}`} value={draft[c.id].term} disabled={!canEdit || busy} onChange={t => setTerm(c.id, t)} /></td>
                    <td style={cell()}><OfficeSelect id={`cpi-office-${c.id}`} offices={view.offices} value={draft[c.id].office} disabled={!canEdit || busy}
                      onChange={k => setDraft(d => ({ ...d, [c.id]: { ...d[c.id], office: k } }))} /></td>
                    <td style={cell()}>
                      <div>{party.name || "—"}</div>
                      <div style={{ fontSize: 11.5, color: HZ.textMuted }}>{party.role === "Principal" ? "the principal" : party.role === "Shipper" ? "the shipper" : "the consignee"}</div>
                    </td>
                  </tr>);
                return rows;
              })}
            </tbody>
          </table>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, maxWidth: 420 }}>
            {view.billingOfficeId
              ? <>The billing office <b style={{ color: HZ.amber }}>{officeByKey("billing")?.code}</b> issues every invoice; each line counts for its responsible office.</>
              : "Each responsible office invoices its own charges."}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn size="sm" variant="secondary" data-testid="payment-terms-lines" onClick={() => setShowLines(true)}>Costs and charges</Btn>
            {canEdit && view.saved && !view.followsIncoterm && !dirty && (
              <Btn size="sm" variant="secondary" data-testid="payment-terms-reset" disabled={busy} onClick={() => save({ reset: true })}>Reset to the Incoterm's defaults</Btn>
            )}
            {canEdit && (dirty || !view.saved) && (
              <Btn size="sm" data-testid="payment-terms-save" disabled={busy}
                onClick={() => save(followsDefaults ? { reset: true } : { categories: draft })}>{busy ? "Saving…" : "Save payment terms"}</Btn>
            )}
          </div>
        </div>
      </div>
      <div style={{ background: HZ.surface, backdropFilter: HZ.cardBlur, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10, padding: "16px 18px", display: "grid", gap: 10, alignContent: "start", minWidth: 0 }}>
        <div style={eyebrow()}>Sent to the carrier · DCSA Booking 2.0</div>
        <div style={{ fontFamily: HZ_DISPLAY, fontSize: 15, fontWeight: 700, color: HZ.text }}>In the booking request</div>
        <pre data-testid="payment-terms-dcsa" style={{ margin: 0, fontFamily: HZ_MONO, fontSize: 11.5, lineHeight: 1.55, color: HZ.text, background: HZ.tint || HZ.bg,
          border: `1px solid ${HZ.border}`, borderRadius: 8, padding: "10px 12px", overflowX: "auto" }}>{JSON.stringify(payload, null, 2)}</pre>
        <div style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted }}>
          {view.saved ? "Sent with the next booking request or update." : "Saved and sent with the booking request; from then on the shipment's money is split between its offices."}
        </div>
      </div>
      {showLines && (
        <CostsAndChargesModal shipment={shipment} view={view} categories={draft} categoriesDirty={dirty || !view.saved} canEdit={canEdit}
          onClose={() => setShowLines(false)} onSaved={async v => { setShowLines(false); await load(); onSaved?.(v); }} />
      )}
    </div>
  );
}

export function CostsAndChargesModal({ shipment, view, categories, categoriesDirty, canEdit, onClose, onSaved }) {
  const [lines, setLines] = useState(null);
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.costLines.list(shipment.id).then(r => setLines(Array.isArray(r) ? r : r?.results || [])).catch(e => toast.error(e.message)); }, [shipment.id]);
  const s = useMemo(() => splitShipment(shipment, view, categories), [shipment, view, categories]);
  const withEdit = l => ({ ...l, ...(edits[l.id] || {}) });
  const rows = (lines || []).map(l => ({ line: withEdit(l), split: lineSplit(s, withEdit(l)) }));
  const officeByKey = k => view.offices.find(o => o.key === k);
  const per = {};
  for (const r of rows) {
    const k = r.split.officeKey;
    per[k] = per[k] || { sell: 0, buy: 0, n: 0 };
    per[k].n++;
    per[k][r.line.type === "SELL" ? "sell" : "buy"] += Number(r.line.amountUsd ?? r.line.amount * (r.line.exchangeRate || 1));
  }
  const setLine = (id, patch) => setEdits(e => ({ ...e, [id]: { ...(e[id] || {}), ...patch } }));
  const changed = Object.keys(edits).length > 0;
  const save = async () => {
    setBusy(true);
    try {
      const body = { lines: Object.fromEntries(Object.entries(edits).map(([id, e]) => [id, e])) };
      if (categoriesDirty) body.categories = categories;
      const v = await api.paymentTerms.save(shipment.id, body);
      toast.success("Offices saved");
      onSaved?.(v);
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal title="Costs and charges" onClose={() => !busy && onClose()} width={1080} data-testid="costs-charges-modal">
      <div style={{ display: "grid", gap: 12 }}>
        <div style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted, maxWidth: 760 }}>
          Every line belongs to its category's office unless it is changed here. A charge is billed to the party its category's term names.
          {categoriesDirty && <b style={{ color: HZ.warn }}> {view.saved ? "The payment terms changed above are saved with these lines." : "Saving also saves the payment terms above as they stand: the shipment is split between its offices from then on."}</b>}
        </div>
        <div style={{ overflowX: "auto" }}>
          {!lines ? <div style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted, padding: 12 }}>Loading the lines…</div>
            : !lines.length ? <div data-testid="costs-charges-empty" style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted, padding: 12 }}>No costs or charges on this shipment yet. Add them on Accounting → Cost Entry; each will follow its category's office.</div>
            : (
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                <thead><tr>{["Type", "Charge", "Side", "Category", "Responsible office", "Billed to", "Amount"].map(h => <th key={h} style={{ ...head(), ...(h === "Amount" ? { textAlign: "right" } : {}) }}>{h}</th>)}</tr></thead>
                <tbody>
                  {rows.map(({ line, split }) => {
                    const fixed = sideOfCode(line.chargeCode);
                    const cat = CATEGORIES.find(c => c.id === split.category);
                    const own = line.responsibleOffice && !split.followsCategory;
                    // Issued or posted: its side and office stay as billed or posted (the server refuses a change).
                    const held = line.billedOn && (line.billedOn.kind === "invoice" ? line.billedOn.status === "confirmed" : line.billedOn.status !== "draft");
                    const frozen = line.status === "posted" ? "posted" : line.type === "SELL" && held ? "issued" : null;
                    return (
                      <tr key={line.id} data-testid={`costs-line-${line.id}`}>
                        <td style={cell()}><span style={{ fontFamily: HZ_MONO, fontSize: 11, fontWeight: 600, color: HZ.textMuted }}>{line.type}</span></td>
                        <td style={cell()}><div style={{ fontWeight: 600 }}>{line.chargeCode}</div>{line.notes && <div style={{ fontSize: 11.5, color: HZ.textMuted }}>{line.notes}</div>}</td>
                        <td style={cell()}>{fixed ? <span style={{ fontSize: 12, color: HZ.textMuted }}>{fixed}</span> : (
                          <select id={`costs-side-${line.id}`} data-testid={`costs-side-${line.id}`} disabled={!canEdit || busy || !!frozen} value={split.side} style={select()}
                            onChange={e => setLine(line.id, { chargeSide: e.target.value })}>
                            {SIDES.map(x => <option key={x}>{x}</option>)}
                          </select>)}</td>
                        <td style={cell()}>{cat?.label}<span style={{ fontSize: 11.5, color: HZ.textMuted }}> · {termLabel(split.term)}</span></td>
                        <td style={cell()}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                            <OfficeSelect id={`costs-office-${line.id}`} offices={view.offices} value={own ? line.responsibleOffice : ""} disabled={!canEdit || busy || !!frozen}
                              inherit={`Its category's · ${officeByKey(categories[split.category].office)?.code || "—"}`}
                              onChange={k => setLine(line.id, { responsibleOffice: k })} />
                            <span data-testid={`costs-office-state-${line.id}`} style={{ fontSize: 10.5, fontWeight: 600, color: own ? HZ.warn : HZ.textFaint }}
                              title={frozen ? `This ${line.type === "SELL" ? "charge" : "cost"} is ${frozen}: its side and office stay as they were` : undefined}>
                              {frozen || (own ? "changed" : "from the category")}</span>
                          </div>
                        </td>
                        <td style={cell()}>{line.type === "SELL" ? (split.billTo.name || "—") : <span style={{ fontSize: 12, color: HZ.textMuted }}>paid by its office</span>}</td>
                        <td style={{ ...cell(), textAlign: "right", fontFamily: HZ_MONO, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{money(line.amount, line.currency)}</td>
                      </tr>);
                  })}
                </tbody>
              </table>)}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "space-between", alignItems: "center" }}>
          <div data-testid="costs-office-totals" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(per).map(([k, f]) => (
              <span key={k} style={chip(k)}>{officeByKey(k)?.label.replace(" office", "") || "Office"} · {f.n} line{f.n === 1 ? "" : "s"} · GP {f.sell - f.buy < 0 ? "−" : ""}{usd(Math.abs(f.sell - f.buy))}</span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="secondary" size="sm" onClick={onClose} disabled={busy}>Close</Btn>
            {canEdit && <Btn size="sm" data-testid="costs-save" disabled={busy || (!changed && !categoriesDirty)} onClick={save}>{busy ? "Saving…" : "Save offices"}</Btn>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
