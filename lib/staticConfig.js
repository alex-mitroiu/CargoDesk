"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const CONFIG_PATH = path.join(__dirname, "..", "config", "app-settings.yaml");

// Same disclosed-default posture JWT_SECRET already uses for a missing env var — a working
// default rather than a boot-time crash, with a visible warning so it isn't silently relied on.
const DEFAULTS = {
  session: { idleTimeoutMinutes: 30 },
};

function loadStaticConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = yaml.load(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("empty or non-object YAML");
    return {
      session: {
        idleTimeoutMinutes: Number(parsed.session?.idleTimeoutMinutes) || DEFAULTS.session.idleTimeoutMinutes,
      },
    };
  } catch (e) {
    console.warn(`⚠  config/app-settings.yaml not read (${e.message}) — using defaults (idleTimeoutMinutes: ${DEFAULTS.session.idleTimeoutMinutes}).`);
    return DEFAULTS;
  }
}

// Read once at process start — this is static, code-deploy-level config, not a live-editable
// setting (see the file's own header comment).
module.exports = loadStaticConfig();
