/**
 * Charge Defaults — CRUD + validation + the applyChargeDefaults() matching/precedence engine
 * (mockup: https://claude.ai/artifact/15DeP2Lcx9qmQbyQAUEwWd)
 *
 * Usage:
 *   node tests/charge-default-setups.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

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
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nValidation — rejects an empty setup, a bad location shape, accepts a valid Global setup");
    const noLines = await request("POST", "/api/charge-default-setups", {
      locationGlobal: true, lines: [],
    }, token);
    assert("empty lines rejected", noLines.status >= 400 && /line/i.test(noLines.body.error || ""));

    const twoOriginFields = await request("POST", "/api/charge-default-setups", {
      locationGlobal: false, originCountry: "US", originRegion: "AMER",
      destCountry: "US",
      lines: [{ type: "SELL", chargeCode: "Customs", amount: 10 }],
    }, token);
    assert("two Origin fields at once rejected", twoOriginFields.status >= 400 && /Origin/.test(twoOriginFields.body.error || ""));

    const badChargeCode = await request("POST", "/api/charge-default-setups", {
      locationGlobal: true, lines: [{ type: "SELL", chargeCode: "Not A Real Code", amount: 10 }],
    }, token);
    assert("a chargeCode outside the fixed vocabulary is rejected", badChargeCode.status >= 400);

    console.log("\nCRUD — create, get, list, update (whole-line replace), deactivate, delete");
    const globalSetup = await request("POST", "/api/charge-default-setups", {
      // Deliberately also sends location fields alongside locationGlobal:true — rule 03
      // ("Global disables, not just hides") must clear them server-side regardless.
      locationGlobal: true, originCountry: "US", destCountry: "NL",
      lines: [{ type: "SELL", chargeCode: "Customs", description: "Global Fallback Charge", currency: "USD", amount: 50 }],
    }, token);
    assert("global setup created (201)", globalSetup.status === 201, JSON.stringify(globalSetup.body));
    assert("locationGlobal true means location fields are cleared even if sent", globalSetup.body.originCountry === "" && globalSetup.body.destCountry === "");
    assert("one line present", globalSetup.body.lines.length === 1 && globalSetup.body.lines[0].chargeCode === "Customs");

    const globalSetupId = globalSetup.body.id;
    const got = await request("GET", `/api/charge-default-setups/${globalSetupId}`, null, token);
    assert("get returns 200 with nested lines", got.status === 200 && got.body.lines.length === 1);

    const list = await request("GET", "/api/charge-default-setups", null, token);
    const listed = list.body.find(s => s.id === globalSetupId);
    assert("list includes it with a lineCount, not full lines", listed && listed.lineCount === 1 && listed.lines === undefined);

    const updated = await request("PUT", `/api/charge-default-setups/${globalSetupId}`, {
      locationGlobal: true,
      lines: [
        { type: "SELL", chargeCode: "Customs", amount: 60 },
        { type: "BUY", chargeCode: "Inland", amount: 25 },
      ],
    }, token);
    assert("update returns 200 with the replaced lines (2, not 3)", updated.status === 200 && updated.body.lines.length === 2, JSON.stringify(updated.body));

    const deactivated = await request("PATCH", `/api/charge-default-setups/${globalSetupId}/active`, { isActive: false }, token);
    assert("deactivate returns ok", deactivated.status === 200);
    const afterDeactivate = await request("GET", `/api/charge-default-setups/${globalSetupId}`, null, token);
    assert("isActive reflects the deactivate", afterDeactivate.body.isActive === false);

    await request("DELETE", `/api/charge-default-setups/${globalSetupId}`, null, token);
    const afterDelete = await request("GET", `/api/charge-default-setups/${globalSetupId}`, null, token);
    assert("get 404s after delete", afterDelete.status === 404);

    console.log("\nMatching engine — precedence, contract/manual-line skip, apply-once");
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);

    const custA = await request("POST", "/api/customers", { companyName: "Charge Defaults Test Principal A" }, token);
    const custB = await request("POST", "/api/customers", { companyName: "Charge Defaults Test Principal B" }, token);
    assert("scratch principal A created", custA.status === 201, JSON.stringify(custA.body));
    assert("scratch principal B created", custB.status === 201, JSON.stringify(custB.body));

    // Broad: no principal, no location, no movement type — the fallback every shipment matches
    // unless something more specific also matches.
    const fallbackSetup = await request("POST", "/api/charge-default-setups", {
      locationGlobal: true,
      lines: [{ type: "SELL", chargeCode: "Customs", description: "Fallback", currency: "USD", amount: 50 }],
    }, token);
    assert("fallback setup created", fallbackSetup.status === 201);

    // Specific: Principal A, exact NLRTM->USNYC, FCL — should outrank the fallback for Principal A's
    // shipments, and never fire for Principal B's.
    const specificSetup = await request("POST", "/api/charge-default-setups", {
      principalId: custA.body.id, principalName: custA.body.companyName, movementType: "FCL",
      originLocation: "NLRTM", destLocation: "USNYC",
      lines: [
        { type: "BUY", chargeCode: "Inland", description: "Specific Inland", currency: "USD", amount: 85 },
        { type: "SELL", chargeCode: "B/L Fee", description: "Specific BL Fee", currency: "USD", amount: 40 },
      ],
    }, token);
    assert("specific setup created", specificSetup.status === 201, JSON.stringify(specificSetup.body));

    const shipA = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      emoOfficeId, imoOfficeId, principalId: custA.body.id,
    }, token);
    assert("shipment A created (Principal A, NLRTM->USNYC)", shipA.status === 201, JSON.stringify(shipA.body));

    const shipALines1 = await request("GET", `/api/shipments/${shipA.body.id}/cost-lines`, null, token);
    const codesA1 = shipALines1.body.map(l => l.chargeCode);
    assert("specific setup's lines were applied to shipment A", codesA1.includes("Inland") && codesA1.includes("B/L Fee"));
    assert("the broader fallback's line did NOT also apply — only the most specific setup wins", !codesA1.includes("Customs"));

    const shipALines2 = await request("GET", `/api/shipments/${shipA.body.id}/cost-lines`, null, token);
    assert("a second GET does not duplicate the applied lines (apply-once)", shipALines2.body.length === shipALines1.body.length);

    const shipB = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      emoOfficeId, imoOfficeId, principalId: custB.body.id,
    }, token);
    assert("shipment B created (Principal B, same lane)", shipB.status === 201, JSON.stringify(shipB.body));
    const shipBLines = await request("GET", `/api/shipments/${shipB.body.id}/cost-lines`, null, token);
    // Checks exclusion only, not which setup wins overall — this is a shared dev database that
    // may have other active setups at any specificity (even reusing the same fixed-vocabulary
    // charge code), so neither "the fallback specifically wins" nor "chargeCode absence" is a
    // safe check here. Disambiguate by this setup's own distinctive amount (85), same technique
    // as the region test below.
    assert("Principal B's shipment does NOT get Principal A's specific setup",
      !shipBLines.body.some(l => l.chargeCode === "Inland" && l.amountUsd === 85));

    const shipC = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      emoOfficeId, imoOfficeId, principalId: custA.body.id,
    }, token);
    await request("POST", `/api/shipments/${shipC.body.id}/cost-lines`, { type: "BUY", chargeCode: "Inland", amount: 999 }, token);
    const shipCLines = await request("GET", `/api/shipments/${shipC.body.id}/cost-lines`, null, token);
    const inlandLines = shipCLines.body.filter(l => l.chargeCode === "Inland");
    assert("a pre-existing manual line for a code the setup also defines is never duplicated", inlandLines.length === 1 && inlandLines[0].amount === 999);
    assert("the setup's OTHER line (a different code) still gets applied to fill the gap", shipCLines.body.some(l => l.chargeCode === "B/L Fee"));

    console.log("\nRegion granularity resolves from port_locations.zone_code, not countries.region_code");
    console.log("(QA finding 2026-09-25: countries.region_code is empty on all 208 seeded countries — region must come from the port's own zone)");
    const portInZoneA = await request("POST", "/api/port-locations", { unlocode: "ZZQ01", name: "Zscratch Port One", countryCode: "ZQ", zoneCode: "ZQREGION" }, token);
    const portInZoneB = await request("POST", "/api/port-locations", { unlocode: "ZZQ02", name: "Zscratch Port Two", countryCode: "ZQ", zoneCode: "ZQREGION" }, token);
    const portOutOfZone = await request("POST", "/api/port-locations", { unlocode: "ZZQ03", name: "Zscratch Port Three", countryCode: "ZQ", zoneCode: "ZQOTHER" }, token);
    assert("3 scratch ports created", [portInZoneA, portInZoneB, portOutOfZone].every(r => r.status === 201), JSON.stringify([portInZoneA.body, portInZoneB.body, portOutOfZone.body]));

    const regionSetup = await request("POST", "/api/charge-default-setups", {
      originRegion: "ZQREGION", destLocation: "USNYC",
      lines: [{ type: "SELL", chargeCode: "Haulage", description: "Region Match", currency: "USD", amount: 33 }],
    }, token);
    assert("region-scoped setup created", regionSetup.status === 201, JSON.stringify(regionSetup.body));

    const shipRegionA = await request("POST", "/api/shipments", { pol: "ZZQ01", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", emoOfficeId, imoOfficeId }, token);
    const shipRegionB = await request("POST", "/api/shipments", { pol: "ZZQ02", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", emoOfficeId, imoOfficeId }, token);
    const shipRegionC = await request("POST", "/api/shipments", { pol: "ZZQ03", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", emoOfficeId, imoOfficeId }, token);

    const linesRegionA = await request("GET", `/api/shipments/${shipRegionA.body.id}/cost-lines`, null, token);
    const linesRegionB = await request("GET", `/api/shipments/${shipRegionB.body.id}/cost-lines`, null, token);
    const linesRegionC = await request("GET", `/api/shipments/${shipRegionC.body.id}/cost-lines`, null, token);
    assert("region setup matches a port in its zone", linesRegionA.body.some(l => l.chargeCode === "Haulage"));
    assert("region setup matches a DIFFERENT port sharing the same zone", linesRegionB.body.some(l => l.chargeCode === "Haulage"));
    // Matches on this setup's own distinctive amount, not just the charge code — "Haulage" is a
    // shared, fixed-vocabulary code another active setup in this shared dev database could also
    // use, so checking code-presence alone isn't a safe way to isolate THIS setup's own effect.
    assert("region setup does NOT match a port in a different zone", !linesRegionC.body.some(l => l.chargeCode === "Haulage" && l.amountUsd === 33));

    console.log("\nManual-line skip is scoped by type+code, not code alone");
    console.log("(QA finding 2026-09-25: a manual BUY line must never block a setup's independent SELL default of the same code)");
    const typeTestSetup = await request("POST", "/api/charge-default-setups", {
      principalId: custA.body.id, principalName: custA.body.companyName, movementType: "FCL",
      originLocation: "NLRTM", destLocation: "USNYC",
      lines: [
        { type: "SELL", chargeCode: "Ocean Freight", description: "Sell side default", currency: "USD", amount: 500 },
        { type: "BUY", chargeCode: "Customs", description: "Buy side default", currency: "USD", amount: 20 },
      ],
    }, token);
    assert("type-collision test setup created", typeTestSetup.status === 201, JSON.stringify(typeTestSetup.body));

    const shipD = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      emoOfficeId, imoOfficeId, principalId: custA.body.id,
    }, token);
    await request("POST", `/api/shipments/${shipD.body.id}/cost-lines`, { type: "BUY", chargeCode: "Ocean Freight", amount: 1450 }, token);
    const shipDLines = await request("GET", `/api/shipments/${shipD.body.id}/cost-lines`, null, token);
    const sellOceanFreight = shipDLines.body.filter(l => l.chargeCode === "Ocean Freight" && l.type === "SELL");
    assert("a manual BUY line does not block the setup's independent SELL line of the same code", sellOceanFreight.length === 1, JSON.stringify(shipDLines.body));
    assert("the setup's other (non-colliding) BUY line still applies", shipDLines.body.some(l => l.chargeCode === "Customs" && l.type === "BUY"));

    console.log("\nDELETE 404s for an unknown id, matching GET/PUT/PATCH on the same resource");
    const deleteUnknown = await request("DELETE", "/api/charge-default-setups/CDS-NOPE", null, token);
    assert("delete of an unknown setup id returns 404", deleteUnknown.status === 404);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipA.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipB.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipC.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipD.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipRegionA.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipRegionB.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipRegionC.body.id}`, null, token);
    await request("DELETE", `/api/charge-default-setups/${fallbackSetup.body.id}`, null, token);
    await request("DELETE", `/api/charge-default-setups/${specificSetup.body.id}`, null, token);
    await request("DELETE", `/api/charge-default-setups/${regionSetup.body.id}`, null, token);
    await request("DELETE", `/api/charge-default-setups/${typeTestSetup.body.id}`, null, token);
    await request("DELETE", "/api/port-locations/ZZQ01", null, token);
    await request("DELETE", "/api/port-locations/ZZQ02", null, token);
    await request("DELETE", "/api/port-locations/ZZQ03", null, token);
    await request("DELETE", `/api/customers/${custA.body.id}`, null, token);
    await request("DELETE", `/api/customers/${custB.body.id}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
