import { PartiesOfficesPanel } from "./ShipmentDetailPage";
import AdditionalPartiesPanel from "../../components/shared/AdditionalPartiesPanel";

// ─── Shipment Parties & Offices Page ──────────────────────────────────────
// Dedicated sub-page for party/office details, promoted out of the
// anchor-scroll Overview page (see ARCHITECTURE.md §8.11).

const ShipmentPartiesPage = ({ shipment, onBack, onUpdate }) => {
  return (
    <div id="shpparties-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <PartiesOfficesPanel shipment={shipment} onUpdate={onUpdate} />
      <div style={{ marginTop: 28 }}>
        <AdditionalPartiesPanel shipmentId={shipment.id} />
      </div>
    </div>
  );
};

export default ShipmentPartiesPage;
