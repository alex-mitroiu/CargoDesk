"use strict";

// An imported shipment sends nothing (2026-11-13, lib/shipment-transfer.js, ARCHITECTURE.md §8.50). server.js's
// shipmentImportGuard runs every request about an imported shipment inside this context ({ shipmentId }), and the
// low-level senders check it: carrierIntegrationFor finds no carrier connection, office mail refuses. So a route that
// sends from a helper still sends nothing, whatever the route's own guard knew. Automatic sweeps run outside any
// request: they leave imported shipments out in their own queries (shipments.imported_from).
const { AsyncLocalStorage } = require("async_hooks");

const importedShipmentContext = new AsyncLocalStorage();

// The message every refusal gives.
const importedSendError = id =>
  `${id || "This shipment"} is an imported shipment: it sends nothing (no emails, EDI, webhooks or carrier messages), so this can't be done here`;

module.exports = { importedShipmentContext, importedSendError };
