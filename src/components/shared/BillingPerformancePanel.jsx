import { useState, useEffect, useMemo } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import Spinner from "../primitives/Spinner";
import ShipmentGpSankey from "./ShipmentGpSankey";

// Billing Performance report (TKT-B4VBDH, Epic TKT-KR6ZBT) — row-level FR01/FR02 invoices,
// filterable by any combination of status/sent/paid and office/customer/lane/carrier, per
// direct request: "the granularity is important because of the performance metrics, and we can
// easily identify where we have certain problems." Deliberately a filter-and-scan table, not a
// single groupBy toggle like the GP-by-Trade-Area tab next to this one — the whole point here is
// slicing several dimensions at once (e.g. "unpaid AND overdue AND this one office").

const fmtUsd = v => v == null ? "—" : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = s => s ? new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";

// paymentState — the one status this report leads with: "is this paid, and if not, how late is
// it" is what a manager actually cares about, not the invoice document's own draft/confirmed/
// voided lifecycle label. A function, not a frozen object, since T's colors mutate in place on
// theme toggle (same class of bug this codebase already fixed once — see ShipmentGpSankey's own
// kindColor, v0.55.1's LEG_TYPE_COLOR note).
const PAYMENT_STATE_ORDER = ["missing", "draft", "unpaid", "partial", "overdue", "paid", "voided"];
const paymentStateMeta = state => ({
  missing: { label: "Missing", color: T.textMuted },
  draft:   { label: "Draft",   color: T.info },
  unpaid:  { label: "Unpaid",  color: T.textMuted },
  partial: { label: "Partial", color: T.warning },
  overdue: { label: "Overdue", color: T.danger },
  paid:    { label: "Paid",    color: T.success },
  voided:  { label: "Voided",  color: T.textMuted },
}[state] || { label: state, color: T.textMuted });

const Chip = ({ active, onClick, children, color }) => (
  <button type="button" onClick={onClick} style={{
    padding: "5px 12px", borderRadius: 20, cursor: "pointer",
    fontFamily: T.body, fontSize: 12, fontWeight: 600,
    border: `1px solid ${active ? (color || T.accent) : T.border}`,
    background: active ? `${color || T.accent}18` : "transparent",
    color: active ? (color || T.accent) : T.textMuted,
    transition: "background .12s, border-color .12s, color .12s",
  }}>
    {children}
  </button>
);

const Select = ({ value, onChange, options, placeholder }) => (
  <select value={value} onChange={e => onChange(e.target.value)} style={{
    padding: "7px 10px", borderRadius: 7, border: `1px solid ${T.border}`,
    background: T.surface, color: T.text, fontFamily: T.body, fontSize: 12.5, cursor: "pointer",
  }}>
    <option value="">{placeholder}</option>
    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>
);

const BillingPerformancePanel = () => {
  const [rows,    setRows]    = useState(null);
  const [error,   setError]   = useState(false);
  const [exporting, setExporting] = useState(false);

  const [stateFilter,  setStateFilter]  = useState(new Set());   // subset of PAYMENT_STATE_ORDER, empty = all
  const [sentFilter,   setSentFilter]   = useState("");           // "" | "sent" | "not_sent"
  const [officeId,     setOfficeId]     = useState("");
  const [customerId,   setCustomerId]   = useState("");
  const [laneCode,     setLaneCode]     = useState("");
  const [carrierCode,  setCarrierCode]  = useState("");

  const load = () => {
    setError(false);
    api.reports.billingPerformance().then(setRows).catch(() => { setRows([]); setError(true); });
  };
  useEffect(load, []);

  const toggleSet = (set, setSet, val) => {
    const next = new Set(set);
    next.has(val) ? next.delete(val) : next.add(val);
    setSet(next);
  };

  const facets = useMemo(() => {
    if (!rows) return { offices: [], customers: [], lanes: [], carriers: [] };
    const uniq = (key, nameKey) => {
      const seen = new Map();
      for (const r of rows) if (r[key] && !seen.has(r[key])) seen.set(r[key], r[nameKey] || r[key]);
      return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
    };
    return {
      offices:   uniq("officeId", "officeName"),
      customers: uniq("customerId", "customerName"),
      lanes:     uniq("laneCode", "laneName"),
      carriers:  uniq("carrierCode", "carrierName"),
    };
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    return rows.filter(r => {
      if (stateFilter.size && !stateFilter.has(r.paymentState)) return false;
      if (sentFilter === "sent" && !r.sent) return false;
      if (sentFilter === "not_sent" && r.sent) return false;
      if (officeId && r.officeId !== officeId) return false;
      if (customerId && r.customerId !== customerId) return false;
      if (laneCode && r.laneCode !== laneCode) return false;
      if (carrierCode && r.carrierCode !== carrierCode) return false;
      return true;
    });
  }, [rows, stateFilter, sentFilter, officeId, customerId, laneCode, carrierCode]);

  const stats = useMemo(() => {
    const confirmed = filtered.filter(r => r.status === "confirmed");
    const invoicedUsd = confirmed.reduce((s, r) => s + r.amountUsd, 0);
    const outstandingUsd = confirmed.reduce((s, r) => s + (r.outstandingUsd || 0), 0);
    const overdue = confirmed.filter(r => r.daysOverdue != null && r.daysOverdue > 0);
    const overdueUsd = overdue.reduce((s, r) => s + (r.outstandingUsd || 0), 0);
    const sentPct = confirmed.length ? Math.round(confirmed.filter(r => r.sent).length / confirmed.length * 100) : null;
    const paidPct = confirmed.length ? Math.round(confirmed.filter(r => r.paymentStatus === "paid").length / confirmed.length * 100) : null;
    const missingCount = filtered.filter(r => r.paymentState === "missing").length;
    return { invoicedUsd, outstandingUsd, overdueCount: overdue.length, overdueUsd, sentPct, paidPct, missingCount };
  }, [filtered]);

  const hasFilters = stateFilter.size || sentFilter || officeId || customerId || laneCode || carrierCode;
  const clearFilters = () => { setStateFilter(new Set()); setSentFilter(""); setOfficeId(""); setCustomerId(""); setLaneCode(""); setCarrierCode(""); };

  // Profit Breakdown graph — the same Sankey used on GP by Trade Area and the shipment GP
  // Overview page, scoped here to exactly the shipments behind whatever's currently filtered
  // below. Direct request: raw numbers in a table are "too complicated" for a quick read — a
  // picture of where the money's going answers "how are we looking" at a glance instead.
  const [gpLines, setGpLines] = useState(null);
  const shipmentIdsKey = useMemo(() => [...new Set(filtered.map(r => r.shipmentId))].sort().join(","), [filtered]);
  useEffect(() => {
    if (!shipmentIdsKey) { setGpLines([]); return; }
    api.reports.billingPerformanceGpLines(shipmentIdsKey.split(","))
      .then(({ lines }) => setGpLines(lines))
      .catch(() => setGpLines([]));
  }, [shipmentIdsKey]);

  const runExport = async () => {
    setExporting(true);
    try { await api.reports.billingPerformanceCSV(); }
    catch { toast.error("Export failed"); }
    finally { setExporting(false); }
  };

  const th = { fontFamily: T.body, fontSize: 10, fontWeight: 600, color: T.textMuted,
    textTransform: "uppercase", letterSpacing: ".07em" };

  if (rows === null) return <div style={{ padding: 40, textAlign: "center" }}><Spinner /></div>;
  if (error) return (
    <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
      Couldn't load the billing report — finance access may not be enabled for your account.
    </div>
  );

  const STAT_CARDS = [
    { label: "Invoiced", value: fmtUsd(stats.invoicedUsd), color: T.text },
    { label: "Outstanding", value: fmtUsd(stats.outstandingUsd), color: stats.outstandingUsd > 0 ? T.warning : T.text },
    { label: "Overdue", value: `${stats.overdueCount} · ${fmtUsd(stats.overdueUsd)}`, color: stats.overdueCount > 0 ? T.danger : T.text },
    { label: "Missing", value: `${stats.missingCount}`, color: stats.missingCount > 0 ? T.danger : T.text },
    { label: "Sent", value: stats.sentPct != null ? `${stats.sentPct}%` : "—", color: T.text },
    { label: "Paid", value: stats.paidPct != null ? `${stats.paidPct}%` : "—", color: T.text },
  ];

  return (
    <div id="billing-performance-panel">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 10, marginBottom: 18 }}>
        {STAT_CARDS.map(c => (
          <div key={c.label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em" }}>{c.label}</div>
            <div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: c.color, marginTop: 4 }}>{c.value}</div>
          </div>
        ))}
      </div>

      {gpLines === null ? (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 40, textAlign: "center", marginBottom: 18 }}>
          <Spinner />
        </div>
      ) : (
        <ShipmentGpSankey lines={gpLines} />
      )}

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px", marginBottom: 14,
        display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <span style={{ ...th, marginRight: 4 }}>Status</span>
          {PAYMENT_STATE_ORDER.map(s => {
            const meta = paymentStateMeta(s);
            return (
              <Chip key={s} active={stateFilter.has(s)} onClick={() => toggleSet(stateFilter, setStateFilter, s)} color={meta.color}>
                {meta.label}
              </Chip>
            );
          })}
          <span style={{ width: 1, height: 18, background: T.border, margin: "0 4px" }} />
          <span style={{ ...th, marginRight: 4 }}>Sent</span>
          <Chip active={sentFilter === "sent"} onClick={() => setSentFilter(p => p === "sent" ? "" : "sent")} color={T.info}>Sent</Chip>
          <Chip active={sentFilter === "not_sent"} onClick={() => setSentFilter(p => p === "not_sent" ? "" : "not_sent")} color={T.info}>Not Sent</Chip>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Select value={officeId} onChange={setOfficeId} options={facets.offices} placeholder="All offices" />
          <Select value={customerId} onChange={setCustomerId} options={facets.customers} placeholder="All customers" />
          <Select value={laneCode} onChange={setLaneCode} options={facets.lanes} placeholder="All trade lanes" />
          <Select value={carrierCode} onChange={setCarrierCode} options={facets.carriers} placeholder="All carriers" />
          {hasFilters && <Btn variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Btn>}
          <div style={{ flex: 1 }} />
          <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>{filtered.length} of {rows.length} invoices</span>
          <Btn variant="secondary" size="sm" onClick={runExport} disabled={exporting}>{exporting ? "Exporting…" : "⬇ Export CSV"}</Btn>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic",
          background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
          No invoices match these filters.
        </div>
      ) : (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface, overflowX: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 16px", borderBottom: `1px solid ${T.border}`, background: T.bg, minWidth: 1000 }}>
            <div style={{ ...th, width: 90, flexShrink: 0 }}>Shipment</div>
            <div style={{ ...th, flex: 1, minWidth: 100 }}>Customer</div>
            <div style={{ ...th, width: 90, flexShrink: 0 }}>Status</div>
            <div style={{ ...th, width: 55, flexShrink: 0 }}>Sent</div>
            <div style={{ ...th, width: 95, flexShrink: 0, textAlign: "right" }}>Amount</div>
            <div style={{ ...th, width: 105, flexShrink: 0, textAlign: "right" }}>Outstanding</div>
            <div style={{ ...th, width: 70, flexShrink: 0, textAlign: "right" }}>Days Over</div>
            <div style={{ ...th, width: 130, flexShrink: 0 }}>Office</div>
            <div style={{ ...th, width: 70, flexShrink: 0 }}>Carrier</div>
          </div>
          {filtered.slice(0, 200).map(r => {
            const meta = paymentStateMeta(r.paymentState);
            return (
              <div key={r.docId || r.shipmentId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 16px",
                borderBottom: `1px solid ${T.border}22`, minWidth: 1000 }}>
                <div style={{ width: 90, flexShrink: 0, fontFamily: T.mono, fontSize: 11.5, color: T.text, fontWeight: 600 }}>{r.shipmentId}</div>
                <div style={{ flex: 1, minWidth: 100, fontFamily: T.body, fontSize: 12.5, color: r.customerName ? T.text : T.border,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.customerName || "—"}</div>
                <div style={{ width: 90, flexShrink: 0 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                    padding: "2px 8px", borderRadius: 20, color: meta.color, background: `${meta.color}18`,
                    border: `1px solid ${meta.color}44`, whiteSpace: "nowrap" }}>{meta.label}</span>
                </div>
                <div style={{ width: 55, flexShrink: 0, fontFamily: T.body, fontSize: 11.5, color: r.sent ? T.info : T.border }}>{r.sent ? "Sent" : "—"}</div>
                <div style={{ width: 95, flexShrink: 0, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: T.text }}>{fmtUsd(r.amountUsd)}</div>
                <div style={{ width: 105, flexShrink: 0, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: r.outstandingUsd > 0 ? T.warning : T.textMuted }}>
                  {r.outstandingUsd != null ? fmtUsd(r.outstandingUsd) : "—"}
                </div>
                <div style={{ width: 70, flexShrink: 0, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: r.daysOverdue > 0 ? T.danger : T.textMuted }}>
                  {r.daysOverdue != null && r.daysOverdue > 0 ? `${r.daysOverdue}d` : "—"}
                </div>
                <div style={{ width: 130, flexShrink: 0, fontFamily: T.body, fontSize: 11, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.officeName || "—"}
                </div>
                <div style={{ width: 70, flexShrink: 0, fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{r.carrierCode || "—"}</div>
              </div>
            );
          })}
          {filtered.length > 200 && (
            <div style={{ padding: "10px 16px", textAlign: "center", fontFamily: T.body, fontSize: 11.5, color: T.textMuted, fontStyle: "italic" }}>
              Showing the first 200 of {filtered.length} matching invoices — narrow the filters or export CSV for the full set.
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default BillingPerformancePanel;
