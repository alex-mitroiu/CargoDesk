/**
 * The House B/L as a DCSA transport document (Epic TKT-C7EBU3; plan https://claude.ai/artifact/FF9eMZXXMLHdJkCk5abaoU,
 * high-importance gaps, 2026-10-21; lib/house-bl.js):
 *   - G10 packages on containers: count, UN/ECE Rec. 21 code, description; a whole-row save that leaves
 *     them out keeps them;
 *   - G23 the House transport document: DRAFT when a BL01 draft is generated, ISSUED on confirm with
 *     issue date, place of issue, the DCSA TransportDocument (checked against eBL 3.0) and the B/L number
 *     written to the shipment;
 *   - G4 readiness: issue is refused with the list of what is missing;
 *   - G8 shipped on board (from the Loaded event, or a typed date) or received for shipment (decision D2);
 *   - G19 release: blocked until the originals are surrendered, collect charges are paid and the
 *     consignee isn't on credit hold; an admin may override with a reason (decision D3); the Delivery
 *     Order waits for release; release completes Cargo Released.
 *
 * Usage:
 *   node tests/house-bl-record.test.js
 *
 * Prerequisites:
 *   - Express server on :3001 and the pdf-render service on :3003
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations (seeded MDM data)
 */

import { readyHouseBlShipment, generateHouseBl } from "./helpers/house-bl.mjs";

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
const today = new Date().toISOString().slice(0, 10);

(async () => {
  const cleanup = { shipments: [], customers: [] };
  let token;
  const track = r => { cleanup.shipments.push(r.shipment.id); cleanup.customers.push(r.shipper.id, r.consignee.id); return r; };
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const house = async id => (await request("GET", `/api/shipments/${id}/house-bl`, null, token)).body;
    const confirm = (shipmentId, docId) => request("PATCH", `/api/shipments/${shipmentId}/documents/${docId}`, { status: "confirmed" }, token);

    console.log("\nG10 — packages on containers");
    const a = track(await readyHouseBlShipment(request, token, { tag: "A" }));
    assert("a container is created with 1,200 cartons", a.container.numberOfPackages === 1200 && a.container.packageCode === "CT" && a.container.packageDescription === "Carton",
      JSON.stringify(a.container));
    const putBody = { containerNumber: a.container.containerNumber, sealNumber: a.container.sealNumber, size: "40", type: "HC", hsCode: "940360",
      cargoDescription: a.container.cargoDescription, marksAndNumbers: a.container.marksAndNumbers, grossWeightKg: 18400, volumeCbm: 64 };
    const kept = await request("PUT", `/api/shipments/${a.shipment.id}/containers/${a.container.id}`, putBody, token);
    assert("a whole-row save without the package fields keeps them", kept.body?.numberOfPackages === 1200 && kept.body?.packageCode === "CT", JSON.stringify(kept.body));
    const pallets = await request("PUT", `/api/shipments/${a.shipment.id}/containers/${a.container.id}`, { ...putBody, packageCode: "PX", numberOfPackages: 24 }, token);
    assert("changing the code takes that code's description", pallets.body?.packageCode === "PX" && pallets.body?.packageDescription === "Pallet" && pallets.body?.numberOfPackages === 24,
      JSON.stringify(pallets.body));
    const badCode = await request("PUT", `/api/shipments/${a.shipment.id}/containers/${a.container.id}`, { ...putBody, packageCode: "ZZ" }, token);
    assert("an unknown package code is refused (400)", badCode.status === 400 && /UN\/ECE/.test(badCode.body?.error), JSON.stringify(badCode.body));
    const zero = await request("PUT", `/api/shipments/${a.shipment.id}/containers/${a.container.id}`, { ...putBody, numberOfPackages: 0 }, token);
    assert("zero packages is refused (400)", zero.status === 400, JSON.stringify(zero.body));
    await request("PUT", `/api/shipments/${a.shipment.id}/containers/${a.container.id}`, { ...putBody, packageCode: "CT", numberOfPackages: 1200 }, token);

    console.log("\nG23 — the House transport document: draft, then issued");
    const draftDoc = await generateHouseBl(request, token, a.shipment.id, { name: "A", houseBl: { shippedOnBoard: true } });
    assert("draft generated", draftDoc.status === 201, JSON.stringify(draftDoc.body));
    let h = await house(a.shipment.id);
    assert("the shipment has a House draft pointing at the PDF", h.draft?.status === "DRAFT" && h.draft.documentId === draftDoc.body.id, JSON.stringify(h.draft));
    assert("the draft says shipped on board, dated by the Loaded event", h.draft.isShippedOnBoardType && h.draft.shippedOnBoardDate === today && h.draft.onBoardSource === "Loaded event",
      JSON.stringify(h.draft));
    assert("readiness: nothing missing", h.readiness?.ready === true, JSON.stringify(h.readiness));
    const issued = await confirm(a.shipment.id, draftDoc.body.id);
    assert("issue (confirm) returns 200", issued.status === 200, JSON.stringify(issued.body));
    h = await house(a.shipment.id);
    const td = h.live;
    assert("the House B/L is ISSUED, the draft gone", td?.status === "ISSUED" && !h.draft, JSON.stringify(h.documents.map(d => d.status)));
    assert("issue date today, place of issue from the export office, type BOL", td.issueDate === today && td.typeCode === "BOL" && td.releaseType === "Original", JSON.stringify(td));
    assert("the DCSA document was kept", td.hasPayload, JSON.stringify(td));
    const shp = (await request("GET", `/api/shipments/${a.shipment.id}`, null, token)).body;
    assert("the B/L number is now on the shipment", shp.blNumber === td.reference && !!td.reference, `${shp.blNumber} vs ${td.reference}`);
    const dcsa = (await request("GET", `/api/shipments/${a.shipment.id}/house-bl/${td.id}/dcsa`, null, token)).body;
    const doc = dcsa.document;
    assert("DCSA: reference, ISSUED, BOL, shipped on board today", doc.transportDocumentReference === td.reference && doc.transportDocumentStatus === "ISSUED"
      && doc.transportDocumentTypeCode === "BOL" && doc.isShippedOnBoardType === true && doc.shippedOnBoardDate === today, JSON.stringify(doc).slice(0, 300));
    const ci = doc.consignmentItems?.[0];
    assert("DCSA: 1,200 cartons, HS 940360, the carrier booking number", ci?.cargoItems?.[0]?.outerPackaging?.numberOfPackages === 1200
      && ci.cargoItems[0].outerPackaging.packageCode === "CT" && ci.HSCodes?.[0] === "940360" && ci.carrierBookingReference === shp.bookingRef, JSON.stringify(ci));
    const ute = doc.utilizedTransportEquipments?.[0];
    assert("DCSA: the container as 45G1 with its seal", ute?.equipment?.ISOEquipmentCode === "45G1" && ute.seals?.[0]?.number === a.container.sealNumber, JSON.stringify(ute));
    assert("DCSA: the consignee carries its LEI", doc.documentParties?.consignee?.identifyingCodes?.[0]?.codeListProvider === "GLEIF", JSON.stringify(doc.documentParties?.consignee));
    assert("DCSA: the spec check names only the issuing entity's details, if anything", !dcsa.errors || /carrierCode|issuingParty/.test(dcsa.errors), dcsa.errors);
    const msIssued = (await request("GET", `/api/shipments/${a.shipment.id}/milestones`, null, token)).body || [];
    assert("B/L Issued completed", msIssued.some(m => m.milestoneKey === "bl_issued" && !!m.completedAt), JSON.stringify(msIssued.map(m => [m.milestoneKey, !!m.completedAt])));
    const events = (await request("GET", `/api/shipments/${a.shipment.id}/house-bl/${td.id}/events`, null, token)).body;
    assert("history: DRAFTED, then ISSUED", events.map(e => e.eventType).join(",") === "DRAFTED,ISSUED", JSON.stringify(events.map(e => e.eventType)));

    console.log("\nG4 — readiness: issue is refused with what is missing");
    const b = track(await readyHouseBlShipment(request, token, { tag: "B" }));
    await request("PUT", `/api/shipments/${b.shipment.id}/containers/${b.container.id}`, { ...putBody, containerNumber: b.container.containerNumber,
      sealNumber: "", numberOfPackages: null, packageCode: "" }, token);
    const bDraft = await generateHouseBl(request, token, b.shipment.id);
    const bIssue = await confirm(b.shipment.id, bDraft.body.id);
    assert("issue refused (409)", bIssue.status === 409, JSON.stringify(bIssue.body));
    assert("…naming the container's seal number, number and kind of packages", /seal number/.test(bIssue.body?.error) && /number of packages/.test(bIssue.body?.error)
      && /kind of packages/.test(bIssue.body?.error), bIssue.body?.error);
    const bHouse = await house(b.shipment.id);
    assert("the summary lists the same", bHouse.readiness?.ready === false && bHouse.readiness.missing.some(m => /seal number/.test(m)), JSON.stringify(bHouse.readiness));

    console.log("\nG8 — shipped on board or received for shipment");
    const c = track(await readyHouseBlShipment(request, token, { tag: "C", loaded: false }));
    const cOld = await generateHouseBl(request, token, c.shipment.id, { name: "OLD" });
    const cOldIssue = await confirm(c.shipment.id, cOld.body.id);
    assert("a draft printed the old way (always shipped on board) can't be issued before loading", cOldIssue.status === 409 && /Loading/.test(cOldIssue.body?.error),
      JSON.stringify(cOldIssue.body));
    const future = await generateHouseBl(request, token, c.shipment.id, { name: "FUT", houseBl: { shippedOnBoard: true, onBoardDate: "2099-01-01", onBoardDateTyped: true } });
    assert("a typed on-board date in the future is refused (400)", future.status === 400, JSON.stringify(future.body));
    const rfs = await generateHouseBl(request, token, c.shipment.id, { name: "RFS", houseBl: { shippedOnBoard: false } });
    const rfsIssue = await confirm(c.shipment.id, rfs.body.id);
    assert("a Received for shipment draft is issued before loading", rfsIssue.status === 200, JSON.stringify(rfsIssue.body));
    const cTd = (await house(c.shipment.id)).live;
    assert("…recorded as received for shipment, dated today", cTd?.isShippedOnBoardType === false && cTd.receivedForShipmentDate === today && !cTd.shippedOnBoardDate,
      JSON.stringify(cTd));
    const d = track(await readyHouseBlShipment(request, token, { tag: "D", loaded: false }));
    const typed = await generateHouseBl(request, token, d.shipment.id, { name: "TYP", houseBl: { shippedOnBoard: true, onBoardDate: today, onBoardDateTyped: true } });
    const typedIssue = await confirm(d.shipment.id, typed.body.id);
    const dTd = (await house(d.shipment.id)).live;
    assert("a typed on-board date issues as shipped on board, source Typed", typedIssue.status === 200 && dTd?.shippedOnBoardDate === today && dTd.onBoardSource === "Typed",
      JSON.stringify(dTd));

    console.log("\nG19 — release at destination");
    const docs = async id => (await request("GET", `/api/shipments/${id}/documents`, null, token)).body;
    const blDocOf = async id => (await docs(id)).find(x => x.docType === "BL01" && x.status === "confirmed");
    const aBl = await blDocOf(a.shipment.id);
    const relEarly = await request("PATCH", `/api/shipments/${a.shipment.id}/documents/${aBl.id}/bl-release`, {}, token);
    assert("release before the originals are surrendered is refused (409)", relEarly.status === 409 && relEarly.body?.blocks?.some(x => x.key === "originals"), JSON.stringify(relEarly.body));
    const doEarly = await request("POST", `/api/shipments/${a.shipment.id}/documents/generate`, { html: "<html><body>DO</body></html>", filename: "DO01-early.html", docType: "DO01" }, token);
    assert("the Delivery Order waits for release (409)", doEarly.status === 409 && /Release the cargo/.test(doEarly.body?.error), JSON.stringify(doEarly.body));
    const surr = await request("PATCH", `/api/shipments/${a.shipment.id}/documents/${aBl.id}/bl-surrender`, {}, token);
    assert("the originals are recorded as presented at destination", surr.status === 200 && (await house(a.shipment.id)).live?.status === "SURRENDERED_FOR_DELIVERY",
      JSON.stringify(surr.body));
    const rel = await request("PATCH", `/api/shipments/${a.shipment.id}/documents/${aBl.id}/bl-release`, {}, token);
    const aTd = (await house(a.shipment.id)).live;
    assert("then the release goes through, recorded on the House B/L", rel.status === 200 && !!aTd?.releasedAt && !aTd.releaseOverrideReason, JSON.stringify(rel.body));
    const ms = (await request("GET", `/api/shipments/${a.shipment.id}/milestones`, null, token)).body || [];
    assert("Cargo Released completed", ms.some(m => m.milestoneKey === "cargo_released" && !!m.completedAt), JSON.stringify(ms.map(m => [m.milestoneKey, !!m.completedAt])));
    const doOk = await request("POST", `/api/shipments/${a.shipment.id}/documents/generate`, { html: "<html><body>DO</body></html>", filename: "DO01-ok.html", docType: "DO01" }, token);
    assert("the Delivery Order can be generated now", doOk.status === 201, JSON.stringify(doOk.body));

    // A collect shipment on a telex release, its consignee on credit hold.
    const e = track(await readyHouseBlShipment(request, token, { tag: "E", releaseType: "Telex Release", freightTerms: "Collect" }));
    await request("POST", `/api/shipments/${e.shipment.id}/cost-lines`, { type: "SELL", chargeCode: "OFR", amount: 2150, currency: "USD", paymentIndicator: "Collect" }, token);
    const eDraft = await generateHouseBl(request, token, e.shipment.id, { houseBl: { shippedOnBoard: true } });
    await confirm(e.shipment.id, eDraft.body.id);
    const eBl = await blDocOf(e.shipment.id);
    await request("PATCH", `/api/shipments/${e.shipment.id}/documents/${eBl.id}/bl-surrender`, {}, token);
    await request("PUT", `/api/customers/${e.consignee.id}`, { ...e.consignee, creditHold: true, creditHoldReason: "Overdue balance" }, token);
    const eRel = await request("PATCH", `/api/shipments/${e.shipment.id}/documents/${eBl.id}/bl-release`, {}, token);
    const keys = (eRel.body?.blocks || []).map(x => x.key).sort().join(",");
    assert("release refused for unpaid collect charges and the credit hold", eRel.status === 409 && keys === "collect_charges,credit_hold", JSON.stringify(eRel.body));
    assert("…the collect line is named as not invoiced", /OFR \(not invoiced\)/.test(eRel.body?.error), eRel.body?.error);
    const noReason = await request("PATCH", `/api/shipments/${e.shipment.id}/documents/${eBl.id}/bl-release`, { override: true }, token);
    assert("an override needs a reason (400)", noReason.status === 400, JSON.stringify(noReason.body));
    const over = await request("PATCH", `/api/shipments/${e.shipment.id}/documents/${eBl.id}/bl-release`, { override: true, overrideReason: "Consignee paid by wire, confirmed by phone" }, token);
    const eTd = (await house(e.shipment.id)).live;
    assert("an admin override releases it, reason kept", over.status === 200 && eTd?.releaseOverrideReason === "Consignee paid by wire, confirmed by phone", JSON.stringify(eTd));
    const eEvents = (await request("GET", `/api/shipments/${e.shipment.id}/house-bl/${eTd.id}/events`, null, token)).body;
    const ovr = eEvents.find(x => x.eventType === "RELEASED_WITH_OVERRIDE");
    assert("history names what was overridden", ovr && ovr.detail.overridden.sort().join(",") === "collect_charges,credit_hold", JSON.stringify(ovr));
    await request("PUT", `/api/customers/${e.consignee.id}`, { ...e.consignee, creditHold: false, creditHoldReason: "" }, token);
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
