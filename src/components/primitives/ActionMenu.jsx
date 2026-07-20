import { useState, useEffect, useRef } from "react";
import { T } from "../../tokens";
import { IconSettings } from "./Icon";

const ActionMenu = ({ items }) => {
  if (!items || items.length === 0) return null;
  const [open, setOpen] = useState(false);
  const [pos,  setPos]  = useState({ top: 0, left: 0 });
  const btnRef  = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = e => {
      if (!menuRef.current?.contains(e.target) && !btnRef.current?.contains(e.target))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const handleOpen = () => {
    const r = btnRef.current.getBoundingClientRect();
    // Align right edge of menu with right edge of button
    setPos({ top: r.bottom + 4, left: r.right - 170 });
    setOpen(o => !o);
  };

  return (
    <>
      <button ref={btnRef} type="button" onClick={handleOpen}
        style={{
          background: "none", border: `1px solid ${T.border}`, borderRadius: 6,
          color: T.textMuted, cursor: "pointer", padding: "5px 10px",
          fontSize: 14, fontFamily: T.body, lineHeight: 1,
          display: "flex", alignItems: "center",
          transition: "border-color .12s, color .12s, background .12s",
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.color = T.accent; e.currentTarget.style.background = T.accentBg; }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.textMuted; e.currentTarget.style.background = "none"; }}>
        <IconSettings size={14} />
      </button>
      {open && (
        <div ref={menuRef}
          style={{
            position: "fixed", top: pos.top, left: pos.left, zIndex: 9999,
            background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8,
            boxShadow: "0 4px 20px rgba(0,0,0,.18)", minWidth: 170, overflow: "hidden",
          }}>
          {items.map((item, i) => (
            <button key={i} type="button"
              onClick={() => { setOpen(false); item.onClick(); }}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", textAlign: "left",
                padding: "10px 14px", background: "none", border: "none",
                fontFamily: T.body, fontSize: 13, cursor: "pointer",
                color: item.variant === "danger" ? T.danger : T.text,
                borderBottom: i < items.length - 1 ? `1px solid ${T.border}22` : "none",
              }}
              onMouseEnter={e => e.currentTarget.style.background = T.surfaceHover}
              onMouseLeave={e => e.currentTarget.style.background = "none"}>
              {item.icon && <span style={{ fontSize: 13, opacity: .7 }}>{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
};

export default ActionMenu;
