/**
 * CargoDesk — first-time setup (optional since 2026-11-22)
 *
 * Not needed any more: the server loads its reference data itself on its first start (ports, carriers, countries,
 * regions, commodities, HS codes and, outside production, the mock vessels — lib/reference-data.js) and downloads the
 * SMDG terminal list once in the background (lib/facilities.js). `npm run dev` or `node server.js` is enough.
 *
 * Kept for anyone used to it: it boots the server once (schema + reference data) and shuts it down CLEANLY through the
 * dev shutdown route, so pgdata/ is ready and unlocked. It no longer runs the seed script, the step that had to wait for
 * the server to stop (pglite is single-connection: lib/db.js's lock, 2026-09-04).
 *
 * Usage (after npm install):
 *   npm run setup
 */

const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HEALTH_URL = "http://localhost:3001/api/health";
const SHUTDOWN_URL = "http://localhost:3001/internal/dev/shutdown";
const BOOT_TIMEOUT_MS = 180_000; // the first start also loads the reference data
const POLL_INTERVAL_MS = 300;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHealthy(deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return true;
    } catch {
      // Not up yet — keep polling.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function isPortInUse(port) {
  const net = require("net");
  return new Promise(resolve => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

(async () => {
  console.log("⚓  CargoDesk setup\n");

  if (await isPortInUse(3001)) {
    console.error("✗ Something is already listening on port 3001 — stop it first (Ctrl+C, or");
    console.error("  the graceful shutdown route), then re-run npm run setup.");
    process.exit(1);
  }

  console.log("① Booting the server once (schema and reference data)…");
  const server = spawn("node", ["server.js"], { cwd: ROOT, stdio: "inherit" });
  let serverExited = false;
  server.on("exit", () => { serverExited = true; });

  const healthy = await waitForHealthy(Date.now() + BOOT_TIMEOUT_MS);
  if (!healthy) {
    console.error(`\n✗ Server didn't report healthy within ${BOOT_TIMEOUT_MS / 1000}s.`);
    if (!serverExited) server.kill();
    process.exit(1);
  }
  console.log("  ✔ Schema created and reference data loaded.\n");

  console.log("② Shutting the server down cleanly (releases its database lock)…");
  try {
    // /internal/dev/shutdown only exists when NODE_ENV !== "production" (server.js) — fetch()
    // resolving doesn't mean the shutdown actually happened, since a 404 here still resolves
    // normally rather than throwing. Checking res.ok is what actually distinguishes "the server
    // is now shutting down" from "that route doesn't exist" — without it, this step could report
    // success while the server (and its exclusive pgdata/ lock) is still very much alive,
    // confusing whatever comes next rather than failing clearly the way every other step here does.
    const res = await fetch(SHUTDOWN_URL, { method: "POST" });
    if (!res.ok) {
      console.error(`✗ Shutdown route returned ${res.status} — is NODE_ENV set to "production"? That route is dev-only.`);
      if (!serverExited) server.kill();
      process.exit(1);
    }
  } catch (e) {
    console.error(`✗ Couldn't reach the shutdown route: ${e.message}`);
    if (!serverExited) server.kill();
    process.exit(1);
  }
  await new Promise(resolve => {
    if (serverExited) return resolve();
    server.on("exit", resolve);
  });
  console.log("  ✔ Server stopped.\n");

  console.log("✔ Setup complete — run npm run dev to start CargoDesk.");
})().catch(e => {
  console.error("\n✗ Setup failed:", e.message);
  process.exit(1);
});
