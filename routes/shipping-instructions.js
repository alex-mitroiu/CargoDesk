"use strict";

// ─── Shipping Instructions (2026-09 FCL export gap analysis, finding #1) ───────
// One row per shipment (UNIQUE shipment_id) — unlike customs_filings (up to 2 per shipment,
// AES/EEI + ISF/AMS both real), a shipment only ever has one SI. Mirrors
// routes/customs-filing.js's Draft->Filed(Submitted)->Accepted(Confirmed)/Rejected shape and
// its edi_messages-reuse idiom exactly. SIMULATED/MOCK ONLY — no real carrier SI/EDI
// integration, matching the carrier-booking/customs-filing Test Tools precedent.

module.exports = function shippingInstructionsRoutes(app, ctx) {
  const { query, uid, ok, err, auth, requireRole, applyShipmentAccessFilter, mapShipment,
          mapShippingInstructions, mapEdiMessage,
          logEntityEvent, autoCompleteMilestone, officeSideOf, blockIfWrongSide } = ctx;

  const write = requireRole(["operator", "admin", "occ_bk"]); // same set as routes/edi.js / customs-filing.js

  async function insertMessage(shipmentId, correlationId, direction, messageType, status, rawPayload, isMock) {
    const id = `EDI-${uid()}`, now = new Date().toISOString();
    await query(`INSERT INTO edi_messages (id, shipment_id, carrier_code, direction, message_type,
      format, raw_payload, status, correlation_id, is_mock, created_at, processed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, shipmentId, "", direction, messageType, "JSON", JSON.stringify(rawPayload),
           status, correlationId, !!isMock, now, now]);
    const [msg] = await query("SELECT * FROM edi_messages WHERE id=$1", [id]);
    return mapEdiMessage(msg);
  }

  app.get("/api/shipments/:id/shipping-instructions", auth(), async (req, res) => {
    const [row] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    ok(res, row ? mapShippingInstructions(row) : null);
  });

  // Upsert the Draft — cutoff + special instructions only. Refused once Submitted/Confirmed
  // (reset first, same "no editing what's already in flight" rule customs filings enforce
  // implicitly by having no edit route at all once Filed).
  app.put("/api/shipments/:id/shipping-instructions", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const { siCutoff = "", specialInstructions = "" } = req.body || {};
    const [existing] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    const now = new Date().toISOString();
    if (existing) {
      if (existing.status !== "Draft") return err(res, `Cannot edit — this Shipping Instructions record is ${existing.status.toLowerCase()}. Reset it to Draft first.`, 409);
      await query(`UPDATE shipping_instructions SET si_cutoff=$1, special_instructions=$2, updated_at=$3 WHERE id=$4`,
        [siCutoff || null, specialInstructions, now, existing.id]);
    } else {
      await query(`INSERT INTO shipping_instructions (id, shipment_id, status, si_cutoff, special_instructions, created_at, updated_at)
        VALUES ($1,$2,'Draft',$3,$4,$5,$5)`, [`SI-${uid()}`, req.params.id, siCutoff || null, specialInstructions, now]);
    }
    const [row] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    ok(res, mapShippingInstructions(row), existing ? 200 : 201);
  });

  app.post("/api/shipments/:id/shipping-instructions/submit", write, async (req, res) => {
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const [si] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    if (!si) return err(res, "Save the Shipping Instructions details before submitting", 404);
    if (si.status !== "Draft") return err(res, `Already ${si.status.toLowerCase()}`, 409);
    if (!shipment.shipper_name) return err(res, "This shipment has no Shipper set — add one on Parties & Offices before submitting Shipping Instructions");
    if (!shipment.consignee_name) return err(res, "This shipment has no Consignee set — add one on Parties & Offices before submitting Shipping Instructions");
    const containers = await query("SELECT container_number, seal_number, size, type, cargo_description, marks_and_numbers FROM containers WHERE shipment_id=$1", [shipment.id]);
    if (containers.length === 0) return err(res, "At least one container is required before submitting Shipping Instructions");
    const now = new Date().toISOString();
    const siRef = `SI${uid()}`;
    await query(`UPDATE shipping_instructions SET status='Submitted', si_reference=$1, submitted_at=$2, submitted_by=$3, updated_at=$4 WHERE id=$5`,
      [siRef, now, req.user?.name || req.user?.email || "", now, si.id]);
    const sent = await insertMessage(shipment.id, si.id, "out", "shipping_instructions_submission", "sent", {
      siReference: siRef, shipperName: shipment.shipper_name, consigneeName: shipment.consignee_name,
      notifyName: shipment.notify_name || null, containerCount: containers.length,
      containers: containers.map(c => ({ containerNumber: c.container_number, sealNumber: c.seal_number, size: c.size, type: c.type })),
      siCutoff: si.si_cutoff || null, specialInstructions: si.special_instructions || "",
      note: "Submitted for simulated carrier processing — no live carrier SI/EDI integration.",
    }, false);
    // Direct, accurate trigger for si_submitted — sits alongside the pre-existing all-containers-
    // VGM-Submitted heuristic (TKT-OZD4V8) rather than replacing it; autoCompleteMilestone is a
    // no-op once already completed, so whichever signal arrives first wins, same "AIS + manual
    // both remain working fallbacks" precedent as the vessel_departed/vessel_arrived fix.
    await autoCompleteMilestone(shipment.id, 'si_submitted', `Shipping Instructions submitted (reference ${siRef})`);
    await logEntityEvent('shipping_instructions', si.id, 'SUBMITTED', null, 'Draft', 'Submitted', JSON.stringify({ siReference: siRef }));
    const [fresh] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [si.id]);
    ok(res, { sent, shippingInstructions: mapShippingInstructions(fresh) }, 201);
  });

  // Test Tools simulator — mirrors customs-filing.js's simulate-response route exactly.
  app.post("/api/shipments/:id/shipping-instructions/simulate-response", write, async (req, res) => {
    const [si] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    if (!si) return err(res, "Shipping Instructions not found", 404);
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    const { outcome, reason } = req.body || {};
    if (outcome !== "confirmed" && outcome !== "rejected") return err(res, 'outcome must be "confirmed" or "rejected"');
    if (si.status !== "Submitted") return err(res, "This Shipping Instructions record has no pending submission to respond to", 409);
    const now = new Date().toISOString();
    if (outcome === "confirmed") {
      await query(`UPDATE shipping_instructions SET status='Confirmed', responded_at=$1, updated_at=$2 WHERE id=$3`, [now, now, si.id]);
      await insertMessage(req.params.id, si.id, "in", "shipping_instructions_confirmation", "confirmed",
        { note: "Simulated via Test Tools → Filing Simulator." }, true);
      await logEntityEvent('shipping_instructions', si.id, 'CONFIRMED', null, 'Submitted', 'Confirmed', null);
    } else {
      const rejReason = reason?.trim() || "Shipping Instructions rejected — data did not match the booking.";
      await query(`UPDATE shipping_instructions SET status='Rejected', rejection_reason=$1, responded_at=$2, updated_at=$3 WHERE id=$4`,
        [rejReason, now, now, si.id]);
      await insertMessage(req.params.id, si.id, "in", "shipping_instructions_rejection", "rejected",
        { reason: rejReason, note: "Simulated via Test Tools → Filing Simulator." }, true);
      await logEntityEvent('shipping_instructions', si.id, 'REJECTED', null, 'Submitted', 'Rejected', JSON.stringify({ reason: rejReason }));
    }
    const [fresh] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [si.id]);
    ok(res, mapShippingInstructions(fresh), 201);
  });

  // Allows correction + resubmission after a rejection — next Submit generates a genuinely
  // new si_reference rather than reusing the rejected one.
  app.patch("/api/shipments/:id/shipping-instructions/reset", write, async (req, res) => {
    const [si] = await query("SELECT * FROM shipping_instructions WHERE shipment_id=$1", [req.params.id]);
    if (!si) return err(res, "Shipping Instructions not found", 404);
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [req.params.id]);
    if (await blockIfWrongSide(req, res, shipment, 'export')) return;
    if (si.status !== "Rejected") return err(res, "Only a Rejected Shipping Instructions record can be reset to Draft", 409);
    const now = new Date().toISOString();
    await query(`UPDATE shipping_instructions SET status='Draft', si_reference='', rejection_reason='', updated_at=$1 WHERE id=$2`, [now, si.id]);
    await logEntityEvent('shipping_instructions', si.id, 'RESET', null, 'Rejected', 'Draft', null);
    const [fresh] = await query("SELECT * FROM shipping_instructions WHERE id=$1", [si.id]);
    ok(res, mapShippingInstructions(fresh));
  });

  // Cross-shipment list for the Test Tools Filing Simulator picker — mirrors GET /api/customs-filings.
  app.get("/api/shipping-instructions", auth(), async (req, res) => {
    const { status } = req.query;
    const rows = status
      ? await query("SELECT * FROM shipping_instructions WHERE status=$1 ORDER BY updated_at DESC", [status])
      : await query("SELECT * FROM shipping_instructions ORDER BY updated_at DESC");
    if (rows.length === 0) return ok(res, []);
    const shipmentIds = [...new Set(rows.map(r => r.shipment_id))];
    const ph = shipmentIds.map((_, i) => `$${i + 1}`).join(",");
    const shipmentRows = await query(`SELECT * FROM shipments WHERE id IN (${ph})`, shipmentIds);
    const allowedShipments = await applyShipmentAccessFilter(shipmentRows.map(mapShipment), req.user, req);
    const shipmentById = new Map(allowedShipments.map(s => [s.id, s]));
    ok(res, rows.filter(r => shipmentById.has(r.shipment_id))
      .map(r => ({ ...mapShippingInstructions(r), shipment: shipmentById.get(r.shipment_id) })));
  });
};
