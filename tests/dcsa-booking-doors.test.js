/**
 * The carrier's haulage at a door, in the DCSA booking (2026-11-20, ARCHITECTURE.md §8.55, TC-109).
 *
 * The user's rule: only when the route has a Carrier's Haulage leg that starts at a Door (pick-up, DR-CY / DR-PT) or ends
 * at one (delivery, CY-DR / PT-DR) does the booking say Store Door (SD) and tell the carrier where to go and whom to call,
 * from the shipper's or the consignee's customer profile. Checked on the body logged as sent (valid Booking 2.0, no field
 * the spec doesn't define):
 *   - DR-CY: receipt SD; the place of receipt (PRE) and each equipment line's container positioning carry the shipper's
 *     address and the door's UN/LOCODE; the positioning's date-time is the Loading plan's earliest time, at the door's own
 *     offset; the shipper party carries the customer's name and details: its address and its Operations contact (not the
 *     primary Sales one);
 *   - a carrier's pick-up from GPS Coordinates (the user: a door too): the place of receipt is the leg's point;
 *   - PT-DR: delivery SD, the consignee's address as the place of delivery (PDE), the company's own phone as its contact;
 *     receipt CY, no positioning;
 *   - Merchant's Haulage from the same door, with Service Type "Door-to-Port": CY, no address (Service Type no longer decides);
 *   - a classified location (GPS only, no street): the coordinates are enough;
 *   - a shipper profile with no street or city: refused before anything is recorded, saying what to add.
 *
 * Usage:
 *   node tests/dcsa-booking-doors.test.js
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
const parse = v => { try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return null; } };
// Dates relative to today (CLAUDE.md: never a fixed date).
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
// Madrid's offset on a day, worked out here independently of lib/booking-doors.js.
const madridOffset = date => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", timeZoneName: "longOffset" })
    .formatToParts(new Date(`${date}T12:00:00Z`)).find(p => p.type === "timeZoneName").value; // "GMT+01:00"
  return name.replace("GMT", "") || "+00:00";
};

(async () => {
  const cleanup = { shipments: [], customers: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const etd = day(12), eta = day(25), pickUpDay = day(9), loadDay = day(8);

    const customer = async (body, contacts = []) => {
      const c = (await request("POST", "/api/customers", body, token)).body;
      if (!c?.id) throw new Error(`scratch customer not created: ${JSON.stringify(c)}`);
      cleanup.customers.push(c.id);
      for (const k of contacts) await request("POST", `/api/customers/${c.id}/contacts`, k, token);
      return c;
    };
    // A tile maker near Barcelona: a Sales contact marked primary, and the warehouse's Operations contact.
    const shipper = await customer({ companyName: `Ceramicas del Llobregat ${rand} SA`, address1: "Carrer de la Botanica 112", address2: "Nave 4",
      postalCode: "08908", city: "L'Hospitalet de Llobregat", state: "Barcelona", countryIso2: "ES", phone: "+34 932 61 40 00", email: "info@ceramicas.example" },
      [{ name: "Jordi Ferrer", email: "jordi.ferrer@ceramicas.example", department: "Sales", isPrimary: true },
       { name: "Marta Puig", phone: "+34 600 112 233", email: "almacen@ceramicas.example", department: "Operations" }]);
    const consignee = await customer({ companyName: `Hudson Tile Distributors ${rand} Inc`, address1: "600 Meadowlands Pkwy", postalCode: "07094",
      city: "Secaucus", state: "NJ", countryIso2: "US", phone: "+1 201 555 0142" });
    const noAddress = await customer({ companyName: `Azulejos Sin Direccion ${rand} SL`, countryIso2: "ES", phone: "+34 961 20 30 40" });
    const farm = await customer({ companyName: `Finca La Ribera ${rand} SL`, countryIso2: "ES", classifiedLocation: true, latitude: 41.3597, longitude: 2.0998 },
      [{ name: "Pep Soler", phone: "+34 611 223 344", department: "Operations" }]);

    // A complete booking-ready shipment ESBCN → USNYC (Central contract, FOB, 2 × 40HC of ceramic tiles) with the route given.
    const newShipment = async (route, { shipperRow = shipper, serviceType = "Port-to-Port" } = {}) => {
      const s = await request("POST", "/api/shipments", { pol: "ESBCN", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central",
        contractRef: "MAEU-SC-2026-ES-0412", etd, eta, incoterm: "FOB", freightTerms: "Collect", commodityCode: "9999", serviceType,
        shipperId: shipperRow.id, shipperName: shipperRow.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: consignee.id, principalName: consignee.companyName, emoOfficeId, imoOfficeId }, token);
      if (!s.body?.id) throw new Error(`scratch shipment not created: ${JSON.stringify(s.body)}`);
      const id = s.body.id;
      cleanup.shipments.push(id);
      const ctrs = [];
      for (const n of [1, 2]) ctrs.push((await request("POST", "/api/containers", { shipmentId: id, containerNumber: `MSKU${String(Date.now()).slice(-6)}${n}`,
        size: "40", type: "HC", hsCode: "690721", cargoDescription: "Glazed ceramic floor tiles", grossWeightKg: 22400, numberOfPackages: 24, packageCode: "PL" }, token)).body);
      const sea = { legType: "SEA", movementType: "SEA", pol: "ESBCN", pod: "USNYC", etd, eta, carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", vesselImo: "9333022", voyage: "449W" };
      const legs = await request("PUT", `/api/shipments/${id}/legs`, { legs: route(sea) }, token);
      if (legs.status !== 200) throw new Error(`route refused: ${legs.status} ${JSON.stringify(legs.body).slice(0, 300)}`);
      return { id, ctrs };
    };
    const pickUp = movementType => ({ legType: "Pick-up", movementType, movementBy: "Truck", pol: "ESHOS", polName: "L'Hospitalet de Llobregat", polLocType: "Door",
      pod: "ESBCN", podLocType: "Container Yard", etd: pickUpDay, eta: pickUpDay });
    const sendBooking = id => request("POST", `/api/shipments/${id}/edi-messages/booking-request`, {}, token);
    const sentBody = async id => {
      const msgs = (await request("GET", `/api/shipments/${id}/edi-messages`, null, token)).body || [];
      return parse(msgs.find(m => m.direction === "out" && /booking/i.test(m.messageType))?.rawPayload);
    };
    const specProblems = b => { if (!b) return "no body"; const v = validateOutbound("bkg", "post", "/v2/bookings", b); return v.ok ? "" : errorsText(v.errors, 6); };
    const loc = (b, code) => b?.shipmentLocations?.find(l => l.locationTypeCode === code)?.location;

    // ─── DR-CY: the carrier collects at the shipper's door ─────────────────────
    console.log("\nDR-CY: the carrier's pick-up at the shipper's door");
    const A = await newShipment(sea => [pickUp("Carrier's Haulage"), sea]);
    const svc = (await request("POST", `/api/shipments/${A.id}/services`, { side: "Export", serviceType: "Loading" }, token)).body;
    await request("PUT", `/api/shipments/${A.id}/services/${svc.id}/loading-plan/${A.ctrs[0].id}`, { plannedDate: `${pickUpDay}T14:30`, sequenceOrder: 2 }, token);
    await request("PUT", `/api/shipments/${A.id}/services/${svc.id}/loading-plan/${A.ctrs[1].id}`, { plannedDate: `${loadDay}T09:00`, sequenceOrder: 1 }, token);
    const sentA = await sendBooking(A.id);
    assert("the booking request is sent (201)", sentA.status === 201, JSON.stringify(sentA.body).slice(0, 300));
    const a = await sentBody(A.id);
    assert("…valid DCSA Booking 2.0, with no field the spec doesn't define", specProblems(a) === "", specProblems(a));
    assert("Store Door at origin, CY at destination", a?.receiptTypeAtOrigin === "SD" && a?.deliveryTypeAtDestination === "CY", JSON.stringify([a?.receiptTypeAtOrigin, a?.deliveryTypeAtDestination]));
    const pre = loc(a, "PRE");
    assert("the place of receipt is the shipper's door: its name, the door's UN/LOCODE",
      pre?.locationName === shipper.companyName && pre?.UNLocationCode === "ESHOS", JSON.stringify(pre));
    assert("…with the shipper's address from its profile (line 2 joined to the street)",
      pre?.address?.street === "Carrer de la Botanica 112, Nave 4" && pre.address.postCode === "08908" && pre.address.city === "L'Hospitalet de Llobregat"
      && pre.address.stateRegion === "Barcelona" && pre.address.countryCode === "ES", JSON.stringify(pre?.address));
    const pos = a?.requestedEquipments?.[0]?.containerPositionings;
    assert("the equipment line asks for the containers at the same door", pos?.length === 1 && JSON.stringify(pos[0].location) === JSON.stringify(pre), JSON.stringify(pos));
    assert("…at the Loading plan's earliest time, in the door's own offset", pos?.[0]?.dateTime === `${loadDay}T09:00:00${madridOffset(loadDay)}`,
      `${pos?.[0]?.dateTime} vs ${loadDay}T09:00:00${madridOffset(loadDay)}`);
    assert("the shipper party carries the Operations contact, not the primary Sales one",
      a?.documentParties?.shipper?.partyContactDetails?.[0]?.name === "Marta Puig" && a.documentParties.shipper.partyContactDetails[0].phone === "+34 600 112 233",
      JSON.stringify(a?.documentParties?.shipper));
    assert("…and its address: the customer's name and details on the shipper", a?.documentParties?.shipper?.partyName === shipper.companyName
      && a.documentParties.shipper.address?.street === "Carrer de la Botanica 112, Nave 4" && a.documentParties.shipper.address?.countryCode === "ES",
      JSON.stringify(a?.documentParties?.shipper));
    assert("no place of delivery: the delivery isn't the carrier's (the consignee party still carries its own profile, TKT-JV1SF2)",
      !loc(a, "PDE") && a?.documentParties?.consignee?.address?.city === "Secaucus", JSON.stringify(a?.documentParties?.consignee));

    // ─── PT-DR: the carrier delivers to the consignee's door ───────────────────
    console.log("\nPT-DR: the carrier's delivery to the consignee's door");
    const B = await newShipment(sea => [sea, { legType: "Delivery", movementType: "Carrier's Haulage", movementBy: "Truck", pol: "USNYC", polLocType: "Terminal",
      pod: "USSEC", podName: "Secaucus", podLocType: "Door", etd: eta, eta: day(27) }]);
    const sentB = await sendBooking(B.id);
    assert("the booking request is sent (201)", sentB.status === 201, JSON.stringify(sentB.body).slice(0, 300));
    const b = await sentBody(B.id);
    assert("…valid DCSA Booking 2.0", specProblems(b) === "", specProblems(b));
    assert("CY at origin, Store Door at destination", b?.receiptTypeAtOrigin === "CY" && b?.deliveryTypeAtDestination === "SD", JSON.stringify([b?.receiptTypeAtOrigin, b?.deliveryTypeAtDestination]));
    const pde = loc(b, "PDE");
    assert("the place of delivery is the consignee's address", pde?.locationName === consignee.companyName && pde?.UNLocationCode === "USSEC"
      && pde?.address?.street === "600 Meadowlands Pkwy" && pde.address.city === "Secaucus" && pde.address.countryCode === "US", JSON.stringify(pde));
    assert("…its contact: the company's own phone (it has no contact person), and its address on the consignee",
      b?.documentParties?.consignee?.partyContactDetails?.[0]?.phone === "+1 201 555 0142" && b.documentParties.consignee.address?.city === "Secaucus",
      JSON.stringify(b?.documentParties?.consignee));
    // Since TKT-JV1SF2 point 1 (2026-11-23) every booking's shipper carries its own profile (address, contact); what stays
    // door-only is the place of receipt and the positioning (next check).
    assert("the shipper party carries its own address and contact from its profile (every booking), not a door",
      b?.documentParties?.shipper?.address?.street === "Carrer de la Botanica 112, Nave 4" && b.documentParties.shipper.partyContactDetails?.[0]?.name === "Marta Puig",
      JSON.stringify(b?.documentParties?.shipper));
    assert("no place of receipt and no container positioning at origin", !loc(b, "PRE") && !b?.requestedEquipments?.[0]?.containerPositionings,
      JSON.stringify(b?.requestedEquipments?.[0]));

    // ─── Merchant's Haulage from the same door: not the carrier's ──────────────
    console.log("\nMerchant's Haulage from the door: the carrier gets no address");
    const C = await newShipment(sea => [pickUp("Merchant's Haulage"), sea], { serviceType: "Door-to-Port" });
    const sentC = await sendBooking(C.id);
    assert("the booking request is sent (201)", sentC.status === 201, JSON.stringify(sentC.body).slice(0, 300));
    const c = await sentBody(C.id);
    assert("CY, though Service Type says Door-to-Port: the route decides", c?.receiptTypeAtOrigin === "CY", c?.receiptTypeAtOrigin);
    assert("…no place of receipt, no positioning (the shipper party still carries its own profile, TKT-JV1SF2)",
      !loc(c, "PRE") && !c?.requestedEquipments?.[0]?.containerPositionings && c?.documentParties?.shipper?.address?.city === "L'Hospitalet de Llobregat",
      JSON.stringify(c?.documentParties?.shipper));

    // ─── A classified location: found by its GPS coordinates ───────────────────
    console.log("\nA classified location (GPS only)");
    const D = await newShipment(sea => [pickUp("Carrier's Haulage"), sea], { shipperRow: farm });
    const sentD = await sendBooking(D.id);
    assert("sent without a street: the coordinates are enough (201)", sentD.status === 201, JSON.stringify(sentD.body).slice(0, 300));
    const d = await sentBody(D.id);
    assert("…valid DCSA Booking 2.0", specProblems(d) === "", specProblems(d));
    assert("the place of receipt carries the GPS coordinates", loc(d, "PRE")?.geoCoordinate?.latitude === "41.359700" && loc(d, "PRE")?.geoCoordinate?.longitude === "2.099800"
      && !loc(d, "PRE")?.address, JSON.stringify(loc(d, "PRE")));
    assert("…and no positioning date: there's no Loading plan", d?.requestedEquipments?.[0]?.containerPositionings?.[0] && !d.requestedEquipments[0].containerPositionings[0].dateTime,
      JSON.stringify(d?.requestedEquipments?.[0]?.containerPositionings));

    // ─── A carrier's pick-up from GPS Coordinates: a door too ───────────────────
    console.log("\nA carrier's pick-up from GPS Coordinates");
    const F = await newShipment(sea => [{ ...pickUp("Carrier's Haulage"), pol: "", polName: "", polLocType: "GPS Coordinates", polLatitude: 41.3712, polLongitude: 2.1048 }, sea]);
    const sentF = await sendBooking(F.id);
    assert("the booking request is sent (201)", sentF.status === 201, JSON.stringify(sentF.body).slice(0, 300));
    const f = await sentBody(F.id);
    assert("…valid DCSA Booking 2.0", specProblems(f) === "", specProblems(f));
    const preF = loc(f, "PRE");
    assert("Store Door, the place of receipt at the leg's coordinates (not the profile's address)", f?.receiptTypeAtOrigin === "SD"
      && preF?.geoCoordinate?.latitude === "41.371200" && preF?.geoCoordinate?.longitude === "2.104800" && !preF?.address && preF?.locationName === shipper.companyName, JSON.stringify(preF));
    assert("…the shipper's name and details on its party", f?.documentParties?.shipper?.address?.city === "L'Hospitalet de Llobregat"
      && f.documentParties.shipper.partyContactDetails?.[0]?.name === "Marta Puig", JSON.stringify(f?.documentParties?.shipper));

    // ─── A profile with no address: refused, nothing recorded ──────────────────
    console.log("\nA carrier's door pick-up with no address on the shipper's profile");
    const E = await newShipment(sea => [pickUp("Carrier's Haulage"), sea], { shipperRow: noAddress });
    const sentE = await sendBooking(E.id);
    assert("refused (400), saying where to add what", sentE.status === 400 && /where to go/.test(sentE.body?.error || "")
      && (sentE.body?.error || "").includes(`add the street, city to ${noAddress.companyName}'s address`), JSON.stringify(sentE.body));
    const bookingE = (await request("GET", `/api/shipments/${E.id}/carrier-booking`, null, token)).body;
    assert("…nothing was sent or recorded", !(await sentBody(E.id)) && bookingE?.status !== "Pending", JSON.stringify(bookingE).slice(0, 200));
  } catch (e) {
    console.error("Fatal:", e);
    failed++;
  } finally {
    console.log("\nCleanup");
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
