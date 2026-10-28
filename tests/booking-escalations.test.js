/**
 * Booking escalations (Epic TKT-ASIYFL, Story 3 TKT-ZNHO3A; agreed 2026-10-20).
 *   - a booking the carrier rejected can be escalated by OCC/BK of the export side, once, to OCC/AY
 *     (the default) or CCL/CO;
 *   - only the current holder acts: OCC/AY ⇄ CCL/CO hand over, either escalates to Trade/AY, Trade/AY
 *     escalates to Trade (messages only) or sends it back, and instructions go back to OCC/BK, who can
 *     question them; Trade/AY can mark the booking impossible;
 *   - people outside the shipment's offices or lane can't act; every step is in the shipment's History;
 *   - "escalated to me" lists what each person can act on;
 *   - no answer: a booking without a carrier decision for the no-answer time can be escalated, and the
 *     escalation resolves itself when the carrier confirms after all.
 * Book As Instructed is Story 4 (tests/booking-escalation-book.test.js).
 *
 * Usage:
 *   node tests/booking-escalations.test.js
 *
 * Prerequisites:
 *   - npm run dev (Express :3001), not in production (the built-in DCSA carrier plays CMDU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC in port_locations with their trade lanes (seeded MDM data)
 */

import { ensureOffices, retireOffice } from "./helpers/offices.mjs";
import { carrierActs, waitForCarrierReference, addContainer } from "./helpers/dcsa-sim.mjs";

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
const list = b => (Array.isArray(b) ? b : (b?.results ?? []));

(async () => {
  const cleanup = { shipments: [], customers: [], users: [], offices: [] };
  let token, savedHours = null;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const otherSE = (await request("POST", "/api/offices", { unlocode: `X${rand.slice(0, 4)}`, department: "SE", name: `Escalation Test SE ${rand}` }, token)).body;
    cleanup.offices.push(otherSE.id);
    const shipper = (await request("POST", "/api/customers", { companyName: `Escalation Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Escalation Consignee ${rand} Inc` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id);

    const newShipment = async () => {
      const s = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU", status: "Active", contractType: "SPOT", contractRef: `SPOT-ESC-${rand}`,
        etd: "2026-11-16", eta: "2026-11-30", incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId,
      }, token);
      cleanup.shipments.push(s.body.id);
      await addContainer(request, token, s.body.id);
      await request("POST", `/api/shipments/${s.body.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
        etd: "2026-11-16", eta: "2026-11-30", carrierCode: "CMDU", vessel: "CMA CGM ESCALATION", vesselImo: "9999995", voyage: "0ES1W" }, token);
      return s.body.id;
    };
    const send = id => request("POST", `/api/shipments/${id}/edi-messages/booking-request`, {}, token);

    // People: OCC/BK and OCC/AY of the export office, CCL/CO of the import office, Trade/AY and Trade
    // of the lane, and an OCC/AY of another office.
    const users = {};
    const makeUser = async (key, roles, setup) => {
      const email = `esc-${key}-${rand.toLowerCase()}@example.com`;
      await request("POST", "/api/users", { email, name: `${key} ${rand}`, roles, password: "EscFixture!2026Zq" }, token);
      cleanup.users.push(email);
      const id = list((await request("GET", "/api/users", null, token)).body).find(u => u.email === email)?.id;
      await setup?.(id);
      users[key] = (await request("POST", "/api/auth/login", { email, password: "EscFixture!2026Zq" })).body.token;
    };
    const lane = id => request("POST", `/api/users/${id}/scope`, { role: "", itemType: "trade_lane", value: JSON.stringify({ origin: "EU-N", dest: "NAM" }), label: "EU-N → NAM" }, token);
    await makeUser("occbk", ["occ_bk"], id => request("POST", `/api/users/${id}/offices`, { officeId: emoOfficeId }, token));
    await makeUser("occay", ["occ_ay"], id => request("POST", `/api/users/${id}/offices`, { officeId: emoOfficeId }, token));
    await makeUser("cclco", ["ccl_co"], id => request("POST", `/api/users/${id}/offices`, { officeId: imoOfficeId }, token));
    await makeUser("tradeay", ["trade_ay"], lane);
    await makeUser("trade", ["trade_manager"], lane);
    await makeUser("otheray", ["occ_ay"], id => request("POST", `/api/users/${id}/offices`, { officeId: otherSE.id }, token));

    const view = (id, who) => request("GET", `/api/shipments/${id}/escalation`, null, users[who]);
    const act = (escId, who, body) => request("POST", `/api/escalations/${escId}/actions`, body, users[who]);

    console.log("Nothing to escalate before the carrier answers");
    const A = await newShipment();
    const early = await request("POST", `/api/shipments/${A}/escalations`, { toRole: "occ_ay" }, users.occbk);
    assert("escalating a booking that was never sent is refused (409)", early.status === 409, JSON.stringify(early.body));

    console.log("\nThe carrier rejects; OCC/BK escalates");
    await send(A);
    await carrierActs(request, token, A, "reject", "No space on 0ES1W");
    let v = (await view(A, "occbk")).body;
    assert("OCC/BK is offered the escalation: rejected, OCC/AY by default", v?.offer?.allowed === true && v.offer.trigger === "rejected" && v.offer.defaultGroup === "occ_ay", JSON.stringify(v?.offer));
    assert("OCC/AY can't escalate it themselves (403)", (await request("POST", `/api/shipments/${A}/escalations`, {}, users.occay)).status === 403);
    const created = await request("POST", `/api/shipments/${A}/escalations`, { toRole: "occ_ay", reasonCode: "no_space", note: "Needed in New York by 10 Dec" }, users.occbk);
    const esc = created.body?.escalation;
    assert("OCC/BK escalates it to OCC/AY (201)", created.status === 201 && esc?.holderRole === "occ_ay" && esc.status === "open" && esc.trigger === "rejected", JSON.stringify(created.body).slice(0, 300));
    assert("it says where: OCC/AY of the export office", !!created.body?.place, JSON.stringify(created.body?.place));
    assert("a second escalation is refused (409)", (await request("POST", `/api/shipments/${A}/escalations`, {}, users.occbk)).status === 409);

    console.log("\nThe Shipments list's Booking column (Story 2)");
    const page = async (who, q) => (await request("GET", `/api/shipments?limit=500&offset=0${q}`, null, users[who])).body;
    let p = await page("occay", "&escalatedToMe=1");
    const rowA = p.results.find(x => x.id === A);
    assert("Escalated to me: OCC/AY of the export office finds it", !!rowA && p.escalatedToMe >= 1, JSON.stringify({ total: p.total, mine: p.escalatedToMe }));
    assert("its Booking value says escalated, rejected, with OCC/AY", rowA?.bookingState?.label === "Escalated" && /Rejected · OCC\/AY/.test(rowA.bookingState.sub) && rowA.bookingState.holderRole === "occ_ay", JSON.stringify(rowA?.bookingState));
    assert("…and not in CCL/CO's Escalated to me", !(await page("cclco", "&escalatedToMe=1")).results.some(x => x.id === A));
    p = await page("occbk", `&booking=${encodeURIComponent("Escalated")}`);
    assert("the Booking column filters on its value", p.results.some(x => x.id === A) && p.results.every(x => x.bookingState.label === "Escalated"), String(p.total));
    assert("the quick-filter counts come with the page", (p.bookingCounts?.Escalated || 0) >= 1, JSON.stringify(p.bookingCounts));

    console.log("\nOnly the holder acts");
    v = (await view(A, "occay")).body;
    assert("OCC/AY may send instructions, hand over or escalate", ["instruct", "hand_over", "escalate", "message"].every(a => v.actions.includes(a)), JSON.stringify(v.actions));
    assert("OCC/AY of another office doesn't see the shipment (404)", (await view(A, "otheray")).status === 404);
    assert("CCL/CO can't escalate while OCC/AY holds it (403)", (await act(esc.id, "cclco", { action: "escalate" })).status === 403);
    let r = await act(esc.id, "occay", { action: "hand_over", message: "Consignee side first" });
    assert("OCC/AY hands it over to CCL/CO", r.status === 200 && r.body.escalation.holderRole === "ccl_co", JSON.stringify(r.body).slice(0, 200));
    r = await act(esc.id, "cclco", { action: "escalate", message: "No Central space on the lane" });
    assert("CCL/CO escalates to Trade/AY", r.status === 200 && r.body.escalation.holderRole === "trade_ay");
    r = await act(esc.id, "tradeay", { action: "escalate", message: "Allocation question" });
    assert("Trade/AY escalates to Trade", r.status === 200 && r.body.escalation.holderRole === "trade_manager");
    assert("Trade can't send instructions (409)", (await act(esc.id, "trade", { action: "instruct", instruction: { carrierCode: "MSCU", sailing: { vesselName: "X", etd: "2026-11-20" } } })).status === 409);
    assert("Trade can add a message", (await act(esc.id, "trade", { action: "message", message: "Ask CMDU about the extra loader" })).status === 200);
    r = await act(esc.id, "trade", { action: "send_back" });
    assert("Trade sends it back to Trade/AY", r.status === 200 && r.body.escalation.holderRole === "trade_ay");
    r = await act(esc.id, "tradeay", { action: "send_back" });
    assert("Trade/AY sends it back to whoever escalated it (CCL/CO)", r.status === 200 && r.body.escalation.holderRole === "ccl_co", r.body?.escalation?.holderRole);

    console.log("\nInstructions go back to OCC/BK");
    assert("an instruction without a sailing is refused (400)", (await act(esc.id, "cclco", { action: "instruct", instruction: { carrierCode: "HLCU" } })).status === 400);
    // CMDU's quote can't go to HLCU, and a DCSA booking names a contract or quote (the DCSA review, 2026-10-27).
    const noContract = await act(esc.id, "cclco", { action: "instruct", instruction: { carrierCode: "HLCU",
      sailing: { vesselName: "DEMO BRAVURA", voyageNumber: "DM002W", etd: "2026-11-21", eta: "2026-12-05" } } });
    assert("instructions for another carrier naming no contract are refused (400), saying so", noContract.status === 400
      && /Name the HLCU contract/.test(noContract.body?.error), JSON.stringify(noContract.body));
    const instruction = { carrierCode: "HLCU", contractNumber: "EC-HLCU-NLAMS-USNYC", source: "contracts", rank: 1,
      sailing: { vesselName: "DEMO BRAVURA", voyageNumber: "DM002W", etd: "2026-11-21", eta: "2026-12-05", service: "DEMO SERVICE", transitDays: 14 } };
    r = await act(esc.id, "cclco", { action: "instruct", instruction, message: "HLCU has space a week later" });
    assert("CCL/CO sends instructions: OCC/BK has it", r.status === 200 && r.body.escalation.status === "instructed" && r.body.escalation.holderRole === "occ_bk" && r.body.escalation.instruction?.sailing?.vesselName === "DEMO BRAVURA", JSON.stringify(r.body).slice(0, 300));
    const mine = async who => list((await request("GET", "/api/escalations/mine", null, users[who])).body).some(e => e.id === esc.id);
    assert("it's in OCC/BK's escalated-to-me list", await mine("occbk"));
    assert("…and no longer in CCL/CO's", !(await mine("cclco")));
    v = (await view(A, "occbk")).body;
    assert("OCC/BK may book as instructed or send it back with a question", v.actions.includes("book") && v.actions.includes("question"), JSON.stringify(v.actions));
    assert("a question needs words (400)", (await act(esc.id, "occbk", { action: "question" })).status === 400);
    r = await act(esc.id, "occbk", { action: "question", message: "Is the 21 Nov departure confirmed space?" });
    assert("OCC/BK's question sends it back to CCL/CO", r.status === 200 && r.body.escalation.status === "open" && r.body.escalation.holderRole === "ccl_co");
    assert("it's back in CCL/CO's list", await mine("cclco"));

    console.log("\nEvery step is on the shipment");
    const steps = (await view(A, "occbk")).body.steps.map(s => s.action);
    assert("the escalation lists its steps in order", JSON.stringify(steps) === JSON.stringify(["escalated", "hand_over", "escalate", "escalate", "message", "send_back", "send_back", "instructed", "question"]), JSON.stringify(steps));
    const events = list((await request("GET", `/api/shipments/${A}/events`, null, token)).body).filter(e => /^ESCALATION_/.test(e.eventType || e.type || ""));
    assert("the shipment History has them too, with names", events.length >= 9 && events.every(e => (e.actor || "") !== ""), String(events.length));

    console.log("\nTrade/AY can mark a booking impossible");
    const B = await newShipment();
    await send(B);
    await carrierActs(request, token, B, "reject", "No space");
    const escB = (await request("POST", `/api/shipments/${B}/escalations`, {}, users.occbk)).body.escalation;
    assert("without a group named it goes to the default, OCC/AY", escB?.holderRole === "occ_ay", JSON.stringify(escB));
    assert("OCC/AY can't mark it impossible (409)", (await act(escB.id, "occay", { action: "impossible", reason: "x" })).status === 409);
    await act(escB.id, "occay", { action: "escalate" });
    assert("Trade/AY needs a reason (400)", (await act(escB.id, "tradeay", { action: "impossible" })).status === 400);
    r = await act(escB.id, "tradeay", { action: "impossible", reason: "No carrier on the lane can load before December" });
    assert("Trade/AY marks it impossible: closed", r.status === 200 && r.body.escalation.status === "impossible" && !!r.body.escalation.closedAt);
    assert("nothing more can happen on it (409)", (await act(escB.id, "tradeay", { action: "send_back" })).status === 409);

    console.log("\nNo answer, then the carrier confirms after all");
    savedHours = (await request("GET", "/api/settings", null, token)).body?.booking_no_answer_hours ?? "2";
    await request("PUT", "/api/settings", { booking_no_answer_hours: "0.0002" }, token);  // under a second
    const C = await newShipment();
    await send(C);
    await waitForCarrierReference(request, token, C);
    await sleep(1200);
    v = (await view(C, "occbk")).body;
    assert("an unanswered booking can be escalated: no answer", v.offer.allowed && v.offer.trigger === "no_answer", JSON.stringify(v.offer));
    const escC = (await request("POST", `/api/shipments/${C}/escalations`, { toRole: "ccl_co" }, users.occbk)).body.escalation;
    assert("escalated to CCL/CO on request", escC?.holderRole === "ccl_co" && escC.trigger === "no_answer", JSON.stringify(escC));
    await carrierActs(request, token, C, "confirm");
    await sleep(400);
    const after = (await view(C, "occbk")).body.escalation;
    assert("the carrier confirming resolves the escalation", after?.status === "resolved" && !!after.closedAt, JSON.stringify(after));
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    if (savedHours !== null) await request("PUT", "/api/settings", { booking_no_answer_hours: String(savedHours) }, token).catch(() => {});
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
    if (cleanup.users.length) {
      const all = list((await request("GET", "/api/users", null, token)).body);
      for (const email of cleanup.users) { const u = all.find(x => x.email === email); if (u) await request("DELETE", `/api/users/${u.id}`, null, token).catch(() => {}); }
    }
    for (const id of cleanup.offices) await retireOffice(token, id).catch(() => {});
    console.log(`\n${"─".repeat(50)}\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
