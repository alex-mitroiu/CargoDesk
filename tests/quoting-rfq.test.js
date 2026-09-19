/**
 * Quoting / RFQ pre-booking stage — a quote precedes and converts into a shipment. Lifecycle:
 * Draft (freely editable) -> Sent (locked, awaiting the customer) -> Accepted | Declined | Expired
 * -> Converted (Accepted only). Pricing can reference a matched contract (GET /api/contracts/match,
 * unchanged) but the quote's own lines are the actual customer-facing offer; on conversion those
 * become the new shipment's SELL cost lines while the BUY side still comes from the real contract
 * via the existing importContractRates path. See routes/quotes.js.
 *
 * Usage:
 *   node tests/quoting-rfq.test.js
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
const pastDate = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

(async () => {
  const cleanup = { quotes: [], shipments: [], contracts: [] };
  try {
    const token = await login();

    console.log("Create a bare Draft quote — no lines yet, freely editable");
    const draft = await request("POST", "/api/quotes", {
      customerName: "Acme Trading Co", pol: "nlrtm", pod: "usnyc", carrierCode: "maeu",
    }, token);
    assert("quote created (201)", draft.status === 201, JSON.stringify(draft.body));
    const quoteId = draft.body.id;
    cleanup.quotes.push(quoteId);
    assert("status is Draft", draft.body.status === "Draft");
    assert("pol/pod uppercased", draft.body.pol === "NLRTM" && draft.body.pod === "USNYC");
    assert("totalAmountUsd is 0 with no lines", draft.body.totalAmountUsd === 0);

    console.log("\nSend rejected — no lines yet");
    const sendNoLines = await request("POST", `/api/quotes/${quoteId}/send`, {}, token);
    assert("send rejected with no lines", sendNoLines.status === 400, JSON.stringify(sendNoLines.body));

    console.log("\nPUT while Draft — adds lines, still no validUntil");
    const upd1 = await request("PUT", `/api/quotes/${quoteId}`, {
      customerName: "Acme Trading Co", pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU",
      lines: [
        { serviceCode: "of", description: "Ocean Freight", quantity: "1", rate: "1200", currency: "USD" },
        { serviceCode: "thc", description: "Origin THC", quantity: "2", rate: "150", currency: "USD" },
      ],
    }, token);
    assert("PUT returns 200", upd1.status === 200, JSON.stringify(upd1.body));
    assert("2 lines saved", upd1.body.lines.length === 2, JSON.stringify(upd1.body.lines));
    assert("total is 1200 + 2*150 = 1500", upd1.body.totalAmountUsd === 1500, String(upd1.body.totalAmountUsd));

    console.log("\nSend rejected — lines exist but no validUntil");
    const sendNoValidUntil = await request("POST", `/api/quotes/${quoteId}/send`, {}, token);
    assert("send rejected with no valid_until", sendNoValidUntil.status === 400, JSON.stringify(sendNoValidUntil.body));

    console.log("\nSend rejected — valid_until already in the past");
    const upd2 = await request("PUT", `/api/quotes/${quoteId}`, {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", validUntil: pastDate(1),
      lines: [{ serviceCode: "OF", description: "Ocean Freight", quantity: "1", rate: "1200", currency: "USD" }],
    }, token);
    assert("PUT with past validUntil still succeeds while Draft", upd2.status === 200, JSON.stringify(upd2.body));
    const sendPastDate = await request("POST", `/api/quotes/${quoteId}/send`, {}, token);
    assert("send rejected — valid_until in the past", sendPastDate.status === 400, JSON.stringify(sendPastDate.body));

    console.log("\nSend succeeds once valid_until is in the future");
    const upd3 = await request("PUT", `/api/quotes/${quoteId}`, {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", validUntil: futureDate(14),
      lines: [{ serviceCode: "OF", description: "Ocean Freight", quantity: "1", rate: "1200", currency: "USD" }],
    }, token);
    assert("PUT succeeds", upd3.status === 200, JSON.stringify(upd3.body));
    const send = await request("POST", `/api/quotes/${quoteId}/send`, {}, token);
    assert("send succeeds (200)", send.status === 200, JSON.stringify(send.body));
    assert("status is Sent", send.body.status === "Sent");
    assert("sentAt is set", !!send.body.sentAt);

    console.log("\nA Sent quote is locked from PUT edits");
    const editWhileSent = await request("PUT", `/api/quotes/${quoteId}`, { pol: "NLRTM", pod: "USNYC" }, token);
    assert("PUT rejected once Sent", editWhileSent.status === 409, JSON.stringify(editWhileSent.body));

    console.log("\nDecline path — a second Sent quote, declined with a reason");
    const draft2 = await request("POST", "/api/quotes", {
      customerName: "Beta Logistics", pol: "CNSHA", pod: "DEHAM", carrierCode: "MSCU",
      validUntil: futureDate(10),
      lines: [{ serviceCode: "OF", description: "Ocean Freight", quantity: "1", rate: "900", currency: "USD" }],
    }, token);
    const quote2Id = draft2.body.id;
    cleanup.quotes.push(quote2Id);
    await request("POST", `/api/quotes/${quote2Id}/send`, {}, token);
    const decline = await request("POST", `/api/quotes/${quote2Id}/decline`, { reason: "Rate too high vs. competitor" }, token);
    assert("decline succeeds (200)", decline.status === 200, JSON.stringify(decline.body));
    assert("status is Declined", decline.body.status === "Declined");
    assert("declineReason recorded", decline.body.declineReason === "Rate too high vs. competitor");
    const acceptDeclined = await request("POST", `/api/quotes/${quote2Id}/accept`, {}, token);
    assert("a Declined quote can't be accepted", acceptDeclined.status === 409, JSON.stringify(acceptDeclined.body));

    console.log("\nAccept rejected on a still-Draft quote");
    const draft3 = await request("POST", "/api/quotes", { pol: "USLAX", pod: "AUSYD" }, token);
    cleanup.quotes.push(draft3.body.id);
    const acceptDraft = await request("POST", `/api/quotes/${draft3.body.id}/accept`, {}, token);
    assert("accept rejected on a Draft quote", acceptDraft.status === 409, JSON.stringify(acceptDraft.body));

    console.log("\nConvert — full lifecycle with a real contract, so BUY (contract) and SELL (quote) cost lines can both be checked");
    const contractNum = `QTF-${Date.now()}`;
    const contract = await request("POST", "/api/contracts", {
      contractNumber: contractNum, carrierCode: "MSCU", status: "Active",
      validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [{ serviceCode: "OF", amount: 1000, currency: "USD", unit: "per_container", containerType: "" }],
    }, token);
    assert("scratch contract created", contract.status === 201, JSON.stringify(contract.body));
    const contractId = contract.body.id;
    cleanup.contracts.push(contractId);

    const matches = await request("GET", `/api/contracts/match?pol=NLRTM&pod=USNYC&carrier=MSCU`, null, token);
    assert("contract-match finds the scratch contract", matches.body.some(m => m.id === contractId), JSON.stringify(matches.body.map(m => m.id)));

    const quote3 = await request("POST", "/api/quotes", {
      customerName: "Gamma Freight", pol: "NLRTM", pod: "USNYC", carrierCode: "MSCU",
      contractId, contractRef: contractNum, validUntil: futureDate(7),
      // Quoted SELL price (1500) is deliberately higher than the contract's own BUY rate (1000) —
      // that gap is the margin; conversion must keep the two sides independent, not collapse them.
      lines: [{ serviceCode: "OF", description: "Ocean Freight", quantity: "1", rate: "1500", currency: "USD" }],
    }, token);
    assert("quote3 created with contract reference", quote3.status === 201, JSON.stringify(quote3.body));
    const quote3Id = quote3.body.id;
    cleanup.quotes.push(quote3Id);

    await request("POST", `/api/quotes/${quote3Id}/send`, {}, token);
    const accept3 = await request("POST", `/api/quotes/${quote3Id}/accept`, {}, token);
    assert("quote3 accepted", accept3.status === 200 && accept3.body.status === "Accepted", JSON.stringify(accept3.body));

    const convert = await request("POST", `/api/quotes/${quote3Id}/convert`, {}, token);
    assert("convert succeeds (200)", convert.status === 200, JSON.stringify(convert.body));
    assert("quote status is Converted", convert.body.quote.status === "Converted", JSON.stringify(convert.body.quote));
    assert("convertedShipmentId is set", !!convert.body.shipmentId);
    // The full mapped shipment must come back inline — the frontend drops it straight into its own
    // local shipments list before navigating (mirrors how a direct POST /api/shipments create
    // response is used); without this the SPA's detail page has nothing to render for a shipment
    // it doesn't yet know about, and shows blank.
    assert("full shipment object included inline (not just the id)", convert.body.shipment?.id === convert.body.shipmentId, JSON.stringify(convert.body.shipment));
    assert("inline shipment carries the quote's route/carrier", convert.body.shipment?.pol === "NLRTM" && convert.body.shipment?.pod === "USNYC" && convert.body.shipment?.carrierCode === "MSCU", JSON.stringify(convert.body.shipment));
    const shipmentId = convert.body.shipmentId;
    cleanup.shipments.push(shipmentId);

    const shipment = await request("GET", `/api/shipments/${shipmentId}`, null, token);
    assert("shipment created as Central (had a contractId)", shipment.body.contractType === "Central", JSON.stringify(shipment.body));
    assert("shipment carries the quote's route/carrier", shipment.body.pol === "NLRTM" && shipment.body.pod === "USNYC" && shipment.body.carrierCode === "MSCU");
    assert("shipment carries the customer as shipper", shipment.body.shipperName === "Gamma Freight", JSON.stringify(shipment.body));

    const costLines = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
    const buyLine = costLines.body.find(l => l.type === "BUY" && l.chargeCode === "Ocean Freight");
    const sellLine = costLines.body.find(l => l.type === "SELL" && l.chargeCode === "Ocean Freight");
    assert("a BUY cost line exists from the real matched contract (1000)", !!buyLine && buyLine.amount === 1000, JSON.stringify(buyLine));
    assert("a SELL cost line exists from the quote's own price (1500), independent of the contract rate", !!sellLine && sellLine.amount === 1500, JSON.stringify(sellLine));
    assert("SELL line is sourced from the quote", sellLine?.source === "quote", JSON.stringify(sellLine));

    console.log("\nDelete guard — a Converted quote can't be deleted, but the earlier Declined one can");
    const delConverted = await request("DELETE", `/api/quotes/${quote3Id}`, null, token);
    assert("delete rejected once Converted", delConverted.status === 400, JSON.stringify(delConverted.body));
    const delDeclined = await request("DELETE", `/api/quotes/${quote2Id}`, null, token);
    assert("delete succeeds for a Declined quote", delDeclined.status === 200, JSON.stringify(delDeclined.body));
    cleanup.quotes = cleanup.quotes.filter(id => id !== quote2Id);

    console.log("\nList + status filter");
    const listSent = await request("GET", "/api/quotes?status=Sent", null, token);
    assert("status filter returns only Sent quotes", listSent.body.results.every(q => q.status === "Sent"), JSON.stringify(listSent.body.results.map(q => q.status)));

    // Shipments-style table endpoints (lib/tableQuery.js) — two scratch quotes under a unique tag so
    // every assertion below is scoped to exactly them, whatever else is in the database. One
    // customer name deliberately contains a comma ("... & Sons, Ltd."): column filters travel as
    // repeated params precisely so a comma inside a value can't be mistaken for a separator.
    console.log("\nTable query — multi-value column filters, search, sort, paging, filter-options");
    const tag = `TBLQ${Date.now().toString(36).toUpperCase()}`;
    const commaCustomer = `${tag} & Sons, Ltd.`;
    const tq1 = await request("POST", "/api/quotes", { customerName: commaCustomer, pol: "cnsha", pod: "usnyc", carrierCode: "cmdu" }, token);
    const tq2 = await request("POST", "/api/quotes", { customerName: `${tag} Freight`, pol: "cnsha", pod: "uslax", carrierCode: "maeu" }, token);
    assert("both scratch quotes created", tq1.status === 201 && tq2.status === 201, JSON.stringify([tq1.body, tq2.body]));
    cleanup.quotes.push(tq1.body.id, tq2.body.id);
    const list = qs => request("GET", `/api/quotes?${qs}`, null, token);
    const idsOf = r => r.body.results.map(x => x.id);
    const sortedIds = r => idsOf(r).sort().join(",");
    const both = [tq1.body.id, tq2.body.id].sort().join(",");

    const multi = await list(`search=${tag}&carrier=CMDU&carrier=MAEU`);
    assert("repeated params match either value", sortedIds(multi) === both, JSON.stringify(idsOf(multi)));
    const single = await list(`search=${tag}&carrier=CMDU`);
    assert("a single value still filters (callers that predate multi-select keep working)", idsOf(single).join() === tq1.body.id, JSON.stringify(idsOf(single)));
    const comma = await list(`customer=${encodeURIComponent(commaCustomer)}`);
    assert("a customer name containing a comma filters as ONE value", comma.body.total === 1 && idsOf(comma)[0] === tq1.body.id, JSON.stringify(comma.body));
    const byRoute = await list(`search=${tag}&route=${encodeURIComponent("CNSHA→USLAX")}`);
    assert("the route column filters on POL→POD", idsOf(byRoute).join() === tq2.body.id, JSON.stringify(idsOf(byRoute)));
    const anded = await list(`search=${tag}&carrier=CMDU&route=${encodeURIComponent("CNSHA→USLAX")}`);
    assert("filters on two columns combine with AND", anded.body.total === 0, JSON.stringify(anded.body.total));
    const emptySel = await list("status=");
    assert("an empty selection (?status=) shows nothing rather than being ignored", emptySel.body.total === 0 && emptySel.body.results.length === 0, JSON.stringify(emptySel.body.total));
    const ci = await list(`search=${tag.toLowerCase()}`);
    assert("search is case-insensitive and reaches the customer name", ci.body.total === 2, JSON.stringify(ci.body.total));
    const newest = await list(`search=${tag}`);
    assert("default order is newest first", idsOf(newest).join() === [tq2.body.id, tq1.body.id].join(), JSON.stringify(idsOf(newest)));
    const oldest = await list(`search=${tag}&sort=oldest`);
    assert("sort=oldest reverses it", idsOf(oldest).join() === [tq1.body.id, tq2.body.id].join(), JSON.stringify(idsOf(oldest)));
    const page2 = await list(`search=${tag}&limit=1&offset=1`);
    assert("paging applies after filtering (total 2, one row on page 2)", page2.body.total === 2 && page2.body.results.length === 1 && page2.body.offset === 1, JSON.stringify(page2.body));

    const opts = await request("GET", "/api/quotes/filter-options", null, token);
    assert("filter-options resolves (not swallowed by /:id) with a checklist per column",
      opts.status === 200 && ["id", "customer", "route", "carrier", "validUntil", "status"].every(k => Array.isArray(opts.body[k])), JSON.stringify(Object.keys(opts.body || {})));
    assert("a comma-containing customer is a single checklist option", opts.body.customer?.includes(commaCustomer));
    assert("checklists come from the whole visible set, not a filtered page", opts.body.id?.includes(tq1.body.id) && opts.body.id?.includes(tq2.body.id));
    assert("route options are POL→POD strings", opts.body.route?.includes("CNSHA→USLAX") && opts.body.route?.includes("CNSHA→USNYC"));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const cleanupToken = await login().catch(() => null);
    if (cleanupToken) {
      for (const id of cleanup.quotes) { try { await request("DELETE", `/api/quotes/${id}`, null, cleanupToken); } catch {} }
      for (const id of cleanup.shipments) { try { await request("DELETE", `/api/shipments/${id}`, null, cleanupToken); } catch {} }
      for (const id of cleanup.contracts) { try { await request("DELETE", `/api/contracts/${id}`, null, cleanupToken); } catch {} }
    }
  }
})();
