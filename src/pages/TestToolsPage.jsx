import { useState, useEffect, useCallback } from "react";
import { T } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Spinner from "../components/primitives/Spinner";
import Btn from "../components/primitives/Btn";
import { Modal } from "../components/primitives/Modal";
import EdiMessageList from "../components/shared/EdiMessageList";
import { VesselField, VesselCombobox } from "../components/shared/VesselCombobox";
import CarrierCombobox from "../components/shared/CarrierCombobox";
import PortCombobox from "../components/shared/PortCombobox";
import { IconBaseStation, IconCheck, IconClose, IconAnchor, IconFileCertificate, IconShip, IconLink, IconMail, IconClipboard } from "../components/primitives/Icon";

// ─── Test Tools ────────────────────────────────────────────────────────────────
// Reached both from Integration Board's sidebar and a header shortcut icon (App.jsx).
// Three tools so far:
//  - Message Simulator: emulates a carrier's response to a pending booking request
//    (routes/edi.js's booking-request endpoint no longer fabricates one automatically —
//    see the v0.35.0 changelog) so rejections and other non-happy-path outcomes can
//    actually be exercised without a live carrier account.
//  - Schedule Generator: authors realistic sea schedules — including genuine multi-leg/TSP
//    sailings via the "Configure Legs" modal — from the real Vessels/Ports/Carriers MDM data
//    (instead of mockSailings()'s synthetic "DEMO ALLEGRO" placeholders). A generated schedule
//    is a pure, ownerless catalog "template" (shipment_schedules.shipment_id is nullable) —
//    it's never linked to a shipment directly here; the everyday Add Sailing search
//    (GET /api/schedules/search) checks this catalog first and a shipment picking a match
//    copies it into its own row (template_id records the provenance). The catalog browser
//    below is read-only — "Used by N shipment(s)" reflects real copies, not manual links.
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

const TestToolsPage = ({ navigate }) => {
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
  const [genBusy, setGenBusy] = useState(false);

  const emptyLegRow = () => ({ pol: "", pod: "", etd: "", eta: "", vesselImo: "", vesselName: "", voyageNumber: "", carrier: "", service: "" });
  const [legsModalOpen, setLegsModalOpen] = useState(false);
  const [legRows,       setLegRows]       = useState([]); // [] = direct sailing (no TSP configured)

  const [catalog,        setCatalog]        = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [expandedId,     setExpandedId]     = useState(null);
  const [expandedData,   setExpandedData]   = useState(null);
  const [expandedLoading,setExpandedLoading]= useState(false);

  const loadCatalog = useCallback(() => {
    setCatalogLoading(true);
    return api.scheduleCatalog.list({ source: "generated" })
      .then(setCatalog).catch(() => setCatalog([])).finally(() => setCatalogLoading(false));
  }, []);

  useEffect(() => { if (activeTab === "generator") loadCatalog(); }, [activeTab, loadCatalog]);

  const resetGeneratorForm = () => {
    setVessel(null); setCarrierCode(""); setPol(null); setPod(null);
    setVoyageNumber(""); setService(""); setEtd(""); setAtd(""); setEta(""); setAta("");
    setLegRows([]);
  };

  const openLegsModal = () => {
    setLegRows(prev => prev.length >= 2 ? prev : [
      { ...emptyLegRow(), pol: pol?.unlocode || "", etd, carrier: carrierCode, vesselImo: vessel?.imo || "", vesselName: vessel?.name || "" },
      { ...emptyLegRow(), pod: pod?.unlocode || "", eta, carrier: carrierCode },
    ]);
    setLegsModalOpen(true);
  };

  // The main form's top-level Vessel/Carrier/POL/POD are otherwise the only source generate()
  // reads from — leaving them blank after building a TSP entirely inside the modal made the page
  // look like nothing had happened (even though the legs themselves were fully configured) and,
  // before the validation fix above, actually blocked Generate outright. Mirror leg 1 / leg N
  // back onto the main form on Done so what's configured is visible, not just usable.
  const closeLegsModal = () => {
    if (legRows.length >= 2) {
      const first = legRows[0], last = legRows[legRows.length - 1];
      if (first.pol)      setPol(p => p?.unlocode === first.pol ? p : { unlocode: first.pol, name: "" });
      if (last.pod)       setPod(p => p?.unlocode === last.pod  ? p : { unlocode: last.pod,  name: "" });
      if (first.carrier)  setCarrierCode(first.carrier);
      if (first.vesselImo) setVessel(v => v?.imo === first.vesselImo ? v : { imo: first.vesselImo, name: first.vesselName });
    }
    setLegsModalOpen(false);
  };

  const generate = async () => {
    // A TSP built entirely in the Configure Legs modal (top-level Vessel/Carrier/POL/POD left
    // blank) is fully valid — the backend already derives the schedule's summary from leg 1/leg
    // N (finalCarrier/finalVesselName/finalPol/finalPod in POST /api/schedules). Validation here
    // must check the SAME effective source, not just the top-level fields, or a pure-modal TSP
    // gets wrongly blocked even though everything it needs is already filled in.
    const isTSP = legRows.length >= 2;
    const lastLeg = isTSP ? legRows[legRows.length - 1] : null;
    const effectiveVesselImo = isTSP ? (legRows[0].vesselImo || vessel?.imo) : vessel?.imo;
    const effectiveCarrier   = isTSP ? (legRows[0].carrier   || carrierCode) : carrierCode;
    const effectivePol       = isTSP ? (legRows[0].pol       || pol?.unlocode) : pol?.unlocode;
    const effectivePod       = isTSP ? (lastLeg.pod           || pod?.unlocode) : pod?.unlocode;
    if (!effectiveVesselImo) return toast.error("Pick a vessel");
    if (!effectiveCarrier)   return toast.error("Pick a carrier");
    if (!effectivePol || !effectivePod) return toast.error("Pick POL and POD");
    setGenBusy(true);
    try {
      const created = await api.scheduleCatalog.create({
        carrier: carrierCode, vesselImo: vessel?.imo || "", vesselName: vessel?.name || "",
        voyageNumber, service, pol: pol?.unlocode || "", pod: pod?.unlocode || "", etd, atd, eta, ata,
        legs: isTSP ? legRows : null,
      });
      toast.success(`Schedule ${created.id} created${created.legs ? ` — ${created.legs.length}-leg TSP` : ""}`);
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
    try {
      setExpandedData(await api.scheduleCatalog.usage(schedId));
    } catch { setExpandedData(null); }
    setExpandedLoading(false);
  };

  const deleteTemplate = async (schedId) => {
    try {
      await api.scheduleCatalog.remove(schedId);
      toast.success("Schedule deleted");
      if (expandedId === schedId) { setExpandedId(null); setExpandedData(null); }
      loadCatalog();
    } catch (e) {
      toast.error(e.message || "Failed to delete schedule");
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

  // ─── AIS Simulator state (TKT-ZFO2OM) ──────────────────────────────────────
  // Both inject actions call the exact same ctx.ingestAisMessage the live aisstream.io
  // connection calls (routes/ais.js) — this tab has no logic of its own, it just constructs a
  // realistic envelope so the real resolve/refresh and ATD/ATA detection code paths run.
  const [aisStatus,      setAisStatus]      = useState(null);
  const [openLegs,       setOpenLegs]       = useState([]);
  const [openLegsLoading,setOpenLegsLoading]= useState(true);
  const [selectedLeg,    setSelectedLeg]    = useState(null);
  const [aisBusy,        setAisBusy]        = useState(false);
  const [staticImo,      setStaticImo]      = useState("");
  const [staticMmsi,     setStaticMmsi]     = useState("");
  const [staticName,     setStaticName]     = useState("");

  const loadAisStatus = useCallback(() => api.ais.status().then(setAisStatus).catch(() => setAisStatus(null)), []);
  const loadOpenLegs  = useCallback(() => {
    setOpenLegsLoading(true);
    return api.ais.openLegs().then(setOpenLegs).catch(() => setOpenLegs([])).finally(() => setOpenLegsLoading(false));
  }, []);

  useEffect(() => { loadAisStatus(); loadOpenLegs(); }, [loadAisStatus, loadOpenLegs]);

  const injectStatic = async () => {
    if (!staticImo.trim() || !staticMmsi.trim() || !staticName.trim() || aisBusy) return;
    setAisBusy(true);
    try {
      const res = await api.ais.simulateStatic({ imo: staticImo.trim(), mmsi: staticMmsi.trim(), name: staticName.trim() });
      toast.success(res.vessel ? `Vessel ${res.imo} — ${res.vessel.name}` : "Static data injected");
      loadOpenLegs();
    } catch (e) { toast.error(e.message || "Failed to inject ShipStaticData"); }
    setAisBusy(false);
  };

  const injectPosition = async event => {
    if (!selectedLeg || aisBusy) return;
    setAisBusy(true);
    try {
      const fresh = await api.ais.simulatePosition({ legId: selectedLeg.legId, event });
      const field = event === "departure" ? "etd" : "eta";
      toast.success(`Simulated ${event} — ${field.toUpperCase()} confirmed: ${fresh[field]}`);
      setSelectedLeg(prev => prev ? { ...prev, etd: fresh.etd, eta: fresh.eta, etdSource: fresh.etdSource, etaSource: fresh.etaSource } : prev);
      loadOpenLegs();
    } catch (e) { toast.error(e.message || `Failed to simulate ${event}`); }
    setAisBusy(false);
  };

  // ─── Webhook Simulator state ────────────────────────────────────────────────
  // Same "inject/observe through the real code path" philosophy as the AIS/Filing/Message
  // simulators above, except here the real code path is a genuine outbound HTTP call: this tab's
  // own mock receiver (POST /api/test/webhook-receiver) is a real endpoint, not a stub — pointing
  // an office's Webhook Settings at it and clicking "Send via Webhook" on a real document proves
  // the whole cross-service, cross-network round trip actually works.
  const [webhookReceived, setWebhookReceived] = useState([]);
  const [webhookLoading,  setWebhookLoading]  = useState(true);
  const [verifySecret,    setVerifySecret]    = useState("");
  const [verifiedIdx,     setVerifiedIdx]     = useState({});

  const loadWebhookReceived = useCallback(() => {
    setWebhookLoading(true);
    return api.webhookSimulator.list().then(setWebhookReceived).catch(() => setWebhookReceived([])).finally(() => setWebhookLoading(false));
  }, []);

  // ─── Reminder Sweep (dunning) — manual trigger ────────────────────────────────
  // The real sweep runs on a daily interval at server boot (server.js's runDunningSweep,
  // Story TKT-4TEYT1) — this tab exposes the identical core function as an admin action, same
  // "inject/observe through the real code path" idiom as the other simulators here, since
  // waiting up to 24h to see a real reminder fire during development/testing isn't practical.
  const [dunningRunning, setDunningRunning] = useState(false);
  const [dunningResult,  setDunningResult]  = useState(null); // { sentCount, sent }
  const runDunningNow = async () => {
    setDunningRunning(true);
    try { setDunningResult(await api.reports.sendReminders()); }
    catch (e) { toast.error(e.message); }
    setDunningRunning(false);
  };

  // ─── Report Scheduler — manual trigger ────────────────────────────────────────
  // Same idiom as the Reminder Sweep tab above — server.js's runScheduledReportsSweep
  // (TKT-IXAR9G) otherwise only runs once a day, impractical to wait on during testing.
  const [reportsRunning, setReportsRunning] = useState(false);
  const [reportsResult,  setReportsResult]  = useState(null); // { sentCount, sent }
  const runReportsNow = async () => {
    setReportsRunning(true);
    try { setReportsResult(await api.scheduledReports.sendDue()); }
    catch (e) { toast.error(e.message); }
    setReportsRunning(false);
  };

  useEffect(() => {
    if (activeTab !== "webhook") return;
    loadWebhookReceived();
    const id = setInterval(loadWebhookReceived, 3000);
    return () => clearInterval(id);
  }, [activeTab, loadWebhookReceived]);

  async function hmacSha256Hex(message, secret) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  const verifyOne = async (idx, item) => {
    if (!verifySecret.trim()) return toast.error("Enter the office's signing secret first");
    const expected = "sha256=" + await hmacSha256Hex(JSON.stringify(item.body), verifySecret.trim());
    setVerifiedIdx(p => ({ ...p, [idx]: expected === item.signature }));
  };
  const receiverUrl = `${window.location.origin}/api/test/webhook-receiver`;
  const copyReceiverUrl = () => { navigator.clipboard.writeText(receiverUrl); toast.success("Copied"); };
  const clearReceived = async () => { await api.webhookSimulator.clear(); loadWebhookReceived(); };

  const TABS = [
    { key: "simulator", label: "Message Simulator", icon: IconBaseStation },
    { key: "generator",  label: "Schedule Generator", icon: IconAnchor },
    { key: "filings",    label: "Filing Simulator", icon: IconFileCertificate },
    { key: "ais",        label: "AIS Simulator", icon: IconShip },
    { key: "webhook",    label: "Webhook Simulator", icon: IconLink },
    { key: "dunning",    label: "Reminder Sweep", icon: IconMail },
    { key: "reports",    label: "Report Scheduler", icon: IconClipboard },
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
              Built from the real Vessels/Ports/Carriers registry and stored in the catalog —
              a real shipment's own Add Sailing search finds and copies it in later, no manual
              linking here.
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

              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, marginTop: 4,
                display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                    {legRows.length >= 2
                      ? <span style={{ color: T.warning, fontWeight: 700 }}>{legRows.length}-leg TSP sailing configured</span>
                      : "Direct sailing (no transshipment)"}
                  </div>
                </div>
                <Btn variant="secondary" size="sm" onClick={openLegsModal}>
                  {legRows.length >= 2 ? "Edit Legs" : "Configure Legs (TSP)"}
                </Btn>
              </div>

              <Btn onClick={generate} disabled={genBusy}>
                {genBusy ? "Generating…" : <><IconAnchor size={12} /> Generate</>}
              </Btn>
            </div>
          </div>

          {legsModalOpen && (
            <Modal title="Configure Legs" onClose={closeLegsModal} width={1040}>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.4 }}>
                  One row = direct sailing. Two or more rows makes this a transshipment (TSP)
                  sailing — the first row's origin/carrier/vessel and the last row's destination/
                  arrival become the schedule's own overall summary.
                </div>
                <div style={{ display: "grid",
                  gridTemplateColumns: "75px 75px 110px 115px 115px 1fr 85px 85px 26px",
                  gap: 6, fontFamily: T.body, fontSize: 10, fontWeight: 700, color: T.textMuted,
                  textTransform: "uppercase", letterSpacing: ".05em" }}>
                  <span>POL</span><span>POD</span><span>Carrier</span><span>ETD</span><span>ETA</span>
                  <span>Vessel</span><span>Voyage</span><span>Service</span><span />
                </div>
                {legRows.map((row, i) => (
                  <div key={i} style={{ display: "grid",
                    gridTemplateColumns: "75px 75px 110px 115px 115px 1fr 85px 85px 26px",
                    gap: 6, alignItems: "center" }}>
                    <input value={row.pol} onChange={e => setLegRows(p => p.map((r, ri) => ri === i ? { ...r, pol: e.target.value.toUpperCase() } : r))}
                      placeholder="UNLOCODE" style={{ ...inputStyle, fontFamily: T.mono, fontSize: 11.5, padding: "5px 8px" }} />
                    <input value={row.pod} onChange={e => setLegRows(p => p.map((r, ri) => ri === i ? { ...r, pod: e.target.value.toUpperCase() } : r))}
                      placeholder="UNLOCODE" style={{ ...inputStyle, fontFamily: T.mono, fontSize: 11.5, padding: "5px 8px" }} />
                    <CarrierCombobox value={row.carrier} onChange={v => setLegRows(p => p.map((r, ri) => ri === i ? { ...r, carrier: v } : r))} />
                    <input type="date" value={row.etd} onChange={e => setLegRows(p => p.map((r, ri) => ri === i ? { ...r, etd: e.target.value } : r))}
                      style={{ ...inputStyle, fontSize: 11.5, padding: "5px 8px" }} />
                    <input type="date" value={row.eta} onChange={e => setLegRows(p => p.map((r, ri) => ri === i ? { ...r, eta: e.target.value } : r))}
                      style={{ ...inputStyle, fontSize: 11.5, padding: "5px 8px" }} />
                    {row.vesselImo ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 5, background: T.bg,
                        border: `1px solid ${T.accent}55`, borderRadius: 6, padding: "5px 7px", minWidth: 0 }}>
                        <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, flexShrink: 0 }}>{row.vesselImo}</span>
                        <span style={{ fontFamily: T.body, fontSize: 11.5, color: T.text, flex: 1,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.vesselName}</span>
                        <button onClick={() => setLegRows(p => p.map((r, ri) => ri === i ? { ...r, vesselImo: "", vesselName: "" } : r))}
                          style={{ background: "none", border: "none", cursor: "pointer", color: T.textMuted,
                            fontSize: 12, padding: 0, flexShrink: 0 }}>✕</button>
                      </div>
                    ) : (
                      <VesselCombobox placeholder="Search vessel…"
                        onSelect={v => setLegRows(p => p.map((r, ri) => ri === i ? { ...r, vesselImo: v.imo, vesselName: v.name } : r))} />
                    )}
                    <input value={row.voyageNumber} onChange={e => setLegRows(p => p.map((r, ri) => ri === i ? { ...r, voyageNumber: e.target.value } : r))}
                      placeholder="Voyage" style={{ ...inputStyle, fontSize: 11.5, padding: "5px 8px" }} />
                    <input value={row.service} onChange={e => setLegRows(p => p.map((r, ri) => ri === i ? { ...r, service: e.target.value } : r))}
                      placeholder="Loop" style={{ ...inputStyle, fontSize: 11.5, padding: "5px 8px" }} />
                    <button onClick={() => setLegRows(p => p.filter((_, ri) => ri !== i))}
                      title="Remove leg" style={{ background: "none", border: "none", cursor: "pointer",
                        color: T.textMuted, fontSize: 14 }}>✕</button>
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <Btn variant="secondary" size="sm" onClick={() => setLegRows(p => [...p, emptyLegRow()])}>
                    + Add Leg
                  </Btn>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn variant="secondary" size="sm" onClick={() => { setLegRows([]); setLegsModalOpen(false); }}>
                      Clear (direct sailing)
                    </Btn>
                    <Btn size="sm" onClick={closeLegsModal}>Done</Btn>
                  </div>
                </div>
              </div>
            </Modal>
          )}

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
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <button onClick={() => openExpanded(s.id)}
                        style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                          flex: 1, minWidth: 0, background: "none", border: "none", cursor: "pointer",
                          padding: "10px 14px", textAlign: "left" }}>
                        <div>
                          <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                            {s.carrier} · {s.vesselName} {s.vesselImo && `(IMO ${s.vesselImo})`}
                            {s.legs && <span style={{ marginLeft: 6, fontFamily: T.body, fontSize: 10, fontWeight: 700,
                              color: T.warning, background: T.warning + "18", borderRadius: 4, padding: "1px 6px",
                              textTransform: "uppercase" }}>TSP · {s.legs.length} legs</span>}
                          </div>
                          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, marginTop: 2 }}>
                            {s.pol} → {s.pod} · ETD {s.etd || "—"}
                          </div>
                        </div>
                        <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.accent,
                          background: `${T.accent}18`, borderRadius: 12, padding: "3px 10px", flexShrink: 0 }}>
                          Used by {s.usedByCount} shipment{s.usedByCount !== 1 ? "s" : ""}
                        </span>
                      </button>
                      <button onClick={() => deleteTemplate(s.id)} title="Delete schedule"
                        style={{ background: "none", border: "none", cursor: "pointer",
                          color: T.textMuted, fontSize: 14, padding: "0 14px 0 4px", flexShrink: 0 }}>✕</button>
                    </div>
                    {expandedId === s.id && (
                      <div style={{ borderTop: `1px solid ${T.border}`, padding: "10px 14px" }}>
                        {s.legs && (
                          <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap",
                            marginBottom: 10, fontFamily: T.mono, fontSize: 11 }}>
                            {s.legs.map((leg, li) => (
                              <span key={li} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                                <span style={{ color: T.text, fontWeight: 700 }}>{leg.pol}</span>
                                <span style={{ color: T.textMuted }}>→</span>
                                {li === s.legs.length - 1 && <span style={{ color: T.text, fontWeight: 700 }}>{leg.pod}</span>}
                                {li < s.legs.length - 1 && (
                                  <span style={{ color: T.warning, fontWeight: 700, background: T.warning + "18",
                                    borderRadius: 3, padding: "0 5px" }}>{leg.pod} →</span>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                        {expandedLoading ? <Spinner size="sm" /> : expandedData && (
                          expandedData.usedBy.length === 0 ? (
                            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic" }}>
                              No shipment has picked this schedule yet.
                            </div>
                          ) : (
                            <>
                              <div style={{ display: "grid",
                                gridTemplateColumns: "110px 130px 90px 110px 50px 90px",
                                gap: 8, fontFamily: T.mono, fontSize: 10.5, color: T.textMuted,
                                fontWeight: 700, textTransform: "uppercase", marginBottom: 6 }}>
                                <span>Shipment</span><span>POL → POD</span><span>ETD</span>
                                <span>Contract</span><span>TEU</span><span>Status</span>
                              </div>
                              {expandedData.usedBy.map((sh, i) => (
                                <div key={sh.id} style={{ display: "grid",
                                  gridTemplateColumns: "110px 130px 90px 110px 50px 90px",
                                  gap: 8, alignItems: "center", padding: "5px 0",
                                  borderTop: i > 0 ? `1px solid ${T.border}22` : "none" }}>
                                  <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.accent, fontWeight: 700 }}>{sh.id}</span>
                                  <span style={{ fontFamily: T.mono, fontSize: 11 }}>{sh.pol} → {sh.pod}</span>
                                  <span style={{ fontFamily: T.mono, fontSize: 11 }}>{sh.etd || "—"}</span>
                                  <span style={{ fontFamily: T.body, fontSize: 11 }}>{sh.contractType || "—"}</span>
                                  <span style={{ fontFamily: T.mono, fontSize: 11 }}>{sh.teu}</span>
                                  <span style={{ fontFamily: T.body, fontSize: 11 }}>{sh.status}</span>
                                </div>
                              ))}
                            </>
                          )
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

      {activeTab === "ais" && (
        <div style={{ display: "flex", gap: 24, height: "100%" }}>
          {/* Left: connection status + open legs eligible for ETD/ETA confirmation */}
          <div style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column" }}>
            <h2 style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 14px" }}>
              AIS Simulator
            </h2>
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
              padding: "10px 12px", marginBottom: 16, fontFamily: T.mono, fontSize: 11.5, color: T.textMuted }}>
              {aisStatus ? (
                <>
                  <span style={{ color: aisStatus.connected ? T.success : T.textMuted }}>
                    ● {aisStatus.connected ? "Live connection open" : "Not connected"}
                  </span>
                  {" · "}{aisStatus.trackedVesselCount} vessel(s) tracked
                </>
              ) : "Loading status…"}
              <div style={{ marginTop: 2, fontSize: 10.5, color: T.border }}>
                The simulators below work regardless of a live connection — they inject
                straight into the same handler a real message would.
              </div>
            </div>

            <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>
              Open legs (SEA, vessel set, ETD or ETA not yet confirmed)
            </div>
            {openLegsLoading ? <Spinner size="sm" /> : openLegs.length === 0 ? (
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
                No shipments currently eligible for AIS matching.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
                {openLegs.map(l => {
                  const active = selectedLeg?.legId === l.legId;
                  return (
                    <button key={l.legId} onClick={() => setSelectedLeg(l)}
                      style={{ textAlign: "left", background: active ? T.accentBg : T.surface,
                        border: `1px solid ${active ? T.accent : T.border}`, borderRadius: 8,
                        padding: "10px 12px", cursor: "pointer" }}>
                      <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 3 }}>
                        {l.shipmentId}
                      </div>
                      <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
                        {l.pol} → {l.pod} · {l.vessel || l.vesselImo}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right: two injectors */}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 20 }}>
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
                textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 12 }}>
                Simulate ShipStaticData — resolve or rename a vessel
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <label style={label}>IMO</label>
                  <input value={staticImo} onChange={e => setStaticImo(e.target.value)} placeholder="9222568" style={{ ...inputStyle, fontFamily: T.mono }} />
                </div>
                <div style={{ flex: 1, minWidth: 120 }}>
                  <label style={label}>MMSI</label>
                  <input value={staticMmsi} onChange={e => setStaticMmsi(e.target.value)} placeholder="245473000" style={{ ...inputStyle, fontFamily: T.mono }} />
                </div>
                <div style={{ flex: 2, minWidth: 180 }}>
                  <label style={label}>Ship Name</label>
                  <input value={staticName} onChange={e => setStaticName(e.target.value)} placeholder="EVER GIVEN" style={inputStyle} />
                </div>
              </div>
              <Btn size="sm" onClick={injectStatic} disabled={aisBusy} style={{ marginTop: 12 }}>
                <IconShip size={12} /> Inject ShipStaticData
              </Btn>
            </div>

            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 20px" }}>
              <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
                textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 12 }}>
                Simulate PositionReport — confirm ETD/ETA in place
              </div>
              {!selectedLeg ? (
                <div style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, fontStyle: "italic" }}>
                  Pick an open leg on the left first.
                </div>
              ) : (
                <>
                  <div style={{ fontFamily: T.mono, fontSize: 12, color: T.text, marginBottom: 4 }}>
                    {selectedLeg.shipmentId} — {selectedLeg.pol} → {selectedLeg.pod}
                  </div>
                  <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted, marginBottom: 12 }}>
                    Vessel IMO {selectedLeg.vesselImo} must already have a known MMSI —
                    inject a ShipStaticData message for it above first if "no known MMSI" is returned.
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <Btn size="sm" onClick={() => injectPosition("departure")} disabled={aisBusy || selectedLeg.etdSource === "ais"}>
                      <IconCheck size={12} /> Simulate Departure
                    </Btn>
                    <Btn size="sm" variant="secondary" onClick={() => injectPosition("arrival")} disabled={aisBusy || selectedLeg.etaSource === "ais"}>
                      <IconCheck size={12} /> Simulate Arrival
                    </Btn>
                  </div>
                  {(selectedLeg.etdSource === "ais" || selectedLeg.etaSource === "ais") && (
                    <div style={{ marginTop: 10, fontFamily: T.mono, fontSize: 11.5, color: T.success }}>
                      {selectedLeg.etdSource === "ais" && `ETD confirmed: ${selectedLeg.etd}`}
                      {selectedLeg.etdSource === "ais" && selectedLeg.etaSource === "ais" ? " · " : ""}
                      {selectedLeg.etaSource === "ais" && `ETA confirmed: ${selectedLeg.eta}`}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === "webhook" && (
        <div style={{ display: "flex", gap: 24, height: "100%" }}>
          <div style={{ width: 340, flexShrink: 0, display: "flex", flexDirection: "column" }}>
            <h2 style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 14px" }}>
              Webhook Simulator
            </h2>
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
              padding: "10px 12px", marginBottom: 16, fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
              Point an office's Webhook URL (Organization → Offices → Webhook Settings) at the
              address below to test end-to-end delivery without a real external endpoint.
            </div>
            <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>
              Mock Receiver URL
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <div style={{ flex: 1, fontFamily: T.mono, fontSize: 11.5, color: T.text,
                background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 9px",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {receiverUrl}
              </div>
              <Btn size="sm" variant="secondary" onClick={copyReceiverUrl}>Copy</Btn>
            </div>
            <div>
              <label style={label}>Verify signature with secret</label>
              <input value={verifySecret} onChange={e => setVerifySecret(e.target.value)}
                placeholder="the office's configured signing secret" style={inputStyle} />
            </div>
            <Btn size="sm" variant="secondary" onClick={clearReceived} style={{ marginTop: 12, alignSelf: "flex-start" }}>
              Clear received
            </Btn>
          </div>

          <div style={{ flex: 1, overflowY: "auto" }}>
            <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 600, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>
              Received Payloads (last 20)
            </div>
            {webhookLoading ? <Spinner size="sm" /> : webhookReceived.length === 0 ? (
              <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
                Nothing received yet — point a webhook here and click "Send via Webhook" on a
                real document.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {webhookReceived.map((item, idx) => (
                  <div key={idx} style={{ background: T.surface, border: `1px solid ${T.border}`,
                    borderRadius: 10, padding: "12px 16px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>{item.receivedAt}</span>
                      <span style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.accent }}>{item.body?.event}</span>
                      <Btn size="sm" variant="secondary" onClick={() => verifyOne(idx, item)} style={{ marginLeft: "auto" }}>
                        Verify signature
                      </Btn>
                      {verifiedIdx[idx] === true && (
                        <span style={{ fontFamily: T.body, fontSize: 11, color: T.success, fontWeight: 700 }}><IconCheck size={11} /> Valid</span>
                      )}
                      {verifiedIdx[idx] === false && (
                        <span style={{ fontFamily: T.body, fontSize: 11, color: T.danger, fontWeight: 700 }}><IconClose size={11} /> Mismatch</span>
                      )}
                    </div>
                    <pre style={{ fontFamily: T.mono, fontSize: 11, color: T.text, background: T.bg,
                      border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px",
                      margin: 0, overflowX: "auto" }}>{JSON.stringify(item.body, null, 2)}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === "dunning" && (
        <div style={{ maxWidth: 640 }}>
          <h2 style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 14px" }}>
            Reminder Sweep
          </h2>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
            padding: "10px 12px", marginBottom: 16, fontFamily: T.body, fontSize: 11.5, color: T.textMuted, lineHeight: 1.6 }}>
            Sends overdue-payment reminder emails right now for every confirmed, unpaid, overdue
            invoice belonging to a customer with reminders enabled (Master Data → Customers →
            Billing) — the same real sweep that otherwise only runs once a day. Each customer's
            own cadence is respected: one already reminded within its own configured interval is
            skipped, not re-sent.
          </div>
          <Btn onClick={runDunningNow} disabled={dunningRunning}>
            {dunningRunning ? "Sending…" : "Send Reminders Now"}
          </Btn>

          {dunningResult && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 10 }}>
                {dunningResult.sentCount} reminder{dunningResult.sentCount === 1 ? "" : "s"} sent
              </div>
              {dunningResult.sentCount === 0 ? (
                <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
                  Nothing due — no reminder-enabled customer has a confirmed, unpaid, overdue
                  invoice past its own cadence right now.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {dunningResult.sent.map(s => (
                    <div key={s.docId} style={{ background: T.surface, border: `1px solid ${T.border}`,
                      borderRadius: 8, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>{s.shipmentId}</span>
                        <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginLeft: 8 }}>{s.companyName}</span>
                      </div>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.warning }}>
                        ${Number(s.outstandingUsd).toFixed(2)} · {s.daysOverdue}d overdue
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {activeTab === "reports" && (
        <div style={{ maxWidth: 640 }}>
          <h2 style={{ fontFamily: T.head, fontSize: 16, fontWeight: 800, color: T.text, margin: "0 0 14px" }}>
            Report Scheduler
          </h2>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
            padding: "10px 12px", marginBottom: 16, fontFamily: T.body, fontSize: 11.5, color: T.textMuted, lineHeight: 1.6 }}>
            Generates and sends every scheduled report that's currently due (Reports → Scheduled
            Reports) right now — the same real sweep that otherwise only runs once a day. A
            schedule not yet due (per its own frequency and last run) is skipped, not re-sent.
          </div>
          <Btn onClick={runReportsNow} disabled={reportsRunning}>
            {reportsRunning ? "Sending…" : "Send Due Reports Now"}
          </Btn>

          {reportsResult && (
            <div style={{ marginTop: 20 }}>
              <div style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text, marginBottom: 10 }}>
                {reportsResult.sentCount} report{reportsResult.sentCount === 1 ? "" : "s"} sent
              </div>
              {reportsResult.sentCount === 0 ? (
                <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, fontStyle: "italic" }}>
                  Nothing due right now — no active schedule has passed its own frequency window.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {reportsResult.sent.map(s => (
                    <div key={s.id} style={{ background: T.surface, border: `1px solid ${T.border}`,
                      borderRadius: 8, padding: "8px 12px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>{s.filename}</span>
                      </div>
                      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted }}>
                        {s.recipients.join(", ")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TestToolsPage;
