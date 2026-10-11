// Completed and Cancelled shipments are locked (TKT-SPXTGR, decided by the user 2026-10-09) — the client
// mirror of server.js's LOCKED_SHIPMENT_STATUSES / shipmentStatusLock. The server refuses every locked
// write on its own; this only decides what the UI offers. Locked: the header, parties, offices, legs,
// containers, schedules, carrier booking, shipping instructions, services and customs filings, and the
// status itself (Cancelled is final; Completed is locked the same way). Still open: finance (cost lines,
// invoices, credit notes), documents, messages, milestones and container events — those pages keep
// using canEditShipments on its own and never call this.
export const LOCKED_SHIPMENT_STATUSES = ["Completed", "Cancelled"];

export const isShipmentLocked = shipment => LOCKED_SHIPMENT_STATUSES.includes(shipment?.status);

export const lockedShipmentText = shipment =>
  `${shipment?.status} — the shipment's details are locked. Finance, documents, messages and milestones stay open.`;
