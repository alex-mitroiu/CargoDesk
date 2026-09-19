import { useEffect, useRef } from "react";
import { T } from "../../tokens";
import Btn from "./Btn";

// Reference-counted body-scroll lock — a wheel/trackpad scroll with the pointer over a modal
// (its backdrop, or content too short to need its own scroll) would otherwise fall through to
// whatever ancestor IS scrollable. That's NOT document.body in this app — App.jsx's own <main
// id="app-scroll-main"> is the element that actually scrolls the page behind every modal, with
// body itself never overflowing — so this locks that element (falling back to body when it's
// absent, e.g. a component test rendering a Modal outside the full App shell). Counted rather
// than a flat on/off so two modals stacked at once (e.g. a picker opened from within another
// modal) don't have the first one's close prematurely re-enable page scroll while the second is
// still up.
let lockCount = 0;
let previousOverflow = "";
const useBodyScrollLock = () => {
  useEffect(() => {
    const el = document.getElementById("app-scroll-main") || document.body;
    if (lockCount === 0) { previousOverflow = el.style.overflow; el.style.overflow = "hidden"; }
    lockCount++;
    return () => { lockCount--; if (lockCount === 0) el.style.overflow = previousOverflow; };
  }, []);
};

// Escape closes the topmost modal — never one underneath it, so a picker opened from inside a form
// closes on its own Escape and leaves the form. Three things deliberately do NOT close it:
//   • hideClose modals: the caller gave the user no way to dismiss it (server shutting down, "Demo
//     Data Reset" whose onClose forces a logout), so Escape must not be a back door.
//   • an Escape a popup inside the modal already handled (event.defaultPrevented): the comboboxes and
//     DatePicker close their own dropdown/calendar on the first Escape and call preventDefault, so
//     the SECOND Escape is the one that closes the modal.
//   • IME composition.
// It calls the same onClose the × button does, so a caller's guard (e.g. `() => !busy && onClose()`)
// applies to Escape too. Like ×, it discards unsaved edits — there is no dirty-form check anywhere here.
const modalStack = [];
const useEscapeToClose = (onClose, hideClose) => {
  const latest = useRef({ onClose, hideClose });
  latest.current = { onClose, hideClose };
  useEffect(() => {
    const token = {};
    modalStack.push(token);
    const onKey = e => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (modalStack[modalStack.length - 1] !== token) return;
      if (latest.current.hideClose) return;
      e.preventDefault();
      latest.current.onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
    };
  }, []);
};

const Modal = ({ title, onClose, children, width = 520, minHeight, hideClose = false, "data-testid": testId }) => {
  useBodyScrollLock();
  useEscapeToClose(onClose, hideClose);
  return (
  <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.78)", display: "flex",
      alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
    <div data-testid={testId} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12,
      width: "100%", maxWidth: width, maxHeight: "90vh", overflowY: "auto",
      minHeight: minHeight ?? undefined,
      boxShadow: "0 30px 70px rgba(0,0,0,.65)" }}>
      <div style={{ padding: "18px 24px", borderBottom: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontFamily: T.head, fontSize: 18, fontWeight: 700, color: T.text, margin: 0 }}>{title}</h2>
        {!hideClose && (
          <button onClick={onClose} style={{ background: "none", border: "none", color: T.textMuted,
            cursor: "pointer", fontSize: 22, lineHeight: 1, padding: "0 4px",
            borderRadius: 4, transition: "color 0.14s" }}
            onMouseEnter={e => e.currentTarget.style.color = T.text}
            onMouseLeave={e => e.currentTarget.style.color = T.textMuted}>×</button>
        )}
      </div>
      <div style={{ padding: "22px 24px" }}>{children}</div>
    </div>
  </div>
  );
};

const ConfirmModal = ({ message, onConfirm, onCancel, confirmLabel = "Confirm Delete" }) => (
  <Modal title="Confirm" onClose={onCancel} width={380}>
    <p style={{ fontFamily: T.body, fontSize: 14, color: T.text, margin: "0 0 20px", lineHeight: 1.6 }}>{message}</p>
    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
      <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
      <Btn variant="danger" onClick={onConfirm}>{confirmLabel}</Btn>
    </div>
  </Modal>
);

// ─── Shared: Contract Type Picker ─────────────────────────────────────────────

export { Modal, ConfirmModal };