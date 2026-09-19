/**
 * Contracts list — the shared table system's second adopter (Quotes was the pilot). Covers
 * GET /api/contracts/table and GET /api/contracts/filter-options: repeated-param column filters,
 * "empty selection shows nothing", multi-valued columns (a contract has several legs and several
 * container types — it matches when ANY is selected), the non-column "active as of" filter, search,
 * sort, paging, and that the older GET /api/contracts (used by the Schedules page) is untouched.
 * See routes/contracts.js and lib/tableQuery.js.
 *
 * Every assertion scopes itself to three scratch contracts by a unique number prefix (search), since
 * the database already holds other contracts.
 *
 * Usage:
 *   node tests/contracts-table.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

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

// Repeated keys (?status=A&status=B), the way src/api.js's tableQs() sends them. A [] value sends
// the bare key with an empty value — the frontend's "deselect everything".
const qs = params => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) { if (v.length === 0) u.append(k, ""); else v.forEach(x => u.append(k, x)); }
    else u.append(k, v);
  }
  return u.toString();
};

(async () => {
  const cleanup = [];
  try {
    const token = await login();
    const tag = `TCT${Date.now()}`;
    const table = async (params = {}) => {
      const r = await request("GET", `/api/contracts/table?${qs({ search: tag, ...params })}`, null, token);
      return r;
    };
    const numbers = r => r.body.results.map(c => c.contractNumber.replace(tag, "").replace(/^-/, ""));

    console.log("Create three scratch contracts");
    const mk = async (suffix, extra) => {
      const r = await request("POST", "/api/contracts", {
        contractNumber: `${tag}-${suffix}`, currency: "USD",
        rates: [{ serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" }],
        ...extra,
      }, token);
      assert(`contract ${suffix} created (201)`, r.status === 201, JSON.stringify(r.body));
      cleanup.push(r.body.id);
      return r.body;
    };
    const commaAccount = "TCT, Beta & Sons";
    // A: two legs, two container types, DG, longest validity.  B: comma in the account name, Draft.
    // C: expired, no container types, no named account.
    const A = await mk("A", { carrierCode: "HLCU", status: "Active", validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }, { pol: "USNYC", pod: "CAMTR" }],
      containerTypes: ["20GP", "40HC"], dgAllowed: true, namedAccount: "TCT Acme" });
    const B = await mk("B", { carrierCode: "MAEU", status: "Draft", validFrom: "2026-03-01", validTo: "2026-06-30",
      legs: [{ pol: "NLRTM", pod: "USNYC" }], containerTypes: ["40HC"], dgAllowed: false, namedAccount: commaAccount });
    const C = await mk("C", { carrierCode: "HLCU", status: "Expired", validFrom: "2025-01-01", validTo: "2025-12-31",
      legs: [{ pol: "DEHAM", pod: "USSAV" }], dgAllowed: false });

    console.log("\nBasic shape, scoped by search");
    const base = await table();
    assert("responds 200 with { results, total, limit, offset }", base.status === 200 &&
      Array.isArray(base.body.results) && typeof base.body.total === "number" && base.body.limit === 50 && base.body.offset === 0, JSON.stringify(base.body).slice(0, 200));
    assert("the three scratch contracts are found by their number prefix", base.body.total === 3, `total=${base.body.total}`);
    const a = base.body.results.find(c => c.id === A.id);
    assert("rows carry the full list shape (legs, rates, routings, containerTypes)",
      a && a.legs.length === 2 && Array.isArray(a.rates) && Array.isArray(a.routings) && a.containerTypes.length === 2, JSON.stringify(a || {}).slice(0, 200));
    assert("legs keep their resolved shape (pol/pod)", a.legs[0].pol === "NLRTM" && a.legs[1].pod === "CAMTR");

    console.log("\nColumn filters: repeated params, AND across columns");
    let r = await table({ status: "Active" });
    assert("a single value filters exactly", numbers(r).join() === "A", numbers(r).join());
    r = await table({ status: ["Active", "Draft"] });
    assert("repeated values are OR-ed within a column", numbers(r).sort().join() === "A,B", numbers(r).join());
    r = await table({ status: "" });
    assert("a present-but-EMPTY param means show nothing, not no filter", r.status === 200 && r.body.total === 0, `total=${r.body.total}`);
    r = await table({ carrier: "HLCU", status: "Expired" });
    assert("columns AND together", numbers(r).join() === "C", numbers(r).join());
    r = await table({ carrier: ["HLCU", "MAEU"], status: ["Active", "Draft", "Expired"] });
    assert("selecting every value of every column returns everything", r.body.total === 3);
    r = await table({ carrier: "hlcu" });
    assert("matching is exact and case-sensitive (unlike the older list's partial ILIKE)", r.body.total === 0, `total=${r.body.total}`);
    r = await table({ namedAccount: commaAccount });
    assert("a value containing a comma (and an ampersand) matches as ONE value", numbers(r).join() === "B", numbers(r).join());
    r = await table({ contractNumber: `${tag}-C` });
    assert("Contract # column filter", numbers(r).join() === "C", numbers(r).join());
    r = await table({ validFrom: "2026-03-01" });
    assert("Valid From column filter", numbers(r).join() === "B", numbers(r).join());
    r = await table({ validTo: ["2025-12-31", "2027-01-01"] });
    assert("Valid To column filter, several values", numbers(r).sort().join() === "A,C", numbers(r).join());

    console.log("\nMulti-valued columns match on ANY value");
    r = await table({ route: "USNYC › CAMTR" });
    assert("a contract matches a route via its SECOND leg", numbers(r).join() === "A", numbers(r).join());
    r = await table({ route: "NLRTM › USNYC" });
    assert("a route shared by several contracts returns all of them", numbers(r).sort().join() === "A,B", numbers(r).join());
    r = await table({ route: ["USNYC › CAMTR", "DEHAM › USSAV"] });
    assert("several routes OR together", numbers(r).sort().join() === "A,C", numbers(r).join());
    r = await table({ containerType: "20GP" });
    assert("container type: only the contract that lists it", numbers(r).join() === "A", numbers(r).join());
    r = await table({ containerType: "40HC" });
    assert("container type shared by two contracts", numbers(r).sort().join() === "A,B", numbers(r).join());
    r = await table({ containerType: ["20GP", "40HC"] });
    assert("a contract with NO container types never matches a container-type selection", !numbers(r).includes("C"), numbers(r).join());
    r = await table({ dg: "DG allowed" });
    assert("DG allowed", numbers(r).join() === "A", numbers(r).join());
    r = await table({ dg: "No DG" });
    assert("No DG", numbers(r).sort().join() === "B,C", numbers(r).join());

    console.log("\nActive-as-of (the one non-column filter)");
    r = await table({ asOf: "2026-05-01" });
    assert("as of a date inside A and B, after C ended", numbers(r).sort().join() === "A,B", numbers(r).join());
    r = await table({ asOf: "2025-06-01" });
    assert("as of a date only C covers", numbers(r).join() === "C", numbers(r).join());
    r = await table({ asOf: "2028-01-01" });
    assert("as of a date after every contract", r.body.total === 0);
    r = await table({ asOf: "2026-05-01", status: "Draft" });
    assert("as-of combines with a column filter", numbers(r).join() === "B", numbers(r).join());

    console.log("\nSearch");
    r = await request("GET", `/api/contracts/table?${qs({ search: "deham" })}`, null, token);
    assert("search reaches a leg's port code, case-insensitively", r.body.results.some(c => c.id === C.id) && !r.body.results.some(c => c.id === A.id), `total=${r.body.total}`);
    r = await request("GET", `/api/contracts/table?${qs({ search: "tct, beta" })}`, null, token);
    assert("search reaches the named account", r.body.results.some(c => c.id === B.id), `total=${r.body.total}`);

    console.log("\nSort");
    r = await table();
    assert("default order is valid-from newest first", numbers(r).join() === "B,A,C", numbers(r).join());
    r = await table({ sort: "oldest" });
    assert("sort=oldest", numbers(r).join() === "C,A,B", numbers(r).join());
    r = await table({ sort: "validTo" });
    assert("sort=validTo puts the soonest-expiring first", numbers(r).join() === "C,B,A", numbers(r).join());
    r = await table({ sort: "contractNumber" });
    assert("sort=contractNumber is A–Z", numbers(r).join() === "A,B,C", numbers(r).join());
    r = await table({ sort: "carrier" });
    assert("sort=carrier is A–Z (HLCU before MAEU)", numbers(r).slice(-1)[0] === "B", numbers(r).join());
    r = await table({ sort: "nonsense" });
    assert("an unknown sort key falls back to the default order", numbers(r).join() === "B,A,C", numbers(r).join());

    console.log("\nPaging");
    r = await table({ limit: 2, offset: 0 });
    assert("first page holds `limit` rows but reports the full total", r.body.results.length === 2 && r.body.total === 3 && r.body.limit === 2);
    r = await table({ limit: 2, offset: 2 });
    assert("second page holds the remainder", r.body.results.length === 1 && r.body.offset === 2);
    assert("every paged row is still fully hydrated", r.body.results[0].legs.length >= 1 && Array.isArray(r.body.results[0].rates));
    r = await table({ limit: 5000 });
    assert("limit is capped at 200", r.body.limit === 200);

    console.log("\nfilter-options");
    const opts = await request("GET", "/api/contracts/filter-options", null, token);
    const keys = ["contractNumber", "carrier", "namedAccount", "route", "containerType", "dg", "validFrom", "validTo", "status"];
    assert("resolves (not swallowed by /:id) with a checklist per column",
      opts.status === 200 && keys.every(k => Array.isArray(opts.body[k])), JSON.stringify(Object.keys(opts.body || {})));
    assert("status options include the scratch statuses", ["Active", "Draft", "Expired"].every(s => opts.body.status.includes(s)));
    assert("route options list each leg separately, as \"POL › POD\"", opts.body.route.includes("USNYC › CAMTR") && opts.body.route.includes("DEHAM › USSAV") && opts.body.route.includes("NLRTM › USNYC"));
    assert("container types are listed one by one, not as a joined string", opts.body.containerType.includes("20GP") && opts.body.containerType.includes("40HC") && !opts.body.containerType.some(v => v.includes(",")));
    assert("dg offers both labels", opts.body.dg.includes("DG allowed") && opts.body.dg.includes("No DG"));
    assert("a comma-containing named account is one option", opts.body.namedAccount.includes(commaAccount));
    assert("blank values are never offered", !opts.body.namedAccount.includes("") && !opts.body.carrier.includes(""));
    assert("contract numbers include the scratch ones", [A, B, C].every(c => opts.body.contractNumber.includes(c.contractNumber)));
    const filtered = await request("GET", `/api/contracts/filter-options?${qs({ status: "Active" })}`, null, token);
    assert("options ignore the list's own filters (a value just unchecked stays selectable)", filtered.body.status.includes("Draft"));

    console.log("\nRegression: the older list endpoint is unchanged");
    const legacy = await request("GET", `/api/contracts?${qs({ search: tag, limit: 50 })}`, null, token);
    assert("GET /api/contracts still returns { results, total } with all three", legacy.status === 200 && legacy.body.total === 3, `total=${legacy.body.total}`);
    const legacyStatus = await request("GET", `/api/contracts?${qs({ search: tag, status: "Active" })}`, null, token);
    assert("its single-value status param still works", legacyStatus.body.total === 1);
    const legacyCarrier = await request("GET", `/api/contracts?${qs({ search: tag, carrier: "hl" })}`, null, token);
    assert("its carrier param is still a partial, case-insensitive match", legacyCarrier.body.total === 2, `total=${legacyCarrier.body.total}`);
    const one = await request("GET", `/api/contracts/${A.id}`, null, token);
    assert("GET /api/contracts/:id still resolves a real id", one.status === 200 && one.body.id === A.id);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const cleanupToken = await login().catch(() => null);
    if (cleanupToken) {
      for (const id of cleanup) { try { await request("DELETE", `/api/contracts/${id}`, null, cleanupToken); } catch {} }
    }
  }
})();
