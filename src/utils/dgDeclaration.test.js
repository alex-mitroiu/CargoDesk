import { describe, it, expect } from "vitest";
import { dispatchDocBuilder, getMissingDocRequirements } from "./documentBuilders";

// DG01, the Dangerous Goods Declaration: its emergency contact is the shipper's own 24-hour contact, from the
// shipper's customer profile (2026-10-29, the user's call: the shipper knows the goods; no fallback to the
// forwarder's or a hotline). It is the same contact the DCSA booking sends.

const shipment = { id: "SHP-DG0001", shipperName: "Van Wijk Coatings B.V.", consigneeName: "Atlantic Paint Supply LLC", pol: "NLRTM", pod: "USNYC",
  vessel: "MAERSK KENSINGTON", voyage: "443W" };
const containers = [{ containerNumber: "MSKU1647203", size: "40", type: "HC", isDg: true, dgClass: "3", dgUnNumber: "1263",
  dgProperShippingName: "PAINT", grossWeightKg: 16200, numberOfPackages: 80, packageCode: "DR" }];
const contact = { contact: "Van Wijk DG Desk", phone: "+31 10 437 2299", provider: "CHEMTREC", referenceNumber: "CCN-204417" };
const shipper = { companyName: "Van Wijk Coatings B.V.", dgEmergencyContact: contact };
const consignee = { companyName: "Atlantic Paint Supply LLC" };

describe("DG01, the emergency contact", () => {
  it("prints the shipper's contact: name, 24-hour phone, provider and reference", () => {
    const h = dispatchDocBuilder("DG01", { shipment, invNumber: "SHP-DG0001-DG", invDate: "2026-10-29", notes: "", containers, shipper, consignee });
    expect(h).toContain("Van Wijk DG Desk");
    expect(h).toContain("24-hour phone: +31 10 437 2299");
    expect(h).toContain("Provider: CHEMTREC");
    expect(h).toContain("Reference: CCN-204417");
    expect(h).not.toContain("CANUTEC");
  });
  it("leaves out provider and reference when the shipper has none", () => {
    const h = dispatchDocBuilder("DG01", { shipment, invNumber: "X", invDate: "2026-10-29", notes: "", containers, consignee,
      shipper: { ...shipper, dgEmergencyContact: { contact: "Van Wijk DG Desk", phone: "+31 10 437 2299", provider: "", referenceNumber: "" } } });
    expect(h).toContain("24-hour phone: +31 10 437 2299");
    expect(h).not.toContain("Provider:");
    expect(h).not.toContain("Reference:");
  });
  it("won't generate when the shipper has no contact, and says where to add it", () => {
    const missing = getMissingDocRequirements("DG01", { shipment, containers, shipper: { companyName: "Van Wijk Coatings B.V.", dgEmergencyContact: null },
      consignee, costLines: [], parties: [] });
    expect(missing).toContain("The shipper's dangerous goods emergency contact (on the shipper's customer profile)");
    expect(getMissingDocRequirements("DG01", { shipment, containers, shipper, consignee, costLines: [], parties: [] })).toEqual([]);
  });
});
