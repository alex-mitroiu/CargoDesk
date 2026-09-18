import { useState, useEffect } from "react";
import { api } from "../../api";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { Inp, ContractTypeInput } from "../primitives/Form";
import DatePicker from "../primitives/DatePicker";
import CarrierCombobox from "./CarrierCombobox";
import { ContractPickerModal, deriveHaulageNeeds } from "../../pages/shipments/ShipmentFormPage";
import { HZ, HZ_BODY, useHorizonFonts } from "../../pages/shipments/shipmentDetailTheme";

// ─── Contract Assign Modal ──────────────────────────────────────────────────
// "+ Add Contract" / "Change Contract" flow for the Schedules page — mirrors
// the shipment-entry form's contract picking (ContractField + ContractPickerModal)
// but as a guided step-through instead of an always-visible inline control, so
// the whole thing commits in ONE onUpdate call (one toast) instead of firing on
// every micro-interaction (type toggle, then contract pick, each its own PUT).
//
// pol/pod must already be resolved from the shipment's real SEA leg(s), not the
// door-to-door bookends — see ShipmentSchedulesPage's own pol/pod computation.
//
// Step "type" — pick Central / SPOT / Pending / Customer Own (defaults to the
// shipment's current type, so the common "already Central, just need a new
// contract" case skips straight to search).
// Step "contract" (Central only) — reuses ContractPickerModal as-is, same
// space-config/contract search the shipment form already uses.
// Non-Central types resolve inline on the type step via a free-text ref field.

const ContractAssignModal = ({ shipment, legs, pol, pod, shipmentTEU = 0, onUpdate, onDone, onClose }) => {
  const [type, setType] = useState(shipment.contractType === "Central" ? "Central" : (shipment.contractType || "Central"));
  const [step, setStep] = useState(shipment.contractType === "Central" ? "contract" : "type");
  const [refVal, setRefVal] = useState(shipment.contractRef || "");
  const [carrierVal, setCarrierVal] = useState(shipment.contractType === "Central" ? "" : (shipment.carrierCode || ""));
  const [validFrom, setValidFrom] = useState(shipment.contractValidFrom || "");
  const [validTo, setValidTo] = useState(shipment.contractValidTo || "");
  const [matches, setMatches] = useState(null);
  const [allocs, setAllocs] = useState(null);

  // Derived straight from the shipment's own Pick-up/Delivery legs — NOT shipment.routingTerm
  // (the door-to-door bookend term), so this agrees with every other haulage-aware match in
  // the app (ShipmentFormPage's ContractField, the header mismatch badge).
  const { needsPolHaulage, needsPodHaulage, pkuLocation, delLocation } = deriveHaulageNeeds(legs);

  useEffect(() => {
    if (step !== "contract") return;
    let live = true;
    setMatches(null); setAllocs(null);
    const dateRef = shipment.cargoReadyDate || shipment.etd || "";
    const haulageParams = { ...(needsPolHaulage && { needsPolHaulage: "1" }),
      ...(needsPodHaulage && { needsPodHaulage: "1" }),
      ...(pkuLocation && { pkuLocation }), ...(delLocation && { delLocation }) };
    const matchParams = { pol, pod, ...(dateRef && { crd: dateRef }), ...haulageParams };
    // Deliberately NOT filtered by shipment.carrierCode — picking a contract from a
    // different carrier is exactly what pickContract/pickAllocation below already support
    // (they update carrierCode from the chosen contract), so narrowing candidates to the
    // shipment's current carrier before that choice is made would hide the very contracts
    // this search exists to surface.
    Promise.all([
      api.contracts.match(matchParams),
      api.allocations.match({ pol, pod, etd: shipment.etd || "", ...haulageParams }),
    ]).then(([c, a]) => {
      if (!live) return;
      setMatches(c);
      setAllocs(a);
    }).catch(() => { if (live) { setMatches([]); setAllocs([]); } });
    return () => { live = false; };
  }, [step, pol, pod, needsPolHaulage, needsPodHaulage, pkuLocation, delLocation]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = (fields, matchedRoute = null) => {
    onUpdate(shipment.id, { ...shipment, contractType: type, ...fields });
    onDone({ isCentral: type === "Central", contractPicked: !!fields.contractId,
      carrierCode: fields.carrierCode || shipment.carrierCode || "", matchedRoute });
  };

  const pickContract = (c, skipReason = "") => {
    // matchedLegs is the specific run of legs that satisfied THIS search — not the contract's
    // full leg list, which can include other routings entirely — so the chained sailing
    // search (if one follows) scopes to the route this contract actually covers, not the
    // shipment's generic SEA-leg span.
    const chain = c.matchedLegs || [];
    // hub/service are informational only (see SailingPickerModal's soft-match hint) — a TSP
    // contract's specific transshipment port and vessel service, dropped by pol/pod alone.
    const matchedRoute = chain.length > 0 ? { pol: chain[0].pol, pod: chain[chain.length - 1].pod,
      hub: chain.length > 1 ? chain[0].pod : null, service: chain[0].vesselService || null } : null;
    // c.routingId is '' for a contract with no named routings (unchanged shipments) or the
    // specific routing (e.g. "Via Rotterdam" vs "Via Hamburg") the operator picked among —
    // GET /api/contracts/match now returns one match entry per (contract, routing) pair, so
    // ContractPickerModal's own card the operator clicked already IS that specific choice.
    finish({ contractId: c.id, contractRef: c.contractNumber, carrierCode: c.carrierCode || shipment.carrierCode,
      contractRoutingId: c.routingId || "",
      allocationId: "", spaceSkipReason: skipReason, spaceOverageReason: "" }, matchedRoute);
  };
  const pickAllocation = (alloc, overageReason = "") => {
    finish({ contractId: alloc.contractId, contractRef: alloc.contractNumber, carrierCode: alloc.carrierCode || shipment.carrierCode,
      allocationId: alloc.id, spaceSkipReason: "", spaceOverageReason: overageReason },
      { pol: alloc.pol, pod: alloc.pod });
  };
  const saveRef = () => {
    finish({ contractId: "", allocationId: "", contractRef: refVal, carrierCode: carrierVal,
      contractValidFrom: validFrom, contractValidTo: validTo });
  };

  useHorizonFonts();

  if (step === "contract") {
    if (!pol || !pod) {
      return (
        <Modal title="+ Add Contract" onClose={onClose} width={420} data-testid="shipment-schedules-contract-assign-modal">
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <ContractTypeInput value={type} onChange={setType} />
            <div style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>
              Set the shipment's POL and POD (via Route Legs) before searching for a contract.
            </div>
          </div>
        </Modal>
      );
    }
    return (
      <ContractPickerModal pol={pol} pod={pod} matches={matches} allocs={allocs} shipmentTEU={shipmentTEU}
        searchCriteria={{ pol, pod, crd: (shipment.cargoReadyDate || shipment.etd || "") || null,
          // Deliberately no carrierCode here — this search is intentionally NOT carrier-filtered
          // (see the comment above the match useEffect), so showing one would misrepresent what
          // was actually searched for.
          needsPolHaulage, needsPodHaulage, pkuLocation, delLocation }}
        // The shipment's own already-assigned Central contract/space-config, if any — lets the
        // picker mark that exact card as already selected and block re-picking it, instead of
        // silently re-running finish()/onDone() (which chains into a fresh sailing search on the
        // Schedules page) for a selection that hasn't actually changed.
        currentSelection={shipment.contractType === "Central" && shipment.contractId
          ? { contractId: shipment.contractId, routingId: shipment.contractRoutingId || "", allocationId: shipment.allocationId || "" }
          : null}
        onSelectContract={pickContract} onSelectAllocation={pickAllocation} onClose={onClose}
        onBack={() => setStep("type")} />
    );
  }

  return (
    <Modal title="+ Add Contract" onClose={onClose} width={420} data-testid="shipment-schedules-contract-assign-modal">
      <div data-testid="shipment-schedules-contract-assign-type-field" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <ContractTypeInput value={type} onChange={setType} />
        {type === "Central" ? (
          <Btn onClick={() => setStep("contract")} data-testid="shipment-schedules-contract-assign-search-btn">Search contracts for {pol} → {pod} →</Btn>
        ) : (
          <>
            <div data-testid="shipment-schedules-contract-assign-ref-field">
              <Inp label="Contract Reference" value={refVal} onChange={setRefVal} required
                placeholder="e.g. SPOT-2025-001" mono hint="Free-text reference for this contract arrangement" />
            </div>
            <div data-testid="shipment-schedules-contract-assign-carrier-field">
              <div style={{ fontFamily: HZ_BODY, fontSize: 12, fontWeight: 600, color: HZ.textMuted, marginBottom: 6 }}>Carrier</div>
              <CarrierCombobox value={carrierVal} onChange={setCarrierVal} />
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <div data-testid="shipment-schedules-contract-assign-valid-from-field" style={{ flex: 1 }}>
                <DatePicker label="Valid From" value={validFrom} onChange={setValidFrom} maxDate={validTo || undefined} />
              </div>
              <div data-testid="shipment-schedules-contract-assign-valid-to-field" style={{ flex: 1 }}>
                <DatePicker label="Valid To" value={validTo} onChange={setValidTo} minDate={validFrom || undefined} />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <Btn variant="secondary" onClick={onClose} data-testid="shipment-schedules-contract-assign-cancel-btn">Cancel</Btn>
              <Btn disabled={!refVal.trim()} onClick={saveRef} data-testid="shipment-schedules-contract-assign-save-btn">Save</Btn>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default ContractAssignModal;
