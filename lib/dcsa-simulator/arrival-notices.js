"use strict";
// The demo carrier's Arrival Notices (DCSA Arrival Notice 1.0) and Port Call timestamps (Port Call 2.0),
// DCSA-everywhere phase 8, 2026-10-28. State in dcsa_sim_arrival_notices.
//
// Test Tools makes the carrier publish an arrival notice for a B/L it issued: a new version each time, pushed
// to CargoDesk (POST …/arrival-notices), or announced by a lightweight notification (POST
// …/arrival-notice-notifications) that CargoDesk follows with GET /arrival-notices. It also reports a vessel's
// berth arrival or departure as a Port Call event (POST …/port-call/events). Both signed like its other pushes.

const { validateOutbound, validateOutboundSchema, errorsText } = require("../dcsa/validate");

const SHORT = { ACTUAL: "ACT", ESTIMATED: "EST", PLANNED: "PLN" };
// Port Call ids are UUIDs: a name-based one (v5 layout over SHA-1), so the same call, kind and classifier
// always get the same id and a later estimate replaces the earlier one.
const uuidOf = name => {
  const h = require("crypto").createHash("sha1").update(String(name)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const plusDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

module.exports = function createSimArrivalNotices({ query, uid, deliver }) {
  /**
   * @param {object} o { carrierCode, tdRef, houseRefs, pol, pod, vessel: { imo, name }, voyage, eta (YYYY-MM-DD),
   *   classifier (ESTIMATED | ACTUAL), containers: [{ number, iso, seals }], freeDays (DEM), detentionDays (DET),
   *   charges: [{ name, code, amount, currency, basis, quantity, unitPrice }], released: { freight, obl, customs },
   *   lightweight (announce, don't push) }
   * → { ok, arrivalNotice, delivery } | { ok:false, status, error }
   */
  async function publish(o) {
    if (!o.tdRef) return { ok: false, status: 409, error: "The carrier has issued no B/L for this shipment yet" };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.eta || "")) return { ok: false, status: 400, error: "eta must be a date (YYYY-MM-DD)" };
    const [{ n }] = await query("SELECT COALESCE(MAX(version), 0) + 1 AS n FROM dcsa_sim_arrival_notices WHERE td_ref=$1", [o.tdRef]);
    const containers = (o.containers || []).filter(c => c.number);
    const numbers = containers.map(c => c.number);
    const dem = Number.isInteger(o.freeDays) ? o.freeDays : 4, det = Number.isInteger(o.detentionDays) ? o.detentionDays : 7;
    const cur = "USD", per = containers.length || 1;
    const charges = o.charges || [
      { name: "Terminal handling, destination", code: "DTHC", amount: 495 * per, currency: cur, basis: "PER_CONTAINER", quantity: per, unitPrice: 495 },
      { name: "Delivery order fee", code: "DOC", amount: 85, currency: cur, basis: "PER_BL", quantity: 1, unitPrice: 85 },
      { name: "Carrier security fee", code: "ISPS", amount: 15 * per, currency: cur, basis: "PER_CONTAINER", quantity: per, unitPrice: 15 },
    ];
    const released = o.released || {};
    const issueDateTime = new Date().toISOString();
    const an = {
      issueDateTime, typeLabel: "Arrival Notice", versionLabel: String(n),
      carrierCode: String(o.carrierCode || "DEMO").slice(0, 4), carrierCodeListProvider: "NMFTA",
      carrierContactInformation: [{ name: "Import customer service", email: "import@demo-carrier.example", phone: "+1 201 555 0170" }],
      pickupInformation: { pickupNumber: `${String(o.voyage || "PU").slice(0, 8)}-${String(Date.now()).slice(-4)}`,
        pickupLocation: { locationName: `Container terminal ${o.pod}`, UNLocationCode: o.pod } },
      returnInformation: { turnInReference: `TI-${String(Date.now()).slice(-5)}`, returnLocation: { locationName: `Empty depot ${o.pod}`, UNLocationCode: o.pod },
        returnInstructions: "Return the empty container clean, with all lashings removed." },
      releaseInformation: { isFreightReleased: released.freight !== false, isOBLReceived: !!released.obl, isCustomsReleased: !!released.customs },
      customsClearance: { manifestReferenceNumber: `${o.pod}-${String(Date.now()).slice(-6)}` },
      ...(o.houseRefs?.length ? { houseBillOfLadingReferences: o.houseRefs } : {}),
      transportDocumentReference: o.tdRef,
      transport: {
        portOfLoading: { UNLocationCode: o.pol }, portOfDischarge: { UNLocationCode: o.pod },
        portOfDischargeArrivalDate: { value: o.eta, classifier: SHORT[String(o.classifier || "ESTIMATED").toUpperCase()] || "EST" },
        legs: [{ transportPlanStage: "MNC", transportPlanStageSequenceNumber: 1, modeOfTransport: "VESSEL",
          loadLocation: { UNLocationCode: o.pol }, dischargeLocation: { UNLocationCode: o.pod },
          vesselVoyage: { ...(o.vessel?.name ? { vesselName: o.vessel.name } : {}), ...(o.vessel?.imo ? { vesselIMONumber: String(o.vessel.imo) } : {}),
            ...(o.voyage ? { carrierImportVoyageNumber: o.voyage } : {}) } }],
      },
      freeTimes: numbers.length ? [
        { typeCodes: ["DEM"], equipmentReferences: numbers, duration: dem, timeUnit: "CD", lastFreeDate: { value: plusDays(o.eta, dem), classifier: "EST" } },
        { typeCodes: ["DET"], equipmentReferences: numbers, duration: det, timeUnit: "CD", lastFreeDate: { value: plusDays(o.eta, det), classifier: "EST" } },
      ] : [],
      charges: charges.map(c => ({ chargeName: String(c.name).slice(0, 50), currencyAmount: Number(c.amount), currencyCode: c.currency || cur, paymentTermCode: "COL",
        ...(c.basis ? { calculationBasis: c.basis } : {}), ...(c.unitPrice != null ? { unitPrice: Number(c.unitPrice) } : {}),
        ...(c.quantity != null ? { quantity: Number(c.quantity) } : {}), ...(c.code ? { chargeCode: c.code } : {}) })),
      freightPaymentStatus: "ZERO_PAID",
      utilizedTransportEquipments: containers.map(c => ({ equipment: { equipmentReference: c.number, ...(c.iso ? { ISOEquipmentCode: c.iso } : {}) },
        isShipperOwned: false, ...(c.seals?.length ? { seals: c.seals } : {}) })),
    };
    const check = validateOutboundSchema("an", "ArrivalNotice", an);
    if (!check.ok) return { ok: false, status: 500, error: `The demo carrier built an invalid Arrival Notice: ${errorsText(check.errors, 4)}` };
    await query(`INSERT INTO dcsa_sim_arrival_notices (id, td_ref, carrier_code, version, an_json, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [`SAN-${uid()}${uid()}`, o.tdRef, o.carrierCode || "", n, JSON.stringify(an), issueDateTime]);
    let body, path;
    if (o.lightweight) {
      body = { arrivalNoticeNotifications: [{ issueDateTime, typeLabel: an.typeLabel, versionLabel: an.versionLabel, transportDocumentReference: o.tdRef,
        ...(numbers.length ? { equipmentReferences: numbers } : {}), portOfDischarge: an.transport.portOfDischarge,
        portOfDischargeArrivalDate: an.transport.portOfDischargeArrivalDate }] };
      path = "/arrival-notice-notifications";
    } else { body = { arrivalNotices: [an] }; path = "/arrival-notices"; }
    const v = validateOutbound("an", "post", path, body);
    if (!v.ok) throw new Error(`The demo carrier built an invalid POST ${path}: ${errorsText(v.errors, 4)}`);
    return { ok: true, arrivalNotice: an, delivery: await deliver(body, { path, retries: [250, 1000] }) };
  }

  /**
   * A vessel's berth arrival or departure as a Port Call 2.0 event.
   * @param {object} o { vesselImo, vesselName, voyage, unLocationCode, kind: ARRI | DEPA, classifier: ACTUAL | ESTIMATED | PLANNED, dateTime }
   */
  async function reportPortCall(o) {
    const kind = String(o.kind || "").toUpperCase(), classifier = SHORT[String(o.classifier || "ESTIMATED").toUpperCase()];
    if (!["ARRI", "DEPA"].includes(kind)) return { ok: false, status: 400, error: "kind must be ARRI (arrived) or DEPA (departed)" };
    if (!classifier) return { ok: false, status: 400, error: "classifier must be ACTUAL, ESTIMATED or PLANNED" };
    if (!o.vesselImo || !o.voyage || !o.unLocationCode || !o.dateTime) return { ok: false, status: 400, error: "vesselImo, voyage, unLocationCode and dateTime are needed" };
    const clean = s => String(s || "").replace(/[^A-Za-z0-9]/g, "");
    const callId = `${clean(o.vesselImo)}-${clean(o.voyage)}-${clean(o.unLocationCode)}`;
    const ev = {
      // One event per call, kind and classifier: a later estimate replaces the earlier one.
      eventID: uuidOf(`${callId}-${kind}-${classifier}`), eventUpdatedDateTime: new Date().toISOString(),
      portCall: { portCallID: uuidOf(callId), UNLocationCode: o.unLocationCode },
      terminalCall: { terminalCallID: uuidOf(`${callId}-T1`), importVoyageNumberOrReference: { carrierVoyageNumber: o.voyage },
        exportVoyageNumberOrReference: { carrierVoyageNumber: o.voyage } },
      portCallService: { portCallServiceID: uuidOf(`${callId}-BERTH`), portCallServiceTypeCode: "BERTH", portCallServiceEventTypeCode: kind, facilityTypeCode: "BRTH" },
      vessel: { vesselIMONumber: String(o.vesselImo), ...(o.vesselName ? { vesselName: o.vesselName } : {}) },
      timestamp: { classifierCode: classifier, serviceDateTime: o.dateTime },
    };
    const body = { events: [ev] };
    const v = validateOutbound("portCall", "post", "/events", body);
    if (!v.ok) return { ok: false, status: 500, error: `The demo carrier built an invalid Port Call event: ${errorsText(v.errors, 4)}` };
    return { ok: true, event: ev, delivery: await deliver(body, { path: "/port-call/events", retries: [250, 1000] }) };
  }

  // GET /arrival-notices (AN 1.0, publisher): by transport document reference(s), the latest version of each.
  function registerRoutes(app) {
    app.get("/dcsa-sim/arrival-notices", async (req, res) => {
      const refs = String(req.query.transportDocumentReferences || "").split(",").map(s => s.trim()).filter(Boolean);
      if (!refs.length) return res.status(400).json({ feedbackElements: [{ severity: "ERROR", message: "Give transportDocumentReferences" }] });
      const rows = await query(`SELECT DISTINCT ON (td_ref) an_json FROM dcsa_sim_arrival_notices WHERE td_ref IN (${refs.map((_, i) => `$${i + 1}`).join(",")})
        ORDER BY td_ref, version DESC`, refs);
      const notices = rows.map(r => JSON.parse(r.an_json));
      res.json({ arrivalNotices: String(req.query.removeCharges) === "true" ? notices.map(({ charges, ...rest }) => rest) : notices });
    });
  }

  async function list({ tdRef = "" } = {}) {
    const rows = tdRef ? await query("SELECT * FROM dcsa_sim_arrival_notices WHERE td_ref=$1 ORDER BY version DESC", [tdRef])
      : await query("SELECT * FROM dcsa_sim_arrival_notices ORDER BY created_at DESC LIMIT 100");
    return rows.map(r => ({ transportDocumentReference: r.td_ref, version: r.version, carrierCode: r.carrier_code, createdAt: r.created_at, arrivalNotice: JSON.parse(r.an_json) }));
  }

  return { publish, reportPortCall, registerRoutes, list };
};
