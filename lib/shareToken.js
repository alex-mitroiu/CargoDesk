"use strict";
const crypto = require("crypto");

// HMAC-SHA256 token helpers — avoids a JWT dependency for public tokens. Originally lived in
// routes/share.js (the public shipment-tracking link); extracted here so the document-scoped
// share token (webhook download links) can reuse the exact same mechanism.
function signToken(payload, secret) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyToken(token, secret) {
  const [data, sig] = token.split(".");
  if (!data || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const sigBuf = Buffer.from(sig), expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws (rather than returning false) when the two buffers differ in length —
  // a real, live-reproducible bug on this public, unauthenticated endpoint: any malformed token
  // (a mistyped link, a crawler probing the URL) with a wrong-length signature crashed with a raw
  // 500 instead of the clean 400 this function already returns for every other malformed shape.
  // The length check itself leaks nothing an attacker doesn't already know — a valid signature is
  // always exactly this HMAC's fixed digest length.
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;
  try { return JSON.parse(Buffer.from(data, "base64url").toString()); }
  catch { return null; }
}

module.exports = { signToken, verifyToken };
