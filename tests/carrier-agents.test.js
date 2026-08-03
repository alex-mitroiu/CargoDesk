/**
 * Carrier Line Agents — carrier x port -> agent customer, auto-resolving onto shipments as
 * "Line Agent (Export)"/"Line Agent (Import)" additional parties (see resolveCarrierAgent /
 * maybeAssignLineAgents, routes/shipments.js + routes/mdm.js).
 *
 * Usage:
 *   node tests/carrier-agents.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM and USNYC present in port_locations (seeded MDM data)
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

    console.log("\nCarrier Agents CRUD — create");
    const created = await request("POST", "/api/carrier-agents",
      { carrierCode: "TSTL", portUnlocode: "NLRTM", agentCustomerId: agentId, note: "Test note" }, token);
    assert("create returns 201", created.status === 201);
    assert("carrierCode round-trips", created.body.carrierCode === "TSTL");
    assert("portUnlocode round-trips", created.body.portUnlocode === "NLRTM");
    assert("agentCustomerName resolves via live join", created.body.agentCustomerName === "Test Line Agent Co");

    console.log("\nCarrier Agents CRUD — duplicate (carrier,port) rejected");
    const dupe = await request("POST", "/api/carrier-agents",
      { carrierCode: "TSTL", portUnlocode: "NLRTM", agentCustomerId: agentId }, token);
    assert("duplicate rejected", dupe.status >= 400);

    console.log("\nCarrier Agents CRUD — list includes it");
    const list1 = await request("GET", "/api/carrier-agents", null, token);
    assert("list returns 200", list1.status === 200);
    assert("created link present in list", list1.body.some(a => a.id === created.body.id));

    console.log("\nCarrier Agents CRUD — update note only");
    const updated = await request("PUT", `/api/carrier-agents/${created.body.id}`, { note: "Updated note" }, token);
    assert("update returns 200", updated.status === 200);
    assert("note updated", updated.body.note === "Updated note");
    assert("agent unchanged", updated.body.agentCustomerId === agentId);

    console.log("\nCustomer-delete guard — blocked while assigned as a carrier agent");
    const blockedDelete = await request("DELETE", `/api/customers/${agentId}`, null, token);
    assert("delete blocked (400)", blockedDelete.status >= 400);

    console.log("\nCustomer-delete guard — removing the assignment allows delete to proceed");
    await request("DELETE", `/api/carrier-agents/${created.body.id}`, null, token);
    const allowedDelete = await request("DELETE", `/api/customers/${agentId}`, null, token);
    assert("delete succeeds once unassigned", allowedDelete.status === 200);

    console.log("\n" + "─".repeat(50));
    console.log("Shipment integration");

    console.log("\nRegister fresh export + import agents for a test carrier");
    const exportAgentCust = await request("POST", "/api/customers", { companyName: "Test Export Agent Co" }, token);
    const importAgentCust = await request("POST", "/api/customers", { companyName: "Test Import Agent Co" }, token);
    const exportLink = await request("POST", "/api/carrier-agents",
      { carrierCode: "TSTL", portUnlocode: "NLRTM", agentCustomerId: exportAgentCust.body.id }, token);
    const importLink = await request("POST", "/api/carrier-agents",
      { carrierCode: "TSTL", portUnlocode: "USNYC", agentCustomerId: importAgentCust.body.id }, token);
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
