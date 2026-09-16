import { useState } from "react";
import { MilestonePanel, ContainerEventsSteppers } from "./ShipmentDetailPage";
import { HZ_MONO, HZ, useHorizonFonts } from "./shipmentDetailTheme";

// ─── Shipment Milestones & Events Page ────────────────────────────────────
// Dedicated sub-page for milestone tracking, promoted out of the
// anchor-scroll Overview page (see ARCHITECTURE.md §8.11). Renamed "Milestones
// & Events" and given a per-container FCL lifecycle stepper (ContainerEventsSteppers)
// alongside the existing shipment-level MilestonePanel — additive, not a replacement;
// ContainerEventsPanel (the raw per-container event log/entry form, opened from the
// Cargo page) is untouched.

const ShipmentMilestonesPage = ({ shipment, containers = [], onBack }) => {
  const [prog, setProg] = useState({ done: 0, total: 0 });
  useHorizonFonts();

  return (
    <div id="shpmiles-page" data-testid="shipment-milestones-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      {prog.total > 0 && (
        <div id="shpmiles-progress" data-testid="shipment-milestones-progress" style={{ fontFamily: HZ_MONO, fontSize: 12, color: HZ.textMuted, marginBottom: 14 }}>
          {prog.done}/{prog.total} milestones complete
        </div>
      )}

      <MilestonePanel shipmentId={shipment.id} shipment={shipment} onProgress={setProg} />
      <ContainerEventsSteppers shipment={shipment} containers={containers} />
    </div>
  );
};

export default ShipmentMilestonesPage;
