import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import * as browser from "./incotermPrincipal";

// The principal rule exists twice: the browser's (the shipment forms show it live) and the server's (lib/incoterm-
// principal.js: create, update, quote conversion). Both must give the same answer for every case (2026-11-13).
const server = createRequire(import.meta.url)("../../lib/incoterm-principal.js");

const VLM = { shipperId: "CUS-VLM", shipperName: "Van Leeuwen Meubelen BV" };
const HHI = { consigneeId: "CUS-HHI", consigneeName: "Hudson Home Imports Inc" };
const PARENT = { principalId: "CUS-PAR", principalName: "Van Leeuwen Holding NV" };
const parties = { ...VLM, ...HHI };

describe("The principal an incoterm implies", () => {
  it("C and D terms: the shipper; E and F terms: the consignee; others: nobody", () => {
    for (const t of ["CPT", "CIP", "CFR", "CIF", "DAP", "DPU", "DDP"]) expect(browser.impliedPrincipal(t, parties)).toEqual({ id: "CUS-VLM", name: "Van Leeuwen Meubelen BV", role: "Shipper" });
    for (const t of ["EXW", "FCA", "FAS", "fob"]) expect(browser.impliedPrincipal(t, parties)).toEqual({ id: "CUS-HHI", name: "Hudson Home Imports Inc", role: "Consignee" });
    expect(browser.impliedPrincipal("", parties)).toBeNull();
    expect(browser.impliedPrincipal("FOB", VLM)).toBeNull();
  });

  const cases = [
    ["empty principal, FOB chosen", { incoterm: "", ...parties }, { incoterm: "FOB", ...parties }],
    ["CIF → FOB moves it from the shipper to the consignee", { incoterm: "CIF", ...parties, principalId: "CUS-VLM", principalName: "Van Leeuwen Meubelen BV" }, { incoterm: "FOB", ...parties }],
    ["a parent company stays whatever the incoterm", { incoterm: "CIF", ...parties, ...PARENT }, { incoterm: "FOB", ...parties }],
    ["the shipper chosen under FOB stays", { incoterm: "FOB", ...parties, principalId: "CUS-VLM", principalName: "Van Leeuwen Meubelen BV" }, { incoterm: "CIF", ...parties }],
    ["a new consignee under FOB takes over", { incoterm: "FOB", ...parties, principalId: "CUS-HHI", principalName: "Hudson Home Imports Inc" },
      { incoterm: "FOB", ...VLM, consigneeId: "CUS-NEW", consigneeName: "Atlantic Living LLC" }],
    ["the incoterm cleared: the principal stays", { incoterm: "FOB", ...parties, principalId: "CUS-HHI", principalName: "Hudson Home Imports Inc" }, { incoterm: "", ...parties }],
    ["a principal typed by name only stays (audit D5)", { incoterm: "CIF", ...parties, principalId: "", principalName: "Van Leeuwen Holding NV" }, { incoterm: "FOB", ...parties }],
  ];
  it.each(cases)("%s — the same in the browser and on the server", (_, before, after) => {
    expect(browser.followPrincipal(before, after)).toEqual(server.followPrincipal(before, after));
  });

  it("follows only an empty or implied principal", () => {
    expect(browser.followPrincipal(cases[0][1], cases[0][2])).toEqual({ id: "CUS-HHI", name: "Hudson Home Imports Inc", moved: true });
    expect(browser.followPrincipal(cases[1][1], cases[1][2])).toEqual({ id: "CUS-HHI", name: "Hudson Home Imports Inc", moved: true });
    expect(browser.followPrincipal(cases[2][1], cases[2][2])).toEqual({ id: "CUS-PAR", name: "Van Leeuwen Holding NV", moved: false });
    expect(browser.followPrincipal(cases[3][1], cases[3][2]).id).toBe("CUS-VLM");
    expect(browser.followPrincipal(cases[4][1], cases[4][2])).toEqual({ id: "CUS-NEW", name: "Atlantic Living LLC", moved: true });
    expect(browser.followPrincipal(cases[6][1], cases[6][2])).toEqual({ id: "", name: "Van Leeuwen Holding NV", moved: false });
    expect(browser.followPrincipal(cases[5][1], cases[5][2])).toEqual({ id: "CUS-HHI", name: "Hudson Home Imports Inc", moved: false });
  });

  it("the two copies list the same terms", () => {
    expect(browser.SELLER_PAYS).toEqual(server.SELLER_PAYS);
    expect(browser.BUYER_PAYS).toEqual(server.BUYER_PAYS);
  });
});
