// Does a sailing follow the contract's routing line? (agreed 2026-11-05)
//   • a direct sailing always does: for "DEHAM via NLRTM to USNYC" the direct DEHAM → USNYC sailings
//     are offered too;
//   • a transshipment does when it calls at the line's own transshipment ports, in the same order —
//     DEHAM → NLRTM → USNYC does, DEHAM → BEANR → USNYC doesn't.
// hubs = the line's transshipment ports (lineChain(...).hubs); [] is a direct line, which takes direct
// sailings only. Used by the sailing search (SailingPickerModal routingHubs).
export function sailingFollowsLine(sailing, hubs) {
  const via = (sailing?.legs || []).slice(0, -1).map(l => String(l.pod || "").toUpperCase());
  if (via.length === 0) return true;
  return via.length === hubs.length && via.every((port, i) => port === String(hubs[i]).toUpperCase());
}

// "via NLRTM" / "via SGSIN → NLRTM" / "direct", for the sailing search's note.
export const lineRouteText = hubs => (hubs.length ? `via ${hubs.join(" → ")}` : "direct");
