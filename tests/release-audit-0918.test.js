/**
 * The 0.91.18 pre-release audit's fixes (2026-11-24, epic TKT-T3QZ6Z, ARCHITECTURE.md §8.58, TC-117). The user: "Audit
 * first", then for A "Follow the Incoterm" and for B–E "Fix all before release".
 *   A TKT-TY4AOH  Freight Terms follows the Incoterm until someone picks it (E/F terms Collect, C/D Prepaid), on shipments
 *                 and quotes; one picked by hand stays; saved payment terms keep their own sync;
 *   B TKT-FXZUWR  a booking request refused before it goes (here: dangerous goods without a UN number) saves no payment
 *                 terms and splits nothing;
 *   C TKT-W29BNX  a Completed shipment answers canEdit false for its payment terms and its transport document;
 *   D TKT-UKAFDT  Freight Terms takes only Prepaid, Collect or Payable at Destination (case and spacing ignored).
 * E (the transport document card after the booking went) is screen text: TransportDocumentCard.test.jsx.
 *
 * Usage:
 *   node tests/release-audit-0918.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, not in production (the built-in DCSA carrier plays MAEU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ method, hostname: "localhost", port: 3001, path, headers: {
      "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }),
      ...(payload && { "Content-Length": Buffer.byteLength(payload) }) } }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  try {
    const login = await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" });
    const token = login.body?.token;
    if (!token) throw new Error(`login failed: ${JSON.stringify(login.body)}`);
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const shipper = (await request("POST", "/api/customers", { companyName: `Van Dijk Keramiek ${rand} BV`, address1: "Waalhaven Oostzijde 12",
      postalCode: "3087 BM", city: "Rotterdam", countryIso2: "NL", phone: "+31 10 412 8870", email: `export.${rand.toLowerCase()}@vandijk-keramiek.example`,
      // A DG booking names the shipper's own 24-hour emergency contact (§8.44).
      dgEmergencyContact: { contact: "Van Dijk Keramiek safety desk", phone: "+31 10 412 8899", provider: "", referenceNumber: "" } }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Hudson Tile Distributors ${rand} Inc`, address1: "600 Meadowlands Pkwy",
      postalCode: "07094", city: "Secaucus", stateProvince: "NJ", countryIso2: "US", phone: "+1 201 555 0142" }, token)).body;
    if (!shipper?.id || !consignee?.id) throw new Error("scratch customers not created");
    const etd = day(12), eta = day(23);
    const base = { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractRef: "MAEU-SC-2026-NL-0318",
      etd, eta, commodityCode: "9999", serviceType: "Port-to-Port", shipperId: shipper.id, shipperName: shipper.companyName,
      consigneeId: consignee.id, consigneeName: consignee.companyName, emoOfficeId, imoOfficeId };
    const create = extra => request("POST", "/api/shipments", { ...base, ...extra }, token);
    const get = async id => (await request("GET", `/api/shipments/${id}`, null, token)).body;
    const freightOf = async id => (await request("GET", `/api/shipments/${id}/payment-terms`, null, token)).body?.categories?.find(c => c.id === "freight")?.term;

    console.log("\nA: Freight Terms follows the Incoterm until someone picks it");
    const fob = await create({ incoterm: "FOB" });
    assert("a new FOB shipment with no Freight Terms sent gets Collect (the buyer pays the main carriage)", fob.status === 201 && fob.body.freightTerms === "Collect",
      JSON.stringify(fob.body).slice(0, 200));
    assert("…so its ocean freight is Collect before the payment terms are saved", (await freightOf(fob.body.id)) === "COL");
    const cif = await create({ incoterm: "CIF" });
    assert("a new CIF shipment gets Prepaid", cif.body?.freightTerms === "Prepaid", cif.body?.freightTerms);
    const exw = await create({ incoterm: "EXW" });
    assert("EXW gets Collect", exw.body?.freightTerms === "Collect", exw.body?.freightTerms);
    const none = await create({ incoterm: "" });
    assert("no incoterm gets Prepaid", none.body?.freightTerms === "Prepaid", none.body?.freightTerms);

    // The Conditions page sends the whole record back: the untouched Freight Terms comes back unchanged.
    let s = await get(fob.body.id);
    let r = await request("PUT", `/api/shipments/${s.id}`, { ...s, incoterm: "CIF" }, token);
    assert("FOB → CIF with Freight Terms sent back unchanged: it follows to Prepaid", r.status === 200 && (await get(s.id)).freightTerms === "Prepaid", JSON.stringify(r.body).slice(0, 200));
    r = await request("PUT", `/api/shipments/${s.id}`, { incoterm: "FCA" }, token);
    assert("…and CIF → FCA with Freight Terms not sent: back to Collect", r.status === 200 && (await get(s.id)).freightTerms === "Collect");

    const picked = await create({ incoterm: "CIF", freightTerms: "Collect" });
    assert("a Freight Terms picked by hand is kept on create (CIF, Collect)", picked.body?.freightTerms === "Collect", picked.body?.freightTerms);
    s = await get(picked.body.id);
    await request("PUT", `/api/shipments/${s.id}`, { ...s, incoterm: "DAP" }, token);
    assert("…and stays when the incoterm changes (CIF → DAP: still Collect)", (await get(s.id)).freightTerms === "Collect");
    const pad = await create({ incoterm: "FOB", freightTerms: "Payable at Destination" });
    s = await get(pad.body.id);
    await request("PUT", `/api/shipments/${s.id}`, { ...s, incoterm: "CFR" }, token);
    assert("Payable at Destination is never implied, so it never moves (FOB → CFR)", (await get(s.id)).freightTerms === "Payable at Destination");

    // Saved payment terms that follow the Incoterm move Freight Terms themselves (§8.52): unchanged by this fix.
    const saved = await create({ incoterm: "FOB" });
    const reset = await request("PUT", `/api/shipments/${saved.body.id}/payment-terms`, { reset: true }, token);
    s = await get(saved.body.id);
    await request("PUT", `/api/shipments/${s.id}`, { ...s, incoterm: "CIF" }, token);
    const after = await get(s.id);
    assert("saved terms following the Incoterm: FOB → CIF moves the freight to Prepaid and Freight Terms with it",
      reset.status === 200 && after.freightTerms === "Prepaid" && (await freightOf(s.id)) === "PRE", `${reset.status} ${after.freightTerms} ${await freightOf(s.id)}`);

    const q = await request("POST", "/api/quotes", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", incoterm: "FOB", customerId: consignee.id,
      customerName: consignee.companyName, validUntil: day(30), lines: [{ serviceCode: "OF", description: "Ocean freight, 40' high cube, NLRTM → USNYC", containerType: "40HC", quantity: 2, unit: "per_container", rate: 2150, currency: "USD" }] }, token);
    assert("a new FOB quote with no Freight Terms gets Collect", q.status === 201 && q.body?.freightTerms === "Collect", JSON.stringify(q.body).slice(0, 200));
    const qb = q.body || {};
    r = await request("PUT", `/api/quotes/${qb.id}`, { ...qb, incoterm: "CIF" }, token);
    assert("…FOB → CIF with Freight Terms sent back unchanged: Prepaid", r.status === 200 && r.body?.freightTerms === "Prepaid", JSON.stringify(r.body).slice(0, 200));

    console.log("\nD: Freight Terms takes only the three values");
    r = await create({ incoterm: "FOB", freightTerms: "Freight Collect" });
    assert("\"Freight Collect\" is refused on create (400), naming the three values", r.status === 400 && /Prepaid, Collect or Payable at Destination/.test(r.body?.error || ""), JSON.stringify(r.body));
    r = await create({ incoterm: "CIF", freightTerms: "  payable  at DESTINATION " });
    assert("spelling is normalised: \"  payable  at DESTINATION \" → Payable at Destination", r.status === 201 && r.body?.freightTerms === "Payable at Destination", r.body?.freightTerms);
    r = await request("PUT", `/api/shipments/${cif.body.id}`, { freightTerms: "Third party" }, token);
    assert("a change to an off-list value is refused (400)", r.status === 400, JSON.stringify(r.body));
    r = await request("POST", "/api/quotes", { pol: "NLRTM", pod: "USNYC", incoterm: "FOB", freightTerms: "Freight Collect", validUntil: day(30), lines: [] }, token);
    assert("…and on a quote (400)", r.status === 400, JSON.stringify(r.body));

    console.log("\nB: a booking request refused before it goes saves no payment terms");
    const dg = await create({ incoterm: "FOB" });
    const dgId = dg.body.id;
    await request("POST", "/api/containers", { shipmentId: dgId, containerNumber: `MSKU${String(Date.now()).slice(-7)}`, size: "40", type: "HC",
      hsCode: "690721", cargoDescription: "Glazed ceramic floor tiles", grossWeightKg: 21800, numberOfPackages: 22, packageCode: "PL" }, token);
    await request("POST", "/api/containers", { shipmentId: dgId, containerNumber: `MSKU${String(Date.now() + 1).slice(-7)}`, size: "20", type: "DV",
      hsCode: "320810", cargoDescription: "Paint, flammable", grossWeightKg: 14200, numberOfPackages: 40, packageCode: "DR", isDg: true, dgClass: "3" }, token);
    const legs = await request("PUT", `/api/shipments/${dgId}/legs`, { legs: [{ legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd, eta,
      carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", vesselImo: "9333022", voyage: `${rand.slice(0, 3)}E` }] }, token);
    if (legs.status !== 200) throw new Error(`route refused: ${JSON.stringify(legs.body).slice(0, 200)}`);
    const refused = await request("POST", `/api/shipments/${dgId}/edi-messages/booking-request`, {}, token);
    assert("the send is refused: the dangerous goods aren't declared (400)", refused.status === 400 && /dangerous goods/.test(refused.body?.error || ""), JSON.stringify(refused.body).slice(0, 200));
    const termsAfter = (await request("GET", `/api/shipments/${dgId}/payment-terms`, null, token)).body;
    assert("…and the payment terms are still not saved (nothing split)", termsAfter?.saved === false, JSON.stringify(termsAfter).slice(0, 160));
    const history = (await request("GET", `/api/shipments/${dgId}/events?limit=50`, null, token)).body?.results || [];
    assert("…nor does History say the booking went", !history.some(e => (e.eventType || e.event_type) === "PAYMENT_TERMS_SET"),
      JSON.stringify(history.map(e => e.eventType || e.event_type)));
    const ctrs = (await request("GET", `/api/containers?shipmentId=${dgId}`, null, token)).body || [];
    const dgCtr = (Array.isArray(ctrs) ? ctrs : ctrs.results || []).find(c => c.isDg);
    const fixedDg = dgCtr && await request("PUT", `/api/shipments/${dgId}/containers/${dgCtr.id}`, { ...dgCtr, dgUnNumber: "1263", dgProperShippingName: "PAINT" }, token);
    const sent = await request("POST", `/api/shipments/${dgId}/edi-messages/booking-request`, {}, token);
    const termsSent = (await request("GET", `/api/shipments/${dgId}/payment-terms`, null, token)).body;
    assert("once the request can go, the send saves them (as shown: the FOB defaults, freight Collect)",
      fixedDg?.status === 200 && sent.status === 201 && termsSent?.saved === true && termsSent.categories?.find(c => c.id === "freight")?.term === "COL",
      `${fixedDg?.status} ${sent.status} ${JSON.stringify(sent.body?.error || "")} saved=${termsSent?.saved}`);

    console.log("\nC: a Completed shipment's cards say they can't be changed");
    const done = await create({ incoterm: "FOB" });
    const closed = await request("PUT", `/api/shipments/${done.body.id}`, { status: "Completed" }, token);
    const pt = (await request("GET", `/api/shipments/${done.body.id}/payment-terms`, null, token)).body;
    const td = (await request("GET", `/api/shipments/${done.body.id}/booking-request-options`, null, token)).body;
    assert("payment terms: canEdit false", closed.status === 200 && pt?.canEdit === false, `${closed.status} ${pt?.canEdit}`);
    assert("transport document and loading: canEdit false", td?.canEdit === false, String(td?.canEdit));
    const open = (await request("GET", `/api/shipments/${fob.body.id}/booking-request-options`, null, token)).body;
    assert("…while an Active one's are still editable for an admin", open?.canEdit === true, String(open?.canEdit));
  } catch (e) {
    console.error("  ✗ error —", e.message);
    failed++;
  }
  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
