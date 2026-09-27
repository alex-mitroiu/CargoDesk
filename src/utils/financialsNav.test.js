import { describe, it, expect } from "vitest";
import { FINANCIALS_PAGES, canSeeFinancialsPage, visibleFinancialsPages } from "./financialsNav";

const see = (roles, extra = {}) => visibleFinancialsPages({ roles, ...extra });

describe("Financials group — who sees which page", () => {
  it("lists the seven pages in the agreed order", () => {
    expect(FINANCIALS_PAGES).toEqual(["quotes", "opportunities", "reports", "freight-audit", "credit-overrides", "customer-statements", "gl-export"]);
  });

  it("gives an admin everything", () => {
    expect(see(["admin"])).toEqual(FINANCIALS_PAGES);
  });

  it("gives an operator Credit Overrides and GL Export, but not Reports, until they have finance access", () => {
    expect(see(["operator"])).toEqual(["quotes", "opportunities", "freight-audit", "credit-overrides", "customer-statements", "gl-export"]);
    expect(see(["operator"], { canViewFinance: true })).toEqual(FINANCIALS_PAGES);
  });

  it("gives a trade manager Reports and Credit Overrides whether or not they have finance access, but GL Export only with it", () => {
    expect(see(["trade_manager"])).toEqual(["quotes", "opportunities", "reports", "freight-audit", "credit-overrides", "customer-statements"]);
    expect(see(["trade_manager"], { canViewFinance: true })).toEqual(FINANCIALS_PAGES);
  });

  it("gives sales, booking and viewer only the four open pages", () => {
    for (const role of ["sales", "occ_bk", "viewer"]) {
      expect(see([role])).toEqual(["quotes", "opportunities", "freight-audit", "customer-statements"]);
    }
  });

  it("finance access adds Reports and GL Export for those roles, but never Credit Overrides", () => {
    for (const role of ["sales", "occ_bk", "viewer"]) {
      expect(see([role], { canViewFinance: true })).toEqual(["quotes", "opportunities", "reports", "freight-audit", "customer-statements", "gl-export"]);
    }
  });

  it("takes the union across a person's roles", () => {
    expect(see(["viewer", "trade_manager"])).toEqual(["quotes", "opportunities", "reports", "freight-audit", "credit-overrides", "customer-statements"]);
    expect(see(["sales", "operator"])).toEqual(["quotes", "opportunities", "freight-audit", "credit-overrides", "customer-statements", "gl-export"]);
  });

  it("hides Reports from everyone, admin included, while the finance view is switched off — but nothing else (GL Export is role/finance-access gated, not tied to this switch)", () => {
    expect(see(["admin"], { financeViewEnabled: false })).toEqual(["quotes", "opportunities", "freight-audit", "credit-overrides", "customer-statements", "gl-export"]);
    expect(see(["trade_manager"], { canViewFinance: true, financeViewEnabled: false })).not.toContain("reports");
  });

  it("applies the module switch on top: a page whose module is off disappears", () => {
    const off = key => key !== "opportunities" && key !== "reports";
    expect(visibleFinancialsPages({ roles: ["admin"] }, off)).toEqual(["quotes", "freight-audit", "credit-overrides", "customer-statements", "gl-export"]);
  });

  it("never offers a page outside the group, and copes with no roles at all", () => {
    expect(canSeeFinancialsPage("shipments", { roles: ["admin"] })).toBe(false);
    expect(see([])).toEqual(["quotes", "opportunities", "freight-audit", "customer-statements"]);
    expect(canSeeFinancialsPage("reports")).toBe(false);
  });

  it("gives GL Export to anyone with finance access, regardless of role", () => {
    expect(canSeeFinancialsPage("gl-export", { roles: ["viewer"], canViewFinance: true })).toBe(true);
    expect(canSeeFinancialsPage("gl-export", { roles: ["viewer"], canViewFinance: false })).toBe(false);
    expect(canSeeFinancialsPage("gl-export", { roles: ["admin"] })).toBe(true);
    expect(canSeeFinancialsPage("gl-export", { roles: ["operator"] })).toBe(true);
  });
});
