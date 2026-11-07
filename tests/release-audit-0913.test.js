/**
 * The 0.91.13 pre-release audit's fixes (epic TKT-YZ2EON, 2026-11-07):
 *   - A1 TKT-ZX70NT: a Central shipment's contract can't be taken off while the carrier holds a booking on it (sent
 *     and awaiting its answer, or confirmed): PUT /api/shipments/:id answers 409 BOOKING_WITH_CARRIER. Changing to
 *     another contract, or taking the contract off before the booking is sent, still works.
 *   - A2 TKT-72U6CG: the creator's active office becomes the controlling office of a shipment they create when it is
 *     neither managing office, so they can still open it; when it is one of them, nothing is added.
 * (A3, a contract Pick-up leg with no To, is in tests/contract-typed-legs.test.js and routing-lines.test.js.)
 *
 * Usage:
 *   node tests/release-audit-0913.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, not in production (the built-in DCSA carrier answers the booking)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

let passed = 0;
let failed = 0;

function request(method, path, body, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: 3001, path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
        ...headers,
      },
    };
    const req = http.request(opts, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function login(email, password) {
  const { status, body } = await request("POST", "/api/auth/login", { email, password });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

const inDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// What Contracts & Schedules' "Save and remove the contract" sends (ShipmentSchedulesPage.jsx commitDraft).
const dropOf = s => ({ ...s, contractType: "Central", contractId: "", contractRef: "", contractRoutingId: "", allocationId: "",
  spaceSkipReason: "", spaceOverageReason: "", spaceSelection: "", steeringReason: "" });

(async () => {
  const users = [];
  let admin;
  try {
    console.log("Logging in…");
    admin = await login("claudeagent@localhost", "TestFixture!2026Zq");
    console.log("  ✓ Logged in");
    const stamp = Date.now();
    const customer = async name => (await request("POST", "/api/customers", { companyName: `${name} ${stamp}` }, admin)).body;
    const shipper = await customer("Audit Fix Shipper BV"), consignee = await customer("Audit Fix Consignee Inc");
    const contract = async n => {
      const r = await request("POST", "/api/contracts", { contractNumber: `AUDITFIX-${n}-${stamp}`, carrierCode: "HLCU", status: "Active",
        validFrom: "2026-01-01", validTo: "2027-12-31", routings: [{ name: "" }], legs: [{ legType: "SEA", pol: "NLRTM", pod: "USNYC", routingIndex: 0 }],
        rates: [{ serviceCode: "OF", amount: 1500, currency: "USD", unit: "per_container" }] }, admin);
      if (r.status !== 201) throw new Error(`contract ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    };
    // A complete Central shipment NLRTM → USNYC on the contract, one 40HC, its sea leg with a vessel, voyage and dates.
    const shipment = async (c, tag) => {
      const s = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "HLCU", status: "Active", contractType: "Central",
        contractId: c.id, contractRef: c.contractNumber, etd: inDays(6), eta: inDays(16), cargoReadyDate: inDays(3), incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName }, admin);
      if (s.status !== 201) throw new Error(`shipment ${s.status} ${JSON.stringify(s.body)}`);
      const id = s.body.id;
      await request("POST", "/api/containers", { shipmentId: id, containerNumber: `AUFU${String(stamp).slice(-5)}${tag}`, size: "40", type: "HC",
        hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 }, admin);
      await request("PUT", `/api/shipments/${id}/legs`, { legs: [{ legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC", etd: inDays(6), eta: inDays(16),
        carrierCode: "HLCU", vessel: "AUDIT FIX", voyage: `AF${tag}W` }] }, admin);
      // No shipment_schedules row: a saved real sailing on NLRTM → USNYC would show in every schedule search on the lane
      // (the catalog comes first) and hide the demo sailings later tests expect; the sea leg with its ETD is enough for the booking.
      return id;
    };
    const confirmBooking = async id => {
      const sent = await request("POST", `/api/shipments/${id}/edi-messages/booking-request`, {}, admin);
      if (sent.status !== 201) throw new Error(`booking request ${sent.status} ${JSON.stringify(sent.body)}`);
      let ref = "";
      for (let i = 0; i < 40 && !ref; i++) {
        const b = (await request("GET", `/api/shipments/${id}/carrier-booking`, null, admin)).body;
        if (b?.carrierBookingRequestReference && b.lastResponseStatus) ref = b.carrierBookingRequestReference; else await sleep(250);
      }
      await request("POST", `/api/test-tools/dcsa-sim/bookings/${ref}/confirm`, {}, admin);
      for (let i = 0; i < 40; i++) { if ((await request("GET", `/api/shipments/${id}/carrier-booking`, null, admin)).body?.status === "Confirmed") return; await sleep(250); }
      throw new Error("the booking was never confirmed");
    };
    const get = async id => (await request("GET", `/api/shipments/${id}`, null, admin)).body;

    console.log("\nA1 — the contract stays while the carrier has the booking");
    const c1 = await contract("A1"), c2 = await contract("A1B");
    const booked = await shipment(c1, "1");
    await confirmBooking(booked);
    let r = await request("PUT", `/api/shipments/${booked}`, dropOf(await get(booked)), admin);
    assert("taking the contract off a confirmed booking: 409 BOOKING_WITH_CARRIER", r.status === 409 && r.body?.code === "BOOKING_WITH_CARRIER", `${r.status} ${JSON.stringify(r.body)}`);
    assert("…saying the carrier has the booking and to amend it first", /HLCU has the booking on it \(confirmed\)\. Ask the carrier to amend the booking first/.test(r.body?.error || ""), r.body?.error);
    assert("the contract is still on the shipment", (await get(booked)).contractId === c1.id);
    r = await request("PUT", `/api/shipments/${booked}`, { ...(await get(booked)), contractId: c2.id, contractRef: c2.contractNumber }, admin);
    assert("changing to another contract still works (unchanged)", r.status === 200 && r.body?.contractId === c2.id, `${r.status} ${JSON.stringify(r.body?.error || "")}`);
    const notSent = await shipment(c1, "2");
    r = await request("PUT", `/api/shipments/${notSent}`, dropOf(await get(notSent)), admin);
    assert("before the booking is sent, the contract comes off as before", r.status === 200 && !r.body?.contractId, `${r.status} ${JSON.stringify(r.body?.error || "")}`);

    console.log("\nA2 — the creator keeps seeing what they create");
    const offices = (await request("GET", "/api/offices", null, admin)).body || [];
    const se = offices.filter(o => String(o.department || "").toUpperCase() === "SE" && o.isActive !== false && o.unlocode);
    const mine = se.find(o => o.unlocode === "NLRTM") || se[0];
    const elsewhere = se.find(o => o.unlocode !== mine.unlocode && o.countryCode !== mine.countryCode);
    assert("two export offices in different countries to test with", !!(mine && elsewhere), JSON.stringify({ mine: mine?.code, elsewhere: elsewhere?.code }));
    const email = `audit-fix-${stamp}@test.local`;
    const u = await request("POST", "/api/users", { email, name: "Audit fix operator", roles: ["occ_bk"], password: "AuditFixture!2026Zq" }, admin);
    users.push(u.body.id);
    await request("POST", `/api/users/${u.body.id}/offices`, { officeId: mine.id }, admin);
    const tok = await login(email, "AuditFixture!2026Zq");
    const H = { "X-Office-Id": mine.id };
    const create = pol => request("POST", "/api/shipments", { pol, pod: "USNYC", carrierCode: "HLCU", status: "Active", contractType: "SPOT",
      contractRef: `SPOT-AUDITFIX-${pol}-${stamp}`, etd: inDays(8), eta: inDays(20), cargoReadyDate: inDays(5), incoterm: "FOB", commodityCode: "9999",
      shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      principalId: shipper.id, principalName: shipper.companyName }, tok, H);
    r = await create(elsewhere.unlocode);
    assert(`created from ${elsewhere.unlocode}: the export office is ${elsewhere.code}, the creator's office the controlling office`,
      r.status === 201 && r.body.emoOfficeId === elsewhere.id && r.body.controllingOfficeId === mine.id, `${r.status} ${JSON.stringify({ emo: r.body?.emoOfficeId, ctrl: r.body?.controllingOfficeId, error: r.body?.error })}`);
    const seen = r.body?.id ? await request("GET", `/api/shipments/${r.body.id}`, null, tok, H) : null;
    assert("…and the creator can open it (it was 404)", seen?.status === 200, String(seen?.status));
    r = await create(mine.unlocode);
    assert(`created from ${mine.unlocode}: the creator's office is the export office, no controlling office added`,
      r.status === 201 && r.body.emoOfficeId === mine.id && !r.body.controllingOfficeId, JSON.stringify({ emo: r.body?.emoOfficeId, ctrl: r.body?.controllingOfficeId }));
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    failed++;
  } finally {
    // The temporary account goes (a live login with a known password); the shipments and contracts stay as verification data.
    for (const id of users) await request("DELETE", `/api/users/${id}`, null, admin).catch(() => {});
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
