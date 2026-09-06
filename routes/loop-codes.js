"use strict";

// Loop Codes MDM registry — a carrier's named service loop (e.g. "AL1") and its ordered port
// rotation. Until now a shipment header's "Loop" field was only ever derived live from
// shipment_schedules[0].service (src/utils/scheduleLoop.js's deriveLoopCode), a free-text
// string with no backing master data — this table gives that string somewhere real to resolve
// against when a user clicks it (LoopRouteModal.jsx), it doesn't replace the derivation itself.
// A miss on /resolve is therefore expected/normal, not an error condition.
module.exports = function loopCodeRoutes(app, ctx) {
  const { query, transaction, ok, err, uid, isUniqueViolation, requireRole, getSettings, callMdmService, mapLoopCode, mapLoopCodePort } = ctx;
  const genId = () => `LOOP-${uid()}`;
  const write = requireRole(["admin", "operator"]);
  const isRemote = async () => ((await getSettings()).mdm_source || "local") === "remote";

  const LOOP_JOIN = `
    SELECT lc.*, (SELECT COUNT(*) FROM loop_code_ports p WHERE p.loop_code_id = lc.id) AS port_count
    FROM loop_codes lc
  `;
  // Local-mode join — kept exactly as it was. The remote branch below (added per the loop-integration
  // audit, 2026-09-05 — this table postdates the 2026-09-02/03 mdm_source sweep, so it was never
  // covered) can't join across two different databases, so it fetches the rotation rows plain, then
  // batch-resolves names/coords through the MDM Service's own ids= filter and merges in JS instead.
  const ROTATION_SQL = `
    SELECT p.*, pl.name AS port_name, pl.country_code, pl.latitude, pl.longitude
    FROM loop_code_ports p
    JOIN port_locations pl ON pl.unlocode = p.port_unlocode
    WHERE p.loop_code_id = $1
    ORDER BY p.sequence_order
  `;

  async function getRotation(loopCodeId) {
    if (!(await isRemote())) return query(ROTATION_SQL, [loopCodeId]);
    const plain = await query(
      "SELECT * FROM loop_code_ports WHERE loop_code_id=$1 ORDER BY sequence_order", [loopCodeId]
    );
    if (!plain.length) return plain;
    const codes = [...new Set(plain.map(p => p.port_unlocode))];
    let byCode = {};
    try {
      const rows = await callMdmService("GET", `/internal/port-locations?ids=${codes.map(encodeURIComponent).join(',')}`);
      byCode = Object.fromEntries((rows || []).map(r => [r.unlocode, r]));
    } catch { /* leave byCode empty — same clean-degrade every other remote MDM lookup here uses on failure */ }
    return plain.map(p => {
      const pl = byCode[p.port_unlocode];
      return { ...p, port_name: pl?.name || '', country_code: pl?.countryCode || null, latitude: pl?.latitude ?? null, longitude: pl?.longitude ?? null };
    });
  }

  // Batched existence check for the rotation PUT route below — local mode does one query for the
  // whole set (was previously one query per port); remote mode reuses the same ids= filter.
  async function findUnknownPorts(codes) {
    const unique = [...new Set(codes)];
    if (!unique.length) return [];
    let known;
    if (await isRemote()) {
      try {
        const rows = await callMdmService("GET", `/internal/port-locations?ids=${unique.map(encodeURIComponent).join(',')}`);
        known = new Set((rows || []).map(r => r.unlocode));
      } catch { known = new Set(); } // clean-degrade: an unreachable service treats every code as unknown, matching a real validation failure rather than silently accepting anything
    } else {
      const ph = unique.map((_, i) => `$${i + 1}`).join(',');
      const rows = await query(`SELECT unlocode FROM port_locations WHERE unlocode IN (${ph})`, unique);
      known = new Set(rows.map(r => r.unlocode));
    }
    return unique.filter(c => !known.has(c));
  }

  app.get("/api/loop-codes", async (req, res) => {
    const rows = await query(`${LOOP_JOIN} ORDER BY lc.code`);
    ok(res, rows.map(mapLoopCode));
  });

  // The shipment-header lookup — registered BEFORE /:id (Express route order; /:id would
  // otherwise greedily capture "resolve" as a literal id, the same gotcha document-templates.js
  // hit). Public (auth() only, no write gate) since any user viewing a shipment can click Loop.
  app.get("/api/loop-codes/resolve", async (req, res) => {
    const { code } = req.query;
    if (!code) return err(res, "code is required");
    const [row] = await query(`${LOOP_JOIN} WHERE lc.code = $1 AND lc.is_active = TRUE`, [code]);
    if (!row) return ok(res, null);
    const ports = await getRotation(row.id);
    ok(res, { ...mapLoopCode(row), ports: ports.map(mapLoopCodePort) });
  });

  app.get("/api/loop-codes/:id", write, async (req, res) => {
    const [row] = await query(`${LOOP_JOIN} WHERE lc.id = $1`, [req.params.id]);
    if (!row) return err(res, "Loop code not found", 404);
    const ports = await getRotation(row.id);
    ok(res, { ...mapLoopCode(row), ports: ports.map(mapLoopCodePort) });
  });

  app.post("/api/loop-codes", write, async (req, res) => {
    const { code, name, carrierCode = null, frequencyDays = null, roundTripDays = null } = req.body || {};
    if (!code || !code.trim()) return err(res, "code is required");
    if (!name || !name.trim()) return err(res, "name is required");
    const id = genId();
    const now = new Date().toISOString();
    try {
      await query(
        `INSERT INTO loop_codes (id, code, name, carrier_code, frequency_days, round_trip_days, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7,$7)`,
        [id, code.trim().toUpperCase(), name.trim(), carrierCode, frequencyDays, roundTripDays, now]
      );
    } catch (e) {
      return err(res, isUniqueViolation(e) ? `Loop code "${code.trim().toUpperCase()}" already exists` : e.message);
    }
    const [row] = await query(`${LOOP_JOIN} WHERE lc.id=$1`, [id]);
    ok(res, mapLoopCode(row), 201);
  });

  app.put("/api/loop-codes/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM loop_codes WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Loop code not found", 404);
    const {
      name = existing.name, carrierCode = existing.carrier_code,
      frequencyDays = existing.frequency_days, roundTripDays = existing.round_trip_days,
      isActive = existing.is_active,
    } = req.body || {};
    if (!name || !name.trim()) return err(res, "name is required");
    const now = new Date().toISOString();
    await query(
      `UPDATE loop_codes SET name=$1, carrier_code=$2, frequency_days=$3, round_trip_days=$4, is_active=$5, updated_at=$6 WHERE id=$7`,
      [name.trim(), carrierCode, frequencyDays, roundTripDays, !!isActive, now, req.params.id]
    );
    const [row] = await query(`${LOOP_JOIN} WHERE lc.id=$1`, [req.params.id]);
    ok(res, mapLoopCode(row));
  });

  app.delete("/api/loop-codes/:id", write, async (req, res) => {
    await query("DELETE FROM loop_codes WHERE id=$1", [req.params.id]);
    ok(res, { ok: true });
  });

  // Full-replace — the rotation is edited as one ordered list client-side (drag-to-reorder),
  // not row-by-row, so a delete-then-reinsert is simpler and correct here (no external table
  // references a loop_code_ports row's own id across a save, unlike e.g. shipment_legs).
  app.put("/api/loop-codes/:id/rotation", write, async (req, res) => {
    const [existing] = await query("SELECT id FROM loop_codes WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Loop code not found", 404);
    const { ports = [] } = req.body || {};
    if (!Array.isArray(ports) || ports.length < 2) return err(res, "A rotation needs at least 2 ports");
    const unknown = await findUnknownPorts(ports.map(p => p.portUnlocode));
    if (unknown.length) return err(res, `Unknown port ${unknown[0]}`);
    try {
      await transaction(async (tx) => {
        await tx.query("DELETE FROM loop_code_ports WHERE loop_code_id=$1", [req.params.id]);
        for (let i = 0; i < ports.length; i++) {
          await tx.query(
            `INSERT INTO loop_code_ports (id, loop_code_id, port_unlocode, sequence_order, transit_day_offset) VALUES ($1,$2,$3,$4,$5)`,
            [uid(), req.params.id, ports[i].portUnlocode, i, ports[i].transitDayOffset ?? null]
          );
        }
      });
    } catch (e) { return err(res, e.message); }
    const rows = await getRotation(req.params.id);
    ok(res, rows.map(mapLoopCodePort));
  });
};
