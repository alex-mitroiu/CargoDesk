"use strict";
const express = require("express");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { readSecret } = require("./lib/dockerSecret");

const PORT = process.env.CONTRACT_SERVICE_PORT || 3004;
const SERVICE_SECRET_DEV_DEFAULT = "cargoDesk-dev-contract-service-secret-do-not-use-in-prod";
const SERVICE_SECRET = readSecret("CONTRACT_SERVICE_SECRET", SERVICE_SECRET_DEV_DEFAULT);
if (SERVICE_SECRET === SERVICE_SECRET_DEV_DEFAULT)
  console.warn("⚠  CONTRACT_SERVICE_SECRET not set (checked CONTRACT_SERVICE_SECRET_FILE, then CONTRACT_SERVICE_SECRET) — using insecure dev default. Set it (and the same value in the monolith's own env) before deploying.");

const app = express();
const db = new DatabaseSync(path.join(__dirname, "contracts.db"));
app.use(express.json({ limit: "5mb" }));

const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const ok = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });

// Straight port of the monolith's contracts/contract_legs/contract_rates/contract_routings
// schema (server.js) — same columns, same `TEXT DEFAULT ''` "unset means blank string, not
// NULL" convention throughout, including the multi-routing routing_id shape. This service does
// NOT own shipments/allocations/linked_ports/entity_events — see the route comments below for
// exactly how each of those three real cross-service dependencies is handled instead of
// silently assumed away.
db.exec(`
  PRAGMA journal_mode=WAL;

  CREATE TABLE IF NOT EXISTS contracts (
    id               TEXT PRIMARY KEY,
    contract_number  TEXT DEFAULT '',
    contract_ref     TEXT DEFAULT '',
    carrier_code     TEXT DEFAULT '',
    named_account_id TEXT DEFAULT '',
    named_account    TEXT DEFAULT '',
    movement_type    TEXT DEFAULT 'FCL',
    container_types  TEXT DEFAULT '[]',
    dg_allowed       INTEGER DEFAULT 0,
    imdg_classes     TEXT DEFAULT '[]',
    valid_from       TEXT DEFAULT '',
    valid_to         TEXT DEFAULT '',
    currency         TEXT DEFAULT 'USD',
    status           TEXT DEFAULT 'Active',
    notes            TEXT DEFAULT '',
    created_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contract_legs (
    id                     TEXT PRIMARY KEY,
    contract_id            TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    leg_order              INTEGER DEFAULT 0,
    pol                    TEXT DEFAULT '',
    pol_name               TEXT DEFAULT '',
    pod                    TEXT DEFAULT '',
    pod_name               TEXT DEFAULT '',
    transit_days           INTEGER DEFAULT 0,
    vessel_service         TEXT DEFAULT '',
    pol_linked_allowed     INTEGER DEFAULT 0,
    pod_linked_allowed     INTEGER DEFAULT 0,
    pol_carrier_haulage    INTEGER DEFAULT 0,
    pod_carrier_haulage    INTEGER DEFAULT 0,
    pol_haulage_locations  TEXT DEFAULT '',
    pod_haulage_locations  TEXT DEFAULT '',
    pol_loc_type           TEXT DEFAULT 'Terminal',
    pod_loc_type           TEXT DEFAULT 'Terminal',
    routing_id             TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_contract_legs_contract ON contract_legs(contract_id);

  CREATE TABLE IF NOT EXISTS contract_rates (
    id             TEXT PRIMARY KEY,
    contract_id    TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    service_code   TEXT DEFAULT '',
    description    TEXT DEFAULT '',
    amount         REAL DEFAULT 0,
    currency       TEXT DEFAULT 'USD',
    amount_usd     REAL DEFAULT 0,
    unit           TEXT DEFAULT 'per_container',
    container_type TEXT DEFAULT '',
    sort_order     INTEGER DEFAULT 0,
    notes          TEXT DEFAULT '',
    valid_from     TEXT DEFAULT '',
    valid_to       TEXT DEFAULT '',
    routing_id     TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_contract_rates_contract ON contract_rates(contract_id);

  CREATE TABLE IF NOT EXISTS contract_routings (
    id           TEXT PRIMARY KEY,
    contract_id  TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
    name         TEXT DEFAULT '',
    sort_order   INTEGER DEFAULT 0,
    transit_days INTEGER DEFAULT 0,
    notes        TEXT DEFAULT '',
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_contract_routings_contract ON contract_routings(contract_id);
`);

// ─── Mappers (duplicated from lib/mappers.js — see dockerSecret.js's own comment on why) ───────

const mapContract = r => ({
  id: r.id, contractNumber: r.contract_number, contractRef: r.contract_ref || "",
  carrierCode: r.carrier_code, namedAccountId: r.named_account_id, namedAccount: r.named_account,
  movementType: r.movement_type, containerTypes: JSON.parse(r.container_types || "[]"),
  dgAllowed: !!r.dg_allowed, imdgClasses: JSON.parse(r.imdg_classes || "[]"),
  validFrom: r.valid_from, validTo: r.valid_to, currency: r.currency, status: r.status,
  notes: r.notes, createdAt: r.created_at,
});
const mapLeg = r => ({
  id: r.id, contractId: r.contract_id, routingId: r.routing_id || "", legOrder: r.leg_order,
  pol: r.pol, polName: r.pol_name, pod: r.pod, podName: r.pod_name,
  transitDays: r.transit_days, vesselService: r.vessel_service,
  polLinkedAllowed: r.pol_linked_allowed === 1, podLinkedAllowed: r.pod_linked_allowed === 1,
  polCarrierHaulage: r.pol_carrier_haulage === 1, podCarrierHaulage: r.pod_carrier_haulage === 1,
  polHaulageLocations: r.pol_haulage_locations || "", podHaulageLocations: r.pod_haulage_locations || "",
  polLocType: r.pol_loc_type || (r.pol_carrier_haulage === 1 ? "Door" : "Terminal"),
  podLocType: r.pod_loc_type || (r.pod_carrier_haulage === 1 ? "Door" : "Terminal"),
});
const mapRate = r => ({
  id: r.id, contractId: r.contract_id, routingId: r.routing_id || "", serviceCode: r.service_code,
  description: r.description, amount: r.amount, currency: r.currency, amountUsd: r.amount_usd,
  unit: r.unit, containerType: r.container_type, sortOrder: r.sort_order, notes: r.notes,
  validFrom: r.valid_from || "", validTo: r.valid_to || "",
});
const mapContractRouting = r => ({
  id: r.id, contractId: r.contract_id, name: r.name || "", sortOrder: r.sort_order,
  transitDays: r.transit_days, notes: r.notes || "", createdAt: r.created_at,
});

// ─── FX rates (frankfurter.app) — self-contained copy of the monolith's own getFxRates/toUsd ──
// The monolith's version reads its refresh interval from app_settings (admin-configurable); this
// service has no such settings store, so it uses a fixed 24h cache — a reasonable first-pass
// simplification (see the plan's own "Explicitly out of scope" list), not a behavior this
// service's callers depend on matching the monolith's interval exactly.
let fxCache = { rates: {}, ts: 0 };
async function getFxRates() {
  if (Date.now() - fxCache.ts < 86400000 && Object.keys(fxCache.rates).length) return fxCache.rates;
  try {
    const r = await fetch("https://api.frankfurter.app/latest?from=USD");
    const d = await r.json();
    fxCache = { rates: d.rates || {}, ts: Date.now() };
  } catch (e) { console.warn("FX fetch failed:", e.message); }
  return fxCache.rates;
}
function roundCents(n) { return Number(Math.round(Number(n + "e2")) + "e-2"); }
async function toUsd(amount, currency) {
  if (!currency || currency === "USD") return roundCents(amount);
  const rates = await getFxRates();
  const rate = rates[currency];
  return rate ? roundCents(amount / rate) : roundCents(amount);
}

// ─── Leg matching — ported from server.js's findMatchingContractLegs ───────────────────────────
// One real difference from the monolith original: `linkedPortCodes(code)` there queries
// linked_ports directly (monolith MDM data this service does NOT own). Here it's passed in as a
// plain function built from whatever pairs the caller (routes/contracts.js's remote branch, which
// DOES own that table) supplies on the request — see the /internal/contracts/match route below.
// Defaults to "no linked ports" so a caller that omits it degrades to exact-match only, never a
// crash. Everything else is an unmodified port — critically, the lookup is still keyed off each
// LEG's own pol/pod (linkedPortCodes(leg.pol)/(leg.pod)), not the query's pol/pod, exactly like
// the original — a contract's legs can each have a different port needing its own expansion.
const findMatchingContractLegs = (legs, { pol, pod, needsPolHaulage, needsPodHaulage, pkuLocation = "", delLocation = "", linkedPortCodes = () => [] }) => {
  if (legs.length === 0) return [];
  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const pkuU = pkuLocation.toUpperCase(), delU = delLocation.toUpperCase();

  const polMatches = leg => (leg.pol_linked_allowed ? [leg.pol, ...linkedPortCodes(leg.pol)] : [leg.pol]).includes(polU);
  const podMatches = leg => (leg.pod_linked_allowed ? [leg.pod, ...linkedPortCodes(leg.pod)] : [leg.pod]).includes(podU);

  const haulageOk = (first, last) => {
    if (needsPolHaulage) {
      if (!first.pol_carrier_haulage) return false;
      if (first.pol_haulage_locations) {
        const allowed = first.pol_haulage_locations.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        if (allowed.length > 0 && pkuU && !allowed.includes(pkuU)) return false;
      }
    }
    if (needsPodHaulage) {
      if (!last.pod_carrier_haulage) return false;
      if (last.pod_haulage_locations) {
        const allowed = last.pod_haulage_locations.split(/[\s,]+/).map(s => s.trim().toUpperCase()).filter(Boolean);
        if (allowed.length > 0 && delU && !allowed.includes(delU)) return false;
      }
    }
    return true;
  };

  const groups = new Map();
  for (const leg of legs) {
    const key = leg.routing_id || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(leg);
  }

  const matches = [];
  for (const [routingId, groupLegs] of groups) {
    const ordered = [...groupLegs].sort((a, b) => a.leg_order - b.leg_order);
    for (let i = 0; i < ordered.length; i++) {
      if (!polMatches(ordered[i])) continue;
      let j = i;
      for (;;) {
        if (podMatches(ordered[j])) {
          if (haulageOk(ordered[i], ordered[j])) {
            matches.push({ routingId, legs: ordered.slice(i, j + 1), firstLeg: ordered[i], lastLeg: ordered[j],
              matchKind: (ordered[i].pol === polU && ordered[j].pod === podU) ? "exact" : "linked" });
          }
          break;
        }
        const next = ordered[j + 1];
        if (!next || ordered[j].pod !== next.pol) break;
        j++;
      }
    }
  }
  return matches;
};

// ─── Contract statuses (mirrors routes/contracts.js's own CONTRACT_STATUSES) ───────────────────
const CONTRACT_STATUSES = ["Active", "Draft", "Expired", "On Hold"];

// ─── Save helpers — ported from routes/contracts.js, unchanged in shape ────────────────────────

function saveRoutings(contractId, routings) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM contract_routings WHERE contract_id=?").run(contractId);
    const ins = db.prepare(`INSERT INTO contract_routings (id,contract_id,name,sort_order,transit_days,notes,created_at)
      VALUES (?,?,?,?,?,?,?)`);
    const now = new Date().toISOString();
    const ids = routings.map((r, i) => {
      const id = `CRTG-${uid()}`;
      ins.run(id, contractId, r.name || "", i, r.transitDays || 0, r.notes || "", now);
      return id;
    });
    db.exec("COMMIT");
    return ids;
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

const resolveRoutingId = (item, routingIds, oldNameById = {}, newIndexByName = {}) => {
  if (Number.isInteger(item.routingIndex) && routingIds[item.routingIndex]) return routingIds[item.routingIndex];
  if (item.routingId && oldNameById[item.routingId] != null) {
    const idx = newIndexByName[oldNameById[item.routingId]];
    if (idx != null && routingIds[idx]) return routingIds[idx];
  }
  return "";
};

function saveLegs(contractId, legs, routingIds = [], oldNameById = {}, newIndexByName = {}) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM contract_legs WHERE contract_id=?").run(contractId);
    const ins = db.prepare(`INSERT INTO contract_legs (id,contract_id,leg_order,pol,pol_name,pod,pod_name,transit_days,vessel_service,pol_linked_allowed,pod_linked_allowed,pol_carrier_haulage,pod_carrier_haulage,pol_haulage_locations,pod_haulage_locations,pol_loc_type,pod_loc_type,routing_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    legs.forEach((l, i) => {
      ins.run(`CLEG-${uid()}`, contractId, i, l.pol||"", l.polName||"", l.pod||"", l.podName||"", l.transitDays||0, l.vesselService||"",
           l.polLinkedAllowed ? 1 : 0, l.podLinkedAllowed ? 1 : 0,
           l.polCarrierHaulage ? 1 : 0, l.podCarrierHaulage ? 1 : 0,
           l.polHaulageLocations || "", l.podHaulageLocations || "",
           l.polLocType || "Terminal", l.podLocType || "Terminal", resolveRoutingId(l, routingIds, oldNameById, newIndexByName));
    });
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

async function saveRates(contractId, rates, routingIds = [], oldNameById = {}, newIndexByName = {}) {
  const resolved = [];
  for (const r of rates) resolved.push({ ...r, usd: await toUsd(r.amount || 0, r.currency || "USD") });
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM contract_rates WHERE contract_id=?").run(contractId);
    const ins = db.prepare(`INSERT INTO contract_rates (id,contract_id,service_code,description,amount,currency,amount_usd,unit,container_type,sort_order,notes,valid_from,valid_to,routing_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    resolved.forEach((r, i) => {
      ins.run(`RATE-${uid()}`, contractId, r.serviceCode||"", r.description||"", r.amount||0, r.currency||"USD", r.usd,
           r.unit||"per_container", r.containerType||"", i, r.notes||"", r.validFrom||"", r.validTo||"", resolveRoutingId(r, routingIds, oldNameById, newIndexByName));
    });
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// ─── Auto-expire (mirrors routes/contracts.js's own expireStaleContracts) ──────────────────────
function expireStaleContracts() {
  const today = new Date().toISOString().slice(0, 10);
  const stale = db.prepare("SELECT id FROM contracts WHERE status='Active' AND valid_to != '' AND valid_to < ?").all(today);
  if (stale.length === 0) return;
  const update = db.prepare("UPDATE contracts SET status='Expired' WHERE id=?");
  for (const c of stale) update.run(c.id);
}
expireStaleContracts();
const expireSweep = setInterval(expireStaleContracts, 60 * 60 * 1000);
expireSweep.unref?.();

// Public liveness check — no secret required, mirrors the other two services' own GET /health.
app.get("/health", (req, res) => ok(res, { status: "ok", service: "contract-management", uptime: process.uptime() }));

// Everything else under /internal/* requires the shared service-to-service secret. This service
// is never called from the browser — only from the monolith's own route handlers.
app.use("/internal", (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== SERVICE_SECRET) return err(res, "Unauthorized", 401);
  next();
});

// ─── Routes ─────────────────────────────────────────────────────────────────────────────────────

// NOTE on what's deliberately NOT enforced here, and why: this service owns contracts/legs/
// rates/routings only. It does not own shipments/allocations (so the "referenced by a shipment/
// allocation" delete and withdraw guards routes/contracts.js's local path already enforces are
// the CALLER's responsibility to replicate before calling this route — see routes/contracts.js's
// remote branch) or entity_events (so amendment/rate-diff audit logging is out of scope for this
// pass entirely, per the plan).

app.get("/internal/contracts/match", (req, res) => {
  const { pol = "", pod = "", etd = "", crd = "", carrier = "",
          needsPolHaulage = "", needsPodHaulage = "", pkuLocation = "", delLocation = "",
          linkedPorts = "" } = req.query;
  if (!pol || !pod) return ok(res, []);

  const polU = pol.toUpperCase(), podU = pod.toUpperCase();
  const dateRef = crd || etd;
  const needsPol = needsPolHaulage === "1" || needsPolHaulage === "true";
  const needsPod = needsPodHaulage === "1" || needsPodHaulage === "true";
  // linkedPorts is a JSON-encoded array of [primaryCode, linkedCode] pairs — the monolith's own
  // linked_ports table content, resolved by the CALLER (it owns that table) and handed over
  // wholesale rather than this service reaching back into a database it has no business
  // touching. Small table (port equivalence pairs, not per-port-code data) so passing it
  // whole on every match call is cheap. Reconstructed into the same linkedPortCodes(code)
  // shape the ported matching function expects — see its own comment on why the lookup must
  // stay keyed by each LEG's own port, not the query's.
  let linkedPairs = [];
  try { linkedPairs = linkedPorts ? JSON.parse(linkedPorts) : []; } catch { linkedPairs = []; }
  const linkedPortCodes = code => linkedPairs
    .filter(([a, b]) => a === code || b === code)
    .map(([a, b]) => (a === code ? b : a));

  const clauses = ["c.status='Active'"];
  const params = [];
  if (dateRef) { clauses.push("c.valid_from<=? AND c.valid_to>=?"); params.push(dateRef, dateRef); }
  if (carrier.trim()) { clauses.push("c.carrier_code=?"); params.push(carrier.trim().toUpperCase()); }

  const candidates = db.prepare(`SELECT c.* FROM contracts c WHERE ${clauses.join(" AND ")} ORDER BY c.valid_from DESC LIMIT 50`).all(...params);

  const results = [];
  for (const c of candidates) {
    const legs = db.prepare("SELECT * FROM contract_legs WHERE contract_id=? ORDER BY leg_order").all(c.id);
    const matches = findMatchingContractLegs(legs, { pol, pod, needsPolHaulage: needsPol, needsPodHaulage: needsPod, pkuLocation, delLocation, linkedPortCodes });
    if (matches.length === 0) continue;
    const routingsById = Object.fromEntries(
      db.prepare("SELECT * FROM contract_routings WHERE contract_id=?").all(c.id).map(r => [r.id, mapContractRouting(r)])
    );
    for (const match of matches) {
      results.push({ ...mapContract(c), legs: legs.map(mapLeg), matchedLegs: match.legs.map(mapLeg),
        matchKind: match.matchKind, routingId: match.routingId,
        routing: match.routingId ? (routingsById[match.routingId] || null) : null,
        linkedPolVia: match.firstLeg.pol !== polU ? match.firstLeg.pol : null,
        linkedPodVia: match.lastLeg.pod !== podU ? match.lastLeg.pod : null });
    }
  }

  if (results.length > 0) {
    const ids = [...new Set(results.map(r => r.id))];
    const allRates = db.prepare(`SELECT * FROM contract_rates WHERE contract_id IN (${ids.map(() => "?").join(",")}) ORDER BY sort_order`).all(...ids);
    const ratesByContract = {};
    for (const r of allRates) (ratesByContract[r.contract_id] = ratesByContract[r.contract_id] || []).push(r);
    for (const result of results) {
      const contractRates = ratesByContract[result.id] || [];
      result.rates = contractRates.filter(r => r.routing_id === result.routingId || !r.routing_id).map(mapRate);
    }
  }
  ok(res, results);
});

app.get("/internal/contracts", (req, res) => {
  const { search = "", carrier = "", status = "", dg = "", asOf = "", containerType = "",
          pol = "", pod = "", polOrigin = "", podDestination = "", routingTerm = "",
          namedAccount = "", limit = "50", offset = "0" } = req.query;
  const lim = Math.min(parseInt(limit) || 50, 200), off = parseInt(offset) || 0;
  const clauses = [], params = [];
  if (carrier.trim()) {
    const codes = carrier.split(",").map(c => c.trim().toUpperCase()).filter(Boolean);
    if (codes.length === 1) { clauses.push("c.carrier_code LIKE ?"); params.push(`%${codes[0]}%`); }
    else { clauses.push(`c.carrier_code IN (${codes.map(() => "?").join(",")})`); params.push(...codes); }
  }
  if (status.trim()) { clauses.push("c.status=?"); params.push(status.trim()); }
  if (dg !== "") { clauses.push("c.dg_allowed=?"); params.push(dg === "1" ? 1 : 0); }
  if (asOf.trim()) { clauses.push("c.valid_from<=? AND c.valid_to>=?"); params.push(asOf, asOf); }
  if (containerType.trim()) { clauses.push("c.container_types LIKE ?"); params.push(`%"${containerType.trim()}"%`); }
  if (namedAccount.trim()) { clauses.push("(c.named_account LIKE ? OR c.named_account_id LIKE ?)"); const n = `%${namedAccount.trim()}%`; params.push(n, n); }
  if (pol.trim()) { clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND UPPER(l.pol)=UPPER(?))"); params.push(pol.trim()); }
  if (pod.trim()) { clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND UPPER(l.pod)=UPPER(?))"); params.push(pod.trim()); }
  if (polOrigin.trim()) {
    clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pol_carrier_haulage=1 AND (COALESCE(l.pol_haulage_locations,'')='' OR UPPER(' '||l.pol_haulage_locations||' ') LIKE UPPER('% '||?||' %')))");
    params.push(polOrigin.trim());
  }
  if (podDestination.trim()) {
    clauses.push("EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pod_carrier_haulage=1 AND (COALESCE(l.pod_haulage_locations,'')='' OR UPPER(' '||l.pod_haulage_locations||' ') LIKE UPPER('% '||?||' %')))");
    params.push(podDestination.trim());
  }
  if (routingTerm.trim()) {
    const hasPol = "EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pol_carrier_haulage=1)";
    const hasPod = "EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND l.pod_carrier_haulage=1)";
    if (routingTerm === "P2P") clauses.push(`NOT ${hasPol} AND NOT ${hasPod}`);
    if (["D2P","CY2P"].includes(routingTerm)) clauses.push(`${hasPol} AND NOT ${hasPod}`);
    if (["P2D","P2CY"].includes(routingTerm)) clauses.push(`NOT ${hasPol} AND ${hasPod}`);
    if (["D2D","D2CY","CY2D","CY2CY"].includes(routingTerm)) clauses.push(`${hasPol} AND ${hasPod}`);
  }
  if (search.trim()) {
    clauses.push(`(c.contract_number LIKE ? OR c.contract_ref LIKE ? OR c.named_account LIKE ? OR c.carrier_code LIKE ? OR EXISTS(SELECT 1 FROM contract_legs l WHERE l.contract_id=c.id AND (l.pol LIKE ? OR l.pod LIKE ? OR l.pol_name LIKE ? OR l.pod_name LIKE ?)))`);
    const s = `%${search.trim()}%`; params.push(s, s, s, s, s, s, s, s);
  }
  const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM contracts c ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT c.* FROM contracts c ${where} ORDER BY c.valid_from DESC, c.created_at DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
  const ids = rows.map(r => r.id);
  let legsMap = {}, ratesMap = {}, routingsMap = {};
  if (ids.length > 0) {
    const ph = ids.map(() => "?").join(",");
    db.prepare(`SELECT * FROM contract_legs WHERE contract_id IN (${ph}) ORDER BY leg_order`).all(...ids)
      .forEach(l => { (legsMap[l.contract_id] = legsMap[l.contract_id] || []).push(mapLeg(l)); });
    db.prepare(`SELECT * FROM contract_rates WHERE contract_id IN (${ph}) ORDER BY sort_order`).all(...ids)
      .forEach(r => { (ratesMap[r.contract_id] = ratesMap[r.contract_id] || []).push(mapRate(r)); });
    db.prepare(`SELECT * FROM contract_routings WHERE contract_id IN (${ph}) ORDER BY sort_order`).all(...ids)
      .forEach(rt => { (routingsMap[rt.contract_id] = routingsMap[rt.contract_id] || []).push(mapContractRouting(rt)); });
  }
  ok(res, { results: rows.map(r => ({ ...mapContract(r), legs: legsMap[r.id] || [], rates: ratesMap[r.id] || [], routings: routingsMap[r.id] || [] })), total, limit: lim, offset: off });
});

app.get("/internal/contracts/search", (req, res) => {
  const { q = "", carrier = "", asOf = "" } = req.query;
  const clauses = [], params = [];
  if (q.trim()) { clauses.push(`(c.contract_number LIKE ? OR c.contract_ref LIKE ? OR c.carrier_code LIKE ? OR c.named_account LIKE ?)`); const s = `%${q.trim()}%`; params.push(s, s, s, s); }
  if (carrier.trim()) { clauses.push("c.carrier_code=?"); params.push(carrier.trim()); }
  if (asOf.trim()) { clauses.push("c.valid_from<=? AND c.valid_to>=?"); params.push(asOf, asOf); }
  clauses.push("c.status='Active'");
  const where = "WHERE " + clauses.join(" AND ");
  const rows = db.prepare(`SELECT c.* FROM contracts c ${where} ORDER BY c.contract_number LIMIT 10`).all(...params);
  ok(res, rows.map(mapContract));
});

app.get("/internal/contracts/expiring", (req, res) => {
  const days = Math.max(1, parseInt(req.query.days, 10) || 14);
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare(`SELECT id, contract_number, carrier_code, valid_to FROM contracts
    WHERE status IN ('Active','Expired') AND valid_to != '' AND valid_to <= ? ORDER BY valid_to ASC LIMIT 20`).all(horizon);
  ok(res, rows.map(r => ({ id: r.id, contractNumber: r.contract_number, carrierCode: r.carrier_code, validTo: r.valid_to, expired: r.valid_to < today })));
});

app.get("/internal/contracts/revalidate", (req, res) => {
  const { ref = "" } = req.query;
  if (!ref.trim()) return ok(res, []);
  const rows = db.prepare("SELECT * FROM contracts WHERE LOWER(contract_number) = LOWER(?) AND status = 'Active' ORDER BY valid_from DESC").all(ref.trim());
  ok(res, rows.map(mapContract));
});

app.get("/internal/contracts/:id", (req, res) => {
  const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
  if (!c) return err(res, "Not found", 404);
  const legs = db.prepare("SELECT * FROM contract_legs WHERE contract_id=? ORDER BY leg_order").all(req.params.id);
  const rates = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
  const routings = db.prepare("SELECT * FROM contract_routings WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
  ok(res, { ...mapContract(c), legs: legs.map(mapLeg), rates: rates.map(mapRate), routings: routings.map(mapContractRouting) });
});

app.post("/internal/contracts", async (req, res) => {
  const { contractNumber = "", contractRef = "", carrierCode = "", namedAccountId = "", namedAccount = "",
          movementType = "FCL", containerTypes = [], dgAllowed = false, imdgClasses = [],
          validFrom = "", validTo = "", currency = "USD", status = "Active", notes = "",
          legs = [], rates = [], routings = [] } = req.body;
  const dup = db.prepare("SELECT id FROM contracts WHERE contract_number=? AND contract_ref=? AND named_account_id=?").get(contractNumber, contractRef, namedAccountId);
  if (dup) return err(res, `A contract with this number${contractRef ? ", reference" : ""}${namedAccountId ? ", and account" : ""} already exists (${dup.id})`);
  if (!CONTRACT_STATUSES.includes(status)) return err(res, `status must be one of: ${CONTRACT_STATUSES.join(", ")}`);
  const id = `CNTR-${uid()}`;
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO contracts (id,contract_number,contract_ref,carrier_code,named_account_id,named_account,movement_type,container_types,dg_allowed,imdg_classes,valid_from,valid_to,currency,status,notes,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType,
         JSON.stringify(containerTypes), dgAllowed ? 1 : 0, JSON.stringify(imdgClasses),
         validFrom, validTo, currency, status, notes, createdAt);
  const routingIds = saveRoutings(id, routings);
  saveLegs(id, legs, routingIds);
  await saveRates(id, rates, routingIds);
  const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(id);
  const lgs = db.prepare("SELECT * FROM contract_legs WHERE contract_id=? ORDER BY leg_order").all(id);
  const rts = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(id);
  const rtgs = db.prepare("SELECT * FROM contract_routings WHERE contract_id=? ORDER BY sort_order").all(id);
  ok(res, { ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate), routings: rtgs.map(mapContractRouting) }, 201);
});

app.put("/internal/contracts/:id", async (req, res) => {
  const { contractNumber = "", contractRef = "", carrierCode = "", namedAccountId = "", namedAccount = "",
          movementType = "FCL", containerTypes = [], dgAllowed = false, imdgClasses = [],
          validFrom = "", validTo = "", currency = "USD", status = "Active", notes = "",
          legs = [], rates = [], routings = [] } = req.body;
  const dup = db.prepare("SELECT id FROM contracts WHERE contract_number=? AND contract_ref=? AND named_account_id=? AND id!=?").get(contractNumber, contractRef, namedAccountId, req.params.id);
  if (dup) return err(res, `A contract with this number${contractRef ? ", reference" : ""}${namedAccountId ? ", and account" : ""} already exists (${dup.id})`);
  if (!CONTRACT_STATUSES.includes(status)) return err(res, `status must be one of: ${CONTRACT_STATUSES.join(", ")}`);
  const oldRoutingsById = Object.fromEntries(
    db.prepare("SELECT id, name FROM contract_routings WHERE contract_id=?").all(req.params.id).map(r => [r.id, r.name])
  );
  const info = db.prepare(`UPDATE contracts SET contract_number=?,contract_ref=?,carrier_code=?,named_account_id=?,named_account=?,
    movement_type=?,container_types=?,dg_allowed=?,imdg_classes=?,valid_from=?,valid_to=?,currency=?,status=?,notes=?
    WHERE id=?`)
    .run(contractNumber, contractRef, carrierCode, namedAccountId, namedAccount, movementType,
         JSON.stringify(containerTypes), dgAllowed ? 1 : 0, JSON.stringify(imdgClasses),
         validFrom, validTo, currency, status, notes, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  const routingIds = saveRoutings(req.params.id, routings);
  const newIndexByName = {};
  routings.forEach((r, i) => { if (r.name && !(r.name in newIndexByName)) newIndexByName[r.name] = i; });
  saveLegs(req.params.id, legs, routingIds, oldRoutingsById, newIndexByName);
  await saveRates(req.params.id, rates, routingIds, oldRoutingsById, newIndexByName);
  const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
  const lgs = db.prepare("SELECT * FROM contract_legs WHERE contract_id=? ORDER BY leg_order").all(req.params.id);
  const rts = db.prepare("SELECT * FROM contract_rates WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
  const rtgs = db.prepare("SELECT * FROM contract_routings WHERE contract_id=? ORDER BY sort_order").all(req.params.id);
  ok(res, { ...mapContract(c), legs: lgs.map(mapLeg), rates: rts.map(mapRate), routings: rtgs.map(mapContractRouting) });
});

// No shipment/allocation reference guard here — this service doesn't own that data. The caller
// (routes/contracts.js's remote branch) is responsible for running that check against its own
// local shipments/allocations tables BEFORE calling this route, exactly mirroring what the
// monolith's local delete path already does today.
app.delete("/internal/contracts/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
  if (!existing) return err(res, "Not found", 404);
  db.prepare("DELETE FROM contracts WHERE id=?").run(req.params.id);
  ok(res, { deleted: req.params.id });
});

app.post("/internal/contracts/:id/publish", (req, res) => {
  const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
  if (!c) return err(res, "Not found", 404);
  if (c.status !== "Draft") return err(res, `Only a Draft contract can be published (this one is ${c.status})`);
  const rateCount = db.prepare("SELECT COUNT(*) AS n FROM contract_rates WHERE contract_id=?").get(req.params.id).n;
  const legCount = db.prepare("SELECT COUNT(*) AS n FROM contract_legs WHERE contract_id=?").get(req.params.id).n;
  if (rateCount === 0) return err(res, "Add at least one rate before publishing");
  if (legCount === 0) return err(res, "Add at least one route leg before publishing");
  const routingCount = db.prepare("SELECT COUNT(*) AS n FROM contract_routings WHERE contract_id=?").get(req.params.id).n;
  if (routingCount > 0) {
    const orphanLegs = db.prepare("SELECT COUNT(*) AS n FROM contract_legs WHERE contract_id=? AND (routing_id IS NULL OR routing_id='')").get(req.params.id).n;
    if (orphanLegs > 0) return err(res, "Every leg must belong to a named routing once this contract has named routings — assign or remove the ungrouped leg(s) first");
  }
  if (!c.valid_from || !c.valid_to) return err(res, "Set both Valid From and Valid To before publishing");
  const today = new Date().toISOString().slice(0, 10);
  if (c.valid_to < today) return err(res, "Valid To is already in the past — update the validity window before publishing");
  db.prepare("UPDATE contracts SET status='Active' WHERE id=?").run(req.params.id);
  ok(res, mapContract({ ...c, status: "Active" }));
});

// No shipment/allocation reference guard here either — same reasoning as DELETE above.
app.post("/internal/contracts/:id/withdraw", (req, res) => {
  const c = db.prepare("SELECT * FROM contracts WHERE id=?").get(req.params.id);
  if (!c) return err(res, "Not found", 404);
  if (c.status !== "Active") return err(res, `Only an Active contract can be withdrawn to Draft (this one is ${c.status})`);
  db.prepare("UPDATE contracts SET status='Draft' WHERE id=?").run(req.params.id);
  ok(res, mapContract({ ...c, status: "Draft" }));
});

// Bulk import for the one-time migration script (scripts/migrate-contracts-to-service.js) — a
// thin loop over the same POST /internal/contracts logic, in one request instead of N, so a
// migration of the monolith's full contract set doesn't mean hundreds of round trips.
app.post("/internal/contracts/bulk-import", async (req, res) => {
  const { contracts = [] } = req.body || {};
  const results = [];
  for (const c of contracts) {
    const id = `CNTR-${uid()}`;
    const createdAt = c.createdAt || new Date().toISOString();
    try {
      db.prepare(`INSERT INTO contracts (id,contract_number,contract_ref,carrier_code,named_account_id,named_account,movement_type,container_types,dg_allowed,imdg_classes,valid_from,valid_to,currency,status,notes,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, c.contractNumber || "", c.contractRef || "", c.carrierCode || "", c.namedAccountId || "", c.namedAccount || "",
             c.movementType || "FCL", JSON.stringify(c.containerTypes || []), c.dgAllowed ? 1 : 0, JSON.stringify(c.imdgClasses || []),
             c.validFrom || "", c.validTo || "", c.currency || "USD", c.status || "Active", c.notes || "", createdAt);
      const routingIds = saveRoutings(id, c.routings || []);
      saveLegs(id, c.legs || [], routingIds);
      await saveRates(id, c.rates || [], routingIds);
      results.push({ sourceId: c.id || null, newId: id, ok: true });
    } catch (e) {
      results.push({ sourceId: c.id || null, ok: false, error: e.message });
    }
  }
  ok(res, { imported: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results }, 201);
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`📑  Contract Management Service running on http://localhost:${PORT}`));
}

module.exports = { app, db };
