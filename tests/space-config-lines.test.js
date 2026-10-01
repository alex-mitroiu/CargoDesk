/**
 * Space configurations on contract routing lines (2026-09-30)
 *
 * Usage:
 *   node tests/space-config-lines.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *
 * A configuration ticks one or more routing lines of its contract (they share its TEU), names one
 * loop when the lines carry loop codes, optionally a customer, and one of the contract's commodity
 * codes, all inside the contract's validity. Duplicates are checked per routing LINE: same line,
 * same loop, customer and commodity, overlapping period. /match walks the configuration's own
 * lines and filters by loop, principal and commodity, customer-specific space first. A sailing on
 * another loop drops the shipment's space link (not its contract). Approved mockup:
 * https://claude.ai/artifact/MDkX8f7EEG3TNVquYeor3h
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

let passed = 0, failed = 0;
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ method, hostname: "localhost", port: 3001, path, headers: {
      "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }),
      ...(payload && { "Content-Length": Buffer.byteLength(payload) }) } }, res => {
      let data = ""; res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", reject); if (payload) req.write(payload); req.end();
  });
}
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

(async () => {
  let token; const cleanup = { shipments: [], allocations: [], contracts: [], customers: [] };
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    // Own customers, not the first ones listed: CI starts from an empty database with none.
    const newCustomer = async companyName => {
      const r = await request("POST", "/api/customers", { companyName }, token);
      if (!r.body.id) throw new Error(`customer ${companyName}: ${JSON.stringify(r.body)}`);
      cleanup.customers.push(r.body.id);
      return r.body;
    };
    const acme = await newCustomer("Space Lines Acme BV");
    const other = await newCustomer("Space Lines Other Inc");

    console.log("\nScratch contract: three routing lines, two loops, two commodities, Q4 validity");
    const contract = await request("POST", "/api/contracts", {
      contractNumber: `SCL-${Date.now()}`, carrierCode: "HLCU", status: "Active", validFrom: "2026-10-01", validTo: "2026-12-31",
      commodityTypes: "9999,002001",
      routings: [{ name: "Rotterdam–Los Angeles" }, { name: "Rotterdam–New York" }, { name: "Hamburg–New York" }],
      legs: [
        { pol: "NLRTM", pod: "USLAX", vesselService: "TPX", transitDays: 24, routingIndex: 0 },
        { pol: "NLRTM", pod: "USNYC", vesselService: "TPX", transitDays: 9, routingIndex: 1 },
        { pol: "DEHAM", pod: "USNYC", vesselService: "AL5", transitDays: 11, routingIndex: 2 },
      ],
      rates: [{ serviceCode: "OF", amount: 1800, currency: "USD", unit: "per_container" }],
    }, token);
    assert("contract created with three lines", contract.status === 201 && contract.body.routings.length === 3, JSON.stringify(contract.body.error || contract.body.routings));
    cleanup.contracts.push(contract.body.id);
    const [lineLAX, lineNYC, lineHAM] = contract.body.routings.map(r => r.id);
    const cfg = extra => ({ contractId: contract.body.id, allocatedTEU: 40, effectiveDate: "2026-10-01", endDate: "2026-10-31",
      routingIds: [lineLAX], loopCode: "TPX", commodityCode: "9999", ...extra });
    const create = async (label, extra, expect = 201) => {
      const r = await request("POST", "/api/allocations", cfg(extra), token);
      if (r.body.id) cleanup.allocations.push(r.body.id);
      assert(label, r.status === expect, JSON.stringify(r.body));
      return r;
    };

    console.log("\nCreating: per-line duplicates, loop, customer, commodity, validity");
    const c1 = await create("configuration on the Los Angeles line, loop TPX, FAK", {});
    assert("it stores its line, loop and commodity", JSON.stringify(c1.body.routingIds) === JSON.stringify([lineLAX]) && c1.body.loopCode === "TPX" && c1.body.commodityCode === "9999");
    const dup = await create("the same line, loop, customer and commodity in an overlapping period is a duplicate (400)", { effectiveDate: "2026-10-15", endDate: "2026-11-15" }, 400);
    assert("the message names the clashing configuration", /already has a space configuration/i.test(dup.body.error || "") && (dup.body.error || "").includes(c1.body.id), dup.body.error);
    await create("another line of the same reference in the same period is fine", { routingIds: [lineNYC] });
    const forAcme = await create("the same line for one customer is separate space", { customerId: acme.id, customerName: acme.companyName, allocatedTEU: 15 });
    await create("the same line for another commodity is separate space", { commodityCode: "002001", allocatedTEU: 10 });
    await create("the next month on the same line is fine", { effectiveDate: "2026-11-01", endDate: "2026-11-30" });
    const outside = await create("a period outside the contract's validity is refused", { effectiveDate: "2026-12-15", endDate: "2027-01-15" }, 400);
    assert("…with a message naming the validity", /inside the contract's validity/i.test(outside.body.error || ""), outside.body.error);
    const offLoop = await create("a ticked line that doesn't sail on the loop is refused", { routingIds: [lineLAX, lineHAM], effectiveDate: "2026-12-01", endDate: "2026-12-31" }, 400);
    assert("…naming the line and the loop", /doesn't sail on loop TPX/.test(offLoop.body.error || ""), offLoop.body.error);
    await create("several loops on the ticked lines and none picked is refused", { routingIds: [lineLAX, lineHAM], loopCode: "", effectiveDate: "2026-12-01", endDate: "2026-12-31" }, 400);
    await create("a commodity that isn't on the contract is refused", { commodityCode: "001404", effectiveDate: "2026-12-01", endDate: "2026-12-31" }, 400);
    await create("a routing that isn't on the contract is refused", { routingIds: ["CRTG-NOPE"], effectiveDate: "2026-12-01", endDate: "2026-12-31" }, 400);

    console.log("\nA reference reserved for a named account passes the account on");
    const named = await request("POST", "/api/contracts", {
      contractNumber: `SCL-NA-${Date.now()}`, carrierCode: "HLCU", status: "Active", validFrom: "2026-10-01", validTo: "2026-12-31",
      namedAccountId: other.id, namedAccount: other.companyName, legs: [{ pol: "NLRTM", pod: "USLAX", vesselService: "TPX" }],
    }, token);
    cleanup.contracts.push(named.body.id);
    const onNamed = await request("POST", "/api/allocations", { contractId: named.body.id, allocatedTEU: 20, effectiveDate: "2026-10-01", endDate: "2026-10-31",
      routingIds: [named.body.routings[0].id], customerId: acme.id, customerName: acme.companyName }, token);
    if (onNamed.body.id) cleanup.allocations.push(onNamed.body.id);
    assert("created, with the named account as its customer (not the one sent)", onNamed.status === 201 && onNamed.body.customerId === other.id, JSON.stringify(onNamed.body));

    console.log("\n/api/allocations/match walks the lines and filters by loop, principal and commodity");
    const match = async q => (await request("GET", `/api/allocations/match?pol=NLRTM&pod=USLAX&etd=2026-10-15&${q}`, null, token)).body.map(a => a.id);
    const forAcmeMatch = await match(`principalId=${acme.id}&commodityCode=9999&loopCode=TPX`);
    assert("Acme's shipment sees its own space first, then the general space", forAcmeMatch[0] === forAcme.body.id && forAcmeMatch.includes(c1.body.id), JSON.stringify(forAcmeMatch));
    assert("the New York line's configuration isn't offered on Los Angeles", !forAcmeMatch.some(id => cleanup.allocations.includes(id) && id !== forAcme.body.id && id !== c1.body.id && id !== onNamed.body.id), JSON.stringify(forAcmeMatch));
    assert("the other-commodity configuration isn't offered for FAK cargo", (await match(`principalId=${acme.id}&commodityCode=9999`)).length === forAcmeMatch.length);
    const noPrincipal = await match("commodityCode=9999&loopCode=TPX");
    assert("without a principal, customer-specific space isn't offered", !noPrincipal.includes(forAcme.body.id) && noPrincipal.includes(c1.body.id), JSON.stringify(noPrincipal));
    assert("a sailing on another loop sees none of the TPX space", !(await match(`principalId=${acme.id}&commodityCode=9999&loopCode=AL5`)).includes(c1.body.id));
    assert("the named-account space is only offered to that account", (await match(`principalId=${other.id}&commodityCode=9999`)).includes(onNamed.body.id)
      && !(await match(`principalId=${acme.id}&commodityCode=9999`)).includes(onNamed.body.id));

    console.log("\nA sailing on another loop drops the shipment's space link, not its contract");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USLAX", carrierCode: "HLCU", contractType: "Central", contractId: contract.body.id, contractRoutingId: lineLAX,
      allocationId: c1.body.id, spaceSelection: "direct", etd: "2026-10-12", eta: "2026-11-05", incoterm: "FOB", commodityCode: "9999",
      principalId: acme.id, principalName: acme.companyName, shipperId: acme.id, shipperName: acme.companyName,
      consigneeId: other.id, consigneeName: other.companyName, emoOfficeId, imoOfficeId,
    }, token);
    assert("shipment created on the TPX configuration", ship.status === 201 && ship.body.allocationId === c1.body.id, JSON.stringify(ship.body.error || ship.body.allocationId));
    cleanup.shipments.push(ship.body.id);
    await request("POST", "/api/containers", { shipmentId: ship.body.id, size: "40", type: "HC", cargoDescription: "Furniture, flat-packed", grossWeightKg: 9800 }, token);
    const onLoop = await request("POST", `/api/shipments/${ship.body.id}/schedules`, { carrier: "HLCU", vesselName: "Test Vessel TPX", voyageNumber: "041W",
      service: "TPX", pol: "NLRTM", pod: "USLAX", etd: "2026-10-12", eta: "2026-11-05", transitDays: 24, isMock: true }, token);
    assert("a sailing on loop TPX keeps the space link", onLoop.status === 201 && !onLoop.body.spaceUnlinked, JSON.stringify(onLoop.body.spaceUnlinked));
    await request("DELETE", `/api/shipments/${ship.body.id}/schedules/${onLoop.body.id}`, null, token);
    const offLoopSailing = await request("POST", `/api/shipments/${ship.body.id}/schedules`, { carrier: "HLCU", vesselName: "Test Vessel AL5", voyageNumber: "112W",
      service: "AL5", pol: "NLRTM", pod: "USLAX", etd: "2026-10-14", eta: "2026-11-08", transitDays: 25, isMock: true }, token);
    assert("a sailing on loop AL5 reports the space link dropped", offLoopSailing.body.spaceUnlinked?.allocationId === c1.body.id && offLoopSailing.body.spaceUnlinked?.loop === "AL5", JSON.stringify(offLoopSailing.body.spaceUnlinked));
    const after = (await request("GET", `/api/shipments/${ship.body.id}`, null, token)).body;
    assert("the shipment is off the space but keeps its contract", !after.allocationId && after.contractId === contract.body.id, JSON.stringify({ a: after.allocationId, c: after.contractId }));
    const events = (await request("GET", `/api/entity-events/shipment/${ship.body.id}`, null, token)).body;
    assert("the change is in the shipment's history", events.some(e => e.eventType === "SPACE_UNLINKED"));

    console.log("\nGuards: lines in use can't be removed or unticked");
    const full = (await request("GET", `/api/contracts/${contract.body.id}`, null, token)).body;
    const dropLAX = await request("PUT", `/api/contracts/${contract.body.id}`, { ...full,
      routings: full.routings.filter(r => r.id !== lineLAX), legs: full.legs.filter(l => l.routingId !== lineLAX), rates: full.rates.filter(r => r.routingId !== lineLAX) }, token);
    assert("removing a contract line a space configuration uses is refused (409)", dropLAX.status === 409 && /space configuration/.test(dropLAX.body.error || ""), JSON.stringify(dropLAX.body));
    await request("PUT", `/api/shipments/${ship.body.id}`, { allocationId: c1.body.id, spaceSelection: "direct" }, token);
    const untick = await request("PUT", `/api/allocations/${c1.body.id}`, cfg({ routingIds: [lineNYC] }), token);
    assert("unticking a line a linked shipment travels on is refused (409)", untick.status === 409 && (untick.body.error || "").includes(ship.body.id), JSON.stringify(untick.body));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e); process.exitCode = 1;
  } finally {
    for (const id of cleanup.shipments) { try { await request("DELETE", `/api/shipments/${id}`, null, token); } catch {} }
    for (const id of cleanup.allocations) { try { await request("DELETE", `/api/allocations/${id}`, null, token); } catch {} }
    for (const id of cleanup.contracts) { try { await request("DELETE", `/api/contracts/${id}`, null, token); } catch {} }
    for (const id of cleanup.customers) { try { await request("DELETE", `/api/customers/${id}`, null, token); } catch {} }
  }
})();
