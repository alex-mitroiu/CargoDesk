import { api } from "../api";
import { toast } from "../toast";

// Copies a picked (or generated) sailing onto a shipment's already-persisted SEA leg(s) —
// shared by ShipmentSchedulesPage.jsx's "Add Sailing" flow and Test Tools' Schedule
// Generator (both operate on an EXISTING shipment via live api.legs.* calls, unlike
// ShipmentFormPage.jsx's own version, which stages draft legs before the shipment exists —
// genuinely different enough to stay local there rather than merge into this one).
//
// No SEA leg exists yet — nothing seeds one automatically when a shipment is created, so a
// shipment that goes straight to a sailing without a leg ever added by hand used to hit this
// case and silently do nothing (still reporting success as if it worked). Creates the leg(s)
// from the sailing instead of no-op'ing.
export async function applySailingToLegs(shipmentId, sailing, { contractType = "SPOT", contractRef = "", silent = false } = {}) {
  const legs = await api.legs.list(shipmentId);
  const seaLegs = legs.filter(l => l.legType === "SEA");
  const isTSP = sailing.legs && sailing.legs.length > 1;
  const say = msg => { if (!silent) toast.success(msg); };

  if (seaLegs.length === 0) {
    const segments = isTSP ? sailing.legs : [{
      pol: sailing.pol, pod: sailing.pod, etd: sailing.etd, eta: sailing.eta,
      vesselName: sailing.vesselName, voyageNumber: sailing.voyageNumber,
    }];
    for (const leg of segments) {
      await api.legs.create(shipmentId, {
        legType: "SEA", movementType: "SEA", movementBy: "",
        polLocType: "Terminal", podLocType: "Terminal",
        pol: leg.pol, pod: leg.pod, etd: leg.etd, eta: leg.eta,
        carrierCode: sailing.carrier || "",
        vessel: leg.vesselName || "", voyage: leg.voyageNumber || "",
        contractType, contractRef,
      });
    }
    say(isTSP
      ? `TSP sailing applied — ${segments.length} sea legs created`
      : "Sailing applied — SEA leg created");
    return true;
  }

  const [firstSeaLeg, ...extraSeaLegs] = seaLegs;

  if (isTSP) {
    await api.legs.update(shipmentId, firstSeaLeg.id, {
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
    for (const stale of extraSeaLegs) await api.legs.remove(shipmentId, stale.id);
    for (const leg of sailing.legs.slice(1)) {
      await api.legs.create(shipmentId, {
        legType: "SEA", movementType: "SEA", movementBy: "",
        polLocType: "Terminal", podLocType: "Terminal",
        pol: leg.pol, pod: leg.pod, etd: leg.etd, eta: leg.eta,
        carrierCode: sailing.carrier || "",
        vessel: leg.vesselName || "", voyage: leg.voyageNumber || "",
        contractType: firstSeaLeg.contractType || "SPOT", contractRef: firstSeaLeg.contractRef || "",
      });
    }
    say(`TSP sailing applied — ${sailing.legs.length} sea legs updated`);
    return true;
  } else {
    await api.legs.update(shipmentId, firstSeaLeg.id, {
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
    });
    // A direct sailing was selected for what used to be a multi-leg (TSP) journey —
    // collapse back down to a single SEA leg rather than leaving stale extra legs.
    for (const extra of extraSeaLegs) await api.legs.remove(shipmentId, extra.id);
    say("Sailing applied to SEA leg");
    return true;
  }
}
