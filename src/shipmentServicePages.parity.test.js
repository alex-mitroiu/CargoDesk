import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { SERVICE_TYPE_SIDES } from "./shipmentServicePages";

// The sides a service type can be ordered under exist twice: the screens offer only these (src/shipmentServicePages.js)
// and the server refuses anything else (lib/service-types.js, audit A6, 2026-11-21). Both must say the same.
const server = createRequire(import.meta.url)("../lib/service-types.js");

describe("service type sides", () => {
  it("the server's list is the screens' list", () => {
    expect(server.SERVICE_TYPE_SIDES).toEqual(SERVICE_TYPE_SIDES);
  });
  it("a Pickup on the Import side is refused, one on the Export side and a Storage on either side are not", () => {
    expect(server.sideProblem("Import", "Pickup")).toBe("A Pickup service is ordered on the Export side only");
    expect(server.sideProblem("Export", "Pickup")).toBe("");
    expect(server.sideProblem("Import", "Storage")).toBe("");
    expect(server.sideProblem("Export", "Storage")).toBe("");
  });
});
