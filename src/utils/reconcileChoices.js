// Per-charge decisions for the Reconcile Carrier Costs modal. Each takeable charge is either
// "keep" (leave the existing lines) or "take" (use the contract); locked / kept / match charges
// have no choice and are never sent. Mirrors RECONCILE_TAKEABLE in server.js.
export const RECONCILE_TAKEABLE = ["changed", "manual", "new", "removed"];

// Approved defaults (2026-09-29 mockup): a plain contract line follows the contract, a human's
// correction is kept, a new charge is added, a charge the contract dropped is kept.
const SUGGESTED = { changed: "take", manual: "keep", new: "take", removed: "keep" };

export const RECONCILE_PRESETS = {
  suggested: status => SUGGESTED[status],
  all:       () => "take",
  missing:   status => (status === "new" ? "take" : "keep"),
};

export const presetChoices = (rows, preset) =>
  Object.fromEntries(rows.filter(r => RECONCILE_TAKEABLE.includes(r.status))
    .map(r => [r.chargeCode, RECONCILE_PRESETS[preset](r.status)]));

export const takenCodes = (rows, choices) =>
  rows.filter(r => RECONCILE_TAKEABLE.includes(r.status) && choices[r.chargeCode] === "take").map(r => r.chargeCode);

export const summarizeChoices = (rows, choices) => {
  const counts = { updated: 0, added: 0, removed: 0 };
  for (const r of rows) {
    if (!RECONCILE_TAKEABLE.includes(r.status) || choices[r.chargeCode] !== "take") continue;
    if (r.status === "new") counts.added++;
    else if (r.status === "removed") counts.removed++;
    else counts.updated++;
  }
  return { ...counts, total: counts.updated + counts.added + counts.removed };
};
