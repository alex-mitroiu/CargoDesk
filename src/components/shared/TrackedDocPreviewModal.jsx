import { useState, useEffect } from "react";
import { api } from "../../api";
import { toast } from "../../toast";
import Btn from "../primitives/Btn";
import { Modal } from "../primitives/Modal";
import { HZ, HZ_MONO, HZ_BODY } from "../../pages/shipments/shipmentDetailTheme";

const fmtDate = s => s ? new Date(s).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" }) : "—";

// ─── Tracked Document Preview Modal ───────────────────────────────────────────
// Previews a document from the TRACKED shipment_documents system (mapDoc shape —
// id/docType/filename/status/isStale/confirmedBy/confirmedAt/etc). Fetches
// GET /api/documents/:id/download as a blob and renders it in an iframe — no
// forced download, no separate metadata endpoint needed. Extracted from App.jsx
// so both App.jsx's DocumentsModal and the Accounting Invoice Entry page can use
// it without a circular import. Both are now Trade Horizon (HZ) pages, and this
// has no other consumer, so it moved to HZ tokens alongside them.
//
// NOT the same component as the same-named DocumentPreviewModal in
// ShipmentDetailPage.jsx, which belongs to the separate untracked jsPDF document
// system (dataUri prop, no server round-trip) — see ARCHITECTURE.md M10.
const TrackedDocPreviewModal = ({ shipmentId, doc, onClose, onConfirm, onSend }) => {
  const [src,        setSrc]        = useState(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("cargodesk_token");
    fetch(`/api/shipments/${shipmentId}/documents/${doc.id}/download`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.blob())
      .then(blob => setSrc(URL.createObjectURL(blob)))
      .catch(() => toast.error("Preview failed — try Download instead"));
    return () => { setSrc(s => { if (s) URL.revokeObjectURL(s); return null; }); };
  }, [shipmentId, doc.id]);

  const handleConfirm = async () => {
    setConfirming(true);
    await onConfirm?.();
    setConfirming(false);
  };

  const isConfirmed = doc.status === "confirmed";

  return (
    <Modal title={`${doc.docType} · ${doc.filename}`} onClose={onClose} width={960}>
      {/* Status bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        marginBottom: 12, padding: "8px 12px",
        background: isConfirmed ? HZ.goodBg : doc.isStale ? HZ.warnBg : HZ.bg,
        border: `1px solid ${isConfirmed ? HZ.good + "44" : doc.isStale ? HZ.warn + "44" : HZ.border}`,
        borderRadius: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: HZ_MONO, fontSize: 11, fontWeight: 700,
            color: isConfirmed ? HZ.good : doc.isStale ? HZ.warn : HZ.textMuted }}>
            {isConfirmed ? "✓ Confirmed" : doc.isStale ? "⚠ Outdated" : "Draft"}
          </span>
          {isConfirmed && doc.confirmedBy && (
            <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>
              by {doc.confirmedBy} · {fmtDate(doc.confirmedAt)}
            </span>
          )}
          {doc.isStale && (
            <span style={{ fontFamily: HZ_BODY, fontSize: 11, color: HZ.textMuted }}>
              Shipment data changed after this document was generated
            </span>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Btn size="sm" variant="secondary"
            onClick={() => api.documents.download(shipmentId, doc.id, doc.filename).catch(() => toast.error("Download failed"))}>
            ↓ Download
          </Btn>
          {onSend && (
            <Btn size="sm" variant="secondary" onClick={onSend}>✉ Send</Btn>
          )}
          {onConfirm && !isConfirmed && (
            <Btn size="sm" onClick={handleConfirm} disabled={confirming}>
              {confirming ? "Confirming…" : "✓ Confirm Document"}
            </Btn>
          )}
        </div>
      </div>

      {src
        ? <iframe src={src} title={doc.filename}
            style={{ width: "100%", height: "68vh", border: "none", borderRadius: 6, background: "#fff" }} />
        : <div style={{ height: "68vh", display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: HZ_BODY, fontSize: 13, color: HZ.textMuted }}>Loading preview…</div>}
    </Modal>
  );
};

export default TrackedDocPreviewModal;
