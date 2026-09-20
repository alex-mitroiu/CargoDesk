import { T, LANE_BADGE_VARIANT } from "../../tokens";

// A trade-lane code as a coloured pill (EU-N, NAM, FE …), coloured by the same LANE_BADGE_VARIANT map the
// rest of the app uses. Unlike <Badge variant="default">, which paints the SAME colour as the card it sits
// on (so NAM, CAR, SAM and OCE read as bare text next to a green EU-N), a lane the map leaves at "default"
// gets a visible neutral fill here. `derived` draws it as a dashed outline instead of a solid fill — used
// where a lane was worked out from a port rather than stored on the record, so the two never look alike.
// Colours are read at render (T is mutated in place when the theme switches).
const LanePill = ({ code, derived = false }) => {
  const variant = LANE_BADGE_VARIANT[code] || "default";
  const [bg, fg] = ({
    success: [T.successBg, T.success],
    warning: [T.warningBg, T.warning],
    danger:  [T.dangerBg,  T.danger],
    info:    [T.infoBg,    T.info],
    amber:   [T.accentBg,  T.accent],
    purple:  [T.purpleBg,  T.purple],
    default: [`${T.textMuted}2e`, T.text],
  })[variant] || [`${T.textMuted}2e`, T.text];
  return (
    <span data-testid="lane-pill" data-derived={derived ? "true" : "false"}
      style={{ display: "inline-block", width: "fit-content", whiteSpace: "nowrap", borderRadius: 4,
        fontFamily: T.mono, fontSize: 10.5, fontWeight: 600, letterSpacing: ".06em", color: fg,
        ...(derived
          ? { background: "transparent", border: "1px dashed currentColor", padding: "1px 8px" }
          : { background: bg, border: "1px solid transparent", padding: "1px 8px" }) }}>
      {code}
    </span>
  );
};

export default LanePill;
