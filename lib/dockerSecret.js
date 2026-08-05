"use strict";
// Docker Compose's native `secrets:` mechanism mounts a secret at /run/secrets/<name> instead
// of passing it via `environment:` — it never shows up in `docker inspect` or a process env
// dump the way an environment-variable secret does, which is the actual point of using it.
// Convention (matches official Docker images like postgres/mysql): an env var named
// `${NAME}_FILE` pointing at that mounted file takes priority over the plain `${NAME}` env var,
// which takes priority over a dev default — so this still works unchanged for anyone running
// the app directly (npm run dev) or via `docker run -e` without Compose secrets at all.
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
