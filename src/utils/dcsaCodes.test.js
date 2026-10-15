import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { BOOKING_STATUS_LABEL, AMENDED_BOOKING_STATUS_LABEL, BOOKING_CANCELLATION_STATUS_LABEL, CARRIER_ACTIONS, dcsaLabel } from "./dcsaCodes";

// The backend's code lists (lib/dcsa/codes.js, checked against the published specs by
// tests/dcsa-standards.test.js) are the source; the screens' copy must not drift from them.
const require = createRequire(import.meta.url);
const codes = require("../../lib/dcsa/codes.js");
const asMap = list => Object.fromEntries(list.map(x => [x.code, x.label]));

describe("dcsaCodes mirrors lib/dcsa/codes.js", () => {
  it("booking states", () => expect(BOOKING_STATUS_LABEL).toEqual(asMap(codes.BOOKING_STATUS)));
  it("amendment states", () => expect(AMENDED_BOOKING_STATUS_LABEL).toEqual(asMap(codes.AMENDED_BOOKING_STATUS)));
  it("cancellation states", () => expect(BOOKING_CANCELLATION_STATUS_LABEL).toEqual(asMap(codes.BOOKING_CANCELLATION_STATUS)));
  it("labels any state and passes unknown codes through", () => {
    expect(dcsaLabel("PENDING_UPDATE")).toBe("Update required");
    expect(dcsaLabel("CANCELLATION_RECEIVED")).toBe("Cancellation requested");
    expect(dcsaLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(dcsaLabel("")).toBe("");
  });
});

describe("carrier actions", () => {
  it("cover exactly the simulator's decisions", () => {
    const src = require("node:fs").readFileSync(require.resolve("../../lib/dcsa-simulator/index.js"), "utf8");
    const block = src.slice(src.indexOf("const ACTIONS = {"), src.indexOf("};", src.indexOf("const ACTIONS = {")));
    const simKeys = [...block.matchAll(/^\s{4}(\w+):\s+\{/gm)].map(m => m[1]).sort();
    expect(Object.keys(CARRIER_ACTIONS).sort()).toEqual(simKeys);
  });
});
