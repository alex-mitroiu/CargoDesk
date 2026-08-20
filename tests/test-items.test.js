/**
 * Test Case repository (routes/testcases.js) — smoke tests
 *
 * Covers Test Items CRUD (Folder/Plan/Run/Case hierarchy, cascade delete of descendants +
 * their story-links), Test Case <-> Ticket story links (both directions: story-links on the
 * test case, tested-by on the ticket), and validation. Previously zero dedicated coverage —
 * test_items lives in its own repository, separate from tickets/testcases.test elsewhere.
 *
 * Usage:
 *   node tests/test-items.test.js
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

(async () => {
  try {
    console.log("Logging in…");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nTest Items — create a Folder -> Case hierarchy, invalid type rejected, missing title rejected");
    const folder = await request("POST", "/api/test-items", { title: "Test Fixture Folder", type: "Test Folder" }, token);
    assert("folder created", folder.status === 201, JSON.stringify(folder.body));
    const folderId = folder.body.id;

    const badType = await request("POST", "/api/test-items", { title: "X", type: "Nonsense" }, token);
    assert("invalid type rejected", badType.status >= 400 && /type must be one of/i.test(badType.body.error || ""));
    const noTitle = await request("POST", "/api/test-items", { type: "Test Case" }, token);
    assert("missing title rejected", noTitle.status >= 400);

    const testCase = await request("POST", "/api/test-items", {
      title: "Test Fixture Case", type: "Test Case", parentId: folderId, priority: "High", testNotes: "Verify X does Y",
    }, token);
    assert("test case created under the folder", testCase.status === 201);
    assert("parentId round-trips", testCase.body.parentId === folderId);
    assert("testNotes round-trips", testCase.body.testNotes === "Verify X does Y");
    const caseId = testCase.body.id;

    console.log("\nList — plain, and filtered by shipmentId/projectId");
    const list = await request("GET", "/api/test-items", null, token);
    assert("list returns 200", list.status === 200);
    assert("both items present", list.body.some(t => t.id === folderId) && list.body.some(t => t.id === caseId));
    assert("assignee_name join present in mapped shape (null when unassigned)", "assigneeName" in testCase.body);

    const shp = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, token);
    const shipmentId = shp.body.id;
    const linkedCase = await request("POST", "/api/test-items", { title: "Shipment-linked Case", type: "Test Case", shipmentId }, token);
    const byShipment = await request("GET", `/api/test-items?shipmentId=${shipmentId}`, null, token);
    assert("shipmentId filter returns only the linked item", byShipment.body.length === 1 && byShipment.body[0].id === linkedCase.body.id);

    console.log("\nUpdate — full field patch, invalid type rejected, 404 for unknown id");
    const update = await request("PUT", `/api/test-items/${caseId}`, {
      title: "Renamed Fixture Case", type: "Test Case", status: "In Progress", priority: "Critical",
    }, token);
    assert("update returns 200", update.status === 200);
    assert("title updated", update.body.title === "Renamed Fixture Case");
    assert("status updated", update.body.status === "In Progress");
    const updateBadType = await request("PUT", `/api/test-items/${caseId}`, { type: "Nonsense" }, token);
    assert("update with invalid type rejected", updateBadType.status >= 400);
    const update404 = await request("PUT", "/api/test-items/TST-NOPE", { title: "X" }, token);
    assert("update 404 for unknown id", update404.status === 404);

    console.log("\nStory Links — create (both validation branches), list, reverse tested-by, delete");
    const ticket = await request("POST", "/api/tickets", { title: "Fixture Story", type: "Story", section: "backlog", status: "Backlog", priority: "Medium" }, token);
    assert("fixture ticket created", ticket.status === 201, JSON.stringify(ticket.body));
    const ticketId = ticket.body.id;

    const linkNoTicketId = await request("POST", `/api/test-items/${caseId}/story-links`, {}, token);
    assert("story-link missing ticketId rejected", linkNoTicketId.status >= 400);
    const linkOnFolder = await request("POST", `/api/test-items/${folderId}/story-links`, { ticketId }, token);
    assert("story-link on a non-Test-Case item rejected (404)", linkOnFolder.status === 404);
    const linkBadTicket = await request("POST", `/api/test-items/${caseId}/story-links`, { ticketId: "TKT-NOPE" }, token);
    assert("story-link to an unknown ticket rejected (404)", linkBadTicket.status === 404);

    const link = await request("POST", `/api/test-items/${caseId}/story-links`, { ticketId }, token);
    assert("story-link created", link.status === 201, JSON.stringify(link.body));
    const linkDup = await request("POST", `/api/test-items/${caseId}/story-links`, { ticketId }, token);
    assert("duplicate story-link rejected", linkDup.status >= 400 && /already exists/i.test(linkDup.body.error || ""));

    const storyLinks = await request("GET", `/api/test-items/${caseId}/story-links`, null, token);
    assert("story-links list returns 200", storyLinks.status === 200);
    assert("displayType is 'Tests'", storyLinks.body[0]?.displayType === "Tests");
    assert("linked ticket resolved with title/status", storyLinks.body[0]?.ticket?.id === ticketId);

    const testedBy = await request("GET", `/api/tickets/${ticketId}/tested-by`, null, token);
    assert("tested-by (reverse direction) returns 200", testedBy.status === 200);
    assert("displayType is 'Is tested by'", testedBy.body[0]?.displayType === "Is tested by");
    assert("linked case resolved with title", testedBy.body[0]?.case?.id === caseId);

    const linkDelete = await request("DELETE", `/api/test-case-links/${link.body.id}`, null, token);
    assert("story-link delete returns 200", linkDelete.status === 200);
    const linkDelete404 = await request("DELETE", `/api/test-case-links/${link.body.id}`, null, token);
    assert("story-link delete 404 on second attempt", linkDelete404.status === 404);

    console.log("\nA ticket resolved as a placeholder when the underlying ticket doesn't exist (defensive branch)");
    const link2 = await request("POST", `/api/test-items/${caseId}/story-links`, { ticketId }, token);
    await request("DELETE", `/api/tickets/${ticketId}`, null, token); // remove the ticket, leave the link dangling
    const danglingLinks = await request("GET", `/api/test-items/${caseId}/story-links`, null, token);
    assert("dangling link still returns 200 with a placeholder ticket object", danglingLinks.status === 200 && danglingLinks.body[0]?.ticket?.id === ticketId && danglingLinks.body[0]?.ticket?.title === ticketId);
    await request("DELETE", `/api/test-case-links/${link2.body.id}`, null, token);

    console.log("\nDelete — cascades to descendants and their story-links");
    const ticket2 = await request("POST", "/api/tickets", { title: "Cascade Fixture Story", type: "Story", section: "backlog", status: "Backlog", priority: "Medium" }, token);
    const linkForCascade = await request("POST", `/api/test-items/${caseId}/story-links`, { ticketId: ticket2.body.id }, token);
    const del = await request("DELETE", `/api/test-items/${folderId}`, null, token);
    assert("folder delete returns 200", del.status === 200);
    assert("cascaded count includes the child case", del.body.cascaded === 1);
    const listAfter = await request("GET", "/api/test-items", null, token);
    assert("both folder and case are gone", !listAfter.body.some(t => t.id === folderId || t.id === caseId));
    const linksAfterCascade = await request("GET", `/api/tickets/${ticket2.body.id}/tested-by`, null, token);
    assert("cascade also removed the case's story-link", linksAfterCascade.body.length === 0);
    const del404 = await request("DELETE", `/api/test-items/${folderId}`, null, token);
    assert("delete 404 on second attempt", del404.status === 404);

    console.log("\nCleanup");
    await request("DELETE", `/api/test-items/${linkedCase.body.id}`, null, token);
    await request("DELETE", `/api/tickets/${ticket2.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
