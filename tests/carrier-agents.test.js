/**
 * Carrier Line Agents — carrier x agent (header) -> one or more locations, each either a
 * specific UN/LOCODE or a whole country, auto-resolving onto shipments as "Line Agent
 * (Export)"/"Line Agent (Import)" additional parties (see resolveCarrierAgent /
 * maybeAssignLineAgents, routes/shipments.js + routes/mdm.js).
 *
 * Usage:
 *   node tests/carrier-agents.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC, ESBCN, ESVLC present in port_locations (seeded MDM data)
 *   - ES (Spain), AD (Andorra) present in countries (seeded MDM data)
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

    console.log("\nScratch agent customer");
    const agentCust = await request("POST", "/api/customers", { companyName: "Test Line Agent Co" }, token);
    const agentId = agentCust.body.id;
    assert("agent customer created", !!agentId);

    console.log("\nCarrier Agents CRUD — create header + first location (UN/LOCODE)");
    const created = await request("POST", "/api/carrier-agents",
      { carrierCode: "TSTL", agentCustomerId: agentId, note: "Test note", locationType: "unlocode", unlocode: "NLRTM" }, token);
    assert("create returns 201", created.status === 201, JSON.stringify(created.body));
    assert("carrierCode round-trips", created.body.carrierCode === "TSTL");
    assert("agentCustomerName resolves via live join", created.body.agentCustomerName === "Test Line Agent Co");
    assert("exactly one location present", created.body.locations?.length === 1);
    assert("location is the NLRTM unlocode", created.body.locations[0].type === "unlocode" && created.body.locations[0].unlocode === "NLRTM");

    console.log("\nCarrier Agents CRUD — duplicate (carrier,location) rejected on a NEW header");
    const dupeCust = await request("POST", "/api/customers", { companyName: "Test Duplicate Agent Co" }, token);
    const dupe = await request("POST", "/api/carrier-agents",
      { carrierCode: "TSTL", agentCustomerId: dupeCust.body.id, locationType: "unlocode", unlocode: "NLRTM" }, token);
    assert("duplicate location under a different agent rejected", dupe.status >= 400);
    await request("DELETE", `/api/customers/${dupeCust.body.id}`, null, token);

    console.log("\nCarrier Agents CRUD — list includes it");
    const list1 = await request("GET", "/api/carrier-agents", null, token);
    assert("list returns 200", list1.status === 200);
    assert("created header present in list", list1.body.some(a => a.id === created.body.id));

    console.log("\nCarrier Agents CRUD — update note only");
    const updated = await request("PUT", `/api/carrier-agents/${created.body.id}`, { note: "Updated note" }, token);
    assert("update returns 200", updated.status === 200);
    assert("note updated", updated.body.note === "Updated note");
    assert("agent unchanged", updated.body.agentCustomerId === agentId);

    console.log("\n" + "─".repeat(50));
    console.log("Multi-location configuration — 'a Line Agent in Spain can also handle Andorra'");

    const esAgentCust = await request("POST", "/api/customers", { companyName: "Test Iberia Line Agents SL" }, token);
    const esHeader = await request("POST", "/api/carrier-agents",
      { carrierCode: "TSTZ", agentCustomerId: esAgentCust.body.id, locationType: "unlocode", unlocode: "ESBCN" }, token);
    assert("ES header created with ESBCN", esHeader.status === 201);
    const headerId = esHeader.body.id;

    const addESVLC = await request("POST", `/api/carrier-agents/${headerId}/locations`, { locationType: "unlocode", unlocode: "ESVLC" }, token);
    assert("second unlocode (ESVLC) added", addESVLC.status === 201);
    assert("header now has 2 locations", addESVLC.body.locations.length === 2);

    const addAD = await request("POST", `/api/carrier-agents/${headerId}/locations`, { locationType: "country", countryIso2: "AD" }, token);
    assert("country AD added alongside the two UN/LOCODEs", addAD.status === 201);
    assert("no discards from adding AD (no AD ports involved)", addAD.body.discarded.length === 0);
    assert("header now has 3 locations (ESBCN, ESVLC, AD)", addAD.body.locations.length === 3);

    console.log("\nAdding country ES auto-discards the now-redundant UN/LOCODEs, logged not silently dropped");
    const addES = await request("POST", `/api/carrier-agents/${headerId}/locations`, { locationType: "country", countryIso2: "ES" }, token);
    assert("country ES added", addES.status === 201);
    assert("ESBCN and ESVLC both reported as discarded", addES.body.discarded.length === 2
      && addES.body.discarded.includes("ESBCN") && addES.body.discarded.includes("ESVLC"));
    assert("header now has exactly 2 locations left (AD, ES)", addES.body.locations.length === 2);
    assert("no unlocode-type locations remain", !addES.body.locations.some(l => l.type === "unlocode"));

    console.log("\nRe-adding a now-covered UN/LOCODE is rejected (nothing to discard, never saved)");
    const reAdd = await request("POST", `/api/carrier-agents/${headerId}/locations`, { locationType: "unlocode", unlocode: "ESBCN" }, token);
    assert("re-adding ESBCN rejected as already covered by ES", reAdd.status >= 400);

    console.log("\nA different header cannot claim the same country for the same carrier");
    const otherAgentCust = await request("POST", "/api/customers", { companyName: "Test Other Iberia Agent Co" }, token);
    const conflictHeader = await request("POST", "/api/carrier-agents",
      { carrierCode: "TSTZ", agentCustomerId: otherAgentCust.body.id, locationType: "country", countryIso2: "ES" }, token);
    assert("cross-header country conflict rejected", conflictHeader.status >= 400);
    await request("DELETE", `/api/customers/${otherAgentCust.body.id}`, null, token);

    console.log("\nRemoving a single location leaves the header and its other locations intact");
    const headerBefore = (await request("GET", "/api/carrier-agents", null, token)).body.find(a => a.id === headerId);
    const adLoc = headerBefore.locations.find(l => l.type === "country" && l.countryIso2 === "AD");
    const delLoc = await request("DELETE", `/api/carrier-agent-locations/${adLoc.id}`, null, token);
    assert("location delete returns 200", delLoc.status === 200);
    const headerAfter = (await request("GET", "/api/carrier-agents", null, token)).body.find(a => a.id === headerId);
    assert("header still exists with exactly 1 location left (ES)", headerAfter.locations.length === 1 && headerAfter.locations[0].countryIso2 === "ES");

    console.log("\nShipment auto-resolution via a COUNTRY-level location (not just a direct UN/LOCODE match)");
    const esShipment = await request("POST", "/api/shipments",
      { pol: "ESBCN", pod: "USNYC", carrierCode: "TSTZ", contractType: "SPOT" }, token);
    assert("shipment created", esShipment.status === 201);
    const esParties = await request("GET", `/api/shipments/${esShipment.body.id}/parties`, null, token);
    const esExportParty = esParties.body.find(p => p.role === "Line Agent (Export)");
    assert("Line Agent (Export) resolved via country-level ES coverage even though ESBCN itself was discarded",
      esExportParty?.customerId === esAgentCust.body.id, JSON.stringify(esExportParty));

    console.log("\nCleanup — multi-location scenario");
    await request("DELETE", `/api/shipments/${esShipment.body.id}`, null, token);
    await request("DELETE", `/api/carrier-agents/${headerId}`, null, token);
    await request("DELETE", `/api/customers/${esAgentCust.body.id}`, null, token);

    console.log("\nCustomer-delete guard — blocked while assigned as a carrier agent header");
    const blockedDelete = await request("DELETE", `/api/customers/${agentId}`, null, token);
    assert("delete blocked (400)", blockedDelete.status >= 400);

    console.log("\nCustomer-delete guard — removing the header allows delete to proceed");
    await request("DELETE", `/api/carrier-agents/${created.body.id}`, null, token);
    const allowedDelete = await request("DELETE", `/api/customers/${agentId}`, null, token);
    assert("delete succeeds once unassigned", allowedDelete.status === 200);

    console.log("\n" + "─".repeat(50));
    console.log("Shipment integration (direct UN/LOCODE match, same as before this restructure)");

    console.log("\nRegister fresh export + import agents for a test carrier");
    const exportAgentCust = await request("POST", "/api/customers", { companyName: "Test Export Agent Co" }, token);
    const importAgentCust = await request("POST", "/api/customers", { companyName: "Test Import Agent Co" }, token);
    const exportLink = await request("POST", "/api/carrier-agents",
      { carrierCode: "TSTL", agentCustomerId: exportAgentCust.body.id, locationType: "unlocode", unlocode: "NLRTM" }, token);
    const importLink = await request("POST", "/api/carrier-agents",
      { carrierCode: "TSTL", agentCustomerId: importAgentCust.body.id, locationType: "unlocode", unlocode: "USNYC" }, token);
    assert("export link created", exportLink.status === 201);
    assert("import link created", importLink.status === 201);

    console.log("\nCreating a shipment with that carrier/route auto-assigns both sides");
    const shipment = await request("POST", "/api/shipments",
      { pol: "NLRTM", pod: "USNYC", carrierCode: "TSTL", contractType: "SPOT" }, token);
    assert("shipment created", shipment.status === 201);
    const parties1 = await request("GET", `/api/shipments/${shipment.body.id}/parties`, null, token);
    const exportParty = parties1.body.find(p => p.role === "Line Agent (Export)");
    const importParty = parties1.body.find(p => p.role === "Line Agent (Import)");
    assert("Line Agent (Export) auto-assigned", exportParty?.customerId === exportAgentCust.body.id);
    assert("Line Agent (Import) auto-assigned", importParty?.customerId === importAgentCust.body.id);

    console.log("\nEditing an unrelated field doesn't duplicate or reset the auto-assigned parties");
    await request("PUT", `/api/shipments/${shipment.body.id}`,
      { pol: "NLRTM", pod: "USNYC", carrierCode: "TSTL", contractType: "SPOT", bookingRef: "BK-TEST-1" }, token);
    const parties2 = await request("GET", `/api/shipments/${shipment.body.id}/parties`, null, token);
    assert("still exactly one Export party", parties2.body.filter(p => p.role === "Line Agent (Export)").length === 1);
    assert("still exactly one Import party", parties2.body.filter(p => p.role === "Line Agent (Import)").length === 1);
    assert("Export party unchanged", parties2.body.find(p => p.role === "Line Agent (Export)").customerId === exportAgentCust.body.id);

    console.log("\nChanging carrier to one with no registered agent leaves the existing party untouched (never auto-removed)");
    await request("PUT", `/api/shipments/${shipment.body.id}`,
      { pol: "NLRTM", pod: "USNYC", carrierCode: "TSTX", contractType: "SPOT" }, token);
    const parties3 = await request("GET", `/api/shipments/${shipment.body.id}/parties`, null, token);
    const exportPartyAfter = parties3.body.find(p => p.role === "Line Agent (Export)");
    assert("Export party still present after carrier change", !!exportPartyAfter);
    assert("Export party still points at the original agent (not auto-removed/reset)", exportPartyAfter.customerId === exportAgentCust.body.id);

    console.log("\nA manually-assigned Line Agent on a fresh shipment is never overwritten by a later carrier/route edit");
    const shipment2 = await request("POST", "/api/shipments",
      { pol: "NLRTM", pod: "USNYC", carrierCode: "TSTX", contractType: "SPOT" }, token); // TSTX has no registered agents
    const manualAgentCust = await request("POST", "/api/customers", { companyName: "Test Manually Chosen Agent Co" }, token);
    await request("POST", `/api/shipments/${shipment2.body.id}/parties`,
      { role: "Line Agent (Export)", customerId: manualAgentCust.body.id, customerName: "Test Manually Chosen Agent Co" }, token);
    // Now switch carrier to TSTL, which DOES have a registered NLRTM agent
    await request("PUT", `/api/shipments/${shipment2.body.id}`,
      { pol: "NLRTM", pod: "USNYC", carrierCode: "TSTL", contractType: "SPOT" }, token);
    const parties4 = await request("GET", `/api/shipments/${shipment2.body.id}/parties`, null, token);
    const exportPartyManual = parties4.body.find(p => p.role === "Line Agent (Export)");
    assert("manually-assigned agent preserved, not overwritten by auto-resolution", exportPartyManual?.customerId === manualAgentCust.body.id);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipment.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipment2.body.id}`, null, token);
    await request("DELETE", `/api/carrier-agents/${exportLink.body.id}`, null, token);
    await request("DELETE", `/api/carrier-agents/${importLink.body.id}`, null, token);
    await request("DELETE", `/api/customers/${exportAgentCust.body.id}`, null, token);
    await request("DELETE", `/api/customers/${importAgentCust.body.id}`, null, token);
    await request("DELETE", `/api/customers/${manualAgentCust.body.id}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
