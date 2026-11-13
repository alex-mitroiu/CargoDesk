/**
 * A shipment as one JSON file for QA, imported into a test system (2026-11-13, lib/shipment-transfer.js, ARCHITECTURE.md
 * §8.50):
 *   - admins only, both ways; the export lists what it will hold, then gives the file with the report (what went wrong,
 *     the steps) and a summary, every record as stored, the customers in full and the documents' bytes;
 *   - a closed (Completed) shipment exports like any other;
 *   - the import refuses what isn't an export, a file from a newer CargoDesk, an export or import office this system
 *     doesn't have until one is chosen; matches customers by LEI/VAT/EORI or name, else creates a copy;
 *   - the imported shipment: a new id, marked IMPORTED with where it came from and the report, its records and files
 *     the same, its history plus "Imported"; importing the same file again gives another one;
 *   - it sends nothing: the booking request, Shipping Instructions, the carrier booking's check, vessel times, sending a
 *     document by email and a VGM change that needs the carrier are refused (409 IMPORTED_SHIPMENT); local work goes on.
 *
 * Usage:
 *   node tests/shipment-transfer.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001 (+ pdf-render on :3003), not in production (the built-in DCSA carrier confirms,
 *     and imports are allowed)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { readyHouseBlShipment, generateHouseBl } from "./helpers/house-bl.mjs";

const BASE = "http://localhost:3001";
let passed = 0, failed = 0;

async function request(method, path, body, token, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }), ...headers },
    ...(body !== undefined && body !== null && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
const list = b => (Array.isArray(b) ? b : (b?.results ?? []));
const clone = o => JSON.parse(JSON.stringify(o));

(async () => {
  const cleanup = { users: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;

    // A complete shipment: booked by the demo carrier, its container loaded, a House B/L issued (a document with its
    // file), a charge, a message.
    const a = await readyHouseBlShipment(request, token, { tag: "QA" });
    const sid = a.shipment.id;
    const hbl = await generateHouseBl(request, token, sid, { name: "QA", houseBl: { shippedOnBoard: true } });
    const issued = await request("PATCH", `/api/shipments/${sid}/documents/${hbl.body?.id}`, { status: "confirmed" }, token);
    assert("(setup) a House B/L issued on the shipment", issued.status === 200, JSON.stringify(issued.body).slice(0, 200));
    await request("POST", `/api/shipments/${sid}/cost-lines`, { type: "SELL", chargeCode: "OFR", currency: "USD", amount: 2450, exchangeRate: 1, paymentIndicator: "Prepaid" }, token);
    await request("POST", `/api/shipments/${sid}/messages`, { body: "Shipper asks to hold the originals until payment clears." }, token);

    console.log("\nAdmins only");
    const opEmail = `qa.operator.${rand.toLowerCase()}@cargodesk.example`;
    const op = await request("POST", "/api/users", { email: opEmail, name: "QA export operator", roles: ["operator"], password: "QaFixture!2026Zq" }, token);
    cleanup.users.push(op.body?.id);
    const opToken = (await request("POST", "/api/auth/login", { email: opEmail, password: "QaFixture!2026Zq" })).body?.token;
    assert("an operator can't export (403)", (await request("POST", `/api/shipments/${sid}/qa-export`, {}, opToken)).status === 403);
    assert("…nor import (403)", (await request("POST", "/api/shipment-import/preview", { file: {} }, opToken)).status === 403);
    assert("…nor turn imports on (403)", (await request("PUT", "/api/settings", { shipment_import_enabled: "true" }, opToken)).status === 403);

    console.log("\nThe export");
    const contents = (await request("GET", `/api/shipments/${sid}/qa-export`, null, token)).body;
    const part = t => contents.parts?.find(p => p.table === t)?.count || 0;
    assert("it lists what it will hold: containers, the carrier booking, documents, the charge, the history",
      part("containers") === 1 && part("carrier_bookings") === 1 && part("shipment_documents") >= 1 && part("shipment_cost_lines") >= 1 && part("shipment_events") > 3
        && contents.files.length >= 1 && contents.estimatedBytes > 1000, JSON.stringify(contents.parts));
    const exp = await request("POST", `/api/shipments/${sid}/qa-export`, {
      whatWentWrong: "The House B/L prints the consignee's old address after the address was corrected.",
      steps: "1. Open the shipment → Documents\n2. Issue the House B/L\n3. Open the PDF" }, token);
    const file = exp.body;
    assert("the file comes as a download named after the shipment", exp.status === 200
      && new RegExp(`attachment; filename="${sid}-for-QA-\\d{4}-\\d{2}-\\d{2}\\.json"`).test(exp.headers.get("content-disposition") || ""), exp.headers.get("content-disposition"));
    assert("it is a versioned export from this system, with the report and its steps",
      file.format === "cargodesk-shipment-export/1" && /^\d+\.\d+\.\d+/.test(file.cargodeskVersion) && file.source?.shipmentId === sid
        && file.report?.whatWentWrong?.startsWith("The House B/L prints") && file.report.stepsToReproduce.length === 3 && file.report.stepsToReproduce[0] === "Open the shipment → Documents",
      JSON.stringify({ f: file.format, v: file.cargodeskVersion, r: file.report }));
    assert("…a plain-language summary first: the route, the parties, the problem and the steps",
      file.summary.includes(sid) && file.summary.includes("NLRTM → USNYC") && file.summary.includes(a.shipper.companyName) && file.summary.includes("What went wrong: The House B/L prints")
        && file.summary.includes("Steps to reproduce: 1. Open the shipment"), file.summary.slice(0, 300));
    assert("…every record as stored, the shipment's own id in them",
      file.shipment.id === sid && file.sections.containers?.[0]?.shipment_id === sid && file.sections.carrier_bookings?.[0]?.status === "Confirmed"
        && (file.sections.transport_documents || []).some(t => t.role === "HOUSE" && t.status === "ISSUED"), Object.keys(file.sections).join(","));
    const cons = file.references.customers.find(c => c.id === a.consignee.id);
    assert("…the customers in full, with their identifiers", file.references.customers.length >= 2 && cons?.record?.companyName === a.consignee.companyName
      && cons.identifiers.some(i => i.idType === "LEI") && cons.roles.includes("Consignee"), JSON.stringify(cons).slice(0, 200));
    const docFile = file.files.find(f => f.documentId === hbl.body.id);
    const original = Buffer.from(await (await fetch(`${BASE}/api/shipments/${sid}/documents/${hbl.body.id}/download`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer());
    assert("…and the documents' bytes", !!docFile?.base64 && Buffer.from(docFile.base64, "base64").equals(original), `${docFile?.filename} ${docFile?.base64?.length}`);

    console.log("\nThe import refuses what it can't take");
    let r = await request("POST", "/api/shipment-import/preview", { file: { hello: "world" } }, token);
    assert("a file that isn't an export", r.status === 200 && /isn't a CargoDesk shipment export/.test(r.body.problems?.[0]), JSON.stringify(r.body));
    const newer = clone(file); newer.cargodeskVersion = "99.0.0";
    r = await request("POST", "/api/shipment-import", { file: newer }, token);
    assert("a file from a newer CargoDesk (409)", r.status === 409 && /newer than this system/.test(r.body.error), JSON.stringify(r.body).slice(0, 200));
    // As if this system didn't have the export office, nor the consignee.
    const elsewhere = clone(file);
    const exportRef = elsewhere.references.offices.find(o => o.roles.includes("export"));
    exportRef.code = `XX-XQ${rand.slice(0, 3)}-SE`;
    const consRef = elsewhere.references.customers.find(c => c.id === a.consignee.id);
    const newName = `Hudson Home Imports QA ${rand} Inc`;
    consRef.record.companyName = newName; consRef.name = newName;
    consRef.identifiers = consRef.identifiers.map(i => (i.idType === "LEI" ? { ...i, idCode: `5493009QA${rand}${String(Date.now()).slice(-7)}` } : i));
    r = await request("POST", "/api/shipment-import/preview", { file: elsewhere }, token);
    const plan = r.body.plan;
    assert("an export office this system doesn't have must be chosen", r.body.problems?.some(x => /export office XX-XQ/.test(x))
      && plan.offices.find(o => o.role === "export")?.found === null && plan.officeChoices.export.length > 0, JSON.stringify(r.body.problems));
    assert("customers: the shipper found by name, the unknown consignee to be created",
      plan.customers.find(c => c.oldId === a.shipper.id)?.match?.by === "same name" && plan.customers.find(c => c.oldId === a.consignee.id)?.match === null,
      JSON.stringify(plan.customers.map(c => [c.name, c.match?.by || "new"])));
    r = await request("POST", "/api/shipment-import", { file: elsewhere }, token);
    assert("…importing without choosing is refused (409), nothing saved", r.status === 409 && /choose one of its export offices/.test(r.body.error), r.body.error);

    console.log("\nImported as a new shipment");
    const pickExport = a.emoOfficeId;
    r = await request("POST", "/api/shipment-import", { file: elsewhere, officeMap: { export: pickExport } }, token);
    const newId = r.body?.shipmentId;
    assert("imported (201) under a new id, the consignee created", r.status === 201 && /^SHP-/.test(newId) && newId !== sid
      && r.body.createdCustomers.some(c => c.name === newName), JSON.stringify(r.body).slice(0, 300));
    const imp = (await request("GET", `/api/shipments/${newId}`, null, token)).body;
    assert("marked IMPORTED: where it came from and the report", imp.importedFrom === sid && imp.importedMeta?.report?.whatWentWrong?.startsWith("The House B/L prints")
      && imp.importedMeta.report.stepsToReproduce.length === 3 && imp.importedMeta.exportedBy?.email === "claudeagent@localhost", JSON.stringify(imp.importedMeta).slice(0, 200));
    const newCons = list((await request("GET", `/api/customers?search=${encodeURIComponent(newName)}`, null, token)).body).find(c => c.companyName === newName);
    assert("its parties: the shipper this system's own, the consignee the new copy, noted as imported", imp.shipperId === a.shipper.id
      && imp.consigneeId === newCons?.id && /Imported from .* with shipment SHP-/.test(newCons?.notes || ""), JSON.stringify({ s: imp.shipperId, c: imp.consigneeId, notes: newCons?.notes }));
    assert("the export office the one chosen", imp.emoOfficeId === pickExport, imp.emoOfficeId);
    const ctrs = list((await request("GET", "/api/containers", null, token)).body).filter(c => c.shipmentId === newId);
    assert("its container came along", ctrs.length === 1 && ctrs[0].containerNumber === a.container.containerNumber, JSON.stringify(ctrs.map(c => c.containerNumber)));
    const cls = list((await request("GET", `/api/shipments/${newId}/cost-lines`, null, token)).body);
    assert("…its charges", cls.some(l => l.chargeCode === "OFR" && Number(l.amount) === 2450), JSON.stringify(cls.map(l => [l.chargeCode, l.amount])));
    const cb = (await request("GET", `/api/shipments/${newId}/carrier-booking`, null, token)).body;
    assert("…its carrier booking, as it stood", cb?.status === "Confirmed", JSON.stringify(cb).slice(0, 160));
    const hb = (await request("GET", `/api/shipments/${newId}/house-bl`, null, token)).body;
    assert("…its issued House B/L", hb?.live?.status === "ISSUED", JSON.stringify(hb?.live).slice(0, 160));
    const docs = list((await request("GET", `/api/shipments/${newId}/documents`, null, token)).body);
    const newBl = docs.find(d => d.docType === "BL01" && d.status === "confirmed");
    const copied = newBl ? Buffer.from(await (await fetch(`${BASE}/api/shipments/${newId}/documents/${newBl.id}/download`, { headers: { Authorization: `Bearer ${token}` } })).arrayBuffer()) : Buffer.alloc(0);
    assert("…and its documents, byte for byte, under new ids", !!newBl && newBl.id !== hbl.body.id && copied.equals(original), `${newBl?.id} ${copied.length}/${original.length}`);
    const msgs = list((await request("GET", `/api/shipments/${newId}/messages`, null, token)).body);
    assert("…its messages", msgs.some(m => /hold the originals/.test(m.body)), JSON.stringify(msgs.map(m => m.body)));
    const hist = list((await request("GET", `/api/entity-events/shipment/${newId}`, null, token)).body);
    assert("its history: the original events, plus Imported", hist.some(e => e.eventType === "SHIPMENT_IMPORTED" && e.newValue === sid)
      && hist.some(e => e.eventType === "SHIPMENT_CREATED"), JSON.stringify(hist.slice(0, 3).map(e => e.eventType)));
    const listed = list((await request("GET", "/api/shipments", null, token)).body).find(s => s.id === newId);
    assert("the Shipments list knows it is imported", listed?.importedFrom === sid);

    console.log("\nIt sends nothing");
    const refused = async (label, method, path, body = {}) => {
      const x = await request(method, `/api/shipments/${newId}${path}`, body, token);
      assert(`${label}: refused (409 IMPORTED_SHIPMENT)`, x.status === 409 && (x.body?.code === "IMPORTED_SHIPMENT" || /imported shipment: it sends nothing/.test(x.body?.error)),
        `${x.status} ${JSON.stringify(x.body).slice(0, 160)}`);
    };
    await refused("a booking request", "POST", "/edi-messages/booking-request");
    await refused("checking the booking with the carrier", "POST", "/carrier-booking/check-status");
    await refused("submitting Shipping Instructions", "POST", "/shipping-instructions/submit");
    await refused("syncing vessel times", "POST", "/vessel-times/sync");
    await refused("sending a document by email", "POST", `/documents/${newBl?.id}/send-email`, { to: "ops@hudson-home.example" });
    await refused("issuing the House B/L as an eBL", "POST", "/house-bl/issue-ebl", { platform: "WAVE" });
    const vgm = await request("PUT", `/api/shipments/${newId}/containers/${ctrs[0]?.id}`, { ...ctrs[0], vgmWeightKg: 18420, vgmMethod: "Method 1", vgmStatus: "Submitted" }, token);
    assert("a VGM that would go to the carrier: refused (409)", vgm.status === 409 && /imported shipment: it sends nothing/.test(vgm.body?.error), `${vgm.status} ${JSON.stringify(vgm.body).slice(0, 160)}`);
    const msg = await request("POST", `/api/shipments/${newId}/messages`, { body: "QA: reproducing the old-address issue here." }, token);
    assert("local work goes on: a message (201)", msg.status === 201, JSON.stringify(msg.body));

    console.log("\nAgain, and from a closed shipment");
    r = await request("POST", "/api/shipment-import", { file, officeMap: {} }, token);
    assert("the same file imports again under another id (no clashes)", r.status === 201 && r.body.shipmentId !== newId && r.body.shipmentId !== sid, JSON.stringify(r.body).slice(0, 200));
    const done = await request("PUT", `/api/shipments/${sid}`, { status: "Completed" }, token);
    const closed = await request("POST", `/api/shipments/${sid}/qa-export`, { whatWentWrong: "", steps: "" }, token);
    assert("a Completed shipment exports like any other", done.status === 200 && closed.status === 200 && closed.body?.shipment?.status === "Completed",
      `${done.status} ${closed.status}`);
  } catch (e) {
    console.error("\nFatal:", e.stack || e.message);
    failed++;
  } finally {
    // The temporary operator (a known password) goes; the shipments and the customer copy stay as verification data.
    console.log("\nCleanup");
    for (const id of cleanup.users.filter(Boolean)) console.log(`  user: ${(await request("DELETE", `/api/users/${id}`, null, token)).status}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
