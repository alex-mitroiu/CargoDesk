import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { IconSendPlane, IconSearch } from "../../components/primitives/Icon";
import CustomsFilingGateModal from "../../components/shared/CustomsFilingGateModal";
import ShipmentCustomsFilingDetailsPage from "./ShipmentCustomsFilingDetailsPage";
import ShipmentCustomsFilingReviewPage from "./ShipmentCustomsFilingReviewPage";

// ─── Customs & Regulatory Filing (Epic TKT-XW6TQK) ─────────────────────────────
// Single page with in-page Details/Review tabs, same underline-tab shape as
// ShipmentCarrierBookingPage.jsx. Gate: unlocks once EITHER Customs Broker role
// (Export or Import) is assigned — a shipment may only ever need one filing type,
// so requiring both up front would permanently block a shipment that will only
// ever file one — AND at least one priced cargo line exists anywhere on the
// shipment. Re-evaluated on every render (not just once), same reasoning as the
// carrier-booking gate's schedule re-check: preconditions can regress later.

const TABS = [
  { key: "details", label: "Details", icon: IconSendPlane },
  { key: "review",  label: "Review",  icon: IconSearch },
];

const ShipmentCustomsFilingPage = ({ shipment, onBack, navigate, initialTab = "details" }) => {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [parties,   setParties]   = useState(undefined); // undefined = still checking
  const [packages,  setPackages]  = useState([]);         // flattened container_packages, shared with children

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.shipmentParties.list(shipment.id).catch(() => []),
      api.containers.list({ shipmentId: shipment.id }).catch(() => []),
    ]).then(async ([partyRows, containerRows]) => {
      if (cancelled) return;
      const lists = await Promise.all(containerRows.map(c => api.containerPackages.list(shipment.id, c.id).catch(() => [])));
      if (cancelled) return;
      setParties(partyRows);
      setPackages(lists.flat());
    });
    return () => { cancelled = true; };
  }, [shipment.id]);

  if (parties === undefined) return null; // still checking — avoid a flash of the gate modal

  const hasExportBroker = parties.some(p => p.role === "Customs Broker (Export)");
  const hasImportBroker = parties.some(p => p.role === "Customs Broker (Import)");
  const hasBroker = hasExportBroker || hasImportBroker;
  const hasCargo = packages.some(p => p.unitValueUsd != null);
  // USPPI (Shipper) / Ultimate Consignee (TKT-6A7J45 story 7) — both legally required EEI
  // fields; server-enforced too (routes/customs-filing.js's own create-gate), this is just
  // the same precondition surfaced before the user gets as far as clicking Create.
  const hasParties = !!(shipment.shipperName && shipment.consigneeName);

  if (!hasBroker || !hasCargo || !hasParties) {
    return (
      <CustomsFilingGateModal
        missingBroker={!hasBroker}
        missingCargo={!hasCargo}
        missingParties={!hasParties}
        onGoToParties={() => navigate("shipment-parties", shipment.id)}
        onGoToCargo={() => navigate("shipment-containers", shipment.id)}
      />
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 24, borderBottom: `1px solid ${T.border}`,
        maxWidth: 1100, margin: "0 auto 20px" }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            style={{ background: "none", border: "none", cursor: "pointer",
              padding: "0 0 10px", display: "flex", alignItems: "center", gap: 6,
              fontFamily: T.body, fontSize: 14, fontWeight: activeTab === t.key ? 700 : 400,
              color: activeTab === t.key ? T.accent : T.textMuted,
              borderBottom: `2px solid ${activeTab === t.key ? T.accent : "transparent"}` }}>
            <t.icon size={14} />{t.label}
          </button>
        ))}
      </div>

      {activeTab === "details" && (
        <ShipmentCustomsFilingDetailsPage shipment={shipment} parties={parties} packages={packages}
          hasExportBroker={hasExportBroker} hasImportBroker={hasImportBroker} navigate={navigate} />
      )}
      {activeTab === "review" && <ShipmentCustomsFilingReviewPage shipment={shipment} parties={parties} />}
    </div>
  );
};

export default ShipmentCustomsFilingPage;
