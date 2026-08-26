/**
 * eAdapter — per-carrier, per-office EDI connectivity configuration (carrier-EDI epic, story 1;
 * office-scoped as of v0.83.0 — a real carrier EDI relationship is negotiated per country/branch,
 * not once globally, so the same carrier can hold several configs, one per office it's actually
 * set up for)
 *
 * Usage:
 *   node tests/eadapter.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

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

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost",
    password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token)
    throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

// Synthetic unlocode + explicit countryCode (offices.js accepts both independently) — a real
// port code like NLRTM/USNYC already has a real office in this long-lived dev DB (`offices.code`
// is UNIQUE), so reusing one here would 400 on creation. Deriving the unlocode from the stamp
// keeps this collision-free across runs, matching this codebase's own "AF-XXXXX-SE" scratch-
// office convention elsewhere.
async function scratchOffice(token, countryCode, seed, name, stamp) {
  const unlocode = `${countryCode}${seed}${stamp % 1000}`.slice(0, 5).toUpperCase().padEnd(5, "X");
  const res = await request("POST", "/api/offices", { unlocode, countryCode, department: "SE", name: `${name} ${stamp}` }, token);
  return res.body;
}

async function scratchShipment(token, carrierCode, emoOfficeId) {
  const res = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode,
    status: "Active", contractType: "SPOT", etd: "2026-09-01", emoOfficeId,
  }, token);
  return res.body.id;
}

// ─── Config CRUD, office-scoped ─────────────────────────────────────────────

async function testConfigCrud(token, officeA, officeB) {
  console.log("\neAdapter — config CRUD (office-scoped)");
  const code = "EATX";

  const noOffice = await request("POST", "/api/eadapter/configs", { carrierCode: code }, token);
  assert("missing officeId rejected (400)", noOffice.status === 400, JSON.stringify(noOffice.body));

  const create = await request("POST", "/api/eadapter/configs", {
    carrierCode: code, officeId: officeA.id, transportType: "rest_api",
    endpointUrl: "https://api.example.com/booking", authHeaderName: "Consumer-Key",
    credential: "sk_test_12345", isActive: true, notes: "Scratch test carrier",
  }, token);
  assert("create returns 201", create.status === 201, JSON.stringify(create.body));
  assert("id has EAC- prefix", typeof create.body?.id === "string" && create.body.id.startsWith("EAC-"));
  assert("carrierCode is uppercased", create.body?.carrierCode === code);
  assert("officeId round-trips", create.body?.officeId === officeA.id);
  assert("officeCode is joined in for display", create.body?.officeCode === officeA.code);
  assert("countryIso2 is derived from the office, not left blank", create.body?.countryIso2 === officeA.countryCode);
  assert("hasCredential is true", create.body?.hasCredential === true);
  assert("raw credential is never returned", !("credential" in create.body));
  const configId = create.body.id;

  const dupe = await request("POST", "/api/eadapter/configs", { carrierCode: code, officeId: officeA.id }, token);
  assert("duplicate (carrier, office) returns 409", dupe.status === 409, JSON.stringify(dupe.body));

  // Same carrier, a different (still real) office, with a deliberately wrong client-supplied
  // countryIso2 — proves the server derives country from the office row and ignores the body.
  const wrongCountry = await request("POST", "/api/eadapter/configs",
    { carrierCode: code, officeId: officeB.id, countryIso2: "ZZ" }, token);
  assert("second office for the same carrier is not a duplicate (201)", wrongCountry.status === 201, JSON.stringify(wrongCountry.body));
  assert("client-supplied countryIso2 is ignored — server derives it from the office instead",
    wrongCountry.body?.countryIso2 === officeB.countryCode && wrongCountry.body?.countryIso2 !== "ZZ");
  await request("DELETE", `/api/eadapter/configs/${wrongCountry.body.id}`, null, token);

  const badOffice = await request("POST", "/api/eadapter/configs", { carrierCode: code, officeId: "OFF-DOES-NOT-EXIST" }, token);
  assert("nonexistent office rejected (404)", badOffice.status === 404, JSON.stringify(badOffice.body));

  const list1 = await request("GET", "/api/eadapter/configs", null, token);
  assert("list returns 200", list1.status === 200);
  const row1 = (list1.body || []).find(r => r.id === configId);
  assert("created config appears in the list", !!row1);
  assert("list row also never carries a raw credential", row1 && !("credential" in row1));

  const update = await request("PUT", `/api/eadapter/configs/${configId}`, {
    transportType: "sftp", endpointUrl: "sftp://example.com/inbound", isActive: false,
    notes: "Updated notes", credential: "",
  }, token);
  assert("update returns 200", update.status === 200);
  assert("transportType updated", update.body?.transportType === "sftp");
  assert("isActive updated to false", update.body?.isActive === false);
  assert("blank credential on update keeps hasCredential true (existing one preserved)", update.body?.hasCredential === true);

  const badTransport = await request("PUT", `/api/eadapter/configs/${configId}`, { transportType: "carrier-pigeon" }, token);
  assert("invalid transportType rejected (400)", badTransport.status === 400);

  const del = await request("DELETE", `/api/eadapter/configs/${configId}`, null, token);
  assert("delete returns 200", del.status === 200);
  const list2 = await request("GET", "/api/eadapter/configs", null, token);
  assert("deleted config no longer in the list", !(list2.body || []).some(r => r.id === configId));
}

// ─── Same carrier, two different offices — not a duplicate ─────────────────

async function testSameCarrierDifferentOffices(token, officeA, officeB) {
  console.log("\neAdapter — same carrier at two different offices is NOT a duplicate");
  const code = "EATZ";

  const createA = await request("POST", "/api/eadapter/configs", { carrierCode: code, officeId: officeA.id }, token);
  assert(`config at ${officeA.code} created`, createA.status === 201, JSON.stringify(createA.body));
  const createB = await request("POST", "/api/eadapter/configs", { carrierCode: code, officeId: officeB.id }, token);
  assert(`config at ${officeB.code} (different office, same carrier) also created`, createB.status === 201, JSON.stringify(createB.body));

  const list = await request("GET", "/api/eadapter/configs", null, token);
  const rows = (list.body || []).filter(r => r.carrierCode === code);
  assert("both rows coexist for the same carrier", rows.length === 2, JSON.stringify(rows));

  await request("DELETE", `/api/eadapter/configs/${createA.body.id}`, null, token);
  await request("DELETE", `/api/eadapter/configs/${createB.body.id}`, null, token);
}

// ─── bookable-carriers is office-aware ──────────────────────────────────────

async function testBookableCarriersOfficeAware(token, officeA, officeB) {
  console.log("\neAdapter — bookable-carriers only reflects a config at the OFFICE actually asked about");
  const code = "EATY";

  const baselineA = await request("GET", `/api/eadapter/bookable-carriers?officeId=${officeA.id}`, null, token);
  assert("baseline includes the 3 built-in carriers", ["MAEU", "SAFM", "MCPU"].every(c => baselineA.body?.carriers?.includes(c)));
  assert("baseline does not yet include the scratch carrier", !baselineA.body?.carriers?.includes(code));

  const noOfficeQuery = await request("GET", "/api/eadapter/bookable-carriers", null, token);
  assert("no officeId query param still returns the built-in 3 only", ["MAEU", "SAFM", "MCPU"].every(c => noOfficeQuery.body?.carriers?.includes(c)) && !noOfficeQuery.body?.carriers?.includes(code));

  const create = await request("POST", "/api/eadapter/configs", { carrierCode: code, officeId: officeA.id, isActive: true }, token);
  const configId = create.body.id;

  const afterActiveA = await request("GET", `/api/eadapter/bookable-carriers?officeId=${officeA.id}`, null, token);
  assert("active config's carrier is bookable when asking about its own office", afterActiveA.body?.carriers?.includes(code));

  const afterActiveB = await request("GET", `/api/eadapter/bookable-carriers?officeId=${officeB.id}`, null, token);
  assert("same carrier is NOT bookable when asking about a DIFFERENT office with no config", !afterActiveB.body?.carriers?.includes(code));

  await request("PUT", `/api/eadapter/configs/${configId}`, { isActive: false }, token);
  const afterInactive = await request("GET", `/api/eadapter/bookable-carriers?officeId=${officeA.id}`, null, token);
  assert("deactivated config's carrier is no longer bookable at its own office", !afterInactive.body?.carriers?.includes(code));

  await request("PUT", `/api/eadapter/configs/${configId}`, { isActive: true }, token);
  const afterReactive = await request("GET", `/api/eadapter/bookable-carriers?officeId=${officeA.id}`, null, token);
  assert("re-activated config's carrier is bookable again at its own office", afterReactive.body?.carriers?.includes(code));

  await request("DELETE", `/api/eadapter/configs/${configId}`, null, token);
  const afterDelete = await request("GET", `/api/eadapter/bookable-carriers?officeId=${officeA.id}`, null, token);
  assert("deleted config's carrier is no longer bookable", !afterDelete.body?.carriers?.includes(code));
}

// ─── Booking-request route resolves via the shipment's own EMO office ──────

async function testBookingRequestOfficeResolution(token, officeA, officeB) {
  console.log("\neAdapter — booking-request only succeeds through the office actually configured");
  const code = "EATW";
  const create = await request("POST", "/api/eadapter/configs", { carrierCode: code, officeId: officeA.id, isActive: true }, token);
  const configId = create.body.id;

  const shipAtA = await scratchShipment(token, code, officeA.id);
  const sendAtA = await request("POST", `/api/shipments/${shipAtA}/edi-messages/booking-request`, {}, token);
  assert("booking-request succeeds for a shipment through the configured office", sendAtA.status === 201, JSON.stringify(sendAtA.body));

  const shipAtB = await scratchShipment(token, code, officeB.id);
  const sendAtB = await request("POST", `/api/shipments/${shipAtB}/edi-messages/booking-request`, {}, token);
  assert("booking-request is blocked (400) for the same carrier through a DIFFERENT office with no config", sendAtB.status === 400, JSON.stringify(sendAtB.body));

  const shipNoOffice = await scratchShipment(token, code, null);
  const sendNoOffice = await request("POST", `/api/shipments/${shipNoOffice}/edi-messages/booking-request`, {}, token);
  assert("booking-request is blocked (400) for a shipment with no EMO office assigned at all", sendNoOffice.status === 400, JSON.stringify(sendNoOffice.body));

  await request("DELETE", `/api/shipments/${shipAtA}`, null, token);
  await request("DELETE", `/api/shipments/${shipAtB}`, null, token);
  await request("DELETE", `/api/shipments/${shipNoOffice}`, null, token);
  await request("DELETE", `/api/eadapter/configs/${configId}`, null, token);
}

// ─── Office delete-guard ─────────────────────────────────────────────────────

async function testOfficeDeleteGuard(token, stamp) {
  console.log("\neAdapter — an office referenced by a config can't be deleted out from under it");
  const office = await scratchOffice(token, "ZR", "C", "Guard Test Office", stamp);
  const create = await request("POST", "/api/eadapter/configs", { carrierCode: "EATV", officeId: office.id }, token);
  assert("config created for the guard-test office", create.status === 201, JSON.stringify(create.body));

  const delBlocked = await request("DELETE", `/api/offices/${office.id}`, null, token);
  assert("office delete blocked while a config references it (400)", delBlocked.status === 400, JSON.stringify(delBlocked.body));

  await request("DELETE", `/api/eadapter/configs/${create.body.id}`, null, token);
  const delAfter = await request("DELETE", `/api/offices/${office.id}`, null, token);
  assert("office delete succeeds once the config is removed", delAfter.status === 200, JSON.stringify(delAfter.body));
}

// ─── Master toggle gates ALL carriers, including the built-in 3 ────────────

async function testMasterToggleGatesEverything(token, officeA) {
  console.log("\neAdapter — master toggle off blocks even the built-in 3 (no gaps, one switch)");
  const shipmentId = await scratchShipment(token, "MAEU", officeA.id);
  assert("scratch MAEU shipment created", !!shipmentId);

  const sendWhileOn = await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
  assert("MAEU booking-request succeeds while eAdapter is on", sendWhileOn.status === 201);

  await request("PUT", "/api/settings", { api_eadapter_enabled: "false" }, token);
  try {
    const bc = await request("GET", `/api/eadapter/bookable-carriers?officeId=${officeA.id}`, null, token);
    assert("bookable-carriers reports enabled:false", bc.body?.enabled === false);
    assert("bookable-carriers is empty while disabled", Array.isArray(bc.body?.carriers) && bc.body.carriers.length === 0);

    const shipment2 = await scratchShipment(token, "MAEU", officeA.id);
    const sendWhileOff = await request("POST", `/api/shipments/${shipment2}/edi-messages/booking-request`, {}, token);
    assert("MAEU booking-request is blocked (400) while master toggle is off", sendWhileOff.status === 400);
    await request("DELETE", `/api/shipments/${shipment2}`, null, token);
  } finally {
    await request("PUT", "/api/settings", { api_eadapter_enabled: "true" }, token);
  }

  const bc2 = await request("GET", `/api/eadapter/bookable-carriers?officeId=${officeA.id}`, null, token);
  assert("bookable-carriers reports enabled:true after restoring the toggle", bc2.body?.enabled === true);
  assert("MAEU is bookable again after restoring the toggle", bc2.body?.carriers?.includes("MAEU"));

  await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
}

(async () => {
  const stamp = Date.now();
  let officeA = null, officeB = null;
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    officeA = await scratchOffice(token, "ZM", "A", "eAdapter Test Office A", stamp);
    officeB = await scratchOffice(token, "ZW", "B", "eAdapter Test Office B", stamp);
    if (!officeA?.id || !officeB?.id) throw new Error("Failed to create scratch offices for the test run");

    await testConfigCrud(token, officeA, officeB);
    await testSameCarrierDifferentOffices(token, officeA, officeB);
    await testBookableCarriersOfficeAware(token, officeA, officeB);
    await testBookingRequestOfficeResolution(token, officeA, officeB);
    await testOfficeDeleteGuard(token, stamp);
    await testMasterToggleGatesEverything(token, officeA);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal error:", e.message);
    process.exit(1);
  } finally {
    const token = await login().catch(() => null);
    if (token) {
      if (officeA?.id) await request("DELETE", `/api/offices/${officeA.id}`, null, token).catch(() => {});
      if (officeB?.id) await request("DELETE", `/api/offices/${officeB.id}`, null, token).catch(() => {});
    }
  }
})();
