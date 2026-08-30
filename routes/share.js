"use strict";

const { signToken, verifyToken } = require("../lib/shareToken");

module.exports = function shareRoutes(app, ctx) {
  const { query, ok, err, auth, JWT_SECRET, mapShipmentLeg, UPLOADS_DIR, fs, path } = ctx;

  const SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  // Generate a shareable token for a shipment (auth required)
  app.post("/api/shipments/:id/share-token", auth(), async (req, res) => {
    const [shipment] = await query("SELECT id, status FROM shipments WHERE id=$1", [req.params.id]);
    if (!shipment) return err(res, "Shipment not found", 404);
    const payload = { shipmentId: shipment.id, exp: Date.now() + SHARE_TTL_MS };
    const token = signToken(payload, JWT_SECRET);
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    ok(res, { token, url: `${baseUrl}/#track/${token}`, expiresAt: new Date(payload.exp).toISOString() });
  });

  // Public tracking endpoint — no auth required
  app.get("/api/share/:token", async (req, res) => {
    const payload = verifyToken(req.params.token, JWT_SECRET);
    if (!payload) return err(res, "Invalid or tampered link", 400);
    if (Date.now() > payload.exp) return err(res, "This tracking link has expired", 410);

    const [ship] = await query(`
      SELECT s.*,
        po.name AS pol_name, pd.name AS pod_name
      FROM shipments s
      LEFT JOIN port_locations po ON po.unlocode = s.pol
      LEFT JOIN port_locations pd ON pd.unlocode = s.pod
      WHERE s.id = $1
    `, [payload.shipmentId]);
    if (!ship) return err(res, "Shipment not found", 404);

    const legs = await query("SELECT * FROM shipment_legs WHERE shipment_id=$1 ORDER BY leg_order ASC", [ship.id]);
    const containers = await query(
      "SELECT size, type, container_number AS \"containerNumber\", gross_weight_kg AS \"grossWeightKg\" FROM containers WHERE shipment_id=$1", [ship.id]
    );
    const milestones = await query(
      "SELECT milestone_key, label, sequence_order, completed_at, estimated_date FROM shipment_milestones WHERE shipment_id=$1 ORDER BY sequence_order ASC", [ship.id]
    );
    // Structural dual carrier/shipper identity (TKT-9O2B3T, NVOCC epic TKT-Q52B38) — a customer
    // whose shipment moves through an NVOCC contracted with the NVOCC, not the underlying vessel
    // operator, so the public tracking page's "Carrier" should read as the NVOCC when one is
    // assigned (same identity already used for the House B/L and the booking-request shipper
    // field) — carrierCode is kept alongside, unchanged, as the real operational vessel operator.
    const [nvoccParty] = await query("SELECT customer_name FROM shipment_parties WHERE shipment_id=$1 AND role='NVOCC'", [ship.id]);

    ok(res, {
      id: ship.id,
      status: ship.status,
      pol: ship.pol, polName: ship.pol_name || '',
      pod: ship.pod, podName: ship.pod_name || '',
      carrierCode: ship.carrier_code || '',
      nvoccName: nvoccParty?.customer_name || '',
      vessel: ship.vessel || '',
      voyage: ship.voyage || '',
      etd: ship.etd || null,
      eta: ship.eta || null,
      bookingRef: ship.booking_ref || '',
      blNumber: ship.bl_number || '',
      incoterm: ship.incoterm || '',
      movementType: ship.movement_type || 'FCL',
      serviceType: ship.service_type || 'Port-to-Port',
      routingTerm: ship.routing_term || 'P2P',
      shipperName: ship.shipper_name || '',
      consigneeName: ship.consignee_name || '',
      cargoReadyDate: ship.cargo_ready_date || null,
      // A classified-location leg's exact lat/lng is stripped here — this is an unauthenticated,
      // token-only endpoint (anyone holding the link, forwarded or not, can reach it), unlike the
      // authenticated app where an ops user genuinely needs the real coordinates. polLocType/
      // podLocType are kept so the public tracking page can still show a "Classified location"
      // label instead of a blank, via the same formatLegPoint helper used everywhere else.
      legs: legs.map(mapShipmentLeg).map(({ polLatitude, polLongitude, podLatitude, podLongitude, ...leg }) => leg),
      containers,
      milestones,
      expiresAt: new Date(payload.exp).toISOString(),
    });
  });

  // Document-scoped share link — minted internally by the webhook distribution proxy
  // (routes/document-distribution.js), never exposed as its own "generate a link" UI action the
  // way the shipment-level tracking link is. The distribution service itself never touches file
  // bytes; this is the one place a partner's webhook receiver can actually fetch the document,
  // using the same signed-token mechanism as the tracking link above.
  app.get("/api/share/document/:token", async (req, res) => {
    const payload = verifyToken(req.params.token, JWT_SECRET);
    if (!payload || !payload.docId) return err(res, "Invalid or tampered link", 400);
    if (Date.now() > payload.exp) return err(res, "This document link has expired", 410);
    const [doc] = await query("SELECT * FROM shipment_documents WHERE id=$1 AND shipment_id=$2", [payload.docId, payload.shipmentId]);
    if (!doc) return err(res, "Document not found", 404);
    const filePath = path.join(UPLOADS_DIR, doc.stored_name);
    if (!fs.existsSync(filePath)) return err(res, "File not found on disk", 404);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.filename}"`);
    res.setHeader("Content-Type", doc.mime_type || "application/octet-stream");
    fs.createReadStream(filePath).pipe(res);
  });
};
