/**
 * FX Revaluation — unrealized gain/loss (confirmed, unpaid, non-USD invoices vs. today's live
 * rate) and realized gain/loss (paid invoices with the Mark as Paid FX-capture fields set), plus
 * the Mark as Paid route extension itself (paidAmountOriginal/paidCurrency/paidExchangeRate,
 * fully optional and backward compatible).
 *
 * Usage:
 *   node tests/fx-revaluation.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - PDF Render Service running on :3003
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: 3001, path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
      },
    };
    const req = http.request(opts, res => {
      let data = "";
      res.on("data", chunk => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost", password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

const SAMPLE_HTML = `<html><body><h1>Freight Invoice (test fixture)</h1></body></html>`;

async function scratchShipment(token, emoOfficeId, imoOfficeId) {
  const res = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", etd: "2026-09-01",
    emoOfficeId, imoOfficeId,
  }, token);
  return res.body.id;
}

async function invoiceEur(shipmentId, token, amount) {
  const line = await request("POST", `/api/shipments/${shipmentId}/cost-lines`,
    { type: "SELL", chargeCode: "Ocean Freight", currency: "EUR", amount, exchangeRate: 1.08 }, token);
  const doc = await request("POST", `/api/shipments/${shipmentId}/documents/generate`, {
    html: SAMPLE_HTML, filename: `FR01-${shipmentId}.html`, docType: "FR01", sourceCostLineIds: [line.body.id],
  }, token);
  const confirmed = await request("PATCH", `/api/shipments/${shipmentId}/documents/${doc.body.id}`, { status: "confirmed" }, token);
  return { line: line.body, doc: confirmed.body };
}

(async () => {
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);

    console.log("\nMark as Paid — the 3 new fields are fully optional (existing plain usage unaffected)");
    const shipPlain = await scratchShipment(token, emoOfficeId, imoOfficeId);
    const { doc: plainDoc } = await invoiceEur(shipPlain, token, 100);
    const plainPaid = await request("POST", `/api/shipments/${shipPlain}/documents/${plainDoc.id}/mark-paid`,
      { paidAt: "2026-09-27", paidAmount: 108 }, token);
    assert("mark-paid with only the original 3 fields still returns 200", plainPaid.status === 200, JSON.stringify(plainPaid.body));
    assert("paidAmountOriginal stays null when not sent", plainPaid.body.paidAmountOriginal == null, JSON.stringify(plainPaid.body));

    console.log("\nMark as Paid — validation on the new optional fields when partially filled");
    const shipPartial = await scratchShipment(token, emoOfficeId, imoOfficeId);
    const { doc: partialDoc } = await invoiceEur(shipPartial, token, 100);
    const partialPaid = await request("POST", `/api/shipments/${shipPartial}/documents/${partialDoc.id}/mark-paid`,
      { paidAt: "2026-09-27", paidAmount: 108, paidAmountOriginal: 100 }, token); // currency/rate omitted
    assert("paidAmountOriginal alone (no currency/rate) is rejected", partialPaid.status >= 400, JSON.stringify(partialPaid.body));

    console.log("\nUnrealized gain/loss — a confirmed, unpaid EUR invoice vs. today's live rate");
    const shipUnrealized = await scratchShipment(token, emoOfficeId, imoOfficeId);
    const { doc: unrealizedDoc } = await invoiceEur(shipUnrealized, token, 1000); // booked at 1.08 -> $1080 USD
    const summary1 = await request("GET", "/api/fx-revaluation/summary", null, token);
    assert("summary returns 200", summary1.status === 200, JSON.stringify(summary1.body));
    const unrealizedRow = summary1.body.unrealized.find(r => r.docId === unrealizedDoc.id);
    assert("the unpaid EUR invoice appears in unrealized", !!unrealizedRow, JSON.stringify(summary1.body.unrealized.map(r => r.docId)));
    assert("its booked USD reflects the original 1.08 rate", unrealizedRow?.bookedUsd === 1080, JSON.stringify(unrealizedRow));
    assert("its foreign amount is the real EUR amount", unrealizedRow?.foreignAmount === 1000, JSON.stringify(unrealizedRow));
    assert("todaysUsd is a real, positive number (live FX)", typeof unrealizedRow?.todaysUsd === "number" && unrealizedRow.todaysUsd > 0);
    assert("gainLossUsd is todaysUsd - bookedUsd", Math.abs(unrealizedRow.gainLossUsd - (unrealizedRow.todaysUsd - unrealizedRow.bookedUsd)) < 0.01);

    console.log("\nUnrealized excludes USD invoices (no FX exposure) and already-paid ones");
    const shipUsd = await scratchShipment(token, emoOfficeId, imoOfficeId);
    const usdLine = await request("POST", `/api/shipments/${shipUsd}/cost-lines`, { type: "SELL", chargeCode: "Ocean Freight", currency: "USD", amount: 500, exchangeRate: 1 }, token);
    const usdDoc = await request("POST", `/api/shipments/${shipUsd}/documents/generate`, { html: SAMPLE_HTML, filename: `FR01-${shipUsd}.html`, docType: "FR01", sourceCostLineIds: [usdLine.body.id] }, token);
    await request("PATCH", `/api/shipments/${shipUsd}/documents/${usdDoc.body.id}`, { status: "confirmed" }, token);
    const summary2 = await request("GET", "/api/fx-revaluation/summary", null, token);
    assert("a USD-denominated invoice never appears in unrealized", !summary2.body.unrealized.some(r => r.docId === usdDoc.body.id));
    assert("the already-paid EUR invoice from above no longer appears in unrealized", !summary2.body.unrealized.some(r => r.docId === plainDoc.id));

    console.log("\nRealized gain/loss — Mark as Paid with the real received amount + rate");
    const shipRealized = await scratchShipment(token, emoOfficeId, imoOfficeId);
    const { doc: realizedDoc } = await invoiceEur(shipRealized, token, 1000); // booked at 1.08 -> $1080 USD
    const realizedPaid = await request("POST", `/api/shipments/${shipRealized}/documents/${realizedDoc.id}/mark-paid`,
      { paidAt: "2026-09-27", paidAmount: 1075, paidAmountOriginal: 1000, paidCurrency: "EUR", paidExchangeRate: 1.075 }, token);
    assert("mark-paid with the FX fields returns 200", realizedPaid.status === 200, JSON.stringify(realizedPaid.body));
    assert("paidAmountOriginal round-trips", realizedPaid.body.paidAmountOriginal === 1000);
    assert("paidCurrency round-trips", realizedPaid.body.paidCurrency === "EUR");
    assert("paidExchangeRate round-trips", realizedPaid.body.paidExchangeRate === 1.075);

    const summary3 = await request("GET", "/api/fx-revaluation/summary", null, token);
    const realizedRow = summary3.body.realized.find(r => r.docId === realizedDoc.id);
    assert("the paid EUR invoice appears in realized", !!realizedRow, JSON.stringify(summary3.body.realized.map(r => r.docId)));
    assert("its booked USD reflects the original 1.08 rate", realizedRow?.bookedUsd === 1080);
    assert("its received USD reflects paid_amount (1075)", realizedRow?.receivedUsd === 1075);
    assert("realized gain/loss is receivedUsd - bookedUsd (a loss of $5)", Math.abs(realizedRow.gainLossUsd - (1075 - 1080)) < 0.01, JSON.stringify(realizedRow));
    assert("the same paid invoice does NOT also appear in unrealized", !summary3.body.unrealized.some(r => r.docId === realizedDoc.id));

    console.log("\nTotals aggregate correctly");
    assert("totals.realizedUsd is a number", typeof summary3.body.totals.realizedUsd === "number");
    assert("totals.unrealizedUsd is a number", typeof summary3.body.totals.unrealizedUsd === "number");

    console.log("\nCleanup");
    for (const id of [shipPlain, shipPartial, shipUnrealized, shipUsd, shipRealized]) {
      await request("DELETE", `/api/shipments/${id}`, null, token);
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
