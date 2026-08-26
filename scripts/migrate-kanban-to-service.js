"use strict";
// migrate-kanban-to-service.js — one-time, manually-run migration of this app's own local
// tickets/ticket_links/test_items/test_case_links/kb_projects/kb_versions/kb_columns into the
// standalone Kanban/Testing Service (services/kanban/), via its own
// POST /internal/kanban/bulk-import route. Same CLI-only, ops-level precedent as the other three
// migrate scripts (contracts/MDM/sanctions) — not automatic, doesn't flip the toggle itself.
//
// This does NOT flip the app_settings.kanban_source toggle — that's a separate, deliberate step
// an admin takes afterward (AppSettingsPage.jsx -> API Controls -> External APIs -> Kanban/Testing
// data source), once they've verified this migration's own output looks right. Running this
// script again is safe AND idempotent — every one of these 7 tables keeps its own original id as
// primary key, and the service's bulk-import route uses INSERT OR IGNORE against it.
//
// Usage:
//   node scripts/migrate-kanban-to-service.js
//
// Prerequisites:
//   - cargodesk.db exists in the project root (the monolith's own local database — this script
//     reads it directly, the same way checkdb.js does; the monolith process itself does NOT need
//     to be running)
//   - Kanban Service running (npm run kanban-service)
//   - KANBAN_SERVICE_SECRET (or KANBAN_SERVICE_SECRET_FILE) set to match that service's own env,
//     unless both are still on the insecure dev default

const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { readSecret } = require("../lib/dockerSecret");

const KANBAN_SERVICE_URL = process.env.KANBAN_SERVICE_URL || "http://localhost:3007";
const KANBAN_SERVICE_SECRET = readSecret("KANBAN_SERVICE_SECRET", "cargoDesk-dev-kanban-service-secret-do-not-use-in-prod");

const db = new DatabaseSync(path.join(__dirname, "..", "cargodesk.db"));

async function postBulk(payload) {
  const res = await fetch(`${KANBAN_SERVICE_URL}/internal/kanban/bulk-import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KANBAN_SERVICE_SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.inserted || {};
}

async function migrate() {
  // Order matters for the response summary only (the service's own route inserts kb_projects
  // before kb_versions/kb_columns regardless of payload key order, since those two carry a real
  // FK to kb_projects) — reading order here just mirrors that for readability.
  const kbProjects    = db.prepare("SELECT * FROM kb_projects").all();
  const kbVersions    = db.prepare("SELECT * FROM kb_versions").all();
  const kbColumns     = db.prepare("SELECT * FROM kb_columns").all();
  const tickets       = db.prepare("SELECT * FROM tickets").all();
  const ticketLinks   = db.prepare("SELECT * FROM ticket_links").all();
  const testItems     = db.prepare("SELECT * FROM test_items").all();
  const testCaseLinks = db.prepare("SELECT * FROM test_case_links").all();

  const totalRows = kbProjects.length + kbVersions.length + kbColumns.length + tickets.length
    + ticketLinks.length + testItems.length + testCaseLinks.length;
  if (!totalRows) { console.log("No local Kanban/Testing data found — nothing to migrate."); return; }

  console.log(`Found ${kbProjects.length} projects, ${kbVersions.length} versions, ${kbColumns.length} columns, `
    + `${tickets.length} tickets, ${ticketLinks.length} ticket links, ${testItems.length} test items, `
    + `${testCaseLinks.length} test case links. Migrating to ${KANBAN_SERVICE_URL}…\n`);

  try {
    const inserted = await postBulk({ kbProjects, kbVersions, kbColumns, tickets, ticketLinks, testItems, testCaseLinks });
    for (const [label, n] of Object.entries(inserted)) console.log(`  ✓  ${label}: ${n} newly inserted`);
  } catch (e) {
    console.error(`  ✗  bulk import failed entirely: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nNothing has changed in this app's own local database, and app_settings.kanban_source");
  console.log("is still whatever it was before — review the service's own data, then flip the toggle");
  console.log("in Application Settings when ready.");
}

migrate().catch(e => { console.error("Fatal:", e); process.exitCode = 1; });
