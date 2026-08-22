import { useState, useEffect } from "react";
import { T, todayIso, addDays } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import GpBreakdownPanel from "../components/shared/GpBreakdownPanel";
import BillingPerformancePanel from "../components/shared/BillingPerformancePanel";
import DatePicker from "../components/primitives/DatePicker";
import Btn from "../components/primitives/Btn";

const fmtUsd = v => `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

const GROUP_MODES = {
  region:  { label: "By Region",  column: "Region",  plural: "regions" },
  country: { label: "By Country", column: "Country", plural: "countries" },
  carrier: { label: "By Carrier", column: "Carrier", plural: "carriers" },
};

// ─── GP by Trade Area — Region / Country / Carrier ─────────────────────────
// Aggregates every shipment's own BUY/SELL cost lines by origin (POL) region/country, or by
// carrier, then hands the same aggregated array to GpBreakdownPanel (stat cards, Profit
// Breakdown Sankey, CPI/charge-code tables) the shipment GP Overview page already uses — the
// whole point being that view was never actually shipment-specific, just shipment-scoped by
// default. "Where is the business losing money" is the list view itself (sorted worst-margin-
// first once a target's configured); drilling into one group is the "why".
const ReportsPage = () => {
  // TKT-B4VBDH — Billing Performance joins GP by Trade Area as a second top-level tab on this
  // page rather than its own nav item, mirroring DashboardPage.jsx's own tab-bar pattern for
  // "several distinct reports under one nav entry."
  const [tab, setTab] = useState("gp"); // "gp" | "billing"
  const [groupBy, setGroupBy] = useState("region"); // "region" | "country" | "carrier"
  // Default window is today -> today+30 (a forward-looking "what's coming up" slice) rather
  // than all-time — "" still means no bound at all, reachable via Clear below, since an
  // investigation into a specific past quarter needs to leave one or both sides open.
  const [dateFrom, setDateFrom] = useState(() => todayIso());        // YYYY-MM-DD, "" = no lower bound
  const [dateTo,   setDateTo]   = useState(() => addDays(todayIso(), 30)); // YYYY-MM-DD, "" = no upper bound
  const [list,        setList]        = useState([]);   // browse-mode summary rows
  const [targetPct,   setTargetPct]   = useState(null);  // Application Settings -> Finance -> "Reports - GP Target"
  const [comparisonAvailable, setComparisonAvailable] = useState(false); // needs both From and To set
  const [listLoading, setListLoading] = useState(true);
  const [selected, setSelected] = useState(null);     // code of the picked region/country/carrier
  const [lines,    setLines]    = useState([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const mode = GROUP_MODES[groupBy];

  // groupBy switches invalidate the selected code's meaning (a country code isn't a carrier
  // code) so that clears the selection; a date-range change on its own deliberately keeps
  // whatever's selected and just re-fetches it — "how did this region do last quarter vs this
  // one" is the more useful behavior than getting kicked back to the list on every date edit.
  useEffect(() => { setSelected(null); }, [groupBy]);

  useEffect(() => {
    setListLoading(true);
    api.reports.gpByGeo(groupBy, null, dateFrom, dateTo)
      .then(({ results, targetPct, comparisonAvailable }) => { setList(results); setTargetPct(targetPct); setComparisonAvailable(!!comparisonAvailable); })
      .catch(() => { setList([]); setTargetPct(null); setComparisonAvailable(false); })
      .finally(() => setListLoading(false));
  }, [groupBy, dateFrom, dateTo]);

  useEffect(() => {
    if (!selected) { setLines([]); return; }
    setLinesLoading(true);
    api.reports.gpByGeo(groupBy, selected, dateFrom, dateTo).then(setLines).catch(() => setLines([])).finally(() => setLinesLoading(false));
  }, [groupBy, selected, dateFrom, dateTo]);

  const runExport = async (value) => {
    setExporting(true);
    try { await api.reports.gpByGeoCSV(groupBy, value, dateFrom, dateTo); }
    catch { toast.error("Export failed"); }
    finally { setExporting(false); }
  };

  const th = { fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".07em" };

  return (
    <div id="reports-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 22, fontWeight: 800, color: T.text, margin: "0 0 4px" }}>Reports</h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: 0 }}>
          {tab === "gp"
            ? "GP breakdown by trade area — origin region/country or carrier, from every shipment's own cost lines"
            : "Every generated invoice, filterable by status, sent, payment, office, customer, trade lane, and carrier"}
        </p>
      </div>

      <div id="reports-tab-bar" style={{ display: "flex", borderBottom: `1px solid ${T.border}`, marginBottom: 20 }}>
        {[{ key: "gp", label: "GP by Trade Area" }, { key: "billing", label: "Billing Performance" }].map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)} style={{
            padding: "10px 20px", background: "none", border: "none",
            borderBottom: tab === t.key ? `2px solid ${T.accent}` : "2px solid transparent",
            color: tab === t.key ? T.accent : T.textMuted,
            fontFamily: T.body, fontSize: 13, fontWeight: 600,
            cursor: "pointer", marginBottom: -1, transition: "color .15s, border-color .15s",
          }}>{t.label}</button>
        ))}
      </div>

      {tab === "billing" ? (
        <BillingPerformancePanel />
      ) : (
      <>
      <div id="reports-groupby-toggle" style={{ display: "inline-flex", gap: 2, padding: 3, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 9, marginBottom: 18 }}>
        {Object.entries(GROUP_MODES).map(([key, m]) => (
          <button key={key} type="button" onClick={() => setGroupBy(key)} style={{
            padding: "6px 14px", fontFamily: T.body, fontSize: 12.5, fontWeight: groupBy === key ? 700 : 500,
            color: groupBy === key ? T.btnPrimaryText : T.textMuted,
            background: groupBy === key ? T.accent : "transparent",
            border: "none", borderRadius: 6, cursor: "pointer", transition: "background .12s, color .12s",
          }}>{m.label}</button>
        ))}
      </div>

      <div id="reports-date-range" style={{ display: "flex", alignItems: "flex-end", gap: 10, marginBottom: 18,
        background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px" }}>
        <div style={{ width: 190 }}>
          <DatePicker label="From" value={dateFrom} onChange={setDateFrom} maxDate={dateTo || undefined} placeholder="Any" />
        </div>
        <div style={{ fontFamily: T.mono, fontSize: 16, color: T.textMuted, paddingBottom: 9, userSelect: "none" }}>—</div>
        <div style={{ width: 190 }}>
          <DatePicker label="To" value={dateTo} onChange={setDateTo} minDate={dateFrom || undefined} placeholder="Any" />
        </div>
        {(dateFrom || dateTo) && (
          <Btn variant="ghost" size="sm" onClick={() => { setDateFrom(""); setDateTo(""); }}>Clear</Btn>
        )}
        <div style={{ flex: 1, textAlign: "right", fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
          Filters by each shipment's ETD (or creation date, if not yet scheduled)
        </div>
      </div>

      {selected == null ? (
        listLoading ? (
          <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>Loading…</div>
        ) : list.length === 0 ? (
          <div id="reports-empty" style={{ padding: 48, textAlign: "center", fontFamily: T.body, fontSize: 13,
            color: T.textMuted, fontStyle: "italic", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
            No cost or invoice lines resolve to a known {groupBy} yet.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              {targetPct != null ? (
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  Sorted worst-margin-first against a <strong style={{ color: T.text }}>{targetPct}%</strong> target —
                  rows below it are flagged <span style={{ color: T.danger, fontWeight: 700 }}>●</span> below target.
                  {!comparisonAvailable && " Set both From and To to also see the trend vs the prior period."}
                </div>
              ) : !comparisonAvailable ? (
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                  Set both From and To to see each row's trend vs the prior period of equal length.
                </div>
              ) : <div />}
              <Btn variant="secondary" size="sm" onClick={() => runExport(null)} disabled={exporting}>
                {exporting ? "Exporting…" : "⬇ Export CSV"}
              </Btn>
            </div>
            <div id="reports-geo-table" style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface, overflowX: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", padding: "7px 16px",
                borderBottom: `1px solid ${T.border}`, background: T.bg, minWidth: comparisonAvailable ? 810 : 700 }}>
                <div style={{ ...th, flex: 1 }}>{mode.column}</div>
                <div style={{ ...th, width: 90, textAlign: "right" }}>Shipments</div>
                <div style={{ ...th, width: 110, textAlign: "right" }}>Sell</div>
                <div style={{ ...th, width: 110, textAlign: "right" }}>Buy</div>
                <div style={{ ...th, width: 110, textAlign: "right" }}>GP</div>
                <div style={{ ...th, width: 80, textAlign: "right" }}>Margin</div>
                {comparisonAvailable && <div style={{ ...th, width: 110, textAlign: "right" }}>Δ vs Prior</div>}
              </div>
              {list.map(r => {
                const belowTarget = targetPct != null && r.grossMarginPct != null && r.grossMarginPct < targetPct;
                return (
                  <div key={r.code} id={`reports-geo-row-${r.code}`} onClick={() => setSelected(r.code)}
                    style={{ display: "flex", alignItems: "center", padding: "10px 16px", cursor: "pointer",
                      borderBottom: `1px solid ${T.border}22`, borderLeft: `3px solid ${belowTarget ? T.danger : "transparent"}`,
                      minWidth: comparisonAvailable ? 810 : 700, transition: "background .1s" }}
                    onMouseEnter={e => e.currentTarget.style.background = T.bg}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <div style={{ flex: 1, fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text }}>
                      {belowTarget && <span title={`Below ${targetPct}% target`} style={{ color: T.danger, marginRight: 6 }}>●</span>}
                      {r.name} <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, fontWeight: 400 }}>{r.code}</span>
                    </div>
                    <div style={{ width: 90, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{r.shipmentCount}</div>
                    <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: T.success }}>{fmtUsd(r.totalSellUsd)}</div>
                    <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: T.warning }}>{fmtUsd(r.totalBuyUsd)}</div>
                    <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                      color: r.grossProfitUsd >= 0 ? T.success : T.danger }}>{fmtUsd(r.grossProfitUsd)}</div>
                    <div style={{ width: 80, textAlign: "right", fontFamily: T.mono, fontSize: 12, fontWeight: belowTarget ? 700 : 400,
                      color: belowTarget ? T.danger : T.textMuted }}>{r.grossMarginPct != null ? `${r.grossMarginPct}%` : "—"}</div>
                    {comparisonAvailable && (
                      <div style={{ width: 110, textAlign: "right", fontFamily: T.mono, fontSize: 12,
                        color: r.marginDeltaPts == null ? T.textMuted : r.marginDeltaPts > 0 ? T.success : r.marginDeltaPts < 0 ? T.danger : T.textMuted }}>
                        {r.marginDeltaPts == null ? "—"
                          : `${r.marginDeltaPts > 0 ? "▲" : r.marginDeltaPts < 0 ? "▼" : "▬"} ${Math.abs(r.marginDeltaPts)}pt${Math.abs(r.marginDeltaPts) === 1 ? "" : "s"}`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <Btn variant="secondary" size="sm" onClick={() => setSelected(null)}
              style={{ color: T.text, border: `1px solid ${T.borderMid}` }}>
              ← Back to {mode.plural}
            </Btn>
            <Btn variant="secondary" size="sm" onClick={() => runExport(selected)} disabled={exporting}>
              {exporting ? "Exporting…" : "⬇ Export CSV"}
            </Btn>
          </div>

          <GpBreakdownPanel
            lines={lines}
            loading={linesLoading}
            idPrefix="reports-gp"
            contextNode={<>read-only · {list.find(r => r.code === selected)?.name || selected} ({selected})</>}
            emptyLabel="No cost or invoice lines for this selection."
          />
        </>
      )}
      </>
      )}
    </div>
  );
};

export default ReportsPage;
