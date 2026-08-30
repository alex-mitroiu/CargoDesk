"use strict";
// migrate-sanctions-to-service.js — one-time, manually-run migration of this app's own local
// sanctions_entries into the standalone Screening Service (services/screening/), via its
// POST /internal/sanctions/bulk-import route. sanctions_syncs (the sync history) is deliberately
// NOT migrated — the service starts its own sync history fresh the moment an admin runs its
// first real "Sync Now" against it, which is the honest state ("this service has never
// independently verified a sync against the live government feeds yet"), not a copied timestamp
// that would misrepresent that. Same CLI-only, ops-level precedent as the other two migrate
// scripts.
//
// This does NOT flip the app_settings.screening_source toggle — that's a separate, deliberate
// step an admin takes afterward (AppSettingsPage.jsx → API Controls → External APIs → Screening
// data source), once they've verified this migration's own output looks right. Running this
// script again is safe AND idempotent — sanctions_entries.id is a natural key (the
// source-prefixed ref id, e.g. "OFAC-12345"/"CSL-98765") and the service's bulk-import route uses
// INSERT OR IGNORE.
//
// Usage:
//   node scripts/migrate-sanctions-to-service.js
//
// Prerequisites:
//   - The monolith's own database is reachable via lib/db.js (same DATABASE_URL/embedded-pglite
//     resolution the monolith itself uses) — this script reads it directly, the same way
//     checkdb.js does; the monolith process itself does NOT need to be running.
//   - Screening Service running (npm run screening-service)
//   - SCREENING_SERVICE_SECRET (or SCREENING_SERVICE_SECRET_FILE) set to match that service's own
//     env, unless both are still on the insecure dev default

const { query } = require("../lib/db.js");
const { readSecret } = require("../lib/dockerSecret");

const SCREENING_SERVICE_URL = process.env.SCREENING_SERVICE_URL || "http://localhost:3006";
const SCREENING_SERVICE_SECRET = readSecret("SCREENING_SERVICE_SECRET", "cargoDesk-dev-screening-service-secret-do-not-use-in-prod");
// A synced OFAC+CSL dataset can run 25,000+ rows — chunked to stay well under the service's
// 10mb JSON body limit.
const CHUNK_SIZE = 2000;

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function postChunk(entries) {
  const res = await fetch(`${SCREENING_SERVICE_URL}/internal/sanctions/bulk-import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SCREENING_SERVICE_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.inserted || 0;
}

async function migrate() {
  const rows = await query("SELECT id, source, ref_id, entity_name, aliases_norm FROM sanctions_entries");
  if (!rows.length) { console.log("No local sanctions entries found — nothing to migrate."); return; }
  const entries = rows.map(r => ({ id: r.id, source: r.source, refId: r.ref_id || "", entityName: r.entity_name, entityType: "", program: "", aliasesNorm: r.aliases_norm || "[]" }));
  console.log(`Found ${entries.length} local sanctions entries. Migrating to ${SCREENING_SERVICE_URL} in batches of ${CHUNK_SIZE}…\n`);

  let inserted = 0, failed = 0;
  const batches = chunk(entries, CHUNK_SIZE);
  for (let i = 0; i < batches.length; i++) {
    try {
      const n = await postChunk(batches[i]);
      inserted += n;
      console.log(`  ✓  batch ${i + 1}/${batches.length}: ${n} newly inserted`);
    } catch (e) {
      failed += batches[i].length;
      console.error(`  ✗  batch ${i + 1}/${batches.length} failed entirely: ${e.message}`);
    }
  }

  console.log(`\n${inserted} newly inserted, ${failed} rows in failed batches (already-present rows are silently skipped, not counted as failed).`);
  console.log("\nsanctions_syncs (sync history) was NOT migrated — the service starts its own sync");
  console.log("history fresh on its first real Sync Now. Nothing has changed in this app's own local");
  console.log("database, and app_settings.screening_source is still whatever it was before — review");
  console.log("the service's own data, then flip the toggle in Application Settings when ready.");
  if (failed > 0) process.exitCode = 1;
}

migrate().catch(e => { console.error("Fatal:", e); process.exitCode = 1; });
