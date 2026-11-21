"use strict";
// ─── Master Data → Facilities (2026-11-20, ARCHITECTURE.md §8.56) ─────────────────────────────────────────────────────
// Terminals from the SMDG list and depots added by hand; the rules are lib/facilities.js (ctx.facilities). Everyone signed in
// reads them (the haulage stop picker); admins and operators add depots; only an admin imports the SMDG list.
// Literal paths (/status, /import-smdg) are registered before /:id (CLAUDE.md: a specific route before a wildcard).

module.exports = function facilitiesRoutes(app, ctx) {
  const { ok, err, auth, requireRole, logEntityEvent } = ctx;
  const write = requireRole(["admin", "operator"]);
  const admin = requireRole(["admin"]);
  const actor = req => req.user?.name || req.user?.email || "";

  app.get("/api/facilities", auth(), async (req, res) => {
    const { unlocode = "", kind = "", q = "", open = "", limit = "" } = req.query;
    ok(res, await ctx.facilities.list({ unlocode, kind, q, open: open === "1" || open === "true", limit: Math.min(Number(limit) || 0, 2000) }));
  });

  // Registered before /api/facilities/:id.
  app.get("/api/facilities/status", auth(), async (req, res) => ok(res, await ctx.facilities.status()));

  // Body { csv } (an uploaded file's text) or nothing (fetched from GitHub). Large: the router's JSON limit applies.
  app.post("/api/facilities/import-smdg", admin, async (req, res) => {
    try {
      const result = await ctx.facilities.importSmdg({ csv: req.body?.csv || "" });
      await logEntityEvent("facility", "SMDG", "IMPORTED", null, null, null, JSON.stringify({ ...result, by: actor(req), upload: !!req.body?.csv }));
      ok(res, { ...result, status: await ctx.facilities.status() });
    } catch (e) { err(res, e.message, e.status || 500); }
  });

  app.get("/api/facilities/:id", auth(), async (req, res) => {
    const row = await ctx.facilities.get(req.params.id);
    if (!row) return err(res, "Facility not found", 404);
    ok(res, ctx.facilities.mapFacility(row));
  });

  app.post("/api/facilities", write, async (req, res) => {
    const r = await ctx.facilities.create(req.body);
    if (r.error) return err(res, r.error, r.status);
    await logEntityEvent("facility", r.facility.id, "CREATED", null, null, r.facility.name, JSON.stringify({ kind: r.facility.kind, unlocode: r.facility.unlocode, by: actor(req) }));
    ok(res, r.facility, 201);
  });

  app.put("/api/facilities/:id", write, async (req, res) => {
    const r = await ctx.facilities.update(req.params.id, req.body);
    if (r.error) return err(res, r.error, r.status);
    await logEntityEvent("facility", req.params.id, "UPDATED", null, null, null, JSON.stringify({ by: actor(req) }));
    ok(res, r.facility);
  });

  app.delete("/api/facilities/:id", write, async (req, res) => {
    const row = await ctx.facilities.get(req.params.id);
    if (row?.source === "smdg" && !(req.user?.roles || [req.user?.role]).includes("admin"))
      return err(res, "Only an admin can remove a terminal from the SMDG list (the next import brings it back)", 403);
    const r = await ctx.facilities.remove(req.params.id);
    if (r.error) return err(res, r.error, r.status);
    await logEntityEvent("facility", req.params.id, "DELETED", null, row?.name || null, null, JSON.stringify({ by: actor(req) }));
    ok(res, r);
  });
};
