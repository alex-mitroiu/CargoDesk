/**
 * AI-driven document extraction — POST /api/ai/extract-document.
 *
 * This dev environment has the AI Agent enabled but no real provider API key configured
 * (GET /api/ai/settings -> hasKey:false), so the live vision-model call itself can't be
 * exercised here. This suite covers every gating/validation branch that runs BEFORE the
 * outbound call to the configured LLM endpoint — the full boundary that's actually testable
 * without live credentials — and settings it touches are always restored to their original
 * values, mirroring the DG Compliance settings round-trip in tests/container-packages.test.js.
 *
 * Usage:
 *   node tests/ai-document-extraction.test.js
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

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost", password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

// Tiny 1x1 PNG, valid base64 image data — content doesn't matter for these validation-path tests.
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

(async () => {
  let token;
  let savedAgentEnabled, savedApiKey, savedEndpoint;
  try {
    token = await login();

    const settingsBefore = await request("GET", "/api/settings", null, token);
    assert("settings GET returns 200", settingsBefore.status === 200, JSON.stringify(settingsBefore.body));
    savedAgentEnabled = settingsBefore.body.ai_agent_enabled;
    savedApiKey       = settingsBefore.body.ai_api_key;
    savedEndpoint = settingsBefore.body.ai_endpoint || "";

    console.log(`\nThis environment's real AI Agent config: enabled=${savedAgentEnabled === '1'}, hasKey=${!!savedApiKey}, endpoint=${savedEndpoint || "(none)"}`);

    if (savedAgentEnabled === '1' && !savedApiKey) {
      console.log("\nEnabled but no API key configured — the actual current state; no setting change needed for this case");
      const noKey = await request("POST", "/api/ai/extract-document",
        { dataBase64: TINY_PNG_B64, mimeType: "image/png", instructions: "extract" }, token);
      assert("returns 503 when no API key is configured", noKey.status === 503, JSON.stringify(noKey.body));
      assert("503 message names the missing config", /endpoint or API key/i.test(noKey.body.error || ""), JSON.stringify(noKey.body));
    } else {
      console.log("\nSkipping the 'no key configured' case — doesn't match this environment's current state");
    }

    console.log("\nDisabled AI agent — 403 before any body validation runs");
    await request("PUT", "/api/settings", { ai_agent_enabled: "0" }, token);
    const disabled = await request("POST", "/api/ai/extract-document",
      { dataBase64: TINY_PNG_B64, mimeType: "image/png", instructions: "extract" }, token);
    assert("returns 403 when the AI agent is disabled", disabled.status === 403, JSON.stringify(disabled.body));
    await request("PUT", "/api/settings", { ai_agent_enabled: savedAgentEnabled }, token);

    if (!savedApiKey) {
      // A placeholder endpoint is just as necessary as the key — the route 503s on either being
      // blank (routes/ai.js: `if (!endpoint || !apiKey)`), and a genuinely fresh environment
      // (every CI run) has ai_endpoint = '' by default, same as ai_api_key. Deliberately a
      // non-Anthropic-shaped URL so the "PDF on a non-Anthropic endpoint" branch below always
      // exercises deterministically, rather than depending on whatever endpoint (if any)
      // happened to be pre-configured in this environment.
      const PLACEHOLDER_ENDPOINT = "https://api.example.com/v1/chat/completions";
      console.log("\nNo real key/endpoint was configured, so it's safe to set placeholders here — this reaches every body-validation branch (they all run before the outbound fetch) without ever calling a real provider");
      await request("PUT", "/api/settings", { ai_agent_enabled: "1", ai_api_key: "test-placeholder-not-a-real-key", ai_endpoint: PLACEHOLDER_ENDPOINT }, token);

      const missingData = await request("POST", "/api/ai/extract-document",
        { mimeType: "image/png", instructions: "extract" }, token);
      assert("missing dataBase64 -> 400", missingData.status === 400 && /dataBase64/i.test(missingData.body.error || ""), JSON.stringify(missingData.body));

      const missingMime = await request("POST", "/api/ai/extract-document",
        { dataBase64: TINY_PNG_B64, instructions: "extract" }, token);
      assert("missing mimeType -> 400", missingMime.status === 400 && /mimeType/i.test(missingMime.body.error || ""), JSON.stringify(missingMime.body));

      const missingInstructions = await request("POST", "/api/ai/extract-document",
        { dataBase64: TINY_PNG_B64, mimeType: "image/png" }, token);
      assert("missing instructions -> 400", missingInstructions.status === 400 && /instructions/i.test(missingInstructions.body.error || ""), JSON.stringify(missingInstructions.body));

      const badMime = await request("POST", "/api/ai/extract-document",
        { dataBase64: TINY_PNG_B64, mimeType: "text/plain", instructions: "extract" }, token);
      assert("unsupported mimeType -> 400", badMime.status === 400 && /Unsupported file type/i.test(badMime.body.error || ""), JSON.stringify(badMime.body));

      console.log("\nPDF on a non-Anthropic endpoint -> clean 400, not a silently wrong-shaped request");
      const pdfBlocked = await request("POST", "/api/ai/extract-document",
        { dataBase64: TINY_PNG_B64, mimeType: "application/pdf", instructions: "extract" }, token);
      assert("PDF rejected on a non-Anthropic endpoint", pdfBlocked.status === 400 && /Anthropic endpoint/i.test(pdfBlocked.body.error || ""), JSON.stringify(pdfBlocked.body));

      await request("PUT", "/api/settings", { ai_agent_enabled: savedAgentEnabled, ai_api_key: savedApiKey || "", ai_endpoint: savedEndpoint }, token);
    } else {
      console.log("\nA real API key is configured in this environment — skipping the placeholder-key validation block rather than overwriting it (its original value can't be reliably restored)");
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e);
    process.exitCode = 1;
  } finally {
    if (token && savedAgentEnabled !== undefined) {
      // Best-effort final restore in case an assertion threw mid-sequence before its own restore ran.
      await request("PUT", "/api/settings", { ai_agent_enabled: savedAgentEnabled, ai_api_key: savedApiKey || "", ai_endpoint: savedEndpoint || "" }, token).catch(() => {});
    }
  }
})();
