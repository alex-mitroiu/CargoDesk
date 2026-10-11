/**
 * DCSA carrier lifecycle, end to end (Epic TKT-KG4E49, built 2026-10-09) — against a fake carrier
 * that follows the published DCSA specs (Booking 2.0, Track & Trace 2.2, Commercial Schedules 1.0;
 * dcsaorg/Conformance-Gateway): it refuses a booking missing a CreateBooking required field, enforces
 * the cancel/update preconditions, pages its events, and requires the schedule query's parameters.
 *
 *   - a carrier set up only under Carrier Integrations can take booking requests (no eAdapter config)
 *   - the booking request the carrier receives is spec-valid
 *   - notifications are CloudEvents; a repeat records nothing; a booking matches by either reference
 *   - polling picks up an answer when no notification arrives
 *   - "Send update to carrier" sends an amendment for a confirmed booking
 *   - cancelling: a confirmed booking is only REQUESTED to cancel (stays Confirmed, blocks the
 *     shipment's cancellation) until the carrier confirms; a not-yet-confirmed one is withdrawn; a
 *     carrier that refuses the call changes nothing (502)
 *   - Track & Trace: Loaded at POL, Discharged at POD, transshipment moves skipped, departure → Sailed
 *     for every container, planned events ignored, milestones complete, a re-pull adds nothing
 *   - schedule search maps point-to-point routings (legs included)
 *   - a booking request the carrier refuses is flagged send_failed with the carrier's error
 *
 * Usage:
 *   node tests/dcsa-lifecycle.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations (seeded MDM data)
 */

import http from "node:http";
import crypto from "node:crypto";
import { ensureOffices } from "./helpers/offices.mjs";

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function request(method, path, body, token, rawHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)));
    const req = http.request({ method, hostname: "localhost", port: 3001, path, headers: {
      ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(rawHeaders || {}) } }, res => {
      let data = ""; res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", reject); if (payload) req.write(payload); req.end();
  });
}

// ─── The fake carrier ─────────────────────────────────────────────────────────
const CREATE_REQUIRED = ["receiptTypeAtOrigin", "deliveryTypeAtDestination", "cargoMovementTypeAtOrigin", "cargoMovementTypeAtDestination",
  "isEquipmentSubstitutionAllowed", "shipmentLocations", "requestedEquipments", "documentParties"];
function specErrors(b) {
  const errs = CREATE_REQUIRED.filter(k => b[k] === undefined).map(k => `${k} is required`);
  if (!b.documentParties?.bookingAgent?.partyName) errs.push("documentParties.bookingAgent.partyName is required");
  if (!["CY", "SD", "CFS"].includes(b.receiptTypeAtOrigin)) errs.push("receiptTypeAtOrigin must be CY, SD or CFS");
  for (const [i, e] of (b.requestedEquipments || []).entries()) {
    if (!/^[0-9L][0-9A-Z][A-Z][0-9A-Z]$/.test(e.ISOEquipmentCode || "")) errs.push(`requestedEquipments[${i}].ISOEquipmentCode must be an ISO 6346 code`);
    if (!Number.isInteger(e.units)) errs.push(`requestedEquipments[${i}].units is required`);
    if (typeof e.isShipperOwned !== "boolean") errs.push(`requestedEquipments[${i}].isShipperOwned is required`);
  }
  for (const [i, l] of (b.shipmentLocations || []).entries()) if (!l.locationTypeCode || !l.location) errs.push(`shipmentLocations[${i}] needs location + locationTypeCode`);
  return errs;
}
const dcsaError = (status, messages) => ({ httpMethod: "POST", requestUri: "/", statusCode: status, statusCodeText: "Bad Request",
  errorDateTime: new Date().toISOString(), errors: messages.map(m => ({ errorCodeText: "invalidData", errorCodeMessage: m })) });

function startFakeCarrier() {
  const fake = { bookings: new Map(), received: [], failNextCreate: false, refuseCancel: new Set(), events: [], routes: [], eventsQueries: [] };
  let seq = 0;
  const find = ref => [...fake.bookings.values()].find(b => b.carrierBookingRequestReference === ref || b.carrierBookingReference === ref);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      const url = new URL(req.url, "http://fake");
      fake.received.push({ method: req.method, path: url.pathname, body, apiVersion: req.headers["api-version"], auth: req.headers.authorization });
      const send = (status, obj, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
      if (req.method === "POST" && url.pathname === "/v2/bookings") {
        if (fake.failNextCreate) { fake.failNextCreate = false; return send(400, dcsaError(400, ["Service contract HLX unknown"])); }
        const errs = specErrors(body || {});
        if (errs.length) return send(400, dcsaError(400, errs));
        const ref = `FAKE-REQ-${++seq}`;
        fake.bookings.set(ref, { ...body, carrierBookingRequestReference: ref, bookingStatus: "RECEIVED" });
        return send(202, { carrierBookingRequestReference: ref });
      }
      const m = url.pathname.match(/^\/v2\/bookings\/(.+)$/);
      if (m) {
        const b = find(decodeURIComponent(m[1]));
        if (!b) return send(404, dcsaError(404, ["Booking not found"]));
        if (req.method === "GET") return send(200, b);
        if (req.method === "PUT") {
          if (!["RECEIVED", "PENDING_UPDATE", "UPDATE_RECEIVED", "PENDING_AMENDMENT", "CONFIRMED"].includes(b.bookingStatus)) return send(409, dcsaError(409, [`Can't update a ${b.bookingStatus} booking`]));
          const errs = specErrors(body || {});
          if (errs.length) return send(400, dcsaError(400, errs));
          if (b.bookingStatus === "CONFIRMED") b.amendedBookingStatus = "AMENDMENT_RECEIVED"; else b.bookingStatus = "UPDATE_RECEIVED";
          b.lastUpdate = body;
          return send(202);
        }
        if (req.method === "PATCH") {
          if (fake.refuseCancel.has(b.carrierBookingRequestReference)) return send(400, dcsaError(400, ["Cancellation window closed"]));
          if (body?.bookingStatus === "CANCELLED") {
            if (["CONFIRMED", "PENDING_AMENDMENT"].includes(b.bookingStatus)) return send(409, dcsaError(409, ["A confirmed booking must be asked to cancel"]));
            b.bookingStatus = "CANCELLED"; return send(202);
          }
          if (body?.bookingCancellationStatus === "CANCELLATION_RECEIVED") {
            if (b.bookingStatus !== "CONFIRMED") return send(409, dcsaError(409, ["Only a confirmed booking takes a cancellation request"]));
            b.bookingCancellationStatus = "CANCELLATION_RECEIVED"; return send(202);
          }
          return send(400, dcsaError(400, ["Unsupported cancellation body"]));
        }
      }
      if (req.method === "GET" && url.pathname === "/v2/events") {
        fake.eventsQueries.push(Object.fromEntries(url.searchParams));
        const types = (url.searchParams.get("eventType") || "").split(",").filter(Boolean);
        const all = fake.events.filter(e => e.ref === url.searchParams.get("carrierBookingReference") && (!types.length || types.includes(e.ev.eventType))).map(e => e.ev);
        // Two pages, to exercise Next-Page.
        if (url.searchParams.get("cursor") === "p2") return send(200, all.slice(5));
        return send(200, all.slice(0, 5), all.length > 5 ? { "Next-Page": `/v2/events?carrierBookingReference=${encodeURIComponent(url.searchParams.get("carrierBookingReference"))}&cursor=p2` } : {});
      }
      if (req.method === "GET" && url.pathname === "/v1/point-to-point-routes") {
        if (!url.searchParams.get("placeOfReceipt") || !url.searchParams.get("placeOfDelivery")) return send(400, dcsaError(400, ["placeOfReceipt and placeOfDelivery are required"]));
        return send(200, fake.routes);
      }
      send(404, dcsaError(404, ["Not found"]));
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ ...fake, fake, server, port: server.address().port })));
}

(async () => {
  const cleanup = { shipments: [], customers: [] };
  let token, carrier, integrationId;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    carrier = await startFakeCarrier();
    const F = carrier.fake;
    const carrierCode = "ZQ" + Math.random().toString(36).replace(/[^a-z]/g, "").slice(0, 2).toUpperCase().padEnd(2, "X");
    const secret = "dcsa-lifecycle-" + Date.now();

    console.log("Setup: a carrier with only a Carrier Integration (booking, tracking, schedules)");
    const integ = await request("POST", "/api/carrier-integrations", { carrierCode, adapterKey: "dcsa-bkg-v2", isActive: true,
      capabilities: ["booking", "tracking", "schedules"], baseUrl: `http://127.0.0.1:${carrier.port}`, authHeaderName: "Authorization",
      credential: "Bearer fake-token", webhookSecret: secret }, token);
    integrationId = integ.body?.id;
    assert("integration created", integ.status === 201, JSON.stringify(integ.body));

    const shipper = await request("POST", "/api/customers", { companyName: "DCSA Lifecycle Shipper BV" }, token);
    const consignee = await request("POST", "/api/customers", { companyName: "DCSA Lifecycle Consignee Inc" }, token);
    cleanup.customers.push(shipper.body.id, consignee.body.id);
    const newShipment = async (ctrNumbers) => {
      const s = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode, status: "Active", contractType: "SPOT",
        etd: "2026-11-02", eta: "2026-11-14", incoterm: "FOB", commodityCode: "9999", serviceType: "Door-to-Port", placeOfReceipt: "Tilburg warehouse",
        shipperId: shipper.body.id, shipperName: shipper.body.companyName, consigneeId: consignee.body.id, consigneeName: consignee.body.companyName,
        principalId: shipper.body.id, principalName: shipper.body.companyName, emoOfficeId, imoOfficeId }, token);
      if (s.status !== 201) throw new Error(`shipment: ${s.status} ${JSON.stringify(s.body)}`);
      cleanup.shipments.push(s.body.id);
      for (const n of ctrNumbers) await request("POST", "/api/containers", { shipmentId: s.body.id, containerNumber: n, size: "40", type: "HC",
        hsCode: "940360", cargoDescription: "Wooden furniture", grossWeightKg: 9000, volumeCbm: 60 }, token);
      await request("POST", `/api/shipments/${s.body.id}/milestones/init`, {}, token);
      return s.body.id;
    };
    const sign = body => { const raw = Buffer.from(JSON.stringify(body)); return { raw, headers: { "x-dcsa-signature": "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("hex") } }; };
    const notify = async (data, id = crypto.randomUUID()) => {
      const ce = { specversion: "1.0", id, source: "https://fake-carrier.example", type: "org.dcsa.booking.v2", time: new Date().toISOString(),
        datacontenttype: "application/json", subscriptionReference: "sub-1", data };
      const { raw, headers } = sign(ce);
      return request("POST", `/api/carrier-webhooks/${integrationId}`, raw, null, headers);
    };
    const booking = async id => (await request("GET", `/api/shipments/${id}/carrier-booking`, null, token)).body;
    const stamp = String(Date.now()).slice(-5);
    const c1 = `DCSU${stamp}1`, c2 = `DCSU${stamp}2`;

    console.log("\nBooking request — spec-valid, through the integration alone");
    const A = await newShipment([c1, c2]);
    const send = await request("POST", `/api/shipments/${A}/edi-messages/booking-request`, {}, token);
    assert("accepted without any eAdapter config (201, pending)", send.status === 201 && send.body?.pending === true, JSON.stringify(send.body).slice(0, 300));
    const reqRef = send.body?.booking?.carrierBookingRequestReference;
    assert("the carrier's request reference is stored", /^FAKE-REQ-/.test(reqRef || ""), reqRef);
    const created = F.received.find(r => r.method === "POST" && r.path === "/v2/bookings");
    assert("the carrier got a spec-valid CreateBooking (it would have answered 400 otherwise)", !!created && specErrors(created.body).length === 0, JSON.stringify(specErrors(created?.body || {})));
    assert("…ISO 6346 code 45G1 for 2 × 40HC, door pick-up as SD with a place of receipt, API-Version 2",
      created?.body.requestedEquipments[0]?.ISOEquipmentCode === "45G1" && created?.body.requestedEquipments[0]?.units === 2
      && created?.body.receiptTypeAtOrigin === "SD" && created?.body.shipmentLocations.some(l => l.locationTypeCode === "PRE") && created?.apiVersion === "2",
      JSON.stringify(created?.body).slice(0, 400));
    assert("…booking agent = the export office's legal entity / office, commodity from MDM", !!created?.body.documentParties.bookingAgent.partyName
      && !!created?.body.requestedEquipments[0]?.commodities?.[0]?.commodityType, JSON.stringify(created?.body.documentParties));

    console.log("\nNotifications (CloudEvents) and polling");
    const n1 = await notify({ bookingStatus: "RECEIVED", carrierBookingRequestReference: reqRef });
    assert("RECEIVED notification accepted and recorded", n1.status === 201 && n1.body?.changed === true && (await booking(A)).lastResponseStatus === "received", JSON.stringify(n1.body).slice(0, 200));
    const n1again = await notify({ bookingStatus: "RECEIVED", carrierBookingRequestReference: reqRef });
    assert("the same state again records nothing new", n1again.status === 201 && n1again.body?.changed === false);
    // The carrier confirms but its notification never arrives — polling picks it up.
    const fb = [...F.bookings.values()].find(b => b.carrierBookingRequestReference === reqRef);
    fb.bookingStatus = "CONFIRMED"; fb.carrierBookingReference = `ZQBKG${stamp}`;
    const sweep = await request("POST", "/api/carrier-bookings/poll-sweep", {}, token);
    const bA = await booking(A);
    assert("the poll sweep picks up the confirmation", sweep.status === 200 && sweep.body.changed >= 1 && bA.lastResponseStatus === "confirmed" && bA.bookingRef === `ZQBKG${stamp}`,
      JSON.stringify({ sweep: sweep.body, last: bA.lastResponseStatus, ref: bA.bookingRef }));
    assert("…recorded but not yet confirmed in CargoDesk (an operator confirms)", bA.status === "Pending", bA.status);
    const check = await request("POST", `/api/shipments/${A}/carrier-booking/check-status`, {}, token);
    assert("Check status now: nothing changed", check.status === 200 && check.body.changed === false, JSON.stringify(check.body).slice(0, 200));
    const conf = await request("PATCH", `/api/shipments/${A}/carrier-booking/confirm`, { bookingRef: `ZQBKG${stamp}` }, token);
    assert("operator confirms", conf.status === 200 && conf.body.status === "Confirmed", JSON.stringify(conf.body).slice(0, 200));

    console.log("\nSend update to carrier — an amendment once confirmed");
    const upd = await request("POST", `/api/shipments/${A}/carrier-booking/send-update`, {}, token);
    assert("sent (amendment_requested)", upd.status === 200 && upd.body.booking.lastResponseStatus === "amendment_requested", JSON.stringify(upd.body).slice(0, 300));
    const put = F.received.filter(r => r.method === "PUT").pop();
    assert("the carrier got a spec-valid PUT on the booking", put?.path === `/v2/bookings/${reqRef}` && specErrors(put.body).length === 0, JSON.stringify(put).slice(0, 200));
    const n2 = await notify({ bookingStatus: "CONFIRMED", amendedBookingStatus: "AMENDMENT_CONFIRMED", carrierBookingReference: `ZQBKG${stamp}` });
    assert("a notification naming only the carrier's booking number still matches; amendment_confirmed",
      n2.status === 201 && (await booking(A)).lastResponseStatus === "amendment_confirmed", JSON.stringify(n2.body).slice(0, 200));

    console.log("\nTrack & Trace");
    const at = (code, unloc) => ({ UNLocationCode: unloc, locationName: code });
    const eq = (id, code, ctr, empty, unloc, when, cls = "ACT") => ({ ref: `ZQBKG${stamp}`, ev: { eventID: id, eventType: "EQUIPMENT", eventClassifierCode: cls,
      eventDateTime: when, eventCreatedDateTime: when, equipmentEventTypeCode: code, equipmentReference: ctr, emptyIndicatorCode: empty ? "EMPTY" : "LADEN",
      ...(unloc ? { eventLocation: at(code, unloc) } : {}) } });
    F.events.push(
      eq(`E1-${stamp}`, "GTOT", c1, true, "NLRTM", "2026-10-28T08:00:00Z"),
      eq(`E2-${stamp}`, "GTIN", c1, false, "NLRTM", "2026-10-30T08:00:00Z"),
      eq(`E3-${stamp}`, "GTIN", c2, false, "NLRTM", "2026-10-30T09:00:00Z"),
      eq(`E4-${stamp}`, "LOAD", c1, false, "NLRTM", "2026-11-01T08:00:00Z"),
      eq(`E5-${stamp}`, "LOAD", c2, false, "NLRTM", "2026-11-01T09:00:00Z", "PLN"),
      { ref: `ZQBKG${stamp}`, ev: { eventID: `T1-${stamp}`, eventType: "TRANSPORT", eventClassifierCode: "ACT", eventDateTime: "2026-11-02T06:00:00Z",
        eventCreatedDateTime: "2026-11-02T06:00:00Z", transportEventTypeCode: "DEPA", transportCall: { transportCallID: "tc1", modeOfTransport: "VESSEL", UNLocationCode: "NLRTM" } } },
      eq(`E6-${stamp}`, "DISC", c1, false, "BEANR", "2026-11-03T08:00:00Z"),
      eq(`E7-${stamp}`, "LOAD", c1, false, "BEANR", "2026-11-04T08:00:00Z"),
      eq(`E8-${stamp}`, "DISC", c1, false, "USNYC", "2026-11-14T08:00:00Z"),
      eq(`E9-${stamp}`, "GTOT", c1, false, "USNYC", "2026-11-15T08:00:00Z"),
      eq(`E10-${stamp}`, "GTIN", c1, true, "USNYC", "2026-11-20T08:00:00Z"),
      eq(`E11-${stamp}`, "LOAD", "XXXU0000000", false, "NLRTM", "2026-11-01T08:00:00Z"),
    );
    const sync = await request("POST", `/api/shipments/${A}/carrier-events/sync`, {}, token);
    assert("synced (both pages read)", sync.status === 200 && sync.body.received === 12, JSON.stringify({ status: sync.status, received: sync.body?.received, err: sync.body?.error }));
    assert("asked by carrierBookingReference for EQUIPMENT,TRANSPORT, comma-separated as the spec says",
      F.eventsQueries[0]?.carrierBookingReference === `ZQBKG${stamp}` && F.eventsQueries[0]?.eventType === "EQUIPMENT,TRANSPORT", JSON.stringify(F.eventsQueries[0]));
    const ev = await request("GET", `/api/containers?shipmentId=${A}`, null, token);
    const ctrs = Array.isArray(ev.body) ? ev.body : ev.body.results || [];
    const evsOf = async n => {
      const c = ctrs.find(x => x.containerNumber === n);
      return (await request("GET", `/api/shipments/${A}/containers/${c.id}/events`, null, token)).body.map(e => e.eventType).sort();
    };
    const e1 = await evsOf(c1), e2 = await evsOf(c2);
    assert(`${c1}: all seven lifecycle events, transshipment moves left out`,
      JSON.stringify(e1) === JSON.stringify(["Discharged", "Empty Pickup", "Empty Return", "Gate In", "Gate Out", "Loaded", "Sailed"]), JSON.stringify(e1));
    assert(`${c2}: Gate In + Sailed only (its LOAD was planned, not actual)`, JSON.stringify(e2) === JSON.stringify(["Gate In", "Sailed"]), JSON.stringify(e2));
    assert("the skipped list names the transshipment moves, the planned event and the unknown container",
      sync.body.skipped.filter(s => /transshipment/.test(s.reason)).length === 2 && sync.body.skipped.some(s => /not an actual/.test(s.reason))
      && sync.body.skipped.some(s => /not on this shipment/.test(s.reason)), JSON.stringify(sync.body.skipped));
    const ms = (await request("GET", `/api/shipments/${A}/milestones`, null, token)).body;
    const done = k => !!ms.find(m => m.milestoneKey === k)?.completedAt;
    assert("milestones completed the same way as manual events (cargo gated in, vessel departed)", done("cargo_gated_in") && done("vessel_departed"),
      JSON.stringify(ms.map(m => [m.milestoneKey, !!m.completedAt])));
    const sync2 = await request("POST", `/api/shipments/${A}/carrier-events/sync`, {}, token);
    assert("a re-pull adds nothing", sync2.status === 200 && sync2.body.added.length === 0 && sync2.body.alreadyRecorded === 9, JSON.stringify({ added: sync2.body.added?.length, already: sync2.body.alreadyRecorded }));

    console.log("\nCancelling a CONFIRMED booking — only a request until the carrier confirms");
    const cx = await request("PATCH", `/api/shipments/${A}/carrier-booking/cancel`, { reason: "Shipper cancelled" }, token);
    assert("requested: stays Confirmed, cancellation_requested", cx.status === 200 && cx.body.status === "Confirmed" && cx.body.lastResponseStatus === "cancellation_requested", JSON.stringify(cx.body).slice(0, 200));
    const patch1 = F.received.filter(r => r.method === "PATCH").pop();
    assert("the carrier got PATCH bookingCancellationStatus CANCELLATION_RECEIVED", patch1?.body?.bookingCancellationStatus === "CANCELLATION_RECEIVED", JSON.stringify(patch1?.body));
    const cxAgain = await request("PATCH", `/api/shipments/${A}/carrier-booking/cancel`, {}, token);
    assert("asking again is refused while waiting (409)", cxAgain.status === 409, JSON.stringify(cxAgain.body));
    const shipCancel = await request("PUT", `/api/shipments/${A}`, { status: "Cancelled" }, token);
    assert("the shipment can't be cancelled meanwhile — the pop-up says why", shipCancel.status === 409 && shipCancel.body.activeItems?.[0]?.status === "Cancellation requested, waiting for the carrier",
      JSON.stringify(shipCancel.body).slice(0, 300));
    const n3 = await notify({ bookingStatus: "CONFIRMED", bookingCancellationStatus: "CANCELLATION_CONFIRMED", carrierBookingRequestReference: reqRef, carrierBookingReference: `ZQBKG${stamp}` });
    assert("CANCELLATION_CONFIRMED → Cancelled", n3.status === 201 && (await booking(A)).status === "Cancelled", JSON.stringify(n3.body).slice(0, 200));
    const shipCancel2 = await request("PUT", `/api/shipments/${A}`, { status: "Cancelled" }, token);
    assert("now the shipment cancels", shipCancel2.status === 200, JSON.stringify(shipCancel2.body).slice(0, 200));

    console.log("\nCancelling a booking not yet confirmed — withdrawn; a refusal changes nothing");
    const B = await newShipment([`DCSU${stamp}3`]);
    const sendB = await request("POST", `/api/shipments/${B}/edi-messages/booking-request`, {}, token);
    const refB = sendB.body?.booking?.carrierBookingRequestReference;
    F.refuseCancel.add(refB);
    const refused = await request("PATCH", `/api/shipments/${B}/carrier-booking/cancel`, { reason: "Changed plans" }, token);
    assert("the carrier refuses → 502 with its error, booking unchanged", refused.status === 502 && /Cancellation window closed/.test(refused.body.error || "") && (await booking(B)).status === "Pending",
      JSON.stringify(refused.body));
    F.refuseCancel.delete(refB);
    const okCancel = await request("PATCH", `/api/shipments/${B}/carrier-booking/cancel`, { reason: "Changed plans" }, token);
    const patch2 = F.received.filter(r => r.method === "PATCH").pop();
    assert("withdrawn: the carrier got bookingStatus CANCELLED, CargoDesk shows Cancelled", okCancel.status === 200 && okCancel.body.status === "Cancelled" && patch2?.body?.bookingStatus === "CANCELLED",
      JSON.stringify({ booking: okCancel.body?.status, patch: patch2?.body }));

    console.log("\nRejection, and a booking request the carrier refuses");
    const C = await newShipment([`DCSU${stamp}4`]);
    const refC = (await request("POST", `/api/shipments/${C}/edi-messages/booking-request`, {}, token)).body?.booking?.carrierBookingRequestReference;
    await notify({ bookingStatus: "REJECTED", carrierBookingRequestReference: refC, feedbacks: [{ severity: "ERROR", code: "PROPERTY_VALUE_HAS_BEEN_CHANGED", message: "No space" }] });
    assert("REJECTED → Rejected", (await booking(C)).status === "Rejected");
    const D = await newShipment([`DCSU${stamp}5`]);
    F.failNextCreate = true;
    const sendD = await request("POST", `/api/shipments/${D}/edi-messages/booking-request`, {}, token);
    assert("refused request: carrierError returned, booking flagged send_failed", sendD.status === 201 && /Service contract HLX unknown/.test(sendD.body.carrierError || "")
      && sendD.body.booking.lastResponseStatus === "send_failed", JSON.stringify(sendD.body).slice(0, 300));

    console.log("\nSchedule search — DCSA point-to-point routings");
    const loc = (unloc, dt) => ({ facilityTypeCode: "POTE", location: { UNLocationCode: unloc }, dateTime: dt });
    F.routes.push({ placeOfReceipt: loc("ZZTS3", "2026-11-05T10:00:00Z"), placeOfDelivery: loc("ZZTS4", "2026-11-25T10:00:00Z"), transitTime: 20,
      routingReference: "R-1", legs: [
        { sequenceNumber: 1, transport: { modeOfTransport: "VESSEL", vessel: { name: "FAKE FEEDER", vesselIMONumber: "9111111" }, servicePartners: [{ carrierServiceCode: "FD1", carrierExportVoyageNumber: "011E" }] },
          departure: loc("ZZTS3", "2026-11-05T10:00:00Z"), arrival: loc("ZZTS5", "2026-11-07T10:00:00Z") },
        { sequenceNumber: 2, transport: { modeOfTransport: "VESSEL", vessel: { name: "FAKE MAINLINER", vesselIMONumber: "9222222" }, servicePartners: [{ carrierServiceCode: "ML7", carrierExportVoyageNumber: "702W" }] },
          departure: loc("ZZTS5", "2026-11-09T10:00:00Z"), arrival: loc("ZZTS4", "2026-11-25T10:00:00Z") },
      ] });
    const sch = await request("GET", `/api/schedules/search?pol=ZZTS3&pod=ZZTS4&carrierCode=${carrierCode}&weeks=6`, null, token);
    const s0 = sch.body?.sailings?.[0];
    assert("a live two-leg sailing: first vessel leg's vessel/voyage/service, both legs kept, transit days",
      s0?.source === "live" && s0.vesselName === "FAKE FEEDER" && s0.voyageNumber === "011E" && s0.service === "FD1" && s0.legs?.length === 2
      && s0.legs[1].vesselName === "FAKE MAINLINER" && s0.transitDays === 20 && s0.etd === "2026-11-05" && s0.eta === "2026-11-25", JSON.stringify(s0));
  } catch (e) {
    console.error("\nFatal:", e.stack || e.message);
    failed++;
  } finally {
    if (token) {
      console.log("\nCleanup");
      for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
      if (integrationId) await request("DELETE", `/api/carrier-integrations/${integrationId}`, null, token);
      for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token);
    }
    carrier?.server.close();
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
