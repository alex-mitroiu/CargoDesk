/**
 * House B/L numbers, corrections and the tasks around them (Epic TKT-C7EBU3; plan
 * https://claude.ai/artifact/FF9eMZXXMLHdJkCk5abaoU, medium and low gaps, 2026-10-22; lib/house-bl.js):
 *   - G5 the number series per issuing office (decision D1): prefix + year + 5 digits, assigned when the
 *     B/L is issued (POST …/house-bl/number), unique across CargoDesk, a voided number never reused, a
 *     typed number kept; an issued number can't be edited on the shipment;
 *   - G6 corrections: surrender for amendment with a reason, version 2 under the same number, the
 *     version-1 copy superseded; what changed since issue is listed;
 *   - G21 an "Overdue milestone" Kanban task closes once its milestone is completed (by issuing the
 *     House B/L, or by hand);
 *   - G22 is in carrier-booking.test.js (the booking links the Master B/L).
 *
 * Usage:
 *   node tests/house-bl-series.test.js
 *
 * Prerequisites:
 *   - Express server on :3001 and the pdf-render service on :3003
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations (seeded MDM data)
 */

import { readyHouseBlShipment, generateHouseBl, assignHouseBlNumber } from "./helpers/house-bl.mjs";
import { retireOffice } from "./helpers/offices.mjs";

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
const yy = new Date().toISOString().slice(2, 4);
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

(async () => {
  const cleanup = { shipments: [], customers: [], offices: [] };
  let token;
  const track = r => { cleanup.shipments.push(r.shipment.id); cleanup.customers.push(r.shipper.id, r.consignee.id); return r; };
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    const house = async id => (await request("GET", `/api/shipments/${id}/house-bl`, null, token)).body;
    const shipment = async id => (await request("GET", `/api/shipments/${id}`, null, token)).body;
    const confirm = (shipmentId, docId) => request("PATCH", `/api/shipments/${shipmentId}/documents/${docId}`, { status: "confirmed" }, token);
    const issue = async (shipmentId, name = "A") => {
      const g = await generateHouseBl(request, token, shipmentId, { name });
      return { draft: g, confirmed: await confirm(shipmentId, g.body?.id) };
    };

    // A scratch export office with its own series, so the numbers are predictable.
    const letters = Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");
    const office = await request("POST", "/api/offices", { unlocode: `NL${letters}`, countryCode: "NL", department: "SE", name: `Export Series ${letters}` }, token);
    assert("(setup) a scratch export office", office.status === 201, JSON.stringify(office.body));
    cleanup.offices.push(office.body.id);
    const prefix = `T${letters}`;

    console.log("\nG5 — the office series");
    const badPrefix = await request("PUT", `/api/offices/${office.body.id}`, { hblPrefix: "rtm-hbl" }, token);
    assert("a prefix with a dash is refused (400)", badPrefix.status === 400 && /2 to 10 capital letters or digits/.test(badPrefix.body?.error), JSON.stringify(badPrefix.body));
    const setPrefix = await request("PUT", `/api/offices/${office.body.id}`, { hblPrefix: prefix.toLowerCase() }, token);
    assert(`the prefix is set, in capitals (${prefix}), and the next number shown`, setPrefix.status === 200 && setPrefix.body.hblPrefix === prefix
      && setPrefix.body.hblNextNumber === `${prefix}${yy}00001`, JSON.stringify(setPrefix.body));
    assert("…the default prefix is the UN/LOCODE's place letters + HBL", setPrefix.body.hblDefaultPrefix === `${letters}HBL`, setPrefix.body.hblDefaultPrefix);
    const listed = (await request("GET", "/api/offices", null, token)).body.find(o => o.id === office.body.id);
    assert("GET /api/offices shows the series", listed?.hblPrefix === prefix && listed.hblNextNumber === `${prefix}${yy}00001`, JSON.stringify(listed));
    const other = (await request("GET", "/api/offices", null, token)).body.find(o => o.id !== office.body.id && o.department === "SE");
    if (other) {
      const dup = await request("PUT", `/api/offices/${other.id}`, { hblPrefix: prefix }, token);
      assert("another office can't take the same prefix (400)", dup.status === 400 && /already used by office/.test(dup.body?.error), JSON.stringify(dup.body));
    }

    const a = track(await readyHouseBlShipment(request, token, { tag: "SA", emoOfficeId: office.body.id, numbered: false }));
    let h = await house(a.shipment.id);
    assert("before issue: no number yet, the next one from the series", h.readiness.number.value === null && h.readiness.number.source === "SERIES"
      && h.readiness.number.next === `${prefix}${yy}00001`, JSON.stringify(h.readiness.number));
    assert("…and that isn't a blocker", h.readiness.ready === true, JSON.stringify(h.readiness.missing));
    const early = await generateHouseBl(request, token, a.shipment.id, { name: "EARLY" });
    assert("a draft printed before the number exists has none", early.status === 201 && (await house(a.shipment.id)).draft.reference === "", JSON.stringify((await house(a.shipment.id)).draft));
    const earlyIssue = await confirm(a.shipment.id, early.body.id);
    assert("…and can't be issued from the Documents list (409)", earlyIssue.status === 409 && /printed before its B\/L number was assigned/.test(earlyIssue.body?.error),
      JSON.stringify(earlyIssue.body));

    const n1 = await request("POST", `/api/shipments/${a.shipment.id}/house-bl/number`, {}, token);
    assert(`POST …/house-bl/number takes ${prefix}${yy}00001 from the series`, n1.status === 200 && n1.body.number === `${prefix}${yy}00001`
      && n1.body.source === "SERIES" && n1.body.assigned === true, JSON.stringify(n1.body));
    const n1again = await request("POST", `/api/shipments/${a.shipment.id}/house-bl/number`, {}, token);
    assert("…asking again gives the same number, not a new one", n1again.body.number === n1.body.number && n1again.body.assigned === false, JSON.stringify(n1again.body));
    let s = await shipment(a.shipment.id);
    assert("…kept on the shipment as a series number", s.blNumber === n1.body.number && s.blNumberSource === "SERIES", `${s.blNumber} ${s.blNumberSource}`);
    const stale = await request("PUT", `/api/shipments/${a.shipment.id}`, { blNumber: "", incoterm: "FOB" }, token);
    assert("…a save sending it blank (a page loaded before the number was taken) keeps it", stale.status === 200 && stale.body.blNumber === n1.body.number
      && stale.body.blNumberSource === "SERIES", JSON.stringify({ status: stale.status, n: stale.body?.blNumber, src: stale.body?.blNumberSource }));
    const aIssued = await issue(a.shipment.id);
    assert("the draft printed with the number issues", aIssued.confirmed.status === 200, JSON.stringify(aIssued.confirmed.body));
    h = await house(a.shipment.id);
    assert("…the record: the number, from the series", h.live?.reference === n1.body.number && h.live.numberSource === "SERIES" && h.live.version === 1, JSON.stringify(h.live));
    const relabel = await request("PUT", `/api/shipments/${a.shipment.id}`, { blNumber: "SOMETHING-ELSE" }, token);
    assert("the shipment's B/L number can't be edited while it is issued (409)", relabel.status === 409 && /can't change/.test(relabel.body?.error), JSON.stringify(relabel.body));

    const b = track(await readyHouseBlShipment(request, token, { tag: "SB", emoOfficeId: office.body.id }));
    assert("the next shipment on the office takes 00002", b.shipment.blNumber === `${prefix}${yy}00002`, b.shipment.blNumber);

    const voided = await request("PATCH", `/api/shipments/${a.shipment.id}/documents/${aIssued.draft.body.id}`,
      { status: "voided", voidReason: "Issued to the wrong consignee" }, token);
    assert("A's House B/L is voided", voided.status === 200, JSON.stringify(voided.body));
    s = await shipment(a.shipment.id);
    assert("…its series number is released from the shipment", s.blNumber === "" && s.blNumberSource === "", `${s.blNumber} ${s.blNumberSource}`);
    const n3 = await assignHouseBlNumber(request, token, a.shipment.id);
    assert(`…and A's next House B/L takes a new number (00003), never 00001 again`, n3 === `${prefix}${yy}00003`, n3);

    const t = track(await readyHouseBlShipment(request, token, { tag: "ST", emoOfficeId: office.body.id, numbered: false }));
    const typedNo = `VLF-PAPER-${letters}42`;
    const typed = await request("PUT", `/api/shipments/${t.shipment.id}`, { blNumber: typedNo }, token);
    assert("a number typed on the shipment is kept as typed", typed.status === 200 && typed.body.blNumber === typedNo && typed.body.blNumberSource === "TYPED",
      JSON.stringify({ n: typed.body.blNumber, src: typed.body.blNumberSource }));
    const tn = await request("POST", `/api/shipments/${t.shipment.id}/house-bl/number`, {}, token);
    assert("…POST …/number keeps it (no series number taken)", tn.body.number === typedNo && tn.body.source === "TYPED" && tn.body.assigned === false, JSON.stringify(tn.body));
    const tIssued = await issue(t.shipment.id);
    assert("…and the House B/L issues under it", tIssued.confirmed.status === 200 && (await house(t.shipment.id)).live?.numberSource === "TYPED",
      JSON.stringify(tIssued.confirmed.body));
    const clash = track(await readyHouseBlShipment(request, token, { tag: "SC", emoOfficeId: office.body.id, numbered: false }));
    await request("PUT", `/api/shipments/${clash.shipment.id}`, { blNumber: typedNo }, token);
    h = await house(clash.shipment.id);
    assert("another shipment typing the same number is blocked at issue", h.readiness.missing.some(m => m.includes(`B/L number ${typedNo} is already used by ${t.shipment.id}`)),
      JSON.stringify(h.readiness.missing));

    console.log("\nG6 — corrections: surrender for amendment, version 2 under the same number");
    const bIssued = await issue(b.shipment.id);
    assert("B is issued (v1)", bIssued.confirmed.status === 200, JSON.stringify(bIssued.confirmed.body));
    await request("PUT", `/api/customers/${b.consignee.id}`, { ...b.consignee, address1: "1 Harbor Gateway", postalCode: "07305" }, token);
    h = await house(b.shipment.id);
    assert("a change after issue is listed: the consignee", Array.isArray(h.changedSinceIssue) && h.changedSinceIssue.includes("Consignee"), JSON.stringify(h.changedSinceIssue));
    const noReason = await request("POST", `/api/shipments/${b.shipment.id}/house-bl/surrender-for-amendment`, {}, token);
    assert("surrender for amendment needs a reason (400)", noReason.status === 400 && /reason/.test(noReason.body?.error), JSON.stringify(noReason.body));
    const amend = await request("POST", `/api/shipments/${b.shipment.id}/house-bl/surrender-for-amendment`, { reason: "Consignee moved to 1 Harbor Gateway" }, token);
    assert("the originals come back: SURRENDERED_FOR_AMENDMENT", amend.status === 200 && amend.body.status === "SURRENDERED_FOR_AMENDMENT"
      && amend.body.amendmentReason === "Consignee moved to 1 Harbor Gateway", JSON.stringify(amend.body));
    const v1Doc = (await request("GET", `/api/shipments/${b.shipment.id}/documents`, null, token)).body.find(d => d.id === bIssued.draft.body.id);
    assert("…the v1 copy is superseded (voided as a document)", v1Doc?.status === "voided", v1Doc?.status);
    h = await house(b.shipment.id);
    assert("…no live House B/L; the next issue amends v1 under the same number", !h.live && h.amends?.version === 1 && h.readiness.number.value === b.shipment.blNumber,
      JSON.stringify({ amends: h.amends?.version, number: h.readiness.number }));
    const relabel2 = await request("PUT", `/api/shipments/${b.shipment.id}`, { blNumber: "NEW-NUMBER" }, token);
    assert("…the number still can't be edited while v2 is pending (409)", relabel2.status === 409, JSON.stringify(relabel2.body));
    const again = await request("POST", `/api/shipments/${b.shipment.id}/house-bl/surrender-for-amendment`, { reason: "twice" }, token);
    assert("…a second surrender for amendment is refused (409)", again.status === 409, JSON.stringify(again.body));
    const v1Id = h.amends?.id;
    const v2 = await generateHouseBl(request, token, b.shipment.id, { name: "V2" });
    h = await house(b.shipment.id);
    assert("the new draft is version 2, amending v1, same number", h.draft?.version === 2 && h.draft.supersedesId === h.amends?.id && h.draft.reference === b.shipment.blNumber,
      JSON.stringify(h.draft));
    const v2Issued = await confirm(b.shipment.id, v2.body.id);
    assert("version 2 issues", v2Issued.status === 200, JSON.stringify(v2Issued.body));
    h = await house(b.shipment.id);
    assert("…live: v2 under the same number, nothing changed since", h.live?.version === 2 && h.live.reference === b.shipment.blNumber
      && Array.isArray(h.changedSinceIssue) && h.changedSinceIssue.length === 0, JSON.stringify({ v: h.live?.version, ref: h.live?.reference, changed: h.changedSinceIssue }));
    assert("…both versions on record", h.documents.filter(d => d.reference === b.shipment.blNumber).map(d => `${d.version}:${d.status}`).sort().join(",")
      === "1:SURRENDERED_FOR_AMENDMENT,2:ISSUED", JSON.stringify(h.documents.map(d => [d.version, d.status])));
    const v2Events = (await request("GET", `/api/shipments/${b.shipment.id}/house-bl/${h.live.id}/events`, null, token)).body;
    assert("…v2's history says it amends v1", v2Events.some(e => e.eventType === "ISSUED" && e.detail.version === 2 && e.detail.amends === v1Id),
      JSON.stringify(v2Events.map(e => [e.eventType, e.detail])));
    await request("PATCH", `/api/shipments/${b.shipment.id}/documents/${v2.body.id}/bl-surrender`, {}, token);
    const released = await request("PATCH", `/api/shipments/${b.shipment.id}/documents/${v2.body.id}/bl-release`, {}, token);
    assert("v2 is surrendered and released as usual", released.status === 200, JSON.stringify(released.body));
    const lateAmend = await request("POST", `/api/shipments/${b.shipment.id}/house-bl/surrender-for-amendment`, { reason: "late" }, token);
    assert("a released House B/L can't be amended (409)", lateAmend.status === 409, JSON.stringify(lateAmend.body));

    console.log("\nG21 — overdue-milestone tasks close themselves");
    const g = track(await readyHouseBlShipment(request, token, { tag: "SG" }));
    const milestones = (await request("GET", `/api/shipments/${g.shipment.id}/milestones`, null, token)).body;
    const blIssued = milestones.find(m => m.milestoneKey === "bl_issued"), siSubmitted = milestones.find(m => m.milestoneKey === "si_submitted");
    for (const m of [blIssued, siSubmitted])
      await request("PUT", `/api/shipments/${g.shipment.id}/milestones/${m.id}`, { estimatedDate: yesterday, completedAt: m.completedAt || "", note: m.note || "" }, token);
    await request("POST", "/api/test/run-ops-automation-sweep", {}, token);
    const tickets = async () => (await request("GET", `/api/tickets?shipmentId=${g.shipment.id}`, null, token)).body.filter(x => x.sourceType === "milestone_overdue");
    let tk = await tickets();
    const blTask = () => tk.find(x => x.sourceId === blIssued.id), siTask = () => tk.find(x => x.sourceId === siSubmitted.id);
    assert("the sweep opens an overdue task for B/L Issued", blTask()?.status === "Ready", JSON.stringify(tk.map(x => [x.title, x.status])));
    await issue(g.shipment.id);
    tk = await tickets();
    assert("issuing the House B/L completes B/L Issued and closes its task", blTask()?.status === "Done" && /Closed automatically: "B\/L Issued" was completed/.test(blTask().description),
      JSON.stringify(blTask()));
    if (siTask() && !siSubmitted.completedAt) {
      assert("…the other overdue task stays open", siTask().status === "Ready", siTask().status);
      await request("PUT", `/api/shipments/${g.shipment.id}/milestones/${siSubmitted.id}`, { estimatedDate: yesterday, completedAt: new Date().toISOString(), note: "SI filed" }, token);
      tk = await tickets();
      assert("…until its milestone is completed by hand", siTask()?.status === "Done", JSON.stringify(siTask()));
    }
    for (const x of await tickets()) await request("DELETE", `/api/tickets/${x.id}`, null, token);
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    console.log("\nCleanup");
    for (const id of cleanup.shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
    for (const id of cleanup.customers) await request("DELETE", `/api/customers/${id}`, null, token);
    for (const id of cleanup.offices) console.log(`  office ${id}: ${await retireOffice(token, id)}`);
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
