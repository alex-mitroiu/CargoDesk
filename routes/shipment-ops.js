"use strict";

module.exports = function shipmentOpsRoutes(app, ctx) {
  const { query, transaction, ok, err, uid, auth, requireRole, validCoord, GPS_LOC_TYPE,
          mapCostLine, mapService, mapMilestone, mapMilestoneTemplate,
          sanctionsMap, screenShipmentById,
          logEvent, logEntityEvent, importContractRates, createRateSnapshot, generateCostLinesFromSnapshot,
          mapRateSnapshot, syncShipmentFromLegs, ensureBookingCreated, autoCompleteMilestone,
          UPLOADS_DIR, fs, path,
          renderHtmlToPdf, getActiveSigningCert, signPdfBuffer,
          buildMailOptions, sendViaOffice,
          createRateLimiter, getSettings, callContractService, getCustomerRow,
          computeArExposure, toUsd, roundCents, OVERRIDE_GRACE_MS,
          userOwnsLaneForShipment, mapInvoiceStatusOverride, docAmountUsd, canEditOfficeSide } = ctx;

  const shipmentWrite = requireRole(["admin", "operator", "occ_bk"]);

  // Document generation renders through the Puppeteer-backed pdf-render service and signs the
  // result; sending emails a real signed PDF via SMTP — both real, per-call cost, keyed per-user.
  const documentActionRateLimit = createRateLimiter({
    windowMs: 60 * 1000, max: 20, maxEnvVar: "DOC_ACTION_RATE_MAX",
    keyFn: req => req.user.id,
    message: "Too many document actions recently — please slow down",
  });

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

  const mapDoc = async (r, shipmentId) => {
    const sid = shipmentId || r.shipment_id;
    const [{ n }] = await query(`
      SELECT COUNT(*) as n FROM shipment_events
      WHERE shipment_id = $1 AND occurred_at > $2
      AND event_type IN ('FIELD_UPDATED','CONTAINER_ADDED','CONTAINER_REMOVED','CONTAINER_UPDATED')
    `, [sid, r.created_at]);
    return {
      id: r.id, shipmentId: r.shipment_id, filename: r.filename,
      mimeType: r.mime_type, sizeBytes: r.size_bytes,
      docType: r.doc_type, uploadedBy: r.uploaded_by, createdAt: r.created_at,
      status: r.status || 'draft',
      confirmedAt: r.confirmed_at || null, confirmedBy: r.confirmed_by || '',
      isStale: Number(n) > 0,
      containerId: r.container_id || '', responsibleParty: r.responsible_party || '',
      relatedDocId: r.related_doc_id || null,
      sourceCostLineIds: r.source_cost_line_ids ? JSON.parse(r.source_cost_line_ids) : null,
      paidAt: r.paid_at || null, paidAmount: r.paid_amount ?? null, transactionId: r.transaction_id || '',
      firstSentAt: r.first_sent_at || null,
      invoiceOwnerId: r.invoice_owner_id || null,
      collectionsAlertedAt: r.collections_alerted_at || null, collectionsEscalatedAt: r.collections_escalated_at || null,
      blSurrenderedAt: r.bl_surrendered_at || null, blSurrenderedBy: r.bl_surrendered_by || '',
      blReleasedAt: r.bl_released_at || null, blReleasedBy: r.bl_released_by || '',
    };
  };

  // ─── Landed-cost / duty estimate (TKT-U6IZCL, FCL Coverage Audit epic TKT-6PO7SV) ─────────
  // Explicitly a ballpark estimator, not a customs broker's system of record — a real duty
  // figure needs a versioned, per-country HS-tariff data feed this app doesn't have (same
  // "needs a data business, not code" gap already named for carrier networks, v0.69.0). Prefers
  // real per-item pricing (container_packages.unitValueUsd, Epic TKT-P3ASH1) grouped by each
  // item's own effective HS code — falling back to the single shipment-level declaredValue,
  // attributed to one chapter, only when NO pack item anywhere on the shipment is priced at all.
  const DEFAULT_DUTY_RATE_PCT = 5;

  app.get("/api/shipments/:id/landed-cost-estimate", auth(), async (req, res) => {
    const [shipment] = await query("SELECT declared_value, declared_value_currency FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);

    const containers = await query("SELECT id, hs_code FROM containers WHERE shipment_id=$1", [req.params.id]);
    const hsByContainer = {};
    containers.forEach(c => { hsByContainer[c.id] = c.hs_code || ''; });

    const chapterTotals = {}; // chapter ('' = unclassified) -> valueUsd
    const addToChapter = (chapter, valueUsd) => { chapterTotals[chapter] = (chapterTotals[chapter] || 0) + valueUsd; };

    let totalPricedValueUsd = 0;
    if (containers.length > 0) {
      const containerIds = containers.map(c => c.id);
      const ph = containerIds.map((_, i) => `$${i + 1}`).join(',');
      const packages = await query(
        `SELECT container_id, hs_code, quantity, unit_value_usd FROM container_packages
         WHERE container_id IN (${ph}) AND unit_value_usd IS NOT NULL`, containerIds
      );
      for (const p of packages) {
        const effectiveHs = p.hs_code || hsByContainer[p.container_id] || '';
        const chapter = effectiveHs ? effectiveHs.slice(0, 2) : '';
        const valueUsd = (p.quantity || 0) * p.unit_value_usd;
        addToChapter(chapter, valueUsd);
        totalPricedValueUsd += valueUsd;
      }
    }

    let cargoValueSource = totalPricedValueUsd > 0 ? "pack-items" : "none";
    if (totalPricedValueUsd === 0 && shipment.declared_value != null) {
      const distinctHs = [...new Set(containers.map(c => c.hs_code).filter(Boolean))];
      const chapter = distinctHs.length === 1 ? distinctHs[0].slice(0, 2) : "";
      const valueUsd = await toUsd(shipment.declared_value, shipment.declared_value_currency || "USD");
      addToChapter(chapter, valueUsd);
      cargoValueSource = "shipment-declared-value";
    }

    const rateRows = await query("SELECT * FROM duty_rate_chapters");
    const rateByChapter = {};
    rateRows.forEach(r => { rateByChapter[r.hs_chapter] = r; });

    const byChapter = Object.entries(chapterTotals).map(([chapter, valueUsd]) => {
      const known = chapter && rateByChapter[chapter];
      const ratePct = known ? known.rate_pct : DEFAULT_DUTY_RATE_PCT;
      const label = known ? known.label
        : chapter ? `HS Chapter ${chapter} (no seeded rate — default ${DEFAULT_DUTY_RATE_PCT}% applied)`
        : "Unclassified (no HS code available)";
      return { chapter: chapter || null, label, valueUsd: roundCents(valueUsd), ratePct, dutyUsd: roundCents(valueUsd * ratePct / 100) };
    }).sort((a, b) => b.valueUsd - a.valueUsd);

    const dutyEstimateUsd = roundCents(byChapter.reduce((s, c) => s + c.dutyUsd, 0));

    const sellLines = await query("SELECT amount, exchange_rate FROM shipment_cost_lines WHERE shipment_id=$1 AND type='SELL'", [req.params.id]);
    const freightUsd = roundCents(sellLines.reduce((s, l) => s + l.amount * l.exchange_rate, 0));

    ok(res, {
      freightUsd, dutyEstimateUsd, landedCostUsd: roundCents(freightUsd + dutyEstimateUsd),
      cargoValueSource, byChapter,
      disclaimer: "Ballpark estimate only — not a customs broker's system of record. Duty rates are illustrative flat rates by HS chapter, not live tariff data. Does not include destination fees, insurance, or brokerage.",
    });
  });

  // ─── Screening ────────────────────────────────────────────────────────────

  app.get("/api/shipments/:id/screening", async (req, res) => {
    const [row] = await query("SELECT * FROM shipment_screenings WHERE shipment_id=$1", [req.params.id]);
    if (!row) return ok(res, null);
    ok(res, { id: row.id, shipmentId: row.shipment_id, screenedAt: row.screened_at,
      result: row.result, hits: JSON.parse(row.hits || "[]"),
      overriddenAt: row.overridden_at || null, overrideReason: row.override_reason || null });
  });

  app.post("/api/shipments/:id/screen", async (req, res) => {
    if (!(await query("SELECT id FROM shipments WHERE id=$1", [req.params.id]))[0]) return err(res, "Not found", 404);
    if (sanctionsMap.size === 0) return err(res, "Sanctions list not yet synced — use POST /api/sanctions/sync first.", 400);
    ok(res, await screenShipmentById(req.params.id));
  });

  // Previously had NO role gate at all — any authenticated user, including a viewer, could
  // flip a sanctions HIT to CLEAR via a direct API call (the frontend's own ComplianceModal
  // doesn't hide the button by role either, so this was reachable through the real UI too, not
  // just a theoretical direct-API gap). Same tier as every other shipment-write action.
  app.post("/api/shipments/:id/screening/override", shipmentWrite, async (req, res) => {
    const { reason = "" } = req.body;
    if (!reason.trim()) return err(res, "Override reason is required");
    const [row] = await query("SELECT id FROM shipment_screenings WHERE shipment_id=$1", [req.params.id]);
    if (!row) return err(res, "No screening record found for this shipment", 404);
    const now = new Date().toISOString();
    await query("UPDATE shipment_screenings SET result='CLEAR', overridden_at=$1, override_reason=$2 WHERE shipment_id=$3",
      [now, reason.trim(), req.params.id]);
    ok(res, { overriddenAt: now, overrideReason: reason.trim() });
  });

  // ─── Cost Lines ───────────────────────────────────────────────────────────

  app.post("/api/shipments/:id/cost-lines/import-contract", shipmentWrite, async (req, res) => {
    const { overwrite = false, splitPerContainer = false } = req.body || {};
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (shipment.contract_type !== 'Central' || !shipment.contract_id)
      return err(res, "Shipment is not linked to a Central contract");
    // Resolving (and, if needed, creating) the rate snapshot happens BEFORE the write transaction
    // below opens — in 'remote' contract-source mode this is a network call to the Contract
    // Management Service, and holding a write transaction open across it would block other
    // writers for no benefit (same reasoning as saveRates in routes/contracts.js). Mirrors
    // importContractRates()'s own existing-snapshot-or-create logic exactly, just hoisted above
    // the transaction rather than inside it.
    const [existingSnap] = await query("SELECT id FROM shipment_rate_snapshots WHERE shipment_id=$1 ORDER BY generated_at DESC LIMIT 1", [req.params.id]);
    const snapshotId = existingSnap ? existingSnap.id : await createRateSnapshot(req.params.id, shipment.contract_id, 'initial');
    // Delete-then-regenerate wrapped in one transaction — without this, an interruption between
    // the delete loop and regeneration could leave a shipment with NO cost lines at all.
    try {
      let includeSell = false;
      await transaction(async (tx) => {
        if (overwrite) {
          const existingBuy  = await tx.query("SELECT id FROM shipment_cost_lines WHERE shipment_id=$1 AND type='BUY'  AND source='contract'", [req.params.id]);
          const existingSell = await tx.query("SELECT id FROM shipment_cost_lines WHERE shipment_id=$1 AND type='SELL' AND source='contract'", [req.params.id]);
          includeSell = existingSell.length > 0;
          for (const row of [...existingBuy, ...existingSell]) await tx.query("DELETE FROM shipment_cost_lines WHERE id=$1", [row.id]);
        }
      });
      const count = snapshotId ? await generateCostLinesFromSnapshot(req.params.id, snapshotId, { splitPerContainer, includeSell }) : 0;
      ok(res, { imported: count });
    } catch (e) { err(res, e.message, 500); }
  });

  // Replays the shipment's existing frozen rate snapshot — does NOT read live contract_rates,
  // so a reset never silently changes what was already committed to the client.
  app.post("/api/shipments/:id/cost-lines/reset-to-contract", shipmentWrite, async (req, res) => {
    const { splitPerContainer = false } = req.body || {};
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (shipment.contract_type !== 'Central' || !shipment.contract_id)
      return err(res, "Shipment is not linked to a Central contract");
    const [snapshot] = await query("SELECT id FROM shipment_rate_snapshots WHERE shipment_id=$1 ORDER BY generated_at DESC LIMIT 1", [req.params.id]);
    if (!snapshot) return err(res, "No rate snapshot found for this shipment — use Import from Contract first");
    const existingSell = await query("SELECT id FROM shipment_cost_lines WHERE shipment_id=$1 AND type='SELL' AND source='contract'", [req.params.id]);
    const includeSell = existingSell.length > 0;
    for (const row of await query("SELECT id FROM shipment_cost_lines WHERE shipment_id=$1 AND source='contract'", [req.params.id]))
      await query("DELETE FROM shipment_cost_lines WHERE id=$1", [row.id]);
    const count = await generateCostLinesFromSnapshot(req.params.id, snapshot.id, { splitPerContainer, includeSell });
    ok(res, { imported: count, snapshotId: snapshot.id });
  });

  // Pulls CURRENT live contract_rates into a NEW frozen snapshot, then regenerates cost lines
  // from it — the only action that changes the committed rate (carrier rates can move; this is
  // how that gets picked up deliberately, with a record of when/why it happened).
  app.post("/api/shipments/:id/cost-lines/update-carrier-costs", shipmentWrite, async (req, res) => {
    const { splitPerContainer = false } = req.body || {};
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (shipment.contract_type !== 'Central' || !shipment.contract_id)
      return err(res, "Shipment is not linked to a Central contract");
    const snapshotId = await createRateSnapshot(req.params.id, shipment.contract_id, 'carrier_update', req.user?.email || '');
    if (!snapshotId) return err(res, "Contract has no rates to snapshot");
    const existingSell = await query("SELECT id FROM shipment_cost_lines WHERE shipment_id=$1 AND type='SELL' AND source='contract'", [req.params.id]);
    const includeSell = existingSell.length > 0;
    for (const row of await query("SELECT id FROM shipment_cost_lines WHERE shipment_id=$1 AND source='contract'", [req.params.id]))
      await query("DELETE FROM shipment_cost_lines WHERE id=$1", [row.id]);
    const count = await generateCostLinesFromSnapshot(req.params.id, snapshotId, { splitPerContainer, includeSell });
    ok(res, { imported: count, snapshotId });
  });

  app.get("/api/shipments/:id/rate-snapshots", costLineRead, async (req, res) => {
    const rows = await query("SELECT * FROM shipment_rate_snapshots WHERE shipment_id=$1 ORDER BY generated_at DESC", [req.params.id]);
    ok(res, rows.map(mapRateSnapshot));
  });

  app.get("/api/shipments/:id/cost-lines", costLineRead, async (req, res) => {
    const { limit, offset } = req.query;
    // Pagination is opt-in (TKT-UAJGR3) — every existing consumer (CostLineRow lists, GP Overview,
    // Freight Audit matching) wants the whole shipment's cost lines at once and omits these params,
    // so the default response stays today's exact bare array.
    if (limit === undefined && offset === undefined) {
      const rows = await query("SELECT * FROM shipment_cost_lines WHERE shipment_id=$1 ORDER BY type, created_at ASC", [req.params.id]);
      return ok(res, rows.map(mapCostLine));
    }
    const lim = Math.min(parseInt(limit) || 50, 500), off = parseInt(offset) || 0;
    const [{ n: total }] = await query("SELECT COUNT(*) AS n FROM shipment_cost_lines WHERE shipment_id=$1", [req.params.id]);
    const rows = await query("SELECT * FROM shipment_cost_lines WHERE shipment_id=$1 ORDER BY type, created_at ASC LIMIT $2 OFFSET $3", [req.params.id, lim, off]);
    ok(res, { results: rows.map(mapCostLine), total: Number(total), limit: lim, offset: off });
  });

  app.post("/api/shipments/:id/cost-lines", shipmentWrite, async (req, res) => {
    const { type, chargeCode, currency = 'USD', amount, exchangeRate = 1, vatRate = 0, notes = '', containerId = '', source: rawSource, paymentIndicator: rawPI } = req.body;
    if (!type || !chargeCode || amount == null) return err(res, "type, chargeCode, amount required");
    if (!['BUY','SELL'].includes(type)) return err(res, "type must be BUY or SELL");
    const source = ['contract', 'mirror', 'automated'].includes(rawSource) ? rawSource : 'manual';
    const paymentIndicator = rawPI === 'Collect' ? 'Collect' : 'Prepaid';
    const vat = type === 'SELL' ? Number(vatRate) || 0 : 0;
    const id  = `CL-${uid()}`;
    const now = new Date().toISOString();
    await query("INSERT INTO shipment_cost_lines (id,shipment_id,type,charge_code,currency,amount,exchange_rate,vat_rate,notes,container_id,created_at,source,payment_indicator) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [id, req.params.id, type, chargeCode, currency.toUpperCase(), Number(amount), Number(exchangeRate), vat, notes, containerId, now, source, paymentIndicator]);
    await logEntityEvent('cost_line', id, 'CREATED', null, null, null,
      JSON.stringify({ shipmentId: req.params.id, type, chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchangeRate: Number(exchangeRate), vatRate: vat }));
    ok(res, mapCostLine({ id, shipment_id: req.params.id, type, charge_code: chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchange_rate: Number(exchangeRate), vat_rate: vat, notes, container_id: containerId, source, payment_indicator: paymentIndicator, modified_at: null, created_at: now }), 201);
  });

  app.put("/api/shipments/:shipmentId/cost-lines/:id", shipmentWrite, async (req, res) => {
    const { type, chargeCode, currency = 'USD', amount, exchangeRate = 1, vatRate = 0, notes = '', containerId = '', paymentIndicator: rawPI } = req.body;
    if (!type || !chargeCode || amount == null) return err(res, "type, chargeCode, amount required");
    if (!['BUY','SELL'].includes(type)) return err(res, "type must be BUY or SELL");
    const [existing] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1 AND shipment_id=$2", [req.params.id, req.params.shipmentId]);
    if (!existing) return err(res, "Not found", 404);
    if (existing.status === 'posted') return err(res, "This line is posted and locked — add a new adjusting line instead of editing it", 409);
    const paymentIndicator = rawPI === 'Collect' ? 'Collect' : 'Prepaid';
    const vat = type === 'SELL' ? Number(vatRate) || 0 : 0;
    const now = new Date().toISOString();
    await query("UPDATE shipment_cost_lines SET type=$1,charge_code=$2,currency=$3,amount=$4,exchange_rate=$5,vat_rate=$6,notes=$7,container_id=$8,payment_indicator=$9,modified_at=$10 WHERE id=$11",
      [type, chargeCode, currency.toUpperCase(), Number(amount), Number(exchangeRate), vat, notes, containerId, paymentIndicator, now, req.params.id]);
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
        await logEntityEvent('cost_line', req.params.id, 'UPDATED', field, oldV, newV,
          JSON.stringify({ shipmentId: existing.shipment_id, chargeCode, type }));
    }
    ok(res, mapCostLine({ id: req.params.id, shipment_id: existing.shipment_id, type, charge_code: chargeCode, currency: currency.toUpperCase(), amount: Number(amount), exchange_rate: Number(exchangeRate), vat_rate: vat, notes, container_id: containerId, source: existing.source || 'manual', payment_indicator: paymentIndicator, modified_at: now, created_at: existing.created_at }));
  });

  // ─── Accrual / posting state machine (TKT-83O41G) ──────────────────────────
  const postGate = requireRole(["admin", "operator"]);

  app.patch("/api/shipments/:shipmentId/cost-lines/:id/actualize", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1 AND shipment_id=$2", [req.params.id, req.params.shipmentId]);
    if (!existing) return err(res, "Not found", 404);
    if (existing.status === 'posted') return err(res, "This line is posted and locked", 409);
    const { actualAmount, actualExchangeRate = existing.exchange_rate } = req.body || {};
    if (actualAmount == null) return err(res, "actualAmount required");
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    await query(`UPDATE shipment_cost_lines
      SET status='actualized', actual_amount=$1, actual_exchange_rate=$2, actualized_at=$3, actualized_by=$4
      WHERE id=$5`,
      [Number(actualAmount), Number(actualExchangeRate), now, actor, req.params.id]);
    await logEntityEvent('cost_line', req.params.id, 'ACTUALIZED', 'status', existing.status, 'actualized',
      JSON.stringify({ shipmentId: existing.shipment_id, chargeCode: existing.charge_code, type: existing.type,
        accruedAmount: existing.amount, actualAmount: Number(actualAmount) }));
    const [row] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1", [req.params.id]);
    ok(res, mapCostLine(row));
  });

  app.patch("/api/shipments/:shipmentId/cost-lines/:id/post", postGate, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1 AND shipment_id=$2", [req.params.id, req.params.shipmentId]);
    if (!existing) return err(res, "Not found", 404);
    if (existing.status === 'posted') return err(res, "Already posted", 409);
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    await query("UPDATE shipment_cost_lines SET status='posted', posted_at=$1, posted_by=$2 WHERE id=$3",
      [now, actor, req.params.id]);
    await logEntityEvent('cost_line', req.params.id, 'POSTED', 'status', existing.status, 'posted',
      JSON.stringify({ shipmentId: existing.shipment_id, chargeCode: existing.charge_code, type: existing.type }));
    const [row] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1", [req.params.id]);
    ok(res, mapCostLine(row));
  });

  // Batch post — same lock/role semantics as the single-line Post above, one entity
  // event per line so the audit trail still reads as individual postings.
  app.post("/api/shipments/:shipmentId/cost-lines/post-batch", postGate, async (req, res) => {
    const { ids = [] } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) return err(res, "ids required");
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    const posted = [];
    for (const id of ids) {
      const [existing] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1 AND shipment_id=$2", [id, req.params.shipmentId]);
      if (!existing || existing.status === 'posted') continue;
      await query("UPDATE shipment_cost_lines SET status='posted', posted_at=$1, posted_by=$2 WHERE id=$3", [now, actor, id]);
      await logEntityEvent('cost_line', id, 'POSTED', 'status', existing.status, 'posted',
        JSON.stringify({ shipmentId: existing.shipment_id, chargeCode: existing.charge_code, type: existing.type }));
      posted.push(id);
    }
    const rows = posted.length
      ? await query(`SELECT * FROM shipment_cost_lines WHERE id IN (${posted.map((_, i) => `$${i + 1}`).join(',')})`, posted)
      : [];
    ok(res, rows.map(mapCostLine));
  });

  // Adjust (2026-09-03 shipment-domain audit) — the real fix for a posted line that turns out to
  // be wrong. A posted line stays locked (matches the SELL-side invariant — nothing here allows
  // editing or deleting one), but this creates a NEW cost line explicitly linked back via
  // adjusts_cost_line_id and immediately posts it, the same "this is already a final, recorded
  // accounting event" reasoning the SELL-side Invoice Reversal (v0.53.0) uses for its own
  // adjusting lines. `amount` is the DELTA (the difference), never a new total — the frontend
  // modal is explicit about this, since actualize/post's own actual_amount write always replaces
  // (not adds to) whatever a line already held, so entering a full corrected total here would
  // double-count against the original line's own already-posted actual_amount.
  app.post("/api/shipments/:shipmentId/cost-lines/:id/adjust", postGate, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1 AND shipment_id=$2", [req.params.id, req.params.shipmentId]);
    if (!existing) return err(res, "Not found", 404);
    if (existing.type !== 'BUY') return err(res, "Adjust is for BUY-side lines — a confirmed SELL invoice has its own Invoice Reversal action instead", 409);
    if (existing.status !== 'posted') return err(res, "Only a posted line can be adjusted — edit it directly instead", 409);
    const { amount, exchangeRate = existing.exchange_rate, note = '' } = req.body || {};
    if (amount == null || Number(amount) === 0) return err(res, "A non-zero adjustment amount is required");
    const now = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    const id = `CL-${uid()}`;
    const amt = Number(amount), rate = Number(exchangeRate);
    await query(`INSERT INTO shipment_cost_lines
      (id, shipment_id, type, charge_code, currency, amount, exchange_rate, notes, created_at,
       container_id, source, status, actual_amount, actual_exchange_rate, actualized_at, actualized_by,
       posted_at, posted_by, adjusts_cost_line_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'adjustment','posted',$11,$12,$13,$14,$15,$16,$17)`,
      [id, req.params.shipmentId, existing.type, existing.charge_code, existing.currency,
        amt, rate, note, now, existing.container_id || '',
        amt, rate, now, actor, now, actor, existing.id]);
    await logEntityEvent('cost_line', id, 'ADJUSTED', null, null, null,
      JSON.stringify({ shipmentId: req.params.shipmentId, chargeCode: existing.charge_code, type: existing.type,
        adjustsCostLineId: existing.id, amount: amt, note }));
    const [row] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1", [id]);
    ok(res, mapCostLine(row), 201);
  });

  app.delete("/api/shipments/:shipmentId/cost-lines/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1 AND shipment_id=$2", [req.params.id, req.params.shipmentId]);
    if (!existing) return err(res, "Not found", 404);
    if (existing.status === 'posted') return err(res, "This line is posted and locked — use Adjust to post an offsetting entry instead of deleting it", 409);
    await query("DELETE FROM shipment_cost_lines WHERE id=$1", [req.params.id]);
    await logEntityEvent('cost_line', req.params.id, 'DELETED', null, null, null,
      JSON.stringify({ shipmentId: existing.shipment_id, type: existing.type, chargeCode: existing.charge_code, amount: existing.amount, currency: existing.currency, source: existing.source || 'manual' }));

    // If this was the last SELL line for its scope, any still-draft invoice generated for
    // that scope is now backed by nothing — clean it up so it doesn't sit there looking
    // valid. Consolidated invoices (container_id='') cover ALL SELL lines regardless of
    // container tag, so they only clear when the shipment has none left at all; a
    // per-container invoice clears as soon as ITS container has no SELL lines left. A
    // CONFIRMED invoice is never touched here — that's the record of what was sent.
    if (existing.type === 'SELL') {
      const scopesToClean = [];
      const [{ n: remainingTotal }] = await query("SELECT COUNT(*) as n FROM shipment_cost_lines WHERE shipment_id=$1 AND type='SELL'", [req.params.shipmentId]);
      if (Number(remainingTotal) === 0) scopesToClean.push('');
      if (existing.container_id) {
        const [{ n: remainingForContainer }] = await query("SELECT COUNT(*) as n FROM shipment_cost_lines WHERE shipment_id=$1 AND type='SELL' AND container_id=$2", [req.params.shipmentId, existing.container_id]);
        if (Number(remainingForContainer) === 0) scopesToClean.push(existing.container_id);
      }
      for (const scope of scopesToClean) {
        const orphaned = await query(`SELECT * FROM shipment_documents
          WHERE shipment_id=$1 AND (doc_type='FR01' OR doc_type='FR02') AND container_id=$2 AND status != 'confirmed'`,
          [req.params.shipmentId, scope]);
        for (const doc of orphaned) {
          try { fs.unlinkSync(path.join(UPLOADS_DIR, doc.stored_name)); } catch {}
          await query("DELETE FROM shipment_documents WHERE id=$1", [doc.id]);
          await logEntityEvent('document', doc.id, 'AUTO_REMOVED', null, null, null,
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
  app.get("/api/shipments/:id/cost-line-events", costLineRead, async (req, res) => {
    const rows = await query(`
      SELECT * FROM entity_events
      WHERE entity_type IN ('cost_line', 'document')
      AND meta IS NOT NULL AND (meta::jsonb)->>'shipmentId' = $1
      ORDER BY created_at DESC
    `, [req.params.id]);
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

  app.get("/api/shipments/:id/services", auth(), async (req, res) => {
    const rows = await query(`${SERVICE_SELECT} WHERE ss.shipment_id=$1 ORDER BY ss.side, ss.created_at ASC`, [req.params.id]);
    ok(res, rows.map(mapService));
  });

  app.post("/api/shipments/:id/services", shipmentWrite, async (req, res) => {
    const { side, serviceType, vendorId = '', vendorName = '', officeId = '',
            requestedDate = '', notes = '' } = req.body;
    if (!side || !serviceType) return err(res, "side, serviceType required");
    if (!['Export', 'Import'].includes(side)) return err(res, "side must be Export or Import");
    const id  = `SVC-${uid()}`;
    const now = new Date().toISOString();
    const createdBy = req.user?.name || req.user?.email || "";
    await query(`INSERT INTO shipment_services
      (id, shipment_id, side, service_type, status, vendor_id, vendor_name, office_id,
       requested_date, notes, created_at, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, req.params.id, side, serviceType, 'Requested', vendorId, vendorName, officeId,
           requestedDate, notes, now, createdBy]);
    await logEntityEvent('service', id, 'REQUESTED', null, null, null,
      JSON.stringify({ shipmentId: req.params.id, side, serviceType, vendorName }));
    // Same History-tab gap as schedules/parties — the entity_events row above only ever
    // surfaced on this service's own detail view, never on the shipment's unified History tab.
    await logEvent(req.params.id, 'SERVICE_ORDERED', null, null, `${side} — ${serviceType}`,
      JSON.stringify({ side, serviceType, vendorName }), req.user?.id);
    const [row] = await query(`${SERVICE_SELECT} WHERE ss.id=$1`, [id]);
    ok(res, mapService(row), 201);
  });

  app.patch("/api/shipments/:shipmentId/services/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [req.params.id, req.params.shipmentId]);
    if (!existing) return err(res, "Not found", 404);

    if (req.body.status && !SERVICE_STATUSES.includes(req.body.status))
      return err(res, `status must be one of ${SERVICE_STATUSES.join(", ")}`);

    // Involved Offices per-side edit permission — which office actually handles a service is
    // exactly the fact an export-only or import-only office user must not be able to move onto
    // (or off of) their own office without belonging to the right department, regardless of
    // which UI surface (Involved Offices tab, Overview's Request Service form) the change comes
    // from. Gated on the service's own current side, not the shipment's EMO/IMO, since a service
    // can be assigned to any of the shipment's involved offices (see shipmentOfficeIds).
    if (req.body.officeId !== undefined && req.body.officeId !== existing.office_id
        && !(await canEditOfficeSide(req, existing.side))) {
      return err(res, `You don't have permission to change the office on a ${existing.side} service`, 403);
    }

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

    await query(`UPDATE shipment_services SET side=$1, service_type=$2, status=$3, vendor_id=$4,
      vendor_name=$5, office_id=$6, requested_date=$7, confirmed_date=$8, completed_date=$9, notes=$10
      WHERE id=$11`,
      [side, serviceType, status, vendorId, vendorName, officeId, requestedDate,
           confirmedDate, completedDate, notes, req.params.id]);

    for (const [field, oldV, newV] of [
      ['status',       existing.status,        status],
      ['vendor_name',  existing.vendor_name,    vendorName],
      ['office_id',    existing.office_id,      officeId],
      ['notes',        existing.notes || '',    notes || ''],
    ]) {
      if (String(oldV || '') !== String(newV || '')) {
        await logEntityEvent('service', req.params.id, 'UPDATED', field, oldV, newV,
          JSON.stringify({ shipmentId: existing.shipment_id, side, serviceType }));
        await logEvent(existing.shipment_id, 'SERVICE_UPDATED', field, oldV, newV,
          JSON.stringify({ side, serviceType }), req.user?.id);
      }
    }

    const [row] = await query(`${SERVICE_SELECT} WHERE ss.id=$1`, [req.params.id]);
    ok(res, mapService(row));
  });

  app.delete("/api/shipments/:shipmentId/services/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [req.params.id, req.params.shipmentId]);
    if (!existing) return err(res, "Not found", 404);
    await query("DELETE FROM shipment_services WHERE id=$1", [req.params.id]);
    await logEntityEvent('service', req.params.id, 'DELETED', null, null, null,
      JSON.stringify({ shipmentId: existing.shipment_id, side: existing.side, serviceType: existing.service_type }));
    await logEvent(existing.shipment_id, 'SERVICE_REMOVED', null, `${existing.side} — ${existing.service_type}`, null,
      '', req.user?.id);
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
    LEFT JOIN shipment_loading_plan_lines l ON l.container_id = c.id AND l.service_id = $1
    WHERE c.shipment_id = $2
  `;

  app.get("/api/shipments/:shipmentId/services/:serviceId/loading-plan", auth(), async (req, res) => {
    const [service] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [req.params.serviceId, req.params.shipmentId]);
    if (!service) return err(res, "Service not found", 404);
    const rows = await query(`${LOADING_PLAN_SELECT}
      ORDER BY (l.sequence_order IS NULL), l.sequence_order ASC, c.container_number ASC`,
      [req.params.serviceId, req.params.shipmentId]);
    ok(res, rows.map(mapLoadingPlanLine));
  });

  app.put("/api/shipments/:shipmentId/services/:serviceId/loading-plan/:containerId", shipmentWrite, async (req, res) => {
    const [service] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [req.params.serviceId, req.params.shipmentId]);
    if (!service) return err(res, "Service not found", 404);
    const [container] = await query("SELECT * FROM containers WHERE id=$1 AND shipment_id=$2", [req.params.containerId, req.params.shipmentId]);
    if (!container) return err(res, "Container not found", 404);

    // Sequence is a display/print ordering for the physical loading/unloading/pickup/delivery
    // plan — "0th" or negative has no real-world meaning there, so 1 is the floor regardless
    // of what the client sends (this table is shared by exactly Loading/Unloading/Pickup/
    // Delivery, nothing else, so no need to branch on the service's own type here).
    const { plannedDate = '', sequenceOrder: rawSequenceOrder = 1, notes = '' } = req.body || {};
    const sequenceOrder = Math.max(1, parseInt(rawSequenceOrder, 10) || 1);
    const now = new Date().toISOString();
    const [existing] = await query("SELECT 1 FROM shipment_loading_plan_lines WHERE service_id=$1 AND container_id=$2", [req.params.serviceId, req.params.containerId]);
    if (existing) {
      await query(`UPDATE shipment_loading_plan_lines SET planned_date=$1, sequence_order=$2, notes=$3, updated_at=$4
        WHERE service_id=$5 AND container_id=$6`,
        [plannedDate, sequenceOrder, notes, now, req.params.serviceId, req.params.containerId]);
    } else {
      await query(`INSERT INTO shipment_loading_plan_lines
        (service_id, container_id, planned_date, sequence_order, notes, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [req.params.serviceId, req.params.containerId, plannedDate, sequenceOrder, notes, now, now]);
    }
    await logEntityEvent('loading_plan_line', `${req.params.serviceId}:${req.params.containerId}`, 'UPDATED', null, null, null,
      JSON.stringify({ shipmentId: req.params.shipmentId, serviceId: req.params.serviceId,
        containerId: req.params.containerId, plannedDate }));

    const [row] = await query(
      `SELECT c.id AS container_id, c.container_number, c.size, c.type,
              l.planned_date, l.sequence_order, l.notes, l.updated_at
       FROM containers c
       LEFT JOIN shipment_loading_plan_lines l ON l.container_id = c.id AND l.service_id = $1
       WHERE c.id = $2`,
      [req.params.serviceId, req.params.containerId]);
    ok(res, mapLoadingPlanLine(row));
  });

  // ─── Merchant's Haulage details (per-container, Pickup/Delivery, Merchant's Haulage only) ──
  // Same "one row per CURRENT container via LEFT JOIN" idiom as the Loading Plan above. Gating
  // on Merchant's Haulage (vs. Carrier's Haulage/Customer Arranged) is a frontend-only concern —
  // these routes don't re-check movement_type themselves, matching how the loading-plan routes
  // above don't re-check serviceType either.

  const mapHaulageRecord = r => ({
    containerId:      r.container_id,
    containerNumber:  r.container_number || '',
    size: r.size, type: r.type,
    id:               r.hr_id || null,
    gateInAt:         r.gate_in_at || '',
    gateOutAt:        r.gate_out_at || '',
    driverName:       r.driver_name || '',
    driverIdNumber:   r.driver_id_number || '',
    instructions:     r.instructions || '',
    costAmount:       r.cost_amount ?? null,
    costCurrency:     r.cost_currency || 'USD',
    costExchangeRate: r.cost_exchange_rate ?? 1,
    costLineId:       r.cost_line_id || '',
    updatedAt:        r.updated_at || null,
  });

  const mapHaulageWaypoint = r => ({
    id: r.id, haulageRecordId: r.haulage_record_id, sequenceOrder: r.sequence_order ?? 1,
    locType: r.loc_type || 'Door', location: r.location || '',
    latitude: r.latitude ?? null, longitude: r.longitude ?? null,
    notes: r.notes || '', createdAt: r.created_at,
  });

  const HAULAGE_RECORD_SELECT = `
    SELECT c.id AS container_id, c.container_number, c.size, c.type,
           hr.id AS hr_id, hr.gate_in_at, hr.gate_out_at, hr.driver_name, hr.driver_id_number,
           hr.instructions, hr.cost_amount, hr.cost_currency, hr.cost_exchange_rate, hr.cost_line_id,
           hr.updated_at
    FROM containers c
    LEFT JOIN shipment_haulage_records hr ON hr.container_id = c.id AND hr.service_id = $1
    WHERE c.shipment_id = $2
  `;

  const HAULAGE_RECORD_SELECT_BY_CONTAINER = `
    SELECT c.id AS container_id, c.container_number, c.size, c.type,
           hr.id AS hr_id, hr.gate_in_at, hr.gate_out_at, hr.driver_name, hr.driver_id_number,
           hr.instructions, hr.cost_amount, hr.cost_currency, hr.cost_exchange_rate, hr.cost_line_id,
           hr.updated_at
    FROM containers c
    LEFT JOIN shipment_haulage_records hr ON hr.container_id = c.id AND hr.service_id = $1
    WHERE c.id = $2
  `;

  // Idempotent get-or-create — lets an operator add a waypoint or set the cost before ever
  // touching the plain fields, same as ensureBookingCreated's own "no artificial ordering
  // requirement" shape elsewhere in this codebase.
  const ensureHaulageRecord = async (serviceId, containerId) => {
    const [existing] = await query("SELECT * FROM shipment_haulage_records WHERE service_id=$1 AND container_id=$2", [serviceId, containerId]);
    if (existing) return existing;
    const id = `HR-${uid()}`;
    const now = new Date().toISOString();
    await query(`INSERT INTO shipment_haulage_records (id, service_id, container_id, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5)`, [id, serviceId, containerId, now, now]);
    const [row] = await query("SELECT * FROM shipment_haulage_records WHERE id=$1", [id]);
    return row;
  };

  app.get("/api/shipments/:shipmentId/services/:serviceId/haulage", auth(), async (req, res) => {
    const [service] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [req.params.serviceId, req.params.shipmentId]);
    if (!service) return err(res, "Service not found", 404);
    const rows = await query(`${HAULAGE_RECORD_SELECT} ORDER BY c.container_number ASC`, [req.params.serviceId, req.params.shipmentId]);
    ok(res, rows.map(mapHaulageRecord));
  });

  app.put("/api/shipments/:shipmentId/services/:serviceId/haulage/:containerId", shipmentWrite, async (req, res) => {
    const [service] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [req.params.serviceId, req.params.shipmentId]);
    if (!service) return err(res, "Service not found", 404);
    const [container] = await query("SELECT * FROM containers WHERE id=$1 AND shipment_id=$2", [req.params.containerId, req.params.shipmentId]);
    if (!container) return err(res, "Container not found", 404);

    const { gateInAt = '', gateOutAt = '', driverName = '', driverIdNumber = '', instructions = '' } = req.body || {};
    const record = await ensureHaulageRecord(req.params.serviceId, req.params.containerId);
    const now = new Date().toISOString();
    await query(`UPDATE shipment_haulage_records
      SET gate_in_at=$1, gate_out_at=$2, driver_name=$3, driver_id_number=$4, instructions=$5, updated_at=$6
      WHERE id=$7`,
      [gateInAt, gateOutAt, driverName, driverIdNumber, instructions, now, record.id]);
    await logEntityEvent('haulage_record', record.id, 'UPDATED', null, null, null,
      JSON.stringify({ shipmentId: req.params.shipmentId, serviceId: req.params.serviceId, containerId: req.params.containerId }));

    const [row] = await query(HAULAGE_RECORD_SELECT_BY_CONTAINER, [req.params.serviceId, req.params.containerId]);
    ok(res, mapHaulageRecord(row));
  });

  // Kept separate from the plain PUT above — same "edit the row" vs. "trigger a state-changing
  // side effect on shipment_cost_lines" split this file already uses for cost lines themselves
  // (PUT .../cost-lines/:id vs. the dedicated .../actualize and .../post routes below). Bypasses
  // the generic POST /cost-lines route entirely (its own source allow-list only accepts
  // 'contract'/'mirror'/'automated' — anything else silently falls back to 'manual') via a direct
  // INSERT, the same precedent the quote-conversion/carrier-invoice-matching/reversal routes
  // already establish for their own distinct source tags.
  app.patch("/api/shipments/:shipmentId/services/:serviceId/haulage/:containerId/cost", shipmentWrite, async (req, res) => {
    const [service] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [req.params.serviceId, req.params.shipmentId]);
    if (!service) return err(res, "Service not found", 404);
    const [container] = await query("SELECT * FROM containers WHERE id=$1 AND shipment_id=$2", [req.params.containerId, req.params.shipmentId]);
    if (!container) return err(res, "Container not found", 404);

    const { amount, currency = 'USD', exchangeRate = 1 } = req.body || {};
    const record = await ensureHaulageRecord(req.params.serviceId, req.params.containerId);
    const now = new Date().toISOString();
    const [existingLine] = record.cost_line_id
      ? await query("SELECT * FROM shipment_cost_lines WHERE id=$1", [record.cost_line_id])
      : [null];
    if (existingLine && existingLine.status === 'posted')
      return err(res, "This line is posted and locked — add a new adjusting line instead of editing it", 409);

    const clearing = amount == null || String(amount).trim() === '';
    const eventsToLog = [];
    try {
      await transaction(async (tx) => {
        if (clearing) {
          if (existingLine) {
            await tx.query("DELETE FROM shipment_cost_lines WHERE id=$1", [existingLine.id]);
            eventsToLog.push(['cost_line', existingLine.id, 'DELETED', null, null, null,
              JSON.stringify({ shipmentId: req.params.shipmentId, reason: "Merchant's Haulage cost cleared" })]);
          }
          await tx.query(`UPDATE shipment_haulage_records
            SET cost_amount=NULL, cost_currency=$1, cost_exchange_rate=$2, cost_line_id='', updated_at=$3 WHERE id=$4`,
            [currency.toUpperCase(), Number(exchangeRate), now, record.id]);
        } else if (existingLine) {
          await tx.query("UPDATE shipment_cost_lines SET amount=$1, currency=$2, exchange_rate=$3, modified_at=$4 WHERE id=$5",
            [Number(amount), currency.toUpperCase(), Number(exchangeRate), now, existingLine.id]);
          eventsToLog.push(['cost_line', existingLine.id, 'UPDATED', 'amount', String(existingLine.amount), String(Number(amount)),
            JSON.stringify({ shipmentId: req.params.shipmentId, chargeCode: 'Haulage', type: 'BUY' })]);
          await tx.query(`UPDATE shipment_haulage_records
            SET cost_amount=$1, cost_currency=$2, cost_exchange_rate=$3, updated_at=$4 WHERE id=$5`,
            [Number(amount), currency.toUpperCase(), Number(exchangeRate), now, record.id]);
        } else {
          const clId = `CL-${uid()}`;
          await tx.query(`INSERT INTO shipment_cost_lines
            (id,shipment_id,type,charge_code,currency,amount,exchange_rate,vat_rate,notes,container_id,created_at,source,payment_indicator)
            VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12)`,
            [clId, req.params.shipmentId, 'BUY', 'Haulage', currency.toUpperCase(), Number(amount), Number(exchangeRate),
              `Merchant's Haulage — ${container.container_number || req.params.containerId}`,
              req.params.containerId, now, 'merchant_haulage', 'Prepaid']);
          eventsToLog.push(['cost_line', clId, 'CREATED', null, null, null,
            JSON.stringify({ shipmentId: req.params.shipmentId, type: 'BUY', chargeCode: 'Haulage', amount: Number(amount), source: 'merchant_haulage' })]);
          await tx.query(`UPDATE shipment_haulage_records
            SET cost_amount=$1, cost_currency=$2, cost_exchange_rate=$3, cost_line_id=$4, updated_at=$5 WHERE id=$6`,
            [Number(amount), currency.toUpperCase(), Number(exchangeRate), clId, now, record.id]);
        }
      });
    } catch (e) {
      return err(res, e.message, 500);
    }
    // Audit-log writes deferred until after commit (same reasoning as mdm.js's insertLocationRow).
    for (const args of eventsToLog) await logEntityEvent(...args);

    const [row] = await query(HAULAGE_RECORD_SELECT_BY_CONTAINER, [req.params.serviceId, req.params.containerId]);
    ok(res, mapHaulageRecord(row));
  });

  app.get("/api/shipments/:shipmentId/services/:serviceId/haulage/:containerId/waypoints", auth(), async (req, res) => {
    const [service] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [req.params.serviceId, req.params.shipmentId]);
    if (!service) return err(res, "Service not found", 404);
    const [record] = await query("SELECT id FROM shipment_haulage_records WHERE service_id=$1 AND container_id=$2", [req.params.serviceId, req.params.containerId]);
    if (!record) return ok(res, []);
    const rows = await query("SELECT * FROM shipment_haulage_waypoints WHERE haulage_record_id=$1 ORDER BY sequence_order ASC", [record.id]);
    ok(res, rows.map(mapHaulageWaypoint));
  });

  app.post("/api/shipments/:shipmentId/services/:serviceId/haulage/:containerId/waypoints", shipmentWrite, async (req, res) => {
    const [service] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [req.params.serviceId, req.params.shipmentId]);
    if (!service) return err(res, "Service not found", 404);
    const [container] = await query("SELECT * FROM containers WHERE id=$1 AND shipment_id=$2", [req.params.containerId, req.params.shipmentId]);
    if (!container) return err(res, "Container not found", 404);

    const { locType = 'Door', location = '', latitude = null, longitude = null, notes = '', sequenceOrder } = req.body || {};
    const isGps = locType === GPS_LOC_TYPE;
    if (isGps) {
      if (!validCoord(latitude, -90, 90)) return err(res, "latitude must be between -90 and 90");
      if (!validCoord(longitude, -180, 180)) return err(res, "longitude must be between -180 and 180");
    }
    const record = await ensureHaulageRecord(req.params.serviceId, req.params.containerId);
    let seq;
    if (sequenceOrder != null) {
      seq = Math.max(1, parseInt(sequenceOrder, 10) || 1);
    } else {
      const [{ n }] = await query("SELECT COALESCE(MAX(sequence_order),0)+1 AS n FROM shipment_haulage_waypoints WHERE haulage_record_id=$1", [record.id]);
      seq = Number(n);
    }
    const id = `HWP-${uid()}`;
    const now = new Date().toISOString();
    await query(`INSERT INTO shipment_haulage_waypoints
      (id, haulage_record_id, sequence_order, loc_type, location, latitude, longitude, notes, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, record.id, seq, locType, isGps ? '' : location,
        isGps && latitude != null && latitude !== '' ? Number(latitude) : null,
        isGps && longitude != null && longitude !== '' ? Number(longitude) : null,
        notes, now]);
    await logEntityEvent('haulage_waypoint', id, 'CREATED', null, null, null,
      JSON.stringify({ shipmentId: req.params.shipmentId, serviceId: req.params.serviceId, containerId: req.params.containerId, locType }));
    const [row] = await query("SELECT * FROM shipment_haulage_waypoints WHERE id=$1", [id]);
    ok(res, mapHaulageWaypoint(row), 201);
  });

  app.put("/api/haulage-waypoints/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_haulage_waypoints WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const { locType = 'Door', location = '', latitude = null, longitude = null, notes = '', sequenceOrder = 1 } = req.body || {};
    const isGps = locType === GPS_LOC_TYPE;
    if (isGps) {
      if (!validCoord(latitude, -90, 90)) return err(res, "latitude must be between -90 and 90");
      if (!validCoord(longitude, -180, 180)) return err(res, "longitude must be between -180 and 180");
    }
    const seq = Math.max(1, parseInt(sequenceOrder, 10) || 1);
    await query(`UPDATE shipment_haulage_waypoints
      SET sequence_order=$1, loc_type=$2, location=$3, latitude=$4, longitude=$5, notes=$6 WHERE id=$7`,
      [seq, locType, isGps ? '' : location,
        isGps && latitude != null && latitude !== '' ? Number(latitude) : null,
        isGps && longitude != null && longitude !== '' ? Number(longitude) : null,
        notes, req.params.id]);
    await logEntityEvent('haulage_waypoint', req.params.id, 'UPDATED', null, null, null, JSON.stringify({ locType }));
    const [row] = await query("SELECT * FROM shipment_haulage_waypoints WHERE id=$1", [req.params.id]);
    ok(res, mapHaulageWaypoint(row));
  });

  app.delete("/api/haulage-waypoints/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_haulage_waypoints WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    await query("DELETE FROM shipment_haulage_waypoints WHERE id=$1", [req.params.id]);
    await logEntityEvent('haulage_waypoint', req.params.id, 'DELETED', null, null, null, null);
    ok(res, { deleted: req.params.id });
  });

  // ─── Milestones ───────────────────────────────────────────────────────────

  app.get("/api/shipments/:id/milestones", async (req, res) => {
    const rows = await query("SELECT * FROM shipment_milestones WHERE shipment_id=$1 ORDER BY sequence_order ASC", [req.params.id]);
    ok(res, rows.map(mapMilestone));
  });

  app.post("/api/shipments/:id/milestones/init", shipmentWrite, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const carrierCode = req.body?.carrierCode || shipment.carrier_code || '';
    const tradeLane   = req.body?.tradeLane || '';
    const etd = req.body?.etd || shipment.etd || '';
    const eta = req.body?.eta || shipment.eta || '';

    let templates = carrierCode
      ? await query("SELECT * FROM milestone_templates WHERE carrier_code=$1 AND trade_lane=$2 ORDER BY sequence_order", [carrierCode, tradeLane])
      : [];
    if (!templates.length && carrierCode)
      templates = await query("SELECT * FROM milestone_templates WHERE carrier_code=$1 AND trade_lane='' ORDER BY sequence_order", [carrierCode]);
    if (!templates.length)
      templates = await query("SELECT * FROM milestone_templates WHERE template_key='FCL' AND carrier_code='' ORDER BY sequence_order");
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

    await query("DELETE FROM shipment_milestones WHERE shipment_id=$1", [req.params.id]);
    const now = new Date().toISOString();
    const created = [];
    for (const t of templates) {
      const id = `MS-${uid()}`;
      const off = DATE_OFFSETS[t.milestone_key];
      const estimatedDate = off ? shiftDate(off.base, off.days) : '';
      await query("INSERT INTO shipment_milestones (id,shipment_id,milestone_key,label,sequence_order,estimated_date,completed_at,completed_by,note,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [id, req.params.id, t.milestone_key, t.label, t.sequence_order, estimatedDate, '', '', '', now]);
      created.push(mapMilestone({ id, shipment_id: req.params.id, milestone_key: t.milestone_key, label: t.label, sequence_order: t.sequence_order, estimated_date: estimatedDate, completed_at: '', completed_by: '', note: '', created_at: now }));
    }
    ok(res, created, 201);
  });

  app.put("/api/milestones/:id", shipmentWrite, async (req, res) => {
    const { estimatedDate = '', completedAt = '', completedBy = '', note = '' } = req.body || {};
    const [existing] = await query("SELECT * FROM shipment_milestones WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    // shipment_milestones' sequence_order implies an intended step order, but real operations
    // routinely need to backfill a step noticed late (or a carrier confirms two events same-day
    // out of order) — per direct decision, this is flagged, not blocked: an entity_events row for
    // the audit trail, plus an `outOfOrder` hint on the response the operator's own UI can choose
    // to surface. Only fires on a genuinely NEW completion (blank -> set), not an edit of an
    // already-completed step's date/note.
    let outOfOrder = false;
    if (completedAt && !existing.completed_at) {
      const [earlierIncomplete] = await query(
        "SELECT label FROM shipment_milestones WHERE shipment_id=$1 AND sequence_order < $2 AND (completed_at IS NULL OR completed_at='') LIMIT 1",
        [existing.shipment_id, existing.sequence_order]
      );
      if (earlierIncomplete) {
        outOfOrder = true;
        await logEntityEvent('milestone', req.params.id, 'COMPLETED_OUT_OF_ORDER', null, null, null,
          JSON.stringify({ shipmentId: existing.shipment_id, milestoneKey: existing.milestone_key,
            label: existing.label, blockedBy: earlierIncomplete.label }));
      }
    }
    await query("UPDATE shipment_milestones SET estimated_date=$1,completed_at=$2,completed_by=$3,note=$4 WHERE id=$5",
      [estimatedDate, completedAt, completedBy, note, req.params.id]);
    const updated = mapMilestone({ ...existing, estimated_date: estimatedDate, completed_at: completedAt, completed_by: completedBy, note });
    ok(res, outOfOrder ? { ...updated, outOfOrder: true } : updated);
  });

  app.delete("/api/milestones/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_milestones WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    await query("DELETE FROM shipment_milestones WHERE id=$1", [req.params.id]);
    ok(res, { deleted: req.params.id });
  });

  // ─── Documents ────────────────────────────────────────────────────────────

  app.get("/api/shipments/:id/documents", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM shipment_documents WHERE shipment_id = $1 ORDER BY created_at DESC", [req.params.id]);
    ok(res, await Promise.all(rows.map(r => mapDoc(r, req.params.id))));
  });

  app.post("/api/shipments/:id/documents", shipmentWrite, async (req, res) => {
    const { filename, mimeType, docType, data, containerId = '', responsibleParty = '', containerEventId = '' } = req.body;
    if (!filename || !data) return err(res, "filename and data are required");
    try {
      const buf        = Buffer.from(data, "base64");
      const ext        = path.extname(filename) || "";
      const storedName = `${Date.now()}_${uid()}${ext}`;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), buf);
      const id       = `DOC-${uid()}`;
      const now      = new Date().toISOString();
      const uploader = req.user?.name || req.user?.email || "";
      await query(`INSERT INTO shipment_documents
        (id, shipment_id, filename, stored_name, mime_type, size_bytes, doc_type, uploaded_by, created_at, status, container_id, responsible_party, container_event_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11, $12)`,
        [id, req.params.id, filename, storedName, mimeType || "", buf.length, docType || "OT", uploader, now, containerId, responsibleParty, containerEventId]);
      await logEntityEvent('document', id, 'GENERATED', null, null, null,
        JSON.stringify({ shipmentId: req.params.id, docType: docType || "OT", filename, containerId }));
      const [row] = await query("SELECT * FROM shipment_documents WHERE id = $1", [id]);
      ok(res, await mapDoc(row, req.params.id), 201);
    } catch (e) { err(res, e.message, 500); }
  });

  // Server-side render + sign counterpart to the plain upload route above — every
  // CargoDesk-generated document (Commercial Invoice, Packing List, loading plans, service
  // docs, ...) goes through this instead of building a blob client-side, so the signing key
  // never has to leave the server. Raw user-attached files keep using the plain upload route
  // untouched — signing a file CargoDesk didn't author would misrepresent who generated it.
  // Mirrors src/utils/invoiceGenerator.js's own resolveCreditGate — that helper only ever ran
  // client-side (ShipmentAccountingInvoicesPage.jsx, before calling this same route), so a
  // direct API call produced a fully signed invoice PDF for a customer on credit hold with no
  // check at all. Scoped to FR01/FR02 (the only two doc types that are actually invoices) —
  // every other generated document (B/L, packing list, service docs, ...) is unaffected by a
  // credit hold and must keep generating normally.
  async function findCreditHold(shipment) {
    const candidateIds = [shipment.shipper_id, shipment.consignee_id, shipment.principal_id].filter(Boolean);
    if (shipment.contract_id) {
      let namedAccountId = null;
      if (((await getSettings()).contract_source || "local") === "remote") {
        try { namedAccountId = (await callContractService("GET", `/internal/contracts/${shipment.contract_id}`)).namedAccountId; }
        catch { /* an unreachable/vanished remote contract just means no Named Account to check — the shipper/consignee/principal check below still runs */ }
      } else {
        const [row] = await query("SELECT named_account_id FROM contracts WHERE id=$1", [shipment.contract_id]);
        namedAccountId = row?.named_account_id;
      }
      if (namedAccountId) candidateIds.push(namedAccountId);
    }
    for (const id of [...new Set(candidateIds)]) {
      const c = await getCustomerRow(id);
      if (c?.creditHold) return { companyName: c.companyName, reason: c.creditHoldReason || '' };
    }
    return null;
  }

  // Credit Control Depth, third pass (TKT-GLWMFP) — the over-limit warning was deliberately
  // client-side-only through v0.73.0 ("a real hard block there would need a proper AR-aging
  // view this app doesn't have yet"). v0.73.0 shipped that AR-aging view; this closes the loop:
  // a direct API call now hits the same real block resolveCreditGate already showed a warning
  // for, and the only way past it is a live credit_overrides row approved by the shipment's own
  // lane trade_manager (POST .../credit-override/approve, routes/customers.js).
  //
  // Validity is a grace window (OVERRIDE_GRACE_MS from approval), not strict single-use —
  // a split-per-container generation calls this route once PER CONTAINER for what's really one
  // logical action, and single-use-on-first-call would silently re-block containers 2..N of the
  // same batch. The window is short enough that it can't become a standing bypass for a later,
  // genuinely new over-limit event (a customer whose balance rises again days later needs a
  // fresh approval), long enough to cover any realistic one-batch generation.
  // Real bug found while testing this pass, not introduced by it: committedExposure (above)
  // already sums EVERY uninvoiced SELL line for the customer's shipments — which necessarily
  // already includes the very lines THIS generation is about to invoice (cost lines are always
  // added, and so already exist as shipment_cost_lines rows, before Generate Invoice is ever
  // clicked in this app's real workflow). A separate "newAmountUsd" term summing those same
  // sourceCostLineIds again — inherited from resolveCreditGate's pre-v0.73.0 formula, when
  // committedExposure didn't exist yet and outstandingAr alone genuinely couldn't see the
  // current invoice — double-counted them. Harmless while over-limit was a soft, bypassable
  // warning; a real correctness bug now that it's a hard block (the very FIRST invoice for any
  // customer with a limit near their typical invoice size would have been wrongly refused).
  // Fixed by dropping the redundant term — see the matching fix in resolveCreditGate.
  async function findOverLimitBlock(shipment) {
    const respId = shipment.principal_id || shipment.consignee_id || null;
    if (!respId) return null;
    const c = await getCustomerRow(respId);
    if (!c || c.creditLimit == null) return null;
    const { outstandingAr, committedExposure } = await computeArExposure(c.id, c.creditTermsDays);
    const limitUsd = await toUsd(c.creditLimit, c.currency || 'USD');
    const projected = roundCents(outstandingAr + committedExposure);
    if (projected <= limitUsd) return null;
    const [latest] = await query(
      "SELECT * FROM credit_overrides WHERE shipment_id=$1 AND customer_id=$2 AND override_type='over_limit' ORDER BY created_at DESC LIMIT 1",
      [shipment.id, c.id]
    );
    const withinGrace = latest && (Date.now() - new Date(latest.created_at).getTime()) <= OVERRIDE_GRACE_MS;
    return { companyName: c.companyName, override: withinGrace ? latest : null };
  }

  app.post("/api/shipments/:id/documents/generate", shipmentWrite, documentActionRateLimit, async (req, res) => {
    const { html, filename, docType, containerId = '', responsibleParty = '', sourceCostLineIds = null, relatedDocId = null } = req.body;
    if (!html || !filename) return err(res, "html and filename are required");
    let consumeOverrideId = null;
    if (docType === 'FR01' || docType === 'FR02') {
      const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
      const hold = shipment && await findCreditHold(shipment);
      if (hold) return err(res, `Cannot generate this invoice — ${hold.companyName} is on credit hold${hold.reason ? ` (${hold.reason})` : ''}`, 409);
      const overLimit = shipment && await findOverLimitBlock(shipment);
      if (overLimit) {
        if (!overLimit.override)
          return err(res, `${overLimit.companyName} is over their credit limit — ask the trade lane's own trade manager to approve an override before generating`, 409);
        consumeOverrideId = overLimit.override.id;
      }
    }
    // Written BEFORE the render/sign calls (both real, per-call network round-trips to the
    // pdf-render service) so a crash or hang mid-call still leaves a durable trace — previously
    // a failure anywhere in this block (render timeout, signing error, process crash) left
    // absolutely nothing behind; the operator just saw a failed request with no record it was
    // ever attempted. Not a retry/queue mechanism (this app has none, deliberately, per the
    // document-distribution service's own scope notes) — just a visible "this was attempted"
    // marker in the shipment's existing event history.
    await logEvent(req.params.id, 'DOCUMENT_GENERATION_ATTEMPTED', null, null, null,
      JSON.stringify({ docType: docType || "OT", filename }), req.user?.id);
    try {
      const cert = await getActiveSigningCert(query);
      const rawPdf = await renderHtmlToPdf(html);
      const signedPdf = await signPdfBuffer(Buffer.from(rawPdf), cert);

      const pdfFilename = `${path.parse(filename).name}.pdf`;
      const storedName  = `${Date.now()}_${uid()}.pdf`;
      fs.writeFileSync(path.join(UPLOADS_DIR, storedName), signedPdf);

      const id       = `DOC-${uid()}`;
      const now      = new Date().toISOString();
      const uploader = req.user?.name || req.user?.email || "";
      // sourceCostLineIds (FR01/FR02 only) records exactly which cost lines this invoice was
      // built from, so a later reversal (TKT-DUADU3) knows precisely what to negate rather than
      // re-deriving from whatever SELL lines happen to exist by then.
      await query(`INSERT INTO shipment_documents
        (id, shipment_id, filename, stored_name, mime_type, size_bytes, doc_type, uploaded_by, created_at, status, container_id, responsible_party, source_cost_line_ids, related_doc_id)
        VALUES ($1, $2, $3, $4, 'application/pdf', $5, $6, $7, $8, 'draft', $9, $10, $11, $12)`,
        [id, req.params.id, pdfFilename, storedName, signedPdf.length, docType || "OT", uploader, now, containerId, responsibleParty,
             Array.isArray(sourceCostLineIds) ? JSON.stringify(sourceCostLineIds) : null, relatedDocId]);
      await logEntityEvent('document', id, 'GENERATED', null, null, null,
        JSON.stringify({ shipmentId: req.params.id, docType: docType || "OT", filename: pdfFilename, containerId, signed: true, certFingerprint: cert.fingerprint_sha256 }));
      await logEvent(req.params.id, 'DOCUMENT_GENERATED', null, null, pdfFilename,
        JSON.stringify({ docType: docType || "OT", containerId }), req.user?.id);
      if (consumeOverrideId) {
        await query("UPDATE credit_overrides SET consumed_at=$1 WHERE id=$2", [now, consumeOverrideId]);
      }
      const [row] = await query("SELECT * FROM shipment_documents WHERE id = $1", [id]);
      ok(res, await mapDoc(row, req.params.id), 201);
    } catch (e) {
      await logEvent(req.params.id, 'DOCUMENT_GENERATION_FAILED', null, null, null,
        JSON.stringify({ docType: docType || "OT", filename, error: e.message }), req.user?.id);
      err(res, e.message, e.status || 500);
    }
  });

  // Always sends from the shipment's EMO (Export Managing Office) — simplest correct default
  // for FCL export-led document distribution (direct scope decision, not a user-facing office
  // picker). No silent fallback to IMO if EMO has no mail settings configured.
  app.post("/api/shipments/:id/documents/:docId/send-email", shipmentWrite, documentActionRateLimit, async (req, res) => {
    const { to, subject, message } = req.body || {};
    if (!to) return err(res, "A recipient email address is required");
    const [shipment] = await query("SELECT emo_office_id FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (!shipment.emo_office_id) return err(res, "This shipment has no Export Managing Office assigned");
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id=$1 AND shipment_id=$2", [req.params.docId, req.params.id]);
    if (!doc) return err(res, "Document not found", 404);
    const [mailSettings] = await query("SELECT * FROM office_mail_settings WHERE office_id=$1 AND is_active=TRUE", [shipment.emo_office_id]);
    if (!mailSettings) return err(res, "Configure SMTP settings for the shipment's Export Managing Office first");

    try {
      const mailOptions = buildMailOptions({
        from: mailSettings.from_address, fromName: mailSettings.from_name,
        to, subject: subject || doc.filename, message: message || "",
        attachmentPath: path.join(UPLOADS_DIR, doc.stored_name), attachmentFilename: doc.filename,
      });
      await sendViaOffice(query, shipment.emo_office_id, mailOptions);
      await logEntityEvent('document', doc.id, 'EMAILED', null, null, null,
        JSON.stringify({ shipmentId: req.params.id, to, subject: subject || doc.filename }));
      // TKT-PLAVEK — a fast, denormalized "was this ever sent" signal for the Billing
      // Performance report; the full multi-channel history stays in entity_events exactly as
      // before, this never replaces it. Written once (first channel wins) — a later resend via
      // any channel doesn't overwrite an earlier first_sent_at.
      if (!doc.first_sent_at) await query("UPDATE shipment_documents SET first_sent_at=$1 WHERE id=$2", [new Date().toISOString(), doc.id]);
      ok(res, { sent: true });
    } catch (e) { err(res, e.message, 502); }
  });

  app.patch("/api/documents/:docId", shipmentWrite, async (req, res) => {
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id = $1", [req.params.docId]);
    if (!doc) return err(res, "Not found", 404);
    const { status, relatedDocId } = req.body;
    if (status !== undefined) {
      if (!["draft", "confirmed", "voided"].includes(status)) return err(res, "status must be draft, confirmed, or voided");
      const now = new Date().toISOString();
      if (status === "confirmed") {
        await query("UPDATE shipment_documents SET status=$1, confirmed_at=$2, confirmed_by=$3 WHERE id=$4",
          [status, now, req.user?.name || req.user?.email || "", req.params.docId]);
        // Invoice Collections "user responsible" (Epic TKT-G11AHW) — defaults to whoever confirmed
        // an FR01/FR02, since they're a real, present person; never overwrites a manual
        // reassignment already on the row (e.g. a re-confirm after a correction).
        if ((doc.doc_type === "FR01" || doc.doc_type === "FR02") && !doc.invoice_owner_id) {
          await query("UPDATE shipment_documents SET invoice_owner_id=$1 WHERE id=$2", [req.user?.id || "", req.params.docId]);
        }
      } else {
        // draft/voided don't touch confirmed_at/confirmed_by — a voided doc WAS confirmed once
        // and that history stays true, it's just no longer the active record.
        await query("UPDATE shipment_documents SET status=$1 WHERE id=$2", [status, req.params.docId]);
      }
      if (status === "confirmed" && doc.status !== "confirmed") {
        await logEntityEvent('document', req.params.docId, 'CONFIRMED', null, null, null,
          JSON.stringify({ shipmentId: doc.shipment_id, docType: doc.doc_type, filename: doc.filename, containerId: doc.container_id || '' }));
        // House B/L Lifecycle — "confirmed" on a BL01 IS "issued": the milestone sequence has
        // carried a bl_issued step since it was first seeded, but nothing has ever completed it.
        // Same never-overwrite-a-manual-completion guard as every other autoCompleteMilestone call.
        if (doc.doc_type === "BL01") {
          await autoCompleteMilestone(doc.shipment_id, 'bl_issued', `House B/L confirmed (${doc.filename})`);
        }
      }
      if (status === "voided" && doc.status !== "voided") {
        await logEntityEvent('document', req.params.docId, 'VOIDED', null, null, null,
          JSON.stringify({ shipmentId: doc.shipment_id, docType: doc.doc_type, filename: doc.filename, containerId: doc.container_id || '' }));
      }
    }
    if (relatedDocId !== undefined) {
      await query("UPDATE shipment_documents SET related_doc_id=$1 WHERE id=$2", [relatedDocId, req.params.docId]);
    }
    const [updated] = await query("SELECT * FROM shipment_documents WHERE id = $1", [req.params.docId]);
    ok(res, await mapDoc(updated, updated.shipment_id));
  });

  // ─── House B/L Lifecycle — Surrendered / Released ──────────────────────────
  // Document generation + print/email already exist (v0.51.0 signed PDF, v0.64.0 email
  // distribution) — EDI/electronic-transfer to the counterparty is explicitly out of scope for
  // this pass. These two actions just let an operator record the two real post-issuance facts
  // this app previously had nowhere to put: has the shipper surrendered the originals at origin
  // (only meaningful for a Telex Release/Surrendered/Seaway Bill release type — the UI surfaces
  // it accordingly, but the backend stays permissive since an Original-release bill can go
  // straight from Issued to Released), and has cargo actually been released at destination
  // against this specific bill. Deliberately NOT ordered against each other server-side, and
  // idempotent (a repeat call is a no-op, not an error) — same guard style autoCompleteMilestone
  // already uses.
  app.patch("/api/shipments/:shipmentId/documents/:docId/bl-surrender", shipmentWrite, async (req, res) => {
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id=$1 AND shipment_id=$2", [req.params.docId, req.params.shipmentId]);
    if (!doc) return err(res, "Not found", 404);
    if (doc.doc_type !== "BL01") return err(res, "Only a House Bill of Lading can be marked surrendered", 400);
    if (doc.status !== "confirmed") return err(res, "Only an issued (confirmed) House B/L can be marked surrendered", 409);
    if (!doc.bl_surrendered_at) {
      const now = new Date().toISOString();
      const actor = req.user?.name || req.user?.email || "";
      await query("UPDATE shipment_documents SET bl_surrendered_at=$1, bl_surrendered_by=$2 WHERE id=$3", [now, actor, doc.id]);
      await logEntityEvent('document', doc.id, 'BL_SURRENDERED', null, null, null,
        JSON.stringify({ shipmentId: doc.shipment_id, docType: doc.doc_type, filename: doc.filename }));
    }
    const [row] = await query("SELECT * FROM shipment_documents WHERE id=$1", [doc.id]);
    ok(res, await mapDoc(row, doc.shipment_id));
  });

  app.patch("/api/shipments/:shipmentId/documents/:docId/bl-release", shipmentWrite, async (req, res) => {
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id=$1 AND shipment_id=$2", [req.params.docId, req.params.shipmentId]);
    if (!doc) return err(res, "Not found", 404);
    if (doc.doc_type !== "BL01") return err(res, "Only a House Bill of Lading can be marked released", 400);
    if (doc.status !== "confirmed") return err(res, "Only an issued (confirmed) House B/L can be marked released", 409);
    if (!doc.bl_released_at) {
      const now = new Date().toISOString();
      const actor = req.user?.name || req.user?.email || "";
      await query("UPDATE shipment_documents SET bl_released_at=$1, bl_released_by=$2 WHERE id=$3", [now, actor, doc.id]);
      await logEntityEvent('document', doc.id, 'BL_RELEASED', null, null, null,
        JSON.stringify({ shipmentId: doc.shipment_id, docType: doc.doc_type, filename: doc.filename }));
    }
    const [row] = await query("SELECT * FROM shipment_documents WHERE id=$1", [doc.id]);
    ok(res, await mapDoc(row, doc.shipment_id));
  });

  // ─── Invoice Reversal / Credit-Debit Note (TKT-DUADU3) ─────────────────────
  // SELL-side only, by construction: FR01/FR02 are built exclusively from SELL cost lines
  // (generateInvoices(), src/utils/invoiceGenerator.js), so reversing an invoice can only ever
  // reverse SELL lines. Creates negative-amount, already-posted adjusting cost lines and voids
  // the original invoice doc — the new CN01 "Credit / Debit Note" document itself is built and
  // uploaded by the client afterward (same client-builds-HTML/server-signs split every other
  // generated document already follows), which is also why this route doesn't touch
  // related_doc_id — that's set once the CN01 doc actually exists (see PATCH above).
  app.post("/api/shipments/:shipmentId/documents/:docId/reverse", postGate, async (req, res) => {
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id=$1 AND shipment_id=$2", [req.params.docId, req.params.shipmentId]);
    if (!doc) return err(res, "Not found", 404);
    if (doc.doc_type !== "FR01" && doc.doc_type !== "FR02") return err(res, "Only a generated invoice can be reversed", 400);
    if (doc.status !== "confirmed") return err(res, "Only a confirmed invoice can be reversed — a draft can simply be regenerated or deleted", 409);
    if (doc.related_doc_id) return err(res, "This invoice has already been reversed", 409);

    const sourceIds = doc.source_cost_line_ids ? JSON.parse(doc.source_cost_line_ids) : null;
    const sourceLines = sourceIds && sourceIds.length
      ? await query(`SELECT * FROM shipment_cost_lines WHERE id IN (${sourceIds.map((_, i) => `$${i + 1}`).join(',')})`, sourceIds)
      : await query("SELECT * FROM shipment_cost_lines WHERE shipment_id=$1 AND type='SELL' AND container_id=$2", [req.params.shipmentId, doc.container_id || '']);
    if (sourceLines.length === 0) return err(res, "No charge lines found to reverse", 409);

    const { reason = "" } = req.body || {};
    const now   = new Date().toISOString();
    const actor = req.user?.name || req.user?.email || "";
    // Loop-insert the reversal lines, then void the original doc — all one atomic unit. An
    // interruption partway through used to risk either a half-reversed invoice (some charges
    // negated, others not) or reversal lines created with the original still showing
    // "confirmed" (looks active AND reversed — a real double-counting risk in AR).
    const reversalLineIds = [];
    const eventsToLog = [];
    try {
      await transaction(async (tx) => {
        for (const line of sourceLines) {
          const id = `CL-${uid()}`;
          const notes = `Reversal of invoice ${doc.filename}` + (reason ? ` — ${reason}` : "");
          await tx.query(`INSERT INTO shipment_cost_lines
            (id,shipment_id,type,charge_code,currency,amount,exchange_rate,vat_rate,notes,container_id,created_at,source,payment_indicator,status,posted_at,posted_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [id, req.params.shipmentId, line.type, line.charge_code, line.currency, -line.amount, line.exchange_rate,
                 line.vat_rate || 0, notes, line.container_id || '', now, 'reversal', line.payment_indicator || 'Prepaid', 'posted', now, actor]);
          eventsToLog.push(['cost_line', id, 'CREATED', null, null, null,
            JSON.stringify({ shipmentId: req.params.shipmentId, type: line.type, chargeCode: line.charge_code, currency: line.currency, amount: -line.amount, reversalOf: doc.id })]);
          reversalLineIds.push(id);
        }

        await tx.query("UPDATE shipment_documents SET status='voided' WHERE id=$1", [doc.id]);
        eventsToLog.push(['document', doc.id, 'VOIDED', null, null, null,
          JSON.stringify({ shipmentId: doc.shipment_id, docType: doc.doc_type, filename: doc.filename, containerId: doc.container_id || '' })]);
      });
    } catch (e) { return err(res, e.message, 500); }

    // Audit-log writes deferred until after commit (see mdm.js's insertLocationRow).
    for (const args of eventsToLog) await logEntityEvent(...args);
    const reversalLines = [];
    for (const id of reversalLineIds) {
      const [row] = await query("SELECT * FROM shipment_cost_lines WHERE id=$1", [id]);
      reversalLines.push(mapCostLine(row));
    }
    const [voidedDocRow] = await query("SELECT * FROM shipment_documents WHERE id=$1", [doc.id]);
    const voidedDoc = await mapDoc(voidedDocRow, doc.shipment_id);
    ok(res, { reversalLines, voidedDoc });
  });

  // ─── Mark as Paid (TKT-NQ87D3, Epic TKT-KR6ZBT) ────────────────────────────
  // A real payment-receipt primitive — before this, computeArExposure's outstandingAr meant
  // purely "confirmed, non-voided invoice", with no concept anywhere of a customer having
  // actually paid. paidAt is REQUIRED and never defaulted to "now" server-side — the financial
  // controller enters the real payment date (often a few days after actually reconciling
  // against a bank statement), and aging needs to reflect that date, not whenever this endpoint
  // happened to be called. paidAmount is REQUIRED too, so a partial payment can never silently
  // read as fully settled. transactionId is optional, free-text reference data only (bank
  // reference, wire confirmation) — never validated or acted on. Same postGate (admin/operator)
  // as Confirm/Reverse above — this is the same class of financial-state-changing action on the
  // same document, not a new gate tier.
  app.post("/api/shipments/:shipmentId/documents/:docId/mark-paid", postGate, async (req, res) => {
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id=$1 AND shipment_id=$2", [req.params.docId, req.params.shipmentId]);
    if (!doc) return err(res, "Not found", 404);
    if (doc.doc_type !== "FR01" && doc.doc_type !== "FR02") return err(res, "Only a generated invoice can be marked paid", 400);
    if (doc.status !== "confirmed") return err(res, "Only a confirmed invoice can be marked paid", 409);

    const { paidAt, paidAmount, transactionId = "" } = req.body || {};
    if (!paidAt) return err(res, "paidAt is required");
    if (paidAmount === undefined || paidAmount === null || paidAmount === "" || Number(paidAmount) <= 0)
      return err(res, "paidAmount must be a positive number");

    await query("UPDATE shipment_documents SET paid_at=$1, paid_amount=$2, transaction_id=$3 WHERE id=$4",
      [paidAt, Number(paidAmount), transactionId.trim(), doc.id]);
    await logEntityEvent('document', doc.id, 'MARKED_PAID', null, null, null,
      JSON.stringify({ shipmentId: doc.shipment_id, docType: doc.doc_type, filename: doc.filename, paidAt, paidAmount: Number(paidAmount), transactionId: transactionId.trim() || undefined }));

    const [row] = await query("SELECT * FROM shipment_documents WHERE id=$1", [doc.id]);
    const updated = await mapDoc(row, doc.shipment_id);
    ok(res, updated);
  });

  // Invoice Collections status override (Epic TKT-G11AHW) — an audit-trail INSERT per override
  // event, never an overwritten single field (same convention entity_events/CostLineHistoryModal
  // already use). Gated EXCLUSIVELY to the shipment's own lane trade_manager, mirroring Credit
  // Control Depth's own established precedent (v0.74.0) — never admin, operator, or an
  // out-of-lane trade_manager. An active override suppresses the collections sweep's alert AND
  // escalation for this document entirely, re-checked on every sweep run.
  app.post("/api/shipments/:shipmentId/documents/:docId/status-override", auth(), async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.shipmentId]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (!(await userOwnsLaneForShipment(req.user, shipment)))
      return err(res, "Only the trade manager responsible for this shipment's own trade lane may override an invoice's collections status", 403);
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id=$1 AND shipment_id=$2", [req.params.docId, req.params.shipmentId]);
    if (!doc) return err(res, "Not found", 404);
    if (doc.doc_type !== "FR01" && doc.doc_type !== "FR02") return err(res, "Only a generated invoice can have its collections status overridden", 400);

    const { reasonCode, description = "", overriddenStatus } = req.body || {};
    if (!reasonCode) return err(res, "reasonCode is required");
    if (!overriddenStatus) return err(res, "overriddenStatus is required");
    const [validCode] = await query("SELECT 1 FROM invoice_status_reason_codes WHERE code=$1 AND is_active=TRUE", [reasonCode]);
    if (!validCode) return err(res, "reasonCode is not a recognized, active reason code");

    const id = `ISO-${uid()}`;
    const now = new Date().toISOString();
    await query(`INSERT INTO invoice_status_overrides (id, document_id, reason_code, description, overridden_status, overridden_by, overridden_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, doc.id, reasonCode, description.trim(), overriddenStatus, req.user.email || req.user.id, now]);
    await logEntityEvent('document', doc.id, 'COLLECTIONS_STATUS_OVERRIDDEN', null, null, null,
      JSON.stringify({ shipmentId: doc.shipment_id, reasonCode, overriddenStatus, overriddenBy: req.user.email || req.user.id }));

    ok(res, mapInvoiceStatusOverride({ id, document_id: doc.id, reason_code: reasonCode, description: description.trim(), overridden_status: overriddenStatus, overridden_by: req.user.email || req.user.id, overridden_at: now }), 201);
  });

  app.get("/api/shipments/:shipmentId/documents/:docId/status-overrides", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM invoice_status_overrides WHERE document_id=$1 ORDER BY overridden_at DESC", [req.params.docId]);
    ok(res, rows.map(mapInvoiceStatusOverride));
  });

  // Reassigns "user responsible" for a generated invoice — defaults to whoever confirmed it
  // (see the documents/generate route), but admin/operator/the shipment's own lane trade_manager
  // can hand it off afterward (e.g. an account manager change).
  app.patch("/api/shipments/:shipmentId/documents/:docId/invoice-owner", auth(), async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.shipmentId]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const roles = req.user.roles || [req.user.role];
    const isAdminOrOperator = roles.includes('admin') || roles.includes('operator');
    if (!isAdminOrOperator && !(await userOwnsLaneForShipment(req.user, shipment)))
      return err(res, "Only admin, operator, or the trade manager responsible for this shipment's own trade lane may reassign the invoice owner", 403);
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id=$1 AND shipment_id=$2", [req.params.docId, req.params.shipmentId]);
    if (!doc) return err(res, "Not found", 404);
    const { ownerId } = req.body || {};
    if (ownerId) {
      const [user] = await query("SELECT id FROM users WHERE id=$1", [ownerId]);
      if (!user) return err(res, "ownerId must reference a real user");
    }
    await query("UPDATE shipment_documents SET invoice_owner_id=$1 WHERE id=$2", [ownerId || '', doc.id]);
    const [row] = await query("SELECT * FROM shipment_documents WHERE id=$1", [doc.id]);
    ok(res, await mapDoc(row, doc.shipment_id));
  });

  app.get("/api/documents/:docId/download", auth(), async (req, res) => {
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id = $1", [req.params.docId]);
    if (!doc) return err(res, "Not found", 404);
    const filePath = path.join(UPLOADS_DIR, doc.stored_name);
    if (!fs.existsSync(filePath)) return err(res, "File not found on disk", 404);
    const inline = (doc.mime_type || "").startsWith("text/") || doc.mime_type === "application/pdf";
    res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${doc.filename}"`);
    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    fs.createReadStream(filePath).pipe(res);
  });

  app.delete("/api/documents/:docId", shipmentWrite, async (req, res) => {
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id = $1", [req.params.docId]);
    if (!doc) return err(res, "Not found", 404);
    try { fs.unlinkSync(path.join(UPLOADS_DIR, doc.stored_name)); } catch {}
    await query("DELETE FROM shipment_documents WHERE id = $1", [req.params.docId]);
    await logEntityEvent('document', req.params.docId, 'DELETED', null, null, null,
      JSON.stringify({ shipmentId: doc.shipment_id, docType: doc.doc_type, filename: doc.filename, containerId: doc.container_id || '' }));
    ok(res, { ok: true });
  });

  // ─── Milestone Templates ──────────────────────────────────────────────────

  app.get("/api/milestone-templates", async (req, res) => {
    const rows = await query("SELECT * FROM milestone_templates ORDER BY template_key, carrier_code, sequence_order");
    ok(res, rows.map(mapMilestoneTemplate));
  });

  app.post("/api/milestone-templates", shipmentWrite, async (req, res) => {
    const { templateKey = 'FCL', carrierCode = '', tradeLane = '', milestoneKey, label, sequenceOrder = 0 } = req.body || {};
    if (!milestoneKey || !label) return err(res, "milestoneKey and label required");
    const id = `MT-${uid()}`;
    const now = new Date().toISOString();
    await query("INSERT INTO milestone_templates (id,template_key,carrier_code,trade_lane,milestone_key,label,sequence_order,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, templateKey, carrierCode, tradeLane, milestoneKey, label, Number(sequenceOrder), now]);
    ok(res, mapMilestoneTemplate({ id, template_key: templateKey, carrier_code: carrierCode, trade_lane: tradeLane, milestone_key: milestoneKey, label, sequence_order: Number(sequenceOrder), created_at: now }), 201);
  });

  app.put("/api/milestone-templates/:id", shipmentWrite, async (req, res) => {
    const { templateKey, carrierCode = '', tradeLane = '', milestoneKey, label, sequenceOrder } = req.body || {};
    const [existing] = await query("SELECT * FROM milestone_templates WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    const tKey = templateKey || existing.template_key;
    const mKey = milestoneKey || existing.milestone_key;
    const lbl  = label || existing.label;
    const seq  = sequenceOrder != null ? Number(sequenceOrder) : existing.sequence_order;
    await query("UPDATE milestone_templates SET template_key=$1,carrier_code=$2,trade_lane=$3,milestone_key=$4,label=$5,sequence_order=$6 WHERE id=$7",
      [tKey, carrierCode, tradeLane, mKey, lbl, seq, req.params.id]);
    ok(res, mapMilestoneTemplate({ id: req.params.id, template_key: tKey, carrier_code: carrierCode, trade_lane: tradeLane, milestone_key: mKey, label: lbl, sequence_order: seq, created_at: existing.created_at }));
  });

  app.delete("/api/milestone-templates/:id", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM milestone_templates WHERE id=$1", [req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    await query("DELETE FROM milestone_templates WHERE id=$1", [req.params.id]);
    ok(res, { deleted: req.params.id });
  });

  // ─── Shipment Schedules ───────────────────────────────────────────────────

  const mapScheduleLeg = l => ({
    pol: l.pol || "", pod: l.pod || "", etd: l.etd || "", eta: l.eta || "",
    vesselName: l.vessel_name || "", vesselImo: l.vessel_imo || "",
    voyageNumber: l.voyage_number || "", service: l.service || "", carrier: l.carrier || "",
  });

  // Content-Keyed Sailing Legs — computeLegKey's 6 fields ARE a leg's identity (same carrier +
  // vessel + voyage + route + departure date = the same physical dated sailing segment, whether
  // it's this schedule's leg 2 or another schedule's only leg); eta/vesselName/service are
  // descriptive, not identity, and are the only fields upsertLeg will ever revise in place.
  const computeLegKey = leg => [leg.carrier, leg.vesselImo, leg.voyageNumber, leg.pol, leg.pod, leg.etd]
    .map(v => (v || "").toString().trim().toUpperCase()).join("|");

  // Real upsert, not insert-or-ignore: a leg may be revised later by an external source (a live
  // carrier feed, a re-run generator, a future EDI sync) — diff old vs new on the fields that can
  // actually change and log one entity_events('sailing_leg', ...) row per changed field, the same
  // field-level diff-and-log idiom the schedule PUT route below already uses for its own updates.
  const upsertLeg = async leg => {
    const legKey = computeLegKey(leg);
    const now = new Date().toISOString();
    const [existing] = await query("SELECT * FROM sailing_legs WHERE leg_key=$1", [legKey]);
    if (!existing) {
      await query(`INSERT INTO sailing_legs (leg_key, carrier, pol, pod, etd, eta, vessel_name, vessel_imo, voyage_number, service, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [legKey, leg.carrier || "", leg.pol || "", leg.pod || "", leg.etd || "", leg.eta || "",
             leg.vesselName || "", leg.vesselImo || "", leg.voyageNumber || "", leg.service || "", now, now]);
      return legKey;
    }
    const diffs = [
      ["eta", existing.eta, leg.eta || ""],
      ["vessel_name", existing.vessel_name, leg.vesselName || ""],
      ["service", existing.service, leg.service || ""],
    ].filter(([, o, n]) => String(o || "") !== String(n || ""));
    if (diffs.length) {
      await query("UPDATE sailing_legs SET eta=$1, vessel_name=$2, service=$3, updated_at=$4 WHERE leg_key=$5",
        [leg.eta || "", leg.vesselName || "", leg.service || "", now, legKey]);
      for (const [field, oldV, newV] of diffs) {
        await logEntityEvent("sailing_leg", legKey, "UPDATED", field, oldV, newV,
          JSON.stringify({ carrier: existing.carrier, pol: existing.pol, pod: existing.pod }));
      }
    }
    return legKey;
  };

  // Builds the ordered list of legs to save for a schedule, given whatever legs[] was actually
  // posted (if any) and the schedule's own top-level fields. 2+ legs = real TSP, saved with each
  // leg's own fields only, no cross-leg fallback — leg 2 must never inherit leg 1's vessel/voyage
  // just because one of its own fields happens to be blank (mirrors this route's pre-existing
  // per-leg save behavior). Exactly 1 leg fills only ITS OWN blanks from the top-level fields —
  // safe here since there's no "other leg" to keep distinct from. No legs at all synthesizes one
  // leg entirely from the top-level fields (the "direct sailing" case).
  const buildLegsToSave = (legs, top) => {
    if (Array.isArray(legs) && legs.length >= 2) {
      return legs.map(leg => ({ carrier: leg.carrier || "", pol: leg.pol || "", pod: leg.pod || "",
        etd: leg.etd || "", eta: leg.eta || "", vesselName: leg.vesselName || "",
        vesselImo: leg.vesselImo || "", voyageNumber: leg.voyageNumber || "", service: leg.service || "" }));
    }
    const single = Array.isArray(legs) && legs.length === 1 ? legs[0] : {};
    return [{
      carrier: single.carrier || top.carrier, pol: single.pol || top.pol, pod: single.pod || top.pod,
      etd: single.etd || top.etd, eta: single.eta || top.eta, vesselName: single.vesselName || top.vesselName,
      vesselImo: single.vesselImo || top.vesselImo, voyageNumber: single.voyageNumber || top.voyageNumber,
      service: single.service || top.service,
    }];
  };

  // Every schedule now has 1+ schedule_leg_refs rows (a "direct" sailing is simply one ref) —
  // upserts each leg into the canonical catalog and records the ordered reference list, returning
  // the composed schedule_key (ordered leg_keys) for the caller to store on shipment_schedules.
  const saveScheduleLegs = async (scheduleId, legs) => {
    await query("DELETE FROM schedule_leg_refs WHERE schedule_id=$1", [scheduleId]);
    const legKeys = [];
    for (const leg of legs) legKeys.push(await upsertLeg(leg));
    for (let i = 0; i < legKeys.length; i++) {
      await query("INSERT INTO schedule_leg_refs (schedule_id, leg_key, leg_order) VALUES ($1,$2,$3)", [scheduleId, legKeys[i], i]);
    }
    return legKeys.join("→");
  };

  const getScheduleLegRows = async scheduleId => query(`
    SELECT sl.* FROM schedule_leg_refs r JOIN sailing_legs sl ON sl.leg_key = r.leg_key
    WHERE r.schedule_id=$1 ORDER BY r.leg_order ASC
  `, [scheduleId]);

  // A schedule with exactly 1 leg ref is a direct sailing (legs: null, same convention
  // mockSailings() already uses) — only 2+ makes it a real TSP sailing.
  const getScheduleLegs = async scheduleId => {
    const rows = await getScheduleLegRows(scheduleId);
    return rows.length >= 2 ? rows.map(mapScheduleLeg) : null;
  };

  const mapSchedule = async r => ({
    id:            r.id,
    shipmentId:    r.shipment_id   || null,
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
    templateId:    r.template_id   || null,
    scheduleKey:   r.schedule_key  || "",
    legs:          await getScheduleLegs(r.id),
  });

  // TEU for a shipment's linked-shipments summary row — same size='40'→2 else 1 convention
  // used everywhere else this app computes TEU (e.g. the notification bell, SpaceConfigurationsPage).
  const teuForShipment = async shipmentId => {
    const [{ teu }] = await query("SELECT COALESCE(SUM(CASE WHEN size='40' THEN 2 ELSE 1 END), 0) AS teu FROM containers WHERE shipment_id=$1", [shipmentId]);
    return Number(teu);
  };

  const mapLinkedShipment = async s => ({
    id: s.id, pol: s.pol, pod: s.pod, etd: s.etd || "",
    contractType: s.contract_type || "", contractRef: s.contract_ref || "",
    status: s.status, teu: await teuForShipment(s.id),
  });

  app.get("/api/shipments/:id/schedules", auth(), async (req, res) => {
    const rows = await query("SELECT * FROM shipment_schedules WHERE shipment_id=$1 ORDER BY saved_at DESC", [req.params.id]);
    ok(res, await Promise.all(rows.map(mapSchedule)));
  });

  app.post("/api/shipments/:id/schedules", shipmentWrite, async (req, res) => {
    if (!(await query("SELECT id FROM shipments WHERE id=$1", [req.params.id]))[0])
      return err(res, "Shipment not found", 404);
    const { carrier = "", vesselName = "", vesselImo = "", voyageNumber = "", service = "",
            pol = "", pod = "", etd = "", eta = "", transitDays = 0, isMock = false,
            templateId = null, legs = null } = req.body;
    const id = `SCHED-${uid()}`;
    const savedAt = new Date().toISOString();
    const savedBy = req.user?.name || req.user?.email || "";
    // templateId (optional) — set when this sailing was picked from a catalog match (a
    // Schedule-Generator-authored template, or any other stored schedule) rather than freshly
    // synthesized from mock/live data; pure provenance, doesn't change how this row behaves.
    await query(`INSERT INTO shipment_schedules
      (id, shipment_id, carrier, vessel_name, vessel_imo, voyage_number, service, pol, pod, etd, eta, transit_days, is_mock, saved_at, saved_by, template_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, req.params.id, carrier, vesselName, vesselImo, voyageNumber, service, pol, pod, etd, eta,
           Number(transitDays), !!isMock, savedAt, savedBy, templateId]);
    // The picked sailing's own legs[] (when it's a multi-leg catalog/mock/live match) already
    // arrives in this body — commitSailing() (ShipmentSchedulesPage.jsx) spreads the whole sailing
    // object it received from search, this just wasn't reading `legs` before. Without this, a
    // shipment picking a TSP sailing silently lost the transshipment-leg detail on save (legs came
    // back null on its own row even though the match it was copied from had 2+ legs).
    const legsToSave = buildLegsToSave(legs, { carrier, pol, pod, etd, eta, vesselName, vesselImo, voyageNumber, service });
    const scheduleKey = await saveScheduleLegs(id, legsToSave);
    await query("UPDATE shipment_schedules SET schedule_key=$1 WHERE id=$2", [scheduleKey, id]);
    await logEntityEvent('schedule', id, 'SAVED', null, null, null,
      JSON.stringify({ shipmentId: req.params.id, carrier, vesselName, vesselImo, voyageNumber, service, pol, pod, etd, eta,
        transitDays: Number(transitDays), actor: savedBy }));
    // Same History-tab gap as parties/side-offices (routes/shipments.js) — the Schedule History
    // panel already showed this via entity_events, but the shipment's own unified History tab
    // (GET /api/shipments/:id/events, shipment_events only) never heard about a schedule being
    // picked at all.
    await logEvent(req.params.id, 'SCHEDULE_ASSIGNED', null, null, `${carrier} ${vesselName} ${voyageNumber}`.trim(),
      JSON.stringify({ carrier, vesselName, voyageNumber, pol, pod, etd, eta }), req.user?.id);
    await ensureBookingCreated(req.params.id);
    ok(res, await mapSchedule({ id, shipment_id: req.params.id, carrier, vessel_name: vesselName, vessel_imo: vesselImo,
      voyage_number: voyageNumber, service, pol, pod, etd, eta,
      transit_days: Number(transitDays), is_mock: !!isMock, saved_at: savedAt, saved_by: savedBy,
      template_id: templateId, schedule_key: scheduleKey }), 201);
  });

  // Lightweight correction for an already-saved sailing (e.g. a carrier-driven ETD/ETA shift) —
  // keeps shipment_schedules AND the backing SEA leg(s) in lockstep in one action, instead of
  // the only previous option (remove the SEA leg entirely, which cascades to delete the
  // schedule, unlock everything, and force a full re-search). Logs one field-level 'UPDATED'
  // entity event per changed value, mirroring the cost-line history pattern, so ScheduleHistory
  // shows a real old→new diff rather than the schedule record silently going stale.
  app.put("/api/shipments/:id/schedules/:scheduleId", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_schedules WHERE id=$1 AND shipment_id=$2", [req.params.scheduleId, req.params.id]);
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

    await query("UPDATE shipment_schedules SET vessel_name=$1, voyage_number=$2, etd=$3, eta=$4, carrier=$5 WHERE id=$6",
      [vesselName, voyageNumber, etd, eta, carrier, req.params.scheduleId]);

    for (const [field, oldVal, newVal] of changes) {
      await logEntityEvent('schedule', req.params.scheduleId, 'UPDATED', field, oldVal, newVal,
        JSON.stringify({ shipmentId: req.params.id, actor }));
      await logEvent(req.params.id, 'SCHEDULE_UPDATED', field, oldVal, newVal, '', req.user?.id);
    }

    // Keep the canonical leg data (sailing_legs/schedule_leg_refs) in lockstep with this
    // correction too — first leg carries the corrected vessel/voyage/etd/carrier, last leg
    // carries the corrected eta (same first/last convention the shipment_legs sync below uses);
    // any legs in between are left untouched. Without this, a real carrier-driven vessel/voyage
    // substitution left schedule_key (and the underlying leg content) silently frozen on the
    // ORIGINAL sailing even though vesselName/voyageNumber/etd/eta had all visibly changed —
    // found live via manual testing. Re-saving recomputes schedule_key and, since vessel/voyage/
    // etd are identity fields, correctly resolves to a DIFFERENT leg_key when they actually
    // change (a genuine vessel substitution is a different leg, not an edit to the old one) while
    // a same-vessel ETD-only bump still lands as a normal upsertLeg update with its own audit
    // entry — either way it's no longer invisible to the leg-reuse system.
    const existingLegRows = (await getScheduleLegRows(req.params.scheduleId)).map(mapScheduleLeg);
    const legsForCorrection = existingLegRows.length > 0 ? existingLegRows
      : [{ carrier: existing.carrier, pol: existing.pol, pod: existing.pod, etd: existing.etd, eta: existing.eta,
           vesselName: existing.vessel_name, vesselImo: existing.vessel_imo, voyageNumber: existing.voyage_number, service: existing.service }];
    const lastIdx = legsForCorrection.length - 1;
    const correctedLegs = legsForCorrection.map((l, i) => ({
      ...l,
      ...(i === 0 ? { carrier, vesselName, voyageNumber, etd } : {}),
      ...(i === lastIdx ? { eta } : {}),
    }));
    const scheduleKey = await saveScheduleLegs(req.params.scheduleId, correctedLegs);
    await query("UPDATE shipment_schedules SET schedule_key=$1 WHERE id=$2", [scheduleKey, req.params.scheduleId]);

    // Keep the SEA leg(s) backing this schedule in lockstep — first leg carries
    // vessel/voyage/etd/carrier, last leg carries eta (handles both direct and TSP sailings,
    // matching the first/last-leg convention already used by applySailingToLegs elsewhere).
    const legs = await query("SELECT * FROM shipment_legs WHERE shipment_id=$1 ORDER BY leg_order ASC", [req.params.id]);
    const seaLegs = legs.filter(l => l.leg_type === 'SEA');
    if (seaLegs.length > 0) {
      const first = seaLegs[0], last = seaLegs[seaLegs.length - 1];
      await query("UPDATE shipment_legs SET vessel=$1, voyage=$2, etd=$3, carrier_code=$4 WHERE id=$5",
        [vesselName, voyageNumber, etd, carrier, first.id]);
      await query("UPDATE shipment_legs SET eta=$1 WHERE id=$2", [eta, last.id]);
      await syncShipmentFromLegs(req.params.id, req.user?.id);
    }

    const [fresh] = await query("SELECT * FROM shipment_schedules WHERE id=$1", [req.params.scheduleId]);
    ok(res, await mapSchedule(fresh));
  });

  app.delete("/api/shipments/:id/schedules/:scheduleId", shipmentWrite, async (req, res) => {
    const [existing] = await query("SELECT * FROM shipment_schedules WHERE id=$1 AND shipment_id=$2", [req.params.scheduleId, req.params.id]);
    if (!existing) return err(res, "Not found", 404);
    await query("DELETE FROM shipment_schedules WHERE id=$1", [req.params.scheduleId]);
    await logEntityEvent('schedule', req.params.scheduleId, 'REMOVED', null, null, null,
      JSON.stringify({ shipmentId: req.params.id, carrier: existing.carrier, vesselName: existing.vessel_name,
        vesselImo: existing.vessel_imo, voyageNumber: existing.voyage_number, service: existing.service,
        pol: existing.pol, pod: existing.pod, etd: existing.etd, eta: existing.eta, transitDays: existing.transit_days,
        actor: req.user?.name || req.user?.email || "" }));
    await logEvent(req.params.id, 'SCHEDULE_REMOVED', null, `${existing.carrier} ${existing.vessel_name} ${existing.voyage_number}`.trim(), null,
      JSON.stringify({ carrier: existing.carrier, vesselName: existing.vessel_name, voyageNumber: existing.voyage_number }), req.user?.id);
    ok(res, { deleted: req.params.scheduleId });
  });

  // ─── Schedule catalog (Test Tools > Schedule Generator) ────────────────────────────────
  // A schedule created here is a pure, ownerless "template" (shipment_id NULL) — it exists to be
  // FOUND by the everyday sailing-search flow (GET /api/schedules/search) and copied into a real
  // shipment's own shipment_schedules row (POST /api/shipments/:id/schedules, which then stamps
  // template_id back to this row for provenance). Nothing here writes to a shipment directly —
  // there's no shipment to sync a SEA leg onto until a real shipment actually picks it via search.

  app.post("/api/schedules", shipmentWrite, async (req, res) => {
    const { carrier = "", vesselImo = "", vesselName = "", voyageNumber = "", service = "",
            pol = "", pod = "", etd = "", atd = "", eta = "", ata = "",
            legs = null } = req.body;
    if (carrier && !(await query("SELECT 1 FROM carriers WHERE code=$1", [carrier]))[0])
      return err(res, `Unknown carrier code: ${carrier}`, 400);
    if (vesselImo && !(await query("SELECT 1 FROM vessels WHERE imo=$1", [vesselImo]))[0])
      return err(res, `Unknown vessel IMO: ${vesselImo}`, 400);
    if (pol && !(await query("SELECT 1 FROM port_locations WHERE unlocode=$1", [pol]))[0])
      return err(res, `Unknown POL: ${pol}`, 400);
    if (pod && !(await query("SELECT 1 FROM port_locations WHERE unlocode=$1", [pod]))[0])
      return err(res, `Unknown POD: ${pod}`, 400);

    // A real TSP schedule (2+ legs) derives its own summary fields from the leg chain — first
    // leg's pol/vessel/voyage/etd, last leg's pod/eta — rather than trusting separately-typed
    // top-level fields that could disagree with what was actually built in the legs modal.
    const isTSP = Array.isArray(legs) && legs.length >= 2;
    const first = isTSP ? legs[0] : null;
    const last  = isTSP ? legs[legs.length - 1] : null;
    // Leg rows built in the Generator's legs modal don't collect a per-leg vessel IMO (the main
    // form's own VesselField pick already provides one) — fall back to the top-level fields
    // whenever a leg's own value is blank, rather than dropping it.
    const finalVesselName   = isTSP ? (first.vesselName   || vesselName)   : vesselName;
    const finalVesselImo    = isTSP ? (first.vesselImo     || vesselImo)    : vesselImo;
    const finalVoyageNumber = isTSP ? (first.voyageNumber || voyageNumber) : voyageNumber;
    const finalService      = isTSP ? (first.service       || service)     : service;
    const finalCarrier      = isTSP ? (first.carrier       || carrier)     : carrier;
    const finalPol          = isTSP ? (first.pol           || pol)         : pol;
    const finalPod          = isTSP ? (last.pod             || pod)         : pod;
    const finalEtd          = isTSP ? (first.etd           || etd)         : etd;
    const finalEta          = isTSP ? (last.eta             || eta)         : eta;
    // Whole-journey ETD->ETA span, not a sum of per-leg transit times — this naturally folds
    // in any hub dwell time between legs (e.g. leg 1 arrives at the transshipment port, leg 2
    // doesn't depart for another 3 days) instead of undercounting it. Previously hardcoded to
    // 0 here unconditionally — a live bug report caught it on a real TSP catalog match showing
    // "0d" transit for an 8-day door-to-door sailing.
    const finalEtdDate = finalEtd ? new Date(finalEtd) : null;
    const finalEtaDate = finalEta ? new Date(finalEta) : null;
    const finalTransitDays = (finalEtdDate && finalEtaDate && !isNaN(finalEtdDate) && !isNaN(finalEtaDate))
      ? Math.max(0, Math.round((finalEtaDate - finalEtdDate) / 86400000))
      : 0;

    const id = `SCHED-${uid()}`;
    const savedAt = new Date().toISOString();
    const savedBy = req.user?.name || req.user?.email || "";
    await query(`INSERT INTO shipment_schedules
      (id, shipment_id, carrier, vessel_name, voyage_number, service, pol, pod, etd, eta,
       transit_days, is_mock, saved_at, saved_by, vessel_imo, atd, ata, source, template_id)
      VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'generated',NULL)`,
      [id, finalCarrier, finalVesselName, finalVoyageNumber, finalService, finalPol, finalPod,
           finalEtd, finalEta, finalTransitDays, false, savedAt, savedBy, finalVesselImo, atd, ata]);

    // Every schedule is now backed by 1+ canonical sailing_legs rows (see buildLegsToSave/
    // saveScheduleLegs above).
    const legsToSave = buildLegsToSave(legs, { carrier: finalCarrier, pol: finalPol, pod: finalPod,
      etd: finalEtd, eta: finalEta, vesselName: finalVesselName, vesselImo: finalVesselImo,
      voyageNumber: finalVoyageNumber, service: finalService });
    const scheduleKey = await saveScheduleLegs(id, legsToSave);
    await query("UPDATE shipment_schedules SET schedule_key=$1 WHERE id=$2", [scheduleKey, id]);

    await logEntityEvent('schedule', id, 'SAVED', null, null, null,
      JSON.stringify({ carrier: finalCarrier, vesselName: finalVesselName, vesselImo: finalVesselImo, voyageNumber: finalVoyageNumber,
        service: finalService, pol: finalPol, pod: finalPod, etd: finalEtd, eta: finalEta, transitDays: finalTransitDays,
        actor: savedBy, source: 'generated', legCount: isTSP ? legs.length : 1 }));

    const [row] = await query("SELECT * FROM shipment_schedules WHERE id=$1", [id]);
    ok(res, await mapSchedule(row), 201);
  });

  app.get("/api/schedules", auth(), async (req, res) => {
    const { source } = req.query;
    const rows = source
      ? await query("SELECT * FROM shipment_schedules WHERE source=$1 ORDER BY saved_at DESC LIMIT 100", [source])
      : await query("SELECT * FROM shipment_schedules ORDER BY saved_at DESC LIMIT 100");
    const withCounts = await Promise.all(rows.map(async r => {
      const [{ n }] = await query("SELECT COUNT(*) AS n FROM shipment_schedules WHERE template_id=$1", [r.id]);
      return { ...(await mapSchedule(r)), usedByCount: Number(n) };
    }));
    ok(res, withCounts);
  });

  // Read-only usage view — which real shipments ended up with their own shipment_schedules row
  // copied from this template (via POST /api/shipments/:id/schedules' templateId passthrough).
  // Replaces the old linked-shipments/link/unlink trio now that assignment happens exclusively
  // through search-and-copy, not manual linking.
  app.get("/api/schedules/:id/usage", auth(), async (req, res) => {
    const [sched] = await query("SELECT * FROM shipment_schedules WHERE id=$1", [req.params.id]);
    if (!sched) return err(res, "Not found", 404);
    const usedByRows = await query(`
      SELECT s.* FROM shipment_schedules t
      JOIN shipments s ON s.id = t.shipment_id
      WHERE t.template_id=$1 ORDER BY t.saved_at ASC`, [req.params.id]);
    ok(res, { usedBy: await Promise.all(usedByRows.map(mapLinkedShipment)) });
  });

  // Deletes a catalog template. Templates have no owning shipment, so the existing per-shipment
  // DELETE /api/shipments/:id/schedules/:scheduleId route (scoped WHERE shipment_id=?) can never
  // reach one — this is the only way to remove a generated schedule. schedule_legs rows cascade;
  // any shipment-owned row that copied this template (template_id) keeps its own data, only its
  // template_id reference is cleared (ON DELETE SET NULL) — deleting a template never touches a
  // shipment's own already-applied sailing.
  app.delete("/api/schedules/:id", shipmentWrite, async (req, res) => {
    const [sched] = await query("SELECT * FROM shipment_schedules WHERE id=$1", [req.params.id]);
    if (!sched) return err(res, "Not found", 404);
    await query("DELETE FROM shipment_schedules WHERE id=$1", [req.params.id]);
    await logEntityEvent('schedule', req.params.id, 'REMOVED', null, null, null,
      JSON.stringify({ carrier: sched.carrier, vesselName: sched.vessel_name, vesselImo: sched.vessel_imo,
        voyageNumber: sched.voyage_number, pol: sched.pol, pod: sched.pod, etd: sched.etd, eta: sched.eta,
        transitDays: sched.transit_days, actor: req.user?.name || req.user?.email || "", source: 'generated' }));
    ok(res, { deleted: req.params.id });
  });

  app.get("/api/shipments/:id/schedule-events", async (req, res) => {
    // A sailing_leg's own UPDATED events (upsertLeg, above) have no shipmentId in their meta —
    // a leg is shared/canonical, not owned by one shipment — so they're scoped here via a join
    // instead: any leg that actually backs one of THIS shipment's own schedules.
    const rows = await query(`
      SELECT * FROM entity_events
      WHERE entity_type = 'schedule'
      AND meta IS NOT NULL AND (meta::jsonb)->>'shipmentId' = $1
      UNION ALL
      SELECT * FROM entity_events
      WHERE entity_type = 'sailing_leg' AND entity_id IN (
        SELECT r.leg_key FROM schedule_leg_refs r
        JOIN shipment_schedules s ON s.id = r.schedule_id
        WHERE s.shipment_id = $2
      )
      ORDER BY created_at DESC
    `, [req.params.id, req.params.id]);
    ok(res, rows);
  });
};
