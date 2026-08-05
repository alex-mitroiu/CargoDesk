"use strict";
// Duplicated from the monolith's lib/dockerSecret.js — no shared module between independent
// processes (same reasoning as roundCents' own frontend/backend duplication). See that file's
// comment for why this exists: Docker Compose's native `secrets:` mechanism mounts a secret at
// /run/secrets/<name> instead of passing it via `environment:`, which never shows up in
// `docker inspect` the way an environment-variable secret does.
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
