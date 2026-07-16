import { useState, useEffect, useRef } from "react";
import { T } from "../tokens";
import { useAuth } from "../AuthContext";
import { api } from "../api";
import { toast } from "../toast";
import Btn from "../components/primitives/Btn";
import { Modal } from "../components/primitives/Modal";
import SailingPickerModal from "../components/shared/SailingPickerModal";
import ContractAssignModal from "../components/shared/ContractAssignModal";
import { ScheduleHistoryPanel } from "./ShipmentDetailPage";
import { LegsTable, deriveHaulageNeeds } from "./ShipmentFormPage";

// ─── Shipment Schedules Page ──────────────────────────────────────────────
// Dedicated sub-page for carrier schedule/booking management, promoted out
// of the anchor-scroll Overview page (see ARCHITECTURE.md §8.11).
//
// "Add Sailing" lives here (next to Route Legs, the thing it actually updates)
// rather than inside a separate Sailings box — the search/apply mechanics used
// to live in SchedulesPanel, which is now the read-only ScheduleHistoryPanel.

const sectionLabel = { fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: "0.08em", color: T.textMuted, marginBottom: 10 };

const ShipmentSchedulesPage = ({ shipment, onBack, onUpdate, onRefresh }) => {
  const { canEditShipments: canEdit } = useAuth();
  // Bumped whenever a sailing is applied to the shipment's SEA leg(s), so LegsTable
  // (self-fetches once on mount) remounts and picks up the new vessel/voyage/dates
  // instead of showing stale data until navigating away and back.
  const [legsVersion, setLegsVersion] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);

  const [schedules,     setSchedules]     = useState([]);
  const [pickerOpen,    setPickerOpen]    = useState(false);
  const [confirmSailing, setConfirmSailing] = useState(null); // pending replacement
  const [contractMismatch, setContractMismatch] = useState(false);
  const [contractModalOpen, setContractModalOpen] = useState(false);

  useEffect(() => {
    api.schedules.list(shipment.id).then(setSchedules).catch(() => {});
  }, [shipment.id, historyVersion]);

  // Mirrors ShipmentFormPage's applySailingToLegs, but against an EXISTING shipment's
  // already-persisted legs (live api.legs.* calls) instead of local draft state.
  const applySailingToLegs = async (sailing) => {
    const legs = await api.legs.list(shipment.id);
    const seaLegs = legs.filter(l => l.legType === "SEA");
    if (seaLegs.length === 0) return false;
    const [firstSeaLeg, ...extraSeaLegs] = seaLegs;
    const isTSP = sailing.legs && sailing.legs.length > 1;

    if (isTSP) {
      await api.legs.update(shipment.id, firstSeaLeg.id, {
        ...firstSeaLeg,
        vessel:      sailing.legs[0].vesselName   || firstSeaLeg.vessel,
        voyage:      sailing.legs[0].voyageNumber || firstSeaLeg.voyage,
        etd:         sailing.legs[0].etd          || firstSeaLeg.etd,
        eta:         sailing.legs[0].eta          || firstSeaLeg.eta,
        pod:         sailing.legs[0].pod          || firstSeaLeg.pod,
        podName:     sailing.legs[0].pod !== firstSeaLeg.pod ? "" : firstSeaLeg.podName,
        carrierCode: sailing.carrier              || firstSeaLeg.carrierCode,
      });
      // Any existing trailing SEA legs belong to the OLD sailing — replace them with
      // fresh legs for the new sailing's remaining segments.
      for (const stale of extraSeaLegs) await api.legs.remove(shipment.id, stale.id);
      for (const leg of sailing.legs.slice(1)) {
        await api.legs.create(shipment.id, {
          legType: "SEA", movementType: "SEA", movementBy: "",
          polLocType: "Terminal", podLocType: "Terminal",
          pol: leg.pol, pod: leg.pod, etd: leg.etd, eta: leg.eta,
          carrierCode: sailing.carrier || "",
          vessel: leg.vesselName || "", voyage: leg.voyageNumber || "",
          contractType: firstSeaLeg.contractType || "SPOT", contractRef: firstSeaLeg.contractRef || "",
        });
      }
      toast.success(`TSP sailing applied — ${sailing.legs.length} sea legs updated`);
      return true;
    } else {
      await api.legs.update(shipment.id, firstSeaLeg.id, {
        ...firstSeaLeg,
        vessel:      sailing.vesselName   || firstSeaLeg.vessel,
        voyage:      sailing.voyageNumber || firstSeaLeg.voyage,
        etd:         sailing.etd          || firstSeaLeg.etd,
        eta:         sailing.eta          || firstSeaLeg.eta,
        carrierCode: sailing.carrier      || firstSeaLeg.carrierCode,
        // A direct sailing's own pol/pod is always the true door-to-door endpoints
        // (mockSailings/maerskSchedules both echo the search query here) — reset both
        // in case the leg currently holds a TSP hub from a previously-applied sailing.
        pol:         sailing.pol          || firstSeaLeg.pol,
        pod:         sailing.pod          || firstSeaLeg.pod,
        polName:     sailing.pol !== firstSeaLeg.pol ? "" : firstSeaLeg.polName,
        podName:     sailing.pod !== firstSeaLeg.pod ? "" : firstSeaLeg.podName,
      });
      // A direct sailing was selected for what used to be a multi-leg (TSP) journey —
      // collapse back down to a single SEA leg rather than leaving stale extra legs.
      for (const extra of extraSeaLegs) await api.legs.remove(shipment.id, extra.id);
      toast.success("Sailing applied to SEA leg");
      return true;
    }
  };

  const commitSailing = async (sailing) => {
    try {
      await Promise.all(schedules.map(s => api.schedules.remove(shipment.id, s.id)));
      const saved = await api.schedules.save(shipment.id, sailing);
      setSchedules([saved]);
      const appliedToLegs = await applySailingToLegs(sailing);
      if (appliedToLegs) {
        setLegsVersion(v => v + 1);
        await onRefresh?.();
      } else {
        toast.success(`Sailing ${sailing.vesselName} saved`);
      }
      setHistoryVersion(v => v + 1);
    } catch (e) { toast.error(e.message); }
  };

  const handleSelectSailing = (sailing) => {
    setPickerOpen(false);
    setCarrierOverride(null);
    const existingVoy = schedules[0]?.voyageNumber;
    if (schedules.length > 0 && existingVoy !== sailing.voyageNumber) {
      setConfirmSailing(sailing);
    } else {
      commitSailing(sailing);
    }
  };

  // While a schedule is assigned, SEA leg fields are locked (see lockedSeaLegs below) —
  // the only way to change them is to remove a SEA leg, which this treats as "unlink the
  // schedule": since a TSP schedule's legs are one connected journey, removing any single
  // SEA leg cascades to remove the rest too (rather than leaving a broken partial route),
  // and the shipment_schedules row(s) are removed so a freshly added SEA leg starts out
  // unlocked instead of immediately re-locking itself.
  const [legs, setLegs] = useState([]);
  const prevSeaLegCountRef = useRef(null);
  const handleLegsChange = async (nextLegs) => {
    setLegs(nextLegs);
    const nextSeaLegs = nextLegs.filter(l => l.legType === "SEA");
    const prevCount = prevSeaLegCountRef.current;
    prevSeaLegCountRef.current = nextSeaLegs.length;
    // Only react to an actual removal (fewer SEA legs than before) — the initial fetch on
    // mount also fires this callback, and adding a Pick-up/Delivery leg shouldn't cascade.
    if (prevCount === null || nextSeaLegs.length >= prevCount || schedules.length === 0) return;
    try {
      await Promise.all(nextSeaLegs.map(l => api.legs.remove(shipment.id, l.id)));
      await Promise.all(schedules.map(s => api.schedules.remove(shipment.id, s.id)));
      setSchedules([]);
      prevSeaLegCountRef.current = 0;
      setLegsVersion(v => v + 1);
      setHistoryVersion(v => v + 1);
      toast.success("Schedule unlinked — SEA leg(s) removed, fields are editable again");
    } catch (e) { toast.error(e.message); }
  };

  // shipment.pol/pod are the journey's overall door-to-door bookends — with a Door pickup
  // leg or a multi-leg (TSP) journey, that's not the same as the actual SEA leg(s)' own
  // pol/pod. Search on the real SEA leg(s) or the sailing picker offers routes that have
  // nothing to do with the shipment's actual ocean leg (and, since the mock/live sailing
  // search echoes the query back as the result's own pol/pod, picking one would silently
  // overwrite the real SEA leg(s) with an unrelated route).
  const seaLegsForSearch = legs.filter(l => l.legType === "SEA");
  const pol = seaLegsForSearch[0]?.pol || shipment.pol || "";
  const pod = seaLegsForSearch[seaLegsForSearch.length - 1]?.pod || shipment.pod || "";
  // Overridden right after a contract is confirmed, so the chained sailing search below
  // uses the just-picked carrier immediately instead of the stale shipment.carrierCode
  // prop (onUpdate's PUT hasn't round-tripped back into this component yet).
  const [carrierOverride, setCarrierOverride] = useState(null);
  const carrier = carrierOverride ?? (shipment.carrierCode || "");
  const hasSchedule = schedules.length > 0;
  const canSearch = !!(pol && pod && carrier) && !hasSchedule;

  // Same silent revalidation as ShipmentHeaderBar's badge — duplicated here (rather than
  // shared) since it's a small, cheap check and this is the one place that also renders
  // the actual fix UI right below the warning. Matches against the real SEA leg pol/pod
  // (above), not shipment.pol/pod — those are the door-to-door bookends, and a contract
  // is always matched port-to-port against the actual ocean leg, including haulage coverage.
  const { needsPolHaulage, needsPodHaulage, pkuLocation, delLocation } = deriveHaulageNeeds(legs);
  useEffect(() => {
    let live = true;
    if (shipment.contractType !== "Central" || !shipment.contractId || !pol || !pod) {
      setContractMismatch(false);
      return;
    }
    api.contracts.match({ pol, pod,
      ...(needsPolHaulage && { needsPolHaulage: "1" }), ...(needsPodHaulage && { needsPodHaulage: "1" }),
      ...(pkuLocation && { pkuLocation }), ...(delLocation && { delLocation }) })
      .then(matches => { if (live) setContractMismatch(!matches.some(m => m.id === shipment.contractId)); })
      .catch(() => { if (live) setContractMismatch(false); });
    return () => { live = false; };
  }, [shipment.contractType, shipment.contractId, pol, pod, needsPolHaulage, needsPodHaulage, pkuLocation, delLocation]);

  const addSailingBtn = canEdit && (
    <button type="button"
      disabled={!canSearch}
      onClick={() => canSearch && setPickerOpen(true)}
      style={{ background: "none", border: `1px solid ${T.border}`,
        borderRadius: 6, padding: "4px 12px", cursor: canSearch ? "pointer" : "not-allowed",
        fontFamily: T.body, fontSize: 12, color: canSearch ? T.text : T.textMuted,
        opacity: canSearch ? 1 : 0.5 }}
      onMouseEnter={e => { if (canSearch) { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}}
      onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = canSearch ? T.text : T.textMuted; }}
      title={hasSchedule ? "A sailing is already assigned — remove the SEA leg to unlink and search again" : canSearch ? "Search and add a sailing" : "POL, POD and carrier must be set"}>
      ⚓ Add Sailing
    </button>
  );

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={sectionLabel}>Route Legs</div>
      <LegsTable key={`legs-${legsVersion}`} shipmentId={shipment.id} canEdit={canEdit} showContractCols={false}
        extraAction={addSailingBtn} lockedSeaLegs={schedules.length > 0} onLegsChange={handleLegsChange} />

      <div style={{ ...sectionLabel, marginTop: 22 }}>Contract</div>
      {contractMismatch && (
        <div style={{ background: T.danger + "12", border: `1px solid ${T.danger}55`, borderLeft: `3px solid ${T.danger}`,
          borderRadius: 8, padding: "12px 16px", marginBottom: 12, maxWidth: 480,
          display: "flex", alignItems: "flex-start", gap: 10 }}>
          <span style={{ color: T.danger, fontSize: 15, lineHeight: 1.4 }}>⚠</span>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 700, color: T.danger, marginBottom: 3 }}>
              Contract doesn't cover this route
            </div>
            <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, lineHeight: 1.55 }}>
              <strong style={{ fontFamily: T.mono, color: T.text }}>{shipment.contractRef || "This contract"}</strong> no
              longer matches <strong style={{ fontFamily: T.mono, color: T.text }}>{pol} → {pod}</strong>.
              Pick a new one below — via a linked space configuration, the Central contract list, or switch to SPOT/Pending/Customer Own.
            </div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 22, maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", flex: 1,
          background: T.bg, border: `1px solid ${contractMismatch ? T.danger + "66" : T.border}`, borderRadius: 8 }}>
          <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
            padding: "2px 8px", borderRadius: 4, background: T.accentBg, color: T.accent, flexShrink: 0 }}>
            {shipment.contractType || "—"}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 13, color: shipment.contractRef ? T.text : T.textMuted,
            fontWeight: shipment.contractRef ? 700 : 400, fontStyle: shipment.contractRef ? "normal" : "italic",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {shipment.contractRef || "No contract assigned"}
          </span>
          {shipment.allocationId && (
            <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, background: T.success + "22", color: T.success,
              border: `1px solid ${T.success}44`, borderRadius: 4, padding: "2px 8px", flexShrink: 0 }}>📦 Space config</span>
          )}
        </div>
        {canEdit && (
          <Btn size="sm" variant="secondary" onClick={() => setContractModalOpen(true)}>
            {shipment.contractRef ? "Change Contract" : "+ Add Contract"}
          </Btn>
        )}
      </div>

      <div style={{ ...sectionLabel, marginTop: 22 }}>Schedule History</div>
      <ScheduleHistoryPanel key={`history-${historyVersion}`} shipment={shipment} />

      {confirmSailing && (
        <Modal title="Replace sailing?" onClose={() => setConfirmSailing(null)} width={420}>
          <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, margin: "0 0 6px", lineHeight: 1.6 }}>
            This will replace{" "}
            <strong style={{ fontFamily: T.mono }}>{schedules[0]?.vesselName || "the current sailing"}</strong>
            {" "}with{" "}
            <strong style={{ fontFamily: T.mono }}>{confirmSailing.vesselName}</strong>
            {" "}· Voy {confirmSailing.voyageNumber}.
          </p>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "0 0 20px" }}>
            The previous sailing record will be removed.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={() => setConfirmSailing(null)}>Cancel</Btn>
            <Btn onClick={() => { commitSailing(confirmSailing); setConfirmSailing(null); }}>Replace</Btn>
          </div>
        </Modal>
      )}

      {pickerOpen && (
        <SailingPickerModal
          pol={pol} pod={pod} carrierCode={carrier}
          routingTerm={shipment.routingTerm}
          activeSailing={schedules[0] || null}
          onSelect={handleSelectSailing}
          onClose={() => { setPickerOpen(false); setCarrierOverride(null); }}
          selectLabel="Add →" />
      )}

      {contractModalOpen && (
        <ContractAssignModal
          shipment={shipment} legs={legs} pol={pol} pod={pod} onUpdate={onUpdate}
          onClose={() => setContractModalOpen(false)}
          onDone={({ isCentral, contractPicked, carrierCode }) => {
            setContractModalOpen(false);
            // Contract routing already matches the request params — chain straight into
            // the sailing search rather than making the user re-open "Add Sailing" and
            // re-enter the same pol/pod/carrier that just got confirmed.
            if (isCentral && contractPicked && !hasSchedule) {
              setCarrierOverride(carrierCode || "");
              setPickerOpen(true);
            }
          }} />
      )}
    </div>
  );
};

export default ShipmentSchedulesPage;
