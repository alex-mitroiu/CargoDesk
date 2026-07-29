import { useState, useEffect, useCallback } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Spinner from "../components/primitives/Spinner";
import Btn from "../components/primitives/Btn";
import EdiMessageList from "../components/shared/EdiMessageList";
import { VesselField } from "../components/shared/VesselCombobox";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import PortCombobox from "../components/shared/PortCombobox";
import { IconBaseStation, IconCheck, IconClose, IconAnchor, IconFileCertificate } from "../components/primitives/Icon";

// ─── Test Tools ────────────────────────────────────────────────────────────────
// Reached both from Integration Board's sidebar and a header shortcut icon (App.jsx).
// Three tools so far:
//  - Message Simulator: emulates a carrier's response to a pending booking request
//    (routes/edi.js's booking-request endpoint no longer fabricates one automatically —
//    see the v0.35.0 changelog) so rejections and other non-happy-path outcomes can
//    actually be exercised without a live carrier account.
//  - Schedule Generator: authors realistic sea schedules from the real Vessels/Ports/
//    Carriers MDM data (instead of mockSailings()'s synthetic "DEMO ALLEGRO" placeholders)
//    and can attach one schedule to MULTIPLE real shipments at once — the "shared schedule
//    catalog" introduced alongside this tool (v0.37.0): shipment_schedules.shipment_id
//    stays the schedule's owner exactly as it always has, additional shipments link via a
//    new schedule_shipment_links row, so "how many shipments are on schedule SCHED-XYZ" is
//    finally answerable.
//  - Filing Simulator (Epic TKT-XW6TQK): emulates a customs authority's response to a Filed
//    AES/EEI or ISF/AMS filing — same "no live government EDI, so simulate the outcome"
//    precedent as the Message Simulator, mirroring its exact shape (pick a pending item,
//    Accept/Reject with an optional ref/reason, refresh three things in parallel).

const STATUS_COLOR = {
  Created: "#6b7280", Pending: "#3b82f6", Confirmed: "#22c55e",
  Rejected: "#ef4444", Cancelled: "#6b7280",
};

// Distinct key set from STATUS_COLOR above (customs_filings has its own status vocabulary —
// Draft/Filed/Accepted/Rejected, not Created/Pending/Confirmed/Cancelled) — not merged in.
const FILING_STATUS_COLOR = {
  Draft: "#6b7280", Filed: "#3b82f6", Accepted: "#22c55e", Rejected: "#ef4444",
};

const inputStyle = {
  background: T.bg, border: `1px solid ${T.border}`, color: T.text,
  borderRadius: 6, padding: "7px 10px", width: "100%", boxSizing: "border-box",
  fontFamily: T.body, fontSize: 12.5,
};

const label = { display: "block", fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 5 };

const TestToolsPage = ({ navigate, shipments = [] }) => {
  const [activeTab, setActiveTab] = useState("simulator"); // "simulator" | "generator"

  // ─── Message Simulator state (unchanged) ──────────────────────────────────
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

  // ─── Schedule Generator state ─────────────────────────────────────────────
  const [vessel,       setVessel]       = useState(null); // {imo, name, ...} | null
  const [carrierCode,  setCarrierCode]  = useState("");
  const [pol,          setPol]          = useState(null); // {unlocode, name} | null
  const [pod,          setPod]          = useState(null);
  const [voyageNumber, setVoyageNumber] = useState("");
  const [service,      setService]      = useState("");
  const [etd, setEtd] = useState(""); const [atd, setAtd] = useState("");
  const [eta, setEta] = useState(""); const [ata, setAta] = useState("");
  const [shipQuery,       setShipQuery]       = useState("");
  const [linkShipmentIds, setLinkShipmentIds] = useState([]);
  const [genBusy, setGenBusy] = useState(false);

  const [catalog,        setCatalog]        = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [expandedId,     setExpandedId]     = useState(null);
  const [expandedData,   setExpandedData]   = useState(null);
  const [expandedLoading,setExpandedLoading]= useState(false);
  const [linkPickerQuery, setLinkPickerQuery] = useState("");

  const loadCatalog = useCallback(() => {
    setCatalogLoading(true);
    return api.scheduleCatalog.list({ source: "generated" })
      .then(setCatalog).catch(() => setCatalog([])).finally(() => setCatalogLoading(false));
  }, []);

  useEffect(() => { if (activeTab === "generator") loadCatalog(); }, [activeTab, loadCatalog]);

  const shipMatches = q => {
    const query = q.trim().toUpperCase();
    if (!query) return [];
    return shipments.filter(s =>
      s.id.toUpperCase().includes(query) || s.pol?.toUpperCase().includes(query) || s.pod?.toUpperCase().includes(query)
    ).slice(0, 8);
  };

  const toggleLinkShipment = id => {
    setLinkShipmentIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const resetGeneratorForm = () => {
    setVessel(null); setCarrierCode(""); setPol(null); setPod(null);
    setVoyageNumber(""); setService(""); setEtd(""); setAtd(""); setEta(""); setAta("");
    setShipQuery(""); setLinkShipmentIds([]);
  };

  const generate = async () => {
    if (!vessel?.imo)       return toast.error("Pick a vessel");
    if (!carrierCode)       return toast.error("Pick a carrier");
    if (!pol?.unlocode || !pod?.unlocode) return toast.error("Pick POL and POD");
    if (linkShipmentIds.length === 0)     return toast.error("Pick at least one shipment to link");
    setGenBusy(true);
    try {
      const created = await api.scheduleCatalog.create({
        carrier: carrierCode, vesselImo: vessel.imo, vesselName: vessel.name,
        voyageNumber, service, pol: pol.unlocode, pod: pod.unlocode, etd, atd, eta, ata,
        initialShipmentIds: linkShipmentIds,
      });
      toast.success(`Schedule ${created.id} created — linked to ${linkShipmentIds.length} shipment(s)`);
      resetGeneratorForm();
      loadCatalog();
    } catch (e) {
      toast.error(e.message || "Failed to generate schedule");
    } finally {
      setGenBusy(false);
    }
  };

  const openExpanded = async (schedId) => {
    if (expandedId === schedId) { setExpandedId(null); setExpandedData(null); return; }
    setExpandedId(schedId);
    setExpandedLoading(true);
    setLinkPickerQuery("");
    try {
      setExpandedData(await api.scheduleCatalog.linkedShipments(schedId));
    } catch { setExpandedData(null); }
    setExpandedLoading(false);
  };

  const linkAnother = async (schedId, shipmentId) => {
    try {
      await api.scheduleCatalog.link(schedId, { shipmentId });
      toast.success(`Linked ${shipmentId}`);
      setLinkPickerQuery("");
      setExpandedData(await api.scheduleCatalog.linkedShipments(schedId));
      loadCatalog();
    } catch (e) {
      toast.error(e.message || "Failed to link shipment");
    }
  };

  const unlink = async (schedId, shipmentId) => {
    try {
      await api.scheduleCatalog.unlink(schedId, shipmentId);
      toast.success(`Unlinked ${shipmentId}`);
      setExpandedData(await api.scheduleCatalog.linkedShipments(schedId));
      loadCatalog();
    } catch (e) {
      toast.error(e.message || "Failed to unlink shipment");
    }
  };

  // ─── Filing Simulator state (Epic TKT-XW6TQK) ─────────────────────────────
  const [filings,         setFilings]         = useState([]);
  const [filingsLoading,  setFilingsLoading]  = useState(true);
  const [showAllFilings,  setShowAllFilings]  = useState(false); // false = Filed only
  const [selectedFiling,  setSelectedFiling]  = useState(null);  // filing row, includes .shipment
  const [filingMessages,  setFilingMessages]  = useState([]);
  const [filingMsgLoading,setFilingMsgLoading]= useState(false);
  const [confNumInput,    setConfNumInput]    = useState("");
  const [rejReasonInput,  setRejReasonInput]  = useState("");
  const [filingBusy,      setFilingBusy]      = useState(false);

  const loadFilings = useCallback(() => {
    setFilingsLoading(true);
    return api.customsFilings.listAll(showAllFilings ? {} : { status: "Filed" })
      .then(setFilings).catch(() => setFilings([])).finally(() => setFilingsLoading(false));
  }, [showAllFilings]);

  useEffect(() => { loadFilings(); }, [loadFilings]);

  const loadFilingThread = shipmentId => {
    setFilingMsgLoading(true);
    return api.ediMessages.list(shipmentId)
      .then(setFilingMessages).catch(() => setFilingMessages([])).finally(() => setFilingMsgLoading(false));
  };

  const selectFiling = row => {
    setSelectedFiling(row);
    setConfNumInput("");
    setRejReasonInput("");
    loadFilingThread(row.shipmentId);
  };

  const simulateFiling = async outcome => {
    if (!selectedFiling || filingBusy) return;
    setFilingBusy(true);
    try {
      await api.customsFilings.simulateResponse(selectedFiling.shipmentId, selectedFiling.id, {
        outcome,
        confirmationNumber: outcome === "accepted" ? (confNumInput.trim() || undefined) : undefined,
        reason:             outcome === "rejected" ? (rejReasonInput.trim() || undefined) : undefined,
      });
      toast.success(`Simulated ${outcome} response`);
      const [freshFilings] = await Promise.all([
        api.customsFilings.list(selectedFiling.shipmentId),
        loadFilings(),
        loadFilingThread(selectedFiling.shipmentId),
      ]);
      const fresh = freshFilings.find(f => f.id === selectedFiling.id);
      setSelectedFiling(prev => prev ? { ...prev, ...fresh } : prev);
    } catch (e) {
      toast.error(e.message || "Failed to simulate response");
    } finally {
      setFilingBusy(false);
    }
  };

  const FILING_TYPE_LABEL = { AES_EEI: "AES/EEI (Export)", ISF_AMS: "ISF/AMS (Import)" };

  const TABS = [
    { key: "simulator", label: "Message Simulator", icon: IconBaseStation },
    { key: "generator",  label: "Schedule Generator", icon: IconAnchor },
    { key: "filings",    label: "Filing Simulator", icon: IconFileCertificate },
  ];

  return (
    <div>
      {/* Tab row — same underline pattern as AppSettingsPage's tabs */}
      <div style={{ display: "flex", gap: 24, borderBottom: `1px solid ${T.border}`, marginBottom: 20 }}>
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

      {activeTab === "simulator" && (
        <div style={{ display: "flex", gap: 24, height: "100%" }}>
          {/* Left: booking picker */}
          <div style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column" }}>
            <h2 style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 14px" }}>
              Simulate a carrier response
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
                        <label style={label}>
                          Booking ref (optional — auto-generated if blank)
                        </label>
                        <input value={bookingRefInput} onChange={e => setBookingRefInput(e.target.value)}
                          style={{ ...inputStyle, fontFamily: T.mono, marginBottom: 8 }} />
                        <Btn size="sm" onClick={() => simulate("confirmed")} disabled={busy}>
                          <IconCheck size={12} /> Simulate Confirmed
                        </Btn>
                      </div>
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <label style={label}>
                          Rejection reason (optional)
                        </label>
                        <input value={reasonInput} onChange={e => setReasonInput(e.target.value)}
                          placeholder="No space available…"
                          style={{ ...inputStyle, marginBottom: 8 }} />
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
      )}

      {activeTab === "generator" && (
        <div style={{ display: "flex", gap: 24 }}>
          {/* Left: generator form */}
          <div style={{ width: 380, flexShrink: 0 }}>
            <h2 style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 6px" }}>
              Generate a schedule
            </h2>
            <p style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, margin: "0 0 16px", lineHeight: 1.5 }}>
              Built from the real Vessels/Ports/Carriers registry — attach it to one or more
              shipments at once to exercise a schedule shared across many shipments.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <VesselField vessel={vessel} onSelect={setVessel} />
              <div>
                <label style={label}>Carrier</label>
                <CarrierCombobox value={carrierCode} onChange={setCarrierCode} />
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={label}>POL</label>
                  <PortCombobox value={pol} onChange={setPol} placeholder="Search POL…" />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={label}>POD</label>
                  <PortCombobox value={pod} onChange={setPod} placeholder="Search POD…" />
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={label}>ETD (estimated)</label>
                  <input type="date" value={etd} onChange={e => setEtd(e.target.value)} style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={label}>ATD (actual, optional)</label>
                  <input type="date" value={atd} onChange={e => setAtd(e.target.value)} style={inputStyle} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={label}>ETA (estimated)</label>
                  <input type="date" value={eta} onChange={e => setEta(e.target.value)} style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={label}>ATA (actual, optional)</label>
                  <input type="date" value={ata} onChange={e => setAta(e.target.value)} style={inputStyle} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label style={label}>Voyage (optional)</label>
                  <input value={voyageNumber} onChange={e => setVoyageNumber(e.target.value)} style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={label}>Service (optional)</label>
                  <input value={service} onChange={e => setService(e.target.value)} style={inputStyle} />
                </div>
              </div>

              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, marginTop: 4 }}>
                <label style={label}>Link to shipment(s)</label>
                <input value={shipQuery} onChange={e => setShipQuery(e.target.value)}
                  placeholder="Search by ID, POL, or POD…" style={{ ...inputStyle, marginBottom: 6 }} />
                {shipQuery.trim() && (
                  <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6,
                    maxHeight: 160, overflowY: "auto", marginBottom: 8 }}>
                    {shipMatches(shipQuery).map(s => (
                      <button key={s.id} onClick={() => { toggleLinkShipment(s.id); setShipQuery(""); }}
                        style={{ display: "block", width: "100%", textAlign: "left", background: "none",
                          border: "none", cursor: "pointer", padding: "7px 10px",
                          fontFamily: T.mono, fontSize: 11.5, color: T.text,
                          borderBottom: `1px solid ${T.border}33` }}
                        onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                        onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                        {s.id} <span style={{ color: T.textMuted }}>· {s.pol} → {s.pod}</span>
                      </button>
                    ))}
                    {shipMatches(shipQuery).length === 0 && (
                      <div style={{ padding: "8px 10px", fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
                        No matches.
                      </div>
                    )}
                  </div>
                )}
                {linkShipmentIds.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                    {linkShipmentIds.map(id => (
                      <span key={id} style={{ display: "flex", alignItems: "center", gap: 5,
                        background: T.accentBg, border: `1px solid ${T.accent}55`, borderRadius: 5,
                        padding: "3px 8px", fontFamily: T.mono, fontSize: 11, color: T.accent }}>
                        {id}
                        <button onClick={() => toggleLinkShipment(id)}
                          style={{ background: "none", border: "none", cursor: "pointer", color: T.accent,
                            padding: 0, fontSize: 11, lineHeight: 1 }}>✕</button>
                      </span>
                    ))}
                  </div>
                )}
                <Btn onClick={generate} disabled={genBusy}>
                  {genBusy ? "Generating…" : <><IconAnchor size={12} /> Generate &amp; Link</>}
                </Btn>
              </div>
            </div>
          </div>

          {/* Right: catalog browser */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            <h3 style={{ fontFamily: T.head, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 10 }}>
              Generated Schedules
            </h3>
            {catalogLoading ? <Spinner size="sm" /> : catalog.length === 0 ? (
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
                No generated schedules yet.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {catalog.map(s => (
                  <div key={s.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8 }}>
                    <button onClick={() => openExpanded(s.id)}
                      style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                        width: "100%", background: "none", border: "none", cursor: "pointer",
                        padding: "10px 14px", textAlign: "left" }}>
                      <div>
                        <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                          {s.carrier} · {s.vesselName} {s.vesselImo && `(IMO ${s.vesselImo})`}
                        </div>
                        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                          {s.pol} → {s.pod} · ETD {s.etd || "—"}
                        </div>
                      </div>
                      <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.accent,
                        background: `${T.accent}18`, borderRadius: 12, padding: "3px 10px", flexShrink: 0 }}>
                        {s.linkedShipmentCount} shipment{s.linkedShipmentCount !== 1 ? "s" : ""}
                      </span>
                    </button>
                    {expandedId === s.id && (
                      <div style={{ borderTop: `1px solid ${T.border}`, padding: "10px 14px" }}>
                        {expandedLoading ? <Spinner size="sm" /> : expandedData && (
                          <>
                            <div style={{ display: "grid",
                              gridTemplateColumns: "110px 130px 90px 110px 50px 90px 24px",
                              gap: 8, fontFamily: T.mono, fontSize: 10.5, color: T.textMuted,
                              fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>
                              <span>Shipment</span><span>POL → POD</span><span>ETD</span>
                              <span>Contract</span><span>TEU</span><span>Status</span><span />
                            </div>
                            {[expandedData.owner, ...expandedData.linked].filter(Boolean).map((sh, i) => (
                              <div key={sh.id} style={{ display: "grid",
                                gridTemplateColumns: "110px 130px 90px 110px 50px 90px 24px",
                                gap: 8, alignItems: "center", padding: "5px 0",
                                borderTop: i > 0 ? `1px solid ${T.border}22` : "none" }}>
                                <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.accent, fontWeight: 700 }}>
                                  {sh.id}{i === 0 && <span title="Owner" style={{ color: T.textMuted }}> ★</span>}
                                </span>
                                <span style={{ fontFamily: T.mono, fontSize: 11 }}>{sh.pol} → {sh.pod}</span>
                                <span style={{ fontFamily: T.mono, fontSize: 11 }}>{sh.etd || "—"}</span>
                                <span style={{ fontFamily: T.body, fontSize: 11 }}>{sh.contractType || "—"}</span>
                                <span style={{ fontFamily: T.mono, fontSize: 11 }}>{sh.teu}</span>
                                <span style={{ fontFamily: T.body, fontSize: 11 }}>{sh.status}</span>
                                {i > 0 ? (
                                  <button onClick={() => unlink(s.id, sh.id)} title="Unlink"
                                    style={{ background: "none", border: "none", cursor: "pointer",
                                      color: T.textMuted, fontSize: 12 }}>✕</button>
                                ) : <span />}
                              </div>
                            ))}
                            <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                              <input value={linkPickerQuery} onChange={e => setLinkPickerQuery(e.target.value)}
                                placeholder="+ Link another shipment (ID, POL, POD)…"
                                style={{ ...inputStyle, fontSize: 11.5 }} />
                            </div>
                            {linkPickerQuery.trim() && (
                              <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6,
                                maxHeight: 140, overflowY: "auto", marginTop: 6 }}>
                                {shipMatches(linkPickerQuery).map(sh => (
                                  <button key={sh.id} onClick={() => linkAnother(s.id, sh.id)}
                                    style={{ display: "block", width: "100%", textAlign: "left", background: "none",
                                      border: "none", cursor: "pointer", padding: "6px 10px",
                                      fontFamily: T.mono, fontSize: 11, color: T.text }}
                                    onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
                                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                                    {sh.id} <span style={{ color: T.textMuted }}>· {sh.pol} → {sh.pod}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "filings" && (
        <div style={{ display: "flex", gap: 24, height: "100%" }}>
          {/* Left: filing picker */}
          <div style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column" }}>
            <h2 style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 14px" }}>
              Simulate a regulatory response
            </h2>
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14,
              fontFamily: T.body, fontSize: 12.5, color: T.textMuted, cursor: "pointer" }}>
              <input type="checkbox" checked={showAllFilings} onChange={e => setShowAllFilings(e.target.checked)}
                style={{ accentColor: T.accent }} />
              Show all filings, not just Filed
            </label>
            {filingsLoading ? <Spinner size="sm" /> : filings.length === 0 ? (
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
                {showAllFilings ? "No customs filings yet." : "No filed submissions awaiting a response right now."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
                {filings.map(f => {
                  const color = FILING_STATUS_COLOR[f.status] || T.textMuted;
                  const active = selectedFiling?.id === f.id;
                  return (
                    <button key={f.id} onClick={() => selectFiling(f)}
                      style={{ textAlign: "left", background: active ? T.accentBg : T.surface,
                        border: `1px solid ${active ? T.accent : T.border}`, borderRadius: 8,
                        padding: "10px 12px", cursor: "pointer" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                        <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                          {f.shipment?.id}
                        </span>
                        <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color,
                          textTransform: "uppercase" }}>{f.status}</span>
                      </div>
                      <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                        {FILING_TYPE_LABEL[f.filingType] || f.filingType} · {f.shipment?.pol} → {f.shipment?.pod}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: selected filing's thread + simulate actions */}
          <div style={{ flex: 1, overflowY: "auto" }}>
            {!selectedFiling ? (
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic",
                textAlign: "center", marginTop: 60 }}>
                Select a filing on the left to view its message thread and simulate a response.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                  <h3 style={{ fontFamily: T.head, fontSize: 15, fontWeight: 700, color: T.text, margin: 0 }}>
                    {selectedFiling.shipment?.id} — {FILING_TYPE_LABEL[selectedFiling.filingType] || selectedFiling.filingType}
                  </h3>
                  <Btn variant="secondary" size="sm"
                    onClick={() => navigate?.("shipment-customs-filing-review", selectedFiling.shipmentId)}>
                    Open Review Page
                  </Btn>
                </div>

                {selectedFiling.status === "Filed" ? (
                  <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
                    padding: "16px 20px", marginBottom: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                    <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
                      textTransform: "uppercase", letterSpacing: ".06em" }}>Simulate Regulatory Response</div>
                    <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <label style={label}>
                          Confirmation number (optional — auto-generated if blank)
                        </label>
                        <input value={confNumInput} onChange={e => setConfNumInput(e.target.value)}
                          style={{ ...inputStyle, fontFamily: T.mono, marginBottom: 8 }} />
                        <Btn size="sm" onClick={() => simulateFiling("accepted")} disabled={filingBusy}>
                          <IconCheck size={12} /> Simulate Accepted
                        </Btn>
                      </div>
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <label style={label}>
                          Rejection reason (optional)
                        </label>
                        <input value={rejReasonInput} onChange={e => setRejReasonInput(e.target.value)}
                          placeholder="Data did not pass regulatory validation…"
                          style={{ ...inputStyle, marginBottom: 8 }} />
                        <Btn size="sm" variant="danger" onClick={() => simulateFiling("rejected")} disabled={filingBusy}>
                          <IconClose size={12} /> Simulate Rejected
                        </Btn>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginBottom: 20,
                    background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 14px" }}>
                    This filing is {selectedFiling.status.toLowerCase()} — nothing pending to respond to.
                  </div>
                )}

                <h4 style={{ fontFamily: T.head, fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 10 }}>
                  Message Thread
                </h4>
                {filingMsgLoading ? <Spinner size="sm" /> : (
                  <EdiMessageList messages={filingMessages.filter(m => m.correlationId === selectedFiling.id)}
                    emptyText="No messages for this filing yet." />
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default TestToolsPage;
