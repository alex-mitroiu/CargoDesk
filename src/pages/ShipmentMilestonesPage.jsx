import { useState } from "react";
import { T } from "../tokens";
import { MilestonePanel } from "./ShipmentDetailPage";

// ─── Shipment Milestones Page ─────────────────────────────────────────────
// Dedicated sub-page for milestone tracking, promoted out of the
// anchor-scroll Overview page (see ARCHITECTURE.md §8.11).

const ShipmentMilestonesPage = ({ shipment, onBack }) => {
  const [prog, setProg] = useState({ done: 0, total: 0 });

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {prog.total > 0 && (
        <div style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted, marginBottom: 14 }}>
          {prog.done}/{prog.total} milestones complete
        </div>
      )}

      <MilestonePanel shipmentId={shipment.id} shipment={shipment} onProgress={setProg} />
    </div>
  );
};

export default ShipmentMilestonesPage;
