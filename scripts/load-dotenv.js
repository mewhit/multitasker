"use strict";

/**
 * Tiny .env loader for dev scripts. We don't pull in the dotenv package
 * because the dev tooling has zero runtime deps. Behavior matches the
 * subset of dotenv we need:
 *   - KEY=value lines, blanks and `#` comments ignored
 *   - Optional surrounding single or double quotes are stripped
 *   - Existing process.env entries WIN (process env > .env file)
 */
const fs = require("node:fs");
const path = require("node:path");

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadDotenv(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return;
  const text = fs.readFileSync(resolved, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    process.env[key] = unquote(line.slice(eq + 1).trim());
  }
}

module.exports = { loadDotenv };
