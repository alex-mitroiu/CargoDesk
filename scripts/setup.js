/**
 * CargoDesk — first-time setup
 *
 * Automates the exact sequence that has to happen in order, and that's easy to get wrong by
 * hand: boot the server once so it creates its own schema, shut it down CLEANLY (releasing its
 * exclusive lock on pgdata/), then seed MDM reference data — never while the server is still up.
 * See lib/db.js's own lock (added 2026-09-04, after a real corrupted-database incident traced to
 * running the seed script concurrently with a live server) for why that order matters.
 *
 * Usage (after npm install):
 *   npm run setup
 */

const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const HEALTH_URL = "http://localhost:3001/api/health";
const SHUTDOWN_URL = "http://localhost:3001/internal/dev/shutdown";
const BOOT_TIMEOUT_MS = 30_000;
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

function runToCompletion(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`)));
  });
}

(async () => {
  console.log("⚓  CargoDesk setup\n");

  if (await isPortInUse(3001)) {
    console.error("✗ Something is already listening on port 3001 — stop it first (Ctrl+C, or");
    console.error("  the graceful shutdown route), then re-run npm run setup.");
    process.exit(1);
  }

  console.log("① Booting the server once to create its schema…");
  const server = spawn("node", ["server.js"], { cwd: ROOT, stdio: "inherit" });
  let serverExited = false;
  server.on("exit", () => { serverExited = true; });

  const healthy = await waitForHealthy(Date.now() + BOOT_TIMEOUT_MS);
  if (!healthy) {
    console.error(`\n✗ Server didn't report healthy within ${BOOT_TIMEOUT_MS / 1000}s.`);
    if (!serverExited) server.kill();
    process.exit(1);
  }
  console.log("  ✔ Schema created.\n");

  console.log("② Shutting the server down cleanly (releases its database lock)…");
  try {
    await fetch(SHUTDOWN_URL, { method: "POST" });
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

  console.log("③ Seeding MDM reference data (ports, carriers, vessels, commodities, regions, trade lanes)…");
  await runToCompletion("node", ["scripts/import-mdm-data.js"]);

  console.log("\n✔ Setup complete — run npm run dev to start CargoDesk.");
})().catch(e => {
  console.error("\n✗ Setup failed:", e.message);
  process.exit(1);
});
