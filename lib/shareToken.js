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
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(data, "base64url").toString()); }
  catch { return null; }
}

module.exports = { signToken, verifyToken };
