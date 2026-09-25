"use strict";

// Charge Defaults (mockup: https://claude.ai/artifact/15DeP2Lcx9qmQbyQAUEwWd) — predefined BUY/
// SELL cost lines a Trade Manager wants to appear automatically on a matching shipment's
// Accounting tabs. See lib/schema.js's own comment on charge_default_setups/charge_default_lines/
// shipment_charge_defaults_applied for the table shapes this module reads and writes.

// Resolves a port's country and region once, so the matching pass below never has to touch
// port_locations/countries per candidate setup — just per shipment side (origin/destination).
// Region comes from the PORT's own zone_code, not countries.region_code — confirmed live
// (QA pass, 2026-09-25) that region_code is empty on all 208 seeded countries, while
// port_locations.zone_code is populated and is literally what /api/regions was auto-derived
// from in the first place. A region is a port-level geographic zone here (e.g. two ports in a
// large country can sit in different zones), not a strict Region>Country containment — so this
// reads zone_code directly instead of hopping through countries at all.
async function resolveCountryAndRegion(query, unlocode) {
  if (!unlocode) return { country: "", region: "" };
  const [port] = await query("SELECT country_code, zone_code FROM port_locations WHERE unlocode=$1", [unlocode]);
  if (!port) return { country: "", region: "" };
  return { country: port.country_code || "", region: port.zone_code || "" };
}

// Exactly one of region/country/location is ever set per side (enforced by the setups route on
// save) — most-specific-first, not a scoring problem.
function sideMatches(setup, prefix, shipmentCode, shipmentCountry, shipmentRegion) {
  const location = setup[`${prefix}_location`], country = setup[`${prefix}_country`], region = setup[`${prefix}_region`];
  if (location) return location === shipmentCode;
  if (country) return country === shipmentCountry;
  if (region) return region === shipmentRegion;
  return true; // all three blank on a non-global setup shouldn't happen post-validation, but never block on it
}

function specificity(setup) {
  return (setup.principal_id ? 1 : 0) + (!setup.location_global ? 1 : 0) + (setup.movement_type ? 1 : 0);
}

module.exports = function createChargeDefaults({ query, uid }) {
  // Runs once per shipment, called from the top of GET /api/shipments/:id/cost-lines — the one
  // endpoint both the Costs (Buy) and Invoice/Cost Entry (Sell) pages already fetch on mount, so
  // no frontend trigger is needed. Never re-runs for a shipment once resolved, even if a better
  // setup is created afterward or a matched line gets deleted — "default", not "enforced".
  async function applyChargeDefaults(shipmentId) {
    const [shipment] = await query("SELECT pol, pod, principal_id, movement_type FROM shipments WHERE id=$1", [shipmentId]);
    if (!shipment) return; // no such shipment (bad id, or deleted) — shipment_id is FK'd, nothing to claim

    // Claims the shipment atomically via the PRIMARY KEY on shipment_id, instead of a plain
    // SELECT-then-INSERT check: two concurrent GET /cost-lines calls for the same brand-new
    // shipment (e.g. two tabs, or the Costs and Invoice pages both fetching on mount) could
    // otherwise both see "not yet applied" and both insert the matched default lines twice.
    // Only the caller that wins this INSERT proceeds; the loser returns immediately, same as
    // the old "already applied" short-circuit.
    const now = new Date().toISOString();
    const claimed = await query(
      "INSERT INTO shipment_charge_defaults_applied (shipment_id, setup_id, applied_at) VALUES ($1, NULL, $2) ON CONFLICT (shipment_id) DO NOTHING RETURNING shipment_id",
      [shipmentId, now]);
    if (!claimed.length) return;

    const origin = await resolveCountryAndRegion(query, shipment.pol);
    const dest   = await resolveCountryAndRegion(query, shipment.pod);

    const setups = await query("SELECT * FROM charge_default_setups WHERE is_active=TRUE");
    const candidates = setups.filter(s =>
      (!s.principal_id || s.principal_id === shipment.principal_id) &&
      (!s.movement_type || s.movement_type === shipment.movement_type) &&
      (s.location_global || (
        sideMatches(s, "origin", shipment.pol, origin.country, origin.region) &&
        sideMatches(s, "dest", shipment.pod, dest.country, dest.region)
      ))
    );
    candidates.sort((a, b) => specificity(b) - specificity(a) || (b.updated_at || b.created_at).localeCompare(a.updated_at || a.created_at));
    const winner = candidates[0] || null;

    if (winner) {
      // Keyed by type+code, not code alone (QA finding, 2026-09-25): a manual BUY "Ocean Freight"
      // line must never block a setup's independent SELL "Ocean Freight" default (cost and
      // revenue sides of the same charge are genuinely different lines) — only a same-direction
      // line for that code counts as "already covered".
      const existing = await query("SELECT type, charge_code FROM shipment_cost_lines WHERE shipment_id=$1", [shipmentId]);
      const existingCodes = new Set(existing.map(r => `${r.type}:${r.charge_code}`));
      const lines = await query("SELECT * FROM charge_default_lines WHERE setup_id=$1 ORDER BY sort_order", [winner.id]);
      for (const l of lines) {
        if (existingCodes.has(`${l.type}:${l.charge_code}`)) continue; // a contract or manual line already covers this code+direction
        await query(
          `INSERT INTO shipment_cost_lines (id, shipment_id, type, charge_code, currency, amount, exchange_rate, notes, created_at, source)
           VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,'principal_default')`,
          [`CL-${uid()}`, shipmentId, l.type, l.charge_code, l.currency, l.amount, l.description, now]);
      }
      await query("UPDATE shipment_charge_defaults_applied SET setup_id=$1 WHERE shipment_id=$2", [winner.id, shipmentId]);
    }
  }

  return { applyChargeDefaults };
};
