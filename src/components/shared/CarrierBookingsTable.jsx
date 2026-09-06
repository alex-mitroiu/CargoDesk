import { useState, useEffect, useCallback, useRef } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import Spinner from "../primitives/Spinner";
import { IconFolder } from "../primitives/Icon";

// ─── Carrier Bookings Table ────────────────────────────────────────────────────
// Shared by ShipmentCarrierBookingDetailsPage.jsx and ShipmentCarrierBookingReviewPage.jsx —
// embedded directly above each tab's own content rather than living behind a separate
// History tab (that tab existed for one release and was folded back in per direct
// feedback: simpler as one table, visible from either tab, than a third place to click).
//
// Shows every booking ever made on this shipment in one list: the current live
// carrier_bookings row (pinned to the top, tagged isCurrent) plus every row
// supersedeIfCarrierChanged (server.js) has since archived. Each keeps its own original
// BKG- surrogate key — an edit that doesn't actually change the carrier reuses the same id
// forever (see supersedeIfCarrierChanged's same-carrier branch); only an actual carrier
// change spins off a new one and archives the old.
//
// Click any row to expand its detail inline. A cancelled/superseded row's expanded detail
// is pure read-only display — there is nothing to act on, it's history. The current row's
// own Send/Confirm/Cancel actions are never duplicated here; they live in the surrounding
// Details/Review content this table sits above.

const STATUS_COLOR = {
  Created: "#6b7280", Pending: "#3b82f6", Confirmed: "#22c55e",
  Rejected: "#ef4444", Cancelled: "#6b7280",
};

const CarrierBookingsTable = ({ shipment }) => {
  const [rows,      setRows]      = useState(null); // null = loading
  const [expanded,  setExpanded]  = useState(null); // booking id
  const [documents, setDocuments] = useState([]); // for resolving a linked bl_document_id to a filename
  const loadRef = useRef(null);

  const load = useCallback(() => {
    return Promise.all([
      api.carrierBooking.get(shipment.id).catch(() => null),
      api.carrierBooking.history(shipment.id).catch(() => []),
      api.documents.list(shipment.id).catch(() => []),
    ]).then(([current, history, docs]) => {
      setRows([
        ...(current ? [{ ...current, isCurrent: true }] : []),
        ...history.map(h => ({ ...h, isCurrent: false })),
      ]);
      setDocuments(docs);
    });
  }, [shipment.id]);
  loadRef.current = load;

  useEffect(() => { load(); }, [load]);

  // Live updates — a booking can be auto-superseded (its own id swapped for a new one) the
  // moment a not-yet-Confirmed booking's carrier changes, which can happen from a completely
  // different page (Schedules, Test Tools) while this table is sitting open. Same WS pattern
  // Details/Review already use for their own state.
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost = import.meta.env.DEV ? "localhost:3001" : window.location.host;
    const ws = new WebSocket(`${proto}//${wsHost}/ws`);
    let pollId;
    ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", shipmentId: shipment.id }));
    ws.onmessage = e => {
      try {
        const frame = JSON.parse(e.data);
        if (frame.type === "booking_status_changed" || frame.type === "new_edi_message") loadRef.current?.();
      } catch { /* ignore */ }
    };
    ws.onerror = () => { pollId = setInterval(() => loadRef.current?.(), 10_000); };
    ws.onclose = () => { if (pollId) clearInterval(pollId); };
    return () => { ws.close(); if (pollId) clearInterval(pollId); };
  }, [shipment.id]);

  if (rows === null) return <div style={{ padding: "24px 0", textAlign: "center" }}><Spinner size="sm" /></div>;

  return (
    <div id="carrier-bookings-table" style={{ maxWidth: 1100, margin: "0 auto 24px" }}>
      <h3 style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 12 }}>
        Bookings on this Shipment
      </h3>

      {rows.length === 0 ? (
        <div style={{ textAlign: "center", padding: "30px 0", color: T.textMuted }}>
          <div style={{ marginBottom: 8 }}><IconFolder size={28} /></div>
          <div style={{ fontFamily: T.body, fontSize: 13 }}>No booking yet.</div>
        </div>
      ) : (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "150px 90px 100px 120px 1fr",
            gap: 10, padding: "8px 16px", borderBottom: `1px solid ${T.border}`,
            fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase" }}>
            <span>Booking ID</span><span>Carrier</span><span>Status</span><span>Date</span><span>Reason</span>
          </div>
          {rows.map(b => {
            const color = STATUS_COLOR[b.status] || T.textMuted;
            const isOpen = expanded === b.id;
            const dateVal = b.isCurrent
              ? (b.cancelledAt || b.respondedAt || b.requestedAt || b.createdAt || "")
              : (b.archivedAt || "");
            return (
              <div key={b.id} style={{ borderBottom: `1px solid ${T.border}22`,
                background: b.isCurrent ? `${T.accent}0c` : "transparent" }}>
                <button onClick={() => setExpanded(isOpen ? null : b.id)}
                  style={{ display: "grid", gridTemplateColumns: "150px 90px 100px 120px 1fr",
                    gap: 10, width: "100%", background: "none", border: "none", cursor: "pointer",
                    padding: "10px 16px", textAlign: "left", fontFamily: T.body, fontSize: 12.5, color: T.text }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.accent }}>{b.id}</span>
                    {b.isCurrent && (
                      <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: T.accent,
                        border: `1px solid ${T.accent}55`, borderRadius: 4, padding: "1px 5px", textTransform: "uppercase" }}>
                        Current
                      </span>
                    )}
                  </span>
                  <span style={{ fontFamily: T.mono }}>{b.carrierCode || "—"}</span>
                  <span style={{ fontFamily: T.mono, fontWeight: 700, color, textTransform: "uppercase" }}>{b.status}</span>
                  <span>{dateVal ? dateVal.slice(0, 10) : "—"}</span>
                  <span style={{ color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {b.archivedReason || "—"}
                  </span>
                </button>
                {isOpen && (() => {
                  const linkedDoc = b.blDocumentId ? documents.find(d => d.id === b.blDocumentId) : null;
                  return (
                  <div style={{ padding: "0 16px 14px 16px" }}>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                      {[
                        ["Booking Ref", b.bookingRef || "—"],
                        ["Requested", b.requestedAt ? `${b.requestedAt.slice(0, 10)} · ${b.requestedBy || "—"}` : "—"],
                        ["Last Response", b.lastResponseStatus || "—"],
                        ["Cancelled By", b.cancelledBy || "—"],
                        ["Cancel Reason", b.cancelReason || "—"],
                        ["Correlation ID", b.correlationId || "—"],
                        ["Linked B/L", linkedDoc
                          ? <a href="#" onClick={e => { e.preventDefault(); api.documents.download(shipment.id, linkedDoc.id, linkedDoc.filename); }}
                              style={{ color: T.accent, textDecoration: "none" }}>{linkedDoc.filename}</a>
                          : (b.blDocumentId ? "Linked document" : "Not linked")],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <div style={{ fontFamily: T.body, fontSize: 10, color: T.textMuted, fontWeight: 600,
                            textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 3 }}>{label}</div>
                          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.text }}>{value}</div>
                        </div>
                      ))}
                    </div>
                    {b.isCurrent ? (
                      <div style={{ marginTop: 10, fontFamily: T.body, fontSize: 11.5, color: T.textMuted, fontStyle: "italic" }}>
                        This is the current booking — use the actions below to manage it.
                      </div>
                    ) : (
                      <div style={{ marginTop: 10, fontFamily: T.body, fontSize: 11.5, color: T.textMuted, fontStyle: "italic" }}>
                        Superseded {b.archivedAt ? `on ${b.archivedAt.slice(0, 10)}` : ""} — read-only record, nothing here can be edited.
                      </div>
                    )}
                  </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default CarrierBookingsTable;
