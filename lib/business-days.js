// Business-day math for the Invoice Collections report (Epic TKT-G11AHW). Plain Mon-Fri, no
// holiday calendar — confirmed via grep that no business-day helper existed anywhere in this
// codebase before this; every other date-driven business rule here (credit terms, invoice
// deadlines, pre-departure filing) uses calendar days. Same "reasonable placeholder, not a
// precise legal citation" tolerance this codebase already accepts elsewhere (e.g. the
// pre-departure filing deadline, v0.72.0).
//
// Both functions accept an optional `holidays` Set of "YYYY-MM-DD" strings, always called with
// an empty set today — the customer Billing Cycle tab's UN/LOCODE field is a deliberate
// placeholder for a future per-location holiday source (a free API, per direct instruction:
// "add a placeholder that indicates them - they should UNLocationCode based"), explicitly not
// wired to any live data in this pass. Accepting the parameter now means wiring in real holiday
// data later never touches a call site.

function isWeekend(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function toUtcDate(iso) {
  // Parses a plain "YYYY-MM-DD" (or an ISO datetime) as a UTC midnight Date, so day-of-week and
  // day-stepping math is never skewed by the server's own local timezone.
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Steps forward `n` business days from `dateIso`, skipping weekends and any date in `holidays`.
function addBusinessDays(dateIso, n, holidays = new Set()) {
  const d = toUtcDate(dateIso);
  let remaining = n;
  while (remaining > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (!isWeekend(d) && !holidays.has(iso)) remaining--;
  }
  return d.toISOString().slice(0, 10);
}

// Counts whole business days elapsed from `fromIso` up to `toIso` (exclusive of `fromIso`
// itself, inclusive of `toIso`) — i.e. "how many business days have passed since fromIso".
// Negative/zero when toIso is on or before fromIso.
function businessDaysBetween(fromIso, toIso, holidays = new Set()) {
  const from = toUtcDate(fromIso);
  const to = toUtcDate(toIso);
  if (to <= from) return 0;
  let count = 0;
  const cursor = new Date(from);
  while (cursor < to) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const iso = cursor.toISOString().slice(0, 10);
    if (!isWeekend(cursor) && !holidays.has(iso)) count++;
  }
  return count;
}

module.exports = { addBusinessDays, businessDaysBetween };
