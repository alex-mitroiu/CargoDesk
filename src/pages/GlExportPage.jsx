import { useState, useEffect } from "react";
import { T, todayIso, addDays } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import DatePicker from "../components/primitives/DatePicker";
import Btn from "../components/primitives/Btn";
import Spinner from "../components/primitives/Spinner";

// GL Export — Financials -> GL Export. Runs lib/gl-export.js's engine over a date range and
// hands back a downloadable, generic journal-entry CSV (importable into QuickBooks, Xero,
// NetSuite, SAP or any accounting system's own import tool) — not a live API push to any one of
// them. See routes/gl-export.js's own comment for the SELL/BUY recognition triggers.

const fmtUsd = n => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const downloadCsv = (csv, filename) => {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

const GlExportPage = () => {
  const [dateFrom, setDateFrom] = useState(() => addDays(todayIso(), -30));
  const [dateTo,   setDateTo]   = useState(() => todayIso());
  const [running,  setRunning]  = useState(false);
  const [result,   setResult]   = useState(null);
  const [batches,  setBatches]  = useState([]);
  const [batchesLoading, setBatchesLoading] = useState(true);

  const loadBatches = () => {
    setBatchesLoading(true);
    api.glExport.batches().then(setBatches).catch(() => setBatches([])).finally(() => setBatchesLoading(false));
  };
  useEffect(() => { loadBatches(); }, []);

  const run = async () => {
    setRunning(true);
    setResult(null);
    try {
      const r = await api.glExport.run(dateFrom, dateTo);
      setResult(r);
      if (r.rows.length) {
        downloadCsv(r.csv, `gl-export-${r.batchId}.csv`);
        toast.success(`Exported ${r.rows.length} rows`);
      } else {
        toast.info("Nothing new to export for this range");
      }
      loadBatches();
    } catch (e) { toast.error(e.message); }
    setRunning(false);
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>GL Export</h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
          Export confirmed invoices/credit notes and posted carrier costs in this range as a journal-entry CSV.
          Already-exported items are never included again — a re-run of the same range only picks up what's new.
        </p>
      </div>

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 18px",
        display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 20 }}>
        <div style={{ width: 190 }}><DatePicker label="From" value={dateFrom} onChange={setDateFrom} maxDate={dateTo} /></div>
        <div style={{ width: 190 }}><DatePicker label="To" value={dateTo} onChange={setDateTo} minDate={dateFrom} /></div>
        <Btn onClick={run} disabled={running || !dateFrom || !dateTo}>{running ? "Running…" : "Run Export"}</Btn>
      </div>

      {result && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 18px", marginBottom: 20 }}>
          <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 10 }}>Last Run</div>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div><div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Rows</div><div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.text }}>{result.rows.length}</div></div>
            <div><div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Total Debit</div><div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.text }}>{fmtUsd(result.totalDebit)}</div></div>
            <div><div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>Total Credit</div><div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.text }}>{fmtUsd(result.totalCredit)}</div></div>
            {result.unmappedCount > 0 && (
              <div><div style={{ fontFamily: T.body, fontSize: 11, color: T.warning }}>Unmapped</div><div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.warning }}>{result.unmappedCount} row{result.unmappedCount !== 1 ? "s" : ""}</div></div>
            )}
          </div>
          {result.unmappedCount > 0 && (
            <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, background: `${T.warning}18`, border: `1px solid ${T.warning}44`,
              fontFamily: T.body, fontSize: 12, color: T.text }}>
              {result.unmappedCount} row{result.unmappedCount !== 1 ? "s" : ""} fell into the Unmapped/Suspense account — check GL Account Mappings
              (Master Data → Finance) for a charge code that still needs one.
            </div>
          )}
          {result.rows.length > 0 && (
            <Btn size="sm" variant="secondary" style={{ marginTop: 12 }} onClick={() => downloadCsv(result.csv, `gl-export-${result.batchId}.csv`)}>
              ⬇ Download Again
            </Btn>
          )}
        </div>
      )}

      <div>
        <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 10 }}>Run History</div>
        {batchesLoading ? (
          <div style={{ padding: 32, textAlign: "center" }}><Spinner /></div>
        ) : batches.length === 0 ? (
          <div style={{ padding: 32, textAlign: "center", fontFamily: T.body, fontSize: 12.5, color: T.textMuted, fontStyle: "italic",
            background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8 }}>
            No exports run yet.
          </div>
        ) : (
          <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface }}>
            <div style={{ display: "flex", padding: "8px 14px", background: T.bg, borderBottom: `1px solid ${T.border}` }}>
              {["Batch", "Range", "Rows", "Debit", "Credit", "Run At"].map(h => (
                <div key={h} style={{ flex: h === "Batch" ? 1.4 : 1, fontFamily: T.body, fontSize: 10.5, fontWeight: 600,
                  color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>{h}</div>
              ))}
            </div>
            {batches.map(b => (
              <div key={b.id} style={{ display: "flex", padding: "9px 14px", alignItems: "center", borderBottom: `1px solid ${T.border}22` }}>
                <div style={{ flex: 1.4, fontFamily: T.mono, fontSize: 12, color: T.text }}>{b.id}</div>
                <div style={{ flex: 1, fontFamily: T.mono, fontSize: 11.5, color: T.textMuted }}>{b.dateFrom} → {b.dateTo}</div>
                <div style={{ flex: 1, fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{b.rowCount}</div>
                <div style={{ flex: 1, fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{fmtUsd(b.totalDebit)}</div>
                <div style={{ flex: 1, fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{fmtUsd(b.totalCredit)}</div>
                <div style={{ flex: 1, fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>{new Date(b.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default GlExportPage;
