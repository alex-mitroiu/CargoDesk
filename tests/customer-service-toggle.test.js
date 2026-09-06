/**
 * Customer Service — the app_settings.customer_source toggle and the monolith-side proxy layer
 * (routes/customers.js) that switches on it.
 *
 * This file grows across the implementation's own staged rollout (see the plan file) — this
 * first pass covers what Stage 2 ships: toggle admin-gating/validation, full local/remote CRUD
 * for customers/identifiers/contacts, and the independent-datastore proof. Later stages
 * (credit-hold/over-limit, resolveCustomerGroup, the screening write/match split, the
 * attachAgentNames ripple) add their own sections here as they land.
 *
 * Requires TWO processes running — this is the monolith-level test file that does.
 *
 * Usage:
 *   node tests/customer-service-toggle.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Customer Service running on :3008 (npm run customer-service)
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
  return request("PUT", "/api/settings/customer-source", { value }, token);
}

(async () => {
  const stamp = Date.now();
  let scratchUserId = null, localCustId = null, remoteCustId = null, remoteIdentifierId = null, remoteContactId = null;
  let custHoldId = null, shipHoldId = null;
  let parentCustId = null, childCustId = null, rollupShipId = null;
  let crossRefCustId = null, crossRefShipId = null;
  let docCustId = null, docId = null;
  try {
    const token = await login("claudeagent@localhost", "TestFixture!2026Zq");

    console.log("Baseline");
    const settings0 = await request("GET", "/api/settings", null, token);
    assert("customer_source defaults to 'local'", (settings0.body.customer_source || "local") === "local");

    console.log("\nToggle route is admin-only and validates its value");
    const scratchEmail = `customer-toggle-test-${stamp}@test.local`;
    const createUser = await request("POST", "/api/users",
      { email: scratchEmail, name: "Customer Toggle Test Viewer", roles: ["viewer"], password: "TestFixture!2026Zq" }, token);
    assert("scratch viewer created", createUser.status === 200, JSON.stringify(createUser.body));
    const usersList = await request("GET", "/api/users", null, token);
    scratchUserId = usersList.body.find(u => u.email === scratchEmail)?.id;
    const viewerToken = await login(scratchEmail, "TestFixture!2026Zq");
    const viewerTry = await setSource(viewerToken, "remote");
    assert("non-admin rejected (403)", viewerTry.status === 403, JSON.stringify(viewerTry.body));
    const badVal = await setSource(token, "somewhere-else");
    assert("invalid value rejected (400)", badVal.status === 400, JSON.stringify(badVal.body));

    console.log("\n'local' mode — full customer/identifier/contact CRUD, unchanged behavior");
    const createLocal = await request("POST", "/api/customers", { companyName: `Toggle Test Local Co ${stamp}`, countryIso2: "fr" }, token);
    assert("local customer create 201", createLocal.status === 201, JSON.stringify(createLocal.body));
    assert("currency defaulted from country (FR -> EUR)", createLocal.body.currency === "EUR");
    localCustId = createLocal.body.id;
    const getLocal = await request("GET", `/api/customers/${localCustId}`, null, token);
    assert("local customer get 200", getLocal.status === 200 && getLocal.body.companyName === `Toggle Test Local Co ${stamp}`);

    console.log("\nFlip to 'remote'");
    const flipRemote = await setSource(token, "remote");
    assert("flip to remote succeeds", flipRemote.status === 200 && flipRemote.body.customerSource === "remote", JSON.stringify(flipRemote.body));

    console.log("\n'remote' mode — customer CRUD proxies correctly to the standalone service");
    const createRemote = await request("POST", "/api/customers", { companyName: `Toggle Test Remote Co ${stamp}`, countryIso2: "jp" }, token);
    assert("remote customer create 201", createRemote.status === 201, JSON.stringify(createRemote.body));
    assert("currency defaulted from country (JP -> JPY), proving validation runs in the service too", createRemote.body.currency === "JPY");
    remoteCustId = createRemote.body.id;
    const getLocalFromRemote = await request("GET", `/api/customers/${localCustId}`, null, token);
    assert("the local-only customer is invisible while on remote", getLocalFromRemote.status === 404, JSON.stringify(getLocalFromRemote.body));

    const updateRemote = await request("PUT", `/api/customers/${remoteCustId}`, { companyName: "Renamed Remote Co", currency: "JPY" }, token);
    assert("remote customer update applies", updateRemote.body.companyName === "Renamed Remote Co");

    const listRemote = await request("GET", "/api/customers", null, token);
    assert("remote list includes the remote customer, not the local one",
      listRemote.body.results.some(c => c.id === remoteCustId) && !listRemote.body.results.some(c => c.id === localCustId),
      JSON.stringify(listRemote.body.results.map(c => c.id)));

    console.log("\n'remote' mode — identifiers and contacts CRUD proxy correctly");
    const idCreate = await request("POST", `/api/customers/${remoteCustId}/identifiers`, { idType: "VAT", idCode: "JP987654321" }, token);
    assert("remote identifier create 201", idCreate.status === 201, JSON.stringify(idCreate.body));
    remoteIdentifierId = idCreate.body.id;
    const idList = await request("GET", `/api/customers/${remoteCustId}/identifiers`, null, token);
    assert("remote identifier list includes the new one", idList.body.some(i => i.id === remoteIdentifierId));

    const ctCreate = await request("POST", `/api/customers/${remoteCustId}/contacts`, { name: "Remote Contact", department: "Sales" }, token);
    assert("remote contact create 201", ctCreate.status === 201, JSON.stringify(ctCreate.body));
    remoteContactId = ctCreate.body.id;
    const ctList = await request("GET", `/api/customers/${remoteCustId}/contacts`, null, token);
    assert("remote contact list includes the new one", ctList.body.some(c => c.id === remoteContactId));

    console.log("\n'remote' mode — credit-hold soft warning (shipment create) and hard block (booking-request)");
    const custHold = await request("POST", "/api/customers", { companyName: `Toggle Hold Test Co ${stamp}`, creditHold: true, creditHoldReason: "test hold" }, token);
    assert("held customer created in remote mode", custHold.status === 201 && custHold.body.creditHold === true, JSON.stringify(custHold.body));
    custHoldId = custHold.body.id;

    const shipHold = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      shipperId: custHoldId, shipperName: custHold.body.companyName,
    }, token);
    assert("shipment create succeeds despite the hold (soft, informational only)", shipHold.status === 201, JSON.stringify(shipHold.body));
    assert("creditWarning.onHold surfaces the held customer (getCustomerRow remote branch, shipments.js)",
      shipHold.body?.creditWarning?.onHold?.some(h => h.customerId === custHoldId), JSON.stringify(shipHold.body?.creditWarning));
    shipHoldId = shipHold.body.id;

    const bookingAttempt = await request("POST", `/api/shipments/${shipHoldId}/edi-messages/booking-request`, {}, token);
    assert("booking-request hard-blocked for a held customer (getCustomerRow remote branch, edi.js)", bookingAttempt.status === 409, JSON.stringify(bookingAttempt.body));

    const queue = await request("GET", "/api/credit-overrides/queue", null, token);
    assert("credit-overrides queue (remote creditHold=1 bulk filter) includes the held shipment",
      queue.body.some(r => r.shipmentId === shipHoldId && r.customerId === custHoldId && r.blockType === "hold"), JSON.stringify(queue.body));

    const releaseAsAdmin = await request("POST", `/api/customers/${custHoldId}/credit-hold/release`, { shipmentId: shipHoldId, reason: "test" }, token);
    assert("admin (not the shipment's own lane trade_manager) is rejected releasing a hold, even in remote mode", releaseAsAdmin.status === 403, JSON.stringify(releaseAsAdmin.body));

    console.log("\n'remote' mode — margin rollup (groupByParent) resolves through the remote service");
    const parentCust = await request("POST", "/api/customers", { companyName: `Toggle Parent Co ${stamp}` }, token);
    assert("parent customer created in remote mode", parentCust.status === 201, JSON.stringify(parentCust.body));
    parentCustId = parentCust.body.id;
    const childCust = await request("POST", "/api/customers", { companyName: `Toggle Child Co ${stamp}`, parentCustomerId: parentCustId }, token);
    assert("child customer created with parentCustomerId set", childCust.status === 201 && childCust.body.parentCustomerId === parentCustId, JSON.stringify(childCust.body));
    childCustId = childCust.body.id;

    const rollupShip = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: childCustId, principalName: childCust.body.companyName,
    }, token);
    assert("rollup shipment create succeeds", rollupShip.status === 201, JSON.stringify(rollupShip.body));
    rollupShipId = rollupShip.body.id;
    const costLine = await request("POST", `/api/shipments/${rollupShipId}/cost-lines`, { type: "SELL", chargeCode: "OFR", amount: 750 }, token);
    assert("SELL cost line created", costLine.status === 201, JSON.stringify(costLine.body));

    const margin = await request("GET", "/api/margin/summary?groupByParent=true", null, token);
    assert("margin summary (groupByParent, remote) returns 200", margin.status === 200, JSON.stringify(margin.body));
    const rolledRow = margin.body.byCustomer?.find(r => r.customerId === parentCustId);
    assert("child's shipment rolls up under the PARENT's id (resolveCustomerGroup remote branch)", !!rolledRow, JSON.stringify(margin.body.byCustomer));
    assert("rolled row's total is the child's own sell amount", rolledRow?.totalSellUsd === 750, JSON.stringify(rolledRow));

    console.log("\n'remote' mode — screening write/match split (screenCustomer's write branch + the customer_screenings cross-reference read)");
    const status0 = await request("GET", "/api/sanctions/status", null, token);
    const hasSanctionsData = status0.status === 200 && (status0.body.indexed || 0) > 0;
    if (!hasSanctionsData) {
      console.log("  ⚠ sanctionsMap is empty (no OFAC/CSL sync has run) — skipping this section, not a bug in the feature under test.");
    } else {
      const SANCTIONED_NAME = "Islamic Republic of Iran Shipping Lines"; // real, already-synced fixture (same as customer-compliance-screening.test.js)
      const crossRefCust = await request("POST", "/api/customers", { companyName: `Toggle Screening Test Co ${stamp}` }, token);
      assert("clean-name customer created in remote mode", crossRefCust.status === 201, JSON.stringify(crossRefCust.body));
      crossRefCustId = crossRefCust.body.id;

      const crossRefShip = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
        principalId: crossRefCustId, principalName: crossRefCust.body.companyName,
      }, token);
      assert("cross-ref shipment starts CLEAR", crossRefShip.status === 201 && crossRefShip.body?.screening?.result !== 'HIT', JSON.stringify(crossRefShip.body?.screening));
      crossRefShipId = crossRefShip.body.id;

      // Renaming the customer to a sanctioned name never touches the shipment's own already-stored
      // principalName — the ONLY way the shipment can flip to HIT is via the customer_id
      // cross-reference (getCustomerScreeningResult's remote branch), not a direct name match.
      const rename = await request("PUT", `/api/customers/${crossRefCustId}`, { companyName: SANCTIONED_NAME }, token);
      assert("customer rename to a sanctioned name returns 200", rename.status === 200, JSON.stringify(rename.body));
      assert("customer-level screening flips to HIT (screenCustomer's remote write branch)", rename.body.screeningResult === 'HIT', JSON.stringify(rename.body));

      const rescreened = await request("GET", `/api/shipments/${crossRefShipId}/screening`, null, token);
      assert("shipment-level screening propagated to HIT purely from the customer-level rename (getCustomerScreeningResult remote branch)",
        rescreened.body?.result === 'HIT', JSON.stringify(rescreened.body));

      const override = await request("POST", `/api/customers/${crossRefCustId}/screening/override`, { reason: "confirmed false positive" }, token);
      assert("screening override succeeds in remote mode", override.status === 200 && override.body.result === 'CLEAR', JSON.stringify(override.body));
      assert("override reason round-trips", override.body.overrideReason === "confirmed false positive", JSON.stringify(override.body));
    }

    console.log("\n'remote' mode — customer_documents stays local-only, but its existence check is remote-aware (Stage 8)");
    const docCust = await request("POST", "/api/customers", { companyName: `Toggle Document Test Co ${stamp}` }, token);
    assert("customer created in remote mode for the document test", docCust.status === 201, JSON.stringify(docCust.body));
    docCustId = docCust.body.id;
    const upload = await request("POST", `/api/customers/${docCustId}/documents`, {
      filename: "toggle-test.txt", mimeType: "text/plain", data: Buffer.from("toggle test content").toString("base64"),
    }, token);
    assert("a customer created AFTER a remote cutover can still have a document uploaded (getCustomerRow-based existence check)",
      upload.status === 201, JSON.stringify(upload.body));
    docId = upload.body.id;
    const docsList = await request("GET", `/api/customers/${docCustId}/documents`, null, token);
    assert("uploaded document is listed", docsList.body.some(d => d.id === docId), JSON.stringify(docsList.body));

    console.log("\nProves two independent datastores, not a live sync");
    await request("DELETE", `/api/customers/${remoteCustId}/identifiers/${remoteIdentifierId}`, null, token).catch(() => {});
    await request("DELETE", `/api/customers/${remoteCustId}/contacts/${remoteContactId}`, null, token).catch(() => {});
    remoteIdentifierId = null; remoteContactId = null;
    await request("DELETE", `/api/customers/${remoteCustId}`, null, token).catch(() => {});
    remoteCustId = null;

    const flipLocal = await setSource(token, "local");
    assert("flip back to local succeeds", flipLocal.status === 200 && flipLocal.body.customerSource === "local", JSON.stringify(flipLocal.body));
    const getLocalStillThere = await request("GET", `/api/customers/${localCustId}`, null, token);
    assert("the original local customer was never touched", getLocalStillThere.status === 200 && getLocalStillThere.body.companyName === `Toggle Test Local Co ${stamp}`);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq").catch(() => null);
    if (adminToken) {
      await setSource(adminToken, "remote").catch(() => {}); // reach any still-remote-only leftovers before flipping back
      if (remoteIdentifierId && remoteCustId) await request("DELETE", `/api/customers/${remoteCustId}/identifiers/${remoteIdentifierId}`, null, adminToken).catch(() => {});
      if (remoteContactId && remoteCustId) await request("DELETE", `/api/customers/${remoteCustId}/contacts/${remoteContactId}`, null, adminToken).catch(() => {});
      if (remoteCustId) await request("DELETE", `/api/customers/${remoteCustId}`, null, adminToken).catch(() => {});
      if (shipHoldId) await request("DELETE", `/api/shipments/${shipHoldId}`, null, adminToken).catch(() => {});
      if (custHoldId) await request("DELETE", `/api/customers/${custHoldId}`, null, adminToken).catch(() => {});
      if (rollupShipId) await request("DELETE", `/api/shipments/${rollupShipId}`, null, adminToken).catch(() => {});
      if (childCustId) await request("DELETE", `/api/customers/${childCustId}`, null, adminToken).catch(() => {});
      if (parentCustId) await request("DELETE", `/api/customers/${parentCustId}`, null, adminToken).catch(() => {});
      if (crossRefShipId) await request("DELETE", `/api/shipments/${crossRefShipId}`, null, adminToken).catch(() => {});
      if (crossRefCustId) await request("DELETE", `/api/customers/${crossRefCustId}`, null, adminToken).catch(() => {});
      if (docId && docCustId) await request("DELETE", `/api/customers/${docCustId}/documents/${docId}`, null, adminToken).catch(() => {});
      if (docCustId) await request("DELETE", `/api/customers/${docCustId}`, null, adminToken).catch(() => {});
      await setSource(adminToken, "local").catch(() => {}); // always leave the toggle back at the safe default
      if (localCustId) await request("DELETE", `/api/customers/${localCustId}`, null, adminToken).catch(() => {});
      if (scratchUserId) await request("DELETE", `/api/users/${scratchUserId}`, null, adminToken).catch(() => {});
    }
  }
})();
