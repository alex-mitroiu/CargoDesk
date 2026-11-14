/**
 * The office split (2026-11-14, lib/payment-terms.js + lib/office-split.js, ARCHITECTURE.md §8.52; the user's decisions,
 * mockup 1cb7bdf6 v2):
 *   - the Carrier Booking's payment terms (CPI) per charge category, defaulted from the Incoterm, each with a responsible
 *     office; the OCC/BK of the export side (admins, operators) changes them; History records it; Freight Terms follows
 *     the ocean freight's term;
 *   - every cost and charge line takes its category's office (a line can name another), a SELL line is billed to the
 *     party its term names (FOB: origin charges to the shipper, the rest to the buyer through the principal);
 *   - the shipment's billing office (copied from its export office's) issues every invoice; a billing document holds one
 *     issuing legal entity and one billed party, and records both;
 *   - VAT Liability counts a charge for the entity that issued it;
 *   - the booking request carries the terms (DCSA freight, origin and destination payment terms, invoicePayableAt) and
 *     switches the split on for a shipment whose terms were never saved.
 *
 * Usage: node tests/office-split.test.js
 * Prerequisites: Express server on :3001 (+ the demo carrier, any non-production server), pdf-render on :3003;
 * admin claudeagent@localhost / TestFixture!2026Zq.
 */

import { addContainer, waitForCarrierReference } from "./helpers/dcsa-sim.mjs";
import { retireOffice, retireBranch } from "./helpers/offices.mjs";

const BASE = "http://localhost:3001";
let passed = 0, failed = 0;
async function request(method, path, body, token) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body !== undefined && body !== null && { body: JSON.stringify(body) }) });
  let parsed = null; try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
}
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
const letters = () => Array.from({ length: 2 }, () => "ABCDEFGHJKLMNPRSTUVWXYZ"[Math.floor(Math.random() * 23)]).join("");
const list = b => (Array.isArray(b) ? b : (b?.results ?? []));
const today = new Date().toISOString().slice(0, 10);
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const cleanup = { offices: [], branches: [], users: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;

    // Two legal entities (Dutch and American), the export and import offices, and an Amsterdam billing office.
    const branch = async (cc, name, currency, vat, rate) => {
      const r = await request("POST", "/api/branches", { code: `OS${rand}${cc}`, name, countryCode: cc, currency, taxRegistrationNumber: vat, standardVatRate: rate }, token);
      if (![200, 201].includes(r.status)) throw new Error(`branch ${cc}: ${r.status} ${JSON.stringify(r.body)}`);
      cleanup.branches.push(r.body.id);
      return r.body;
    };
    const nl = await branch("NL", `Rotterdam Forwarding ${rand} BV`, "EUR", `NL8${String(Date.now()).slice(-8)}B01`, 21);
    const us = await branch("US", `New York Forwarding ${rand} Inc`, "USD", "", null);
    const office = async (unlocode, department, name, branchId) => {
      const r = await request("POST", "/api/offices", { unlocode, department, name, branchId }, token);
      if (r.status !== 201) throw new Error(`office ${unlocode} ${department}: ${r.status} ${JSON.stringify(r.body)}`);
      cleanup.offices.push(r.body.id);
      return r.body;
    };
    const exportOffice = await office(`NL${letters()}Q`, "SE", `Rotterdam Export ${rand}`, nl.id);
    const importOffice = await office(`US${letters()}Q`, "SI", `New York Import ${rand}`, us.id);
    const billingOffice = await office(`NL${letters()}Q`, "SE", `Amsterdam Billing ${rand}`, nl.id);
    let r = await request("PUT", `/api/offices/${exportOffice.id}`, { billingOfficeId: billingOffice.id }, token);
    assert("an office names the office that issues its invoices", r.status === 200 && r.body.billingOfficeId === billingOffice.id, JSON.stringify(r.body).slice(0, 160));
    assert("…but not itself (400)", (await request("PUT", `/api/offices/${billingOffice.id}`, { billingOfficeId: billingOffice.id }, token)).status === 400);

    const customer = async (companyName, address1, postalCode, city, countryIso2, currency) =>
      (await request("POST", "/api/customers", { companyName, address1, postalCode, city, countryIso2, currency }, token)).body;
    const shipper = await customer(`Van Leeuwen Meubelen ${rand} BV`, "Waalhaven Oostzijde 81", "3087 BM", "Rotterdam", "NL", "EUR");
    const consignee = await customer(`Hudson Home Imports ${rand} Inc`, "250 Port Jersey Blvd", "07305", "Jersey City", "US", "USD");
    const newShipment = async (incoterm, extra = {}) => {
      const s = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", contractRef: `SPOT-OS-${rand}`,
        etd: inDays(12), eta: inDays(24), cargoReadyDate: inDays(9), incoterm, commodityCode: "9999", freightTerms: "Prepaid",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        notifyId: consignee.id, notifyName: consignee.companyName, emoOfficeId: exportOffice.id, imoOfficeId: importOffice.id, ...extra }, token);
      if (s.status !== 201) throw new Error(`shipment: ${s.status} ${JSON.stringify(s.body)}`);
      return s.body;
    };

    console.log("\nA new FOB shipment: its billing office, the Incoterm's defaults");
    const A = await newShipment("FOB");
    assert("it takes its export office's billing office", A.billingOfficeId === billingOffice.id, A.billingOfficeId);
    let terms = (await request("GET", `/api/shipments/${A.id}/payment-terms`, null, token)).body;
    const cat = id => terms.categories.find(c => c.id === id);
    assert("not saved yet: the Incoterm's defaults are shown", terms.saved === false && terms.canEdit === true && cat("freight").term === "COL"
      && cat("originPort").term === "PRE" && cat("destinationPort").term === "COL", JSON.stringify(terms.categories.map(c => [c.id, c.term, c.office])));
    assert("…origin charges billed to the shipper, the freight to the principal (the consignee)", cat("originPort").billTo.customerId === shipper.id
      && cat("freight").billTo.customerId === consignee.id && cat("freight").billTo.role === "Principal", JSON.stringify([cat("originPort").billTo, cat("freight").billTo]));
    assert("…the offices to choose from: export, import, billing", terms.offices.map(o => o.key).join(",") === "export,import,billing"
      && terms.offices.find(o => o.key === "billing")?.code === billingOffice.code, JSON.stringify(terms.offices));

    console.log("\nWho may change them");
    const viewerEmail = `os.viewer.${rand.toLowerCase()}@cargodesk.example`;
    const viewer = await request("POST", "/api/users", { email: viewerEmail, name: "Split viewer", roles: ["viewer"], password: "SplitFixture!2026Zq" }, token);
    cleanup.users.push(viewer.body?.id);
    const viewerToken = (await request("POST", "/api/auth/login", { email: viewerEmail, password: "SplitFixture!2026Zq" })).body?.token;
    assert("a viewer can't (403)", (await request("PUT", `/api/shipments/${A.id}/payment-terms`, { reset: true }, viewerToken)).status === 403);
    assert("an office the shipment doesn't have is refused (400)",
      (await request("PUT", `/api/shipments/${A.id}/payment-terms`, { categories: { freight: { term: "COL", office: "office:OFF-NOPE" } } }, token)).status === 400);

    console.log("\nThe lines follow their category");
    const line = async (type, chargeCode, currency, amount) => (await request("POST", `/api/shipments/${A.id}/cost-lines`,
      { type, chargeCode, currency, amount, exchangeRate: currency === "EUR" ? 1.08 : 1, paymentIndicator: "Prepaid" }, token)).body;
    const othc = await line("SELL", "Origin THC", "EUR", 245);
    const blFee = await line("SELL", "B/L Fee", "EUR", 75);
    const ofr = await line("SELL", "Ocean Freight", "USD", 2450);
    const dthc = await line("SELL", "Destination THC", "USD", 380);
    const delivery = await line("SELL", "Haulage", "USD", 650);
    const ofrBuy = await line("BUY", "Ocean Freight", "USD", 1900);
    r = await request("PUT", `/api/shipments/${A.id}/payment-terms`, { lines: { [delivery.id]: { chargeSide: "Destination" } } }, token);
    assert("saved: the delivery haulage set to the destination side", r.status === 200 && r.body.saved === true && r.body.followsIncoterm === true, JSON.stringify(r.body).slice(0, 200));
    const lines = list((await request("GET", `/api/shipments/${A.id}/cost-lines`, null, token)).body);
    const sp = id => lines.find(l => l.id === id)?.split;
    assert("Origin THC: origin port charges, the export office, issued by the billing office, billed to the shipper",
      sp(othc.id)?.category === "originPort" && sp(othc.id).officeId === exportOffice.id && sp(othc.id).issuerOfficeId === billingOffice.id
        && sp(othc.id).billTo.customerId === shipper.id, JSON.stringify(sp(othc.id)));
    assert("Ocean Freight: Collect, the import office, billed to the principal", sp(ofr.id)?.term === "COL" && sp(ofr.id).officeId === importOffice.id
      && sp(ofr.id).billTo.customerId === consignee.id, JSON.stringify(sp(ofr.id)));
    assert("the delivery: destination haulage, the import office", sp(delivery.id)?.category === "destinationHaulage" && sp(delivery.id).officeId === importOffice.id,
      JSON.stringify(sp(delivery.id)));
    assert("a cost is its office's: the carrier's freight, the import office", sp(ofrBuy.id)?.officeId === importOffice.id, JSON.stringify(sp(ofrBuy.id)));
    const shipA = (await request("GET", `/api/shipments/${A.id}`, null, token)).body;
    assert("Freight Terms follows the freight's term (Collect)", shipA.freightTerms === "Collect", shipA.freightTerms);
    let hist = list((await request("GET", `/api/shipments/${A.id}/events?limit=200`, null, token)).body);
    assert("History: the terms set and the line's side", hist.some(e => e.eventType === "PAYMENT_TERMS_SET") && hist.some(e => e.eventType === "COST_LINE_OFFICE_CHANGED"),
      JSON.stringify(hist.slice(0, 5).map(e => e.eventType)));

    console.log("\nEach line's Prepaid/Collect follows its category's term");
    const mark = id => lines.find(l => l.id === id)?.paymentIndicator;
    assert("saving the terms set the marks: freight, destination THC and the delivery Collect (charge and cost), origin THC Prepaid",
      mark(ofr.id) === "Collect" && mark(dthc.id) === "Collect" && mark(delivery.id) === "Collect" && mark(ofrBuy.id) === "Collect" && mark(othc.id) === "Prepaid",
      JSON.stringify(lines.map(l => [l.type, l.chargeCode, l.paymentIndicator])));
    const probe = await line("SELL", "Destination THC", "USD", 12);
    assert("a new line takes its category's term, whatever was sent (Prepaid sent, Collect kept)", probe.paymentIndicator === "Collect", probe.paymentIndicator);
    r = await request("PUT", `/api/shipments/${A.id}/cost-lines/${probe.id}`, { type: "SELL", chargeCode: "Origin THC", currency: "USD", amount: 12, paymentIndicator: "Collect" }, token);
    assert("…and an edit too (moved to Origin THC with Collect sent: Prepaid)", r.status === 200 && r.body.paymentIndicator === "Prepaid", JSON.stringify(r.body?.paymentIndicator));
    await request("DELETE", `/api/shipments/${A.id}/cost-lines/${probe.id}`, null, token);

    console.log("\nA cost's office travels with its adjustment");
    r = await request("PUT", `/api/shipments/${A.id}/payment-terms`, { lines: { [ofrBuy.id]: { responsibleOffice: "billing" } } }, token);
    await request("PATCH", `/api/shipments/${A.id}/cost-lines/${ofrBuy.id}/actualize`, { actualAmount: 1900, actualExchangeRate: 1 }, token);
    await request("PATCH", `/api/shipments/${A.id}/cost-lines/${ofrBuy.id}/post`, {}, token);
    const adj = await request("POST", `/api/shipments/${A.id}/cost-lines/${ofrBuy.id}/adjust`, { amount: 85, note: "Carrier's bunker surcharge correction" }, token);
    const adjLine = list((await request("GET", `/api/shipments/${A.id}/cost-lines`, null, token)).body).find(l => l.adjustsCostLineId === ofrBuy.id);
    assert("the carrier's freight moved to the billing office; its adjustment stays there", r.status === 200 && adj.status < 300
      && adjLine?.responsibleOffice === "billing" && adjLine.split?.officeId === billingOffice.id, JSON.stringify({ adj: adj.status, line: adjLine?.split }));

    console.log("\nOne issuing entity and one billed party per invoice");
    const generate = (ids, name) => request("POST", `/api/shipments/${A.id}/documents/generate`,
      { html: `<html><body><h1>${name}</h1></body></html>`, filename: `FR01-${A.id}-${name}.pdf`, docType: "FR01", responsibleParty: "whoever", sourceCostLineIds: ids }, token);
    r = await generate([othc.id, ofr.id], "mixed");
    assert("charges billed to two parties on one invoice: refused (409)", r.status === 409 && /different parties/.test(r.body?.error || ""), JSON.stringify(r.body));
    const toShipper = await generate([othc.id, blFee.id], "shipper");
    assert("the origin charges: the billing office issues them to the shipper", toShipper.status === 201 && toShipper.body.issuingOfficeId === billingOffice.id
      && toShipper.body.billToCustomerId === shipper.id && toShipper.body.responsibleParty === shipper.companyName, JSON.stringify(toShipper.body).slice(0, 300));
    r = await request("PATCH", `/api/shipments/${A.id}/documents/${toShipper.body.id}`, { status: "confirmed" }, token);
    assert("…confirmed while its charges still go there", r.status === 200, JSON.stringify(r.body).slice(0, 200));
    const toBuyer = await generate([ofr.id, dthc.id, delivery.id], "buyer");
    assert("the rest: the billing office issues them to the principal", toBuyer.status === 201 && toBuyer.body.issuingOfficeId === billingOffice.id
      && toBuyer.body.billToCustomerId === consignee.id, JSON.stringify(toBuyer.body).slice(0, 300));

    console.log("\nWithout a billing office, each responsible office issues its own");
    r = await request("PUT", `/api/shipments/${A.id}`, { ...shipA, billingOfficeId: null }, token);
    assert("the OCC/BK (here an admin) takes the billing office off", r.status === 200 && r.body.billingOfficeId === null, JSON.stringify(r.body?.billingOfficeId));
    const customs = await line("SELL", "Customs", "USD", 185);
    const docFee = await line("SELL", "Other", "EUR", 40);
    r = await request("PUT", `/api/shipments/${A.id}/payment-terms`, {
      categories: { originOther: { term: "COL", office: "export" } }, lines: { [customs.id]: { chargeSide: "Destination" } } }, token);
    assert("other origin charges switched to Collect, kept with the export office", r.status === 200 && r.body.followsIncoterm === false
      && r.body.categories.find(c => c.id === "originOther").term === "COL", JSON.stringify(r.body?.categories?.find(c => c.id === "originOther")));
    r = await generate([docFee.id, customs.id], "two-entities");
    assert("one buyer, two issuing entities (Dutch export office, American import office): refused (409)", r.status === 409 && /different legal entities/.test(r.body?.error || ""),
      JSON.stringify(r.body));
    const nyc = await generate([customs.id], "nyc");
    assert("the import office issues its own", nyc.status === 201 && nyc.body.issuingOfficeId === importOffice.id, JSON.stringify(nyc.body).slice(0, 200));
    hist = list((await request("GET", `/api/shipments/${A.id}/events?limit=200`, null, token)).body);
    assert("History: the term change, the billing office taken off", hist.some(e => e.eventType === "PAYMENT_TERMS_CHANGED" && e.field === "originOther")
      && hist.some(e => e.eventType === "OFFICE_REASSIGNED" && e.field === "billingOfficeId"), JSON.stringify(hist.slice(0, 6).map(e => [e.eventType, e.field])));

    console.log("\nA draft whose charges now go elsewhere isn't confirmed (audit S2)");
    r = await request("PATCH", `/api/shipments/${A.id}/documents/${toBuyer.body.id}`, { status: "confirmed" }, token);
    assert("the buyer's draft, made while the billing office issued it, is refused now that it's gone (409)",
      r.status === 409 && /changed since this draft was made/.test(r.body?.error || ""), JSON.stringify(r.body));

    console.log("\nVAT Liability: a charge counts for the entity that issued it");
    await request("PATCH", `/api/shipments/${A.id}/documents/${nyc.body.id}`, { status: "confirmed" }, token);
    const vat = (await request("GET", `/api/vat-liability/summary?dateFrom=${today}&dateTo=${today}`, null, token)).body;
    const ent = id => (vat?.entities || vat?.byEntity || []).find(e => e.entityId === id);
    const nlBase = ent(nl.id)?.output?.standard?.baseUsd ?? ent(nl.id)?.output?.zero_rated?.baseUsd;
    assert("the Dutch entity holds the origin charges the billing office issued", !!ent(nl.id) && nlBase > 0, JSON.stringify(ent(nl.id)).slice(0, 300));
    assert("…the American entity the customs charge its import office issued", !!ent(us.id), JSON.stringify((vat?.entities || vat?.byEntity || []).map(e => e.entityName)));

    console.log("\nWhat is issued keeps its Prepaid/Collect");
    r = await request("PUT", `/api/shipments/${A.id}/payment-terms`, { categories: { originPort: { term: "COL", office: "export" } } }, token);
    let marked = list((await request("GET", `/api/shipments/${A.id}/cost-lines`, null, token)).body);
    assert("origin port charges switched to Collect: the Origin THC on the shipper's confirmed invoice stays Prepaid",
      r.status === 200 && marked.find(l => l.id === othc.id)?.paymentIndicator === "Prepaid", JSON.stringify(marked.find(l => l.id === othc.id)));
    const lateThc = await line("SELL", "Origin THC", "EUR", 30);
    assert("…a later Origin THC is Collect", lateThc.paymentIndicator === "Collect", lateThc.paymentIndicator);
    r = await request("PUT", `/api/shipments/${A.id}/payment-terms`, { lines: { [othc.id]: { responsibleOffice: "import" } } }, token);
    assert("an issued charge keeps its office (409, audit S4)", r.status === 409 && /already issued/.test(r.body?.error || ""), JSON.stringify(r.body));
    r = await request("PUT", `/api/shipments/${A.id}/payment-terms`, { lines: { [ofrBuy.id]: { responsibleOffice: "export" } } }, token);
    assert("…so does a posted cost (409)", r.status === 409 && /is posted/.test(r.body?.error || ""), JSON.stringify(r.body));

    console.log("\nA credit note goes from the invoice's office to the party it billed, whatever the terms say now (audit S1)");
    const rev = await request("POST", `/api/shipments/${A.id}/documents/${toShipper.body.id}/reverse`, { reason: "Wrong container weight on the invoice" }, token);
    const cn = await request("POST", `/api/shipments/${A.id}/documents/generate`, { html: "<html><body><h1>CN</h1></body></html>",
      filename: `CN01-${A.id}-shipper.pdf`, docType: "CN01", responsibleParty: toShipper.body.responsibleParty,
      sourceCostLineIds: (rev.body?.reversalLines || []).map(l => l.id), relatedDocId: toShipper.body.id }, token);
    assert("the terms and the billing office changed since, yet the credit note is issued by the billing office to the shipper",
      rev.status === 200 && cn.status === 201 && cn.body.issuingOfficeId === billingOffice.id && cn.body.billToCustomerId === shipper.id,
      JSON.stringify({ rev: rev.status, cn: cn.status, issuer: cn.body?.issuingOfficeId, billTo: cn.body?.billToCustomerId, error: cn.body?.error }));
    await request("PATCH", `/api/shipments/${A.id}/documents/${cn.body.id}`, { status: "confirmed", relatedDocId: toShipper.body.id }, token);
    await request("PATCH", `/api/shipments/${A.id}/documents/${toShipper.body.id}`, { relatedDocId: cn.body.id }, token);

    console.log("\nBefore the split the marks are as entered; an adjustment keeps its line's; the Incoterm moves them");
    const C = await newShipment("FOB");
    const lineC = async (type, chargeCode, amount, paymentIndicator) => (await request("POST", `/api/shipments/${C.id}/cost-lines`,
      { type, chargeCode, currency: "USD", amount, exchangeRate: 1, paymentIndicator }, token)).body;
    const dthcBuy = await lineC("BUY", "Destination THC", 340, "Collect");
    const othcSell = await lineC("SELL", "Origin THC", 260, "Collect");
    assert("not split: Collect as entered on both", dthcBuy.paymentIndicator === "Collect" && othcSell.paymentIndicator === "Collect",
      JSON.stringify([dthcBuy.paymentIndicator, othcSell.paymentIndicator]));
    await request("PATCH", `/api/shipments/${C.id}/cost-lines/${dthcBuy.id}/actualize`, { actualAmount: 340, actualExchangeRate: 1 }, token);
    await request("PATCH", `/api/shipments/${C.id}/cost-lines/${dthcBuy.id}/post`, {}, token);
    const adjC = await request("POST", `/api/shipments/${C.id}/cost-lines/${dthcBuy.id}/adjust`, { amount: 25, note: "Terminal's late-gate fee" }, token);
    assert("the adjustment of a Collect cost is Collect", adjC.status === 201 && adjC.body.paymentIndicator === "Collect", JSON.stringify(adjC.body?.paymentIndicator));
    r = await request("PUT", `/api/shipments/${C.id}/payment-terms`, { reset: true }, token);
    let linesC = list((await request("GET", `/api/shipments/${C.id}/cost-lines`, null, token)).body);
    const markC = id => linesC.find(l => l.id === id)?.paymentIndicator;
    assert("split under FOB: the Origin THC charge becomes Prepaid; the destination THC cost and its adjustment stay Collect",
      r.status === 200 && markC(othcSell.id) === "Prepaid" && markC(dthcBuy.id) === "Collect" && markC(adjC.body.id) === "Collect",
      JSON.stringify(linesC.map(l => [l.type, l.chargeCode, l.paymentIndicator])));
    const shipC = (await request("GET", `/api/shipments/${C.id}`, null, token)).body;
    r = await request("PUT", `/api/shipments/${C.id}`, { ...shipC, incoterm: "DAP" }, token);
    linesC = list((await request("GET", `/api/shipments/${C.id}/cost-lines`, null, token)).body);
    assert("the Incoterm moves to DAP (terms follow it): destination THC and its adjustment become Prepaid",
      r.status === 200 && markC(dthcBuy.id) === "Prepaid" && markC(adjC.body.id) === "Prepaid", JSON.stringify(linesC.map(l => [l.type, l.chargeCode, l.paymentIndicator])));

    console.log("\nThe QA export carries the billing office and the offices that issued its documents (audit S3)");
    const qaOffices = async id => {
      const x = await request("POST", `/api/shipments/${id}/qa-export`, { whatWentWrong: "Office split check", steps: "Export a split shipment" }, token);
      return x.status === 200 ? (x.body?.references?.offices || []).map(o => ({ code: o.code, roles: o.roles })) : [{ status: x.status }];
    };
    const offsC = await qaOffices(C.id), offsA = await qaOffices(A.id);
    assert("a shipment's billing office is listed with the billing role", offsC.some(o => o.roles?.includes("billing") && o.code === billingOffice.code), JSON.stringify(offsC));
    assert("…and an office that issued its invoices, though no longer on the shipment", offsA.some(o => o.roles?.includes("issuing") && o.code === billingOffice.code), JSON.stringify(offsA));

    console.log("\nA deactivated billing office isn't copied onto new shipments (audit S5)");
    await request("PUT", `/api/offices/${billingOffice.id}`, { isActive: false }, token);
    const D = await newShipment("CIF");
    assert("its export office still names it, the new shipment has no billing office", D.billingOfficeId === null, D.billingOfficeId);

    console.log("\nThe booking request carries the terms");
    const B = await newShipment("CIF", { carrierCode: "MAEU" });
    await addContainer(request, token, B.id);
    await request("POST", `/api/shipments/${B.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
      etd: inDays(12), eta: inDays(24), carrierCode: "MAEU", vessel: "MAERSK SPLIT", vesselImo: "9999995", voyage: `OS${rand}W` }, token);
    assert("(before) its terms were never saved", (await request("GET", `/api/shipments/${B.id}/payment-terms`, null, token)).body?.saved === false);
    const sent = await request("POST", `/api/shipments/${B.id}/edi-messages/booking-request`, {}, token);
    await waitForCarrierReference(request, token, B.id).catch(() => null);
    const out = list((await request("GET", `/api/shipments/${B.id}/edi-messages`, null, token)).body).find(m => m.direction === "out" && /booking/i.test(m.messageType));
    let body = null; try { body = JSON.parse(out?.rawPayload || "null"); } catch { /* not JSON */ }
    assert("sent (the DCSA request validated)", sent.status < 300 && !!body, `${sent.status} ${JSON.stringify(sent.body).slice(0, 200)}`);
    assert("CIF: freight and origin charges Prepaid, destination charges Collect",
      body?.freightPaymentTermCode === "PRE" && body?.originChargesPaymentTerm?.portChargesPaymentTermCode === "PRE"
        && body?.destinationChargesPaymentTerm?.portChargesPaymentTermCode === "COL", JSON.stringify({ f: body?.freightPaymentTermCode, o: body?.originChargesPaymentTerm, d: body?.destinationChargesPaymentTerm }));
    assert("…the freight payable where its office is", body?.invoicePayableAt?.UNLocationCode === exportOffice.unlocode, JSON.stringify(body?.invoicePayableAt));
    assert("…and the shipment is split from now on", (await request("GET", `/api/shipments/${B.id}/payment-terms`, null, token)).body?.saved === true);
  } catch (e) {
    console.error("\nFatal:", e.stack || e.message);
    failed++;
  } finally {
    // The shipments and customers stay as verification data. Offices and legal entities decide other shipments'
    // offices (ensureOffices picks the first active one), so they go: deleted, or deactivated when shipments use them.
    for (const id of cleanup.users.filter(Boolean)) await request("DELETE", `/api/users/${id}`, null, token).catch(() => {});
    for (const id of cleanup.offices) await retireOffice(token, id).catch(() => {});
    for (const id of cleanup.branches) await retireBranch(token, id).catch(() => {});
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
