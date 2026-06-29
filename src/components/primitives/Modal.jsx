import { T } from "../../tokens";
import Btn from "./Btn";

const Modal = ({ title, onClose, children, width = 520, minHeight }) => (
  <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
      width: "100%", maxWidth: width, maxHeight: "90vh", overflowY: "auto",
      minHeight: minHeight ?? undefined,
      boxShadow: "0 30px 70px rgba(0,0,0,.65)" }}>
      <div style={{ padding: "18px 24px", borderBottom: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontFamily: T.head, fontSize: 18, fontWeight: 700, color: T.text, margin: 0 }}>{title}</h2>
        <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted,
          cursor: "pointer", fontSize: 22, lineHeight: 1, padding: "0 4px",
          borderRadius: 4, transition: "color 0.14s" }}
          onMouseEnter={e => e.currentTarget.style.color = T.text}
          onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>×</button>
      </div>
      <div style={{ padding: "22px 24px" }}>{children}</div>
    </div>
  </div>
);

const ConfirmModal = ({ message, onConfirm, onCancel }) => (
  <Modal title="Confirm" onClose={onCancel} width={380}>
    <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, margin: "0 0 20px", lineHeight: 1.6 }}>{message}</p>
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
      <Btn variant="danger" onClick={onConfirm}>Confirm Delete</Btn>
    </div>
  </Modal>
);

// ─── Shared: Contract Type Picker ─────────────────────────────────────────────

export { Modal, ConfirmModal };