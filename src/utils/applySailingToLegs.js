import { api } from "../api";
import { toast } from "../toast";

import { journeyOrder } from "./legChain";

// Copies a picked (or generated) sailing onto a shipment's already-persisted SEA leg(s) —
// shared by ShipmentSchedulesPage.jsx's "Add Sailing" flow, ShipmentFormPage.jsx's edit-mode
// Sailing section, and Test Tools' Schedule Generator (all operate on an EXISTING shipment via
// live api.legs.* calls, unlike ShipmentFormPage.jsx's OWN local draft-legs version, used only
// before the shipment exists yet — genuinely different enough to stay local there).
// Since 2026-11-06 it builds the finished route and saves it in one call (api.legs.saveRoute), in journey order
// (legChain.js journeyOrder: Pick-up legs first, then the sea legs in sailing order, then Delivery legs): the server
// checks a route once against the user's rules and refuses a half-written one, so legs are no longer created one by
// one and re-numbered afterwards. A refusal throws with the server's sentence.
export async function applySailingToLegs(shipmentId, sailing, { contractType = "SPOT", contractRef = "", silent = false } = {}) {
  const legs = await api.legs.list(shipmentId);
  const seaLegs = legs.filter(l => l.legType === "SEA");
  const isTSP = sailing.legs && sailing.legs.length > 1;
  const say = msg => { if (!silent) toast.success(msg); };
  const seaLegOf = (leg, terms) => ({
    legType: "SEA", movementType: "SEA", movementBy: "",
    polLocType: "Terminal", podLocType: "Terminal",
    pol: leg.pol, pod: leg.pod, etd: leg.etd, eta: leg.eta,
    carrierCode: sailing.carrier || "",
    vessel: leg.vesselName || "", voyage: leg.voyageNumber || "",
    contractType: terms.contractType, contractRef: terms.contractRef,
  });

  // No SEA leg exists yet — nothing seeds one automatically when a shipment is created, so a
  // shipment that goes straight to a sailing without a leg ever added by hand used to hit this
  // case and silently do nothing (still reporting success as if it worked). Creates the leg(s)
  // from the sailing instead of no-op'ing.
  if (seaLegs.length === 0) {
    const segments = isTSP ? sailing.legs : [{
      pol: sailing.pol, pod: sailing.pod, etd: sailing.etd, eta: sailing.eta,
      vesselName: sailing.vesselName, voyageNumber: sailing.voyageNumber,
    }];
    await api.legs.saveRoute(shipmentId, journeyOrder([...legs, ...segments.map(seg => seaLegOf(seg, { contractType, contractRef }))]));
    say(isTSP
      ? `TSP sailing applied — ${segments.length} sea legs created`
      : "Sailing applied — SEA leg created");
    return true;
  }

  const [firstSeaLeg, ...extraSeaLegs] = seaLegs;
  // Any existing trailing SEA legs belong to the OLD sailing — they go, replaced by the new sailing's legs.
  const extraIds = new Set(extraSeaLegs.map(l => l.id));
  const base = legs.filter(l => !extraIds.has(l.id));

  if (isTSP) {
    const updatedFirst = {
      ...firstSeaLeg,
      vessel:      sailing.legs[0].vesselName   || firstSeaLeg.vessel,
      voyage:      sailing.legs[0].voyageNumber || firstSeaLeg.voyage,
      etd:         sailing.legs[0].etd          || firstSeaLeg.etd,
      eta:         sailing.legs[0].eta          || firstSeaLeg.eta,
      pol:         sailing.legs[0].pol          || firstSeaLeg.pol,
      polName:     sailing.legs[0].pol !== firstSeaLeg.pol ? "" : firstSeaLeg.polName,
      pod:         sailing.legs[0].pod          || firstSeaLeg.pod,
      podName:     sailing.legs[0].pod !== firstSeaLeg.pod ? "" : firstSeaLeg.podName,
      carrierCode: sailing.carrier              || firstSeaLeg.carrierCode,
    };
    const terms = { contractType: firstSeaLeg.contractType || "SPOT", contractRef: firstSeaLeg.contractRef || "" };
    const route = base.flatMap(l => l.id === firstSeaLeg.id ? [updatedFirst, ...sailing.legs.slice(1).map(seg => seaLegOf(seg, terms))] : [l]);
    await api.legs.saveRoute(shipmentId, journeyOrder(route));
    say(`TSP sailing applied — ${sailing.legs.length} sea legs updated`);
    return true;
  }
  const updatedFirst = {
    ...firstSeaLeg,
    vessel:      sailing.vesselName   || firstSeaLeg.vessel,
    voyage:      sailing.voyageNumber || firstSeaLeg.voyage,
    etd:         sailing.etd          || firstSeaLeg.etd,
    eta:         sailing.eta          || firstSeaLeg.eta,
    carrierCode: sailing.carrier      || firstSeaLeg.carrierCode,
    // A direct sailing's own pol/pod is always the true door-to-door endpoints
    // (mockSailings echoes the search query here, same as the catalog) — reset both
    // in case the leg currently holds a TSP hub from a previously-applied sailing.
    pol:         sailing.pol          || firstSeaLeg.pol,
    pod:         sailing.pod          || firstSeaLeg.pod,
    polName:     sailing.pol !== firstSeaLeg.pol ? "" : firstSeaLeg.polName,
    podName:     sailing.pod !== firstSeaLeg.pod ? "" : firstSeaLeg.podName,
  };
  // A direct sailing selected for what used to be a multi-leg (TSP) journey collapses back to one SEA leg.
  await api.legs.saveRoute(shipmentId, journeyOrder(base.map(l => l.id === firstSeaLeg.id ? updatedFirst : l)));
  say("Sailing applied to SEA leg");
  return true;
}
