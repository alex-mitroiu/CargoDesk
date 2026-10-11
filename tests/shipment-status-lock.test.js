/**
 * Completed / Cancelled shipment lock and what a cancellation needs (TKT-SPXTGR, decided by the
 * user 2026-10-09):
 *   - A shipment can only be cancelled once its carrier booking and its submitted customs /
 *     security filings are cancelled. A Pending or Confirmed booking, or a Filed or Accepted
 *     filing (with or without an answer from the authority), refuses the cancellation with
 *     409 code ACTIVE_ITEMS and the list of what is still active — the client shows it in a pop-up.
 *     A Rejected booking doesn't block; the cancellation closes it out.
 *   - A submitted filing can be cancelled (reason required) and reset to Draft from there.
 *   - Completed and Cancelled shipments are locked: the header, legs, containers, parties,
 *     schedules, shipping instructions, services, customs filings, carrier booking and the status
 *     itself all refuse writes with 409 code SHIPMENT_LOCKED. Finance (cost lines), messages,
 *     milestones, container events and the concurrent-edit lock stay open.
 *
 * Usage:
 *   node tests/shipment-status-lock.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *   - NLRTM, USNYC present in port_locations (seeded MDM data); MAEU EDI-bookable at the test office
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

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

async function login(email, password) {
  const { status, body } = await request("POST", "/api/auth/login", { email, password });
  if (status !== 200 || !body.token) throw new Error(`Login failed (${status}): ${JSON.stringify(body)}`);
  return body.token;
}

const locked = res => res.status === 409 && res.body?.code === "SHIPMENT_LOCKED";
const notLocked = res => res.status < 400;

(async () => {
  const shipmentIds = [], customerIds = [];
  let token;
  try {
    console.log("Logging in…");
    token = await login("claudeagent@localhost", "TestFixture!2026Zq");
    console.log("  ✓ Logged in");
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);

    const customer = async name => {
      const res = await request("POST", "/api/customers", { companyName: name }, token);
      customerIds.push(res.body.id);
      return res.body;
    };
    const shipper = await customer("Lock Test Shipper BV");
    const consignee = await customer("Lock Test Consignee Inc");
    const broker = await customer("Lock Test Customs Brokers LLC");

    // Complete shipment: parties, incoterm, POL/POD, ETD/ETA, commodity, a filled-in container with
    // priced cargo, and an export customs broker — everything a booking and an AES filing need.
    const scratchShipment = async () => {
      const res = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "SPOT",
        etd: "2026-11-02", eta: "2026-11-14", incoterm: "FOB", commodityCode: "9999",
        shipperId: shipper.id, shipperName: shipper.companyName,
        consigneeId: consignee.id, consigneeName: consignee.companyName,
        declaredValue: 48000, declaredValueCurrency: "USD",
        emoOfficeId, imoOfficeId,
      }, token);
      if (res.status !== 201) throw new Error(`scratch shipment: ${res.status} ${JSON.stringify(res.body)}`);
      shipmentIds.push(res.body.id);
      const id = res.body.id;
      const ctr = await request("POST", "/api/containers", {
        shipmentId: id, containerNumber: `MSKU${String(Date.now()).slice(-7)}`, size: "40", type: "HC",
        hsCode: "847130", cargoDescription: "Laptop computers", grossWeightKg: 12000, volumeCbm: 58,
      }, token);
      await request("POST", `/api/shipments/${id}/containers/${ctr.body.id}/packages`,
        { description: "Laptop computers", quantity: 400, unitValue: 120, currency: "USD" }, token);
      await request("POST", `/api/shipments/${id}/parties`,
        { role: "Customs Broker (Export)", customerId: broker.id, customerName: broker.companyName }, token);
      return { id, containerId: ctr.body.id };
    };
    const cancel = id => request("PUT", `/api/shipments/${id}`, { status: "Cancelled" }, token);
    const statusOf = async id => (await request("GET", `/api/shipments/${id}`, null, token)).body.status;

    // ── Cancelling needs the booking and the filings cancelled first ──────────────────────────
    console.log("\nShipment A: a Confirmed booking and a Filed AES/EEI filing block the cancellation");
    const A = await scratchShipment();
    const confirm = await request("PATCH", `/api/shipments/${A.id}/carrier-booking/confirm`, { bookingRef: "MAEU-LOCK-0001" }, token);
    assert("booking confirmed", confirm.status === 200 && confirm.body.status === "Confirmed", JSON.stringify(confirm.body));
    const draft = await request("POST", `/api/shipments/${A.id}/customs-filings`, { filingType: "AES_EEI" }, token);
    assert("AES/EEI filing created", draft.status === 201, JSON.stringify(draft.body));
    const filingId = draft.body.id;
    const submit = await request("POST", `/api/shipments/${A.id}/customs-filings/${filingId}/submit`, {}, token);
    assert("AES/EEI filing submitted (Filed, no answer yet)", submit.body?.filing?.status === "Filed", JSON.stringify(submit.body));

    const blocked1 = await cancel(A.id);
    const items1 = blocked1.body?.activeItems || [];
    assert("cancel is refused with 409 ACTIVE_ITEMS", blocked1.status === 409 && blocked1.body.code === "ACTIVE_ITEMS", JSON.stringify(blocked1.body));
    assert("…listing the booking and the filing", items1.length === 2
      && items1.some(i => i.kind === "booking" && i.status === "Confirmed by the carrier" && /MAEU-LOCK-0001/.test(i.label))
      && items1.some(i => i.kind === "filing" && i.id === filingId && i.filingType === "AES_EEI" && i.status === "Submitted, no answer yet"),
      JSON.stringify(items1));
    assert("…and the message names them", /Carrier booking/.test(blocked1.body.error) && /AES \/ EEI/.test(blocked1.body.error), blocked1.body.error);
    assert("the shipment is still Active", await statusOf(A.id) === "Active");

    console.log("\nCancelling a submitted filing");
    const cancelFiling = body => request("POST", `/api/shipments/${A.id}/customs-filings/${filingId}/cancel`, body, token);
    const noReason = await cancelFiling({ reason: "  " });
    assert("a reason is required (400)", noReason.status === 400, JSON.stringify(noReason.body));
    const cancelled = await cancelFiling({ reason: "Shipper cancelled the order" });
    assert("Filed filing cancelled", cancelled.status === 200 && cancelled.body.status === "Cancelled", JSON.stringify(cancelled.body));
    assert("…with who, when and why recorded", cancelled.body.cancelReason === "Shipper cancelled the order"
      && !!cancelled.body.cancelledAt && !!cancelled.body.cancelledBy, JSON.stringify(cancelled.body));
    const again = await cancelFiling({ reason: "again" });
    assert("cancelling it twice is refused (409)", again.status === 409, JSON.stringify(again.body));

    const reset = await request("PATCH", `/api/shipments/${A.id}/customs-filings/${filingId}/reset`, {}, token);
    assert("a Cancelled filing can be reset to Draft", reset.status === 200 && reset.body.status === "Draft", JSON.stringify(reset.body));
    assert("…which clears the cancellation", !reset.body.cancelledAt && !reset.body.cancelReason && !reset.body.cancelledBy, JSON.stringify(reset.body));
    const cancelDraft = await cancelFiling({ reason: "nothing submitted" });
    assert("a Draft filing can't be cancelled — nothing was submitted (409)", cancelDraft.status === 409, JSON.stringify(cancelDraft.body));

    console.log("\nAn Accepted filing blocks too, and can be cancelled");
    await request("POST", `/api/shipments/${A.id}/customs-filings/${filingId}/submit`, {}, token);
    const accept = await request("POST", `/api/shipments/${A.id}/customs-filings/${filingId}/simulate-response`,
      { outcome: "accepted", confirmationNumber: "CBPLOCK0001" }, token);
    assert("filing resubmitted and Accepted", accept.status < 300, JSON.stringify(accept.body));
    const blocked2 = await cancel(A.id);
    assert("cancel is refused while the filing is Accepted",
      blocked2.status === 409 && (blocked2.body.activeItems || []).some(i => i.kind === "filing" && i.status === "Accepted · CBPLOCK0001"),
      JSON.stringify(blocked2.body));
    const cancelAccepted = await cancelFiling({ reason: "Shipment cancelled after acceptance" });
    assert("Accepted filing cancelled", cancelAccepted.status === 200 && cancelAccepted.body.status === "Cancelled", JSON.stringify(cancelAccepted.body));

    const blocked3 = await cancel(A.id);
    assert("with the filing cancelled, only the booking still blocks",
      blocked3.status === 409 && blocked3.body.activeItems?.length === 1 && blocked3.body.activeItems[0].kind === "booking",
      JSON.stringify(blocked3.body));
    const cancelBooking = await request("PATCH", `/api/shipments/${A.id}/carrier-booking/cancel`, { reason: "Shipper cancelled the order" }, token);
    assert("booking cancelled", cancelBooking.status === 200 && cancelBooking.body.status === "Cancelled", JSON.stringify(cancelBooking.body));
    const done = await cancel(A.id);
    assert("now the shipment cancels (200)", done.status === 200 && done.body.status === "Cancelled", JSON.stringify(done.body));

    console.log("\nShipment B: a Pending booking blocks; a Rejected one doesn't, and the cancellation closes it out");
    const B = await scratchShipment();
    const requested = await request("POST", `/api/shipments/${B.id}/edi-messages/booking-request`, {}, token);
    assert("booking requested (Pending)", requested.status < 300, JSON.stringify(requested.body));
    const blockedB = await cancel(B.id);
    assert("cancel is refused while the booking awaits an answer",
      blockedB.status === 409 && blockedB.body.activeItems?.[0]?.status === "Requested, no answer yet", JSON.stringify(blockedB.body));
    await request("POST", `/api/shipments/${B.id}/edi-messages/simulate-response`, { outcome: "rejected" }, token);
    const bookingB = await request("GET", `/api/shipments/${B.id}/carrier-booking`, null, token);
    assert("booking now Rejected", bookingB.body?.status === "Rejected", JSON.stringify(bookingB.body));
    const doneB = await cancel(B.id);
    assert("the shipment cancels with a Rejected booking (200)", doneB.status === 200 && doneB.body.status === "Cancelled", JSON.stringify(doneB.body));
    const bookingB2 = await request("GET", `/api/shipments/${B.id}/carrier-booking`, null, token);
    assert("…and its Rejected booking is closed out as Cancelled", bookingB2.body?.status === "Cancelled", JSON.stringify(bookingB2.body));

    // ── The lock itself ──────────────────────────────────────────────────────────────────────
    console.log("\nCancelled shipment A: details are locked");
    // A schedule saved before cancelling, to check its delete is locked too.
    const C = await scratchShipment();
    const sched = await request("POST", `/api/shipments/${C.id}/schedules`, {
      carrier: "MAEU", vesselName: "MAERSK KENSINGTON", voyageNumber: "441W", service: "AE7",
      pol: "NLRTM", pod: "USNYC", etd: "2026-11-02", eta: "2026-11-14", transitDays: 12,
    }, token);
    assert("schedule saved on shipment C before it closes", sched.status === 201, JSON.stringify(sched.body));

    const put = await request("PUT", `/api/shipments/${A.id}`, { etd: "2026-11-09" }, token);
    assert("editing the header is refused (409 SHIPMENT_LOCKED)", locked(put), JSON.stringify(put.body));
    const reopen = await request("PUT", `/api/shipments/${A.id}`, { status: "Active" }, token);
    assert("reopening a Cancelled shipment is refused — Cancelled is final", locked(reopen), JSON.stringify(reopen.body));
    const lockedWrites = {
      "adding a leg":             ["POST", `/api/shipments/${A.id}/legs`, { legType: "SEA", pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU" }],
      "adding a container":       ["POST", "/api/containers", { shipmentId: A.id, containerNumber: "TGHU7654321", size: "20", type: "GP" }],
      "editing a container":      ["PUT", `/api/shipments/${A.id}/containers/${A.containerId}`, { containerNumber: "MSKU0000001", size: "40", type: "HC" }],
      "adding a party":           ["POST", `/api/shipments/${A.id}/parties`, { role: "Notify Party", customerId: consignee.id, customerName: consignee.companyName }],
      "saving a schedule":        ["POST", `/api/shipments/${A.id}/schedules`, { carrier: "MAEU", pol: "NLRTM", pod: "USNYC", etd: "2026-11-02" }],
      "editing shipping instructions": ["PUT", `/api/shipments/${A.id}/shipping-instructions`, { specialInstructions: "Keep dry" }],
      "adding a service":         ["POST", `/api/shipments/${A.id}/services`, { side: "Export", serviceType: "Trucking" }],
      "resetting a customs filing": ["PATCH", `/api/shipments/${A.id}/customs-filings/${filingId}/reset`, {}],
      "confirming a booking":     ["PATCH", `/api/shipments/${A.id}/carrier-booking/confirm`, { bookingRef: "MAEU-LOCK-0002" }],
      "requesting a booking":     ["POST", `/api/shipments/${A.id}/edi-messages/booking-request`, {}],
      "reassigning an office":    ["POST", `/api/shipments/${A.id}/reassign-office`, { field: "emoOfficeId", officeId: emoOfficeId, reason: "test" }],
    };
    for (const [label, [method, path, body]] of Object.entries(lockedWrites)) {
      const res = await request(method, path, body, token);
      assert(`${label} is refused (409 SHIPMENT_LOCKED)`, locked(res), `${res.status} ${JSON.stringify(res.body)}`);
    }
    const reread = await request("GET", `/api/shipments/${A.id}`, null, token);
    assert("reading it still works", reread.status === 200 && reread.body.etd === "2026-11-02", JSON.stringify(reread.body?.etd));

    console.log("\nCancelled shipment A: finance, messages, milestones and container events stay open");
    const cost = await request("POST", `/api/shipments/${A.id}/cost-lines`,
      { type: "SELL", chargeCode: "OT", currency: "USD", amount: 150, notes: "Cancellation fee" }, token);
    assert("a cost line (cancellation fee) can be added", cost.status === 201, JSON.stringify(cost.body));
    const msg = await request("POST", `/api/shipments/${A.id}/messages`,
      { body: "Shipper confirmed the cancellation by phone.", author: "Lock Test" }, token);
    assert("a message can be posted", notLocked(msg), JSON.stringify(msg.body));
    // An API-created shipment has no milestones until they're initialised; that's open too.
    const init = await request("POST", `/api/shipments/${A.id}/milestones/init`, {}, token);
    assert("milestones can be initialised", notLocked(init), JSON.stringify(init.body));
    const milestones = await request("GET", `/api/shipments/${A.id}/milestones`, null, token);
    const ms = (milestones.body || []).find(m => !m.completedAt);
    if (ms) {
      const msPut = await request("PUT", `/api/shipments/${A.id}/milestones/${ms.id}`, { note: "Closed out on cancellation" }, token);
      assert("a milestone can be updated", notLocked(msPut), JSON.stringify(msPut.body));
    } else assert("shipment A has milestones to update", false, JSON.stringify(milestones.body));
    const ev = await request("POST", `/api/shipments/${A.id}/containers/${A.containerId}/events`,
      { eventType: "Empty Return", occurredAt: "2026-10-09T10:00:00Z", location: "Rotterdam ECT Delta" }, token);
    assert("a container event can be recorded", notLocked(ev), JSON.stringify(ev.body));
    const editLock = await request("POST", `/api/shipments/${A.id}/edit-lock`, {}, token);
    assert("the concurrent-edit lock still works", notLocked(editLock), JSON.stringify(editLock.body));
    await request("DELETE", `/api/shipments/${A.id}/edit-lock`, null, token);

    console.log("\nShipment C: Completed is locked the same way");
    const complete = await request("PUT", `/api/shipments/${C.id}`, { status: "Completed" }, token);
    assert("an Active shipment can be completed (no booking/filing rule for Completed)", complete.status === 200 && complete.body.status === "Completed", JSON.stringify(complete.body));
    const reopenC = await request("PUT", `/api/shipments/${C.id}`, { status: "Active" }, token);
    assert("a Completed shipment can't be reopened", locked(reopenC), JSON.stringify(reopenC.body));
    const cancelC = await cancel(C.id);
    assert("…or cancelled", locked(cancelC), JSON.stringify(cancelC.body));
    const legC = await request("POST", `/api/shipments/${C.id}/legs`, { legType: "SEA", pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU" }, token);
    assert("adding a leg is refused", locked(legC), JSON.stringify(legC.body));
    const delSched = await request("DELETE", `/api/schedules/${sched.body.id}`, null, token);
    assert("deleting its saved schedule is refused", locked(delSched), JSON.stringify(delSched.body));
    const costC = await request("POST", `/api/shipments/${C.id}/cost-lines`,
      { type: "BUY", chargeCode: "OT", currency: "USD", amount: 80, notes: "Late carrier invoice" }, token);
    assert("a late cost line can still be added", costC.status === 201, JSON.stringify(costC.body));
  } catch (e) {
    console.error("\nFatal:", e.message);
    failed++;
  } finally {
    if (token) {
      console.log("\nCleanup");
      for (const id of shipmentIds) await request("DELETE", `/api/shipments/${id}`, null, token);
      for (const id of customerIds) await request("DELETE", `/api/customers/${id}`, null, token);
    }
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
