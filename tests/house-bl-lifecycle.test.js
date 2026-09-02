/**
 * House B/L Lifecycle — status tracking (Surrendered / Released) on a confirmed BL01 — smoke tests
 *
 * Usage:
 *   node tests/house-bl-lifecycle.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
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

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost", password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

async function scratchShipment(token, blReleaseType = "Original") {
  const res = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU",
    status: "Active", contractType: "SPOT", etd: "2026-09-01", blReleaseType,
  }, token);
  const id = res.body.id;
  // Milestones aren't auto-seeded at shipment creation — a shipment needs an explicit init call
  // before shipment_milestones has any rows for it (routes/shipment-ops.js:834).
  await request("POST", `/api/shipments/${id}/milestones/init`, {}, token);
  return id;
}

const SAMPLE_HTML = `<html><body><h1>House Bill of Lading (test fixture)</h1></body></html>`;

async function generateBl(shipmentId, token) {
  const res = await request("POST", `/api/shipments/${shipmentId}/documents/generate`, {
    html: SAMPLE_HTML, filename: `BL01-${shipmentId}.html`, docType: "BL01",
  }, token);
  return res.body;
}

async function confirmDoc(docId, token) {
  return request("PATCH", `/api/documents/${docId}`, { status: "confirmed" }, token);
}

async function getMilestone(shipmentId, key, token) {
  const res = await request("GET", `/api/shipments/${shipmentId}/milestones`, null, token);
  return res.body.find(m => m.milestoneKey === key);
}

async function getDocumentEvents(docId, token) {
  const res = await request("GET", `/api/entity-events/document/${docId}`, null, token);
  return res.body;
}

(async () => {
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch shipment (Telex Release, so Surrender is meaningful) + draft BL01");
    const shipmentId = await scratchShipment(token, "Telex Release");
    assert("scratch shipment created", !!shipmentId);
    const doc = await generateBl(shipmentId, token);
    assert("BL01 generated as draft", !!doc.id && doc.status === "draft");

    const surrenderWhileDraft = await request("PATCH", `/api/shipments/${shipmentId}/documents/${doc.id}/bl-surrender`, null, token);
    assert("surrender on a draft doc 409s", surrenderWhileDraft.status === 409, JSON.stringify(surrenderWhileDraft.body));
    const releaseWhileDraft = await request("PATCH", `/api/shipments/${shipmentId}/documents/${doc.id}/bl-release`, null, token);
    assert("release on a draft doc 409s", releaseWhileDraft.status === 409, JSON.stringify(releaseWhileDraft.body));

    console.log("\nbl_issued milestone is uncompleted before the House B/L is confirmed");
    const beforeMilestone = await getMilestone(shipmentId, "bl_issued", token);
    assert("bl_issued milestone row exists", !!beforeMilestone);
    assert("bl_issued not yet completed", !beforeMilestone.completedAt);

    console.log("\nConfirming the BL01 auto-completes bl_issued");
    const confirmed = await confirmDoc(doc.id, token);
    assert("confirm returns 200", confirmed.status === 200, JSON.stringify(confirmed.body));
    const afterMilestone = await getMilestone(shipmentId, "bl_issued", token);
    assert("bl_issued auto-completed on BL01 confirm", !!afterMilestone.completedAt, JSON.stringify(afterMilestone));
    assert("bl_issued completedBy is System (Auto)", afterMilestone.completedBy === "System (Auto)");

    console.log("\nA manually-completed bl_issued is never overwritten by a later confirm");
    const shipment2Id = await scratchShipment(token, "Original");
    const doc2 = await generateBl(shipment2Id, token);
    const blIssuedRow = await getMilestone(shipment2Id, "bl_issued", token);
    assert("bl_issued milestone row exists on shipment 2", !!blIssuedRow?.id);
    const manualComplete = await request("PUT", `/api/milestones/${blIssuedRow.id}`,
      { completedAt: "2026-08-01T00:00:00.000Z", completedBy: "Test Operator", note: "Completed by hand ahead of the system" }, token);
    assert("manual milestone completion succeeds", manualComplete.status === 200, JSON.stringify(manualComplete.body));
    await confirmDoc(doc2.id, token);
    const stillManual = await getMilestone(shipment2Id, "bl_issued", token);
    assert("manual completion survives the auto-complete guard", stillManual.completedBy === "Test Operator", JSON.stringify(stillManual));

    console.log("\nMark Surrendered then Released on the confirmed doc from shipment 1");
    const surrender = await request("PATCH", `/api/shipments/${shipmentId}/documents/${doc.id}/bl-surrender`, null, token);
    assert("surrender returns 200", surrender.status === 200, JSON.stringify(surrender.body));
    assert("blSurrenderedAt set", !!surrender.body.blSurrenderedAt);
    assert("blSurrenderedBy set", !!surrender.body.blSurrenderedBy);

    const release = await request("PATCH", `/api/shipments/${shipmentId}/documents/${doc.id}/bl-release`, null, token);
    assert("release returns 200", release.status === 200, JSON.stringify(release.body));
    assert("blReleasedAt set", !!release.body.blReleasedAt);

    console.log("\nBoth actions are idempotent — a repeat call is a no-op, not an error, timestamp unchanged");
    const firstSurrenderedAt = surrender.body.blSurrenderedAt;
    const surrenderAgain = await request("PATCH", `/api/shipments/${shipmentId}/documents/${doc.id}/bl-surrender`, null, token);
    assert("repeat surrender returns 200", surrenderAgain.status === 200);
    assert("repeat surrender does not change the timestamp", surrenderAgain.body.blSurrenderedAt === firstSurrenderedAt);

    console.log("\nBoth actions are logged as entity_events, visible via the existing document history endpoint");
    const events = await getDocumentEvents(doc.id, token);
    assert("BL_SURRENDERED event logged", events.some(e => e.eventType === "BL_SURRENDERED"), JSON.stringify(events.map(e => e.eventType)));
    assert("BL_RELEASED event logged", events.some(e => e.eventType === "BL_RELEASED"), JSON.stringify(events.map(e => e.eventType)));
    assert("BL_SURRENDERED logged only once despite the repeat call", events.filter(e => e.eventType === "BL_SURRENDERED").length === 1);

    console.log("\nA non-BL01 document rejects both actions");
    const otherDoc = await request("POST", `/api/shipments/${shipmentId}/documents/generate`, {
      html: SAMPLE_HTML, filename: `PL01-${shipmentId}.html`, docType: "PL01",
    }, token);
    await confirmDoc(otherDoc.body.id, token);
    const otherSurrender = await request("PATCH", `/api/shipments/${shipmentId}/documents/${otherDoc.body.id}/bl-surrender`, null, token);
    assert("surrender on a non-BL01 doc 400s", otherSurrender.status === 400, JSON.stringify(otherSurrender.body));

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
    await request("DELETE", `/api/shipments/${shipment2Id}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
