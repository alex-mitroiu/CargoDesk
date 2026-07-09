"use strict";

module.exports = function shipmentOpsRoutes(app, ctx) {
  const { db, ok, err, uid, auth,
          mapCostLine, mapMilestone, mapMilestoneTemplate,
          sanctionsMap, screenShipmentById,
          logEntityEvent, importContractRates,
          UPLOADS_DIR, fs, path } = ctx;

  // Prepared statement declared at module scope for efficiency (re-used per mapDoc call)
  const STALE_EVENTS = db.prepare(`
    SELECT COUNT(*) as n FROM shipment_events
    WHERE shipment_id = ? AND occurred_at > ?
    AND event_type IN ('FIELD_UPDATED','CONTAINER_ADDED','CONTAINER_REMOVED','CONTAINER_UPDATED')
  `);

  const mapDoc = (r, shipmentId) => {
    const sid = shipmentId || r.shipment_id;
    const { n } = STALE_EVENTS.get(sid, r.created_at);
    return {
      id: r.id, shipmentId: r.shipment_id, filename: r.filename,
      mimeType: r.mime_type, sizeBytes: r.size_bytes,
      docType: r.doc_type, uploadedBy: r.uploaded_by, createdAt: r.created_at,
      status: r.status || 'draft',
      confirmedAt: r.confirmed_at || null, confirmedBy: r.confirmed_by || '',
      isStale: n > 0,
    };
  };

  // ─── Screening ────────────────────────────────────────────────────────────

  app.get("/api/shipments/:id/screening", (req, res) => {
    const row = db.prepare("SELECT * FROM shipment_screenings WHERE shipment_id=?").get(req.params.id);
    if (!row) return ok(res, null);
    ok(res, { id: row.id, shipmentId: row.shipment_id, screenedAt: row.screened_at,
      result: row.result, hits: JSON.parse(row.hits || "[]"),
      overriddenAt: row.overridden_at || null, overrideReason: row.override_reason || null });
  });

  app.post("/api/shipments/:id/screen", (req, res) => {
    if (!db.prepare("SELECT id FROM shipments WHERE id=?").get(req.params.id)) return err(res, "Not found", 404);
    if (sanctionsMap.size === 0) return err(res, "Sanctions list not yet synced — use POST /api/sanctions/sync first.", 400);
    ok(res, screenShipmentById(req.params.id));
  });

  app.post("/api/shipments/:id/screening/override", (req, res) => {
    const { reason = "" } = req.body;
    if (!reason.trim()) return err(res, "Override reason is required");
    const row = db.prepare("SELECT id FROM shipment_screenings WHERE shipment_id=?").get(req.params.id);
    if (!row) return err(res, "No screening record found for this shipment", 404);
    const now = new Date().toISOString();
    db.prepare("UPDATE shipment_screenings SET result='CLEAR', overridden_at=?, override_reason=? WHERE shipment_id=?")
      .run(now, reason.trim(), req.params.id);
    ok(res, { overriddenAt: now, overrideReason: reason.trim() });
  });

  // ─── Cost Lines ───────────────────────────────────────────────────────────

  app.post("/api/shipments/:id/cost-lines/import-contract", (req, res) => {
    const { overwrite = false, splitPerContainer = false } = req.body || {};
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (shipment.contract_type !== 'Central' || !shipment.contract_id)
      return err(res, "Shipment is not linked to a Central contract");
    let includeSell = false;
    if (overwrite) {
      const existingBuy  = db.prepare("SELECT id FROM shipment_cost_lines WHERE shipment_id=? AND type='BUY'  AND source='contract'").all(req.params.id);
      const existingSell = db.prepare("SELECT id FROM shipment_cost_lines WHERE shipment_id=? AND type='SELL' AND source='contract'").all(req.params.id);
      includeSell = existingSell.length > 0;
      for (const row of [...existingBuy, ...existingSell]) db.prepare("DELETE FROM shipment_cost_lines WHERE id=?").run(row.id);
    }
    const count = importContractRates(req.params.id, { splitPerContainer, includeSell });
    ok(res, { imported: count });
  });

  app.get("/api/shipments/:id/cost-lines", (req, res) => {
    const rows = db.prepare("SELECT * FROM shipment_cost_lines WHERE shipment_id=? ORDER BY type, created_at ASC").all(req.params.id);
    ok(res, rows.map(mapCostLine));
  });

  app.post("/api/shipments/:id/cost-lines", (req, res) => {
    const { type, chargeCode, currency = 'USD', amount, exchangeRate = 1, vatRate = 0, notes = '', containerId = '', source: rawSource } = req.body;
    if (!type || !chargeCode || amount == null) return err(res, "type, chargeCode, amount required");
    if (!['BUY','SELL'].includes(type)) return err(res, "type must be BUY or SELL");
    const source = rawSource === 'contract' ? 'contract' : 'manual';
    const vat = type === 'SELL' ? Number(vatRate) || 0 : 0;
    const id  = `CL-${uid()}`;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,vat_rate,notes,container_id,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.params.id, type, chargeCode, currency.toUpperCase(), Number(amount), Number(exchangeRate), vat, notes, containerId, now, source);
    logEntityEvent('cost_line', id, 'CREATED', null, null, null,
      JSON.stringify({ shipmentId: req.params.id, type, chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchangeRate: Number(exchangeRate), vatRate: vat }));
    ok(res, mapCostLine({ id, shipment_id: req.params.id, type, charge_code: chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchange_rate: Number(exchangeRate), vat_rate: vat, notes, container_id: containerId, source, modified_at: null, created_at: now }), 201);
  });

  app.put("/api/shipments/:shipmentId/cost-lines/:id", (req, res) => {
    const { type, chargeCode, currency = 'USD', amount, exchangeRate = 1, vatRate = 0, notes = '', containerId = '' } = req.body;
    if (!type || !chargeCode || amount == null) return err(res, "type, chargeCode, amount required");
    if (!['BUY','SELL'].includes(type)) return err(res, "type must be BUY or SELL");
    const existing = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=? AND shipment_id=?").get(req.params.id, req.params.shipmentId);
    if (!existing) return err(res, "Not found", 404);
    const vat = type === 'SELL' ? Number(vatRate) || 0 : 0;
    const now = new Date().toISOString();
    db.prepare("UPDATE shipment_cost_lines SET type=?,charge_code=?,currency=?,amount=?,exchange_rate=?,vat_rate=?,notes=?,container_id=?,modified_at=? WHERE id=?")
      .run(type, chargeCode, currency.toUpperCase(), Number(amount), Number(exchangeRate), vat, notes, containerId, now, req.params.id);
    for (const [field, oldV, newV] of [
      ['type',          existing.type,          type],
      ['charge_code',   existing.charge_code,   chargeCode],
      ['currency',      existing.currency,      currency.toUpperCase()],
      ['amount',        String(existing.amount), String(Number(amount))],
      ['exchange_rate', String(existing.exchange_rate), String(Number(exchangeRate))],
      ['vat_rate',      String(existing.vat_rate || 0), String(vat)],
      ['notes',         existing.notes || '',   notes],
      ['container_id',  existing.container_id || '', containerId],
    ]) {
      if (String(oldV) !== String(newV))
        logEntityEvent('cost_line', req.params.id, 'UPDATED', field, oldV, newV,
          JSON.stringify({ shipmentId: existing.shipment_id, chargeCode, type }));
    }
    ok(res, mapCostLine({ id: req.params.id, shipment_id: existing.shipment_id, type, charge_code: chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchange_rate: Number(exchangeRate), vat_rate: vat, notes, container_id: containerId, source: existing.source || 'manual', modified_at: now, created_at: existing.created_at }));
  });

  app.delete("/api/shipments/:shipmentId/cost-lines/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=? AND shipment_id=?").get(req.params.id, req.params.shipmentId);
    if (!existing) return err(res, "Not found", 404);
    db.prepare("DELETE FROM shipment_cost_lines WHERE id=?").run(req.params.id);
    logEntityEvent('cost_line', req.params.id, 'DELETED', null, null, null,
      JSON.stringify({ shipmentId: existing.shipment_id, type: existing.type, chargeCode: existing.charge_code, amount: existing.amount, currency: existing.currency, source: existing.source || 'manual' }));
    ok(res, { deleted: req.params.id });
  });

  app.get("/api/shipments/:id/cost-line-events", (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM entity_events
      WHERE entity_type = 'cost_line'
      AND json_extract(meta, '$.shipmentId') = ?
      ORDER BY created_at DESC
    `).all(req.params.id);
    ok(res, rows);
  });

  // ─── Milestones ───────────────────────────────────────────────────────────

  app.get("/api/shipments/:id/milestones", (req, res) => {
    const rows = db.prepare("SELECT * FROM shipment_milestones WHERE shipment_id=? ORDER BY sequence_order ASC").all(req.params.id);
    ok(res, rows.map(mapMilestone));
  });

  app.post("/api/shipments/:id/milestones/init", (req, res) => {
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    const carrierCode = req.body?.carrierCode || shipment.carrier_code || '';
    const tradeLane   = req.body?.tradeLane || '';
    let templates = carrierCode
      ? db.prepare("SELECT * FROM milestone_templates WHERE carrier_code=? AND trade_lane=? ORDER BY sequence_order").all(carrierCode, tradeLane)
      : [];
    if (!templates.length && carrierCode)
      templates = db.prepare("SELECT * FROM milestone_templates WHERE carrier_code=? AND trade_lane='' ORDER BY sequence_order").all(carrierCode);
    if (!templates.length)
      templates = db.prepare("SELECT * FROM milestone_templates WHERE template_key='FCL' AND carrier_code='' ORDER BY sequence_order").all();
    if (!templates.length) return err(res, "No milestone template found");
    db.prepare("DELETE FROM shipment_milestones WHERE shipment_id=?").run(req.params.id);
    const now = new Date().toISOString();
    const created = [];
    for (const t of templates) {
      const id = `MS-${uid()}`;
      db.prepare("INSERT INTO shipment_milestones (id,shipment_id,milestone_key,label,sequence_order,estimated_date,completed_at,completed_by,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, req.params.id, t.milestone_key, t.label, t.sequence_order, '', '', '', '', now);
      created.push(mapMilestone({ id, shipment_id: req.params.id, milestone_key: t.milestone_key, label: t.label, sequence_order: t.sequence_order, estimated_date: '', completed_at: '', completed_by: '', note: '', created_at: now }));
    }
    ok(res, created, 201);
  });

  app.put("/api/milestones/:id", (req, res) => {
    const { estimatedDate = '', completedAt = '', completedBy = '', note = '' } = req.body || {};
    const existing = db.prepare("SELECT * FROM shipment_milestones WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    db.prepare("UPDATE shipment_milestones SET estimated_date=?,completed_at=?,completed_by=?,note=? WHERE id=?")
      .run(estimatedDate, completedAt, completedBy, note, req.params.id);
    ok(res, mapMilestone({ ...existing, estimated_date: estimatedDate, completed_at: completedAt, completed_by: completedBy, note }));
  });

  app.delete("/api/milestones/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM shipment_milestones WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    db.prepare("DELETE FROM shipment_milestones WHERE id=?").run(req.params.id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Documents ────────────────────────────────────────────────────────────

  app.get("/api/shipments/:id/documents", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM shipment_documents WHERE shipment_id = ? ORDER BY created_at DESC").all(req.params.id);
    ok(res, rows.map(r => mapDoc(r, req.params.id)));
  });

  app.post("/api/shipments/:id/documents", auth(), (req, res) => {
    const { filename, mimeType, docType, data } = req.body;
    if (!filename || !data) return err(res, "filename and data are required");
    try {
      const buf        = Buffer.from(data, "base64");
      const ext        = path.extname(filename) || "";
      const storedName = `${Date.now()}_${uid()}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buf);
      const id       = `DOC-${uid()}`;
      const now      = new Date().toISOString();
      const uploader = req.user?.name || req.user?.email || "";
      db.prepare(`INSERT INTO shipment_documents
        (id, shipment_id, filename, stored_name, mime_type, size_bytes, doc_type, uploaded_by, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`)
        .run(id, req.params.id, filename, storedName, mimeType || "", buf.length, docType || "OT", uploader, now);
      const row = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(id);
      ok(res, mapDoc(row, req.params.id), 201);
    } catch (e) { err(res, e.message, 500); }
  });

  app.patch("/api/documents/:docId", auth(), (req, res) => {
    const doc = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(req.params.docId);
    if (!doc) return err(res, "Not found", 404);
    const { status } = req.body;
    if (!["draft", "confirmed"].includes(status)) return err(res, "status must be draft or confirmed");
    const now = new Date().toISOString();
    db.prepare("UPDATE shipment_documents SET status=?, confirmed_at=?, confirmed_by=? WHERE id=?")
      .run(status, status === "confirmed" ? now : null, status === "confirmed" ? (req.user?.name || req.user?.email || "") : "", req.params.docId);
    const updated = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(req.params.docId);
    ok(res, mapDoc(updated, updated.shipment_id));
  });

  app.get("/api/documents/:docId/download", auth(), (req, res) => {
    const doc = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(req.params.docId);
    if (!doc) return err(res, "Not found", 404);
    const filePath = path.join(UPLOADS_DIR, doc.stored_name);
    if (!fs.existsSync(filePath)) return err(res, "File not found on disk", 404);
    const inline = (doc.mime_type || "").startsWith("text/") || doc.mime_type === "application/pdf";
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${doc.filename}"`);
    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    fs.createReadStream(filePath).pipe(res);
  });

  app.delete("/api/documents/:docId", auth(), (req, res) => {
    const doc = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(req.params.docId);
    if (!doc) return err(res, "Not found", 404);
    try { fs.unlinkSync(path.join(UPLOADS_DIR, doc.stored_name)); } catch {}
    db.prepare("DELETE FROM shipment_documents WHERE id = ?").run(req.params.docId);
    ok(res, { ok: true });
  });

  // ─── Milestone Templates ──────────────────────────────────────────────────

  app.get("/api/milestone-templates", (req, res) => {
    const rows = db.prepare("SELECT * FROM milestone_templates ORDER BY template_key, carrier_code, sequence_order").all();
    ok(res, rows.map(mapMilestoneTemplate));
  });

  app.post("/api/milestone-templates", (req, res) => {
    const { templateKey = 'FCL', carrierCode = '', tradeLane = '', milestoneKey, label, sequenceOrder = 0 } = req.body || {};
    if (!milestoneKey || !label) return err(res, "milestoneKey and label required");
    const id = `MT-${uid()}`;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO milestone_templates (id,template_key,carrier_code,trade_lane,milestone_key,label,sequence_order,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, templateKey, carrierCode, tradeLane, milestoneKey, label, Number(sequenceOrder), now);
    ok(res, mapMilestoneTemplate({ id, template_key: templateKey, carrier_code: carrierCode, trade_lane: tradeLane, milestone_key: milestoneKey, label, sequence_order: Number(sequenceOrder), created_at: now }), 201);
  });

  app.put("/api/milestone-templates/:id", (req, res) => {
    const { templateKey, carrierCode = '', tradeLane = '', milestoneKey, label, sequenceOrder } = req.body || {};
    const existing = db.prepare("SELECT * FROM milestone_templates WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const tKey = templateKey || existing.template_key;
    const mKey = milestoneKey || existing.milestone_key;
    const lbl  = label || existing.label;
    const seq  = sequenceOrder != null ? Number(sequenceOrder) : existing.sequence_order;
    db.prepare("UPDATE milestone_templates SET template_key=?,carrier_code=?,trade_lane=?,milestone_key=?,label=?,sequence_order=? WHERE id=?")
      .run(tKey, carrierCode, tradeLane, mKey, lbl, seq, req.params.id);
    ok(res, mapMilestoneTemplate({ id: req.params.id, template_key: tKey, carrier_code: carrierCode, trade_lane: tradeLane, milestone_key: mKey, label: lbl, sequence_order: seq, created_at: existing.created_at }));
  });

  app.delete("/api/milestone-templates/:id", (req, res) => {
    const existing = db.prepare("SELECT * FROM milestone_templates WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    db.prepare("DELETE FROM milestone_templates WHERE id=?").run(req.params.id);
    ok(res, { deleted: req.params.id });
  });

  // ─── Shipment Schedules ───────────────────────────────────────────────────

  const mapSchedule = r => ({
    id:            r.id,
    shipmentId:    r.shipment_id,
    carrier:       r.carrier       || "",
    vesselName:    r.vessel_name   || "",
    voyageNumber:  r.voyage_number || "",
    service:       r.service       || "",
    pol:           r.pol           || "",
    pod:           r.pod           || "",
    etd:           r.etd           || "",
    eta:           r.eta           || "",
    transitDays:   r.transit_days  || 0,
    isMock:        !!r.is_mock,
    savedAt:       r.saved_at,
    savedBy:       r.saved_by      || "",
  });

  app.get("/api/shipments/:id/schedules", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM shipment_schedules WHERE shipment_id=? ORDER BY saved_at DESC")
      .all(req.params.id);
    ok(res, rows.map(mapSchedule));
  });

  app.post("/api/shipments/:id/schedules", auth(), (req, res) => {
    if (!db.prepare("SELECT id FROM shipments WHERE id=?").get(req.params.id))
      return err(res, "Shipment not found", 404);
    const { carrier = "", vesselName = "", voyageNumber = "", service = "",
            pol = "", pod = "", etd = "", eta = "", transitDays = 0, isMock = false } = req.body;
    const id = `SCHED-${uid()}`;
    const savedAt = new Date().toISOString();
    const savedBy = req.user?.name || req.user?.email || "";
    db.prepare(`INSERT INTO shipment_schedules
      (id, shipment_id, carrier, vessel_name, voyage_number, service, pol, pod, etd, eta, transit_days, is_mock, saved_at, saved_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.params.id, carrier, vesselName, voyageNumber, service, pol, pod, etd, eta,
           Number(transitDays), isMock ? 1 : 0, savedAt, savedBy);
    ok(res, mapSchedule({ id, shipment_id: req.params.id, carrier, vessel_name: vesselName,
      voyage_number: voyageNumber, service, pol, pod, etd, eta,
      transit_days: Number(transitDays), is_mock: isMock ? 1 : 0, saved_at: savedAt, saved_by: savedBy }), 201);
  });

  app.delete("/api/shipments/:id/schedules/:scheduleId", auth(), (req, res) => {
    const info = db.prepare("DELETE FROM shipment_schedules WHERE id=? AND shipment_id=?")
      .run(req.params.scheduleId, req.params.id);
    if (info.changes === 0) return err(res, "Not found", 404);
    ok(res, { deleted: req.params.scheduleId });
  });
};
