/**
 * Scheduled / emailed reports (TKT-IXAR9G, Competitive Gap Analysis epic TKT-GTGM6R)
 *
 * CRUD + validation on the scheduled_reports registry, admin-only gating (this sends real
 * outbound email, same tier as the dunning-reminder manual trigger), and the manual sweep
 * trigger's own shape. This environment has no reachable SMTP server (matches
 * office-mail.test.js's/billing-performance.test.js's own disclosed limitation) — a real
 * successful send can't be exercised end-to-end; these tests cover every gating branch up to
 * that network boundary.
 *
 * Usage:
 *   node tests/scheduled-reports.test.js
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

    console.log("\nScratch office for the CRUD/sweep tests");
    const rand = Math.random().toString(36).slice(2, 8);
    const office = await request("POST", "/api/offices", { unlocode: `X${rand.slice(0, 4).toUpperCase()}`, department: "SE", name: "Test Scheduled Reports Office" }, token);
    assert("scratch office created", office.status === 201, JSON.stringify(office.body));
    const officeId = office.body.id;
    await request("PUT", `/api/offices/${officeId}/mail-settings`, {
      smtpHost: "127.0.0.1", smtpPort: 1, secureMode: "none", fromAddress: "noreply@example.com", fromName: "Test Reports Office",
    }, token);

    console.log("\nScheduled Reports — validation");
    const badType = await request("POST", "/api/scheduled-reports", { reportType: "not-a-real-type", frequency: "weekly", recipients: "a@b.com", officeId }, token);
    assert("invalid reportType rejected", badType.status >= 400, JSON.stringify(badType.body));
    const badFreq = await request("POST", "/api/scheduled-reports", { reportType: "shipments-csv", frequency: "hourly", recipients: "a@b.com", officeId }, token);
    assert("invalid frequency rejected", badFreq.status >= 400, JSON.stringify(badFreq.body));
    const noRecipients = await request("POST", "/api/scheduled-reports", { reportType: "shipments-csv", frequency: "weekly", recipients: "", officeId }, token);
    assert("blank recipients rejected", noRecipients.status >= 400, JSON.stringify(noRecipients.body));
    const badOffice = await request("POST", "/api/scheduled-reports", { reportType: "shipments-csv", frequency: "weekly", recipients: "a@b.com", officeId: "OFF-DOESNOTEXIST" }, token);
    assert("non-existent officeId rejected", badOffice.status === 404, JSON.stringify(badOffice.body));

    console.log("\nScheduled Reports — CRUD + admin-only gating");
    const occEmail = `occ-srep-${rand}@example.com`;
    await request("POST", "/api/users", { email: occEmail, name: "OCC Scheduled Reports Test", roles: ["occ_bk"], password: "OccFixture!2026Zq" }, token);
    const occLogin = await request("POST", "/api/auth/login", { email: occEmail, password: "OccFixture!2026Zq" });
    const asOcc = await request("POST", "/api/scheduled-reports", { reportType: "shipments-csv", frequency: "weekly", recipients: "a@b.com", officeId }, occLogin.body.token);
    assert("occ_bk (not admin) cannot create a schedule", asOcc.status === 403, JSON.stringify(asOcc.body));

    const created = await request("POST", "/api/scheduled-reports", {
      reportType: "shipments-csv", frequency: "daily", recipients: "ops@example.com, finance@example.com ,", officeId,
    }, token);
    assert("create returns 201", created.status === 201, JSON.stringify(created.body));
    assert("reportType round-trips", created.body?.reportType === "shipments-csv");
    assert("frequency round-trips", created.body?.frequency === "daily");
    assert("recipients are trimmed and empty entries dropped", created.body?.recipients === "ops@example.com,finance@example.com", JSON.stringify(created.body));
    assert("officeName is resolved via the join", created.body?.officeName === "Test Scheduled Reports Office", JSON.stringify(created.body));
    assert("isActive defaults true", created.body?.isActive === true);
    assert("lastRunAt is null (never run yet)", created.body?.lastRunAt === null);

    const list = await request("GET", "/api/scheduled-reports", null, token);
    assert("list includes the new schedule", list.body.some(r => r.id === created.body.id));

    const updated = await request("PUT", `/api/scheduled-reports/${created.body.id}`, { frequency: "monthly", isActive: false }, token);
    assert("update returns 200", updated.status === 200, JSON.stringify(updated.body));
    assert("frequency updates independently", updated.body?.frequency === "monthly");
    assert("isActive updates independently", updated.body?.isActive === false);
    assert("recipients untouched by a partial update", updated.body?.recipients === "ops@example.com,finance@example.com", JSON.stringify(updated.body));

    const asOccDelete = await request("DELETE", `/api/scheduled-reports/${created.body.id}`, null, occLogin.body.token);
    assert("occ_bk cannot delete a schedule", asOccDelete.status === 403, JSON.stringify(asOccDelete.body));
    const removed = await request("DELETE", `/api/scheduled-reports/${created.body.id}`, null, token);
    assert("delete returns 200", removed.status === 200);
    const missingDelete = await request("DELETE", `/api/scheduled-reports/${created.body.id}`, null, token);
    assert("deleting again 404s", missingDelete.status === 404);

    console.log("\nManual sweep trigger — admin-only gate, and a due-but-unreachable-SMTP schedule fails cleanly");
    const asOccSweep = await request("POST", "/api/scheduled-reports/send-due", {}, occLogin.body.token);
    assert("occ_bk cannot trigger the sweep", asOccSweep.status === 403, JSON.stringify(asOccSweep.body));

    const dueSchedule = await request("POST", "/api/scheduled-reports", {
      reportType: "shipments-csv", frequency: "daily", recipients: "ops@example.com", officeId,
    }, token);
    const sweep = await request("POST", "/api/scheduled-reports/send-due", {}, token);
    assert("sweep run returns 200 (no crash walking the full due-schedule path)", sweep.status === 200, JSON.stringify(sweep.body));
    assert("sentCount matches the sent array length", sweep.body?.sentCount === sweep.body?.sent.length, JSON.stringify(sweep.body));
    assert("a due schedule against an unreachable SMTP host does not falsely report as sent", !sweep.body?.sent.some(s => s.id === dueSchedule.body.id), JSON.stringify(sweep.body));

    console.log("\nCleanup");
    await request("DELETE", `/api/users/${(await request("GET", "/api/users", null, token)).body.find(u => u.email === occEmail)?.id}`, null, token).catch(() => {});
    await request("DELETE", `/api/scheduled-reports/${dueSchedule.body.id}`, null, token);
    await request("DELETE", `/api/offices/${officeId}`, null, token);

    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("\nFATAL:", e.message);
    process.exit(1);
  }
})();
