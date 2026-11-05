// Shared helper for rendering a shipment leg's From/To endpoint — a Pick-up/Delivery leg to a
// classified-location customer identifies its endpoint by GPS coordinates instead of a UN/LOCODE
// (see the "GPS Coordinates" pol_loc_type/pod_loc_type value, routes/shipments.js). Every leg-level
// display surface should go through this instead of reading leg.pol/pod/polName/podName directly,
// so a GPS leg never shows a blank or broken port name.

export const GPS_LOC_TYPE = "GPS Coordinates";

// Hoisted out of ShipmentFormPage.jsx, which had two ad hoc copies of this exact list (its leg
// editor's loc-type dropdown) with no shared constant anywhere — a third ad hoc copy for the new
// Merchant's Haulage waypoints picker would have made it a real, more widely-duplicated one.
export const LOC_TYPE_OPTIONS = ["Door", "Terminal", "Container Yard", "CFS"];

export const isGpsLeg = (leg, side) => leg?.[`${side}LocType`] === GPS_LOC_TYPE;

// A SEA leg runs terminal to terminal, both ends, whatever is stored (agreed 2026-11-03; the server
// forces it too, routes/shipments.js). Reaching a container yard, CFS or door is its own Pick-up or
// Delivery leg. Every other leg's type is its own, blank meaning Terminal.
export const legLocType = (leg, side) =>
  (leg?.legType || "SEA") === "SEA" ? "Terminal" : (leg?.[`${side}LocType`] || "Terminal");

export const formatLegPoint = (leg, side) => {
  if (isGpsLeg(leg, side)) {
    const lat = leg[`${side}Latitude`], lng = leg[`${side}Longitude`];
    return {
      code: (lat != null && lng != null) ? `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}` : "GPS",
      name: "Classified location",
    };
  }
  return { code: leg?.[side] || "", name: leg?.[`${side}Name`] || "" };
};
