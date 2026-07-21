import { useState, useEffect, useRef } from "react";
import { T, todayIso } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Btn from "../components/primitives/Btn";
import DatePicker from "../components/primitives/DatePicker";
import { inputBase } from "../components/primitives/Form";
import { buildLoadingPlanHtml } from "../utils/invoiceGenerator";
import { IconCheck, IconFlash, IconFolder } from "../components/primitives/Icon";

// ─── Loading / Unloading Service page (Epic TKT-TBS7QD, Stories TKT-TR6OBR /
//     TKT-X3SA2E / follow-up Unloading reuse) ──────────────────────────────
// Dedicated fine-tuning page for an ordered Loading OR Unloading service —
// reached via the dynamic "Export Services" / "Import Services" sidebar rows
// (App.jsx), only once that service has actually been ordered on that side.
// Additive to ServicesPanel (Overview), which stays the place to manage vendor/
// status/dates; this page is purely the carrier plan workspace: a planned date
// + time per container (manual entry), plus the carrier's own emailed plan
// attached to the service and/or a produced document generated from the
// structured table — both land in the same shipment_documents doc-type slot.
// Loading and Unloading are structurally identical (same per-container date/
// time-plan shape), so this one component serves both via the serviceType prop
// rather than being duplicated — only the doc-type code (LP01/UP01) and labels differ.

const DOC_CODE_BY_TYPE   = { Loading: "LP01", Unloading: "UP01" };
const PLAN_LABEL_BY_TYPE = { Loading: "Loading Plan", Unloading: "Unloading Plan" };

const LoadingPlanRow = ({ line, canEdit, saving, onSave }) => {
  const [seq,   setSeq]   = useState(line.sequenceOrder ?? 0);
  const [notes, setNotes] = useState(line.notes || "");

  useEffect(() => { setSeq(line.sequenceOrder ?? 0); setNotes(line.notes || ""); }, [line.containerId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <tr id={`svcplan-row-${line.containerId}`} style={{ borderBottom: `1px solid ${T.border}` }}>
      <td style={{ padding: "8px 10px" }}>
        <span style={{ fontFamily: T.mono, fontWeight: 700, color: T.accent, fontSize: 12.5 }}>
          {line.containerNumber || "TBC"}
        </span>
      </td>
      <td style={{ padding: "8px 10px", fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
        {line.size}ft {line.type}
      </td>
      <td style={{ padding: "8px 10px", width: 230 }}>
        <DatePicker id={`svcplan-row-${line.containerId}-date`} value={line.plannedDate} disabled={!canEdit} withTime
          onChange={d => onSave({ plannedDate: d })} placeholder="Not yet planned" />
      </td>
      <td style={{ padding: "8px 10px", width: 80 }}>
        <input id={`svcplan-row-${line.containerId}-seq`} type="number" value={seq} disabled={!canEdit}
          onChange={e => setSeq(e.target.value)}
          onBlur={() => onSave({ sequenceOrder: parseInt(seq, 10) || 0 })}
          style={{ ...inputBase, fontFamily: T.body, fontSize: 12, width: "100%" }} />
      </td>
      <td style={{ padding: "8px 10px" }}>
        <input id={`svcplan-row-${line.containerId}-notes`} value={notes} disabled={!canEdit} placeholder="Optional instructions…"
          onChange={e => setNotes(e.target.value)}
          onBlur={() => onSave({ notes })}
          style={{ ...inputBase, fontFamily: T.body, fontSize: 12, width: "100%" }} />
      </td>
      {saving && (
        <td style={{ padding: "8px 4px", width: 20 }}>
          <span style={{ fontSize: 10, color: T.textMuted }}>⏳</span>
        </td>
      )}
    </tr>
  );
};

const LoadingServicePage = ({ shipment, containers = [], side, serviceType = "Loading", canEdit, onViewDocuments }) => {
  const docCode   = DOC_CODE_BY_TYPE[serviceType];
  const planLabel = PLAN_LABEL_BY_TYPE[serviceType];

  const [service, setService] = useState(undefined); // undefined = loading, null = not found
  const [lines,   setLines]   = useState([]);
  const [savingId, setSavingId] = useState(null);
  const [latestDoc, setLatestDoc] = useState(null);
  const [file,       setFile]       = useState(null);
  const [uploading,  setUploading]  = useState(false);
  const [generating, setGenerating] = useState(false);
  const fileRef = useRef(null);

  const shipmentContainers = containers.filter(c => c.shipmentId === shipment.id);

  useEffect(() => {
    let cancelled = false;
    api.services.list(shipment.id)
      .then(list => {
        if (cancelled) return;
        const match = list.find(s => s.side === side && s.serviceType === serviceType && s.status !== "Cancelled");
        setService(match || null);
      })
      .catch(() => !cancelled && setService(null));
    return () => { cancelled = true; };
  }, [shipment.id, side, serviceType]);

  const loadLines = (serviceId) =>
    api.loadingPlan.list(shipment.id, serviceId).then(setLines).catch(() => setLines([]));

  const loadLatestDoc = () =>
    api.documents.list(shipment.id)
      .then(list => setLatestDoc(list.filter(d => d.docType === docCode)[0] || null))
      .catch(() => {});

  useEffect(() => {
    if (service) { loadLines(service.id); loadLatestDoc(); }
  }, [service?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveLine = async (containerId, patch) => {
    if (!service) return;
    setSavingId(containerId);
    const current = lines.find(l => l.containerId === containerId) || {};
    try {
      const updated = await api.loadingPlan.update(shipment.id, service.id, containerId, {
        plannedDate: current.plannedDate || "", sequenceOrder: current.sequenceOrder ?? 0,
        notes: current.notes || "", ...patch,
      });
      setLines(p => p.map(l => l.containerId === containerId ? updated : l));
    } catch (e) { toast.error(e.message || "Failed to save loading plan"); }
    setSavingId(null);
  };

  const handleUpload = () => {
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async e => {
      const base64 = e.target.result.split(",")[1];
      try {
        await api.documents.upload(shipment.id, { filename: file.name, mimeType: file.type, docType: docCode, data: base64 });
        setFile(null);
        if (fileRef.current) fileRef.current.value = "";
        toast.success(`Carrier ${planLabel.toLowerCase()} uploaded`);
        loadLatestDoc();
      } catch (ex) { toast.error(ex.message); }
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const invNumber = `${shipment.id}-${docCode.slice(0, 2)}-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      const invDate   = todayIso();
      const html = buildLoadingPlanHtml({
        shipment, invNumber, invDate, notes: "", side, planLabel,
        containers: shipmentContainers, loadingPlanLines: lines,
      });
      const filename = `${docCode}-${invNumber}-${invDate}.html`;
      const base64   = btoa(unescape(encodeURIComponent(html)));
      await api.documents.upload(shipment.id, { filename, mimeType: "text/html", docType: docCode, data: base64 });
      toast.success(`${planLabel} generated and saved to Documents`);
      loadLatestDoc();
    } catch (e) { toast.error(e.message || `Failed to generate ${planLabel}`); }
    setGenerating(false);
  };

  if (service === undefined) {
    return (
      <div style={{ padding: "40px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
        Loading…
      </div>
    );
  }

  if (service === null) {
    return (
      <div id="svcplan-notfound" style={{ maxWidth: 700, margin: "60px auto", textAlign: "center" }}>
        <div style={{ marginBottom: 12, color: T.textMuted }}><IconFolder size={40} /></div>
        <div style={{ fontFamily: T.head, fontSize: 18, fontWeight: 800, color: T.text, marginBottom: 8 }}>
          No {side} {serviceType} service found
        </div>
        <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
          Order a {serviceType} service for {side} from the Services panel on the Overview page to unlock this page.
        </div>
      </div>
    );
  }

  return (
    <div id="svcplan-page" style={{ maxWidth: 1100, margin: "0 auto" }}>

      {/* Header / service summary */}
      <div id="svcplan-header" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
        padding: "16px 18px", marginBottom: 18, display: "flex", alignItems: "center",
        justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ fontFamily: T.head, fontSize: 18, fontWeight: 800, color: T.text }}>
            {side} · {serviceType} Service
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 3 }}>
            {service.vendorName || "No vendor set"} · {service.status}
            {service.requestedDate ? ` · Requested ${service.requestedDate}` : ""}
          </div>
        </div>
        <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, fontStyle: "italic", maxWidth: 260, textAlign: "right" }}>
          Manage vendor, status and dates from the Services panel on Overview.
        </div>
      </div>

      {/* Per-container loading plan */}
      <div id="svcplan-table-section" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 18 }}>
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}`,
          fontFamily: T.head, fontSize: 14, fontWeight: 800, color: T.text }}>
          Container {planLabel}
        </div>
        {shipmentContainers.length === 0 ? (
          <div id="svcplan-no-containers" style={{ padding: "28px 0", textAlign: "center", fontFamily: T.body, fontSize: 12.5, color: T.textMuted }}>
            No containers on this shipment yet — add containers from the Cargo page first.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table id="svcplan-table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Container #", "Type", `Planned ${serviceType} Date & Time`, "Seq.", "Notes"].map(h => (
                    <th key={h} style={{ padding: "8px 10px", textAlign: "left", fontFamily: T.body,
                      fontSize: 10.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: ".05em" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {lines.map(line => (
                  <LoadingPlanRow key={line.containerId} line={line} canEdit={canEdit}
                    saving={savingId === line.containerId}
                    onSave={patch => handleSaveLine(line.containerId, patch)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Carrier attachment + produced document */}
      <div id="svcplan-doc-section" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 18px" }}>
        <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 12 }}>
          {planLabel} Document
        </div>

        {latestDoc ? (
          <div id="svcplan-doc-latest" style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 12 }}>
            Latest: <strong style={{ color: T.text }}>{latestDoc.filename}</strong>
            {" · "}{latestDoc.status === "confirmed" ? <span style={{ color: T.success, display: "inline-flex", alignItems: "center", gap: 3 }}><IconCheck size={10} />Confirmed</span> : "Draft"}
            {" · "}{new Date(latestDoc.createdAt).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" })}
            {onViewDocuments && (
              <button id="svcplan-view-documents-btn" type="button" onClick={onViewDocuments}
                style={{ background: "none", border: "none", color: T.accent, cursor: "pointer",
                  fontFamily: T.body, fontSize: 12, marginLeft: 8, padding: 0 }}>
                View in Documents →
              </button>
            )}
          </div>
        ) : (
          <div id="svcplan-doc-empty" style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, fontStyle: "italic", marginBottom: 12 }}>
            No {planLabel} document yet.
          </div>
        )}

        {canEdit && (
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>
                  Carrier's emailed {planLabel.toLowerCase()}
                </div>
                <input id="svcplan-upload-input" ref={fileRef} type="file" onChange={e => setFile(e.target.files[0] || null)}
                  style={{ fontFamily: T.body, fontSize: 12.5, color: T.text }} />
              </div>
              <Btn id="svcplan-upload-btn" variant="secondary" onClick={handleUpload} disabled={!file || uploading}>
                {uploading ? "Uploading…" : "Upload"}
              </Btn>
            </div>
            <Btn id="svcplan-generate-btn" onClick={handleGenerate} disabled={generating}>
              {generating ? "Generating…" : <><IconFlash size={13} />Generate {planLabel}</>}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
};

export default LoadingServicePage;
