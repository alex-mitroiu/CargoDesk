import { useState, useEffect, useCallback, useRef } from "react";
import { T } from "../tokens";
import { useAuth } from "../AuthContext";
import { api } from "../api";
import { toast } from "../toast";
import Btn from "../components/primitives/Btn";
import Spinner from "../components/primitives/Spinner";
import { Modal } from "../components/primitives/Modal";
import EdiMessageList, { EDI_STATUS_COLOR } from "../components/shared/EdiMessageList";
import CarrierBookingsTable from "../components/shared/CarrierBookingsTable";
import { IconCheck, IconClose, IconAnchor } from "../components/primitives/Icon";
import { BOOKABLE_CARRIERS } from "../utils/carrierBooking";

// ─── Carrier Booking — Review ─────────────────────────────────────────────────
// The inbound half: the carrier's response (real or Test-Tools-simulated) plus the
// full bidirectional message thread, and the Confirm/Cancel actions. A confirmed
// carrier response does NOT finalize the booking by itself — Confirm is a deliberate,
// separate operator action (see the migration comment on carrier_bookings in server.js
// for why: it's what lets "simulate confirmed, then click Confirm" be two real,
// independently-testable steps instead of the same thing twice).

const ShipmentCarrierBookingReviewPage = ({ shipment, onBack, onRefresh }) => {
  const { canEditShipments: canEdit } = useAuth();
  const [booking,  setBooking]  = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [confirmModal, setConfirmModal] = useState(null); // null | { bookingRef, note }
  const [cancelModal,  setCancelModal]  = useState(null); // null | { reason }
  const [busy, setBusy] = useState(false);
  const loadRef = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([
      api.carrierBooking.get(shipment.id).catch(() => null),
      api.ediMessages.list(shipment.id).catch(() => []),
    ]).then(([b, m]) => { setBooking(b); setMessages(m); }).finally(() => setLoading(false));
  }, [shipment.id]);
  loadRef.current = load;

  useEffect(() => { load(); }, [load]);

  // Live updates — same WS pattern as the old EDI drawer (ShipmentHeaderBar.jsx), so a
  // Test Tools simulate action lands here immediately if this page is already open.
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost = import.meta.env.DEV ? "localhost:3001" : window.location.host;
    const ws = new WebSocket(`${proto}//${wsHost}/ws`);
    let pollId;
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", shipmentId: shipment.id }));
    ws.onmessage = e => {
      try {
        const frame = JSON.parse(e.data);
        if (frame.type === "new_edi_message") {
          setMessages(prev => prev.some(m => m.id === frame.message.id) ? prev : [frame.message, ...prev]);
        } else if (frame.type === "booking_status_changed") {
          setBooking(frame.booking);
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { pollId = setInterval(() => loadRef.current?.(), 10_000); };
    ws.onclose = () => { if (pollId) clearInterval(pollId); };
    return () => { ws.close(); if (pollId) clearInterval(pollId); };
  }, [shipment.id]);

  const status = booking?.status || "Created";
  const canConfirm = canEdit && status !== "Confirmed" && status !== "Cancelled";
  const canCancel  = canEdit && status !== "Cancelled";
  const willNotifyCarrier = BOOKABLE_CARRIERS.has(shipment.carrierCode) && !!booking?.correlationId;
  const latestInbound = messages.filter(m => m.direction === "in")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;

  const openConfirm = () => setConfirmModal({ bookingRef: booking?.bookingRef || "", note: "" });
  const openCancel  = () => setCancelModal({ reason: "" });

  const doConfirm = async () => {
    if (!confirmModal?.bookingRef?.trim()) { toast.error("A booking reference is required"); return; }
    setBusy(true);
    try {
      await api.carrierBooking.confirm(shipment.id, { bookingRef: confirmModal.bookingRef.trim(), note: confirmModal.note.trim() || undefined });
      toast.success("Booking confirmed");
      setConfirmModal(null);
      await load();
      onRefresh?.();
    } catch (e) {
      toast.error(e.message || "Failed to confirm booking");
    } finally { setBusy(false); }
  };

  const doCancel = async () => {
    setBusy(true);
    try {
      await api.carrierBooking.cancel(shipment.id, { reason: cancelModal.reason.trim() || undefined });
      toast.success("Booking cancelled");
      setCancelModal(null);
      await load();
      onRefresh?.();
    } catch (e) {
      toast.error(e.message || "Failed to cancel booking");
    } finally { setBusy(false); }
  };

  if (loading) return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: T.textMuted,
      fontFamily: T.body, fontSize: 13, padding: "60px 0", justifyContent: "center" }}>
      <Spinner size="sm" /> Loading booking review…
    </div>
  );

  return (
    <div id="shpbooking-review-page" style={{ maxWidth: 1100, margin: "0 auto" }}>
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
            <IconAnchor size={14} />Carrier Booking — Review
          </h2>
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 8 }}>
            <Btn variant="secondary" onClick={openCancel} disabled={!canCancel}>Cancel Booking</Btn>
            <Btn onClick={openConfirm} disabled={!canConfirm}>Confirm Booking</Btn>
          </div>
        )}
      </div>

      {/* Carrier Response card */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "16px 20px", marginBottom: 24 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>Carrier Response</div>
        {!booking?.lastResponseStatus ? (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
            No response received yet.
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700,
              color: EDI_STATUS_COLOR[booking.lastResponseStatus] || T.text,
              textTransform: "uppercase" }}>
              {booking.lastResponseStatus}{booking.isMock ? " · demo" : ""}
            </span>
            {booking.bookingRef && (
              <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>Ref: {booking.bookingRef}</span>
            )}
            {latestInbound?.parsedPayload && (() => {
              try {
                const parsed = JSON.parse(latestInbound.rawPayload || "{}");
                return parsed.reason ? (
                  <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>— {parsed.reason}</span>
                ) : null;
              } catch { return null; }
            })()}
          </div>
        )}
      </div>

      <h3 style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 12 }}>
        Message Thread
      </h3>
      <EdiMessageList messages={messages} emptyText="No EDI messages for this shipment yet." />

      {confirmModal && (
        <Modal title="Confirm Booking" onClose={() => !busy && setConfirmModal(null)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>
                Booking Reference
              </label>
              <input value={confirmModal.bookingRef}
                onChange={e => setConfirmModal(m => ({ ...m, bookingRef: e.target.value }))}
                style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text,
                  borderRadius: 6, padding: "8px 12px", width: "100%", boxSizing: "border-box",
                  fontFamily: T.mono, fontSize: 13 }} />
            </div>
            <div>
              <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>
                Note (optional)
              </label>
              <input value={confirmModal.note}
                onChange={e => setConfirmModal(m => ({ ...m, note: e.target.value }))}
                style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text,
                  borderRadius: 6, padding: "8px 12px", width: "100%", boxSizing: "border-box",
                  fontFamily: T.body, fontSize: 13 }} />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setConfirmModal(null)} disabled={busy}>Cancel</Btn>
              <Btn onClick={doConfirm} disabled={busy}>
                {busy ? "Confirming…" : <><IconCheck size={13} /> Confirm</>}
              </Btn>
            </div>
          </div>
        </Modal>
      )}

      {cancelModal && (
        <Modal title="Cancel Booking" onClose={() => !busy && setCancelModal(null)} width={420}>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <p style={{ fontFamily: T.body, fontSize: 13, color: T.text, margin: 0, lineHeight: 1.5 }}>
              {willNotifyCarrier
                ? "This marks the booking as cancelled and sends a cancellation message to the carrier."
                : "This marks the booking as cancelled."}
            </p>
            <div>
              <label style={{ display: "block", fontFamily: T.body, fontSize: 11, fontWeight: 600,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>
                Reason (optional)
              </label>
              <input value={cancelModal.reason}
                onChange={e => setCancelModal(m => ({ ...m, reason: e.target.value }))}
                style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text,
                  borderRadius: 6, padding: "8px 12px", width: "100%", boxSizing: "border-box",
                  fontFamily: T.body, fontSize: 13 }} />
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn variant="secondary" onClick={() => setCancelModal(null)} disabled={busy}>Back</Btn>
              <Btn variant="danger" onClick={doCancel} disabled={busy}>
                {busy ? "Cancelling…" : <><IconClose size={13} /> Cancel Booking</>}
              </Btn>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default ShipmentCarrierBookingReviewPage;
