/**
 * Rate Reconciliation (2026-09-06) — smoke tests
 *
 * Direct finding on SHP-WKX04E: "Import from Contract"/"Update Carrier Costs" both used to
 * delete-then-regenerate every source='contract' cost line unconditionally, silently destroying
 * a dispatcher's own manual correction the next time either ran (PUT .../cost-lines/:id never
 * changed a line's `source`, so an edited contract line stayed forever indistinguishable from an
 * untouched one). Also fixes DOC (Documentation Fee) having silently aliased to the same "B/L Fee"
 * label as BL/BLF — two real, distinct charges collapsing into one, reading as duplication.
 *
 * Covers: GET .../cost-lines/reconcile-preview (both modes, all 5 statuses), the PUT
 * source-flip-to-manual behavior, and the overwrite/ignore semantics of both apply routes.
 * cost-lines-lifecycle.test.js already covers the plain happy-path of import-contract/
 * reset-to-contract/update-carrier-costs — this file is scoped to what's new.
 *
 * Usage:
 *   node tests/rate-reconciliation.test.js
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

function rowFor(rows, chargeCode) { return rows.find(r => r.chargeCode === chargeCode); }

(async () => {
  const cleanupShipments = [];
  let contractId, custId;
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch contract with OF + DOC rates, mirroring the real SHP-WKX04E shape");
    const cust = await request("POST", "/api/customers", { companyName: "Rate Reconciliation Test Co" }, token);
    custId = cust.body.id;
    const contractNum = `RR-${Date.now()}`;
    const contract = await request("POST", "/api/contracts", {
      contractNumber: contractNum, carrierCode: "MAEU", status: "Active",
      rates: [
        { serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" },
        { serviceCode: "DOC", amount: 50, currency: "USD", unit: "per_shipment" },
      ],
    }, token);
    assert("contract created", contract.status === 201, JSON.stringify(contract.body));
    contractId = contract.body.id;

    console.log("\nDOC and BL/BLF must resolve to distinct labels (the actual live bug)");
    const ship1 = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "Central", contractId, status: "Active",
    }, token);
    const ship1Id = ship1.body.id;
    cleanupShipments.push(ship1Id);
    const lines1 = await request("GET", `/api/shipments/${ship1Id}/cost-lines`, null, token);
    assert("shipment creation auto-imported 2 lines", lines1.body.length === 2, JSON.stringify(lines1.body));
    assert("Ocean Freight present", !!rowFor(lines1.body, "Ocean Freight"));
    assert("Documentation Fee has its OWN label, not 'B/L Fee'", !!rowFor(lines1.body, "Documentation Fee"), JSON.stringify(lines1.body));
    const docLine = rowFor(lines1.body, "Documentation Fee");

    console.log("\nreconcile-preview mode=import before any edits — everything should match");
    const previewMatch = await request("GET", `/api/shipments/${ship1Id}/cost-lines/reconcile-preview?mode=import`, null, token);
    assert("preview returns 200", previewMatch.status === 200, JSON.stringify(previewMatch.body));
    assert("both rows report 'match'", previewMatch.body.rows.every(r => r.status === "match"), JSON.stringify(previewMatch.body.rows));

    console.log("\nEditing a contract-sourced line flips its source to 'manual'");
    const editDoc = await request("PUT", `/api/shipments/${ship1Id}/cost-lines/${docLine.id}`,
      { type: "BUY", chargeCode: "Documentation Fee", currency: "USD", amount: 65, exchangeRate: 1 }, token);
    assert("edit succeeds", editDoc.status === 200, JSON.stringify(editDoc.body));
    assert("source flipped from contract to manual", editDoc.body.source === "manual", JSON.stringify(editDoc.body));

    console.log("\nA no-op edit (nothing actually changes) leaves an already-manual line's source untouched");
    const noopEdit = await request("PUT", `/api/shipments/${ship1Id}/cost-lines/${docLine.id}`,
      { type: "BUY", chargeCode: "Documentation Fee", currency: "USD", amount: 65, exchangeRate: 1 }, token);
    assert("still manual after a repeat no-op save", noopEdit.body.source === "manual");

    console.log("\nContract rate genuinely changes (OF 500->450) + a brand-new charge (BL) appears");
    const rateChange = await request("PUT", `/api/contracts/${contractId}`, {
      contractNumber: contractNum, carrierCode: "MAEU", status: "Active",
      rates: [
        { serviceCode: "OF", amount: 450, currency: "USD", unit: "per_container" },
        { serviceCode: "DOC", amount: 50, currency: "USD", unit: "per_shipment" },
        { serviceCode: "BL", amount: 11, currency: "USD", unit: "per_shipment" },
      ],
    }, token);
    assert("contract rates updated", rateChange.status === 200, JSON.stringify(rateChange.body));

    console.log("\nreconcile-preview mode=update now shows all 3 real statuses from the exact scenario reported");
    const previewUpdate = await request("GET", `/api/shipments/${ship1Id}/cost-lines/reconcile-preview?mode=update`, null, token);
    const ofRow = rowFor(previewUpdate.body.rows, "Ocean Freight");
    const docRow = rowFor(previewUpdate.body.rows, "Documentation Fee");
    const blRow = rowFor(previewUpdate.body.rows, "B/L Fee");
    assert("Ocean Freight: 'changed' (500 current vs 450 live)", ofRow?.status === "changed" && ofRow.currentAmount === 500 && ofRow.contractAmount === 450, JSON.stringify(ofRow));
    assert("Documentation Fee: 'manual' (65 current, source=manual)", docRow?.status === "manual" && docRow.currentAmount === 65, JSON.stringify(docRow));
    assert("B/L Fee: 'new' (no current line yet)", blRow?.status === "new" && blRow.currentAmount == null, JSON.stringify(blRow));

    console.log("\nreconcile-preview mode=import stays pinned to the ALREADY-ISSUED snapshot, unaffected by the live rate change");
    const previewImportStillPinned = await request("GET", `/api/shipments/${ship1Id}/cost-lines/reconcile-preview?mode=import`, null, token);
    const ofRowImport = rowFor(previewImportStillPinned.body.rows, "Ocean Freight");
    assert("Import mode still compares against the old snapshot's 500, not live 450", ofRowImport?.status === "match" && ofRowImport.contractAmount === 500, JSON.stringify(ofRowImport));

    console.log("\naction=ignore: touches nothing existing (manual OR plain stale), only adds what's missing");
    const ignoreRes = await request("POST", `/api/shipments/${ship1Id}/cost-lines/update-carrier-costs`, { action: "ignore" }, token);
    assert("ignore returns 200", ignoreRes.status === 200, JSON.stringify(ignoreRes.body));
    assert("only 1 line imported (just the missing B/L Fee)", ignoreRes.body.imported === 1, JSON.stringify(ignoreRes.body));
    const linesAfterIgnore = await request("GET", `/api/shipments/${ship1Id}/cost-lines`, null, token);
    assert("Ocean Freight left stale at 500 (not refreshed)", rowFor(linesAfterIgnore.body, "Ocean Freight")?.amount === 500);
    assert("Documentation Fee still the manual 65 (untouched)", rowFor(linesAfterIgnore.body, "Documentation Fee")?.amount === 65 && rowFor(linesAfterIgnore.body, "Documentation Fee")?.source === "manual");
    assert("B/L Fee 11 was added", rowFor(linesAfterIgnore.body, "B/L Fee")?.amount === 11);
    assert("action=ignore still creates a real snapshot (audit trail)", !!ignoreRes.body.snapshotId);

    console.log("\naction=overwrite (fresh scratch shipment): reaches manual overrides deliberately, refreshes stale prices");
    const ship2 = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "Central", contractId, status: "Active",
    }, token);
    const ship2Id = ship2.body.id;
    cleanupShipments.push(ship2Id);
    const lines2 = await request("GET", `/api/shipments/${ship2Id}/cost-lines`, null, token);
    const doc2 = rowFor(lines2.body, "Documentation Fee");
    await request("PUT", `/api/shipments/${ship2Id}/cost-lines/${doc2.id}`,
      { type: "BUY", chargeCode: "Documentation Fee", currency: "USD", amount: 99, exchangeRate: 1 }, token);

    const overwriteRes = await request("POST", `/api/shipments/${ship2Id}/cost-lines/update-carrier-costs`, { action: "overwrite" }, token);
    assert("overwrite returns 200", overwriteRes.status === 200, JSON.stringify(overwriteRes.body));
    assert("all 3 lines regenerated (OF+DOC refreshed, BL added)", overwriteRes.body.imported === 3, JSON.stringify(overwriteRes.body));
    const linesAfterOverwrite = await request("GET", `/api/shipments/${ship2Id}/cost-lines`, null, token);
    assert("Ocean Freight refreshed to live 450", rowFor(linesAfterOverwrite.body, "Ocean Freight")?.amount === 450);
    assert("Documentation Fee clobbered back to contract's 50, source back to contract", rowFor(linesAfterOverwrite.body, "Documentation Fee")?.amount === 50 && rowFor(linesAfterOverwrite.body, "Documentation Fee")?.source === "contract");
    assert("B/L Fee 11 added", rowFor(linesAfterOverwrite.body, "B/L Fee")?.amount === 11);

    console.log("\nValidation — bad action value, non-Central shipment");
    const badAction = await request("POST", `/api/shipments/${ship2Id}/cost-lines/update-carrier-costs`, { action: "delete-everything" }, token);
    assert("invalid action rejected", badAction.status >= 400);
    const spot = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active" }, token);
    cleanupShipments.push(spot.body.id);
    const previewNotCentral = await request("GET", `/api/shipments/${spot.body.id}/cost-lines/reconcile-preview?mode=update`, null, token);
    assert("preview rejected on a non-Central shipment", previewNotCentral.status >= 400 && /not linked to a Central contract/i.test(previewNotCentral.body.error || ""));

    console.log("\nCleanup");
    for (const id of cleanupShipments) await request("DELETE", `/api/shipments/${id}`, null, token);
    await request("DELETE", `/api/contracts/${contractId}`, null, token);
    await request("DELETE", `/api/customers/${custId}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("\nFATAL:", e.message);
    process.exit(1);
  }
})();
