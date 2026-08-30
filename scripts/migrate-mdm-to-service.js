"use strict";
// migrate-mdm-to-service.js — one-time, manually-run migration of this app's own local
// carriers/vessels/port_locations/linked_ports/trade_lanes/country_trade_lanes/regions/countries/
// commodities/carrier_agents into the standalone MDM Service (services/mdm/), via its
// POST /internal/mdm/bulk-import route. Deliberately a CLI script, not a Settings-page button —
// same precedent as migrate-contracts-to-service.js/seed-contracts.js/checkdb.js: a rare,
// ops-level, one-time action.
//
// This does NOT flip the app_settings.mdm_source toggle — that's a separate, deliberate step an
// admin takes afterward (AppSettingsPage.jsx → API Controls → External APIs → MDM data source),
// once they've verified this migration's own output looks right. Running this script again is
// safe AND idempotent (unlike the contracts migrate script) — every MDM table has a natural-key
// primary key (code/imo/unlocode/...), and the service's bulk-import route uses INSERT OR IGNORE,
// so a re-run just skips rows that already made it across.
//
// Usage:
//   node scripts/migrate-mdm-to-service.js
//
// Prerequisites:
//   - The monolith's own database is reachable via lib/db.js (same DATABASE_URL/embedded-pglite
//     resolution the monolith itself uses) — this script reads it directly, the same way
//     checkdb.js does; the monolith process itself does NOT need to be running.
//   - MDM Service running (npm run mdm-service)
//   - MDM_SERVICE_SECRET (or MDM_SERVICE_SECRET_FILE) set to match that service's own env, unless
//     both are still on the insecure dev default

const { query } = require("../lib/db.js");
const { readSecret } = require("../lib/dockerSecret");

const MDM_SERVICE_URL = process.env.MDM_SERVICE_URL || "http://localhost:3005";
const MDM_SERVICE_SECRET = readSecret("MDM_SERVICE_SECRET", "cargoDesk-dev-mdm-service-secret-do-not-use-in-prod");
// port_locations alone can be 14,000+ rows — chunked per table (not one giant request) to stay
// well under the service's 5mb JSON body limit.
const CHUNK_SIZE = 1000;

const TABLES = [
  { key: "carriers", label: "Carriers", sql: "SELECT code, name, short_name FROM carriers" },
  { key: "vessels", label: "Vessels", sql: "SELECT imo, name, asset_type, flag_iso2, flag_name, build_year, gross_tonnage, mmsi, ais_verified_at FROM vessels" },
  { key: "portLocations", label: "Port locations", sql: "SELECT unlocode, name, latitude, longitude, country_code, zone_code, timezone, last_synced_at FROM port_locations" },
  { key: "linkedPorts", label: "Linked ports", sql: "SELECT id, primary_unlocode, linked_unlocode, note FROM linked_ports" },
  { key: "tradeLanes", label: "Trade lanes", sql: "SELECT code, name, description, transit_days FROM trade_lanes" },
  { key: "countryTradeLanes", label: "Country-trade-lane assignments", sql: "SELECT iso2, lane_code FROM country_trade_lanes" },
  { key: "regions", label: "Regions", sql: "SELECT code, name, description FROM regions" },
  { key: "countries", label: "Countries", sql: "SELECT iso2, name, un_member, region_code, invoice_alert_business_days, invoice_escalation_business_days FROM countries" },
  { key: "commodities", label: "Commodities", sql: "SELECT code, description, grade_code, grade_name FROM commodities" },
  // carrier_agents deliberately NOT migrated — every row's agent_customer_id points at a
  // customers row, and this migration only moves MDM's own reference data. An operator
  // re-registers Line Agents against the new service directly once it's live, same "business
  // config, not reference data" reasoning documented in the MDM sample DB's own build notes.
];

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function postChunk(key, rows) {
  const res = await fetch(`${MDM_SERVICE_URL}/internal/mdm/bulk-import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${MDM_SERVICE_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify({ [key]: rows }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data[key] || 0;
}

async function migrate() {
  console.log(`Migrating local MDM data to ${MDM_SERVICE_URL} in chunks of ${CHUNK_SIZE}…\n`);
  let totalInserted = 0, anyFailed = false;
  for (const t of TABLES) {
    const rows = await query(t.sql);
    if (!rows.length) { console.log(`${t.label}: 0 local rows, skipped`); continue; }
    let inserted = 0;
    try {
      for (const c of chunk(rows, CHUNK_SIZE)) inserted += await postChunk(t.key, c);
      console.log(`${t.label}: ${rows.length} local rows, ${inserted} newly inserted (${rows.length - inserted} already present or skipped)`);
      totalInserted += inserted;
    } catch (e) {
      console.error(`${t.label}: FAILED — ${e.message}`);
      anyFailed = true;
    }
  }
  console.log(`\n${totalInserted} row(s) newly inserted across all tables.`);
  console.log("\nNothing has changed in this app's own local database, and app_settings.mdm_source");
  console.log("is still whatever it was before — review the service's own data, then flip the toggle");
  console.log("in Application Settings → API Controls → External APIs when ready.");
  if (anyFailed) process.exitCode = 1;
}

migrate().catch(e => { console.error("Fatal:", e); process.exitCode = 1; });
