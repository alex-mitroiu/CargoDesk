/**
 * House B/L issue rules (Epic TKT-C7EBU3, Story 1 TKT-E8R1UF; plan https://claude.ai/artifact/FF9eMZXXMLHdJkCk5abaoU,
 * 2026-10-21). The House B/L (BL01) is a document of title, so once issued (confirmed) it only moves forward:
 *   - an issued House B/L can't be deleted or set back to draft; it is voided with a reason instead;
 *   - a voided one stays voided and can't be deleted;
 *   - a shipment has at most one issued House B/L (also a partial unique index);
 *   - a regenerated draft replaces the earlier drafts, and a carrier booking linked to one follows it;
 *   - other document types keep their rules (a confirmed packing list can still be deleted).
 *
 * Usage:
 *   node tests/house-bl-issue-rules.test.js
 *
 * Prerequisites:
 *   - Express server on :3001 and the pdf-render service on :3003
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations (seeded MDM data)
 */

import { readyHouseBlShipment } from "./helpers/house-bl.mjs";

const BASE = "http://localhost:3001";
let passed = 0, failed = 0;

async function request(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    ...(body !== undefined && body !== null && { body: JSON.stringify(body) }),
  });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
}
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
const html = title => `<!doctype html><html><body><h1>${title}</h1><p>House B/L issue rules test fixture</p></body></html>`;

(async () => {
  const cleanup = { shipments: [], customers: [] };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    // Complete data, the booking confirmed by the carrier and the container loaded: issue readiness
    // (Epic TKT-C7EBU3) refuses anything less.
    const ready = await readyHouseBlShipment(request, token, { tag: "IR" });
    const shp = ready.shipment;
    cleanup.shipments.push(shp.id);
    cleanup.customers.push(ready.shipper.id, ready.consignee.id);
    const docs = async () => (await request("GET", `/api/shipments/${shp.id}/documents`, null, token)).body || [];
    const houseBls = async () => (await docs()).filter(d => d.docType === "BL01");
    const generate = (docType, title) => request("POST", `/api/shipments/${shp.id}/documents/generate`,
      { html: html(title), filename: `${docType}-${rand}-${title}.html`, docType }, token);
    const patch = (id, body) => request("PATCH", `/api/shipments/${shp.id}/documents/${id}`, body, token);
    const del = id => request("DELETE", `/api/shipments/${shp.id}/documents/${id}`, null, token);

    console.log("\nA regenerated draft replaces the earlier draft");
    const a = await generate("BL01", "A");
    assert("draft A generated", a.status === 201, JSON.stringify(a.body));
    assert("the carrier confirmed the booking", ready.booking?.status === "Confirmed", JSON.stringify(ready.booking));
    // The booking's B/L is the carrier's Master (gap G22): a House draft can't be linked to it.
    const link = await request("PATCH", `/api/shipments/${shp.id}/carrier-booking/link-bl-document`, { documentId: a.body.id }, token);
    assert("the booking refuses House draft A (400)", link.status === 400 && /Master Bill of Lading/.test(link.body?.error), JSON.stringify(link.body));
    const b = await generate("BL01", "B");
    assert("draft B generated", b.status === 201, JSON.stringify(b.body));
    let bls = await houseBls();
    assert("only draft B is left", bls.length === 1 && bls[0].id === b.body.id, JSON.stringify(bls.map(d => [d.id, d.status])));
    const aEvents = (await request("GET", `/api/entity-events/document/${a.body.id}`, null, token)).body || [];
    assert("draft A's history says it was replaced by B", aEvents.some(e => e.eventType === "REPLACED" && JSON.stringify(e).includes(b.body.id)),
      JSON.stringify(aEvents.map(e => e.eventType)));

    console.log("\nAn issued House B/L only moves forward");
    const issue = await patch(b.body.id, { status: "confirmed" });
    assert("B is issued", issue.status === 200 && issue.body.status === "confirmed", JSON.stringify(issue.body));
    const delIssued = await del(b.body.id);
    assert("deleting issued B is refused (409)", delIssued.status === 409 && /void it with a reason/.test(delIssued.body?.error), JSON.stringify(delIssued.body));
    const toDraft = await patch(b.body.id, { status: "draft" });
    assert("setting issued B back to draft is refused (409)", toDraft.status === 409 && /can't go back to draft/.test(toDraft.body?.error), JSON.stringify(toDraft.body));

    console.log("\nOne issued House B/L per shipment");
    const c = await generate("BL01", "C");
    assert("draft C generated next to issued B", c.status === 201, JSON.stringify(c.body));
    bls = await houseBls();
    assert("issued B is untouched by the new draft", bls.some(d => d.id === b.body.id && d.status === "confirmed"), JSON.stringify(bls.map(d => [d.id, d.status])));
    const issueC = await patch(c.body.id, { status: "confirmed" });
    assert("issuing C while B is issued is refused (409)", issueC.status === 409 && /already has an issued House B\/L/.test(issueC.body?.error), JSON.stringify(issueC.body));

    console.log("\nVoiding needs a reason, and a voided House B/L stays voided");
    const voidBare = await patch(b.body.id, { status: "voided" });
    assert("voiding issued B without a reason is refused (400)", voidBare.status === 400 && /reason/.test(voidBare.body?.error), JSON.stringify(voidBare.body));
    const voided = await patch(b.body.id, { status: "voided", voidReason: "Consignee address wrong" });
    assert("B is voided with a reason", voided.status === 200 && voided.body.status === "voided", JSON.stringify(voided.body));
    const bEvents = (await request("GET", `/api/entity-events/document/${b.body.id}`, null, token)).body || [];
    assert("B's history keeps the reason", bEvents.some(e => e.eventType === "VOIDED" && JSON.stringify(e).includes("Consignee address wrong")),
      JSON.stringify(bEvents.map(e => e.eventType)));
    const reissue = await patch(b.body.id, { status: "confirmed" });
    assert("issuing voided B again is refused (409)", reissue.status === 409 && /stays voided/.test(reissue.body?.error), JSON.stringify(reissue.body));
    const delVoided = await del(b.body.id);
    assert("deleting voided B is refused (409)", delVoided.status === 409 && /stays as the record/.test(delVoided.body?.error), JSON.stringify(delVoided.body));
    const issueC2 = await patch(c.body.id, { status: "confirmed" });
    assert("with B voided, C can be issued", issueC2.status === 200 && issueC2.body.status === "confirmed", JSON.stringify(issueC2.body));

    console.log("\nA draft can still be deleted, and other document types keep their rules");
    const d = await generate("BL01", "D");
    const delDraft = await del(d.body.id);
    assert("a House B/L draft can be deleted", delDraft.status === 200, JSON.stringify(delDraft.body));
    const pl = await generate("PL01", "P");
    await patch(pl.body.id, { status: "confirmed" });
    const backPl = await patch(pl.body.id, { status: "draft" });
    assert("a confirmed packing list can still go back to draft", backPl.status === 200 && backPl.body.status === "draft", JSON.stringify(backPl.body));
    await patch(pl.body.id, { status: "confirmed" });
    const delPl = await del(pl.body.id);
    assert("a confirmed packing list can still be deleted", delPl.status === 200, JSON.stringify(delPl.body));
    bls = await houseBls();
    assert("the shipment ends with voided B and issued C", bls.length === 2
      && bls.some(x => x.id === b.body.id && x.status === "voided") && bls.some(x => x.id === c.body.id && x.status === "confirmed"),
      JSON.stringify(bls.map(x => [x.id, x.status])));

    console.log("\nTwo House B/Ls issued at the same moment: one wins");
    await patch(c.body.id, { status: "voided", voidReason: "Race test" });
    // Uploaded (not generated) drafts don't replace each other, so two can stand side by side.
    const upload = name => request("POST", `/api/shipments/${shp.id}/documents`,
      { filename: `BL01-${rand}-${name}.pdf`, mimeType: "application/pdf", docType: "BL01", data: Buffer.from(`%PDF-1.4 ${name}`).toString("base64") }, token);
    const e1 = (await upload("E")).body, f1 = (await upload("F")).body;
    const race = await Promise.all([patch(e1.id, { status: "confirmed" }), patch(f1.id, { status: "confirmed" })]);
    const codes = race.map(r => r.status).sort();
    assert("exactly one is issued, the other refused (200 + 409)", codes[0] === 200 && codes[1] === 409, JSON.stringify(race.map(r => [r.status, r.body?.error])));
    bls = await houseBls();
    assert("the shipment holds one issued House B/L", bls.filter(x => x.status === "confirmed").length === 1, JSON.stringify(bls.map(x => [x.id, x.status])));
  } catch (e) {
    console.error("Unexpected error:", e);
    failed++;
  } finally {
    if (token) {
      for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
      for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
