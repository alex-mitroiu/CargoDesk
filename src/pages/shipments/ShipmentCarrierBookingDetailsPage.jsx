import { useState, useEffect, useCallback, useMemo } from "react";
import { T } from "../../tokens";
import { useAuth } from "../../AuthContext";
import { api } from "../../api";
import { toast } from "../../toast";
import EdiMessageList from "../../components/shared/EdiMessageList";
import CarrierBookingsTable from "../../components/shared/CarrierBookingsTable";
import Spinner from "../../components/primitives/Spinner";
import { CommodityDisplay } from "./ShipmentDetailPage";
import { IconSendPlane, IconAnchor, IconWarning } from "../../components/primitives/Icon";
import { BOOKABLE_CARRIERS } from "../../utils/carrierBooking";

// ─── Carrier Booking — Details ────────────────────────────────────────────────
// The outbound half of a booking: what we're asking the carrier for, and the Send
// action itself. Sibling to Review (the carrier's response + Confirm/Cancel), split
// out of the old EdiMessagesDrawer per the same "one concept, one dedicated page"
// precedent Accounting already established for Invoice/Cost/GP.

const ShipmentCarrierBookingDetailsPage = ({ shipment, onBack }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [booking,    setBooking]    = useState(null);
  const [messages,   setMessages]   = useState([]);
  const [containers, setContainers] = useState([]);
  const [contract,   setContract]   = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [sending,    setSending]    = useState(false);

  // Only a Central contract has a real record to load (contractId set) — SPOT/Pending/
  // Customer Own carry just a free-text contractRef with nothing to fetch, so `contract`
  // stays null and the Client field below falls back to "No Customer" per its own rule.
  useEffect(() => {
    if (!shipment.contractId) { setContract(null); return; }
    let cancelled = false;
    api.contracts.get(shipment.contractId).then(c => !cancelled && setContract(c)).catch(() => !cancelled && setContract(null));
    return () => { cancelled = true; };
  }, [shipment.contractId]);

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([
      api.carrierBooking.get(shipment.id).catch(() => null),
      api.ediMessages.list(shipment.id).catch(() => []),
      api.containers.list({ shipmentId: shipment.id }).catch(() => []),
    ]).then(([b, m, c]) => { setBooking(b); setMessages(m); setContainers(c); }).finally(() => setLoading(false));
  }, [shipment.id]);

  // Same size+type grouping the backend applies to the outbound booking-request payload
  // (routes/edi.js, TKT-0H9TSP) — shown here so what's on screen matches what gets sent.
  const equipment = useMemo(() => {
    const byType = {};
    for (const c of containers) {
      const key = `${c.size}${c.type}`;
      const entry = byType[key] || (byType[key] = { type: key, count: 0, totalWeightKg: 0, totalVolumeCbm: 0 });
      entry.count += 1;
      entry.totalWeightKg += c.grossWeightKg || 0;
      entry.totalVolumeCbm += c.volumeCbm || 0;
    }
    return Object.values(byType);
  }, [containers]);

  // Container-level isDg only — consistent with every other DG signal in the app (the
  // ShipmentHeaderBar DG badge, ShipmentContainersPage's contract-conflict chip); doesn't
  // also reach into container_packages' independent, unsynced pack-level DG flags.
  const dgContainerCount = useMemo(() => containers.filter(c => c.isDg).length, [containers]);

  useEffect(() => { load(); }, [load]);

  const bookable = BOOKABLE_CARRIERS.has(shipment.carrierCode);
  const status = booking?.status || "Created";
  const canSend = canEdit && bookable && status !== "Pending" && status !== "Confirmed";
  const outboundMessages = messages.filter(m => m.direction === "out");

  const handleSend = async () => {
    if (!canSend || sending) return;
    setSending(true);
    try {
      const result = await api.ediMessages.sendBookingRequest(shipment.id);
      await load();
      if (result.pending) {
        toast.info("Booking request sent — awaiting carrier response. Use Integration Board → Test Tools to simulate one.");
      } else {
        toast.success(result.isMock ? "Booking request sent (demo response received)" : "Booking request sent");
      }
    } catch (e) {
      toast.error(e.message || "Failed to send booking request");
    } finally {
      setSending(false);
    }
  };

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.textMuted,
      fontFamily: T.body, fontSize: 13, padding: "60px 0", justifyContent: "center" }}>
      <Spinner size="sm" /> Loading booking details…
    </div>
  );

  return (
    <div id="shpbooking-details-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <CarrierBookingsTable shipment={shipment} />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Status + BKG- id are no longer repeated here — both already appear on the
              current row in the "Bookings on this Shipment" table above (CarrierBookingsTable),
              which is now the single place that shows them. Heading font size matched to that
              table's own "Bookings on this Shipment" heading rather than standing out as a
              bigger, differently-weighted title above it. */}
          <h2 style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, margin: 0,
            display: "flex", alignItems: "center", gap: 8 }}>
            <IconAnchor size={14} />Carrier Booking — Details
          </h2>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 14, marginBottom: 24, background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: 10, padding: "16px 20px" }}>
        {[
          ["Carrier", shipment.carrierCode || "—"],
          ["Route", `${shipment.pol || "—"} → ${shipment.pod || "—"}`],
          ["ETD", shipment.etd || "—"],
          ["Vessel / Voyage", shipment.vessel ? `${shipment.vessel} / ${shipment.voyage || "—"}` : "—"],
          ["Booking Ref", booking?.bookingRef || "—"],
        ].map(([label, value]) => (
          <div key={label}>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
              textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{label}</div>
            <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: 14, marginBottom: 24, background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: 10, padding: "16px 20px" }}>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Contract Number</div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>
            {contract?.contractNumber || "—"}
          </div>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Reference</div>
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>
            {shipment.contractRef || "—"}
          </div>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Client</div>
          {/* Specifically the contract's own Named Account — not the shipment's Shipper/
              Consignee, which are separate parties. A SPOT/Pending/Customer Own contract (no
              linked contract record) or a Central contract with no named account both fall
              through to the same explicit "No Customer" text, per direct request. */}
          <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>
            {contract?.namedAccount || "No Customer"}
          </div>
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
            textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Commodity</div>
          {shipment.commodityCode ? <CommodityDisplay code={shipment.commodityCode} /> : (
            <div style={{ fontFamily: T.body, fontSize: 14, color: T.text, fontWeight: 600 }}>—</div>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>
          Equipment — sent with the booking request
        </div>
        {equipment.length === 0 ? (
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, fontStyle: "italic",
            background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px" }}>
            No containers added yet — the booking request will go out with no equipment detail.
          </div>
        ) : (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 80px 140px 140px",
              gap: 10, padding: "8px 16px", borderBottom: `1px solid ${T.border}`,
              fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase" }}>
              <span>Type</span><span>Count</span><span>Total Weight</span><span>Total Volume</span>
            </div>
            {equipment.map(e => (
              <div key={e.type} style={{ display: "grid", gridTemplateColumns: "1fr 80px 140px 140px",
                gap: 10, padding: "9px 16px", borderBottom: `1px solid ${T.border}22`,
                fontFamily: T.body, fontSize: 13, color: T.text }}>
                <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.accent }}>{e.type}</span>
                <span>{e.count}</span>
                <span>{e.totalWeightKg.toLocaleString()} kg</span>
                <span>{e.totalVolumeCbm.toLocaleString()} m³</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {dgContainerCount > 0 && (
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, marginBottom: 16,
          background: T.warning + "12", border: `1px solid ${T.warning}44`,
          borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <IconWarning size={13} color={T.warning} />
          {dgContainerCount} container{dgContainerCount !== 1 ? "s" : ""} with DG cargo will be declared to the carrier.
        </div>
      )}

      {!bookable && (
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginBottom: 16,
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px" }}>
          Booking requests aren't supported for carrier {shipment.carrierCode || "—"} yet.
        </div>
      )}
      {status === "Pending" && (
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, marginBottom: 16,
          background: "#3b82f612", border: "1px solid #3b82f644",
          borderRadius: 8, padding: "10px 14px" }}>
          Awaiting carrier response — check the Review page once it arrives.
        </div>
      )}

      {canEdit && (
        <button onClick={handleSend} disabled={!canSend || sending}
          style={{ background: canSend ? T.accent : T.border, border: "none", borderRadius: 7,
            color: canSend ? "#fff" : T.textMuted, cursor: canSend && !sending ? "pointer" : "default",
            padding: "9px 20px", fontFamily: T.body, fontSize: 13, fontWeight: 700,
            display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 24 }}>
          {sending ? "Sending…" : <><IconSendPlane size={13} />Send Booking Request</>}
        </button>
      )}

      <h3 style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 12 }}>
        Sent Requests
      </h3>
      <EdiMessageList messages={outboundMessages} emptyText="No booking requests sent yet." />
    </div>
  );
};

export default ShipmentCarrierBookingDetailsPage;
