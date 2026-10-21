/**
 * Weekly space (Epic TKT-KFGL81, Story 1 TKT-1A1YP0; scope doc https://claude.ai/artifact/X9n2jk6TyGFKfbE7GsWKCy,
 * decided 2026-10-21). A space configuration holds its TEU per period (as always) or per ISO week:
 *   - weekly: that TEU every Monday-to-Sunday week of its period, nothing carried over; a shipment counts in
 *     the week of its ETD, else of its cargo-ready date;
 *   - the list shows a weekly configuration's figures for one week (today's, or ?date=), plus every week of
 *     its period and the period's totals; /match shows the ETD's week;
 *   - the Space Exceeded badge measures a shipment only against the others in its week, and moving its ETD
 *     (a roll) moves it to its new week; switching the basis recomputes the pool;
 *   - the minimum commitment stays one figure for the whole period (TEU per week × the weeks);
 *   - space held per period is unchanged.
 *
 * Usage:
 *   node tests/weekly-space.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations (seeded MDM data)
 */

import { ensureOffices } from "./helpers/offices.mjs";

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

(async () => {
  const shipmentIds = [], customerIds = [], allocIds = [];
  let token, contractId;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);

    console.log("Scratch contract, Rotterdam → New York");
    const contract = await request("POST", "/api/contracts", {
      carrierCode: "MAEU", contractNumber: `WEEKLY-TEST-${Date.now()}`, status: "Active",
      validFrom: "2026-01-01", validTo: "2030-01-01", legs: [{ pol: "NLRTM", pod: "USNYC" }],
    }, token);
    contractId = contract.body.id;
    assert("contract created", contract.status === 201, JSON.stringify(contract.body));
    const routingId = contract.body.routings?.[0]?.id;
    // 2 Nov 2026 is the Monday of ISO week 45; 29 Nov the Sunday of week 48: four whole weeks.
    const config = (over = {}) => ({ contractId, routingIds: [routingId], allocatedTEU: 4, spaceBasis: "week",
      effectiveDate: "2026-11-02", endDate: "2026-11-29", ...over });

    console.log("\nThe basis and the minimum are checked");
    const bad = await request("POST", "/api/allocations", config({ spaceBasis: "month" }), token);
    assert("an unknown basis is refused (400)", bad.status === 400 && /period or week/.test(bad.body?.error || ""), JSON.stringify(bad.body));
    const tooHigh = await request("POST", "/api/allocations", config({ minimumTEU: 17 }), token);
    assert("a minimum above 4 TEU × 4 weeks = 16 is refused", tooHigh.status === 400 && /16 TEU/.test(tooHigh.body?.error || ""), JSON.stringify(tooHigh.body));
    if (tooHigh.body?.id) allocIds.push(tooHigh.body.id);

    const created = await request("POST", "/api/allocations", config({ minimumTEU: 16 }), token);
    const allocId = created.body?.id;
    if (allocId) allocIds.push(allocId);
    assert("4 TEU a week, with a 16 TEU minimum for the period, is accepted", created.status === 201, JSON.stringify(created.body));
    assert("it is held per week", created.body?.spaceBasis === "week");
    assert("its four weeks are listed, 45 to 48", JSON.stringify((created.body?.weeks || []).map(w => w.weekNumber)) === "[45,46,47,48]",
      JSON.stringify(created.body?.weeks));
    assert("the period's totals start at zero", created.body?.periodTotals?.pendingTEU === 0 && created.body?.periodTotals?.confirmedTEU === 0);

    const shipper = await request("POST", "/api/customers", { companyName: `Weekly Space Shipper ${Date.now()} BV` }, token);
    const consignee = await request("POST", "/api/customers", { companyName: `Weekly Space Consignee ${Date.now()} Inc` }, token);
    customerIds.push(shipper.body.id, consignee.body.id);
    // One 40' HC (2 TEU) each, booked on the weekly space, not sent to the carrier yet (pending).
    const newShipment = async (label, { etd = "", eta = "", cargoReadyDate = "" } = {}) => {
      const s = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractId,
        allocationId: allocId, contractRoutingId: routingId, etd, eta, cargoReadyDate, incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.body.id, shipperName: shipper.body.companyName,
        consigneeId: consignee.body.id, consigneeName: consignee.body.companyName,
        principalId: shipper.body.id, principalName: shipper.body.companyName,
        emoOfficeId, imoOfficeId,
      }, token);
      if (s.status !== 201) throw new Error(`${label}: ${s.status} ${JSON.stringify(s.body)}`);
      shipmentIds.push(s.body.id);
      await request("POST", "/api/containers", { shipmentId: s.body.id, containerNumber: `MSKU${String(Date.now()).slice(-7)}`,
        size: "40", type: "HC", hsCode: "940360", cargoDescription: "Flat-pack furniture", grossWeightKg: 9000, volumeCbm: 60 }, token);
      return s.body.id;
    };
    const badge = async id => (await request("GET", `/api/shipments/${id}`, null, token)).body.spaceBadge || "";
    const listed = async (date = "") => (await request("GET", `/api/allocations${date ? `?date=${date}` : ""}`, null, token)).body.find(a => a.id === allocId);
    const matched = async etd => (await request("GET", `/api/allocations/match?pol=NLRTM&pod=USNYC&etd=${etd}&principalId=${shipper.body.id}&commodityCode=9999`, null, token))
      .body.find(a => a.id === allocId);

    console.log("\nA and B sail in week 45, C in week 46, D has only a cargo-ready date in week 47");
    const A = await newShipment("A", { etd: "2026-11-04", eta: "2026-11-15" });
    const B = await newShipment("B", { etd: "2026-11-05", eta: "2026-11-16" });
    const C = await newShipment("C", { etd: "2026-11-12", eta: "2026-11-23" });
    const D = await newShipment("D", { cargoReadyDate: "2026-11-19" });

    const wk45 = await listed("2026-11-04");
    assert("the list for 4 Nov shows week 45", wk45?.week === "2026-11-02" && wk45?.weekNumber === 45, JSON.stringify({ week: wk45?.week, n: wk45?.weekNumber }));
    assert("week 45: A + B = 4 TEU pending, of 4 a week", wk45?.pendingTEU === 4 && wk45?.allocatedTEU === 4, JSON.stringify(wk45));
    const byWeek = Object.fromEntries((wk45?.weeks || []).map(w => [w.weekNumber, w.pendingTEU]));
    assert("each week counts its own shipments: 45 → 4, 46 → 2 (C), 47 → 2 (D by its cargo-ready date), 48 → 0",
      byWeek[45] === 4 && byWeek[46] === 2 && byWeek[47] === 2 && byWeek[48] === 0, JSON.stringify(byWeek));
    assert("the period's total is 8 TEU pending", wk45?.periodTotals?.pendingTEU === 8, JSON.stringify(wk45?.periodTotals));
    const early = await listed("2026-10-01"), late = await listed("2027-02-01");
    assert("a date before the period shows its first week, after it its last", early?.weekNumber === 45 && late?.weekNumber === 48,
      `${early?.weekNumber} / ${late?.weekNumber}`);

    const m46 = await matched("2026-11-12"), m45 = await matched("2026-11-04");
    assert("/match for a 12 Nov ETD shows week 46: 2 TEU pending", m46?.weekNumber === 46 && m46?.pendingTEU === 2, JSON.stringify(m46 && { n: m46.weekNumber, p: m46.pendingTEU }));
    assert("/match for a 4 Nov ETD shows week 45: 4 TEU pending", m45?.weekNumber === 45 && m45?.pendingTEU === 4, JSON.stringify(m45 && { n: m45.weekNumber, p: m45.pendingTEU }));

    console.log("\nThe badge compares a shipment only with its own week");
    assert("A and B share week 45 exactly (2 + 2 of 4): no badge", await badge(A) === "" && await badge(B) === "");
    assert("C has week 46 to itself: no badge (period space of 4 TEU would have flagged it)", await badge(C) === "");
    const E = await newShipment("E", { etd: "2026-11-06", eta: "2026-11-17" });
    assert("E makes week 45 6 TEU of 4: E is Space Exceeded", await badge(E) === "exceeded");
    assert("A and B, pending in the same week, are flagged too", await badge(A) === "exceeded" && await badge(B) === "exceeded");
    assert("C, in week 46, is not", await badge(C) === "");

    console.log("\nA roll moves E to week 48");
    const roll = await request("PUT", `/api/shipments/${E}`, { etd: "2026-11-25", eta: "2026-12-06" }, token);
    assert("E's ETD moved to 25 Nov", roll.status === 200 && String(roll.body?.etd || "").startsWith("2026-11-25"), JSON.stringify(roll.body?.etd));
    assert("E fits week 48 on its own", await badge(E) === "");
    assert("A and B fit week 45 again", await badge(A) === "" && await badge(B) === "");
    const after = await listed("2026-11-25");
    assert("week 48 now holds E's 2 TEU", after?.weekNumber === 48 && after?.pendingTEU === 2, JSON.stringify(after && { n: after.weekNumber, p: after.pendingTEU }));

    console.log("\nSwitching the basis recomputes the pool");
    const toPeriod = await request("PUT", `/api/allocations/${allocId}`, config({ minimumTEU: 4, spaceBasis: "period" }), token);
    assert("switched to per period", toPeriod.status === 200 && toPeriod.body?.spaceBasis === "period", JSON.stringify(toPeriod.body));
    assert("as period space it shows the whole pool (10 TEU pending) and no week", toPeriod.body?.pendingTEU === 10 && !toPeriod.body?.week && !toPeriod.body?.weeks,
      JSON.stringify({ p: toPeriod.body?.pendingTEU, w: toPeriod.body?.week }));
    assert("10 TEU on 4 of period space: C is now Space Exceeded", await badge(C) === "exceeded");
    const toWeek = await request("PUT", `/api/allocations/${allocId}`, config({ minimumTEU: 16 }), token);
    assert("switched back to per week", toWeek.status === 200 && toWeek.body?.spaceBasis === "week", JSON.stringify(toWeek.body));
    assert("C fits its week again", await badge(C) === "");

    console.log("\nSpace held per period is unchanged");
    const period = await request("POST", "/api/allocations", config({ spaceBasis: undefined, effectiveDate: "2026-12-01", endDate: "2026-12-31" }), token);
    if (period.body?.id) allocIds.push(period.body.id);
    assert("a configuration sent without a basis is held per period", period.status === 201 && period.body?.spaceBasis === "period", JSON.stringify(period.body));
    assert("and carries no week figures", period.body?.week === undefined && period.body?.weeks === undefined);
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    if (token) {
      console.log("\nCleanup");
      for (const id of shipmentIds) await request("DELETE", `/api/shipments/${id}`, null, token);
      for (const id of allocIds) await request("DELETE", `/api/allocations/${id}`, null, token);
      if (contractId) await request("DELETE", `/api/contracts/${contractId}`, null, token);
      for (const id of customerIds) await request("DELETE", `/api/customers/${id}`, null, token);
    }
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
