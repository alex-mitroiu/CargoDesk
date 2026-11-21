"use strict";
// The carrier's haulage at a door, for the DCSA booking (2026-11-20, the user's rule, ARCHITECTURE.md §8.55).
//
// Only when the route has a Carrier's Haulage leg that STARTS at a Door (the pick-up, DR-CY / DR-PT) or ENDS at one (the
// delivery, CY-DR / PT-DR) does the booking say Store Door (SD) and tell the carrier where to go: the address and a contact
// from the customer profile of the shipment's shipper (pick-up) or consignee (delivery), whose name and details the party
// carries too. A leg from or to GPS Coordinates is a door as well (the user, 2026-11-20): the carrier goes to the leg's
// coordinates. A Merchant's Haulage leg, or a carrier's leg from a port or a container yard, is CY: the carrier gets no
// address (the trucker we choose gets it through the Pickup / Delivery service). The shipment's Service Type field no
// longer decides it. Pure: routes/edi.js reads the rows and the profiles.

const { zoneInfo } = require("./timezones");

const CH = "Carrier's Haulage";
const DOOR = "Door";
const GPS = "GPS Coordinates";
const DOOR_TYPES = new Set([DOOR, GPS]);
const UNLOCODE = /^[A-Z]{2}[A-Z2-9]{3}$/;
const EMAIL = /^.+@\S+$/;
const trim = s => String(s ?? "").trim();
// Cut to the spec's length, and never end on a space (DCSA's ^\S(?:.*\S)?$ patterns).
const cut = (s, n) => trim(trim(s).slice(0, n));

// shipment_legs rows (snake_case, route order) → { pickUp, delivery }: the carrier's leg from a door (or GPS point), the
// carrier's leg to one.
function doorLegs(legs = []) {
  const pickUp = legs.find(l => l.leg_type === "Pick-up" && l.movement_type === CH && DOOR_TYPES.has(l.pol_loc_type)) || null;
  const delivery = legs.find(l => l.leg_type === "Delivery" && l.movement_type === CH && DOOR_TYPES.has(l.pod_loc_type)) || null;
  return { pickUp, delivery };
}

// The door end of a door leg: its UN/LOCODE, or its coordinates when the leg is at GPS Coordinates.
function doorPoint(leg, side) {
  const end = side === "origin" ? "pol" : "pod";
  const gps = leg?.[`${end}_loc_type`] === GPS;
  return { gps, code: gps ? "" : trim(leg?.[end]).toUpperCase(),
    latitude: gps ? leg[`${end}_latitude`] : null, longitude: gps ? leg[`${end}_longitude`] : null };
}

// A customer profile (mapCustomer's shape) → DCSA Address (street, city and country are required), or null. Address line 2
// joins the street when both fit its 70 characters; otherwise the full lines go as addressLines too, so nothing is lost.
function dcsaAddress(c) {
  const street = trim(c?.address1), extra = trim(c?.address2), city = trim(c?.city), country = trim(c?.countryIso2).toUpperCase();
  if (!street || !city || !/^[A-Z]{2}$/.test(country)) return null;
  const joined = extra ? `${street}, ${extra}` : street;
  const post = trim(c.postalCode), region = trim(c.state);
  return {
    address: {
      street: cut(joined.length <= 70 ? joined : street, 70),
      ...(post && post.length <= 10 ? { postCode: post } : {}),
      city: cut(city, 35),
      ...(region ? { stateRegion: cut(region, 65) } : {}),
      countryCode: country,
    },
    ...(extra && joined.length > 70 ? { addressLines: [street, extra, trim(`${post} ${city}`), region, country].filter(Boolean).map(l => cut(l, 250)) } : {}),
  };
}

// What the profile lacks for the carrier to find the door, in words ([] = nothing). A classified location is found by its
// GPS coordinates alone (the profile's own rule: "pickup/delivery can only be identified by GPS coordinates").
function addressGaps(c) {
  if (c?.classifiedLocation && hasCoords(c.latitude, c.longitude)) return [];
  return [!trim(c?.address1) && "street", !trim(c?.city) && "city", !/^[A-Z]{2}$/.test(trim(c?.countryIso2).toUpperCase()) && "country"].filter(Boolean);
}

// The person the carrier calls at the door: an Operations contact (the primary one first), else the primary contact, else
// the first with a phone or e-mail; with no such person, the company's own phone or e-mail under its name. → DCSA
// PartyContactDetail ({ name, phone?, email? }, name + phone or e-mail), or null.
function doorContact(customer, contacts = []) {
  const shape = (name, phone, email) => {
    const n = cut(name, 35), p = cut(phone, 30), e = EMAIL.test(trim(email)) && trim(email).length <= 100 ? trim(email) : "";
    return n && (p || e) ? { name: n, ...(p ? { phone: p } : {}), ...(e ? { email: e } : {}) } : null;
  };
  const people = (contacts || []).map(c => ({ c, d: shape(c.name, c.phone, c.email) })).filter(x => x.d);
  const ops = people.filter(x => x.c.department === "Operations");
  const person = ops.find(x => x.c.isPrimary) || ops[0] || people.find(x => x.c.isPrimary) || people[0];
  return person ? person.d : shape(customer?.companyName, customer?.phone, customer?.email);
}

const hasCoords = (lat, lng) => lat != null && lng != null && lat !== "" && lng !== "" && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
const geo = (lat, lng) => ({ geoCoordinate: { latitude: Number(lat).toFixed(6).slice(0, 10), longitude: Number(lng).toFixed(6).slice(0, 11) } });

// The door as a DCSA Location (also a ContainerPositioningLocation: the same fields): whose premises, then where. A leg at
// GPS Coordinates is the leg's point alone (the profile's address may be another place, and every way of naming a
// location must point to the same one). Otherwise the profile's address, the leg's UN/LOCODE, and the coordinates of a
// classified location. point = doorPoint(leg, side).
function doorLocation(customer, point = {}) {
  const name = cut(customer?.companyName, 100) ? { locationName: cut(customer.companyName, 100) } : {};
  if (point.gps && hasCoords(point.latitude, point.longitude)) return { ...name, ...geo(point.latitude, point.longitude) };
  const where = dcsaAddress(customer);
  const unlocode = trim(point.code).toUpperCase();
  return {
    ...name,
    ...(where || {}),
    ...(UNLOCODE.test(unlocode) ? { UNLocationCode: unlocode } : {}),
    ...(customer?.classifiedLocation && hasCoords(customer.latitude, customer.longitude) ? geo(customer.latitude, customer.longitude) : {}),
  };
}

// "2026-11-24T09:00" at the door, in its time zone → "2026-11-24T09:00:00+01:00" (RFC 3339 with the door's own offset that
// day), or null without a time or a zone. A planned date with no time is not sent: a time would be made up.
function localDateTime(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(trim(local));
  if (!m || !tz) return null;
  const offsetAt = at => {
    const o = /UTC([+-])(\d{2}):(\d{2})/.exec(zoneInfo(tz, new Date(at))?.utcOffset || "");
    return o ? (o[1] === "-" ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3])) : null;
  };
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let off = offsetAt(wall);
  if (off == null) return null;
  off = offsetAt(wall - off * 60000) ?? off;
  const a = Math.abs(off), pad = n => String(n).padStart(2, "0");
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${off < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// The Loading service's plan → the earliest planned time per equipment line (the key routes/edi.js groups containers by:
// the ISO code, else size+type), as the door's local date-time. Lines with no time are skipped.
function positioningTimes(planLines = [], containers = [], tz) {
  const keyOf = new Map(containers.map(c => [c.id, c.iso_equipment_code || `${c.size}${c.type}`]));
  const earliest = {};
  for (const l of planLines) {
    const key = keyOf.get(l.container_id);
    if (!key || !/T\d{2}:\d{2}/.test(trim(l.planned_date))) continue;
    if (!earliest[key] || trim(l.planned_date) < earliest[key]) earliest[key] = trim(l.planned_date);
  }
  return Object.fromEntries(Object.entries(earliest).map(([k, v]) => [k, localDateTime(v, tz)]).filter(([, v]) => v));
}

module.exports = { doorLegs, doorPoint, dcsaAddress, addressGaps, doorContact, doorLocation, localDateTime, positioningTimes, CH, DOOR, GPS };
