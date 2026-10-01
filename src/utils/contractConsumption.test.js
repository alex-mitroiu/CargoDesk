import { describe, it, expect } from "vitest";
import { buildContractRows, buildWeeklyTrend, buildBreakdown, inUnit, bucketOf, MAX_BREAKDOWN_REFS } from "./contractConsumption";

const addDays = (iso, n) => { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const teuOfShipment = s => s.teu;

// One contract number (HLCU-TATL) with three records, plus a single-record contract.
const contractMap = {
  "C-A": { carrierCode: "HLCU", contractNumber: "HLCU-TATL", contractRef: "EUN-USEC-A" },
  "C-B": { carrierCode: "HLCU", contractNumber: "HLCU-TATL", contractRef: "EUN-USEC-B", namedAccount: "Nordic Home Retail AB" },
  "C-G": { carrierCode: "HLCU", contractNumber: "HLCU-TATL", contractRef: "EUN-USG" },
  "C-E": { carrierCode: "EGLV", contractNumber: "EGLV-TPAC", contractRef: "" },
};
const allocations = [
  { id: "AL-A", contractId: "C-A", carrierCode: "HLCU", contractNumber: "STALE-COPY", allocatedTEU: 120 },
  { id: "AL-B", contractId: "C-B", carrierCode: "HLCU", contractNumber: "HLCU-TATL", allocatedTEU: 60 },
  { id: "AL-G", contractId: "C-G", carrierCode: "HLCU", contractNumber: "HLCU-TATL", allocatedTEU: 80 },
  { id: "AL-E", contractId: "C-E", carrierCode: "EGLV", contractNumber: "EGLV-TPAC", allocatedTEU: 200 },
];
const ship = (id, allocationId, bookingStatus, teu, etd = "2026-09-15") => ({ id, allocationId, bookingStatus, teu, etd });
const shipments = [
  ship("S1", "AL-A", "Confirmed", 70), ship("S2", "AL-A", "Pending", 8),
  ship("S3", "AL-B", "Confirmed", 60), ship("S4", "AL-B", "Created", 4),
  ship("S5", "AL-G", "Confirmed", 78), ship("S6", "AL-G", undefined, 2),
  ship("S7", "AL-E", "Confirmed", 19), ship("S8", "AL-E", "Rejected", 5), ship("S9", "AL-E", "Cancelled", 40),
  ship("S10", "", "Confirmed", 99), // not on a space configuration — never counted
];

describe("contract consumption rows", () => {
  const rows = buildContractRows({ allocations, shipments, contractMap, teuOfShipment });
  const tatl = rows.find(r => r.contractNumber === "HLCU-TATL");

  it("groups every record of a contract number into one row, using the live contract number", () => {
    expect(rows.map(r => r.key)).toEqual(["HLCU|HLCU-TATL", "EGLV|EGLV-TPAC"]);
    expect(tatl.refs.map(r => r.ref)).toEqual(["EUN-USEC-A", "EUN-USG", "EUN-USEC-B"]);
  });

  it("buckets by booking status with booking counts; cancelled and unlinked shipments don't count", () => {
    expect(tatl.totals).toMatchObject({ alloc: 260, conf: 208, pend: 14, confN: 3, pendN: 3 });
    const eglv = rows.find(r => r.contractNumber === "EGLV-TPAC");
    expect(eglv.totals).toMatchObject({ alloc: 200, conf: 19, pend: 0, rej: 5, rejN: 1 });
    expect(bucketOf("Cancelled")).toBeNull();
  });

  it("reports a reference booked past its own allocation, and the contract's net and free space", () => {
    expect(tatl.totals.over).toBe(4);
    expect(tatl.totals.overRefs.map(r => r.ref)).toEqual(["EUN-USEC-B"]);
    expect(tatl.totals.net).toBe(38);   // 260 − 208 − 14
    expect(tatl.totals.free).toBe(42);  // free space on EUN-USEC-A
  });

  it("counts per reference how each shipment's space was picked: steered, direct, overbooked or not recorded", () => {
    const withSel = shipments.map(s => ({ ...s, spaceSelection: { S1: "suggested", S2: "direct", S3: "direct", S4: "overbooked", S9: "suggested" }[s.id] }));
    const r = buildContractRows({ allocations, shipments: withSel, contractMap, teuOfShipment });
    const refA = r[0].refs.find(x => x.ref === "EUN-USEC-A"), refB = r[0].refs.find(x => x.ref === "EUN-USEC-B");
    expect(refA).toMatchObject({ selSuggested: 1, selDirect: 1, selOverbooked: 0, selUnknown: 0 });
    expect(refB).toMatchObject({ selSuggested: 0, selDirect: 1, selOverbooked: 1 });
    expect(r[0].totals).toMatchObject({ selSuggested: 1, selDirect: 2, selOverbooked: 1, selUnknown: 2 });
    // S9 is cancelled: not counted anywhere.
    expect(r.find(x => x.contractNumber === "EGLV-TPAC").totals.selSuggested).toBe(0);
  });

  it("sorts the fullest contract first", () => {
    expect(rows[0].totals.used).toBeGreaterThan(rows[1].totals.used);
  });
});

describe("weekly confirmed trend", () => {
  const trend = buildWeeklyTrend({
    allocations, shipments: [...shipments, ship("S11", "AL-A", "Confirmed", 5, "2026-08-20")], contractMap, teuOfShipment,
    rangeStart: "2026-09-21", addDays, formatWeek: iso => iso,
  });

  it("covers the 6 weeks ending with the period's first week", () => {
    expect(trend.weeks.map(w => w.start)).toEqual(["2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"]);
  });

  it("sums confirmed TEU per contract number by ETD week, through the space configuration link", () => {
    const tatl = trend.series.find(s => s.contractNumber === "HLCU-TATL");
    expect(tatl.values).toEqual([5, 0, 0, 0, 208, 0]);
    expect(trend.series.find(s => s.contractNumber === "EGLV-TPAC").values).toEqual([0, 0, 0, 0, 19, 0]);
  });
});

describe("contract breakdown (Sankey)", () => {
  const rows = buildContractRows({ allocations, shipments, contractMap, teuOfShipment });
  const g = buildBreakdown(rows.find(r => r.contractNumber === "HLCU-TATL"));
  const flow = (id, dir) => g.links.filter(l => (dir === "in" ? l.target : l.source) === g.nodes.findIndex(n => n.id === id)).reduce((a, l) => a + l.value, 0);

  it("balances every reference: inflow (allocation + over allocation) equals outflow", () => {
    g.nodes.filter(n => n.kind === "ref").forEach(n => expect(flow(n.id, "in")).toBe(flow(n.id, "out")));
  });

  it("feeds the over-booked reference from an Over allocation node", () => {
    expect(g.nodes.find(n => n.id === "over").teu).toBe(4);
    expect(flow("confirmed", "in")).toBe(208);
    expect(flow("available", "in")).toBe(42);
  });

  it("folds references past the limit into one node", () => {
    const many = { contractNumber: "X", refs: Array.from({ length: MAX_BREAKDOWN_REFS + 2 }, (_, i) =>
      ({ ref: `R${i}`, alloc: 10, conf: 1, pend: 0, rej: 0, confN: 1, pendN: 0, rejN: 0 })) };
    const refs = buildBreakdown(many).nodes.filter(n => n.kind === "ref");
    expect(refs).toHaveLength(MAX_BREAKDOWN_REFS);
    expect(refs.at(-1).name).toBe("Other references (3)");
  });

  it("has nothing to draw for a contract with no space and no bookings", () => {
    expect(buildBreakdown({ contractNumber: "Y", refs: [{ ref: "", alloc: 0, conf: 0, pend: 0, rej: 0, confN: 0, pendN: 0, rejN: 0 }] })).toBeNull();
  });
});

describe("unit formatting", () => {
  it("shows TEU, or % of the contract's allocation", () => {
    expect(inUnit(208, 260, "teu")).toBe("208 TEU");
    expect(inUnit(208, 260, "pct")).toBe("80%");
    expect(inUnit(14, 260, "pct")).toBe("5.4%");
    expect(inUnit(5, 0, "pct")).toBe("—");
  });
});
