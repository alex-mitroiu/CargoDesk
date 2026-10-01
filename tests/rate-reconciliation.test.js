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
import { ensureOffices } from "./helpers/offices.mjs";

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
  let contractId, custId, cdSetupId;
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    const { emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId } = await ensureOffices(token);

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
      emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId,
    }, token);
    const ship1Id = ship1.body.id;
    cleanupShipments.push(ship1Id);
    const lines1 = await request("GET", `/api/shipments/${ship1Id}/cost-lines`, null, token);
    // Counted by source: a live database's own global Charge Default setups also land lines here.
    assert("shipment creation auto-imported 2 lines", lines1.body.filter(l => l.source === "contract").length === 2, JSON.stringify(lines1.body));
    assert("Ocean Freight present", !!rowFor(lines1.body, "Ocean Freight"));
    assert("Documentation Fee has its OWN label, not 'B/L Fee'", !!rowFor(lines1.body, "Documentation Fee"), JSON.stringify(lines1.body));
    const docLine = rowFor(lines1.body, "Documentation Fee");

    console.log("\nreconcile-preview mode=import before any edits — everything should match");
    const previewMatch = await request("GET", `/api/shipments/${ship1Id}/cost-lines/reconcile-preview?mode=import`, null, token);
    assert("preview returns 200", previewMatch.status === 200, JSON.stringify(previewMatch.body));
    assert("both contract rows report 'match'", previewMatch.body.rows.filter(r => r.status !== "kept").length === 2
      && previewMatch.body.rows.filter(r => r.status !== "kept").every(r => r.status === "match"), JSON.stringify(previewMatch.body.rows));

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
      emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId,
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

    console.log("\nOverwrite never touches posted/actualized lines, Charge Default lines, or charges the contract never had");
    // Principal + movement type = the most specific a setup can be, so a live DB's own global
    // setups can't outrank it for this shipment.
    const cdSetup = await request("POST", "/api/charge-default-setups", {
      principalId: custId, principalName: "Rate Reconciliation Test Co", movementType: "FCL", locationGlobal: true,
      lines: [{ type: "BUY", chargeCode: "Customs", description: "Customs brokerage", currency: "USD", amount: 120 }],
    }, token);
    assert("scoped Charge Default setup created", cdSetup.status === 201, JSON.stringify(cdSetup.body));
    cdSetupId = cdSetup.body.id;
    const threeRates = await request("PUT", `/api/contracts/${contractId}`, {
      contractNumber: contractNum, carrierCode: "MAEU", status: "Active",
      rates: [
        { serviceCode: "OF", amount: 450, currency: "USD", unit: "per_container" },
        { serviceCode: "DOC", amount: 50, currency: "USD", unit: "per_shipment" },
        { serviceCode: "BL", amount: 11, currency: "USD", unit: "per_shipment" },
        { serviceCode: "THC", amount: 90, currency: "USD", unit: "per_shipment" },
      ],
    }, token);
    assert("contract now has OF/DOC/BL/THC", threeRates.status === 200, JSON.stringify(threeRates.body));
    const ship3 = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "Central", contractId, status: "Active",
      principalId: custId, principalName: "Rate Reconciliation Test Co", movementType: "FCL",
      emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId,
    }, token);
    const ship3Id = ship3.body.id;
    cleanupShipments.push(ship3Id);
    const lines3 = (await request("GET", `/api/shipments/${ship3Id}/cost-lines`, null, token)).body;
    const customs3 = lines3.find(l => l.chargeCode === "Customs" && l.source === "principal_default");
    assert("Charge Default line applied (Customs 120)", customs3?.amount === 120, JSON.stringify(lines3));
    const inland = await request("POST", `/api/shipments/${ship3Id}/cost-lines`,
      { type: "BUY", chargeCode: "Inland", currency: "USD", amount: 75, exchangeRate: 1 }, token);
    assert("hand-added manual Inland line", inland.status === 201 || inland.status === 200, JSON.stringify(inland.body));
    const of3 = rowFor(lines3, "Ocean Freight"), bl3 = rowFor(lines3, "B/L Fee");
    const post = await request("PATCH", `/api/shipments/${ship3Id}/cost-lines/${of3.id}/post`, {}, token);
    assert("Ocean Freight posted", post.status === 200 && post.body.status === "posted", JSON.stringify(post.body));
    const act = await request("PATCH", `/api/shipments/${ship3Id}/cost-lines/${bl3.id}/actualize`, { actualAmount: 12 }, token);
    assert("B/L Fee actualized", act.status === 200 && act.body.status === "actualized", JSON.stringify(act.body));

    await request("PUT", `/api/contracts/${contractId}`, {
      contractNumber: contractNum, carrierCode: "MAEU", status: "Active",
      rates: [
        { serviceCode: "OF", amount: 480, currency: "USD", unit: "per_container" },
        { serviceCode: "DOC", amount: 55, currency: "USD", unit: "per_shipment" },
        { serviceCode: "BL", amount: 13, currency: "USD", unit: "per_shipment" },
      ],
    }, token);
    const preview3 = (await request("GET", `/api/shipments/${ship3Id}/cost-lines/reconcile-preview?mode=update`, null, token)).body.rows;
    const p = code => rowFor(preview3, code);
    assert("posted Ocean Freight: 'locked' (posted)", p("Ocean Freight")?.status === "locked" && p("Ocean Freight")?.reason === "posted", JSON.stringify(p("Ocean Freight")));
    assert("actualized B/L Fee: 'locked' (actualized)", p("B/L Fee")?.status === "locked" && p("B/L Fee")?.reason === "actualized", JSON.stringify(p("B/L Fee")));
    assert("Documentation Fee: 'changed' 50 -> 55", p("Documentation Fee")?.status === "changed", JSON.stringify(p("Documentation Fee")));
    assert("Origin THC (dropped from contract): 'removed'", p("Origin THC")?.status === "removed", JSON.stringify(p("Origin THC")));
    assert("Charge Default Customs: 'kept', not 'removed'", p("Customs")?.status === "kept", JSON.stringify(p("Customs")));
    assert("hand-added Inland: 'kept', not 'removed'", p("Inland")?.status === "kept", JSON.stringify(p("Inland")));

    const overwrite3 = await request("POST", `/api/shipments/${ship3Id}/cost-lines/update-carrier-costs`, { action: "overwrite" }, token);
    assert("overwrite returns 200", overwrite3.status === 200, JSON.stringify(overwrite3.body));
    assert("only Documentation Fee regenerated (locked charges not duplicated)", overwrite3.body.imported === 1, JSON.stringify(overwrite3.body));
    const after3 = (await request("GET", `/api/shipments/${ship3Id}/cost-lines`, null, token)).body.filter(l => l.type === "BUY");
    const byCode = code => after3.filter(l => l.chargeCode === code);
    assert("posted Ocean Freight survives, still one line at 450", byCode("Ocean Freight").length === 1 && byCode("Ocean Freight")[0].id === of3.id && byCode("Ocean Freight")[0].amount === 450, JSON.stringify(byCode("Ocean Freight")));
    assert("actualized B/L Fee survives, not duplicated", byCode("B/L Fee").length === 1 && byCode("B/L Fee")[0].id === bl3.id, JSON.stringify(byCode("B/L Fee")));
    assert("Documentation Fee refreshed to 55", byCode("Documentation Fee").length === 1 && byCode("Documentation Fee")[0].amount === 55);
    assert("Origin THC removed", byCode("Origin THC").length === 0);
    assert("Charge Default Customs survives", byCode("Customs").some(l => l.id === customs3.id));
    assert("hand-added Inland survives", byCode("Inland").some(l => l.id === inland.body.id));

    const ignore3 = await request("POST", `/api/shipments/${ship3Id}/cost-lines/update-carrier-costs`, { action: "ignore" }, token);
    assert("ignore adds nothing for locked charges", ignore3.status === 200 && ignore3.body.imported === 0, JSON.stringify(ignore3.body));

    console.log("\nReset to Contract: reverts edits without duplicating, never touches posted/CCD/hand-added lines");
    const ship4 = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "Central", contractId, status: "Active",
      principalId: custId, principalName: "Rate Reconciliation Test Co", movementType: "FCL",
      emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId,
    }, token);
    const ship4Id = ship4.body.id;
    cleanupShipments.push(ship4Id);
    const lines4 = (await request("GET", `/api/shipments/${ship4Id}/cost-lines`, null, token)).body;
    const of4 = rowFor(lines4, "Ocean Freight"), doc4 = rowFor(lines4, "Documentation Fee");
    const customs4 = lines4.find(l => l.chargeCode === "Customs" && l.source === "principal_default");
    await request("PATCH", `/api/shipments/${ship4Id}/cost-lines/${of4.id}/post`, {}, token);
    await request("PUT", `/api/shipments/${ship4Id}/cost-lines/${doc4.id}`,
      { type: "BUY", chargeCode: "Documentation Fee", currency: "USD", amount: 70, exchangeRate: 1 }, token);
    const inland4 = await request("POST", `/api/shipments/${ship4Id}/cost-lines`,
      { type: "BUY", chargeCode: "Inland", currency: "USD", amount: 75, exchangeRate: 1 }, token);
    const reset4 = await request("POST", `/api/shipments/${ship4Id}/cost-lines/reset-to-contract`, {}, token);
    assert("reset returns 200", reset4.status === 200, JSON.stringify(reset4.body));
    const after4 = (await request("GET", `/api/shipments/${ship4Id}/cost-lines`, null, token)).body.filter(l => l.type === "BUY");
    const code4 = c => after4.filter(l => l.chargeCode === c);
    assert("posted Ocean Freight survives, not duplicated", code4("Ocean Freight").length === 1 && code4("Ocean Freight")[0].id === of4.id && code4("Ocean Freight")[0].status === "posted", JSON.stringify(code4("Ocean Freight")));
    assert("edited Documentation Fee reverted to the contract's 55 — one line, not two", code4("Documentation Fee").length === 1 && code4("Documentation Fee")[0].amount === 55, JSON.stringify(code4("Documentation Fee")));
    assert("CCD Customs survives", code4("Customs").some(l => l.id === customs4?.id));
    assert("hand-added Inland survives", code4("Inland").some(l => l.id === inland4.body.id));

    console.log("\nValidation — bad action value, non-Central shipment");
    const badAction = await request("POST", `/api/shipments/${ship2Id}/cost-lines/update-carrier-costs`, { action: "delete-everything" }, token);
    assert("invalid action rejected", badAction.status >= 400);
    const spot = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active", emoOfficeId: defaultEmoOfficeId, imoOfficeId: defaultImoOfficeId }, token);
    cleanupShipments.push(spot.body.id);
    const previewNotCentral = await request("GET", `/api/shipments/${spot.body.id}/cost-lines/reconcile-preview?mode=update`, null, token);
    assert("preview rejected on a non-Central shipment", previewNotCentral.status >= 400 && /not linked to a Central contract/i.test(previewNotCentral.body.error || ""));

    console.log("\nCleanup");
    for (const id of cleanupShipments) await request("DELETE", `/api/shipments/${id}`, null, token);
    if (cdSetupId) await request("DELETE", `/api/charge-default-setups/${cdSetupId}`, null, token);
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
