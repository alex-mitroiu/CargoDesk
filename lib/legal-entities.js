"use strict";

// Which legal entity (branch) a shipment belongs to: its Export Managing Office's branch, else its
// Import Managing Office's. The VAT Liability report, consolidated statements (one entity per
// statement, TKT-1E55AR) and reverse-charge self-assessment (TKT-MQAXQX) all use this, so they
// can't disagree about where a charge is booked.
module.exports = function createLegalEntities({ query }) {
  // shipmentIds → Map(shipmentId → { entityId, entityName, currency, taxRegistrationNumber, countryCode, standardVatRate }).
  // A shipment with no branch on either office maps to entityId null.
  async function entityByShipment(shipmentIds) {
    const ids = [...new Set((shipmentIds || []).filter(Boolean))];
    if (!ids.length) return new Map();
    const rows = await query(`
      SELECT s.id AS shipment_id, b.id AS entity_id, b.name AS entity_name, b.currency AS entity_currency,
             b.tax_registration_number AS entity_tax_number, b.country_code AS entity_country, b.standard_vat_rate AS entity_vat_rate
      FROM shipments s
      LEFT JOIN offices  emo_office ON emo_office.id = s.emo_office_id
      LEFT JOIN branches emo_branch ON emo_branch.id = emo_office.branch_id
      LEFT JOIN offices  imo_office ON imo_office.id = s.imo_office_id
      LEFT JOIN branches imo_branch ON imo_branch.id = imo_office.branch_id
      LEFT JOIN branches b ON b.id = COALESCE(emo_branch.id, imo_branch.id)
      WHERE s.id IN (${ids.map((_, i) => `$${i + 1}`).join(",")})`, ids);
    return new Map(rows.map(r => [r.shipment_id, {
      entityId: r.entity_id || null,
      entityName: r.entity_name || "",
      currency: r.entity_currency || "USD",
      taxRegistrationNumber: r.entity_tax_number || "",
      countryCode: r.entity_country || "",
      standardVatRate: r.entity_vat_rate ?? null,
    }]));
  }
  return { entityByShipment };
};
