"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const node_http_1 = require("node:http");
const web_api_1 = require("@slack/web-api");
const sessionManager_1 = require("./sessionManager");
const shellServerClient_1 = require("./shellServerClient");
const settings_1 = require("./settings");
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const WINDOW_MIN_WIDTH = 960;
const WINDOW_MIN_HEIGHT = 600;
const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;
const MIN_VISIBLE_WINDOW_AREA = 100;
const TERMINAL_UPDATE_HOST = '127.0.0.1';
const TERMINAL_UPDATE_PORT = 39017;
const TERMINAL_UPDATE_PATH = '/terminal-update';
const TERMINAL_EVENT_PATH = '/terminal-event';
const SLACK_EVENT_PATH = '/slack-event';
const SLACK_NOTIFICATION_PATH = '/slack-notification';
const SLACK_NOTIFICATION_DISMISS_PATH = '/slack-notification-dismiss';
const EXTENSION_SLACK_EVENT_PATH = '/extensions/slack/events';
const EXTENSION_SLACK_NOTIFICATION_PATH = '/extensions/slack/notifications';
const EXTENSION_SLACK_NOTIFICATION_DISMISS_PATH = '/extensions/slack/notification-dismiss';
const BACKEND_EVENTS_PATH = '/api/events';
const BACKEND_HEALTH_PATH = '/api/health';
const BACKEND_STATE_PATH = '/api/state';
const BACKEND_SERVER_SCRIPT_RELATIVE_PATH = node_path_1.default.join('..', 'http-server', 'server.js');
const BACKEND_START_TIMEOUT_MS = 5000;
const BACKEND_HEALTH_POLL_MS = 100;
const BACKEND_EVENT_RECONNECT_MS = 1000;
const LEGACY_IN_PROCESS_BACKEND_ENV = 'MULTITASKER_USE_IN_PROCESS_BACKEND';
const MAX_TERMINAL_EVENT_BODY_BYTES = 512 * 1024;
const MAX_MANUAL_TASKS = 200;
const MAX_MANUAL_TASK_TEXT_LENGTH = 4000;
const MAX_RECURRING_TASKS = 100;
const RECURRING_TASK_CHECK_INTERVAL_MS = 30 * 1000;
const MAX_SLACK_NOTIFICATIONS = 100;
const MAX_SLACK_TEXT_LENGTH = 4000;
const MAX_SLACK_DEBUG_TEXT_LENGTH = 700;
const MAX_PENDING_TERMINAL_EVENTS_PER_SESSION = 200;
const DEBUG_LOG_DIRECTORY = node_path_1.default.join('.tmp', 'desktop');
const DEBUG_LOG_FILE_EXTENSION = '.log';
const TERMINAL_UPDATE_DEBUG_ENV = 'MULTITASKER_DEBUG_TERMINAL';
const SLACK_AUTH_DEBUG_LOG_FILE = 'slack-auth.log';
const SLACK_SOCKET_DEBUG_LOG_FILE = 'slack-connector.log';
const SLACK_OAUTH_SCRIPT_RELATIVE_PATH = node_path_1.default.join('extension', 'slack', 'src', 'slack-oauth.js');
const SLACK_SOCKET_SCRIPT_RELATIVE_PATH = node_path_1.default.join('extension', 'slack', 'src', 'slack-socket.js');
const SLACK_AUTH_OUTPUT_MAX_LENGTH = 4000;
const SLACK_SOCKET_OUTPUT_MAX_LENGTH = 4000;
const SLACK_USER_CONVERSATIONS_REFRESH_MS = 5 * 60 * 1000;
const GOOGLE_CALENDAR_SCOPE = 'openid email profile https://www.googleapis.com/auth/calendar.readonly';
const GOOGLE_CALENDAR_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const GOOGLE_CALENDAR_API_BASE_URL = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_CALENDAR_OAUTH_HOST = '127.0.0.1';
const GOOGLE_CALENDAR_OAUTH_CALLBACK_PATH = '/oauth/google-calendar/callback';
const GOOGLE_CALENDAR_AUTH_TIMEOUT_MS = 2 * 60 * 1000;
const GOOGLE_CALENDAR_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const GOOGLE_CALENDAR_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;
const MAX_GOOGLE_CALENDAR_EVENTS = 100;
const SLACK_PRIORITY_MENTION = { rank: 0, label: 'mention' };
const SLACK_PRIORITY_DM = { rank: 1, label: 'dm' };
const SLACK_PRIORITY_THREAD_MENTION = { rank: 2, label: 'thread_mention' };
const SLACK_PRIORITY_THREAD_WRITTEN = { rank: 3, label: 'thread_written' };
const SLACK_PRIORITY_OTHER = { rank: 4, label: 'other' };
const SLACK_AUTHORIZE_URL_PATTERN = /https:\/\/slack\.com\/oauth\/v2\/authorize\?\S+/;
let mainWindow = null;
let sessionManager = null;
let terminalUpdateServer = null;
let backendProcess = null;
let backendStartupPromise = null;
let backendEventRequest = null;
let backendEventReconnectTimer = null;
let backendEventBuffer = '';
let backendAvailable = false;
let isQuitting = false;
let windowStateSaveTimer = null;
const pendingTerminalUpdates = new Map();
const pendingTerminalEvents = new Map();
const taskIdByTerminalRef = new Map();
const terminalDebugLogFileBySessionId = new Map();
const reportedDebugLogWriteFailures = new Set();
const manualTasks = [];
const recurringTasks = [];
const slackNotifications = [];
const googleCalendarEvents = [];
const backendState = {
    sessions: [],
    manualTasks,
    recurringTasks,
    slackNotifications,
};
const slackUserNameById = new Map();
const slackBotNameById = new Map();
const slackChannelInfoById = new Map();
const slackClientByToken = new Map();
const slackThreadWrittenByAuthedUser = new Map();
let slackAuthProcess = null;
let slackAuthOutput = '';
let slackAuthAuthorizeUrl = '';
let slackAuthBrowserOpenRequested = false;
let slackSocketProcess = null;
let slackSocketOutput = '';
let slackSocketConnected = false;
let slackSocketLastError = '';
let slackListenerStatus = null;
let slackApiEnv = {};
let slackAuthedUserId = '';
let slackAuthedUserConversationIds;
let slackAuthedUserConversationsLoadedAt = 0;
let recurringTaskTimer = null;
let googleCalendarRefreshTimer = null;
let googleCalendarAuthServer = null;
let googleCalendarLastSyncedAt = 0;
let googleCalendarOAuthConfigCache = { clientId: '', hasClientSecret: false };
function isLocalShellType(value) {
    return value === 'powershell' || value === 'bash';
}
function isShellType(value) {
    return isLocalShellType(value) || value === 'ssh';
}
function isSessionStatus(value) {
    return (value === 'waiting' ||
        value === 'starting' ||
        value === 'running' ||
        value === 'needs_attention' ||
        value === 'error' ||
        value === 'stopped' ||
        value === 'detached');
}
function isTerminalEventType(value) {
    return (value === 'terminal_opened' ||
        value === 'terminal_attached' ||
        value === 'terminal_capture_state' ||
        value === 'shell_execution_started' ||
        value === 'terminal_output' ||
        value === 'shell_execution_ended' ||
        value === 'terminal_closed' ||
        value === 'terminal_disconnected' ||
        value === 'terminal_visible' ||
        value === 'terminal_interacted');
}
function isTerminalCaptureState(value) {
    return value === 'waiting_for_execution' || value === 'capturing' || value === 'unavailable';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function readStringField(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}
function readOptionalNumberField(record, key) {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function readOptionalBooleanField(record, key) {
    const value = record[key];
    return typeof value === 'boolean' ? value : undefined;
}
class HttpBodyTooLargeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HttpBodyTooLargeError';
    }
}
function normalizePathForCompare(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return '';
    return node_path_1.default.normalize(trimmed).replace(/[\\/]+$/g, '').toLowerCase();
}
function getLegacyAttachedTerminalPid(sessionId) {
    const match = /^attached:(\d+):/.exec(sessionId);
    if (!match?.[1])
        return undefined;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function rememberTaskTerminalBinding(taskId, binding) {
    const previousTerminalRef = sessionManager?.getSession(taskId)?.terminalRef?.trim();
    const terminalRef = binding.terminalRef?.trim();
    if (previousTerminalRef && terminalRef && previousTerminalRef !== terminalRef) {
        taskIdByTerminalRef.delete(previousTerminalRef);
    }
    if (terminalRef)
        taskIdByTerminalRef.set(terminalRef, taskId);
    sessionManager?.bindSessionToTerminal(taskId, buildTerminalBinding({
        terminalRef,
        terminalPid: binding.terminalPid,
        terminalCaptureState: binding.captureState,
        terminalCaptureReason: binding.captureReason,
    }));
}
function buildTerminalBinding(binding) {
    const terminalBinding = {};
    const terminalRef = binding.terminalRef?.trim();
    if (terminalRef)
        terminalBinding.terminalRef = terminalRef;
    if (binding.terminalPid !== undefined)
        terminalBinding.terminalPid = binding.terminalPid;
    if (binding.terminalCaptureState)
        terminalBinding.terminalCaptureState = binding.terminalCaptureState;
    const terminalCaptureReason = binding.terminalCaptureReason?.trim();
    if (terminalCaptureReason)
        terminalBinding.terminalCaptureReason = terminalCaptureReason;
    return terminalBinding;
}
function startSlackAuthFlow() {
    if (slackAuthProcess && slackAuthProcess.exitCode === null && !slackAuthProcess.killed) {
        if (slackAuthAuthorizeUrl) {
            openSlackAuthorizeUrl(slackAuthAuthorizeUrl, true);
        }
        return { ok: true, message: 'Slack authorization is already running.' };
    }
    const scriptPath = getSlackScriptPath(SLACK_OAUTH_SCRIPT_RELATIVE_PATH);
    if (!scriptPath) {
        return { ok: false, message: 'Slack OAuth script was not found under extension\\slack.' };
    }
    const electronRunAsNode = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    slackAuthOutput = '';
    slackAuthAuthorizeUrl = '';
    slackAuthBrowserOpenRequested = false;
    const child = (0, node_child_process_1.spawn)(process.execPath, [scriptPath], {
        cwd: node_path_1.default.dirname(node_path_1.default.dirname(scriptPath)),
        env: {
            ...process.env,
            ...electronRunAsNode,
            SLACK_OAUTH_OPEN_BROWSER: '0',
        },
        windowsHide: true,
    });
    slackAuthProcess = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        handleSlackAuthStdout(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        appendSlackAuthOutput(chunk);
    });
    child.on('error', error => {
        if (slackAuthProcess === child)
            slackAuthProcess = null;
        notifySlackAuthStatus(false, `Slack authorization could not start: ${getErrorMessage(error)}`);
    });
    child.on('exit', code => {
        if (slackAuthProcess === child)
            slackAuthProcess = null;
        if (code === 0) {
            notifySlackAuthStatus(true, 'Slack authorization completed.');
            restartSlackSocketListener({ notifyIfMissingConfig: true });
            return;
        }
        const details = slackAuthOutput.trim();
        notifySlackAuthStatus(false, details || `Slack authorization exited with code ${code ?? 'unknown'}.`);
    });
    notifySlackAuthStatus(true, 'Slack authorization started. Complete the flow in your browser.');
    return { ok: true, message: 'Slack authorization started. Complete the flow in your browser.' };
}
function startSlackSocketListener(options) {
    if (slackSocketProcess && slackSocketProcess.exitCode === null && !slackSocketProcess.killed) {
        return {
            ok: true,
            message: slackSocketConnected ? 'Slack listener is already connected.' : 'Slack listener is already starting.',
        };
    }
    const scriptPath = getSlackScriptPath(SLACK_SOCKET_SCRIPT_RELATIVE_PATH);
    if (!scriptPath) {
        const message = 'Slack Socket Mode script was not found under extension\\slack.';
        if (options.notifyIfMissingConfig)
            notifySlackListenerStatus(false, message);
        return { ok: false, message };
    }
    const slackEnv = readSlackEnvForScript(scriptPath);
    resetSlackApiState(slackEnv);
    const appToken = getSlackApiEnvValue('SLACK_APP_TOKEN');
    if (!appToken.trim()) {
        const message = 'Slack OAuth completed, but the listener needs SLACK_APP_TOKEN=xapp-... in extension\\slack\\.env.';
        if (options.notifyIfMissingConfig)
            notifySlackListenerStatus(false, message);
        return { ok: false, message };
    }
    if (isSlackOnlyUserChannelsEnabled() && !getSlackUserToken()) {
        const message = 'Slack listener needs SLACK_USER_TOKEN=xoxp-... when SLACK_ONLY_USER_CHANNELS is enabled.';
        if (options.notifyIfMissingConfig)
            notifySlackListenerStatus(false, message);
        return { ok: false, message };
    }
    const electronRunAsNode = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    slackSocketOutput = '';
    slackSocketConnected = false;
    slackSocketLastError = '';
    const child = (0, node_child_process_1.spawn)(process.execPath, [scriptPath], {
        cwd: node_path_1.default.dirname(node_path_1.default.dirname(scriptPath)),
        env: {
            ...process.env,
            ...slackEnv,
            ...electronRunAsNode,
        },
        windowsHide: true,
    });
    slackSocketProcess = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        handleSlackSocketOutput(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        handleSlackSocketOutput(chunk);
    });
    child.on('error', error => {
        if (slackSocketProcess !== child)
            return;
        if (slackSocketProcess === child)
            slackSocketProcess = null;
        slackSocketConnected = false;
        notifySlackListenerStatus(false, `Slack listener could not start: ${getErrorMessage(error)}`);
    });
    child.on('exit', code => {
        if (slackSocketProcess !== child)
            return;
        slackSocketProcess = null;
        slackSocketConnected = false;
        const details = slackSocketOutput.trim();
        const stoppedCleanly = code === 0 || code === null;
        notifySlackListenerStatus(stoppedCleanly, stoppedCleanly
            ? 'Slack listener stopped.'
            : details || `Slack listener exited with code ${code}.`);
    });
    notifySlackListenerStatus(true, 'Slack listener starting.');
    return { ok: true, message: 'Slack listener starting.' };
}
function restartSlackSocketListener(options) {
    stopSlackSocketListener();
    return startSlackSocketListener(options);
}
function getSlackScriptPath(relativePath) {
    const candidates = [
        node_path_1.default.join(electron_1.app.getAppPath(), relativePath),
        node_path_1.default.join(process.cwd(), relativePath),
        node_path_1.default.join(__dirname, '..', relativePath),
        node_path_1.default.join(__dirname, '..', '..', relativePath),
    ];
    return candidates.find(candidate => node_fs_1.default.existsSync(candidate)) ?? null;
}
function appendSlackAuthOutput(chunk) {
    appendDebugLogFile(SLACK_AUTH_DEBUG_LOG_FILE, chunk);
    slackAuthOutput = `${slackAuthOutput}${chunk}`;
    if (slackAuthOutput.length > SLACK_AUTH_OUTPUT_MAX_LENGTH) {
        slackAuthOutput = slackAuthOutput.slice(-SLACK_AUTH_OUTPUT_MAX_LENGTH);
    }
}
function handleSlackAuthStdout(chunk) {
    appendSlackAuthOutput(chunk);
    const authorizeUrl = slackAuthOutput.match(SLACK_AUTHORIZE_URL_PATTERN)?.[0];
    if (!authorizeUrl)
        return;
    slackAuthAuthorizeUrl = authorizeUrl;
    openSlackAuthorizeUrl(authorizeUrl);
}
function openSlackAuthorizeUrl(authorizeUrl, force = false) {
    if (slackAuthBrowserOpenRequested && !force)
        return;
    slackAuthBrowserOpenRequested = true;
    void electron_1.shell.openExternal(authorizeUrl)
        .then(() => {
        notifySlackAuthStatus(true, 'Slack authorization opened in your browser.');
    })
        .catch(error => {
        slackAuthBrowserOpenRequested = false;
        notifySlackAuthStatus(false, `Could not open Slack authorization in the browser: ${getErrorMessage(error)}`);
    });
}
function handleSlackSocketOutput(chunk) {
    appendSlackSocketOutput(chunk);
    const failureMatch = slackSocketOutput.match(/Slack connector failed: ([^\r\n]+)/);
    if (!slackSocketConnected && failureMatch?.[1] && failureMatch[1] !== slackSocketLastError) {
        slackSocketLastError = failureMatch[1];
        notifySlackListenerStatus(false, `Slack listener error: ${failureMatch[1]}`);
    }
    if (!slackSocketConnected && slackSocketOutput.includes('Connected to Slack Socket Mode.')) {
        slackSocketConnected = true;
        notifySlackListenerStatus(true, 'Slack listener connected.');
    }
}
function appendSlackSocketOutput(chunk) {
    appendDebugLogFile(SLACK_SOCKET_DEBUG_LOG_FILE, chunk);
    slackSocketOutput = `${slackSocketOutput}${chunk}`;
    if (slackSocketOutput.length > SLACK_SOCKET_OUTPUT_MAX_LENGTH) {
        slackSocketOutput = slackSocketOutput.slice(-SLACK_SOCKET_OUTPUT_MAX_LENGTH);
    }
}
function notifySlackAuthStatus(ok, message) {
    mainWindow?.webContents.send('slack:auth-status', { ok, message });
}
function notifySlackListenerStatus(ok, message) {
    slackListenerStatus = { ok, message };
    mainWindow?.webContents.send('slack:listener-status', { ok, message });
}
function stopSlackAuthFlow() {
    const child = slackAuthProcess;
    if (!child)
        return;
    slackAuthProcess = null;
    if (child.exitCode === null && !child.killed) {
        child.kill();
    }
}
function stopSlackSocketListener() {
    const child = slackSocketProcess;
    if (!child)
        return;
    slackSocketProcess = null;
    slackSocketConnected = false;
    if (child.exitCode === null && !child.killed) {
        child.kill();
    }
}
function readSlackEnvForScript(scriptPath) {
    const envPath = node_path_1.default.join(node_path_1.default.dirname(node_path_1.default.dirname(scriptPath)), '.env');
    if (!node_fs_1.default.existsSync(envPath))
        return {};
    const env = {};
    const lines = node_fs_1.default.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#'))
            continue;
        const equalsIndex = trimmedLine.indexOf('=');
        if (equalsIndex <= 0)
            continue;
        const key = trimmedLine.slice(0, equalsIndex).trim();
        const value = unquoteSlackEnvValue(trimmedLine.slice(equalsIndex + 1).trim());
        if (key)
            env[key] = value;
    }
    return env;
}
function unquoteSlackEnvValue(value) {
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function shouldUseExternalBackend() {
    return process.env[LEGACY_IN_PROCESS_BACKEND_ENV] !== '1';
}
function shouldBackendOwnState() {
    return true;
}
function getBackendUrl(pathName) {
    return `http://${TERMINAL_UPDATE_HOST}:${TERMINAL_UPDATE_PORT}${pathName}`;
}
async function ensureBackendServer() {
    if (!shouldUseExternalBackend())
        return;
    if (backendAvailable)
        return;
    if (backendStartupPromise)
        return backendStartupPromise;
    backendStartupPromise = startBackendServer();
    try {
        await backendStartupPromise;
    }
    finally {
        backendStartupPromise = null;
    }
}
async function startBackendServer() {
    if (await waitForBackendHealth(BACKEND_HEALTH_POLL_MS)) {
        backendAvailable = true;
        if (shouldBackendOwnState())
            await refreshBackendState();
        connectBackendEventStream();
        return;
    }
    const scriptPath = node_path_1.default.join(__dirname, BACKEND_SERVER_SCRIPT_RELATIVE_PATH);
    const electronRunAsNode = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
    const child = (0, node_child_process_1.spawn)(process.execPath, [scriptPath], {
        cwd: node_path_1.default.join(__dirname, '..', '..'),
        env: {
            ...process.env,
            ...electronRunAsNode,
            MULTITASKER_DATA_DIR: electron_1.app.getPath('userData'),
        },
        windowsHide: true,
    });
    backendProcess = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        if (isTerminalUpdateDebugEnabled())
            console.info(chunk.trimEnd());
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        console.error(chunk.trimEnd());
    });
    child.on('error', error => {
        if (backendProcess === child)
            backendProcess = null;
        console.error(`Multitasker backend could not start: ${getErrorMessage(error)}`);
    });
    child.on('exit', code => {
        if (backendProcess === child)
            backendProcess = null;
        backendAvailable = false;
        if (!isQuitting) {
            console.error(`Multitasker backend exited with code ${code ?? 'unknown'}`);
            scheduleBackendEventReconnect();
        }
    });
    if (!(await waitForBackendHealth(BACKEND_START_TIMEOUT_MS))) {
        throw new Error('Multitasker backend did not become ready in time.');
    }
    backendAvailable = true;
    if (shouldBackendOwnState())
        await refreshBackendState();
    connectBackendEventStream();
}
async function waitForBackendHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    do {
        try {
            const response = await fetch(getBackendUrl(BACKEND_HEALTH_PATH));
            if (response.ok)
                return true;
        }
        catch {
            // Backend is not accepting connections yet.
        }
        if (Date.now() >= deadline)
            break;
        await delay(Math.min(BACKEND_HEALTH_POLL_MS, Math.max(0, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return false;
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function backendGet(pathName) {
    return backendJsonRequest('GET', pathName);
}
async function backendPost(pathName, body = {}) {
    return backendJsonRequest('POST', pathName, body);
}
async function backendJsonRequest(method, pathName, body) {
    await ensureBackendServer();
    const init = { method };
    if (method === 'POST') {
        init.headers = { 'content-type': 'application/json; charset=utf-8' };
        init.body = JSON.stringify(body ?? {});
    }
    const response = await fetch(getBackendUrl(pathName), init);
    const parsed = await response.json();
    if (!response.ok)
        throw new Error(parsed.error ?? `Backend request failed: HTTP ${response.status}`);
    return parsed;
}
async function refreshBackendState() {
    try {
        const result = await backendGet(BACKEND_STATE_PATH);
        if (result.ok)
            applyBackendState(result.state);
    }
    catch (error) {
        console.error(`Failed to refresh backend state: ${getErrorMessage(error)}`);
    }
}
function connectBackendEventStream() {
    if (!shouldUseExternalBackend() || backendEventRequest)
        return;
    const request = (0, node_http_1.request)({
        hostname: TERMINAL_UPDATE_HOST,
        port: TERMINAL_UPDATE_PORT,
        path: BACKEND_EVENTS_PATH,
        method: 'GET',
        headers: { accept: 'text/event-stream' },
    }, response => {
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
            handleBackendEventChunk(chunk);
        });
        response.on('end', () => {
            backendEventRequest = null;
            scheduleBackendEventReconnect();
        });
    });
    backendEventRequest = request;
    request.on('error', () => {
        backendEventRequest = null;
        scheduleBackendEventReconnect();
    });
    request.end();
}
function scheduleBackendEventReconnect() {
    if (!shouldUseExternalBackend() || isQuitting || backendEventReconnectTimer)
        return;
    backendEventReconnectTimer = setTimeout(() => {
        backendEventReconnectTimer = null;
        backendEventRequest = null;
        backendAvailable = false;
        void ensureBackendServer().catch(error => {
            console.error(`Failed to reconnect to backend: ${getErrorMessage(error)}`);
            scheduleBackendEventReconnect();
        });
    }, BACKEND_EVENT_RECONNECT_MS);
}
function stopBackendServer() {
    backendAvailable = false;
    if (backendEventReconnectTimer) {
        clearTimeout(backendEventReconnectTimer);
        backendEventReconnectTimer = null;
    }
    if (backendEventRequest) {
        backendEventRequest.destroy();
        backendEventRequest = null;
    }
    const child = backendProcess;
    backendProcess = null;
    if (child && child.exitCode === null && !child.killed)
        child.kill();
}
function handleBackendEventChunk(chunk) {
    backendEventBuffer += chunk.replace(/\r/g, '');
    let separatorIndex = backendEventBuffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
        const block = backendEventBuffer.slice(0, separatorIndex);
        backendEventBuffer = backendEventBuffer.slice(separatorIndex + 2);
        handleBackendEventBlock(block);
        separatorIndex = backendEventBuffer.indexOf('\n\n');
    }
}
function handleBackendEventBlock(block) {
    let eventName = 'message';
    const dataLines = [];
    for (const line of block.split('\n')) {
        if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim();
        }
        else if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
        }
    }
    if (dataLines.length === 0)
        return;
    try {
        handleBackendEvent(eventName, JSON.parse(dataLines.join('\n')));
    }
    catch (error) {
        console.error(`Failed to process backend event "${eventName}": ${getErrorMessage(error)}`);
    }
}
function handleBackendEvent(eventName, payload) {
    switch (eventName) {
        case 'state':
            if (isBackendState(payload))
                applyBackendState(payload);
            return;
        case 'terminal:update': {
            const update = parseTerminalUpdateRequest(payload);
            if (update)
                handleTerminalUpdate(update);
            return;
        }
        case 'terminal:event': {
            const event = parseTerminalEventRequest(payload);
            if (event)
                handleTerminalEvent(event);
            return;
        }
        case 'session:list-update':
            if (shouldBackendOwnState() && Array.isArray(payload))
                applyBackendSessions(payload);
            return;
        case 'manual-task:list-update':
            if (shouldBackendOwnState() && Array.isArray(payload))
                applyBackendManualTasks(payload);
            return;
        case 'manual-task:add': {
            const task = parseManualTaskState(payload);
            if (task) {
                addManualTask(task);
            }
            else {
                console.error('Failed to add task from backend: invalid manual task payload');
            }
            return;
        }
        case 'recurring-task:list-update':
            if (shouldBackendOwnState() && Array.isArray(payload))
                applyBackendRecurringTasks(payload);
            return;
        case 'slack:notification':
            if (isSlackNotification(payload)) {
                if (shouldBackendOwnState()) {
                    mainWindow?.webContents.send('slack:notification', payload);
                }
                else {
                    handleSlackNotification(payload);
                }
                if (mainWindow && !mainWindow.isFocused())
                    mainWindow.flashFrame(true);
            }
            return;
        case 'slack:dismiss': {
            const dismissRequest = parseSlackNotificationDismissRequest(payload);
            if (dismissRequest)
                handleSlackNotificationDismiss(dismissRequest);
            return;
        }
        case 'slack:list-update':
            if (shouldBackendOwnState() && Array.isArray(payload))
                applyBackendSlackNotifications(payload);
            return;
        default:
            return;
    }
}
function isBackendState(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return Array.isArray(candidate.sessions) &&
        Array.isArray(candidate.manualTasks) &&
        Array.isArray(candidate.recurringTasks) &&
        Array.isArray(candidate.slackNotifications);
}
function isSlackNotification(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return typeof candidate.id === 'string' &&
        typeof candidate.text === 'string' &&
        typeof candidate.receivedAt === 'number';
}
function applyBackendState(state) {
    if (shouldBackendOwnState()) {
        applyBackendSessions(state.sessions);
        applyBackendManualTasks(state.manualTasks);
        applyBackendRecurringTasks(state.recurringTasks);
        applyBackendSlackNotifications(state.slackNotifications);
    }
}
function applyBackendSessions(sessions) {
    backendState.sessions = sessions.map(session => ({ ...session }));
    mainWindow?.webContents.send('session:list-update', backendState.sessions);
}
function applyBackendManualTasks(tasks) {
    manualTasks.length = 0;
    manualTasks.push(...tasks.map(task => ({ ...task })));
    mainWindow?.webContents.send('manual-task:list-update', manualTasks.map(task => ({ ...task })));
}
function applyBackendRecurringTasks(tasks) {
    recurringTasks.length = 0;
    recurringTasks.push(...tasks.map(cloneRecurringTask));
    mainWindow?.webContents.send('recurring-task:list-update', recurringTasks.map(cloneRecurringTask));
}
function applyBackendSlackNotifications(notifications) {
    slackNotifications.length = 0;
    slackNotifications.push(...notifications.map(notification => ({ ...notification })));
    mainWindow?.webContents.send('slack:list-update', slackNotifications.map(notification => ({ ...notification })));
}
function isTerminalUpdateDebugEnabled() {
    const value = process.env[TERMINAL_UPDATE_DEBUG_ENV]?.toLowerCase();
    return value === '1' || value === 'true';
}
function debugTerminalUpdate(message, details = {}) {
    if (!isTerminalUpdateDebugEnabled())
        return;
    const serializedDetails = Object.entries(details)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
        .join(' ');
    const line = `[multitasker terminal ${new Date().toISOString()}] ${message}${serializedDetails ? ` ${serializedDetails}` : ''}`;
    appendTerminalDebugLog(line, details);
    console.info(line);
}
function appendTerminalDebugLog(line, details) {
    const sessionId = getDebugLogSessionId(details);
    if (!sessionId)
        return;
    const filePath = getTerminalDebugLogFilePath(sessionId, details);
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true });
        node_fs_1.default.appendFileSync(filePath, `${line}\n`, 'utf8');
    }
    catch (error) {
        reportDebugLogWriteFailure(`Could not write Electron terminal debug log "${filePath}": ${getErrorMessage(error)}`);
    }
}
function appendDebugLogFile(fileName, chunk) {
    const lines = chunk.replace(/\r/g, '').split('\n').filter(line => line.length > 0);
    if (lines.length === 0)
        return;
    const filePath = node_path_1.default.join(process.cwd(), DEBUG_LOG_DIRECTORY, fileName);
    const content = lines
        .map(line => `[multitasker slack ${new Date().toISOString()}] ${line}`)
        .join('\n');
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true });
        node_fs_1.default.appendFileSync(filePath, `${content}\n`, 'utf8');
    }
    catch (error) {
        reportDebugLogWriteFailure(`Could not write Slack debug log "${filePath}": ${getErrorMessage(error)}`);
    }
}
function getTerminalDebugLogFilePath(sessionId, details) {
    const existingFilePath = terminalDebugLogFileBySessionId.get(sessionId);
    if (existingFilePath)
        return existingFilePath;
    const timestamp = formatDebugLogFileTimestamp(new Date());
    const sessionName = getDebugLogSessionName(sessionId, details);
    const fileName = [
        timestamp,
        sanitizeDebugLogFilePart(sessionName, 'unknown-session', 80),
        sanitizeDebugLogFilePart(sessionId, 'unknown-id', 140),
    ].join('-');
    const filePath = node_path_1.default.join(process.cwd(), DEBUG_LOG_DIRECTORY, `${fileName}${DEBUG_LOG_FILE_EXTENSION}`);
    terminalDebugLogFileBySessionId.set(sessionId, filePath);
    return filePath;
}
function getDebugLogSessionId(details) {
    const value = details['id'];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function getDebugLogSessionName(sessionId, details) {
    const detailSessionName = details['sessionName'];
    if (typeof detailSessionName === 'string' && detailSessionName.trim())
        return detailSessionName.trim();
    const session = sessionManager?.getSession(sessionId);
    if (session?.name.trim())
        return session.name.trim();
    const terminalName = details['terminalName'];
    if (typeof terminalName === 'string' && terminalName.trim())
        return terminalName.trim();
    return 'unknown-session';
}
function formatDebugLogFileTimestamp(date) {
    return date.toISOString().replace(/[:.]/g, '-');
}
function sanitizeDebugLogFilePart(value, fallback, maxLength) {
    const sanitized = value
        .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    const safeValue = sanitized || fallback;
    if (safeValue.length <= maxLength)
        return safeValue;
    const hash = (0, node_crypto_1.createHash)('sha256').update(safeValue).digest('hex').slice(0, 8);
    return `${safeValue.slice(0, maxLength - hash.length - 1)}-${hash}`;
}
function reportDebugLogWriteFailure(message) {
    if (reportedDebugLogWriteFailures.has(message))
        return;
    reportedDebugLogWriteFailures.add(message);
    console.warn(message);
}
function formatDebugValue(value) {
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return JSON.stringify(value);
}
function terminalUpdateDebugDetails(update) {
    return {
        id: update.id,
        status: update.status,
        occurredAt: update.occurredAt,
        exitCode: update.exitCode,
        exitReason: update.exitReason,
        reason: update.debugReason,
        matchedText: update.debugMatchedText,
    };
}
function terminalEventStatusDebugDetails(update) {
    if (!update) {
        return {
            statusUpdate: false,
            statusReason: 'terminal event did not produce a status update',
        };
    }
    return {
        statusUpdate: true,
        computedStatus: update.status,
        statusReason: update.debugReason,
        statusExitCode: update.exitCode,
        statusExitReason: update.exitReason,
    };
}
function terminalEventDebugDetails(event, sessionName) {
    return {
        id: event.id,
        sessionName,
        type: event.type,
        occurredAt: event.occurredAt,
        terminalRef: event.terminalRef,
        launchId: event.launchId,
        commandLine: event.commandLine,
        executionId: event.executionId,
        exitCode: event.exitCode,
        exitReason: event.exitReason,
        terminalName: event.terminalName,
        terminalCwd: event.terminalCwd,
        terminalPid: event.terminalPid,
        shellType: event.shellType,
        hasLaunchCommand: event.hasLaunchCommand,
        primary: event.primary,
        captureState: event.captureState,
        captureReason: event.captureReason,
        output: event.output === undefined ? undefined : terminalOutputDebugValue(event.output),
    };
}
function getTerminalEventSessionName(event) {
    const session = sessionManager?.getSession(event.id);
    return session?.name ?? event.terminalName;
}
function terminalOutputDebugValue(output) {
    return stripTerminalControlSequences(output)
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}
function stripTerminalControlSequences(value) {
    return value
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r/g, '\n');
}
function parseTerminalUpdateRequest(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const record = payload;
    const id = readStringField(record, 'id').trim();
    const rawStatus = readStringField(record, 'status').trim();
    const occurredAt = readOptionalNumberField(record, 'occurredAt') ?? Date.now();
    if (!id || !isSessionStatus(rawStatus))
        return null;
    const update = {
        id,
        status: rawStatus,
        occurredAt,
    };
    const exitCode = readOptionalNumberField(record, 'exitCode');
    if (exitCode !== undefined)
        update.exitCode = exitCode;
    const exitReason = readStringField(record, 'exitReason').trim();
    if (exitReason)
        update.exitReason = exitReason;
    const debugReason = readStringField(record, 'debugReason').trim();
    if (debugReason)
        update.debugReason = debugReason.slice(0, 500);
    return update;
}
function parseTerminalEventRequest(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const record = payload;
    const explicitTaskId = readStringField(record, 'taskId').trim() || readStringField(record, 'id').trim();
    const rawType = readStringField(record, 'type').trim();
    const occurredAt = readOptionalNumberField(record, 'occurredAt') ?? Date.now();
    if (!isTerminalEventType(rawType))
        return null;
    const terminalRef = readStringField(record, 'terminalRef').trim();
    const launchId = readStringField(record, 'launchId').trim();
    const terminalPid = readOptionalNumberField(record, 'terminalPid');
    const terminalName = readStringField(record, 'terminalName').trim();
    const terminalCwd = readStringField(record, 'terminalCwd').trim();
    const rawShellType = readStringField(record, 'shellType').trim();
    const shellType = isShellType(rawShellType) ? rawShellType : undefined;
    const id = resolveTerminalEventTaskId({
        explicitTaskId,
        terminalRef,
        terminalPid,
        terminalName,
        terminalCwd,
    });
    if (!id)
        return null;
    const event = {
        id,
        type: rawType,
        occurredAt,
    };
    if (terminalRef)
        event.terminalRef = terminalRef;
    if (launchId)
        event.launchId = launchId;
    if (terminalPid !== undefined)
        event.terminalPid = terminalPid;
    if (terminalName)
        event.terminalName = terminalName;
    if (terminalCwd)
        event.terminalCwd = terminalCwd;
    if (shellType)
        event.shellType = shellType;
    const commandLine = readStringField(record, 'commandLine');
    if (commandLine)
        event.commandLine = commandLine;
    const executionId = readStringField(record, 'executionId').trim();
    if (executionId)
        event.executionId = executionId;
    const output = readStringField(record, 'output');
    if (output)
        event.output = output;
    const exitCode = readOptionalNumberField(record, 'exitCode');
    if (exitCode !== undefined)
        event.exitCode = exitCode;
    const exitReason = readStringField(record, 'exitReason').trim();
    if (exitReason)
        event.exitReason = exitReason;
    const hasLaunchCommand = readOptionalBooleanField(record, 'hasLaunchCommand');
    if (hasLaunchCommand !== undefined)
        event.hasLaunchCommand = hasLaunchCommand;
    const primary = readOptionalBooleanField(record, 'primary');
    if (primary !== undefined)
        event.primary = primary;
    const rawCaptureState = readStringField(record, 'captureState').trim();
    if (rawCaptureState && isTerminalCaptureState(rawCaptureState))
        event.captureState = rawCaptureState;
    const captureReason = readStringField(record, 'captureReason').trim();
    if (captureReason)
        event.captureReason = captureReason.slice(0, 500);
    rememberTaskTerminalBinding(id, {
        terminalRef,
        terminalPid,
        captureState: event.captureState,
        captureReason: event.captureReason,
    });
    return event;
}
function resolveTerminalEventTaskId(identity) {
    if (identity.terminalRef) {
        const terminalTaskId = taskIdByTerminalRef.get(identity.terminalRef);
        if (terminalTaskId)
            return terminalTaskId;
    }
    if (identity.explicitTaskId)
        return identity.explicitTaskId;
    const matchingSession = findSessionForTerminalIdentity(identity);
    return matchingSession?.id ?? '';
}
function findSessionForTerminalIdentity(identity) {
    const sessions = sessionManager?.getSessions() ?? [];
    const exactRef = identity.terminalRef
        ? sessions.find(session => session.terminalRef === identity.terminalRef)
        : undefined;
    if (exactRef)
        return exactRef;
    const exactPid = identity.terminalPid !== undefined
        ? sessions.find(session => (session.terminalPid ?? getLegacyAttachedTerminalPid(session.id)) === identity.terminalPid)
        : undefined;
    if (exactPid)
        return exactPid;
    const normalizedTerminalPath = normalizePathForCompare(identity.terminalCwd);
    if (!normalizedTerminalPath)
        return null;
    return sessions.find(session => !session.terminalRef?.trim() &&
        normalizePathForCompare(session.cwd) === normalizedTerminalPath) ?? null;
}
function createManualTask(textValue, createdAtValue) {
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    if (!text) {
        console.error('Failed to add manual task: task text is required');
        return null;
    }
    const createdAt = typeof createdAtValue === 'number' && Number.isFinite(createdAtValue)
        ? createdAtValue
        : Date.now();
    return addManualTask({
        id: `manual-${(0, node_crypto_1.randomUUID)()}`,
        text: truncateManualTaskText(text),
        createdAt,
    });
}
function readManualTaskText(payload) {
    if (typeof payload === 'string')
        return payload;
    if (typeof payload !== 'object' || payload === null)
        return '';
    const record = payload;
    return readStringField(record, 'text') || readStringField(record, 'title') || readStringField(record, 'task');
}
function parseManualTaskState(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const record = payload;
    const id = readStringField(record, 'id').trim();
    const text = readStringField(record, 'text').trim();
    const createdAt = readOptionalNumberField(record, 'createdAt');
    if (!id || !text || createdAt === undefined)
        return null;
    return {
        id,
        text: truncateManualTaskText(text),
        createdAt,
    };
}
function addManualTask(task) {
    const existingIndex = manualTasks.findIndex(existing => existing.id === task.id);
    if (existingIndex >= 0)
        manualTasks.splice(existingIndex, 1);
    manualTasks.unshift({ ...task });
    while (manualTasks.length > MAX_MANUAL_TASKS)
        manualTasks.pop();
    (0, settings_1.saveManualTasks)(manualTasks);
    broadcastManualTasks();
    return { ...task };
}
function removeManualTask(id) {
    const existingIndex = manualTasks.findIndex(task => task.id === id);
    if (existingIndex < 0) {
        console.error(`Failed to remove manual task: task "${id}" was not found`);
        return false;
    }
    manualTasks.splice(existingIndex, 1);
    (0, settings_1.saveManualTasks)(manualTasks);
    broadcastManualTasks();
    return true;
}
function broadcastManualTasks() {
    mainWindow?.webContents.send('manual-task:list-update', manualTasks.map(task => ({ ...task })));
}
function truncateManualTaskText(text) {
    if (text.length <= MAX_MANUAL_TASK_TEXT_LENGTH)
        return text;
    return `${text.slice(0, MAX_MANUAL_TASK_TEXT_LENGTH - 1)}…`;
}
function createRecurringTask(textValue, timeValue, scheduleValue) {
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    const time = typeof timeValue === 'string' ? timeValue.trim() : '';
    const schedule = parseRecurringSchedule(scheduleValue);
    if (!text) {
        console.error('Failed to add recurring task: task text is required');
        return null;
    }
    if (parseRecurringTimeMinutes(time) === null) {
        console.error('Failed to add recurring task: invalid time');
        return null;
    }
    if (!schedule) {
        console.error('Failed to add recurring task: invalid recurrence schedule');
        return null;
    }
    const now = new Date();
    const task = {
        id: `recurring-${(0, node_crypto_1.randomUUID)()}`,
        text: truncateManualTaskText(text),
        time,
        frequency: schedule.frequency,
        daysOfWeek: schedule.daysOfWeek,
        createdAt: now.getTime(),
        enabled: true,
    };
    if (schedule.intervalDays !== undefined)
        task.intervalDays = schedule.intervalDays;
    if (schedule.dayOfMonth !== undefined)
        task.dayOfMonth = schedule.dayOfMonth;
    if (schedule.anchorDate)
        task.anchorDate = schedule.anchorDate;
    const initialGeneratedDate = getInitialRecurringTaskGeneratedDate(task, now);
    if (initialGeneratedDate)
        task.lastGeneratedDate = initialGeneratedDate;
    recurringTasks.unshift(task);
    while (recurringTasks.length > MAX_RECURRING_TASKS)
        recurringTasks.pop();
    (0, settings_1.saveRecurringTasks)(recurringTasks);
    broadcastRecurringTasks();
    return { ...task, daysOfWeek: [...task.daysOfWeek] };
}
function removeRecurringTask(id) {
    const existingIndex = recurringTasks.findIndex(task => task.id === id);
    if (existingIndex < 0) {
        console.error(`Failed to remove recurring task: task "${id}" was not found`);
        return false;
    }
    recurringTasks.splice(existingIndex, 1);
    (0, settings_1.saveRecurringTasks)(recurringTasks);
    broadcastRecurringTasks();
    return true;
}
function broadcastRecurringTasks() {
    mainWindow?.webContents.send('recurring-task:list-update', recurringTasks.map(cloneRecurringTask));
}
function parseRecurringSchedule(value) {
    if (Array.isArray(value)) {
        const daysOfWeek = normalizeRecurringDays(value);
        return daysOfWeek.length > 0 ? { frequency: 'weekly', daysOfWeek } : null;
    }
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const frequency = normalizeRecurringFrequency(readStringField(record, 'frequency'));
    if (frequency === 'daily') {
        return { frequency, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
    }
    if (frequency === 'interval') {
        const intervalDays = normalizeRecurringIntervalDays(record['intervalDays']);
        if (intervalDays === null)
            return null;
        return { frequency, daysOfWeek: [], intervalDays, anchorDate: getLocalDateKey(new Date()) };
    }
    if (frequency === 'monthly') {
        const dayOfMonth = normalizeRecurringDayOfMonth(record['dayOfMonth']);
        if (dayOfMonth === null)
            return null;
        return { frequency, daysOfWeek: [], dayOfMonth };
    }
    const daysOfWeek = normalizeRecurringDays(record['daysOfWeek']);
    return daysOfWeek.length > 0 ? { frequency, daysOfWeek } : null;
}
function normalizeRecurringFrequency(value) {
    return value === 'daily' || value === 'interval' || value === 'monthly' ? value : 'weekly';
}
function normalizeRecurringDays(value) {
    if (!Array.isArray(value))
        return [];
    const days = value
        .filter((day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
    return [...new Set(days)].sort((a, b) => a - b);
}
function normalizeRecurringIntervalDays(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null;
}
function normalizeRecurringDayOfMonth(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
}
function cloneRecurringTask(task) {
    const clone = {
        ...task,
        frequency: task.frequency ?? 'weekly',
        daysOfWeek: [...task.daysOfWeek],
    };
    return clone;
}
function getInitialRecurringTaskGeneratedDate(task, now) {
    if (!isRecurringTaskDue(task, now))
        return '';
    return getLocalDateKey(now);
}
function startRecurringTaskScheduler() {
    if (recurringTaskTimer)
        clearInterval(recurringTaskTimer);
    runDueRecurringTasks();
    recurringTaskTimer = setInterval(runDueRecurringTasks, RECURRING_TASK_CHECK_INTERVAL_MS);
}
function stopRecurringTaskScheduler() {
    if (!recurringTaskTimer)
        return;
    clearInterval(recurringTaskTimer);
    recurringTaskTimer = null;
}
function runDueRecurringTasks(now = new Date()) {
    let changed = false;
    const today = getLocalDateKey(now);
    for (const task of recurringTasks) {
        if (!isRecurringTaskDue(task, now))
            continue;
        if (task.lastGeneratedDate === today)
            continue;
        if (createManualTask(task.text)) {
            task.lastGeneratedDate = today;
            changed = true;
        }
    }
    if (changed) {
        (0, settings_1.saveRecurringTasks)(recurringTasks);
        broadcastRecurringTasks();
    }
}
function isRecurringTaskDue(task, now) {
    if (!task.enabled)
        return false;
    const taskMinutes = parseRecurringTimeMinutes(task.time);
    if (taskMinutes === null)
        return false;
    if (getLocalMinutesSinceMidnight(now) < taskMinutes)
        return false;
    const frequency = task.frequency ?? 'weekly';
    if (frequency === 'daily')
        return true;
    if (frequency === 'interval')
        return isRecurringIntervalDue(task, now);
    if (frequency === 'monthly')
        return isRecurringMonthlyDue(task, now);
    return task.daysOfWeek.includes(now.getDay());
}
function isRecurringIntervalDue(task, now) {
    const intervalDays = task.intervalDays;
    if (intervalDays === undefined || intervalDays < 1)
        return false;
    const anchorDate = parseLocalDateKey(task.anchorDate || getLocalDateKey(new Date(task.createdAt)));
    if (!anchorDate)
        return false;
    const daysSinceAnchor = getLocalDateDiffDays(anchorDate, now);
    return daysSinceAnchor >= 0 && daysSinceAnchor % intervalDays === 0;
}
function isRecurringMonthlyDue(task, now) {
    const dayOfMonth = task.dayOfMonth;
    if (dayOfMonth === undefined)
        return false;
    return now.getDate() === Math.min(dayOfMonth, getDaysInMonth(now));
}
function parseRecurringTimeMinutes(time) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!match)
        return null;
    return Number(match[1]) * 60 + Number(match[2]);
}
function getLocalMinutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
}
function getLocalDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function parseLocalDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match)
        return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
function getLocalDateDiffDays(start, end) {
    const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
    const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());
    return Math.floor((endUtc - startUtc) / 86_400_000);
}
function getDaysInMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}
function restorePersistedGoogleCalendarEvents() {
    googleCalendarEvents.length = 0;
    googleCalendarEvents.push(...filterActiveGoogleCalendarEvents((0, settings_1.loadGoogleCalendarEvents)()));
}
function cloneGoogleCalendarEvent(event) {
    return { ...event };
}
function broadcastGoogleCalendarEvents() {
    mainWindow?.webContents.send('google-calendar:list-update', googleCalendarEvents.map(cloneGoogleCalendarEvent));
}
function broadcastGoogleCalendarStatus(message = '') {
    const status = getGoogleCalendarStatus(message);
    mainWindow?.webContents.send('google-calendar:status-update', status);
    return status;
}
async function getFreshGoogleCalendarStatus(message = '') {
    await loadGoogleCalendarOAuthConfig();
    return getGoogleCalendarStatus(message);
}
function getGoogleCalendarStatus(message = '', oauthConfig = googleCalendarOAuthConfigCache) {
    const settings = (0, settings_1.loadSettings)().googleCalendar;
    const connections = (0, settings_1.loadGoogleCalendarConnections)();
    const lastSyncedAt = Math.max(0, ...connections.map(connection => connection.lastSyncedAt ?? 0));
    const connected = connections.length > 0;
    const configured = Boolean(oauthConfig.clientId.trim());
    const status = {
        connected,
        configured,
        enabled: settings.enabled,
        calendarId: settings.calendarId,
        lookAheadDays: settings.lookAheadDays,
        ownedCalendarsOnly: settings.ownedCalendarsOnly,
        accountCount: connections.length,
        eventCount: googleCalendarEvents.length,
        message: message || getDefaultGoogleCalendarStatusMessage(settings, configured, connected, connections.length),
        connections: connections.map(getGoogleCalendarConnectionStatus),
    };
    if (lastSyncedAt || googleCalendarLastSyncedAt)
        status.lastSyncedAt = Math.max(lastSyncedAt, googleCalendarLastSyncedAt);
    return status;
}
function getGoogleCalendarConnectionStatus(connection) {
    const status = {
        id: connection.id,
        calendarId: connection.calendarId,
        lookAheadDays: connection.lookAheadDays,
        enabled: connection.enabled,
        connectedAt: connection.connectedAt,
    };
    if (connection.accountEmail)
        status.accountEmail = connection.accountEmail;
    if (connection.accountName)
        status.accountName = connection.accountName;
    if (connection.lastSyncedAt)
        status.lastSyncedAt = connection.lastSyncedAt;
    if (connection.authError)
        status.authError = connection.authError;
    return status;
}
function getDefaultGoogleCalendarStatusMessage(settings, configured, connected, accountCount) {
    if (!configured)
        return 'Google Calendar OAuth env vars are not configured in the backend.';
    if (!connected)
        return 'Google Calendar is not connected.';
    if (!settings.enabled)
        return 'Google Calendar is connected but disabled.';
    return googleCalendarLastSyncedAt
        ? `Synced ${googleCalendarEvents.length} upcoming event(s) from ${accountCount} account(s).`
        : `Google Calendar is connected to ${accountCount} account(s).`;
}
function startGoogleCalendarScheduler() {
    if (googleCalendarRefreshTimer)
        clearInterval(googleCalendarRefreshTimer);
    if ((0, settings_1.loadSettings)().googleCalendar.enabled && (0, settings_1.loadGoogleCalendarConnections)().length > 0) {
        void refreshGoogleCalendarEvents();
    }
    googleCalendarRefreshTimer = setInterval(() => {
        if ((0, settings_1.loadSettings)().googleCalendar.enabled && (0, settings_1.loadGoogleCalendarConnections)().length > 0) {
            void refreshGoogleCalendarEvents();
        }
    }, GOOGLE_CALENDAR_REFRESH_INTERVAL_MS);
}
function stopGoogleCalendarScheduler() {
    if (googleCalendarRefreshTimer) {
        clearInterval(googleCalendarRefreshTimer);
        googleCalendarRefreshTimer = null;
    }
    stopGoogleCalendarAuthFlow();
}
function handleGoogleCalendarSettingsChanged() {
    const settings = (0, settings_1.loadSettings)().googleCalendar;
    if (!settings.enabled) {
        googleCalendarEvents.length = 0;
        (0, settings_1.saveGoogleCalendarEvents)(googleCalendarEvents);
        broadcastGoogleCalendarEvents();
        broadcastGoogleCalendarStatus();
        return;
    }
    startGoogleCalendarScheduler();
}
async function loadGoogleCalendarOAuthConfig() {
    try {
        const response = await backendGet('/api/google-calendar/oauth-config');
        googleCalendarOAuthConfigCache = {
            clientId: typeof response.clientId === 'string' ? response.clientId.trim() : '',
            hasClientSecret: response.hasClientSecret === true,
        };
    }
    catch (error) {
        googleCalendarOAuthConfigCache = { clientId: '', hasClientSecret: false };
        console.error(`Failed to load Google Calendar OAuth config: ${getErrorMessage(error)}`);
    }
    return googleCalendarOAuthConfigCache;
}
async function startGoogleCalendarAuthFlow() {
    const settings = (0, settings_1.loadSettings)().googleCalendar;
    const oauthConfig = await loadGoogleCalendarOAuthConfig();
    if (!oauthConfig.clientId.trim()) {
        const message = 'Google Calendar OAuth env vars are required in the backend.';
        return { ok: false, message, status: getGoogleCalendarStatus(message, oauthConfig) };
    }
    stopGoogleCalendarAuthFlow();
    const state = (0, node_crypto_1.randomUUID)();
    const codeVerifier = base64UrlEncode((0, node_crypto_1.randomBytes)(64));
    const codeChallenge = base64UrlEncode((0, node_crypto_1.createHash)('sha256').update(codeVerifier).digest());
    let redirectUri = '';
    const result = new Promise((resolve) => {
        let settled = false;
        let timeout = null;
        const finish = (ok, message) => {
            if (settled)
                return;
            settled = true;
            if (timeout)
                clearTimeout(timeout);
            stopGoogleCalendarAuthFlow();
            const status = broadcastGoogleCalendarStatus(message);
            resolve({ ok, message, status });
        };
        googleCalendarAuthServer = (0, node_http_1.createServer)((request, response) => {
            void handleGoogleCalendarOAuthCallback(request, response, {
                state,
                codeVerifier,
                redirectUri,
                settings,
                finish,
            });
        });
        googleCalendarAuthServer.once('error', error => {
            finish(false, `Google Calendar authorization server failed: ${getErrorMessage(error)}`);
        });
        googleCalendarAuthServer.listen(0, GOOGLE_CALENDAR_OAUTH_HOST, () => {
            const address = googleCalendarAuthServer?.address();
            if (!address || typeof address === 'string') {
                finish(false, 'Google Calendar authorization server did not return a local port.');
                return;
            }
            redirectUri = `http://${GOOGLE_CALENDAR_OAUTH_HOST}:${address.port}${GOOGLE_CALENDAR_OAUTH_CALLBACK_PATH}`;
            timeout = setTimeout(() => {
                finish(false, 'Google Calendar authorization timed out.');
            }, GOOGLE_CALENDAR_AUTH_TIMEOUT_MS);
            const authUrl = buildGoogleCalendarAuthUrl(oauthConfig, redirectUri, state, codeChallenge);
            void electron_1.shell.openExternal(authUrl).catch(error => {
                finish(false, `Could not open Google authorization page: ${getErrorMessage(error)}`);
            });
        });
    });
    broadcastGoogleCalendarStatus('Waiting for Google authorization...');
    return result;
}
async function handleGoogleCalendarOAuthCallback(request, response, context) {
    const requestUrl = new URL(request.url ?? '/', `http://${GOOGLE_CALENDAR_OAUTH_HOST}`);
    if (requestUrl.pathname !== GOOGLE_CALENDAR_OAUTH_CALLBACK_PATH) {
        writeGoogleCalendarOAuthResponse(response, false, 'Unsupported Google Calendar authorization callback.');
        return;
    }
    const callbackState = requestUrl.searchParams.get('state') ?? '';
    if (callbackState !== context.state) {
        writeGoogleCalendarOAuthResponse(response, false, 'Google Calendar authorization state did not match.');
        context.finish(false, 'Google Calendar authorization state did not match.');
        return;
    }
    const callbackError = requestUrl.searchParams.get('error') ?? '';
    if (callbackError) {
        const message = `Google Calendar authorization failed: ${callbackError}`;
        writeGoogleCalendarOAuthResponse(response, false, message);
        context.finish(false, message);
        return;
    }
    const code = requestUrl.searchParams.get('code') ?? '';
    if (!code) {
        writeGoogleCalendarOAuthResponse(response, false, 'Google Calendar authorization did not return a code.');
        context.finish(false, 'Google Calendar authorization did not return a code.');
        return;
    }
    try {
        const token = await requestGoogleToken({
            grant_type: 'authorization_code',
            code,
            redirect_uri: context.redirectUri,
            code_verifier: context.codeVerifier,
        });
        const userInfo = await fetchGoogleUserInfo(token.accessToken);
        const connections = (0, settings_1.loadGoogleCalendarConnections)();
        const connectionId = getGoogleCalendarConnectionId(userInfo);
        const existingConnection = connections.find(connection => connection.id === connectionId);
        const refreshToken = token.refreshToken ?? existingConnection?.auth.refreshToken ?? '';
        if (!refreshToken) {
            throw new Error('Google did not return a refresh token. Revoke Multitasker access in your Google account and connect again.');
        }
        const auth = {
            accessToken: token.accessToken,
            refreshToken,
            expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000,
        };
        if (token.tokenType)
            auth.tokenType = token.tokenType;
        if (token.scope)
            auth.scope = token.scope;
        const connection = {
            id: connectionId,
            calendarId: context.settings.calendarId,
            lookAheadDays: context.settings.lookAheadDays,
            enabled: true,
            connectedAt: existingConnection?.connectedAt ?? Date.now(),
            auth,
        };
        if (userInfo.email)
            connection.accountEmail = userInfo.email;
        if (userInfo.name)
            connection.accountName = userInfo.name;
        if (existingConnection?.lastSyncedAt)
            connection.lastSyncedAt = existingConnection.lastSyncedAt;
        (0, settings_1.saveGoogleCalendarConnections)([
            connection,
            ...connections.filter(candidate => candidate.id !== connection.id),
        ]);
        (0, settings_1.clearGoogleCalendarAuth)();
        const currentSettings = (0, settings_1.loadSettings)();
        (0, settings_1.saveSettings)({
            ...currentSettings,
            googleCalendar: {
                ...currentSettings.googleCalendar,
                enabled: true,
            },
        });
        await refreshGoogleCalendarEvents();
        const accountLabel = getGoogleCalendarConnectionLabel(connection);
        writeGoogleCalendarOAuthResponse(response, true, `Google Calendar connected for ${accountLabel}. You can close this tab.`);
        context.finish(true, `Google Calendar connected for ${accountLabel}.`);
    }
    catch (error) {
        const message = `Google Calendar authorization failed: ${getErrorMessage(error)}`;
        writeGoogleCalendarOAuthResponse(response, false, message);
        context.finish(false, message);
    }
}
function writeGoogleCalendarOAuthResponse(response, ok, message) {
    const body = `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;padding:24px"><h1>${ok ? 'Connected' : 'Authorization failed'}</h1><p>${escapeHtml(message)}</p></body></html>`;
    response.writeHead(ok ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    response.end(body);
}
function buildGoogleCalendarAuthUrl(oauthConfig, redirectUri, state, codeChallenge) {
    const url = new URL(GOOGLE_CALENDAR_AUTH_URL);
    url.searchParams.set('client_id', oauthConfig.clientId.trim());
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPE);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'select_account consent');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
}
function stopGoogleCalendarAuthFlow() {
    const server = googleCalendarAuthServer;
    googleCalendarAuthServer = null;
    if (!server)
        return;
    try {
        server.close();
    }
    catch {
        // Server may not have started listening yet.
    }
}
function getGoogleCalendarReauthTaskId(connectionId) {
    return `google-calendar-reauth-${connectionId}`;
}
function clearGoogleCalendarReauthTask(connectionId) {
    const taskId = getGoogleCalendarReauthTaskId(connectionId);
    if (manualTasks.some(task => task.id === taskId))
        removeManualTask(taskId);
}
async function refreshGoogleCalendarEvents() {
    const settings = (0, settings_1.loadSettings)().googleCalendar;
    if (!settings.enabled)
        return broadcastGoogleCalendarStatus('Google Calendar is disabled.');
    const oauthConfig = await loadGoogleCalendarOAuthConfig();
    if (!oauthConfig.clientId.trim())
        return broadcastGoogleCalendarStatus('Google Calendar OAuth env vars are required in the backend.');
    const connections = (0, settings_1.loadGoogleCalendarConnections)();
    if (connections.length === 0)
        return broadcastGoogleCalendarStatus('Google Calendar is not connected.');
    const events = [];
    const failures = [];
    const reauthRequired = [];
    try {
        for (const connection of connections) {
            if (!connection.enabled)
                continue;
            try {
                const accessToken = await getValidGoogleCalendarAccessToken(connection);
                const connectionEvents = await fetchGoogleCalendarEvents(settings, connection, accessToken);
                connection.lastSyncedAt = Date.now();
                if (connection.authError) {
                    delete connection.authError;
                    clearGoogleCalendarReauthTask(connection.id);
                }
                events.push(...connectionEvents);
            }
            catch (error) {
                const accountLabel = getGoogleCalendarConnectionLabel(connection);
                const message = getErrorMessage(error);
                failures.push(accountLabel);
                if (/invalid_grant|invalid_token|unauthorized_client|insufficient[_ ]?(authentication[_ ]?)?scopes?|ACCESS_TOKEN_SCOPE_INSUFFICIENT|\b401\b/i.test(message)) {
                    connection.authError = 'reauth_required';
                    reauthRequired.push(accountLabel);
                    addManualTask({
                        id: getGoogleCalendarReauthTaskId(connection.id),
                        text: truncateManualTaskText(`Reconnect Google Calendar for ${accountLabel}`),
                        createdAt: Date.now(),
                    });
                }
                console.error(`Google Calendar sync failed for ${accountLabel}: ${message}`);
            }
        }
        googleCalendarLastSyncedAt = Date.now();
        (0, settings_1.saveGoogleCalendarConnections)(connections);
        googleCalendarEvents.length = 0;
        googleCalendarEvents.push(...filterActiveGoogleCalendarEvents(events).sort((a, b) => a.startMs - b.startMs));
        (0, settings_1.saveGoogleCalendarEvents)(googleCalendarEvents);
        broadcastGoogleCalendarEvents();
        if (reauthRequired.length > 0) {
            return broadcastGoogleCalendarStatus(`Reconnect required for ${reauthRequired.join(', ')}. Sign in again to resume Google Calendar sync.`);
        }
        if (failures.length > 0) {
            return broadcastGoogleCalendarStatus(`Synced ${googleCalendarEvents.length} event(s); ${failures.length} account(s) failed.`);
        }
        return broadcastGoogleCalendarStatus(`Synced ${googleCalendarEvents.length} upcoming Google Calendar event(s) from ${connections.length} account(s).`);
    }
    catch (error) {
        const message = `Google Calendar sync failed: ${getErrorMessage(error)}`;
        console.error(message);
        return broadcastGoogleCalendarStatus(message);
    }
}
async function getValidGoogleCalendarAccessToken(connection) {
    if (connection.auth.expiresAt > Date.now() + GOOGLE_CALENDAR_TOKEN_REFRESH_BUFFER_MS) {
        return connection.auth.accessToken;
    }
    connection.auth = await refreshGoogleCalendarAccessToken(connection.auth);
    return connection.auth.accessToken;
}
async function refreshGoogleCalendarAccessToken(auth) {
    const token = await requestGoogleToken({
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
    });
    const refreshedAuth = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? auth.refreshToken,
        expiresAt: Date.now() + (token.expiresIn ?? 3600) * 1000,
    };
    const tokenType = token.tokenType ?? auth.tokenType;
    if (tokenType)
        refreshedAuth.tokenType = tokenType;
    const scope = token.scope ?? auth.scope;
    if (scope)
        refreshedAuth.scope = scope;
    return refreshedAuth;
}
async function requestGoogleToken(params) {
    const response = await backendPost('/api/google-calendar/token', params);
    if (!response.ok || response.token === undefined) {
        throw new Error(response.error || 'Google token request failed.');
    }
    return parseGoogleTokenResponse(response.token);
}
function parseGoogleTokenResponse(payload) {
    if (!isRecord(payload))
        throw new Error('Google token response was not an object.');
    const accessToken = readStringField(payload, 'access_token').trim();
    if (!accessToken)
        throw new Error('Google token response did not include an access token.');
    const token = { accessToken };
    const refreshToken = readStringField(payload, 'refresh_token').trim();
    if (refreshToken)
        token.refreshToken = refreshToken;
    const expiresIn = readOptionalNumberField(payload, 'expires_in');
    if (expiresIn !== undefined)
        token.expiresIn = expiresIn;
    const tokenType = readStringField(payload, 'token_type').trim();
    if (tokenType)
        token.tokenType = tokenType;
    const scope = readStringField(payload, 'scope').trim();
    if (scope)
        token.scope = scope;
    return token;
}
async function fetchGoogleUserInfo(accessToken) {
    const response = await fetch(GOOGLE_USERINFO_URL, {
        headers: { authorization: `Bearer ${accessToken}` },
    });
    const rawBody = await response.text();
    const payload = parseJsonResponseBody(rawBody);
    if (!response.ok) {
        throw new Error(`Google user info request failed (${response.status}): ${getGoogleApiErrorMessage(payload, rawBody)}`);
    }
    return parseGoogleUserInfo(payload);
}
function parseGoogleUserInfo(payload) {
    if (!isRecord(payload))
        throw new Error('Google user info response was not an object.');
    const id = readStringField(payload, 'id').trim();
    const email = readStringField(payload, 'email').trim();
    const name = readStringField(payload, 'name').trim();
    const accountId = id || email;
    if (!accountId)
        throw new Error('Google user info response did not include an account id or email.');
    return {
        id: accountId,
        ...(email ? { email } : {}),
        ...(name ? { name } : {}),
    };
}
function getGoogleCalendarConnectionId(userInfo) {
    return `google:${(0, node_crypto_1.createHash)('sha256').update(userInfo.id).digest('hex').slice(0, 16)}`;
}
function getGoogleCalendarConnectionLabel(connection) {
    return connection.accountEmail || connection.accountName || connection.id;
}
async function fetchGoogleCalendarEvents(settings, connection, accessToken) {
    const calendarId = connection.calendarId.trim() || 'primary';
    if (settings.ownedCalendarsOnly && !(await isOwnedGoogleCalendar(calendarId, accessToken))) {
        console.info(`Skipping shared Google Calendar "${calendarId}" for ${getGoogleCalendarConnectionLabel(connection)}.`);
        return [];
    }
    const now = new Date();
    const timeMin = startOfLocalDay(now).toISOString();
    const timeMax = new Date(now.getTime() + connection.lookAheadDays * 86_400_000).toISOString();
    const url = new URL(`${GOOGLE_CALENDAR_API_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('timeMin', timeMin);
    url.searchParams.set('timeMax', timeMax);
    url.searchParams.set('maxResults', String(MAX_GOOGLE_CALENDAR_EVENTS));
    const response = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
    });
    const rawBody = await response.text();
    const payload = parseJsonResponseBody(rawBody);
    if (!response.ok) {
        throw new Error(`Google Calendar request failed (${response.status}): ${getGoogleApiErrorMessage(payload, rawBody)}`);
    }
    const eventsResponse = parseGoogleCalendarEventsResponse(payload);
    return filterActiveGoogleCalendarEvents((eventsResponse.items ?? [])
        .map(event => parseGoogleCalendarEvent(connection, calendarId, event))
        .filter((event) => event !== null), now).sort((a, b) => a.startMs - b.startMs);
}
async function isOwnedGoogleCalendar(calendarId, accessToken) {
    const normalizedCalendarId = calendarId.trim() || 'primary';
    const entry = normalizedCalendarId.toLowerCase() === 'primary'
        ? await fetchPrimaryGoogleCalendarListEntry(accessToken)
        : await fetchGoogleCalendarListEntry(normalizedCalendarId, accessToken);
    return entry?.accessRole === 'owner';
}
async function fetchPrimaryGoogleCalendarListEntry(accessToken) {
    const entries = await fetchGoogleCalendarListEntries(accessToken);
    return entries.find(entry => entry.primary === true) ?? null;
}
async function fetchGoogleCalendarListEntry(calendarId, accessToken) {
    const url = new URL(`${GOOGLE_CALENDAR_API_BASE_URL}/users/me/calendarList/${encodeURIComponent(calendarId)}`);
    const response = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}` },
    });
    const rawBody = await response.text();
    const payload = parseJsonResponseBody(rawBody);
    if (response.status === 404)
        return null;
    if (!response.ok) {
        throw new Error(`Google Calendar list request failed (${response.status}): ${getGoogleApiErrorMessage(payload, rawBody)}`);
    }
    return parseGoogleCalendarListEntry(payload);
}
async function fetchGoogleCalendarListEntries(accessToken) {
    const entries = [];
    let pageToken = '';
    do {
        const url = new URL(`${GOOGLE_CALENDAR_API_BASE_URL}/users/me/calendarList`);
        url.searchParams.set('maxResults', '250');
        url.searchParams.set('showHidden', 'true');
        if (pageToken)
            url.searchParams.set('pageToken', pageToken);
        const response = await fetch(url, {
            headers: { authorization: `Bearer ${accessToken}` },
        });
        const rawBody = await response.text();
        const payload = parseJsonResponseBody(rawBody);
        if (!response.ok) {
            throw new Error(`Google Calendar list request failed (${response.status}): ${getGoogleApiErrorMessage(payload, rawBody)}`);
        }
        const page = parseGoogleCalendarListResponse(payload);
        entries.push(...page.items);
        pageToken = page.nextPageToken;
    } while (pageToken);
    return entries;
}
function parseGoogleCalendarListResponse(payload) {
    if (!isRecord(payload))
        throw new Error('Google Calendar list response was not an object.');
    const items = payload['items'];
    const nextPageToken = readStringField(payload, 'nextPageToken').trim();
    return {
        items: Array.isArray(items)
            ? items.map(parseGoogleCalendarListEntry).filter((entry) => entry !== null)
            : [],
        nextPageToken,
    };
}
function parseGoogleCalendarListEntry(payload) {
    if (!isRecord(payload))
        return null;
    const id = readStringField(payload, 'id').trim();
    if (!id)
        return null;
    const entry = { id };
    const summary = readStringField(payload, 'summary').trim();
    const accessRole = readStringField(payload, 'accessRole').trim();
    const primary = readOptionalBooleanField(payload, 'primary');
    if (summary)
        entry.summary = summary;
    if (accessRole)
        entry.accessRole = accessRole;
    if (primary !== undefined)
        entry.primary = primary;
    return entry;
}
function parseGoogleCalendarEventsResponse(payload) {
    if (!isRecord(payload))
        throw new Error('Google Calendar response was not an object.');
    const items = payload['items'];
    if (!Array.isArray(items))
        return { items: [] };
    return {
        items: items
            .filter(isRecord)
            .map(parseGoogleCalendarRawEvent),
    };
}
function parseGoogleCalendarRawEvent(item) {
    const event = {};
    const id = readStringField(item, 'id').trim();
    if (id)
        event.id = id;
    const status = readStringField(item, 'status').trim();
    if (status)
        event.status = status;
    const summary = readStringField(item, 'summary').trim();
    if (summary)
        event.summary = summary;
    const htmlLink = readStringField(item, 'htmlLink').trim();
    if (htmlLink)
        event.htmlLink = htmlLink;
    const location = readStringField(item, 'location').trim();
    if (location)
        event.location = location;
    const updated = readStringField(item, 'updated').trim();
    if (updated)
        event.updated = updated;
    const start = parseGoogleCalendarRawEventDate(item['start']);
    if (start)
        event.start = start;
    const end = parseGoogleCalendarRawEventDate(item['end']);
    if (end)
        event.end = end;
    return event;
}
function parseGoogleCalendarRawEventDate(value) {
    if (!isRecord(value))
        return undefined;
    const date = readStringField(value, 'date').trim();
    const dateTime = readStringField(value, 'dateTime').trim();
    if (!date && !dateTime)
        return undefined;
    return {
        ...(date ? { date } : {}),
        ...(dateTime ? { dateTime } : {}),
    };
}
function parseGoogleCalendarEvent(connection, calendarId, rawEvent) {
    if (!rawEvent.id || rawEvent.status === 'cancelled' || !rawEvent.start || !rawEvent.end)
        return null;
    const start = parseGoogleCalendarEventDate(rawEvent.start);
    const end = parseGoogleCalendarEventDate(rawEvent.end);
    if (!start || !end)
        return null;
    const event = {
        id: `${connection.id}:${calendarId}:${rawEvent.id}`,
        connectionId: connection.id,
        calendarId,
        summary: rawEvent.summary?.trim() || '(no title)',
        start: start.value,
        end: end.value,
        startMs: start.ms,
        endMs: end.ms,
        allDay: start.allDay,
    };
    if (connection.accountEmail)
        event.accountEmail = connection.accountEmail;
    if (connection.accountName)
        event.accountName = connection.accountName;
    if (rawEvent.htmlLink)
        event.htmlLink = rawEvent.htmlLink;
    if (rawEvent.location)
        event.location = rawEvent.location;
    if (rawEvent.updated)
        event.updated = rawEvent.updated;
    return event;
}
function parseGoogleCalendarEventDate(value) {
    if (value.dateTime) {
        const ms = Date.parse(value.dateTime);
        return Number.isFinite(ms) ? { value: value.dateTime, ms, allDay: false } : null;
    }
    if (!value.date)
        return null;
    const date = parseLocalDateKey(value.date);
    return date ? { value: value.date, ms: date.getTime(), allDay: true } : null;
}
function filterActiveGoogleCalendarEvents(events, now = new Date()) {
    const nowMs = now.getTime();
    return events.filter(event => event.endMs >= nowMs).slice(0, MAX_GOOGLE_CALENDAR_EVENTS);
}
function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function parseJsonResponseBody(rawBody) {
    if (!rawBody.trim())
        return {};
    try {
        return JSON.parse(rawBody);
    }
    catch {
        return {};
    }
}
function getGoogleApiErrorMessage(payload, fallback) {
    if (!isRecord(payload))
        return fallback.slice(0, 500);
    const errorDescription = readStringField(payload, 'error_description').trim();
    if (errorDescription)
        return errorDescription;
    const rawError = payload['error'];
    if (typeof rawError === 'string' && rawError.trim())
        return rawError.trim();
    if (isRecord(rawError)) {
        const message = readStringField(rawError, 'message').trim();
        if (message)
            return message;
    }
    return fallback.slice(0, 500);
}
function base64UrlEncode(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}
function disconnectGoogleCalendar(connectionId) {
    if (typeof connectionId === 'string' && connectionId.trim()) {
        const normalizedConnectionId = connectionId.trim();
        const connections = (0, settings_1.loadGoogleCalendarConnections)()
            .filter(connection => connection.id !== normalizedConnectionId);
        (0, settings_1.saveGoogleCalendarConnections)(connections);
        googleCalendarEvents.splice(0, googleCalendarEvents.length, ...googleCalendarEvents.filter(event => event.connectionId !== normalizedConnectionId));
        (0, settings_1.saveGoogleCalendarEvents)(googleCalendarEvents);
        broadcastGoogleCalendarEvents();
        clearGoogleCalendarReauthTask(normalizedConnectionId);
        return broadcastGoogleCalendarStatus('Google Calendar account disconnected.');
    }
    const allConnectionIds = (0, settings_1.loadGoogleCalendarConnections)().map(connection => connection.id);
    (0, settings_1.clearGoogleCalendarAuth)();
    (0, settings_1.clearGoogleCalendarConnections)();
    (0, settings_1.clearGoogleCalendarEvents)();
    googleCalendarEvents.length = 0;
    googleCalendarLastSyncedAt = 0;
    for (const id of allConnectionIds)
        clearGoogleCalendarReauthTask(id);
    const settings = (0, settings_1.loadSettings)();
    (0, settings_1.saveSettings)({
        ...settings,
        googleCalendar: {
            ...settings.googleCalendar,
            enabled: false,
        },
    });
    broadcastGoogleCalendarEvents();
    return broadcastGoogleCalendarStatus('Google Calendar disconnected.');
}
async function openGoogleCalendarEvent(id) {
    if (typeof id !== 'string' || !id.trim())
        return false;
    const event = googleCalendarEvents.find(candidate => candidate.id === id.trim());
    if (!event?.htmlLink)
        return false;
    await electron_1.shell.openExternal(event.htmlLink);
    return true;
}
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function parseSlackNotificationRequest(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const record = payload;
    const id = readStringField(record, 'id').trim();
    const receivedAt = readOptionalNumberField(record, 'receivedAt') ?? Date.now();
    if (!id || !Number.isFinite(receivedAt))
        return null;
    const text = truncateSlackText(readStringField(record, 'text').trim() || '(no text)');
    const notification = {
        id,
        text,
        receivedAt,
    };
    addOptionalSlackString(notification, 'teamId', readStringField(record, 'teamId'));
    addOptionalSlackString(notification, 'teamName', readStringField(record, 'teamName'));
    addOptionalSlackString(notification, 'channelId', readStringField(record, 'channelId'));
    addOptionalSlackString(notification, 'channelName', readStringField(record, 'channelName'));
    addOptionalSlackString(notification, 'channelType', readStringField(record, 'channelType'));
    addOptionalSlackString(notification, 'userId', readStringField(record, 'userId'));
    addOptionalSlackString(notification, 'userName', readStringField(record, 'userName'));
    addOptionalSlackString(notification, 'ts', readStringField(record, 'ts'));
    addOptionalSlackString(notification, 'threadTs', readStringField(record, 'threadTs'));
    addOptionalSlackString(notification, 'permalink', readStringField(record, 'permalink'));
    const messageCount = readOptionalNumberField(record, 'messageCount');
    if (messageCount !== undefined && messageCount > 1)
        notification.messageCount = Math.floor(messageCount);
    const priorityRank = readOptionalNumberField(record, 'priorityRank');
    if (priorityRank !== undefined)
        notification.priorityRank = normalizeSlackPriorityRank(priorityRank);
    const priorityLabel = readStringField(record, 'priorityLabel').trim();
    if (isSlackNotificationPriorityLabel(priorityLabel))
        notification.priorityLabel = priorityLabel;
    return notification;
}
function parseSlackNotificationDismissRequest(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const record = payload;
    const channelId = readStringField(record, 'channelId').trim();
    if (!channelId)
        return null;
    const request = { channelId };
    const teamId = readStringField(record, 'teamId').trim();
    if (teamId)
        request.teamId = teamId;
    const channelType = readStringField(record, 'channelType').trim();
    if (channelType)
        request.channelType = channelType;
    const reason = readStringField(record, 'reason').trim();
    if (reason)
        request.reason = reason;
    const targetTs = readStringField(record, 'targetTs').trim();
    if (targetTs)
        request.targetTs = targetTs;
    const replyTs = readStringField(record, 'replyTs').trim();
    if (replyTs)
        request.replyTs = replyTs;
    const ts = readStringField(record, 'ts').trim();
    if (ts)
        request.ts = ts;
    const receivedAt = readOptionalNumberField(record, 'receivedAt');
    if (receivedAt !== undefined)
        request.receivedAt = receivedAt;
    return request;
}
function addOptionalSlackString(notification, key, value) {
    const trimmedValue = value.trim();
    if (trimmedValue)
        notification[key] = trimmedValue;
}
function truncateSlackText(text) {
    if (text.length <= MAX_SLACK_TEXT_LENGTH)
        return text;
    return `${text.slice(0, MAX_SLACK_TEXT_LENGTH - 1)}…`;
}
function getSlackDebugTextPreview(text) {
    const preview = text.replace(/\s+/g, ' ').trim();
    if (preview.length <= MAX_SLACK_DEBUG_TEXT_LENGTH)
        return preview;
    return `${preview.slice(0, MAX_SLACK_DEBUG_TEXT_LENGTH - 1)}…`;
}
function normalizeSlackPriorityRank(value) {
    if (!Number.isFinite(value))
        return SLACK_PRIORITY_OTHER.rank;
    return Math.max(SLACK_PRIORITY_MENTION.rank, Math.min(SLACK_PRIORITY_OTHER.rank, Math.floor(value)));
}
function isSlackNotificationPriorityLabel(value) {
    return value === 'mention' ||
        value === 'dm' ||
        value === 'thread_mention' ||
        value === 'thread_written' ||
        value === 'other';
}
async function handleSlackEventEnvelope(envelope) {
    const envelopeRecord = readSlackRecord(envelope);
    if (!envelopeRecord) {
        debugSlackEventDecision('ignored_invalid_envelope', {});
        return;
    }
    const envelopeType = readSlackString(envelopeRecord, 'type');
    if (envelopeType !== 'events_api') {
        debugSlackEventDecision('ignored_non_event', { type: envelopeType });
        return;
    }
    const payload = readSlackRecord(envelopeRecord, 'payload');
    const event = payload ? readSlackRecord(payload, 'event') : undefined;
    const envelopeId = readSlackString(envelopeRecord, 'envelope_id');
    if (!payload || !event) {
        debugSlackEventDecision('ignored_invalid_event', { envelopeId });
        return;
    }
    const channelId = readSlackString(event, 'channel');
    const ts = readSlackString(event, 'ts') || readSlackString(event, 'event_ts');
    const eventText = readSlackString(event, 'text') || readSlackString(event, 'fallback');
    if (readSlackBoolean(event, 'hidden') === true) {
        debugSlackEventDecision('ignored_hidden', { envelopeId, channelId, messageText: getSlackDebugTextPreview(eventText), ts });
        return;
    }
    const subtype = readSlackString(event, 'subtype');
    if (subtype === 'message_deleted' || subtype === 'message_changed') {
        debugSlackEventDecision('ignored_subtype', { envelopeId, channelId, subtype, messageText: getSlackDebugTextPreview(eventText), ts });
        return;
    }
    const notification = await buildSlackNotification(payload, event, subtype);
    if (notification)
        handleSlackNotification(notification);
}
async function buildSlackNotification(payload, event, subtype) {
    const teamId = readSlackString(payload, 'team_id') || readSlackString(readSlackRecord(payload, 'team'), 'id');
    const channelId = readSlackString(event, 'channel');
    const eventUserId = readSlackString(event, 'user');
    const botId = readSlackString(event, 'bot_id');
    const senderId = eventUserId || botId;
    const ts = readSlackString(event, 'ts') || readSlackString(event, 'event_ts');
    const text = readSlackString(event, 'text') || readSlackString(event, 'fallback') || '(no text)';
    if (!channelId && !text.trim())
        return null;
    await initializeSlackAuthedUserId();
    rememberSlackAuthedUserThread(event);
    if (eventUserId && slackAuthedUserId && eventUserId === slackAuthedUserId) {
        const channelType = readSlackString(event, 'channel_type') || getSlackFallbackChannelType(channelId);
        if (isSlackDirectMessageChannel(channelId, channelType)) {
            const dismissRequest = buildSlackDismissRequest(payload, event, channelType);
            const removed = handleSlackNotificationDismiss(dismissRequest);
            debugSlackEventDecision('dismissed_self_dm', {
                channelId,
                channelType,
                eventUserId,
                authedUserId: slackAuthedUserId,
                messageText: getSlackDebugTextPreview(text),
                targetTs: dismissRequest.targetTs,
                replyTs: dismissRequest.replyTs,
                removed,
                ts,
            });
            return null;
        }
        debugSlackEventDecision('ignored_self', {
            channelId,
            channelType,
            eventUserId,
            authedUserId: slackAuthedUserId,
            messageText: getSlackDebugTextPreview(text),
            ts,
        });
        return null;
    }
    const channelInfo = channelId ? await getSlackChannelInfo(channelId) : undefined;
    if (channelId && !(await shouldAcceptSlackChannel(channelId, channelInfo))) {
        debugSlackEventDecision('ignored_not_member', {
            channelId,
            channelType: channelInfo?.type || getSlackFallbackChannelType(channelId),
            eventUserId,
            authedUserId: slackAuthedUserId,
            knownUserConversation: Boolean(slackAuthedUserConversationIds?.has(channelId)),
            messageText: getSlackDebugTextPreview(text),
            ts,
        });
        return null;
    }
    const userName = await getSlackMessageSenderName(event, eventUserId, botId);
    const channelName = getSlackNotificationChannelName(channelInfo, channelId, userName);
    const channelType = readSlackString(event, 'channel_type') || channelInfo?.type || '';
    const priority = await getSlackNotificationPriority(channelId, event, channelType, ts);
    const displayText = await resolveSlackMessageMentions(text);
    const permalink = channelId && ts ? await getSlackPermalink(channelId, ts) : '';
    const notification = {
        id: ['slack', teamId, channelId, ts || Date.now().toString()].filter(Boolean).join(':'),
        text: truncateSlackText(displayText),
        receivedAt: Date.now(),
        priorityRank: priority.rank,
        priorityLabel: priority.label,
    };
    addOptionalSlackString(notification, 'teamId', teamId);
    addOptionalSlackString(notification, 'channelId', channelId);
    addOptionalSlackString(notification, 'channelName', channelName);
    addOptionalSlackString(notification, 'channelType', channelType);
    addOptionalSlackString(notification, 'userId', senderId);
    addOptionalSlackString(notification, 'userName', userName);
    addOptionalSlackString(notification, 'ts', ts);
    addOptionalSlackString(notification, 'threadTs', readSlackString(event, 'thread_ts'));
    addOptionalSlackString(notification, 'permalink', permalink);
    debugSlackEventDecision('accepted', {
        channelId,
        channelName,
        channelType: notification.channelType,
        subtype,
        eventUserId,
        userName,
        messageText: getSlackDebugTextPreview(displayText),
        rawMessageText: displayText !== text ? getSlackDebugTextPreview(text) : '',
        priority: priority.label,
        priorityRank: priority.rank,
        priorityReason: priority.reason,
        mentionsAuthedUser: priority.mentionsAuthedUser,
        directMessage: priority.directMessage,
        threadReply: priority.threadReply,
        threadWrittenByAuthedUser: priority.threadWrittenByAuthedUser,
        threadTs: priority.threadTs,
        authedUserId: slackAuthedUserId,
        knownUserConversation: channelId ? Boolean(slackAuthedUserConversationIds?.has(channelId)) : false,
        ts,
    });
    return notification;
}
async function getSlackNotificationPriority(channelId, event, channelType, ts) {
    const threadTs = readSlackString(event, 'thread_ts');
    const isThreadReply = Boolean(threadTs && threadTs !== ts);
    const mentionsAuthedUser = slackAuthedUserId ? slackEventMentionsUser(event, slackAuthedUserId) : false;
    const directMessage = isSlackDirectMessageChannel(channelId, channelType);
    const threadWrittenByAuthedUser = isThreadReply
        ? await isSlackThreadWrittenByAuthedUser(channelId, threadTs, event)
        : false;
    const details = {
        mentionsAuthedUser,
        directMessage,
        threadReply: isThreadReply,
        threadWrittenByAuthedUser,
        ...(threadTs ? { threadTs } : {}),
    };
    if (mentionsAuthedUser && !isThreadReply) {
        return { ...SLACK_PRIORITY_MENTION, ...details, reason: 'message mentions authed user' };
    }
    if (directMessage) {
        return { ...SLACK_PRIORITY_DM, ...details, reason: 'direct message channel' };
    }
    if (mentionsAuthedUser && isThreadReply) {
        return { ...SLACK_PRIORITY_THREAD_MENTION, ...details, reason: 'thread reply mentions authed user' };
    }
    if (threadWrittenByAuthedUser) {
        return { ...SLACK_PRIORITY_THREAD_WRITTEN, ...details, reason: 'authed user participated in thread' };
    }
    return { ...SLACK_PRIORITY_OTHER, ...details, reason: 'no priority signal matched' };
}
function slackEventMentionsUser(event, userId) {
    const mentionToken = `<@${userId}>`;
    return readSlackString(event, 'text').includes(mentionToken) ||
        readSlackString(event, 'fallback').includes(mentionToken) ||
        slackStructuredValueMentionsUser(event['blocks'], userId, mentionToken);
}
function slackStructuredValueMentionsUser(value, userId, mentionToken) {
    if (typeof value === 'string')
        return value.includes(mentionToken);
    if (Array.isArray(value))
        return value.some(item => slackStructuredValueMentionsUser(item, userId, mentionToken));
    const record = readSlackRecord(value);
    if (!record)
        return false;
    const type = readSlackString(record, 'type');
    if (type === 'user' && (readSlackString(record, 'user_id') === userId || readSlackString(record, 'user') === userId)) {
        return true;
    }
    return Object.entries(record).some(([key, nestedValue]) => {
        if (key === 'text' && typeof nestedValue === 'string')
            return nestedValue.includes(mentionToken);
        if (typeof nestedValue === 'object' && nestedValue !== null)
            return slackStructuredValueMentionsUser(nestedValue, userId, mentionToken);
        return typeof nestedValue === 'string' && nestedValue.includes(mentionToken);
    });
}
function rememberSlackAuthedUserThread(event) {
    const eventUserId = readSlackString(event, 'user');
    if (!slackAuthedUserId || eventUserId !== slackAuthedUserId)
        return;
    const channelId = readSlackString(event, 'channel');
    const ts = readSlackString(event, 'ts') || readSlackString(event, 'event_ts');
    const threadTs = readSlackString(event, 'thread_ts') || ts;
    if (!channelId || !threadTs)
        return;
    slackThreadWrittenByAuthedUser.set(getSlackThreadKey(channelId, threadTs), true);
}
async function isSlackThreadWrittenByAuthedUser(channelId, threadTs, event) {
    if (!channelId || !threadTs || !slackAuthedUserId)
        return false;
    const cacheKey = getSlackThreadKey(channelId, threadTs);
    const cached = slackThreadWrittenByAuthedUser.get(cacheKey);
    if (cached !== undefined)
        return cached;
    if (readSlackString(event, 'parent_user_id') === slackAuthedUserId) {
        slackThreadWrittenByAuthedUser.set(cacheKey, true);
        return true;
    }
    if (!getSlackWebApiToken())
        return false;
    try {
        const response = await slackApiWithFallback('conversations.replies', [getSlackUserToken(), getSlackBotToken()], {
            channel: channelId,
            ts: threadTs,
            limit: 200,
        });
        const messages = Array.isArray(response['messages']) ? response['messages'] : [];
        const wroteThread = messages.some(message => {
            const messageRecord = readSlackRecord(message);
            return readSlackString(messageRecord, 'user') === slackAuthedUserId;
        });
        slackThreadWrittenByAuthedUser.set(cacheKey, wroteThread);
        return wroteThread;
    }
    catch (error) {
        debugSlackLog('Could not inspect Slack thread participation', {
            channelId,
            threadTs,
            error: getErrorMessage(error),
        });
        return false;
    }
}
function getSlackThreadKey(channelId, threadTs) {
    return `${channelId}:${threadTs}`;
}
function buildSlackDismissRequest(payload, event, channelType) {
    const ts = readSlackString(event, 'ts') || readSlackString(event, 'event_ts');
    const threadTs = readSlackString(event, 'thread_ts');
    const targetTs = threadTs && threadTs !== ts ? threadTs : '';
    const request = {
        channelId: readSlackString(event, 'channel'),
    };
    const teamId = readSlackString(payload, 'team_id') || readSlackString(readSlackRecord(payload, 'team'), 'id');
    if (teamId)
        request.teamId = teamId;
    if (channelType)
        request.channelType = channelType;
    if (targetTs)
        request.targetTs = targetTs;
    if (ts) {
        request.replyTs = ts;
        request.ts = ts;
    }
    request.reason = 'self_dm_reply';
    request.receivedAt = Date.now();
    return request;
}
async function shouldAcceptSlackChannel(channelId, channelInfo) {
    if (!isSlackOnlyUserChannelsEnabled())
        return true;
    const channelType = channelInfo?.type || getSlackFallbackChannelType(channelId);
    if (channelType === 'im' || channelType === 'mpim')
        return true;
    if (channelInfo?.isUserMember === true)
        return true;
    if (await isSlackAuthedUserConversation(channelId))
        return true;
    return false;
}
async function isSlackAuthedUserConversation(channelId) {
    if (!isSlackOnlyUserChannelsEnabled())
        return true;
    const userToken = getSlackUserToken();
    if (!userToken)
        return false;
    await initializeSlackAuthedUserId();
    if (!slackAuthedUserId)
        return false;
    const stale = Date.now() - slackAuthedUserConversationsLoadedAt > SLACK_USER_CONVERSATIONS_REFRESH_MS;
    if (!slackAuthedUserConversationIds || stale) {
        try {
            await refreshSlackAuthedUserConversations();
        }
        catch (error) {
            debugSlackLog('Could not refresh Slack user conversations', { error: getErrorMessage(error) });
            return false;
        }
    }
    return Boolean(slackAuthedUserConversationIds?.has(channelId));
}
async function refreshSlackAuthedUserConversations() {
    if (!isSlackOnlyUserChannelsEnabled())
        return;
    const userToken = getSlackUserToken();
    if (!userToken || !slackAuthedUserId)
        return;
    const conversationIds = new Set();
    let cursor = '';
    do {
        const payload = {
            user: slackAuthedUserId,
            types: 'public_channel,private_channel,mpim,im',
            exclude_archived: true,
            limit: 1000,
        };
        if (cursor)
            payload['cursor'] = cursor;
        const response = await slackApi('users.conversations', userToken, payload);
        const channels = Array.isArray(response['channels']) ? response['channels'] : [];
        for (const channelValue of channels) {
            const channel = readSlackRecord(channelValue);
            const id = channel ? readSlackString(channel, 'id') : '';
            if (id)
                conversationIds.add(id);
        }
        cursor = readSlackString(readSlackRecord(response, 'response_metadata'), 'next_cursor');
    } while (cursor);
    slackAuthedUserConversationIds = conversationIds;
    slackAuthedUserConversationsLoadedAt = Date.now();
    debugSlackLog('Loaded Slack conversations for authed user membership filtering', {
        count: conversationIds.size,
    });
}
async function initializeSlackAuthedUserId() {
    if (slackAuthedUserId || !getSlackUserToken())
        return;
    try {
        const response = await slackApi('auth.test', getSlackUserToken(), {});
        slackAuthedUserId = readSlackString(response, 'user_id');
        if (slackAuthedUserId)
            debugSlackLog('Slack authed user resolved', { authedUserId: slackAuthedUserId });
    }
    catch (error) {
        debugSlackLog('Could not resolve Slack authed user', { error: getErrorMessage(error) });
    }
}
async function getSlackMessageSenderName(event, userId, botId) {
    const botProfile = readSlackRecord(event, 'bot_profile');
    return readSlackString(event, 'username') ||
        readSlackString(botProfile, 'name') ||
        readSlackString(botProfile, 'real_name') ||
        (userId ? await getSlackUserName(userId) : '') ||
        botId;
}
async function getSlackUserName(userId) {
    if (!getSlackWebApiToken() || !userId || slackUserNameById.has(userId)) {
        return slackUserNameById.get(userId) || userId;
    }
    try {
        const response = await slackApiWithFallback('users.info', [getSlackUserToken(), getSlackBotToken()], { user: userId });
        const user = readSlackRecord(response, 'user');
        const profile = user ? readSlackRecord(user, 'profile') : undefined;
        const name = readSlackString(profile, 'display_name') ||
            readSlackString(profile, 'real_name') ||
            readSlackString(user, 'name') ||
            userId;
        slackUserNameById.set(userId, name);
        return name;
    }
    catch (error) {
        debugSlackLog('Could not resolve Slack user', { userId, error: getErrorMessage(error) });
        slackUserNameById.set(userId, userId);
        return userId;
    }
}
async function getSlackBotName(botId) {
    if (!getSlackWebApiToken() || !botId || slackBotNameById.has(botId)) {
        return slackBotNameById.get(botId) || botId;
    }
    try {
        const response = await slackApiWithFallback('bots.info', [getSlackBotToken(), getSlackUserToken()], { bot: botId });
        const bot = readSlackRecord(response, 'bot');
        const botUserId = readSlackString(bot, 'user_id');
        const userName = botUserId ? await getSlackUserName(botUserId) : '';
        const name = userName ||
            readSlackString(bot, 'name') ||
            readSlackString(bot, 'real_name') ||
            readSlackString(bot, 'app_name') ||
            botId;
        slackBotNameById.set(botId, name);
        return name;
    }
    catch (error) {
        debugSlackLog('Could not resolve Slack bot', { botId, error: getErrorMessage(error) });
        slackBotNameById.set(botId, botId);
        return botId;
    }
}
async function resolveSlackMessageMentions(text) {
    const mentions = getSlackMentionIds(text);
    if (mentions.length === 0)
        return text;
    const resolvedNames = new Map();
    await Promise.all(mentions.map(async (mentionId) => {
        resolvedNames.set(mentionId, await getSlackMentionName(mentionId));
    }));
    return text.replace(/<@([A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, mentionId, fallbackName) => {
        const resolvedName = resolvedNames.get(mentionId);
        const fallback = fallbackName?.trim().replace(/^@/, '') || '';
        const displayName = resolvedName && resolvedName !== mentionId ? resolvedName : (fallback || resolvedName || mentionId);
        return `@${displayName}`;
    });
}
function getSlackMentionIds(text) {
    const ids = new Set();
    for (const match of text.matchAll(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g)) {
        const id = match[1]?.trim();
        if (id)
            ids.add(id);
    }
    return [...ids];
}
async function getSlackMentionName(mentionId) {
    return mentionId.startsWith('B')
        ? getSlackBotName(mentionId)
        : getSlackUserName(mentionId);
}
function getSlackNotificationChannelName(channelInfo, channelId, senderName) {
    if (channelInfo?.type === 'im') {
        if (channelInfo.name && !isRawSlackId(channelInfo.name))
            return channelInfo.name;
        if (senderName && !isRawSlackId(senderName))
            return senderName;
        return channelId;
    }
    return channelInfo?.name || channelId;
}
async function getSlackChannelInfo(channelId) {
    if (!channelId)
        return undefined;
    const cachedInfo = slackChannelInfoById.get(channelId);
    if (cachedInfo)
        return cachedInfo;
    const webApiToken = getSlackWebApiToken();
    if (!webApiToken) {
        const info = { name: channelId, isUserMember: true, type: getSlackFallbackChannelType(channelId) };
        slackChannelInfoById.set(channelId, info);
        return info;
    }
    try {
        const response = await slackApi('conversations.info', getSlackUserToken() || webApiToken, { channel: channelId });
        const channel = readSlackRecord(response, 'channel');
        const type = getSlackChannelType(channel, channelId);
        const channelUserId = readSlackString(channel, 'user');
        const channelUserName = channelUserId ? await getSlackUserName(channelUserId) : '';
        const name = type === 'im'
            ? (channelUserName || channelUserId || channelId)
            : (readSlackString(channel, 'name') || channelUserName || channelUserId || channelId);
        const info = {
            name,
            isUserMember: getSlackUserChannelMembership(channel),
            type,
        };
        slackChannelInfoById.set(channelId, info);
        return info;
    }
    catch (error) {
        debugSlackLog('Could not resolve Slack channel', { channelId, error: getErrorMessage(error) });
        const canVerifyMembership = isSlackOnlyUserChannelsEnabled() && Boolean(getSlackUserToken());
        const knownUserConversation = Boolean(slackAuthedUserConversationIds?.has(channelId));
        const info = {
            name: channelId,
            isUserMember: !canVerifyMembership || knownUserConversation,
            type: getSlackFallbackChannelType(channelId),
        };
        slackChannelInfoById.set(channelId, info);
        return info;
    }
}
function getSlackChannelType(channel, channelId) {
    if (readSlackBoolean(channel, 'is_im'))
        return 'im';
    if (readSlackBoolean(channel, 'is_mpim'))
        return 'mpim';
    if (readSlackBoolean(channel, 'is_private'))
        return 'private_channel';
    return getSlackFallbackChannelType(channelId);
}
function getSlackFallbackChannelType(channelId) {
    if (channelId.startsWith('D'))
        return 'im';
    if (channelId.startsWith('G'))
        return 'private_channel';
    return 'channel';
}
function getSlackUserChannelMembership(channel) {
    if (!isSlackOnlyUserChannelsEnabled() || !getSlackUserToken())
        return true;
    const isMember = readSlackBoolean(channel, 'is_member');
    if (typeof isMember === 'boolean')
        return isMember;
    if (readSlackBoolean(channel, 'is_im') || readSlackBoolean(channel, 'is_mpim'))
        return true;
    return false;
}
async function getSlackPermalink(channelId, messageTs) {
    if (!getSlackWebApiToken())
        return '';
    try {
        const response = await slackApiWithFallback('chat.getPermalink', [getSlackUserToken(), getSlackBotToken()], {
            channel: channelId,
            message_ts: messageTs,
        });
        return readSlackString(response, 'permalink');
    }
    catch (error) {
        debugSlackLog('Could not resolve Slack permalink', { channelId, messageTs, error: getErrorMessage(error) });
        return '';
    }
}
async function slackApi(method, token, payload) {
    const trimmedToken = token.trim();
    if (!trimmedToken)
        throw new Error(`${method} failed: missing Slack token`);
    try {
        const response = await getSlackClient(trimmedToken).apiCall(method, payload);
        const responseRecord = readSlackRecord(response);
        if (!responseRecord)
            throw new Error('Slack returned an invalid response');
        return responseRecord;
    }
    catch (error) {
        throw new Error(formatSlackApiError(method, error));
    }
}
function getSlackClient(token) {
    const cachedClient = slackClientByToken.get(token);
    if (cachedClient)
        return cachedClient;
    const client = new web_api_1.WebClient(token);
    slackClientByToken.set(token, client);
    return client;
}
function formatSlackApiError(method, error) {
    const errorRecord = readSlackRecord(error);
    const data = errorRecord ? readSlackRecord(errorRecord, 'data') : undefined;
    if (data) {
        const details = [
            readSlackString(data, 'error'),
            readSlackString(data, 'needed') ? `needed=${readSlackString(data, 'needed')}` : '',
            readSlackString(data, 'provided') ? `provided=${readSlackString(data, 'provided')}` : '',
        ].filter(Boolean);
        details.push(...readSlackStringArray(readSlackRecord(data, 'response_metadata'), 'messages'));
        if (details.length > 0)
            return `${method} failed: ${details.join('; ')}`;
    }
    return `${method} failed: ${getErrorMessage(error)}`;
}
async function slackApiWithFallback(method, tokens, payload) {
    const usableTokens = tokens.filter(token => token.trim());
    let lastError;
    for (const token of usableTokens) {
        try {
            return await slackApi(method, token, payload);
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError ?? new Error(`${method} failed: missing Slack token`);
}
function resetSlackApiState(nextSlackEnv) {
    slackApiEnv = nextSlackEnv;
    slackUserNameById.clear();
    slackBotNameById.clear();
    slackChannelInfoById.clear();
    slackClientByToken.clear();
    slackThreadWrittenByAuthedUser.clear();
    slackAuthedUserId = getSlackApiEnvValue('SLACK_USER_ID');
    slackAuthedUserConversationIds = undefined;
    slackAuthedUserConversationsLoadedAt = 0;
}
function getSlackApiEnvValue(key) {
    const processValue = process.env[key];
    if (typeof processValue === 'string' && processValue.trim())
        return processValue.trim();
    const envValue = slackApiEnv[key];
    return typeof envValue === 'string' ? envValue.trim() : '';
}
function getSlackUserToken() {
    return getSlackApiEnvValue('SLACK_USER_TOKEN');
}
function getSlackBotToken() {
    return getSlackApiEnvValue('SLACK_BOT_TOKEN');
}
function getSlackWebApiToken() {
    return getSlackUserToken() || getSlackBotToken();
}
function isSlackOnlyUserChannelsEnabled() {
    return getSlackApiEnvValue('SLACK_ONLY_USER_CHANNELS') !== '0';
}
function debugSlackEventDecision(decision, details) {
    debugSlackLog(`Slack event ${decision}`, details);
}
function debugSlackLog(message, details = {}) {
    const serializedDetails = Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
        .join(' ');
    appendDebugLogFile(SLACK_SOCKET_DEBUG_LOG_FILE, `${message}${serializedDetails ? ` ${serializedDetails}` : ''}`);
}
function readSlackRecord(value, key) {
    const candidate = key && typeof value === 'object' && value !== null
        ? value[key]
        : value;
    return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)
        ? candidate
        : undefined;
}
function readSlackString(record, key) {
    if (!record)
        return '';
    const value = record[key];
    return typeof value === 'string' ? value.trim() : '';
}
function readSlackStringArray(record, key) {
    if (!record)
        return [];
    const value = record[key];
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && item.trim().length > 0)
        .map(item => item.trim());
}
function readSlackBoolean(record, key) {
    if (!record)
        return undefined;
    const value = record[key];
    return typeof value === 'boolean' ? value : undefined;
}
function isRawSlackId(value) {
    return /^[A-Z][A-Z0-9]{8,}$/.test(value);
}
function handleSlackNotification(notification) {
    const existingIndex = slackNotifications.findIndex(existing => existing.id === notification.id);
    if (existingIndex >= 0)
        slackNotifications.splice(existingIndex, 1);
    const mergeIndex = existingIndex < 0 ? findSlackNotificationMergeIndex(notification) : -1;
    const nextNotification = mergeIndex >= 0
        ? mergeSlackNotifications(slackNotifications.splice(mergeIndex, 1)[0], notification)
        : notification;
    slackNotifications.unshift(nextNotification);
    while (slackNotifications.length > MAX_SLACK_NOTIFICATIONS)
        slackNotifications.pop();
    (0, settings_1.saveSlackNotifications)(slackNotifications);
    mainWindow?.webContents.send('slack:notification', nextNotification);
    if (mainWindow && !mainWindow.isFocused())
        mainWindow.flashFrame(true);
}
function findSlackNotificationMergeIndex(notification) {
    const mergeKey = getSlackNotificationMergeKey(notification);
    if (!mergeKey)
        return -1;
    return slackNotifications.findIndex(existing => getSlackNotificationMergeKey(existing) === mergeKey);
}
function getSlackNotificationMergeKey(notification) {
    const channelId = notification.channelId?.trim();
    if (!channelId)
        return null;
    const teamId = notification.teamId?.trim() ?? '';
    if (isSlackDirectMessageChannel(channelId, notification.channelType))
        return `dm:${teamId}:${channelId}`;
    const threadRootTs = notification.threadTs?.trim() || notification.ts?.trim();
    return threadRootTs ? `thread:${teamId}:${channelId}:${threadRootTs}` : null;
}
function mergeSlackNotifications(existing, incoming) {
    if (!existing)
        return incoming;
    const messageCount = (existing.messageCount ?? 1) + 1;
    const merged = {
        id: existing.id,
        text: mergeSlackNotificationText(existing, incoming),
        receivedAt: Math.max(existing.receivedAt, incoming.receivedAt),
        messageCount,
    };
    const priority = getHigherSlackNotificationPriority(existing, incoming);
    merged.priorityRank = priority.rank;
    merged.priorityLabel = priority.label;
    addOptionalSlackString(merged, 'teamId', existing.teamId || incoming.teamId || '');
    addOptionalSlackString(merged, 'teamName', existing.teamName || incoming.teamName || '');
    addOptionalSlackString(merged, 'channelId', existing.channelId || incoming.channelId || '');
    addOptionalSlackString(merged, 'channelName', existing.channelName || incoming.channelName || '');
    addOptionalSlackString(merged, 'channelType', existing.channelType || incoming.channelType || '');
    addOptionalSlackString(merged, 'userId', incoming.userId || existing.userId || '');
    addOptionalSlackString(merged, 'userName', getMergedSlackUserName(existing, incoming) || '');
    addOptionalSlackString(merged, 'ts', incoming.ts || existing.ts || '');
    addOptionalSlackString(merged, 'threadTs', existing.threadTs || incoming.threadTs || '');
    addOptionalSlackString(merged, 'permalink', incoming.permalink || existing.permalink || '');
    return merged;
}
function getHigherSlackNotificationPriority(existing, incoming) {
    const existingRank = normalizeSlackPriorityRank(existing.priorityRank ?? SLACK_PRIORITY_OTHER.rank);
    const incomingRank = normalizeSlackPriorityRank(incoming.priorityRank ?? SLACK_PRIORITY_OTHER.rank);
    if (incomingRank < existingRank)
        return { rank: incomingRank, label: incoming.priorityLabel ?? getSlackPriorityLabelForRank(incomingRank) };
    return { rank: existingRank, label: existing.priorityLabel ?? getSlackPriorityLabelForRank(existingRank) };
}
function getSlackPriorityLabelForRank(rank) {
    switch (normalizeSlackPriorityRank(rank)) {
        case SLACK_PRIORITY_MENTION.rank:
            return SLACK_PRIORITY_MENTION.label;
        case SLACK_PRIORITY_DM.rank:
            return SLACK_PRIORITY_DM.label;
        case SLACK_PRIORITY_THREAD_MENTION.rank:
            return SLACK_PRIORITY_THREAD_MENTION.label;
        case SLACK_PRIORITY_THREAD_WRITTEN.rank:
            return SLACK_PRIORITY_THREAD_WRITTEN.label;
        default:
            return SLACK_PRIORITY_OTHER.label;
    }
}
function getMergedSlackUserName(existing, incoming) {
    const existingUser = existing.userName?.trim();
    const incomingUser = incoming.userName?.trim();
    if (!existingUser)
        return incomingUser || undefined;
    if (!incomingUser || incomingUser === existingUser)
        return existingUser;
    return 'Multiple people';
}
function mergeSlackNotificationText(existing, incoming) {
    const existingText = existing.messageCount && existing.messageCount > 1
        ? existing.text
        : formatSlackNotificationMessageLine(existing);
    return truncateSlackText(`${existingText}\n${formatSlackNotificationMessageLine(incoming)}`);
}
function formatSlackNotificationMessageLine(notification) {
    const sender = notification.userName?.trim();
    const text = notification.text.trim() || '(no text)';
    return sender ? `${sender}: ${text}` : text;
}
function handleSlackNotificationDismiss(request) {
    if (!isSlackDirectMessageChannel(request.channelId, request.channelType))
        return 0;
    const existingIndex = findSlackNotificationDismissIndex(request);
    if (existingIndex < 0)
        return 0;
    slackNotifications.splice(existingIndex, 1);
    (0, settings_1.saveSlackNotifications)(slackNotifications);
    mainWindow?.webContents.send('slack:list-update', slackNotifications.map(notification => ({ ...notification })));
    return 1;
}
function findSlackNotificationDismissIndex(request) {
    const targetTs = request.targetTs?.trim();
    if (targetTs) {
        return slackNotifications.findIndex(notification => matchesSlackNotificationConversation(notification, request) &&
            (notification.ts === targetTs || notification.threadTs === targetTs));
    }
    const replyTs = (request.replyTs ?? request.ts)?.trim();
    const replyAt = parseSlackTimestamp(replyTs);
    const receivedAt = request.receivedAt;
    let fallbackIndex = -1;
    let fallbackScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < slackNotifications.length; index += 1) {
        const notification = slackNotifications[index];
        if (!notification || !matchesSlackNotificationConversation(notification, request))
            continue;
        const notificationTs = parseSlackTimestamp(notification.ts);
        if (replyAt !== null && notificationTs !== null) {
            if (notificationTs >= replyAt)
                continue;
            if (notificationTs > fallbackScore) {
                fallbackScore = notificationTs;
                fallbackIndex = index;
            }
            continue;
        }
        if (receivedAt !== undefined && notification.receivedAt > receivedAt)
            continue;
        return index;
    }
    return fallbackIndex;
}
function matchesSlackNotificationConversation(notification, request) {
    if (notification.channelId !== request.channelId)
        return false;
    if (request.teamId && notification.teamId && notification.teamId !== request.teamId)
        return false;
    return true;
}
function parseSlackTimestamp(value) {
    if (!value)
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function isSlackDirectMessageChannel(channelId, channelType) {
    return channelType === 'im' || channelType === 'mpim' || channelId.startsWith('D');
}
function removeSlackNotification(id) {
    const existingIndex = slackNotifications.findIndex(existing => existing.id === id);
    if (existingIndex < 0)
        return false;
    slackNotifications.splice(existingIndex, 1);
    (0, settings_1.saveSlackNotifications)(slackNotifications);
    mainWindow?.webContents.send('slack:list-update', slackNotifications.map(notification => ({ ...notification })));
    return true;
}
async function openSlackNotification(id) {
    const notification = slackNotifications.find(existing => existing.id === id);
    if (!notification)
        return false;
    const targetUrls = getSlackNotificationTargetUrls(notification);
    if (targetUrls.length === 0)
        return false;
    for (const targetUrl of targetUrls) {
        try {
            await electron_1.shell.openExternal(targetUrl);
            return true;
        }
        catch (error) {
            debugSlackLog('Could not open Slack notification target', {
                targetUrl,
                error: getErrorMessage(error),
            });
        }
    }
    return false;
}
function getSlackNotificationTargetUrls(notification) {
    const targetUrls = [
        getSlackNotificationAppTargetUrl(notification),
        getSlackNotificationWebTargetUrl(notification),
    ].filter((targetUrl) => Boolean(targetUrl));
    return [...new Set(targetUrls)];
}
function getSlackNotificationAppTargetUrl(notification) {
    const teamId = notification.teamId?.trim();
    const channelId = notification.channelId?.trim();
    if (!teamId)
        return null;
    if (channelId) {
        const messageTs = notification.ts?.trim();
        const messageQuery = messageTs ? `&message=${encodeURIComponent(messageTs)}` : '';
        const threadTs = getSlackNotificationThreadReplyTs(notification);
        const threadQuery = threadTs ? `&thread_ts=${encodeURIComponent(threadTs)}` : '';
        return `slack://channel?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(channelId)}${messageQuery}${threadQuery}`;
    }
    const channelType = notification.channelType?.trim();
    const userId = notification.userId?.trim();
    if (channelType === 'im' && userId) {
        return `slack://user?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(userId)}`;
    }
    return `slack://open?team=${encodeURIComponent(teamId)}`;
}
function getSlackNotificationWebTargetUrl(notification) {
    if (notification.permalink)
        return notification.permalink;
    const channelId = notification.channelId?.trim();
    if (!channelId)
        return null;
    const targetUrl = new URL('https://slack.com/app_redirect');
    targetUrl.searchParams.set('channel', channelId);
    const messageTs = notification.ts?.trim();
    if (messageTs)
        targetUrl.searchParams.set('message_ts', messageTs);
    const threadTs = getSlackNotificationThreadReplyTs(notification);
    if (threadTs) {
        targetUrl.searchParams.set('thread_ts', threadTs);
        targetUrl.searchParams.set('cid', channelId);
    }
    const teamId = notification.teamId?.trim();
    if (teamId)
        targetUrl.searchParams.set('team', teamId);
    return targetUrl.toString();
}
function getSlackNotificationThreadReplyTs(notification) {
    const threadTs = notification.threadTs?.trim();
    const messageTs = notification.ts?.trim();
    return threadTs && threadTs !== messageTs ? threadTs : '';
}
function restorePersistedSlackNotifications() {
    slackNotifications.length = 0;
    slackNotifications.push(...(0, settings_1.loadSlackNotifications)().slice(0, MAX_SLACK_NOTIFICATIONS));
}
function restorePersistedManualTasks() {
    manualTasks.length = 0;
    manualTasks.push(...(0, settings_1.loadManualTasks)().slice(0, MAX_MANUAL_TASKS));
}
function restorePersistedRecurringTasks() {
    recurringTasks.length = 0;
    recurringTasks.push(...(0, settings_1.loadRecurringTasks)().slice(0, MAX_RECURRING_TASKS));
}
function applyTerminalUpdate(update) {
    const previousSession = sessionManager?.getSession(update.id);
    const session = sessionManager?.updateTerminalState(update);
    if (!session)
        return false;
    debugTerminalUpdate('terminal update applied', {
        ...terminalUpdateDebugDetails(update),
        previousStatus: previousSession?.status,
        nextStatus: session.status,
    });
    saveSessionsAfterTerminalStatusChange(previousSession?.status, session.status);
    return true;
}
function applyTerminalEvent(event) {
    const previousSession = sessionManager?.getSession(event.id);
    const result = sessionManager?.updateTerminalEventWithDetails(event);
    if (!result)
        return false;
    debugTerminalUpdate('terminal event applied', {
        ...terminalEventDebugDetails(event, getTerminalEventSessionName(event)),
        ...terminalEventStatusDebugDetails(result.statusUpdate),
        previousStatus: previousSession?.status,
        nextStatus: result.session.status,
    });
    saveSessionsAfterTerminalStatusChange(previousSession?.status, result.session.status);
    return true;
}
function saveSessionsAfterTerminalStatusChange(previousStatus, nextStatus) {
    if (nextStatus === 'error' ||
        nextStatus === 'stopped' ||
        nextStatus === 'detached' ||
        previousStatus === 'error' ||
        previousStatus === 'stopped' ||
        previousStatus === 'detached') {
        (0, settings_1.saveSessions)(getSessionsStateToSave());
    }
}
function handleTerminalUpdate(update) {
    if (applyTerminalUpdate(update))
        return;
    debugTerminalUpdate('terminal update queued for missing session', terminalUpdateDebugDetails(update));
    pendingTerminalUpdates.set(update.id, update);
}
function handleTerminalEvent(event) {
    debugTerminalUpdate('terminal event received', terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
    if (applyTerminalEvent(event))
        return;
    debugTerminalUpdate('terminal event queued for missing session', terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
    queuePendingTerminalEvent(event);
}
function flushPendingTerminalUpdates(id) {
    if (id) {
        const update = pendingTerminalUpdates.get(id);
        if (!update || !applyTerminalUpdate(update))
            return;
        debugTerminalUpdate('pending terminal update flushed', terminalUpdateDebugDetails(update));
        pendingTerminalUpdates.delete(id);
        return;
    }
    [...pendingTerminalUpdates.keys()].forEach(sessionId => {
        flushPendingTerminalUpdates(sessionId);
    });
}
function queuePendingTerminalEvent(event) {
    const events = pendingTerminalEvents.get(event.id) ?? [];
    events.push(event);
    if (events.length > MAX_PENDING_TERMINAL_EVENTS_PER_SESSION) {
        events.shift();
        debugTerminalUpdate('oldest pending terminal event dropped', {
            id: event.id,
            maxPendingEvents: MAX_PENDING_TERMINAL_EVENTS_PER_SESSION,
        });
    }
    pendingTerminalEvents.set(event.id, events);
}
function flushPendingTerminalEvents(id) {
    if (id) {
        const events = pendingTerminalEvents.get(id);
        if (!events)
            return;
        const remainingEvents = [];
        for (const event of events) {
            if (applyTerminalEvent(event)) {
                debugTerminalUpdate('pending terminal event flushed', terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
            }
            else {
                remainingEvents.push(event);
            }
        }
        if (remainingEvents.length === 0) {
            pendingTerminalEvents.delete(id);
        }
        else {
            pendingTerminalEvents.set(id, remainingEvents);
        }
        return;
    }
    [...pendingTerminalEvents.keys()].forEach(sessionId => {
        flushPendingTerminalEvents(sessionId);
    });
}
async function startTerminalUpdateServer() {
    if (shouldUseExternalBackend()) {
        await ensureBackendServer();
        return;
    }
    startLegacyTerminalUpdateServer();
}
function startLegacyTerminalUpdateServer() {
    if (terminalUpdateServer)
        return;
    const server = (0, node_http_1.createServer)((request, response) => {
        void handleTerminalUpdateHttpRequest(request, response);
    });
    server.on('error', (error) => {
        console.error(`Failed to start terminal update server: ${getErrorMessage(error)}`);
    });
    server.listen(TERMINAL_UPDATE_PORT, TERMINAL_UPDATE_HOST);
    debugTerminalUpdate('terminal update server started', {
        host: TERMINAL_UPDATE_HOST,
        port: TERMINAL_UPDATE_PORT,
        updatePath: TERMINAL_UPDATE_PATH,
        eventPath: TERMINAL_EVENT_PATH,
    });
    terminalUpdateServer = server;
}
function stopTerminalUpdateServer() {
    stopBackendServer();
    if (!terminalUpdateServer)
        return;
    terminalUpdateServer.close();
    terminalUpdateServer = null;
}
async function handleTerminalUpdateHttpRequest(request, response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }
    const requestUrl = new URL(request.url ?? '/', `http://${TERMINAL_UPDATE_HOST}`);
    const requestPath = requestUrl.pathname;
    const isTerminalUpdatePath = requestPath === TERMINAL_UPDATE_PATH;
    const isTerminalEventPath = requestPath === TERMINAL_EVENT_PATH;
    const isTaskApiPath = requestPath === '/api/tasks' ||
        requestPath === '/api/task/add' ||
        requestPath === '/api/manual-task/add';
    const isSlackEventPath = requestPath === SLACK_EVENT_PATH ||
        requestPath === EXTENSION_SLACK_EVENT_PATH;
    const isSlackNotificationPath = requestPath === SLACK_NOTIFICATION_PATH ||
        requestPath === EXTENSION_SLACK_NOTIFICATION_PATH;
    const isSlackNotificationDismissPath = requestPath === SLACK_NOTIFICATION_DISMISS_PATH ||
        requestPath === EXTENSION_SLACK_NOTIFICATION_DISMISS_PATH;
    if (request.method !== 'POST' ||
        (!isTerminalUpdatePath &&
            !isTerminalEventPath &&
            !isTaskApiPath &&
            !isSlackEventPath &&
            !isSlackNotificationPath &&
            !isSlackNotificationDismissPath)) {
        writeJsonResponse(response, 404, { ok: false, error: 'not_found' });
        return;
    }
    let parsedPayload;
    try {
        parsedPayload = JSON.parse(await readHttpBody(request));
    }
    catch (error) {
        const statusCode = error instanceof HttpBodyTooLargeError ? 413 : 400;
        writeJsonResponse(response, statusCode, { ok: false, error: getErrorMessage(error) });
        return;
    }
    if (isTaskApiPath) {
        const task = createManualTask(readManualTaskText(parsedPayload));
        if (!task) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_manual_task' });
            return;
        }
        writeJsonResponse(response, 200, { ok: true, task });
        return;
    }
    else if (isSlackEventPath) {
        try {
            await handleSlackEventEnvelope(parsedPayload);
        }
        catch (error) {
            const message = getErrorMessage(error);
            debugSlackLog('Slack event handling failed', { error: message });
            writeJsonResponse(response, 500, { ok: false, error: message });
            return;
        }
    }
    else if (isSlackNotificationDismissPath) {
        const dismissRequest = parseSlackNotificationDismissRequest(parsedPayload);
        if (!dismissRequest) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_slack_notification_dismiss' });
            return;
        }
        const removed = handleSlackNotificationDismiss(dismissRequest);
        writeJsonResponse(response, 200, { ok: true, removed });
        return;
    }
    else if (isSlackNotificationPath) {
        const notification = parseSlackNotificationRequest(parsedPayload);
        if (!notification) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_slack_notification' });
            return;
        }
        handleSlackNotification(notification);
    }
    else if (isTerminalEventPath) {
        const event = parseTerminalEventRequest(parsedPayload);
        if (!event) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_event' });
            return;
        }
        handleTerminalEvent(event);
    }
    else {
        const update = parseTerminalUpdateRequest(parsedPayload);
        if (!update) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_update' });
            return;
        }
        handleTerminalUpdate(update);
    }
    writeJsonResponse(response, 200, { ok: true });
}
function readHttpBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        let bodyBytes = 0;
        let rejected = false;
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            if (rejected)
                return;
            bodyBytes += Buffer.byteLength(chunk, 'utf8');
            if (bodyBytes > MAX_TERMINAL_EVENT_BODY_BYTES) {
                rejected = true;
                reject(new HttpBodyTooLargeError('request payload is too large'));
                return;
            }
            body += chunk;
        });
        request.on('end', () => {
            if (!rejected)
                resolve(body);
        });
        request.on('error', error => {
            if (!rejected)
                reject(error);
        });
    });
}
function writeJsonResponse(response, statusCode, body) {
    const encodedBody = JSON.stringify(body);
    response.writeHead(statusCode, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(encodedBody),
    });
    response.end(encodedBody);
}
function setupLegacyIpc() {
    electron_1.ipcMain.handle('session:create', (_e, name, cmd, cwd, shellType, sshCommand = '') => {
        const settings = (0, settings_1.loadSettings)();
        const normalizedShellType = isShellType(shellType) ? shellType : settings.defaultShell;
        const session = sessionManager?.createSession(name, cmd, cwd, normalizedShellType, '', sshCommand) ?? null;
        if (session) {
            debugTerminalUpdate('session created from app', {
                id: session.id,
                status: session.status,
                shellType: session.shellType,
                hasCommand: Boolean(session.cmd),
            });
            (0, settings_1.saveSessions)(getSessionsStateToSave());
        }
        return session;
    });
    electron_1.ipcMain.handle('session:remove', async (_e, id) => {
        try {
            if (shouldBackendOwnState()) {
                await backendPost('/api/session/remove', { id });
            }
            else {
                // Always remove the session completely, regardless of status
                sessionManager?.removeSession(id);
            }
            // Always save sessions after removal
            (0, settings_1.saveSessions)(getSessionsStateToSave());
        }
        catch (error) {
            console.error(`Failed to remove session: ${getErrorMessage(error)}`);
        }
    });
    electron_1.ipcMain.handle('session:rename', (_e, id, name) => {
        const sessionId = typeof id === 'string' ? id.trim() : '';
        const nextName = typeof name === 'string' ? name.trim() : '';
        if (!sessionId || !nextName) {
            console.error('Failed to rename session: missing session id or name');
            return null;
        }
        const session = sessionManager?.renameSession(sessionId, nextName) ?? null;
        if (!session) {
            console.error(`Failed to rename session: session "${sessionId}" was not found`);
            return null;
        }
        debugTerminalUpdate('session renamed', {
            id: session.id,
            sessionName: session.name,
        });
        (0, settings_1.saveSessions)(getSessionsStateToSave());
        return session;
    });
    electron_1.ipcMain.handle('session:pause', (_e, id) => {
        const sessionId = typeof id === 'string' ? id.trim() : '';
        if (!sessionId) {
            console.error('Failed to pause session: missing session id');
            return null;
        }
        const session = sessionManager?.pauseSession(sessionId) ?? null;
        if (!session) {
            console.error(`Failed to pause session: session "${sessionId}" was not found`);
            return null;
        }
        debugTerminalUpdate('session paused', { id: session.id, status: session.status });
        return session;
    });
    electron_1.ipcMain.handle('session:list', () => {
        sessionManager?.refreshGitChanges();
        return sessionManager?.getSessions() ?? [];
    });
    electron_1.ipcMain.handle('session:open-review', (_e, cwd) => {
        const settings = (0, settings_1.loadSettings)();
        const cmd = settings.reviewTool.replace('{path}', `"${cwd}"`);
        (0, node_child_process_1.exec)(cmd, (err) => {
            if (err)
                console.error('Failed to open review tool:', err.message);
        });
    });
    electron_1.ipcMain.handle('session:pick-dir', async () => {
        if (!mainWindow)
            return null;
        const result = await electron_1.dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    electron_1.ipcMain.handle('settings:get', () => (0, settings_1.loadSettings)());
    electron_1.ipcMain.handle('settings:set', (_e, settings) => {
        (0, settings_1.saveSettings)(settings);
        handleGoogleCalendarSettingsChanged();
    });
    electron_1.ipcMain.handle('manual-task:list', () => manualTasks.map(task => ({ ...task })));
    electron_1.ipcMain.handle('manual-task:add', (_event, text, createdAt) => createManualTask(text, createdAt));
    electron_1.ipcMain.handle('manual-task:remove', (_event, id) => {
        if (typeof id !== 'string' || !id.trim()) {
            console.error('Failed to remove manual task: missing task id');
            return false;
        }
        return removeManualTask(id.trim());
    });
    electron_1.ipcMain.handle('recurring-task:list', () => recurringTasks.map(cloneRecurringTask));
    electron_1.ipcMain.handle('recurring-task:add', (_event, text, time, schedule) => createRecurringTask(text, time, schedule));
    electron_1.ipcMain.handle('recurring-task:remove', (_event, id) => {
        if (typeof id !== 'string' || !id.trim()) {
            console.error('Failed to remove recurring task: missing task id');
            return false;
        }
        return removeRecurringTask(id.trim());
    });
    electron_1.ipcMain.handle('slack:list', () => slackNotifications.map(notification => ({ ...notification })));
    electron_1.ipcMain.handle('slack:clear', () => {
        slackNotifications.length = 0;
        (0, settings_1.saveSlackNotifications)(slackNotifications);
        mainWindow?.webContents.send('slack:list-update', []);
    });
    electron_1.ipcMain.handle('slack:remove', (_event, id) => {
        if (typeof id !== 'string' || !id.trim())
            return false;
        return removeSlackNotification(id.trim());
    });
    electron_1.ipcMain.handle('slack:open', async (_event, id) => {
        if (typeof id !== 'string' || !id.trim())
            return false;
        try {
            return await openSlackNotification(id.trim());
        }
        catch (error) {
            console.error(`Failed to open Slack notification: ${getErrorMessage(error)}`);
            return false;
        }
    });
    electron_1.ipcMain.handle('slack:start-auth', () => startSlackAuthFlow());
    electron_1.ipcMain.handle('slack:start-listener', () => startSlackSocketListener({ notifyIfMissingConfig: true }));
    electron_1.ipcMain.handle('slack:get-listener-status', () => slackListenerStatus);
}
function setupBackendIpc() {
    electron_1.ipcMain.handle('session:create', async (_e, name, cmd, cwd, shellType, sshCommand = '') => {
        try {
            const result = await backendPost('/api/session/create', {
                name,
                cmd,
                cwd,
                shellType,
                sshCommand,
            });
            return result.session;
        }
        catch (error) {
            console.error(`Failed to create session: ${getErrorMessage(error)}`);
            return null;
        }
    });
    electron_1.ipcMain.handle('session:rename', async (_e, id, name) => {
        try {
            const result = await backendPost('/api/session/rename', { id, name });
            return result.session;
        }
        catch (error) {
            console.error(`Failed to rename session: ${getErrorMessage(error)}`);
            return null;
        }
    });
    electron_1.ipcMain.handle('session:remove', async (_e, id) => {
        const sessionId = typeof id === 'string' ? id.trim() : '';
        if (!sessionId) {
            console.error('Failed to remove session: missing session id');
            return false;
        }
        try {
            await backendPost('/api/session/remove', { id: sessionId });
            return true;
        }
        catch (error) {
            console.error(`Failed to remove session: ${getErrorMessage(error)}`);
            return false;
        }
    });
    electron_1.ipcMain.handle('session:pause', async (_e, id) => {
        const sessionId = typeof id === 'string' ? id.trim() : '';
        if (!sessionId) {
            console.error('Failed to pause session: missing session id');
            return null;
        }
        try {
            const result = await backendPost('/api/session/pause', { id: sessionId });
            if (result.session) {
                applyBackendSessions(backendState.sessions.map(s => s.id === sessionId ? result.session : s));
                debugTerminalUpdate('session paused (backend)', { id: result.session.id, status: result.session.status });
                return result.session;
            }
            return null;
        }
        catch (error) {
            console.error(`Failed to pause session: ${getErrorMessage(error)}`);
            return null;
        }
    });
    electron_1.ipcMain.handle('session:list', async () => {
        try {
            const result = await backendGet('/api/sessions');
            applyBackendSessions(result.sessions);
            return result.sessions;
        }
        catch (error) {
            console.error(`Failed to list sessions: ${getErrorMessage(error)}`);
            return backendState.sessions;
        }
    });
    electron_1.ipcMain.handle('session:open-review', (_e, cwd) => {
        const settings = (0, settings_1.loadSettings)();
        const cmd = settings.reviewTool.replace('{path}', `"${cwd}"`);
        (0, node_child_process_1.exec)(cmd, (err) => {
            if (err)
                console.error('Failed to open review tool:', err.message);
        });
    });
    electron_1.ipcMain.handle('session:pick-dir', async () => {
        if (!mainWindow)
            return null;
        const result = await electron_1.dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
        });
        return result.canceled ? null : (result.filePaths[0] ?? null);
    });
    electron_1.ipcMain.handle('settings:get', async () => {
        try {
            const result = await backendGet('/api/settings');
            return result.settings;
        }
        catch {
            return (0, settings_1.loadSettings)();
        }
    });
    electron_1.ipcMain.handle('settings:set', async (_e, settings) => {
        await backendPost('/api/settings', settings);
        handleGoogleCalendarSettingsChanged();
    });
    electron_1.ipcMain.handle('manual-task:list', async () => {
        try {
            const result = await backendGet('/api/manual-tasks');
            applyBackendManualTasks(result.manualTasks);
            return result.manualTasks;
        }
        catch (error) {
            console.error(`Failed to list manual tasks: ${getErrorMessage(error)}`);
            return manualTasks.map(task => ({ ...task }));
        }
    });
    electron_1.ipcMain.handle('manual-task:add', async (_event, text, createdAt) => {
        try {
            const body = { text };
            if (typeof createdAt === 'number' && Number.isFinite(createdAt))
                body['createdAt'] = createdAt;
            const result = await backendPost('/api/manual-task/add', body);
            return result.task;
        }
        catch (error) {
            console.error(`Failed to add manual task: ${getErrorMessage(error)}`);
            return null;
        }
    });
    electron_1.ipcMain.handle('manual-task:remove', async (_event, id) => {
        try {
            const result = await backendPost('/api/manual-task/remove', { id });
            return result.removed ?? false;
        }
        catch (error) {
            console.error(`Failed to remove manual task: ${getErrorMessage(error)}`);
            return false;
        }
    });
    electron_1.ipcMain.handle('recurring-task:list', async () => {
        try {
            const result = await backendGet('/api/recurring-tasks');
            applyBackendRecurringTasks(result.recurringTasks);
            return result.recurringTasks;
        }
        catch (error) {
            console.error(`Failed to list recurring tasks: ${getErrorMessage(error)}`);
            return recurringTasks.map(cloneRecurringTask);
        }
    });
    electron_1.ipcMain.handle('recurring-task:add', async (_event, text, time, schedule) => {
        try {
            const result = await backendPost('/api/recurring-task/add', {
                text,
                time,
                schedule,
            });
            return result.task;
        }
        catch (error) {
            console.error(`Failed to add recurring task: ${getErrorMessage(error)}`);
            return null;
        }
    });
    electron_1.ipcMain.handle('recurring-task:remove', async (_event, id) => {
        try {
            const result = await backendPost('/api/recurring-task/remove', { id });
            return result.removed ?? false;
        }
        catch (error) {
            console.error(`Failed to remove recurring task: ${getErrorMessage(error)}`);
            return false;
        }
    });
    electron_1.ipcMain.handle('slack:list', async () => {
        try {
            const result = await backendGet('/api/slack/notifications');
            applyBackendSlackNotifications(result.slackNotifications);
            return result.slackNotifications;
        }
        catch (error) {
            console.error(`Failed to list Slack notifications: ${getErrorMessage(error)}`);
            return slackNotifications.map(notification => ({ ...notification }));
        }
    });
    electron_1.ipcMain.handle('slack:clear', async () => {
        await backendPost('/api/slack/clear');
    });
    electron_1.ipcMain.handle('slack:remove', async (_event, id) => {
        try {
            const result = await backendPost('/api/slack/remove', { id });
            return result.removed ?? false;
        }
        catch {
            return false;
        }
    });
    electron_1.ipcMain.handle('slack:open', async (_event, id) => {
        if (typeof id !== 'string' || !id.trim())
            return false;
        try {
            return await openSlackNotification(id.trim());
        }
        catch (error) {
            console.error(`Failed to open Slack notification: ${getErrorMessage(error)}`);
            return false;
        }
    });
    electron_1.ipcMain.handle('slack:start-auth', () => startSlackAuthFlow());
    electron_1.ipcMain.handle('slack:start-listener', () => startSlackSocketListener({ notifyIfMissingConfig: true }));
    electron_1.ipcMain.handle('slack:get-listener-status', () => slackListenerStatus);
}
function setupIpc() {
    if (shouldBackendOwnState()) {
        setupBackendIpc();
    }
    else {
        setupLegacyIpc();
    }
    setupSharedIpc();
    setupGoogleCalendarIpc();
}
function setupSharedIpc() {
    electron_1.ipcMain.handle('shell:get-config', () => ({
        url: process.env['MULTITASKER_SHELL_SERVER_URL']?.trim() || 'ws://127.0.0.1:4321',
        token: process.env['SHELL_AUTH_TOKEN'] || '',
    }));
    electron_1.ipcMain.handle('shell:create-pty', async (_e, cwdArg, nameArg) => {
        const cwd = typeof cwdArg === 'string' && cwdArg.trim()
            ? cwdArg.trim()
            : (process.env['USERPROFILE'] || process.env['HOME'] || process.cwd());
        const settings = (0, settings_1.loadSettings)();
        const localShell = settings.defaultShell === 'bash' ? 'bash' : 'powershell';
        try {
            const pty = await (0, shellServerClient_1.createShellPty)({ cwd, track: false });
            const shortId = pty.sessionId.slice(0, 8);
            const name = typeof nameArg === 'string' && nameArg.trim() ? nameArg.trim() : `shell ${shortId}`;
            if (shouldBackendOwnState()) {
                try {
                    const result = await backendPost('/api/session/create', {
                        name,
                        cmd: '',
                        cwd: pty.cwd,
                        shellType: localShell,
                        requestedId: pty.sessionId,
                    });
                    return result.session ?? null;
                }
                catch (error) {
                    console.error(`Failed to register shell PTY with backend: ${getErrorMessage(error)}`);
                    return null;
                }
            }
            const session = sessionManager?.createSession(name, '', pty.cwd, localShell, pty.sessionId) ?? null;
            if (session) {
                debugTerminalUpdate('shell pty created from app', {
                    id: session.id,
                    pid: pty.pid,
                    shell: pty.shell,
                });
                (0, settings_1.saveSessions)(getSessionsStateToSave());
            }
            return session;
        }
        catch (error) {
            console.error(`Failed to create shell PTY: ${getErrorMessage(error)}`);
            return null;
        }
    });
    electron_1.ipcMain.handle('shell:create-ssh', async (_e, optsArg) => {
        const opts = (optsArg && typeof optsArg === 'object') ? optsArg : {};
        const host = typeof opts.host === 'string' ? opts.host.trim() : '';
        const username = typeof opts.username === 'string' ? opts.username.trim() : '';
        if (!host || !username) {
            console.error('shell:create-ssh missing host/username');
            return null;
        }
        const port = typeof opts.port === 'number' && opts.port > 0 ? opts.port : 22;
        const sshOpts = { host, username, port };
        if (typeof opts.privateKeyPath === 'string' && opts.privateKeyPath.trim())
            sshOpts.privateKeyPath = opts.privateKeyPath.trim();
        if (typeof opts.passphrase === 'string')
            sshOpts.passphrase = opts.passphrase;
        if (typeof opts.agent === 'string' && opts.agent.trim())
            sshOpts.agent = opts.agent.trim();
        if (typeof opts.initCommand === 'string' && opts.initCommand.trim())
            sshOpts.initCommand = opts.initCommand.trim();
        try {
            const ssh = await (0, shellServerClient_1.createShellSsh)(sshOpts);
            const shortId = ssh.sessionId.slice(0, 8);
            const baseName = typeof opts.name === 'string' && opts.name.trim()
                ? opts.name.trim()
                : `ssh ${username}@${host}${port !== 22 ? ":" + port : ""} ${shortId}`;
            const sessionSshOptions = { host, username };
            if (port !== 22)
                sessionSshOptions.port = port;
            if (sshOpts.privateKeyPath)
                sessionSshOptions.privateKeyPath = sshOpts.privateKeyPath;
            if (sshOpts.agent)
                sessionSshOptions.agent = sshOpts.agent;
            if (sshOpts.initCommand)
                sessionSshOptions.initCommand = sshOpts.initCommand;
            if (shouldBackendOwnState()) {
                try {
                    const result = await backendPost('/api/session/create', {
                        name: baseName,
                        cmd: '',
                        cwd: ssh.cwd || '',
                        shellType: 'ssh',
                        sshCommand: `${username}@${host}${port !== 22 ? ":" + port : ""}`,
                        sshOptions: sessionSshOptions,
                        requestedId: ssh.sessionId,
                    });
                    return result.session ?? null;
                }
                catch (error) {
                    console.error(`Failed to register SSH session with backend: ${getErrorMessage(error)}`);
                    return null;
                }
            }
            const session = sessionManager?.createSession(baseName, '', ssh.cwd || '', 'ssh', ssh.sessionId, `${username}@${host}${port !== 22 ? ":" + port : ""}`, '', undefined, sessionSshOptions) ?? null;
            if (session) {
                debugTerminalUpdate('shell ssh created from app', {
                    id: session.id,
                    host,
                    username,
                });
                (0, settings_1.saveSessions)(getSessionsStateToSave());
            }
            return session;
        }
        catch (error) {
            console.error(`Failed to create SSH session: ${getErrorMessage(error)}`);
            return null;
        }
    });
    electron_1.ipcMain.handle('shell:reconnect-ssh', async (_e, idArg) => {
        const sessionId = typeof idArg === 'string' ? idArg.trim() : '';
        if (!sessionId) {
            return { ok: false, error: 'missing_session_id' };
        }
        return reconnectShellSshSession(sessionId);
    });
    electron_1.ipcMain.handle('shell:focus-vscode', async (_e, idArg) => {
        const sessionId = typeof idArg === 'string' ? idArg.trim() : '';
        if (!sessionId)
            return { ok: false, error: 'missing_session_id' };
        return focusVscodeForSession(sessionId);
    });
}
// In-flight reconnect promises keyed by session id. Used so concurrent
// renderer requests for the same session collapse into one supervisor call —
// otherwise the supervisor would reject the second spawn with
// "session already exists" even though the reconnect actually succeeded.
const sshReconnectInFlight = new Map();
async function reconnectShellSshSession(sessionId) {
    const existing = sshReconnectInFlight.get(sessionId);
    if (existing)
        return existing;
    const promise = (async () => {
        try {
            const session = await lookupSessionForReconnect(sessionId);
            if (!session)
                return { ok: false, error: 'session_not_found' };
            if (session.shellType !== 'ssh')
                return { ok: false, error: 'not_ssh_session' };
            const status = session.status;
            if (status === 'error' || status === 'stopped' || status === 'detached') {
                return { ok: false, error: `session_not_reconnectable:${status}` };
            }
            if (typeof session.terminalExitCode === 'number') {
                return { ok: false, error: 'session_already_exited' };
            }
            const sshOpts = buildSshConnectOptions(session);
            if (!sshOpts)
                return { ok: false, error: 'ssh_options_missing' };
            try {
                await (0, shellServerClient_1.createShellSsh)({ ...sshOpts, sessionId });
            }
            catch (error) {
                const message = getErrorMessage(error);
                // Supervisor may have a stale session from a previous reconnect
                // race — treat that as success and let the renderer attach.
                if (/already\s*exists/i.test(message)) {
                    debugTerminalUpdate('shell ssh reconnect idempotent', { id: sessionId });
                    return { ok: true, sessionId };
                }
                debugTerminalUpdate('shell ssh reconnect failed', { id: sessionId, error: message });
                return { ok: false, error: message };
            }
            debugTerminalUpdate('shell ssh reconnect ok', {
                id: sessionId,
                host: sshOpts.host,
                username: sshOpts.username,
            });
            if (!shouldBackendOwnState() && sessionManager) {
                sessionManager.touchSession(sessionId);
                (0, settings_1.saveSessions)(getSessionsStateToSave());
            }
            return { ok: true, sessionId };
        }
        catch (error) {
            return { ok: false, error: getErrorMessage(error) };
        }
    })();
    sshReconnectInFlight.set(sessionId, promise);
    try {
        return await promise;
    }
    finally {
        sshReconnectInFlight.delete(sessionId);
    }
}
async function lookupSessionForReconnect(sessionId) {
    if (shouldBackendOwnState()) {
        return backendState.sessions.find(s => s.id === sessionId) ?? null;
    }
    return sessionManager?.getSession(sessionId) ?? null;
}
async function focusVscodeForSession(sessionId) {
    const session = await lookupSessionForReconnect(sessionId);
    if (!session)
        return { ok: false, error: 'session_not_found' };
    const meta = session.clientMetadata;
    if (!meta || meta.kind !== 'vscode')
        return { ok: false, error: 'no_vscode_metadata' };
    const workspace = meta.workspace || session.cwd || '';
    if (!workspace)
        return { ok: false, error: 'no_workspace' };
    // Spawn `code --reuse-window <workspace>`. Setting VSCODE_IPC_HOOK_CLI in
    // the env makes the CLI talk to the *originating* VS Code instance (the one
    // that opened this terminal), so the right window is focused instead of
    // potentially opening a new one.
    const env = { ...process.env };
    if (meta.ipcHook)
        env['VSCODE_IPC_HOOK_CLI'] = meta.ipcHook;
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'code.cmd' : 'code';
    try {
        const child = (0, node_child_process_1.spawn)(cmd, ['--reuse-window', workspace], {
            env,
            detached: true,
            stdio: 'ignore',
            shell: isWindows,
        });
        child.on('error', (err) => {
            console.error('[focus-vscode] spawn failed', err.message);
        });
        child.unref();
        return { ok: true };
    }
    catch (e) {
        return { ok: false, error: e.message };
    }
}
function buildSshConnectOptions(session) {
    if (session.sshOptions && session.sshOptions.host && session.sshOptions.username) {
        const o = session.sshOptions;
        const opts = {
            host: o.host,
            username: o.username,
            port: o.port ?? 22,
        };
        if (o.privateKeyPath)
            opts.privateKeyPath = o.privateKeyPath;
        if (o.agent)
            opts.agent = o.agent;
        if (o.initCommand)
            opts.initCommand = o.initCommand;
        return opts;
    }
    const parsed = parseSshCommand(session.sshCommand);
    if (!parsed)
        return null;
    return { host: parsed.host, username: parsed.username, port: parsed.port };
}
function parseSshCommand(value) {
    if (!value)
        return null;
    const trimmed = value.trim();
    // user@host[:port] — does not handle IPv6 with brackets; falls back to null.
    const m = /^([^@\s]+)@([^@:\s]+)(?::(\d+))?$/.exec(trimmed);
    if (!m)
        return null;
    const username = m[1];
    const host = m[2];
    if (!username || !host)
        return null;
    const port = m[3] ? parseInt(m[3], 10) : 22;
    if (!Number.isFinite(port) || port <= 0)
        return null;
    return { username, host, port };
}
function setupGoogleCalendarIpc() {
    electron_1.ipcMain.handle('google-calendar:list', () => googleCalendarEvents.map(cloneGoogleCalendarEvent));
    electron_1.ipcMain.handle('google-calendar:status', () => getFreshGoogleCalendarStatus());
    electron_1.ipcMain.handle('google-calendar:connect', () => startGoogleCalendarAuthFlow());
    electron_1.ipcMain.handle('google-calendar:disconnect', (_event, id) => disconnectGoogleCalendar(id));
    electron_1.ipcMain.handle('google-calendar:refresh', () => refreshGoogleCalendarEvents());
    electron_1.ipcMain.handle('google-calendar:open', (_event, id) => openGoogleCalendarEvent(id));
}
function getSessionsStateToSave() {
    const allSessions = sessionManager?.getSessions() ?? [];
    return allSessions
        .filter(s => s.status !== 'error' && s.status !== 'stopped' && s.status !== 'detached')
        .map(s => ({
        id: s.id,
        name: s.name,
        cmd: s.cmd,
        cwd: s.cwd,
        shellType: s.shellType,
        ...(s.sshCommand ? { sshCommand: s.sshCommand } : {}),
        ...(s.sshOptions ? { sshOptions: s.sshOptions } : {}),
        ...(s.terminalRef ? { terminalRef: s.terminalRef } : {}),
        ...(s.terminalPid !== undefined ? { terminalPid: s.terminalPid } : {}),
    }));
}
function restorePersistedSessions(settings) {
    const persistedSessions = (0, settings_1.loadSessions)();
    persistedSessions
        .filter(s => s.status !== 'stopped' && s.status !== 'error' && s.status !== 'detached')
        .forEach(sessionState => {
        const rawShellType = String(sessionState.shellType);
        const shellType = isShellType(rawShellType) ? rawShellType : settings.defaultShell;
        sessionManager?.createSession(sessionState.name, sessionState.cmd, sessionState.cwd, shellType, sessionState.id ?? '', sessionState.sshCommand ?? '', sessionState.terminalRef ?? '', sessionState.terminalPid, sessionState.sshOptions);
    });
    for (const session of sessionManager?.getSessions() ?? []) {
        if (session.terminalRef)
            taskIdByTerminalRef.set(session.terminalRef, session.id);
    }
    flushPendingTerminalUpdates();
    flushPendingTerminalEvents();
}
function getRestorableWindowState() {
    const savedState = (0, settings_1.loadWindowState)();
    if (!savedState)
        return null;
    const state = {
        ...savedState,
        width: Math.max(WINDOW_MIN_WIDTH, savedState.width),
        height: Math.max(WINDOW_MIN_HEIGHT, savedState.height),
    };
    return isWindowBoundsVisible(state) ? state : null;
}
function isWindowBoundsVisible(bounds) {
    return electron_1.screen.getAllDisplays().some(display => {
        const workArea = display.workArea;
        const visibleWidth = Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x);
        const visibleHeight = Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y);
        return visibleWidth >= MIN_VISIBLE_WINDOW_AREA && visibleHeight >= MIN_VISIBLE_WINDOW_AREA;
    });
}
function trackWindowState(window) {
    const queueSave = () => queueWindowStateSave(window);
    window.on('move', queueSave);
    window.on('resize', queueSave);
    window.on('maximize', queueSave);
    window.on('unmaximize', queueSave);
    window.on('close', () => {
        if (windowStateSaveTimer) {
            clearTimeout(windowStateSaveTimer);
            windowStateSaveTimer = null;
        }
        saveWindowStateForWindow(window);
    });
}
function queueWindowStateSave(window) {
    if (window.isDestroyed())
        return;
    if (windowStateSaveTimer)
        clearTimeout(windowStateSaveTimer);
    windowStateSaveTimer = setTimeout(() => {
        windowStateSaveTimer = null;
        saveWindowStateForWindow(window);
    }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
}
function saveWindowStateForWindow(window) {
    if (window.isDestroyed())
        return;
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    (0, settings_1.saveWindowState)({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        isMaximized: window.isMaximized(),
    });
}
function createWindow() {
    const backendOwnsState = shouldBackendOwnState();
    if (!backendOwnsState)
        sessionManager = new sessionManager_1.SessionManager();
    const savedWindowState = getRestorableWindowState();
    const windowOptions = {
        width: savedWindowState?.width ?? WINDOW_WIDTH,
        height: savedWindowState?.height ?? WINDOW_HEIGHT,
        minWidth: WINDOW_MIN_WIDTH,
        minHeight: WINDOW_MIN_HEIGHT,
        backgroundColor: '#0d1117',
        webPreferences: {
            preload: node_path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false,
        },
    };
    if (savedWindowState) {
        windowOptions.x = savedWindowState.x;
        windowOptions.y = savedWindowState.y;
    }
    mainWindow = new electron_1.BrowserWindow(windowOptions);
    if (savedWindowState?.isMaximized)
        mainWindow.maximize();
    trackWindowState(mainWindow);
    if (!backendOwnsState) {
        sessionManager?.on('sessionUpdate', (sessions) => {
            mainWindow?.webContents.send('session:list-update', sessions);
        });
    }
    mainWindow.on('focus', () => {
        mainWindow?.flashFrame(false);
        if (backendOwnsState) {
            void backendGet('/api/sessions')
                .then(result => applyBackendSessions(result.sessions))
                .catch(error => console.error(`Failed to refresh backend sessions: ${getErrorMessage(error)}`));
        }
        else {
            sessionManager?.refreshGitChanges();
        }
    });
    if (backendOwnsState) {
        applyBackendState(backendState);
    }
    else {
        const settings = (0, settings_1.loadSettings)();
        restorePersistedSessions(settings);
        restorePersistedManualTasks();
        restorePersistedRecurringTasks();
        restorePersistedSlackNotifications();
        startRecurringTaskScheduler();
    }
    restorePersistedGoogleCalendarEvents();
    startGoogleCalendarScheduler();
    void mainWindow.loadFile(node_path_1.default.join(__dirname, '..', '..', 'desktop', 'index.html'));
}
setupIpc();
const hasSingleInstanceLock = electron_1.app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => {
        if (!mainWindow)
            return;
        if (mainWindow.isMinimized())
            mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    });
}
void electron_1.app.whenReady().then(async () => {
    (0, settings_1.setStorageDirectory)(electron_1.app.getPath('userData'));
    if (shouldBackendOwnState()) {
        await startTerminalUpdateServer();
        createWindow();
    }
    else {
        createWindow();
        await startTerminalUpdateServer();
    }
    startSlackSocketListener({ notifyIfMissingConfig: false });
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('before-quit', () => {
    isQuitting = true;
    stopRecurringTaskScheduler();
    stopGoogleCalendarScheduler();
    stopSlackAuthFlow();
    stopSlackSocketListener();
    stopTerminalUpdateServer();
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
