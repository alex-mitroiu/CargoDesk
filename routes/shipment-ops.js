"use strict";

module.exports = function shipmentOpsRoutes(app, ctx) {
  const { db, ok, err, uid, auth, requireRole,
          mapCostLine, mapService, mapMilestone, mapMilestoneTemplate,
          sanctionsMap, screenShipmentById,
          logEntityEvent, importContractRates, createRateSnapshot, generateCostLinesFromSnapshot,
          mapRateSnapshot, syncShipmentFromLegs, ensureBookingCreated,
          UPLOADS_DIR, fs, path,
          renderHtmlToPdf, getActiveSigningCert, signPdfBuffer,
          buildMailOptions, sendViaOffice } = ctx;

  const shipmentWrite = requireRole(["admin", "operator", "occ_bk"]);

  // Cost lines are hidden from trade_manager (and viewer) unless canViewFinance is set on
  // their account — mirrors routes/finance.js's inline margin-access check, but admin/
  // operator/occ_bk always pass since they need cost-line data for normal shipment ops,
  // unlike the Finance/Margin dashboard which defaults to admin-only.
  const costLineRead = (req, res, next) => {
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [req.user?.role || 'viewer'];
    const hasOpsAccess = roles.some(r => ['admin', 'operator', 'occ_bk'].includes(r));
    if (!hasOpsAccess && !req.user?.canViewFinance) return err(res, "Cost line access not enabled for your account", 403);
    next();
  };

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

  app.get("/api/shipments/:id/rate-snapshots", costLineRead, (req, res) => {
    const rows = db.prepare("SELECT * FROM shipment_rate_snapshots WHERE shipment_id=? ORDER BY generated_at DESC").all(req.params.id);
    ok(res, rows.map(mapRateSnapshot));
  });

  app.get("/api/shipments/:id/cost-lines", costLineRead, (req, res) => {
    const rows = db.prepare("SELECT * FROM shipment_cost_lines WHERE shipment_id=? ORDER BY type, created_at ASC").all(req.params.id);
    ok(res, rows.map(mapCostLine));
  });

  app.post("/api/shipments/:id/cost-lines", shipmentWrite, (req, res) => {
    const { type, chargeCode, currency = 'USD', amount, exchangeRate = 1, vatRate = 0, notes = '', containerId = '', source: rawSource, paymentIndicator: rawPI } = req.body;
    if (!type || !chargeCode || amount == null) return err(res, "type, chargeCode, amount required");
    if (!['BUY','SELL'].includes(type)) return err(res, "type must be BUY or SELL");
    const source = ['contract', 'mirror', 'automated'].includes(rawSource) ? rawSource : 'manual';
    const paymentIndicator = rawPI === 'Collect' ? 'Collect' : 'Prepaid';
    const vat = type === 'SELL' ? Number(vatRate) || 0 : 0;
    const id  = `CL-${uid()}`;
    const now = new Date().toISOString();
    db.prepare("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,vat_rate,notes,container_id,created_at,source,payment_indicator) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, req.params.id, type, chargeCode, currency.toUpperCase(), Number(amount), Number(exchangeRate), vat, notes, containerId, now, source, paymentIndicator);
    logEntityEvent('cost_line', id, 'CREATED', null, null, null,
      JSON.stringify({ shipmentId: req.params.id, type, chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchangeRate: Number(exchangeRate), vatRate: vat }));
    ok(res, mapCostLine({ id, shipment_id: req.params.id, type, charge_code: chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchange_rate: Number(exchangeRate), vat_rate: vat, notes, container_id: containerId, source, payment_indicator: paymentIndicator, modified_at: null, created_at: now }), 201);
  });

  app.put("/api/shipments/:shipmentId/cost-lines/:id", shipmentWrite, (req, res) => {
    const { type, chargeCode, currency = 'USD', amount, exchangeRate = 1, vatRate = 0, notes = '', containerId = '', paymentIndicator: rawPI } = req.body;
    if (!type || !chargeCode || amount == null) return err(res, "type, chargeCode, amount required");
    if (!['BUY','SELL'].includes(type)) return err(res, "type must be BUY or SELL");
    const existing = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=? AND shipment_id=?").get(req.params.id, req.params.shipmentId);
    if (!existing) return err(res, "Not found", 404);
    if (existing.status === 'posted') return err(res, "This line is posted and locked — add a new adjusting line instead of editing it", 409);
    const paymentIndicator = rawPI === 'Collect' ? 'Collect' : 'Prepaid';
    const vat = type === 'SELL' ? Number(vatRate) || 0 : 0;
    const now = new Date().toISOString();
    db.prepare("UPDATE shipment_cost_lines SET type=?,charge_code=?,currency=?,amount=?,exchange_rate=?,vat_rate=?,notes=?,container_id=?,payment_indicator=?,modified_at=? WHERE id=?")
      .run(type, chargeCode, currency.toUpperCase(), Number(amount), Number(exchangeRate), vat, notes, containerId, paymentIndicator, now, req.params.id);
    for (const [field, oldV, newV] of [
      ['type',          existing.type,          type],
      ['charge_code',   existing.charge_code,   chargeCode],
      ['currency',      existing.currency,      currency.toUpperCase()],
      ['amount',        String(existing.amount), String(Number(amount))],
      ['exchange_rate', String(existing.exchange_rate), String(Number(exchangeRate))],
      ['vat_rate',      String(existing.vat_rate || 0), String(vat)],
      ['notes',         existing.notes || '',   notes],
      ['container_id',  existing.container_id || '', containerId],
      ['payment_indicator', existing.payment_indicator || 'Prepaid', paymentIndicator],
    ]) {
      if (String(oldV) !== String(newV))
        logEntityEvent('cost_line', req.params.id, 'UPDATED', field, oldV, newV,
          JSON.stringify({ shipmentId: existing.shipment_id, chargeCode, type }));
    }
    ok(res, mapCostLine({ id: req.params.id, shipment_id: existing.shipment_id, type, charge_code: chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchange_rate: Number(exchangeRate), vat_rate: vat, notes, container_id: containerId, source: existing.source || 'manual', payment_indicator: paymentIndicator, modified_at: now, created_at: existing.created_at }));
  });

  // ─── Accrual / posting state machine (TKT-83O41G) ──────────────────────────
  const postGate = requireRole(["admin", "operator"]);

  app.patch("/api/shipments/:shipmentId/cost-lines/:id/actualize", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=? AND shipment_id=?").get(req.params.id, req.params.shipmentId);
    if (!existing) return err(res, "Not found", 404);
    if (existing.status === 'posted') return err(res, "This line is posted and locked", 409);
    const { actualAmount, actualExchangeRate = existing.exchange_rate } = req.body || {};
    if (actualAmount == null) return err(res, "actualAmount required");
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    db.prepare(`UPDATE shipment_cost_lines
      SET status='actualized', actual_amount=?, actual_exchange_rate=?, actualized_at=?, actualized_by=?
      WHERE id=?`)
      .run(Number(actualAmount), Number(actualExchangeRate), now, actor, req.params.id);
    logEntityEvent('cost_line', req.params.id, 'ACTUALIZED', 'status', existing.status, 'actualized',
      JSON.stringify({ shipmentId: existing.shipment_id, chargeCode: existing.charge_code, type: existing.type,
        accruedAmount: existing.amount, actualAmount: Number(actualAmount) }));
    const row = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=?").get(req.params.id);
    ok(res, mapCostLine(row));
  });

  app.patch("/api/shipments/:shipmentId/cost-lines/:id/post", postGate, (req, res) => {
    const existing = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=? AND shipment_id=?").get(req.params.id, req.params.shipmentId);
    if (!existing) return err(res, "Not found", 404);
    if (existing.status === 'posted') return err(res, "Already posted", 409);
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    db.prepare("UPDATE shipment_cost_lines SET status='posted', posted_at=?, posted_by=? WHERE id=?")
      .run(now, actor, req.params.id);
    logEntityEvent('cost_line', req.params.id, 'POSTED', 'status', existing.status, 'posted',
      JSON.stringify({ shipmentId: existing.shipment_id, chargeCode: existing.charge_code, type: existing.type }));
    const row = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=?").get(req.params.id);
    ok(res, mapCostLine(row));
  });

  // Batch post — same lock/role semantics as the single-line Post above, one entity
  // event per line so the audit trail still reads as individual postings.
  app.post("/api/shipments/:shipmentId/cost-lines/post-batch", postGate, (req, res) => {
    const { ids = [] } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return err(res, "ids required");
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    const posted = [];
    for (const id of ids) {
      const existing = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=? AND shipment_id=?").get(id, req.params.shipmentId);
      if (!existing || existing.status === 'posted') continue;
      db.prepare("UPDATE shipment_cost_lines SET status='posted', posted_at=?, posted_by=? WHERE id=?").run(now, actor, id);
      logEntityEvent('cost_line', id, 'POSTED', 'status', existing.status, 'posted',
        JSON.stringify({ shipmentId: existing.shipment_id, chargeCode: existing.charge_code, type: existing.type }));
      posted.push(id);
    }
    const rows = posted.length
      ? db.prepare(`SELECT * FROM shipment_cost_lines WHERE id IN (${posted.map(() => '?').join(',')})`).all(...posted)
      : [];
    ok(res, rows.map(mapCostLine));
  });

  app.delete("/api/shipments/:shipmentId/cost-lines/:id", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM shipment_cost_lines WHERE id=? AND shipment_id=?").get(req.params.id, req.params.shipmentId);
    if (!existing) return err(res, "Not found", 404);
    if (existing.status === 'posted') return err(res, "This line is posted and locked — add a new adjusting line instead of deleting it", 409);
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
  app.get("/api/shipments/:id/cost-line-events", costLineRead, (req, res) => {
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

  // ─── Loading Plan (per-container, TKT-TR6OBR) ──────────────────────────────
  // Always returns one row per CURRENT container on the shipment (LEFT JOIN),
  // even if no plan data has been entered yet, so the frontend table never needs
  // separate provisioning logic — same "list what should exist, backed by a
  // maybe-absent row" idiom container compliance state already uses.

  const mapLoadingPlanLine = r => ({
    containerId:     r.container_id,
    containerNumber: r.container_number || '',
    size: r.size, type: r.type,
    plannedDate:     r.planned_date || '',
    sequenceOrder:   r.sequence_order ?? 1,
    notes:           r.notes || '',
    updatedAt:       r.updated_at || null,
  });

  const LOADING_PLAN_SELECT = `
    SELECT c.id AS container_id, c.container_number, c.size, c.type,
           l.planned_date, l.sequence_order, l.notes, l.updated_at
    FROM containers c
    LEFT JOIN shipment_loading_plan_lines l ON l.container_id = c.id AND l.service_id = ?
    WHERE c.shipment_id = ?
  `;

  app.get("/api/shipments/:shipmentId/services/:serviceId/loading-plan", auth(), (req, res) => {
    const service = db.prepare("SELECT * FROM shipment_services WHERE id=? AND shipment_id=?")
      .get(req.params.serviceId, req.params.shipmentId);
    if (!service) return err(res, "Service not found", 404);
    const rows = db.prepare(`${LOADING_PLAN_SELECT}
      ORDER BY (l.sequence_order IS NULL), l.sequence_order ASC, c.container_number ASC`)
      .all(req.params.serviceId, req.params.shipmentId);
    ok(res, rows.map(mapLoadingPlanLine));
  });

  app.put("/api/shipments/:shipmentId/services/:serviceId/loading-plan/:containerId", shipmentWrite, (req, res) => {
    const service = db.prepare("SELECT * FROM shipment_services WHERE id=? AND shipment_id=?")
      .get(req.params.serviceId, req.params.shipmentId);
    if (!service) return err(res, "Service not found", 404);
    const container = db.prepare("SELECT * FROM containers WHERE id=? AND shipment_id=?")
      .get(req.params.containerId, req.params.shipmentId);
    if (!container) return err(res, "Container not found", 404);

    // Sequence is a display/print ordering for the physical loading/unloading/pickup/delivery
    // plan — "0th" or negative has no real-world meaning there, so 1 is the floor regardless
    // of what the client sends (this table is shared by exactly Loading/Unloading/Pickup/
    // Delivery, nothing else, so no need to branch on the service's own type here).
    const { plannedDate = '', sequenceOrder: rawSequenceOrder = 1, notes = '' } = req.body || {};
    const sequenceOrder = Math.max(1, parseInt(rawSequenceOrder, 10) || 1);
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT 1 FROM shipment_loading_plan_lines WHERE service_id=? AND container_id=?")
      .get(req.params.serviceId, req.params.containerId);
    if (existing) {
      db.prepare(`UPDATE shipment_loading_plan_lines SET planned_date=?, sequence_order=?, notes=?, updated_at=?
        WHERE service_id=? AND container_id=?`)
        .run(plannedDate, sequenceOrder, notes, now, req.params.serviceId, req.params.containerId);
    } else {
      db.prepare(`INSERT INTO shipment_loading_plan_lines
        (service_id, container_id, planned_date, sequence_order, notes, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run(req.params.serviceId, req.params.containerId, plannedDate, sequenceOrder, notes, now, now);
    }
    logEntityEvent('loading_plan_line', `${req.params.serviceId}:${req.params.containerId}`, 'UPDATED', null, null, null,
      JSON.stringify({ shipmentId: req.params.shipmentId, serviceId: req.params.serviceId,
        containerId: req.params.containerId, plannedDate }));

    const row = db.prepare(`${LOADING_PLAN_SELECT.replace("WHERE c.shipment_id = ?", "WHERE c.id = ?")}`)
      .get(req.params.serviceId, req.params.containerId);
    ok(res, mapLoadingPlanLine(row));
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

  // Server-side render + sign counterpart to the plain upload route above — every
  // CargoDesk-generated document (Commercial Invoice, Packing List, loading plans, service
  // docs, ...) goes through this instead of building a blob client-side, so the signing key
  // never has to leave the server. Raw user-attached files keep using the plain upload route
  // untouched — signing a file CargoDesk didn't author would misrepresent who generated it.
  app.post("/api/shipments/:id/documents/generate", shipmentWrite, async (req, res) => {
    const { html, filename, docType, containerId = '', responsibleParty = '' } = req.body;
    if (!html || !filename) return err(res, "html and filename are required");
    try {
      const cert = getActiveSigningCert(db);
      const rawPdf = await renderHtmlToPdf(html);
      const signedPdf = await signPdfBuffer(Buffer.from(rawPdf), cert);

      const pdfFilename = `${path.parse(filename).name}.pdf`;
      const storedName  = `${Date.now()}_${uid()}.pdf`;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), signedPdf);

      const id       = `DOC-${uid()}`;
      const now      = new Date().toISOString();
      const uploader = req.user?.name || req.user?.email || "";
      db.prepare(`INSERT INTO shipment_documents
        (id, shipment_id, filename, stored_name, mime_type, size_bytes, doc_type, uploaded_by, created_at, status, container_id, responsible_party)
        VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, ?, ?, 'draft', ?, ?)`)
        .run(id, req.params.id, pdfFilename, storedName, signedPdf.length, docType || "OT", uploader, now, containerId, responsibleParty);
      logEntityEvent('document', id, 'GENERATED', null, null, null,
        JSON.stringify({ shipmentId: req.params.id, docType: docType || "OT", filename: pdfFilename, containerId, signed: true, certFingerprint: cert.fingerprint_sha256 }));
      const row = db.prepare("SELECT * FROM shipment_documents WHERE id = ?").get(id);
      ok(res, mapDoc(row, req.params.id), 201);
    } catch (e) { err(res, e.message, 500); }
  });

  // Always sends from the shipment's EMO (Export Managing Office) — simplest correct default
  // for FCL export-led document distribution (direct scope decision, not a user-facing office
  // picker). No silent fallback to IMO if EMO has no mail settings configured.
  app.post("/api/shipments/:id/documents/:docId/send-email", shipmentWrite, async (req, res) => {
    const { to, subject, message } = req.body || {};
    if (!to) return err(res, "A recipient email address is required");
    const shipment = db.prepare("SELECT emo_office_id FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (!shipment.emo_office_id) return err(res, "This shipment has no Export Managing Office assigned");
    const doc = db.prepare("SELECT * FROM shipment_documents WHERE id=? AND shipment_id=?").get(req.params.docId, req.params.id);
    if (!doc) return err(res, "Document not found", 404);
    const mailSettings = db.prepare("SELECT * FROM office_mail_settings WHERE office_id=? AND is_active=1").get(shipment.emo_office_id);
    if (!mailSettings) return err(res, "Configure SMTP settings for the shipment's Export Managing Office first");

    try {
      const mailOptions = buildMailOptions({
        from: mailSettings.from_address, fromName: mailSettings.from_name,
        to, subject: subject || doc.filename, message: message || "",
        attachmentPath: path.join(UPLOADS_DIR, doc.stored_name), attachmentFilename: doc.filename,
      });
      await sendViaOffice(db, shipment.emo_office_id, mailOptions);
      logEntityEvent('document', doc.id, 'EMAILED', null, null, null,
        JSON.stringify({ shipmentId: req.params.id, to, subject: subject || doc.filename }));
      ok(res, { sent: true });
    } catch (e) { err(res, e.message, 502); }
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
    vesselImo:     r.vessel_imo    || "",
    atd:           r.atd           || "",
    ata:           r.ata           || "",
    source:        r.source        || "search",
  });

  // TEU for a shipment's linked-shipments summary row — same size='40'→2 else 1 convention
  // used everywhere else this app computes TEU (e.g. the notification bell, SpaceConfigurationsPage).
  const teuForShipment = shipmentId =>
    db.prepare("SELECT COALESCE(SUM(CASE WHEN size='40' THEN 2 ELSE 1 END), 0) AS teu FROM containers WHERE shipment_id=?")
      .get(shipmentId).teu;

  const mapLinkedShipment = s => ({
    id: s.id, pol: s.pol, pod: s.pod, etd: s.etd || "",
    contractType: s.contract_type || "", contractRef: s.contract_ref || "",
    status: s.status, teu: teuForShipment(s.id),
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
    ensureBookingCreated(req.params.id);
    ok(res, mapSchedule({ id, shipment_id: req.params.id, carrier, vessel_name: vesselName,
      voyage_number: voyageNumber, service, pol, pod, etd, eta,
      transit_days: Number(transitDays), is_mock: isMock ? 1 : 0, saved_at: savedAt, saved_by: savedBy }), 201);
  });

  // Lightweight correction for an already-saved sailing (e.g. a carrier-driven ETD/ETA shift) —
  // keeps shipment_schedules AND the backing SEA leg(s) in lockstep in one action, instead of
  // the only previous option (remove the SEA leg entirely, which cascades to delete the
  // schedule, unlock everything, and force a full re-search). Logs one field-level 'UPDATED'
  // entity event per changed value, mirroring the cost-line history pattern, so ScheduleHistory
  // shows a real old→new diff rather than the schedule record silently going stale.
  app.put("/api/shipments/:id/schedules/:scheduleId", shipmentWrite, (req, res) => {
    const existing = db.prepare("SELECT * FROM shipment_schedules WHERE id=? AND shipment_id=?")
      .get(req.params.scheduleId, req.params.id);
    if (!existing) return err(res, "Not found", 404);
    const { vesselName = existing.vessel_name, voyageNumber = existing.voyage_number,
            etd = existing.etd, eta = existing.eta, carrier = existing.carrier } = req.body;
    const actor = req.user?.name || req.user?.email || "";

    const changes = [
      ['vessel_name',   existing.vessel_name,   vesselName],
      ['voyage_number', existing.voyage_number, voyageNumber],
      ['etd',           existing.etd,           etd],
      ['eta',           existing.eta,           eta],
      ['carrier',       existing.carrier,       carrier],
    ].filter(([, o, n]) => String(o || '') !== String(n || ''));

    db.prepare("UPDATE shipment_schedules SET vessel_name=?, voyage_number=?, etd=?, eta=?, carrier=? WHERE id=?")
      .run(vesselName, voyageNumber, etd, eta, carrier, req.params.scheduleId);

    for (const [field, oldVal, newVal] of changes) {
      logEntityEvent('schedule', req.params.scheduleId, 'UPDATED', field, oldVal, newVal,
        JSON.stringify({ shipmentId: req.params.id, actor }));
    }

    // Keep the SEA leg(s) backing this schedule in lockstep — first leg carries
    // vessel/voyage/etd/carrier, last leg carries eta (handles both direct and TSP sailings,
    // matching the first/last-leg convention already used by applySailingToLegs elsewhere).
    const legs = db.prepare("SELECT * FROM shipment_legs WHERE shipment_id=? ORDER BY leg_order ASC").all(req.params.id);
    const seaLegs = legs.filter(l => l.leg_type === 'SEA');
    if (seaLegs.length > 0) {
      const first = seaLegs[0], last = seaLegs[seaLegs.length - 1];
      db.prepare("UPDATE shipment_legs SET vessel=?, voyage=?, etd=?, carrier_code=? WHERE id=?")
        .run(vesselName, voyageNumber, etd, carrier, first.id);
      db.prepare("UPDATE shipment_legs SET eta=? WHERE id=?").run(eta, last.id);
      syncShipmentFromLegs(req.params.id);
    }

    ok(res, mapSchedule(db.prepare("SELECT * FROM shipment_schedules WHERE id=?").get(req.params.scheduleId)));
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

  // ─── Schedule catalog (shared schedules — Test Tools > Schedule Generator) ────────────
  // A schedule created here is NOT owned by exactly one shipment the way a searched-and-saved
  // one is — shipment_id becomes whichever shipment was linked first (satisfies the existing
  // NOT NULL FK with no schema loosening needed), and every additional shipment is a row in
  // schedule_shipment_links instead of a duplicate shipment_schedules row. This is what lets
  // many shipments share one real sailing and answer "how many are on schedule SCHED-XYZ".

  // Mirrors src/utils/applySailingToLegs.js's "no SEA leg yet" case (the routing-table bug
  // fixed earlier this session) — nothing auto-seeds a shipment's first leg, so a shipment
  // linked to a generated schedule before it has any SEA leg must get one created here,
  // not silently skipped.
  const pushScheduleToLeg = (shipmentId, sched) => {
    const legs = db.prepare("SELECT * FROM shipment_legs WHERE shipment_id=? ORDER BY leg_order ASC").all(shipmentId);
    const seaLegs = legs.filter(l => l.leg_type === 'SEA');
    if (seaLegs.length === 0) {
      const shipment = db.prepare("SELECT contract_type, contract_ref FROM shipments WHERE id=?").get(shipmentId);
      const id = `LEG-${uid()}`;
      const legOrder = (db.prepare("SELECT MAX(leg_order) AS m FROM shipment_legs WHERE shipment_id=?").get(shipmentId).m ?? -1) + 1;
      db.prepare(`INSERT INTO shipment_legs
        (id, shipment_id, leg_order, mot, leg_type, movement_type, pol, pod, pol_loc_type, pod_loc_type,
         etd, eta, carrier_code, vessel, vessel_imo, voyage, movement_by, contract_type, contract_ref, created_at)
        VALUES (?,?,?,'SEA','SEA','SEA',?,?,'Terminal','Terminal',?,?,?,?,?,?,'',?,?,?)`)
        .run(id, shipmentId, legOrder, sched.pol, sched.pod, sched.etd || null, sched.eta || null,
             sched.carrier, sched.vessel_name, sched.vessel_imo, sched.voyage_number,
             shipment?.contract_type || "SPOT", shipment?.contract_ref || "", new Date().toISOString());
      syncShipmentFromLegs(shipmentId);
      return;
    }
    const first = seaLegs[0], last = seaLegs[seaLegs.length - 1];
    db.prepare("UPDATE shipment_legs SET vessel=?, vessel_imo=?, voyage=?, carrier_code=? WHERE id=?")
      .run(sched.vessel_name, sched.vessel_imo, sched.voyage_number, sched.carrier, first.id);
    db.prepare("UPDATE shipment_legs SET eta=? WHERE id=?").run(sched.eta, last.id);
    syncShipmentFromLegs(shipmentId);
  };

  app.post("/api/schedules", shipmentWrite, (req, res) => {
    const { carrier = "", vesselImo = "", vesselName = "", voyageNumber = "", service = "",
            pol = "", pod = "", etd = "", atd = "", eta = "", ata = "",
            initialShipmentIds = [] } = req.body;
    if (!Array.isArray(initialShipmentIds) || initialShipmentIds.length === 0)
      return err(res, "At least one shipment must be linked", 400);
    if (carrier && !db.prepare("SELECT 1 FROM carriers WHERE code=?").get(carrier))
      return err(res, `Unknown carrier code: ${carrier}`, 400);
    if (vesselImo && !db.prepare("SELECT 1 FROM vessels WHERE imo=?").get(vesselImo))
      return err(res, `Unknown vessel IMO: ${vesselImo}`, 400);
    if (pol && !db.prepare("SELECT 1 FROM port_locations WHERE unlocode=?").get(pol))
      return err(res, `Unknown POL: ${pol}`, 400);
    if (pod && !db.prepare("SELECT 1 FROM port_locations WHERE unlocode=?").get(pod))
      return err(res, `Unknown POD: ${pod}`, 400);
    for (const sid of initialShipmentIds) {
      if (!db.prepare("SELECT id FROM shipments WHERE id=?").get(sid))
        return err(res, `Shipment not found: ${sid}`, 404);
    }

    const [ownerId, ...extraIds] = initialShipmentIds;
    const id = `SCHED-${uid()}`;
    const savedAt = new Date().toISOString();
    const savedBy = req.user?.name || req.user?.email || "";
    db.prepare(`INSERT INTO shipment_schedules
      (id, shipment_id, carrier, vessel_name, voyage_number, service, pol, pod, etd, eta,
       transit_days, is_mock, saved_at, saved_by, vessel_imo, atd, ata, source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'generated')`)
      .run(id, ownerId, carrier, vesselName, voyageNumber, service, pol, pod, etd, eta,
           0, 0, savedAt, savedBy, vesselImo, atd, ata);
    logEntityEvent('schedule', id, 'SAVED', null, null, null,
      JSON.stringify({ shipmentId: ownerId, carrier, vesselName, voyageNumber, service, pol, pod, etd, eta,
        actor: savedBy, source: 'generated' }));

    const row = db.prepare("SELECT * FROM shipment_schedules WHERE id=?").get(id);
    pushScheduleToLeg(ownerId, row);
    ensureBookingCreated(ownerId);
    for (const sid of extraIds) {
      db.prepare("INSERT INTO schedule_shipment_links (schedule_id, shipment_id, linked_at, linked_by) VALUES (?,?,?,?)")
        .run(id, sid, savedAt, savedBy);
      pushScheduleToLeg(sid, row);
      ensureBookingCreated(sid);
    }

    ok(res, { ...mapSchedule(row), linkedShipmentCount: initialShipmentIds.length }, 201);
  });

  app.get("/api/schedules", auth(), (req, res) => {
    const { source } = req.query;
    const rows = source
      ? db.prepare("SELECT * FROM shipment_schedules WHERE source=? ORDER BY saved_at DESC LIMIT 100").all(source)
      : db.prepare("SELECT * FROM shipment_schedules ORDER BY saved_at DESC LIMIT 100").all();
    const withCounts = rows.map(r => ({
      ...mapSchedule(r),
      linkedShipmentCount: 1 + db.prepare("SELECT COUNT(*) AS n FROM schedule_shipment_links WHERE schedule_id=?").get(r.id).n,
    }));
    ok(res, withCounts);
  });

  app.get("/api/schedules/:id/linked-shipments", auth(), (req, res) => {
    const sched = db.prepare("SELECT * FROM shipment_schedules WHERE id=?").get(req.params.id);
    if (!sched) return err(res, "Not found", 404);
    const owner = db.prepare("SELECT * FROM shipments WHERE id=?").get(sched.shipment_id);
    const linkedRows = db.prepare(`
      SELECT s.* FROM schedule_shipment_links l
      JOIN shipments s ON s.id = l.shipment_id
      WHERE l.schedule_id=? ORDER BY l.linked_at ASC`).all(req.params.id);
    ok(res, {
      owner: owner ? mapLinkedShipment(owner) : null,
      linked: linkedRows.map(mapLinkedShipment),
    });
  });

  app.post("/api/schedules/:id/link", shipmentWrite, (req, res) => {
    const sched = db.prepare("SELECT * FROM shipment_schedules WHERE id=?").get(req.params.id);
    if (!sched) return err(res, "Not found", 404);
    const { shipmentId } = req.body;
    if (!shipmentId) return err(res, "shipmentId is required", 400);
    if (!db.prepare("SELECT id FROM shipments WHERE id=?").get(shipmentId))
      return err(res, "Shipment not found", 404);
    if (sched.shipment_id === shipmentId) return err(res, "Already the owner of this schedule", 409);
    if (db.prepare("SELECT 1 FROM schedule_shipment_links WHERE schedule_id=? AND shipment_id=?").get(req.params.id, shipmentId))
      return err(res, "Already linked", 409);
    const linkedAt = new Date().toISOString();
    db.prepare("INSERT INTO schedule_shipment_links (schedule_id, shipment_id, linked_at, linked_by) VALUES (?,?,?,?)")
      .run(req.params.id, shipmentId, linkedAt, req.user?.name || req.user?.email || "");
    pushScheduleToLeg(shipmentId, sched);
    ensureBookingCreated(shipmentId);
    ok(res, { linked: shipmentId }, 201);
  });

  app.delete("/api/schedules/:id/link/:shipmentId", shipmentWrite, (req, res) => {
    const sched = db.prepare("SELECT * FROM shipment_schedules WHERE id=?").get(req.params.id);
    if (!sched) return err(res, "Not found", 404);
    if (sched.shipment_id === req.params.shipmentId)
      return err(res, "Can't unlink the owning shipment — delete the schedule instead", 400);
    const existing = db.prepare("SELECT 1 FROM schedule_shipment_links WHERE schedule_id=? AND shipment_id=?")
      .get(req.params.id, req.params.shipmentId);
    if (!existing) return err(res, "Not linked", 404);
    db.prepare("DELETE FROM schedule_shipment_links WHERE schedule_id=? AND shipment_id=?")
      .run(req.params.id, req.params.shipmentId);
    ok(res, { unlinked: req.params.shipmentId });
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
