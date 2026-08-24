import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { IconTag, IconCoin } from "../../components/primitives/Icon";

// ─── Finance (hub) ──────────────────────────────────────────────────────────
// Landing page for the finance-adjacent Master Data registries — automated charge codes, duty
// rate chapters, invoice status reason codes. A clickable nav page rather than a plain section
// header, per direct request (same pattern as the Equipment hub) — each card below is the
// "button to access it directly", and the sidebar keeps its own direct links to all three too.

const FinanceCard = ({ icon: IconComp, title, description, count, onClick }) => (
  <div onClick={onClick}
    style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 24,
      cursor: "pointer", display: "flex", flexDirection: "column", gap: 12, transition: "border-color .12s, transform .12s" }}
    onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.transform = "translateY(-2px)"; }}
    onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.transform = "translateY(0)"; }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: T.accentBg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <IconComp size={20} color={T.accent} />
      </div>
      {count != null && (
        <span style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800, color: T.text }}>{count}</span>
      )}
    </div>
    <div>
      <div style={{ fontFamily: T.head, fontSize: 16, fontWeight: 700, color: T.text }}>{title}</div>
      <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginTop: 4, lineHeight: 1.4 }}>{description}</div>
    </div>
  </div>
);

const MdmFinancePage = ({ navigate }) => {
  const [counts, setCounts] = useState({ chargeCodes: null, dutyRates: null, reasonCodes: null });

  useEffect(() => {
    Promise.all([
      api.chargeCodes.list().catch(() => []),
      api.dutyRates.list().catch(() => []),
      api.invoiceReasonCodes.list().catch(() => []),
    ]).then(([chargeCodes, dutyRates, reasonCodes]) => {
      setCounts({ chargeCodes: chargeCodes.length, dutyRates: dutyRates.length, reasonCodes: reasonCodes.length });
    });
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 26, fontWeight: 800, color: T.text, margin: 0 }}>Finance</h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
          Automated charge codes, duty rate chapters, and invoice status reason codes
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        <FinanceCard
          icon={IconTag}
          title="Charge Codes"
          description="Automated per-container charge definitions that auto-inject into a split-per-container invoice generation."
          count={counts.chargeCodes}
          onClick={() => navigate("mdm-charge-codes")}
        />
        <FinanceCard
          icon={IconCoin}
          title="Duty Rate Chapters"
          description="HS-code chapter duty rate reference used by the Landed Cost calculator."
          count={counts.dutyRates}
          onClick={() => navigate("mdm-duty-rates")}
        />
        <FinanceCard
          icon={IconTag}
          title="Invoice Reason Codes"
          description="Reason codes a Trade Manager picks from when overriding an Invoice Collections status."
          count={counts.reasonCodes}
          onClick={() => navigate("mdm-invoice-reason-codes")}
        />
      </div>
    </div>
  );
};

export default MdmFinancePage;
