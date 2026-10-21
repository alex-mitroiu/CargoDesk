/**
 * Carrier answer handling (Epic TKT-ASIYFL, Story 6 TKT-JHUTK5; agreed 2026-10-20).
 *   - accepted with changes: when the carrier confirms, CargoDesk reads the confirmed booking (DCSA GET)
 *     and compares it with the request — vessel / voyage, departure and arrival outside the tolerance
 *     (arrival against the shipment's ETA when the request was sent), equipment, ports, per App
 *     Settings' change rules. The Booking column says "Confirmed with changes" and what
 *     changed; OCC/BK may escalate it, and the escalation shows the changes. The instructed carrier
 *     confirming with changes sends a booked-as-instructed escalation back, like a rejection;
 *   - no answer: a booking without a carrier decision for the no-answer time, on a lane steered with the
 *     switch on, is withdrawn and booked on the next option with space, on its Recommended sailing
 *     (shortest transit) from the requested ETD — no OCC/BK step. With no option left, or no steering, it escalates to OCC/AY on its
 *     own, once per booking.
 *
 * Usage:
 *   node tests/booking-carrier-answers.test.js
 *
 * Prerequisites:
 *   - npm run dev (Express :3001), not in production (the built-in DCSA carrier plays CMDU and MSCU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC in port_locations with their trade lanes EU-N and NAM (seeded MDM data)
 */

import { ensureOffices } from "./helpers/offices.mjs";
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
  const cleanup = { steerings: [], allocations: [], contracts: [], shipments: [], customers: [], users: [] };
  let token, saved = null;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    saved = (await request("GET", "/api/settings", null, token)).body;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const shipper = (await request("POST", "/api/customers", { companyName: `Answers Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Answers Consignee ${rand} Inc` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id);

    const newShipment = async ({ pol = "NLRTM", pod = "USNYC", carrierCode = "CMDU", vessel = "CMA CGM ANSWERS", voyage = "0AN1W" } = {}) => {
      const s = await request("POST", "/api/shipments", {
        pol, pod, carrierCode, status: "Active", contractType: "SPOT", contractRef: `SPOT-ANS-${rand}`,
        etd: "2026-11-16", eta: "2026-11-30", incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId,
      }, token);
      cleanup.shipments.push(s.body.id);
      await addContainer(request, token, s.body.id);
      await request("POST", `/api/shipments/${s.body.id}/legs`, { legType: "SEA", movementType: "SEA", pol, pod,
        etd: "2026-11-16", eta: "2026-11-30", carrierCode, vessel, vesselImo: "9999995", voyage }, token);
      return s.body.id;
    };
    const send = async id => { await request("POST", `/api/shipments/${id}/edi-messages/booking-request`, {}, token); return waitForCarrierReference(request, token, id); };
    const row = async id => list((await request("GET", `/api/shipments?limit=50&offset=0&search=${id}`, null, token)).body).find(x => x.id === id);
    const makeUser = async (key, roles, officeId) => {
      const email = `ans-${key}-${rand.toLowerCase()}@example.com`;
      await request("POST", "/api/users", { email, name: `${key} ${rand}`, roles, password: "AnsFixture!2026Zq" }, token);
      cleanup.users.push(email);
      const id = list((await request("GET", "/api/users", null, token)).body).find(u => u.email === email)?.id;
      await request("POST", `/api/users/${id}/offices`, { officeId }, token);
      return (await request("POST", "/api/auth/login", { email, password: "AnsFixture!2026Zq" })).body.token;
    };
    const occBk = await makeUser("occbk", ["occ_bk"], emoOfficeId);
    const occAy = await makeUser("occay", ["occ_ay"], emoOfficeId);

    console.log("Confirmed with changes");
    const A = await newShipment();
    await send(A);
    let r = await carrierActs(request, token, A, "confirmWithChanges", "Rolled to next week's sailing");
    assert("the carrier confirms with changes (simulator)", r.status === 200 && r.body?.simulator?.transportPlan?.[0]?.vesselName === "DEMO SUBSTITUTE"
      && r.body.simulator.confirmedEquipments?.length > 0 && r.body.simulator.shipmentCutOffTimes?.length === 3, JSON.stringify(r.body?.simulator?.transportPlan));
    let b;
    let st = (await row(A))?.bookingState;
    assert("the Booking column says Confirmed with changes, and what changed", st?.label === "Confirmed with changes" && /Vessel \/ voyage/.test(st.sub) && /Departure/.test(st.sub) && /Arrival/.test(st.sub), JSON.stringify(st));
    let v = (await request("GET", `/api/shipments/${A}/escalation`, null, occBk)).body;
    const changes = v?.offer?.changes || [];
    assert("OCC/BK is offered the escalation, with the changes", v?.offer?.allowed && v.offer.trigger === "changed"
      && changes.some(c => c.field === "vessel" && /CMA CGM ANSWERS · 0AN1W/.test(c.requested) && /DEMO SUBSTITUTE · DM777W/.test(c.confirmed))
      && changes.some(c => c.field === "dates" && c.requested === "2026-11-16" && c.confirmed === "2026-11-23")
      && changes.some(c => c.field === "arrival" && c.requested === "2026-11-30" && c.confirmed === "2026-12-07"), JSON.stringify(v?.offer));
    assert("…and only those: same equipment, same ports", !changes.some(c => ["equipment", "ports"].includes(c.field)), JSON.stringify(changes.map(c => c.field)));
    r = await request("POST", `/api/shipments/${A}/escalations`, { toRole: "occ_ay", reasonCode: "later_sailing" }, occBk);
    assert("escalated, the escalation keeps the changes", r.status === 201 && r.body.escalation.trigger === "changed" && r.body.escalation.sailing?.changes?.length === 3,
      JSON.stringify(r.body?.escalation?.sailing));

    const B = await newShipment();
    await send(B);
    await carrierActs(request, token, B, "confirm");
    st = (await row(B))?.bookingState;
    assert("a plain confirmation is just Confirmed: the carrier's arrival is the requested ETA", st?.label === "Confirmed", JSON.stringify(st));

    console.log("\nThe change rules (App Settings)");
    await request("PUT", "/api/settings", { booking_change_rules: JSON.stringify({ vessel: false, dates: true, toleranceDays: 10, equipment: true, ports: true }) }, token);
    const C = await newShipment();
    await send(C);
    await carrierActs(request, token, C, "confirmWithChanges");
    st = (await row(C))?.bookingState;
    assert("vessel changes not counted, departure and arrival 7 days off inside a 10-day tolerance: Confirmed", st?.label === "Confirmed", JSON.stringify(st));
    await request("PUT", "/api/settings", { booking_change_rules: saved.booking_change_rules }, token);

    console.log("\nThe instructed carrier confirms with changes");
    const D = await newShipment();
    await send(D);
    await carrierActs(request, token, D, "reject", "No space");
    const escD = (await request("POST", `/api/shipments/${D}/escalations`, { toRole: "occ_ay" }, occBk)).body.escalation;
    await request("POST", `/api/escalations/${escD.id}/actions`, { action: "instruct", message: "MSCU the same week",
      instruction: { carrierCode: "MSCU", sailing: { vesselName: "DEMO ALLEGRO", voyageNumber: "DM001W", etd: "2026-11-18", eta: "2026-12-02" } } }, occAy);
    r = await request("POST", `/api/escalations/${escD.id}/book`, {}, occBk);
    assert("OCC/BK books MSCU as instructed", r.status === 200, JSON.stringify(r.body).slice(0, 200));
    await carrierActs(request, token, D, "confirmWithChanges");
    await sleep(300);
    v = (await request("GET", `/api/shipments/${D}/escalation`, null, occAy)).body;
    assert("it's back with OCC/AY, open, about MSCU's changes", v.escalation.status === "open" && v.escalation.holderRole === "occ_ay" && v.escalation.trigger === "changed"
      && v.escalation.carrierCode === "MSCU" && v.escalation.sailing?.changes?.some(c => c.field === "vessel"), JSON.stringify(v.escalation).slice(0, 400));
    assert("the steps say so", v.steps.at(-1)?.action === "carrier_changed" && /MSCU confirmed the booking made as instructed with changes/.test(v.steps.at(-1).message), JSON.stringify(v.steps.at(-1)));

    console.log("\nNo answer: the switch to the next steered option");
    const contract = async carrierCode => {
      const c = (await request("POST", "/api/contracts", { contractNumber: `TC-ANS-${carrierCode}-${rand}`, carrierCode, status: "Active",
        validFrom: "2026-01-01", validTo: "2027-06-30", legs: [{ pol: "NLRTM", pod: "USNYC" }] }, token)).body;
      cleanup.contracts.push(c.id);
      return c;
    };
    const cmdu = await contract("CMDU"), mscu = await contract("MSCU");
    for (const c of [cmdu, mscu]) {
      const a = (await request("POST", "/api/allocations", { contractId: c.id, routingIds: [c.routings[0].id], allocatedTEU: 20, effectiveDate: "2026-10-01", endDate: "2026-12-31" }, token)).body;
      cleanup.allocations.push(a.id);
    }
    const steer = (await request("POST", "/api/lane-steerings", { originLane: "EU-N", destLane: "NAM", customerId: shipper.id, customerName: shipper.companyName,
      validFrom: "2026-10-01", validTo: "2026-12-31", autoSwitch: true,
      options: [{ carrierCode: "CMDU", contractId: cmdu.id }, { carrierCode: "MSCU", contractId: mscu.id }] }, token)).body;
    if (steer?.id) cleanup.steerings.push(steer.id);
    assert("the shipper's lane is steered #1 CMDU, #2 MSCU, switch on", steer?.autoSwitch === true && steer.options.length === 2, JSON.stringify(steer).slice(0, 200));

    await request("PUT", "/api/settings", { booking_no_answer_hours: "0.0002" }, token);
    const E = await newShipment();
    const first = await send(E);
    await sleep(1200);
    r = await request("POST", "/api/escalations/no-answer-sweep", {}, token);
    assert("the sweep runs (admin)", r.status === 200 && Array.isArray(r.body?.switched), JSON.stringify(r.body).slice(0, 300));
    assert("OCC/BK can't run it (403)", (await request("POST", "/api/escalations/no-answer-sweep", {}, occBk)).status === 403);
    const s = (await request("GET", `/api/shipments/${E}`, null, token)).body;
    // The Recommended MSCU sailing from the requested ETD: the shortest transit, the earlier departure on a tie.
    const offered = list((await request("GET", "/api/schedules/search?pol=NLRTM&pod=USNYC&carrierCode=MSCU&weeks=6&onlyCarrier=1", null, token)).body?.sailings)
      .filter(x => x.etd >= "2026-11-16").sort((a, b) => a.transitDays - b.transitDays || a.etd.localeCompare(b.etd)); // transshipments too (2026-10-21)
    const best = offered[0];
    assert("CMDU didn't answer: the shipment moved to MSCU, Central on #2, on its Recommended sailing (shortest transit from the requested ETD)",
      s.carrierCode === "MSCU" && s.contractType === "Central" && s.contractId === mscu.id && !!best
        && String(s.etd).slice(0, 10) === best.etd && s.vessel === best.vesselName && String(s.eta).slice(0, 10) === best.eta,
      JSON.stringify({ c: s.carrierCode, t: s.contractType, etd: s.etd, v: s.vessel, best: best && { etd: best.etd, v: best.vesselName, tt: best.transitDays }, first: offered.map(o => `${o.etd}/${o.transitDays}`) }));
    b = await waitForCarrierReference(request, token, E);
    assert("a new request went to MSCU", b?.carrierCode === "MSCU" && b.status === "Pending" && b.carrierBookingRequestReference !== first?.carrierBookingRequestReference, JSON.stringify(b).slice(0, 200));
    const archived = list((await request("GET", `/api/shipments/${E}/carrier-booking-history`, null, token)).body).find(h => h.carrierCode === "CMDU");
    const withdrawn = list((await request("GET", `/api/shipments/${E}/edi-messages`, null, token)).body)
      .find(m => m.direction === "out" && m.messageType === "booking_cancellation" && m.carrierCode === "CMDU");
    assert("the unanswered CMDU request was withdrawn at CMDU and archived", archived?.status === "Cancelled" && /Carrier changed to MSCU/.test(archived.cancelReason || "")
      && !/not told/.test(archived.cancelReason || "") && !!withdrawn, JSON.stringify({ archived: archived && { s: archived.status, r: archived.cancelReason }, withdrawn: !!withdrawn }));
    const history = list((await request("GET", `/api/shipments/${E}/events`, null, token)).body);
    assert("the History says why", history.some(h => (h.eventType || h.event_type) === "NO_ANSWER_SWITCHED"), JSON.stringify(history.slice(0, 5).map(h => h.eventType || h.event_type)));
    assert("no escalation for a switch", (await request("GET", `/api/shipments/${E}/escalation`, null, occBk)).body?.escalation === null);

    console.log("\nNo answer, no option left: escalated on its own");
    await sleep(1200);
    await request("POST", "/api/escalations/no-answer-sweep", {}, token);
    v = (await request("GET", `/api/shipments/${E}/escalation`, null, occAy)).body;
    assert("MSCU (#2, the last option) didn't answer either: escalated to OCC/AY by CargoDesk", v?.escalation?.status === "open" && v.escalation.trigger === "no_answer"
      && v.escalation.holderRole === "occ_ay" && v.escalation.automatic === true && v.escalation.carrierCode === "MSCU", JSON.stringify(v?.escalation).slice(0, 300));
    st = (await row(E))?.bookingState;
    assert("…shown in the Booking column", st?.label === "Escalated" && /No answer · OCC\/AY/.test(st.sub), JSON.stringify(st));
    await request("POST", `/api/escalations/${v.escalation.id}/actions`, { action: "withdraw" }, occBk);
    await sleep(1200);
    await request("POST", "/api/escalations/no-answer-sweep", {}, token);
    v = (await request("GET", `/api/shipments/${E}/escalation`, null, occAy)).body;
    assert("withdrawn by OCC/BK, it isn't escalated again for the same booking", v?.escalation?.status === "withdrawn", JSON.stringify(v?.escalation?.status));

    const F = await newShipment({ pol: "USNYC", pod: "NLRTM", vessel: "CMA CGM WESTBOUND", voyage: "0AN2E" });
    await send(F);
    await sleep(1200);
    await request("POST", "/api/escalations/no-answer-sweep", {}, token);
    v = (await request("GET", `/api/shipments/${F}/escalation`, null, occAy)).body;
    assert("an unsteered lane: escalated straight away", v?.escalation?.trigger === "no_answer" && v.escalation.automatic === true, JSON.stringify(v?.escalation).slice(0, 200));
    v = (await request("GET", `/api/shipments/${F}`, null, token)).body;
    assert("…and left with CMDU", v.carrierCode === "CMDU", v.carrierCode);
  } catch (e) {
    console.error("Unexpected error:", e);
    failed++;
  } finally {
    if (saved) await request("PUT", "/api/settings", { booking_no_answer_hours: saved.booking_no_answer_hours ?? "2", booking_change_rules: saved.booking_change_rules }, token).catch(() => {});
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
