/**
 * Contract & Space Configuration improvements — smoke tests
 *
 * Usage:
 *   node tests/contract-improvements.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *
 * Covers the new backend surface added in this pass: contractType server-side validation,
 * contract delete guard (referenced by a shipment / allocation), auto-expire + the new
 * GET /api/contracts/expiring bell endpoint, contract amendment field diffs, rate-line
 * content-keyed diffs, the expanded SERVICE_CODE_MAP (surcharge codes no longer collapse to
 * "Other"), rate-line-level validity windows, allocation MQC validation, and the Publish/
 * Withdraw workflow. Does NOT re-test anything already covered by an existing test file (route
 * matching, IMDG policy, space-config overlap detection, etc.) — see routes/contracts.js and
 * routes/allocations.js's own comments for what each new piece is fixing and why.
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

(async () => {
  let token, contractId, draftContractId, allocationId, shipmentId;
  try {
    console.log("Logging in...");
    token = await login();
    console.log("  ✓ Logged in");

    console.log("\ncontractType — server-side enum validation");
    {
      let r = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "Not A Real Type",
      }, token);
      assert("bogus contractType rejected", r.status === 400);
      r = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "SPOT",
      }, token);
      assert("valid contractType (SPOT) accepted", r.status === 200 || r.status === 201);
      if (r.body.id) { await request("DELETE", `/api/shipments/${r.body.id}`, null, token); }
    }

    console.log("\nScratch contract with a leg and rates, for the rest of this file");
    {
      const num = `TESTCNTR-${Date.now()}`;
      const r = await request("POST", "/api/contracts", {
        contractNumber: num, carrierCode: "MAEU", status: "Active",
        validFrom: "2026-01-01", validTo: "2027-01-01",
        legs: [{ pol: "NLRTM", pod: "USNYC" }],
        rates: [
          { serviceCode: "OF", amount: 500, currency: "USD", unit: "per_container" },
          { serviceCode: "BAF", amount: 80, currency: "USD", unit: "per_container" },
        ],
      }, token);
      assert("scratch contract created", r.status === 201, JSON.stringify(r.body));
      contractId = r.body.id;
    }

    console.log("\nAmendment history — field diff + content-keyed rate diff");
    {
      const before = await request("GET", `/api/contracts/${contractId}`, null, token);
      const newRates = before.body.rates.map(rt => rt.serviceCode === "OF" ? { ...rt, amount: 600 } : rt);
      const put = await request("PUT", `/api/contracts/${contractId}`, { ...before.body, notes: "amended", rates: newRates }, token);
      assert("update returns 200", put.status === 200);
      const events = await request("GET", `/api/entity-events/contract/${contractId}`, null, token);
      const notesEvent = events.body.find(e => e.field === "notes");
      assert("notes field diff logged", !!notesEvent && notesEvent.oldValue === "" && notesEvent.newValue === "amended");
      const rateEvent = events.body.find(e => e.field === "rate:OF");
      assert("OF rate diff logged with old->new amounts", !!rateEvent && rateEvent.oldValue.includes("500") && rateEvent.newValue.includes("600"));
    }

    console.log("\nSERVICE_CODE_MAP — surcharge codes no longer collapse to 'Other'");
    {
      // Create a scratch Central shipment against this contract, which auto-imports rates
      // into shipment_cost_lines via generateCostLinesFromSnapshot.
      const shipRes = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "Central", contractId,
      }, token);
      assert("scratch shipment created against the contract", shipRes.status === 200 || shipRes.status === 201, JSON.stringify(shipRes.body));
      shipmentId = shipRes.body.id;
      const lines = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
      const bafLine = (lines.body.results || lines.body).find(l => (l.notes || "").includes("BAF"));
      assert("a BAF-sourced cost line exists", !!bafLine, JSON.stringify(lines.body));
      assert("its charge code is specific, not the generic 'Other'", bafLine && bafLine.chargeCode === "Bunker Adjustment Factor", bafLine?.chargeCode);
    }

    console.log("\nContract delete guard — referenced by a shipment");
    {
      const r = await request("DELETE", `/api/contracts/${contractId}`, null, token);
      assert("delete blocked while a shipment references it", r.status === 400);
      assert("error names the reason", /shipment/i.test(r.body.error || ""));
    }

    console.log("\nRate-line-level validity window — a lapsed rate line is excluded from a NEW snapshot");
    {
      const before = await request("GET", `/api/contracts/${contractId}`, null, token);
      const lapsedRates = before.body.rates.map(rt => rt.serviceCode === "BAF"
        ? { ...rt, validFrom: "2020-01-01", validTo: "2020-12-31" } : rt);
      await request("PUT", `/api/contracts/${contractId}`, { ...before.body, rates: lapsedRates }, token);
      const reimport = await request("POST", `/api/shipments/${shipmentId}/cost-lines/update-carrier-costs`, {}, token);
      assert("update-carrier-costs returns 200", reimport.status === 200, JSON.stringify(reimport.body));
      const lines = await request("GET", `/api/shipments/${shipmentId}/cost-lines`, null, token);
      const bafStillThere = (lines.body.results || lines.body).some(l => (l.notes || "").includes("BAF") && l.source === "contract");
      assert("the now-lapsed BAF rate is excluded from the fresh snapshot", !bafStillThere);
    }

    console.log("\nGET /api/contracts/expiring — bell endpoint");
    {
      const r = await request("GET", "/api/contracts/expiring?days=3650", null, token);
      assert("returns 200", r.status === 200);
      assert("response is an array", Array.isArray(r.body));
    }

    console.log("\nCleanup — delete the scratch shipment, then confirm the contract can now be deleted");
    {
      const del = await request("DELETE", `/api/shipments/${shipmentId}`, null, token);
      assert("scratch shipment deleted", del.status === 200);
      const delContract = await request("DELETE", `/api/contracts/${contractId}`, null, token);
      assert("contract now deletes cleanly with no shipment referencing it", delContract.status === 200, JSON.stringify(delContract.body));
      contractId = null;
    }

    console.log("\nScratch Draft contract — Publish workflow validation");
    {
      const num = `TESTDRAFT-${Date.now()}`;
      const r = await request("POST", "/api/contracts", {
        contractNumber: num, carrierCode: "MAEU", status: "Draft",
      }, token);
      assert("draft contract created", r.status === 201);
      draftContractId = r.body.id;

      const pubEmpty = await request("POST", `/api/contracts/${draftContractId}/publish`, {}, token);
      assert("publish rejected with no rates/legs", pubEmpty.status === 400);

      const withLegRate = await request("GET", `/api/contracts/${draftContractId}`, null, token);
      await request("PUT", `/api/contracts/${draftContractId}`, {
        ...withLegRate.body,
        validFrom: "2026-01-01", validTo: "2027-01-01",
        legs: [{ pol: "DEHAM", pod: "USNYC" }],
        rates: [{ serviceCode: "OF", amount: 400, currency: "USD", unit: "per_container" }],
      }, token);

      const pubOk = await request("POST", `/api/contracts/${draftContractId}/publish`, {}, token);
      assert("publish succeeds once rate+leg+validity are set", pubOk.status === 200, JSON.stringify(pubOk.body));
      assert("status is now Active", pubOk.body.status === "Active");

      const pubAgain = await request("POST", `/api/contracts/${draftContractId}/publish`, {}, token);
      assert("publishing an already-Active contract is rejected", pubAgain.status === 400);

      const withdraw = await request("POST", `/api/contracts/${draftContractId}/withdraw`, {}, token);
      assert("withdraw back to Draft succeeds (nothing references it)", withdraw.status === 200);
      assert("status is now Draft", withdraw.body.status === "Draft");

      const events = await request("GET", `/api/entity-events/contract/${draftContractId}`, null, token);
      assert("a PUBLISHED event was logged", events.body.some(e => e.eventType === "PUBLISHED"));
      assert("a WITHDRAWN event was logged", events.body.some(e => e.eventType === "WITHDRAWN"));
    }

    console.log("\nAllocation MQC — minimumTEU can't exceed allocatedTEU");
    {
      // Re-publish the draft contract so an allocation can reference it (allocations require
      // a real contractId but don't themselves check the linked contract's status).
      await request("POST", `/api/contracts/${draftContractId}/publish`, {}, token);
      const today = new Date().toISOString().slice(0, 10);
      const end = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const bad = await request("POST", "/api/allocations", {
        carrierCode: "MAEU", allocatedTEU: 50, effectiveDate: today, endDate: end,
        pol: "DEHAM", pod: "USNYC", contractId: draftContractId, minimumTEU: 100,
      }, token);
      assert("minimumTEU > allocatedTEU rejected", bad.status === 400);

      const good = await request("POST", "/api/allocations", {
        carrierCode: "MAEU", allocatedTEU: 50, effectiveDate: today, endDate: end,
        pol: "DEHAM", pod: "USNYC", contractId: draftContractId, minimumTEU: 20,
      }, token);
      assert("valid minimumTEU accepted", good.status === 201, JSON.stringify(good.body));
      assert("minimumTEU round-trips", good.body.minimumTEU === 20);
      assert("a brand-new allocation reports 0 consumed (shape matches GET)", good.body.consumedTEU === 0);
      allocationId = good.body.id;

      const list = await request("GET", "/api/allocations", null, token);
      const listed = list.body.find(a => a.id === allocationId);
      assert("GET /api/allocations includes the same consumedTEU/remainingTEU shape", listed && listed.consumedTEU === 0 && listed.remainingTEU === 50);
    }

    console.log("\nCleanup");
    if (allocationId)    { const d = await request("DELETE", `/api/allocations/${allocationId}`, null, token); assert("scratch allocation deleted", d.status === 200); }
    if (draftContractId) { const d = await request("DELETE", `/api/contracts/${draftContractId}`, null, token); assert("scratch draft contract deleted", d.status === 200, JSON.stringify(d.body)); }

    console.log("\n──────────────────────────────────────────────────");
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  } catch (e) {
    console.error("Fatal:", e.message);
    if (token) {
      if (shipmentId)      await request("DELETE", `/api/shipments/${shipmentId}`, null, token).catch(() => {});
      if (allocationId)    await request("DELETE", `/api/allocations/${allocationId}`, null, token).catch(() => {});
      if (contractId)      await request("DELETE", `/api/contracts/${contractId}`, null, token).catch(() => {});
      if (draftContractId) await request("DELETE", `/api/contracts/${draftContractId}`, null, token).catch(() => {});
    }
    process.exit(1);
  }
})();
