import { useState, useEffect } from "react";
import { T, worstState, CUTOFF_STATE_VARIANT, COMPLIANCE_STATE_LABEL } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import DatePicker from "../../components/primitives/DatePicker";
import { Textarea, inputBase } from "../../components/primitives/Form";
import { IconFolder } from "../../components/primitives/Icon";
import EdiMessageList from "../../components/shared/EdiMessageList";

// ─── VGM Export Service page ────────────────────────────────────────────────
// VGM's real compliance data (vgmWeightKg/vgmStatus/vgmCutoff) lives directly on
// `containers` — moved out of ContainerForm's Cargo-page "Compliance & Cutoffs"
// section into this dedicated per-container workspace, reached from the "VGM" row
// under Export Services once that service has actually been ordered. Unlike
// LoadingServicePage's per-container data, there's no satellite table here — saves
// go through the same PUT /api/containers/:id route ContainerForm always used, so
// every write below sends the container's own complete current record with only
// the touched VGM field overridden (that route is a full-row replace, not a merge —
// a bare partial patch would silently null out every other field on the container).

const VgmRow = ({ container, canEdit, saving, onSave }) => {
  const [weight, setWeight] = useState(container.vgmWeightKg != null ? String(container.vgmWeightKg) : "");
  const [status, setStatus] = useState(container.vgmStatus || "Pending");
  const [cutoff, setCutoff] = useState(container.vgmCutoff || "");
  const [method, setMethod] = useState(container.vgmMethod || "");

  // Resyncs on the saved values themselves (not just container identity) — a save
  // round-trips async, so without this a corrected value could keep showing the
  // user's original, now-stale entry after it actually persisted. Safe against
  // fighting active typing since these props only change once a save completes.
  useEffect(() => {
    setWeight(container.vgmWeightKg != null ? String(container.vgmWeightKg) : "");
    setStatus(container.vgmStatus || "Pending");
    setCutoff(container.vgmCutoff || "");
    setMethod(container.vgmMethod || "");
  }, [container.id, container.vgmWeightKg, container.vgmStatus, container.vgmCutoff, container.vgmMethod]);

  const commitWeight = () => {
    const parsed = weight.trim() === "" ? null : parseFloat(weight);
    onSave({ vgmWeightKg: (parsed != null && !Number.isNaN(parsed)) ? parsed : null });
  };

  // SOLAS VI/2 requires a declared method (Method 1: weighing the packed container;
  // Method 2: certified sum of cargo/dunnage weight + tare) — the server rejects a
  // Submitted transition with no method set, so block it here too rather than let the
  // user hit a save error with no context.
  const handleStatusChange = next => {
    if (next === "Submitted" && !method) {
      toast.error("Set a VGM Method (Method 1 or Method 2) before marking VGM as Submitted");
      return;
    }
    setStatus(next);
    onSave({ vgmStatus: next, vgmMethod: method });
  };

  const state = container.vgmCutoffState;

  return (
    <tr id={`svcvgm-row-${container.id}`} style={{ borderBottom: `1px solid ${T.border}` }}>
      <td style={{ padding: "8px 10px" }}>
        <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.accent, fontSize: 12.5 }}>
          {container.containerNumber || "TBC"}
        </span>
      </td>
      <td style={{ padding: "8px 10px", fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
        {container.size}ft {container.type}
      </td>
      <td style={{ padding: "8px 10px", width: 150 }}>
        <input id={`svcvgm-row-${container.id}-weight`} type="text" inputMode="decimal" value={weight}
          disabled={!canEdit} placeholder="18 500"
          onChange={e => { if (e.target.value === "" || /^\d*\.?\d*$/.test(e.target.value)) setWeight(e.target.value); }}
          onBlur={commitWeight}
          style={{ ...inputBase, fontFamily: T.body, fontSize: 12, width: "100%" }} />
      </td>
      <td style={{ padding: "8px 10px", width: 150 }}>
        <select id={`svcvgm-row-${container.id}-method`} value={method} disabled={!canEdit}
          onChange={e => { setMethod(e.target.value); onSave({ vgmMethod: e.target.value }); }}
          style={{ ...inputBase, fontFamily: T.body, fontSize: 12, width: "100%", cursor: "pointer" }}>
          <option value="">Not declared</option>
          <option value="Method 1">Method 1 — Weighing</option>
          <option value="Method 2">Method 2 — Calculated</option>
        </select>
      </td>
      <td style={{ padding: "8px 10px", width: 150 }}>
        {/* Accepted/Rejected only ever come from the VGM Simulator (Test Tools) — same
            simulate-only invariant as customs filing/carrier booking's own Accepted/Rejected,
            never a raw dropdown option here. */}
        {status === "Accepted" ? (
          <Badge variant="success">Accepted</Badge>
        ) : status === "Rejected" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span title={container.vgmRejectionReason || "Rejected"}><Badge variant="danger">Rejected</Badge></span>
            {canEdit && (
              <button id={`svcvgm-row-${container.id}-reset-btn`}
                onClick={() => { setStatus("Pending"); onSave({ vgmStatus: "Pending" }); }}
                style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                  fontFamily: T.body, fontSize: 11, color: T.accent, textDecoration: "underline" }}>
                Reset
              </button>
            )}
          </div>
        ) : (
          <select id={`svcvgm-row-${container.id}-status`} value={status} disabled={!canEdit}
            onChange={e => handleStatusChange(e.target.value)}
            style={{ ...inputBase, fontFamily: T.body, fontSize: 12, width: "100%", cursor: "pointer" }}>
            <option value="Pending">Pending</option>
            <option value="Submitted">Submitted</option>
          </select>
        )}
      </td>
      <td style={{ padding: "8px 10px", width: 170 }}>
        <DatePicker id={`svcvgm-row-${container.id}-cutoff`} value={cutoff} disabled={!canEdit}
          onChange={d => { setCutoff(d); onSave({ vgmCutoff: d }); }} placeholder="Not set" />
      </td>
      <td style={{ padding: "8px 10px", width: 110 }}>
        {state && state !== "none" && (
          <Badge variant={CUTOFF_STATE_VARIANT[state]}>{COMPLIANCE_STATE_LABEL[state]}</Badge>
        )}
      </td>
      {saving && (
        <td style={{ padding: "8px 4px", width: 20 }}>
          <span style={{ fontSize: 10, color: T.textMuted }}>⏳</span>
        </td>
      )}
    </tr>
  );
};

const VgmServicePage = ({ shipment, containers = [], side, canEdit, onEditContainer }) => {
  const [service, setService] = useState(undefined); // undefined = loading, null = not found
  const [notes,   setNotes]   = useState("");
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingId,    setSavingId]    = useState(null);
  const [messages,    setMessages]    = useState([]);

  const shipmentContainers = containers.filter(c => c.shipmentId === shipment.id);
  // Every vgm_declaration/vgm_acceptance/vgm_rejection message across every container on this
  // shipment — one shared thread rather than splitting per-container, since each message's own
  // payload already names its containerNumber (EdiMessageList shows the raw payload).
  const vgmMessages = messages.filter(m => m.messageType.startsWith("vgm_"));

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.services.list(shipment.id), api.ediMessages.list(shipment.id)])
      .then(([list, msgs]) => {
        if (cancelled) return;
        const match = list.find(s => s.side === side && s.serviceType === "VGM" && s.status !== "Cancelled");
        setService(match || null);
        setNotes(match?.notes || "");
        setMessages(msgs);
      })
      .catch(() => !cancelled && setService(null));
    return () => { cancelled = true; };
  }, [shipment.id, side]);

  const handleSaveNotes = async () => {
    if (!service) return;
    setSavingNotes(true);
    try {
      const updated = await api.services.update(shipment.id, service.id, { notes });
      setService(updated);
      toast.success("Notes saved");
    } catch (e) { toast.error(e.message || "Failed to save notes"); }
    setSavingNotes(false);
  };

  const handleSaveField = async (containerId, patch) => {
    const container = shipmentContainers.find(c => c.id === containerId);
    if (!container) return;
    setSavingId(containerId);
    try {
      await onEditContainer(containerId, { ...container, ...patch }, { silent: true });
      // A Pending→Submitted transition writes a new vgm_declaration transmittal server-side —
      // refetch so it shows up in the thread immediately rather than only after a reload.
      if (patch.vgmStatus === "Submitted") {
        api.ediMessages.list(shipment.id).then(setMessages).catch(() => {});
      }
    } catch { /* already toasted by onEditContainer */ }
    setSavingId(null);
  };

  const acceptedCount  = shipmentContainers.filter(c => c.vgmStatus === "Accepted").length;
  const rejectedCount  = shipmentContainers.filter(c => c.vgmStatus === "Rejected").length;
  const submittedCount = shipmentContainers.filter(c => c.vgmStatus === "Submitted" || c.vgmStatus === "Accepted").length;
  const overallState   = worstState(shipmentContainers.map(c => c.vgmCutoffState));

  if (service === undefined) {
    return (
      <div style={{ padding: "40px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
        Loading…
      </div>
    );
  }

  if (service === null) {
    return (
      <div id="svcvgm-notfound" style={{ maxWidth: 700, margin: "60px auto", textAlign: "center" }}>
        <div style={{ marginBottom: 12, color: T.textMuted }}><IconFolder size={40} /></div>
        <div style={{ fontFamily: T.head, fontSize: 18, fontWeight: 800, color: T.text, marginBottom: 8 }}>
          No {side} VGM service found
        </div>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          Order a VGM service for {side} from the Services panel on the Overview page to unlock this page.
        </div>
      </div>
    );
  }

  return (
    <div id="svcvgm-page" style={{ maxWidth: 1100, margin: "0 auto" }}>

      {/* Header / service summary */}
      <div id="svcvgm-header" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "16px 18px", marginBottom: 18, display: "flex", alignItems: "center",
        justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontFamily: T.head, fontSize: 18, fontWeight: 800, color: T.text }}>
            {side} · VGM Service
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 3 }}>
            {service.vendorName || "No vendor set"} · {service.status}
            {service.requestedDate ? ` · Requested ${service.requestedDate}` : ""}
          </div>
        </div>
        {shipmentContainers.length > 0 && (
          <div id="svcvgm-summary" style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
              {submittedCount}/{shipmentContainers.length} container{shipmentContainers.length !== 1 ? "s" : ""} submitted
              {acceptedCount > 0 ? ` · ${acceptedCount} accepted` : ""}
            </span>
            {rejectedCount > 0 && (
              <Badge variant="danger">{rejectedCount} rejected</Badge>
            )}
            {overallState && overallState !== "none" && (
              <Badge variant={CUTOFF_STATE_VARIANT[overallState]}>{COMPLIANCE_STATE_LABEL[overallState]}</Badge>
            )}
          </div>
        )}
      </div>

      {/* Per-container VGM table */}
      <div id="svcvgm-table-section" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 18 }}>
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}`,
          fontFamily: T.head, fontSize: 14, fontWeight: 800, color: T.text }}>
          Container VGM
        </div>
        {shipmentContainers.length === 0 ? (
          <div id="svcvgm-no-containers" style={{ padding: "28px 0", textAlign: "center", fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
            No containers on this shipment yet — add containers from the Cargo page first.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table id="svcvgm-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Container #", "Type", "VGM Weight (kg)", "VGM Method", "VGM Status", "VGM Cutoff", "Compliance"].map(h => (
                    <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontFamily: T.body,
                      fontSize: 10.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shipmentContainers.map(c => (
                  <VgmRow key={c.id} container={c} canEdit={canEdit} saving={savingId === c.id}
                    onSave={patch => handleSaveField(c.id, patch)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Service-level notes */}
      <div id="svcvgm-details-section" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 18px" }}>
        <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 12 }}>
          Details
        </div>
        <Textarea id="svcvgm-notes" value={notes} onChange={setNotes} disabled={!canEdit} rows={6}
          placeholder="Fine-tuning details for this VGM service…" />
        {canEdit && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <Btn id="svcvgm-save-notes-btn" onClick={handleSaveNotes} disabled={savingNotes || notes === (service.notes || "")}>
              {savingNotes ? "Saving…" : "Save Details"}
            </Btn>
          </div>
        )}
      </div>

      {/* VGM declaration/response thread — Accepted/Rejected only ever arrive here via
          Test Tools → VGM Simulator (no live SOLAS VGM EDI integration). */}
      <div id="svcvgm-thread-section" style={{ marginTop: 18 }}>
        <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600,
          textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>Message Thread</div>
        <EdiMessageList messages={vgmMessages} emptyText="No VGM declared yet." />
      </div>
    </div>
  );
};

export default VgmServicePage;
