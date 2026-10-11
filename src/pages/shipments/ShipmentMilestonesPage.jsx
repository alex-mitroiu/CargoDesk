import { useState, useEffect } from "react";
import { MilestonePanel, ContainerEventsSteppers } from "./ShipmentDetailPage";
import { HZ_MONO, HZ, useHorizonFonts } from "./shipmentDetailTheme";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import { IconRefresh } from "../../components/primitives/Icon";

// ─── Shipment Milestones & Events Page ────────────────────────────────────
// Dedicated sub-page for milestone tracking, promoted out of the
// anchor-scroll Overview page (see ARCHITECTURE.md §8.11). Renamed "Milestones
// & Events" and given a per-container FCL lifecycle stepper (ContainerEventsSteppers)
// alongside the existing shipment-level MilestonePanel — additive, not a replacement;
// ContainerEventsPanel (the raw per-container event log/entry form, opened from the
// Cargo page) is untouched.
//
// "Sync carrier events" (TKT-KG4E49, 2026-10-09): for a booking made through a carrier integration
// that has a carrier booking number, pulls the carrier's Track & Trace events into container events
// (routes/carrier-tracking.js). Container events stay open on a Completed/Cancelled shipment, so
// the button does too.

const ShipmentMilestonesPage = ({ shipment, containers = [], onBack }) => {
  const [prog, setProg] = useState({ done: 0, total: 0 });
  const { canEditShipments } = useAuth();
  const [booking, setBooking] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useHorizonFonts();

  useEffect(() => {
    api.carrierBooking.get(shipment.id).then(setBooking).catch(() => setBooking(null));
  }, [shipment.id]);

  const canSync = canEditShipments && !!booking?.carrierBookingRequestReference && !!booking?.bookingRef && booking.status !== "Cancelled";
  const doSync = async () => {
    setSyncing(true);
    try {
      const r = await api.carrierBooking.syncEvents(shipment.id);
      toast.success(r.added.length
        ? `${r.added.length} event${r.added.length === 1 ? "" : "s"} recorded from ${booking.carrierCode}`
        : `Nothing new from ${booking.carrierCode}`);
      setReloadKey(k => k + 1);
    } catch (e) { toast.error(e.message || "The carrier could not be asked for events"); }
    setSyncing(false);
  };

  return (
    <div id="shpmiles-page" data-testid="shipment-milestones-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      {(prog.total > 0 || canSync) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div id="shpmiles-progress" data-testid="shipment-milestones-progress" style={{ fontFamily: HZ_MONO, fontSize: 12, color: HZ.textMuted }}>
            {prog.total > 0 ? `${prog.done}/${prog.total} milestones complete` : ""}
          </div>
          {canSync && (
            <Btn variant="secondary" size="sm" onClick={doSync} disabled={syncing} data-testid="shipment-milestones-sync-carrier-events-btn"
              title={`Pull ${booking.carrierCode}'s Track & Trace events for booking ${booking.bookingRef}`}>
              <IconRefresh size={12} /> {syncing ? "Syncing…" : "Sync carrier events"}
            </Btn>
          )}
        </div>
      )}

      <MilestonePanel key={`ms-${reloadKey}`} shipmentId={shipment.id} shipment={shipment} onProgress={setProg} />
      <ContainerEventsSteppers key={`ce-${reloadKey}`} shipment={shipment} containers={containers} />
    </div>
  );
};

export default ShipmentMilestonesPage;
