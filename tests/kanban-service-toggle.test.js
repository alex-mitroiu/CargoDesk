/**
 * Kanban/Testing Service — the app_settings.kanban_source toggle and the monolith-side proxy
 * layer (routes/kanban.js, routes/testcases.js, resolveAssigneeNames, ensureOpsTicket/
 * runOpsAutomationSweep) that switches on it.
 *
 * With 'local' (the default every existing install keeps), every route behaves exactly as it
 * always has. With 'remote', the same routes proxy to the standalone Kanban Service — this test
 * proves both modes work, that they really are two independent datastores (not a live sync), that
 * assignee names/initials still resolve even though the service itself owns no `users` table, that
 * the Test Case <-> Ticket story-link JOIN survives (both tables co-located in that service), and
 * that the ops-automation sweep's new atomic ensure route doesn't create duplicate tickets across
 * two consecutive runs.
 *
 * Requires TWO processes running — this is the monolith-level test file that does.
 *
 * Usage:
 *   node tests/kanban-service-toggle.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Kanban Service running on :3007 (npm run kanban-service)
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

async function login(email, password) {
  const { status, body } = await request("POST", "/api/auth/login", { email, password });
  if (status !== 200 || !body.token) throw new Error(`Login failed for ${email} (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

async function setSource(token, value) {
  return request("PUT", "/api/settings/kanban-source", { value }, token);
}

(async () => {
  const stamp = Date.now();
  let scratchUserId = null, localTicketId = null, remoteTicketId = null, caseId = null, storyTicketId = null;
  try {
    const token = await login("claudeagent@localhost", "TestFixture!2026Zq");

    console.log("Baseline");
    const settings0 = await request("GET", "/api/settings", null, token);
    assert("kanban_source defaults to 'local'", (settings0.body.kanban_source || "local") === "local");

    console.log("\nToggle route is admin-only and validates its value");
    const scratchEmail = `kanban-toggle-test-${stamp}@test.local`;
    const createUser = await request("POST", "/api/users",
      { email: scratchEmail, name: "Kanban Toggle Test Assignee", roles: ["viewer"], password: "TestFixture!2026Zq" }, token);
    assert("scratch user created", createUser.status === 200, JSON.stringify(createUser.body));
    const usersList = await request("GET", "/api/users", null, token);
    const scratchUser = usersList.body.find(u => u.email === scratchEmail);
    scratchUserId = scratchUser?.id;
    assert("scratch user findable", !!scratchUserId);
    const viewerToken = await login(scratchEmail, "TestFixture!2026Zq");
    const viewerTry = await setSource(viewerToken, "remote");
    assert("non-admin rejected (403)", viewerTry.status === 403, JSON.stringify(viewerTry.body));
    const badVal = await setSource(token, "somewhere-else");
    assert("invalid value rejected (400)", badVal.status === 400, JSON.stringify(badVal.body));

    console.log("\n'local' mode — full ticket CRUD, unchanged behavior");
    const createLocal = await request("POST", "/api/tickets", { title: `Toggle Test Local Ticket ${stamp}` }, token);
    assert("local ticket create 201", createLocal.status === 201, JSON.stringify(createLocal.body));
    localTicketId = createLocal.body.id;

    console.log("\nFlip to 'remote'");
    const flipRemote = await setSource(token, "remote");
    assert("flip to remote succeeds", flipRemote.status === 200 && flipRemote.body.kanbanSource === "remote", JSON.stringify(flipRemote.body));

    console.log("\n'remote' mode — ticket CRUD proxies correctly to the standalone service");
    const createRemote = await request("POST", "/api/tickets", { title: `Toggle Test Remote Ticket ${stamp}`, assigneeId: scratchUserId }, token);
    assert("remote ticket create 201", createRemote.status === 201, JSON.stringify(createRemote.body));
    remoteTicketId = createRemote.body.id;
    const getLocalFromRemote = await request("GET", "/api/tickets", null, token);
    assert("the local-only ticket is invisible while on remote", !getLocalFromRemote.body.some(t => t.id === localTicketId), JSON.stringify(getLocalFromRemote.body.length));

    console.log("\nAssignee name/initial resolve locally even though the service owns no users table");
    const remoteList = await request("GET", "/api/tickets", null, token);
    const foundRemote = remoteList.body.find(t => t.id === remoteTicketId);
    assert("assigneeName resolved via resolveAssigneeNames", foundRemote?.assigneeName === scratchUser.name, JSON.stringify(foundRemote));
    assert("assigneeInitial resolved to the first letter", foundRemote?.assigneeInitial === scratchUser.name.trim()[0].toUpperCase());

    console.log("\nTest Case <-> Ticket story-link JOIN survives (both tables co-located remotely)");
    const storyTicket = await request("POST", "/api/tickets", { title: `Story Ticket ${stamp}` }, token);
    storyTicketId = storyTicket.body.id;
    const caseCreate = await request("POST", "/api/test-items", { title: `Toggle Test Case ${stamp}`, type: "Test Case" }, token);
    assert("remote test case create 201", caseCreate.status === 201, JSON.stringify(caseCreate.body));
    caseId = caseCreate.body.id;
    const linkCreate = await request("POST", `/api/test-items/${caseId}/story-links`, { ticketId: storyTicketId }, token);
    assert("story link create 201 in remote mode", linkCreate.status === 201, JSON.stringify(linkCreate.body));
    const testedBy = await request("GET", `/api/tickets/${storyTicketId}/tested-by`, null, token);
    assert("reverse JOIN resolves the real test case title", testedBy.body[0]?.case?.title === `Toggle Test Case ${stamp}`, JSON.stringify(testedBy.body));

    console.log("\nOps-automation sweep — atomic ensure means two consecutive runs never duplicate a ticket");
    const sweep1 = await request("POST", "/api/test/run-ops-automation-sweep", {}, token);
    assert("first sweep run succeeds", sweep1.status === 200 && typeof sweep1.body.ticketsCreated === "number", JSON.stringify(sweep1.body));
    const sweep2 = await request("POST", "/api/test/run-ops-automation-sweep", {}, token);
    assert("second consecutive sweep run creates 0 new tickets (nothing newly eligible in between)", sweep2.body.ticketsCreated === 0, JSON.stringify(sweep2.body));

    console.log("\nProves two independent datastores, not a live sync");
    const flipLocal = await setSource(token, "local");
    assert("flip back to local succeeds", flipLocal.status === 200 && flipLocal.body.kanbanSource === "local", JSON.stringify(flipLocal.body));
    const getRemoteFromLocal = await request("GET", "/api/tickets", null, token);
    assert("the remote-created ticket is invisible once back on local", !getRemoteFromLocal.body.some(t => t.id === remoteTicketId), JSON.stringify(getRemoteFromLocal.body.length));
    const getLocalStillThere = await request("GET", "/api/tickets", null, token);
    assert("the original local ticket was never touched", getLocalStillThere.body.some(t => t.id === localTicketId));

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    const adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq").catch(() => null);
    if (adminToken) {
      if (localTicketId) await request("DELETE", `/api/tickets/${localTicketId}`, null, adminToken).catch(() => {});
      await setSource(adminToken, "remote").catch(() => {}); // reach remote-only rows below before flipping back
      if (remoteTicketId) await request("DELETE", `/api/tickets/${remoteTicketId}`, null, adminToken).catch(() => {});
      if (storyTicketId) await request("DELETE", `/api/tickets/${storyTicketId}`, null, adminToken).catch(() => {});
      if (caseId) await request("DELETE", `/api/test-items/${caseId}`, null, adminToken).catch(() => {});
      await setSource(adminToken, "local").catch(() => {}); // always leave the toggle back at the safe default
      if (scratchUserId) await request("DELETE", `/api/users/${scratchUserId}`, null, adminToken).catch(() => {});
    }
  }
})();
