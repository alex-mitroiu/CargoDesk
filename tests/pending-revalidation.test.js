/**
 * Pending contract revalidation — Node smoke test (zero dependencies)
 *
 * Exercises GET /api/contracts/revalidate and the full upgrade flow
 * (Pending → Central) via the live dev server.
 *
 * Usage:
 *   node tests/pending-revalidation.test.js
 *
 * Prerequisites:
 *   - npm run server  (Express on :3001)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

// ─── Minimal HTTP helpers ─────────────────────────────────────────────────────

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: "localhost",
      port: 3001,
      path,
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
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost",
    password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token)
    throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function testRevalidateEndpoint(token) {
  console.log("\nGET /api/contracts/revalidate");

  const known = await request("GET", "/api/contracts/revalidate?ref=CMDU-CH-EUN-NAM", null, token);
  assert("200 for known ref",         known.status === 200);
  assert("returns array",             Array.isArray(known.body));
  assert("at least one result",       known.body.length >= 1);
  assert("correct contractNumber",    known.body[0]?.contractNumber === "CMDU-CH-EUN-NAM");
  assert("status is Active",          known.body[0]?.status === "Active");
  assert("has id field",              !!known.body[0]?.id);

  const none = await request("GET", "/api/contracts/revalidate?ref=NOSUCHCONTRACT", null, token);
  assert("200 for unknown ref",       none.status === 200);
  assert("empty array for no match",  Array.isArray(none.body) && none.body.length === 0);

  const empty = await request("GET", "/api/contracts/revalidate?ref=", null, token);
  assert("empty array for empty ref", Array.isArray(empty.body) && empty.body.length === 0);

  const omit = await request("GET", "/api/contracts/revalidate", null, token);
  assert("empty array when ref omitted", Array.isArray(omit.body) && omit.body.length === 0);

  const lower = await request("GET", "/api/contracts/revalidate?ref=cmdu-ch-eun-nam", null, token);
  assert("case-insensitive match",    lower.body.length >= 1 && lower.body[0].contractNumber === "CMDU-CH-EUN-NAM");

  const allActive = known.body.every(c => c.status === "Active");
  assert("all results are Active",    allActive);
}

async function testUpgradeFlow(token) {
  console.log("\nPending → Central upgrade flow");

  // Create a Pending shipment with a contractRef that matches a known contract
  const create = await request("POST", "/api/shipments", {
    pol: "CNSHA", pod: "USNYC",
    carrierCode: "CMDU",
    status: "Active",
    contractType: "Pending",
    contractRef: "CMDU-CH-EUN-NAM",
    etd: "2026-08-01",
  }, token);
  assert("create Pending shipment (201)", create.status === 201);
  const shipmentId = create.body?.id;
  assert("shipment has id",              !!shipmentId);

  try {
    // Revalidate finds the match
    const rev = await request("GET", `/api/contracts/revalidate?ref=CMDU-CH-EUN-NAM`, null, token);
    assert("revalidate returns match for new shipment's ref", rev.body.length >= 1);
    const contract = rev.body[0];

    // Fetch shipment, then upgrade it
    const get = await request("GET", `/api/shipments/${shipmentId}`, null, token);
    const upgrade = await request("PUT", `/api/shipments/${shipmentId}`, {
      ...get.body,
      contractType: "Central",
      contractId:   contract.id,
      contractRef:  contract.contractNumber,
    }, token);
    assert("upgrade PUT returns 200",            upgrade.status === 200);
    assert("contractType is now Central",        upgrade.body.contractType === "Central");
    assert("contractId is set",                  upgrade.body.contractId   === contract.id);
    assert("contractRef matches contract number", upgrade.body.contractRef  === contract.contractNumber);
  } finally {
    // Clean up regardless of assertion failures
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  console.log("Pending contract revalidation — smoke tests");
  console.log(`Server: ${BASE}\n`);

  try {
    const token = await login();
    console.log("  ✓ Login OK");

    await testRevalidateEndpoint(token);
    await testUpgradeFlow(token);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }

  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
