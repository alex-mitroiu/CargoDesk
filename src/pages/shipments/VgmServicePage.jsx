import { useState, useEffect } from "react";
import { T, worstState, CUTOFF_STATE_VARIANT, COMPLIANCE_STATE_LABEL } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../../components/primitives/Btn";
import Badge from "../../components/primitives/Badge";
import DatePicker from "../../components/primitives/DatePicker";
import { Textarea, inputBase } from "../../components/primitives/Form";
import { IconFolder } from "../../components/primitives/Icon";

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

  // Resyncs on the saved values themselves (not just container identity) — a save
  // round-trips async, so without this a corrected value could keep showing the
  // user's original, now-stale entry after it actually persisted. Safe against
  // fighting active typing since these props only change once a save completes.
  useEffect(() => {
    setWeight(container.vgmWeightKg != null ? String(container.vgmWeightKg) : "");
    setStatus(container.vgmStatus || "Pending");
    setCutoff(container.vgmCutoff || "");
  }, [container.id, container.vgmWeightKg, container.vgmStatus, container.vgmCutoff]);

  const commitWeight = () => {
    const parsed = weight.trim() === "" ? null : parseFloat(weight);
    onSave({ vgmWeightKg: (parsed != null && !Number.isNaN(parsed)) ? parsed : null });
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
      <td style={{ padding: "8px 10px", width: 130 }}>
        <select id={`svcvgm-row-${container.id}-status`} value={status} disabled={!canEdit}
          onChange={e => { setStatus(e.target.value); onSave({ vgmStatus: e.target.value }); }}
          style={{ ...inputBase, fontFamily: T.body, fontSize: 12, width: "100%", cursor: "pointer" }}>
          <option value="Pending">Pending</option>
          <option value="Submitted">Submitted</option>
        </select>
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

  const shipmentContainers = containers.filter(c => c.shipmentId === shipment.id);

  useEffect(() => {
    let cancelled = false;
    api.services.list(shipment.id)
      .then(list => {
        if (cancelled) return;
        const match = list.find(s => s.side === side && s.serviceType === "VGM" && s.status !== "Cancelled");
        setService(match || null);
        setNotes(match?.notes || "");
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
    } catch { /* already toasted by onEditContainer */ }
    setSavingId(null);
  };

  const submittedCount = shipmentContainers.filter(c => c.vgmStatus === "Submitted").length;
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
            </span>
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
                  {["Container #", "Type", "VGM Weight (kg)", "VGM Status", "VGM Cutoff", "Compliance"].map(h => (
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
    </div>
  );
};

export default VgmServicePage;
