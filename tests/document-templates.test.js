/**
 * Document Template Editor — CRUD + cascading /resolve lookup — smoke tests
 *
 * Usage:
 *   node tests/document-templates.test.js
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

// Office `code` is server-generated from country+unlocode+department (routes/offices.js) —
// creating a scratch one risks colliding with a real office already in the dev DB. Simpler and
// collision-free to just reuse whatever real office already exists.
async function anyOfficeId(token) {
  const res = await request("GET", "/api/offices", null, token);
  const offices = Array.isArray(res.body) ? res.body : (res.body?.results ?? []);
  if (!offices.length) throw new Error("No offices exist in this dev DB to test against");
  return offices[0].id;
}

(async () => {
  try {
    console.log("Logging in...");
    const token = await login();
    console.log("  ✓ Logged in");

    console.log("\nReusing a real existing office for scoping (avoids code-collision risk)");
    const officeId = await anyOfficeId(token);
    assert("resolved a real office id", !!officeId);

    console.log("\nCreate a generic (no office, no carrier) BL01 template");
    const generic = await request("POST", "/api/document-templates", {
      docType: "BL01", officeId: null, carrierCode: null, name: "Generic BL01", pageSize: "A4",
      fields: [{ id: "f1", x: 10, y: 10, width: 100, height: 20, type: "text", source: "field", path: "shipment.shipperName" }],
    }, token);
    assert("generic template created", generic.status === 200 && !!generic.body.id, JSON.stringify(generic.body));
    assert("generic officeId is null", generic.body.officeId === null);
    assert("generic fields round-trip", generic.body.fields.length === 1 && generic.body.fields[0].path === "shipment.shipperName");

    console.log("\nDuplicate generic scope is rejected");
    const dupGeneric = await request("POST", "/api/document-templates", {
      docType: "BL01", officeId: null, carrierCode: null, name: "Duplicate Generic BL01",
    }, token);
    assert("duplicate generic scope 400s", dupGeneric.status === 400, JSON.stringify(dupGeneric.body));

    console.log("\nCreate an office-only (no carrier) BL01 template");
    const officeOnly = await request("POST", "/api/document-templates", {
      docType: "BL01", officeId, carrierCode: null, name: "Office-Only BL01",
    }, token);
    assert("office-only template created", officeOnly.status === 200, JSON.stringify(officeOnly.body));
    assert("office-only carries office code/name via join", !!officeOnly.body.officeCode);

    console.log("\nCreate an exact office+carrier BL01 template");
    const exact = await request("POST", "/api/document-templates", {
      docType: "BL01", officeId, carrierCode: "MAEU", name: "Rotterdam Maersk BL01",
    }, token);
    assert("exact template created", exact.status === 200, JSON.stringify(exact.body));

    console.log("\nResolve cascades exact -> office-only -> generic -> none");
    const resolveExact = await request("GET", `/api/document-templates/resolve?docType=BL01&officeId=${officeId}&carrierCode=MAEU`, null, token);
    assert("resolve exact match returns the exact template", resolveExact.body?.id === exact.body.id, JSON.stringify(resolveExact.body));

    const resolveOfficeOnly = await request("GET", `/api/document-templates/resolve?docType=BL01&officeId=${officeId}&carrierCode=HLCU`, null, token);
    assert("resolve falls back to office-only for a different carrier", resolveOfficeOnly.body?.id === officeOnly.body.id, JSON.stringify(resolveOfficeOnly.body));

    const resolveGeneric = await request("GET", `/api/document-templates/resolve?docType=BL01&officeId=NONEXISTENT&carrierCode=HLCU`, null, token);
    assert("resolve falls back to generic for an unknown office", resolveGeneric.body?.id === generic.body.id, JSON.stringify(resolveGeneric.body));

    const resolveNone = await request("GET", `/api/document-templates/resolve?docType=MB01&officeId=${officeId}&carrierCode=MAEU`, null, token);
    assert("resolve returns null for a doc type with no templates at all", resolveNone.body === null, JSON.stringify(resolveNone.body));

    console.log("\nUpdate a template's fields");
    const updated = await request("PUT", `/api/document-templates/${exact.body.id}`, {
      name: exact.body.name, pageSize: "A4",
      fields: [{ id: "f1", x: 5, y: 5, width: 50, height: 15, type: "text", source: "static", text: "Hello" }],
    }, token);
    assert("update returns 200", updated.status === 200, JSON.stringify(updated.body));
    assert("updated fields persisted", updated.body.fields[0].text === "Hello");

    console.log("\nList returns all created templates");
    const list = await request("GET", "/api/document-templates", null, token);
    const ids = list.body.map(t => t.id);
    assert("list includes all 3 templates", [generic.body.id, officeOnly.body.id, exact.body.id].every(id => ids.includes(id)));

    console.log("\nDelete the exact template, resolve now falls back to office-only");
    await request("DELETE", `/api/document-templates/${exact.body.id}`, null, token);
    const resolveAfterDelete = await request("GET", `/api/document-templates/resolve?docType=BL01&officeId=${officeId}&carrierCode=MAEU`, null, token);
    assert("resolve falls back to office-only after the exact template is deleted", resolveAfterDelete.body?.id === officeOnly.body.id, JSON.stringify(resolveAfterDelete.body));

    console.log("\nCleanup");
    await request("DELETE", `/api/document-templates/${generic.body.id}`, null, token);
    await request("DELETE", `/api/document-templates/${officeOnly.body.id}`, null, token);

    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
  } catch (e) {
    console.error("\nFatal:", e.message);
    process.exit(1);
  }
})();
