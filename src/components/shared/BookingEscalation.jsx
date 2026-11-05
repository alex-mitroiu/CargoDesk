import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import { Modal } from "../primitives/Modal";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY } from "../../pages/shipments/shipmentDetailTheme";
import { LegRoleChip, SailingLegs, viaText } from "./LegRoles";

// ─── Booking escalations (Epic TKT-ASIYFL; approved mockup https://claude.ai/artifact/FXrT7utJNRgPabknbKyPmR) ───
// Handled on the shipment's Booking & Review page — no separate section. OCC/BK escalates a rejected,
// changed or unanswered booking from the Escalate pop-up; whoever holds it (OCC/AY, CCL/CO, Trade/AY,
// Trade) works it in the panel; instructions come back to OCC/BK. What each person may do comes from the
// server (view.actions), never worked out here.

const ROLE_LABEL = { occ_bk: "OCC/BK", occ_ay: "OCC/AY", ccl_co: "CCL/CO", trade_ay: "Trade/AY", trade_manager: "Trade", system: "CargoDesk" };
const ago = iso => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 60 ? `${min} min` : min < 60 * 48 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min` : `${Math.floor(min / 1440)} days`;
};
const fmtDay = d => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }) : "—";
const fmtWhen = iso => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const STEP_TEXT = {
  escalated: s => `escalated it to ${s.toLabel}`, hand_over: s => `handed it over to ${s.toLabel}`, escalate: s => `escalated it to ${s.toLabel}`,
  send_back: s => `sent it back to ${s.toLabel}`, instructed: s => `sent instructions to ${s.toLabel}`, question: s => `sent the instructions back to ${s.toLabel} with a question`,
  impossible: () => "marked the booking impossible", withdraw: () => "withdrew the escalation", message: () => "added a message", resolved: () => "closed it",
  booked: () => "booked as instructed", carrier_rejected: s => `sent it back to ${s.toLabel}`,
  carrier_changed: s => (s.toLabel ? `sent it back to ${s.toLabel}` : "noted the carrier's changes"),
};

// What the carrier changed when it confirmed (lib/booking-escalations.js confirmationChanges):
// one line per change, requested → confirmed. Dates are shown as days.
const showChange = (c, v) => (c.field === "dates" || c.field === "arrival" ? fmtDay(v) : v);

// The Recommended sailing: the shortest transit time, the earlier departure on a tie (user, 2026-10-20).
// The no-answer switch books by the same rule (lib/booking-escalations.js recommendedSailing).
const transitOf = s => (s.transitDays != null && s.transitDays !== "" && Number.isFinite(Number(s.transitDays)) ? Number(s.transitDays)
  : s.etd && s.eta ? (Date.parse(`${s.eta}T00:00:00Z`) - Date.parse(`${s.etd}T00:00:00Z`)) / 864e5 : Infinity);
const recommendedIndex = list => list.reduce((best, s, i) => (best < 0 || transitOf(s) < transitOf(list[best])
  || (transitOf(s) === transitOf(list[best]) && String(s.etd) < String(list[best].etd)) ? i : best), -1);
const ChangeList = ({ changes, testId }) => (
  <ul data-testid={testId} style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3, fontFamily: T.body, fontSize: 13, color: "inherit" }}>
    {changes.map(c => (
      <li key={c.field}><b>{c.label}:</b> <span style={{ fontFamily: T.mono, fontSize: 12 }}>{showChange(c, c.requested)}</span> → <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 600 }}>{showChange(c, c.confirmed)}</span></li>
    ))}
  </ul>
);

// ─── Review and Book As Instructed (OCC/BK) ──────────────────────────────────────────────────
const SailingRow = ({ label, tone, carrier, contract, etd, eta, tt, vessel, service, status }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    <span style={fieldLabel()}>{label}</span>
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 860, display: "grid", gridTemplateColumns: "repeat(9, minmax(0, 1fr))", gap: "3px 14px", alignItems: "center",
        border: `1px solid ${tone}73`, background: `${tone}1a`, borderRadius: 8, padding: "10px 16px", fontFamily: T.body, fontSize: 13, color: T.text }}>
        {["Carrier", "Contract", "", "Departure", "Arrival", "T/T", "Vessel · voyage", "Service", ""].map((h, i) => <span key={i} style={{ fontSize: 10.5, color: T.textMuted }}>{h}</span>)}
        <b style={{ fontFamily: T.mono, color: T.accent }}>{carrier || "—"}</b>
        <span style={{ fontFamily: T.mono, fontSize: 12, gridColumn: "span 2" }}>{contract || "—"}</span>
        <b>{fmtDay(etd)}</b><b>{fmtDay(eta)}</b><span>{tt ? `${tt} days` : "—"}</span>
        <span style={{ fontFamily: T.mono, fontSize: 12 }}>{vessel || "—"}</span><span>{service || "—"}</span>
        <span style={{ justifySelf: "end", fontFamily: T.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em", color: tone, background: `${tone}1a`, borderRadius: 4, padding: "2px 9px" }}>{status}</span>
      </div>
    </div>
  </div>
);

export function BookAsInstructedModal({ shipment, booking, view, onClose, onDone }) {
  const esc = view.escalation, ins = esc.instruction;
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const instructedStep = [...(view.steps || [])].reverse().find(s => s.action === "instructed");
  const days = (a, b) => (a && b) ? Math.round((Date.parse(b) - Date.parse(a)) / 864e5) : null;
  const was = esc.sailing || {};
  const book = async () => {
    setBusy(true);
    try {
      const r = await api.escalations.book(esc.id);
      if (r.carrierError) toast.error(`Booked, but ${ins.carrierCode} didn't receive the request: ${r.carrierError}`);
      else toast.success(`Booked as instructed — waiting for ${ins.carrierCode}`);
      onDone?.();
    } catch (e) { toast.error(e.message || "Couldn't book as instructed"); setBusy(false); }
  };
  const ask = async () => {
    setBusy(true);
    try { await api.escalations.act(esc.id, { action: "question", message: question.trim() }); toast.success("Sent back with your question"); onDone?.(); }
    catch (e) { toast.error(e.message || "Couldn't send it back"); setBusy(false); }
  };
  const ctxItem = (label, value, mono) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ ...fieldLabel(), fontSize: 10 }}>{label}</span>
      <b style={{ fontFamily: mono ? T.mono : T.body, fontSize: 13.5, color: T.text }}>{value || "—"}</b>
    </div>
  );
  return (
    <Modal title="Review and Book As Instructed" onClose={() => !busy && onClose()} width={1040} data-testid="book-as-instructed-modal">
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: "12px 18px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 16px" }}>
          {ctxItem("Principal", shipment.principalName || shipment.shipperName)}
          {ctxItem("Route", `${shipment.pol} → ${shipment.pod}`, true)}
          {ctxItem("Lane · commodity", [shipment.tradeLane, shipment.commodityCode].filter(Boolean).join(" · "))}
          {ctxItem("Booking", booking?.id, true)}
        </div>
        <SailingRow label={esc.trigger === "changed" ? "Confirmed with changes" : esc.trigger === "no_answer" ? "Unanswered sailing" : "Rejected sailing"}
          tone={esc.trigger === "changed" ? T.warning : esc.trigger === "no_answer" ? T.info : T.danger}
          carrier={esc.carrierCode} contract={was.contractRef} etd={was.etd} eta={was.eta} tt={days(was.etd, was.eta)}
          vessel={[was.vessel, was.voyage].filter(Boolean).join(" · ")} status={esc.trigger === "changed" ? "CHANGED" : esc.trigger === "no_answer" ? "NO ANSWER" : "REJECTED"} />
        <SailingRow label={`Instructed sailing${ins.rank ? ` · option #${ins.rank}` : ""}`} tone={T.success}
          carrier={ins.carrierCode} contract={ins.contractNumber} etd={ins.sailing.etd} eta={ins.sailing.eta} tt={ins.sailing.transitDays ?? days(ins.sailing.etd, ins.sailing.eta)}
          vessel={[ins.sailing.vesselName, ins.sailing.voyageNumber].filter(Boolean).join(" · ")} service={ins.sailing.legs?.length > 1 ? `Main vessel, ${viaText(ins.sailing)}` : ins.sailing.service} status="INSTRUCTED" />
        {ins.sailing.legs?.length > 1 && <SailingLegs sailing={ins.sailing} testId="book-as-instructed-legs" />}
        <p style={{ margin: 0, fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.6 }}>
          <b>Book As Instructed</b> {booking?.status === "Pending" ? `withdraws ${booking.id} at ${booking.carrierCode}, ` : ""}puts {ins.carrierCode}{ins.contractNumber ? `, ${ins.contractNumber}` : ""} and this sailing on the shipment, and sends the DCSA booking request to {ins.carrierCode}. The escalation closes when {ins.carrierCode} confirms.
        </p>
        {asking && (
          <label htmlFor="bai-question" style={{ display: "flex", flexDirection: "column", gap: 6, ...fieldLabel() }}>Your question
            <textarea id="bai-question" rows={2} value={question} onChange={e => setQuestion(e.target.value)} data-testid="book-as-instructed-question"
              style={{ ...inputStyle(), letterSpacing: 0, textTransform: "none", resize: "vertical" }} />
          </label>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
            Instructed by <b style={{ color: T.text }}>{ROLE_LABEL[esc.instructedByRole]}{view.instructedByPlace ? ` · ${view.instructedByPlace}` : ""}</b>{instructedStep ? ` · ${instructedStep.actorName}, ${fmtWhen(instructedStep.createdAt)}` : ""}
          </span>
          <span style={{ flex: "1 1 auto" }} />
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Close</Btn>
          {asking
            ? <Btn variant="secondary" onClick={ask} disabled={busy || !question.trim()} data-testid="book-as-instructed-send-question">Send back</Btn>
            : <Btn variant="secondary" onClick={() => setAsking(true)} disabled={busy}>Send back with a question</Btn>}
          <Btn onClick={book} disabled={busy} data-testid="book-as-instructed-submit">{busy ? "Booking…" : "Book As Instructed"}</Btn>
        </div>
      </div>
    </Modal>
  );
}

// ─── Escalate pop-up (OCC/BK) ────────────────────────────────────────────────────────────────
const fieldLabel = () => ({ fontFamily: T.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".08em", color: T.textMuted, textTransform: "uppercase" });
const inputStyle = () => ({ background: T.bg, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: "9px 10px", fontFamily: T.body, fontSize: 13.5, boxSizing: "border-box", width: "100%" });

export function EscalateModal({ shipment, booking, offer, onClose, onDone }) {
  const [toRole, setToRole] = useState(offer.defaultGroup || "occ_ay");
  const [reasonCode, setReasonCode] = useState(offer.trigger === "changed" ? "later_sailing" : offer.trigger === "no_answer" ? "no_answer" : "no_space");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const badge = offer.trigger === "rejected" ? { text: `REJECTED BY ${booking?.carrierCode || "THE CARRIER"}`, c: T.danger, bg: T.dangerBg }
    : offer.trigger === "changed" ? { text: "CONFIRMED WITH CHANGES", c: T.warning, bg: T.warningBg }
    : { text: "NO ANSWER FROM THE CARRIER", c: T.info, bg: T.infoBg };
  const submit = async () => {
    setBusy(true);
    try {
      await api.escalations.create(shipment.id, { toRole, reasonCode, note: note.trim() });
      toast.success(`Escalated to ${ROLE_LABEL[toRole]}`);
      onDone?.();
    } catch (e) { toast.error(e.message || "Couldn't escalate the booking"); setBusy(false); }
  };
  return (
    <Modal title="Escalate Booking" onClose={() => !busy && onClose()} width={560} data-testid="escalate-modal">
      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, fontFamily: T.body, fontSize: 13.5 }}>
          <span style={{ fontFamily: T.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em", borderRadius: 4, padding: "2px 9px", color: badge.c, background: badge.bg }}>{badge.text}</span>
          <span style={{ color: T.textMuted }}>{booking?.id} · {shipment.id} · {shipment.pol} → {shipment.pod}</span>
        </div>
        {offer.changes?.length > 0 && (
          <div style={{ color: T.text, background: T.warningBg, border: `1px solid ${T.warning}55`, borderRadius: 8, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>{booking?.carrierCode || "The carrier"} confirmed, but not as requested:</span>
            <ChangeList changes={offer.changes} testId="escalate-changes" />
          </div>
        )}
        <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <legend style={{ ...fieldLabel(), padding: "0 0 8px" }}>Send to</legend>
          {offer.groups.map(g => {
            const on = g.role === toRole;
            return (
              <label key={g.role} htmlFor={`esc-to-${g.role}`} data-testid={`escalate-to-${g.role}`}
                style={{ display: "flex", gap: 12, alignItems: "flex-start", borderRadius: 8, padding: "12px 14px", cursor: "pointer",
                  border: `1px solid ${on ? T.accent : T.border}`, background: on ? T.accentBg : T.bg }}>
                <input type="radio" id={`esc-to-${g.role}`} name="esc-to" checked={on} onChange={() => setToRole(g.role)} style={{ marginTop: 3, accentColor: T.accent }} />
                <span style={{ display: "flex", flexDirection: "column", gap: 3, fontFamily: T.body }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{g.label}{g.place ? ` · ${g.place}` : ""}
                    {g.role === offer.defaultGroup && <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 600, letterSpacing: ".06em", color: T.accent, background: T.accentBg, borderRadius: 4, padding: "1px 7px", marginLeft: 8 }}>DEFAULT</span>}
                  </span>
                  <span style={{ fontSize: 12.5, color: T.textMuted }}>{g.role === "occ_ay" ? "Origin side, the export office. Clears it with the carrier's local contacts first." : "Destination side, the import office. For what the consignee can accept."}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <label htmlFor="esc-reason" style={{ display: "flex", flexDirection: "column", gap: 6, ...fieldLabel() }}>Reason
          <select id="esc-reason" value={reasonCode} onChange={e => setReasonCode(e.target.value)} style={{ ...inputStyle(), letterSpacing: 0, textTransform: "none" }}>
            {offer.reasons.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
          </select>
        </label>
        <label htmlFor="esc-note" style={{ display: "flex", flexDirection: "column", gap: 6, ...fieldLabel() }}>Note for the handler
          <textarea id="esc-note" rows={3} value={note} onChange={e => setNote(e.target.value)} data-testid="escalate-note"
            placeholder="e.g. Customer needs it in New York by 10 Nov; any Central contract is fine."
            style={{ ...inputStyle(), letterSpacing: 0, textTransform: "none", resize: "vertical" }} />
        </label>
        <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
          Everyone with the {ROLE_LABEL[toRole]} role {toRole === "occ_ay" ? "in the export office" : "in the import office"} sees it under Shipments → Escalated to me, and gets a notification.
        </span>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <Btn variant="secondary" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={submit} disabled={busy} data-testid="escalate-submit">{busy ? "Escalating…" : `Escalate to ${ROLE_LABEL[toRole]}`}</Btn>
        </div>
      </div>
    </Modal>
  );
}

// ─── The panel on the shipment ───────────────────────────────────────────────────────────────
const hzPrimary = () => ({ background: HZ.cyan, border: "none", color: HZ.chipText, borderRadius: 7, padding: "9px 18px", fontFamily: HZ_BODY, fontSize: 13, fontWeight: 700, cursor: "pointer" });

export default function BookingEscalationPanel({ shipment, view, onChanged, onBookAsInstructed }) {
  const esc = view?.escalation;
  const actions = view?.actions || [];
  const canInstruct = actions.includes("instruct");
  const [alts, setAlts] = useState(null);
  const [altSource, setAltSource] = useState("");  // "" = lane steering when the lane has it, "contracts" = the contract search
  const [pick, setPick] = useState(null);          // option rank
  const [sailings, setSailings] = useState(null);  // for the picked option
  const [sailing, setSailing] = useState(null);    // index
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [impossibleOpen, setImpossibleOpen] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (!canInstruct) return;
    let cancelled = false;
    setAlts(null);
    api.escalations.alternatives(shipment.id, altSource).then(a => { if (!cancelled) { setAlts(a); setPick(a.options.find(o => o.usable)?.rank ?? null); } }).catch(() => !cancelled && setAlts({ options: [] }));
    return () => { cancelled = true; };
  }, [shipment.id, canInstruct, esc?.id, esc?.holderRole, altSource]);

  const option = alts?.options.find(o => o.rank === pick) || null;
  useEffect(() => {
    if (!option) { setSailings(null); return; }
    let cancelled = false;
    setSailings(null); setSailing(null);
    api.schedules.search({ pol: shipment.pol, pod: shipment.pod, carrierCode: option.carrierCode, weeks: 4, onlyCarrier: "1" })
      .then(r => { if (!cancelled) { const list = (r.sailings || []).slice(0, 4); setSailings(list); setSailing(list.length ? recommendedIndex(list) : null); } })
      .catch(() => !cancelled && setSailings([]));
    return () => { cancelled = true; };
  }, [option?.rank, option?.carrierCode, shipment.pol, shipment.pod]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!esc) return null;

  const run = async (action, extra = {}) => {
    setBusy(true);
    try {
      await api.escalations.act(esc.id, { action, message: message.trim(), ...extra });
      setMessage(""); setImpossibleOpen(false); setReason("");
      toast.success({ hand_over: "Handed over", escalate: "Escalated", send_back: "Sent back", instruct: "Instructions sent to OCC/BK", impossible: "Marked impossible",
        question: "Sent back with your question", message: "Message added", withdraw: "Escalation withdrawn" }[action] || "Done");
      onChanged?.();
    } catch (e) { toast.error(e.message || "That didn't go through"); }
    finally { setBusy(false); }
  };
  const chosen = option && sailings && sailing != null ? sailings[sailing] : null;
  const instruct = () => run("instruct", { instruction: {
    carrierCode: option.carrierCode, contractId: option.contractId, contractNumber: option.contractNumber, allocationId: option.allocationId, source: option.source, rank: option.rank,
    sailing: { vesselName: chosen.vesselName, voyageNumber: chosen.voyageNumber, etd: chosen.etd, eta: chosen.eta, service: chosen.service || "", transitDays: chosen.transitDays,
      pol: chosen.pol || shipment.pol, pod: chosen.pod || shipment.pod,
      ...(chosen.legs?.length > 1 ? { legs: chosen.legs.map(l => ({ pol: l.pol, pod: l.pod, vesselName: l.vesselName, voyageNumber: l.voyageNumber, etd: l.etd, eta: l.eta, service: l.service || "" })) } : {}) },
  } });

  const holder = esc.holderRole;
  const closed = !esc.active;
  const tone = closed ? (esc.status === "impossible" ? HZ.crit : esc.status === "resolved" ? HZ.good : HZ.textMuted) : HZ.amber;
  const statusChip = closed
    ? { resolved: "RESOLVED", impossible: "IMPOSSIBLE", withdrawn: "WITHDRAWN" }[esc.status] || esc.status.toUpperCase()
    : `WITH ${ROLE_LABEL[holder]}${view.place ? ` · ${view.place}` : ""} · ${ago(esc.holderSince)}`.toUpperCase();
  const triggerTone = esc.trigger === "rejected" ? HZ.crit : esc.trigger === "changed" ? HZ.warn : HZ.info;
  const secondary = [
    actions.includes("hand_over") && { action: "hand_over", label: holder === "occ_ay" ? "Hand over to CCL/CO" : "Hand back to OCC/AY" },
    actions.includes("escalate") && { action: "escalate", label: holder === "trade_ay" ? "Escalate to Trade" : "Escalate to Trade/AY" },
    actions.includes("send_back") && { action: "send_back", label: holder === "trade_manager" ? "Send back to Trade/AY" : "Send back" },
  ].filter(Boolean);
  const ins = esc.instruction;
  const was = esc.sailing || {};   // the sailing the carrier turned down

  return (
    <section data-testid="escalation-panel" aria-labelledby="escalation-heading"
      style={{ border: `1px solid ${closed ? HZ.border : `${HZ.amber}66`}`, background: HZ.surface, borderRadius: 12, padding: "16px 20px", marginBottom: 24,
        display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <h3 id="escalation-heading" style={{ fontFamily: HZ_DISPLAY, fontSize: 14, fontWeight: 700, color: HZ.text, margin: 0 }}>{closed ? "Last escalation" : "Escalation"}</h3>
        <span data-testid="escalation-holder" style={{ fontFamily: HZ_MONO, fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em", color: tone, background: `${tone}1f`, borderRadius: 4, padding: "3px 9px" }}>{statusChip}</span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 22px", border: `1px solid ${triggerTone}66`, background: `${triggerTone}18`, borderRadius: 10, padding: "10px 14px", fontFamily: HZ_BODY, fontSize: 13, color: HZ.text }}>
        <b style={{ fontFamily: HZ_MONO, color: triggerTone }}>{esc.trigger === "rejected" ? "REJECTED" : esc.trigger === "changed" ? "CONFIRMED WITH CHANGES" : "NO ANSWER"}</b>
        <span><b style={{ fontFamily: HZ_MONO }}>{esc.carrierCode}</b>{was.contractRef ? ` · ${was.contractRef}` : ""}</span>
        {(was.vessel || was.voyage) && <span style={{ fontFamily: HZ_MONO }}>{[was.vessel, was.voyage].filter(Boolean).join(" · ")}</span>}
        {was.etd && <span>{fmtDay(was.etd)} → {fmtDay(was.eta)}</span>}
        {was.changes?.length > 0 && <div style={{ flexBasis: "100%" }}><ChangeList changes={was.changes} testId="escalation-changes" /></div>}
      </div>
      <span style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>
        <b style={{ color: HZ.text }}>{esc.createdByName || "CargoDesk"}{esc.automatic ? "" : " (OCC/BK)"}:</b> {esc.reasonLabel || esc.triggerLabel}{esc.note ? ` — “${esc.note}”` : ""}
      </span>

      {esc.status === "impossible" && (
        <div style={{ fontFamily: HZ_BODY, fontSize: 13.5, color: HZ.text, border: `1px solid ${HZ.crit}66`, borderRadius: 10, padding: "10px 14px" }}>
          <b style={{ color: HZ.crit }}>Impossible:</b> {esc.impossibleReason}
        </div>
      )}

      {esc.status === "instructed" && ins && (
        <div data-testid="escalation-instructions" style={{ display: "flex", flexDirection: "column", gap: 8, border: `1px solid ${HZ.good}66`, background: `${HZ.good}14`, borderRadius: 10, padding: "12px 14px", fontFamily: HZ_BODY, fontSize: 13, color: HZ.text }}>
          <span><b style={{ color: HZ.good }}>Instructions from {ROLE_LABEL[esc.instructedByRole]}{view.instructedByPlace ? ` · ${view.instructedByPlace}` : ""}:</b> book <b style={{ fontFamily: HZ_MONO }}>{ins.carrierCode}</b>{ins.contractNumber ? ` on ${ins.contractNumber}` : ""}, <span style={{ fontFamily: HZ_MONO }}>{ins.sailing.vesselName}{ins.sailing.voyageNumber ? ` · ${ins.sailing.voyageNumber}` : ""}</span>{ins.sailing.legs?.length > 1 ? ` (main, ${viaText(ins.sailing)})` : ""}, {fmtDay(ins.sailing.etd)} → {fmtDay(ins.sailing.eta)}</span>
          {actions.includes("book") && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              <button type="button" style={hzPrimary()} disabled={busy} onClick={() => onBookAsInstructed?.(esc)} data-testid="escalation-action-book">Review and Book As Instructed</button>
            </div>
          )}
          {view.booked && <span data-testid="escalation-booked" style={{ color: HZ.textMuted }}>Booked as instructed — waiting for {ins.carrierCode} to confirm.</span>}
        </div>
      )}

      {canInstruct && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
            <span data-testid="escalation-alternatives-source" style={{ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", color: HZ.textMuted }}>
              ALTERNATIVES{alts?.lane ? ` · ${alts.source === "steering" ? `LANE STEERING ${alts.lane}${alts.steering?.customerName ? ` · ${alts.steering.customerName.toUpperCase()}` : ""}` : `CONTRACT SEARCH, ${alts.lane}`}` : ""}
            </span>
            {alts?.steering && (
              <button type="button" data-testid="escalation-alternatives-switch" onClick={() => setAltSource(alts.source === "steering" ? "contracts" : "")}
                style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.cyan }}>
                {alts.source === "steering" ? "Search all contracts instead (Central first)" : "Back to the lane steering"}
              </button>
            )}
          </div>
          {!alts ? <span style={{ color: HZ.textMuted, fontFamily: HZ_BODY, fontSize: 13 }}><Spinner size="sm" /> Finding alternatives…</span>
            : alts.options.length === 0 ? <span style={{ color: HZ.textMuted, fontFamily: HZ_BODY, fontSize: 13 }}>No Central contract with space fits this route. Escalate it, or mark it impossible if you're Trade/AY.</span>
            : (
              <div style={{ border: `1px solid ${HZ.border}`, borderRadius: 10, overflow: "hidden" }}>
                {alts.options.map(o => {
                  const on = o.rank === pick;
                  return (
                    <div key={o.rank} data-testid={`escalation-option-${o.rank}`} style={{ padding: "10px 14px", borderBottom: `1px solid ${HZ.border}`, opacity: o.usable ? 1 : .55, background: on ? HZ.cyanBg : "transparent", display: "flex", flexDirection: "column", gap: 8 }}>
                      <label style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 12, cursor: o.usable ? "pointer" : "default", fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text }}>
                        <input type="radio" name="esc-option" checked={on} disabled={!o.usable} onChange={() => setPick(o.rank)} style={{ accentColor: HZ.cyan }} aria-label={`Option ${o.rank}: ${o.carrierCode} ${o.contractNumber}`} />
                        <span style={{ fontFamily: HZ_MONO, fontWeight: 700, color: HZ.amber, minWidth: 24 }}>#{o.rank}</span>
                        <b style={{ fontFamily: HZ_MONO, minWidth: 44 }}>{o.carrierCode}</b>
                        <span style={{ fontFamily: HZ_MONO }}>{o.contractNumber || "—"}</span>
                        <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 600, letterSpacing: ".06em", color: "#fff", background: "rgb(77,179,232)", borderRadius: 4, padding: "1px 7px" }}>CENTRAL</span>
                        <span style={{ color: o.usable ? HZ.textMuted : HZ.warn }}>{o.note}</span>
                      </label>
                      {on && (
                        <div role="radiogroup" aria-label="Sailings" style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 62 }}>
                          {!sailings ? <span style={{ color: HZ.textMuted, fontFamily: HZ_BODY, fontSize: 12.5 }}>Finding sailings…</span>
                            : sailings.length === 0 ? <span style={{ color: HZ.textMuted, fontFamily: HZ_BODY, fontSize: 12.5 }}>No sailings found for {o.carrierCode} in the next 4 weeks.</span>
                            : sailings.map((s, i) => (
                              <label key={i} data-testid={`escalation-sailing-${i}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 18px", borderRadius: 8, padding: "7px 12px", cursor: "pointer", fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text,
                                border: `1px solid ${i === sailing ? HZ.cyan : HZ.border}`, background: i === sailing ? HZ.cyanBg : "transparent" }}>
                                <input type="radio" name="esc-sailing" checked={i === sailing} onChange={() => setSailing(i)} style={{ accentColor: HZ.cyan }} />
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: HZ_MONO, fontWeight: 600 }}>{s.vesselName} · {s.voyageNumber}{s.legs?.length > 1 && <LegRoleChip role="MAIN" muted={HZ.textMuted} />}</span>
                                <span style={{ fontFamily: HZ_MONO }}>{fmtDay(s.etd)} → {fmtDay(s.eta)}</span>
                                <span style={{ color: HZ.textMuted }}>{s.transitDays} days{s.isMock ? " · demo" : ""}</span>
                                {i === recommendedIndex(sailings) && (
                                  <span data-testid={`escalation-sailing-recommended-${i}`} title="Shortest transit time"
                                    style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 600, letterSpacing: ".06em", color: HZ.good, background: `${HZ.good}1f`, borderRadius: 4, padding: "1px 7px" }}>RECOMMENDED</span>
                                )}
                                {s.legs?.length > 1 && (
                                  <div style={{ flexBasis: "100%", paddingLeft: 24 }}>
                                    <SailingLegs sailing={s} text={HZ.text} muted={HZ.textMuted} testId={`escalation-sailing-${i}-legs`} />
                                  </div>
                                )}
                              </label>
                            ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      )}

      {holder === "trade_manager" && !closed && !actions.includes("send_back") && actions.includes("message") && (
        <span style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>Trade has it: they can add messages and send it back to Trade/AY.</span>
      )}

      {actions.includes("message") && (
        <label htmlFor="esc-message" style={{ display: "flex", flexDirection: "column", gap: 6, fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: ".1em", color: HZ.textMuted }}>
          MESSAGE <span style={{ fontFamily: HZ_BODY, fontSize: 11.5, fontWeight: 500, letterSpacing: 0 }}>Goes with your action and into the History.</span>
          <textarea id="esc-message" data-testid="escalation-message" rows={2} value={message} onChange={e => setMessage(e.target.value)}
            style={{ background: T.bg, color: HZ.text, border: `1px solid ${HZ.borderStrong}`, borderRadius: 8, padding: "8px 10px", fontFamily: HZ_BODY, fontSize: 13, letterSpacing: 0, resize: "vertical" }} />
        </label>
      )}

      {(canInstruct || secondary.length > 0 || actions.includes("message") || actions.includes("impossible") || actions.includes("question") || actions.includes("withdraw")) && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {canInstruct && <button type="button" style={{ ...hzPrimary(), opacity: chosen && !busy ? 1 : .42, cursor: chosen && !busy ? "pointer" : "not-allowed" }} disabled={!chosen || busy} onClick={instruct} data-testid="escalation-action-instruct">Send instructions to OCC/BK</button>}
          {secondary.map(a => <Btn key={a.action} variant="secondary" onClick={() => run(a.action)} disabled={busy} data-testid={`escalation-action-${a.action}`}>{a.label}</Btn>)}
          {actions.includes("question") && <Btn variant="secondary" onClick={() => run("question")} disabled={busy || !message.trim()} data-testid="escalation-action-question">Send back with a question</Btn>}
          {actions.includes("message") && <Btn variant="secondary" onClick={() => run("message")} disabled={busy || !message.trim()} data-testid="escalation-action-message">Add message</Btn>}
          <span style={{ flex: "1 1 auto" }} />
          {actions.includes("withdraw") && <Btn variant="secondary" onClick={() => run("withdraw")} disabled={busy} data-testid="escalation-action-withdraw">Withdraw</Btn>}
          {actions.includes("impossible") && <Btn variant="danger" onClick={() => setImpossibleOpen(true)} disabled={busy} data-testid="escalation-action-impossible">Mark impossible…</Btn>}
        </div>
      )}
      {canInstruct && chosen && (
        <span style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted }}>OCC/BK will get: {option.carrierCode}{option.contractNumber ? ` · ${option.contractNumber}` : ""} · {chosen.vesselName} {chosen.voyageNumber}{chosen.legs?.length > 1 ? ` (main), ${viaText(chosen)}` : ""} · {fmtDay(chosen.etd)} → {fmtDay(chosen.eta)}</span>
      )}

      <details data-testid="escalation-steps" style={{ borderTop: `1px solid ${HZ.border}`, paddingTop: 10 }}>
        <summary style={{ cursor: "pointer", fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>Escalation steps ({view.steps.length})</summary>
        <ol style={{ margin: "10px 0 0", paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6, fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text }}>
          {view.steps.map(s => (
            <li key={s.id}>
              <span style={{ fontFamily: HZ_MONO, color: HZ.textMuted }}>{fmtWhen(s.createdAt)}</span>{" "}
              {s.actorName}{s.actorRole && ROLE_LABEL[s.actorRole] && s.actorRole !== "system" ? ` (${ROLE_LABEL[s.actorRole]})` : ""} {(STEP_TEXT[s.action] || (() => s.action))(s)}
              {s.message && <span style={{ color: HZ.textMuted }}>: “{s.message}”</span>}
            </li>
          ))}
        </ol>
      </details>

      {impossibleOpen && (
        <Modal title="Mark the booking impossible" onClose={() => !busy && setImpossibleOpen(false)} width={460}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ margin: 0, fontFamily: T.body, fontSize: 13.5, color: T.text, lineHeight: 1.55 }}>The escalation closes and OCC/BK is told. The shipment stays as it is, for OCC/BK to cancel or rework.</p>
            <label htmlFor="esc-impossible" style={{ display: "flex", flexDirection: "column", gap: 6, ...fieldLabel() }}>Why
              <textarea id="esc-impossible" rows={3} value={reason} onChange={e => setReason(e.target.value)} data-testid="escalation-impossible-reason"
                style={{ ...inputStyle(), letterSpacing: 0, textTransform: "none", resize: "vertical" }} />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <Btn variant="secondary" onClick={() => setImpossibleOpen(false)} disabled={busy}>Back</Btn>
              <Btn variant="danger" onClick={() => run("impossible", { reason: reason.trim() })} disabled={busy || !reason.trim()} data-testid="escalation-impossible-confirm">Mark impossible</Btn>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}
