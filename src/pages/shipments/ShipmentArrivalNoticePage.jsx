import { useState, useEffect } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Spinner from "../../components/primitives/Spinner";
import GenerateDocumentModal from "../../components/shared/GenerateDocumentModal";
import { IconMailUnread } from "../../components/primitives/Icon";
import { canEditShipmentSide } from "../../utils/officeSide";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, useHorizonFonts } from "./shipmentDetailTheme";

// ─── The carrier's Arrival Notice (DCSA Arrival Notice 1.0, phase 8, 2026-10-28) ─────────────────
// Import side, under Booking & Routing. Approved mockup 1bf14417 (tab 3): the key facts first (vessel,
// arrival, where to pick up and return, what's released), then free time checked against the containers
// (empty days were filled; a container that says otherwise asks keep or use), then the carrier's charges
// with "Add as accruals" (the user's decision: shown, added on a click; one that looks entered starts
// unticked), and "Generate AN01 from it". lib/arrival-notices.js holds the rules.

const card = () => ({ background: HZ.surface, backdropFilter: "blur(20px)", border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10, padding: 18 });
const day = s => (s ? new Date(`${String(s).slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const when = s => (s ? new Date(s).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const money = (cur, n) => `${cur} ${Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const UNIT = { CD: "calendar days", WD: "working days" };

const Pill = ({ tone = "info", children, id }) => {
  const [bg, fg] = { good: [HZ.goodBg, HZ.goodPillText], warn: [HZ.warnBg, HZ.warn], crit: [HZ.critBg, HZ.crit], info: [HZ.infoBg, HZ.infoPillText] }[tone];
  return <span id={id} style={{ fontFamily: HZ_MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: ".06em", padding: "3px 9px", borderRadius: 999, background: bg, color: fg, whiteSpace: "nowrap" }}>{children}</span>;
};

const ShipmentArrivalNoticePage = ({ shipment }) => {
  useHorizonFonts();
  const auth = useAuth();
  const canEdit = canEditShipmentSide(auth, shipment, "import");
  const carrier = shipment.carrierCode || "the carrier";
  const [an, setAn] = useState(undefined); // undefined = loading, null = none yet
  const [picked, setPicked] = useState({});
  const [busy, setBusy] = useState("");
  const [genDocOpen, setGenDocOpen] = useState(false);

  // A charge that looks already entered starts unticked; one already added can't be ticked.
  const show = v => { setAn(v); setPicked(Object.fromEntries((v?.charges || []).map(c => [c.index, !c.looksEntered && !c.addedCostLineId]))); };
  useEffect(() => { api.arrivalNotice.get(shipment.id).then(show).catch(() => setAn(null)); }, [shipment.id]);

  const act = async (key, fn, done) => {
    setBusy(key);
    try { const v = await fn(); if (v) show(v.arrivalNotice || v); if (done) toast.success(done); }
    catch (e) { toast.error(e.message); }
    setBusy("");
  };
  const refresh = () => act("refresh", () => api.arrivalNotice.refresh(shipment.id), `Asked ${carrier}`);
  const settle = (f, use) => act(`ft-${f.containerId}-${f.kind}`, () => api.arrivalNotice.freeTime(shipment.id, { containerId: f.containerId, kind: f.kind, use }),
    use ? `${f.containerNumber}: ${f.label.toLowerCase()} free days set to ${f.days}` : `Kept ${f.onContainer} ${f.label.toLowerCase()} days on ${f.containerNumber}`);
  const chosen = (an?.charges || []).filter(c => picked[c.index] && !c.addedCostLineId);
  const accrue = () => act("accrue", () => api.arrivalNotice.accrue(shipment.id, chosen.map(c => c.index)),
    `${chosen.length} accrual${chosen.length === 1 ? "" : "s"} added to Cost Entry`);

  if (an === undefined) return <div style={{ padding: 40, display: "flex", justifyContent: "center" }}><Spinner /></div>;

  const header = (
    <div style={card()}>
      <h3 style={{ fontFamily: HZ_DISPLAY, fontSize: 14, fontWeight: 700, color: HZ.text, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 6 }}>
        <IconMailUnread size={14} /> Arrival Notice
      </h3>
      <div style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted, lineHeight: 1.55 }}>
        {carrier}'s DCSA Arrival Notice for the shipment's Master or House B/L: when the vessel arrives, where to pick up and return the
        containers, the free time and the carrier's charges at destination. It arrives on its own when the carrier publishes it.
      </div>
    </div>
  );

  if (!an) return (
    <div id="shpan-page" style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
      {header}
      <div id="shpan-empty" style={{ ...card(), display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>
        <span style={{ flex: "1 1 320px" }}>No Arrival Notice from {carrier} yet.</span>
        {canEdit && <Btn id="shpan-refresh-btn" size="sm" variant="secondary" disabled={!!busy} onClick={refresh}>{busy === "refresh" ? "Asking…" : `Ask ${carrier} now`}</Btn>}
      </div>
    </div>
  );

  const f = an.facts || {};
  const previous = an.versions.find(v => !v.isCurrent && v.issueDateTime < an.issueDateTime);
  const released = (v, yes, no) => (v === true ? <Pill tone="good">✓ {yes}</Pill> : v === false ? <Pill tone="warn">{no}</Pill> : <span style={{ color: HZ.textMuted }}>—</span>);
  const fact = (label, value, id) => (
    <div id={id} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "6px 0", borderBottom: `1px solid ${HZ.border}` }}>
      <span style={{ color: HZ.textMuted }}>{label}</span><span style={{ textAlign: "right" }}>{value}</span>
    </div>
  );
  const th = { textAlign: "left", padding: "8px 12px", fontSize: 10.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: HZ.textMuted, borderBottom: `1px solid ${HZ.border}`, whiteSpace: "nowrap" };
  const td = { padding: "8px 12px", borderBottom: `1px solid ${HZ.border}`, verticalAlign: "top" };
  const linkBtn = { background: "none", border: "none", color: HZ.cyan, cursor: "pointer", fontFamily: HZ_BODY, fontSize: 12, padding: "0 4px" };
  const totalChosen = chosen.reduce((n, c) => n + c.amount, 0);
  const chosenCur = chosen[0]?.currency || "USD";

  return (
    <div id="shpan-page" style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18, fontFamily: HZ_BODY }}>
      {genDocOpen && <GenerateDocumentModal shipment={shipment} defaultCode="AN01" onClose={() => setGenDocOpen(false)} onSaved={() => setGenDocOpen(false)} />}
      {header}

      <div style={{ ...card(), padding: 0 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px", padding: "14px 18px", borderBottom: `1px solid ${HZ.border}` }}>
          <span style={{ fontFamily: HZ_DISPLAY, fontSize: 15, fontWeight: 800, color: HZ.text }}>Arrival Notice from {an.carrierCode || carrier}</span>
          <Pill id="shpan-version" tone="info">VERSION {an.version || "1"}</Pill>
          <span style={{ fontSize: 12, color: HZ.textMuted }}>received {when(an.receivedAt)} · for B/L <span style={{ fontFamily: HZ_MONO }}>{an.transportDocumentReference}</span></span>
          {an.isMock && <span style={{ marginLeft: "auto", fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, padding: "3px 7px", borderRadius: 4, background: HZ.violetBg, color: HZ.violetPillText }}>DEMO CARRIER</span>}
        </div>
        <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
          {an.etaChange && (
            <div id="shpan-banner" style={{ fontSize: 12.5, lineHeight: 1.55, padding: "10px 12px", borderRadius: 8, background: HZ.warnBg, color: HZ.text }}>
              {previous ? `Version ${an.version} replaces version ${previous.version} (${day(previous.issueDateTime)}). ` : ""}
              The shipment's ETA moved from {day(an.etaChange.from)} to <b>{day(an.etaChange.to)}</b>.
            </div>
          )}
          <div id="shpan-facts" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "4px 28px", fontSize: 12.5, color: HZ.text }}>
            {fact("Vessel", <>{f.vessel || "—"} {f.voyage && <span style={{ fontFamily: HZ_MONO }}>{f.voyage}</span>}</>)}
            {fact(`Arrives at ${f.portOfDischarge || shipment.pod || "the port"}`, f.arrival
              ? <><b>{day(f.arrival.date)}</b> <span style={{ color: HZ.textMuted }}>· {f.arrival.classifier === "ACTUAL" ? "arrived" : f.arrival.classifier === "PLANNED" ? "planned" : "ETA"}</span></> : "—", "shpan-arrival")}
            {fact("Pick up at", [f.pickup?.location?.name, f.pickup?.location?.unLocationCode].filter(Boolean).join(" · ") || "—")}
            {fact("Pickup number", <span style={{ fontFamily: HZ_MONO }}>{f.pickup?.number || "—"}</span>)}
            {fact("Return empties to", <>{f.returnTo?.location?.name || "—"}{f.returnTo?.reference && <> · <span style={{ fontFamily: HZ_MONO }}>{f.returnTo.reference}</span></>}</>)}
            {fact("Freight", released(f.release?.freight, "RELEASED", "NOT RELEASED"))}
            {fact("Original B/L received", released(f.release?.originalBl, "RECEIVED", "NOT YET"))}
            {fact("Customs", <>{released(f.release?.customs, "RELEASED", "NOT RELEASED")}{f.customs?.manifest && <span style={{ color: HZ.textMuted }}> · manifest {f.customs.manifest}</span>}</>)}
          </div>
          {an.versions.length > 1 && (
            <div style={{ fontSize: 11.5, color: HZ.textMuted }}>
              Versions: {an.versions.map(v => `${v.version || "?"}${v.isCurrent ? " (current)" : ""} · ${day(v.issueDateTime)}`).join("; ")}. History keeps each one.
            </div>
          )}
        </div>
      </div>

      {an.freeTime.length > 0 && (
        <div style={{ ...card(), display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontFamily: HZ_DISPLAY, fontSize: 14, fontWeight: 700, color: HZ.text }}>Free time</span>
            <span style={{ fontSize: 12, color: HZ.textMuted }}>checked against the containers</span>
          </div>
          <div style={{ overflowX: "auto", border: `1px solid ${HZ.border}`, borderRadius: 8 }}>
            <table id="shpan-free-time" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, color: HZ.text, minWidth: 620 }}>
              <thead><tr><th style={th}>Container</th><th style={th}>Kind</th><th style={{ ...th, textAlign: "right" }}>{an.carrierCode || carrier} gives</th><th style={th}>Last free day</th><th style={th}>On the container</th></tr></thead>
              <tbody>
                {an.freeTime.map(x => (
                  <tr key={`${x.containerId}-${x.kind}`} data-testid={`shpan-ft-${x.containerNumber}-${x.kind}`}>
                    <td style={{ ...td, fontFamily: HZ_MONO }}>{x.containerNumber}</td>
                    <td style={td}>{x.label}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{x.days} {UNIT[x.unit] || "days"}</td>
                    <td style={td}>{day(x.lastFreeDate)}</td>
                    <td style={td}>
                      {x.state === "filled" ? <Pill tone="good">FILLED · {x.days} DAYS</Pill>
                        : x.state === "same" ? <span style={{ color: HZ.good }}>✓ {x.onContainer} days</span>
                        : x.state === "kept" ? <Pill tone="info">KEPT {x.onContainer} DAYS</Pill>
                        : x.state === "empty" ? <span style={{ color: HZ.textMuted }}>not set</span>
                        : <>
                            <Pill tone="warn">SAYS {x.onContainer} DAYS</Pill>
                            {canEdit && <>
                              <button type="button" style={linkBtn} disabled={!!busy} onClick={() => settle(x, false)} data-testid={`shpan-ft-${x.containerNumber}-${x.kind}-keep`}>Keep {x.onContainer}</button>
                              <button type="button" style={linkBtn} disabled={!!busy} onClick={() => settle(x, true)} data-testid={`shpan-ft-${x.containerNumber}-${x.kind}-use`}>Use {x.days}</button>
                            </>}
                          </>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: HZ.textMuted }}>Empty free days on a container are filled from the notice. Where the container already says something else, you choose; nothing is overwritten silently.</div>
        </div>
      )}

      {an.charges.length > 0 && (
        <div style={{ ...card(), display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontFamily: HZ_DISPLAY, fontSize: 14, fontWeight: 700, color: HZ.text }}>{an.carrierCode || carrier}'s charges</span>
            <span style={{ fontSize: 12, color: HZ.textMuted }}>{an.charges.every(c => c.paymentTermCode === "COL") ? "collect at destination" : "as the carrier lists them"}</span>
          </div>
          <div style={{ overflowX: "auto", border: `1px solid ${HZ.border}`, borderRadius: 8 }}>
            <table id="shpan-charges" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, color: HZ.text, minWidth: 620 }}>
              <thead><tr><th style={{ ...th, width: 36 }}><span style={{ position: "absolute", left: -9999 }}>Add</span></th><th style={th}>Charge</th><th style={th}>Basis</th>
                <th style={{ ...th, textAlign: "right" }}>Amount</th><th style={th}>On the shipment</th></tr></thead>
              <tbody>
                {an.charges.map(c => (
                  <tr key={c.index} data-testid={`shpan-charge-${c.index}`}>
                    <td style={td}>
                      <input type="checkbox" id={`shpan-charge-${c.index}-pick`} checked={!!picked[c.index] && !c.addedCostLineId} disabled={!canEdit || !!c.addedCostLineId}
                        onChange={e => setPicked(p => ({ ...p, [c.index]: e.target.checked }))} aria-label={`Add ${c.name}`} />
                    </td>
                    <td style={td}><label htmlFor={`shpan-charge-${c.index}-pick`}>{c.name}</label>
                      {c.chargeCode !== "Other" && <div style={{ fontSize: 11, color: HZ.textMuted }}>as {c.chargeCode}</div>}</td>
                    <td style={{ ...td, color: HZ.textMuted }}>{c.quantity && c.unitPrice ? `${c.quantity} × ${money(c.currency, c.unitPrice)}` : (c.basis || "—").toLowerCase().replace(/_/g, " ")}</td>
                    <td style={{ ...td, textAlign: "right", fontFamily: HZ_MONO, fontVariantNumeric: "tabular-nums" }}>{money(c.currency, c.amount)}</td>
                    <td style={td}>
                      {c.addedCostLineId ? <Pill tone="good">ADDED · BUY ACCRUAL</Pill>
                        : c.looksEntered ? <><Pill tone="warn">LOOKS ENTERED</Pill><div style={{ fontSize: 11, color: HZ.textMuted, marginTop: 4 }}>{c.looksEntered}</div></>
                        : <span style={{ color: HZ.textMuted }}>not yet</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, justifyContent: "flex-end" }}>
            <span style={{ marginRight: "auto", fontSize: 11.5, color: HZ.textMuted }}>Each one becomes a BUY accrual from {an.carrierCode || carrier} on this shipment. A charge that looks already entered starts unticked.</span>
            {canEdit && <Btn id="shpan-accrue-btn" size="sm" disabled={!!busy || !chosen.length} onClick={accrue}>
              {busy === "accrue" ? "Adding…" : chosen.length ? `Add ${chosen.length} as accruals (${money(chosenCur, totalChosen)})` : "Add as accruals"}</Btn>}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        {canEdit && <Btn id="shpan-refresh-btn" size="sm" variant="secondary" disabled={!!busy} onClick={refresh}>{busy === "refresh" ? "Asking…" : `Ask ${an.carrierCode || carrier} again`}</Btn>}
        <Btn id="shpan-an01-btn" size="sm" variant="secondary" onClick={() => setGenDocOpen(true)}>Generate AN01 from it</Btn>
      </div>
    </div>
  );
};

export default ShipmentArrivalNoticePage;
