import { PartiesOfficesPanel } from "./ShipmentDetailPage";

// ─── Shipment Parties & Offices Page ──────────────────────────────────────
// Dedicated sub-page for party/office details, promoted out of the
// anchor-scroll Overview page (see ARCHITECTURE.md §8.11).

const ShipmentPartiesPage = ({ shipment, onBack, onUpdate }) => {
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <PartiesOfficesPanel shipment={shipment} onUpdate={onUpdate} />
    </div>
  );
};

export default ShipmentPartiesPage;
