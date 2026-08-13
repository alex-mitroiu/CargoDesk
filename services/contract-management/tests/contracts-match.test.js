/**
 * Contract Management Service — multi-routing matching (the HLCU/Kuehne+Nagel worked example)
 * and the linked-port-expansion contract this service deliberately doesn't own.
 *
 * Hits the service directly on its own port, no monolith involved.
 *
 * Usage:
 *   node services/contract-management/tests/contracts-match.test.js
 *
 * Prerequisites:
 *   - Contract Management Service running on :3004 (npm run contract-service)
 */

import http from "node:http";

const PORT = 3004;
const SECRET = process.env.CONTRACT_SERVICE_SECRET || "cargoDesk-dev-contract-service-secret-do-not-use-in-prod";
let passed = 0;
let failed = 0;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = { method, hostname: "localhost", port: PORT, path,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}`, ...(payload && { "Content-Length": Buffer.byteLength(payload) }) } };
    const req = http.request(opts, res => {
      let data = ""; res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
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
  const cleanupIds = [];
  try {
    console.log("HLCU/Kuehne+Nagel worked example — CNCKG->SEGOT via 3 different transshipment hubs");
    const num = `SVC-MATCH-${Date.now()}`;
    const create = await request("POST", "/internal/contracts", {
      contractNumber: num, carrierCode: "HLCU", namedAccount: "Kuehne+Nagel", status: "Active",
      validFrom: "2026-01-01", validTo: "2027-01-01",
      routings: [
        { name: "Via Shanghai/Rotterdam", transitDays: 38 },
        { name: "Via Shanghai/Hamburg", transitDays: 36 },
        { name: "Via Shanghai/Wilhelmshaven", transitDays: 34 },
      ],
      legs: [
        { pol: "CNCKG", pod: "CNSHA", routingIndex: 0 }, { pol: "CNSHA", pod: "NLRTM", routingIndex: 0 }, { pol: "NLRTM", pod: "SEGOT", routingIndex: 0 },
        { pol: "CNCKG", pod: "CNSHA", routingIndex: 1 }, { pol: "CNSHA", pod: "DEHAM", routingIndex: 1 }, { pol: "DEHAM", pod: "SEGOT", routingIndex: 1 },
        { pol: "CNCKG", pod: "CNSHA", routingIndex: 2 }, { pol: "CNSHA", pod: "DEWVN", routingIndex: 2 }, { pol: "DEWVN", pod: "SEGOT", routingIndex: 2 },
      ],
      rates: [
        { serviceCode: "OF", amount: 2450, currency: "USD", unit: "per_container", routingIndex: 0 },
        { serviceCode: "OF", amount: 2600, currency: "USD", unit: "per_container", routingIndex: 1 },
        { serviceCode: "OF", amount: 2300, currency: "USD", unit: "per_container", routingIndex: 2 },
        { serviceCode: "DOC", amount: 45, currency: "USD", unit: "per_bl" },
      ],
    });
    assert("contract created", create.status === 201, JSON.stringify(create.body));
    const contractId = create.body.id;
    cleanupIds.push(contractId);

    const match = await request("GET", "/internal/contracts/match?pol=CNCKG&pod=SEGOT");
    const mine = match.body.filter(m => m.id === contractId);
    assert("3 match results, one per routing", mine.length === 3, JSON.stringify(mine.map(m => m.routing?.name)));
    const byName = Object.fromEntries(mine.map(m => [m.routing?.name, m]));
    for (const [name, expected] of [["Via Shanghai/Rotterdam", 2495], ["Via Shanghai/Hamburg", 2645], ["Via Shanghai/Wilhelmshaven", 2345]]) {
      const total = (byName[name]?.rates || []).reduce((s, r) => s + r.amountUsd, 0);
      assert(`${name} priced correctly (own OFR + shared DOC, not the others')`, Math.round(total) === expected, `got ${total}`);
    }

    console.log("\nLinked-port expansion — caller-supplied linkedPorts pairs (this service owns no linked_ports data of its own)");
    const num2 = `SVC-LINKED-${Date.now()}`;
    const linkedCreate = await request("POST", "/internal/contracts", {
      contractNumber: num2, carrierCode: "MAEU", status: "Active",
      validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC", polLinkedAllowed: true }],
      rates: [{ serviceCode: "OF", amount: 700, currency: "USD" }],
    });
    cleanupIds.push(linkedCreate.body.id);
    const noLinkMatch = await request("GET", "/internal/contracts/match?pol=NLAMS&pod=USNYC");
    assert("no match for an unrelated port with no linked-port hint supplied", !noLinkMatch.body.some(m => m.id === linkedCreate.body.id));
    // The lookup is keyed by the LEG's own pol (NLRTM), not the query's (NLAMS) — matches
    // routes/contracts.js's own linkedPortCodes(leg.pol) call site exactly.
    const linkedPorts = encodeURIComponent(JSON.stringify([["NLRTM", "NLAMS"]]));
    const linkedMatch = await request("GET", `/internal/contracts/match?pol=NLAMS&pod=USNYC&linkedPorts=${linkedPorts}`);
    assert("match succeeds once the caller supplies the resolved linked-port pair", linkedMatch.body.some(m => m.id === linkedCreate.body.id));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    for (const id of cleanupIds) { try { await request("DELETE", `/internal/contracts/${id}`); } catch {} }
  }
})();
