/**
 * CSV export — custom field selection
 *
 * Usage:
 *   node tests/export-fields.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *
 * Covers GET /api/export/shipments.csv's new ?fields= param: default (everything), a custom
 * subset, and that the 5 mandatory fields (Shipment ID, POL, POD, ETD/ATD, ETA/ATA) are always
 * force-included server-side regardless of what the caller actually requests — the real
 * enforcement point behind the Shipments page's field-picker modal (which only prevents
 * unchecking them client-side).
 */

import http from "node:http";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

function requestRaw(method, path, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}` } }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

function requestJson(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }) },
    }, res => {
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
  const { status, body } = await requestJson("POST", "/api/auth/login", {
    email: "claudeagent@localhost", password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nDefault export (no ?fields=) includes every registered field");
    {
      const r = await requestRaw("GET", "/api/export/shipments.csv", token);
      assert("returns 200", r.status === 200);
      const header = r.text.split("\n")[0];
      assert("includes new office field (EMO Office)", header.includes("EMO Office"));
      assert("includes new vessel field (Vessel IMO)", header.includes("Vessel IMO"));
      assert("includes new contract fields", header.includes("Contract Valid From") && header.includes("Contract Valid To"));
      assert("includes new financial fields", header.includes("Declared Value"));
      assert("includes new party field (Notify Party)", header.includes("Notify Party"));
    }

    console.log("\nCustom minimal selection — mandatory fields force-included even when not requested");
    {
      const r = await requestRaw("GET", "/api/export/shipments.csv?fields=carrierCode,vessel", token);
      assert("returns 200", r.status === 200);
      const cols = r.text.split("\n")[0].split(",");
      assert("Shipment ID forced in", cols.includes("Shipment ID"));
      assert("POL forced in", cols.includes("POL"));
      assert("POD forced in", cols.includes("POD"));
      assert("ETD / ATD forced in", cols.includes("ETD / ATD"));
      assert("ETA / ATA forced in", cols.includes("ETA / ATA"));
      assert("Carrier (requested) present", cols.includes("Carrier"));
      assert("Vessel (requested) present", cols.includes("Vessel"));
      assert("exactly 7 columns (5 mandatory + 2 requested)", cols.length === 7, `got ${cols.length}: ${cols.join("|")}`);
      assert("a field never requested (Status) is absent", !cols.includes("Status"));
    }

    console.log("\nRequesting only mandatory fields returns exactly those 5, in registry order");
    {
      const r = await requestRaw("GET", "/api/export/shipments.csv?fields=id,pol,pod,etd,eta", token);
      const cols = r.text.split("\n")[0].split(",");
      assert("exactly 5 columns", cols.length === 5, cols.join("|"));
      assert("order is Shipment ID, POL, POD, ETD/ATD, ETA/ATA", cols.join(",") === "Shipment ID,POL,POD,ETD / ATD,ETA / ATA", cols.join(","));
    }

    console.log("\nEmpty ?fields= behaves the same as omitting it (defaults to everything)");
    {
      const r = await requestRaw("GET", "/api/export/shipments.csv?fields=", token);
      const cols = r.text.split("\n")[0].split(",");
      assert("returns the full field set, not zero columns", cols.length > 30, `got ${cols.length}`);
    }

    console.log("\n──────────────────────────────────────────────────");
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
