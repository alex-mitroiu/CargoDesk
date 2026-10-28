import { useState } from "react";
import { MilestonePanel, ContainerEventsSteppers } from "./ShipmentDetailPage";
import { HZ_MONO, HZ, useHorizonFonts } from "./shipmentDetailTheme";
import { useAuth } from "../../AuthContext";
import CarrierEventsPanel, { SeaLegTimes } from "../../components/shared/CarrierEventsPanel";

// ─── Shipment Milestones & Events Page ────────────────────────────────────
// Dedicated sub-page for milestone tracking, promoted out of the
// anchor-scroll Overview page (see ARCHITECTURE.md §8.11). Renamed "Milestones
// & Events" and given a per-container FCL lifecycle stepper (ContainerEventsSteppers)
// alongside the existing shipment-level MilestonePanel — additive, not a replacement;
// ContainerEventsPanel (the raw per-container event log/entry form, opened from the
// Cargo page) is untouched.
//
// The carrier's word (DCSA phase 6, 2026-10-28; mockup VUTPKnRAjdPjfb8DntUxVs): the sea legs' times
// marked by where they came from (carrier actual, carrier estimate, AIS), each milestone with the DCSA
// events that complete it, and "From the carrier" — every Track & Trace event with what CargoDesk did
// with it, "Sync carrier events" (T&T 3.0) and "Check vessel times" (OVS 3.0). Container events stay
// open on a Completed/Cancelled shipment, so the buttons do too.

const ShipmentMilestonesPage = ({ shipment, containers = [], onBack }) => {
  const [prog, setProg] = useState({ done: 0, total: 0 });
  const { canEditShipments } = useAuth();
  const [reloadKey, setReloadKey] = useState(0);
  useHorizonFonts();

  return (
    <div id="shpmiles-page" data-testid="shipment-milestones-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      {prog.total > 0 && (
        <div id="shpmiles-progress" data-testid="shipment-milestones-progress" style={{ fontFamily: HZ_MONO, fontSize: 12, color: HZ.textMuted, marginBottom: 14 }}>
          {`${prog.done}/${prog.total} milestones complete`}
        </div>
      )}

      <SeaLegTimes shipmentId={shipment.id} reloadKey={reloadKey} />
      <MilestonePanel key={`ms-${reloadKey}`} shipmentId={shipment.id} shipment={shipment} onProgress={setProg} />
      <CarrierEventsPanel shipment={shipment} canEdit={canEditShipments} reloadKey={reloadKey} onChanged={() => setReloadKey(k => k + 1)} />
      <ContainerEventsSteppers key={`ce-${reloadKey}`} shipment={shipment} containers={containers} />
    </div>
  );
};

export default ShipmentMilestonesPage;
