/**
 * CRM / pre-sales pipeline (TKT-WW8THL, Epic TKT-GTGM6R) — an opportunity precedes and converts
 * into a quote, the same way a quote precedes and converts into a shipment. Lifecycle: New ->
 * Qualified -> Converted (to Quote, Qualified only) | Lost (from New or Qualified). No separate
 * "Won" status — Converted IS the win condition; the resulting quote's own already-shipped
 * Draft->Sent->Accepted->...->Converted(to shipment) lifecycle takes over from there. See
 * routes/opportunities.js.
 *
 * Usage:
 *   node tests/opportunities.test.js
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

const futureDate = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

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
  const cleanup = { opportunities: [], quotes: [] };
  try {
    const token = await login();

    console.log("Create a bare opportunity — just a title, nothing else known yet");
    const bare = await request("POST", "/api/opportunities", { title: "Cold lead — trade show badge scan" }, token);
    assert("opportunity created (201)", bare.status === 201, JSON.stringify(bare.body));
    const bareId = bare.body.id;
    cleanup.opportunities.push(bareId);
    assert("status is New", bare.body.status === "New");
    assert("estimatedValue defaults to 0", bare.body.estimatedValue === 0);
    assert("pol/pod blank", bare.body.pol === "" && bare.body.pod === "");

    console.log("\nTitle is required");
    const noTitle = await request("POST", "/api/opportunities", { customerName: "Someone" }, token);
    assert("create rejected with no title", noTitle.status === 400, JSON.stringify(noTitle.body));

    console.log("\nQualify rejected on the bare opportunity, then Lost from New");
    const loseFromNew = await request("POST", `/api/opportunities/${bareId}/lose`, { reason: "Not a real opportunity — spam scan" }, token);
    assert("lose from New succeeds", loseFromNew.status === 200 && loseFromNew.body.status === "Lost", JSON.stringify(loseFromNew.body));
    assert("lostReason recorded", loseFromNew.body.lostReason === "Not a real opportunity — spam scan");
    const qualifyLost = await request("POST", `/api/opportunities/${bareId}/qualify`, {}, token);
    assert("qualify rejected once Lost", qualifyLost.status === 409, JSON.stringify(qualifyLost.body));
    const editLost = await request("PUT", `/api/opportunities/${bareId}`, { title: "renamed" }, token);
    assert("PUT rejected once Lost", editLost.status === 409, JSON.stringify(editLost.body));

    console.log("\nFull happy path — New -> Qualified -> Convert -> the resulting quote is real and independently usable");
    const opp = await request("POST", "/api/opportunities", {
      title: "Q3 lane expansion — NL to US East Coast", customerName: "Acme Trading Co",
      pol: "nlrtm", pod: "usnyc", carrierCode: "maeu", commodityCode: "8471.30",
      estimatedValue: "25000", currency: "usd", estimatedCloseDate: futureDate(30),
      leadSource: "Referral", notes: "Existing customer wants to add a second lane",
    }, token);
    assert("full opportunity created (201)", opp.status === 201, JSON.stringify(opp.body));
    const oppId = opp.body.id;
    cleanup.opportunities.push(oppId);
    assert("pol/pod/carrierCode uppercased", opp.body.pol === "NLRTM" && opp.body.pod === "USNYC" && opp.body.carrierCode === "MAEU");
    assert("currency uppercased", opp.body.currency === "USD");
    assert("estimatedValueUsd resolved (non-zero for a non-zero USD value)", opp.body.estimatedValueUsd === 25000, String(opp.body.estimatedValueUsd));

    const convertTooEarly = await request("POST", `/api/opportunities/${oppId}/convert`, {}, token);
    assert("convert rejected while still New", convertTooEarly.status === 409, JSON.stringify(convertTooEarly.body));

    const qualify = await request("POST", `/api/opportunities/${oppId}/qualify`, {}, token);
    assert("qualify succeeds (200)", qualify.status === 200, JSON.stringify(qualify.body));
    assert("status is Qualified", qualify.body.status === "Qualified");
    assert("qualifiedAt is set", !!qualify.body.qualifiedAt);

    const editWhileQualified = await request("PUT", `/api/opportunities/${oppId}`, {
      title: "Q3 lane expansion — revised", customerName: "Acme Trading Co", pol: "NLRTM", pod: "USNYC",
    }, token);
    assert("still editable while Qualified", editWhileQualified.status === 200 && editWhileQualified.body.title === "Q3 lane expansion — revised", JSON.stringify(editWhileQualified.body));

    const convert = await request("POST", `/api/opportunities/${oppId}/convert`, {}, token);
    assert("convert succeeds (200)", convert.status === 200, JSON.stringify(convert.body));
    assert("opportunity status is Converted", convert.body.opportunity.status === "Converted", JSON.stringify(convert.body.opportunity));
    assert("convertedQuoteId is set", !!convert.body.quoteId);
    assert("full quote object included inline (not just the id)", convert.body.quote?.id === convert.body.quoteId, JSON.stringify(convert.body.quote));
    assert("inline quote carries the opportunity's customer/route", convert.body.quote?.customerName === "Acme Trading Co" && convert.body.quote?.pol === "NLRTM" && convert.body.quote?.pod === "USNYC", JSON.stringify(convert.body.quote));
    assert("inline quote is a real Draft, not pre-locked", convert.body.quote?.status === "Draft");
    assert("estimatedCloseDate was NOT written into the quote's cargoReadyDate (unrelated concepts)", convert.body.quote?.cargoReadyDate === "", JSON.stringify(convert.body.quote));
    const quoteId = convert.body.quoteId;
    cleanup.quotes.push(quoteId);

    const convertAgain = await request("POST", `/api/opportunities/${oppId}/convert`, {}, token);
    assert("convert rejected once already Converted", convertAgain.status === 409, JSON.stringify(convertAgain.body));
    const loseConverted = await request("POST", `/api/opportunities/${oppId}/lose`, { reason: "too late" }, token);
    assert("lose rejected once Converted", loseConverted.status === 409, JSON.stringify(loseConverted.body));
    const editConverted = await request("PUT", `/api/opportunities/${oppId}`, { title: "x" }, token);
    assert("PUT rejected once Converted", editConverted.status === 409, JSON.stringify(editConverted.body));

    console.log("\nThe converted quote composes cleanly with Quotes' own already-shipped lifecycle — no special-casing needed on that side");
    const addLineAndValidUntil = await request("PUT", `/api/quotes/${quoteId}`, {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", validUntil: futureDate(14),
      lines: [{ serviceCode: "OF", description: "Ocean Freight", quantity: "1", rate: "20000", currency: "USD" }],
    }, token);
    assert("the opportunity-sourced quote accepts a normal PUT edit", addLineAndValidUntil.status === 200, JSON.stringify(addLineAndValidUntil.body));
    const sendQuote = await request("POST", `/api/quotes/${quoteId}/send`, {}, token);
    assert("send succeeds", sendQuote.status === 200 && sendQuote.body.status === "Sent", JSON.stringify(sendQuote.body));
    const acceptQuote = await request("POST", `/api/quotes/${quoteId}/accept`, {}, token);
    assert("accept succeeds", acceptQuote.status === 200 && acceptQuote.body.status === "Accepted", JSON.stringify(acceptQuote.body));
    const convertToShipment = await request("POST", `/api/quotes/${quoteId}/convert`, {}, token);
    assert("the opportunity-sourced quote converts to a real shipment", convertToShipment.status === 200 && !!convertToShipment.body.shipmentId, JSON.stringify(convertToShipment.body));
    const shipmentId = convertToShipment.body.shipmentId;

    console.log("\nDelete guards — a Converted opportunity can't be deleted, an earlier Lost one can");
    const delConverted = await request("DELETE", `/api/opportunities/${oppId}`, null, token);
    assert("delete rejected once Converted", delConverted.status === 400, JSON.stringify(delConverted.body));
    const delLost = await request("DELETE", `/api/opportunities/${bareId}`, null, token);
    assert("delete succeeds for a Lost opportunity", delLost.status === 200, JSON.stringify(delLost.body));
    cleanup.opportunities = cleanup.opportunities.filter(id => id !== bareId);

    console.log("\nList + status filter");
    const listQualified = await request("GET", "/api/opportunities?status=Converted", null, token);
    assert("status filter returns only Converted opportunities", listQualified.body.results.every(o => o.status === "Converted"), JSON.stringify(listQualified.body.results.map(o => o.status)));
    assert("our converted opportunity is in the filtered list", listQualified.body.results.some(o => o.id === oppId));

    // ── Table view: the shared Shipments-style filter/sort/search/page semantics (lib/tableQuery.js) ──
    // Everything is scoped to three scratch opportunities by a unique title tag, since the database
    // already holds others.
    console.log("\nTable view — column filters, search, sort, paging, filter-options");
    const tag = `TBL${Date.now()}`;
    const me = await request("GET", "/api/auth/me", null, token);
    const myId = me.body.id || me.body.user?.id, myName = me.body.name || me.body.user?.name;
    const commaCustomer = "Smith & Sons, Ltd.";
    const mkOpp = async payload => {
      const r = await request("POST", "/api/opportunities", payload, token);
      assert(`scratch opportunity "${payload.title}" created`, r.status === 201, JSON.stringify(r.body));
      cleanup.opportunities.push(r.body.id);
      return r.body;
    };
    // Created in this order, so newest-first is C, B, A.
    const tA = await mkOpp({ title: `${tag} alpha`, customerName: "Acme Trading Co", pol: "NLRTM", pod: "USNYC",
      estimatedValue: 5000, estimatedCloseDate: futureDate(10), leadSource: "Referral", assigneeId: myId });
    const tB = await mkOpp({ title: `${tag} beta, phase 2`, customerName: commaCustomer, pol: "CNSHA", pod: "USLAX",
      estimatedValue: 20000, estimatedCloseDate: futureDate(3), leadSource: "Trade Show" });
    const tC = await mkOpp({ title: `${tag} gamma`, estimatedValue: 100 });
    const q1 = await request("POST", `/api/opportunities/${tB.id}/qualify`, {}, token);
    assert("one scratch opportunity qualified (gives the status column two values)", q1.status === 200, JSON.stringify(q1.body));

    const table = (params = {}) => request("GET", `/api/opportunities?${qs({ search: tag, ...params })}`, null, token);
    const titles = r => r.body.results.map(o => o.title.replace(`${tag} `, "").split(",")[0]);

    let r = await table();
    assert("responds with { results, total, limit, offset } and finds all three by title tag",
      r.status === 200 && r.body.total === 3 && r.body.limit === 50 && r.body.offset === 0, JSON.stringify(r.body).slice(0, 160));

    r = await table({ status: "Qualified" });
    assert("single-value status filter (also what the older ?status=X callers send)", titles(r).join() === "beta", titles(r).join());
    r = await table({ status: ["New", "Qualified"] });
    assert("repeated values are OR-ed within a column", r.body.total === 3);
    r = await table({ status: "" });
    assert("a present-but-EMPTY param means show nothing, not no filter", r.status === 200 && r.body.total === 0, `total=${r.body.total}`);
    r = await table({ customer: commaCustomer });
    assert("a customer name containing a comma and an ampersand matches as ONE value", titles(r).join() === "beta", titles(r).join());
    r = await table({ customer: ["Acme Trading Co", commaCustomer] });
    assert("several customers OR together", titles(r).sort().join() === "alpha,beta", titles(r).join());
    r = await table({ customer: "Acme Trading Co", status: "Qualified" });
    assert("columns AND together (Acme's is New, so Qualified matches nothing)", r.body.total === 0, `total=${r.body.total}`);
    r = await table({ closeDate: futureDate(3) });
    assert("Est. Close column filter", titles(r).join() === "beta", titles(r).join());
    r = await table({ title: `${tag} gamma` });
    assert("Title column filter", titles(r).join() === "gamma", titles(r).join());
    if (myName) {
      r = await table({ assignee: myName });
      assert("Assignee column filters on the resolved name, not the id", titles(r).join() === "alpha", titles(r).join());
    }
    r = await request("GET", `/api/opportunities?${qs({ customerId: "NO-SUCH-CUSTOMER", search: tag })}`, null, token);
    assert("customerId is still an exact SQL scope alongside the table filters", r.body.total === 0);

    r = await request("GET", `/api/opportunities?${qs({ search: "smith & sons" })}`, null, token);
    assert("search is case-insensitive and reaches the customer name", r.body.results.some(o => o.id === tB.id), `total=${r.body.total}`);
    r = await request("GET", `/api/opportunities?${qs({ search: "cnsha" })}`, null, token);
    assert("search reaches the route", r.body.results.some(o => o.id === tB.id) && !r.body.results.some(o => o.id === tA.id));
    r = await request("GET", `/api/opportunities?${qs({ search: "trade show" })}`, null, token);
    assert("search reaches the lead source", r.body.results.some(o => o.id === tB.id));

    r = await table();
    assert("default order is newest first", titles(r).join() === "gamma,beta,alpha", titles(r).join());
    r = await table({ sort: "oldest" });
    assert("sort=oldest", titles(r).join() === "alpha,beta,gamma", titles(r).join());
    r = await table({ sort: "closeDate" });
    assert("sort=closeDate puts the soonest first and a blank date LAST", titles(r).join() === "beta,alpha,gamma", titles(r).join());
    r = await table({ sort: "value" });
    assert("sort=value is largest first", titles(r).join() === "beta,alpha,gamma", titles(r).join());
    r = await table({ sort: "customer" });
    assert("sort=customer is A–Z with a blank customer LAST", titles(r).join() === "alpha,beta,gamma", titles(r).join());
    r = await table({ sort: "nonsense" });
    assert("an unknown sort key falls back to the default order", titles(r).join() === "gamma,beta,alpha", titles(r).join());

    r = await table({ limit: 2, offset: 0 });
    assert("first page holds `limit` rows but reports the full total", r.body.results.length === 2 && r.body.total === 3 && r.body.limit === 2);
    r = await table({ limit: 2, offset: 2 });
    assert("second page holds the remainder", r.body.results.length === 1 && r.body.offset === 2);
    r = await request("GET", "/api/opportunities?limit=200", null, token);
    assert("the Dashboard's bare { limit } call still returns { results, total }", r.status === 200 && Array.isArray(r.body.results) && typeof r.body.total === "number");

    const opts = await request("GET", "/api/opportunities/filter-options", null, token);
    const optKeys = ["id", "title", "customer", "closeDate", "assignee", "status"];
    assert("filter-options resolves (not swallowed by /:id) with a checklist per column",
      opts.status === 200 && optKeys.every(k => Array.isArray(opts.body[k])), JSON.stringify(Object.keys(opts.body || {})));
    assert("a comma-containing customer is a single checklist option", opts.body.customer?.includes(commaCustomer));
    assert("blank values (the unassigned/no-customer rows) are never offered", !opts.body.customer.includes("") && !opts.body.assignee.includes("") && !opts.body.closeDate.includes(""));
    assert("checklists come from the whole visible set", [tA, tB, tC].every(o => opts.body.id.includes(o.id)));
    assert("status options include both scratch statuses", opts.body.status.includes("New") && opts.body.status.includes("Qualified"));
    const optsFiltered = await request("GET", `/api/opportunities/filter-options?${qs({ status: "Lost" })}`, null, token);
    assert("options ignore the list's own filters (a value just unchecked stays selectable)", optsFiltered.body.status.includes("New"));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;

    // Cleanup that must run before the finally block's own opportunity/quote deletes, since the
    // shipment references the quote only informationally (no FK) but tidying newest-first avoids
    // ever leaving a dangling reference visible even momentarily.
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token).catch(() => {});
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const cleanupToken = await login().catch(() => null);
    if (cleanupToken) {
      for (const id of cleanup.opportunities) { try { await request("DELETE", `/api/opportunities/${id}`, null, cleanupToken); } catch {} }
      for (const id of cleanup.quotes) { try { await request("DELETE", `/api/quotes/${id}`, null, cleanupToken); } catch {} }
    }
  }
})();
