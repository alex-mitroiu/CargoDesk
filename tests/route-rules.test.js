/**
 * The route rules on the server (the user's, 2026-11-06: "the order rules are non-negotiable")
 *
 * A shipment's legs run PKU, SEA, DEL: Pick-up legs (Merchant's Haulage first, then at most one Carrier's Haulage leg
 * to the port of loading), the sea legs, then Delivery legs (at most one Carrier's Haulage leg from the port of
 * discharge first, then Merchant's Haulage); and their dates run forward (a pick-up can't reach the POL after the
 * sea leg's ETD). Every leg write through the API is checked against the route it would leave behind and refused with
 * 400 { error, code: ROUTE_RULES, problems, help } when it breaks them (lib/route-rules.js; routes/shipments.js).
 * PUT /api/shipments/:id/legs saves a whole route at once, all or nothing. Routes already stored out of order are
 * left as they are (the user's call) until one is saved.
 *
 * Usage:
 *   node tests/route-rules.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account claudeagent@localhost (its password is the one tests/ai-assistant.test.js logs in with)
 */

import http from "node:http";
import fs from "node:fs";
import { ensureOffices } from "./helpers/offices.mjs";

let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      method, hostname: "localhost", port: 3001, path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
      },
    }, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function login() {
  const source = fs.readFileSync(new URL("./ai-assistant.test.js", import.meta.url), "utf8");
  const password = source.match(/login\("claudeagent@localhost",\s*"([^"]+)"\)/)?.[1];
  if (!password) throw new Error("Couldn't read the test admin's password from tests/ai-assistant.test.js");
  const { status, body } = await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

// The user's example route (2026-11-06).
const MH_PKU = { legType: "Pick-up", movementType: "Merchant's Haulage", movementBy: "Truck", pol: "NLAMS", polLocType: "Door",
  pod: "NLRTM", podLocType: "Container Yard", etd: "2026-12-07", eta: "2026-12-07" };
const CH_PKU = { legType: "Pick-up", movementType: "Carrier's Haulage", movementBy: "Truck", pol: "NLRTM", polLocType: "Container Yard",
  pod: "NLRTM", podLocType: "Terminal", etd: "2026-12-08", eta: "2026-12-08" };
const SEA = { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: "2026-12-10", eta: "2026-12-21",
  carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", voyage: "451W" };
const CH_DEL = { legType: "Delivery", movementType: "Carrier's Haulage", movementBy: "Truck", pol: "USNYC", polLocType: "Terminal",
  pod: "USJEC", podLocType: "Container Yard", etd: "2026-12-22", eta: "2026-12-22" };
const MH_DEL = { legType: "Delivery", movementType: "Merchant's Haulage", movementBy: "Truck", pol: "USJEC", polLocType: "Container Yard",
  pod: "USCHI", podLocType: "Door", etd: "2026-12-23", eta: "2026-12-26" };

(async () => {
  const shipments = [];
  try {
    const token = await login();
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const stamp = Date.now().toString(36).toUpperCase();
    const shipper = (await request("POST", "/api/customers", { companyName: `Route Rules Furniture ${stamp} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Route Rules Home ${stamp} Inc` }, token)).body;
    const scratch = async () => {
      const r = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active",
        contractType: "SPOT", contractRef: `SPOT-RR-${stamp}`, incoterm: "FOB", etd: SEA.etd, eta: SEA.eta, cargoReadyDate: "2026-12-04",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId }, token);
      if (r.status !== 201 && r.status !== 200) throw new Error(`shipment create failed: ${r.status} ${JSON.stringify(r.body)}`);
      shipments.push(r.body.id);
      return r.body.id;
    };
    const legsOf = async id => (await request("GET", `/api/shipments/${id}/legs`, null, token)).body;
    const shape = legs => legs.map(l => `${l.legType}:${l.movementType}:${l.pol}>${l.pod}`).join(" | ");

    console.log("\nThe user's example route saves whole, in one call");
    const s1 = await scratch();
    const saved = await request("PUT", `/api/shipments/${s1}/legs`, { legs: [MH_PKU, CH_PKU, SEA, CH_DEL, MH_DEL] }, token);
    assert("saved (200)", saved.status === 200, `${saved.status} ${JSON.stringify(saved.body)}`);
    assert("stored in that order, positions 0..4", shape(await legsOf(s1)) === shape([MH_PKU, CH_PKU, SEA, CH_DEL, MH_DEL])
      && (await legsOf(s1)).every((l, i) => l.legOrder === i), shape(await legsOf(s1)));

    console.log("\nWhole-route saves that break the rules are refused, and nothing changes");
    const before = shape(await legsOf(s1));
    const outOfOrder = await request("PUT", `/api/shipments/${s1}/legs`, { legs: (await legsOf(s1)).slice(1).concat([(await legsOf(s1))[0]]) }, token);
    assert("a pick-up after the delivery: 400 ROUTE_RULES", outOfOrder.status === 400 && outOfOrder.body.code === "ROUTE_RULES", JSON.stringify(outOfOrder.body));
    assert("says what's wrong and what the order should be", /comes after a sea leg/.test(outOfOrder.body.error) && /The order is: the pick-up legs/.test(outOfOrder.body.error)
      && Array.isArray(outOfOrder.body.problems) && /The order is/.test(outOfOrder.body.help), outOfOrder.body.error);
    assert("nothing written (all or nothing)", shape(await legsOf(s1)) === before, shape(await legsOf(s1)));
    const twoCh = await request("PUT", `/api/shipments/${s1}/legs`, { legs: [CH_PKU, { ...CH_PKU, pol: "NLAMS", polLocType: "Door" }, SEA] }, token);
    assert("two Carrier's Haulage pick-ups: refused", twoCh.status === 400 && /second Carrier's Haulage pick-up/.test(twoCh.body.error), JSON.stringify(twoCh.body));
    const mhAfterCh = await request("PUT", `/api/shipments/${s1}/legs`, { legs: [CH_PKU, MH_PKU, SEA] }, token);
    assert("Merchant's Haulage after Carrier's Haulage on the pick-up: refused", mhAfterCh.status === 400 && /Merchant's Haulage after a Carrier's Haulage pick-up/.test(mhAfterCh.body.error), JSON.stringify(mhAfterCh.body));
    const chAfterMh = await request("PUT", `/api/shipments/${s1}/legs`, { legs: [SEA, MH_DEL, CH_DEL] }, token);
    assert("Carrier's Haulage after Merchant's Haulage on the delivery: refused", chAfterMh.status === 400 && /Carrier's Haulage after a Merchant's Haulage delivery/.test(chAfterMh.body.error), JSON.stringify(chAfterMh.body));
    const lateDates = await request("PUT", `/api/shipments/${s1}/legs`, { legs: [{ ...CH_PKU, etd: "2026-12-11", eta: "2026-12-11" }, SEA] }, token);
    assert("a pick-up reaching the POL after the ETD: refused", lateDates.status === 400 && /departs 2026-12-10 \(ETD\), before leg 1 \(Pick-up\) arrives 2026-12-11/.test(lateDates.body.error)
      && /Correct the dates/.test(lateDates.body.error), JSON.stringify(lateDates.body));
    const noArrival = await request("PUT", `/api/shipments/${s1}/legs`, { legs: [{ ...CH_PKU, etd: "2026-12-11", eta: null }, SEA] }, token);
    assert("…also with no arrival date on the pick-up", noArrival.status === 400 && /even departs 2026-12-11/.test(noArrival.body.error), JSON.stringify(noArrival.body));
    const foreign = await request("PUT", `/api/shipments/${s1}/legs`, { legs: [{ ...SEA, id: "LEG-NOT-HERE" }] }, token);
    assert("a leg id from elsewhere: refused", foreign.status === 400 && /not one of this shipment's legs/.test(foreign.body.error), JSON.stringify(foreign.body));
    assert("a single CH pick-up, SEA, an MH delivery: allowed", (await request("PUT", `/api/shipments/${s1}/legs`,
      { legs: [CH_PKU, SEA, { ...MH_DEL, pol: "USNYC", polLocType: "Terminal" }] }, token)).status === 200);

    console.log("\nOne leg at a time");
    const s2 = await scratch();
    const sea2 = await request("POST", `/api/shipments/${s2}/legs`, SEA, token);
    assert("a SEA leg is added", sea2.status === 201, JSON.stringify(sea2.body));
    const pkuLast = await request("POST", `/api/shipments/${s2}/legs`, CH_PKU, token);
    assert("a pick-up added last (after the sea leg): refused", pkuLast.status === 400 && pkuLast.body.code === "ROUTE_RULES"
      && /comes after a sea leg/.test(pkuLast.body.error), JSON.stringify(pkuLast.body));
    assert("…and not stored", (await legsOf(s2)).length === 1);
    const pkuFirst = await request("POST", `/api/shipments/${s2}/legs`, { ...CH_PKU, legOrder: 0 }, token);
    assert("the same pick-up with legOrder 0: added in front", pkuFirst.status === 201 && shape(await legsOf(s2)) === shape([CH_PKU, SEA]), shape(await legsOf(s2)));
    const mhPku = await request("POST", `/api/shipments/${s2}/legs`, { ...MH_PKU, legOrder: 0 }, token);
    assert("a merchant's pick-up in front of it: added", mhPku.status === 201 && shape(await legsOf(s2)) === shape([MH_PKU, CH_PKU, SEA]), shape(await legsOf(s2)));
    const legs2 = await legsOf(s2);
    const second = await request("PUT", `/api/shipments/${s2}/legs/${legs2[0].id}`, { ...legs2[0], movementType: "Carrier's Haulage" }, token);
    assert("turning the merchant's pick-up into a second carrier's one: refused", second.status === 400 && /second Carrier's Haulage pick-up/.test(second.body.error), JSON.stringify(second.body));
    const moveSea = await request("PUT", `/api/shipments/${s2}/legs/${legs2[2].id}`, { ...legs2[2], legOrder: 0 }, token);
    assert("moving the sea leg in front of the pick-ups: refused", moveSea.status === 400 && /comes after a sea leg/.test(moveSea.body.error), JSON.stringify(moveSea.body));
    const vessel = await request("PUT", `/api/shipments/${s2}/legs/${legs2[2].id}`, { ...legs2[2], vessel: "MAERSK EDMONTON" }, token);
    assert("an ordinary edit (the vessel) on a route in order: saved", vessel.status === 200 && vessel.body.vessel === "MAERSK EDMONTON", JSON.stringify(vessel.body));
    const late = await request("PUT", `/api/shipments/${s2}/legs/${legs2[1].id}`, { ...legs2[1], eta: "2026-12-12" }, token);
    assert("a pick-up arrival after the ETD: refused", late.status === 400 && /before leg 2 \(Pick-up\) arrives 2026-12-12/.test(late.body.error), JSON.stringify(late.body));
    const del = await request("DELETE", `/api/shipments/${s2}/legs/${legs2[0].id}`, null, token);
    assert("removing a leg still works", del.status === 200, JSON.stringify(del.body));
  } catch (e) {
    console.error(e);
    failed++;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
