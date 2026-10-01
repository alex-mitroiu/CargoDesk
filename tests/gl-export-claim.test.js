/**
 * GL Export — concurrent runs claim disjoint rows (TKT-OBCQH7).
 *
 * Pure unit test: drives lib/gl-export.js against an in-memory fake database that yields between
 * every query, so two runs started together both SELECT the same unexported rows before either
 * stamps them — the interleaving a real Postgres pool produces under load. (Against the dev
 * pglite database the race can't be reproduced live: a request that only awaits pglite queries
 * runs start to finish before the next request is even read, so a live test would pass with or
 * without the fix.)
 *
 * Usage:
 *   node tests/gl-export-claim.test.js
 */

const createGlExport = require("../lib/gl-export");

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

// Two confirmed invoices (one SELL line each) and one posted BUY line, all unexported, in range.
function makeDb() {
  const docs = [
    { id: "DOC-A", doc_type: "FR01", status: "confirmed", confirmed_at: "2026-09-30T08:00:00Z", filename: "FR01-A.pdf", source_cost_line_ids: '["CL-S1"]', gl_exported_at: null, gl_export_batch_id: null },
    { id: "DOC-B", doc_type: "FR01", status: "confirmed", confirmed_at: "2026-09-30T09:00:00Z", filename: "FR01-B.pdf", source_cost_line_ids: '["CL-S2"]', gl_exported_at: null, gl_export_batch_id: null },
  ];
  const lines = [
    { id: "CL-S1", type: "SELL", charge_code: "Ocean Freight", amount: 1850, exchange_rate: 1, currency: "USD", shipment_id: "SHP-1" },
    { id: "CL-S2", type: "SELL", charge_code: "Terminal Handling", amount: 245, exchange_rate: 1, currency: "USD", shipment_id: "SHP-2" },
    { id: "CL-B1", type: "BUY", status: "posted", posted_at: "2026-09-30T10:00:00Z", charge_code: "Ocean Freight", amount: 1400, exchange_rate: 1, currency: "USD", shipment_id: "SHP-1", gl_exported_at: null, gl_export_batch_id: null },
  ];
  const batches = [];
  const tick = () => new Promise(r => setImmediate(r));
  const tables = { shipment_documents: docs, shipment_cost_lines: lines, customer_statements: [] };

  async function query(sql, params = []) {
    await tick(); // let the other run in
    if (/FROM gl_account_mappings/.test(sql)) return [];
    if (/FROM customer_statements/.test(sql)) return []; // no statements in this scenario
    if (/FROM shipment_documents/.test(sql)) return docs.filter(d => d.gl_exported_at === null).map(d => ({ ...d }));
    if (/FROM shipment_cost_lines WHERE id IN/.test(sql)) return lines.filter(l => params.includes(l.id)).map(l => ({ ...l }));
    if (/FROM shipment_cost_lines\s+WHERE type='BUY'/.test(sql)) return lines.filter(l => l.type === "BUY" && l.gl_exported_at === null).map(l => ({ ...l }));
    const upd = sql.match(/UPDATE (\w+) SET gl_exported_at=\$1, gl_export_batch_id=\$2/);
    if (upd) {
      // Postgres evaluates a conditional UPDATE's WHERE atomically per row — mirrored here by
      // doing the whole claim synchronously, with no await inside.
      const [now, batch, ...ids] = params;
      const onlyUnexported = /gl_exported_at IS NULL/.test(sql);
      const claimed = tables[upd[1]].filter(r => ids.includes(r.id) && (!onlyUnexported || r.gl_exported_at === null));
      for (const r of claimed) { r.gl_exported_at = now; r.gl_export_batch_id = batch; }
      return claimed.map(r => ({ id: r.id }));
    }
    if (/INSERT INTO gl_export_batches/.test(sql)) { batches.push({ id: params[0], rowCount: params[3] }); return []; }
    throw new Error(`fake db: unexpected SQL ${sql.slice(0, 60)}`);
  }
  const transaction = fn => fn({ query });
  return { query, transaction, docs, lines, batches };
}

(async () => {
  console.log("Two GL export runs started together");
  const db = makeDb();
  let n = 0;
  const { runGlExport } = createGlExport({
    query: db.query, transaction: db.transaction, uid: () => `T${++n}`,
    costLineEffectiveUsd: l => l.amount * (l.exchange_rate || 1), getSettings: async () => ({}),
  });
  const range = { dateFrom: "2026-09-30", dateTo: "2026-09-30", user: "test" };
  const [a, b] = await Promise.all([runGlExport(range), runGlExport(range)]);

  const refsOf = r => r.rows.map(x => x.memo.includes("CL-B1") ? "CL-B1" : x.reference);
  const ra = new Set(refsOf(a)), rb = new Set(refsOf(b));
  const both = [...ra].filter(x => rb.has(x));
  assert("the two runs exported disjoint rows", both.length === 0, `both exported ${both.join(", ")}`);
  const all = new Set([...ra, ...rb]);
  assert("together they exported every row exactly once", ["DOC-A", "DOC-B", "CL-B1"].every(id => all.has(id)), [...all].join(", "));
  assert("each document is stamped with the batch that exported it",
    db.docs.every(d => (ra.has(d.id) ? a.batchId : b.batchId) === d.gl_export_batch_id), JSON.stringify(db.docs.map(d => [d.id, d.gl_export_batch_id])));
  assert("each run's batch row counts only its own rows",
    db.batches.find(x => x.id === a.batchId)?.rowCount === a.rows.length && db.batches.find(x => x.id === b.batchId)?.rowCount === b.rows.length,
    JSON.stringify(db.batches));
  const debit = r => r.rows.reduce((s, x) => s + (x.debit || 0), 0), credit = r => r.rows.reduce((s, x) => s + (x.credit || 0), 0);
  assert("each run's entries still balance", Math.abs(debit(a) - credit(a)) < 0.005 && Math.abs(debit(b) - credit(b)) < 0.005);

  console.log("\nA re-run over the same range exports nothing");
  const again = await runGlExport(range);
  assert("no rows the second time", again.rows.length === 0, JSON.stringify(again.rows));

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(e => { console.error("\nFatal:", e.message); process.exit(1); });
