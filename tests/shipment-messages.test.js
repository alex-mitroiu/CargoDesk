/**
 * Shipment messages are signed by whoever is signed in (2026-11-09). POST /api/shipments/:id/messages used to store
 * the author and role the request named, so any signed-in user could post under someone else's name. Now:
 *   - the author is the signed-in user's name, the role the one they work in (X-Active-Role, else their highest),
 *     labelled as the app's role switcher labels it; an author or role in the request is ignored;
 *   - the body must be a string of 15 to 500 characters (a non-string is a 400, not a 500).
 *
 * Usage:
 *   node tests/shipment-messages.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

let passed = 0;
let failed = 0;

function request(method, path, body, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined && body !== null ? JSON.stringify(body) : null;
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
  return body;
}

const inDays = n => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

(async () => {
  const users = [];
  let admin;
  try {
    console.log("Logging in…");
    const adminLogin = await login("claudeagent@localhost", "TestFixture!2026Zq");
    admin = adminLogin.token;
    console.log("  ✓ Logged in");
    const stamp = Date.now();
    const { emoOfficeId, imoOfficeId } = await ensureOffices(admin);

    // A complete Central shipment NLRTM → USNYC on its contract: parties, incoterm, dates, commodity, one 40HC.
    const customer = async name => (await request("POST", "/api/customers", { companyName: `${name} ${stamp}` }, admin)).body;
    const shipper = await customer("Messages Test Shipper BV"), consignee = await customer("Messages Test Consignee Inc");
    const contract = await request("POST", "/api/contracts", { contractNumber: `MSGTEST-${stamp}`, carrierCode: "HLCU", status: "Active",
      validFrom: "2026-01-01", validTo: "2027-12-31", routings: [{ name: "" }], legs: [{ legType: "SEA", pol: "NLRTM", pod: "USNYC", routingIndex: 0 }],
      rates: [{ serviceCode: "OF", amount: 1450, currency: "USD", unit: "per_container" }] }, admin);
    if (contract.status !== 201) throw new Error(`contract ${contract.status} ${JSON.stringify(contract.body)}`);
    const s = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "HLCU", status: "Active", contractType: "Central",
      contractId: contract.body.id, contractRef: contract.body.contractNumber, etd: inDays(9), eta: inDays(19), cargoReadyDate: inDays(6),
      incoterm: "FCA", commodityCode: "9999", shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id,
      consigneeName: consignee.companyName, principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId }, admin);
    if (s.status !== 201) throw new Error(`shipment ${s.status} ${JSON.stringify(s.body)}`);
    const id = s.body.id;
    await request("POST", "/api/containers", { shipmentId: id, containerNumber: `HLXU${String(stamp).slice(-7)}`, size: "40", type: "HC",
      hsCode: "940360", cargoDescription: "Wooden furniture", grossWeightKg: 8600, volumeCbm: 61 }, admin);
    const post = (token, body, headers) => request("POST", `/api/shipments/${id}/messages`, body, token, headers);

    console.log("\nThe author and role are the signed-in user's");
    let r = await post(admin, { body: "Customer asks to hold the booking until Friday.", author: "Someone Else", role: "Viewer" });
    assert("posted (201)", r.status === 201, `${r.status} ${JSON.stringify(r.body)}`);
    assert("signed with the admin's own name, not the name sent", r.body?.author === adminLogin.user.name && r.body?.author !== "Someone Else",
      JSON.stringify({ author: r.body?.author, expected: adminLogin.user.name }));
    assert("…and the admin's role, not the role sent", r.body?.role === "Admin", r.body?.role);
    const stored = (await request("GET", `/api/shipments/${id}/messages`, null, admin)).body || [];
    assert("stored the same way", stored.some(m => m.id === r.body?.id && m.author === adminLogin.user.name && m.role === "Admin"),
      JSON.stringify(stored.map(m => [m.author, m.role])));

    console.log("\nThe role is the one the user works in");
    const email = `msg-test-${stamp}@test.local`;
    const u = await request("POST", "/api/users", { email, name: "Messages Test Operator", roles: ["operator", "occ_bk"], password: "MsgFixture!2026Zq" }, admin);
    if (u.status !== 201 && u.status !== 200) throw new Error(`user ${u.status} ${JSON.stringify(u.body)}`);
    users.push(u.body.id);
    await request("POST", `/api/users/${u.body.id}/offices`, { officeId: emoOfficeId }, admin);
    const op = (await login(email, "MsgFixture!2026Zq")).token;
    const H = { "X-Office-Id": emoOfficeId };
    r = await post(op, { body: "Shipper sends the commercial invoice tomorrow.", author: "Admin User", role: "Admin" }, H);
    assert("an operator + OCC Booking user is signed by name, with their highest role", r.status === 201 && r.body?.author === "Messages Test Operator" && r.body?.role === "Operator",
      `${r.status} ${JSON.stringify({ author: r.body?.author, role: r.body?.role, error: r.body?.error })}`);
    r = await post(op, { body: "Booking desk: the carrier asked for the VGM by noon." }, { ...H, "X-Active-Role": "occ_bk" });
    assert("…and with the role they switched to (X-Active-Role)", r.status === 201 && r.body?.role === "OCC Booking", JSON.stringify(r.body?.role));
    r = await post(op, { body: "Trying to claim a role I don't have." }, { ...H, "X-Active-Role": "admin" });
    assert("a role they don't hold is never taken from the header", r.status === 201 && r.body?.role === "Operator", JSON.stringify(r.body?.role));

    console.log("\nThe body");
    r = await post(admin, { body: "too short" });
    assert("under 15 characters: 400", r.status === 400, `${r.status}`);
    r = await post(admin, { body: "x".repeat(501) });
    assert("over 500 characters: 400", r.status === 400, `${r.status}`);
    r = await post(admin, { body: 12345678901234567 });
    assert("not text: 400, not a server error", r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    failed++;
  } finally {
    // The temporary account goes (a live login with a known password); the shipment and its messages stay as verification data.
    for (const uid of users) await request("DELETE", `/api/users/${uid}`, null, admin).catch(() => {});
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
