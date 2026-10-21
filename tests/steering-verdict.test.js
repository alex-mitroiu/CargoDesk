/**
 * The steering verdict (Epic TKT-KFGL81, Story 3 TKT-SQ5U6H; scope doc https://claude.ai/artifact/X9n2jk6TyGFKfbE7GsWKCy,
 * decided 2026-10-21). Whenever a shipment's contract or space is saved, the server works out whether it
 * followed the Lane Steering line and saves that on the shipment (lib/where-to-book.js recordVerdict):
 *   - steered: on the line with no higher option that had space;
 *   - out_of_order: lower on the line while a higher option had space — the reason given is kept and the
 *     History says what it would have been (BOOKED_OUT_OF_ORDER); warn, never block;
 *   - other_contract / other_carrier / spot while an option had space (BOOKED_OFF_STEERING);
 *   - not_covered on a lane with no line; customer_own and no_contract are left out of the report;
 *   - a reassignment is judged again, and a steered one keeps no reason.
 * GET /api/reports/steering (Story 4 TKT-Q2E7WN) then counts them for the dates: the steering rate, by trade
 * lane and carrier, and the shipments that didn't follow, with what they would have been and why.
 * Dated 2028 so no other steering or space is in the way.
 *
 * Usage:
 *   node tests/steering-verdict.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC, CNSHA present in port_locations (seeded MDM data)
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
    const shipper = (await request("POST", "/api/customers", { companyName: `Steering Verdict Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Steering Verdict Consignee ${rand} Inc` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id);

    // The line: #1 MAEU (4 TEU a week), #2 HLCU (10 TEU for the year), #3 CMDU (no space: order only).
    // ONEY also sails the lane but isn't on the line.
    const contract = async (carrierCode, legs = [{ pol: "NLRTM", pod: "USNYC" }]) => {
      const c = (await request("POST", "/api/contracts", { contractNumber: `TC-SV-${carrierCode}-${rand}`, carrierCode, status: "Active",
        validFrom: "2028-01-01", validTo: "2028-12-31", legs, rates: [{ serviceCode: "OF", amount: 1850, currency: "USD", unit: "per_container" }] }, token)).body;
      cleanup.contracts.push(c.id);
      return c;
    };
    const maeu = await contract("MAEU"), hlcu = await contract("HLCU"), cmdu = await contract("CMDU"), oney = await contract("ONEY");
    const space = async (c, extra) => {
      const r = await request("POST", "/api/allocations", { contractId: c.id, routingIds: [c.routings[0].id], effectiveDate: "2028-01-01", endDate: "2028-12-31", ...extra }, token);
      if (r.status !== 201) throw new Error(`space on ${c.carrierCode}: ${r.status} ${JSON.stringify(r.body)}`);
      cleanup.allocations.push(r.body.id);
      return r.body;
    };
    const maeuSpace = await space(maeu, { allocatedTEU: 4, spaceBasis: "week" });
    const hlcuSpace = await space(hlcu, { allocatedTEU: 10 });
    const line = await request("POST", "/api/lane-steerings", { originLane: "EU-N", destLane: "NAM", validFrom: "2028-01-01", validTo: "2028-12-31",
      options: [{ carrierCode: "MAEU", contractId: maeu.id }, { carrierCode: "HLCU", contractId: hlcu.id }, { carrierCode: "CMDU", contractId: cmdu.id }] }, token);
    if (line.body?.id) cleanup.steerings.push(line.body.id);
    assert("the line is saved (201)", line.status === 201, JSON.stringify(line.body).slice(0, 200));

    // A shipment sailing 8 March 2028 (week 10), with one 40' HC (2 TEU) once its containers are added.
    const newShipment = async ({ carrierCode, contractType = "Central", contractId = "", allocationId = "", contractRef = "", pol = "NLRTM", pod = "USNYC",
      steeringReason, container = true } = {}) => {
      const s = await request("POST", "/api/shipments", {
        pol, pod, carrierCode, status: "Active", contractType, contractId, contractRef, ...(allocationId && { allocationId }),
        etd: "2028-03-08", eta: "2028-03-20", incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId, ...(steeringReason !== undefined && { steeringReason }),
      }, token);
      if (s.status !== 201) throw new Error(`shipment: ${s.status} ${JSON.stringify(s.body)}`);
      cleanup.shipments.push(s.body.id);
      if (container) await request("POST", "/api/containers", { shipmentId: s.body.id, containerNumber: `MSKU${String(Date.now()).slice(-7)}`,
        size: "40", type: "HC", hsCode: "940360", cargoDescription: "Flat-pack furniture", grossWeightKg: 9000, volumeCbm: 60 }, token);
      return s.body.id;
    };
    const get = async id => (await request("GET", `/api/shipments/${id}`, null, token)).body;
    const events = async id => list((await request("GET", `/api/shipments/${id}/events`, null, token)).body);

    console.log("\nOn the line");
    const A = await newShipment({ carrierCode: "MAEU", contractId: maeu.id, allocationId: maeuSpace.id, contractRef: maeu.contractNumber });
    let s = await get(A);
    assert("#1 MAEU with space: steered, rank 1, on the line", s.steeringVerdict === "steered" && s.steeringRank === 1 && s.steeringLineId === line.body.id,
      JSON.stringify({ v: s.steeringVerdict, r: s.steeringRank }));
    const B = await newShipment({ carrierCode: "HLCU", contractId: hlcu.id, allocationId: hlcuSpace.id, contractRef: hlcu.contractNumber,
      steeringReason: "Customer asked for Hapag-Lloyd" });
    s = await get(B);
    assert("#2 HLCU while #1 MAEU has space: out of order, with the reason", s.steeringVerdict === "out_of_order" && s.steeringRank === 2
      && s.steeringReason === "Customer asked for Hapag-Lloyd", JSON.stringify({ v: s.steeringVerdict, r: s.steeringReason }));
    assert("…and the better option it skipped: #1 MAEU, 2 TEU free, of 3 options", s.steeringPick?.rank === 1 && s.steeringPick.carrierCode === "MAEU"
      && s.steeringPick.freeTeu === 2 && s.steeringPick.options === 3, JSON.stringify(s.steeringPick));
    const ooo = (await events(B)).find(e => e.eventType === "BOOKED_OUT_OF_ORDER");
    assert("the History says so (BOOKED_OUT_OF_ORDER)", !!ooo && /MAEU/.test(ooo.meta?.better?.carrierCode || JSON.stringify(ooo.meta || ooo)), JSON.stringify(ooo));

    console.log("\nOnce #1 is full for the week");
    await newShipment({ carrierCode: "MAEU", contractId: maeu.id, allocationId: maeuSpace.id, contractRef: maeu.contractNumber });
    const C = await newShipment({ carrierCode: "HLCU", contractId: hlcu.id, allocationId: hlcuSpace.id, contractRef: hlcu.contractNumber });
    s = await get(C);
    assert("#2 HLCU is steered: #1 MAEU has no space left in week 10", s.steeringVerdict === "steered" && s.steeringRank === 2 && s.steeringReason === "",
      JSON.stringify({ v: s.steeringVerdict, r: s.steeringRank }));

    console.log("\nOff the line");
    const D = await newShipment({ carrierCode: "ONEY", contractId: oney.id, contractRef: oney.contractNumber, steeringReason: "Earliest sailing" });
    s = await get(D);
    assert("ONEY, not on the line, while #2 HLCU has space: other carrier", s.steeringVerdict === "other_carrier" && s.steeringReason === "Earliest sailing"
      && s.steeringPick?.rank === 2, JSON.stringify({ v: s.steeringVerdict, p: s.steeringPick }));
    assert("the History says so (BOOKED_OFF_STEERING)", (await events(D)).some(e => e.eventType === "BOOKED_OFF_STEERING"));
    const E = await newShipment({ carrierCode: "CMDU", contractType: "SPOT", contractRef: `SPOT-SV-${rand}` });
    s = await get(E);
    assert("SPOT while an option has space: spot, no reason given", s.steeringVerdict === "spot" && s.steeringReason === "", JSON.stringify({ v: s.steeringVerdict }));
    const F = await newShipment({ carrierCode: "MAEU", contractType: "Customer Own", contractRef: `OWN-${rand}`, container: false });
    const G = await newShipment({ carrierCode: "MAEU", contractType: "Pending", container: false });
    assert("Customer Own and Pending are left out", (await get(F)).steeringVerdict === "customer_own" && (await get(G)).steeringVerdict === "no_contract");
    const H = await newShipment({ carrierCode: "HLCU", contractType: "SPOT", contractRef: `SPOT-SV2-${rand}`, pol: "CNSHA", pod: "NLRTM", container: false });
    assert("a lane with no steering: not covered", (await get(H)).steeringVerdict === "not_covered", (await get(H)).steeringVerdict);

    console.log("\nA reassignment is judged again");
    let put = await request("PUT", `/api/shipments/${D}`, { carrierCode: "CMDU", contractType: "Central", contractId: cmdu.id, contractRef: cmdu.contractNumber, allocationId: "" }, token);
    s = await get(D);
    assert("ONEY → #3 CMDU (order only) while #2 HLCU has space: out of order", put.status === 200 && s.steeringVerdict === "out_of_order" && s.steeringRank === 3,
      JSON.stringify({ st: put.status, v: s.steeringVerdict, r: s.steeringRank }));
    put = await request("PUT", `/api/shipments/${D}`, { carrierCode: "HLCU", contractType: "Central", contractId: hlcu.id, contractRef: hlcu.contractNumber,
      allocationId: hlcuSpace.id }, token);
    s = await get(D);
    assert("→ #2 HLCU: steered, and the old reason is gone", put.status === 200 && s.steeringVerdict === "steered" && s.steeringReason === "",
      JSON.stringify({ v: s.steeringVerdict, r: s.steeringReason }));
    put = await request("PUT", `/api/shipments/${B}`, { steeringReason: "Customer asked for Hapag-Lloyd, confirmed by mail" }, token);
    s = await get(B);
    assert("a new reason alone is saved, and the verdict stands as judged (MAEU is full by now)", s.steeringReason === "Customer asked for Hapag-Lloyd, confirmed by mail"
      && s.steeringVerdict === "out_of_order", JSON.stringify({ v: s.steeringVerdict, r: s.steeringReason }));

    console.log("\nThe steering report, March 2028");
    const report = async params => (await request("GET", `/api/reports/steering?${new URLSearchParams({ from: "2028-03-01", to: "2028-03-31", ...params })}`, null, token)).body;
    let r = await report({ lane: "EU-N → NAM" });
    assert("EU-N → NAM: 4 steered, 1 out of order, 1 SPOT; Customer Own and Pending left out", r?.counts?.steered === 4 && r.counts.out_of_order === 1
      && r.counts.spot === 1 && r.total === 6, JSON.stringify(r?.counts));
    assert("the steering rate is 4 of 6 = 66.7%", r?.inRate === 6 && r.followed === 4 && r.rate === 66.7, JSON.stringify({ inRate: r?.inRate, rate: r?.rate }));
    const bOut = (r?.notFollowedShipments || []).find(x => x.id === B);
    assert("the shipments that didn't follow list B with its pick and reason", (r?.notFollowedShipments || []).length === 2 && bOut?.verdict === "out_of_order"
      && bOut.pick?.rank === 1 && /Hapag-Lloyd/.test(bOut.reason), JSON.stringify(r?.notFollowedShipments));
    const hl = (r?.byCarrier || []).find(c => c.carrierCode === "HLCU");
    assert("by carrier: HLCU 3 shipments, 2 steered there, 1 not", hl?.shipments === 3 && hl.followed === 2 && hl.notFollowed === 1, JSON.stringify(r?.byCarrier));
    r = await report({});
    assert("all lanes: CNSHA → NLRTM counts as not covered, outside the rate", r?.counts?.not_covered === 1 && r.inRate === 6
      && (r.byLane || []).some(l => l.lane === "FE → EU-N" && l.notCovered === 1 && l.rate === null), JSON.stringify(r?.byLane));
    r = await report({ carrier: "MAEU" });
    assert("a carrier filter: MAEU's 2, both steered, 100%", r?.total === 2 && r.rate === 100, JSON.stringify({ total: r?.total, rate: r?.rate }));
    assert("to before from is refused (400)", (await request("GET", "/api/reports/steering?from=2028-03-31&to=2028-03-01", null, token)).status === 400);
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
