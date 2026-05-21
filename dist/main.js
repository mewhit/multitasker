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
const node_window_manager_1 = require("node-window-manager");
const sessionManager_1 = require("./sessionManager");
const settings_1 = require("./settings");
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const WINDOW_MIN_WIDTH = 960;
const WINDOW_MIN_HEIGHT = 600;
const WINDOW_STATE_SAVE_DEBOUNCE_MS = 500;
const MIN_VISIBLE_WINDOW_AREA = 100;
const VSCODE_COMPANION_START_URI = 'vscode://multitasker.vscode-companion/start';
const MULTITASKER_PROTOCOL = 'multitasker';
const MULTITASKER_CREATE_PATH = '/create';
const MULTITASKER_TERMINAL_PATH = '/terminal';
const TERMINAL_UPDATE_HOST = '127.0.0.1';
const TERMINAL_UPDATE_PORT = 39017;
const TERMINAL_UPDATE_PATH = '/terminal-update';
const TERMINAL_EVENT_PATH = '/terminal-event';
const VSCODE_WINDOW_PATH = '/vscode-window';
const VSCODE_COMMAND_PATH = '/vscode-command';
const SLACK_EVENT_PATH = '/slack-event';
const SLACK_NOTIFICATION_PATH = '/slack-notification';
const SLACK_NOTIFICATION_DISMISS_PATH = '/slack-notification-dismiss';
const MAX_TERMINAL_EVENT_BODY_BYTES = 512 * 1024;
const MAX_MANUAL_TASKS = 200;
const MAX_MANUAL_TASK_TEXT_LENGTH = 4000;
const MAX_RECURRING_TASKS = 100;
const RECURRING_TASK_CHECK_INTERVAL_MS = 30 * 1000;
const MAX_SLACK_NOTIFICATIONS = 100;
const MAX_SLACK_TEXT_LENGTH = 4000;
const MAX_SLACK_DEBUG_TEXT_LENGTH = 700;
const MAX_PENDING_TERMINAL_EVENTS_PER_SESSION = 200;
const MAX_PENDING_VSCODE_COMMANDS_PER_WINDOW = 50;
const TERMINAL_DEBUG_OUTPUT_PREVIEW_LENGTH = 500;
const VSCODE_WINDOW_FOCUS_AFTER_DEEPLINK_DELAY_MS = 1000;
const VSCODE_COMMAND_LONG_POLL_TIMEOUT_MS = 25000;
const MAX_VSCODE_FOCUS_CANDIDATES_IN_LOG = 5;
const DEBUG_LOG_DIRECTORY = 'debug-log';
const DEBUG_LOG_FILE_EXTENSION = '.log';
const TERMINAL_UPDATE_DEBUG_ENV = 'MULTITASKER_DEBUG_TERMINAL';
const SLACK_AUTH_DEBUG_LOG_FILE = 'slack-auth.log';
const SLACK_SOCKET_DEBUG_LOG_FILE = 'slack-connector.log';
const SLACK_OAUTH_SCRIPT_RELATIVE_PATH = node_path_1.default.join('extension', 'slack', 'src', 'slack-oauth.js');
const SLACK_SOCKET_SCRIPT_RELATIVE_PATH = node_path_1.default.join('extension', 'slack', 'src', 'slack-socket.js');
const SLACK_AUTH_OUTPUT_MAX_LENGTH = 4000;
const SLACK_SOCKET_OUTPUT_MAX_LENGTH = 4000;
const SLACK_USER_CONVERSATIONS_REFRESH_MS = 5 * 60 * 1000;
const SLACK_PRIORITY_MENTION = { rank: 0, label: 'mention' };
const SLACK_PRIORITY_DM = { rank: 1, label: 'dm' };
const SLACK_PRIORITY_THREAD_MENTION = { rank: 2, label: 'thread_mention' };
const SLACK_PRIORITY_THREAD_WRITTEN = { rank: 3, label: 'thread_written' };
const SLACK_PRIORITY_OTHER = { rank: 4, label: 'other' };
const SLACK_AUTHORIZE_URL_PATTERN = /https:\/\/slack\.com\/oauth\/v2\/authorize\?\S+/;
let mainWindow = null;
let sessionManager = null;
let terminalUpdateServer = null;
let windowStateSaveTimer = null;
const pendingDeepLinks = [];
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
const cachedVsCodeWindowHandlesByWindowId = new Map();
const manualTasks = [];
const recurringTasks = [];
const slackNotifications = [];
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
function readStringArrayField(record, key) {
    const value = record[key];
    if (!Array.isArray(value))
        return [];
    return value
        .filter((item) => typeof item === 'string')
        .map(item => item.trim())
        .filter(item => item.length > 0);
}
function buildVsCodeCompanionUri(session) {
    const launchId = (0, node_crypto_1.randomUUID)();
    pendingLaunchTaskIdByLaunchId.set(launchId, session.id);
    const payload = {
        launchId,
        name: session.name,
        cwd: session.cwd,
        command: session.cmd,
        shellType: session.shellType,
        sshCommand: session.sshCommand ?? '',
    };
    return `${VSCODE_COMPANION_START_URI}?payload=${encodeURIComponent(JSON.stringify(payload))}`;
}
async function openSessionInVsCode(session) {
    debugTerminalUpdate('vscode open requested', getVsCodeOpenDebugDetails(session));
    try {
        const bindingStatus = getVsCodeBindingStatus(session);
        if (bindingStatus === 'stale') {
            debugTerminalUpdate('vscode open stopped; session detached', getVsCodeOpenDebugDetails(session));
            return false;
        }
        if (bindingStatus === 'valid' || bindingStatus === 'unverified') {
            let didRequestWindowFocus = false;
            if (canFocusRegisteredVsCodeWindow(session)) {
                didRequestWindowFocus = await focusRegisteredVsCodeWindow(session);
            }
            else {
                debugTerminalUpdate('vscode window OS focus skipped; missing exact process id', getVsCodeOpenDebugDetails(session));
            }
            const didQueueTerminalFocus = queueFocusTerminalCommand(session);
            return didRequestWindowFocus || didQueueTerminalFocus;
        }
        debugTerminalUpdate('vscode binding unavailable; using companion deeplink', getVsCodeOpenDebugDetails(session));
        const companionUri = buildVsCodeCompanionUri(session);
        debugTerminalUpdate('vscode companion deeplink requested', getVsCodeOpenDebugDetails(session, {
            companionUri: redactVsCodeCompanionUri(companionUri),
        }));
        await electron_1.shell.openExternal(companionUri);
        debugTerminalUpdate('vscode companion deeplink completed', getVsCodeOpenDebugDetails(session));
        scheduleVsCodeWindowFocus(session);
        return true;
    }
    catch (err) {
        debugTerminalUpdate('vscode open failed', getVsCodeOpenDebugDetails(session, { error: getErrorMessage(err) }));
        console.error('Failed to open VS Code:', getErrorMessage(err));
        return false;
    }
}
function getVsCodeBindingStatus(session) {
    const windowId = session.vscodeWindowId?.trim();
    if (!windowId)
        return 'none';
    const windowEntry = vscodeWindowsById.get(windowId);
    if (!windowEntry) {
        return 'none';
    }
    const reboundSession = bindSessionToMatchingVsCodeTerminal(session, windowEntry);
    if (reboundSession?.terminalRef)
        return 'valid';
    if (windowEntry.terminals === undefined) {
        debugTerminalUpdate('vscode binding unverified; window has not reported terminals yet', getVsCodeOpenDebugDetails(session, {
            windowId,
            workspaceFolder: windowEntry.workspaceFolder,
            workspaceName: windowEntry.workspaceName,
        }));
        return 'unverified';
    }
    return 'none';
}
function bindSessionToMatchingVsCodeTerminal(session, windowEntry) {
    const terminal = findMatchingVsCodeTerminal(session, windowEntry);
    if (!terminal)
        return null;
    const reboundSession = sessionManager?.bindSessionToTerminal(session.id, buildTerminalBinding({
        vscodeWindowId: windowEntry.windowId,
        terminalRef: terminal.terminalRef,
        terminalPid: terminal.terminalPid,
        terminalCaptureState: terminal.captureState,
        terminalCaptureReason: terminal.captureReason,
    })) ?? null;
    if (!reboundSession)
        return null;
    rememberTaskTerminalBinding(reboundSession.id, {
        vscodeWindowId: windowEntry.windowId,
        terminalRef: terminal.terminalRef,
        terminalPid: terminal.terminalPid,
        captureState: terminal.captureState,
        captureReason: terminal.captureReason,
    });
    debugTerminalUpdate('session bound to vscode terminal', getVsCodeOpenDebugDetails(reboundSession, {
        terminalRef: terminal.terminalRef,
        terminalPid: terminal.terminalPid,
        terminalName: terminal.terminalName,
        terminalCwd: terminal.terminalCwd,
        windowId: windowEntry.windowId,
    }));
    return reboundSession;
}
function findMatchingVsCodeTerminal(session, windowEntry) {
    const terminals = windowEntry.terminals ?? [];
    if (terminals.length === 0)
        return null;
    const sessionTerminalRef = session.terminalRef?.trim();
    if (sessionTerminalRef) {
        const exactRefMatch = terminals.find(terminal => terminal.terminalRef === sessionTerminalRef);
        if (exactRefMatch)
            return exactRefMatch;
    }
    const sessionTerminalPid = session.terminalPid ?? getLegacyAttachedTerminalPid(session.id);
    if (sessionTerminalPid !== undefined) {
        const exactPidMatch = terminals.find(terminal => terminal.terminalPid === sessionTerminalPid);
        if (exactPidMatch)
            return exactPidMatch;
    }
    const normalizedSessionPath = normalizePathForCompare(session.cwd);
    const sessionName = session.name.trim().toLowerCase();
    const scored = terminals
        .map(terminal => ({
        terminal,
        score: scoreTerminalMatch(terminal, normalizedSessionPath, sessionName),
    }))
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score);
    return scored[0]?.terminal ?? null;
}
function scoreTerminalMatch(terminal, normalizedSessionPath, sessionName) {
    let score = 0;
    const terminalPath = normalizePathForCompare(terminal.terminalCwd ?? '');
    const terminalName = (terminal.terminalName ?? '').trim().toLowerCase();
    if (normalizedSessionPath && terminalPath && normalizedSessionPath === terminalPath)
        score += 4;
    if (sessionName && terminalName && (terminalName === sessionName || terminalName.includes(sessionName)))
        score += 2;
    return score;
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
    const terminalRef = binding.terminalRef?.trim();
    if (terminalRef)
        taskIdByTerminalRef.set(terminalRef, taskId);
    sessionManager?.bindSessionToTerminal(taskId, buildTerminalBinding({
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
function focusRegisteredVsCodeWindow(session) {
    return focusVsCodeWindow(session);
}
function canFocusRegisteredVsCodeWindow(session) {
    const windowId = session.vscodeWindowId?.trim();
    const windowEntry = windowId ? vscodeWindowsById.get(windowId) : undefined;
    return typeof windowEntry?.pid === 'number' ||
        Boolean((windowEntry?.workspaceFolder ?? session.cwd).trim());
}
function scheduleVsCodeWindowFocus(session) {
    if (process.platform !== 'win32')
        return;
    setTimeout(() => {
        void focusVsCodeWindow(session);
    }, VSCODE_WINDOW_FOCUS_AFTER_DEEPLINK_DELAY_MS);
}
async function focusVsCodeWindow(session) {
    if (process.platform !== 'win32')
        return Promise.resolve(false);
    const details = getWindowsVsCodeFocusDetails(session);
    try {
        const response = focusWindowsVsCodeWindow(details);
        if (!response.ok) {
            const error = response.error ?? 'no matching VS Code window';
            debugTerminalUpdate('vscode window OS focus failed', getVsCodeOpenDebugDetails(session, {
                windowId: details.windowId,
                error,
                fromCache: response.fromCache,
            }));
            notifyVsCodeFocusFailed(session, error);
            return false;
        }
        debugTerminalUpdate('vscode window OS focus completed', getVsCodeOpenDebugDetails(session, {
            windowId: details.windowId,
            result: response.title ?? '',
            handle: response.handle,
            pid: response.pid,
            fromCache: response.fromCache,
        }));
        return true;
    }
    catch (error) {
        const message = getErrorMessage(error);
        debugTerminalUpdate('vscode window OS focus failed', getVsCodeOpenDebugDetails(session, {
            windowId: details.windowId,
            error: message,
        }));
        notifyVsCodeFocusFailed(session, message);
        return false;
    }
}
function focusWindowsVsCodeWindow(details) {
    const cacheKey = details.windowId.trim();
    const cachedCandidate = getCachedVsCodeWindowCandidate(cacheKey, details);
    if (cachedCandidate && isStrongVsCodeWindowCandidate(cachedCandidate)) {
        focusManagedWindow(cachedCandidate.window);
        return buildWindowsVsCodeFocusSuccess(cachedCandidate, true);
    }
    if (cacheKey)
        cachedVsCodeWindowHandlesByWindowId.delete(cacheKey);
    let bestCandidate = null;
    const candidates = [];
    for (const managedWindow of node_window_manager_1.windowManager.getWindows()) {
        const candidate = buildVsCodeWindowCandidate(managedWindow, details);
        if (!candidate)
            continue;
        candidates.push(candidate);
        if (isStrongVsCodeWindowCandidate(candidate) &&
            (bestCandidate === null || candidate.score > bestCandidate.score)) {
            bestCandidate = candidate;
        }
    }
    if (bestCandidate === null) {
        return {
            ok: false,
            error: `no matching VS Code window${formatVsCodeWindowCandidates(candidates)}`,
        };
    }
    if (cacheKey)
        cachedVsCodeWindowHandlesByWindowId.set(cacheKey, bestCandidate.window.id);
    focusManagedWindow(bestCandidate.window);
    return buildWindowsVsCodeFocusSuccess(bestCandidate, false);
}
function getCachedVsCodeWindowCandidate(cacheKey, details) {
    if (!cacheKey)
        return null;
    const cachedHandle = cachedVsCodeWindowHandlesByWindowId.get(cacheKey);
    if (cachedHandle === undefined)
        return null;
    return buildVsCodeWindowCandidate(new node_window_manager_1.Window(cachedHandle), details);
}
function buildVsCodeWindowCandidate(managedWindow, details) {
    if (!managedWindow.isWindow())
        return null;
    const title = managedWindow.getTitle();
    if (!title || !titleContains(title, 'Visual Studio Code'))
        return null;
    if (!isCodeWindowProcess(managedWindow))
        return null;
    const processId = managedWindow.processId;
    const workspaceTitle = getVsCodeWorkspaceTitle(title);
    const processMatches = details.pid !== undefined && processId === details.pid;
    const workspaceMatches = workspaceTitleMatches(workspaceTitle, details.workspaceName, getLeaf(details.workspaceFolder));
    const isStrongMatch = processMatches || workspaceMatches;
    const isVisible = managedWindow.isVisible();
    let score = 1;
    if (processMatches)
        score += 1000;
    if (workspaceMatches)
        score += 300;
    if (isVisible)
        score += 5;
    return {
        window: managedWindow,
        title,
        score,
        processId,
        isVisible,
        isStrongMatch,
    };
}
function isStrongVsCodeWindowCandidate(candidate) {
    return candidate.isStrongMatch;
}
function focusManagedWindow(managedWindow) {
    managedWindow.show();
    managedWindow.bringToTop();
}
function buildWindowsVsCodeFocusSuccess(candidate, fromCache) {
    return {
        ok: true,
        title: candidate.title,
        handle: String(candidate.window.id),
        pid: candidate.processId,
        fromCache,
    };
}
function formatVsCodeWindowCandidates(candidates) {
    if (candidates.length === 0)
        return '';
    return `; candidates=${candidates
        .slice(0, MAX_VSCODE_FOCUS_CANDIDATES_IN_LOG)
        .map(candidate => `#${candidate.processId} ${candidate.title}`)
        .join(', ')}`;
}
function isCodeWindowProcess(managedWindow) {
    const executablePath = managedWindow.path.trim();
    if (!executablePath)
        return false;
    return node_path_1.default.basename(executablePath, node_path_1.default.extname(executablePath))
        .toLowerCase()
        .startsWith('code');
}
function titleContains(title, needle) {
    return needle.trim().length > 0 && title.toLowerCase().includes(needle.toLowerCase());
}
function workspaceTitleMatches(workspaceTitle, workspaceName, workspaceLeaf) {
    return segmentMatches(workspaceTitle, workspaceName) || segmentMatches(workspaceTitle, workspaceLeaf);
}
function segmentMatches(segment, expected) {
    if (!segment.trim() || !expected.trim())
        return false;
    const normalizedSegment = segment.trim().toLowerCase();
    const normalizedExpected = expected.trim().toLowerCase();
    return normalizedSegment === normalizedExpected || normalizedSegment.includes(normalizedExpected);
}
function getVsCodeWorkspaceTitle(title) {
    const suffix = ' - Visual Studio Code';
    const suffixIndex = title.toLowerCase().lastIndexOf(suffix.toLowerCase());
    if (suffixIndex < 0)
        return '';
    const beforeSuffix = title.slice(0, suffixIndex);
    const separatorIndex = beforeSuffix.lastIndexOf(' - ');
    return separatorIndex >= 0 ? beforeSuffix.slice(separatorIndex + 3).trim() : beforeSuffix.trim();
}
function getLeaf(value) {
    const trimmedValue = value.trim().replace(/[\\\/]+$/, '');
    if (!trimmedValue)
        return '';
    const separatorIndex = Math.max(trimmedValue.lastIndexOf('\\'), trimmedValue.lastIndexOf('/'));
    return separatorIndex >= 0 ? trimmedValue.slice(separatorIndex + 1) : trimmedValue;
}
function getWindowsVsCodeFocusDetails(session) {
    const windowId = session.vscodeWindowId?.trim();
    const windowEntry = windowId ? vscodeWindowsById.get(windowId) : undefined;
    const workspaceFolder = windowEntry?.workspaceFolder ?? session.cwd;
    const details = {
        windowId: windowId ?? '',
        workspaceName: windowEntry?.workspaceName ?? node_path_1.default.basename(workspaceFolder),
        workspaceFolder,
        sessionName: session.name,
    };
    if (windowEntry?.pid !== undefined)
        details.pid = windowEntry.pid;
    return details;
}
function notifyVsCodeFocusFailed(session, reason) {
    const windowId = session.vscodeWindowId?.trim();
    const windowEntry = windowId ? vscodeWindowsById.get(windowId) : undefined;
    const missingWindowMetadata = windowEntry?.sessionIds === undefined;
    const multipleCandidates = reason.includes('candidates=');
    const message = missingWindowMetadata && multipleCandidates
        ? 'VS Code focused the terminal, but Windows could not bring the right window forward because this VS Code window has not reported its metadata yet. Reload the VS Code extension/window and click again.'
        : 'VS Code focused the terminal, but Windows could not bring the VS Code window forward. Check debug-log for the focus failure details.';
    mainWindow?.webContents.send('editor:vscode-focus-failed', {
        id: session.id,
        message,
        reason,
    });
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
function getVsCodeOpenDebugDetails(session, extraDetails = {}) {
    return {
        id: session.id,
        sessionName: session.name,
        cwd: session.cwd,
        shellType: session.shellType,
        vscodeWindowId: session.vscodeWindowId,
        terminalRef: session.terminalRef,
        terminalPid: session.terminalPid,
        hasCommand: session.cmd.length > 0,
        hasSshCommand: Boolean(session.sshCommand?.trim()),
        ...extraDetails,
    };
}
function queueFocusTerminalCommand(session) {
    const windowId = session.vscodeWindowId?.trim();
    const currentSession = sessionManager?.getSession(session.id) ?? session;
    const terminalRef = currentSession.terminalRef?.trim();
    if (!windowId || !terminalRef)
        return false;
    enqueueVsCodeCommand(windowId, {
        id: (0, node_crypto_1.randomUUID)(),
        type: 'focus-terminal',
        terminalRef,
    });
    debugTerminalUpdate('vscode focus terminal command queued', getVsCodeOpenDebugDetails(session, {
        windowId,
        terminalRef,
    }));
    return true;
}
function queueDisconnectSessionCommand(session) {
    const windowId = session.vscodeWindowId?.trim();
    const currentSession = sessionManager?.getSession(session.id) ?? session;
    const terminalRef = currentSession.terminalRef?.trim();
    if (!windowId || !terminalRef)
        return false;
    enqueueVsCodeCommand(windowId, {
        id: (0, node_crypto_1.randomUUID)(),
        type: 'disconnect-session',
        terminalRef,
    });
    debugTerminalUpdate('vscode disconnect session command queued', {
        id: session.id,
        vscodeWindowId: session.vscodeWindowId,
        windowId,
        terminalRef,
    });
    return true;
}
function enqueueVsCodeCommand(windowId, command) {
    const queue = pendingVsCodeCommandsByWindowId.get(windowId) ?? [];
    queue.push(command);
    while (queue.length > MAX_PENDING_VSCODE_COMMANDS_PER_WINDOW)
        queue.shift();
    pendingVsCodeCommandsByWindowId.set(windowId, queue);
    flushPendingVsCodeCommandPoll(windowId);
}
function redactVsCodeCompanionUri(uri) {
    const payloadIndex = uri.indexOf('payload=');
    if (payloadIndex === -1)
        return uri;
    return `${uri.slice(0, payloadIndex)}payload=<redacted>`;
}
function isVsCodeSessionRequest(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return (typeof candidate['id'] === 'string' &&
        typeof candidate['name'] === 'string' &&
        typeof candidate['cmd'] === 'string' &&
        typeof candidate['cwd'] === 'string' &&
        typeof candidate['shellType'] === 'string' &&
        isShellType(candidate['shellType']) &&
        (candidate['sshCommand'] === undefined || typeof candidate['sshCommand'] === 'string') &&
        (candidate['vscodeWindowId'] === undefined || typeof candidate['vscodeWindowId'] === 'string') &&
        (candidate['terminalRef'] === undefined || typeof candidate['terminalRef'] === 'string') &&
        (candidate['terminalPid'] === undefined || typeof candidate['terminalPid'] === 'number'));
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
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
    const line = `[multitasker terminal ${new Date().toISOString()}] ${message}${serializedDetails ? ` ${serializedDetails}` : ''}`;
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
        output: event.output === undefined ? undefined : terminalOutputDebugPreview(event.output),
    };
}
function getTerminalEventSessionName(event) {
    const session = sessionManager?.getSession(event.id);
    return session?.name ?? event.terminalName;
}
function terminalOutputDebugPreview(output) {
    const strippedOutput = stripTerminalControlSequences(output)
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
    const start = Math.max(0, strippedOutput.length - TERMINAL_DEBUG_OUTPUT_PREVIEW_LENGTH);
    const prefix = start > 0 ? '...' : '';
    return `${prefix}${strippedOutput.slice(start)}`;
}
function stripTerminalControlSequences(value) {
    return value
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r/g, '\n');
}
function getDeepLinkFromArgv(argv) {
    return argv.find(arg => arg.startsWith(`${MULTITASKER_PROTOCOL}://`));
}
function enqueueDeepLink(url) {
    if (!url.startsWith(`${MULTITASKER_PROTOCOL}://`))
        return;
    pendingDeepLinks.push(url);
    flushPendingDeepLinks();
}
function flushPendingDeepLinks() {
    if (!sessionManager)
        return;
    while (pendingDeepLinks.length > 0) {
        const deepLink = pendingDeepLinks.shift();
        if (!deepLink)
            continue;
        processDeepLink(deepLink);
    }
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
    const request = {
        name,
        cmd,
        cwd,
        shellType,
    };
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
    const event = {
        id,
        type: rawType,
        occurredAt,
    };
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
    return sessions.find(session => (!identity.windowId || !session.vscodeWindowId || session.vscodeWindowId === identity.windowId) &&
        normalizePathForCompare(session.cwd) === normalizedTerminalPath) ?? null;
}
function createManualTask(textValue) {
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    if (!text) {
        console.error('Failed to add manual task: task text is required');
        return null;
    }
    const task = {
        id: `manual-${(0, node_crypto_1.randomUUID)()}`,
        text: truncateManualTaskText(text),
        createdAt: Date.now(),
    };
    manualTasks.unshift(task);
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
function createRecurringTask(textValue, timeValue, daysValue) {
    const text = typeof textValue === 'string' ? textValue.trim() : '';
    const time = typeof timeValue === 'string' ? timeValue.trim() : '';
    const daysOfWeek = normalizeRecurringDays(daysValue);
    if (!text) {
        console.error('Failed to add recurring task: task text is required');
        return null;
    }
    if (parseRecurringTimeMinutes(time) === null) {
        console.error('Failed to add recurring task: invalid time');
        return null;
    }
    if (daysOfWeek.length === 0) {
        console.error('Failed to add recurring task: at least one weekday is required');
        return null;
    }
    const now = new Date();
    const task = {
        id: `recurring-${(0, node_crypto_1.randomUUID)()}`,
        text: truncateManualTaskText(text),
        time,
        daysOfWeek,
        createdAt: now.getTime(),
        enabled: true,
    };
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
function normalizeRecurringDays(value) {
    if (!Array.isArray(value))
        return [];
    const days = value
        .filter((day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
    return [...new Set(days)].sort((a, b) => a - b);
}
function cloneRecurringTask(task) {
    return { ...task, daysOfWeek: [...task.daysOfWeek] };
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
    if (!task.daysOfWeek.includes(now.getDay()))
        return false;
    const taskMinutes = parseRecurringTimeMinutes(task.time);
    if (taskMinutes === null)
        return false;
    return getLocalMinutesSinceMidnight(now) >= taskMinutes;
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
        return `slack://channel?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(channelId)}${messageQuery}`;
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
    const teamId = notification.teamId?.trim();
    if (teamId)
        targetUrl.searchParams.set('team', teamId);
    return targetUrl.toString();
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
        const terminals = record['terminals']
            .map(parseVsCodeTerminalRegistration)
            .filter((terminal) => terminal !== null);
        registration.terminals = terminals;
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
function startTerminalUpdateServer() {
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
    if (!terminalUpdateServer)
        return;
    closePendingVsCodeCommandPolls();
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
    if (request.method === 'GET' && requestPath === VSCODE_COMMAND_PATH) {
        handleVsCodeCommandPoll(requestUrl, response);
        return;
    }
    const isTerminalUpdatePath = requestPath === TERMINAL_UPDATE_PATH;
    const isTerminalEventPath = requestPath === TERMINAL_EVENT_PATH;
    const isVsCodeWindowPath = requestPath === VSCODE_WINDOW_PATH;
    const isSlackEventPath = requestPath === SLACK_EVENT_PATH;
    const isSlackNotificationPath = requestPath === SLACK_NOTIFICATION_PATH;
    const isSlackNotificationDismissPath = requestPath === SLACK_NOTIFICATION_DISMISS_PATH;
    if (request.method !== 'POST' ||
        (!isTerminalUpdatePath &&
            !isTerminalEventPath &&
            !isVsCodeWindowPath &&
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
        writeJsonResponse(response, 400, { ok: false, error: getErrorMessage(error) });
        return;
    }
    if (isVsCodeWindowPath) {
        const registration = parseVsCodeWindowRegistration(parsedPayload);
        if (!registration) {
            writeJsonResponse(response, 400, { ok: false, error: 'invalid_vscode_window' });
            return;
        }
        rememberVsCodeWindow(registration);
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
    if (!pendingPoll.response.writableEnded) {
        writeVsCodeCommandPollResponse(pendingPoll.response, commands);
    }
}
function closePendingVsCodeCommandPolls() {
    [...pendingVsCodeCommandPollsByWindowId.keys()].forEach(windowId => {
        completePendingVsCodeCommandPoll(windowId, []);
    });
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
function readHttpBody(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', (chunk) => {
            body += chunk;
            if (Buffer.byteLength(body, 'utf8') > MAX_TERMINAL_EVENT_BODY_BYTES) {
                reject(new Error('terminal event payload is too large'));
                request.destroy();
            }
        });
        request.on('end', () => resolve(body));
        request.on('error', reject);
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
}
function bindSessionsToVsCodeTerminals(registration) {
    const terminals = registration.terminals ?? [];
    if (terminals.length === 0)
        return;
    let didBindSession = false;
    for (const terminal of terminals) {
        const mappedTaskId = taskIdByTerminalRef.get(terminal.terminalRef);
        const session = mappedTaskId
            ? sessionManager?.getSession(mappedTaskId)
            : findSessionForTerminalRegistration(registration, terminal);
        if (!session)
            continue;
        const previousTerminalRef = session.terminalRef;
        const reboundSession = sessionManager?.bindSessionToTerminal(session.id, buildTerminalBinding({
            vscodeWindowId: registration.windowId,
            terminalRef: terminal.terminalRef,
            terminalPid: terminal.terminalPid,
            terminalCaptureState: terminal.captureState,
            terminalCaptureReason: terminal.captureReason,
        }));
        if (!reboundSession)
            continue;
        taskIdByTerminalRef.set(terminal.terminalRef, reboundSession.id);
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
            });
        }
    }
    if (didBindSession)
        (0, settings_1.saveSessions)(getSessionsStateToSave());
}
function findSessionForTerminalRegistration(registration, terminal) {
    const sessions = sessionManager?.getSessions() ?? [];
    const exactRef = sessions.find(session => session.terminalRef === terminal.terminalRef);
    if (exactRef)
        return exactRef;
    if (terminal.terminalPid !== undefined) {
        const exactPid = sessions.find(session => (session.terminalPid ?? getLegacyAttachedTerminalPid(session.id)) === terminal.terminalPid);
        if (exactPid)
            return exactPid;
    }
    const terminalPath = normalizePathForCompare(terminal.terminalCwd ?? '');
    if (!terminalPath)
        return null;
    return sessions.find(session => (!session.vscodeWindowId || session.vscodeWindowId === registration.windowId) &&
        normalizePathForCompare(session.cwd) === terminalPath) ?? null;
}
function bindSessionsToVsCodeWindow(registration) {
    if (!registration.sessionIds || registration.sessionIds.length === 0)
        return;
    let didBindSession = false;
    for (const sessionId of registration.sessionIds) {
        const previousSession = sessionManager?.getSession(sessionId);
        const reboundSession = sessionManager?.bindSessionToVsCodeWindow(sessionId, registration.windowId);
        if (!previousSession || !reboundSession || previousSession.vscodeWindowId === reboundSession.vscodeWindowId) {
            continue;
        }
        didBindSession = true;
        debugTerminalUpdate('session rebound to vscode window', {
            id: reboundSession.id,
            sessionName: reboundSession.name,
            vscodeWindowId: reboundSession.vscodeWindowId,
            previousVsCodeWindowId: previousSession.vscodeWindowId,
            workspaceFolder: registration.workspaceFolder,
            workspaceName: registration.workspaceName,
        });
    }
    if (didBindSession)
        (0, settings_1.saveSessions)(getSessionsStateToSave());
}
function isDeepLinkPath(parsedUrl, pathName, hostName) {
    return (parsedUrl.pathname === pathName ||
        (parsedUrl.hostname === hostName && (parsedUrl.pathname === '' || parsedUrl.pathname === '/')));
}
function applyTerminalUpdate(update) {
    const previousSession = sessionManager?.getSession(update.id) ?? null;
    const session = sessionManager?.updateTerminalState(update) ?? null;
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
    const previousSession = sessionManager?.getSession(event.id) ?? null;
    const sessionName = previousSession?.name ?? event.terminalName;
    const session = sessionManager?.updateTerminalEvent(event) ?? null;
    if (!session) {
        debugTerminalUpdate('terminal event could not be applied', terminalEventDebugDetails(event, sessionName));
        return false;
    }
    debugTerminalUpdate('terminal event applied', {
        ...terminalEventDebugDetails(event, session.name),
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
function markSessionRemoved(id) {
    removedSessionIds.add(id);
    pendingTerminalUpdates.delete(id);
    pendingTerminalEvents.delete(id);
}
function forgetRemovedSession(id) {
    removedSessionIds.delete(id);
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
function processDeepLink(url) {
    if (!sessionManager)
        return;
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
    }
    catch (error) {
        console.error('Failed to open deep link: invalid URL', getErrorMessage(error));
        return;
    }
    if (parsedUrl.protocol !== `${MULTITASKER_PROTOCOL}:`)
        return;
    const createPath = isDeepLinkPath(parsedUrl, MULTITASKER_CREATE_PATH, 'create');
    const terminalPath = isDeepLinkPath(parsedUrl, MULTITASKER_TERMINAL_PATH, 'terminal');
    if (!createPath && !terminalPath) {
        console.error(`Unsupported deep link path "${parsedUrl.pathname}"`);
        return;
    }
    const payloadParam = parsedUrl.searchParams.get('payload');
    if (!payloadParam) {
        console.error('Failed to open deep link: missing payload');
        return;
    }
    let parsedPayload;
    try {
        parsedPayload = parseDeepLinkPayload(payloadParam);
    }
    catch (error) {
        console.error('Failed to open deep link: invalid payload JSON', getErrorMessage(error));
        return;
    }
    if (terminalPath) {
        const event = parseTerminalEventRequest(parsedPayload);
        if (event) {
            handleTerminalEvent(event);
            return;
        }
        const update = parseTerminalUpdateRequest(parsedPayload);
        if (!update) {
            console.error('Failed to open deep link: invalid terminal event payload');
            return;
        }
        handleTerminalUpdate(update);
        return;
    }
    const request = parseCreateSessionRequest(parsedPayload);
    if (!request) {
        console.error('Failed to open deep link: invalid session payload');
        return;
    }
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
    debugTerminalUpdate('session created from deep link', {
        id: session.id,
        status: session.status,
        shellType: session.shellType,
        terminalRef: session.terminalRef,
        terminalPid: session.terminalPid,
        hasCommand: Boolean(session.cmd),
    });
    (0, settings_1.saveSessions)(getSessionsStateToSave());
    flushPendingTerminalUpdates(session.id);
    flushPendingTerminalEvents(session.id);
    if (!request.terminalRef)
        void openSessionInVsCode(session);
    if (mainWindow) {
        if (mainWindow.isMinimized())
            mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
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
function setupIpc() {
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
            void openSessionInVsCode(session);
        }
        return session;
    });
    electron_1.ipcMain.handle('session:remove', (_e, id) => {
        const session = sessionManager?.getSession(id);
        if (session?.status === 'detached' || session?.status === 'stopped' || session?.status === 'error') {
            markSessionRemoved(id);
            sessionManager?.removeSession(id);
        }
        else {
            if (session)
                queueDisconnectSessionCommand(session);
            sessionManager?.detachSession(id);
        }
        (0, settings_1.saveSessions)(getSessionsStateToSave());
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
    electron_1.ipcMain.handle('editor:open-vscode', async (_e, session) => {
        if (!isVsCodeSessionRequest(session)) {
            console.error('Failed to open VS Code: invalid session payload');
            return false;
        }
        if (session.shellType === 'ssh') {
            if (!session.sshCommand?.trim()) {
                console.error('Failed to open VS Code: missing SSH command');
                return false;
            }
        }
        else if (!session.cwd.trim()) {
            console.error('Failed to open VS Code: missing session path');
            return false;
        }
        const refreshedSession = sessionManager?.touchSession(session.id) ?? session;
        return openSessionInVsCode(refreshedSession);
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
    });
    electron_1.ipcMain.handle('manual-task:list', () => manualTasks.map(task => ({ ...task })));
    electron_1.ipcMain.handle('manual-task:add', (_event, text) => createManualTask(text));
    electron_1.ipcMain.handle('manual-task:remove', (_event, id) => {
        if (typeof id !== 'string' || !id.trim()) {
            console.error('Failed to remove manual task: missing task id');
            return false;
        }
        return removeManualTask(id.trim());
    });
    electron_1.ipcMain.handle('recurring-task:list', () => recurringTasks.map(cloneRecurringTask));
    electron_1.ipcMain.handle('recurring-task:add', (_event, text, time, daysOfWeek) => createRecurringTask(text, time, daysOfWeek));
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
        ...(s.vscodeWindowId ? { vscodeWindowId: s.vscodeWindowId } : {}),
        ...(s.terminalRef ? { terminalRef: s.terminalRef } : {}),
        ...(s.terminalPid !== undefined ? { terminalPid: s.terminalPid } : {}),
    }));
}
function restorePersistedSessions(settings) {
    const persistedSessions = (0, settings_1.loadSessions)();
    persistedSessions.forEach(sessionState => {
        const rawShellType = String(sessionState.shellType);
        const shellType = isShellType(rawShellType) ? rawShellType : settings.defaultShell;
        sessionManager?.createSession(sessionState.name, sessionState.cmd, sessionState.cwd, shellType, sessionState.id ?? '', sessionState.sshCommand ?? '', sessionState.vscodeWindowId ?? '', sessionState.terminalRef ?? '', sessionState.terminalPid);
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
    const settings = (0, settings_1.loadSettings)();
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
    sessionManager.on('sessionUpdate', (sessions) => {
        mainWindow?.webContents.send('session:list-update', sessions);
    });
    mainWindow.on('focus', () => {
        mainWindow?.flashFrame(false);
        sessionManager?.refreshGitChanges();
    });
    restorePersistedSessions(settings);
    restorePersistedManualTasks();
    restorePersistedRecurringTasks();
    restorePersistedSlackNotifications();
    startRecurringTaskScheduler();
    void mainWindow.loadFile(node_path_1.default.join(__dirname, '..', 'index.html'));
}
setupIpc();
const hasSingleInstanceLock = electron_1.app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', (_event, argv) => {
        const deepLink = getDeepLinkFromArgv(argv);
        if (deepLink)
            enqueueDeepLink(deepLink);
    });
}
electron_1.app.on('open-url', (event, url) => {
    event.preventDefault();
    enqueueDeepLink(url);
});
const startupDeepLink = getDeepLinkFromArgv(process.argv);
if (startupDeepLink)
    enqueueDeepLink(startupDeepLink);
void electron_1.app.whenReady().then(() => {
    if (process.defaultApp && process.argv[1]) {
        electron_1.app.setAsDefaultProtocolClient(MULTITASKER_PROTOCOL, process.execPath, [node_path_1.default.resolve(process.argv[1])]);
    }
    else {
        electron_1.app.setAsDefaultProtocolClient(MULTITASKER_PROTOCOL);
    }
    createWindow();
    startTerminalUpdateServer();
    startSlackSocketListener({ notifyIfMissingConfig: false });
    flushPendingDeepLinks();
    electron_1.app.on('activate', () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});
electron_1.app.on('before-quit', () => {
    stopRecurringTaskScheduler();
    stopSlackAuthFlow();
    stopSlackSocketListener();
    stopTerminalUpdateServer();
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        electron_1.app.quit();
    }
});
