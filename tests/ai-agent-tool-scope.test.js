/**
 * AI Agent tool-execution containment (routes/ai.js) — 2026-09-03 audit.
 *
 * Drives a real tool-use round trip through POST /api/ai/chat against an in-process mock
 * OpenAI-compatible LLM endpoint (no real, billed provider involved) to prove three things
 * end to end, not just by reading the code:
 *
 *   1. get_shipment/list_shipments now respect the same per-user shipment scope
 *      (applyShipmentAccessFilter) every other shipment-reading route in this app already does
 *      — CRITICAL gap, confirmed live before this fix: a scope-restricted user could ask the AI
 *      assistant for any shipment in the whole system and get full detail back.
 *   2. list_shipments no longer 500s on every call (a separate, real bug found alongside the
 *      scope gap: the old count query kept unaggregated columns from its SELECT s.* base with
 *      no GROUP BY).
 *   3. An unrecognized tool name is safely rejected, not executed — the closed-whitelist
 *      boundary that keeps this agent contained to application data lookups only.
 *
 * Usage:
 *   node tests/ai-agent-tool-scope.test.js
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

async function login(email, password) {
  const { status, body } = await request("POST", "/api/auth/login", { email, password });
  if (status !== 200 || !body.token) throw new Error(`Login failed for ${email} (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

// Mock OpenAI-compatible endpoint (routes/ai.js's isAnthropicEndpoint() resolves false for any
// non-anthropic.com host, so a plain localhost mock speaks Chat Completions shape). First call
// requests whichever tool the test has staged; second call captures the tool result the real
// server fed back — that's the payload that would have leaked out-of-scope data before this fix.
let toolToRequest = null;
let capturedToolResultMessage = null;
let capturedFirstCallSystemContent = null;
let callCount = 0;
const MOCK_PORT = 4322;

const mockServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => raw += c);
  req.on("end", () => {
    callCount++;
    const parsed = JSON.parse(raw || "{}");
    res.setHeader("Content-Type", "application/json");
    if (callCount === 1) {
      capturedFirstCallSystemContent = parsed.messages?.find(m => m.role === "system")?.content || "";
      res.end(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant", content: null,
            tool_calls: [{ id: "t1", type: "function", function: { name: toolToRequest.name, arguments: JSON.stringify(toolToRequest.input) } }],
          },
        }],
      }));
    } else {
      capturedToolResultMessage = parsed.messages?.find(m => m.role === "tool") || null;
      res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "done" } }] }));
    }
  });
});

async function withMockServer(fn) {
  callCount = 0;
  capturedToolResultMessage = null;
  capturedFirstCallSystemContent = null;
  await new Promise(r => mockServer.listen(MOCK_PORT, r));
  try { return await fn(); }
  finally { await new Promise(r => mockServer.close(r)); }
}

async function chatRequestingTool(token, userMessage, name, input) {
  toolToRequest = { name, input };
  return withMockServer(() => request("POST", "/api/ai/chat", { messages: [{ role: "user", content: userMessage }] }, token));
}

(async () => {
  const adminToken = await login("claudeagent@localhost", "TestFixture!2026Zq");
  let scopeItemId = null;
  let scopedUserId = null;
  const cleanup = [];

  try {
    console.log("Point AI settings at the in-process mock endpoint, save originals for restore");
    const before = (await request("GET", "/api/settings", null, adminToken)).body;
    const AI_KEYS = ["ai_agent_enabled", "ai_endpoint", "ai_model", "ai_api_key", "ai_system_prompt"];
    // ai_api_key is masked by GET /api/settings (2026-09-03 audit fix) — before.ai_api_key is
    // always "", which PUT now treats as "leave the stored secret untouched," so restoring it
    // needs the explicit-clear signal (JSON null) when this environment's baseline is "no key
    // configured" (see ai-document-extraction.test.js's docstring) — a real pre-existing key
    // (not the case here) is left alone instead, since its true value was never observable.
    const restoreSettings = async () => {
      const patch = {};
      for (const k of AI_KEYS) patch[k] = before[k] ?? "";
      if (before.ai_api_key_configured) delete patch.ai_api_key;
      else patch.ai_api_key = null;
      await request("PUT", "/api/settings", patch, adminToken);
    };
    cleanup.push(restoreSettings);
    await request("PUT", "/api/settings", {
      ai_agent_enabled: "1", ai_endpoint: `http://localhost:${MOCK_PORT}/v1/chat/completions`,
      ai_api_key: "test-fixture-key", ai_model: "mock-model",
    }, adminToken);

    console.log("\nCreate two scratch shipments with different POLs to build a scope restriction");
    // Deliberately self-contained rather than picking two shipments off GET /api/shipments — CI
    // seeds only MDM reference data (npm run seed), not sample shipments, so the 45-file chain
    // builds up whatever shipments exist purely from each test's own fixtures; depending on
    // ambient data left over from wherever this file happens to land in that chain is exactly
    // the kind of ordering-fragile assumption that passes locally (a long-lived dev DB always has
    // plenty of shipments) and fails in CI. Confirmed live: this was the actual cause of a real
    // CI failure caught right after this file first shipped.
    const scopedPol = "NLRTM";
    const otherPol   = "DEHAM";
    const inScopeShipRes = await request("POST", "/api/shipments", { pol: scopedPol, pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, adminToken);
    const outOfScopeShipRes = await request("POST", "/api/shipments", { pol: otherPol, pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, adminToken);
    assert("in-scope scratch shipment created", inScopeShipRes.status === 200 || inScopeShipRes.status === 201);
    assert("out-of-scope scratch shipment created", outOfScopeShipRes.status === 200 || outOfScopeShipRes.status === 201);
    const inScope    = inScopeShipRes.body;
    const outOfScope = outOfScopeShipRes.body;
    cleanup.push(() => request("DELETE", `/api/shipments/${inScope.id}`, null, adminToken));
    cleanup.push(() => request("DELETE", `/api/shipments/${outOfScope.id}`, null, adminToken));

    console.log("\nCreate a trade_manager test user restricted to one POL");
    const email = `scope-audit-${Date.now()}@test.local`;
    const createUserRes = await request("POST", "/api/users", {
      name: "Scope Audit Fixture", email, password: "TestFixture!2026Zq", role: "trade_manager",
    }, adminToken);
    assert("scoped test user created", createUserRes.status === 200 || createUserRes.status === 201);
    const usersListRes = await request("GET", "/api/users", null, adminToken);
    const newUser = (Array.isArray(usersListRes.body) ? usersListRes.body : usersListRes.body.results).find(u => u.email === email);
    scopedUserId = newUser.id;
    cleanup.push(() => request("DELETE", `/api/users/${scopedUserId}`, null, adminToken));

    const scopeRes = await request("POST", `/api/users/${scopedUserId}/scope`, { itemType: "pol", value: scopedPol, label: "audit fixture" }, adminToken);
    assert("scope item created", scopeRes.status === 200 || scopeRes.status === 201);
    scopeItemId = scopeRes.body.id;
    cleanup.push(() => request("DELETE", `/api/scope-items/${scopeItemId}`, null, adminToken));

    const scopedToken = await login(email, "TestFixture!2026Zq");

    console.log("\nSanity check — the ordinary scoped shipment list route excludes the out-of-scope shipment");
    const scopedListRes = await request("GET", "/api/shipments", null, scopedToken);
    const scopedIds = (Array.isArray(scopedListRes.body) ? scopedListRes.body : scopedListRes.body.results).map(s => s.id);
    assert("GET /api/shipments (scoped route) excludes the out-of-scope shipment", !scopedIds.includes(outOfScope.id));

    console.log("\nget_shipment via AI chat — scoped user asking for an OUT-OF-SCOPE shipment");
    const oosRes = await chatRequestingTool(scopedToken, `What's the status of ${outOfScope.id}?`, "get_shipment", { id: outOfScope.id });
    assert("chat call succeeds (200)", oosRes.status === 200);
    const oosResultData = capturedToolResultMessage ? JSON.parse(capturedToolResultMessage.content) : null;
    assert("out-of-scope shipment is NOT leaked through the tool result", !!oosResultData?.error && !oosResultData.pol,
      JSON.stringify(oosResultData));

    console.log("\nget_shipment via AI chat — same scoped user asking for an IN-SCOPE shipment");
    const inScopeRes = await chatRequestingTool(scopedToken, `What's the status of ${inScope.id}?`, "get_shipment", { id: inScope.id });
    assert("chat call succeeds (200)", inScopeRes.status === 200);
    const inScopeResultData = capturedToolResultMessage ? JSON.parse(capturedToolResultMessage.content) : null;
    assert("in-scope shipment IS still returned correctly (fix doesn't over-block)", inScopeResultData?.id === inScope.id);

    console.log("\nget_shipment via AI chat — an unrestricted admin CAN still see the same out-of-scope shipment (no regression for the normal case)");
    const adminRes = await chatRequestingTool(adminToken, `What's the status of ${outOfScope.id}?`, "get_shipment", { id: outOfScope.id });
    const adminResultData = capturedToolResultMessage ? JSON.parse(capturedToolResultMessage.content) : null;
    assert("admin still gets the real shipment back", adminResultData?.id === outOfScope.id);

    console.log("\nlist_shipments via AI chat — no longer 500s, and excludes out-of-scope rows");
    const listChatRes = await chatRequestingTool(scopedToken, "List all shipments", "list_shipments", {});
    assert("chat call succeeds (200)", listChatRes.status === 200);
    const listResultData = capturedToolResultMessage ? JSON.parse(capturedToolResultMessage.content) : null;
    assert("list_shipments tool result has no SQL error (the GROUP BY bug is fixed)", !listResultData?.error, JSON.stringify(listResultData));
    const returnedIds = (listResultData?.shipments || []).map(s => s.id);
    assert("list_shipments excludes the out-of-scope shipment", !returnedIds.includes(outOfScope.id));
    assert("list_shipments returns at least the in-scope shipment", returnedIds.includes(inScope.id));

    console.log("\nClosed-whitelist boundary — an unrecognized tool name is rejected, never executed");
    const unknownRes = await chatRequestingTool(adminToken, "do something else", "execute_shell_command", { cmd: "rm -rf /" });
    assert("chat call still succeeds cleanly (200)", unknownRes.status === 200);
    const unknownResultData = capturedToolResultMessage ? JSON.parse(capturedToolResultMessage.content) : null;
    assert("unknown tool name returns a plain error, not a crash or silent execution", /Unknown tool/i.test(unknownResultData?.error || ""));

    console.log("\nNon-overridable containment system prompt is present on every chat call");
    assert("system prompt sent to the LLM includes the containment clause", /never write, generate, execute, or explain code/i.test(capturedFirstCallSystemContent || ""));

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  } finally {
    for (const fn of cleanup.reverse()) { try { await fn(); } catch {} }
  }
})();
