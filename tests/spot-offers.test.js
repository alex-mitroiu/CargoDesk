/**
 * SPOT rates, phase 1 (plan https://claude.ai/artifact/Y61PAmXZfgFxTLtpt7GiAZ; decisions 2026-10-21).
 *   - a carrier's spot offer typed in: reference, kind (classic quote / digital spot), route, containers,
 *     validity, charges (included or "subject to"), penalty terms — checked, priced in USD;
 *   - on a Draft quote: the quote takes the offer's carrier and reference; converting it makes a SPOT
 *     shipment whose BUY side is the offer's charges;
 *   - straight on a shipment (the booking desk): SPOT, the offer's reference, its BUY lines; a second offer
 *     replaces the first, removing take it off again; carrier, route, Central contract, an expired
 *     digital offer and a booking already sent all refuse it; an expired classic quote only warns;
 *   - the DCSA booking carries the offer as contractQuotationReference (never a serviceContractReference
 *     beside it), the A/B table compares it, and the offer is then booked on.
 *
 * Usage:
 *   node tests/spot-offers.test.js
 *
 * Prerequisites:
 *   - npm run dev (Express :3001), not in production (the built-in DCSA carrier plays CMDU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "./helpers/offices.mjs";
import { carrierActs, waitForCarrierReference, addContainer } from "./helpers/dcsa-sim.mjs";

const BASE = "http://localhost:3001";
let passed = 0, failed = 0;

async function request(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }), ...headers },
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
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.02;
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// A CMA CGM quote for 2 × 40' HC Rotterdam → New York, as its pricing desk would send it.
const offerBody = (over = {}) => ({
  carrierCode: "CMDU", offerRef: `QCMDU${rand}01`, kind: "classic", pol: "NLRTM", pod: "USNYC",
  equipment: [{ containerType: "40HC", quantity: 2 }], validUntil: inDays(14), priceLock: "gate_in",
  lines: [
    { serviceCode: "OF", description: "Ocean freight", basis: "per_container", containerType: "40HC", unitPrice: 2100 },
    { serviceCode: "BAF", description: "Bunker adjustment", unitPrice: 250 },
    { serviceCode: "THC-O", description: "Origin terminal handling", unitPrice: 190, currency: "EUR" },
    { serviceCode: "DOC", description: "Documentation fee", basis: "per_bl", unitPrice: 75 },
    { serviceCode: "PSS", description: "Peak season surcharge", unitPrice: 300, included: false },
  ],
  penalties: { cancellationFee: 150, cancellationNoticeDays: 7, noShowFee: 300, amendmentFee: 75, currency: "USD", basis: "per_container" },
  notes: "FAK, valid for gate-in within validity",
  ...over,
});

(async () => {
  const cleanup = { shipments: [], customers: [], users: [], quotes: [], offers: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const shipper = (await request("POST", "/api/customers", { companyName: `Spot Rates Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Spot Rates Consignee ${rand} Inc` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id);
    const fx = (await request("GET", "/api/fx/rates", null, token)).body;
    const eurPerUsd = Number(fx?.rates?.EUR ?? fx?.EUR) || null;

    const newOffer = async (over = {}) => {
      const r = await request("POST", "/api/spot-offers", offerBody(over), token);
      if (r.body?.id) cleanup.offers.push(r.body.id);
      return r;
    };
    const newShipment = async ({ carrierCode = "CMDU", contractType = "SPOT", pol = "NLRTM", pod = "USNYC", extra = {} } = {}) => {
      const s = (await request("POST", "/api/shipments", {
        pol, pod, carrierCode, status: "Active", contractType, contractRef: contractType === "SPOT" ? "" : `CT-${rand}`,
        etd: "2026-11-16", eta: "2026-11-30", incoterm: "FOB", commodityCode: "9999", cargoReadyDate: "2026-11-10",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId, ...extra,
      }, token)).body;
      cleanup.shipments.push(s.id);
      await addContainer(request, token, s.id);
      await addContainer(request, token, s.id);
      await request("POST", `/api/shipments/${s.id}/legs`, { legType: "SEA", movementType: "SEA", pol, pod, carrierCode,
        etd: "2026-11-16", eta: "2026-11-30", vessel: "CMA CGM SPOTLIGHT", voyage: "0SP1W", vesselImo: "9999995" }, token);
      return s.id;
    };
    const shipment = async id => (await request("GET", `/api/shipments/${id}`, null, token)).body;
    const spotBuyLines = async id => list((await request("GET", `/api/shipments/${id}/cost-lines`, null, token)).body)
      .filter(l => l.type === "BUY" && l.source === "spot_offer");
    const history = async id => list((await request("GET", `/api/shipments/${id}/events?limit=200`, null, token)).body);

    console.log("Typing in a spot offer");
    let r = await request("POST", "/api/spot-offers", offerBody({ carrierCode: "" }), token);
    assert("no carrier → 400", r.status === 400 && /carrier/i.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", "/api/spot-offers", offerBody({ offerRef: "X".repeat(36) }), token);
    assert("a reference over 35 characters (DCSA) → 400", r.status === 400 && /35/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", "/api/spot-offers", offerBody({ equipment: [{ containerType: "BIGBOX", quantity: 2 }] }), token);
    assert("an unknown container type → 400", r.status === 400 && /container type/i.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", "/api/spot-offers", offerBody({ lines: [] }), token);
    assert("no charges → 400", r.status === 400 && /charges/i.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", "/api/spot-offers", offerBody({ validUntil: "" }), token);
    assert("no validity → 400", r.status === 400 && /until when/i.test(r.body?.error), JSON.stringify(r.body));

    r = await newOffer();
    const A = r.body;
    assert("created (201), Offered, classic, bookable", r.status === 201 && A.status === "Offered" && A.kind === "classic" && A.bookable && !A.expired,
      JSON.stringify(r.body).slice(0, 300));
    const line = code => A.lines?.find(l => l.serviceCode === code);
    assert("per-container charges count the offer's containers (2 × 40HC)", line("OF")?.quantity === 2 && line("OF").amount === 4200
      && line("BAF")?.containerType === "40HC" && line("BAF").amount === 500, JSON.stringify(A.lines?.slice(0, 2)));
    assert("a per-B/L charge is charged once", line("DOC")?.quantity === 1 && line("DOC").amount === 75 && line("DOC").containerType === "");
    assert("a EUR charge is priced in USD", line("THC-O")?.currency === "EUR" && line("THC-O").amount === 380
      && (eurPerUsd ? near(line("THC-O").amountUsd, 380 / eurPerUsd) : line("THC-O").amountUsd > 0), JSON.stringify(line("THC-O")));
    const includedUsd = A.lines.filter(l => l.included).reduce((s, l) => s + l.amountUsd, 0);
    assert("the price is the included charges; \"subject to\" is apart", near(A.totalUsd, includedUsd) && A.subjectToUsd === 600 && line("PSS")?.included === false,
      `${A.totalUsd} vs ${includedUsd}, subject to ${A.subjectToUsd}`);
    assert("charge codes resolve to their names", line("OF")?.chargeCode === "Ocean Freight" && line("THC-O")?.chargeCode === "Origin THC");
    assert("penalty terms and price lock are kept", A.penalties?.cancellationFee === 150 && A.penalties.cancellationNoticeDays === 7
      && A.penalties.noShowFee === 300 && A.priceLock === "gate_in" && A.priceLockLabel === "At gate-in", JSON.stringify(A.penalties));
    r = await request("GET", "/api/spot-offers?carrierCode=CMDU&unattached=1", null, token);
    assert("listed among the unattached CMDU offers", r.status === 200 && list(r.body).some(o => o.id === A.id));

    console.log("\nWho can price");
    const salesEmail = `spot-sales-${rand.toLowerCase()}@example.com`, viewerEmail = `spot-viewer-${rand.toLowerCase()}@example.com`;
    await request("POST", "/api/users", { email: salesEmail, name: `sales ${rand}`, roles: ["sales"], password: "SpotFixture!2026Zq" }, token);
    await request("POST", "/api/users", { email: viewerEmail, name: `viewer ${rand}`, roles: ["viewer"], password: "SpotFixture!2026Zq" }, token);
    cleanup.users.push(salesEmail, viewerEmail);
    // Sales sees the quotes of its own office (office-scoped, like every quote).
    const salesId = list((await request("GET", "/api/users", null, token)).body).find(u => u.email === salesEmail)?.id;
    await request("POST", `/api/users/${salesId}/offices`, { officeId: emoOfficeId }, token);
    const sales = (await request("POST", "/api/auth/login", { email: salesEmail, password: "SpotFixture!2026Zq" })).body.token;
    const viewer = (await request("POST", "/api/auth/login", { email: viewerEmail, password: "SpotFixture!2026Zq" })).body.token;
    r = await request("POST", "/api/spot-offers", offerBody({ offerRef: `QCMDU${rand}SL` }), sales);
    if (r.body?.id) cleanup.offers.push(r.body.id);
    assert("sales types in an offer (201)", r.status === 201, JSON.stringify(r.body).slice(0, 200));
    assert("a viewer can't (403)", (await request("POST", "/api/spot-offers", offerBody({ offerRef: `QCMDU${rand}VW` }), viewer)).status === 403);

    console.log("\nOn a quote, then converted");
    const quote = (await request("POST", "/api/quotes", {
      customerId: shipper.id, customerName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      principalId: shipper.id, principalName: shipper.companyName, pol: "NLRTM", pod: "USNYC", carrierCode: "", commodityCode: "9999",
      incoterm: "FOB", cargoReadyDate: "2026-11-10", validUntil: inDays(10), officeId: emoOfficeId,
      lines: [{ serviceCode: "OF", description: "Ocean freight, all in", containerType: "40HC", quantity: 2, rate: 3150, currency: "USD" }],
    }, token)).body;
    cleanup.quotes.push(quote.id);
    // The app sends the office a user works in as X-Office-Id; quotes are scoped by it.
    r = await request("POST", `/api/quotes/${quote.id}/spot-offer`, { offerId: A.id }, sales, { "X-Office-Id": emoOfficeId });
    assert("sales attaches it to the Draft quote", r.status === 200 && r.body.offer?.status === "Attached" && r.body.offer.quoteId === quote.id, JSON.stringify(r.body).slice(0, 200));
    let q = (await request("GET", `/api/quotes/${quote.id}`, null, token)).body;
    assert("the quote takes the offer's carrier and reference", q.carrierCode === "CMDU" && q.contractRef === A.offerRef && q.contractId === "" && q.spotOfferId === A.id,
      JSON.stringify({ c: q.carrierCode, r: q.contractRef, s: q.spotOfferId }));
    r = await request("PUT", `/api/quotes/${quote.id}`, { ...q, carrierCode: "MAEU" }, token);
    assert("changing the quote's carrier away from the offer → 409", r.status === 409 && /remove the offer/i.test(r.body?.error), JSON.stringify(r.body));
    r = await request("PUT", `/api/quotes/${quote.id}`, { ...q, contractRef: "SOMETHING ELSE", notes: "Rates per CMA CGM quote" }, token);
    assert("an ordinary edit keeps the offer's reference", r.status === 200 && r.body.contractRef === A.offerRef && r.body.notes === "Rates per CMA CGM quote");
    r = await request("PUT", `/api/spot-offers/${A.id}`, offerBody({ offerRef: A.offerRef, lines: offerBody().lines.map(l => l.serviceCode === "OF" ? { ...l, unitPrice: 2050 } : l) }), token);
    assert("the offer can still be corrected while its quote is a Draft", r.status === 200 && r.body.lines.find(l => l.serviceCode === "OF")?.amount === 4100);

    const B = (await newOffer({ offerRef: `QCMDU${rand}02` })).body;
    r = await request("POST", `/api/quotes/${quote.id}/spot-offer`, { offerId: B.id }, token);
    const aBack = (await request("GET", `/api/spot-offers/${A.id}`, null, token)).body;
    assert("a second offer replaces the first, which goes back to Offered", r.status === 200 && aBack.status === "Offered" && aBack.quoteId === "", JSON.stringify(aBack).slice(0, 120));
    r = await request("POST", `/api/quotes/${quote.id}/spot-offer`, { offerId: A.id }, token);
    assert("…and back again", r.status === 200 && (await request("GET", `/api/spot-offers/${B.id}`, null, token)).body.status === "Offered");

    await request("POST", `/api/quotes/${quote.id}/send`, {}, token);
    await request("POST", `/api/quotes/${quote.id}/accept`, {}, token);
    r = await request("PUT", `/api/spot-offers/${A.id}`, offerBody({ offerRef: A.offerRef }), token);
    assert("once the quote is sent, the offer is fixed (409)", r.status === 409, JSON.stringify(r.body));
    r = await request("POST", `/api/quotes/${quote.id}/convert`, {}, token);
    const Q = r.body?.shipmentId;
    if (Q) cleanup.shipments.push(Q);
    assert("converted", r.status === 200 && !!Q, JSON.stringify(r.body).slice(0, 200));
    let s = await shipment(Q);
    assert("a SPOT shipment on the offer's reference", s.contractType === "SPOT" && s.contractRef === A.offerRef && s.spotOfferId === A.id && s.carrierCode === "CMDU",
      JSON.stringify({ t: s.contractType, r: s.contractRef, o: s.spotOfferId }));
    let buys = await spotBuyLines(Q);
    assert("its BUY side is the offer's charges, \"subject to\" included and marked", buys.length === 5
      && near(buys.find(l => l.chargeCode === "Ocean Freight")?.amount, 4100) && buys.some(l => /subject to change/.test(l.notes)), JSON.stringify(buys.map(l => [l.chargeCode, l.amount])));
    const sells = list((await request("GET", `/api/shipments/${Q}/cost-lines`, null, token)).body).filter(l => l.type === "SELL" && l.source === "quote");
    assert("its SELL side is still the quote's", sells.length === 1 && near(sells[0].amount, 6300), JSON.stringify(sells.map(l => l.amount)));
    let offer = (await request("GET", `/api/shipments/${Q}/spot-offer`, null, token)).body;
    assert("the offer is now on the shipment", offer?.id === A.id && offer.shipmentId === Q && offer.quoteId === quote.id && offer.status === "Attached");

    console.log("\nThe booking carries it to the carrier");
    r = await request("POST", `/api/shipments/${Q}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", carrierCode: "CMDU",
      etd: "2026-11-16", eta: "2026-11-30", vessel: "CMA CGM SPOTLIGHT", voyage: "0SP2W", vesselImo: "9999995" }, token);
    r = await request("POST", `/api/shipments/${Q}/edi-messages/booking-request`, {}, token);
    assert("booking request sent (201)", r.status === 201, JSON.stringify(r.body).slice(0, 300));
    const msgs = list((await request("GET", `/api/shipments/${Q}/edi-messages`, null, token)).body);
    const out = msgs.find(m => m.direction === "out" && m.messageType === "booking_request");
    let payload = {};
    try { payload = JSON.parse(out?.parsedPayload || out?.rawPayload || "{}"); } catch { payload = {}; }
    assert("the request names the offer as its quotation reference", payload.quotationReference === A.offerRef && !payload.contractNumber, JSON.stringify(payload).slice(0, 200));
    let sentBody = {};
    try { sentBody = JSON.parse(out?.rawPayload || "{}"); } catch { sentBody = {}; }
    assert("…and the DCSA booking sent carries it as contractQuotationReference, with no service contract (exactly one of the two)",
      sentBody.contractQuotationReference === A.offerRef && !sentBody.serviceContractReference, JSON.stringify(sentBody).slice(0, 200));
    assert("the offer is booked on", (await request("GET", `/api/spot-offers/${A.id}`, null, token)).body.status === "Booked");
    await waitForCarrierReference(request, token, Q);
    r = await carrierActs(request, token, Q, "confirm");
    assert("the carrier confirms", r.status === 200, JSON.stringify(r.body).slice(0, 200));
    const cmp = (await request("GET", `/api/shipments/${Q}/carrier-booking/comparison`, null, token)).body;
    const rowOf = label => cmp?.rows?.find(x => x.label === label);
    assert("the carrier's booking holds contractQuotationReference and no contract (A/B: Quotation, same)", rowOf("Quotation")?.kind === "same"
      && rowOf("Quotation").b === A.offerRef && !rowOf("Contract"), JSON.stringify([rowOf("Quotation"), rowOf("Contract")]));
    r = await request("DELETE", `/api/shipments/${Q}/spot-offer`, null, token);
    assert("once the carrier has the booking, the offer can't be removed (409)", r.status === 409 && /already went/.test(r.body?.error), JSON.stringify(r.body));

    console.log("\nStraight on a shipment (the booking desk)");
    const S = await newShipment();
    const C = (await newOffer({ offerRef: `QCMDU${rand}03` })).body;
    r = await request("POST", `/api/shipments/${S}/spot-offer`, { offerId: C.id }, sales);
    assert("sales can't put an offer on a shipment (403)", r.status === 403);
    r = await request("POST", `/api/shipments/${S}/spot-offer`, { offerId: C.id }, token);
    assert("attached (200) with 5 BUY lines", r.status === 200 && r.body.buyLines === 5 && !r.body.warning, JSON.stringify(r.body).slice(0, 200));
    s = await shipment(S);
    assert("the shipment is SPOT on the offer's reference", s.contractType === "SPOT" && s.contractRef === C.offerRef && s.spotOfferId === C.id);
    let ev = await history(S);
    assert("History: Spot offer attached", ev.some(e => e.eventType === "SPOT_OFFER_ATTACHED" && e.newValue === C.offerRef), JSON.stringify(ev.map(e => e.eventType)));
    r = await request("PUT", `/api/spot-offers/${C.id}`, offerBody({ offerRef: C.offerRef }), token);
    assert("an offer on a shipment can't be edited there (409)", r.status === 409 && /detach/i.test(r.body?.error));
    assert("…nor deleted (409)", (await request("DELETE", `/api/spot-offers/${C.id}`, null, token)).status === 409);

    const D = (await newOffer({ offerRef: `QCMDU${rand}04`, lines: [{ serviceCode: "OF", unitPrice: 2400 }] })).body;
    r = await request("POST", `/api/shipments/${S}/spot-offer`, { offerId: D.id }, token);
    buys = await spotBuyLines(S);
    assert("a better offer replaces it: the old BUY lines go, the new one comes", r.status === 200 && buys.length === 1 && near(buys[0].amount, 4800)
      && (await request("GET", `/api/spot-offers/${C.id}`, null, token)).body.status === "Offered", JSON.stringify(buys.map(l => l.amount)));
    r = await request("DELETE", `/api/shipments/${S}/spot-offer`, null, token);
    s = await shipment(S);
    assert("removed: no spot BUY lines, no reference", r.status === 200 && r.body.removedBuyLines === 1 && (await spotBuyLines(S)).length === 0
      && s.spotOfferId === "" && s.contractRef === "", JSON.stringify({ r: r.body, ref: s.contractRef }));
    ev = await history(S);
    assert("History: Spot offer removed", ev.some(e => e.eventType === "SPOT_OFFER_DETACHED"));

    console.log("\nWhat refuses an offer");
    r = await request("POST", `/api/shipments/${await newShipment({ carrierCode: "MSCU" })}/spot-offer`, { offerId: C.id }, token);
    assert("another carrier's shipment → 409", r.status === 409 && /CMDU/.test(r.body?.error) && /MSCU/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", `/api/shipments/${await newShipment({ pod: "USSAV" })}/spot-offer`, { offerId: C.id }, token);
    assert("another route → 409", r.status === 409 && /NLRTM → USNYC/.test(r.body?.error), JSON.stringify(r.body));
    r = await request("POST", `/api/shipments/${await newShipment({ contractType: "Central" })}/spot-offer`, { offerId: C.id }, token);
    assert("a Central-contract shipment → 409 (change its contract first)", r.status === 409 && /Central/.test(r.body?.error), JSON.stringify(r.body));
    const expiredDigital = (await newOffer({ offerRef: `SPOTON${rand}`, kind: "digital", validUntil: new Date(Date.now() - 60e3).toISOString(), priceLock: "booking" })).body;
    assert("an expired digital offer says it can't be booked", expiredDigital.expired && !expiredDigital.bookable);
    r = await request("POST", `/api/shipments/${S}/spot-offer`, { offerId: expiredDigital.id }, token);
    assert("…and is refused on a shipment (409)", r.status === 409 && /expired/.test(r.body?.error), JSON.stringify(r.body));
    const expiredClassic = (await newOffer({ offerRef: `QCMDU${rand}05`, validUntil: inDays(-2) })).body;
    r = await request("POST", `/api/shipments/${S}/spot-offer`, { offerId: expiredClassic.id }, token);
    assert("an expired classic quote attaches with a warning", r.status === 200 && /expired/.test(r.body?.warning || ""), JSON.stringify(r.body).slice(0, 200));

    console.log("\nAn offer freed by its quote");
    const Q2 = (await request("POST", "/api/quotes", { customerId: shipper.id, customerName: shipper.companyName, pol: "NLRTM", pod: "USNYC",
      commodityCode: "9999", validUntil: inDays(10), lines: [{ serviceCode: "OF", containerType: "40HC", quantity: 2, rate: 3000 }] }, token)).body;
    cleanup.quotes.push(Q2.id);
    await request("POST", `/api/quotes/${Q2.id}/spot-offer`, { offerId: B.id }, token);
    r = await request("POST", `/api/shipments/${await newShipment()}/spot-offer`, { offerId: B.id }, token);
    assert("an offer on another quote can't go on a shipment (409)", r.status === 409 && /quote/.test(r.body?.error), JSON.stringify(r.body));
    await request("DELETE", `/api/quotes/${Q2.id}`, null, token);
    cleanup.quotes = cleanup.quotes.filter(id => id !== Q2.id);
    const bFree = (await request("GET", `/api/spot-offers/${B.id}`, null, token)).body;
    assert("deleting the quote frees its offer", bFree.status === "Offered" && bFree.quoteId === "");
    assert("an unattached offer can be deleted", (await request("DELETE", `/api/spot-offers/${B.id}`, null, token)).status === 200);
    cleanup.offers = cleanup.offers.filter(id => id !== B.id);
  } catch (e) {
    console.error("Unexpected error:", e);
    failed++;
  } finally {
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    for (const id of cleanup.quotes) await request("DELETE", `/api/quotes/${id}`, null, token).catch(() => {});
    // Offers left on a deleted shipment are freed by detaching first; booked ones stay as the carrier's record.
    for (const id of cleanup.offers) await request("DELETE", `/api/spot-offers/${id}`, null, token).catch(() => {});
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
    const users = list((await request("GET", "/api/users", null, token)).body);
    for (const email of cleanup.users) { const u = users.find(x => x.email === email); if (u) await request("DELETE", `/api/users/${u.id}`, null, token).catch(() => {}); }
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
