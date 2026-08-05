"use strict";
// PDF Render Service — CargoDesk's second extracted microservice. Owns the heaviest, most
// bursty piece of the monolith's runtime (a headless-Chromium launch + render per document,
// via Puppeteer) so it can no longer degrade the monolith's own event loop — specifically the
// persistent AIS WebSocket listener and the live WS broadcast to browsers, both of which need
// low, steady latency and previously shared a process with this. See the audit this extraction
// was based on (logged against TKT-YQYUSX) for the full reasoning.
//
// Deliberately stateless and narrow: HTML in, raw PDF bytes out, nothing else. It never touches
// a database, never sees a signing key, and is never called from the browser — only from the
// monolith's lib/pdf-signing.js, which still does cert lookup + cryptographic signing itself
// (the signing key never leaves the monolith, an existing invariant this extraction preserves
// exactly, not just "mostly").
const express = require("express");
const fs = require("fs");

const PORT = process.env.PDF_RENDER_SERVICE_PORT || 3003;
const SERVICE_SECRET = process.env.PDF_RENDER_SERVICE_SECRET || "cargoDesk-dev-pdf-render-secret-do-not-use-in-prod";
if (!process.env.PDF_RENDER_SERVICE_SECRET)
  console.warn("⚠  PDF_RENDER_SERVICE_SECRET env var not set — using insecure dev default. Set it (and the same value in the monolith's env) before deploying.");

const app = express();
app.use(express.json({ limit: "20mb" })); // generated document HTML can be a few MB with inline styles

const ok = (res, data, status = 200) => res.status(status).json(data);
const err = (res, msg, status = 400) => res.status(status).json({ error: msg });

// Public liveness check — no secret required, mirrors the other services' own GET /health.
app.get("/health", (req, res) => ok(res, { status: "ok", service: "pdf-render", uptime: process.uptime() }));

// Everything else requires the shared service-to-service secret. Never called from the browser.
app.use("/internal", (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token !== SERVICE_SECRET) return err(res, "Unauthorized", 401);
  next();
});

// ─── Browser lifecycle (moved verbatim from the monolith's lib/pdf-signing.js) ────────────────

let browserPromise = null;

// Never hardcode a dev machine's browser path — resolve via env var first, then a short
// well-known-paths fallback list per OS. Errors lazily at render time (not at server boot)
// so a machine with no browser installed yet still starts up fine.
function resolveBrowserExecutable() {
  if (process.env.PDF_BROWSER_PATH) return process.env.PDF_BROWSER_PATH;
  const candidates = process.platform === "win32" ? [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ] : [
    "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
    "/usr/bin/microsoft-edge", "/opt/google/chrome/chrome",
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error(
    "No PDF-capable browser found. Set PDF_BROWSER_PATH to an installed Chromium/Edge/Chrome executable."
  );
  return found;
}

async function getBrowser() {
  if (browserPromise) return browserPromise;
  const puppeteer = require("puppeteer-core");
  browserPromise = puppeteer.launch({
    executablePath: resolveBrowserExecutable(),
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  }).catch(e => { browserPromise = null; throw e; });
  return browserPromise;
}

// Renders a CargoDesk-generated HTML document (already fully self-contained — inline <style>,
// no external assets, same as every buildXHtml function in src/App.jsx produces) into a PDF
// buffer. preferCSSPageSize honors the document's own @page rule (INV_CSS's 18mm margins),
// matching today's browser-print output instead of imposing Puppeteer's own default size.
async function renderHtmlToPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "networkidle0" });
    return await page.pdf({ printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}

app.post("/internal/render", async (req, res) => {
  const { html } = req.body || {};
  if (!html) return err(res, "html is required");
  try {
    const pdf = await renderHtmlToPdf(html);
    res.status(200).set("Content-Type", "application/pdf").send(Buffer.from(pdf));
  } catch (e) {
    err(res, e.message, 500);
  }
});

app.listen(PORT, () => console.log(`PDF Render Service listening on :${PORT}`));

// A stuck/crashed browser shouldn't need a full process restart to recover — the next render
// call just re-launches it (getBrowser's own catch already clears browserPromise on failure).
process.on("SIGTERM", async () => {
  if (browserPromise) { try { (await browserPromise).close(); } catch { /* already gone */ } }
  process.exit(0);
});
