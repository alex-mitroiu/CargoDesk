/**
 * Consolidated statements are chased like invoices (decided by the user 2026-10-09, TKT-IRH7WX):
 *   - owner = whoever confirmed the statement (as for an invoice);
 *   - its office = the export office of its shipments, or the one carrying the largest share of its
 *     value when they differ (statementMainOffice) — the office whose mail account, thresholds and
 *     manager the reminder / alert / escalation use;
 *   - a row in Billing Performance and in Invoice Collections (shipmentId null, statementId and the
 *     shipmentIds it bills);
 *   - an override may be recorded by a trade manager responsible for the lane of ANY of its shipments
 *     who can also see the statement, i.e. every shipment on it (TKT-6T97DY; decided 2026-10-10).
 * This environment has no reachable SMTP server, so — like billing-performance.test.js and
 * invoice-collections.test.js — the sweeps are exercised up to that network boundary (no crash, no
 * false "sent"), not through a real send.
 *
 * Usage:
 *   node tests/statement-collections.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001, PDF Render Service on :3003
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC, CNSHA, USLAX present in port_locations (seeded MDM data)
 */

import http from "node:http";
import { ensureOffices, retireOffice } from "./helpers/offices.mjs";

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

const near = (a, b) => Math.abs((a ?? NaN) - b) < 0.011;
const SAMPLE_HTML = `<html><body><h1>Statement (test fixture)</h1></body></html>`;
const rand = Math.random().toString(36).slice(2, 7);

(async () => {
  const cleanup = { shipments: [], customers: [], users: [], offices: [] };
  let token;
  try {
    console.log("Logging in…");
    const login = await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" });
    token = login.body.token;
    const me = login.body.user;
    console.log("  ✓ Logged in");
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);
    // A second export office, so the statement spans two and the bigger one must win. Same branch as
    // the first: a statement is issued by one legal entity (an office's branch), so two branches would
    // be refused — and a branchless office would fall back to the import office's branch instead.
    const branchId = (await request("GET", "/api/offices", null, token)).body.find(o => o.id === emoOfficeId)?.branchId || null;
    const office2 = await request("POST", "/api/offices", { unlocode: `X${rand.slice(0, 4).toUpperCase()}`, department: "SE", name: `Statement Test Office ${rand}`, branchId }, token);
    cleanup.offices.push(office2.body.id);
    assert("second export office created", !!office2.body.id, JSON.stringify(office2.body));

    const cust = await request("POST", "/api/customers", { companyName: `Statement Collections Co ${rand}`, currency: "USD",
      creditLimit: 100000, creditTermsDays: 30, reminderEnabled: true }, token);
    const consignee = await request("POST", "/api/customers", { companyName: `Statement Consignee ${rand}` }, token);
    cleanup.customers.push(cust.body.id, consignee.body.id);
    const newShipment = async (pol, pod, carrierCode, emo) => {
      const s = await request("POST", "/api/shipments", {
        pol, pod, carrierCode, status: "Active", contractType: "SPOT", etd: "2026-10-12", eta: "2026-10-30",
        incoterm: "FOB", commodityCode: "9999",
        shipperId: cust.body.id, shipperName: cust.body.companyName, consigneeId: consignee.body.id, consigneeName: consignee.body.companyName,
        principalId: cust.body.id, principalName: cust.body.companyName, emoOfficeId: emo, imoOfficeId,
      }, token);
      cleanup.shipments.push(s.body.id);
      await request("POST", "/api/containers", { shipmentId: s.body.id, containerNumber: `MSKU${String(Date.now()).slice(-7)}`,
        size: "40", type: "HC", hsCode: "940360", cargoDescription: "Furniture", grossWeightKg: 9000, volumeCbm: 60 }, token);
      return s.body.id;
    };
    const sell = async (shipmentId, amount, vatRate = 0) =>
      (await request("POST", `/api/shipments/${shipmentId}/cost-lines`, { type: "SELL", chargeCode: "Ocean Freight", amount, currency: "USD", exchangeRate: 1, vatRate }, token)).body.id;

    // Shipment A (default office, NLRTM → USNYC) carries 300; shipment B (office 2, CNSHA → USLAX) 900.
    const shipA = await newShipment("NLRTM", "USNYC", "MAEU", emoOfficeId);
    const shipB = await newShipment("CNSHA", "USLAX", "EGLV", office2.body.id);
    const lineA = await sell(shipA, 300, 20);
    const lineB = await sell(shipB, 900);

    console.log("\nGenerate and confirm a statement over both shipments");
    const gen = await request("POST", "/api/customer-statements/generate", {
      customerId: cust.body.id, dateFrom: "2020-01-01", dateTo: "2030-12-31", costLineIds: [lineA, lineB], html: SAMPLE_HTML, filename: `stmt-${rand}.html`,
    }, token);
    assert("statement generated", gen.status === 201, JSON.stringify(gen.body).slice(0, 300));
    const stId = gen.body.id;
    const conf = await request("POST", `/api/customer-statements/${stId}/confirm`, {}, token);
    assert("statement confirmed", conf.status === 200, JSON.stringify(conf.body).slice(0, 300));
    const st = (await request("GET", `/api/customer-statements/${stId}`, null, token)).body;
    assert("whoever confirmed it owns it", st.ownerId === me.id, JSON.stringify({ ownerId: st.ownerId, me: me.id }));

    console.log("\nBilling Performance — a row for the statement");
    const bp = (await request("GET", "/api/reports/billing-performance", null, token)).body;
    const bpRow = bp.find(r => r.statementId === stId);
    assert("the statement has a row, typed STMT, with no single shipment", bpRow?.docType === "STMT" && bpRow.shipmentId === null, JSON.stringify(bpRow));
    assert("it lists both shipments it bills", bpRow && [shipA, shipB].every(id => bpRow.shipmentIds.includes(id)), JSON.stringify(bpRow?.shipmentIds));
    assert("amount is gross, the same figure AR counts (300 × 1.2 + 900 = 1260)", near(bpRow?.amountUsd, 1260) && near(bpRow?.outstandingUsd, 1260), JSON.stringify(bpRow));
    assert("its office is the export office with the larger share (office 2, 900 vs 300)", bpRow?.officeId === office2.body.id, JSON.stringify({ officeId: bpRow?.officeId }));
    assert("unpaid, not yet past 30-day terms", bpRow?.paymentState === "unpaid", bpRow?.paymentState);

    console.log("\nInvoice Collections — a row for the statement");
    const ic = (await request("GET", "/api/reports/invoice-collections", null, token)).body;
    const icRow = ic.find(r => r.statementId === stId);
    assert("the statement has a row, Not Paid", icRow?.status === "not_paid" && icRow.docType === "STMT", JSON.stringify(icRow));
    assert("its owner is shown", icRow?.invoiceOwnerId === me.id, JSON.stringify(icRow));
    assert("…and its shipments", icRow && [shipA, shipB].every(id => icRow.shipmentIds.includes(id)), JSON.stringify(icRow?.shipmentIds));
    assert("neither shipment is reported as Missing an invoice", !ic.some(r => [shipA, shipB].includes(r.shipmentId) && r.status === "missing"));

    console.log("\nOverride — a trade manager of ANY of its lanes who can see the whole statement");
    const tmEmail = `tm-stmt-${rand}@example.com`;
    await request("POST", "/api/users", { email: tmEmail, name: "TM Statement Test", roles: ["trade_manager"], password: "TmFixture!2026Zq" }, token);
    cleanup.users.push(tmEmail);
    const tmId = (await request("GET", "/api/users", null, token)).body.find(u => u.email === tmEmail)?.id;
    const tmToken = (await request("POST", "/api/auth/login", { email: tmEmail, password: "TmFixture!2026Zq" })).body.token;
    const body = { reasonCode: "END_OF_MONTH_TERMS", description: "Customer pays at month end", overriddenStatus: "not_paid" };
    const noLane = await request("POST", `/api/customer-statements/${stId}/status-override`, body, tmToken);
    // No office and no scope items yet: the access filter doesn't restrict such a user (server.js
    // applyShipmentAccessFilter), so they see the statement but own none of its lanes.
    assert("a trade manager with none of its lanes is refused (403)", noLane.status === 403, JSON.stringify(noLane.body));
    const asAdmin = await request("POST", `/api/customer-statements/${stId}/status-override`, body, token);
    assert("so is an admin — the same rule as invoices", asAdmin.status === 403, JSON.stringify(asAdmin.body));
    // Grant the TM shipment A's lane only (NLRTM → USNYC); B's lane stays someone else's.
    const polLanes = (await request("GET", "/api/port-locations/NLRTM/lanes", null, token)).body;
    const podLanes = (await request("GET", "/api/port-locations/USNYC/lanes", null, token)).body;
    const origin = polLanes.primary || polLanes.lanes?.[0], dest = podLanes.primary || podLanes.lanes?.[0];
    const origCode = typeof origin === "string" ? origin : origin?.code, destCode = typeof dest === "string" ? dest : dest?.code;
    const grant = await request("POST", `/api/users/${tmId}/scope`, { role: "trade_manager", itemType: "trade_lane",
      value: JSON.stringify({ origin: origCode, dest: destCode }), label: `${origCode} → ${destCode}` }, token);
    assert("TM granted shipment A's lane", grant.status === 201 && !!origCode && !!destCode, JSON.stringify({ grant: grant.body, origCode, destCode }));
    const tmToken2 = (await request("POST", "/api/auth/login", { email: tmEmail, password: "TmFixture!2026Zq" })).body.token;
    // TKT-6T97DY's visibility rule: a statement shows only to someone who can see EVERY shipment on
    // it — the reports follow it, so they never reveal it (or the ids of its other shipments).
    const icAsTm = await request("GET", "/api/reports/invoice-collections", null, tmToken2);
    assert("Invoice Collections hides it from a TM who sees only one of its two shipments",
      icAsTm.status === 200 && !icAsTm.body.some(r => r.statementId === stId), JSON.stringify(icAsTm.body.find?.(r => r.statementId === stId)));
    // ...and the override follows the same rule (decided 2026-10-10): owning one of its lanes isn't
    // enough while the statement is invisible to them. Before, this override went through by id.
    const oneLane = await request("POST", `/api/customer-statements/${stId}/status-override`, body, tmToken2);
    assert("the TM of one lane who can't see shipment B can't override it (404, as on every statement route)", oneLane.status === 404, JSON.stringify(oneLane.body));
    const before = (await request("GET", "/api/reports/invoice-collections", null, token)).body.find(r => r.statementId === stId);
    assert("...and nothing was recorded", before?.status === "not_paid", JSON.stringify(before?.status));
    // Grant shipment B's lane too (CNSHA → USLAX): now the TM sees every shipment on the statement.
    const bPol = (await request("GET", "/api/port-locations/CNSHA/lanes", null, token)).body;
    const bPod = (await request("GET", "/api/port-locations/USLAX/lanes", null, token)).body;
    const bOrigin = bPol.primary || bPol.lanes?.[0], bDest = bPod.primary || bPod.lanes?.[0];
    const bOrigCode = typeof bOrigin === "string" ? bOrigin : bOrigin?.code, bDestCode = typeof bDest === "string" ? bDest : bDest?.code;
    const grantB = await request("POST", `/api/users/${tmId}/scope`, { role: "trade_manager", itemType: "trade_lane",
      value: JSON.stringify({ origin: bOrigCode, dest: bDestCode }), label: `${bOrigCode} → ${bDestCode}` }, token);
    assert("TM granted shipment B's lane as well", grantB.status === 201 && !!bOrigCode && !!bDestCode, JSON.stringify({ grant: grantB.body, bOrigCode, bDestCode }));
    const tmToken3 = (await request("POST", "/api/auth/login", { email: tmEmail, password: "TmFixture!2026Zq" })).body.token;
    const icAsTm3 = await request("GET", "/api/reports/invoice-collections", null, tmToken3);
    assert("Invoice Collections now shows the statement to that TM", icAsTm3.status === 200 && icAsTm3.body.some(r => r.statementId === stId));
    const badCode = await request("POST", `/api/customer-statements/${stId}/status-override`, { ...body, reasonCode: "NOT_A_REAL_CODE" }, tmToken3);
    assert("an unknown reason code is refused", badCode.status >= 400 && badCode.status < 500 && badCode.status !== 403 && badCode.status !== 404, JSON.stringify(badCode.body));
    const ok = await request("POST", `/api/customer-statements/${stId}/status-override`, body, tmToken3);
    assert("a TM who sees the whole statement and owns one of its lanes can override it", ok.status === 200 && ok.body.documentId === stId, JSON.stringify(ok.body));
    const ic2 = (await request("GET", "/api/reports/invoice-collections", null, token)).body;
    assert("Invoice Collections now shows it Overridden", ic2.find(r => r.statementId === stId)?.status === "overridden");

    console.log("\nSweeps walk statements without crashing (no SMTP here, so nothing is actually sent)");
    const dun = await request("POST", "/api/billing/send-reminders", {}, token);
    assert("reminder sweep 200", dun.status === 200 && dun.body.sentCount === dun.body.sent.length, JSON.stringify(dun.body).slice(0, 200));
    assert("a statement not yet past its terms gets no reminder", !dun.body.sent?.some(s => s.statementId === stId));
    const col = await request("POST", "/api/billing/run-collections-sweep", {}, token);
    assert("collections sweep 200", col.status === 200 && col.body.sentCount === col.body.sent.length, JSON.stringify(col.body).slice(0, 200));
    assert("an overridden statement gets no collections alert", !col.body.sent?.some(s => s.statementId === stId));

    console.log("\nPaid in full");
    await request("POST", `/api/customer-statements/${stId}/mark-paid`, { paidAt: new Date().toISOString().slice(0, 10), paidAmount: 1260 }, token);
    const bpPaid = (await request("GET", "/api/reports/billing-performance", null, token)).body.find(r => r.statementId === stId);
    assert("Billing Performance shows it paid", bpPaid?.paymentState === "paid" && near(bpPaid.outstandingUsd, 0), JSON.stringify(bpPaid));
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    if (token) {
      console.log("\nCleanup");
      // Billed shipments can't be deleted; the scratch office is retired so ensureOffices() never picks it up.
      for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
      for (const id of cleanup.offices) await retireOffice(token, id).catch(() => {});
      const users = (await request("GET", "/api/users", null, token)).body || [];
      for (const email of cleanup.users) { const u = users.find(x => x.email === email); if (u) await request("DELETE", `/api/users/${u.id}`, null, token); }
    }
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
