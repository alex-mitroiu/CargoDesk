"use strict";

// ─── The principal an incoterm implies (2026-11-13, documentation/incoterms-principal-and-charges.html) ─────────────────
// Who pays the main carriage under the Incoterms 2020 rule: with a C or D term the seller pays it, so the SHIPPER is the
// principal (the customer the shipment is billed to); with an E or F term the buyer arranges it, so the CONSIGNEE is.
// One rule for the New/Edit Shipment form, the Conditions and Parties pages, the API and quote conversion. The client
// copy (src/utils/incotermPrincipal.js) must stay identical: incotermPrincipal.parity.test.js checks it.
//
// The principal "follows" while it is empty or is the party the incoterm implied; a principal someone chose (a third
// party, a parent company, the shipper under FOB) is never moved by a change of incoterm or parties.

const SELLER_PAYS = ["CPT", "CIP", "CFR", "CIF", "DAP", "DPU", "DDP"];
const BUYER_PAYS = ["EXW", "FCA", "FAS", "FOB"];

// "Shipper" | "Consignee" | null (no incoterm, or one CargoDesk doesn't know).
const payerOf = incoterm => {
  const c = String(incoterm || "").trim().toUpperCase();
  return SELLER_PAYS.includes(c) ? "Shipper" : BUYER_PAYS.includes(c) ? "Consignee" : null;
};

// p = { shipperId, shipperName, consigneeId, consigneeName } → { id, name, role } | null.
function impliedPrincipal(incoterm, p = {}) {
  const role = payerOf(incoterm);
  if (role === "Shipper" && p.shipperId) return { id: p.shipperId, name: p.shipperName || "", role };
  if (role === "Consignee" && p.consigneeId) return { id: p.consigneeId, name: p.consigneeName || "", role };
  return null;
}

// Did the principal follow the rule? (empty, or the party the incoterm implied). A principal given by name only, with no
// customer id, was typed by someone: it is theirs, not the rule's (audit 2026-11-13, D5).
const follows = s => (!s.principalId && !String(s.principalName || "").trim()) || impliedPrincipal(s.incoterm, s)?.id === s.principalId;

// The principal after the incoterm or the parties change, from before → after (each { incoterm, shipperId, shipperName,
// consigneeId, consigneeName, principalId, principalName }) → { id, name, moved }.
function followPrincipal(before, after) {
  const keep = { id: before.principalId || "", name: before.principalName || "", moved: false };
  if (!follows(before)) return keep;
  const now = impliedPrincipal(after.incoterm, after);
  if (!now) return keep;
  return { id: now.id, name: now.name, moved: now.id !== (before.principalId || "") };
}

module.exports = { SELLER_PAYS, BUYER_PAYS, payerOf, impliedPrincipal, follows, followPrincipal };
