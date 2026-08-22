/**
 * Organization Model Enhancement — Epic 2: Credit Control, deepened per Epic TKT-6XFJQM
 * ("Credit Control Depth" — a sourced gap analysis against CargoWise One and Magaya).
 *
 * Covers the credit_limit/credit_terms_days/credit_hold/credit_hold_reason/currency fields on
 * customers, and GET /api/customers/:id/credit-status — the outstanding-AR-vs-limit
 * computation that ShipmentAccountingInvoicesPage.jsx's Generate Invoice flow gates on
 * (resolveCreditGate, src/utils/invoiceGenerator.js). Plus, from TKT-6XFJQM: AR aging buckets
 * (TKT-O4DNFX), accrued-but-uninvoiced committed exposure (TKT-AJAEDO), parent/group rollup
 * (TKT-IA7I7J), and country-defaulted customer currency wired into the limit itself
 * (TKT-O5I4NK).
 *
 * Known, deliberate coverage gap: the AR aging bucket *boundaries* (31-60/61-90/90+ days
 * overdue) can't be exercised through pure HTTP — there's no endpoint to backdate an invoice's
 * confirmed_at, and this suite (like every other test file in this project) only ever talks to
 * the app over its real API, never the DB directly. Only the "current" bucket (a just-confirmed
 * invoice) is integration-tested below; the day-threshold arithmetic itself is plain, low-risk
 * math reviewed at implementation time, not something faked into a false-confidence test here.
 *
 * Usage:
 *   node tests/customer-credit-control.test.js
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

const SAMPLE_HTML = `<html><body><h1>Freight Invoice (test fixture)</h1></body></html>`;

async function addSellLine(shipmentId, token, amount, chargeCode = "OFR") {
  const res = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, {
    type: "SELL", chargeCode, currency: "USD", amount, exchangeRate: 1,
  }, token);
  return res.body;
}

async function generateInvoiceDoc(shipmentId, token, sourceCostLineIds) {
  const res = await request("POST", `/api/shipments/${shipmentId}/documents/generate`, {
    html: SAMPLE_HTML, filename: `FR01-${shipmentId}-2026-08-02.html`, docType: "FR01",
    responsibleParty: "Test Credit Co", sourceCostLineIds,
  }, token);
  return res.body;
}

async function confirmDoc(docId, token) {
  return request("PATCH", `/api/documents/${docId}`, { status: "confirmed" }, token);
}

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch customer — credit fields default blank/off");
    const cust = await request("POST", "/api/customers", { companyName: "Test Credit Co" }, token);
    const customerId = cust.body.id;
    assert("scratch customer created", !!customerId);
    assert("creditLimit defaults null", cust.body.creditLimit === null);
    assert("creditTermsDays defaults null", cust.body.creditTermsDays === null);
    assert("creditHold defaults false", cust.body.creditHold === false);

    console.log("\nSet credit_limit=1000, credit_terms_days=30");
    const setLimit = await request("PUT", `/api/customers/${customerId}`, {
      companyName: "Test Credit Co", creditLimit: 1000, creditTermsDays: 30,
    }, token);
    assert("update returns 200", setLimit.status === 200);
    assert("creditLimit round-trips", setLimit.body.creditLimit === 1000);
    assert("creditTermsDays round-trips", setLimit.body.creditTermsDays === 30);

    console.log("\nCredit status — no shipments yet, no outstanding AR");
    const status0 = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("GET returns 200", status0.status === 200);
    assert("outstandingAr is 0", status0.body.outstandingAr === 0);
    assert("overLimit is false", status0.body.overLimit === false);

    console.log("\nScratch shipment with this customer as Principal");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: customerId, principalName: "Test Credit Co",
    }, token);
    const shipmentId = ship.body.id;
    assert("scratch shipment created", !!shipmentId);
    assert("principalId round-trips on the shipment", ship.body.principalId === customerId);

    console.log("\nFirst confirmed invoice — 700 USD, under the 1000 limit");
    const line1 = await addSellLine(shipmentId, token, 500, "OFR");
    const line2 = await addSellLine(shipmentId, token, 200, "DOC");
    const doc1 = await generateInvoiceDoc(shipmentId, token, [line1.id, line2.id]);
    assert("invoice 1 generated", !!doc1.id);
    const confirm1 = await confirmDoc(doc1.id, token);
    assert("invoice 1 confirmed", confirm1.body.status === "confirmed");

    const status1 = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("outstandingAr reflects the confirmed invoice (700)", status1.body.outstandingAr === 700, JSON.stringify(status1.body));
    assert("still under limit", status1.body.overLimit === false);

    console.log("\nSecond confirmed invoice — 500 USD more, now 1200 total, OVER the 1000 limit");
    const line3 = await addSellLine(shipmentId, token, 500, "THC");
    const doc2 = await generateInvoiceDoc(shipmentId, token, [line3.id]);
    const confirm2 = await confirmDoc(doc2.id, token);
    assert("invoice 2 confirmed", confirm2.body.status === "confirmed");

    const status2 = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("outstandingAr now 1200", status2.body.outstandingAr === 1200, JSON.stringify(status2.body));
    assert("now over limit", status2.body.overLimit === true);

    console.log("\nReversing invoice 2 drops outstanding AR back to 700 (voided invoices are excluded)");
    const reversed = await request("POST", `/api/shipments/${shipmentId}/documents/${doc2.id}/reverse`, { reason: "test" }, token);
    assert("reverse returns 200", reversed.status === 200);
    const status3 = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("outstandingAr back to 700 after reversal", status3.body.outstandingAr === 700, JSON.stringify(status3.body));
    assert("back under limit", status3.body.overLimit === false);

    console.log("\nCredit hold — set, verify, then clear");
    const setHold = await request("PUT", `/api/customers/${customerId}`, {
      companyName: "Test Credit Co", creditLimit: 1000, creditTermsDays: 30,
      creditHold: true, creditHoldReason: "Overdue balance — test fixture",
    }, token);
    assert("hold set", setHold.body.creditHold === true);
    assert("hold reason round-trips", setHold.body.creditHoldReason === "Overdue balance — test fixture");
    const statusHold = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("credit-status reflects the hold", statusHold.body.creditHold === true && statusHold.body.creditHoldReason === "Overdue balance — test fixture");

    const clearHold = await request("PUT", `/api/customers/${customerId}`, {
      companyName: "Test Credit Co", creditLimit: 1000, creditTermsDays: 30, creditHold: false,
    }, token);
    assert("hold cleared", clearHold.body.creditHold === false);
    assert("hold reason cleared alongside it (no stale reason left behind)", clearHold.body.creditHoldReason === "");

    console.log("\n404 on a bogus customer id");
    const bogus = await request("GET", "/api/customers/CUS-DOESNOTEXIST/credit-status", null, token);
    assert("bogus id returns 404", bogus.status === 404);

    // ── TKT-6XFJQM — Credit Control Depth ────────────────────────────────────────

    console.log("\nCommitted exposure — accrued SELL lines never invoiced still count as risk");
    const setLowLimit = await request("PUT", `/api/customers/${customerId}`, {
      companyName: "Test Credit Co", creditLimit: 100, creditTermsDays: 30,
    }, token);
    assert("limit lowered to 100", setLowLimit.body.creditLimit === 100);
    // Every SELL line from earlier in this file is already covered by a confirmed or reversed
    // invoice (net zero after reversal, verified above) — this is a genuinely fresh, never-
    // invoiced line, so committedExposure should reflect exactly this and nothing carried over.
    const exposureLine = await addSellLine(shipmentId, token, 300, "WHS");
    const statusExposure = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("outstandingAr unaffected by an uninvoiced line", statusExposure.body.outstandingAr === 700, JSON.stringify(statusExposure.body));
    assert("committedExposure reflects the uninvoiced line", statusExposure.body.committedExposure === 300, JSON.stringify(statusExposure.body));
    assert("overLimit now true from exposure alone (700+300=1000 > 100 limit, AR alone would say false)",
      statusExposure.body.overLimit === true);
    // Clean up this one line directly so it doesn't pollute the aging assertion below.
    await request("DELETE", `/api/shipments/${shipmentId}/cost-lines/${exposureLine.id}`, null, token);
    await request("PUT", `/api/customers/${customerId}`, { companyName: "Test Credit Co", creditLimit: 1000, creditTermsDays: 30 }, token);

    console.log("\nAR aging — a just-confirmed invoice lands entirely in the 'current' bucket");
    const statusAging = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    const aging = statusAging.body.aging;
    assert("aging object present with all 5 buckets", aging && ["current","d1_30","d31_60","d61_90","d90_plus"].every(k => k in aging), JSON.stringify(aging));
    assert("the confirmed invoice (700) is entirely in 'current'", aging.current === 700, JSON.stringify(aging));
    assert("no overdue buckets have anything in them yet", aging.d1_30 === 0 && aging.d31_60 === 0 && aging.d61_90 === 0 && aging.d90_plus === 0, JSON.stringify(aging));

    console.log("\nCurrency — credit_limit is interpreted in the customer's own currency, not hardcoded USD");
    const eurCust = await request("POST", "/api/customers", { companyName: "Test Credit EUR Co", currency: "EUR", creditLimit: 500 }, token);
    assert("EUR customer created", !!eurCust.body.id);
    assert("currency round-trips as EUR", eurCust.body.currency === "EUR");
    const eurStatus = await request("GET", `/api/customers/${eurCust.body.id}/credit-status`, null, token);
    assert("creditLimitCurrency reflects EUR, not a hardcoded USD assumption", eurStatus.body.creditLimitCurrency === "EUR", JSON.stringify(eurStatus.body));
    assert("creditLimit itself stays the raw EUR number (display value, never silently rewritten)", eurStatus.body.creditLimit === 500);
    // Live FX (frankfurter.app) may or may not be reachable in this environment — assert the
    // conversion ran and produced a real number, not a specific rate (that would be flaky).
    assert("creditLimitUsd is populated as a real positive number", typeof eurStatus.body.creditLimitUsd === "number" && eurStatus.body.creditLimitUsd > 0, JSON.stringify(eurStatus.body));
    await request("DELETE", `/api/customers/${eurCust.body.id}`, null, token);

    console.log("\nCurrency — new customer defaults from country when currency is omitted entirely");
    const esCust = await request("POST", "/api/customers", { companyName: "Test Credit ES Co", countryIso2: "ES" }, token);
    assert("Spain customer defaults to EUR", esCust.body.currency === "EUR", JSON.stringify(esCust.body));
    const jpCust = await request("POST", "/api/customers", { companyName: "Test Credit JP Co", countryIso2: "JP" }, token);
    assert("Japan customer defaults to JPY", jpCust.body.currency === "JPY", JSON.stringify(jpCust.body));
    const unmappedCust = await request("POST", "/api/customers", { companyName: "Test Credit BR Co", countryIso2: "BR" }, token);
    assert("a country with no mapping falls back to plain USD, not a broken value", unmappedCust.body.currency === "USD", JSON.stringify(unmappedCust.body));
    const explicitCust = await request("POST", "/api/customers", { companyName: "Test Credit Explicit Co", countryIso2: "ES", currency: "GBP" }, token);
    assert("an explicit currency is never overridden by the country default", explicitCust.body.currency === "GBP", JSON.stringify(explicitCust.body));
    for (const cid of [esCust.body.id, jpCust.body.id, unmappedCust.body.id, explicitCust.body.id]) {
      await request("DELETE", `/api/customers/${cid}`, null, token);
    }

    console.log("\nParent/group credit-limit rollup");
    const parentCust = await request("POST", "/api/customers", { companyName: "Test Credit Parent Co" }, token);
    const childCust = await request("POST", "/api/customers", { companyName: "Test Credit Child Co", parentCustomerId: parentCust.body.id }, token);
    assert("parent created", !!parentCust.body.id);
    assert("child linked to parent", childCust.body.parentCustomerId === parentCust.body.id);

    const groupShip = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: childCust.body.id, principalName: "Test Credit Child Co",
    }, token);
    const groupLine = await addSellLine(groupShip.body.id, token, 400, "OFR");
    const groupDoc = await generateInvoiceDoc(groupShip.body.id, token, [groupLine.id]);
    await confirmDoc(groupDoc.id, token);

    const parentStatus = await request("GET", `/api/customers/${parentCust.body.id}/credit-status`, null, token);
    const childStatus  = await request("GET", `/api/customers/${childCust.body.id}/credit-status`, null, token);
    assert("parent's own outstandingAr is 0 (the AR is on the child, not the parent directly)", parentStatus.body.outstandingAr === 0, JSON.stringify(parentStatus.body));
    assert("child's own outstandingAr reflects its own invoice", childStatus.body.outstandingAr === 400, JSON.stringify(childStatus.body));
    assert("parent's groupOutstandingAr sees the whole group's AR", parentStatus.body.groupOutstandingAr === 400, JSON.stringify(parentStatus.body));
    assert("child's groupOutstandingAr matches the parent's (same group, same total, either direction)", childStatus.body.groupOutstandingAr === 400, JSON.stringify(childStatus.body));
    assert("both report hasGroup true", parentStatus.body.hasGroup === true && childStatus.body.hasGroup === true);

    const standaloneStatus = await request("GET", `/api/customers/${customerId}/credit-status`, null, token);
    assert("a customer with no parent/children reports hasGroup false", standaloneStatus.body.hasGroup === false, JSON.stringify(standaloneStatus.body));

    await request("DELETE", `/api/shipments/${groupShip.body.id}`, null, token);
    await request("DELETE", `/api/customers/${childCust.body.id}`, null, token);
    await request("DELETE", `/api/customers/${parentCust.body.id}`, null, token);

    console.log("\nEarlier trigger point — shipment creation surfaces a soft creditWarning (never blocks)");
    const heldCust = await request("POST", "/api/customers", {
      companyName: "Test Credit Held Co", creditHold: true, creditHoldReason: "Overdue — test fixture",
    }, token);
    const heldShip = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: heldCust.body.id, principalName: "Test Credit Held Co",
    }, token);
    assert("shipment creation itself is never blocked by a hold", heldShip.status === 201);
    assert("creation response carries a creditWarning naming the held party", heldShip.body.creditWarning?.onHold?.length === 1, JSON.stringify(heldShip.body.creditWarning));
    assert("creditWarning names the right company/role", heldShip.body.creditWarning.onHold[0].companyName === "Test Credit Held Co" && heldShip.body.creditWarning.onHold[0].role === "Principal");

    const cleanShip = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
      principalId: customerId, principalName: "Test Credit Co",
    }, token);
    assert("a shipment with no held party carries no creditWarning at all", cleanShip.body.creditWarning === undefined, JSON.stringify(cleanShip.body.creditWarning));
    await request("DELETE", `/api/shipments/${cleanShip.body.id}`, null, token);

    console.log("\nEarlier trigger point — carrier-booking send is a real, server-enforced block");
    const sendBlocked = await request("POST", `/api/shipments/${heldShip.body.id}/edi-messages/booking-request`, {}, token);
    assert("sending a booking request is blocked (409) while the principal is on hold", sendBlocked.status === 409, JSON.stringify(sendBlocked.body));
    assert("the block names the held party", /Test Credit Held Co/.test(sendBlocked.body.error || ""), JSON.stringify(sendBlocked.body));

    await request("PUT", `/api/customers/${heldCust.body.id}`, { companyName: "Test Credit Held Co", creditHold: false }, token);
    const sendAfterClear = await request("POST", `/api/shipments/${heldShip.body.id}/edi-messages/booking-request`, {}, token);
    assert("clearing the hold unblocks sending", sendAfterClear.status === 201, JSON.stringify(sendAfterClear.body));

    await request("DELETE", `/api/shipments/${heldShip.body.id}`, null, token);
    await request("DELETE", `/api/customers/${heldCust.body.id}`, null, token);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/customers/${customerId}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    process.exit(1);
  }
})();
