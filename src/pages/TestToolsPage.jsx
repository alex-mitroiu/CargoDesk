import { useState, useEffect, useCallback } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Spinner from "../components/primitives/Spinner";
import Btn from "../components/primitives/Btn";
import EdiMessageList from "../components/shared/EdiMessageList";
import { IconBaseStation, IconCheck, IconClose } from "../components/primitives/Icon";

// ─── Test Tools — Message Simulator ───────────────────────────────────────────
// First tool under Integration Board > Test Tools. Emulates a carrier's response to
// a pending booking request (routes/edi.js's booking-request endpoint no longer
// fabricates one automatically — see the v0.35.0 changelog) so rejections and other
// non-happy-path outcomes can actually be exercised without a live carrier account.
// Writes real edi_messages rows through the real WS broadcast path — a Review page
// open elsewhere sees a simulated response exactly like a real one.

const STATUS_COLOR = {
  Draft: "#6b7280", Pending: "#3b82f6", Confirmed: "#22c55e",
  Rejected: "#ef4444", Cancelled: "#6b7280",
};

const TestToolsPage = ({ navigate }) => {
  const [bookings, setBookings] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [showAll,  setShowAll]  = useState(false); // false = Pending only (the realistic case)
  const [selected, setSelected] = useState(null);  // booking row, includes .shipment
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [bookingRefInput, setBookingRefInput] = useState("");
  const [reasonInput,     setReasonInput]     = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return api.carrierBooking.listAll(showAll ? {} : { status: "Pending" })
      .then(setBookings).catch(() => setBookings([])).finally(() => setLoading(false));
  }, [showAll]);

  useEffect(() => { load(); }, [load]);

  const loadThread = (shipmentId) => {
    setMessagesLoading(true);
    return api.ediMessages.list(shipmentId)
      .then(setMessages).catch(() => setMessages([])).finally(() => setMessagesLoading(false));
  };

  const selectBooking = (row) => {
    setSelected(row);
    setBookingRefInput("");
    setReasonInput("");
    loadThread(row.shipmentId);
  };

  const simulate = async (outcome) => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await api.ediMessages.simulateResponse(selected.shipmentId, {
        outcome,
        bookingRef: outcome === "confirmed" ? (bookingRefInput.trim() || undefined) : undefined,
        reason:     outcome === "rejected"  ? (reasonInput.trim()     || undefined) : undefined,
      });
      toast.success(`Simulated ${outcome} response`);
      const [freshBooking] = await Promise.all([
        api.carrierBooking.get(selected.shipmentId),
        load(),
        loadThread(selected.shipmentId),
      ]);
      setSelected(prev => prev ? { ...prev, ...freshBooking } : prev);
    } catch (e) {
      toast.error(e.message || "Failed to simulate response");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", gap: 24, height: "100%" }}>
      {/* Left: booking picker */}
      <div style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column" }}>
        <h2 style={{ fontFamily: T.head, fontSize: 18, fontWeight: 800, color: T.text, margin: "0 0 14px",
          display: "flex", alignItems: "center", gap: 8 }}>
          <IconBaseStation size={16} />Message Simulator
        </h2>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
          fontFamily: T.body, fontSize: 12.5, color: T.textMuted, cursor: "pointer" }}>
          <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)}
            style={{ accentColor: T.accent }} />
          Show all bookings, not just Pending
        </label>
        {loading ? <Spinner size="sm" /> : bookings.length === 0 ? (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
            {showAll ? "No carrier bookings yet." : "No pending booking requests right now."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
            {bookings.map(b => {
              const color = STATUS_COLOR[b.status] || T.textMuted;
              const active = selected?.id === b.id;
              return (
                <button key={b.id} onClick={() => selectBooking(b)}
                  style={{ textAlign: "left", background: active ? T.accentBg : T.surface,
                    border: `1px solid ${active ? T.accent : T.border}`, borderRadius: 8,
                    padding: "10px 12px", cursor: "pointer" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                    <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                      {b.shipment?.id}
                    </span>
                    <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color,
                      textTransform: "uppercase" }}>{b.status}</span>
                  </div>
                  <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                    {b.carrierCode} · {b.shipment?.pol} → {b.shipment?.pod}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Right: selected booking's thread + simulate actions */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {!selected ? (
          <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic",
            textAlign: "center", marginTop: 60 }}>
            Select a booking on the left to view its message thread and simulate a response.
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>
                {selected.shipment?.id} — {selected.carrierCode}
              </h3>
              <Btn variant="secondary" size="sm"
                onClick={() => navigate?.("shipment-carrier-booking-review", selected.shipmentId)}>
                Open Review Page
              </Btn>
            </div>

            {selected.status === "Pending" ? (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
                padding: "16px 20px", marginBottom: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
                  textTransform: "uppercase", letterSpacing: ".06em" }}>Simulate Carrier Response</div>
                <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <label style={{ display: "block", fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 5 }}>
                      Booking ref (optional — auto-generated if blank)
                    </label>
                    <input value={bookingRefInput} onChange={e => setBookingRefInput(e.target.value)}
                      style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text,
                        borderRadius: 6, padding: "7px 10px", width: "100%", boxSizing: "border-box",
                        fontFamily: T.mono, fontSize: 12.5, marginBottom: 8 }} />
                    <Btn size="sm" onClick={() => simulate("confirmed")} disabled={busy}>
                      <IconCheck size={12} /> Simulate Confirmed
                    </Btn>
                  </div>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <label style={{ display: "block", fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 5 }}>
                      Rejection reason (optional)
                    </label>
                    <input value={reasonInput} onChange={e => setReasonInput(e.target.value)}
                      placeholder="No space available…"
                      style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text,
                        borderRadius: 6, padding: "7px 10px", width: "100%", boxSizing: "border-box",
                        fontFamily: T.body, fontSize: 12.5, marginBottom: 8 }} />
                    <Btn size="sm" variant="danger" onClick={() => simulate("rejected")} disabled={busy}>
                      <IconClose size={12} /> Simulate Rejected
                    </Btn>
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginBottom: 20,
                background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px" }}>
                This booking is {selected.status.toLowerCase()} — nothing pending to respond to.
              </div>
            )}

            <h4 style={{ fontFamily: T.head, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 10 }}>
              Message Thread
            </h4>
            {messagesLoading ? <Spinner size="sm" /> : (
              <EdiMessageList messages={messages} emptyText="No messages for this shipment yet." />
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default TestToolsPage;
