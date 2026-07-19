// ─── Navigation guard (TKT-OJYO71) ────────────────────────────────────────────
// Lets a currently-open, dirty in-page form (e.g. the Add/Edit Container modal on
// the Cargo page) intercept sidebar/section navigation — rather than the shipment
// create/edit form's plain confirm-then-discard (formDirtyRef in App.jsx, a
// separate, already-working mechanism this does not replace), this attempts
// auto-validate + auto-save first and only blocks navigation, with a concrete
// error, if validation actually fails. A single registration slot is enough since
// only one such form can realistically be open/focused at a time.

let guard = null; // { trySave: () => Promise<{ ok: boolean, error?: string }> }

export const setNavigationGuard = g => { guard = g; };
export const clearNavigationGuard = () => { guard = null; };

// Returns { proceed: true } if there's nothing to check, the form is clean, or it
// validated and saved successfully. Returns { proceed: false, error } otherwise —
// callers should surface `error` (e.g. via toast) and abort the navigation.
export const runNavigationGuard = async () => {
  if (!guard) return { proceed: true };
  try {
    const result = await guard.trySave();
    return result.ok ? { proceed: true } : { proceed: false, error: result.error };
  } catch (e) {
    return { proceed: false, error: e.message || "Failed to save before leaving this section" };
  }
};
