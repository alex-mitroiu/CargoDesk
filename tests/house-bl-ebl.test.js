/**
 * The House B/L as an eBL (Epic TKT-C7EBU3, gap G24, decision D4: issuance and surrender through the
 * built-in eBL platform; lib/ebl.js, lib/ebl-platform-simulator.js). Exercises DCSA eBL Issuance 3.0
 * and eBL Surrender 3.0 end to end:
 *   - issue an issued House B/L to the platform with a JWS-signed manifest; the platform verifies it;
 *   - ISSU makes it an eBL; BREQ sends it back to paper with the reason; a Sea Waybill can't be one;
 *   - the holder endorses it; SREQ is answered SURR when the release checks pass (and releases the
 *     cargo) and SREJ when collect charges are unpaid; AREQ surrenders it for amendment;
 *   - the receivers refuse a caller without the platform credential.
 * The export office is a scratch Rotterdam office whose legal entity has an address, a VAT number and a
 * SCAC (a DCSA transport document names its issuing carrier); both are retired afterwards.
 *
 * Usage:
 *   node tests/house-bl-ebl.test.js
 *
 * Prerequisites:
 *   - Express server on :3001 and the pdf-render service on :3003; the built-in DCSA carrier available
 *     (always outside production)
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import { readyHouseBlShipment, generateHouseBl } from "./helpers/house-bl.mjs";
import { retireOffice, retireBranch } from "./helpers/offices.mjs";

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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();

(async () => {
  const cleanup = { shipments: [], customers: [], office: null, branch: null };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;

    // The issuing entity: CargoDesk's Rotterdam legal entity, with its address, VAT number and SCAC.
    const branch = (await request("POST", "/api/branches", { code: `EBL${rand}`, name: `CargoDesk Logistics Rotterdam ${rand} BV`, countryCode: "NL",
      city: "Rotterdam", address: "Wilhelminakade 909", locode: "NLRTM", taxRegistrationNumber: "NL004495445B01", currency: "EUR",
      email: "docs.rotterdam@cargodesk.example", phone: "+31 10 555 0199" }, token)).body;
    cleanup.branch = branch.id;
    const scac = await request("PUT", `/api/branches/${branch.id}`, { scac: "CDLR" }, token);
    assert("the legal entity takes its SCAC", scac.status === 200 && scac.body.scac === "CDLR", JSON.stringify(scac.body));
    // Office codes are country-UN/LOCODE-department and unique, so the scratch office takes its own code.
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    const office = (await request("POST", "/api/offices", { unlocode: `NL${letters}`, countryCode: "NL", department: "SE", name: `Rotterdam Export eBL ${rand}`, branchId: branch.id }, token)).body;
    if (!office?.id) throw new Error(`scratch office not created: ${JSON.stringify(office)}`);
    cleanup.office = office.id;

    const ready = async (tag, opts = {}) => {
      const r = await readyHouseBlShipment(request, token, { tag, emoOfficeId: office.id, ...opts });
      cleanup.shipments.push(r.shipment.id); cleanup.customers.push(r.shipper.id, r.consignee.id);
      return r;
    };
    const issuePaper = async id => {
      const draft = await generateHouseBl(request, token, id, { houseBl: { shippedOnBoard: true } });
      return request("PATCH", `/api/shipments/${id}/documents/${draft.body.id}`, { status: "confirmed" }, token);
    };
    const house = async id => (await request("GET", `/api/shipments/${id}/house-bl`, null, token)).body;
    const live = async id => (await house(id)).live;
    const issueEbl = (id, body = {}) => request("POST", `/api/shipments/${id}/house-bl/issue-ebl`, body, token);
    const act = (ref, action, body = {}) => request("POST", `/api/test-tools/ebl-sim/documents/${encodeURIComponent(ref)}/${action}`, body, token);
    const until = async (fn, ms = 4000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(150); } return v; };

    console.log("\nIssue an issued House B/L as an eBL");
    const a = await ready("A");
    const aIssued = await issuePaper(a.shipment.id);
    assert("the paper House B/L is issued", aIssued.status === 200, JSON.stringify(aIssued.body));
    let td = await live(a.shipment.id);
    const dcsa = (await request("GET", `/api/shipments/${a.shipment.id}/house-bl/${td.id}/dcsa`, null, token)).body;
    assert("its DCSA transport document passes the eBL 3.0 spec", dcsa.errors === "" && dcsa.document.carrierCode === "CDLR"
      && dcsa.document.documentParties.issuingParty.address.city === "Rotterdam", dcsa.errors);
    const noId = await issueEbl(a.shipment.id);
    assert("without the shipper's WAVE id it is refused, saying where to add it", noId.status === 409 && /Customers → Identifiers/.test(noId.body?.error), JSON.stringify(noId.body));
    await request("POST", `/api/customers/${a.shipper.id}/identifiers`, { idType: "WAVE", idCode: `WAVE-VLF-${rand}`, countryIso2: "NL" }, token);
    const sent = await issueEbl(a.shipment.id);
    assert("issued to WAVE: pending the platform's answer", sent.status === 200 && sent.body.isElectronic && sent.body.eblIssuanceStatus === "PENDING"
      && sent.body.eblPlatform === "WAVE" && sent.body.eblIssueTo?.identifyingCodes?.[0]?.partyCode === `WAVE-VLF-${rand}`, JSON.stringify(sent.body));
    const held = (await request("GET", "/api/test-tools/ebl-sim/documents", null, token)).body.find(x => x.transportDocumentReference === td.reference);
    assert("the platform verified the signed manifest and holds it", held?.manifestVerified && held.status === "RECEIVED" && held.actions.join(",") === "ISSU,BREQ,REFU",
      JSON.stringify(held));
    const again = await issueEbl(a.shipment.id);
    assert("a second request while one is pending is refused", again.status === 409 && /already waiting/.test(again.body?.error), JSON.stringify(again.body));
    const issu = await act(td.reference, "ISSU");
    assert("the platform issues it (ISSU)", issu.status === 200, JSON.stringify(issu.body));
    td = await live(a.shipment.id);
    assert("…CargoDesk records the eBL as issued", td.isElectronic && td.eblIssuanceStatus === "ISSU" && !!td.eblRespondedAt, JSON.stringify(td));

    console.log("\nEndorse, then surrender for delivery: SURR releases the cargo");
    const end = await act(td.reference, "endorse", { partyName: a.consignee.companyName, partyCode: `WAVE-HHI-${rand}` });
    assert("the shipper endorses it to the consignee", end.status === 200 && end.body.document.holder.partyName === a.consignee.companyName
      && end.body.document.endorsementChain.map(l => l.actionCode).join(",") === "ISSUE,ENDORSE", JSON.stringify(end.body));
    const sreq = await act(td.reference, "SREQ");
    assert("the consignee asks to surrender for delivery (SREQ accepted by CargoDesk)", sreq.status === 200, JSON.stringify(sreq.body));
    const surrendered = await until(async () => { const t = await live(a.shipment.id); return t?.releasedAt ? t : null; });
    assert("CargoDesk answers SURR: surrendered for delivery, cargo released", surrendered?.status === "SURRENDERED_FOR_DELIVERY" && surrendered.surrenderKind === "platform",
      JSON.stringify(surrendered));
    const onPlatform = await until(async () => { const d = (await request("GET", "/api/test-tools/ebl-sim/documents", null, token)).body.find(x => x.transportDocumentReference === td.reference);
      return d?.lastAnswer ? d : null; });
    assert("the platform got SURR", onPlatform?.lastAnswer === "SURR" && onPlatform.status === "SURRENDERED", JSON.stringify(onPlatform));
    const ms = (await request("GET", `/api/shipments/${a.shipment.id}/milestones`, null, token)).body || [];
    assert("Cargo Released completed", ms.some(m => m.milestoneKey === "cargo_released" && !!m.completedAt));

    console.log("\nUnpaid collect charges: SREQ is rejected (SREJ); AREQ surrenders for amendment");
    const b = await ready("B", { freightTerms: "Collect" });
    await request("POST", `/api/shipments/${b.shipment.id}/cost-lines`, { type: "SELL", chargeCode: "OFR", amount: 2150, currency: "USD", paymentIndicator: "Collect" }, token);
    await issuePaper(b.shipment.id);
    await request("POST", `/api/customers/${b.shipper.id}/identifiers`, { idType: "WAVE", idCode: `WAVE-VLF-B${rand}`, countryIso2: "NL" }, token);
    const bSent = await issueEbl(b.shipment.id);
    const bRef = bSent.body.reference;
    await act(bRef, "ISSU");
    await act(bRef, "SREQ");
    const bRejected = await until(async () => { const d = (await request("GET", "/api/test-tools/ebl-sim/documents", null, token)).body.find(x => x.transportDocumentReference === bRef);
      return d?.lastAnswer ? d : null; });
    assert("CargoDesk answers SREJ, and the platform has it back", bRejected?.lastAnswer === "SREJ" && bRejected.status === "ISSUED", JSON.stringify(bRejected));
    const bTd = await live(b.shipment.id);
    assert("…the House B/L is issued again, not released", bTd?.status === "ISSUED" && !bTd.releasedAt, JSON.stringify(bTd));
    const bEvents = (await request("GET", `/api/shipments/${b.shipment.id}/house-bl/${bTd.id}/events`, null, token)).body;
    const rej = bEvents.find(e => e.eventType === "EBL_SURRENDER_REJECTED");
    assert("…its history says why (collect charges)", rej && /Collect charges/.test(rej.detail.comments), JSON.stringify(rej));
    await act(bRef, "AREQ");
    const bAmend = await until(async () => { const h = await house(b.shipment.id); return h.documents.find(x => x.status === "SURRENDERED_FOR_AMENDMENT"); });
    assert("AREQ: surrendered for amendment", !!bAmend, "");
    assert("…so the shipment has no live House B/L and a new version can be issued", !(await house(b.shipment.id)).live, "");

    console.log("\nThe platform refuses (BREQ); a Sea Waybill isn't an eBL");
    const c = await ready("C");
    await issuePaper(c.shipment.id);
    await request("POST", `/api/customers/${c.shipper.id}/identifiers`, { idType: "WAVE", idCode: `WAVE-VLF-C${rand}`, countryIso2: "NL" }, token);
    const cSent = await issueEbl(c.shipment.id);
    await act(cSent.body.reference, "BREQ", { reason: "Consignee not onboarded on WAVE" });
    const cTd = await live(c.shipment.id);
    assert("BREQ: back to paper, the reason kept", cTd && !cTd.isElectronic && cTd.eblIssuanceStatus === "BREQ" && cTd.eblIssuanceReason === "Consignee not onboarded on WAVE",
      JSON.stringify(cTd));
    const retry = await issueEbl(c.shipment.id);
    assert("…and it can be sent again", retry.status === 200 && retry.body.eblIssuanceStatus === "PENDING", JSON.stringify(retry.body));
    const s = await ready("S", { releaseType: "Seaway Bill" });
    await issuePaper(s.shipment.id);
    const swb = await issueEbl(s.shipment.id, { partyCode: "WAVE-ANY" });
    assert("a Sea Waybill is refused", swb.status === 409 && /Sea Waybill/.test(swb.body?.error), JSON.stringify(swb.body));

    console.log("\nThe receivers need the platform credential");
    const anon = await request("POST", "/api/ebl/v3/ebl-issuance-responses", { transportDocumentReference: "X", issuanceResponseCode: "ISSU" });
    const forged = await fetch(`${BASE}/api/ebl/v3/ebl-surrender-requests`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ surrenderRequestReference: "SR-X", transportDocumentReference: "X", surrenderRequestCode: "SREQ" }) });
    assert("no credential: 401; a CargoDesk login is not the platform's: 401", anon.status === 401 && forged.status === 401, `${anon.status} / ${forged.status}`);
  } catch (e) {
    console.error("Unexpected error:", e);
    failed++;
  } finally {
    if (token) {
      for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
      for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token);
      await retireOffice(token, cleanup.office);
      await retireBranch(token, cleanup.branch);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
