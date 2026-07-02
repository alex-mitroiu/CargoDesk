// ─── CargoDesk global saving state ────────────────────────────────────────────
// Counter-based (not boolean) so concurrent operations don't cancel each other.
// Any module calls saving.start() / saving.end().
// GlobalSavingOverlay subscribes and renders while count > 0.

const listeners = new Set();
let count = 0;

const notify = () => listeners.forEach(fn => fn(count > 0));

export const saving = {
  start: () => { count++; notify(); },
  end:   () => { count = Math.max(0, count - 1); notify(); },
};

export const subscribeSaving = fn => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
