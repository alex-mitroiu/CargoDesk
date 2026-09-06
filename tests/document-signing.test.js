/**
 * Signed PDF Document Generation (Epic TKT-YOFYFZ) — smoke tests
 *
 * Usage:
 *   node tests/document-signing.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - PDF Render Service running on :3003 (services/pdf-render — the generate-document route
 *     calls it internally; started automatically by `npm run dev`, a separate process otherwise)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { verifySignedPdf } from "../lib/pdf-signing.js";

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

function download(shipmentId, docId, token) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}/api/shipments/${shipmentId}/documents/${docId}/download`, {
      headers: { Authorization: `Bearer ${token}` },
    }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
    }).on("error", reject);
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

async function scratchShipment(token) {
  const res = await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU",
    status: "Active", contractType: "SPOT", etd: "2026-09-01",
  }, token);
  return res.body.id;
}

const SAMPLE_HTML = `<html><head><style>
  body { font-family: sans-serif; padding: 24px; }
  h1 { color: #1a4d8f; font-size: 18px; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #ccc; padding: 6px; }
</style></head><body>
  <h1>Commercial Invoice (test fixture)</h1>
  <table><tr><th>Item</th><th>Qty</th></tr><tr><td>Test cargo</td><td>1</td></tr></table>
</body></html>`;

(async () => {
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nScratch shipment");
    const shipmentId = await scratchShipment(token);
    assert("scratch shipment created", !!shipmentId);

    console.log("\nGenerate a signed PDF document");
    const gen = await request("POST", `/api/shipments/${shipmentId}/documents/generate`, {
      html: SAMPLE_HTML, filename: "CI01-TEST-2026-07-28.html", docType: "CI01",
    }, token);
    assert("generate returns 201", gen.status === 201, JSON.stringify(gen.body));
    assert("mimeType is application/pdf", gen.body.mimeType === "application/pdf");
    assert(".html was swapped for .pdf in the stored filename", gen.body.filename === "CI01-TEST-2026-07-28.pdf");
    assert("sizeBytes is a real positive number", gen.body.sizeBytes > 1000);
    const docId = gen.body.id;

    console.log("\nMissing html/filename is rejected");
    const bad = await request("POST", `/api/shipments/${shipmentId}/documents/generate`, { docType: "CI01" }, token);
    assert("missing html/filename rejected", bad.status >= 400);

    console.log("\nDownload the generated file");
    const dl = await download(shipmentId, docId, token);
    assert("download returns 200", dl.status === 200);
    assert("downloaded bytes start with %PDF-", dl.buffer.slice(0, 5).toString() === "%PDF-");

    console.log("\nVerify the cryptographic signature (untampered)");
    const verified = verifySignedPdf(dl.buffer);
    assert("digest matches signed content", verified.digestMatches === true);
    assert("RSA signature is valid", verified.signatureValid === true);
    assert("overall integrity is true", verified.integrity === true);
    assert("cert subject is the CargoDesk signing cert", verified.certSubject === "CargoDesk Document Signing");

    console.log("\nTamper-evidence: flip one byte in the signed content, integrity must break");
    const tampered = Buffer.from(dl.buffer);
    // Byte 200 sits inside the page content stream (well before the /ByteRange /
    // signature dictionary near the end) for a file this small — safe to flip without
    // corrupting PDF structure itself, only the signed content.
    tampered[200] = tampered[200] ^ 0xff;
    const afterTamper = verifySignedPdf(tampered);
    assert("tampered digest no longer matches", afterTamper.digestMatches === false);
    assert("tampered integrity is false", afterTamper.integrity === false);

    console.log("\nExisting plain upload route is unaffected (raw file attachments still allowed)");
    const rawUpload = await request("POST", `/api/shipments/${shipmentId}/documents`, {
      filename: "manual-attachment.txt", mimeType: "text/plain",
      data: Buffer.from("plain attachment, not CargoDesk-generated").toString("base64"),
    }, token);
    assert("plain upload still returns 201", rawUpload.status === 201);
    assert("plain upload mimeType untouched", rawUpload.body.mimeType === "text/plain");

    console.log("\nCleanup");
    await request("DELETE", `/api/shipments/${shipmentId}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
