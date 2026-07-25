import { useState, useEffect, useCallback } from "react";
import { T } from "../tokens";
import { useAuth } from "../AuthContext";
import { api } from "../api";
import { toast } from "../toast";
import EdiMessageList from "../components/shared/EdiMessageList";
import { IconSendPlane, IconAnchor } from "../components/primitives/Icon";

// ─── Carrier Booking — Details ────────────────────────────────────────────────
// The outbound half of a booking: what we're asking the carrier for, and the Send
// action itself. Sibling to Review (the carrier's response + Confirm/Cancel), split
// out of the old EdiMessagesDrawer per the same "one concept, one dedicated page"
// precedent Accounting already established for Invoice/Cost/GP.

const BOOKABLE_CARRIERS = new Set(["MAEU", "SAFM", "MCPU"]);

const STATUS_COLOR = {
  Draft: "#6b7280", Pending: "#3b82f6", Confirmed: "#22c55e",
  Rejected: "#ef4444", Cancelled: "#6b7280",
};

const StatusBadge = ({ status }) => {
  const color = STATUS_COLOR[status] || T.textMuted;
  return (
    <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color,
      background: `${color}18`, border: `1px solid ${color}44`,
      borderRadius: 5, padding: "3px 10px", textTransform: "uppercase" }}>
      {status}
    </span>
  );
};

const ShipmentCarrierBookingDetailsPage = ({ shipment, onBack }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [booking,  setBooking]  = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [sending,  setSending]  = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([
      api.carrierBooking.get(shipment.id).catch(() => null),
      api.ediMessages.list(shipment.id).catch(() => []),
    ]).then(([b, m]) => { setBooking(b); setMessages(m); }).finally(() => setLoading(false));
  }, [shipment.id]);

  useEffect(() => { load(); }, [load]);

  const bookable = BOOKABLE_CARRIERS.has(shipment.carrierCode);
  const status = booking?.status || "Draft";
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

  if (loading) return null;

  return (
    <div id="shpbooking-details-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 style={{ fontFamily: T.head, fontSize: 20, fontWeight: 800, color: T.text, margin: 0,
            display: "flex", alignItems: "center", gap: 8 }}>
            <IconAnchor size={18} />Carrier Booking — Details
          </h2>
          <StatusBadge status={status} />
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

      {!bookable && (
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginBottom: 16,
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px" }}>
          Booking requests aren't supported for carrier {shipment.carrierCode || "—"} yet.
        </div>
      )}
      {status === "Pending" && (
        <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text, marginBottom: 16,
          background: `${STATUS_COLOR.Pending}12`, border: `1px solid ${STATUS_COLOR.Pending}44`,
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
