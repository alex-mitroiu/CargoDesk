/**
 * 100-concurrent-user load test against the local CargoDesk API.
 *
 * Simulates a realistic mixed session, not a single-endpoint hammer: each virtual connection
 * repeatedly lists shipments, views one, browses a lightweight MDM lookup, then creates, updates,
 * and deletes its own scratch shipment (a full CRUD cycle) — so both the read-heavy and
 * write-heavy paths get exercised under real concurrency, and the create/delete pairing keeps
 * the dev database from growing unbounded across repeated runs.
 *
 * One admin login happens ONCE before the run starts (not per-connection/per-cycle) — 100
 * connections logging in simultaneously would immediately trip the per-IP login rate limiter
 * (LOGIN_RATE_MAX), which isn't what this test is measuring. The resulting JWT is shared via
 * autocannon's `initialContext`, exactly like every other authenticated request in the app uses
 * a bearer token — this only skips re-authenticating on every cycle, not authentication itself.
 *
 * Usage:
 *   node scripts/load-test.js [connections] [durationSeconds]
 *   node scripts/load-test.js            # defaults: 100 connections, 30s
 *   node scripts/load-test.js 50 60      # 50 connections, 60s
 *
 * Prerequisites:
 *   - Express server running on :3001 (npm run server / npm run dev)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - At least one real shipment already exists (any scratch one from prior testing works) —
 *     used as the shared "view a shipment" target; the script fetches one automatically.
 */

const autocannon = require("autocannon");

const BASE = "http://localhost:3001";
const connections = parseInt(process.argv[2], 10) || 100;
const duration = parseInt(process.argv[3], 10) || 30;

async function apiCall(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

(async () => {
  console.log(`Load test: ${connections} concurrent connections, ${duration}s, target ${BASE}`);

  console.log("\nLogging in once (shared token, avoids tripping the per-IP login rate limiter)…");
  const login = await apiCall("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" });
  if (login.status !== 200 || !login.body.token) {
    console.error("Login failed — is the server running on :3001?", login.status, login.body);
    process.exit(1);
  }
  const token = login.body.token;
  console.log("  ✓ Logged in as", login.body.user.email);

  console.log("\nFinding a real shipment to use as the shared \"view one\" target…");
  const list = await apiCall("GET", "/api/shipments?limit=1", null, token);
  const sharedShipmentId = Array.isArray(list.body) ? list.body[0]?.id : list.body?.results?.[0]?.id;
  if (!sharedShipmentId) {
    console.error("No shipments exist yet to use as a read target — create at least one first.");
    process.exit(1);
  }
  console.log("  ✓ Using", sharedShipmentId);

  const rand = () => Math.random().toString(36).slice(2, 8).toUpperCase();

  const instance = autocannon({
    url: BASE,
    connections,
    duration,
    pipelining: 1, // one in-flight request per connection at a time — real users wait for each response
    initialContext: { token, sharedShipmentId },
    requests: [
      {
        // Shipments list page load
        method: "GET",
        path: "/api/shipments?limit=50&offset=0",
        setupRequest: (req, ctx) => ({ ...req, headers: { Authorization: `Bearer ${ctx.token}` } }),
      },
      {
        // View a shipment's detail
        setupRequest: (req, ctx) => ({ ...req, method: "GET", path: `/api/shipments/${ctx.sharedShipmentId}`,
          headers: { Authorization: `Bearer ${ctx.token}` } }),
      },
      {
        // Lightweight MDM dropdown-style read (e.g. a carrier picker)
        method: "GET",
        path: "/api/carriers",
        setupRequest: (req, ctx) => ({ ...req, headers: { Authorization: `Bearer ${ctx.token}` } }),
      },
      {
        // Create a scratch shipment — unique data per cycle so nothing collides across connections
        method: "POST",
        path: "/api/shipments",
        setupRequest: (req, ctx) => ({
          ...req,
          headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
          // carrierCode is a deliberately fake, distinctive code (not a real carrier) so any
          // leaked row is unambiguous to find later — a plain "note" field doesn't survive at
          // all (POST /api/shipments doesn't read one), a real gap found the first time this
          // script ran with a note-based marker and silently produced a false-clean leak check.
          body: JSON.stringify({ pol: "NLRTM", pod: "USNYC", carrierCode: "LDTST", status: "Active",
            contractType: "SPOT", contractRef: `LOADTEST-${rand()}` }),
        }),
        onResponse: (status, body, ctx) => {
          try { ctx.createdId = JSON.parse(body).id; } catch { ctx.createdId = null; }
        },
      },
      {
        // Update the shipment it just created (write-under-concurrency on a row nothing else touches)
        method: "PUT",
        setupRequest: (req, ctx) => {
          if (!ctx.createdId) return false; // no id captured — restart the cycle rather than PUT to nothing
          return { ...req, path: `/api/shipments/${ctx.createdId}`,
            headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ contractRef: `LOADTEST-${rand()}-updated` }) };
        },
      },
      {
        // Delete it — keeps the dev database from growing unbounded across repeated load-test runs
        method: "DELETE",
        setupRequest: (req, ctx) => {
          if (!ctx.createdId) return false;
          return { ...req, path: `/api/shipments/${ctx.createdId}`, headers: { Authorization: `Bearer ${ctx.token}` } };
        },
      },
    ],
  }, async (err, results) => {
    if (err) { console.error("Load test failed:", err); process.exit(1); }
    console.log("\n─── Summary ───────────────────────────────────────────────");
    console.log(`Requests completed: ${results.requests.total}`);
    console.log(`Non-2xx responses:  ${results.non2xx}`);
    console.log(`Connection errors:  ${results.errors}`);
    console.log(`Timeouts:           ${results.timeouts}`);
    console.log(`Pipeline resets:    ${results.resets} (a setupRequest returned false — usually a create that didn't return an id)`);
    console.log(`Latency p50/p97.5/p99/max: ${results.latency.p50}ms / ${results.latency.p97_5}ms / ${results.latency.p99}ms / ${results.latency.max}ms`);
    console.log(`Throughput: ${results.requests.average.toFixed(1)} req/sec average`);
    if (results.non2xx > 0 || results.errors > 0 || results.timeouts > 0) {
      console.log("\n⚠ Non-zero errors/non-2xx/timeouts — investigate before treating this as a clean pass.");
    } else {
      console.log("\n✓ Zero errors, zero non-2xx responses, zero timeouts.");
    }

    // A handful of connections are always caught mid-cycle (between create and delete) when the
    // run's duration expires — this is expected, not a bug, and scales with `connections`, not
    // with anything wrong. Cleaned up here so a repeat run always starts from a clean baseline;
    // carrierCode="LDTST" is a deliberately fake code used by nothing else, so this can never
    // touch real data.
    const remaining = await apiCall("GET", "/api/shipments", null, token);
    const rows = Array.isArray(remaining.body) ? remaining.body : (remaining.body?.results || []);
    const orphaned = rows.filter(s => s.carrierCode === "LDTST");
    if (orphaned.length > 0) {
      console.log(`\nCleaning up ${orphaned.length} shipment(s) caught mid-cycle at the time limit…`);
      for (const s of orphaned) await apiCall("DELETE", `/api/shipments/${s.id}`, null, token).catch(() => {});
      console.log("  ✓ Cleaned up");
    }
  });

  autocannon.track(instance, { renderProgressBar: true });
})();
