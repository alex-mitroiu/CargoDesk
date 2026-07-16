import { useEffect, useState } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { ComplianceModal, RouteSummaryBar } from "../../pages/ShipmentDetailPage";
import { deriveHaulageNeeds } from "../../pages/ShipmentFormPage";
import ContractMismatchModal from "./ContractMismatchModal";

// ─── Persistent Shipment Header ────────────────────────────────────────────
// Mounted once in App.jsx above the page switch for "detail" + every promoted
// shipment sub-page, so shipment identity/route/dates stay visible while
// navigating between tabs. Row 3 reuses RouteSummaryBar as-is (same component
// shown on the Schedules page) rather than maintaining a second, different
// journey visualization for the same underlying legs data.

const Field = ({ label, value, first }) => (
  <div style={{
    display: "flex", alignItems: "baseline", gap: 6,
    padding: "0 14px", margin: first ? "0 14px 0 0" : 0,
    borderLeft: first ? "none" : `1px solid ${T.border}`,
  }}>
    <span style={{ fontFamily: T.mono, fontSize: 10, textTransform: "uppercase",
      letterSpacing: "0.08em", color: T.textMuted, flexShrink: 0 }}>{label}</span>
    <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, fontWeight: 500,
      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>
      {value || "—"}
    </span>
  </div>
);

const ShipmentHeaderBar = ({ shipment, containers = [], onNavigateToSchedules, onUpdate }) => {
  const [schedules, setSchedules] = useState([]);
  const [screening, setScreening] = useState(null);
  const [complianceOpen, setComplianceOpen] = useState(false);
  const [contractMismatch, setContractMismatch] = useState(false);
  const [legs, setLegs] = useState([]);

  useEffect(() => {
    let live = true;
    api.schedules.list(shipment.id).then(rows => { if (live) setSchedules(rows || []); }).catch(() => {});
    return () => { live = false; };
  }, [shipment.id]);

  useEffect(() => {
    let live = true;
    api.screening.get(shipment.id).then(s => { if (live) setScreening(s); }).catch(() => {});
    return () => { live = false; };
  }, [shipment.id]);

  useEffect(() => {
    let live = true;
    api.legs.list(shipment.id).then(rows => { if (live) setLegs(rows || []); }).catch(() => {});
    return () => { live = false; };
  }, [shipment.id]);

  // shipment.pol/pod are the journey's overall door-to-door bookends — with a Door pickup
  // leg or a multi-leg (TSP) journey, that's not the same as the actual SEA leg(s)' own
  // pol/pod, and a contract is always matched port-to-port against the real ocean leg.
  const seaLegs = legs.filter(l => l.legType === "SEA");
  const matchPol = seaLegs[0]?.pol || shipment.pol || "";
  const matchPod = seaLegs[seaLegs.length - 1]?.pod || shipment.pod || "";
  const { needsPolHaulage, needsPodHaulage, pkuLocation, delLocation } = deriveHaulageNeeds(legs);

  // Silent revalidation: a Central contract was matched against POL/POD (and haulage coverage)
  // at the time it was picked, but nothing re-checks it if the route changes afterward — same
  // class of gap PendingRevalidationModal already covers for Pending shipments, extended to
  // Central here. Must agree with ContractAssignModal's own check or the badge and the actual
  // fix flow could disagree on whether there's a problem.
  useEffect(() => {
    let live = true;
    if (shipment.contractType !== "Central" || !shipment.contractId || !matchPol || !matchPod) {
      setContractMismatch(false);
      return;
    }
    api.contracts.match({ pol: matchPol, pod: matchPod,
      ...(needsPolHaulage && { needsPolHaulage: "1" }), ...(needsPodHaulage && { needsPodHaulage: "1" }),
      ...(pkuLocation && { pkuLocation }), ...(delLocation && { delLocation }) })
      .then(matches => { if (live) setContractMismatch(!matches.some(m => m.id === shipment.contractId)); })
      .catch(() => { if (live) setContractMismatch(false); });
    return () => { live = false; };
  }, [shipment.contractType, shipment.contractId, matchPol, matchPod, needsPolHaulage, needsPodHaulage, pkuLocation, delLocation]);

  const ctrs = containers.filter(c => c.shipmentId === shipment.id);
  const teu = ctrs.reduce((n, c) => n + (c.size === "40" ? 2 : 1), 0);
  const dgClasses = [...new Set(ctrs.filter(c => c.isDg).map(c => c.dgClass).filter(Boolean))];
  const isDg = ctrs.some(c => c.isDg);
  const loopCode = schedules[0]?.service || "";

  const vesselVoyage = [shipment.vessel, shipment.voyage ? `Voy ${shipment.voyage}` : null].filter(Boolean).join(" · ");

  const copyId = () => {
    navigator.clipboard.writeText(shipment.id)
      .then(() => toast.success(`Copied ${shipment.id}`))
      .catch(() => toast.error("Could not copy to clipboard"));
  };

  return (
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
      padding: "14px 22px", marginBottom: 22, position: "sticky", top: 0, zIndex: 5,
    }}>
      {/* Row 1 — identity, route, dates, DG */}
      <div style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: 17, color: T.text,
            letterSpacing: "0.01em" }}>{shipment.id}</span>
          <button type="button" onClick={copyId} title="Copy shipment ID"
            style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 3px",
              display: "flex", alignItems: "center", fontSize: 12, lineHeight: 1, color: T.textMuted }}
            onMouseEnter={e => { e.currentTarget.style.color = T.accent; }}
            onMouseLeave={e => { e.currentTarget.style.color = T.textMuted; }}>
            📋
          </button>
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 600, letterSpacing: "0.03em",
          padding: "3px 9px", borderRadius: 5, background: T.accentBg, color: T.accent,
          border: `1px solid ${T.accent}66` }}>{shipment.movementType || "FCL"}</span>

        {(() => {
          const r = screening?.result;
          const isHit = r === "HIT";
          const overridden = screening?.overriddenAt;
          const bg = !r ? T.border + "33" : isHit ? "#ef444420" : "#22c55e20";
          const color = !r ? T.textMuted : isHit ? "#ef4444" : "#22c55e";
          const label = !r ? "UNSCREENED" : isHit ? "⚠ Compliance review required" : overridden ? "✓ CLEAR*" : "✓ CLEAR";
          const hitLines = isHit && screening?.hits?.length
            ? screening.hits.map(h => `${h.field}: ${h.value}`).join("\n")
            : null;
          const tooltipText = !r ? "Run compliance screening"
            : isHit ? `Sanctioned party detected:\n${hitLines}\n\nClick to review`
            : overridden ? "Cleared via manual override"
            : "Compliance clear";
          return (
            <button type="button" onClick={() => setComplianceOpen(true)}
              title={tooltipText}
              style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
                borderRadius: 5, padding: "3px 9px", letterSpacing: "0.03em", whiteSpace: "nowrap",
                border: `1px solid ${!r ? T.border : isHit ? "#ef444444" : "#22c55e44"}`,
                background: bg, color }}>
              {label}
            </button>
          );
        })()}

        <div style={{ width: 1, alignSelf: "stretch", background: T.border }} />

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: 15, color: T.text }}>{shipment.pol || "—"}</span>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{shipment.polName || ""}</span>
          </div>
          <span style={{ color: T.textMuted }}>→</span>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontFamily: T.mono, fontWeight: 700, fontSize: 15, color: T.text }}>{shipment.pod || "—"}</span>
            <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{shipment.podName || ""}</span>
          </div>
        </div>

        <div style={{ width: 1, alignSelf: "stretch", background: T.border }} />

        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontFamily: T.mono, fontSize: 10, textTransform: "uppercase",
              letterSpacing: "0.08em", color: T.textMuted }}>ETD</span>
            <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text,
              fontVariantNumeric: "tabular-nums" }}>{shipment.etd || "—"}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            <span style={{ fontFamily: T.mono, fontSize: 10, textTransform: "uppercase",
              letterSpacing: "0.08em", color: T.textMuted }}>ETA</span>
            <span style={{ fontFamily: T.mono, fontSize: 12.5, color: T.text,
              fontVariantNumeric: "tabular-nums" }}>{shipment.eta || "—"}</span>
          </div>
        </div>

        <div style={{ flex: 1 }} />

        {contractMismatch && (
          <button type="button" onClick={onNavigateToSchedules}
            title={`${shipment.contractRef || "The attached contract"} no longer covers ${matchPol} → ${matchPod} — click to resolve`}
            style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.03em",
              padding: "3px 9px", borderRadius: 5, background: T.danger + "22", color: T.danger,
              border: `1px solid ${T.danger}66`, whiteSpace: "nowrap", cursor: onNavigateToSchedules ? "pointer" : "default" }}>
            ⚠ Contract Mismatch
          </button>
        )}

        {isDg && (
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: "0.03em",
            padding: "3px 9px", borderRadius: 5, background: T.danger + "22", color: T.danger,
            border: `1px solid ${T.danger}66`, whiteSpace: "nowrap" }}>
            ⚠ DG{dgClasses.length ? ` · CLASS ${dgClasses.join("/")}` : ""}
          </span>
        )}
      </div>

      {/* Row 2 — secondary facts */}
      <div style={{ display: "flex", flexWrap: "wrap", rowGap: 6,
        marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
        <Field first label="Incoterm" value={shipment.incoterm} />
        <Field label="Routing" value={shipment.routingTerm} />
        <Field label="Vessel" value={vesselVoyage} />
        <Field label="Shipper" value={shipment.shipperName} />
        <Field label="Consignee" value={shipment.consigneeName} />
        <Field label="Contract" value={shipment.contractRef} />
        <Field label="TEU" value={ctrs.length ? String(teu) : null} />
        <Field label="Loop" value={loopCode} />
      </div>

      {/* Row 3 — the same route summary panel shown on the Schedules page (Pick-up/POL,
          ETD/transit/ETA/carrier/routing-term, POD/Delivery) — one visual for one concept
          instead of a second, different journey diagram. */}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
        <RouteSummaryBar shipment={shipment} />
      </div>

      {complianceOpen && (
        <ComplianceModal
          shipment={shipment}
          screening={screening}
          onChange={s => setScreening(s)}
          onClose={() => setComplianceOpen(false)}
        />
      )}

      {contractMismatch && onUpdate && (
        <ContractMismatchModal shipment={shipment} pol={matchPol} pod={matchPod}
          needsPolHaulage={needsPolHaulage} needsPodHaulage={needsPodHaulage}
          pkuLocation={pkuLocation} delLocation={delLocation}
          onUpdate={onUpdate} />
      )}
    </div>
  );
};

export default ShipmentHeaderBar;
