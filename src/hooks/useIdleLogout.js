import { useEffect, useRef } from "react";
import { TOKEN_KEY } from "../api";

const ACTIVITY_KEY   = "cargodesk_last_activity";
const REASON_KEY      = "cargodesk_logout_reason";
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"];
const WRITE_THROTTLE_MS = 5_000;
const CHECK_INTERVAL_MS = 15_000;

// Idle-timeout auto-logout, aware of every open tab. Activity anywhere writes a shared
// localStorage timestamp, so any tab (including a shipment opened in a second tab) keeps the
// whole session alive — idle is a property of the session, not of one forgotten tab. When one
// tab's timer actually crosses the threshold, it clears the shared auth token exactly like a
// 401 already does; every OTHER open tab hears that via the native `storage` event (which never
// fires in the tab that made the change, only the others) and logs itself out too, with no
// polling or custom cross-tab channel needed.
export default function useIdleLogout({ enabled, timeoutMinutes, onIdle }) {
  const lastWriteRef = useRef(0);
  const firedRef     = useRef(false);

  // Broadcast listener — active regardless of `enabled`, so a tab already sitting on the login
  // page (or one whose own timer hasn't fired yet) still reacts the instant another tab clears
  // the shared token. TOKEN_KEY also gets cleared by a plain manual "Log out" click and by a
  // 401 in any tab — REASON_KEY is what actually distinguishes "this was the idle timeout"
  // from those (the originating tab sets it BEFORE clearing the token, synchronously, so it's
  // already correct by the time this event fires); handleLogin clears REASON_KEY on every
  // successful login so a stale "inactivity" flag can never survive to mislabel a later,
  // unrelated logout.
  useEffect(() => {
    const onStorage = e => {
      if (e.key === TOKEN_KEY && !e.newValue && localStorage.getItem(REASON_KEY) === "inactivity") {
        onIdle({ broadcastOnly: true });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [onIdle]);

  useEffect(() => {
    if (!enabled || !timeoutMinutes) return;
    firedRef.current = false;
    // A fresh login is itself recent activity — avoid inheriting a stale timestamp from hours
    // ago and looking idle immediately.
    localStorage.setItem(ACTIVITY_KEY, String(Date.now()));

    const recordActivity = () => {
      const now = Date.now();
      if (now - lastWriteRef.current < WRITE_THROTTLE_MS) return;
      lastWriteRef.current = now;
      localStorage.setItem(ACTIVITY_KEY, String(now));
    };
    ACTIVITY_EVENTS.forEach(evt => document.addEventListener(evt, recordActivity, { passive: true }));

    const checkIdle = () => {
      if (firedRef.current) return;
      const last = Number(localStorage.getItem(ACTIVITY_KEY)) || 0;
      if (Date.now() - last >= timeoutMinutes * 60_000) {
        firedRef.current = true;
        onIdle();
      }
    };
    const intervalId = setInterval(checkIdle, CHECK_INTERVAL_MS);

    return () => {
      ACTIVITY_EVENTS.forEach(evt => document.removeEventListener(evt, recordActivity));
      clearInterval(intervalId);
    };
  }, [enabled, timeoutMinutes, onIdle]);
}
