/**
 * Classified-Location Customers — GPS-coordinate pickup/delivery
 *
 * Some customers' pickup/delivery sites are classified (military/government/restricted) and can
 * only ever be identified by GPS coordinates, never a UN/LOCODE. Covers customers.classified_location
 * + latitude/longitude, shipment_legs' new "GPS Coordinates" pol_loc_type/pod_loc_type value with
 * its own pol_latitude/pol_longitude/pod_latitude/pod_longitude columns, the syncShipmentFromLegs
 * SEA-leg fallback for shipment-level pol/pod, and the public share-token route's coordinate redaction.
 *
 * Usage:
 *   node tests/classified-locations.test.js
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

async function scratchShipment(token) {
  const res = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
  }, token);
  return res.body.id;
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nCustomer classified_location + lat/lng round-trip");
    const cust = await request("POST", "/api/customers", {
      companyName: "Test Classified Site Alpha",
      classifiedLocation: true, latitude: "52.3676", longitude: "4.9041",
    }, token);
    assert("customer created", cust.status === 201, JSON.stringify(cust.body));
    assert("classifiedLocation round-trips true", cust.body.classifiedLocation === true);
    assert("latitude round-trips", cust.body.latitude === 52.3676, cust.body.latitude);
    assert("longitude round-trips", cust.body.longitude === 4.9041, cust.body.longitude);

    console.log("\nOut-of-range coordinates rejected");
    const badLat = await request("POST", "/api/customers", {
      companyName: "Test Bad Lat", classifiedLocation: true, latitude: "200", longitude: "4.9041",
    }, token);
    assert("latitude 200 rejected", badLat.status >= 400, JSON.stringify(badLat.body));
    const badLng = await request("POST", "/api/customers", {
      companyName: "Test Bad Lng", classifiedLocation: true, latitude: "52.3676", longitude: "-200",
    }, token);
    assert("longitude -200 rejected", badLng.status >= 400, JSON.stringify(badLng.body));

    console.log("\nUnchecking classifiedLocation force-clears stored coordinates server-side");
    const uncheck = await request("PUT", `/api/customers/${cust.body.id}`, {
      companyName: "Test Classified Site Alpha",
      classifiedLocation: false, latitude: "52.3676", longitude: "4.9041", // still sent, must be ignored
    }, token);
    assert("uncheck save returns 200", uncheck.status === 200, JSON.stringify(uncheck.body));
    assert("classifiedLocation is now false", uncheck.body.classifiedLocation === false);
    assert("latitude cleared despite being resent", uncheck.body.latitude === null, uncheck.body.latitude);
    assert("longitude cleared despite being resent", uncheck.body.longitude === null, uncheck.body.longitude);

    console.log("\nLeg — Pick-up in GPS Coordinates mode");
    const shipA = await scratchShipment(token);
    const pkuGps = await request("POST", `/api/shipments/${shipA}/legs`, {
      legType: "Pick-up", mot: "ROAD", polLocType: "GPS Coordinates",
      polLatitude: "35.1234", polLongitude: "-115.5678",
    }, token);
    assert("GPS Pick-up leg created", pkuGps.status === 201, JSON.stringify(pkuGps.body));
    assert("pol is blanked", pkuGps.body.pol === "", pkuGps.body.pol);
    assert("polLatitude round-trips", pkuGps.body.polLatitude === 35.1234, pkuGps.body.polLatitude);
    assert("polLongitude round-trips", pkuGps.body.polLongitude === -115.5678, pkuGps.body.polLongitude);

    console.log("\nSwitching a GPS leg back to a normal loc-type clears its coordinates server-side");
    const backToTerminal = await request("PUT", `/api/shipments/${shipA}/legs/${pkuGps.body.id}`, {
      legType: "Pick-up", mot: "ROAD", polLocType: "Terminal", pol: "NLRTM",
      polLatitude: "35.1234", polLongitude: "-115.5678", // still sent, must be ignored
    }, token);
    assert("switch-back returns 200", backToTerminal.status === 200, JSON.stringify(backToTerminal.body));
    assert("polLatitude cleared despite being resent", backToTerminal.body.polLatitude === null, backToTerminal.body.polLatitude);
    assert("polLongitude cleared despite being resent", backToTerminal.body.polLongitude === null, backToTerminal.body.polLongitude);
    assert("pol now holds the real UN/LOCODE", backToTerminal.body.pol === "NLRTM");

    console.log("\nA SEA leg cannot use GPS Coordinates");
    const seaGpsRejected = await request("POST", `/api/shipments/${shipA}/legs`, {
      legType: "SEA", mot: "SEA", polLocType: "GPS Coordinates", polLatitude: "1", polLongitude: "1",
    }, token);
    assert("SEA + GPS Coordinates rejected", seaGpsRejected.status >= 400, JSON.stringify(seaGpsRejected.body));

    console.log("\nOut-of-range leg coordinates rejected");
    const legBadLat = await request("POST", `/api/shipments/${shipA}/legs`, {
      legType: "Delivery", mot: "ROAD", podLocType: "GPS Coordinates", podLatitude: "-200", podLongitude: "10",
    }, token);
    assert("leg latitude -200 rejected", legBadLat.status >= 400, JSON.stringify(legBadLat.body));

    await request("DELETE", `/api/shipments/${shipA}`, null, token);

    console.log("\nsyncShipmentFromLegs — Pick-up(GPS) → SEA → Delivery(GPS) still resolves shipment.pol/pod to the real SEA ports");
    const shipB = await scratchShipment(token);
    const pkuLeg = await request("POST", `/api/shipments/${shipB}/legs`, {
      legType: "Pick-up", mot: "ROAD", legOrder: 0,
      polLocType: "GPS Coordinates", polLatitude: "35.1", polLongitude: "-115.5",
    }, token);
    assert("Pick-up(GPS) leg created", pkuLeg.status === 201, JSON.stringify(pkuLeg.body));
    const seaLeg = await request("POST", `/api/shipments/${shipB}/legs`, {
      legType: "SEA", mot: "SEA", legOrder: 1, pol: "CNSHA", pod: "USSAV",
    }, token);
    assert("SEA leg created", seaLeg.status === 201, JSON.stringify(seaLeg.body));
    const delLeg = await request("POST", `/api/shipments/${shipB}/legs`, {
      legType: "Delivery", mot: "ROAD", legOrder: 2,
      podLocType: "GPS Coordinates", podLatitude: "40.2", podLongitude: "-74.3",
    }, token);
    assert("Delivery(GPS) leg created", delLeg.status === 201, JSON.stringify(delLeg.body));

    const shipBAfter = await request("GET", `/api/shipments/${shipB}`, null, token);
    assert("shipment.pol falls back to the SEA leg's real POL, not blank", shipBAfter.body.pol === "CNSHA", shipBAfter.body.pol);
    assert("shipment.pod falls back to the SEA leg's real POD, not blank", shipBAfter.body.pod === "USSAV", shipBAfter.body.pod);

    console.log("\nPublic share-token payload redacts GPS coordinates but keeps the loc-type label");
    const shareToken = await request("POST", `/api/shipments/${shipB}/share-token`, null, token);
    assert("share-token created", shareToken.status === 200, JSON.stringify(shareToken.body));
    const publicView = await request("GET", `/api/share/${shareToken.body.token}`, null, null);
    assert("public tracking view returns 200", publicView.status === 200, JSON.stringify(publicView.body));
    const publicPkuLeg = publicView.body.legs.find(l => l.id === pkuLeg.body.id);
    assert("public leg keeps its polLocType label", publicPkuLeg?.polLocType === "GPS Coordinates", JSON.stringify(publicPkuLeg));
    assert("public leg does NOT include polLatitude", !("polLatitude" in (publicPkuLeg || {})), JSON.stringify(publicPkuLeg));
    assert("public leg does NOT include polLongitude", !("polLongitude" in (publicPkuLeg || {})), JSON.stringify(publicPkuLeg));

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipB}`, null, token);
    await request("DELETE", `/api/customers/${cust.body.id}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
