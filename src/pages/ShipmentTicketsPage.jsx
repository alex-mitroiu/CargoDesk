import { RelatedTicketsPanel } from "./ShipmentDetailPage";

// ─── Shipment Tickets Page ────────────────────────────────────────────────
// Dedicated sub-page for related tickets, promoted out of the
// anchor-scroll Overview page (see ARCHITECTURE.md §8.11).

const ShipmentTicketsPage = ({ shipment, onBack }) => {
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      <RelatedTicketsPanel shipmentId={shipment.id} />
    </div>
  );
};

export default ShipmentTicketsPage;
