"use strict";
// migrate-contracts-to-service.js — one-time, manually-run migration of this app's own local
// contracts/contract_legs/contract_rates/contract_routings into the standalone Contract
// Management Service (services/contract-management/), via its POST /internal/contracts/bulk-import
// route. Deliberately a CLI script, not a Settings-page button — same precedent as seed-contracts.js
// and checkdb.js: a rare, ops-level, one-time action.
//
// This does NOT flip the app_settings.contract_source toggle — that's a separate, deliberate step
// an admin takes afterward (AppSettingsPage.jsx → API Controls → External APIs → Contract data
// source), once they've verified this migration's own output looks right. Running this script
// again is safe (it never touches or deletes the local data it reads from) but will create
// DUPLICATE contracts in the remote service if run twice against the same target — it doesn't
// check what's already there.
//
// Usage:
//   node scripts/migrate-contracts-to-service.js
//
// Prerequisites:
//   - cargodesk.db exists in the project root (the monolith's own local database — this script
//     reads it directly, the same way checkdb.js does; the monolith process itself does NOT need
//     to be running)
//   - Contract Management Service running (npm run contract-service)
//   - CONTRACT_SERVICE_SECRET (or CONTRACT_SERVICE_SECRET_FILE) set to match that service's own
//     env, unless both are still on the insecure dev default

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { readSecret } = require("../lib/dockerSecret");

const CONTRACT_SERVICE_URL = process.env.CONTRACT_SERVICE_URL || "http://localhost:3004";
const CONTRACT_SERVICE_SECRET = readSecret("CONTRACT_SERVICE_SECRET", "cargoDesk-dev-contract-service-secret-do-not-use-in-prod");
const BATCH_SIZE = 25;

const db = new DatabaseSync(path.join(__dirname, "..", "cargodesk.db"));

function loadContracts() {
  const contracts = db.prepare("SELECT * FROM contracts ORDER BY created_at ASC").all();
  return contracts.map(c => {
    const routingRows = db.prepare("SELECT * FROM contract_routings WHERE contract_id=? ORDER BY sort_order").all(c.id);
    const legRows      = db.prepare("SELECT * FROM contract_legs   WHERE contract_id=? ORDER BY leg_order").all(c.id);
    const rateRows      = db.prepare("SELECT * FROM contract_rates  WHERE contract_id=? ORDER BY sort_order").all(c.id);
    // routing_id never survives a save on the service side either (see routes/contracts.js's own
    // resolveRoutingId) — the only identity that does is a leg/rate's position (routingIndex) in
    // THIS payload's own routings[] array, so every routing_id gets resolved to an index here.
    const indexByRoutingId = Object.fromEntries(routingRows.map((r, i) => [r.id, i]));
    const routingIndexOf = routingId => (routingId && indexByRoutingId[routingId] != null) ? indexByRoutingId[routingId] : undefined;

    return {
      id: c.id, // sourceId — carried through in bulk-import's own response for correlation only
      contractNumber: c.contract_number, contractRef: c.contract_ref || "", carrierCode: c.carrier_code,
      namedAccountId: c.named_account_id || "", namedAccount: c.named_account || "",
      movementType: c.movement_type || "FCL",
      containerTypes: JSON.parse(c.container_types || "[]"),
      dgAllowed: !!c.dg_allowed,
      imdgClasses: JSON.parse(c.imdg_classes || "[]"),
      validFrom: c.valid_from || "", validTo: c.valid_to || "",
      currency: c.currency || "USD", status: c.status || "Active", notes: c.notes || "",
      createdAt: c.created_at,
      routings: routingRows.map(r => ({ name: r.name || "", transitDays: r.transit_days || 0, notes: r.notes || "" })),
      legs: legRows.map(l => ({
        pol: l.pol || "", polName: l.pol_name || "", pod: l.pod || "", podName: l.pod_name || "",
        transitDays: l.transit_days || 0, vesselService: l.vessel_service || "",
        polLinkedAllowed: !!l.pol_linked_allowed, podLinkedAllowed: !!l.pod_linked_allowed,
        polCarrierHaulage: !!l.pol_carrier_haulage, podCarrierHaulage: !!l.pod_carrier_haulage,
        polHaulageLocations: l.pol_haulage_locations || "", podHaulageLocations: l.pod_haulage_locations || "",
        polLocType: l.pol_loc_type || "Terminal", podLocType: l.pod_loc_type || "Terminal",
        routingIndex: routingIndexOf(l.routing_id),
      })),
      rates: rateRows.map(r => ({
        serviceCode: r.service_code || "", description: r.description || "",
        amount: r.amount || 0, currency: r.currency || "USD", unit: r.unit || "per_container",
        containerType: r.container_type || "", notes: r.notes || "",
        validFrom: r.valid_from || "", validTo: r.valid_to || "",
        routingIndex: routingIndexOf(r.routing_id),
      })),
    };
  });
}

async function postBatch(batch) {
  const res = await fetch(`${CONTRACT_SERVICE_URL}/internal/contracts/bulk-import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONTRACT_SERVICE_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ contracts: batch }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function migrate() {
  const contracts = loadContracts();
  if (!contracts.length) { console.log("No local contracts found — nothing to migrate."); return; }
  console.log(`Found ${contracts.length} local contract(s). Migrating to ${CONTRACT_SERVICE_URL} in batches of ${BATCH_SIZE}…\n`);

  let imported = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < contracts.length; i += BATCH_SIZE) {
    const batch = contracts.slice(i, i + BATCH_SIZE);
    try {
      const result = await postBatch(batch);
      imported += result.imported || 0;
      failed += result.failed || 0;
      for (const r of result.results || []) {
        if (r.ok) console.log(`  ✓  ${r.sourceId} → ${r.newId}`);
        else { console.error(`  ✗  ${r.sourceId}: ${r.error}`); failures.push(r); }
      }
    } catch (e) {
      console.error(`  ✗  Batch starting at index ${i} failed entirely: ${e.message}`);
      failed += batch.length;
      failures.push(...batch.map(c => ({ sourceId: c.id, error: e.message })));
    }
  }

  console.log(`\n${imported} imported, ${failed} failed.`);
  if (failures.length) {
    console.log("\nFailed contracts (not migrated — re-run this script after fixing, or migrate them by hand):");
    for (const f of failures) console.log(`  ${f.sourceId}: ${f.error}`);
  }
  console.log("\nNothing has changed in this app's own local database, and app_settings.contract_source");
  console.log("is still whatever it was before — review the service's own data, then flip the toggle");
  console.log("in Application Settings → API Controls → External APIs when ready.");
}

migrate().catch(e => { console.error("Fatal:", e); process.exitCode = 1; });
