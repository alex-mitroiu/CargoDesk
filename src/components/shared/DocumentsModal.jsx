import { useState, useEffect, useRef, useMemo } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import TrackedDocPreviewModal from "./TrackedDocPreviewModal";
import EntityHistoryModal from "./EntityHistoryModal";
import GenerateDocumentModal from "./GenerateDocumentModal";
import SendDocumentEmailModal from "./SendDocumentEmailModal";
import SendDocumentEdiModal from "./SendDocumentEdiModal";
import SendDocumentWebhookModal from "./SendDocumentWebhookModal";
import { DOC_TYPES, docTypeLabel, FILE_ICON, fmtBytes, fmtDate } from "../../utils/documentBuilders";
import { HZ, HZ_MONO, HZ_BODY, useHorizonFonts } from "../../pages/shipments/shipmentDetailTheme";

// ─── Documents Modal ──────────────────────────────────────────────────────────
// TrackedDocPreviewModal (in-app preview) now lives in
// src/components/shared/TrackedDocPreviewModal.jsx — shared with the Accounting
// Invoice Entry page, which can't import it back from here.
//
// Trade Horizon "New Style" pass — `standalone` is always true in practice (App.jsx's
// only real render call); the readiness overview's doc-type rows became a real <table>
// (a genuine repeating list, same treatment as Cargo/Accounting/History), while the
// uploaded/generated document list stays as cards — same shape Invoice Entry's own
// "Invoices" list already uses for the same kind of document-card content.
// GenerateDocumentModal/SendDocumentEmailModal/SendDocumentEdiModal/
// SendDocumentWebhookModal/EntityHistoryModal stay untouched — all genuinely shared
// with non-shipment-detail pages (MDM Document Templates, etc.), same reasoning as
// leaving Btn/Modal alone.

// A function, not a plain object — HZ is a live-mutated object (App.jsx's theme toggle calls
// applyHzTheme in place, no reload), so a plain object built from HZ.* at module load would
// freeze whichever theme was active at import and never follow a later toggle.
const docReadinessColor = status => ({
  confirmed: HZ.good,
  draft:     HZ.textMuted,
  outdated:  HZ.warn,
  missing:   HZ.crit,
}[status]);
const DOC_READINESS_LABEL = {
  confirmed: "✓ Confirmed",
  draft:     "Draft",
  outdated:  "⚠ Outdated",
  missing:   "Missing",
};

const DocumentsModal = ({ shipment, canEdit, onClose, standalone = false }) => {
  const [docs,           setDocs]           = useState([]);
  const [loading,        setLoading]        = useState(true);
  const [uploading,      setUploading]      = useState(false);
  const [docType,        setDocType]        = useState(DOC_TYPES[0].code);
  const [file,           setFile]           = useState(null);
  const [genInvOpen,     setGenInvOpen]     = useState(false);
  const [genDefaultCode, setGenDefaultCode] = useState(null);
  const [previewDoc,     setPreviewDoc]     = useState(null);
  const [sendDoc,        setSendDoc]        = useState(null);
  const [ediDoc,         setEdiDoc]         = useState(null);
  const [webhookDoc,     setWebhookDoc]     = useState(null);
  const [historyDoc,     setHistoryDoc]     = useState(null);
  const fileRef = useRef(null);

  // Best doc per type: confirmed+fresh > confirmed+stale > draft+fresh > draft+stale
  const latestByCode = useMemo(() => {
    const map = {};
    docs.forEach(doc => { (map[doc.docType] ||= []).push(doc); });
    const result = {};
    Object.entries(map).forEach(([code, list]) => {
      const pri = d => (d.status === "confirmed" && !d.isStale) ? 0
                     : (d.status === "confirmed")                ? 1
                     : (!d.isStale)                              ? 2 : 3;
      list.sort((a, b) => pri(a) - pri(b) || new Date(b.createdAt) - new Date(a.createdAt));
      result[code] = list[0];
    });
    return result;
  }, [docs]);

  const typeStatus = code => {
    const doc = latestByCode[code];
    if (!doc)                                    return "missing";
    if (doc.status === "confirmed" && !doc.isStale) return "confirmed";
    if (doc.isStale)                             return "outdated";
    return "draft";
  };

  const confirmedCount = DOC_TYPES.filter(t => typeStatus(t.code) === "confirmed").length;
  const draftCount     = DOC_TYPES.filter(t => ["draft","outdated"].includes(typeStatus(t.code))).length;
  const missingCount   = DOC_TYPES.filter(t => typeStatus(t.code) === "missing").length;
  const total          = DOC_TYPES.length;

  useEffect(() => {
    api.documents.list(shipment.id)
      .then(setDocs)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [shipment.id]);

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    const reader = new FileReader();
    reader.onload = async e => {
      const base64 = e.target.result.split(",")[1];
      try {
        const doc = await api.documents.upload(shipment.id, {
          filename: file.name, mimeType: file.type, docType, data: base64,
        });
        setDocs(p => [doc, ...p]);
        setFile(null);
        fileRef.current.value = "";
        toast.success("Document uploaded");
      } catch (ex) { toast.error(ex.message); }
      setUploading(false);
    };
    reader.readAsDataURL(file);
  };

  const handleDelete = async id => {
    if (!window.confirm("Remove this document?")) return;
    try {
      await api.documents.remove(shipment.id, id);
      setDocs(p => p.filter(d => d.id !== id));
      toast.success("Document removed");
    } catch (ex) { toast.error(ex.message); }
  };

  const handleConfirm = async id => {
    try {
      const updated = await api.documents.patch(shipment.id, id, { status: "confirmed" });
      setDocs(p => p.map(d => d.id === id ? updated : d));
      setPreviewDoc(p => p?.id === id ? updated : p);
      toast.success("Document confirmed");
    } catch (ex) { toast.error(ex.message); }
  };

  // House B/L Lifecycle — post-issuance facts on a confirmed BL01 (see routes/shipment-ops.js).
  const handleBlSurrender = async id => {
    try {
      const updated = await api.documents.blSurrender(shipment.id, id);
      setDocs(p => p.map(d => d.id === id ? updated : d));
      toast.success("House B/L marked surrendered");
    } catch (ex) { toast.error(ex.message); }
  };
  const handleBlRelease = async id => {
    try {
      const updated = await api.documents.blRelease(shipment.id, id);
      setDocs(p => p.map(d => d.id === id ? updated : d));
      toast.success("House B/L marked released");
    } catch (ex) { toast.error(ex.message); }
  };

  const statusBadge = doc => {
    if (doc.isStale) return (
      <span title="Shipment data changed after this document was generated — consider regenerating"
        style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "1px 6px",
          background: HZ.warnBg, color: HZ.warn }}>
        ⚠ Outdated
      </span>
    );
    const confirmed = doc.status === "confirmed";
    return (
      <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "1px 6px",
        background: confirmed ? HZ.goodBg : HZ.surface2,
        color: confirmed ? HZ.good : HZ.textMuted }}>
        {confirmed ? "✓ Confirmed" : "Draft"}
      </span>
    );
  };

  const dashedBtn = { padding: "4px 10px", background: "none", cursor: "pointer",
    border: `1px solid ${HZ.border}`, borderRadius: 6, fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted };

  useHorizonFonts();

  const body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Toolbar */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={() => { setGenDefaultCode(null); setGenInvOpen(true); }}
            style={{ padding: "7px 12px", background: "none", cursor: "pointer",
              border: `1px dashed ${HZ.cyan}55`, borderRadius: 6, fontFamily: HZ_BODY, fontSize: 12, color: HZ.cyan }}>
            ⚡ Generate Document
          </button>
        </div>

        {/* Document readiness overview — stat strip + a real table (Cargo/Accounting/History's
            own New Style treatment; approved mockup https://claude.ai/artifact/25ygL745mmMfvYWBXZWoAE) */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {[["Confirmed", confirmedCount, docReadinessColor("confirmed")],
            ["Draft / Outdated", draftCount, docReadinessColor("outdated")],
            ["Missing", missingCount, docReadinessColor("missing")]].map(([label, n, color]) => (
            <div key={label} style={{ background: HZ.bg, border: `1px solid ${HZ.border}`, boxShadow: HZ.cardShadow,
              borderRadius: 8, padding: "10px 12px" }}>
              <div style={{ fontFamily: HZ_BODY, fontSize: 10, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
              <div style={{ fontFamily: HZ_MONO, fontSize: 16, fontWeight: 700, color, marginTop: 2 }}>{n}</div>
            </div>
          ))}
        </div>
        <div style={{ height: 6, borderRadius: 3, background: HZ.surface2, overflow: "hidden", display: "flex", marginTop: -6 }}>
          <div style={{ width: `${confirmedCount / total * 100}%`, background: docReadinessColor("confirmed") }} />
          <div style={{ width: `${draftCount     / total * 100}%`, background: docReadinessColor("outdated")  }} />
          <div style={{ width: `${missingCount   / total * 100}%`, background: docReadinessColor("missing")   }} />
        </div>

        <div style={{ background: HZ.surface, backdropFilter: "blur(20px)", border: `1px solid ${HZ.border}`,
          boxShadow: HZ.cardShadow, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: HZ.bg, borderBottom: `1px solid ${HZ.border}` }}>
                {["Code", "Document", "Generated", "Status", ""].map(h => (
                  <th key={h} style={{ textAlign: "left", padding: "9px 14px", fontFamily: HZ_BODY, fontSize: 10,
                    fontWeight: 700, color: HZ.textMuted, textTransform: "uppercase", letterSpacing: ".06em" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DOC_TYPES.map((t, idx) => {
                const doc  = latestByCode[t.code];
                const stat = typeStatus(t.code);
                const col  = docReadinessColor(stat);
                const handleRowClick = () => {
                  if (doc) { setPreviewDoc(doc); }
                  else     { setGenDefaultCode(t.code); setGenInvOpen(true); }
                };
                return (
                  <tr key={t.code} onClick={handleRowClick}
                    style={{ cursor: "pointer", borderBottom: idx < DOC_TYPES.length - 1 ? `1px solid ${HZ.border}` : "none" }}>
                    <td style={{ padding: "8px 14px" }}>
                      <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700, color: HZ.cyan,
                        background: HZ.cyanBg, borderRadius: 4, padding: "1px 6px" }}>{t.code}</span>
                    </td>
                    <td style={{ padding: "8px 14px", fontFamily: HZ_BODY, fontSize: 12, color: HZ.text }}>{t.label}</td>
                    <td style={{ padding: "8px 14px", fontFamily: HZ_MONO, fontSize: 11, color: HZ.textMuted }}>
                      {doc ? fmtDate(doc.createdAt) : "—"}
                    </td>
                    <td style={{ padding: "8px 14px" }}>
                      <span style={{ fontFamily: HZ_MONO, fontSize: 9.5, fontWeight: 700, textTransform: "uppercase",
                        color: col, background: col + "22", borderRadius: 4, padding: "2px 7px", whiteSpace: "nowrap" }}>
                        {DOC_READINESS_LABEL[stat]}
                      </span>
                    </td>
                    <td style={{ padding: "8px 14px" }}>
                      {!doc && canEdit && (
                        <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.cyan,
                          background: HZ.cyanBg, borderRadius: 4, padding: "1px 8px", whiteSpace: "nowrap" }}>
                          ⚡ Generate
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Upload area — editors only */}
        {canEdit && (
          <div style={{ background: HZ.bg, border: `1px solid ${HZ.border}`, borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontFamily: HZ_BODY, fontSize: 11, fontWeight: 700, color: HZ.textMuted,
              textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>
              Upload External Document
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginBottom: 4 }}>File</div>
                <input ref={fileRef} type="file" onChange={e => setFile(e.target.files[0] || null)}
                  style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.text, width: "100%" }} />
              </div>
              <div>
                <div style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted, marginBottom: 4 }}>Document Type</div>
                <select value={docType} onChange={e => setDocType(e.target.value)}
                  style={{ fontFamily: HZ_BODY, fontSize: 13, background: HZ.surface, color: HZ.text,
                    border: `1px solid ${HZ.border}`, borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}>
                  {DOC_TYPES.map(t => <option key={t.code} value={t.code}>{t.code} · {t.label}</option>)}
                </select>
              </div>
              <Btn onClick={handleUpload} disabled={!file || uploading}>
                {uploading ? "Uploading…" : "Upload"}
              </Btn>
            </div>
          </div>
        )}

        {/* Document list */}
        {loading ? (
          <div style={{ padding: "32px 0", textAlign: "center", fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>
            Loading…
          </div>
        ) : docs.length === 0 ? (
          <div style={{ padding: "40px 0", textAlign: "center" }}>
            <div style={{ fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted, marginBottom: 8 }}>
              No documents yet.
            </div>
            <div style={{ fontFamily: HZ_BODY, fontSize: 12, color: HZ.textMuted }}>
              Use <strong>⚡ Generate Document</strong> to create a Bill of Lading, Invoice, Packing List and more.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {docs.map(doc => (
              <div key={doc.id} style={{ display: "flex", alignItems: "flex-start", gap: 12,
                padding: "12px 14px", background: HZ.bg,
                border: `1px solid ${doc.isStale ? HZ.warn + "55" : HZ.border}`,
                borderRadius: 8 }}>
                <span style={{ fontSize: 20, flexShrink: 0, marginTop: 2 }}>{FILE_ICON(doc.mimeType)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: HZ_BODY, fontSize: 13, fontWeight: 600, color: HZ.text,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 }}>
                    {doc.filename}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontFamily: HZ_MONO, fontSize: 10, fontWeight: 700,
                      background: HZ.cyanBg, color: HZ.cyan, borderRadius: 4, padding: "1px 6px" }}>
                      {doc.docType}
                    </span>
                    <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>
                      {docTypeLabel(doc.docType)}
                    </span>
                    {statusBadge(doc)}
                    <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>
                      {fmtBytes(doc.sizeBytes)} · {fmtDate(doc.createdAt)}
                      {doc.uploadedBy && ` · ${doc.uploadedBy}`}
                    </span>
                    {doc.status === "confirmed" && doc.confirmedBy && (
                      <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.good }}>
                        confirmed by {doc.confirmedBy}
                      </span>
                    )}
                    {doc.docType === "BL01" && doc.blSurrenderedAt && (
                      <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.good }}>
                        surrendered {fmtDate(doc.blSurrenderedAt)}{doc.blSurrenderedBy && ` by ${doc.blSurrenderedBy}`}
                      </span>
                    )}
                    {doc.docType === "BL01" && doc.blReleasedAt && (
                      <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.good }}>
                        released {fmtDate(doc.blReleasedAt)}{doc.blReleasedBy && ` by ${doc.blReleasedBy}`}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5, flexShrink: 0, alignItems: "center", marginTop: 1, flexWrap: "wrap", maxWidth: 340, justifyContent: "flex-end" }}>
                  <button type="button" onClick={() => setPreviewDoc(doc)} style={dashedBtn}>👁 Preview</button>
                  <button type="button" style={dashedBtn}
                    onClick={() => api.documents.download(shipment.id, doc.id, doc.filename).catch(() => toast.error("Download failed"))}>
                    ↓
                  </button>
                  <button type="button" onClick={() => setSendDoc(doc)} style={dashedBtn}>✉ Send</button>
                  <button type="button" onClick={() => setEdiDoc(doc)} style={dashedBtn}>📡 EDI</button>
                  <button type="button" onClick={() => setWebhookDoc(doc)} style={dashedBtn}>🔗 Webhook</button>
                  <button type="button" onClick={() => setHistoryDoc(doc)} style={dashedBtn}>🕐</button>
                  {canEdit && doc.status !== "confirmed" && (
                    <button type="button" onClick={() => handleConfirm(doc.id)}
                      style={{ ...dashedBtn, color: HZ.good, borderColor: HZ.good + "66" }}>
                      ✓ Confirm
                    </button>
                  )}
                  {canEdit && doc.docType === "BL01" && doc.status === "confirmed" && !doc.blSurrenderedAt
                    && ["Telex Release", "Surrendered", "Seaway Bill"].includes(shipment.blReleaseType) && (
                    <button type="button" onClick={() => handleBlSurrender(doc.id)} style={dashedBtn}>Mark Surrendered</button>
                  )}
                  {canEdit && doc.docType === "BL01" && doc.status === "confirmed" && !doc.blReleasedAt && (
                    <button type="button" onClick={() => handleBlRelease(doc.id)} style={dashedBtn}>Mark Released</button>
                  )}
                  {canEdit && (
                    <button type="button" onClick={() => handleDelete(doc.id)} style={{ ...dashedBtn, color: HZ.crit, borderColor: HZ.crit + "55" }}>✕</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
  );

  return (
    <>
      {standalone ? body : (
        <Modal title={`Documents — ${shipment.id}`} onClose={onClose} width={720}>{body}</Modal>
      )}
      {genInvOpen && (
        <GenerateDocumentModal
          shipment={shipment}
          defaultCode={genDefaultCode}
          onClose={() => { setGenInvOpen(false); setGenDefaultCode(null); }}
          onSaved={doc => { setDocs(p => [doc, ...p]); setGenInvOpen(false); setGenDefaultCode(null); setPreviewDoc(doc); }}
        />
      )}
      {previewDoc && (
        <TrackedDocPreviewModal
          shipmentId={shipment.id}
          doc={previewDoc}
          onClose={() => setPreviewDoc(null)}
          onConfirm={canEdit ? () => handleConfirm(previewDoc.id) : null}
          onSend={() => setSendDoc(previewDoc)}
        />
      )}
      {sendDoc && (
        <SendDocumentEmailModal shipment={shipment} doc={sendDoc} onClose={() => setSendDoc(null)} />
      )}
      {ediDoc && (
        <SendDocumentEdiModal shipment={shipment} doc={ediDoc} onClose={() => setEdiDoc(null)} />
      )}
      {webhookDoc && (
        <SendDocumentWebhookModal shipment={shipment} doc={webhookDoc} onClose={() => setWebhookDoc(null)} />
      )}
      {historyDoc && (
        <EntityHistoryModal
          entityType="document"
          entityId={historyDoc.id}
          title={`History — ${historyDoc.filename}`}
          onClose={() => setHistoryDoc(null)} />
      )}
    </>
  );
};

export default DocumentsModal;
