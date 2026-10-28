/**
 * The main vessel, and what the carrier changed (Epic TKT-O3YBNE; agreed 2026-10-21, approved mockup
 * https://claude.ai/artifact/P3xrSaDFwDHWeWiSEWVccv).
 *   - the main vessel is the sea leg with the longest transit (lib/mainLeg.js); every schedule search
 *     headlines a transshipment by it, demo transshipments run feeder → main (→ feeder), and a
 *     shipment's vessel/voyage follow its main sea leg;
 *   - the escalation offers transshipment sailings, and Book As Instructed rebuilds the shipment's sea
 *     legs from the instructed legs;
 *   - Requested (A) vs Carrier (B): the carrier's DCSA confirmation is kept with the booking and compared
 *     with the request, row by row (changed / from the carrier / not stated);
 *   - accept the carrier's version (sailing, legs, dates, cut-offs onto the shipment; Confirmed; a
 *     'changed' escalation resolves; History), or ask the carrier to amend (a DCSA amendment, the note
 *     kept in the History) and see it answered.
 *
 * Usage:
 *   node tests/main-vessel-carrier-changes.test.js
 *
 * Prerequisites:
 *   - npm run dev (Express :3001), not in production (the built-in DCSA carrier plays CMDU and MSCU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { createRequire } from "node:module";
import { ensureOffices } from "./helpers/offices.mjs";
import { carrierActs, waitForCarrierReference, addContainer } from "./helpers/dcsa-sim.mjs";

const require = createRequire(import.meta.url);
const { mainLegIndex, legDays } = require("../lib/mainLeg.js");

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
  const cleanup = { shipments: [], customers: [], users: [] };
  let token;
  try {
    console.log("The main-leg rule");
    const L = (etd, eta) => ({ etd, eta });
    assert("feeder 1 day, main 13 days → the main", mainLegIndex([L("2026-11-04", "2026-11-05"), L("2026-11-07", "2026-11-20")]) === 1);
    assert("feeder, main, feeder → the middle one", mainLegIndex([L("2026-11-19", "2026-11-20"), L("2026-11-22", "2026-12-05"), L("2026-12-06", "2026-12-08")]) === 1);
    assert("a tie → the earlier leg", mainLegIndex([L("2026-11-01", "2026-11-06"), L("2026-11-07", "2026-11-12")]) === 0);
    assert("no dates → the first leg; no legs → -1", mainLegIndex([{}, {}]) === 0 && mainLegIndex([]) === -1);
    assert("days between ETD and ETA", legDays(L("2026-11-07", "2026-11-20")) === 13 && legDays({ etd: "2026-11-07" }) === 0);

    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;

    console.log("\nDemo schedules: feeder → main (→ feeder), headlined by the main vessel");
    const sail = list((await request("GET", "/api/schedules/search?pol=NLRTM&pod=USNYC&carrierCode=HLCU&weeks=6", null, token)).body?.sailings);
    const ts = sail.filter(s => s.legs?.length > 1);
    assert("some sailings transship, one of them over three legs", ts.length >= 2 && ts.some(s => s.legs.length === 3), JSON.stringify(ts.map(s => s.legs.length)));
    assert("each is headlined by its main leg (the longest transit)", ts.every(s => s.mainLegIndex === mainLegIndex(s.legs) && s.vesselName === s.legs[s.mainLegIndex].vesselName
      && s.voyageNumber === s.legs[s.mainLegIndex].voyageNumber), JSON.stringify(ts.map(s => [s.vesselName, s.mainLegIndex])));
    assert("feeders take a day or two, the main the rest", ts.every(s => s.legs.every((l, i) => i === s.mainLegIndex ? legDays(l) >= 7 : legDays(l) <= 2)),
      JSON.stringify(ts.map(s => s.legs.map(legDays))));
    assert("legs join up from POL to POD through hubs that are neither", ts.every(s => s.legs[0].pol === "NLRTM" && s.legs.at(-1).pod === "USNYC"
      && s.legs.slice(1).every((l, i) => l.pol === s.legs[i].pod) && s.legs.slice(0, -1).every(l => !["NLRTM", "USNYC"].includes(l.pod))));
    assert("a direct sailing says so (mainLegIndex null)", sail.filter(s => !s.legs).every(s => s.mainLegIndex === null));
    // 2026-10-21: a signed shift on the unsigned hash gave some departures an undefined hub and a 0-day
    // feeder ("via BEANR, , feeders …"). Every leg of every demo transshipment names both ports.
    let broken = [];
    for (const [pol, pod, carrier] of [["NLRTM", "USNYC", "CMDU"], ["NLRTM", "USNYC", "HLCU"], ["CNSHA", "DEHAM", "MAEU"], ["SGSIN", "USLAX", "MSCU"]]) {
      const rows = list((await request("GET", `/api/schedules/search?pol=${pol}&pod=${pod}&carrierCode=${carrier}&weeks=12&onlyCarrier=1`, null, token)).body?.sailings);
      broken = broken.concat(rows.filter(s => s.legs?.some(l => !l.pol || !l.pod || legDays(l) < 1)).map(s => `${carrier} ${s.etd}`));
    }
    assert("every demo leg names its ports and takes at least a day (12 weeks, 4 lanes)", broken.length === 0, broken.join(", "));

    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const shipper = (await request("POST", "/api/customers", { companyName: `Main Vessel Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Main Vessel Consignee ${rand} Inc` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id);
    const newShipment = async (legs = [{ pol: "NLRTM", pod: "USNYC", etd: "2026-11-16", eta: "2026-11-30", vessel: "CMA CGM REQUESTED", voyage: "0MV1W" }]) => {
      const s = (await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU", status: "Active", contractType: "SPOT", contractRef: `SPOT-MV-${rand}`,
        etd: legs[0].etd, eta: legs.at(-1).eta, incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId,
      }, token)).body;
      cleanup.shipments.push(s.id);
      await addContainer(request, token, s.id);
      for (const l of legs) await request("POST", `/api/shipments/${s.id}/legs`, { legType: "SEA", movementType: "SEA", carrierCode: "CMDU", vesselImo: "9999995", ...l }, token);
      return s.id;
    };
    const send = async id => { await request("POST", `/api/shipments/${id}/edi-messages/booking-request`, {}, token); return waitForCarrierReference(request, token, id); };
    const shipment = async id => (await request("GET", `/api/shipments/${id}`, null, token)).body;
    const seaLegs = async id => list((await request("GET", `/api/shipments/${id}/legs`, null, token)).body).filter(l => l.legType === "SEA");

    console.log("\nA shipment's vessel is its main sea leg's");
    const A = await newShipment([
      { pol: "NLRTM", pod: "BEANR", etd: "2026-11-14", eta: "2026-11-16", vessel: "FEEDER ONE", voyage: "F1N" },
      { pol: "BEANR", pod: "USNYC", etd: "2026-11-18", eta: "2026-11-27", vessel: "MAIN LINER", voyage: "M7W" },
    ]);
    let s = await shipment(A);
    assert("vessel/voyage: the 9-day main leg, not the 2-day feeder", s.vessel === "MAIN LINER" && s.voyage === "M7W", `${s.vessel} ${s.voyage}`);
    assert("ETD the first sea leg's, ETA the last's", String(s.etd).startsWith("2026-11-14") && String(s.eta).startsWith("2026-11-27"), `${s.etd} ${s.eta}`);
    assert("the transshipment's legs and roles come with the shipment", s.transshipment?.mainIndex === 1
      && s.transshipment.legs.map(l => `${l.role}:${l.vessel}`).join(",") === "FEEDER:FEEDER ONE,MAIN:MAIN LINER", JSON.stringify(s.transshipment));
    const row = list((await request("GET", `/api/shipments?limit=50&offset=0&search=${A}`, null, token)).body).find(x => x.id === A);
    assert("…in the Shipments list too", row?.transshipment?.legs?.length === 2 && row.vessel === "MAIN LINER", JSON.stringify(row?.transshipment));

    console.log("\nAn escalation books a transshipment sailing as instructed");
    const B = await newShipment();
    await send(B);
    await carrierActs(request, token, B, "reject", "No space");
    const esc = (await request("POST", `/api/shipments/${B}/escalations`, { toRole: "occ_ay" }, token)).body.escalation;
    const mscu = list((await request("GET", "/api/schedules/search?pol=NLRTM&pod=USNYC&carrierCode=MSCU&weeks=6&onlyCarrier=1", null, token)).body?.sailings);
    const tsSailing = mscu.find(x => x.legs?.length === 2);
    let r = await request("POST", `/api/escalations/${esc.id}/actions`, { action: "instruct", message: "Via the hub",
      instruction: { carrierCode: "MSCU", contractNumber: "MSCU-SC-2026-0118", source: "contracts", sailing: { vesselName: tsSailing.vesselName, voyageNumber: tsSailing.voyageNumber, etd: tsSailing.etd, eta: tsSailing.eta,
        pol: "NLRTM", pod: "USNYC", legs: tsSailing.legs } } }, token);
    assert("instructions carry the legs", r.status === 200 && r.body.escalation.instruction?.sailing?.legs?.length === 2, JSON.stringify(r.body).slice(0, 300));
    r = await request("POST", `/api/escalations/${esc.id}/book`, {}, token);
    assert("booked as instructed (200)", r.status === 200, JSON.stringify(r.body).slice(0, 200));
    let legsB = await seaLegs(B);
    s = await shipment(B);
    assert("the shipment's sea legs are the sailing's two, in order", legsB.length === 2 && legsB[0].pol === "NLRTM" && legsB[0].pod === tsSailing.legs[0].pod
      && legsB[1].pod === "USNYC" && legsB.every(l => l.carrierCode === "MSCU"), JSON.stringify(legsB.map(l => [l.pol, l.pod, l.vessel])));
    assert("…and its vessel is the main one", s.vessel === tsSailing.vesselName && s.carrierCode === "MSCU", `${s.vessel} vs ${tsSailing.vesselName}`);
    await carrierActs(request, token, B, "confirm");
    await sleep(300);
    const vB = (await request("GET", `/api/shipments/${B}/escalation`, null, token)).body;
    assert("MSCU confirms the main vessel as requested: resolved", vB.escalation.status === "resolved", vB.escalation.status);

    console.log("\nRequested (A) vs Carrier (B)");
    const C = await newShipment();
    await send(C);
    await carrierActs(request, token, C, "confirmWithChanges", "Rolled to next week");
    const cmp = (await request("GET", `/api/shipments/${C}/carrier-booking/comparison`, null, token)).body;
    const rowOf = label => cmp?.rows?.find(x => x.label === label);
    assert("the confirmation is kept and compared", cmp?.available && cmp.withChanges && !cmp.accepted && cmp.feedback.includes("Rolled to next week"), JSON.stringify(cmp).slice(0, 300));
    assert("vessel and voyage: changed", rowOf("Vessel")?.kind === "changed" && rowOf("Vessel").a === "CMA CGM REQUESTED" && rowOf("Vessel").b === "DEMO SUBSTITUTE"
      && rowOf("Voyage")?.kind === "changed", JSON.stringify([rowOf("Vessel"), rowOf("Voyage")]));
    assert("ETD and ETA: changed, +7 days", rowOf("ETD")?.kind === "changed" && rowOf("ETD").delta === "+7 days" && rowOf("ETA")?.delta === "+7 days", JSON.stringify([rowOf("ETD"), rowOf("ETA")]));
    assert("ports and equipment: the same", rowOf("Port of loading")?.kind === "same" && rowOf("Port of discharge")?.kind === "same" && rowOf("Equipment")?.kind === "same",
      JSON.stringify([rowOf("Port of loading"), rowOf("Equipment")]));
    assert("the booking number and cut-offs come from the carrier", rowOf("Booking number")?.kind === "new" && rowOf("VGM cut-off")?.kind === "new"
      && rowOf("Documentation cut-off")?.kind === "new" && rowOf("FCL delivery cut-off")?.kind === "new");
    assert("what DCSA doesn't carry is 'Not stated', not changed", rowOf("Gross weight")?.kind === "missing" && rowOf("Gross weight").b === "Not stated");
    assert("four changes counted", cmp.changeCount === 4, String(cmp.changeCount));

    console.log("\nAccept the carrier's version");
    const occAyEmail = `mv-occay-${rand.toLowerCase()}@example.com`;
    await request("POST", "/api/users", { email: occAyEmail, name: `occay ${rand}`, roles: ["occ_ay"], password: "MvFixture!2026Zq" }, token);
    cleanup.users.push(occAyEmail);
    const occAyId = list((await request("GET", "/api/users", null, token)).body).find(u => u.email === occAyEmail)?.id;
    await request("POST", `/api/users/${occAyId}/offices`, { officeId: emoOfficeId }, token);
    const occAy = (await request("POST", "/api/auth/login", { email: occAyEmail, password: "MvFixture!2026Zq" })).body.token;
    assert("OCC/AY can't accept it (403)", (await request("POST", `/api/shipments/${C}/carrier-booking/accept-changes`, {}, occAy)).status === 403);
    r = await request("POST", `/api/shipments/${C}/carrier-booking/accept-changes`, {}, token);
    assert("accepted (200)", r.status === 200 && r.body.booking?.status === "Confirmed", JSON.stringify(r.body).slice(0, 200));
    s = await shipment(C);
    const legsC = await seaLegs(C);
    assert("the shipment carries column B: vessel, voyage, dates", s.vessel === "DEMO SUBSTITUTE" && s.voyage === "DM777W"
      && String(s.etd).startsWith("2026-11-23") && String(s.eta).startsWith("2026-12-07") && legsC.length === 1 && legsC[0].vessel === "DEMO SUBSTITUTE",
      JSON.stringify({ v: s.vessel, voy: s.voyage, etd: s.etd, eta: s.eta, legs: legsC.length }));
    const ctrs = list((await request("GET", `/api/containers?shipmentId=${C}`, null, token)).body).filter(c => c.shipmentId === C);
    assert("VGM and FCL delivery cut-offs on each container", ctrs.length > 0 && ctrs.every(c => c.vgmCutoff === "2026-11-21T12:00" && c.cyCutoff === "2026-11-22T12:00"),
      JSON.stringify(ctrs.map(c => [c.vgmCutoff, c.cyCutoff])));
    const si = (await request("GET", `/api/shipments/${C}/shipping-instructions`, null, token)).body;
    assert("the documentation cut-off on the Shipping Instructions", si?.siCutoff === "2026-11-20T12:00", JSON.stringify(si));
    const stC = list((await request("GET", `/api/shipments?limit=50&offset=0&search=${C}`, null, token)).body).find(x => x.id === C)?.bookingState;
    assert("the Booking column says Confirmed", stC?.label === "Confirmed", JSON.stringify(stC));
    const cmp2 = (await request("GET", `/api/shipments/${C}/carrier-booking/comparison`, null, token)).body;
    assert("the table says who accepted it", !!cmp2.accepted?.at && cmp2.accepted.by !== undefined && !cmp2.withChanges, JSON.stringify(cmp2.accepted));
    const hist = list((await request("GET", `/api/shipments/${C}/events`, null, token)).body);
    assert("the History records the acceptance", hist.some(h => (h.eventType || h.event_type) === "CARRIER_CHANGES_ACCEPTED"));
    assert("accepting twice is refused (409)", (await request("POST", `/api/shipments/${C}/carrier-booking/accept-changes`, {}, token)).status === 409);

    const D = await newShipment();
    await send(D);
    await carrierActs(request, token, D, "confirmWithChanges");
    const escD = (await request("POST", `/api/shipments/${D}/escalations`, { toRole: "occ_ay", reasonCode: "later_sailing" }, token)).body.escalation;
    assert("an escalation over the changes", escD?.trigger === "changed", JSON.stringify(escD).slice(0, 200));
    await request("POST", `/api/shipments/${D}/carrier-booking/accept-changes`, {}, token);
    const vD = (await request("GET", `/api/shipments/${D}/escalation`, null, token)).body;
    assert("accepting resolves it", vD.escalation.status === "resolved" && vD.steps.at(-1)?.action === "accepted_changes", JSON.stringify({ s: vD.escalation.status, a: vD.steps.at(-1)?.action }));

    console.log("\nAsk the carrier to amend");
    const E = await newShipment();
    await send(E);
    await carrierActs(request, token, E, "confirmWithChanges");
    r = await request("POST", `/api/shipments/${E}/carrier-booking/send-update`, { note: "Please keep 0MV1W, ETD 16 Nov" }, token);
    assert("the amendment goes to CMDU (200)", r.status === 200 && r.body.booking?.lastResponseStatus === "amendment_requested", JSON.stringify(r.body).slice(0, 200));
    const histE = list((await request("GET", `/api/shipments/${E}/events`, null, token)).body);
    const amendEvent = histE.find(h => (h.eventType || h.event_type) === "CARRIER_AMENDMENT_REQUESTED");
    assert("the note is kept in the History", !!amendEvent && /keep 0MV1W/.test(JSON.stringify(amendEvent)), JSON.stringify(amendEvent).slice(0, 200));
    await carrierActs(request, token, E, "confirmAmendment");
    await sleep(300);
    const cmpE = (await request("GET", `/api/shipments/${E}/carrier-booking/comparison`, null, token)).body;
    const stE = list((await request("GET", `/api/shipments?limit=50&offset=0&search=${E}`, null, token)).body).find(x => x.id === E)?.bookingState;
    assert("CMDU confirms the amendment as asked: no changes left, Confirmed", cmpE.changeCount === 0 && !cmpE.withChanges && stE?.label === "Confirmed",
      JSON.stringify({ n: cmpE.changeCount, st: stE }));
  } catch (e) {
    console.error("Unexpected error:", e);
    failed++;
  } finally {
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
    const users = list((await request("GET", "/api/users", null, token).catch(() => ({ body: [] }))).body);
    for (const email of cleanup.users) { const u = users.find(x => x.email === email); if (u) await request("DELETE", `/api/users/${u.id}`, null, token).catch(() => {}); }
  }
  console.log(`\n${"─".repeat(50)}\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
