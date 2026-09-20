import { useState, useEffect } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { IconReceipt, IconFlag, IconChartBar, IconFileCertificate, IconWarning } from "../components/primitives/Icon";

// ─── Financials (hub) ────────────────────────────────────────────────────────
// Landing page for the Financials sidebar group — Quotes, Opportunities, Reports, Freight Audit and Credit
// Overrides. Built like the Master Data → Finance hub (MdmFinancePage): the sidebar parent is a real page of
// cards rather than a bare label, each card is the direct way in, and the sidebar keeps its own links to every
// child. Every child keeps its own page key and address (#quotes, #reports, …); only this hub is new.
//
// `pages` is the list of page keys THIS person may see, decided once in App.jsx (src/utils/financialsNav.js)
// and shared with the sidebar group, so a card can never point at a link the sidebar hides. The counts are
// each page's own figure, fetched here, and a count that fails to load just leaves its card without a number.

const CARDS = {
  quotes: {
    icon: IconReceipt, title: "Quotes", unit: ["quote", "quotes"],
    description: "Price a lane for a customer, send it, and convert an accepted quote into a shipment.",
    count: () => api.quotes.list({ limit: 1 }).then(r => r?.total ?? null),
  },
  opportunities: {
    icon: IconFlag, title: "Opportunities", unit: ["opportunity", "opportunities"],
    description: "The pre-sales pipeline: qualify a lead and convert it into a quote.",
    count: () => api.opportunities.list({ limit: 1 }).then(r => r?.total ?? null),
  },
  reports: {
    icon: IconChartBar, title: "Reports",
    description: "GP by Trade Area, Billing Performance and Invoice Collections.",
  },
  "freight-audit": {
    icon: IconFileCertificate, title: "Freight Audit", unit: ["open exception", "open exceptions"],
    description: "Reconcile carrier invoices against contracted rates and accrued costs, and work the open exceptions.",
    count: () => api.carrierInvoices.exceptions().then(r => (Array.isArray(r) ? r.length : null)),
  },
  "credit-overrides": {
    icon: IconWarning, title: "Credit Overrides", unit: ["blocked shipment", "blocked shipments"],
    description: "Shipments held for credit or over a customer's limit. Only the lane's trade manager can release them.",
    count: () => api.creditOverridesQueue().then(r => (Array.isArray(r) ? r.length : null)),
  },
};

const FinancialsCard = ({ pageKey, count, onClick }) => {
  const { icon: IconComp, title, description, unit } = CARDS[pageKey];
  return (
    <div data-testid={`financials-card-${pageKey}`} role="link" tabIndex={0} onClick={onClick}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 24,
        cursor: "pointer", display: "flex", flexDirection: "column", gap: 12, transition: "border-color .12s, transform .12s" }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.transform = "translateY(-2px)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.transform = "translateY(0)"; }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: T.accentBg, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <IconComp size={20} color={T.accent} />
        </div>
        {count != null && (
          <div data-testid={`financials-count-${pageKey}`} style={{ textAlign: "right" }}>
            <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800, color: T.text, lineHeight: 1.1 }}>{count}</div>
            <div style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted, letterSpacing: ".04em" }}>{count === 1 ? unit[0] : unit[1]}</div>
          </div>
        )}
      </div>
      <div>
        <div style={{ fontFamily: T.head, fontSize: 16, fontWeight: 700, color: T.text }}>{title}</div>
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginTop: 4, lineHeight: 1.4 }}>{description}</div>
      </div>
    </div>
  );
};

const FinancialsPage = ({ pages, navigate }) => {
  const [counts, setCounts] = useState({});
  const pagesKey = pages.join(",");

  useEffect(() => {
    let live = true;
    pages.forEach(key => {
      const load = CARDS[key]?.count;
      if (!load) return;
      Promise.resolve().then(load)
        .then(n => { if (live && n != null) setCounts(prev => ({ ...prev, [key]: n })); })
        .catch(() => {});
    });
    return () => { live = false; };
  }, [pagesKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Financials</h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
          Quotes and the pre-sales pipeline, carrier invoice audit, credit holds and reports
        </p>
      </div>

      {/* 320px (the Master Data hubs use 260 for their three cards): with five cards a four-column grid would leave
          the last one alone on a second row; three columns gives a balanced 3 + 2. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
        {pages.filter(key => CARDS[key]).map(key => (
          <FinancialsCard key={key} pageKey={key} count={counts[key]} onClick={() => navigate(key)} />
        ))}
      </div>
    </div>
  );
};

export default FinancialsPage;
