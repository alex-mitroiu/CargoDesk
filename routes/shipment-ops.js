"use strict";

module.exports = function shipmentOpsRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole,
          mapCostLine, mapService, mapMilestone, mapMilestoneTemplate,
          sanctionsMap, screenShipmentById,
          logEntityEvent, importContractRates, createRateSnapshot, generateCostLinesFromSnapshot,
          mapRateSnapshot,
          UPLOADS_DIR, fs, path } = ctx;

  const shipmentWrite = requireRole(["admin", "operator", "occ_bk"]);

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
      containerId: r.container_id || '', responsibleParty: r.responsible_party || '',
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

  app.post("/api/shipments/:id/cost-lines/import-contract", shipmentWrite, (req, res) => {
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

  // Replays the shipment's existing frozen rate snapshot — does NOT read live contract_rates,
  // so a reset never silently changes what was already committed to the client.
  app.post("/api/shipments/:id/cost-lines/reset-to-contract", shipmentWrite, (req, res) => {
    const { splitPerContainer = false } = req.body || {};
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (shipment.contract_type !== 'Central' || !shipment.contract_id)
      return err(res, "Shipment is not linked to a Central contract");
    const snapshot = db.prepare("SELECT id FROM shipment_rate_snapshots WHERE shipment_id=? ORDER BY generated_at DESC LIMIT 1").get(req.params.id);
    if (!snapshot) return err(res, "No rate snapshot found for this shipment — use Import from Contract first");
    const existingSell = db.prepare("SELECT id FROM shipment_cost_lines WHERE shipment_id=? AND type='SELL' AND source='contract'").all(req.params.id);
    const includeSell = existingSell.length > 0;
    for (const row of db.prepare("SELECT id FROM shipment_cost_lines WHERE shipment_id=? AND source='contract'").all(req.params.id))
      db.prepare("DELETE FROM shipment_cost_lines WHERE id=?").run(row.id);
    const count = generateCostLinesFromSnapshot(req.params.id, snapshot.id, { splitPerContainer, includeSell });
    ok(res, { imported: count, snapshotId: snapshot.id });
  });

  // Pulls CURRENT live contract_rates into a NEW frozen snapshot, then regenerates cost lines
  // from it — the only action that changes the committed rate (carrier rates can move; this is
  // how that gets picked up deliberately, with a record of when/why it happened).
  app.post("/api/shipments/:id/cost-lines/update-carrier-costs", shipmentWrite, (req, res) => {
    const { splitPerContainer = false } = req.body || {};
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (shipment.contract_type !== 'Central' || !shipment.contract_id)
      return err(res, "Shipment is not linked to a Central contract");
    const snapshotId = createRateSnapshot(req.params.id, shipment.contract_id, 'carrier_update', req.user?.email || '');
    if (!snapshotId) return err(res, "Contract has no rates to snapshot");
    const existingSell = db.prepare("SELECT id FROM shipment_cost_lines WHERE shipment_id=? AND type='SELL' AND source='contract'").all(req.params.id);
    const includeSell = existingSell.length > 0;
    for (const row of db.prepare("SELECT id FROM shipment_cost_lines WHERE shipment_id=? AND source='contract'").all(req.params.id))
      db.prepare("DELETE FROM shipment_cost_lines WHERE id=?").run(row.id);
    const count = generateCostLinesFromSnapshot(req.params.id, snapshotId, { splitPerContainer, includeSell });
    ok(res, { imported: count, snapshotId });
  });

  app.get("/api/shipments/:id/rate-snapshots", (req, res) => {
    const rows = db.prepare("SELECT * FROM shipment_rate_snapshots WHERE shipment_id=? ORDER BY generated_at DESC").all(req.params.id);
    ok(res, rows.map(mapRateSnapshot));
  });

  app.get("/api/shipments/:id/cost-lines", (req, res) => {
    const rows = db.prepare("SELECT * FROM shipment_cost_lines WHERE shipment_id=? ORDER BY type, created_at ASC").all(req.params.id);
    ok(res, rows.map(mapCostLine));
  });

  app.post("/api/shipments/:id/cost-lines", shipmentWrite, (req, res) => {
    const { type, chargeCode, currency = 'USD', amount, exchangeRate = 1, vatRate = 0, notes = '', containerId = '', source: rawSource } = req.body;
    if (!type || !chargeCode || amount == null) return err(res, "type, chargeCode, amount required");
    if (!['BUY','SELL'].includes(type)) return err(res, "type must be BUY or SELL");
    const source = ['contract', 'mirror'].includes(rawSource) ? rawSource : 'manual';
    const vat = type === 'SELL' ? Number(vatRate) || 0 : 0;
    const id  = `CL-${uid()}`;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,vat_rate,notes,container_id,created_at,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.params.id, type, chargeCode, currency.toUpperCase(), Number(amount), Number(exchangeRate), vat, notes, containerId, now, source);
    logEntityEvent('cost_line', id, 'CREATED', null, null, null,
      JSON.stringify({ shipmentId: req.params.id, type, chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchangeRate: Number(exchangeRate), vatRate: vat }));
    ok(res, mapCostLine({ id, shipment_id: req.params.id, type, charge_code: chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchange_rate: Number(exchangeRate), vat_rate: vat, notes, container_id: containerId, source, modified_at: null, created_at: now }), 201);
  });

  app.put("/api/shipments/:shipmentId/cost-lines/:id", shipmentWrite, (req, res) => {
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

  app.delete("/api/shipments/:shipmentId/cost-lines/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=? AND shipment_id=?").get(req.params.id, req.params.shipmentId);
    if (!existing) return err(res, "Not found", 404);
    db.prepare("DELETE FROM shipment_cost_lines WHERE id=?").run(req.params.id);
    logEntityEvent('cost_line', req.params.id, 'DELETED', null, null, null,
      JSON.stringify({ shipmentId: existing.shipment_id, type: existing.type, chargeCode: existing.charge_code, amount: existing.amount, currency: existing.currency, source: existing.source || 'manual' }));

    // If this was the last SELL line for its scope, any still-draft invoice generated for
    // that scope is now backed by nothing — clean it up so it doesn't sit there looking
    // valid. Consolidated invoices (container_id='') cover ALL SELL lines regardless of
    // container tag, so they only clear when the shipment has none left at all; a
    // per-container invoice clears as soon as ITS container has no SELL lines left. A
    // CONFIRMED invoice is never touched here — that's the record of what was sent.
    if (existing.type === 'SELL') {
      const scopesToClean = [];
      const remainingTotal = db.prepare("SELECT COUNT(*) as n FROM shipment_cost_lines WHERE shipment_id=? AND type='SELL'")
        .get(req.params.shipmentId).n;
      if (remainingTotal === 0) scopesToClean.push('');
      if (existing.container_id) {
        const remainingForContainer = db.prepare("SELECT COUNT(*) as n FROM shipment_cost_lines WHERE shipment_id=? AND type='SELL' AND container_id=?")
          .get(req.params.shipmentId, existing.container_id).n;
        if (remainingForContainer === 0) scopesToClean.push(existing.container_id);
      }
      for (const scope of scopesToClean) {
        const orphaned = db.prepare(`SELECT * FROM shipment_documents
          WHERE shipment_id=? AND (doc_type='FR01' OR doc_type='FR02') AND container_id=? AND status != 'confirmed'`)
          .all(req.params.shipmentId, scope);
        for (const doc of orphaned) {
          try { fs.unlinkSync(path.join(UPLOADS_DIR, doc.stored_name)); } catch {}
          db.prepare("DELETE FROM shipment_documents WHERE id=?").run(doc.id);
          logEntityEvent('document', doc.id, 'AUTO_REMOVED', null, null, null,
            JSON.stringify({ shipmentId: req.params.shipmentId, docType: doc.doc_type, filename: doc.filename,
              containerId: doc.container_id || '', reason: 'No remaining charge lines for this scope' }));
        }
      }
    }
    ok(res, { deleted: req.params.id });
  });

  // Despite the route name (kept for backward compatibility with existing frontend calls),
  // this also returns 'document' entity_events — the Accounting History modal covers both
  // cost/invoice lines AND generated invoice documents (generated/confirmed/deleted).
  app.get("/api/shipments/:id/cost-line-events", (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM entity_events
      WHERE entity_type IN ('cost_line', 'document')
      AND json_extract(meta, '$.shipmentId') = ?
      ORDER BY created_at DESC
    `).all(req.params.id);
    ok(res, rows);
  });

  // ─── Dedicated Services (TKT-9DGDNP) ───────────────────────────────────────
  // Ancillary services (VGM, Haulage, Fumigation, Storage, Customs, ...) ordered
  // independently per Export/Import side, with a Requested→Confirmed→Completed
  // (or Cancelled) lifecycle. Deliberately independent of shipment_legs — see
  // plan notes; a leg tracks physical routing, a service tracks who's ordering
  // an ancillary activity and its status.
  const SERVICE_STATUSES = ["Requested", "Confirmed", "Completed", "Cancelled"];

  const SERVICE_SELECT = `
    SELECT ss.*, o.code AS office_code, o.name AS office_name
    FROM shipment_services ss
    LEFT JOIN offices o ON o.id = ss.office_id
  `;

  app.get("/api/shipments/:id/services", auth(), (req, res) => {
    const rows = db.prepare(`${SERVICE_SELECT} WHERE ss.shipment_id=? ORDER BY ss.side, ss.created_at ASC`)
      .all(req.params.id);
    ok(res, rows.map(mapService));
  });

  app.post("/api/shipments/:id/services", shipmentWrite, (req, res) => {
    const { side, serviceType, vendorId = '', vendorName = '', officeId = '',
            requestedDate = '', notes = '' } = req.body;
    if (!side || !serviceType) return err(res, "side, serviceType required");
    if (!['Export', 'Import'].includes(side)) return err(res, "side must be Export or Import");
    const id  = `SVC-${uid()}`;
    const now = new Date().toISOString();
    const createdBy = req.user?.name || req.user?.email || "";
    db.prepare(`INSERT INTO shipment_services
      (id, shipment_id, side, service_type, status, vendor_id, vendor_name, office_id,
       requested_date, notes, created_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, req.params.id, side, serviceType, 'Requested', vendorId, vendorName, officeId,
           requestedDate, notes, now, createdBy);
    logEntityEvent('service', id, 'REQUESTED', null, null, null,
      JSON.stringify({ shipmentId: req.params.id, side, serviceType, vendorName }));
    const row = db.prepare(`${SERVICE_SELECT} WHERE ss.id=?`).get(id);
    ok(res, mapService(row), 201);
  });

  app.patch("/api/shipments/:shipmentId/services/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM shipment_services WHERE id=? AND shipment_id=?")
      .get(req.params.id, req.params.shipmentId);
    if (!existing) return err(res, "Not found", 404);

    if (req.body.status && !SERVICE_STATUSES.includes(req.body.status))
      return err(res, `status must be one of ${SERVICE_STATUSES.join(", ")}`);

    // req.body is camelCase (API convention); existing is a raw snake_case DB row —
    // map each field explicitly rather than spreading the two together, which would
    // silently leave e.g. `officeId` sitting unused next to the untouched `office_id`.
    const side          = req.body.side          !== undefined ? req.body.side          : existing.side;
    const serviceType   = req.body.serviceType   !== undefined ? req.body.serviceType   : existing.service_type;
    const status         = req.body.status         !== undefined ? req.body.status         : existing.status;
    const vendorId        = req.body.vendorId        !== undefined ? req.body.vendorId        : existing.vendor_id;
    const vendorName      = req.body.vendorName      !== undefined ? req.body.vendorName      : existing.vendor_name;
    const officeId         = req.body.officeId         !== undefined ? req.body.officeId         : existing.office_id;
    const requestedDate     = req.body.requestedDate     !== undefined ? req.body.requestedDate     : existing.requested_date;
    const notes              = req.body.notes              !== undefined ? req.body.notes              : existing.notes;

    const today = new Date().toISOString().slice(0, 10);
    let confirmedDate = existing.confirmed_date;
    let completedDate = existing.completed_date;
    if (status === 'Confirmed' && !confirmedDate) confirmedDate = today;
    if (status === 'Completed' && !completedDate) completedDate = today;

    db.prepare(`UPDATE shipment_services SET side=?, service_type=?, status=?, vendor_id=?,
      vendor_name=?, office_id=?, requested_date=?, confirmed_date=?, completed_date=?, notes=?
      WHERE id=?`)
      .run(side, serviceType, status, vendorId, vendorName, officeId, requestedDate,
           confirmedDate, completedDate, notes, req.params.id);

    for (const [field, oldV, newV] of [
      ['status',       existing.status,        status],
      ['vendor_name',  existing.vendor_name,    vendorName],
      ['office_id',    existing.office_id,      officeId],
      ['notes',        existing.notes || '',    notes || ''],
    ]) {
      if (String(oldV || '') !== String(newV || ''))
        logEntityEvent('service', req.params.id, 'UPDATED', field, oldV, newV,
          JSON.stringify({ shipmentId: existing.shipment_id, side, serviceType }));
    }

    const row = db.prepare(`${SERVICE_SELECT} WHERE ss.id=?`).get(req.params.id);
    ok(res, mapService(row));
  });

  app.delete("/api/shipments/:shipmentId/services/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM shipment_services WHERE id=? AND shipment_id=?")
      .get(req.params.id, req.params.shipmentId);
    if (!existing) return err(res, "Not found", 404);
    db.prepare("DELETE FROM shipment_services WHERE id=?").run(req.params.id);
    logEntityEvent('service', req.params.id, 'DELETED', null, null, null,
      JSON.stringify({ shipmentId: existing.shipment_id, side: existing.side, serviceType: existing.service_type }));
    ok(res, { deleted: req.params.id });
  });

  // ─── Milestones ───────────────────────────────────────────────────────────

  app.get("/api/shipments/:id/milestones", (req, res) => {
    const rows = db.prepare("SELECT * FROM shipment_milestones WHERE shipment_id=? ORDER BY sequence_order ASC").all(req.params.id);
    ok(res, rows.map(mapMilestone));
  });

  app.post("/api/shipments/:id/milestones/init", shipmentWrite, (req, res) => {
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    const carrierCode = req.body?.carrierCode || shipment.carrier_code || '';
    const tradeLane   = req.body?.tradeLane || '';
    const etd = req.body?.etd || shipment.etd || '';
    const eta = req.body?.eta || shipment.eta || '';

    let templates = carrierCode
      ? db.prepare("SELECT * FROM milestone_templates WHERE carrier_code=? AND trade_lane=? ORDER BY sequence_order").all(carrierCode, tradeLane)
      : [];
    if (!templates.length && carrierCode)
      templates = db.prepare("SELECT * FROM milestone_templates WHERE carrier_code=? AND trade_lane='' ORDER BY sequence_order").all(carrierCode);
    if (!templates.length)
      templates = db.prepare("SELECT * FROM milestone_templates WHERE template_key='FCL' AND carrier_code='' ORDER BY sequence_order").all();
    if (!templates.length) return err(res, "No milestone template found");

    // Compute estimated dates relative to ETD/ETA when available
    const DATE_OFFSETS = {
      booking_confirmed: { base: etd, days: -21 },
      si_submitted:      { base: etd, days: -14 },
      cargo_gated_in:    { base: etd, days:  -5 },
      vessel_departed:   { base: etd, days:   0 },
      bl_issued:         { base: etd, days:   2 },
      vessel_arrived:    { base: eta, days:   0 },
      customs_cleared:   { base: eta, days:   1 },
      cargo_released:    { base: eta, days:   2 },
      delivered:         { base: eta, days:   3 },
    };
    const shiftDate = (d, days) => {
      if (!d) return '';
      try { const dt = new Date(d); dt.setDate(dt.getDate() + days); return dt.toISOString().slice(0, 10); }
      catch { return ''; }
    };

    db.prepare("DELETE FROM shipment_milestones WHERE shipment_id=?").run(req.params.id);
    const now = new Date().toISOString();
    const created = [];
    for (const t of templates) {
      const id = `MS-${uid()}`;
      const off = DATE_OFFSETS[t.milestone_key];
      const estimatedDate = off ? shiftDate(off.base, off.days) : '';
      db.prepare("INSERT INTO shipment_milestones (id,shipment_id,milestone_key,label,sequence_order,estimated_date,completed_at,completed_by,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, req.params.id, t.milestone_key, t.label, t.sequence_order, estimatedDate, '', '', '', now);
      created.push(mapMilestone({ id, shipment_id: req.params.id, milestone_key: t.milestone_key, label: t.label, sequence_order: t.sequence_order, estimated_date: estimatedDate, completed_at: '', completed_by: '', note: '', created_at: now }));
    }
    ok(res, created, 201);
  });

  app.put("/api/milestones/:id", shipmentWrite, (req, res) => {
    const { estimatedDate = '', completedAt = '', completedBy = '', note = '' } = req.body || {};
    const existing = db.prepare("SELECT * FROM shipment_milestones WHERE id=?").get(req.params.id);
    if (!existing) return err(res, "Not found", 404);
    db.prepare("UPDATE shipment_milestones SET estimated_date=?,completed_at=?,completed_by=?,note=? WHERE id=?")
      .run(estimatedDate, completedAt, completedBy, note, req.params.id);
    ok(res, mapMilestone({ ...existing, estimated_date: estimatedDate, completed_at: completedAt, completed_by: completedBy, note }));
  });

  app.delete("/api/milestones/:id", shipmentWrite, (req, res) => {
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

  app.post("/api/shipments/:id/documents", shipmentWrite, (req, res) => {
    const { filename, mimeType, docType, data, containerId = '', responsibleParty = '' } = req.body;
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
        (id, shipment_id, filename, stored_name, mime_type, size_bytes, doc_type, uploaded_by, created_at, status, container_id, responsible_party)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`)
        .run(id, req.params.id, filename, storedName, mimeType || "", buf.length, docType || "OT", uploader, now, containerId, responsibleParty);
      logEntityEvent('document', id, 'GENERATED', null, null, null,
        JSON.stringify({ shipmentId: req.params.id, docType: docType || "OT", filename, containerId }));
      const row = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(id);
      ok(res, mapDoc(row, req.params.id), 201);
    } catch (e) { err(res, e.message, 500); }
  });

  app.patch("/api/documents/:docId", shipmentWrite, (req, res) => {
    const doc = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(req.params.docId);
    if (!doc) return err(res, "Not found", 404);
    const { status } = req.body;
    if (!["draft", "confirmed"].includes(status)) return err(res, "status must be draft or confirmed");
    const now = new Date().toISOString();
    db.prepare("UPDATE shipment_documents SET status=?, confirmed_at=?, confirmed_by=? WHERE id=?")
      .run(status, status === "confirmed" ? now : null, status === "confirmed" ? (req.user?.name || req.user?.email || "") : "", req.params.docId);
    if (status === "confirmed" && doc.status !== "confirmed") {
      logEntityEvent('document', req.params.docId, 'CONFIRMED', null, null, null,
        JSON.stringify({ shipmentId: doc.shipment_id, docType: doc.doc_type, filename: doc.filename, containerId: doc.container_id || '' }));
    }
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

  app.delete("/api/documents/:docId", shipmentWrite, (req, res) => {
    const doc = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(req.params.docId);
    if (!doc) return err(res, "Not found", 404);
    try { fs.unlinkSync(path.join(UPLOADS_DIR, doc.stored_name)); } catch {}
    db.prepare("DELETE FROM shipment_documents WHERE id = ?").run(req.params.docId);
    logEntityEvent('document', req.params.docId, 'DELETED', null, null, null,
      JSON.stringify({ shipmentId: doc.shipment_id, docType: doc.doc_type, filename: doc.filename, containerId: doc.container_id || '' }));
    ok(res, { ok: true });
  });

  // ─── Milestone Templates ──────────────────────────────────────────────────

  app.get("/api/milestone-templates", (req, res) => {
    const rows = db.prepare("SELECT * FROM milestone_templates ORDER BY template_key, carrier_code, sequence_order").all();
    ok(res, rows.map(mapMilestoneTemplate));
  });

  app.post("/api/milestone-templates", shipmentWrite, (req, res) => {
    const { templateKey = 'FCL', carrierCode = '', tradeLane = '', milestoneKey, label, sequenceOrder = 0 } = req.body || {};
    if (!milestoneKey || !label) return err(res, "milestoneKey and label required");
    const id = `MT-${uid()}`;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO milestone_templates (id,template_key,carrier_code,trade_lane,milestone_key,label,sequence_order,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, templateKey, carrierCode, tradeLane, milestoneKey, label, Number(sequenceOrder), now);
    ok(res, mapMilestoneTemplate({ id, template_key: templateKey, carrier_code: carrierCode, trade_lane: tradeLane, milestone_key: milestoneKey, label, sequence_order: Number(sequenceOrder), created_at: now }), 201);
  });

  app.put("/api/milestone-templates/:id", shipmentWrite, (req, res) => {
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

  app.delete("/api/milestone-templates/:id", shipmentWrite, (req, res) => {
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

  app.post("/api/shipments/:id/schedules", shipmentWrite, (req, res) => {
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
    logEntityEvent('schedule', id, 'SAVED', null, null, null,
      JSON.stringify({ shipmentId: req.params.id, carrier, vesselName, voyageNumber, service, pol, pod, etd, eta, actor: savedBy }));
    ok(res, mapSchedule({ id, shipment_id: req.params.id, carrier, vessel_name: vesselName,
      voyage_number: voyageNumber, service, pol, pod, etd, eta,
      transit_days: Number(transitDays), is_mock: isMock ? 1 : 0, saved_at: savedAt, saved_by: savedBy }), 201);
  });

  app.delete("/api/shipments/:id/schedules/:scheduleId", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM shipment_schedules WHERE id=? AND shipment_id=?")
      .get(req.params.scheduleId, req.params.id);
    if (!existing) return err(res, "Not found", 404);
    db.prepare("DELETE FROM shipment_schedules WHERE id=?").run(req.params.scheduleId);
    logEntityEvent('schedule', req.params.scheduleId, 'REMOVED', null, null, null,
      JSON.stringify({ shipmentId: req.params.id, carrier: existing.carrier, vesselName: existing.vessel_name,
        voyageNumber: existing.voyage_number, service: existing.service, pol: existing.pol, pod: existing.pod,
        actor: req.user?.name || req.user?.email || "" }));
    ok(res, { deleted: req.params.scheduleId });
  });

  app.get("/api/shipments/:id/schedule-events", (req, res) => {
    const rows = db.prepare(`
      SELECT * FROM entity_events
      WHERE entity_type = 'schedule'
      AND json_extract(meta, '$.shipmentId') = ?
      ORDER BY created_at DESC
    `).all(req.params.id);
    ok(res, rows);
  });
};
