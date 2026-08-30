"use strict";
const express = require("express");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { readSecret } = require("./lib/dockerSecret");

const PORT = process.env.CUSTOMER_SERVICE_PORT || 3008;
const SERVICE_SECRET_DEV_DEFAULT = "cargoDesk-dev-customers-service-secret-do-not-use-in-prod";
const SERVICE_SECRET = readSecret("CUSTOMER_SERVICE_SECRET", SERVICE_SECRET_DEV_DEFAULT);
if (SERVICE_SECRET === SERVICE_SECRET_DEV_DEFAULT)
  console.warn("⚠  CUSTOMER_SERVICE_SECRET not set (checked CUSTOMER_SERVICE_SECRET_FILE, then CUSTOMER_SERVICE_SECRET) — using insecure dev default. Set it (and the same value in the monolith's own env) before deploying.");

// No zero-script-onboarding sample DB here, matching Contract Management/Kanban's own precedent
// (not MDM's) — customers are operational data an install accumulates for itself, not
// hand-curated reference data worth shipping a seed for.
const DB_PATH = path.join(__dirname, "customers.db");

const app = express();
const db = new DatabaseSync(DB_PATH);

// Crash-safety net — same fix applied to the monolith's server.js after a live stress-test found
// an unhandled route error (a bad enum value, `undefined` bound into a node:sqlite statement)
// kills this entire process, same as any other plain Express 4 app with no error handling. Every
// app.get/post/put/patch/delete handler registered from here on is wrapped so a thrown/rejected
// error reaches next(err) — and the error middleware near app.listen below — instead of crashing.
function wrapAsyncHandler(fn) {
  if (typeof fn !== "function") return fn;
  return (req, res, next) => {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === "function") result.catch(next);
    } catch (e) { next(e); }
  };
}
for (const method of ["get", "post", "put", "patch", "delete"]) {
  const original = app[method].bind(app);
  app[method] = (routePath, ...handlers) => original(routePath, ...handlers.map(wrapAsyncHandler));
}
process.on("unhandledRejection", (reason) => console.error("⚠ Unhandled promise rejection (process kept alive):", reason));
process.on("uncaughtException", (e) => console.error("⚠ Uncaught exception (process kept alive):", e));

app.use(express.json({ limit: "5mb" }));

const uid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const ok = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });

// This service owns customers/customer_identifiers/customer_screenings/customer_contacts —
// deliberately NOT customer_documents (uploaded file bytes live on disk under the monolith's own
// UPLOADS_DIR; no prior extraction has solved cross-service file storage, and this satellite is
// narrow/self-contained enough to stay local-only regardless of customer_source — see
// ARCHITECTURE.md §8.1's "Customer-specific notes") and NOT customer_roles (confirmed dead code —
// zero readers, zero writers anywhere in the monolith; role membership is derived live from
// shipments/shipment_parties, which stay monolith-owned and need no toggle branch at all).
//
// parent_customer_id's ON DELETE SET NULL needs PRAGMA foreign_keys=ON (node:sqlite defaults it
// off) — without it, deleting a parent in remote mode would leave dangling pointers on its former
// children instead of nulling them, a correctness hazard for both the /group walk below and
// wouldCreateCycle's guard.
db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;

  CREATE TABLE IF NOT EXISTS customers (
    id                      TEXT PRIMARY KEY,
    company_name            TEXT NOT NULL,
    address1                TEXT DEFAULT '',
    address2                TEXT DEFAULT '',
    city                    TEXT DEFAULT '',
    state                   TEXT DEFAULT '',
    postal_code             TEXT DEFAULT '',
    country_iso2            TEXT DEFAULT '',
    phone                   TEXT DEFAULT '',
    fax                     TEXT DEFAULT '',
    email                   TEXT DEFAULT '',
    website                 TEXT DEFAULT '',
    notes                   TEXT DEFAULT '',
    created_at              TEXT NOT NULL,
    currency                TEXT DEFAULT 'USD',
    credit_limit            REAL DEFAULT NULL,
    credit_terms_days       INTEGER DEFAULT NULL,
    credit_hold             INTEGER NOT NULL DEFAULT 0,
    credit_hold_reason      TEXT DEFAULT '',
    parent_customer_id      TEXT REFERENCES customers(id) ON DELETE SET NULL,
    classified_location     INTEGER NOT NULL DEFAULT 0,
    latitude                REAL DEFAULT NULL,
    longitude               REAL DEFAULT NULL,
    is_nvocc                INTEGER NOT NULL DEFAULT 0,
    fmc_number              TEXT DEFAULT '',
    invoice_deadline_days   INTEGER DEFAULT NULL,
    reminder_enabled        INTEGER NOT NULL DEFAULT 0,
    reminder_interval_days  INTEGER DEFAULT NULL,
    billing_by_day          INTEGER DEFAULT NULL,
    payment_settlement_day  INTEGER DEFAULT NULL,
    holiday_unlocode        TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS customer_identifiers (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    id_type      TEXT NOT NULL DEFAULT 'VAT',
    id_code      TEXT NOT NULL DEFAULT '',
    country_iso2 TEXT NOT NULL DEFAULT '',
    label        TEXT NOT NULL DEFAULT '',
    is_primary   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS customer_screenings (
    id              TEXT PRIMARY KEY,
    customer_id     TEXT NOT NULL,
    screened_at     TEXT NOT NULL,
    result          TEXT NOT NULL,
    hits            TEXT DEFAULT '[]',
    overridden_at   TEXT,
    override_reason TEXT,
    UNIQUE(customer_id)
  );

  CREATE TABLE IF NOT EXISTS customer_contacts (
    id           TEXT PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    name         TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    email        TEXT NOT NULL DEFAULT '',
    phone        TEXT NOT NULL DEFAULT '',
    department   TEXT NOT NULL DEFAULT 'Other',
    is_primary   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL
  );
`);

// ─── Mappers — local copies of lib/mappers.js's own. ───────────────────────────────────────────

const mapCustomer = r => ({ id: r.id, companyName: r.company_name, address1: r.address1 || '', address2: r.address2 || '', city: r.city || '', state: r.state || '', postalCode: r.postal_code || '', countryIso2: r.country_iso2 || '', phone: r.phone || '', fax: r.fax || '', email: r.email || '', website: r.website || '', notes: r.notes || '', createdAt: r.created_at, screeningResult: r.screening_result || null, currency: r.currency || 'USD', creditLimit: r.credit_limit ?? null, creditTermsDays: r.credit_terms_days ?? null, invoiceDeadlineDays: r.invoice_deadline_days ?? null, reminderEnabled: !!r.reminder_enabled, reminderIntervalDays: r.reminder_interval_days ?? null, creditHold: !!r.credit_hold, creditHoldReason: r.credit_hold_reason || '', parentCustomerId: r.parent_customer_id || null, parentCustomerName: r.parent_customer_name || null, classifiedLocation: !!r.classified_location, latitude: r.latitude ?? null, longitude: r.longitude ?? null, isNvocc: !!r.is_nvocc, fmcNumber: r.fmc_number || '', billingByDay: r.billing_by_day ?? null, paymentSettlementDay: r.payment_settlement_day ?? null, holidayUnlocode: r.holiday_unlocode || '' });
const mapCustomerIdentifier = r => ({ id: r.id, customerId: r.customer_id, idType: r.id_type, idCode: r.id_code, countryIso2: r.country_iso2 || '', label: r.label || '', isPrimary: !!r.is_primary, createdAt: r.created_at });
const mapCustomerScreening = r => ({ id: r.id, customerId: r.customer_id, screenedAt: r.screened_at, result: r.result, hits: JSON.parse(r.hits || '[]'), overriddenAt: r.overridden_at || null, overrideReason: r.override_reason || null });
const mapCustomerContact = r => ({ id: r.id, customerId: r.customer_id, name: r.name, title: r.title || '', email: r.email || '', phone: r.phone || '', department: r.department || 'Other', isPrimary: !!r.is_primary, createdAt: r.created_at });

const CUST_JOIN = `SELECT c.*, cs.result AS screening_result, pc.company_name AS parent_customer_name
  FROM customers c
  LEFT JOIN customer_screenings cs ON cs.customer_id = c.id
  LEFT JOIN customers pc ON pc.id = c.parent_customer_id`;

// Country -> currency default — same scoped map routes/customers.js's own POST/PUT already use;
// duplicated here since customer creation/update now genuinely happens in this process too.
const COUNTRY_TO_CURRENCY = {
  US: "USD", GB: "GBP", CN: "CNY", HK: "CNY", SG: "SGD", JP: "JPY", AE: "AED", CH: "CHF", LI: "CHF",
  DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", BE: "EUR", PT: "EUR",
  AT: "EUR", IE: "EUR", FI: "EUR", GR: "EUR", LU: "EUR", SI: "EUR", SK: "EUR",
  EE: "EUR", LV: "EUR", LT: "EUR", MT: "EUR", CY: "EUR", HR: "EUR",
};

const validCoord = (v, min, max) => v === null || v === undefined || v === ''
  ? true : Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;

// Self-contained — this service owns the full parent_customer_id chain itself, so cycle
// detection (and everything else about referential integrity within this table) never needs a
// cross-service round trip. Verbatim logic port of routes/customers.js's own wouldCreateCycle.
function wouldCreateCycle(customerId, newParentId) {
  let current = newParentId;
  const seen = new Set();
  while (current) {
    if (current === customerId || seen.has(current)) return true;
    seen.add(current);
    current = db.prepare("SELECT parent_customer_id FROM customers WHERE id=?").get(current)?.parent_customer_id || null;
  }
  return false;
}

// Public liveness check — no secret required, matches every other service's own GET /health.
app.get("/health", (req, res) => ok(res, { status: "ok", service: "customers", uptime: process.uptime() }));

app.use("/internal", (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== SERVICE_SECRET) return err(res, "Unauthorized", 401);
  next();
});

// ─── Customers ──────────────────────────────────────────────────────────────────────────────────

app.get("/internal/customers", (req, res) => {
  const { search = '', city = '', country = '', customerId = '', ids = '',
          creditHold = '', hasCreditLimit = '', limit, offset } = req.query;
  const conditions = [], params = [];
  const s = search.trim();
  if (s) { conditions.push("(c.company_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.id LIKE ?)"); params.push(`%${s}%`, `%${s}%`, `%${s}%`, `%${s}%`); }
  const ci = city.trim();
  if (ci) { conditions.push("c.city LIKE ?"); params.push(`%${ci}%`); }
  const co = country.trim().toUpperCase();
  if (co) { conditions.push("c.country_iso2 = ?"); params.push(co); }
  const cid = customerId.trim();
  if (cid) { conditions.push("c.id LIKE ?"); params.push(`%${cid}%`); }
  // Batch id lookup — backs attachAgentNames() (MDM's own carrier-agent name resolver) and
  // routes/customers.js's own ?role= filter, both of which resolve an id set locally (against
  // monolith-owned tables) and pass it here instead of asking this service to know about roles
  // or carrier agents it has no data for.
  const idList = ids.split(',').map(x => x.trim()).filter(Boolean);
  if (idList.length) { conditions.push(`c.id IN (${idList.map(() => '?').join(',')})`); params.push(...idList); }
  if (creditHold === '1' || creditHold === 'true') conditions.push("c.credit_hold=1");
  if (creditHold === '0' || creditHold === 'false') conditions.push("c.credit_hold=0");
  if (hasCreditLimit === '1' || hasCreditLimit === 'true') conditions.push("c.credit_limit IS NOT NULL");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const order = " ORDER BY c.company_name";
  // Bare array by default (Kanban's GET /internal/tickets convention) — a caller that wants a
  // bounded page passes limit/offset explicitly and gets the {results,total,limit,offset} shape.
  if (limit === undefined && offset === undefined) {
    return ok(res, db.prepare(`${CUST_JOIN} ${where}${order}`).all(...params).map(mapCustomer));
  }
  const lim = Math.min(parseInt(limit) || 50, 500), off = parseInt(offset) || 0;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM customers c ${where}`).get(...params).n;
  const rows = db.prepare(`${CUST_JOIN} ${where}${order} LIMIT ? OFFSET ?`).all(...params, lim, off);
  ok(res, { results: rows.map(mapCustomer), total, limit: lim, offset: off });
});

app.get("/internal/customers/:id", (req, res) => {
  const r = db.prepare(`${CUST_JOIN} WHERE c.id=?`).get(req.params.id);
  if (!r) return err(res, "Not found", 404);
  ok(res, mapCustomer(r));
});

// Walks up parent_customer_id to the tree root, then BFS back down over every descendant —
// entirely server-side since both directions of the walk are fully co-located here. Returns the
// full id list, ROOT FIRST (routes/finance.js's own groupByParent rollup depends on this exact
// convention: resolveCustomerGroup(id)[0] === the root).
app.get("/internal/customers/:id/group", (req, res) => {
  const id = req.params.id;
  if (!db.prepare("SELECT id FROM customers WHERE id=?").get(id)) return err(res, "Not found", 404);
  let root = id;
  const walked = new Set([id]);
  while (true) {
    const row = db.prepare("SELECT parent_customer_id FROM customers WHERE id=?").get(root);
    const parentId = row?.parent_customer_id;
    if (!parentId || walked.has(parentId)) break; // no parent, or a pre-existing cycle — stop
    walked.add(parentId);
    root = parentId;
  }
  const ids = [root];
  const queue = [root];
  const seen = new Set([root]);
  while (queue.length) {
    const current = queue.shift();
    const children = db.prepare("SELECT id FROM customers WHERE parent_customer_id=?").all(current);
    for (const c of children) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      ids.push(c.id);
      queue.push(c.id);
    }
  }
  ok(res, { ids });
});

app.post("/internal/customers", (req, res) => {
  const { companyName, address1 = '', address2 = '', city = '', state = '', postalCode = '',
          countryIso2 = '', phone = '', fax = '', email = '', website = '', notes = '', currency = '',
          creditLimit = null, creditTermsDays = null, invoiceDeadlineDays = null, creditHold = false, creditHoldReason = '',
          reminderEnabled = false, reminderIntervalDays = null,
          parentCustomerId = null,
          classifiedLocation = false, latitude = null, longitude = null,
          isNvocc = false, fmcNumber = '',
          billingByDay = null, paymentSettlementDay = null, holidayUnlocode = '' } = req.body || {};
  if (!companyName?.trim()) return err(res, "companyName required");
  if (parentCustomerId && !db.prepare("SELECT id FROM customers WHERE id=?").get(parentCustomerId))
    return err(res, "Parent customer not found");
  if (!validCoord(latitude, -90, 90)) return err(res, "Latitude must be between -90 and 90");
  if (!validCoord(longitude, -180, 180)) return err(res, "Longitude must be between -180 and 180");
  const id = `CUS-${uid()}`;
  const createdAt = new Date().toISOString();
  const ccU = countryIso2.toUpperCase().trim();
  const resolvedCurrency = (currency.trim() || COUNTRY_TO_CURRENCY[ccU] || 'USD').toUpperCase().trim();
  const cl = creditLimit === null || creditLimit === '' ? null : Number(creditLimit);
  const ctd = creditTermsDays === null || creditTermsDays === '' ? null : parseInt(creditTermsDays, 10);
  const idd = invoiceDeadlineDays === null || invoiceDeadlineDays === '' ? null : parseInt(invoiceDeadlineDays, 10);
  const rid = reminderIntervalDays === null || reminderIntervalDays === '' ? null : parseInt(reminderIntervalDays, 10);
  const lat = classifiedLocation && latitude !== '' && latitude != null ? Number(latitude) : null;
  const lng = classifiedLocation && longitude !== '' && longitude != null ? Number(longitude) : null;
  const bbd = billingByDay === null || billingByDay === '' ? null : parseInt(billingByDay, 10);
  const psd = paymentSettlementDay === null || paymentSettlementDay === '' ? null : parseInt(paymentSettlementDay, 10);
  if (bbd != null && (bbd < 1 || bbd > 31)) return err(res, "billingByDay must be between 1 and 31");
  if (psd != null && (psd < 1 || psd > 31)) return err(res, "paymentSettlementDay must be between 1 and 31");
  db.prepare(`INSERT INTO customers (id,company_name,address1,address2,city,state,postal_code,country_iso2,phone,fax,email,website,notes,created_at,currency,credit_limit,credit_terms_days,invoice_deadline_days,credit_hold,credit_hold_reason,reminder_enabled,reminder_interval_days,parent_customer_id,classified_location,latitude,longitude,is_nvocc,fmc_number,billing_by_day,payment_settlement_day,holiday_unlocode)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, companyName.trim(), address1, address2, city, state, postalCode, ccU, phone, fax, email, website, notes, createdAt, resolvedCurrency,
         cl, ctd, idd, creditHold ? 1 : 0, creditHold ? creditHoldReason.trim() : '', reminderEnabled ? 1 : 0, rid, parentCustomerId || null,
         classifiedLocation ? 1 : 0, lat, lng, isNvocc ? 1 : 0, isNvocc ? fmcNumber.trim() : '', bbd, psd, holidayUnlocode.trim().toUpperCase());
  const row = db.prepare(`${CUST_JOIN} WHERE c.id=?`).get(id);
  ok(res, mapCustomer(row), 201);
});

app.put("/internal/customers/:id", (req, res) => {
  const { companyName, address1 = '', address2 = '', city = '', state = '', postalCode = '',
          countryIso2 = '', phone = '', fax = '', email = '', website = '', notes = '', currency = 'USD',
          creditLimit = null, creditTermsDays = null, invoiceDeadlineDays = null, creditHold = false, creditHoldReason = '',
          reminderEnabled = false, reminderIntervalDays = null,
          parentCustomerId = null,
          classifiedLocation = false, latitude = null, longitude = null,
          isNvocc = false, fmcNumber = '',
          billingByDay = null, paymentSettlementDay = null, holidayUnlocode = '' } = req.body || {};
  if (!companyName?.trim()) return err(res, "companyName required");
  if (parentCustomerId) {
    if (!db.prepare("SELECT id FROM customers WHERE id=?").get(parentCustomerId))
      return err(res, "Parent customer not found");
    if (wouldCreateCycle(req.params.id, parentCustomerId))
      return err(res, "This would create a circular parent chain — pick a different parent");
  }
  if (!validCoord(latitude, -90, 90)) return err(res, "Latitude must be between -90 and 90");
  if (!validCoord(longitude, -180, 180)) return err(res, "Longitude must be between -180 and 180");
  const ccU = countryIso2.toUpperCase().trim();
  const cl = creditLimit === null || creditLimit === '' ? null : Number(creditLimit);
  const ctd = creditTermsDays === null || creditTermsDays === '' ? null : parseInt(creditTermsDays, 10);
  const idd = invoiceDeadlineDays === null || invoiceDeadlineDays === '' ? null : parseInt(invoiceDeadlineDays, 10);
  const rid = reminderIntervalDays === null || reminderIntervalDays === '' ? null : parseInt(reminderIntervalDays, 10);
  const lat = classifiedLocation && latitude !== '' && latitude != null ? Number(latitude) : null;
  const lng = classifiedLocation && longitude !== '' && longitude != null ? Number(longitude) : null;
  const bbd = billingByDay === null || billingByDay === '' ? null : parseInt(billingByDay, 10);
  const psd = paymentSettlementDay === null || paymentSettlementDay === '' ? null : parseInt(paymentSettlementDay, 10);
  if (bbd != null && (bbd < 1 || bbd > 31)) return err(res, "billingByDay must be between 1 and 31");
  if (psd != null && (psd < 1 || psd > 31)) return err(res, "paymentSettlementDay must be between 1 and 31");
  const info = db.prepare(`UPDATE customers SET company_name=?,address1=?,address2=?,city=?,state=?,
    postal_code=?,country_iso2=?,phone=?,fax=?,email=?,website=?,notes=?,currency=?,
    credit_limit=?,credit_terms_days=?,invoice_deadline_days=?,credit_hold=?,credit_hold_reason=?,reminder_enabled=?,reminder_interval_days=?,parent_customer_id=?,
    classified_location=?,latitude=?,longitude=?,is_nvocc=?,fmc_number=?,
    billing_by_day=?,payment_settlement_day=?,holiday_unlocode=? WHERE id=?`)
    .run(companyName.trim(), address1, address2, city, state, postalCode, ccU, phone, fax, email, website, notes, (currency || 'USD').toUpperCase().trim(),
         cl, ctd, idd, creditHold ? 1 : 0, creditHold ? creditHoldReason.trim() : '', reminderEnabled ? 1 : 0, rid, parentCustomerId || null,
         classifiedLocation ? 1 : 0, lat, lng, isNvocc ? 1 : 0, isNvocc ? fmcNumber.trim() : '',
         bbd, psd, holidayUnlocode.trim().toUpperCase(), req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  const row = db.prepare(`${CUST_JOIN} WHERE c.id=?`).get(req.params.id);
  ok(res, mapCustomer(row));
});

// No carrier_agents guard here — that table lives in the MDM Service, not this one; the guard
// stays entirely monolith-side (routes/customers.js), unchanged, regardless of customer_source.
app.delete("/internal/customers/:id", (req, res) => {
  const info = db.prepare("DELETE FROM customers WHERE id=?").run(req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  db.prepare("DELETE FROM customer_identifiers WHERE customer_id=?").run(req.params.id);
  db.prepare("DELETE FROM customer_screenings WHERE customer_id=?").run(req.params.id);
  db.prepare("DELETE FROM customer_contacts WHERE customer_id=?").run(req.params.id);
  ok(res, { deleted: req.params.id });
});

// ─── Identifiers ────────────────────────────────────────────────────────────────────────────────

app.get("/internal/customers/:id/identifiers", (req, res) => {
  const rows = db.prepare("SELECT * FROM customer_identifiers WHERE customer_id=? ORDER BY is_primary DESC, created_at ASC").all(req.params.id);
  ok(res, rows.map(mapCustomerIdentifier));
});

app.post("/internal/customers/:id/identifiers", (req, res) => {
  if (!db.prepare("SELECT id FROM customers WHERE id=?").get(req.params.id)) return err(res, "Customer not found", 404);
  const { idType = 'VAT', idCode = '', countryIso2 = '', label = '', isPrimary = false } = req.body || {};
  if (!idCode.trim()) return err(res, "idCode required");
  const id = `CID-${uid()}`;
  const now = new Date().toISOString();
  if (isPrimary) db.prepare("UPDATE customer_identifiers SET is_primary=0 WHERE customer_id=? AND id_type=?").run(req.params.id, idType);
  db.prepare("INSERT INTO customer_identifiers (id,customer_id,id_type,id_code,country_iso2,label,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, req.params.id, idType, idCode.trim(), countryIso2.toUpperCase().slice(0, 2), label.trim(), isPrimary ? 1 : 0, now);
  const row = db.prepare("SELECT * FROM customer_identifiers WHERE id=?").get(id);
  ok(res, mapCustomerIdentifier(row), 201);
});

app.put("/internal/customers/:id/identifiers/:iid", (req, res) => {
  const existing = db.prepare("SELECT * FROM customer_identifiers WHERE id=? AND customer_id=?").get(req.params.iid, req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const { idType = existing.id_type, idCode = existing.id_code, countryIso2 = existing.country_iso2,
          label = existing.label, isPrimary = !!existing.is_primary } = req.body || {};
  if (!idCode.trim()) return err(res, "idCode required");
  if (isPrimary) db.prepare("UPDATE customer_identifiers SET is_primary=0 WHERE customer_id=? AND id_type=? AND id!=?").run(req.params.id, idType, req.params.iid);
  db.prepare("UPDATE customer_identifiers SET id_type=?,id_code=?,country_iso2=?,label=?,is_primary=? WHERE id=?")
    .run(idType, idCode.trim(), countryIso2.toUpperCase().slice(0, 2), label.trim(), isPrimary ? 1 : 0, req.params.iid);
  const row = db.prepare("SELECT * FROM customer_identifiers WHERE id=?").get(req.params.iid);
  ok(res, mapCustomerIdentifier(row));
});

app.delete("/internal/customers/:id/identifiers/:iid", (req, res) => {
  const info = db.prepare("DELETE FROM customer_identifiers WHERE id=? AND customer_id=?").run(req.params.iid, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.iid });
});

// ─── Contacts ───────────────────────────────────────────────────────────────────────────────────

app.get("/internal/customers/:id/contacts", (req, res) => {
  const rows = db.prepare("SELECT * FROM customer_contacts WHERE customer_id=? ORDER BY is_primary DESC, created_at ASC").all(req.params.id);
  ok(res, rows.map(mapCustomerContact));
});

app.post("/internal/customers/:id/contacts", (req, res) => {
  if (!db.prepare("SELECT id FROM customers WHERE id=?").get(req.params.id)) return err(res, "Customer not found", 404);
  const { name = '', title = '', email = '', phone = '', department = 'Other', isPrimary = false } = req.body || {};
  if (!name.trim()) return err(res, "name required");
  const id = `CCT-${uid()}`;
  const now = new Date().toISOString();
  if (isPrimary) db.prepare("UPDATE customer_contacts SET is_primary=0 WHERE customer_id=?").run(req.params.id);
  db.prepare("INSERT INTO customer_contacts (id,customer_id,name,title,email,phone,department,is_primary,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, req.params.id, name.trim(), title.trim(), email.trim(), phone.trim(), department, isPrimary ? 1 : 0, now);
  const row = db.prepare("SELECT * FROM customer_contacts WHERE id=?").get(id);
  ok(res, mapCustomerContact(row), 201);
});

app.put("/internal/customers/:id/contacts/:cid", (req, res) => {
  const existing = db.prepare("SELECT * FROM customer_contacts WHERE id=? AND customer_id=?").get(req.params.cid, req.params.id);
  if (!existing) return err(res, "Not found", 404);
  const { name = existing.name, title = existing.title, email = existing.email, phone = existing.phone,
          department = existing.department, isPrimary = !!existing.is_primary } = req.body || {};
  if (!name.trim()) return err(res, "name required");
  if (isPrimary) db.prepare("UPDATE customer_contacts SET is_primary=0 WHERE customer_id=? AND id!=?").run(req.params.id, req.params.cid);
  db.prepare("UPDATE customer_contacts SET name=?,title=?,email=?,phone=?,department=?,is_primary=? WHERE id=?")
    .run(name.trim(), title.trim(), email.trim(), phone.trim(), department, isPrimary ? 1 : 0, req.params.cid);
  const row = db.prepare("SELECT * FROM customer_contacts WHERE id=?").get(req.params.cid);
  ok(res, mapCustomerContact(row));
});

app.delete("/internal/customers/:id/contacts/:cid", (req, res) => {
  const info = db.prepare("DELETE FROM customer_contacts WHERE id=? AND customer_id=?").run(req.params.cid, req.params.id);
  if (info.changes === 0) return err(res, "Not found", 404);
  ok(res, { deleted: req.params.cid });
});

// ─── Screening — write-only. The MATCH decision (comparing company_name against the sanctions
// list) can never move here: it needs the monolith's in-memory sanctionsMap, itself sourced from
// the already-extracted Screening Service. This service only ever persists an already-decided
// result. ───────────────────────────────────────────────────────────────────────────────────────

app.get("/internal/customers/:id/screening", (req, res) => {
  const row = db.prepare("SELECT * FROM customer_screenings WHERE customer_id=?").get(req.params.id);
  if (!row) return ok(res, null);
  ok(res, mapCustomerScreening(row));
});

app.put("/internal/customers/:id/screening", (req, res) => {
  if (!db.prepare("SELECT id FROM customers WHERE id=?").get(req.params.id)) return err(res, "Not found", 404);
  const { result, hits = [], screenedAt } = req.body || {};
  if (result !== "HIT" && result !== "CLEAR") return err(res, "result must be HIT or CLEAR");
  const now = screenedAt || new Date().toISOString();
  const id = `CSC-${uid()}`;
  db.prepare(`INSERT INTO customer_screenings (id,customer_id,screened_at,result,hits)
    VALUES (?,?,?,?,?)
    ON CONFLICT(customer_id) DO UPDATE SET
      screened_at=excluded.screened_at, result=excluded.result,
      hits=excluded.hits, overridden_at=NULL, override_reason=NULL`)
    .run(id, req.params.id, now, result, JSON.stringify(hits));
  const row = db.prepare("SELECT * FROM customer_screenings WHERE customer_id=?").get(req.params.id);
  ok(res, mapCustomerScreening(row));
});

// Pure state mutation, no sanctionsMap dependency — this one CAN run fully server-side.
app.post("/internal/customers/:id/screening/override", (req, res) => {
  const { reason = "" } = req.body || {};
  if (!reason.trim()) return err(res, "Override reason is required");
  const row = db.prepare("SELECT id FROM customer_screenings WHERE customer_id=?").get(req.params.id);
  if (!row) return err(res, "No screening record found for this customer", 404);
  const now = new Date().toISOString();
  db.prepare("UPDATE customer_screenings SET result='CLEAR', overridden_at=?, override_reason=? WHERE customer_id=?")
    .run(now, reason.trim(), req.params.id);
  const updated = db.prepare("SELECT * FROM customer_screenings WHERE customer_id=?").get(req.params.id);
  ok(res, mapCustomerScreening(updated));
});

// Bulk import for the one-time migration script (scripts/migrate-customers-to-service.js) — one
// payload with a per-table array of raw snake_case rows, INSERT OR IGNORE keyed on each table's
// own original id so a re-run against an already-migrated target is a safe no-op. customers
// inserted first (parent_customer_id is self-referential — a child row migrated before its
// parent would still succeed since the FK isn't checked mid-transaction against not-yet-inserted
// siblings within the same batch the usual way IGNORE handles it, but ordering avoids ambiguity).
app.post("/internal/customers/bulk-import", (req, res) => {
  const { customers = [], customerIdentifiers = [], customerContacts = [], customerScreenings = [] } = req.body || {};
  const counts = {};
  const run = (label, table, cols, rows) => {
    const ins = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    let n = 0;
    for (const r of rows) { try { const info = ins.run(...cols.map(c => r[c] ?? null)); n += info.changes; } catch { /* skip malformed row */ } }
    counts[label] = n;
  };
  db.exec("BEGIN");
  try {
    run("customers", "customers", ["id", "company_name", "address1", "address2", "city", "state", "postal_code",
      "country_iso2", "phone", "fax", "email", "website", "notes", "created_at", "currency", "credit_limit",
      "credit_terms_days", "credit_hold", "credit_hold_reason", "parent_customer_id", "classified_location",
      "latitude", "longitude", "is_nvocc", "fmc_number", "invoice_deadline_days", "reminder_enabled",
      "reminder_interval_days", "billing_by_day", "payment_settlement_day", "holiday_unlocode"], customers);
    run("customerIdentifiers", "customer_identifiers", ["id", "customer_id", "id_type", "id_code", "country_iso2", "label", "is_primary", "created_at"], customerIdentifiers);
    run("customerContacts", "customer_contacts", ["id", "customer_id", "name", "title", "email", "phone", "department", "is_primary", "created_at"], customerContacts);
    run("customerScreenings", "customer_screenings", ["id", "customer_id", "screened_at", "result", "hits", "overridden_at", "override_reason"], customerScreenings);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); return err(res, e.message, 500); }
  ok(res, { inserted: counts }, 201);
});

// Error-handling middleware — must be registered after every route above. Malformed JSON bodies
// get a clean 400 instead of body-parser's raw HTML/stack-trace page; anything else forwarded via
// wrapAsyncHandler is logged in full server-side and answered with a generic 500 (never the raw
// error/stack to the caller).
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed" || error instanceof SyntaxError) {
    return res.status(400).json({ error: "Malformed request body — expected valid JSON" });
  }
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, error);
  res.status(error?.status || 500).json({ error: "Internal server error" });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`🧾  Customer Service running on http://localhost:${PORT}`));
}

module.exports = { app, db };
