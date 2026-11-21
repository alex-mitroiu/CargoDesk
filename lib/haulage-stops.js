"use strict";
// ─── Haulage stops: the trucker's run on a Pickup or Delivery service (2026-11-20, ARCHITECTURE.md §8.56) ──────────────
// The user's idea (mockup 3d91c28a, approved "looks great - go ahead"): a merchant's haulage run is a list of stops (the
// empty depot, the shipper's door, the terminal; on import the terminal, the consignee's door, the empty depot), each with
// a planned gate in and out per container, the places from Master Data (customers, terminals from the SMDG list, depots),
// and the carrier's closing times the haulier has to respect. Decisions A–G (my recommendations, all approved):
//   A  the documentation cut-off is not printed for the trucker; the VGM cut-off only for a container weighed during the run
//      (VGM Method 1); the CY cut-off and the earliest delivery (when the carrier gives one) are.
//   B  one route for every container, times per container; a container may get its own stops.
//   C  the trucker is the service's vendor; the Trucker (Pre-/On-carriage) party follows it (both ways, routes).
//   D  terminals from the SMDG list fetched at run time, depots by hand (lib/facilities.js).
//   E  the carrier's cut-offs fill a container's empty CY and VGM cut-off; a typed value stays and is flagged when it differs.
//   F  Delivery works the same way.
//   G  the old free-text waypoints become stops ("Other"), the gate in/out pair the first stop's out and the last one's in.
// Times are the stop's own local wall-clock time ("YYYY-MM-DDTHH:mm"); checks compare instants in UTC. Every check is a
// warning, never a block. Built once as ctx.haulage.

const { timezoneFor, zoneInfo } = require("./timezones");
const { doorContact, localDateTime } = require("./booking-doors");
const { containerIso, containerSeals } = require("./dcsa/codes");

const PURPOSES = Object.freeze([
  { key: "EMPTY_PICKUP", label: "Empty pick-up", side: "Export", event: { type: "Empty Pickup", at: "out" }, inOut: ["gate in", "gate out"] },
  { key: "LOAD", label: "Load at the door", side: "Export", inOut: ["arrive", "leave"] },
  { key: "WEIGH", label: "Weigh (VGM)", side: "Export", inOut: ["arrive", "leave"] },
  { key: "CUSTOMS", label: "Customs", side: "", inOut: ["arrive", "leave"] },
  { key: "FULL_GATE_IN", label: "Full gate-in", side: "Export", event: { type: "Gate In", at: "in" }, inOut: ["gate in", "gate out"] },
  { key: "FULL_PICKUP", label: "Full pick-up", side: "Import", event: { type: "Gate Out", at: "out" }, inOut: ["gate in", "gate out"] },
  { key: "UNLOAD", label: "Unload at the door", side: "Import", inOut: ["arrive", "leave"] },
  { key: "EMPTY_RETURN", label: "Empty return", side: "Import", event: { type: "Empty Return", at: "in" }, inOut: ["gate in", "gate out"] },
  { key: "OTHER", label: "Other", side: "", inOut: ["arrive", "leave"] },
]);
const PURPOSE = Object.fromEntries(PURPOSES.map(p => [p.key, p]));
const PLACE_KINDS = Object.freeze(["customer", "facility", "gps", "address", "none"]);
// The run's planned end per side: the stop whose arrival the cut-offs judge.
const LOCAL_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DAY_MS = 86400000;

const trim = v => String(v ?? "").trim();
const hasCoords = (lat, lng) => lat != null && lng != null && lat !== "" && lng !== "" && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));

// ── Time ────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A stop's local wall-clock time → the instant (ms), or null.
const localToMs = (local, tz) => { const s = localDateTime(local, tz); return s ? Date.parse(s) : null; };
// An instant → the wall-clock time in tz ("YYYY-MM-DDTHH:mm").
function msToLocal(ms, tz) {
  if (!Number.isFinite(ms)) return "";
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch { return new Date(ms).toISOString().slice(0, 16); }
}
// A stored time: with a zone (an event from a carrier, "…Z" or "+01:00") it is an instant; without one it is already the
// stop's wall-clock time (typed on a screen).
const hasZone = v => /(Z|[+-]\d{2}:?\d{2})$/.test(trim(v));
const asLocal = (v, tz) => (hasZone(v) ? msToLocal(Date.parse(trim(v)), tz) : trim(v).slice(0, 16));
const asMs = (v, tz) => (hasZone(v) ? Date.parse(trim(v)) : LOCAL_RX.test(trim(v).slice(0, 16)) ? localToMs(trim(v).slice(0, 16), tz) : null);
const offsetOf = (tz, ms = Date.now()) => zoneInfo(tz, new Date(ms))?.utcOffset || "";

// "48 h 30 m", "3 d 4 h": how far a planned time is from a limit.
function fmtSpan(minutes) {
  const m = Math.abs(Math.round(minutes));
  if (m >= 72 * 60) { const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return h ? `${d} d ${h} h` : `${d} d`; }
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} h ${r} m` : `${h} h`) : `${r} m`;
}
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// "Sat 24 Oct 14:00" from a wall-clock time; "Sat 24 Oct" from a date.
function fmtLocal(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(trim(local));
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${DOW[d.getUTCDay()]} ${+m[3]} ${MON[+m[2] - 1]}${m[4] ? ` ${m[4]}:${m[5]}` : ""}`;
}

// ── Cut-offs and checks ─────────────────────────────────────────────────────────────────────────────────────────────
// A limit is an instant (the carrier's cut-off, or a container's cut-off saved with a time: those are UTC, as the
// carrier's acceptance writes them) or a date (typed on the Cargo page, which takes a date only).
function limitOf(value, source) {
  const v = trim(value);
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { source, date: v };
  const ms = hasZone(v) ? Date.parse(v) : Date.parse(`${v.slice(0, 16)}:00Z`);
  return Number.isFinite(ms) ? { source, ms } : null;
}
// planned (instant + the stop's local date) against limits: the worst result. before = true: planned must be at or before
// the limit; false: at or after (the earliest delivery).
function judge(planned, limits, before = true) {
  let worst = null;
  for (const l of limits.filter(Boolean)) {
    let r;
    if (l.ms != null) {
      const minutes = Math.round((before ? l.ms - planned.ms : planned.ms - l.ms) / 60000);
      r = { ok: minutes >= 0, minutes, limit: l };
    } else r = { ok: before ? planned.date <= l.date : planned.date >= l.date, minutes: null, limit: l };
    const rank = x => (x.ok ? 1e12 + (x.minutes ?? 1e11) : -(Math.abs(x.minutes ?? 0)) - 1);
    if (!worst || rank(r) < rank(worst)) worst = r;
  }
  return worst;
}
const checkText = (r, what, before = true) => {
  if (r.minutes == null) {
    const day = fmtLocal(r.limit.date);
    return r.ok ? `on or ${before ? "before" : "after"} the ${what} day (${day})` : `${before ? "after" : "before"} the ${what} day (${day})`;
  }
  if (r.ok) return `${fmtSpan(r.minutes)} ${before ? "before" : "after"} the ${what}`;
  return `${fmtSpan(r.minutes)} ${before ? "after" : "before"} the ${what}`;
};
const method1 = c => /(^|\D)1$|SM1|method\s*1/i.test(trim(c.vgm_method));

// The checks for one container's run. stops: its stops in order; times: { [stopId]: { plannedIn, plannedOut, actualIn,
// actualOut } } (wall-clock, with actualIn/OutMs when known); tzOf(stop); cut: the carrier's cut-offs as limits;
// container: the containers row; discharge: { ms } on import. → [{ key, ok, text }]
function checksFor({ side, stops, times, tzOf, cut = {}, container, discharge }) {
  const out = [];
  const at = (stop, which) => {
    const t = times[stop.id] || {};
    const v = which === "in" ? (t.plannedIn || t.plannedOut) : (t.plannedOut || t.plannedIn);
    if (!v) return null;
    const ms = localToMs(v, tzOf(stop));
    return ms == null ? null : { ms, date: v.slice(0, 10) };
  };
  const actualOrPlanned = (stop, which) => {
    const t = times[stop.id] || {};
    const ms = which === "out" ? t.actualOutMs : t.actualInMs;
    return Number.isFinite(ms) ? { ms, date: msToLocal(ms, tzOf(stop)).slice(0, 10) } : at(stop, which);
  };
  const last = key => [...stops].reverse().find(s => s.purpose === key);
  const first = key => stops.find(s => s.purpose === key);
  const add = (key, r, what, before = true) => r && out.push({ key, ok: r.ok, text: checkText(r, what, before) });
  if (side === "Export") {
    const gate = last("FULL_GATE_IN");
    const gateAt = gate && at(gate, "in");
    if (gateAt) {
      add("FCO", judge(gateAt, [cut.FCO, limitOf(container.cy_cutoff, "container")]), "CY cut-off");
      if (cut.EFC) add("EFC", judge(gateAt, [cut.EFC], false), "earliest delivery", false);
    }
    if (method1(container)) {
      const weigh = first("WEIGH");
      const weighAt = (weigh && at(weigh, "in")) || gateAt;
      if (weighAt) add("VCO", judge(weighAt, [cut.VCO, limitOf(container.vgm_cutoff, "container")]), "VGM cut-off");
    }
    const empty = first("EMPTY_PICKUP");
    const emptyAt = empty && actualOrPlanned(empty, "out");
    if (container.origin_detention_free_days != null && emptyAt && gateAt)
      add("DET_ORIGIN", judge(gateAt, [{ ms: emptyAt.ms + Number(container.origin_detention_free_days) * DAY_MS }]), "detention free time");
  } else {
    const pick = first("FULL_PICKUP");
    const pickAt = pick && at(pick, "out");
    if (container.dest_free_time_days != null && pickAt && discharge?.ms != null)
      add("DEM", judge(pickAt, [{ ms: discharge.ms + Number(container.dest_free_time_days) * DAY_MS }]), "terminal free time");
    const ret = last("EMPTY_RETURN");
    const retAt = ret && at(ret, "in");
    const pickStart = pick && actualOrPlanned(pick, "out");
    if (container.dest_detention_free_days != null && retAt && pickStart)
      add("DET_DEST", judge(retAt, [{ ms: pickStart.ms + Number(container.dest_detention_free_days) * DAY_MS }]), "detention free time");
  }
  return out;
}

// G: one container's old free-text waypoints → its own stops (purpose Other), the gate out on the first stop and the gate
// in on the last. record: shipment_haulage_records row; waypoints in order. Pure.
function legacyToStops(record, waypoints) {
  const stops = waypoints.map((w, i) => {
    const gps = w.loc_type === "GPS Coordinates" && hasCoords(w.latitude, w.longitude);
    return { legacyId: w.id, sequenceOrder: i + 1, purpose: "OTHER", placeKind: gps ? "gps" : "address",
      placeName: gps ? "" : (trim(w.location) || trim(w.loc_type)), latitude: gps ? Number(w.latitude) : null, longitude: gps ? Number(w.longitude) : null,
      notes: [trim(w.loc_type) && `Was: ${trim(w.loc_type)}`, trim(w.notes)].filter(Boolean).join(" · ") };
  });
  const times = {};
  if (stops.length) {
    const gateOut = trim(record.gate_out_at).slice(0, 16), gateIn = trim(record.gate_in_at).slice(0, 16);
    if (gateOut) times[0] = { ...(times[0] || {}), actualOut: gateOut };
    if (gateIn) times[stops.length - 1] = { ...(times[stops.length - 1] || {}), actualIn: gateIn };
  }
  return { stops, times };
}

const EQUIPMENT_WORD = { HC: "High Cube", GP: "Dry", DV: "Dry", DC: "Dry", RF: "Reefer", RH: "Reefer High Cube", OT: "Open Top", FR: "Flat Rack", TK: "Tank", PL: "Platform" };
const equipmentLabel = c => `${c.size || ""}' ${EQUIPMENT_WORD[String(c.type || "").toUpperCase()] || c.type || ""}`.trim();

module.exports = function haulageStops(ctx) {
  const { query, transaction, uid, getCustomerRow, getSettings } = ctx;
  const nowIso = () => new Date().toISOString();

  async function customerContacts(customerId) {
    if (((await getSettings()).customer_source || "local") === "remote") {
      try { return await ctx.callCustomerService("GET", `/internal/customers/${customerId}/contacts`); } catch { return []; }
    }
    return (await query("SELECT * FROM customer_contacts WHERE customer_id=$1 ORDER BY is_primary DESC, created_at ASC", [customerId])).map(ctx.mapCustomerContact);
  }

  // The service's run: its pick-up leg (Export: the first Pick-up leg) or delivery leg (Import: the last Delivery leg), and
  // the port its trucker starts or ends at (the first sea leg's POL, the last sea leg's POD; shipments.pol can be a place).
  async function routeOf(shipment, side) {
    const legs = await query("SELECT * FROM shipment_legs WHERE shipment_id=$1 ORDER BY leg_order, created_at", [shipment.id]);
    const sea = legs.filter(l => l.leg_type === "SEA" || (!l.leg_type && l.movement_type === "SEA"));
    const leg = side === "Export" ? legs.find(l => l.leg_type === "Pick-up") || null : [...legs].reverse().find(l => l.leg_type === "Delivery") || null;
    const port = side === "Export" ? (sea[0]?.pol || shipment.pol) : (sea[sea.length - 1]?.pod || shipment.pod);
    const eta = sea[sea.length - 1]?.eta || shipment.eta || "";
    const etd = sea[0]?.etd || shipment.etd || "";
    return { leg, port: trim(port).toUpperCase(), eta, etd };
  }

  async function bookingOf(shipmentId) {
    const [b] = await query("SELECT * FROM carrier_bookings WHERE shipment_id=$1", [shipmentId]);
    let dcsa = null;
    try { dcsa = b?.carrier_confirmation ? JSON.parse(b.carrier_confirmation) : null; } catch { dcsa = null; }
    return { booking: b || null, dcsa };
  }
  const cutOffsOf = dcsa => Object.fromEntries((dcsa?.shipmentCutOffTimes || []).filter(c => c?.cutOffDateTimeCode && c?.cutOffDateTime)
    .map(c => [c.cutOffDateTimeCode, c.cutOffDateTime]));

  // E: the carrier's cut-offs fill a container's EMPTY CY and VGM cut-off (never one someone typed; "Accept the carrier's
  // version" on Booking & Review still overwrites, on purpose). Called when a confirmation is kept. → number of fields filled
  async function fillCutOffs(shipmentId, dcsa, actor = "") {
    const cut = cutOffsOf(dcsa);
    const local = v => trim(v).slice(0, 16); // "YYYY-MM-DDTHH:mm" (UTC), the shape the acceptance writes
    let filled = 0;
    for (const [col, code, label] of [["cy_cutoff", "FCO", "CY Cutoff"], ["vgm_cutoff", "VCO", "VGM Cutoff"]]) {
      if (!cut[code]) continue;
      const rows = await query(`UPDATE containers SET ${col}=$1 WHERE shipment_id=$2 AND COALESCE(${col},'')='' RETURNING id, container_number`, [local(cut[code]), shipmentId]);
      for (const r of rows) {
        filled++;
        await ctx.logEvent(shipmentId, "CONTAINER_UPDATED", label, "", `${local(cut[code])} UTC`,
          JSON.stringify({ containerId: r.id, containerNumber: r.container_number || "", source: "carrier confirmation", code }), actor || "Carrier");
      }
    }
    return filled;
  }

  // ── Places ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function placeView(stop, cache) {
    const kind = stop.place_kind;
    if (kind === "customer" && stop.customer_id) {
      if (!cache.customers.has(stop.customer_id)) {
        const c = await getCustomerRow(stop.customer_id).catch(() => null);
        cache.customers.set(stop.customer_id, c ? { c, contacts: await customerContacts(c.id) } : null);
      }
      const hit = cache.customers.get(stop.customer_id);
      if (!hit) return { kind, customerId: stop.customer_id, name: stop.place_name || "", lines: [], missing: "customer" };
      const c = hit.c;
      const street = [trim(c.address1), trim(c.address2)].filter(Boolean).join(", ");
      const cityLine = [trim(c.postalCode), trim(c.city)].filter(Boolean).join(" ");
      const lines = c.classifiedLocation && hasCoords(c.latitude, c.longitude) && !street
        ? [`GPS ${Number(c.latitude).toFixed(5)}, ${Number(c.longitude).toFixed(5)}`]
        : [street, [cityLine, trim(c.countryIso2)].filter(Boolean).join(", ")].filter(Boolean);
      const contact = doorContact(c, hit.contacts);
      return { kind, customerId: c.id, name: c.companyName, lines, countryCode: trim(c.countryIso2).toUpperCase(),
        latitude: hasCoords(c.latitude, c.longitude) ? Number(c.latitude) : null, longitude: hasCoords(c.latitude, c.longitude) ? Number(c.longitude) : null,
        contact, companyContact: !!contact && contact.name === trim(c.companyName).slice(0, 35), noAddress: !street && !(c.classifiedLocation && hasCoords(c.latitude, c.longitude)) };
    }
    if (kind === "facility" && stop.facility_id) {
      if (!cache.facilities.has(stop.facility_id)) cache.facilities.set(stop.facility_id, await ctx.facilities.get(stop.facility_id));
      const f = cache.facilities.get(stop.facility_id);
      if (!f) return { kind, facilityId: stop.facility_id, name: stop.place_name || "", lines: [], missing: "facility" };
      return { kind, facilityId: f.id, name: f.name, lines: f.address ? [f.address] : [], unlocode: f.unlocode, code: f.code, codeList: f.code_list,
        facilityKind: f.kind, source: f.source, latitude: f.latitude, longitude: f.longitude, open: ctx.facilities.isOpen(f) };
    }
    if (kind === "gps") return { kind, name: stop.place_name || "", lines: hasCoords(stop.latitude, stop.longitude) ? [`GPS ${Number(stop.latitude).toFixed(5)}, ${Number(stop.longitude).toFixed(5)}`] : [],
      latitude: stop.latitude, longitude: stop.longitude };
    if (kind === "address") return { kind, name: stop.place_name || "", lines: stop.place_address ? stop.place_address.split(/\n/).filter(Boolean) : [] };
    return { kind: "none", name: "", lines: [], unlocode: stop.unlocode || "" };
  }
  const tzForPlace = (place, stop, portTz) => {
    if (place.kind === "facility") return timezoneFor({ unlocode: place.unlocode, latitude: place.latitude, longitude: place.longitude }) || portTz;
    if (place.kind === "customer") return timezoneFor({ unlocode: stop.unlocode, countryCode: place.countryCode, latitude: place.latitude, longitude: place.longitude }) || portTz;
    if (place.kind === "gps") return timezoneFor({ unlocode: stop.unlocode, latitude: stop.latitude, longitude: stop.longitude }) || portTz;
    return (stop.unlocode && timezoneFor({ unlocode: stop.unlocode })) || portTz;
  };
  const warningsOf = (stop, place) => {
    const w = [];
    if (place.kind === "none") w.push(stop.purpose === "EMPTY_PICKUP" || stop.purpose === "EMPTY_RETURN" ? "Choose the depot" : "Choose where");
    if (place.missing === "customer") w.push("This customer is no longer in Master Data → Customers: choose it again");
    if (place.missing === "facility") w.push("This facility is no longer in Master Data → Facilities: choose another");
    if (place.kind === "facility" && place.open === false) w.push(`${place.name} is closed (Master Data → Facilities)`);
    if (place.kind === "customer" && !place.missing) {
      if (place.noAddress) w.push(`No address on ${place.name}'s customer profile`);
      if (!place.contact) w.push(`No phone or e-mail on ${place.name}'s customer profile`);
      else if (place.companyContact) w.push("No named contact on the profile, so the company phone is printed. Add an Operations contact to give the driver a person to ask for.");
    }
    return w;
  };

  // ── The plan ───────────────────────────────────────────────────────────────────────────────────────────────────────
  // Everything the Pickup or Delivery page and its trucker's document show. → plan or null (no such service)
  async function planFor(shipmentId, serviceId) {
    const [service] = await query("SELECT * FROM shipment_services WHERE id=$1 AND shipment_id=$2", [serviceId, shipmentId]);
    if (!service) return null;
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    if (!shipment) return null;
    const side = service.side === "Import" ? "Import" : "Export";
    const { leg, port, eta, etd } = await routeOf(shipment, side);
    const [portRow] = port ? await query("SELECT unlocode, name, timezone FROM port_locations WHERE unlocode=$1", [port]) : [];
    const portTz = portRow?.timezone || timezoneFor({ unlocode: port }) || "UTC";
    // The offsets shown are the run's (the sailing's day: the clocks may change between today and then).
    const refDay = trim(side === "Export" ? etd : eta).slice(0, 10);
    const refMs = /^\d{4}-\d{2}-\d{2}$/.test(refDay) ? Date.parse(`${refDay}T12:00:00Z`) : Date.now();
    const { booking, dcsa } = await bookingOf(shipmentId);
    const cutRaw = cutOffsOf(dcsa);
    const cut = Object.fromEntries(Object.entries(cutRaw).map(([k, v]) => [k, limitOf(v, "carrier")]));

    const ctrs = await query(`SELECT c.*, l.planned_date AS plan_date, l.sequence_order AS plan_seq, l.notes AS plan_notes,
        hr.id AS hr_id, hr.own_stops, hr.driver_name, hr.driver_id_number, hr.truck_plate, hr.instructions, hr.cost_amount, hr.cost_currency,
        hr.cost_exchange_rate, hr.cost_line_id, hr.gate_in_at, hr.gate_out_at, hr.gate_moved
      FROM containers c
      LEFT JOIN shipment_loading_plan_lines l ON l.container_id = c.id AND l.service_id = $1
      LEFT JOIN shipment_haulage_records hr ON hr.container_id = c.id AND hr.service_id = $1
      WHERE c.shipment_id = $2
      ORDER BY (l.sequence_order IS NULL), l.sequence_order, c.container_number, c.id`, [serviceId, shipmentId]);
    const stopRows = await query("SELECT * FROM haulage_stops WHERE service_id=$1 ORDER BY container_id NULLS FIRST, sequence_order, created_at", [serviceId]);
    const timeRows = stopRows.length ? await query(`SELECT t.* FROM haulage_stop_times t JOIN haulage_stops s ON s.id = t.stop_id WHERE s.service_id=$1`, [serviceId]) : [];
    const events = await query(`SELECT container_id, event_type, occurred_at FROM container_events
      WHERE shipment_id=$1 AND COALESCE(event_classifier,'ACTUAL')='ACTUAL' ORDER BY occurred_at`, [shipmentId]);

    const cache = { customers: new Map(), facilities: new Map() };
    const bookingRef = trim(booking?.booking_ref || shipment.booking_ref);
    const releaseRef = side === "Export" ? (bookingRef && `Booking ${bookingRef}`) : (trim(shipment.master_bl_number) ? `B/L ${trim(shipment.master_bl_number)}` : bookingRef && `Booking ${bookingRef}`);
    const stopView = async s => {
      const place = await placeView(s, cache);
      const tz = tzForPlace(place, s, portTz);
      const p = PURPOSE[s.purpose] || PURPOSE.OTHER;
      const gateRef = ["EMPTY_PICKUP", "FULL_GATE_IN", "FULL_PICKUP", "EMPTY_RETURN"].includes(s.purpose) ? releaseRef : "";
      return { id: s.id, containerId: s.container_id || null, sequenceOrder: s.sequence_order, purpose: p.key, purposeLabel: p.label, inOut: p.inOut,
        place, contact: place.contact || null, reference: s.reference || "", effectiveReference: s.reference || gateRef || "", notes: s.notes || "",
        unlocode: s.unlocode || place.unlocode || "", timezone: tz, utcOffset: offsetOf(tz, refMs), warnings: warningsOf(s, place), event: p.event || null };
    };
    const views = [];
    for (const s of stopRows) views.push(await stopView(s));
    const shared = views.filter(v => !v.containerId);
    const tzOf = stop => stop.timezone || portTz;

    const eventsBy = {};
    for (const e of events) ((eventsBy[e.container_id] ||= {})[e.event_type] = e.occurred_at);
    const timesBy = {};
    for (const t of timeRows) (timesBy[t.container_id] ||= {})[t.stop_id] = t;
    const dischargeOf = cid => {
      const ev = eventsBy[cid]?.Discharged;
      const ms = ev ? asMs(ev, portTz) : (eta ? Date.parse(`${trim(eta).slice(0, 10)}T00:00:00Z`) : NaN);
      return Number.isFinite(ms) ? { ms, from: ev ? "discharged" : "eta" } : null;
    };

    const containers = ctrs.map(c => {
      const stops = c.own_stops ? views.filter(v => v.containerId === c.id) : shared;
      const times = {};
      for (const stop of stops) {
        const t = timesBy[c.id]?.[stop.id] || {};
        const tz = tzOf(stop);
        const ev = stop.event ? eventsBy[c.id]?.[stop.event.type] : null;
        const fromEvent = which => (ev && stop.event.at === which ? { value: asLocal(ev, tz), ms: asMs(ev, tz), source: "event" } : null);
        const typed = v => (trim(v) ? { value: trim(v), ms: localToMs(trim(v), tz), source: "typed" } : null);
        const aIn = fromEvent("in") || typed(t.actual_in), aOut = fromEvent("out") || typed(t.actual_out);
        times[stop.id] = { plannedIn: t.planned_in || "", plannedOut: t.planned_out || "",
          actualIn: aIn?.value || "", actualInSource: aIn?.source || "", actualInMs: aIn?.ms ?? null,
          actualOut: aOut?.value || "", actualOutSource: aOut?.source || "", actualOutMs: aOut?.ms ?? null,
          typedIn: t.actual_in || "", typedOut: t.actual_out || "" };
      }
      const checks = checksFor({ side, stops, times, tzOf, cut, container: c, discharge: side === "Import" ? dischargeOf(c.id) : null });
      return {
        id: c.id, containerNumber: c.container_number || "", size: c.size, type: c.type, isoCode: containerIso(c) || "", equipment: equipmentLabel(c),
        seals: containerSeals(c).map(s => s.number), packages: c.number_of_packages ?? null, packageCode: c.package_code || "",
        packageDescription: c.package_description || "", description: c.cargo_description || "", grossWeightKg: c.gross_weight_kg ?? null,
        vgmWeightKg: c.vgm_weight_kg ?? null, vgmMethod: c.vgm_method || "", weighedDuringRun: side === "Export" && method1(c),
        isDg: !!c.is_dg, dgUnNumber: c.dg_un_number || "", dgClass: c.dg_class || "", cyCutoff: c.cy_cutoff || "", vgmCutoff: c.vgm_cutoff || "",
        ownStops: !!c.own_stops, stops: c.own_stops ? stops : null, times, checks,
        planDate: c.plan_date || "", planNotes: c.plan_notes || "",
        record: { id: c.hr_id || null, driverName: c.driver_name || "", driverIdNumber: c.driver_id_number || "", truckPlate: c.truck_plate || "",
          instructions: c.instructions || "", costAmount: c.cost_amount ?? null, costCurrency: c.cost_currency || "USD", costExchangeRate: c.cost_exchange_rate ?? 1,
          costLineId: c.cost_line_id || "",
          earlierGate: !c.gate_moved && (trim(c.gate_in_at) || trim(c.gate_out_at)) ? { gateInAt: trim(c.gate_in_at), gateOutAt: trim(c.gate_out_at) } : null },
      };
    });

    // The closing times (Export: the carrier's cut-offs, typed values beside them; Import: arrival and free time).
    const deadlines = [];
    if (side === "Export") {
      const [si] = await query("SELECT si_cutoff FROM shipping_instructions WHERE shipment_id=$1", [shipmentId]).catch(() => []);
      const tile = (code, label, carrierValue, typedField, printed, note) => {
        const l = carrierValue ? limitOf(carrierValue, "carrier") : null;
        const local = l?.ms != null ? msToLocal(l.ms, portTz) : "";
        const typed = typedField ? ctrs.filter(c => trim(c[typedField])).map(c => {
          const tl = limitOf(c[typedField], "container");
          const tLocal = tl?.ms != null ? msToLocal(tl.ms, portTz) : tl?.date || "";
          const differs = !!l && (tl?.ms != null ? tl.ms !== l.ms : tl?.date !== local.slice(0, 10));
          return { containerId: c.id, containerNumber: c.container_number || "", value: tLocal, differs };
        }) : [];
        deadlines.push({ code, label, carrier: carrierValue || "", local, display: local ? fmtLocal(local) : "", typed, printed, note,
          weighed: code === "VCO" ? containers.filter(c => c.weighedDuringRun).map(c => c.containerNumber || c.id) : undefined });
      };
      tile("DCO", "Documentation", cutRaw.DCO, null, false, "For our documentation team (Shipping Instructions). Not on the trucker's order.");
      if (!cutRaw.DCO && trim(si?.si_cutoff)) {
        const d = deadlines[deadlines.length - 1];
        d.local = trim(si.si_cutoff).slice(0, 16); d.display = fmtLocal(d.local); d.fromSi = true;
      }
      const weighed = containers.filter(c => c.weighedDuringRun).map(c => c.containerNumber || "a container");
      tile("VCO", "VGM", cutRaw.VCO, "vgm_cutoff", weighed.length > 0,
        weighed.length ? `On the order for ${weighed.join(", ")} only: VGM Method 1, weighed during the run.` : "Not on the order: no container is weighed during the run (VGM Method 1).");
      tile("FCO", "CY delivery", cutRaw.FCO, "cy_cutoff", true, "On the order: every full container through the terminal gate by then.");
      tile("EFC", "Earliest delivery", cutRaw.EFC, null, !!cutRaw.EFC,
        cutRaw.EFC ? "On the order: the terminal turns away earlier containers." : "Not given by the carrier. When it is, it goes on the order.");
    } else {
      const dis = containers.map(c => dischargeOf(c.id)).find(Boolean);
      deadlines.push({ code: "ETA", label: dis?.from === "discharged" ? "Discharged" : "Arrival", local: dis ? msToLocal(dis.ms, portTz).slice(0, 10) : "",
        display: dis ? fmtLocal(msToLocal(dis.ms, portTz).slice(0, 10)) : "", printed: true, note: `At ${port || "the port of discharge"}; the terminal free time runs from here.` });
      const days = key => [...new Set(ctrs.map(c => c[key]).filter(v => v != null))];
      const dem = days("dest_free_time_days"), det = days("dest_detention_free_days");
      deadlines.push({ code: "DEM", label: "Terminal free time", display: dem.length ? `${dem.join(" / ")} days` : "", printed: dem.length > 0,
        note: dem.length ? "From discharge: the full pick-up after this costs demurrage." : "Not set on the containers (Cargo page)." });
      deadlines.push({ code: "DET", label: "Detention free days", display: det.length ? `${det.join(" / ")} days` : "", printed: det.length > 0,
        note: det.length ? "From the full pick-up: the empty return after this costs detention." : "Not set on the containers (Cargo page)." });
    }

    const vendor = service.vendor_id ? await getCustomerRow(service.vendor_id).catch(() => null) : null;
    const officeId = side === "Export" ? shipment.emo_office_id : shipment.imo_office_id;
    const [office] = officeId ? await query(`SELECT o.name AS office_name, b.name AS branch_name, b.email, b.phone
      FROM offices o LEFT JOIN branches b ON b.id = o.branch_id WHERE o.id=$1`, [officeId]) : [];
    return {
      service: { id: service.id, side, serviceType: service.service_type, status: service.status, vendorId: service.vendor_id || "", vendorName: service.vendor_name || "" },
      trucker: service.vendor_id || service.vendor_name ? { id: service.vendor_id || "", name: vendor?.companyName || service.vendor_name || "",
        email: vendor?.email || "", phone: vendor?.phone || "", inMasterData: !!vendor } : null,
      leg: leg ? { movementType: leg.movement_type || "", fromType: leg.pol_loc_type || "", toType: leg.pod_loc_type || "", from: leg.pol || "", to: leg.pod || "" } : null,
      merchantHaulage: leg?.movement_type === "Merchant's Haulage",
      bookingRef, masterBl: trim(shipment.master_bl_number), carrierCode: shipment.carrier_code || "", releaseRef: releaseRef || "",
      port: { unlocode: port, name: portRow?.name || "", timezone: portTz, utcOffset: offsetOf(portTz, refMs) },
      purposes: PURPOSES.map(p => ({ key: p.key, label: p.label, side: p.side, inOut: p.inOut })),
      deadlines, stops: shared, containers,
      office: office ? { name: office.office_name || office.branch_name || "", entity: office.branch_name || "", email: office.email || "", phone: office.phone || "" } : null,
    };
  }

  // ── Changes ────────────────────────────────────────────────────────────────────────────────────────────────────────
  // The place in a request body → the stop's place columns, or { error }.
  async function placeColumns(body = {}) {
    const p = body.place || {};
    const kind = trim(p.kind || "none");
    if (!PLACE_KINDS.includes(kind)) return { error: `place.kind must be one of ${PLACE_KINDS.join(", ")}` };
    const base = { place_kind: kind, customer_id: null, facility_id: null, place_name: "", place_address: "", unlocode: trim(p.unlocode).toUpperCase(), latitude: null, longitude: null };
    if (kind === "customer") {
      const c = p.customerId ? await getCustomerRow(p.customerId).catch(() => null) : null;
      if (!c) return { error: "Choose a customer from Master Data → Customers" };
      return { ...base, customer_id: c.id, place_name: c.companyName };
    }
    if (kind === "facility") {
      const f = p.facilityId ? await ctx.facilities.get(p.facilityId) : null;
      if (!f) return { error: "Choose a terminal or depot from Master Data → Facilities" };
      return { ...base, facility_id: f.id, place_name: f.name, unlocode: f.unlocode };
    }
    if (kind === "gps") {
      if (!(Number(p.latitude) >= -90 && Number(p.latitude) <= 90) || trim(p.latitude) === "") return { error: "latitude must be between -90 and 90" };
      if (!(Number(p.longitude) >= -180 && Number(p.longitude) <= 180) || trim(p.longitude) === "") return { error: "longitude must be between -180 and 180" };
      return { ...base, place_name: trim(p.name), latitude: Number(p.latitude), longitude: Number(p.longitude) };
    }
    if (kind === "address") {
      if (!trim(p.name)) return { error: "Give the place a name" };
      return { ...base, place_name: trim(p.name), place_address: trim(p.address) };
    }
    return base;
  }

  async function ownerCheck(serviceId, containerId) {
    if (!containerId) return null;
    const [r] = await query(`SELECT hr.own_stops FROM shipment_haulage_records hr WHERE hr.service_id=$1 AND hr.container_id=$2`, [serviceId, containerId]);
    return r?.own_stops ? null : "This container follows the shared stops: give it its own stops first";
  }

  async function addStop(service, body = {}) {
    const purpose = trim(body.purpose || "OTHER").toUpperCase();
    if (!PURPOSE[purpose]) return { error: `purpose must be one of ${PURPOSES.map(p => p.key).join(", ")}` };
    const containerId = body.containerId || null;
    const notOwn = await ownerCheck(service.id, containerId);
    if (notOwn) return { error: notOwn, status: 409 };
    const place = await placeColumns(body);
    if (place.error) return place;
    const [{ n }] = await query(`SELECT COALESCE(MAX(sequence_order),0)+1 AS n FROM haulage_stops WHERE service_id=$1 AND container_id IS NOT DISTINCT FROM $2`, [service.id, containerId]);
    const id = `HST-${uid()}`, now = nowIso();
    await query(`INSERT INTO haulage_stops (id, service_id, container_id, sequence_order, purpose, place_kind, customer_id, facility_id, place_name, place_address,
        unlocode, latitude, longitude, reference, notes, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
      [id, service.id, containerId, Number(n), purpose, place.place_kind, place.customer_id, place.facility_id, place.place_name, place.place_address,
        place.unlocode, place.latitude, place.longitude, trim(body.reference), trim(body.notes), now]);
    return { id };
  }

  async function stopOf(serviceId, stopId) {
    const [s] = await query("SELECT * FROM haulage_stops WHERE id=$1 AND service_id=$2", [stopId, serviceId]);
    return s || null;
  }

  async function updateStop(service, stopId, body = {}) {
    const s = await stopOf(service.id, stopId);
    if (!s) return { error: "Stop not found", status: 404 };
    const purpose = body.purpose !== undefined ? trim(body.purpose).toUpperCase() : s.purpose;
    if (!PURPOSE[purpose]) return { error: `purpose must be one of ${PURPOSES.map(p => p.key).join(", ")}` };
    let place = { place_kind: s.place_kind, customer_id: s.customer_id, facility_id: s.facility_id, place_name: s.place_name, place_address: s.place_address,
      unlocode: s.unlocode, latitude: s.latitude, longitude: s.longitude };
    if (body.place !== undefined) { place = await placeColumns(body); if (place.error) return place; }
    await query(`UPDATE haulage_stops SET purpose=$1, place_kind=$2, customer_id=$3, facility_id=$4, place_name=$5, place_address=$6, unlocode=$7,
        latitude=$8, longitude=$9, reference=$10, notes=$11, updated_at=$12 WHERE id=$13`,
      [purpose, place.place_kind, place.customer_id, place.facility_id, place.place_name, place.place_address, place.unlocode, place.latitude, place.longitude,
        body.reference !== undefined ? trim(body.reference) : s.reference, body.notes !== undefined ? trim(body.notes) : s.notes, nowIso(), stopId]);
    return { id: stopId };
  }

  async function removeStop(service, stopId) {
    const s = await stopOf(service.id, stopId);
    if (!s) return { error: "Stop not found", status: 404 };
    await transaction(async tx => {
      await tx.query("DELETE FROM haulage_stops WHERE id=$1", [stopId]);
      const rest = await tx.query(`SELECT id FROM haulage_stops WHERE service_id=$1 AND container_id IS NOT DISTINCT FROM $2 ORDER BY sequence_order, created_at`, [service.id, s.container_id]);
      for (let i = 0; i < rest.length; i++) await tx.query("UPDATE haulage_stops SET sequence_order=$1 WHERE id=$2", [i + 1, rest[i].id]);
    });
    return { deleted: stopId, purpose: s.purpose, placeName: s.place_name };
  }

  // ids: every stop of the shared route (containerId null) or of one container's own stops, in the new order.
  async function reorder(service, containerId, ids = []) {
    const rows = await query(`SELECT id FROM haulage_stops WHERE service_id=$1 AND container_id IS NOT DISTINCT FROM $2`, [service.id, containerId || null]);
    const have = new Set(rows.map(r => r.id));
    if (ids.length !== have.size || !ids.every(id => have.has(id))) return { error: "Send every stop of the route once, in the new order" };
    await transaction(async tx => { for (let i = 0; i < ids.length; i++) await tx.query("UPDATE haulage_stops SET sequence_order=$1, updated_at=$2 WHERE id=$3", [i + 1, nowIso(), ids[i]]); });
    return { ok: true };
  }

  async function ensureRecord(serviceId, containerId, tx = { query }) {
    const [r] = await tx.query("SELECT * FROM shipment_haulage_records WHERE service_id=$1 AND container_id=$2", [serviceId, containerId]);
    if (r) return r;
    const id = `HR-${uid()}`, now = nowIso();
    await tx.query(`INSERT INTO shipment_haulage_records (id, service_id, container_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$4)
      ON CONFLICT (service_id, container_id) DO NOTHING`, [id, serviceId, containerId, now]);
    const [row] = await tx.query("SELECT * FROM shipment_haulage_records WHERE service_id=$1 AND container_id=$2", [serviceId, containerId]);
    return row;
  }

  // planned/actual times of one container at one stop; only the fields sent change. Wall-clock "YYYY-MM-DDTHH:mm" or "".
  async function setTimes(service, containerId, stopId, body = {}) {
    const s = await stopOf(service.id, stopId);
    if (!s) return { error: "Stop not found", status: 404 };
    const [c] = await query("SELECT id FROM containers WHERE id=$1 AND shipment_id=$2", [containerId, service.shipment_id]);
    if (!c) return { error: "Container not found", status: 404 };
    const [rec] = await query("SELECT own_stops FROM shipment_haulage_records WHERE service_id=$1 AND container_id=$2", [service.id, containerId]);
    if (s.container_id ? s.container_id !== containerId : !!rec?.own_stops)
      return { error: "This stop isn't on this container's route", status: 409 };
    const fields = { plannedIn: "planned_in", plannedOut: "planned_out", actualIn: "actual_in", actualOut: "actual_out" };
    const set = {};
    for (const [k, col] of Object.entries(fields)) {
      if (body[k] === undefined) continue;
      const v = trim(body[k]).slice(0, 16);
      if (v && !LOCAL_RX.test(v)) return { error: `${k} must be a date and time (YYYY-MM-DDTHH:mm) or empty` };
      set[col] = v;
    }
    const [cur] = await query("SELECT * FROM haulage_stop_times WHERE stop_id=$1 AND container_id=$2", [stopId, containerId]);
    const row = { planned_in: "", planned_out: "", actual_in: "", actual_out: "", ...(cur || {}), ...set };
    if (row.planned_in && row.planned_out && row.planned_out < row.planned_in) return { error: "The planned out is before the planned in" };
    await query(`INSERT INTO haulage_stop_times (stop_id, container_id, planned_in, planned_out, actual_in, actual_out, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (stop_id, container_id) DO UPDATE SET planned_in=EXCLUDED.planned_in, planned_out=EXCLUDED.planned_out, actual_in=EXCLUDED.actual_in,
        actual_out=EXCLUDED.actual_out, updated_at=EXCLUDED.updated_at`,
      [stopId, containerId, row.planned_in, row.planned_out, row.actual_in, row.actual_out, nowIso()]);
    return { ok: true, changed: Object.keys(set) };
  }

  // B: own = true copies the shared stops (and this container's times at them) into the container's own stops; false drops
  // them, and it follows the shared route again (its times there were kept).
  async function setOwnStops(service, containerId, own) {
    const [c] = await query("SELECT id FROM containers WHERE id=$1 AND shipment_id=$2", [containerId, service.shipment_id]);
    if (!c) return { error: "Container not found", status: 404 };
    await transaction(async tx => {
      const rec = await ensureRecord(service.id, containerId, tx);
      if (own && !rec.own_stops) {
        const shared = await tx.query("SELECT * FROM haulage_stops WHERE service_id=$1 AND container_id IS NULL ORDER BY sequence_order, created_at", [service.id]);
        const now = nowIso();
        for (const s of shared) {
          const id = `HST-${uid()}`;
          await tx.query(`INSERT INTO haulage_stops (id, service_id, container_id, sequence_order, purpose, place_kind, customer_id, facility_id, place_name, place_address,
              unlocode, latitude, longitude, reference, notes, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
            [id, service.id, containerId, s.sequence_order, s.purpose, s.place_kind, s.customer_id, s.facility_id, s.place_name, s.place_address,
              s.unlocode, s.latitude, s.longitude, s.reference, s.notes, now]);
          await tx.query(`INSERT INTO haulage_stop_times (stop_id, container_id, planned_in, planned_out, actual_in, actual_out, updated_at)
            SELECT $1, container_id, planned_in, planned_out, actual_in, actual_out, $3 FROM haulage_stop_times WHERE stop_id=$2 AND container_id=$4`,
            [id, s.id, now, containerId]);
        }
        await tx.query("UPDATE shipment_haulage_records SET own_stops=TRUE, updated_at=$1 WHERE id=$2", [now, rec.id]);
      } else if (!own && rec.own_stops) {
        await tx.query("DELETE FROM haulage_stops WHERE service_id=$1 AND container_id=$2", [service.id, containerId]);
        await tx.query("UPDATE shipment_haulage_records SET own_stops=FALSE, updated_at=$1 WHERE id=$2", [nowIso(), rec.id]);
      }
    });
    return { ok: true };
  }

  // The usual run, when a service has no stops yet. Export: the empty depot (the carrier's release depot when its
  // confirmation names one), the door (the pick-up leg's start: the shipper's profile, or the leg's GPS point), the
  // terminal (the carrier's load terminal when named, else the leg's end port). Import: the terminal, the consignee's door,
  // the empty depot. The door's planned arrival is the plan date the service already had per container.
  async function addUsualStops(service) {
    const [{ n }] = await query("SELECT COUNT(*)::int AS n FROM haulage_stops WHERE service_id=$1", [service.id]);
    if (Number(n) > 0) return { error: "This service already has stops", status: 409 };
    const [shipment] = await query("SELECT * FROM shipments WHERE id=$1", [service.shipment_id]);
    const side = service.side === "Import" ? "Import" : "Export";
    const { leg, port } = await routeOf(shipment, side);
    const { dcsa } = await bookingOf(shipment.id);
    const facilityFor = async loc => {
      const code = trim(loc?.facility?.facilityCode).toUpperCase(), un = trim(loc?.UNLocationCode).toUpperCase();
      if (!code || !un) return null;
      const [f] = await query("SELECT id FROM facilities WHERE unlocode=$1 AND UPPER(code)=$2 ORDER BY (source='smdg') DESC LIMIT 1", [un, code]);
      return f?.id || null;
    };
    const plan = dcsa?.transportPlan || [];
    const depotLoc = (dcsa?.requestedEquipments || []).map(e => e.originEmptyContainerPickup?.depotReleaseLocation || e.emptyContainerPickup?.depotReleaseLocation).find(Boolean);
    const depotId = side === "Export" ? await facilityFor(depotLoc) : null;
    const terminalId = await facilityFor(side === "Export" ? plan[0]?.loadLocation : plan[plan.length - 1]?.dischargeLocation);
    const doorPlace = () => {
      const from = side === "Export" ? leg?.pol_loc_type : leg?.pod_loc_type;
      const end = side === "Export" ? "pol" : "pod";
      if (from === "GPS Coordinates" && hasCoords(leg?.[`${end}_latitude`], leg?.[`${end}_longitude`]))
        return { kind: "gps", name: side === "Export" ? shipment.shipper_name || "" : shipment.consignee_name || "", latitude: leg[`${end}_latitude`], longitude: leg[`${end}_longitude`] };
      const customerId = side === "Export" ? shipment.shipper_id : shipment.consignee_id;
      return customerId ? { kind: "customer", customerId } : { kind: "none", unlocode: trim(leg?.[end]) };
    };
    const terminal = () => (terminalId ? { kind: "facility", facilityId: terminalId }
      : { kind: "none", unlocode: trim(side === "Export" ? (leg?.pod || port) : (leg?.pol || port)).toUpperCase() });
    const depot = () => (depotId ? { kind: "facility", facilityId: depotId } : { kind: "none", unlocode: port });
    const plan3 = side === "Export"
      ? [["EMPTY_PICKUP", depot()], ["LOAD", doorPlace()], ["FULL_GATE_IN", terminal()]]
      : [["FULL_PICKUP", terminal()], ["UNLOAD", doorPlace()], ["EMPTY_RETURN", depot()]];
    const ids = [];
    for (const [purpose, place] of plan3) {
      const r = await addStop(service, { purpose, place });
      if (r.error) {
        // A door whose customer can't be read: the stop stays, unplaced, with its port.
        const fallback = await addStop(service, { purpose, place: { kind: "none", unlocode: port } });
        ids.push(fallback.id);
      } else ids.push(r.id);
    }
    const door = ids[1];
    const lines = await query("SELECT container_id, planned_date FROM shipment_loading_plan_lines WHERE service_id=$1", [service.id]);
    for (const l of lines) {
      const v = trim(l.planned_date);
      if (LOCAL_RX.test(v.slice(0, 16))) await setTimes(service, l.container_id, door, { plannedIn: v.slice(0, 16) });
    }
    return { ids };
  }

  // G: every old free-text waypoint becomes a stop, once (startup; idempotent through migrated_stop_id and gate_moved).
  async function migrateLegacyWaypoints() {
    const recs = await query(`SELECT DISTINCT hr.* FROM shipment_haulage_records hr JOIN shipment_haulage_waypoints w ON w.haulage_record_id = hr.id
      WHERE COALESCE(w.migrated_stop_id,'')=''`);
    let moved = 0;
    for (const rec of recs) {
      const wps = await query("SELECT * FROM shipment_haulage_waypoints WHERE haulage_record_id=$1 AND COALESCE(migrated_stop_id,'')='' ORDER BY sequence_order, created_at", [rec.id]);
      if (!wps.length) continue;
      const { stops, times } = legacyToStops(rec, wps);
      await transaction(async tx => {
        const [{ n }] = await tx.query("SELECT COALESCE(MAX(sequence_order),0) AS n FROM haulage_stops WHERE service_id=$1 AND container_id=$2", [rec.service_id, rec.container_id]);
        const now = nowIso();
        for (let i = 0; i < stops.length; i++) {
          const s = stops[i], id = `HST-${uid()}`;
          await tx.query(`INSERT INTO haulage_stops (id, service_id, container_id, sequence_order, purpose, place_kind, place_name, latitude, longitude, notes,
              legacy_waypoint_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
            [id, rec.service_id, rec.container_id, Number(n) + s.sequenceOrder, s.purpose, s.placeKind, s.placeName, s.latitude, s.longitude, s.notes, s.legacyId, now]);
          if (times[i] && !rec.gate_moved)
            await tx.query(`INSERT INTO haulage_stop_times (stop_id, container_id, actual_in, actual_out, updated_at) VALUES ($1,$2,$3,$4,$5)`,
              [id, rec.container_id, times[i].actualIn || "", times[i].actualOut || "", now]);
          await tx.query("UPDATE shipment_haulage_waypoints SET migrated_stop_id=$1 WHERE id=$2", [id, s.legacyId]);
          moved++;
        }
        await tx.query("UPDATE shipment_haulage_records SET own_stops=TRUE, gate_moved=TRUE WHERE id=$1", [rec.id]);
      });
    }
    if (moved) console.log(`Haulage stops: ${moved} old waypoint${moved === 1 ? "" : "s"} moved to stops`);
    return moved;
  }

  // C: the trucker is the service's vendor; the Trucker party of its side follows it. → "assigned" | "reassigned" | "removed" | ""
  const TRUCKER_ROLE = { Pickup: "Trucker (Pre-carriage)", Delivery: "Trucker (On-carriage)" };
  async function rescreen(shipmentId) {
    if (!ctx.sanctionsMap || ctx.sanctionsMap.size === 0) return;
    const [prev] = await query("SELECT result, overridden_at FROM shipment_screenings WHERE shipment_id=$1", [shipmentId]);
    if (!(prev?.result === "CLEAR" && prev?.overridden_at)) await ctx.screenShipmentById(shipmentId);
  }
  async function syncTruckerParty(service, actor = "") {
    const role = TRUCKER_ROLE[service.service_type];
    if (!role) return "";
    // A cancelled service's trucker isn't driving: its party goes (audit A2, TKT-4T44HU).
    if (service.status === "Cancelled") return releaseTruckerParty(service, actor, "cancelled");
    const [party] = await query("SELECT * FROM shipment_parties WHERE shipment_id=$1 AND role=$2", [service.shipment_id, role]);
    const id = trim(service.vendor_id), name = trim(service.vendor_name);
    let what = "";
    if (id && name) {
      if (!party) {
        await query(`INSERT INTO shipment_parties (id, shipment_id, role, customer_id, customer_name, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
          [`PTY-${uid()}`, service.shipment_id, role, id, name, nowIso()]);
        await ctx.logEvent(service.shipment_id, "PARTY_ASSIGNED", role, null, name, JSON.stringify({ from: `${service.service_type} service vendor` }), actor);
        what = "assigned";
      } else if (party.customer_id !== id) {
        await query("UPDATE shipment_parties SET customer_id=$1, customer_name=$2 WHERE id=$3", [id, name, party.id]);
        await ctx.logEvent(service.shipment_id, "PARTY_REASSIGNED", role, party.customer_name, name, JSON.stringify({ from: `${service.service_type} service vendor` }), actor);
        what = "reassigned";
      }
    } else if (!id && party) {
      // No vendor, or one typed as free text (no customer record): a party needs a customer, so the old one goes rather
      // than naming another trucker than the plan does (audit A1, TKT-X0EXIJ).
      await query("DELETE FROM shipment_parties WHERE id=$1", [party.id]);
      await ctx.logEvent(service.shipment_id, "PARTY_REMOVED", role, party.customer_name, null,
        JSON.stringify({ from: `${service.service_type} service vendor`, ...(name ? { typedVendor: name } : {}) }), actor);
      what = "removed";
    }
    if (what) await rescreen(service.shipment_id);
    return what;
  }
  // A service cancelled or removed releases the Trucker party it set (audit A2): only while the party is still its vendor,
  // and not when another live service of the same type has that vendor too. why: "cancelled" | "removed".
  async function releaseTruckerParty(service, actor = "", why = "removed") {
    const role = TRUCKER_ROLE[service.service_type];
    const vendorId = trim(service.vendor_id);
    if (!role || !vendorId) return "";
    const [party] = await query("SELECT * FROM shipment_parties WHERE shipment_id=$1 AND role=$2", [service.shipment_id, role]);
    if (!party || party.customer_id !== vendorId) return "";
    const [other] = await query(`SELECT 1 FROM shipment_services WHERE shipment_id=$1 AND service_type=$2 AND status<>'Cancelled' AND id<>$3 AND vendor_id=$4 LIMIT 1`,
      [service.shipment_id, service.service_type, service.id, vendorId]);
    if (other) return "";
    await query("DELETE FROM shipment_parties WHERE id=$1", [party.id]);
    await ctx.logEvent(service.shipment_id, "PARTY_REMOVED", role, party.customer_name, null, JSON.stringify({ from: `${service.service_type} service ${why}` }), actor);
    await rescreen(service.shipment_id);
    return "removed";
  }
  // …and the other way: the party set on Parties & Offices becomes the vendor of the side's Pickup/Delivery services.
  async function syncVendorFromParty(shipmentId, role, customerId, customerName, actor = "") {
    const type = Object.keys(TRUCKER_ROLE).find(t => TRUCKER_ROLE[t] === role);
    if (!type) return 0;
    const rows = await query(`UPDATE shipment_services SET vendor_id=$1, vendor_name=$2 WHERE shipment_id=$3 AND service_type=$4 AND status<>'Cancelled'
      AND (COALESCE(vendor_id,'')<>$1 OR COALESCE(vendor_name,'')<>$2) RETURNING id, vendor_name`, [customerId || "", customerName || "", shipmentId, type]);
    for (const r of rows) await ctx.logEvent(shipmentId, "SERVICE_UPDATED", "vendor_name", null, customerName || "", JSON.stringify({ serviceType: type, from: role }), actor);
    return rows.length;
  }

  return { PURPOSES, planFor, addStop, updateStop, removeStop, reorder, setTimes, setOwnStops, addUsualStops, ensureRecord,
    migrateLegacyWaypoints, fillCutOffs, syncTruckerParty, releaseTruckerParty, syncVendorFromParty, TRUCKER_ROLE, customerContacts };
};

module.exports.PURPOSES = PURPOSES;
module.exports.checksFor = checksFor;
module.exports.legacyToStops = legacyToStops;
module.exports.limitOf = limitOf;
module.exports.judge = judge;
module.exports.fmtSpan = fmtSpan;
module.exports.fmtLocal = fmtLocal;
module.exports.msToLocal = msToLocal;
module.exports.localToMs = localToMs;
