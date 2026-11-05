import { useState } from "react";
import { T } from "../../tokens";
import { IconUpload, IconDownload } from "../primitives/Icon";

export const EDI_STATUS_COLOR = {
  pending: "#6b7280", sent: "#3b82f6", acknowledged: "#3b82f6",
  confirmed: "#22c55e", accepted: "#22c55e", rejected: "#ef4444", error: "#ef4444",
  confirmed_with_changes: "#eab308",
  // A real carrier's DCSA booking states (TKT-KG4E49, 2026-10-09).
  received: "#3b82f6", update_sent: "#3b82f6", amendment_requested: "#3b82f6", update_requested: "#eab308",
  cancellation_requested: "#eab308", cancellation_declined: "#ef4444", amendment_declined: "#ef4444", send_failed: "#ef4444",
  amendment_confirmed: "#22c55e", completed: "#22c55e", cancelled: "#6b7280", amendment_cancelled: "#6b7280",
};

const fmtTs = iso => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) +
    " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
};

const payloadFor = m => {
  const raw = m.direction === "out" ? m.rawPayload : (m.parsedPayload || m.rawPayload);
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw || ""; }
};

// Plain message-thread rendering, lifted out of the old EdiMessagesDrawer so the Carrier
// Booking Details/Review pages (and the Test Tools simulator) can all reuse it instead of
// duplicating the same ~60 lines of JSX per consumer.
const EdiMessageList = ({ messages, emptyText = "No EDI messages yet." }) => {
  const [expandedId, setExpandedId] = useState(null);

  if (messages.length === 0) {
    return (
      <div style={{ fontFamily: T.body, fontSize: 13, color: T.textMuted,
        fontStyle: "italic", textAlign: "center", padding: "40px 0" }}>
        {emptyText}
      </div>
    );
  }

  // A shipment page (Trade Horizon, T.hz): each message is a card with a direction tile and a status
  // pill in the theme's status tones; the fixed hexes above only stand in for those tones there.
  if (T.hz) {
    const TONE = {
      "#22c55e": [T.successBg, T.successText], "#3b82f6": [T.infoBg, T.infoText], "#ef4444": [T.dangerBg, T.danger],
      "#eab308": [T.warningBg, T.warning], "#6b7280": [T.neutralBg, T.textMuted],
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.map(m => {
          const [pillBg, pillText] = TONE[EDI_STATUS_COLOR[m.status]] || [T.neutralBg, T.textMuted];
          const expanded = expandedId === m.id;
          const out = m.direction === "out";
          return (
            <div key={m.id} style={{ background: T.surface, border: `1px solid ${T.border}`, boxShadow: T.cardShadow,
              borderRadius: 10, padding: "11px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <span title={out ? "Sent" : "Received"} style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0,
                  background: out ? T.accentBg : T.purpleBg, color: out ? T.accent : T.purpleText,
                  display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {out ? <IconUpload size={14} /> : <IconDownload size={14} />}
                </span>
                <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                  <span style={{ fontFamily: T.body, fontSize: 12.5, fontWeight: 600, color: T.text }}>
                    {out ? "Sent" : "Received"} · <span style={{ fontFamily: T.mono, fontWeight: 500, color: T.textMuted }}>
                      {m.messageType.replace(/_/g, " ")}</span>
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textFaint }}>{fmtTs(m.createdAt)}</span>
                </div>
                <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 12 }}>
                  <button onClick={() => setExpandedId(expanded ? null : m.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                      fontFamily: T.body, fontSize: 12, fontWeight: 600, color: T.accent }}>
                    {expanded ? "Hide payload" : "View payload"}
                  </button>
                  <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: ".06em",
                    color: pillText, background: pillBg, borderRadius: 5, padding: "3px 8px", textTransform: "uppercase" }}>
                    {m.status}{m.isMock ? " · demo" : ""}
                  </span>
                </span>
              </div>
              {expanded && (
                <pre style={{ margin: "10px 0 0", fontFamily: T.mono, fontSize: 10.5, color: T.text,
                  background: T.bg, border: `1px solid ${T.border}`, borderRadius: 7,
                  padding: "10px 12px", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {payloadFor(m)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {messages.map(m => {
        const color = EDI_STATUS_COLOR[m.status] || T.textMuted;
        const expanded = expandedId === m.id;
        return (
          <div key={m.id} style={{ background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.body, fontSize: 12, fontWeight: 700, color: T.text,
                display: "inline-flex", alignItems: "center", gap: 4 }}>
                {m.direction === "out" ? <><IconUpload size={11} />Sent</> : <><IconDownload size={11} />Received</>}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted }}>
                {m.messageType.replace(/_/g, " ")}
              </span>
              <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                color, background: `${color}18`, border: `1px solid ${color}44`,
                borderRadius: 4, padding: "1px 7px", textTransform: "uppercase" }}>
                {m.status}{m.isMock ? " · demo" : ""}
              </span>
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.textMuted, marginBottom: 8 }}>
              {fmtTs(m.createdAt)}
            </div>
            <button onClick={() => setExpandedId(expanded ? null : m.id)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0,
                fontFamily: T.body, fontSize: 11, color: T.accent, textDecoration: "underline dotted" }}>
              {expanded ? "Hide payload" : "View payload"}
            </button>
            {expanded && (
              <pre style={{ marginTop: 8, fontFamily: T.mono, fontSize: 10.5, color: T.text,
                background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6,
                padding: "10px 12px", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {payloadFor(m)}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default EdiMessageList;
