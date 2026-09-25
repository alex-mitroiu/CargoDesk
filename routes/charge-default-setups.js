"use strict";

// Charge Defaults (mockup: https://claude.ai/artifact/15DeP2Lcx9qmQbyQAUEwWd) — CRUD for the
// setups lib/charge-defaults.js's applyChargeDefaults() matches shipments against. Same
// nested-array response shape as GET /api/contracts/:id (setup + its lines in one payload).

const MOVEMENT_TYPES = ["", "FCL", "LCL"];
// Same fixed vocabulary CostLineForm's own Charge Code dropdown already uses (ShipmentDetailPage.jsx)
// — duplicated rather than imported, same page-scoped-duplication precedent as this codebase's
// other small, rarely-changing shared constants, so a Charge Defaults change never risks the
// unrelated Cost Entry modal.
const CHARGE_CODES = ["Ocean Freight", "Origin THC", "Destination THC", "B/L Fee", "Customs", "Inland", "Haulage", "Other"];

module.exports = function chargeDefaultSetupsRoutes(app, ctx) {
  const { query, ok, err, uid, requireRole, mapChargeDefaultSetup, mapChargeDefaultLine } = ctx;
  const write = requireRole(["admin", "operator", "trade_manager"]);

  async function withLines(setup) {
    const lines = await query("SELECT * FROM charge_default_lines WHERE setup_id=$1 ORDER BY sort_order", [setup.id]);
    return { ...mapChargeDefaultSetup(setup), lines: lines.map(mapChargeDefaultLine) };
  }

  // Exactly one of region/country/location per side unless locationGlobal — the same rule the
  // editor UI enforces live (filling one clears its siblings), re-checked here since the client
  // is never trusted for validation that decides how broadly a setup fires.
  function validateAndNormalizeScope(body) {
    const { principalId = "", principalName = "", movementType = "", locationGlobal = false } = body;
    if (!MOVEMENT_TYPES.includes(movementType)) return { error: `movementType must be one of: ${MOVEMENT_TYPES.filter(Boolean).join(", ")}, or blank for any` };

    if (locationGlobal) {
      return { scope: { principalId, principalName, movementType, locationGlobal: true,
        originRegion: "", originCountry: "", originLocation: "", destRegion: "", destCountry: "", destLocation: "" } };
    }
    const originRegion = body.originRegion || "", originCountry = body.originCountry || "", originLocation = body.originLocation || "";
    const destRegion   = body.destRegion   || "", destCountry   = body.destCountry   || "", destLocation   = body.destLocation   || "";
    const originCount = [originRegion, originCountry, originLocation].filter(Boolean).length;
    const destCount   = [destRegion, destCountry, destLocation].filter(Boolean).length;
    if (originCount !== 1) return { error: "Set exactly one Origin field (Region, Country or Location), or turn Global on" };
    if (destCount !== 1)   return { error: "Set exactly one Destination field (Region, Country or Location), or turn Global on" };
    return { scope: { principalId, principalName, movementType, locationGlobal: false,
      originRegion, originCountry, originLocation, destRegion, destCountry, destLocation } };
  }

  function validateLines(lines) {
    if (!Array.isArray(lines) || !lines.length) return { error: "Add at least one charge or cost line" };
    for (const l of lines) {
      if (!["BUY", "SELL"].includes(l.type)) return { error: "Each line's type must be BUY or SELL" };
      if (!CHARGE_CODES.includes(l.chargeCode)) return { error: `Each line's chargeCode must be one of: ${CHARGE_CODES.join(", ")}` };
      if (l.amount == null || !Number.isFinite(Number(l.amount)) || Number(l.amount) < 0) return { error: "Each line needs a non-negative amount" };
    }
    return { lines };
  }

  app.get("/api/charge-default-setups", async (req, res) => {
    const setups = await query("SELECT * FROM charge_default_setups ORDER BY created_at DESC");
    const counts = await query("SELECT setup_id, COUNT(*)::int AS n FROM charge_default_lines GROUP BY setup_id");
    const countBySetup = Object.fromEntries(counts.map(c => [c.setup_id, c.n]));
    ok(res, setups.map(s => ({ ...mapChargeDefaultSetup(s), lineCount: countBySetup[s.id] || 0 })));
  });

  app.get("/api/charge-default-setups/:id", async (req, res) => {
    const [setup] = await query("SELECT * FROM charge_default_setups WHERE id=$1", [req.params.id]);
    if (!setup) return err(res, "Not found", 404);
    ok(res, await withLines(setup));
  });

  app.post("/api/charge-default-setups", write, async (req, res) => {
    const { scope, error: scopeError } = validateAndNormalizeScope(req.body || {});
    if (scopeError) return err(res, scopeError);
    const { lines, error: linesError } = validateLines(req.body?.lines);
    if (linesError) return err(res, linesError);

    const id = `CDS-${uid()}`;
    const now = new Date().toISOString();
    await query(
      `INSERT INTO charge_default_setups (id, principal_id, principal_name, movement_type, location_global,
        origin_region, origin_country, origin_location, dest_region, dest_country, dest_location,
        is_active, created_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,$12,$13)`,
      [id, scope.principalId, scope.principalName, scope.movementType, scope.locationGlobal,
       scope.originRegion, scope.originCountry, scope.originLocation, scope.destRegion, scope.destCountry, scope.destLocation,
       now, req.user?.id || ""]);
    let sortOrder = 0;
    for (const l of lines) {
      await query(
        `INSERT INTO charge_default_lines (id, setup_id, type, charge_code, description, currency, amount, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [`CDL-${uid()}`, id, l.type, l.chargeCode, l.description || "", (l.currency || "USD").toUpperCase(), Number(l.amount), sortOrder++]);
    }
    const [setup] = await query("SELECT * FROM charge_default_setups WHERE id=$1", [id]);
    ok(res, await withLines(setup), 201);
  });

  app.put("/api/charge-default-setups/:id", write, async (req, res) => {
    const [existing] = await query("SELECT * FROM charge_default_setups WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { scope, error: scopeError } = validateAndNormalizeScope(req.body || {});
    if (scopeError) return err(res, scopeError);
    const { lines, error: linesError } = validateLines(req.body?.lines);
    if (linesError) return err(res, linesError);

    await query(
      `UPDATE charge_default_setups SET principal_id=$1, principal_name=$2, movement_type=$3, location_global=$4,
        origin_region=$5, origin_country=$6, origin_location=$7, dest_region=$8, dest_country=$9, dest_location=$10,
        updated_at=$11, updated_by=$12
       WHERE id=$13`,
      [scope.principalId, scope.principalName, scope.movementType, scope.locationGlobal,
       scope.originRegion, scope.originCountry, scope.originLocation, scope.destRegion, scope.destCountry, scope.destLocation,
       new Date().toISOString(), req.user?.id || "", req.params.id]);
    // Whole-setup replace, not a per-line diff — the config is small enough that this is simpler
    // and safer than reconciling adds/edits/removes against whatever the client sends back.
    await query("DELETE FROM charge_default_lines WHERE setup_id=$1", [req.params.id]);
    let sortOrder = 0;
    for (const l of lines) {
      await query(
        `INSERT INTO charge_default_lines (id, setup_id, type, charge_code, description, currency, amount, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [`CDL-${uid()}`, req.params.id, l.type, l.chargeCode, l.description || "", (l.currency || "USD").toUpperCase(), Number(l.amount), sortOrder++]);
    }
    const [setup] = await query("SELECT * FROM charge_default_setups WHERE id=$1", [req.params.id]);
    ok(res, await withLines(setup));
  });

  app.patch("/api/charge-default-setups/:id/active", write, async (req, res) => {
    const [existing] = await query("SELECT id FROM charge_default_setups WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    await query("UPDATE charge_default_setups SET is_active=$1, updated_at=$2, updated_by=$3 WHERE id=$4",
      [!!req.body?.isActive, new Date().toISOString(), req.user?.id || "", req.params.id]);
    ok(res, { ok: true });
  });

  // Deletes the setup and its line templates (cascade). Never touches a cost line already
  // applied to a shipment — those are real financial records now, independent of the setup
  // that created them (shipment_charge_defaults_applied.setup_id just goes NULL via its own
  // ON DELETE SET NULL, keeping the "already resolved, never re-run" history intact).
  app.delete("/api/charge-default-setups/:id", write, async (req, res) => {
    const [existing] = await query("SELECT id FROM charge_default_setups WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    await query("DELETE FROM charge_default_setups WHERE id=$1", [req.params.id]);
    ok(res, { ok: true });
  });
};
