/**
 * Book As Instructed (Epic TKT-ASIYFL, Story 4 TKT-ENOCCX; agreed 2026-10-20).
 *   - OCC/BK books the instructions: the shipment and its sea leg take the instructed carrier and
 *     sailing, and the DCSA booking request goes to that carrier;
 *   - another carrier: the rejected booking is superseded (archived) and a new one is sent;
 *   - the same carrier, unanswered: the open request is withdrawn there first, then sent again;
 *   - the escalation waits with OCC/BK: it closes when the instructed carrier confirms, and goes back
 *     to whoever gave the instructions when that carrier rejects;
 *   - nobody but OCC/BK books, and only once.
 *
 * Usage:
 *   node tests/booking-escalation-book.test.js
 *
 * Prerequisites:
 *   - npm run dev (Express :3001), not in production (the built-in DCSA carrier plays CMDU and MSCU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "./helpers/offices.mjs";
import { carrierActs, waitForCarrierReference, addContainer } from "./helpers/dcsa-sim.mjs";

const BASE = "http://localhost:3001";
let passed = 0, failed = 0;
async function request(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
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
  const cleanup = { shipments: [], customers: [], users: [], contracts: [] };
  let token, savedHours = null;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const shipper = (await request("POST", "/api/customers", { companyName: `Book Instructed Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Book Instructed Consignee ${rand} Inc` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id);
    const newShipment = async () => {
      const s = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU", status: "Active", contractType: "SPOT", contractRef: `SPOT-BAI-${rand}`,
        etd: "2026-11-16", eta: "2026-11-30", incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId,
      }, token);
      cleanup.shipments.push(s.body.id);
      await addContainer(request, token, s.body.id);
      await request("POST", `/api/shipments/${s.body.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
        etd: "2026-11-16", eta: "2026-11-30", carrierCode: "CMDU", vessel: "CMA CGM BOOK", vesselImo: "9999995", voyage: "0BK1W" }, token);
      return s.body.id;
    };
    const makeUser = async (key, roles, officeId) => {
      const email = `bai-${key}-${rand.toLowerCase()}@example.com`;
      await request("POST", "/api/users", { email, name: `${key} ${rand}`, roles, password: "BaiFixture!2026Zq" }, token);
      cleanup.users.push(email);
      const id = list((await request("GET", "/api/users", null, token)).body).find(u => u.email === email)?.id;
      await request("POST", `/api/users/${id}/offices`, { officeId }, token);
      return (await request("POST", "/api/auth/login", { email, password: "BaiFixture!2026Zq" })).body.token;
    };
    const occBk = await makeUser("occbk", ["occ_bk"], emoOfficeId);
    const occAy = await makeUser("occay", ["occ_ay"], emoOfficeId);
    const sailing = (vesselName, etd, eta) => ({ vesselName, voyageNumber: "DM002W", etd, eta, service: "DEMO SERVICE", transitDays: 14 });
    const escalateAndInstruct = async (id, instruction) => {
      const esc = (await request("POST", `/api/shipments/${id}/escalations`, { toRole: "occ_ay" }, occBk)).body.escalation;
      await request("POST", `/api/escalations/${esc.id}/actions`, { action: "instruct", instruction, message: "Space a week later" }, occAy);
      return esc.id;
    };

    console.log("Another carrier: the rejected booking is superseded");
    const A = await newShipment();
    await request("POST", `/api/shipments/${A}/edi-messages/booking-request`, {}, token);
    await carrierActs(request, token, A, "reject", "No space");
    const oldBooking = (await request("GET", `/api/shipments/${A}/carrier-booking`, null, token)).body;
    const escA = await escalateAndInstruct(A, { carrierCode: "MSCU", contractNumber: "MSCU-2026-ATL-001", rank: 2, source: "contracts",
      sailing: sailing("DEMO ALLEGRO", "2026-11-23", "2026-12-07") });
    assert("OCC/AY can't book (403)", (await request("POST", `/api/escalations/${escA}/book`, {}, occAy)).status === 403);
    const booked = await request("POST", `/api/escalations/${escA}/book`, {}, occBk);
    assert("OCC/BK books as instructed (200)", booked.status === 200 && booked.body.booked === true, JSON.stringify(booked.body).slice(0, 300));
    const s = (await request("GET", `/api/shipments/${A}`, null, token)).body;
    assert("the shipment carries the instructions: MSCU and the new dates", s.carrierCode === "MSCU" && String(s.etd).startsWith("2026-11-23") && String(s.eta).startsWith("2026-12-07"),
      JSON.stringify({ c: s.carrierCode, etd: s.etd, eta: s.eta }));
    assert("instructions naming no contract record leave the contract as it was", s.contractType === "SPOT" && s.contractRef === `SPOT-BAI-${rand}`,
      JSON.stringify({ t: s.contractType, ref: s.contractRef }));
    const sea = list((await request("GET", `/api/shipments/${A}/legs`, null, token)).body).find(l => l.legType === "SEA");
    assert("its sea leg too: vessel and dates", sea?.carrierCode === "MSCU" && sea.vessel === "DEMO ALLEGRO" && String(sea.etd).startsWith("2026-11-23"), JSON.stringify(sea));
    const nb = (await waitForCarrierReference(request, token, A));
    assert("a new booking went to MSCU through DCSA", nb?.carrierCode === "MSCU" && nb.status === "Pending" && /^SIM-/.test(nb.carrierBookingRequestReference || "") && nb.id !== oldBooking.id, JSON.stringify(nb).slice(0, 200));
    const history = list((await request("GET", `/api/shipments/${A}/carrier-booking-history`, null, token)).body);
    assert("the rejected CMDU booking is archived", history.some(h => h.id === oldBooking.id), JSON.stringify(history.map(h => h.id)));
    assert("booking again is refused (409)", (await request("POST", `/api/escalations/${escA}/book`, {}, occBk)).status === 409);
    let v = (await request("GET", `/api/shipments/${A}/escalation`, null, occBk)).body;
    assert("the escalation waits with OCC/BK, booked, nothing more to book", v.escalation.status === "instructed" && v.booked && !v.actions.includes("book"), JSON.stringify({ s: v.escalation.status, a: v.actions }));
    await carrierActs(request, token, A, "confirm");
    await sleep(400);
    v = (await request("GET", `/api/shipments/${A}/escalation`, null, occBk)).body;
    assert("MSCU confirms: the escalation is resolved", v.escalation.status === "resolved", v.escalation.status);
    assert("it still shows the sailing CMDU turned down, not the one on the shipment now",
      v.escalation.carrierCode === "CMDU" && v.escalation.sailing?.vessel === "CMA CGM BOOK" && v.escalation.sailing.voyage === "0BK1W"
        && v.escalation.sailing.etd === "2026-11-16" && v.escalation.sailing.contractRef === `SPOT-BAI-${rand}`, JSON.stringify(v.escalation.sailing));
    assert("the steps record the booking", v.steps.some(st => st.action === "booked") && v.steps.at(-1).action === "resolved", JSON.stringify(v.steps.map(st => st.action)));

    console.log("\nA Central contract in the instructions; then the instructed carrier rejects too");
    const contractNumber = `TC-BAI-MSCU-${Date.now()}`;
    const contract = (await request("POST", "/api/contracts", { contractNumber, carrierCode: "MSCU", status: "Active",
      validFrom: "2026-01-01", validTo: "2027-01-01", legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [{ serviceCode: "OF", amount: 1900, currency: "USD", unit: "per_container" }] }, token)).body;
    cleanup.contracts.push(contract.id);
    const B = await newShipment();
    await request("POST", `/api/shipments/${B}/edi-messages/booking-request`, {}, token);
    await carrierActs(request, token, B, "reject", "No space");
    const escB = await escalateAndInstruct(B, { carrierCode: "MSCU", contractId: contract.id, contractNumber, sailing: sailing("DEMO BRAVURA", "2026-11-28", "2026-12-12") });
    const bookedB = await request("POST", `/api/escalations/${escB}/book`, {}, occBk);
    assert("booked as instructed on the contract (200)", bookedB.status === 200, JSON.stringify(bookedB.body).slice(0, 200));
    const sb = (await request("GET", `/api/shipments/${B}`, null, token)).body;
    assert("instructions naming a contract make the shipment Central on it", sb.contractType === "Central" && sb.contractId === contract.id && sb.contractRef === contractNumber,
      JSON.stringify({ t: sb.contractType, id: sb.contractId, ref: sb.contractRef }));
    await carrierActs(request, token, B, "reject", "No space either");
    await sleep(400);
    v = (await request("GET", `/api/shipments/${B}/escalation`, null, occAy)).body;
    assert("MSCU rejects: it's back with OCC/AY, open, instructions cleared", v.escalation.status === "open" && v.escalation.holderRole === "occ_ay" && !v.escalation.instruction, JSON.stringify(v.escalation));
    assert("OCC/AY can instruct again", v.actions.includes("instruct"), JSON.stringify(v.actions));
    assert("…about MSCU's booking and the sailing MSCU turned down", v.escalation.carrierCode === "MSCU" && v.escalation.bookingId !== ""
        && v.escalation.sailing?.vessel === "DEMO BRAVURA" && v.escalation.sailing.etd === "2026-11-28" && v.escalation.sailing.contractRef === contractNumber,
      JSON.stringify({ c: v.escalation.carrierCode, s: v.escalation.sailing }));

    console.log("\nSame carrier, unanswered: withdrawn there first");
    savedHours = (await request("GET", "/api/settings", null, token)).body?.booking_no_answer_hours ?? "2";
    await request("PUT", "/api/settings", { booking_no_answer_hours: "0.0002" }, token);
    const C = await newShipment();
    await request("POST", `/api/shipments/${C}/edi-messages/booking-request`, {}, token);
    const before = await waitForCarrierReference(request, token, C);
    await sleep(1200);
    const escC = await escalateAndInstruct(C, { carrierCode: "CMDU", contractNumber: "", sailing: sailing("DEMO BRAVURA", "2026-11-30", "2026-12-18") });
    const bookedC = await request("POST", `/api/escalations/${escC}/book`, {}, occBk);
    assert("booked as instructed with the same carrier (200)", bookedC.status === 200, JSON.stringify(bookedC.body).slice(0, 200));
    const after = await waitForCarrierReference(request, token, C);
    assert("a new CMDU request went out, under a new reference", after?.status === "Pending" && after.carrierBookingRequestReference && after.carrierBookingRequestReference !== before.carrierBookingRequestReference,
      JSON.stringify({ before: before?.carrierBookingRequestReference, after: after?.carrierBookingRequestReference }));
    const sim = list((await request("GET", "/api/test-tools/dcsa-sim/bookings", null, token)).body);
    const oldAtCarrier = (await request("GET", `/dcsa-sim/v2/bookings/${before.carrierBookingRequestReference}`)).body;
    assert("the first request was withdrawn at CMDU (CANCELLED)", oldAtCarrier?.bookingStatus === "CANCELLED", JSON.stringify(oldAtCarrier?.bookingStatus));
    assert("…and only the new one is offered to play", sim.some(x => x.carrierBookingRequestReference === after.carrierBookingRequestReference) && !sim.some(x => x.carrierBookingRequestReference === before.carrierBookingRequestReference && x.shipmentId === C), "");
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    if (savedHours !== null) await request("PUT", "/api/settings", { booking_no_answer_hours: String(savedHours) }, token).catch(() => {});
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
    for (const id of cleanup.contracts) await request("DELETE", `/api/contracts/${id}`, null, token).catch(() => {});
    if (cleanup.users.length) {
      const all = list((await request("GET", "/api/users", null, token)).body);
      for (const email of cleanup.users) { const u = all.find(x => x.email === email); if (u) await request("DELETE", `/api/users/${u.id}`, null, token).catch(() => {}); }
    }
    console.log(`\n${"─".repeat(50)}\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
