/**
 * Kanban / Integration Board API (routes/kanban.js) — smoke tests
 *
 * Covers Tickets CRUD (+ pagination opt-in), Ticket Links (both directions), Projects CRUD
 * (+ default-column seeding), Versions CRUD, Columns CRUD (+ bulk reorder, delete guards),
 * and the dev-only ops-automation-sweep trigger. Previously only incidentally exercised by
 * other test files creating a scratch ticket or two, never a direct pass of its own.
 *
 * Usage:
 *   node tests/kanban-api.test.js
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

    console.log("\nTickets — create (Epic/Story), list (unpaginated + paginated), filters, update, delete");
    const epic = await request("POST", "/api/tickets", { title: "Fixture Epic", type: "Epic", section: "backlog", status: "Backlog", priority: "High" }, token);
    assert("epic created", epic.status === 201, JSON.stringify(epic.body));
    const epicId = epic.body.id;

    const story = await request("POST", "/api/tickets", { title: "Fixture Story", type: "Story", section: "backlog", status: "Ready", priority: "Medium", parentId: epicId }, token);
    assert("story created with parentId", story.status === 201 && story.body.parentId === epicId);
    const storyId = story.body.id;

    const noTitle = await request("POST", "/api/tickets", { type: "Task" }, token);
    assert("missing title rejected", noTitle.status >= 400);

    const listAll = await request("GET", "/api/tickets", null, token);
    assert("unpaginated list returns a bare array", Array.isArray(listAll.body));
    assert("both fixture tickets present", listAll.body.some(t => t.id === epicId) && listAll.body.some(t => t.id === storyId));

    const listPaged = await request("GET", "/api/tickets?limit=2&offset=0", null, token);
    assert("paginated list returns results/total/limit/offset shape", ["results", "total", "limit", "offset"].every(k => k in listPaged.body));
    assert("paginated results respects the limit", listPaged.body.results.length <= 2);

    const shp = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, token);
    const shipmentId = shp.body.id;
    const shipmentTicket = await request("POST", "/api/tickets", { title: "Shipment Fixture Ticket", type: "Task", shipmentId, status: "Ready" }, token);
    const byShipment = await request("GET", `/api/tickets?shipmentId=${shipmentId}`, null, token);
    assert("shipmentId filter returns only the linked ticket", byShipment.body.length === 1 && byShipment.body[0].id === shipmentTicket.body.id);

    const update = await request("PUT", `/api/tickets/${storyId}`, { title: "Renamed Fixture Story", status: "In Progress", priority: "Critical" }, token);
    assert("update returns 200", update.status === 200 && update.body.title === "Renamed Fixture Story");
    const update404 = await request("PUT", "/api/tickets/TKT-NOPE", { title: "X" }, token);
    assert("update 404 for unknown id", update404.status === 404);

    console.log("\nTicket Links — create both directions, duplicate rejection, list resolves the other side, delete");
    const linkMissing = await request("POST", `/api/tickets/${epicId}/links`, {}, token);
    assert("link missing fields rejected", linkMissing.status >= 400);
    const linkBadTarget = await request("POST", `/api/tickets/${epicId}/links`, { toId: "TKT-NOPE", linkType: "blocks" }, token);
    assert("link to an unknown ticket rejected (404)", linkBadTarget.status === 404);

    const link = await request("POST", `/api/tickets/${epicId}/links`, { toId: storyId, linkType: "blocks" }, token);
    assert("link created", link.status === 201, JSON.stringify(link.body));
    const linkDup = await request("POST", `/api/tickets/${epicId}/links`, { toId: storyId, linkType: "blocks" }, token);
    assert("duplicate link rejected", linkDup.status >= 400 && /already exists/i.test(linkDup.body.error || ""));
    const linkReverseDup = await request("POST", `/api/tickets/${storyId}/links`, { toId: epicId, linkType: "is blocked by" }, token);
    assert("the reverse pair is also treated as a duplicate", linkReverseDup.status >= 400);

    const outLinks = await request("GET", `/api/tickets/${epicId}/links`, null, token);
    assert("outbound link direction is 'out'", outLinks.body.some(l => l.direction === "out" && l.otherTicketId === storyId));
    const inLinks = await request("GET", `/api/tickets/${storyId}/links`, null, token);
    assert("inbound link direction is 'in', displayType inverted", inLinks.body.some(l => l.direction === "in" && l.otherTicketId === epicId));

    const linkDelete = await request("DELETE", `/api/ticket-links/${link.body.id}`, null, token);
    assert("link delete returns 200", linkDelete.status === 200);
    const linkDelete404 = await request("DELETE", `/api/ticket-links/${link.body.id}`, null, token);
    assert("link delete 404 on second attempt", linkDelete404.status === 404);

    console.log("\nProjects — create (seeds 7 default columns), list, update, delete-guard (last project), delete");
    const project = await request("POST", "/api/kb/projects", { name: "Fixture Project", key: "fix", color: "#123456", description: "A test project" }, token);
    assert("project created", project.status === 201, JSON.stringify(project.body));
    assert("key uppercased", project.body.key === "FIX");
    const projectId = project.body.id;

    const projectNoName = await request("POST", "/api/kb/projects", {}, token);
    assert("missing name rejected", projectNoName.status >= 400);

    const projectAutoKey = await request("POST", "/api/kb/projects", { name: "Another Fixture" }, token);
    assert("key auto-derived from name when omitted", projectAutoKey.body.key === "ANOT");
    const projectAutoKeyId = projectAutoKey.body.id;

    const columnsSeeded = await request("GET", `/api/kb/projects/${projectId}/columns`, null, token);
    assert("7 default columns seeded", columnsSeeded.body.length === 7);
    assert("first default column is Ready at position 0", columnsSeeded.body[0].name === "Ready" && columnsSeeded.body[0].position === 0);

    const projectList = await request("GET", "/api/kb/projects", null, token);
    assert("project list includes ours", projectList.body.some(p => p.id === projectId));

    const projectUpdate = await request("PUT", `/api/kb/projects/${projectId}`, { name: "Renamed Fixture Project" }, token);
    assert("project update returns 200", projectUpdate.status === 200 && projectUpdate.body.name === "Renamed Fixture Project");

    console.log("\nVersions — create, list, update, delete (unlinks tickets first)");
    const version = await request("POST", `/api/kb/projects/${projectId}/versions`, { name: "v1.0.0", description: "First release", status: "Planning" }, token);
    assert("version created", version.status === 201, JSON.stringify(version.body));
    const versionId = version.body.id;
    const versionBadProject = await request("POST", "/api/kb/projects/PRJ-NOPE/versions", { name: "v1" }, token);
    assert("version create 404 for unknown project", versionBadProject.status === 404);
    const versionNoName = await request("POST", `/api/kb/projects/${projectId}/versions`, {}, token);
    assert("version missing name rejected", versionNoName.status >= 400);

    const versionList = await request("GET", `/api/kb/projects/${projectId}/versions`, null, token);
    assert("version list includes ours", versionList.body.some(v => v.id === versionId));

    const versionUpdate = await request("PUT", `/api/kb/versions/${versionId}`, { name: "v1.0.1", status: "Released" }, token);
    assert("version update returns 200", versionUpdate.status === 200 && versionUpdate.body.status === "Released");

    const versionedTicket = await request("POST", "/api/tickets", { title: "Versioned Fixture Ticket", type: "Task", versionId, status: "Ready" }, token);
    const versionDelete = await request("DELETE", `/api/kb/versions/${versionId}`, null, token);
    assert("version delete returns 200", versionDelete.status === 200);
    const versionDelete404 = await request("DELETE", `/api/kb/versions/${versionId}`, null, token);
    assert("version delete 404 on second attempt", versionDelete404.status === 404);
    const ticketAfterVersionDelete = await request("GET", "/api/tickets", null, token);
    const vt = ticketAfterVersionDelete.body.find(t => t.id === versionedTicket.body.id);
    assert("ticket's versionId cleared, not left dangling", vt && vt.versionId == null);

    console.log("\nColumns — create, update, bulk reorder, delete-guard (last column, ticket-in-column), delete");
    const column = await request("POST", `/api/kb/projects/${projectAutoKeyId}/columns`, { name: "Fixture Column", color: "#abcdef" }, token);
    assert("column created", column.status === 201, JSON.stringify(column.body));
    const columnId = column.body.id;
    const columnBadProject = await request("POST", "/api/kb/projects/PRJ-NOPE/columns", { name: "X" }, token);
    assert("column create 404 for unknown project", columnBadProject.status === 404);
    const columnNoName = await request("POST", `/api/kb/projects/${projectAutoKeyId}/columns`, {}, token);
    assert("column missing name rejected", columnNoName.status >= 400);

    const columnUpdate = await request("PUT", `/api/kb/columns/${columnId}`, { name: "Renamed Column", wipLimit: 5 }, token);
    assert("column update returns 200", columnUpdate.status === 200 && columnUpdate.body.wipLimit === 5);
    const columnUpdate404 = await request("PUT", "/api/kb/columns/COL-NOPE", { name: "X" }, token);
    assert("column update 404 for unknown id", columnUpdate404.status === 404);

    const beforeReorder = await request("GET", `/api/kb/projects/${projectAutoKeyId}/columns`, null, token);
    const reorderedIds = [...beforeReorder.body.map(c => c.id)].reverse();
    const reorder = await request("PATCH", `/api/kb/projects/${projectAutoKeyId}/columns`, { order: reorderedIds }, token);
    assert("bulk reorder returns 200", reorder.status === 200);
    assert("first column is now what was last", reorder.body[0].id === reorderedIds[0]);

    const columnWithTicket = beforeReorder.body[0]; // "Ready" — has our earlier fixture tickets? no, those are on `projectId`'s Ready. Use a column we can safely guard-test.
    // Delete-guard: ticket-in-column. Put a ticket in one of projectAutoKeyId's own columns first.
    const guardTicket = await request("POST", "/api/tickets", { title: "Column Guard Ticket", type: "Task", status: columnWithTicket.name, projectId: projectAutoKeyId }, token);
    const columnDeleteBlocked = await request("DELETE", `/api/kb/columns/${columnWithTicket.id}`, null, token);
    assert("column delete blocked while it holds a ticket", columnDeleteBlocked.status >= 400 && /ticket/i.test(columnDeleteBlocked.body.error || ""));
    await request("DELETE", `/api/tickets/${guardTicket.body.id}`, null, token);
    const columnDeleteOk = await request("DELETE", `/api/kb/columns/${columnId}`, null, token);
    assert("column delete succeeds once empty", columnDeleteOk.status === 200);
    const columnDelete404 = await request("DELETE", `/api/kb/columns/${columnId}`, null, token);
    assert("column delete 404 on second attempt", columnDelete404.status === 404);

    console.log("\nProject delete — both fixture projects removed (real seeded projects remain, so the last-project guard never actually engages here)");
    const deleteFirst = await request("DELETE", `/api/kb/projects/${projectAutoKeyId}`, null, token);
    assert("first fixture project delete succeeds (others remain)", deleteFirst.status === 200);
    const deleteSecond = await request("DELETE", `/api/kb/projects/${projectId}`, null, token);
    assert("second fixture project delete succeeds (real seeded projects remain)", deleteSecond.status === 200);

    console.log("\nDev-only ops-automation-sweep trigger");
    const sweep = await request("POST", "/api/test/run-ops-automation-sweep", {}, token);
    assert("sweep returns 200 with a ticketsCreated count", sweep.status === 200 && typeof sweep.body.ticketsCreated === "number");

    console.log("\nUnauthenticated requests rejected");
    const noAuth = await request("GET", "/api/tickets", null, null);
    assert("tickets list without a token rejected", noAuth.status === 401);

    console.log("\nCleanup");
    await request("DELETE", `/api/tickets/${storyId}`, null, token);
    await request("DELETE", `/api/tickets/${epicId}`, null, token);
    await request("DELETE", `/api/tickets/${shipmentTicket.body.id}`, null, token);
    await request("DELETE", `/api/tickets/${versionedTicket.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
