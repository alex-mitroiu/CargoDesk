import { useState, useEffect } from "react";
import { T, todayIso } from "../../tokens";
import { api } from "../../api";
import Spinner from "../primitives/Spinner";
import DatePicker from "../primitives/DatePicker";

// VAT Liability report (Reports tab, finance-only) — output VAT (SELL, on issued invoices and
// credit notes) minus input VAT (BUY, on posted costs), per legal entity (branch), for a period.
// Zero-rated / reverse-charged / exempt amounts are shown as their own base figures, since a VAT
// return reports each in a different box. See routes/finance.js's /api/vat-liability/summary.

const fmtUsd = n => `${n < 0 ? "-" : ""}$${Math.abs(Number(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtLocal = (n, c) => `${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${c}`;

// Default window: the current calendar quarter to date — most VAT returns are quarterly.
const quarterStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1)).toISOString().slice(0, 10);
};

const Cell = ({ children, align = "right", strong, color }) => (
  <div style={{ flex: 1, textAlign: align, fontFamily: T.mono, fontSize: 12, fontWeight: strong ? 700 : 400, color: color || T.textMuted }}>
    {children}
  </div>
);

const SideTable = ({ label, side }) => (
  <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
    <div style={{ padding: "7px 12px", background: T.bg, borderBottom: `1px solid ${T.border}`,
      fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>
      {label}
    </div>
    {[
      ["Standard-rated", side.standard.baseUsd, side.standard.vatUsd],
      ["Zero-rated", side.zero_rated.baseUsd, null],
      ["Reverse charge", side.reverse_charge.baseUsd, null],
      ["Exempt", side.exempt.baseUsd, null],
      // Reverse-charged purchases the entity accounts for itself — same figure on both sides.
      ...(side.self_assessed?.baseUsd ? [["Self-assessed (reverse-charge purchases)", side.self_assessed.baseUsd, side.self_assessed.vatUsd]] : []),
    ].map(([name, base, vat]) => (
      <div key={name} style={{ display: "flex", padding: "6px 12px", borderBottom: `1px solid ${T.border}22` }}>
        <Cell align="left" color={T.text}>{name}</Cell>
        <Cell>{fmtUsd(base)}</Cell>
        <Cell>{vat == null ? "—" : fmtUsd(vat)}</Cell>
      </div>
    ))}
    <div style={{ display: "flex", padding: "7px 12px", background: T.bg }}>
      <Cell align="left" strong color={T.text}>Total VAT</Cell>
      <Cell />
      <Cell strong color={T.text}>{fmtUsd(side.totalVatUsd)}</Cell>
    </div>
  </div>
);

const VatLiabilityPanel = () => {
  const [dateFrom, setDateFrom] = useState(quarterStart);
  const [dateTo,   setDateTo]   = useState(() => todayIso());
  const [data,  setData]  = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!dateFrom || !dateTo) return;
    setData(null); setError("");
    api.vatLiability.summary(dateFrom, dateTo).then(setData).catch(e => setError(e.message));
  }, [dateFrom, dateTo]);

  return (
    <div id="vat-liability-panel" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, background: T.surface,
        border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px" }}>
        <div style={{ width: 190 }}><DatePicker label="From" value={dateFrom} onChange={setDateFrom} maxDate={dateTo || undefined} /></div>
        <div style={{ width: 190 }}><DatePicker label="To" value={dateTo} onChange={setDateTo} minDate={dateFrom || undefined} /></div>
        <div style={{ flex: 1, textAlign: "right", fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
          Output VAT by invoice, credit-note or statement confirm date · input VAT by cost post date
        </div>
      </div>

      {error ? (
        <div style={{ padding: 32, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.danger }}>{error}</div>
      ) : !data ? (
        <div style={{ padding: 40, textAlign: "center" }}><Spinner /></div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 16 }}>
            {[["Output VAT", data.totals.outputVatUsd], ["Input VAT", data.totals.inputVatUsd], ["Net VAT", data.totals.netVatUsd]].map(([label, v]) => (
              <div key={label} style={{ flex: 1, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 18px" }}>
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</div>
                <div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, marginTop: 4,
                  color: label !== "Net VAT" ? T.text : v > 0 ? T.danger : v < 0 ? T.success : T.textMuted }}>{fmtUsd(v)}</div>
                {label === "Net VAT" && (
                  <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                    {v > 0 ? "owed to the tax authority" : v < 0 ? "reclaimable" : "nothing owed"}
                  </div>
                )}
              </div>
            ))}
          </div>

          {data.entities.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic",
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10 }}>
              No issued invoices or posted costs in this period.
            </div>
          ) : data.entities.map(e => (
            <div key={e.entityId || "unassigned"} data-testid={`vat-entity-${e.entityId || "unassigned"}`}
              style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                <div>
                  <div style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text }}>{e.entityName}</div>
                  <div style={{ fontFamily: T.mono, fontSize: 11, color: e.taxRegistrationNumber ? T.textMuted : T.warning, marginTop: 2 }}>
                    {e.taxRegistrationNumber ? `VAT No. ${e.taxRegistrationNumber}`
                      : e.entityId ? "No VAT number set on this branch"
                      : "Assign these shipments' offices to a branch to report them under an entity"}
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: e.netVatUsd > 0 ? T.danger : e.netVatUsd < 0 ? T.success : T.textMuted }}>
                    {fmtUsd(e.netVatUsd)}
                  </div>
                  {e.currency !== "USD" && (
                    <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>≈ {fmtLocal(e.localNetVat, e.currency)}</div>
                  )}
                </div>
              </div>
              {e.selfAssessRateMissing && (
                <div data-testid={`vat-entity-${e.entityId || "unassigned"}-rate-missing`} style={{ marginBottom: 10, padding: "7px 12px", borderRadius: 6,
                  background: T.warningBg, border: `1px solid ${T.warning}44`, fontFamily: T.body, fontSize: 12, color: T.text }}>
                  {e.entityId
                    ? "Reverse-charged purchases aren't self-assessed yet — set this branch's standard VAT rate under Organization → Branches."
                    : "Reverse-charged purchases on shipments with no branch can't be self-assessed."}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <SideTable label="Output VAT — sales" side={e.output} />
                <SideTable label="Input VAT — purchases" side={e.input} />
              </div>
            </div>
          ))}

          <p style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, margin: 0, lineHeight: 1.5 }}>
            Figures are in USD, converted per line at its own booked or actual rate; the local-currency figure uses
            today's rate. A reverse-charged purchase is self-assessed at the buying branch's standard VAT rate: the
            same VAT is added to output and input, so it doesn't change the net figure.
          </p>
        </>
      )}
    </div>
  );
};

export default VatLiabilityPanel;
