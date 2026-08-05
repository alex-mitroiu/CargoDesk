"use strict";
// Signed PDF Document Generation (Epic TKT-YOFYFZ) — HTML->PDF rendering and self-signed
// CAdES-detached CMS/PKCS#7 PDF signing (node-forge + @signpdf). See the shipped plan for the
// full research/rationale on the signing scheme.
//
// HTML->PDF rendering itself (Puppeteer driving a real installed browser) was extracted into
// services/pdf-render/ (TKT-SR7EOK) — the heaviest, most bursty piece of the monolith's
// runtime, previously sharing an event loop with the persistent AIS WebSocket listener and the
// live WS broadcast to browsers. renderHtmlToPdf below keeps its exact original name and
// signature (HTML in, raw PDF bytes out) so routes/shipment-ops.js's call site needed zero
// changes — only the implementation moved, from a local Puppeteer launch to an HTTP call.
// Cert lookup + signing stay here, unchanged: the signing key never leaves the monolith.
const os = require("os");
const forge = require("node-forge");
const { PDFDocument } = require("pdf-lib");
const { pdflibAddPlaceholder } = require("@signpdf/placeholder-pdf-lib");
const { P12Signer } = require("@signpdf/signer-p12");
const { default: signpdf } = require("@signpdf/signpdf");
const { SUBFILTER_ETSI_CADES_DETACHED, extractSignature } = require("@signpdf/utils");
const { readSecret } = require("./dockerSecret");

const PDF_RENDER_SERVICE_URL = process.env.PDF_RENDER_SERVICE_URL || "http://localhost:3003";
const PDF_RENDER_SECRET_DEV_DEFAULT = "cargoDesk-dev-pdf-render-secret-do-not-use-in-prod";
const PDF_RENDER_SERVICE_SECRET = readSecret("PDF_RENDER_SERVICE_SECRET", PDF_RENDER_SECRET_DEV_DEFAULT);
if (PDF_RENDER_SERVICE_SECRET === PDF_RENDER_SECRET_DEV_DEFAULT)
  console.warn("⚠  PDF_RENDER_SERVICE_SECRET not set (checked PDF_RENDER_SERVICE_SECRET_FILE, then PDF_RENDER_SERVICE_SECRET) — using insecure dev default. Set it (and the same value in the pdf-render service's own env) before deploying.");

// Renders a CargoDesk-generated HTML document (already fully self-contained — inline <style>,
// no external assets, same as every buildXHtml function in src/App.jsx produces) into a raw
// PDF buffer, via the pdf-render service. Same 10s-timeout / clean-503-on-unreachable pattern
// already established for the document-distribution service's own callDistributionService.
async function renderHtmlToPdf(html) {
  let r;
  try {
    r = await fetch(`${PDF_RENDER_SERVICE_URL}/internal/render`, {
      method: "POST",
      headers: { Authorization: `Bearer ${PDF_RENDER_SERVICE_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({ html }),
      signal: AbortSignal.timeout(30000), // a real render can take longer than a typical internal call
    });
  } catch {
    const e = new Error("PDF Render Service is unreachable — try again shortly");
    e.status = 503;
    throw e;
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    const e = new Error(data.error || `PDF Render Service returned HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return Buffer.from(await r.arrayBuffer());
}

// 2048-bit RSA + a 10-year self-signed X.509 cert, packaged as PKCS#12. No CA involved by
// design (see plan) — readers will show "signature valid, issuer not trusted", which is the
// accepted tradeoff; what matters is that the file is genuinely tamper-evident.
function generateSelfSignedSigningCert() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: "commonName", value: "CargoDesk Document Signing" },
    { name: "organizationName", value: "CargoDesk" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, nonRepudiation: true },
    { name: "extKeyUsage", emailProtection: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const passphrase = forge.util.encode64(forge.random.getBytesSync(24));
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, {
    algorithm: "aes256",
  });
  const p12Base64 = forge.util.encode64(forge.asn1.toDer(p12Asn1).getBytes());
  const fingerprint = forge.md.sha256.create()
    .update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
    .digest().toHex();

  return {
    certPem: forge.pki.certificateToPem(cert),
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    p12Base64,
    p12Passphrase: passphrase,
    fingerprintSha256: fingerprint,
    subject: "CN=CargoDesk Document Signing, O=CargoDesk",
    notBefore: cert.validity.notBefore.toISOString(),
    notAfter: cert.validity.notAfter.toISOString(),
  };
}

function getActiveSigningCert(db) {
  const row = db.prepare("SELECT * FROM org_signing_certs WHERE status = 'active' ORDER BY created_at DESC LIMIT 1").get();
  if (!row) throw new Error("No active signing certificate found.");
  return row;
}

// Embeds a signature placeholder (pdf-lib), then fills it with a real CAdES-detached
// CMS/PKCS#7 signature over the exact PDF bytes (@signpdf + node-forge, via the cert's own
// PKCS#12 bundle). useObjectStreams:false is required — @signpdf locates the placeholder by
// scanning the raw, uncompressed PDF byte stream.
async function signPdfBuffer(pdfBuffer, certRow) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  pdflibAddPlaceholder({
    pdfDoc,
    reason: "Generated by CargoDesk",
    contactInfo: "",
    name: "CargoDesk Document Signing",
    location: os.hostname(),
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
  });
  const placeholdered = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  const signer = new P12Signer(Buffer.from(certRow.p12_base64, "base64"), {
    passphrase: certRow.p12_passphrase,
  });
  return signpdf.sign(placeholdered, signer);
}

// node-forge's own pkcs7 module can build detached CMS signatures but not verify them
// ("PKCS#7 signature verification not yet implemented" — thrown by forge itself), so this
// reimplements the two checks a real verifier does: (1) the signer's RSA signature is valid
// over the DER-serialized authenticatedAttributes SET, and (2) that SET's messageDigest
// attribute matches a fresh SHA-256 of the actual signed byte range. (2) is what catches
// tampering — the signature in (1) stays "valid" for the attributes as originally signed
// even after the content changes; it's the digest recorded in those attributes going stale
// that exposes the edit. Mirrors forge's own pkcs7.js sign() step for step, in reverse.
function verifySignedPdf(pdfBuffer) {
  const { signature, signedData } = extractSignature(pdfBuffer);
  const p7Asn1 = forge.asn1.fromDer(signature);
  const p7 = forge.pkcs7.messageFromAsn1(p7Asn1);
  const rc = p7.rawCapture;
  const cert = p7.certificates[0];

  const messageDigestAttr = rc.authenticatedAttributes.find(
    attr => forge.asn1.derToOid(attr.value[0].value) === forge.pki.oids.messageDigest
  );
  const claimedDigest = messageDigestAttr.value[1].value[0].value;
  const actualDigest = forge.md.sha256.create().update(signedData.toString("binary")).digest().getBytes();
  const digestMatches = claimedDigest === actualDigest;

  // Attributes are captured under their storage tag ([0] IMPLICIT) — RFC 2315 requires
  // re-wrapping them as a plain SET OF before DER-serializing for the signature payload.
  const attrsAsn1 = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, rc.authenticatedAttributes);
  const attrsDigest = forge.md.sha256.create().update(forge.asn1.toDer(attrsAsn1).getBytes()).digest().bytes();
  const signatureValid = cert.publicKey.verify(attrsDigest, rc.signature);

  return { digestMatches, signatureValid, integrity: digestMatches && signatureValid, certSubject: cert.subject.getField("CN")?.value || "" };
}

module.exports = {
  renderHtmlToPdf,
  generateSelfSignedSigningCert,
  getActiveSigningCert,
  signPdfBuffer,
  verifySignedPdf,
};
