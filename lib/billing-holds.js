"use strict";

// One SELL line, one live billing document (decided 2026-09-30, TKT-2F19XD). A charge line may sit
// on at most one invoice or credit/debit note (FR01/FR02/CN01, draft or confirmed) or one
// consolidated statement that isn't voided. Deleting a draft invoice, voiding an invoice (a
// reversal voids it, and its CN01 then holds the negative reversal lines instead) or voiding a
// draft statement frees the lines again. Used by every path that bills a line — per-shipment
// invoice generation, statement generation and the statement eligible-lines preview — so the
// rule can't hold in one direction and not the other (it used to: eligible-lines excluded
// invoiced lines, but invoice generation never looked at statements).

const BILLING_DOC_TYPES = ["FR01", "FR02", "CN01"];

module.exports = function createBillingHolds({ query }) {
  const ph = (n, from = 1) => Array.from({ length: n }, (_, i) => `$${i + from}`).join(",");

  // costLineIds → Map(costLineId → { kind: "invoice" | "statement", id, docType, status, label }).
  // Lines no document holds are absent from the map. `ignoreDocId` leaves out one invoice — the
  // draft a regenerate is about to replace.
  async function billingHolds(costLineIds, { ignoreDocId = null } = {}) {
    const ids = [...new Set((costLineIds || []).filter(Boolean))];
    const holds = new Map();
    if (!ids.length) return holds;

    // source_cost_line_ids is a JSON array column (not joinable), so narrow the documents to the
    // lines' own shipments first, then match in JS.
    const lines = await query(`SELECT id, shipment_id FROM shipment_cost_lines WHERE id IN (${ph(ids.length)})`, ids);
    const shipmentIds = [...new Set(lines.map(l => l.shipment_id))];
    if (shipmentIds.length) {
      const docs = await query(
        `SELECT id, doc_type, status, filename, source_cost_line_ids FROM shipment_documents
         WHERE doc_type IN (${BILLING_DOC_TYPES.map(t => `'${t}'`).join(",")}) AND status IN ('draft','confirmed')
           AND shipment_id IN (${ph(shipmentIds.length)})
         ORDER BY created_at`, shipmentIds);
      const wanted = new Set(ids);
      for (const d of docs) {
        if (d.id === ignoreDocId || !d.source_cost_line_ids) continue;
        for (const id of JSON.parse(d.source_cost_line_ids)) {
          if (wanted.has(id) && !holds.has(id))
            holds.set(id, { kind: "invoice", id: d.id, docType: d.doc_type, status: d.status, label: d.filename });
        }
      }
    }

    const statementLines = await query(
      `SELECT csl.cost_line_id, cs.id, cs.status FROM customer_statement_lines csl
       JOIN customer_statements cs ON cs.id = csl.statement_id
       WHERE cs.status != 'voided' AND csl.cost_line_id IN (${ph(ids.length)})
       ORDER BY cs.created_at`, ids);
    for (const r of statementLines) {
      if (!holds.has(r.cost_line_id))
        holds.set(r.cost_line_id, { kind: "statement", id: r.id, docType: "STMT", status: r.status, label: r.id });
    }
    return holds;
  }

  // "Ocean Freight is already billed on STMT-X (confirmed statement)" — one clause per held line.
  function describeHolds(holds, lineRows) {
    const byId = new Map(lineRows.map(l => [l.id, l]));
    return [...holds].map(([id, h]) => {
      const what = byId.get(id)?.charge_code || id;
      const where = h.kind === "statement" ? `${h.id} (${h.status} statement)` : `${h.label || h.id} (${h.status} ${h.docType})`;
      return `${what} is already billed on ${where}`;
    }).join("; ");
  }

  return { billingHolds, describeHolds };
};
