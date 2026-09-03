/**
 * AI Agent routes (routes/ai.js) — gating / validation smoke tests
 *
 * Covers every branch reachable WITHOUT a real, working provider key: the disabled-agent
 * gate, the endpoint/key-not-configured gate, request-body validation on both /chat and
 * /extract-document, the unsupported-mimeType and PDF-requires-Anthropic branches, and
 * GET /api/ai/settings. Also exercises the outbound-fetch failure path (a real network call
 * to a deliberately unreachable/reserved-invalid host, RFC 2606 .invalid TLD) to reach the
 * provider-branching request-building code (buildRequest/isAnthropicEndpoint) one step
 * further than the gating tests alone can, without ever calling a real, billed provider.
 * tests/ai-document-extraction.test.js and tests/rate-limiting.test.js already cover a subset
 * of this from different angles — this fills in the rest and GET /api/ai/settings entirely.
 *
 * Usage:
 *   node tests/ai-agent-gating.test.js
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

    console.log("\nGET /api/ai/settings — safe, non-secret config shape");
    const settingsRes = await request("GET", "/api/ai/settings", null, token);
    assert("returns 200", settingsRes.status === 200);
    assert("shape has enabled/endpoint/model/hasKey/systemPrompt", ["enabled", "endpoint", "model", "hasKey", "systemPrompt"].every(k => k in settingsRes.body));
    assert("never leaks the raw key, only a boolean", typeof settingsRes.body.hasKey === "boolean");
    const noAuthSettings = await request("GET", "/api/ai/settings", null, null);
    assert("settings without a token rejected (401)", noAuthSettings.status === 401);

    console.log("\nSave the real settings so every mutation below is fully restored afterward");
    const before = (await request("GET", "/api/settings", null, token)).body;
    const AI_KEYS = ["ai_agent_enabled", "ai_endpoint", "ai_model", "ai_api_key", "ai_system_prompt"];
    // ai_api_key is masked by GET /api/settings (2026-09-03 audit fix) — before.ai_api_key is
    // always "", which PUT now treats as "leave the stored secret untouched" rather than "clear
    // it", so restoring it needs the explicit-clear signal (JSON null) instead when this
    // environment's own documented baseline is "no key configured" (see
    // ai-document-extraction.test.js's docstring — hasKey:false here). A real key already
    // present before this test ran (not the case in this environment) would need a different,
    // out-of-band restore path, since its true value was never observable to begin with.
    const restore = async () => {
      const patch = {};
      for (const k of AI_KEYS) patch[k] = before[k] ?? "";
      if (before.ai_api_key_configured) delete patch.ai_api_key; // was already set — leave untouched, can't restore an unobserved value
      else patch.ai_api_key = null; // baseline was no key — genuinely clear whatever this test set
      await request("PUT", "/api/settings", patch, token);
    };

    try {
      console.log("\nAgent disabled — both routes reject with 403");
      await request("PUT", "/api/settings", { ai_agent_enabled: "0" }, token);
      const chatDisabled = await request("POST", "/api/ai/chat", { messages: [{ role: "user", content: "hi" }] }, token);
      assert("chat rejected while disabled (403)", chatDisabled.status === 403);
      const extractDisabled = await request("POST", "/api/ai/extract-document", { dataBase64: "x", mimeType: "image/png", instructions: "x" }, token);
      assert("extract-document rejected while disabled (403)", extractDisabled.status === 403);
      const settingsWhileDisabled = await request("GET", "/api/ai/settings", null, token);
      assert("settings reflects enabled:false", settingsWhileDisabled.body.enabled === false);

      console.log("\nAgent enabled but no endpoint/key configured — 503 on both routes");
      await request("PUT", "/api/settings", { ai_agent_enabled: "1", ai_endpoint: "", ai_api_key: "" }, token);
      const chatNoKey = await request("POST", "/api/ai/chat", { messages: [{ role: "user", content: "hi" }] }, token);
      assert("chat rejected with no endpoint/key (503)", chatNoKey.status === 503);
      const extractNoKey = await request("POST", "/api/ai/extract-document", { dataBase64: "x", mimeType: "image/png", instructions: "x" }, token);
      assert("extract-document rejected with no endpoint/key (503)", extractNoKey.status === 503);

      console.log("\nEnabled + endpoint + key configured — request-body validation branches");
      // A reserved, guaranteed-non-resolving host (RFC 2606 .invalid TLD) — validation runs
      // BEFORE any outbound fetch, so these never actually reach the network.
      const FAKE_KEY = "sk-test-fixture-not-a-real-key";
      await request("PUT", "/api/settings", { ai_agent_enabled: "1", ai_endpoint: "https://not-a-real-ai-endpoint.invalid/v1/chat/completions", ai_api_key: FAKE_KEY }, token);

      const chatNoMessages = await request("POST", "/api/ai/chat", { messages: [] }, token);
      assert("chat with an empty messages array rejected", chatNoMessages.status >= 400);
      const chatMissingMessages = await request("POST", "/api/ai/chat", {}, token);
      assert("chat with no messages field rejected", chatMissingMessages.status >= 400);

      const extractMissingData = await request("POST", "/api/ai/extract-document", { mimeType: "image/png", instructions: "x" }, token);
      assert("extract-document missing dataBase64 rejected", extractMissingData.status >= 400);
      const extractMissingMime = await request("POST", "/api/ai/extract-document", { dataBase64: "x", instructions: "x" }, token);
      assert("extract-document missing mimeType rejected", extractMissingMime.status >= 400);
      const extractMissingInstructions = await request("POST", "/api/ai/extract-document", { dataBase64: "x", mimeType: "image/png" }, token);
      assert("extract-document missing instructions rejected", extractMissingInstructions.status >= 400);
      const extractBadMime = await request("POST", "/api/ai/extract-document", { dataBase64: "x", mimeType: "application/zip", instructions: "x" }, token);
      assert("extract-document unsupported mimeType rejected", extractBadMime.status >= 400 && /Unsupported file type/i.test(extractBadMime.body.error || ""));

      console.log("\nPDF extraction requires an Anthropic endpoint — the OpenAI-compatible (non-Anthropic) preset above rejects it");
      const extractPdfNonAnthropic = await request("POST", "/api/ai/extract-document", { dataBase64: "x", mimeType: "application/pdf", instructions: "x" }, token);
      assert("PDF against a non-Anthropic endpoint rejected (400)", extractPdfNonAnthropic.status === 400 && /Anthropic/i.test(extractPdfNonAnthropic.body.error || ""));

      console.log("\nPast validation — a real outbound fetch to the deliberately-unreachable endpoint fails cleanly (502), not a crash");
      const chatUnreachable = await request("POST", "/api/ai/chat", { messages: [{ role: "user", content: "hi" }] }, token);
      assert("chat proxy failure returns 502, not a hang/crash", chatUnreachable.status === 502);
      assert("error message names it a proxy error", /AI proxy error/i.test(chatUnreachable.body.error || ""));

      const extractImageUnreachable = await request("POST", "/api/ai/extract-document", { dataBase64: "AAAA", mimeType: "image/png", instructions: "Extract the invoice number" }, token);
      assert("extract-document (image, OpenAI-shaped payload) proxy failure returns 502", extractImageUnreachable.status === 502);

      console.log("\nSwitch to an Anthropic-shaped endpoint (still unreachable) — exercises the PDF content-block branch up to the fetch call");
      await request("PUT", "/api/settings", { ai_agent_enabled: "1", ai_endpoint: "https://api.anthropic.com.invalid-test-fixture.invalid/v1/messages", ai_api_key: FAKE_KEY }, token);
      const extractPdfAnthropic = await request("POST", "/api/ai/extract-document", { dataBase64: "AAAA", mimeType: "application/pdf", instructions: "Extract the invoice number" }, token);
      assert("PDF against an Anthropic-shaped (but unreachable) endpoint reaches the fetch and fails cleanly (502)", extractPdfAnthropic.status === 502);
      const chatAnthropicShaped = await request("POST", "/api/ai/chat", {
        messages: [{ role: "user", content: "What's the status of SHP-TEST?" }], context: { shipmentId: "SHP-TEST" },
      }, token);
      assert("chat with shipmentId context against an Anthropic-shaped endpoint fails cleanly (502)", chatAnthropicShaped.status === 502);
    } finally {
      await restore();
    }

    const settingsAfter = await request("GET", "/api/ai/settings", null, token);
    assert("settings restored to their original values", settingsAfter.body.enabled === (before.ai_agent_enabled === "1") && settingsAfter.body.endpoint === (before.ai_endpoint || ""));

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
