import { useState, useEffect } from "react";
import { T } from "../../tokens";
import { api } from "../../api";
import { Modal } from "../primitives/Modal";
import { PageSpinner } from "../primitives/Spinner";

// ─── Loop Route Modal ──────────────────────────────────────────────────────────
// Opened from ShipmentHeaderBar's Loop field. A shipment's loop is a plain derived string
// (src/utils/scheduleLoop.js's deriveLoopCode) with no FK into the loop_codes registry, so a
// miss is expected/normal — rendered as an honest "not registered yet" state, not an error.

const Timeline = ({ ports, polCode, podCode }) => {
  const n = ports.length;
  const W = 900, H = 220, marginX = 60;
  const step = n > 1 ? (W - 2 * marginX) / (n - 1) : 0;
  const y = H / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block",
      background: T.bg, borderRadius: 10 }} role="img"
      aria-label={`Rotation: ${ports.map(p => p.portUnlocode).join(" → ")}, back to ${ports[0]?.portUnlocode}`}>
      <line x1={marginX} y1={y} x2={marginX + step * (n - 1)} y2={y} stroke={T.accent} strokeWidth={3} />
      <polygon points={`${marginX + step * (n - 1)},${y} ${marginX + step * (n - 1) - 14},${y - 7} ${marginX + step * (n - 1) - 14},${y + 7}`} fill={T.accent} />
      {ports.map((p, i) => {
        const cx = marginX + step * i;
        const above = i % 2 === 0;
        const isHub = p.portUnlocode === polCode || p.portUnlocode === podCode;
        return (
          <g key={`${p.portUnlocode}-${i}`}>
            <circle cx={cx} cy={y} r={isHub ? 7 : 5.5} fill={isHub ? T.text : T.accent} stroke={T.bg} strokeWidth={2} />
            <text x={cx} y={above ? y - 22 : y + 40} textAnchor="middle"
              fontFamily={T.mono} fontSize={11} fill={T.text}>{p.portUnlocode}</text>
            <text x={cx} y={above ? y - 38 : y + 56} textAnchor="middle"
              fontFamily={T.body} fontSize={8.5} fill={T.textMuted}>{p.portName}</text>
            {p.transitDayOffset != null && (
              <text x={cx} y={above ? y + 18 : y - 14} textAnchor="middle"
                fontFamily={T.mono} fontSize={10} fill={T.textMuted}>D{p.transitDayOffset}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

const LoopRouteModal = ({ code, polCode, podCode, onClose }) => {
  const [loop, setLoop] = useState(undefined); // undefined = loading, null = not found

  useEffect(() => {
    let live = true;
    api.loopCodes.resolve(code).then(r => { if (live) setLoop(r); }).catch(() => { if (live) setLoop(null); });
    return () => { live = false; };
  }, [code]);

  const currentLeg = loop && polCode && podCode
    ? loop.ports.find(p => p.portUnlocode === polCode)?.portName && loop.ports.find(p => p.portUnlocode === podCode)?.portName
      ? `${loop.ports.find(p => p.portUnlocode === polCode).portName} → ${loop.ports.find(p => p.portUnlocode === podCode).portName}`
      : null
    : null;

  return (
    <Modal title={`Loop ${code}`} onClose={onClose} width={720}>
      {loop === undefined ? (
        <PageSpinner />
      ) : loop === null ? (
        <div style={{ padding: "24px 4px", textAlign: "center" }}>
          <div style={{ fontFamily: T.body, fontSize: 13.5, color: T.textMuted, lineHeight: 1.6 }}>
            No route data registered for loop <span style={{ fontFamily: T.mono, color: T.accent }}>{code}</span>.
          </div>
          <div style={{ fontFamily: T.body, fontSize: 12, color: T.textMuted, marginTop: 6 }}>
            An admin can register it under Master Data → Loop Codes.
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
            <div>
              <span style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.text }}>{loop.code}</span>
              <span style={{ fontFamily: T.body, fontSize: 12.5, color: T.textMuted, marginLeft: 10 }}>
                {loop.name}{loop.carrierCode ? ` · ${loop.carrierCode}` : ""}
              </span>
            </div>
            <div style={{ display: "flex", gap: 18 }}>
              <div>
                <div style={{ fontFamily: T.body, fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: T.textMuted }}>Rotation</div>
                <div style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>{loop.ports.length} ports</div>
              </div>
              {loop.roundTripDays != null && (
                <div>
                  <div style={{ fontFamily: T.body, fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: T.textMuted }}>Round Trip</div>
                  <div style={{ fontFamily: T.mono, fontSize: 13, color: T.accent, fontWeight: 600 }}>{loop.roundTripDays}d</div>
                </div>
              )}
              {loop.frequencyDays != null && (
                <div>
                  <div style={{ fontFamily: T.body, fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: T.textMuted }}>Frequency</div>
                  <div style={{ fontFamily: T.mono, fontSize: 13, color: T.text, fontWeight: 600 }}>Every {loop.frequencyDays}d</div>
                </div>
              )}
            </div>
          </div>

          {loop.ports.length < 2 ? (
            <div style={{ padding: 24, textAlign: "center", fontFamily: T.body, fontSize: 13, color: T.textMuted }}>
              This loop has no rotation configured yet.
            </div>
          ) : (
            <Timeline ports={loop.ports} polCode={polCode} podCode={podCode} />
          )}

          {currentLeg && (
            <div style={{ marginTop: 12, fontFamily: T.body, fontSize: 11.5, color: T.textMuted }}>
              This shipment rides the <span style={{ color: T.text, fontWeight: 600 }}>{currentLeg}</span> leg.
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};

export default LoopRouteModal;
