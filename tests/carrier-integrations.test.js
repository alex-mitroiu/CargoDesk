/**
 * Multi-Carrier Integration Framework — DCSA Standard (Epic TKT-KG4E49, stories 1-5)
 *
 * Exercises the real dcsa-bkg-v2 adapter's pure functions directly, then its actual fetch()
 * calls against a local mock HTTP server standing in for a carrier's real sandbox (no real
 * Hapag-Lloyd credentials needed — Story 6, the real sandbox signup, is a separate business/ops
 * action), plus the full booking-request -> carrier_integrations lookup -> webhook callback ->
 * applyBookingResponse plumbing, and the fallback-must-be-invisible guarantee for any carrier
 * with no active integration.
 *
 * Usage:
 *   node tests/carrier-integrations.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dcsaAdapter = (await import(pathToFileURL(path.join(__dirname, "..", "lib", "carrier-integrations", "dcsa-bkg-v2.js")).href)).default;

const BASE_HOST = "localhost";
const BASE_PORT = 3001;
let passed = 0;
let failed = 0;

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : null;
    const headers = {
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
    };
    if (payload && !Buffer.isBuffer(body)) headers["Content-Type"] = "application/json";
    const req = http.request({ method, hostname: BASE_HOST, port: BASE_PORT, path: urlPath, headers }, res => {
      let data = "";
      res.on("data", c => data += c);
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

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

// ─── Pure functions, no network at all ─────────────────────────────────────────
function testPureFunctions() {
  console.log("\nDCSA adapter — pure functions (buildBookingRequest / verifyCallback / parseCallback)");

  const requestPayload = {
    pol: "NLRTM", pod: "USNYC", carrierCode: "HLCU", etd: "2026-10-01",
    vessel: "TEST VESSEL", voyage: "001W", vesselImo: "9999999",
    service: "AEX", incoTerms: "FOB", equipment: [{ type: "40HC", count: 2 }], commodityCode: "8471",
  };
  const dcsaPayload = dcsaAdapter.buildBookingRequest({ id: "SHP-TEST" }, requestPayload);
  assert("buildBookingRequest sets vessel.vesselIMONumber", dcsaPayload.vessel?.vesselIMONumber === "9999999");
  assert("buildBookingRequest sets carrierServiceCode/carrierExportVoyageNumber", dcsaPayload.carrierServiceCode === "AEX" && dcsaPayload.carrierExportVoyageNumber === "001W");
  assert("shipmentLocations has POL/POD with correct UNLocationCode", dcsaPayload.shipmentLocations.some(l => l.locationTypeCode === "POL" && l.location.UNLocationCode === "NLRTM") && dcsaPayload.shipmentLocations.some(l => l.locationTypeCode === "POD" && l.location.UNLocationCode === "USNYC"));
  assert("requestedEquipments maps ISOEquipmentCode/units/commodities", dcsaPayload.requestedEquipments[0]?.ISOEquipmentCode === "40HC" && dcsaPayload.requestedEquipments[0]?.units === 2 && dcsaPayload.requestedEquipments[0]?.commodities?.[0]?.commodityType === "8471");

  const minimalPayload = dcsaAdapter.buildBookingRequest({ id: "SHP-TEST" }, { pol: "", pod: "", equipment: [] });
  assert("fields with no source data are omitted, never fabricated", minimalPayload.vessel === undefined && minimalPayload.expectedDepartureDate === undefined && minimalPayload.shipmentLocations.length === 0);

  const secret = "unit-test-secret";
  const rawBody = Buffer.from(JSON.stringify({ bookingStatus: "CONFIRMED", carrierBookingReference: "HLCU-REF-1", carrierBookingRequestReference: "REQ-REF-1" }), "utf8");
  const goodSig = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  assert("verifyCallback accepts a correctly signed body", dcsaAdapter.verifyCallback(rawBody, { "x-dcsa-signature": goodSig }, { webhookSecret: secret }) === true);
  assert("verifyCallback rejects a wrong-secret signature", dcsaAdapter.verifyCallback(rawBody, { "x-dcsa-signature": goodSig }, { webhookSecret: "wrong-secret" }) === false);
  assert("verifyCallback rejects a missing signature header or no configured secret", dcsaAdapter.verifyCallback(rawBody, {}, { webhookSecret: secret }) === false && dcsaAdapter.verifyCallback(rawBody, { "x-dcsa-signature": goodSig }, { webhookSecret: "" }) === false);

  assert("parseCallback maps CONFIRMED -> confirmed", dcsaAdapter.parseCallback({ bookingStatus: "CONFIRMED", carrierBookingReference: "HLCU-REF-1" }).status === "confirmed");
  assert("parseCallback maps REJECTED -> rejected", dcsaAdapter.parseCallback({ bookingStatus: "REJECTED" }).status === "rejected");
  assert("parseCallback maps an unrecognized/interim status -> confirmed_with_changes (surfaced for review, never silently confirmed)", dcsaAdapter.parseCallback({ bookingStatus: "PENDING_UPDATE" }).status === "confirmed_with_changes");
}

// ─── A tiny local HTTP server stands in for the carrier's real sandbox ─────────
function startMockCarrier() {
  let lastBookingRequestBody = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.method === "POST" && req.url === "/v2/bookings") {
        lastBookingRequestBody = JSON.parse(raw.toString("utf8") || "{}");
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ carrierBookingRequestReference: "MOCK-REQ-REF-1" }));
      } else if (req.method === "GET" && req.url.startsWith("/v1/vessel-schedules")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify([{ vesselName: "MOCK CARRIER VESSEL", vesselIMONumber: "9888888", carrierVoyageNumber: "002E", carrierServiceCode: "AEX", departureDateTime: "2026-10-05T00:00:00Z", arrivalDateTime: "2026-10-20T00:00:00Z" }]));
      } else { res.writeHead(404); res.end("{}"); }
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, getLastBookingRequestBody: () => lastBookingRequestBody })));
}

function rawPost(urlPath, buf, extraHeaders) {
  return new Promise((resolve, reject) => {
    const r = http.request({ method: "POST", hostname: BASE_HOST, port: BASE_PORT, path: urlPath,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(buf), ...extraHeaders } },
      res => { let d = ""; res.on("data", c => d += c); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } }); });
    r.on("error", reject); r.write(buf); r.end();
  });
}

async function scratchOffice(token, countryCode, name, stamp) {
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase().padEnd(3, "X");
  const unlocode = `${countryCode}${rand}`.slice(0, 5).toUpperCase();
  const res = await request("POST", "/api/offices", { unlocode, countryCode, department: "SE", name: `${name} ${stamp}` }, token);
  return res.body;
}

async function main() {
  const stamp = Date.now();
  const carrierCode = "ZZDC" + Math.random().toString(36).slice(2, 4).toUpperCase();
  const webhookSecret = "verify-secret-" + stamp;
  let officeA = null, integrationId = null, shipmentId = null, unconfiguredShipmentId = null, mock = null;
  let exitCode = 0;

  try {
    testPureFunctions();

    console.log("\nReal HTTP flow — carrier_integrations lookup, adapter dispatch, webhook callback");
    const token = await login();
    mock = await startMockCarrier();

    officeA = await scratchOffice(token, "ZM", "DCSA Test Office", stamp);
    assert("scratch office created", !!officeA?.id);

    const eadapterRes = await request("POST", "/api/eadapter/configs", { carrierCode, officeId: officeA.id, transportType: "rest_api", isActive: true }, token);
    assert("scratch eadapter config created (edi-bookable prerequisite, unrelated to carrier_integrations)", eadapterRes.status === 201, JSON.stringify(eadapterRes.body));

    const integrationRes = await request("POST", "/api/carrier-integrations", {
      carrierCode, adapterKey: "dcsa-bkg-v2", isActive: true, capabilities: ["booking", "schedules"],
      baseUrl: `http://127.0.0.1:${mock.port}`, authHeaderName: "Authorization", credential: "mock-bearer-token", webhookSecret,
    }, token);
    assert("carrier_integrations row created", integrationRes.status === 201, JSON.stringify(integrationRes.body));
    integrationId = integrationRes.body?.id;
    assert("credential never comes back over the API, only hasCredential", integrationRes.body?.credential === undefined && integrationRes.body?.hasCredential === true);

    const adaptersRes = await request("GET", "/api/carrier-integrations/adapters", null, token);
    assert("registered adapters list includes dcsa-bkg-v2", adaptersRes.body?.includes("dcsa-bkg-v2"));

    const shipRes = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode, status: "Active", contractType: "SPOT", etd: "2026-10-01", emoOfficeId: officeA.id }, token);
    shipmentId = shipRes.body?.id;
    assert("scratch shipment created", !!shipmentId, JSON.stringify(shipRes.body));

    const sendRes = await request("POST", `/api/shipments/${shipmentId}/edi-messages/booking-request`, {}, token);
    assert("booking-request returns 201 and stays pending (real carrier flow is async)", sendRes.status === 201 && sendRes.body?.pending === true);
    assert("carrier_booking_request_reference stored from the mock carrier's 202 response", sendRes.body?.booking?.carrierBookingRequestReference === "MOCK-REQ-REF-1");
    assert("the real adapter actually called the mock carrier with a DCSA-shaped body", mock.getLastBookingRequestBody()?.shipmentLocations?.some(l => l.locationTypeCode === "POL" && l.location.UNLocationCode === "NLRTM"));

    const callbackBody = { bookingStatus: "CONFIRMED", carrierBookingReference: "HLCU-REAL-REF-1", carrierBookingRequestReference: "MOCK-REQ-REF-1" };
    const rawCallback = Buffer.from(JSON.stringify(callbackBody), "utf8");
    const sig = "sha256=" + crypto.createHmac("sha256", webhookSecret).update(rawCallback).digest("hex");
    const goodWebhook = await rawPost(`/api/carrier-webhooks/${integrationId}`, rawCallback, { "x-dcsa-signature": sig });
    assert("correctly signed webhook accepted (201)", goodWebhook.status === 201, JSON.stringify(goodWebhook.body));
    assert("applyBookingResponse fired — real bookingRef + lastResponseStatus recorded", goodWebhook.body?.booking?.bookingRef === "HLCU-REAL-REF-1" && goodWebhook.body?.booking?.lastResponseStatus === "confirmed");

    const threadRes = await request("GET", `/api/shipments/${shipmentId}/edi-messages`, null, token);
    assert("a real (non-mock) inbound edi_messages row was written", threadRes.body?.some(m => m.direction === "in" && m.isMock === false));

    const badWebhook = await rawPost(`/api/carrier-webhooks/${integrationId}`, rawCallback, { "x-dcsa-signature": "sha256=deadbeef" });
    assert("incorrectly signed webhook rejected (401)", badWebhook.status === 401);

    const scheduleRes = await request("GET", `/api/schedules/search?pol=ZZTS1&pod=ZZTS2&carrierCode=${carrierCode}&weeks=4`, null, token);
    assert("schedule search uses the active 'schedules' integration ahead of mock fallback", scheduleRes.body?.sailings?.[0]?.vesselName === "MOCK CARRIER VESSEL" && scheduleRes.body?.sailings?.[0]?.source === "live" && scheduleRes.body?.isMock === false);

    const unconfiguredShip = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", etd: "2026-10-01" }, token);
    unconfiguredShipmentId = unconfiguredShip.body?.id;
    const unconfiguredSend = await request("POST", `/api/shipments/${unconfiguredShipmentId}/edi-messages/booking-request`, {}, token);
    assert("a carrier with NO active integration behaves byte-for-byte as before (fallback invisible)", unconfiguredSend.status === 201 && unconfiguredSend.body?.pending === true && !unconfiguredSend.body?.booking?.carrierBookingRequestReference);

    // ── Master safety-net toggle: off means every active integration is ignored, no exceptions ──
    console.log("\nMaster toggle (api_carrier_integrations_enabled) — a single kill switch, independent of any integration's own Active flag");
    let toggleShipmentId = null;
    await request("PUT", "/api/settings", { api_carrier_integrations_enabled: "false" }, token);
    try {
      const toggleShip = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode, status: "Active", contractType: "SPOT", etd: "2026-10-01", emoOfficeId: officeA.id }, token);
      toggleShipmentId = toggleShip.body?.id;
      const sendWhileOff = await request("POST", `/api/shipments/${toggleShipmentId}/edi-messages/booking-request`, {}, token);
      assert("booking-request still succeeds while toggle is off (falls back to simulator, not blocked)", sendWhileOff.status === 201 && sendWhileOff.body?.pending === true);
      assert("no carrier_booking_request_reference is stored while the toggle is off, even though the integration itself is still Active", !sendWhileOff.body?.booking?.carrierBookingRequestReference);

      const scheduleWhileOff = await request("GET", `/api/schedules/search?pol=ZZTS1&pod=ZZTS2&carrierCode=${carrierCode}&weeks=4`, null, token);
      assert("schedule search ignores the active integration while the toggle is off", scheduleWhileOff.body?.sailings?.[0]?.vesselName !== "MOCK CARRIER VESSEL");

      const webhookWhileOff = await rawPost(`/api/carrier-webhooks/${integrationId}`, rawCallback, { "x-dcsa-signature": sig });
      assert("webhook callback is rejected (503) while the toggle is off", webhookWhileOff.status === 503, JSON.stringify(webhookWhileOff.body));
    } finally {
      await request("PUT", "/api/settings", { api_carrier_integrations_enabled: "true" }, token);
      if (toggleShipmentId) await request("DELETE", `/api/shipments/${toggleShipmentId}`, null, token);
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e.message);
    exitCode = 1;
  } finally {
    try {
      const token = await login();
      if (shipmentId) await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
      if (unconfiguredShipmentId) await request("DELETE", `/api/shipments/${unconfiguredShipmentId}`, null, token);
      if (integrationId) await request("DELETE", `/api/carrier-integrations/${integrationId}`, null, token);
      const configs = await request("GET", "/api/eadapter/configs", null, token);
      for (const c of (configs.body || [])) if (c.carrierCode === carrierCode) await request("DELETE", `/api/eadapter/configs/${c.id}`, null, token);
      if (officeA?.id) await request("DELETE", `/api/offices/${officeA.id}`, null, token);
    } catch (e) { console.error("Cleanup error (non-fatal):", e.message); }
    if (mock?.server) mock.server.close();
  }
  process.exit(exitCode);
}

main();
