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
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { readSecret } = require("./lib/dockerSecret");

// Every log line this service emits for the browser lifecycle carries one of these codes, so a
// failure is greppable ("PDFR-" + a stable event) instead of only ever showing up as a bare
// Puppeteer stack trace with no way to correlate it back to a specific step.
const LOG = {
  LAUNCH_START:  "PDFR-001",
  LAUNCH_READY:  "PDFR-002",
  LAUNCH_FAILED: "PDFR-003",
  RENDER_FAILED: "PDFR-004",
  SHUTDOWN:      "PDFR-005",
};
const log = (code, msg) => console.log(`[${code}] ${msg}`);
const logErr = (code, msg) => console.error(`[${code}] ${msg}`);

const PORT = process.env.PDF_RENDER_SERVICE_PORT || 3003;
const SERVICE_SECRET_DEV_DEFAULT = "cargoDesk-dev-pdf-render-secret-do-not-use-in-prod";
const SERVICE_SECRET = readSecret("PDF_RENDER_SERVICE_SECRET", SERVICE_SECRET_DEV_DEFAULT);
if (SERVICE_SECRET === SERVICE_SECRET_DEV_DEFAULT)
  console.warn("⚠  PDF_RENDER_SERVICE_SECRET not set (checked PDF_RENDER_SERVICE_SECRET_FILE, then PDF_RENDER_SERVICE_SECRET) — using insecure dev default. Set it (and the same value in the monolith's env) before deploying.");

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
let browserChild = null; // the OS process we spawned — tracked so SIGTERM can kill it directly

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

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function waitForCdp(port, tries = 50, intervalMs = 200) {
  for (let i = 0; i < tries; i++) {
    try { return await httpGetJson(`http://127.0.0.1:${port}/json/version`); }
    catch { await new Promise(r => setTimeout(r, intervalMs)); }
  }
  throw new Error(`Browser process started but never answered on CDP port ${port} after ${tries * intervalMs}ms`);
}

// puppeteer.launch()'s own readiness check watches the child process's stderr for the
// "DevTools listening on ws://..." line — in this environment, spawning msedge.exe with piped
// stdio (which launch() requires, to read that line) silently breaks Edge's own internal
// parent-to-child relaunch, so the real browser never comes up and the pipe closes immediately
// with exit code 0 and empty output ("Failed to launch the browser process: Code: 0").
// Confirmed directly: the identical spawn with stdio:'ignore' (no piping at all) launches Edge
// successfully every time — this app's own CDP verification tooling has relied on exactly that
// all along. So: spawn the same way (stdio:'ignore', detached), poll the CDP HTTP endpoint
// ourselves instead of reading stderr, then puppeteer.connect() to the already-running browser
// instead of asking puppeteer to launch (and therefore stdio-detect) it.
const CDP_PORT = Number(process.env.PDF_BROWSER_CDP_PORT) || 9350;
const BROWSER_PROFILE_DIR = path.join(os.tmpdir(), "cargodesk-pdf-render-browser-profile");

async function launchBrowser() {
  const executablePath = resolveBrowserExecutable();
  log(LOG.LAUNCH_START, `Spawning ${executablePath} (CDP port ${CDP_PORT})`);
  const child = spawn(executablePath, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${BROWSER_PROFILE_DIR}`,
    "--no-first-run",
  ], { stdio: "ignore", detached: true });
  child.unref();
  child.on("error", e => logErr(LOG.LAUNCH_FAILED, `Spawn error: ${e.message}`));
  await waitForCdp(CDP_PORT);
  const puppeteer = require("puppeteer-core");
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}` });
  browserChild = child;
  log(LOG.LAUNCH_READY, `Browser ready, pid ${child.pid}`);
  browser.on("disconnected", () => { browserPromise = null; browserChild = null; });
  return browser;
}

async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = launchBrowser().catch(e => {
    logErr(LOG.LAUNCH_FAILED, e.message);
    browserPromise = null;
    throw e;
  });
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
    logErr(LOG.RENDER_FAILED, e.message);
    err(res, `[${LOG.RENDER_FAILED}] ${e.message}`, 500);
  }
});

app.listen(PORT, () => console.log(`PDF Render Service listening on :${PORT}`));

// A stuck/crashed browser shouldn't need a full process restart to recover — the next render
// call just re-launches it (getBrowser's own catch already clears browserPromise on failure).
// Kills the OS process we tracked directly, rather than going through Puppeteer's close()/
// disconnect() on a connect()-ed (not launch()-ed) Browser, whose semantics for actually
// terminating the remote process are less predictable — this is the same orphaned-process
// concern from this session's own CDP verification cleanup, applied to the service's own
// long-lived browser instance.
function killBrowserChild() {
  if (!browserChild || browserChild.exitCode !== null) return;
  try { browserChild.kill(); } catch { /* already gone */ }
}
process.on("SIGTERM", () => { log(LOG.SHUTDOWN, "SIGTERM received"); killBrowserChild(); process.exit(0); });
process.on("SIGINT",  () => { log(LOG.SHUTDOWN, "SIGINT received");  killBrowserChild(); process.exit(0); });
