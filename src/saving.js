// ─── CargoDesk global saving state ────────────────────────────────────────────
// Counter-based (not boolean) so concurrent operations don't cancel each other.
// Any module calls saving.start() / saving.end().
// GlobalSavingOverlay subscribes and renders while count > 0.

const DEFAULT_MESSAGE = "Processing…";
const listeners = new Set();
let count = 0;
let message = DEFAULT_MESSAGE;

const notify = () => listeners.forEach(fn => fn(count > 0, message));

export const saving = {
  // msg is optional — every existing caller keeps seeing the generic "Processing…" copy;
  // a caller that wants something more specific (e.g. Contracts & Schedules' new staged-draft
  // Save, "Saving…") can pass it here.
  start: (msg) => { count++; if (msg) message = msg; notify(); },
  end:   () => { count = Math.max(0, count - 1); if (count === 0) message = DEFAULT_MESSAGE; notify(); },
};

export const subscribeSaving = fn => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
