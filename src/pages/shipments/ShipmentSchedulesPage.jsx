import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import Spinner from "../../components/primitives/Spinner";
import { Modal } from "../../components/primitives/Modal";
import SailingPickerModal from "../../components/shared/SailingPickerModal";
import ContractAssignModal from "../../components/shared/ContractAssignModal";
import CustomerCombobox from "../../components/shared/CustomerCombobox";
import { ScheduleHistoryPanel, PendingRevalidationModal } from "./ShipmentDetailPage";
import { LegsTable, deriveHaulageNeeds } from "./ShipmentFormPage";
import { IconWarning, IconPackage, IconAnchor } from "../../components/primitives/Icon";
import useContractMismatch from "../../hooks/useContractMismatch";
import ConsumptionBar from "../../components/shared/ConsumptionBar";
import { deriveLoopCode } from "../../utils/scheduleLoop";
import { emitLegsScheduleChanged } from "../../legsScheduleBus";
import useSaving from "../../hooks/useSaving";
import { setNavigationGuard, clearNavigationGuard } from "../../navigationGuard";

// ─── Shipment Schedules Page ──────────────────────────────────────────────
// Dedicated sub-page for carrier schedule/booking management, promoted out
// of the anchor-scroll Overview page (see ARCHITECTURE.md §8.11).
//
// "Add Sailing" lives here (next to Route Legs, the thing it actually updates)
// rather than inside a separate Sailings box — the search/apply mechanics used
// to live in SchedulesPanel, which is now the read-only ScheduleHistoryPanel.
//
// Staged-draft model (PoC, direct request): Route Legs + Add Sailing/Remove Leg no longer
// commit to the server on every click — they mutate local `draftLegs`/`draftSailing` state
// (LegsTable's own existing draft mode, the same mechanism the New Shipment form's create mode
// already uses — see ShipmentFormPage.jsx's `isDraft = !shipmentId`) until an explicit "Save"
// validates the whole picture and commits it in one pass. Concrete motivating example: removing
// the existing schedule, adding a new one, and leaving POL/POD blank used to save that
// incomplete state instantly — Save now catches this with a bulleted error modal before
// anything is written, with an explicit Discard as the only way past it besides fixing the
// issues (no silent "I'll fix it later"). Attempting to navigate away with a valid draft
// auto-saves it via the existing `navigationGuard.js` mechanism (already used by
// ShipmentContainersPage.jsx's ContainerForm for the same "validate before letting the user
// leave" purpose); an invalid draft blocks navigation the same way Save does. Deliberately
// scoped down, per direct confirmation: "Change Contract" keeps its own existing modal and
// immediate commit (just disabled while a draft is pending, so the two commit paths never
// interleave), and the old "locked schedule leg" concept (read-only until explicitly unlinked)
// is dropped entirely — every leg is always directly editable once a draft is in progress,
// exactly like the New Shipment form already behaves; Save's validation is the real safety net
// now, not a separate lock/unlock mechanic.

const sectionLabel = { fontFamily: T.mono, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: "0.08em", color: T.textMuted, marginBottom: 10 };

const todayStr = new Date().toISOString().slice(0, 10);

// Export/Import Line Agent — a compact assign/reassign/remove field, deliberately narrower than
// AdditionalPartiesPanel's generic party editor (which handles all 9 ADDITIONAL_PARTY_ROLES with
// one blanket canEditShipments gate): these two roles are each restricted to their own office
// side, so this needs its own per-instance `canEdit` rather than one shared flag.
const LineAgentField = ({ label, role, party, canEdit, onAssign, onRemove }) => {
  const [editing, setEditing] = useState(false);
  const [value,   setValue]   = useState({ id: "", name: "" });
  const [saving,  setSaving]  = useState(false);

  const startEdit = () => {
    setValue(party ? { id: party.customerId, name: party.customerName } : { id: "", name: "" });
    setEditing(true);
  };
  const save = async () => {
    if (!value.id) return;
    setSaving(true);
    await onAssign(party?.id, value.id, value.name);
    setSaving(false);
    setEditing(false);
  };

  return (
    <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 16px" }}>
      <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 6 }}>{label}</div>
      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <CustomerCombobox label="Customer" value={value} onChange={setValue} roleFilter={role} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn size="sm" variant="secondary" onClick={() => setEditing(false)}>Cancel</Btn>
            <Btn size="sm" disabled={saving || !value.id} onClick={save}>{saving ? "Saving…" : "Save"}</Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: T.body, fontSize: 14, fontWeight: 700,
            color: party ? T.text : T.textMuted, fontStyle: party ? "normal" : "italic" }}>
            {party ? party.customerName : "Not assigned"}
          </div>
          {canEdit && (
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" title={party ? "Reassign" : "Assign"} onClick={startEdit}
                style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 13 }}
                onMouseEnter={e => e.currentTarget.style.color = T.text}
                onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                {party ? "✎" : "＋"}
              </button>
              {party && (
                <button type="button" title="Remove" onClick={() => onRemove(party.id)}
                  style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted, fontSize: 15, lineHeight: 1 }}
                  onMouseEnter={e => e.currentTarget.style.color = T.danger}
                  onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>
                  ×
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const ShipmentSchedulesPage = ({ shipment, onBack, onUpdate, onRefresh }) => {
  const { canEditShipments: canEdit, activeOffice, allOffices, isAdmin, activeRoles } = useAuth();
  // Change Contract's own carrier-changed cascade (below) is the one remaining multi-step async
  // operation on this page that still hits the server immediately — everything else route-leg/
  // sailing-related is now a local draft mutation with no network call until Save.
  const [isSaving, withSaving] = useSaving();
  // Bumped on every successful commit so the initial-legs-fetch effect below re-seeds
  // draftLegs/originalLegsSnapshot from the server's normalized post-save state (real ids for
  // anything created this round, etc.) instead of trusting the client-side draft forever.
  const [legsVersion, setLegsVersion] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);

  // null (not []) until the first fetch resolves — [] is indistinguishable from "confirmed, no
  // schedule assigned", so this page briefly rendered an unlocked/"no schedule" state on every
  // load before the real data arrived (same []-vs-null gap fixed elsewhere in the app). Kept as
  // `schedules` for the loading gate; `scheduleList` below is the safe-to-index array everywhere
  // else in this component reads it — this deliberately keeps the loading gate as the LAST thing
  // computed before the JSX return (after every hook has already run this render), so no hook
  // ends up called conditionally.
  const [schedules,     setSchedules]     = useState(null);
  const scheduleList = schedules || [];
  const [pickerOpen,    setPickerOpen]    = useState(false);
  const [confirmSailing, setConfirmSailing] = useState(null); // pending replacement
  const [contractModalOpen, setContractModalOpen] = useState(false);
  const [pendingMatches, setPendingMatches] = useState(null);
  const [histOpen, setHistOpen] = useState(false);
  // True only while the sailing picker was auto-opened right after a contract was just
  // confirmed (that contract is already saved via onUpdate) — closing without picking a
  // sailing in that case leaves the shipment in a partial state, so it needs a confirmation.
  // A plain "Add Sailing" click (no pending contract commit) can close freely, as before.
  const [chainedFromContract, setChainedFromContract] = useState(false);
  const [confirmCloseSailing, setConfirmCloseSailing] = useState(false);

  useEffect(() => {
    api.schedules.list(shipment.id).then(setSchedules).catch(() => {});
  }, [shipment.id, historyVersion]);

  // ── Staged draft: route legs + a freshly-picked sailing ────────────────────────────────
  // draftLegs/originalLegsSnapshot are seeded together from the server on mount and after
  // every successful commit (legsVersion bump) — LegsTable renders in its existing draft mode
  // (shipmentId={null}) rather than its live-CRUD mode, so every edit/add/remove only mutates
  // this local array; nothing reaches the server until commitDraft() runs (Save, or an
  // auto-save on navigating away with a valid draft).
  const [draftLegs, setDraftLegs] = useState(null);
  const [originalLegsSnapshot, setOriginalLegsSnapshot] = useState(null);
  // Set the moment a NEW sailing is picked (Add/Change Sailing) — remembered separately from
  // draftLegs because a schedule row needs the sailing's own full shape (transitDays/isMock/
  // scheduleId) that doesn't survive being flattened onto leg fields. Stays as picked even if
  // the leg is hand-edited afterward, same decoupled relationship shipment_schedules already
  // has with shipment_legs elsewhere in this app.
  const [draftSailing, setDraftSailing] = useState(null);
  const [validationErrors, setValidationErrors] = useState(null); // null = modal closed

  useEffect(() => {
    let live = true;
    api.legs.list(shipment.id).then(rows => {
      if (!live) return;
      setDraftLegs(rows);
      setOriginalLegsSnapshot(rows);
      setDraftSailing(null);
    }).catch(() => {});
    return () => { live = false; };
  }, [shipment.id, legsVersion]);

  const isDirty = draftLegs !== null && originalLegsSnapshot !== null &&
    (draftSailing !== null || JSON.stringify(draftLegs) !== JSON.stringify(originalLegsSnapshot));

  // Contract rate lines — direct request for a facelift on the plain one-line contract summary
  // below: once a Central contract is actually attached, fetch its full detail (rates included)
  // so the rate table can show real type/rate id/container type/amount instead of just the
  // contract number. Only fetched for a real Central contractId — SPOT/Pending/Customer Own have
  // no contract_rates row to speak of, the table renders a dashed placeholder row for those
  // instead of attempting a fetch that has nothing to return.
  const [contractDetail, setContractDetail] = useState(null);
  useEffect(() => {
    if (shipment.contractType !== "Central" || !shipment.contractId) { setContractDetail(null); return; }
    let live = true;
    api.contracts.get(shipment.contractId).then(c => { if (live) setContractDetail(c); }).catch(() => { if (live) setContractDetail(null); });
    return () => { live = false; };
  }, [shipment.contractType, shipment.contractId]);

  // "Rate ID" (below) used to join every rate line's own id on the assigned CONTRACT — a real
  // contract legitimately carries several (one per charge type), so this always showed 2-3+ ids
  // and read as duplication (2026-09-06 audit, SHP-WKX04E). What it's meant to represent is the
  // shipment's OWN current governing rate — the latest shipment_rate_snapshots row, same
  // ORDER BY generated_at DESC LIMIT 1 "latest wins" convention already used everywhere else this
  // is resolved (routes/edi.js's booking-request payload, GenerateDocumentModal.jsx).
  const [latestRateSnapshotId, setLatestRateSnapshotId] = useState(null);
  useEffect(() => {
    if (shipment.contractType !== "Central" || !shipment.contractId) { setLatestRateSnapshotId(null); return; }
    let live = true;
    api.costLines.rateSnapshots(shipment.id).then(rows => { if (live) setLatestRateSnapshotId(rows[0]?.id || ""); }).catch(() => { if (live) setLatestRateSnapshotId(""); });
    return () => { live = false; };
  }, [shipment.id, shipment.contractType, shipment.contractId]);

  // Export/Import Line Agent — surfaced here (not just on Parties & Offices) since schedule and
  // contract selection are also an export-side-only action on this page; keeping both under the
  // same office-side permission model in one place matches how the operator actually works.
  // null (not []) until the fetch resolves, same "don't render a false empty state" convention
  // this page already uses for `schedules` above.
  const [parties, setParties] = useState(null);
  const loadParties = () => api.shipmentParties.list(shipment.id).then(setParties).catch(() => setParties([]));
  useEffect(() => { loadParties(); }, [shipment.id]);
  const exportLineAgent = (parties || []).find(p => p.role === "Line Agent (Export)") || null;
  const importLineAgent = (parties || []).find(p => p.role === "Line Agent (Import)") || null;

  // Client-side mirror of the server's canEditOfficeSide (routes/shipments.js) — same pattern
  // PartiesOfficesPanel (ShipmentDetailPage.jsx) already established for EMO/IMO office editing.
  // The server re-checks this on every write; this only decides what to render as editable.
  const roleBypass = isAdmin || (activeRoles || []).includes("operator");
  const canEditSideDept = dept => canEdit && (roleBypass || allOffices || activeOffice?.department === dept);
  const canEditExportLineAgent = canEditSideDept("SE");
  const canEditImportLineAgent = canEditSideDept("SI");

  const handleAssignLineAgent = async (role, existingId, customerId, customerName) => {
    try {
      if (existingId) await api.shipmentParties.update(shipment.id, existingId, { customerId, customerName });
      else await api.shipmentParties.create(shipment.id, { role, customerId, customerName });
      await loadParties();
      toast.success(`${role} ${existingId ? "reassigned" : "assigned"}`);
    } catch (e) { toast.error(e.message); }
  };
  const handleRemoveLineAgent = async id => {
    try {
      await api.shipmentParties.remove(shipment.id, id);
      setParties(list => list.filter(p => p.id !== id));
    } catch (e) { toast.error(e.message); }
  };

  // ── Staging a picked sailing onto draftLegs — local-only, no API call ─────────────────────
  // Adapted from ShipmentFormPage.jsx's own create-mode applySailingToLegs closure (the New
  // Shipment form's exact equivalent for staging a sailing pick before Create) rather than
  // applySailingToLegsShared, which is the *live*-mode variant that writes to the server
  // immediately — that one stays in use only by src/utils/applySailingToLegs.js's other real
  // caller (Test Tools' Schedule Generator, which does operate on an already-persisted leg).
  const applySailingToDraft = (sailing) => {
    const list = draftLegs || [];
    const firstSeaIdx = list.findIndex(l => l.legType === "SEA");
    const isTSPForCreate = sailing.legs && sailing.legs.length > 1;

    if (firstSeaIdx === -1) {
      const segments = isTSPForCreate ? sailing.legs : [{
        pol: sailing.pol, pod: sailing.pod, etd: sailing.etd, eta: sailing.eta,
        vesselName: sailing.vesselName, voyageNumber: sailing.voyageNumber,
      }];
      const newLegs = segments.map((leg, i) => ({
        id:           `draft_${Date.now() + i}`,
        legType:      "SEA",
        movementType: "SEA",
        movementBy:   "",
        polLocType:   "Terminal",
        podLocType:   "Terminal",
        pol:          leg.pol,      polName: "",
        pod:          leg.pod,      podName: "",
        etd:          leg.etd,
        eta:          leg.eta,
        carrierCode:  sailing.carrier || "",
        vessel:       leg.vesselName   || "",
        vesselImo:    "",
        voyage:       leg.voyageNumber || "",
        contractType: shipment.contractType || "SPOT",
        contractRef:  shipment.contractRef  || "",
      }));
      setDraftLegs([...list, ...newLegs]);
      toast.success(isTSPForCreate
        ? `TSP sailing staged — ${newLegs.length} sea legs created`
        : "Sailing staged — SEA leg created");
      return;
    }
    const firstSeaLeg = list[firstSeaIdx];
    // Drop every SEA leg AFTER the first one — they belong to whatever routing was there
    // before (a previous TSP pick), and would otherwise sit stale alongside this new sailing.
    const base = list.filter((l, i) => i === firstSeaIdx || l.legType !== "SEA");
    const baseFirstIdx = base.indexOf(firstSeaLeg);
    const isTSP = sailing.legs && sailing.legs.length > 1;
    if (isTSP) {
      const updatedFirst = {
        ...firstSeaLeg,
        vessel:      sailing.legs[0].vesselName   || firstSeaLeg.vessel,
        voyage:      sailing.legs[0].voyageNumber || firstSeaLeg.voyage,
        etd:         sailing.legs[0].etd          || firstSeaLeg.etd,
        eta:         sailing.legs[0].eta          || firstSeaLeg.eta,
        pod:         sailing.legs[0].pod          || firstSeaLeg.pod,
        podName:     sailing.legs[0].pod !== firstSeaLeg.pod ? "" : firstSeaLeg.podName,
        carrierCode: sailing.carrier              || firstSeaLeg.carrierCode,
      };
      const extraLegs = sailing.legs.slice(1).map((leg, i) => ({
        id:           `draft_${Date.now() + i + 1}`,
        legType:      "SEA",
        movementType: "SEA",
        movementBy:   "",
        polLocType:   "Terminal",
        podLocType:   "Terminal",
        pol:          leg.pol,      polName: "",
        pod:          leg.pod,      podName: "",
        etd:          leg.etd,
        eta:          leg.eta,
        carrierCode:  sailing.carrier || "",
        vessel:       leg.vesselName   || "",
        vesselImo:    "",
        voyage:       leg.voyageNumber || "",
        contractType: firstSeaLeg.contractType || shipment.contractType || "SPOT",
        contractRef:  firstSeaLeg.contractRef  || shipment.contractRef  || "",
      }));
      const newLegs = [...base];
      newLegs[baseFirstIdx] = updatedFirst;
      newLegs.splice(baseFirstIdx + 1, 0, ...extraLegs);
      setDraftLegs(newLegs);
      toast.success(`TSP sailing staged — ${sailing.legs.length} sea legs updated`);
    } else {
      const updatedFirst = {
        ...firstSeaLeg,
        vessel:      sailing.vesselName   || firstSeaLeg.vessel,
        voyage:      sailing.voyageNumber || firstSeaLeg.voyage,
        etd:         sailing.etd          || firstSeaLeg.etd,
        eta:         sailing.eta          || firstSeaLeg.eta,
        carrierCode: sailing.carrier      || firstSeaLeg.carrierCode,
        pol:         sailing.pol          || firstSeaLeg.pol,
        pod:         sailing.pod          || firstSeaLeg.pod,
        polName:     sailing.pol !== firstSeaLeg.pol ? "" : firstSeaLeg.polName,
        podName:     sailing.pod !== firstSeaLeg.pod ? "" : firstSeaLeg.podName,
      };
      const updated = base.map((l, i) => i === baseFirstIdx ? updatedFirst : l);
      setDraftLegs(updated);
      toast.success("Sailing staged — click Save to apply");
    }
  };

  const stageSailing = (sailing) => {
    applySailingToDraft(sailing);
    setDraftSailing(sailing);
  };

  const handleSelectSailing = (sailing) => {
    setPickerOpen(false);
    setCarrierOverride(null);
    setRouteOverride(null);
    setChainedFromContract(false);
    const existingVoy = seaLegsForSearch[0]?.voyage || "";
    if (hasSchedule && existingVoy && existingVoy !== sailing.voyageNumber) {
      setConfirmSailing(sailing);
    } else {
      stageSailing(sailing);
    }
  };

  // shipment.pol/pod are the journey's overall door-to-door bookends — with a Door pickup
  // leg or a multi-leg (TSP) journey, that's not the same as the actual SEA leg(s)' own
  // pol/pod. Search on the real SEA leg(s) or the sailing picker offers routes that have
  // nothing to do with the shipment's actual ocean leg (and, since the mock/live sailing
  // search echoes the query back as the result's own pol/pod, picking one would silently
  // overwrite the real SEA leg(s) with an unrelated route). Reads from draftLegs now — the
  // page's own working set of legs, staged or not.
  const seaLegsForSearch = (draftLegs || []).filter(l => l.legType === "SEA");
  const pol = seaLegsForSearch[0]?.pol || shipment.pol || "";
  const pod = seaLegsForSearch[seaLegsForSearch.length - 1]?.pod || shipment.pod || "";
  // Overridden right after a contract is confirmed, so the chained sailing search below
  // uses the just-picked carrier immediately instead of the stale shipment.carrierCode
  // prop (onUpdate's PUT hasn't round-tripped back into this component yet).
  const [carrierOverride, setCarrierOverride] = useState(null);
  const carrier = carrierOverride ?? (seaLegsForSearch[0]?.carrierCode || shipment.carrierCode || "");
  // Set from ContractAssignModal's onDone (the specific route the just-picked contract/space
  // config actually covers) so the chained sailing search scopes to what the contract was
  // rated for, not the shipment's generic SEA-leg span — a multi-leg TSP contract or a space
  // config tied to a different transship port than the shipment's current legs would
  // otherwise surface sailings unrelated to what was just selected.
  const [routeOverride, setRouteOverride] = useState(null);
  const sailingPol = routeOverride?.pol || pol;
  const sailingPod = routeOverride?.pod || pod;
  // Whether the draft's SEA leg currently carries real sailing data — from the original
  // committed schedule, untouched, or a freshly staged pick. No longer disables Add Sailing;
  // it only decides the button's own label/tooltip and whether picking a different sailing
  // needs the "Replace sailing?" confirmation, matching how the New Shipment form's own
  // Search Sailings/Change Sailing button already behaves.
  const hasSchedule = seaLegsForSearch.some(l => l.vessel || l.voyage);
  const canSearch = !!(pol && pod && carrier);

  // Same silent revalidation as ShipmentHeaderBar's badge — shared via useContractMismatch so
  // the two can't drift on what counts as a mismatch (they used to be independently duplicated,
  // and neither passed a validity date to the match check — see the hook's own comment). Matches
  // against the real SEA leg pol/pod (above), not shipment.pol/pod, which are door-to-door
  // bookends; a contract is always matched port-to-port against the actual ocean leg. Now reads
  // draftLegs, so the banner below reacts live while editing, before Save even runs.
  const contractMismatch = useContractMismatch(shipment, pol, pod, draftLegs || []);

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

  // Linked space configuration — /api/allocations/match already computes confirmedTEU/
  // pendingTEU/rejectedTEU/remainingTEU server-side (same query SpaceConfigurationsPage uses
  // for its consumption bars), so this just picks the one entry matching shipment.allocationId
  // out of that
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

  // Wraps LegsTable's own onDraftLegsChange (add/edit/remove a leg) — a multi-leg (TSP) sailing's
  // legs are one connected journey, so removing just ONE of them (whichever leg the user had
  // selected) must cascade to remove every other leg that belongs to that same sailing too,
  // exactly like the old live-mode handleLegsChange cascade did before this page moved to a
  // staged draft. "Belongs to the sailing" is the same signal that cascade used: a SEA leg
  // currently carrying real vessel/voyage data. Field edits and adding an unrelated new leg
  // pass straight through unchanged — only an actual disappearance triggers this.
  const handleDraftLegsChange = (nextLegs) => {
    const prevLegs = draftLegs || [];
    const scheduledIds = new Set(prevLegs.filter(l => l.legType === "SEA" && (l.vessel || l.voyage)).map(l => l.id));
    const nextIds = new Set(nextLegs.map(l => l.id));
    const aScheduledLegWasRemoved = [...scheduledIds].some(id => !nextIds.has(id));
    if (aScheduledLegWasRemoved && scheduledIds.size > 0) {
      const finalLegs = nextLegs.filter(l => !scheduledIds.has(l.id));
      setDraftLegs(finalLegs);
      setDraftSailing(null);
      if (scheduledIds.size > 1) {
        toast.info("A multi-leg sailing's legs are one connected journey — removing one removes the whole sailing.");
      }
    } else {
      setDraftLegs(nextLegs);
    }
  };

  // ── Validation — runs identically for the Save button and the nav-guard's auto-save ───────
  const validateDraft = async () => {
    const errors = [];
    // Check every sea leg's OWN pol/pod/carrierCode directly here — NOT the page-level `pol`/
    // `pod` variables above, which deliberately fall back to shipment.pol/pod (needed so the
    // Add Sailing search box still has something sensible to search on before any leg data
    // exists at all). That same fallback would silently mask a genuinely blank leg during
    // validation — e.g. a second, freshly-added blank leg's empty POD hidden behind the
    // shipment's own stale, still-populated top-level pod. Found live via CDP verification.
    seaLegsForSearch.forEach((leg, i) => {
      const label = seaLegsForSearch.length > 1 ? ` (leg ${i + 1})` : "";
      if (!leg.pol) errors.push(`Port of Loading (POL) is required${label}.`);
      if (!leg.pod) errors.push(`Port of Discharge (POD) is required${label}.`);
      if (!leg.carrierCode) errors.push(`Carrier is required${label}.`);
    });
    // Only worth checking the contract against pol/pod once we know every leg actually has
    // real values — otherwise this would be matching against the same masked/fallback data.
    if (errors.length === 0 && shipment.contractType === "Central" && shipment.contractId && pol && pod) {
      const { needsPolHaulage, needsPodHaulage, pkuLocation, delLocation } = deriveHaulageNeeds(draftLegs || []);
      const dateRef = shipment.cargoReadyDate || shipment.etd || "";
      try {
        const matches = await api.contracts.match({ pol, pod, ...(dateRef && { crd: dateRef }),
          ...(needsPolHaulage && { needsPolHaulage: "1" }), ...(needsPodHaulage && { needsPodHaulage: "1" }),
          ...(pkuLocation && { pkuLocation }), ...(delLocation && { delLocation }) });
        const stillMatches = matches.some(m => m.id === shipment.contractId && (m.routingId || "") === (shipment.contractRoutingId || ""));
        if (!stillMatches) errors.push(`${shipment.contractRef || "This contract"} does not cover ${pol} → ${pod}.`);
      } catch { /* a validation-check network hiccup shouldn't itself block Save */ }
    }
    return errors;
  };

  // ── Commit — id-based diff of draftLegs against originalLegsSnapshot, same reconciliation
  // shape src/utils/applySailingToLegs.js already uses for the live sailing-pick case (match
  // by real id: update in place / remove missing / create new) rather than a full delete-then-
  // reinsert — shipment_legs ids are referenced elsewhere (AIS, Command Center). ─────────────
  const commitDraft = async () => {
    const originalById = new Map((originalLegsSnapshot || []).map(l => [l.id, l]));
    const draftIds = new Set((draftLegs || []).map(l => l.id));

    const removed = (originalLegsSnapshot || []).filter(l => !draftIds.has(l.id));
    await Promise.all(removed.map(l => api.legs.remove(shipment.id, l.id)));

    const created = (draftLegs || []).filter(l => !originalById.has(l.id));
    for (const { id: _draftId, polName: _pn, podName: _ppn, ...payload } of created) {
      await api.legs.create(shipment.id, payload);
    }

    const updated = (draftLegs || []).filter(l => {
      const orig = originalById.get(l.id);
      return orig && JSON.stringify(l) !== JSON.stringify(orig);
    });
    await Promise.all(updated.map(l => api.legs.update(shipment.id, l.id, l)));

    // Schedule reconciliation: a freshly staged pick replaces whatever schedule row(s) exist;
    // if the sea leg no longer carries vessel/voyage (removed without a new pick), any existing
    // schedule row(s) no longer correspond to a real leg and are cleaned up too; otherwise, if
    // the schedule's own leg had a field hand-edited directly (e.g. a carrier-driven ETD
    // correction, with no new sailing picked), keep the schedule row's own vessel/voyage/dates
    // in sync — the same correction api.schedules.update always performed via the old dedicated
    // "Update Schedule" modal, which is gone now that every leg is directly editable, but the
    // schedule row itself (read by Schedule History, re-keyed scheduleKey, etc.) still needs
    // this same sync or it silently drifts from what the leg now actually shows.
    const seaLegsNow = (draftLegs || []).filter(l => l.legType === "SEA");
    const hasVesselNow = seaLegsNow.some(l => l.vessel || l.voyage);
    const updatedSeaLegs = updated.filter(l => l.legType === "SEA");
    if (draftSailing) {
      await Promise.all(scheduleList.map(s => api.schedules.remove(shipment.id, s.id)));
      await api.schedules.save(shipment.id, { ...draftSailing, templateId: draftSailing.scheduleId ?? null });
    } else if (!hasVesselNow && scheduleList.length > 0) {
      await Promise.all(scheduleList.map(s => api.schedules.remove(shipment.id, s.id)));
    } else if (hasVesselNow && scheduleList.length > 0 && updatedSeaLegs.length > 0) {
      const firstSea = seaLegsNow[0];
      const lastSea = seaLegsNow[seaLegsNow.length - 1];
      await api.schedules.update(shipment.id, scheduleList[0].id, {
        vesselName: firstSea.vessel, voyageNumber: firstSea.voyage,
        etd: firstSea.etd, eta: lastSea.eta, carrier: firstSea.carrierCode,
      });
    }

    setLegsVersion(v => v + 1); // re-seeds draftLegs/originalLegsSnapshot from the fresh server state
    setHistoryVersion(v => v + 1); // re-fetches schedules via the effect above
    await onRefresh?.();
    emitLegsScheduleChanged(shipment.id);
    toast.success("Saved");
  };

  const handleSave = async () => {
    const errors = await validateDraft();
    if (errors.length) { setValidationErrors(errors); return; }
    await withSaving(async () => {
      try {
        await commitDraft();
      } catch (e) {
        // commitDraft is a sequence of independent API calls, not one server-side transaction —
        // a failure partway through (e.g. the leg diff succeeds but the schedule save doesn't)
        // must never fail silently: without this, the exception would be an unhandled rejection
        // with no toast at all, and the local draft would keep disagreeing with whatever
        // actually landed on the server. Re-syncing from the server here at least prevents that
        // second, worse failure mode — a real distributed-transaction rollback is out of scope.
        toast.error(e.message || "Save failed — reloading the current state.");
        setLegsVersion(v => v + 1);
        setHistoryVersion(v => v + 1);
      }
    }, "Saving…");
  };

  const handleDiscard = () => {
    setDraftLegs(originalLegsSnapshot);
    setDraftSailing(null);
    setValidationErrors(null);
  };

  // Blocks in-app navigation (sidebar, back arrow, breadcrumbs, tab switches — every path that
  // goes through App.jsx's navigate(), which already calls runNavigationGuard() first) while a
  // draft is dirty: a valid draft auto-saves silently and lets navigation proceed; an invalid
  // one opens the same bulleted modal and aborts the navigation attempt. Real browser back/
  // forward (App.jsx's separate onHash listener) is not covered — a pre-existing, documented
  // limitation of navigationGuard.js itself (TKT-OJYO71), not extended here.
  useEffect(() => {
    if (!isDirty) { clearNavigationGuard(); return; }
    setNavigationGuard({
      trySave: async () => {
        const errors = await validateDraft();
        if (errors.length) { setValidationErrors(errors); return { ok: false, error: "Fix the issues before leaving this page" }; }
        try {
          await commitDraft();
          return { ok: true };
        } catch (e) {
          // Same partial-failure concern as handleSave above — re-sync from the server so the
          // draft never keeps disagreeing with whatever actually landed, even on failure.
          setLegsVersion(v => v + 1);
          setHistoryVersion(v => v + 1);
          return { ok: false, error: e.message || "Failed to save before leaving this page" };
        }
      },
    });
    return () => clearNavigationGuard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDirty, draftLegs, draftSailing]);

  // Every hook above has already run this render regardless of this branch — only what gets
  // returned/rendered is gated, so this doesn't violate the Rules of Hooks.
  if (schedules === null || parties === null || draftLegs === null) {
    return (
      <div id="shpsched-page" style={{ display: "flex", alignItems: "center", gap: 10, padding: "24px 0",
        fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
        <Spinner size="sm" /> Loading schedule…
      </div>
    );
  }

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
      title={canSearch ? "Search and stage a sailing" : "POL, POD and carrier must be set"}>
      <IconAnchor size={12} />{hasSchedule ? "Change Sailing" : "Add Sailing"}
    </button>
  );

  const hasSpaceConfig = shipment.contractType === "Central" && shipment.allocationId;

  return (
    <div id="shpsched-page">
      {isDirty && (
        <div id="shpsched-dirty-bar" style={{ display: "flex", alignItems: "center", gap: 12,
          background: T.accentBg, border: `1px solid ${T.accent}44`, borderRadius: 8,
          padding: "10px 16px", marginBottom: 18 }}>
          <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, flex: 1 }}>
            You have unsaved route/schedule changes on this page.
          </span>
          <Btn id="shpsched-discard-btn" size="sm" variant="secondary" disabled={isSaving} onClick={handleDiscard}>Discard</Btn>
          <Btn id="shpsched-save-btn" size="sm" disabled={isSaving} onClick={handleSave}>💾 Save</Btn>
        </div>
      )}

      <div id="shpsched-line-agents-section" style={{ marginBottom: 22 }}>
        <div style={sectionLabel}>Line Agents</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <LineAgentField label="Export Line Agent" role="Line Agent (Export)" party={exportLineAgent}
            canEdit={canEditExportLineAgent} onAssign={(id, cid, cname) => handleAssignLineAgent("Line Agent (Export)", id, cid, cname)}
            onRemove={handleRemoveLineAgent} />
          <LineAgentField label="Import Line Agent" role="Line Agent (Import)" party={importLineAgent}
            canEdit={canEditImportLineAgent} onAssign={(id, cid, cname) => handleAssignLineAgent("Line Agent (Import)", id, cid, cname)}
            onRemove={handleRemoveLineAgent} />
        </div>
      </div>

      <div id="shpsched-legs-section">
        <div style={sectionLabel}>Route Legs</div>
        <LegsTable key={`legs-${legsVersion}`} shipmentId={null} draftLegs={draftLegs} onDraftLegsChange={handleDraftLegsChange}
          canEdit={canEdit} showContractCols={false}
          extraAction={addSailingBtn}
          loopCode={deriveLoopCode(draftSailing || scheduleList[0])}
          hideDraftBanner />
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
              <Btn id="shpsched-contract-btn" size="sm" variant="secondary" disabled={isDirty}
                title={isDirty ? "Save or discard your route changes first" : undefined}
                onClick={() => setContractModalOpen(true)}>
                {shipment.contractRef ? "Change Contract" : "+ Add Contract"}
              </Btn>
            )}
          </div>

          {/* Contract details facelift, direct request — same column structure regardless of
              contract type. Contract Number/Named Account/Commodity/Rate ID only exist on a real
              Central contract record; SPOT/Pending/Customer Own (and a Central contract still
              loading) show a dash for those, falling back to the shipment's own contractRef/
              contractValidFrom/contractValidTo for the fields that DO apply to a manual contract
              type. Rate ID is the shipment's own latest rate snapshot (2026-09-06 fix) — it used
              to join every rate line's own id on the assigned CONTRACT instead, which legitimately
              carries several (one per charge type) and read as duplication; see
              latestRateSnapshotId above for the full story. */}
          {(() => {
            const isCentral = shipment.contractType === "Central";
            const cols = [
              ["Contract Number", isCentral ? (contractDetail?.contractNumber || "") : ""],
              ["Contract Reference", shipment.contractRef || ""],
              ["Named Account", isCentral ? (contractDetail?.namedAccount || "") : ""],
              ["Commodity", isCentral ? (contractDetail?.commodityTypes || "") : ""],
              ["Rate ID", isCentral ? (latestRateSnapshotId || "") : ""],
              ["Valid From", isCentral ? (contractDetail?.validFrom || "") : (shipment.contractValidFrom || "")],
              ["Valid To", isCentral ? (contractDetail?.validTo || "") : (shipment.contractValidTo || "")],
            ];
            return (
              <div id="shpsched-contract-details" style={{ marginTop: 12,
                border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
                <div style={{ display: "flex", padding: "8px 0", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
                  {cols.map(([label], i) => (
                    <div key={label} style={{ flex: 1, minWidth: 0, paddingLeft: 14, paddingRight: 10,
                      fontFamily: T.body, fontSize: 10.5, fontWeight: 600, color: T.textMuted,
                      textTransform: "uppercase", letterSpacing: ".08em",
                      borderRight: i < cols.length - 1 ? `1px solid ${T.border}33` : "none" }}>
                      {label}
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", padding: "8px 0" }}>
                  {cols.map(([label, value], i) => (
                    <div key={label} style={{ flex: 1, minWidth: 0, paddingLeft: 14, paddingRight: 10, fontFamily: T.mono, fontSize: 12,
                      color: value ? T.text : T.textMuted, fontWeight: value ? 700 : 400, fontStyle: value ? "normal" : "italic",
                      wordBreak: "break-word" }}>
                      {value || "—"}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
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
                <ConsumptionBar allocated={linkedAlloc.allocatedTEU} confirmed={linkedAlloc.confirmedTEU}
                  pending={linkedAlloc.pendingTEU} rejected={linkedAlloc.rejectedTEU} height={6} width="100%" />
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginTop: 4 }}>
                  {linkedAlloc.confirmedTEU} / {linkedAlloc.allocatedTEU} TEU confirmed ({linkedAlloc.remainingTEU} remaining)
                  {linkedAlloc.pendingTEU > 0 && <span style={{ color: T.warning }}> · +{linkedAlloc.pendingTEU} pending</span>}
                  {linkedAlloc.rejectedTEU > 0 && <span style={{ color: T.danger }}> · +{linkedAlloc.rejectedTEU} rejected</span>}
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

      {validationErrors && (
        <Modal title="Can't save yet" onClose={() => setValidationErrors(null)} width={460} hideClose>
          <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, margin: "0 0 10px", lineHeight: 1.5 }}>
            Fix the following before saving:
          </p>
          <ul style={{ margin: "0 0 20px", paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
            {validationErrors.map((e, i) => (
              <li key={i} style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.5 }}>{e}</li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="danger" onClick={handleDiscard}>Discard changes</Btn>
            <Btn onClick={() => setValidationErrors(null)}>Fix issues</Btn>
          </div>
        </Modal>
      )}

      {confirmSailing && (
        <Modal title="Replace sailing?" onClose={() => setConfirmSailing(null)} width={420}>
          <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, margin: "0 0 6px", lineHeight: 1.6 }}>
            This will replace{" "}
            <strong style={{ fontFamily: T.mono }}>{seaLegsForSearch[0]?.vessel || "the current sailing"}</strong>
            {" "}with{" "}
            <strong style={{ fontFamily: T.mono }}>{confirmSailing.vesselName}</strong>
            {" "}· Voy {confirmSailing.voyageNumber}.
          </p>
          <p style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, margin: "0 0 20px" }}>
            This won't be saved to the shipment until you click Save below.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="secondary" onClick={() => setConfirmSailing(null)}>Cancel</Btn>
            <Btn onClick={() => { stageSailing(confirmSailing); setConfirmSailing(null); }}>Replace</Btn>
          </div>
        </Modal>
      )}

      {pickerOpen && (
        <SailingPickerModal
          pol={sailingPol} pod={sailingPod} carrierCode={carrier}
          routingTerm={shipment.routingTerm}
          expectedHub={routeOverride?.hub || null} expectedService={routeOverride?.service || null}
          activeSailing={draftSailing || scheduleList[0] || null}
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
          shipment={shipment} legs={draftLegs} pol={pol} pod={pod} onUpdate={onUpdate}
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
            // don't silently rewrite" principle as the carrier_bookings fix. Auto-unlink it.
            // Change Contract is only ever reachable while !isDirty (button disabled
            // otherwise), so draftLegs === originalLegsSnapshot here — safe to treat as the
            // real, currently-committed leg set.
            const carrierChanged = !!carrierCode && carrierCode !== shipment.carrierCode;
            if (carrierChanged && hasSchedule) {
              await withSaving(async () => {
                try {
                  const remainingLegs = (draftLegs || []).filter(l => l.legType !== "SEA");
                  await Promise.all((draftLegs || []).filter(l => l.legType === "SEA").map(l => api.legs.remove(shipment.id, l.id)));
                  await Promise.all(scheduleList.map(s => api.schedules.remove(shipment.id, s.id)));
                  setSchedules([]);
                  setDraftLegs(remainingLegs);
                  setOriginalLegsSnapshot(remainingLegs);
                  setDraftSailing(null);
                  setHistoryVersion(v => v + 1);
                  await onRefresh?.();
                  emitLegsScheduleChanged(shipment.id);
                  toast.info("Previous schedule unlinked — it was booked with a different carrier. Pick a new sailing below.");
                } catch (e) { toast.error(e.message); }
              });
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
    </div>
  );
};

export default ShipmentSchedulesPage;
