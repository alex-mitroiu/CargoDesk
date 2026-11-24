/**
 * The DCSA booking request sends what the carrier needs (2026-11-23, story TKT-JV1SF2, ARCHITECTURE.md §8.58, TC-114).
 *
 * The user's review of a real booking request (2026-11-18) found it sent the shipper and consignee as names only, "FAK" as
 * the goods, no reference of ours, and an account number only when one is set. Checked on the body logged as sent (valid
 * Booking 2.0, no field the spec doesn't define):
 *   - point 1: the shipper and the consignee carry their own customer profile on every booking (no door involved): the
 *     address, a contact (Operations first), the legal-entity codes (LEI under GLEIF) and the tax numbers (EORI, VAT, EIN)
 *     as taxLegalReferences; through an NVOCC the shipper is the NVOCC's own profile;
 *   - point 2: a FAK shipment tells the carrier what the goods are: the containers' cargo descriptions (each once), its HS
 *     codes; any other commodity goes by its description; the rated commodity stays FAK on the shipment;
 *   - point 3: our shipment number as the Customer's Reference (references, type CR);
 *   - point 4: no customer number of ours at the carrier for the export office's legal entity → the send says so (a
 *     warning, never a refusal).
 *
 * Usage:
 *   node tests/booking-request-parties.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, not in production (the built-in DCSA carrier plays MAEU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { createRequire } from "node:module";
import { ensureOffices } from "./helpers/offices.mjs";

const require = createRequire(import.meta.url);
const { validateOutbound, errorsText } = require("../lib/dcsa/validate.js");
const { dcsaPartyCodes } = require("../lib/dcsa/parties.js");

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
const parse = v => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

(async () => {
  let token;
  try {
    console.log("\nPure: a party's identifiers in DCSA terms (lib/dcsa/parties.js, shared with the House B/L)");
    const codes = dcsaPartyCodes([{ idType: "LEI", idCode: "724500VKKSH9QOLTFR81" }, { idType: "eori", idCode: "NL812345678" }, { idType: "VAT", idCode: "NL812345678B01", countryIso2: "NL" },
      { idType: "Tax ID", idCode: "99-1234567", countryIso2: "us" }, { idType: "WAVE", idCode: "did:wave:123" }, { idType: "VAT", idCode: "" }, { idType: "GST", idCode: "29ABCDE1234F1Z5" }], "NL");
    assert("LEI → GLEIF identifyingCode, a platform id under the platform", codes.identifyingCodes.length === 2
      && codes.identifyingCodes[0].codeListProvider === "GLEIF" && codes.identifyingCodes[0].codeListName === "LEI" && codes.identifyingCodes[1].codeListProvider === "WAVE",
      JSON.stringify(codes.identifyingCodes));
    assert("tax numbers → taxLegalReferences with a country (the customer's when the number has none); Tax ID as TIN; an empty code left out",
      JSON.stringify(codes.taxLegalReferences.map(t => `${t.type}:${t.countryCode}`)) === JSON.stringify(["EORI:NL", "VAT:NL", "TIN:US", "GST:NL"]), JSON.stringify(codes.taxLegalReferences));
    const noCountry = dcsaPartyCodes([{ idType: "VAT", idCode: "123" }], "");
    assert("…a tax number with no country at all is left out (DCSA requires the country)", noCountry.taxLegalReferences.length === 0);

    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const etd = day(14), eta = day(27);
    const customer = async (body, { contacts = [], ids = [] } = {}) => {
      const c = (await request("POST", "/api/customers", body, token)).body;
      if (!c?.id) throw new Error(`scratch customer not created: ${JSON.stringify(c)}`);
      for (const k of contacts) await request("POST", `/api/customers/${c.id}/contacts`, k, token);
      for (const i of ids) await request("POST", `/api/customers/${c.id}/identifiers`, i, token);
      return c;
    };
    // A tile exporter in Rotterdam with its LEI, EORI and VAT numbers; a New Jersey importer with its EIN; an NVOCC.
    const shipper = await customer({ companyName: `Rotterdam Tegelhandel ${rand} BV`, address1: "Waalhaven Oostzijde 12", postalCode: "3087 BM", city: "Rotterdam",
      countryIso2: "NL", phone: "+31 10 429 1100", email: "info@tegelhandel.example" }, {
      contacts: [{ name: "Pieter Jansen", email: "p.jansen@tegelhandel.example", department: "Sales", isPrimary: true },
                 { name: "Anouk de Vries", phone: "+31 6 1234 5678", email: "expeditie@tegelhandel.example", department: "Operations" }],
      ids: [{ idType: "LEI", idCode: "724500VKKSH9QOLTFR81" }, { idType: "EORI", idCode: "NL812345678", countryIso2: "NL" }, { idType: "VAT", idCode: "NL812345678B01", countryIso2: "NL", isPrimary: true }] });
    const consignee = await customer({ companyName: `Garden State Tile Supply ${rand} LLC`, address1: "1200 Harbor Blvd", postalCode: "07086", city: "Weehawken", state: "NJ",
      countryIso2: "US", phone: "+1 201 555 0188" }, { ids: [{ idType: "EIN", idCode: "22-3456789", countryIso2: "US" }] });
    const nvocc = await customer({ companyName: `Blue Anchor Lines ${rand} (NVOCC)`, address1: "Maasboulevard 100", postalCode: "3011 TX", city: "Rotterdam", countryIso2: "NL",
      phone: "+31 10 400 2200", isNvocc: true, fmcNumber: `0${String(Date.now()).slice(-5)}N` });

    const newShipment = async ({ commodityCode = "9999", cargo = ["Glazed ceramic floor tiles", "Ceramic wall tiles", "Glazed ceramic floor tiles"] } = {}) => {
      const s = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central",
        contractRef: "MAEU-SC-2026-NL-0318", etd, eta, incoterm: "FOB", freightTerms: "Collect", commodityCode, serviceType: "Port-to-Port",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: consignee.id, principalName: consignee.companyName, emoOfficeId, imoOfficeId }, token);
      if (!s.body?.id) throw new Error(`scratch shipment not created: ${JSON.stringify(s.body)}`);
      const id = s.body.id;
      for (const [n, desc] of cargo.entries()) await request("POST", "/api/containers", { shipmentId: id, containerNumber: `MSKU${String(Date.now()).slice(-6)}${n}`,
        size: "40", type: "HC", hsCode: n === 1 ? "690890" : "690721", cargoDescription: desc, grossWeightKg: 21800, numberOfPackages: 22, packageCode: "PL" }, token);
      const legs = await request("PUT", `/api/shipments/${id}/legs`, { legs: [{ legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd, eta,
        carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", vesselImo: "9333022", voyage: `${rand.slice(0, 3)}W` }] }, token);
      if (legs.status !== 200) throw new Error(`route refused: ${legs.status} ${JSON.stringify(legs.body).slice(0, 300)}`);
      return id;
    };
    const sendBooking = id => request("POST", `/api/shipments/${id}/edi-messages/booking-request`, {}, token);
    const sentBody = async id => {
      const msgs = (await request("GET", `/api/shipments/${id}/edi-messages`, null, token)).body || [];
      return parse(msgs.find(m => m.direction === "out" && /booking/i.test(m.messageType))?.rawPayload);
    };
    const specProblems = b => { if (!b) return "no body"; const v = validateOutbound("bkg", "post", "/v2/bookings", b); return v.ok ? "" : errorsText(v.errors, 6); };

    console.log("\nA FAK shipment of tiles, booked direct with the carrier");
    const A = await newShipment();
    const sentA = await sendBooking(A);
    assert("the booking request is sent (201)", sentA.status === 201, JSON.stringify(sentA.body).slice(0, 300));
    const a = await sentBody(A);
    assert("…valid DCSA Booking 2.0, with no field the spec doesn't define", specProblems(a) === "", specProblems(a));
    const sh = a?.documentParties?.shipper;
    assert("point 1: the shipper carries its address from its profile", sh?.partyName === shipper.companyName && sh?.address?.street === "Waalhaven Oostzijde 12"
      && sh.address.postCode === "3087 BM" && sh.address.city === "Rotterdam" && sh.address.countryCode === "NL", JSON.stringify(sh));
    assert("…its Operations contact (not the primary Sales one)", sh?.partyContactDetails?.[0]?.name === "Anouk de Vries" && sh.partyContactDetails[0].phone === "+31 6 1234 5678",
      JSON.stringify(sh?.partyContactDetails));
    assert("…its LEI as an identifyingCode (GLEIF)", sh?.identifyingCodes?.length === 1 && sh.identifyingCodes[0].codeListProvider === "GLEIF" && sh.identifyingCodes[0].partyCode === "724500VKKSH9QOLTFR81",
      JSON.stringify(sh?.identifyingCodes));
    assert("…its EORI and VAT numbers as taxLegalReferences (NL)", JSON.stringify((sh?.taxLegalReferences || []).map(t => `${t.type}:${t.countryCode}:${t.value}`).sort())
      === JSON.stringify(["EORI:NL:NL812345678", "VAT:NL:NL812345678B01"]), JSON.stringify(sh?.taxLegalReferences));
    const cn = a?.documentParties?.consignee;
    assert("the consignee carries its address and its EIN; with no contact person, the company's own phone", cn?.address?.city === "Weehawken" && cn.address.stateRegion === "NJ"
      && cn?.taxLegalReferences?.[0]?.type === "EIN" && cn.taxLegalReferences[0].countryCode === "US" && cn?.partyContactDetails?.[0]?.phone === "+1 201 555 0188",
      JSON.stringify(cn));
    const commodity = a?.requestedEquipments?.[0]?.commodities?.[0];
    assert("point 2: FAK goes as what the goods are: the containers' cargo descriptions, each once", commodity?.commodityType === "Glazed ceramic floor tiles; Ceramic wall tiles",
      JSON.stringify(commodity));
    assert("…with the HS codes", JSON.stringify([...(commodity?.HSCodes || [])].sort()) === JSON.stringify(["690721", "690890"]), JSON.stringify(commodity?.HSCodes));
    const shipmentAfter = (await request("GET", `/api/shipments/${A}`, null, token)).body;
    assert("…while the shipment stays rated as FAK", shipmentAfter?.commodityCode === "9999", shipmentAfter?.commodityCode);
    assert("point 3: our shipment number as the Customer's Reference (CR)", a?.references?.length === 1 && a.references[0].type === "CR" && a.references[0].value === A,
      JSON.stringify(a?.references));
    assert("point 4: no customer number of ours at MAEU for the booking agent → the send says so, and still sends",
      sentA.status === 201 && (sentA.body.bookingWarnings || []).some(w => /no customer number/.test(w) && /MAEU/.test(w)) && /customer number/.test(sentA.body.warning || ""),
      JSON.stringify({ w: sentA.body.bookingWarnings, warning: sentA.body.warning }));

    console.log("\nA named commodity, and a shipment through an NVOCC");
    const B = await newShipment({ commodityCode: "002001", cargo: ["Oak dining tables, flat-packed"] });
    const sentB = await sendBooking(B);
    const b = await sentBody(B);
    assert("a named commodity goes by its description (Furniture, nos), not the cargo description",
      sentB.status === 201 && b?.requestedEquipments?.[0]?.commodities?.[0]?.commodityType === "Furniture, nos", JSON.stringify(b?.requestedEquipments?.[0]?.commodities));
    const C = await newShipment();
    const party = await request("POST", `/api/shipments/${C}/parties`, { role: "NVOCC", customerId: nvocc.id, customerName: nvocc.companyName }, token);
    assert("an NVOCC is named on the shipment", party.status === 200 || party.status === 201, JSON.stringify(party.body).slice(0, 200));
    const sentC = await sendBooking(C);
    const c = await sentBody(C);
    assert("through an NVOCC, the booking's shipper is the NVOCC with its own address, not the cargo owner's", sentC.status === 201 && specProblems(c) === ""
      && c?.documentParties?.shipper?.partyName === nvocc.companyName && c.documentParties.shipper.address?.street === "Maasboulevard 100" && !c.documentParties.shipper.taxLegalReferences,
      JSON.stringify(c?.documentParties?.shipper));

    // ─── D1 (TKT-ML3GRC): before the payment terms are saved, the ocean freight follows Freight Terms ────────────────
    console.log("\nD1: FOB with Freight Terms Prepaid, payment terms not saved");
    const D = await newShipment();
    await request("PUT", `/api/shipments/${D}`, { freightTerms: "Prepaid" }, token);
    const viewD = (await request("GET", `/api/shipments/${D}/payment-terms`, null, token)).body;
    const freightD = viewD?.categories?.find(c => c.id === "freight");
    assert("the ocean freight shows Prepaid from Freight Terms (FOB alone would say Collect); the rest still FOB",
      viewD?.saved === false && viewD.freightFromFreightTerms === true && freightD?.term === "PRE"
        && viewD.categories.find(c => c.id === "destinationPort")?.term === "COL" && viewD.categories.find(c => c.id === "originPort")?.term === "PRE",
      JSON.stringify({ saved: viewD?.saved, fft: viewD?.freightFromFreightTerms, freight: freightD }));
    const sentD = await sendBooking(D);
    const d = await sentBody(D);
    const afterD = (await request("GET", `/api/shipments/${D}`, null, token)).body;
    assert("sending saves them as shown: Freight Terms stays Prepaid, the request says freight PRE, destination COL",
      sentD.status === 201 && afterD?.freightTerms === "Prepaid" && afterD?.paymentTerms?.followsIncoterm === false
        && d?.freightPaymentTermCode === "PRE" && d?.destinationChargesPaymentTerm?.portChargesPaymentTermCode === "COL",
      JSON.stringify({ ft: afterD?.freightTerms, pt: afterD?.paymentTerms, code: d?.freightPaymentTermCode }));
    const E = await newShipment();
    await request("PUT", `/api/shipments/${E}`, { freightTerms: "Collect" }, token);
    const sentE = await sendBooking(E);
    const afterE = (await request("GET", `/api/shipments/${E}`, null, token)).body;
    assert("…and Collect on an FOB shipment simply follows the Incoterm when saved (nothing set by hand)",
      sentE.status === 201 && afterE?.freightTerms === "Collect" && afterE?.paymentTerms?.followsIncoterm === true, JSON.stringify(afterE?.paymentTerms));

    // ─── Point 5: the transport document and loading ──────────────────────────────────────────────────────────────────
    console.log("\nPoint 5: the transport document and loading, sent only when stated");
    const F = await newShipment();
    const empty = (await request("GET", `/api/shipments/${F}/booking-request-options`, null, token)).body;
    assert("nothing stated on a new shipment, and nothing to send", empty?.canEdit === true && empty.options.transportDocumentType === ""
      && empty.options.partialLoad === null && Object.keys(empty.dcsa || {}).length === 0 && empty.portOfLoading === "NLRTM", JSON.stringify(empty));
    const bad = await request("PUT", `/api/shipments/${F}/booking-request-options`, { placeOfIssue: "ROTTERDAM" }, token);
    assert("a place of issue that is neither a UN/LOCODE nor a country is refused, saying so (400)", bad.status === 400 && /UN\/LOCODE/.test(bad.body?.error || ""), JSON.stringify(bad.body));
    const badRef = await request("PUT", `/api/shipments/${F}/booking-request-options`, { customsReferences: [{ type: "ACID", countryCode: "Egypt", values: ["1"] }] }, token);
    assert("a customs reference without a two-letter country is refused (400)", badRef.status === 400 && /country/.test(badRef.body?.error || ""), JSON.stringify(badRef.body));
    const set = await request("PUT", `/api/shipments/${F}/booking-request-options`, { transportDocumentType: "SWB", numberOfDocuments: 2, placeOfIssue: "nlrtm",
      partialLoad: false, customsReferences: [{ type: "ACID", countryCode: "eg", values: ["4471202611230001"] }] }, token);
    assert("saved: sea waybill, 2 B/Ls, issued at NLRTM, no partial loading, one customs reference", set.status === 200
      && JSON.stringify(set.body?.dcsa) === JSON.stringify({ transportDocumentTypeCode: "SWB", requestedNumberOfTransportDocuments: 2, placeOfBLIssue: { UNLocationCode: "NLRTM" },
        isPartialLoadAllowed: false, customsReferences: [{ type: "ACID", countryCode: "EG", values: ["4471202611230001"] }] }), JSON.stringify(set.body));
    const hist = (await request("GET", `/api/shipments/${F}/events?limit=50`, null, token)).body;
    const histRows = Array.isArray(hist) ? hist : hist?.results || [];
    assert("…logged in the shipment's History", histRows.some(e => e.field === "booking_request_options" || e.fieldName === "booking_request_options"),
      JSON.stringify(histRows.slice(0, 3)).slice(0, 300));
    const sentF = await sendBooking(F);
    const f = await sentBody(F);
    assert("the booking request carries them, valid DCSA Booking 2.0", sentF.status === 201 && specProblems(f) === "" && f?.transportDocumentTypeCode === "SWB"
      && f?.requestedNumberOfTransportDocuments === 2 && f?.placeOfBLIssue?.UNLocationCode === "NLRTM" && f?.isPartialLoadAllowed === false
      && f?.customsReferences?.[0]?.values?.[0] === "4471202611230001", JSON.stringify({ problems: specProblems(f), f: f && { t: f.transportDocumentTypeCode, p: f.placeOfBLIssue } }));
    assert("a booking with nothing stated sends none of them (A above)", !("transportDocumentTypeCode" in (a || {})) && !("isPartialLoadAllowed" in (a || {}))
      && !("placeOfBLIssue" in (a || {})) && !("customsReferences" in (a || {})) && !("requestedNumberOfTransportDocuments" in (a || {})));
    const cleared = await request("PUT", `/api/shipments/${F}/booking-request-options`, { transportDocumentType: "", numberOfDocuments: null, placeOfIssue: "", partialLoad: null, customsReferences: [] }, token);
    assert("clearing every field states nothing again", cleared.status === 200 && Object.keys(cleared.body?.dcsa || {}).length === 0, JSON.stringify(cleared.body));
    const country = await request("PUT", `/api/shipments/${F}/booking-request-options`, { placeOfIssue: "NL" }, token);
    assert("a country alone goes as placeOfBLIssue.countryCode", JSON.stringify(country.body?.dcsa) === JSON.stringify({ placeOfBLIssue: { countryCode: "NL" } }), JSON.stringify(country.body?.dcsa));
  } catch (e) {
    console.error("  ✗ Unexpected error:", e.stack || e.message);
    failed++;
  } finally {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
