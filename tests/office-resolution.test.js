/**
 * EMO/IMO auto-resolution (decided 2026-11-06, mockup f7b10beb)
 *
 * A new shipment's managing offices come from one rule (lib/office-resolution.js): an active office of
 * the department at the port (EMO: an SE office at the POL; IMO: an SI office at the POD), otherwise one
 * in the port's country; a preferred office (your own) only breaks a tie; several or none means the user
 * chooses. The rule is used by GET /api/offices/resolve (the New Shipment form's lookups), by
 * POST /api/shipments for a side sent empty, and by quote conversion. Covers the rule itself, then the
 * three server paths, which must all agree with the resolve endpoint.
 *
 * Usage:
 *   node tests/office-resolution.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { createRequire } from "node:module";
import { ensureOffices } from "./helpers/offices.mjs";

const require = createRequire(import.meta.url);
const { resolveManagingOffice, resolveManagingOffices } = require("../lib/office-resolution.js");

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

const futureDate = days => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

// ── The rule on its own (no server) ─────────────────────────────────────────────────────────────
function ruleTests() {
  console.log("The rule: port, then country; your office only breaks a tie");
  const rows = [
    { id: "A", code: "NL-NLRTM-SE", name: "Rotterdam Export", department: "SE", unlocode: "NLRTM", country_code: "NL", is_active: true },
    { id: "B", code: "NL-NLAMS-SE", name: "Amsterdam Export 1", department: "SE", unlocode: "NLAMS", country_code: "NL", is_active: true },
    { id: "C", code: "NL-NLAMS-SE2", name: "Amsterdam Export 2", department: "SE", unlocode: "NLAMS", country_code: "NL", is_active: true },
    { id: "D", code: "US-USNYC-SI", name: "New York Import", department: "SI", unlocode: "USNYC", country_code: "US", is_active: true },
    { id: "E", code: "DE-DEHAM-SE", name: "Hamburg Export (closed)", department: "SE", unlocode: "DEHAM", country_code: "DE", is_active: false },
    { id: "F", code: "NL-NLRTM-SI", name: "Rotterdam Import", department: "SI", unlocode: "NLRTM", country_code: "NL", is_active: true },
  ];
  const r = (dept, port, prefer, countryNames) => resolveManagingOffice({ offices: rows, dept, port, prefer, countryNames });

  const atPort = r("SE", "NLRTM");
  assert("one export office at the port: picked by port", atPort.status === "auto" && atPort.officeId === "A" && atPort.how === "port", JSON.stringify(atPort));
  assert("…and the reason names the port", atPort.reason === "At the port of loading, NLRTM", atPort.reason);

  const two = r("SE", "NLAMS");
  assert("two at the port, no preference: the user chooses", two.status === "several" && two.officeId === null, JSON.stringify(two));
  assert("…both are listed as fitting", JSON.stringify(two.fitIds) === JSON.stringify(["B", "C"]), JSON.stringify(two.fitIds));
  const tie = r("SE", "NLAMS", ["X", "C"]);
  assert("your office among them breaks the tie", tie.status === "auto" && tie.officeId === "C" && /your office/.test(tie.reason), JSON.stringify(tie));
  const notMine = r("SE", "NLAMS", ["A"]);
  assert("your office elsewhere doesn't break it (ports come first)", notMine.status === "several", JSON.stringify(notMine));

  const byCountry = r("SE", "NLZZZ");
  assert("no office at the port: the country's offices fit", byCountry.status === "several" && byCountry.how === "country" && byCountry.fitIds.length === 3, JSON.stringify(byCountry));
  const byCountryMine = r("SE", "NLZZZ", "A", { NL: "Netherlands" });
  assert("…your office breaks that tie too", byCountryMine.status === "auto" && byCountryMine.officeId === "A", JSON.stringify(byCountryMine));
  assert("…with the country named", byCountryMine.reason === "Your office, one of 3 in Netherlands (NL)", byCountryMine.reason);

  const onlyOne = r("SI", "USLAX", [], { US: "United States" });
  assert("the only import office in the country is picked", onlyOne.status === "auto" && onlyOne.officeId === "D" && onlyOne.how === "country", JSON.stringify(onlyOne));
  assert("…and says so", onlyOne.reason === "The only import office in United States (US)", onlyOne.reason);

  const inactive = r("SE", "DEHAM");
  assert("an inactive office never fits", inactive.status === "none" && inactive.fitIds.length === 0, JSON.stringify(inactive));
  assert("…and the reason says nothing fits", /^No export office at DEHAM/.test(inactive.reason), inactive.reason);

  const dept = r("SI", "NLRTM");
  assert("the department decides: an import office for the IMO", dept.officeId === "F", JSON.stringify(dept));
  const wait = r("SE", "");
  assert("no port yet: wait", wait.status === "wait" && wait.officeId === null, JSON.stringify(wait));

  const mapped = rows.map(o => ({ id: o.id, code: o.code, name: o.name, department: o.department, unlocode: o.unlocode, countryCode: o.country_code, isActive: o.is_active }));
  const both = resolveManagingOffices({ offices: mapped, pol: "nlrtm", pod: "usnyc" });
  assert("mapped offices and lower-case ports work the same", both.emo.officeId === "A" && both.imo.officeId === "D", JSON.stringify(both));
}

(async () => {
  const cleanup = { shipments: [], quotes: [] };
  let token;
  try {
    ruleTests();

    console.log("\nLogging in…");
    token = await login();
    console.log("  ✓ Logged in");
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const offices = (await request("GET", "/api/offices", null, token)).body;
    const emoOffice = offices.find(o => o.id === emoOfficeId);
    const imoOffice = offices.find(o => o.id === imoOfficeId);

    console.log("\nGET /api/offices/resolve");
    const none = await request("GET", "/api/offices/resolve", null, token);
    assert("no ports: both sides wait", none.status === 200 && none.body.emo.status === "wait" && none.body.imo.status === "wait", JSON.stringify(none.body));
    const route = { pol: emoOffice.unlocode, pod: imoOffice.unlocode };
    const res = await request("GET", `/api/offices/resolve?pol=${route.pol}&pod=${route.pod}`, null, token);
    assert("the export office fits its own port", res.body.emo.fitIds.includes(emoOfficeId), JSON.stringify(res.body.emo));
    assert("the import office fits its own port", res.body.imo.fitIds.includes(imoOfficeId), JSON.stringify(res.body.imo));
    // A port in a country with no offices of ours (Antarctica): nothing fits.
    const empty = await request("GET", "/api/offices/resolve?pol=AQXXX&pod=AQXXX", null, token);
    assert("a country with no offices: none on both sides", empty.body.emo.status === "none" && empty.body.imo.status === "none", JSON.stringify(empty.body));

    console.log("\nPOST /api/shipments fills a side sent empty, with the same answer");
    const base = { carrierCode: "MAEU", status: "Active", contractType: "SPOT", incoterm: "FOB", etd: futureDate(10), eta: futureDate(24) };
    const filled = await request("POST", "/api/shipments", { ...base, ...route }, token);
    if (res.body.emo.officeId && res.body.imo.officeId) {
      assert("created with no offices sent (201)", filled.status === 201, JSON.stringify(filled.body));
      if (filled.status === 201) cleanup.shipments.push(filled.body.id);
      assert("EMO is the rule's", filled.body.emoOfficeId === res.body.emo.officeId, `${filled.body.emoOfficeId} vs ${res.body.emo.officeId}`);
      assert("IMO is the rule's", filled.body.imoOfficeId === res.body.imo.officeId, `${filled.body.imoOfficeId} vs ${res.body.imo.officeId}`);
    } else {
      assert("the rule can't decide this route here, so creation without offices is refused (400)", filled.status === 400, JSON.stringify(filled.body));
      if (filled.status === 201) cleanup.shipments.push(filled.body.id);
    }
    const refused = await request("POST", "/api/shipments", { ...base, pol: "AQXXX", pod: route.pod }, token);
    assert("nothing fits the POL and no EMO sent: refused (400)", refused.status === 400, JSON.stringify(refused.body));
    assert("…saying which side and why", /emoOfficeId required \(No export office at AQXXX/.test(refused.body?.error || ""), JSON.stringify(refused.body));
    const kept = await request("POST", "/api/shipments", { ...base, pol: "AQXXX", pod: "AQXXX", emoOfficeId, imoOfficeId }, token);
    assert("offices sent by the caller are kept, whatever the rule says (201)", kept.status === 201 && kept.body.emoOfficeId === emoOfficeId && kept.body.imoOfficeId === imoOfficeId, JSON.stringify(kept.body));
    if (kept.status === 201) cleanup.shipments.push(kept.body.id);
    const half = await request("POST", "/api/shipments", { ...base, ...route, emoOfficeId }, token);
    if (res.body.imo.officeId) {
      assert("only the empty side is filled", half.status === 201 && half.body.emoOfficeId === emoOfficeId && half.body.imoOfficeId === res.body.imo.officeId, JSON.stringify(half.body));
      if (half.status === 201) cleanup.shipments.push(half.body.id);
    }

    console.log("\nQuote conversion gets both offices");
    const convertQuote = async (pol, pod) => {
      const q = await request("POST", "/api/quotes", {
        customerName: "Office Rule Freight BV", pol, pod, carrierCode: "MAEU", validUntil: futureDate(7),
        lines: [{ serviceCode: "OF", description: "Ocean Freight", quantity: "1", rate: "1800", currency: "USD" }],
      }, token);
      if (q.status !== 201) throw new Error(`Quote create failed (${q.status}): ${JSON.stringify(q.body)}`);
      cleanup.quotes.push(q.body.id);
      await request("POST", `/api/quotes/${q.body.id}/send`, {}, token);
      await request("POST", `/api/quotes/${q.body.id}/accept`, {}, token);
      const c = await request("POST", `/api/quotes/${q.body.id}/convert`, {}, token);
      if (c.status === 200) cleanup.shipments.push(c.body.shipmentId);
      return c;
    };
    const conv = await convertQuote(route.pol, route.pod);
    assert("converted (200)", conv.status === 200, JSON.stringify(conv.body));
    assert("EMO from the rule", (conv.body.shipment?.emoOfficeId || null) === (res.body.emo.officeId || null), JSON.stringify(conv.body.shipment));
    assert("IMO from the rule", (conv.body.shipment?.imoOfficeId || null) === (res.body.imo.officeId || null), JSON.stringify(conv.body.shipment));
    assert("a warning only when a side stayed empty", !!conv.body.officeWarning === !(res.body.emo.officeId && res.body.imo.officeId), conv.body.officeWarning);
    const convNone = await convertQuote("AQXXX", route.pod);
    assert("a POL nothing fits still converts (200)", convNone.status === 200, JSON.stringify(convNone.body));
    assert("…with the EMO left empty", !convNone.body.shipment?.emoOfficeId, JSON.stringify(convNone.body.shipment));
    assert("…and a warning that says what to do", /No export managing office .*Reassign Office/.test(convNone.body.officeWarning || ""), convNone.body.officeWarning);
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    if (token) {
      for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
      for (const id of cleanup.quotes) await request("DELETE", `/api/quotes/${id}`, null, token);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
