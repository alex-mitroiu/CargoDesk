/**
 * Reference data loaded by the server itself (2026-11-22, lib/reference-data.js, ARCHITECTURE.md §8.57).
 *
 * The user: "we need to have a logic that with the first deployment all this data is seeded so that people do not have
 * to run scripts constantly or upload manually files." Their decisions:
 *   - the committed files load on the server's first start (no npm run setup / seed);
 *   - a later release's changed file adds only its NEW rows, never overwriting or deleting (a deleted row stays deleted);
 *   - the mock vessels load outside production only;
 *   - the SMDG terminal list is downloaded once on first start (retried until one import succeeded); the denied-party
 *     lists' first sync stays manual.
 *
 * Covers:
 *   - Pure: the committed files as the loader reads them (counts, SGSIN, ZA on SAF); planLoad (first / unchanged /
 *     changed / full); load() itself over a stand-in database (records, a second start does nothing, a changed file adds
 *     only its new rows, a deleted row isn't brought back, full mode restores it, vessels skipped in production, an
 *     unreadable file skipped); the first-start download's switch and waits.
 *   - Live (server on :3001): GET /api/reference-data — every dataset recorded with the file's row count and its rows in
 *     the table (on CI's fresh database this is the proof that no seed script ran); admins only.
 *
 * Prerequisites: server on :3001 (it loaded the data when it started). Admin account: claudeagent@localhost / TestFixture!2026Zq
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const createReferenceData = require("../lib/reference-data.js");
const { parsePorts, parseCarriers, regionsOf, planLoad, TRADE_LANES } = createReferenceData;
const { timezoneFor } = require("../lib/timezones.js");
const { firstStartSkipped, retryHours } = require("../lib/facilities.js");
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = f => fs.readFileSync(path.join(ROOT, "data", f), "utf8");

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ method, hostname: "localhost", port: 3001, path: urlPath, headers: {
      "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }),
      ...(payload && { "Content-Length": Buffer.byteLength(payload) }) } }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function login(email, password) {
  const { status, body } = await request("POST", "/api/auth/login", { email, password });
  if (status !== 200 || !body.token) throw new Error(`Login failed for ${email} (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

// A stand-in database for load(): reference_data_loads in a Map, each dataset's table a Set of keys.
function standIn({ isProduction = false } = {}) {
  const loads = new Map();
  const query = async (sql, params = []) => {
    if (/^SELECT \* FROM reference_data_loads/.test(sql.trim())) return [...loads.values()];
    if (/^INSERT INTO reference_data_loads/.test(sql.trim())) {
      const [dataset, version, row_keys, rows_in_file, rows_added, mode, loaded_at] = params;
      loads.set(dataset, { dataset, version, row_keys, rows_in_file, rows_added, mode, loaded_at });
      return [];
    }
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  };
  const transaction = fn => fn({ query });
  const rd = createReferenceData({ query, transaction, timezoneFor: null, isProduction, log: () => {} });
  const tables = new Map();
  const files = new Map();
  for (const ds of rd.DATASETS) {
    tables.set(ds.name, new Set());
    files.set(ds.name, [{ k: `${ds.name}-1` }, { k: `${ds.name}-2` }]);
    ds.keyOf = r => r.k;
    ds.rows = () => { const f = files.get(ds.name); if (f === "unreadable") throw new Error("ENOENT"); return f; };
    ds.insert = async (tx, rows) => { const t = tables.get(ds.name); let n = 0; for (const r of rows) if (!t.has(r.k)) { t.add(r.k); n++; } return n; };
    delete ds.refresh;
  }
  return { rd, loads, tables, files };
}
const byName = (summary, name) => summary.find(s => s.dataset === name);

(async () => {
  let adminToken = null, opUserId = null;
  try {
    console.log("\nPure: the committed files, as the loader reads them");
    const ports = parsePorts(read("seaports.csv"), timezoneFor);
    assert("data/seaports.csv: 14,270 ports, each code once", ports.length === 14270 && new Set(ports.map(p => p.unlocode)).size === 14270, String(ports.length));
    const sgsin = ports.find(p => p.unlocode === "SGSIN");
    assert("…SGSIN is Singapore, zone AS-SIN, Asia/Singapore", sgsin?.countryCode === "SG" && sgsin?.zoneCode === "AS-SIN" && sgsin?.timezone === "Asia/Singapore", JSON.stringify(sgsin));
    assert("…every port has a time zone", ports.every(p => p.timezone), ports.filter(p => !p.timezone).slice(0, 3).map(p => p.unlocode).join(","));
    assert("regions are the ports' 33 zone codes", regionsOf(ports).length === 33, String(regionsOf(ports).length));
    const carriers = parseCarriers(read("carriers.csv"));
    const maeu = carriers.find(c => c.code === "MAEU");
    assert("data/carriers.csv: 68 carriers by SCAC, MAEU among them", carriers.length === 68 && !!maeu, `${carriers.length} ${JSON.stringify(maeu)}`);
    assert("…no HTML left in a name", carriers.every(c => !/[<>]/.test(c.name)));
    const countries = JSON.parse(read("countries.json"));
    assert("data/countries.json: 211 countries and 185 lane assignments, South Africa on SAF",
      countries.length === 211 && countries.reduce((n, c) => n + c.lanes.length, 0) === 185 && countries.find(c => c.iso2 === "ZA")?.lanes.includes("SAF"));
    const laneCodes = new Set(TRADE_LANES.map(l => l[0]));
    assert("…every lane it names is one of the 14 trade lanes", TRADE_LANES.length === 14 && countries.every(c => c.lanes.every(l => laneCodes.has(l))),
      countries.flatMap(c => c.lanes.filter(l => !laneCodes.has(l))).join(","));

    console.log("\nPure: what a start adds (planLoad)");
    const rows = [{ k: "A" }, { k: "B" }, { k: "C" }];
    const keyOf = r => r.k;
    assert("never loaded: every row", planLoad({ rows, keyOf, version: "v1", record: null }).rows.length === 3);
    assert("the same file again: nothing", planLoad({ rows, keyOf, version: "v1", record: { version: "v1", row_keys: '["A","B","C"]' } }).rows.length === 0);
    const changed = planLoad({ rows, keyOf, version: "v2", record: { version: "v1", row_keys: '["A","B"]' } });
    assert("a changed file: only the rows it didn't have before", changed.reason === "changed" && changed.rows.map(keyOf).join() === "C", JSON.stringify(changed));
    assert("mode 'full' (npm run seed): every row again", planLoad({ rows, keyOf, version: "v1", record: { version: "v1", row_keys: "[]" }, mode: "full" }).rows.length === 3);

    console.log("\nload() over a stand-in database");
    {
      const { rd, loads, tables, files } = standIn();
      const first = await rd.load();
      assert("first start: every dataset loaded from its file, vessels included outside production",
        rd.DATASETS.every(ds => byName(first, ds.name).added === 2 && byName(first, ds.name).reason === "first") && loads.size === rd.DATASETS.length,
        JSON.stringify(first));
      const second = await rd.load();
      assert("the next start: nothing added, nothing re-recorded", second.every(s => s.added === 0 && s.reason === "unchanged"), JSON.stringify(second));
      tables.get("ports").delete("ports-1");
      files.set("ports", [{ k: "ports-1" }, { k: "ports-2" }, { k: "ports-3" }]);
      const third = await rd.load();
      assert("a release with a new port: only it is added; the port someone deleted stays deleted",
        byName(third, "ports").added === 1 && tables.get("ports").has("ports-3") && !tables.get("ports").has("ports-1"), JSON.stringify(byName(third, "ports")));
      assert("…and the record now holds the new file's keys", JSON.parse(loads.get("ports").row_keys).length === 3);
      const full = await rd.load({ mode: "full", vessels: true });
      assert("npm run seed (full): the deleted port comes back", byName(full, "ports").added === 1 && tables.get("ports").has("ports-1"), JSON.stringify(byName(full, "ports")));
      files.set("commodities", "unreadable");
      const broken = await rd.load();
      assert("a file that can't be read is skipped, the others still load", byName(broken, "commodities").skipped && byName(broken, "ports").reason === "unchanged", JSON.stringify(byName(broken, "commodities")));
    }
    {
      // 2026-11-22 audit R2: a dataset whose insert fails is skipped and not recorded; the datasets after it still load.
      const { rd, loads, tables } = standIn();
      rd.DATASETS.find(ds => ds.name === "ports").insert = async () => { throw new Error("value too long"); };
      const s = await rd.load();
      assert("a dataset that fails to insert doesn't stop the ones after it (regions, carriers … vessels still load)",
        byName(s, "ports").reason === "failed" && byName(s, "ports").skipped && !loads.has("ports")
          && ["regions", "carriers", "commodities", "hs-codes", "vessels"].every(n => byName(s, n).added === 2) && tables.get("carriers").size === 2,
        JSON.stringify(s.map(x => `${x.dataset}:${x.reason}:${x.added}`)));
    }
    {
      const { rd, tables, loads } = standIn({ isProduction: true });
      const prod = await rd.load();
      assert("in production the mock vessels are not loaded (and not recorded, so they never load by themselves)",
        byName(prod, "vessels").skipped && tables.get("vessels").size === 0 && !loads.has("vessels") && byName(prod, "ports").added === 2, JSON.stringify(byName(prod, "vessels")));
      const seeded = await rd.load({ mode: "full", vessels: true });
      assert("…npm run seed still loads them when asked", byName(seeded, "vessels").added === 2);
    }

    console.log("\nPure: the SMDG first-start download");
    assert("REFERENCE_DOWNLOADS=off switches it off (any case), unset leaves it on",
      firstStartSkipped({ REFERENCE_DOWNLOADS: "off" }) && firstStartSkipped({ REFERENCE_DOWNLOADS: " OFF " }) && !firstStartSkipped({}) && !firstStartSkipped({ REFERENCE_DOWNLOADS: "on" }));
    assert("a failed download is tried again after 1, 2, 4 … hours, at most a day apart",
      [0, 1, 2, 3, 4, 5, 9].map(retryHours).join() === "1,2,4,8,16,24,24");

    console.log("\nLive: what the server loaded when it started");
    adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq");
    const st = await request("GET", "/api/reference-data", null, adminToken);
    const ds = new Map((st.body?.datasets || []).map(d => [d.dataset, d]));
    assert("GET /api/reference-data lists the nine datasets", st.status === 200 && ds.size === 9, JSON.stringify(st.body).slice(0, 300));
    const expected = { "trade-lanes": 14, countries: 211, "country-trade-lanes": 185, ports: 14270, regions: 33, carriers: 68, commodities: 294, "hs-codes": 48 };
    for (const [name, n] of Object.entries(expected)) {
      const d = ds.get(name);
      assert(`${name}: loaded from a file of ${n} rows, and the table holds rows`, d?.loaded?.rowsInFile === n && d.rowsNow > 0, JSON.stringify(d));
    }
    assert("vessels: loaded outside production (this server isn't production)",
      st.body.vesselsLoadedAutomatically === true && ds.get("vessels")?.loaded?.rowsInFile === 350 && ds.get("vessels").rowsNow > 0, JSON.stringify(ds.get("vessels")));
    const port = await request("GET", "/api/port-locations/SGSIN", null, adminToken);
    assert("the ports are there to use: SGSIN answers", port.status === 200 && /Singapore/.test(JSON.stringify(port.body)), `${port.status} ${JSON.stringify(port.body).slice(0, 120)}`);
    const za = await request("GET", "/api/countries?search=South%20Africa", null, adminToken);
    const zaRow = (Array.isArray(za.body) ? za.body : za.body?.results || []).find(c => c.iso2 === "ZA");
    assert("…and so are the countries: South Africa", za.status === 200 && !!zaRow, JSON.stringify(zaRow));

    console.log("\nLive: admins only");
    const anon = await request("GET", "/api/reference-data");
    assert("no token: 401", anon.status === 401, String(anon.status));
    const stamp = Date.now();
    const opEmail = `refdata-op-${stamp}@test.local`;
    const created = await request("POST", "/api/users", { email: opEmail, name: "Reference Data Test Operator", roles: ["operator"], password: "RefDataFixture!2026Zq" }, adminToken);
    opUserId = (await request("GET", "/api/users", null, adminToken)).body.find(u => u.email === opEmail)?.id;
    assert("a scratch operator", created.status === 201 && !!opUserId, JSON.stringify(created.body));
    const opToken = await login(opEmail, "RefDataFixture!2026Zq");
    const asOp = await request("GET", "/api/reference-data", null, opToken);
    assert("an operator: 403", asOp.status === 403, String(asOp.status));
  } catch (e) {
    console.error("  ✗ Unexpected error:", e.stack || e.message);
    failed++;
  } finally {
    if (adminToken && opUserId) await request("DELETE", `/api/users/${opUserId}`, null, adminToken).catch(() => {});
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
