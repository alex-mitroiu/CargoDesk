import { api } from "../api";
import { toast } from "../toast";

// Re-normalizes every leg's order so Pick-up legs stay first, the full SEA chain (in sailing
// order, identified by seaChainIds) sits together in the middle, and everything else keeps its
// own relative order at the end. Needed because a brand-new leg's own legOrder is just
// server-side MAX(leg_order)+1 — with a Delivery/trucking leg already sitting at a lower order
// than that MAX, a newly-created SEA leg would otherwise land AFTER it (found live on
// SHP-WKX04E: a Delivery leg ended up sandwiched between the two SEA legs). Sequential, not
// Promise.all — each PUT triggers the server's own syncShipmentFromLegs re-read of
// shipment_legs ORDER BY leg_order, so racing these could transiently derive the shipment
// header from a half-reordered leg set.
async function reorderLegs(shipmentId, legs, seaChainIds) {
  const seaRank = new Map(seaChainIds.map((id, i) => [id, i]));
  const groupRank = l => l.legType === "Pick-up" ? 0 : seaRank.has(l.id) ? 1 : 2;
  const ordered = [...legs].sort((a, b) =>
    groupRank(a) - groupRank(b) || (seaRank.get(a.id) ?? a.legOrder) - (seaRank.get(b.id) ?? b.legOrder));
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].legOrder !== i) await api.legs.update(shipmentId, ordered[i].id, { ...ordered[i], legOrder: i });
  }
}

// Copies a picked (or generated) sailing onto a shipment's already-persisted SEA leg(s) —
// shared by ShipmentSchedulesPage.jsx's "Add Sailing" flow, ShipmentFormPage.jsx's edit-mode
// Sailing section, and Test Tools' Schedule Generator (all operate on an EXISTING shipment via
// live api.legs.* calls, unlike ShipmentFormPage.jsx's OWN local draft-legs version, used only
// before the shipment exists yet — genuinely different enough to stay local there).
export async function applySailingToLegs(shipmentId, sailing, { contractType = "SPOT", contractRef = "", silent = false } = {}) {
  const legs = await api.legs.list(shipmentId);
  const seaLegs = legs.filter(l => l.legType === "SEA");
  const isTSP = sailing.legs && sailing.legs.length > 1;
  const say = msg => { if (!silent) toast.success(msg); };

  // No SEA leg exists yet — nothing seeds one automatically when a shipment is created, so a
  // shipment that goes straight to a sailing without a leg ever added by hand used to hit this
  // case and silently do nothing (still reporting success as if it worked). Creates the leg(s)
  // from the sailing instead of no-op'ing.
  if (seaLegs.length === 0) {
    const segments = isTSP ? sailing.legs : [{
      pol: sailing.pol, pod: sailing.pod, etd: sailing.etd, eta: sailing.eta,
      vesselName: sailing.vesselName, voyageNumber: sailing.voyageNumber,
    }];
    const createdLegs = [];
    for (const leg of segments) {
      createdLegs.push(await api.legs.create(shipmentId, {
        legType: "SEA", movementType: "SEA", movementBy: "",
        polLocType: "Terminal", podLocType: "Terminal",
        pol: leg.pol, pod: leg.pod, etd: leg.etd, eta: leg.eta,
        carrierCode: sailing.carrier || "",
        vessel: leg.vesselName || "", voyage: leg.voyageNumber || "",
        contractType, contractRef,
      }));
    }
    // Same ordering gap as the TSP-update branch below can hit here too — a shipment with an
    // existing Pick-up/Delivery leg but no SEA leg yet gets its new leg(s) appended past them.
    await reorderLegs(shipmentId, [...legs, ...createdLegs], createdLegs.map(l => l.id));
    say(isTSP
      ? `TSP sailing applied — ${segments.length} sea legs created`
      : "Sailing applied — SEA leg created");
    return true;
  }

  const [firstSeaLeg, ...extraSeaLegs] = seaLegs;

  if (isTSP) {
    const updatedFirst = await api.legs.update(shipmentId, firstSeaLeg.id, {
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
    const createdLegs = [];
    for (const leg of sailing.legs.slice(1)) {
      createdLegs.push(await api.legs.create(shipmentId, {
        legType: "SEA", movementType: "SEA", movementBy: "",
        polLocType: "Terminal", podLocType: "Terminal",
        pol: leg.pol, pod: leg.pod, etd: leg.etd, eta: leg.eta,
        carrierCode: sailing.carrier || "",
        vessel: leg.vesselName || "", voyage: leg.voyageNumber || "",
        contractType: firstSeaLeg.contractType || "SPOT", contractRef: firstSeaLeg.contractRef || "",
      }));
    }
    // Every leg the reorder pass needs is already in hand from the calls above — the update's
    // own response, the create responses, and the original fetch minus the legs just removed —
    // so no extra api.legs.list round trip is needed just to rebuild the same list.
    const extraIds = new Set(extraSeaLegs.map(l => l.id));
    const untouched = legs.filter(l => l.id !== firstSeaLeg.id && !extraIds.has(l.id));
    const allLegs = [updatedFirst, ...untouched, ...createdLegs];
    await reorderLegs(shipmentId, allLegs, [firstSeaLeg.id, ...createdLegs.map(l => l.id)]);
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
    // collapse back down to a single SEA leg rather than leaving stale extra legs. No
    // reordering needed here — nothing new is created, so relative leg order is untouched.
    for (const extra of extraSeaLegs) await api.legs.remove(shipmentId, extra.id);
    say("Sailing applied to SEA leg");
    return true;
  }
}
