"use strict";

// ─── Shipment QA export / import (2026-11-13, mockup 0fb62029, ARCHITECTURE.md §8.50) ──────────────────────────────────
// An admin saves any shipment as one JSON file and imports it into a test system as a NEW shipment marked IMPORTED, so
// QA can reproduce an issue found in production. The user's decisions: real values as stored (no anonymising), admins
// only, a new id with an IMPORTED label, the shipment's files inside the file, and a "what went wrong / steps to
// reproduce" report in the file with a plain-language summary at the top, so the file can be handed to Claude as it is.
// Recommended and approved (A–G): import lives in Test Tools; a server in production mode imports only while an admin
// has turned on App Settings → Shipment imports; an office the test system doesn't have is chosen by the importer;
// customers are matched by VAT/LEI/EORI number, else exact name, else created as a copy marked IMPORTED; an imported
// shipment sends nothing (lib/imported-shipment-context.js, server.js shipmentImportGuard) and every sweep skips it.
//
// The file (format cargodesk-shipment-export/1): source, report, summary, shipment (the row as stored), sections
// (every table that hangs off the shipment, rows as stored), entityEvents, context (read-only: tickets, test items,
// statement lines), references (customers in full, offices, carrier, ports, vessels, commodity, contract, people) and
// files (each document's bytes, base64). An import gives every row a new id and rewrites every reference to it.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FORMAT = "cargodesk-shipment-export/1";
// What hangs off a shipment, in the order an import writes it (a row after what its foreign keys point at). `by` is how
// rows are found: by shipment_id, or by a parent part's ids.
const PARTS = [
  { table: "containers", by: "shipment" },
  { table: "container_packages", by: { col: "container_id", parent: "containers" } },
  { table: "shipment_legs", by: "shipment" },
  { table: "shipment_schedules", by: "shipment" },
  { table: "schedule_legs", by: { col: "schedule_id", parent: "shipment_schedules" } },
  { table: "schedule_leg_refs", by: { col: "schedule_id", parent: "shipment_schedules" } },
  { table: "vgm_declarations", by: "shipment" },
  { table: "shipment_documents", by: "shipment" },
  { table: "carrier_bookings", by: "shipment" },
  { table: "carrier_booking_archive", by: "shipment" },
  { table: "edi_messages", by: "shipment" },
  { table: "shipping_instructions", by: "shipment" },
  { table: "transport_documents", by: "shipment" },
  { table: "transport_document_events", by: "shipment" },
  { table: "ebl_surrender_requests", by: { col: "transport_document_id", parent: "transport_documents" } },
  { table: "master_bl_custody", by: "shipment" },
  { table: "master_bl_custody_events", by: "shipment" },
  { table: "carrier_events", by: "shipment" },
  { table: "container_events", by: "shipment" },
  { table: "shipment_rate_snapshots", by: "shipment" },
  { table: "shipment_cost_lines", by: "shipment" },
  { table: "shipment_charge_defaults_applied", by: "shipment" },
  { table: "shipment_services", by: "shipment" },
  { table: "shipment_loading_plan_lines", by: { col: "service_id", parent: "shipment_services" } },
  { table: "shipment_haulage_records", by: { col: "service_id", parent: "shipment_services" } },
  { table: "shipment_milestones", by: "shipment" },
  { table: "shipment_messages", by: "shipment" },
  { table: "shipment_parties", by: "shipment" },
  { table: "shipment_carrier_offices", by: "shipment" },
  { table: "shipment_side_offices", by: "shipment" },
  { table: "shipment_screenings", by: "shipment" },
  { table: "booking_escalations", by: "shipment" },
  { table: "booking_escalation_steps", by: "shipment" },
  { table: "carrier_invoices", by: "shipment" },
  { table: "carrier_invoice_lines", by: { col: "invoice_id", parent: "carrier_invoices" } },
  { table: "credit_overrides", by: "shipment" },
  { table: "customs_filings", by: "shipment" },
  { table: "spot_offers", by: "shipment" },
  { table: "spot_offer_lines", by: { col: "offer_id", parent: "spot_offers" } },
  { table: "arrival_notices", by: "shipment" },
  { table: "invoice_status_overrides", by: { col: "document_id", parent: "shipment_documents" } },
  { table: "shipment_events", by: "shipment" },
  { table: "status_log", by: "shipment" },
];
// Carried for whoever looks into the issue, never written into the test system: Kanban tickets and test cases live
// in their own board, and a statement line belongs to a statement spanning other shipments.
const CONTEXT = ["tickets", "test_items", "customer_statement_lines"];
// Plain-language names for the summary and the screens.
const LABEL = {
  containers: "containers", container_packages: "container packages", shipment_legs: "route legs", shipment_schedules: "saved sailings",
  schedule_legs: "sailing legs", schedule_leg_refs: "sailing leg references", vgm_declarations: "VGM declarations", shipment_documents: "documents",
  carrier_bookings: "carrier booking", carrier_booking_archive: "earlier carrier bookings", edi_messages: "carrier messages",
  shipping_instructions: "Shipping Instructions", transport_documents: "B/L records (House and Master)", transport_document_events: "B/L events",
  ebl_surrender_requests: "eBL surrender requests", master_bl_custody: "carrier's Master B/L custody", master_bl_custody_events: "Master B/L custody steps",
  carrier_events: "carrier events (Track & Trace)", container_events: "container events", shipment_rate_snapshots: "contract rate snapshots",
  shipment_cost_lines: "costs and charges", shipment_charge_defaults_applied: "Charge Defaults applied", shipment_services: "services",
  shipment_loading_plan_lines: "loading plan lines", shipment_haulage_records: "haulage records", shipment_milestones: "milestones",
  shipment_messages: "messages", shipment_parties: "additional parties", shipment_carrier_offices: "carrier offices",
  shipment_side_offices: "additional offices", shipment_screenings: "compliance screening",
  booking_escalations: "booking escalations", booking_escalation_steps: "escalation steps", carrier_invoices: "carrier invoices",
  carrier_invoice_lines: "carrier invoice lines", credit_overrides: "credit overrides", customs_filings: "customs filings", spot_offers: "spot offers",
  spot_offer_lines: "spot offer lines", arrival_notices: "Arrival Notices", invoice_status_overrides: "invoice status overrides",
  shipment_events: "history events", status_log: "status changes",
};
// …and for a count of one.
const SINGULAR = {
  containers: "container", container_packages: "container package", shipment_legs: "route leg", shipment_schedules: "saved sailing",
  schedule_legs: "sailing leg", schedule_leg_refs: "sailing leg reference", vgm_declarations: "VGM declaration", shipment_documents: "document",
  carrier_booking_archive: "earlier carrier booking", edi_messages: "carrier message", transport_documents: "B/L record",
  transport_document_events: "B/L event", ebl_surrender_requests: "eBL surrender request", master_bl_custody_events: "Master B/L custody step",
  carrier_events: "carrier event (Track & Trace)", container_events: "container event", shipment_rate_snapshots: "contract rate snapshot",
  shipment_cost_lines: "cost or charge", shipment_services: "service", shipment_loading_plan_lines: "loading plan line",
  shipment_haulage_records: "haulage record", shipment_milestones: "milestone", shipment_messages: "message", shipment_parties: "additional party",
  shipment_carrier_offices: "carrier office",
  shipment_side_offices: "additional office", booking_escalations: "booking escalation", booking_escalation_steps: "escalation step",
  carrier_invoices: "carrier invoice", carrier_invoice_lines: "carrier invoice line", credit_overrides: "credit override", customs_filings: "customs filing",
  spot_offers: "spot offer", spot_offer_lines: "spot offer line", arrival_notices: "Arrival Notice", invoice_status_overrides: "invoice status override",
  shipment_events: "history event", status_log: "status change",
};
const countText = (table, n) => `${n} ${n === 1 && SINGULAR[table] ? SINGULAR[table] : (LABEL[table] || table)}`;
const ROLE_OF_COLUMN = { shipper_id: "Shipper", consignee_id: "Consignee", principal_id: "Principal", notify_id: "Notify" };
// The billing office too (the office split, §8.52; audit S3, TKT-PRA1PQ): found here by code, else left off.
const OFFICE_ROLES = { emo_office_id: "export", imo_office_id: "import", controlling_office_id: "controlling", billing_office_id: "billing" };
// Customer fields a created copy takes (local mode), camelCase from the API's mapCustomer → the customers column.
const CUSTOMER_COLUMNS = [["companyName", "company_name"], ["address1", "address1"], ["address2", "address2"], ["city", "city"], ["state", "state"],
  ["postalCode", "postal_code"], ["countryIso2", "country_iso2"], ["phone", "phone"], ["fax", "fax"], ["email", "email"], ["website", "website"],
  ["notes", "notes"], ["currency", "currency"], ["creditLimit", "credit_limit"], ["creditTermsDays", "credit_terms_days"],
  ["invoiceDeadlineDays", "invoice_deadline_days"], ["creditHold", "credit_hold"], ["creditHoldReason", "credit_hold_reason"],
  ["reminderEnabled", "reminder_enabled"], ["reminderIntervalDays", "reminder_interval_days"], ["classifiedLocation", "classified_location"],
  ["latitude", "latitude"], ["longitude", "longitude"], ["isNvocc", "is_nvocc"], ["fmcNumber", "fmc_number"], ["billingByDay", "billing_by_day"],
  ["paymentSettlementDay", "payment_settlement_day"], ["holidayUnlocode", "holiday_unlocode"]];
const MATCH_ID_TYPES = ["VAT", "LEI", "EORI"];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 0.91.14 vs 0.91.13 → 1; equal → 0.
const cmpVersion = (a, b) => {
  const pa = String(a || "0").split(".").map(Number), pb = String(b || "0").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d > 0 ? 1 : -1; }
  return 0;
};
const fmtDay = d => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const stepsOf = v => (Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map(s => String(s).replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean).slice(0, 50);

function createShipmentTransfer(ctx) {
  const { query, transaction, uid, UPLOADS_DIR, getSettings, getCustomerRow, callCustomerService, logEvent, logAdminEvent } = ctx;
  const VERSION = (() => { try { return require("../package.json").version; } catch { return "0"; } })();
  const nowIso = () => new Date().toISOString();
  const actorOf = user => user?.name || user?.email || "";
  const isRemoteCustomers = async () => ((await getSettings()).customer_source || "local") === "remote";

  // ─── The schema as this system has it ───────────────────────────────────────────────────────────────────────────────
  const schemaCache = new Map();
  async function schemaOf(table) {
    if (schemaCache.has(table)) return schemaCache.get(table);
    const cols = await query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1`, [table]);
    const fks = cols.length ? await query(`SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public' AND tc.table_name=$1`, [table]) : [];
    const s = {
      exists: cols.length > 0,
      columns: new Map(cols.map(c => [c.column_name, { type: c.data_type, nullable: c.is_nullable === "YES", serial: /nextval/i.test(c.column_default || "") }])),
      fks: fks.filter(f => f.column_name !== "shipment_id"),
    };
    schemaCache.set(table, s);
    return s;
  }

  // ─── Export ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function gather(shipmentId) {
    const [s] = await query("SELECT * FROM shipments WHERE id=$1", [shipmentId]);
    if (!s) return null;
    const sections = {}, idsOf = {};
    for (const part of PARTS) {
      if (!(await schemaOf(part.table)).exists) continue;
      let rows;
      if (part.by === "shipment") rows = await query(`SELECT * FROM ${part.table} WHERE shipment_id=$1`, [shipmentId]);
      else {
        const parentIds = idsOf[part.by.parent] || [];
        rows = parentIds.length ? await query(`SELECT * FROM ${part.table} WHERE ${part.by.col} = ANY($1)`, [parentIds]) : [];
      }
      if (rows.length) sections[part.table] = rows;
      idsOf[part.table] = rows.map(r => r.id).filter(v => typeof v === "string");
    }
    const bundleIds = Object.values(idsOf).flat();
    const entityEvents = bundleIds.length ? await query("SELECT * FROM entity_events WHERE entity_id = ANY($1) ORDER BY created_at", [bundleIds]) : [];
    const context = {};
    for (const t of CONTEXT) {
      if (!(await schemaOf(t)).exists) continue;
      const rows = await query(`SELECT * FROM ${t} WHERE shipment_id=$1`, [shipmentId]);
      if (rows.length) context[t] = rows;
    }
    return { s, sections, entityEvents, context };
  }

  async function customerFile(id) {
    const record = await getCustomerRow(id);
    if (!record) return null;
    let identifiers = [], contacts = [];
    if (await isRemoteCustomers()) {
      identifiers = await callCustomerService("GET", `/internal/customers/${id}/identifiers`).catch(() => []);
      contacts = await callCustomerService("GET", `/internal/customers/${id}/contacts`).catch(() => []);
    } else {
      identifiers = (await query("SELECT * FROM customer_identifiers WHERE customer_id=$1 ORDER BY created_at", [id])).map(ctx.mapCustomerIdentifier);
      contacts = (await query("SELECT * FROM customer_contacts WHERE customer_id=$1 ORDER BY created_at", [id])).map(ctx.mapCustomerContact);
    }
    return { record, identifiers: identifiers || [], contacts: contacts || [] };
  }

  async function referencesOf(s, sections) {
    const customers = new Map();
    const addCustomer = (id, role) => { if (!id) return; const c = customers.get(id) || { id, roles: [] }; if (!c.roles.includes(role)) c.roles.push(role); customers.set(id, c); };
    for (const [col, role] of Object.entries(ROLE_OF_COLUMN)) addCustomer(s[col], role);
    for (const p of sections.shipment_parties || []) addCustomer(p.customer_id, p.role);
    for (const c of sections.credit_overrides || []) addCustomer(c.customer_id, "Credit override");
    const customerList = [];
    for (const c of customers.values()) {
      const f = await customerFile(c.id);
      customerList.push({ id: c.id, roles: c.roles, name: f?.record?.companyName || "", missing: !f, ...(f || {}) });
    }
    const officeIds = new Map();
    for (const [col, role] of Object.entries(OFFICE_ROLES)) if (s[col]) officeIds.set(s[col], [...(officeIds.get(s[col]) || []), role]);
    for (const so of sections.shipment_side_offices || []) officeIds.set(so.office_id, [...(officeIds.get(so.office_id) || []), `additional ${String(so.side || "").toLowerCase()}`]);
    // The offices that issued its invoices and credit notes (the office split, §8.52), which may have left the shipment
    // since (audit S3): found here by code, else their documents' issuing office is emptied.
    for (const d of sections.shipment_documents || [])
      if (d.issuing_office_id && !(officeIds.get(d.issuing_office_id) || []).includes("issuing"))
        officeIds.set(d.issuing_office_id, [...(officeIds.get(d.issuing_office_id) || []), "issuing"]);
    const officeRows = officeIds.size ? await query(`SELECT o.id, o.code, o.name, o.department, o.country_code, b.name AS branch
      FROM offices o LEFT JOIN branches b ON b.id = o.branch_id WHERE o.id = ANY($1)`, [[...officeIds.keys()]]) : [];
    const offices = [...officeIds.entries()].map(([id, roles]) => {
      const o = officeRows.find(r => r.id === id);
      return { id, roles, code: o?.code || "", name: o?.name || "", department: o?.department || "", countryCode: o?.country_code || "", legalEntity: o?.branch || "" };
    });
    // The carrier offices it names (§8.53): its own carrier offices and the issuers of its carrier invoices. Found in a
    // test system by carrier and name, else the reference is emptied and the name it carries kept.
    const carrierOfficeIds = new Set([...(sections.shipment_carrier_offices || []).map(r => r.office_id), ...(sections.carrier_invoices || []).map(r => r.issuing_office_id)].filter(Boolean));
    const carrierOffices = carrierOfficeIds.size
      ? (await query("SELECT id, carrier_code, name, unlocode FROM carrier_offices WHERE id = ANY($1)", [[...carrierOfficeIds]]).catch(() => []))
        .map(o => ({ id: o.id, carrierCode: o.carrier_code, name: o.name, unlocode: o.unlocode || "" }))
      : [];
    const legs = sections.shipment_legs || [];
    const uniq = a => [...new Set(a.map(v => String(v || "").trim()).filter(Boolean))];
    const people = uniq([...(sections.shipment_events || []).map(e => e.actor), ...(sections.transport_document_events || []).map(e => e.actor),
      ...(sections.master_bl_custody_events || []).map(e => e.actor), ...(sections.shipment_messages || []).map(m => m.author)]);
    return {
      customers: customerList, offices, carrierOffices,
      carriers: uniq([s.carrier_code, ...legs.map(l => l.carrier_code), ...(sections.carrier_bookings || []).map(b => b.carrier_code)]),
      ports: uniq([s.pol, s.pod, ...legs.flatMap(l => [l.pol, l.pod])]).filter(p => /^[A-Z]{2}[A-Z0-9]{3}$/.test(p)),
      vessels: uniq([s.vessel, ...legs.map(l => l.vessel)]).map(name => ({ name, imo: legs.find(l => l.vessel === name)?.vessel_imo || (s.vessel === name ? s.vessel_imo || "" : "") })),
      commodity: s.commodity_code || "",
      containerTypes: uniq((sections.containers || []).map(c => c.iso_equipment_code || `${c.size || ""}${c.type || ""}`)),
      contract: { id: s.contract_id || "", reference: s.contract_ref || "", routingId: s.contract_routing_id || "", type: s.contract_type || "" },
      allocation: s.allocation_id || "", laneSteering: s.steering_line_id || "", quote: s.source_quote_id || "",
      termsVersions: uniq((sections.transport_documents || []).map(t => t.terms_id)),
      people,
    };
  }

  function summaryOf(s, sections, refs, report) {
    const n = t => (sections[t] || []).length;
    const ctrs = sections.containers || [];
    const types = [...new Set(ctrs.map(c => c.iso_equipment_code || `${c.size || ""}${c.type || ""}`).filter(Boolean))].join(", ");
    const booking = (sections.carrier_bookings || [])[0];
    const office = role => refs.offices.find(o => o.roles.includes(role));
    const parts = Object.entries(sections).map(([t, rows]) => countText(t, rows.length)).join(", ");
    const lines = [
      `Shipment ${s.id} (${s.status}): ${s.incoterm ? `${s.incoterm} ` : ""}${s.pol} → ${s.pod}${s.carrier_code ? ` on ${s.carrier_code}` : ""}${s.vessel ? ` (${[s.vessel, s.voyage].filter(Boolean).join(" ")})` : ""}`
        + `${ctrs.length ? `, ${ctrs.length} container${ctrs.length === 1 ? "" : "s"}${types ? ` (${types})` : ""}` : ""}; ETD ${fmtDay(s.etd) || "—"}, ETA ${fmtDay(s.eta) || "—"}.`,
      `Parties: shipper ${s.shipper_name || "—"}, consignee ${s.consignee_name || "—"}, principal ${s.principal_name || "—"}.`
        + ` Export office ${office("export")?.code || "—"}, import office ${office("import")?.code || "—"}.`,
      booking ? `Carrier booking: ${booking.status}${booking.carrier_state ? ` (carrier state ${booking.carrier_state})` : ""}${booking.booking_ref ? `, carrier reference ${booking.booking_ref}` : ""}.` : "No carrier booking.",
      `Contract: ${s.contract_type || "—"} ${s.contract_ref || ""}`.trim() + ".",
      report.whatWentWrong ? `What went wrong: ${report.whatWentWrong}` : "No problem was described when this file was made.",
      report.stepsToReproduce.length ? `Steps to reproduce: ${report.stepsToReproduce.map((x, i) => `${i + 1}. ${x}`).join(" ")}` : "",
      `This file holds the shipment row as stored (shipment), ${parts} (sections), related audit entries (entityEvents), `
        + `${refs.customers.length} customer record(s), ${refs.offices.length} office reference(s) (references), and ${n("shipment_documents")} document file(s) (files). `
        + "Every id is the production id; an import into a test system gives each record a new one.",
    ];
    return lines.filter(Boolean).join("\n");
  }

  // What the export dialog lists before the download: the parts with their counts, the files and the records it points at.
  async function contents(shipmentId) {
    const g = await gather(shipmentId);
    if (!g) return null;
    const refs = await referencesOf(g.s, g.sections);
    const files = (g.sections.shipment_documents || []).map(d => ({ filename: d.filename, docType: d.doc_type, sizeBytes: Number(d.size_bytes) || 0,
      onDisk: !!d.stored_name && fs.existsSync(path.join(UPLOADS_DIR, d.stored_name)) }));
    const rowBytes = JSON.stringify(g.sections).length + JSON.stringify(g.s).length;
    const fileBytes = files.reduce((a, f) => a + (f.onDisk ? f.sizeBytes : 0), 0);
    return {
      shipmentId, parts: Object.entries(g.sections).map(([table, rows]) => ({ table, label: LABEL[table] || table, count: rows.length })),
      context: Object.entries(g.context).map(([table, rows]) => ({ table, count: rows.length })),
      files, references: { customers: refs.customers.map(c => ({ name: c.name, roles: c.roles, countryIso2: c.record?.countryIso2 || "" })),
        offices: refs.offices.map(o => ({ code: o.code, name: o.name, roles: o.roles })), carriers: refs.carriers, ports: refs.ports,
        vessels: refs.vessels.map(v => v.name), contract: refs.contract.reference },
      estimatedBytes: Math.round(rowBytes * 1.2 + fileBytes * 4 / 3),
    };
  }

  async function exportShipment(shipmentId, user, { whatWentWrong = "", steps = [], host = "" } = {}) {
    const g = await gather(shipmentId);
    if (!g) return { error: "Shipment not found", status: 404 };
    const { s, sections, entityEvents, context } = g;
    const refs = await referencesOf(s, sections);
    const report = { whatWentWrong: String(whatWentWrong || "").trim().slice(0, 4000), stepsToReproduce: stepsOf(steps) };
    const files = [];
    for (const d of sections.shipment_documents || []) {
      const file = d.stored_name ? path.join(UPLOADS_DIR, d.stored_name) : "";
      const ok = file && fs.existsSync(file);
      files.push({ documentId: d.id, filename: d.filename, docType: d.doc_type, mimeType: d.mime_type || "", sizeBytes: Number(d.size_bytes) || 0,
        ...(ok ? { base64: fs.readFileSync(file).toString("base64") } : { missing: true }) });
    }
    const exportedAt = nowIso();
    const file = {
      format: FORMAT, cargodeskVersion: VERSION,
      source: { system: process.env.NODE_ENV === "production" ? "production" : (process.env.NODE_ENV || "development"), host: String(host || ""),
        shipmentId: s.id, exportedAt, exportedBy: { name: user?.name || "", email: user?.email || "" } },
      report,
      summary: summaryOf(s, sections, refs, report),
      shipment: s, sections, entityEvents, context, references: refs, files,
    };
    await logAdminEvent(user, "SHIPMENT_EXPORTED", "shipment", s.id,
      { parts: Object.fromEntries(Object.entries(sections).map(([t, r]) => [t, r.length])), files: files.length, withReport: !!report.whatWentWrong });
    return { file, filename: `${s.id}-for-QA-${exportedAt.slice(0, 10)}.json` };
  }

  // ─── Import ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  // Who may import: an admin (the route), on a server not in production mode, or in production while App Settings →
  // Shipment imports is on.
  async function importAllowed() {
    if (process.env.NODE_ENV !== "production") return true;
    return (await getSettings()).shipment_import_enabled === "true";
  }

  async function findCustomer(c) {
    const ids = (c.identifiers || []).filter(i => MATCH_ID_TYPES.includes(String(i.idType || "").toUpperCase()) && i.idCode);
    const name = String(c.record?.companyName || c.name || "").trim();
    if (await isRemoteCustomers()) {
      // The Customer Service has no identifier search: same name, then any of its identifiers, else the name alone.
      const found = name ? await callCustomerService("GET", `/internal/customers?search=${encodeURIComponent(name)}&limit=50`).catch(() => []) : [];
      const list = (Array.isArray(found) ? found : found?.results || []).filter(x => String(x.companyName || "").trim().toLowerCase() === name.toLowerCase());
      for (const x of list) {
        const theirs = await callCustomerService("GET", `/internal/customers/${x.id}/identifiers`).catch(() => []);
        const hit = ids.find(i => (theirs || []).some(t => String(t.idType).toUpperCase() === String(i.idType).toUpperCase() && String(t.idCode).toUpperCase() === String(i.idCode).toUpperCase()));
        if (hit) return { id: x.id, name: x.companyName, by: `same ${String(hit.idType).toUpperCase()} ${hit.idCode}` };
      }
      return list[0] ? { id: list[0].id, name: list[0].companyName, by: "same name" } : null;
    }
    for (const i of ids) {
      const [hit] = await query(`SELECT c.id, c.company_name FROM customer_identifiers ci JOIN customers c ON c.id = ci.customer_id
        WHERE UPPER(ci.id_type)=$1 AND UPPER(ci.id_code)=$2 LIMIT 1`, [String(i.idType).toUpperCase(), String(i.idCode).toUpperCase()]);
      if (hit) return { id: hit.id, name: hit.company_name, by: `same ${String(i.idType).toUpperCase()} ${i.idCode}` };
    }
    if (!name) return null;
    const [byName] = await query("SELECT id, company_name FROM customers WHERE LOWER(TRIM(company_name))=$1 ORDER BY created_at LIMIT 1", [name.toLowerCase()]);
    return byName ? { id: byName.id, name: byName.company_name, by: "same name" } : null;
  }

  // Removes customer copies an import made (its identifiers and contacts first: no cascade). → the ones still there.
  async function removeCustomers(list) {
    const left = [];
    for (const c of list) {
      try {
        if (await isRemoteCustomers()) await callCustomerService("DELETE", `/internal/customers/${c.id}`);
        else {
          await query("DELETE FROM customer_identifiers WHERE customer_id=$1", [c.id]);
          await query("DELETE FROM customer_contacts WHERE customer_id=$1", [c.id]);
          await query("DELETE FROM customers WHERE id=$1", [c.id]);
        }
      } catch (e) { console.error(`Import: couldn't remove customer copy ${c.id}:`, e.message); left.push(c); }
    }
    return left;
  }

  async function createCustomer(c, note) {
    const r = c.record || {};
    const notes = [String(r.notes || "").trim(), note].filter(Boolean).join("\n\n");
    if (await isRemoteCustomers()) {
      const body = Object.fromEntries(CUSTOMER_COLUMNS.map(([k]) => [k, r[k]]).filter(([, v]) => v !== undefined));
      const created = await callCustomerService("POST", "/internal/customers", { ...body, notes, parentCustomerId: null });
      for (const i of c.identifiers || []) await callCustomerService("POST", `/internal/customers/${created.id}/identifiers`,
        { idType: i.idType, idCode: i.idCode, countryIso2: i.countryIso2 || "", label: i.label || "", isPrimary: !!i.isPrimary }).catch(() => null);
      for (const k of c.contacts || []) await callCustomerService("POST", `/internal/customers/${created.id}/contacts`,
        { name: k.name, title: k.title || "", email: k.email || "", phone: k.phone || "", department: k.department || "Other", isPrimary: !!k.isPrimary }).catch(() => null);
      return created.id;
    }
    const id = `CUS-${uid()}`;
    const cols = ["id", "created_at", ...CUSTOMER_COLUMNS.map(([, col]) => col)];
    const vals = [id, nowIso(), ...CUSTOMER_COLUMNS.map(([k]) => (k === "notes" ? notes : k === "companyName" ? String(r.companyName || c.name || "Imported customer") : (r[k] ?? null)))];
    await query(`INSERT INTO customers (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals);
    const dg = r.dgEmergencyContact;
    if (dg) await query("UPDATE customers SET dg_emergency_contact=$1, dg_emergency_phone=$2, dg_emergency_provider=$3, dg_emergency_reference=$4 WHERE id=$5",
      [dg.contact || "", dg.phone || "", dg.provider || "", dg.referenceNumber || "", id]);
    for (const i of c.identifiers || []) await query(`INSERT INTO customer_identifiers (id, customer_id, id_type, id_code, country_iso2, label, is_primary, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [`CID-${uid()}`, id, i.idType, i.idCode, i.countryIso2 || "", i.label || "", !!i.isPrimary, nowIso()]);
    for (const k of c.contacts || []) await query(`INSERT INTO customer_contacts (id, customer_id, name, title, email, phone, department, is_primary, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [`CON-${uid()}`, id, k.name, k.title || "", k.email || "", k.phone || "", k.department || "Other", !!k.isPrimary, nowIso()]);
    return id;
  }

  const officeHere = async (code, department) => {
    if (!code) return null;
    const [o] = await query(`SELECT id, code, name, department FROM offices WHERE code=$1 ${department ? "AND department=$2" : ""}
      ORDER BY is_active DESC LIMIT 1`, department ? [code, department] : [code]);
    return o || null;
  };
  const officeById = async id => (id ? (await query("SELECT id, code, name, department, is_active FROM offices WHERE id=$1", [id]))[0] || null : null);

  // Read the file and work out what it points at in this system. → { problems, plan } (problems refuse the import).
  async function plan(file, { officeMap = {} } = {}) {
    const problems = [], warnings = [];
    if (!file || typeof file !== "object" || file.format !== FORMAT || !file.shipment?.id || typeof file.sections !== "object")
      return { problems: ["This isn't a CargoDesk shipment export (format cargodesk-shipment-export/1)"], plan: null };
    const version = { file: String(file.cargodeskVersion || ""), here: VERSION, ok: cmpVersion(file.cargodeskVersion, VERSION) <= 0 };
    if (!version.ok) problems.push(`The file was made by CargoDesk ${version.file}, newer than this system's ${VERSION}: update this system first`);
    const refs = file.references || {};
    // Offices: found here by code (and department), else the importer's choice; the export and import offices are needed.
    const offices = [];
    for (const o of refs.offices || []) {
      const required = o.roles.includes("export") || o.roles.includes("import");
      const dept = o.roles.includes("export") ? "SE" : o.roles.includes("import") ? "SI" : (o.department || null);
      const here = await officeHere(o.code, dept);
      const role = o.roles.includes("export") ? "export" : o.roles.includes("import") ? "import" : null;
      let chosen = null;
      if (!here && role && officeMap[role]) {
        const c = await officeById(officeMap[role]);
        if (!c) problems.push(`The ${role} office picked isn't in this system`);
        else if (c.department !== dept) problems.push(`${c.code} isn't an ${role} office (department ${dept})`);
        else chosen = c;
      }
      const use = here || chosen;
      if (!use && required) problems.push(`The ${role} office ${o.code || o.id} ${o.name ? `(${o.name}) ` : ""}isn't in this system: choose one of its ${role} offices`);
      if (!use && !required) warnings.push(`Office ${o.code || o.id} (${o.roles.join(", ")}) isn't in this system: left off`);
      offices.push({ oldId: o.id, code: o.code, name: o.name, roles: o.roles, department: dept, required, role,
        found: here ? { id: here.id, code: here.code, name: here.name } : null, chosen: chosen ? { id: chosen.id, code: chosen.code, name: chosen.name } : null });
    }
    // Carrier offices (§8.53): found here by carrier and name; else the shipment keeps their names only.
    const carrierOffices = [];
    for (const o of refs.carrierOffices || []) {
      const [here] = await query("SELECT id, name FROM carrier_offices WHERE carrier_code=$1 AND LOWER(name)=LOWER($2) ORDER BY is_active DESC LIMIT 1",
        [o.carrierCode, o.name]).catch(() => []);
      if (!here) warnings.push(`Carrier office ${o.name} (${o.carrierCode}) isn't in this system: the shipment keeps its name only`);
      carrierOffices.push({ oldId: o.id, carrierCode: o.carrierCode, name: o.name, found: here ? { id: here.id, name: here.name } : null });
    }
    // Customers: matched by number, then name; otherwise created as a copy marked IMPORTED.
    const customers = [];
    for (const c of refs.customers || []) {
      if (c.missing) { warnings.push(`Customer ${c.id} wasn't in the export (deleted in production?): its references are left empty`); continue; }
      const match = await findCustomer(c);
      customers.push({ oldId: c.id, name: c.record?.companyName || c.name, countryIso2: c.record?.countryIso2 || "", roles: c.roles, match,
        identifiers: (c.identifiers || []).map(i => `${i.idType} ${i.idCode}`), contacts: (c.contacts || []).length });
    }
    // Reference data: reported, never created.
    const mdm = [];
    for (const code of refs.carriers || []) mdm.push({ kind: "Carrier", value: code, found: !!(await query("SELECT 1 FROM carriers WHERE code=$1", [code]).catch(() => []))[0] });
    for (const code of refs.ports || []) mdm.push({ kind: "Port", value: code, found: !!(await query("SELECT 1 FROM port_locations WHERE unlocode=$1", [code]).catch(() => []))[0] });
    for (const v of refs.vessels || []) mdm.push({ kind: "Vessel", value: v.name, found: !!(await query("SELECT 1 FROM vessels WHERE UPPER(name)=UPPER($1) OR (imo=$2 AND $2<>'')", [v.name, v.imo || ""]).catch(() => []))[0] });
    if (refs.commodity) mdm.push({ kind: "Commodity", value: refs.commodity, found: !!(await query("SELECT 1 FROM commodities WHERE code=$1", [refs.commodity]).catch(() => []))[0] });
    for (const m of mdm) if (!m.found) warnings.push(`${m.kind} ${m.value} isn't in this system's master data: the shipment keeps it as written`);
    // Records it names that live elsewhere: kept when this system has them (same id), else left off.
    const kept = {};
    const has = async (sql, v) => !!v && !!(await query(sql, [v]).catch(() => []))[0];
    kept.contract = await has("SELECT 1 FROM contracts WHERE id=$1", refs.contract?.id);
    kept.allocation = await has("SELECT 1 FROM allocations WHERE id=$1", refs.allocation);
    kept.laneSteering = await has("SELECT 1 FROM lane_steerings WHERE id=$1", refs.laneSteering);
    kept.quote = await has("SELECT 1 FROM quotes WHERE id=$1", refs.quote);
    if (refs.contract?.id && !kept.contract) warnings.push(`Contract ${refs.contract.reference || refs.contract.id} isn't in this system: the shipment keeps its reference only`);
    if (refs.allocation && !kept.allocation) warnings.push("Its space configuration isn't in this system: left off");
    const counts = Object.entries(file.sections || {}).map(([table, rows]) => {
      const count = Array.isArray(rows) ? rows.length : 0;
      return { table, label: LABEL[table] || table, count, text: countText(table, count) };
    });
    const files = (file.files || []).map(f => ({ filename: f.filename, docType: f.docType, sizeBytes: f.sizeBytes || 0, included: !!f.base64 }));
    for (const f of files) if (!f.included) warnings.push(`${f.filename} wasn't on disk in production: its record comes without the file`);
    return {
      problems,
      plan: {
        source: file.source || {}, report: file.report || { whatWentWrong: "", stepsToReproduce: [] }, summary: file.summary || "", version,
        shipment: { id: file.shipment.id, status: file.shipment.status, route: `${file.shipment.pol} → ${file.shipment.pod}`, carrier: file.shipment.carrier_code || "",
          shipper: file.shipment.shipper_name || "", consignee: file.shipment.consignee_name || "" },
        offices, carrierOffices, customers, mdm, kept, counts, files, warnings,
        officeChoices: {
          export: await query("SELECT id, code, name FROM offices WHERE department='SE' AND is_active=TRUE ORDER BY code"),
          import: await query("SELECT id, code, name FROM offices WHERE department='SI' AND is_active=TRUE ORDER BY code"),
        },
      },
    };
  }

  async function freshShipmentId() {
    for (let i = 0; i < 20; i++) {
      const id = `SHP-${uid()}`;
      if (!(await query("SELECT 1 FROM shipments WHERE id=$1", [id]))[0]) return id;
    }
    throw new Error("Couldn't find a free shipment id");
  }
  const newIdLike = old => {
    const m = /^([A-Za-z]+-)/.exec(old);
    return `${m ? m[1] : ""}${uid()}${uid()}`;
  };

  async function importShipment(file, { officeMap = {} } = {}, user) {
    const { problems, plan: p } = await plan(file, { officeMap });
    if (problems.length) return { error: problems.join("; "), status: 409, problems, plan: p };
    const src = file.shipment;
    const note = `Imported from ${file.source?.system || "another system"} with shipment ${src.id} on ${fmtDay(nowIso())}.`;
    const map = new Map();          // old id → new id (text)
    const dropTo = new Set();       // old ids whose references are emptied (an office left off, a missing customer)
    const createdCustomers = [];
    // Customers first: matched, else created.
    try {
      for (const c of p.customers) {
        if (c.match) { map.set(c.oldId, c.match.id); continue; }
        const full = (file.references.customers || []).find(x => x.id === c.oldId);
        const id = await createCustomer(full, note);
        map.set(c.oldId, id);
        createdCustomers.push({ id, name: c.name });
      }
    } catch (e) {
      const left = await removeCustomers(createdCustomers);
      return { error: `The import failed while copying its customers and nothing was saved: ${e.message}${left.length ? ` (${left.length} copy not removed: ${left.map(c => c.name).join(", ")})` : ""}`, status: 500 };
    }
    for (const c of file.references.customers || []) if (c.missing) dropTo.add(c.id);
    for (const o of p.offices) {
      const use = o.found || o.chosen;
      if (use) map.set(o.oldId, use.id); else dropTo.add(o.oldId);
    }
    for (const o of p.carrierOffices || []) { if (o.found) map.set(o.oldId, o.found.id); else dropTo.add(o.oldId); }
    const newShipmentId = await freshShipmentId();
    map.set(src.id, newShipmentId);
    // A new id for every record in the file that has one.
    const sections = file.sections || {};
    for (const rows of [...Object.values(sections), file.entityEvents || []]) for (const r of rows || []) if (typeof r.id === "string" && r.id && !map.has(r.id)) map.set(r.id, newIdLike(r.id));
    // An eBL surrender request's reference is unique across the whole table (audit Q3): a new one, rewritten in the
    // request JSON and the B/L events too, so a file imports again or beside its original.
    for (const r of sections.ebl_surrender_requests || []) if (r.surrender_request_reference && !map.has(r.surrender_request_reference)) map.set(r.surrender_request_reference, crypto.randomUUID());
    // Rewrite references inside text too (meta JSON, notes, file names): the longest ids first.
    const textIds = [...map.keys()].filter(k => k.length >= 6).sort((a, b) => b.length - a.length);
    const idRe = textIds.length ? new RegExp(textIds.map(escapeRe).join("|"), "g") : null;
    const rewrite = v => {
      if (v == null) return v;
      if (typeof v === "string") {
        if (map.has(v)) return map.get(v);
        if (dropTo.has(v)) return null;
        return idRe ? v.replace(idRe, m => map.get(m)) : v;
      }
      if (typeof v === "object" && !(v instanceof Date)) return JSON.parse(JSON.stringify(v).replace(idRe || /$^/, m => map.get(m)));
      return v;
    };
    // The files: every document gets a stored name the import makes (audit Q1: never the file's own, which could point
    // anywhere on the server); one whose bytes the file doesn't carry gets a name with no file behind it (download 404).
    const storedName = new Map();
    const written = [];
    const freshName = filename => {
      const ext = path.extname(String(filename || ""));
      return `${Date.now()}_${uid()}${uid()}${/^\.[A-Za-z0-9]{1,8}$/.test(ext) ? ext : ".pdf"}`;
    };
    for (const d of sections.shipment_documents || []) storedName.set(d.id, freshName(d.filename));
    const dropped = [];
    const unknownColumns = new Set();
    const newIdsOf = {};   // table → Set of new ids written
    try {
      for (const f of file.files || []) {
        if (!f.base64 || !storedName.has(f.documentId)) continue;
        const name = storedName.get(f.documentId);
        fs.writeFileSync(path.join(UPLOADS_DIR, name), Buffer.from(f.base64, "base64"));
        written.push(name);
      }
      await transaction(async tx => {
        const insert = async (table, row) => {
          const sch = await schemaOf(table);
          if (!sch.exists) { dropped.push(`${table} (no such table here)`); return; }
          const cols = [], vals = [];
          for (const [k, v] of Object.entries(row)) {
            const c = sch.columns.get(k);
            if (!c) { unknownColumns.add(`${table}.${k}`); continue; }
            if (c.serial && typeof v === "number") continue;   // a number the sequence gives here
            cols.push(k);
            vals.push(v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && /json/.test(c.type) ? JSON.stringify(v) : v);
          }
          await tx.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, vals);
        };
        // A foreign key to a record that isn't in the file and isn't here: emptied when it may be, else the row is left off.
        const fixForeignKeys = async (table, row) => {
          const sch = await schemaOf(table);
          // A required column emptied by the import (an office or customer left off) leaves the row off.
          for (const [k, v] of Object.entries(row)) { const c = sch.columns.get(k); if (v === null && c && !c.nullable && !c.serial) return false; }
          for (const fk of sch.fks) {
            const v = row[fk.column_name];
            if (v == null || v === "") continue;
            if (newIdsOf[fk.ref_table]?.has(v)) continue;
            if ((await tx.query(`SELECT 1 FROM ${fk.ref_table} WHERE ${fk.ref_col}=$1`, [v]))[0]) continue;
            if (sch.columns.get(fk.column_name)?.nullable) row[fk.column_name] = null;
            else return false;
          }
          return true;
        };
        // The shipment.
        const ship = {};
        for (const [k, v] of Object.entries(src)) ship[k] = rewrite(v);
        ship.id = newShipmentId;
        for (const col of ["shipper_id", "consignee_id", "principal_id", "notify_id", "emo_office_id", "imo_office_id", "controlling_office_id", "billing_office_id"])
          if (src[col] && !map.has(src[col])) ship[col] = null;
        if (!p.kept.contract) { ship.contract_id = null; ship.contract_routing_id = ""; }
        if (!p.kept.allocation) ship.allocation_id = null;
        if (!p.kept.laneSteering) ship.steering_line_id = null;
        if (!p.kept.quote) ship.source_quote_id = null;
        ship.imported_from = src.id;
        ship.imported_meta = JSON.stringify({ system: file.source?.system || "", host: file.source?.host || "", sourceId: src.id,
          exportedAt: file.source?.exportedAt || "", exportedBy: file.source?.exportedBy || {}, cargodeskVersion: file.cargodeskVersion || "",
          importedAt: nowIso(), importedBy: actorOf(user), report: file.report || {}, summary: file.summary || "" });
        await insert("shipments", ship);
        newIdsOf.shipments = new Set([newShipmentId]);
        // Everything that hangs off it, in order.
        for (const part of PARTS) {
          let rows = (sections[part.table] || []).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, rewrite(v)])));
          if (!rows.length) continue;
          if (part.table === "container_packages") rows = [...rows.filter(r => !r.parent_id), ...rows.filter(r => r.parent_id)];
          if (part.table === "shipment_documents") rows = rows.map((r, i) => ({ ...r, stored_name: storedName.get(sections.shipment_documents[i].id) }));
          newIdsOf[part.table] = newIdsOf[part.table] || new Set();
          for (const row of rows) {
            if (!(await fixForeignKeys(part.table, row))) { dropped.push(`${LABEL[part.table] || part.table} ${row.id || ""}`.trim()); continue; }
            await insert(part.table, row);
            if (typeof row.id === "string") newIdsOf[part.table].add(row.id);
          }
        }
        for (const e of file.entityEvents || []) await insert("entity_events", Object.fromEntries(Object.entries(e).map(([k, v]) => [k, rewrite(v)])));
      });
    } catch (e) {
      for (const n of written) { try { fs.unlinkSync(path.join(UPLOADS_DIR, n)); } catch { /* best effort */ } }
      // The customer copies made for this import go too (audit Q4): they were created before the transaction.
      const left = await removeCustomers(createdCustomers);
      return { error: left.length
        ? `The import failed and the shipment wasn't saved: ${e.message}. ${left.length} customer cop${left.length === 1 ? "y" : "ies"} it made couldn't be removed: ${left.map(c => c.name).join(", ")}`
        : `The import failed and nothing was saved: ${e.message}`, status: 500 };
    }
    await logEvent(newShipmentId, "SHIPMENT_IMPORTED", "imported_from", null, src.id,
      JSON.stringify({ system: file.source?.system || "", exportedAt: file.source?.exportedAt || "", exportedBy: file.source?.exportedBy?.name || "",
        whatWentWrong: file.report?.whatWentWrong || "" }), actorOf(user));
    await logAdminEvent(user, "SHIPMENT_IMPORTED", "shipment", newShipmentId, { from: src.id, system: file.source?.system || "", createdCustomers: createdCustomers.map(c => c.name) });
    return { shipmentId: newShipmentId, from: src.id, createdCustomers, dropped, warnings: [...p.warnings, ...[...unknownColumns].map(c => `${c} isn't in this system: left off`)] };
  }

  return { contents, exportShipment, plan, importShipment, importAllowed, FORMAT, PARTS, LABEL };
}

module.exports = createShipmentTransfer;
module.exports.FORMAT = FORMAT;
module.exports.cmpVersion = cmpVersion;
