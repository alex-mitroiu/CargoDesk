import { describe, it, expect } from "vitest";
import { presetChoices, takenCodes, summarizeChoices } from "./reconcileChoices";

const rows = [
  { chargeCode: "Ocean Freight", status: "changed" },
  { chargeCode: "Documentation Fee", status: "manual" },
  { chargeCode: "Origin THC", status: "new" },
  { chargeCode: "B/L Fee", status: "removed" },
  { chargeCode: "Bunker Adjustment Factor", status: "locked" },
  { chargeCode: "Destination THC", status: "match" },
  { chargeCode: "Haulage", status: "kept" },
];

describe("reconcile presets", () => {
  it("suggested: plain contract line and new charge taken, manual override and dropped charge kept", () => {
    expect(presetChoices(rows, "suggested")).toEqual({
      "Ocean Freight": "take", "Documentation Fee": "keep", "Origin THC": "take", "B/L Fee": "keep",
    });
  });

  it("take all contract rates reaches every takeable charge", () => {
    expect(Object.values(presetChoices(rows, "all"))).toEqual(["take", "take", "take", "take"]);
  });

  it("only add new charges takes nothing but the new one", () => {
    expect(takenCodes(rows, presetChoices(rows, "missing"))).toEqual(["Origin THC"]);
  });

  it("never offers a choice for locked, kept or matching charges", () => {
    const choices = presetChoices(rows, "all");
    expect(choices).not.toHaveProperty("Bunker Adjustment Factor");
    expect(choices).not.toHaveProperty("Haulage");
    expect(choices).not.toHaveProperty("Destination THC");
  });
});

describe("reconcile summary", () => {
  it("counts updates, additions and removals separately", () => {
    expect(summarizeChoices(rows, presetChoices(rows, "all"))).toEqual({ updated: 2, added: 1, removed: 1, total: 4 });
  });

  it("ignores a stray take on a charge that can't change", () => {
    expect(takenCodes(rows, { Haulage: "take", "Bunker Adjustment Factor": "take" })).toEqual([]);
  });
});
