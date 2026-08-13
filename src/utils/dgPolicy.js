// Shared by ShipmentContainersPage.jsx and ShipmentDetailPage.jsx's ContainerForm — both
// previously carried their own near-identical inline copy of this check. Mirrors (but is a
// separate copy of, per this app's standing frontend/backend split) routes/shipments.js's own
// checkDgPolicy — that one runs server-side against a shipment id at write time; this one runs
// client-side against an already-fetched { dgAllowed, imdgClasses } contract snapshot, purely
// for inline UI validation/badging before a save is even attempted.
export function dgPolicyConflict(dgPolicy, isDg, dgClass) {
  if (!isDg || !dgClass || !dgPolicy) return null;
  if (!dgPolicy.dgAllowed) return "Contract does not permit DG cargo";
  if (dgPolicy.imdgClasses.length > 0 && !dgPolicy.imdgClasses.includes(dgClass))
    return `IMO class ${dgClass} not permitted by contract (allowed: ${dgPolicy.imdgClasses.join(", ")})`;
  return null;
}
