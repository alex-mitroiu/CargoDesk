/**
 * Organization Model Enhancement — Epic 4: Customer Hierarchy & Named-Account Unification
 *
 * Covers customers.parent_customer_id (self-parent/cycle rejection, ON DELETE SET NULL),
 * resolveCustomerGroup (server.js), and the groupByParent rollup on GET /api/margin/summary.
 *
 * Usage:
 *   node tests/customer-hierarchy.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq (admin role — required for
 *     /api/margin/summary's finance-access gate)
 */

import http from "node:http";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: 3001, path,
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
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost", password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

async function addSellLine(shipmentId, token, amount, chargeCode = "OFR") {
  const res = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, {
    type: "SELL", chargeCode, currency: "USD", amount, exchangeRate: 1,
  }, token);
  return res.body;
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch parent + child customers");
    const parent = await request("POST", "/api/customers", { companyName: "Test Hierarchy Global HQ" }, token);
    assert("parent created", !!parent.body.id);
    assert("parent has no parentCustomerId by default", parent.body.parentCustomerId === null);
    const child = await request("POST", "/api/customers",
      { companyName: "Test Hierarchy Regional Branch", parentCustomerId: parent.body.id }, token);
    assert("child created", !!child.body.id);
    assert("child's parentCustomerId round-trips", child.body.parentCustomerId === parent.body.id);
    assert("child's parentCustomerName resolves via join", child.body.parentCustomerName === "Test Hierarchy Global HQ");

    console.log("\nBogus parent id is rejected");
    const bogusParent = await request("POST", "/api/customers",
      { companyName: "Test Hierarchy Orphan", parentCustomerId: "CUS-DOESNOTEXIST" }, token);
    assert("bogus parent rejected", bogusParent.status >= 400);

    console.log("\nSelf-parenting is rejected");
    const selfParent = await request("PUT", `/api/customers/${parent.body.id}`,
      { companyName: "Test Hierarchy Global HQ", parentCustomerId: parent.body.id }, token);
    assert("self-parent rejected", selfParent.status >= 400);

    console.log("\nCircular chain is rejected (parent's parent can't become its own child)");
    const cycle = await request("PUT", `/api/customers/${parent.body.id}`,
      { companyName: "Test Hierarchy Global HQ", parentCustomerId: child.body.id }, token);
    assert("cycle rejected", cycle.status >= 400);

    console.log("\nMargin rollup — two shipments, one per customer, same lane");
    const shipParent = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: parent.body.id, principalName: "Test Hierarchy Global HQ",
    }, token);
    const shipChild = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: child.body.id, principalName: "Test Hierarchy Regional Branch",
    }, token);
    await addSellLine(shipParent.body.id, token, 1000, "OFR");
    await addSellLine(shipChild.body.id, token, 500, "OFR");

    console.log("\nWithout rollup — parent and child show as two separate rows");
    const flat = await request("GET", "/api/margin/summary", null, token);
    assert("summary returns 200", flat.status === 200);
    const flatParentRow = flat.body.byCustomer.find(c => c.customerId === parent.body.id);
    const flatChildRow  = flat.body.byCustomer.find(c => c.customerId === child.body.id);
    assert("parent row present with its own 1000", flatParentRow?.totalSellUsd === 1000, JSON.stringify(flatParentRow));
    assert("child row present with its own 500", flatChildRow?.totalSellUsd === 500, JSON.stringify(flatChildRow));

    console.log("\nWith rollup — parent and child combine into one row under the parent's id");
    const rolled = await request("GET", "/api/margin/summary?groupByParent=true", null, token);
    assert("rolled summary returns 200", rolled.status === 200);
    const rolledRow = rolled.body.byCustomer.find(c => c.customerId === parent.body.id);
    assert("combined row exists under the parent id", !!rolledRow, JSON.stringify(rolled.body.byCustomer));
    assert("combined total is 1500 (1000 + 500)", rolledRow?.totalSellUsd === 1500, JSON.stringify(rolledRow));
    assert("combined row reads by the parent's own name", rolledRow?.customerName === "Test Hierarchy Global HQ");
    const rolledChildRow = rolled.body.byCustomer.find(c => c.customerId === child.body.id);
    assert("child no longer appears as its own separate row once rolled up", !rolledChildRow);

    console.log("\nDeleting the parent sets the child's parentCustomerId to NULL (ON DELETE SET NULL)");
    await request("DELETE", `/api/shipments/${shipParent.body.id}`, null, token);
    await request("DELETE", `/api/customers/${parent.body.id}`, null, token);
    const childAfter = await request("GET", `/api/customers/${child.body.id}`, null, token);
    assert("child's parentCustomerId cleared, not left dangling", childAfter.body.parentCustomerId === null, JSON.stringify(childAfter.body));

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipChild.body.id}`, null, token);
    await request("DELETE", `/api/customers/${child.body.id}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
