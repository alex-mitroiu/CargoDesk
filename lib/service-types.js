"use strict";
// Which side a service type can be ordered under (audit A6, TKT-8IB8HX, 2026-11-21): VGM, Loading and Pickup are origin
// activities (Export only), Unloading and Delivery their destination mirror (Import only); a type with no entry is valid on
// both sides. The same list as the screens' SERVICE_TYPE_SIDES (src/shipmentServicePages.js), kept equal by
// src/shipmentServicePages.parity.test.js. The server refuses a side the type doesn't allow on POST and PATCH.
const SERVICE_TYPE_SIDES = Object.freeze({
  VGM:       ["Export"],
  Loading:   ["Export"],
  Pickup:    ["Export"],
  Unloading: ["Import"],
  Delivery:  ["Import"],
});

// → "" when the side is allowed, else the reason in words.
const sideProblem = (side, type) => {
  const allowed = SERVICE_TYPE_SIDES[type];
  return allowed && !allowed.includes(side) ? `A ${type} service is ordered on the ${allowed.join(" or ")} side only` : "";
};

module.exports = { SERVICE_TYPE_SIDES, sideProblem };
