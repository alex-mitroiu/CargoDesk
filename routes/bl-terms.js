"use strict";

// House B/L terms and conditions (2026-11-10, lib/bl-terms.js, ARCHITECTURE.md §8.48). Organisation → B/L Terms.
//   GET    /api/bl-terms                              admin: the organisation default and every legal entity, their
//                                                     current terms per language and all versions
//   POST   /api/bl-terms                              admin: { branchId|null, language, title?, text, pdfBase64?,
//                                                     pdfFilename?, keepPdf? } a new version → 201 { doc }
//   DELETE /api/bl-terms/:owner/:language             admin: no longer offer a language (owner = "org" or a branch id);
//                                                     its versions stay for the B/Ls issued on them; offices that
//                                                     started with it start with English → { retired, clearedOffices }
//   GET    /api/bl-terms/options?officeId=            the terms an office's House B/Ls can carry, and its default
//   GET    /api/bl-terms/:id/pdf                      a version's PDF (terms are public: every B/L prints them)

const fs = require("fs");
const path = require("path");

module.exports = function blTermsRoutes(app, ctx) {
  const { ok, err, auth, requireRole, UPLOADS_DIR } = ctx;
  const adminOnly = requireRole(["admin"]);
  const t = () => ctx.blTerms;

  app.get("/api/bl-terms", adminOnly, async (req, res) => ok(res, await t().list()));

  app.get("/api/bl-terms/options", auth(), async (req, res) => {
    const officeId = String(req.query.officeId || "");
    if (!officeId) return err(res, "officeId is required");
    const o = await t().optionsForOffice(officeId);
    if (!o.office) return err(res, "Office not found", 404);
    ok(res, { options: o.options, defaultKey: o.defaultKey, officeDefault: o.officeDefault, officeDefaultValid: o.officeDefaultValid,
      entityName: o.branch?.name || "" });
  });

  app.post("/api/bl-terms", adminOnly, async (req, res) => {
    const r = await t().save(req.body || {}, req.user);
    if (r.error) return err(res, r.error, r.status || 400);
    ok(res, r, 201);
  });

  app.delete("/api/bl-terms/:owner/:language", adminOnly, async (req, res) => {
    const owner = req.params.owner === "org" ? null : req.params.owner;
    const r = await t().retire(owner, req.params.language, req.user);
    if (r.error) return err(res, r.error, r.status || 400);
    ok(res, r);
  });

  app.get("/api/bl-terms/:id/pdf", auth(), async (req, res) => {
    const row = await t().byId(req.params.id);
    if (!row?.pdf_stored_name) return err(res, "No PDF for these terms", 404);
    const file = path.join(UPLOADS_DIR, row.pdf_stored_name);
    if (!fs.existsSync(file)) return err(res, "The PDF file is missing", 404);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${String(row.pdf_filename || "terms.pdf").replace(/[^\w.\- ]/g, "_")}"`);
    fs.createReadStream(file).pipe(res);
  });
};
