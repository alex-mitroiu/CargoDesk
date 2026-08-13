import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { IconSendPlane, IconSearch } from "../../components/primitives/Icon";
import CarrierBookingGateModal from "../../components/shared/CarrierBookingGateModal";
import ShipmentCarrierBookingDetailsPage from "./ShipmentCarrierBookingDetailsPage";
import ShipmentCarrierBookingReviewPage from "./ShipmentCarrierBookingReviewPage";

// ─── Carrier Booking ───────────────────────────────────────────────────────────
// Single page with in-page Details/Review tabs — the original requirement asked for
// tabs, not nav-bar children, which is how this first shipped (a promoted parent nav
// row with two child rows, mirroring Accounting's Cost/Invoice/GP pattern). Same
// underline-tab style as Test Tools' Message Simulator / Schedule Generator tabs.
// initialTab is derived from which of the two page keys (App.jsx still routes
// shipment-carrier-booking-details/-review separately, for deep-linking and so the
// notification bell / Test Tools "Open Review Page" still jump straight to Review) —
// switching tabs afterward is local state only, same as Test Tools' tabs (doesn't
// rewrite the hash).
//
// Gate: whether a carrier_bookings row exists is trusted as server.js's ensureBookingCreated
// single source of truth for "was this shipment ever ready to book" — contract readiness in
// particular is NOT re-derived here, to avoid the exact drift that caused a real bug
// (SHP-VSB0Z2): the backend and this page each had their own definition of "has a schedule",
// and they quietly drifted apart (this page only checked for a shipment_schedules row,
// missing shipments whose Route Legs were filled in by hand). hasContract is still ONLY used
// to word the gate modal's message.
//
// hasSchedule, however, IS re-checked on every render, in addition to the booking-exists
// check — a booking having been created once does not mean a schedule still exists: its SEA
// leg can be removed later (deliberately, or via a leg-removal bug) while the booking record
// stays around untouched. Without this, the page stayed permanently unlocked forever once a
// booking existed, even after the schedule backing it was gone.

const TABS = [
  { key: "details", label: "Details", icon: IconSendPlane },
  { key: "review",  label: "Review",  icon: IconSearch },
];

const ShipmentCarrierBookingPage = ({ shipment, onBack, onRefresh, navigate, initialTab = "details" }) => {
  const [activeTab, setActiveTab] = useState(initialTab);
  const [booking,   setBooking]   = useState(undefined); // undefined = still checking, null = doesn't exist
  const [legs,      setLegs]      = useState([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.carrierBooking.get(shipment.id).catch(() => null),
      api.legs.list(shipment.id).catch(() => []),
    ]).then(([b, l]) => { if (!cancelled) { setBooking(b); setLegs(l); } });
    return () => { cancelled = true; };
  }, [shipment.id]);

  if (booking === undefined) return null; // still checking — avoid a flash of the gate modal

  const hasContract = !!(shipment.contractId || shipment.contractRef);
  // Same broadened definition as ensureBookingCreated (server.js): a formal saved
  // sailing isn't the only way to have "a schedule" — a hand-filled SEA leg with a
  // real ETD counts too.
  const hasSchedule = legs.some(l => l.legType === "SEA" && l.etd);

  // A booking record having been created once does NOT mean a schedule still exists now —
  // e.g. its SEA leg was later removed (intentionally, or via the leg-removal cascade) while
  // the booking itself stays around untouched. Re-check schedule presence every render, not
  // just at the moment ensureBookingCreated first created the booking — otherwise this page
  // stays permanently unlocked once a booking exists even after the schedule backing it
  // disappears.
  if (booking === null || !hasSchedule) {
    return (
      <CarrierBookingGateModal
        missingContract={!hasContract}
        missingSchedule={!hasSchedule}
        onGoToSchedules={() => navigate("shipment-schedules", shipment.id)}
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

      {activeTab === "details" && <ShipmentCarrierBookingDetailsPage shipment={shipment} onBack={onBack} onRefresh={onRefresh} />}
      {activeTab === "review" && (
        <ShipmentCarrierBookingReviewPage shipment={shipment} onBack={onBack} onRefresh={onRefresh} />
      )}
    </div>
  );
};

export default ShipmentCarrierBookingPage;
