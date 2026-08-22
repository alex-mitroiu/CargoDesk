"use strict";
// Office-Level Email Distribution (Epic TKT-O4B0IB) — generic SMTP, configured per office.
// See the shipped plan for the full research/rationale (why nodemailer, the 3-mode transport
// mapping, why no connection pooling at this volume).
const nodemailer = require("nodemailer");

const SECURE_MODE_OPTIONS = {
  none:     { secure: false, ignoreTLS: true },
  starttls: { secure: false, requireTLS: true },
  tls:      { secure: true },
};

// connectionTimeout/greetingTimeout/socketTimeout are set explicitly so a bad host/port fails
// fast (10s) instead of hanging a settings-save or send-document request indefinitely.
function buildTransportOptions({ smtpHost, smtpPort, secureMode, smtpUsername, smtpPassword }) {
  const modeOpts = SECURE_MODE_OPTIONS[secureMode] || SECURE_MODE_OPTIONS.starttls;
  return {
    host: smtpHost,
    port: smtpPort,
    ...modeOpts,
    auth: smtpUsername ? { user: smtpUsername, pass: smtpPassword || "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
  };
}

function createTransporterFromSettings(settings) {
  return nodemailer.createTransport(buildTransportOptions(settings));
}

// One non-pooled transporter per office, cached — cheap to hold (no pooling means no idle open
// sockets), avoids rebuilding/reparsing config on every send. Invalidated whenever that
// office's settings are saved (invalidateTransporterCache).
const transporterCache = new Map();

function getTransporterForOffice(db, officeId) {
  if (transporterCache.has(officeId)) return transporterCache.get(officeId);
  const row = db.prepare("SELECT * FROM office_mail_settings WHERE office_id = ?").get(officeId);
  if (!row || !row.is_active) {
    throw new Error("Configure SMTP settings for the shipment's Export Managing Office first.");
  }
  const transporter = createTransporterFromSettings({
    smtpHost: row.smtp_host, smtpPort: row.smtp_port, secureMode: row.secure_mode,
    smtpUsername: row.smtp_username, smtpPassword: row.smtp_password,
  });
  transporterCache.set(officeId, transporter);
  return transporter;
}

function invalidateTransporterCache(officeId) {
  transporterCache.delete(officeId);
}

function buildMailOptions({ from, fromName, to, subject, message, attachmentPath, attachmentFilename, attachmentContent, attachmentContentType }) {
  const opts = {
    from: fromName ? `"${fromName}" <${from}>` : from,
    to,
    subject,
    text: message,
  };
  if (attachmentPath) {
    opts.attachments = [{ filename: attachmentFilename, path: attachmentPath, contentType: "application/pdf" }];
  } else if (attachmentContent != null) {
    // In-memory attachment (e.g. a generated CSV report, TKT-IXAR9G) — no file on disk needed,
    // unlike the signed-PDF case above which always originates from a real uploaded document.
    opts.attachments = [{ filename: attachmentFilename, content: attachmentContent, contentType: attachmentContentType || "application/octet-stream" }];
  }
  return opts;
}

async function sendViaOffice(db, officeId, mailOptions) {
  const transporter = getTransporterForOffice(db, officeId);
  return transporter.sendMail(mailOptions);
}

module.exports = {
  buildTransportOptions,
  createTransporterFromSettings,
  getTransporterForOffice,
  invalidateTransporterCache,
  buildMailOptions,
  sendViaOffice,
};
