import { describe, it, expect } from "vitest";
import { sailingFollowsLine, lineRouteText } from "./sailingRouting";
import { lineChain } from "./routingLines";

const sailing = (...ports) => ({ vesselName: "TEST", legs: ports.slice(0, -1).map((p, i) => ({ pol: p, pod: ports[i + 1] })) });

describe("sailingFollowsLine", () => {
  const viaRotterdam = ["NLRTM"];

  it("takes the line's own transshipments and the direct sailings (DEHAM via NLRTM to USNYC)", () => {
    expect(sailingFollowsLine(sailing("DEHAM", "NLRTM", "USNYC"), viaRotterdam)).toBe(true);
    expect(sailingFollowsLine(sailing("DEHAM", "USNYC"), viaRotterdam)).toBe(true);
  });

  it("leaves out a transshipment via another port, or via more ports", () => {
    expect(sailingFollowsLine(sailing("DEHAM", "BEANR", "USNYC"), viaRotterdam)).toBe(false);
    expect(sailingFollowsLine(sailing("DEHAM", "NLRTM", "BEANR", "USNYC"), viaRotterdam)).toBe(false);
  });

  it("needs a two-hub line's ports in the same order", () => {
    expect(sailingFollowsLine(sailing("CNSHA", "SGSIN", "NLRTM", "USNYC"), ["SGSIN", "NLRTM"])).toBe(true);
    expect(sailingFollowsLine(sailing("CNSHA", "NLRTM", "SGSIN", "USNYC"), ["SGSIN", "NLRTM"])).toBe(false);
  });

  it("gives a direct line direct sailings only", () => {
    expect(sailingFollowsLine(sailing("DEHAM", "USNYC"), [])).toBe(true);
    expect(sailingFollowsLine(sailing("DEHAM", "NLRTM", "USNYC"), [])).toBe(false);
  });

  it("counts a sailing with no leg breakdown, or one leg, as direct; compares codes case-insensitively", () => {
    expect(sailingFollowsLine({ vesselName: "X" }, viaRotterdam)).toBe(true);
    expect(sailingFollowsLine(sailing("DEHAM", "nlrtm", "USNYC"), viaRotterdam)).toBe(true);
  });
});

describe("the line's ports come from its contract legs", () => {
  it("lineChain lists every transshipment port in order", () => {
    const legs = [{ pol: "DEHAM", pod: "NLRTM" }, { pol: "NLRTM", pod: "USNYC" }];
    expect(lineChain(legs).hubs).toEqual(["NLRTM"]);
    expect(lineChain([{ pol: "DEHAM", pod: "USNYC" }]).hubs).toEqual([]);
    expect(lineRouteText(["SGSIN", "NLRTM"])).toBe("via SGSIN → NLRTM");
    expect(lineRouteText([])).toBe("direct");
  });
});
