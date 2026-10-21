/**
 * Lane steering (Epic TKT-ASIYFL, Story 5 TKT-SWD5LM; agreed 2026-10-20).
 *   - Master Data → Lane Steering: the carrier order on a trade lane, for everyone or one customer, over a
 *     validity window; maintained ONLY by admins and Trade Managers (never OCC/BK, OCC/AY, CCL/CO — the
 *     user, 2026-10-20), readable by everyone;
 *   - every option is a carrier on one of its own contracts; overlapping windows for the same lane and
 *     customer are refused; every change is in the entity history;
 *   - an escalation handler is offered the steering's options first, in their order, each checked against
 *     the shipment (a named account or a route the contract doesn't cover makes it not usable), and can
 *     switch to the contract search; a customer's own steering wins over everyone's; with no steering the
 *     contract search is all there is.
 *
 * Usage:
 *   node tests/lane-steering.test.js
 *
 * Prerequisites:
 *   - npm run dev (Express :3001), not in production (the built-in DCSA carrier plays CMDU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC in port_locations with their trade lanes EU-N and NAM (seeded MDM data)
 */

import { ensureOffices } from "./helpers/offices.mjs";
import { carrierActs, addContainer } from "./helpers/dcsa-sim.mjs";

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
  const cleanup = { steerings: [], allocations: [], contracts: [], shipments: [], customers: [], users: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const shipper = (await request("POST", "/api/customers", { companyName: `Steering Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Steering Consignee ${rand} Inc` }, token)).body;
    const other = (await request("POST", "/api/customers", { companyName: `Steering Other ${rand} GmbH` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id, other.id);

    // Three contracts on NLRTM → USNYC: MSCU with space, CMDU without, HLCU only for another customer;
    // and an ONEY contract that sails from Antwerp, not Rotterdam.
    const contract = async (carrierCode, extra = {}, legs = [{ pol: "NLRTM", pod: "USNYC" }]) => {
      const c = (await request("POST", "/api/contracts", { contractNumber: `TC-LS-${carrierCode}-${rand}`, carrierCode, status: "Active",
        validFrom: "2026-01-01", validTo: "2027-06-30", legs, rates: [{ serviceCode: "OF", amount: 1850, currency: "USD", unit: "per_container" }], ...extra }, token)).body;
      cleanup.contracts.push(c.id);
      return c;
    };
    const mscu = await contract("MSCU");
    const cmdu = await contract("CMDU");
    const hlcu = await contract("HLCU", { namedAccountId: other.id, namedAccount: other.companyName });
    const oney = await contract("ONEY", {}, [{ pol: "BEANR", pod: "USNYC" }]);
    const alloc = (await request("POST", "/api/allocations", { contractId: mscu.id, routingIds: [mscu.routings[0].id], allocatedTEU: 20,
      effectiveDate: "2026-10-01", endDate: "2026-12-31" }, token)).body;
    cleanup.allocations.push(alloc.id);

    const makeUser = async (key, roles, setup) => {
      const email = `ls-${key}-${rand.toLowerCase()}@example.com`;
      await request("POST", "/api/users", { email, name: `${key} ${rand}`, roles, password: "LsFixture!2026Zq" }, token);
      cleanup.users.push(email);
      const id = list((await request("GET", "/api/users", null, token)).body).find(u => u.email === email)?.id;
      await setup?.(id);
      return (await request("POST", "/api/auth/login", { email, password: "LsFixture!2026Zq" })).body.token;
    };
    const laneScope = id => request("POST", `/api/users/${id}/scope`, { role: "", itemType: "trade_lane", value: JSON.stringify({ origin: "EU-N", dest: "NAM" }), label: "EU-N → NAM" }, token);
    const tradeMgr = await makeUser("trade", ["trade_manager"], laneScope);
    const tradeAy = await makeUser("tradeay", ["trade_ay"], laneScope);
    const cclCo = await makeUser("cclco", ["ccl_co"], id => request("POST", `/api/users/${id}/offices`, { officeId: imoOfficeId }, token));
    const operator = await makeUser("operator", ["operator"], id => request("POST", `/api/users/${id}/offices`, { officeId: emoOfficeId }, token));
    const occBk = await makeUser("occbk", ["occ_bk"], id => request("POST", `/api/users/${id}/offices`, { officeId: emoOfficeId }, token));
    const occAy = await makeUser("occay", ["occ_ay"], id => request("POST", `/api/users/${id}/offices`, { officeId: emoOfficeId }, token));

    const body = (extra = {}) => ({ originLane: "EU-N", destLane: "NAM", validFrom: "2026-10-01", validTo: "2026-12-31", autoSwitch: true,
      options: [
        { carrierCode: "MSCU", contractId: mscu.id, note: "Weekly Monday cut-off" },
        { carrierCode: "CMDU", contractId: cmdu.id },
        { carrierCode: "HLCU", contractId: hlcu.id },
        { carrierCode: "ONEY", contractId: oney.id },
      ], ...extra });

    console.log("Who may steer");
    for (const [label, who] of [["OCC/BK", occBk], ["OCC/AY", occAy], ["CCL/CO", cclCo], ["Trade/AY", tradeAy], ["an operator", operator]])
      assert(`${label} can't steer a lane (403)`, (await request("POST", "/api/lane-steerings", body(), who)).status === 403);
    const created = await request("POST", "/api/lane-steerings", body(), tradeMgr);
    const st = created.body;
    if (st?.id) cleanup.steerings.push(st.id);
    assert("a Trade Manager steers EU-N → NAM for everyone (201)", created.status === 201 && st.originLane === "EU-N" && st.destLane === "NAM" && st.customerId === "" && st.autoSwitch === true,
      JSON.stringify(created.body).slice(0, 300));
    assert("the options keep their order, with contract numbers", st?.options?.map(o => `${o.rank}${o.carrierCode}`).join(",") === "1MSCU,2CMDU,3HLCU,4ONEY"
      && st.options[0].contractNumber === mscu.contractNumber && st.options[0].note === "Weekly Monday cut-off", JSON.stringify(st?.options));
    const all = (await request("GET", "/api/lane-steerings", null, occBk)).body;
    const listed = list(all).find(x => x.id === st.id);
    assert("everyone can read the list, with each contract's validity", !!listed && listed.options[0].contractValidTo === "2027-06-30" && listed.options[0].contractStatus === "Active",
      JSON.stringify(listed?.options?.[0]));

    console.log("\nWhat's refused");
    let r = await request("POST", "/api/lane-steerings", body({ originLane: "XX-NOPE" }), tradeMgr);
    assert("an unknown trade lane (400)", r.status === 400 && /Unknown trade lane/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", "/api/lane-steerings", body({ options: [] }), tradeMgr);
    assert("no options (400)", r.status === 400 && /at least one option/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", "/api/lane-steerings", body({ options: [{ carrierCode: "CMDU", contractId: mscu.id }] }), tradeMgr);
    assert("another carrier's contract (400)", r.status === 400 && /is a MSCU contract, not CMDU/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", "/api/lane-steerings", body({ options: [{ carrierCode: "MSCU", contractId: mscu.id }, { carrierCode: "MSCU", contractId: mscu.id }] }), tradeMgr);
    assert("the same contract twice (400)", r.status === 400 && /repeats a contract/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", "/api/lane-steerings", body({ validFrom: "2026-12-01", validTo: "2027-01-31" }), tradeMgr);
    assert("an overlapping window for the same lane and customer (409)", r.status === 409 && /already steered/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", "/api/lane-steerings", body({ validFrom: "2027-01-01", validTo: "2027-03-31" }), tradeMgr);
    if (r.body?.id) cleanup.steerings.push(r.body.id);
    assert("the next window, not overlapping, is fine (201)", r.status === 201, JSON.stringify(r.body).slice(0, 200));

    console.log("\nThe handler gets the steering first");
    const s = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU", status: "Active", contractType: "SPOT", contractRef: `SPOT-LS-${rand}`,
      etd: "2026-11-16", eta: "2026-11-30", incoterm: "FOB", commodityCode: "9999",
      shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId,
    }, token);
    const A = s.body.id;
    cleanup.shipments.push(A);
    await addContainer(request, token, A);
    await request("POST", `/api/shipments/${A}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
      etd: "2026-11-16", eta: "2026-11-30", carrierCode: "CMDU", vessel: "CMA CGM STEERING", vesselImo: "9999995", voyage: "0LS1W" }, token);
    await request("POST", `/api/shipments/${A}/edi-messages/booking-request`, {}, token);
    await carrierActs(request, token, A, "reject", "No space on 0LS1W");
    await request("POST", `/api/shipments/${A}/escalations`, { toRole: "occ_ay" }, occBk);
    let alts = (await request("GET", `/api/shipments/${A}/escalation/alternatives`, null, occAy)).body;
    assert("source: lane steering EU-N → NAM, with the switch on", alts?.source === "steering" && alts.lane === "EU-N → NAM" && alts.steering?.id === st.id && alts.steering.autoSwitch === true,
      JSON.stringify({ source: alts?.source, lane: alts?.lane, steering: alts?.steering }));
    const byRank = n => alts.options.find(o => o.rank === n);
    assert("#1 MSCU: usable, on its space configuration, with the steering's note", byRank(1)?.carrierCode === "MSCU" && byRank(1).usable && byRank(1).allocationId === alloc.id
      && /Weekly Monday cut-off/.test(byRank(1).note), JSON.stringify(byRank(1)));
    assert("#2 CMDU: usable, but no space configured on this route", byRank(2)?.carrierCode === "CMDU" && byRank(2).usable && byRank(2).allocationId === "" && /No space configured/.test(byRank(2).note),
      JSON.stringify(byRank(2)));
    assert("#3 HLCU: not usable, another customer's named account", byRank(3)?.usable === false && new RegExp(`named account ${other.companyName}`).test(byRank(3).note), JSON.stringify(byRank(3)));
    assert("#4 ONEY: not usable, it doesn't sail NLRTM → USNYC", byRank(4)?.usable === false && /doesn't cover NLRTM → USNYC/.test(byRank(4).note), JSON.stringify(byRank(4)));
    alts = (await request("GET", `/api/shipments/${A}/escalation/alternatives?source=contracts`, null, occAy)).body;
    assert("the handler can switch to the contract search (and back: the steering is still named)", alts?.source === "contracts" && alts.steering?.id === st.id
      && alts.options.some(o => o.carrierCode === "MSCU" && o.contractId === mscu.id), JSON.stringify({ source: alts?.source, options: alts?.options?.map(o => o.carrierCode) }));

    console.log("\nA customer's own steering wins");
    r = await request("POST", "/api/lane-steerings", { originLane: "EU-N", destLane: "NAM", customerId: shipper.id, customerName: shipper.companyName,
      validFrom: "2026-11-01", validTo: "2026-11-30", options: [{ carrierCode: "CMDU", contractId: cmdu.id, note: "Customer asked for CMA CGM" }] }, token);
    if (r.body?.id) cleanup.steerings.push(r.body.id);
    assert("admin steers the lane for the shipper alone, inside everyone's window (201)", r.status === 201 && r.body.customerName === shipper.companyName, JSON.stringify(r.body).slice(0, 200));
    alts = (await request("GET", `/api/shipments/${A}/escalation/alternatives`, null, occAy)).body;
    assert("the shipper's shipment gets the shipper's steering", alts?.steering?.id === r.body.id && alts.steering.customerName === shipper.companyName
      && alts.options.length === 1 && alts.options[0].carrierCode === "CMDU", JSON.stringify(alts?.steering));
    const own = r.body.id;

    console.log("\nChanges are recorded");
    r = await request("PUT", `/api/lane-steerings/${own}`, { originLane: "EU-N", destLane: "NAM", customerId: shipper.id, customerName: shipper.companyName,
      validFrom: "2026-11-01", validTo: "2026-11-30", autoSwitch: true,
      options: [{ carrierCode: "MSCU", contractId: mscu.id }, { carrierCode: "CMDU", contractId: cmdu.id, note: "Customer asked for CMA CGM" }] }, tradeMgr);
    assert("the Trade Manager reorders it and turns the switch on (200)", r.status === 200 && r.body.options.map(o => o.carrierCode).join(",") === "MSCU,CMDU" && r.body.autoSwitch, JSON.stringify(r.body).slice(0, 200));
    const events = list((await request("GET", `/api/entity-events/lane_steering/${own}`, null, token)).body);
    assert("the history has the creation and both changes", events.some(e => e.eventType === "CREATED") && events.some(e => e.field === "options" && /#1 MSCU/.test(e.newValue))
      && events.some(e => e.field === "autoSwitch" && e.newValue === "true"), JSON.stringify(events.map(e => `${e.eventType}:${e.field}`)));

    console.log("\nNo steering: the contract search");
    assert("OCC/AY can't remove it (403), nor edit it (403)", (await request("DELETE", `/api/lane-steerings/${own}`, null, occAy)).status === 403
      && (await request("PUT", `/api/lane-steerings/${own}`, body(), occAy)).status === 403);
    for (const id of [...cleanup.steerings]) await request("DELETE", `/api/lane-steerings/${id}`, null, tradeMgr);
    const left = list((await request("GET", "/api/lane-steerings", null, token)).body).filter(x => cleanup.steerings.includes(x.id));
    assert("the Trade Manager removes them", left.length === 0, JSON.stringify(left.map(x => x.id)));
    cleanup.steerings = [];
    alts = (await request("GET", `/api/shipments/${A}/escalation/alternatives`, null, occAy)).body;
    assert("the handler gets the contract search, Central first", alts?.source === "contracts" && alts.steering === null && alts.options.some(o => o.contractId === mscu.id),
      JSON.stringify({ source: alts?.source, steering: alts?.steering }));
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
    const users = list((await request("GET", "/api/users", null, token).catch(() => ({ body: [] }))).body);
    for (const email of cleanup.users) { const u = users.find(x => x.email === email); if (u) await request("DELETE", `/api/users/${u.id}`, null, token).catch(() => {}); }
  }
  console.log(`\n${"─".repeat(50)}\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
