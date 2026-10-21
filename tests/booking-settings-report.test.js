/**
 * Booking escalation settings and the Carrier Responses report (Epic TKT-ASIYFL, Story 7 TKT-SXO1QS).
 *   - App Settings → Bookings: the default escalation group, the no-answer time, what counts as
 *     "accepted with changes" and the Trade level are company policy — admin-only, and each value is
 *     checked;
 *   - Reports → Carrier Responses: per carrier, the booking requests sent in a period and what the carrier
 *     did with them — decided (confirmed, confirmed with changes, rejected, update requested), no answer
 *     after the no-answer time, waiting inside it — counted per request, with the median time to a
 *     decision; same access as the other reports.
 * The report figures are checked as the difference this test makes, so other data in the period
 * doesn't matter.
 *
 * Usage:
 *   node tests/booking-settings-report.test.js
 *
 * Prerequisites:
 *   - npm run dev (Express :3001), not in production (the built-in DCSA carrier plays OOLU)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { ensureOffices } from "./helpers/offices.mjs";
import { carrierActs, waitForCarrierReference, addContainer } from "./helpers/dcsa-sim.mjs";

const BASE = "http://localhost:3001";
let passed = 0, failed = 0;

async function request(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body !== undefined && body !== null && { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
}
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
const list = b => (Array.isArray(b) ? b : (b?.results ?? []));
const today = new Date().toISOString().slice(0, 10);
const CARRIER = "OOLU";

(async () => {
  const cleanup = { shipments: [], customers: [], users: [] };
  let token, saved = null;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    saved = (await request("GET", "/api/settings", null, token)).body;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    const makeUser = async (key, roles, officeId) => {
      const email = `bsr-${key}-${rand.toLowerCase()}@example.com`;
      await request("POST", "/api/users", { email, name: `${key} ${rand}`, roles, password: "BsrFixture!2026Zq" }, token);
      cleanup.users.push(email);
      const id = list((await request("GET", "/api/users", null, token)).body).find(u => u.email === email)?.id;
      if (officeId) await request("POST", `/api/users/${id}/offices`, { officeId }, token);
      return (await request("POST", "/api/auth/login", { email, password: "BsrFixture!2026Zq" })).body.token;
    };
    const occBk = await makeUser("occbk", ["occ_bk"], emoOfficeId);
    const operator = await makeUser("operator", ["operator"], emoOfficeId);
    const occAy = await makeUser("occay", ["occ_ay"], emoOfficeId);
    const trade = await makeUser("trade", ["trade_manager"]);

    console.log("App Settings → Bookings is admin-only, and checked");
    assert("OCC/BK can't change them (403)", (await request("PUT", "/api/settings", { booking_no_answer_hours: "4" }, occBk)).status === 403);
    assert("an operator can't either (403)", (await request("PUT", "/api/settings", { booking_escalation_default_group: "ccl_co" }, operator)).status === 403);
    const bad = [
      [{ booking_escalation_default_group: "trade_ay" }, "OCC/AY"],
      [{ booking_no_answer_hours: "0" }, "above 0"],
      [{ booking_no_answer_hours: "two" }, "above 0"],
      [{ booking_no_answer_hours: "200" }, "168"],
      [{ booking_escalation_trade_level: "maybe" }, "on \\(true\\)"],
      [{ booking_change_rules: "not json" }, "toleranceDays"],
      [{ booking_change_rules: JSON.stringify({ vessel: true, dates: true, equipment: true, toleranceDays: 1 }) }, "toleranceDays"],
      [{ booking_change_rules: JSON.stringify({ vessel: true, dates: true, equipment: true, ports: true, toleranceDays: 45 }) }, "0–30"],
    ];
    for (const [body, msg] of bad) {
      const r = await request("PUT", "/api/settings", body, token);
      assert(`refused: ${JSON.stringify(body).slice(0, 70)} (400)`, r.status === 400 && new RegExp(msg).test(r.body?.error || ""), JSON.stringify(r.body));
    }
    const good = { booking_escalation_default_group: "ccl_co", booking_no_answer_hours: "3.5", booking_escalation_trade_level: "false",
      booking_change_rules: JSON.stringify({ vessel: true, dates: false, toleranceDays: 2, equipment: true, ports: false }) };
    let r = await request("PUT", "/api/settings", good, token);
    const now = (await request("GET", "/api/settings", null, token)).body;
    assert("admin sets all four (200), and they read back", r.status === 200 && Object.entries(good).every(([k, v]) => now[k] === v), JSON.stringify(Object.keys(good).map(k => now[k])));
    await request("PUT", "/api/settings", {
      booking_escalation_default_group: saved.booking_escalation_default_group, booking_no_answer_hours: saved.booking_no_answer_hours,
      booking_escalation_trade_level: saved.booking_escalation_trade_level, booking_change_rules: saved.booking_change_rules }, token);

    console.log("\nReports → Carrier Responses");
    assert("OCC/AY can't open it (403)", (await request("GET", `/api/reports/carrier-responses?from=${today}&to=${today}`, null, occAy)).status === 403);
    const report = async (who = token, lane = "") => (await request("GET", `/api/reports/carrier-responses?from=${today}&to=${today}${lane ? `&lane=${encodeURIComponent(lane)}` : ""}`, null, who)).body;
    const zero = { sent: 0, decided: 0, noAnswer: 0, waiting: 0, confirmed: 0, changed: 0, rejected: 0, updateRequested: 0 };
    const row = b => ({ ...zero, ...(b?.carriers?.find(c => c.carrierCode === CARRIER) || {}) });
    const before = row(await report());

    const shipper = (await request("POST", "/api/customers", { companyName: `Report Shipper ${rand} BV` }, token)).body;
    const consignee = (await request("POST", "/api/customers", { companyName: `Report Consignee ${rand} Inc` }, token)).body;
    cleanup.customers.push(shipper.id, consignee.id);
    const ship = async () => {
      const s = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: CARRIER, status: "Active", contractType: "SPOT", contractRef: `SPOT-RPT-${rand}`,
        etd: "2026-11-16", eta: "2026-11-30", incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
        principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId,
      }, token);
      cleanup.shipments.push(s.body.id);
      await addContainer(request, token, s.body.id);
      await request("POST", `/api/shipments/${s.body.id}/legs`, { legType: "SEA", movementType: "SEA", pol: "NLRTM", pod: "USNYC",
        etd: "2026-11-16", eta: "2026-11-30", carrierCode: CARRIER, vessel: "OOCL REPORT", vesselImo: "9999995", voyage: "0RP1W" }, token);
      await request("POST", `/api/shipments/${s.body.id}/edi-messages/booking-request`, {}, token);
      await waitForCarrierReference(request, token, s.body.id);
      return s.body.id;
    };
    await carrierActs(request, token, await ship(), "confirm");
    await carrierActs(request, token, await ship(), "confirmWithChanges");
    await carrierActs(request, token, await ship(), "reject", "No space");
    const asked = await ship();
    await carrierActs(request, token, asked, "requestUpdate", "Send the VGM first");
    await ship(); // waiting: no decision yet, inside the no-answer time

    let after = row(await report());
    const d = k => after[k] - before[k];
    assert("five requests sent", d("sent") === 5, JSON.stringify({ before, after }));
    assert("four decided: confirmed, with changes, rejected, update requested", d("decided") === 4 && d("confirmed") === 2 && d("changed") === 1 && d("rejected") === 1 && d("updateRequested") === 1,
      JSON.stringify({ decided: d("decided"), confirmed: d("confirmed"), changed: d("changed"), rejected: d("rejected"), update: d("updateRequested") }));
    assert("one waiting, inside the no-answer time — not counted as no answer", d("waiting") === 1 && d("noAnswer") === 0, JSON.stringify({ waiting: d("waiting"), noAnswer: d("noAnswer") }));
    assert("a median time to a decision, in seconds", Number.isFinite(after.medianSeconds) && after.medianSeconds >= 0, String(after.medianSeconds));
    const full = await report();
    assert("an All carriers total, the lanes to filter by, and the no-answer time", full.total?.carrierName === "All carriers" && full.total.sent >= after.sent
      && full.lanes.includes("EU-N → NAM") && full.noAnswerHours > 0, JSON.stringify({ total: full.total?.sent, lanes: full.lanes, h: full.noAnswerHours }));

    await request("PUT", "/api/settings", { booking_no_answer_hours: "0.0002" }, token);
    await sleep(1200);
    after = row(await report());
    assert("past the no-answer time, the waiting one counts as no answer", after.noAnswer - before.noAnswer === 1 && after.waiting === before.waiting, JSON.stringify(after));
    await request("PUT", "/api/settings", { booking_no_answer_hours: saved.booking_no_answer_hours }, token);

    const other = row(await report(token, "NAM → EU-N"));
    assert("filtered to another lane, none of these count", other.sent <= before.sent, JSON.stringify(other));
    const forTrade = await report(trade);
    assert("a Trade Manager with no scope configured gets the report, narrowed to what they may see", Array.isArray(forTrade?.carriers), JSON.stringify(forTrade).slice(0, 200));
  } catch (e) {
    console.error("Unexpected error:", e);
    failed++;
  } finally {
    if (saved) await request("PUT", "/api/settings", {
      booking_escalation_default_group: saved.booking_escalation_default_group ?? "occ_ay", booking_no_answer_hours: saved.booking_no_answer_hours ?? "2",
      booking_escalation_trade_level: saved.booking_escalation_trade_level ?? "true", booking_change_rules: saved.booking_change_rules }, token).catch(() => {});
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token).catch(() => {});
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token).catch(() => {});
    const users = list((await request("GET", "/api/users", null, token).catch(() => ({ body: [] }))).body);
    for (const email of cleanup.users) { const u = users.find(x => x.email === email); if (u) await request("DELETE", `/api/users/${u.id}`, null, token).catch(() => {}); }
  }
  console.log(`\n${"─".repeat(50)}\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
