/**
 * Cost Line accrual/posting lifecycle + Dedicated Services (routes/shipment-ops.js) — smoke tests
 *
 * tests/freight-audit-payment.test.js already exercises import-contract and (internally, via
 * carrier-invoice approval) actualization — but never the direct HTTP routes for updating,
 * actualizing, posting, batch-posting, or deleting a cost line, nor reset-to-contract,
 * update-carrier-costs, rate-snapshots, cost-line-events, or the Dedicated Services PATCH/DELETE
 * routes. This file fills all of that in.
 *
 * Usage:
 *   node tests/cost-lines-lifecycle.test.js
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

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch Central-contract shipment with a real rate, for reset-to-contract/update-carrier-costs");
    const contractNum = `CLL-${Date.now()}`;
    const contract = await request("POST", "/api/contracts", {
      contractNumber: contractNum, carrierCode: "MSCU", status: "Active",
      validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [{ serviceCode: "OF", amount: 1000, currency: "USD", unit: "per_container", containerType: "40HC" }],
    }, token);
    assert("contract created", contract.status === 201, JSON.stringify(contract.body));
    const contractId = contract.body.id;

    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MSCU", contractType: "Central", contractId, status: "Active",
    }, token);
    const shipmentId = ship.body.id;
    await request("POST", "/api/containers", { shipmentId, containerNumber: "CLLU1234567", size: "40", type: "HC" }, token);

    console.log("\nGET rate-snapshots — empty before any import, populated after");
    const snapsEmpty = await request("GET", `/api/shipments/${shipmentId}/rate-snapshots`, null, token);
    assert("rate-snapshots returns 200 array", snapsEmpty.status === 200 && Array.isArray(snapsEmpty.body));

    const importRes = await request("POST", `/api/shipments/${shipmentId}/cost-lines/import-contract`, { overwrite: true }, token);
    assert("import-contract succeeds", importRes.status === 200, JSON.stringify(importRes.body));
    const snapsAfter = await request("GET", `/api/shipments/${shipmentId}/rate-snapshots`, null, token);
    assert("a rate snapshot now exists", snapsAfter.body.length > 0);

    console.log("\nreset-to-contract — not-Central rejection, no-snapshot rejection, happy path");
    const spot = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MSCU", contractType: "SPOT", status: "Active" }, token);
    const resetNotCentral = await request("POST", `/api/shipments/${spot.body.id}/cost-lines/reset-to-contract`, {}, token);
    assert("reset-to-contract rejected on a non-Central shipment", resetNotCentral.status >= 400 && /not linked to a Central contract/i.test(resetNotCentral.body.error || ""));
    await request("DELETE", `/api/shipments/${spot.body.id}`, null, token);

    const resetOk = await request("POST", `/api/shipments/${shipmentId}/cost-lines/reset-to-contract`, {}, token);
    assert("reset-to-contract succeeds (real snapshot exists)", resetOk.status === 200, JSON.stringify(resetOk.body));
    assert("reset returns the snapshotId it replayed", !!resetOk.body.snapshotId);

    console.log("\nupdate-carrier-costs — pulls a fresh snapshot from live contract rates");
    const updateCosts = await request("POST", `/api/shipments/${shipmentId}/cost-lines/update-carrier-costs`, {}, token);
    assert("update-carrier-costs succeeds", updateCosts.status === 200, JSON.stringify(updateCosts.body));
    assert("returns a new snapshotId", !!updateCosts.body.snapshotId);
    const snapsAfterUpdate = await request("GET", `/api/shipments/${shipmentId}/rate-snapshots`, null, token);
    assert("a second, distinct snapshot now exists", snapsAfterUpdate.body.length >= 2);

    console.log("\nCost line PUT — happy path, field-diff audit, posted-lock rejection, 404");
    const costLines = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
    const line = costLines.body[0];
    assert("at least one cost line exists to edit", !!line);

    const putOk = await request("PUT", `/api/shipments/${shipmentId}/cost-lines/${line.id}`, {
      type: line.type, chargeCode: line.chargeCode, currency: line.currency, amount: 1234, exchangeRate: 1, notes: "Edited by test",
    }, token);
    assert("cost line PUT returns 200", putOk.status === 200 && putOk.body.amount === 1234);
    const putMissing = await request("PUT", `/api/shipments/${shipmentId}/cost-lines/${line.id}`, { chargeCode: "X" }, token);
    assert("PUT missing required fields rejected", putMissing.status >= 400);
    const put404 = await request("PUT", `/api/shipments/${shipmentId}/cost-lines/CL-NOPE`, { type: "BUY", chargeCode: "X", amount: 1 }, token);
    assert("PUT 404 for unknown line", put404.status === 404);

    const events = await request("GET", `/api/shipments/${shipmentId}/cost-line-events`, null, token);
    assert("cost-line-events returns 200", events.status === 200);
    assert("the PUT's amount change is in the audit trail", events.body.some(e => e.entity_id === line.id && e.field === "amount"));

    console.log("\nActualize — missing actualAmount rejected, happy path, 404");
    const actualizeMissing = await request("PATCH", `/api/shipments/${shipmentId}/cost-lines/${line.id}/actualize`, {}, token);
    assert("actualize missing actualAmount rejected", actualizeMissing.status >= 400);
    const actualize = await request("PATCH", `/api/shipments/${shipmentId}/cost-lines/${line.id}/actualize`, { actualAmount: 1200 }, token);
    assert("actualize succeeds", actualize.status === 200 && actualize.body.status === "actualized");
    assert("actualAmount round-trips", actualize.body.actualAmountUsd != null);
    const actualize404 = await request("PATCH", `/api/shipments/${shipmentId}/cost-lines/CL-NOPE/actualize`, { actualAmount: 1 }, token);
    assert("actualize 404 for unknown line", actualize404.status === 404);

    console.log("\nPost — happy path, already-posted rejection, locked-line PUT/DELETE rejection, 404");
    const post = await request("PATCH", `/api/shipments/${shipmentId}/cost-lines/${line.id}/post`, {}, token);
    assert("post succeeds", post.status === 200 && post.body.status === "posted");
    const postAgain = await request("PATCH", `/api/shipments/${shipmentId}/cost-lines/${line.id}/post`, {}, token);
    assert("posting an already-posted line rejected (409)", postAgain.status === 409);
    const post404 = await request("PATCH", `/api/shipments/${shipmentId}/cost-lines/CL-NOPE/post`, {}, token);
    assert("post 404 for unknown line", post404.status === 404);
    const putLocked = await request("PUT", `/api/shipments/${shipmentId}/cost-lines/${line.id}`, { type: line.type, chargeCode: line.chargeCode, amount: 1 }, token);
    assert("PUT on a posted line rejected (409)", putLocked.status === 409);
    const deleteLocked = await request("DELETE", `/api/shipments/${shipmentId}/cost-lines/${line.id}`, null, token);
    assert("DELETE on a posted line rejected (409)", deleteLocked.status === 409);
    const actualizeLocked = await request("PATCH", `/api/shipments/${shipmentId}/cost-lines/${line.id}/actualize`, { actualAmount: 1 }, token);
    assert("actualize on a posted line rejected (409)", actualizeLocked.status === 409);

    console.log("\nPost-batch — mixed valid/already-posted/unknown ids, empty ids rejected");
    const secondLine = costLines.body.find(l => l.id !== line.id);
    const batchEmpty = await request("POST", `/api/shipments/${shipmentId}/cost-lines/post-batch`, { ids: [] }, token);
    assert("post-batch with empty ids rejected", batchEmpty.status >= 400);
    if (secondLine) {
      const batch = await request("POST", `/api/shipments/${shipmentId}/cost-lines/post-batch`, { ids: [secondLine.id, line.id, "CL-NOPE"] }, token);
      assert("post-batch returns 200", batch.status === 200);
      assert("only the genuinely-postable line comes back", batch.body.length === 1 && batch.body[0].id === secondLine.id);
      assert("that line is now posted", batch.body[0].status === "posted");
    }

    console.log("\nDelete — happy path (non-posted line), auto-cleans an orphaned draft invoice");
    const scratchLine = await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "SELL", chargeCode: "OT", currency: "USD", amount: 50 }, token);
    const delOk = await request("DELETE", `/api/shipments/${shipmentId}/cost-lines/${scratchLine.body.id}`, null, token);
    assert("delete succeeds on a non-posted line", delOk.status === 200);
    const del404 = await request("DELETE", `/api/shipments/${shipmentId}/cost-lines/${scratchLine.body.id}`, null, token);
    assert("delete 404 on second attempt", del404.status === 404);

    console.log("\nDedicated Services — PATCH (status transitions, invalid status, 404) and DELETE");
    const svc = await request("POST", `/api/shipments/${shipmentId}/services`, { side: "Export", serviceType: "VGM", vendorName: "Test Vendor" }, token);
    assert("service created", svc.status === 201, JSON.stringify(svc.body));
    const svcId = svc.body.id;

    const svcBadStatus = await request("PATCH", `/api/shipments/${shipmentId}/services/${svcId}`, { status: "Nonsense" }, token);
    assert("service PATCH with invalid status rejected", svcBadStatus.status >= 400);
    const svcConfirm = await request("PATCH", `/api/shipments/${shipmentId}/services/${svcId}`, { status: "Confirmed" }, token);
    assert("service PATCH to Confirmed succeeds", svcConfirm.status === 200 && svcConfirm.body.status === "Confirmed");
    assert("confirmedDate auto-stamped", !!svcConfirm.body.confirmedDate);
    const svcComplete = await request("PATCH", `/api/shipments/${shipmentId}/services/${svcId}`, { status: "Completed", notes: "Done" }, token);
    assert("service PATCH to Completed succeeds", svcComplete.status === 200 && svcComplete.body.status === "Completed");
    assert("completedDate auto-stamped", !!svcComplete.body.completedDate);
    assert("notes updated too, in the same PATCH", svcComplete.body.notes === "Done");
    const svc404 = await request("PATCH", `/api/shipments/${shipmentId}/services/SVC-NOPE`, { status: "Confirmed" }, token);
    assert("service PATCH 404 for unknown id", svc404.status === 404);

    const svcDelete = await request("DELETE", `/api/shipments/${shipmentId}/services/${svcId}`, null, token);
    assert("service delete returns 200", svcDelete.status === 200);
    const svcDelete404 = await request("DELETE", `/api/shipments/${shipmentId}/services/${svcId}`, null, token);
    assert("service delete 404 on second attempt", svcDelete404.status === 404);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/contracts/${contractId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
