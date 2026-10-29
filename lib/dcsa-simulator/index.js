"use strict";

// Built-in DCSA carrier simulator (DCSA-everywhere program, phase 1; Epic TKT-G2J60Z).
//
// The carrier side of the DCSA standards, served by CargoDesk itself under /dcsa-sim, for every carrier
// that has no real DCSA integration. CargoDesk talks to it through the same adapters, HTTP calls,
// validation and webhook receiver as a real carrier, so a booking made against the simulator exercises
// the whole production path. Phase 1 implements Booking 2.0; each later phase adds its standard:
// Shipping Instructions 3.0 and VGM 1.0 since 2026-10-27 (state in dcsa_sim_shipping_instructions,
// dcsa_sim_vgm_declarations); the Master transport document, Track & Trace 3.0 and Operational Vessel
// Schedules 3.0 since 2026-10-28 (transport-documents.js, track-trace.js, vessel-schedules.js).
//
// Where it runs (decided by the user, 2026-10-11): always outside production; in production only when
// an admin turns on App Settings → "Demo carrier" (dcsa_demo_carrier_enabled). Everything it touches is
// flagged (carrier_bookings.is_mock) and shown as DEMO CARRIER.
//
// Carrier-side state lives in dcsa_sim_bookings. The carrier's decisions (confirm, reject, ask for an
// update, confirm a cancellation…) are taken from Test Tools through act(); each one sends a signed
// DCSA notification to /api/carrier-webhooks/dcsa-simulator, as a real carrier would.

const crypto = require("crypto");
const { validateRequest, validateOutbound, errorsText } = require("../dcsa/validate");

const INTEGRATION_ID = "dcsa-simulator";
// "spot-rates": the demo spot desk (spot-desk.js, SPOT rates phase 2) — not DCSA, its own adapter.
// "tracking" (Track & Trace 3.0, track-trace.js) and "vessel-schedules" (OVS 3.0, vessel-schedules.js) since
// 2026-10-28; the sweeps still only call carriers with integrations of their own (the demo carrier answers
// "Sync carrier events" / "Check vessel times" and pushes what Test Tools makes it report).
// "arrival-notice" (Arrival Notice 1.0) and "port-call" (Port Call 2.0, pushed only) since 2026-10-28 (phase 8,
// arrival-notices.js).
const CAPABILITIES = new Set(["booking", "shipping-instructions", "vgm", "tracking", "vessel-schedules", "arrival-notice", "port-call", "spot-rates"]);
const ADAPTER_FOR = { "spot-rates": "demo-spot-v1" };
const createSpotDesk = require("./spot-desk");
const createTransportDocuments = require("./transport-documents");
const createSimTrackTrace = require("./track-trace");
const createSimVesselSchedules = require("./vessel-schedules");
const createSimArrivalNotices = require("./arrival-notices");
// Booking states (lib/dcsa/codes.js BOOKING_STATUS) the consumer may still change with a PUT/PATCH.
const OPEN = ["RECEIVED", "PENDING_UPDATE", "UPDATE_RECEIVED"];
const LIVE = ["CONFIRMED", "PENDING_AMENDMENT"];

// expectedArrival(requestRef) → the ETA CargoDesk sent the request for ('' when none). A real carrier
// plans the arrival from its own schedule; the demo carrier has none, so it confirms the arrival it was
// expected to (a DCSA booking request carries no arrival date of its own).
module.exports = function createDcsaSimulator({ query, uid, getSettings, port, expectedArrival = async () => "", sailingsFor = async () => [] }) {
  const spotDesk = createSpotDesk({ query, uid, sailingsFor });
  // Shared only between the simulator and the receiver in this process; a restart only invalidates a
  // notification still being retried, which the next poll (routes/edi.js) picks up anyway.
  const webhookSecret = crypto.randomBytes(32).toString("hex");
  // CargoDesk's credential at the demo carrier (release audit R2, 2026-10-29): made per process, like the built-in
  // eBL platform's, and required on every /dcsa-sim call — the demo carrier's API sits outside the /api login guard.
  const accessToken = crypto.randomBytes(24).toString("hex");
  const baseUrl = () => `http://127.0.0.1:${port()}/dcsa-sim`;

  async function allowed() {
    if (process.env.NODE_ENV !== "production") return true;
    return (await getSettings()).dcsa_demo_carrier_enabled === "true";
  }

  // The shape carrierIntegrationFor (server.js) returns for a real carrier_integrations row.
  function integration(carrierCode, capability) {
    if (!CAPABILITIES.has(capability)) return null;
    const row = { id: INTEGRATION_ID, carrier_code: carrierCode, adapter_key: ADAPTER_FOR[capability] || "dcsa-bkg-v2", is_active: true,
      is_simulator: true, capabilities: JSON.stringify([...CAPABILITIES]), base_url: baseUrl(),
      auth_header_name: "Authorization", credential: `Bearer ${accessToken}`, webhook_secret: webhookSecret };
    return { row, config: { baseUrl: row.base_url, authHeaderName: row.auth_header_name, credential: row.credential, webhookSecret } };
  }

  // ─── Carrier-side records ────────────────────────────────────────────────────
  const load = async ref => (await query(
    "SELECT * FROM dcsa_sim_bookings WHERE request_ref=$1 OR (carrier_booking_ref <> '' AND carrier_booking_ref=$1)", [ref]))[0] || null;

  function toBooking(b) {
    let request = {}, feedbacks = [], confirmed = {};
    try { request = JSON.parse(b.request_json || "{}"); } catch { /* stored by us; never malformed */ }
    try { feedbacks = JSON.parse(b.feedbacks_json || "[]"); } catch { feedbacks = []; }
    try { confirmed = b.confirmed_json ? JSON.parse(b.confirmed_json) : {}; } catch { confirmed = {}; }
    return {
      ...request,
      ...confirmed,
      carrierBookingRequestReference: b.request_ref,
      ...(b.carrier_booking_ref ? { carrierBookingReference: b.carrier_booking_ref } : {}),
      bookingStatus: b.booking_status,
      ...(b.amended_booking_status ? { amendedBookingStatus: b.amended_booking_status } : {}),
      ...(b.booking_cancellation_status ? { bookingCancellationStatus: b.booking_cancellation_status } : {}),
      ...(feedbacks.length ? { feedbacks } : {}),
    };
  }

  async function save(b, changes, feedback) {
    const next = { ...b, ...changes };
    let feedbacks = [];
    try { feedbacks = JSON.parse(b.feedbacks_json || "[]"); } catch { feedbacks = []; }
    if (feedback) feedbacks = [feedback]; // DCSA feedbacks describe the latest state change
    else if (changes.booking_status && changes.booking_status !== b.booking_status) feedbacks = [];
    next.feedbacks_json = JSON.stringify(feedbacks);
    next.updated_at = new Date().toISOString();
    await query(`UPDATE dcsa_sim_bookings SET carrier_booking_ref=$1, booking_status=$2, amended_booking_status=$3,
      booking_cancellation_status=$4, request_json=$5, feedbacks_json=$6, updated_at=$7, confirmed_json=$9 WHERE request_ref=$8`,
      [next.carrier_booking_ref || "", next.booking_status, next.amended_booking_status || "", next.booking_cancellation_status || "",
       next.request_json, next.feedbacks_json, next.updated_at, b.request_ref, next.confirmed_json || ""]);
    return next;
  }

  // ─── Notifications (BKG 2.0 BookingNotification, a CloudEvent) ──────────────
  function notificationFor(b) {
    const booking = toBooking(b);
    const data = { bookingStatus: booking.bookingStatus, carrierBookingRequestReference: booking.carrierBookingRequestReference };
    for (const k of ["carrierBookingReference", "amendedBookingStatus", "bookingCancellationStatus", "feedbacks"]) if (booking[k]) data[k] = booking[k];
    return {
      specversion: "1.0", id: crypto.randomUUID(), source: baseUrl(), type: "org.dcsa.booking.v2",
      time: new Date().toISOString(), datacontenttype: "application/json", subscriptionReference: "cargodesk-dcsa-simulator", data,
    };
  }

  // Delivered after the HTTP answer that caused it, the way a carrier's notification arrives after
  // its 202 — and retried, because CargoDesk only stores the request reference once that 202 is back.
  async function notify(b, { retries = [250, 1000, 3000] } = {}) {
    const event = notificationFor(b);
    const v = validateOutbound("bkg", "post", "/v2/booking-notifications", event);
    if (!v.ok) throw new Error(`DCSA simulator built an invalid notification: ${errorsText(v.errors)}`);
    const body = JSON.stringify(event);
    const signature = "sha256=" + crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
    let last = null;
    for (let attempt = 0; attempt <= retries.length; attempt++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port()}/api/carrier-webhooks/${INTEGRATION_ID}`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-DCSA-Signature": signature }, body,
        });
        last = { status: r.status, body: await r.json().catch(() => null) };
        if (r.status < 400 || (r.status >= 400 && r.status < 500 && r.status !== 404)) return { delivered: r.status < 400, ...last };
      } catch (e) { last = { status: 0, error: e.message }; }
      if (attempt < retries.length) await new Promise(res => setTimeout(res, retries[attempt]));
    }
    return { delivered: false, ...last };
  }
  const notifyLater = b => setTimeout(() => notify(b).catch(e => console.error("DCSA simulator:", e.message)), 50);

  // ─── Shipping Instructions 3.0: carrier-side records and notifications ───────
  const loadSi = async ref => (await query("SELECT * FROM dcsa_sim_shipping_instructions WHERE si_ref=$1", [ref]))[0] || null;
  const siState = (si, tdRef = "") => {
    let feedbacks = [];
    try { feedbacks = JSON.parse(si.feedbacks_json || "[]"); } catch { feedbacks = []; }
    return { shippingInstructionsStatus: si.status, shippingInstructionsReference: si.si_ref,
      ...(si.updated_status ? { updatedShippingInstructionsStatus: si.updated_status } : {}), ...(feedbacks.length ? { feedbacks } : {}),
      ...(tdRef ? { transportDocumentReference: tdRef } : {}) };
  };
  const tdRefOf = async siRef => (await query("SELECT td_ref FROM dcsa_sim_transport_documents WHERE si_ref=$1 AND status<>'VOIDED' ORDER BY created_at DESC LIMIT 1", [siRef]))[0]?.td_ref || "";
  async function saveSi(si, changes, feedback) {
    const next = { ...si, ...changes, feedbacks_json: JSON.stringify(feedback ? [feedback] : []), updated_at: new Date().toISOString() };
    await query(`UPDATE dcsa_sim_shipping_instructions SET status=$1, updated_status=$2, request_json=$3, feedbacks_json=$4, updated_at=$5,
      prev_request_json=$7 WHERE si_ref=$6`,
      [next.status, next.updated_status || "", next.request_json, next.feedbacks_json, next.updated_at, si.si_ref, next.prev_request_json || ""]);
    return next;
  }
  // Signs a message with the per-process secret and posts it to CargoDesk's carrier webhook (`path`
  // after it: "/events" for Track & Trace), retrying — CargoDesk only knows a reference once the 202
  // that carried it is back. A 4xx other than 404 is an answer, not a reason to retry.
  async function deliver(message, { retries = [250, 1000, 3000], path = "" } = {}) {
    const body = JSON.stringify(message);
    const signature = "sha256=" + crypto.createHmac("sha256", webhookSecret).update(body).digest("hex");
    let last = null;
    for (let attempt = 0; attempt <= retries.length; attempt++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port()}/api/carrier-webhooks/${INTEGRATION_ID}${path}`, {
          method: "POST", headers: { "Content-Type": "application/json", "X-DCSA-Signature": signature }, body,
        });
        last = { status: r.status, body: await r.json().catch(() => null) };
        if (r.status < 400 || (r.status < 500 && r.status !== 404)) return { delivered: r.status < 400, ...last };
      } catch (e) { last = { status: 0, error: e.message }; }
      if (attempt < retries.length) await new Promise(res => setTimeout(res, retries[attempt]));
    }
    return { delivered: false, ...last };
  }

  // POST /v3/shipping-instructions-notifications on CargoDesk's webhook: a CloudEvent, checked against the spec first.
  async function notifySi(si, { retries = [250, 1000, 3000] } = {}) {
    const event = { specversion: "1.0", id: crypto.randomUUID(), source: baseUrl(), type: "org.dcsa.shipping-instructions.v3",
      time: new Date().toISOString(), datacontenttype: "application/json", subscriptionReference: "cargodesk-dcsa-simulator", data: siState(si, await tdRefOf(si.si_ref)) };
    const v = validateOutbound("ebl", "post", "/v3/shipping-instructions-notifications", event);
    if (!v.ok) throw new Error(`DCSA simulator built an invalid Shipping Instructions notification: ${errorsText(v.errors)}`);
    return deliver(event, { retries });
  }
  const notifySiLater = si => setTimeout(() => notifySi(si).catch(e => console.error("DCSA simulator:", e.message)), 50);

  // The booking the carrier confirmed, by its booking number: the request with the confirmation over it.
  const loadBookingByCarrierRef = async ref => {
    const [b] = await query("SELECT * FROM dcsa_sim_bookings WHERE carrier_booking_ref=$1", [ref]);
    return b ? toBooking(b) : null;
  };
  const transportDocuments = createTransportDocuments({ query, uid, baseUrl, deliver, loadSi, saveSi, notifySi, loadBookingByCarrierRef });
  const trackTrace = createSimTrackTrace({ query, deliver });
  const vesselSchedules = createSimVesselSchedules({ query, uid });
  const arrivalNotices = createSimArrivalNotices({ query, uid, deliver });

  // ─── HTTP: the carrier's Booking 2.0 API ────────────────────────────────────
  const errorBody = (req, statusCode, statusCodeText, statusCodeMessage, errors) => ({
    httpMethod: req.method, requestUri: req.originalUrl, statusCode, statusCodeText, statusCodeMessage,
    errorDateTime: new Date().toISOString(),
    errors: errors.length ? errors : [{ errorCodeText: statusCodeText, errorCodeMessage: statusCodeMessage }],
  });
  const fail = (req, res, status, text, message, errors = []) => res.status(status).json(errorBody(req, status, text, message, errors));
  const invalid = (req, res, v) => fail(req, res, 400, "Bad Request", "The request does not match DCSA Booking 2.0",
    v.errors.slice(0, 20).map(e => ({ errorCodeText: "invalidInput", errorCodeMessage: `${e.path} ${e.message}`, jsonPath: "$" + e.path.replace(/\//g, ".") })));

  function registerRoutes(app) {
    app.use("/dcsa-sim", async (req, res, next) => {
      if (!(await allowed())) return res.status(404).json({ error: "Not found" });
      const got = Buffer.from(String(req.headers.authorization || "")), want = Buffer.from(`Bearer ${accessToken}`);
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).json({ error: "Unauthorized" });
      next();
    });
    spotDesk.registerRoutes(app);

    app.post("/dcsa-sim/v2/bookings", async (req, res) => {
      const v = validateRequest("bkg", "post", "/v2/bookings", req.body);
      if (!v.ok) return invalid(req, res, v);
      const now = new Date().toISOString();
      const b = { request_ref: `SIM-${uid()}${uid()}`, carrier_code: req.body.carrierCode || "", carrier_booking_ref: "",
        booking_status: "RECEIVED", amended_booking_status: "", booking_cancellation_status: "",
        request_json: JSON.stringify(req.body), feedbacks_json: "[]", created_at: now, updated_at: now };
      await query(`INSERT INTO dcsa_sim_bookings (request_ref, carrier_code, carrier_booking_ref, booking_status, amended_booking_status,
        booking_cancellation_status, request_json, feedbacks_json, created_at, updated_at) VALUES ($1,$2,'',$3,'','',$4,'[]',$5,$5)`,
        [b.request_ref, b.carrier_code, b.booking_status, b.request_json, now]);
      res.status(202).json({ carrierBookingRequestReference: b.request_ref });
      notifyLater(b);
    });

    app.get("/dcsa-sim/v2/bookings/:ref", async (req, res) => {
      const b = await load(req.params.ref);
      if (!b) return fail(req, res, 404, "Not Found", `No booking ${req.params.ref}`);
      res.json(toBooking(b));
    });

    // Update while open, amendment once confirmed (DCSA: the same PUT, the carrier tells them apart).
    app.put("/dcsa-sim/v2/bookings/:ref", async (req, res) => {
      const b = await load(req.params.ref);
      if (!b) return fail(req, res, 404, "Not Found", `No booking ${req.params.ref}`);
      const v = validateRequest("bkg", "put", "/v2/bookings/{bookingReference}", req.body);
      if (!v.ok) return invalid(req, res, v);
      let changes;
      if (OPEN.includes(b.booking_status)) changes = { booking_status: "UPDATE_RECEIVED" };
      else if (LIVE.includes(b.booking_status) && !b.booking_cancellation_status) changes = { amended_booking_status: "AMENDMENT_RECEIVED" };
      else return fail(req, res, 409, "Conflict", `A ${b.booking_status} booking can't be updated`);
      const next = await save(b, { ...changes, request_json: JSON.stringify(req.body) });
      res.status(202).json({ carrierBookingRequestReference: b.request_ref });
      notifyLater(next);
    });

    // CancelBookingRequest: withdraw an open booking, ask to cancel a confirmed one, or drop an amendment.
    app.patch("/dcsa-sim/v2/bookings/:ref", async (req, res) => {
      const b = await load(req.params.ref);
      if (!b) return fail(req, res, 404, "Not Found", `No booking ${req.params.ref}`);
      const v = validateRequest("bkg", "patch", "/v2/bookings/{bookingReference}", req.body);
      if (!v.ok) return invalid(req, res, v);
      const body = req.body || {};
      let changes = null;
      if (body.bookingStatus === "CANCELLED" && OPEN.includes(b.booking_status)) changes = { booking_status: "CANCELLED" };
      else if (body.bookingCancellationStatus === "CANCELLATION_RECEIVED" && LIVE.includes(b.booking_status) && !b.booking_cancellation_status)
        changes = { booking_cancellation_status: "CANCELLATION_RECEIVED" };
      else if (body.amendedBookingStatus === "AMENDMENT_CANCELLED" && b.amended_booking_status === "AMENDMENT_RECEIVED")
        changes = { amended_booking_status: "AMENDMENT_CANCELLED" };
      if (!changes) return fail(req, res, 409, "Conflict", `That cancellation doesn't apply to a ${b.booking_status} booking`);
      const next = await save(b, changes);
      res.status(202).json({ carrierBookingRequestReference: b.request_ref });
      notifyLater(next);
    });

    // ─── Shipping Instructions 3.0 ─────────────────────────────────────────────
    const invalidEbl = (req, res, v) => fail(req, res, 400, "Bad Request", "The request does not match DCSA Shipping Instructions 3.0",
      v.errors.slice(0, 20).map(e => ({ errorCodeText: "invalidInput", errorCodeMessage: `${e.path} ${e.message}`, jsonPath: "$" + e.path.replace(/\//g, ".") })));
    app.post("/dcsa-sim/v3/shipping-instructions", async (req, res) => {
      const v = validateRequest("ebl", "post", "/v3/shipping-instructions", req.body);
      if (!v.ok) return invalidEbl(req, res, v);
      const now = new Date().toISOString();
      const si = { si_ref: `SISIM-${uid()}${uid()}`, carrier_code: req.body.carrierCode || "", status: "RECEIVED", updated_status: "",
        request_json: JSON.stringify(req.body), feedbacks_json: "[]", created_at: now, updated_at: now };
      await query(`INSERT INTO dcsa_sim_shipping_instructions (si_ref, carrier_code, status, updated_status, request_json, feedbacks_json, created_at, updated_at)
        VALUES ($1,$2,$3,'',$4,'[]',$5,$5)`, [si.si_ref, si.carrier_code, si.status, si.request_json, now]);
      res.status(202).json({ shippingInstructionsReference: si.si_ref });
      notifySiLater(si);
    });
    app.get("/dcsa-sim/v3/shipping-instructions/:ref", async (req, res) => {
      const si = await loadSi(req.params.ref);
      if (!si) return fail(req, res, 404, "Not Found", `No Shipping Instructions ${req.params.ref}`);
      let request = {};
      try { request = JSON.parse(si.request_json || "{}"); } catch { request = {}; }
      const { shippingInstructionsReference, ...content } = request;
      res.json({ ...content, ...siState(si, await tdRefOf(si.si_ref)) });
    });
    // An update after the carrier asked for one (PENDING_UPDATE), or while it is still being processed.
    app.put("/dcsa-sim/v3/shipping-instructions/:ref", async (req, res) => {
      const si = await loadSi(req.params.ref);
      if (!si) return fail(req, res, 404, "Not Found", `No Shipping Instructions ${req.params.ref}`);
      const v = validateRequest("ebl", "put", "/v3/shipping-instructions/{documentReference}", req.body);
      if (!v.ok) return invalidEbl(req, res, v);
      if (!["RECEIVED", "PENDING_UPDATE"].includes(si.status)) return fail(req, res, 409, "Conflict", `Shipping Instructions that are ${si.status} can't be updated`);
      const td = await transportDocuments.forSi(si.si_ref);
      if (td && !["DRAFT", "APPROVED", "VOIDED"].includes(td.status))
        return fail(req, res, 409, "Conflict", `The transport document ${td.td_ref} is already ${td.status}: these Shipping Instructions can't be updated`);
      const next = await saveSi(si, { status: si.status === "PENDING_UPDATE" ? "PENDING_UPDATE" : "RECEIVED", updated_status: "UPDATE_RECEIVED",
        request_json: JSON.stringify(req.body), prev_request_json: si.request_json });
      res.status(202).end();
      notifySiLater(next);
    });
    // Cancel the instructions (not once the transport document is issued), or only the update the carrier
    // hasn't worked in yet — the instructions stand as they were before it.
    app.patch("/dcsa-sim/v3/shipping-instructions/:ref", async (req, res) => {
      const si = await loadSi(req.params.ref);
      if (!si) return fail(req, res, 404, "Not Found", `No Shipping Instructions ${req.params.ref}`);
      const v = validateRequest("ebl", "patch", "/v3/shipping-instructions/{documentReference}", req.body);
      if (!v.ok) return invalidEbl(req, res, v);
      const td = await transportDocuments.forSi(si.si_ref);
      let next;
      if (req.body.updatedShippingInstructionsStatus === "UPDATE_CANCELLED") {
        if (si.updated_status !== "UPDATE_RECEIVED") return fail(req, res, 409, "Conflict", "There is no update waiting to be cancelled");
        next = await saveSi(si, { updated_status: "UPDATE_CANCELLED", request_json: si.prev_request_json || si.request_json, prev_request_json: "" });
      } else {
        if (!["RECEIVED", "PENDING_UPDATE"].includes(si.status)) return fail(req, res, 409, "Conflict", `Shipping Instructions that are ${si.status} can't be cancelled`);
        if (td && !["DRAFT", "APPROVED", "VOIDED"].includes(td.status))
          return fail(req, res, 409, "Conflict", `The transport document ${td.td_ref} is already ${td.status}: these Shipping Instructions can't be cancelled`);
        next = await saveSi(si, { status: "CANCELLED", updated_status: "" });
        // The carrier's draft from them goes too.
        if (td && td.status !== "VOIDED") await transportDocuments.act(si.si_ref, "void", { message: "Shipping Instructions cancelled by the shipper" });
      }
      res.status(202).end();
      notifySiLater(next);
    });
    transportDocuments.registerRoutes(app, { fail });
    trackTrace.registerRoutes(app);
    vesselSchedules.registerRoutes(app);
    arrivalNotices.registerRoutes(app);

    // ─── VGM 1.0: the carrier as VGM Consumer ──────────────────────────────────
    app.post("/dcsa-sim/vgm-declarations", async (req, res) => {
      const v = validateRequest("vgm", "post", "/vgm-declarations", req.body);
      if (!v.ok) return res.status(400).json({ feedbackElements: v.errors.slice(0, 20).map(e => ({ severity: "ERROR", message: `${e.path} ${e.message}`, propertyPath: "$" + e.path.replace(/\//g, ".") })) });
      const now = new Date().toISOString();
      for (const d of req.body.VGMDeclarations || []) {
        if (!d.declarationReference) continue;
        await query(`INSERT INTO dcsa_sim_vgm_declarations (declaration_reference, carrier_code, equipment_reference, declaration_json, is_retracted, received_at)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (declaration_reference) DO UPDATE SET carrier_code=EXCLUDED.carrier_code,
          equipment_reference=CASE WHEN EXCLUDED.is_retracted THEN dcsa_sim_vgm_declarations.equipment_reference ELSE EXCLUDED.equipment_reference END,
          declaration_json=EXCLUDED.declaration_json, is_retracted=EXCLUDED.is_retracted, received_at=EXCLUDED.received_at`,
          [d.declarationReference, d.vesselVoyageDetails?.carrierCode || "", d.equipmentDetails?.equipmentReference || "", JSON.stringify(d), !!d.isRetracted, now]);
      }
      res.status(200).json({ feedbackElements: [] });
    });
  }

  // ─── The carrier's decisions (Test Tools) ───────────────────────────────────
  const feedbackOf = (message, code = "INFORMATIONAL_MESSAGE", severity = "INFO") =>
    message ? { severity, code, message: String(message).slice(0, 5000) } : null;

  // What a CONFIRMED booking carries on top of the request (BKG 2.0: confirmedEquipments, transportPlan
  // and shipmentCutOffTimes are mandatory and non-empty once confirmed): the requested equipment, one
  // main-carriage leg POL → POD on the requested vessel, voyage and departure date, and the usual
  // documentation / VGM / FCL cut-offs before departure. The arrival is the one CargoDesk expected
  // (expectedArrival), else 14 days after departure. With `changed`, the carrier confirms the next
  // week's sailing instead — another vessel and voyage, departing and arriving 7 days later — the way a
  // carrier rolls a booking it can't take as requested ("accepted with changes", Epic TKT-ASIYFL).
  const isoDay = (d, plus = 0) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + plus); return x.toISOString().slice(0, 10); };
  function confirmation(b, { changed = false, arrival = "", charges = [] } = {}) {
    let request = {};
    try { request = JSON.parse(b.request_json || "{}"); } catch { request = {}; }
    const where = code => (request.shipmentLocations || []).find(l => l.locationTypeCode === code)?.location;
    const requested = request.expectedDepartureDate || isoDay(new Date().toISOString().slice(0, 10), 7);
    const departure = changed ? isoDay(requested, 7) : requested;
    const expected = /^\d{4}-\d{2}-\d{2}$/.test(arrival) && arrival > requested ? arrival : isoDay(requested, 14);
    const vesselName = changed ? "DEMO SUBSTITUTE" : (request.vessel?.name || "DEMO VESSEL");
    const voyage = changed ? "DM777W" : (request.carrierExportVoyageNumber || "DM001W");
    const leg = {
      transportPlanStage: "MNC", transportPlanStageSequenceNumber: 1,
      loadLocation: where("POL") || { locationName: "Port of loading" },
      dischargeLocation: where("POD") || { locationName: "Port of discharge" },
      plannedDepartureDate: departure, plannedArrivalDate: changed ? isoDay(expected, 7) : expected,
      modeOfTransport: "VESSEL", vesselName,
      ...(!changed && request.vessel?.vesselIMONumber ? { vesselIMONumber: request.vessel.vesselIMONumber } : {}),
      carrierExportVoyageNumber: voyage,
    };
    const cutOff = (code, days) => ({ cutOffDateTimeCode: code, cutOffDateTime: `${isoDay(departure, -days)}T12:00:00Z` });
    return JSON.stringify({
      confirmedEquipments: (request.requestedEquipments || []).map(e => ({ ISOEquipmentCode: e.ISOEquipmentCode, units: e.units })),
      transportPlan: [leg],
      shipmentCutOffTimes: [cutOff("DCO", 3), cutOff("VCO", 2), cutOff("FCO", 1)],
      // A booking quoting one of the spot desk's offers is confirmed with that offer's charges.
      ...(charges.length ? { charges } : {}),
    });
  }
  const confirmRef = b => b.carrier_booking_ref || `${(b.carrier_code || "SIM").slice(0, 4)}${String(Date.now()).slice(-6)}${uid().slice(0, 3)}`;

  const ACTIONS = {
    confirm:             { when: b => ["RECEIVED", "UPDATE_RECEIVED"].includes(b.booking_status),
                           apply: (b, { arrival, charges }) => ({ booking_status: "CONFIRMED", carrier_booking_ref: confirmRef(b), confirmed_json: confirmation(b, { arrival, charges }) }) },
    confirmWithChanges:  { when: b => ["RECEIVED", "UPDATE_RECEIVED"].includes(b.booking_status),
                           apply: (b, { arrival, charges }) => ({ booking_status: "CONFIRMED", carrier_booking_ref: confirmRef(b), confirmed_json: confirmation(b, { changed: true, arrival, charges }) }),
                           severity: "WARN", code: "INFORMATIONAL_MESSAGE" },
    requestUpdate:       { when: b => ["RECEIVED", "UPDATE_RECEIVED"].includes(b.booking_status), apply: () => ({ booking_status: "PENDING_UPDATE" }), severity: "WARN", code: "PROPERTY_VALUE_MUST_CHANGE" },
    reject:              { when: b => OPEN.includes(b.booking_status), apply: () => ({ booking_status: "REJECTED" }), severity: "ERROR" },
    requestAmendment:    { when: b => b.booking_status === "CONFIRMED", apply: () => ({ booking_status: "PENDING_AMENDMENT" }), severity: "WARN", code: "PROPERTY_VALUE_MUST_CHANGE" },
    decline:             { when: b => LIVE.includes(b.booking_status), apply: () => ({ booking_status: "DECLINED" }), severity: "ERROR" },
    confirmAmendment:    { when: b => b.amended_booking_status === "AMENDMENT_RECEIVED", apply: (b, { arrival, charges }) => ({ amended_booking_status: "AMENDMENT_CONFIRMED", booking_status: "CONFIRMED", confirmed_json: confirmation(b, { arrival, charges }) }) },
    declineAmendment:    { when: b => b.amended_booking_status === "AMENDMENT_RECEIVED", apply: () => ({ amended_booking_status: "AMENDMENT_DECLINED" }), severity: "WARN" },
    confirmCancellation: { when: b => b.booking_cancellation_status === "CANCELLATION_RECEIVED", apply: () => ({ booking_cancellation_status: "CANCELLATION_CONFIRMED" }) },
    declineCancellation: { when: b => b.booking_cancellation_status === "CANCELLATION_RECEIVED", apply: () => ({ booking_cancellation_status: "CANCELLATION_DECLINED" }), severity: "WARN" },
  };

  // Applies a carrier decision and waits for CargoDesk to receive it, so Test Tools and tests see the
  // result straight away. → { ok, booking, delivery } or { ok:false, status, error }.
  async function act(ref, action, { message = "" } = {}) {
    const spec = ACTIONS[action];
    if (!spec) return { ok: false, status: 400, error: `Unknown carrier action "${action}" (${Object.keys(ACTIONS).join(", ")})` };
    const b = await load(ref);
    if (!b) return { ok: false, status: 404, error: `The simulator has no booking ${ref}` };
    if (!spec.when(b)) return { ok: false, status: 409, error: `Can't ${action} a booking that is ${[b.booking_status, b.amended_booking_status, b.booking_cancellation_status].filter(Boolean).join(" / ")}` };
    const arrival = await expectedArrival(b.request_ref).catch(() => "");
    const charges = await spotDesk.chargesForRequest(b.request_json).catch(() => []);
    const next = await save(b, spec.apply(b, { arrival: arrival || "", charges }), feedbackOf(message, spec.code, spec.severity));
    const delivery = await notify(next, { retries: [250, 1000] });
    return { ok: true, booking: toBooking(next), delivery };
  }

  const availableActions = b => Object.entries(ACTIONS).filter(([, s]) => s.when(b)).map(([k]) => k);
  async function list({ refs = null } = {}) {
    if (refs && !refs.length) return [];
    const rows = refs
      ? await query(`SELECT * FROM dcsa_sim_bookings WHERE request_ref IN (${refs.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY updated_at DESC`, refs)
      : await query("SELECT * FROM dcsa_sim_bookings ORDER BY updated_at DESC LIMIT 200");
    return rows.map(b => ({ ...toBooking(b), carrierCode: b.carrier_code, updatedAt: b.updated_at, actions: availableActions(b) }));
  }

  // ─── Shipping Instructions: the carrier's decisions (Test Tools) ─────────────
  // The carrier accepts instructions by drafting the transport document from them (transport-documents.js:
  // draft, issue, surrender, void); COMPLETED comes only with the surrender. Before 2026-10-28 a
  // "complete" action jumped straight to COMPLETED, against the spec's meaning of it.
  const SI_ACTIONS = {
    requestUpdate: { when: si => si.status === "RECEIVED", apply: () => ({ status: "PENDING_UPDATE", updated_status: "" }), severity: "WARN", code: "PROPERTY_VALUE_MUST_CHANGE" },
    decline:       { when: si => ["RECEIVED", "PENDING_UPDATE"].includes(si.status), apply: () => ({ status: "DECLINED", updated_status: "" }), severity: "ERROR" },
  };
  async function actShippingInstructions(ref, action, { message = "" } = {}) {
    if (transportDocuments.ACTIONS.includes(action)) return transportDocuments.act(ref, action, { message });
    const spec = SI_ACTIONS[action];
    if (!spec) return { ok: false, status: 400, error: `Unknown carrier action "${action}" (${[...Object.keys(SI_ACTIONS), ...transportDocuments.ACTIONS].join(", ")})` };
    const si = await loadSi(ref);
    if (!si) return { ok: false, status: 404, error: `The simulator has no Shipping Instructions ${ref}` };
    if (!spec.when(si)) return { ok: false, status: 409, error: `Can't ${action} Shipping Instructions that are ${si.status}` };
    const next = await saveSi(si, spec.apply(si), feedbackOf(message, spec.code, spec.severity));
    const delivery = await notifySi(next, { retries: [250, 1000] });
    return { ok: true, shippingInstructions: siState(next), delivery };
  }
  async function vgmDeclarations({ equipmentReference = "" } = {}) {
    const rows = equipmentReference
      ? await query("SELECT * FROM dcsa_sim_vgm_declarations WHERE equipment_reference=$1 ORDER BY received_at DESC", [equipmentReference])
      : await query("SELECT * FROM dcsa_sim_vgm_declarations ORDER BY received_at DESC LIMIT 200");
    return rows.map(r => ({ declarationReference: r.declaration_reference, carrierCode: r.carrier_code, equipmentReference: r.equipment_reference,
      isRetracted: !!r.is_retracted, receivedAt: r.received_at, declaration: JSON.parse(r.declaration_json || "{}") }));
  }

  return { INTEGRATION_ID, CAPABILITIES, allowed, integration, registerRoutes, act, list, spotDesk, webhookSecret: () => webhookSecret,
    accessToken: () => accessToken,
    actShippingInstructions, vgmDeclarations, transportDocuments: () => transportDocuments.list(), trackTrace, vesselSchedules, arrivalNotices };
};
