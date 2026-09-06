/**
 * Additional Parties (Epic TKT-5XFCAP) — generic party-role assignment smoke tests
 *
 * Usage:
 *   node tests/shipment-parties.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: "localhost",
      port: 3001,
      path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
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
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost",
    password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token)
    throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch shipment + two scratch customers");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    }, token);
    const shipmentId = ship.body.id;
    assert("scratch shipment created", !!shipmentId);
    const custA = await request("POST", "/api/customers", { companyName: "Test Insurance Co A" }, token);
    const custB = await request("POST", "/api/customers", { companyName: "Test Insurance Co B" }, token);
    assert("scratch customer A created", !!custA.body.id);
    assert("scratch customer B created", !!custB.body.id);

    console.log("\nEmpty list on a fresh shipment");
    const empty = await request("GET", `/api/shipments/${shipmentId}/parties`, null, token);
    assert("GET returns 200", empty.status === 200);
    assert("empty array for a fresh shipment", Array.isArray(empty.body) && empty.body.length === 0);

    console.log("\nInvalid role is rejected");
    const badRole = await request("POST", `/api/shipments/${shipmentId}/parties`,
      { role: "Not A Real Role", customerId: custA.body.id, customerName: custA.body.companyName }, token);
    assert("invalid role rejected", badRole.status >= 400);

    console.log("\nAssign Insurance Provider to customer A");
    const created = await request("POST", `/api/shipments/${shipmentId}/parties`,
      { role: "Insurance Provider", customerId: custA.body.id, customerName: custA.body.companyName }, token);
    assert("create returns 201", created.status === 201);
    assert("role round-trips", created.body.role === "Insurance Provider");
    assert("customerId round-trips", created.body.customerId === custA.body.id);
    assert("customerName round-trips", created.body.customerName === custA.body.companyName);
    const partyId = created.body.id;

    console.log("\nAssigning the SAME role again is rejected (UNIQUE constraint enforced server-side)");
    const dup = await request("POST", `/api/shipments/${shipmentId}/parties`,
      { role: "Insurance Provider", customerId: custB.body.id, customerName: custB.body.companyName }, token);
    assert("duplicate role rejected", dup.status >= 400);
    assert("duplicate role error message mentions 'already assigned'",
      typeof dup.body.error === "string" && dup.body.error.toLowerCase().includes("already assigned"));

    console.log("\nList now has exactly 1 row");
    const afterCreate = await request("GET", `/api/shipments/${shipmentId}/parties`, null, token);
    assert("list has 1 row", Array.isArray(afterCreate.body) && afterCreate.body.length === 1);

    console.log("\nReassign to customer B (role stays the same)");
    const reassigned = await request("PUT", `/api/shipments/${shipmentId}/parties/${partyId}`,
      { customerId: custB.body.id, customerName: custB.body.companyName }, token);
    assert("update returns 200", reassigned.status === 200);
    assert("customerName updated", reassigned.body.customerName === custB.body.companyName);
    assert("role unchanged", reassigned.body.role === "Insurance Provider");

    console.log("\nDelete frees the role slot");
    const removed = await request("DELETE", `/api/shipments/${shipmentId}/parties/${partyId}`, null, token);
    assert("delete returns 200", removed.status === 200);
    const reCreate = await request("POST", `/api/shipments/${shipmentId}/parties`,
      { role: "Insurance Provider", customerId: custA.body.id, customerName: custA.body.companyName }, token);
    assert("re-assigning the same role after delete succeeds", reCreate.status === 201);

    console.log("\n404s on a bogus id");
    const badPut = await request("PUT", `/api/shipments/${shipmentId}/parties/PTY-DOESNOTEXIST`, { customerId: "x", customerName: "y" }, token);
    assert("PUT on bogus id returns 404", badPut.status === 404);
    const badDelete = await request("DELETE", "/api/shipment-parties/PTY-DOESNOTEXIST", null, token);
    assert("DELETE on bogus id returns 404", badDelete.status === 404);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/customers/${custA.body.id}`, null, token);
    await request("DELETE", `/api/customers/${custB.body.id}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
