// ─── The principal an incoterm implies (2026-11-13) — the client copy of lib/incoterm-principal.js ──────────────────────
// Keep the two identical: incotermPrincipal.parity.test.js runs both on the same cases. With a C or D term the seller pays
// the main carriage, so the SHIPPER is the principal; with an E or F term the buyer arranges it, so the CONSIGNEE is. The
// principal "follows" while it is empty or is the party the incoterm implied; one someone chose is never moved.

export const SELLER_PAYS = ["CPT", "CIP", "CFR", "CIF", "DAP", "DPU", "DDP"];
export const BUYER_PAYS = ["EXW", "FCA", "FAS", "FOB"];

// "Shipper" | "Consignee" | null (no incoterm, or one CargoDesk doesn't know).
export const payerOf = incoterm => {
  const c = String(incoterm || "").trim().toUpperCase();
  return SELLER_PAYS.includes(c) ? "Shipper" : BUYER_PAYS.includes(c) ? "Consignee" : null;
};

// p = { shipperId, shipperName, consigneeId, consigneeName } → { id, name, role } | null.
export function impliedPrincipal(incoterm, p = {}) {
  const role = payerOf(incoterm);
  if (role === "Shipper" && p.shipperId) return { id: p.shipperId, name: p.shipperName || "", role };
  if (role === "Consignee" && p.consigneeId) return { id: p.consigneeId, name: p.consigneeName || "", role };
  return null;
}

// Did the principal follow the rule? (empty, or the party the incoterm implied). A principal given by name only, with no
// customer id, was typed by someone: it is theirs, not the rule's (audit 2026-11-13, D5).
export const follows = s => (!s.principalId && !String(s.principalName || "").trim()) || impliedPrincipal(s.incoterm, s)?.id === s.principalId;

// The principal after the incoterm or the parties change, from before → after → { id, name, moved }.
export function followPrincipal(before, after) {
  const keep = { id: before.principalId || "", name: before.principalName || "", moved: false };
  if (!follows(before)) return keep;
  const now = impliedPrincipal(after.incoterm, after);
  if (!now) return keep;
  return { id: now.id, name: now.name, moved: now.id !== (before.principalId || "") };
}

// A shipment object (camelCase) → the shape the rule reads.
export const principalShape = s => ({ incoterm: s.incoterm || "", shipperId: s.shipperId || "", shipperName: s.shipperName || "",
  consigneeId: s.consigneeId || "", consigneeName: s.consigneeName || "", principalId: s.principalId || "", principalName: s.principalName || "" });

// A form update with the principal moved when it follows (else the update as it is).
export const withFollowedPrincipal = (before, after) => {
  const r = followPrincipal(before, after);
  return { ...after, principalId: r.id, principalName: r.name };
};

// The line under a Principal field while the principal is the party the incoterm implies ("" otherwise).
export const principalHintText = s => {
  const imp = impliedPrincipal(s.incoterm, s);
  return imp && imp.id === s.principalId ? `From the incoterm: ${String(s.incoterm).toUpperCase()}, so the ${imp.role.toLowerCase()} pays the main carriage` : "";
};
