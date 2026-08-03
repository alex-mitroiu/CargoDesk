/**
 * AIS Integration (TKT-ZFO2OM) — vessel resolve/refresh + in-place ETD/ETA confirmation
 *
 * Confirmed departure/arrival updates a SEA leg's etd/eta directly (an estimate becoming a
 * known fact), not a separate always-visible atd/ata pair — reworked from an earlier design
 * pass per direct feedback. etd_source/eta_source ('manual'|'ais'|'') is the idempotent-
 * confirmation flag: 'ais' means "don't re-fire," any manual PUT clears it back to ''.
 *
 * Exercises lib/ais-listener.js's ingestMessage() the same way the live aisstream.io
 * connection and the Test Tools AIS Simulator both do — via the two real
 * POST /api/test-tools/ais/simulate-* routes, not a mocked/reimplemented handler.
 *
 * Usage:
 *   node tests/ais-integration.test.js
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

    console.log("\nVessel resolve — unknown IMO becomes a real vessels row");
    const imo = "9199901", mmsi = "911222333";
    const empty = await request("GET", `/api/vessels/${imo}`, null, token);
    assert("unresolved IMO not found yet (404)", empty.status === 404);
    const resolved = await request("POST", "/api/test-tools/ais/simulate-static",
      { imo, mmsi, name: "AIS TEST VESSEL ONE" }, token);
    assert("simulate-static returns 200", resolved.status === 200);
    assert("vessel applied", resolved.body.applied === true);
    const fetched = await request("GET", `/api/vessels/${imo}`, null, token);
    assert("vessel now resolvable", fetched.status === 200 && fetched.body.name === "AIS TEST VESSEL ONE");
    assert("flag/tonnage stay blank — AIS doesn't supply them", fetched.body.flagIso2 === "" && fetched.body.grossTonnage == null);

    console.log("\nVessel refresh — re-observing the same name is a silent no-op");
    const beforeRename = await request("GET", `/api/entity-events/vessel/${imo}`, null, token);
    const renamedCountBefore = beforeRename.body.filter(e => e.eventType === "RENAMED").length;
    const reSeen = await request("POST", "/api/test-tools/ais/simulate-static", { imo, mmsi, name: "AIS TEST VESSEL ONE" }, token);
    assert("re-observing same name returns 200", reSeen.status === 200);
    const afterReSeen = await request("GET", `/api/entity-events/vessel/${imo}`, null, token);
    assert("re-observing the same name logs no RENAMED event",
      afterReSeen.body.filter(e => e.eventType === "RENAMED").length === renamedCountBefore);

    console.log("\nVessel rename — a differing name for a known IMO is detected and logged");
    const renamed = await request("POST", "/api/test-tools/ais/simulate-static", { imo, mmsi, name: "AIS TEST VESSEL RENAMED" }, token);
    assert("rename applied", renamed.status === 200 && renamed.body.vessel.name === "AIS TEST VESSEL RENAMED");
    const events = await request("GET", `/api/entity-events/vessel/${imo}`, null, token);
    const renameEvents = events.body.filter(e => e.eventType === "RENAMED");
    // entity_events is an append-only audit log with no delete route — this file's own vessel
    // gets deleted at cleanup below, but its historical events don't, so a rerun's own count
    // starts from whatever earlier runs left behind. Assert the DELTA (+1), not an absolute
    // count, so this stays correct however many times this file has run before.
    assert("exactly one NEW RENAMED event logged by this run", renameEvents.length === renamedCountBefore + 1);
    const lastRename = renameEvents[renameEvents.length - 1];
    assert("RENAMED event captures old/new name", lastRename.oldValue === "AIS TEST VESSEL ONE" && lastRename.newValue === "AIS TEST VESSEL RENAMED");

    console.log("\nInvalid simulate-static payload is rejected");
    const bad = await request("POST", "/api/test-tools/ais/simulate-static", { imo: "123" }, token);
    assert("missing mmsi/name rejected", bad.status >= 400);

    console.log("\nScratch shipment + SEA leg with a real POL for ETD/ETA confirmation");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
    }, token);
    const shipmentId = ship.body.id;
    assert("scratch shipment created", ship.status === 201);
    const leg = await request("POST", `/api/shipments/${shipmentId}/legs`, {
      legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
      etd: "2026-09-01", eta: "2026-09-15", carrierCode: "MAEU",
      vessel: "AIS TEST VESSEL RENAMED", vesselImo: imo,
    }, token);
    const legId = leg.body.id;
    assert("SEA leg created with vessel_imo", leg.status === 201 && leg.body.vesselImo === imo);
    assert("etd/eta start as the given estimate, unconfirmed", leg.body.etd === "2026-09-01" && leg.body.eta === "2026-09-15");
    assert("etdSource/etaSource start blank (not yet AIS-confirmed)", leg.body.etdSource === "" && leg.body.etaSource === "");

    console.log("\nDeparture confirmation — a simulated departure updates etd IN PLACE with source:'ais'");
    const dep = await request("POST", "/api/test-tools/ais/simulate-position", { legId, event: "departure" }, token);
    assert("simulate-position returns 200", dep.status === 200);
    assert("etd updated to the confirmed date (no longer the original estimate)", dep.body.etd !== "2026-09-01" && !!dep.body.etd);
    assert("etd_source is 'ais'", dep.body.etdSource === "ais");
    const shipAfterEtd = await request("GET", `/api/shipments/${shipmentId}`, null, token);
    assert("shipment-level etd bookend rolled up via syncShipmentFromLegs", shipAfterEtd.body.etd === dep.body.etd);
    const legEvents = await request("GET", `/api/entity-events/shipment_leg/${legId}`, null, token);
    assert("AIS_DEPARTURE_CONFIRMED logged", legEvents.body.some(e => e.eventType === "AIS_DEPARTURE_CONFIRMED"));

    console.log("\nIdempotent-confirmation guard — re-simulating departure does not re-fire once already confirmed");
    const dep2 = await request("POST", "/api/test-tools/ais/simulate-position", { legId, event: "departure" }, token);
    assert("second simulate-position still 200", dep2.status === 200);
    assert("etd unchanged on the second attempt", dep2.body.etd === dep.body.etd);
    const legEvents2 = await request("GET", `/api/entity-events/shipment_leg/${legId}`, null, token);
    assert("no duplicate AIS_DEPARTURE_CONFIRMED event", legEvents2.body.filter(e => e.eventType === "AIS_DEPARTURE_CONFIRMED").length === 1);

    console.log("\nA MANUAL correction always overwrites an AIS-confirmed value and resets the confirmed flag");
    const manualCorrect = await request("PUT", `/api/shipments/${shipmentId}/legs/${legId}`, {
      legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
      etd: "2026-09-02", eta: "2026-09-15", carrierCode: "MAEU",
      vessel: "AIS TEST VESSEL RENAMED", vesselImo: imo,
    }, token);
    assert("manual PUT can override a confirmed etd", manualCorrect.body.etd === "2026-09-02");
    assert("etd_source clears back to '' on a manual change", manualCorrect.body.etdSource === "");

    console.log("\nATA confirmation mirrors ETD");
    const arr = await request("POST", "/api/test-tools/ais/simulate-position", { legId, event: "arrival" }, token);
    assert("simulate-position (arrival) returns 200", arr.status === 200);
    assert("eta updated to the confirmed date", arr.body.eta !== "2026-09-15" && !!arr.body.eta);
    assert("eta_source is 'ais'", arr.body.etaSource === "ais");

    console.log("\nAIS status endpoint");
    const status = await request("GET", "/api/ais/status", null, token);
    assert("status returns 200", status.status === 200);
    assert("status has a connected boolean", typeof status.body.connected === "boolean");

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    // The vessel this file creates must not survive between runs — the very first assertion
    // (unresolved IMO not found yet) and the rename-count assertion both depend on starting
    // from a genuinely clean IMO each time.
    await request("DELETE", `/api/vessels/${imo}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
