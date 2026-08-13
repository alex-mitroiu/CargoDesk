/**
 * Freight Audit & Payment — carrier invoice reconciliation against contracted rates / accrued
 * cost lines, plus a Detention & Demurrage pre-audit computed from the existing free-time
 * tracking (containers.origin_free_time_days/dest_free_time_days + container_events).
 *
 * Usage:
 *   node tests/freight-audit-payment.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";

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

(async () => {
  const cleanup = { shipments: [], contracts: [] };
  try {
    const token = await login();

    console.log("Scratch contract — OF rate + a per-day DET rate");
    const contractNum = `FAP-${Date.now()}`;
    const contract = await request("POST", "/api/contracts", {
      contractNumber: contractNum, carrierCode: "MSCU", status: "Active",
      validFrom: "2026-01-01", validTo: "2027-01-01",
      legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [
        { serviceCode: "OF", amount: 1000, currency: "USD", unit: "per_container", containerType: "40HC" },
        { serviceCode: "DET", amount: 150, currency: "USD", unit: "per_day", containerType: "" },
      ],
    }, token);
    assert("contract created", contract.status === 201, JSON.stringify(contract.body));
    const contractId = contract.body.id;
    cleanup.contracts.push(contractId);

    console.log("\nScratch Central shipment linked to that contract, with one 40HC container");
    const ship = await request("POST", "/api/shipments", {
      pol: "NLRTM", pod: "USNYC", carrierCode: "MSCU", contractType: "Central", contractId, status: "Active",
    }, token);
    assert("shipment created", ship.status === 201, JSON.stringify(ship.body));
    const shipmentId = ship.body.id;
    cleanup.shipments.push(shipmentId);

    const ctr = await request("POST", "/api/containers", {
      shipmentId, containerNumber: "FAPU1234567", size: "40", type: "HC",
      originFreeTimeDays: 3, destFreeTimeDays: 3,
    }, token);
    assert("container created", ctr.status === 201, JSON.stringify(ctr.body));
    const containerId = ctr.body.id;

    // The very first importContractRates ran at shipment-creation time, BEFORE this container
    // existed — its per-container OF rate had nothing to apply to yet and was skipped. Re-import
    // with overwrite now that the container is on the shipment, matching how a real operator
    // would use the "Import from Contract" action after adding cargo.
    const reimport = await request("POST", `/api/shipments/${shipmentId}/cost-lines/import-contract`, { overwrite: true }, token);
    assert("re-import from contract succeeds", reimport.status === 200, JSON.stringify(reimport.body));

    console.log("\nimportContractRates auto-accrued an OF cost line now that the container exists");
    const costLines1 = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
    const accruedOF = costLines1.body.find(l => l.chargeCode === "Ocean Freight" && l.status === "accrued");
    assert("an accrued Ocean Freight cost line exists", !!accruedOF, JSON.stringify(costLines1.body));

    console.log("\nSimulate a late destination free-time window (7 days late)");
    const now = Date.now();
    const daysAgo = n => new Date(now - n * 86400000).toISOString();
    await request("POST", `/api/containers/${containerId}/events`, { eventType: "Discharged", occurredAt: daysAgo(10) }, token);
    await request("POST", `/api/containers/${containerId}/events`, { eventType: "Gate Out", occurredAt: daysAgo(0) }, token);
    // dest_free_time_days=3, Discharged 10 days ago, Gate Out today -> 10 - 3 = 7 days late

    console.log("\nCarrier invoice — OF line (matches the accrued cost line, within tolerance), DET line (D&D pre-audit), and an unmapped MISC line");
    const invoice = await request("POST", "/api/carrier-invoices", {
      shipmentId, carrierCode: "MSCU", invoiceNumber: `INV-${Date.now()}`, invoiceDate: "2026-06-01", currency: "USD",
      lines: [
        { serviceCode: "OF", description: "Ocean Freight", amount: 1000, currency: "USD" },
        { serviceCode: "DET", description: "Destination detention", containerId, freeTimeSide: "destination", amount: 1050, currency: "USD" },
        { serviceCode: "MISC", description: "Unmapped miscellaneous charge", amount: 75, currency: "USD" },
      ],
    }, token);
    assert("invoice created (201)", invoice.status === 201, JSON.stringify(invoice.body));
    const invoiceId = invoice.body.id;
    const [ofLine, detLine, miscLine] = invoice.body.lines;

    assert("OF line matched against the accrued cost line", ofLine.expectedSource === "cost_line" && ofLine.matchedCostLineId === accruedOF.id, JSON.stringify(ofLine));
    assert("OF line status is 'matched' (exact amount, no variance)", ofLine.status === "matched", JSON.stringify(ofLine));

    assert("DET line D&D pre-audit resolved (7 late days x $150/day = $1050)", detLine.expectedAmount === 1050, JSON.stringify(detLine));
    assert("DET line status is 'matched' (invoiced amount equals the independently computed expected charge)", detLine.status === "matched", JSON.stringify(detLine));

    assert("MISC line has no comparison available", miscLine.expectedSource === "", JSON.stringify(miscLine));
    assert("MISC line status is 'pending'", miscLine.status === "pending", JSON.stringify(miscLine));

    assert("invoice status is 'Pending' (MISC line still needs attention)", invoice.body.status === "Pending", JSON.stringify(invoice.body));

    console.log("\nException queue lists only the unresolved MISC line for this invoice");
    const exceptions = await request("GET", "/api/carrier-invoices/exceptions", null, token);
    const ourExceptions = exceptions.body.filter(e => e.invoiceId === invoiceId);
    assert("exactly one exception line for this invoice (MISC)", ourExceptions.length === 1 && ourExceptions[0].serviceCode === "MISC", JSON.stringify(ourExceptions));

    console.log("\nApprove the OF line — actualizes the existing matched cost line, doesn't create a new one");
    const approveOf = await request("POST", `/api/carrier-invoice-lines/${ofLine.id}/approve`, {}, token);
    assert("approve OF returns 200", approveOf.status === 200 && approveOf.body.status === "approved", JSON.stringify(approveOf.body));
    const costLinesAfterOf = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
    const actualizedOF = costLinesAfterOf.body.find(l => l.id === accruedOF.id);
    assert("the SAME cost line is now actualized with the invoiced amount", actualizedOF.status === "actualized" && actualizedOF.actualAmount === 1000, JSON.stringify(actualizedOF));
    assert("no duplicate Ocean Freight cost line was created", costLinesAfterOf.body.filter(l => l.chargeCode === "Ocean Freight").length === 1);

    console.log("\nApprove the DET line — no matched cost line existed, so a new one is created directly as actualized");
    const approveDet = await request("POST", `/api/carrier-invoice-lines/${detLine.id}/approve`, {}, token);
    assert("approve DET returns 200", approveDet.status === 200 && approveDet.body.status === "approved", JSON.stringify(approveDet.body));
    assert("DET line now carries a matchedCostLineId", !!approveDet.body.matchedCostLineId, JSON.stringify(approveDet.body));
    const costLinesAfterDet = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
    const newDetLine = costLinesAfterDet.body.find(l => l.id === approveDet.body.matchedCostLineId);
    assert("new Detention cost line created, actualized, sourced from carrier_invoice", !!newDetLine && newDetLine.status === "actualized" && newDetLine.actualAmount === 1050 && newDetLine.source === "carrier_invoice", JSON.stringify(newDetLine));

    console.log("\nDispute the MISC line");
    const dispute = await request("POST", `/api/carrier-invoice-lines/${miscLine.id}/dispute`, { reason: "No corresponding contract charge — querying with carrier" }, token);
    assert("dispute returns 200", dispute.status === 200 && dispute.body.status === "disputed", JSON.stringify(dispute.body));

    console.log("\nInvoice status rolls up to 'Disputed' once a line is disputed, even with others approved");
    const invoiceFinal = await request("GET", `/api/carrier-invoices/${invoiceId}`, null, token);
    assert("invoice status is Disputed", invoiceFinal.body.status === "Disputed", JSON.stringify(invoiceFinal.body));

    console.log("\nException queue no longer lists this invoice's lines (all resolved)");
    const exceptions2 = await request("GET", "/api/carrier-invoices/exceptions", null, token);
    assert("no more exceptions for this invoice", !exceptions2.body.some(e => e.invoiceId === invoiceId), JSON.stringify(exceptions2.body.filter(e => e.invoiceId === invoiceId)));

    console.log("\nA second invoice's OF line now falls through to the contract rate (no accrued line left — it's actualized)");
    const invoice2 = await request("POST", "/api/carrier-invoices", {
      shipmentId, carrierCode: "MSCU", invoiceNumber: `INV2-${Date.now()}`, invoiceDate: "2026-06-15", currency: "USD",
      lines: [{ serviceCode: "OF", description: "Correction invoice", amount: 5000, currency: "USD" }],
    }, token);
    const of2 = invoice2.body.lines[0];
    assert("second OF line falls back to the contract rate", of2.expectedSource === "contract_rate" && of2.expectedAmount === 1000, JSON.stringify(of2));
    assert("second OF line is flagged 'variance' (5000 vs 1000 contracted)", of2.status === "variance", JSON.stringify(of2));

    console.log("\nDelete guard — an invoice with an approved line cannot be deleted");
    const delBlocked = await request("DELETE", `/api/carrier-invoices/${invoiceId}`, null, token);
    assert("delete rejected once a line is approved", delBlocked.status === 400, JSON.stringify(delBlocked.body));
    const delOk = await request("DELETE", `/api/carrier-invoices/${invoice2.body.id}`, null, token);
    assert("delete succeeds for an invoice with no approved lines", delOk.status === 200, JSON.stringify(delOk.body));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const cleanupToken = await login().catch(() => null);
    if (cleanupToken) {
      for (const id of cleanup.shipments) { try { await request("DELETE", `/api/shipments/${id}`, null, cleanupToken); } catch {} }
      for (const id of cleanup.contracts) { try { await request("DELETE", `/api/contracts/${id}`, null, cleanupToken); } catch {} }
    }
  }
})();
