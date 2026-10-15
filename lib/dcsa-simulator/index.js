"use strict";

// Built-in DCSA carrier simulator (DCSA-everywhere program, phase 1; Epic TKT-G2J60Z).
//
// The carrier side of the DCSA standards, served by CargoDesk itself under /dcsa-sim, for every carrier
// that has no real DCSA integration. CargoDesk talks to it through the same adapters, HTTP calls,
// validation and webhook receiver as a real carrier, so a booking made against the simulator exercises
// the whole production path. Phase 1 implements Booking 2.0; each later phase adds its standard.
//
// Where it runs (decided by the user, 2026-10-11): always outside production; in production only when
// an admin turns on App Settings → "Demo carrier" (dcsa_demo_carrier_enabled). Everything it touches is
// flagged (carrier_bookings.is_mock) and shown as DEMO CARRIER.
//
// Carrier-side state lives in dcsa_sim_bookings. The carrier's decisions (confirm, reject, ask for an
// update, confirm a cancellation…) are taken from Test Tools through act(); each one sends a signed
// DCSA notification to /api/carrier-webhooks/dcsa-simulator, as a real carrier would.

const crypto = require("crypto");
const { validateRequest, errorsText } = require("../dcsa/validate");

const INTEGRATION_ID = "dcsa-simulator";
const CAPABILITIES = new Set(["booking"]);
// Booking states (lib/dcsa/codes.js BOOKING_STATUS) the consumer may still change with a PUT/PATCH.
const OPEN = ["RECEIVED", "PENDING_UPDATE", "UPDATE_RECEIVED"];
const LIVE = ["CONFIRMED", "PENDING_AMENDMENT"];

module.exports = function createDcsaSimulator({ query, uid, getSettings, port }) {
  // Shared only between the simulator and the receiver in this process; a restart only invalidates a
  // notification still being retried, which the next poll (routes/edi.js) picks up anyway.
  const webhookSecret = crypto.randomBytes(32).toString("hex");
  const baseUrl = () => `http://127.0.0.1:${port()}/dcsa-sim`;

  async function allowed() {
    if (process.env.NODE_ENV !== "production") return true;
    return (await getSettings()).dcsa_demo_carrier_enabled === "true";
  }

  // The shape carrierIntegrationFor (server.js) returns for a real carrier_integrations row.
  function integration(carrierCode, capability) {
    if (!CAPABILITIES.has(capability)) return null;
    const row = { id: INTEGRATION_ID, carrier_code: carrierCode, adapter_key: "dcsa-bkg-v2", is_active: true,
      is_simulator: true, capabilities: JSON.stringify([...CAPABILITIES]), base_url: baseUrl(),
      auth_header_name: "Authorization", credential: "Bearer dcsa-simulator", webhook_secret: webhookSecret };
    return { row, config: { baseUrl: row.base_url, authHeaderName: row.auth_header_name, credential: row.credential, webhookSecret } };
  }

  // ─── Carrier-side records ────────────────────────────────────────────────────
  const load = async ref => (await query(
    "SELECT * FROM dcsa_sim_bookings WHERE request_ref=$1 OR (carrier_booking_ref <> '' AND carrier_booking_ref=$1)", [ref]))[0] || null;

  function toBooking(b) {
    let request = {}, feedbacks = [];
    try { request = JSON.parse(b.request_json || "{}"); } catch { /* stored by us; never malformed */ }
    try { feedbacks = JSON.parse(b.feedbacks_json || "[]"); } catch { feedbacks = []; }
    return {
      ...request,
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
      booking_cancellation_status=$4, request_json=$5, feedbacks_json=$6, updated_at=$7 WHERE request_ref=$8`,
      [next.carrier_booking_ref || "", next.booking_status, next.amended_booking_status || "", next.booking_cancellation_status || "",
       next.request_json, next.feedbacks_json, next.updated_at, b.request_ref]);
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
    const v = validateRequest("bkg", "post", "/v2/booking-notifications", event);
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
      next();
    });

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
  }

  // ─── The carrier's decisions (Test Tools) ───────────────────────────────────
  const feedbackOf = (message, code = "INFORMATIONAL_MESSAGE", severity = "INFO") =>
    message ? { severity, code, message: String(message).slice(0, 5000) } : null;
  const ACTIONS = {
    confirm:             { when: b => ["RECEIVED", "UPDATE_RECEIVED"].includes(b.booking_status),
                           apply: b => ({ booking_status: "CONFIRMED", carrier_booking_ref: b.carrier_booking_ref || `${(b.carrier_code || "SIM").slice(0, 4)}${String(Date.now()).slice(-6)}${uid().slice(0, 3)}` }) },
    requestUpdate:       { when: b => ["RECEIVED", "UPDATE_RECEIVED"].includes(b.booking_status), apply: () => ({ booking_status: "PENDING_UPDATE" }), severity: "WARN", code: "PROPERTY_VALUE_MUST_CHANGE" },
    reject:              { when: b => OPEN.includes(b.booking_status), apply: () => ({ booking_status: "REJECTED" }), severity: "ERROR" },
    requestAmendment:    { when: b => b.booking_status === "CONFIRMED", apply: () => ({ booking_status: "PENDING_AMENDMENT" }), severity: "WARN", code: "PROPERTY_VALUE_MUST_CHANGE" },
    decline:             { when: b => LIVE.includes(b.booking_status), apply: () => ({ booking_status: "DECLINED" }), severity: "ERROR" },
    confirmAmendment:    { when: b => b.amended_booking_status === "AMENDMENT_RECEIVED", apply: () => ({ amended_booking_status: "AMENDMENT_CONFIRMED", booking_status: "CONFIRMED" }) },
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
    const next = await save(b, spec.apply(b), feedbackOf(message, spec.code, spec.severity));
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

  return { INTEGRATION_ID, CAPABILITIES, allowed, integration, registerRoutes, act, list, webhookSecret: () => webhookSecret };
};
