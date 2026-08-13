"use strict";

// Reusable in-memory rate limiter — same Map + periodic-cleanup pattern originally built twice,
// independently, for login and forgot-password (routes/auth.js). One shared implementation so
// every additional limiter doesn't re-derive the same window/sweep bookkeeping. Each call site
// still gets its OWN Map/interval (a fresh closure per createRateLimiter call) — limiters are
// never accidentally shared across unrelated routes just because they reuse this factory.
//
// keyFn defaults to per-IP (req.ip) — the right default for public/unauthenticated routes.
// Routes gating an authenticated, expensive action should pass keyFn: req => req.user.id instead,
// so the limit tracks the actual actor rather than a shared office IP/NAT address.
function createRateLimiter({ windowMs, max, maxEnvVar, keyFn, message }) {
  const envOverride = maxEnvVar ? Number(process.env[maxEnvVar]) : 0;
  const effectiveMax = envOverride > 0 ? envOverride : max;
  const attemptsByKey = new Map(); // key -> { count, windowStart }

  const sweep = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of attemptsByKey) if (v.windowStart < cutoff) attemptsByKey.delete(k);
  }, 60_000);
  sweep.unref?.();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.ip;
    const now = Date.now();
    let rec = attemptsByKey.get(key);
    if (!rec || now - rec.windowStart > windowMs) {
      rec = { count: 0, windowStart: now };
      attemptsByKey.set(key, rec);
    }
    rec.count++;
    if (rec.count > effectiveMax) {
      return res.status(429).json({ error: message || "Too many requests — please try again later" });
    }
    next();
  };
}

module.exports = { createRateLimiter };
