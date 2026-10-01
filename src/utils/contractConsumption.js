// Dashboard → Contract Consumption, grouped by carrier + contract number (approved mockup:
// https://claude.ai/artifact/TqrzSKpPFsUQF6VVkXvrs8). One contract number can have several
// contract records (number + reference + named account); each record is one "reference" in the
// breakdown. A shipment counts toward a record through its space configuration (allocationId), the
// same link the Space Configurations page uses — never by the shipment's own contract fields.

// Same rule as routes/allocations.js loadTeuBuckets(): only Confirmed uses space for sure, Rejected
// is its own bucket, Cancelled is gone, anything else (Created/Pending/no booking yet) is pending.
export const bucketOf = bookingStatus =>
  bookingStatus === "Confirmed" ? "conf" : bookingStatus === "Rejected" ? "rej" : bookingStatus === "Cancelled" ? null : "pend";

// sel* = how each (non-cancelled) shipment's space configuration was picked in the contract picker:
// steered there by the same-contract suggestion, picked directly, booked onto it though full, or
// not recorded (booked before this was tracked). Stored as shipments.space_selection.
const emptyRecord = () => ({ alloc: 0, conf: 0, pend: 0, rej: 0, confN: 0, pendN: 0, rejN: 0,
  selSuggested: 0, selDirect: 0, selOverbooked: 0, selUnknown: 0 });
const SELECTION_KEY = { suggested: "selSuggested", direct: "selDirect", overbooked: "selOverbooked" };

// The allocation's stored contract_number is a copy that goes stale when a contract is renumbered,
// so the live contract record wins whenever it's loaded.
export const recordOf = (a, contractMap) => {
  const c = a.contractId ? contractMap[a.contractId] : null;
  return {
    recordKey: a.contractId || `alloc:${a.id}`,
    contractId: a.contractId || "",
    carrierCode: c?.carrierCode || a.carrierCode || "",
    contractNumber: c?.contractNumber || a.contractNumber || "(no contract number)",
    ref: c?.contractRef || "",
    namedAccount: c?.namedAccount || "",
    validFrom: c?.validFrom || "",
    validTo: c?.validTo || "",
  };
};
export const rowKeyOf = rec => `${rec.carrierCode}|${rec.contractNumber}`;

export function totalsOf(refs) {
  const t = refs.reduce((acc, r) => {
    for (const k of Object.keys(emptyRecord())) acc[k] += r[k];
    return acc;
  }, emptyRecord());
  const overRefs = refs.filter(r => r.conf + r.pend > r.alloc);
  return {
    ...t,
    over: overRefs.reduce((a, r) => a + (r.conf + r.pend - r.alloc), 0),
    overRefs,
    // Free space still left on the references that have any.
    free: refs.reduce((a, r) => a + Math.max(0, r.alloc - r.conf - r.pend), 0),
    net: t.alloc - t.conf - t.pend,
    used: t.alloc ? (t.conf + t.pend) / t.alloc : 0,
  };
}

// allocations: the space configurations active in the selected period. shipments: the period's
// shipments. teuOfShipment(s) → that shipment's TEU.
export function buildContractRows({ allocations, shipments, contractMap = {}, teuOfShipment }) {
  const byAlloc = new Map(allocations.map(a => [a.id, a]));
  const recs = new Map();
  const recFor = a => {
    const base = recordOf(a, contractMap);
    if (!recs.has(base.recordKey)) recs.set(base.recordKey, { ...base, ...emptyRecord() });
    return recs.get(base.recordKey);
  };
  allocations.forEach(a => { recFor(a).alloc += Number(a.allocatedTEU) || 0; });
  shipments.forEach(s => {
    const a = s.allocationId && byAlloc.get(s.allocationId);
    const b = a && bucketOf(s.bookingStatus);
    if (!b) return;
    const r = recFor(a);
    r[b] += teuOfShipment(s);
    r[`${b}N`] += 1;
    r[SELECTION_KEY[s.spaceSelection] || "selUnknown"] += 1;
  });
  const rows = new Map();
  for (const r of recs.values()) {
    const key = rowKeyOf(r);
    if (!rows.has(key)) rows.set(key, { key, carrierCode: r.carrierCode, contractNumber: r.contractNumber, refs: [] });
    rows.get(key).refs.push(r);
  }
  return [...rows.values()]
    .map(row => ({ ...row, refs: row.refs.sort((a, b) => b.alloc - a.alloc), totals: totalsOf(row.refs) }))
    // Ties broken by values that don't change when the live contract numbers arrive, so the bars
    // don't reshuffle under the pointer a moment after the tab opens.
    .sort((a, b) => (b.totals.used - a.totals.used) || (b.totals.alloc - a.totals.alloc)
      || a.refs[0].recordKey.localeCompare(b.refs[0].recordKey));
}

// Confirmed TEU per week for the 6 weeks ending with the period's first week, by ETD, per contract
// number — through the space configuration link, like the bars. A contract only gets a line if it
// has confirmed volume somewhere in the window. allocations here = every space configuration (a
// shipment from 5 weeks ago may sit on one that's no longer active).
export function buildWeeklyTrend({ allocations, shipments, contractMap = {}, teuOfShipment, rangeStart, addDays, formatWeek }) {
  const keyOfAlloc = new Map(allocations.map(a => { const rec = recordOf(a, contractMap); return [a.id, rec]; }));
  const weeks = Array.from({ length: 6 }, (_, i) => {
    const start = addDays(rangeStart, -(5 - i) * 7), end = addDays(start, 6);
    return { start, end, label: formatWeek(end) };
  });
  const series = new Map();
  for (const s of shipments) {
    if (s.bookingStatus !== "Confirmed" || !s.etd || !s.allocationId) continue;
    const rec = keyOfAlloc.get(s.allocationId);
    if (!rec) continue;
    const w = weeks.findIndex(wk => s.etd >= wk.start && s.etd <= wk.end);
    if (w < 0) continue;
    const key = rowKeyOf(rec);
    if (!series.has(key)) series.set(key, { key, carrierCode: rec.carrierCode, contractNumber: rec.contractNumber, values: weeks.map(() => 0) });
    series.get(key).values[w] += teuOfShipment(s);
  }
  // Stable order (by contract number) so a contract keeps its color when others come and go.
  return { weeks, series: [...series.values()].sort((a, b) => a.contractNumber.localeCompare(b.contractNumber)) };
}

export const MAX_BREAKDOWN_REFS = 6;

// Sankey graph for one contract number: contract → references → confirmed / pending / available.
// Conservation-safe like ShipmentGpSankey: a reference booked past its own allocation gets an
// "Over allocation" inflow for the difference, so every node's inflow equals its outflow. Rejected
// bookings don't use space and stay out of the graph (shown as a note). Past MAX_BREAKDOWN_REFS
// references, the smallest fold into "Other references".
export function buildBreakdown(row) {
  let refs = row.refs.filter(r => r.alloc > 0 || r.conf + r.pend > 0);
  if (!refs.length) return null;
  if (refs.length > MAX_BREAKDOWN_REFS) {
    const head = refs.slice(0, MAX_BREAKDOWN_REFS - 1), tail = refs.slice(MAX_BREAKDOWN_REFS - 1);
    const other = { ref: `Other references (${tail.length})`, ...emptyRecord() };
    tail.forEach(r => { for (const k of Object.keys(emptyRecord())) other[k] += r[k]; });
    refs = [...head, other];
  }
  const t = totalsOf(row.refs);
  const nodes = [], links = [], idx = {};
  const add = (id, props) => { if (idx[id] == null) { idx[id] = nodes.length; nodes.push({ id, ...props }); } return idx[id]; };

  const contract = add("contract", { name: row.contractNumber, kind: "contract", teu: t.alloc });
  const over = t.over > 0 ? add("over", { name: "Over allocation", kind: "over", teu: t.over }) : null;
  refs.forEach((r, i) => {
    const ref = add(`ref${i}`, { name: r.ref || "(no reference)", kind: "ref", teu: r.alloc, bookings: r.confN + r.pendN, account: r.namedAccount || "" });
    if (r.alloc > 0) links.push({ source: contract, target: ref, value: r.alloc, kind: "ref" });
    const o = Math.max(0, r.conf + r.pend - r.alloc);
    if (o > 0) links.push({ source: over, target: ref, value: o, kind: "over" });
    if (r.conf > 0) links.push({ source: ref, target: add("confirmed", { name: "Confirmed", kind: "confirmed", teu: t.conf, bookings: t.confN }), value: r.conf, kind: "confirmed", bookings: r.confN });
    if (r.pend > 0) links.push({ source: ref, target: add("pending", { name: "Pending confirmation", kind: "pending", teu: t.pend, bookings: t.pendN }), value: r.pend, kind: "pending", bookings: r.pendN });
    const free = Math.max(0, r.alloc - r.conf - r.pend);
    if (free > 0) links.push({ source: ref, target: add("available", { name: "Available", kind: "available", teu: t.free }), value: free, kind: "available" });
  });
  return { nodes, links, totals: t };
}

// A TEU figure in the selected unit; % is always of the contract number's total allocation.
export const fmtPct = p => `${p >= 10 || p === 0 ? Math.round(p) : p.toFixed(1)}%`;
export const inUnit = (teu, base, unit) =>
  unit === "pct" ? (base ? fmtPct(teu / base * 100) : "—") : `${Math.round(teu * 100) / 100} TEU`;
