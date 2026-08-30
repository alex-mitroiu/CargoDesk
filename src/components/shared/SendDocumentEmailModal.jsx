import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { toast } from "../../toast";
import { Modal } from "../primitives/Modal";
import Btn from "../primitives/Btn";
import { docTypeLabel } from "../../utils/documentBuilders";

// ─── Send Document Email Modal ─────────────────────────────────────────────────
// Always sends from the shipment's EMO (Export Managing Office) — a direct scope decision,
// not a user-facing office picker (see the shipped plan). Recipient candidates mirror
// GenerateDocumentModal.handlePreview's existing party-resolution pattern just below.

const SendDocumentEmailModal = ({ shipment, doc, onClose }) => {
  const [candidates, setCandidates] = useState([]);
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [to,          setTo]          = useState("");
  const [customMode,  setCustomMode]  = useState(false);
  const [subject,     setSubject]     = useState(`${docTypeLabel(doc.docType)} — ${shipment.id}`);
  const [message,     setMessage]     = useState(`Please find attached the ${docTypeLabel(doc.docType)} for shipment ${shipment.id}.`);
  const [sending,     setSending]     = useState(false);

  useEffect(() => {
    (async () => {
      const fixedRoles = [
        ["Shipper", shipment.shipperId, shipment.shipperName],
        ["Consignee", shipment.consigneeId, shipment.consigneeName],
        ["Notify Party", shipment.notifyId, shipment.notifyName],
        ["Principal", shipment.principalId, shipment.principalName],
      ].filter(([, id]) => id);
      const parties = await api.shipmentParties.list(shipment.id).catch(() => []);
      const allRefs = [...fixedRoles, ...parties.map(p => [p.role, p.customerId, p.customerName])];
      const resolved = await Promise.all(allRefs.map(async ([role, customerId, name]) => {
        const cust = await api.customers.get(customerId).catch(() => null);
        return cust?.email ? { role, name: name || cust.companyName, email: cust.email } : null;
      }));
      const list = resolved.filter(Boolean);
      setCandidates(list);
      if (list.length) setTo(list[0].email); else setCustomMode(true);
      setLoadingCandidates(false);
    })();
  }, [shipment.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = async () => {
    if (!to.trim()) return toast.error("A recipient email address is required");
    setSending(true);
    try {
      await api.documents.sendEmail(shipment.id, doc.id, { to: to.trim(), subject, message });
      toast.success(`Sent to ${to.trim()}`);
      onClose();
    } catch (ex) { toast.error(ex.message); } finally { setSending(false); }
  };

  return (
    <Modal title={`Send — ${doc.filename}`} onClose={onClose} width={480}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ fontFamily: T.body, fontSize: 11.5, color: T.textMuted,
          background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px" }}>
          Sends from <strong>{shipment.emoOfficeName || "the shipment's Export Managing Office"}</strong>
          {shipment.emoOfficeName ? "" : " — configure it under Parties & Offices if unset"}.
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 6 }}>To</div>
          {!customMode && candidates.length > 0 ? (
            <select value={to} onChange={e => { if (e.target.value === "__custom__") { setCustomMode(true); setTo(""); } else setTo(e.target.value); }}
              style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
                border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", cursor: "pointer" }}>
              {candidates.map(c => <option key={c.role} value={c.email}>{c.role}: {c.name} &lt;{c.email}&gt;</option>)}
              <option value="__custom__">Other (enter manually)…</option>
            </select>
          ) : (
            <input type="email" value={to} onChange={e => setTo(e.target.value)} placeholder="recipient@example.com"
              style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
                border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", boxSizing: "border-box" }} />
          )}
          {!loadingCandidates && candidates.length === 0 && (
            <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginTop: 4 }}>
              No party on this shipment has an email on file — enter one manually.
            </div>
          )}
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Subject</div>
          <input value={subject} onChange={e => setSubject(e.target.value)}
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", boxSizing: "border-box" }} />
        </div>
        <div>
          <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, marginBottom: 4 }}>Message</div>
          <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4}
            style={{ width: "100%", fontFamily: T.body, fontSize: 13, background: T.surface, color: T.text,
              border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", resize: "vertical", boxSizing: "border-box" }} />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
          <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
          <Btn onClick={handleSend} disabled={sending || !to.trim()}>{sending ? "Sending…" : "Send →"}</Btn>
        </div>
      </div>
    </Modal>
  );
};

export default SendDocumentEmailModal;
