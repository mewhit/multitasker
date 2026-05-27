"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_crypto_1 = require("node:crypto");
const node_http_1 = require("node:http");
const web_api_1 = require("@slack/web-api");
const sessionManager_1 = require("../desktop/sessionManager");
const settings_1 = require("../desktop/settings");
const HOST = '127.0.0.1';
const DEFAULT_PORT = 39017;
const PORT = readBackendPort();
const TERMINAL_UPDATE_PATH = '/terminal-update';
const TERMINAL_EVENT_PATH = '/terminal-event';
const VSCODE_WINDOW_PATH = '/vscode-window';
const VSCODE_COMMAND_PATH = '/vscode-command';
const SLACK_EVENT_PATH = '/slack-event';
const SLACK_NOTIFICATION_PATH = '/slack-notification';
const SLACK_NOTIFICATION_DISMISS_PATH = '/slack-notification-dismiss';
const EXTENSION_VSCODE_TERMINAL_UPDATE_PATH = '/extensions/vscode/terminal-updates';
const EXTENSION_VSCODE_TERMINAL_EVENT_PATH = '/extensions/vscode/terminal-events';
const EXTENSION_VSCODE_WINDOW_PATH = '/extensions/vscode/windows';
const EXTENSION_VSCODE_COMMAND_PATH = '/extensions/vscode/commands';
const EXTENSION_VSCODE_TASKS_PATH = '/extensions/vscode/tasks';
const EXTENSION_SLACK_EVENT_PATH = '/extensions/slack/events';
const EXTENSION_SLACK_NOTIFICATION_PATH = '/extensions/slack/notifications';
const EXTENSION_SLACK_NOTIFICATION_DISMISS_PATH = '/extensions/slack/notification-dismiss';
const MAX_HTTP_BODY_BYTES = 512 * 1024;
const MAX_MANUAL_TASKS = 200;
const MAX_MANUAL_TASK_TEXT_LENGTH = 4000;
const MAX_RECURRING_TASKS = 100;
const RECURRING_TASK_CHECK_INTERVAL_MS = 30 * 1000;
const MAX_SLACK_NOTIFICATIONS = 100;
const MAX_SLACK_TEXT_LENGTH = 4000;
const MAX_SLACK_DEBUG_TEXT_LENGTH = 700;
const MAX_PENDING_TERMINAL_EVENTS_PER_SESSION = 200;
const MAX_PENDING_VSCODE_COMMANDS_PER_WINDOW = 50;
const VSCODE_COMMAND_LONG_POLL_TIMEOUT_MS = 25000;
const SLACK_USER_CONVERSATIONS_REFRESH_MS = 5 * 60 * 1000;
const DEBUG_LOG_DIRECTORY = 'debug-log';
const DEBUG_LOG_FILE_EXTENSION = '.log';
const TERMINAL_UPDATE_DEBUG_ENV = 'MULTITASKER_DEBUG_TERMINAL';
const SLACK_SOCKET_DEBUG_LOG_FILE = 'slack-connector.log';
const SLACK_ENV_RELATIVE_PATH = node_path_1.default.join('extension', 'slack', '.env');
const BACKEND_OWNS_STATE_ENV = 'MULTITASKER_BACKEND_OWNS_STATE';
const GOOGLE_CALENDAR_CLIENT_ID_ENV = 'MULTITASKER_GOOGLE_CALENDAR_CLIENT_ID';
const GOOGLE_CALENDAR_CLIENT_SECRET_ENV = 'MULTITASKER_GOOGLE_CALENDAR_CLIENT_SECRET';
const GITHUB_TOKEN_ENV = 'MULTITASKER_GITHUB_TOKEN';
const GOOGLE_CALENDAR_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_GITHUB_REVIEW_POLL_MINUTES = 5;
const SERVER_ENV_FILE_NAMES = ['.env', '.env.local'];
const SLACK_PRIORITY_MENTION = { rank: 0, label: 'mention' };
const SLACK_PRIORITY_DM = { rank: 1, label: 'dm' };
const SLACK_PRIORITY_THREAD_MENTION = { rank: 2, label: 'thread_mention' };
const SLACK_PRIORITY_THREAD_WRITTEN = { rank: 3, label: 'thread_written' };
const SLACK_PRIORITY_OTHER = { rank: 4, label: 'other' };
const storageDirectory = process.env['MULTITASKER_DATA_DIR']?.trim() || process.env['MULTITASKER_STORAGE_DIR']?.trim();
if (storageDirectory)
    (0, settings_1.setStorageDirectory)(storageDirectory);
const sessionManager = new sessionManager_1.SessionManager();
const pendingTerminalUpdates = new Map();
const pendingTerminalEvents = new Map();
const removedSessionIds = new Set();
const vscodeWindowsById = new Map();
const taskIdByTerminalRef = new Map();
const pendingLaunchTaskIdByLaunchId = new Map();
const pendingVsCodeCommandsByWindowId = new Map();
const pendingVsCodeCommandPollsByWindowId = new Map();
const terminalDebugLogFileBySessionId = new Map();
const reportedDebugLogWriteFailures = new Set();
const manualTasks = [];
const recurringTasks = [];
const slackNotifications = [];
const slackUserNameById = new Map();
const slackBotNameById = new Map();
const slackChannelInfoById = new Map();
const slackClientByToken = new Map();
const slackThreadWrittenByAuthedUser = new Map();
const sseClients = new Set();
let slackApiEnv = {};
let slackApiEnvFingerprint = '';
let slackAuthedUserId = '';
let slackAuthedUserConversationIds;
let slackAuthedUserConversationsLoadedAt = 0;
let recurringTaskTimer = null;
let githubReviewTimer = null;
let githubReviewPollInFlight = false;
let server = null;
const seenGitHubReviewRequestKeys = new Set();
refreshSlackApiEnvFromDisk();
sessionManager.on('sessionUpdate', (sessions) => {
    broadcastSseEvent('session:list-update', sessions);
    broadcastSseEvent('state', getBackendState());
});
restorePersistedState();
startRecurringTaskScheduler();
loadSeenGitHubReviewRequests();
startGitHubReviewScheduler();
startServer();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
function startServer() {
    if (server)
        return;
    server = (0, node_http_1.createServer)((request, response) => {
        void handleHttpRequest(request, response);
    });
    server.on('error', error => {
        console.error(`Failed to start Multitasker backend: ${getErrorMessage(error)}`);
        shutdown();
        process.exit(1);
    });
    server.listen(PORT, HOST, () => {
        console.info(`Multitasker backend listening on http://${HOST}:${PORT}`);
    });
}
function shutdown() {
    stopRecurringTaskScheduler();
    stopGitHubReviewScheduler();
    closePendingVsCodeCommandPolls();
    for (const client of [...sseClients])
        client.end();
    sseClients.clear();
    if (server) {
        try {
            server.close();
        }
        catch {
            // The server may fail before it starts listening.
        }
        server = null;
    }
}
async function handleHttpRequest(request, response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
    }
    const requestUrl = new URL(request.url ?? '/', `http://${HOST}`);
    const requestPath = requestUrl.pathname;
    if (request.method === 'GET' && requestPath === '/api/health') {
        writeJsonResponse(response, 200, { ok: true });
        return;
    }
    if (request.method === 'GET' && requestPath === '/api/events') {
        handleSseClient(response);
        return;
    }
    if (request.method === 'GET' && requestPath === '/api/state') {
        writeJsonResponse(response, 200, { ok: true, state: getBackendState() });
        return;
    }
    if (request.method === 'GET' && requestPath === '/api/settings') {
        writeJsonResponse(response, 200, { ok: true, settings: (0, settings_1.loadSettings)() });
        return;
    }
    if (request.method === 'GET' && requestPath === '/api/google-calendar/oauth-config') {
        handleGoogleCalendarOAuthConfigGet(response);
        return;
    }
    if (request.method === 'GET' && requestPath === '/api/sessions') {
        sessionManager.refreshGitChanges();
        writeJsonResponse(response, 200, { ok: true, sessions: sessionManager.getSessions() });
        return;
    }
    if (request.method === 'GET' && requestPath === '/api/manual-tasks') {
        writeJsonResponse(response, 200, { ok: true, manualTasks: manualTasks.map(cloneManualTask) });
        return;
    }
    if (request.method === 'GET' && requestPath === '/api/recurring-tasks') {
        writeJsonResponse(response, 200, { ok: true, recurringTasks: recurringTasks.map(cloneRecurringTask) });
        return;
    }
    if (request.method === 'GET' && requestPath === '/api/slack/notifications') {
        writeJsonResponse(response, 200, { ok: true, slackNotifications: slackNotifications.map(cloneSlackNotification) });
        return;
    }
    if (request.method === 'GET' && isVsCodeCommandPath(requestPath)) {
        handleVsCodeCommandPoll(requestUrl, response);
        return;
    }
    const postPaths = new Set([
        TERMINAL_UPDATE_PATH,
        TERMINAL_EVENT_PATH,
        VSCODE_WINDOW_PATH,
        SLACK_EVENT_PATH,
        SLACK_NOTIFICATION_PATH,
        SLACK_NOTIFICATION_DISMISS_PATH,
        EXTENSION_VSCODE_TERMINAL_UPDATE_PATH,
        EXTENSION_VSCODE_TERMINAL_EVENT_PATH,
        EXTENSION_VSCODE_WINDOW_PATH,
        EXTENSION_VSCODE_TASKS_PATH,
        EXTENSION_SLACK_EVENT_PATH,
        EXTENSION_SLACK_NOTIFICATION_PATH,
        EXTENSION_SLACK_NOTIFICATION_DISMISS_PATH,
        '/api/settings',
        '/api/google-calendar/token',
        '/api/session/create',
        '/api/session/remove',
        '/api/session/rename',
        '/api/session/touch',
        '/api/tasks',
        '/api/task/add',
        '/api/manual-task/add',
        '/api/manual-task/remove',
        '/api/recurring-task/add',
        '/api/recurring-task/remove',
        '/api/slack/clear',
        '/api/slack/remove',
        '/api/vscode/register-launch',
        '/api/vscode/queue-command',
        '/api/deeplink',
    ]);
    if (request.method !== 'POST' || !postPaths.has(requestPath)) {
        writeJsonResponse(response, 404, { ok: false, error: 'not_found' });
        return;
    }
    let parsedPayload;
    try {
        const rawBody = await readHttpBody(request);
        parsedPayload = rawBody ? JSON.parse(rawBody) : {};
    }
    catch (error) {
        const statusCode = error instanceof HttpBodyTooLargeError ? 413 : 400;
        writeJsonResponse(response, statusCode, { ok: false, error: getErrorMessage(error) });
        return;
    }
    await handlePostRequest(requestPath, parsedPayload, response);
}
async function handlePostRequest(requestPath, payload, response) {
    switch (requestPath) {
        case TERMINAL_UPDATE_PATH:
        case EXTENSION_VSCODE_TERMINAL_UPDATE_PATH:
            handleTerminalUpdatePost(payload, response);
            return;
        case TERMINAL_EVENT_PATH:
        case EXTENSION_VSCODE_TERMINAL_EVENT_PATH:
            handleTerminalEventPost(payload, response);
            return;
        case VSCODE_WINDOW_PATH:
        case EXTENSION_VSCODE_WINDOW_PATH:
            handleVsCodeWindowPost(payload, response);
            return;
        case SLACK_EVENT_PATH:
        case EXTENSION_SLACK_EVENT_PATH:
            await handleSlackEventPost(payload, response);
            return;
        case SLACK_NOTIFICATION_PATH:
        case EXTENSION_SLACK_NOTIFICATION_PATH:
            handleSlackNotificationPost(payload, response);
            return;
        case SLACK_NOTIFICATION_DISMISS_PATH:
        case EXTENSION_SLACK_NOTIFICATION_DISMISS_PATH:
            handleSlackNotificationDismissPost(payload, response);
            return;
        case '/api/settings':
            handleSettingsPost(payload, response);
            return;
        case '/api/google-calendar/token':
            await handleGoogleCalendarTokenPost(payload, response);
            return;
        case '/api/session/create':
            handleSessionCreatePost(payload, response);
            return;
        case '/api/session/remove':
            handleSessionRemovePost(payload, response);
            return;
        case '/api/session/rename':
            handleSessionRenamePost(payload, response);
            return;
        case '/api/session/touch':
            handleSessionTouchPost(payload, response);
            return;
        case '/api/tasks':
        case '/api/task/add':
        case '/api/manual-task/add':
        case EXTENSION_VSCODE_TASKS_PATH:
            handleManualTaskAddPost(payload, response);
            return;
        case '/api/manual-task/remove':
            handleManualTaskRemovePost(payload, response);
            return;
        case '/api/recurring-task/add':
            handleRecurringTaskAddPost(payload, response);
            return;
        case '/api/recurring-task/remove':
            handleRecurringTaskRemovePost(payload, response);
            return;
        case '/api/slack/clear':
            handleSlackClearPost(response);
            return;
        case '/api/slack/remove':
            handleSlackRemovePost(payload, response);
            return;
        case '/api/vscode/register-launch':
            handleVsCodeRegisterLaunchPost(payload, response);
            return;
        case '/api/vscode/queue-command':
            handleVsCodeQueueCommandPost(payload, response);
            return;
        case '/api/deeplink':
            handleDeepLinkPost(payload, response);
            return;
        default:
            writeJsonResponse(response, 404, { ok: false, error: 'not_found' });
    }
}
function handleTerminalUpdatePost(payload, response) {
    const update = parseTerminalUpdateRequest(payload);
    if (!update) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_update' });
        return;
    }
    if (shouldBackendOwnState()) {
        handleTerminalUpdate(update);
    }
    else {
        broadcastSseEvent('terminal:update', update);
    }
    writeJsonResponse(response, 200, { ok: true });
}
function handleTerminalEventPost(payload, response) {
    if (shouldBackendOwnState()) {
        const event = parseTerminalEventRequest(payload);
        if (!event) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_event' });
            return;
        }
        handleTerminalEvent(event);
        writeJsonResponse(response, 200, { ok: true });
        return;
    }
    if (!isTerminalEventRelayPayload(payload)) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_terminal_event' });
        return;
    }
    broadcastSseEvent('terminal:event', payload);
    writeJsonResponse(response, 200, { ok: true });
}
function handleVsCodeWindowPost(payload, response) {
    const registration = parseVsCodeWindowRegistration(payload);
    if (!registration) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_vscode_window' });
        return;
    }
    rememberVsCodeWindow(registration);
    writeJsonResponse(response, 200, { ok: true });
}
async function handleSlackEventPost(payload, response) {
    try {
        await handleSlackEventEnvelope(payload);
        writeJsonResponse(response, 200, { ok: true });
    }
    catch (error) {
        const message = getErrorMessage(error);
        debugSlackLog('Slack event handling failed', { error: message });
        writeJsonResponse(response, 500, { ok: false, error: message });
    }
}
function handleSlackNotificationPost(payload, response) {
    const notification = parseSlackNotificationRequest(payload);
    if (!notification) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_slack_notification' });
        return;
    }
    handleSlackNotification(notification);
    writeJsonResponse(response, 200, { ok: true });
}
function handleSlackNotificationDismissPost(payload, response) {
    const dismissRequest = parseSlackNotificationDismissRequest(payload);
    if (!dismissRequest) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_slack_notification_dismiss' });
        return;
    }
    const removed = handleSlackNotificationDismiss(dismissRequest);
    writeJsonResponse(response, 200, { ok: true, removed });
}
function handleGoogleCalendarOAuthConfigGet(response) {
    const config = getGoogleCalendarOAuthConfig();
    writeJsonResponse(response, 200, {
        ok: true,
        configured: Boolean(config.clientId),
        clientId: config.clientId,
        hasClientSecret: Boolean(config.clientSecret),
    });
}
async function handleGoogleCalendarTokenPost(payload, response) {
    const tokenRequest = parseGoogleCalendarTokenRequest(payload);
    if (!tokenRequest) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_google_calendar_token_request' });
        return;
    }
    const config = getGoogleCalendarOAuthConfig();
    if (!config.clientId) {
        writeJsonResponse(response, 400, { ok: false, error: `${GOOGLE_CALENDAR_CLIENT_ID_ENV} is required` });
        return;
    }
    const body = new URLSearchParams(tokenRequest);
    body.set('client_id', config.clientId);
    if (config.clientSecret)
        body.set('client_secret', config.clientSecret);
    try {
        const tokenResponse = await fetch(GOOGLE_CALENDAR_TOKEN_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
        const rawBody = await tokenResponse.text();
        const payloadBody = parseJsonResponseBody(rawBody);
        if (!tokenResponse.ok) {
            writeJsonResponse(response, tokenResponse.status, {
                ok: false,
                error: getGoogleApiErrorMessage(payloadBody, rawBody),
            });
            return;
        }
        writeJsonResponse(response, 200, { ok: true, token: payloadBody });
    }
    catch (error) {
        writeJsonResponse(response, 502, { ok: false, error: getErrorMessage(error) });
    }
}
function parseGoogleCalendarTokenRequest(payload) {
    if (!isRecord(payload))
        return null;
    const grantType = readStringField(payload, 'grant_type').trim();
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token')
        return null;
    const tokenRequest = { grant_type: grantType };
    for (const key of ['code', 'redirect_uri', 'code_verifier', 'refresh_token']) {
        const value = readStringField(payload, key).trim();
        if (value)
            tokenRequest[key] = value;
    }
    if (grantType === 'authorization_code') {
        return tokenRequest['code'] && tokenRequest['redirect_uri'] && tokenRequest['code_verifier']
            ? tokenRequest
            : null;
    }
    return tokenRequest['refresh_token'] ? tokenRequest : null;
}
function parseJsonResponseBody(rawBody) {
    if (!rawBody.trim())
        return {};
    try {
        return JSON.parse(rawBody);
    }
    catch {
        return rawBody;
    }
}
function getGoogleApiErrorMessage(payload, rawBody) {
    if (isRecord(payload)) {
        const error = payload['error'];
        if (typeof error === 'string' && error.trim())
            return error.trim();
        if (isRecord(error)) {
            const message = readStringField(error, 'message').trim();
            if (message)
                return message;
        }
        const errorDescription = readStringField(payload, 'error_description').trim();
        if (errorDescription)
            return errorDescription;
    }
    return rawBody.trim() || 'Unknown Google API error';
}
function handleSettingsPost(payload, response) {
    if (typeof payload !== 'object' || payload === null) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_settings' });
        return;
    }
    const settings = payload;
    const currentSettings = (0, settings_1.loadSettings)();
    (0, settings_1.saveSettings)({
        reviewTool: typeof settings.reviewTool === 'string' ? settings.reviewTool : currentSettings.reviewTool,
        defaultShell: isLocalShellType(settings.defaultShell) ? settings.defaultShell : currentSettings.defaultShell,
        googleCalendar: typeof settings.googleCalendar === 'object' && settings.googleCalendar !== null
            ? settings.googleCalendar
            : currentSettings.googleCalendar,
        githubReview: typeof settings.githubReview === 'object' && settings.githubReview !== null
            ? settings.githubReview
            : currentSettings.githubReview,
    });
    startGitHubReviewScheduler();
    writeJsonResponse(response, 200, { ok: true, settings: (0, settings_1.loadSettings)() });
}
function handleSessionCreatePost(payload, response) {
    const session = createSessionFromPayload(payload);
    if (!session) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_session' });
        return;
    }
    writeJsonResponse(response, 200, { ok: true, session });
}
function handleSessionRemovePost(payload, response) {
    const id = readPayloadString(payload, 'id').trim();
    if (!id) {
        writeJsonResponse(response, 400, { ok: false, error: 'missing_session_id' });
        return;
    }
    removeSessionById(id);
    writeJsonResponse(response, 200, { ok: true });
}
function handleSessionRenamePost(payload, response) {
    const id = readPayloadString(payload, 'id').trim();
    const name = readPayloadString(payload, 'name').trim();
    if (!id || !name) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_session_rename' });
        return;
    }
    const session = sessionManager.renameSession(id, name);
    if (!session) {
        writeJsonResponse(response, 404, { ok: false, error: 'session_not_found' });
        return;
    }
    (0, settings_1.saveSessions)(getSessionsStateToSave());
    writeJsonResponse(response, 200, { ok: true, session });
}
function handleSessionTouchPost(payload, response) {
    const id = readPayloadString(payload, 'id').trim();
    if (!id) {
        writeJsonResponse(response, 400, { ok: false, error: 'missing_session_id' });
        return;
    }
    const session = sessionManager.touchSession(id);
    writeJsonResponse(response, 200, { ok: true, session });
}
function handleManualTaskAddPost(payload, response) {
    const task = parseManualTaskAddRequest(payload);
    if (!task) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_manual_task' });
        return;
    }
    if (shouldBackendOwnState()) {
        writeJsonResponse(response, 200, { ok: true, task: storeManualTask(task) });
        return;
    }
    broadcastSseEvent('manual-task:add', cloneManualTask(task));
    writeJsonResponse(response, 200, { ok: true, task: cloneManualTask(task) });
}
function handleManualTaskRemovePost(payload, response) {
    const id = readPayloadString(payload, 'id').trim();
    if (!id) {
        writeJsonResponse(response, 400, { ok: false, error: 'missing_task_id' });
        return;
    }
    writeJsonResponse(response, 200, { ok: true, removed: removeManualTask(id) });
}
function handleRecurringTaskAddPost(payload, response) {
    const task = createRecurringTask(readPayloadValue(payload, 'text'), readPayloadValue(payload, 'time'), readPayloadValue(payload, 'schedule') ?? readPayloadValue(payload, 'recurrence') ?? readPayloadValue(payload, 'daysOfWeek'));
    if (!task) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_recurring_task' });
        return;
    }
    writeJsonResponse(response, 200, { ok: true, task });
}
function handleRecurringTaskRemovePost(payload, response) {
    const id = readPayloadString(payload, 'id').trim();
    if (!id) {
        writeJsonResponse(response, 400, { ok: false, error: 'missing_task_id' });
        return;
    }
    writeJsonResponse(response, 200, { ok: true, removed: removeRecurringTask(id) });
}
function handleSlackClearPost(response) {
    slackNotifications.length = 0;
    (0, settings_1.saveSlackNotifications)(slackNotifications);
    broadcastSlackListUpdate();
    writeJsonResponse(response, 200, { ok: true });
}
function handleSlackRemovePost(payload, response) {
    const id = readPayloadString(payload, 'id').trim();
    if (!id) {
        writeJsonResponse(response, 400, { ok: false, error: 'missing_slack_notification_id' });
        return;
    }
    writeJsonResponse(response, 200, { ok: true, removed: removeSlackNotification(id) });
}
function handleVsCodeRegisterLaunchPost(payload, response) {
    const launchId = readPayloadString(payload, 'launchId').trim();
    const sessionId = readPayloadString(payload, 'sessionId').trim();
    if (!launchId || !sessionId) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_launch_registration' });
        return;
    }
    pendingLaunchTaskIdByLaunchId.set(launchId, sessionId);
    writeJsonResponse(response, 200, { ok: true });
}
function handleVsCodeQueueCommandPost(payload, response) {
    const windowId = readPayloadString(payload, 'windowId').trim();
    const terminalRef = readPayloadString(payload, 'terminalRef').trim();
    const commandType = readPayloadString(payload, 'type').trim();
    if (!windowId || !terminalRef || (commandType !== 'focus-terminal' && commandType !== 'disconnect-session')) {
        writeJsonResponse(response, 400, { ok: false, error: 'invalid_vscode_command' });
        return;
    }
    enqueueVsCodeCommand(windowId, { id: (0, node_crypto_1.randomUUID)(), type: commandType, terminalRef });
    writeJsonResponse(response, 200, { ok: true });
}
function handleDeepLinkPost(payload, response) {
    const url = readPayloadString(payload, 'url').trim();
    if (!url) {
        writeJsonResponse(response, 400, { ok: false, error: 'missing_url' });
        return;
    }
    const result = processDeepLink(url);
    if (!result.ok) {
        writeJsonResponse(response, 400, result);
        return;
    }
    writeJsonResponse(response, 200, result);
}
function createSessionFromPayload(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const record = payload;
    const settings = (0, settings_1.loadSettings)();
    const name = readStringField(record, 'name').trim();
    const cmd = readStringField(record, 'cmd').trim() || readStringField(record, 'command').trim();
    const cwd = readStringField(record, 'cwd').trim();
    const rawShellType = readStringField(record, 'shellType').trim();
    const shellType = isShellType(rawShellType) ? rawShellType : settings.defaultShell;
    const sshCommand = readStringField(record, 'sshCommand').trim();
    if (!name)
        return null;
    if (shellType === 'ssh') {
        if (!sshCommand)
            return null;
    }
    else if (!cwd) {
        return null;
    }
    const session = sessionManager.createSession(name, cmd, cwd, shellType, '', sshCommand);
    forgetRemovedSession(session.id);
    (0, settings_1.saveSessions)(getSessionsStateToSave());
    flushPendingTerminalUpdates(session.id);
    flushPendingTerminalEvents(session.id);
    return session;
}
function removeSessionById(id) {
    const session = sessionManager.getSession(id);
    if (session?.status === 'detached' || session?.status === 'stopped' || session?.status === 'error') {
        markSessionRemoved(id);
        sessionManager.removeSession(id);
    }
    else {
        if (session)
            queueDisconnectSessionCommand(session);
        sessionManager.detachSession(id);
    }
    (0, settings_1.saveSessions)(getSessionsStateToSave());
}
function processDeepLink(url) {
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    }
    catch (error) {
        return { ok: false, error: `invalid URL: ${getErrorMessage(error)}` };
    }
    if (parsedUrl.protocol !== 'multitasker:')
        return { ok: true, action: 'none' };
    const createPath = isDeepLinkPath(parsedUrl, '/create', 'create');
    const terminalPath = isDeepLinkPath(parsedUrl, '/terminal', 'terminal');
    if (!createPath && !terminalPath)
        return { ok: false, error: `unsupported path "${parsedUrl.pathname}"` };
    const payloadParam = parsedUrl.searchParams.get('payload');
    if (!payloadParam)
        return { ok: false, error: 'missing payload' };
    let parsedPayload;
    try {
        parsedPayload = parseDeepLinkPayload(payloadParam);
    }
    catch (error) {
        return { ok: false, error: `invalid payload JSON: ${getErrorMessage(error)}` };
    }
    if (terminalPath) {
        const event = parseTerminalEventRequest(parsedPayload);
        if (event) {
            handleTerminalEvent(event);
            return { ok: true, action: 'none' };
        }
        const update = parseTerminalUpdateRequest(parsedPayload);
        if (!update)
            return { ok: false, error: 'invalid terminal payload' };
        handleTerminalUpdate(update);
        return { ok: true, action: 'none' };
    }
    const request = parseCreateSessionRequest(parsedPayload);
    if (!request)
        return { ok: false, error: 'invalid session payload' };
    if (request.id)
        forgetRemovedSession(request.id);
    if (request.vscodeWindowId)
        rememberVsCodeWindow({ windowId: request.vscodeWindowId });
    const session = sessionManager.createSession(request.name, request.cmd, request.cwd, request.shellType, request.id ?? '', request.sshCommand ?? '', request.vscodeWindowId ?? '', request.terminalRef ?? '', request.terminalPid);
    rememberTaskTerminalBinding(session.id, {
        vscodeWindowId: request.vscodeWindowId,
        terminalRef: request.terminalRef,
        terminalPid: request.terminalPid,
    });
    if (request.launchId)
        pendingLaunchTaskIdByLaunchId.set(request.launchId, session.id);
    (0, settings_1.saveSessions)(getSessionsStateToSave());
    flushPendingTerminalUpdates(session.id);
    flushPendingTerminalEvents(session.id);
    return request.terminalRef ? { ok: true, action: 'none', session } : { ok: true, action: 'open-vscode', session };
}
function parseDeepLinkPayload(rawPayload) {
    let current = rawPayload;
    for (let i = 0; i < 3; i += 1) {
        try {
            return JSON.parse(current);
        }
        catch {
            let decoded;
            try {
                decoded = decodeURIComponent(current);
            }
            catch {
                break;
            }
            if (decoded === current)
                break;
            current = decoded;
        }
    }
    throw new Error('Invalid payload JSON');
}
function isDeepLinkPath(parsedUrl, pathName, hostName) {
    return (parsedUrl.pathname === pathName ||
        (parsedUrl.hostname === hostName && (parsedUrl.pathname === '' || parsedUrl.pathname === '/')));
}
function restorePersistedState() {
    const settings = (0, settings_1.loadSettings)();
    for (const sessionState of (0, settings_1.loadSessions)()) {
        const shellType = isShellType(String(sessionState.shellType)) ? sessionState.shellType : settings.defaultShell;
        sessionManager.createSession(sessionState.name, sessionState.cmd, sessionState.cwd, shellType, sessionState.id ?? '', sessionState.sshCommand ?? '', sessionState.vscodeWindowId ?? '', sessionState.terminalRef ?? '', sessionState.terminalPid);
    }
    for (const session of sessionManager.getSessions()) {
        if (session.terminalRef)
            taskIdByTerminalRef.set(session.terminalRef, session.id);
    }
    manualTasks.push(...(0, settings_1.loadManualTasks)().slice(0, MAX_MANUAL_TASKS));
    recurringTasks.push(...(0, settings_1.loadRecurringTasks)().slice(0, MAX_RECURRING_TASKS));
    slackNotifications.push(...(0, settings_1.loadSlackNotifications)().slice(0, MAX_SLACK_NOTIFICATIONS));
    flushPendingTerminalUpdates();
    flushPendingTerminalEvents();
}
function getBackendState() {
    return {
        sessions: sessionManager.getSessions(),
        manualTasks: manualTasks.map(cloneManualTask),
        recurringTasks: recurringTasks.map(cloneRecurringTask),
        slackNotifications: slackNotifications.map(cloneSlackNotification),
        vscodeWindows: [...vscodeWindowsById.values()].map(cloneVsCodeWindowEntry),
    };
}
function handleSseClient(response) {
    response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
    });
    response.write(': connected\n\n');
    sseClients.add(response);
    writeSseEvent(response, 'state', getBackendState());
    response.on('close', () => {
        sseClients.delete(response);
    });
}
function broadcastSseEvent(event, payload) {
    for (const client of [...sseClients]) {
        if (client.writableEnded) {
            sseClients.delete(client);
            continue;
        }
        writeSseEvent(client, event, payload);
    }
}
function writeSseEvent(response, event, payload) {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
}
function broadcastManualTasks() {
    broadcastSseEvent('manual-task:list-update', manualTasks.map(cloneManualTask));
    broadcastSseEvent('state', getBackendState());
}
function broadcastRecurringTasks() {
    broadcastSseEvent('recurring-task:list-update', recurringTasks.map(cloneRecurringTask));
    broadcastSseEvent('state', getBackendState());
}
function broadcastSlackListUpdate() {
    broadcastSseEvent('slack:list-update', slackNotifications.map(cloneSlackNotification));
    broadcastSseEvent('state', getBackendState());
}
function broadcastVsCodeWindowsUpdate() {
    broadcastSseEvent('vscode:windows-update', [...vscodeWindowsById.values()].map(cloneVsCodeWindowEntry));
    broadcastSseEvent('state', getBackendState());
}
function createManualTask(textValue) {
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    if (!text)
        return null;
    return storeManualTask({
        id: `manual-${(0, node_crypto_1.randomUUID)()}`,
        text: truncateTaskText(text),
        createdAt: Date.now(),
    });
}
function parseManualTaskAddRequest(payload) {
    const record = typeof payload === 'object' && payload !== null ? payload : undefined;
    const rawText = typeof payload === 'string'
        ? payload
        : readStringField(record, 'text') || readStringField(record, 'title') || readStringField(record, 'task');
    const text = rawText.trim();
    if (!text)
        return null;
    const id = readStringField(record, 'id').trim() || `manual-${(0, node_crypto_1.randomUUID)()}`;
    const createdAt = record ? readOptionalNumberField(record, 'createdAt') ?? Date.now() : Date.now();
    if (!Number.isFinite(createdAt))
        return null;
    return {
        id,
        text: truncateTaskText(text),
        createdAt,
    };
}
function storeManualTask(task) {
    const existingIndex = manualTasks.findIndex(existing => existing.id === task.id);
    if (existingIndex >= 0)
        manualTasks.splice(existingIndex, 1);
    manualTasks.unshift(cloneManualTask(task));
    while (manualTasks.length > MAX_MANUAL_TASKS)
        manualTasks.pop();
    (0, settings_1.saveManualTasks)(manualTasks);
    broadcastManualTasks();
    return cloneManualTask(task);
}
function removeManualTask(id) {
    const existingIndex = manualTasks.findIndex(task => task.id === id);
    if (existingIndex < 0)
        return false;
    manualTasks.splice(existingIndex, 1);
    (0, settings_1.saveManualTasks)(manualTasks);
    broadcastManualTasks();
    return true;
}
function createRecurringTask(textValue, timeValue, scheduleValue) {
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    const time = typeof timeValue === 'string' ? timeValue.trim() : '';
    const schedule = parseRecurringSchedule(scheduleValue);
    if (!text || parseRecurringTimeMinutes(time) === null || !schedule)
        return null;
    const now = new Date();
    const task = {
        id: `recurring-${(0, node_crypto_1.randomUUID)()}`,
        text: truncateTaskText(text),
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
    return cloneRecurringTask(task);
}
function removeRecurringTask(id) {
    const existingIndex = recurringTasks.findIndex(task => task.id === id);
    if (existingIndex < 0)
        return false;
    recurringTasks.splice(existingIndex, 1);
    (0, settings_1.saveRecurringTasks)(recurringTasks);
    broadcastRecurringTasks();
    return true;
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
function startGitHubReviewScheduler() {
    stopGitHubReviewScheduler();
    void pollGitHubReviewRequests();
    githubReviewTimer = setInterval(() => {
        void pollGitHubReviewRequests();
    }, getGitHubReviewPollIntervalMs());
}
function stopGitHubReviewScheduler() {
    if (!githubReviewTimer)
        return;
    clearInterval(githubReviewTimer);
    githubReviewTimer = null;
}
function getGitHubReviewPollIntervalMs() {
    const settings = (0, settings_1.loadSettings)().githubReview;
    const pollMinutes = Number.isFinite(settings.pollMinutes)
        ? Math.max(1, Math.min(60, Math.floor(settings.pollMinutes)))
        : DEFAULT_GITHUB_REVIEW_POLL_MINUTES;
    return pollMinutes * 60 * 1000;
}
async function pollGitHubReviewRequests() {
    if (githubReviewPollInFlight)
        return;
    const settings = (0, settings_1.loadSettings)().githubReview;
    if (!settings.enabled)
        return;
    if (!settings.owner.trim() || !settings.repo.trim())
        return;
    const token = getServerEnvValue(GITHUB_TOKEN_ENV).trim();
    if (!token)
        return;
    githubReviewPollInFlight = true;
    try {
        const viewerLogin = await fetchGitHubViewerLogin(token);
        if (!viewerLogin)
            return;
        const prs = await fetchOpenPullRequests(settings.owner, settings.repo, token);
        const now = Date.now();
        let changed = false;
        for (const pr of prs) {
            if (!isPullRequestRequestedForViewer(pr, viewerLogin))
                continue;
            const requestKey = `${settings.owner}/${settings.repo}#${pr.number}`;
            if (seenGitHubReviewRequestKeys.has(requestKey))
                continue;
            seenGitHubReviewRequestKeys.add(requestKey);
            changed = true;
            publishIntegrationManualTask({
                id: `manual-${(0, node_crypto_1.randomUUID)()}`,
                text: truncateTaskText(`Review PR ${requestKey}: ${pr.title} (${pr.html_url})`),
                createdAt: now,
            });
        }
        if (changed)
            saveSeenGitHubReviewRequests();
    }
    catch (error) {
        console.error(`GitHub review polling failed: ${getErrorMessage(error)}`);
    }
    finally {
        githubReviewPollInFlight = false;
    }
}
function isPullRequestRequestedForViewer(pr, viewerLogin) {
    if (pr.draft)
        return false;
    const requestedReviewers = Array.isArray(pr.requested_reviewers) ? pr.requested_reviewers : [];
    return requestedReviewers.some(reviewer => reviewer?.login?.toLowerCase() === viewerLogin.toLowerCase());
}
async function fetchGitHubViewerLogin(token) {
    const response = await fetch(`${GITHUB_API_BASE_URL}/user`, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'multitasker-local-backend',
        },
    });
    const body = parseJsonResponseBody(await response.text());
    if (!response.ok || !isRecord(body)) {
        throw new Error(`GitHub /user failed (${response.status})`);
    }
    return readStringField(body, 'login').trim();
}
async function fetchOpenPullRequests(owner, repo, token) {
    const url = new URL(`${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`);
    url.searchParams.set('state', 'open');
    url.searchParams.set('sort', 'updated');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('per_page', '50');
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'multitasker-local-backend',
        },
    });
    const body = parseJsonResponseBody(await response.text());
    if (!response.ok || !Array.isArray(body)) {
        throw new Error(`GitHub pulls listing failed (${response.status})`);
    }
    return body.filter(isGitHubPullRequest);
}
function isGitHubPullRequest(value) {
    if (!isRecord(value))
        return false;
    if (!Number.isInteger(value['number']))
        return false;
    if (typeof value['title'] !== 'string' || !value['title'].trim())
        return false;
    if (typeof value['html_url'] !== 'string' || !value['html_url'].trim())
        return false;
    if (value['requested_reviewers'] !== undefined && !Array.isArray(value['requested_reviewers']))
        return false;
    if (value['draft'] !== undefined && typeof value['draft'] !== 'boolean')
        return false;
    return true;
}
function publishIntegrationManualTask(task) {
    if (shouldBackendOwnState()) {
        storeManualTask(task);
        return;
    }
    broadcastSseEvent('manual-task:add', cloneManualTask(task));
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
function getInitialRecurringTaskGeneratedDate(task, now) {
    if (!isRecurringTaskDue(task, now))
        return '';
    return getLocalDateKey(now);
}
function normalizeRecurringDays(value) {
    if (!Array.isArray(value))
        return [];
    const days = value
        .filter((day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
    return [...new Set(days)].sort((a, b) => a - b);
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
    if (frequency === 'daily')
        return { frequency, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
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
function normalizeRecurringIntervalDays(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3650 ? value : null;
}
function normalizeRecurringDayOfMonth(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31 ? value : null;
}
function parseRecurringTimeMinutes(time) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
    if (!match)
        return null;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    return hours * 60 + minutes;
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
function truncateTaskText(text) {
    if (text.length <= MAX_MANUAL_TASK_TEXT_LENGTH)
        return text;
    return `${text.slice(0, MAX_MANUAL_TASK_TEXT_LENGTH - 1)}…`;
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
    broadcastSseEvent('slack:notification', cloneSlackNotification(nextNotification));
    broadcastSlackListUpdate();
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
        text: truncateSlackText(`${formatSlackNotificationMessageLine(existing)}\n${formatSlackNotificationMessageLine(incoming)}`),
        receivedAt: Math.max(existing.receivedAt, incoming.receivedAt),
        messageCount,
    };
    addOptionalSlackString(merged, 'teamId', existing.teamId || incoming.teamId || '');
    addOptionalSlackString(merged, 'teamName', existing.teamName || incoming.teamName || '');
    addOptionalSlackString(merged, 'channelId', existing.channelId || incoming.channelId || '');
    addOptionalSlackString(merged, 'channelName', existing.channelName || incoming.channelName || '');
    addOptionalSlackString(merged, 'channelType', existing.channelType || incoming.channelType || '');
    addOptionalSlackString(merged, 'userId', incoming.userId || existing.userId || '');
    addOptionalSlackString(merged, 'userName', incoming.userName || existing.userName || '');
    addOptionalSlackString(merged, 'ts', incoming.ts || existing.ts || '');
    addOptionalSlackString(merged, 'threadTs', existing.threadTs || incoming.threadTs || '');
    addOptionalSlackString(merged, 'permalink', incoming.permalink || existing.permalink || '');
    const rank = Math.min(existing.priorityRank ?? 4, incoming.priorityRank ?? 4);
    merged.priorityRank = rank;
    merged.priorityLabel = getSlackPriorityLabelForRank(rank);
    return merged;
}
function formatSlackNotificationMessageLine(notification) {
    const sender = notification.userName?.trim();
    const text = notification.text.trim() || '(no text)';
    return sender ? `${sender}: ${text}` : text;
}
function handleSlackNotificationDismiss(request) {
    if (!isSlackDirectMessageChannel(request.channelId, request.channelType))
        return 0;
    broadcastSseEvent('slack:dismiss', { ...request });
    const existingIndex = findSlackNotificationDismissIndex(request);
    if (existingIndex < 0)
        return 0;
    slackNotifications.splice(existingIndex, 1);
    (0, settings_1.saveSlackNotifications)(slackNotifications);
    broadcastSlackListUpdate();
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
function removeSlackNotification(id) {
    const existingIndex = slackNotifications.findIndex(existing => existing.id === id);
    if (existingIndex < 0)
        return false;
    slackNotifications.splice(existingIndex, 1);
    (0, settings_1.saveSlackNotifications)(slackNotifications);
    broadcastSlackListUpdate();
    return true;
}
async function handleSlackEventEnvelope(envelope) {
    refreshSlackApiEnvFromDisk();
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
        if (typeof nestedValue === 'object' && nestedValue !== null) {
            return slackStructuredValueMentionsUser(nestedValue, userId, mentionToken);
        }
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
function refreshSlackApiEnvFromDisk() {
    const nextEnv = readSlackEnvFromDisk();
    const fingerprint = JSON.stringify(nextEnv);
    if (fingerprint === slackApiEnvFingerprint)
        return;
    slackApiEnvFingerprint = fingerprint;
    resetSlackApiState(nextEnv);
}
function readSlackEnvFromDisk() {
    const candidates = [
        node_path_1.default.join(process.cwd(), SLACK_ENV_RELATIVE_PATH),
        node_path_1.default.join(__dirname, '..', SLACK_ENV_RELATIVE_PATH),
    ];
    const envPath = candidates.find(candidate => node_fs_1.default.existsSync(candidate));
    return envPath ? readEnvFile(envPath) : {};
}
function loadSeenGitHubReviewRequests() {
    seenGitHubReviewRequestKeys.clear();
    try {
        const raw = node_fs_1.default.readFileSync(getGitHubReviewSeenPath(), 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return;
        for (const value of parsed) {
            if (typeof value === 'string' && value.trim())
                seenGitHubReviewRequestKeys.add(value.trim());
        }
    }
    catch {
        // No previous file yet.
    }
}
function saveSeenGitHubReviewRequests() {
    const filePath = getGitHubReviewSeenPath();
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true });
    node_fs_1.default.writeFileSync(filePath, JSON.stringify([...seenGitHubReviewRequestKeys], null, 2));
}
function getGitHubReviewSeenPath() {
    const baseDirectory = storageDirectory || node_path_1.default.join(process.cwd(), '.multitasker-data');
    return node_path_1.default.join(baseDirectory, 'github-review-seen.json');
}
function getGoogleCalendarOAuthConfig() {
    return {
        clientId: getServerEnvValue(GOOGLE_CALENDAR_CLIENT_ID_ENV),
        clientSecret: getServerEnvValue(GOOGLE_CALENDAR_CLIENT_SECRET_ENV),
    };
}
function getServerEnvValue(key) {
    const processValue = process.env[key];
    if (typeof processValue === 'string' && processValue.trim())
        return processValue.trim();
    const fileValue = readServerEnvFromDisk()[key];
    return typeof fileValue === 'string' ? fileValue.trim() : '';
}
function readServerEnvFromDisk() {
    const env = {};
    for (const fileName of SERVER_ENV_FILE_NAMES) {
        const candidates = [
            node_path_1.default.join(process.cwd(), fileName),
            node_path_1.default.join(__dirname, '..', fileName),
        ];
        const envPath = candidates.find(candidate => node_fs_1.default.existsSync(candidate));
        if (envPath)
            Object.assign(env, readEnvFile(envPath));
    }
    return env;
}
function readEnvFile(envPath) {
    return parseEnvContent(node_fs_1.default.readFileSync(envPath, 'utf8'));
}
function parseEnvContent(content) {
    const env = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine.startsWith('#'))
            continue;
        const equalsIndex = trimmedLine.indexOf('=');
        if (equalsIndex <= 0)
            continue;
        const key = trimmedLine.slice(0, equalsIndex).trim();
        const value = unquoteEnvValue(trimmedLine.slice(equalsIndex + 1).trim());
        if (key)
            env[key] = value;
    }
    return env;
}
function unquoteEnvValue(value) {
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
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
    appendSlackDebugLog(message, details);
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
function getSlackDebugTextPreview(text) {
    const preview = text.replace(/\s+/g, ' ').trim();
    if (preview.length <= MAX_SLACK_DEBUG_TEXT_LENGTH)
        return preview;
    return `${preview.slice(0, MAX_SLACK_DEBUG_TEXT_LENGTH - 1)}…`;
}
function parseSlackNotificationRequest(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const record = payload;
    const id = readStringField(record, 'id').trim();
    const receivedAt = readOptionalNumberField(record, 'receivedAt') ?? Date.now();
    if (!id || !Number.isFinite(receivedAt))
        return null;
    const notification = {
        id,
        text: truncateSlackText(readStringField(record, 'text').trim() || '(no text)'),
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
function normalizeSlackPriorityRank(value) {
    if (!Number.isFinite(value))
        return 4;
    return Math.max(0, Math.min(4, Math.floor(value)));
}
function isSlackNotificationPriorityLabel(value) {
    return value === 'mention' ||
        value === 'dm' ||
        value === 'thread_mention' ||
        value === 'thread_written' ||
        value === 'other';
}
function isSlackDirectMessageChannel(channelId, channelType) {
    return channelType === 'im' || channelType === 'mpim' || channelId.startsWith('D');
}
function parseSlackTimestamp(value) {
    if (!value)
        return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function parseVsCodeWindowRegistration(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const record = payload;
    const windowId = readStringField(record, 'windowId').trim();
    if (!windowId)
        return null;
    const registration = { windowId };
    const workspaceFolder = readStringField(record, 'workspaceFolder').trim();
    if (workspaceFolder)
        registration.workspaceFolder = workspaceFolder;
    const workspaceName = readStringField(record, 'workspaceName').trim();
    if (workspaceName)
        registration.workspaceName = workspaceName;
    const pid = readOptionalNumberField(record, 'pid');
    if (pid !== undefined)
        registration.pid = pid;
    if (Array.isArray(record['terminals'])) {
        registration.terminals = record['terminals']
            .map(parseVsCodeTerminalRegistration)
            .filter((terminal) => terminal !== null);
    }
    if (Array.isArray(record['sessionIds']))
        registration.sessionIds = readStringArrayField(record, 'sessionIds');
    return registration;
}
function parseVsCodeTerminalRegistration(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const record = payload;
    const terminalRef = readStringField(record, 'terminalRef').trim();
    if (!terminalRef)
        return null;
    const terminal = { terminalRef };
    const terminalName = readStringField(record, 'terminalName').trim();
    if (terminalName)
        terminal.terminalName = terminalName;
    const terminalCwd = readStringField(record, 'terminalCwd').trim();
    if (terminalCwd)
        terminal.terminalCwd = terminalCwd;
    const rawShellType = readStringField(record, 'shellType').trim();
    if (isShellType(rawShellType))
        terminal.shellType = rawShellType;
    const terminalPid = readOptionalNumberField(record, 'terminalPid');
    if (terminalPid !== undefined)
        terminal.terminalPid = terminalPid;
    const isActive = readOptionalBooleanField(record, 'isActive');
    if (isActive !== undefined)
        terminal.isActive = isActive;
    const rawCaptureState = readStringField(record, 'captureState').trim();
    if (isTerminalCaptureState(rawCaptureState))
        terminal.captureState = rawCaptureState;
    const captureReason = readStringField(record, 'captureReason').trim();
    if (captureReason)
        terminal.captureReason = captureReason;
    return terminal;
}
function rememberVsCodeWindow(registration) {
    const existingEntry = vscodeWindowsById.get(registration.windowId);
    const entry = {
        windowId: registration.windowId,
        lastSeenAt: Date.now(),
    };
    const workspaceFolder = registration.workspaceFolder ?? existingEntry?.workspaceFolder;
    if (workspaceFolder)
        entry.workspaceFolder = workspaceFolder;
    const workspaceName = registration.workspaceName ?? existingEntry?.workspaceName;
    if (workspaceName)
        entry.workspaceName = workspaceName;
    const pid = registration.pid ?? existingEntry?.pid;
    if (pid !== undefined)
        entry.pid = pid;
    if (registration.terminals !== undefined) {
        entry.terminals = registration.terminals;
    }
    else if (existingEntry?.terminals !== undefined) {
        entry.terminals = existingEntry.terminals;
    }
    if (registration.sessionIds !== undefined) {
        entry.sessionIds = registration.sessionIds;
    }
    else if (existingEntry?.sessionIds !== undefined) {
        entry.sessionIds = existingEntry.sessionIds;
    }
    vscodeWindowsById.set(registration.windowId, entry);
    bindSessionsToVsCodeTerminals(entry);
    bindSessionsToVsCodeWindow(registration);
    broadcastVsCodeWindowsUpdate();
}
function bindSessionsToVsCodeTerminals(registration) {
    const terminals = registration.terminals ?? [];
    if (terminals.length === 0)
        return;
    let didBindSession = false;
    const boundSessionIds = new Set();
    const bindTerminal = (session, terminal, matchReason) => {
        if (boundSessionIds.has(session.id))
            return;
        const previousTerminalRef = session.terminalRef;
        const reboundSession = sessionManager.bindSessionToTerminal(session.id, buildTerminalBinding({
            vscodeWindowId: registration.windowId,
            terminalRef: terminal.terminalRef,
            terminalPid: terminal.terminalPid,
            terminalCaptureState: terminal.captureState,
            terminalCaptureReason: terminal.captureReason,
        }));
        if (!reboundSession)
            return;
        if (previousTerminalRef && previousTerminalRef !== terminal.terminalRef)
            taskIdByTerminalRef.delete(previousTerminalRef);
        taskIdByTerminalRef.set(terminal.terminalRef, reboundSession.id);
        boundSessionIds.add(reboundSession.id);
        if (previousTerminalRef !== terminal.terminalRef || session.status === 'detached') {
            didBindSession = true;
            debugTerminalUpdate('session rebound to vscode terminal', {
                id: reboundSession.id,
                sessionName: reboundSession.name,
                vscodeWindowId: registration.windowId,
                terminalRef: terminal.terminalRef,
                terminalPid: terminal.terminalPid,
                terminalName: terminal.terminalName,
                terminalCwd: terminal.terminalCwd,
                matchReason,
            });
        }
    };
    for (const terminal of terminals) {
        const session = findKnownSessionForTerminalRef(terminal.terminalRef);
        if (session)
            bindTerminal(session, terminal, 'known terminalRef');
    }
    for (const terminal of terminals) {
        if (taskIdByTerminalRef.has(terminal.terminalRef))
            continue;
        const match = findSessionForTerminalRegistration(registration, terminal, boundSessionIds);
        if (match)
            bindTerminal(match.session, terminal, match.reason);
    }
    if (didBindSession)
        (0, settings_1.saveSessions)(getSessionsStateToSave());
}
function findKnownSessionForTerminalRef(terminalRef) {
    const mappedTaskId = taskIdByTerminalRef.get(terminalRef);
    if (mappedTaskId)
        return sessionManager.getSession(mappedTaskId);
    return sessionManager.getSessions().find(session => session.terminalRef === terminalRef) ?? null;
}
function findSessionForTerminalRegistration(registration, terminal, excludedSessionIds) {
    const sessions = sessionManager.getSessions().filter(session => !excludedSessionIds.has(session.id));
    const exactRef = sessions.find(session => session.terminalRef === terminal.terminalRef);
    if (exactRef)
        return { session: exactRef, reason: 'exact terminalRef' };
    if (terminal.terminalPid !== undefined) {
        const exactPid = sessions.find(session => (session.terminalPid ?? getLegacyAttachedTerminalPid(session.id)) === terminal.terminalPid);
        if (exactPid)
            return { session: exactPid, reason: 'exact terminalPid' };
    }
    const terminalPath = normalizePathForCompare(terminal.terminalCwd ?? '');
    if (!terminalPath)
        return null;
    const matchingTerminals = (registration.terminals ?? [])
        .filter(candidate => normalizePathForCompare(candidate.terminalCwd ?? '') === terminalPath);
    if (matchingTerminals.length > 1)
        return null;
    const matchingSessions = sessions.filter(session => !session.terminalRef?.trim() &&
        (!session.vscodeWindowId || session.vscodeWindowId === registration.windowId) &&
        normalizePathForCompare(session.cwd) === terminalPath);
    if (matchingSessions.length > 1)
        return null;
    const matchingSession = matchingSessions[0];
    return matchingSession ? { session: matchingSession, reason: 'unique cwd fallback' } : null;
}
function bindSessionsToVsCodeWindow(registration) {
    if (!registration.sessionIds || registration.sessionIds.length === 0)
        return;
    let didBindSession = false;
    for (const sessionId of registration.sessionIds) {
        const previousSession = sessionManager.getSession(sessionId);
        const reboundSession = sessionManager.bindSessionToVsCodeWindow(sessionId, registration.windowId);
        if (!previousSession || !reboundSession || previousSession.vscodeWindowId === reboundSession.vscodeWindowId)
            continue;
        didBindSession = true;
    }
    if (didBindSession)
        (0, settings_1.saveSessions)(getSessionsStateToSave());
}
function handleVsCodeCommandPoll(requestUrl, response) {
    const windowId = requestUrl.searchParams.get('windowId')?.trim();
    if (!windowId) {
        writeJsonResponse(response, 400, { ok: false, error: 'missing_window_id' });
        return;
    }
    rememberVsCodeWindow(readVsCodeWindowRegistrationFromUrl(requestUrl, windowId));
    const commands = pendingVsCodeCommandsByWindowId.get(windowId) ?? [];
    if (commands.length > 0) {
        pendingVsCodeCommandsByWindowId.delete(windowId);
        writeVsCodeCommandPollResponse(response, commands);
        return;
    }
    completePendingVsCodeCommandPoll(windowId, []);
    const timeout = setTimeout(() => {
        const pendingPoll = pendingVsCodeCommandPollsByWindowId.get(windowId);
        if (!pendingPoll || pendingPoll.response !== response)
            return;
        pendingVsCodeCommandPollsByWindowId.delete(windowId);
        writeVsCodeCommandPollResponse(response, []);
    }, VSCODE_COMMAND_LONG_POLL_TIMEOUT_MS);
    pendingVsCodeCommandPollsByWindowId.set(windowId, { response, timeout });
    response.on('close', () => {
        const pendingPoll = pendingVsCodeCommandPollsByWindowId.get(windowId);
        if (!pendingPoll || pendingPoll.response !== response)
            return;
        clearTimeout(pendingPoll.timeout);
        pendingVsCodeCommandPollsByWindowId.delete(windowId);
    });
}
function enqueueVsCodeCommand(windowId, command) {
    const queue = pendingVsCodeCommandsByWindowId.get(windowId) ?? [];
    queue.push(command);
    while (queue.length > MAX_PENDING_VSCODE_COMMANDS_PER_WINDOW)
        queue.shift();
    pendingVsCodeCommandsByWindowId.set(windowId, queue);
    flushPendingVsCodeCommandPoll(windowId);
}
function queueDisconnectSessionCommand(session) {
    const windowId = session.vscodeWindowId?.trim();
    const currentSession = sessionManager.getSession(session.id) ?? session;
    const terminalRef = currentSession.terminalRef?.trim();
    if (!windowId || !terminalRef)
        return false;
    enqueueVsCodeCommand(windowId, { id: (0, node_crypto_1.randomUUID)(), type: 'disconnect-session', terminalRef });
    return true;
}
function flushPendingVsCodeCommandPoll(windowId) {
    if (!pendingVsCodeCommandPollsByWindowId.has(windowId))
        return;
    const commands = pendingVsCodeCommandsByWindowId.get(windowId) ?? [];
    pendingVsCodeCommandsByWindowId.delete(windowId);
    completePendingVsCodeCommandPoll(windowId, commands);
}
function completePendingVsCodeCommandPoll(windowId, commands) {
    const pendingPoll = pendingVsCodeCommandPollsByWindowId.get(windowId);
    if (!pendingPoll)
        return;
    clearTimeout(pendingPoll.timeout);
    pendingVsCodeCommandPollsByWindowId.delete(windowId);
    if (!pendingPoll.response.writableEnded)
        writeVsCodeCommandPollResponse(pendingPoll.response, commands);
}
function closePendingVsCodeCommandPolls() {
    for (const windowId of [...pendingVsCodeCommandPollsByWindowId.keys()]) {
        completePendingVsCodeCommandPoll(windowId, []);
    }
}
function writeVsCodeCommandPollResponse(response, commands) {
    writeJsonResponse(response, 200, { ok: true, longPoll: true, commands });
}
function readVsCodeWindowRegistrationFromUrl(requestUrl, windowId) {
    const registration = { windowId };
    const workspaceFolder = requestUrl.searchParams.get('workspaceFolder')?.trim();
    if (workspaceFolder)
        registration.workspaceFolder = workspaceFolder;
    const workspaceName = requestUrl.searchParams.get('workspaceName')?.trim();
    if (workspaceName)
        registration.workspaceName = workspaceName;
    const rawPid = requestUrl.searchParams.get('pid');
    const pid = rawPid ? Number(rawPid) : NaN;
    if (Number.isFinite(pid))
        registration.pid = pid;
    if (requestUrl.searchParams.get('sessionIdsKnown') === '1') {
        registration.sessionIds = requestUrl.searchParams.getAll('sessionId')
            .map(sessionId => sessionId.trim())
            .filter(sessionId => sessionId.length > 0);
    }
    return registration;
}
function parseCreateSessionRequest(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const record = payload;
    const rawId = readStringField(record, 'id').trim() || readStringField(record, 'taskId').trim();
    const cwd = readStringField(record, 'cwd').trim();
    const rawShellType = readStringField(record, 'shellType').trim();
    const shellType = isShellType(rawShellType) ? rawShellType : 'powershell';
    const sshCommand = (readStringField(record, 'sshCommand') || readStringField(record, 'sshHost')).trim();
    const cmd = (readStringField(record, 'command') || readStringField(record, 'cmd')).trim();
    const name = readStringField(record, 'name').trim() || node_path_1.default.basename(cwd) || sshCommand || 'Session';
    const vscodeWindowId = readStringField(record, 'windowId').trim();
    const terminalRef = readStringField(record, 'terminalRef').trim();
    const terminalName = readStringField(record, 'terminalName').trim();
    const launchId = readStringField(record, 'launchId').trim();
    const terminalPid = readOptionalNumberField(record, 'terminalPid');
    const id = rawId ||
        (launchId ? pendingLaunchTaskIdByLaunchId.get(launchId) ?? '' : '') ||
        (terminalRef ? taskIdByTerminalRef.get(terminalRef) ?? '' : '');
    if (shellType === 'ssh') {
        if (!sshCommand)
            return null;
    }
    else if (!cwd) {
        return null;
    }
    const request = { name, cmd, cwd, shellType };
    if (id)
        request.id = id;
    if (sshCommand)
        request.sshCommand = sshCommand;
    if (vscodeWindowId)
        request.vscodeWindowId = vscodeWindowId;
    if (terminalRef)
        request.terminalRef = terminalRef;
    if (terminalPid !== undefined)
        request.terminalPid = terminalPid;
    if (terminalName)
        request.terminalName = terminalName;
    if (launchId)
        request.launchId = launchId;
    return request;
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
    const update = { id, status: rawStatus, occurredAt };
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
    const windowId = readStringField(record, 'windowId').trim();
    const terminalPid = readOptionalNumberField(record, 'terminalPid');
    const terminalName = readStringField(record, 'terminalName').trim();
    const terminalCwd = readStringField(record, 'terminalCwd').trim();
    const rawShellType = readStringField(record, 'shellType').trim();
    const shellType = isShellType(rawShellType) ? rawShellType : undefined;
    const id = resolveTerminalEventTaskId({
        explicitTaskId,
        terminalRef,
        launchId,
        windowId,
        terminalPid,
        terminalName,
        terminalCwd,
    });
    if (!id)
        return null;
    const event = { id, type: rawType, occurredAt };
    if (terminalRef)
        event.terminalRef = terminalRef;
    if (launchId)
        event.launchId = launchId;
    if (windowId)
        event.windowId = windowId;
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
        vscodeWindowId: windowId,
        terminalRef,
        terminalPid,
        captureState: event.captureState,
        captureReason: event.captureReason,
    });
    return event;
}
function isTerminalEventRelayPayload(payload) {
    if (typeof payload !== 'object' || payload === null)
        return false;
    const rawType = readStringField(payload, 'type').trim();
    return isTerminalEventType(rawType);
}
function resolveTerminalEventTaskId(identity) {
    if (identity.launchId) {
        const launchTaskId = pendingLaunchTaskIdByLaunchId.get(identity.launchId);
        if (launchTaskId)
            return launchTaskId;
    }
    if (identity.terminalRef) {
        const terminalTaskId = taskIdByTerminalRef.get(identity.terminalRef);
        if (terminalTaskId)
            return terminalTaskId;
    }
    if (identity.explicitTaskId)
        return identity.explicitTaskId;
    return findSessionForTerminalIdentity(identity)?.id ?? '';
}
function findSessionForTerminalIdentity(identity) {
    const sessions = sessionManager.getSessions();
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
        (!identity.windowId || !session.vscodeWindowId || session.vscodeWindowId === identity.windowId) &&
        normalizePathForCompare(session.cwd) === normalizedTerminalPath) ?? null;
}
function handleTerminalUpdate(update) {
    if (removedSessionIds.has(update.id)) {
        debugTerminalUpdate('terminal update ignored for removed session', terminalUpdateDebugDetails(update));
        return;
    }
    if (applyTerminalUpdate(update))
        return;
    debugTerminalUpdate('terminal update queued for missing session', terminalUpdateDebugDetails(update));
    pendingTerminalUpdates.set(update.id, update);
}
function handleTerminalEvent(event) {
    if (removedSessionIds.has(event.id)) {
        debugTerminalUpdate('terminal event ignored for removed session', terminalEventDebugDetails(event, event.terminalName));
        return;
    }
    if (event.windowId)
        rememberVsCodeWindow({ windowId: event.windowId });
    debugTerminalUpdate('terminal event received', terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
    if (applyTerminalEvent(event))
        return;
    debugTerminalUpdate('terminal event queued for missing session', terminalEventDebugDetails(event, getTerminalEventSessionName(event)));
    queuePendingTerminalEvent(event);
}
function applyTerminalUpdate(update) {
    const previousSession = sessionManager.getSession(update.id);
    const session = sessionManager.updateTerminalState(update);
    if (!session) {
        debugTerminalUpdate('terminal update could not be applied', terminalUpdateDebugDetails(update));
        return false;
    }
    debugTerminalUpdate('terminal update applied', {
        ...terminalUpdateDebugDetails(update),
        previousStatus: previousSession?.status,
        nextStatus: session.status,
    });
    saveSessionsAfterTerminalStatusChange(previousSession?.status, session.status);
    return true;
}
function applyTerminalEvent(event) {
    const previousSession = sessionManager.getSession(event.id);
    const sessionName = previousSession?.name ?? event.terminalName;
    const result = sessionManager.updateTerminalEventWithDetails(event);
    if (!result) {
        debugTerminalUpdate('terminal event could not be applied', terminalEventDebugDetails(event, sessionName));
        return false;
    }
    const { session, statusUpdate } = result;
    debugTerminalUpdate('terminal event applied', {
        ...terminalEventDebugDetails(event, session.name),
        ...terminalEventStatusDebugDetails(statusUpdate),
        previousStatus: previousSession?.status,
        nextStatus: session.status,
    });
    saveSessionsAfterTerminalStatusChange(previousSession?.status, session.status);
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
function queuePendingTerminalEvent(event) {
    const events = pendingTerminalEvents.get(event.id) ?? [];
    events.push(event);
    if (events.length > MAX_PENDING_TERMINAL_EVENTS_PER_SESSION)
        events.shift();
    pendingTerminalEvents.set(event.id, events);
}
function flushPendingTerminalUpdates(id) {
    if (id) {
        const update = pendingTerminalUpdates.get(id);
        if (!update || !applyTerminalUpdate(update))
            return;
        pendingTerminalUpdates.delete(id);
        return;
    }
    for (const sessionId of [...pendingTerminalUpdates.keys()])
        flushPendingTerminalUpdates(sessionId);
}
function flushPendingTerminalEvents(id) {
    if (id) {
        const events = pendingTerminalEvents.get(id);
        if (!events)
            return;
        const remainingEvents = [];
        for (const event of events) {
            if (!applyTerminalEvent(event))
                remainingEvents.push(event);
        }
        if (remainingEvents.length === 0) {
            pendingTerminalEvents.delete(id);
        }
        else {
            pendingTerminalEvents.set(id, remainingEvents);
        }
        return;
    }
    for (const sessionId of [...pendingTerminalEvents.keys()])
        flushPendingTerminalEvents(sessionId);
}
function markSessionRemoved(id) {
    removedSessionIds.add(id);
    pendingTerminalUpdates.delete(id);
    pendingTerminalEvents.delete(id);
}
function forgetRemovedSession(id) {
    removedSessionIds.delete(id);
}
function rememberTaskTerminalBinding(taskId, binding) {
    const previousTerminalRef = sessionManager.getSession(taskId)?.terminalRef?.trim();
    const terminalRef = binding.terminalRef?.trim();
    if (previousTerminalRef && terminalRef && previousTerminalRef !== terminalRef)
        taskIdByTerminalRef.delete(previousTerminalRef);
    if (terminalRef)
        taskIdByTerminalRef.set(terminalRef, taskId);
    sessionManager.bindSessionToTerminal(taskId, buildTerminalBinding({
        vscodeWindowId: binding.vscodeWindowId,
        terminalRef,
        terminalPid: binding.terminalPid,
        terminalCaptureState: binding.captureState,
        terminalCaptureReason: binding.captureReason,
    }));
}
function buildTerminalBinding(binding) {
    const terminalBinding = {};
    const vscodeWindowId = binding.vscodeWindowId?.trim();
    if (vscodeWindowId)
        terminalBinding.vscodeWindowId = vscodeWindowId;
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
function getSessionsStateToSave() {
    return sessionManager.getSessions()
        .filter(session => session.status !== 'error' && session.status !== 'stopped' && session.status !== 'detached')
        .map(session => ({
        id: session.id,
        name: session.name,
        cmd: session.cmd,
        cwd: session.cwd,
        shellType: session.shellType,
        ...(session.sshCommand ? { sshCommand: session.sshCommand } : {}),
        ...(session.vscodeWindowId ? { vscodeWindowId: session.vscodeWindowId } : {}),
        ...(session.terminalRef ? { terminalRef: session.terminalRef } : {}),
        ...(session.terminalPid !== undefined ? { terminalPid: session.terminalPid } : {}),
    }));
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
function readPayloadValue(payload, key) {
    if (typeof payload !== 'object' || payload === null)
        return undefined;
    return payload[key];
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function readPayloadString(payload, key) {
    const value = readPayloadValue(payload, key);
    return typeof value === 'string' ? value : '';
}
function readStringField(record, key) {
    if (!record)
        return '';
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
function readStringArrayField(record, key) {
    const value = record[key];
    if (!Array.isArray(value))
        return [];
    return value
        .filter((item) => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => item.length > 0);
}
function cloneManualTask(task) {
    return { ...task };
}
function cloneRecurringTask(task) {
    return {
        ...task,
        frequency: task.frequency ?? 'weekly',
        daysOfWeek: [...task.daysOfWeek],
    };
}
function cloneSlackNotification(notification) {
    return { ...notification };
}
function cloneVsCodeWindowEntry(entry) {
    const clone = {
        windowId: entry.windowId,
        lastSeenAt: entry.lastSeenAt,
    };
    if (entry.workspaceFolder)
        clone.workspaceFolder = entry.workspaceFolder;
    if (entry.workspaceName)
        clone.workspaceName = entry.workspaceName;
    if (entry.pid !== undefined)
        clone.pid = entry.pid;
    if (entry.terminals !== undefined)
        clone.terminals = entry.terminals.map(terminal => ({ ...terminal }));
    if (entry.sessionIds !== undefined)
        clone.sessionIds = [...entry.sessionIds];
    return clone;
}
class HttpBodyTooLargeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HttpBodyTooLargeError';
    }
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
            if (bodyBytes > MAX_HTTP_BODY_BYTES) {
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
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function readBackendPort() {
    const value = Number(process.env['MULTITASKER_BACKEND_PORT']);
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : DEFAULT_PORT;
}
function isVsCodeCommandPath(requestPath) {
    return requestPath === VSCODE_COMMAND_PATH || requestPath === EXTENSION_VSCODE_COMMAND_PATH;
}
function shouldBackendOwnState() {
    return process.env[BACKEND_OWNS_STATE_ENV] === '1';
}
function isTerminalUpdateDebugEnabled() {
    const value = process.env[TERMINAL_UPDATE_DEBUG_ENV]?.toLowerCase();
    return value === '1' || value === 'true';
}
function debugTerminalUpdate(message, details = {}) {
    const serializedDetails = Object.entries(details)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
        .join(' ');
    const line = `[multitasker backend terminal ${new Date().toISOString()}] ${message}${serializedDetails ? ` ${serializedDetails}` : ''}`;
    appendTerminalDebugLog(line, details);
    if (isTerminalUpdateDebugEnabled())
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
        reportDebugLogWriteFailure(`Could not write backend terminal debug log "${filePath}": ${getErrorMessage(error)}`);
    }
}
function appendSlackDebugLog(message, details = {}) {
    const serializedDetails = Object.entries(details)
        .filter(([, value]) => value !== undefined && value !== '')
        .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
        .join(' ');
    const filePath = node_path_1.default.join(process.cwd(), DEBUG_LOG_DIRECTORY, SLACK_SOCKET_DEBUG_LOG_FILE);
    try {
        node_fs_1.default.mkdirSync(node_path_1.default.dirname(filePath), { recursive: true });
        node_fs_1.default.appendFileSync(filePath, `[multitasker backend slack ${new Date().toISOString()}] ${message}${serializedDetails ? ` ${serializedDetails}` : ''}\n`, 'utf8');
    }
    catch (error) {
        reportDebugLogWriteFailure(`Could not write backend Slack debug log "${filePath}": ${getErrorMessage(error)}`);
    }
}
function getTerminalDebugLogFilePath(sessionId, details) {
    const existingFilePath = terminalDebugLogFileBySessionId.get(sessionId);
    if (existingFilePath)
        return existingFilePath;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
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
    const session = sessionManager.getSession(sessionId);
    if (session?.name.trim())
        return session.name.trim();
    const terminalName = details['terminalName'];
    if (typeof terminalName === 'string' && terminalName.trim())
        return terminalName.trim();
    return 'unknown-session';
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
        windowId: event.windowId,
        captureState: event.captureState,
        captureReason: event.captureReason,
        output: event.output === undefined ? undefined : terminalOutputDebugValue(event.output),
    };
}
function getTerminalEventSessionName(event) {
    return sessionManager.getSession(event.id)?.name ?? event.terminalName;
}
function terminalOutputDebugValue(output) {
    return output
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r/g, '\n')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}
appendSlackDebugLog('backend process started', { port: PORT, storageDirectory });
