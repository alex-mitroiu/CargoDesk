// ISO weeks, Monday to Sunday on UTC dates, for weekly space (Epic TKT-KFGL81, Story 1). The same
// rules as lib/iso-week.js on the server, which works out every figure the screens show; these
// only label and lay them out.

const DAY = 864e5;
const dayOf = d => Date.parse(`${String(d || "").slice(0, 10)}T00:00:00Z`);
const iso = t => new Date(t).toISOString().slice(0, 10);

// The Monday of a date's ISO week ('YYYY-MM-DD'), or '' for no date.
export function mondayOf(d) {
  const t = dayOf(d);
  if (!Number.isFinite(t)) return "";
  return iso(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY);
}

// The ISO week number (1–53) of a date.
export function isoWeekNumber(d) {
  const t = dayOf(d);
  if (!Number.isFinite(t)) return null;
  const thursday = t + (3 - ((new Date(t).getUTCDay() + 6) % 7)) * DAY;
  return 1 + Math.floor((thursday - Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1)) / DAY / 7);
}

// The Monday of every ISO week that overlaps from..to (inclusive), oldest first.
export function mondaysBetween(from, to) {
  const a = dayOf(mondayOf(from)), b = dayOf(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return [];
  const out = [];
  for (let t = a; t <= b; t += 7 * DAY) out.push(iso(t));
  return out;
}

// The date a shipment's space is counted on: its ETD, else its cargo-ready date.
export const spaceDateOf = (etd, cargoReadyDate) => String(etd || cargoReadyDate || "").slice(0, 10);

// "Week 44" for a date's week.
export const weekLabel = d => (d ? `Week ${isoWeekNumber(d)}` : "");

// "26 Oct – 1 Nov" for the week starting on a Monday.
export function weekRange(monday) {
  const t = dayOf(monday);
  if (!Number.isFinite(t)) return "";
  const fmt = x => new Date(x).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return `${fmt(t)} – ${fmt(t + 6 * DAY)}`;
}

// A space configuration's TEU over a date range: weekly space its TEU per week for every ISO week
// of the range inside its period (decided in the scope doc, 2026-10-21); period space its whole
// TEU, as the dashboards have always counted it. Totals that add configurations up use this, so
// a weekly configuration's per-week TEU is never added to another's whole-period TEU.
export function teuOverRange(a, from, to) {
  const teu = Number(a?.allocatedTEU) || 0;
  return a?.spaceBasis !== "week" ? teu : teu * rangeWeeksOf(a, from, to).length;
}
// The Mondays of a weekly configuration's weeks that fall in a date range and in its period.
export function rangeWeeksOf(a, from, to) {
  const lo = from && from > a.effectiveDate ? from : a.effectiveDate, hi = to && to < a.endDate ? to : a.endDate;
  return lo && hi && lo <= hi ? mondaysBetween(lo, hi) : [];
}
// Its TEU over its whole period.
export const periodTeuOf = a => teuOverRange(a, a?.effectiveDate, a?.endDate);
// "40 TEU" or "15 TEU/wk".
export const spaceTeuLabel = a => `${a?.allocatedTEU ?? 0} TEU${a?.spaceBasis === "week" ? "/wk" : ""}`;
