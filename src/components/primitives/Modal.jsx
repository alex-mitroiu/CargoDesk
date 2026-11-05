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

// keepAdvanceBar: while this modal is open, the shipment pages' » Advance bar is lifted above its
// backdrop (ShipmentAdvanceBar reads the root attribute). Only for a page's prerequisite lock
// (CarrierBookingGateModal, CustomsFilingGateModal): a locked page is still a stop in the tree, and
// » must be able to move on from it. Every other dialog covers the bar, so » never leaves one half-done.
const useAdvanceBarOverModal = on => {
  useEffect(() => {
    if (!on) return undefined;
    const root = document.documentElement;
    root.setAttribute("data-advance-bar-over-modal", "");
    return () => root.removeAttribute("data-advance-bar-over-modal");
  }, [on]);
};

const Modal = ({ title, onClose, children, width = 520, minHeight, hideClose = false, keepAdvanceBar = false,
  "data-testid": testId }) => {
  useBodyScrollLock();
  useEscapeToClose(onClose, hideClose);
  useAdvanceBarOverModal(keepAdvanceBar);
  // Trade Horizon pages (T.hz): the solid HZ surface on the stronger border, HZ's soft popover shadow,
  // a lighter, blurred backdrop in light mode, and a bordered close button.
  const hz = T.hz;
  return (
  <div style={{ position: "fixed", inset: 0, background: T.backdrop, display: "flex",
      backdropFilter: hz ? "blur(3px)" : undefined,
      alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 20 }}>
    <div data-testid={testId} style={{ background: T.surface, border: `1px solid ${hz ? T.borderMid : T.border}`, borderRadius: hz ? 14 : 12,
      width: "100%", maxWidth: width, maxHeight: "90vh", overflowY: "auto",
      minHeight: minHeight ?? undefined,
      boxShadow: hz ? T.popoverShadow : "0 30px 70px rgba(0,0,0,.65)" }}>
      <div style={{ padding: "18px 24px", borderBottom: `1px solid ${T.border}`,
        display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={{ fontFamily: T.head, fontSize: hz ? 17 : 18, fontWeight: 700, color: T.text, margin: 0 }}>{title}</h2>
        {!hideClose && (
          <button onClick={onClose} style={hz ? {
            background: "none", border: `1px solid ${T.border}`, color: T.textMuted, cursor: "pointer",
            width: 30, height: 30, borderRadius: 8, fontSize: 18, lineHeight: 1, padding: 0,
            display: "flex", alignItems: "center", justifyContent: "center", transition: "color 0.14s",
          } : { background: "none", border: "none", color: T.textMuted,
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