import { useState, useEffect, useRef, useMemo } from "react";
import { T } from "../../tokens";
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

// ─── Documents Modal ──────────────────────────────────────────────────────────
// TrackedDocPreviewModal (in-app preview) now lives in
// src/components/shared/TrackedDocPreviewModal.jsx — shared with the Accounting
// Invoice Entry page, which can't import it back from here.

const DOC_STATUS_STYLE = {
  draft:     { label: "Draft",     bg: "", color: T.textMuted, border: T.border },
  confirmed: { label: "Confirmed", bg: "", color: T.success,   border: T.success + "66" },
};

const DOC_READINESS_COLOR = {
  confirmed: "#34d399",
  draft:     "#94a3b8",
  outdated:  "#fbbf24",
  missing:   "#f87171",
};
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
      await api.documents.remove(id);
      setDocs(p => p.filter(d => d.id !== id));
      toast.success("Document removed");
    } catch (ex) { toast.error(ex.message); }
  };

  const handleConfirm = async id => {
    try {
      const updated = await api.documents.patch(id, { status: "confirmed" });
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
        style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "1px 6px",
          background: T.warning + "22", color: T.warning, border: `1px solid ${T.warning + "55"}` }}>
        ⚠ Outdated
      </span>
    );
    const s = DOC_STATUS_STYLE[doc.status] || DOC_STATUS_STYLE.draft;
    return (
      <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, borderRadius: 4, padding: "1px 6px",
        background: doc.status === "confirmed" ? T.success + "18" : T.surface,
        color: s.color, border: `1px solid ${s.border}` }}>
        {doc.status === "confirmed" ? "✓ " : ""}{s.label}
      </span>
    );
  };

  const body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

        {/* Toolbar */}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Btn variant="secondary" onClick={() => { setGenDefaultCode(null); setGenInvOpen(true); }}>⚡ Generate Document</Btn>
        </div>

        {/* Document readiness overview */}
        <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
          {/* Coverage bar */}
          <div style={{ display: "flex", alignItems: "center", gap: 20,
            padding: "14px 16px", borderBottom: `1px solid ${T.border}` }}>
            <div style={{ display: "flex", gap: 20, flexShrink: 0 }}>
              {[[confirmedCount, "Confirmed", DOC_READINESS_COLOR.confirmed],
                [draftCount,     "Draft / Outdated", DOC_READINESS_COLOR.outdated],
                [missingCount,   "Missing",   DOC_READINESS_COLOR.missing]].map(([n, lbl, color]) => (
                <div key={lbl}>
                  <div style={{ fontFamily: T.mono, fontSize: 20, fontWeight: 800,
                    fontVariantNumeric: "tabular-nums", lineHeight: 1, color }}>{n}</div>
                  <div style={{ fontFamily: T.body, fontSize: 10, fontWeight: 700,
                    letterSpacing: ".08em", textTransform: "uppercase", color: T.textMuted }}>{lbl}</div>
                </div>
              ))}
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ height: 6, borderRadius: 3, background: T.border, overflow: "hidden", display: "flex" }}>
                <div style={{ width: `${confirmedCount / total * 100}%`, background: DOC_READINESS_COLOR.confirmed }} />
                <div style={{ width: `${draftCount     / total * 100}%`, background: DOC_READINESS_COLOR.outdated  }} />
                <div style={{ width: `${missingCount   / total * 100}%`, background: DOC_READINESS_COLOR.missing   }} />
              </div>
              <div style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted, textAlign: "right" }}>
                {confirmedCount} / {total} confirmed
              </div>
            </div>
          </div>

          {/* Doc type rows */}
          {DOC_TYPES.map((t, idx) => {
            const doc  = latestByCode[t.code];
            const stat = typeStatus(t.code);
            const col  = DOC_READINESS_COLOR[stat];
            const handleRowClick = () => {
              if (doc) { setPreviewDoc(doc); }
              else     { setGenDefaultCode(t.code); setGenInvOpen(true); }
            };
            return (
              <div key={t.code}
                onClick={handleRowClick}
                style={{ display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 16px",
                  borderBottom: idx < DOC_TYPES.length - 1 ? `1px solid ${T.border}22` : "none",
                  cursor: "pointer", transition: "background .1s" }}
                onMouseEnter={e => e.currentTarget.style.background = T.surface}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  color: T.accent, background: T.accent + "18",
                  border: `1px solid ${T.accent}33`, borderRadius: 4,
                  padding: "1px 6px", flexShrink: 0, minWidth: 38, textAlign: "center" }}>
                  {t.code}
                </span>
                <span style={{ fontFamily: T.body, fontSize: 12, color: T.text, flex: 1 }}>
                  {t.label}
                </span>
                {doc && (
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, flexShrink: 0 }}>
                    {fmtDate(doc.createdAt)}
                  </span>
                )}
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  color: col, background: col + "18", border: `1px solid ${col}44`,
                  borderRadius: 4, padding: "1px 7px", flexShrink: 0, minWidth: 78, textAlign: "center" }}>
                  {DOC_READINESS_LABEL[stat]}
                </span>
                {!doc && canEdit && (
                  <span style={{ fontFamily: T.body, fontSize: 11, color: T.accent,
                    background: T.accent + "15", border: `1px solid ${T.accent}44`,
                    borderRadius: 4, padding: "1px 8px", flexShrink: 0 }}>
                    ⚡ Generate
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Upload area — editors only */}
        {canEdit && (
          <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ fontFamily: T.body, fontSize: 11, fontWeight: 700, color: T.textMuted,
              textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10 }}>
              Upload External Document
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>File</div>
                <input ref={fileRef} type="file" onChange={e => setFile(e.target.files[0] || null)}
                  style={{ fontFamily: T.body, fontSize: 13, color: T.text, width: "100%" }} />
              </div>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Document Type</div>
                <select value={docType} onChange={e => setDocType(e.target.value)}
                  style={{ fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
                    border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}>
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
          <div style={{ padding: "32px 0", textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
            Loading…
          </div>
        ) : docs.length === 0 ? (
          <div style={{ padding: "40px 0", textAlign: "center" }}>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted, marginBottom: 8 }}>
              No documents yet.
            </div>
            <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted }}>
              Use <strong>⚡ Generate Document</strong> to create a Bill of Lading, Invoice, Packing List and more.
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {docs.map(doc => (
              <div key={doc.id} style={{ display: "flex", alignItems: "flex-start", gap: 12,
                padding: "12px 14px", background: T.bg,
                border: `1px solid ${doc.isStale ? T.warning + "55" : T.border}`,
                borderRadius: 8, transition: "border-color .15s" }}>
                <span style={{ fontSize: 20, flexShrink: 0, marginTop: 2 }}>{FILE_ICON(doc.mimeType)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: T.body, fontSize: 13, fontWeight: 600, color: T.text,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 }}>
                    {doc.filename}
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                      background: T.accent + "22", color: T.accent, borderRadius: 4, padding: "1px 6px" }}>
                      {doc.docType}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      {docTypeLabel(doc.docType)}
                    </span>
                    {statusBadge(doc)}
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                      {fmtBytes(doc.sizeBytes)} · {fmtDate(doc.createdAt)}
                      {doc.uploadedBy && ` · ${doc.uploadedBy}`}
                    </span>
                    {doc.status === "confirmed" && doc.confirmedBy && (
                      <span style={{ fontFamily: T.body, fontSize: 11, color: T.success }}>
                        confirmed by {doc.confirmedBy}
                      </span>
                    )}
                    {doc.docType === "BL01" && doc.blSurrenderedAt && (
                      <span style={{ fontFamily: T.body, fontSize: 11, color: T.success }}>
                        surrendered {fmtDate(doc.blSurrenderedAt)}{doc.blSurrenderedBy && ` by ${doc.blSurrenderedBy}`}
                      </span>
                    )}
                    {doc.docType === "BL01" && doc.blReleasedAt && (
                      <span style={{ fontFamily: T.body, fontSize: 11, color: T.success }}>
                        released {fmtDate(doc.blReleasedAt)}{doc.blReleasedBy && ` by ${doc.blReleasedBy}`}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5, flexShrink: 0, alignItems: "center", marginTop: 1 }}>
                  <Btn size="sm" variant="secondary" onClick={() => setPreviewDoc(doc)}>
                    👁 Preview
                  </Btn>
                  <Btn size="sm" variant="secondary"
                    onClick={() => api.documents.download(doc.id, doc.filename).catch(() => toast.error("Download failed"))}>
                    ↓
                  </Btn>
                  <Btn size="sm" variant="secondary" onClick={() => setSendDoc(doc)}>
                    ✉ Send
                  </Btn>
                  <Btn size="sm" variant="secondary" onClick={() => setEdiDoc(doc)}>
                    📡 EDI
                  </Btn>
                  <Btn size="sm" variant="secondary" onClick={() => setWebhookDoc(doc)}>
                    🔗 Webhook
                  </Btn>
                  <Btn size="sm" variant="secondary" onClick={() => setHistoryDoc(doc)}>
                    🕐
                  </Btn>
                  {canEdit && doc.status !== "confirmed" && (
                    <Btn size="sm" variant="secondary" onClick={() => handleConfirm(doc.id)}
                      style={{ color: T.success, borderColor: T.success + "66" }}>
                      ✓ Confirm
                    </Btn>
                  )}
                  {canEdit && doc.docType === "BL01" && doc.status === "confirmed" && !doc.blSurrenderedAt
                    && ["Telex Release", "Surrendered", "Seaway Bill"].includes(shipment.blReleaseType) && (
                    <Btn size="sm" variant="secondary" onClick={() => handleBlSurrender(doc.id)}>
                      Mark Surrendered
                    </Btn>
                  )}
                  {canEdit && doc.docType === "BL01" && doc.status === "confirmed" && !doc.blReleasedAt && (
                    <Btn size="sm" variant="secondary" onClick={() => handleBlRelease(doc.id)}>
                      Mark Released
                    </Btn>
                  )}
                  {canEdit && (
                    <Btn size="sm" variant="danger" onClick={() => handleDelete(doc.id)}>✕</Btn>
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
