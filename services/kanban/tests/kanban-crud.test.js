/**
 * Kanban Service — CRUD across tickets, ticket_links, kb_projects, kb_versions, kb_columns
 *
 * Hits the service directly on its own port, no monolith involved.
 *
 * Usage:
 *   node services/kanban/tests/kanban-crud.test.js
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
  let ticketId = null, ticket2Id = null, linkId = null, projectId = null, versionId = null, columnId = null;
  try {
    console.log("Health check");
    const health = await request("GET", "/health", null, false);
    assert("health returns 200", health.status === 200);
    assert("service name is kanban", health.body.service === "kanban");

    console.log("\nNo secret / wrong secret rejected on /internal/*");
    const noAuth = await request("GET", "/internal/tickets", null, false);
    assert("no auth returns 401", noAuth.status === 401);

    console.log("\nTickets CRUD");
    const tCreate = await request("POST", "/internal/tickets", { title: `Kanban Test Ticket ${stamp}`, priority: "High" });
    assert("ticket create returns 201", tCreate.status === 201, JSON.stringify(tCreate.body));
    ticketId = tCreate.body.id;
    assert("created ticket has default status Ready", tCreate.body.status === "Ready");
    assert("no assigneeName field — service owns no users table", !("assigneeName" in tCreate.body));

    const tGetAll = await request("GET", "/internal/tickets");
    assert("bare-array GET returns an array", Array.isArray(tGetAll.body));
    assert("created ticket present in bare array", tGetAll.body.some(t => t.id === ticketId));

    const tUpdate = await request("PUT", `/internal/tickets/${ticketId}`, { title: "Renamed Ticket", status: "In Progress" });
    assert("ticket update applies", tUpdate.body.title === "Renamed Ticket" && tUpdate.body.status === "In Progress");

    const t2Create = await request("POST", "/internal/tickets", { title: `Kanban Test Ticket 2 ${stamp}` });
    ticket2Id = t2Create.body.id;

    console.log("\nPaginated tickets");
    const tPage = await request("GET", "/internal/tickets?limit=1&offset=0");
    assert("paginated response has results/total/limit/offset shape", Array.isArray(tPage.body.results) && typeof tPage.body.total === "number");

    console.log("\nAtomic ensure (backs ensureOpsTicket's remote branch)");
    const sourceType = "kanban_crud_test", sourceId = `SRC-${stamp}`;
    const ensure1 = await request("POST", "/internal/tickets/ensure", { sourceType, sourceId, title: "Auto-created" });
    assert("first ensure call creates a ticket", ensure1.status === 200 && ensure1.body.created === true, JSON.stringify(ensure1.body));
    const ensure2 = await request("POST", "/internal/tickets/ensure", { sourceType, sourceId, title: "Auto-created again" });
    assert("second ensure call for the same source is a no-op (UNIQUE constraint)", ensure2.body.created === false, JSON.stringify(ensure2.body));
    if (ensure1.body.id) await request("DELETE", `/internal/tickets/${ensure1.body.id}`);

    console.log("\nTicket Links");
    const linkCreate = await request("POST", `/internal/tickets/${ticketId}/links`, { toId: ticket2Id, linkType: "Blocks" });
    assert("link create returns 201", linkCreate.status === 201, JSON.stringify(linkCreate.body));
    linkId = linkCreate.body.id;
    const dupLink = await request("POST", `/internal/tickets/${ticketId}/links`, { toId: ticket2Id, linkType: "Blocks" });
    assert("duplicate link rejected", dupLink.status === 400);
    const linksOut = await request("GET", `/internal/tickets/${ticketId}/links`);
    assert("outbound link shows displayType='Blocks'", linksOut.body[0].displayType === "Blocks");
    const linksIn = await request("GET", `/internal/tickets/${ticket2Id}/links`);
    assert("inbound link shows inverse displayType='Is blocked by'", linksIn.body[0].displayType === "Is blocked by");

    console.log("\nProjects + default columns");
    const pCreate = await request("POST", "/internal/kb/projects", { name: `Test Project ${stamp}` });
    assert("project create returns 201", pCreate.status === 201, JSON.stringify(pCreate.body));
    projectId = pCreate.body.id;
    const cols = await request("GET", `/internal/kb/projects/${projectId}/columns`);
    assert("new project seeded with 7 default columns", cols.body.length === 7, JSON.stringify(cols.body));
    columnId = cols.body[0].id;

    const pUpdate = await request("PUT", `/internal/kb/projects/${projectId}`, { name: "Renamed Project" });
    assert("project update applies", pUpdate.body.name === "Renamed Project");

    console.log("\nVersions");
    const vCreate = await request("POST", `/internal/kb/projects/${projectId}/versions`, { name: "v1.0" });
    assert("version create returns 201", vCreate.status === 201, JSON.stringify(vCreate.body));
    versionId = vCreate.body.id;
    const vList = await request("GET", `/internal/kb/projects/${projectId}/versions`);
    assert("version list includes the new version", vList.body.some(v => v.id === versionId));

    console.log("\nColumns — add, reorder, delete-guard");
    const newCol = await request("POST", `/internal/kb/projects/${projectId}/columns`, { name: "Extra Column" });
    assert("new column create returns 201", newCol.status === 201, JSON.stringify(newCol.body));
    const reorder = await request("PATCH", `/internal/kb/projects/${projectId}/columns`, { order: [newCol.body.id, ...cols.body.map(c => c.id)] });
    assert("reorder puts new column first", reorder.body[0].id === newCol.body.id, JSON.stringify(reorder.body));
    const delNewCol = await request("DELETE", `/internal/kb/columns/${newCol.body.id}`);
    assert("empty column deletes cleanly", delNewCol.status === 200, JSON.stringify(delNewCol.body));
    const delLastGuard = await request("DELETE", `/internal/kb/columns/${columnId}`);
    // columnId is the 'Ready' column; ticket2Id was created with no status override, so it still
    // sits in 'Ready' — the delete-guard (ticketCount>0) should reject this one.
    assert("column with a ticket in it refuses to delete", delLastGuard.status === 400, JSON.stringify(delLastGuard.body));

    console.log("\nBulk import (migration script) is idempotent");
    const bulkTicket = { id: `TKT-BULK${stamp % 100000}`, title: "Bulk Import Ticket", section: "", description: "",
      priority: "Medium", status: "Ready", position: 0, created_at: new Date().toISOString(),
      shipment_id: null, type: "Task", version: "", parent_id: null, assignee_id: null,
      due_date: null, test_notes: null, project_id: null, version_id: null, source_type: null, source_id: null };
    const bulk1 = await request("POST", "/internal/kanban/bulk-import", { tickets: [bulkTicket] });
    assert("first bulk-import inserts the row", bulk1.status === 201 && bulk1.body.inserted.tickets === 1, JSON.stringify(bulk1.body));
    const bulk2 = await request("POST", "/internal/kanban/bulk-import", { tickets: [bulkTicket] });
    assert("re-running bulk-import is idempotent (0 new inserts)", bulk2.body.inserted.tickets === 0, JSON.stringify(bulk2.body));
    await request("DELETE", `/internal/tickets/${bulkTicket.id}`).catch(() => {});

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    if (linkId) await request("DELETE", `/internal/ticket-links/${linkId}`).catch(() => {});
    if (ticketId) await request("DELETE", `/internal/tickets/${ticketId}`).catch(() => {});
    if (ticket2Id) await request("DELETE", `/internal/tickets/${ticket2Id}`).catch(() => {});
    if (versionId) await request("DELETE", `/internal/kb/versions/${versionId}`).catch(() => {});
    if (projectId) await request("DELETE", `/internal/kb/projects/${projectId}`).catch(() => {});
  }
})();
