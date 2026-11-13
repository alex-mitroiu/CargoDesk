// The History line for a field change (getEventSummary, ShipmentDetailPage.jsx): the parties are labelled (server.js
// TRACKED_FIELDS logs them since 2026-11-13), and a reason the server recorded — a principal moved by the incoterm rule,
// lib/incoterm-principal.js — follows the change.
import { describe, it, expect } from "vitest";
import { getEventSummary } from "./ShipmentDetailPage";

describe("History: a field change", () => {
  it("labels a party and shows why the principal moved", () => {
    expect(getEventSummary({
      eventType: "FIELD_UPDATED", field: "principal_name", oldValue: "Hudson Home Imports Inc", newValue: "Van Leeuwen Meubelen BV",
      meta: { reason: "Follows the incoterm CIF: shipper pays the main carriage" },
    })).toBe("Principal: Hudson Home Imports Inc → Van Leeuwen Meubelen BV  ·  Follows the incoterm CIF: shipper pays the main carriage");
  });

  it("shows a change with no reason as before", () => {
    expect(getEventSummary({ eventType: "FIELD_UPDATED", field: "consignee_name", oldValue: "", newValue: "Atlantic Living LLC", meta: {} }))
      .toBe("Consignee: Atlantic Living LLC");
    expect(getEventSummary({ eventType: "FIELD_UPDATED", field: "incoterm", oldValue: "FOB", newValue: "CIF", meta: null }))
      .toBe("Incoterm: FOB → CIF");
  });
});
