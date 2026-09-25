import { useState, useEffect, useCallback } from "react";
import { api } from "../../api";
import { PartiesOfficesPanel } from "./ShipmentDetailPage";
import AdditionalPartiesPanel from "../../components/shared/AdditionalPartiesPanel";

// ─── Shipment Parties & Offices Page ──────────────────────────────────────
// Dedicated sub-page for party/office details, promoted out of the
// anchor-scroll Overview page (see ARCHITECTURE.md §8.11).

const ShipmentPartiesPage = ({ shipment, onBack, onUpdate, onShipmentPatched }) => {
  // Single shared shipmentParties.list fetch for both panels below — they used to each fetch it
  // independently (PartiesOfficesPanel just for its Line Agent mini-grid, AdditionalPartiesPanel
  // for its own full CRUD list), a real duplicate network round-trip on every visit to this tab
  // (2026-09-25 audit finding).
  const [parties, setParties] = useState(null); // null = loading
  const reloadParties = useCallback(
    () => api.shipmentParties.list(shipment.id).then(setParties).catch(() => setParties([])),
    [shipment.id]);
  useEffect(() => { reloadParties(); }, [reloadParties]);

  return (
    <div id="shpparties-page" data-testid="shipment-parties-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <PartiesOfficesPanel shipment={shipment} onUpdate={onUpdate} onShipmentPatched={onShipmentPatched} parties={parties} />
      <div data-testid="shipment-parties-additional-section" style={{ marginTop: 28 }}>
        <AdditionalPartiesPanel shipmentId={shipment.id} parties={parties} onChanged={reloadParties} />
      </div>
    </div>
  );
};

export default ShipmentPartiesPage;
