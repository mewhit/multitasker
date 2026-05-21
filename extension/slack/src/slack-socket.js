'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SLACK_API_URL = 'https://slack.com/api';
const DEFAULT_MULTITASKER_EVENT_URL = 'http://127.0.0.1:39017/slack-event';
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;

loadDotEnv();

const appToken = readEnv('SLACK_APP_TOKEN');
const multitaskerEventUrl =
  readEnv('MULTITASKER_SLACK_EVENT_URL') ||
  getEventUrl(readEnv('MULTITASKER_SLACK_NOTIFICATION_URL')) ||
  DEFAULT_MULTITASKER_EVENT_URL;
const logRawEvents = readEnv('SLACK_LOG_RAW_EVENTS') === '1';

if (!appToken) {
  console.error('Missing SLACK_APP_TOKEN. Create a Slack app, enable Socket Mode, and set an xapp token with connections:write.');
  process.exit(1);
}

if (typeof WebSocket !== 'function') {
  console.error('This connector needs Node 22+ with the global WebSocket API.');
  process.exit(1);
}

let activeSocket;
let stopped = false;

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

void run();

async function run() {
  let reconnectDelayMs = RECONNECT_INITIAL_MS;

  while (!stopped) {
    try {
      await connectSocketMode();
      reconnectDelayMs = RECONNECT_INITIAL_MS;
    } catch (error) {
      console.error(`Slack connector failed: ${getErrorMessage(error)}`);
    }

    if (stopped) return;
    console.log(`Reconnecting Slack Socket Mode in ${reconnectDelayMs}ms...`);
    await delay(reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
  }
}

async function connectSocketMode() {
  const socketUrl = await openSlackSocketModeUrl();

  await new Promise((resolve, reject) => {
    let opened = false;
    const socket = new WebSocket(socketUrl);
    activeSocket = socket;

    socket.addEventListener('open', () => {
      opened = true;
      console.log('Connected to Slack Socket Mode.');
    });

    socket.addEventListener('message', event => {
      void handleSocketMessage(socket, event.data).catch(error => {
        console.error(`Slack message forwarding failed: ${getErrorMessage(error)}`);
      });
    });

    socket.addEventListener('error', () => {
      if (!opened) reject(new Error('Slack Socket Mode connection failed.'));
    });

    socket.addEventListener('close', () => {
      if (activeSocket === socket) activeSocket = undefined;
      console.log('Slack Socket Mode disconnected.');
      resolve(undefined);
    });
  });
}

async function openSlackSocketModeUrl() {
  const response = await fetch(`${SLACK_API_URL}/apps.connections.open`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${appToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: '{}',
  });
  const data = await response.json();
  if (!response.ok || data.ok !== true) {
    throw new Error(`apps.connections.open failed: ${data.error || `HTTP ${response.status}`}`);
  }

  const socketUrl = readString(data, 'url');
  if (!socketUrl) throw new Error('Slack did not return a Socket Mode URL.');
  return socketUrl;
}

async function handleSocketMessage(socket, data) {
  const envelope = parseJson(readSocketData(data));
  if (!envelope) return;
  if (logRawEvents) logSlackRawEvent(envelope);

  const envelopeId = readString(envelope, 'envelope_id');
  if (envelopeId) socket.send(JSON.stringify({ envelope_id: envelopeId }));

  if (readString(envelope, 'type') !== 'events_api') return;
  await postSlackEvent(envelope);
  logSlackEventForwarded(envelope);
}

async function postSlackEvent(envelope) {
  const response = await fetch(multitaskerEventUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(envelope),
  });
  if (!response.ok) {
    throw new Error(`Multitasker rejected Slack event: HTTP ${response.status}`);
  }
}

function logSlackRawEvent(envelope) {
  console.log(`Slack raw event ${JSON.stringify(envelope)}`);
}

function logSlackEventForwarded(envelope) {
  const payload = readRecord(envelope, 'payload');
  const event = payload ? readRecord(payload, 'event') : undefined;
  console.log(
    `Slack event forwarded envelopeId=${JSON.stringify(readString(envelope, 'envelope_id'))}` +
    ` eventId=${JSON.stringify(readString(payload, 'event_id'))}` +
    ` channelId=${JSON.stringify(readString(event, 'channel'))}` +
    ` ts=${JSON.stringify(readString(event, 'ts') || readString(event, 'event_ts'))}`
  );
}

function readSocketData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return String(data);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function readRecord(record, key) {
  if (!record || typeof record !== 'object') return undefined;
  const value = key ? record[key] : record;
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

function getEventUrl(notificationUrl) {
  if (!notificationUrl) return '';

  try {
    const url = new URL(notificationUrl);
    url.pathname = '/slack-event';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
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

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stop() {
  stopped = true;
  if (activeSocket) activeSocket.close();
}
