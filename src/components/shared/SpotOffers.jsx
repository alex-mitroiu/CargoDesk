import { useEffect, useMemo, useState } from "react";
import { T, CURRENCIES } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import { Modal } from "../primitives/Modal";
import { HZ, HZ_MONO, HZ_BODY } from "../../pages/shipments/shipmentDetailTheme";

// SPOT rates (plan https://claude.ai/artifact/Y61PAmXZfgFxTLtpt7GiAZ; approved mockup
// https://claude.ai/artifact/5DYk7qXZLEUn51zJUQpZYK, 2026-10-21). A carrier's spot offer — its
// reference, charges, validity and penalty terms — attached to a shipment (SpotOfferCard on the
// Schedules page) or a quote (QuoteSpotOffer). The rules are the server's (lib/spot-offers.js); these
// components show them and call the routes in routes/spot-offers.js.

const AMBER = "#fbc531";
export const fmtMoney = (n, cur = "USD") =>
  `${cur} ${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDay = d => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
// A date-only validity runs to the end of that day (UTC); a timestamp to that instant — as the server.
export const fmtValidUntil = v => {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtDay(v);
  const d = new Date(v);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}, ${d.toISOString().slice(11, 16)} UTC`;
};
const validityNote = offer => {
  if (offer.expired) return offer.kind === "digital" ? "expired: can't be booked" : "expired: check the carrier still honours it";
  const end = /^\d{4}-\d{2}-\d{2}$/.test(offer.validUntil) ? Date.parse(`${offer.validUntil}T23:59:59Z`) : Date.parse(offer.validUntil);
  const hours = (end - Date.now()) / 36e5;
  if (hours < 48) return `in ${Math.max(1, Math.round(hours))} hour${Math.round(hours) === 1 ? "" : "s"}`;
  return `in ${Math.round(hours / 24)} days`;
};
export const KIND_LABEL = { classic: "Classic quote", digital: "Digital spot" };
const SOURCE_LABEL = { manual: "Typed in", demo: "Demo carrier", api: "From the carrier" };
const BASIS_LABEL = { per_container: "per container", per_bl: "per B/L" };

// Containers per type ("40HC") from a shipment's containers, for the offer's equipment.
export const equipmentOfContainers = containers => {
  const by = {};
  for (const c of containers || []) {
    const t = `${c.size || ""}${c.type || ""}`.toUpperCase();
    if (/^\d{2}[A-Z0-9]{2}$/.test(t)) by[t] = (by[t] || 0) + 1;
  }
  return Object.entries(by).map(([containerType, quantity]) => ({ containerType, quantity }));
};
// Containers per type from a quote's lines: the most any line names for a type (several lines price
// the same boxes), as the quote's conversion counts them.
export const equipmentOfQuoteLines = lines => {
  const by = {};
  for (const l of lines || []) {
    const t = String(l.containerType || "").toUpperCase(), q = Math.round(Number(l.quantity) || 0);
    if (/^\d{2}[A-Z0-9]{2}$/.test(t) && q > 0) by[t] = Math.max(by[t] || 0, q);
  }
  return Object.entries(by).map(([containerType, quantity]) => ({ containerType, quantity }));
};
const equipmentText = eq => (eq || []).map(e => `${e.quantity} × ${e.containerType}`).join(", ");

const chipStyle = (color, bg) => ({ fontFamily: HZ_MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: ".04em", color, background: bg, borderRadius: 4, padding: "2px 9px", whiteSpace: "nowrap" });
const hzLabel = { fontFamily: HZ_BODY, fontSize: 10.5, fontWeight: 600, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: ".08em" };

// ─── On the shipment (Schedules page, under the contract) ───────────────────────────────────────
// `locked` = the carrier already holds the booking (Pending/Confirmed): the offer can't change.
export const SpotOfferCard = ({ offer, carrierCode, locked, lockedText, canEdit, onAdd, onRemove }) => {
  if (!offer) {
    return (
      <div data-testid="spot-offer-empty" style={{ border: `1px dashed ${HZ.borderStrong}`, borderRadius: 10, padding: "20px 22px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 18 }}>
        <div style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: 6, fontFamily: HZ_BODY }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: HZ.text }}>No spot offer yet</span>
          <span style={{ fontSize: 12.5, color: HZ.textMuted, lineHeight: 1.55 }}>Put {carrierCode || "the carrier"}'s quote here: the booking then carries its quotation reference, and its charges become this shipment's BUY lines.</span>
          <span style={{ fontSize: 12, color: AMBER }}>Without one, the booking goes to {carrierCode || "the carrier"} with no quotation reference.</span>
        </div>
        {canEdit && <>
          <Btn size="sm" onClick={() => onAdd("type")} data-testid="spot-offer-add">＋ Add spot offer</Btn>
          <Btn size="sm" variant="secondary" onClick={() => onAdd("pick")} data-testid="spot-offer-pick">Pick an existing offer</Btn>
        </>}
      </div>
    );
  }
  const blocked = offer.expired && offer.kind === "digital";
  return (
    <div data-testid="spot-offer-card" style={{ border: `1px solid ${HZ.border}`, borderRadius: 10, background: HZ.surface, display: "flex", flexDirection: "column", fontFamily: HZ_BODY, color: HZ.text }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "14px 18px", borderBottom: `1px solid ${HZ.border}` }}>
        <span style={chipStyle("#fff", "#d6322a")}>{offer.carrierCode}</span>
        <span data-testid="spot-offer-ref" style={{ fontFamily: HZ_MONO, fontSize: 15, fontWeight: 700 }}>{offer.offerRef}</span>
        <span style={chipStyle(HZ.text, HZ.surface2)}>{KIND_LABEL[offer.kind] || offer.kind}</span>
        {offer.status === "Booked" && <span data-testid="spot-offer-booked" style={chipStyle(HZ.goodPillText, HZ.goodBg)}>Booked on</span>}
        {offer.expired && <span data-testid="spot-offer-expired" style={chipStyle(blocked ? HZ.crit : AMBER, blocked ? HZ.critBg : `${AMBER}24`)}>Expired</span>}
        <span style={{ flex: 1 }} />
        {canEdit && <>
          <Btn size="sm" variant="secondary" disabled={locked} onClick={() => onAdd("type")} data-testid="spot-offer-replace">Replace offer</Btn>
          <Btn size="sm" variant="ghost" disabled={locked} onClick={onRemove} data-testid="spot-offer-remove">Remove</Btn>
        </>}
      </div>

      {blocked && (
        <div role="alert" data-testid="spot-offer-expired-banner" style={{ margin: "14px 18px 0", padding: "12px 16px", borderRadius: 8, background: HZ.critBg, border: `1px solid ${HZ.crit}55`, display: "flex", flexDirection: "column", gap: 3 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: HZ.crit }}>This digital offer can't be booked any more</span>
          <span style={{ fontSize: 12.5, color: HZ.textMuted, lineHeight: 1.5 }}>It was valid until {fmtValidUntil(offer.validUntil)}. Send Booking Request stays blocked until a fresh offer from {offer.carrierCode} replaces it.</span>
        </div>
      )}
      {locked && lockedText && <div data-testid="spot-offer-locked" style={{ margin: "14px 18px 0", fontSize: 12.5, color: HZ.textMuted }}>{lockedText}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", margin: "14px 18px 0", border: `1px solid ${HZ.border}`, borderRadius: 8 }}>
        {[
          ["Valid until", fmtValidUntil(offer.validUntil), validityNote(offer), offer.expired ? (blocked ? HZ.crit : AMBER) : HZ.textMuted],
          ["Price locks", offer.priceLockLabel || "—", "", HZ.textMuted],
          ["Containers", equipmentText(offer.equipment) || "—", "", HZ.textMuted],
          ["Source", SOURCE_LABEL[offer.source] || offer.source, fmtDay(offer.createdAt), HZ.textMuted],
        ].map(([label, value, note, noteColor], i) => (
          <div key={label} style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4, borderRight: i < 3 ? `1px solid ${HZ.border}` : "none", minWidth: 0 }}>
            <span style={hzLabel}>{label}</span>
            <span style={{ fontFamily: HZ_MONO, fontSize: 13, fontWeight: 700 }}>{value}</span>
            {note && <span style={{ fontSize: 11.5, color: noteColor }}>{note}</span>}
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 32, padding: "16px 18px 2px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 11.5, color: HZ.textMuted }}>Offered price</span>
          <span data-testid="spot-offer-total" style={{ fontFamily: HZ_MONO, fontSize: 21, fontWeight: 700 }}>{fmtMoney(offer.totalUsd)}</span>
          <span style={{ fontSize: 11.5, color: HZ.textMuted }}>charges in the price</span>
        </div>
        {offer.subjectToUsd > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 11.5, color: HZ.textMuted }}>Subject to, at shipment</span>
            <span data-testid="spot-offer-subject" style={{ fontFamily: HZ_MONO, fontSize: 21, fontWeight: 700, color: AMBER }}>{fmtMoney(offer.subjectToUsd)}</span>
            <span style={{ fontSize: 11.5, color: HZ.textMuted }}>at its level on the shipment date</span>
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontSize: 11.5, color: HZ.textMuted }}>On the BUY side</span>
          <span style={{ fontFamily: HZ_MONO, fontSize: 21, fontWeight: 700 }}>{offer.lines.filter(l => l.amount > 0).length} cost lines</span>
          <span style={{ fontSize: 11.5, color: HZ.textMuted }}>see Accounting</span>
        </div>
      </div>

      <div style={{ margin: "12px 18px 0", overflowX: "auto", border: `1px solid ${HZ.border}`, borderRadius: 8 }}>
        <table style={{ width: "100%", minWidth: 820, borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ background: HZ.bg, textAlign: "left" }}>
              {["Code", "Charge", "Basis", "Qty", "Unit price", "Amount", "USD", "Terms", "Price"].map((h, i) => (
                <th key={h} scope="col" style={{ ...hzLabel, padding: "9px 12px", textAlign: [3, 4, 5, 6].includes(i) ? "right" : "left" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {offer.lines.map(l => (
              <tr key={l.id} data-testid={`spot-offer-line-${l.serviceCode.toLowerCase()}`} style={{ borderTop: `1px solid ${HZ.border}` }}>
                <td style={{ padding: "8px 12px", fontFamily: HZ_MONO, fontWeight: 700 }}>{l.serviceCode}</td>
                <td style={{ padding: "8px 12px" }}>{l.description || l.chargeCode}</td>
                <td style={{ padding: "8px 12px", fontFamily: HZ_MONO, color: HZ.textMuted }}>{l.basis === "per_bl" ? "per B/L" : `per ${l.containerType || "container"}`}</td>
                <td style={{ padding: "8px 12px", fontFamily: HZ_MONO, textAlign: "right" }}>{l.quantity}</td>
                <td style={{ padding: "8px 12px", fontFamily: HZ_MONO, textAlign: "right" }}>{Number(l.unitPrice).toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
                <td style={{ padding: "8px 12px", fontFamily: HZ_MONO, textAlign: "right" }}>{fmtMoney(l.amount, l.currency)}</td>
                <td style={{ padding: "8px 12px", fontFamily: HZ_MONO, textAlign: "right", fontWeight: 700 }}>{Number(l.amountUsd).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                <td style={{ padding: "8px 12px", fontFamily: HZ_MONO, color: HZ.textMuted }}>{l.paymentTerm}</td>
                <td style={{ padding: "8px 12px" }}>{l.included ? <span style={chipStyle(HZ.textMuted, HZ.surface2)}>In price</span> : <span style={chipStyle(AMBER, `${AMBER}24`)}>Subject to</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <PenaltyTerms penalties={offer.penalties} />
    </div>
  );
};

const PenaltyTerms = ({ penalties: p }) => {
  if (!p) return null;
  const per = p.basis === "per_bl" ? "per B/L" : "per container";
  const money = v => <b style={{ fontFamily: HZ_MONO, color: HZ.text }}>{fmtMoney(v, p.currency).replace(".00", "")}</b>;
  const items = [
    p.cancellationFee != null && <span key="c">Cancellation {money(p.cancellationFee)} {per}{p.cancellationNoticeDays != null ? `, from ${p.cancellationNoticeDays} days before ETD` : ""}</span>,
    p.noShowFee != null && <span key="n">No-show {money(p.noShowFee)} {per}{p.cancellationNoticeDays != null ? `, inside ${p.cancellationNoticeDays} days` : ""}</span>,
    p.amendmentFee != null && <span key="a">Amendment {money(p.amendmentFee)} {per}</span>,
    <span key="r">Roll compensation {p.rollCompensation != null ? money(p.rollCompensation) : <b style={{ fontFamily: HZ_MONO, color: HZ.text }}>none</b>}</span>,
  ].filter(Boolean);
  return (
    <div data-testid="spot-offer-penalties" style={{ display: "flex", flexWrap: "wrap", gap: "8px 26px", padding: "12px 18px 16px", fontSize: 12.5, color: HZ.textMuted }}>
      <span style={{ ...hzLabel, alignSelf: "center" }}>Penalty terms</span>
      {items}
    </div>
  );
};

// ─── Add spot offer: type it in, or pick one already entered ────────────────────────────────────
// ctx: { carrierCode, pol, pod, equipment } — fixed by the shipment; a quote passes what it has, and
// whatever's missing (carrier, containers) is typed here. onAttach(offer) → Promise; a rejection keeps
// the dialog open with the reason (the offer itself stays saved, free to pick later).
const blankCharge = (containerType = "", quantity = "") =>
  ({ serviceCode: "", description: "", basis: "per_container", containerType, quantity: String(quantity || ""), unitPrice: "", currency: "USD", paymentTerm: "PRE", included: true });

export const AddSpotOfferModal = ({ ctx, targetLabel, initialTab = "type", onClose, onAttach }) => {
  const fixedEquipment = ctx.equipment?.length ? ctx.equipment : null;
  const [tab, setTab] = useState(initialTab);
  const [carrierCode, setCarrierCode] = useState(ctx.carrierCode || "");
  const [equipment, setEquipment] = useState(fixedEquipment || [{ containerType: "40HC", quantity: 1 }]);
  const [offerRef, setOfferRef] = useState("");
  const [kind, setKind] = useState("classic");
  const [validDate, setValidDate] = useState("");
  const [validTime, setValidTime] = useState("");
  const [priceLock, setPriceLock] = useState("booking");
  const [charges, setCharges] = useState(() => (fixedEquipment || [{ containerType: "40HC", quantity: 1 }])
    .map(e => ({ ...blankCharge(e.containerType, e.quantity), serviceCode: "OF", description: "Ocean freight" })));
  const [penalties, setPenalties] = useState({ cancellationFee: "", cancellationNoticeDays: "", noShowFee: "", amendmentFee: "", rollCompensation: "" });
  const [notes, setNotes] = useState("");
  const [fx, setFx] = useState({});
  const [pool, setPool] = useState(null);
  const [live, setLive] = useState(null);   // the carrier's offers (phase 2): { available, demo, offers, message }
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { api.fx.rates().then(r => setFx(r?.rates || {})).catch(() => setFx({})); }, []);
  useEffect(() => {
    if (!carrierCode || !ctx.pol || !ctx.pod) { setPool([]); return; }
    let cancelled = false;
    api.spotOffers.list({ carrierCode, pol: ctx.pol, pod: ctx.pod, unattached: 1 })
      .then(rows => !cancelled && setPool(rows || [])).catch(() => !cancelled && setPool([]));
    return () => { cancelled = true; };
  }, [carrierCode, ctx.pol, ctx.pod]);

  const askCarrier = async () => {
    if (!carrierCode || !equipment.length) return;
    setAsking(true); setError("");
    try {
      setLive(await api.spotOffers.fromCarrier({ carrierCode, pol: ctx.pol, pod: ctx.pod,
        equipment: equipment.map(e => `${e.containerType}:${e.quantity}`).join(","), from: ctx.from || "" }));
    } catch (e) { setLive({ available: false, offers: [], message: e.message }); }
    finally { setAsking(false); }
  };
  useEffect(() => { if (tab === "carrier" && live === null && carrierCode) askCarrier(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const takeLive = async o => {
    setError(""); setBusy(true);
    try { const offer = await api.spotOffers.takeFromCarrier(carrierCode, o.offerRef); await attach(offer); }
    catch (e) { setError(e.message || "The offer wasn't taken"); }
    finally { setBusy(false); }
  };

  const toUsd = (amount, cur) => (cur === "USD" || !fx[cur] ? amount : amount / fx[cur]);
  const totals = useMemo(() => {
    let inPrice = 0, subject = 0;
    for (const c of charges) {
      const qty = c.basis === "per_bl" ? 1 : Number(c.quantity) || 0;
      const usd = toUsd((Number(c.unitPrice) || 0) * qty, c.currency);
      if (c.included) inPrice += usd; else subject += usd;
    }
    return { inPrice, subject };
  }, [charges, fx]); // eslint-disable-line react-hooks/exhaustive-deps

  const setCharge = (i, patch) => setCharges(cs => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const validUntil = kind === "digital"
    ? (validDate && validTime ? new Date(`${validDate}T${validTime}`).toISOString() : "")
    : validDate;

  const attach = async offer => {
    try { await onAttach(offer); onClose(); }
    catch (e) { setError(`${e.message || "It wasn't attached"}${offer ? ` (offer ${offer.offerRef} is saved and can be picked later)` : ""}`); }
  };
  const save = async () => {
    setError(""); setBusy(true);
    try {
      const offer = await api.spotOffers.create({
        carrierCode, offerRef, kind, pol: ctx.pol, pod: ctx.pod, equipment, validUntil, priceLock, notes,
        lines: charges.filter(c => c.serviceCode || c.unitPrice).map(c => ({
          serviceCode: c.serviceCode, description: c.description, basis: c.basis, containerType: c.basis === "per_bl" ? "" : c.containerType,
          quantity: c.basis === "per_bl" ? 1 : c.quantity, unitPrice: c.unitPrice, currency: c.currency, paymentTerm: c.paymentTerm, included: c.included,
        })),
        penalties: { ...penalties, currency: "USD", basis: "per_container" },
      });
      await attach(offer);
    } catch (e) { setError(e.message || "The offer wasn't saved"); }
    finally { setBusy(false); }
  };
  const pick = async offer => { setError(""); setBusy(true); try { await attach(offer); } finally { setBusy(false); } };

  const lbl = { display: "flex", flexDirection: "column", gap: 6, fontFamily: T.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".08em", color: T.textMuted, textTransform: "uppercase" };
  const input = { background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", fontFamily: T.body, fontSize: 13, boxSizing: "border-box", width: "100%", letterSpacing: 0, textTransform: "none" };
  const fixedInput = { ...input, color: T.textMuted, fontFamily: T.mono, fontWeight: 600 };
  const cell = { ...input, padding: "6px 7px", fontSize: 12.5 };
  const tabBtn = on => ({ padding: "9px 14px", border: "none", borderBottom: `2px solid ${on ? T.accent : "transparent"}`, background: "transparent", cursor: "pointer",
    fontFamily: T.body, fontSize: 13, fontWeight: 700, color: on ? T.text : T.textMuted });
  const seg = on => ({ flex: 1, padding: "7px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontFamily: T.body, fontSize: 12.5, fontWeight: 600,
    background: on ? T.accent : "transparent", color: on ? "#06111f" : T.textMuted });
  const pickable = (pool || []).filter(o => !(o.expired && o.kind === "digital"));

  return (
    <Modal title={`Add spot offer — ${targetLabel}`} onClose={() => !busy && onClose()} width={900} data-testid="add-spot-offer-modal">
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div role="tablist" aria-label="How to add it" style={{ display: "flex", gap: 4, borderBottom: `1px solid ${T.border}` }}>
          <button type="button" role="tab" aria-selected={tab === "type"} onClick={() => setTab("type")} style={tabBtn(tab === "type")} data-testid="spot-tab-type">Type it in</button>
          <button type="button" role="tab" aria-selected={tab === "pick"} onClick={() => setTab("pick")} style={tabBtn(tab === "pick")} data-testid="spot-tab-pick">
            Pick an existing offer{pool ? ` (${pool.length})` : ""}</button>
          <button type="button" role="tab" aria-selected={tab === "carrier"} onClick={() => setTab("carrier")} style={tabBtn(tab === "carrier")} data-testid="spot-tab-carrier"
            disabled={!carrierCode}>Get offers from {carrierCode || "the carrier"}</button>
        </div>

        {tab === "type" && <>
          <div style={{ display: "grid", gridTemplateColumns: "120px minmax(0, 1fr) 260px", gap: 12, alignItems: "end" }}>
            <label style={lbl}>Carrier
              {ctx.carrierCode
                ? <input value={carrierCode} readOnly style={fixedInput} />
                : <input value={carrierCode} onChange={e => setCarrierCode(e.target.value.toUpperCase().slice(0, 4))} placeholder="SCAC" style={{ ...input, fontFamily: T.mono }} data-testid="spot-carrier-input" />}
            </label>
            <label style={lbl}>Offer reference
              <input value={offerRef} onChange={e => setOfferRef(e.target.value.slice(0, 35))} placeholder={kind === "digital" ? "Offer or price id" : "Quotation number"}
                style={{ ...input, fontFamily: T.mono, fontWeight: 600 }} data-testid="spot-ref-input" />
            </label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={lbl}>Kind</span>
              <div role="radiogroup" aria-label="Kind" style={{ display: "flex", padding: 3, gap: 3, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8 }}>
                <button type="button" role="radio" aria-checked={kind === "classic"} onClick={() => { setKind("classic"); setPriceLock(p => p); }} style={seg(kind === "classic")} data-testid="spot-kind-classic">Classic quote</button>
                <button type="button" role="radio" aria-checked={kind === "digital"} onClick={() => { setKind("digital"); setPriceLock("booking"); }} style={seg(kind === "digital")} data-testid="spot-kind-digital">Digital spot</button>
              </div>
            </div>
          </div>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: -8 }}>
            {kind === "digital" ? "The offer or price id from the carrier's spot tool." : "The quotation number on the carrier's quote."} It goes on the booking as the quotation reference (35 characters at most).</span>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12 }}>
            <label style={lbl}>Port of loading<input value={ctx.pol || ""} readOnly style={fixedInput} /></label>
            <label style={lbl}>Port of discharge<input value={ctx.pod || ""} readOnly style={fixedInput} /></label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={lbl}>Containers</span>
              {fixedEquipment
                ? <input value={equipmentText(equipment)} readOnly style={fixedInput} />
                : equipment.map((e, i) => (
                  <div key={i} style={{ display: "flex", gap: 6 }}>
                    <input value={e.quantity} inputMode="numeric" aria-label="Number of containers" onChange={ev => setEquipment(eq => eq.map((x, j) => (j === i ? { ...x, quantity: ev.target.value.replace(/\D/g, "") } : x)))}
                      style={{ ...input, width: 64, fontFamily: T.mono, textAlign: "right" }} data-testid={`spot-equipment-qty-${i}`} />
                    <input value={e.containerType} aria-label="Container type" onChange={ev => setEquipment(eq => eq.map((x, j) => (j === i ? { ...x, containerType: ev.target.value.toUpperCase().slice(0, 4) } : x)))}
                      style={{ ...input, fontFamily: T.mono }} data-testid={`spot-equipment-type-${i}`} />
                  </div>
                ))}
            </div>
          </div>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: -8 }}>
            {fixedEquipment ? `Carrier, route and containers come from the ${targetLabel.startsWith("SHP") ? "shipment" : "quote"}.` : "Route from the quote; give the containers the offer is for."}</span>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={lbl}>Valid until{kind === "digital" ? " (UTC)" : ""}</span>
              <div style={{ display: "flex", gap: 6 }}>
                <input type="date" value={validDate} onChange={e => setValidDate(e.target.value)} style={{ ...input, fontFamily: T.mono }} data-testid="spot-valid-date" aria-label="Valid until date" />
                {kind === "digital" && <input type="time" value={validTime} onChange={e => setValidTime(e.target.value)} style={{ ...input, fontFamily: T.mono, width: 130 }} data-testid="spot-valid-time" aria-label="Valid until time" />}
              </div>
            </div>
            <label style={lbl}>Price locks
              <select value={priceLock} onChange={e => setPriceLock(e.target.value)} style={{ ...input, cursor: "pointer" }} data-testid="spot-price-lock">
                <option value="booking">At booking confirmation</option>
                <option value="gate_in">At gate-in</option>
                <option value="departure">At departure</option>
                <option value="bl_date">At the B/L date</option>
              </select>
            </label>
          </div>
          <span style={{ fontFamily: T.body, fontSize: 12, color: kind === "digital" ? AMBER : T.textMuted, marginTop: -8 }}>
            {kind === "digital" ? "A digital offer can't be attached or booked once it expires: get a fresh one." : "An expired quote only warns: its terms may still hold, so check with the carrier."}</span>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={lbl}>Charges</span>
              <Btn size="sm" variant="secondary" onClick={() => setCharges(cs => [...cs, blankCharge(equipment[0]?.containerType, equipment[0]?.quantity)])} data-testid="spot-add-charge">＋ Add charge</Btn>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "70px minmax(0, 1fr) 118px 70px 48px 84px 66px 58px 96px 22px", gap: 6, padding: "0 8px", fontFamily: T.mono, fontSize: 9.5, fontWeight: 600, color: T.textMuted, letterSpacing: ".06em", textTransform: "uppercase" }}>
              <span>Code</span><span>Charge</span><span>Basis</span><span>Type</span><span>Qty</span><span>Unit price</span><span>Curr.</span><span>Terms</span><span>Price</span><span />
            </div>
            {charges.map((c, i) => (
              <div key={i} data-testid={`spot-charge-row-${i}`} style={{ display: "grid", gridTemplateColumns: "70px minmax(0, 1fr) 118px 70px 48px 84px 66px 58px 96px 22px", gap: 6, alignItems: "center", padding: "7px 8px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6 }}>
                <input value={c.serviceCode} aria-label="Charge code" placeholder="OF" onChange={e => setCharge(i, { serviceCode: e.target.value.toUpperCase().slice(0, 10) })} style={{ ...cell, fontFamily: T.mono, fontWeight: 700 }} data-testid={`spot-charge-code-${i}`} />
                <input value={c.description} aria-label="Charge" placeholder="Description" onChange={e => setCharge(i, { description: e.target.value })} style={cell} data-testid={`spot-charge-desc-${i}`} />
                <select value={c.basis} aria-label="Basis" onChange={e => setCharge(i, { basis: e.target.value })} style={{ ...cell, cursor: "pointer" }} data-testid={`spot-charge-basis-${i}`}>
                  <option value="per_container">{BASIS_LABEL.per_container}</option><option value="per_bl">{BASIS_LABEL.per_bl}</option>
                </select>
                <input value={c.basis === "per_bl" ? "" : c.containerType} disabled={c.basis === "per_bl"} aria-label="Container type" onChange={e => setCharge(i, { containerType: e.target.value.toUpperCase().slice(0, 4) })} style={{ ...cell, fontFamily: T.mono }} />
                <input value={c.basis === "per_bl" ? "1" : c.quantity} disabled={c.basis === "per_bl"} aria-label="Quantity" inputMode="decimal" onChange={e => setCharge(i, { quantity: e.target.value })} style={{ ...cell, fontFamily: T.mono, textAlign: "right" }} data-testid={`spot-charge-qty-${i}`} />
                <input value={c.unitPrice} aria-label="Unit price" inputMode="decimal" placeholder="0.00" onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setCharge(i, { unitPrice: e.target.value }); }} style={{ ...cell, fontFamily: T.mono, textAlign: "right" }} data-testid={`spot-charge-price-${i}`} />
                <select value={c.currency} aria-label="Currency" onChange={e => setCharge(i, { currency: e.target.value })} style={{ ...cell, cursor: "pointer", fontFamily: T.mono }} data-testid={`spot-charge-currency-${i}`}>
                  {CURRENCIES.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
                <select value={c.paymentTerm} aria-label="Payment term" onChange={e => setCharge(i, { paymentTerm: e.target.value })} style={{ ...cell, cursor: "pointer", fontFamily: T.mono }}>
                  <option value="PRE">PRE</option><option value="COL">COL</option>
                </select>
                <button type="button" aria-pressed={!c.included} onClick={() => setCharge(i, { included: !c.included })} data-testid={`spot-charge-included-${i}`}
                  title="In the offered price, or 'subject to' at its level on the shipment date"
                  style={{ padding: "5px 6px", borderRadius: 5, cursor: "pointer", fontFamily: T.body, fontSize: 11.5, fontWeight: 700,
                    border: `1px solid ${c.included ? T.border : `${AMBER}73`}`, background: c.included ? "transparent" : `${AMBER}1f`, color: c.included ? T.textMuted : AMBER }}>
                  {c.included ? "In price" : "Subject to"}</button>
                <button type="button" aria-label="Remove charge" disabled={charges.length === 1} onClick={() => setCharges(cs => cs.filter((_, j) => j !== i))}
                  style={{ background: "none", border: "none", color: T.textMuted, cursor: charges.length === 1 ? "not-allowed" : "pointer", opacity: charges.length === 1 ? 0.3 : 1, padding: 0 }}>×</button>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 28, padding: "4px 8px 0", fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
              <span>In the price <b data-testid="spot-total-in" style={{ fontFamily: T.mono, color: T.text, fontSize: 14 }}>{fmtMoney(totals.inPrice)}</b></span>
              <span>Subject to <b data-testid="spot-total-subject" style={{ fontFamily: T.mono, color: AMBER, fontSize: 14 }}>{fmtMoney(totals.subject)}</b></span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <span style={lbl}>Penalty terms (per container, USD; leave blank if none)</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10 }}>
              {[["cancellationFee", "Cancellation fee"], ["cancellationNoticeDays", "Days before ETD"], ["noShowFee", "No-show fee"], ["amendmentFee", "Amendment fee"], ["rollCompensation", "Roll compensation"]].map(([key, label]) => (
                <label key={key} style={{ display: "flex", flexDirection: "column", gap: 5, fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>{label}
                  <input value={penalties[key]} inputMode="decimal" onChange={e => { if (/^\d*\.?\d*$/.test(e.target.value)) setPenalties(p => ({ ...p, [key]: e.target.value })); }}
                    style={{ ...input, fontFamily: T.mono }} data-testid={`spot-penalty-${key}`} />
                </label>
              ))}
            </div>
          </div>

          <label style={lbl}>Notes<input value={notes} onChange={e => setNotes(e.target.value)} style={input} data-testid="spot-notes" /></label>
        </>}

        {tab === "pick" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>{carrierCode || "The carrier"}'s offers for {ctx.pol} → {ctx.pod} that aren't on a quote or shipment yet.</span>
            {pool === null ? <Spinner /> : pool.length === 0 ? (
              <span data-testid="spot-pool-empty" style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>None yet — type one in.</span>
            ) : pool.map((o, i) => {
              const dead = o.expired && o.kind === "digital";
              return (
                <div key={o.id} data-testid={`spot-pool-row-${i}`} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.3fr) 110px minmax(0, 1fr) 130px 96px", gap: 14, alignItems: "center", padding: "12px 14px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, opacity: dead ? 0.6 : 1 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontFamily: T.mono, fontSize: 13.5, fontWeight: 700, color: T.text }}>{o.offerRef}</span>
                    <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>{SOURCE_LABEL[o.source] || o.source}{o.createdBy ? ` by ${o.createdBy}` : ""} · {fmtDay(o.createdAt)} · {equipmentText(o.equipment)}</span>
                  </div>
                  <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 4, background: T.surface, color: T.textMuted, justifySelf: "start" }}>{KIND_LABEL[o.kind]}</span>
                  <span style={{ fontFamily: T.body, fontSize: 12.5, color: o.expired ? (dead ? T.danger || "#f0526b" : AMBER) : T.textMuted }}>
                    {o.expired ? `expired ${fmtValidUntil(o.validUntil)}${dead ? "" : ": warns"}` : `until ${fmtValidUntil(o.validUntil)}`}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 13.5, fontWeight: 700, color: T.text, textAlign: "right" }}>{fmtMoney(o.totalUsd)}</span>
                  <Btn size="sm" variant={dead ? "secondary" : "primary"} disabled={dead || busy} onClick={() => pick(o)} data-testid={`spot-pool-pick-${i}`}>{dead ? "Expired" : "Pick"}</Btn>
                </div>
              );
            })}
            {pool && pool.length > 0 && pickable.length === 0 && <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Every one of them is an expired digital offer.</span>}
          </div>
        )}

        {tab === "carrier" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{ctx.pol} → {ctx.pod}</span>
              <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>{equipmentText(equipment)}{ctx.from ? ` · departures from ${fmtDay(ctx.from)}` : ""}</span>
              <span style={{ flex: 1 }} />
              <Btn size="sm" onClick={askCarrier} disabled={asking || busy} data-testid="spot-carrier-ask">{asking ? "Asking…" : `Ask ${carrierCode} again`}</Btn>
            </div>
            {asking && !live ? <Spinner /> : live && !live.available ? (
              <span data-testid="spot-carrier-unavailable" style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>{live.message}</span>
            ) : live && (<>
              <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
                {live.offers.length ? `${carrierCode} answered with a priced offer per departure. Prices move: an offer taken is attached to ${targetLabel.startsWith("SHP") ? "this shipment" : "the quote"}.` : (live.message || `${carrierCode} has no offers for this route.`)}</span>
              {live.offers.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) 84px 84px 52px 130px 104px", gap: 12, padding: "0 14px", fontFamily: T.mono, fontSize: 9.5, fontWeight: 600, color: T.textMuted, letterSpacing: ".06em", textTransform: "uppercase" }}>
                  <span>Departure (main vessel)</span><span>ETD</span><span>ETA</span><span>Days</span><span style={{ textAlign: "right" }}>All-in price</span><span />
                </div>
              )}
              {live.offers.map((o, i) => (
                <div key={o.offerRef} data-testid={`spot-carrier-row-${i}`} style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", background: T.bg, border: `1px solid ${i === 0 ? `${T.accent}73` : T.border}`, borderRadius: 8 }}>
                  <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) 84px 84px 52px 130px 104px", gap: 12, alignItems: "center" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{o.vessel || "—"}</span>
                      <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>Voy {o.voyage || "—"}{o.sailing?.legs?.length > 1 ? ` · ${o.sailing.legs.length} legs` : " · direct"}</span>
                    </div>
                    <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text }}>{fmtDay(o.etd)}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text }}>{fmtDay(o.sailing?.eta)}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text }}>{o.sailing?.transitDays ?? "—"}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 14.5, fontWeight: 700, color: T.text, textAlign: "right" }}>{fmtMoney(o.totalUsd)}</span>
                    <Btn size="sm" variant={i === 0 ? "primary" : "secondary"} disabled={busy} onClick={() => takeLive(o)} data-testid={`spot-carrier-take-${i}`}>{o.takenId ? "Use offer" : "Take offer"}</Btn>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                    <span style={{ fontFamily: T.mono, color: T.text }}>{o.offerRef}</span>
                    <span>{o.lines.map(l => `${l.serviceCode} ${l.basis === "per_bl" ? "" : `${l.quantity} × `}${l.currency === "USD" ? "" : `${l.currency} `}${Number(l.unitPrice).toLocaleString("en-US")}`).join(" · ")}</span>
                    <span>valid until {fmtValidUntil(o.validUntil)}</span>
                    {o.penalties?.cancellationFee != null && <span>cancel {o.penalties.currency} {o.penalties.cancellationFee}{o.penalties.noShowFee != null ? ` / no-show ${o.penalties.currency} ${o.penalties.noShowFee}` : ""} per container</span>}
                  </div>
                </div>
              ))}
              {live.demo && (
                <div data-testid="spot-carrier-demo" style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 12px", borderRadius: 8, background: `${AMBER}14`, border: `1px solid ${AMBER}4d`, fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, color: AMBER }}>DEMO CARRIER</span>
                  {carrierCode} has no spot connection yet: CargoDesk's demo carrier answered, with generated prices.
                </div>
              )}
            </>)}
          </div>
        )}

        {error && <div role="alert" data-testid="spot-error" style={{ fontFamily: T.body, fontSize: 13, color: T.danger || "#f0526b", background: `${T.danger || "#f0526b"}14`, border: `1px solid ${T.danger || "#f0526b"}55`, borderRadius: 8, padding: "10px 12px" }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          {tab === "type" && <Btn onClick={save} disabled={busy || !offerRef.trim() || !carrierCode || !validUntil} data-testid="spot-save">{busy ? "Saving…" : `Attach to ${targetLabel}`}</Btn>}
        </div>
      </div>
    </Modal>
  );
};

// ─── On a quote: bought on a spot offer, and the margin ─────────────────────────────────────────
// The sell lines a margin rule makes from the offer's charges (SPOT rates phase 4): fixed = USD per
// container added to the ocean freight, the rest at cost; percent = every charge marked up.
export const sellLinesFromRule = (offer, rule) => offer.lines.map(l => {
  const ofLine = l.serviceCode === "OF" && l.basis !== "per_bl";
  const unit = rule.kind === "percent" ? l.unitPrice * (1 + rule.value / 100) : ofLine ? l.unitPrice + rule.value : l.unitPrice;
  return { serviceCode: l.serviceCode, description: l.description || l.chargeCode, containerType: l.basis === "per_bl" ? "" : l.containerType,
    quantity: String(l.quantity), rate: String(Math.round(unit * 100) / 100), currency: l.currency, setTemperatureC: "" };
});
const ruleText = r => `${r.customerName || "Everyone"} · ${r.originLane ? `${r.originLane} → ${r.destLane}` : "any lane"}${r.containerType ? ` · ${r.containerType}` : ""}`;

export const QuoteSpotOffer = ({ offer, sellUsd, onAdd, onRemove, editable = true, rule = null, onApplyRule = null }) => {
  if (!offer) {
    return (
      <div data-testid="quote-spot-empty" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: T.bg, border: `1px dashed ${T.border}`, borderRadius: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, fontWeight: 600 }}>Price on a carrier's spot offer</div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>What you bought from the carrier: the quote then carries its carrier and reference, and its conversion gets the offer's BUY lines</div>
        </div>
        {editable && <Btn size="sm" variant="secondary" onClick={onAdd} data-testid="quote-spot-add">＋ Add spot offer</Btn>}
      </div>
    );
  }
  const margin = sellUsd - offer.totalUsd;
  const pct = sellUsd > 0 ? (margin / sellUsd) * 100 : 0;
  const below = rule && rule.minMarginPct != null && sellUsd > 0 && Math.round(pct * 10) / 10 < rule.minMarginPct;
  return (
    <div data-testid="quote-spot-offer" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 9, padding: "14px 16px", border: `1px solid ${T.accent}73`, borderRadius: 10, background: `${T.accent}0f` }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: ".08em" }}>Bought on a spot offer</span>
          <span style={{ flex: 1 }} />
          {editable && <>
            <Btn size="sm" variant="secondary" onClick={onAdd} data-testid="quote-spot-change">Change offer</Btn>
            <Btn size="sm" variant="ghost" onClick={onRemove} data-testid="quote-spot-remove">Remove</Btn>
          </>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, color: "#fff", background: "#d6322a", borderRadius: 3, padding: "2px 7px" }}>{offer.carrierCode}</span>
          <span data-testid="quote-spot-ref" style={{ fontFamily: T.mono, fontSize: 14.5, fontWeight: 700, color: T.text }}>{offer.offerRef}</span>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 600, padding: "2px 9px", borderRadius: 4, background: T.surface, color: T.textMuted }}>{KIND_LABEL[offer.kind]}</span>
          {offer.expired && <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, padding: "2px 9px", borderRadius: 4, background: `${AMBER}24`, color: AMBER }}>Expired</span>}
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>{equipmentText(offer.equipment)} · valid until {fmtValidUntil(offer.validUntil)} · price locks {String(offer.priceLockLabel || "").toLowerCase()}</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 22px", fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
          {offer.lines.map(l => (
            <span key={l.id}>{l.serviceCode} <b style={{ fontFamily: T.mono, color: l.included ? T.text : AMBER }}>{fmtMoney(l.amount, l.currency).replace("USD ", "")}{l.included ? "" : " subject to"}</b></span>
          ))}
        </div>
      </div>
      {rule && (
        <div data-testid="quote-margin-rule" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "10px 14px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 360px" }}>
            <span style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>Margin rule</span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>{ruleText(rule)}: <b style={{ fontFamily: T.mono }}>{rule.kind === "fixed" ? `USD ${rule.value} per container` : `${rule.value}% of the buy`}</b>
              {rule.minMarginPct != null && <>, minimum <b style={{ fontFamily: T.mono }}>{rule.minMarginPct}%</b></>}</span>
          </div>
          {editable && onApplyRule && <Btn size="sm" variant="secondary" onClick={onApplyRule} data-testid="quote-margin-apply">Apply to the sell lines</Btn>}
        </div>
      )}
      <div data-testid="quote-margin" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", border: `1px solid ${below ? `${T.danger || "#f0526b"}73` : T.border}`, borderRadius: 10 }}>
        {[["Buy (spot offer, in price)", fmtMoney(offer.totalUsd), T.text, "quote-margin-buy"], ["Sell (quote lines)", fmtMoney(sellUsd), T.text, "quote-margin-sell"],
          ["Margin", `${fmtMoney(margin)} · ${pct.toFixed(1)}%`, margin >= 0 && !below ? (T.success || "#22c55e") : (T.danger || "#f0526b"), "quote-margin-value"]].map(([label, value, color, id], i) => (
          <div key={label} style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 3, borderRight: i < 2 ? `1px solid ${T.border}` : "none" }}>
            <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>{label}</span>
            <span data-testid={id} style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color }}>{value}</span>
          </div>
        ))}
      </div>
      {below && (
        <div role="alert" data-testid="quote-margin-below" style={{ display: "flex", flexDirection: "column", gap: 3, padding: "10px 14px", borderRadius: 8, background: `${T.danger || "#f0526b"}14`, border: `1px solid ${T.danger || "#f0526b"}55` }}>
          <span style={{ fontFamily: T.body, fontSize: 13.5, fontWeight: 700, color: T.danger || "#f0526b" }}>Below the {rule.minMarginPct}% minimum for this customer and lane</span>
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>The quote can still be saved and sent; the History records it when it's sent.</span>
        </div>
      )}
    </div>
  );
};

// The shipment's offer, and whether the carrier already holds its booking. → { offer, booking, reload }
export const useShipmentSpotOffer = shipment => {
  const [offer, setOffer] = useState(undefined);
  const [booking, setBooking] = useState(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!shipment?.id) return;
    let cancelled = false;
    Promise.all([
      api.spotOffers.forShipment(shipment.id).catch(() => null),
      api.carrierBooking.get(shipment.id).catch(() => null),
    ]).then(([o, b]) => { if (!cancelled) { setOffer(o || null); setBooking(b || null); } });
    return () => { cancelled = true; };
  }, [shipment?.id, shipment?.spotOfferId, shipment?.contractRef, tick]);
  return { offer, booking, reload: () => setTick(t => t + 1) };
};

export const removeSpotOffer = async (shipmentId) => {
  const r = await api.spotOffers.detachFromShipment(shipmentId);
  toast.success(`Spot offer removed${r?.removedBuyLines ? ` with its ${r.removedBuyLines} BUY line${r.removedBuyLines === 1 ? "" : "s"}` : ""}`);
  return r;
};
