/**
 * MDM Service — the app_settings.mdm_source toggle and the monolith-side proxy layer
 * (routes/mdm.js, plus the shared portLanesMap/portCountryMap caches and resolveCarrierAgent)
 * that switches on it.
 *
 * With 'local' (the default every existing install keeps), every route behaves exactly as it
 * always has. With 'remote', the same routes proxy to the standalone MDM Service — this test
 * proves both modes work, that they really are two independent datastores (not a live sync),
 * and that the dedicated admin-only toggle route is actually gated.
 *
 * Requires TWO processes running — this is the monolith-level test file that does.
 *
 * Usage:
 *   node tests/mdm-service-toggle.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - MDM Service running on :3005 (npm run mdm-service)
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
  return request("PUT", "/api/settings/mdm-source", { value }, token);
}

(async () => {
  const stamp = Date.now();
  const localCarrier = `TL${stamp % 10000}`;
  const remoteCarrier = `TR${stamp % 10000}`;
  let scratchUserId = null;
  try {
    const token = await login("claudeagent@localhost", "TestFixture!2026Zq");

    console.log("Baseline");
    const settings0 = await request("GET", "/api/settings", null, token);
    assert("mdm_source defaults to 'local'", (settings0.body.mdm_source || "local") === "local");

    console.log("\nToggle route is admin-only and validates its value");
    const scratchEmail = `mdm-toggle-test-${stamp}@localhost`;
    const createUser = await request("POST", "/api/users",
      { email: scratchEmail, name: "MDM Toggle Test Viewer", roles: ["viewer"], password: "TestFixture!2026Zq" }, token);
    assert("scratch viewer created", createUser.status === 200, JSON.stringify(createUser.body));
    const usersList = await request("GET", "/api/users", null, token);
    scratchUserId = usersList.body.find(u => u.email === scratchEmail)?.id;
    assert("scratch viewer findable", !!scratchUserId);
    const viewerToken = await login(scratchEmail, "TestFixture!2026Zq");
    const viewerTry = await setSource(viewerToken, "remote");
    assert("non-admin rejected (403)", viewerTry.status === 403, JSON.stringify(viewerTry.body));
    const badVal = await setSource(token, "somewhere-else");
    assert("invalid value rejected (400)", badVal.status === 400, JSON.stringify(badVal.body));

    console.log("\n'local' mode — full carrier CRUD, unchanged behavior");
    const createLocal = await request("POST", "/api/carriers", { code: localCarrier, name: "Toggle Test Local Carrier" }, token);
    assert("local carrier create 201", createLocal.status === 201, JSON.stringify(createLocal.body));
    const getLocal = await request("GET", `/api/carriers/${localCarrier}`, null, token);
    assert("local carrier get 200", getLocal.status === 200 && getLocal.body.name === "Toggle Test Local Carrier");

    console.log("\nFlip to 'remote'");
    const flipRemote = await setSource(token, "remote");
    assert("flip to remote succeeds", flipRemote.status === 200 && flipRemote.body.mdmSource === "remote", JSON.stringify(flipRemote.body));

    console.log("\n'remote' mode — carrier CRUD proxies correctly to the standalone service");
    const createRemote = await request("POST", "/api/carriers", { code: remoteCarrier, name: "Toggle Test Remote Carrier" }, token);
    assert("remote carrier create 201", createRemote.status === 201, JSON.stringify(createRemote.body));
    const getRemote = await request("GET", `/api/carriers/${remoteCarrier}`, null, token);
    assert("remote carrier get 200", getRemote.status === 200 && getRemote.body.name === "Toggle Test Remote Carrier");
    const getLocalFromRemote = await request("GET", `/api/carriers/${localCarrier}`, null, token);
    assert("the local-only carrier is invisible while on remote", getLocalFromRemote.status === 404, JSON.stringify(getLocalFromRemote.body));

    console.log("\nrebuildPortLanesMap picks up remote MDM data (transit-suggestion resolves through it)");
    const port1 = `TG${stamp % 100000}`.slice(0, 5).toUpperCase().padEnd(5, "A");
    const port2 = `TH${stamp % 100000}`.slice(0, 5).toUpperCase().padEnd(5, "A");
    const iso2 = "TG";
    const laneCode = `TGL${stamp % 1000}`;
    await request("POST", "/api/port-locations", { unlocode: port1, name: "Toggle Port One", countryCode: iso2 }, token);
    await request("POST", "/api/port-locations", { unlocode: port2, name: "Toggle Port Two", countryCode: iso2 }, token);
    await request("POST", "/api/regions", { code: "TGR", name: "Toggle Region" }, token);
    await request("POST", "/api/countries", { iso2, name: "Toggleland", regionCode: "TGR" }, token);
    await request("POST", "/api/trade-lanes", { code: laneCode, name: "Toggle Lane", transitDays: 9 }, token);
    const ctlCreate = await request("POST", "/api/country-trade-lanes", { iso2, laneCode }, token);
    assert("country-trade-lane assignment created in remote mode", ctlCreate.status === 201, JSON.stringify(ctlCreate.body));
    const transit = await request("GET", `/api/trade-lanes/transit-suggestion?pol=${port1}&pod=${port2}`, null, token);
    assert("transit-suggestion resolves through the remote-backed portLanesMap cache", transit.body.days === 9, JSON.stringify(transit.body));

    console.log("\nCarrier agent resolve — direct + linked-port fallback, name attached locally");
    const link = await request("POST", "/api/linked-ports", { primaryUnlocode: port1, linkedUnlocode: port2 }, token);
    assert("linked-ports create 201 in remote mode", link.status === 201, JSON.stringify(link.body));
    const agentCreate = await request("POST", "/api/carrier-agents", { carrierCode: remoteCarrier, agentCustomerId: "CUST-TOGGLE-FAKE", locationType: "unlocode", unlocode: port1 }, token);
    assert("carrier agent create 201 in remote mode", agentCreate.status === 201, JSON.stringify(agentCreate.body));
    const agentsList = await request("GET", "/api/carrier-agents", null, token);
    const found = (agentsList.body.results || agentsList.body).find(a => a.carrierCode === remoteCarrier);
    assert("carrier agent list attaches agentCustomerName field locally (even if blank for a fake id)", found && "agentCustomerName" in found, JSON.stringify(found));

    console.log("\nmdm_source=remote AND customer_source=remote together — the one place two extracted services interact");
    const flipCustRemote = await request("PUT", "/api/settings/customer-source", { value: "remote" }, token);
    assert("customer_source also flips to remote", flipCustRemote.status === 200 && flipCustRemote.body.customerSource === "remote", JSON.stringify(flipCustRemote.body));
    const remoteCust = await request("POST", "/api/customers", { companyName: `Toggle MDM+Customer Agent Co ${stamp}` }, token);
    assert("real remote customer created", remoteCust.status === 201, JSON.stringify(remoteCust.body));
    const agentCreate2 = await request("POST", "/api/carrier-agents", { carrierCode: remoteCarrier, agentCustomerId: remoteCust.body.id, locationType: "unlocode", unlocode: port2 }, token);
    assert("carrier agent create 201 with a real remote customer id", agentCreate2.status === 201, JSON.stringify(agentCreate2.body));
    assert("attachAgentNames resolves the name through the remote Customer Service (create response)",
      agentCreate2.body.agentCustomerName === remoteCust.body.companyName, JSON.stringify(agentCreate2.body));
    const agentsList2 = await request("GET", "/api/carrier-agents", null, token);
    const found2 = (agentsList2.body.results || agentsList2.body).find(a => a.id === agentCreate2.body.id);
    assert("attachAgentNames resolves the name through the remote Customer Service (list response, batched)",
      found2?.agentCustomerName === remoteCust.body.companyName, JSON.stringify(found2));
    await request("DELETE", `/api/carrier-agents/${agentCreate2.body.id}`, null, token).catch(() => {});
    await request("DELETE", `/api/customers/${remoteCust.body.id}`, null, token).catch(() => {});
    const flipCustLocal = await request("PUT", "/api/settings/customer-source", { value: "local" }, token);
    assert("customer_source flips back to local", flipCustLocal.status === 200 && flipCustLocal.body.customerSource === "local", JSON.stringify(flipCustLocal.body));

    console.log("\nProves two independent datastores, not a live sync");
    await request("DELETE", `/api/carrier-agents/${agentCreate.body.id}`, null, token).catch(() => {});
    await request("DELETE", `/api/linked-ports/${link.body.id}`, null, token).catch(() => {});
    await request("DELETE", `/api/country-trade-lanes/${iso2}/${laneCode}`, null, token).catch(() => {});
    await request("DELETE", `/api/trade-lanes/${laneCode}`, null, token).catch(() => {});
    await request("DELETE", `/api/countries/${iso2}`, null, token).catch(() => {});
    await request("DELETE", "/api/regions/TGR", null, token).catch(() => {});
    await request("DELETE", `/api/port-locations/${port1}`, null, token).catch(() => {});
    await request("DELETE", `/api/port-locations/${port2}`, null, token).catch(() => {});
    await request("DELETE", `/api/carriers/${remoteCarrier}`, null, token).catch(() => {});

    const flipLocal = await setSource(token, "local");
    assert("flip back to local succeeds", flipLocal.status === 200 && flipLocal.body.mdmSource === "local", JSON.stringify(flipLocal.body));
    const getRemoteFromLocal = await request("GET", `/api/carriers/${remoteCarrier}`, null, token);
    assert("the remote-created carrier is invisible once back on local", getRemoteFromLocal.status === 404, JSON.stringify(getRemoteFromLocal.body));
    const getLocalStillThere = await request("GET", `/api/carriers/${localCarrier}`, null, token);
    assert("the original local carrier was never touched", getLocalStillThere.status === 200 && getLocalStillThere.body.name === "Toggle Test Local Carrier");

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq").catch(() => null);
    if (adminToken) {
      await request("DELETE", `/api/carriers/${localCarrier}`, null, adminToken).catch(() => {});
      await setSource(adminToken, "local").catch(() => {}); // always leave the toggle back at the safe default
      if (scratchUserId) await request("DELETE", `/api/users/${scratchUserId}`, null, adminToken).catch(() => {});
    }
  }
})();
