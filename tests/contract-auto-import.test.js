/**
 * Contract cost auto-import — a Central shipment's contract costs appear without clicking
 * "Import from Contract", once per contract, and never on top of charges that already exist.
 *
 * Covers: import when a Central contract is assigned after creation, a deliberate delete staying
 * deleted, holding back when a contract charge already has a line (hand-added or the previous
 * contract's after a switch), the Reconcile preview comparing against the NEW contract after a
 * switch, and concurrent cost-line reads importing only once.
 *
 * Usage:   node tests/contract-auto-import.test.js
 * Needs:   Express server on :3001, admin claudeagent@localhost / TestFixture!2026Zq
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

let passed = 0;
let failed = 0;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      method, hostname: "localhost", port: 3001, path,
      headers: {
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(payload && { "Content-Length": Buffer.byteLength(payload) }),
      },
    }, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
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

const contractLines = lines => lines.filter(l => l.type === "BUY" && l.source === "contract");

(async () => {
  const shipments = [], contracts = [], customers = [];
  let token;
  try {
    token = (await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" })).body.token;
    console.log("  ✓ Logged in");
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);

    const shipperRes = await request("POST", "/api/customers", { companyName: "Auto-Import Shipper BV" }, token);
    const consigneeRes = await request("POST", "/api/customers", { companyName: "Auto-Import Consignee Inc" }, token);
    customers.push(shipperRes.body.id, consigneeRes.body.id);

    const newContract = async (rates) => {
      const contractNumber = `CAI-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const c = await request("POST", "/api/contracts", { contractNumber, carrierCode: "MAEU", status: "Active", rates }, token);
      contracts.push(c.body.id);
      return { id: c.body.id, contractNumber };
    };
    const newShipment = async (extra) => {
      const s = await request("POST", "/api/shipments", {
        pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Pending",
        incoterm: "FOB", etd: "2026-10-20", eta: "2026-11-02", commodityCode: "001404",
        shipperId: shipperRes.body.id, shipperName: "Auto-Import Shipper BV",
        consigneeId: consigneeRes.body.id, consigneeName: "Auto-Import Consignee Inc",
        emoOfficeId, imoOfficeId, ...extra,
      }, token);
      shipments.push(s.body.id);
      await request("POST", "/api/containers", { shipmentId: s.body.id, containerNumber: `MSKU${String(Date.now()).slice(-7)}`, size: "40", type: "HC", status: "Empty" }, token);
      return s.body.id;
    };
    const setContract = (id, c) => request("PUT", `/api/shipments/${id}`,
      { status: "Active", contractType: "Central", contractId: c.id, contractRef: c.contractNumber }, token);
    const getLines = async id => (await request("GET", `/api/shipments/${id}/cost-lines`, null, token)).body;

    const contractA = await newContract([
      { serviceCode: "OF", amount: 1450, currency: "USD", unit: "per_container" },
      { serviceCode: "DOC", amount: 50, currency: "USD", unit: "per_shipment" },
    ]);
    const contractB = await newContract([
      { serviceCode: "OF", amount: 1525, currency: "USD", unit: "per_container" },
      { serviceCode: "DOC", amount: 55, currency: "USD", unit: "per_shipment" },
      { serviceCode: "THC", amount: 180, currency: "USD", unit: "per_shipment" },
    ]);

    console.log("\nAssigning a Central contract after creation imports its costs straight away");
    const s1 = await newShipment();
    assert("Pending shipment starts with no contract lines", contractLines(await getLines(s1)).length === 0);
    const put1 = await setContract(s1, contractA);
    assert("contract assigned", put1.status === 200, JSON.stringify(put1.body));
    const lines1 = contractLines(await getLines(s1));
    assert("Ocean Freight 1450 + Documentation Fee 50 imported",
      lines1.length === 2 && lines1.some(l => l.chargeCode === "Ocean Freight" && l.amount === 1450) && lines1.some(l => l.chargeCode === "Documentation Fee" && l.amount === 50),
      JSON.stringify(lines1));
    const snaps1 = (await request("GET", `/api/shipments/${s1}/rate-snapshots`, null, token)).body;
    assert("one snapshot, for contract A", snaps1.length === 1 && snaps1[0].contractId === contractA.id, JSON.stringify(snaps1));

    console.log("\nA deliberate delete stays deleted — auto-import is once per contract");
    for (const l of lines1) await request("DELETE", `/api/shipments/${s1}/cost-lines/${l.id}`, null, token);
    assert("contract lines not re-imported on the next read", contractLines(await getLines(s1)).length === 0);
    assert("…nor on the one after", contractLines(await getLines(s1)).length === 0);

    console.log("\nSwitching contract A -> B changes nothing by itself; the preview compares against B");
    const s2 = await newShipment();
    await setContract(s2, contractA);
    const beforeSwitch = contractLines(await getLines(s2));
    await setContract(s2, contractB);
    const afterSwitch = contractLines(await getLines(s2));
    assert("contract A's lines untouched by the switch", afterSwitch.length === 2
      && afterSwitch.every(l => beforeSwitch.some(b => b.id === l.id && b.amount === l.amount)), JSON.stringify(afterSwitch));
    const snaps2 = (await request("GET", `/api/shipments/${s2}/rate-snapshots`, null, token)).body;
    assert("no snapshot for contract B yet (Cost Entry will ask)", !snaps2.some(s => s.contractId === contractB.id), JSON.stringify(snaps2));
    const preview2 = (await request("GET", `/api/shipments/${s2}/cost-lines/reconcile-preview?mode=import`, null, token)).body.rows;
    const of2 = preview2.find(r => r.chargeCode === "Ocean Freight");
    const thc2 = preview2.find(r => r.chargeCode === "Origin THC");
    assert("import preview uses contract B's rates, not A's snapshot", of2?.status === "changed" && of2.currentAmount === 1450 && of2.contractAmount === 1525, JSON.stringify(of2));
    assert("B's extra THC shows as new", thc2?.status === "new", JSON.stringify(thc2));
    const apply2 = await request("POST", `/api/shipments/${s2}/cost-lines/import-contract`, { action: "overwrite" }, token);
    assert("user's Overwrite applies contract B", apply2.status === 200 && apply2.body.imported === 3, JSON.stringify(apply2.body));
    const snaps2b = (await request("GET", `/api/shipments/${s2}/rate-snapshots`, null, token)).body;
    assert("B's snapshot now recorded", snaps2b.some(s => s.contractId === contractB.id));

    console.log("\nPer-charge choice (action=selected) after a switch — only the chosen charges change");
    const s6 = await newShipment();
    await setContract(s6, contractA);
    const a6 = contractLines(await getLines(s6));
    const doc6 = a6.find(l => l.chargeCode === "Documentation Fee");
    await setContract(s6, contractB);
    const badTake = await request("POST", `/api/shipments/${s6}/cost-lines/import-contract`, { action: "selected", take: "Ocean Freight" }, token);
    assert("take must be an array", badTake.status === 400, JSON.stringify(badTake.body));
    const sel = await request("POST", `/api/shipments/${s6}/cost-lines/import-contract`,
      { action: "selected", take: ["Ocean Freight", "Origin THC", "Not A Charge"] }, token);
    assert("selected apply returns 200", sel.status === 200, JSON.stringify(sel.body));
    assert("2 lines generated (Ocean Freight refreshed, Origin THC added)", sel.body.imported === 2, JSON.stringify(sel.body));
    const after6 = (await getLines(s6)).filter(l => l.type === "BUY");
    const one = code => after6.filter(l => l.chargeCode === code);
    assert("Ocean Freight now contract B's 1525", one("Ocean Freight").length === 1 && one("Ocean Freight")[0].amount === 1525, JSON.stringify(one("Ocean Freight")));
    assert("Origin THC 180 added", one("Origin THC").length === 1 && one("Origin THC")[0].amount === 180);
    assert("Documentation Fee (not chosen) kept at contract A's 50, same line", one("Documentation Fee").length === 1 && one("Documentation Fee")[0].id === doc6.id && one("Documentation Fee")[0].amount === 50);
    const snaps6 = (await request("GET", `/api/shipments/${s6}/rate-snapshots`, null, token)).body;
    assert("contract B marked as applied", snaps6.some(s => s.contractId === contractB.id));

    console.log("\nKeeping everything (empty take) still marks the contract as applied");
    const s7 = await newShipment();
    await setContract(s7, contractA);
    await setContract(s7, contractB);
    const keepAll = await request("POST", `/api/shipments/${s7}/cost-lines/import-contract`, { action: "selected", take: [] }, token);
    assert("keep-all apply returns 200 and changes nothing", keepAll.status === 200 && keepAll.body.imported === 0 && keepAll.body.deleted === 0, JSON.stringify(keepAll.body));
    const snaps7 = (await request("GET", `/api/shipments/${s7}/rate-snapshots`, null, token)).body;
    assert("contract B recorded, so Cost Entry stops asking", snaps7.some(s => s.contractId === contractB.id));

    console.log("\nAn existing line for a contract charge holds the auto-import back");
    const s3 = await newShipment();
    await request("POST", `/api/shipments/${s3}/cost-lines`, { type: "BUY", chargeCode: "Ocean Freight", currency: "USD", amount: 1400, exchangeRate: 1 }, token);
    await setContract(s3, contractA);
    const lines3 = await getLines(s3);
    assert("nothing imported over the hand-entered Ocean Freight", contractLines(lines3).length === 0, JSON.stringify(lines3));
    assert("hand-entered line intact", lines3.some(l => l.chargeCode === "Ocean Freight" && l.amount === 1400 && l.source === "manual"));
    const snaps3 = (await request("GET", `/api/shipments/${s3}/rate-snapshots`, null, token)).body;
    assert("no snapshot written (decision still pending)", snaps3.length === 0, JSON.stringify(snaps3));

    console.log("\nA hand-added charge the contract doesn't have does NOT hold it back");
    const s4 = await newShipment();
    await request("POST", `/api/shipments/${s4}/cost-lines`, { type: "BUY", chargeCode: "Inland", currency: "USD", amount: 320, exchangeRate: 1 }, token);
    await setContract(s4, contractA);
    const lines4 = await getLines(s4);
    assert("contract A imported alongside the Inland line", contractLines(lines4).length === 2 && lines4.some(l => l.chargeCode === "Inland"), JSON.stringify(lines4));

    console.log("\nConcurrent cost-line reads import only once");
    const late = await newContract([]);
    const s5 = await newShipment();
    await setContract(s5, late);
    assert("contract with no rates imports nothing", contractLines(await getLines(s5)).length === 0);
    await request("PUT", `/api/contracts/${late.id}`, { contractNumber: late.contractNumber, carrierCode: "MAEU", status: "Active",
      rates: [{ serviceCode: "OF", amount: 1600, currency: "USD", unit: "per_container" }] }, token);
    await Promise.all([getLines(s5), getLines(s5), getLines(s5), getLines(s5)]);
    const lines5 = contractLines(await getLines(s5));
    assert("exactly one Ocean Freight line after 4 simultaneous reads", lines5.length === 1, JSON.stringify(lines5));
  } catch (e) {
    console.error("\nFATAL:", e.message);
    failed++;
  } finally {
    if (token) {
      for (const id of shipments) await request("DELETE", `/api/shipments/${id}`, null, token);
      for (const id of contracts) await request("DELETE", `/api/contracts/${id}`, null, token);
      for (const id of customers) await request("DELETE", `/api/customers/${id}`, null, token);
    }
    console.log("\n" + "─".repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
})();
