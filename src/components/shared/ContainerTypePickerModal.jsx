import { useState } from "react";
import { T, CONTAINER_OPTIONS } from "../../tokens";
import { Field } from "../primitives/Form";
import { Modal } from "../primitives/Modal";

// ─── ContainerTypePickerModal ─────────────────────────────────────────────────
// Visual equipment picker grouped by 20ft / 40ft.
// Props:
//   current  — currently selected code string (e.g. "40DC") — highlights the row
//   onSelect — called with the full CONTAINER_OPTIONS entry on click; modal stays open
//   onClose  — called when modal should close

export const ContainerTypePickerModal = ({ current, onSelect, onClose }) => {
  const [hovered, setHovered] = useState(null);
  const groups = [
    { size: "20", teu: 1, items: CONTAINER_OPTIONS.filter(o => o.size === "20") },
    { size: "40", teu: 2, items: CONTAINER_OPTIONS.filter(o => o.size === "40") },
  ];

  return (
    <Modal title="Select Equipment Type" onClose={onClose} width={560}>
      {/* TEU info banner */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
        {[{ size: "20", teu: 1 }, { size: "40", teu: 2 }].map(({ size, teu }) => (
          <div key={size} style={{ flex: 1, background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: 8, padding: "10px 14px", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 800, color: T.accent }}>{size}ft</span>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text }}>{teu} TEU</div>
              <div style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>
                {size === "20" ? "Standard 20ft unit" : "Standard 40ft unit"}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Options grouped by size */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {groups.map(({ size, teu, items }) => (
          <div key={size}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                color: T.textMuted, textTransform: "uppercase", letterSpacing: ".08em" }}>
                {size}ft · {teu} TEU
              </span>
              <div style={{ flex: 1, height: 1, background: T.border, opacity: 0.4 }} />
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {items.map(opt => {
                const isSelected = current === opt.code;
                const isHovered  = hovered === opt.code;
                return (
                  <div key={opt.code}
                    onClick={() => { onSelect(opt); onClose(); }}
                    onMouseEnter={() => setHovered(opt.code)}
                    onMouseLeave={() => setHovered(null)}
                    style={{ display: "grid", gridTemplateColumns: "64px 160px 1fr",
                      alignItems: "center", gap: 12, padding: "10px 14px",
                      borderRadius: 8, cursor: "pointer",
                      background: isSelected ? T.accent + "18" : isHovered ? T.surfaceHover : T.surface,
                      border: `1px solid ${isSelected ? T.accent + "66" : isHovered ? T.border : T.border + "55"}`,
                      transition: "background .1s, border-color .1s" }}>
                    <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 800,
                      color: isSelected ? T.accent : T.text }}>
                      {opt.code}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.text }}>
                      {opt.label}
                    </span>
                    <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted, lineHeight: 1.4 }}>
                      {opt.desc}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
};

// ─── ContainerTypeField ───────────────────────────────────────────────────────
// Drop-in labelled field: button trigger + modal. Manages its own open state.
// Props:
//   size     — "20" | "40"
//   type     — "DC" | "HC" | "RF" | "OT" | "FR" | "TK"
//   onChange — called with { size, type, code, label, teu } on selection
//   required — shows red asterisk on label

export const ContainerTypeField = ({ size, type, onChange, required = false }) => {
  const [open, setOpen] = useState(false);
  const selected = CONTAINER_OPTIONS.find(o => o.size === size && o.type === type) || null;

  return (
    <Field label="Equipment Type" required={required}
      hint="Size, type and TEU — click to browse all options">
      <button type="button" onClick={() => setOpen(true)}
        style={{ width: "100%", display: "flex", alignItems: "center",
          justifyContent: "space-between", padding: "8px 12px", borderRadius: 6,
          cursor: "pointer", textAlign: "left", background: "none",
          border: `1px solid ${selected ? T.accent + "66" : T.border}`,
          transition: "border-color .12s" }}
        onMouseEnter={e => e.currentTarget.style.borderColor = T.accent}
        onMouseLeave={e => e.currentTarget.style.borderColor = selected ? T.accent + "66" : T.border}>
        {selected ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 800, color: T.accent }}>
              {selected.code}
            </span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.text }}>
              {selected.label}
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.textMuted,
              background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4,
              padding: "1px 7px" }}>
              {selected.teu} TEU
            </span>
          </div>
        ) : (
          <span style={{ fontFamily: T.body, fontSize: 13, color: T.border }}>
            Select equipment type…
          </span>
        )}
        <span style={{ fontFamily: T.mono, fontSize: 12, color: T.textMuted, flexShrink: 0 }}>▾</span>
      </button>

      {open && (
        <ContainerTypePickerModal
          current={selected?.code}
          onSelect={opt => onChange(opt)}
          onClose={() => setOpen(false)}
        />
      )}
    </Field>
  );
};

export default ContainerTypePickerModal;
