"use strict";

// Carrier offices (2026-11-16, ARCHITECTURE.md §8.53), built once as ctx.carrierOffices.
//
// A carrier's profile, kept on the carrier's own record (Master Data → Carriers), as CargoWise keeps a carrier's
// addresses and appointed-agent ports on its organisation and SAP / Oracle keep a vendor's partner functions / sites
// on the vendor:
// - carrier_offices: the carrier's own offices and subsidiaries (name, its own UN/LOCODE, address, contact, the
//   creditor code our finance system knows it by, capabilities, working hours). Its own records, never customers (the
//   August 2026 decision).
// - carrier_office_coverage: which office acts where, per role and direction. Roles: booking (export: who takes our
//   booking), import (import: who handles the arrival) and billing (either side: the carrier company that invoices
//   us, its creditor subsidiary). A row for a port beats a row for its country, per role; linked ports are the last
//   resort, and two offices found only that way are left for a person to pick.
// - carrier_account_numbers: our customer number at the carrier per legal entity of ours (branch), sent on the
//   booking agent as DCSA identifyingCodes (provider ZZZ, "mutually defined"; Maersk Booking v2 checks it).
//
// A shipment keeps a copy of its offices (shipment_carrier_offices, roles booking / billing_origin / import /
// billing_destination), picked from the coverage when it's created and again when the carrier or a port changes;
// the export side's OCC/BK and the import side can pick another office of the same carrier. Master data changes
// never rewrite a shipment's copy (SAP, Oracle, CargoWise alike), and nothing is resent to the carrier by itself.
// With no billing row, the booking office bills the export side and the import office the import side, worked out
// when it's read (SAP falls back to the ordering vendor, Oracle to the purchase order's site).

const UNLOCODE = /^[A-Z]{2}[A-Z2-9]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const COVERAGE_ROLES = ["booking", "import", "billing"];
const DIRECTIONS = ["export", "import"];
// The shipment's four offices: what each reads in the coverage and which port decides it.
const SHIPMENT_ROLES = {
  booking:             { role: "booking", direction: "export", port: "pol", side: "Export", label: "Carrier booking office" },
  billing_origin:      { role: "billing", direction: "export", port: "pol", side: "Export", label: "Carrier billing · origin" },
  import:              { role: "import",  direction: "import", port: "pod", side: "Import", label: "Carrier import office" },
  billing_destination: { role: "billing", direction: "import", port: "pod", side: "Import", label: "Carrier billing · destination" },
};
const SHIPMENT_ROLE_KEYS = Object.keys(SHIPMENT_ROLES);
// A billing role with no office of its own falls back to the office that acts on its side.
const BILLING_FALLBACK = { billing_origin: "booking", billing_destination: "import" };
const ROLE_LABEL = { booking: "Booking", import: "Import office", billing: "Billing" };
// What an office can do: checked against a shipment's own haulage and services before its booking is sent.
const CAPABILITY_CODES = [
  "port_agency", "documentation", "customs_clearance",
  "road_haulage", "rail_haulage", "barge_haulage",
  "warehousing", "cy_storage", "fumigation", "empty_equipment",
];
const CAPABILITY_LABELS = {
  port_agency: "Port Agency", documentation: "Documentation", customs_clearance: "Customs Clearance",
  road_haulage: "Road Haulage", rail_haulage: "Rail Haulage", barge_haulage: "Barge Haulage",
  warehousing: "Warehousing", cy_storage: "CY Storage", fumigation: "Fumigation", empty_equipment: "Empty Equipment",
};
const HAULAGE_MODE_TO_CAPABILITY = { Truck: "road_haulage", Rail: "rail_haulage", Barge: "barge_haulage" };
const SERVICE_TYPE_TO_CAPABILITY = { "Customs Clearance": "customs_clearance", Warehousing: "warehousing", "CY Storage": "cy_storage", Fumigation: "fumigation" };
const SCHEDULE_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const LEGACY_LINE_AGENT_ROLES = { "Line Agent (Export)": "booking", "Line Agent (Import)": "import" };

const up = v => String(v ?? "").trim().toUpperCase();
const txt = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const parseJson = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch { return fallback; } };

function validateHours(rows) {
  if (!Array.isArray(rows)) return "rows must be an array";
  const seen = new Set();
  for (const row of rows) {
    if (!Array.isArray(row.days) || row.days.length === 0) return "Each row needs at least one day";
    for (const d of row.days) {
      if (!SCHEDULE_DAYS.includes(d)) return `Invalid day: ${d}`;
      if (seen.has(d)) return `${d} appears in more than one row — a day can only belong to one row`;
      seen.add(d);
    }
    if (!row.startTime || !row.endTime) return "Each row needs a start and end time";
    if (row.startTime >= row.endTime) return "Start time must be before end time";
  }
  return null;
}

function createCarrierOffices(ctx) {
  const { query, transaction, uid, logEvent, logEntityEvent, getSettings, portCountryMap, linkedPortCodes, getCustomerRow, callMdmService } = ctx;
  const nowIso = () => new Date().toISOString();

  // ─── Mapping ───────────────────────────────────────────────────────────────
  const mapOffice = (r, hours = []) => ({
    id: r.id, carrierCode: r.carrier_code, name: r.name, unlocode: r.unlocode || "",
    address1: r.address1 || "", address2: r.address2 || "", city: r.city || "", postalCode: r.postal_code || "", countryIso2: r.country_iso2 || "",
    contactName: r.contact_name || "", contactPhone: r.contact_phone || "", contactEmail: r.contact_email || "",
    creditorCode: r.creditor_code || "", capabilities: parseJson(r.capabilities, []), note: r.note || "",
    isActive: r.is_active !== false, legacyAgentId: r.legacy_agent_id || "", createdAt: r.created_at, updatedAt: r.updated_at || "",
    hours: hours.map(h => ({ id: h.id, days: parseJson(h.days, []), startTime: h.start_time, endTime: h.end_time })),
  });
  const mapCoverage = r => ({
    id: r.id, carrierCode: r.carrier_code, officeId: r.office_id, officeName: r.office_name || "",
    placeType: r.place_type, unlocode: r.unlocode || "", countryIso2: r.country_iso2 || "",
    place: r.place_type === "country" ? r.country_iso2 : r.unlocode, placeName: r.place_name || "",
    direction: r.direction, role: r.role, createdAt: r.created_at,
  });

  // ─── Ports and countries: the port→country map first (built from wherever Master Data lives), then Master Data
  // itself: the MDM service when mdm_source is remote, else the local tables ──────────────
  const remoteMdm = async () => ((await getSettings()).mdm_source || "local") === "remote" && !!callMdmService;
  async function portRow(code) {
    if (await remoteMdm()) {
      try { const p = await callMdmService("GET", `/internal/port-locations/${encodeURIComponent(code)}`); return p ? { country: p.countryCode || "", name: p.name || "" } : null; }
      catch { return null; }
    }
    const [r] = await query("SELECT country_code, name FROM port_locations WHERE unlocode=$1", [code]).catch(() => []);
    return r ? { country: r.country_code || "", name: r.name || "" } : null;
  }
  async function countryOfPort(code) {
    if (portCountryMap && portCountryMap[code]) return portCountryMap[code];
    return (await portRow(code))?.country || "";
  }
  async function portKnown(code) {
    if (portCountryMap && portCountryMap[code] !== undefined) return true;
    return !!(await portRow(code));
  }
  async function portNames(codes) {
    const list = [...new Set(codes.filter(Boolean))];
    if (!list.length) return new Map();
    const rows = await query("SELECT unlocode, name FROM port_locations WHERE unlocode = ANY($1)", [list]).catch(() => []);
    const names = new Map(rows.map(r => [r.unlocode, r.name]));
    if (names.size < list.length && await remoteMdm())
      for (const c of list.filter(x => !names.has(x))) { const p = await portRow(c); if (p?.name) names.set(c, p.name); }
    return names;
  }

  // ─── Reading the profile ────────────────────────────────────────────────────
  async function officesOf(carrierCode, { activeOnly = false } = {}) {
    const rows = await query(`SELECT * FROM carrier_offices WHERE carrier_code=$1 ${activeOnly ? "AND is_active=TRUE" : ""} ORDER BY name`, [up(carrierCode)]);
    if (!rows.length) return [];
    const hours = await query("SELECT * FROM carrier_office_hours WHERE office_id = ANY($1) ORDER BY sort_order", [rows.map(r => r.id)]);
    return rows.map(r => mapOffice(r, hours.filter(h => h.office_id === r.id)));
  }
  async function officeById(id) {
    if (!id) return null;
    const [r] = await query("SELECT * FROM carrier_offices WHERE id=$1", [id]);
    if (!r) return null;
    const hours = await query("SELECT * FROM carrier_office_hours WHERE office_id=$1 ORDER BY sort_order", [id]);
    return mapOffice(r, hours);
  }
  async function coverageOf(carrierCode) {
    const rows = await query(`SELECT c.*, o.name AS office_name FROM carrier_office_coverage c
      JOIN carrier_offices o ON o.id = c.office_id WHERE c.carrier_code=$1
      ORDER BY c.direction, c.role, c.place_type DESC, COALESCE(c.unlocode, c.country_iso2)`, [up(carrierCode)]);
    const names = await portNames(rows.map(r => r.unlocode));
    const countries = await query("SELECT iso2, name FROM countries WHERE iso2 = ANY($1)", [[...new Set(rows.map(r => r.country_iso2).filter(Boolean))]]).catch(() => []);
    const cn = new Map(countries.map(c => [c.iso2, c.name]));
    return rows.map(r => mapCoverage({ ...r, place_name: r.place_type === "country" ? cn.get(r.country_iso2) || "" : names.get(r.unlocode) || "" }));
  }
  async function accountNumbersOf(carrierCode) {
    const rows = await query("SELECT * FROM carrier_account_numbers WHERE carrier_code=$1", [up(carrierCode)]);
    // Active legal entities, and any inactive one that still has a number here.
    const branches = await query("SELECT id, code, name, country_code FROM branches WHERE is_active = TRUE OR id = ANY($1) ORDER BY name",
      [rows.map(r => r.branch_id)]).catch(() => []);
    const byBranch = new Map(rows.map(r => [r.branch_id, r]));
    return branches.map(b => ({ branchId: b.id, branchCode: b.code || "", branchName: b.name, countryCode: b.country_code || "",
      accountNumber: byBranch.get(b.id)?.account_number || "" }));
  }
  // Kept beside the profile, not on carriers (that table belongs to the MDM service when Master Data is remote).
  async function codeListNameOf(carrierCode) {
    const [s] = await query("SELECT value FROM carrier_profile_settings WHERE carrier_code=$1 AND key='account_code_list_name'", [up(carrierCode)]);
    return s?.value || "";
  }
  async function profile(carrierCode) {
    const code = up(carrierCode);
    const integrations = await query("SELECT carrier_code, adapter_key, is_active, capabilities FROM carrier_integrations WHERE carrier_code=$1", [code]).catch(() => []);
    return {
      carrierCode: code,
      offices: await officesOf(code),
      coverage: await coverageOf(code),
      accountNumbers: await accountNumbersOf(code),
      codeListName: await codeListNameOf(code),
      connection: integrations.map(i => ({ adapterKey: i.adapter_key, isActive: i.is_active !== false, capabilities: parseJson(i.capabilities, []) })),
    };
  }

  // ─── Writing the profile ────────────────────────────────────────────────────
  // Returns { error } or the cleaned office fields.
  function cleanOffice(body, existing = null) {
    const pick = (k, max) => (body[k] !== undefined ? txt(body[k], max) : existing ? existing[k] : "");
    const out = {
      name: pick("name", 70), unlocode: up(body.unlocode !== undefined ? body.unlocode : existing?.unlocode || ""),
      address1: pick("address1", 70), address2: pick("address2", 70), city: pick("city", 35), postalCode: pick("postalCode", 10),
      countryIso2: up(body.countryIso2 !== undefined ? body.countryIso2 : existing?.countryIso2 || ""),
      contactName: pick("contactName", 35), contactPhone: pick("contactPhone", 30), contactEmail: pick("contactEmail", 100),
      creditorCode: pick("creditorCode", 40), note: pick("note", 500),
      capabilities: body.capabilities !== undefined ? body.capabilities : existing?.capabilities || [],
      isActive: body.isActive !== undefined ? body.isActive !== false : existing ? existing.isActive : true,
    };
    if (!out.name) return { error: "The office needs a name" };
    // The office's own location: any well-formed UN/LOCODE (an inland office such as Madrid, ESMAD, isn't a port).
    if (!UNLOCODE.test(out.unlocode)) return { error: "The office's location must be a UN/LOCODE (5 characters, e.g. ESMAD)" };
    if (out.countryIso2 && !COUNTRY.test(out.countryIso2)) return { error: "The country must be a 2-letter ISO code" };
    if (out.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.contactEmail)) return { error: "The contact e-mail isn't valid" };
    if (!Array.isArray(out.capabilities) || out.capabilities.some(c => !CAPABILITY_CODES.includes(c)))
      return { error: "capabilities must be an array of known capability codes" };
    return out;
  }

  async function createOffice(carrierCode, body, actor) {
    const code = up(carrierCode);
    if (!code) return { error: "carrierCode required" };
    const o = cleanOffice(body || {});
    if (o.error) return o;
    if (body.hours !== undefined) { const bad = validateHours(body.hours); if (bad) return { error: bad }; }
    const id = `COF-${uid()}`;
    const now = nowIso();
    await transaction(async tx => {
      await tx.query(`INSERT INTO carrier_offices (id, carrier_code, name, unlocode, address1, address2, city, postal_code, country_iso2,
        contact_name, contact_phone, contact_email, creditor_code, capabilities, note, is_active, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
        [id, code, o.name, o.unlocode, o.address1, o.address2, o.city, o.postalCode, o.countryIso2, o.contactName, o.contactPhone,
          o.contactEmail, o.creditorCode, JSON.stringify(o.capabilities), o.note, o.isActive, now]);
      if (Array.isArray(body.hours)) await writeHours(tx.query, id, body.hours);
    });
    await logEntityEvent("carrier_office", id, "CREATED", null, null, o.name, JSON.stringify({ carrierCode: code, unlocode: o.unlocode }), actor);
    await logEntityEvent("carrier", code, "OFFICE_ADDED", "office", null, o.name, JSON.stringify({ officeId: id }), actor);
    return { office: await officeById(id) };
  }

  async function updateOffice(id, body, actor) {
    const existing = await officeById(id);
    if (!existing) return { error: "Not found", status: 404 };
    const o = cleanOffice(body || {}, existing);
    if (o.error) return o;
    if (body.hours !== undefined) { const bad = validateHours(body.hours); if (bad) return { error: bad }; }
    await transaction(async tx => {
      await tx.query(`UPDATE carrier_offices SET name=$1, unlocode=$2, address1=$3, address2=$4, city=$5, postal_code=$6, country_iso2=$7,
        contact_name=$8, contact_phone=$9, contact_email=$10, creditor_code=$11, capabilities=$12, note=$13, is_active=$14, updated_at=$15 WHERE id=$16`,
        [o.name, o.unlocode, o.address1, o.address2, o.city, o.postalCode, o.countryIso2, o.contactName, o.contactPhone, o.contactEmail,
          o.creditorCode, JSON.stringify(o.capabilities), o.note, o.isActive, nowIso(), id]);
      if (Array.isArray(body.hours)) await writeHours(tx.query, id, body.hours);
    });
    for (const [k, label] of [["name", "name"], ["unlocode", "location"], ["creditorCode", "creditor code"], ["isActive", "active"]]) {
      if (String(existing[k]) !== String(o[k]))
        await logEntityEvent("carrier_office", id, "UPDATED", label, String(existing[k]), String(o[k]), null, actor);
    }
    return { office: await officeById(id) };
  }

  async function writeHours(q, officeId, rows) {
    await q("DELETE FROM carrier_office_hours WHERE office_id=$1", [officeId]);
    const now = nowIso();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await q(`INSERT INTO carrier_office_hours (id, office_id, days, start_time, end_time, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [`COH-${uid()}`, officeId, JSON.stringify(r.days), r.startTime, r.endTime, i, now]);
    }
  }

  // An office still named by coverage, a shipment or a carrier invoice is set inactive instead (its name stays on them).
  async function removeOffice(id, actor) {
    const existing = await officeById(id);
    if (!existing) return { error: "Not found", status: 404 };
    const [cov] = await query("SELECT COUNT(*)::int AS n FROM carrier_office_coverage WHERE office_id=$1", [id]);
    const [shp] = await query("SELECT COUNT(*)::int AS n FROM shipment_carrier_offices WHERE office_id=$1", [id]);
    const [inv] = await query("SELECT COUNT(*)::int AS n FROM carrier_invoices WHERE issuing_office_id=$1", [id]);
    const uses = [cov.n && `${cov.n} coverage row${cov.n === 1 ? "" : "s"}`, shp.n && `${shp.n} shipment${shp.n === 1 ? "" : "s"}`,
      inv.n && `${inv.n} carrier invoice${inv.n === 1 ? "" : "s"}`].filter(Boolean);
    if (uses.length) return { error: `${existing.name} is used by ${uses.join(", ")}: set it inactive instead, so they keep its name.`, status: 409 };
    await query("DELETE FROM carrier_offices WHERE id=$1", [id]);
    await logEntityEvent("carrier", existing.carrierCode, "OFFICE_REMOVED", "office", existing.name, null, JSON.stringify({ officeId: id }), actor);
    return { deleted: id };
  }

  async function addCoverage(carrierCode, body, actor) {
    const code = up(carrierCode);
    const { placeType, direction, role, officeId } = body || {};
    if (placeType !== "unlocode" && placeType !== "country") return { error: "placeType must be 'unlocode' or 'country'" };
    if (!DIRECTIONS.includes(direction)) return { error: "direction must be 'export' or 'import'" };
    if (!COVERAGE_ROLES.includes(role)) return { error: "role must be 'booking', 'import' or 'billing'" };
    if (role === "booking" && direction !== "export") return { error: "The booking office covers exports only" };
    if (role === "import" && direction !== "import") return { error: "The import office covers imports only" };
    const office = await officeById(officeId);
    if (!office || office.carrierCode !== code) return { error: "Pick an office of this carrier" };
    if (!office.isActive) return { error: `${office.name} is inactive` };
    const unlocode = placeType === "unlocode" ? up(body.unlocode) : null;
    const country = placeType === "country" ? up(body.countryIso2) : null;
    if (placeType === "unlocode" && !(UNLOCODE.test(unlocode) && await portKnown(unlocode))) return { error: `Unknown port: ${body.unlocode || ""}` };
    if (placeType === "country") {
      if (!COUNTRY.test(country)) return { error: "The country must be a 2-letter ISO code" };
      let known;
      if (await remoteMdm()) {
        try { const list = await callMdmService("GET", "/internal/countries"); known = (Array.isArray(list) ? list : list?.results || []).some(c => c.iso2 === country); }
        catch { known = false; }
      }
      else known = !!(await query("SELECT 1 FROM countries WHERE iso2=$1", [country]).catch(() => []))[0];
      if (!known) return { error: `Unknown country: ${country}` };
    }
    const [dup] = await query(`SELECT c.id, o.name FROM carrier_office_coverage c JOIN carrier_offices o ON o.id = c.office_id
      WHERE c.carrier_code=$1 AND c.direction=$2 AND c.role=$3 AND c.place_type=$4 AND COALESCE(c.unlocode,'')=$5 AND COALESCE(c.country_iso2,'')=$6`,
      [code, direction, role, placeType, unlocode || "", country || ""]);
    if (dup) return { error: `${unlocode || country} already has a ${ROLE_LABEL[role].toLowerCase()} office for ${direction}s: ${dup.name}. Change that row instead.`, status: 409 };
    const id = `COV-${uid()}`;
    await query(`INSERT INTO carrier_office_coverage (id, carrier_code, office_id, place_type, unlocode, country_iso2, direction, role, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, code, office.id, placeType, unlocode, country, direction, role, nowIso()]);
    await logEntityEvent("carrier", code, "COVERAGE_ADDED", "coverage", null, `${unlocode || country} ${direction} ${role} → ${office.name}`, JSON.stringify({ coverageId: id }), actor);
    return { coverage: (await coverageOf(code)).find(c => c.id === id) };
  }

  async function updateCoverage(id, { officeId }, actor) {
    const [row] = await query("SELECT * FROM carrier_office_coverage WHERE id=$1", [id]);
    if (!row) return { error: "Not found", status: 404 };
    const office = await officeById(officeId);
    if (!office || office.carrierCode !== row.carrier_code) return { error: "Pick an office of this carrier" };
    if (!office.isActive) return { error: `${office.name} is inactive` };
    await query("UPDATE carrier_office_coverage SET office_id=$1 WHERE id=$2", [office.id, id]);
    await logEntityEvent("carrier", row.carrier_code, "COVERAGE_CHANGED", "coverage", row.office_id, office.id,
      JSON.stringify({ coverageId: id, place: row.unlocode || row.country_iso2, direction: row.direction, role: row.role }), actor);
    return { coverage: (await coverageOf(row.carrier_code)).find(c => c.id === id) };
  }

  async function removeCoverage(id, actor) {
    const [row] = await query("DELETE FROM carrier_office_coverage WHERE id=$1 RETURNING *", [id]);
    if (!row) return { error: "Not found", status: 404 };
    await logEntityEvent("carrier", row.carrier_code, "COVERAGE_REMOVED", "coverage", `${row.unlocode || row.country_iso2} ${row.direction} ${row.role}`, null,
      JSON.stringify({ coverageId: id, officeId: row.office_id }), actor);
    return { deleted: id };
  }

  // Full replace: our customer number per legal entity, and the name the carrier gives that code list.
  async function saveAccountNumbers(carrierCode, { numbers = [], codeListName }, actor) {
    const code = up(carrierCode);
    if (!Array.isArray(numbers)) return { error: "numbers must be an array" };
    const branches = new Set((await query("SELECT id FROM branches")).map(b => b.id));
    for (const n of numbers) {
      if (!branches.has(n.branchId)) return { error: `Unknown legal entity: ${n.branchId}` };
      if (txt(n.accountNumber, 151).length > 150) return { error: "An account number is at most 150 characters (DCSA partyCode)" };
    }
    const list = txt(codeListName, 101);
    if (list.length > 100) return { error: "The code list name is at most 100 characters (DCSA codeListName)" };
    const before = await accountNumbersOf(code);
    await transaction(async tx => {
      await tx.query("DELETE FROM carrier_account_numbers WHERE carrier_code=$1", [code]);
      for (const n of numbers) {
        const value = txt(n.accountNumber, 150);
        if (!value) continue;
        await tx.query("INSERT INTO carrier_account_numbers (id, carrier_code, branch_id, account_number, updated_at) VALUES ($1,$2,$3,$4,$5)",
          [`CAN-${uid()}`, code, n.branchId, value, nowIso()]);
      }
      if (codeListName !== undefined)
        await tx.query(`INSERT INTO carrier_profile_settings (carrier_code, key, value) VALUES ($1,'account_code_list_name',$2)
          ON CONFLICT (carrier_code, key) DO UPDATE SET value=EXCLUDED.value`, [code, list]);
    });
    const after = await accountNumbersOf(code);
    for (const a of after) {
      const b = before.find(x => x.branchId === a.branchId);
      if ((b?.accountNumber || "") !== a.accountNumber)
        await logEntityEvent("carrier", code, "ACCOUNT_NUMBER_CHANGED", a.branchName, b?.accountNumber || null, a.accountNumber || null, JSON.stringify({ branchId: a.branchId }), actor);
    }
    return { accountNumbers: after, codeListName: await codeListNameOf(code) };
  }

  // ─── The rule: which office acts for a role at a port ───────────────────────────
  // A row for the port beats a row for its country; with neither, the port's linked ports are tried, and only one
  // office found that way is taken (two are left for a person to pick, as the Line Agents were).
  async function candidatesFor(carrierCode, shipmentRole, port) {
    const spec = SHIPMENT_ROLES[shipmentRole];
    const code = up(carrierCode), p = up(port);
    if (!spec || !code || !p) return [];
    const rows = await query(`SELECT c.*, o.name AS office_name, o.unlocode AS office_unlocode FROM carrier_office_coverage c
      JOIN carrier_offices o ON o.id = c.office_id AND o.is_active = TRUE
      WHERE c.carrier_code=$1 AND c.role=$2 AND c.direction=$3`, [code, spec.role, spec.direction]);
    if (!rows.length) return [];
    const tryPort = async q => {
      const byPort = rows.find(r => r.place_type === "unlocode" && r.unlocode === q);
      if (byPort) return { row: byPort, why: `row for ${q}` };
      const country = await countryOfPort(q);
      const byCountry = country && rows.find(r => r.place_type === "country" && r.country_iso2 === country);
      return byCountry ? { row: byCountry, why: `row for ${country}` } : null;
    };
    const direct = await tryPort(p);
    if (direct) return [{ officeId: direct.row.office_id, officeName: direct.row.office_name, officeUnlocode: direct.row.office_unlocode, why: direct.why, via: p }];
    const linked = await (linkedPortCodes ? linkedPortCodes(p) : []);
    const found = [];
    for (const l of linked) {
      const hit = await tryPort(l);
      if (hit && !found.some(f => f.officeId === hit.row.office_id))
        found.push({ officeId: hit.row.office_id, officeName: hit.row.office_name, officeUnlocode: hit.row.office_unlocode, why: `${hit.why}, linked to ${p}`, via: l });
    }
    return found;
  }

  // The four offices for a carrier and ports, as the coverage gives them, with the billing fallback (the live check).
  async function check(carrierCode, { pol, pod }) {
    const out = {};
    for (const role of SHIPMENT_ROLE_KEYS) {
      const port = SHIPMENT_ROLES[role].port === "pol" ? pol : pod;
      const c = await candidatesFor(carrierCode, role, port);
      out[role] = c.length === 1 ? { ...c[0], source: "coverage" } : c.length > 1 ? { candidates: c } : null;
    }
    for (const [billing, from] of Object.entries(BILLING_FALLBACK))
      if (!out[billing] && out[from]?.officeId) out[billing] = { ...out[from], fallback: true, why: fallbackWhy(billing) };
    return out;
  }
  const fallbackWhy = billing => (billing === "billing_origin" ? "no billing row: the booking office bills" : "no billing row: the import office bills");

  // ─── The shipment's copy ─────────────────────────────────────────────────────
  async function storedRows(shipmentId) {
    return query("SELECT * FROM shipment_carrier_offices WHERE shipment_id=$1", [shipmentId]);
  }
  // The ports that decide its offices: the port of loading of its first sea leg and the port of discharge of its last
  // (shipments.pol/pod follow the first and last leg, which can be a pick-up or delivery place); its own pol/pod when it
  // has no sea leg yet.
  async function portsOf(s) {
    const legs = await query("SELECT leg_type, mot, pol, pod FROM shipment_legs WHERE shipment_id=$1 ORDER BY leg_order", [s.id]);
    const sea = legs.filter(l => (l.leg_type ? l.leg_type === "SEA" : l.mot === "SEA"));
    return { pol: up(sea[0]?.pol || s.pol), pod: up(sea[sea.length - 1]?.pod || s.pod) };
  }
  const keyOf = (carrier, ports) => `${up(carrier)}|${ports.pol}|${ports.pod}`;
  async function loadShipment(shipmentId) {
    const [s] = await query("SELECT id, carrier_code, pol, pod, carrier_offices_for, emo_office_id, imo_office_id FROM shipments WHERE id=$1", [shipmentId]);
    return s ? { ...s, ports: await portsOf(s) } : null;
  }

  // Picks the offices again from the coverage for the roles whose carrier or port changed (all of them for a new
  // shipment). A role the coverage can't settle (nothing, or two offices via linked ports) is emptied, since what it
  // held belonged to the old carrier or port. Logs only what changed.
  async function determine(shipmentId, { roles = SHIPMENT_ROLE_KEYS, actor = "" } = {}) {
    const s = await loadShipment(shipmentId);
    if (!s) return;
    const stored = new Map((await storedRows(shipmentId)).map(r => [r.role, r]));
    for (const role of roles) {
      const spec = SHIPMENT_ROLES[role];
      const port = s.ports[spec.port];
      const found = s.carrier_code && port ? await candidatesFor(s.carrier_code, role, port) : [];
      const before = stored.get(role);
      if (found.length === 1) {
        const c = found[0];
        if (before && before.office_id === c.officeId && before.source !== "manual") continue;
        await upsert(shipmentId, role, { officeId: c.officeId, officeName: c.officeName, officeUnlocode: c.officeUnlocode, source: "auto", reason: c.why, actor });
        // History only when the office changed (audit F3: a hand pick the coverage agrees with logged "X → X").
        if (before?.office_id !== c.officeId)
          await logEvent(shipmentId, "CARRIER_OFFICE_ASSIGNED", spec.label, before?.office_name || null, c.officeName,
            JSON.stringify({ role, carrierCode: s.carrier_code, port, why: c.why, via: c.via }), actor || null);
      } else if (before) {
        await query("DELETE FROM shipment_carrier_offices WHERE shipment_id=$1 AND role=$2", [shipmentId, role]);
        if (before.office_name)
          await logEvent(shipmentId, "CARRIER_OFFICE_CLEARED", spec.label, before.office_name, null,
            JSON.stringify({ role, carrierCode: s.carrier_code, port, candidates: found.length }), actor || null);
      }
    }
    await query("UPDATE shipments SET carrier_offices_for=$1 WHERE id=$2", [keyOf(s.carrier_code, s.ports), shipmentId]);
  }
  // After anything that may have moved its carrier or ports (an edit, a route save, a rebooking): picks again the roles
  // whose carrier or port changed since they were last picked, and nothing else.
  async function refresh(shipmentId, actor = "") {
    const s = await loadShipment(shipmentId);
    if (!s) return;
    const key = keyOf(s.carrier_code, s.ports);
    if (s.carrier_offices_for === key) return;
    if (s.carrier_offices_for == null) return determine(shipmentId, { actor });
    const [c0 = "", p0 = "", d0 = ""] = String(s.carrier_offices_for).split("|");
    const roles = rolesFor({ carrier: c0 !== up(s.carrier_code), pol: p0 !== s.ports.pol, pod: d0 !== s.ports.pod });
    return determine(shipmentId, { roles, actor });
  }
  // The roles a change of carrier, port of loading or port of discharge calls for.
  const rolesFor = ({ carrier, pol, pod }) => (carrier ? SHIPMENT_ROLE_KEYS
    : [...(pol ? ["booking", "billing_origin"] : []), ...(pod ? ["import", "billing_destination"] : [])]);

  async function upsert(shipmentId, role, { officeId, officeName, officeUnlocode, source, reason, actor, legacyCustomerId = null }) {
    await query(`INSERT INTO shipment_carrier_offices (id, shipment_id, role, office_id, office_name, office_unlocode, source, reason, legacy_customer_id, set_at, set_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (shipment_id, role) DO UPDATE SET office_id=EXCLUDED.office_id, office_name=EXCLUDED.office_name, office_unlocode=EXCLUDED.office_unlocode,
        source=EXCLUDED.source, reason=EXCLUDED.reason, set_at=EXCLUDED.set_at, set_by=EXCLUDED.set_by`,
      [`SCO-${uid()}`, shipmentId, role, officeId || null, officeName || "", officeUnlocode || "", source, reason || "", legacyCustomerId, nowIso(), actor || ""]);
  }

  // A person's pick: another office of the shipment's carrier, or none (officeId null). `fromCoverage` picks the role
  // again from the coverage instead.
  async function pick(shipmentId, role, { officeId, fromCoverage = false } = {}, actor = "") {
    const spec = SHIPMENT_ROLES[role];
    if (!spec) return { error: "Unknown carrier office role", status: 400 };
    const [s] = await query("SELECT id, carrier_code FROM shipments WHERE id=$1", [shipmentId]);
    if (!s) return { error: "Not found", status: 404 };
    if (fromCoverage) {
      await query("DELETE FROM shipment_carrier_offices WHERE shipment_id=$1 AND role=$2 AND office_id IS NULL AND office_name=''", [shipmentId, role]);
      await determine(shipmentId, { roles: [role], actor });
      return { view: await view(shipmentId) };
    }
    const [before] = await query("SELECT * FROM shipment_carrier_offices WHERE shipment_id=$1 AND role=$2", [shipmentId, role]);
    if (!officeId) {
      // Kept as an empty pick, so a later route save doesn't fill it again.
      await upsert(shipmentId, role, { officeId: null, officeName: "", officeUnlocode: "", source: "manual", reason: `left empty by ${actor || "a user"}`, actor });
      if (before?.office_name)
        await logEvent(shipmentId, "CARRIER_OFFICE_CHANGED", spec.label, before.office_name, null, JSON.stringify({ role, manual: true }), actor || null);
      return { view: await view(shipmentId) };
    }
    const office = await officeById(officeId);
    if (!office || office.carrierCode !== up(s.carrier_code)) return { error: `Pick an office of ${s.carrier_code || "the shipment's carrier"}`, status: 400 };
    if (!office.isActive) return { error: `${office.name} is inactive`, status: 400 };
    await upsert(shipmentId, role, { officeId: office.id, officeName: office.name, officeUnlocode: office.unlocode, source: "manual", reason: `picked by ${actor || "a user"}`, actor });
    if (before?.office_id !== office.id)
      await logEvent(shipmentId, "CARRIER_OFFICE_CHANGED", spec.label, before?.office_name || null, office.name, JSON.stringify({ role, manual: true, officeId: office.id }), actor || null);
    return { view: await view(shipmentId) };
  }

  // The shipment's offices as they act: the copy, the billing fallback, and what a person still has to pick.
  async function effective(shipmentId) {
    const rows = await storedRows(shipmentId);
    const out = {};
    for (const role of SHIPMENT_ROLE_KEYS) {
      const r = rows.find(x => x.role === role && (x.office_id || x.office_name));
      out[role] = r ? { officeId: r.office_id || null, officeName: r.office_name, officeUnlocode: r.office_unlocode || "", source: r.source,
        why: r.reason, setAt: r.set_at, setBy: r.set_by, legacyCustomerId: r.legacy_customer_id || null } : null;
    }
    for (const [billing, from] of Object.entries(BILLING_FALLBACK))
      if (!out[billing] && out[from]) out[billing] = { ...out[from], source: "fallback", fallback: true, why: fallbackWhy(billing) };
    return out;
  }

  async function view(shipmentId) {
    const s = await loadShipment(shipmentId);
    if (!s) return null;
    const eff = await effective(shipmentId);
    const emptied = new Set((await storedRows(shipmentId)).filter(r => !r.office_id && !r.office_name).map(r => r.role));
    const ids = [...new Set(Object.values(eff).map(e => e?.officeId).filter(Boolean))];
    const offices = ids.length ? await query("SELECT * FROM carrier_offices WHERE id = ANY($1)", [ids]) : [];
    const names = await portNames(Object.values(eff).map(e => e?.officeUnlocode));
    const roles = {};
    for (const role of SHIPMENT_ROLE_KEYS) {
      const spec = SHIPMENT_ROLES[role];
      const e = eff[role];
      const o = e?.officeId ? offices.find(x => x.id === e.officeId) : null;
      const port = s.ports[spec.port];
      // Two offices via linked ports: left empty for a person to pick, with the candidates.
      const candidates = !e && !emptied.has(role) && s.carrier_code && port ? await candidatesFor(s.carrier_code, role, port) : [];
      roles[role] = {
        role, label: spec.label, side: spec.side, port: port || "",
        office: e ? { id: e.officeId, name: o?.name || e.officeName, unlocode: o?.unlocode || e.officeUnlocode,
          locationName: names.get(o?.unlocode || e.officeUnlocode) || "", creditorCode: o?.creditor_code || "", isActive: o ? o.is_active !== false : null,
          contact: o ? { name: o.contact_name || "", phone: o.contact_phone || "", email: o.contact_email || "" } : null } : null,
        source: e?.source || (emptied.has(role) ? "manual" : null), why: e?.why || (emptied.has(role) ? "left empty on purpose" : ""),
        fallback: !!e?.fallback, setAt: e?.setAt || null, setBy: e?.setBy || "", leftEmpty: !e && emptied.has(role),
        candidates: candidates.length > 1 ? candidates : [],
      };
    }
    return { shipmentId: s.id, carrierCode: s.carrier_code || "", roles,
      offices: s.carrier_code ? (await officesOf(s.carrier_code, { activeOnly: true })).map(o => ({ id: o.id, name: o.name, unlocode: o.unlocode })) : [],
      capabilityGaps: await capabilityGaps(shipmentId) };
  }

  // ─── What the booking request needs ───────────────────────────────────────────
  // The booking office (located at its own UN/LOCODE, not the port of loading), our customer number at the carrier for
  // the legal entity behind the export office, and where the freight is payable: the billing (creditor) office of the
  // side that pays it.
  async function forBooking(shipment, { freightTerm = "" } = {}) {
    const eff = await effective(shipment.id);
    const ports = await portsOf(shipment);
    const book = eff.booking;
    const bookRow = book?.officeId ? (await query("SELECT * FROM carrier_offices WHERE id=$1", [book.officeId]))[0] : null;
    let bookingOffice = null;
    if (bookRow) {
      bookingOffice = { name: bookRow.name, UNLocationCode: bookRow.unlocode || ports.pol,
        address: bookRow.address1 && bookRow.city && bookRow.country_iso2 ? { street: bookRow.address1, postCode: bookRow.postal_code || "", city: bookRow.city, countryCode: bookRow.country_iso2 } : null,
        contact: bookRow.contact_name && (bookRow.contact_email || bookRow.contact_phone) ? { name: bookRow.contact_name, email: bookRow.contact_email || "", phone: bookRow.contact_phone || "" } : null };
    } else if (book?.officeName) {
      // A Line Agent kept from before carrier offices with no office behind it: its name, at the port of loading, as it went then.
      bookingOffice = { name: book.officeName, UNLocationCode: book.officeUnlocode || ports.pol, address: null, contact: null };
    }
    // Our customer number: the legal entity of the export office (else the import office's).
    const [entity] = await query(`SELECT b.id FROM offices o JOIN branches b ON b.id = o.branch_id WHERE o.id = $1`,
      [shipment.emo_office_id || shipment.imo_office_id || ""]).catch(() => []);
    const [acct] = entity ? await query("SELECT account_number FROM carrier_account_numbers WHERE carrier_code=$1 AND branch_id=$2", [up(shipment.carrier_code), entity.id]) : [];
    const listName = acct ? await codeListNameOf(shipment.carrier_code) : "";
    const identifyingCodes = acct?.account_number ? [{ codeListProvider: "ZZZ", partyCode: acct.account_number, ...(listName ? { codeListName: listName } : {}) }] : [];
    const payableAt = payableAtFrom(eff, freightTerm, ports);
    return { bookingOffice, identifyingCodes, payableAt, offices: eff };
  }
  // Prepaid: the origin billing office's location (else the port of loading); Collect: the destination's (else the port
  // of discharge). No freight term known: nothing.
  function payableAtFrom(eff, freightTerm, ports) {
    const term = /^col/i.test(freightTerm) ? "COL" : /^pre/i.test(freightTerm) ? "PRE" : "";
    if (!term) return "";
    const office = term === "COL" ? eff.billing_destination : eff.billing_origin;
    const loc = up(office?.officeUnlocode);
    if (UNLOCODE.test(loc)) return loc;
    const port = up(term === "COL" ? ports.pod : ports.pol);
    return UNLOCODE.test(port) ? port : "";
  }
  // The live office location (the copy keeps it too, for an office since removed).
  async function payableAt(shipment, freightTerm) {
    const eff = await effective(shipment.id);
    const ids = [eff.billing_origin?.officeId, eff.billing_destination?.officeId].filter(Boolean);
    const rows = ids.length ? await query("SELECT id, unlocode FROM carrier_offices WHERE id = ANY($1)", [ids]) : [];
    for (const k of ["billing_origin", "billing_destination"]) {
      const r = eff[k]?.officeId && rows.find(x => x.id === eff[k].officeId);
      if (r?.unlocode) eff[k] = { ...eff[k], officeUnlocode: r.unlocode };
    }
    return payableAtFrom(eff, freightTerm, await portsOf(shipment));
  }

  // ─── Capabilities (checked before the booking is sent; never blocking) ─────────────────
  async function capabilityGaps(shipmentId) {
    const legs = await query("SELECT leg_type, movement_type, movement_by FROM shipment_legs WHERE shipment_id=$1", [shipmentId]);
    const services = await query("SELECT side, service_type FROM shipment_services WHERE shipment_id=$1 AND status != 'Cancelled'", [shipmentId]);
    const needed = { Export: new Map(), Import: new Map() };
    for (const l of legs) {
      if (l.movement_type !== "Merchant's Haulage") continue;
      const cap = HAULAGE_MODE_TO_CAPABILITY[l.movement_by];
      const side = l.leg_type === "Pick-up" ? "Export" : l.leg_type === "Delivery" ? "Import" : null;
      if (cap && side && !needed[side].has(cap)) needed[side].set(cap, `Merchant's Haulage by ${l.movement_by}`);
    }
    for (const sv of services) {
      const cap = SERVICE_TYPE_TO_CAPABILITY[sv.service_type];
      if (cap && (sv.side === "Export" || sv.side === "Import") && !needed[sv.side].has(cap)) needed[sv.side].set(cap, `${sv.service_type} service ordered`);
    }
    if (!needed.Export.size && !needed.Import.size) return [];
    const eff = await effective(shipmentId);
    const gaps = [];
    for (const [side, role] of [["Export", "booking"], ["Import", "import"]]) {
      if (!needed[side].size || !eff[role]?.officeId) continue;
      const [o] = await query("SELECT name, capabilities FROM carrier_offices WHERE id=$1", [eff[role].officeId]);
      if (!o) continue;
      const have = new Set(parseJson(o.capabilities, []));
      for (const [cap, reason] of needed[side])
        if (!have.has(cap)) gaps.push({ side, agentName: o.name, officeName: o.name, capability: cap, capabilityLabel: CAPABILITY_LABELS[cap] || cap, reason });
    }
    return gaps;
  }

  // ─── Freight Audit: who issued a carrier invoice ────────────────────────────────
  // Defaults from the shipment's billing office for the side of the invoice's first charge (origin when it names none);
  // the clerk can pick another office of the carrier. Only an office of the invoice's carrier.
  async function issuerDefault(shipmentId, carrierCode, side = "origin") {
    const [s] = await query("SELECT carrier_code FROM shipments WHERE id=$1", [shipmentId]);
    if (!s || up(s.carrier_code) !== up(carrierCode)) return null;
    const eff = await effective(shipmentId);
    const e = side === "destination" ? eff.billing_destination : eff.billing_origin;
    return e?.officeId ? { officeId: e.officeId, officeName: e.officeName, why: e.fallback ? e.why : `the shipment's ${side} billing office` } : null;
  }

  // ─── The one-time move from Carrier Agents (2026-11-16) ─────────────────────────
  // Each carrier agent becomes a carrier office of its carrier (its customer's name, address and primary contact copied
  // in, kept with legacy_agent_id / legacy_customer_id); each of its locations becomes an export booking row and an
  // import office row (an agent acted on both sides); its working hours move with it. Each shipment's Line Agent
  // (Export) / (Import) party becomes its booking / import office (source 'migrated', the customer id kept) and the
  // party row goes. The old tables stay as they were, with their foreign keys dropped so they block nothing.
  async function migrateFromCarrierAgents() {
    const settings = await getSettings();
    if (settings.carrier_offices_migrated === "1") return { skipped: true };
    const [exists] = await query("SELECT to_regclass('public.carrier_agents') AS t");
    let agents = [];
    if ((settings.mdm_source || "local") === "remote" && callMdmService) {
      try {
        const list = await callMdmService("GET", "/internal/carrier-agents");
        for (const a of Array.isArray(list) ? list : list?.results || []) {
          let hours = [];
          try { hours = await callMdmService("GET", `/internal/carrier-agents/${a.id}/schedule`); } catch { hours = []; }
          agents.push({ id: a.id, carrier_code: a.carrierCode, agent_customer_id: a.agentCustomerId, note: a.note || "",
            capabilities: JSON.stringify(a.capabilities || []),
            locations: (a.locations || []).map(l => ({ location_type: l.type || l.locationType, unlocode: l.unlocode || null, country_iso2: l.countryIso2 || null })),
            hours: (hours || []).map(h => ({ days: JSON.stringify(h.days || []), start_time: h.startTime, end_time: h.endTime })) });
        }
      } catch (e) { console.error("Carrier offices: the MDM service's carrier agents couldn't be read:", e.message); return { error: e.message }; }
    } else if (exists?.t) {
      const rows = await query("SELECT * FROM carrier_agents ORDER BY created_at");
      for (const a of rows) {
        agents.push({ ...a,
          locations: await query("SELECT location_type, unlocode, country_iso2 FROM carrier_agent_locations WHERE carrier_agent_id=$1 ORDER BY created_at", [a.id]),
          hours: await query("SELECT days, start_time, end_time FROM carrier_agent_schedule_rows WHERE carrier_agent_id=$1 ORDER BY sort_order", [a.id]) });
      }
    }
    const officeOfAgent = new Map();
    let offices = 0, coverage = 0, shipments = 0;
    // The name a shipment's Line Agent party carried, for an agent whose customer can't be read (the Customer Service
    // down at startup, a deleted customer): better than a placeholder (audit F2).
    const partyNames = new Map((await query(`SELECT customer_id, customer_name FROM shipment_parties
      WHERE role IN ('Line Agent (Export)','Line Agent (Import)') AND COALESCE(customer_name,'') <> ''`)).map(r => [r.customer_id, r.customer_name]));
    for (const a of agents) {
      const [done] = await query("SELECT id FROM carrier_offices WHERE legacy_agent_id=$1", [a.id]);
      if (done) { officeOfAgent.set(`${up(a.carrier_code)}|${a.agent_customer_id}`, done.id); continue; }
      const c = await getCustomerRow(a.agent_customer_id).catch(() => null);
      const contacts = c ? await query("SELECT name, phone, email FROM customer_contacts WHERE customer_id=$1 ORDER BY is_primary DESC, created_at", [c.id]).catch(() => []) : [];
      const contact = contacts[0] || null;
      const firstPort = (a.locations || []).find(l => l.location_type === "unlocode")?.unlocode || "";
      const id = `COF-${uid()}`;
      const now = nowIso();
      await query(`INSERT INTO carrier_offices (id, carrier_code, name, unlocode, address1, address2, city, postal_code, country_iso2,
        contact_name, contact_phone, contact_email, creditor_code, capabilities, note, is_active, legacy_agent_id, legacy_customer_id, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'',$13,$14,TRUE,$15,$16,$17,$17)`,
        [id, up(a.carrier_code), txt(c?.companyName || partyNames.get(a.agent_customer_id) || `Agent ${a.agent_customer_id}`, 70), firstPort, txt(c?.address1, 70), txt(c?.address2, 70), txt(c?.city, 35),
          txt(c?.postalCode, 10), up(c?.countryIso2 || ""), txt(contact?.name || "", 35), txt(contact?.phone || c?.phone || "", 30),
          txt(contact?.email || c?.email || "", 100), a.capabilities || "[]", a.note || "", a.id, a.agent_customer_id || null, now]);
      offices++;
      officeOfAgent.set(`${up(a.carrier_code)}|${a.agent_customer_id}`, id);
      for (const h of a.hours || [])
        await query("INSERT INTO carrier_office_hours (id, office_id, days, start_time, end_time, sort_order, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [`COH-${uid()}`, id, typeof h.days === "string" ? h.days : JSON.stringify(h.days || []), h.start_time, h.end_time, 0, now]);
      for (const l of a.locations || []) {
        for (const [direction, role] of [["export", "booking"], ["import", "import"]]) {
          const placeType = l.location_type === "country" ? "country" : "unlocode";
          const [dup] = await query(`SELECT 1 FROM carrier_office_coverage WHERE carrier_code=$1 AND direction=$2 AND role=$3 AND place_type=$4
            AND COALESCE(unlocode,'')=$5 AND COALESCE(country_iso2,'')=$6`, [up(a.carrier_code), direction, role, placeType, l.unlocode || "", l.country_iso2 || ""]);
          if (dup) continue;
          await query(`INSERT INTO carrier_office_coverage (id, carrier_code, office_id, place_type, unlocode, country_iso2, direction, role, created_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [`COV-${uid()}`, up(a.carrier_code), id, placeType,
            placeType === "unlocode" ? l.unlocode : null, placeType === "country" ? l.country_iso2 : null, direction, role, now]);
          coverage++;
        }
      }
    }
    // The shipments' Line Agents.
    const parties = await query(`SELECT p.*, s.carrier_code FROM shipment_parties p JOIN shipments s ON s.id = p.shipment_id
      WHERE p.role IN ('Line Agent (Export)','Line Agent (Import)')`);
    for (const p of parties) {
      const role = LEGACY_LINE_AGENT_ROLES[p.role];
      const officeId = officeOfAgent.get(`${up(p.carrier_code)}|${p.customer_id}`) || null;
      const [o] = officeId ? await query("SELECT name, unlocode FROM carrier_offices WHERE id=$1", [officeId]) : [];
      await query(`INSERT INTO shipment_carrier_offices (id, shipment_id, role, office_id, office_name, office_unlocode, source, reason, legacy_customer_id, set_at, set_by)
        VALUES ($1,$2,$3,$4,$5,$6,'migrated',$7,$8,$9,'') ON CONFLICT (shipment_id, role) DO NOTHING`,
        [`SCO-${uid()}`, p.shipment_id, role, officeId, p.customer_name || o?.name || "", o?.unlocode || "",
          `${p.role} before carrier offices`, p.customer_id || null, p.created_at || nowIso()]);
      await query("DELETE FROM shipment_parties WHERE id=$1", [p.id]);
      shipments++;
    }
    // Every existing shipment counts as picked for its carrier and ports as they are now: its offices (the Line Agents
    // it had, or none) are kept until its carrier or a port changes.
    const all = await query("SELECT id, carrier_code, pol, pod FROM shipments WHERE carrier_offices_for IS NULL");
    for (const s of all) await query("UPDATE shipments SET carrier_offices_for=$1 WHERE id=$2", [keyOf(s.carrier_code, await portsOf(s)), s.id]);
    if (exists?.t) {
      for (const [table, fk] of [["carrier_agents", "carrier_agents_agent_customer_id_fkey"], ["carrier_agent_locations", "carrier_agent_locations_unlocode_fkey"],
        ["carrier_agent_locations", "carrier_agent_locations_country_iso2_fkey"]])
        await query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${fk}`).catch(() => {});
    }
    await query(`INSERT INTO app_settings (key, value) VALUES ('carrier_offices_migrated','1') ON CONFLICT (key) DO UPDATE SET value='1'`);
    if (offices || coverage || shipments)
      console.log(`  ✔ Carrier offices: ${offices} office(s) and ${coverage} coverage row(s) from Carrier Agents, ${shipments} shipment Line Agent(s) moved`);
    return { offices, coverage, shipments };
  }

  // The names screened with the shipment's parties (the sanctions lists): its carrier offices, by name.
  async function screeningNames(shipmentId) {
    const rows = await storedRows(shipmentId);
    return rows.filter(r => r.office_name).map(r => [SHIPMENT_ROLES[r.role]?.label || r.role, r.office_name, null]);
  }

  return {
    SHIPMENT_ROLES, SHIPMENT_ROLE_KEYS, COVERAGE_ROLES, DIRECTIONS, CAPABILITY_CODES, CAPABILITY_LABELS, UNLOCODE,
    profile, officesOf, officeById, coverageOf, accountNumbersOf, codeListNameOf,
    createOffice, updateOffice, removeOffice, addCoverage, updateCoverage, removeCoverage, saveAccountNumbers, validateHours,
    candidatesFor, check, determine, refresh, rolesFor, pick, effective, view, forBooking, payableAt, capabilityGaps, issuerDefault, portsOf,
    migrateFromCarrierAgents, screeningNames,
  };
}

module.exports = createCarrierOffices;
module.exports.SHIPMENT_ROLES = SHIPMENT_ROLES;
module.exports.validateHours = validateHours;
