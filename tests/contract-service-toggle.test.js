/**
 * Contract Management Service — the app_settings.contract_source toggle and the monolith-side
 * proxy layer (routes/contracts.js, routes/allocations.js) that switches on it.
 *
 * With 'local' (the default every existing install keeps), every route behaves exactly as it
 * always has. With 'remote', the same routes proxy to the standalone Contract Management Service
 * — this test proves both modes work, that they really are two independent datastores (not a
 * live sync), and that the dedicated admin-only toggle route is actually gated.
 *
 * Requires TWO processes running — this is the one monolith-level test file that does.
 *
 * Usage:
 *   node tests/contract-service-toggle.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Contract Management Service running on :3004 (npm run contract-service)
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

async function login(email, password) {
  const { status, body } = await request("POST", "/api/auth/login", { email, password });
  if (status !== 200 || !body.token) throw new Error(`Login failed for ${email} (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

async function setSource(token, value) {
  return request("PUT", "/api/settings/contract-source", { value }, token);
}

(async () => {
  const contractIds = []; // { id, cleanupSource }
  let scratchUserId = null;
  try {
    const token = await login("claudeagent@localhost", "TestFixture!2026Zq");

    console.log("Baseline");
    const settings0 = await request("GET", "/api/settings", null, token);
    assert("contract_source defaults to 'local'", (settings0.body.contract_source || "local") === "local");

    console.log("\nToggle route is admin-only and validates its value");
    const scratchEmail = `toggle-test-${Date.now()}@localhost`;
    const createUser = await request("POST", "/api/users",
      { email: scratchEmail, name: "Toggle Test Viewer", roles: ["viewer"], password: "TestFixture!2026Zq" }, token);
    assert("scratch viewer created", createUser.status === 200, JSON.stringify(createUser.body));
    const usersList = await request("GET", "/api/users", null, token);
    scratchUserId = usersList.body.find(u => u.email === scratchEmail)?.id;
    assert("scratch viewer findable", !!scratchUserId);
    const viewerToken = await login(scratchEmail, "TestFixture!2026Zq");
    const viewerTry = await setSource(viewerToken, "remote");
    assert("non-admin rejected (403)", viewerTry.status === 403, JSON.stringify(viewerTry.body));
    const badVal = await setSource(token, "somewhere-else");
    assert("invalid value rejected (400)", badVal.status === 400, JSON.stringify(badVal.body));

    console.log("\n'local' mode — full create/publish/match/withdraw cycle, unchanged behavior");
    const numLocal = `TOGGLE-LOCAL-${Date.now()}`;
    const createLocal = await request("POST", "/api/contracts", {
      contractNumber: numLocal, carrierCode: "MAEU", status: "Draft", validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [{ serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" }],
    }, token);
    assert("local create 201", createLocal.status === 201, JSON.stringify(createLocal.body));
    const localId = createLocal.body.id;
    contractIds.push({ id: localId, source: "local" });
    const publishLocal = await request("POST", `/api/contracts/${localId}/publish`, {}, token);
    assert("local publish succeeds", publishLocal.status === 200 && publishLocal.body.status === "Active", JSON.stringify(publishLocal.body));
    const matchLocal = await request("GET", "/api/contracts/match?pol=NLRTM&pod=USNYC", null, token);
    assert("local match finds it", matchLocal.body.some(m => m.id === localId), JSON.stringify(matchLocal.body));
    const withdrawLocal = await request("POST", `/api/contracts/${localId}/withdraw`, {}, token);
    assert("local withdraw succeeds", withdrawLocal.status === 200 && withdrawLocal.body.status === "Draft", JSON.stringify(withdrawLocal.body));

    console.log("\nFlip to 'remote'");
    const flipRemote = await setSource(token, "remote");
    assert("flip to remote succeeds", flipRemote.status === 200 && flipRemote.body.contractSource === "remote", JSON.stringify(flipRemote.body));

    console.log("\n'remote' mode — same cycle proxies correctly to the standalone service");
    const numRemote = `TOGGLE-REMOTE-${Date.now()}`;
    const createRemote = await request("POST", "/api/contracts", {
      contractNumber: numRemote, carrierCode: "HLCU", status: "Draft", validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "CNSHA", pod: "USLAX", polCarrierHaulage: true, polHaulageLocations: "" }],
      rates: [{ serviceCode: "OF", amount: 900, currency: "USD", unit: "per_container" }],
    }, token);
    assert("remote create 201", createRemote.status === 201, JSON.stringify(createRemote.body));
    const remoteId = createRemote.body.id;
    contractIds.push({ id: remoteId, source: "remote" });
    const getRemote = await request("GET", `/api/contracts/${remoteId}`, null, token);
    assert("remote get 200 with legs", getRemote.status === 200 && getRemote.body.legs.length === 1, JSON.stringify(getRemote.body));
    const publishRemote = await request("POST", `/api/contracts/${remoteId}/publish`, {}, token);
    assert("remote publish succeeds", publishRemote.status === 200 && publishRemote.body.status === "Active", JSON.stringify(publishRemote.body));
    // match only ever considers Active contracts (both locally and on the service) — must run
    // after publish, not before, or a still-Draft contract is correctly invisible to it.
    const matchRemote = await request("GET", "/api/contracts/match?pol=CNSHA&pod=USLAX", null, token);
    assert("remote match finds it", matchRemote.body.some(m => m.id === remoteId), JSON.stringify(matchRemote.body));

    console.log("\nallocations/match resolves a remote contract's legs too (haulage-gated matching)");
    const allocNum = `TGL-${Date.now()}`;
    const createAlloc = await request("POST", "/api/allocations", {
      carrierCode: "HLCU", allocatedTEU: 10, effectiveDate: "2031-01-01", endDate: "2031-12-31",
      pol: "CNSHA", pod: "USLAX", contractId: remoteId, contractNumber: numRemote,
    }, token);
    assert("scratch allocation created", createAlloc.status === 201, JSON.stringify(createAlloc.body));
    const allocId = createAlloc.body.id;
    const allocMatch = await request("GET",
      "/api/allocations/match?pol=CNSHA&pod=USLAX&etd=2031-06-01&needsPolHaulage=1", null, token);
    assert("allocation matches once its remote contract's leg is fetched and shows carrier haulage",
      allocMatch.body.some(a => a.id === allocId), JSON.stringify(allocMatch.body));
    await request("DELETE", `/api/allocations/${allocId}`, null, token);

    const withdrawRemote = await request("POST", `/api/contracts/${remoteId}/withdraw`, {}, token);
    assert("remote withdraw succeeds", withdrawRemote.status === 200 && withdrawRemote.body.status === "Draft", JSON.stringify(withdrawRemote.body));

    console.log("\nProves two independent datastores, not a live sync");
    const flipLocal = await setSource(token, "local");
    assert("flip back to local succeeds", flipLocal.status === 200 && flipLocal.body.contractSource === "local", JSON.stringify(flipLocal.body));
    const getRemoteFromLocal = await request("GET", `/api/contracts/${remoteId}`, null, token);
    assert("the remote-created contract is invisible once back on local", getRemoteFromLocal.status === 404, JSON.stringify(getRemoteFromLocal.body));
    const getLocalStillThere = await request("GET", `/api/contracts/${localId}`, null, token);
    assert("the original local contract was never touched", getLocalStillThere.status === 200 && getLocalStillThere.body.contractNumber === numLocal);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq").catch(() => null);
    if (adminToken) {
      for (const c of contractIds) {
        await setSource(adminToken, c.source).catch(() => {});
        await request("DELETE", `/api/contracts/${c.id}`, null, adminToken).catch(() => {});
      }
      await setSource(adminToken, "local").catch(() => {}); // always leave the toggle back at the safe default
      if (scratchUserId) await request("DELETE", `/api/users/${scratchUserId}`, null, adminToken).catch(() => {});
    }
  }
})();
