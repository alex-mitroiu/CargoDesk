// ─── CargoDesk toast notification system ─────────────────────────────────────
// Pub-sub: any module calls toast.success/error/warning/info — ToastContainer
// subscribes and renders. No React context required.

const listeners = new Set();
let _id = 0;

const emit = (type, message, duration) => {
  const id = ++_id;
  listeners.forEach(fn => fn({ id, type, message, duration }));
};

export const toast = {
  success: (msg, dur = 10000)  => emit("success", msg, dur),
  error:   (msg, dur = 10000)  => emit("error",   msg, dur),
  warning: (msg, dur = 10000)  => emit("warning", msg, dur),
  info:    (msg, dur = 10000)  => emit("info",    msg, dur),
};

export const subscribe = fn => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};