import { describe, it, expect } from "vitest";
import { FINANCIALS_PAGES, canSeeFinancialsPage, visibleFinancialsPages } from "./financialsNav";

const see = (roles, extra = {}) => visibleFinancialsPages({ roles, ...extra });

describe("Financials group — who sees which page", () => {
  it("lists the five pages in the agreed order", () => {
    expect(FINANCIALS_PAGES).toEqual(["quotes", "opportunities", "reports", "freight-audit", "credit-overrides"]);
  });

  it("gives an admin everything", () => {
    expect(see(["admin"])).toEqual(FINANCIALS_PAGES);
  });

  it("gives an operator Credit Overrides but not Reports, until they have finance access", () => {
    expect(see(["operator"])).toEqual(["quotes", "opportunities", "freight-audit", "credit-overrides"]);
    expect(see(["operator"], { canViewFinance: true })).toEqual(FINANCIALS_PAGES);
  });

  it("gives a trade manager Reports and Credit Overrides whether or not they have finance access", () => {
    expect(see(["trade_manager"])).toEqual(FINANCIALS_PAGES);
  });

  it("gives sales, booking and viewer only the three open pages", () => {
    for (const role of ["sales", "occ_bk", "viewer"]) {
      expect(see([role])).toEqual(["quotes", "opportunities", "freight-audit"]);
    }
  });

  it("finance access adds Reports for those roles, but never Credit Overrides", () => {
    for (const role of ["sales", "occ_bk", "viewer"]) {
      expect(see([role], { canViewFinance: true })).toEqual(["quotes", "opportunities", "reports", "freight-audit"]);
    }
  });

  it("takes the union across a person's roles", () => {
    expect(see(["viewer", "trade_manager"])).toEqual(FINANCIALS_PAGES);
    expect(see(["sales", "operator"])).toEqual(["quotes", "opportunities", "freight-audit", "credit-overrides"]);
  });

  it("hides Reports from everyone, admin included, while the finance view is switched off — but nothing else", () => {
    expect(see(["admin"], { financeViewEnabled: false })).toEqual(["quotes", "opportunities", "freight-audit", "credit-overrides"]);
    expect(see(["trade_manager"], { canViewFinance: true, financeViewEnabled: false })).not.toContain("reports");
  });

  it("applies the module switch on top: a page whose module is off disappears", () => {
    const off = key => key !== "opportunities" && key !== "reports";
    expect(visibleFinancialsPages({ roles: ["admin"] }, off)).toEqual(["quotes", "freight-audit", "credit-overrides"]);
  });

  it("never offers a page outside the group, and copes with no roles at all", () => {
    expect(canSeeFinancialsPage("shipments", { roles: ["admin"] })).toBe(false);
    expect(see([])).toEqual(["quotes", "opportunities", "freight-audit"]);
    expect(canSeeFinancialsPage("reports")).toBe(false);
  });
});
