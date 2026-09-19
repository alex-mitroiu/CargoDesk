import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { Modal, ConfirmModal } from "./Modal";

// Escape-to-close on the shared Modal. The cases that matter are the ones where closing would be
// WRONG: a modal underneath another, a non-dismissible modal, and an Escape that a dropdown or
// calendar inside the modal already used to close itself.

// fireEvent returns false when the event's default was prevented.
const esc = (target = document.body, init = {}) => fireEvent.keyDown(target, { key: "Escape", ...init });

describe("Modal — Escape to close", () => {
  it("calls onClose on Escape, and only for Escape", () => {
    const onClose = vi.fn();
    render(<Modal title="T" onClose={onClose}><p>body</p></Modal>);
    fireEvent.keyDown(document.body, { key: "Enter" });
    fireEvent.keyDown(document.body, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("uses the same onClose the × button uses, so a caller's guard applies to Escape too", () => {
    let busy = true;
    const inner = vi.fn();
    render(<Modal title="T" onClose={() => !busy && inner()}><p>body</p></Modal>);
    esc();
    expect(inner).not.toHaveBeenCalled();      // a busy modal stays open, exactly as with ×
    busy = false;
    esc();
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("does NOT close a hideClose modal — the caller gave the user no way to dismiss it", () => {
    const onClose = vi.fn();
    render(<Modal title="Server Shutting Down" onClose={onClose} hideClose><p>body</p></Modal>);
    esc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes only the TOPMOST of two stacked modals, then the one beneath on the next Escape", () => {
    const outer = vi.fn(), inner = vi.fn();
    const ui = showInner => (
      <>
        <Modal key="outer" title="Outer" onClose={outer}><p>form</p></Modal>
        {showInner && <Modal key="inner" title="Picker" onClose={inner}><p>picker</p></Modal>}
      </>
    );
    const { rerender } = render(ui(true));
    esc();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();       // the form underneath survives the picker's Escape

    rerender(ui(false));                          // the picker is gone
    esc();
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("a non-dismissible modal on top shields the closable one beneath it", () => {
    const outer = vi.fn();
    render(
      <>
        <Modal title="Outer" onClose={outer}><p>form</p></Modal>
        <Modal title="Shutting down" onClose={() => {}} hideClose><p>wait</p></Modal>
      </>
    );
    esc();
    expect(outer).not.toHaveBeenCalled();
  });

  it("ignores an Escape a popup inside the modal already handled; the NEXT Escape closes it", () => {
    const onClose = vi.fn();
    const { getByPlaceholderText } = render(
      <Modal title="T" onClose={onClose}>
        {/* stands in for a combobox: closes its dropdown on Escape and marks the key handled */}
        <input placeholder="carrier" onKeyDown={e => { if (e.key === "Escape") e.preventDefault(); }} />
      </Modal>
    );
    esc(getByPlaceholderText("carrier"));
    expect(onClose).not.toHaveBeenCalled();     // first Escape: the dropdown, not the modal
    esc();                                        // nothing handled it this time
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("marks the key handled itself, so one Escape cannot also be acted on by something outside", () => {
    render(<Modal title="T" onClose={() => {}}><p>body</p></Modal>);
    expect(esc()).toBe(false);
  });

  it("does not react to Escape while an IME is composing", () => {
    const onClose = vi.fn();
    render(<Modal title="T" onClose={onClose}><p>body</p></Modal>);
    esc(document.body, { isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted, and always calls the latest onClose", () => {
    const first = vi.fn(), second = vi.fn();
    const { rerender, unmount } = render(<Modal title="T" onClose={first}><p>body</p></Modal>);
    rerender(<Modal title="T" onClose={second}><p>body</p></Modal>);
    esc();
    expect(first).not.toHaveBeenCalled();       // not a stale closure over the first render's prop
    expect(second).toHaveBeenCalledTimes(1);
    unmount();
    esc();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("ConfirmModal: Escape cancels and never confirms", () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    render(<ConfirmModal message="Delete this?" onConfirm={onConfirm} onCancel={onCancel} />);
    esc();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
