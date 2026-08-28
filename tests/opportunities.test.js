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
