/**
 * Customers list — the shared table system's fourth adopter (Quotes, Contracts, Opportunities came
 * first). Covers GET /api/customers/table and GET /api/customers/filter-options: repeated-param column
 * filters, "empty selection shows nothing", the multi-valued Roles column (derived from real shipment
 * assignments — a customer can be Shipper AND Bank), the separate `role` scope the segmented control
 * sends, search, sort and paging — and that the older GET /api/customers (CustomerCombobox, the
 * Schedules page) keeps its own, different param semantics. See routes/customers.js, lib/tableQuery.js.
 *
 * Every assertion scopes itself to three scratch customers by a unique name prefix (search), since the
 * database already holds others. Roles come from one realistic, complete Central shipment.
 *
 * Usage:
 *   node tests/customers-table.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

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

// Repeated keys (?roles=A&roles=B), the way src/api.js's tableQs() sends them; a [] value sends the bare
// key with an empty value — the frontend's "deselect everything".
const qs = params => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) { if (v.length === 0) u.append(k, ""); else v.forEach(x => u.append(k, x)); }
    else u.append(k, v);
  }
  return u.toString();
};

(async () => {
  const cleanup = { customers: [], shipments: [], contracts: [] };
  try {
    const token = await login();
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const tag = `TCUST${Date.now()}`;
    const table = (params = {}) => request("GET", `/api/customers/table?${qs({ search: tag, ...params })}`, null, token);
    const names = r => r.body.results.map(c => c.companyName.replace(`${tag} `, ""));

    console.log("Create three scratch customers");
    const commaName = `${tag} Beta, Ltd. & Sons`;
    const mkCust = async payload => {
      const r = await request("POST", "/api/customers", payload, token);
      assert(`customer "${payload.companyName}" created`, r.status === 201 || r.status === 200, JSON.stringify(r.body));
      cleanup.customers.push(r.body.id);
      return r.body;
    };
    // Created in this order, so newest-first is C, B, A. Company A-Z is Alpha, Beta, Gamma.
    const A = await mkCust({ companyName: `${tag} Alpha Freight`, city: "Rotterdam", countryIso2: "NL", email: "ops@alpha-freight.test", phone: "+31 10 555 0101" });
    const B = await mkCust({ companyName: commaName, city: "Hamburg", countryIso2: "DE", email: "hello@beta.test", phone: "+49 40 555 0202" });
    const C = await mkCust({ companyName: `${tag} Gamma` });

    console.log("\nRoles come from ONE realistic, complete Central shipment: A ships and is the principal, B receives (and is also the Bank)");
    const contractNumber = `TCU-${Date.now()}`;
    const contract = await request("POST", "/api/contracts", {
      contractNumber, carrierCode: "HLCU", status: "Active", validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }], containerTypes: ["40HC"],
      rates: [{ serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" }],
    }, token);
    assert("scratch Central contract created", contract.status === 201, JSON.stringify(contract.body));
    cleanup.contracts.push(contract.body.id);
    const commodities = await request("GET", "/api/commodities?limit=1", null, token);
    const commodityCode = commodities.body?.results?.[0]?.code || "";
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "HLCU", contractType: "Central", contractId: contract.body.id, contractRef: contractNumber,
      incoterm: "FOB", etd: "2026-10-01", eta: "2026-10-15", commodityCode,
      shipperId: A.id, shipperName: A.companyName, consigneeId: B.id, consigneeName: B.companyName,
      principalId: A.id, principalName: A.companyName, emoOfficeId, imoOfficeId,
    }, token);
    assert("scratch shipment created with parties, incoterm, route and dates", ship.status === 201, JSON.stringify(ship.body));
    cleanup.shipments.push(ship.body.id);
    const ctr = await request("POST", "/api/containers", { shipmentId: ship.body.id, size: "40", type: "HC", marksAndNumbers: "TCUST / NO. 1-10" }, token);
    assert("real 40HC container added", ctr.status === 201 || ctr.status === 200, JSON.stringify(ctr.body));
    const bank = await request("POST", `/api/shipments/${ship.body.id}/parties`, { role: "Bank", customerId: B.id, customerName: B.companyName }, token);
    assert("Bank party assigned to B", bank.status === 201, JSON.stringify(bank.body));

    console.log("\nBasic shape, scoped by search");
    let r = await table();
    assert("responds 200 with { results, total, limit, offset } and finds all three by name prefix",
      r.status === 200 && r.body.total === 3 && r.body.limit === 50 && r.body.offset === 0, JSON.stringify(r.body).slice(0, 160));
    const rowA = r.body.results.find(c => c.id === A.id);
    assert("rows keep the full customer shape and carry derived roles", rowA && rowA.city === "Rotterdam" && Array.isArray(rowA.roles), JSON.stringify(rowA || {}).slice(0, 160));
    assert("roles are derived from the shipment, in either slot (A: Shipper + Principal)", rowA.roles.includes("Shipper") && rowA.roles.includes("Principal") && !rowA.roles.includes("Consignee"), JSON.stringify(rowA.roles));
    const rowB = r.body.results.find(c => c.id === B.id), rowC = r.body.results.find(c => c.id === C.id);
    assert("B is Consignee + Bank; C, never used, has no roles", rowB.roles.includes("Consignee") && rowB.roles.includes("Bank") && rowC.roles.length === 0, `${JSON.stringify(rowB.roles)} / ${JSON.stringify(rowC.roles)}`);

    console.log("\nColumn filters: repeated params, AND across columns");
    r = await table({ company: `${tag} Alpha Freight` });
    assert("Company: a single value filters exactly", names(r).join() === "Alpha Freight", names(r).join());
    r = await table({ company: commaName });
    assert("Company: a name containing a comma and an ampersand matches as ONE value", names(r).join() === "Beta, Ltd. & Sons", names(r).join());
    r = await table({ company: [`${tag} Alpha Freight`, commaName] });
    assert("repeated values are OR-ed within a column", names(r).join() === "Alpha Freight,Beta, Ltd. & Sons", names(r).join());
    r = await table({ company: "" });
    assert("a present-but-EMPTY param means show nothing, not no filter", r.status === 200 && r.body.total === 0, `total=${r.body.total}`);
    r = await table({ location: "Rotterdam · NL" });
    assert("Location filters on the same \"City · Country\" the cell shows", names(r).join() === "Alpha Freight", names(r).join());
    r = await table({ location: ["Rotterdam · NL", "Hamburg · DE"] });
    assert("a customer with no city or country never matches a Location selection", !names(r).includes("Gamma") && r.body.total === 2, names(r).join());
    r = await table({ company: commaName, location: "Rotterdam · NL" });
    assert("columns AND together", r.body.total === 0, `total=${r.body.total}`);

    console.log("\nRoles column: matches on ANY role");
    r = await table({ roles: "Shipper" });
    assert("Shipper -> only A", names(r).join() === "Alpha Freight", names(r).join());
    r = await table({ roles: "Consignee" });
    assert("Consignee -> only B", names(r).join() === "Beta, Ltd. & Sons", names(r).join());
    r = await table({ roles: "Bank" });
    assert("Bank -> only B (a shipment_parties role, not a shipment column)", names(r).join() === "Beta, Ltd. & Sons", names(r).join());
    r = await table({ roles: ["Shipper", "Bank"] });
    assert("several roles OR together", names(r).join() === "Alpha Freight,Beta, Ltd. & Sons", names(r).join());
    r = await table({ roles: ["Shipper", "Consignee", "Principal", "Bank"] });
    assert("a customer with NO roles never matches a role selection", !names(r).includes("Gamma"), names(r).join());
    r = await table({ roles: "" });
    assert("Roles: empty selection shows nothing", r.body.total === 0, `total=${r.body.total}`);

    console.log("\nThe `role` scope (the segmented control) — comma-joined, separate from the Roles column");
    r = await table({ role: "Shipper,Principal" });
    assert("role=Shipper,Principal -> A", names(r).join() === "Alpha Freight", names(r).join());
    r = await table({ role: "Bank" });
    assert("role=Bank -> B", names(r).join() === "Beta, Ltd. & Sons", names(r).join());
    r = await table({ role: "Shipper,Consignee,Bank" });
    assert("several roles in the scope OR together", names(r).join() === "Alpha Freight,Beta, Ltd. & Sons", names(r).join());
    r = await table({ role: "Consignee", roles: "Bank" });
    assert("the scope and the Roles column filter AND together", names(r).join() === "Beta, Ltd. & Sons", names(r).join());
    r = await table({ role: "Consignee", roles: "Shipper" });
    assert("...and can exclude everything", r.body.total === 0, `total=${r.body.total}`);

    console.log("\nSearch");
    r = await request("GET", `/api/customers/table?${qs({ search: "hamburg" })}`, null, token);
    assert("search reaches the city, case-insensitively", r.body.results.some(c => c.id === B.id), `total=${r.body.total}`);
    r = await request("GET", `/api/customers/table?${qs({ search: "OPS@ALPHA-FREIGHT.TEST" })}`, null, token);
    assert("search reaches the email", r.body.results.some(c => c.id === A.id) && !r.body.results.some(c => c.id === B.id));
    r = await request("GET", `/api/customers/table?${qs({ search: "555 0202" })}`, null, token);
    assert("search reaches the phone", r.body.results.some(c => c.id === B.id));
    r = await request("GET", `/api/customers/table?${qs({ search: C.id })}`, null, token);
    assert("search reaches the id", r.body.results.some(c => c.id === C.id));

    console.log("\nSort");
    r = await table();
    assert("default order is company A–Z", names(r).join() === "Alpha Freight,Beta, Ltd. & Sons,Gamma", names(r).join());
    r = await table({ sort: "newest" });
    assert("sort=newest", names(r).join() === "Gamma,Beta, Ltd. & Sons,Alpha Freight", names(r).join());
    r = await table({ sort: "city" });
    assert("sort=city is A–Z with a blank city LAST", names(r).join() === "Beta, Ltd. & Sons,Alpha Freight,Gamma", names(r).join());
    r = await table({ sort: "country" });
    assert("sort=country is A–Z with a blank country LAST", names(r).join() === "Beta, Ltd. & Sons,Alpha Freight,Gamma", names(r).join());
    r = await table({ sort: "nonsense" });
    assert("an unknown sort key falls back to the default order", names(r).join() === "Alpha Freight,Beta, Ltd. & Sons,Gamma", names(r).join());

    console.log("\nPaging");
    r = await table({ limit: 2, offset: 0 });
    assert("first page holds `limit` rows but reports the full total", r.body.results.length === 2 && r.body.total === 3 && r.body.limit === 2);
    r = await table({ limit: 2, offset: 2 });
    assert("second page holds the remainder", r.body.results.length === 1 && r.body.offset === 2);
    r = await table({ limit: 5000 });
    assert("limit is capped at 200", r.body.limit === 200);

    console.log("\nfilter-options");
    const opts = await request("GET", "/api/customers/filter-options", null, token);
    assert("resolves (not swallowed by /:id) with a checklist per filterable column",
      opts.status === 200 && ["company", "roles", "location"].every(k => Array.isArray(opts.body[k])), JSON.stringify(Object.keys(opts.body || {})));
    assert("a comma-and-ampersand company is a single checklist option", opts.body.company.includes(commaName));
    assert("roles are listed one by one", ["Shipper", "Consignee", "Principal", "Bank"].every(x => opts.body.roles.includes(x)) && !opts.body.roles.some(x => x.includes(",")));
    assert("locations are offered as \"City · Country\"; blanks never", opts.body.location.includes("Rotterdam · NL") && opts.body.location.includes("Hamburg · DE") && !opts.body.location.includes(""));
    assert("checklists come from the whole registry, not one page", [A, B, C].every(c => opts.body.company.includes(c.companyName)));
    const scoped = await request("GET", `/api/customers/filter-options?${qs({ role: "Bank", company: "x" })}`, null, token);
    assert("options ignore the list's own filters AND the role scope (a category never shrinks the Roles checklist)", scoped.body.roles.includes("Shipper") && scoped.body.company.includes(A.companyName));

    console.log("\nRegression: the older endpoint keeps its own semantics");
    const legacy = await request("GET", `/api/customers?${qs({ search: tag, limit: 50 })}`, null, token);
    assert("GET /api/customers still returns { results, total } with all three", legacy.status === 200 && legacy.body.total === 3, `total=${legacy.body.total}`);
    const legacyRole = await request("GET", `/api/customers?${qs({ search: tag, role: "Bank" })}`, null, token);
    assert("its ?role= scope still works (CustomerCombobox)", legacyRole.body.total === 1 && legacyRole.body.results[0].id === B.id, `total=${legacyRole.body.total}`);
    const legacyCity = await request("GET", `/api/customers?${qs({ search: tag, city: "rot" })}`, null, token);
    assert("its city param is still a PARTIAL match (the table's Location filter is exact)", legacyCity.body.total === 1 && legacyCity.body.results[0].id === A.id, `total=${legacyCity.body.total}`);
    const legacyRoles = await request("GET", `/api/customers?${qs({ search: tag, limit: 50 })}`, null, token);
    assert("its rows carry derived roles too", legacyRoles.body.results.find(c => c.id === A.id)?.roles.includes("Shipper"));
    const one = await request("GET", `/api/customers/${A.id}`, null, token);
    assert("GET /api/customers/:id still resolves a real id", one.status === 200 && one.body.id === A.id);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const cleanupToken = await login().catch(() => null);
    if (cleanupToken) {
      // shipments first (they reference the customers and the contract), then the rest
      for (const id of cleanup.shipments) { try { await request("DELETE", `/api/shipments/${id}`, null, cleanupToken); } catch {} }
      for (const id of cleanup.customers) { try { await request("DELETE", `/api/customers/${id}`, null, cleanupToken); } catch {} }
      for (const id of cleanup.contracts) { try { await request("DELETE", `/api/contracts/${id}`, null, cleanupToken); } catch {} }
    }
  }
})();
