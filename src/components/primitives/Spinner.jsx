import { useEffect } from "react";
import { T } from "../../tokens";
import { IconAnchor } from "./Icon";

// Inject keyframe once
if (!document.getElementById("cd-spinner-style")) {
  const s = document.createElement("style");
  s.id = "cd-spinner-style";
  s.textContent = `@keyframes cd-spin { to { transform: rotate(360deg) } }`;
  document.head.appendChild(s);
}

// ─── Spinner ─────────────────────────────────────────────────────────────────
// size: "sm" (16px) | "md" (24px, default) | "lg" (40px) | "xl" (64px)
// color: any CSS color — defaults to T.accent
// label: optional screen-reader / caption text shown below (lg/xl only)

const SIZES = { sm: 16, md: 24, lg: 40, xl: 64 };
const WIDTHS = { sm: 2, md: 2.5, lg: 3.5, xl: 4 };

const Spinner = ({ size = "md", color, label, style: extraStyle }) => {
  const px  = SIZES[size]  ?? 24;
  const bw  = WIDTHS[size] ?? 2.5;
  const clr = color ?? T.accent;

  return (
    <div style={{ display: "inline-flex", flexDirection: "column",
      alignItems: "center", gap: 10, ...extraStyle }}>
      <div style={{
        width: px, height: px, borderRadius: "50%",
        border: `${bw}px solid ${clr}22`,
        borderTopColor: clr,
        animation: "cd-spin .7s linear infinite",
        flexShrink: 0,
      }} />
      {label && (
        <span style={{ fontFamily: T.body, fontSize: 13,
          color: T.textMuted, whiteSpace: "nowrap" }}>
          {label}
        </span>
      )}
    </div>
  );
};

// ─── FullPageSpinner — centred overlay for initial app load ───────────────────

export const FullPageSpinner = ({ label = "Loading CargoDesk…" }) => (
  <div style={{
    position: "fixed", inset: 0, background: T.bg,
    display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center", gap: 20, zIndex: 9999,
  }}>
    <div style={{ fontFamily: T.head, fontSize: 28, fontWeight: 800,
      color: T.text, letterSpacing: "-.02em",
      display: "flex", alignItems: "center", gap: 10 }}><IconAnchor size={28} />CargoDesk</div>
    <Spinner size="lg" />
    <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
      {label}
    </span>
  </div>
);

// ─── PageSpinner — centred within a page/section content area ─────────────────

export const PageSpinner = ({ label = "Loading…" }) => (
  <div style={{ display: "flex", flexDirection: "column",
    alignItems: "center", justifyContent: "center",
    padding: "60px 20px", gap: 14 }}>
    <Spinner size="md" />
    <span style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
      {label}
    </span>
  </div>
);

export default Spinner;