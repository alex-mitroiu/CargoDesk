/**
 * What the House B/L says, and what happens to its originals (Epic TKT-C7EBU3; plan
 * https://claude.ai/artifact/FF9eMZXXMLHdJkCk5abaoU, medium and low gaps, 2026-10-22; lib/house-bl.js).
 * Every DCSA TransportDocument here is checked against the vendored eBL 3.0 spec (payloadErrors empty):
 *   - G11 to order: "to order of" the consignee (DCSA isToOrder + consignee) or "to order" of the shipper
 *     (no consignee); never on a Sea Waybill; who presented the originals is recorded;
 *   - G12 originals and copies, chosen with the draft; G14 with the charges (DCSA charges from the selling
 *     lines) or "freight as arranged" (without);
 *   - G16 every sea leg (first sea-going and mother vessel) and the on-carriage;
 *   - G17 a reefer's set temperature (activeReeferSettings) and dangerous goods (UN number, proper
 *     shipping name, class), which readiness asks for;
 *   - G18 the originals handover log; a surrender at origin sends the import office a telex release notice.
 *
 * Usage:
 *   node tests/house-bl-content.test.js
 *
 * Prerequisites:
 *   - Express server on :3001 and the pdf-render service on :3003
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, ESALG, USNYC present in port_locations (seeded MDM data)
 */

import { readyHouseBlShipment, generateHouseBl } from "./helpers/house-bl.mjs";
import { retireOffice, retireBranch } from "./helpers/offices.mjs";

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
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();

(async () => {
  const cleanup = { shipments: [], customers: [], office: null, branch: null };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;

    // A complete issuing entity, so each DCSA document can be checked whole against the spec.
    const branch = (await request("POST", "/api/branches", { code: `HBC${rand}`, name: `CargoDesk Logistics Rotterdam ${rand} BV`, countryCode: "NL",
      city: "Rotterdam", address: "Wilhelminakade 909", locode: "NLRTM", taxRegistrationNumber: "NL004495445B01", currency: "EUR",
      email: "docs.rotterdam@cargodesk.example", phone: "+31 10 555 0199", scac: "CDLR" }, token)).body;
    cleanup.branch = branch.id;
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    const office = (await request("POST", "/api/offices", { unlocode: `NL${letters}`, countryCode: "NL", department: "SE", name: `Rotterdam Export B/L ${rand}`, branchId: branch.id }, token)).body;
    if (!office?.id) throw new Error(`scratch office not created: ${JSON.stringify(office)}`);
    cleanup.office = office.id;

    const ready = async (tag, opts = {}) => {
      const r = await readyHouseBlShipment(request, token, { tag, emoOfficeId: office.id, ...opts });
      cleanup.shipments.push(r.shipment.id); cleanup.customers.push(r.shipper.id, r.consignee.id);
      return r;
    };
    const house = async id => (await request("GET", `/api/shipments/${id}/house-bl`, null, token)).body;
    const issue = async (id, houseBl) => {
      const draft = await generateHouseBl(request, token, id, { houseBl: { shippedOnBoard: true, ...houseBl } });
      if (draft.status !== 201) return { draft, confirmed: null };
      return { draft, confirmed: await request("PATCH", `/api/shipments/${id}/documents/${draft.body.id}`, { status: "confirmed" }, token) };
    };
    const dcsa = async id => { const h = await house(id); return (await request("GET", `/api/shipments/${id}/house-bl/${h.live.id}/dcsa`, null, token)).body; };
    const fullContainer = c => ({ containerNumber: c.containerNumber, sealNumber: c.sealNumber, size: c.size, type: c.type, hsCode: c.hsCode,
      cargoDescription: c.cargoDescription, marksAndNumbers: c.marksAndNumbers, grossWeightKg: c.grossWeightKg, volumeCbm: c.volumeCbm,
      numberOfPackages: c.numberOfPackages, packageCode: c.packageCode });

    console.log("\nG11 — to order");
    const badMode = await request("PUT", `/api/shipments/${(await ready("OX")).shipment.id}`, { blToOrder: "BANK" }, token);
    assert("an unknown to-order mode is refused (400)", badMode.status === 400 && /blToOrder/.test(badMode.body?.error), JSON.stringify(badMode.body));
    const c = await ready("OC");
    const setC = await request("PUT", `/api/shipments/${c.shipment.id}`, { blToOrder: "consignee" }, token);
    assert("to order of the consignee is set", setC.status === 200 && setC.body.blToOrder === "CONSIGNEE", JSON.stringify(setC.body.blToOrder));
    const cIssued = await issue(c.shipment.id);
    assert("…and the House B/L issues", cIssued.confirmed?.status === 200, JSON.stringify(cIssued.confirmed?.body || cIssued.draft.body));
    let doc = await dcsa(c.shipment.id);
    assert("DCSA: isToOrder, the consignee named, valid", doc.document.isToOrder === true && doc.document.documentParties.consignee?.partyName === c.consignee.companyName
      && doc.errors === "", JSON.stringify({ toOrder: doc.document.isToOrder, consignee: doc.document.documentParties.consignee?.partyName, errors: doc.errors }));
    assert("…the record keeps the mode", (await house(c.shipment.id)).live.toOrderMode === "CONSIGNEE", "");
    const sh = await ready("OS");
    await request("PUT", `/api/shipments/${sh.shipment.id}`, { blToOrder: "SHIPPER" }, token);
    await issue(sh.shipment.id);
    doc = await dcsa(sh.shipment.id);
    assert("\"to order\" (of the shipper): isToOrder and no consignee on the document, valid", doc.document.isToOrder === true && !doc.document.documentParties.consignee
      && doc.errors === "", JSON.stringify({ toOrder: doc.document.isToOrder, consignee: doc.document.documentParties.consignee, errors: doc.errors }));
    const w = await ready("OW", { releaseType: "Seaway Bill" });
    await request("PUT", `/api/shipments/${w.shipment.id}`, { blToOrder: "CONSIGNEE" }, token);
    const wh = await house(w.shipment.id);
    assert("a Sea Waybill to order is blocked", wh.readiness.missing.some(m => /Sea Waybill can't be issued to order/.test(m)), JSON.stringify(wh.readiness.missing));

    console.log("\nG12 + G14 — originals, copies, charges");
    const o = await ready("OO");
    const none = await generateHouseBl(request, token, o.shipment.id, { houseBl: { shippedOnBoard: true, originals: 0 } });
    assert("a B/L with no originals is refused (400)", none.status === 400 && /1 to 9 originals/.test(none.body?.error), JSON.stringify(none.body));
    const sw = await generateHouseBl(request, token, w.shipment.id, { houseBl: { shippedOnBoard: true, originals: 2 } });
    assert("originals on a Sea Waybill are refused (400)", sw.status === 400 && /Sea Waybill has no originals/.test(sw.body?.error), JSON.stringify(sw.body));
    const ofr = await request("POST", `/api/shipments/${o.shipment.id}/cost-lines`, { type: "SELL", chargeCode: "OFR", currency: "USD", amount: 2450, paymentIndicator: "Prepaid" }, token);
    const thc = await request("POST", `/api/shipments/${o.shipment.id}/cost-lines`, { type: "SELL", chargeCode: "DTHC", currency: "USD", amount: 395, paymentIndicator: "Collect" }, token);
    assert("(setup) two selling charges", ofr.status === 201 && thc.status === 201, JSON.stringify([ofr.body, thc.body]).slice(0, 300));
    const oIssued = await issue(o.shipment.id, { originals: 3, copies: 2, withCharges: true });
    assert("3 originals and 2 copies with charges issue", oIssued.confirmed?.status === 200, JSON.stringify(oIssued.confirmed?.body || oIssued.draft.body));
    let live = (await house(o.shipment.id)).live;
    assert("…the record says so", live.originals === 3 && live.copies === 2 && live.withCharges === true, JSON.stringify(live));
    doc = await dcsa(o.shipment.id);
    assert("DCSA: 3 originals and 2 copies with charges", doc.document.numberOfOriginalsWithCharges === 3 && doc.document.numberOfOriginalsWithoutCharges === 0
      && doc.document.numberOfCopiesWithCharges === 2, JSON.stringify(doc.document));
    const charges = doc.document.charges || [];
    assert("…the charges: OFR prepaid, DTHC collect, valid", charges.length === 2 && charges.some(x => x.currencyAmount === 2450 && x.paymentTermCode === "PRE")
      && charges.some(x => x.currencyAmount === 395 && x.paymentTermCode === "COL") && doc.errors === "", JSON.stringify({ charges, errors: doc.errors }));
    const p = await ready("OP");
    await request("POST", `/api/shipments/${p.shipment.id}/cost-lines`, { type: "SELL", chargeCode: "OFR", currency: "USD", amount: 2450, paymentIndicator: "Prepaid" }, token);
    await issue(p.shipment.id, { originals: 2 });
    doc = await dcsa(p.shipment.id);
    assert("without charges (freight as arranged): no charges on the document", doc.document.numberOfOriginalsWithoutCharges === 2 && !doc.document.charges
      && doc.document.numberOfCopiesWithoutCharges === 0 && doc.errors === "", JSON.stringify({ o: doc.document.numberOfOriginalsWithoutCharges, ch: doc.document.charges, errors: doc.errors }));

    console.log("\nG16 — transshipment and on-carriage");
    const t = await ready("OT");
    for (const leg of (await request("GET", `/api/shipments/${t.shipment.id}/legs`, null, token)).body || [])
      await request("DELETE", `/api/shipments/${t.shipment.id}/legs/${leg.id}`, null, token);
    const legs = [
      { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "ESALG", etd: inDays(3), eta: inDays(6), carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", voyage: "443W" },
      { legType: "SEA", movementType: "SEA", pol: "ESALG", pod: "USNYC", etd: inDays(7), eta: inDays(17), carrierCode: "MAEU", vessel: "MAERSK EDMONTON", voyage: "445W" },
      { legType: "Delivery", movementType: "Carrier's Haulage", movementBy: "Truck", pol: "USNYC", pod: "USNYC", polLocType: "Terminal", podLocType: "Terminal",
        etd: inDays(18), eta: inDays(19), carrierCode: "MAEU" },
    ];
    for (const leg of legs) {
      const r = await request("POST", `/api/shipments/${t.shipment.id}/legs`, leg, token);
      if (r.status !== 201) console.log("    leg:", r.status, JSON.stringify(r.body));
    }
    const th = await house(t.shipment.id);
    assert("the summary: two vessels, transshipment at ESALG, on-carriage by truck", th.routing.vessels.length === 2 && th.routing.transshipmentPorts.join() === "ESALG"
      && th.routing.onCarriageBy === "TRUCK", JSON.stringify(th.routing));
    const tIssued = await issue(t.shipment.id);
    assert("(issued)", tIssued.confirmed?.status === 200, JSON.stringify(tIssued.confirmed?.body || th.readiness.missing));
    doc = await dcsa(t.shipment.id);
    const vv = doc.document.transports.vesselVoyages;
    assert("DCSA: first sea-going feeder, then the mother vessel, on-carriage by truck, valid",
      vv.length === 2 && vv[0].vesselName === "MAERSK KENSINGTON" && vv[0].role === "FIRST_SEA_GOING" && vv[1].vesselName === "MAERSK EDMONTON" && vv[1].role === "MOTHER"
      && doc.document.transports.onCarriageBy === "TRUCK" && doc.errors === "", JSON.stringify({ vv, on: doc.document.transports.onCarriageBy, errors: doc.errors }));

    console.log("\nG17 — reefer and dangerous goods");
    const r = await ready("OR");
    const reefer = await request("PUT", `/api/shipments/${r.shipment.id}/containers/${r.container.id}`,
      { ...fullContainer(r.container), size: "40", type: "RH", cargoDescription: "Frozen cod fillets", hsCode: "030471", setTemperatureC: -18 }, token);
    assert("(setup) a 40' reefer at -18 °C", reefer.status === 200, JSON.stringify(reefer.body));
    await issue(r.shipment.id);
    doc = await dcsa(r.shipment.id);
    const ute = doc.document.utilizedTransportEquipments[0];
    assert("DCSA: an operating reefer set at -18 °C, valid", ute.isNonOperatingReefer === false && ute.activeReeferSettings?.temperatureSetpoint === -18
      && ute.activeReeferSettings.temperatureUnit === "CEL" && doc.errors === "", JSON.stringify({ ute, errors: doc.errors }));
    const g = await ready("OG");
    const dgNoUn = await request("PUT", `/api/shipments/${g.shipment.id}/containers/${g.container.id}`,
      { ...fullContainer(g.container), cargoDescription: "Paint, water-based, in tins", hsCode: "320910", isDg: true, dgClass: "3" }, token);
    assert("(setup) a class 3 container", dgNoUn.status === 200, JSON.stringify(dgNoUn.body));
    let gh = await house(g.shipment.id);
    assert("readiness asks for the UN number and the proper shipping name", gh.readiness.missing.some(m => /UN number \(dangerous goods\), proper shipping name/.test(m)),
      JSON.stringify(gh.readiness.missing));
    const badUn = await request("PUT", `/api/shipments/${g.shipment.id}/containers/${g.container.id}`,
      { ...fullContainer(g.container), isDg: true, dgClass: "3", dgUnNumber: "12A" }, token);
    assert("a UN number that isn't 4 digits is refused (400)", badUn.status === 400 && /4-digit UN number/.test(badUn.body?.error), JSON.stringify(badUn.body));
    const dg = await request("PUT", `/api/shipments/${g.shipment.id}/containers/${g.container.id}`,
      { ...fullContainer(g.container), cargoDescription: "Paint, water-based, in tins", hsCode: "320910", isDg: true, dgClass: "3", dgUnNumber: "UN 1263", dgProperShippingName: "PAINT" }, token);
    assert("UN 1263 PAINT is saved as 1263", dg.status === 200 && dg.body.dgUnNumber === "1263" && dg.body.dgProperShippingName === "PAINT", JSON.stringify(dg.body));
    gh = await house(g.shipment.id);
    assert("…and the House B/L is ready", gh.readiness.ready, JSON.stringify(gh.readiness.missing));
    await issue(g.shipment.id);
    doc = await dcsa(g.shipment.id);
    const dgs = doc.document.consignmentItems[0].cargoItems[0].outerPackaging.dangerousGoods;
    assert("DCSA: UN 1263, PAINT, class 3, valid", dgs?.[0]?.UNNumber === "1263" && dgs[0].properShippingName === "PAINT" && dgs[0].imoClass === "3" && doc.errors === "",
      JSON.stringify({ dgs, errors: doc.errors }));

    console.log("\nG18 — originals log and telex release notice");
    const ho = await ready("OH");
    const hIssued = await issue(ho.shipment.id);
    const handover = body => request("POST", `/api/shipments/${ho.shipment.id}/house-bl/originals-handover`, body, token);
    assert("a handover needs who received them (400)", (await handover({ method: "Courier", trackingRef: "1Z999" })).status === 400, "");
    const noTrack = await handover({ to: ho.shipper.companyName, method: "Courier" });
    assert("a courier handover needs its tracking number (400)", noTrack.status === 400 && /tracking/.test(noTrack.body?.error), JSON.stringify(noTrack.body));
    const tooMany = await handover({ to: ho.shipper.companyName, method: "In person", count: 4 });
    assert("more originals than were issued is refused (400)", tooMany.status === 400 && /1 to 3/.test(tooMany.body?.error), JSON.stringify(tooMany.body));
    const handed = await handover({ to: ho.shipper.companyName, method: "Courier", trackingRef: "DHL 4471 9920 31", count: 3 });
    assert("3 originals couriered to the shipper are logged", handed.status === 201 && handed.body.handover.count === 3 && handed.body.handover.trackingRef === "DHL 4471 9920 31",
      JSON.stringify(handed.body));
    let hh = await house(ho.shipment.id);
    let evs = (await request("GET", `/api/shipments/${ho.shipment.id}/house-bl/${hh.live.id}/events`, null, token)).body;
    assert("…in the House B/L's history", evs.some(e => e.eventType === "ORIGINALS_HANDED_OVER" && e.detail.to === ho.shipper.companyName && e.detail.method === "Courier"),
      JSON.stringify(evs.map(e => e.eventType)));
    await request("PATCH", `/api/shipments/${ho.shipment.id}/documents/${hIssued.draft.body.id}/bl-surrender`, { presentedBy: "Atlantic Trade Bank NA" }, token);
    evs = (await request("GET", `/api/shipments/${ho.shipment.id}/house-bl/${hh.live.id}/events`, null, token)).body;
    assert("presented at destination: who presented them is recorded", evs.some(e => e.eventType === "SURRENDERED_FOR_DELIVERY" && e.detail.presentedBy === "Atlantic Trade Bank NA"),
      JSON.stringify(evs.filter(e => e.eventType === "SURRENDERED_FOR_DELIVERY")));
    const late = await handover({ to: "anyone", method: "In person" });
    assert("…after which no handover can be logged (409)", late.status === 409, JSON.stringify(late.body));
    const swbHand = await request("POST", `/api/shipments/${w.shipment.id}/house-bl/originals-handover`, { to: "x", method: "In person" }, token);
    assert("a shipment with no issued House B/L has nothing to hand over (409)", swbHand.status === 409, JSON.stringify(swbHand.body));

    const tx = await ready("OL", { releaseType: "Telex Release" });
    const txIssued = await issue(tx.shipment.id);
    await request("PATCH", `/api/shipments/${tx.shipment.id}/documents/${txIssued.draft.body.id}/bl-surrender`, {}, token);
    const txh = await house(tx.shipment.id);
    const notice = (await request("GET", `/api/tickets?shipmentId=${tx.shipment.id}`, null, token)).body.find(x => x.sourceType === "telex_release_notice");
    assert("surrendered at origin: the import office gets a telex release task", !!notice && notice.status === "Ready" && notice.priority === "High"
      && notice.title.includes(`House B/L ${txh.live.reference} surrendered at origin`), JSON.stringify(notice));
    assert("…linked from the record", txh.live.telexNoticeTicketId === notice?.id, txh.live.telexNoticeTicketId);
    evs = (await request("GET", `/api/shipments/${tx.shipment.id}/house-bl/${txh.live.id}/events`, null, token)).body;
    assert("…and in its history", evs.some(e => e.eventType === "TELEX_RELEASE_NOTICE" && e.detail.sent === true), JSON.stringify(evs.map(e => e.eventType)));
    const txAgain = await request("PATCH", `/api/shipments/${tx.shipment.id}/documents/${txIssued.draft.body.id}/bl-surrender`, {}, token);
    const notices = (await request("GET", `/api/tickets?shipmentId=${tx.shipment.id}`, null, token)).body.filter(x => x.sourceType === "telex_release_notice");
    assert("…sent once, however often the surrender is recorded", txAgain.status === 200 && notices.length === 1, `${notices.length}`);
    if (notice) await request("DELETE", `/api/tickets/${notice.id}`, null, token);
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    console.log("\nCleanup");
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token);
    if (cleanup.office) console.log(`  office: ${await retireOffice(token, cleanup.office)}`);
    if (cleanup.branch) console.log(`  branch: ${await retireBranch(token, cleanup.branch)}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
