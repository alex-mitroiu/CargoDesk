/**
 * lib/pdf-signing.js — renderHtmlToPdf error-branch smoke tests
 *
 * tests/document-signing.test.js already exercises the full happy-path pipeline (render, sign,
 * verify, tamper-detection) through the real running PDF Render Service. What it can't reach
 * without taking that service down is renderHtmlToPdf's own two failure branches — service
 * unreachable, and a reachable-but-non-2xx response — so this tests lib/pdf-signing.js
 * DIRECTLY (no HTTP call to :3001 at all), the same "import the lib module and call it" pattern
 * document-signing.test.js already established for verifySignedPdf. Each scenario needs its own
 * PDF_RENDER_SERVICE_URL (read once at module load), so the CommonJS require cache is cleared
 * between them to force a fresh module instance per scenario, all within one process.
 *
 * Usage:
 *   node tests/pdf-signing-errors.test.js
 *
 * Prerequisites: none — doesn't touch the running dev stack at all.
 */

import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);
let passed = 0;
let failed = 0;

function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

function freshPdfSigning(url) {
  const path = require.resolve("../lib/pdf-signing.js");
  delete require.cache[path];
  const prev = process.env.PDF_RENDER_SERVICE_URL;
  process.env.PDF_RENDER_SERVICE_URL = url;
  const mod = require("../lib/pdf-signing.js");
  process.env.PDF_RENDER_SERVICE_URL = prev;
  return mod;
}

function startStubServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

(async () => {
  try {
    console.log("\nrenderHtmlToPdf — service unreachable (connection refused) throws a clean 503");
    // Port 1 is a reserved/privileged port essentially guaranteed to have nothing listening —
    // fetch() fails fast with ECONNREFUSED, no real network round-trip needed.
    const { renderHtmlToPdf: renderUnreachable } = freshPdfSigning("http://127.0.0.1:1");
    try {
      await renderUnreachable("<html><body>test</body></html>");
      assert("throws when the service is unreachable", false, "did not throw");
    } catch (e) {
      assert("throws when the service is unreachable", true);
      assert("error carries status 503", e.status === 503);
      assert("error message names it unreachable", /unreachable/i.test(e.message));
    }

    console.log("\nrenderHtmlToPdf — reachable but returns a non-2xx status, with a JSON error body");
    const badServer = await startStubServer((req, res) => {
      let body = "";
      req.on("data", c => (body += c));
      req.on("end", () => {
        res.writeHead(422, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Rendering engine crashed on this HTML" }));
      });
    });
    const badPort = badServer.address().port;
    try {
      const { renderHtmlToPdf: renderBad } = freshPdfSigning(`http://127.0.0.1:${badPort}`);
      try {
        await renderBad("<html><body>test</body></html>");
        assert("throws on a non-2xx response", false, "did not throw");
      } catch (e) {
        assert("throws on a non-2xx response", true);
        assert("error carries the real upstream status (422)", e.status === 422);
        assert("error message is the upstream's own JSON error text", e.message === "Rendering engine crashed on this HTML");
      }
    } finally {
      badServer.close();
    }

    console.log("\nrenderHtmlToPdf — reachable, non-2xx, but body isn't valid JSON — falls back to a generic message, not a crash");
    const uglyServer = await startStubServer((req, res) => {
      let body = "";
      req.on("data", c => (body += c));
      req.on("end", () => { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("not json"); });
    });
    const uglyPort = uglyServer.address().port;
    try {
      const { renderHtmlToPdf: renderUgly } = freshPdfSigning(`http://127.0.0.1:${uglyPort}`);
      try {
        await renderUgly("<html><body>test</body></html>");
        assert("throws on a non-JSON error body", false, "did not throw");
      } catch (e) {
        assert("throws on a non-JSON error body", true);
        assert("falls back to a generic HTTP-status message", e.message === "PDF Render Service returned HTTP 500");
      }
    } finally {
      uglyServer.close();
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
