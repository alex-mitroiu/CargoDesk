import { useState } from "react";
import { T, INCOTERMS_2020 } from "../../tokens";
import { Modal } from "../primitives/Modal";

// ─── Incoterms Modal ──────────────────────────────────────────────────────────


const IncotermsModal = ({ onClose }) => {
  const [active, setActive] = useState(null);
  const anyMode = INCOTERMS_2020.filter(t => t.scope === "any");
  const seaMode = INCOTERMS_2020.filter(t => t.scope === "sea");

  const termRow = (t) => (
    <div key={t.code} onClick={() => setActive(active?.code === t.code ? null : t)}
      style={{ borderBottom: `1px solid ${T.border}22`, cursor: "pointer",
        background: active?.code === t.code ? T.accentBg : "transparent",
        transition: "background .12s" }}
      onMouseEnter={e => { if (active?.code !== t.code) e.currentTarget.style.background = T.surfaceHover; }}
      onMouseLeave={e => { if (active?.code !== t.code) e.currentTarget.style.background = "transparent"; }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px" }}>
        <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 800, color: T.accent, width: 36, flexShrink: 0 }}>{t.code}</span>
        <span style={{ fontFamily: T.body, fontSize: 14, fontWeight: 600, color: T.text, flex: 1 }}>{t.name}</span>
        <span style={{ fontFamily: T.body, fontSize: 11, color: T.textMuted }}>{active?.code === t.code ? "▲" : "▼"}</span>
      </div>
      {active?.code === t.code && (
        <div style={{ padding: "0 16px 14px 64px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <span style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em" }}>Risk Transfer — </span>
            <span style={{ fontFamily: T.body, fontSize: 13, color: T.warning }}>{t.risk}</span>
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 2 }}>Seller obligations</div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6 }}>{t.seller}</div>
          </div>
          <div>
            <div style={{ fontFamily: T.body, fontSize: 10.5, color: T.textMuted, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".07em", marginBottom: 2 }}>Buyer obligations</div>
            <div style={{ fontFamily: T.body, fontSize: 13, color: T.text, lineHeight: 1.6 }}>{t.buyer}</div>
          </div>
          <div style={{ background: T.bg, borderRadius: 6, padding: "8px 12px", fontFamily: T.body, fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
            💡 {t.notes}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <Modal title="Incoterms® 2020 Reference" onClose={onClose} width={640}>
      <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginBottom: 16, lineHeight: 1.6 }}>
        International Commercial Terms published by the International Chamber of Commerce (ICC).
        Click any term to expand its obligations and risk transfer point.
      </div>

      <div style={{ marginBottom: 6, fontFamily: T.mono, fontSize: 10, color: T.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".1em" }}>All Transport Modes</div>
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden", marginBottom: 16 }}>
        {anyMode.map(termRow)}
      </div>

      <div style={{ marginBottom: 6, fontFamily: T.mono, fontSize: 10, color: T.textMuted, fontWeight: 700,
        textTransform: "uppercase", letterSpacing: ".1em" }}>Sea &amp; Inland Waterway Only</div>
      <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, overflow: "hidden" }}>
        {seaMode.map(termRow)}
      </div>

      <div style={{ marginTop: 14, fontFamily: T.body, fontSize: 11, color: T.border, lineHeight: 1.5 }}>
        Incoterms® is a registered trademark of the ICC. This reference is provided for informational purposes only.
      </div>
    </Modal>
  );
};

export default IncotermsModal;