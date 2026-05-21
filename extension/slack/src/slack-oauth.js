'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

const SLACK_AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const SLACK_OAUTH_ACCESS_URL = 'https://slack.com/api/oauth.v2.access';
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:39018/slack/oauth/callback';
const DEFAULT_BOT_SCOPES = 'channels:read,groups:read,im:read,mpim:read,users:read';
const DEFAULT_USER_SCOPES = [
  'channels:history',
  'channels:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'users:read',
].join(',');

const envPath = path.join(__dirname, '..', '.env');

loadDotEnv();

const clientId = readEnv('SLACK_CLIENT_ID');
const clientSecret = readEnv('SLACK_CLIENT_SECRET');
const redirectUri = readEnv('SLACK_REDIRECT_URI') || DEFAULT_REDIRECT_URI;
const botScopes = readEnv('SLACK_BOT_SCOPES') || DEFAULT_BOT_SCOPES;
const userScopes = readEnv('SLACK_USER_SCOPES') || DEFAULT_USER_SCOPES;
const openBrowserEnabled = readEnv('SLACK_OAUTH_OPEN_BROWSER') !== '0';

if (!clientId || !clientSecret) {
  console.error('Missing SLACK_CLIENT_ID or SLACK_CLIENT_SECRET. Add them to extension\\slack\\.env first.');
  process.exit(1);
}

void run().catch(error => {
  console.error(`Slack OAuth failed: ${getErrorMessage(error)}`);
  process.exit(1);
});

async function run() {
  const redirectUrl = new URL(redirectUri);
  if (redirectUrl.protocol !== 'http:' || !isLocalhost(redirectUrl.hostname)) {
    throw new Error('SLACK_REDIRECT_URI must be a local http URL, for example http://127.0.0.1:39018/slack/oauth/callback');
  }

  const state = randomBytes(24).toString('hex');
  const authorizeUrl = buildAuthorizeUrl(state);
  const server = http.createServer((request, response) => {
    void handleCallbackRequest(request, response, redirectUrl, state, server);
  });

  await listen(server, redirectUrl);
  console.log(`Listening for Slack OAuth callback on ${redirectUri}`);
  console.log('Opening Slack authorization URL...');
  console.log(authorizeUrl);
  if (openBrowserEnabled) openBrowser(authorizeUrl);
}

function buildAuthorizeUrl(state) {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  if (botScopes.trim()) url.searchParams.set('scope', normalizeScopeList(botScopes));
  if (userScopes.trim()) url.searchParams.set('user_scope', normalizeScopeList(userScopes));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

async function handleCallbackRequest(request, response, redirectUrl, expectedState, server) {
  const requestUrl = new URL(request.url || '/', redirectUri);
  if (requestUrl.pathname !== redirectUrl.pathname) {
    writeHtml(response, 404, '<h1>Not found</h1>');
    return;
  }

  const error = requestUrl.searchParams.get('error');
  if (error) {
    process.exitCode = 1;
    writeHtml(response, 400, `<h1>Slack OAuth failed</h1><p>${escapeHtml(error)}</p>`);
    closeServerSoon(server);
    return;
  }

  const state = requestUrl.searchParams.get('state') || '';
  const code = requestUrl.searchParams.get('code') || '';
  if (!code || state !== expectedState) {
    process.exitCode = 1;
    writeHtml(response, 400, '<h1>Invalid Slack OAuth callback</h1>');
    closeServerSoon(server);
    return;
  }

  try {
    const tokenResponse = await exchangeCode(code);
    const updates = buildEnvUpdates(tokenResponse);
    updateEnvFile(updates);
    writeHtml(response, 200, '<h1>Slack connected</h1><p>You can close this tab and start the Multitasker Slack connector.</p>');
    console.log('Slack OAuth completed. Updated extension\\slack\\.env with returned token values.');
    console.log('Run: npm start --prefix extension\\slack');
  } catch (exchangeError) {
    process.exitCode = 1;
    writeHtml(response, 500, `<h1>Slack OAuth token exchange failed</h1><p>${escapeHtml(getErrorMessage(exchangeError))}</p>`);
    console.error(`Slack OAuth token exchange failed: ${getErrorMessage(exchangeError)}`);
  } finally {
    closeServerSoon(server);
  }
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  const response = await fetch(SLACK_OAUTH_ACCESS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const payload = await response.json();
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

function buildEnvUpdates(tokenResponse) {
  const updates = {};
  const authedUser = readRecord(tokenResponse, 'authed_user');
  const userId = readString(authedUser, 'id');
  const userToken = readString(authedUser, 'access_token');
  const botToken = readString(tokenResponse, 'access_token');
  const team = readRecord(tokenResponse, 'team');
  const teamId = readString(team, 'id');
  const teamName = readString(team, 'name');

  if (userId) updates.SLACK_USER_ID = userId;
  if (userToken) updates.SLACK_USER_TOKEN = userToken;
  if (botToken) updates.SLACK_BOT_TOKEN = botToken;
  if (teamId) updates.SLACK_TEAM_ID = teamId;
  if (teamName) updates.SLACK_TEAM_NAME = teamName;
  return updates;
}

function updateEnvFile(updates) {
  if (!updates.SLACK_USER_TOKEN) {
    throw new Error('Slack did not return a user token. Check that user_scope is set and reinstall/authorize the app.');
  }

  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const remainingUpdates = { ...updates };
  const nextLines = lines.map(line => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match || !(match[1] in remainingUpdates)) return line;

    const key = match[1];
    const value = remainingUpdates[key];
    delete remainingUpdates[key];
    return `${key}=${escapeEnvValue(value)}`;
  });

  for (const [key, value] of Object.entries(remainingUpdates)) {
    nextLines.push(`${key}=${escapeEnvValue(value)}`);
  }

  fs.writeFileSync(envPath, `${nextLines.filter((line, index, all) => line || index < all.length - 1).join('\n')}\n`, 'utf8');
}

function listen(server, redirectUrl) {
  const port = Number(redirectUrl.port || 80);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, redirectUrl.hostname, () => resolve(undefined));
  });
}

function openBrowser(url) {
  const command = process.platform === 'win32'
    ? 'powershell.exe'
    : process.platform === 'darwin'
      ? 'open'
      : 'xdg-open';
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $args[0]', url]
    : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
  });
  child.unref();
}

function closeServerSoon(server) {
  setTimeout(() => {
    server.close();
  }, 500);
}

function writeHtml(response, statusCode, body) {
  const html = `<!doctype html><html><body>${body}</body></html>`;
  response.writeHead(statusCode, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
  });
  response.end(html);
}

function normalizeScopeList(value) {
  return value
    .split(',')
    .map(scope => scope.trim())
    .filter(Boolean)
    .join(',');
}

function loadDotEnv() {
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith('#')) continue;

    const equalsIndex = trimmedLine.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = trimmedLine.slice(0, equalsIndex).trim();
    const value = unquoteEnvValue(trimmedLine.slice(equalsIndex + 1).trim());
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeEnvValue(value) {
  return String(value).replace(/\r?\n/g, '');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readRecord(record, key) {
  if (!record || typeof record !== 'object') return undefined;
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function readString(record, key) {
  if (!record || typeof record !== 'object') return '';
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readEnv(key) {
  const value = process.env[key];
  return typeof value === 'string' ? value.trim() : '';
}

function isLocalhost(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
