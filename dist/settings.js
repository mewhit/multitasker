"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadSettings = loadSettings;
exports.saveSettings = saveSettings;
exports.loadSessions = loadSessions;
exports.saveSessions = saveSessions;
exports.loadManualTasks = loadManualTasks;
exports.saveManualTasks = saveManualTasks;
exports.loadRecurringTasks = loadRecurringTasks;
exports.saveRecurringTasks = saveRecurringTasks;
exports.loadSlackNotifications = loadSlackNotifications;
exports.saveSlackNotifications = saveSlackNotifications;
exports.loadWindowState = loadWindowState;
exports.saveWindowState = saveWindowState;
const electron_1 = require("electron");
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const DEFAULT_SETTINGS = {
    reviewTool: 'code {path}',
    defaultShell: process.platform === 'win32' ? 'powershell' : 'bash',
};
function isLocalShellType(value) {
    return value === 'powershell' || value === 'bash';
}
function isShellType(value) {
    return isLocalShellType(value) || value === 'ssh';
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function normalizeSettings(value) {
    if (!isRecord(value))
        return { ...DEFAULT_SETTINGS };
    const rawReviewTool = value['reviewTool'];
    const rawDefaultShell = value['defaultShell'];
    const reviewTool = typeof rawReviewTool === 'string' && rawReviewTool.trim()
        ? rawReviewTool
        : DEFAULT_SETTINGS.reviewTool;
    const defaultShell = isLocalShellType(rawDefaultShell)
        ? rawDefaultShell
        : DEFAULT_SETTINGS.defaultShell;
    return { reviewTool, defaultShell };
}
function normalizeSessionState(value) {
    if (!isRecord(value))
        return null;
    const rawId = value['id'];
    const rawName = value['name'];
    const rawCmd = value['cmd'];
    const rawCwd = value['cwd'];
    const rawShellType = value['shellType'];
    const rawSshCommand = value['sshCommand'] ?? value['sshHost'];
    const rawVsCodeWindowId = value['vscodeWindowId'];
    const rawTerminalRef = value['terminalRef'];
    const terminalPid = readFiniteNumber(value, 'terminalPid');
    const cwd = typeof rawCwd === 'string' ? rawCwd.trim() : '';
    const shellType = isShellType(rawShellType) ? rawShellType : DEFAULT_SETTINGS.defaultShell;
    const sshCommand = typeof rawSshCommand === 'string' ? rawSshCommand.trim() : '';
    if (shellType === 'ssh') {
        if (!sshCommand)
            return null;
    }
    else if (!cwd) {
        return null;
    }
    const name = typeof rawName === 'string' && rawName.trim()
        ? rawName
        : node_path_1.default.basename(cwd) || sshCommand || 'Session';
    const cmd = typeof rawCmd === 'string' ? rawCmd : '';
    const id = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : undefined;
    const vscodeWindowId = typeof rawVsCodeWindowId === 'string' && rawVsCodeWindowId.trim()
        ? rawVsCodeWindowId.trim()
        : undefined;
    const terminalRef = typeof rawTerminalRef === 'string' && rawTerminalRef.trim()
        ? rawTerminalRef.trim()
        : undefined;
    const session = {
        name,
        cmd,
        cwd,
        shellType,
        ...(sshCommand ? { sshCommand } : {}),
        ...(vscodeWindowId ? { vscodeWindowId } : {}),
        ...(terminalRef ? { terminalRef } : {}),
        ...(terminalPid !== null ? { terminalPid } : {}),
    };
    if (id)
        return { id, ...session };
    return session;
}
function normalizeManualTask(value) {
    if (!isRecord(value))
        return null;
    const id = readTrimmedString(value, 'id');
    const text = readTrimmedString(value, 'text');
    const createdAt = readFiniteNumber(value, 'createdAt');
    if (!id || !text || createdAt === null)
        return null;
    return { id, text, createdAt };
}
function normalizeRecurringTask(value) {
    if (!isRecord(value))
        return null;
    const id = readTrimmedString(value, 'id');
    const text = readTrimmedString(value, 'text');
    const time = readTrimmedString(value, 'time');
    const createdAt = readFiniteNumber(value, 'createdAt');
    const daysOfWeek = normalizeRecurringDays(value['daysOfWeek']);
    if (!id || !text || !isRecurringTime(time) || daysOfWeek.length === 0 || createdAt === null)
        return null;
    const task = {
        id,
        text,
        time,
        daysOfWeek,
        createdAt,
        enabled: value['enabled'] !== false,
    };
    const lastGeneratedDate = readTrimmedString(value, 'lastGeneratedDate');
    if (/^\d{4}-\d{2}-\d{2}$/.test(lastGeneratedDate))
        task.lastGeneratedDate = lastGeneratedDate;
    return task;
}
function normalizeRecurringDays(value) {
    if (!Array.isArray(value))
        return [];
    const days = value
        .filter((day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
    return [...new Set(days)].sort((a, b) => a - b);
}
function isRecurringTime(value) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function normalizeWindowState(value) {
    if (!isRecord(value))
        return null;
    const x = readFiniteNumber(value, 'x');
    const y = readFiniteNumber(value, 'y');
    const width = readFiniteNumber(value, 'width');
    const height = readFiniteNumber(value, 'height');
    const isMaximized = value['isMaximized'];
    if (x === null || y === null || width === null || height === null)
        return null;
    if (width <= 0 || height <= 0)
        return null;
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
        isMaximized: typeof isMaximized === 'boolean' ? isMaximized : false,
    };
}
function normalizeSlackNotification(value) {
    if (!isRecord(value))
        return null;
    const id = readTrimmedString(value, 'id');
    const text = readTrimmedString(value, 'text') || '(no text)';
    const receivedAt = readFiniteNumber(value, 'receivedAt');
    if (!id || receivedAt === null)
        return null;
    const notification = { id, text, receivedAt };
    addOptionalSlackString(notification, 'teamId', readTrimmedString(value, 'teamId'));
    addOptionalSlackString(notification, 'teamName', readTrimmedString(value, 'teamName'));
    addOptionalSlackString(notification, 'channelId', readTrimmedString(value, 'channelId'));
    addOptionalSlackString(notification, 'channelName', readTrimmedString(value, 'channelName'));
    addOptionalSlackString(notification, 'channelType', readTrimmedString(value, 'channelType'));
    addOptionalSlackString(notification, 'userId', readTrimmedString(value, 'userId'));
    addOptionalSlackString(notification, 'userName', readTrimmedString(value, 'userName'));
    addOptionalSlackString(notification, 'ts', readTrimmedString(value, 'ts'));
    addOptionalSlackString(notification, 'threadTs', readTrimmedString(value, 'threadTs'));
    addOptionalSlackString(notification, 'permalink', readTrimmedString(value, 'permalink'));
    const messageCount = readFiniteNumber(value, 'messageCount');
    if (messageCount !== null && messageCount > 1)
        notification.messageCount = Math.floor(messageCount);
    const priorityRank = readFiniteNumber(value, 'priorityRank');
    if (priorityRank !== null)
        notification.priorityRank = Math.max(0, Math.min(4, Math.floor(priorityRank)));
    const priorityLabel = readTrimmedString(value, 'priorityLabel');
    if (isSlackNotificationPriorityLabel(priorityLabel))
        notification.priorityLabel = priorityLabel;
    return notification;
}
function isSlackNotificationPriorityLabel(value) {
    return value === 'mention' ||
        value === 'dm' ||
        value === 'thread_mention' ||
        value === 'thread_written' ||
        value === 'other';
}
function readFiniteNumber(record, key) {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function readTrimmedString(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value.trim() : '';
}
function addOptionalSlackString(notification, key, value) {
    if (value)
        notification[key] = value;
}
function getSettingsPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'settings.json');
}
function getSessionsPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'sessions.json');
}
function getWindowStatePath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'window-state.json');
}
function getSlackNotificationsPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'slack-notifications.json');
}
function getManualTasksPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'manual-tasks.json');
}
function getRecurringTasksPath() {
    return node_path_1.default.join(electron_1.app.getPath('userData'), 'recurring-tasks.json');
}
function loadSettings() {
    try {
        const raw = node_fs_1.default.readFileSync(getSettingsPath(), 'utf-8');
        return normalizeSettings(JSON.parse(raw));
    }
    catch {
        return { ...DEFAULT_SETTINGS };
    }
}
function saveSettings(settings) {
    node_fs_1.default.writeFileSync(getSettingsPath(), JSON.stringify(normalizeSettings(settings), null, 2));
}
function loadSessions() {
    try {
        const raw = node_fs_1.default.readFileSync(getSessionsPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map(normalizeSessionState)
            .filter((session) => session !== null);
    }
    catch {
        return [];
    }
}
function saveSessions(sessions) {
    node_fs_1.default.writeFileSync(getSessionsPath(), JSON.stringify(sessions, null, 2));
}
function loadManualTasks() {
    try {
        const raw = node_fs_1.default.readFileSync(getManualTasksPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map(normalizeManualTask)
            .filter((task) => task !== null);
    }
    catch {
        return [];
    }
}
function saveManualTasks(tasks) {
    node_fs_1.default.writeFileSync(getManualTasksPath(), JSON.stringify(tasks.map(normalizeManualTask).filter(Boolean), null, 2));
}
function loadRecurringTasks() {
    try {
        const raw = node_fs_1.default.readFileSync(getRecurringTasksPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map(normalizeRecurringTask)
            .filter((task) => task !== null);
    }
    catch {
        return [];
    }
}
function saveRecurringTasks(tasks) {
    node_fs_1.default.writeFileSync(getRecurringTasksPath(), JSON.stringify(tasks.map(normalizeRecurringTask).filter(Boolean), null, 2));
}
function loadSlackNotifications() {
    try {
        const raw = node_fs_1.default.readFileSync(getSlackNotificationsPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map(normalizeSlackNotification)
            .filter((notification) => notification !== null);
    }
    catch {
        return [];
    }
}
function saveSlackNotifications(notifications) {
    node_fs_1.default.writeFileSync(getSlackNotificationsPath(), JSON.stringify(notifications.map(normalizeSlackNotification).filter(Boolean), null, 2));
}
function loadWindowState() {
    try {
        const raw = node_fs_1.default.readFileSync(getWindowStatePath(), 'utf-8');
        return normalizeWindowState(JSON.parse(raw));
    }
    catch {
        return null;
    }
}
function saveWindowState(state) {
    node_fs_1.default.writeFileSync(getWindowStatePath(), JSON.stringify(normalizeWindowState(state), null, 2));
}
