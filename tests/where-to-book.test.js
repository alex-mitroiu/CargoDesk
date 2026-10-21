/**
 * Where to book (Epic TKT-KFGL81, Story 2 TKT-BI1QS7; scope doc https://claude.ai/artifact/X9n2jk6TyGFKfbE7GsWKCy,
 * approved 2026-10-21). GET /api/where-to-book answers from the Lane Steering line and the space behind each
 * option (lib/where-to-book.js):
 *   - no line for the lane, no steered answer;
 *   - each option skipped (with the reason: named account, another loop), full, or available with its free
 *     TEU (allocated − confirmed − pending, in the ETD's week for weekly space); a contract with no space
 *     configured is order only;
 *   - the pick is the first available option; a shipment bigger than what's left stays there as an
 *     overbooking; every option full → the first one not skipped, as an overbooking;
 *   - a customer's own line wins, and books their own space on a contract, never spilling into its
 *     general space; with none of their own, the contract's general space;
 *   - ?shipmentId= answers for a saved shipment; Lane Steering lists the space behind each option and
 *     keeps the line's note.
 * Everything is dated 2028 so no other steering or space is in the way.
 *
 * Usage:
 *   node tests/where-to-book.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations (seeded MDM data; EU-N → NAM)
 */

import { ensureOffices } from "./helpers/offices.mjs";

const BASE = "http://localhost:3001";
let passed = 0, failed = 0;

async function request(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body !== undefined && body !== null && { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
}
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
const list = b => (Array.isArray(b) ? b : (b?.results ?? []));

(async () => {
  const cleanup = { steerings: [], allocations: [], contracts: [], shipments: [], customers: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const shipper = (await request("POST", "/api/customers", { companyName: `Where To Book Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Where To Book Consignee ${rand} Inc` }, token)).body;
    const other = (await request("POST", "/api/customers", { companyName: `Where To Book Other ${rand} GmbH` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id, other.id);

    // Four contracts on Rotterdam → New York for 2028: MSCU reserved for another customer, MAEU with
    // weekly space, HLCU on loop AL1 with period space, CMDU with no space configured.
    const contract = async (carrierCode, extra = {}, legs = [{ pol: "NLRTM", pod: "USNYC" }]) => {
      const c = (await request("POST", "/api/contracts", { contractNumber: `TC-WTB-${carrierCode}-${rand}`, carrierCode, status: "Active",
        validFrom: "2028-01-01", validTo: "2028-12-31", legs, rates: [{ serviceCode: "OF", amount: 1850, currency: "USD", unit: "per_container" }], ...extra }, token)).body;
      cleanup.contracts.push(c.id);
      return c;
    };
    const mscu = await contract("MSCU", { namedAccountId: other.id, namedAccount: other.companyName });
    const maeu = await contract("MAEU");
    const hlcu = await contract("HLCU", {}, [{ pol: "NLRTM", pod: "USNYC", vesselService: "AL1" }]);
    const cmdu = await contract("CMDU");
    const space = async (c, extra) => {
      const r = await request("POST", "/api/allocations", { contractId: c.id, routingIds: [c.routings[0].id], effectiveDate: "2028-01-01", endDate: "2028-12-31", ...extra }, token);
      if (r.status !== 201) throw new Error(`space on ${c.carrierCode}: ${r.status} ${JSON.stringify(r.body)}`);
      cleanup.allocations.push(r.body.id);
      return r.body;
    };
    const maeuWeekly = await space(maeu, { allocatedTEU: 4, spaceBasis: "week" });
    const hlcuAl1 = await space(hlcu, { allocatedTEU: 10, loopCode: "AL1" });

    const ask = async (params, who = token) => {
      const q = new URLSearchParams({ pol: "NLRTM", pod: "USNYC", etd: "2028-03-08", customerId: shipper.id, commodityCode: "9999", teu: "2", ...params });
      return (await request("GET", `/api/where-to-book?${q}`, null, who)).body;
    };
    const opt = (a, rank) => a?.options?.find(o => o.rank === rank);

    console.log("No steering for the lane");
    let a = await ask({});
    assert("no line, no options, no pick", a?.line === null && a.options.length === 0 && a.pick === null && a.lane === "EU-N → NAM", JSON.stringify(a));
    assert("pol and pod are required (400)", (await request("GET", "/api/where-to-book?pol=NLRTM", null, token)).status === 400);

    const line = await request("POST", "/api/lane-steerings", { originLane: "EU-N", destLane: "NAM", validFrom: "2028-01-01", validTo: "2028-12-31",
      note: "MAEU first; HLCU only on AL1", options: [
        { carrierCode: "MSCU", contractId: mscu.id }, { carrierCode: "MAEU", contractId: maeu.id, note: "Weekly allocation" },
        { carrierCode: "HLCU", contractId: hlcu.id }, { carrierCode: "CMDU", contractId: cmdu.id },
      ] }, token);
    if (line.body?.id) cleanup.steerings.push(line.body.id);
    assert("the line for everyone is saved with its note (201)", line.status === 201 && line.body.note === "MAEU first; HLCU only on AL1", JSON.stringify(line.body).slice(0, 200));

    console.log("\nThe waterfall, week 10 of 2028 (6 – 12 March)");
    a = await ask({});
    assert("the line for everyone answers, with its note", a?.line?.id === line.body.id && a.line.note === "MAEU first; HLCU only on AL1", JSON.stringify(a?.line));
    assert("#1 MSCU is skipped: named account of another customer", opt(a, 1)?.status === "skipped" && new RegExp(`named account ${other.companyName}`).test(opt(a, 1).reason),
      JSON.stringify(opt(a, 1)));
    assert("#2 MAEU is available: 4 TEU free in week 10, with its note", opt(a, 2)?.status === "available" && opt(a, 2).freeTeu === 4
      && opt(a, 2).space[0]?.weekNumber === 10 && opt(a, 2).note === "Weekly allocation", JSON.stringify(opt(a, 2)));
    assert("#3 HLCU is available on its AL1 space (any loop asked)", opt(a, 3)?.status === "available" && opt(a, 3).freeTeu === 10, JSON.stringify(opt(a, 3)));
    assert("#4 CMDU is order only: available, no cap", opt(a, 4)?.status === "available" && opt(a, 4).orderOnly === true && opt(a, 4).freeTeu === null, JSON.stringify(opt(a, 4)));
    assert("the pick is #2 MAEU on its weekly space, no overbooking", a.pick?.rank === 2 && a.pick.allocationId === maeuWeekly.id && a.pick.overbooking === false && a.pick.allFull === false,
      JSON.stringify(a.pick));
    a = await ask({ teu: "6" });
    assert("6 TEU, more than the 4 left: still #2, as an overbooking", a.pick?.rank === 2 && a.pick.overbooking === true, JSON.stringify(a.pick));
    a = await ask({ loopCode: "AL5" });
    assert("a sailing on AL5: #3 HLCU is skipped, space for loop AL1 only", opt(a, 3)?.status === "skipped" && /loop AL1 only; this sailing is AL5/.test(opt(a, 3).reason),
      JSON.stringify(opt(a, 3)));

    console.log("\nWeek 10 fills up");
    const newShipment = async (etd, eta) => {
      const s = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractId: maeu.id,
        allocationId: maeuWeekly.id, contractRoutingId: maeu.routings[0].id, etd, eta, incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId,
      }, token);
      if (s.status !== 201) throw new Error(`shipment: ${s.status} ${JSON.stringify(s.body)}`);
      cleanup.shipments.push(s.body.id);
      await request("POST", "/api/containers", { shipmentId: s.body.id, containerNumber: `MSKU${String(Date.now()).slice(-7)}`,
        size: "40", type: "HC", hsCode: "940360", cargoDescription: "Flat-pack furniture", grossWeightKg: 9000, volumeCbm: 60 }, token);
      return s.body.id;
    };
    const S1 = await newShipment("2028-03-09", "2028-03-20");
    await newShipment("2028-03-10", "2028-03-21");
    a = await ask({});
    assert("#2 MAEU is full in week 10 (2 × 40' HC pending)", opt(a, 2)?.status === "full" && opt(a, 2).freeTeu === 0, JSON.stringify(opt(a, 2)));
    assert("the pick moves to #3 HLCU", a.pick?.rank === 3 && a.pick.allocationId === hlcuAl1.id, JSON.stringify(a.pick));
    a = await ask({ etd: "2028-03-15" });
    assert("week 11 is a new week: #2 MAEU is the pick again", a.pick?.rank === 2 && opt(a, 2).freeTeu === 4 && opt(a, 2).space[0]?.weekNumber === 11, JSON.stringify(a.pick));

    const forS1 = await request("GET", `/api/where-to-book?shipmentId=${S1}`, null, token);
    assert("?shipmentId= answers for a saved shipment: its own week, its own TEU", forS1.status === 200 && forS1.body.teu === 2 && opt(forS1.body, 2)?.status === "full"
      && forS1.body.pick?.rank === 3, JSON.stringify({ teu: forS1.body?.teu, pick: forS1.body?.pick }));
    assert("an unknown shipment is 404", (await request("GET", "/api/where-to-book?shipmentId=SHP-NOPE00", null, token)).status === 404);

    console.log("\nA customer's own line");
    const own = await request("POST", "/api/lane-steerings", { originLane: "EU-N", destLane: "NAM", customerId: shipper.id, customerName: shipper.companyName,
      validFrom: "2028-01-01", validTo: "2028-12-31", options: [{ carrierCode: "MAEU", contractId: maeu.id }] }, token);
    if (own.body?.id) cleanup.steerings.push(own.body.id);
    a = await ask({});
    assert("the shipper's own line wins over the line for everyone", a?.line?.id === own.body?.id && a.options.length === 1, JSON.stringify(a?.line));
    assert("with no space of their own, MAEU's general space applies: full in week 10, so #1 as an overbooking",
      a.pick?.rank === 1 && a.pick.allocationId === maeuWeekly.id && a.pick.overbooking === true && a.pick.allFull === true, JSON.stringify(a.pick));
    const ownSpace = await space(maeu, { allocatedTEU: 3, spaceBasis: "week", customerId: shipper.id, customerName: shipper.companyName });
    a = await ask({ teu: "4" });
    assert("with space of their own, only theirs: 3 free, 4 TEU stays there as an overbooking, never spilling into the general space",
      opt(a, 1)?.space.length === 1 && opt(a, 1).space[0].id === ownSpace.id && a.pick?.allocationId === ownSpace.id && a.pick.overbooking === true, JSON.stringify(opt(a, 1)));
    const otherAsks = await ask({ customerId: other.id });
    assert("another customer gets the line for everyone, and never the shipper's space",
      otherAsks?.line?.id === line.body.id && !otherAsks.options.some(o => o.space.some(x => x.id === ownSpace.id)), JSON.stringify(otherAsks?.line));

    console.log("\nLane Steering shows the space behind each option");
    const lines = list((await request("GET", "/api/lane-steerings", null, token)).body);
    const everyone = lines.find(x => x.id === line.body.id);
    const o2 = everyone?.options.find(o => o.rank === 2), o4 = everyone?.options.find(o => o.rank === 4);
    assert("#2 MAEU lists its weekly configurations", (o2?.space || []).some(x => x.id === maeuWeekly.id && x.spaceBasis === "week" && x.allocatedTEU === 4), JSON.stringify(o2?.space));
    assert("#4 CMDU lists none", Array.isArray(o4?.space) && o4.space.length === 0, JSON.stringify(o4?.space));
    assert("the line keeps its note", everyone?.note === "MAEU first; HLCU only on AL1");
  } catch (e) {
    console.error("Unexpected error:", e);
    failed++;
  } finally {
    // Steering and space on a real lane change what other shipments are offered, so none of it outlives the test.
    for (const id of cleanup.steerings) await request("DELETE", `/api/lane-steerings/${id}`, null, token).catch(() => {});
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    for (const id of cleanup.allocations) await request("DELETE", `/api/allocations/${id}`, null, token).catch(() => {});
    for (const id of cleanup.contracts) await request("DELETE", `/api/contracts/${id}`, null, token).catch(() => {});
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
  }
  console.log(`\n${"─".repeat(50)}\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
