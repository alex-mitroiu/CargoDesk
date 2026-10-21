"use strict";

// ISO weeks, Monday to Sunday on UTC dates, for weekly space (Epic TKT-KFGL81, Story 1). A space
// configuration held "per week" offers its TEU every ISO week of its period, nothing carried over;
// a shipment counts in the week of its ETD, or of its cargo-ready date while it has no ETD. The
// same rules are in src/utils/isoWeek.js for the screens.

const DAY = 864e5;
const dayOf = d => Date.parse(`${String(d || "").slice(0, 10)}T00:00:00Z`);
const iso = t => new Date(t).toISOString().slice(0, 10);

// The Monday of a date's ISO week ('YYYY-MM-DD'), or '' for no date.
function mondayOf(d) {
  const t = dayOf(d);
  if (!Number.isFinite(t)) return "";
  return iso(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY);
}

// The ISO week number (1–53) of a date.
function isoWeekNumber(d) {
  const t = dayOf(d);
  if (!Number.isFinite(t)) return null;
  const thursday = t + (3 - ((new Date(t).getUTCDay() + 6) % 7)) * DAY;
  return 1 + Math.floor((thursday - Date.UTC(new Date(thursday).getUTCFullYear(), 0, 1)) / DAY / 7);
}

// The Monday of every ISO week that overlaps from..to (inclusive), oldest first.
function mondaysBetween(from, to) {
  const a = dayOf(mondayOf(from)), b = dayOf(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) return [];
  const out = [];
  for (let t = a; t <= b; t += 7 * DAY) out.push(iso(t));
  return out;
}

// The date a shipment's space is counted on: its ETD, else its cargo-ready date (decided
// 2026-10-21), as 'YYYY-MM-DD'; '' when it has neither.
const spaceDateOf = (etd, cargoReadyDate) => String(etd || cargoReadyDate || "").slice(0, 10);

// "Week 44" for a date's week.
const weekLabel = d => (d ? `Week ${isoWeekNumber(d)}` : "");

module.exports = { mondayOf, isoWeekNumber, mondaysBetween, spaceDateOf, weekLabel };
