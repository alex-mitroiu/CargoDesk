/**
 * Kanban Service — test_items CRUD, nested-delete cascade, and the Test Case <-> Ticket
 * story-link JOIN (both tables co-located in this service — the live JOIN stays fully
 * server-side, same as the monolith today).
 *
 * Hits the service directly on its own port, no monolith involved.
 *
 * Usage:
 *   node services/kanban/tests/testcases-crud.test.js
 *
 * Prerequisites:
 *   - Kanban Service running on :3007 (npm run kanban-service)
 */

import http from "node:http";

const PORT = 3007;
const SECRET = process.env.KANBAN_SERVICE_SECRET || "cargoDesk-dev-kanban-service-secret-do-not-use-in-prod";
let passed = 0;
let failed = 0;

function request(method, path, body, auth = true) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method, hostname: "localhost", port: PORT, path,
      headers: {
        "Content-Type": "application/json",
        ...(auth && { Authorization: `Bearer ${SECRET}` }),
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

(async () => {
  const stamp = Date.now();
  let folderId = null, caseId = null, ticketId = null, linkId = null;
  try {
    console.log("Test Items CRUD");
    const badType = await request("POST", "/internal/test-items", { title: "Bad", type: "Nonsense" });
    assert("invalid type rejected", badType.status === 400);

    const fCreate = await request("POST", "/internal/test-items", { title: `Test Folder ${stamp}`, type: "Test Folder" });
    assert("folder create returns 201", fCreate.status === 201, JSON.stringify(fCreate.body));
    folderId = fCreate.body.id;

    const cCreate = await request("POST", "/internal/test-items", { title: `Test Case ${stamp}`, type: "Test Case", parentId: folderId });
    assert("case create returns 201", cCreate.status === 201, JSON.stringify(cCreate.body));
    caseId = cCreate.body.id;
    assert("no assigneeName field — service owns no users table", !("assigneeName" in cCreate.body));

    const listAll = await request("GET", "/internal/test-items");
    assert("bare list includes both new items", listAll.body.some(i => i.id === folderId) && listAll.body.some(i => i.id === caseId));

    const update = await request("PUT", `/internal/test-items/${caseId}`, { title: "Renamed Case", type: "Test Case", status: "In Progress" });
    assert("update applies", update.body.title === "Renamed Case" && update.body.status === "In Progress");

    console.log("\nStory Links (Test Case <-> Ticket, cross-table JOIN)");
    const tCreate = await request("POST", "/internal/tickets", { title: `Story for ${stamp}` });
    ticketId = tCreate.body.id;
    const linkBadCase = await request("POST", `/internal/test-items/${folderId}/story-links`, { ticketId });
    assert("linking a non-Test-Case item is rejected", linkBadCase.status === 404, JSON.stringify(linkBadCase.body));
    const link = await request("POST", `/internal/test-items/${caseId}/story-links`, { ticketId });
    assert("story link create returns 201", link.status === 201, JSON.stringify(link.body));
    linkId = link.body.id;
    const dupLink = await request("POST", `/internal/test-items/${caseId}/story-links`, { ticketId });
    assert("duplicate story link rejected", dupLink.status === 400);

    const storyLinks = await request("GET", `/internal/test-items/${caseId}/story-links`);
    assert("story-links JOIN resolves the real ticket title", storyLinks.body[0]?.ticket?.title === `Story for ${stamp}`, JSON.stringify(storyLinks.body));

    const testedBy = await request("GET", `/internal/tickets/${ticketId}/tested-by`);
    assert("reverse tested-by JOIN resolves the real test case title", testedBy.body[0]?.case?.title === "Renamed Case", JSON.stringify(testedBy.body));

    console.log("\nCascading delete (folder -> case -> its story links)");
    const del = await request("DELETE", `/internal/test-items/${folderId}`);
    assert("folder delete returns cascaded count 1", del.status === 200 && del.body.cascaded === 1, JSON.stringify(del.body));
    const gone = await request("GET", "/internal/test-items");
    assert("cascaded case is actually gone", !gone.body.some(i => i.id === caseId));
    const linksGone = await request("GET", `/internal/tickets/${ticketId}/tested-by`);
    assert("cascade also removed the story link (no orphan)", linksGone.body.length === 0, JSON.stringify(linksGone.body));
    folderId = null; caseId = null; linkId = null; // already gone, skip in finally

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    if (linkId) await request("DELETE", `/internal/test-case-links/${linkId}`).catch(() => {});
    if (caseId) await request("DELETE", `/internal/test-items/${caseId}`).catch(() => {});
    if (folderId) await request("DELETE", `/internal/test-items/${folderId}`).catch(() => {});
    if (ticketId) await request("DELETE", `/internal/tickets/${ticketId}`).catch(() => {});
  }
})();
