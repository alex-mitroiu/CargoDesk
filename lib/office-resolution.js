"use strict";

// Which office manages each side of a new shipment (EMO = export, SE offices; IMO = import, SI offices).
// One rule, used by the New Shipment form (through GET /api/offices/resolve), by POST /api/shipments
// when a side arrives empty, and by quote conversion:
//   1. an active office of that department AT the port (offices.unlocode = POL for EMO, POD for IMO);
//   2. otherwise one in the port's COUNTRY (offices.country_code = the first two letters of the port);
//   3. one candidate is the answer; with several, a preferred office among them breaks the tie
//      (the user's own active office, or a converted quote's office);
//   4. otherwise nobody is guessed: the result is "several" (the user chooses) or "none".
// Decided with the user 2026-11-06 (mockup f7b10beb): ports first, your own office only breaks a tie.
// Pure: callers pass the office rows, so it can be tested without a database.

const DEPT_FOR = { emo: "SE", imo: "SI" };
const SIDE_WORDS = {
  SE: { office: "export", port: "port of loading" },
  SI: { office: "import", port: "port of discharge" },
};

// Accepts DB rows (unlocode/country_code/department/is_active) or mapped offices (countryCode/isActive).
const norm = o => ({
  id: o.id, code: o.code, name: o.name,
  department: String(o.department || "").toUpperCase(),
  unlocode: String(o.unlocode || "").toUpperCase(),
  countryCode: String(o.country_code ?? o.countryCode ?? "").toUpperCase(),
  isActive: o.is_active === undefined ? o.isActive !== false : !!o.is_active,
});

/**
 * @param {object} p
 * @param {Array}  p.offices      office rows (inactive ones are ignored)
 * @param {"SE"|"SI"} p.dept
 * @param {string} p.port         UN/LOCODE (POL for SE, POD for SI)
 * @param {string|string[]} [p.prefer]  office id(s) that break a tie, first match wins
 * @param {object} [p.countryNames]      ISO2 → name, for the reason text ("in Netherlands (NL)")
 * @returns {{ status: "wait"|"none"|"auto"|"several", officeId: string|null, fitIds: string[],
 *             how: "port"|"country"|null, reason: string }}
 */
function resolveManagingOffice({ offices = [], dept, port, prefer = [], countryNames = {} }) {
  const words = SIDE_WORDS[dept];
  const p = String(port || "").trim().toUpperCase();
  if (!words) throw new Error(`Unknown department ${dept}`);
  if (!p) return { status: "wait", officeId: null, fitIds: [], how: null, reason: `Fills in from the ${words.port}` };
  const pool = offices.map(norm).filter(o => o.isActive && o.department === dept);
  const atPort = pool.filter(o => o.unlocode === p);
  const country = p.slice(0, 2);
  const inC = countryNames[country] ? `in ${countryNames[country]} (${country})` : `in country ${country}`;
  const inCountry = pool.filter(o => o.countryCode === country);
  const fits = atPort.length ? atPort : inCountry;
  const how = atPort.length ? "port" : inCountry.length ? "country" : null;
  const fitIds = fits.map(o => o.id);
  if (!fits.length) return { status: "none", officeId: null, fitIds, how, reason: `No ${words.office} office at ${p} or ${inC}` };
  const preferIds = (Array.isArray(prefer) ? prefer : [prefer]).filter(Boolean);
  const one = fits.length === 1 ? fits[0] : fits.find(o => preferIds.includes(o.id)) || null;
  if (!one) return { status: "several", officeId: null, fitIds, how, reason: `${fits.length} ${words.office} offices ${how === "port" ? `at ${p}` : inC} fit: choose one` };
  const tieBroken = fits.length > 1;
  const reason = how === "port"
    ? `At the ${words.port}, ${p}${tieBroken ? ", and your office" : ""}`
    : tieBroken ? `Your office, one of ${fits.length} ${inC}` : `The only ${words.office} office ${inC}`;
  return { status: "auto", officeId: one.id, fitIds, how, reason };
}

/** Both sides at once: { emo, imo }, each as resolveManagingOffice returns. */
function resolveManagingOffices({ offices = [], pol, pod, prefer = [], countryNames = {} }) {
  return {
    emo: resolveManagingOffice({ offices, dept: DEPT_FOR.emo, port: pol, prefer, countryNames }),
    imo: resolveManagingOffice({ offices, dept: DEPT_FOR.imo, port: pod, prefer, countryNames }),
  };
}

module.exports = { resolveManagingOffice, resolveManagingOffices };
