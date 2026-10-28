import { useState, useEffect } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import { IconRefresh } from "../primitives/Icon";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY } from "../../pages/shipments/shipmentDetailTheme";

// ─── The carrier's word on a shipment (DCSA phase 6, 2026-10-28; mockup VUTPKnRAjdPjfb8DntUxVs) ─────
// Two cards on Milestones & Events:
//   - SeaLegTimes: each sea leg's departure and arrival, marked by where the date came from — ACTUAL (the
//     carrier confirmed it: Track & Trace or its vessel schedule), EST (the carrier's estimate), AIS
//     (detected by AIS, only where the carrier hasn't said) — or nothing (typed or planned);
//   - CarrierEventsPanel: every DCSA Track & Trace event the carrier sent (routes/carrier-tracking.js
//     GET …/carrier-events), newest first, with what CargoDesk did with it, plus "Sync carrier events"
//     (T&T 3.0 pull) and "Check vessel times" (OVS 3.0).

const SOURCE_TAG = { dcsa_actual: ["ACTUAL", "goodBg", "goodPillText"], dcsa: ["EST", "cyanBg", "cyan"], ais: ["AIS", "surface2", "text"] };
const Tag = ({ source, id }) => {
  const t = SOURCE_TAG[source];
  if (!t) return null;
  return <span id={id} style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: HZ[t[1]], color: HZ[t[2]] }}>{t[0]}</span>;
};
const day = s => (s ? new Date(`${String(s).slice(0, 10)}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "—");
const when = s => (s ? new Date(s).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const isSea = l => l.legType === "SEA" || (!l.legType && l.mot === "SEA");

export const SeaLegTimes = ({ shipmentId, reloadKey = 0 }) => {
  const [legs, setLegs] = useState([]);
  useEffect(() => { api.legs.list(shipmentId).then(r => setLegs((Array.isArray(r) ? r : r?.results || []).filter(isSea))).catch(() => setLegs([])); }, [shipmentId, reloadKey]);
  if (!legs.length) return null;
  const label = { fontSize: 11, color: HZ.textMuted, marginBottom: 4 };
  return (
    <div id="shpmiles-sea-legs" style={{ background: HZ.surface, backdropFilter: HZ.cardBlur, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10,
      padding: "16px 18px", display: "flex", flexDirection: "column", gap: 12, marginBottom: 14, fontFamily: HZ_BODY, color: HZ.text }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <span style={{ fontFamily: HZ_DISPLAY, fontSize: 15, fontWeight: 800 }}>Sea leg{legs.length > 1 ? "s" : ""}</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 11.5, color: HZ.textMuted }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Tag source="dcsa_actual" /> confirmed by the carrier</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Tag source="dcsa" /> the carrier's estimate</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Tag source="ais" /> detected by AIS (where the carrier hasn't said)</span>
        </div>
      </div>
      {legs.map(l => (
        <div key={l.id} data-testid={`shpmiles-leg-${l.id}`} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, fontSize: 12.5 }}>
          <div><div style={label}>From</div><div style={{ fontFamily: HZ_MONO, fontWeight: 700 }}>{l.pol || "—"}</div></div>
          <div><div style={label}>Departure</div><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span>{day(l.etd)}</span><Tag source={l.etdSource} id={`shpmiles-leg-${l.id}-etd-source`} /></div></div>
          <div><div style={label}>To</div><div style={{ fontFamily: HZ_MONO, fontWeight: 700 }}>{l.pod || "—"}</div></div>
          <div><div style={label}>Arrival</div><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span>{day(l.eta)}</span><Tag source={l.etaSource} id={`shpmiles-leg-${l.id}-eta-source`} /></div></div>
          <div><div style={label}>Vessel / voyage</div><div>{[l.vessel, l.voyage].filter(Boolean).join(" ") || "—"}</div></div>
        </div>
      ))}
    </div>
  );
};

// The event in words: "Gated in · laden", "Vessel departed", "Vessel departure" (an estimate of one)…
const EVENT_WORDS = {
  GATED_IN: "Gated in", GATED_OUT: "Gated out", LOADED: "Loaded", DISCHARGED: "Discharged", STUFFED: "Stuffed", STRIPPED: "Stripped",
  PICKED_UP: "Picked up", DROPPED_OFF: "Dropped off", CUSTOMS_RELEASED: "Released by customs", CUSTOMS_SELECTED_FOR_INSPECTION: "Selected for customs inspection",
  CUSTOMS_SELECTED_FOR_SCAN: "Selected for customs scan", INSPECTED: "Inspected", AVAILABLE_FOR_PICKUP: "Available for pickup",
  RELEASED: "Cargo released", ISSUED: "Document issued", CONFIRMED: "Confirmed",
};
const eventLabel = e => {
  if (e.eventType === "TRANSPORT") {
    const actual = e.eventClassifier === "ACTUAL";
    return e.eventCode === "DEPARTED" ? (actual ? "Vessel departed" : "Vessel departure")
      : e.eventCode === "ARRIVED" ? (actual ? "Vessel arrived" : "Vessel arrival") : e.eventCode === "APPROACHING" ? "Vessel approaching" : e.eventCode;
  }
  const base = EVENT_WORDS[e.eventCode] || String(e.eventCode || e.eventType).toLowerCase().replace(/_/g, " ");
  return e.emptyIndicator ? `${base} · ${e.emptyIndicator.toLowerCase()}` : base;
};
const CLASS_TAG = { ACTUAL: ["ACTUAL", "goodBg", "goodPillText"], ESTIMATED: ["EST", "cyanBg", "cyan"], PLANNED: ["PLAN", "surface2", "text"] };

const CarrierEventsPanel = ({ shipment, canEdit, reloadKey = 0, onChanged }) => {
  const [events, setEvents] = useState(null);
  const [booking, setBooking] = useState(null);
  const [busy, setBusy] = useState("");
  const load = () => api.carrierBooking.carrierEvents(shipment.id).then(setEvents).catch(() => setEvents([]));
  useEffect(() => { load(); api.carrierBooking.get(shipment.id).then(setBooking).catch(() => setBooking(null)); }, [shipment.id, reloadKey]);

  const carrier = booking?.carrierCode || shipment.carrierCode || "the carrier";
  const canSync = canEdit && !!booking?.carrierBookingRequestReference && !!booking?.bookingRef && booking.status !== "Cancelled";
  const sync = async () => {
    setBusy("sync");
    try {
      const r = await api.carrierBooking.syncEvents(shipment.id);
      const did = [r.added.length && `${r.added.length} container event${r.added.length === 1 ? "" : "s"}`, r.legTimes?.length && `${r.legTimes.length} vessel time${r.legTimes.length === 1 ? "" : "s"}`,
        r.milestones?.length && `${r.milestones.length} milestone${r.milestones.length === 1 ? "" : "s"}`].filter(Boolean);
      toast.success(did.length ? `From ${carrier}: ${did.join(", ")}` : `Nothing new from ${carrier}`);
      await load(); onChanged?.();
    } catch (e) { toast.error(e.message || "The carrier could not be asked for events"); }
    setBusy("");
  };
  const checkTimes = async () => {
    setBusy("times");
    try {
      const r = await api.carrierBooking.syncVesselTimes(shipment.id);
      if (r.changes.length) toast.success(r.changes.map(c => c.text).join(" · "));
      else toast.info(r.skipped[0]?.reason ? `No new vessel times: ${r.skipped[0].reason}` : "No new vessel times");
      onChanged?.();
    } catch (e) { toast.error(e.message); }
    setBusy("");
  };
  const th = { textAlign: "left", padding: "9px 14px", fontSize: 10.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: HZ.textMuted };

  return (
    <div id="shpmiles-carrier-events" style={{ background: HZ.surface, backdropFilter: HZ.cardBlur, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow, borderRadius: 10,
      overflow: "hidden", marginTop: 14, fontFamily: HZ_BODY, color: HZ.text }}>
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${HZ.border}`, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
        <span style={{ fontFamily: HZ_DISPLAY, fontSize: 15, fontWeight: 800 }}>From the carrier</span>
        <span style={{ fontSize: 12, color: HZ.textMuted }}>DCSA Track &amp; Trace 3.0 · newest first</span>
        {canEdit && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canSync && (
              <Btn variant="secondary" size="sm" onClick={sync} disabled={!!busy} data-testid="shipment-milestones-sync-carrier-events-btn"
                title={`Pull ${carrier}'s Track & Trace events for booking ${booking.bookingRef}`}>
                <IconRefresh size={12} /> {busy === "sync" ? "Syncing…" : "Sync carrier events"}
              </Btn>
            )}
            <Btn variant="secondary" size="sm" onClick={checkTimes} disabled={!!busy} data-testid="shipment-milestones-check-vessel-times-btn"
              title={`Ask ${carrier} for its vessel schedule (DCSA Operational Vessel Schedules)`}>
              {busy === "times" ? "Checking…" : "Check vessel times"}
            </Btn>
          </div>
        )}
      </div>
      {events === null ? (
        <div style={{ padding: "18px", fontSize: 12.5, color: HZ.textMuted }}>Loading…</div>
      ) : events.length === 0 ? (
        <div id="shpmiles-carrier-events-empty" style={{ padding: "18px", fontSize: 12.5, color: HZ.textMuted }}>
          Nothing from {carrier} yet. Its Track &amp; Trace events show here as they arrive (or with Sync carrier events).
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 820 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${HZ.border}` }}>
                <th scope="col" style={th}>When</th><th scope="col" style={th}>Event</th><th scope="col" style={th}>Where</th>
                <th scope="col" style={th}>Container</th><th scope="col" style={th}>What CargoDesk did</th>
              </tr>
            </thead>
            <tbody>
              {events.map(e => {
                const [t, bg, fg] = e.isRetracted ? ["RETRACTED", "critBg", "crit"] : CLASS_TAG[e.eventClassifier] || [e.eventClassifier, "surface2", "text"];
                return (
                  <tr key={e.id} data-testid={`shpmiles-carrier-event-${e.carrierEventId}`} style={{ borderBottom: `1px solid ${HZ.border}`, opacity: e.isRetracted ? 0.6 : 1 }}>
                    <td style={{ padding: "9px 14px", whiteSpace: "nowrap", color: HZ.textMuted }}>{when(e.eventDateTime)}</td>
                    <td style={{ padding: "9px 14px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 600 }}>{eventLabel(e)}</span>
                        <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: HZ[bg], color: HZ[fg] }}>{t}</span>
                      </div>
                    </td>
                    <td style={{ padding: "9px 14px", fontFamily: HZ_MONO }}>{e.unLocationCode || e.locationName || "—"}</td>
                    <td style={{ padding: "9px 14px", fontFamily: HZ_MONO, color: HZ.cyan }}>{e.equipmentReference || "—"}</td>
                    <td style={{ padding: "9px 14px", color: HZ.textMuted }}>{e.applied || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default CarrierEventsPanel;
