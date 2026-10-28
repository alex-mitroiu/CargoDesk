/**
 * SPOT rates, phases 2–4 (plan https://claude.ai/artifact/Y61PAmXZfgFxTLtpt7GiAZ; decisions 2026-10-21).
 *   - phase 2: "Get offers" from the carrier — the demo carrier's spot desk answers with one all-in,
 *     short-lived offer per departure (validity and limits per carrier); taking one saves it (once);
 *     booking on it, the carrier confirms with the offer's charges and the A/B table compares them;
 *   - phase 3: an expired digital offer blocks Send Booking Request, an expired classic quote warns;
 *     cancelling a confirmed booking previews the fee (cancellation from the notice days, no-show inside
 *     them) and accrues it on the BUY side once the carrier confirms the cancellation;
 *   - phase 4: margin rules (admin / Trade Manager), the most specific one applies, a quote below its
 *     minimum is flagged when sent, never blocked.
 *
 * Usage:
 *   node tests/spot-offers-carrier.test.js
 *
 * Prerequisites:
 *   - npm run dev (Express :3001), not in production (the built-in carrier plays CMDU, HLCU and MAEU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
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
const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
const list = b => (Array.isArray(b) ? b : (b?.results ?? []));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const hoursAhead = iso => (Date.parse(iso) - Date.now()) / 36e5;

(async () => {
  const cleanup = { shipments: [], customers: [], quotes: [], offers: [], rules: [], users: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const shipper = (await request("POST", "/api/customers", { companyName: `Spot Desk Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Spot Desk Consignee ${rand} Inc` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id);

    const newShipment = async ({ carrierCode = "CMDU", etd = inDays(30), eta = inDays(44) } = {}) => {
      const s = (await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode, status: "Active", contractType: "SPOT", contractRef: "",
        etd, eta, incoterm: "FOB", commodityCode: "9999", cargoReadyDate: inDays(1),
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId,
      }, token)).body;
      cleanup.shipments.push(s.id);
      await addContainer(request, token, s.id);
      await addContainer(request, token, s.id);
      await request("POST", `/api/shipments/${s.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", carrierCode,
        etd, eta, vessel: "DEMO SPOTLINER", voyage: "0SD1W", vesselImo: "9999995" }, token);
      return s.id;
    };
    const take = async (carrierCode, offerRef) => {
      const r = await request("POST", "/api/spot-offers/from-carrier", { carrierCode, offerRef }, token);
      if (r.body?.id && !cleanup.offers.includes(r.body.id)) cleanup.offers.push(r.body.id);
      return r;
    };
    const typeIn = async (over = {}) => {
      const r = await request("POST", "/api/spot-offers", {
        carrierCode: "CMDU", offerRef: `QSD${rand}${Math.floor(Math.random() * 1e4)}`, kind: "classic", pol: "NLRTM", pod: "USNYC",
        equipment: [{ containerType: "40HC", quantity: 2 }], validUntil: inDays(10),
        lines: [{ serviceCode: "OF", description: "Ocean freight", unitPrice: 2050 }, { serviceCode: "DOC", description: "Documentation fee", basis: "per_bl", unitPrice: 75 }],
        penalties: { cancellationFee: 150, cancellationNoticeDays: 7, noShowFee: 300, currency: "USD", basis: "per_container" }, ...over,
      }, token);
      if (r.body?.id) cleanup.offers.push(r.body.id);
      return r;
    };
    const shipmentLines = async id => list((await request("GET", `/api/shipments/${id}/cost-lines`, null, token)).body);
    const history = async id => list((await request("GET", `/api/shipments/${id}/events?limit=200`, null, token)).body);

    console.log("Phase 2: offers from the carrier");
    let r = await request("GET", `/api/spot-offers/from-carrier?carrierCode=CMDU&pol=NLRTM&pod=USNYC&equipment=40HC:2&from=${inDays(1)}`, null, token);
    const cmdu = r.body;
    assert("the demo carrier answers for CMDU", r.status === 200 && cmdu.available && cmdu.demo && cmdu.offers.length >= 2, JSON.stringify(r.body).slice(0, 300));
    const o1 = cmdu.offers[0];
    assert("one digital offer per departure, priced from the booking", cmdu.offers.every(o => o.kind === "digital" && o.priceLock === "booking" && o.etd && o.vessel)
      && new Set(cmdu.offers.map(o => o.etd)).size === cmdu.offers.length, JSON.stringify(cmdu.offers.map(o => [o.etd, o.vessel])));
    assert("all-in: ocean freight, bunker, origin THC in EUR (from Rotterdam), documentation", ["OF", "BAF", "THC-O", "DOC"].every(c => o1.lines.some(l => l.serviceCode === c))
      && o1.lines.find(l => l.serviceCode === "THC-O").currency === "EUR" && o1.lines.every(l => l.included), JSON.stringify(o1.lines.map(l => [l.serviceCode, l.currency])));
    assert("the list shows the price in USD, as a saved offer would", o1.totalUsd > 0 && o1.subjectToUsd === 0);
    assert("CMA CGM's offers live 24 hours", hoursAhead(o1.validUntil) > 23 && hoursAhead(o1.validUntil) <= 24.05, o1.validUntil);
    assert("…with the demo carrier's penalty terms", o1.penalties.cancellationFee === 150 && o1.penalties.noShowFee === 300 && o1.penalties.cancellationNoticeDays === 7);
    r = await request("GET", `/api/spot-offers/from-carrier?carrierCode=HLCU&pol=NLRTM&pod=USNYC&equipment=40HC:2&from=${inDays(1)}`, null, token);
    assert("Hapag-Lloyd's live 3 hours", r.body.offers?.length > 0 && hoursAhead(r.body.offers[0].validUntil) > 2.9 && hoursAhead(r.body.offers[0].validUntil) <= 3.05);
    r = await request("GET", `/api/spot-offers/from-carrier?carrierCode=HLCU&pol=NLRTM&pod=USNYC&equipment=40HC:21&from=${inDays(1)}`, null, token);
    assert("…for at most 20 containers", r.body.offers?.length === 0 && /at most 20/.test(r.body.message), JSON.stringify(r.body));
    r = await request("GET", "/api/spot-offers/from-carrier?carrierCode=CMDU&pol=NLRTM&pod=USNYC", null, token);
    assert("no containers → 400", r.status === 400);

    r = await take("CMDU", o1.offerRef);
    const taken = r.body;
    assert("taking one saves it: demo source, digital, same price", r.status === 201 && taken.source === "demo" && taken.kind === "digital"
      && Math.abs(taken.totalUsd - o1.totalUsd) < 0.02 && taken.etd === o1.etd, JSON.stringify(r.body).slice(0, 200));
    r = await take("CMDU", o1.offerRef);
    assert("taking it again returns the same offer", r.status === 200 && r.body.id === taken.id);
    assert("a made-up reference is refused (404)", (await take("CMDU", "CMDUSPOTNOPE")).status === 404);
    r = await request("GET", `/api/spot-offers/from-carrier?carrierCode=CMDU&pol=NLRTM&pod=USNYC&equipment=40HC:2&from=${inDays(1)}`, null, token);
    assert("…and a new search lists fresh offers", r.body.offers.length > 0 && r.body.offers.every(o => o.offerRef !== o1.offerRef));

    const A = await newShipment({ etd: taken.etd, eta: taken.sailing?.eta || inDays(44) });
    r = await request("POST", `/api/shipments/${A}/spot-offer`, { offerId: taken.id }, token);
    assert("attached to a CMDU shipment", r.status === 200 && r.body.buyLines === 4, JSON.stringify(r.body).slice(0, 200));
    r = await request("POST", `/api/shipments/${A}/edi-messages/booking-request`, {}, token);
    assert("booked", r.status === 201 && !r.body.warning, JSON.stringify(r.body).slice(0, 200));
    await waitForCarrierReference(request, token, A);
    r = await carrierActs(request, token, A, "confirm");
    const cmp = (await request("GET", `/api/shipments/${A}/carrier-booking/comparison`, null, token)).body;
    const groupIdx = cmp.rows.findIndex(x => x.group === "CHARGES");
    const chargeRows = groupIdx < 0 ? [] : cmp.rows.slice(groupIdx + 1).filter((x, i, arr) => !x.group && arr.slice(0, i).every(y => !y.group));
    assert("the carrier confirms with the offer's charges: a CHARGES group, every row the same", groupIdx >= 0 && chargeRows.length === 4
      && chargeRows.every(x => x.kind === "same"), JSON.stringify(chargeRows));
    assert("…and the Quotation row", cmp.rows.find(x => x.label === "Quotation")?.kind === "same");

    console.log("\nPhase 3: validity at booking");
    const B = await newShipment();
    const soon = (await typeIn({ kind: "digital", validUntil: new Date(Date.now() + 2500).toISOString(), priceLock: "booking" })).body;
    r = await request("POST", `/api/shipments/${B}/spot-offer`, { offerId: soon.id }, token);
    assert("a digital offer with seconds to go attaches", r.status === 200, JSON.stringify(r.body).slice(0, 150));
    await sleep(3200);
    r = await request("POST", `/api/shipments/${B}/edi-messages/booking-request`, {}, token);
    assert("once expired, Send Booking Request is refused (409)", r.status === 409 && /expired/.test(r.body?.error) && /fresh offer/.test(r.body?.error), JSON.stringify(r.body));
    const C = await newShipment();
    const old = (await typeIn({ validUntil: inDays(-1) })).body;
    await request("POST", `/api/shipments/${C}/spot-offer`, { offerId: old.id }, token);
    r = await request("POST", `/api/shipments/${C}/edi-messages/booking-request`, {}, token);
    assert("an expired classic quote is booked, with a warning", r.status === 201 && /expired/.test(r.body?.warning || ""), JSON.stringify(r.body).slice(0, 200));

    console.log("\nPhase 3: the late-cancel fee");
    const D = await newShipment({ etd: inDays(5), eta: inDays(19) });
    const late = (await typeIn()).body;
    await request("POST", `/api/shipments/${D}/spot-offer`, { offerId: late.id }, token);
    r = await request("GET", `/api/shipments/${D}/spot-offer/cancellation-fee`, null, token);
    assert("no fee before the carrier confirms", r.status === 200 && r.body === null, JSON.stringify(r.body));
    await request("POST", `/api/shipments/${D}/edi-messages/booking-request`, {}, token);
    await waitForCarrierReference(request, token, D);
    await carrierActs(request, token, D, "confirm");
    r = await request("GET", `/api/shipments/${D}/spot-offer/cancellation-fee`, null, token);
    assert("5 days before ETD (notice 7): the no-show fee, 2 × USD 300", r.body?.kind === "no_show" && r.body.fee === 600 && r.body.units === 2 && r.body.perUnit === 300,
      JSON.stringify(r.body));
    r = await request("PATCH", `/api/shipments/${D}/carrier-booking/cancel`, { reason: "Customer cancelled the order" }, token);
    assert("cancellation asked of the carrier", r.status === 200, JSON.stringify(r.body).slice(0, 150));
    assert("nothing accrued until the carrier agrees", !(await shipmentLines(D)).some(l => /No-show fee/.test(l.notes)));
    r = await carrierActs(request, token, D, "confirmCancellation");
    let lines = await shipmentLines(D);
    const fee = lines.find(l => l.type === "BUY" && /No-show fee/.test(l.notes));
    assert("the carrier confirms: USD 600 on the BUY side", r.status === 200 && fee && fee.amount === 600 && fee.source === "spot_offer" && fee.chargeCode === "Other",
      JSON.stringify(lines.map(l => [l.type, l.chargeCode, l.amount, l.notes?.slice(0, 40)])));
    assert("History: the fee accrued", (await history(D)).some(e => e.eventType === "SPOT_PENALTY_ACCRUED"));
    const E = await newShipment({ etd: inDays(20), eta: inDays(34) });
    await request("POST", `/api/shipments/${E}/spot-offer`, { offerId: (await typeIn()).body.id }, token);
    await request("POST", `/api/shipments/${E}/edi-messages/booking-request`, {}, token);
    await waitForCarrierReference(request, token, E);
    await carrierActs(request, token, E, "confirm");
    r = await request("GET", `/api/shipments/${E}/spot-offer/cancellation-fee`, null, token);
    assert("20 days before ETD: the cancellation fee, 2 × USD 150", r.body?.kind === "cancellation" && r.body.fee === 300, JSON.stringify(r.body));

    console.log("\nPhase 3: the escalation books with another carrier");
    const makeUser = async (key, roles) => {
      const email = `spot-${key}-${rand.toLowerCase()}@example.com`;
      await request("POST", "/api/users", { email, name: `${key} ${rand}`, roles, password: "SpotFixture!2026Zq" }, token);
      cleanup.users.push(email);
      const id = list((await request("GET", "/api/users", null, token)).body).find(u => u.email === email)?.id;
      await request("POST", `/api/users/${id}/offices`, { officeId: emoOfficeId }, token);
      return (await request("POST", "/api/auth/login", { email, password: "SpotFixture!2026Zq" })).body.token;
    };
    const escBk = await makeUser("escbk", ["occ_bk"]), escAy = await makeUser("escay", ["occ_ay"]);
    const F = await newShipment({ etd: "2026-11-16", eta: "2026-11-30" });
    const cmduQuote = (await typeIn()).body;
    await request("POST", `/api/shipments/${F}/spot-offer`, { offerId: cmduQuote.id }, token);
    await request("POST", `/api/shipments/${F}/edi-messages/booking-request`, {}, token);
    await carrierActs(request, token, F, "reject", "No space");
    const esc = (await request("POST", `/api/shipments/${F}/escalations`, { toRole: "occ_ay" }, escBk)).body.escalation;
    await request("POST", `/api/escalations/${esc.id}/actions`, { action: "instruct", message: "MSCU has space",
      instruction: { carrierCode: "MSCU", contractNumber: "MSCU-SC-2026-0118", rank: 2, source: "contracts", sailing: { vesselName: "DEMO ALLEGRO", voyageNumber: "DM002W", etd: "2026-11-23", eta: "2026-12-07", service: "DEMO SERVICE", transitDays: 14 } } }, escAy);
    r = await request("POST", `/api/escalations/${esc.id}/book`, {}, escBk);
    const sf = (await request("GET", `/api/shipments/${F}`, null, token)).body;
    assert("booked with MSCU as instructed", r.status === 200 && sf.carrierCode === "MSCU", JSON.stringify(r.body).slice(0, 200));
    assert("CMDU's offer came off: no offer, no spot BUY lines, and the reference is the MSCU contract the instruction named",
      sf.spotOfferId === "" && sf.contractRef === "MSCU-SC-2026-0118"
      && !(await shipmentLines(F)).some(l => l.source === "spot_offer"), JSON.stringify({ o: sf.spotOfferId, r: sf.contractRef }));
    assert("History says why", (await history(F)).some(e => e.eventType === "SPOT_OFFER_DETACHED" && /MSCU/.test(e.meta?.reason || "")));
    const outF = list((await request("GET", `/api/shipments/${F}/edi-messages`, null, token)).body)
      .filter(m => m.direction === "out" && m.messageType === "booking_request" && m.carrierCode === "MSCU");
    let payloadF = {};
    try { payloadF = JSON.parse(outF[0]?.parsedPayload || outF[0]?.rawPayload || "{}"); } catch { payloadF = {}; }
    assert("MSCU's booking request carries no CMDU quotation reference", outF.length === 1 && !payloadF.quotationReference, JSON.stringify(payloadF).slice(0, 160));
    assert("CMDU's offer stays Booked: the record of the request it went with", (await request("GET", `/api/spot-offers/${cmduQuote.id}`, null, token)).body.status === "Booked");

    console.log("\nPhase 4: margin rules");
    const tmEmail = `spot-tm-${rand.toLowerCase()}@example.com`, bkEmail = `spot-bk-${rand.toLowerCase()}@example.com`;
    await request("POST", "/api/users", { email: tmEmail, name: `tm ${rand}`, roles: ["trade_manager"], password: "SpotFixture!2026Zq" }, token);
    await request("POST", "/api/users", { email: bkEmail, name: `bk ${rand}`, roles: ["occ_bk"], password: "SpotFixture!2026Zq" }, token);
    cleanup.users.push(tmEmail, bkEmail);
    const tm = (await request("POST", "/api/auth/login", { email: tmEmail, password: "SpotFixture!2026Zq" })).body.token;
    const bk = (await request("POST", "/api/auth/login", { email: bkEmail, password: "SpotFixture!2026Zq" })).body.token;
    const rule = async (body, who = tm) => { const x = await request("POST", "/api/margin-rules", body, who); if (x.body?.id) cleanup.rules.push(x.body.id); return x; };
    assert("OCC/BK can't set margin rules (403)", (await rule({ kind: "percent", value: 12 }, bk)).status === 403);
    r = await rule({ customerId: shipper.id, customerName: shipper.companyName, originLane: "EU-N", destLane: "NAM", containerType: "40HC", kind: "fixed", value: 150, minMarginPct: 8, validFrom: "2026-01-01", validTo: "2027-12-31" });
    assert("a Trade Manager sets the customer's rule on EU-N → NAM, 40HC (201)", r.status === 201 && r.body.kind === "fixed" && r.body.value === 150, JSON.stringify(r.body));
    r = await rule({ customerId: shipper.id, customerName: shipper.companyName, kind: "percent", value: 10, minMarginPct: 6 });
    assert("…and its rule for any lane", r.status === 201);
    r = await rule({ customerId: shipper.id, customerName: shipper.companyName, originLane: "EU-N", destLane: "NAM", containerType: "40HC", kind: "fixed", value: 99, validFrom: "2027-06-01" });
    assert("an overlapping rule for the same customer, lane and container → 409", r.status === 409, JSON.stringify(r.body));
    r = await rule({ originLane: "EU-N", destLane: "XX-NOPE", kind: "percent", value: 5 });
    assert("an unknown trade lane → 400", r.status === 400);
    r = await request("GET", `/api/margin-rules/resolve?customerId=${shipper.id}&pol=NLRTM&pod=USNYC&containerType=40HC&date=2026-11-10`, null, token);
    assert("the most specific applies: the customer's lane and container rule", r.body?.kind === "fixed" && r.body.value === 150 && r.body.containerType === "40HC", JSON.stringify(r.body));
    r = await request("GET", `/api/margin-rules/resolve?customerId=${shipper.id}&pol=CNSHA&pod=USNYC&containerType=40HC&date=2026-11-10`, null, token);
    assert("another lane: the customer's rule for any lane", r.body?.kind === "percent" && r.body.value === 10, JSON.stringify(r.body));

    const quote = (await request("POST", "/api/quotes", {
      customerId: shipper.id, customerName: shipper.companyName, pol: "NLRTM", pod: "USNYC", commodityCode: "9999", cargoReadyDate: "2026-11-10", validUntil: inDays(10),
      lines: [{ serviceCode: "OF", description: "Ocean freight, all in", containerType: "40HC", quantity: 2, rate: 2150, currency: "USD" }],
    }, token)).body;
    cleanup.quotes.push(quote.id);
    const buy = (await typeIn()).body;   // OF 2 × 2,050 + DOC 75 = 4,175
    await request("POST", `/api/quotes/${quote.id}/spot-offer`, { offerId: buy.id }, token);
    r = await request("GET", `/api/quotes/${quote.id}/margin`, null, token);
    assert("the quote's margin: buy 4,175, sell 4,300 → 2.9%, below the rule's 8%", r.body?.buyUsd === 4175 && r.body.sellUsd === 4300 && r.body.marginPct === 2.9
      && r.body.belowMinimum && r.body.rule?.value === 150, JSON.stringify(r.body));
    r = await request("POST", `/api/quotes/${quote.id}/send`, {}, token);
    assert("sent anyway, with a warning", r.status === 200 && r.body.status === "Sent" && /below the 8% minimum/.test(r.body.marginWarning || ""), JSON.stringify(r.body).slice(0, 200));
  } catch (e) {
    console.error("Unexpected error:", e);
    failed++;
  } finally {
    // Margin rules are lookup rows: left behind, they would price other quotes (always removed).
    for (const id of cleanup.rules) await request("DELETE", `/api/margin-rules/${id}`, null, token).catch(() => {});
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    for (const id of cleanup.quotes) await request("DELETE", `/api/quotes/${id}`, null, token).catch(() => {});
    for (const id of cleanup.offers) await request("DELETE", `/api/spot-offers/${id}`, null, token).catch(() => {});
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
    const users = list((await request("GET", "/api/users", null, token)).body);
    for (const email of cleanup.users) { const u = users.find(x => x.email === email); if (u) await request("DELETE", `/api/users/${u.id}`, null, token).catch(() => {}); }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
