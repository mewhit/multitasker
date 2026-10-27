const fs = require('node:fs');

const keys = ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'SLACK_REDIRECT_URI', 'SLACK_BOT_SCOPES', 'SLACK_USER_SCOPES'];

function readEnv(file) {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z0-9_]+)\s*=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

function buildConfig(file, env = process.env) {
  const local = readEnv(file);
  const config = {};
  for (const key of keys) {
    const value = (env[key] || local[key] || '').trim();
    if (value) config[key] = value;
  }
  const missing = keys.slice(0, 2).filter(key => !config[key]);
  if (missing.length) throw new Error(`Slack packaging requires ${missing.join(' and ')} in extension/slack/.env or the build environment.`);
  return config;
}

function applyConfig(config, localFile, env = process.env) {
  const local = readEnv(localFile);
  for (const key of keys) {
    if (!env[key]?.trim() && !local[key]?.trim() && config[key]) env[key] = config[key];
  }
}

module.exports = { buildConfig, applyConfig };
