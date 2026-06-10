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
const MAX_PENDING_TERMINAL_EVENTS_PER_SESSION = 200;
const DEBUG_LOG_DIRECTORY = node_path_1.default.join('.tmp', 'desktop');
const DEBUG_LOG_FILE_EXTENSION = '.log';
const TERMINAL_UPDATE_DEBUG_ENV = 'MULTITASKER_DEBUG_TERMINAL';
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
const googleCalendarEvents = [];
const backendState = {
    sessions: [],
    manualTasks,
    recurringTasks,
};
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
        Array.isArray(candidate.recurringTasks);
}
function applyBackendState(state) {
    if (shouldBackendOwnState()) {
        applyBackendSessions(state.sessions);
        applyBackendManualTasks(state.manualTasks);
        applyBackendRecurringTasks(state.recurringTasks);
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
    return `${text.slice(0, MAX_MANUAL_TASK_TEXT_LENGTH - 1)}â€¦`;
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
    if (request.method !== 'POST' ||
        (!isTerminalUpdatePath &&
            !isTerminalEventPath &&
            !isTaskApiPath)) {
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
// renderer requests for the same session collapse into one supervisor call â€”
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
                // race â€” treat that as success and let the renderer attach.
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
    // user@host[:port] â€” does not handle IPv6 with brackets; falls back to null.
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
        startRecurringTaskScheduler();
    }
    restorePersistedGoogleCalendarEvents();
    startGoogleCalendarScheduler();
    if (process.env['NODE_ENV'] === 'development') {
        void mainWindow.loadURL('http://localhost:5173');
    }
    else {
        void mainWindow.loadFile(node_path_1.default.join(__dirname, '..', 'renderer', 'index.html'));
    }
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
    stopTerminalUpdateServer();
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
