import { useState, useEffect, useCallback } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Spinner from "../components/primitives/Spinner";
import Btn from "../components/primitives/Btn";
import { IconRefresh } from "../components/primitives/Icon";
import { dcsaLabel, CARRIER_ACTIONS } from "../utils/dcsaCodes";

// ─── Test Tools → DCSA Carrier ────────────────────────────────────────────────
// Plays the carrier for every booking the built-in DCSA simulator holds (lib/dcsa-simulator; DCSA-
// everywhere phase 1, layout A of the approved mockup https://claude.ai/artifact/YWTqiqFffgjxDPq827CdPD).
// Replaced the booking Message Simulator on 2026-10-11. Only the decisions valid for the booking's
// current DCSA state are offered (the simulator says which); each one is sent back to CargoDesk as a
// signed DCSA notification, exactly as a real carrier's would be, so the shipment updates through the
// same path. The demo carrier never answers on its own (decided by the user).

const STATE_TONE = {
  RECEIVED: "info", UPDATE_RECEIVED: "info", AMENDMENT_RECEIVED: "warn", CONFIRMED: "good", AMENDMENT_CONFIRMED: "good",
  PENDING_UPDATE: "warn", PENDING_AMENDMENT: "warn", CANCELLATION_RECEIVED: "warn", CANCELLATION_DECLINED: "warn", AMENDMENT_DECLINED: "warn",
  REJECTED: "bad", DECLINED: "bad", CANCELLED: "bad", CANCELLATION_CONFIRMED: "bad", AMENDMENT_CANCELLED: "warn", COMPLETED: "good",
};
const toneColor = tone => ({ info: T.info || T.accent, good: T.success, warn: T.warning, bad: T.danger }[tone] || T.textMuted);
// The state that matters most right now: a pending cancellation, then an amendment, then the booking itself.
const leadState = b => b.bookingCancellationStatus || b.amendedBookingStatus || b.bookingStatus;

const StatePill = ({ code }) => {
  const c = toneColor(STATE_TONE[code]);
  return (
    <span title={dcsaLabel(code)} style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: ".03em", color: c,
      background: `${c}18`, borderRadius: 999, padding: "2px 8px", whiteSpace: "nowrap" }}>{code}</span>
  );
};

const StateBox = ({ title, code }) => (
  <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, padding: "8px 10px", minWidth: 0 }}>
    <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".06em" }}>{title}</div>
    {code ? (
      <>
        <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: toneColor(STATE_TONE[code]), marginTop: 2, overflowWrap: "anywhere" }}>{code}</div>
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>{dcsaLabel(code)}</div>
      </>
    ) : <div style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted, marginTop: 2 }}>—</div>}
  </div>
);

const fmtTime = iso => iso ? new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

export default function DcsaCarrierPanel({ navigate }) {
  const [bookings, setBookings] = useState(null); // null = loading
  const [error, setError] = useState("");
  const [selectedRef, setSelectedRef] = useState(null);
  const [feedback, setFeedback] = useState("");
  const [thread, setThread] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.dcsaSim.bookings()
    .then(rows => { setBookings(rows); setError(""); return rows; })
    .catch(e => { setBookings([]); setError(e.message || "The DCSA carrier simulator isn't available"); return []; }), []);

  useEffect(() => { load().then(rows => { if (rows.length) setSelectedRef(r => r || rows[0].carrierBookingRequestReference); }); }, [load]);

  const selected = (bookings || []).find(b => b.carrierBookingRequestReference === selectedRef) || null;

  const loadThread = useCallback(shipmentId => {
    if (!shipmentId) { setThread([]); return Promise.resolve(); }
    return api.ediMessages.list(shipmentId)
      .then(msgs => setThread(msgs.filter(m => m.direction === "in" && /^booking_/.test(m.messageType)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))))
      .catch(() => setThread([]));
  }, []);
  useEffect(() => { loadThread(selected?.shipmentId); }, [selected?.shipmentId, loadThread]);

  const decide = async action => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await api.dcsaSim.act(selected.carrierBookingRequestReference, action, feedback.trim() || undefined);
      toast.success(`${selected.carrierCode} — ${CARRIER_ACTIONS[action]?.label || action}: sent to CargoDesk`);
      setFeedback("");
      await Promise.all([load(), loadThread(selected.shipmentId)]);
    } catch (e) {
      toast.error(e.message || "The carrier's decision didn't go through");
    } finally { setBusy(false); }
  };

  return (
    <div data-testid="dcsa-carrier-panel" style={{ display: "flex", flexDirection: "column", gap: 14, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 4px" }}>Play the carrier</h2>
          <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, maxWidth: 680, lineHeight: 1.5 }}>
            Bookings held by CargoDesk's built-in DCSA carrier, for carriers with no DCSA connection of their own.
            Your decision goes back to CargoDesk as a DCSA notification, and the shipment updates as it would for a real carrier.
          </div>
        </div>
        <Btn variant="secondary" size="sm" onClick={() => load()} disabled={busy} data-testid="dcsa-carrier-refresh-btn">
          <IconRefresh size={12} /> Refresh
        </Btn>
      </div>

      {bookings === null ? <Spinner size="sm" /> : error ? (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.warning }}>{error}</div>
      ) : bookings.length === 0 ? (
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
          No bookings yet. Send a booking request for a carrier without a DCSA integration, and it appears here.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 340px) minmax(0, 1fr)", gap: 20, minHeight: 0 }}>
          {/* Left: the simulator's bookings */}
          <div role="listbox" aria-label="Bookings held by the DCSA carrier simulator" data-testid="dcsa-carrier-list"
            style={{ display: "flex", flexDirection: "column", border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", alignSelf: "start", maxHeight: "70vh", overflowY: "auto" }}>
            {bookings.map(b => {
              const active = b.carrierBookingRequestReference === selectedRef;
              return (
                <button key={b.carrierBookingRequestReference} role="option" aria-selected={active}
                  data-testid={`dcsa-carrier-row-${b.shipmentId || b.carrierBookingRequestReference}`}
                  onClick={() => { setSelectedRef(b.carrierBookingRequestReference); setFeedback(""); }}
                  style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", gap: 10, alignItems: "center", textAlign: "left",
                    background: active ? T.accentBg : T.surface, border: "none", borderBottom: `1px solid ${T.border}`,
                    boxShadow: active ? `inset 3px 0 0 ${T.accent}` : "none", padding: "10px 12px", cursor: "pointer" }}>
                  <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.accent, background: T.accentBg, borderRadius: 4, padding: "2px 6px" }}>{b.carrierCode || "—"}</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {b.shipmentId || "(shipment deleted)"}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>{b.pol || "?"} → {b.pod || "?"}</span>
                  </span>
                  <StatePill code={leadState(b)} />
                </button>
              );
            })}
          </div>

          {/* Right: the chosen booking, its three DCSA states, the carrier's decisions, what was sent */}
          {selected && (
            <div data-testid="dcsa-carrier-detail" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>
                  {selected.shipmentId || "—"} · {selected.carrierCode}
                  <span style={{ fontWeight: 400, color: T.textMuted }}> {selected.pol} → {selected.pod}</span>
                </h3>
                {selected.shipmentId && (
                  <Btn variant="secondary" size="sm" onClick={() => navigate?.("shipment-carrier-booking-review", selected.shipmentId)}>Open Review Page</Btn>
                )}
              </div>

              <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 14px", margin: 0, fontSize: 12.5 }}>
                <dt style={{ fontFamily: T.body, color: T.textMuted }}>Request reference</dt>
                <dd style={{ margin: 0, fontFamily: T.mono, color: T.text }}>{selected.carrierBookingRequestReference}</dd>
                <dt style={{ fontFamily: T.body, color: T.textMuted }}>Carrier booking number</dt>
                <dd style={{ margin: 0, fontFamily: T.mono, color: T.text }}>{selected.carrierBookingReference || "— (issued on confirmation)"}</dd>
              </dl>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
                <StateBox title="Booking" code={selected.bookingStatus} />
                <StateBox title="Amendment" code={selected.amendedBookingStatus} />
                <StateBox title="Cancellation" code={selected.bookingCancellationStatus} />
              </div>

              {selected.actions.length > 0 ? (
                <>
                  <div>
                    <label htmlFor="dcsa-carrier-feedback" style={{ display: "block", fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 5 }}>
                      Feedback to send with the decision (optional)
                    </label>
                    <textarea id="dcsa-carrier-feedback" data-testid="dcsa-carrier-feedback" rows={2} value={feedback} onChange={e => setFeedback(e.target.value)}
                      placeholder="e.g. No space on 045W, next available sailing 9 Nov"
                      style={{ width: "100%", boxSizing: "border-box", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6,
                        padding: "8px 10px", color: T.text, fontFamily: T.body, fontSize: 13, resize: "vertical" }} />
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {Object.entries(CARRIER_ACTIONS).filter(([key]) => selected.actions.includes(key)).map(([key, a]) => (
                      <Btn key={key} size="sm" variant={a.variant} onClick={() => decide(key)} disabled={busy} data-testid={`dcsa-carrier-action-${key}`}>
                        {a.label}
                      </Btn>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, fontStyle: "italic" }}>The carrier has nothing left to decide on this booking.</div>
              )}

              <div>
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 6 }}>What CargoDesk received from the carrier</div>
                {thread.length === 0 ? (
                  <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, fontStyle: "italic" }}>Nothing yet.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
                    {thread.slice(0, 12).map(m => {
                      let parsed = {};
                      try { parsed = JSON.parse(m.parsedPayload || "{}"); } catch { /* not ours to fix */ }
                      const state = parsed.bookingCancellationStatus || parsed.amendedBookingStatus || parsed.bookingStatus;
                      const note = (parsed.feedbacks || []).map(f => f.message).filter(Boolean).join(" · ");
                      return (
                        <div key={m.id} style={{ display: "grid", gridTemplateColumns: "auto auto minmax(0, 1fr)", gap: 10, alignItems: "center",
                          padding: "7px 10px", borderBottom: `1px solid ${T.border}`, fontSize: 12 }}>
                          <span style={{ fontFamily: T.mono, color: T.textMuted }}>{fmtTime(m.createdAt)}</span>
                          {state ? <StatePill code={state} /> : <span />}
                          <span style={{ fontFamily: T.body, color: T.textMuted, overflowWrap: "anywhere" }}>
                            {m.messageType === "booking_status" ? "Poll" : "Notification"}{note ? ` — ${note}` : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
