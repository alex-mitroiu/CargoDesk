import { useState } from "react";
import { T } from "../tokens";
import { api } from "../api";
import Btn from "../components/primitives/Btn";
import { Field } from "../components/primitives/Form";
import PortField from "../components/shared/PortField";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import DatePicker from "../components/primitives/DatePicker";
import Spinner from "../components/primitives/Spinner";
import { IconSearch } from "../components/primitives/Icon";

// ─── Rate Benchmarking ──────────────────────────────────────────────────────
// Compares every Active contract's own rates for one lane side by side — the same "sort by
// cheapest total, badge the winner" logic ContractPickerModal (ShipmentFormPage.jsx) already
// runs when picking a contract for one specific shipment, surfaced here as its own standalone
// view so it can be used for pricing/renewal review without needing a shipment in progress.
// Reuses GET /api/contracts/match as-is — no new backend logic, this is a comparison lens over
// data the app already computes.

const totalUsd = rates => (rates && rates.length ? rates.reduce((s, r) => s + (r.amountUsd || 0), 0) : 0);
const fmtUsd = v => `$${Math.round(v).toLocaleString("en-US")}`;

const RateBenchmarkPage = () => {
  const [polPort, setPolPort] = useState(null);
  const [podPort, setPodPort] = useState(null);
  const [carrierCode, setCarrierCode] = useState("");
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [results, setResults] = useState([]);
  const [expanded, setExpanded] = useState(null);

  const canSearch = !!(polPort?.unlocode && podPort?.unlocode);

  const runSearch = async () => {
    if (!canSearch) return;
    setLoading(true);
    setSearched(true);
    try {
      const matches = await api.contracts.match({
        pol: polPort.unlocode, pod: podPort.unlocode,
        ...(carrierCode && { carrier: carrierCode }),
        ...(asOf && { crd: asOf }),
      });
      setResults([...matches].sort((a, b) => totalUsd(a.rates) - totalUsd(b.rates)));
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  const lowestTotal = results.length > 0 ? totalUsd(results[0].rates) : null;

  // Every distinct service code across the result set — used as the expanded row's own
  // breakdown columns so BAF/PSS/etc. are directly comparable line-by-line, not just as one
  // blended total (a single number can hide that one contract is cheap on Ocean Freight but
  // expensive on surcharges).
  const codesFor = contract => {
    const m = {};
    (contract.rates || []).forEach(r => { m[r.serviceCode || "—"] = (m[r.serviceCode || "—"] || 0) + (r.amountUsd || 0); });
    return m;
  };

  return (
    <div style={{ maxWidth: 1100 }}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: T.head, fontSize: 22, fontWeight: 700, color: T.text, margin: 0 }}>
          Rate Benchmarking
        </h1>
        <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "4px 0 0" }}>
          Compare every Active contract's own rate for a lane, side by side — the same data the
          Carrier Booking flow already uses to auto-pick the cheapest match, viewable on its own
          for pricing review or contract renewal — not a live external market rate.
        </p>
      </div>

      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
        padding: "18px 20px", marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 200px 160px auto", gap: 12, alignItems: "end" }}>
          <PortField label="Port of Loading" value={polPort} onChange={setPolPort} placeholder="Search origin port…" required />
          <PortField label="Port of Discharge" value={podPort} onChange={setPodPort} placeholder="Search destination port…" required />
          <Field label="Carrier (optional)">
            <CarrierCombobox value={carrierCode} onChange={setCarrierCode} />
          </Field>
          <Field label="As of">
            <DatePicker value={asOf} onChange={setAsOf} />
          </Field>
          <Btn onClick={runSearch} disabled={!canSearch || loading}>
            <IconSearch size={13} /> Compare
          </Btn>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 48, textAlign: "center" }}><Spinner /></div>
      ) : !searched ? (
        <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
          Pick a POL/POD (and optionally a carrier) to compare every matching Active contract's rate.
        </div>
      ) : results.length === 0 ? (
        <div style={{ padding: 48, textAlign: "center", color: T.textMuted, fontFamily: T.body, fontSize: 13 }}>
          No Active contract currently matches this lane{carrierCode ? " for that carrier" : ""}.
        </div>
      ) : (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 140px 110px 130px 32px",
            padding: "9px 16px", borderBottom: `1px solid ${T.border}`,
            fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
            textTransform: "uppercase", letterSpacing: ".07em" }}>
            <span>Carrier</span>
            <span>Contract</span>
            <span>Match</span>
            <span>Lines</span>
            <span style={{ textAlign: "right" }}>Total (USD)</span>
            <span></span>
          </div>
          {results.map(c => {
            // GET /api/contracts/match returns one row per (contract, routing) pair — two
            // routing variants of the SAME contract share the same c.id, so the id alone can't
            // be used as a unique row/expand key (it would collapse both rows' expand state
            // into one).
            const rowKey = c.routingId ? `${c.id}::${c.routingId}` : c.id;
            const total = totalUsd(c.rates);
            const isBest = lowestTotal !== null && total === lowestTotal;
            const isOpen = expanded === rowKey;
            return (
              <div key={rowKey}>
                <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 140px 110px 130px 32px",
                  padding: "12px 16px", borderBottom: `1px solid ${T.border}22`, alignItems: "center",
                  cursor: "pointer", background: isBest ? T.success + "0a" : "transparent" }}
                  onClick={() => setExpanded(isOpen ? null : rowKey)}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.accent }}>{c.carrierCode}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>{c.contractNumber}</span>
                    {/* Distinguishes two priced routings on the same contract — without this,
                        two rows sharing a contractNumber would look identical apart from price. */}
                    {c.routing?.name && <span style={{ fontFamily: T.body, fontSize: 10.5, fontWeight: 700, color: T.accent }}>{c.routing.name}</span>}
                    {c.namedAccount && <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted }}>{c.namedAccount}</span>}
                  </div>
                  <span style={{
                    fontFamily: T.body, fontSize: 10.5, fontWeight: 700, width: "fit-content",
                    padding: "2px 8px", borderRadius: 4,
                    background: c.matchKind === "exact" ? T.success + "22" : T.info + "22",
                    color: c.matchKind === "exact" ? T.success : T.info,
                  }}>
                    {c.matchKind === "exact" ? "Exact" : "Via linked port"}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                    {(c.rates || []).length} rate{(c.rates || []).length !== 1 ? "s" : ""}
                  </span>
                  <div style={{ textAlign: "right", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
                    <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: isBest ? T.success : T.text }}>
                      {fmtUsd(total)}
                    </span>
                    {isBest && (
                      <span style={{ fontFamily: T.body, fontSize: 9.5, fontWeight: 700, color: T.success,
                        background: T.success + "18", border: `1px solid ${T.success}44`,
                        borderRadius: 3, padding: "1px 5px" }}>
                        BEST
                      </span>
                    )}
                  </div>
                  <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted, textAlign: "center" }}>
                    {isOpen ? "▾" : "▸"}
                  </span>
                </div>
                {isOpen && (
                  <div style={{ padding: "10px 16px 14px 34px", background: T.bg, borderBottom: `1px solid ${T.border}22` }}>
                    {Object.entries(codesFor(c)).map(([code, amt]) => (
                      <div key={code} style={{ display: "flex", justifyContent: "space-between",
                        maxWidth: 320, padding: "3px 0", fontFamily: T.mono, fontSize: 11.5 }}>
                        <span style={{ color: T.textMuted }}>{code}</span>
                        <span style={{ color: T.text, fontWeight: 600 }}>{fmtUsd(amt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default RateBenchmarkPage;
