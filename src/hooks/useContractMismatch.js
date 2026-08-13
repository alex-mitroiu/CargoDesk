import { useState, useEffect } from "react";
import { api } from "../api";
import { deriveHaulageNeeds } from "../pages/shipments/ShipmentFormPage";

// A Central contract is matched against POL/POD (route, haulage coverage, and validity window)
// at the time it's picked, but nothing re-checks it if the route changes or the contract's own
// valid_to simply passes afterward — this hook is that ongoing revalidation. Was previously
// duplicated independently in ShipmentHeaderBar.jsx and ShipmentSchedulesPage.jsx (both render
// their own mismatch badge/banner), which is exactly how they drifted: neither ever passed a
// crd/etd date to GET /api/contracts/match, so an expired-but-still-"Active" contract silently
// kept "matching" forever on both surfaces. One shared implementation now — matchPol/matchPod
// should be the shipment's real SEA-leg pol/pod (not the door-to-door shipment.pol/pod), same as
// ContractAssignModal uses to pick the contract in the first place.
export default function useContractMismatch(shipment, matchPol, matchPod, legs) {
  const [contractMismatch, setContractMismatch] = useState(false);
  const { needsPolHaulage, needsPodHaulage, pkuLocation, delLocation } = deriveHaulageNeeds(legs);
  const dateRef = shipment.cargoReadyDate || shipment.etd || "";

  useEffect(() => {
    let live = true;
    if (shipment.contractType !== "Central" || !shipment.contractId || !matchPol || !matchPod) {
      setContractMismatch(false);
      return;
    }
    api.contracts.match({ pol: matchPol, pod: matchPod, ...(dateRef && { crd: dateRef }),
      ...(needsPolHaulage && { needsPolHaulage: "1" }), ...(needsPodHaulage && { needsPodHaulage: "1" }),
      ...(pkuLocation && { pkuLocation }), ...(delLocation && { delLocation }) })
      .then(matches => {
        // GET /api/contracts/match now returns one entry per (contract, routing) pair — a
        // shipment must match on BOTH its stored contract id AND its stored routing id (''
        // for a shipment that predates named routings, or one with no routing recorded yet).
        // Checking contract id alone would miss a real mismatch: if the shipment's specific
        // routing (e.g. "Via Hamburg") stops matching while a DIFFERENT routing on the same
        // contract still does, that's still a mismatch worth flagging, not a false negative.
        if (live) setContractMismatch(!matches.some(m => m.id === shipment.contractId && (m.routingId || "") === (shipment.contractRoutingId || "")));
      })
      .catch(() => { if (live) setContractMismatch(false); });
    return () => { live = false; };
  }, [shipment.contractType, shipment.contractId, shipment.contractRoutingId, matchPol, matchPod, dateRef, needsPolHaulage, needsPodHaulage, pkuLocation, delLocation]);

  return contractMismatch;
}
