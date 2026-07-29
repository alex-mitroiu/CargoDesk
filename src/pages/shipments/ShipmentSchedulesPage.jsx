import { useState, useEffect, useRef } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import { Modal } from "../../components/primitives/Modal";
import { Inp } from "../../components/primitives/Form";
import DatePicker from "../../components/primitives/DatePicker";
import SailingPickerModal from "../../components/shared/SailingPickerModal";
import ContractAssignModal from "../../components/shared/ContractAssignModal";
import { ScheduleHistoryPanel, PendingRevalidationModal } from "./ShipmentDetailPage";
import { LegsTable, deriveHaulageNeeds } from "./ShipmentFormPage";
import { IconWarning, IconPackage, IconAnchor } from "../../components/primitives/Icon";
import { applySailingToLegs as applySailingToLegsShared } from "../../utils/applySailingToLegs";

// ─── Shipment Schedules Page ──────────────────────────────────────────────
// Dedicated sub-page for carrier schedule/booking management, promoted out
// of the anchor-scroll Overview page (see ARCHITECTURE.md §8.11).
//
// "Add Sailing" lives here (next to Route Legs, the thing it actually updates)
// rather than inside a separate Sailings box — the search/apply mechanics used
// to live in SchedulesPanel, which is now the read-only ScheduleHistoryPanel.

const sectionLabel = { fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: "0.08em", color: T.textMuted, marginBottom: 10 };

const todayStr = new Date().toISOString().slice(0, 10);

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
  const [pendingMatches, setPendingMatches] = useState(null);
  const [histOpen, setHistOpen] = useState(false);
  // True only while the sailing picker was auto-opened right after a contract was just
  // confirmed (that contract is already saved via onUpdate) — closing without picking a
  // sailing in that case leaves the shipment in a partial state, so it needs a confirmation.
  // A plain "Add Sailing" click (no pending contract commit) can close freely, as before.
  const [chainedFromContract, setChainedFromContract] = useState(false);
  const [confirmCloseSailing, setConfirmCloseSailing] = useState(false);
  // Lightweight correction for an already-saved sailing (e.g. a carrier-driven ETD/ETA shift) —
  // replaces the previous only-option of removing the SEA leg entirely (which cascades to
  // delete the schedule, unlock everything, and force a full re-search).
  const [updateScheduleLeg, setUpdateScheduleLeg] = useState(null);
  const [scheduleForm, setScheduleForm] = useState(null);

  useEffect(() => {
    api.schedules.list(shipment.id).then(setSchedules).catch(() => {});
  }, [shipment.id, historyVersion]);

  const openUpdateSchedule = (leg) => {
    const sched = schedules[0];
    if (!sched) return;
    setUpdateScheduleLeg(leg);
    setScheduleForm({ vesselName: sched.vesselName, voyageNumber: sched.voyageNumber,
      etd: sched.etd, eta: sched.eta, carrier: sched.carrier });
  };

  const saveScheduleUpdate = async () => {
    const sched = schedules[0];
    if (!sched || !scheduleForm) return;
    try {
      const updated = await api.schedules.update(shipment.id, sched.id, scheduleForm);
      setSchedules([updated]);
      setUpdateScheduleLeg(null);
      setScheduleForm(null);
      setLegsVersion(v => v + 1);
      setHistoryVersion(v => v + 1);
      await onRefresh?.();
      toast.success("Schedule updated");
    } catch (e) { toast.error(e.message); }
  };

  // Live-shipment leg-sync, shared with Test Tools' Schedule Generator (both operate on an
  // EXISTING shipment's already-persisted legs) — see src/utils/applySailingToLegs.js.
  const applySailingToLegs = sailing => applySailingToLegsShared(shipment.id, sailing,
    { contractType: shipment.contractType, contractRef: shipment.contractRef });

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
    setRouteOverride(null);
    setChainedFromContract(false);
    const existingVoy = schedules[0]?.voyageNumber;
    if (schedules.length > 0 && existingVoy !== sailing.voyageNumber) {
      setConfirmSailing(sailing);
    } else {
      commitSailing(sailing);
    }
  };

  // While a schedule is assigned, the schedule's own SEA leg (the one carrying real
  // vessel/voyage data from applySailingToLegs — see lockedSeaLegs below) is locked; the
  // only way to change it is to remove it, which this treats as "unlink the schedule":
  // since a TSP schedule's legs are one connected journey, removing the schedule's SEA leg
  // cascades to remove any other SEA legs too (rather than leaving a broken partial route),
  // and the shipment_schedules row(s) are removed so a freshly added SEA leg starts out
  // unlocked instead of immediately re-locking itself.
  const [legs, setLegs] = useState([]);
  // Tracks which leg ids actually belong to the assigned schedule (vessel/voyage populated),
  // not just a raw SEA-leg count — a brand new, still-blank SEA leg (freshly added via
  // "+ Add leg" while a schedule already exists) is NOT one of those, so adding one and then
  // removing it again must never cascade into unlinking the real schedule. Comparing counts
  // alone couldn't tell the two apart and cascaded on either.
  const prevScheduledLegIdsRef = useRef(null);
  const handleLegsChange = async (nextLegs) => {
    setLegs(nextLegs);
    const nextScheduledIds = new Set(
      nextLegs.filter(l => l.legType === "SEA" && (l.vessel || l.voyage)).map(l => l.id)
    );
    const prevIds = prevScheduledLegIdsRef.current;
    prevScheduledLegIdsRef.current = nextScheduledIds;
    // Only react once a schedule's own leg has actually disappeared — the initial fetch on
    // mount also fires this callback (prevIds === null), and adding/removing an unrelated
    // blank leg shouldn't cascade.
    if (prevIds === null || schedules.length === 0) return;
    const removedScheduledLeg = [...prevIds].some(id => !nextLegs.some(l => l.id === id));
    if (!removedScheduledLeg) return;
    try {
      const remainingSeaLegs = nextLegs.filter(l => l.legType === "SEA");
      await Promise.all(remainingSeaLegs.map(l => api.legs.remove(shipment.id, l.id)));
      await Promise.all(schedules.map(s => api.schedules.remove(shipment.id, s.id)));
      setSchedules([]);
      prevScheduledLegIdsRef.current = new Set();
      setLegsVersion(v => v + 1);
      setHistoryVersion(v => v + 1);
      // The last SEA leg's removal already clears the shipment's stale etd/eta/vessel/voyage
      // server-side (syncShipmentFromLegs) — without re-fetching here, the header stays on
      // its cached shipment prop and keeps showing the old sailing until an unrelated reload.
      await onRefresh?.();
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
  // Set from ContractAssignModal's onDone (the specific route the just-picked contract/space
  // config actually covers) so the chained sailing search scopes to what the contract was
  // rated for, not the shipment's generic SEA-leg span — a multi-leg TSP contract or a space
  // config tied to a different transship port than the shipment's current legs would
  // otherwise surface sailings unrelated to what was just selected.
  const [routeOverride, setRouteOverride] = useState(null);
  const sailingPol = routeOverride?.pol || pol;
  const sailingPod = routeOverride?.pod || pod;
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

  // Pending-contract revalidation — same check as ShipmentHeaderBar's badge (duplicated for
  // the same reason: cheap, and this is the page that renders the actual accept/dismiss UI).
  useEffect(() => {
    let live = true;
    if (shipment.contractType !== "Pending" || !shipment.contractRef) { setPendingMatches(null); return; }
    api.contracts.revalidate(shipment.contractRef)
      .then(matches => { if (live) setPendingMatches(matches.length > 0 ? matches : null); })
      .catch(() => { if (live) setPendingMatches(null); });
    return () => { live = false; };
  }, [shipment.id, shipment.contractType, shipment.contractRef]);

  // Linked space configuration — /api/allocations/match already computes consumedTEU/
  // remainingTEU server-side (same query SpaceConfigurationsPage uses for its consumption
  // bars), so this just picks the one entry matching shipment.allocationId out of that
  // route/date-scoped result set rather than re-deriving consumption client-side.
  const [linkedAlloc, setLinkedAlloc] = useState(null);
  useEffect(() => {
    let live = true;
    if (shipment.contractType !== "Central" || !shipment.allocationId || !pol || !pod || !shipment.etd) {
      setLinkedAlloc(null);
      return;
    }
    api.allocations.match({ pol, pod, etd: shipment.etd })
      .then(matches => { if (live) setLinkedAlloc(matches.find(a => a.id === shipment.allocationId) || null); })
      .catch(() => { if (live) setLinkedAlloc(null); });
    return () => { live = false; };
  }, [shipment.contractType, shipment.allocationId, pol, pod, shipment.etd]);

  const addSailingBtn = canEdit && (
    <button type="button"
      disabled={!canSearch}
      onClick={() => { if (canSearch) { setChainedFromContract(false); setPickerOpen(true); } }}
      style={{ background: "none", border: `1px solid ${T.border}`,
        borderRadius: 6, padding: "4px 12px", cursor: canSearch ? "pointer" : "not-allowed",
        fontFamily: T.body, fontSize: 12, color: canSearch ? T.text : T.textMuted,
        opacity: canSearch ? 1 : 0.5, display: "inline-flex", alignItems: "center", gap: 5 }}
      onMouseEnter={e => { if (canSearch) { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; }}}
      onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = canSearch ? T.text : T.textMuted; }}
      title={hasSchedule ? "A sailing is already assigned — remove the SEA leg to unlink and search again" : canSearch ? "Search and add a sailing" : "POL, POD and carrier must be set"}>
      <IconAnchor size={12} />Add Sailing
    </button>
  );

  const hasSpaceConfig = shipment.contractType === "Central" && shipment.allocationId;

  return (
    <div id="shpsched-page">
      <div id="shpsched-legs-section">
        <div style={sectionLabel}>Route Legs</div>
        <LegsTable key={`legs-${legsVersion}`} shipmentId={shipment.id} canEdit={canEdit} showContractCols={false}
          extraAction={addSailingBtn} lockedSeaLegs={schedules.length > 0} onLegsChange={handleLegsChange}
          onUpdateSchedule={canEdit ? openUpdateSchedule : null} />
      </div>

      <div style={{ marginTop: 22, marginBottom: 22,
        ...(hasSpaceConfig ? { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 } : {}) }}>
        <div id="shpsched-contract-section">
          <div style={sectionLabel}>Contract</div>
          {contractMismatch && (
            <div id="shpsched-contract-mismatch" style={{ background: T.danger + "12", border: `1px solid ${T.danger}55`, borderLeft: `3px solid ${T.danger}`,
              borderRadius: 8, padding: "12px 16px", marginBottom: 12,
              display: "flex", alignItems: "flex-start", gap: 10 }}>
              <span style={{ color: T.danger, fontSize: 15, lineHeight: 1.4, display: "inline-flex" }}><IconWarning size={15} /></span>
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
          <div style={{ display: "flex", alignItems: "center", gap: 14, maxWidth: hasSpaceConfig ? "none" : 480 }}>
            <div id="shpsched-contract-summary" style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", flex: 1,
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
                  border: `1px solid ${T.success}44`, borderRadius: 4, padding: "2px 8px", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}><IconPackage size={10} /> Space config</span>
              )}
              {shipment.contractType !== "Central" && shipment.contractValidTo && shipment.contractValidTo < todayStr && (
                <span title={`Expired ${shipment.contractValidTo}`}
                  style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, background: T.warning + "22", color: T.warning,
                  border: `1px solid ${T.warning}44`, borderRadius: 4, padding: "2px 8px", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 4 }}><IconWarning size={10} /> Expired</span>
              )}
            </div>
            {canEdit && (
              <Btn id="shpsched-contract-btn" size="sm" variant="secondary" onClick={() => setContractModalOpen(true)}>
                {shipment.contractRef ? "Change Contract" : "+ Add Contract"}
              </Btn>
            )}
          </div>
        </div>

        {hasSpaceConfig && (
          <div id="shpsched-space-config-section">
            <div style={sectionLabel}>Space Configuration</div>
            {linkedAlloc ? (
              <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 14px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                    {linkedAlloc.carrierCode} · {linkedAlloc.pol} → {linkedAlloc.pod}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.textMuted }}>
                    {linkedAlloc.contractNumber || "—"}
                  </span>
                </div>
                <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginBottom: 8 }}>
                  Valid {linkedAlloc.effectiveDate} → {linkedAlloc.endDate}
                </div>
                <div style={{ height: 6, borderRadius: 3, background: T.border, overflow: "hidden", marginBottom: 4 }}>
                  <div style={{ height: "100%",
                    width: `${Math.min(100, (linkedAlloc.consumedTEU / linkedAlloc.allocatedTEU) * 100)}%`,
                    background: (linkedAlloc.consumedTEU / linkedAlloc.allocatedTEU) * 100 >= (linkedAlloc.alertThreshold ?? 80)
                      ? T.danger : T.accent }} />
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                  {linkedAlloc.consumedTEU} / {linkedAlloc.allocatedTEU} TEU consumed ({linkedAlloc.remainingTEU} remaining)
                </div>
              </div>
            ) : (
              <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, fontStyle: "italic",
                background: T.bg, border: `1px dashed ${T.border}`, borderRadius: 8, padding: "12px 14px" }}>
                No active space configuration matches this shipment.
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <Btn id="shpsched-history-btn" size="sm" variant="secondary" onClick={() => setHistOpen(true)}>⏱ History</Btn>
      </div>
      {histOpen && (
        <Modal title="Schedule History" onClose={() => setHistOpen(false)} width={640}>
          <ScheduleHistoryPanel key={`history-${historyVersion}`} shipment={shipment} forceOpen />
        </Modal>
      )}

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
          pol={sailingPol} pod={sailingPod} carrierCode={carrier}
          routingTerm={shipment.routingTerm}
          expectedHub={routeOverride?.hub || null} expectedService={routeOverride?.service || null}
          activeSailing={schedules[0] || null}
          onSelect={handleSelectSailing}
          onClose={() => {
            // A contract was just committed as part of this chained flow — closing without
            // picking a sailing leaves that partial state, so confirm instead of discarding
            // silently. A plain "Add Sailing" open (nothing pending) can just close.
            if (chainedFromContract) setConfirmCloseSailing(true);
            else { setPickerOpen(false); setCarrierOverride(null); setRouteOverride(null); }
          }}
          selectLabel="Add →" />
      )}

      {confirmCloseSailing && (
        <Modal title="Close without a sailing?" onClose={() => setConfirmCloseSailing(false)} width={440}>
          <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, margin: "0 0 6px", lineHeight: 1.6 }}>
            The contract <strong style={{ fontFamily: T.mono }}>{shipment.contractRef || "you just picked"}</strong> has
            already been saved to this shipment, but no sailing has been selected yet.
          </p>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "0 0 20px" }}>
            You can add one later via "Add Sailing" — the contract selection stays either way.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={() => setConfirmCloseSailing(false)}>Keep searching</Btn>
            <Btn variant="danger" onClick={() => {
              setConfirmCloseSailing(false); setPickerOpen(false);
              setCarrierOverride(null); setRouteOverride(null); setChainedFromContract(false);
            }}>Close without a sailing</Btn>
          </div>
        </Modal>
      )}

      {contractModalOpen && (
        <ContractAssignModal
          shipment={shipment} legs={legs} pol={pol} pod={pod} onUpdate={onUpdate}
          onClose={() => setContractModalOpen(false)}
          onDone={async ({ isCentral, contractPicked, carrierCode, matchedRoute }) => {
            setContractModalOpen(false);
            // Real bug found on a live shipment (SHP-Y9E98X): changing the contract to a
            // different carrier while a schedule was already assigned used to leave the old
            // SEA leg(s)/shipment_schedules row silently in place — Route Legs kept showing
            // the OLD carrier/vessel/voyage forever, permanently disagreeing with the
            // shipment's own (now-updated) carrier/contract, since nothing here reacted to
            // it. That schedule was booked with a specific carrier; relabeling the shipment
            // around it doesn't make the old sailing valid for the new one — same "archive,
            // don't silently rewrite" principle as the carrier_bookings fix. Auto-unlink it
            // (the exact same cascade handleLegsChange already runs for a manual SEA-leg
            // removal — remove every SEA leg, then every shipment_schedules row) instead of
            // requiring the operator to notice the mismatch and separately go delete the leg.
            const carrierChanged = !!carrierCode && carrierCode !== shipment.carrierCode;
            if (carrierChanged && hasSchedule) {
              try {
                await Promise.all(legs.filter(l => l.legType === "SEA").map(l => api.legs.remove(shipment.id, l.id)));
                await Promise.all(schedules.map(s => api.schedules.remove(shipment.id, s.id)));
                setSchedules([]);
                prevScheduledLegIdsRef.current = new Set();
                setLegsVersion(v => v + 1);
                setHistoryVersion(v => v + 1);
                await onRefresh?.();
                toast.info("Previous schedule unlinked — it was booked with a different carrier. Pick a new sailing below.");
              } catch (e) { toast.error(e.message); }
            }
            // Contract routing already matches the request params — chain straight into
            // the sailing search rather than making the user re-open "Add Sailing" and
            // re-enter the same pol/pod/carrier that just got confirmed. Scoped to the
            // contract/space-config's own matched route (matchedRoute), not the shipment's
            // generic SEA-leg span — see routeOverride above.
            if (isCentral && contractPicked && (!hasSchedule || carrierChanged)) {
              setCarrierOverride(carrierCode || "");
              setRouteOverride(matchedRoute || null);
              setChainedFromContract(true);
              setPickerOpen(true);
            }
          }} />
      )}

      {pendingMatches && canEdit && (
        <PendingRevalidationModal
          matches={pendingMatches}
          contractRef={shipment.contractRef}
          onAccept={async contract => {
            try {
              await onUpdate(shipment.id, {
                ...shipment,
                contractType: "Central",
                contractId:   contract.id,
                contractRef:  contract.contractNumber,
              });
            } finally {
              setPendingMatches(null);
            }
          }}
          onDismiss={() => setPendingMatches(null)}
        />
      )}

      {updateScheduleLeg && scheduleForm && (
        <Modal title="Update Schedule" onClose={() => { setUpdateScheduleLeg(null); setScheduleForm(null); }} width={440}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: 0, lineHeight: 1.5 }}>
              Correct the vessel, voyage or dates for the currently assigned sailing — e.g. a
              carrier-driven ETD/ETA shift. This updates the SEA leg in place without unlinking
              the schedule, and logs the change in Schedule History.
            </p>
            <Inp id="shpsched-update-vessel" label="Vessel" value={scheduleForm.vesselName}
              onChange={v => setScheduleForm(f => ({ ...f, vesselName: v }))} />
            <Inp id="shpsched-update-voyage" label="Voyage" value={scheduleForm.voyageNumber} mono
              onChange={v => setScheduleForm(f => ({ ...f, voyageNumber: v }))} />
            <div style={{ display: "flex", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <DatePicker id="shpsched-update-etd" label="ETD" value={scheduleForm.etd}
                  onChange={v => setScheduleForm(f => ({ ...f, etd: v }))} />
              </div>
              <div style={{ flex: 1 }}>
                <DatePicker id="shpsched-update-eta" label="ETA" value={scheduleForm.eta} minDate={scheduleForm.etd || undefined}
                  onChange={v => setScheduleForm(f => ({ ...f, eta: v }))} />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn id="shpsched-update-cancel-btn" variant="secondary" onClick={() => { setUpdateScheduleLeg(null); setScheduleForm(null); }}>Cancel</Btn>
              <Btn id="shpsched-update-save-btn" onClick={saveScheduleUpdate}>Save</Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default ShipmentSchedulesPage;
