import { useState } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";

// EDI distribution — a formal transmittal record only (this app's EDI has always been
// simulated/structured-JSON, no attachment concept anywhere in edi_messages); the "recipient" is
// free text since a document's EDI counterparty isn't always a carrier (a Certificate of Origin
// might go to a customs broker), mirroring carrier_code's own established loose-text convention.
const SendDocumentEdiModal = ({ shipment, doc, onClose }) => {
  const [recipientCode,  setRecipientCode]  = useState("");
  const [recipientLabel, setRecipientLabel] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!recipientCode.trim()) return toast.error("A recipient code is required");
    setSending(true);
    try {
      await api.documents.sendEdi(shipment.id, doc.id, { recipientCode: recipientCode.trim(), recipientLabel: recipientLabel.trim() });
      toast.success(`EDI transmittal sent to ${recipientCode.trim()}`);
      onClose();
    } catch (ex) { toast.error(ex.message); } finally { setSending(false); }
  };

  return (
    <Modal title={`Send via EDI — ${doc.filename}`} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted,
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px" }}>
          Records a formal EDI transmittal (document metadata + checksum, simulated — no real EDI
          network integration) via the Document Distribution Service.
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Recipient Code <span style={{ color: T.danger }}>*</span></div>
          <input value={recipientCode} onChange={e => setRecipientCode(e.target.value)} placeholder="e.g. MAEU, or a customs broker code"
            style={{ width: "100%", fontFamily: T.mono, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", boxSizing: "border-box" }} />
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Recipient Label (optional)</div>
          <input value={recipientLabel} onChange={e => setRecipientLabel(e.target.value)} placeholder="e.g. Maersk Line"
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", boxSizing: "border-box" }} />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleSend} disabled={sending || !recipientCode.trim()}>{sending ? "Sending…" : "Send →"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

export default SendDocumentEdiModal;
