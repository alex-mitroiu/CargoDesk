import { useState, useEffect } from "react";
import { T, todayIso } from "../../tokens";
import { api } from "../../api";
import Spinner from "../primitives/Spinner";
import DatePicker from "../primitives/DatePicker";
import { Sel } from "../primitives/Form";

// Reports → Carrier Responses (Epic TKT-ASIYFL, Story 7; approved mockup
// https://claude.ai/artifact/FXrT7utJNRgPabknbKyPmR, "Carrier responses" artboard): how carriers answer
// booking requests — how many got no decision, how long a decision takes, and how many were confirmed,
// confirmed with changes or rejected. Counted per request, by the date it was sent
// (routes/reports.js /api/reports/carrier-responses).

const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmt = n => Number(n || 0).toLocaleString("en-US");
const pct = (n, of) => (of ? (n / of) * 100 : 0);
const fmtTime = s => s == null ? "—" : s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")} min`;
const COLS = "minmax(170px, 1.6fr) repeat(2, 80px) 170px 100px repeat(3, 90px)";

const NoAnswer = ({ row }) => {
  const share = pct(row.noAnswer, row.sent);
  return (
    <span title={`${row.carrierCode || "All carriers"}: ${fmt(row.noAnswer)} of ${fmt(row.sent)} requests got no decision`}
      style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ flex: "0 0 56px", height: 6, borderRadius: 3, background: `${T.border}`, overflow: "hidden" }}>
        <span style={{ display: "block", height: "100%", width: `${Math.max(row.noAnswer ? 4 : 0, share).toFixed(1)}%`, background: T.danger, borderRadius: 3 }} />
      </span>
      <span style={{ fontFamily: T.mono, fontSize: 12, color: row.noAnswer ? T.text : T.textMuted }}>{fmt(row.noAnswer)} · {share.toFixed(1)}%</span>
    </span>
  );
};

const Row = ({ row, total = false }) => (
  <div data-testid={total ? "carrier-responses-total" : `carrier-responses-row-${row.carrierCode}`}
    style={{ display: "grid", gridTemplateColumns: COLS, gap: 10, alignItems: "center", padding: "10px 16px",
      borderTop: `1px solid ${total ? T.border : `${T.border}55`}`, background: total ? T.bg : "transparent" }}>
    <span style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
      <b style={{ fontFamily: total ? T.body : T.mono, fontSize: 12.5, color: T.text }}>{total ? "All carriers" : row.carrierCode}</b>
      {!total && <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.carrierName}</span>}
    </span>
    {[row.sent, row.decided].map((n, i) => <span key={i} style={{ fontFamily: T.mono, fontSize: 12, color: T.text, textAlign: "right" }}>{fmt(n)}</span>)}
    <NoAnswer row={row} />
    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text, textAlign: "right" }}>{fmtTime(row.medianSeconds)}</span>
    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text, textAlign: "right" }}>{fmt(row.confirmed)}</span>
    <span style={{ fontFamily: T.mono, fontSize: 12, color: row.changed ? T.warning : T.textMuted, textAlign: "right" }}>{fmt(row.changed)}</span>
    <span style={{ fontFamily: T.mono, fontSize: 12, color: row.rejected ? T.danger : T.textMuted, textAlign: "right" }}>{fmt(row.rejected)}</span>
  </div>
);

const toCsv = data => {
  const head = ["Carrier", "Name", "Sent", "Decided", "No answer", "No answer %", "Waiting", "Median seconds to a decision", "Confirmed", "With changes", "Rejected", "Update requested"];
  const line = r => [r.carrierCode || "All carriers", r.carrierName, r.sent, r.decided, r.noAnswer, pct(r.noAnswer, r.sent).toFixed(1), r.waiting,
    r.medianSeconds ?? "", r.confirmed, r.changed, r.rejected, r.updateRequested];
  const esc = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [head, ...data.carriers.map(line), ...(data.total ? [line(data.total)] : [])].map(r => r.map(esc).join(",")).join("\n");
};

const CarrierResponsesPanel = () => {
  const [from, setFrom] = useState(() => addDays(todayIso(), -30));
  const [to, setTo] = useState(() => todayIso());
  const [lane, setLane] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setData(null); setError("");
    api.reports.carrierResponses({ from, to, lane }).then(d => !cancelled && setData(d)).catch(e => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [from, to, lane]);

  const download = () => {
    const blob = new Blob([toCsv(data)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `carrier-responses-${from || "start"}-${to || "today"}${lane ? `-${lane.replace(/\W+/g, "")}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div id="carrier-responses-panel" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 10, background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px" }}>
        <div style={{ width: 180 }}><DatePicker id="cr-from" label="From" value={from} onChange={setFrom} maxDate={to || undefined} /></div>
        <div style={{ width: 180 }}><DatePicker id="cr-to" label="To" value={to} onChange={setTo} minDate={from || undefined} /></div>
        <div style={{ width: 190 }}>
          <Sel id="cr-lane" label="Lane" value={lane} onChange={setLane}
            options={[{ value: "", label: "All lanes" }, ...(data?.lanes || (lane ? [lane] : [])).map(l => ({ value: l, label: l }))]} />
        </div>
        <span style={{ flex: 1, minWidth: 180, textAlign: "right", fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>Counted by the date each booking request was sent</span>
      </div>

      {error ? (
        <div style={{ padding: 32, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.danger }}>{error}</div>
      ) : !data ? (
        <div style={{ padding: 40, display: "flex", justifyContent: "center" }}><Spinner /></div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button type="button" onClick={download} disabled={!data.carriers.length} data-testid="carrier-responses-csv"
              style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 12px", cursor: data.carriers.length ? "pointer" : "not-allowed",
                color: T.textMuted, fontFamily: T.body, fontSize: 12.5, fontWeight: 600, opacity: data.carriers.length ? 1 : .5 }}>⬇ Export CSV</button>
          </div>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflowX: "auto" }}>
            <div style={{ minWidth: 900 }}>
              <div style={{ display: "grid", gridTemplateColumns: COLS, gap: 10, padding: "10px 16px", fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
                <span>Carrier</span><span style={{ textAlign: "right" }}>Sent</span><span style={{ textAlign: "right" }}>Decided</span><span>No answer</span>
                <span style={{ textAlign: "right" }}>Median time</span><span style={{ textAlign: "right" }}>Confirmed</span><span style={{ textAlign: "right" }}>With changes</span><span style={{ textAlign: "right" }}>Rejected</span>
              </div>
              {data.carriers.length === 0 ? (
                <div style={{ padding: "28px 16px", borderTop: `1px solid ${T.border}55`, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
                  No booking requests were sent in this period{lane ? ` on ${lane}` : ""}.
                </div>
              ) : (
                <>
                  {data.carriers.map(r => <Row key={r.carrierCode} row={r} />)}
                  {data.total && <Row row={data.total} total />}
                </>
              )}
            </div>
          </div>
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.6 }}>
            “Decided” means confirmed, confirmed with changes, rejected or update requested; the automatic RECEIVED isn't a decision. A request
            without a decision counts as “no answer” after the no-answer time ({data.noAnswerHours} h, App Settings → Bookings)
            {data.total?.waiting ? `; ${fmt(data.total.waiting)} still inside it ${data.total.waiting === 1 ? "is" : "are"} waiting` : ""}. The median time runs to the carrier's first decision.
          </span>
        </>
      )}
    </div>
  );
};

export default CarrierResponsesPanel;
