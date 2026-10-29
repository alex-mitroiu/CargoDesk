/**
 * The House B/L audit's fixes (2026-10-29; report https://claude.ai/code/artifact/71144ea4-cd7a-4e3b-b20d-07ad17076ecd).
 *
 *  - H1/M6: an issued House B/L is voided only by an admin, and not while originals are out, an eBL is live,
 *    after a surrender for delivery or after the cargo's release;
 *  - H2: no eBL while paper originals are out;  H3: a live eBL isn't surrendered by hand;
 *  - M5: a telex release at origin needs every original that went out back;  L1: never more out than issued;
 *  - M1: shipped on board once every container is aboard, dated by the last one;
 *  - M2: the issuer's SCAC and address are asked for before issue;
 *  - M3: the House against the carrier's Master B/L;
 *  - M4: the on-board notation on a received-for-shipment B/L;
 *  - L2: the issue date is the issuing office's day;
 *  - L3: the shipper's approval of the draft;  L4: clauses added to the B/L.
 *
 * Usage:
 *   node tests/house-bl-audit-fixes.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001 (not in production), the PDF render service on :3003
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { retireOffice, retireBranch } from "./helpers/offices.mjs";
import { readyHouseBlShipment, generateHouseBl } from "./helpers/house-bl.mjs";

let passed = 0, failed = 0;
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined && body !== null ? JSON.stringify(body) : null;
    const req = http.request({ method, hostname: "localhost", port: 3001, path, headers: {
      "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }),
      ...(payload && { "Content-Length": Buffer.byteLength(payload) }) } }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const cleanup = { shipments: [], customers: [], office: null, branch: null, user: null };
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    // The export office: its own legal entity, complete (SCAC, address, contact), in the Netherlands.
    const branch = (await request("POST", "/api/branches", { code: `HAF${rand}`, name: `CargoDesk Logistics Rotterdam ${rand} BV`, countryCode: "NL",
      city: "Rotterdam", address: "Wilhelminakade 909", locode: "NLRTM", currency: "EUR", taxRegistrationNumber: "NL004495445B01",
      email: "documentation@cargodesk.example", phone: "+31 10 555 0142", scac: "CDLR" }, token)).body;
    cleanup.branch = branch.id;
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    const office = (await request("POST", "/api/offices", { unlocode: `NL${letters}`, countryCode: "NL", department: "SE", name: `Rotterdam Export Audit ${rand}`, branchId: branch.id }, token)).body;
    if (!office?.id) throw new Error(`scratch office not created: ${JSON.stringify(office)}`);
    cleanup.office = office.id;

    const ready = async (tag, opts = {}) => {
      const r = await readyHouseBlShipment(request, token, { tag, emoOfficeId: office.id, ...opts });
      cleanup.shipments.push(r.shipment.id); cleanup.customers.push(r.shipper.id, r.consignee.id);
      return r;
    };
    const draft = (id, houseBl = { shippedOnBoard: true }) => generateHouseBl(request, token, id, { houseBl });
    const patchDoc = (id, docId, body, tok = token) => request("PATCH", `/api/shipments/${id}/documents/${docId}`, body, tok);
    const issue = async (id, houseBl) => { const d = await draft(id, houseBl); const r = await patchDoc(id, d.body.id, { status: "confirmed" }); return { doc: d.body, r }; };
    const house = async id => (await request("GET", `/api/shipments/${id}/house-bl`, null, token)).body;
    const handover = (id, body) => request("POST", `/api/shipments/${id}/house-bl/originals-handover`, body, token);
    const returned = (id, body) => request("POST", `/api/shipments/${id}/house-bl/originals-returned`, body, token);
    const surrender = (id, docId) => request("PATCH", `/api/shipments/${id}/documents/${docId}/bl-surrender`, {}, token);

    // ─── Originals both ways, void, telex release, eBL (H1, H2, M5, M6, L1) ───
    console.log("\nOriginals out and back; what they block");
    const t = await ready("T", { releaseType: "Telex Release" });
    const tIssued = await issue(t.shipment.id);
    assert("(setup) a telex-release House B/L issued in 3 originals", tIssued.r.status === 200 && (await house(t.shipment.id)).live?.originals === 3, JSON.stringify(tIssued.r.body).slice(0, 200));
    const h1 = await handover(t.shipment.id, { to: "Van Leeuwen Furniture BV", method: "Courier", trackingRef: "DHL 4471 0921 55" });
    assert("all 3 originals handed over to the shipper", h1.status === 201 && h1.body.handover.count === 3, JSON.stringify(h1.body));
    const h2 = await handover(t.shipment.id, { to: "Someone else", method: "In person" });
    assert("L1: no more out than were issued (409)", h2.status === 409 && /already out/.test(h2.body?.error), JSON.stringify(h2.body));
    let hb = await house(t.shipment.id);
    assert("the panel sees 3 out, 0 back, and why it can't be voided", hb.originals?.outstanding === 3 && /3 originals are still with Van Leeuwen Furniture BV/.test(hb.voidBlock?.error || ""),
      JSON.stringify({ o: hb.originals, v: hb.voidBlock }));
    const v1 = await patchDoc(t.shipment.id, tIssued.doc.id, { status: "voided", voidReason: "Consignee address wrong" });
    assert("H1: voiding it while the originals are out is refused (409)", v1.status === 409 && /record them returned before voiding/.test(v1.body?.error), JSON.stringify(v1.body));
    // Release audit R1 (2026-10-29): nor can the shipment be deleted with it, which took the House B/L along.
    const del1 = await request("DELETE", `/api/shipments/${t.shipment.id}`, null, token);
    assert("R1: the shipment can't be deleted with an issued House B/L (409, cancel it instead), and the B/L is still there",
      del1.status === 409 && /an issued House B\/L .*Cancel the shipment instead/.test(del1.body?.error) && (await house(t.shipment.id)).originals?.outstanding === 3,
      JSON.stringify(del1.body));
    const s1 = await surrender(t.shipment.id, tIssued.doc.id);
    assert("M5: the surrender at origin is refused while originals are out (409)", s1.status === 409 && /record them returned before the surrender at origin/.test(s1.body?.error), JSON.stringify(s1.body));
    await request("POST", `/api/customers/${t.shipper.id}/identifiers`, { idType: "WAVE", idCode: `WAVE-VLF-${rand}`, countryIso2: "NL" }, token);
    const e1 = await request("POST", `/api/shipments/${t.shipment.id}/house-bl/issue-ebl`, {}, token);
    assert("H2: no eBL while paper originals are out (409)", e1.status === 409 && /paper originals are still with/.test(e1.body?.error), JSON.stringify(e1.body));
    const r1 = await returned(t.shipment.id, { count: 2, method: "In person" });
    assert("2 come back: 1 still out", r1.status === 201 && r1.body.outstanding === 1, JSON.stringify(r1.body));
    const rTooMany = await returned(t.shipment.id, { count: 2 });
    assert("…more back than are out is refused (400)", rTooMany.status === 400, JSON.stringify(rTooMany.body));
    await returned(t.shipment.id, {});
    hb = await house(t.shipment.id);
    assert("the last one back: none out, and the admin may void it now", hb.originals?.outstanding === 0 && hb.originals.back === 3 && hb.voidBlock === null, JSON.stringify({ o: hb.originals, v: hb.voidBlock }));
    // M6: an operator can't void an issued House B/L.
    const opEmail = `audit-op-${rand.toLowerCase()}@cargodesk.example`;
    const op = await request("POST", "/api/users", { email: opEmail, name: `Audit Operator ${rand}`, roles: ["operator"], password: "GoodPolicyPassword!2026" }, token);
    cleanup.user = op.body?.id || null;
    const opToken = (await request("POST", "/api/auth/login", { email: opEmail, password: "GoodPolicyPassword!2026" })).body?.token;
    const vOp = opToken ? await patchDoc(t.shipment.id, tIssued.doc.id, { status: "voided", voidReason: "Wrong consignee" }, opToken) : { status: 0 };
    assert("M6: an operator can't void an issued House B/L (403)", vOp.status === 403, JSON.stringify(vOp.body));
    const s2 = await surrender(t.shipment.id, tIssued.doc.id);
    assert("M5: with every original back, the surrender at origin goes", s2.status === 200 && (await house(t.shipment.id)).live?.status === "SURRENDERED_FOR_DELIVERY", JSON.stringify(s2.body).slice(0, 200));
    const v2 = await patchDoc(t.shipment.id, tIssued.doc.id, { status: "voided", voidReason: "Consignee address wrong" });
    assert("H1: a House B/L surrendered for delivery can't be voided (409)", v2.status === 409 && /surrendered for delivery/.test(v2.body?.error), JSON.stringify(v2.body));

    const v = await ready("V");
    const vIssued = await issue(v.shipment.id);
    const vv = await patchDoc(v.shipment.id, vIssued.doc.id, { status: "voided", voidReason: "Consignee name misspelt" });
    assert("with no original out and nothing live, the admin voids it (with a reason)", vIssued.r.status === 200 && vv.status === 200 && vv.body.status === "voided", JSON.stringify(vv.body).slice(0, 200));

    // ─── A live eBL (H1, H3) ───
    console.log("\nA live eBL is the platform's");
    const e = await ready("E");
    await issue(e.shipment.id);
    await request("POST", `/api/customers/${e.shipper.id}/identifiers`, { idType: "WAVE", idCode: `WAVE-VLE-${rand}`, countryIso2: "NL" }, token);
    const eSent = await request("POST", `/api/shipments/${e.shipment.id}/house-bl/issue-ebl`, {}, token);
    let eLive = (await house(e.shipment.id)).live;
    await request("POST", `/api/test-tools/ebl-sim/documents/${encodeURIComponent(eLive.reference)}/ISSU`, {}, token);
    for (let i = 0; i < 20 && eLive.eblIssuanceStatus !== "ISSU"; i++) { await sleep(150); eLive = (await house(e.shipment.id)).live; }
    assert("(setup) issued as an eBL on WAVE", eSent.status === 200 && eLive.eblIssuanceStatus === "ISSU", JSON.stringify({ s: eSent.body?.error, st: eLive.eblIssuanceStatus }));
    const eSur = await surrender(e.shipment.id, eLive.documentId);
    assert("H3: a live eBL isn't surrendered by hand (409)", eSur.status === 409 && /surrendered there/.test(eSur.body?.error), JSON.stringify(eSur.body));
    const eVoid = await patchDoc(e.shipment.id, eLive.documentId, { status: "voided", voidReason: "Wrong consignee" });
    assert("H1: a live eBL isn't voided here (409)", eVoid.status === 409 && /eBL on WAVE/.test(eVoid.body?.error), JSON.stringify(eVoid.body));
    const eDel = await request("DELETE", `/api/shipments/${e.shipment.id}`, null, token);
    assert("R1: nor is its shipment deleted (409, a live eBL)", eDel.status === 409 && /a live eBL/.test(eDel.body?.error), JSON.stringify(eDel.body));

    // ─── Shipped on board once every container is (M1), the issuer (M2), the issue date (L2) ───
    console.log("\nShipped on board, the issuer, the issue date");
    const m = await ready("M");
    const c2 = (await request("POST", "/api/containers", { shipmentId: m.shipment.id, containerNumber: `MSKU${String(Date.now()).slice(-6)}7`,
      sealNumber: `ML-${String(Date.now()).slice(-6)}`, size: "40", type: "HC", hsCode: "940360", cargoDescription: "Flat-pack wooden furniture",
      marksAndNumbers: "VLF/NYC 1201-2400", grossWeightKg: 17900, volumeCbm: 64, numberOfPackages: 1100, packageCode: "CT" }, token)).body;
    await draft(m.shipment.id);
    let mHb = await house(m.shipment.id);
    assert("M1: one of two containers loaded — not shipped on board yet, and it says which", !mHb.onBoard.shippedOnBoard && mHb.onBoard.loaded === 1
      && mHb.readiness.missing.some(x => x.includes(`1 of 2 containers loaded (${c2.containerNumber} isn't)`)), JSON.stringify({ ob: mHb.onBoard, miss: mHb.readiness?.missing }));
    await request("POST", `/api/shipments/${m.shipment.id}/containers/${c2.id}/events`, { eventType: "Loaded", occurredAt: `${inDays(0)}T22:50:00Z`, location: "NLRTM" }, token);
    mHb = await house(m.shipment.id);
    const amsDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(`${inDays(0)}T22:50:00Z`));
    assert("…both loaded: shipped on board, dated by the last one in Rotterdam's own day", mHb.onBoard.shippedOnBoard && mHb.onBoard.onBoardDate === amsDay, JSON.stringify(mHb.onBoard));
    await request("PUT", `/api/branches/${branch.id}`, { ...(await request("GET", `/api/branches/${branch.id}`, null, token)).body, scac: "" }, token);
    mHb = await house(m.shipment.id);
    assert("M2: the issuer's SCAC is asked for before issue", mHb.readiness.missing.some(x => /needs a SCAC/.test(x)), JSON.stringify(mHb.readiness?.missing));
    await request("PUT", `/api/branches/${branch.id}`, { ...(await request("GET", `/api/branches/${branch.id}`, null, token)).body, scac: "CDLR" }, token);
    const mIssued = await issue(m.shipment.id);
    const officeDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    mHb = await house(m.shipment.id);
    assert("L2: issued under the office's own day", mIssued.r.status === 200 && mHb.live?.issueDate === officeDay, JSON.stringify({ s: mIssued.r.status, d: mHb.live?.issueDate, officeDay }));

    // ─── The on-board notation (M4) ───
    console.log("\nThe on-board notation on a received-for-shipment B/L");
    const n = await ready("N", { loaded: false });
    const nIssued = await issue(n.shipment.id, { shippedOnBoard: false });
    const early = await request("POST", `/api/shipments/${n.shipment.id}/house-bl/on-board-notation`, {}, token);
    assert("issued Received for shipment; no notation before loading (409)", nIssued.r.status === 200 && early.status === 409 && /waits for every container/.test(early.body?.error),
      JSON.stringify({ s: nIssued.r.body?.error, e: early.body }));
    await request("POST", `/api/shipments/${n.shipment.id}/containers/${n.container.id}/events`, { eventType: "Loaded", occurredAt: `${inDays(0)}T06:15:00Z`, location: "NLRTM" }, token);
    const note = await request("POST", `/api/shipments/${n.shipment.id}/house-bl/on-board-notation`, {}, token);
    const nTd = (await house(n.shipment.id)).live;
    const nDoc = (await request("GET", `/api/shipments/${n.shipment.id}/house-bl/${nTd.id}/dcsa`, null, token)).body;
    assert("M4: once loaded, the notation goes on the same B/L: dated, in its DCSA document, still version 1", note.status === 200 && note.body.onBoardNotationDate === inDays(0)
      && nTd.version === 1 && !nTd.isShippedOnBoardType && nDoc.document.shippedOnBoardDate === inDays(0) && /shipped on board/.test(nDoc.document.displayedShippedOnBoardReceivedForShipment) && nDoc.errors === "",
      JSON.stringify({ b: note.body?.onBoardNotationDate, d: nDoc.document?.displayedShippedOnBoardReceivedForShipment, e: nDoc.errors }));
    assert("…and only once (409)", (await request("POST", `/api/shipments/${n.shipment.id}/house-bl/on-board-notation`, {}, token)).status === 409);

    // ─── The shipper's approval (L3) and added clauses (L4) ───
    console.log("\nThe shipper's approval of the draft; added clauses");
    const a = await ready("A");
    const tooMany = await draft(a.shipment.id, { shippedOnBoard: true, clauses: Array.from({ length: 11 }, (_, i) => `CLAUSE ${i + 1}`) });
    assert("L4: at most 10 added clauses (400)", tooMany.status === 400, JSON.stringify(tooMany.body));
    await draft(a.shipment.id, { shippedOnBoard: true, clauses: ["FREIGHT PREPAID AS ARRANGED", "L/C NO. 4471-2026 ISSUED BY ABN AMRO BANK N.V."] });
    let aHb = await house(a.shipment.id);
    const aDoc = (await request("GET", `/api/shipments/${a.shipment.id}/house-bl/${aHb.draft.id}/dcsa`, null, token)).body;
    assert("L4: the clauses are on the draft and in its DCSA document, after the fixed ones", aHb.draft.extraClauses.length === 2
      && aDoc.document.carrierClauses.join("|") === "SHIPPER'S LOAD, STOW AND COUNT|SAID TO CONTAIN|FREIGHT PREPAID AS ARRANGED|L/C NO. 4471-2026 ISSUED BY ABN AMRO BANK N.V.", JSON.stringify(aDoc.document?.carrierClauses));
    const noMail = await request("POST", `/api/shipments/${a.shipment.id}/house-bl/approval/send`, { to: "not an email" }, token);
    assert("L3: the shipper's email is needed (400)", noMail.status === 400, JSON.stringify(noMail.body));
    const sent = await request("POST", `/api/shipments/${a.shipment.id}/house-bl/approval/send`, { to: "logistics@vanleeuwen.example" }, token);
    assert("L3: sent for approval (recorded; emailed only where the office has email settings)", sent.status === 200 && sent.body.draft.approval?.status === "SENT"
      && sent.body.draft.approval.sentTo === "logistics@vanleeuwen.example" && (sent.body.emailed || /send the draft yourself/.test(sent.body.note)), JSON.stringify(sent.body).slice(0, 300));
    const noWhy = await request("POST", `/api/shipments/${a.shipment.id}/house-bl/approval/answer`, { approved: false }, token);
    assert("…changes asked need what to change (400)", noWhy.status === 400, JSON.stringify(noWhy.body));
    const changes = await request("POST", `/api/shipments/${a.shipment.id}/house-bl/approval/answer`, { approved: false, comment: "Consignee street is 250 Port Jersey Blvd" }, token);
    assert("…the shipper asked for changes: recorded with their words", changes.status === 200 && changes.body.approval?.status === "CHANGES_REQUESTED" && /250 Port Jersey/.test(changes.body.approval.comment), JSON.stringify(changes.body?.approval));
    await draft(a.shipment.id, { shippedOnBoard: true, clauses: ["FREIGHT PREPAID AS ARRANGED"] });
    aHb = await house(a.shipment.id);
    const stale = await request("POST", `/api/shipments/${a.shipment.id}/house-bl/approval/answer`, { approved: true }, token);
    assert("…a new draft makes it stale: the answer is for the draft that was sent (409)", aHb.draft.approval?.status === "STALE" && stale.status === 409, JSON.stringify({ a: aHb.draft.approval, s: stale.body }));
    await request("POST", `/api/shipments/${a.shipment.id}/house-bl/approval/send`, { to: "logistics@vanleeuwen.example" }, token);
    const ok = await request("POST", `/api/shipments/${a.shipment.id}/house-bl/approval/answer`, { approved: true }, token);
    assert("…sent again and approved", ok.status === 200 && ok.body.approval?.status === "APPROVED" && !!ok.body.approval.answeredBy, JSON.stringify(ok.body?.approval));

    // ─── The House against the carrier's Master B/L (M3) ───
    console.log("\nThe House against the carrier's Master B/L");
    const hm = await ready("H");
    await draft(hm.shipment.id);
    assert("no Master yet: nothing to compare", (await house(hm.shipment.id)).houseVsMaster === null);
    await request("PUT", `/api/shipments/${hm.shipment.id}/shipping-instructions`, { siCutoff: `${inDays(2)}T12:00`, specialInstructions: "" }, token);
    const siSent = await request("POST", `/api/shipments/${hm.shipment.id}/shipping-instructions/submit`, {}, token);
    const siRef = siSent.body?.shippingInstructions?.siReference;
    for (let i = 0; i < 20; i++) { const s = (await request("GET", `/api/shipments/${hm.shipment.id}/shipping-instructions`, null, token)).body; if (s?.carrierState === "RECEIVED") break; await sleep(150); }
    const drafted = await request("POST", `/api/test-tools/dcsa-sim/shipping-instructions/${siRef}/draft`, {}, token);
    let cmp = (await house(hm.shipment.id)).houseVsMaster;
    assert("the carrier drafted its Master B/L: the House matches it (containers, seals, weights, packages)", drafted.status === 200 && cmp?.differences.length === 0
      && cmp.containers === 1 && !!cmp.masterReference, JSON.stringify({ d: drafted.body?.error || drafted.body?.refused, cmp }));
    await request("PUT", `/api/shipments/${hm.shipment.id}/containers/${hm.container.id}`, { ...hm.container, seals: undefined, sealNumber: "CBP-7731" }, token);
    cmp = (await house(hm.shipment.id)).houseVsMaster;
    const sealDiff = cmp?.differences.find(x => x.key === `seal:${hm.container.containerNumber}`);
    assert("M3: a seal replaced on the shipment: the House differs from the Master, both values shown", sealDiff?.house === "CBP-7731" && sealDiff.master === hm.container.sealNumber, JSON.stringify(cmp));
    const mbl = (await request("GET", `/api/shipments/${hm.shipment.id}/master-bl`, null, token)).body;
    assert("…and the Master B/L card says so too", mbl?.houseCheck?.differences?.length === 1, JSON.stringify(mbl?.houseCheck));
  } catch (err) {
    console.error("\nFatal:", err.message);
    failed++;
  } finally {
    console.log("\nCleanup");
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token);
    if (cleanup.user) await request("DELETE", `/api/users/${cleanup.user}`, null, token);
    if (cleanup.office) console.log(`  office: ${await retireOffice(token, cleanup.office)}`);
    if (cleanup.branch) console.log(`  branch: ${await retireBranch(token, cleanup.branch)}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
