import { useState, useEffect } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import { useAuth } from "../../AuthContext";
import Btn from "../../components/primitives/Btn";
import Spinner from "../../components/primitives/Spinner";
import DatePicker from "../../components/primitives/DatePicker";
import { Textarea } from "../../components/primitives/Form";
import EdiMessageList from "../../components/shared/EdiMessageList";
import GenerateDocumentModal from "../../components/shared/GenerateDocumentModal";
import MasterBlPanel from "../../components/shared/MasterBlPanel";
import { IconFileCertificate, IconRefresh, IconWarning } from "../../components/primitives/Icon";
import { canEditShipmentSide } from "../../utils/officeSide";
import { HZ, HZ_MONO, HZ_BODY, HZ_DISPLAY, useHorizonFonts } from "./shipmentDetailTheme";

// ─── Shipping Instructions ──────────────────────────────────────────────────────
// 2026-09 FCL export gap analysis, finding #1 — the shipper/forwarder's own submission of
// final B/L data to the carrier ahead of the SI cutoff. Previously si_submitted was only ever
// a side effect of every container's VGM reaching Submitted (TKT-OZD4V8, a real but indirect
// heuristic) — this is the real thing, one per shipment, so a single page suffices (unlike
// Carrier Booking/Customs Filing's Details+Review split, which exists because those can have
// 1-2 independent records to compose *and* review). Sent to the carrier as DCSA Shipping
// Instructions 3.0 since 2026-10-27; the carrier accepts them by drafting its Master B/L from them,
// shown and approved here (MasterBlPanel, DCSA phase 4, mockup VUTPKnRAjdPjfb8DntUxVs). While the
// carrier holds them they can be sent again as an update, or cancelled (or just a pending update).
//
// Trade Horizon "New Style" pass — a single-record page (one SI per shipment), so this is a
// straight token migration (T → HZ) in its existing card shape rather than the stat-strip+table
// treatment (that fits a real list, which this isn't). EdiMessageList/GenerateDocumentModal stay
// untouched — both are genuinely shared with non-shipment-detail pages (TestToolsPage.jsx, MDM
// Document Templates), same reasoning as leaving Btn/Modal/Badge alone.

const STATUS_COLOR = { Draft: "", Submitted: "cyan", Confirmed: "good", Rejected: "crit", Cancelled: "" };
// The carrier's DCSA state of them, in words.
const CARRIER_STATE = { RECEIVED: "Received", PENDING_UPDATE: "Asked for an update", COMPLETED: "Completed", DECLINED: "Declined", CANCELLED: "Cancelled" };
const UPDATE_STATE = { UPDATE_RECEIVED: "update received", UPDATE_CONFIRMED: "update worked in", UPDATE_DECLINED: "update declined", UPDATE_CANCELLED: "update cancelled" };

const ShipmentShippingInstructionsPage = ({ shipment, containers = [] }) => {
  const auth = useAuth();
  // Shipping Instructions is export-edit per the Office-Side Permissions Epic (TKT-Z0LB0W) — not
  // in Phase 3's own file list, added anyway: it was gated export-edit in Phase 2 (routes/
  // shipping-instructions.js), so leaving this page unchanged would have left an import user
  // clicking Save and hitting a raw 403 instead of a disabled control.
  const canEdit = canEditShipmentSide(auth, shipment, "export");
  const [si,       setSi]       = useState(undefined); // undefined = loading, null = none yet
  const [messages, setMessages] = useState([]);
  const [cutoff,   setCutoff]   = useState("");
  const [notes,    setNotes]    = useState("");
  const [busy,     setBusy]     = useState(false);
  const [genDocOpen, setGenDocOpen] = useState(false);
  const [masterBl, setMasterBl] = useState(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const shipmentContainers = containers.filter(c => c.shipmentId === shipment.id);

  const load = () => Promise.all([
    api.shippingInstructions.get(shipment.id),
    api.ediMessages.list(shipment.id),
    api.masterBl.get(shipment.id).catch(() => null),
  ]).then(([row, m, mbl]) => {
    setSi(row);
    setMessages(m);
    setMasterBl(mbl);
    setCutoff(row?.siCutoff || "");
    setNotes(row?.specialInstructions || "");
    setRefreshKey(k => k + 1);
  }).catch(() => { setSi(null); setMessages([]); });

  useEffect(() => { load(); }, [shipment.id]);

  // The instructions' own messages and the carrier's Master B/L notifications.
  const thread = si ? messages.filter(m => m.correlationId === si.id || (masterBl && m.correlationId === masterBl.id)) : [];
  // The House B/Ls the last instructions sent carried (gap G25).
  const lastSent = messages.find(m => m.correlationId === si?.id && m.direction === "out" && /^shipping_instructions_(submission|update)$/.test(m.messageType));
  const houseBls = (() => { try { return (JSON.parse(lastSent?.rawPayload || "{}").houseBillOfLadings || []).map(h => h.houseBillOfLadingReference); } catch { return []; } })();
  // Once the carrier has issued its Master B/L the instructions can't change any more.
  const masterLocked = !!masterBl && !["DRAFT", "APPROVED", "VOIDED"].includes(masterBl.status);
  const carrierHolds = si?.carrierState === "RECEIVED" && !masterLocked;
  const updatePending = si?.carrierUpdatedState === "UPDATE_RECEIVED";
  const status = si?.status || "Draft";
  const isDraft = status === "Draft";
  // Soft, non-blocking awareness (not a Submit gate) — nothing stops a submission with these
  // blank; the SI01 document just renders "—" for them until they're filled in. Not every
  // carrier needs all three at SI time, so this stays a nudge, same class of warning as
  // ShipmentCustomsFilingDetailsPage.jsx's own Pickup-not-ready notice.
  const incompleteContainers = shipmentContainers.filter(c => !c.sealNumber || !c.marksAndNumbers || !c.cargoDescription);

  const handleSaveDraft = async () => {
    setBusy(true);
    try {
      await api.shippingInstructions.save(shipment.id, { siCutoff: cutoff, specialInstructions: notes });
      toast.success("Draft saved");
      await load();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  const handleSubmit = async () => {
    setBusy(true);
    try {
      await api.shippingInstructions.submit(shipment.id);
      toast.success("Shipping Instructions submitted");
      await load();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  const handleSendUpdate = async () => {
    setBusy(true);
    try {
      await api.shippingInstructions.sendUpdate(shipment.id);
      toast.success(`Update sent to ${shipment.carrierCode || "the carrier"}`);
      await load();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  const handleCancel = async (update = false) => {
    setBusy(true);
    try {
      await api.shippingInstructions.cancel(shipment.id, update);
      toast.success(update ? "Update cancelled: the instructions stand as they were" : "Shipping Instructions cancelled at the carrier");
      setConfirmCancel(false);
      await load();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  const handleReset = async () => {
    setBusy(true);
    try {
      await api.shippingInstructions.reset(shipment.id);
      toast.success("Reset to Draft");
      await load();
    } catch (e) { toast.error(e.message); }
    setBusy(false);
  };

  useHorizonFonts();

  if (si === undefined) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: HZ.textMuted,
        fontFamily: HZ_BODY, fontSize: 13, padding: "30px 0", justifyContent: "center" }}>
        <Spinner size="sm" /> Loading Shipping Instructions…
      </div>
    );
  }

  return (
    <div id="shpsi-page" style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 18 }}>
      {genDocOpen && (
        <GenerateDocumentModal shipment={shipment} defaultCode="SI01"
          onClose={() => setGenDocOpen(false)} onSaved={() => setGenDocOpen(false)} />
      )}

      <div style={{ background: HZ.surface, backdropFilter: "blur(20px)", border: `1px solid ${HZ.border}`,
        boxShadow: HZ.cardShadow, borderRadius: 10, padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <h3 style={{ fontFamily: HZ_DISPLAY, fontSize: 14, fontWeight: 700, color: HZ.text, margin: 0,
            display: "flex", alignItems: "center", gap: 6 }}>
            <IconFileCertificate size={14} /> Shipping Instructions
          </h3>
          <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700,
            color: STATUS_COLOR[status] ? HZ[STATUS_COLOR[status]] : HZ.textMuted, textTransform: "uppercase" }}>
            {status}
          </span>
        </div>
        <div style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.textMuted }}>
          The final B/L data (parties, container/seal list, marks &amp; numbers, cargo description) sent to
          {" "}{shipment.carrierCode || "the carrier"} as DCSA Shipping Instructions 3.0 ahead of the SI cutoff. The carrier accepts them by
          drafting its Master B/L from them.
        </div>
      </div>

      {isDraft && (
        <div style={{ background: HZ.surface, backdropFilter: "blur(20px)", border: `1px solid ${HZ.border}`,
          boxShadow: HZ.cardShadow, borderRadius: 10, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 14, alignItems: "start" }}>
            <div>
              <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginBottom: 4 }}>SI Cutoff</div>
              <DatePicker id="shpsi-cutoff" value={cutoff} disabled={!canEdit} onChange={setCutoff} placeholder="Not set" withTime />
            </div>
            <div>
              <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginBottom: 4 }}>Special Instructions</div>
              <Textarea id="shpsi-notes" value={notes} onChange={setNotes} disabled={!canEdit} rows={3}
                placeholder="Anything the carrier needs beyond the standard B/L data…" />
            </div>
          </div>
          {incompleteContainers.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 10px",
              borderRadius: 6, background: HZ.warnBg, border: `1px solid ${HZ.warn}33` }}>
              <span style={{ color: HZ.warn, flexShrink: 0, marginTop: 1 }}><IconWarning size={12} /></span>
              <span style={{ fontFamily: HZ_BODY, fontSize: 11.5, color: HZ.text, lineHeight: 1.5 }}>
                {incompleteContainers.length} of {shipmentContainers.length} container{shipmentContainers.length !== 1 ? "s" : ""} {incompleteContainers.length !== 1 ? "are" : "is"} missing
                a seal number, marks &amp; numbers, or cargo description — the Shipping Instructions document will show blanks
                for those fields until they're filled in on the Cargo page. You can still submit.
              </span>
            </div>
          )}
          {canEdit && (
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Btn id="shpsi-save-draft-btn" variant="secondary" size="sm" disabled={busy} onClick={handleSaveDraft}>
                {busy ? "Saving…" : "Save Draft"}
              </Btn>
              <Btn id="shpsi-submit-btn" size="sm" disabled={busy} onClick={handleSubmit}>
                {busy ? "Submitting…" : "Submit →"}
              </Btn>
            </div>
          )}
        </div>
      )}

      {!isDraft && (
        <div style={{ background: HZ.surface, backdropFilter: "blur(20px)", border: `1px solid ${HZ.border}`,
          boxShadow: HZ.cardShadow, borderRadius: 10, padding: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>Carrier reference</span>
            <span style={{ fontFamily: HZ_MONO, fontSize: 11, color: HZ.text }}>{si.siReference || "—"}</span>
          </div>
          {si.carrierState && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>At the carrier</span>
              <span id="shpsi-carrier-state" style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.text }}>
                {CARRIER_STATE[si.carrierState] || si.carrierState}
                {masterBl && si.carrierState === "RECEIVED" && masterBl.status !== "VOIDED" ? " · drafted the Master B/L" : ""}
                {si.carrierUpdatedState ? ` · ${UPDATE_STATE[si.carrierUpdatedState] || si.carrierUpdatedState}` : ""}
                {si.isMock ? " · demo carrier" : ""}
              </span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>House B/Ls included</span>
            <span id="shpsi-house-bls" style={{ fontFamily: HZ_MONO, fontSize: 11, color: HZ.text }}>{houseBls.length ? houseBls.join(", ") : "None"}</span>
          </div>
          {masterBl && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>Master B/L</span>
              <span style={{ fontFamily: HZ_MONO, fontSize: 11, color: HZ.text }}>{masterBl.reference} · {masterBl.status.toLowerCase().replace(/_/g, " ")}</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>Submitted</span>
            <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.text }}>
              {si.submittedAt ? new Date(si.submittedAt).toLocaleString() : "—"}
            </span>
          </div>
          {si.siCutoff && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>SI Cutoff</span>
              <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.text }}>{new Date(si.siCutoff).toLocaleString()}</span>
            </div>
          )}
          {(status === "Rejected" || si.rejectionReason) && (
            <div>
              <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginBottom: 3 }}>{status === "Rejected" ? "The carrier's reason" : "The carrier said"}</div>
              <div id="shpsi-rejection" style={{ fontFamily: HZ_BODY, fontSize: 12, color: status === "Rejected" ? HZ.crit : HZ.text }}>{si.rejectionReason}</div>
            </div>
          )}
          {masterLocked && (
            <div id="shpsi-locked" style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted, padding: "8px 10px", borderRadius: 6, background: HZ.surface2 }}>
              {shipment.carrierCode || "The carrier"} has issued the Master B/L: these instructions can't be updated or cancelled any more.
            </div>
          )}
          {confirmCancel && (
            <div id="shpsi-cancel-confirm" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8,
              background: HZ.critBg, border: `1px solid ${HZ.crit}55`, fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.text }}>
              <span style={{ flex: "1 1 320px" }}>
                Cancel {si.siReference} at {shipment.carrierCode || "the carrier"}?{masterBl && masterBl.status !== "VOIDED" ? " The carrier voids its draft Master B/L." : ""} You can reset and send new instructions afterwards.
              </span>
              <Btn id="shpsi-cancel-keep" size="sm" variant="secondary" disabled={busy} onClick={() => setConfirmCancel(false)}>Keep them</Btn>
              <Btn id="shpsi-cancel-confirm-btn" size="sm" variant="danger" disabled={busy} onClick={() => handleCancel(false)}>{busy ? "Cancelling…" : `Cancel at ${shipment.carrierCode || "the carrier"}`}</Btn>
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            {canEdit && carrierHolds && !updatePending && (status === "Submitted" || status === "Confirmed") && (
              <Btn id="shpsi-send-update-btn" size="sm" variant="secondary" disabled={busy} onClick={handleSendUpdate}>
                {busy ? "Sending…" : "Send update"}
              </Btn>
            )}
            {canEdit && updatePending && (
              <Btn id="shpsi-cancel-update-btn" size="sm" variant="secondary" disabled={busy} onClick={() => handleCancel(true)}>Cancel the update</Btn>
            )}
            {canEdit && !masterLocked && ["RECEIVED", "PENDING_UPDATE"].includes(si.carrierState) && !confirmCancel && (
              <Btn id="shpsi-cancel-btn" size="sm" variant="danger" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel instructions</Btn>
            )}
            {(status === "Rejected" || status === "Cancelled") && canEdit && (
              <Btn id="shpsi-reset-btn" size="sm" variant="secondary" disabled={busy} onClick={handleReset}>
                <IconRefresh size={12} /> {busy ? "Resetting…" : "Reset to Draft"}
              </Btn>
            )}
            {(status === "Submitted" || status === "Confirmed") && canEdit && (
              <Btn id="shpsi-generate-btn" size="sm" variant="secondary" onClick={() => setGenDocOpen(true)}>
                <IconFileCertificate size={12} /> Generate Document
              </Btn>
            )}
          </div>
        </div>
      )}

      {masterBl && <MasterBlPanel shipment={shipment} canEdit={canEdit} refreshKey={refreshKey} onChanged={load} />}

      <div style={{ background: HZ.surface, backdropFilter: "blur(20px)", border: `1px solid ${HZ.border}`,
        boxShadow: HZ.cardShadow, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${HZ.border}`,
          fontFamily: HZ_DISPLAY, fontSize: 14, fontWeight: 800, color: HZ.text }}>
          Container / Seal Detail
        </div>
        {shipmentContainers.length === 0 ? (
          <div style={{ padding: "20px 0", textAlign: "center", fontFamily: HZ_BODY, fontSize: 12.5, color: HZ.textMuted }}>
            No containers on this shipment yet — add containers from the Cargo page first.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: HZ.bg, borderBottom: `1px solid ${HZ.border}` }}>
                  {["Container #", "Seal #", "Type", "Marks & Numbers", "Cargo Description"].map(h => (
                    <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontFamily: HZ_BODY,
                      fontSize: 10.5, fontWeight: 700, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shipmentContainers.map(c => (
                  <tr key={c.id} style={{ borderBottom: `1px solid ${HZ.border}` }}>
                    <td style={{ padding: "8px 10px", fontFamily: HZ_MONO, fontWeight: 700, color: HZ.cyan, fontSize: 12.5 }}>
                      {c.containerNumber || "TBC"}
                    </td>
                    <td style={{ padding: "8px 10px", fontFamily: HZ_MONO, fontSize: 12, color: c.sealNumber ? HZ.text : HZ.warn }}>{c.sealNumber || "—"}</td>
                    <td style={{ padding: "8px 10px", fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted }}>{c.size}ft {c.type}</td>
                    <td style={{ padding: "8px 10px", fontFamily: HZ_BODY, fontSize: 12, color: c.marksAndNumbers ? HZ.text : HZ.warn }}>{c.marksAndNumbers || "—"}</td>
                    <td style={{ padding: "8px 10px", fontFamily: HZ_BODY, fontSize: 12, color: c.cargoDescription ? HZ.text : HZ.warn }}>{c.cargoDescription || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div style={{ fontFamily: HZ_BODY, fontSize: 10.5, color: HZ.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>Message Thread</div>
        <EdiMessageList messages={thread} emptyText="Not submitted yet." />
      </div>
    </div>
  );
};

export default ShipmentShippingInstructionsPage;
