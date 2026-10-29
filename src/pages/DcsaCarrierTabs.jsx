import { useState, useEffect, useCallback } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Spinner from "../components/primitives/Spinner";
import Btn from "../components/primitives/Btn";

// ─── Test Tools → DCSA Carrier: Shipping Instructions & B/L, Track & Trace, Vessel times ──────────
// DCSA-everywhere phases 4–6 (2026-10-28), mockup VUTPKnRAjdPjfb8DntUxVs. The built-in carrier's side of
// eBL 3.0 (it accepts Shipping Instructions by drafting its Master B/L, issues and surrenders it), of
// Track & Trace 3.0 (it reports what happened to a booking, and pushes the events) and of Operational
// Vessel Schedules 3.0 (its vessels' planned, estimated and actual times). Each decision reaches
// CargoDesk the way a real carrier's would (routes/dcsa-simulator.js).

const box = { border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 12 };
const input = { minHeight: 34, padding: "0 8px", borderRadius: 7, border: `1px solid ${T.border}`, background: T.bg, color: T.text, fontFamily: T.body, fontSize: 12.5, boxSizing: "border-box" };
const lbl = { display: "block", fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 };
const fmt = iso => (iso ? new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const empty = text => <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>{text}</div>;
const errorText = text => <div style={{ fontFamily: T.body, fontSize: 13, color: T.warning }}>{text}</div>;
const list = r => (Array.isArray(r) ? r : r?.results || []);

// ─── Shipping Instructions & the Master B/L ─────────────────────────────────
const SI_ACTIONS = [
  { key: "draft", label: si => (si.td ? "Redraft the Master B/L" : "Draft the Master B/L"), variant: "primary",
    when: (si, td) => (si.carrierState === "RECEIVED" || (si.carrierState === "PENDING_UPDATE" && si.carrierUpdatedState === "UPDATE_RECEIVED")) && ["", "DRAFT", "APPROVED"].includes(td) },
  { key: "requestUpdate", label: () => "Ask for an update", variant: "secondary", when: (si, td) => si.carrierState === "RECEIVED" && ["", "DRAFT", "APPROVED"].includes(td) },
  { key: "issue", label: si => (si.td?.transportDocumentStatus === "SURRENDERED_FOR_AMENDMENT" ? "Issue the amended B/L" : "Issue"), variant: "secondary",
    when: (si, td) => ["DRAFT", "APPROVED"].includes(td) || (td === "SURRENDERED_FOR_AMENDMENT" && si.td?.amendedTransportDocumentStatus === "AMENDMENT_CONFIRMED") },
  { key: "surrender", label: () => "Surrender for delivery", variant: "secondary", when: (si, td) => td === "ISSUED" },
  // An amendment CargoDesk asked for (Shipping Instructions → Master B/L → Request amendment).
  { key: "confirmAmendment", label: () => "Accept the amendment", variant: "primary", when: si => si.td?.amendedTransportDocumentStatus === "AMENDMENT_RECEIVED" },
  { key: "declineAmendment", label: () => "Decline the amendment", variant: "danger", when: si => si.td?.amendedTransportDocumentStatus === "AMENDMENT_RECEIVED" },
  { key: "surrenderForAmendment", label: () => "Originals surrendered for amendment", variant: "secondary", when: (si, td) => td === "PENDING_SURRENDER_FOR_AMENDMENT" },
  { key: "decline", label: () => "Decline", variant: "danger", when: (si, td) => ["RECEIVED", "PENDING_UPDATE"].includes(si.carrierState) && ["", "DRAFT", "APPROVED", "VOIDED"].includes(td) },
  { key: "void", label: () => "Void", variant: "danger", when: (si, td) => td && !["VOIDED", "SURRENDERED_FOR_DELIVERY"].includes(td) },
];
const SI_STATE = { RECEIVED: "Received", PENDING_UPDATE: "Update requested", DECLINED: "Declined", COMPLETED: "Completed", CANCELLED: "Cancelled" };

export function ShippingInstructionsTab({ navigate }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => Promise.all([api.shippingInstructions.listAll({}), api.dcsaSim.transportDocuments()])
    .then(([sis, tds]) => {
      const tdBySi = new Map(tds.map(t => [t.shippingInstructionsReference, t]));
      const held = sis.filter(s => s.isMock && s.siReference).map(s => ({ ...s, td: tdBySi.get(s.siReference) || null }));
      setRows(held); setError("");
      setSelected(r => r && held.some(h => h.siReference === r) ? r : held[0]?.siReference || null);
    })
    .catch(e => { setRows([]); setError(e.message || "The DCSA carrier simulator isn't available"); }), []);
  useEffect(() => { load(); }, [load]);
  const si = (rows || []).find(r => r.siReference === selected) || null;
  const td = si?.td?.transportDocumentStatus || "";

  const publishAn = async lightweight => {
    setBusy(true);
    try {
      const r = await api.dcsaSim.publishArrivalNotice({ shipmentId: si.shipmentId, lightweight });
      toast.success(`${si.carrierCode || "Carrier"}: Arrival Notice version ${r.versionLabel} ${lightweight ? "announced" : "sent"} to CargoDesk`);
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const act = async key => {
    setBusy(true);
    try {
      const r = await api.dcsaSim.actSi(si.siReference, key, message.trim() || undefined);
      toast[r.refused ? "warning" : "success"](r.refused || `${si.carrierCode || "Carrier"}: ${SI_ACTIONS.find(a => a.key === key).label(si).toLowerCase()} — sent to CargoDesk`);
      setMessage("");
      await load();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  if (rows === null) return <Spinner size="sm" />;
  if (error) return errorText(error);
  if (!rows.length) return empty("No Shipping Instructions yet. Submit them for a shipment booked with the demo carrier, and they appear here.");
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 340px) minmax(0, 1fr)", gap: 20 }}>
      <div role="listbox" aria-label="Shipping Instructions held by the demo carrier" data-testid="dcsa-si-list"
        style={{ display: "flex", flexDirection: "column", border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", alignSelf: "start", maxHeight: "70vh", overflowY: "auto" }}>
        {rows.map(r => {
          const active = r.siReference === selected;
          return (
            <button key={r.siReference} role="option" aria-selected={active} data-testid={`dcsa-si-row-${r.shipmentId}`} onClick={() => { setSelected(r.siReference); setMessage(""); }}
              style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, textAlign: "left", background: active ? T.accentBg : T.surface, border: "none",
                borderBottom: `1px solid ${T.border}`, boxShadow: active ? `inset 3px 0 0 ${T.accent}` : "none", padding: "10px 12px", cursor: "pointer" }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>{r.shipmentId}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{r.siReference}</span>
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.textMuted, alignSelf: "center" }}>
                {r.td ? r.td.transportDocumentStatus : SI_STATE[r.carrierState] || r.carrierState}
              </span>
            </button>
          );
        })}
      </div>
      {si && (
        <div data-testid="dcsa-si-detail" style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>{si.shipmentId} · {si.carrierCode}</h3>
            <Btn variant="secondary" size="sm" onClick={() => navigate?.("shipment-shipping-instructions", si.shipmentId)}>Open Shipping Instructions</Btn>
          </div>
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 14px", margin: 0, fontSize: 12.5 }}>
            <dt style={{ fontFamily: T.body, color: T.textMuted }}>Shipping Instructions</dt>
            <dd data-testid="dcsa-si-state" style={{ margin: 0, fontFamily: T.mono, color: T.text }}>
              {si.siReference} · {SI_STATE[si.carrierState] || si.carrierState}{si.carrierUpdatedState ? ` · ${si.carrierUpdatedState}` : ""}
            </dd>
            <dt style={{ fontFamily: T.body, color: T.textMuted }}>Master B/L</dt>
            <dd data-testid="dcsa-si-td" style={{ margin: 0, fontFamily: T.mono, color: T.text }}>
              {si.td ? `${si.td.transportDocumentReference} · ${si.td.transportDocumentStatus.toLowerCase().replace(/_/g, " ")}` : "not drafted"}
              {si.td?.amendedTransportDocumentStatus ? ` · ${si.td.amendedTransportDocumentStatus.toLowerCase().replace(/_/g, " ")}` : ""}
            </dd>
          </dl>
          <div>
            <label htmlFor="dcsa-si-message" style={lbl}>The carrier's message (optional, shown on the instructions)</label>
            <input id="dcsa-si-message" data-testid="dcsa-si-message" value={message} onChange={e => setMessage(e.target.value)}
              placeholder="e.g. Consignee tax ID missing for US customs" style={{ ...input, width: "100%" }} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {SI_ACTIONS.map(a => {
              const ok = a.when(si, td);
              return <Btn key={a.key} size="sm" variant={a.variant} disabled={busy || !ok} onClick={() => act(a.key)} data-testid={`dcsa-si-action-${a.key}`}>{a.label(si)}</Btn>;
            })}
          </div>
          {["ISSUED", "PENDING_SURRENDER_FOR_DELIVERY", "SURRENDERED_FOR_DELIVERY"].includes(td) && (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>Arrival Notice (DCSA 1.0):</span>
              <Btn size="sm" variant="secondary" disabled={busy} onClick={() => publishAn(false)} data-testid="dcsa-an-publish">Publish Arrival Notice</Btn>
              <Btn size="sm" variant="secondary" disabled={busy} onClick={() => publishAn(true)} data-testid="dcsa-an-announce">Announce it (lightweight)</Btn>
            </div>
          )}
          <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, lineHeight: 1.5 }}>
            Draft = the carrier accepts the instructions: CargoDesk shows the draft for review and approval. Issue and Surrender follow; the surrender
            completes the Shipping Instructions. An amendment CargoDesk asks for once the B/L is issued is accepted or declined here; once
            accepted, the originals are surrendered for amendment and the amended B/L is issued.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Track & Trace 3.0 ───────────────────────────────────────────────────────
const KINDS = [
  ["gateIn", "Gated in"], ["loaded", "Loaded"], ["departed", "Departed"], ["arrived", "Arrived"], ["discharged", "Discharged"],
  ["customsReleased", "Released by customs"], ["gateOut", "Gated out"], ["emptyReturn", "Returned empty"], ["released", "Cargo released"],
];
const describe = e => {
  const c = e.eventClassification || {};
  const code = c.equipmentEventType || c.transportEventType || c.shipmentEventType || "";
  return [code.toLowerCase().replace(/_/g, " "), c.eventClassifier && c.eventClassifier !== "ACTUAL" ? c.eventClassifier.toLowerCase() : "",
    e.equipmentDetails?.emptyIndicator?.toLowerCase(), e.eventLocation?.UNLocationCode].filter(Boolean).join(" · ");
};

export function TrackTraceTab() {
  const [bookings, setBookings] = useState(null);
  const [error, setError] = useState("");
  const [shipmentId, setShipmentId] = useState("");
  const [classifier, setClassifier] = useState("ACTUAL");
  const [at, setAt] = useState("");
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.dcsaSim.bookings().then(rows => {
      const booked = rows.filter(b => b.carrierBookingReference);
      setBookings(booked); setShipmentId(s => s || booked[0]?.shipmentId || "");
    }).catch(e => { setBookings([]); setError(e.message); });
  }, []);
  const booking = (bookings || []).find(b => b.shipmentId === shipmentId);
  const loadEvents = useCallback(() => booking ? api.dcsaSim.events(booking.carrierBookingReference).then(setEvents).catch(() => setEvents([])) : setEvents([]), [booking?.carrierBookingReference]);
  useEffect(() => { loadEvents(); }, [loadEvents]);

  const report = async kind => {
    setBusy(true);
    try {
      const r = await api.dcsaSim.reportEvent({ shipmentId, kind, classifier: ["departed", "arrived"].includes(kind) ? classifier : "ACTUAL",
        dateTime: at ? new Date(at).toISOString() : "" });
      const did = r.carrierEvents.filter(e => r.reported.includes(e.carrierEventId)).map(e => e.applied).filter(Boolean);
      toast.success(did.length ? `CargoDesk: ${[...new Set(did)].join(" · ")}` : `Reported ${r.reported.length} event${r.reported.length === 1 ? "" : "s"}`);
      if (r.feedback?.length) toast.warning(r.feedback.map(f => f.message).join(" · "));
      await loadEvents();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  const retract = async id => {
    setBusy(true);
    try { await api.dcsaSim.retractEvent(id); toast.success("Retracted — sent to CargoDesk"); await loadEvents(); }
    catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  if (bookings === null) return <Spinner size="sm" />;
  if (error) return errorText(error);
  if (!bookings.length) return empty("No confirmed bookings with the demo carrier yet: confirm one under Bookings first.");
  return (
    <div style={box}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        <div>
          <label htmlFor="dcsa-tnt-shipment" style={lbl}>Booking with the demo carrier</label>
          <select id="dcsa-tnt-shipment" data-testid="dcsa-tnt-shipment" value={shipmentId} onChange={e => setShipmentId(e.target.value)} style={{ ...input, width: "100%" }}>
            {bookings.map(b => <option key={b.shipmentId} value={b.shipmentId}>{b.shipmentId} · {b.carrierBookingReference} · {b.pol} → {b.pod}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="dcsa-tnt-classifier" style={lbl}>Classifier (departure and arrival)</label>
          <select id="dcsa-tnt-classifier" data-testid="dcsa-tnt-classifier" value={classifier} onChange={e => setClassifier(e.target.value)} style={{ ...input, width: "100%" }}>
            <option value="ACTUAL">Actual</option><option value="ESTIMATED">Estimated</option><option value="PLANNED">Planned</option>
          </select>
        </div>
        <div>
          <label htmlFor="dcsa-tnt-when" style={lbl}>When (empty = now)</label>
          <input id="dcsa-tnt-when" data-testid="dcsa-tnt-when" type="datetime-local" value={at} onChange={e => setAt(e.target.value)} style={{ ...input, width: "100%" }} />
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {KINDS.map(([k, label]) => <Btn key={k} size="sm" variant="secondary" disabled={busy || !shipmentId} onClick={() => report(k)} data-testid={`dcsa-tnt-report-${k}`}>{label}</Btn>)}
      </div>
      {events.length === 0 ? empty("The carrier hasn't reported anything on this booking yet.") : (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
          {events.map(e => (
            <div key={e.eventID} data-testid={`dcsa-tnt-event-${e.eventID}`} style={{ display: "grid", gridTemplateColumns: "130px minmax(0, 1fr) 130px 90px", gap: 12, alignItems: "center",
              padding: "8px 12px", borderBottom: `1px solid ${T.border}`, fontFamily: T.body, fontSize: 12, opacity: e.isRetracted ? 0.55 : 1 }}>
              <span style={{ color: T.textMuted }}>{fmt(e.eventDateTime)}</span>
              <span style={{ color: T.text }}>{e.isRetracted ? `${e.eventID} · retracted` : describe(e)}</span>
              <span style={{ fontFamily: T.mono, color: T.accent }}>{e.equipmentDetails?.equipmentReference || "—"}</span>
              {!e.isRetracted
                ? <Btn size="sm" variant="danger" disabled={busy} onClick={() => retract(e.eventID)}>Retract</Btn>
                : <span />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Operational Vessel Schedules 3.0 ───────────────────────────────────────
const TIME_KINDS = [["ARRI|EST", "Arrival · estimated"], ["ARRI|ACT", "Arrival · actual"], ["ARRI|PLN", "Arrival · planned"],
  ["DEPA|EST", "Departure · estimated"], ["DEPA|ACT", "Departure · actual"], ["DEPA|PLN", "Departure · planned"]];

export function VesselTimesTab() {
  const [form, setForm] = useState({ vesselName: "", vesselImo: "", voyage: "", unLocationCode: "", kind: "ARRI|EST", at: "", carrierCode: "" });
  const [calls, setCalls] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.dcsaSim.vesselCalls().then(setCalls).catch(e => { setCalls([]); setError(e.message); }), []);
  useEffect(() => {
    load();
    // Start from the newest demo-carrier booking's sea leg, so the form is ready to use.
    api.dcsaSim.bookings().then(async rows => {
      const b = rows.find(x => x.carrierBookingReference);
      if (!b) return;
      const sea = list(await api.legs.list(b.shipmentId)).find(l => l.legType === "SEA");
      if (sea) setForm(f => ({ ...f, vesselName: sea.vessel || "", vesselImo: sea.vesselImo || "", voyage: sea.voyage || "", unLocationCode: sea.pod || "", carrierCode: b.carrierCode || "" }));
    }).catch(() => {});
  }, [load]);
  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
  const save = async () => {
    const [eventTypeCode, eventClassifierCode] = form.kind.split("|");
    setBusy(true);
    try {
      await api.dcsaSim.setVesselCall({ carrierCode: form.carrierCode, vesselName: form.vesselName.trim(), vesselImo: form.vesselImo.trim(), voyage: form.voyage.trim(),
        unLocationCode: form.unLocationCode.trim().toUpperCase(), eventTypeCode, eventClassifierCode, eventDateTime: form.at ? new Date(form.at).toISOString() : "" });
      toast.success("Vessel time set. CargoDesk reads it with Check vessel times on the shipment.");
      await load();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };
  // The same call as a Port Call 2.0 berth arrival/departure, pushed to CargoDesk at once (phase 8).
  const sendPortCall = async () => {
    const [kind, short] = form.kind.split("|");
    setBusy(true);
    try {
      const r = await api.dcsaSim.reportPortCall({ vesselImo: form.vesselImo.trim(), vesselName: form.vesselName.trim(), voyage: form.voyage.trim(),
        unLocationCode: form.unLocationCode.trim().toUpperCase(), kind, classifier: { PLN: "PLANNED", EST: "ESTIMATED", ACT: "ACTUAL" }[short],
        dateTime: form.at ? new Date(form.at).toISOString() : "" });
      toast[r.feedback?.length ? "warning" : "success"](r.feedback?.[0]?.message || "Port Call event sent: the shipments on that voyage have their leg time.");
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  if (calls === null) return <Spinner size="sm" />;
  if (error) return errorText(error);
  return (
    <div style={box}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, alignItems: "end" }}>
        <div><label htmlFor="dcsa-ovs-vessel" style={lbl}>Vessel</label><input id="dcsa-ovs-vessel" value={form.vesselName} onChange={set("vesselName")} style={{ ...input, width: "100%" }} /></div>
        <div><label htmlFor="dcsa-ovs-imo" style={lbl}>IMO number</label><input id="dcsa-ovs-imo" value={form.vesselImo} onChange={set("vesselImo")} style={{ ...input, width: "100%" }} /></div>
        <div><label htmlFor="dcsa-ovs-voyage" style={lbl}>Voyage</label><input id="dcsa-ovs-voyage" value={form.voyage} onChange={set("voyage")} style={{ ...input, width: "100%" }} /></div>
        <div><label htmlFor="dcsa-ovs-port" style={lbl}>Port (UN/LOCODE)</label><input id="dcsa-ovs-port" value={form.unLocationCode} onChange={set("unLocationCode")} style={{ ...input, width: "100%" }} /></div>
        <div><label htmlFor="dcsa-ovs-kind" style={lbl}>Time</label>
          <select id="dcsa-ovs-kind" value={form.kind} onChange={set("kind")} style={{ ...input, width: "100%" }}>{TIME_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div><label htmlFor="dcsa-ovs-when" style={lbl}>Date and time</label><input id="dcsa-ovs-when" type="datetime-local" value={form.at} onChange={set("at")} style={{ ...input, width: "100%" }} /></div>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Btn size="sm" variant="secondary" onClick={sendPortCall} disabled={busy || !form.vesselImo || !form.voyage || !form.unLocationCode || !form.at} data-testid="dcsa-portcall-send">Send as a Port Call event</Btn>
          <Btn size="sm" onClick={save} disabled={busy || !form.voyage || !form.unLocationCode || !form.at} data-testid="dcsa-ovs-save">{busy ? "Setting…" : "Set vessel time"}</Btn>
        </div>
      </div>
      {calls.length === 0 ? empty("No vessel times yet.") : (
        <div style={{ border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
          {calls.map(c => (
            <div key={c.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) 70px minmax(0, 1fr) minmax(0, 1fr)", gap: 12, padding: "8px 12px",
              borderBottom: `1px solid ${T.border}`, fontFamily: T.body, fontSize: 12 }}>
              <span style={{ color: T.text }}>{c.vessel_name || c.vessel_imo} {c.voyage}</span>
              <span style={{ fontFamily: T.mono }}>{c.un_location_code}</span>
              <span>{TIME_KINDS.find(([v]) => v === `${c.event_type}|${c.classifier}`)?.[1] || `${c.event_type} ${c.classifier}`}</span>
              <span style={{ color: T.textMuted }}>{fmt(c.event_date_time)}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
        CargoDesk reads these with "Check vessel times" on the shipment's Milestones &amp; Events. The hourly check only asks carriers with an integration of their own.
        "Send as a Port Call event" pushes the same berth arrival or departure as DCSA Port Call 2.0 instead (needs the IMO number).
      </div>
    </div>
  );
}
