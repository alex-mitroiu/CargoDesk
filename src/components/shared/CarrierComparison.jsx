import { useEffect, useState } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY } from "../../pages/shipments/shipmentDetailTheme";

// Requested (A) vs Carrier (B) on Booking & Review (agreed with the user 2026-10-21, approved mockup
// https://claude.ai/artifact/P3xrSaDFwDHWeWiSEWVccv): column A is the booking request the carrier
// answered, column B what it confirmed (DCSA), every detail, so the user compares and decides — accept
// the carrier's version, ask the carrier to amend, or escalate. Rows come from the server
// (GET …/carrier-booking/comparison, lib/carrier-confirmation.js). Replaces "Sent vs. Received", which
// only ever echoed what was sent (a DCSA notification carries just the status).

const AMBER = "#fbc531";
const fmtWhen = iso => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const chip = (text, color, bg) => (
  <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".06em", color, background: bg, borderRadius: 4, padding: "2px 8px", whiteSpace: "nowrap" }}>{text}</span>
);
const btnPrimary = { background: HZ.cyan, border: "none", color: "#06111f", borderRadius: 7, padding: "10px 20px", fontFamily: HZ_BODY, fontSize: 13, fontWeight: 700, cursor: "pointer" };

const CarrierComparison = ({ shipment, booking, canEdit, onEscalate, onDecided }) => {
  const [data, setData] = useState(null);
  const [only, setOnly] = useState(false);
  const [choice, setChoice] = useState("accept");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Reloaded whenever the booking moves (a new confirmation, an acceptance, an amendment answered).
  const key = `${booking?.id}|${booking?.status}|${booking?.updatedAt}|${booking?.lastResponseStatus}`;
  useEffect(() => {
    if (!booking || booking.status !== "Confirmed") { setData(null); return; }
    let cancelled = false;
    api.carrierBooking.comparison(shipment.id).then(d => !cancelled && setData(d)).catch(() => !cancelled && setData(null));
    return () => { cancelled = true; };
  }, [shipment.id, key]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data?.available) return null;
  const carrier = data.carrierCode || "The carrier";
  const pending = data.withChanges && !data.accepted;
  const rowsAll = data.rows;
  const isChange = r => r.kind === "changed" || r.kind === "new";
  const rows = only ? (() => {
    const out = []; let group = null;
    for (const r of rowsAll) {
      if (r.group) { group = r; continue; }
      if (!isChange(r)) continue;
      if (group) { out.push(group); group = null; }
      out.push(r);
    }
    return out;
  })() : rowsAll;
  const detailCount = rowsAll.filter(r => !r.group).length;

  const accept = async () => {
    setBusy(true);
    try {
      await api.carrierBooking.acceptChanges(shipment.id);
      toast.success(`${carrier}'s version is on the shipment`);
      onDecided?.();
    } catch (e) { toast.error(e.message || "The carrier's version wasn't applied"); }
    finally { setBusy(false); }
  };
  const amend = async () => {
    setBusy(true);
    try {
      await api.carrierBooking.sendUpdate(shipment.id, { note: note.trim() });
      toast.success(`Amendment sent — waiting for ${carrier}`);
      setNote("");
      onDecided?.();
    } catch (e) { toast.error(e.message || `${carrier} did not take the amendment`); }
    finally { setBusy(false); }
  };

  const seg = on => ({ background: on ? `${HZ.cyan}29` : "transparent", color: on ? HZ.cyan : HZ.textMuted, border: "none", padding: "8px 14px",
    fontFamily: HZ_BODY, fontSize: 12.5, fontWeight: 600, cursor: "pointer" });
  const card = on => ({ display: "flex", flexDirection: "column", gap: 6, textAlign: "left", padding: "14px 16px", borderRadius: 10, cursor: "pointer",
    fontFamily: HZ_BODY, border: `1px solid ${on ? HZ.cyan : HZ.border}`, background: on ? `${HZ.cyan}1a` : "transparent", color: HZ.text });

  return (
    <section data-testid="comparison-panel" aria-labelledby="cmp-h" style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 24 }}>
      {pending && (
        <div role="status" data-testid="comparison-banner" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px",
          border: `1px solid ${AMBER}73`, background: `${AMBER}14`, borderRadius: 12, padding: "14px 18px", fontFamily: HZ_BODY, color: HZ.text }}>
          {chip("CONFIRMED WITH CHANGES", AMBER, `${AMBER}24`)}
          <span style={{ fontSize: 14 }}>{carrier} confirmed booking <b style={{ fontFamily: HZ_MONO }}>{data.bookingRef}</b>, but not as requested: <b>{data.changeCount} detail{data.changeCount === 1 ? " differs" : "s differ"}</b>. Compare them below and decide how to go on.</span>
          {data.feedback.map((f, i) => <span key={i} style={{ flexBasis: "100%", fontSize: 13, color: HZ.textMuted }}>{carrier}'s note: <i>“{f}”</i></span>)}
        </div>
      )}
      {data.accepted && (
        <div role="status" data-testid="comparison-accepted" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12,
          border: `1px solid ${HZ.good}66`, background: `${HZ.good}14`, borderRadius: 12, padding: "12px 18px", fontFamily: HZ_BODY, fontSize: 13.5, color: HZ.text }}>
          {chip("ACCEPTED", HZ.good, `${HZ.good}22`)}
          <span>{carrier}'s version was accepted{data.accepted.by ? ` by ${data.accepted.by}` : ""}, {fmtWhen(data.accepted.at)}. The shipment carries column B.</span>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <h3 id="cmp-h" style={{ margin: 0, fontFamily: HZ_DISPLAY, fontSize: 15, fontWeight: 700, color: HZ.text }}>Requested vs. {carrier}'s confirmation</h3>
          <span style={{ fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted }}>
            Column A is the booking request we sent{data.requestedAt ? `, ${fmtWhen(data.requestedAt)}` : ""}. Column B is what {carrier} confirmed (DCSA){data.confirmedAt ? `, ${fmtWhen(data.confirmedAt)}` : ""}.
          </span>
        </div>
        <div role="group" aria-label="Rows to show" style={{ display: "flex", border: `1px solid ${HZ.border}`, borderRadius: 8, overflow: "hidden" }}>
          <button type="button" aria-pressed={only} onClick={() => setOnly(true)} style={seg(only)} data-testid="comparison-filter-changes">Changes only · {data.changeCount}</button>
          <button type="button" aria-pressed={!only} onClick={() => setOnly(false)} style={seg(!only)} data-testid="comparison-filter-all">Every detail · {detailCount}</button>
        </div>
      </div>

      <div style={{ border: `1px solid ${HZ.border}`, background: HZ.surface, borderRadius: 12, overflowX: "auto" }}>
        <table style={{ width: "100%", minWidth: 760, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ background: HZ.bg, borderBottom: `1px solid ${HZ.border}` }}>
              <th scope="col" style={{ textAlign: "left", padding: "9px 16px", width: "22%", fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".08em", color: HZ.textMuted }}>DETAIL</th>
              <th scope="col" style={{ textAlign: "left", padding: "9px 16px", width: "33%", fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".08em", color: HZ.textMuted }}>
                <span style={{ color: HZ.text, background: HZ.border, borderRadius: 4, padding: "1px 7px", marginRight: 8 }}>A</span>WE REQUESTED</th>
              <th scope="col" style={{ textAlign: "left", padding: "9px 16px", width: "33%", fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".08em", color: HZ.textMuted }}>
                <span style={{ color: "#06111f", background: HZ.cyan, borderRadius: 4, padding: "1px 7px", marginRight: 8 }}>B</span>{carrier.toUpperCase()} CONFIRMED</th>
              <th scope="col" style={{ width: "12%", padding: "9px 16px" }}><span style={{ position: "absolute", left: -9999 }}>Status</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => r.group ? (
              <tr key={`g${i}`} style={{ borderBottom: `1px solid ${HZ.border}` }}>
                <th scope="colgroup" colSpan={4} style={{ textAlign: "left", padding: "11px 16px 5px", fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".14em", color: HZ.textMuted }}>{r.group}</th>
              </tr>
            ) : (
              <tr key={`r${i}`} data-testid={`comparison-row-${r.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} data-kind={r.kind}
                style={{ borderBottom: `1px solid ${HZ.border}`, ...(r.kind === "changed" ? { background: `${AMBER}0f`, boxShadow: `inset 3px 0 0 ${AMBER}` } : null) }}>
                <th scope="row" style={{ textAlign: "left", padding: "9px 16px", fontFamily: HZ_BODY, fontSize: 13, fontWeight: 500, color: HZ.textMuted }}>{r.label}</th>
                <td style={{ padding: "9px 16px", fontFamily: HZ_MONO, fontSize: 12.5, color: HZ.text }}>{r.a}</td>
                <td style={{ padding: "9px 16px", fontSize: 12.5,
                  ...(r.kind === "changed" ? { fontFamily: HZ_MONO, color: AMBER, fontWeight: 700 }
                    : r.kind === "missing" ? { fontFamily: HZ_BODY, color: HZ.textMuted, fontStyle: "italic" }
                    : r.kind === "new" ? { fontFamily: HZ_MONO, color: HZ.cyan, fontWeight: 600 } : { fontFamily: HZ_MONO, color: HZ.text }) }}>
                  {r.b}{r.delta && <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: AMBER }}>{r.delta}</span>}
                </td>
                <td style={{ padding: "9px 16px" }}>
                  {r.kind === "changed" && chip("CHANGED", AMBER, `${AMBER}24`)}
                  {r.kind === "new" && chip(`FROM ${carrier.toUpperCase()}`, HZ.cyan, `${HZ.cyan}1f`)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted }}>“Not stated” means {carrier}'s confirmation doesn't carry that detail (DCSA has no field for it), not that it changed.</span>

      {pending && canEdit && (
        <div data-testid="comparison-decision" style={{ border: `1px solid ${HZ.border}`, background: HZ.surface, borderRadius: 12, padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
          <h3 style={{ margin: 0, fontFamily: HZ_DISPLAY, fontSize: 14, fontWeight: 700, color: HZ.text }}>How do you want to proceed?</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <button type="button" aria-pressed={choice === "accept"} onClick={() => setChoice("accept")} style={card(choice === "accept")} data-testid="decision-accept">
              <b style={{ fontSize: 14 }}>Accept {carrier}'s version</b>
              <span style={{ fontSize: 12.5, color: HZ.textMuted, lineHeight: 1.5 }}>Column B goes on the shipment and its sea legs. The booking stays confirmed; nothing is sent to {carrier}.</span>
            </button>
            <button type="button" aria-pressed={choice === "amend"} onClick={() => setChoice("amend")} style={card(choice === "amend")} data-testid="decision-amend">
              <b style={{ fontSize: 14 }}>Ask {carrier} to amend</b>
              <span style={{ fontSize: 12.5, color: HZ.textMuted, lineHeight: 1.5 }}>Sends {carrier} a DCSA amendment asking for column A again. The shipment stays as requested until {carrier} answers.</span>
            </button>
            <button type="button" aria-pressed={choice === "escalate"} onClick={() => setChoice("escalate")} style={card(choice === "escalate")} data-testid="decision-escalate">
              <b style={{ fontSize: 14 }}>Escalate…</b>
              <span style={{ fontSize: 12.5, color: HZ.textMuted, lineHeight: 1.5 }}>To OCC/AY or CCL/CO, who look for another carrier or sailing.</span>
            </button>
          </div>
          {choice === "accept" && (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, borderTop: `1px solid ${HZ.border}`, paddingTop: 14, fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>
              <span>The vessel, voyage, dates and every leg in column B, and {carrier}'s cut-offs (documentation, VGM, FCL delivery), go on the shipment. The History records who accepted.</span>
              <button type="button" onClick={accept} disabled={busy} style={btnPrimary} data-testid="decision-accept-submit">{busy ? "Applying…" : "Accept and update the shipment"}</button>
            </div>
          )}
          {choice === "amend" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: `1px solid ${HZ.border}`, paddingTop: 14 }}>
              <label htmlFor="amend-note" style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, letterSpacing: ".1em", color: HZ.textMuted }}>
                NOTE <span style={{ fontFamily: HZ_BODY, fontSize: 11.5, fontWeight: 500, letterSpacing: 0 }}>Kept in the History: a DCSA amendment has no free-text field to carry it to {carrier}.</span>
              </label>
              <textarea id="amend-note" rows={2} value={note} onChange={e => setNote(e.target.value)} data-testid="decision-amend-note"
                style={{ background: HZ.bg, color: HZ.text, border: `1px solid ${HZ.border}`, borderRadius: 8, padding: "8px 10px", fontFamily: HZ_BODY, fontSize: 13, resize: "vertical" }} />
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="button" onClick={amend} disabled={busy} style={btnPrimary} data-testid="decision-amend-submit">{busy ? "Sending…" : `Send the amendment to ${carrier}`}</button>
              </div>
            </div>
          )}
          {choice === "escalate" && (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, borderTop: `1px solid ${HZ.border}`, paddingTop: 14, fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>
              <span>{onEscalate ? "The Escalate pop-up opens with “Confirmed with changes” and these changes." : "This booking is already escalated, or you can't escalate it from this office."}</span>
              <button type="button" onClick={() => onEscalate?.()} disabled={!onEscalate} style={{ ...btnPrimary, opacity: onEscalate ? 1 : 0.45, cursor: onEscalate ? "pointer" : "not-allowed" }} data-testid="decision-escalate-submit">Escalate…</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
};

export default CarrierComparison;
