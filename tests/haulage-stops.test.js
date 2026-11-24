/**
 * Haulage stops and facilities (2026-11-20, ARCHITECTURE.md §8.56, TC-110, mockup 3d91c28a).
 *
 * The user's idea: a merchant's haulage run is a list of stops (the empty depot, the shipper's door, the terminal; on import
 * the terminal, the consignee's door, the empty depot) with a planned gate in and out per container, places from Master Data
 * (terminals from the SMDG list, depots by hand) and the carrier's closing times the haulier has to respect. Checked:
 *   - pure: the SMDG CSV reader, the checks (CY / VGM cut-off, a typed date-only cut-off, terminal free time), the move of the
 *     old free-text waypoints (decision G);
 *   - Master Data → Facilities: an SMDG import from an uploaded CSV (fictitious terminals; added, then updated, never deleted;
 *     a row past its Valid to is closed), an SMDG row changes only with the next import, a depot by hand, no removal in use;
 *   - C: the trucker is the Pickup service's vendor and the Trucker (Pre-carriage) party follows it, both ways;
 *   - E: the carrier's confirmation fills the containers' EMPTY CY and VGM cut-offs; a typed one stays and is flagged;
 *   - A: the plan's closing times: the documentation cut-off isn't printed; the VGM cut-off only for a Method 1 container;
 *   - the usual stops (the old per-container plan date becomes the door's planned arrival), places, times, the checks,
 *     own stops for one container (B), reordering, an actual time from a container event, the truck's plate;
 *   - F: a Delivery run's usual stops and its terminal free time and detention checks;
 *   - BR01: GET …/booking-doors gives the carrier's door as the DCSA booking sends it;
 *   - the audit of 2026-11-21 (epic TKT-YQQWJR): A1 a vendor typed as free text clears the Trucker party; A2 a cancelled or
 *     removed service releases it; A3 the QA export / import carries the stops and their times; A4 a deleted shipment takes
 *     its services along; A6 a Pickup can't be ordered on (or moved to) the Import side.
 *
 * Usage:
 *   node tests/haulage-stops.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, not in production (the built-in DCSA carrier plays MAEU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { createRequire } from "node:module";
import { ensureOffices } from "./helpers/offices.mjs";
import { bookThroughCarrier } from "./helpers/dcsa-sim.mjs";

const require = createRequire(import.meta.url);
const { parseSmdg, zeroTwinOf } = require("../lib/facilities.js");
const { checksFor, legacyToStops, limitOf } = require("../lib/haulage-stops.js");

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
// Dates relative to today (CLAUDE.md: never a fixed date).
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
// A wall-clock time in Amsterdam → the instant, worked out here independently of lib/haulage-stops.js.
const amsterdamMs = local => {
  const guess = Date.parse(`${local}:00Z`);
  const off = at => {
    const n = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Amsterdam", timeZoneName: "longOffset" }).formatToParts(new Date(at))
      .find(p => p.type === "timeZoneName").value.replace("GMT", "") || "+00:00";
    const m = /([+-])(\d{2}):(\d{2})/.exec(n);
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  };
  return guess - off(guess - off(guess) * 60000) * 60000;
};

(async () => {
  const cleanup = { shipments: [], customers: [], facilities: [] };
  let token;
  try {
    // ─── Pure rules ────────────────────────────────────────────────────────────
    console.log("\nPure: the SMDG reader, the checks, the old waypoints");
    const csv = [
      "UNLOCODE,Alternative UNLOCODE,Terminal Code,Terminal Facility Name,Terminal Company Name,Latitude (DMS),Longitude (DMS),Latitude,Longitude,Last change,Valid from,Valid to,Terminal Website,Terminal Address,Remarks",
      `NLRTM,,QA${rand},TEST TERMINAL ALPHA ${rand},TEST OPERATOR,"51°57'15"" N","004°00'12"" E",51.954167,4.003333,2026-11-01,2014-08-26,,https://example.test,"Testweg 1, Port number 1, 3199 LC Maasvlakte Rotterdam, The Netherlands",`,
      `NLRTM,,QB${rand},TEST TERMINAL BETA ${rand},TEST OPERATOR,,,51.95,4.01,,2010-01-01,2020-12-31,,"Testweg 2, Rotterdam","Closed, merged into ""Alpha"""`,
      `XX,,,No code,,,,,,,,,,,`,
    ].join("\r\n");
    const parsed = parseSmdg(csv);
    assert("the SMDG reader takes the rows by their column names, quotes and commas included", parsed.rows.length === 2 && parsed.skipped === 1
      && parsed.rows[0].address === "Testweg 1, Port number 1, 3199 LC Maasvlakte Rotterdam, The Netherlands" && parsed.rows[1].remarks === 'Closed, merged into "Alpha"'
      && parsed.rows[0].latitude === 51.954167 && parsed.rows[0].id === `FAC-SMDG-NLRTM-QA${rand}`, JSON.stringify(parsed).slice(0, 400));
    assert("…and refuses a file that isn't the list", !!parseSmdg("a,b,c\n1,2,3").error);
    // A copy re-saved in a spreadsheet (2026-11-22: the user's upload had 1/19/2022): the file's own dates tell the order.
    const H = "UNLOCODE,Terminal Code,Terminal Facility Name,Last change,Valid from,Valid to";
    const dates = rows => { const p = parseSmdg([H, ...rows].join("\n")); return { order: p.dates.order, unreadable: p.dates.unreadable, d: p.rows.map(r => [r.lastChange, r.validFrom, r.validTo].join("|")) }; };
    const iso = dates(["NLRTM,A,Alpha,2026-11-01,2014-08-26,", "NLRTM,B,Beta,,2010-01-01,2020-12-31"]);
    assert("the list's own ISO dates read as before", iso.order === "ISO" && iso.unreadable === 0 && iso.d.join() === "2026-11-01|2014-08-26|,|2010-01-01|2020-12-31", JSON.stringify(iso));
    const us = dates(["NLRTM,A,Alpha,11/1/2026,8/26/2014,", "NLRTM,B,Beta,,1/1/2010,12/31/2020"]);
    assert("an Excel (US) re-save: 8/26/2014 can only be month first, so 11/1/2026 is 1 November", us.order === "M/D/Y" && us.d.join() === iso.d.join(), JSON.stringify(us));
    const eu = dates(["NLRTM,A,Alpha,01.11.2026,26.08.2014,", "NLRTM,B,Beta,,01.01.2010,31.12.2020"]);
    assert("a European re-save with dots: day first, the same dates", eu.order === "D/M/Y" && eu.d.join() === iso.d.join(), JSON.stringify(eu));
    const twoDigit = dates(["NLRTM,A,Alpha,1/19/22 0:00,10/5/12 12:00 AM,"]);
    assert("two-digit years and a time after the date", twoDigit.d[0] === "2022-01-19|2012-10-05|", JSON.stringify(twoDigit));
    const ambiguous = dates(["NLRTM,A,Alpha,11/1/2026,8/6/2014,"]);
    assert("every date ambiguous: left empty and counted, never guessed", ambiguous.order === "unknown" && ambiguous.unreadable === 2 && ambiguous.d[0] === "||", JSON.stringify(ambiguous));
    const mixed = dates(["NLRTM,A,Alpha,13/1/2026,1/13/2014,"]);
    assert("both orders in one file: left empty and counted", mixed.order === "mixed" && mixed.unreadable === 2, JSON.stringify(mixed));
    const impossible = dates(["NLRTM,A,Alpha,2/30/2022,1/19/2022,"]);
    assert("a day that doesn't exist (30 February) is left empty and counted; the rest read", impossible.unreadable === 1 && impossible.d[0] === "|2022-01-19|", JSON.stringify(impossible));
    // A spreadsheet also drops a code's leading zeros (2026-11-23: the user's copy had Weihai Port as CNWEI 1, the list 00001).
    const sheet = parseSmdg([H, "CNWEI,1,WEIHAI PORT,4/16/2019,5/31/2004,", "BEANR,1700,ANTWERP TERMINAL,,1/19/2022,", "NLRTM,ECT,ECT DELTA,,1/19/2022,"].join("\n"));
    assert("a spreadsheet re-save is recognised by its dates, and its digit-only codes listed (they may have lost zeros)",
      sheet.spreadsheet === true && sheet.digitCodes.join() === "CNWEI 1,BEANR 1700", JSON.stringify({ s: sheet.spreadsheet, d: sheet.digitCodes }));
    const listFile = parseSmdg([H, "CNWEI,00001,WEIHAI PORT,2019-04-16,2004-05-31,"].join("\n"));
    assert("…the list's own file isn't (no warning for its 00001)", listFile.spreadsheet === false && listFile.digitCodes.length === 0, JSON.stringify(listFile.digitCodes));
    const known = [{ unlocode: "CNWEI", code: "00001" }, { unlocode: "BEANR", code: "1700" }];
    assert("CNWEI 1 from a spreadsheet is the CNWEI 00001 already here (same port, equal without zeros)",
      zeroTwinOf({ unlocode: "CNWEI", code: "1" }, known, true)?.code === "00001");
    assert("…not from the list's own file, not at another port, not for a code with letters, not 1700 for 17",
      !zeroTwinOf({ unlocode: "CNWEI", code: "1" }, known, false) && !zeroTwinOf({ unlocode: "CNSHA", code: "1" }, known, true)
        && !zeroTwinOf({ unlocode: "CNWEI", code: "1A" }, known, true) && !zeroTwinOf({ unlocode: "BEANR", code: "17" }, known, true));
    const tz = "Europe/Amsterdam";
    const stops = [{ id: "e", purpose: "EMPTY_PICKUP", timezone: tz }, { id: "d", purpose: "LOAD", timezone: tz }, { id: "g", purpose: "FULL_GATE_IN", timezone: tz }];
    const cut = { FCO: limitOf("2026-10-24T12:00:00Z", "carrier"), VCO: limitOf("2026-10-23T12:00:00Z", "carrier") };
    const ok1 = checksFor({ side: "Export", stops, times: { g: { plannedIn: "2026-10-23T13:30" } }, tzOf: s => s.timezone, cut, container: { vgm_method: "Method 1" } });
    assert("a gate-in on Fri 23 Oct 13:30 Rotterdam time is 24 h 30 m before the CY cut-off (Sat 14:00) and 30 m before the VGM cut-off",
      ok1.length === 2 && ok1[0].ok && ok1[0].text === "24 h 30 m before the CY cut-off" && ok1[1].ok && ok1[1].text === "30 m before the VGM cut-off", JSON.stringify(ok1));
    const typed = checksFor({ side: "Export", stops, times: { g: { plannedIn: "2026-10-24T09:00" } }, tzOf: s => s.timezone, cut, container: { vgm_method: "Method 2", cy_cutoff: "2026-10-23" } });
    assert("a typed date-only CY cut-off earlier than the carrier's wins: after the cut-off day; no VGM check for Method 2",
      typed.length === 1 && !typed[0].ok && typed[0].text === "after the CY cut-off day (Fri 23 Oct)", JSON.stringify(typed));
    const dem = checksFor({ side: "Import", stops: [{ id: "p", purpose: "FULL_PICKUP", timezone: tz }, { id: "r", purpose: "EMPTY_RETURN", timezone: tz }],
      times: { p: { plannedOut: "2026-11-10T10:00" }, r: { plannedIn: "2026-11-12T10:00" } }, tzOf: s => s.timezone,
      container: { dest_free_time_days: 4, dest_detention_free_days: 1 }, discharge: { ms: Date.parse("2026-11-05T00:00:00Z") } });
    assert("import: a full pick-up after the 4 free days at the terminal, an empty return after 1 detention day: both flagged",
      dem.length === 2 && !dem[0].ok && dem[0].key === "DEM" && /after the terminal free time$/.test(dem[0].text) && !dem[1].ok && dem[1].key === "DET_DEST", JSON.stringify(dem));
    const legacy = legacyToStops({ gate_in_at: "2026-09-01T16:00", gate_out_at: "2026-09-01T07:30" },
      [{ id: "w1", loc_type: "Door", location: "Waalhaven Oostzijde 81, Rotterdam", notes: "" }, { id: "w2", loc_type: "GPS Coordinates", latitude: 51.95, longitude: 4.0, notes: "gate 3" }]);
    assert("G: old waypoints become Other stops (a GPS one keeps its point), the gate out on the first, the gate in on the last",
      legacy.stops.length === 2 && legacy.stops[0].placeName === "Waalhaven Oostzijde 81, Rotterdam" && legacy.stops[0].purpose === "OTHER"
      && legacy.stops[1].placeKind === "gps" && legacy.stops[1].latitude === 51.95 && legacy.stops[1].notes === "Was: GPS Coordinates · gate 3"
      && legacy.times[0].actualOut === "2026-09-01T07:30" && legacy.times[1].actualIn === "2026-09-01T16:00", JSON.stringify(legacy));

    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);

    // ─── Facilities ────────────────────────────────────────────────────────────
    console.log("\nMaster Data → Facilities: the SMDG list and depots");
    const imp = await request("POST", "/api/facilities/import-smdg", { csv }, token);
    assert("an admin imports the SMDG list from an uploaded file", imp.status === 200 && imp.body.added === 2 && imp.body.skipped === 1, JSON.stringify(imp.body).slice(0, 300));
    cleanup.facilities.push(`FAC-SMDG-NLRTM-QA${rand}`, `FAC-SMDG-NLRTM-QB${rand}`);
    const again = await request("POST", "/api/facilities/import-smdg", { csv }, token);
    assert("…a second import updates the same rows, adds none", again.body.added === 0 && again.body.updated === 2, JSON.stringify(again.body).slice(0, 200));
    const bad = await request("POST", "/api/facilities/import-smdg", { csv: "name,code\nx,y" }, token);
    assert("…a file that isn't the list is refused (400)", bad.status === 400, JSON.stringify(bad.body));
    // The list's file with a zero-padded code, then a spreadsheet's copy of it that lost the zeros (2026-11-23).
    const digits = String(1000 + Math.floor(Math.random() * 8999));
    const zH = "UNLOCODE,Terminal Code,Terminal Facility Name,Last change,Valid from,Valid to";
    const padded = await request("POST", "/api/facilities/import-smdg", { csv: `${zH}\nNLRTM,00${digits},TEST ZERO TERMINAL Z${digits},2026-11-01,2014-08-26,` }, token);
    cleanup.facilities.push(`FAC-SMDG-NLRTM-00${digits}`);
    const fromSheet = await request("POST", "/api/facilities/import-smdg", { csv: `${zH}\nNLRTM,${digits},TEST ZERO TERMINAL Z${digits},11/1/2026,8/26/2014,` }, token);
    const zeroRows = (await request("GET", `/api/facilities?unlocode=NLRTM&q=${encodeURIComponent(`TEST ZERO TERMINAL Z${digits}`)}`, null, token)).body;
    assert("a spreadsheet's copy whose code lost its zeros (NLRTM " + digits + ") keeps the terminal already here (00" + digits + "): no duplicate, and the answer says so",
      padded.body?.added === 1 && fromSheet.status === 200 && fromSheet.body.added === 0 && fromSheet.body.leadingZeros?.spreadsheet === true
        && fromSheet.body.leadingZeros.kept?.[0]?.kept === `NLRTM 00${digits}` && fromSheet.body.leadingZeros.digitCodes?.includes(`NLRTM ${digits}`)
        && Array.isArray(zeroRows) && zeroRows.length === 1 && zeroRows[0].code === `00${digits}`,
      JSON.stringify({ padded: padded.body, fromSheet: fromSheet.body, zeroRows }).slice(0, 500));
    if (Array.isArray(zeroRows)) for (const z of zeroRows) if (z.id !== `FAC-SMDG-NLRTM-00${digits}`) cleanup.facilities.push(z.id);
    const openList = (await request("GET", `/api/facilities?unlocode=NLRTM&open=1&q=${rand}`, null, token)).body;
    assert("the picker lists the open terminal, not the one past its Valid to", openList.length === 1 && openList[0].code === `QA${rand}` && openList[0].codeList === "SMDG",
      JSON.stringify(openList).slice(0, 300));
    const smdgEdit = await request("PUT", `/api/facilities/FAC-SMDG-NLRTM-QA${rand}`, { name: "Renamed" }, token);
    assert("an SMDG row changes only with the next import (409)", smdgEdit.status === 409, JSON.stringify(smdgEdit.body));
    const off = await request("PUT", `/api/facilities/FAC-SMDG-NLRTM-QB${rand}`, { isActive: false }, token);
    assert("…but can be switched off", off.status === 200 && off.body.isActive === false, JSON.stringify(off.body).slice(0, 200));
    const depotBad = await request("POST", "/api/facilities", { kind: "DEPOT", name: "No port", unlocode: "RTM" }, token);
    assert("a depot needs a UN/LOCODE (400)", depotBad.status === 400, JSON.stringify(depotBad.body));
    const codeBad = await request("POST", "/api/facilities", { kind: "DEPOT", name: "Coded", unlocode: "NLRTM", code: "ABC" }, token);
    assert("…and a code says which list it's from (400)", codeBad.status === 400, JSON.stringify(codeBad.body));
    const depot = (await request("POST", "/api/facilities", { kind: "DEPOT", name: `Waalhaven Empty Depot ${rand}`, unlocode: "NLRTM",
      address: "Waalhaven Zuidzijde 21, 3089 JH Rotterdam", operator: "Test depot operator" }, token)).body;
    assert("a depot is added by hand", !!depot?.id && depot.source === "manual" && depot.kind === "DEPOT", JSON.stringify(depot).slice(0, 200));
    if (depot?.id) cleanup.facilities.push(depot.id);
    const status = (await request("GET", "/api/facilities/status", null, token)).body;
    assert("the status counts the SMDG rows and when they were imported", status.smdgCount >= 2 && !!status.smdgImportedAt, JSON.stringify(status));

    // ─── The shipment ──────────────────────────────────────────────────────────
    const customer = async (body, contacts = []) => {
      const c = (await request("POST", "/api/customers", body, token)).body;
      if (!c?.id) throw new Error(`scratch customer not created: ${JSON.stringify(c)}`);
      cleanup.customers.push(c.id);
      for (const k of contacts) await request("POST", `/api/customers/${c.id}/contacts`, k, token);
      return c;
    };
    const shipper = await customer({ companyName: `Van Leeuwen Meubelen ${rand} BV`, address1: "Waalhaven Oostzijde 81", postalCode: "3087 BM", city: "Rotterdam",
      countryIso2: "NL", phone: "+31 10 428 1100", email: "logistics@vanleeuwen.example" },
      [{ name: "Sanne de Boer", phone: "+31 6 1234 5678", email: "sanne@vanleeuwen.example", department: "Operations" }]);
    const consignee = await customer({ companyName: `Hudson Home Imports ${rand} Inc`, address1: "1 Harmon Meadow Blvd", postalCode: "07094", city: "Secaucus",
      state: "NJ", countryIso2: "US", phone: "+1 201 555 0188" });
    const trucker = await customer({ companyName: `ACME Trucking ${rand} BV`, address1: "Vaanweg 120", postalCode: "3089 KR", city: "Rotterdam", countryIso2: "NL",
      phone: "+31 10 555 0190", email: "planning@acme-trucking.example" });
    const trucker2 = await customer({ companyName: `Maasvlakte Transport ${rand} BV`, address1: "Europaweg 10", postalCode: "3199 LC", city: "Rotterdam", countryIso2: "NL",
      phone: "+31 10 555 0191", email: "ops@mvtransport.example" });

    const etd = day(14), eta = day(27);
    const s = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central",
      contractRef: "MAEU-SC-2026-0418", etd, eta, incoterm: "FOB", freightTerms: "Collect", commodityCode: "9999",
      shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId }, token);
    if (!s.body?.id) throw new Error(`scratch shipment not created: ${JSON.stringify(s.body)}`);
    const sid = s.body.id;
    cleanup.shipments.push(sid);
    const typedCy = day(11);
    const c1 = (await request("POST", "/api/containers", { shipmentId: sid, containerNumber: `MSKU${String(Date.now()).slice(-6)}1`, size: "40", type: "HC",
      hsCode: "940360", cargoDescription: "Wooden dining furniture, flat-packed", grossWeightKg: 11850, numberOfPackages: 120, packageCode: "CT",
      vgmWeightKg: 15620, vgmMethod: "Method 1", destFreeTimeDays: 4, destDetentionFreeDays: 6 }, token)).body;
    const c2 = (await request("POST", "/api/containers", { shipmentId: sid, containerNumber: `MSKU${String(Date.now()).slice(-6)}2`, size: "40", type: "HC",
      hsCode: "940360", cargoDescription: "Wooden dining furniture, flat-packed", grossWeightKg: 12940, numberOfPackages: 120, packageCode: "CT",
      vgmWeightKg: 16690, vgmMethod: "Method 2", cyCutoff: typedCy, destFreeTimeDays: 4, destDetentionFreeDays: 6 }, token)).body;
    const sea = { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd, eta, carrierCode: "MAEU", vessel: "MAERSK KENSINGTON", vesselImo: "9333022", voyage: `4${rand.slice(0, 2)}W` };
    const pickUpLeg = { legType: "Pick-up", movementType: "Merchant's Haulage", movementBy: "Truck", pol: "NLRTM", polName: "Rotterdam", polLocType: "Door",
      pod: "NLRTM", podLocType: "Terminal", etd: day(11), eta: day(11) };
    const deliveryLeg = { legType: "Delivery", movementType: "Merchant's Haulage", movementBy: "Truck", pol: "USNYC", polLocType: "Terminal",
      pod: "USSEC", podName: "Secaucus", podLocType: "Door", etd: day(29), eta: day(29) };
    const legs = await request("PUT", `/api/shipments/${sid}/legs`, { legs: [pickUpLeg, sea, deliveryLeg] }, token);
    assert("the route is saved: Merchant's Haulage from the shipper's door, the sea leg, Merchant's Haulage to the consignee's door",
      legs.status === 200, JSON.stringify(legs.body).slice(0, 300));

    // ─── C: the trucker ────────────────────────────────────────────────────────
    console.log("\nC: the trucker is the Pickup service's vendor; the Trucker party follows it");
    const svc = (await request("POST", `/api/shipments/${sid}/services`, { side: "Export", serviceType: "Pickup", vendorId: trucker.id, vendorName: trucker.companyName }, token)).body;
    const party = async role => ((await request("GET", `/api/shipments/${sid}/parties`, null, token)).body || []).find(p => p.role === role);
    assert("ordering the Pickup service with a vendor sets the Trucker (Pre-carriage) party", (await party("Trucker (Pre-carriage)"))?.customerId === trucker.id);
    await request("PATCH", `/api/shipments/${sid}/services/${svc.id}`, { vendorId: trucker2.id, vendorName: trucker2.companyName }, token);
    const p2 = await party("Trucker (Pre-carriage)");
    assert("…changing the vendor changes the party", p2?.customerId === trucker2.id, JSON.stringify(p2));
    await request("PUT", `/api/shipments/${sid}/parties/${p2.id}`, { customerId: trucker.id, customerName: trucker.companyName }, token);
    const svcBack = ((await request("GET", `/api/shipments/${sid}/services`, null, token)).body || []).find(x => x.id === svc.id);
    assert("…and the party set on Parties & Offices becomes the vendor", svcBack?.vendorId === trucker.id, JSON.stringify(svcBack).slice(0, 200));

    // ─── E: the carrier's cut-offs ─────────────────────────────────────────────
    console.log("\nE: the carrier's confirmation fills the empty cut-offs; a typed one stays");
    const booked = await bookThroughCarrier(request, token, sid, "confirm");
    assert("the booking is confirmed by the carrier", booked.act?.status === 200, JSON.stringify(booked.act?.body).slice(0, 200));
    let ctrs = [];
    for (let i = 0; i < 40; i++) {
      ctrs = ((await request("GET", "/api/containers", null, token)).body || []);
      ctrs = (Array.isArray(ctrs) ? ctrs : ctrs.results || []).filter(c => c.shipmentId === sid);
      if (ctrs.find(c => c.id === c1.id)?.cyCutoff) break;
      await sleep(250);
    }
    const bk = (await request("GET", `/api/shipments/${sid}/carrier-booking`, null, token)).body;
    const plan0 = (await request("GET", `/api/shipments/${sid}/services/${svc.id}/haulage-plan`, null, token)).body;
    const dl = code => plan0.deadlines?.find(d => d.code === code);
    const fco = dl("FCO"), vco = dl("VCO"), dco = dl("DCO");
    const k1 = ctrs.find(c => c.id === c1.id), k2 = ctrs.find(c => c.id === c2.id);
    assert("the confirmation's CY delivery cut-off fills MSKU…1's empty CY cut-off", !!fco?.carrier && k1?.cyCutoff === fco.carrier.slice(0, 16), `${k1?.cyCutoff} vs ${fco?.carrier}`);
    assert("…and its VGM cut-off the empty VGM cut-off", !!vco?.carrier && k1?.vgmCutoff === vco.carrier.slice(0, 16), `${k1?.vgmCutoff} vs ${vco?.carrier}`);
    assert("…the CY cut-off typed on MSKU…2 stays", k2?.cyCutoff === typedCy, k2?.cyCutoff);
    assert("…and is flagged on the plan because it differs from the carrier's", fco?.typed?.some(t => t.containerId === c2.id && t.differs) && !fco.typed.some(t => t.containerId === c1.id && t.differs),
      JSON.stringify(fco?.typed));
    const fcoLocal = (() => {
      const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
        minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(fco.carrier)).map(x => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
    })();
    assert("the CY cut-off is shown in Rotterdam time", fco?.local === fcoLocal, `${fco?.local} vs ${fcoLocal}`);
    assert("A: the documentation cut-off is on the page but not printed for the trucker", !!dco?.carrier && dco.printed === false, JSON.stringify(dco));
    assert("…the VGM cut-off is printed, for the Method 1 container only", vco?.printed === true && vco.weighed?.length === 1 && vco.weighed[0] === c1.containerNumber,
      JSON.stringify(vco));
    assert("…the CY cut-off is printed", fco?.printed === true);
    assert("the plan names the trucker, the booking and the merchant's haulage", plan0.trucker?.name === trucker.companyName && plan0.trucker.email === "planning@acme-trucking.example"
      && !!bk?.bookingRef && plan0.bookingRef === bk.bookingRef && plan0.merchantHaulage === true && plan0.port?.timezone === "Europe/Amsterdam", JSON.stringify({ t: plan0.trucker, b: plan0.bookingRef, m: plan0.merchantHaulage, p: plan0.port }));

    // ─── The usual stops ───────────────────────────────────────────────────────
    console.log("\nThe usual stops, places and times");
    const doorDate = `${day(10)}T09:00`;
    await request("PUT", `/api/shipments/${sid}/services/${svc.id}/loading-plan/${c1.id}`, { plannedDate: doorDate, sequenceOrder: 1 }, token);
    const usual = await request("POST", `/api/shipments/${sid}/services/${svc.id}/haulage-stops/usual`, {}, token);
    const st = usual.body?.stops || [];
    assert("the usual stops: empty pick-up, load at the shipper's door, full gate-in", usual.status === 201
      && st.map(x => x.purpose).join(",") === "EMPTY_PICKUP,LOAD,FULL_GATE_IN", JSON.stringify(usual.body).slice(0, 300));
    assert("…the door is the shipper's profile, with its Operations contact", st[1]?.place?.kind === "customer" && st[1].place.name === shipper.companyName
      && st[1].contact?.name === "Sanne de Boer" && st[1].place.lines?.[0] === "Waalhaven Oostzijde 81", JSON.stringify(st[1]).slice(0, 300));
    assert("…the depot and the terminal are still to choose (the demo carrier names neither)", st[0]?.warnings?.includes("Choose the depot") && st[2]?.place?.kind === "none"
      && st[2].unlocode === "NLRTM", JSON.stringify([st[0]?.warnings, st[2]?.place, st[2]?.unlocode]));
    assert("…the gate stops quote the booking", st[0]?.effectiveReference === `Booking ${bk?.bookingRef}`, st[0]?.effectiveReference);
    const u1 = usual.body.containers.find(c => c.id === c1.id);
    assert("…the plan date the service had for MSKU…1 is the door's planned arrival", u1?.times?.[st[1].id]?.plannedIn === doorDate, JSON.stringify(u1?.times?.[st[1]?.id]));
    const again2 = await request("POST", `/api/shipments/${sid}/services/${svc.id}/haulage-stops/usual`, {}, token);
    assert("…not twice (409)", again2.status === 409);

    const put = (id, b) => request("PUT", `/api/shipments/${sid}/services/${svc.id}/haulage-stops/${id}`, b, token);
    const r1 = await put(st[0].id, { place: { kind: "facility", facilityId: depot.id } });
    const r3 = await put(st[2].id, { place: { kind: "facility", facilityId: `FAC-SMDG-NLRTM-QA${rand}` } });
    const ps = r3.body?.stops || [];
    assert("the depot and the SMDG terminal are chosen from Master Data", r1.status === 200 && ps[0]?.place?.name === depot.name
      && ps[2]?.place?.code === `QA${rand}` && ps[2].place.codeList === "SMDG" && ps[2].warnings.length === 0, JSON.stringify(ps.map(x => x.place)).slice(0, 400));
    const badPlace = await put(st[2].id, { place: { kind: "gps", latitude: 120, longitude: 4 } });
    assert("a GPS point out of range is refused (400)", badPlace.status === 400, JSON.stringify(badPlace.body));

    const times = (cid, stopId, b) => request("PUT", `/api/shipments/${sid}/services/${svc.id}/haulage-times/${cid}/${stopId}`, b, token);
    const gate1 = `${day(12)}T08:00`;
    const tA = await times(c1.id, st[2].id, { plannedIn: gate1 });
    const checks1 = tA.body?.containers?.find(c => c.id === c1.id)?.checks || [];
    const fcoMs = Date.parse(fco.carrier), vcoMs = Date.parse(vco.carrier), g1 = amsterdamMs(gate1);
    assert("MSKU…1's gate-in: before the CY cut-off, and (Method 1) checked against the VGM cut-off",
      checks1.find(c => c.key === "FCO")?.ok === (g1 <= fcoMs) && checks1.find(c => c.key === "VCO")?.ok === (g1 <= vcoMs) && checks1.length === 2, JSON.stringify(checks1));
    const late = await times(c2.id, st[2].id, { plannedIn: `${day(12)}T10:00` });
    const checks2 = late.body?.containers?.find(c => c.id === c2.id)?.checks || [];
    assert("MSKU…2's gate-in after its typed CY cut-off day is flagged; no VGM check (Method 2)", checks2.length === 1 && checks2[0].key === "FCO" && checks2[0].ok === false
      && checks2[0].text.startsWith("after the CY cut-off day"), JSON.stringify(checks2));
    const badTime = await times(c1.id, st[1].id, { plannedIn: "tomorrow" });
    assert("a time that isn't YYYY-MM-DDTHH:mm is refused (400)", badTime.status === 400, JSON.stringify(badTime.body));
    const backwards = await times(c1.id, st[1].id, { plannedIn: `${day(10)}T11:00`, plannedOut: `${day(10)}T09:00` });
    assert("a planned out before the planned in is refused (400)", backwards.status === 400, JSON.stringify(backwards.body));

    // ─── B: one container's own stops ──────────────────────────────────────────
    console.log("\nB: a container gets its own stops");
    const own = await request("POST", `/api/shipments/${sid}/services/${svc.id}/haulage/${c2.id}/own-stops`, { own: true }, token);
    const o2 = own.body?.containers?.find(c => c.id === c2.id);
    assert("MSKU…2 gets a copy of the stops, with its times", o2?.ownStops === true && o2.stops?.length === 3 && o2.stops[2].place.code === `QA${rand}`
      && Object.values(o2.times).some(t => t.plannedIn.endsWith("T10:00")), JSON.stringify(o2).slice(0, 400));
    const customs = await request("POST", `/api/shipments/${sid}/services/${svc.id}/haulage-stops`, { containerId: c2.id, purpose: "CUSTOMS",
      place: { kind: "address", name: "Douane Rotterdam Haven", address: "Kruisplein 25, Rotterdam" }, notes: "Export inspection" }, token);
    const o2b = customs.body?.containers?.find(c => c.id === c2.id);
    assert("…a customs stop is added to its own stops only", customs.status === 201 && o2b?.stops?.length === 4 && customs.body.stops.length === 3, JSON.stringify(customs.body).slice(0, 200));
    const wrong = await times(c2.id, st[0].id, { plannedIn: `${day(11)}T07:00` });
    assert("…a shared stop's time can't be set for it now (409)", wrong.status === 409, JSON.stringify(wrong.body));
    const back = await request("POST", `/api/shipments/${sid}/services/${svc.id}/haulage/${c2.id}/own-stops`, { own: false }, token);
    assert("…and it follows the shared stops again", back.body?.containers?.find(c => c.id === c2.id)?.ownStops === false);

    // ─── Order, actuals, the record, removal ───────────────────────────────────
    console.log("\nOrder, an actual time, the truck, removing");
    const order = ids => request("POST", `/api/shipments/${sid}/services/${svc.id}/haulage-stops/order`, { ids }, token);
    assert("a reorder must name every stop once (400)", (await order([st[0].id])).status === 400);
    const re = await order([st[1].id, st[0].id, st[2].id]);
    assert("the stops are reordered", re.body?.stops?.map(x => x.id).join() === [st[1].id, st[0].id, st[2].id].join());
    await order([st[0].id, st[1].id, st[2].id]);
    const outAt = `${day(-1)}T05:10:00Z`;
    await request("POST", `/api/shipments/${sid}/containers/${c1.id}/events`, { eventType: "Empty Pickup", occurredAt: outAt, location: "NLRTM" }, token);
    const withEvent = (await request("GET", `/api/shipments/${sid}/services/${svc.id}/haulage-plan`, null, token)).body;
    const tEmpty = withEvent.containers.find(c => c.id === c1.id).times[st[0].id];
    assert("an Empty Pickup event is the empty pick-up's actual gate out, in Rotterdam time", tEmpty.actualOutSource === "event"
      && Math.abs(amsterdamMs(tEmpty.actualOut) - Date.parse(outAt)) < 60000, JSON.stringify(tEmpty));
    await request("PUT", `/api/shipments/${sid}/services/${svc.id}/haulage/${c1.id}`, { truckPlate: "BX-123-Z", driverName: "Kees Visser" }, token);
    const rec = (await request("GET", `/api/shipments/${sid}/services/${svc.id}/haulage-plan`, null, token)).body.containers.find(c => c.id === c1.id).record;
    assert("the truck's plate and the driver are kept per container", rec.truckPlate === "BX-123-Z" && rec.driverName === "Kees Visser", JSON.stringify(rec));
    const inUse = await request("DELETE", `/api/facilities/${depot.id}`, null, token);
    assert("a depot a stop uses can't be removed (409)", inUse.status === 409, JSON.stringify(inUse.body));
    const extra = await request("POST", `/api/shipments/${sid}/services/${svc.id}/haulage-stops`, { purpose: "WEIGH", place: { kind: "gps", name: "Weighbridge", latitude: 51.9, longitude: 4.3 } }, token);
    const extraId = extra.body.stops.find(x => x.purpose === "WEIGH")?.id;
    const del = await request("DELETE", `/api/shipments/${sid}/services/${svc.id}/haulage-stops/${extraId}`, null, token);
    assert("a stop is removed and the rest keep their order", del.status === 200 && del.body.stops.map(x => x.sequenceOrder).join() === "1,2,3", JSON.stringify(del.body.stops?.map(x => x.sequenceOrder)));

    // ─── F: Delivery ───────────────────────────────────────────────────────────
    console.log("\nF: a Delivery run");
    const dsvc = (await request("POST", `/api/shipments/${sid}/services`, { side: "Import", serviceType: "Delivery", vendorId: trucker2.id, vendorName: trucker2.companyName }, token)).body;
    assert("the Delivery service's vendor is the Trucker (On-carriage)", (await party("Trucker (On-carriage)"))?.customerId === trucker2.id);
    const du = await request("POST", `/api/shipments/${sid}/services/${dsvc.id}/haulage-stops/usual`, {}, token);
    const ds = du.body?.stops || [];
    assert("the usual stops: full pick-up at the terminal, unload at the consignee's door, empty return", ds.map(x => x.purpose).join(",") === "FULL_PICKUP,UNLOAD,EMPTY_RETURN"
      && ds[1]?.place?.name === consignee.companyName && ds[0]?.unlocode === "USNYC", JSON.stringify(ds.map(x => [x.purpose, x.place?.name, x.unlocode])));
    assert("…its closing times are the arrival and the free days", du.body?.deadlines?.map(d => d.code).join() === "ETA,DEM,DET"
      && du.body.deadlines[1].display === "4 days", JSON.stringify(du.body?.deadlines));
    const dt = (cid, stopId, b) => request("PUT", `/api/shipments/${sid}/services/${dsvc.id}/haulage-times/${cid}/${stopId}`, b, token);
    await dt(c1.id, ds[0].id, { plannedIn: `${day(33)}T08:00`, plannedOut: `${day(33)}T09:00` });
    const dr = await dt(c1.id, ds[2].id, { plannedIn: `${day(35)}T15:00` });
    const dchecks = dr.body?.containers?.find(c => c.id === c1.id)?.checks || [];
    assert("a full pick-up 6 days after arrival is past the 4 free days; the empty return 2 days later is within detention",
      dchecks.find(c => c.key === "DEM")?.ok === false && dchecks.find(c => c.key === "DET_DEST")?.ok === true, JSON.stringify(dchecks));

    // ─── The audit's fixes (2026-11-21, epic TKT-YQQWJR) ─────────────────────────
    console.log("\nAudit fixes: A1, A2, A3, A6");
    await request("PATCH", `/api/shipments/${sid}/services/${svc.id}`, { vendorId: "", vendorName: "Kees' Trucks (typed)" }, token);
    const typedPlan = (await request("GET", `/api/shipments/${sid}/services/${svc.id}/haulage-plan`, null, token)).body;
    assert("A1: a vendor typed as free text clears the Trucker (Pre-carriage) party, and the plan says it isn't in Master Data",
      !(await party("Trucker (Pre-carriage)")) && typedPlan.trucker?.name === "Kees' Trucks (typed)" && typedPlan.trucker.inMasterData === false,
      JSON.stringify(typedPlan.trucker));
    await request("PATCH", `/api/shipments/${sid}/services/${svc.id}`, { vendorId: trucker.id, vendorName: trucker.companyName }, token);
    assert("…choosing a customer again sets it back", (await party("Trucker (Pre-carriage)"))?.customerId === trucker.id);
    await request("PATCH", `/api/shipments/${sid}/services/${dsvc.id}`, { status: "Cancelled" }, token);
    assert("A2: cancelling the Delivery service releases its Trucker (On-carriage) party", !(await party("Trucker (On-carriage)")));
    await request("PATCH", `/api/shipments/${sid}/services/${dsvc.id}`, { status: "Requested" }, token);
    assert("…and ordering it again brings it back", (await party("Trucker (On-carriage)"))?.customerId === trucker2.id);
    const wrongSide = await request("POST", `/api/shipments/${sid}/services`, { side: "Import", serviceType: "Pickup" }, token);
    assert("A6: a Pickup on the Import side is refused (400)", wrongSide.status === 400 && /Export side only/.test(wrongSide.body?.error), JSON.stringify(wrongSide.body));
    const moved = await request("PATCH", `/api/shipments/${sid}/services/${dsvc.id}`, { side: "Export" }, token);
    assert("…and so is moving the Delivery to the Export side (400)", moved.status === 400 && /Import side only/.test(moved.body?.error), JSON.stringify(moved.body));
    const statusOnly = await request("PATCH", `/api/shipments/${sid}/services/${dsvc.id}`, { status: "Confirmed" }, token);
    assert("…a status change alone still goes through", statusOnly.status === 200 && statusOnly.body.status === "Confirmed");
    const qaParts = (await request("GET", `/api/shipments/${sid}/qa-export`, null, token)).body?.parts || [];
    const qaCount = t => qaParts.find(p => p.table === t)?.count || 0;
    assert("A3: the QA export holds the stops of both services and their times", qaCount("haulage_stops") === 6 && qaCount("haulage_stop_times") > 0,
      JSON.stringify(qaParts.filter(p => /haulage/.test(p.table))));
    const qaFile = (await request("POST", `/api/shipments/${sid}/qa-export`, { whatWentWrong: "Audit A3: the stops must come along." }, token)).body;
    const imported = await request("POST", "/api/shipment-import", { file: qaFile }, token);
    const importedId = imported.body?.shipmentId;
    if (importedId) cleanup.shipments.push(importedId);
    const impSvc = ((await request("GET", `/api/shipments/${importedId}/services`, null, token)).body || []).find(x => x.serviceType === "Pickup");
    const impPlan = impSvc ? (await request("GET", `/api/shipments/${importedId}/services/${impSvc.id}/haulage-plan`, null, token)).body : null;
    const impC1 = impPlan?.containers?.find(c => c.containerNumber === c1.containerNumber);
    assert("…and the import brings them: three stops, MSKU…1's door time, under the new ids", imported.status === 201 && impPlan?.stops?.length === 3
      && impPlan.stops[1].place?.name === shipper.companyName && impC1?.id !== c1.id && impC1?.times?.[impPlan.stops[1].id]?.plannedIn === doorDate,
      JSON.stringify({ s: imported.status, e: imported.body?.error, stops: impPlan?.stops?.length, t: impC1?.times?.[impPlan?.stops?.[1]?.id] }));

    // ─── BR01's doors ──────────────────────────────────────────────────────────
    console.log("\nBR01: the carrier's door, as the booking sends it");
    const mhDoors = (await request("GET", `/api/shipments/${sid}/booking-doors`, null, token)).body;
    assert("merchant's haulage: no carrier door on either side", mhDoors.origin === null && mhDoors.destination === null, JSON.stringify(mhDoors));
    const s2 = (await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central",
      contractRef: "MAEU-SC-2026-0418", etd, eta, incoterm: "FOB", freightTerms: "Collect", commodityCode: "9999",
      shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId }, token)).body;
    cleanup.shipments.push(s2.id);
    await request("POST", "/api/containers", { shipmentId: s2.id, containerNumber: `MSKU${String(Date.now()).slice(-6)}3`, size: "40", type: "HC",
      hsCode: "940360", cargoDescription: "Wooden dining furniture, flat-packed", grossWeightKg: 11850, numberOfPackages: 120, packageCode: "CT" }, token);
    await request("PUT", `/api/shipments/${s2.id}/legs`, { legs: [{ ...pickUpLeg, movementType: "Carrier's Haulage", podLocType: "Container Yard" }, sea] }, token);
    const chDoors = (await request("GET", `/api/shipments/${s2.id}/booking-doors`, null, token)).body;
    assert("carrier's haulage from the door: the shipper's address, its contact, details on the shipper party",
      chDoors.origin?.carrierHaulage === true && chDoors.origin.location?.address?.street === "Waalhaven Oostzijde 81" && chDoors.origin.contact?.name === "Sanne de Boer"
      && chDoors.origin.detailsOnParty === true && chDoors.destination === null, JSON.stringify(chDoors).slice(0, 400));

    console.log("\nAudit fixes: A2 (removed), A4");
    const s2svc = (await request("POST", `/api/shipments/${s2.id}/services`, { side: "Export", serviceType: "Pickup", vendorId: trucker2.id, vendorName: trucker2.companyName }, token)).body;
    await request("POST", `/api/shipments/${s2.id}/services/${s2svc.id}/haulage-stops/usual`, {}, token);
    const s2party = async () => ((await request("GET", `/api/shipments/${s2.id}/parties`, null, token)).body || []).find(p => p.role === "Trucker (Pre-carriage)");
    const hadParty = !!(await s2party());
    await request("DELETE", `/api/shipments/${s2.id}/services/${s2svc.id}`, null, token);
    assert("A2: removing the Pickup service releases the Trucker party it set", hadParty && !(await s2party()));
    const s2svc2 = (await request("POST", `/api/shipments/${s2.id}/services`, { side: "Export", serviceType: "Pickup" }, token)).body;
    await request("POST", `/api/shipments/${s2.id}/services/${s2svc2.id}/haulage-stops/usual`, {}, token);
    const del2 = await request("DELETE", `/api/shipments/${s2.id}`, null, token);
    const after = await request("GET", `/api/shipments/${s2.id}/services`, null, token);
    const afterPlan = await request("GET", `/api/shipments/${s2.id}/services/${s2svc2.id}/haulage-plan`, null, token);
    assert("A4: a deleted shipment takes its services along: its services and its plan answer 404", del2.status === 200 && after.status === 404 && afterPlan.status === 404,
      JSON.stringify([del2.status, after.status, afterPlan.status]));

    // Facilities are lookup rows (CLAUDE.md): take the stops off them, so they can go.
    for (const id of [st[0].id, st[2].id]) await put(id, { place: { kind: "none", unlocode: "NLRTM" } });
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    if (token) {
      for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
      for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token);
      for (const id of cleanup.facilities) {
        const r = await request("DELETE", `/api/facilities/${id}`, null, token);
        if (r.status !== 200) console.error(`  (facility ${id} not removed: ${r.status} ${JSON.stringify(r.body)})`);
      }
    }
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
