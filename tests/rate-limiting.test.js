/**
 * Rate limiting — smoke + real threshold tests
 *
 * Usage:
 *   node tests/rate-limiting.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *
 * Most of the new limiters added in this pass (reset-password, mail-test, document generate/
 * send-email, EDI/webhook send) sit on routes already exercised for correctness by their own
 * dedicated test files (password-reset.test.js, office-mail.test.js, document-signing.test.js,
 * document-distribution.test.js, carrier-booking.test.js, invoice-reversal.test.js) — those
 * files already prove the middleware doesn't break a legitimate call under budget. Deliberately
 * NOT re-asserting actual 429-tripping for any of those here: they share one continuous server
 * process with this file, so their real-world thresholds (5-20 per window) would trip based on
 * cumulative calls across the WHOLE suite's run order, not this file's own count alone — the
 * same reasoning password-reset.test.js's own comment gives for punting FORGOT_PW_MAX's actual
 * threshold to a separate one-off manual verification instead of the automated suite.
 *
 * This file instead covers what nothing else does:
 *   - The two brand-new /ws guards (per-IP connection cap, per-connection message-rate cap) —
 *     genuinely untouched by any other test file, safe to hammer without side effects, and their
 *     real default thresholds (20 conns/IP, 30 msgs/10s) are both cheap enough to actually trip
 *     here rather than punt to a manual check.
 *   - Smoke checks that AI chat / SSO — both new rate-limited routes neither hit any existing
 *     test file — still return their normal disabled/unconfigured response with the limiter
 *     wired in front of them (proves the middleware ordering doesn't break the route; a fresh/
 *     default DB has both features off, so this makes no real external call).
 *   - Smoke check that the CSV export route (also newly rate-limited, also untouched elsewhere)
 *     still returns a real CSV under budget.
 */

import http from "node:http";
import WebSocket from "ws";

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

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket("ws://localhost:3001/ws");
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function waitForClose(ws, timeoutMs = 5000) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    ws.once("close", code => { clearTimeout(t); resolve(code); });
  });
}

(async () => {
  const openSockets = [];
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nWS — per-connection message-rate cap (default 30 msgs / 10s)");
    {
      const ws = await openWs();
      openSockets.push(ws);
      const closeCode = waitForClose(ws);
      // 35 rapid subscribe frames — comfortably past the default 30/10s cap.
      for (let i = 0; i < 35; i++) {
        ws.send(JSON.stringify({ type: "subscribe", shipmentId: `SHP-RATELIMIT-TEST-${i}` }));
      }
      const code = await closeCode;
      assert("connection closed once the message-rate cap is exceeded", code === 1013, `got close code ${code}`);
    }

    console.log("\nWS — per-IP connection cap (default 20 concurrent / IP)");
    {
      const sockets = [];
      for (let i = 0; i < 21; i++) sockets.push(await openWs());
      openSockets.push(...sockets);
      // The 21st connection is accepted at the TCP/handshake level (ws.close() runs after
      // 'open', not before) but should be closed by the server almost immediately after.
      const last = sockets[sockets.length - 1];
      const code = await waitForClose(last, 5000);
      assert("the 21st connection from the same IP gets closed", code === 1013, `got close code ${code}`);
      assert("earlier connections are unaffected (still open)", sockets[0].readyState === WebSocket.OPEN);
    }

    console.log("\nAI chat — rate limiter wired in front of the existing disabled-by-default response");
    {
      const r = await request("POST", "/api/ai/chat", { messages: [{ role: "user", content: "hi" }] }, token);
      assert("still returns the normal disabled/unconfigured response (403 or 503), not a 429 or crash",
        r.status === 403 || r.status === 503, `got ${r.status}: ${JSON.stringify(r.body)}`);
    }

    console.log("\nSSO init — rate limiter wired in front of the existing disabled-by-default response");
    {
      const r = await request("GET", "/api/auth/sso/init", null, null);
      assert("still returns the normal SSO-not-enabled response, not a 429", r.status === 404, `got ${r.status}`);
    }

    console.log("\nCSV export — still works normally under budget with the new limiter in front of it");
    {
      const r = await request("GET", "/api/export/shipments.csv", null, token);
      assert("returns 200", r.status === 200, `got ${r.status}`);
    }

    console.log("\n──────────────────────────────────────────────────");
    console.log(`Results: ${passed} passed, ${failed} failed`);
    for (const ws of openSockets) { try { ws.close(); } catch {} }
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    for (const ws of openSockets) { try { ws.close(); } catch {} }
    process.exit(1);
  }
})();
