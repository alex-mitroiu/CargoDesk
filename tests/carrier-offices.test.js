/**
 * Carrier offices (2026-11-16, ARCHITECTURE.md §8.53) — the user's Spain example, end to end:
 *
 *  - Profile: Hapag-Lloyd's Madrid office books for all of Spain, its Barcelona office bills Barcelona's exports, its
 *    American office handles and bills US imports. Offices are their own records, located at any UN/LOCODE (Madrid is
 *    ESMAD, not a port); coverage is a port or a country × a direction × a role, a port beating its country; the
 *    booking role is export only, the import office import only; duplicates and wrong carriers are refused; the
 *    route check gives the four offices.
 *  - Our account number per legal entity (DCSA identifyingCodes) and the code list name.
 *  - A shipment ESBCN → USNYC gets its four offices from the coverage, with why; a new port of loading picks the
 *    export roles again and leaves the import ones; a hand pick (export side only) is kept until "From coverage";
 *    an empty pick stays empty; with no billing row the import office bills (worked out when read); two offices found
 *    only through linked ports are left empty with both as candidates, and a pick settles it (was
 *    tests/line-agent-candidates.test.js).
 *  - The booking request: the booking office at its own location (ESMAD, not the port of loading), our customer number
 *    on the booking agent, "payable at" the origin billing office (ESBCN) when Prepaid and the destination one (USNYC)
 *    when Collect; the body is valid DCSA Booking 2.0. The Shipping Instructions take the same place.
 *  - Freight Audit: "Issued by" defaults from the shipment's billing office for the side of the first charge, can be
 *    changed, and is fixed once a line is approved; the detail carries the office's creditor code.
 *  - The Line Agent routes and party roles are gone; the QA export carries the shipment's carrier offices.
 *
 * Usage:
 *   node tests/carrier-offices.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, not in production (the built-in DCSA carrier answers the booking)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - ESBCN, ESVLC, USNYC, NLRTM in port_locations, ES/US in countries (seeded MDM data)
 *
 * Everything it creates is removed afterwards: the coverage and offices are lookup rows that would change every other
 * shipment of their carrier, so they go even though verification data is normally kept.
 */

import http from "node:http";
import { createRequire } from "node:module";
import { ensureOffices, retireOffice, retireBranch } from "./helpers/offices.mjs";
import { addContainer } from "./helpers/dcsa-sim.mjs";

const require = createRequire(import.meta.url);
const { validateOutbound, errorsText } = require("../lib/dcsa/validate.js");
const { buildShippingInstructions } = require("../lib/carrier-integrations/dcsa-ebl-v3.js");

let passed = 0, failed = 0;
const assert = (label, cond, detail = "") => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${String(detail).slice(0, 400)}` : ""}`); failed++; }
};
function request(method, path, body, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ method, hostname: "localhost", port: 3001, path, headers: {
      "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}), ...headers } }, res => {
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  // A carrier code of its own, so the coverage written here changes no other shipment.
  const CARRIER = `Q${Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;
  const cleanup = { shipments: [], offices: [], coverage: [], customers: [], users: [], branch: null, office: null };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { imoOfficeId } = await ensureOffices(token);

    // Our Spanish legal entity and its Barcelona export office.
    const branch = (await request("POST", "/api/branches", { code: `COF${rand}`, name: `CargoDesk Logistica Barcelona ${rand} SL`, countryCode: "ES",
      city: "Barcelona", address: "Moll de Barcelona 21", locode: "ESBCN", currency: "EUR", email: "export.bcn@cargodesk.example", phone: "+34 93 301 4400" }, token)).body;
    cleanup.branch = branch?.id;
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    const exportOffice = (await request("POST", "/api/offices", { unlocode: `ES${letters}`, countryCode: "ES", department: "SE",
      name: `Barcelona Export ${rand}`, branchId: branch?.id }, token)).body;
    if (!exportOffice?.id) throw new Error(`scratch office not created: ${JSON.stringify(exportOffice)}`);
    cleanup.office = exportOffice.id;

    // ─── The profile ────────────────────────────────────────────────────────────
    console.log(`\nThe carrier's profile (${CARRIER})`);
    const office = async body => {
      const r = await request("POST", `/api/carriers/${CARRIER}/offices`, body, token);
      if (r.body?.id) cleanup.offices.push(r.body.id);
      return r;
    };
    const madrid = await office({ name: `Hapag-Lloyd Spain Madrid ${rand}`, unlocode: "ESMAD", address1: "Paseo de la Castellana 95", postalCode: "28046",
      city: "Madrid", countryIso2: "ES", contactName: "Bookings desk", contactPhone: "+34 91 590 7100", contactEmail: "es.bookings@hlag.example",
      capabilities: ["documentation", "port_agency"], hours: [{ days: ["Mon", "Tue", "Wed", "Thu", "Fri"], startTime: "08:30", endTime: "18:00" }] });
    assert("an office located at an inland UN/LOCODE (Madrid, ESMAD) is added (201)", madrid.status === 201 && madrid.body.unlocode === "ESMAD", JSON.stringify(madrid.body));
    assert("…with its working hours", madrid.body.hours?.length === 1 && madrid.body.hours[0].days.length === 5, JSON.stringify(madrid.body.hours));
    const barcelona = await office({ name: `Hapag-Lloyd Spain Barcelona ${rand}`, unlocode: "ESBCN", address1: "Moll de Sant Bertran 2", postalCode: "08039",
      city: "Barcelona", countryIso2: "ES", contactName: "Accounts", contactEmail: "es.accounts@hlag.example", creditorCode: "400128" });
    const usa = await office({ name: `Hapag-Lloyd (America) ${rand}`, unlocode: "USNYC", address1: "399 Hoes Lane", postalCode: "08854", city: "Piscataway",
      countryIso2: "US", contactName: "Import desk", contactPhone: "+1 732 562 1800", creditorCode: "400311", capabilities: ["documentation", "customs_clearance"] });
    assert("Barcelona and the American office are added", barcelona.status === 201 && usa.status === 201, JSON.stringify([barcelona.body, usa.body]));
    const bad = await request("POST", `/api/carriers/${CARRIER}/offices`, { name: "No location", unlocode: "Madrid" }, token);
    assert("a location that isn't a UN/LOCODE is refused (400)", bad.status === 400 && /UN\/LOCODE/.test(bad.body?.error || ""), JSON.stringify(bad.body));

    const cover = async body => {
      const r = await request("POST", `/api/carriers/${CARRIER}/coverage`, body, token);
      if (r.body?.id) cleanup.coverage.push(r.body.id);
      return r;
    };
    const rows = [
      await cover({ placeType: "country", countryIso2: "ES", direction: "export", role: "booking", officeId: madrid.body.id }),
      await cover({ placeType: "country", countryIso2: "ES", direction: "export", role: "billing", officeId: madrid.body.id }),
      await cover({ placeType: "unlocode", unlocode: "ESBCN", direction: "export", role: "billing", officeId: barcelona.body.id }),
      await cover({ placeType: "country", countryIso2: "US", direction: "import", role: "import", officeId: usa.body.id }),
    ];
    assert("four coverage rows: Spain books and bills in Madrid, Barcelona bills ESBCN, the US office handles US imports",
      rows.every(r => r.status === 201), JSON.stringify(rows.map(r => r.body)));
    const usBilling = await cover({ placeType: "country", countryIso2: "US", direction: "import", role: "billing", officeId: usa.body.id });
    assert("…and bills them", usBilling.status === 201, JSON.stringify(usBilling.body));
    const wrongDir = await request("POST", `/api/carriers/${CARRIER}/coverage`, { placeType: "unlocode", unlocode: "ESVLC", direction: "import", role: "booking", officeId: madrid.body.id }, token);
    assert("a booking office for imports is refused (400)", wrongDir.status === 400, JSON.stringify(wrongDir.body));
    const dup = await request("POST", `/api/carriers/${CARRIER}/coverage`, { placeType: "unlocode", unlocode: "ESBCN", direction: "export", role: "billing", officeId: madrid.body.id }, token);
    assert("a second billing office for ESBCN exports is refused (409)", dup.status === 409, JSON.stringify(dup.body));
    const otherCarrier = await request("POST", `/api/carriers/MAEU/coverage`, { placeType: "unlocode", unlocode: "ESVLC", direction: "export", role: "booking", officeId: madrid.body.id }, token);
    assert("another carrier's office can't be used (400)", otherCarrier.status === 400, JSON.stringify(otherCarrier.body));

    const check = (await request("GET", `/api/carriers/${CARRIER}/coverage-check?pol=ESBCN&pod=USNYC`, null, token)).body;
    assert("check ESBCN → USNYC: Madrid books (the row for ES)", check.booking?.officeId === madrid.body.id && /ES/.test(check.booking.why), JSON.stringify(check.booking));
    assert("…Barcelona bills the origin (the port beats its country)", check.billing_origin?.officeId === barcelona.body.id && /ESBCN/.test(check.billing_origin.why), JSON.stringify(check.billing_origin));
    assert("…the American office handles and bills the destination", check.import?.officeId === usa.body.id && check.billing_destination?.officeId === usa.body.id, JSON.stringify(check));
    const checkVlc = (await request("GET", `/api/carriers/${CARRIER}/coverage-check?pol=ESVLC&pod=USNYC`, null, token)).body;
    assert("check ESVLC → USNYC: Madrid bills the origin (no row for ESVLC)", checkVlc.billing_origin?.officeId === madrid.body.id, JSON.stringify(checkVlc.billing_origin));

    // ─── Our account numbers ──────────────────────────────────────────────────
    console.log("\nOur account numbers");
    let acc = await request("PUT", `/api/carriers/${CARRIER}/account-numbers`, { codeListName: "hlagCustomerNumber", numbers: [{ branchId: branch.id, accountNumber: "ES00041207" }] }, token);
    assert("our Spanish entity's customer number is saved", acc.status === 200 && acc.body.accountNumbers.find(a => a.branchId === branch.id)?.accountNumber === "ES00041207"
      && acc.body.codeListName === "hlagCustomerNumber", JSON.stringify(acc.body).slice(0, 300));
    acc = await request("PUT", `/api/carriers/${CARRIER}/account-numbers`, { numbers: [{ branchId: "BRN-NOPE", accountNumber: "X" }] }, token);
    assert("an unknown legal entity is refused (400)", acc.status === 400, JSON.stringify(acc.body));
    const profile = (await request("GET", `/api/carriers/${CARRIER}/profile`, null, token)).body;
    assert("the profile holds 3 offices, 5 coverage rows and the number", profile.offices?.length === 3 && profile.coverage?.length === 5
      && profile.accountNumbers?.find(a => a.branchId === branch.id)?.accountNumber === "ES00041207", JSON.stringify({ o: profile.offices?.length, c: profile.coverage?.length }));

    // ─── A shipment's offices ─────────────────────────────────────────────────
    console.log("\nA shipment ESBCN → USNYC");
    const customer = async (companyName, address1, postalCode, city, countryIso2) => {
      const c = (await request("POST", "/api/customers", { companyName, address1, postalCode, city, countryIso2 }, token)).body;
      cleanup.customers.push(c.id);
      return c;
    };
    const shipper = await customer(`Ceramicas del Llobregat ${rand} SA`, "Carrer de la Botanica 112", "08908", "L'Hospitalet de Llobregat", "ES");
    const consignee = await customer(`Hudson Tile Distributors ${rand} Inc`, "250 Port Jersey Blvd", "07305", "Jersey City", "US");
    const s = await request("POST", "/api/shipments", { pol: "ESBCN", pod: "USNYC", carrierCode: CARRIER, status: "Active", contractType: "Central",
      contractRef: "HLAG-SC-2026-ES-0412", incoterm: "CIF", freightTerms: "Prepaid", etd: "2026-12-04", eta: "2026-12-18", commodityCode: "9999",
      shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      principalId: shipper.id, principalName: shipper.companyName, emoOfficeId: exportOffice.id, imoOfficeId }, token);
    const S = s.body?.id;
    if (!S) throw new Error(`scratch shipment not created: ${JSON.stringify(s.body)}`);
    cleanup.shipments.push(S);
    await request("POST", `/api/shipments/${S}/legs`, { legType: "SEA", movementType: "SEA", pol: "ESBCN", pod: "USNYC", etd: "2026-12-04", eta: "2026-12-18",
      carrierCode: CARRIER, vessel: "BERLIN EXPRESS", vesselImo: "9501344", voyage: "512W" }, token);
    const view = async () => (await request("GET", `/api/shipments/${S}/carrier-offices`, null, token)).body;
    let v = await view();
    assert("the booking office is Madrid, from the row for ES", v.roles?.booking?.office?.id === madrid.body.id && v.roles.booking.source === "auto"
      && /row for ES/.test(v.roles.booking.why), JSON.stringify(v.roles?.booking));
    assert("…the origin billing office Barcelona, with its creditor code", v.roles.billing_origin?.office?.id === barcelona.body.id
      && v.roles.billing_origin.office.creditorCode === "400128", JSON.stringify(v.roles.billing_origin));
    assert("…the import office and destination billing the American office", v.roles.import?.office?.id === usa.body.id && v.roles.billing_destination?.office?.id === usa.body.id,
      JSON.stringify([v.roles.import, v.roles.billing_destination]));
    assert("…and the carrier's offices are offered for a pick", v.offices?.length === 3, JSON.stringify(v.offices));
    const history = (await request("GET", `/api/shipments/${S}/events?limit=200`, null, token)).body;
    const events = Array.isArray(history) ? history : history?.results || [];
    assert("History records the offices picked", events.filter(e => e.eventType === "CARRIER_OFFICE_ASSIGNED").length === 4, JSON.stringify(events.map(e => e.eventType)));

    // A new port of loading picks the export roles again and leaves the import ones.
    const importSetAt = v.roles.import.setAt;
    await sleep(20);
    let r = await request("PUT", `/api/shipments/${S}`, { pol: "ESVLC" }, token);
    assert("(setup) the port of loading changes to ESVLC", r.status === 200, JSON.stringify(r.body).slice(0, 200));
    const legs = (await request("GET", `/api/shipments/${S}/legs`, null, token)).body;
    const sea = (Array.isArray(legs) ? legs : []).find(l => l.legType === "SEA");
    if (sea) await request("PUT", `/api/shipments/${S}/legs/${sea.id}`, { ...sea, pol: "ESVLC" }, token);
    v = await view();
    assert("…origin billing moves to Madrid (no row for ESVLC)", v.roles.billing_origin?.office?.id === madrid.body.id, JSON.stringify(v.roles.billing_origin));
    assert("…the import office isn't picked again", v.roles.import?.setAt === importSetAt, JSON.stringify([importSetAt, v.roles.import?.setAt]));
    if (sea) await request("PUT", `/api/shipments/${S}/legs/${sea.id}`, { ...sea, pol: "ESBCN" }, token);
    await request("PUT", `/api/shipments/${S}`, { pol: "ESBCN" }, token);
    v = await view();
    assert("…and back on ESBCN, Barcelona bills again", v.roles.billing_origin?.office?.id === barcelona.body.id, JSON.stringify(v.roles.billing_origin));

    // Hand picks.
    r = await request("PUT", `/api/shipments/${S}/carrier-offices/booking`, { officeId: barcelona.body.id }, token);
    assert("Barcelona is picked as the booking office by hand", r.status === 200 && r.body.roles.booking.office.id === barcelona.body.id && r.body.roles.booking.source === "manual",
      JSON.stringify(r.body?.roles?.booking));
    r = await request("PUT", `/api/shipments/${S}/carrier-offices/booking`, { officeId: madrid.body.id.replace(/./g, "X") }, token);
    assert("an office that isn't the carrier's is refused (400)", r.status === 400, JSON.stringify(r.body));
    r = await request("PUT", `/api/shipments/${S}/carrier-offices/booking`, { fromCoverage: true }, token);
    assert("From coverage puts Madrid back", r.status === 200 && r.body.roles.booking.office.id === madrid.body.id && r.body.roles.booking.source === "auto",
      JSON.stringify(r.body?.roles?.booking));
    r = await request("PUT", `/api/shipments/${S}/carrier-offices/billing_destination`, { officeId: null }, token);
    assert("destination billing left empty on purpose: then the import office bills (worked out when read)",
      r.status === 200 && r.body.roles.billing_destination.fallback && r.body.roles.billing_destination.office?.id === usa.body.id, JSON.stringify(r.body?.roles?.billing_destination));
    r = await request("PUT", `/api/shipments/${S}/carrier-offices/billing_destination`, { fromCoverage: true }, token);
    assert("…and From coverage picks it again", r.body?.roles?.billing_destination?.source === "auto", JSON.stringify(r.body?.roles?.billing_destination));
    r = await request("PUT", `/api/shipments/${S}/carrier-offices/nonsense`, { officeId: madrid.body.id }, token);
    assert("an unknown role is refused (400)", r.status === 400, JSON.stringify(r.body));

    // Only the export side changes the export roles.
    const email = `cof-import-${rand.toLowerCase()}@test.local`;
    const u = await request("POST", "/api/users", { email, name: "Carrier office import desk", roles: ["occ_bk"], password: "CofFixture!2026Zq" }, token);
    cleanup.users.push(u.body?.id);
    await request("POST", `/api/users/${u.body?.id}/offices`, { officeId: imoOfficeId }, token);
    const userToken = (await request("POST", "/api/auth/login", { email, password: "CofFixture!2026Zq" })).body?.token;
    const asImport = { "X-Office-Id": imoOfficeId };
    r = await request("PUT", `/api/shipments/${S}/carrier-offices/booking`, { officeId: barcelona.body.id }, userToken, asImport);
    assert("an import-side user can't change the booking office (403)", r.status === 403, JSON.stringify(r.body));
    r = await request("PUT", `/api/shipments/${S}/carrier-offices/import`, { officeId: usa.body.id }, userToken, asImport);
    assert("…but can pick the import office", r.status === 200 && r.body.roles.import.source === "manual", JSON.stringify(r.body).slice(0, 200));

    // ─── Two offices found only through linked ports: left for a person to pick ──────────
    console.log("\nTwo offices via linked ports");
    const CARRIER2 = `${CARRIER.slice(0, 3)}Z`;
    const viaA = await request("POST", `/api/carriers/${CARRIER2}/offices`, { name: `Rotterdam Line Office ${rand}`, unlocode: "NLRTM" }, token);
    const viaB = await request("POST", `/api/carriers/${CARRIER2}/offices`, { name: `New York Line Office ${rand}`, unlocode: "USNYC" }, token);
    cleanup.offices.push(viaA.body?.id, viaB.body?.id);
    for (const [o, port] of [[viaA, "NLRTM"], [viaB, "USNYC"]]) {
      const c = await request("POST", `/api/carriers/${CARRIER2}/coverage`, { placeType: "unlocode", unlocode: port, direction: "export", role: "booking", officeId: o.body?.id }, token);
      if (c.body?.id) cleanup.coverage.push(c.body.id);
    }
    const link1 = await request("POST", "/api/linked-ports", { primaryUnlocode: "ESVLC", linkedUnlocode: "NLRTM" }, token);
    const link2 = await request("POST", "/api/linked-ports", { primaryUnlocode: "ESVLC", linkedUnlocode: "USNYC" }, token);
    cleanup.links = [link1.body?.id, link2.body?.id];
    assert("(setup) ESVLC is linked to NLRTM and USNYC, each with its own office of the carrier", link1.status === 201 && link2.status === 201, JSON.stringify([link1.body, link2.body]));
    const amb = await request("POST", "/api/shipments", { pol: "ESVLC", pod: "SGSIN", carrierCode: CARRIER2, status: "Active", contractType: "Central",
      contractRef: "LINE-SC-2026-0098", incoterm: "FOB", freightTerms: "Collect", etd: "2026-12-08", eta: "2027-01-02", commodityCode: "9999",
      shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      principalId: consignee.id, principalName: consignee.companyName, emoOfficeId: exportOffice.id, imoOfficeId }, token);
    if (amb.body?.id) { cleanup.shipments.push(amb.body.id); await addContainer(request, token, amb.body.id); }
    let av = (await request("GET", `/api/shipments/${amb.body?.id}/carrier-offices`, null, token)).body;
    assert("the booking office is left empty, with both offices as candidates (via NLRTM and USNYC)", !av?.roles?.booking?.office
      && JSON.stringify((av?.roles?.booking?.candidates || []).map(c => c.via).sort()) === JSON.stringify(["NLRTM", "USNYC"]), JSON.stringify(av?.roles?.booking));
    const pickA = await request("PUT", `/api/shipments/${amb.body?.id}/carrier-offices/booking`, { officeId: viaA.body?.id }, token);
    assert("…picking one settles it, and no candidates are left", pickA.status === 200 && pickA.body.roles.booking.office?.id === viaA.body?.id
      && pickA.body.roles.booking.candidates.length === 0, JSON.stringify(pickA.body?.roles?.booking));

    // ─── The booking request ──────────────────────────────────────────────────
    console.log("\nThe booking request");
    await addContainer(request, token, S);
    const sent = await request("POST", `/api/shipments/${S}/edi-messages/booking-request`, {}, token);
    assert("the booking request is sent (201)", sent.status === 201, JSON.stringify(sent.body).slice(0, 300));
    const out = ((await request("GET", `/api/shipments/${S}/edi-messages`, null, token)).body || []).find(m => m.direction === "out" && /booking/.test(m.messageType));
    const body = parse(out?.rawPayload);
    const v1 = body ? validateOutbound("bkg", "post", "/v2/bookings", body) : { ok: false, errors: [] };
    assert("…valid DCSA Booking 2.0, no field the spec doesn't define", v1.ok, v1.ok ? "" : errorsText(v1.errors, 6));
    const cbo = body?.documentParties?.carrierBookingOffice;
    assert("the carrier booking office is Madrid, located at ESMAD (not the port of loading)", cbo?.partyName === madrid.body.name && cbo?.UNLocationCode === "ESMAD",
      JSON.stringify(cbo));
    assert("…with its address and contact", cbo?.address?.city === "Madrid" && cbo?.partyContactDetails?.[0]?.email === "es.bookings@hlag.example", JSON.stringify(cbo));
    const codes = body?.documentParties?.bookingAgent?.identifyingCodes;
    assert("the booking agent carries our customer number (ZZZ, with the code list name)", codes?.[0]?.codeListProvider === "ZZZ" && codes[0].partyCode === "ES00041207"
      && codes[0].codeListName === "hlagCustomerNumber", JSON.stringify(body?.documentParties?.bookingAgent));
    assert("Prepaid: the freight is payable at the origin billing office (ESBCN)", body?.invoicePayableAt?.UNLocationCode === "ESBCN", JSON.stringify(body?.invoicePayableAt));

    // Collect: payable at the destination billing office (the SI builder takes the same place).
    const payCollect = (await request("PUT", `/api/shipments/${S}`, { freightTerms: "Collect" }, token)).status;
    const si = buildShippingInstructions({ shipment: { carrier_code: CARRIER, pol: "ESBCN", pod: "USNYC", freight_terms: "Collect" }, payableAt: "USNYC" });
    const siDefault = buildShippingInstructions({ shipment: { carrier_code: CARRIER, pol: "ESBCN", pod: "USNYC", freight_terms: "Prepaid" } });
    assert("the Shipping Instructions are payable at the billing office given, else the port of loading (Prepaid)",
      payCollect === 200 && si.invoicePayableAt.UNLocationCode === "USNYC" && siDefault.invoicePayableAt.UNLocationCode === "ESBCN", JSON.stringify([si.invoicePayableAt, siDefault.invoicePayableAt]));
    await request("PUT", `/api/shipments/${S}`, { freightTerms: "Prepaid" }, token);

    // ─── Freight Audit ────────────────────────────────────────────────────────
    console.log("\nFreight Audit: who issued the carrier's invoice");
    const opts = (await request("GET", `/api/carrier-invoices/issuer-options?shipmentId=${S}&carrierCode=${CARRIER}&serviceCode=OF`, null, token)).body;
    assert("the form offers the carrier's offices and defaults to Barcelona for the ocean freight (Prepaid → origin)",
      opts.offices?.length === 3 && opts.defaultOfficeId === barcelona.body.id, JSON.stringify(opts));
    const optsD = (await request("GET", `/api/carrier-invoices/issuer-options?shipmentId=${S}&carrierCode=${CARRIER}&serviceCode=DTHC`, null, token)).body;
    assert("…and to the American office for destination THC", optsD.defaultOfficeId === usa.body.id, JSON.stringify(optsD));
    const inv = await request("POST", "/api/carrier-invoices", { shipmentId: S, carrierCode: CARRIER, invoiceNumber: `HLE${rand}0412`, invoiceDate: "2026-12-06",
      currency: "USD", lines: [{ serviceCode: "OF", description: "Ocean freight ESBCN-USNYC 40HC", amount: 2450, currency: "USD" }] }, token);
    assert("a carrier invoice with no issuer given takes the shipment's origin billing office", inv.status === 201 && inv.body.issuingOfficeId === barcelona.body.id
      && inv.body.issuingOfficeName === barcelona.body.name, JSON.stringify(inv.body).slice(0, 300));
    const detail = (await request("GET", `/api/carrier-invoices/${inv.body.id}`, null, token)).body;
    assert("…its detail carries the office's creditor code (400128)", detail.issuingCreditorCode === "400128", JSON.stringify(detail).slice(0, 300));
    r = await request("PATCH", `/api/carrier-invoices/${inv.body.id}/issuer`, { issuingOfficeId: madrid.body.id }, token);
    assert("the clerk changes it to Madrid", r.status === 200 && r.body.issuingOfficeId === madrid.body.id, JSON.stringify(r.body));
    r = await request("PATCH", `/api/carrier-invoices/${inv.body.id}/issuer`, { issuingOfficeId: "COF-NOPE" }, token);
    assert("…not to an office of another carrier (400)", r.status === 400, JSON.stringify(r.body));
    const lineId = inv.body.lines?.[0]?.id;
    const appr = await request("POST", `/api/carrier-invoice-lines/${lineId}/approve`, {}, token);
    assert("(setup) the line is approved", appr.status === 200, JSON.stringify(appr.body).slice(0, 200));
    r = await request("PATCH", `/api/carrier-invoices/${inv.body.id}/issuer`, { issuingOfficeId: barcelona.body.id }, token);
    assert("once a line is approved, who issued it is fixed (409)", r.status === 409, JSON.stringify(r.body));
    // GL Export: the cost posted from that line carries the issuing office's creditor code on its AP row.
    const costLineId = (await request("GET", `/api/carrier-invoices/${inv.body.id}`, null, token)).body?.lines?.[0]?.matchedCostLineId;
    const posted = await request("PATCH", `/api/shipments/${S}/cost-lines/${costLineId}/post`, {}, token);
    assert("(setup) the cost is posted", posted.status === 200, JSON.stringify(posted.body).slice(0, 200));
    const today = new Date().toISOString().slice(0, 10);
    const gl = await request("POST", "/api/gl-export/run", { dateFrom: today, dateTo: today }, token);
    const csvLines = String(gl.body?.csv || "").split(/\r?\n/);
    const apRow = csvLines.find(l => l.includes(`AP — ${costLineId}`)) || "";
    assert("GL Export: the CSV has Counterparty columns, and the cost's AP row names Madrid's creditor code (none set: blank) and name",
      /Counterparty,Counterparty Name$/.test(csvLines[0]) && apRow.endsWith(`,${madrid.body.name}`), JSON.stringify({ head: csvLines[0], apRow }));
    await request("PUT", `/api/carrier-offices/${barcelona.body.id}`, { creditorCode: "400128" }, token);
    // Freight Audit's issuer for the next invoice: Barcelona, with its creditor code on the AP row.
    const inv3 = await request("POST", "/api/carrier-invoices", { shipmentId: S, carrierCode: CARRIER, invoiceNumber: `HLE${rand}0414`, invoiceDate: "2026-12-07",
      currency: "USD", lines: [{ serviceCode: "OTHC", description: "Origin THC ESBCN", amount: 210, currency: "USD" }] }, token);
    const line3 = inv3.body?.lines?.[0];
    await request("POST", `/api/carrier-invoice-lines/${line3?.id}/approve`, {}, token);
    const cost3 = (await request("GET", `/api/carrier-invoices/${inv3.body?.id}`, null, token)).body?.lines?.[0]?.matchedCostLineId;
    await request("PATCH", `/api/shipments/${S}/cost-lines/${cost3}/post`, {}, token);
    const gl2 = await request("POST", "/api/gl-export/run", { dateFrom: today, dateTo: today }, token);
    const ap3 = String(gl2.body?.csv || "").split(/\r?\n/).find(l => l.includes(`AP — ${cost3}`)) || "";
    assert("…and an origin THC invoice issued by Barcelona posts on creditor 400128", inv3.body?.issuingOfficeId === barcelona.body.id
      && ap3.endsWith(`,400128,${barcelona.body.name}`), JSON.stringify({ issuer: inv3.body?.issuingOfficeName, ap3 }));
    const inv2 = await request("POST", "/api/carrier-invoices", { shipmentId: S, carrierCode: CARRIER, invoiceNumber: `HLE${rand}0413`, invoiceDate: "2026-12-20",
      currency: "USD", issuingOfficeId: usa.body.id, lines: [{ serviceCode: "DTHC", description: "Destination THC USNYC", amount: 340, currency: "USD" }] }, token);
    assert("an issuer picked on the form is kept", inv2.status === 201 && inv2.body.issuingOfficeId === usa.body.id, JSON.stringify(inv2.body).slice(0, 200));

    // ─── Retired: Line Agents ─────────────────────────────────────────────────
    console.log("\nThe Line Agents are gone");
    assert("GET /api/carrier-agents → 404", (await request("GET", "/api/carrier-agents", null, token)).status === 404);
    assert("GET …/line-agent-candidates → 404", (await request("GET", `/api/shipments/${S}/line-agent-candidates`, null, token)).status === 404);
    r = await request("POST", `/api/shipments/${S}/parties`, { role: "Line Agent (Export)", customerId: shipper.id, customerName: shipper.companyName }, token);
    assert("a Line Agent party role is refused (400)", r.status === 400, JSON.stringify(r.body));

    // ─── The QA export ────────────────────────────────────────────────────────
    console.log("\nThe QA export");
    const qa = (await request("GET", `/api/shipments/${S}/qa-export`, null, token)).body;
    const part = (qa?.parts || []).find(p => p.table === "shipment_carrier_offices");
    assert("the QA export carries the shipment's carrier offices", part?.count === 4, JSON.stringify(qa?.parts?.map(p => `${p.table}:${p.count}`)));

    // ─── Removing an office ───────────────────────────────────────────────────
    r = await request("DELETE", `/api/carrier-offices/${madrid.body.id}`, null, token);
    assert("an office still used by coverage or a shipment can't be removed: set it inactive (409)", r.status === 409 && /inactive/.test(r.body?.error || ""), JSON.stringify(r.body));
  } catch (e) {
    console.error("Test run failed:", e);
    failed++;
  } finally {
    if (token) {
      for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
      for (const id of (cleanup.links || []).filter(Boolean)) await request("DELETE", `/api/linked-ports/${id}`, null, token).catch(() => {});
      for (const id of cleanup.coverage) await request("DELETE", `/api/carrier-coverage/${id}`, null, token).catch(() => {});
      await request("PUT", `/api/carriers/${CARRIER}/account-numbers`, { numbers: [], codeListName: "" }, token).catch(() => {});
      for (const id of cleanup.offices.filter(Boolean)) {
        const del = await request("DELETE", `/api/carrier-offices/${id}`, null, token).catch(() => ({ status: 0 }));
        if (del.status !== 200) await request("PUT", `/api/carrier-offices/${id}`, { isActive: false }, token).catch(() => {});
      }
      for (const id of cleanup.users.filter(Boolean)) await request("DELETE", `/api/users/${id}`, null, token).catch(() => {});
      for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
      if (cleanup.office) await retireOffice(token, cleanup.office).catch(() => {});
      if (cleanup.branch) await retireBranch(token, cleanup.branch).catch(() => {});
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
