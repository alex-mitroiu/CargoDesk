import { useEffect, useState } from "react";
import { api } from "../../api";

// Dashboard → Steering (Epic TKT-KFGL81, Story 4 TKT-Q2E7WN; approved mockup
// https://claude.ai/artifact/KTkERe9u1qHg1yaESQaCEm). How many shipments followed the Lane Steering in
// the Dashboard's dates: the verdict each one got when its contract was saved (lib/where-to-book.js),
// counted by GET /api/reports/steering. Nothing is worked out here. hz: the Dashboard's Trade Horizon
// tokens; carriers: the Dashboard's carrier filter (null = all).

// The verdicts in the rate, each with its colour and wording, in the bar's order.
const IN_RATE = [
  { key: "steered",        label: "Steered",                color: hz => hz.good },
  { key: "rebooked",       label: "Rebooked down the line", color: () => "#199e70" },
  { key: "out_of_order",   label: "Out of order",           color: hz => hz.warning },
  { key: "other_contract", label: "Other contract",         color: () => "#d95926" },
  { key: "other_carrier",  label: "Other carrier",          color: hz => hz.critical },
  { key: "spot",           label: "SPOT",                   color: hz => hz.available },
  { key: "other_loop",     label: "Other loop",             color: hz => hz.inkMuted },
];
const LABEL = Object.fromEntries(IN_RATE.map(v => [v.key, v.label]));
const pct = r => (r == null ? "—" : `${Number.isInteger(r) ? r : r.toFixed(1)}%`);
const shipmentsWord = n => `${n} shipment${n === 1 ? "" : "s"}`;
const fmt = d => d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "—";

export default function SteeringReport({ hz, rangeStart, rangeEnd, carriers = null }) {
  const [data, setData] = useState(null);
  const [lane, setLane] = useState("");
  const [error, setError] = useState("");
  const carrierKey = carriers ? [...carriers].sort().join(",") : "";

  useEffect(() => {
    let live = true;
    setData(null); setError("");
    api.reports.steering({ from: rangeStart, to: rangeEnd, ...(carrierKey && { carrier: carrierKey }), ...(lane && { lane }) })
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) setError(e.message || "The report couldn't be loaded"); });
    return () => { live = false; };
  }, [rangeStart, rangeEnd, carrierKey, lane]);

  const card = { background: hz.surface, border: `1px solid ${hz.border}`, boxShadow: hz.cardShadow, borderRadius: 16, padding: "18px 20px" };
  const h3 = { fontFamily: hz.fontDisplay, fontSize: 15, fontWeight: 600, color: hz.ink, margin: "0 0 10px" };
  const th = { textAlign: "left", fontFamily: hz.fontBody, fontSize: 10.5, fontWeight: 600, color: hz.inkMuted, textTransform: "uppercase", letterSpacing: ".07em",
    padding: "7px 8px", borderBottom: `1px solid ${hz.border}`, whiteSpace: "nowrap" };
  const td = { padding: "8px", borderBottom: `1px solid ${hz.borderSoft}`, fontFamily: hz.fontMono, fontSize: 12, color: hz.ink, fontVariantNumeric: "tabular-nums" };
  const num = { ...td, textAlign: "right" };

  if (error) return <div data-testid="steering-report-error" style={{ ...card, fontFamily: hz.fontBody, fontSize: 13, color: hz.critical }}>{error}</div>;
  if (!data) return <div style={{ ...card, fontFamily: hz.fontBody, fontSize: 13, color: hz.inkMuted }}>Loading the steering report…</div>;

  const outside = data.counts.not_covered + data.counts.not_recorded;
  const laneOptions = data.byLane.map(l => l.lane).filter(Boolean);
  return (
    <div data-testid="steering-report" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, fontFamily: hz.fontBody, fontSize: 12.5, color: hz.inkMuted }}>
        <span>Shipments sailing {fmt(data.from)} – {fmt(data.to)}, by the verdict saved when their contract was assigned.</span>
        <label htmlFor="steering-report-lane" style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
          Trade lane
          <select id="steering-report-lane" data-testid="steering-report-lane" value={lane} onChange={e => setLane(e.target.value)}
            style={{ background: hz.surfaceStrong, color: hz.ink, border: `1px solid ${hz.border}`, borderRadius: 7, padding: "6px 10px", fontFamily: hz.fontMono, fontSize: 12 }}>
            <option value="">All lanes</option>
            {[...new Set([...(lane ? [lane] : []), ...laneOptions])].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      </div>

      {data.total === 0 ? (
        <div data-testid="steering-report-empty" style={{ ...card, fontFamily: hz.fontBody, fontSize: 13, color: hz.inkMuted }}>
          No shipments on a contract sail in these dates{lane ? ` on ${lane}` : ""}.
        </div>
      ) : (<>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <div data-testid="steering-report-rate" style={{ ...card, flex: "1 1 240px", display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontFamily: hz.fontBody, fontSize: 12.5, color: hz.inkMuted }}>Steering rate</span>
            <span style={{ fontFamily: hz.fontMono, fontSize: 42, fontWeight: 700, lineHeight: 1, color: hz.ink }}>{pct(data.rate)}</span>
            <span style={{ fontFamily: hz.fontBody, fontSize: 12.5, color: hz.ink }}>{data.followed} of {shipmentsWord(data.inRate)} followed the steering</span>
            {outside > 0 && (
              <span style={{ fontFamily: hz.fontBody, fontSize: 12, color: hz.inkMuted }}>
                {outside} more outside the rate: {data.counts.not_covered} not covered (no steering or no space), {data.counts.not_recorded} assigned before this was recorded
              </span>
            )}
          </div>
          <div style={{ ...card, flex: "999 1 520px", minWidth: 0, display: "flex", flexDirection: "column", gap: 12 }}>
            <span style={{ fontFamily: hz.fontBody, fontSize: 12.5, color: hz.inkMuted }}>{data.inRate === 1 ? "The shipment" : `The ${data.inRate} shipments`} in the rate</span>
            {data.inRate > 0 && (
              <div role="img" aria-label={IN_RATE.map(v => `${v.label} ${data.counts[v.key]}`).join(", ")} style={{ display: "flex", gap: 2, height: 16 }}>
                {IN_RATE.filter(v => data.counts[v.key] > 0).map((v, i, all) => (
                  <div key={v.key} title={`${v.label}: ${data.counts[v.key]}`}
                    style={{ flex: `${data.counts[v.key]} 1 0`, background: v.color(hz), borderRadius: `${i === 0 ? 4 : 0}px ${i === all.length - 1 ? 4 : 0}px ${i === all.length - 1 ? 4 : 0}px ${i === 0 ? 4 : 0}px` }} />
                ))}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: "6px 16px" }}>
              {IN_RATE.map(v => (
                <span key={v.key} data-testid={`steering-report-count-${v.key}`} style={{ fontFamily: hz.fontBody, fontSize: 12.5, color: hz.inkMuted, display: "flex", alignItems: "center", gap: 6 }}>
                  <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 2, background: v.color(hz) }} />
                  {v.label} <b style={{ fontFamily: hz.fontMono, color: hz.ink }}>{data.counts[v.key]}</b>
                </span>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
          <section aria-label="By trade lane" style={{ ...card, flex: "1 1 400px", minWidth: 0, overflowX: "auto" }}>
            <h3 style={h3}>By trade lane</h3>
            <table data-testid="steering-report-lanes" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Lane</th><th style={{ ...th, textAlign: "right" }}>In the rate</th><th style={{ ...th, textAlign: "right" }}>Followed</th>
                <th style={{ ...th, textAlign: "right" }}>Rate</th><th style={{ ...th, textAlign: "right" }}>Not covered</th></tr></thead>
              <tbody>{data.byLane.map(l => (
                <tr key={l.lane}><td style={td}>{l.lane || "—"}</td><td style={num}>{l.inRate}</td><td style={num}>{l.followed}</td>
                  <td style={{ ...num, color: l.rate != null && l.rate < 80 ? hz.warning : hz.ink }}>{pct(l.rate)}</td><td style={{ ...num, color: hz.inkMuted }}>{l.notCovered}</td></tr>
              ))}</tbody>
            </table>
          </section>
          <section aria-label="By carrier booked" style={{ ...card, flex: "1 1 400px", minWidth: 0, overflowX: "auto" }}>
            <h3 style={h3}>By carrier booked</h3>
            <table data-testid="steering-report-carriers" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr><th style={th}>Carrier</th><th style={{ ...th, textAlign: "right" }}>Shipments</th><th style={{ ...th, textAlign: "right" }}>Steered there</th>
                <th style={{ ...th, textAlign: "right" }}>Not steered</th></tr></thead>
              <tbody>{data.byCarrier.map(c => (
                <tr key={c.carrierCode}><td style={td}>{c.carrierCode}</td><td style={num}>{c.shipments}</td><td style={num}>{c.followed}</td>
                  <td style={{ ...num, color: c.notFollowed ? hz.warning : hz.ink }}>{c.notFollowed}</td></tr>
              ))}</tbody>
            </table>
          </section>
        </div>

        <section aria-label="Didn't follow the steering" style={{ ...card, overflowX: "auto" }}>
          <h3 style={h3}>Didn’t follow the steering ({data.notFollowedShipments.length})</h3>
          {data.notFollowedShipments.length === 0 ? (
            <span style={{ fontFamily: hz.fontBody, fontSize: 13, color: hz.inkMuted }}>Every shipment in the rate followed the steering.</span>
          ) : (
            <table data-testid="steering-report-not-followed" style={{ width: "100%", minWidth: 860, borderCollapse: "collapse" }}>
              <thead><tr>{["Shipment", "ETD", "Lane", "Booked", "The pick was", "Verdict", "Reason given"].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>{data.notFollowedShipments.map(s => (
                <tr key={s.id}>
                  <td style={td}>
                    <a href={`${window.location.pathname}#shipments/${s.id}`} target="_blank" rel="noreferrer" style={{ color: hz.gradCyan[0], fontWeight: 600 }}>{s.id}</a>
                  </td>
                  <td style={td}>{fmt(s.etd)}</td>
                  <td style={td}>{s.lane || "—"}</td>
                  <td style={td}>{s.contractType === "SPOT" ? `SPOT ${s.carrierCode}` : `${s.rank ? `#${s.rank} ` : ""}${s.carrierCode} ${s.contractRef || ""}`}</td>
                  <td style={{ ...td, color: hz.inkMuted }}>{s.pick?.rank ? `#${s.pick.rank} ${s.pick.carrierCode}${s.pick.orderOnly ? " (no cap)" : ` · ${s.pick.freeTeu ?? 0} TEU free`}` : "—"}</td>
                  <td style={td}><span style={{ fontFamily: hz.fontMono, fontSize: 10.5, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
                    color: hz.warning, background: hz.warning + "22" }}>{(LABEL[s.verdict] || s.verdict).toUpperCase()}</span></td>
                  <td style={{ ...td, fontFamily: hz.fontBody, color: s.reason ? hz.ink : hz.inkMuted }}>{s.reason || "No reason given"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      </>)}
    </div>
  );
}
