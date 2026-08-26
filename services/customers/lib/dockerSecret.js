"use strict";
// Duplicated from the monolith's lib/dockerSecret.js (and every other extracted service's own
// copy) — no shared module between independent processes.
const fs = require("fs");

function readSecret(envVarName, devDefault) {
  const filePath = process.env[`${envVarName}_FILE`];
  if (filePath) {
    try {
      return fs.readFileSync(filePath, "utf8").trim();
    } catch (e) {
      console.error(`⚠  Could not read ${envVarName}_FILE (${filePath}): ${e.message} — falling back to ${envVarName}`);
    }
  }
  return process.env[envVarName] || devDefault;
}

module.exports = { readSecret };
