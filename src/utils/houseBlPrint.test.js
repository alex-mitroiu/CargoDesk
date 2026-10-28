import { describe, it, expect } from "vitest";
import { dispatchDocBuilder } from "./documentBuilders";

// The printed House B/L (Epic TKT-C7EBU3, approved mockups https://claude.ai/artifact/Tr9cyqXe31HqYTxy63ap7Z and
// https://claude.ai/artifact/CnuymDL2eUEnxnD8oDtj57): on board or received for shipment with its date, packages
// and marks, the notify party's address, the place of issue and who signs for the carrier; the number or
// "assigned at issue", to order, originals and copies, freight as arranged or the charges, transshipment
// and on-carriage, reefer and dangerous goods, the version of an amended B/L.

const shipment = {
  id: "SHP-NLWJFQ", blNumber: "SHP-NLWJFQ-K6BHVR", blReleaseType: "Original", pol: "NLRTM", polName: "Rotterdam", pod: "USNYC", podName: "New York",
  vessel: "ZEUS", voyage: "test1", bookingRef: "HLCU123456789", carrierCode: "HLCU", freightTerms: "Prepaid", movementType: "FCL",
  shipperName: "Acme Freight B.V.", consigneeName: "Empire Logistics Partners (Brooklyn) Inc", notifyName: "Empire Logistics Partners (Brooklyn) Inc",
};
const containers = [{ containerNumber: "HLCU123456", sealNumber: "TEST", size: "40", type: "HC", hsCode: "940360", cargoDescription: "Flat-pack furniture",
  marksAndNumbers: "VLF/NYC 1-1200", numberOfPackages: 1200, packageCode: "CT", packageDescription: "Carton", grossWeightKg: 14412, volumeCbm: 23 }];
const notify = { companyName: "Empire Logistics Partners (Brooklyn) Inc", address1: "334 Furman St", city: "Brooklyn", state: "NY", postalCode: "11201", countryIso2: "US" };
const issuer = { entityName: "Rotterdam Branch", officeName: "Rotterdam Office", placeName: "Rotterdam", unlocode: "NLRTM", signatory: "Dana Visser" };
const html = extra => dispatchDocBuilder("BL01", { shipment, invNumber: "SHP-NLWJFQ-K6BHVR", invDate: "2026-10-21", notes: "", containers, parties: [], notify, issuer, ...extra });

describe("BL01, the printed House B/L", () => {
  it("says shipped on board with the loading date", () => {
    const h = html({ houseBl: { shippedOnBoard: true, onBoardDate: "2026-10-20" } });
    expect(h).toContain("SHIPPED ON BOARD 20 October 2026");
    expect(h).not.toContain("RECEIVED FOR SHIPMENT");
  });
  it("or received for shipment, before loading", () => {
    const h = html({ houseBl: { shippedOnBoard: false, receivedDate: "2026-10-19" } });
    expect(h).toContain("RECEIVED FOR SHIPMENT 19 October 2026");
    expect(h).not.toContain("SHIPPED ON BOARD");
  });
  it("without a statement it prints the old wording: shipped on board, no date", () => {
    const h = dispatchDocBuilder("BL01", { shipment, invNumber: "X", invDate: "2026-10-21", notes: "", containers, parties: [] });
    expect(h).toMatch(/<strong>SHIPPED ON BOARD<\/strong>/);
  });
  it("prints the packages, marks and the FCL clauses", () => {
    const h = html({ houseBl: { shippedOnBoard: true, onBoardDate: "2026-10-20" } });
    expect(h).toContain("1,200 CT");
    expect(h).toContain("VLF/NYC 1-1200");
    expect(h).toContain("SHIPPER'S LOAD, STOW AND COUNT · SAID TO CONTAIN");
  });
  it("gives the notify party's address, the place of issue, and who signs as carrier", () => {
    const h = html({ houseBl: { shippedOnBoard: true, onBoardDate: "2026-10-20" } });
    expect(h).toContain("334 Furman St");
    expect(h).toContain("Rotterdam (NLRTM) / 21 October 2026");
    expect(h).toContain("Rotterdam Branch, as carrier");
    expect(h).toContain("by Dana Visser, Rotterdam Office");
    expect(h).toContain("FREIGHT PREPAID AS ARRANGED, payable at Rotterdam");
    expect(h).toContain("3 (THREE)");
  });
});

describe("BL01, the remaining gaps", () => {
  const on = { shippedOnBoard: true, onBoardDate: "2026-10-20" };
  it("prints the number, or says it is assigned at issue (G5)", () => {
    expect(html({ houseBl: on })).toContain("SHP-NLWJFQ-K6BHVR");
    const draft = dispatchDocBuilder("BL01", { shipment: { ...shipment, blNumber: "" }, invNumber: "", invDate: "2026-10-21", notes: "", containers, parties: [], houseBl: on });
    expect(draft).toContain("Assigned at issue");
  });
  it("to order of the consignee, or to order with no consignee (G11)", () => {
    const ofConsignee = dispatchDocBuilder("BL01", { shipment: { ...shipment, blToOrder: "CONSIGNEE" }, invNumber: "X", invDate: "2026-10-21", notes: "", containers, parties: [], houseBl: on });
    expect(ofConsignee).toMatch(/TO ORDER OF<\/div>\s*<div class="party-name">Empire Logistics Partners \(Brooklyn\) Inc/);
    const blank = dispatchDocBuilder("BL01", { shipment: { ...shipment, blToOrder: "SHIPPER" }, invNumber: "X", invDate: "2026-10-21", notes: "", containers, parties: [], houseBl: on });
    expect(blank).toContain('<div class="party-name">TO ORDER</div>');
    const swb = dispatchDocBuilder("BL01", { shipment: { ...shipment, blReleaseType: "Seaway Bill", blToOrder: "SHIPPER" }, invNumber: "X", invDate: "2026-10-21", notes: "", containers, parties: [], houseBl: on });
    expect(swb).not.toContain("TO ORDER");
  });
  it("originals and copies as chosen; with charges, the charges table (G12, G14)", () => {
    const h = html({ houseBl: { ...on, originals: 2, copies: 4, withCharges: true }, charges: [
      { code: "OFR", name: "Ocean freight", currency: "USD", amount: 2450, paymentTerm: "PRE" },
      { code: "DTHC", name: "Destination THC", currency: "USD", amount: 395, paymentTerm: "COL" }] });
    expect(h).toContain("2 (TWO)");
    expect(h).toContain("4 (NOT NEGOTIABLE)");
    expect(h).toContain("Freight and Charges");
    expect(h).toContain("USD 2,450.00");
    expect(h).toContain("USD 395.00");
    expect(h).not.toContain("AS ARRANGED");
  });
  it("every sea leg: the first vessel, the transshipment onto the mother vessel, on-carriage by truck (G16)", () => {
    const h = html({ houseBl: on, routing: { preCarriageBy: "", onCarriageBy: "TRUCK", vessels: [
      { vessel: "MAERSK KENSINGTON", voyage: "443W", pol: "NLRTM", pod: "ESALG", role: "FIRST_SEA_GOING" },
      { vessel: "MAERSK EDMONTON", voyage: "445W", pol: "ESALG", pod: "USNYC", role: "MOTHER" }] } });
    expect(h).toContain("MAERSK KENSINGTON / 443W");
    expect(h).toContain("at ESALG on MAERSK EDMONTON / 445W (mother vessel)");
    expect(h).toMatch(/On-carriage By<\/div><div class="detail-val">Truck/);
  });
  it("a reefer's set temperature and the dangerous goods under their container (G17)", () => {
    const h = html({ houseBl: on, containers: [
      { ...containers[0], type: "RF", setTemperatureC: -18 },
      { ...containers[0], containerNumber: "MSKU1647203", isDg: true, dgClass: "3", dgUnNumber: "1263", dgProperShippingName: "PAINT" }] });
    expect(h).toContain("REEFER · SET AT -18.0 °C");
    expect(h).toContain("DANGEROUS GOODS · UN 1263 PAINT · CLASS 3");
  });
  it("an amended B/L says its version and what it replaces (G6)", () => {
    const h = html({ houseBl: on, version: 2, amendsIssueDate: "2026-10-21" });
    expect(h).toContain("VERSION 2 · AMENDED · REPLACES THE B/L ISSUED 21 OCTOBER 2026");
    expect(html({ houseBl: on })).not.toContain("AMENDED");
  });
});
