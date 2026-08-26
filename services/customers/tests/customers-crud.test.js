/**
 * Customer Service — CRUD across customers, customer_identifiers, customer_contacts
 *
 * Hits the service directly on its own port, no monolith involved.
 *
 * Usage:
 *   node services/customers/tests/customers-crud.test.js
 *
 * Prerequisites:
 *   - Customer Service running on :3008 (npm run customer-service)
 */

import http from "node:http";

const PORT = 3008;
const SECRET = process.env.CUSTOMER_SERVICE_SECRET || "cargoDesk-dev-customers-service-secret-do-not-use-in-prod";
let passed = 0;
let failed = 0;

function request(method, path, body, auth = true) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: PORT, path,
      headers: {
        "Content-Type": "application/json",
        ...(auth && { Authorization: `Bearer ${SECRET}` }),
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

(async () => {
  const stamp = Date.now();
  let custId = null, cust2Id = null, custChildId = null, identifierId = null, contactId = null;
  try {
    console.log("Health check");
    const health = await request("GET", "/health", null, false);
    assert("health returns 200", health.status === 200);
    assert("service name is customers", health.body.service === "customers");

    console.log("\nNo secret / wrong secret rejected on /internal/*");
    const noAuth = await request("GET", "/internal/customers", null, false);
    assert("no auth returns 401", noAuth.status === 401);

    console.log("\nCustomers CRUD");
    const create = await request("POST", "/internal/customers", {
      companyName: `Customer CRUD Test ${stamp}`, countryIso2: "de", city: "Hamburg",
      creditLimit: 5000, creditTermsDays: 30,
    });
    assert("create returns 201", create.status === 201, JSON.stringify(create.body));
    assert("id has CUS- prefix", typeof create.body?.id === "string" && create.body.id.startsWith("CUS-"));
    assert("countryIso2 uppercased", create.body?.countryIso2 === "DE");
    assert("currency defaulted from country (DE -> EUR)", create.body?.currency === "EUR");
    assert("creditLimit round-trips", create.body?.creditLimit === 5000);
    assert("screeningResult is null before any screening", create.body?.screeningResult === null);
    custId = create.body.id;

    const badCoord = await request("POST", "/internal/customers", { companyName: "Bad Coord", classifiedLocation: true, latitude: 999 });
    assert("out-of-range latitude rejected", badCoord.status === 400);

    const getOne = await request("GET", `/internal/customers/${custId}`);
    assert("get returns 200", getOne.status === 200 && getOne.body.id === custId);

    const list = await request("GET", "/internal/customers");
    assert("bare-array GET returns an array", Array.isArray(list.body));
    assert("created customer present in bare array", list.body.some(c => c.id === custId));

    const update = await request("PUT", `/internal/customers/${custId}`, {
      companyName: "Renamed Co", creditHold: true, creditHoldReason: "test hold", creditLimit: 5000,
    });
    assert("update applies", update.body.companyName === "Renamed Co" && update.body.creditHold === true);
    assert("creditHoldReason round-trips", update.body.creditHoldReason === "test hold");

    console.log("\nPaginated / filtered list");
    const page = await request("GET", "/internal/customers?limit=1&offset=0");
    assert("paginated response has results/total/limit/offset shape", Array.isArray(page.body.results) && typeof page.body.total === "number");
    const heldOnly = await request("GET", "/internal/customers?creditHold=1");
    assert("creditHold=1 filter includes the held customer", heldOnly.body.some(c => c.id === custId));
    const limitOnly = await request("GET", "/internal/customers?hasCreditLimit=1");
    assert("hasCreditLimit=1 filter includes the limited customer", limitOnly.body.some(c => c.id === custId));

    console.log("\nBatch ids= lookup (backs attachAgentNames/role-filter resolution)");
    const create2 = await request("POST", "/internal/customers", { companyName: `Customer CRUD Test 2 ${stamp}` });
    cust2Id = create2.body.id;
    const byIds = await request("GET", `/internal/customers?ids=${custId},${cust2Id},CUS-DOES-NOT-EXIST`);
    assert("ids= filter returns exactly the 2 real customers", byIds.body.length === 2 && byIds.body.every(c => [custId, cust2Id].includes(c.id)), JSON.stringify(byIds.body.map(c=>c.id)));

    console.log("\nParent hierarchy — creation, cycle guard, /group walk");
    const createChild = await request("POST", "/internal/customers", { companyName: `Customer CRUD Child ${stamp}`, parentCustomerId: custId });
    assert("child create returns 201 with parentCustomerName resolved", createChild.status === 201 && createChild.body.parentCustomerName === "Renamed Co", JSON.stringify(createChild.body));
    custChildId = createChild.body.id;
    const badParent = await request("POST", "/internal/customers", { companyName: "Bad Parent", parentCustomerId: "CUS-NOPE" });
    assert("nonexistent parent rejected", badParent.status === 400);
    const cycleAttempt = await request("PUT", `/internal/customers/${custId}`, { companyName: "Renamed Co", parentCustomerId: custChildId });
    assert("circular parent chain rejected", cycleAttempt.status === 400, JSON.stringify(cycleAttempt.body));
    const group = await request("GET", `/internal/customers/${custChildId}/group`);
    assert("group walk returns root first", group.body.ids[0] === custId, JSON.stringify(group.body));
    assert("group walk includes the child", group.body.ids.includes(custChildId), JSON.stringify(group.body));

    console.log("\nIdentifiers CRUD");
    const idCreate = await request("POST", `/internal/customers/${custId}/identifiers`, { idType: "VAT", idCode: "DE123456789", isPrimary: true });
    assert("identifier create returns 201", idCreate.status === 201, JSON.stringify(idCreate.body));
    identifierId = idCreate.body.id;
    const idList = await request("GET", `/internal/customers/${custId}/identifiers`);
    assert("identifier list includes the new one", idList.body.some(i => i.id === identifierId));
    const idUpdate = await request("PUT", `/internal/customers/${custId}/identifiers/${identifierId}`, { idCode: "DE999999999" });
    assert("identifier update applies", idUpdate.body.idCode === "DE999999999");

    console.log("\nContacts CRUD");
    const ctCreate = await request("POST", `/internal/customers/${custId}/contacts`, { name: "Jane Ops", department: "Operations", isPrimary: true });
    assert("contact create returns 201", ctCreate.status === 201, JSON.stringify(ctCreate.body));
    contactId = ctCreate.body.id;
    const ctList = await request("GET", `/internal/customers/${custId}/contacts`);
    assert("contact list includes the new one and is primary", ctList.body.some(c => c.id === contactId && c.isPrimary === true));

    console.log("\nparent_customer_id ON DELETE SET NULL (PRAGMA foreign_keys=ON regression)");
    const delParent = await request("DELETE", `/internal/customers/${custId}`);
    assert("parent delete returns 200", delParent.status === 200, JSON.stringify(delParent.body));
    const childAfter = await request("GET", `/internal/customers/${custChildId}`);
    assert("former child's parentCustomerId is nulled, not dangling", childAfter.body?.parentCustomerId === null, JSON.stringify(childAfter.body));
    custId = null; // already deleted, skip in finally

    console.log("\nBulk import (migration script) is idempotent");
    const bulkCust = { id: `CUS-BULK${stamp % 100000}`, company_name: "Bulk Import Co", address1: '', address2: '', city: '', state: '',
      postal_code: '', country_iso2: '', phone: '', fax: '', email: '', website: '', notes: '', created_at: new Date().toISOString(),
      currency: 'USD', credit_limit: null, credit_terms_days: null, credit_hold: 0, credit_hold_reason: '', parent_customer_id: null,
      classified_location: 0, latitude: null, longitude: null, is_nvocc: 0, fmc_number: '', invoice_deadline_days: null,
      reminder_enabled: 0, reminder_interval_days: null, billing_by_day: null, payment_settlement_day: null, holiday_unlocode: '' };
    const bulk1 = await request("POST", "/internal/customers/bulk-import", { customers: [bulkCust] });
    assert("first bulk-import inserts the row", bulk1.status === 201 && bulk1.body.inserted.customers === 1, JSON.stringify(bulk1.body));
    const bulk2 = await request("POST", "/internal/customers/bulk-import", { customers: [bulkCust] });
    assert("re-running bulk-import is idempotent (0 new inserts)", bulk2.body.inserted.customers === 0, JSON.stringify(bulk2.body));
    await request("DELETE", `/internal/customers/${bulkCust.id}`).catch(() => {});

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    if (identifierId && custId) await request("DELETE", `/internal/customers/${custId}/identifiers/${identifierId}`).catch(() => {});
    if (contactId && custId) await request("DELETE", `/internal/customers/${custId}/contacts/${contactId}`).catch(() => {});
    if (custChildId) await request("DELETE", `/internal/customers/${custChildId}`).catch(() => {});
    if (custId) await request("DELETE", `/internal/customers/${custId}`).catch(() => {});
    if (cust2Id) await request("DELETE", `/internal/customers/${cust2Id}`).catch(() => {});
  }
})();
