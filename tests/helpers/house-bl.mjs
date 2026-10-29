// A shipment whose House B/L can be issued (Epic TKT-C7EBU3, lib/house-bl.js readiness): realistic,
// complete data. Shipper, consignee and notify with addresses, the consignee with an LEI (DCSA needs
// an identifying code on a named consignee), NLRTM → USNYC on MAEU with vessel and voyage, one sealed
// 40' HC with packages and an HS code, the booking confirmed by the built-in DCSA carrier, and (unless
// { loaded: false }) the container's Gate In and Loaded events, and (unless { numbered: false }) its B/L
// number taken from the export office's series, as the House B/L panel takes it before it prints the
// final copy (gap G5). Each suite passes its own request:
//   request(method, path, body, token) → Promise<{ status, body }>

import { ensureOffices } from "./offices.mjs";
import { bookThroughCarrier } from "./dcsa-sim.mjs";

const inDays = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const asList = b => (Array.isArray(b) ? b : (b?.results ?? []));

// The House B/L names its issuer (lib/house-bl.js readiness, the House B/L audit's M2, 2026-10-29): the export
// office's legal entity, with a SCAC, a street address and a city. Provisions it where the test database
// has none (a fresh CI database's fixture office has no legal entity at all) or an incomplete one —
// realistic data, as the shipments are. Idempotent: a complete legal entity is left as it is.
export async function ensureIssuingEntity(request, token, officeId) {
  const office = asList((await request("GET", "/api/offices", null, token)).body).find(o => o.id === officeId);
  if (!office) throw new Error(`ensureIssuingEntity: office ${officeId} not found`);
  if (office.branchId) {
    const b = (await request("GET", `/api/branches/${office.branchId}`, null, token)).body;
    if (b?.scac && b.address && b.city && b.countryCode) return b.id;
    const r = await request("PUT", `/api/branches/${office.branchId}`, { ...b, scac: b.scac || "CDHB",
      address: b.address || "Wilhelminakade 909", city: b.city || "Rotterdam", phone: b.phone || "+31 10 555 0142",
      email: b.email || "documentation@cargodesk.example" }, token);
    if (r.status !== 200) throw new Error(`ensureIssuingEntity: branch ${office.branchId}: ${r.status} ${JSON.stringify(r.body)}`);
    return office.branchId;
  }
  const code = `HB${String(officeId).replace(/[^A-Z0-9]/gi, "").slice(-6).toUpperCase()}`;
  const existing = asList((await request("GET", "/api/branches", null, token)).body).find(x => x.code === code);
  const branch = existing || (await request("POST", "/api/branches", { code, name: `CargoDesk Logistics ${office.name || code} BV`, countryCode: "NL",
    city: "Rotterdam", address: "Wilhelminakade 909", locode: "NLRTM", currency: "EUR", email: "documentation@cargodesk.example",
    phone: "+31 10 555 0142", scac: "CDHB", taxRegistrationNumber: "NL004495445B01" }, token)).body;
  if (!branch?.id) throw new Error(`ensureIssuingEntity: no legal entity for ${officeId}: ${JSON.stringify(branch)}`);
  const r = await request("PUT", `/api/offices/${officeId}`, { branchId: branch.id }, token);
  if (r.status !== 200) throw new Error(`ensureIssuingEntity: office ${officeId}: ${r.status} ${JSON.stringify(r.body)}`);
  return branch.id;
}

export async function readyHouseBlShipment(request, token, { tag = "", releaseType = "Original", freightTerms = "Prepaid", loaded = true, numbered = true,
  emoOfficeId: emoOverride = null } = {}) {
  const rand = `${tag}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const offices = await ensureOffices(token);
  const emoOfficeId = emoOverride || offices.emoOfficeId, imoOfficeId = offices.imoOfficeId;
  await ensureIssuingEntity(request, token, emoOfficeId);
  const customer = async (companyName, address1, postalCode, city, countryIso2) =>
    (await request("POST", "/api/customers", { companyName, address1, postalCode, city, countryIso2 }, token)).body;
  const shipper = await customer(`Van Leeuwen Furniture ${rand} BV`, "Waalhaven Oostzijde 81", "3087 BM", "Rotterdam", "NL");
  const consignee = await customer(`Hudson Home Imports ${rand} Inc`, "250 Port Jersey Blvd", "07305", "Jersey City", "US");
  await request("POST", `/api/customers/${consignee.id}/identifiers`, { idType: "LEI", idCode: `5493001KJTIIGC8Y1R${String(Date.now()).slice(-2)}`, countryIso2: "US" }, token);

  const shipment = (await request("POST", "/api/shipments", {
    pol: "NLRTM", pod: "USNYC", carrierCode: "MAEU", status: "Active", contractType: "Central", contractRef: "MAEU-SC-2026-0418",
    etd: inDays(3), eta: inDays(14), incoterm: "FOB", commodityCode: "9999", cargoReadyDate: inDays(1),
    blReleaseType: releaseType, freightTerms, vessel: "MAERSK KENSINGTON", voyage: "443W",
    shipperId: shipper.id, shipperName: shipper.companyName, consigneeId: consignee.id, consigneeName: consignee.companyName,
    notifyId: consignee.id, notifyName: consignee.companyName,
    principalId: shipper.id, principalName: shipper.companyName, emoOfficeId, imoOfficeId,
  }, token)).body;
  const container = (await request("POST", "/api/containers", {
    shipmentId: shipment.id, containerNumber: `MSKU${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 10)}`,
    sealNumber: `ML-${String(Date.now()).slice(-6)}`, size: "40", type: "HC",
    hsCode: "940360", cargoDescription: "Flat-pack wooden furniture", marksAndNumbers: "VLF/NYC 1-1200",
    grossWeightKg: 18400, volumeCbm: 64, numberOfPackages: 1200, packageCode: "CT",
  }, token)).body;
  await request("POST", `/api/shipments/${shipment.id}/milestones/init`, {}, token);
  const booked = await bookThroughCarrier(request, token, shipment.id);
  if (loaded) {
    await request("POST", `/api/shipments/${shipment.id}/containers/${container.id}/events`, { eventType: "Gate In", occurredAt: `${inDays(-1)}T09:30:00Z`, location: "NLRTM" }, token);
    await request("POST", `/api/shipments/${shipment.id}/containers/${container.id}/events`, { eventType: "Loaded", occurredAt: `${inDays(0)}T06:15:00Z`, location: "NLRTM" }, token);
  }
  if (numbered) shipment.blNumber = await assignHouseBlNumber(request, token, shipment.id);
  return { shipment, container, shipper, consignee, booking: booked.booking, emoOfficeId, imoOfficeId };
}

// The number the House B/L will be issued under (POST …/house-bl/number): the shipment's, or the next
// from its export office's series. Returns the number.
export async function assignHouseBlNumber(request, token, shipmentId) {
  const r = await request("POST", `/api/shipments/${shipmentId}/house-bl/number`, {}, token);
  if (r.status !== 200) throw new Error(`House B/L number: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.number;
}

// Generates a House B/L draft (what the PDF prints is passed as `houseBl`) and returns the document.
export async function generateHouseBl(request, token, shipmentId, { name = "A", houseBl } = {}) {
  return request("POST", `/api/shipments/${shipmentId}/documents/generate`, {
    html: `<!doctype html><html><body><h1>House Bill of Lading ${name}</h1></body></html>`,
    filename: `BL01-${shipmentId}-${name}-${new Date().toISOString().slice(0, 10)}.html`, docType: "BL01",
    ...(houseBl && { houseBl }),
  }, token);
}
