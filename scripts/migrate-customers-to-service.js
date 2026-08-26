"use strict";
// migrate-customers-to-service.js — one-time, manually-run migration of this app's own local
// customers/customer_identifiers/customer_contacts/customer_screenings into the standalone
// Customer Service (services/customers/), via its own POST /internal/customers/bulk-import route.
// Same CLI-only, ops-level precedent as the other four migrate scripts (contracts/MDM/sanctions/
// kanban) — not automatic, doesn't flip the toggle itself.
//
// Deliberately does NOT touch customer_documents (stays local-only regardless of customer_source,
// see ARCHITECTURE.md §8.1 — uploaded file bytes live on disk, no cross-service blob storage
// exists in this codebase) or customer_roles (confirmed dead — role membership is fully derived
// live from shipments/shipment_parties, which stay monolith-owned either way).
//
// This does NOT flip the app_settings.customer_source toggle — that's a separate, deliberate step
// an admin takes afterward (AppSettingsPage.jsx -> API Controls -> External APIs -> Customer data
// source), once they've verified this migration's own output looks right. Running this script
// again is safe AND idempotent — every one of these 4 tables keeps its own original id as primary
// key, and the service's bulk-import route uses INSERT OR IGNORE against it.
//
// Usage:
//   node scripts/migrate-customers-to-service.js
//
// Prerequisites:
//   - cargodesk.db exists in the project root (the monolith's own local database — this script
//     reads it directly, the same way checkdb.js does; the monolith process itself does NOT need
//     to be running)
//   - Customer Service running (npm run customer-service)
//   - CUSTOMER_SERVICE_SECRET (or CUSTOMER_SERVICE_SECRET_FILE) set to match that service's own
//     env, unless both are still on the insecure dev default

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { readSecret } = require("../lib/dockerSecret");

const CUSTOMER_SERVICE_URL = process.env.CUSTOMER_SERVICE_URL || "http://localhost:3008";
const CUSTOMER_SERVICE_SECRET = readSecret("CUSTOMER_SERVICE_SECRET", "cargoDesk-dev-customers-service-secret-do-not-use-in-prod");

const db = new DatabaseSync(path.join(__dirname, "..", "cargodesk.db"));

async function postBulk(payload) {
  const res = await fetch(`${CUSTOMER_SERVICE_URL}/internal/customers/bulk-import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CUSTOMER_SERVICE_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.inserted || {};
}

async function migrate() {
  // Order matters for the response summary only (the service's own route always inserts
  // customers before identifiers/contacts/screenings regardless of payload key order, since those
  // three carry a real FK to customers) — reading order here just mirrors that for readability.
  const customers          = db.prepare("SELECT * FROM customers").all();
  const customerIdentifiers = db.prepare("SELECT * FROM customer_identifiers").all();
  const customerContacts    = db.prepare("SELECT * FROM customer_contacts").all();
  const customerScreenings  = db.prepare("SELECT * FROM customer_screenings").all();

  const totalRows = customers.length + customerIdentifiers.length + customerContacts.length + customerScreenings.length;
  if (!totalRows) { console.log("No local customer data found — nothing to migrate."); return; }

  console.log(`Found ${customers.length} customers, ${customerIdentifiers.length} identifiers, `
    + `${customerContacts.length} contacts, ${customerScreenings.length} screening records. `
    + `Migrating to ${CUSTOMER_SERVICE_URL}…\n`);

  try {
    const inserted = await postBulk({ customers, customerIdentifiers, customerContacts, customerScreenings });
    for (const [label, n] of Object.entries(inserted)) console.log(`  ✓  ${label}: ${n} newly inserted`);
  } catch (e) {
    console.error(`  ✗  bulk import failed entirely: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nNothing has changed in this app's own local database, and app_settings.customer_source");
  console.log("is still whatever it was before — review the service's own data, then flip the toggle");
  console.log("in Application Settings when ready. customer_documents and customer_roles were NOT");
  console.log("migrated — see this script's own header comment for why.");
}

migrate().catch(e => { console.error("Fatal:", e); process.exitCode = 1; });
