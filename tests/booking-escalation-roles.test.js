/**
 * Booking-escalation roles (Epic TKT-ASIYFL, Story 1 TKT-Q0N7N6; agreed 2026-10-20):
 *   - OCC/AY (occ_ay), CCL/CO (ccl_co) and Trade/AY (trade_ay) are real roles: they can be assigned,
 *     appear in the token, and are refused nothing a role check doesn't name;
 *   - they see the shipments their scope covers: OCC/AY and CCL/CO by office (export and import side
 *     alike), Trade/AY by trade lane;
 *   - they can't edit a shipment or send a booking (the escalation actions come with Story 3).
 *
 * Usage:
 *   node tests/booking-escalation-roles.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC, CNSHA, USLAX in port_locations, with their trade lanes (seeded MDM data)
 */

import { ensureOffices, retireOffice } from "./helpers/offices.mjs";

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

(async () => {
  const cleanup = { shipments: [], customers: [], users: [], offices: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    // A second export and import office, so "not my office" is a real, other office.
    const otherSE = (await request("POST", "/api/offices", { unlocode: `X${rand.slice(0, 4)}`, department: "SE", name: `Escalation Roles SE ${rand}` }, token)).body;
    const otherSI = (await request("POST", "/api/offices", { unlocode: `X${rand.slice(1, 5)}`, department: "SI", name: `Escalation Roles SI ${rand}` }, token)).body;
    cleanup.offices.push(otherSE.id, otherSI.id);

    const shipper = (await request("POST", "/api/customers", { companyName: `Escalation Roles Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Escalation Roles Consignee ${rand} Inc` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id);
    const newShipment = async (pol, pod, carrierCode, emo, imo) => {
      const s = await request("POST", "/api/shipments", {
        pol, pod, carrierCode, status: "Active", contractType: "SPOT", contractRef: `SPOT-ROLES-${rand}`,
        etd: "2026-11-09", eta: "2026-11-27", incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId: emo, imoOfficeId: imo,
      }, token);
      cleanup.shipments.push(s.body.id);
      await request("POST", "/api/containers", { shipmentId: s.body.id, containerNumber: `ESCU${String(Date.now()).slice(-7)}`,
        size: "40", type: "HC", hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 }, token);
      return s.body.id;
    };
    // Ours: Rotterdam → New York through the default offices. Theirs: Shanghai → Los Angeles through the others.
    const ours = await newShipment("NLRTM", "USNYC", "MAEU", emoOfficeId, imoOfficeId);
    const theirs = await newShipment("CNSHA", "USLAX", "EGLV", otherSE.id, otherSI.id);

    console.log("The three roles exist");
    const makeUser = async (role) => {
      const email = `${role.replace("_", "-")}-${rand.toLowerCase()}@example.com`;
      const created = await request("POST", "/api/users", { email, name: `${role} test ${rand}`, roles: [role], password: "EscFixture!2026Zq" }, token);
      cleanup.users.push(email);
      return { email, status: created.status, body: created.body };
    };
    const occAy = await makeUser("occ_ay");
    const cclCo = await makeUser("ccl_co");
    const tradeAy = await makeUser("trade_ay");
    assert("an OCC/AY user can be created", occAy.status === 201, JSON.stringify(occAy.body));
    assert("a CCL/CO user can be created", cclCo.status === 201, JSON.stringify(cclCo.body));
    assert("a Trade/AY user can be created", tradeAy.status === 201, JSON.stringify(tradeAy.body));
    assert("an unknown role is still refused", (await request("POST", "/api/users", { email: `nope-${rand.toLowerCase()}@example.com`, name: "Nope", roles: ["occ_xx"], password: "EscFixture!2026Zq" }, token)).status === 400);

    const users = list((await request("GET", "/api/users", null, token)).body);
    const idOf = email => users.find(u => u.email === email)?.id;
    await request("POST", `/api/users/${idOf(occAy.email)}/offices`, { officeId: emoOfficeId, isDefault: true }, token);
    await request("POST", `/api/users/${idOf(cclCo.email)}/offices`, { officeId: imoOfficeId, isDefault: true }, token);
    await request("POST", `/api/users/${idOf(tradeAy.email)}/scope`, { role: "trade_ay", itemType: "trade_lane", value: JSON.stringify({ origin: "EU-N", dest: "NAM" }), label: "EU-N → NAM" }, token);

    const login = async email => (await request("POST", "/api/auth/login", { email, password: "EscFixture!2026Zq" })).body;
    const occAyLogin = await login(occAy.email);
    const cclCoLogin = await login(cclCo.email);
    const tradeAyLogin = await login(tradeAy.email);
    assert("each signs in with the role in the session", [occAyLogin, cclCoLogin, tradeAyLogin].every((l, i) => (l?.user?.roles || []).includes(["occ_ay", "ccl_co", "trade_ay"][i])),
      JSON.stringify([occAyLogin?.user?.roles, cclCoLogin?.user?.roles, tradeAyLogin?.user?.roles]));

    console.log("\nThey see what their scope covers");
    const sees = async (tok, id) => (await request("GET", `/api/shipments/${id}`, null, tok)).status === 200;
    assert("OCC/AY sees a shipment of its export office", await sees(occAyLogin.token, ours));
    assert("OCC/AY doesn't see another office's shipment", !(await sees(occAyLogin.token, theirs)));
    assert("CCL/CO sees a shipment of its import office", await sees(cclCoLogin.token, ours));
    assert("CCL/CO doesn't see another office's shipment", !(await sees(cclCoLogin.token, theirs)));
    assert("Trade/AY sees a shipment on its lane (EU-N → NAM)", await sees(tradeAyLogin.token, ours));
    assert("Trade/AY doesn't see another lane's shipment (FE → NAM)", !(await sees(tradeAyLogin.token, theirs)));

    console.log("\nThey can't edit a shipment or send a booking");
    for (const [label, l] of [["OCC/AY", occAyLogin], ["CCL/CO", cclCoLogin], ["Trade/AY", tradeAyLogin]]) {
      const put = await request("PUT", `/api/shipments/${ours}`, { incoterm: "CIF" }, l.token);
      const send = await request("POST", `/api/shipments/${ours}/edi-messages/booking-request`, {}, l.token);
      assert(`${label}: editing the shipment is refused (403)`, put.status === 403, String(put.status));
      assert(`${label}: sending a booking request is refused (403)`, send.status === 403, String(send.status));
    }
    assert("the shipment is unchanged", (await request("GET", `/api/shipments/${ours}`, null, token)).body?.incoterm === "FOB");
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
    if (cleanup.users.length) {
      const users = list((await request("GET", "/api/users", null, token)).body);
      for (const email of cleanup.users) { const u = users.find(x => x.email === email); if (u) await request("DELETE", `/api/users/${u.id}`, null, token).catch(() => {}); }
    }
    for (const id of cleanup.offices) await retireOffice(token, id).catch(() => {});
    console.log(`\n${"─".repeat(50)}\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
