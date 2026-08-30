"use strict";

// ─── Admin "Reset Demo Data" ────────────────────────────────────────────────
// Direct request: a way to wipe all demo/business data back to a clean slate — for testing
// from the beginning, or eventually committing a known-good .db baseline — while keeping MDM
// reference data (and a few adjacent things) intact. The natural sibling of Zero-Script
// Onboarding (db/cargodesk.sample.db, v0.79.0): that one seeds a clean database on first boot
// when none exists yet; this resets an already-running one in place, on demand, no restart.
//
// Scoped to local-mode data only — the five extracted microservices (Contract Management, MDM,
// Screening, Kanban, Customers) each keep their own separate DB file when their own *_source
// toggle is 'remote'; this route can only reach the monolith's own local tables, by design.
//
// PRESERVE_TABLES is the single source of truth for what survives — reference/registry data and
// infra config, never tied to a specific demo scenario or person. Everything else in the live
// schema gets wiped. Deriving the reset list as (live schema − PRESERVE_TABLES), rather than a
// hand-maintained mirror list of what TO reset, is deliberate: a table added later defaults to
// being wiped unless someone explicitly adds it here — the safe failure direction for a
// "clean slate" feature (leftover demo data is a much smaller problem than silently exempting a
// future business table from ever being reset).
const PRESERVE_TABLES = new Set([
  // MDM core
  "carriers", "vessels", "port_locations", "linked_ports", "regions", "countries",
  "country_trade_lanes", "trade_lanes", "commodities",
  // Admin-maintained registries — same "seeded defaults + Master Data editable" idiom as MDM
  "charge_code_definitions", "pack_type_definitions", "container_type_definitions",
  "duty_rate_chapters", "milestone_templates", "invoice_status_reason_codes",
  // Compliance reference data — large external OFAC/CSL sync, re-syncing needs live network access
  "sanctions_entries", "sanctions_syncs",
  // App-level infra config, not business data
  "app_settings", "system_email_settings",
]);

module.exports = function adminResetRoutes(app, ctx) {
  const { query, transaction, ok, err, auth, requireRole, logAdminEvent, seedAdmin, seedTestFixtureAdmin, seedSigningCert } = ctx;

  const listTables = async () => (await query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name"
  )).map(r => r.name);

  // GET so the frontend can render the exact live preserve/reset table split without hand-
  // duplicating PRESERVE_TABLES in the UI — always current with the real schema.
  app.get("/api/admin/reset-demo-data/preview", auth(), requireRole(["admin"]), async (req, res) => {
    const allTables = await listTables();
    const preserve = allTables.filter(t => PRESERVE_TABLES.has(t));
    const reset = allTables.filter(t => !PRESERVE_TABLES.has(t));
    ok(res, { preserve, reset });
  });

  app.post("/api/admin/reset-demo-data", auth(), requireRole(["admin"]), async (req, res) => {
    if (req.body?.confirm !== "RESET")
      return err(res, 'Type RESET to confirm this irreversible action');

    const allTables = await listTables();
    const toReset = allTables.filter(t => !PRESERVE_TABLES.has(t));

    // TRUNCATE ... CASCADE is the Postgres equivalent of SQLite's PRAGMA foreign_keys=OFF bracket
    // around a bulk DELETE sweep — handles every FK dependency between the tables in this list
    // (and only this list; none of PRESERVE_TABLES sits downstream of a to-be-reset table in the
    // FK graph) in one statement, regardless of order. Table names come from the fixed internal
    // list above, never request input, so interpolating them is safe.
    try {
      await transaction(async (tx) => {
        if (toReset.length) await tx.query(`TRUNCATE TABLE ${toReset.map(t => `"${t}"`).join(", ")} CASCADE`);
      });
    } catch (e) {
      return err(res, e.message, 500);
    }

    // Re-bootstrap users/signing-cert exactly as a fresh boot would — the acting admin's own
    // account is gone (just wiped along with everyone else's), replaced by the same generic
    // seeded account a brand-new clone would get. Never preserved as-is: that would leave the
    // real admin's own name/email baked into what's meant to become a shareable baseline.
    await seedAdmin();
    await seedTestFixtureAdmin();
    await seedSigningCert();

    // First row of the now-empty admin_events log — real accountability for who reset it and when.
    await logAdminEvent(req.user, "RESET_DEMO_DATA", "system", "", { tablesCleared: toReset.length });

    ok(res, { reset: true, tablesCleared: toReset.length });
  });
};
