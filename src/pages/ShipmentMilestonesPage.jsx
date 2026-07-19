import { useState } from "react";
import { T } from "../tokens";
import { MilestonePanel, ContainerEventsSteppers } from "./ShipmentDetailPage";

// ─── Shipment Milestones & Events Page ────────────────────────────────────
// Dedicated sub-page for milestone tracking, promoted out of the
// anchor-scroll Overview page (see ARCHITECTURE.md §8.11). Renamed "Milestones
// & Events" and given a per-container FCL lifecycle stepper (ContainerEventsSteppers)
// alongside the existing shipment-level MilestonePanel — additive, not a replacement;
// ContainerEventsPanel (the raw per-container event log/entry form, opened from the
// Cargo page) is untouched.

const ShipmentMilestonesPage = ({ shipment, containers = [], onBack }) => {
  const [prog, setProg] = useState({ done: 0, total: 0 });

  return (
    <div id="shpmiles-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      {prog.total > 0 && (
        <div id="shpmiles-progress" style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted, marginBottom: 14 }}>
          {prog.done}/{prog.total} milestones complete
        </div>
      )}

      <MilestonePanel shipmentId={shipment.id} shipment={shipment} onProgress={setProg} />
      <ContainerEventsSteppers shipment={shipment} containers={containers} />
    </div>
  );
};

export default ShipmentMilestonesPage;
