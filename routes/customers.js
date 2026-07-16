"use strict";

module.exports = function customersRoutes(app, ctx) {
  const { db, ok, err, uid, auth,
          mapCustomer, mapCustomerIdentifier, mapCustomerScreening, mapCustomerDoc,
          sanctionsMap, normSanctionName, loadSanctionsIndex, scheduleNextOfacSync,
          syncOfacSdn,
          getFxRates, fxCache, getSettings,
          UPLOADS_DIR, fs, path } = ctx;

  // ─── CSV parsing helpers (local to this domain) ────────────────────────────

  function parseCSVLine(line) {
    const fields = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) {
        fields.push(cur.trim()); cur = "";
      } else {
        cur += c;
      }
    }
    fields.push(cur.trim());
    return fields;
  }

  function parseOfacCsv(csvText) {
    const lines = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    const entries = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      const f = parseCSVLine(raw);
      if (f.length < 2) continue;
      let entNum, name, sdnType, program;
      const recIndicator = f[0].replace(/[\s-]/g, "");
      if (/^\d+$/.test(recIndicator) && f[0].includes("-")) {
        if (recIndicator !== "0") continue;
        entNum = f[1]; name = f[2]; sdnType = f[3] || ""; program = f[4] || "";
      } else {
        entNum = f[0]; name = f[1]; sdnType = f[2] || ""; program = f[3] || "";
      }
      if (!name || !entNum) continue;
      if (/sdn_?name|^name$/i.test(name)) continue;
      entries.push({ refId: String(entNum), name, sdnType, program: program.replace(/;+$/, "") });
    }
    return entries;
  }

  // Screen a customer against the loaded sanctions map and persist the result
  function screenCustomer(customerId) {
    const c = db.prepare("SELECT * FROM customers WHERE id=?").get(customerId);
    if (!c) return null;
    const match  = sanctionsMap.get(normSanctionName(c.company_name || ''));
    const result = match ? "HIT" : "CLEAR";
    const hits   = match ? [{ entityName: match.entityName, program: match.program, source: match.source }] : [];
    const now    = new Date().toISOString();
    const id     = `CSC-${uid()}`;
    db.prepare(`INSERT INTO customer_screenings (id,customer_id,screened_at,result,hits)
      VALUES (?,?,?,?,?)
      ON CONFLICT(customer_id) DO UPDATE SET
        screened_at=excluded.screened_at, result=excluded.result,
        hits=excluded.hits, overridden_at=NULL, override_reason=NULL`)
      .run(id, customerId, now, result, JSON.stringify(hits));
    const row = db.prepare("SELECT * FROM customer_screenings WHERE customer_id=?").get(customerId);
    return mapCustomerScreening(row);
  }

  const CUST_JOIN = `SELECT c.*, cs.result AS screening_result
    FROM customers c
    LEFT JOIN customer_screenings cs ON cs.customer_id = c.id`;

  // ─── Customers ────────────────────────────────────────────────────────────

  app.get("/api/customers", (req, res) => {
    const { search='', city='', country='', customerId='', limit='50', offset='0' } = req.query;
    const lim = Math.min(parseInt(limit)||50, 200), off = parseInt(offset)||0;
    const conditions = [], params = [];
    const s = search.trim();
    if (s) { conditions.push("(c.company_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.id LIKE ?)"); params.push(`%${s}%`, `%${s}%`, `%${s}%`, `%${s}%`); }
    const ci = city.trim();
    if (ci) { conditions.push("c.city LIKE ?"); params.push(`%${ci}%`); }
    const co = country.trim().toUpperCase();
    if (co) { conditions.push("c.country_iso2 = ?"); params.push(co); }
    const cid = customerId.trim();
    if (cid) { conditions.push("c.id LIKE ?"); params.push(`%${cid}%`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM customers c ${where}`).get(...params).n;
    const rows  = db.prepare(`${CUST_JOIN} ${where} ORDER BY c.company_name LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows.map(mapCustomer), total, limit: lim, offset: off });
  });

  app.get("/api/customers/sanctions-check", (req, res) => {
    const s = getSettings();
    if (s.api_customers_enabled !== 'true' || s.api_ofac_enabled !== 'true')
      return ok(res, { enabled: false, hits: [] });
    if (sanctionsMap.size === 0) return ok(res, { enabled: true, hits: [] });
    const customers = db.prepare("SELECT * FROM customers ORDER BY company_name").all();
    const hits = [];
    for (const c of customers) {
      const match = sanctionsMap.get(normSanctionName(c.company_name || ''));
      if (match) hits.push({ customer: mapCustomer(c), matchedEntry: match.entityName, program: match.program, source: match.source });
    }
    ok(res, { enabled: true, hits });
  });

  app.get("/api/customers/:id", (req, res) => {
    const r = db.prepare(`${CUST_JOIN} WHERE c.id=?`).get(req.params.id);
    if (!r) return err(res, "Not found", 404);
    ok(res, mapCustomer(r));
  });

  app.post("/api/customers", auth(), (req, res) => {
    const { companyName, address1='', address2='', city='', state='', postalCode='',
            countryIso2='', phone='', fax='', email='', website='', notes='', currency='USD' } = req.body;
    if (!companyName?.trim()) return err(res, "companyName required");
    const id = `CUS-${uid()}`;
    const createdAt = new Date().toISOString();
    const ccU = countryIso2.toUpperCase().trim();
    db.prepare("INSERT INTO customers (id,company_name,address1,address2,city,state,postal_code,country_iso2,phone,fax,email,website,notes,created_at,currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, companyName.trim(), address1, address2, city, state, postalCode, ccU, phone, fax, email, website, notes, createdAt, (currency || 'USD').toUpperCase().trim());
    if (sanctionsMap.size > 0) screenCustomer(id);
    const row = db.prepare(`${CUST_JOIN} WHERE c.id=?`).get(id);
    ok(res, mapCustomer(row), 201);
  });

  app.put("/api/customers/:id", auth(), (req, res) => {
    const { companyName, address1='', address2='', city='', state='', postalCode='',
            countryIso2='', phone='', fax='', email='', website='', notes='', currency='USD' } = req.body;
    if (!companyName?.trim()) return err(res, "companyName required");
    const ccU = countryIso2.toUpperCase().trim();
    const info = db.prepare(`UPDATE customers SET company_name=?,address1=?,address2=?,city=?,state=?,
      postal_code=?,country_iso2=?,phone=?,fax=?,email=?,website=?,notes=?,currency=? WHERE id=?`)
      .run(companyName.trim(), address1, address2, city, state, postalCode, ccU, phone, fax, email, website, notes, (currency || 'USD').toUpperCase().trim(), req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    if (sanctionsMap.size > 0) screenCustomer(req.params.id);
    const row = db.prepare(`${CUST_JOIN} WHERE c.id=?`).get(req.params.id);
    ok(res, mapCustomer(row));
  });

  app.delete("/api/customers/:id", auth(), (req, res) => {
    const info = db.prepare("DELETE FROM customers WHERE id=?").run(req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    db.prepare("DELETE FROM customer_identifiers WHERE customer_id=?").run(req.params.id);
    db.prepare("DELETE FROM customer_screenings  WHERE customer_id=?").run(req.params.id);
    const docs = db.prepare("SELECT stored_name FROM customer_documents WHERE customer_id=?").all(req.params.id);
    for (const d of docs) {
      try { fs.unlinkSync(path.join(UPLOADS_DIR, d.stored_name)); } catch {}
    }
    db.prepare("DELETE FROM customer_documents WHERE customer_id=?").run(req.params.id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Customer Identifiers ─────────────────────────────────────────────────

  app.get("/api/customers/:id/identifiers", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM customer_identifiers WHERE customer_id=? ORDER BY is_primary DESC, created_at ASC").all(req.params.id);
    ok(res, rows.map(mapCustomerIdentifier));
  });

  app.post("/api/customers/:id/identifiers", auth(), (req, res) => {
    if (!db.prepare("SELECT id FROM customers WHERE id=?").get(req.params.id))
      return err(res, "Customer not found", 404);
    const { idType='VAT', idCode='', countryIso2='', label='', isPrimary=false } = req.body;
    if (!idCode.trim()) return err(res, "idCode required");
    const id  = `CID-${uid()}`;
    const now = new Date().toISOString();
    if (isPrimary)
      db.prepare("UPDATE customer_identifiers SET is_primary=0 WHERE customer_id=? AND id_type=?").run(req.params.id, idType);
    db.prepare("INSERT INTO customer_identifiers (id,customer_id,id_type,id_code,country_iso2,label,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, req.params.id, idType, idCode.trim(), countryIso2.toUpperCase().slice(0,2), label.trim(), isPrimary ? 1 : 0, now);
    const row = db.prepare("SELECT * FROM customer_identifiers WHERE id=?").get(id);
    ok(res, mapCustomerIdentifier(row), 201);
  });

  app.put("/api/customers/:id/identifiers/:iid", auth(), (req, res) => {
    const existing = db.prepare("SELECT * FROM customer_identifiers WHERE id=? AND customer_id=?").get(req.params.iid, req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { idType=existing.id_type, idCode=existing.id_code, countryIso2=existing.country_iso2,
            label=existing.label, isPrimary=!!existing.is_primary } = req.body;
    if (!idCode.trim()) return err(res, "idCode required");
    if (isPrimary)
      db.prepare("UPDATE customer_identifiers SET is_primary=0 WHERE customer_id=? AND id_type=? AND id!=?").run(req.params.id, idType, req.params.iid);
    db.prepare("UPDATE customer_identifiers SET id_type=?,id_code=?,country_iso2=?,label=?,is_primary=? WHERE id=?")
      .run(idType, idCode.trim(), countryIso2.toUpperCase().slice(0,2), label.trim(), isPrimary ? 1 : 0, req.params.iid);
    const row = db.prepare("SELECT * FROM customer_identifiers WHERE id=?").get(req.params.iid);
    ok(res, mapCustomerIdentifier(row));
  });

  app.delete("/api/customers/:id/identifiers/:iid", auth(), (req, res) => {
    const info = db.prepare("DELETE FROM customer_identifiers WHERE id=? AND customer_id=?").run(req.params.iid, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.iid });
  });

  // ─── Customer Screening ───────────────────────────────────────────────────

  app.get("/api/customers/:id/screening", auth(), (req, res) => {
    const row = db.prepare("SELECT * FROM customer_screenings WHERE customer_id=?").get(req.params.id);
    if (!row) return ok(res, null);
    ok(res, mapCustomerScreening(row));
  });

  app.post("/api/customers/:id/screen", auth(), (req, res) => {
    if (!db.prepare("SELECT id FROM customers WHERE id=?").get(req.params.id))
      return err(res, "Not found", 404);
    if (sanctionsMap.size === 0)
      return err(res, "Sanctions list not yet synced — use POST /api/sanctions/sync first.", 400);
    ok(res, screenCustomer(req.params.id));
  });

  app.post("/api/customers/:id/screening/override", auth(), (req, res) => {
    const { reason = "" } = req.body;
    if (!reason.trim()) return err(res, "Override reason is required");
    const row = db.prepare("SELECT id FROM customer_screenings WHERE customer_id=?").get(req.params.id);
    if (!row) return err(res, "No screening record found for this customer", 404);
    const now = new Date().toISOString();
    db.prepare("UPDATE customer_screenings SET result='CLEAR', overridden_at=?, override_reason=? WHERE customer_id=?")
      .run(now, reason.trim(), req.params.id);
    const updated = db.prepare("SELECT * FROM customer_screenings WHERE customer_id=?").get(req.params.id);
    ok(res, mapCustomerScreening(updated));
  });

  // ─── Customer Documents ───────────────────────────────────────────────────

  app.get("/api/customers/:id/documents", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM customer_documents WHERE customer_id=? ORDER BY created_at DESC").all(req.params.id);
    ok(res, rows.map(mapCustomerDoc));
  });

  app.post("/api/customers/:id/documents", auth(), (req, res) => {
    if (!db.prepare("SELECT id FROM customers WHERE id=?").get(req.params.id))
      return err(res, "Customer not found", 404);
    const { filename, mimeType, docType, data } = req.body;
    if (!filename || !data) return err(res, "filename and data are required");
    try {
      const buf        = Buffer.from(data, "base64");
      const ext        = path.extname(filename) || "";
      const storedName = `${Date.now()}_${uid()}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buf);
      const id       = `CDO-${uid()}`;
      const now      = new Date().toISOString();
      const uploader = req.user?.name || req.user?.email || "";
      db.prepare("INSERT INTO customer_documents (id,customer_id,filename,stored_name,mime_type,size_bytes,doc_type,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, req.params.id, filename, storedName, mimeType || "", buf.length, docType || "Other", uploader, now);
      const row = db.prepare("SELECT * FROM customer_documents WHERE id=?").get(id);
      ok(res, mapCustomerDoc(row), 201);
    } catch (e) { err(res, e.message, 500); }
  });

  app.delete("/api/customers/:id/documents/:did", auth(), (req, res) => {
    const doc = db.prepare("SELECT * FROM customer_documents WHERE id=? AND customer_id=?").get(req.params.did, req.params.id);
    if (!doc) return err(res, "Not found", 404);
    try { fs.unlinkSync(path.join(UPLOADS_DIR, doc.stored_name)); } catch {}
    db.prepare("DELETE FROM customer_documents WHERE id=?").run(req.params.did);
    ok(res, { deleted: req.params.did });
  });

  app.get("/api/customers/:id/documents/:did/download", auth(), (req, res) => {
    const doc = db.prepare("SELECT * FROM customer_documents WHERE id=? AND customer_id=?").get(req.params.did, req.params.id);
    if (!doc) return err(res, "Not found", 404);
    const filePath = path.join(UPLOADS_DIR, doc.stored_name);
    if (!fs.existsSync(filePath)) return err(res, "File not found on disk", 404);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.filename}"`);
    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    res.sendFile(filePath);
  });

  // ─── Sanctions ────────────────────────────────────────────────────────────

  app.get("/api/sanctions/entries", (req, res) => {
    const { search = '', limit = '50', offset = '0', source = '' } = req.query;
    const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
    const conditions = [], params = [];
    if (search.trim()) { conditions.push("(entity_name LIKE ? OR program LIKE ?)"); params.push(`%${search.trim()}%`, `%${search.trim()}%`); }
    if (source.trim()) { conditions.push("source = ?"); params.push(source.trim()); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS n FROM sanctions_entries ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT id, source, ref_id, entity_name, entity_type, program FROM sanctions_entries ${where} ORDER BY entity_name LIMIT ? OFFSET ?`).all(...params, lim, off);
    ok(res, { results: rows, total, limit: lim, offset: off });
  });

  app.get("/api/sanctions/status", (req, res) => {
    const syncs = db.prepare("SELECT * FROM sanctions_syncs ORDER BY synced_at DESC").all();
    const count = db.prepare("SELECT COUNT(*) AS n FROM sanctions_entries").get().n;
    ok(res, { syncs, entryCount: count, indexed: sanctionsMap.size });
  });

  app.post("/api/sanctions/sync", async (req, res) => {
    try {
      ok(res, await syncOfacSdn());
      scheduleNextOfacSync();
    } catch (e) {
      err(res, e.message, 502);
    }
  });

  app.post("/api/sanctions/import-csv", (req, res) => {
    const { csv } = req.body;
    if (!csv || typeof csv !== "string") return err(res, "csv string required");
    try {
      const entries = parseOfacCsv(csv);
      if (entries.length === 0) return err(res, "No valid entries found — check the file format");
      db.prepare("DELETE FROM sanctions_entries WHERE source='OFAC-SDN'").run();
      const ins = db.prepare(
        `INSERT OR REPLACE INTO sanctions_entries
           (id, source, ref_id, entity_name, entity_name_norm, entity_type, program, aliases_norm)
         VALUES (?, 'OFAC-SDN', ?, ?, ?, ?, ?, '[]')`
      );
      db.exec("BEGIN");
      try {
        for (const e of entries)
          ins.run(`OFAC-${e.refId}`, e.refId, e.name, normSanctionName(e.name), e.sdnType, e.program);
        db.exec("COMMIT");
      } catch (e2) { db.exec("ROLLBACK"); throw e2; }
      const now = new Date().toISOString();
      db.prepare("INSERT OR REPLACE INTO sanctions_syncs (source, synced_at, entry_count) VALUES ('OFAC-SDN', ?, ?)").run(now, entries.length);
      loadSanctionsIndex();
      scheduleNextOfacSync();
      ok(res, { source: "OFAC-SDN", syncedAt: now, entries: entries.length });
    } catch (e) {
      err(res, e.message, 400);
    }
  });

  // ─── FX Rates ─────────────────────────────────────────────────────────────

  app.get("/api/fx/rates", async (req, res) => {
    const rates = await getFxRates();
    ok(res, { base: "USD", rates, ts: fxCache.ts });
  });
};
