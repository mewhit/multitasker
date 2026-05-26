"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const node_path_1 = __importDefault(require("node:path"));
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = require("node:crypto");
const node_url_1 = require("node:url");
const vscode = __importStar(require("vscode"));
const TERMINAL_EVENT_RETRY_INITIAL_MS = 1000;
const TERMINAL_EVENT_RETRY_MAX_MS = 10000;
const SHELL_INTEGRATION_COMMAND_TIMEOUT_MS = 3000;
const TERMINAL_DEBUG_OUTPUT_PREVIEW_LENGTH = 500;
const MAX_TERMINAL_OUTPUT_EVENT_CHARS = 16 * 1024;
const MULTITASKER_BASE_URL = 'http://127.0.0.1:39017';
const MULTITASKER_TERMINAL_EVENT_URL = `${MULTITASKER_BASE_URL}/terminal-event`;
const MULTITASKER_VSCODE_WINDOW_URL = `${MULTITASKER_BASE_URL}/vscode-window`;
const MULTITASKER_VSCODE_COMMAND_URL = `${MULTITASKER_BASE_URL}/vscode-command`;
const VSCODE_COMMAND_POLL_MIN_MS = 1000;
const VSCODE_COMMAND_LONG_POLL_NEXT_MS = 0;
const VSCODE_COMMAND_POLL_MAX_MS = 30000;
const DEBUG_CONFIGURATION_SECTION = 'multitasker';
const DEBUG_TERMINAL_STATUS_SETTING = 'debugTerminalStatus';
const DEBUG_LOG_DIRECTORY = 'debug-log';
const DEBUG_TERMINAL_STATUS_FILE = '.multitasker-terminal-debug.log';
const DEBUG_TERMINAL_STATUS_FILE_PREFIX = '.multitasker-terminal-debug';
const DEBUG_TERMINAL_STATUS_FILE_EXTENSION = '.log';
const DEBUG_TERMINAL_STATUS_FILE_LOGS_ENABLED = false;
const ATTACHED_TERMINAL_CAPTURE_REASON = 'Connected for focus; VS Code only exposes output from shell executions started after Multitasker attached.';
const WAITING_TERMINAL_CAPTURE_REASON = 'Waiting for the next shell execution to start live output capture.';
const CAPTURING_TERMINAL_CAPTURE_REASON = 'Live output capture is active for the current shell execution.';
const UNAVAILABLE_TERMINAL_CAPTURE_REASON = 'VS Code shell integration is unavailable, so live output cannot be captured for this command.';
const terminalByRef = new Map();
const terminalRefByTerminal = new Map();
const launchIdByTerminal = new Map();
const terminalProcessIdByTerminal = new Map();
const disconnectedTerminalRefs = new Set();
const primaryCommandByTerminal = new Map();
const primaryExecutionByTerminal = new Map();
const terminalCaptureStateByTerminal = new Map();
const terminalCaptureReasonByTerminal = new Map();
const latestTerminalEventAtByTerminalRef = new Map();
const terminalEventDeliveryByRef = new Map();
const executionIdByExecution = new WeakMap();
const consumedExecutions = new WeakSet();
const reportedDebugFileWriteFailures = new Set();
const connectedTerminalRefs = new Set();
const vscodeWindowId = (0, node_crypto_1.randomUUID)();
let terminalStatusOutputChannel;
let debugFallbackRoot;
let vscodeCommandPollTimer;
let vscodeCommandPollInFlight = false;
let vscodeCommandPollDelayMs = VSCODE_COMMAND_POLL_MIN_MS;
let vscodeEndpointReachable = true;
let vscodeEndpointFailureMessage = '';
let nextExecutionSequence = 0;
function activate(context) {
    debugFallbackRoot = context.globalStorageUri.fsPath;
    if (isTerminalStatusFileDebugEnabled())
        migrateLegacyDebugFiles();
    context.subscriptions.push(vscode.commands.registerCommand('multitasker.startSession', (payload) => startSessionCommand(payload)), vscode.commands.registerCommand('multitasker.attachTerminal', () => attachExistingTerminalCommand()), vscode.commands.registerCommand('multitasker.disconnectTerminal', () => disconnectTerminalCommand()), vscode.commands.registerCommand('multitasker.showTerminalStatusLogs', () => showTerminalStatusLogs()), vscode.window.registerUriHandler({ handleUri: uri => handleUri(uri) }), vscode.window.onDidCloseTerminal(terminal => closeTrackedTerminal(terminal)), vscode.window.onDidChangeActiveTerminal(terminal => acknowledgeTrackedTerminal(terminal)), vscode.window.onDidChangeWindowState(() => acknowledgeTrackedTerminal(vscode.window.activeTerminal)), vscode.window.onDidChangeTerminalState(terminal => acknowledgeInteractedTerminal(terminal)), vscode.window.onDidStartTerminalShellExecution(event => handleTerminalShellExecutionStarted(event)), vscode.window.onDidEndTerminalShellExecution(event => handleTerminalShellExecutionEnded(event)));
    startVsCodeCommandPolling(context);
    debugLog('extension activated');
}
function deactivate() {
    terminalEventDeliveryByRef.clear();
    latestTerminalEventAtByTerminalRef.clear();
    terminalByRef.clear();
    terminalRefByTerminal.clear();
    connectedTerminalRefs.clear();
    launchIdByTerminal.clear();
    terminalProcessIdByTerminal.clear();
    disconnectedTerminalRefs.clear();
    primaryCommandByTerminal.clear();
    primaryExecutionByTerminal.clear();
    terminalCaptureStateByTerminal.clear();
    terminalCaptureReasonByTerminal.clear();
    reportedDebugFileWriteFailures.clear();
    if (vscodeCommandPollTimer) {
        clearTimeout(vscodeCommandPollTimer);
        vscodeCommandPollTimer = undefined;
    }
    vscodeCommandPollInFlight = false;
    vscodeCommandPollDelayMs = VSCODE_COMMAND_POLL_MIN_MS;
    vscodeEndpointReachable = true;
    vscodeEndpointFailureMessage = '';
    debugFallbackRoot = undefined;
    terminalStatusOutputChannel?.dispose();
    terminalStatusOutputChannel = undefined;
}
function showTerminalStatusLogs() {
    const channel = getTerminalStatusOutputChannel();
    const debugFilePath = getDebugFilePath();
    const activeTerminal = vscode.window.activeTerminal;
    const activeTerminalDebugFilePath = activeTerminal ? getTerminalDebugFilePath(activeTerminal) : null;
    if (!isTerminalStatusFileDebugEnabled()) {
        channel.appendLine(`[${new Date().toISOString()}] Terminal status debug file logging is disabled.`);
    }
    channel.appendLine(`[${new Date().toISOString()}] Terminal aggregate debug file: ${debugFilePath ?? '(no workspace folder)'}`);
    if (activeTerminal) {
        channel.appendLine(`[${new Date().toISOString()}] Active terminal debug file: ${activeTerminalDebugFilePath ?? '(no workspace folder)'}`);
    }
    if (!isTerminalStatusDebugEnabled()) {
        channel.appendLine(`[${new Date().toISOString()}] Terminal status debug logging is disabled. ` +
            `Enable "${DEBUG_CONFIGURATION_SECTION}.${DEBUG_TERMINAL_STATUS_SETTING}" or set MULTITASKER_DEBUG_TERMINAL=1.`);
    }
    channel.show(true);
}
function startVsCodeCommandPolling(context) {
    scheduleVsCodeCommandPoll(0);
    context.subscriptions.push({
        dispose: () => {
            if (!vscodeCommandPollTimer)
                return;
            clearTimeout(vscodeCommandPollTimer);
            vscodeCommandPollTimer = undefined;
        },
    });
}
function scheduleVsCodeCommandPoll(delayMs = vscodeCommandPollDelayMs) {
    if (vscodeCommandPollTimer)
        clearTimeout(vscodeCommandPollTimer);
    vscodeCommandPollTimer = setTimeout(() => {
        vscodeCommandPollTimer = undefined;
        void pollVsCodeCommands();
    }, delayMs);
}
async function registerVsCodeWindow() {
    try {
        const registration = await buildVsCodeWindowRegistration();
        const response = await fetch(MULTITASKER_VSCODE_WINDOW_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(registration),
        });
        if (!response.ok) {
            recordVsCodeEndpointFailure('vscode window registration rejected', `HTTP ${response.status}`);
            return false;
        }
        return true;
    }
    catch (error) {
        recordVsCodeEndpointFailure('vscode window registration failed', getErrorMessage(error));
        return false;
    }
}
async function buildVsCodeWindowRegistration() {
    return {
        windowId: vscodeWindowId,
        workspaceFolder: getDefaultCwd(),
        workspaceName: vscode.workspace.name ?? '',
        pid: process.pid,
        terminals: await Promise.all(vscode.window.terminals.map(terminal => buildTerminalRegistration(terminal))),
    };
}
async function buildTerminalRegistration(terminal) {
    const terminalPid = await getTerminalProcessId(terminal);
    return {
        terminalRef: getTerminalRef(terminal),
        terminalName: terminal.name,
        terminalCwd: getTerminalCwd(terminal),
        shellType: inferTerminalShellType(terminal),
        isActive: vscode.window.activeTerminal === terminal,
        ...(terminalPid !== undefined ? { terminalPid } : {}),
        ...getTerminalCaptureDetails(terminal),
    };
}
async function pollVsCodeCommands() {
    if (vscodeCommandPollInFlight) {
        scheduleVsCodeCommandPoll();
        return;
    }
    vscodeCommandPollInFlight = true;
    let reachable = false;
    let reachablePollDelayMs = VSCODE_COMMAND_POLL_MIN_MS;
    try {
        if (!(await registerVsCodeWindow()))
            return;
        const url = new URL(MULTITASKER_VSCODE_COMMAND_URL);
        url.searchParams.set('windowId', vscodeWindowId);
        url.searchParams.set('workspaceFolder', getDefaultCwd());
        url.searchParams.set('workspaceName', vscode.workspace.name ?? '');
        url.searchParams.set('pid', String(process.pid));
        const response = await fetch(url);
        if (!response.ok) {
            recordVsCodeEndpointFailure('vscode command poll rejected', `HTTP ${response.status}`);
            return;
        }
        reachable = true;
        recordVsCodeEndpointReachable();
        const payload = await response.json();
        reachablePollDelayMs = supportsVsCodeCommandLongPolling(payload)
            ? VSCODE_COMMAND_LONG_POLL_NEXT_MS
            : VSCODE_COMMAND_POLL_MIN_MS;
        const commands = parseVsCodeCommands(payload);
        for (const command of commands) {
            handleVsCodeCommand(command);
        }
    }
    catch (error) {
        recordVsCodeEndpointFailure('vscode command poll failed', getErrorMessage(error));
    }
    finally {
        vscodeCommandPollInFlight = false;
        vscodeCommandPollDelayMs = reachable
            ? reachablePollDelayMs
            : Math.min(vscodeCommandPollDelayMs * 2, VSCODE_COMMAND_POLL_MAX_MS);
        scheduleVsCodeCommandPoll();
    }
}
function recordVsCodeEndpointFailure(message, error) {
    const failureMessage = `${message}: ${error}`;
    if (!vscodeEndpointReachable && vscodeEndpointFailureMessage === failureMessage)
        return;
    vscodeEndpointReachable = false;
    vscodeEndpointFailureMessage = failureMessage;
    debugLog(message, {
        windowId: vscodeWindowId,
        error,
        retryDelayMs: vscodeCommandPollDelayMs,
    });
}
function recordVsCodeEndpointReachable() {
    if (!vscodeEndpointReachable) {
        debugLog('vscode command endpoint restored', {
            windowId: vscodeWindowId,
        });
    }
    vscodeEndpointReachable = true;
    vscodeEndpointFailureMessage = '';
}
function parseVsCodeCommands(payload) {
    if (!isRecord(payload))
        return [];
    const rawCommands = payload['commands'];
    if (!Array.isArray(rawCommands))
        return [];
    return rawCommands
        .map(parseVsCodeCommand)
        .filter((command) => command !== null);
}
function supportsVsCodeCommandLongPolling(payload) {
    return isRecord(payload) && payload['longPoll'] === true;
}
function parseVsCodeCommand(payload) {
    if (!isRecord(payload))
        return null;
    const id = readString(payload, 'id').trim();
    const type = readString(payload, 'type').trim();
    const terminalRef = readString(payload, 'terminalRef').trim();
    if (!id || !terminalRef)
        return null;
    if (type === 'focus-terminal' || type === 'disconnect-session')
        return { id, type, terminalRef };
    return null;
}
function handleVsCodeCommand(command) {
    switch (command.type) {
        case 'focus-terminal':
            focusTerminalByRef(command.terminalRef);
            return;
        case 'disconnect-session':
            disconnectTerminalByRef(command.terminalRef);
            return;
        default:
            assertNever(command);
    }
}
function focusTerminalByRef(terminalRef) {
    const terminal = terminalByRef.get(terminalRef);
    if (!terminal) {
        debugLog('focus terminal command ignored; terminal not found', {
            terminalRef,
            windowId: vscodeWindowId,
        });
        return;
    }
    connectedTerminalRefs.add(terminalRef);
    disconnectedTerminalRefs.delete(terminalRef);
    terminal.show(false);
    sendTerminalEvent(terminal, 'terminal_visible', {
        terminalName: terminal.name,
        ...getTerminalCaptureDetails(terminal),
    });
    debugLog('focused session terminal', {
        terminalRef,
        windowId: vscodeWindowId,
        terminalName: terminal.name,
    }, terminal);
}
function disconnectTerminalByRef(terminalRef) {
    const terminal = terminalByRef.get(terminalRef);
    connectedTerminalRefs.delete(terminalRef);
    disconnectedTerminalRefs.add(terminalRef);
    terminalEventDeliveryByRef.delete(terminalRef);
    latestTerminalEventAtByTerminalRef.delete(terminalRef);
    if (!terminal) {
        debugLog('disconnect session command ignored; terminal not found', {
            terminalRef,
            windowId: vscodeWindowId,
        });
        return;
    }
    debugLog('disconnected session terminal', {
        terminalRef,
        windowId: vscodeWindowId,
        terminalName: terminal.name,
    }, terminal);
    forgetTerminal(terminal);
}
async function disconnectTerminalCommand() {
    const terminal = await pickConnectedTerminal('Disconnect terminal from Multitasker');
    if (!terminal)
        return;
    const terminalRef = terminalRefByTerminal.get(terminal);
    if (!terminalRef) {
        vscode.window.showWarningMessage(`Terminal "${terminal.name}" is not connected to Multitasker.`);
        return;
    }
    sendTerminalEvent(terminal, 'terminal_disconnected', { terminalName: terminal.name });
    debugLog('user disconnected terminal', {
        terminalRef,
        windowId: vscodeWindowId,
        terminalName: terminal.name,
    }, terminal);
    forgetTerminal(terminal);
    vscode.window.showInformationMessage(`Disconnected terminal "${terminal.name}" from Multitasker.`);
}
function debugLog(message, details = {}, terminal) {
    if (!isTerminalStatusDebugEnabled())
        return;
    const serializedDetails = Object.entries(details)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${formatDebugValue(value)}`)
        .join(' ');
    const line = `[${new Date().toISOString()}] ${message}${serializedDetails ? ` ${serializedDetails}` : ''}`;
    getTerminalStatusOutputChannel().appendLine(line);
    appendDebugFile(`${line}\n`, terminal);
}
function isTerminalStatusDebugEnabled() {
    const envValue = process.env['MULTITASKER_DEBUG_TERMINAL']?.toLowerCase();
    return (envValue === '1' ||
        envValue === 'true' ||
        vscode.workspace
            .getConfiguration(DEBUG_CONFIGURATION_SECTION)
            .get(DEBUG_TERMINAL_STATUS_SETTING, false));
}
function getTerminalStatusOutputChannel() {
    terminalStatusOutputChannel ??= vscode.window.createOutputChannel('Multitasker Terminal Status');
    return terminalStatusOutputChannel;
}
function formatDebugValue(value) {
    if (typeof value === 'string')
        return JSON.stringify(value);
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return JSON.stringify(value);
}
function appendDebugFile(content, terminal) {
    if (!isTerminalStatusDebugEnabled() || !isTerminalStatusFileDebugEnabled())
        return;
    const debugFilePaths = getDebugFilePaths(terminal);
    if (debugFilePaths.length === 0) {
        reportDebugFileWriteFailure('No workspace folder is available for the terminal debug file.');
        return;
    }
    for (const debugFilePath of debugFilePaths) {
        try {
            node_fs_1.default.mkdirSync(node_path_1.default.dirname(debugFilePath), { recursive: true });
            node_fs_1.default.appendFileSync(debugFilePath, content, 'utf8');
        }
        catch (error) {
            reportDebugFileWriteFailure(`Could not write terminal debug file "${debugFilePath}": ${getErrorMessage(error)}`);
        }
    }
}
function appendTerminalOutputDebugChunk(terminal, execution, output) {
    if (!isTerminalStatusDebugEnabled() || !isTerminalStatusFileDebugEnabled())
        return;
    const terminalRef = terminalRefByTerminal.get(terminal);
    const timestamp = new Date().toISOString();
    appendDebugFile(`\n[${timestamp}] terminal-output-begin terminalRef=${formatDebugValue(terminalRef ?? '')} ` +
        `terminal=${formatDebugValue(terminal.name)} command=${formatDebugValue(execution.commandLine.value)}\n`, terminal);
    appendDebugFile(output, terminal);
    appendDebugFile(`\n[${timestamp}] terminal-output-end terminalRef=${formatDebugValue(terminalRef ?? '')}\n`, terminal);
}
function isTerminalStatusFileDebugEnabled() {
    return DEBUG_TERMINAL_STATUS_FILE_LOGS_ENABLED;
}
function getDebugFilePath(terminal) {
    const root = getDebugFileRoot(terminal);
    return root ? node_path_1.default.join(root, DEBUG_TERMINAL_STATUS_FILE) : null;
}
function getDebugFilePaths(terminal) {
    const aggregateDebugFilePath = getDebugFilePath(terminal);
    const debugFilePaths = aggregateDebugFilePath ? [aggregateDebugFilePath] : [];
    if (terminal) {
        const terminalDebugFilePath = getTerminalDebugFilePath(terminal);
        if (terminalDebugFilePath && terminalDebugFilePath !== aggregateDebugFilePath) {
            debugFilePaths.push(terminalDebugFilePath);
        }
    }
    return debugFilePaths;
}
function getTerminalDebugFilePath(terminal) {
    const root = getDebugFileRoot(terminal);
    return root ? node_path_1.default.join(root, getTerminalDebugFileName(terminal)) : null;
}
function getTerminalDebugFileName(terminal) {
    const terminalRef = terminalRefByTerminal.get(terminal) ?? '';
    const hashInput = `${terminalRef}:${terminal.name}`;
    const hash = (0, node_crypto_1.createHash)('sha256').update(hashInput).digest('hex').slice(0, 8);
    const label = sanitizeDebugFilePart(terminal.name || terminalRef).slice(0, 48) || 'terminal';
    return `${DEBUG_TERMINAL_STATUS_FILE_PREFIX}-${label}-${hash}${DEBUG_TERMINAL_STATUS_FILE_EXTENSION}`;
}
function migrateLegacyDebugFiles() {
    const baseRoot = getDebugFileBaseRoot();
    const debugRoot = getDebugFileRoot();
    let entries;
    try {
        entries = node_fs_1.default.readdirSync(baseRoot, { withFileTypes: true });
    }
    catch (error) {
        reportDebugFileWriteFailure(`Could not inspect legacy terminal debug files in "${baseRoot}": ${getErrorMessage(error)}`);
        return;
    }
    const legacyDebugFileNames = entries
        .filter(entry => entry.isFile() && isTerminalDebugFileName(entry.name))
        .map(entry => entry.name);
    if (legacyDebugFileNames.length === 0)
        return;
    try {
        node_fs_1.default.mkdirSync(debugRoot, { recursive: true });
    }
    catch (error) {
        reportDebugFileWriteFailure(`Could not create terminal debug directory "${debugRoot}": ${getErrorMessage(error)}`);
        return;
    }
    for (const fileName of legacyDebugFileNames) {
        const sourcePath = node_path_1.default.join(baseRoot, fileName);
        const destinationPath = node_path_1.default.join(debugRoot, fileName);
        try {
            if (node_fs_1.default.existsSync(destinationPath)) {
                node_fs_1.default.appendFileSync(destinationPath, node_fs_1.default.readFileSync(sourcePath));
                node_fs_1.default.unlinkSync(sourcePath);
            }
            else {
                node_fs_1.default.renameSync(sourcePath, destinationPath);
            }
        }
        catch (error) {
            reportDebugFileWriteFailure(`Could not move legacy terminal debug file "${sourcePath}" to "${destinationPath}": ${getErrorMessage(error)}`);
        }
    }
}
function isTerminalDebugFileName(fileName) {
    return (fileName === DEBUG_TERMINAL_STATUS_FILE ||
        (fileName.startsWith(`${DEBUG_TERMINAL_STATUS_FILE_PREFIX}-`) &&
            fileName.endsWith(DEBUG_TERMINAL_STATUS_FILE_EXTENSION)));
}
function sanitizeDebugFilePart(value) {
    return value
        .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
function getDebugFileRoot(terminal) {
    return node_path_1.default.join(getDebugFileBaseRoot(terminal), DEBUG_LOG_DIRECTORY);
}
function getDebugFileBaseRoot(terminal) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file');
    if (workspaceFolder)
        return workspaceFolder.uri.fsPath;
    if (terminal) {
        const terminalCwd = getTerminalCwd(terminal);
        if (isUsableDebugRoot(terminalCwd))
            return terminalCwd;
    }
    const defaultCwd = getDefaultCwd();
    if (isUsableDebugRoot(defaultCwd))
        return defaultCwd;
    return getFallbackDebugRoot();
}
function isUsableDebugRoot(candidate) {
    const normalized = candidate.trim();
    if (!normalized || !node_path_1.default.isAbsolute(normalized))
        return false;
    const resolved = node_path_1.default.resolve(normalized);
    return resolved !== node_path_1.default.parse(resolved).root;
}
function getFallbackDebugRoot() {
    return debugFallbackRoot ?? node_path_1.default.join(node_os_1.default.tmpdir(), 'multitasker-terminal-debug');
}
function reportDebugFileWriteFailure(message) {
    if (reportedDebugFileWriteFailures.has(message))
        return;
    reportedDebugFileWriteFailures.add(message);
    getTerminalStatusOutputChannel().appendLine(`[${new Date().toISOString()}] ${message}`);
    console.warn(message);
}
async function startSessionCommand(payload) {
    if (payload === undefined) {
        const promptedLaunch = await promptForSession();
        if (!promptedLaunch)
            return;
        const terminal = openSessionTerminal(promptedLaunch);
        await createSessionInMultitasker(promptedLaunch, terminal);
        return;
    }
    const launch = parseSessionPayload(payload);
    if (!launch)
        return;
    openSessionTerminal(launch);
}
async function createSessionInMultitasker(launch, terminal) {
    const terminalPid = await getTerminalProcessId(terminal);
    const payload = {
        name: launch.name,
        cwd: launch.cwd,
        command: launch.command,
        shellType: launch.shellType,
        sshCommand: launch.sshCommand,
        windowId: vscodeWindowId,
        terminalRef: getTerminalRef(terminal),
        terminalName: terminal.name,
        terminalCwd: getTerminalCwd(terminal),
        ...(terminalPid !== undefined ? { terminalPid } : {}),
    };
    const uri = vscode.Uri.parse(`multitasker://create?payload=${encodeURIComponent(JSON.stringify(payload))}`, true);
    const opened = await vscode.env.openExternal(uri);
    if (!opened) {
        vscode.window.showWarningMessage('Could not reach the Multitasker app. Open Multitasker and try again.');
        return false;
    }
    return true;
}
async function attachExistingTerminalCommand() {
    const terminal = await pickExistingTerminal();
    if (!terminal)
        return;
    if (isTerminalConnected(terminal)) {
        terminal.show();
        sendTerminalEvent(terminal, 'terminal_visible', {
            terminalName: terminal.name,
            ...getTerminalCaptureDetails(terminal),
        });
        vscode.window.showInformationMessage(`Terminal "${terminal.name}" is connected for focus. Output appears after a new shell command starts.`);
        return;
    }
    const session = await buildAttachedTerminalSession(terminal);
    if (!session)
        return;
    attachTerminalToSession(terminal, session);
    terminal.show();
    const opened = await createSessionInMultitasker(session, terminal);
    sendTerminalEvent(terminal, 'terminal_attached', {
        terminalName: terminal.name,
        ...getTerminalCaptureDetails(terminal),
    });
    if (opened) {
        vscode.window.showInformationMessage(`Connected terminal "${terminal.name}" for focus. Output capture starts with the next shell command.`);
    }
}
async function pickExistingTerminal() {
    const terminals = vscode.window.terminals;
    if (terminals.length === 0) {
        vscode.window.showWarningMessage('No open terminal to connect to Multitasker.');
        return undefined;
    }
    const activeTerminal = vscode.window.activeTerminal;
    const items = terminals.map((terminal, index) => {
        const isConnectedTerminal = isTerminalConnected(terminal);
        const details = [
            terminal === activeTerminal ? 'active' : '',
            isConnectedTerminal ? 'focus connected' : '',
        ].filter(Boolean);
        return {
            label: terminal.name || `Terminal ${index + 1}`,
            description: details.join(', '),
            detail: getTerminalCwd(terminal),
            terminal,
        };
    });
    const picked = await vscode.window.showQuickPick(items, {
        title: 'Connect existing terminal to Multitasker for focus',
        placeHolder: 'Select the terminal to focus and capture from the next shell command',
    });
    return picked?.terminal;
}
async function pickConnectedTerminal(title) {
    const connectedTerminals = vscode.window.terminals.filter(isTerminalConnected);
    if (connectedTerminals.length === 0) {
        vscode.window.showWarningMessage('No terminal is connected to Multitasker.');
        return undefined;
    }
    const activeTerminal = vscode.window.activeTerminal;
    if (connectedTerminals.length === 1)
        return connectedTerminals[0];
    if (activeTerminal && isTerminalConnected(activeTerminal))
        return activeTerminal;
    const items = connectedTerminals.map((terminal, index) => ({
        label: terminal.name || `Terminal ${index + 1}`,
        description: terminal === activeTerminal ? 'active' : '',
        detail: getTerminalCwd(terminal),
        terminal,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        title,
        placeHolder: 'Select the terminal to disconnect',
    });
    return picked?.terminal;
}
async function buildAttachedTerminalSession(terminal) {
    const inferredCwd = getTerminalCwd(terminal).trim();
    let cwd = inferredCwd || getDefaultCwd().trim();
    if (!cwd) {
        const enteredCwd = await vscode.window.showInputBox({
            title: 'Multitasker terminal path',
            prompt: 'Working directory for this existing terminal',
            value: '',
        });
        if (enteredCwd === undefined)
            return undefined;
        cwd = enteredCwd.trim();
    }
    if (!cwd) {
        vscode.window.showErrorMessage('Multitasker needs a working directory to connect an existing terminal.');
        return undefined;
    }
    const defaultName = terminal.name.trim() || node_path_1.default.basename(cwd) || 'Terminal';
    const name = await vscode.window.showInputBox({
        title: 'Multitasker session name',
        prompt: 'Name to show in Multitasker for this terminal',
        value: defaultName,
    });
    if (name === undefined)
        return undefined;
    const processId = await terminal.processId;
    if (processId !== undefined)
        terminalProcessIdByTerminal.set(terminal, processId);
    return {
        launchId: `attached:${getTerminalRef(terminal)}:${Date.now()}`,
        name: name.trim() || defaultName,
        cwd,
        command: '',
        shellType: inferTerminalShellType(terminal),
        sshCommand: '',
    };
}
async function handleUri(uri) {
    debugLog('start URI received', {
        path: uri.path,
        workspaceFolder: getDefaultCwd(),
        activeTerminal: vscode.window.activeTerminal?.name,
    });
    if (uri.path !== '/start') {
        vscode.window.showWarningMessage(`Multitasker does not support URI path "${uri.path}".`);
        return;
    }
    const payloadParam = new node_url_1.URLSearchParams(uri.query).get('payload');
    if (!payloadParam) {
        vscode.window.showErrorMessage('Multitasker URI is missing its session payload.');
        return;
    }
    let payload;
    try {
        payload = JSON.parse(payloadParam);
    }
    catch (error) {
        vscode.window.showErrorMessage(`Multitasker URI payload is invalid JSON: ${getErrorMessage(error)}`);
        return;
    }
    const session = parseSessionPayload(payload);
    if (!session)
        return;
    debugLog('start URI parsed', {
        launchId: session.launchId,
        name: session.name,
        cwd: session.cwd,
        shellType: session.shellType,
        hasCommand: session.command.length > 0,
        hasSshCommand: session.sshCommand.length > 0,
        workspaceFolder: getDefaultCwd(),
    });
    openSessionTerminal(session);
}
async function promptForSession() {
    const selectedShellType = await vscode.window.showQuickPick(['powershell', 'bash', 'ssh'], {
        title: 'Multitasker terminal type',
        placeHolder: 'Select a local shell or SSH',
    });
    if (selectedShellType !== 'powershell' && selectedShellType !== 'bash' && selectedShellType !== 'ssh') {
        return undefined;
    }
    if (selectedShellType === 'ssh') {
        const sshCommand = await vscode.window.showInputBox({
            title: 'Multitasker SSH command',
            prompt: 'SSH command to run in the VS Code terminal',
            value: 'ssh ',
        });
        if (sshCommand === undefined)
            return undefined;
        const trimmedSshCommand = sshCommand.trim();
        if (!trimmedSshCommand) {
            vscode.window.showErrorMessage('Multitasker needs an SSH command to start an SSH session terminal.');
            return undefined;
        }
        const remoteCwd = await vscode.window.showInputBox({
            title: 'Multitasker remote project path',
            prompt: 'Optional remote directory to cd into before starting the command',
            value: '',
        });
        if (remoteCwd === undefined)
            return undefined;
        const command = await vscode.window.showInputBox({
            title: 'Multitasker remote command',
            prompt: 'Optional command to run after connecting, such as codex',
            value: '',
        });
        if (command === undefined)
            return undefined;
        const trimmedCwd = remoteCwd.trim();
        const name = node_path_1.default.basename(trimmedCwd) || trimmedSshCommand;
        return {
            launchId: `manual:ssh:${(0, node_crypto_1.randomUUID)()}`,
            name,
            cwd: trimmedCwd,
            command: command.trim(),
            shellType: 'ssh',
            sshCommand: trimmedSshCommand,
        };
    }
    const workspaceCwd = getDefaultCwd().trim();
    let trimmedCwd = workspaceCwd;
    if (!trimmedCwd) {
        const cwd = await vscode.window.showInputBox({
            title: 'Multitasker session path',
            prompt: 'Working directory for the VS Code terminal',
            value: '',
        });
        if (cwd === undefined)
            return undefined;
        trimmedCwd = cwd.trim();
    }
    if (!trimmedCwd) {
        vscode.window.showErrorMessage('Multitasker needs a working directory to start a session terminal.');
        return undefined;
    }
    const name = node_path_1.default.basename(trimmedCwd) || 'Session';
    return {
        launchId: `manual:${(0, node_crypto_1.randomUUID)()}`,
        name,
        cwd: trimmedCwd,
        command: '',
        shellType: selectedShellType,
        sshCommand: '',
    };
}
function openSessionTerminal(launch) {
    const terminalOptions = {
        name: getTerminalName(launch),
    };
    if (launch.shellType === 'ssh') {
        terminalOptions.shellPath = getSshLocalShellPath();
    }
    else {
        terminalOptions.cwd = launch.cwd;
        terminalOptions.shellPath = getShellPath(launch.shellType);
    }
    const terminal = vscode.window.createTerminal(terminalOptions);
    const terminalRef = markTerminalConnected(terminal);
    launchIdByTerminal.set(terminal, launch.launchId);
    void getTerminalProcessId(terminal);
    const launchCommand = getSessionLaunchCommand(launch);
    if (launchCommand)
        primaryCommandByTerminal.set(terminal, launchCommand);
    setTerminalCaptureState(terminal, 'waiting_for_execution', WAITING_TERMINAL_CAPTURE_REASON, false);
    debugLog('opened session terminal', {
        terminalRef,
        launchId: launch.launchId,
        name: launch.name,
        cwd: launch.cwd,
        shellType: launch.shellType,
        hasLaunchCommand: launchCommand.length > 0,
    }, terminal);
    terminal.show();
    sendTerminalEvent(terminal, 'terminal_opened', {
        commandLine: launchCommand,
        hasLaunchCommand: launchCommand.length > 0,
        terminalName: terminal.name,
        ...getTerminalCaptureDetails(terminal),
    });
    if (launchCommand) {
        runSessionCommand(terminal, launchCommand);
    }
    return terminal;
}
function attachTerminalToSession(terminal, launch) {
    const terminalRef = markTerminalConnected(terminal);
    launchIdByTerminal.set(terminal, launch.launchId);
    void getTerminalProcessId(terminal);
    primaryCommandByTerminal.delete(terminal);
    primaryExecutionByTerminal.delete(terminal);
    setTerminalCaptureState(terminal, 'waiting_for_execution', ATTACHED_TERMINAL_CAPTURE_REASON, false);
    debugLog('attached existing terminal', {
        terminalRef,
        launchId: launch.launchId,
        name: launch.name,
        cwd: launch.cwd,
        shellType: launch.shellType,
        outputCapture: 'starts with the next shell execution; already-running output is not exposed by VS Code',
    }, terminal);
}
function setTerminalCaptureState(terminal, captureState, captureReason, notify = true) {
    const previousState = terminalCaptureStateByTerminal.get(terminal);
    const previousReason = terminalCaptureReasonByTerminal.get(terminal);
    terminalCaptureStateByTerminal.set(terminal, captureState);
    terminalCaptureReasonByTerminal.set(terminal, captureReason);
    if (!notify || (previousState === captureState && previousReason === captureReason))
        return;
    sendTerminalEvent(terminal, 'terminal_capture_state', {
        terminalName: terminal.name,
        captureState,
        captureReason,
    });
}
function getTerminalCaptureDetails(terminal) {
    const captureState = terminalCaptureStateByTerminal.get(terminal);
    const captureReason = terminalCaptureReasonByTerminal.get(terminal);
    return {
        ...(captureState ? { captureState } : {}),
        ...(captureReason ? { captureReason } : {}),
    };
}
function getTerminalRef(terminal) {
    const existingRef = terminalRefByTerminal.get(terminal);
    if (existingRef)
        return existingRef;
    const terminalRef = `terminal:${(0, node_crypto_1.randomUUID)()}`;
    terminalRefByTerminal.set(terminal, terminalRef);
    terminalByRef.set(terminalRef, terminal);
    void getTerminalProcessId(terminal);
    return terminalRef;
}
function markTerminalConnected(terminal) {
    const terminalRef = getTerminalRef(terminal);
    connectedTerminalRefs.add(terminalRef);
    disconnectedTerminalRefs.delete(terminalRef);
    return terminalRef;
}
function isTerminalConnected(terminal) {
    const terminalRef = terminalRefByTerminal.get(terminal);
    return Boolean(terminalRef && connectedTerminalRefs.has(terminalRef) && !disconnectedTerminalRefs.has(terminalRef));
}
async function getTerminalProcessId(terminal) {
    const cachedPid = terminalProcessIdByTerminal.get(terminal);
    if (cachedPid !== undefined)
        return cachedPid;
    try {
        const terminalPid = await terminal.processId;
        if (terminalPid !== undefined)
            terminalProcessIdByTerminal.set(terminal, terminalPid);
        return terminalPid;
    }
    catch (error) {
        debugLog('terminal process id unavailable', {
            terminalRef: terminalRefByTerminal.get(terminal),
            terminalName: terminal.name,
            error: getErrorMessage(error),
        }, terminal);
        return undefined;
    }
}
function runSessionCommand(terminal, command) {
    const runWithShellIntegration = (shellIntegration) => {
        const execution = shellIntegration.executeCommand(command);
        primaryExecutionByTerminal.set(terminal, execution);
    };
    if (terminal.shellIntegration) {
        runWithShellIntegration(terminal.shellIntegration);
        return;
    }
    let didRun = false;
    let disposable;
    let fallbackTimer;
    const runOnce = (shellIntegration) => {
        if (didRun)
            return;
        didRun = true;
        if (fallbackTimer)
            clearTimeout(fallbackTimer);
        disposable?.dispose();
        if (shellIntegration) {
            runWithShellIntegration(shellIntegration);
            return;
        }
        debugLog('shell integration unavailable; launch command output capture may be unavailable', {
            terminalRef: terminalRefByTerminal.get(terminal),
            command,
        }, terminal);
        setTerminalCaptureState(terminal, 'unavailable', UNAVAILABLE_TERMINAL_CAPTURE_REASON);
        terminal.sendText(command, true);
    };
    disposable = vscode.window.onDidChangeTerminalShellIntegration(event => {
        if (event.terminal === terminal)
            runOnce(event.shellIntegration);
    });
    fallbackTimer = setTimeout(() => runOnce(), SHELL_INTEGRATION_COMMAND_TIMEOUT_MS);
}
function handleTerminalShellExecutionStarted(event) {
    if (!isTerminalConnected(event.terminal))
        return;
    const terminalRef = getTerminalRef(event.terminal);
    setTerminalCaptureState(event.terminal, 'capturing', CAPTURING_TERMINAL_CAPTURE_REASON, false);
    const primaryCommand = primaryCommandByTerminal.get(event.terminal);
    const isPrimaryExecution = Boolean(primaryCommand && commandsMatch(event.execution.commandLine.value, primaryCommand));
    const executionId = getExecutionId(event.execution);
    if (isPrimaryExecution) {
        primaryExecutionByTerminal.set(event.terminal, event.execution);
    }
    sendTerminalEvent(event.terminal, 'shell_execution_started', {
        commandLine: event.execution.commandLine.value,
        executionId,
        primary: isPrimaryExecution,
        ...getTerminalCaptureDetails(event.terminal),
    });
    debugLog('terminal shell execution started', {
        terminalRef,
        command: event.execution.commandLine.value,
        executionId,
        primary: isPrimaryExecution,
    }, event.terminal);
    void consumeTerminalExecutionOutput(event.terminal, event.execution);
}
async function consumeTerminalExecutionOutput(terminal, execution) {
    if (consumedExecutions.has(execution))
        return;
    consumedExecutions.add(execution);
    try {
        for await (const data of execution.read()) {
            if (data.length > 0) {
                appendTerminalOutputDebugChunk(terminal, execution, data);
                reportTerminalOutput(terminal, execution, data);
            }
        }
    }
    catch (error) {
        setTerminalCaptureState(terminal, 'unavailable', `Terminal output read failed: ${getErrorMessage(error)}`);
        debugLog('terminal output read failed', {
            terminalRef: terminalRefByTerminal.get(terminal),
            error: getErrorMessage(error),
        }, terminal);
        console.error(`Multitasker could not read terminal output: ${getErrorMessage(error)}`);
    }
}
function handleTerminalShellExecutionEnded(event) {
    if (!isTerminalConnected(event.terminal))
        return;
    getTerminalRef(event.terminal);
    setTerminalCaptureState(event.terminal, 'waiting_for_execution', WAITING_TERMINAL_CAPTURE_REASON, false);
    const primaryExecution = primaryExecutionByTerminal.get(event.terminal);
    if (primaryExecution === event.execution) {
        const details = {
            commandLine: event.execution.commandLine.value,
            executionId: getExecutionId(event.execution),
            primary: true,
            ...getTerminalCaptureDetails(event.terminal),
        };
        if (event.exitCode !== undefined)
            details.exitCode = event.exitCode;
        sendTerminalEvent(event.terminal, 'shell_execution_ended', details);
        forgetTerminal(event.terminal);
        return;
    }
    const details = {
        commandLine: event.execution.commandLine.value,
        executionId: getExecutionId(event.execution),
        primary: false,
        ...getTerminalCaptureDetails(event.terminal),
    };
    if (event.exitCode !== undefined)
        details.exitCode = event.exitCode;
    sendTerminalEvent(event.terminal, 'shell_execution_ended', details);
}
function reportTerminalOutput(terminal, execution, output) {
    for (const outputChunk of splitTerminalOutput(output)) {
        sendTerminalEvent(terminal, 'terminal_output', {
            commandLine: execution.commandLine.value,
            executionId: getExecutionId(execution),
            output: outputChunk,
            ...getTerminalCaptureDetails(terminal),
        }, false);
    }
}
function acknowledgeTrackedTerminal(terminal) {
    if (!terminal || !isTerminalConnected(terminal) || !isTerminalVisibleToUser(terminal))
        return;
    sendTerminalEvent(terminal, 'terminal_visible', {
        terminalName: terminal.name,
        ...getTerminalCaptureDetails(terminal),
    });
}
function acknowledgeInteractedTerminal(terminal) {
    if (!isTerminalConnected(terminal) || !terminal.state.isInteractedWith)
        return;
    sendTerminalEvent(terminal, 'terminal_interacted', {
        terminalName: terminal.name,
        ...getTerminalCaptureDetails(terminal),
    });
}
function closeTrackedTerminal(terminal) {
    const terminalRef = terminalRefByTerminal.get(terminal);
    if (terminalRef && isTerminalConnected(terminal)) {
        const exitCode = terminal.exitStatus?.code;
        const exitReason = terminal.exitStatus ? terminalExitReasonLabel(terminal.exitStatus.reason) : '';
        const details = {
            terminalName: terminal.name,
            ...getTerminalCaptureDetails(terminal),
        };
        if (exitCode !== undefined)
            details.exitCode = exitCode;
        if (exitReason)
            details.exitReason = exitReason;
        sendTerminalEvent(terminal, 'terminal_closed', details);
    }
    forgetTerminal(terminal);
}
function sendTerminalEvent(terminal, type, details = {}, retry = true) {
    const terminalRef = getTerminalRef(terminal);
    const event = buildTerminalEvent(terminal, terminalRef, type, details);
    latestTerminalEventAtByTerminalRef.set(terminalRef, event.occurredAt);
    debugLog('queue terminal event', terminalEventDebugDetails(event), terminal);
    queueTerminalEventDelivery(event, retry);
}
function buildTerminalEvent(terminal, terminalRef, type, details) {
    const event = {
        terminalRef,
        type,
        occurredAt: nextTerminalEventOccurredAt(terminalRef),
        windowId: vscodeWindowId,
        terminalName: terminal.name,
        terminalCwd: getTerminalCwd(terminal),
        shellType: inferTerminalShellType(terminal),
    };
    const launchId = details.launchId ?? launchIdByTerminal.get(terminal);
    if (launchId !== undefined)
        event.launchId = launchId;
    const terminalPid = details.terminalPid ?? terminalProcessIdByTerminal.get(terminal);
    if (terminalPid !== undefined)
        event.terminalPid = terminalPid;
    if (details.commandLine !== undefined)
        event.commandLine = details.commandLine;
    if (details.executionId !== undefined)
        event.executionId = details.executionId;
    if (details.output !== undefined)
        event.output = details.output;
    if (details.exitCode !== undefined)
        event.exitCode = details.exitCode;
    if (details.exitReason !== undefined)
        event.exitReason = details.exitReason;
    if (details.terminalName !== undefined)
        event.terminalName = details.terminalName;
    if (details.terminalCwd !== undefined)
        event.terminalCwd = details.terminalCwd;
    if (details.shellType !== undefined)
        event.shellType = details.shellType;
    if (details.hasLaunchCommand !== undefined)
        event.hasLaunchCommand = details.hasLaunchCommand;
    if (details.primary !== undefined)
        event.primary = details.primary;
    if (details.captureState !== undefined)
        event.captureState = details.captureState;
    if (details.captureReason !== undefined)
        event.captureReason = details.captureReason;
    return event;
}
function nextTerminalEventOccurredAt(terminalRef) {
    const latestOccurredAt = latestTerminalEventAtByTerminalRef.get(terminalRef) ?? 0;
    return Math.max(Date.now(), latestOccurredAt + 1);
}
function queueTerminalEventDelivery(event, retry) {
    if (disconnectedTerminalRefs.has(event.terminalRef))
        return;
    const previousDelivery = terminalEventDeliveryByRef.get(event.terminalRef) ?? Promise.resolve();
    const delivery = previousDelivery
        .catch(() => undefined)
        .then(() => sendTerminalEventWithRetry(event, retry));
    terminalEventDeliveryByRef.set(event.terminalRef, delivery);
    void delivery.finally(() => {
        if (terminalEventDeliveryByRef.get(event.terminalRef) === delivery) {
            terminalEventDeliveryByRef.delete(event.terminalRef);
        }
    });
}
async function sendTerminalEventWithRetry(event, retry, retryDelayMs = TERMINAL_EVENT_RETRY_INITIAL_MS) {
    if (disconnectedTerminalRefs.has(event.terminalRef))
        return;
    const delivered = await postTerminalEvent(event);
    if (delivered || !retry)
        return;
    debugLog('schedule terminal event retry', {
        ...terminalEventDebugDetails(event),
        retryDelayMs,
    }, terminalByRef.get(event.terminalRef));
    await delay(retryDelayMs);
    await sendTerminalEventWithRetry(event, retry, Math.min(retryDelayMs * 2, TERMINAL_EVENT_RETRY_MAX_MS));
}
function delay(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}
async function postTerminalEvent(event) {
    const terminal = terminalByRef.get(event.terminalRef);
    try {
        const response = await fetch(MULTITASKER_TERMINAL_EVENT_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(event),
        });
        if (!response.ok) {
            debugLog('terminal event rejected', {
                ...terminalEventDebugDetails(event),
                httpStatus: response.status,
            }, terminal);
            console.warn(`Multitasker rejected terminal event: HTTP ${response.status}.`);
            return false;
        }
        debugLog('terminal event accepted', terminalEventDebugDetails(event), terminal);
        return true;
    }
    catch (error) {
        debugLog('terminal event failed', {
            ...terminalEventDebugDetails(event),
            error: getErrorMessage(error),
        }, terminal);
        console.warn(`Could not send terminal event to Multitasker: ${getErrorMessage(error)}`);
        return false;
    }
}
function isTerminalVisibleToUser(terminal) {
    return vscode.window.state.focused && vscode.window.activeTerminal === terminal;
}
function stripTerminalControlSequences(value) {
    return value
        .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/\r/g, '\n');
}
function terminalOutputDebugPreview(output) {
    const strippedOutput = stripTerminalControlSequences(output)
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
    const start = Math.max(0, strippedOutput.length - TERMINAL_DEBUG_OUTPUT_PREVIEW_LENGTH);
    const prefix = start > 0 ? '...' : '';
    return `${prefix}${strippedOutput.slice(start)}`;
}
function splitTerminalOutput(output) {
    if (output.length <= MAX_TERMINAL_OUTPUT_EVENT_CHARS)
        return [output];
    const chunks = [];
    for (let index = 0; index < output.length; index += MAX_TERMINAL_OUTPUT_EVENT_CHARS) {
        chunks.push(output.slice(index, index + MAX_TERMINAL_OUTPUT_EVENT_CHARS));
    }
    return chunks;
}
function getExecutionId(execution) {
    const existingId = executionIdByExecution.get(execution);
    if (existingId)
        return existingId;
    nextExecutionSequence += 1;
    const executionId = `execution:${nextExecutionSequence}`;
    executionIdByExecution.set(execution, executionId);
    return executionId;
}
function terminalEventDebugDetails(event) {
    return {
        terminalRef: event.terminalRef,
        launchId: event.launchId,
        type: event.type,
        occurredAt: event.occurredAt,
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
function commandsMatch(actual, expected) {
    return normalizeCommandLine(actual) === normalizeCommandLine(expected);
}
function normalizeCommandLine(commandLine) {
    return commandLine.trim().replace(/\s+/g, ' ');
}
function terminalExitReasonLabel(reason) {
    switch (reason) {
        case vscode.TerminalExitReason.Shutdown:
            return 'shutdown';
        case vscode.TerminalExitReason.Process:
            return 'process exited';
        case vscode.TerminalExitReason.User:
            return 'closed by user';
        case vscode.TerminalExitReason.Extension:
            return 'closed by extension';
        default:
            return 'unknown';
    }
}
function parseSessionPayload(payload) {
    if (!isRecord(payload)) {
        vscode.window.showErrorMessage('Multitasker session payload must be an object.');
        return undefined;
    }
    const cwd = readString(payload, 'cwd').trim();
    const rawShellType = readString(payload, 'shellType');
    const shellType = rawShellType === 'ssh' ? 'ssh' : rawShellType === 'bash' ? 'bash' : 'powershell';
    const sshCommand = (readString(payload, 'sshCommand') || readString(payload, 'sshHost')).trim();
    if (shellType === 'ssh' && !sshCommand) {
        vscode.window.showErrorMessage('Multitasker SSH sessions need an SSH command.');
        return undefined;
    }
    if (shellType !== 'ssh' && !cwd) {
        vscode.window.showErrorMessage('Multitasker session payload is missing cwd.');
        return undefined;
    }
    const launchId = readString(payload, 'launchId').trim() || (0, node_crypto_1.randomUUID)();
    const name = readString(payload, 'name').trim() || node_path_1.default.basename(cwd) || sshCommand || 'Session';
    const command = readString(payload, 'command').trim() || readString(payload, 'cmd').trim();
    return {
        launchId,
        name,
        cwd,
        command,
        shellType,
        sshCommand,
    };
}
function getTerminalName(session) {
    return `Multitasker: ${session.name}`;
}
function getSessionLaunchCommand(session) {
    if (session.shellType !== 'ssh')
        return session.command;
    const remoteCommand = buildRemoteCommand(session.cwd, session.command);
    if (!remoteCommand)
        return session.sshCommand;
    return `${session.sshCommand} -t ${quoteLocalShellArg(remoteCommand)}`;
}
function buildRemoteCommand(remoteCwd, command) {
    const trimmedCwd = remoteCwd.trim();
    const trimmedCommand = command.trim();
    if (trimmedCwd && trimmedCommand) {
        return `cd ${quoteRemoteShellArg(trimmedCwd)} && ${trimmedCommand}`;
    }
    if (trimmedCwd) {
        return `cd ${quoteRemoteShellArg(trimmedCwd)} && exec "$SHELL" -l`;
    }
    return trimmedCommand;
}
function quoteRemoteShellArg(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function quoteLocalShellArg(value) {
    if (process.platform === 'win32')
        return `'${value.replace(/'/g, "''")}'`;
    return quoteRemoteShellArg(value);
}
function getShellPath(shellType) {
    if (shellType === 'bash')
        return 'bash';
    return getPowerShellPath();
}
function getSshLocalShellPath() {
    return process.platform === 'win32' ? 'powershell.exe' : 'bash';
}
function getPowerShellPath() {
    return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}
function inferTerminalShellType(terminal) {
    const shellPath = getTerminalShellPath(terminal).toLowerCase();
    const terminalName = terminal.name.toLowerCase();
    if (shellPath.includes('bash') || terminalName.includes('bash'))
        return 'bash';
    return process.platform === 'win32' ? 'powershell' : 'bash';
}
function getTerminalShellPath(terminal) {
    const options = terminal.creationOptions;
    if ('shellPath' in options && typeof options.shellPath === 'string')
        return options.shellPath;
    return '';
}
function getTerminalCwd(terminal) {
    const shellIntegrationCwd = terminal.shellIntegration?.cwd;
    if (shellIntegrationCwd)
        return uriToTerminalPath(shellIntegrationCwd);
    const options = terminal.creationOptions;
    if ('cwd' in options) {
        const cwd = options.cwd;
        if (typeof cwd === 'string')
            return cwd;
        if (cwd)
            return uriToTerminalPath(cwd);
    }
    return getDefaultCwd();
}
function uriToTerminalPath(uri) {
    if (uri.scheme === 'file')
        return uri.fsPath;
    return uri.path || uri.fsPath;
}
function getDefaultCwd() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder?.uri.fsPath ?? '';
}
function forgetTerminal(terminal) {
    const terminalRef = terminalRefByTerminal.get(terminal);
    if (terminalRef) {
        terminalByRef.delete(terminalRef);
        latestTerminalEventAtByTerminalRef.delete(terminalRef);
        terminalEventDeliveryByRef.delete(terminalRef);
        connectedTerminalRefs.delete(terminalRef);
    }
    terminalRefByTerminal.delete(terminal);
    launchIdByTerminal.delete(terminal);
    terminalProcessIdByTerminal.delete(terminal);
    primaryCommandByTerminal.delete(terminal);
    primaryExecutionByTerminal.delete(terminal);
    terminalCaptureStateByTerminal.delete(terminal);
    terminalCaptureReasonByTerminal.delete(terminal);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function readString(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : '';
}
function assertNever(value) {
    throw new Error(`Unsupported VS Code command type: ${String(value)}`);
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
