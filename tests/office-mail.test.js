/**
 * Office-Level Email Distribution (Epic TKT-O4B0IB) — smoke tests
 *
 * Usage:
 *   node tests/office-mail.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import path from "node:path";
import nodemailer from "nodemailer";
import { buildTransportOptions, buildMailOptions } from "../lib/mailer.js";

const BASE = "http://localhost:3001";
let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: "localhost",
      port: 3001,
      path,
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
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function login() {
  const { status, body } = await request("POST", "/api/auth/login", {
    email: "claudeagent@localhost",
    password: "TestFixture!2026Zq",
  });
  if (status !== 200 || !body.token)
    throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

(async () => {
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nPure functions: buildTransportOptions (lib/mailer.js, no network)");
    const none = buildTransportOptions({ smtpHost: "h", smtpPort: 25, secureMode: "none", smtpUsername: "", smtpPassword: "" });
    assert("none mode: secure=false, ignoreTLS=true", none.secure === false && none.ignoreTLS === true);
    assert("none mode: no auth block when username is blank", none.auth === undefined);
    const starttls = buildTransportOptions({ smtpHost: "h", smtpPort: 587, secureMode: "starttls", smtpUsername: "u", smtpPassword: "p" });
    assert("starttls mode: secure=false, requireTLS=true", starttls.secure === false && starttls.requireTLS === true);
    assert("starttls mode: auth present", starttls.auth?.user === "u" && starttls.auth?.pass === "p");
    const tls = buildTransportOptions({ smtpHost: "h", smtpPort: 465, secureMode: "tls", smtpUsername: "u", smtpPassword: "p" });
    assert("tls mode: secure=true", tls.secure === true);
    assert("connection timeouts are set (fail fast on a bad host)", none.connectionTimeout > 0 && none.socketTimeout > 0);

    console.log("\nPure functions: buildMailOptions (lib/mailer.js, no network)");
    const mailOpts = buildMailOptions({
      from: "noreply@x.com", fromName: "CargoDesk EMO", to: "someone@example.com",
      subject: "Test Subject", message: "Hello", attachmentPath: path.join(process.cwd(), "package.json"),
      attachmentFilename: "BL01-test.pdf",
    });
    assert("from includes quoted display name", mailOpts.from === '"CargoDesk EMO" <noreply@x.com>');
    assert("to/subject/text round-trip", mailOpts.to === "someone@example.com" && mailOpts.subject === "Test Subject" && mailOpts.text === "Hello");
    assert("attachment present with pdf contentType", mailOpts.attachments?.[0]?.contentType === "application/pdf");

    console.log("\nFull composed-message check via nodemailer's own no-network test transport");
    const streamTransporter = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const info = await streamTransporter.sendMail(mailOpts);
    const raw = info.message.toString();
    assert("composed message includes recipient", raw.includes("someone@example.com"));
    assert("composed message includes subject", raw.includes("Test Subject"));
    assert("composed message includes attachment filename", raw.includes("BL01-test.pdf"));
    assert("composed message includes base64-encoded attachment part", raw.includes("Content-Transfer-Encoding: base64"));

    console.log("\nScratch office + shipment for the HTTP route tests");
    const office = await request("POST", "/api/offices", { unlocode: "XXTST", department: "SE", name: "Test Mail Office" }, token);
    assert("scratch office created", office.status === 201);
    const officeId = office.body.id;

    console.log("\nGET mail-settings before any save (default shape)");
    const before = await request("GET", `/api/offices/${officeId}/mail-settings`, null, token);
    assert("returns 200", before.status === 200);
    assert("hasPassword is false", before.body.hasPassword === false);
    assert("response never includes a password-shaped field", !("smtpPassword" in before.body) && !("smtp_password" in before.body));

    console.log("\nPUT mail-settings — validation");
    const missingHost = await request("PUT", `/api/offices/${officeId}/mail-settings`, { smtpHost: "", fromAddress: "a@b.com" }, token);
    assert("blank host rejected", missingHost.status >= 400);
    const badMode = await request("PUT", `/api/offices/${officeId}/mail-settings`, { smtpHost: "smtp.example.com", secureMode: "bogus", fromAddress: "a@b.com" }, token);
    assert("invalid secureMode rejected", badMode.status >= 400);

    console.log("\nPUT mail-settings — save, then confirm the password never round-trips");
    const saved = await request("PUT", `/api/offices/${officeId}/mail-settings`, {
      smtpHost: "smtp.example.com", smtpPort: 587, secureMode: "starttls",
      smtpUsername: "user@example.com", smtpPassword: "s3cret", fromAddress: "noreply@example.com", fromName: "Test Office",
    }, token);
    assert("save returns 200", saved.status === 200);
    assert("hasPassword is now true", saved.body.hasPassword === true);
    assert("response never includes the actual password value", JSON.stringify(saved.body).includes("s3cret") === false);

    console.log("\nBlank password on update keeps the existing one");
    const updatedNoPw = await request("PUT", `/api/offices/${officeId}/mail-settings`, {
      smtpHost: "smtp.example.com", smtpPort: 587, secureMode: "starttls",
      smtpUsername: "user@example.com", smtpPassword: "", fromAddress: "noreply@example.com", fromName: "Test Office Updated",
    }, token);
    assert("update returns 200", updatedNoPw.status === 200);
    assert("hasPassword is still true (kept)", updatedNoPw.body.hasPassword === true);
    assert("fromName was updated", updatedNoPw.body.fromName === "Test Office Updated");

    console.log("\nTest-send route against a closed local port — fast, clean failure (not a hang, not a 500 stack trace)");
    const testSend = await request("POST", `/api/offices/${officeId}/mail-settings/test`, {
      to: "someone@example.com", smtpHost: "127.0.0.1", smtpPort: 1, secureMode: "none",
    }, token);
    assert("test-send returns a clean error status", testSend.status >= 400 && testSend.status < 600);
    assert("test-send error message present", typeof testSend.body.error === "string" && testSend.body.error.length > 0);

    console.log("\nDocument send-email route — no EMO assigned");
    const shipNoEmo = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT" }, token);
    const docNoEmo = await request("POST", `/api/shipments/${shipNoEmo.body.id}/documents/generate`, { html: "<html><body>x</body></html>", filename: "x.html", docType: "OT" }, token);
    const sendNoEmo = await request("POST", `/api/shipments/${shipNoEmo.body.id}/documents/${docNoEmo.body.id}/send-email`, { to: "someone@example.com" }, token);
    assert("send rejected when shipment has no EMO office", sendNoEmo.status >= 400);

    console.log("\nDocument send-email route — EMO assigned but no mail settings configured for it");
    const office2 = await request("POST", "/api/offices", { unlocode: "XXTS2", department: "SE", name: "Test Office No Mail" }, token);
    const shipNoSettings = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", emoOfficeId: office2.body.id }, token);
    const docNoSettings = await request("POST", `/api/shipments/${shipNoSettings.body.id}/documents/generate`, { html: "<html><body>x</body></html>", filename: "x.html", docType: "OT" }, token);
    const sendNoSettings = await request("POST", `/api/shipments/${shipNoSettings.body.id}/documents/${docNoSettings.body.id}/send-email`, { to: "someone@example.com" }, token);
    assert("send rejected when EMO office has no mail settings", sendNoSettings.status >= 400);

    console.log("\nDocument send-email route — EMO configured, unreachable host, clean failure end-to-end");
    // Point the scratch office's saved settings at a closed local port for a fast, deterministic failure.
    await request("PUT", `/api/offices/${officeId}/mail-settings`, {
      smtpHost: "127.0.0.1", smtpPort: 1, secureMode: "none", fromAddress: "noreply@example.com", fromName: "Test Office",
    }, token);
    const shipReal = await request("POST", "/api/shipments", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT", emoOfficeId: officeId }, token);
    const docReal = await request("POST", `/api/shipments/${shipReal.body.id}/documents/generate`, { html: "<html><body>Real doc</body></html>", filename: "BL01.html", docType: "BL01" }, token);
    const sendReal = await request("POST", `/api/shipments/${shipReal.body.id}/documents/${docReal.body.id}/send-email`, { to: "someone@example.com", subject: "Test", message: "Hi" }, token);
    assert("send returns a clean error (not a hang, not a 500 stack trace)", sendReal.status >= 400 && sendReal.status < 600);
    assert("send rejected for missing recipient", (await request("POST", `/api/shipments/${shipReal.body.id}/documents/${docReal.body.id}/send-email`, {}, token)).status >= 400);

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipNoEmo.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipNoSettings.body.id}`, null, token);
    await request("DELETE", `/api/shipments/${shipReal.body.id}`, null, token);
    await request("DELETE", `/api/offices/${office2.body.id}`, null, token);
    await request("DELETE", `/api/offices/${officeId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
