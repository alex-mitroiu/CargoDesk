"use strict";
// ─── Facilities: terminals and depots (2026-11-20, ARCHITECTURE.md §8.56, mockup 3d91c28a) ─────────────────────────────
// The places a trucker goes that aren't a customer's door. Terminals come from the SMDG Terminal Code List, the code list
// DCSA itself names for terminals (a DCSA `facility` is an SMDG or a BIC code under a UN/LOCODE). The list is public on
// GitHub but its repository states no licence, so it is never committed here: an admin imports it at run time (fetched,
// or a CSV file uploaded), as the sanctions lists are fetched (the user's decision D). An import adds and updates rows and
// never deletes one: SMDG closes a terminal by giving it a Valid to date, and an expired row drops out of the pickers by
// itself. Depots, which no open list covers, are added by hand (a BIC facility code optional). Local only, like HS codes.
// Built once as ctx.facilities.

const SMDG_URL = "https://raw.githubusercontent.com/smdg-org/Terminal-Code-List/master/SMDG%20Terminal%20Code%20List.csv";
const KINDS = Object.freeze(["TERMINAL", "DEPOT", "OTHER"]);
const CODE_LISTS = Object.freeze(["SMDG", "BIC", ""]);

// RFC 4180 CSV: quoted fields may hold commas, line breaks and "" for a quote.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v !== "")) rows.push(row);
  return rows;
}

const num = v => { const n = Number(String(v ?? "").trim()); return String(v ?? "").trim() !== "" && Number.isFinite(n) ? n : null; };
// Dates as a spreadsheet re-saves them (2026-11-22, the user: "Fix it first"): the list publishes ISO dates (2022-01-19),
// but a file opened and saved in Excel comes back as 1/19/2022 (US) or 19/01/2022 (most of Europe; also with dots or
// dashes, two-digit years, a time after it). Which order a file uses is told by its own dates: a first part above 12 can
// only be a day, a second part above 12 only a day. Neither seen (every date ambiguous) or both seen (mixed) → the
// order is unknown and those dates are left empty and counted, never guessed.
const LOCAL_DATE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?)?$/;
function dateOrderOf(values) {
  let dayFirst = false, monthFirst = false;
  for (const v of values) {
    const m = LOCAL_DATE.exec(String(v || "").trim());
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirst = true;
  }
  return dayFirst && monthFirst ? "mixed" : dayFirst ? "D/M/Y" : monthFirst ? "M/D/Y" : "unknown";
}
// → "YYYY-MM-DD", "" for an empty cell, or null for a date that can't be read in that order.
function readDate(v, order) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = LOCAL_DATE.exec(s);
  if (!m || (order !== "M/D/Y" && order !== "D/M/Y")) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const month = order === "M/D/Y" ? a : b, dd = order === "M/D/Y" ? b : a;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const t = new Date(Date.UTC(year, month - 1, dd));
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== dd) return null; // 2/30, 13/13
  return t.toISOString().slice(0, 10);
}

// The SMDG file's rows as facility rows. Columns are read by their header names (UNLOCODE, Terminal Code, Terminal
// Facility Name, …), so a reordered file still reads. A row without a UN/LOCODE, a code or a name is skipped.
function parseSmdg(text) {
  const [head, ...rows] = parseCsv(text);
  if (!head) return { rows: [], skipped: 0, error: "The file is empty" };
  const at = name => head.findIndex(h => h.trim().toLowerCase() === name.toLowerCase());
  const col = { unlocode: at("UNLOCODE"), code: at("Terminal Code"), name: at("Terminal Facility Name"), operator: at("Terminal Company Name"),
    lat: at("Latitude"), lng: at("Longitude"), lastChange: at("Last change"), validFrom: at("Valid from"), validTo: at("Valid to"),
    website: at("Terminal Website"), address: at("Terminal Address"), remarks: at("Remarks") };
  if (col.unlocode < 0 || col.code < 0 || col.name < 0)
    return { rows: [], skipped: 0, error: "This isn't the SMDG Terminal Code List: the UNLOCODE, Terminal Code and Terminal Facility Name columns are missing" };
  const get = (r, i) => (i >= 0 ? String(r[i] ?? "").trim() : "");
  const dateCols = [col.lastChange, col.validFrom, col.validTo];
  const cells = rows.flatMap(r => dateCols.map(i => get(r, i))).filter(Boolean);
  const local = cells.filter(c => !/^\d{4}-\d{2}-\d{2}/.test(c));
  const order = local.length ? dateOrderOf(local) : "ISO";
  let unreadable = 0;
  const date = v => { const d = readDate(v, order); if (d === null) { unreadable++; return ""; } return d; };
  const out = [];
  let skipped = 0;
  for (const r of rows) {
    const unlocode = get(r, col.unlocode).toUpperCase(), code = get(r, col.code).toUpperCase(), name = get(r, col.name);
    if (!/^[A-Z]{2}[A-Z0-9]{3}$/.test(unlocode) || !code || !name) { skipped++; continue; }
    out.push({ id: `FAC-SMDG-${unlocode}-${code}`, unlocode, code, name, operator: get(r, col.operator),
      latitude: num(get(r, col.lat)), longitude: num(get(r, col.lng)), lastChange: date(get(r, col.lastChange)),
      validFrom: date(get(r, col.validFrom)), validTo: date(get(r, col.validTo)), website: get(r, col.website),
      address: get(r, col.address), remarks: get(r, col.remarks) });
  }
  // dates: how the file wrote them (ISO, M/D/Y, D/M/Y; unknown or mixed = not readable) and how many couldn't be read.
  return { rows: out, skipped, error: "", dates: { order, unreadable } };
}

const todayIso = () => new Date().toISOString().slice(0, 10);
// Open today: active, and inside its validity (an SMDG row past its Valid to is closed).
const isOpen = (r, today = todayIso()) => !!r.is_active && (!r.valid_to || r.valid_to >= today) && (!r.valid_from || r.valid_from <= today);

const mapFacility = r => ({
  id: r.id, kind: r.kind, source: r.source, unlocode: r.unlocode || "", code: r.code || "", codeList: r.code_list || "",
  name: r.name, operator: r.operator || "", address: r.address || "", latitude: r.latitude ?? null, longitude: r.longitude ?? null,
  website: r.website || "", remarks: r.remarks || "", validFrom: r.valid_from || "", validTo: r.valid_to || "",
  lastChange: r.last_change || "", isActive: !!r.is_active, open: isOpen(r), createdAt: r.created_at, updatedAt: r.updated_at,
});

module.exports = function facilitiesLib(ctx) {
  const { query, transaction, uid } = ctx;
  const nowIso = () => new Date().toISOString();

  async function get(id) {
    const [row] = await query("SELECT * FROM facilities WHERE id=$1", [id]);
    return row || null;
  }

  // ?unlocode= one port; ?kind=; ?q= name, code, operator or address; ?open=1 only what's open today (the pickers).
  async function list({ unlocode = "", kind = "", q = "", open = false, limit = 0 } = {}) {
    const where = [], params = [];
    if (unlocode) { params.push(String(unlocode).toUpperCase()); where.push(`unlocode=$${params.length}`); }
    if (kind) { params.push(String(kind).toUpperCase()); where.push(`kind=$${params.length}`); }
    if (q) {
      params.push(`%${String(q).toLowerCase()}%`);
      where.push(`(LOWER(name) LIKE $${params.length} OR LOWER(code) LIKE $${params.length} OR LOWER(operator) LIKE $${params.length} OR LOWER(address) LIKE $${params.length} OR LOWER(unlocode) LIKE $${params.length})`);
    }
    const rows = await query(`SELECT * FROM facilities ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY unlocode, CASE kind WHEN 'TERMINAL' THEN 0 WHEN 'DEPOT' THEN 1 ELSE 2 END, name`, params);
    const today = todayIso();
    const out = (open ? rows.filter(r => isOpen(r, today)) : rows).map(mapFacility);
    return limit > 0 ? out.slice(0, limit) : out;
  }

  async function status() {
    const [{ n }] = await query("SELECT COUNT(*)::int AS n FROM facilities WHERE source='smdg'");
    const [{ m }] = await query("SELECT COUNT(*)::int AS m FROM facilities WHERE source='manual'");
    const [ports] = await query("SELECT COUNT(DISTINCT unlocode)::int AS p FROM facilities WHERE source='smdg'");
    const settings = await ctx.getSettings();
    return { smdgCount: Number(n), smdgPorts: Number(ports?.p || 0), manualCount: Number(m), smdgUrl: SMDG_URL,
      smdgImportedAt: settings.facilities_smdg_imported_at || "", smdgLastChange: settings.facilities_smdg_last_change || "" };
  }

  // The SMDG import: csv given (an uploaded file) or fetched from the list's GitHub repository. → { added, updated, skipped }
  async function importSmdg({ csv } = {}) {
    let text = csv;
    if (!text) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 30000);
      try {
        const res = await fetch(SMDG_URL, { signal: ctl.signal });
        if (!res.ok) throw Object.assign(new Error(`The SMDG list couldn't be downloaded (GitHub answered ${res.status}). Upload the CSV file instead.`), { status: 502 });
        text = await res.text();
      } catch (e) {
        if (e.status) throw e;
        throw Object.assign(new Error(`The SMDG list couldn't be downloaded (${e.name === "AbortError" ? "no answer in 30 seconds" : e.message}). Upload the CSV file instead.`), { status: 502 });
      } finally { clearTimeout(timer); }
    }
    const parsed = parseSmdg(text);
    if (parsed.error) throw Object.assign(new Error(parsed.error), { status: 400 });
    if (!parsed.rows.length) throw Object.assign(new Error("The file has no terminals in it"), { status: 400 });
    const now = nowIso();
    let added = 0, updated = 0;
    await transaction(async tx => {
      const existing = new Set((await tx.query("SELECT id FROM facilities WHERE source='smdg'")).map(r => r.id));
      for (const f of parsed.rows) {
        const vals = [f.id, f.unlocode, f.code, f.name, f.operator, f.address, f.latitude, f.longitude, f.website, f.remarks, f.validFrom, f.validTo, f.lastChange, now];
        if (existing.has(f.id)) {
          await tx.query(`UPDATE facilities SET unlocode=$2, code=$3, name=$4, operator=$5, address=$6, latitude=$7, longitude=$8, website=$9,
            remarks=$10, valid_from=$11, valid_to=$12, last_change=$13, updated_at=$14 WHERE id=$1`, vals);
          updated++;
        } else {
          await tx.query(`INSERT INTO facilities (id, kind, source, unlocode, code, code_list, name, operator, address, latitude, longitude, website,
            remarks, valid_from, valid_to, last_change, is_active, created_at, updated_at)
            VALUES ($1,'TERMINAL','smdg',$2,$3,'SMDG',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE,$14,$14)`, vals);
          existing.add(f.id);
          added++;
        }
      }
    });
    const lastChange = parsed.rows.map(r => r.lastChange || r.validFrom).filter(Boolean).sort().pop() || "";
    for (const [key, value] of [["facilities_smdg_imported_at", now], ["facilities_smdg_last_change", lastChange]])
      await query("INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);
    return { added, updated, skipped: parsed.skipped, total: parsed.rows.length, dates: parsed.dates };
  }

  // A depot or another place, by hand. → { facility } or { error, status }
  function validate(body, existing = null) {
    const kind = String(body.kind ?? existing?.kind ?? "DEPOT").toUpperCase();
    if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(", ")}` };
    const name = String(body.name ?? existing?.name ?? "").trim();
    if (!name) return { error: "A name is required" };
    const unlocode = String(body.unlocode ?? existing?.unlocode ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{3}$/.test(unlocode)) return { error: "A UN/LOCODE (5 characters, e.g. NLRTM) is required" };
    const codeList = String(body.codeList ?? existing?.code_list ?? "").toUpperCase();
    if (!CODE_LISTS.includes(codeList)) return { error: "codeList must be SMDG, BIC or empty" };
    const code = String(body.code ?? existing?.code ?? "").trim().toUpperCase();
    if (code && !codeList) return { error: "Say which list the code is from (SMDG or BIC)" };
    if (code.length > 6) return { error: "A facility code has at most 6 characters (DCSA)" };
    const lat = body.latitude !== undefined ? body.latitude : existing?.latitude;
    const lng = body.longitude !== undefined ? body.longitude : existing?.longitude;
    const blank = v => v == null || v === "";
    if (blank(lat) !== blank(lng)) return { error: "Give both the latitude and the longitude, or neither" };
    if (!blank(lat) && !(Number(lat) >= -90 && Number(lat) <= 90)) return { error: "latitude must be between -90 and 90" };
    if (!blank(lng) && !(Number(lng) >= -180 && Number(lng) <= 180)) return { error: "longitude must be between -180 and 180" };
    return { facility: { kind, name, unlocode, code, codeList: code ? codeList : "", operator: String(body.operator ?? existing?.operator ?? "").trim(),
      address: String(body.address ?? existing?.address ?? "").trim(), latitude: blank(lat) ? null : Number(lat), longitude: blank(lng) ? null : Number(lng),
      isActive: body.isActive !== undefined ? !!body.isActive : existing ? !!existing.is_active : true } };
  }

  async function create(body) {
    const v = validate(body || {});
    if (v.error) return { error: v.error, status: 400 };
    const f = v.facility, id = `FAC-${uid()}`, now = nowIso();
    await query(`INSERT INTO facilities (id, kind, source, unlocode, code, code_list, name, operator, address, latitude, longitude, is_active, created_at, updated_at)
      VALUES ($1,$2,'manual',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [id, f.kind, f.unlocode, f.code, f.codeList, f.name, f.operator, f.address, f.latitude, f.longitude, f.isActive, now]);
    return { facility: mapFacility(await get(id)) };
  }

  // An SMDG row is the list's: only switching it off is ours (the next import keeps that).
  async function update(id, body) {
    const row = await get(id);
    if (!row) return { error: "Facility not found", status: 404 };
    if (row.source === "smdg") {
      const keys = Object.keys(body || {}).filter(k => k !== "isActive");
      if (keys.length) return { error: "A terminal from the SMDG list changes only with the next import; you can only switch it off", status: 409 };
      await query("UPDATE facilities SET is_active=$1, updated_at=$2 WHERE id=$3", [!!body.isActive, nowIso(), id]);
      return { facility: mapFacility(await get(id)) };
    }
    const v = validate(body || {}, row);
    if (v.error) return { error: v.error, status: 400 };
    const f = v.facility;
    await query(`UPDATE facilities SET kind=$1, unlocode=$2, code=$3, code_list=$4, name=$5, operator=$6, address=$7, latitude=$8, longitude=$9,
      is_active=$10, updated_at=$11 WHERE id=$12`,
      [f.kind, f.unlocode, f.code, f.codeList, f.name, f.operator, f.address, f.latitude, f.longitude, f.isActive, nowIso(), id]);
    return { facility: mapFacility(await get(id)) };
  }

  // Not while a haulage stop uses it (switch it off instead). An SMDG row comes back with the next import.
  async function remove(id) {
    const row = await get(id);
    if (!row) return { error: "Facility not found", status: 404 };
    const [{ n }] = await query("SELECT COUNT(*)::int AS n FROM haulage_stops WHERE facility_id=$1", [id]);
    if (Number(n) > 0) return { error: `${row.name} is a stop on ${n} haulage plan${Number(n) === 1 ? "" : "s"}: switch it off instead`, status: 409 };
    await query("DELETE FROM facilities WHERE id=$1", [id]);
    return { deleted: id };
  }

  // First start (2026-11-22, the user: "with the first deployment all this data is seeded"; decided: download once, no
  // monthly refresh): in the background after listen(), the list is downloaded until one import has succeeded, whether
  // downloaded or uploaded (facilities_smdg_imported_at). Afterwards only an admin's Update from SMDG changes it. A failed
  // download is tried again after 1 hour, then 2, 4, … at most a day apart; Update from SMDG and the upload stay open
  // meanwhile. REFERENCE_DOWNLOADS=off skips it: CI and test databases import fictitious rows of their own.
  let retryTimer = null;
  async function firstStartImport(attempt = 0) {
    retryTimer = null;
    if (firstStartSkipped(process.env)) return { skipped: "off" };
    if ((await ctx.getSettings()).facilities_smdg_imported_at) return { skipped: "imported" };
    let result;
    try {
      result = await importSmdg();
    } catch (e) {
      const hours = retryHours(attempt);
      console.warn(`  ⚠ SMDG terminal list not downloaded on first start (${e.message}). Trying again in ${hours} h.`);
      retryTimer = setTimeout(() => firstStartImport(attempt + 1).catch(() => {}), hours * 3600_000);
      retryTimer.unref?.();
      return { failed: e.message, retryInHours: hours };
    }
    console.log(`  ✔ SMDG terminal list downloaded on first start: ${result.added} terminals added`);
    // The History line is a separate step (2026-11-22 audit R3): failing to write it no longer reads as a failed download
    // and no longer re-arms a retry.
    await ctx.logEntityEvent("facility", "SMDG", "IMPORTED", null, null, null, JSON.stringify({ ...result, by: "first start", upload: false }))
      .catch(e => console.warn("  ⚠ SMDG first-start import: History line not written:", e.message));
    return result;
  }

  return { list, get, mapFacility, status, importSmdg, firstStartImport, create, update, remove, isOpen, KINDS, SMDG_URL };
};

// The first-start download's rules, pure for tests: the switch, and the wait before try n+1 (1, 2, 4, … 24 hours).
function firstStartSkipped(env) { return String(env?.REFERENCE_DOWNLOADS || "").trim().toLowerCase() === "off"; }
function retryHours(attempt) { return Math.min(24, 2 ** Math.max(0, attempt)); }
module.exports.firstStartSkipped = firstStartSkipped;
module.exports.retryHours = retryHours;

module.exports.parseCsv = parseCsv;
module.exports.parseSmdg = parseSmdg;
