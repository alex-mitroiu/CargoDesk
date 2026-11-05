/**
 * Contract search by routing term: carrier haulage judged on location AND type (agreed 2026-11-05)
 *
 * The routing term comes from the first and last location on both sides. A shipment the carrier picks
 * up at a Door (deriveHaulageNeeds → pkuLocType) needs a contract line whose origin haulage is a Door,
 * covering that location; a line left at "Terminal" is a terminal pick-up. A shipment with no carrier
 * haulage matches on POL/POD alone, whatever the line offers. Schedule Search's DR / CY terms filter
 * the same way (GET /api/contracts), and a Lane Steering line can allow linked ports for its options.
 * Covers GET /api/contracts/match, GET /api/contracts (Schedule Search) and GET /api/where-to-book.
 *
 * Usage:
 *   node tests/contract-haulage-types.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
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

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost", password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

const qs = o => new URLSearchParams(o).toString();
// Well clear of real data, like the other steering tests (CLAUDE.md): validity and every date in 2028.
const VALID = { validFrom: "2028-01-01", validTo: "2028-12-31" }, DATE = "2028-11-15";

(async () => {
  const contracts = [], cleanup = [];
  let token;
  try {
    console.log("Logging in…");
    token = await login();
    console.log("  ✓ Logged in");
    const stamp = Date.now();
    const contract = async (number, leg) => {
      const r = await request("POST", "/api/contracts", { contractNumber: number, carrierCode: "HLCU", status: "Active", ...VALID,
        legs: [{ pol: "NLRTM", pod: "USNYC", ...leg }], rates: [{ serviceCode: "OF", amount: 900, currency: "USD", unit: "per_container" }] }, token);
      if (r.status !== 201) throw new Error(`Contract create failed (${r.status}): ${JSON.stringify(r.body)}`);
      contracts.push(r.body.id);
      return r.body;
    };
    // DR-CY: the carrier picks up at a door in NLAMS and delivers to a container yard in USCHI.
    const drcy = await contract(`HAULTYPE-DRCY-${stamp}`, { polCarrierHaulage: true, polLocType: "Door", polHaulageLocations: "NLAMS",
      podCarrierHaulage: true, podLocType: "Container Yard", podHaulageLocations: "USCHI" });
    // Carrier haulage at origin left at the default "Terminal": a terminal pick-up.
    const terminal = await contract(`HAULTYPE-TER-${stamp}`, { polCarrierHaulage: true, polLocType: "Terminal", polHaulageLocations: "NLAMS" });
    const ids = new Set([drcy.id, terminal.id]);
    const match = async extra => {
      const r = await request("GET", `/api/contracts/match?${qs({ pol: "NLRTM", pod: "USNYC", crd: DATE, ...extra })}`, null, token);
      return new Set((Array.isArray(r.body) ? r.body : []).map(m => m.id).filter(id => ids.has(id)));
    };
    const pku = (location, type) => ({ needsPolHaulage: "1", pkuLocation: location, pkuLocType: type });
    const del = (location, type) => ({ needsPodHaulage: "1", delLocation: location, delLocType: type });

    console.log("\nShipment DR-CY: NLAMS (Door) → NLRTM → USNYC → USCHI (CY)");
    let m = await match({ ...pku("NLAMS", "Door"), ...del("USCHI", "Container Yard") });
    assert("the DR-CY line matches", m.has(drcy.id));
    assert("the terminal pick-up line doesn't (no delivery haulage, and the wrong type)", !m.has(terminal.id));
    m = await match({ ...pku("NLAMS", "Container Yard"), ...del("USCHI", "Container Yard") });
    assert("a CY pick-up doesn't match the line's door pick-up", !m.has(drcy.id));
    m = await match({ ...pku("NLAMS", "Door"), ...del("USCHI", "Door") });
    assert("a door delivery doesn't match the line's CY delivery", !m.has(drcy.id));
    m = await match({ ...pku("DEBER", "Door"), ...del("USCHI", "Container Yard") });
    assert("a door pick-up the line doesn't list (DEBER) doesn't match", !m.has(drcy.id));

    console.log("\nNo carrier haulage on the shipment: POL and POD alone");
    m = await match({});
    assert("both lines match a port-to-port shipment", m.has(drcy.id) && m.has(terminal.id), JSON.stringify([...m]));

    console.log("\nA line left at Terminal is a terminal pick-up");
    m = await match(pku("NLAMS", "Terminal"));
    assert("a terminal pick-up in NLAMS matches it", m.has(terminal.id));
    m = await match(pku("NLAMS", "Door"));
    assert("a door pick-up doesn't", !m.has(terminal.id));
    m = await match({ needsPolHaulage: "1", pkuLocation: "NLAMS" });
    assert("a search that states no type judges none (both lines with origin haulage match)", m.has(drcy.id) && m.has(terminal.id));

    console.log("\nSchedule Search (GET /api/contracts): DR and CY ends are told apart");
    const search = async extra => {
      const r = await request("GET", `/api/contracts?${qs({ pol: "NLRTM", pod: "USNYC", search: `HAULTYPE-`, status: "Active", ...extra })}`, null, token);
      return new Set((r.body.results || []).map(c => c.id).filter(id => ids.has(id)));
    };
    let s = await search({ routingTerm: "D2CY" });
    assert("DR-CY finds the DR-CY contract", s.has(drcy.id) && !s.has(terminal.id), JSON.stringify([...s]));
    s = await search({ routingTerm: "CY2CY" });
    assert("CY-CY doesn't", !s.has(drcy.id));
    s = await search({ routingTerm: "D2P" });
    assert("DR-PT doesn't (the contract also delivers), nor the terminal pick-up", !s.has(drcy.id) && !s.has(terminal.id));
    s = await search({ routingTerm: "D2CY", polOrigin: "NLAMS" });
    assert("DR-CY from NLAMS finds it", s.has(drcy.id));
    s = await search({ routingTerm: "D2CY", polOrigin: "DEBER" });
    assert("DR-CY from DEBER doesn't (not on its pick-up list)", !s.has(drcy.id));
    s = await search({ routingTerm: "P2P" });
    assert("PT-PT leaves out contracts with carrier haulage, as before", !s.has(drcy.id) && !s.has(terminal.id));

    console.log("\nLane Steering: the line's own \"allow linked ports\"");
    const plain = await contract(`HAULTYPE-PLAIN-${stamp}`, {});
    const link = await request("POST", "/api/linked-ports", { primaryUnlocode: "NLRTM", linkedUnlocode: "NLMOE", note: "contract-haulage-types test" }, token);
    if (link.status === 201) cleanup.push(() => request("DELETE", `/api/linked-ports/${link.body.id}`, null, token));
    else if (!/already exists/i.test(link.body?.error || "")) throw new Error(`Linked port create failed (${link.status}): ${JSON.stringify(link.body)}`);
    const where = async () => (await request("GET", `/api/where-to-book?${qs({ pol: "NLMOE", pod: "USNYC", etd: DATE, teu: "2" })}`, null, token)).body;
    const lanes = await where();
    if (!lanes.originLane || !lanes.destLane) throw new Error(`No trade lanes for NLMOE → USNYC: ${JSON.stringify(lanes)}`);
    const steering = await request("POST", "/api/lane-steerings", { originLane: lanes.originLane, destLane: lanes.destLane,
      validFrom: "2028-11-01", validTo: "2028-11-30", autoSwitch: false, allowLinkedPorts: false, note: "contract-haulage-types test",
      options: [{ carrierCode: "HLCU", contractId: plain.id }] }, token);
    if (steering.status !== 201) throw new Error(`Steering create failed (${steering.status}): ${JSON.stringify(steering.body)}`);
    cleanup.unshift(() => request("DELETE", `/api/lane-steerings/${steering.body.id}`, null, token));
    assert("a new steering line doesn't allow linked ports", steering.body.allowLinkedPorts === false);
    let option = (await where()).options?.find(o => o.contractId === plain.id);
    assert("switched off: NLMOE isn't covered by a NLRTM line that takes only its own ports", option?.status === "skipped" && /doesn't cover/.test(option.reason || ""),
      JSON.stringify(option));
    const on = await request("PUT", `/api/lane-steerings/${steering.body.id}`, { ...steering.body, allowLinkedPorts: true,
      options: [{ carrierCode: "HLCU", contractId: plain.id }] }, token);
    assert("the switch saves", on.status === 200 && on.body.allowLinkedPorts === true, JSON.stringify(on.body));
    option = (await where()).options?.find(o => o.contractId === plain.id);
    assert("switched on: the option takes the NLMOE shipment through the linked port", option && option.status !== "skipped", JSON.stringify(option));
    const plainMatch = await request("GET", `/api/contracts/match?${qs({ pol: "NLMOE", pod: "USNYC", crd: DATE })}`, null, token);
    assert("the plain contract search still takes the line's own ports only", !(plainMatch.body || []).some(c => c.id === plain.id));
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    for (const undo of cleanup) await undo().catch(() => {});
    for (const id of contracts) await request("DELETE", `/api/contracts/${id}`, null, token).catch(() => {});
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
