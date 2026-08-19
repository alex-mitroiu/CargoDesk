/**
 * Workflow / business-process audit fixes — smoke tests
 *
 * Usage:
 *   node tests/workflow-improvements.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Document Distribution Service running on :3002 (for the EDI/webhook ATTEMPTED-event checks)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *
 * Covers, in the order they were implemented (user-directed: bugs, then consistency gaps, then
 * process automation):
 *   Bug 1 — screening-override role gate now enforced server-side (shipment + customer level)
 *   Bug 2 — customs-filing creation now server-enforces broker + priced-cargo preconditions
 *   Bug 3 — credit-hold now hard-blocks FR01/FR02 invoice generation server-side
 *   Consistency 4 — shipments.status / contracts.status enum validation
 *   Consistency 5 — milestone out-of-order completion is flagged (outOfOrder:true), not blocked
 *   Process automation 7 — ops-automation sweep auto-creates tickets, deduped by source
 *   Process automation 8 — an EDI send writes an *_ATTEMPTED audit event before the real call
 * Does NOT re-test Consistency 6 (DG/IMDG policy dedup) — a pure client-side refactor with no
 * behavior change, verified by code inspection + live CDP instead of a backend test.
 */

import http from "node:http";

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

async function login(email, password) {
  const { status, body } = await request("POST", "/api/auth/login", { email, password });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

const SAMPLE_HTML = `<html><body><h1>Test fixture</h1></body></html>`;

(async () => {
  let adminToken, viewerToken, viewerUserId;
  const cleanupShipments = [];
  const cleanupCustomers = [];
  const cleanupContracts = [];
  const cleanupTickets = [];
  try {
    console.log("Logging in as admin…");
    adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq");
    console.log("  ✓ Logged in");

    console.log("\nScratch viewer user, for the role-gate tests below");
    const viewerEmail = `wf-viewer-${Date.now()}@test.local`;
    const created = await request("POST", "/api/users", {
      email: viewerEmail, name: "Workflow Test Viewer", roles: ["viewer"], password: "Original-Strong-Pw-2026!",
    }, adminToken);
    assert("scratch viewer created", created.status === 200 || created.status === 201);
    const usersList = await request("GET", "/api/users", null, adminToken);
    const viewerUser = (usersList.body.users || usersList.body).find(u => u.email === viewerEmail);
    viewerUserId = viewerUser?.id;
    viewerToken = await login(viewerEmail, "Original-Strong-Pw-2026!");
    assert("viewer logged in", !!viewerToken);

    // ─── Bug 1 — screening override role gate ──────────────────────────────────────────────────
    console.log("\nBug 1 — shipment screening override rejects a viewer");
    {
      const ship = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active",
      }, adminToken);
      const shipmentId = ship.body.id;
      cleanupShipments.push(shipmentId);
      const r = await request("POST", `/api/shipments/${shipmentId}/screening/override`, { reason: "test" }, viewerToken);
      assert("viewer gets 403 on shipment screening override", r.status === 403, `got ${r.status}`);
      const rAdmin = await request("POST", `/api/shipments/${shipmentId}/screening/override`, { reason: "test override" }, adminToken);
      // Admin clears the role gate regardless of whether a screening row happens to exist yet
      // (that's a separate 404-vs-200 concern, not what this fix changed) — just must not be 403.
      assert("admin is not blocked by the role gate", rAdmin.status !== 403, `got ${rAdmin.status}`);
    }

    console.log("\nBug 1 — customer screening override rejects a viewer");
    {
      const cust = await request("POST", "/api/customers", { companyName: "WF Bug1 Customer" }, adminToken);
      const customerId = cust.body.id;
      cleanupCustomers.push(customerId);
      const r = await request("POST", `/api/customers/${customerId}/screening/override`, { reason: "test" }, viewerToken);
      assert("viewer gets 403 on customer screening override", r.status === 403, `got ${r.status}`);
    }

    // ─── Bug 2 — customs-filing broker + priced-cargo gate ─────────────────────────────────────
    console.log("\nBug 2 — customs filing creation rejected with no broker and no priced cargo");
    {
      const ship = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active",
        // Shipper/Consignee set from the start (TKT-6A7J45 story 7 added a USPPI/Consignee
        // check too) — this test is specifically about the broker/cargo gate, not this one.
        shipperName: "WF Bug2 Shipper Co", consigneeName: "WF Bug2 Consignee Co",
      }, adminToken);
      const shipmentId = ship.body.id;
      cleanupShipments.push(shipmentId);
      const noBroker = await request("POST", `/api/shipments/${shipmentId}/customs-filings`, { filingType: "AES_EEI" }, adminToken);
      assert("rejected with no broker assigned", noBroker.status === 400, `got ${noBroker.status}: ${JSON.stringify(noBroker.body)}`);

      const cust = await request("POST", "/api/customers", { companyName: "WF Bug2 Broker Co" }, adminToken);
      cleanupCustomers.push(cust.body.id);
      await request("POST", `/api/shipments/${shipmentId}/parties`,
        { role: "Customs Broker (Export)", customerId: cust.body.id, customerName: cust.body.companyName }, adminToken);
      const noCargo = await request("POST", `/api/shipments/${shipmentId}/customs-filings`, { filingType: "AES_EEI" }, adminToken);
      assert("rejected with broker but no priced cargo", noCargo.status === 400, `got ${noCargo.status}: ${JSON.stringify(noCargo.body)}`);

      const ctr = await request("POST", "/api/containers", { shipmentId, size: "40", type: "HC" }, adminToken);
      await request("POST", `/api/containers/${ctr.body.id}/packages`,
        { description: "Test cargo", quantity: 1, unitValue: 500, currency: "USD" }, adminToken);
      const ok1 = await request("POST", `/api/shipments/${shipmentId}/customs-filings`, { filingType: "AES_EEI" }, adminToken);
      assert("succeeds once broker + priced cargo both present", ok1.status === 201, `got ${ok1.status}: ${JSON.stringify(ok1.body)}`);
    }

    // ─── Bug 3 — credit-hold blocks FR01/FR02 generation ───────────────────────────────────────
    console.log("\nBug 3 — credit hold blocks FR01 generation, leaves other doc types unaffected");
    {
      const cust = await request("POST", "/api/customers", { companyName: "WF Bug3 Held Co" }, adminToken);
      const customerId = cust.body.id;
      cleanupCustomers.push(customerId);
      await request("PUT", `/api/customers/${customerId}`, {
        companyName: "WF Bug3 Held Co", creditHold: true, creditHoldReason: "Test hold",
      }, adminToken);

      const ship = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active",
        principalId: customerId, principalName: "WF Bug3 Held Co",
      }, adminToken);
      const shipmentId = ship.body.id;
      cleanupShipments.push(shipmentId);

      const invoiceAttempt = await request("POST", `/api/shipments/${shipmentId}/documents/generate`,
        { html: SAMPLE_HTML, filename: "FR01-test.html", docType: "FR01" }, adminToken);
      assert("FR01 generation blocked (409)", invoiceAttempt.status === 409, `got ${invoiceAttempt.status}`);
      assert("error names the held company", (invoiceAttempt.body.error || "").includes("WF Bug3 Held Co"));

      const otherDocAttempt = await request("POST", `/api/shipments/${shipmentId}/documents/generate`,
        { html: SAMPLE_HTML, filename: "OT-test.html", docType: "OT" }, adminToken);
      assert("non-invoice doc type is not blocked by the hold", otherDocAttempt.status !== 409, `got ${otherDocAttempt.status}`);
    }

    // ─── Consistency 4 — status enum validation ────────────────────────────────────────────────
    console.log("\nConsistency 4 — shipments.status enum validation");
    {
      const bad = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Not A Real Status",
      }, adminToken);
      assert("bogus shipment status rejected", bad.status === 400);
      const good = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active",
      }, adminToken);
      assert("valid shipment status accepted", good.status === 200 || good.status === 201);
      if (good.body.id) cleanupShipments.push(good.body.id);

      const putBad = await request("PUT", `/api/shipments/${good.body.id}`, {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Bogus",
      }, adminToken);
      assert("bogus status rejected on PUT too", putBad.status === 400);
    }

    console.log("\nConsistency 4 — contracts.status enum validation");
    {
      const num = `WFTEST-${Date.now()}`;
      const bad = await request("POST", "/api/contracts", {
        contractNumber: num, carrierCode: "MAEU", status: "Not A Real Status",
        validFrom: "2026-01-01", validTo: "2027-01-01",
      }, adminToken);
      assert("bogus contract status rejected", bad.status === 400);
      const good = await request("POST", "/api/contracts", {
        contractNumber: num, carrierCode: "MAEU", status: "Draft",
        validFrom: "2026-01-01", validTo: "2027-01-01",
      }, adminToken);
      assert("valid contract status accepted", good.status === 200 || good.status === 201);
      if (good.body.id) cleanupContracts.push(good.body.id);
    }

    // ─── Consistency 5 — milestone out-of-order completion is flagged, not blocked ─────────────
    console.log("\nConsistency 5 — completing a milestone out of order is flagged (soft warning)");
    {
      const ship = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active",
      }, adminToken);
      const shipmentId = ship.body.id;
      cleanupShipments.push(shipmentId);
      await request("POST", `/api/shipments/${shipmentId}/milestones/init`, {}, adminToken);
      const list = await request("GET", `/api/shipments/${shipmentId}/milestones`, null, adminToken);
      const steps = list.body;
      assert("milestones initialized", Array.isArray(steps) && steps.length >= 2);
      // Complete the SECOND step first — the first is still incomplete, so this should be flagged.
      const second = steps[1];
      const r = await request("PUT", `/api/milestones/${second.id}`, {
        estimatedDate: second.estimatedDate, completedAt: new Date().toISOString(), completedBy: "Test",
      }, adminToken);
      assert("out-of-order completion still succeeds (not blocked)", r.status === 200, `got ${r.status}`);
      assert("response flags outOfOrder", r.body.outOfOrder === true);
      const events = await request("GET", `/api/entity-events/milestone/${second.id}`, null, adminToken);
      const hasFlagEvent = Array.isArray(events.body) && events.body.some(e => e.eventType === "COMPLETED_OUT_OF_ORDER");
      assert("COMPLETED_OUT_OF_ORDER event logged", hasFlagEvent);
    }

    // ─── Process automation 7 — ops-automation sweep ───────────────────────────────────────────
    console.log("\nProcess automation 7 — sweep creates a ticket for an overdue milestone, dedupes on rerun");
    {
      const ship = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active",
      }, adminToken);
      const shipmentId = ship.body.id;
      cleanupShipments.push(shipmentId);
      await request("POST", `/api/shipments/${shipmentId}/milestones/init`, {}, adminToken);
      const list = await request("GET", `/api/shipments/${shipmentId}/milestones`, null, adminToken);
      const firstStep = list.body[0];
      // Backdate the estimate so the sweep sees it as overdue (no direct "set estimatedDate to the
      // past" route restriction — PUT accepts any date the same way the real UI's date field does).
      await request("PUT", `/api/milestones/${firstStep.id}`, { estimatedDate: "2020-01-01" }, adminToken);

      const sweep1 = await request("POST", "/api/test/run-ops-automation-sweep", {}, adminToken);
      assert("sweep runs", sweep1.status === 200, `got ${sweep1.status}: ${JSON.stringify(sweep1.body)}`);
      assert("sweep created at least one ticket", sweep1.body.ticketsCreated >= 1, `created ${sweep1.body.ticketsCreated}`);

      const tickets = await request("GET", `/api/tickets?shipmentId=${shipmentId}`, null, adminToken);
      const opsTicket = (tickets.body || []).find(t => t.title && t.title.includes(firstStep.label));
      assert("an overdue-milestone ticket exists for this shipment", !!opsTicket);
      // tickets.shipment_id has no DB-level cascade (unlike most other shipment-child tables),
      // so it must be deleted explicitly here — otherwise it survives as an orphan pointing at
      // a shipment id that's about to be deleted below.
      if (opsTicket) cleanupTickets.push(opsTicket.id);

      const sweep2 = await request("POST", "/api/test/run-ops-automation-sweep", {}, adminToken);
      assert("sweep is idempotent — no new ticket for the same still-overdue milestone", sweep2.body.ticketsCreated === 0, `created ${sweep2.body.ticketsCreated}`);
    }

    // ─── Process automation 8 — durable ATTEMPTED event before the real call ──────────────────
    console.log("\nProcess automation 8 — document generation writes an ATTEMPTED event before the pdf-render call");
    {
      const ship = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active",
      }, adminToken);
      const shipmentId = ship.body.id;
      cleanupShipments.push(shipmentId);
      await request("POST", `/api/shipments/${shipmentId}/documents/generate`,
        { html: SAMPLE_HTML, filename: "OT-attempt-test.html", docType: "OT" }, adminToken);
      const events = await request("GET", `/api/shipments/${shipmentId}/events`, null, adminToken);
      const rows = events.body.results || events.body;
      assert("DOCUMENT_GENERATION_ATTEMPTED event present", Array.isArray(rows) && rows.some(e => e.eventType === "DOCUMENT_GENERATION_ATTEMPTED"));
    }

    console.log("\nProcess automation 8 — EDI send writes EDI_SEND_ATTEMPTED before the distribution-service call");
    {
      const ship = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT", status: "Active",
      }, adminToken);
      const shipmentId = ship.body.id;
      cleanupShipments.push(shipmentId);
      const gen = await request("POST", `/api/shipments/${shipmentId}/documents/generate`,
        { html: SAMPLE_HTML, filename: "OT-edi-test.html", docType: "OT" }, adminToken);
      if (gen.status === 201) {
        const docId = gen.body.id;
        await request("POST", `/api/shipments/${shipmentId}/documents/${docId}/send-edi`,
          { recipientCode: "TESTCODE" }, adminToken);
        const events = await request("GET", `/api/entity-events/document/${docId}`, null, adminToken);
        const hasAttempted = Array.isArray(events.body) && events.body.some(e => e.eventType === "EDI_SEND_ATTEMPTED");
        assert("EDI_SEND_ATTEMPTED event present regardless of outcome", hasAttempted);
      } else {
        console.log("  (skipped — pdf-render service not running, document could not be generated)");
      }
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    for (const id of cleanupTickets) { try { await request("DELETE", `/api/tickets/${id}`, null, adminToken); } catch {} }
    for (const id of cleanupShipments) { try { await request("DELETE", `/api/shipments/${id}`, null, adminToken); } catch {} }
    for (const id of cleanupContracts) { try { await request("DELETE", `/api/contracts/${id}`, null, adminToken); } catch {} }
    for (const id of cleanupCustomers) { try { await request("DELETE", `/api/customers/${id}`, null, adminToken); } catch {} }
    if (viewerUserId) { try { await request("DELETE", `/api/users/${viewerUserId}`, null, adminToken); } catch {} }
  }
})();
