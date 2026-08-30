"use strict";

// ─── Customs & Regulatory Filing (Epic TKT-XW6TQK) ─────────────────────────────
// Mirrors carrier_bookings/routes/edi.js closely, minus the archive/supersede
// machinery (not needed — a shipment can independently need one AES/EEI export
// filing AND one ISF/AMS import filing; UNIQUE(shipment_id, filing_type) lets
// both coexist as their own rows, nothing "supersedes" the other). Reuses the
// existing edi_messages table for submission/response messages rather than a
// new table — every row this file inserts sets correlation_id = filing.id so a
// shipment's two filings' threads stay independently filterable even though
// they share one physical table. SIMULATED/MOCK ONLY — no real government EDI
// integration, matching the carrier-booking Test Tools precedent exactly.

module.exports = function customsFilingRoutes(app, ctx) {
  const { db, uid, ok, err, auth, requireRole, applyShipmentAccessFilter,
          mapCustomsFiling, mapEdiMessage, mapShipment,
          logEntityEvent, isUniqueViolation, CUSTOMS_FILING_TYPES, autoCompleteMilestone } = ctx;

  const write = requireRole(["operator", "admin", "occ_bk"]); // same set as routes/edi.js

  const FILING_TYPE_LABEL = { AES_EEI: "AES/EEI (Export)", ISF_AMS: "ISF/AMS (Import)" };
  const REF_PREFIX = { AES_EEI: "AES", ISF_AMS: "ISF" };
  // Matches ShipmentCustomsFilingDetailsPage.jsx's own per-card "Create Filing" precondition
  // exactly (hasThisBroker) — previously only enforced client-side, so a direct API call could
  // create a filing with no broker assigned and no priced cargo at all.
  const FILING_TYPE_BROKER_ROLE = { AES_EEI: "Customs Broker (Export)", ISF_AMS: "Customs Broker (Import)" };

  // Priced cargo lines at THIS moment, for the Submit-time snapshot below (TKT-6A7J45,
  // story 4) — captures exactly what a real EEI declaration requires per line (HS code,
  // quantity, value), not just "a priced package exists somewhere" (the create-gate's own,
  // deliberately looser, check).
  function cargoSnapshotFor(shipmentId) {
    const rows = db.prepare(`
      SELECT cp.description, cp.hs_code, cp.quantity, cp.unit_value, cp.currency, cp.unit_value_usd
      FROM container_packages cp JOIN containers c ON c.id = cp.container_id
      WHERE c.shipment_id=? AND cp.unit_value_usd IS NOT NULL
    `).all(shipmentId);
    return rows.map(r => ({
      description: r.description, hsCode: r.hs_code || '', quantity: r.quantity,
      unitValue: r.unit_value, currency: r.currency || '', unitValueUsd: r.unit_value_usd,
    }));
  }

  // A Filed/Accepted filing's own snapshot (captured once, at Submit) vs. the shipment's
  // CURRENT data — story 5: nothing previously flagged a filing as potentially inaccurate
  // if the carrier, vessel/voyage, or priced cargo changed afterward. Compared by value, not
  // stored as a flag, same "recompute live" idiom ContractMismatchModal/useContractMismatch
  // already use for the analogous contract-route-mismatch case.
  function stalenessOf(filing, shipment) {
    if (filing.status !== 'Filed' && filing.status !== 'Accepted') return { isStale: false, staleFields: [] };
    const staleFields = [];
    if ((filing.carrier_code || '') !== (shipment.carrier_code || '')) staleFields.push('carrier');
    if ((filing.vessel_name || '') !== (shipment.vessel || '')) staleFields.push('vessel');
    if ((filing.voyage_number || '') !== (shipment.voyage || '')) staleFields.push('voyage');
    const currentSnapshot = JSON.stringify(cargoSnapshotFor(shipment.id));
    if ((filing.cargo_snapshot || '[]') !== currentSnapshot) staleFields.push('cargo');
    return { isStale: staleFields.length > 0, staleFields };
  }

  function mapWithStaleness(filing, shipment) {
    return { ...mapCustomsFiling(filing), ...stalenessOf(filing, shipment) };
  }

  function insertMessage(shipmentId, filingId, direction, messageType, status, rawPayload, isMock) {
    const id = `EDI-${uid()}`, now = new Date().toISOString();
    db.prepare(`INSERT INTO edi_messages (id, shipment_id, carrier_code, direction, message_type,
      format, raw_payload, status, correlation_id, is_mock, created_at, processed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, shipmentId, "", direction, messageType, "JSON", JSON.stringify(rawPayload),
           status, filingId, isMock ? 1 : 0, now, now);
    return mapEdiMessage(db.prepare("SELECT * FROM edi_messages WHERE id=?").get(id));
  }

  app.get("/api/shipments/:id/customs-filings", auth(), (req, res) => {
    const rows = db.prepare("SELECT * FROM customs_filings WHERE shipment_id=? ORDER BY created_at ASC").all(req.params.id);
    if (rows.length === 0) return ok(res, []);
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    ok(res, rows.map(r => mapWithStaleness(r, shipment)));
  });

  // Cross-shipment list for the Test Tools Filing Simulator picker — mirrors GET /api/carrier-bookings.
  app.get("/api/customs-filings", auth(), async (req, res) => {
    const { status } = req.query;
    const rows = status
      ? db.prepare("SELECT * FROM customs_filings WHERE status=? ORDER BY updated_at DESC").all(status)
      : db.prepare("SELECT * FROM customs_filings ORDER BY updated_at DESC").all();
    if (rows.length === 0) return ok(res, []);
    const shipmentIds = [...new Set(rows.map(r => r.shipment_id))];
    const ph = shipmentIds.map(() => "?").join(",");
    const shipmentRows = db.prepare(`SELECT * FROM shipments WHERE id IN (${ph})`).all(...shipmentIds);
    const allowedShipments = await applyShipmentAccessFilter(shipmentRows.map(mapShipment), req.user, req);
    const shipmentById = new Map(allowedShipments.map(s => [s.id, s]));
    ok(res, rows.filter(r => shipmentById.has(r.shipment_id))
      .map(r => ({ ...mapCustomsFiling(r), shipment: shipmentById.get(r.shipment_id) })));
  });

  app.post("/api/shipments/:id/customs-filings", write, async (req, res) => {
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    if (!shipment) return err(res, "Shipment not found", 404);
    const { filingType } = req.body || {};
    if (!CUSTOMS_FILING_TYPES.includes(filingType))
      return err(res, `filingType must be one of ${CUSTOMS_FILING_TYPES.join(", ")}`);
    const brokerRole = FILING_TYPE_BROKER_ROLE[filingType];
    const hasBroker = !!db.prepare("SELECT id FROM shipment_parties WHERE shipment_id=? AND role=?").get(shipment.id, brokerRole);
    if (!hasBroker) return err(res, `Assign a ${brokerRole} to this shipment before creating a ${FILING_TYPE_LABEL[filingType]} filing`);
    const hasCargo = !!db.prepare(`
      SELECT cp.id FROM container_packages cp
      JOIN containers c ON c.id = cp.container_id
      WHERE c.shipment_id=? AND cp.unit_value_usd IS NOT NULL
    `).get(shipment.id);
    if (!hasCargo) return err(res, "At least one priced cargo line is required before creating a customs filing");
    // USPPI (Shipper) and Ultimate Consignee are both legally required EEI fields — previously
    // only enforced client-side on the gate modal's checklist; a direct API call could still
    // create a filing with neither set. Mirrors the broker/cargo checks just above.
    if (!shipment.shipper_name) return err(res, "This shipment has no Shipper (USPPI) set — add one on Parties & Offices before creating a customs filing");
    if (!shipment.consignee_name) return err(res, "This shipment has no Consignee (Ultimate Consignee) set — add one on Parties & Offices before creating a customs filing");
    const id = `CF-${uid()}`, now = new Date().toISOString();
    try {
      db.prepare(`INSERT INTO customs_filings (id, shipment_id, filing_type, status, created_at, updated_at)
        VALUES (?,?,?,'Draft',?,?)`).run(id, shipment.id, filingType, now, now);
    } catch (e) {
      if (isUniqueViolation(e)) return err(res, `A ${FILING_TYPE_LABEL[filingType]} filing already exists for this shipment`, 409);
      throw e;
    }
    await logEntityEvent('customs_filing', id, 'CREATED', null, null, null, JSON.stringify({ filingType }));
    ok(res, mapCustomsFiling(db.prepare("SELECT * FROM customs_filings WHERE id=?").get(id)), 201);
  });

  app.post("/api/shipments/:id/customs-filings/:filingId/submit", write, async (req, res) => {
    const filing = db.prepare("SELECT * FROM customs_filings WHERE id=? AND shipment_id=?").get(req.params.filingId, req.params.id);
    if (!filing) return err(res, "Filing not found", 404);
    if (filing.status !== "Draft") return err(res, `Filing is already ${filing.status.toLowerCase()}`, 409);
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    const now = new Date().toISOString();
    const filingRef = `${REF_PREFIX[filing.filing_type]}${uid()}`;
    // Snapshot conveyance + cargo data at the moment of Submit (TKT-6A7J45, stories 3-4) —
    // both what actually gets transmitted below AND what a later staleness check compares
    // against, so "the filing says X" has a real, comparable answer instead of just a
    // reference number.
    const cargoSnapshot = cargoSnapshotFor(shipment.id);
    db.prepare(`UPDATE customs_filings SET status='Filed', filing_reference=?, filed_at=?, filed_by=?,
      carrier_code=?, vessel_name=?, voyage_number=?, export_date=?, cargo_snapshot=?, updated_at=? WHERE id=?`)
      .run(filingRef, now, req.user?.name || req.user?.email || "",
           shipment.carrier_code || '', shipment.vessel || '', shipment.voyage || '', shipment.etd || '',
           JSON.stringify(cargoSnapshot), now, filing.id);
    const sent = insertMessage(shipment.id, filing.id, "out", "customs_filing_submission", "sent", {
      filingType: filing.filing_type, filingReference: filingRef, pol: shipment.pol, pod: shipment.pod,
      carrierCode: shipment.carrier_code || null, vessel: shipment.vessel || null, voyage: shipment.voyage || null,
      exportDate: shipment.etd || null, cargoLineCount: cargoSnapshot.length,
      note: "Submitted for simulated regulatory review (Epic TKT-XW6TQK — no live government EDI integration).",
    }, false);
    await logEntityEvent('customs_filing', filing.id, 'SUBMITTED', null, 'Draft', 'Filed', JSON.stringify({ filingReference: filingRef }));
    ok(res, { sent, filing: mapWithStaleness(db.prepare("SELECT * FROM customs_filings WHERE id=?").get(filing.id), shipment) }, 201);
  });

  app.post("/api/shipments/:id/customs-filings/:filingId/simulate-response", write, async (req, res) => {
    const filing = db.prepare("SELECT * FROM customs_filings WHERE id=? AND shipment_id=?").get(req.params.filingId, req.params.id);
    if (!filing) return err(res, "Filing not found", 404);
    const { outcome, confirmationNumber, reason } = req.body || {};
    if (outcome !== "accepted" && outcome !== "rejected") return err(res, 'outcome must be "accepted" or "rejected"');
    if (filing.status !== "Filed") return err(res, "This filing has no pending submission to respond to", 409);
    const shipment = db.prepare("SELECT * FROM shipments WHERE id=?").get(req.params.id);
    const now = new Date().toISOString();
    if (outcome === "accepted") {
      const confNum = confirmationNumber?.trim() || `CBP${uid()}`;
      db.prepare(`UPDATE customs_filings SET status='Accepted', confirmation_number=?, responded_at=?, updated_at=? WHERE id=?`)
        .run(confNum, now, now, filing.id);
      insertMessage(shipment.id, filing.id, "in", "customs_filing_acceptance", "accepted",
        { confirmationNumber: confNum, note: "Simulated via Test Tools → Filing Simulator." }, true);
      await logEntityEvent('customs_filing', filing.id, 'ACCEPTED', null, 'Filed', 'Accepted', JSON.stringify({ confirmationNumber: confNum }));
      // customs_cleared sits AFTER vessel_arrived in the FCL milestone sequence (seq 7, right
      // before cargo_released) — that's destination/import clearance, so only an accepted
      // ISF/AMS (import) filing completes it. AES/EEI is export-side and pre-departure; there's
      // no matching step for it in the current 9-step template, so nothing is wired for it here.
      if (filing.filing_type === 'ISF_AMS') {
        autoCompleteMilestone(shipment.id, 'customs_cleared', `ISF/AMS import filing accepted (confirmation ${confNum})`);
      }
    } else {
      const rejReason = reason?.trim() || "Filing rejected — data did not pass regulatory validation.";
      db.prepare(`UPDATE customs_filings SET status='Rejected', rejection_reason=?, responded_at=?, updated_at=? WHERE id=?`)
        .run(rejReason, now, now, filing.id);
      insertMessage(shipment.id, filing.id, "in", "customs_filing_rejection", "rejected",
        { reason: rejReason, note: "Simulated via Test Tools → Filing Simulator." }, true);
      await logEntityEvent('customs_filing', filing.id, 'REJECTED', null, 'Filed', 'Rejected', JSON.stringify({ reason: rejReason }));
    }
    ok(res, { filing: mapWithStaleness(db.prepare("SELECT * FROM customs_filings WHERE id=?").get(filing.id), shipment) }, 201);
  });

  // Allows resubmission after a rejection — the next Submit generates a genuinely new
  // filing_reference rather than reusing the rejected one.
  app.patch("/api/shipments/:id/customs-filings/:filingId/reset", write, async (req, res) => {
    const filing = db.prepare("SELECT * FROM customs_filings WHERE id=? AND shipment_id=?").get(req.params.filingId, req.params.id);
    if (!filing) return err(res, "Filing not found", 404);
    if (filing.status !== "Rejected") return err(res, "Only a Rejected filing can be reset to Draft", 409);
    const now = new Date().toISOString();
    db.prepare(`UPDATE customs_filings SET status='Draft', filing_reference='', rejection_reason='',
      filed_at=NULL, filed_by='', responded_at=NULL,
      carrier_code='', vessel_name='', voyage_number='', export_date='', cargo_snapshot='[]',
      updated_at=? WHERE id=?`).run(now, filing.id);
    await logEntityEvent('customs_filing', filing.id, 'RESET_TO_DRAFT', null, 'Rejected', 'Draft');
    ok(res, mapCustomsFiling(db.prepare("SELECT * FROM customs_filings WHERE id=?").get(filing.id)));
  });
};
