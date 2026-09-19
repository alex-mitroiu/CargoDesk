/**
 * Freight Audit page — the shared table system's fifth adopter. Two tables: the All Invoices list
 * (GET /api/carrier-invoices, changed in place; + /filter-options) and the Exceptions tab
 * (GET /api/carrier-invoices/exceptions/table + /exceptions/filter-options — open variance/pending
 * LINES, capped at the 200 worst). Covers repeated-param column filters, "empty selection shows
 * nothing", search, sort, paging and checklist options — and that the bare GET
 * /api/carrier-invoices/exceptions array (the tab's count badge, relied on by other tests) is unchanged.
 * See routes/carrier-invoices.js and lib/tableQuery.js.
 *
 * Every assertion scopes itself to four scratch invoices by a unique invoice-number prefix (search),
 * since the database already holds others. They sit on two realistic, complete Central shipments.
 *
 * Usage:
 *   node tests/freight-audit-table.test.js
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

// Repeated keys (?status=A&status=B), the way src/api.js's tableQs() sends them; a [] value sends the
// bare key with an empty value — the frontend's "deselect everything".
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
    const tag = `TFA${Date.now()}`;

    console.log("Scratch parties, a Central contract (OF $1000 per 40HC) and two realistic, complete shipments");
    const mkCust = async companyName => {
      const r = await request("POST", "/api/customers", { companyName, city: "Rotterdam", countryIso2: "NL" }, token);
      cleanup.customers.push(r.body.id);
      return r.body;
    };
    const shipper = await mkCust(`${tag} Shipper`), consignee = await mkCust(`${tag} Consignee`);
    const contractNumber = `TFA-${Date.now()}`;
    const contract = await request("POST", "/api/contracts", {
      contractNumber, carrierCode: "MSCU", status: "Active", validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [{ serviceCode: "OF", amount: 1000, currency: "USD", unit: "per_container", containerType: "40HC" }],
    }, token);
    assert("scratch contract created", contract.status === 201, JSON.stringify(contract.body));
    cleanup.contracts.push(contract.body.id);
    const commodities = await request("GET", "/api/commodities?limit=1", null, token);
    const commodityCode = commodities.body?.results?.[0]?.code || "";
    const mkShipment = async () => {
      const s = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MSCU", contractType: "Central", contractId: contract.body.id, contractRef: contractNumber,
        incoterm: "FOB", etd: "2026-06-01", eta: "2026-06-15", commodityCode,
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        emoOfficeId, imoOfficeId,
      }, token);
      assert("scratch shipment created with parties, incoterm, route and dates", s.status === 201, JSON.stringify(s.body));
      cleanup.shipments.push(s.body.id);
      const c = await request("POST", "/api/containers", { shipmentId: s.body.id, size: "40", type: "HC", marksAndNumbers: "TFA / NO. 1-10" }, token);
      assert("real 40HC container added", c.status === 201 || c.status === 200, JSON.stringify(c.body));
      return s.body;
    };
    const S1 = await mkShipment(), S2 = await mkShipment();

    console.log("\nFour invoices — one Pending, one Approved, one Disputed, one with a variance");
    const mkInvoice = async (shipmentId, n, carrierCode, invoiceDate, lines) => {
      const r = await request("POST", "/api/carrier-invoices", { shipmentId, carrierCode, invoiceNumber: `${tag}-${n}`, invoiceDate, currency: "USD", lines }, token);
      assert(`invoice ${n} created (201)`, r.status === 201, JSON.stringify(r.body));
      return r.body;
    };
    // Created in this order, so newest-created-first is I4, I3, I2, I1.
    const I1 = await mkInvoice(S1.id, 1, "MSCU", "2026-06-01", [
      { serviceCode: "OF", description: "Ocean Freight", amount: 1000, currency: "USD" },
      { serviceCode: "MISC", description: "Unmapped miscellaneous charge", amount: 9000, currency: "USD" }]);
    const I2 = await mkInvoice(S1.id, 2, "HLCU", "2026-06-15", [{ serviceCode: "OF", description: "Ocean Freight (overcharged)", amount: 5000, currency: "USD" }]);
    let I3 = await mkInvoice(S2.id, 3, "MAEU", "2026-05-20", [{ serviceCode: "OF", description: "Ocean Freight", amount: 1000, currency: "USD" }]);
    let I4 = await mkInvoice(S1.id, 4, "MSCU", "2026-07-01", [{ serviceCode: "MISC", description: "Terminal handling", amount: 50, currency: "USD" }]);
    const approve = await request("POST", `/api/carrier-invoice-lines/${I3.lines[0].id}/approve`, {}, token);
    assert("I3's only line approved", approve.status === 200 && approve.body.status === "approved", JSON.stringify(approve.body));
    const dispute = await request("POST", `/api/carrier-invoice-lines/${I4.lines[0].id}/dispute`, { reason: "Not in the contract" }, token);
    assert("I4's only line disputed", dispute.status === 200 && dispute.body.status === "disputed", JSON.stringify(dispute.body));
    I3 = (await request("GET", `/api/carrier-invoices/${I3.id}`, null, token)).body;
    I4 = (await request("GET", `/api/carrier-invoices/${I4.id}`, null, token)).body;
    assert("statuses roll up: I1 Pending, I3 Approved, I4 Disputed", I1.status === "Pending" && I3.status === "Approved" && I4.status === "Disputed", `${I1.status}/${I2.status}/${I3.status}/${I4.status}`);
    const ofLine2 = I2.lines[0];
    assert("I2's line is a real variance against the contract rate ($5000 vs $1000)", ofLine2.status === "variance" && ofLine2.expectedAmount === 1000 && ofLine2.varianceUsd === 4000, JSON.stringify(ofLine2));

    // ═════════════════════════════════ All Invoices ═════════════════════════════════
    const table = (params = {}) => request("GET", `/api/carrier-invoices?${qs({ search: tag, ...params })}`, null, token);
    const nums = r => r.body.results.map(i => i.invoiceNumber.replace(`${tag}-`, ""));

    console.log("\nAll Invoices — basic shape, scoped by search");
    let r = await table();
    assert("responds 200 with { results, total, limit, offset } and finds all four by invoice-number prefix",
      r.status === 200 && r.body.total === 4 && r.body.limit === 50 && r.body.offset === 0, JSON.stringify(r.body).slice(0, 160));

    console.log("\nAll Invoices — column filters: repeated params, AND across columns");
    const expectStatus = s => [I1, I2, I3, I4].filter(i => i.status === s).map(i => i.invoiceNumber.replace(`${tag}-`, "")).sort().join();
    r = await table({ status: "Approved" });
    assert("Status: a single value filters exactly (also what the older ?status=X caller sent)", nums(r).sort().join() === expectStatus("Approved"), nums(r).join());
    r = await table({ status: ["Approved", "Disputed"] });
    assert("repeated values are OR-ed within a column", nums(r).sort().join() === "3,4", nums(r).join());
    r = await table({ status: "" });
    assert("a present-but-EMPTY param means show nothing, not no filter", r.status === 200 && r.body.total === 0, `total=${r.body.total}`);
    r = await table({ carrier: "MSCU" });
    assert("Carrier", nums(r).sort().join() === "1,4", nums(r).join());
    r = await table({ carrier: "mscu" });
    assert("...matching is exact and case-sensitive", r.body.total === 0, `total=${r.body.total}`);
    r = await table({ carrier: ["HLCU", "MAEU"] });
    assert("Carrier: several values OR together", nums(r).sort().join() === "2,3", nums(r).join());
    r = await table({ shipment: S2.id });
    assert("Shipment", nums(r).join() === "3", nums(r).join());
    r = await table({ shipment: [S1.id, S2.id] });
    assert("Shipment: both", r.body.total === 4);
    r = await table({ date: "2026-06-15" });
    assert("Date", nums(r).join() === "2", nums(r).join());
    r = await table({ invoice: `${tag}-3` });
    assert("Invoice #", nums(r).join() === "3", nums(r).join());
    r = await table({ carrier: "MSCU", status: "Disputed" });
    assert("columns AND together", nums(r).join() === "4", nums(r).join());
    r = await table({ carrier: "MAEU", status: "Disputed" });
    assert("...and can exclude everything", r.body.total === 0);

    console.log("\nAll Invoices — the SQL scopes are still exact");
    r = await request("GET", `/api/carrier-invoices?${qs({ search: tag, shipmentId: S2.id })}`, null, token);
    assert("shipmentId scope", r.body.total === 1 && nums(r).join() === "3", `total=${r.body.total}`);
    r = await request("GET", `/api/carrier-invoices?${qs({ search: tag, carrierCode: "hlcu" })}`, null, token);
    assert("carrierCode scope (uppercased, exact)", r.body.total === 1 && nums(r).join() === "2", `total=${r.body.total}`);
    r = await request("GET", `/api/carrier-invoices?${qs({ search: tag, shipmentId: "SHP-NOSUCH" })}`, null, token);
    assert("a shipmentId with no invoices returns nothing", r.body.total === 0);

    console.log("\nAll Invoices — search");
    r = await request("GET", `/api/carrier-invoices?${qs({ search: tag.toLowerCase() + "-2" })}`, null, token);
    assert("search is case-insensitive and reaches the invoice number", nums(r).join() === "2", `total=${r.body.total}`);
    r = await request("GET", `/api/carrier-invoices?${qs({ search: S2.id.toLowerCase() })}`, null, token);
    assert("search reaches the shipment id", r.body.results.some(i => i.id === I3.id) && !r.body.results.some(i => i.id === I1.id));

    console.log("\nAll Invoices — sort");
    r = await table();
    assert("default order is newest-created first", nums(r).join() === "4,3,2,1", nums(r).join());
    r = await table({ sort: "oldest" });
    assert("sort=oldest", nums(r).join() === "1,2,3,4", nums(r).join());
    r = await table({ sort: "date" });
    assert("sort=date is newest INVOICE date first", nums(r).join() === "4,2,1,3", nums(r).join());
    r = await table({ sort: "invoice" });
    assert("sort=invoice is A–Z by invoice number", nums(r).join() === "1,2,3,4", nums(r).join());
    r = await table({ sort: "nonsense" });
    assert("an unknown sort key falls back to the default order", nums(r).join() === "4,3,2,1", nums(r).join());

    console.log("\nAll Invoices — paging");
    r = await table({ limit: 3, offset: 0 });
    assert("first page holds `limit` rows but reports the full total", r.body.results.length === 3 && r.body.total === 4 && r.body.limit === 3);
    r = await table({ limit: 3, offset: 3 });
    assert("second page holds the remainder", r.body.results.length === 1 && r.body.offset === 3);
    r = await table({ limit: 5000 });
    assert("limit is capped at 200", r.body.limit === 200);

    console.log("\nAll Invoices — filter-options");
    const opts = await request("GET", "/api/carrier-invoices/filter-options", null, token);
    assert("resolves (not swallowed by /:id) with a checklist per column",
      opts.status === 200 && ["invoice", "shipment", "carrier", "date", "status"].every(k => Array.isArray(opts.body[k])), JSON.stringify(Object.keys(opts.body || {})));
    assert("carriers, shipments and statuses cover the scratch data",
      ["MSCU", "HLCU", "MAEU"].every(c => opts.body.carrier.includes(c)) && [S1.id, S2.id].every(s => opts.body.shipment.includes(s)) && ["Pending", "Approved", "Disputed"].every(s => opts.body.status.includes(s)));
    assert("invoice options are the number the column shows", [I1, I2, I3, I4].every(i => opts.body.invoice.includes(i.invoiceNumber)));
    assert("blanks are never offered", !opts.body.carrier.includes("") && !opts.body.date.includes(""));
    const optsFiltered = await request("GET", `/api/carrier-invoices/filter-options?${qs({ status: "Approved" })}`, null, token);
    assert("options ignore the list's own filters (a value just unchecked stays selectable)", optsFiltered.body.status.includes("Pending"));

    // ═════════════════════════════════ Exceptions ═════════════════════════════════
    const exc = (params = {}) => request("GET", `/api/carrier-invoices/exceptions/table?${qs({ search: tag, ...params })}`, null, token);
    const lines = r => r.body.results.map(e => `${e.invoiceNumber.replace(`${tag}-`, "")}:${e.serviceCode}`);

    console.log("\nExceptions — only OPEN lines (pending + variance), worst variance first");
    r = await exc();
    assert("responds 200 with exactly the two open lines (matched, approved and disputed lines never appear)",
      r.status === 200 && r.body.total === 2 && lines(r).sort().join() === "1:MISC,2:OF", lines(r).join());
    assert("default order is worst variance first (I2's $4000 before a pending line with no variance)", lines(r).join() === "2:OF,1:MISC", lines(r).join());
    const ex2 = r.body.results.find(e => e.invoiceId === I2.id);
    assert("rows carry the line fields and the invoice context the table shows",
      ex2.amountUsd === 5000 && ex2.expectedAmountUsd === 1000 && ex2.varianceUsd === 4000 && ex2.shipmentId === S1.id && ex2.invoiceNumber === `${tag}-2` && ex2.status === "variance", JSON.stringify(ex2));

    console.log("\nExceptions — column filters");
    r = await exc({ service: "MISC" });
    assert("Service", lines(r).join() === "1:MISC", lines(r).join());
    r = await exc({ status: "variance" });
    assert("Status: variance", lines(r).join() === "2:OF", lines(r).join());
    r = await exc({ status: ["pending", "variance"] });
    assert("Status: both", r.body.total === 2);
    r = await exc({ status: "" });
    assert("an empty selection shows nothing", r.body.total === 0, `total=${r.body.total}`);
    r = await exc({ invoice: `${tag}-1` });
    assert("Invoice", lines(r).join() === "1:MISC", lines(r).join());
    r = await exc({ shipment: S1.id });
    assert("Shipment", r.body.total === 2);
    r = await exc({ shipment: S2.id });
    assert("a shipment with no open lines shows nothing", r.body.total === 0);
    r = await exc({ service: "OF", status: "pending" });
    assert("columns AND together", r.body.total === 0);

    console.log("\nExceptions — search, sort, paging");
    r = await request("GET", `/api/carrier-invoices/exceptions/table?${qs({ search: "unmapped miscellaneous" })}`, null, token);
    assert("search reaches the line description, case-insensitively", r.body.results.some(e => e.invoiceId === I1.id));
    r = await exc({ sort: "amount" });
    assert("sort=amount is largest first (the $9000 pending line before the $5000 variance)", lines(r).join() === "1:MISC,2:OF", lines(r).join());
    r = await exc({ sort: "nonsense" });
    assert("an unknown sort key keeps the worst-variance order", lines(r).join() === "2:OF,1:MISC", lines(r).join());
    r = await exc({ limit: 1, offset: 0 });
    assert("first page holds `limit` rows but reports the full total", r.body.results.length === 1 && r.body.total === 2);
    r = await exc({ limit: 1, offset: 1 });
    assert("second page holds the remainder", r.body.results.length === 1 && r.body.offset === 1);

    console.log("\nExceptions — filter-options");
    const eopts = await request("GET", "/api/carrier-invoices/exceptions/filter-options", null, token);
    assert("resolves with a checklist per column", eopts.status === 200 && ["shipment", "invoice", "service", "status"].every(k => Array.isArray(eopts.body[k])), JSON.stringify(Object.keys(eopts.body || {})));
    assert("services and statuses come from the open lines", eopts.body.service.includes("MISC") && eopts.body.service.includes("OF") && eopts.body.status.includes("pending") && eopts.body.status.includes("variance"));
    assert("invoice options are the number the column shows", eopts.body.invoice.includes(`${tag}-1`) && eopts.body.invoice.includes(`${tag}-2`) && !eopts.body.invoice.includes(`${tag}-3`));
    const eoptsFiltered = await request("GET", `/api/carrier-invoices/exceptions/filter-options?${qs({ status: "variance" })}`, null, token);
    assert("options ignore the table's own filters", eoptsFiltered.body.status.includes("pending"));

    console.log("\nRegression: the bare exceptions array (the tab's count badge) is unchanged");
    const bare = await request("GET", "/api/carrier-invoices/exceptions", null, token);
    assert("GET /api/carrier-invoices/exceptions is still a plain array of lines", bare.status === 200 && Array.isArray(bare.body));
    assert("...containing the open lines, each with shipment/invoice context", [I1, I2].every(i => bare.body.some(e => e.invoiceId === i.id && e.shipmentId && e.invoiceNumber)));
    assert("...and not the resolved ones", !bare.body.some(e => e.invoiceId === I3.id || e.invoiceId === I4.id));
    assert("...capped at the 200 worst", bare.body.length <= 200);
    const one = await request("GET", `/api/carrier-invoices/${I1.id}`, null, token);
    assert("GET /api/carrier-invoices/:id still resolves a real id", one.status === 200 && one.body.id === I1.id && one.body.lines.length === 2);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const cleanupToken = await login().catch(() => null);
    if (cleanupToken) {
      // shipments first (their invoices go with them, and they reference the customers and the contract)
      for (const id of cleanup.shipments) { try { await request("DELETE", `/api/shipments/${id}`, null, cleanupToken); } catch {} }
      for (const id of cleanup.customers) { try { await request("DELETE", `/api/customers/${id}`, null, cleanupToken); } catch {} }
      for (const id of cleanup.contracts) { try { await request("DELETE", `/api/contracts/${id}`, null, cleanupToken); } catch {} }
    }
  }
})();
