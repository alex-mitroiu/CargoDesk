/**
 * Organization Model Enhancement — Epic 1: Contacts & Role-Eligible Pickers
 *
 * Covers customer_contacts CRUD, customer_roles get/set (full-set replace), and the new
 * GET /api/customers?role= filter that CustomerCombobox's roleFilter/CustomerPickerModal's
 * "Only show eligible customers" toggle both rely on.
 *
 * Usage:
 *   node tests/customer-contacts-roles.test.js
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

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch customer");
    const cust = await request("POST", "/api/customers", { companyName: "Test Contacts & Roles Co" }, token);
    const customerId = cust.body.id;
    assert("scratch customer created", !!customerId);

    console.log("\nContacts — empty on a fresh customer");
    const emptyContacts = await request("GET", `/api/customers/${customerId}/contacts`, null, token);
    assert("GET returns 200", emptyContacts.status === 200);
    assert("empty array", Array.isArray(emptyContacts.body) && emptyContacts.body.length === 0);

    console.log("\nContacts — blank name rejected");
    const badContact = await request("POST", `/api/customers/${customerId}/contacts`, { name: "  " }, token);
    assert("blank name rejected", badContact.status >= 400);

    console.log("\nContacts — create two, first marked primary");
    const c1 = await request("POST", `/api/customers/${customerId}/contacts`,
      { name: "Jane van der Berg", title: "Export Coordinator", email: "jane@test.co", phone: "+31101234567", department: "Operations", isPrimary: true }, token);
    assert("contact 1 created (201)", c1.status === 201);
    assert("contact 1 fields round-trip", c1.body.name === "Jane van der Berg" && c1.body.department === "Operations" && c1.body.isPrimary === true);
    const c2 = await request("POST", `/api/customers/${customerId}/contacts`,
      { name: "Tom Bakker", department: "Accounts" }, token);
    assert("contact 2 created (201)", c2.status === 201);
    assert("contact 2 not primary by default", c2.body.isPrimary === false);

    console.log("\nContacts — list has 2, primary sorts first");
    const list2 = await request("GET", `/api/customers/${customerId}/contacts`, null, token);
    assert("list has 2 contacts", list2.body.length === 2);
    assert("primary contact sorts first", list2.body[0].id === c1.body.id);

    console.log("\nContacts — marking a second contact primary un-primaries the first (single-primary invariant)");
    const c2Primary = await request("PUT", `/api/customers/${customerId}/contacts/${c2.body.id}`,
      { name: "Tom Bakker", department: "Accounts", isPrimary: true }, token);
    assert("update returns 200", c2Primary.status === 200);
    assert("contact 2 is now primary", c2Primary.body.isPrimary === true);
    const c1Refetched = await request("GET", `/api/customers/${customerId}/contacts`, null, token);
    const c1Row = c1Refetched.body.find(c => c.id === c1.body.id);
    assert("contact 1 no longer primary", c1Row.isPrimary === false);

    console.log("\nContacts — delete one, list drops to 1");
    const delContact = await request("DELETE", `/api/customers/${customerId}/contacts/${c1.body.id}`, null, token);
    assert("delete returns 200", delContact.status === 200);
    const list1 = await request("GET", `/api/customers/${customerId}/contacts`, null, token);
    assert("list has 1 contact", list1.body.length === 1);

    console.log("\nContacts — 404 on a bogus id");
    const badDel = await request("DELETE", `/api/customers/${customerId}/contacts/CCT-DOESNOTEXIST`, null, token);
    assert("delete bogus id returns 404", badDel.status === 404);

    console.log("\nRoles — empty on a fresh customer");
    const emptyRoles = await request("GET", `/api/customers/${customerId}/roles`, null, token);
    assert("GET returns 200", emptyRoles.status === 200);
    assert("empty array", Array.isArray(emptyRoles.body) && emptyRoles.body.length === 0);

    console.log("\nRoles — invalid role value rejected");
    const badRoles = await request("PUT", `/api/customers/${customerId}/roles`, { roles: ["Not A Real Role"] }, token);
    assert("invalid role rejected", badRoles.status >= 400);

    console.log("\nRoles — set to [Bank, Shipper]");
    const setRoles = await request("PUT", `/api/customers/${customerId}/roles`, { roles: ["Bank", "Shipper"] }, token);
    assert("set returns 200", setRoles.status === 200);
    assert("both roles present", setRoles.body.includes("Bank") && setRoles.body.includes("Shipper") && setRoles.body.length === 2);

    console.log("\nRoles — set again is a full REPLACE, not a merge (down to just [Bank])");
    const replaceRoles = await request("PUT", `/api/customers/${customerId}/roles`, { roles: ["Bank"] }, token);
    assert("replace returns 200", replaceRoles.status === 200);
    assert("only Bank remains — Shipper was dropped, not kept alongside", JSON.stringify(replaceRoles.body) === JSON.stringify(["Bank"]));

    console.log("\nRole filter — GET /api/customers?role=Bank only returns Bank-flagged customers");
    const unflagged = await request("POST", "/api/customers", { companyName: "Test Unflagged Co" }, token);
    const roleSearch = await request("GET", `/api/customers?role=Bank&search=Test%20`, null, token);
    assert("search returns 200", roleSearch.status === 200);
    const ids = roleSearch.body.results.map(c => c.id);
    assert("flagged customer is included", ids.includes(customerId));
    assert("unflagged customer is excluded", !ids.includes(unflagged.body.id));

    console.log("\nCleanup — deleting the customer also removes its contacts/roles (not orphaned)");
    await request("DELETE", `/api/customers/${customerId}`, null, token);
    const afterDeleteContacts = await request("GET", `/api/customers/${customerId}/contacts`, null, token);
    assert("no orphaned contacts after customer delete", afterDeleteContacts.body.length === 0);
    const afterDeleteRoles = await request("GET", `/api/customers/${customerId}/roles`, null, token);
    assert("no orphaned roles after customer delete", afterDeleteRoles.body.length === 0);
    await request("DELETE", `/api/customers/${unflagged.body.id}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
