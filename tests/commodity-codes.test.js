/**
 * Commodity codes come from Master Data → Commodities everywhere (decided 2026-09-30)
 *
 * Usage:
 *   node tests/commodity-codes.test.js
 *
 * Prerequisites:
 *   - Express server running on :3001
 *   - Admin account: claudeagent@localhost / TestFixture!2026Zq
 *
 * Contracts, opportunities, quotes and shipments name a commodity by its registry code, so a
 * space configuration or contract can be matched against a shipment exactly. FAK is the
 * registry's own code 9999. Unknown codes (free text, HS headings such as "8471") are refused on
 * save; a code is only checked when it is set and changes, so a record still carrying a legacy
 * value stays editable. Contract commodity types are covered in contract-improvements.test.js.
 */

import http from "node:http";
import { ensureOffices } from "./helpers/offices.mjs";

let passed = 0, failed = 0;
function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ method, hostname: "localhost", port: 3001, path, headers: {
      "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }),
      ...(payload && { "Content-Length": Buffer.byteLength(payload) }) } }, res => {
      let data = ""; res.on("data", c => (data += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on("error", reject); if (payload) req.write(payload); req.end();
  });
}
function assert(label, condition, detail = "") {
  if (condition) { console.log(`  ✓ ${label}`); passed++; }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); failed++; }
}

(async () => {
  let token; const cleanup = { shipments: [], quotes: [], opportunities: [], contracts: [], customers: [] };
  try {
    const login = await request("POST", "/api/auth/login", { email: "claudeagent@localhost", password: "TestFixture!2026Zq" });
    token = login.body.token;
    const { emoOfficeId, imoOfficeId } = await ensureOffices(token);

    const contract = await request("POST", "/api/contracts", {
      contractNumber: `COMMTEST-${Date.now()}`, carrierCode: "MAEU", status: "Active", validFrom: "2026-01-01", validTo: "2027-12-31",
      commodityTypes: "001404", legs: [{ pol: "NLRTM", pod: "USNYC" }],
      rates: [{ serviceCode: "OF", amount: 1500, currency: "USD", unit: "per_container" }],
    }, token);
    assert("scratch contract created with a registry commodity", contract.status === 201 && contract.body.commodityTypes === "001404", JSON.stringify(contract.body.commodityTypes));
    cleanup.contracts.push(contract.body.id);

    // Own customers, not the first ones listed: CI starts from an empty database with none.
    const newCustomer = async companyName => {
      const r = await request("POST", "/api/customers", { companyName }, token);
      if (!r.body.id) throw new Error(`customer ${companyName}: ${JSON.stringify(r.body)}`);
      cleanup.customers.push(r.body.id);
      return r.body;
    };
    const shipper = await newCustomer("Commodity Codes Shipper BV");
    const consignee = await newCustomer("Commodity Codes Consignee Inc");
    const shipment = code => ({
      pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", contractType: "Central", contractId: contract.body.id,
      etd: "2026-11-02", eta: "2026-11-14", incoterm: "FOB", commodityCode: code,
      shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
      principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId,
    });

    console.log("\nShipments");
    const bad = await request("POST", "/api/shipments", shipment("8471"), token);
    assert("an HS heading as commodity is refused (400)", bad.status === 400 && /commodity code/i.test(bad.body.error || ""), JSON.stringify(bad.body));
    if (bad.body.id) cleanup.shipments.push(bad.body.id);
    const good = await request("POST", "/api/shipments", shipment("001404"), token);
    assert("a registry code is accepted", good.status === 201 || good.status === 200, JSON.stringify(good.body));
    cleanup.shipments.push(good.body.id);
    const box = await request("POST", "/api/containers", { shipmentId: good.body.id, size: "40", type: "HC", cargoDescription: "Consumer electronics", grossWeightKg: 12400 }, token);
    assert("shipment has a real container", box.status === 201 || box.status === 200, JSON.stringify(box.body));
    const fak = await request("PUT", `/api/shipments/${good.body.id}`, { commodityCode: "9999" }, token);
    assert("changing to FAK (9999) is accepted", fak.status === 200 && fak.body.commodityCode === "9999", JSON.stringify(fak.body.commodityCode));
    const badPut = await request("PUT", `/api/shipments/${good.body.id}`, { commodityCode: "FAK" }, token);
    assert("changing to free text 'FAK' is refused (400)", badPut.status === 400, JSON.stringify(badPut.body));
    const other = await request("PUT", `/api/shipments/${good.body.id}`, { incoterm: "CIF" }, token);
    assert("an edit that doesn't touch the commodity still saves", other.status === 200 && other.body.incoterm === "CIF");
    const cleared = await request("PUT", `/api/shipments/${good.body.id}`, { commodityCode: "" }, token);
    assert("clearing the commodity is allowed", cleared.status === 200 && cleared.body.commodityCode === "");

    console.log("\nQuotes and opportunities");
    const badQuote = await request("POST", "/api/quotes", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", commodityCode: "8471.30", customerName: "Commodity Test Co" }, token);
    assert("a quote with an unknown commodity is refused (400)", badQuote.status === 400, JSON.stringify(badQuote.body));
    if (badQuote.body.id) cleanup.quotes.push(badQuote.body.id);
    const goodQuote = await request("POST", "/api/quotes", { pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", commodityCode: "002001", customerName: "Commodity Test Co" }, token);
    assert("a quote with a registry code is accepted", goodQuote.status === 201 || goodQuote.status === 200, JSON.stringify(goodQuote.body));
    if (goodQuote.body.id) cleanup.quotes.push(goodQuote.body.id);
    const badOpp = await request("POST", "/api/opportunities", { title: "Commodity test lead", commodityCode: "Electronics" }, token);
    assert("an opportunity with an unknown commodity is refused (400)", badOpp.status === 400, JSON.stringify(badOpp.body));
    if (badOpp.body.id) cleanup.opportunities.push(badOpp.body.id);
    const goodOpp = await request("POST", "/api/opportunities", { title: "Commodity test lead", commodityCode: "9999" }, token);
    assert("an opportunity with FAK (9999) is accepted", goodOpp.status === 201 || goodOpp.status === 200, JSON.stringify(goodOpp.body));
    if (goodOpp.body.id) cleanup.opportunities.push(goodOpp.body.id);

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exitCode = failed > 0 ? 1 : 0;
  } catch (e) {
    console.error("Fatal error:", e); process.exitCode = 1;
  } finally {
    for (const id of cleanup.shipments) { try { await request("DELETE", `/api/shipments/${id}`, null, token); } catch {} }
    for (const id of cleanup.quotes) { try { await request("DELETE", `/api/quotes/${id}`, null, token); } catch {} }
    for (const id of cleanup.opportunities) { try { await request("DELETE", `/api/opportunities/${id}`, null, token); } catch {} }
    for (const id of cleanup.contracts) { try { await request("DELETE", `/api/contracts/${id}`, null, token); } catch {} }
    for (const id of cleanup.customers) { try { await request("DELETE", `/api/customers/${id}`, null, token); } catch {} }
  }
})();
