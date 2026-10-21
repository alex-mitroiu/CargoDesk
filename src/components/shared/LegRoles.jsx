import { T } from "../../tokens";
import { legRoles } from "../../utils/mainLeg";

// The main vessel, marked the same way wherever a sailing is picked or shown (agreed 2026-10-21,
// mockup https://claude.ai/artifact/P3xrSaDFwDHWeWiSEWVccv): a solid MAIN chip on the leg with the
// longest transit, an outlined FEEDER chip on the others, legs always in sailing order.

export const MAIN_COLOR = "#38d4e8";

export const LegRoleChip = ({ role, muted = T.textMuted }) => (
  <span data-testid={`leg-role-${role.toLowerCase()}`}
    style={{ display: "inline-block", fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em", borderRadius: 3,
      padding: "1px 6px", whiteSpace: "nowrap", lineHeight: 1.5,
      ...(role === "MAIN" ? { color: "#06111f", background: MAIN_COLOR } : { color: muted, border: `1px solid ${muted}88` }) }}>
    {role}
  </span>
);

const fmt = d => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }) : "—");

// "via GBFXT, feeder DEMO CADENZA" — the hubs and feeder vessels of a transshipment, for a sub-line.
export const viaText = sailing => {
  const legs = legRoles(sailing);
  if (!legs.length) return "";
  const hubs = legs.slice(0, -1).map(l => l.pod);
  const feeders = legs.filter(l => l.role === "FEEDER").map(l => l.vesselName || l.vessel).filter(Boolean);
  return `via ${hubs.join(", ")}${feeders.length ? `, feeder${feeders.length > 1 ? "s" : ""} ${feeders.join(", ")}` : ""}`;
};

// A transshipment sailing's legs in order, each with its role, route, vessel · voyage, dates and days.
// Renders nothing for a direct sailing. `text`/`muted` follow the page's theme.
export const SailingLegs = ({ sailing, text = T.text, muted = T.textMuted, testId = "sailing-legs" }) => {
  const legs = legRoles(sailing);
  if (!legs.length) return null;
  return (
    <ol aria-label="Legs in sailing order" data-testid={testId}
      style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 3 }}>
      {legs.map((l, i) => (
        <li key={i} data-testid={`${testId}-${i}`} style={{ display: "grid", gridTemplateColumns: "62px 128px minmax(0, 1fr) 128px 36px", gap: 10,
          alignItems: "center", padding: "4px 8px", borderRadius: 5, fontFamily: T.mono, fontSize: 11.5, color: text,
          background: l.role === "MAIN" ? `${MAIN_COLOR}14` : "transparent", border: `1px solid ${l.role === "MAIN" ? `${MAIN_COLOR}66` : "transparent"}` }}>
          <LegRoleChip role={l.role} muted={muted} />
          <span style={{ fontWeight: 700 }}>{l.pol} → {l.pod}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[l.vesselName || l.vessel, l.voyageNumber || l.voyage].filter(Boolean).join(" · ") || "—"}</span>
          <span style={{ color: muted }}>{fmt(l.etd)} → {fmt(l.eta)}</span>
          <span style={{ color: muted, textAlign: "right" }}>{l.days ? `${l.days}d` : "—"}</span>
        </li>
      ))}
    </ol>
  );
};
