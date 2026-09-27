import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import Spinner from "../primitives/Spinner";

// FX Revaluation report (Reports tab, finance-only) — unrealized gain/loss on confirmed, unpaid,
// non-USD invoices (booked value vs. today's live rate) and realized gain/loss on paid invoices
// where Mark as Paid captured what was actually received in the invoice's own currency. A flat
// scan-and-review table, same posture as BillingPerformancePanel/InvoiceCollectionsPanel next to
// it — report only, no ledger writes (see routes/fx-revaluation.js's own comment for why).

const fmtUsd = n => `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const GainLossCell = ({ value }) => (
  <span style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 700, color: value > 0 ? T.success : value < 0 ? T.danger : T.textMuted }}>
    {value > 0 ? "+" : ""}{fmtUsd(value)}
  </span>
);

const Table = ({ rows, columns, emptyLabel }) => (
  <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", background: T.surface }}>
    <div style={{ display: "flex", padding: "8px 14px", background: T.bg, borderBottom: `1px solid ${T.border}` }}>
      {columns.map(c => (
        <div key={c.key} style={{ flex: c.flex || 1, textAlign: c.align || "left", fontFamily: T.body, fontSize: 10.5,
          fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>{c.label}</div>
      ))}
    </div>
    {rows.length === 0 ? (
      <div style={{ padding: 32, textAlign: "center", fontFamily: T.body, fontSize: 12.5, color: T.textMuted, fontStyle: "italic" }}>
        {emptyLabel}
      </div>
    ) : rows.map((r, i) => (
      <div key={r.docId} style={{ display: "flex", padding: "9px 14px", alignItems: "center",
        borderBottom: i === rows.length - 1 ? "none" : `1px solid ${T.border}22` }}>
        {columns.map(c => (
          <div key={c.key} style={{ flex: c.flex || 1, textAlign: c.align || "left" }}>{c.render(r)}</div>
        ))}
      </div>
    ))}
  </div>
);

const FxRevaluationPanel = () => {
  const [data, setData] = useState(null); // null = loading
  const [error, setError] = useState("");

  useEffect(() => {
    api.fxRevaluation.summary().then(setData).catch(e => setError(e.message));
  }, []);

  if (error) return (
    <div style={{ padding: 32, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.danger }}>{error}</div>
  );
  if (!data) return (
    <div style={{ padding: 40, textAlign: "center" }}><Spinner /></div>
  );

  const unrealizedColumns = [
    { key: "doc", label: "Invoice", flex: 1.4, render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{r.filename}</span> },
    { key: "currency", label: "Currency", render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{r.currency}</span> },
    { key: "foreign", label: "Amount", align: "right", render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{r.foreignAmount.toLocaleString()}</span> },
    { key: "booked", label: "Booked USD", align: "right", render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{fmtUsd(r.bookedUsd)}</span> },
    { key: "today", label: "Today's USD", align: "right", render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{fmtUsd(r.todaysUsd)}</span> },
    { key: "gainLoss", label: "Unrealized", align: "right", render: r => <GainLossCell value={r.gainLossUsd} /> },
  ];
  const realizedColumns = [
    { key: "doc", label: "Invoice", flex: 1.4, render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{r.filename}</span> },
    { key: "currency", label: "Currency", render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{r.currency}</span> },
    { key: "received", label: "Amount Received", align: "right", render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{r.paidAmountOriginal?.toLocaleString() ?? "—"}</span> },
    { key: "booked", label: "Booked USD", align: "right", render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{fmtUsd(r.bookedUsd)}</span> },
    { key: "receivedUsd", label: "Received USD", align: "right", render: r => <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted }}>{fmtUsd(r.receivedUsd)}</span> },
    { key: "gainLoss", label: "Realized", align: "right", render: r => <GainLossCell value={r.gainLossUsd} /> },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", gap: 16 }}>
        <div style={{ flex: 1, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>Unrealized Gain/Loss</div>
          <div style={{ marginTop: 4 }}><GainLossCell value={data.totals.unrealizedUsd} /></div>
        </div>
        <div style={{ flex: 1, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>Realized Gain/Loss</div>
          <div style={{ marginTop: 4 }}><GainLossCell value={data.totals.realizedUsd} /></div>
        </div>
      </div>

      <div>
        <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 8 }}>Unrealized — Open Foreign-Currency Invoices</div>
        <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "0 0 10px" }}>
          Confirmed, unpaid invoices, valued at today's live rate against what was originally booked.
        </p>
        <Table rows={data.unrealized} columns={unrealizedColumns} emptyLabel="No open non-USD invoices right now." />
      </div>

      <div>
        <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 8 }}>Realized — Paid Invoices</div>
        <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "0 0 10px" }}>
          Invoices whose Mark as Paid recorded what was actually received in the invoice's own currency. An
          invoice marked paid without that optional field isn't shown here — there's nothing to compare a rate
          against.
        </p>
        <Table rows={data.realized} columns={realizedColumns} emptyLabel="No paid invoices have a recorded original-currency amount yet." />
      </div>
    </div>
  );
};

export default FxRevaluationPanel;
