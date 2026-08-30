import { useState } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";

// Webhook distribution — no recipient input, everything resolves server-side from the shipment's
// EMO office's configured webhook (Document Distribution Service). A confirm-style modal rather
// than a silent one-click action, so a mis-click doesn't fire a real external HTTP POST unseen.
const SendDocumentWebhookModal = ({ shipment, doc, onClose }) => {
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    setSending(true);
    try {
      await api.documents.sendWebhook(shipment.id, doc.id);
      toast.success("Webhook delivered");
      onClose();
    } catch (ex) { toast.error(ex.message); } finally { setSending(false); }
  };

  return (
    <Modal title={`Send via Webhook — ${doc.filename}`} onClose={onClose} width={440}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted,
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px" }}>
          Delivers to <strong>{shipment.emoOfficeName || "the shipment's Export Managing Office"}</strong>'s
          configured webhook{shipment.emoOfficeName ? "" : " — configure it under Parties & Offices if unset"},
          via a signed, expiring download link. Configure the webhook URL under the office's Webhook
          Settings first.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleSend} disabled={sending}>{sending ? "Sending…" : "Send →"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

export default SendDocumentWebhookModal;
