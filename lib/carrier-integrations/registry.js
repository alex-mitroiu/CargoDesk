"use strict";
// Carrier adapter registry (Epic TKT-KG4E49, story 2) — mirrors
// services/document-distribution/lib/channels.js's registerChannel()/distribute() exactly: a
// bare Map, handlers are plain objects of async (or pure) functions. Adding a carrier's adapter
// is one registerCarrierAdapter() call, never a new route — routes/edi.js and routes/system.js
// look an adapter up here by carrier_integrations.adapter_key, never import one directly.

const adapters = new Map();

function registerCarrierAdapter(key, handlers) {
  adapters.set(key, handlers);
}

function getCarrierAdapter(key) {
  return adapters.get(key) || null;
}

function listRegisteredAdapterKeys() {
  return [...adapters.keys()];
}

module.exports = { registerCarrierAdapter, getCarrierAdapter, listRegisteredAdapterKeys };
