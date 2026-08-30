/**
 * Line Agent Auto-Resolve / Ambiguity Picker — resolveCarrierAgentCandidates (server.js) can now
 * return more than one candidate when a shipment's POL/POD has no direct or country-level Line
 * Agent registered, but resolves via the linked-ports fallback to two or more ports that each have
 * their own independent, valid agent for the same carrier. maybeAssignLineAgents (routes/shipments.js,
 * routes/quotes.js) now only auto-assigns when exactly one candidate exists — an ambiguous side is
 * left unassigned instead of guessing, surfaced read-only via
 * GET /api/shipments/:id/line-agent-candidates for a picker UI to resolve via the existing
 * POST /api/shipments/:id/parties route.
 *
 * Usage:
 *   node tests/line-agent-candidates.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - ESVLC, NLRTM, USNYC present in port_locations (seeded MDM data)
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
  const carrierCode = "TSTA";
  let token, agent1Id, agent2Id, header1Id, header2Id, link1Id, link2Id, shipmentId, ambiguousShipmentId;
  try {
    console.log("Logging in…");
    token = await login();
    console.log("  ✓ Logged in");

    console.log("\nControl case: unambiguous resolution still auto-assigns (unchanged behavior)");
    const soloAgent = await request("POST", "/api/customers", { companyName: "LAC Solo Agent Co" }, token);
    const soloHeader = await request("POST", "/api/carrier-agents",
      { carrierCode, agentCustomerId: soloAgent.body.id, locationType: "unlocode", unlocode: "NLRTM" }, token);
    assert("solo header created", soloHeader.status === 201, JSON.stringify(soloHeader.body));
    const soloShip = await request("POST", "/api/shipments",
      { pol: "NLRTM", pod: "USNYC", carrierCode, status: "Active", contractType: "SPOT" }, token);
    shipmentId = soloShip.body.id;
    assert("scratch shipment created", soloShip.status === 201);
    const soloParties = await request("GET", `/api/shipments/${shipmentId}/parties`, null, token);
    const soloExport = soloParties.body.find(p => p.role === "Line Agent (Export)");
    assert("single candidate still auto-assigns Line Agent (Export)", soloExport?.customerId === soloAgent.body.id, JSON.stringify(soloParties.body));
    const soloCandidates = await request("GET", `/api/shipments/${shipmentId}/line-agent-candidates`, null, token);
    assert("no pending candidates once auto-assigned", !soloCandidates.body.export, JSON.stringify(soloCandidates.body));
    await request("DELETE", `/api/carrier-agents/${soloHeader.body.id}`, null, token);

    console.log("\nBuilding the ambiguous fixture: ESVLC links to two ports, each with its own agent for the same carrier");
    const agent1 = await request("POST", "/api/customers", { companyName: "LAC Candidate Agent A" }, token);
    const agent2 = await request("POST", "/api/customers", { companyName: "LAC Candidate Agent B" }, token);
    agent1Id = agent1.body.id; agent2Id = agent2.body.id;

    const header1 = await request("POST", "/api/carrier-agents",
      { carrierCode, agentCustomerId: agent1Id, locationType: "unlocode", unlocode: "NLRTM" }, token);
    const header2 = await request("POST", "/api/carrier-agents",
      { carrierCode, agentCustomerId: agent2Id, locationType: "unlocode", unlocode: "USNYC" }, token);
    header1Id = header1.body.id; header2Id = header2.body.id;
    assert("header 1 (NLRTM) created", header1.status === 201, JSON.stringify(header1.body));
    assert("header 2 (USNYC) created", header2.status === 201, JSON.stringify(header2.body));

    const link1 = await request("POST", "/api/linked-ports", { primaryUnlocode: "ESVLC", linkedUnlocode: "NLRTM" }, token);
    const link2 = await request("POST", "/api/linked-ports", { primaryUnlocode: "ESVLC", linkedUnlocode: "USNYC" }, token);
    link1Id = link1.body.id; link2Id = link2.body.id;
    assert("ESVLC<->NLRTM link created", link1.status === 201, JSON.stringify(link1.body));
    assert("ESVLC<->USNYC link created", link2.status === 201, JSON.stringify(link2.body));

    console.log("\nCreating a shipment on the ambiguous route (POL=ESVLC, no direct/country agent for TSTA; POD=SGSIN, unrelated and agent-free, to isolate the ambiguity to the export side only)");
    const ambShip = await request("POST", "/api/shipments",
      { pol: "ESVLC", pod: "SGSIN", carrierCode, status: "Active", contractType: "SPOT" }, token);
    ambiguousShipmentId = ambShip.body.id;
    assert("ambiguous scratch shipment created", ambShip.status === 201, JSON.stringify(ambShip.body));

    const ambParties = await request("GET", `/api/shipments/${ambiguousShipmentId}/parties`, null, token);
    assert("Line Agent (Export) left unassigned when ambiguous", !ambParties.body.find(p => p.role === "Line Agent (Export)"), JSON.stringify(ambParties.body));

    console.log("\nGET line-agent-candidates reports both real candidates with correct matchedVia");
    const candidates = await request("GET", `/api/shipments/${ambiguousShipmentId}/line-agent-candidates`, null, token);
    assert("candidates endpoint returns 200", candidates.status === 200);
    assert("export side reports exactly 2 candidates", candidates.body.export?.length === 2, JSON.stringify(candidates.body));
    const viaCodes = (candidates.body.export || []).map(c => c.matchedVia).sort();
    assert("matchedVia names both real linked ports", JSON.stringify(viaCodes) === JSON.stringify(["NLRTM", "USNYC"]), JSON.stringify(viaCodes));
    const names = (candidates.body.export || []).map(c => c.agentCustomerName).sort();
    assert("both real candidate names present", JSON.stringify(names) === JSON.stringify(["LAC Candidate Agent A", "LAC Candidate Agent B"].sort()), JSON.stringify(names));
    assert("import side (unrelated pod, no agents at all) reports nothing pending", !candidates.body.import, JSON.stringify(candidates.body));

    console.log("\nResolving one candidate via the existing add-party route clears it from a follow-up check");
    const pick = candidates.body.export.find(c => c.matchedVia === "NLRTM");
    const resolve = await request("POST", `/api/shipments/${ambiguousShipmentId}/parties`,
      { role: "Line Agent (Export)", customerId: pick.agentCustomerId, customerName: pick.agentCustomerName }, token);
    assert("resolving the pick succeeds", resolve.status === 201, JSON.stringify(resolve.body));
    const afterResolve = await request("GET", `/api/shipments/${ambiguousShipmentId}/line-agent-candidates`, null, token);
    assert("no longer reported as pending after resolution", !afterResolve.body.export, JSON.stringify(afterResolve.body));
    const finalParties = await request("GET", `/api/shipments/${ambiguousShipmentId}/parties`, null, token);
    assert("the picked agent is now the real Line Agent (Export)", finalParties.body.find(p => p.role === "Line Agent (Export)")?.customerId === pick.agentCustomerId);

  } catch (e) {
    console.error("Test run failed:", e);
    failed++;
  } finally {
    if (token) {
      if (shipmentId) await request("DELETE", `/api/shipments/${shipmentId}`, null, token).catch(() => {});
      if (ambiguousShipmentId) await request("DELETE", `/api/shipments/${ambiguousShipmentId}`, null, token).catch(() => {});
      if (link1Id) await request("DELETE", `/api/linked-ports/${link1Id}`, null, token).catch(() => {});
      if (link2Id) await request("DELETE", `/api/linked-ports/${link2Id}`, null, token).catch(() => {});
      if (header1Id) await request("DELETE", `/api/carrier-agents/${header1Id}`, null, token).catch(() => {});
      if (header2Id) await request("DELETE", `/api/carrier-agents/${header2Id}`, null, token).catch(() => {});
      if (agent1Id) await request("DELETE", `/api/customers/${agent1Id}`, null, token).catch(() => {});
      if (agent2Id) await request("DELETE", `/api/customers/${agent2Id}`, null, token).catch(() => {});
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
