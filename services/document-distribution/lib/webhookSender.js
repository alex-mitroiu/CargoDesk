"use strict";
const crypto = require("crypto");

// Pragmatic literal-address denylist — https only, blocks loopback/link-local/private-range
// literal hosts including the cloud-metadata address (169.254.169.254). This is NOT
// DNS-rebinding-proof (a hostname that resolves to a private IP at request time would slip
// through — real protection needs to resolve-then-check at connect time) — deliberately scoped
// "for the time being" per direct clarification, not a network-boundary control.
const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
function isPrivateLiteral(hostname) {
  if (BLOCKED_HOSTS.has(hostname)) return true;
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isUrlSafe(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== "https:") return false;
  if (isPrivateLiteral(parsed.hostname)) return false;
  return true;
}

// GitHub/Stripe-style signed payload — receiver recomputes and compares to prove authenticity.
function signPayload(payload, secret) {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

// Same 10s-timeout convention as the monolith's own outbound API call (routes/edi.js's Maersk
// booking request) — fail fast rather than hang the send action indefinitely.
async function sendWebhook(url, payload, secret) {
  const signature = signPayload(payload, secret);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CargoDesk-Signature": `sha256=${signature}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  return { httpStatus: r.status, ok: r.ok };
}

module.exports = { isUrlSafe, signPayload, sendWebhook };
