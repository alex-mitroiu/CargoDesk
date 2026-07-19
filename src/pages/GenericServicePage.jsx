import { useState, useEffect, useRef } from "react";
import { T, todayIso } from "../tokens";
import { api } from "../api";
import { toast } from "../toast";
import Btn from "../components/primitives/Btn";
import { Textarea } from "../components/primitives/Form";
import { buildGenericServiceDocHtml } from "../utils/invoiceGenerator";

// ─── Generic Service Detail page (Epic TKT-TBS7QD) ────────────────────────────
// Dedicated page for every ordered service type without a bespoke page — everything
// except Loading/Unloading, which share LoadingServicePage.jsx instead (see
// BESPOKE_SERVICE_TYPES in shipmentServicePages.js). Replaces the old WIP placeholder:
// not tailored per type, but real — a vendor/status/dates recap (same shape as
// LoadingServicePage's header), a bigger Details textarea bound to the same
// shipment_services.notes column ServicesPanel already shows (no new table), and a
// generic produced document saved under the catch-all "OT" (Other) doc type.

const GenericServicePage = ({ shipment, side, serviceType, canEdit, onViewDocuments }) => {
  const [service, setService] = useState(undefined); // undefined = loading, null = not found
  const [notes,   setNotes]   = useState("");
  const [saving,  setSaving]  = useState(false);
  const [file,       setFile]       = useState(null);
  const [uploading,  setUploading]  = useState(false);
  const [generating, setGenerating] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.services.list(shipment.id)
      .then(list => {
        if (cancelled) return;
        const match = list.find(s => s.side === side && s.serviceType === serviceType && s.status !== "Cancelled");
        setService(match || null);
        setNotes(match?.notes || "");
      })
      .catch(() => !cancelled && setService(null));
    return () => { cancelled = true; };
  }, [shipment.id, side, serviceType]);

  const handleSaveNotes = async () => {
    if (!service) return;
    setSaving(true);
    try {
      const updated = await api.services.update(shipment.id, service.id, { notes });
      setService(updated);
      toast.success("Details saved");
    } catch (e) { toast.error(e.message || "Failed to save details"); }
    setSaving(false);
  };

  const handleUpload = () => {
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async e => {
      const base64 = e.target.result.split(",")[1];
      try {
        await api.documents.upload(shipment.id, { filename: file.name, mimeType: file.type, docType: "OT", data: base64 });
        setFile(null);
        if (fileRef.current) fileRef.current.value = "";
        toast.success("Document uploaded");
      } catch (ex) { toast.error(ex.message); }
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const invNumber = `${shipment.id}-SV-${Date.now().toString(36).toUpperCase().slice(-6)}`;
      const invDate   = todayIso();
      const html = buildGenericServiceDocHtml({ shipment, invNumber, invDate, side, serviceType, service });
      const filename = `OT-${serviceType.replace(/[^a-zA-Z0-9]+/g, "")}-${invNumber}-${invDate}.html`;
      const base64   = btoa(unescape(encodeURIComponent(html)));
      await api.documents.upload(shipment.id, { filename, mimeType: "text/html", docType: "OT", data: base64 });
      toast.success("Document generated and saved to Documents");
    } catch (e) { toast.error(e.message || "Failed to generate document"); }
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
      <div id="svcgen-notfound" style={{ maxWidth: 700, margin: "60px auto", textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>📭</div>
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
    <div id="svcgen-page" style={{ maxWidth: 1100, margin: "0 auto" }}>

      {/* Header / service summary */}
      <div id="svcgen-header" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10,
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

      {/* Details */}
      <div id="svcgen-details-section" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 18px", marginBottom: 18 }}>
        <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 12 }}>
          Details
        </div>
        <Textarea id="svcgen-notes" value={notes} onChange={setNotes} disabled={!canEdit} rows={6}
          placeholder={`Fine-tuning details for this ${serviceType} service…`} />
        {canEdit && (
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
            <Btn id="svcgen-save-notes-btn" onClick={handleSaveNotes} disabled={saving || notes === (service.notes || "")}>
              {saving ? "Saving…" : "Save Details"}
            </Btn>
          </div>
        )}
      </div>

      {/* Generic produced document */}
      <div id="svcgen-doc-section" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: "16px 18px" }}>
        <div style={{ fontFamily: T.head, fontSize: 14, fontWeight: 800, color: T.text, marginBottom: 12 }}>
          Document
        </div>
        <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 12 }}>
          Not a dedicated tracked type yet — generated or uploaded documents for this service are saved under
          the general "Other" document type.
          {onViewDocuments && (
            <button id="svcgen-view-documents-btn" type="button" onClick={onViewDocuments}
              style={{ background: "none", border: "none", color: T.accent, cursor: "pointer",
                fontFamily: T.body, fontSize: 12, marginLeft: 8, padding: 0 }}>
              View Documents →
            </button>
          )}
        </div>

        {canEdit && (
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-end" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>
                  Vendor's own document
                </div>
                <input id="svcgen-upload-input" ref={fileRef} type="file" onChange={e => setFile(e.target.files[0] || null)}
                  style={{ fontFamily: T.body, fontSize: 12.5, color: T.text }} />
              </div>
              <Btn id="svcgen-upload-btn" variant="secondary" onClick={handleUpload} disabled={!file || uploading}>
                {uploading ? "Uploading…" : "Upload"}
              </Btn>
            </div>
            <Btn id="svcgen-generate-btn" onClick={handleGenerate} disabled={generating}>
              {generating ? "Generating…" : "⚡ Generate Document"}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
};

export default GenericServicePage;
